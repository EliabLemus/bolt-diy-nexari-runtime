import { describe, expect, it } from 'vitest';
import { devServerInjection, generateGuestLockfile } from './dev-server-injection';
import { rewriteWasmSafeCommand } from '~/lib/runtime/nexari-action-shell';

function decode(payload: string): string {
  return JSON.parse(payload.slice('0:'.length).trim()) as string;
}

const PKG_JSON =
  '<boltAction type="file" filePath="package.json">{\n  "name": "demo",\n  "version": "1.2.3"\n}</boltAction>';

describe('install flags (A1)', () => {
  it('maps a bare install to the wasm-safe pipeline with the 4 work-reduction flags', () => {
    const steps = rewriteWasmSafeCommand('npm install')!;

    expect(steps[0]).toBe('npm install --ignore-scripts --prefer-offline --no-audit --no-fund');
  });

  it('keeps the flags on compound install && run dev', () => {
    const steps = rewriteWasmSafeCommand('npm install && npm run dev')!;

    expect(steps[0]).toContain('--ignore-scripts --prefer-offline --no-audit --no-fund');
  });
});

describe('lockfile action before install (A2)', () => {
  it('emits a package-lock.json file action before the shell when the model emitted none', () => {
    const decoded = decode(devServerInjection(PKG_JSON)!);

    const lockIndex = decoded.indexOf('<boltAction type="file" filePath="package-lock.json">');
    const shellIndex = decoded.indexOf('<boltAction type="shell">');

    expect(lockIndex).toBeGreaterThan(-1);
    expect(shellIndex).toBeGreaterThan(lockIndex);

    const lockBody = /<boltAction type="file" filePath="package-lock.json">([\s\S]*?)<\/boltAction>/.exec(
      decoded,
    )![1];

    expect(JSON.parse(lockBody)).toMatchObject({ name: 'demo', version: '1.2.3', lockfileVersion: 3 });
  });

  it('keeps the model lockfile untouched when it matches the package.json root', () => {
    const content =
      PKG_JSON +
      '\n<boltAction type="file" filePath="package-lock.json">{\n  "name": "demo",\n  "version": "1.2.3",\n  "lockfileVersion": 3\n}</boltAction>';
    const decoded = decode(devServerInjection(content)!);

    expect(decoded).not.toContain('filePath="package-lock.json"');
  });

  it('generates the lockfile when the model lockfile is unparsable or mismatched', () => {
    for (const lock of ['not json', '{"name":"other","version":"9.9.9"}']) {
      const decoded = decode(devServerInjection(`${PKG_JSON}\n<boltAction type="file" filePath="package-lock.json">${lock}</boltAction>`)!);

      expect(decoded).toContain('filePath="package-lock.json"');
      expect(decoded.indexOf('filePath="package-lock.json"')).toBeLessThan(decoded.indexOf('<boltAction type="shell">'));
    }
  });

  it('generateGuestLockfile is deterministic and rejects unparsable package.json', () => {
    expect(generateGuestLockfile('{"name":"a","version":"0.1.0"}')).toBe(
      generateGuestLockfile('{"version":"0.1.0","name":"a"}'),
    );
    expect(generateGuestLockfile('nope')).toBeNull();
  });
});
