import { WORK_DIR_NAME } from '~/utils/constants';
import type { NexariRuntime } from './nexari-runtime';
import { createVivariGuestFactory, type VivariSdkLike } from './vivari-guest-factory';

/**
 * Cross-origin isolation is a hard Vivari prerequisite. This probe mirrors the
 * pinned adapter's default and is SSR/node-safe: both globals are read through
 * `typeof` guards so the module can be imported outside a browser context.
 */
export function defaultCrossOriginIsolationProbe(): boolean {
  return typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined';
}

export interface NexariAppBootFactoryOptions {
  /** Stable vivari runtime identifier; defaults to the app work directory name. */
  id?: string;

  /**
   * Isolation probe override. The default rejects boot on non-cross-origin-isolated
   * browsers (the vivari guest fails closed with ISOLATION_REQUIRED there).
   */
  isIsolated?: () => boolean;
}

export interface NexariAppBootDependencies {
  /** Loads the vivari SDK the injected runtime will boot from. Required: this build links no vivari package. */
  loadSdk: () => Promise<VivariSdkLike>;

  /**
   * Injected vivari runtime constructor; production passes the pinned adapter's
   * `createVivariRuntime` once the owner approves linking the adapter package.
   */
  createVivariRuntime: Parameters<typeof createVivariGuestFactory>[0]['createVivariRuntime'];
}

/**
 * Compose the application-level Nexari guest boot factory for the
 * `VITE_RUNTIME_BACKEND=nexari` path.
 *
 * The vivari guest is constructed exactly once, eagerly, at composition time
 * (mirroring `createVivariGuestFactory` semantics), while its `boot()` runs
 * once inside the Nexari boot seam of each produced runtime. Returning a fresh
 * `NexariRuntime` thunk per call keeps lifecycle ownership explicit; the app
 * seam composes this factory a single time.
 */
export function createAppNexariBootFactory(
  dependencies: NexariAppBootDependencies,
  options: NexariAppBootFactoryOptions = {},
): () => Promise<NexariRuntime> {
  const { createVivariRuntime, loadSdk } = dependencies;
  const id = options.id ?? WORK_DIR_NAME;
  const isIsolated = options.isIsolated ?? defaultCrossOriginIsolationProbe;

  return createVivariGuestFactory({
    id,
    isIsolated,
    loadSdk,
    createVivariRuntime,
  });
}
