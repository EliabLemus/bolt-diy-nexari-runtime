import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNexariWatchPaths } from './files-store-runtime-selector';
import type { NexariBrowserRuntime, NexariBrowserFileSystem } from './nexari-runtime-facade';

const WORK_DIR = '/home/project';

type FakeFs = Map<string, string>;

function fakeRuntime(fs: FakeFs): NexariBrowserRuntime {
  const fileSystem: NexariBrowserFileSystem = {
    writeFile: async (guestPath, contents) => {
      fs.set(guestPath, typeof contents === 'string' ? contents : new TextDecoder().decode(contents));
    },
    readFile: async (guestPath) => {
      const content = fs.get(guestPath);

      if (content === undefined) {
        throw new Error(`ENOENT: ${guestPath}`);
      }

      return content;
    },
    readdir: async (guestPath) => {
      const normalized = guestPath === '.' || guestPath === '/' ? '' : guestPath.replace(/^\/+/, '');
      const depthPrefix = normalized ? `${normalized}/` : '';
      const children = new Set<string>();

      for (const key of fs.keys()) {
        if (!key.startsWith(depthPrefix)) {
          continue;
        }

        const rest = key.slice(depthPrefix.length);

        if (rest.length === 0) {
          continue;
        }

        children.add(rest.split('/')[0]);
      }

      const isFile = fs.has(normalized);

      if (children.size === 0 && !isFile && normalized !== '') {
        throw new Error(`ENOENT: ${guestPath}`);
      }

      if (children.size === 0 && isFile) {
        throw new Error(`ENOTDIR: ${guestPath}`);
      }

      return [...children];
    },
    mkdir: async (guestPath) => {
      // Directories are implicit in the fake fs; mark them with a sentinel file.
      fs.set(`${guestPath.replace(/^\/+/, '')}/.keep`, '');
    },
    rm: async (guestPath, options) => {
      const normalized = guestPath.replace(/^\/+/, '');

      for (const key of [...fs.keys()]) {
        if (key === normalized || (options?.recursive && key.startsWith(`${normalized}/`))) {
          fs.delete(key);
        }
      }
    },
  };

  return {
    state: 'ready',
    workdir: WORK_DIR,
    fs: fileSystem,
    boot: async () => undefined,
    spawn: async () => {
      throw new Error('not used');
    },
    runActionCommand: async () => {
      throw new Error('not used');
    },
    on: () => undefined,
    setPreviewScript: async () => undefined,
    internal: {
      watchPaths: () => {
        throw new Error('not used');
      },
    },
    teardown: async () => undefined,
  } as unknown as NexariBrowserRuntime;
}

describe('nexari watchPaths poller', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits add_file events with content for newly created files', async () => {
    const fs: FakeFs = new Map([['src/app.tsx', 'const a = 1;']]);
    const runtime = fakeRuntime(fs);
    const watch = createNexariWatchPaths(runtime, { intervalMs: 50 });
    const batches: Array<Array<{ type: string; path: string; buffer?: Uint8Array }>> = [];

    const stop = watch({ include: [`${WORK_DIR}/**`], includeContent: true }, (events) => batches.push(events as any));

    await vi.advanceTimersByTimeAsync(60);
    expect(batches.length).toBeGreaterThan(0);

    const added = batches.flat().filter((event) => event.type === 'add_file');

    expect(added.some((event) => event.path === `${WORK_DIR}/src/app.tsx`)).toBe(true);

    const withContent = added.find((event) => event.path === `${WORK_DIR}/src/app.tsx`);

    expect(new TextDecoder().decode(withContent?.buffer)).toBe('const a = 1;');

    stop();
  });

  it('emits change events when file content changes', async () => {
    const fs: FakeFs = new Map([['app.tsx', 'v1']]);
    const runtime = fakeRuntime(fs);
    const watch = createNexariWatchPaths(runtime, { intervalMs: 50 });
    const batches: Array<Array<{ type: string; path: string; buffer?: Uint8Array }>> = [];

    const stop = watch({ includeContent: true }, (events) => batches.push(events as any));

    await vi.advanceTimersByTimeAsync(60);
    fs.set('app.tsx', 'v2');
    await vi.advanceTimersByTimeAsync(60);

    const changes = batches.flat().filter((event) => event.path === `${WORK_DIR}/app.tsx` && event.type === 'change');

    expect(changes.length).toBe(1);
    expect(new TextDecoder().decode(changes[0].buffer)).toBe('v2');

    stop();
  });

  it('respects exclude patterns for any depth', async () => {
    const fs: FakeFs = new Map([
      ['node_modules/pkg/index.js', 'x'],
      ['src/app.tsx', 'y'],
    ]);
    const runtime = fakeRuntime(fs);
    const watch = createNexariWatchPaths(runtime, { intervalMs: 50 });
    const batches: Array<Array<{ type: string; path: string }>> = [];

    const stop = watch(
      {
        includeContent: false,
        exclude: ['**/node_modules', '.git', '**/package-lock.json'],
      },
      (events) => batches.push(events as any),
    );

    await vi.advanceTimersByTimeAsync(60);

    const paths = batches.flat().map((event) => event.path);

    expect(paths.some((path) => path.includes('node_modules'))).toBe(false);
    expect(paths.some((path) => path === `${WORK_DIR}/src/app.tsx`)).toBe(true);

    stop();
  });

  it('emits remove_file events for deleted files and stops after unsubscribe', async () => {
    const fs: FakeFs = new Map([['app.tsx', 'x']]);
    const runtime = fakeRuntime(fs);
    const watch = createNexariWatchPaths(runtime, { intervalMs: 50 });
    const batches: Array<Array<{ type: string; path: string }>> = [];

    const stop = watch({ includeContent: true }, (events) => batches.push(events as any));

    await vi.advanceTimersByTimeAsync(60);

    fs.delete('app.tsx');
    await vi.advanceTimersByTimeAsync(60);

    const removed = batches.flat().filter((event) => event.type === 'remove_file');

    expect(removed.map((event) => event.path)).toContain(`${WORK_DIR}/app.tsx`);

    stop();

    const batchCount = batches.length;
    fs.set('app.tsx', 'recreated');
    await vi.advanceTimersByTimeAsync(120);

    expect(batches.length).toBe(batchCount);
  });
});
