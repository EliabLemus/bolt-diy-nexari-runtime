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
    internal: {
      watchPaths: createNexariWatchPaths(runtime),
    },
  };
}

/**
 * Poll-based filesystem watcher for the nexari guest. StackBlitz's SDK
 * exposes `internal.watchPaths` over real fs events; the nexari guest offers
 * none, so this watcher snapshots the work directory tree on an interval,
 * diffs it against the previous snapshot, and emits `PathWatcherEvent`-shaped
 * batches. Content is included only when `options.includeContent` is set,
 * mirroring the SDK contract `FilesStore` was written against.
 */
export function createNexariWatchPaths(
  runtime: NexariBrowserRuntime,
  options: { intervalMs?: number } = {},
): (watchOptions: WatchPathsOptions, callback: (events: PathWatcherEvent[]) => void) => () => void {
  const intervalMs = options.intervalMs ?? 1000;

  return (watchOptions, callback) => {
    const exclude = watchOptions.exclude ?? [];
    const includeContent = watchOptions.includeContent ?? false;
    type Entry = { kind: 'file' | 'dir'; content?: Uint8Array };

    let previous = new Map<string, Entry>();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const isExcluded = (appPath: string): boolean => {
      const relative = appPath.startsWith(`${WORK_DIR}/`) ? appPath.slice(WORK_DIR.length + 1) : appPath;
      const segments = relative.split('/');

      return exclude.some((pattern) => {
        const normalized = pattern.replace(/^\*\*\//, '').replace(/\/?\*\*$/, '');

        return segments.some((segment) => segment === normalized) || relative.startsWith(`${normalized}/`);
      });
    };

    /*
     * The guest fs is scoped to its root, so paths are relative there even
     * though toGuestPath hands back '/' for the workdir itself.
     */
    const toRelativeGuestPath = (guestPath: string): string => guestPath.replace(/^\/+/, '');

    async function readDir(guestPath: string): Promise<string[]> {
      const relative = toRelativeGuestPath(guestPath);

      try {
        return await runtime.fs.readdir(relative || '.');
      } catch {
        return runtime.fs.readdir(relative || '/');
      }
    }

    async function isDirectory(guestPath: string): Promise<boolean> {
      try {
        await runtime.fs.readdir(toRelativeGuestPath(guestPath));

        return true;
      } catch {
        return false;
      }
    }

    async function snapshot(guestDir: string, appDir: string, depth: number): Promise<Map<string, Entry>> {
      const next = new Map<string, Entry>();

      if (depth > 16) {
        return next;
      }

      let entries: string[] = [];

      try {
        entries = await readDir(guestDir);
      } catch {
        return next;
      }

      const relativeDir = toRelativeGuestPath(guestDir);

      for (const entry of entries) {
        const guestEntry = relativeDir ? `${relativeDir}/${entry}` : entry;
        const appEntry = `${appDir}/${entry}`;

        if (isExcluded(appEntry)) {
          continue;
        }

        if (await isDirectory(guestEntry)) {
          next.set(appEntry, { kind: 'dir' });

          const nested = await snapshot(guestEntry, appEntry, depth + 1);

          for (const [nestedPath, nestedEntry] of nested) {
            next.set(nestedPath, nestedEntry);
          }
        } else {
          const entryItem: Entry = { kind: 'file' };

          if (includeContent) {
            try {
              const content = await runtime.fs.readFile(guestEntry);

              entryItem.content = typeof content === 'string' ? new TextEncoder().encode(content) : content;
            } catch {
              /*
               * A file removed between readdir and readFile is simply absent
               * from this snapshot; the next poll reports the removal.
               */
            }
          }

          next.set(appEntry, entryItem);
        }
      }

      return next;
    }

    async function poll() {
      if (stopped) {
        return;
      }

      const current = await snapshot(toGuestPath(WORK_DIR), WORK_DIR, 0);
      const events: PathWatcherEvent[] = [];
      const now = Date.now();

      for (const [appPath, entry] of current) {
        const before = previous.get(appPath);

        if (!before && entry.kind === 'file') {
          events.push({ type: 'add_file', path: appPath, mtime: now, ino: 0, buffer: entry.content });
        } else if (!before && entry.kind === 'dir') {
          events.push({ type: 'add_dir', path: appPath, mtime: now, ino: 0 });
        } else if (before?.kind === 'file' && entry.kind === 'file' && before.content && entry.content) {
          const changed =
            before.content.length !== entry.content.length ||
            before.content.some((byte, index) => byte !== entry.content?.[index]);

          if (changed) {
            events.push({ type: 'change', path: appPath, mtime: now, ino: 0, buffer: entry.content });
          }
        }
      }

      for (const [appPath, entry] of previous) {
        if (!current.has(appPath)) {
          events.push({
            type: entry.kind === 'dir' ? 'remove_dir' : 'remove_file',
            path: appPath,
            mtime: now,
            ino: 0,
          });
        }
      }

      previous = current;

      if (events.length > 0) {
        callback(events);
      }

      if (!stopped) {
        timer = setTimeout(() => {
          void poll();
        }, intervalMs);
      }
    }

    void poll();

    return () => {
      stopped = true;

      if (timer !== null) {
        clearTimeout(timer);
      }
    };
  };
}
