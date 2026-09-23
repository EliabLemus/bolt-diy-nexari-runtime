import { WebContainer, type WebContainer as WebContainerInstance } from '@webcontainer/api';
import { WORK_DIR_NAME } from '~/utils/constants';
import type { RuntimeBackend } from './runtime-selector';

export class RuntimeBackendUnavailableError extends Error {
  constructor(backend: RuntimeBackend) {
    super(`The ${backend} runtime adapter is not wired into this build yet.`);
    this.name = 'RuntimeBackendUnavailableError';
  }
}

export interface BrowserRuntimeBootstrapDependencies {
  bootStackblitz: () => Promise<WebContainerInstance>;
}

const productionDependencies: BrowserRuntimeBootstrapDependencies = {
  bootStackblitz: () =>
    WebContainer.boot({
      coep: 'credentialless',
      workdirName: WORK_DIR_NAME,
      forwardPreviewErrors: true,
    }),
};

/**
 * Own the backend choice at one seam. The current StackBlitz path intentionally
 * uses the exact historical boot options; Nexari remains fail-closed until its
 * adapter is supplied in the next slice.
 */
export function createBrowserRuntime(
  backend: RuntimeBackend,
  dependencies: BrowserRuntimeBootstrapDependencies = productionDependencies,
): Promise<WebContainerInstance> {
  if (backend === 'stackblitz') {
    return dependencies.bootStackblitz();
  }

  return Promise.reject(new RuntimeBackendUnavailableError(backend));
}
