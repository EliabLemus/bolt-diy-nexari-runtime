/**
 * Returns the data-stream text-delta payload that boots the guest dev server,
 * or null when the model already emitted a shell action itself (so we don't
 * double-run install/dev). Free OpenRouter models often skip the shell step,
 * leaving files written but the preview never starting.
 *
 * ponytail: single string payload + regex guard; extract config only if the
 * command ever needs to vary per project type.
 */
export function devServerInjection(content: string): string | null {
  if (!content || /<boltAction\s+type=["']shell["']/.test(content)) {
    return null;
  }

  const injectedText =
    '\n\n<boltArtifact id="dev-server-autostart" title="Start Dev Server" type="run">\n' +
    '<boltAction type="shell">npm install && npm run dev -- --host 0.0.0.0 --port 5173</boltAction>\n' +
    '</boltArtifact>\n';

  return `0:${JSON.stringify(injectedText)}\n`;
}
