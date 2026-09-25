import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionRunner, type ActionRunnerRuntimeSurface } from './action-runner';
import type { ActionCallbackData } from './message-parser';
import type { ActionShell } from './action-shell';

function createShellStub() {
  return {
    assertRunnable: vi.fn().mockResolvedValue(undefined),
    executeCommand: vi.fn().mockResolvedValue({ output: 'all good', exitCode: 0 }),
    executionState: { get: () => ({ sessionId: 'x', active: false }) },
  } as unknown as ActionShell & {
    assertRunnable: ReturnType<typeof vi.fn>;
    executeCommand: ReturnType<typeof vi.fn>;
  };
}

function createRunner(getShellTerminal: () => ActionShell) {
  return new ActionRunner(
    new Promise(() => {
      // pending webcontainer promise: file/build actions are not exercised here
    }),
    getShellTerminal,
    () => undefined,
    () => undefined,
    () => undefined,
  );
}

function shellData(actionId: string, content: string): ActionCallbackData {
  return {
    artifactId: 'artifact-1',
    messageId: 'message-1',
    actionId,
    action: { type: 'shell', content },
  };
}

describe('ActionRunner shell actions over the runtime-agnostic seam', () => {
  let shell: ReturnType<typeof createShellStub>;

  beforeEach(() => {
    shell = createShellStub();
  });

  it('routes shell actions through the seam with the runner session id and completes on exit 0', async () => {
    const runner = createRunner(() => shell);
    runner.addAction(shellData('a1', 'echo hi'));

    await runner.runAction(shellData('a1', 'echo hi'));

    /*
     * Guard (including readiness) now lives behind the seam adapter; the runner
     * itself must only touch assertRunnable/executeCommand.
     */
    expect(shell.assertRunnable).toHaveBeenCalledTimes(1);
    expect(shell.executeCommand).toHaveBeenCalledWith(expect.any(String), 'echo hi', expect.any(Function));
    expect(runner.actions.get().a1.status).toBe('complete');
  });

  it('awaits the seam guard before the guard-then-command sequence, preserving boot-window semantics', async () => {
    let resolveGuard: (() => void) | undefined;
    const shell = createShellStub();
    (shell.assertRunnable as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<void>((resolve) => (resolveGuard = resolve)),
    );

    const runner = createRunner(() => shell);
    const data = shellData('a6', 'echo hi');
    runner.addAction(data);

    const pipeline = runner.runAction(data);

    // While the guard is pending (boot window), no command may be dispatched.
    await Promise.resolve();
    expect(shell.executeCommand).not.toHaveBeenCalled();

    resolveGuard?.();
    await pipeline;

    expect(shell.executeCommand).toHaveBeenCalledTimes(1);
    expect(runner.actions.get().a6.status).toBe('complete');
  });

  it('marks the action failed and raises the shell alert on a non-zero exit code', async () => {
    const runner = createRunner(() => shell);
    (shell.executeCommand as ReturnType<typeof vi.fn>).mockResolvedValue({
      output: 'command not found: nope\nnpm ERR! something',
      exitCode: 127,
    });
    runner.addAction(shellData('a2', 'nope'));

    const alerts: Array<{ title: string }> = [];
    runner.onAlert = (alert) => alerts.push(alert as { title: string });

    await runner.runAction(shellData('a2', 'nope'));

    expect(runner.actions.get().a2.status).toBe('failed');
    expect((runner.actions.get().a2 as { error?: string }).error).toBe('Action failed');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].title).toBe('Dev Server Failed');
  });

  it('marks an aborted action as aborted instead of failed', async () => {
    const runner = createRunner(() => shell);
    runner.addAction(shellData('a3', 'long-task'));
    runner.actions.get().a3.abort();

    await runner.runAction(shellData('a3', 'long-task'));

    expect(runner.actions.get().a3.status).toBe('aborted');
  });

  it('keeps streaming shell actions in running status until a later explicit run completes them', async () => {
    const runner = createRunner(() => shell);
    runner.addAction(shellData('a4', 'stream-cmd'));

    await runner.runAction(shellData('a4', 'stream-cmd'), true);

    expect(runner.actions.get().a4.status).toBe('running');
  });

  it('propagates a seam rejection as a failed action without crashing the pipeline', async () => {
    const runner = createRunner(() => shell);
    (shell.executeCommand as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('shell not ready'));
    runner.addAction(shellData('a5', 'echo hi'));

    await runner.runAction(shellData('a5', 'echo hi'));

    expect(runner.actions.get().a5.status).toBe('failed');
  });
});

