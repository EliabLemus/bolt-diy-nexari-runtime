import { describe, expect, it, vi } from 'vitest';

vi.mock('~/lib/modules/llm/registry', () => ({ default: {}, getModelList: vi.fn() }));

import OllamaProvider from './ollama';

describe('getDynamicModelsCacheKey includes DEFAULT_NUM_CTX', () => {
  // regression: changing DEFAULT_NUM_CTX must invalidate the cached dynamic models
  it('produces different keys for different DEFAULT_NUM_CTX values', () => {
    const provider = new OllamaProvider();
    const key1 = provider.getDynamicModelsCacheKey({ serverEnv: { DEFAULT_NUM_CTX: '32768' } } as any);
    const key2 = provider.getDynamicModelsCacheKey({ serverEnv: { DEFAULT_NUM_CTX: '65536' } } as any);
    expect(key1).not.toBe(key2);
  });

  it('getModelsFromCache invalidates when DEFAULT_NUM_CTX changes', () => {
    const provider = new OllamaProvider();
    provider.storeDynamicModels(
      { serverEnv: { DEFAULT_NUM_CTX: '32768' } } as any,
      [{ name: 'qwen3:4b', label: 'q', provider: 'Ollama', maxTokenAllowed: 8192 }] as any,
    );

    // same env -> cached
    expect(provider.getModelsFromCache({ serverEnv: { DEFAULT_NUM_CTX: '32768' } } as any)).not.toBeNull();

    // changed env -> cache miss
    expect(provider.getModelsFromCache({ serverEnv: { DEFAULT_NUM_CTX: '65536' } } as any)).toBeNull();
  });
});
