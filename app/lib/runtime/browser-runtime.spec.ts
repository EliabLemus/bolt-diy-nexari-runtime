import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import type { WebContainer } from '@webcontainer/api';
import { NexariBootNotConfiguredError, createBrowserRuntime } from './browser-runtime';

describe('createBrowserRuntime', () => {
  it('contains no static @webcontainer/api import; the SDK loads lazily only inside the stackblitz boot factory', async () => {
    const source = await readFile(new URL('./browser-runtime.ts', import.meta.url), 'utf8');

    expect(source).not.toMatch(/^import\s+\{[^}]*WebContainer[^}]*\}\s+from\s+'@webcontainer\/api';/m);
    expect(source).toMatch(/await import\('@webcontainer\/api'\)/);
  });

  it('links the production Nexari boot path only through lazy public adapter imports', async () => {
    const source = await readFile(new URL('./browser-runtime.ts', import.meta.url), 'utf8');

    expect(source).toMatch(/import\('@nexari\/vivari-adapter'\)/);
    expect(source).toMatch(/import\('\.\/nexari-app-boot'\)/);
    expect(source).toMatch(
      /createAppNexariBootFactory\(\{[\s\S]*loadSdk:\s*loadPinnedVivariSdk,[\s\S]*createVivariRuntime,/,
    );
    expect(source).not.toMatch(/^import\s+.*@nexari\/vivari-adapter/m);
  });

  it('delegates the StackBlitz control path to its bootstrapper', async () => {
    const runtime = {} as WebContainer;
    const bootStackblitz = vi.fn().mockResolvedValue(runtime);

    await expect(createBrowserRuntime('stackblitz', { bootStackblitz })).resolves.toBe(runtime);
    expect(bootStackblitz).toHaveBeenCalledOnce();
  });

  it('fails closed with a typed error when nexari is selected without a guest boot', async () => {
    const bootStackblitz = vi.fn();

    await expect(createBrowserRuntime('nexari', { bootStackblitz })).rejects.toBeInstanceOf(
      NexariBootNotConfiguredError,
    );
    expect(bootStackblitz).not.toHaveBeenCalled();
  });
});
