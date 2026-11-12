export type NexariRuntimeState = 'created' | 'booting' | 'ready' | 'terminated';

export class NexariRuntimeTerminatedError extends Error {
  constructor() {
    super('Nexari runtime has been terminated.');
    this.name = 'NexariRuntimeTerminatedError';
  }
}

export interface NexariGuestFileSystem {
  readFile(path: string, encoding?: 'utf8' | 'utf-8'): Promise<Uint8Array | string>;
  writeFile(path: string, contents: Uint8Array | string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
}

export interface NexariGuestProcess {
  /** Interactive `sh` owns this lane; action commands do not write to it. */
  input: WritableStream<string>;
  stdout: ReadableStream<string>;
  stderr: ReadableStream<string>;
  exit: Promise<number>;
  kill(): void;
}

export interface NexariGuestSpawnOptions {
  signal?: AbortSignal;
}

export interface NexariGuestRuntime {
  fs: NexariGuestFileSystem;
  spawn(command: string, args?: string[], options?: NexariGuestSpawnOptions): Promise<NexariGuestProcess>;
  teardown(): Promise<void>;

  /**
   * Optional preview event lane exposed by the underlying runtime (Vivari's
   * `on('server-ready' | 'port')`). Absent guests keep every other capability;
   * consumers of the lane fail typed instead of silently no-oping.
   */
  onGuestEvent?: NexariGuestEventLane;
}

/**
 * Preview event lane mirrored from the vendored Vivari adapter: `server-ready`
 * fires only after the in-VM server answers a real HTTP request (a port bind
 * does not count, per Vivari's design) and `port` reports open/close transitions.
 */
export interface NexariGuestEventLane {
  (event: 'server-ready' | 'port', listener: (...args: unknown[]) => void): (() => void) | PromiseLike<void>;
}

export interface NexariRuntimeOptions {
  boot(): Promise<NexariGuestRuntime>;
}

export interface NexariActionCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface NexariRuntime {
  readonly state: NexariRuntimeState;
  readonly fs: NexariGuestFileSystem;
  boot(): Promise<void>;
  spawn(command: string, args?: string[], options?: NexariGuestSpawnOptions): Promise<NexariGuestProcess>;
  runActionCommand(command: string, signal?: AbortSignal): Promise<NexariActionCommandResult>;

  /** Present only when the booted guest exposes a preview event lane. */
  readonly on?: NexariGuestEventLane;
  teardown(): Promise<void>;
}

export function createNexariRuntime({ boot }: NexariRuntimeOptions): NexariRuntime {
  return new NexariRuntimeAdapter(boot);
}

class NexariRuntimeAdapter implements NexariRuntime {
  #bootGuest: () => Promise<NexariGuestRuntime>;
  #guest: NexariGuestRuntime | undefined;
  #bootPromise: Promise<void> | undefined;
  #teardownPromise: Promise<void> | undefined;
  #activeActionCancels = new Set<(reason: unknown) => void>();
  #activeInteractiveProcesses = new Set<NexariGuestProcess>();
  #state: NexariRuntimeState = 'created';

  readonly fs: NexariGuestFileSystem = {
    readFile: async (path, encoding) => this.#delegate((guest) => guest.fs.readFile(path, encoding)),
    writeFile: async (path, contents) => this.#delegate((guest) => guest.fs.writeFile(path, contents)),
    readdir: async (path) => this.#delegate((guest) => guest.fs.readdir(path)),
    mkdir: async (path, options) => this.#delegate((guest) => guest.fs.mkdir(path, options)),
    rm: async (path, options) => this.#delegate((guest) => guest.fs.rm(path, options)),
  };

  constructor(boot: () => Promise<NexariGuestRuntime>) {
    this.#bootGuest = boot;
  }

  get state(): NexariRuntimeState {
    return this.#state;
  }

  /** Preview event lane of the booted guest; undefined until boot completes. */
  get on(): NexariGuestEventLane | undefined {
    return this.#guest?.onGuestEvent;
  }

