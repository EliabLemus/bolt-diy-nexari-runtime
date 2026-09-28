import type { WebContainer, WebContainerProcess } from '@webcontainer/api';
import { atom, type WritableAtom } from 'nanostores';
import { createNexariTerminalSession, type TerminalSession } from '~/lib/runtime/nexari-terminal';
import type { RuntimeBackend } from '~/lib/runtime/runtime-selector';
import type { ITerminal } from '~/types/terminal';
import { newBoltShellProcess, newShellProcess } from '~/utils/shell';
import { coloredText } from '~/utils/terminal';

export class TerminalStore {
  #runtime: Promise<unknown>;
  #backend: RuntimeBackend;
  #terminals: Array<{ terminal: ITerminal; process: WebContainerProcess | TerminalSession }> = [];
  #terminalGenerations = new Map<ITerminal, number>();
  #boltTerminal = newBoltShellProcess();

  showTerminal: WritableAtom<boolean> = import.meta.hot?.data.showTerminal ?? atom(true);

  constructor(backend: RuntimeBackend, runtimePromise: Promise<unknown>) {
    this.#backend = backend;
    this.#runtime = runtimePromise;

    if (import.meta.hot) {
      import.meta.hot.data.showTerminal = this.showTerminal;
    }
  }
  get boltTerminal() {
    return this.#boltTerminal;
  }

  toggleTerminal(value?: boolean) {
    this.showTerminal.set(value !== undefined ? value : !this.showTerminal.get());
  }
  async attachBoltTerminal(terminal: ITerminal) {
    if (this.#backend === 'nexari') {
      await this._attachNexariTerminal(terminal);
      return;
    }

    try {
      const wc = (await this.#runtime) as WebContainer;
      await this.#boltTerminal.init(wc, terminal);
    } catch (error: any) {
      terminal.write(coloredText.red('Failed to spawn bolt shell\n\n') + error.message);
      return;
    }
  }

  async attachTerminal(terminal: ITerminal) {
    if (this.#backend === 'nexari') {
      await this._attachNexariTerminal(terminal);
      return;
    }

    try {
      const shellProcess = await newShellProcess((await this.#runtime) as WebContainer, terminal);
      this.#terminals.push({ terminal, process: shellProcess });
    } catch (error: any) {
      terminal.write(coloredText.red('Failed to spawn shell\n\n') + error.message);
      return;
    }
  }

  private async _attachNexariTerminal(terminal: ITerminal) {
    let generation: number | undefined;

    try {
      await this.detachTerminal(terminal);
      generation = this.#terminalGenerations.get(terminal);

      const session = await createNexariTerminalSession(this.#runtime, terminal);

      if (generation !== this.#terminalGenerations.get(terminal)) {
        session.kill();

        return;
      }

      this.#terminals.push({ terminal, process: session });
    } catch (error: any) {
      if (generation === this.#terminalGenerations.get(terminal)) {
        terminal.write(coloredText.red('Failed to spawn nexari shell\n\n') + error.message);
      }
    }
  }

  onTerminalResize(cols: number, rows: number) {
    for (const { process } of this.#terminals) {
      process.resize({ cols, rows });
    }
  }

  /**
   * Terminal sessions are owned by this store rather than the runtime cache.
   * Clear the registry before killing so repeated teardown/HMR disposal is
   * idempotent and no stale session receives later resize calls.
   */
  dispose() {
    if (this.#backend !== 'nexari') {
      return;
    }

    const terminals = this.#terminals;
    this.#terminals = [];

    for (const [terminal, generation] of this.#terminalGenerations) {
      this.#terminalGenerations.set(terminal, generation + 1);
    }

    for (const { process } of terminals) {
      try {
        process.kill();
      } catch (error) {
        console.warn('Failed to kill terminal process:', error);
      }
    }
  }

  async detachTerminal(terminal: ITerminal) {
    this.#terminalGenerations.set(terminal, (this.#terminalGenerations.get(terminal) ?? 0) + 1);

    const terminalIndex = this.#terminals.findIndex((t) => t.terminal === terminal);

    if (terminalIndex !== -1) {
      const { process } = this.#terminals[terminalIndex];

      try {
        process.kill();
      } catch (error) {
        console.warn('Failed to kill terminal process:', error);
      }
      this.#terminals.splice(terminalIndex, 1);
    }
  }
}
