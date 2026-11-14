import { describe, expect, it, vi } from 'vitest';
import { createNexariRuntime, NexariRuntimeTerminatedError } from './nexari-runtime';
import { createNexariActionShell, rewriteWasmSafeCommand } from './nexari-action-shell';
import { createNexariBrowserRuntime, type NexariBrowserRuntime } from './nexari-runtime-facade';

function createRuntime(result: { stdout: string; stderr: string; exitCode: number }) {
  const runActionCommand = vi.fn().mockResolvedValue(result);
  const runActionCommandStreaming = vi
    .fn()
    .mockImplementation(
      async (
        _command: string,
        _signal: AbortSignal | undefined,
        onChunk: (chunk: string, stream: 'stdout' | 'stderr') => void,
      ) => {
        if (result.stdout.length > 0) {
          onChunk(result.stdout, 'stdout');
        }

        if (result.stderr.length > 0) {
          onChunk(result.stderr, 'stderr');
        }

        return result;
      },
    );
  const runtime = {
    state: 'ready',
    workdir: '/project',
    fs: {},
    boot: vi.fn(),
    spawn: vi.fn(),
    runActionCommand,
    runActionCommandStreaming,
    on: vi.fn(),
    setPreviewScript: vi.fn(),
    internal: { watchPaths: vi.fn() },
    teardown: vi.fn(),
  } as unknown as NexariBrowserRuntime & {
    runActionCommand: ReturnType<typeof vi.fn>;
    runActionCommandStreaming: ReturnType<typeof vi.fn>;
  };

  return { runtime, runActionCommand, runActionCommandStreaming };
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
  it('maps bare install to the full install pipeline (install + wasm builds + rollup swap + esbuild swap)', () => {
    expect(rewriteWasmSafeCommand('npm install')).toEqual([
      'npm install --ignore-scripts --prefer-offline --no-audit --no-fund',
      'npm install --no-save --ignore-scripts esbuild-wasm@0.28.2 @rollup/wasm-node',
      expect.stringContaining('fs.cpSync'),
      expect.stringContaining('fs.cpSync'),
    ]);
  });

  it('discards model flags: install variants normalize to the exact same pipeline', () => {
    expect(rewriteWasmSafeCommand('npm install --legacy-peer-deps')).toEqual(rewriteWasmSafeCommand('npm install'));
    expect(rewriteWasmSafeCommand('npm ci')).toEqual(rewriteWasmSafeCommand('npm install'));
    expect(rewriteWasmSafeCommand('  npm   install  ')).toEqual(rewriteWasmSafeCommand('npm install'));
  });

  it('maps dev, build and preview to the full 5-step start pipeline (install + wasm builds + rollup swap + esbuild swap + npm run X)', () => {
    const pipeline = rewriteWasmSafeCommand('npm run dev');
    expect(pipeline).toEqual([
      'npm install --ignore-scripts --prefer-offline --no-audit --no-fund',
      'npm install --no-save --ignore-scripts esbuild-wasm@0.28.2 @rollup/wasm-node',
      expect.stringContaining('fs.cpSync'),
      expect.stringContaining('fs.cpSync'),
      'npm run dev',
    ]);
    expect(rewriteWasmSafeCommand('npm run build')?.at(-1)).toBe('npm run build');
    expect(rewriteWasmSafeCommand('npm run preview')?.at(-1)).toBe('npm run preview');
  });

  it('preserves flags after `--` on the final run step', () => {
    const pipeline = rewriteWasmSafeCommand('npm run dev -- --host 0.0.0.0');
    expect(pipeline?.slice(0, 4)).toEqual(rewriteWasmSafeCommand('npm run dev')!.slice(0, 4));
    expect(pipeline?.at(-1)).toBe('npm run dev -- --host 0.0.0.0');
  });

  it('keeps requested packages on package installs, without extra esbuild/rollup', () => {
    expect(rewriteWasmSafeCommand('npm install lodash axios')).toEqual([
      'npm install --ignore-scripts --no-save lodash axios',
    ]);

    // esbuild/@rollup/wasm-node are already brought by the wasm rebuild step.
    expect(rewriteWasmSafeCommand('npm install esbuild @rollup/wasm-node')).toEqual([
      'npm install --ignore-scripts --prefer-offline --no-audit --no-fund',
      'npm install --no-save --ignore-scripts esbuild-wasm@0.28.2 @rollup/wasm-node',
      expect.stringContaining('fs.cpSync'),
      expect.stringContaining('fs.cpSync'),
    ]);
  });

  it('adds the wasm builds + rollup swap when a native-binary bundler is installed', () => {
    const pipeline = rewriteWasmSafeCommand('npm install vite@7.1.0');
    expect(pipeline).toEqual([
      'npm install --ignore-scripts --no-save vite@7.1.0',
      'npm install --no-save --ignore-scripts esbuild-wasm@0.28.2 @rollup/wasm-node',
      expect.stringContaining('fs.cpSync'),
      expect.stringContaining('fs.cpSync'),
    ]);
    expect(rewriteWasmSafeCommand('npm install webpack')?.length).toBe(4);
    expect(rewriteWasmSafeCommand('npm install lodash')?.length).toBe(1);
  });

  it('maps the compound model command to the dev pipeline', () => {
    expect(rewriteWasmSafeCommand('npm install && npm run dev')).toEqual(rewriteWasmSafeCommand('npm run dev'));
  });

  it('rewrites every part of a compound command by its own type', () => {
    const pipeline = rewriteWasmSafeCommand('npm run build && npm run preview');
    expect(pipeline).toEqual([...rewriteWasmSafeCommand('npm run build')!, 'npm run preview']);
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
    expect(rewriteWasmSafeCommand('yarn dev')).toBeNull();
  });
});

