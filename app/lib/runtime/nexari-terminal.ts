import type { ITerminal } from '~/types/terminal';
import type { NexariBrowserRuntime } from './nexari-runtime-facade';
import { isNexariFacade } from './nexari-surface';

/** The clean-room REPL banner defined by the pinned Nexari terminal contract. */
export const NEXARI_REPL_BANNER = 'Vivari shell — type commands, Enter to run.\n';

export class NexariTerminalSelectionError extends Error {
  constructor() {
    super('Nexari terminal selected but the runtime promise did not resolve to the Nexari facade.');
    this.name = 'NexariTerminalSelectionError';
  }
}

export interface TerminalSession {
  kill(): void;
  resize(dimensions: { cols: number; rows: number }): void;
}

function resolveNexariFacade(runtime: unknown): NexariBrowserRuntime {
  if (!isNexariFacade(runtime)) {
    throw new NexariTerminalSelectionError();
  }

  return runtime;
}

/**
 * Attach Bolt's terminal UI to Nexari's interactive `sh` lane. This is not the
 * action lane: action commands remain on `runActionCommand` through ActionShell.
 * The REPL uses a clean-room protocol: readiness is the accumulated banner
 * followed by a prompt marker, which remains safe when stream chunks split it.
 */
export async function createNexariTerminalSession(
  runtimePromise: Promise<unknown>,
  terminal: ITerminal,
): Promise<TerminalSession> {
  const runtime = resolveNexariFacade(await runtimePromise);
  const process = await runtime.spawn('sh', []);
  const reader = process.output.getReader();
  const writer = process.input.getWriter();
  let active = true;
  let ready = false;
  let output = '';
  let settleReady!: () => void;
  let rejectReady!: (reason: unknown) => void;
  const readyPromise = new Promise<void>((resolve, reject) => {
    settleReady = resolve;
    rejectReady = reject;
  });

  const stop = () => {
    if (!active) {
      return;
    }

    active = false;
    void reader.cancel().catch(() => undefined);

    try {
      writer.releaseLock();
    } catch {
      // The writer was already released by a terminal/guest shutdown.
    }

    try {
      process.kill();
    } catch {
      // A terminated guest makes the terminal session inert.
    }
  };

  const failBeforeReady = (reason: unknown) => {
    if (!ready) {
      rejectReady(reason);
    }
  };

  void (async () => {
    try {
      while (active) {
        const { done, value } = await reader.read();

        if (done) {
          failBeforeReady(new Error('Nexari interactive shell stopped before becoming ready.'));
          stop();

          return;
        }

        if (!active || value === undefined) {
          continue;
        }

        terminal.write(value);
        output += value;

        const bannerAt = output.indexOf(NEXARI_REPL_BANNER);

        if (bannerAt !== -1 && /❯/.test(output.slice(bannerAt + NEXARI_REPL_BANNER.length))) {
          ready = true;
          settleReady();
        }
      }
    } catch (error) {
      failBeforeReady(error);
      stop();
    }
  })();

  void process.exit.then(
    () => {
      failBeforeReady(new Error('Nexari interactive shell stopped before becoming ready.'));
      stop();
    },
    (error) => {
      failBeforeReady(error);
      stop();
    },
  );

  terminal.onData((data) => {
    if (!active || !ready) {
      return;
    }

    void writer.write(data).catch(stop);
  });

  await readyPromise;

  return {
    kill: stop,

    // The clean-room REPL is intentionally uncapped; terminal resize is inert.
    resize: () => undefined,
  };
}
