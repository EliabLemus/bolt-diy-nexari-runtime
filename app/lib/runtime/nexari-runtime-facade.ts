import { WORK_DIR } from '~/utils/constants';
import type {
  NexariActionCommandResult,
  NexariGuestFileSystem,
  NexariRuntime,
  NexariRuntimeState,
} from './nexari-runtime';

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
 * stderr into a single stream; `input` is fail-closed for this slice.
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
  readonly fs: NexariGuestFileSystem;
  boot(): Promise<void>;
  spawn(command: string, args?: string[], options?: NexariSpawnOptions): Promise<NexariBrowserProcess>;
  runActionCommand(command: string, signal?: AbortSignal): Promise<NexariActionCommandResult>;
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

  return {
    get state() {
      return runtime.state;
    },
    workdir: WORK_DIR,
    fs: runtime.fs,
    boot: () => runtime.boot(),
    teardown: () => runtime.teardown(),
    runActionCommand: (command, signal) => runtime.runActionCommand(command, signal),

    async spawn(command, args, options) {
      rejectSpawnOptions(options);

      const process = await runtime.spawn(command, args, options ? { signal: options.signal } : undefined);

      return {
        input: new WritableStream<string>({
          write: unsupportedCapability('process stdin (input)'),
        }),
        output: mergeTextStreams([process.stdout, process.stderr]),
        exit: process.exit,
        kill: () => process.kill(),
        resize: unsupportedCapability('process resize'),
      };
    },

    on: unsupportedCapability('runtime event handling (on)'),
    setPreviewScript: () => Promise.reject(new NexariUnsupportedCapabilityError('setPreviewScript')),
    internal: {
      watchPaths: unsupportedCapability('internal.watchPaths (filesystem watching)'),
    },
  };
}
