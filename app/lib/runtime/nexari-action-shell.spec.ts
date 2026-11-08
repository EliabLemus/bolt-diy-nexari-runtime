import { describe, expect, it, vi } from 'vitest';
import { NexariRuntimeTerminatedError } from './nexari-runtime';
import { createNexariActionShell, rewriteWasmSafeCommand } from './nexari-action-shell';
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

describe('rewriteWasmSafeCommand', () => {
  it('maps bare install to the full install pipeline (install + wasm builds + rollup swap)', () => {
    expect(rewriteWasmSafeCommand('npm install')).toEqual([
      'npm install --ignore-scripts',
      'npm install --no-save --ignore-scripts esbuild@0.28.2 @rollup/wasm-node',
      expect.stringContaining('fs.cpSync'),
    ]);
  });

  it('discards model flags: install variants normalize to the exact same pipeline', () => {
    expect(rewriteWasmSafeCommand('npm install --legacy-peer-deps')).toEqual(rewriteWasmSafeCommand('npm install'));
    expect(rewriteWasmSafeCommand('npm ci')).toEqual(rewriteWasmSafeCommand('npm install'));
    expect(rewriteWasmSafeCommand('  npm   install  ')).toEqual(rewriteWasmSafeCommand('npm install'));
  });

  it('maps dev, build and preview to the start pipeline (install + rollup swap + npm run X)', () => {
    const pipeline = rewriteWasmSafeCommand('npm run dev');
    expect(pipeline).toEqual(['npm install --ignore-scripts', expect.stringContaining('fs.cpSync'), 'npm run dev']);
    expect(rewriteWasmSafeCommand('npm run build')?.at(-1)).toBe('npm run build');
    expect(rewriteWasmSafeCommand('npm run preview')?.at(-1)).toBe('npm run preview');
  });

  it('maps the compound model command to the dev pipeline', () => {
    expect(rewriteWasmSafeCommand('npm install && npm run dev')).toEqual(rewriteWasmSafeCommand('npm run dev'));
  });

  it('rewrites pnpm/yarn to the npm pipeline (the guest has no pnpm/yarn)', () => {
    expect(rewriteWasmSafeCommand('pnpm install')).toEqual(rewriteWasmSafeCommand('npm install'));
    expect(rewriteWasmSafeCommand('yarn install && yarn run dev')).toEqual(rewriteWasmSafeCommand('npm run dev'));
  });

  it('returns null for non-project commands', () => {
    expect(rewriteWasmSafeCommand('ls -la')).toBeNull();
    expect(rewriteWasmSafeCommand('cat package.json')).toBeNull();
    expect(rewriteWasmSafeCommand('')).toBeNull();
    expect(rewriteWasmSafeCommand('npm test')).toBeNull();
  });
});

describe('createNexariActionShell wasm-safe rewriting', () => {
  it('never sends a project command raw: the rewritten pipeline runs step by step', async () => {
    const { runtime, runActionCommand } = createRuntime({ stdout: 'ok', stderr: '', exitCode: 0 });

    const shell = createNexariActionShell(runtime);
    await shell.executeCommand('session-1', 'npm install && npm run dev');

    const commands = runActionCommand.mock.calls.map(([command]) => command);
    expect(commands).not.toContain('npm install && npm run dev');
    expect(commands.at(-1)).toBe('npm run dev');
    expect(commands[0]).toBe('npm install --ignore-scripts');
    expect(commands.some((command) => command.includes('fs.cpSync'))).toBe(true);
  });

  it('shows the executed pipeline in the terminal output, not the original command', async () => {
    const { runtime, runActionCommand } = createRuntime({ stdout: 'ok', stderr: '', exitCode: 0 });

    const shell = createNexariActionShell(runtime);
    const { output } = (await shell.executeCommand('session-1', 'pnpm install'))!;

    expect(output).toContain('npm install --ignore-scripts');
    expect(output).toContain('esbuild@0.28.2 @rollup/wasm-node');
    expect(output).toContain('$ npm install --no-save --ignore-scripts esbuild@0.28.2 @rollup/wasm-node');
    expect(output).not.toContain('pnpm install\n');
    expect(runActionCommand).toHaveBeenCalledTimes(3);
  });

  it('stops at the first failing step and returns that step exit code', async () => {
    const { runtime, runActionCommand } = createRuntime({ stdout: '', stderr: '', exitCode: 0 });
    (runActionCommand as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: 'boom', exitCode: 37 });

    const shell = createNexariActionShell(runtime);
    const result = (await shell.executeCommand('session-1', 'npm run dev'))!;
    expect(result.output).toContain('boom');
    expect(result.output).toContain('step failed with exit code 37');
    expect(runActionCommand).toHaveBeenCalledTimes(2);
  });

  it('propagates the caller abort signal to every pipeline step', async () => {
    const { runtime, runActionCommand } = createRuntime({ stdout: '', stderr: '', exitCode: 0 });
    const controller = new AbortController();

    const shell = createNexariActionShell(runtime);
    await shell.executeCommand('session-1', 'npm run dev', undefined, controller.signal);

    for (const call of runActionCommand.mock.calls) {
      expect(call[1]).toBe(controller.signal);
    }
  });

  it('refuses to start a pipeline step after the signal is already aborted', async () => {
    const { runtime, runActionCommand } = createRuntime({ stdout: '', stderr: '', exitCode: 0 });
    const controller = new AbortController();
    controller.abort();

    const shell = createNexariActionShell(runtime);
    await expect(shell.executeCommand('session-1', 'npm run dev', undefined, controller.signal)).rejects.toThrow(
      'Nexari action command aborted.',
    );
    expect(runActionCommand).not.toHaveBeenCalled();
  });

  it('leaves non-project commands untouched on the raw lane', async () => {
    const { runtime, runActionCommand } = createRuntime({ stdout: 'out', stderr: '', exitCode: 0 });

    const shell = createNexariActionShell(runtime);
    await shell.executeCommand('session-1', 'cat package.json');

    expect(runActionCommand).toHaveBeenCalledTimes(1);
    expect(runActionCommand).toHaveBeenCalledWith('cat package.json', undefined);
  });
});
