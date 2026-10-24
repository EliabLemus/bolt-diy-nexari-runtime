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
  assessNexariEvidence,
  buildChromeArgs,
  captureNexariBrowserEvidence,
  classifyNexariResource,
  connectRawCdp,
  createOwnedProfile,
  inspectCdpCapabilities,
  launchChrome,
  resolveNexariSelector,
  runNexariE2E,
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

  it('preserves both run and cleanup failures from an owned profile', async () => {
    const runFailure = new Error('run failed');
    const cleanupFailure = new Error('cleanup failed');

    await expect(
      createOwnedProfile(
        async () => {
          throw runFailure;
        },
        {
          mkdtemp: vi.fn().mockResolvedValue('/tmp/nexari-cdp-e2e-owned-profile'),
          remove: vi.fn().mockRejectedValue(cleanupFailure),
          tempDirectory: '/tmp',
        },
      ),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof AggregateError && error.errors.includes(runFailure) && error.errors.includes(cleanupFailure),
    );
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
        '--remote-allow-origins=*',
        '--host-resolver-rules=MAP * 0.0.0.0, EXCLUDE 127.0.0.1',
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

  it('classifies only same-origin Nexari document, worker, and asset requests as mandatory', () => {
    const origin = 'http://127.0.0.1:43124';

    expect(classifyNexariResource(`${origin}/`, origin)).toBe('document');
    expect(classifyNexariResource(`${origin}/sw.js`, origin)).toBe('service-worker');
    expect(classifyNexariResource(`${origin}/assets/kernel-worker.js`, origin)).toBe('asset');
    expect(classifyNexariResource(`${origin}/vendor/vivari.js`, origin)).toBe('asset');
    expect(classifyNexariResource('https://fonts.googleapis.com/css2', origin)).toBeUndefined();
  });

  it('fails evidence that lacks a mandatory graph response or records a kernel console error', () => {
    const complete = {
      responses: [
        { url: 'http://127.0.0.1:43124/', status: 200 },
        { url: 'http://127.0.0.1:43124/sw.js', status: 200 },
        { url: 'http://127.0.0.1:43124/assets/kernel-worker.js', status: 200 },
      ],
      failures: [],
      consoleErrors: [],
      crossOriginIsolated: true,
      serviceWorkerScriptUrl: 'http://127.0.0.1:43124/sw.js',
    };

    expect(assessNexariEvidence(complete, 'http://127.0.0.1:43124').passed).toBe(true);
    expect(
      assessNexariEvidence({ ...complete, responses: complete.responses.slice(0, 2) }, 'http://127.0.0.1:43124')
        .reasons,
    ).toContain('insufficient-mandatory-asset-evidence');
    expect(
      assessNexariEvidence(
        { ...complete, serviceWorkerScriptUrl: 'https://attacker.example/sw.js' },
        'http://127.0.0.1:43124',
      ).reasons,
    ).toContain('service-worker-controller-missing');
    expect(
      assessNexariEvidence({ ...complete, consoleErrors: ['kernel worker failed to load'] }, 'http://127.0.0.1:43124')
        .reasons,
    ).toContain('kernel-worker-console-error');
  });

  it('enables page domains before navigation and captures auto-attached worker failures', async () => {
    const calls: Array<{ method: string; sessionId?: string }> = [];
    let eventListener: ((event: Record<string, unknown>) => void | Promise<void>) | undefined;
    const cdp = {
      onEvent(listener: (event: Record<string, unknown>) => void | Promise<void>) {
        eventListener = listener;

        return () => {
          eventListener = undefined;
        };
      },
      async send(method: string, _params: Record<string, unknown> = {}, sessionId?: string) {
        calls.push({ method, sessionId });

        if (method === 'Target.createTarget') {
          return { targetId: 'page-target' };
        }

        if (method === 'Target.attachToTarget') {
          return { sessionId: 'page-session' };
        }

        if (method === 'Page.navigate') {
          await eventListener?.({
            method: 'Target.attachedToTarget',
            params: { sessionId: 'worker-session', targetInfo: { type: 'service_worker' } },
          });
          await eventListener?.({
            method: 'Network.responseReceived',
            sessionId: 'page-session',
            params: { response: { url: 'http://127.0.0.1:43124/', status: 200 } },
          });
          await eventListener?.({
            method: 'Network.responseReceived',
            sessionId: 'worker-session',
            params: { response: { url: 'http://127.0.0.1:43124/sw.js', status: 200 } },
          });
          await eventListener?.({
            method: 'Network.loadingFailed',
            sessionId: 'worker-session',
            params: { requestId: 'worker-failure', errorText: 'net::ERR_FAILED' },
          });

          return {};
        }

        if (method === 'Runtime.evaluate') {
          return {
            result: { value: { crossOriginIsolated: true, serviceWorkerScriptUrl: 'http://127.0.0.1:43124/sw.js' } },
          };
        }

        return {};
      },
      async waitFor(method: string) {
        expect(method).toBe('Page.loadEventFired');
      },
    };

    const evidence = await captureNexariBrowserEvidence({ cdp, appUrl: 'http://127.0.0.1:43124/' });
    const navigateIndex = calls.findIndex((call) => call.method === 'Page.navigate');

    expect(calls.slice(0, navigateIndex).map((call) => call.method)).toEqual(
      expect.arrayContaining([
        'Target.createTarget',
        'Target.attachToTarget',
        'Target.setAutoAttach',
        'Runtime.enable',
        'Network.enable',
        'Page.enable',
      ]),
    );
    expect(calls.find((call) => call.method === 'Runtime.enable' && call.sessionId === 'worker-session')).toBeDefined();
    expect(evidence.failures).toEqual([{ requestId: 'worker-failure', errorText: 'net::ERR_FAILED' }]);
  });

  it('reloads once after service-worker readiness if the first document has no controller', async () => {
    const calls: string[] = [];
    let evaluateCount = 0;
    const cdp = {
      onEvent() {
        return () => undefined;
      },
      async send(method: string) {
        calls.push(method);

        if (method === 'Target.createTarget') {
          return { targetId: 'page-target' };
        }

        if (method === 'Target.attachToTarget') {
          return { sessionId: 'page-session' };
        }

        if (method === 'Runtime.evaluate') {
          evaluateCount += 1;
          return {
            result: {
              value:
                evaluateCount === 1
                  ? { crossOriginIsolated: true, serviceWorkerScriptUrl: null }
                  : { crossOriginIsolated: true, serviceWorkerScriptUrl: 'http://127.0.0.1:43124/sw.js' },
            },
          };
        }

        return {};
      },
      waitFor() {
        return Promise.resolve();
      },
    };

    const evidence = await captureNexariBrowserEvidence({ cdp, appUrl: 'http://127.0.0.1:43124/' });

    expect(calls.filter((method) => method === 'Page.reload')).toHaveLength(1);
    expect(evaluateCount).toBe(2);
    expect(evidence.serviceWorkerScriptUrl).toBe('http://127.0.0.1:43124/sw.js');
  });

  it('connects raw CDP through an injected WebSocket and routes replies by command id', async () => {
    class FakeWebSocket {
      listeners = new Map<string, Array<(event: { data?: string; error?: Error }) => void>>();
      sent: string[] = [];
      closed = false;

      constructor() {
        queueMicrotask(() => this.emit('open', {}));
      }

      addEventListener(type: string, listener: (event: { data?: string; error?: Error }) => void) {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
      }

      emit(type: string, event: { data?: string; error?: Error }) {
        for (const listener of this.listeners.get(type) ?? []) {
          listener(event);
        }
      }

      send(message: string) {
        this.sent.push(message);

        const request = JSON.parse(message);
        queueMicrotask(() =>
          this.emit('message', { data: JSON.stringify({ id: request.id, result: { product: 'Chrome' } }) }),
        );
      }

      close() {
        this.closed = true;
      }
    }

    const cdp = await connectRawCdp({
      webSocketUrl: 'ws://127.0.0.1:43123/devtools/browser/test',
      WebSocket: FakeWebSocket as any,
    });

    await expect(cdp.send('Browser.getVersion')).resolves.toEqual({ product: 'Chrome' });
    cdp.close();
  });

  it('rejects an unapproved E2E run before allocating ports or spawning children', async () => {
    const acquirePort = vi.fn();

    await expect(
      runNexariE2E({
        approvalToken: undefined,
        dependencies: { acquirePort },
      } as any),
    ).rejects.toThrow(NexariCdpApprovalRequiredError);
    expect(acquirePort).not.toHaveBeenCalled();
  });

  it('treats HTML app readiness as ready without attempting JSON decoding', async () => {
    const server = new EventEmitter() as EventEmitter & { exitCode: number | null };
    const chrome = new EventEmitter() as EventEmitter & { exitCode: number | null };
    server.exitCode = null;
    chrome.exitCode = null;

    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.reject(new SyntaxError('HTML is not JSON')) })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ webSocketDebuggerUrl: 'ws://127.0.0.1:43123/devtools/browser/test' }),
      });
    const stopChild = vi.fn().mockResolvedValue(undefined);
    const capture = vi.fn().mockResolvedValue({
      responses: [
        { url: 'http://127.0.0.1:43124/', status: 200 },
        { url: 'http://127.0.0.1:43124/sw.js', status: 200 },
        { url: 'http://127.0.0.1:43124/assets/kernel-worker.js', status: 200 },
      ],
      failures: [],
      consoleErrors: [],
      crossOriginIsolated: true,
      serviceWorkerScriptUrl: 'http://127.0.0.1:43124/sw.js',
    });
    const cdp = { close: vi.fn() };

    await expect(
      runNexariE2E({
        approvalToken: OWNER_APPROVAL_TOKEN,
        env: { VITE_RUNTIME_BACKEND: 'nexari' },
        dependencies: {
          acquirePort: vi.fn().mockResolvedValueOnce(43124).mockResolvedValueOnce(43123),
          startServer: vi.fn().mockReturnValue(server),
          startChrome: vi.fn().mockReturnValue(chrome),
          createOwnedProfile: (callback: (profileDirectory: string) => Promise<unknown>) =>
            callback('/tmp/nexari-cdp-e2e'),
          fetch,
          runtime: { WebSocket: class {}, fetch },
          connect: vi.fn().mockResolvedValue(cdp),
          capture,
          stopChild,
        },
      } as any),
    ).resolves.toMatchObject({ passed: true, appUrl: 'http://127.0.0.1:43124/' });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(capture).toHaveBeenCalledWith({ cdp, appUrl: 'http://127.0.0.1:43124/' });
    expect(stopChild).toHaveBeenCalledWith(chrome);
    expect(stopChild).toHaveBeenCalledWith(server);
  });

  it('reports an owned child error during readiness without waiting for a timeout', async () => {
    const server = new EventEmitter() as EventEmitter & { exitCode: number | null };
    server.exitCode = null;

    const startServer = vi.fn(() => {
      setTimeout(() => server.emit('error', new Error('spawn ENOENT')), 0);
      return server;
    });

    await expect(
      runNexariE2E({
        approvalToken: OWNER_APPROVAL_TOKEN,
        env: { VITE_RUNTIME_BACKEND: 'nexari' },
        timeoutMs: 10,
        dependencies: {
          acquirePort: vi.fn().mockResolvedValueOnce(43124).mockResolvedValueOnce(43123),
          startServer,
          fetch: vi.fn().mockRejectedValue(new Error('not ready')),
          runtime: { WebSocket: class {}, fetch: vi.fn() },
          stopChild: vi.fn().mockResolvedValue(undefined),
        },
      } as any),
    ).rejects.toThrow('spawn ENOENT');
  });

  it('requires the Nexari selector before allocating ports or starting injected children', async () => {
    const acquirePort = vi.fn();
    const startServer = vi.fn();

    await expect(
      runNexariE2E({
        approvalToken: OWNER_APPROVAL_TOKEN,
        env: { VITE_RUNTIME_BACKEND: 'stackblitz' },
        dependencies: {
          acquirePort,
          startServer,
          runtime: { WebSocket: class {}, fetch: vi.fn() },
        },
      } as any),
    ).rejects.toThrow(NexariCdpSelectorError);
    expect(acquirePort).not.toHaveBeenCalled();
    expect(startServer).not.toHaveBeenCalled();
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
