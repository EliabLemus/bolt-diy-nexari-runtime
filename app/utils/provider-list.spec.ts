import { describe, expect, it } from 'vitest';
import { PROVIDER_LIST, DEFAULT_PROVIDER } from './constants';

/*
 * Regression: provider registration race — PROVIDER_LIST must be fully
 * populated at module-eval time, before any component reads it.
 */
describe('PROVIDER_LIST', () => {
  it('contains Ollama at module-eval time', () => {
    expect(PROVIDER_LIST.some((p) => p.name === 'Ollama')).toBe(true);
  });

  it('DEFAULT_PROVIDER is a registered provider', () => {
    expect(PROVIDER_LIST.some((p) => p.name === DEFAULT_PROVIDER.name)).toBe(true);
  });
});
