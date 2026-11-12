import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { NexariRuntimeTerminatedError } from './nexari-runtime';
import { NexariActionShellSelectionError, createActionShell } from './action-shell-selector';
import type { NexariBrowserRuntime } from './nexari-runtime-facade';
import type { BoltShell } from '~/utils/shell';

/**
 * Selector-level pins. Adapter behavior is owned by the stackblitz/nexari
 * adapter specs; these tests pin routing, promise handling, and the
 * fail-closed structural predicate only.
 */

function createBoltShell() {
  return {
    ready: vi.fn().mockResolvedValue(undefined),
    terminal: {} as object | undefined,
    process: {} as object | undefined,
    executeCommand: vi.fn().mockResolvedValue({ output: 'clean', exitCode: 0 }),
    executionState: { get: () => ({ sessionId: 'x', active: false }) },
  };
}

function createPoisonedBoltShell(): BoltShell {
  const boom = (): never => {
    throw new Error('BoltShell must not be touched on the nexari path');
  };

  return {
    get terminal() {
      return boom();
    },
    get process() {
      return boom();
    },
    ready: vi.fn(boom),
    executeCommand: vi.fn(boom),
    executionState: { get: boom },
  } as unknown as BoltShell;
}

function createFacadeMock(overrides: Partial<Record<string, unknown>> = {}): NexariBrowserRuntime {
  return {
    state: 'ready',
    workdir: '/project',
    fs: {},
    boot: async () => undefined,
    spawn: async () => {
      throw new Error('not used here');
    },
    runActionCommand: vi.fn().mockResolvedValue({ stdout: 'out', stderr: '', exitCode: 0 }),
    on: () => undefined,
    setPreviewScript: async () => undefined,
    internal: { watchPaths: () => undefined },
    teardown: async () => undefined,
    ...overrides,
  } as unknown as NexariBrowserRuntime;
}

const neverPromise = new Promise<unknown>(() => undefined);

describe('createActionShell selection', () => {
  it('selects solely by the backend parameter: identical inputs route differently', async () => {
    const bolt = createBoltShell();
    const runtimePromise = Promise.resolve(createFacadeMock());

    const stackblitzShell = createActionShell('stackblitz', bolt as unknown as BoltShell, runtimePromise);
    await stackblitzShell.assertRunnable();
    expect(bolt.ready).toHaveBeenCalledTimes(1);

    const nexariShell = createActionShell('nexari', createPoisonedBoltShell(), runtimePromise);
    await nexariShell.assertRunnable();
  });

  it('stackblitz branch never awaits or attaches to the runtime promise (never-settling promise stays inert)', async () => {
    const bolt = createBoltShell();
    const shell = createActionShell('stackblitz', bolt as unknown as BoltShell, neverPromise);

    await shell.assertRunnable();
    await expect(shell.executeCommand('s1', 'ls')).resolves.toEqual({ output: 'clean', exitCode: 0 });
    expect(bolt.executeCommand).toHaveBeenCalledWith('s1', 'ls', undefined);
  });

  it('stackblitz branch never attaches any handler to the runtime promise (tracking thenable)', async () => {
    const attachedHandlers: unknown[] = [];

    /*
     * Structural thenable standing in for the runtime promise. Any eager
     * `.then`/`.catch`/`.finally` the selector performed would register here.
     */
    const trackingPromise = {
      then(onFulfilled?: unknown, onRejected?: unknown) {
        attachedHandlers.push([onFulfilled, onRejected]);

        return Promise.resolve().then(onFulfilled as never, onRejected as never);
      },
      catch(onRejected?: unknown) {
        attachedHandlers.push(onRejected);

        return Promise.resolve().catch(onRejected as never);
      },
      finally(onFinally?: () => void) {
        attachedHandlers.push(onFinally);

        return Promise.resolve().finally(onFinally);
      },
    } as unknown as Promise<unknown>;

    const bolt = createBoltShell();
    const shell = createActionShell('stackblitz', bolt as unknown as BoltShell, trackingPromise);

    await shell.assertRunnable();
    await shell.executeCommand('s1', 'ls');

    expect(attachedHandlers).toEqual([]);
  });
});

