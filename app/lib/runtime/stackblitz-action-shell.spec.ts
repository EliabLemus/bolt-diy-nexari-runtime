import { describe, expect, it, vi } from 'vitest';
import { createStackblitzActionShell } from './stackblitz-action-shell';

function createBoltShell() {
  return {
    ready: vi.fn().mockResolvedValue(undefined),
    terminal: {} as object | undefined,
    process: {} as object | undefined,
    executeCommand: vi.fn().mockResolvedValue({ output: 'clean', exitCode: 0 }),
    executionState: { get: () => ({ sessionId: 'x', active: false }) },
  };
}

describe('createStackblitzActionShell', () => {
  it('awaits BoltShell readiness before each command and forwards the exact argument triple', async () => {
    const shell = createBoltShell();
    const onAbort = vi.fn();

    const adapter = createStackblitzActionShell(shell as never);
    await adapter.executeCommand('runner-1', 'npm test', onAbort);

    expect(shell.ready).toHaveBeenCalledTimes(1);
    expect(shell.executeCommand).toHaveBeenCalledWith('runner-1', 'npm test', onAbort);
  });

  it('keeps ExecutionResult passthrough byte-identical, including undefined and NaN exit codes', async () => {
    const shell = createBoltShell();
    (shell.executeCommand as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ output: 'merged-cleaned', exitCode: 1 })
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ output: 'x', exitCode: NaN });

    const adapter = createStackblitzActionShell(shell as never);

    await expect(adapter.executeCommand('s1', 'a')).resolves.toEqual({ output: 'merged-cleaned', exitCode: 1 });
    await expect(adapter.executeCommand('s1', 'b')).resolves.toBeUndefined();
    await expect(adapter.executeCommand('s1', 'c')).resolves.toEqual({ output: 'x', exitCode: NaN });
  });

  it('rejects with the exact Unreachable error when the terminal or process is missing', async () => {
    const shell = createBoltShell();
    shell.terminal = undefined;

    const adapter = createStackblitzActionShell(shell as never);
    await expect(adapter.executeCommand('s1', 'ls')).rejects.toThrow('Unreachable: Shell terminal not found');
    expect(shell.executeCommand).not.toHaveBeenCalled();
  });

  it('does not throw the Unreachable error during the boot window: the guard awaits readiness first', async () => {
    const shell = createBoltShell();
    shell.terminal = undefined; // not yet attached: mirrors pre-init BoltShell

    let resolveReady: (() => void) | undefined;
    (shell.ready as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<void>((resolve) => (resolveReady = resolve)),
    );

    const adapter = createStackblitzActionShell(shell as never);
    const pending = adapter.executeCommand('s1', 'ls');

    // Guard is waiting on readiness; no sync Unreachable rejection, no dispatch.
    await Promise.resolve();
    expect(shell.executeCommand).not.toHaveBeenCalled();

    shell.terminal = {}; // attach, then release readiness
    resolveReady?.();

    await expect(pending).resolves.toEqual({ output: 'clean', exitCode: 0 });
    expect(shell.executeCommand).toHaveBeenCalledWith('s1', 'ls', undefined);
  });

  it('surfaces ready() rejection unchanged', async () => {
    const shell = createBoltShell();
    (shell.ready as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boot failed'));

    const adapter = createStackblitzActionShell(shell as never);
    await expect(adapter.executeCommand('s1', 'ls')).rejects.toThrow('boot failed');
    expect(shell.executeCommand).not.toHaveBeenCalled();
  });

  it('wraps the shared BoltShell instance without touching its executionState atom', async () => {
    const shell = createBoltShell();

    const adapter = createStackblitzActionShell(shell as never);
    await adapter.executeCommand('runner-9', 'echo');

    expect(shell.executeCommand).toHaveBeenCalledTimes(1);
    expect(shell.executionState.get()).toEqual({ sessionId: 'x', active: false });
  });
});
