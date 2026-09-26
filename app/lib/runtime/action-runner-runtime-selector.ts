import type { ActionRunnerRuntimeSurface } from './action-runner';
import type { RuntimeBackend } from './runtime-selector';
import { NexariUnsupportedCapabilityError, type NexariBrowserRuntime } from './nexari-runtime-facade';
import { isNexariFacade, toGuestPath } from './nexari-surface';
import { WORK_DIR } from '~/utils/constants';

/**
 * Backend-aware selection of the ActionRunner runtime surface. On the
 * stackblitz control path this is the raw WebContainer promise, returned by
 * identity: the historical behavior is untouched. On the nexari path the
 * resolved facade is structurally verified, then exposed as a narrow
 * `ActionRunnerRuntimeSurface` whose filesystem operations translate the
 * app's workdir-relative path domain to the nexari guest's root domain.
 */
export class NexariActionRunnerSurfaceSelectionError extends Error {
  constructor() {
    super('Nexari action-runner surface selected but the runtime promise did not resolve to the Nexari facade.');
    this.name = 'NexariActionRunnerSurfaceSelectionError';
  }
}

/*
 * The facade predicate and the app→guest path translation live in
 * `nexari-surface.ts`, shared with the action-shell and files-store
 * selectors so every consumer verifies the same facade shape and
 * translates paths identically.
 */

/**
 * Build the nexari-backed `ActionRunnerRuntimeSurface` over a verified
 * facade. UTF-8 text is the only encoding this slice: binary reads, binary
 * writes, and non-recursive mkdir are typed refusals at this edge — the same
 * fail-closed policy the facade applies to its own unsupported shapes. The
 * utf8 arm additionally refuses a guest that answers a text read with bytes:
 * returning them "as text" would smuggle mojibake into file-history JSON.
 *
 * Spawn delegates with args only; the facade already rejects every spawn
 * option except `signal` and merges stdout/stderr into the single output
 * stream the surface contract expects.
 */
function createNexariActionRunnerSurface(runtime: NexariBrowserRuntime): ActionRunnerRuntimeSurface {
  /*
   * The surface exposes WebContainer's two readFile arms. The binary arm is a
   * typed refusal here — the declared arm shape is kept so the object remains
   * assignable to ActionRunnerRuntimeSurface while never promising bytes it
   * cannot produce.
   */
  function readFile(path: string, encoding?: null): Promise<Uint8Array>;
  function readFile(path: string, encoding: BufferEncoding): Promise<string>;
  async function readFile(path: string, encoding?: BufferEncoding | null): Promise<string | Uint8Array> {
    if (encoding === undefined || encoding === null) {
      throw new NexariUnsupportedCapabilityError('fs.readFile binary arm (no encoding)');
    }

    if (encoding !== 'utf8' && encoding !== 'utf-8') {
      throw new NexariUnsupportedCapabilityError(`fs.readFile encoding (${encoding})`);
    }

    const contents = await runtime.fs.readFile(toGuestPath(path), encoding);

    if (typeof contents !== 'string') {
      throw new NexariUnsupportedCapabilityError('fs.readFile text read (guest returned binary bytes)');
    }

    return contents;
  }

  async function writeFile(path: string, contents: string | Uint8Array): Promise<void> {
    if (typeof contents !== 'string') {
      throw new NexariUnsupportedCapabilityError('fs.writeFile binary contents (Uint8Array)');
    }

    await runtime.fs.writeFile(toGuestPath(path), contents);
  }

  function readdir(path: string): Promise<string[]> {
    return runtime.fs.readdir(toGuestPath(path), {}) as Promise<string[]>;
  }

  async function mkdir(path: string, options: { recursive: true }): Promise<void> {
    if (options.recursive !== true) {
      throw new NexariUnsupportedCapabilityError('fs.mkdir without recursive (the runner always recurses)');
    }

    await runtime.fs.mkdir(toGuestPath(path), { recursive: true });
  }

  function rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    return runtime.fs.rm(toGuestPath(path), options);
  }

  function spawn(command: string, args: string[]): Promise<{ output: ReadableStream<string>; exit: Promise<number> }> {
    return runtime.spawn(command, args).then((process) => ({
      output: process.output,
      exit: process.exit,
    }));
  }

  return {
    workdir: WORK_DIR,
    fs: {
      readFile,
      writeFile,
      readdir,
      mkdir,
      rm,
    },
    spawn,
  };
}

export function createActionRunnerRuntime(
  backend: RuntimeBackend,
  runtimePromise: Promise<unknown>,
): Promise<ActionRunnerRuntimeSurface> {
  if (backend === 'stackblitz') {
    return runtimePromise as Promise<ActionRunnerRuntimeSurface>;
  }

  return runtimePromise.then((resolved) => {
    if (!isNexariFacade(resolved)) {
      throw new NexariActionRunnerSurfaceSelectionError();
    }

    return createNexariActionRunnerSurface(resolved);
  });
}