describe('createNexariActionShell wasm-safe rewriting', () => {
  it('never sends a project command raw: the rewritten pipeline runs step by step', async () => {
    const { runtime, runActionCommandStreaming } = createRuntime({ stdout: 'ok', stderr: '', exitCode: 0 });

    /*
     * The final dev step runs detached: the spawn lane hosts the never-exiting
     * server, and readiness resolves through the (mocked) server-ready lane.
     */
    const spawn = vi.fn().mockImplementation(async () => {
      const listeners: Array<() => void> = [];
      const output = new ReadableStream<string>({
        start(controller) {
          controller.enqueue('VITE ready in 300 ms\n');
          controller.close();
        },
      });

      return {
        input: new WritableStream<string>(),
        output,
        exit: new Promise<number>(() => undefined), // a serving dev server never exits
        kill: () => listeners.splice(0).forEach((listener) => listener()),
      };
    });
    (runtime as unknown as { spawn: unknown }).spawn = spawn;

    // The facade fires 'server-ready' once the guest lane reports the server.
    (runtime.on as ReturnType<typeof vi.fn>).mockImplementation((event: string, callback: () => void) => {
      if (event === 'server-ready') {
        setTimeout(callback, 0);
      }

      return () => undefined;
    });

    const shell = createNexariActionShell(runtime);
    const { exitCode } = (await shell.executeCommand('session-1', 'npm install && npm run dev'))!;

    const commands = runActionCommandStreaming.mock.calls.map(([command]) => command);
    expect(commands).not.toContain('npm install && npm run dev');
    expect(commands[0]).toBe('npm install --ignore-scripts --prefer-offline --no-audit --no-fund');
    expect(commands[1]).toBe('npm install --no-save --ignore-scripts esbuild-wasm@0.28.2 @rollup/wasm-node');
    expect(commands.some((command) => command.includes('fs.cpSync'))).toBe(true);

    // The never-exiting dev server step goes through the detached spawn lane, not exit-joining runActionCommand.
    expect(commands).not.toContain('npm run dev');
    expect(spawn).toHaveBeenCalledWith('sh', ['-c', 'npm run dev'], expect.objectContaining({ signal: undefined }));
    expect(exitCode).toBe(0);
  });

  it('resolves a slow-starting server step on server-ready without waiting for process exit', async () => {
    const { runtime } = createRuntime({ stdout: '', stderr: '', exitCode: 0 });

    let serverReady: (() => void) | undefined;
    (runtime.on as ReturnType<typeof vi.fn>).mockImplementation((event: string, callback: () => void) => {
      if (event === 'server-ready') {
        serverReady = callback;
      }

      return () => undefined;
    });

    (runtime as unknown as { spawn: unknown }).spawn = vi.fn().mockImplementation(async () => ({
      input: new WritableStream<string>(),
      output: new ReadableStream<string>({ start: (controller) => controller.close() }),
      exit: new Promise<number>(() => undefined),
      kill: () => undefined,
    }));

    const shell = createNexariActionShell(runtime);
    const pending = shell.executeCommand('session-1', 'npm run dev');

    // The action stays pending (never exits) until the guest reports readiness.
    let raced = false;
    void pending.then(() => (raced = true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(raced).toBe(false);

    serverReady!();
    await expect(pending).resolves.toEqual(expect.objectContaining({ exitCode: 0 }));
  });
  it('regression S10: a process that exits never settles the server step (resolution only via server-ready)', async () => {
    const { runtime } = createRuntime({ stdout: '', stderr: '', exitCode: 0 });

    let serverReady: (() => void) | undefined;
    (runtime.on as ReturnType<typeof vi.fn>).mockImplementation((event: string, callback: () => void) => {
      if (event === 'server-ready') {
        serverReady = callback;
      }

      return () => undefined;
    });

    /*
     * The forbidden shape: the process exits immediately (exit resolves with
     * its real code) while the output stream stays open and never prints a
     * ready line. No process.exit branch may resolve the step — it must stay
     * pending until server-ready arrives.
     */
    (runtime as unknown as { spawn: unknown }).spawn = vi.fn().mockImplementation(async () => ({
      input: new WritableStream<string>(),
      output: new ReadableStream<string>(), // never closes, no ready pattern
      exit: Promise.resolve(37),
      kill: () => undefined,
    }));

    const shell = createNexariActionShell(runtime);
    const pending = shell.executeCommand('session-1', 'npm run dev');

    let settledByExit = false;
    void pending.then(() => (settledByExit = true));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settledByExit).toBe(false);

    serverReady!();
    await expect(pending).resolves.toEqual(expect.objectContaining({ exitCode: 0 }));
  });

  it('regression T06/S11: action output streams into the visible terminal sink before the step settles', async () => {
    const { runtime } = createRuntime({ stdout: '', stderr: '', exitCode: 0 });

    const seen: string[] = [];
    (runtime.on as ReturnType<typeof vi.fn>).mockImplementation(() => () => undefined);

    /*
     * The server prints its ready banner and keeps running (exit pending).
     * The sink must already carry the executed step and the banner — the
     * visible terminal must not wait for the process to exit.
     */
    (runtime as unknown as { spawn: unknown }).spawn = vi.fn().mockImplementation(async () => ({
      input: new WritableStream<string>(),
      output: new ReadableStream<string>({
        start(controller) {
          controller.enqueue('VITE ready in 300 ms\nLocal: http://localhost:5173/\n');
        },
      }),
      exit: new Promise<number>(() => undefined),
      kill: () => undefined,
    }));

    const shell = createNexariActionShell(runtime, (chunk) => seen.push(chunk));
    void shell.executeCommand('session-1', 'npm run dev');

    await new Promise((resolve) => setTimeout(resolve, 30));
    await shell.assertRunnable();

    expect(seen.join('')).toContain('$ npm run dev');
    expect(seen.join('')).toContain('VITE ready in 300 ms');
  });

  it('shows the executed pipeline in the terminal output, not the original command', async () => {
    const { runtime, runActionCommandStreaming } = createRuntime({ stdout: 'ok', stderr: '', exitCode: 0 });

    const shell = createNexariActionShell(runtime);
    const { output } = (await shell.executeCommand('session-1', 'pnpm install'))!;

    expect(output).toContain('npm install --ignore-scripts --prefer-offline --no-audit --no-fund');
    expect(output).toContain('esbuild-wasm@0.28.2 @rollup/wasm-node');
    expect(output).toContain('$ npm install --no-save --ignore-scripts esbuild-wasm@0.28.2 @rollup/wasm-node');
    expect(output).not.toContain('pnpm install\n');
    expect(runActionCommandStreaming).toHaveBeenCalledTimes(4);
  });

  it('stops at the first failing step and returns that step exit code', async () => {
    const { runtime, runActionCommandStreaming } = createRuntime({ stdout: '', stderr: '', exitCode: 0 });
    (runActionCommandStreaming as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: 'boom', exitCode: 37 });

    const shell = createNexariActionShell(runtime);
    const result = (await shell.executeCommand('session-1', 'npm run dev'))!;
    expect(result.output).toContain('boom');
    expect(result.output).toContain('step failed with exit code 37');
    expect(result.exitCode).toBe(37);
    expect(runActionCommandStreaming).toHaveBeenCalledTimes(2);
  });

  it('captures a crash after the ready line in the result (death output + real exit code)', async () => {
    const { runtime, runActionCommandStreaming } = createRuntime({ stdout: '', stderr: '', exitCode: 0 });

    /*
     * The live failure shape: vite prints its ready banner, then dies at the
     * first transform (native esbuild binary on wasm32). The stream closes and
     * the process exits non-zero moments after `Local:` — the result must carry
     * the death diagnostics instead of the ready line.
     */
    (runtime as unknown as { spawn: unknown }).spawn = vi.fn().mockImplementation(async () => ({
      input: new WritableStream<string>(),
      output: new ReadableStream<string>({
        start(controller) {
          controller.enqueue('VITE v7.1.0  ready in 300 ms\n');
          controller.enqueue('Local: http://localhost:5173/\n');
          controller.enqueue('Error: The package esbuild could not be found / could not be executed\n');
          controller.close();
        },
      }),
      exit: Promise.resolve(1),
      kill: () => undefined,
    }));

    const shell = createNexariActionShell(runtime);
    const result = (await shell.executeCommand('session-1', 'npm run dev'))!;

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Local: http://localhost:5173/');
    expect(result.output).toContain('could not be executed');
    expect(runActionCommandStreaming).toHaveBeenCalledTimes(4);
  });

  it('propagates the caller abort signal to every pipeline step', async () => {
    const { runtime, runActionCommandStreaming } = createRuntime({ stdout: '', stderr: '', exitCode: 0 });
    const controller = new AbortController();

    /*
     * The dev step runs detached on the spawn lane; give the mock a spawn whose
     * process never exits so runServerStep relies on the signal listener.
     */
    (runtime as unknown as { spawn: unknown }).spawn = vi.fn().mockImplementation(async () => ({
      input: new WritableStream<string>(),
      output: new ReadableStream<string>({ start: (c) => c.close() }),
      exit: new Promise<number>(() => undefined),
      kill: () => undefined,
    }));

    // The event lane fires server-ready so runServerStep settles instead of waiting its 30 s fallback.
    (runtime.on as ReturnType<typeof vi.fn>).mockImplementation((event: string, callback: () => void) => {
      if (event === 'server-ready') {
        setTimeout(callback, 0);
      }

      return () => undefined;
    });

    const shell = createNexariActionShell(runtime);
    await shell.executeCommand('session-1', 'npm run dev', undefined, controller.signal);

    for (const call of runActionCommandStreaming.mock.calls) {
      expect(call[1]).toBe(controller.signal);
    }
    expect(runtime.spawn).toHaveBeenCalledWith(
      'sh',
      ['-c', 'npm run dev'],
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it('refuses to start a pipeline step after the signal is already aborted', async () => {
    const { runtime, runActionCommandStreaming } = createRuntime({ stdout: '', stderr: '', exitCode: 0 });
    const controller = new AbortController();
    controller.abort();

    const shell = createNexariActionShell(runtime);
    await expect(shell.executeCommand('session-1', 'npm run dev', undefined, controller.signal)).rejects.toThrow(
      'Nexari action command aborted.',
    );
    expect(runActionCommandStreaming).not.toHaveBeenCalled();
  });

  it('leaves non-project commands untouched on the raw lane', async () => {
    const { runtime, runActionCommand } = createRuntime({ stdout: 'out', stderr: '', exitCode: 0 });

    const shell = createNexariActionShell(runtime);
    await shell.executeCommand('session-1', 'cat package.json');

    expect(runActionCommand).toHaveBeenCalledTimes(1);
    expect(runActionCommand).toHaveBeenCalledWith('cat package.json', undefined);
  });
});

/*
 * E2E regression: the exact live failure shape — an artifact whose shell action
 * is `npm install && npm run dev`, executed against a guest whose preview
 * event lane only appears after boot (late-binding), with a consumer that
 * subscribed before boot. The compound command MUST execute and the action
 * MUST resolve instead of hanging on the never-exiting dev server.
 */
describe('regression: artifact shell action on a guest with a late event lane', () => {
  it('executes the compound command and resolves the dev step on server-ready', async () => {
    const executed: string[] = [];
    const serverReadyListeners: Array<(...args: unknown[]) => void> = [];
    const guest: Record<string, unknown> & { boot: () => Promise<void> } = {
      state: 'ready' as const,
      fs: {} as any,
      boot: async () => {
        // The preview lane appears exactly at boot completion (late binding).
        (guest as { onGuestEvent?: unknown }).onGuestEvent = (
          event: string,
          listener: (...args: unknown[]) => void,
        ) => {
          if (event === 'server-ready') {
            serverReadyListeners.push(listener);
          }

          return () => undefined;
        };
      },
      spawn: async (command: string, args: string[] = []) => {
        executed.push([command, ...args].join(' '));

        return {
          input: new WritableStream<string>(),
          stdout: new ReadableStream<string>({
            start: (c) => {
              c.enqueue('ok');
              c.close();
            },
          }),
          stderr: new ReadableStream<string>({ start: (c) => c.close() }),
          exit: Promise.resolve(0),
          kill: () => undefined,
        };
      },
      teardown: async () => undefined,
    };

    const runtime = createNexariRuntime({
      boot: async () => guest as unknown as import('./nexari-runtime').NexariGuestRuntime,
    });

    // The adapter calls the boot factory, not guest.boot — expose the lane eagerly.
    (guest as { onGuestEvent?: unknown }).onGuestEvent = (event: string, listener: (...args: unknown[]) => void) => {
      if (event === 'server-ready') {
        serverReadyListeners.push(listener);
      }

      return () => undefined;
    };

    const facade = createNexariBrowserRuntime(runtime);

    // A previews-like consumer subscribes BEFORE the lane exists: late-bound.
    const serverReadyEvents: unknown[][] = [];
    facade.on('server-ready', (...args: unknown[]) => serverReadyEvents.push(args));

    // The action-runner's runtime surface boot happens before actions run.
    await facade.boot();

    const shell = createNexariActionShell(facade);
    const pending = shell.executeCommand('runner-1', 'npm install && npm run dev');

    // Give the pipeline time to reach the dev step; fire the lane afterwards.
    await new Promise((resolve) => setTimeout(resolve, 60));

    for (const listener of [...serverReadyListeners]) {
      listener(5173, 'http://localhost:5173');
    }

    const { exitCode } = (await pending)!;

    expect(exitCode).toBe(0);
    expect(executed).toEqual([
      'sh -c npm install --ignore-scripts --prefer-offline --no-audit --no-fund',
      'sh -c npm install --no-save --ignore-scripts esbuild-wasm@0.28.2 @rollup/wasm-node',
      expect.stringContaining('fs.cpSync'),
      expect.stringContaining('fs.cpSync'),
      'sh -c npm run dev',
    ]);
    expect(serverReadyEvents.length).toBeGreaterThan(0);
  });

  it('echoes install chunks to the terminal DURING execution, not after the step resolves', async () => {
    const { runtime, runActionCommandStreaming } = createRuntime({ stdout: '', stderr: '', exitCode: 0 });

    const chunkTimes: number[] = [];
    let resolved = false;
    let release: (() => void) | undefined;

    (runActionCommandStreaming as ReturnType<typeof vi.fn>).mockImplementation(
      async (
        _command: string,
        _signal: AbortSignal | undefined,
        onChunk: (chunk: string, stream: 'stdout' | 'stderr') => void,
      ) => {
        onChunk('adding 42 packages', 'stdout');

        await new Promise<void>((resolve) => (release = resolve));

        return { stdout: 'adding 42 packages', stderr: '', exitCode: 0 };
      },
    );

    const shell = createNexariActionShell(runtime, (chunk) => {
      if (chunk.includes('adding 42 packages')) {
        chunkTimes.push(resolved ? 1 : 0);
      }
    });

    const pending = shell.executeCommand('session-1', 'npm install lodash');
    void pending.then(() => (resolved = true));

    // Chunks arrive while the step is still in flight.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(chunkTimes).toEqual([0]);

    release!();
    await pending;
    expect(resolved).toBe(true);
    expect(chunkTimes).toEqual([0]); // no echo happened after resolution
  });
});

describe('static server commands (injected dev-server step)', () => {
  function createSpawnRuntime() {
    const killed: string[] = [];
    let spawnCount = 0;
    const spawnImpl = async (_cmd: string, _args: string[], _opts?: unknown) => {
      spawnCount += 1;
      const id = `proc-${spawnCount}`;
      return {
        output: new ReadableStream({
          start(controller) {
            controller.enqueue('server listening on 0.0.0.0:5173');
          },
        }),
        exit: new Promise<number>(() => undefined), // long-running server
        kill: () => {
          killed.push(id);
        },
      };
    };
    const runtime = {
      state: 'ready',
      workdir: '/project',
      fs: {},
      boot: vi.fn(),
      spawn: vi.fn().mockImplementation(spawnImpl),
      runActionCommand: vi.fn(),
      runActionCommandStreaming: vi.fn(),
      on: vi.fn(),
      setPreviewScript: vi.fn(),
      internal: { watchPaths: vi.fn() },
      teardown: vi.fn(),
    } as unknown as NexariBrowserRuntime;

    return { runtime, killed };
  }

  it('runs a static server detached and kills the previous instance first', { timeout: 15_000 }, async () => {
    const { runtime, killed } = createSpawnRuntime();

    const shell = createNexariActionShell(runtime);
    const first = await shell.executeCommand('s1', 'python3 -m http.server 5173 --bind 0.0.0.0');
    expect(first?.exitCode).toBe(0);

    const second = await shell.executeCommand('s2', 'python3 -m http.server 5173 --bind 0.0.0.0');
    expect(second?.exitCode).toBe(0);
    // The stale server from the first chat was killed before the new bind.
    expect(killed).toEqual(['proc-1']);
  });
});
