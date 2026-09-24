import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  NexariRuntimeTerminatedError,
  createNexariRuntime,
  type NexariGuestRuntime,
  type NexariGuestProcess,
} from './nexari-runtime';

function stream(contents: string): ReadableStream<string> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(contents);
      controller.close();
    },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });

  return { promise, resolve };
}

function createGuest() {
  const process: NexariGuestProcess = {
    stdout: stream('stdout'),
    stderr: stream('stderr'),
    exit: Promise.resolve(17),
    kill: vi.fn(),
  };
  const guest: NexariGuestRuntime = {
    fs: {
      readFile: vi.fn().mockResolvedValue('read'),
      writeFile: vi.fn().mockResolvedValue(undefined),
      readdir: vi.fn().mockResolvedValue(['entry']),
      mkdir: vi.fn().mockResolvedValue(undefined),
      rm: vi.fn().mockResolvedValue(undefined),
    },
    spawn: vi.fn().mockResolvedValue(process),
    teardown: vi.fn().mockResolvedValue(undefined),
  };

  return { guest, process };
}

describe('createNexariRuntime', () => {
  it('boots an injected guest and delegates basic guest filesystem operations without rewriting paths', async () => {
    const { guest } = createGuest();
    const boot = vi.fn().mockResolvedValue(guest);
    const runtime = createNexariRuntime({ boot });

    await runtime.boot();
    await expect(runtime.fs.readFile('/project/readme.md', 'utf-8')).resolves.toBe('read');
    await runtime.fs.writeFile('/project/write.txt', 'contents');
    await expect(runtime.fs.readdir('/project')).resolves.toEqual(['entry']);
    await runtime.fs.mkdir('/project/new', { recursive: true });
    await runtime.fs.rm('/project/old', { recursive: true, force: true });

    expect(boot).toHaveBeenCalledOnce();
    expect(guest.fs.readFile).toHaveBeenCalledWith('/project/readme.md', 'utf-8');
    expect(guest.fs.writeFile).toHaveBeenCalledWith('/project/write.txt', 'contents');
    expect(guest.fs.readdir).toHaveBeenCalledWith('/project');
    expect(guest.fs.mkdir).toHaveBeenCalledWith('/project/new', { recursive: true });
    expect(guest.fs.rm).toHaveBeenCalledWith('/project/old', { recursive: true, force: true });
  });

  it('captures action command stdout, stderr, and numeric exit code', async () => {
    const { guest } = createGuest();
    const runtime = createNexariRuntime({ boot: vi.fn().mockResolvedValue(guest) });
    await runtime.boot();

    await expect(runtime.runActionCommand('npm run build')).resolves.toEqual({
      stdout: 'stdout',
      stderr: 'stderr',
      exitCode: 17,
    });
    expect(guest.spawn).toHaveBeenCalledOnce();
    expect(guest.spawn).toHaveBeenCalledWith('sh', ['-c', 'npm run build'], {
      signal: expect.any(AbortSignal),
    });
  });

  it('cancels only the action process and leaves the guest runtime ready', async () => {
    const { guest, process } = createGuest();
    const controller = new AbortController();
    const exit = deferred<number>();
    process.exit = exit.promise;

    const runtime = createNexariRuntime({ boot: vi.fn().mockResolvedValue(guest) });
    await runtime.boot();

    const command = runtime.runActionCommand('npm run build', controller.signal);
    controller.abort();

    await expect(command).rejects.toBe(controller.signal.reason);
    expect(process.kill).toHaveBeenCalledOnce();
    expect(runtime.state).toBe('ready');
    expect(guest.teardown).not.toHaveBeenCalled();
  });

  it('does not wait for a cancelled guest process to exit', async () => {
    const { guest, process } = createGuest();
    const controller = new AbortController();
    const exit = deferred<number>();
    process.exit = exit.promise;

    const runtime = createNexariRuntime({ boot: vi.fn().mockResolvedValue(guest) });
    await runtime.boot();

    const command = runtime.runActionCommand('npm run build', controller.signal);
    await new Promise(setImmediate);
    controller.abort();

    await expect(command).rejects.toBe(controller.signal.reason);
    expect(process.kill).toHaveBeenCalledOnce();
    expect(runtime.state).toBe('ready');
  });

  it('cancels an action waiting to spawn when teardown begins, then kills its late process', async () => {
    const { guest, process } = createGuest();
    const spawn = deferred<NexariGuestProcess>();

    vi.mocked(guest.spawn).mockReturnValueOnce(spawn.promise);

    const runtime = createNexariRuntime({ boot: vi.fn().mockResolvedValue(guest) });
    await runtime.boot();

    const command = runtime.runActionCommand('npm run build');
    await runtime.teardown();

    await expect(command).rejects.toBeInstanceOf(NexariRuntimeTerminatedError);
    spawn.resolve(process);
    await new Promise(setImmediate);
    expect(process.kill).toHaveBeenCalledOnce();
  });

  it('cancels an active action immediately when teardown begins', async () => {
    const { guest, process } = createGuest();
    const exit = deferred<number>();

    process.exit = exit.promise;

    const runtime = createNexariRuntime({ boot: vi.fn().mockResolvedValue(guest) });
    await runtime.boot();

    const command = runtime.runActionCommand('npm run build');
    await new Promise(setImmediate);
    await runtime.teardown();

    await expect(command).rejects.toBeInstanceOf(NexariRuntimeTerminatedError);
    expect(process.kill).toHaveBeenCalledOnce();
  });

  it('contains a guest teardown rejection when boot resolves after teardown', async () => {
    const { guest } = createGuest();
    const boot = deferred<NexariGuestRuntime>();
    const teardownFailure = new Error('guest teardown failed');
    vi.mocked(guest.teardown).mockRejectedValueOnce(teardownFailure);

    const runtime = createNexariRuntime({ boot: vi.fn().mockReturnValue(boot.promise) });

    const booting = runtime.boot();
    await runtime.teardown();
    boot.resolve(guest);

    await expect(booting).rejects.toBeInstanceOf(NexariRuntimeTerminatedError);

    await new Promise(setImmediate);
    expect(guest.teardown).toHaveBeenCalledOnce();
  });

  it('fails closed after boot rejects', async () => {
    const bootFailure = new Error('guest boot failed');
    const boot = vi.fn().mockRejectedValue(bootFailure);
    const runtime = createNexariRuntime({ boot });

    await expect(runtime.boot()).rejects.toBe(bootFailure);
    expect(runtime.state).toBe('terminated');
    await expect(runtime.boot()).rejects.toBeInstanceOf(NexariRuntimeTerminatedError);
    await expect(runtime.fs.readFile('/project/after-failure.txt')).rejects.toThrow(NexariRuntimeTerminatedError);
    await expect(runtime.runActionCommand('echo never')).rejects.toBeInstanceOf(NexariRuntimeTerminatedError);
    expect(boot).toHaveBeenCalledOnce();
  });

  it('rejects a guest result that resolves after teardown and prevents future guest calls', async () => {
    const { guest } = createGuest();
    const pendingRead = deferred<string>();
    vi.mocked(guest.fs.readFile).mockReturnValueOnce(pendingRead.promise);

    const runtime = createNexariRuntime({ boot: vi.fn().mockResolvedValue(guest) });
    await runtime.boot();

    const read = runtime.fs.readFile('/project/late.txt');
    await runtime.teardown();
    pendingRead.resolve('stale value');

    await expect(read).rejects.toBeInstanceOf(NexariRuntimeTerminatedError);
    await expect(runtime.fs.readFile('/project/after.txt')).rejects.toBeInstanceOf(NexariRuntimeTerminatedError);
    expect(guest.fs.readFile).toHaveBeenCalledOnce();
    await expect(runtime.boot()).rejects.toBeInstanceOf(NexariRuntimeTerminatedError);
  });

  it('contains no StackBlitz or host filesystem/network imports', async () => {
    const source = await readFile(new URL('./nexari-runtime.ts', import.meta.url), 'utf8');

    expect(source).not.toMatch(
      /@webcontainer\/api|node:(?:fs|http|https|net|os)|\b(?:fetch|XMLHttpRequest|WebSocket)\b/,
    );
  });
});
