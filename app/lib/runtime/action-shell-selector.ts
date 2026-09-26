import type { RuntimeBackend } from './runtime-selector';
import type { ActionShell } from './action-shell';
import { createStackblitzActionShell } from './stackblitz-action-shell';
import { createNexariActionShell } from './nexari-action-shell';
import { isNexariFacade } from './nexari-surface';
import type { NexariBrowserRuntime } from './nexari-runtime-facade';
import type { BoltShell } from '~/utils/shell';

/**
 * Backend-aware selection of the ActionShell implementation for Bolt's action
 * pipeline. The factory stays synchronous and stateless: ActionRunner invokes
 * it per action (`action-runner.ts`) and each branch immediately returns the
 * corresponding adapter. The runtime promise is only ever touched on the
 * nexari branch — the StackBlitz control path keeps its exact historical
 * behavior (BoltShell readiness, guard ordering, no promise interaction), so a
 * StackBlitz boot failure cannot become a new unhandled rejection here.
 *
 * On the nexari path the resolved runtime is verified structurally before
 * delegation: the workbench's runtime promise must resolve to the
 * NexariBrowserRuntime facade. Anything else (a real WebContainer, a malformed
 * boot result) fails closed with a typed error, and a rejected promise
 * propagates its original rejection — never a silent fallback to another
 * backend.
 */
export class NexariActionShellSelectionError extends Error {
  constructor() {
    super('Nexari action shell selected but the runtime promise did not resolve to the Nexari facade.');
    this.name = 'NexariActionShellSelectionError';
  }
}

/*
 * The facade predicate lives in `nexari-surface.ts`, shared with the
 * action-runner and files-store selectors so every consumer verifies the
 * same facade shape. The shared predicate additionally requires the `fs`
 * object and `spawn` function; both are present on every real facade, so
 * acceptance is unchanged while filesystem consumers stay covered.
 */

async function resolveNexariFacade(runtimePromise: Promise<unknown>): Promise<NexariBrowserRuntime> {
  const resolved = await runtimePromise;

  if (!isNexariFacade(resolved)) {
    throw new NexariActionShellSelectionError();
  }

  return resolved;
}

export function createActionShell(
  backend: RuntimeBackend,
  boltTerminal: BoltShell,
  runtimePromise: Promise<unknown>,
): ActionShell {
  if (backend === 'stackblitz') {
    return createStackblitzActionShell(boltTerminal);
  }

  return {
    async assertRunnable() {
      const nexariShell = createNexariActionShell(await resolveNexariFacade(runtimePromise));

      await nexariShell.assertRunnable();
    },

    async executeCommand(sessionId, command, preempt, signal) {
      const nexariShell = createNexariActionShell(await resolveNexariFacade(runtimePromise));

      return nexariShell.executeCommand(sessionId, command, preempt, signal);
    },
  };
}
