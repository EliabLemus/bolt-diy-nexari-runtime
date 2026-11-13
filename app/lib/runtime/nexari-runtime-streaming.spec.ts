import { describe, expect, it, vi } from 'vitest';
import {
  createNexariRuntime,
  type NexariGuestRuntime,
  type NexariGuestProcess,
} from './nexari-runtime';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

/** Controllable stream: chunks are enqueued only when the test pushes them. */
function manualStream(): { stream: ReadableStream<string>; push(chunk: string): void; close(): void } {
  let controller!: ReadableStreamDefaultController<string>;
  const stream = new ReadableStream<string>({
    start(c) {
      controller = c;
    },
  });

  return {
    stream,
    // ponytail: enqueue after cancel/kill throws — a killed guest cannot write.
    push: (chunk) => {
      try {
        controller.enqueue(chunk);
      } catch {
        // stream already closed by cancellation
      }
    },
    close: () => {
      try {
        controller.close();
      } catch {
        // already closed
      }
    },
  };
}

function createGuest(seeds: { stdout?: string; stderr?: string } = {}) {
  const out = manualStream();
  const err = manualStream();

  if (seeds.stdout !== undefined) {
    out.push(seeds.stdout);
    out.close();
  }
  if (seeds.stderr !== undefined) {
    err.push(seeds.stderr);
    err.close();
  }
  const process: NexariGuestProcess = {
    input: new WritableStream<string>(),
    stdout: out.stream,
    stderr: err.stream,
    exit: Promise.resolve(17),
    kill: vi.fn(),
  };
  const guest: NexariGuestRuntime = {
    fs: {
      readFile: vi.fn().mockResolvedValue(''),
      writeFile: vi.fn().mockResolvedValue(undefined),
      readdir: vi.fn().mockResolvedValue([]),
      mkdir: vi.fn().mockResolvedValue(undefined),
      rm: vi.fn().mockResolvedValue(undefined),
    },
    spawn: vi.fn().mockResolvedValue(process),
    teardown: vi.fn().mockResolvedValue(undefined),
  };

  return { guest, process, out, err };
}

describe('runActionCommandStreaming', () => {
  it('delivers chunks before exit and returns the aggregated result', async () => {
    const { guest, process, out, err } = createGuest();
    const exit = deferred<number>();
    process.exit = exit.promise;

    const runtime = createNexariRuntime({ boot: vi.fn().mockResolvedValue(guest) });
    await runtime.boot();

    const chunks: Array<[string, 'stdout' | 'stderr']> = [];
    const result = runtime.runActionCommandStreaming('npm install', undefined, (chunk, stream) => {
      chunks.push([chunk, stream]);
    });

    await new Promise(setImmediate);
    out.push('added 50 packages');
    err.push('npm warn');
    await new Promise(setImmediate);

    expect(chunks).toEqual([
      ['added 50 packages', 'stdout'],
      ['npm warn', 'stderr'],
    ]);
    expect(result).toBeInstanceOf(Promise);

    exit.resolve(0);
    out.close();
    err.close();

    await expect(result).resolves.toEqual({
      stdout: 'added 50 packages',
      stderr: 'npm warn',
      exitCode: 0,
    });
    expect(guest.spawn).toHaveBeenCalledWith('sh', ['-c', 'npm install'], {
      signal: expect.any(AbortSignal),
    });
  });

  it('aborts: kills the process, rejects with the signal reason, and stops callbacks', async () => {
    const { guest, process, out, err } = createGuest();
    const controller = new AbortController();

    const runtime = createNexariRuntime({ boot: vi.fn().mockResolvedValue(guest) });
    await runtime.boot();

    const chunks: string[] = [];
    const result = runtime.runActionCommandStreaming('npm install', controller.signal, (chunk) => {
      chunks.push(chunk);
    });
    await new Promise(setImmediate);

    out.push('partial');
    await new Promise(setImmediate);
    controller.abort();
    out.push('after-abort');
    err.close();

    await expect(result).rejects.toBe(controller.signal.reason);
    expect(process.kill).toHaveBeenCalledOnce();
    expect(chunks).toEqual(['partial']);
    expect(runtime.state).toBe('ready');
  });

  it('aggregates the same result as runActionCommand', async () => {
    const { guest } = createGuest();
    // Streams are single-use: each spawn gets a fresh process.
    vi.mocked(guest.spawn).mockImplementation(async () => createGuest({ stdout: 'stdout', stderr: 'stderr' }).process);
    const runtime = createNexariRuntime({ boot: vi.fn().mockResolvedValue(guest) });
    await runtime.boot();

    const reference = await runtime.runActionCommand('npm run build');
    const chunks: Array<[string, 'stdout' | 'stderr']> = [];
    await expect(
      runtime.runActionCommandStreaming('npm run build', undefined, (chunk, stream) => {
        chunks.push([chunk, stream]);
      }),
    ).resolves.toEqual(reference);
    expect(chunks).toEqual([
      ['stdout', 'stdout'],
      ['stderr', 'stderr'],
    ]);
  });
});
