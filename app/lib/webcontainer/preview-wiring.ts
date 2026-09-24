import type { WebContainer } from '@webcontainer/api';
import { cleanStackTrace } from '~/utils/stacktrace';
import { workbenchStore } from '~/lib/stores/workbench';

/**
 * StackBlitz-only post-boot preview wiring. This body is extracted verbatim
 * from the historical consumer seam so the StackBlitz control path keeps its
 * exact behavior. The nexari backend never reaches it: the nexari facade
 * refuses `setPreviewScript` and `on(...)` with typed errors, so calling this
 * on that path would break boot.
 */
export async function wireStackblitzPreview(webcontainer: WebContainer): Promise<void> {
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
}
