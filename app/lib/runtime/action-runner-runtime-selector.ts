import type { ActionRunnerRuntimeSurface } from './action-runner';
import type { RuntimeBackend } from './runtime-selector';
import { NexariUnsupportedCapabilityError, type NexariBrowserRuntime } from './nexari-runtime-facade';
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

/**
 * Structural predicate over the facade surface (`nexari-runtime-facade.ts`),
 * mirroring `action-shell-selector.ts` so both consumers agree on what counts
 * as a booted facade.
 */
function isNexariFacade(value: unknown): value is NexariBrowserRuntime {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  return (
    typeof candidate.runActionCommand === 'function' &&
    typeof candidate.teardown === 'function' &&
    typeof candidate.boot === 'function' &&
    typeof candidate.state === 'string' &&
    typeof candidate.fs === 'object' &&
    candidate.fs !== null &&
    typeof candidate.spawn === 'function'
  );
}

/**
 * Translate an app-domain path to the nexari guest path domain. The app works
 * in two shapes: bare workdir-relative paths (ActionRunner relativizes file
 * actions against the surface `workdir`) and absolute app paths rooted at
 * `WORK_DIR` (`/home/project/...`, the prompt contract's cwd).
 *
 * The nexari guest VFS is rooted at `/` — the pinned adapter advertises
 * `workdir = '/'` and guest spawns default to the root — so file actions,
 * history files, and `sh -c` command cwd must agree. The translation is a
 * guarded prefix strip plus dot-segment normalization: `/home/project/x` →
 * `/x`, bare `x` → `/x`. Anything escaping the workdir (`..`, other roots)
 * is refused typed instead of being re-rooted silently.
 */
function toGuestPath(path: string): string {
  let relative: string;

  if (path.startsWith('/')) {
    if (!path.startsWith(`${WORK_DIR}/`) && path !== WORK_DIR) {
      throw new NexariUnsupportedCapabilityError(
        `fs paths outside the work directory (${path}); the nexari surface is scoped to ${WORK_DIR}`,
      );
    }

    relative = path === WORK_DIR ? '' : path.slice(WORK_DIR.length + 1);
  } else {
    relative = path;
  }

  const stack: string[] = [];

  for (const segment of relative.split('/')) {
    if (segment === '' || segment === '.') {
      continue;
    }

    if (segment === '..') {
      if (stack.length === 0) {
        throw new NexariUnsupportedCapabilityError(
          `fs paths outside the work directory (${path}); the nexari surface is scoped to ${WORK_DIR}`,
        );
      }

      stack.pop();

      continue;
    }

    stack.push(segment);
  }

  return `/${stack.join('/')}`;
}

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
