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

describe('OllamaProvider.getDynamicModels maxTokenAllowed', () => {
  // regression: metadata 8000 < completion request 8192 -> api.llmcall 400 'Token Limit Exceeded'
  it('reports maxTokenAllowed >= Ollama completion limit (8192)', async () => {
    const provider = new OllamaProvider();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        models: [
          { name: 'qwen3:4b', model: 'qwen3:4b', details: { parameter_size: '4B' } },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const models = await provider.getDynamicModels(undefined, { baseUrl: 'http://localhost:11434' } as any, {});
    expect(models[0].maxTokenAllowed).toBeGreaterThanOrEqual(8192);
    vi.unstubAllGlobals();
  });
});
