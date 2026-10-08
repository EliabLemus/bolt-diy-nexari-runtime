import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

export interface PrepareNexariBrowserAssetsOptions {
  archivePath: string;
  destinationDirectory: string;
  sha256: string;
}

type TarPayload = {
  destinationPath: string;
  bytes: Buffer;
};

const TAR_BLOCK_SIZE = 512;
const PACKAGE_PREFIX = 'package/';

function unsafeTarEntry(name: string): Error {
  return new Error(`unsafe tar entry: ${name}`);
}

function readNullTerminatedString(block: Buffer, offset: number, length: number): string {
  return block
    .subarray(offset, offset + length)
    .toString('utf8')
    .replace(/\0.*$/, '');
}

function readTarSize(block: Buffer): number {
  const raw = readNullTerminatedString(block, 124, 12).trim();

  if (!/^[0-7]*$/.test(raw)) {
    throw new Error('unsafe tar entry: invalid size');
  }

  return raw ? Number.parseInt(raw, 8) : 0;
}

function isZeroBlock(block: Buffer): boolean {
  return block.every((byte) => byte === 0);
}

function outputPathForTarEntry(name: string): string {
  if (!name.startsWith(PACKAGE_PREFIX)) {
    throw unsafeTarEntry(name);
  }

  const relativePath = name.slice(PACKAGE_PREFIX.length);
  const normalized = path.posix.normalize(relativePath);

  if (
    !relativePath ||
    path.posix.isAbsolute(relativePath) ||
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized !== relativePath ||
    (normalized !== 'package.json' && !normalized.startsWith('dist/'))
  ) {
    throw unsafeTarEntry(name);
  }

  return normalized;
}

function readTarPayloads(archive: Buffer): TarPayload[] {
  const decompressed = gunzipSync(archive);
  const payloads: TarPayload[] = [];
  const seenPaths = new Set<string>();
  let offset = 0;

  while (offset + TAR_BLOCK_SIZE <= decompressed.length) {
    const header = decompressed.subarray(offset, offset + TAR_BLOCK_SIZE);

    if (isZeroBlock(header)) {
      return payloads;
    }

    const name = readNullTerminatedString(header, 0, 100);
    const type = header[156];
    const size = readTarSize(header);
    const bodyStart = offset + TAR_BLOCK_SIZE;
    const bodyEnd = bodyStart + size;

    if (!name || (type !== 0 && type !== '0'.charCodeAt(0)) || bodyEnd > decompressed.length) {
      throw unsafeTarEntry(name || '<unnamed>');
    }

    const destinationPath = outputPathForTarEntry(name);

    if (seenPaths.has(destinationPath)) {
      throw unsafeTarEntry(name);
    }

    seenPaths.add(destinationPath);
    payloads.push({ destinationPath, bytes: decompressed.subarray(bodyStart, bodyEnd) });
    offset = bodyStart + Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
  }

  throw new Error('unsafe tar entry: missing end-of-archive marker');
}

function resolveContained(root: string, relativePath: string): string {
  const candidate = path.resolve(root, relativePath);

  if (candidate === root || !candidate.startsWith(`${root}${path.sep}`)) {
    throw unsafeTarEntry(relativePath);
  }

  return candidate;
}

async function rejectSymlinkedDestinationPath(destinationRoot: string, destinationDirectory: string): Promise<void> {
  const relativeDestination = path.relative(destinationRoot, destinationDirectory);

  if (
    !relativeDestination ||
    relativeDestination === '..' ||
    relativeDestination.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeDestination)
  ) {
    throw new Error(`refusing to use destination outside archive root: ${destinationDirectory}`);
  }

  let current = destinationRoot;

  for (const segment of relativeDestination.split(path.sep)) {
    const stats = await lstat(current);

    if (stats.isSymbolicLink()) {
      throw new Error(`refusing to use symlinked destination ancestor: ${current}`);
    }

    current = path.join(current, segment);
  }
}

async function assertExistingDestinationMatchesPayloadSet(
  destinationDirectory: string,
  expectedPaths: Set<string>,
  relativeDirectory = '',
): Promise<void> {
  const directory = relativeDirectory
    ? resolveContained(destinationDirectory, relativeDirectory)
    : destinationDirectory;

  for (const entry of await readdir(directory)) {
    const relativePath = path.posix.join(relativeDirectory, entry);
    const target = resolveContained(destinationDirectory, relativePath);
    const stats = await lstat(target);

    if (stats.isSymbolicLink()) {
      throw new Error(`existing browser-assets destination does not match archive: symlink ${relativePath}`);
    }

    if (stats.isDirectory()) {
      await assertExistingDestinationMatchesPayloadSet(destinationDirectory, expectedPaths, relativePath);
      continue;
    }

    if (!stats.isFile() || !expectedPaths.has(relativePath)) {
      throw new Error(`existing browser-assets destination does not match archive: unexpected ${relativePath}`);
    }
  }
}

async function verifyExistingDestination(destinationDirectory: string, payloads: TarPayload[]): Promise<boolean> {
  try {
    const stats = await lstat(destinationDirectory);

    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error(`refusing to use non-directory destination: ${destinationDirectory}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }

    throw error;
  }

  await assertExistingDestinationMatchesPayloadSet(
    destinationDirectory,
    new Set(payloads.map((payload) => payload.destinationPath)),
  );

  for (const payload of payloads) {
    const target = resolveContained(destinationDirectory, payload.destinationPath);
    const stats = await lstat(target);

    if (!stats.isFile() || stats.isSymbolicLink() || !(await readFile(target)).equals(payload.bytes)) {
      throw new Error(`existing browser-assets destination does not match archive: ${payload.destinationPath}`);
    }
  }

  return true;
}

/**
 * Expand the pinned browser-assets archive without trusting archive path or
 * link metadata. A failed validation never publishes an incomplete destination.
 */
export async function prepareNexariBrowserAssets({
  archivePath,
  destinationDirectory,
  sha256,
}: PrepareNexariBrowserAssetsOptions): Promise<void> {
  const resolvedArchivePath = path.resolve(archivePath);
  const resolvedDestinationDirectory = path.resolve(destinationDirectory);

  await rejectSymlinkedDestinationPath(path.dirname(resolvedArchivePath), resolvedDestinationDirectory);

  const archive = await readFile(resolvedArchivePath);
  const actualSha256 = createHash('sha256').update(archive).digest('hex');

  if (actualSha256 !== sha256) {
    throw new Error(`browser-assets checksum mismatch: expected ${sha256}, received ${actualSha256}`);
  }

  const payloads = readTarPayloads(archive);

  if (payloads.length === 0) {
    throw new Error('unsafe tar entry: archive has no payloads');
  }

  if (await verifyExistingDestination(resolvedDestinationDirectory, payloads)) {
    return;
  }

  const destinationParent = path.dirname(resolvedDestinationDirectory);
  const destinationName = path.basename(resolvedDestinationDirectory);
  const stagingDirectory = await mkdtemp(path.join(destinationParent, `.${destinationName}.staging-`));

  try {
    for (const payload of payloads) {
      const target = resolveContained(stagingDirectory, payload.destinationPath);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, payload.bytes, { flag: 'wx' });
    }

    try {
      await rename(stagingDirectory, resolvedDestinationDirectory);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;

      if (
        (code === 'EEXIST' || code === 'ENOTEMPTY') &&
        (await verifyExistingDestination(resolvedDestinationDirectory, payloads))
      ) {
        return;
      }

      throw error;
    }
  } catch (error) {
    await rm(stagingDirectory, { recursive: true, force: true });
    throw error;
  }
}
