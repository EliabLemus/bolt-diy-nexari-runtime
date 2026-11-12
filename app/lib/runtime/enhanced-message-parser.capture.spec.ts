import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EnhancedStreamingMessageParser } from './enhanced-message-parser';

/**
 * Replays the REAL captured /api/chat stream (scripts/chat-stream.txt,
 * provider Ollama / qwen3:4b-64k, prompt 10.2) through the parser the same
 * way useMessageParser does: cumulative message text with a stable messageId.
 * Reproduces the "stream arrives but nothing renders" failure without a browser.
 */
function extractChunks(raw: string): string[] {
  const chunks: string[] = [];

  for (const line of raw.split('\n')) {
    const m = line.match(/^0:(.*)$/);

    if (m) {
      // each 0: line is a JSON-encoded string delta
      chunks.push(JSON.parse(m[1]) as string);
    }
  }

  return chunks;
}

describe('EnhancedStreamingMessageParser — captured real stream', () => {
  const raw = readFileSync(new URL('../../../scripts/chat-stream.txt', import.meta.url), 'utf8');
  const chunks = extractChunks(raw);
  const full = chunks.join('');

  it('captured stream: model emits bare boltAction tags WITHOUT boltArtifact wrapper', () => {
    // qwen3:4b-64k omits the <boltArtifact> wrapper — this is the actual defect trigger
    expect(full).toContain('<boltAction type="file"');
    expect(full).toContain('<boltAction type="shell"');
    expect(full).not.toContain('<boltArtifact');
  });

  it('fires onArtifactOpen/action callbacks when replaying the captured stream', () => {
    const events: string[] = [];
    const parser = new EnhancedStreamingMessageParser({
      callbacks: {
        onArtifactOpen: () => events.push('artifactOpen'),
        onArtifactClose: () => events.push('artifactClose'),
        onActionOpen: (d) => events.push(`actionOpen:${d.action.type}`),
        onActionClose: (d) => events.push(`actionClose:${d.action.type}`),
        onActionStream: () => events.push('actionStream'),
      },
    });

    // client feeds cumulative message text, not isolated chunks
    let buffer = '';

    for (const chunk of chunks) {
      buffer += chunk;
      parser.parse('real-msg-1', buffer);
    }

    expect(events).toContain('artifactOpen');
    expect(events.filter((e) => e === 'artifactOpen')).toHaveLength(1); // no duplicate opens on re-parse
    expect(events.some((e) => e.startsWith('actionOpen:file'))).toBe(true);
    expect(events.filter((e) => e.startsWith('actionOpen:file'))).toHaveLength(4); // package.json, index.html, main.jsx, App.jsx
    expect(events.some((e) => e.startsWith('actionClose:shell'))).toBe(true);
  });
});
