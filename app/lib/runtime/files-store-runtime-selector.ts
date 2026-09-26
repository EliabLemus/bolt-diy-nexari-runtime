import type { RuntimeBackend } from './runtime-selector';
import type { PathWatcherEvent, WatchPathsOptions } from '@webcontainer/api';
import { NexariUnsupportedCapabilityError, type NexariBrowserRuntime } from './nexari-runtime-facade';
import { isNexariFacade, toGuestPath } from './nexari-surface';
import { WORK_DIR } from '~/utils/constants';

/**
 * The narrow filesystem surface FilesStore consumes. On the stackblitz
 * control path this is the raw WebContainer instance (which also carries
 * `internal.watchPaths`); on the nexari path it is a verified facade-backed
 * adapter whose `internal` is deliberately absent — filesystem watching is a
 * later slice, and the typed absence lets `FilesStore.#init` skip watching
 * visibly instead of catching a mid-init refusal.
 */
export interface FilesStoreRuntimeSurface {
  readonly workdir: string;
  fs: {
    writeFile(path: string, contents: string | Uint8Array): Promise<void>;
    mkdir(path: string, options: { recursive: true }): Promise<void | string>;
    mkdir(path: string, options?: { recursive?: false }): Promise<void>;
    rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  };

  /** Present only on the stackblitz control path; mirrors the SDK signature exactly. */
  internal?: {
    watchPaths(options: WatchPathsOptions, callback: (events: PathWatcherEvent[]) => void): () => void;
  };
}

/**
 * Raised when `nexari` is selected but the runtime promise did not resolve to
 * the Nexari facade. Fail-closed: never a silent fallback to another backend.
 */
export class NexariFilesStoreSurfaceSelectionError extends Error {
  constructor() {
    super('Nexari files-store surface selected but the runtime promise did not resolve to the Nexari facade.');
    this.name = 'NexariFilesStoreSurfaceSelectionError';
  }
}

/**
 * Backend-aware selection of the FilesStore filesystem surface. On the
 * stackblitz control path this is the raw runtime promise, returned by
 * identity: the historical behavior is untouched. On the nexari path the
 * resolved facade is structurally verified, then exposed as the narrow
 * `FilesStoreRuntimeSurface` whose filesystem operations translate the app's
 * workdir-relative path domain to the nexari guest's root domain.
 */
export function createFilesStoreRuntime(
  backend: RuntimeBackend,
  runtimePromise: Promise<unknown>,
): Promise<FilesStoreRuntimeSurface> {
  if (backend === 'stackblitz') {
    return runtimePromise as Promise<FilesStoreRuntimeSurface>;
  }

  return runtimePromise.then((resolved) => {
    if (!isNexariFacade(resolved)) {
      throw new NexariFilesStoreSurfaceSelectionError();
    }

    return createNexariFilesStoreSurface(resolved);
  });
}

/**
 * Build the nexari-backed `FilesStoreRuntimeSurface` over a verified facade.
 * Writes forward both text and binary contents — `FilesStore.createFile`
 * stores uploaded binaries as `Uint8Array` and the facade's writeFile accepts
 * bytes. mkdir keeps WebContainer's recursive contract (the store always
 * recurses); rm forwards options unchanged. Paths are translated at this
 * edge so the guest never sees app-domain shapes.
 */
function createNexariFilesStoreSurface(runtime: NexariBrowserRuntime): FilesStoreRuntimeSurface {
  async function writeFile(path: string, contents: string | Uint8Array): Promise<void> {
    await runtime.fs.writeFile(toGuestPath(path), contents);
  }

  function mkdir(path: string, options: { recursive: true }): Promise<string>;
  function mkdir(path: string, options?: { recursive?: false }): Promise<void>;
  async function mkdir(path: string, options?: { recursive?: boolean }): Promise<void | string> {
    if (options?.recursive !== true) {
      throw new NexariUnsupportedCapabilityError('fs.mkdir without recursive (the store always recurses)');
    }

    await runtime.fs.mkdir(toGuestPath(path), { recursive: true });

    /*
     * WebContainer's recursive arm resolves to the created directory path;
     * the store ignores it, and the facade produces no meaningful equivalent,
     * so resolve with void rather than inventing a path value.
     */
    return undefined as unknown as string;
  }

  function rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    return runtime.fs.rm(toGuestPath(path), options);
  }

  return {
    workdir: WORK_DIR,
    fs: {
      writeFile,
      mkdir,
      rm,
    },
  };
}
