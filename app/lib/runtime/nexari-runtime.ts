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
  runActionCommand(command: string, signal?: AbortSignal): Promise<NexariActionCommandResult>;
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
