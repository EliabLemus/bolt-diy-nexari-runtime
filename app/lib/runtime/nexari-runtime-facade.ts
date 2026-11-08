import { WORK_DIR } from '~/utils/constants';
import type { NexariActionCommandResult, NexariRuntime, NexariRuntimeState } from './nexari-runtime';

/**
 * Typed, visible refusal for a capability that exists on the WebContainer
 * surface but is outside the current nexari slice. Never a silent no-op.
 */
export class NexariUnsupportedCapabilityError extends Error {
  constructor(capability: string) {
    super(`The nexari runtime does not support ${capability} in this build yet.`);
    this.name = 'NexariUnsupportedCapabilityError';
  }
}

export type NexariFsEncoding = 'utf8' | 'utf-8';

export interface NexariFsEncodingOptions {
  encoding?: NexariFsEncoding;
}

export interface NexariReaddirOptions {
  /**
   * Dirent-bearing reads are a later slice. The type admits `false` (and an
   * absent key) while the facade rejects every other shape with a typed error.
   */
  withFileTypes?: false;
}

/**
 * WebContainer-shaped filesystem surface exposed by the facade. Call shapes
 * the nexari guest cannot honor (non-UTF-8 encodings, dirent reads, unknown
 * option keys) are rejected at this edge with typed errors instead of being
 * silently dropped by a narrower adapter signature.
 */
export interface NexariBrowserFileSystem {
  readFile(path: string, encoding?: NexariFsEncoding): Promise<Uint8Array | string>;
  writeFile(
    path: string,
    contents: Uint8Array | string,
    encoding?: NexariFsEncoding | NexariFsEncodingOptions,
  ): Promise<void>;
  readdir(path: string, options?: NexariReaddirOptions): Promise<string[]>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
}

/**
 * Spawn options mirror the WebContainer call shape so future consumer wiring
 * typechecks, but only `signal` is forwarded to the guest today. Everything
 * else is rejected at runtime with a typed error.
 */
export interface NexariSpawnOptions {
  signal?: AbortSignal;

  /** Rejected: the nexari guest lane boots in its default directory. */
  cwd?: string;

  /** Rejected: environment forwarding is not part of this slice. */
  env?: Record<string, string>;

  /** Rejected: the interactive terminal lane is out of scope. */
  terminal?: { cols: number; rows: number };

  /** Rejected: output is always captured by the caller. */
  output?: boolean;
}

/**
 * WebContainer-shaped process surface. `output` merges the guest's stdout and
 * stderr into a single stream. Interactive terminal wiring is allowed only
 * through an uncapped `sh` spawn; unsupported spawn options remain refused.
 */
export interface NexariBrowserProcess {
  readonly input: WritableStream<string>;
  readonly output: ReadableStream<string>;
  readonly exit: Promise<number>;
  kill(): void;
  resize(dimensions: { cols: number; rows: number }): void;
}

export interface NexariBrowserRuntimeInternal {
  /**
   * Fail-closed on the nexari path. Filesystem watching is a later slice;
   * callers receive a typed throw, never a silent no-op.
   */
  watchPaths(options: unknown, callback: unknown): never;
}

export interface NexariBrowserRuntime {
  readonly state: NexariRuntimeState;
  readonly workdir: string;
  readonly fs: NexariBrowserFileSystem;
  boot(): Promise<void>;
  spawn(command: string, args?: string[], options?: NexariSpawnOptions): Promise<NexariBrowserProcess>;
  runActionCommand(command: string, signal?: AbortSignal): Promise<NexariActionCommandResult>;
  on(event: 'server-ready', callback: (port: number, url: string) => void): () => void;
  on(event: 'port', callback: (port: number, kind: 'open' | 'close', url: string) => void): () => void;

  /** Refusal arm: any other event stays a typed, visible failure. */
  on(event: string, callback: (...args: unknown[]) => void): void;
  setPreviewScript(script: string): Promise<void>;
  readonly internal: NexariBrowserRuntimeInternal;
  teardown(): Promise<void>;
}

function rejectSpawnOptions(options: NexariSpawnOptions | undefined): void {
  const unsupported: string[] = [];

  if (options?.cwd !== undefined) {
    unsupported.push('cwd');
  }

  if (options?.env !== undefined) {
    unsupported.push('env');
  }

  if (options?.terminal !== undefined) {
    unsupported.push('terminal');
  }

  if (options?.output !== undefined) {
    unsupported.push('output');
  }

  if (unsupported.length > 0) {
    throw new NexariUnsupportedCapabilityError(`spawn options (${unsupported.join(', ')})`);
  }
}