describe('createActionShell nexari routing', () => {
  it('resolves the runtime promise per call and delegates to the facade adapter; BoltShell untouched', async () => {
    const runtime = createFacadeMock();
    const shell = createActionShell('nexari', createPoisonedBoltShell(), Promise.resolve(runtime));

    await shell.assertRunnable();

    const result = await shell.executeCommand('s1', 'echo hi');
    expect(result).toEqual({ output: 'out', exitCode: 0 });
    expect(runtime.runActionCommand).toHaveBeenCalledWith('echo hi', undefined);
  });

  it('double resolution per action is idempotent; a terminated flip between calls surfaces the typed error', async () => {
    const runtime = createFacadeMock();
    const shell = createActionShell('nexari', createPoisonedBoltShell(), Promise.resolve(runtime));

    await shell.assertRunnable();
    await shell.executeCommand('s1', 'a');

    (runtime.state as string) = 'terminated';

    await expect(shell.executeCommand('s1', 'b')).rejects.toBeInstanceOf(NexariRuntimeTerminatedError);
  });

  it('propagates a rejected runtime promise unchanged, preserving the original error instance', async () => {
    const bootFailure = new NexariBootFailure();
    const shell = createActionShell('nexari', createPoisonedBoltShell(), Promise.reject(bootFailure));

    await expect(shell.assertRunnable()).rejects.toBe(bootFailure);
    await expect(shell.executeCommand('s1', 'a')).rejects.toBe(bootFailure);
  });
});

class NexariBootFailure extends Error {
  constructor() {
    super('Nexari guest boot is not configured in this build.');
    this.name = 'NexariBootNotConfiguredError';
  }
}

describe('createActionShell structural predicate (fail-closed)', () => {
  it('accepts a facade-shaped value and rejects a WebContainer-shaped value', async () => {
    const ok = createActionShell('nexari', createPoisonedBoltShell(), Promise.resolve(createFacadeMock()));
    await expect(ok.assertRunnable()).resolves.toBeUndefined();

    const webcontainerShaped = {
      spawn: async () => undefined,
      mount: async () => undefined,
      teardown: async () => undefined,
    };
    const bad = createActionShell('nexari', createPoisonedBoltShell(), Promise.resolve(webcontainerShaped));
    await expect(bad.assertRunnable()).rejects.toBeInstanceOf(NexariActionShellSelectionError);
  });

  it('rejects runActionCommand without a string state, and non-object resolutions', async () => {
    const missingState = createActionShell(
      'nexari',
      createPoisonedBoltShell(),
      Promise.resolve(createFacadeMock({ state: 42 })),
    );
    await expect(missingState.assertRunnable()).rejects.toBeInstanceOf(NexariActionShellSelectionError);

    for (const value of [undefined, 'facade', 7]) {
      const shell = createActionShell('nexari', createPoisonedBoltShell(), Promise.resolve(value));
      await expect(shell.assertRunnable()).rejects.toBeInstanceOf(NexariActionShellSelectionError);
    }
  });
});

describe('selection-path import hygiene', () => {
  it('selector module contains no @webcontainer/api value import and never imports the webcontainer index', async () => {
    const source = await readFile(new URL('./action-shell-selector.ts', import.meta.url), 'utf8');

    expect(source).not.toMatch(/^\s*import\s+\{[^}]*\}\s+from\s+'@webcontainer\/api';/m);
    expect(source).not.toMatch(/await\s+import\('@webcontainer\/api'\)/);
    expect(source).not.toMatch(/from\s+'~\/lib\/webcontainer'/);
  });

  it('workbench wiring routes through the selector with the module-scope backend and no direct stackblitz factory', async () => {
    const source = await readFile(new URL('../stores/workbench.ts', import.meta.url), 'utf8');

    expect(source).toMatch(/createActionShell\(runtimeBackend,/);
    expect(source).not.toMatch(/createStackblitzActionShell/);
  });
});
