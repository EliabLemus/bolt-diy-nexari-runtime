import { createReadStream, existsSync, statSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Plugin, ViteDevServer } from 'vite';

/**
 * Nexari host asset-serving plugin.
 *
 * Serves the verified `@nexari/vivari-browser-assets` static package in
 * development and copies its payload byte-identically into the production
 * build output. Files are ONLY ever resolved from the installed package's
 * `dist/` directory; any attempt to escape that root is rejected.
 */

const PACKAGE_SUBPATH = 'node_modules/@nexari/vivari-browser-assets';

const ALLOWED_ENTRY_PREFIXES = ['/', '/assets/', '/vendor/'];

const MIME_TYPES: Record<string, string> = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.html': 'text/html',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
  '.bin': 'application/octet-stream',
  '.map': 'application/json',
  '.txt': 'text/plain',
};

export interface ResolveNexariAssetResult {
  /** Absolute path inside the package dist root, or null when rejected. */
  filePath: string | null;
}

/**
 * Resolve a URL path to a file inside the installed assets package.
 * Returns null for anything that escapes the dist root (traversal, absolute
 * segments, symlinks-out via normalization, non-allowlisted roots).
 */
export function resolveNexariAssetUrl(repositoryRoot: string, urlPath: string): string | null {
  if (!ALLOWED_ENTRY_PREFIXES.some((prefix) => urlPath === prefix || urlPath.startsWith(prefix))) {
    return null;
  }

  const distRoot = path.resolve(repositoryRoot, PACKAGE_SUBPATH, 'dist');
  const decoded = decodeURIComponent(urlPath);
  const normalized = path.normalize(decoded).replace(/\\/g, '/');

  // Reject any normalization that climbs out of the root or hides escape segments.
  if (normalized.includes('..') || path.isAbsolute(normalized) === false || !normalized.startsWith('/')) {
    return null;
  }

  const resolved = path.resolve(distRoot, `.${normalized}`);
  const resolvedWithSep = distRoot.endsWith(path.sep) ? distRoot : `${distRoot}${path.sep}`;

  if (!resolved.startsWith(resolvedWithSep)) {
    return null;
  }

  if (!existsSync(resolved) || !statSync(resolved).isFile()) {
    return null;
  }

  return resolved;
}

function crossOriginIsolationHeaders(res: import('node:http').ServerResponse): void {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Service-Worker-Allowed', '/');
}

function serveNexariAsset(
  repositoryRoot: string,
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  next: () => void,
): void {
  const urlPath = (req.url ?? '').split('?')[0];

  if (!ALLOWED_ENTRY_PREFIXES.some((prefix) => urlPath === prefix || urlPath.startsWith(prefix))) {
    next();

    return;
  }

  const filePath = resolveNexariAssetUrl(repositoryRoot, urlPath);

  if (filePath === null) {
    res.statusCode = 403;
    res.end('Forbidden');

    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  res.statusCode = 200;
  res.setHeader('Content-Type', MIME_TYPES[ext] ?? 'application/octet-stream');
  crossOriginIsolationHeaders(res);

  const stream = createReadStream(filePath);
  stream.on('error', () => {
    if (!res.headersSent) {
      res.statusCode = 404;
    }

    res.end();
  });
  stream.pipe(res);
}

async function copyNexariAssets(repositoryRoot: string, outDir: string): Promise<number> {
  const distRoot = path.resolve(repositoryRoot, PACKAGE_SUBPATH, 'dist');
  let copied = 0;

  async function walk(sourceDir: string, targetDir: string): Promise<void> {
    await mkdir(targetDir, { recursive: true });

    for (const entry of await readdir(sourceDir, { withFileTypes: true })) {
      const sourcePath = path.join(sourceDir, entry.name);
      const targetPath = path.join(targetDir, entry.name);

      if (entry.isDirectory()) {
        await walk(sourcePath, targetPath);
      } else if (entry.isFile()) {
        await copyFile(sourcePath, targetPath);
        copied += 1;
      }
    }
  }

  await walk(distRoot, path.resolve(outDir));

  return copied;
}

export function nexariBrowserAssetsPlugin(repositoryRoot: string = process.cwd()): Plugin {
  let isBuild = false;

  return {
    name: 'nexari-browser-assets',
    configResolved(config) {
      isBuild = config.command === 'build';
    },
    configureServer(server: ViteDevServer) {
      server.middlewares.use((req, res, next) => serveNexariAsset(repositoryRoot, req, res, next));
    },
    async closeBundle() {
      if (!isBuild) {
        return;
      }

      const resolvedOutDir = path.resolve(repositoryRoot, 'build/client');
      const copied = await copyNexariAssets(repositoryRoot, resolvedOutDir);
      console.info(`nexari-browser-assets: copied ${copied} files into build/client`);
    },
  };
}

export async function readNexariAssetBytes(repositoryRoot: string, urlPath: string): Promise<Buffer> {
  const filePath = resolveNexariAssetUrl(repositoryRoot, urlPath);

  if (filePath === null) {
    throw new Error(`Rejected asset URL: ${urlPath}`);
  }

  return readFile(filePath);
}
