import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createNexariBrowserAssetsPlugin } from './nexari-browser-assets-vite-plugin';

type Middleware = (
  request: { method?: string; url?: string },
  response: FakeResponse,
  next: () => void,
) => void | Promise<void>;

class FakeResponse {
  readonly headers = new Map<string, string>();
  readonly chunks: Buffer[] = [];
  readonly finished: Promise<void>;
  statusCode = 200;
  ended = false;
  #resolveFinished!: () => void;

  constructor() {
    this.finished = new Promise((resolve) => {
      this.#resolveFinished = resolve;
    });
  }

  setHeader(name: string, value: string) {
    this.headers.set(name.toLowerCase(), value);
  }

  end(chunk?: Buffer) {
    if (chunk) {
      this.chunks.push(chunk);
    }

    this.ended = true;
    this.#resolveFinished();
  }

  body() {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

function configurePlugin(plugin: ReturnType<typeof createNexariBrowserAssetsPlugin>, server: unknown) {
  const configureServer = plugin.configureServer;

  if (!configureServer) {
    return;
  }

  if (typeof configureServer === 'function') {
    configureServer(server as never);
    return;
  }

  configureServer.handler(server as never);
}

function installMiddleware(assetsRoot: string): Middleware {
  const plugin = createNexariBrowserAssetsPlugin({ enabled: true, assetsRoot });
  let middleware: Middleware | undefined;

  configurePlugin(plugin, {
    middlewares: {
      use(handler: Middleware) {
        middleware = handler;
      },
    },
  });

  if (!middleware) {
    throw new Error('Nexari browser-assets plugin did not install its middleware');
  }

  return middleware;
}

async function request(middleware: Middleware, url: string, method = 'GET') {
  const response = new FakeResponse();
  let passedThrough = false;

  await middleware({ method, url }, response, () => {
    passedThrough = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  if (!passedThrough) {
    await response.finished;
  }

  return { response, passedThrough };
}

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('createNexariBrowserAssetsPlugin', () => {
  it('serves the root service worker with its required isolation and scope headers', async () => {
    const assetsRoot = await mkdtemp(path.join(tmpdir(), 'nexari-browser-assets-'));
    tempDirectories.push(assetsRoot);
    await mkdir(path.join(assetsRoot, 'dist'), { recursive: true });
    await writeFile(path.join(assetsRoot, 'dist/sw.js'), 'self.skipWaiting();\n');

    const { response, passedThrough } = await request(installMiddleware(assetsRoot), '/sw.js?cache-bust=1');

    expect(passedThrough).toBe(false);
    expect(response.statusCode).toBe(200);
    expect(response.body()).toBe('self.skipWaiting();\n');
    expect(response.headers.get('content-type')).toContain('application/javascript');
    expect(response.headers.get('service-worker-allowed')).toBe('/');
    expect(response.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(response.headers.get('cross-origin-embedder-policy')).toBe('require-corp');
  });

  it('serves the declared assets and vendor graph with the correct MIME types', async () => {
    const assetsRoot = await mkdtemp(path.join(tmpdir(), 'nexari-browser-assets-'));
    tempDirectories.push(assetsRoot);
    await mkdir(path.join(assetsRoot, 'dist/assets'), { recursive: true });
    await mkdir(path.join(assetsRoot, 'dist/vendor/pyodide'), { recursive: true });
    await writeFile(path.join(assetsRoot, 'dist/assets/kernel.mjs'), 'export {};\n');
    await writeFile(path.join(assetsRoot, 'dist/vendor/pyodide/kernel.wasm'), Buffer.from([0, 97, 115, 109]));

    const middleware = installMiddleware(assetsRoot);
    const asset = await request(middleware, '/assets/kernel.mjs');
    const wasm = await request(middleware, '/vendor/pyodide/kernel.wasm');

    expect(asset.response.statusCode).toBe(200);
    expect(asset.response.headers.get('content-type')).toContain('application/javascript');
    expect(wasm.response.statusCode).toBe(200);
    expect(wasm.response.headers.get('content-type')).toBe('application/wasm');
  });

  it('owns allowed-shape misses and rejects traversal, malformed encoding, and symlinks without fallback', async () => {
    const assetsRoot = await mkdtemp(path.join(tmpdir(), 'nexari-browser-assets-'));
    const outsideRoot = await mkdtemp(path.join(tmpdir(), 'nexari-browser-assets-outside-'));
    tempDirectories.push(assetsRoot, outsideRoot);
    await mkdir(path.join(assetsRoot, 'dist'), { recursive: true });
    await writeFile(path.join(outsideRoot, 'secret.js'), 'outside\n');
    await symlink(outsideRoot, path.join(assetsRoot, 'dist/assets'));

    const middleware = installMiddleware(assetsRoot);
    const cases = await Promise.all([
      request(middleware, '/assets/../sw.js'),
      request(middleware, '/assets/%2e%2e/secret.js'),
      request(middleware, '/assets/%zz'),
      request(middleware, '/assets/secret.js'),
    ]);

    for (const result of cases) {
      expect(result.passedThrough).toBe(false);
      expect(result.response.statusCode).toBe(404);
      expect(result.response.body()).toBe('');
      expect(result.response.headers.get('cross-origin-opener-policy')).toBe('same-origin');
      expect(result.response.headers.get('cross-origin-embedder-policy')).toBe('require-corp');
    }
  });

  it('passes non-Nexari routes through and installs no middleware when disabled', async () => {
    const assetsRoot = await mkdtemp(path.join(tmpdir(), 'nexari-browser-assets-'));
    tempDirectories.push(assetsRoot);

    const middleware = installMiddleware(assetsRoot);

    await expect(request(middleware, '/favicon.ico')).resolves.toMatchObject({ passedThrough: true });

    const disabled = createNexariBrowserAssetsPlugin({ enabled: false, assetsRoot });
    let installed = false;
    configurePlugin(disabled, {
      middlewares: {
        use() {
          installed = true;
        },
      },
    });

    expect(installed).toBe(false);
  });

  it('registers the asset middleware only for the explicit nexari selector', async () => {
    const repositoryRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
    const viteConfig = await readFile(path.join(repositoryRoot, 'vite.config.ts'), 'utf8');

    expect(viteConfig).toContain(
      "import { createNexariBrowserAssetsPlugin } from './app/lib/runtime/nexari-browser-assets-vite-plugin';",
    );
    expect(viteConfig).toContain(
      "createNexariBrowserAssetsPlugin({ enabled: process.env.VITE_RUNTIME_BACKEND === 'nexari' })",
    );
  });
});
