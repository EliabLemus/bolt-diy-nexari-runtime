/**
 * Runtime-agnostic shell seam for Bolt's action pipeline.
 *
 * The action pipeline (`ActionRunner` #runShellAction/#runStartAction) must run
 * over either backend without changing the StackBlitz control path's observable
 * behavior. The seam keeps BoltShell's historical semantics:
 *
 * - `executeCommand` resolves with the historical `ExecutionResult` shape
 *   (`{ output, exitCode } | undefined`, output already ANSI/OSC-cleaned for
 *   the StackBlitz lane).
 * - the third argument is BoltShell's preemption callback slot, passed through
 *   unmodified on the StackBlitz lane.
 * - `assertRunnable` preserves the historical guard ordering and the exact
 *   `Unreachable: Shell terminal not found` failure before any command runs.
 *
 * The Nexari lane (see `nexari-action-shell.ts`) adapts its `sh -c` action
 * execution onto the same contract; caller cancellation is carried by the
 * separate fourth `signal` argument so the preemption slot stays untouched.
 */

/**
 * Historical `ExecutionResult` contract from `~/utils/shell`, redeclared
 * structurally so this seam module needs no `@webcontainer/api`-adjacent
 * import and stays backend-neutral.
 */
export interface ActionShellExecutionResult {
  output: string;
  exitCode: number;
}

export type ActionShellPreemptCallback = () => void;

export interface ActionShell {
  /**
   * Resolve once the shell can accept a command, awaiting backend readiness
   * first; throw the backend's typed error when it cannot (StackBlitz:
   * ready-await then terminal/process guards — the historical runner order;
   * Nexari: fail-closed until boot completes, terminated-state rejected with
   * the typed terminated marker).
   *
   * Implementations must be stateless and safe to construct per call: the
   * workbench allocates a fresh adapter for every shell/start action.
   */
  assertRunnable(): Promise<void>;

  /**
   * Run a command and resolve with its cleaned merged output and exit code.
   * `preempt` keeps the BoltShell callback slot semantics; `signal` is the
   * caller-cancellation lane used by the Nexari adapter.
   */
  executeCommand(
    sessionId: string,
    command: string,
    preempt?: () => void,
    signal?: AbortSignal,
  ): Promise<ActionShellExecutionResult | undefined>;
}
