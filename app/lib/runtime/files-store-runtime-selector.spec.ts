import { describe, expect, it, vi } from 'vitest';
import { createFilesStoreRuntime, NexariFilesStoreSurfaceSelectionError } from './files-store-runtime-selector';
import { NexariUnsupportedCapabilityError } from './nexari-runtime-facade';
import type { NexariBrowserRuntime } from './nexari-runtime-facade';
import { WORK_DIR } from '~/utils/constants';

/**
 * Selector-level pins for the FilesStore runtime surface. The stackblitz
 * branch must return the input promise by identity (the historical behavior),
 * the nexari branch must translate app-domain paths to the guest domain,
 * forward text and binary writes, refuse non-recursive mkdir, and omit
 * `internal` so filesystem watching is a typed absence instead of a refusal
 * thrown mid-init.
 */

interface FsCall {
  op: 'writeFile' | 'mkdir' | 'rm';
  path: string;
  contents?: unknown;
  options?: unknown;
}

function createFacadeFake() {
  const calls: FsCall[] = [];

  const facade: NexariBrowserRuntime = {
    state: 'ready',
    workdir: '/',
    fs: {
      readFile: vi.fn(async () => ''),
      writeFile: vi.fn(async (path: string, contents: Uint8Array | string) => {
        calls.push({ op: 'writeFile', path, contents });
      }),
      readdir: vi.fn(async () => []),
      mkdir: vi.fn(async (path: string, options?: { recursive?: boolean }) => {
        calls.push({ op: 'mkdir', path, options });
      }),
      rm: vi.fn(async (path: string, options?: { recursive?: boolean; force?: boolean }) => {
        calls.push({ op: 'rm', path, options });
      }),
    },
    boot: vi.fn(async () => undefined),
    spawn: vi.fn(),
    runActionCommand: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
    on: () => undefined,
    setPreviewScript: () => Promise.resolve(),
    internal: { watchPaths: () => undefined },
    teardown: vi.fn(async () => undefined),
  } as unknown as NexariBrowserRuntime;

  return { facade, calls };
}

describe('createFilesStoreRuntime (stackblitz control path)', () => {
  it('returns the input promise by identity without interacting with it', async () => {
    let inspected = false;
    const trackingPromise = new Promise<unknown>(() => {
      inspected = true;
    });

    const tracked = createFilesStoreRuntime('stackblitz', trackingPromise);

    expect(tracked).toBe(trackingPromise);
    expect(inspected).toBe(true);

    const sentinel = { workdir: '/webcontainer' };
    await expect(createFilesStoreRuntime('stackblitz', Promise.resolve(sentinel))).resolves.toBe(sentinel);
  });
});

describe('createFilesStoreRuntime (nexari path)', () => {
  it('exposes the app workdir and an internal.watchPaths poller', async () => {
    const { facade } = createFacadeFake();
    const surface = await createFilesStoreRuntime('nexari', Promise.resolve(facade));

    expect(surface.workdir).toBe(WORK_DIR);
    expect(typeof surface.internal?.watchPaths).toBe('function');
  });

  it('translates bare workdir-relative write paths to the guest domain', async () => {
    const { facade, calls } = createFacadeFake();
    const surface = await createFilesStoreRuntime('nexari', Promise.resolve(facade));

    await surface.fs.writeFile('src/app.tsx', 'export {};\n');

    expect(calls).toEqual([{ op: 'writeFile', path: '/src/app.tsx', contents: 'export {};\n' }]);
  });

  it('translates WORK_DIR-absolute write paths and refuses paths outside the workdir', async () => {
    const { facade, calls } = createFacadeFake();
    const surface = await createFilesStoreRuntime('nexari', Promise.resolve(facade));

    await surface.fs.writeFile(`${WORK_DIR}/notes.md`, 'hello');

    expect(calls).toEqual([{ op: 'writeFile', path: '/notes.md', contents: 'hello' }]);

    await expect(surface.fs.writeFile('../escape.txt', 'no')).rejects.toBeInstanceOf(NexariUnsupportedCapabilityError);
    await expect(surface.fs.writeFile('/etc/passwd', 'no')).rejects.toBeInstanceOf(NexariUnsupportedCapabilityError);
    expect(calls).toHaveLength(1);
  });

  it('forwards binary write contents unchanged', async () => {
    const { facade, calls } = createFacadeFake();
    const surface = await createFilesStoreRuntime('nexari', Promise.resolve(facade));

    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    await surface.fs.writeFile('assets/logo.png', bytes);

    const written = calls[0]?.contents as Uint8Array;
    expect(Array.from(written)).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it('requires recursive mkdir and forwards the option translated', async () => {
    const { facade, calls } = createFacadeFake();
    const surface = await createFilesStoreRuntime('nexari', Promise.resolve(facade));

    await expect(surface.fs.mkdir('src/components', { recursive: false })).rejects.toBeInstanceOf(
      NexariUnsupportedCapabilityError,
    );

    await surface.fs.mkdir('src/components', { recursive: true });

    expect(calls).toEqual([{ op: 'mkdir', path: '/src/components', options: { recursive: true } }]);
  });

  it('forwards rm with and without options translated', async () => {
    const { facade, calls } = createFacadeFake();
    const surface = await createFilesStoreRuntime('nexari', Promise.resolve(facade));

    await surface.fs.rm('tmp.txt');
    await surface.fs.rm('dist', { recursive: true });
    await surface.fs.rm('cache', { recursive: true, force: true });

    expect(calls).toEqual([
      { op: 'rm', path: '/tmp.txt', options: undefined },
      { op: 'rm', path: '/dist', options: { recursive: true } },
      { op: 'rm', path: '/cache', options: { recursive: true, force: true } },
    ]);
  });

  it('fails closed with a typed error when the promise does not resolve to the facade', async () => {
    await expect(createFilesStoreRuntime('nexari', Promise.resolve({}))).rejects.toBeInstanceOf(
      NexariFilesStoreSurfaceSelectionError,
    );
    await expect(createFilesStoreRuntime('nexari', Promise.resolve('webcontainer'))).rejects.toBeInstanceOf(
      NexariFilesStoreSurfaceSelectionError,
    );
  });
});
