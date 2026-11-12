import { describe, expect, it, vi } from 'vitest';
import { restoreSnapshotFiles } from './snapshot-restore';
import { createFilesStoreRuntime } from '~/lib/runtime/files-store-runtime-selector';
import { NexariUnsupportedCapabilityError, type NexariBrowserRuntime } from '~/lib/runtime/nexari-runtime-facade';
import type { FilesStoreRuntimeSurface } from '~/lib/runtime/files-store-runtime-selector';
import type { Snapshot } from './types';
import { WORK_DIR } from '~/utils/constants';

/**
 * Pins for the chat-snapshot file restore. The restore must keep its
 * historical semantics on the stackblitz control path — workdir prefix
 * strip, folder pass dispatched before the file pass, text and binary
 * contents forwarded as stored — while gaining backend-aware path
 * translation on the nexari path through the real FilesStore runtime
 * surface selector.
 */

interface FsOp {
  op: 'mkdir' | 'writeFile';
  path: string;
  contents?: unknown;
  options?: unknown;
}

function createSurfaceFake() {
  const ops: FsOp[] = [];

  const surface: FilesStoreRuntimeSurface = {
    workdir: WORK_DIR,
    fs: {
      writeFile: vi.fn(async (path: string, contents: string | Uint8Array) => {
        ops.push({ op: 'writeFile', path, contents });
      }),
      mkdir: vi.fn(async (path: string, options?: { recursive?: boolean }) => {
        ops.push({ op: 'mkdir', path, options });
      }),
      rm: vi.fn(async () => undefined),
    },
  };

  return { surface, ops };
}

function createFacadeFake() {
  const ops: FsOp[] = [];

  const facade: NexariBrowserRuntime = {
    state: 'ready',
    workdir: '/',
    fs: {
      readFile: vi.fn(async () => ''),
      writeFile: vi.fn(async (path: string, contents: Uint8Array | string) => {
        ops.push({ op: 'writeFile', path, contents });
      }),
      readdir: vi.fn(async () => []),
      mkdir: vi.fn(async (path: string, options?: { recursive?: boolean }) => {
        ops.push({ op: 'mkdir', path, options });
      }),
      rm: vi.fn(async () => undefined),
    },
    boot: vi.fn(async () => undefined),
    spawn: vi.fn(),
    runActionCommand: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
    on: () => undefined,
    setPreviewScript: () => Promise.resolve(),
    internal: { watchPaths: () => undefined },
    teardown: vi.fn(async () => undefined),
  } as unknown as NexariBrowserRuntime;

  return { facade, ops };
}

describe('restoreSnapshotFiles (backend-agnostic restore semantics)', () => {
  it('writes files with stripped workdir keys and forwards text and binary contents as stored (AC-1)', async () => {
    const { surface, ops } = createSurfaceFake();

    const snapshot: Snapshot = {
      chatIndex: '',
      files: {
        [`${WORK_DIR}/src/a.ts`]: { type: 'file', content: 'export {};', isBinary: false },
        'relative/b.txt': { type: 'file', content: 'text', isBinary: false },
        [`${WORK_DIR}/img/logo.png`]: { type: 'file', content: 'aGVsbG8=', isBinary: true },
      },
    };

    await restoreSnapshotFiles(surface, snapshot);

    expect(surface.fs.writeFile).toHaveBeenCalledTimes(3);
    expect(surface.fs.writeFile).toHaveBeenCalledWith('src/a.ts', 'export {};');
    expect(surface.fs.writeFile).toHaveBeenCalledWith('relative/b.txt', 'text');
    expect(surface.fs.writeFile).toHaveBeenCalledWith('img/logo.png', 'aGVsbG8=');

    const writeOps = ops.filter((entry) => entry.op === 'writeFile');
    expect(writeOps.map((entry) => entry.path).sort()).toEqual(['img/logo.png', 'relative/b.txt', 'src/a.ts']);
  });

  it('dispatches the recursive folder pass before the file pass (AC-2)', async () => {
    const { surface, ops } = createSurfaceFake();

    const snapshot: Snapshot = {
      chatIndex: '',
      files: {
        [`${WORK_DIR}/app`]: { type: 'folder' },
        [`${WORK_DIR}/app/main.ts`]: { type: 'file', content: 'console.log(1);', isBinary: false },
      },
    };

    await restoreSnapshotFiles(surface, snapshot);

    expect(surface.fs.mkdir).toHaveBeenCalledWith('app', { recursive: true });

    const firstFileIndex = ops.findIndex((entry) => entry.op === 'writeFile');
    const folderIndexes = ops
      .map((entry, index) => (entry.op === 'mkdir' ? index : -1))
      .filter((index) => index !== -1);

    expect(folderIndexes.length).toBeGreaterThan(0);
    expect(Math.min(...folderIndexes)).toBeLessThan(firstFileIndex);
  });

  it('performs zero filesystem operations for a missing or empty snapshot (AC-3)', async () => {
    const { surface, ops } = createSurfaceFake();

    await restoreSnapshotFiles(surface, undefined);
    await restoreSnapshotFiles(surface, { chatIndex: '', files: {} });

    expect(ops).toEqual([]);
    expect(surface.fs.writeFile).not.toHaveBeenCalled();
    expect(surface.fs.mkdir).not.toHaveBeenCalled();
  });

  it('propagates the first filesystem rejection instead of swallowing it', async () => {
    const surface: FilesStoreRuntimeSurface = {
      workdir: WORK_DIR,
      fs: {
        writeFile: vi.fn(async () => Promise.reject(new Error('disk full'))),
        mkdir: vi.fn(async () => undefined),
        rm: vi.fn(async () => undefined),
      },
    };

    const snapshot: Snapshot = {
      chatIndex: '',
      files: {
        [`${WORK_DIR}/x.txt`]: { type: 'file', content: 'x', isBinary: false },
      },
    };

    await expect(restoreSnapshotFiles(surface, snapshot)).rejects.toThrow('disk full');
  });
});

describe('restoreSnapshotFiles through the real nexari FilesStore surface (AC-5)', () => {
  it('translates workdir-absolute keys into the guest domain', async () => {
    const { facade, ops } = createFacadeFake();
    const surface = await createFilesStoreRuntime('nexari', Promise.resolve(facade));

    const snapshot: Snapshot = {
      chatIndex: '',
      files: {
        [`${WORK_DIR}/src/a.ts`]: { type: 'file', content: 'export {};', isBinary: false },
        [`${WORK_DIR}/components`]: { type: 'folder' },
      },
    };

    await restoreSnapshotFiles(surface, snapshot);

    expect(ops).toContainEqual({ op: 'writeFile', path: '/src/a.ts', contents: 'export {};' });
    expect(ops).toContainEqual({ op: 'mkdir', path: '/components', options: { recursive: true } });
    expect(ops.every((entry) => entry.path.startsWith('/'))).toBe(true);
  });

  it('refuses foreign-root absolute keys with the typed capability error and writes nothing (AC-5)', async () => {
    const { facade, ops } = createFacadeFake();
    const surface = await createFilesStoreRuntime('nexari', Promise.resolve(facade));

    const snapshot: Snapshot = {
      chatIndex: '',
      files: {
        '/etc/evil.txt': { type: 'file', content: 'nope', isBinary: false },
      },
    };

    await expect(restoreSnapshotFiles(surface, snapshot)).rejects.toBeInstanceOf(NexariUnsupportedCapabilityError);
    expect(ops).toEqual([]);
  });
});
