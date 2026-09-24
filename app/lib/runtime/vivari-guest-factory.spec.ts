import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { NexariRuntimeTerminatedError } from './nexari-runtime';
import {
  createVivariGuestFactory,
  type VivariGuestProcessLike,
  type VivariGuestRuntimeLike,
  type VivariSdkLike,
} from './vivari-guest-factory';

function textStream(contents: string): ReadableStream<string> {
  return new ReadableStream({
    start(controller) {
      if (contents.length > 0) {
        controller.enqueue(contents);
      }

      controller.close();
    },
  });
}

function fakeVivariProcess({
  stdout = '',
  stderr = '',
  exitCode = 0,
}: { stdout?: string; stderr?: string; exitCode?: number } = {}): VivariGuestProcessLike {
  return {
    stdout: textStream(stdout),
    stderr: textStream(stderr),
    exit: Promise.resolve(exitCode),
    kill: vi.fn(),
  };
}

function createVivariHarness(overrides: { bootError?: Error; isIsolated?: () => boolean } = {}) {
  const guestBoot = overrides.bootError
    ? vi.fn<() => Promise<void>>().mockRejectedValue(overrides.bootError)
    : vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const guestReadFile = vi
    .fn<(path: string, encoding?: 'utf8') => Promise<Uint8Array | string>>()
    .mockResolvedValue(new Uint8Array([1, 2, 3]));
  const guestWriteFile = vi
    .fn<(path: string, contents: Uint8Array | string) => Promise<void>>()
    .mockResolvedValue(undefined);
  const guestReaddir = vi.fn<(path: string) => Promise<string[]>>().mockResolvedValue(['a.txt']);
  const guestMkdir = vi
    .fn<(path: string, options?: { recursive?: boolean }) => Promise<void>>()
    .mockResolvedValue(undefined);
  const guestRm = vi
    .fn<(path: string, options?: { recursive?: boolean; force?: boolean }) => Promise<void>>()
    .mockResolvedValue(undefined);
  const guestSpawn =
    vi.fn<(command: string, args?: string[], options?: { signal?: AbortSignal }) => Promise<VivariGuestProcessLike>>();
  const guestTeardown = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

  const guest: VivariGuestRuntimeLike = {
    boot: guestBoot,
    fs: {
      readFile: guestReadFile,
      writeFile: guestWriteFile,
      readdir: guestReaddir,
      mkdir: guestMkdir,
      rm: guestRm,
    },
    spawn: guestSpawn,
    teardown: guestTeardown,
  };

  const createVivariRuntime = vi.fn<() => VivariGuestRuntimeLike>().mockReturnValue(guest);
  const loadSdk = vi.fn<() => Promise<VivariSdkLike>>();

  const factory = createVivariGuestFactory({
    id: 'test-vivari',
    ...(overrides.isIsolated ? { isIsolated: overrides.isIsolated } : {}),
    loadSdk,
    createVivariRuntime,
  });

  return { guest, guestBoot, guestSpawn, guestTeardown, createVivariRuntime, loadSdk, factory };
}

