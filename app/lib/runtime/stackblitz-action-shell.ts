import type { ActionShell } from './action-shell';
import type { BoltShell } from '~/utils/shell';

/**
 * StackBlitz adapter over the historical `BoltShell`. Pure passthrough: every
 * observable behavior (readiness await, guard ordering and message, argument
 * triple, `ExecutionResult` passthrough including `undefined` and `NaN`
 * exit codes, `executionState` atom ownership) stays in BoltShell itself.
 */
export function createStackblitzActionShell(shell: BoltShell): ActionShell {
  return {
    async assertRunnable() {
      await shell.ready();

      if (!shell.terminal || !shell.process) {
        throw new Error('Unreachable: Shell terminal not found');
      }
    },

    async executeCommand(sessionId, command, preempt, _signal) {
      await this.assertRunnable();

      /*
       * Accepted race classification (Challenger finding, NEXARI-SEAM-002): a
       * terminal detach between the runner's outer guard and this post-ready
       * guard rejects with the exact Unreachable error, whereas the legacy
       * single-guard path would fall through to BoltShell's undefined result
       * and a generic ActionCommandError. The loud rejection is deliberate;
       * any detach after this guard still surfaces as the legacy undefined
       * result via BoltShell's own check.
       */
      return shell.executeCommand(sessionId, command, preempt);
    },
  };
}
