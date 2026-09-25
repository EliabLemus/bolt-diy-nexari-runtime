import type { ActionShell } from './action-shell';
import { NexariRuntimeTerminatedError } from './nexari-runtime';
import type { NexariBrowserRuntime } from './nexari-runtime-facade';

/**
 * Nexari adapter over the facade's `sh -c` action-execution lane
 * (`runActionCommand`). Composition rule for the historical merged-output
 * contract: cleaned-stderr semantics do not exist on this lane, so output is
 * `stdout` with `stderr` appended after a newline only when stderr is
 * non-empty. Exit-code passthrough is exact (including 0 and non-zero);
 * failures (not-ready, terminated, caller abort, teardown-mid-command)
 * propagate typed.
 */
export function createNexariActionShell(runtime: NexariBrowserRuntime): ActionShell {
  return {
    async assertRunnable() {
      if (runtime.state === 'terminated') {
        throw new NexariRuntimeTerminatedError();
      }

      if (runtime.state !== 'ready') {
        throw new Error('Nexari runtime has not completed booting.');
      }
    },

    async executeCommand(sessionId, command, _preempt, signal) {
      void sessionId;

      await this.assertRunnable();

      const result = await runtime.runActionCommand(command, signal);

      const output = result.stderr.length > 0 ? `${result.stdout}\n${result.stderr}` : result.stdout;

      return { output, exitCode: result.exitCode };
    },
  };
}
