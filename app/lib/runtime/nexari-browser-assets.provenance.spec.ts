import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
const vendorDirectory = path.join(repositoryRoot, 'vendor/nexari-browser-stack');
const archiveFilename = 'nexari-vivari-browser-assets-0.1.0-dev.tgz';
const archivePath = path.join(vendorDirectory, archiveFilename);
const expectedSha256 = '6c97fb8ea6e82ffa3fa5ce27d225d38885e685712ec854669f994d4548b134da';
const expectedProducerCommit = '4e9e71708ffbd3e11aadf6a3fec11ea27f552210';

type VendorManifest = {
  packages: Array<{
    name: string;
    filename: string;
    version: string;
    sha256?: string;
    producerCommit?: string;
  }>;
};

describe('Nexari browser-assets provenance', () => {
  it('pins the verified browser-assets archive without a mutable package dependency', async () => {
    const manifest = JSON.parse(await readFile(path.join(vendorDirectory, 'manifest.json'), 'utf8')) as VendorManifest;
    const browserAssets = manifest.packages.find((entry) => entry.name === '@nexari/vivari-browser-assets');

    expect(browserAssets).toMatchObject({
      name: '@nexari/vivari-browser-assets',
      filename: archiveFilename,
      version: '0.1.0-dev',
      sha256: expectedSha256,
      producerCommit: expectedProducerCommit,
    });

    const archive = await readFile(archivePath);
    expect(createHash('sha256').update(archive).digest('hex')).toBe(expectedSha256);

    const stdout = execFileSync('tar', ['-xOzf', archivePath, 'package/package.json'], { encoding: 'utf8' });
    expect(JSON.parse(stdout)).toMatchObject({
      name: '@nexari/vivari-browser-assets',
      version: '0.1.0-dev',
      private: true,
      nexari: { vivariCoreVersion: '1.0.0' },
    });

    const packageJson = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(packageJson.dependencies['@nexari/vivari-browser-assets']).toBeUndefined();
  });
});
