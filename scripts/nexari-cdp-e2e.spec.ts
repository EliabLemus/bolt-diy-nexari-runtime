import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import {
  CDP_LOOPBACK_HOST,
  RUNNER_VERSION,
  OWNER_APPROVAL_TOKEN,
  NexariCdpApprovalRequiredError,
  NexariCdpPortReservationError,
  NexariCdpSelectorError,
  acquireLoopbackPort,
  buildChromeArgs,
  createOwnedProfile,
  inspectCdpCapabilities,
  launchChrome,
  resolveNexariSelector,
  startNexariDevServer,
} from './nexari-cdp-e2e.mjs';

describe('Nexari CDP E2E runner contract', () => {
  it('documents a non-launching project command for the owner-gated runner', async () => {
    const packageJson = JSON.parse(
      await readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as { scripts: Record<string, string> };

    expect(packageJson.scripts['test:nexari-e2e']).toBe('node scripts/nexari-cdp-e2e.mjs --help');
  });

  it('exports a semver version and reports CDP capabilities without opening a socket', () => {
    expect(RUNNER_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(inspectCdpCapabilities({})).toEqual({
      cdpWebSocket: false,
      fetch: false,
    });
  });

  it('requires the nexari selector before creating a child process', () => {
    const spawn = vi.fn();

    expect(() => resolveNexariSelector({})).toThrow(NexariCdpSelectorError);
    expect(() => resolveNexariSelector({ VITE_RUNTIME_BACKEND: 'stackblitz' })).toThrow(NexariCdpSelectorError);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('creates runner-owned temporary profiles and always cleans them up', async () => {
    const remove = vi.fn();
    const mkdtemp = vi.fn().mockReturnValue('/tmp/nexari-cdp-e2e-owned-profile');

    await expect(
      createOwnedProfile(
        async (profileDirectory: string) => {
          expect(profileDirectory).toBe('/tmp/nexari-cdp-e2e-owned-profile');
          throw new Error('simulated test failure');
        },
        { mkdtemp, remove, tempDirectory: '/tmp' },
      ),
    ).rejects.toThrow('simulated test failure');

    expect(mkdtemp).toHaveBeenCalledWith('/tmp/nexari-cdp-e2e-');
    expect(remove).toHaveBeenCalledWith('/tmp/nexari-cdp-e2e-owned-profile');
  });

  it('reserves a port by binding loopback before releasing it for the owned child', async () => {
    class FakeServer extends EventEmitter {
      close = vi.fn((callback: () => void) => callback());
      listen = vi.fn((_options: { host: string; port: number }, callback: () => void) => callback());
      address = vi.fn(() => ({ address: CDP_LOOPBACK_HOST, family: 'IPv4', port: 43123 }));
    }

    const server = new FakeServer();
    const port = await acquireLoopbackPort({ createServer: () => server });

    expect(port).toBe(43123);
    expect(server.listen).toHaveBeenCalledWith({ host: CDP_LOOPBACK_HOST, port: 0 }, expect.any(Function));
    expect(server.close).toHaveBeenCalledOnce();
  });

  it('rejects a non-loopback CDP reservation before returning a port', async () => {
    class FakeServer extends EventEmitter {
      close = vi.fn((callback: () => void) => callback());
      listen = vi.fn((_options: { host: string; port: number }, callback: () => void) => callback());
      address = vi.fn(() => ({ address: '::1', family: 'IPv6', port: 43123 }));
    }

    const server = new FakeServer();

    await expect(acquireLoopbackPort({ createServer: () => server })).rejects.toThrow(NexariCdpPortReservationError);
    expect(server.close).toHaveBeenCalledOnce();
  });

  it('builds Chrome arguments that can only expose CDP on loopback and an owned profile', () => {
    expect(
      buildChromeArgs({
        profileDirectory: '/tmp/nexari-cdp-e2e-owned-profile',
        debugPort: 43123,
      }),
    ).toEqual(
      expect.arrayContaining([
        '--remote-debugging-address=127.0.0.1',
        '--remote-debugging-port=43123',
        '--user-data-dir=/tmp/nexari-cdp-e2e-owned-profile',
        '--no-first-run',
        '--no-default-browser-check',
      ]),
    );
  });

  it('refuses to spawn a dev server unless the Nexari selector is already explicit', () => {
    const spawn = vi.fn();

    expect(() =>
      startNexariDevServer({
        cwd: '/repo',
        port: 43124,
        env: { PATH: '/bin' },
        spawn,
      }),
    ).toThrow(NexariCdpSelectorError);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('starts a new Nexari dev process on loopback with strict port ownership', () => {
    const child = new EventEmitter();
    const spawn = vi.fn().mockReturnValue(child);

    const started = startNexariDevServer({
      cwd: '/repo',
      port: 43124,
      env: { PATH: '/bin', VITE_RUNTIME_BACKEND: 'nexari' },
      spawn,
    });

    expect(started).toBe(child);
    expect(spawn).toHaveBeenCalledWith(
      'pnpm',
      ['exec', 'remix', 'vite:dev', '--host', CDP_LOOPBACK_HOST, '--port', '43124', '--strictPort'],
      expect.objectContaining({
        cwd: '/repo',
        env: expect.objectContaining({ VITE_RUNTIME_BACKEND: 'nexari' }),
      }),
    );
  });

  it('refuses to launch Chrome until a dedicated owner-approval value is supplied', () => {
    const spawn = vi.fn();

    expect(() =>
      launchChrome({
        approvalToken: undefined,
        chromeExecutable: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        profileDirectory: '/tmp/nexari-cdp-e2e-owned-profile',
        debugPort: 43123,
        spawn,
      }),
    ).toThrow(NexariCdpApprovalRequiredError);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('passes only loopback CDP arguments to an owner-approved Chrome child', () => {
    const child = new EventEmitter();
    const spawn = vi.fn().mockReturnValue(child);
    const profileDirectory = '/tmp/nexari-cdp-e2e-owned-profile';
    const debugPort = 43123;

    expect(
      launchChrome({
        approvalToken: OWNER_APPROVAL_TOKEN,
        chromeExecutable: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        profileDirectory,
        debugPort,
        spawn,
      }),
    ).toBe(child);
    expect(spawn).toHaveBeenCalledWith(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      buildChromeArgs({ profileDirectory, debugPort }),
      { stdio: 'pipe' },
    );
  });
});
