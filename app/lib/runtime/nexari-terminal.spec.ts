import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import type { ITerminal } from '~/types/terminal';
import {
  MAX_NEXARI_REPL_READINESS_BUFFER,
  NEXARI_REPL_BANNER,
  NexariTerminalSelectionError,
  createNexariTerminalSession,
} from './nexari-terminal';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

function terminalHarness() {
  let onData: ((data: string) => void) | undefined;
  const terminal: ITerminal = {
    write: vi.fn(),
    reset: vi.fn(),
    input: vi.fn(),
    onData: vi.fn((callback) => {
      onData = callback;
    }),
  };

  return { terminal, input: (data: string) => onData?.(data) };
}

function facadeWithProcess(process: {
  input: WritableStream<string>;
  output: ReadableStream<string>;
  exit: Promise<number>;
  kill(): void;
}) {
  return {
    state: 'ready',
    fs: {},
    boot: vi.fn(),
    teardown: vi.fn(),
    runActionCommand: vi.fn(),
    spawn: vi.fn().mockResolvedValue(process),
  };
}

describe('createNexariTerminalSession', () => {
  it('AC-1/AC-2: spawns uncapped sh, accumulates a split readiness gate, then forwards terminal input', async () => {
    const writes: string[] = [];
    const output = new TransformStream<string, string>();
    const exit = deferred<number>();
    const process = {
      input: new WritableStream<string>({
        write: (data) => {
          writes.push(data);
        },
      }),
      output: output.readable,
      exit: exit.promise,
      kill: vi.fn(),
    };
    const facade = facadeWithProcess(process);
    const { terminal, input } = terminalHarness();

    const attaching = createNexariTerminalSession(Promise.resolve(facade), terminal);
    await vi.waitFor(() => expect(facade.spawn).toHaveBeenCalledWith('sh', []));
    input('before-ready\n');
    expect(writes).toEqual([]);

    const writer = output.writable.getWriter();
    await writer.write(NEXARI_REPL_BANNER.slice(0, 12));
    await writer.write(NEXARI_REPL_BANNER.slice(12));
    input('still-not-ready\n');
    expect(writes).toEqual([]);
    await writer.write('\u001b[32m/ ❯ ');

    const session = await attaching;
    input('echo ready\n');
    await vi.waitFor(() => expect(writes).toEqual(['echo ready\n']));
    expect(terminal.write).toHaveBeenCalledWith(NEXARI_REPL_BANNER.slice(0, 12));
    expect(terminal.write).toHaveBeenCalledWith('\u001b[32m/ ❯ ');
    session.resize({ cols: 120, rows: 40 });
    expect(process.kill).not.toHaveBeenCalled();
  });

  it('AC-4: fails closed when the REPL exits before readiness and leaves input inert', async () => {
    const writes: string[] = [];
    const process = {
      input: new WritableStream<string>({
        write: (data) => {
          writes.push(data);
        },
      }),
      output: new ReadableStream<string>({ start: (controller) => controller.close() }),
      exit: Promise.resolve(0),
      kill: vi.fn(),
    };
    const { terminal, input } = terminalHarness();

    await expect(createNexariTerminalSession(Promise.resolve(facadeWithProcess(process)), terminal)).rejects.toThrow(
      'stopped before becoming ready',
    );
    input('late\n');
    expect(writes).toEqual([]);
  });

  it('AC-4: kills and makes the session inert when reading guest output fails', async () => {
    const writes: string[] = [];
    const failure = new Error('guest output failed');
    const process = {
      input: new WritableStream<string>({ write: (data) => void writes.push(data) }),
      output: new ReadableStream<string>({ start: (controller) => controller.error(failure) }),
      exit: new Promise<number>(() => undefined),
      kill: vi.fn(),
    };
    const { terminal, input } = terminalHarness();

    await expect(createNexariTerminalSession(Promise.resolve(facadeWithProcess(process)), terminal)).rejects.toBe(
      failure,
    );
    input('late\n');

    expect(process.kill).toHaveBeenCalledOnce();
    expect(writes).toEqual([]);
  });

  it('AC-3: fails closed rather than retaining unbounded output before REPL readiness', async () => {
    const writes: string[] = [];
    let emit!: (value: string) => void;
    const process = {
      input: new WritableStream<string>({ write: (data) => void writes.push(data) }),
      output: new ReadableStream<string>({
        start: (controller) => {
          emit = (value) => controller.enqueue(value);
        },
      }),
      exit: new Promise<number>(() => undefined),
      kill: vi.fn(),
    };
    const { terminal, input } = terminalHarness();
    const attaching = createNexariTerminalSession(Promise.resolve(facadeWithProcess(process)), terminal);

    emit('x'.repeat(MAX_NEXARI_REPL_READINESS_BUFFER + 1));

    await expect(attaching).rejects.toThrow('exceeded the readiness output limit');
    input('late\n');

    expect(process.kill).toHaveBeenCalledOnce();
    expect(writes).toEqual([]);
  });

  it('AC-4: rejects a malformed runtime without spawning or falling back', async () => {
    const { terminal } = terminalHarness();

    await expect(createNexariTerminalSession(Promise.resolve({}), terminal)).rejects.toBeInstanceOf(
      NexariTerminalSelectionError,
    );
  });

  it('AC-3: contains no JSH or OSC 654 protocol dependency', async () => {
    const source = await readFile(new URL('./nexari-terminal.ts', import.meta.url), 'utf8');

    expect(source).not.toMatch(/\/bin\/jsh|\\x1b\\]654|OSC 654/);
  });
});
