import { describe, expect, it } from 'vitest';
import { devServerInjection } from './dev-server-injection';
import { rewriteWasmSafeCommand } from '~/lib/runtime/nexari-action-shell';

/**
 * Regression: free OpenRouter models (e.g. nemotron-3.5-lightning:free) write
 * files via <boltAction type="file"> but never emit the shell step that boots
 * the dev server, so the preview stays on "No preview available".
 */
describe('devServerInjection', () => {
  it('injects a dev-server shell action when the model emitted only file actions', () => {
    const content =
      '<boltArtifact id="counter" title="Counter" type="bundled">\n' +
      '<boltAction type="file" filePath="src/CounterButton.tsx">export default () => <button/></boltAction>\n' +
      '</boltArtifact>';

    const payload = devServerInjection(content);

    expect(payload).not.toBeNull();

    const decoded = JSON.parse(payload!.slice('0:'.length).trim()) as string;

    expect(decoded).toContain('<boltAction type="shell">');
    expect(decoded).toContain('npm install && npm run dev');
  });

  it('does not inject when the model already emitted a shell action', () => {
    const content = '<boltAction type="shell">npm run dev</boltAction>';

    expect(devServerInjection(content)).toBeNull();
  });

  it('does not inject on empty content', () => {
    expect(devServerInjection('')).toBeNull();
  });

  it('injected command maps to the wasm-safe guest pipeline', () => {
    const payload = devServerInjection('<boltAction type="file" filePath="a.ts">x</boltAction>');
    const decoded = JSON.parse(payload!.slice('0:'.length).trim()) as string;
    const command = /<boltAction type="shell">([\s\S]*?)<\/boltAction>/.exec(decoded)![1];

    expect(rewriteWasmSafeCommand(command)).not.toBeNull();
    expect(rewriteWasmSafeCommand(command)!.some((step) => step.includes('run dev'))).toBe(true);
  });
});
