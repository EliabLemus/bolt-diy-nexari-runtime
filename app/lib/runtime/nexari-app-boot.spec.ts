import { describe, expect, it, vi, afterEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import { WORK_DIR_NAME } from '~/utils/constants';
import type { Mock } from 'vitest';
import { createAppNexariBootFactory, defaultCrossOriginIsolationProbe } from './nexari-app-boot';
import type { NexariRuntime } from './nexari-runtime';
import type { VivariGuestProcessLike, VivariGuestRuntimeLike, VivariSdkLike } from './vivari-guest-factory';

interface GuestHarness {
  createVivariRuntime: Mock;
  guestBoot: Mock;
  guestSpawn: Mock;
  guestTeardown: Mock;
  loadSdk: Mock<() => Promise<VivariSdkLike>>;
}

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

function createGuestHarness({ spawnProcess }: { spawnProcess?: VivariGuestProcessLike } = {}): GuestHarness {
  const guestBoot = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const guestSpawn =
    vi.fn<(command: string, args?: string[], options?: { signal?: AbortSignal }) => Promise<VivariGuestProcessLike>>();

  if (spawnProcess) {
    guestSpawn.mockResolvedValue(spawnProcess);
  } else {
    guestSpawn.mockResolvedValue({
      input: new WritableStream<string>(),
      stdout: textStream(),
      stderr: textStream(),
      exit: Promise.resolve(0),
      kill: vi.fn(),
    });
  }

  const guest: VivariGuestRuntimeLike = {
    boot: guestBoot,
    fs: {
      readFile: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
      writeFile: vi.fn().mockResolvedValue(undefined),
      readdir: vi.fn().mockResolvedValue(['a.txt']),
      mkdir: vi.fn().mockResolvedValue(undefined),
      rm: vi.fn().mockResolvedValue(undefined),
    },
    spawn: guestSpawn,
    teardown: vi.fn().mockResolvedValue(undefined),
  };

  return {
    createVivariRuntime: vi.fn().mockReturnValue(guest),
    guestBoot,
    guestSpawn,
    guestTeardown: guest.teardown as Mock,
    loadSdk: vi.fn<() => Promise<VivariSdkLike>>().mockResolvedValue({ boot: vi.fn() }),
  };
}

function createBootFactory(harness: GuestHarness, overrides: Parameters<typeof createAppNexariBootFactory>[1] = {}) {
  return createAppNexariBootFactory(
    {
      loadSdk: harness.loadSdk,
      createVivariRuntime: harness.createVivariRuntime,
    },
    overrides,
  );
}

const isolationGlobals = ['crossOriginIsolated', 'SharedArrayBuffer'] as const;
type IsolationGlobal = (typeof isolationGlobals)[number];

const savedDescriptors = new Map<IsolationGlobal, PropertyDescriptor | undefined>();

function stubIsolationGlobal(name: IsolationGlobal, value: unknown): void {
  if (!savedDescriptors.has(name)) {
    savedDescriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  }

  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

afterEach(() => {
  for (const name of isolationGlobals) {
    const saved = savedDescriptors.get(name);

    if (saved) {
      Object.defineProperty(globalThis, name, saved);
    } else {
      delete (globalThis as Record<string, unknown>)[name];
    }

    savedDescriptors.delete(name);
  }
});

const sharedArrayBufferStub = () => undefined;

describe('defaultCrossOriginIsolationProbe', () => {
  it('returns true only when the browser is cross-origin isolated and SharedArrayBuffer exists', () => {
    stubIsolationGlobal('crossOriginIsolated', true);
    stubIsolationGlobal('SharedArrayBuffer', sharedArrayBufferStub);

    expect(defaultCrossOriginIsolationProbe()).toBe(true);
  });

  it('returns false when crossOriginIsolated is false', () => {
    stubIsolationGlobal('crossOriginIsolated', false);

    expect(defaultCrossOriginIsolationProbe()).toBe(false);
  });

  it('returns false when SharedArrayBuffer is absent', () => {
    stubIsolationGlobal('crossOriginIsolated', true);
    stubIsolationGlobal('SharedArrayBuffer', undefined);

    expect(defaultCrossOriginIsolationProbe()).toBe(false);
  });

  it('is SSR/node-safe when neither isolation global exists', () => {
    stubIsolationGlobal('crossOriginIsolated', undefined);
    stubIsolationGlobal('SharedArrayBuffer', undefined);

    expect(defaultCrossOriginIsolationProbe()).toBe(false);
  });
});

describe('createAppNexariBootFactory', () => {
  it('composes the guest eagerly: the injected vivari constructor runs exactly once at composition time', () => {
    const harness = createGuestHarness();

    createBootFactory(harness);

    expect(harness.createVivariRuntime).toHaveBeenCalledOnce();
  });

  it('repeated factory invocations reuse the single composed guest without re-invoking the constructor', () => {
    const harness = createGuestHarness();
    const bootFactory = createBootFactory(harness);

    const first = bootFactory();
    const second = bootFactory();

    expect(harness.createVivariRuntime).toHaveBeenCalledOnce();
    expect(first).not.toBe(second);
  });

  it('boots the vivari guest inside the nexari boot seam, not at factory creation', async () => {
    const harness = createGuestHarness();
    const bootFactory = createBootFactory(harness);

    const runtime = await bootFactory();

    expect(harness.guestBoot).not.toHaveBeenCalled();

    await runtime.boot();

    expect(harness.guestBoot).toHaveBeenCalledOnce();
    expect(runtime.state).toBe('ready');
    expect(harness.loadSdk).not.toHaveBeenCalled();
  });

  it('forwards the composed options (default id, probe, sdk loader) to the injected constructor', () => {
    const harness = createGuestHarness();

    createBootFactory(harness)();

    expect(harness.createVivariRuntime).toHaveBeenCalledWith({
      id: WORK_DIR_NAME,
      isIsolated: defaultCrossOriginIsolationProbe,
      loadSdk: harness.loadSdk,
    });
  });

  it('forwards an explicit isIsolated override by identity', () => {
    const harness = createGuestHarness();
    const override = () => false;

    createBootFactory(harness, { isIsolated: override })();

    expect(harness.createVivariRuntime).toHaveBeenCalledWith(expect.objectContaining({ isIsolated: override }));
  });

  it('defaults the runtime id to WORK_DIR_NAME and forwards an explicit id verbatim', () => {
    const harness = createGuestHarness();

    createBootFactory(harness)();

    expect(harness.createVivariRuntime).toHaveBeenCalledWith(expect.objectContaining({ id: WORK_DIR_NAME }));

    createBootFactory(harness, { id: 'custom-runtime' })();

    expect(harness.createVivariRuntime).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'custom-runtime' }));
  });

  it('keeps action-command abort passthrough intact across the composition boundary', async () => {
    const kill = vi.fn();
    const harness = createGuestHarness({
      spawnProcess: {
        input: new WritableStream<string>(),
        stdout: textStream('', false),
        stderr: textStream('', false),
        exit: new Promise<number>(() => undefined),
        kill,
      },
    });
    const bootFactory = createBootFactory(harness);
    const runtime: NexariRuntime = await bootFactory();

    await runtime.boot();

    const controller = new AbortController();
    const pending = runtime.runActionCommand('sleep 5', controller.signal);

    await vi.waitFor(() => expect(harness.guestSpawn).toHaveBeenCalledOnce());

    expect(harness.guestSpawn).toHaveBeenCalledWith(
      'sh',
      ['-c', 'sleep 5'],
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    controller.abort('user-cancelled');

    await expect(pending).rejects.toBe('user-cancelled');
    expect(kill).toHaveBeenCalled();
  });

  it('imports only runtime-internal modules and never references the webcontainer seam or SDK', async () => {
    const source = await readFile(new URL('./nexari-app-boot.ts', import.meta.url), 'utf8');

    expect(source).toMatch(/from '\.\/vivari-guest-factory'/);
    expect(source).not.toMatch(/@webcontainer\/api/);
    expect(source).not.toMatch(/~\/lib\/webcontainer/);
  });
});
