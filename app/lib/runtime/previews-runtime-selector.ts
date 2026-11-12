import type { RuntimeBackend } from './runtime-selector';
import type { WebContainer } from '@webcontainer/api';
import { NexariUnsupportedCapabilityError, type NexariBrowserRuntime } from './nexari-runtime-facade';
import { isNexariFacade } from './nexari-surface';

/**
 * The narrow preview-event surface `PreviewsStore` consumes. On the stackblitz
 * control path this is the raw WebContainer instance, returned by identity so
 * the historical behavior is untouched. On the nexari path it is a verified
 * facade-backed adapter exposing only `server-ready` and `port` — the events
 * the store was written against — with everything else refused typed.
 */
export interface PreviewsRuntimeSurface {
  on(event: 'server-ready', listener: (port: number, url: string) => void): () => void;
  on(event: 'port', listener: (port: number, kind: 'open' | 'close', url: string) => void): () => void;
}

/** Structural view: a booted WebContainer satisfies the surface unchanged. */
type StackblitzPreviewSurface = PreviewsRuntimeSurface & WebContainer;

/**
 * Raised when `nexari` is selected but the runtime promise did not resolve to
 * the Nexari facade. Fail-closed: never a silent fallback to another backend.
 */
export class NexariPreviewsSurfaceSelectionError extends Error {
  constructor() {
    super('Nexari previews surface selected but the runtime promise did not resolve to the Nexari facade.');
    this.name = 'NexariPreviewsSurfaceSelectionError';
  }
}

/**
 * Backend-aware selection of the preview-event surface, mirroring the
 * `createFilesStoreRuntime` pattern.
 */
export function createPreviewsRuntime(
  backend: RuntimeBackend,
  runtimePromise: Promise<unknown>,
): Promise<PreviewsRuntimeSurface> {
  if (backend === 'stackblitz') {
    return runtimePromise as Promise<StackblitzPreviewSurface>;
  }

  return runtimePromise.then((resolved) => {
    if (!isNexariFacade(resolved)) {
      throw new NexariPreviewsSurfaceSelectionError();
    }

    return createNexariPreviewsSurface(resolved);
  });
}

/**
 * Build the nexari-backed preview surface over a verified facade. The facade's
 * `on` lane forwards `server-ready` (fired by the Vivari guest only after the
 * in-VM server answers a real HTTP request) and `port` transitions; unknown
 * events keep the facade's typed refusal.
 */
function createNexariPreviewsSurface(runtime: NexariBrowserRuntime): PreviewsRuntimeSurface {
  const lane = runtime.on as
    | ((event: 'server-ready' | 'port', listener: (...args: unknown[]) => void) => (() => void) | PromiseLike<void>)
    | undefined;

  const on = ((event: 'server-ready' | 'port', listener: (...args: unknown[]) => void): (() => void) => {
    if (!lane) {
      throw new NexariUnsupportedCapabilityError(`previews event ${String(event)}`);
    }

    const detach = lane(event, listener);

    return () => {
      if (typeof detach === 'function') {
        detach();
      }
    };
  }) as PreviewsRuntimeSurface['on'];

  return { on };
}