describe('ActionRunner start actions over the runtime-agnostic seam', () => {
  it('marks a start action complete on exit 0 without blocking the pipeline', async () => {
    vi.useFakeTimers();

    try {
      const shellStub = createShellStub();
      const runner = createRunner(() => shellStub);
      runner.addAction({
        artifactId: 'artifact-1',
        messageId: 'message-1',
        actionId: 's1',
        action: { type: 'start', content: 'npm run dev' },
      });

      const pipeline = runner.runAction({
        artifactId: 'artifact-1',
        messageId: 'message-1',
        actionId: 's1',
        action: { type: 'start', content: 'npm run dev' },
      });
      await vi.advanceTimersByTimeAsync(2100);
      await pipeline;

      expect(shellStub.executeCommand).toHaveBeenCalledWith(expect.any(String), 'npm run dev', expect.any(Function));
      expect(runner.actions.get().s1.status).toBe('complete');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ActionRunner accepts any ActionShell implementation', () => {
  it('completes a shell action through a fully synthetic seam implementation', async () => {
    const seam: ActionShell = {
      assertRunnable: () => Promise.resolve(),
      executeCommand: vi.fn().mockResolvedValue({ output: 'synthetic', exitCode: 0 }),
    };
    const runner = createRunner(() => seam);
    runner.addAction(shellData('n1', 'synthetic command'));

    await runner.runAction(shellData('n1', 'synthetic command'));

    expect(seam.executeCommand).toHaveBeenCalledWith(expect.any(String), 'synthetic command', expect.any(Function));
    expect(runner.actions.get().n1.status).toBe('complete');
  });
});

describe('ActionRunner consumes only the narrow runtime surface', () => {
  interface SurfaceFile {
    bytes: Uint8Array;
    text: string;
  }

  /**
   * In-memory fake satisfying ActionRunnerRuntimeSurface and nothing more:
   * every member outside the surface (mount, watch, rename, on, internal,
   * ...) is intentionally absent, so a runtime touchpoint that drifts beyond
   * the narrow surface fails the typecheck of this harness itself.
   */
  function createSurfaceFake() {
    const files = new Map<string, SurfaceFile>();
    const dirs = new Set<string>(['.']);
    const spawns: Array<{ command: string; args: string[] }> = [];

    const fs: ActionRunnerRuntimeSurface['fs'] = {
      readFile: vi.fn(async (path: string, encoding?: null | BufferEncoding): Promise<string | Uint8Array> => {
        const file = files.get(path);

        if (!file) {
          throw new Error(`ENOENT: ${path}`);
        }

        return encoding ? file.text : file.bytes;
      }) as ActionRunnerRuntimeSurface['fs']['readFile'],
      writeFile: vi.fn(async (path: string, contents: string | Uint8Array) => {
        const parent = path.split('/').slice(0, -1).join('/') || '.';
        dirs.add(parent);
        files.set(path, {
          bytes: contents instanceof Uint8Array ? contents : new TextEncoder().encode(contents),
          text: typeof contents === 'string' ? contents : '',
        });
      }),
      readdir: vi.fn(async (path: string) => {
        if (!dirs.has(path)) {
          throw new Error(`ENOENT: ${path}`);
        }

        return [...dirs].filter((dir) => dir !== path && dir.startsWith(`${path === '.' ? '' : path}/`));
      }),
      mkdir: vi.fn(async (path: string) => {
        dirs.add(path);

        let cursor = path;

        while (cursor.includes('/')) {
          cursor = cursor.split('/').slice(0, -1).join('/');
          dirs.add(cursor);
        }
      }),
      rm: vi.fn(async (path: string) => {
        dirs.delete(path);
        files.delete(path);
      }),
    };

    const spawn = vi.fn(async (command: string, args: string[]) => {
      spawns.push({ command, args });

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
        output: stream('build ok'),
        exit: Promise.resolve(0),
      };
    });

    const surface: ActionRunnerRuntimeSurface = { workdir: '/project', fs, spawn };

    return { surface, fs, spawn, spawns, files, dirs };
  }

  function createSurfaceRunner(surface: ActionRunnerRuntimeSurface, onDeployAlert?: (alert: unknown) => void) {
    return new ActionRunner(
      Promise.resolve(surface),
      () => createShellStub(),
      () => undefined,
      () => undefined,
      onDeployAlert,
    );
  }

  it('runs file actions through the narrow surface (mkdir + writeFile)', async () => {
    const { surface, fs } = createSurfaceFake();
    const runner = createSurfaceRunner(surface);

    runner.addAction({
      artifactId: 'artifact-1',
      messageId: 'message-1',
      actionId: 'f1',
      action: { type: 'file', filePath: '/project/src/main.ts', content: 'export {};' },
    });
    await runner.runAction({
      artifactId: 'artifact-1',
      messageId: 'message-1',
      actionId: 'f1',
      action: { type: 'file', filePath: '/project/src/main.ts', content: 'export {};' },
    });

    expect(fs.mkdir).toHaveBeenCalledWith('src', { recursive: true });
    expect(fs.writeFile).toHaveBeenCalledWith('src/main.ts', 'export {};');
    expect(runner.actions.get().f1.status).toBe('complete');
  });

  it('reads file history as utf-8 text through the narrow surface', async () => {
    const { surface } = createSurfaceFake();
    const runner = createSurfaceRunner(surface);
    const history = new Map<string, string>([['.history/src/app.ts', JSON.stringify({ original: 'x' })]]);

    (surface.fs.readFile as ReturnType<typeof vi.fn>).mockImplementation(async (path: string, encoding?: null) => {
      const text = history.get(path);

      if (encoding && text !== undefined) {
        return text;
      }

      throw new Error(`ENOENT: ${path}`);
    });

    await expect(runner.getFileHistory('src/app.ts')).resolves.toEqual({ original: 'x' });
    expect(surface.fs.readFile).toHaveBeenCalledWith('.history/src/app.ts', 'utf-8');
  });

  it('runs the build action through the narrow surface (spawn + readdir probes)', async () => {
    const { surface, spawn } = createSurfaceFake();
    (surface.fs.readdir as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('ENOENT'));

    const runner = createSurfaceRunner(surface, () => undefined);

    runner.addAction({
      artifactId: 'artifact-1',
      messageId: 'message-1',
      actionId: 'b1',
      action: { type: 'build', content: 'npm run build' },
    });
    await runner.runAction({
      artifactId: 'artifact-1',
      messageId: 'message-1',
      actionId: 'b1',
      action: { type: 'build', content: 'npm run build' },
    });

    expect(spawn).toHaveBeenCalledWith('npm', ['run', 'build']);
    expect(runner.buildOutput).toEqual({
      path: '/project/dist',
      exitCode: 0,
      output: 'build ok',
    });
    expect(runner.actions.get().b1.status).toBe('complete');
  });
});
