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

const WASM_SAFE_PIPELINE_STEPS: readonly string[] = [
  WASM_SAFE_INSTALL_STEP,
  WASM_SAFE_WASM_BUILDS_STEP,
  WASM_SAFE_ROLLUP_SWAP_STEP,
];

const WASM_SAFE_PIPELINE_INSTALL: readonly string[] = WASM_SAFE_PIPELINE_STEPS;
const WASM_SAFE_PIPELINE_START: readonly string[] = WASM_SAFE_PIPELINE_STEPS;

/** Bundlers whose native postinstalls fail on wasm32 and need the wasm rebuild. */
const NATIVE_BINARY_PACKAGES = new Set(['vite', 'rollup', 'esbuild', 'webpack', 'parcel', 'turbopack']);

function normalize(command: string): string {
  return command.trim().replace(/\s+/g, ' ');
}

function stripVersion(pkg: string): string {
  return pkg.replace(/@[0-9^~][^@]*$/, '').replace(/@latest$/, '');
}

/**
 * Deterministic mapping from a model-emitted project install/start command to
 * the verified wasm-safe sequence for the vivari guest. Returns the ordered
 * list of shell steps to run, or `null` when the command is not a project
 * install/start command (it then executes raw, untouched).
 *
 * Pure string-mapping only: flags and package-manager variants (`pnpm`,
 * `yarn`, `--legacy-peer-deps`, compound `install && run dev`) normalize to
 * the exact same tested pipeline.
 */
export function rewriteWasmSafeCommand(command: string): string[] | null {
  const normalized = normalize(command);

  if (normalized.length === 0) {
    return null;
  }

  /*
   * Split compound commands and rewrite each part by its own type, so
   * `npm install && npm run dev` maps to install + dev and
   * `npm run build && npm run preview` runs both targets.
   */
  const segments = normalized.split(' && ').map((part) => part.trim());

  const steps: string[] = [];

  for (const segment of segments) {
    const mapped = mapWasmSafeSegment(segment);

    if (mapped === null) {
      return null;
    }

    /*
     * The run pipeline starts with the install pipeline; when a bare install
     * was already emitted by an earlier segment, only append the run step.
     */
    if (mapped[0] === WASM_SAFE_INSTALL_STEP && steps[0] === WASM_SAFE_INSTALL_STEP) {
      steps.push(...mapped.slice(WASM_SAFE_PIPELINE_STEPS.length));
    } else {
      steps.push(...mapped);
    }
  }

  return steps;
}

/**
 * Maps a single command segment to its wasm-safe steps, or `null` when the
 * segment is not a recognized project install/run command.
 */
function mapWasmSafeSegment(segment: string): string[] | null {
  // The guest ships npm only; pnpm/yarn rewrite to the npm pipeline.
  const rewritten = segment.replace(/^(pnpm|yarn)(\s+)/, 'npm$2');

  const runMatch = /^npm run (dev|build|preview)( -- .+)?$/.exec(rewritten);

  if (runMatch !== null) {
    // The full 4-step start sequence, with the model's flags preserved on the final step.
    return [...WASM_SAFE_PIPELINE_START, `npm run ${runMatch[1]}${runMatch[2] ?? ''}`];
  }

  const tokens = rewritten.split(' ');

  if (tokens[0] !== 'npm' || !(tokens[1] === 'install' || tokens[1] === 'i' || tokens[1] === 'ci')) {
    return null;
  }

  const rest = tokens.slice(2);
  const packages = rest.filter((token) => !token.startsWith('-'));

  if (packages.length === 0) {
    return [...WASM_SAFE_PIPELINE_INSTALL];
  }

  /*
   * Package install: keep the requested packages (the wasm rebuild already
   * brings esbuild/@rollup/wasm-node, so drop those duplicates), and add the
   * wasm builds + rollup swap when a native-binary bundler is among them.
   */
  const deduped = packages.filter((pkg) => {
    const name = stripVersion(pkg);

    return name !== 'esbuild' && name !== '@rollup/wasm-node';
  });
  const needsWasm = packages.some((pkg) => NATIVE_BINARY_PACKAGES.has(stripVersion(pkg)));

  const installStep =
    deduped.length > 0 ? `npm install --ignore-scripts --no-save ${deduped.join(' ')}` : WASM_SAFE_INSTALL_STEP;

  if (needsWasm) {
    return [installStep, WASM_SAFE_WASM_BUILDS_STEP, WASM_SAFE_ROLLUP_SWAP_STEP];
  }

  return [installStep];
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