  async boot(): Promise<void> {
    this.#assertNotTerminated();

    if (this.#bootPromise) {
      return this.#bootPromise;
    }

    this.#state = 'booting';
    this.#bootPromise = this.#bootGuest().then(
      (guest) => {
        if (this.#state === 'terminated') {
          void guest.teardown().catch(() => undefined);
          throw new NexariRuntimeTerminatedError();
        }

        this.#guest = guest;
        this.#state = 'ready';
      },
      (error) => {
        this.#state = 'terminated';
        throw error;
      },
    );

    return this.#bootPromise;
  }

  async spawn(command: string, args?: string[], options?: NexariGuestSpawnOptions): Promise<NexariGuestProcess> {
    this.#assertReady();

    const process = await this.#guest!.spawn(command, args, options);

    if (this.#state !== 'ready') {
      /* The discarded process can reject on exit after teardown. */
      void process.exit.catch(() => undefined);
      process.kill();
      throw new NexariRuntimeTerminatedError();
    }

    this.#activeInteractiveProcesses.add(process);
    void process.exit.then(
      () => this.#activeInteractiveProcesses.delete(process),
      () => this.#activeInteractiveProcesses.delete(process),
    );

    return process;
  }

  async runActionCommand(command: string, signal?: AbortSignal): Promise<NexariActionCommandResult> {
    this.#assertReady();

    if (signal?.aborted) {
      throw signal.reason;
    }

    const spawnController = new AbortController();
    let process: NexariGuestProcess | undefined;
    let killed = false;
    let rejectCancellation!: (reason: unknown) => void;
    const cancellation = new Promise<never>((_resolve, reject) => {
      rejectCancellation = reject;
    });
    const cancel = (reason: unknown) => {
      if (!killed) {
        killed = true;
        spawnController.abort(reason);
        process?.kill();
      }

      rejectCancellation(reason);
    };
    const abort = () => cancel(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    this.#activeActionCancels.add(cancel);

    try {
      if (signal?.aborted) {
        cancel(signal.reason);
      }

      const spawnedProcess = this.#guest!.spawn('sh', ['-c', command], { signal: spawnController.signal }).then(
        (lateProcess) => {
          if (killed || this.#state !== 'ready') {
            void lateProcess.exit.catch(() => undefined);
            lateProcess.kill();
          }

          return lateProcess;
        },
      );
      process = await Promise.race([spawnedProcess, cancellation]);

      if (this.#state !== 'ready') {
        cancel(new NexariRuntimeTerminatedError());
      }

      const [stdout, stderr, exitCode] = await Promise.race([
        Promise.all([readStream(process.stdout), readStream(process.stderr), process.exit]),
        cancellation,
      ]);
      this.#assertReady();

      if (signal?.aborted) {
        throw signal.reason;
      }

      return { stdout, stderr, exitCode };
    } finally {
      signal?.removeEventListener('abort', abort);
      this.#activeActionCancels.delete(cancel);
    }
  }

  async teardown(): Promise<void> {
    if (this.#teardownPromise) {
      return this.#teardownPromise;
    }

    if (this.#state === 'terminated') {
      return Promise.resolve();
    }

    this.#state = 'terminated';

    const terminated = new NexariRuntimeTerminatedError();

    for (const cancel of this.#activeActionCancels) {
      cancel(terminated);
    }

    for (const process of this.#activeInteractiveProcesses) {
      process.kill();
    }
    this.#activeInteractiveProcesses.clear();

    const guest = this.#guest;
    this.#guest = undefined;
    this.#teardownPromise = guest?.teardown() ?? Promise.resolve();

    return this.#teardownPromise;
  }

  async #delegate<T>(operation: (guest: NexariGuestRuntime) => Promise<T>): Promise<T> {
    this.#assertReady();

    const result = await operation(this.#guest!);
    this.#assertReady();

    return result;
  }

  #assertReady(): void {
    this.#assertNotTerminated();

    if (this.#state !== 'ready' || !this.#guest) {
      throw new Error('Nexari runtime has not completed booting.');
    }
  }

  #assertNotTerminated(): void {
    if (this.#state === 'terminated') {
      throw new NexariRuntimeTerminatedError();
    }
  }
}

async function readStream(stream: ReadableStream<string>): Promise<string> {
  const reader = stream.getReader();
  let output = '';

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        return output;
      }

      output += value;
    }
  } finally {
    reader.releaseLock();
  }
}
