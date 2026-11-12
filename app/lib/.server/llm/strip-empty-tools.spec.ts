import { describe, expect, it } from 'vitest';
import { stripEmptyTools } from './utils';

describe('stripEmptyTools', () => {
  it('drops empty tools/toolChoice/maxSteps (prevents hallucinated boltAction tool calls)', () => {
    const out = stripEmptyTools({ supabaseConnection: undefined, toolChoice: 'auto', tools: {}, maxSteps: 5 }) as any;
    expect(out).toEqual({ supabaseConnection: undefined });
    expect('tools' in out).toBe(false);
  });

  it('keeps options when tools are present', () => {
    const options = { toolChoice: 'auto' as const, tools: { myTool: {} }, maxSteps: 5 };
    expect(stripEmptyTools(options)).toBe(options);
  });

  it('passes through undefined', () => {
    expect(stripEmptyTools(undefined)).toBeUndefined();
  });
});
