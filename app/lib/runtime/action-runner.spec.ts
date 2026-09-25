import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionRunner } from './action-runner';
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
