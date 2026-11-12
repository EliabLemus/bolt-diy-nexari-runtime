import { describe, expect, it, vi } from 'vitest';

vi.mock('~/utils/logger', () => ({ createScopedLogger: () => ({ warn: vi.fn() }) }));

const sample = JSON.stringify([
  { id: 'css', description: 'Modern CSS guidelines' },
  { id: 'html', description: 'Semantic HTML' },
]);

describe('getModernWebGuidance', () => {
  it('is empty when disabled via MODERN_WEB_GUIDANCE=off', async () => {
    vi.resetModules();
    process.env.MODERN_WEB_GUIDANCE = 'off';

    const { getModernWebGuidance } = await import('./mwg');
    expect(await getModernWebGuidance('build a landing page')).toBe('');
    delete process.env.MODERN_WEB_GUIDANCE;
  });

  it('is empty for empty queries', async () => {
    vi.resetModules();

    const { getModernWebGuidance } = await import('./mwg');
    expect(await getModernWebGuidance('   ')).toBe('');
  });

  it('injects guidance listing from CLI search', async () => {
    const execFileMock = vi.fn((_cmd: string, _args: string[], _opts: any, cb: any) => cb(null, sample));
    vi.doMock('child_process', () => ({ execFile: execFileMock }));
    vi.resetModules();

    const { getModernWebGuidance } = await import('./mwg');
    const out = await getModernWebGuidance('react counter component');
    expect(out).toContain('MODERN WEB GUIDANCE');
    expect(out).toContain('Apache-2.0');
    expect(out).toContain('- css: Modern CSS guidelines');
    vi.doUnmock('child_process');
  });
});
