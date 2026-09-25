import { describe, expect, it, vi, afterEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import type { WebContainer } from '@webcontainer/api';
import { WORK_DIR_NAME } from '~/utils/constants';
import { createAppNexariBootFactory } from './nexari-app-boot';
import { createBrowserRuntime } from './browser-runtime';
import { createNexariActionShell } from './nexari-action-shell';
import { NexariRuntimeTerminatedError } from './nexari-runtime';
import type { VivariGuestProcessLike, VivariGuestRuntimeLike, VivariSdkLike } from './vivari-guest-factory';
import type { NexariBrowserRuntime } from './nexari-runtime-facade';
import type { Mock } from 'vitest';

/**
 * Vertical composition slice: proves the composed production Nexari boot path
 * (createAppNexariBootFactory → createBrowserRuntime('nexari') → facade →
 * ActionShell / facade.fs) with an inert in-memory vivari guest. Only the
 * vivari guest boundary is faked — the selector composition, lifecycle
 * adapter, facade reshaping, and action-shell composition all run their real
 * code. The StackBlitz control path is asserted untouched: no boot call and
 * no `@webcontainer/api` runtime load (AC-5).
 */

function textStream(contents = '', close = true): ReadableStream<string> {
  return new ReadableStream({
    start(controller) {
      if (contents.length > 0) {
        controller.enqueue(contents);
      }

      if (close) {
        controller.close();
      }
    },
  });
}

interface GuestHarness {
  guest: VivariGuestRuntimeLike;
  boot: Mock;
  spawn: Mock;
  teardown: Mock;
  loadSdk: Mock<() => Promise<VivariSdkLike>>;
  createVivariRuntime: Mock;
  files: Map<string, Uint8Array | string>;
  calls: {
    mkdir: Array<{ path: string; options?: { recursive?: boolean } }>;
    readdir: string[];
    rm: Array<{ path: string; options?: { recursive?: boolean; force?: boolean } }>;
  };
}

/**
 * In-memory vivari guest: inert (no host fs, no network) and exercising the
 * same ReadableStream shapes the pinned adapter is expected to produce, so
 * stream close semantics match the runtime adapter's readStream expectations.
 */
function createGuestHarness(): GuestHarness {
  const files = new Map<string, Uint8Array | string>();
  const calls: GuestHarness['calls'] = { mkdir: [], readdir: [], rm: [] };
  const boot = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const teardown = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const spawn =
    vi.fn<(command: string, args?: string[], options?: { signal?: AbortSignal }) => Promise<VivariGuestProcessLike>>();
  const loadSdk = vi.fn<() => Promise<VivariSdkLike>>().mockResolvedValue({ boot: vi.fn() });

  const guest: VivariGuestRuntimeLike = {
    boot,
    fs: {
      readFile: vi.fn(async (path: string) => {
        const contents = files.get(path);

        if (contents === undefined) {
          throw new Error(`ENOENT: ${path}`);
        }

        return contents;
      }),
      writeFile: vi.fn(async (path: string, contents: Uint8Array | string) => {
        files.set(path, contents);
      }),
      readdir: vi.fn(async (path: string) => {
        calls.readdir.push(path);

        return ['src', 'package.json'].filter((entry) => entry !== 'package.json' || path === '/');
      }),
      mkdir: vi.fn(async (path: string, options?: { recursive?: boolean }) => {
        calls.mkdir.push({ path, options });
      }),
      rm: vi.fn(async (path: string, options?: { recursive?: boolean; force?: boolean }) => {
        calls.rm.push({ path, options });
      }),
    },
    spawn,
    teardown,
  };

  const createVivariRuntime = vi.fn(() => guest);

  return {
    guest,
    boot,
    spawn,
    teardown,
    loadSdk,
    createVivariRuntime,
    files,
    calls,
  };
}

function createComposedRuntime(
  harness: GuestHarness,
  bootStackblitz: () => Promise<WebContainer> = vi.fn(),
): Promise<NexariBrowserRuntime> {
  const bootNexari = createAppNexariBootFactory(
    {
      loadSdk: harness.loadSdk,
      createVivariRuntime: harness.createVivariRuntime,
    },
    { isIsolated: () => true },
  );

  return createBrowserRuntime('nexari', {
    bootStackblitz,
    bootNexari,
  }) as Promise<NexariBrowserRuntime>;
}

const webcontainerImportProbe = vi.hoisted(() => ({ count: 0 }));

vi.mock('@webcontainer/api', () => {
  webcontainerImportProbe.count += 1;

  return {};
});

describe('nexari vertical composition', () => {
  afterEach(async () => {
    vi.clearAllMocks();
  });

  it('AC-1: boots the composed factory to a ready facade without touching the StackBlitz path', async () => {
    const harness = createGuestHarness();
    const bootStackblitz = vi.fn();

    const runtime = await createComposedRuntime(harness, bootStackblitz);

    expect(runtime.state).toBe('ready');
    expect(bootStackblitz).not.toHaveBeenCalled();
    expect(harness.boot).toHaveBeenCalledTimes(1);
    expect(harness.teardown).not.toHaveBeenCalled();
    expect(harness.createVivariRuntime).toHaveBeenCalledOnce();
    expect(harness.createVivariRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        id: WORK_DIR_NAME,
        isIsolated: expect.any(Function),
        loadSdk: harness.loadSdk,
      }),
    );
  });

  it('AC-2: propagates the original guest boot rejection unwrapped', async () => {
    const harness = createGuestHarness();
    const bootError = new Error('guest boot failed');
    harness.boot.mockRejectedValue(bootError);

    const pending = createComposedRuntime(harness);

    await expect(pending).rejects.toBe(bootError);
  });

  it('AC-3: action lane executes a command through the composed runtime and shell', async () => {
    const harness = createGuestHarness();
    harness.spawn.mockImplementation(async (command: string, args?: string[]) => {
      expect(command).toBe('sh');
      expect(args).toEqual(['-c', 'echo hello']);

      return {
        stdout: textStream('hello'),
        stderr: textStream('a warning'),
        exit: Promise.resolve(0),
        kill: vi.fn(),
      };
    });

    const runtime = await createComposedRuntime(harness);
    const shell = createNexariActionShell(runtime);
    const controller = new AbortController();
    const preempt = vi.fn();

    const result = await shell.executeCommand('session-1', 'echo hello', preempt, controller.signal);

    expect(result).toEqual({ output: 'hello\na warning', exitCode: 0 });
    expect(preempt).not.toHaveBeenCalled();
    expect(harness.spawn).toHaveBeenCalledOnce();
  });

  it('AC-4: filesystem basics pass through the composed runtime to the guest', async () => {
    const harness = createGuestHarness();
    const runtime = await createComposedRuntime(harness);

    const contents = new Uint8Array([1, 2, 3]);
    await runtime.fs.writeFile('/project/src/main.ts', contents);
    await expect(runtime.fs.readFile('/project/src/main.ts')).resolves.toEqual(contents);

    await runtime.fs.mkdir('/project/src', { recursive: true });
    expect(harness.calls.mkdir).toEqual([{ path: '/project/src', options: { recursive: true } }]);

    await runtime.fs.readdir('/project');
    expect(harness.calls.readdir).toEqual(['/project']);

    await runtime.fs.rm('/project/src', { recursive: true, force: true });
    expect(harness.calls.rm).toEqual([{ path: '/project/src', options: { recursive: true, force: true } }]);

    await runtime.teardown();
    expect(harness.teardown).toHaveBeenCalledOnce();
    expect(runtime.state).toBe('terminated');
  });

  it('AC-6: running an action on a terminated composed runtime fails typed and inertly', async () => {
    const harness = createGuestHarness();
    harness.spawn.mockResolvedValue({
      stdout: textStream(''),
      stderr: textStream(''),
      exit: Promise.resolve(0),
      kill: vi.fn(),
    });

    const runtime = await createComposedRuntime(harness);
    await runtime.teardown();

    const shell = createNexariActionShell(runtime);

    await expect(shell.assertRunnable()).rejects.toBeInstanceOf(NexariRuntimeTerminatedError);
    await expect(
      shell.executeCommand('session-1', 'echo nope', vi.fn(), new AbortController().signal),
    ).rejects.toBeInstanceOf(NexariRuntimeTerminatedError);
    expect(harness.spawn).not.toHaveBeenCalled();
  });

  it('AC-5: the composed nexari boot path never loads @webcontainer/api at runtime', async () => {
    const source = await readFile(new URL('./browser-runtime.ts', import.meta.url), 'utf8');

    expect(source).toMatch(/await import\('@webcontainer\/api'\)/);

    const harness = createGuestHarness();

    await createComposedRuntime(harness);

    expect(webcontainerImportProbe.count).toBe(0);
  });
});
