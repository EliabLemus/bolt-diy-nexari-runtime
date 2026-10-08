import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Plugin, ViteDevServer } from 'vite';
import { prepareNexariBrowserAssets } from './nexari-browser-assets-extract';

const ALLOWED_EXACT_PATHS = new Map<string, string>([
  ['/sw.js', 'sw.js'],
  ['/__vv-bridge.html', '__vv-bridge.html'],
  ['/__vv-preview-boot.html', '__vv-preview-boot.html'],
]);
const ALLOWED_PREFIXES = ['/assets/', '/vendor/'] as const;

export const NEXARI_BROWSER_ASSETS_DIRECTORY = path.resolve('vendor/nexari-browser-stack/browser-assets');

export interface NexariBrowserAssetsPluginOptions {
  enabled: boolean;
  archivePath?: string;
  archiveSha256?: string;
  assetsRoot?: string;
}

type MiddlewareRequest = { method?: string; url?: string };
type MiddlewareResponse = {
  end(chunk?: Buffer): void;
  setHeader(name: string, value: string): void;
  statusCode: number;
};

type AssetRoute = { relativePath: string } | undefined;

export const NEXARI_ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
} as const;

function setIsolationHeaders(response: MiddlewareResponse) {
  for (const [name, value] of Object.entries(NEXARI_ISOLATION_HEADERS)) {
    response.setHeader(name, value);
  }
}

function contentTypeFor(relativePath: string) {
  const extension = path.extname(relativePath).toLowerCase();

  if (extension === '.wasm') {
    return 'application/wasm';
  }

  if (extension === '.html') {
    return 'text/html; charset=utf-8';
  }

  if (extension === '.js' || extension === '.mjs') {
    return 'application/javascript; charset=utf-8';
  }

  if (extension === '.json') {
    return 'application/json; charset=utf-8';
  }

  return 'application/octet-stream';
}

function routeAssetUrl(url: string | undefined): AssetRoute {
  const rawPathname = (url ?? '/').split(/[?#]/, 1)[0];
  let decodedPathname: string;

  try {
    decodedPathname = decodeURIComponent(rawPathname);
  } catch {
    return ALLOWED_PREFIXES.some((prefix) => rawPathname.startsWith(prefix)) ? { relativePath: '' } : undefined;
  }

  const isExact = ALLOWED_EXACT_PATHS.has(decodedPathname);
  const prefix = ALLOWED_PREFIXES.find((candidate) => decodedPathname.startsWith(candidate));

  if (!isExact && !prefix) {
    return undefined;
  }

  if (decodedPathname.split('/').includes('..')) {
    return { relativePath: '' };
  }

  if (isExact) {
    return { relativePath: ALLOWED_EXACT_PATHS.get(decodedPathname)! };
  }

  const normalizedPathname = path.posix.normalize(decodedPathname);

  if (!normalizedPathname.startsWith(prefix!)) {
    return { relativePath: '' };
  }

  return { relativePath: normalizedPathname.slice(1) };
}

function isContained(root: string, candidate: string) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

async function hasNoSymlinkPathSegment(root: string, candidate: string) {
  if (!isContained(root, candidate)) {
    return false;
  }

  const segments = path.relative(root, candidate).split(path.sep).filter(Boolean);
  let current = root;

  for (const segment of segments) {
    const stats = await lstat(current);

    if (stats.isSymbolicLink()) {
      return false;
    }

    current = path.join(current, segment);
  }

  return !(await lstat(current)).isSymbolicLink();
}

function sendNotFound(response: MiddlewareResponse) {
  setIsolationHeaders(response);
  response.statusCode = 404;
  response.end();
}

async function serveAsset(
  request: MiddlewareRequest,
  response: MiddlewareResponse,
  assetsRoot: string,
): Promise<boolean> {
  const route = routeAssetUrl(request.url);

  if (!route) {
    return false;
  }

  if (request.method !== undefined && request.method !== 'GET' && request.method !== 'HEAD') {
    sendNotFound(response);
    return true;
  }

  const root = path.resolve(assetsRoot, 'dist');
  const candidate = path.resolve(root, route.relativePath);

  try {
    if (!route.relativePath || !isContained(root, candidate) || !(await hasNoSymlinkPathSegment(root, candidate))) {
      sendNotFound(response);
      return true;
    }

    const body = await readFile(candidate);
    setIsolationHeaders(response);
    response.statusCode = 200;
    response.setHeader('Content-Type', contentTypeFor(route.relativePath));

    if (route.relativePath === 'sw.js') {
      response.setHeader('Service-Worker-Allowed', '/');
    }

    response.end(request.method === 'HEAD' ? undefined : body);

    return true;
  } catch {
    sendNotFound(response);
    return true;
  }
}

export function createNexariBrowserAssetsPlugin({
  enabled,
  archivePath,
  archiveSha256,
  assetsRoot = NEXARI_BROWSER_ASSETS_DIRECTORY,
}: NexariBrowserAssetsPluginOptions): Plugin {
  return {
    name: 'nexari-browser-assets',
    async configResolved() {
      if (!enabled) {
        return;
      }

      if (!archivePath || !archiveSha256) {
        throw new Error('Nexari browser-assets archive identity is required when the nexari backend is selected');
      }

      await prepareNexariBrowserAssets({
        archivePath,
        destinationDirectory: assetsRoot,
        sha256: archiveSha256,
      });
    },
    configureServer(server: ViteDevServer) {
      if (!enabled) {
        return;
      }

      server.middlewares.use((_request, response, next) => {
        setIsolationHeaders(response);
        next();
      });

      server.middlewares.use((request, response, next) => {
        void serveAsset(request, response, assetsRoot).then((handled) => {
          if (!handled) {
            next();
          }
        });
      });
    },
  };
}
