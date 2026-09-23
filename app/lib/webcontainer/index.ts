import type { WebContainer } from '@webcontainer/api';
import { cleanStackTrace } from '~/utils/stacktrace';
import { createBrowserRuntime } from '~/lib/runtime/browser-runtime';
import { configuredRuntimeBackend, type RuntimeBackend } from '~/lib/runtime/runtime-selector';

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

        const { workbenchStore } = await import('~/lib/stores/workbench');

        const response = await fetch('/inspector-script.js');
        const inspectorScript = await response.text();
        await webcontainer.setPreviewScript(inspectorScript);

        // Listen for preview errors
        webcontainer.on('preview-message', (message) => {
          console.log('WebContainer preview message:', message);

          // Handle both uncaught exceptions and unhandled promise rejections
          if (message.type === 'PREVIEW_UNCAUGHT_EXCEPTION' || message.type === 'PREVIEW_UNHANDLED_REJECTION') {
            const isPromise = message.type === 'PREVIEW_UNHANDLED_REJECTION';
            const title = isPromise ? 'Unhandled Promise Rejection' : 'Uncaught Exception';
            workbenchStore.actionAlert.set({
              type: 'preview',
              title,
              description: 'message' in message ? message.message : 'Unknown error',
              content: `Error occurred at ${message.pathname}${message.search}${message.hash}\nPort: ${message.port}\n\nStack trace:\n${cleanStackTrace(message.stack || '')}`,
              source: 'preview',
            });
          }
        });

        return webcontainer;
      });

  if (import.meta.hot) {
    import.meta.hot.data.webcontainer = webcontainer;
  }
}
