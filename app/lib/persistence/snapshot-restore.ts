import { createFilesStoreRuntime, type FilesStoreRuntimeSurface } from '~/lib/runtime/files-store-runtime-selector';
import type { RuntimeBackend } from '~/lib/runtime/runtime-selector';
import type { Snapshot } from './types';

/*
 * Backend-aware acquisition of the chat-snapshot restore surface. On the
 * stackblitz control path this is the raw runtime promise by identity
 * (historical behavior); on the nexari path the resolved facade is verified
 * structurally and its fs writes translate the app's workdir-relative path
 * domain into the guest root domain, refusing escapes with a typed error.
 */
export function createSnapshotRestoreRuntime(
  backend: RuntimeBackend,
  runtimePromise: Promise<unknown>,
): Promise<FilesStoreRuntimeSurface> {
  return createFilesStoreRuntime(backend, runtimePromise);
}

/**
 * Restore chat-snapshot files onto the backend-aware FilesStore runtime
 * surface. Semantics match the historical restore: the folder pass is
 * dispatched before the file pass, keys are relativized by stripping the
 * surface workdir prefix when present, and contents are forwarded exactly
 * as stored (file content is always persisted as text — binaries as base64).
 *
 * Per-entry operations keep their synchronous fire-and-forget dispatch; the
 * returned promise joins the dispatched writes so the restore's completion
 * becomes observable without changing scheduling. Whole-promise rejection
 * is reserved for the typed path-translation refusals raised synchronously
 * inside the dispatched callbacks — a snapshot pointing outside the work
 * directory must not silently restore nothing — and for the first
 * operational fs failure after dispatch, which the join surfaces to the
 * caller (pinned by the rejection-propagation test in the spec).
 */
export async function restoreSnapshotFiles(surface: FilesStoreRuntimeSurface, snapshot?: Snapshot): Promise<void> {
  const validSnapshot = snapshot || { chatIndex: '', files: {} };

  if (!validSnapshot?.files) {
    return;
  }

  const dispatched: Array<Promise<void>> = [];

  /*
   * Snapshot keys are app-domain paths in three shapes. (1) Workdir-prefixed
   * keys (`/home/project/x`, the store's canonical shape) strip to a bare
   * workdir-relative key (`x`): the historical strip left a root-absolute
   * remainder (`/x`), which the WebContainer filesystem resolved to the same
   * destination because it scopes every path to the workdir, while the nexari
   * surface requires the bare-relative or WORK_DIR-prefixed spelling. (2)
   * Bare relative keys pass through unchanged, as before. (3) Any other
   * absolute key is forwarded unchanged — the control path's chrooted
   * filesystem resolves it as history did, and the nexari surface refuses it
   * with a typed error instead of silently re-rooting it into the project.
   */
  const relativize = (key: string): string => {
    if (key === surface.workdir || key.startsWith(`${surface.workdir}/`)) {
      const stripped = key.slice(surface.workdir.length);

      return stripped.startsWith('/') ? stripped.slice(1) : stripped;
    }

    return key;
  };

  Object.entries(validSnapshot.files).forEach(([key, value]) => {
    if (value?.type === 'folder') {
      dispatched.push(surface.fs.mkdir(relativize(key), { recursive: true }).then(() => undefined));
    }
  });

  Object.entries(validSnapshot.files).forEach(([key, value]) => {
    if (value?.type === 'file') {
      dispatched.push(surface.fs.writeFile(relativize(key), value.content));
    }
  });

  await Promise.all(dispatched);
}
