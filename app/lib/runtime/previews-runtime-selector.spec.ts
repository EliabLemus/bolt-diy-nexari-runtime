import { describe, expect, it, vi } from 'vitest';
import { createPreviewsRuntime, NexariPreviewsSurfaceSelectionError } from './previews-runtime-selector';

type Detach = () => void;

function fakeNexariFacade() {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const detachCalls: string[] = [];
  const on = vi.fn((event: string, listener: (...args: unknown[]) => void): Detach => {
    const set = listeners.get(event) ?? new Set();
    set.add(listener);
    listeners.set(event, set);

    return () => {
      detachCalls.push(event);
      set.delete(listener);
    };
  });

  return {
    on,
    listeners,
    detachCalls,
    runActionCommand: vi.fn(),
    teardown: vi.fn(),
    boot: vi.fn(),
    state: 'ready',
    fs: {},
    spawn: vi.fn(),
  };
}

describe('createPreviewsRuntime', () => {
  it('returns the stackblitz runtime promise by identity', async () => {
    const webcontainer = { on: vi.fn() } as unknown;
    const runtimePromise = Promise.resolve(webcontainer);
    const surface = await createPreviewsRuntime('stackblitz', runtimePromise);
    expect(surface).toBe(webcontainer);
  });

  it('resolves nexari selections to a facade-backed event surface', async () => {
    const facade = fakeNexariFacade();
    const surface = await createPreviewsRuntime('nexari', Promise.resolve(facade));
    const listener = vi.fn();
    const detach = surface.on('server-ready', listener);
    expect(facade.on).toHaveBeenCalledWith('server-ready', listener);
    detach();
    expect(facade.detachCalls).toContain('server-ready');
  });

  it('forwards server-ready emissions through the nexari surface', async () => {
    const facade = fakeNexariFacade();
    const surface = await createPreviewsRuntime('nexari', Promise.resolve(facade));
    const listener = vi.fn();
    surface.on('server-ready', listener);

    for (const fn of facade.listeners.get('server-ready') ?? []) {
      fn(5173, 'http://localhost:5173/');
    }
    expect(listener).toHaveBeenCalledWith(5173, 'http://localhost:5173/');
  });

  it('forwards port transitions through the nexari surface', async () => {
    const facade = fakeNexariFacade();
    const surface = await createPreviewsRuntime('nexari', Promise.resolve(facade));
    const listener = vi.fn();
    surface.on('port', listener);

    for (const fn of facade.listeners.get('port') ?? []) {
      fn(5173, 'open', 'http://localhost:5173/');
    }
    expect(listener).toHaveBeenCalledWith(5173, 'open', 'http://localhost:5173/');
  });

  it('forwards event names verbatim to the facade lane', async () => {
    const facade = fakeNexariFacade();
    const surface = await createPreviewsRuntime('nexari', Promise.resolve(facade));
    surface.on('server-ready', vi.fn());
    surface.on('port', vi.fn());
    expect(facade.on).toHaveBeenCalledWith('server-ready', expect.any(Function));
    expect(facade.on).toHaveBeenCalledWith('port', expect.any(Function));
    expect(surface.on('server-ready', vi.fn())).toBeTypeOf('function');
  });

  it('fails closed when the nexari promise does not resolve to the facade', async () => {
    const impostor = { on: vi.fn() };
    await expect(createPreviewsRuntime('nexari', Promise.resolve(impostor))).rejects.toThrow(
      NexariPreviewsSurfaceSelectionError,
    );
  });
});
