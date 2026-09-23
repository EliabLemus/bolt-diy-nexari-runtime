import { describe, expect, it } from 'vitest';
import { RuntimeConfigurationError, resolveRuntimeBackend } from './runtime-selector';

describe('resolveRuntimeBackend', () => {
  it('keeps StackBlitz as the baseline when no backend is configured', () => {
    expect(resolveRuntimeBackend(undefined)).toBe('stackblitz');
  });

  it('selects Nexari only when explicitly requested', () => {
    expect(resolveRuntimeBackend('nexari')).toBe('nexari');
  });

  it('rejects unknown runtime selections instead of silently falling back', () => {
    expect(() => resolveRuntimeBackend('webcontainer')).toThrow(RuntimeConfigurationError);
    expect(() => resolveRuntimeBackend('webcontainer')).toThrow('Unsupported runtime backend');
  });
});
