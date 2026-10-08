import { afterEach, describe, expect, it, vi } from 'vitest';
import { NexariUnsupportedCapabilityError } from '~/lib/runtime/nexari-runtime-facade';
import { PreviewsStore } from './previews';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PreviewsStore', () => {
  it('does not register WebContainer preview event listeners on the Nexari facade', async () => {
    vi.stubGlobal('BroadcastChannel', undefined);

    const nexariFacade = {
      state: 'ready',
      fs: {},
      boot: vi.fn(),
      spawn: vi.fn(),
      runActionCommand: vi.fn(),
      teardown: vi.fn(),
      on: vi.fn(() => {
        throw new NexariUnsupportedCapabilityError('runtime event handling (on)');
      }),
    };

    new PreviewsStore(Promise.resolve(nexariFacade as never));

    await Promise.resolve();
    await Promise.resolve();

    expect(nexariFacade.on).not.toHaveBeenCalled();
  });
});
