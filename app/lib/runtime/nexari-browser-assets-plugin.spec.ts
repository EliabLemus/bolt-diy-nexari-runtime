import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readNexariAssetBytes, resolveNexariAssetUrl } from './nexari-browser-assets-plugin';

const repositoryRoot = resolve(import.meta.dirname, '../../..');
const distRoot = resolve(repositoryRoot, 'node_modules/@nexari/vivari-browser-assets/dist');

describe('nexari-browser-assets path safety', () => {
  it('rejects traversal attempts that escape the package dist root', () => {
    const attempts = [
      '/../../package.json',
      '/assets/../../../package.json',
      '/assets/..%2F..%2F..%2Fpackage.json',
      '/vendor/../../vite.config.ts',
      '/..%2f..%2f..%2fetc/passwd',
      '/assets/%2e%2e/%2e%2e/%2e%2e/package.json',
      '/..\\..\\package.json',
      '/%2e%2e/%2e%2e',
      '/assets/./../../bolt.diy-nexari-main/package.json',
    ];

    for (const attempt of attempts) {
      expect(resolveNexariAssetUrl(repositoryRoot, attempt), attempt).toBeNull();
    }
  });

  it('rejects non-allowlisted URL roots', () => {
    for (const urlPath of ['/app/entry.client.tsx', '/node_modules/vite/package.json', '/secret.txt']) {
      expect(resolveNexariAssetUrl(repositoryRoot, urlPath), urlPath).toBeNull();
    }
  });

  it('resolves real package files inside the dist root', () => {
    expect(resolveNexariAssetUrl(repositoryRoot, '/sw.js')).toBe(resolve(distRoot, 'sw.js'));
    expect(resolveNexariAssetUrl(repositoryRoot, '/__vv-bridge.html')).toBe(resolve(distRoot, '__vv-bridge.html'));

    const asset = resolveNexariAssetUrl(repositoryRoot, '/assets/sw.js');

    expect(asset).toBe(resolve(distRoot, 'assets/sw.js'));
  });
});

describe('nexari-browser-assets byte identity', () => {
  it('serves bytes identical to the installed package for sw.js', async () => {
    const served = await readNexariAssetBytes(repositoryRoot, '/sw.js');
    const origin = await readFile(resolve(distRoot, 'sw.js'));

    expect(createHash('sha256').update(served).digest('hex')).toBe(createHash('sha256').update(origin).digest('hex'));
    expect(served.equals(origin)).toBe(true);
  });

  it('serves bytes identical to the installed package for bridge and worker assets', async () => {
    const paths = ['/__vv-bridge.html', '/__vv-preview-boot.html', '/assets/sw.js'];

    for (const urlPath of paths) {
      const relative = urlPath.replace(/^\//, '');
      const served = await readNexariAssetBytes(repositoryRoot, urlPath);
      const origin = await readFile(resolve(distRoot, relative));

      expect(served.equals(origin), urlPath).toBe(true);
    }
  });
});
