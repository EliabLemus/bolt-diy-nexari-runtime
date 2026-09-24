import type { WebContainer } from '@webcontainer/api';
import { createBrowserRuntime } from '~/lib/runtime/browser-runtime';
import { configuredRuntimeBackend, type RuntimeBackend } from '~/lib/runtime/runtime-selector';
import { wireStackblitzPreview } from '~/lib/webcontainer/preview-wiring';

interface WebContainerContext {
  loaded: boolean;
  backend?: RuntimeBackend;
}

const runtimeBackend = configuredRuntimeBackend();

export const webcontainerContext: WebContainerContext = import.meta.hot?.data.webcontainerContext ?? {
  loaded: false,
};

if (import.meta.hot) {
  import.meta.hot.data.webcontainerContext = webcontainerContext;
}

export let webcontainer: Promise<WebContainer> = new Promise(() => {
  // noop for ssr
});

if (!import.meta.env.SSR) {
  const cachedRuntime =
    import.meta.hot?.data.webcontainerContext?.backend === runtimeBackend
      ? import.meta.hot.data.webcontainer
      : undefined;

  if (!cachedRuntime) {
    /*
     * A backend change or failed prior boot cannot retain readiness from the
     * previous runtime. Consumers must observe the pending/new runtime instead.
     */
    webcontainerContext.loaded = false;
    webcontainerContext.backend = undefined;
  }

  webcontainer =
    cachedRuntime ??
    Promise.resolve()
      .then(() => createBrowserRuntime(runtimeBackend))
      .then(async (webcontainer) => {
        webcontainerContext.loaded = true;
        webcontainerContext.backend = runtimeBackend;

        /*
         * Preview script injection and preview error events are StackBlitz
         * capabilities. The nexari facade rejects them, so the nexari path
         * skips this wiring entirely instead of failing boot on a refusal.
         */
        if (runtimeBackend === 'stackblitz') {
          await wireStackblitzPreview(webcontainer);
        }

        return webcontainer;
      });

  if (import.meta.hot) {
    import.meta.hot.data.webcontainer = webcontainer;
  }
}
