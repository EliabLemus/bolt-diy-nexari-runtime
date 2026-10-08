import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareNexariBrowserAssets } from './nexari-browser-assets-extract';

type TarEntry = {
  path: string;
  body?: string;
  type?: '0' | '2';
};

function writeString(target: Buffer, offset: number, length: number, value: string) {
  Buffer.from(value, 'utf8').copy(target, offset, 0, length);
}

function writeOctal(target: Buffer, offset: number, length: number, value: number) {
  writeString(target, offset, length, `${value.toString(8).padStart(length - 1, '0')}\0`);
}

function makeTar(entries: TarEntry[]) {
  const blocks: Buffer[] = [];

  for (const entry of entries) {
    const body = Buffer.from(entry.body ?? '', 'utf8');
    const header = Buffer.alloc(512, 0);
    writeString(header, 0, 100, entry.path);
    writeOctal(header, 100, 8, 0o644);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, body.length);
    writeOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    writeString(header, 156, 1, entry.type ?? '0');
    writeString(header, 257, 6, 'ustar\0');
    writeString(header, 263, 2, '00');

    let checksum = 0;

    for (const byte of header) {
      checksum += byte;
    }

    writeString(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }

  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createFixture(entries: TarEntry[]) {
  const directory = await mkdtemp(path.join(tmpdir(), 'nexari-browser-assets-extract-'));
  tempDirectories.push(directory);

  const archivePath = path.join(directory, 'browser-assets.tgz');
  const archive = makeTar(entries);
  await writeFile(archivePath, archive);

  return {
    archivePath,
    destinationDirectory: path.join(directory, 'browser-assets'),
    sha256: createHash('sha256').update(archive).digest('hex'),
  };
}

describe('prepareNexariBrowserAssets', () => {
  it('copies every regular tar payload byte-identically into a consumer-local destination', async () => {
    const fixture = await createFixture([
      { path: 'package/package.json', body: '{"name":"@nexari/vivari-browser-assets"}\n' },
      { path: 'package/dist/sw.js', body: 'self.skipWaiting();\n' },
      { path: 'package/dist/assets/kernel.mjs', body: 'export {};\n' },
      { path: 'package/dist/vendor/pyodide/kernel.wasm', body: '\0asm' },
    ]);

    await prepareNexariBrowserAssets(fixture);

    await expect(readFile(path.join(fixture.destinationDirectory, 'dist/sw.js'), 'utf8')).resolves.toBe(
      'self.skipWaiting();\n',
    );
    await expect(readFile(path.join(fixture.destinationDirectory, 'dist/assets/kernel.mjs'), 'utf8')).resolves.toBe(
      'export {};\n',
    );
    await expect(readFile(path.join(fixture.destinationDirectory, 'dist/vendor/pyodide/kernel.wasm'))).resolves.toEqual(
      Buffer.from('\0asm'),
    );
  });

  it('accepts repository-relative archive and destination paths', async () => {
    const fixture = await createFixture([{ path: 'package/dist/sw.js', body: 'safe\n' }]);

    await prepareNexariBrowserAssets({
      ...fixture,
      archivePath: path.relative(process.cwd(), fixture.archivePath),
      destinationDirectory: path.relative(process.cwd(), fixture.destinationDirectory),
    });

    await expect(readFile(path.join(fixture.destinationDirectory, 'dist/sw.js'), 'utf8')).resolves.toBe('safe\n');
  });

  it('verifies an existing byte-identical consumer destination without replacing it', async () => {
    const fixture = await createFixture([
      { path: 'package/dist/sw.js', body: 'safe\n' },
      { path: 'package/dist/assets/kernel.mjs', body: 'export {};\n' },
    ]);

    await prepareNexariBrowserAssets(fixture);
    await expect(prepareNexariBrowserAssets(fixture)).resolves.toBeUndefined();
  });

  it('accepts concurrent extraction when another consumer publishes the same verified destination first', async () => {
    const fixture = await createFixture([
      { path: 'package/dist/sw.js', body: 'safe\n' },
      { path: 'package/dist/assets/kernel.mjs', body: 'export {};\n' },
    ]);

    await expect(
      Promise.all([prepareNexariBrowserAssets(fixture), prepareNexariBrowserAssets(fixture)]),
    ).resolves.toEqual([undefined, undefined]);
    await expect(readFile(path.join(fixture.destinationDirectory, 'dist/sw.js'), 'utf8')).resolves.toBe('safe\n');
  });

  it('rejects divergent or symlinked existing destinations without replacing them', async () => {
    const fixture = await createFixture([{ path: 'package/dist/sw.js', body: 'safe\n' }]);
    await prepareNexariBrowserAssets(fixture);
    await writeFile(path.join(fixture.destinationDirectory, 'dist/sw.js'), 'tampered\n');

    await expect(prepareNexariBrowserAssets(fixture)).rejects.toThrow(
      'existing browser-assets destination does not match archive: dist/sw.js',
    );
    await expect(readFile(path.join(fixture.destinationDirectory, 'dist/sw.js'), 'utf8')).resolves.toBe('tampered\n');

    const symlinkFixture = await createFixture([{ path: 'package/dist/sw.js', body: 'safe\n' }]);
    const outsideDirectory = path.join(path.dirname(symlinkFixture.destinationDirectory), 'outside');
    await mkdir(outsideDirectory);
    await symlink(outsideDirectory, symlinkFixture.destinationDirectory);

    await expect(prepareNexariBrowserAssets(symlinkFixture)).rejects.toThrow(
      'refusing to use non-directory destination',
    );
  });

  it('rejects an existing destination that contains files absent from the pinned archive', async () => {
    const fixture = await createFixture([{ path: 'package/dist/sw.js', body: 'safe\n' }]);
    await prepareNexariBrowserAssets(fixture);
    await mkdir(path.join(fixture.destinationDirectory, 'dist/assets'), { recursive: true });
    await writeFile(path.join(fixture.destinationDirectory, 'dist/assets/extra.js'), 'stale\n');

    await expect(prepareNexariBrowserAssets(fixture)).rejects.toThrow(
      'existing browser-assets destination does not match archive: unexpected dist/assets/extra.js',
    );
    await expect(readFile(path.join(fixture.destinationDirectory, 'dist/assets/extra.js'), 'utf8')).resolves.toBe(
      'stale\n',
    );
  });

  it('uses a unique staging directory when a stale process-named directory already exists', async () => {
    const fixture = await createFixture([{ path: 'package/dist/sw.js', body: 'safe\n' }]);
    const staleStagingDirectory = path.join(
      path.dirname(fixture.destinationDirectory),
      `.${path.basename(fixture.destinationDirectory)}.staging-${process.pid}-`,
    );
    await mkdir(path.join(staleStagingDirectory, 'dist'), { recursive: true });
    await writeFile(path.join(staleStagingDirectory, 'dist', 'sw.js'), 'stale\n');

    await prepareNexariBrowserAssets(fixture);

    await expect(readFile(path.join(fixture.destinationDirectory, 'dist/sw.js'), 'utf8')).resolves.toBe('safe\n');
    await expect(readFile(path.join(staleStagingDirectory, 'dist/sw.js'), 'utf8')).resolves.toBe('stale\n');
  });

  it('rejects a symlinked destination ancestor before it writes outside the consumer tree', async () => {
    const fixture = await createFixture([{ path: 'package/dist/sw.js', body: 'safe\n' }]);
    const destinationRoot = path.dirname(fixture.destinationDirectory);
    const outsideDirectory = path.join(destinationRoot, 'outside');
    const linkedDirectory = path.join(destinationRoot, 'linked');
    await mkdir(outsideDirectory);
    await symlink(outsideDirectory, linkedDirectory);

    const linkedDestination = path.join(linkedDirectory, path.basename(fixture.destinationDirectory));

    await expect(prepareNexariBrowserAssets({ ...fixture, destinationDirectory: linkedDestination })).rejects.toThrow(
      'refusing to use symlinked destination ancestor',
    );
    await expect(
      readFile(path.join(outsideDirectory, path.basename(fixture.destinationDirectory), 'dist/sw.js')),
    ).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rejects a checksum mismatch before it creates a destination directory', async () => {
    const fixture = await createFixture([{ path: 'package/dist/sw.js', body: 'safe\n' }]);

    await expect(prepareNexariBrowserAssets({ ...fixture, sha256: '0'.repeat(64) })).rejects.toThrow('checksum');
    await expect(readFile(path.join(fixture.destinationDirectory, 'dist/sw.js'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rejects traversal and link members without publishing partial output', async () => {
    const fixture = await createFixture([
      { path: 'package/dist/sw.js', body: 'safe\n' },
      { path: 'package/dist/assets/link.js', body: '/outside', type: '2' },
      { path: 'package/dist/../../escape.js', body: 'escape\n' },
    ]);

    await expect(prepareNexariBrowserAssets(fixture)).rejects.toThrow('unsafe tar entry');
    await expect(readFile(path.join(fixture.destinationDirectory, 'dist/sw.js'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
