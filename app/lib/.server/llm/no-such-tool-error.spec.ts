import { describe, expect, it } from 'vitest';
import { isNoSuchToolError } from './utils';

describe('isNoSuchToolError', () => {
  it('matches AI SDK NoSuchToolError by name or message', () => {
    expect(isNoSuchToolError({ name: 'AI_NoSuchToolError', toolName: 'boltAction' })).toBe(true);
    expect(isNoSuchToolError(new Error('Tool "boltAction" not found: AI_NoSuchToolError: no such tool'))).toBe(true);
    expect(isNoSuchToolError(new Error('rate limit exceeded'))).toBe(false);
    expect(isNoSuchToolError(undefined)).toBe(false);
  });
});