describe('createVivariGuestFactory', () => {
  it('boots the injected vivari runtime once and delegates fs writes to the same guest instance', async () => {
    const { guest, guestBoot, createVivariRuntime, factory } = createVivariHarness();
    const runtime = await factory();

    expect(createVivariRuntime).toHaveBeenCalledTimes(1);
    expect(createVivariRuntime).toHaveBeenLastCalledWith({
      id: 'test-vivari',
      loadSdk: expect.any(Function),
    });

    await runtime.boot();

    expect(guestBoot).toHaveBeenCalledTimes(1);

    await runtime.fs.writeFile('a.txt', 'hello');
    expect(guest.fs.writeFile).toHaveBeenCalledWith('a.txt', 'hello');
  });

  it('forwards the isolation probe and sdk loader by identity to the injected vivari factory', async () => {
    const isIsolated = () => true;
    const { createVivariRuntime, loadSdk, factory } = createVivariHarness({ isIsolated });

    await factory();

    expect(createVivariRuntime).toHaveBeenLastCalledWith({
      id: 'test-vivari',
      isIsolated,
      loadSdk,
    });
  });

  it('deduplicates concurrent boot calls into a single vivari guest boot', async () => {
    const { guestBoot, factory } = createVivariHarness();
    const runtime = await factory();

    await Promise.all([runtime.boot(), runtime.boot()]);

    expect(guestBoot).toHaveBeenCalledTimes(1);
    expect(runtime.state).toBe('ready');
  });

  it('normalizes the utf-8 alias to utf8 while preserving every other read shape', async () => {
    const { guest, factory } = createVivariHarness();
    const runtime = await factory();
    await runtime.boot();

    await runtime.fs.readFile('a.txt');
    expect(guest.fs.readFile).toHaveBeenLastCalledWith('a.txt', undefined);

    await runtime.fs.readFile('a.txt', 'utf8');
    expect(guest.fs.readFile).toHaveBeenLastCalledWith('a.txt', 'utf8');

    await runtime.fs.readFile('a.txt', 'utf-8');
    expect(guest.fs.readFile).toHaveBeenLastCalledWith('a.txt', 'utf8');
  });

  it('throws a typed error for encodings the vivari guest cannot honor', async () => {
    const { guest, factory } = createVivariHarness();
    const runtime = await factory();
    await runtime.boot();

    await expect(runtime.fs.readFile('a.txt', 'hex' as 'utf8')).rejects.toThrow(
      'Unsupported vivari guest read encoding: hex',
    );
    expect(guest.fs.readFile).not.toHaveBeenCalled();
  });

  it('passes mkdir and rm options through unchanged', async () => {
    const { guest, factory } = createVivariHarness();
    const runtime = await factory();
    await runtime.boot();

    await runtime.fs.mkdir('dir', { recursive: true });
    expect(guest.fs.mkdir).toHaveBeenCalledWith('dir', { recursive: true });

    await runtime.fs.rm('dir', { recursive: true, force: true });
    expect(guest.fs.rm).toHaveBeenCalledWith('dir', { recursive: true, force: true });
  });

  it('runs action commands through the vivari sh -c lane and captures the split result', async () => {
    const { guestSpawn, factory } = createVivariHarness();
    const runtime = await factory();
    await runtime.boot();

    guestSpawn.mockResolvedValue(fakeVivariProcess({ stdout: 'out\n', stderr: 'err\n', exitCode: 3 }));

    const result = await runtime.runActionCommand('echo hi');

    expect(guestSpawn).toHaveBeenCalledWith(
      'sh',
      ['-c', 'echo hi'],
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result).toEqual({ stdout: 'out\n', stderr: 'err\n', exitCode: 3 });
  });

  it('bridges vivari processes to the guest process shape with delegated kill', async () => {
    const { guestSpawn, factory } = createVivariHarness();
    const runtime = await factory();
    await runtime.boot();

    const vivariProcess = fakeVivariProcess();
    guestSpawn.mockResolvedValue(vivariProcess);

    const spawned = await runtime.spawn('node', ['--version'], { signal: new AbortController().signal });

    expect(guestSpawn).toHaveBeenCalledWith('node', ['--version'], {
      signal: expect.any(AbortSignal),
    });

    spawned.kill();
    expect(vivariProcess.kill).toHaveBeenCalledTimes(1);
  });

  it('aborts an in-flight action, rejects with the caller reason, and kills the late vivari process', async () => {
    const { guestSpawn, factory } = createVivariHarness();
    const runtime = await factory();
    await runtime.boot();

    let releaseProcess: (process: VivariGuestProcessLike) => void = () => undefined;
    const pendingSpawn = new Promise<VivariGuestProcessLike>((resolve) => {
      releaseProcess = resolve;
    });
    guestSpawn.mockReturnValue(pendingSpawn);

    const controller = new AbortController();
    const action = runtime.runActionCommand('sleep 30', controller.signal);
    const rejection = expect(action).rejects.toBe('stop');

    controller.abort('stop');
    await rejection;

    const lateProcess = fakeVivariProcess();
    const killSpy = vi.mocked(lateProcess.kill);
    releaseProcess(lateProcess);

    await vi.waitFor(() => expect(killSpy).toHaveBeenCalledTimes(1));
  });

  it('propagates a vivari boot rejection without fallback and leaves the runtime terminated', async () => {
    const bootError = new Error('vivari boot failed');
    const { guestTeardown, factory } = createVivariHarness({ bootError });
    const runtime = await factory();

    await expect(runtime.boot()).rejects.toBe(bootError);
    expect(runtime.state).toBe('terminated');

    await expect(runtime.boot()).rejects.toBeInstanceOf(NexariRuntimeTerminatedError);

    await expect(runtime.teardown()).resolves.toBeUndefined();
    expect(guestTeardown).not.toHaveBeenCalled();
  });

  it('tears the vivari guest down exactly once and turns later operations into typed failures', async () => {
    const { guestTeardown, factory } = createVivariHarness();
    const runtime = await factory();
    await runtime.boot();

    await runtime.teardown();
    await runtime.teardown();

    expect(guestTeardown).toHaveBeenCalledTimes(1);
    expect(runtime.state).toBe('terminated');

    await expect(runtime.fs.writeFile('x.txt', 'y')).rejects.toBeInstanceOf(NexariRuntimeTerminatedError);
  });

  it('imports only the local nexari-runtime module: no WebContainer SDK, no vivari package, no dynamic import', async () => {
    const source = await readFile(new URL('./vivari-guest-factory.ts', import.meta.url), 'utf8');

    expect(source).toContain("from './nexari-runtime'");
    expect(source).not.toContain('@webcontainer/api');
    expect(source).not.toContain('@nexari/');
    expect(source).not.toContain('vivari-adapter');
    expect(source).not.toContain('runtime-contract');
    expect(source).not.toContain('import(');
  });
});
