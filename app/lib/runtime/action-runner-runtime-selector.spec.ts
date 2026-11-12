import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createActionRunnerRuntime, NexariActionRunnerSurfaceSelectionError } from './action-runner-runtime-selector';
import { NexariUnsupportedCapabilityError } from './nexari-runtime-facade';
import { ActionRunner } from './action-runner';
import type { NexariBrowserRuntime } from './nexari-runtime-facade';
import type { ActionCallbackData } from './message-parser';
import { WORK_DIR } from '~/utils/constants';

/**
 * Facade-shaped fake with recording fs/spin. Paths it receives are asserted in
 * the tests: they must already be in the guest path domain (rooted at `/`),
 * because the adapter under test owns the app-domain → guest-domain
 * translation.
 */
function createFacadeFake(options?: { readdirHits?: string[] }) {
  const fsCalls: Array<{ op: string; path: string; options?: unknown; contents?: unknown }> = [];

  const facade: NexariBrowserRuntime = {
    state: 'ready',
    workdir: WORK_DIR,
    fs: {
      readFile: vi.fn(async (path: string) => {
        fsCalls.push({ op: 'readFile', path });

        return `contents of ${path}`;
      }),
      writeFile: vi.fn(async (path: string, contents: string | Uint8Array) => {
        fsCalls.push({ op: 'writeFile', path, contents });
      }),
      readdir: vi.fn(async (path: string) => {
        fsCalls.push({ op: 'readdir', path });
        options?.readdirHits?.push(path);

        return path === '/dist' ? ['index.html'] : [];
      }),
      mkdir: vi.fn(async (path: string, mkdirOptions?: { recursive?: boolean }) => {
        fsCalls.push({ op: 'mkdir', path, options: mkdirOptions });
      }),
      rm: vi.fn(async (path: string, rmOptions?: { recursive?: boolean; force?: boolean }) => {
        fsCalls.push({ op: 'rm', path, options: rmOptions });
      }),
    },
    boot: vi.fn(async () => undefined),
    spawn: vi.fn(async (_command: string, _args?: string[]) => {
      const stream = (text: string) =>
        new ReadableStream<string>({
          start(controller) {
            if (text.length > 0) {
              controller.enqueue(text);
            }

            controller.close();
          },
        });

      return {
        input: new WritableStream<string>(),
        output: stream('build ok'),
        exit: Promise.resolve(0),
        kill: () => undefined,
        resize: () => undefined,
      };
    }),
    runActionCommand: vi.fn(async (command: string) => ({ stdout: `ran ${command}`, stderr: '', exitCode: 0 })),
    on: (() => () => undefined) as unknown as NexariBrowserRuntime['on'],
    setPreviewScript: () => Promise.resolve(),
    internal: {
      watchPaths: () => {
        throw new NexariUnsupportedCapabilityError('internal.watchPaths (filesystem watching)');
      },
    },
    teardown: vi.fn(async () => undefined),
  };

  return { facade, fsCalls };
}

function resolveWithFacade(promise: Promise<unknown>, facade: NexariBrowserRuntime) {
  return Promise.resolve(facade);
}

