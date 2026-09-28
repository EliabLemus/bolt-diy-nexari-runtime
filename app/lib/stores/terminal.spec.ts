import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ITerminal } from '~/types/terminal';

const mocks = vi.hoisted(() => ({
  createNexariTerminalSession: vi.fn(),
  newShellProcess: vi.fn(),
  newBoltShellProcess: vi.fn(),
}));

vi.mock('~/lib/runtime/nexari-terminal', () => ({
  createNexariTerminalSession: mocks.createNexariTerminalSession,
}));

vi.mock('~/utils/shell', () => ({
  newShellProcess: mocks.newShellProcess,
  newBoltShellProcess: mocks.newBoltShellProcess,
}));

import { TerminalStore } from './terminal';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });

  return { promise, resolve };
}

function terminalHarness(): ITerminal {
  return {
    write: vi.fn(),
    reset: vi.fn(),
    input: vi.fn(),
    onData: vi.fn(),
  };
}

describe('TerminalStore runtime selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('AC-1: attaches the nexari sh session without touching either StackBlitz shell mechanism', async () => {
    const session = { kill: vi.fn(), resize: vi.fn() };
    mocks.createNexariTerminalSession.mockResolvedValue(session);
    mocks.newBoltShellProcess.mockReturnValue({ init: vi.fn() });

    const runtime = Promise.resolve({});
    const store = new TerminalStore('nexari', runtime);
    const terminal = terminalHarness();

    await store.attachTerminal(terminal);
    await store.attachBoltTerminal(terminal);

    expect(mocks.createNexariTerminalSession).toHaveBeenCalledTimes(2);
    expect(mocks.createNexariTerminalSession).toHaveBeenNthCalledWith(1, runtime, terminal);
    expect(mocks.newShellProcess).not.toHaveBeenCalled();
    expect(mocks.newBoltShellProcess).toHaveBeenCalledOnce();
  });

  it('AC-2/AC-3: makes a failed nexari attach visible and a detached session inert', async () => {
    const failure = new Error('guest boot failed');
    mocks.createNexariTerminalSession.mockRejectedValue(failure);
    mocks.newBoltShellProcess.mockReturnValue({ init: vi.fn() });

    const store = new TerminalStore('nexari', Promise.resolve({}));
    const terminal = terminalHarness();

    await store.attachTerminal(terminal);
    await store.detachTerminal(terminal);

    expect(terminal.write).toHaveBeenCalledWith(expect.stringContaining('Failed to spawn nexari shell'));
    expect(terminal.write).toHaveBeenCalledWith(expect.stringContaining(failure.message));

    const session = { kill: vi.fn(), resize: vi.fn() };
    mocks.createNexariTerminalSession.mockResolvedValue(session);
    await store.attachTerminal(terminal);
    await store.detachTerminal(terminal);
    await store.detachTerminal(terminal);
    store.onTerminalResize(120, 40);

    expect(session.kill).toHaveBeenCalledOnce();
    expect(session.resize).not.toHaveBeenCalled();
  });

  it('AC-3: disposes every live session exactly once for a module replacement', async () => {
    const first = { kill: vi.fn(), resize: vi.fn() };
    const second = { kill: vi.fn(), resize: vi.fn() };
    mocks.createNexariTerminalSession.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    mocks.newBoltShellProcess.mockReturnValue({ init: vi.fn() });

    const store = new TerminalStore('nexari', Promise.resolve({}));

    await store.attachTerminal(terminalHarness());
    await store.attachTerminal(terminalHarness());
    store.dispose();
    store.dispose();
    store.onTerminalResize(120, 40);

    expect(first.kill).toHaveBeenCalledOnce();
    expect(second.kill).toHaveBeenCalledOnce();
    expect(first.resize).not.toHaveBeenCalled();
    expect(second.resize).not.toHaveBeenCalled();
  });

  it('AC-3: kills a nexari session that resolves after its terminal was detached', async () => {
    const pending = deferred<{ kill(): void; resize(dimensions: { cols: number; rows: number }): void }>();
    mocks.createNexariTerminalSession.mockReturnValue(pending.promise);
    mocks.newBoltShellProcess.mockReturnValue({ init: vi.fn() });

    const store = new TerminalStore('nexari', Promise.resolve({}));
    const terminal = terminalHarness();

    const attaching = store.attachTerminal(terminal);
    await vi.waitFor(() => expect(mocks.createNexariTerminalSession).toHaveBeenCalledOnce());
    await store.detachTerminal(terminal);

    const lateSession = { kill: vi.fn(), resize: vi.fn() };
    pending.resolve(lateSession);
    await attaching;
    store.onTerminalResize(120, 40);

    expect(lateSession.kill).toHaveBeenCalledOnce();
    expect(lateSession.resize).not.toHaveBeenCalled();
  });

  it('AC-4: preserves the StackBlitz control lane', async () => {
    const shellProcess = { kill: vi.fn(), resize: vi.fn() };
    const boltTerminal = { init: vi.fn() };
    mocks.newShellProcess.mockResolvedValue(shellProcess);
    mocks.newBoltShellProcess.mockReturnValue(boltTerminal);

    const runtime = Promise.resolve({ webcontainer: true });
    const store = new TerminalStore('stackblitz', runtime);
    const terminal = terminalHarness();

    await store.attachTerminal(terminal);
    await store.attachBoltTerminal(terminal);

    expect(mocks.newShellProcess).toHaveBeenCalledWith(await runtime, terminal);
    expect(boltTerminal.init).toHaveBeenCalledWith(await runtime, terminal);
    expect(mocks.createNexariTerminalSession).not.toHaveBeenCalled();
  });
});
