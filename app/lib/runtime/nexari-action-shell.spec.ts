import { describe, expect, it, vi } from 'vitest';
import { NexariRuntimeTerminatedError } from './nexari-runtime';
import { createNexariActionShell } from './nexari-action-shell';
import type { NexariBrowserRuntime } from './nexari-runtime-facade';

function createRuntime(result: { stdout: string; stderr: string; exitCode: number }) {
  const runActionCommand = vi.fn().mockResolvedValue(result);
  const runtime = {
    state: 'ready',
    workdir: '/project',
    fs: {},
    boot: vi.fn(),
    spawn: vi.fn(),
    runActionCommand,
    on: vi.fn(),
    setPreviewScript: vi.fn(),
    internal: { watchPaths: vi.fn() },
    teardown: vi.fn(),
  } as unknown as NexariBrowserRuntime & { runActionCommand: ReturnType<typeof vi.fn> };

  return { runtime, runActionCommand };
}

describe('createNexariActionShell', () => {
  it('executes through the facade action lane and composes output as stdout plus stderr', async () => {
    const { runtime, runActionCommand } = createRuntime({
      stdout: 'out',
      stderr: 'err',
      exitCode: 3,
    });

    const shell = createNexariActionShell(runtime);
    await expect(shell.executeCommand('session-1', 'echo hi')).resolves.toEqual({
      output: 'out\nerr',
      exitCode: 3,
    });
    expect(runActionCommand).toHaveBeenCalledWith('echo hi', undefined);
  });

  it('skips empty stderr composition and forwards an abort signal as the caller lane signal', async () => {
    const { runtime, runActionCommand } = createRuntime({
      stdout: 'only-stdout',
      stderr: '',
      exitCode: 0,
    });
    const controller = new AbortController();

    const shell = createNexariActionShell(runtime);
    await expect(shell.executeCommand('session-1', 'sleep 1', undefined, controller.signal)).resolves.toEqual({
      output: 'only-stdout',
      exitCode: 0,
    });
    expect(runActionCommand).toHaveBeenCalledWith('sleep 1', controller.signal);
  });

  it('throws the typed not-booted error when boot has not completed', async () => {
    const { runtime } = createRuntime({ stdout: '', stderr: '', exitCode: 0 });
    (runtime as unknown as { state: string }).state = 'created';

    const shell = createNexariActionShell(runtime);
    await expect(shell.executeCommand('session-1', 'echo hi')).rejects.toThrow(
      'Nexari runtime has not completed booting.',
    );
  });

  it('throws the terminated marker when the runtime already tore down before a command', async () => {
    const { runtime } = createRuntime({ stdout: '', stderr: '', exitCode: 0 });
    (runtime as unknown as { state: string }).state = 'terminated';

    const shell = createNexariActionShell(runtime);
    await expect(shell.executeCommand('session-1', 'echo hi')).rejects.toThrow('Nexari runtime has been terminated.');
    await expect(shell.executeCommand('session-1', 'echo hi')).rejects.toBeInstanceOf(NexariRuntimeTerminatedError);
  });

  it('propagates teardown failures typed, including the terminated marker', async () => {
    const { runtime } = createRuntime({ stdout: '', stderr: '', exitCode: 0 });
    const terminated = new NexariRuntimeTerminatedError();
    (runtime.runActionCommand as ReturnType<typeof vi.fn>).mockRejectedValue(terminated);

    const shell = createNexariActionShell(runtime);
    await expect(shell.executeCommand('session-1', 'echo hi')).rejects.toBe(terminated);
  });

  it('propagates a caller-aborted signal rejection typed, without synthesis', async () => {
    const { runtime, runActionCommand } = createRuntime({ stdout: '', stderr: '', exitCode: 0 });
    const controller = new AbortController();
    controller.abort();

    // Mirror the real runtime contract: runActionCommand throws signal.reason when already aborted.
    (runActionCommand as ReturnType<typeof vi.fn>).mockRejectedValue(controller.signal.reason);

    const shell = createNexariActionShell(runtime);
    await expect(shell.executeCommand('session-1', 'echo hi', undefined, controller.signal)).rejects.toBe(
      controller.signal.reason,
    );
  });

  it('ignores preemption on the nexari lane: commands are serialized by the action pipeline', async () => {
    const { runtime, runActionCommand } = createRuntime({ stdout: 'a', stderr: '', exitCode: 0 });

    const shell = createNexariActionShell(runtime);
    await shell.executeCommand('session-1', 'first');
    await shell.executeCommand('session-2', 'second');

    expect(runActionCommand.mock.calls.map(([command]) => command)).toEqual(['first', 'second']);
  });
});
