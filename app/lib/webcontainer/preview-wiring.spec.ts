import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import type { WebContainer } from '@webcontainer/api';
import type { PreviewMessage } from '@webcontainer/api';
import { wireStackblitzPreview } from './preview-wiring';

const { actionAlertSet } = vi.hoisted(() => ({ actionAlertSet: vi.fn() }));

vi.mock('~/lib/stores/workbench', () => ({
  workbenchStore: {
    actionAlert: {
      set: actionAlertSet,
    },
  },
}));

const INSPECTOR_SCRIPT = 'window.__inspector = true;';

function createMockWebContainer() {
  return {
    setPreviewScript: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
  } as unknown as WebContainer;
}

function createPreviewMessage(overrides: Partial<Record<string, unknown>>): PreviewMessage {
  return {
    type: 'PREVIEW_UNCAUGHT_EXCEPTION',
    message: 'boom',
    pathname: '/app',
    search: '?a=1',
    hash: '#frag',
    port: 5173,
    stack: 'Error: boom\n    at https://abc123.webcontainer-api.io/src/main.ts:1:1',
    ...overrides,
  } as unknown as PreviewMessage;
}

describe('wireStackblitzPreview', () => {
  beforeEach(() => {
    actionAlertSet.mockClear();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ text: async () => INSPECTOR_SCRIPT }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches the inspector script and registers it through setPreviewScript', async () => {
    const webcontainer = createMockWebContainer();

    await wireStackblitzPreview(webcontainer);

    expect(fetch).toHaveBeenCalledWith('/inspector-script.js');
    expect(webcontainer.setPreviewScript).toHaveBeenCalledOnce();
    expect(webcontainer.setPreviewScript).toHaveBeenCalledWith(INSPECTOR_SCRIPT);
  });

  it('registers a preview-message listener', async () => {
    const webcontainer = createMockWebContainer();

    await wireStackblitzPreview(webcontainer);

    expect(webcontainer.on).toHaveBeenCalledWith('preview-message', expect.any(Function));
  });

  it('maps PREVIEW_UNCAUGHT_EXCEPTION to a preview action alert', async () => {
    const webcontainer = createMockWebContainer();
    await wireStackblitzPreview(webcontainer);

    const listener = vi.mocked(webcontainer.on).mock.calls[0][1] as unknown as (message: PreviewMessage) => void;

    listener(createPreviewMessage({ type: 'PREVIEW_UNCAUGHT_EXCEPTION' }));

    expect(actionAlertSet).toHaveBeenCalledOnce();
    expect(actionAlertSet).toHaveBeenCalledWith({
      type: 'preview',
      title: 'Uncaught Exception',
      description: 'boom',
      content: expect.stringContaining('Error occurred at /app?a=1#frag'),
      source: 'preview',
    });

    const alert = actionAlertSet.mock.calls[0][0] as { content: string };
    expect(alert.content).toContain('Port: 5173');
    expect(alert.content).toContain('Stack trace:');
    expect(alert.content).toContain('at src/main.ts:1:1');
  });

  it('maps PREVIEW_UNHANDLED_REJECTION to a preview action alert with the rejection title', async () => {
    const webcontainer = createMockWebContainer();
    await wireStackblitzPreview(webcontainer);

    const listener = vi.mocked(webcontainer.on).mock.calls[0][1] as unknown as (message: PreviewMessage) => void;

    listener(createPreviewMessage({ type: 'PREVIEW_UNHANDLED_REJECTION' }));

    expect(actionAlertSet).toHaveBeenCalledOnce();
    expect(actionAlertSet).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'preview', title: 'Unhandled Promise Rejection', source: 'preview' }),
    );
  });

  it('ignores other preview message types', async () => {
    const webcontainer = createMockWebContainer();
    await wireStackblitzPreview(webcontainer);

    const listener = vi.mocked(webcontainer.on).mock.calls[0][1] as unknown as (message: PreviewMessage) => void;

    listener(createPreviewMessage({ type: 'PREVIEW_CONSOLE_ERROR' }));

    expect(actionAlertSet).not.toHaveBeenCalled();
  });
});

describe('app consumer seam', () => {
  it('loads preview wiring only inside the stackblitz backend gate so SSR cannot traverse its workbench import cycle', async () => {
    const source = await readFile(new URL('./index.ts', import.meta.url), 'utf8');

    expect(source).toMatch(/runtimeBackend\s*===\s*'stackblitz'/);
    expect(source).not.toMatch(/from\s*['"]\.\/preview-wiring['"]/);

    // The dynamic import and call must stay ordered inside the only stackblitz gate.
    expect(source).toMatch(
      /if\s*\(\s*runtimeBackend\s*===\s*'stackblitz'\s*\)\s*\{[\s\S]*?await import\(['"]\.\/preview-wiring['"]\)[\s\S]*?await wireStackblitzPreview\(/,
    );
    expect(source.match(/await wireStackblitzPreview\(/g)).toHaveLength(1);
  });

  it('keeps runtime context and boot flow in index.ts; preview wiring owns no context state', async () => {
    const wiringSource = await readFile(new URL('./preview-wiring.ts', import.meta.url), 'utf8');
    const indexSource = await readFile(new URL('./index.ts', import.meta.url), 'utf8');

    expect(wiringSource).not.toMatch(/webcontainerContext/);
    expect(indexSource).toMatch(/webcontainerContext\.loaded\s*=\s*true/);
    expect(indexSource).toMatch(/webcontainerContext\.backend\s*=\s*runtimeBackend/);
  });
});