const supportedEncodings: readonly string[] = ['utf8', 'utf-8'];

function assertReadEncoding(encoding: string | undefined): void {
  if (encoding !== undefined && !supportedEncodings.includes(encoding)) {
    throw new NexariUnsupportedCapabilityError(`fs.readFile encoding (${encoding})`);
  }
}

function resolveWriteEncoding(encoding: NexariFsEncoding | NexariFsEncodingOptions | undefined): void {
  if (encoding === undefined) {
    return;
  }

  if (typeof encoding === 'string') {
    if (!supportedEncodings.includes(encoding)) {
      throw new NexariUnsupportedCapabilityError(`fs.writeFile encoding (${encoding})`);
    }

    return;
  }

  for (const key of Object.keys(encoding)) {
    if (key !== 'encoding') {
      throw new NexariUnsupportedCapabilityError(`fs.writeFile options key (${key})`);
    }
  }

  if (encoding.encoding !== undefined && !supportedEncodings.includes(encoding.encoding)) {
    throw new NexariUnsupportedCapabilityError(`fs.writeFile encoding (${String(encoding.encoding)})`);
  }
}

function assertReaddirOptions(options: NexariReaddirOptions | undefined): void {
  if (options === undefined) {
    return;
  }

  for (const key of Object.keys(options)) {
    if (key !== 'withFileTypes') {
      throw new NexariUnsupportedCapabilityError(`fs.readdir options key (${key})`);
    }
  }

  if (options.withFileTypes !== undefined && options.withFileTypes !== false) {
    throw new NexariUnsupportedCapabilityError('fs.readdir withFileTypes (dirent mapping)');
  }
}

function assertMkdirOptions(options: { recursive?: boolean } | undefined): void {
  if (options === undefined) {
    return;
  }

  for (const key of Object.keys(options)) {
    if (key !== 'recursive') {
      throw new NexariUnsupportedCapabilityError(`fs.mkdir options key (${key})`);
    }
  }

  if (options.recursive !== undefined && typeof options.recursive !== 'boolean') {
    throw new NexariUnsupportedCapabilityError('fs.mkdir recursive (must be boolean)');
  }
}

function assertRmOptions(options: { recursive?: boolean; force?: boolean } | undefined): void {
  if (options === undefined) {
    return;
  }

  for (const key of Object.keys(options)) {
    if (key !== 'recursive' && key !== 'force') {
      throw new NexariUnsupportedCapabilityError(`fs.rm options key (${key})`);
    }
  }

  if (options.recursive !== undefined && typeof options.recursive !== 'boolean') {
    throw new NexariUnsupportedCapabilityError('fs.rm recursive (must be boolean)');
  }

  if (options.force !== undefined && typeof options.force !== 'boolean') {
    throw new NexariUnsupportedCapabilityError('fs.rm force (must be boolean)');
  }
}

function mergeTextStreams(streams: ReadableStream<string>[]): ReadableStream<string> {
  const readers = streams.map((stream) => stream.getReader());
  const done = readers.map(() => false);

  return new ReadableStream<string>({
    async pull(controller) {
      while (done.some((isDone) => !isDone)) {
        for (let index = 0; index < readers.length; index++) {
          if (done[index]) {
            continue;
          }

          const { done: streamDone, value } = await readers[index].read();

          if (streamDone) {
            done[index] = true;

            continue;
          }

          if (value !== undefined) {
            controller.enqueue(value);

            return;
          }
        }
      }

      controller.close();
    },
    cancel() {
      for (const reader of readers) {
        void reader.cancel().catch(() => undefined);
      }
    },
  });
}

/**
 * Expose the nexari adapter through the WebContainer-shaped surface the app
 * consumes. Lifecycle invariants (pre-boot typed errors, post-teardown
 * terminated errors, no retained runtime after teardown) stay owned by the
 * underlying adapter; the facade only reshapes the surface.
 */
