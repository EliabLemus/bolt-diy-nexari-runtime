import {
  createNexariRuntime,
  type NexariGuestFileSystem,
  type NexariGuestProcess,
  type NexariGuestRuntime,
  type NexariRuntime,
} from './nexari-runtime';

/**
 * Narrow structural view of the Vivari runtime surface this factory relies on.
 * It is satisfied by `createVivariRuntime` from the pinned Vivari adapter
 * package, but declared here so the Bolt build carries no dependency on that
 * package: the host application injects the concrete factory at the seam.
 */
export interface VivariGuestRuntimeLike {
  boot(): Promise<void>;
  fs: {
    readFile(path: string, encoding?: 'utf8'): Promise<Uint8Array | string>;
    writeFile(path: string, contents: Uint8Array | string): Promise<void>;
    readdir(path: string): Promise<string[]>;
    mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
    rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  };
  spawn(command: string, args?: string[], options?: { signal?: AbortSignal }): Promise<VivariGuestProcessLike>;
  teardown(): void | Promise<void>;
}

export interface VivariGuestProcessLike {
  stdout: ReadableStream<string>;
  stderr: ReadableStream<string>;
  exit: Promise<number>;
  kill(): void;
}

export interface VivariSdkLike {
  boot(options?: { signal?: AbortSignal }): Promise<unknown>;
}

export interface VivariGuestFactoryOptions {
  /** Stable runtime identifier passed through to the vivari factory. */
  id: string;

  /** Optional isolation probe; vivari fails closed without cross-origin isolation. */
  isIsolated?: () => boolean;

  /** Loads the vivari SDK the injected runtime will boot from. */
  loadSdk: () => Promise<VivariSdkLike>;

  /** Injected vivari runtime constructor; production passes the pinned adapter's `createVivariRuntime`. */
  createVivariRuntime: (options: {
    id: string;
    isIsolated?: () => boolean;
    loadSdk: () => Promise<VivariSdkLike>;
  }) => VivariGuestRuntimeLike;
}

const utf8Alias = new Set<string>(['utf8', 'utf-8']);

function normalizeReadEncoding(encoding: string | undefined): 'utf8' | undefined {
  if (encoding === undefined) {
    return undefined;
  }

  if (!utf8Alias.has(encoding)) {
    throw new Error(`Unsupported vivari guest read encoding: ${encoding}`);
  }

  return 'utf8';
}

function adaptVivariProcess(process: VivariGuestProcessLike): NexariGuestProcess {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    exit: process.exit,
    kill: () => process.kill(),
  };
}

function adaptVivariGuest(guest: VivariGuestRuntimeLike): NexariGuestRuntime {
  const fs: NexariGuestFileSystem = {
    readFile: async (path, encoding) => guest.fs.readFile(path, normalizeReadEncoding(encoding as string | undefined)),
    writeFile: (path, contents) => guest.fs.writeFile(path, contents),
    readdir: (path) => guest.fs.readdir(path),
    mkdir: (path, options) => guest.fs.mkdir(path, options),
    rm: (path, options) => guest.fs.rm(path, options),
  };

  return {
    fs,
    spawn: (command, args, options) =>
      guest.spawn(command, args, options ? { signal: options.signal } : undefined).then(adaptVivariProcess),
    teardown: () => Promise.resolve(guest.teardown()),
  };
}

/**
 * Build the Nexari guest boot factory for a Vivari-backed runtime. The vivari
 * runtime is constructed immediately; its `boot()` runs once inside the Nexari
 * adapter's boot seam, so every lifecycle invariant (boot deduplication,
 * terminated-state typed failures, teardown-once, stale-action cancellation)
 * stays owned by `createNexariRuntime`.
 *
 * No WebContainer SDK import and no vivari package import exist in this module:
 * the host injects both, keeping the stackblitz control path as the only
 * production default.
 */
export function createVivariGuestFactory(options: VivariGuestFactoryOptions): () => Promise<NexariRuntime> {
  const { id, isIsolated, loadSdk, createVivariRuntime } = options;
  const guest = createVivariRuntime({
    id,
    ...(isIsolated ? { isIsolated } : {}),
    loadSdk,
  });

  return async () =>
    createNexariRuntime({
      boot: async () => {
        await guest.boot();

        return adaptVivariGuest(guest);
      },
    });
}
