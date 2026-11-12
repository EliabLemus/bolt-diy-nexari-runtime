import { NexariUnsupportedCapabilityError, type NexariBrowserRuntime } from './nexari-runtime-facade';
import { WORK_DIR } from '~/utils/constants';

/**
 * Shared structural predicate over the Nexari facade surface
 * (`nexari-runtime-facade.ts`). Every backend-aware consumer selector
 * (action shell, action runner, files store) resolves the shared runtime
 * promise through this predicate instead of carrying its own weaker copy.
 *
 * `runActionCommand` remains the strongest discriminator — the WebContainer
 * surface has spawn/mount/teardown but no runActionCommand. The `fs` object
 * and `spawn` function checks are the additions that make the predicate
 * sufficient for filesystem consumers; they reject a superset of the weaker
 * per-selector predicates, so every previously accepted facade still passes
 * and every rejection remains fail-closed.
 *
 * Cheap, side-effect-free, and idempotent.
 */
export function isNexariFacade(value: unknown): value is NexariBrowserRuntime {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  return (
    typeof candidate.runActionCommand === 'function' &&
    typeof candidate.teardown === 'function' &&
    typeof candidate.boot === 'function' &&
    typeof candidate.state === 'string' &&
    typeof candidate.fs === 'object' &&
    candidate.fs !== null &&
    typeof candidate.spawn === 'function'
  );
}

/**
 * Translate an app-domain path to the nexari guest path domain. The app works
 * in two shapes: bare workdir-relative paths (file actions and the files store
 * relativize against the surface `workdir`) and absolute app paths rooted at
 * `WORK_DIR` (`/home/project/...`, the prompt contract's cwd).
 *
 * The nexari guest VFS is rooted at `/` — the pinned adapter advertises
 * `workdir = '/'` and guest spawns default to the root — so file actions,
 * history files, store writes, and `sh -c` command cwd must agree. The
 * translation is a guarded prefix strip plus dot-segment normalization:
 * `/home/project/x` → `/x`, bare `x` → `/x`. Anything escaping the workdir
 * (`..`, other roots) is refused typed instead of being re-rooted silently.
 */
export function toGuestPath(path: string): string {
  let relative: string;

  if (path.startsWith('/')) {
    if (!path.startsWith(`${WORK_DIR}/`) && path !== WORK_DIR) {
      throw new NexariUnsupportedCapabilityError(
        `fs paths outside the work directory (${path}); the nexari surface is scoped to ${WORK_DIR}`,
      );
    }

    relative = path === WORK_DIR ? '' : path.slice(WORK_DIR.length + 1);
  } else {
    relative = path;
  }

  const stack: string[] = [];

  for (const segment of relative.split('/')) {
    if (segment === '' || segment === '.') {
      continue;
    }

    if (segment === '..') {
      if (stack.length === 0) {
        throw new NexariUnsupportedCapabilityError(
          `fs paths outside the work directory (${path}); the nexari surface is scoped to ${WORK_DIR}`,
        );
      }

      stack.pop();

      continue;
    }

    stack.push(segment);
  }

  return `/${stack.join('/')}`;
}