function fileData(actionId: string, filePath: string, content: string): ActionCallbackData {
  return {
    artifactId: 'artifact-1',
    messageId: 'message-1',
    actionId,
    action: { type: 'file', filePath, content },
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('createActionRunnerRuntime selection', () => {
  it('AC-1: returns the identical promise instance for the stackblitz backend and never inspects it', async () => {
    const runtimePromise = Promise.resolve({ pretend: 'webcontainer' });
    const selected = createActionRunnerRuntime('stackblitz', runtimePromise);

    expect(selected).toBe(runtimePromise);
  });

  it('AC-2: resolves to a surface when the runtime promise resolves to the nexari facade', async () => {
    const { facade } = createFacadeFake();
    const selected = createActionRunnerRuntime('nexari', resolveWithFacade(Promise.resolve(), facade));
    const surface = await selected;

    expect(typeof surface.workdir).toBe('string');
    expect(typeof surface.fs.writeFile).toBe('function');
    expect(typeof surface.spawn).toBe('function');
  });

  it('AC-2: rejects typed when the runtime promise resolves to something that is not the facade', async () => {
    const selected = createActionRunnerRuntime('nexari', Promise.resolve({ state: 'ready', boot: () => undefined }));

    await expect(selected).rejects.toBeInstanceOf(NexariActionRunnerSurfaceSelectionError);
  });

  it('AC-2: rejects typed when a facade-shaped object lacks the fs surface or spawn (no deep TypeError)', async () => {
    const missingFs = {
      state: 'ready',
      boot: () => undefined,
      teardown: () => undefined,
      runActionCommand: () => undefined,
      spawn: () => undefined,
    };
    const missingSpawn = {
      state: 'ready',
      boot: () => undefined,
      teardown: () => undefined,
      runActionCommand: () => undefined,
      fs: {},
    };

    await expect(createActionRunnerRuntime('nexari', Promise.resolve(missingFs))).rejects.toBeInstanceOf(
      NexariActionRunnerSurfaceSelectionError,
    );
    await expect(createActionRunnerRuntime('nexari', Promise.resolve(missingSpawn))).rejects.toBeInstanceOf(
      NexariActionRunnerSurfaceSelectionError,
    );
  });
});

describe('nexari surface path translation (app domain → guest root)', () => {
  it('AC-3: file action writes translate to guest-rooted absolute paths end to end', async () => {
    const { facade, fsCalls } = createFacadeFake();
    const surface = await createActionRunnerRuntime('nexari', resolveWithFacade(Promise.resolve(), facade));
    const runner = new ActionRunner(Promise.resolve(surface), () => {
      throw new Error('shell not expected in this test');
    });

    runner.addAction(fileData('f1', `${WORK_DIR}/src/main.ts`, 'export {};'));
    await runner.runAction(fileData('f1', `${WORK_DIR}/src/main.ts`, 'export {};'));

    expect(runner.actions.get().f1.status).toBe('complete');
    expect(fsCalls).toEqual(
      expect.arrayContaining([
        { op: 'mkdir', path: '/src', options: { recursive: true } },
        { op: 'writeFile', path: '/src/main.ts', contents: 'export {};' },
      ]),
    );
  });

  it('AC-3: bare relative paths (file history) translate to the same guest root', async () => {
    const { facade, fsCalls } = createFacadeFake();
    const surface = await createActionRunnerRuntime('nexari', resolveWithFacade(Promise.resolve(), facade));

    await surface.fs.writeFile(`${WORK_DIR}/.history/src/app.ts`.replace(`${WORK_DIR}/`, ''), 'x');

    expect(fsCalls).toEqual([{ op: 'writeFile', path: '/.history/src/app.ts', contents: 'x' }]);
  });

  it('AC-3: the build action probes translated build directories and forwards spawn args exactly', async () => {
    const { facade, fsCalls } = createFacadeFake({ readdirHits: [] });
    const surface = await createActionRunnerRuntime('nexari', resolveWithFacade(Promise.resolve(), facade));
    const runner = new ActionRunner(Promise.resolve(surface), () => {
      throw new Error('shell not expected in this test');
    });

    runner.addAction({
      artifactId: 'artifact-1',
      messageId: 'message-1',
      actionId: 'b1',
      action: { type: 'build' },
    } as ActionCallbackData);
    await runner.runAction({
      artifactId: 'artifact-1',
      messageId: 'message-1',
      actionId: 'b1',
      action: { type: 'build' },
    } as ActionCallbackData);

    expect(runner.actions.get().b1.status).toBe('complete');
    expect(facade.spawn).toHaveBeenCalledWith('npm', ['run', 'build']);
    expect(fsCalls.some((call) => call.op === 'readdir' && call.path === '/dist')).toBe(true);
    expect(runner.buildOutput?.exitCode).toBe(0);
  });

  it('AC-3: utf-8 history reads return text through the utf8 arm', async () => {
    const { facade } = createFacadeFake();
    const surface = await createActionRunnerRuntime('nexari', resolveWithFacade(Promise.resolve(), facade));

    const text = await surface.fs.readFile('.history/src/app.ts', 'utf-8');

    expect(text).toBe('contents of /.history/src/app.ts');
  });
});

describe('nexari surface fail-closed shapes', () => {
  it('AC-4: binary-arm reads fail typed without touching the guest', async () => {
    const { facade, fsCalls } = createFacadeFake();
    const surface = await createActionRunnerRuntime('nexari', resolveWithFacade(Promise.resolve(), facade));

    await expect(surface.fs.readFile('/src/data.bin', null)).rejects.toBeInstanceOf(NexariUnsupportedCapabilityError);
    await expect(surface.fs.readFile('/src/data.bin')).rejects.toBeInstanceOf(NexariUnsupportedCapabilityError);
    expect(fsCalls).toEqual([]);
  });

  it('AC-4: Uint8Array writes fail typed without touching the guest', async () => {
    const { facade, fsCalls } = createFacadeFake();
    const surface = await createActionRunnerRuntime('nexari', resolveWithFacade(Promise.resolve(), facade));

    await expect(surface.fs.writeFile('/src/data.bin', new Uint8Array([1, 2, 3]))).rejects.toBeInstanceOf(
      NexariUnsupportedCapabilityError,
    );
    expect(fsCalls).toEqual([]);
  });

  it('AC-4: non-recursive mkdir fails typed without touching the guest', async () => {
    const { facade, fsCalls } = createFacadeFake();
    const surface = await createActionRunnerRuntime('nexari', resolveWithFacade(Promise.resolve(), facade));

    /*
     * The static surface type already forbids this shape; the cast pins the
     * runtime defense for callers that reach the method through a widened type.
     */
    const nonRecursiveOptions = { recursive: false } as unknown as { recursive: true };

    await expect(surface.fs.mkdir('/src', nonRecursiveOptions)).rejects.toBeInstanceOf(
      NexariUnsupportedCapabilityError,
    );
    expect(fsCalls).toEqual([]);
  });

  it('AC-3: paths escaping the work directory fail typed without touching the guest', async () => {
    const { facade, fsCalls } = createFacadeFake();
    const surface = await createActionRunnerRuntime('nexari', resolveWithFacade(Promise.resolve(), facade));

    await expect(surface.fs.writeFile('/etc/passwd', 'nope')).rejects.toBeInstanceOf(NexariUnsupportedCapabilityError);
    await expect(surface.fs.writeFile(`${WORK_DIR}/../../etc/passwd`, 'nope')).rejects.toBeInstanceOf(
      NexariUnsupportedCapabilityError,
    );

    /*
     * Bare-relative escapes: the exact shape #runFileAction feeds when the
     * model emits a filePath outside WORK_DIR (nodePath.relative output).
     */
    await expect(surface.fs.writeFile('../../etc/passwd', 'nope')).rejects.toBeInstanceOf(
      NexariUnsupportedCapabilityError,
    );
    await expect(surface.fs.readFile('../outside.txt', 'utf-8')).rejects.toBeInstanceOf(
      NexariUnsupportedCapabilityError,
    );
    expect(fsCalls).toEqual([]);
  });

  it('AC-3: a file action with a filePath outside WORK_DIR is refused typed end to end', async () => {
    const { facade, fsCalls } = createFacadeFake();
    const surface = await createActionRunnerRuntime('nexari', resolveWithFacade(Promise.resolve(), facade));
    const runner = new ActionRunner(Promise.resolve(surface), () => {
      throw new Error('shell not expected in this test');
    });

    runner.addAction(fileData('f2', '/etc/escape.txt', 'nope'));
    await runner.runAction(fileData('f2', '/etc/escape.txt', 'nope'));

    /*
     * The surface refused the escape without touching the guest. The runner's
     * historical catch-and-log in #runFileAction marks the action complete —
     * identical to how a StackBlitz write failure surfaces today; the refusal
     * is observable at the surface, not swallowed there.
     */
    expect(fsCalls).toEqual([]);
    expect(facade.fs.writeFile).not.toHaveBeenCalled();
  });

  it('AC-4: a guest returning bytes for a text read fails typed instead of smuggling bytes as text', async () => {
    const { facade } = createFacadeFake();

    facade.fs.readFile = vi.fn(async () => new Uint8Array([104, 105]));

    const surface = await createActionRunnerRuntime('nexari', resolveWithFacade(Promise.resolve(), facade));

    await expect(surface.fs.readFile('/src/app.ts', 'utf8')).rejects.toBeInstanceOf(NexariUnsupportedCapabilityError);
  });
});
