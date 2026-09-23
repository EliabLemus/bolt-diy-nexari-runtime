import { describe, expect, it, vi } from 'vitest';
import type { WebContainer } from '@webcontainer/api';
import { RuntimeBackendUnavailableError, createBrowserRuntime } from './browser-runtime';

describe('createBrowserRuntime', () => {
  it('delegates the StackBlitz control path to its bootstrapper', async () => {
    const runtime = {} as WebContainer;
    const bootStackblitz = vi.fn().mockResolvedValue(runtime);

    await expect(createBrowserRuntime('stackblitz', { bootStackblitz })).resolves.toBe(runtime);
    expect(bootStackblitz).toHaveBeenCalledOnce();
  });

  it('fails closed when Nexari is selected before its adapter is wired', async () => {
    const bootStackblitz = vi.fn();

    await expect(createBrowserRuntime('nexari', { bootStackblitz })).rejects.toBeInstanceOf(
      RuntimeBackendUnavailableError,
    );
    expect(bootStackblitz).not.toHaveBeenCalled();
  });
});
