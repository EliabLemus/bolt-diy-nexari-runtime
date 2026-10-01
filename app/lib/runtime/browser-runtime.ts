import type { WebContainer as WebContainerInstance } from '@webcontainer/api';
import { WORK_DIR_NAME } from '~/utils/constants';
import type { RuntimeBackend } from './runtime-selector';
import type { NexariRuntime } from './nexari-runtime';
import { createNexariBrowserRuntime, type NexariBrowserRuntime } from './nexari-runtime-facade';

/**
 * Raised when `nexari` is selected but no guest boot factory was injected.
 * The build carries no Nexari guest yet, so this failure must stay visible
 * and typed instead of falling back to another backend.
 */
export class NexariBootNotConfiguredError extends Error {
  constructor() {
    super('Nexari guest boot is not configured in this build.');
    this.name = 'NexariBootNotConfiguredError';
  }
}

export interface BrowserRuntimeBootstrapDependencies {
  bootStackblitz: () => Promise<WebContainerInstance>;

  /** Optional until a Nexari guest package is approved for this build. */
  bootNexari?: () => Promise<NexariRuntime>;
}

const productionDependencies: BrowserRuntimeBootstrapDependencies = {
  /*
   * Loaded lazily so selecting `nexari` never downloads/loads the WebContainer
   * SDK (Delta 003 acceptance: the nexari path contains no SDK import).
   */
  bootStackblitz: async () => {
    const webcontainerModule = await import('@webcontainer/api');

    return webcontainerModule.WebContainer.boot({
      coep: 'credentialless',
      workdirName: WORK_DIR_NAME,
      forwardPreviewErrors: true,
    });
  },

  /*
   * The vendored adapter owns the Vivari SDK import. Keep this composition
   * dynamic so the StackBlitz control path neither loads nor bundles it, and
   * the Nexari path never evaluates @webcontainer/api.
   */
  bootNexari: async () => {
    const [{ createAppNexariBootFactory }, { createVivariRuntime, loadPinnedVivariSdk }] = await Promise.all([
      import('./nexari-app-boot'),
      import('@nexari/vivari-adapter'),
    ]);

    return createAppNexariBootFactory({
      loadSdk: loadPinnedVivariSdk,
      createVivariRuntime,
    })();
  },
};

/**
 * Boot a Nexari-backed browser runtime from an injected guest factory and
 * return it only once it reached `ready`. Failed guest boots propagate as
 * rejections of the returned promise.
 */
export async function createNexariBrowserRuntimeBackend(
  bootNexari: () => Promise<NexariRuntime>,
): Promise<NexariBrowserRuntime> {
  const runtime = createNexariBrowserRuntime(await bootNexari());

  await runtime.boot();

  return runtime;
}

/**
 * Own the backend choice at one seam. The current StackBlitz path intentionally
 * uses the exact historical boot options. Selecting `nexari` without an
 * injected guest boot fails closed with a typed error.
 */
export function createBrowserRuntime(
  backend: 'nexari',
  dependencies: BrowserRuntimeBootstrapDependencies & { bootNexari: () => Promise<NexariRuntime> },
): Promise<NexariBrowserRuntime>;
export function createBrowserRuntime(
  backend: RuntimeBackend,
  dependencies?: BrowserRuntimeBootstrapDependencies,
): Promise<WebContainerInstance>;
export function createBrowserRuntime(
  backend: RuntimeBackend,
  dependencies: BrowserRuntimeBootstrapDependencies = productionDependencies,
): Promise<WebContainerInstance | NexariBrowserRuntime> {
  if (backend === 'stackblitz') {
    return dependencies.bootStackblitz();
  }

  const { bootNexari } = dependencies;

  if (!bootNexari) {
    return Promise.reject(new NexariBootNotConfiguredError());
  }

  return createNexariBrowserRuntimeBackend(bootNexari);
}
