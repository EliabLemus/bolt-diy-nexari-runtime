import { describe, expect, it } from 'vitest';
import { devServerInjection } from './dev-server-injection';
import { rewriteWasmSafeCommand } from '~/lib/runtime/nexari-action-shell';

/**
 * Regression: free OpenRouter models (e.g. nemotron-3.5-lightning:free) write
 * files via <boltAction type="file"> but never emit the shell step that boots
 * the dev server, so the preview stays on "No preview available".
 */
describe('devServerInjection', () => {
  it('injects the npm dev pipeline when package.json has a dev script', () => {
    const content =
      '<boltArtifact id="app" title="App" type="bundled">\n' +
      '<boltAction type="file" filePath="package.json">{"name":"app","version":"1.0.0","scripts":{"dev":"vite"}}</boltAction>\n' +
      '</boltArtifact>';

    const payload = devServerInjection(content);
    const decoded = JSON.parse(payload!.slice('0:'.length).trim()) as string;

    expect(decoded).toContain('npm install && npm run dev');
  });

  it('serves plain-HTML projects statically (no package.json → no npm)', () => {
    const content =
      '<boltArtifact id="hola" title="Hola" type="bundled">\n' +
      '<boltAction type="file" filePath="index.html"><h1>Hola</h1></boltAction>\n' +
      '</boltArtifact>';

    const payload = devServerInjection(content);
    expect(payload).not.toBeNull();

    const decoded = JSON.parse(payload!.slice('0:'.length).trim()) as string;

    expect(decoded).toContain('python3 -m http.server 5173');
    // Shared guest fs: a previous chat's server keeps 5173 bound — the
    // injected command must reboot it via the pidfile before binding.
    expect(decoded).toContain('/tmp/.nexari-dev.pid');
    expect(decoded).toContain('kill -9');
    expect(decoded).not.toContain('npm install');
    expect(decoded).not.toContain('package-lock.json');
  });

  it('does not inject when the model already emitted a shell action', () => {
    const content = '<boltAction type="shell">npm run dev</boltAction>';

    expect(devServerInjection(content)).toBeNull();
  });

  it('does not inject on empty content', () => {
    expect(devServerInjection('')).toBeNull();
  });

  it('injected npm command maps to the wasm-safe guest pipeline', () => {
    const content =
      '<boltAction type="file" filePath="package.json">{"name":"a","version":"1.0.0","scripts":{"dev":"vite"}}</boltAction>';
    const payload = devServerInjection(content);
    const decoded = JSON.parse(payload!.slice('0:'.length).trim()) as string;
    const command = /<boltAction type="shell">([\s\S]*?)<\/boltAction>/.exec(decoded)![1];

    expect(rewriteWasmSafeCommand(command)).not.toBeNull();
    expect(rewriteWasmSafeCommand(command)!.some((step) => step.includes('run dev'))).toBe(true);
  });

  it('static command falls back to raw runActionCommand (no wasm rewrite)', () => {
    const payload = devServerInjection('<boltAction type="file" filePath="index.html">x</boltAction>');
    const decoded = JSON.parse(payload!.slice('0:'.length).trim()) as string;
    const command = /<boltAction type="shell">([\s\S]*?)<\/boltAction>/.exec(decoded)![1];

    expect(rewriteWasmSafeCommand(command)).toBeNull();
  });
});