export function createNexariBrowserRuntime(runtime: NexariRuntime): NexariBrowserRuntime {
  const unsupportedCapability = (capability: string) => () => {
    throw new NexariUnsupportedCapabilityError(capability);
  };

  /*
   * Late-binding queue: the guest exposes its preview event lane only after
   * boot completes, but consumers (e.g. PreviewsStore) may subscribe before
   * that. Queued listeners are flushed onto the lane as soon as it appears;
   * until then their detach functions simply remove them from the queue.
   */
  interface PendingListener {
    event: 'server-ready' | 'port';
    callback: (...args: unknown[]) => void;
    detached: boolean;
    detach?: () => void;
  }

  const pendingListeners = new Set<PendingListener>();
  let flushTimer: ReturnType<typeof setInterval> | undefined;

  const flushPendingListeners = () => {
    const lane = runtime.on;

    if (!lane) {
      return;
    }

    for (const pending of [...pendingListeners]) {
      pendingListeners.delete(pending);

      if (pending.detached) {
        continue;
      }

      const detach = lane(pending.event, pending.callback);

      if (pending.detached) {
        // Detached between the flush and the lane registration.
        if (typeof detach === 'function') {
          detach();
        }

        continue;
      }

      pending.detach = typeof detach === 'function' ? detach : undefined;
    }

    if (pendingListeners.size === 0 && flushTimer !== undefined) {
      clearInterval(flushTimer);
      flushTimer = undefined;
    }
  };

  const startFlushPolling = () => {
    if (flushTimer === undefined && pendingListeners.size > 0) {
      // Lightweight poll; boot-completion also triggers an immediate flush.
      flushTimer = setInterval(flushPendingListeners, 20);
    }
  };

  return {
    get state() {
      return runtime.state;
    },
    workdir: WORK_DIR,
    fs: {
      readFile: async (path, encoding) => {
        assertReadEncoding(encoding);

        return runtime.fs.readFile(path, encoding);
      },
      writeFile: async (path, contents, encoding) => {
        resolveWriteEncoding(encoding);

        return runtime.fs.writeFile(path, contents);
      },
      readdir: async (path, options) => {
        assertReaddirOptions(options);

        return runtime.fs.readdir(path);
      },
      mkdir: async (path, options) => {
        assertMkdirOptions(options);

        return runtime.fs.mkdir(path, options);
      },
      rm: async (path, options) => {
        assertRmOptions(options);

        return runtime.fs.rm(path, options);
      },
    },
    boot: () => {
      const booted = runtime.boot();

      /*
       * The guest lane may appear exactly at boot completion; flush any
       * late-bound listeners immediately instead of waiting for the poll.
       */
      void booted.then(flushPendingListeners, () => undefined);

      return booted;
    },
    teardown: () => runtime.teardown(),
    runActionCommand: (command, signal) => runtime.runActionCommand(command, signal),

    async spawn(command, args, options) {
      rejectSpawnOptions(options);

      const process = await runtime.spawn(command, args, options ? { signal: options.signal } : undefined);

      return {
        input: process.input,
        output: mergeTextStreams([process.stdout, process.stderr]),
        exit: process.exit,
        kill: () => process.kill(),
        resize: unsupportedCapability('process resize'),
      };
    },

    on(event, callback) {
      if (event !== 'server-ready' && event !== 'port') {
        throw new NexariUnsupportedCapabilityError(`runtime event ${String(event)}`);
      }

      const lane = runtime.on;

      if (!lane) {
        /*
         * The lane is not exposed (yet). Unknown-event refusals above stay
         * typed; a missing lane is late-bound: queue the listener and connect
         * it automatically once the guest exposes the lane after boot.
         */
        const pending: PendingListener = {
          event,
          callback: callback as (...args: unknown[]) => void,
          detached: false,
        };

        pendingListeners.add(pending);
        startFlushPolling();

        return () => {
          if (pending.detach) {
            pending.detach();
            pending.detach = undefined;
          }

          pending.detached = true;
          pendingListeners.delete(pending);

          if (pendingListeners.size === 0 && flushTimer !== undefined) {
            clearInterval(flushTimer);
            flushTimer = undefined;
          }
        };
      }

      const detach = lane(event, callback as (...args: unknown[]) => void);

      return () => {
        if (typeof detach === 'function') {
          detach();
        }
      };
    },
    setPreviewScript: () => Promise.reject(new NexariUnsupportedCapabilityError('setPreviewScript')),
    internal: {
      watchPaths: unsupportedCapability('internal.watchPaths (filesystem watching)'),
    },
  };
}
