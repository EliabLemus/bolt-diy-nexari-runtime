import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
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

async function resolvePluginConfig(plugin: ReturnType<typeof createNexariBrowserAssetsPlugin>) {
  const configResolved = plugin.configResolved;

  if (!configResolved) {
    throw new Error('Nexari browser-assets plugin did not register a configResolved hook');
  }

  if (typeof configResolved === 'function') {
    await configResolved({} as never);
    return;
  }

  await configResolved.handler({} as never);
}

function installMiddleware(assetsRoot: string): Middleware {
  const plugin = createNexariBrowserAssetsPlugin({ enabled: true, assetsRoot });
  const middlewares: Middleware[] = [];

  configurePlugin(plugin, {
    middlewares: {
      use(handler: Middleware) {
        middlewares.push(handler);
      },
    },
  });

  if (middlewares.length === 0) {
    throw new Error('Nexari browser-assets plugin did not install its middleware');
  }

  return async (request, response, next) => {
    let middlewareIndex = 0;

    const runNext = (): void | Promise<void> => {
      const middleware = middlewares[middlewareIndex++];

      return middleware ? middleware(request, response, runNext) : next();
    };

    await runNext();
  };
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

function writeString(target: Buffer, offset: number, length: number, value: string) {
  Buffer.from(value, 'utf8').copy(target, offset, 0, length);
}

function createBrowserAssetsArchive() {
  const body = Buffer.from('self.skipWaiting();\n', 'utf8');
  const header = Buffer.alloc(512, 0);
  writeString(header, 0, 100, 'package/dist/sw.js');
  writeString(header, 100, 8, '0000644\0');
  writeString(header, 124, 12, `${body.length.toString(8).padStart(11, '0')}\0`);
  header.fill(0x20, 148, 156);
  writeString(header, 156, 1, '0');
  writeString(header, 257, 6, 'ustar\0');
  writeString(header, 263, 2, '00');

  let checksum = 0;

  for (const byte of header) {
    checksum += byte;
  }

  writeString(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `);

  return gzipSync(Buffer.concat([header, body, Buffer.alloc(512 - body.length), Buffer.alloc(1024)]));
}

async function createArchiveFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'nexari-browser-assets-plugin-'));
  tempDirectories.push(directory);

  const archive = createBrowserAssetsArchive();
  const archivePath = path.join(directory, 'browser-assets.tgz');
  await writeFile(archivePath, archive);

  return {
    archivePath,
    assetsRoot: path.join(directory, 'consumer-assets'),
    sha256: createHash('sha256').update(archive).digest('hex'),
  };
}

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('createNexariBrowserAssetsPlugin', () => {
  it('materializes the checksum-pinned tarball into the consumer destination before Vite serves it', async () => {
    const fixture = await createArchiveFixture();
    const plugin = createNexariBrowserAssetsPlugin({
      enabled: true,
      assetsRoot: fixture.assetsRoot,
      archivePath: fixture.archivePath,
      archiveSha256: fixture.sha256,
    });

    expect(plugin.configResolved).toBeDefined();
    await resolvePluginConfig(plugin);

    await expect(readFile(path.join(fixture.assetsRoot, 'dist/sw.js'), 'utf8')).resolves.toBe('self.skipWaiting();\n');
  });

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

  it('sets isolation headers on the Nexari application document before passing it to Remix', async () => {
    const assetsRoot = await mkdtemp(path.join(tmpdir(), 'nexari-browser-assets-'));
    tempDirectories.push(assetsRoot);

    const { response, passedThrough } = await request(installMiddleware(assetsRoot), '/');

    expect(passedThrough).toBe(true);
    expect(response.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(response.headers.get('cross-origin-embedder-policy')).toBe('require-corp');
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

    expect(viteConfig).toMatch(
      /import \{[^}]*createNexariBrowserAssetsPlugin[^}]*\} from '\.\/app\/lib\/runtime\/nexari-browser-assets-vite-plugin';/,
    );
    expect(viteConfig).toMatch(
      /createNexariBrowserAssetsPlugin\(\{\s*enabled: isNexariBackend,\s*archivePath: nexariBrowserAssetsArchivePath,\s*archiveSha256: nexariBrowserAssets\.sha256,\s*\}\)/,
    );
    expect(viteConfig).toMatch(/const isNexariBackend = process\.env\.VITE_RUNTIME_BACKEND === 'nexari';/);
  });

  it('sets cross-origin isolation on the Nexari application document, not only asset responses', async () => {
    const repositoryRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
    const viteConfig = await readFile(path.join(repositoryRoot, 'vite.config.ts'), 'utf8');

    expect(viteConfig).toMatch(
      /import \{[^}]*NEXARI_ISOLATION_HEADERS[^}]*\} from '\.\/app\/lib\/runtime\/nexari-browser-assets-vite-plugin';/,
    );
    expect(viteConfig).toMatch(
      /server:\s*isNexariBackend\s*\?\s*\{\s*headers:\s*NEXARI_ISOLATION_HEADERS\s*\}\s*:\s*undefined/,
    );
  });
});
