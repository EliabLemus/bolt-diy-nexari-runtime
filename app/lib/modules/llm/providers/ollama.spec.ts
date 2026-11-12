import { describe, expect, it, vi } from 'vitest';

/*
 * Break the BaseProvider -> LLMManager -> registry -> providers circular import
 * that crashes at module-eval time under vitest (works fine in the app).
 */
vi.mock('~/lib/modules/llm/registry', () => ({ default: {}, getModelList: vi.fn() }));

import OllamaProvider from './ollama';

describe('OllamaProvider.getDefaultNumCtx', () => {
  it('defaults to 65536 when DEFAULT_NUM_CTX is not set', () => {
    const provider = new OllamaProvider();
    expect(provider.getDefaultNumCtx(undefined)).toBe(65536);
    expect(provider.getDefaultNumCtx({} as any)).toBe(65536);
  });

  it('respects DEFAULT_NUM_CTX when set', () => {
    const provider = new OllamaProvider();
    expect(provider.getDefaultNumCtx({ DEFAULT_NUM_CTX: '32768' } as any)).toBe(32768);
  });
});
