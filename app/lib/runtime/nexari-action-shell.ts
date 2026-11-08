import type { ActionShell } from './action-shell';
import { NexariRuntimeTerminatedError } from './nexari-runtime';
import type { NexariBrowserRuntime } from './nexari-runtime-facade';

/**
 * The verified wasm-safe sequence for the vivari guest (wasm32 linux LE):
 * native esbuild/rollup postinstalls fail there, so installs run with
 * `--ignore-scripts`, the wasm builds are added explicitly, and rollup is
 * swapped for `@rollup/wasm-node`. Verified by hand: it boots a real Vite
 * dev server (`VITE ready`) on the guest.
 */
const WASM_SAFE_INSTALL_STEP = 'npm install --ignore-scripts';
const WASM_SAFE_WASM_BUILDS_STEP = 'npm install --no-save --ignore-scripts esbuild@0.28.2 @rollup/wasm-node';
const WASM_SAFE_ROLLUP_SWAP_STEP =
  `node -e "const fs=require('fs'); ` +
  `fs.rmSync('node_modules/rollup',{recursive:true,force:true}); ` +
  `fs.cpSync('node_modules/@rollup/wasm-node','node_modules/rollup',{recursive:true})"`;

const WASM_SAFE_PIPELINE_INSTALL: readonly string[] = [
  WASM_SAFE_INSTALL_STEP,
  WASM_SAFE_WASM_BUILDS_STEP,
  WASM_SAFE_ROLLUP_SWAP_STEP,
];

const WASM_SAFE_PIPELINE_START: readonly string[] = [WASM_SAFE_INSTALL_STEP, WASM_SAFE_ROLLUP_SWAP_STEP];

function normalize(command: string): string {
  return command.trim().replace(/\s+/g, ' ');
}

/**
 * Deterministic mapping from a model-emitted project install/start command to
 * the verified wasm-safe sequence for the vivari guest. Returns the ordered
 * list of shell steps to run, or `null` when the command is not a project
 * install/start command (it then executes raw, untouched).
 *
 * Pure string-mapping only: flags and package-manager variants (`pnpm`,
 * `yarn`, `--legacy-peer-deps`, compound `install && run dev`) normalize to
 * the exact same tested pipeline; nothing dynamic is generated.
 */
export function rewriteWasmSafeCommand(command: string): string[] | null {
  const normalized = normalize(command);

  if (normalized.length === 0) {
    return null;
  }

  /*
   * Split compound commands so `npm install && npm run dev` maps to the
   * start pipeline (install + swap + dev) rather than bare install.
   */
  const segments = normalized.split(' && ').map((part) => part.trim());

  let startTarget: string | null = null;
  let sawInstall = false;

  for (const segment of segments) {
    // The guest ships npm only; pnpm/yarn rewrite to the npm pipeline.
    const rewritten = segment.replace(/^(pnpm|yarn)(\s+)/, 'npm$2');

    if (/^npm run (dev|build|preview)$/.test(rewritten)) {
      startTarget = rewritten.replace(/^npm run /, '');
      continue;
    }

    if (/^npm (install|i|ci)( .*)?$/.test(rewritten)) {
      sawInstall = true;
      continue;
    }

    return null;
  }

  if (startTarget !== null) {
    return [...WASM_SAFE_PIPELINE_START, `npm run ${startTarget}`];
  }

  if (sawInstall) {
    return [...WASM_SAFE_PIPELINE_INSTALL];
  }

  return null;
}

/**
 * Nexari adapter over the facade's `sh -c` action-execution lane
 * (`runActionCommand`). Composition rule for the historical merged-output
 * contract: cleaned-stderr semantics do not exist on this lane, so output is
 * `stdout` with `stderr` appended after a newline only when stderr is
 * non-empty. Exit-code passthrough is exact (including 0 and non-zero);
 * failures (not-ready, terminated, caller abort, teardown-mid-command)
 * propagate typed.
 *
 * Project install/start commands are never executed raw: they are rewritten
 * into the verified wasm-safe sequence and run step by step, with the caller
 * abort signal propagated to the step in flight. Interactive workbench
 * terminal sessions do not go through this shell and are unaffected.
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

      const steps = rewriteWasmSafeCommand(command);

      if (steps === null) {
        const result = await runtime.runActionCommand(command, signal);

        const output = result.stderr.length > 0 ? `${result.stdout}\n${result.stderr}` : result.stdout;

        return { output, exitCode: result.exitCode };
      }

      let output = '[wasm-safe] project start command rewritten to the verified wasm32 sequence:\n';

      for (const step of steps) {
        if (signal?.aborted) {
          throw new Error('Nexari action command aborted.');
        }

        output += `\n$ ${step}\n`;

        const result = await runtime.runActionCommand(step, signal);

        output += result.stderr.length > 0 ? `${result.stdout}\n${result.stderr}` : result.stdout;

        if (result.exitCode !== 0) {
          output += `\n[wasm-safe] step failed with exit code ${result.exitCode}; stopping the pipeline.`;
          return { output, exitCode: result.exitCode };
        }
      }

      return { output, exitCode: 0 };
    },
  };
}
