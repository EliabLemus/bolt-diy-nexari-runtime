import { describe, expect, it } from 'vitest';
import { PreviewsStore } from './previews';

type Listener = (...args: unknown[]) => void;

/** Minimal event-emitter surface matching PreviewsRuntimeShape. */
function createFakeRuntime() {
  const listeners = new Map<string, Set<Listener>>();

  return {
    on(event: string, listener: Listener) {
      if (!listeners.has(event)) {
        listeners.set(event, new Set());
      }

      listeners.get(event)!.add(listener);

      return () => {
        listeners.get(event)?.delete(listener);
      };
    },
    emit(event: string, ...args: unknown[]) {
      listeners.get(event)?.forEach((listener) => listener(...args));
    },
  };
}

async function createStore() {
  const runtime = createFakeRuntime();
  const store = new PreviewsStore(Promise.resolve(runtime as never));

  // Allow the constructor's async #init() to attach its listeners.
  await new Promise((resolve) => setTimeout(resolve, 0));

  return { runtime, store };
}

describe('PreviewsStore ready semantics', () => {
  it('does NOT mark a preview ready from a port:open bind', async () => {
    const { runtime, store } = await createStore();

    runtime.emit('port', 3000, 'open', 'http://localhost:3000');

    const previews = store.previews.get();

    expect(previews).toHaveLength(1);
    expect(previews[0].port).toBe(3000);
    expect(previews[0].ready).toBe(false);
  });

  it('inserts a ready entry on server-ready even without a prior port:open', async () => {
    const { runtime, store } = await createStore();

    runtime.emit('server-ready', 4173, 'http://localhost:4173');

    const previews = store.previews.get();

    expect(previews).toHaveLength(1);
    expect(previews[0].port).toBe(4173);
    expect(previews[0].ready).toBe(true);
    expect(previews[0].baseUrl).toBe('http://localhost:4173');
  });

  it('flips ready=true only when server-ready follows port:open', async () => {
    const { runtime, store } = await createStore();

    runtime.emit('port', 3000, 'open', 'http://localhost:3000');
    expect(store.previews.get()[0].ready).toBe(false);

    runtime.emit('server-ready', 3000, 'http://localhost:3000');
    expect(store.previews.get()[0].ready).toBe(true);
  });

  it('removes the preview on port:close', async () => {
    const { runtime, store } = await createStore();

    runtime.emit('server-ready', 3000, 'http://localhost:3000');
    runtime.emit('port', 3000, 'close', 'http://localhost:3000');

    expect(store.previews.get()).toHaveLength(0);
  });
});

describe('PreviewsStore.getPreviewId', () => {
  it('extracts the id from WebContainer preview URLs', async () => {
    const { store } = await createStore();

    expect(store.getPreviewId('https://abc123.local-credentialless.webcontainer-api.io/')).toBe('abc123');
  });

  it('extracts an id from nexari /preview/<port>/ URLs', async () => {
    const { store } = await createStore();

    expect(store.getPreviewId('http://localhost:5173/preview/3000/')).toBe('nexari-3000');
  });

  it('returns null for unrelated URLs', async () => {
    const { store } = await createStore();

    expect(store.getPreviewId('http://localhost:5173/chat')).toBeNull();
  });
});
