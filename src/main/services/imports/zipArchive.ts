/**
 * Thin wrapper around yauzl: list entries (no extraction), read one small entry as text,
 * and extract an allow-listed set of entries.
 *
 * Everything that decides what is acceptable lives in archivePolicy/bundleValidators;
 * this file only adapts yauzl and enforces byte counts while streaming. yauzl itself
 * rejects unsafe entry names and, with validateEntrySizes, entries whose real size
 * differs from the declared one. It does not verify CRC-32, does not support encryption
 * and only handles stored/deflated entries; all of those surface here as errors.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import * as yauzl from 'yauzl';

import {
  type ArchiveLimits,
  displayName,
  getUnixMode,
  isDirectoryEntry,
  type ZipEntryInfo,
} from './archivePolicy';

export class ZipError extends Error {}

const OPEN_OPTIONS: yauzl.Options = {
  lazyEntries: true,
  decodeStrings: true,
  validateEntrySizes: true,
  strictFileNames: true,
  autoClose: false,
};

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return displayName(message);
}

async function openZip(zipPath: string): Promise<yauzl.ZipFile> {
  try {
    return await yauzl.openPromise(zipPath, OPEN_OPTIONS);
  } catch (error) {
    throw new ZipError(`Not a valid zip archive: ${describe(error)}`);
  }
}

function toInfo(entry: yauzl.Entry): ZipEntryInfo {
  return {
    fileName: entry.fileName,
    uncompressedSize: entry.uncompressedSize,
    compressedSize: entry.compressedSize,
    isEncrypted: entry.isEncrypted(),
    unixMode: getUnixMode(entry.versionMadeBy, entry.externalFileAttributes),
  };
}

/** Lists the entries of the archive without reading any file data. */
export async function listZipEntries(
  zipPath: string,
  limits: ArchiveLimits
): Promise<ZipEntryInfo[]> {
  const stat = await fs.promises.stat(zipPath);
  if (stat.size > limits.maxZipBytes) {
    throw new ZipError(
      `The zip file is ${Math.round(stat.size / (1024 * 1024))} MB; ` +
        `the limit is ${Math.round(limits.maxZipBytes / (1024 * 1024))} MB`
    );
  }

  const zipfile = await openZip(zipPath);
  try {
    // Checked before iterating: the entry list itself must not be a resource problem.
    if (zipfile.entryCount > limits.maxEntries) {
      throw new ZipError(
        `The archive has ${zipfile.entryCount} entries; the limit is ${limits.maxEntries}`
      );
    }
    const entries: ZipEntryInfo[] = [];
    for await (const entry of zipfile.eachEntry()) {
      entries.push(toInfo(entry));
    }
    return entries;
  } catch (error) {
    if (error instanceof ZipError) throw error;
    throw new ZipError(`Not a valid zip archive: ${describe(error)}`);
  } finally {
    zipfile.close();
  }
}

/** Counts bytes and fails the stream as soon as a limit is exceeded. */
class ByteLimit extends Transform {
  private seen = 0;

  constructor(
    private readonly maxBytes: number,
    private readonly onBytes: (n: number) => void
  ) {
    super();
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null, data?: Buffer) => void
  ): void {
    this.seen += chunk.length;
    this.onBytes(chunk.length);
    if (this.seen > this.maxBytes) {
      callback(new ZipError('An entry is larger than its declared size'));
      return;
    }
    callback(null, chunk);
  }
}

/** Reads one entry fully as UTF-8 text, refusing anything larger than `maxBytes`. */
export async function readZipEntryText(
  zipPath: string,
  entryName: string,
  maxBytes: number
): Promise<string> {
  const zipfile = await openZip(zipPath);
  try {
    for await (const entry of zipfile.eachEntry()) {
      if (entry.fileName !== entryName) continue;
      if (entry.uncompressedSize > maxBytes) {
        throw new ZipError(`${displayName(entryName)} is larger than the allowed size`);
      }
      const stream = await zipfile.openReadStreamPromise(entry);
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of stream) {
        total += (chunk as Buffer).length;
        if (total > maxBytes) {
          stream.destroy();
          throw new ZipError(`${displayName(entryName)} is larger than the allowed size`);
        }
        chunks.push(chunk as Buffer);
      }
      return Buffer.concat(chunks).toString('utf8');
    }
    throw new ZipError(`${displayName(entryName)} was not found in the archive`);
  } catch (error) {
    if (error instanceof ZipError) throw error;
    throw new ZipError(`Could not read ${displayName(entryName)}: ${describe(error)}`);
  } finally {
    zipfile.close();
  }
}

/**
 * Extracts exactly the entries named in `names` into `destDir`.
 * Files are created with 'wx' (never overwrite) and mode 0644. Directories are created
 * as needed from the entry path. Throws when any requested entry is missing or too big.
 */
export async function extractZipEntries(
  zipPath: string,
  destDir: string,
  names: ReadonlySet<string>,
  limits: ArchiveLimits
): Promise<void> {
  const root = path.resolve(destDir);
  const zipfile = await openZip(zipPath);
  const done = new Set<string>();
  let total = 0;

  try {
    for await (const entry of zipfile.eachEntry()) {
      if (!names.has(entry.fileName) || isDirectoryEntry(entry)) continue;

      const target = path.resolve(root, entry.fileName);
      if (!isInside(root, target)) {
        throw new ZipError(`Entry ${displayName(entry.fileName)} resolves outside the target`);
      }
      await fs.promises.mkdir(path.dirname(target), { recursive: true, mode: 0o755 });

      const perEntryMax = Math.min(entry.uncompressedSize, limits.maxEntryBytes);
      const source = await zipfile.openReadStreamPromise(entry);
      const counter = new ByteLimit(perEntryMax, (n) => {
        total += n;
        if (total > limits.maxTotalUncompressedBytes) {
          counter.destroy(new ZipError('The archive expands beyond the allowed total size'));
        }
      });
      const sink = fs.createWriteStream(target, { flags: 'wx', mode: 0o644 });
      await pipeline(source, counter, sink);
      done.add(entry.fileName);
    }
  } catch (error) {
    if (error instanceof ZipError) throw error;
    throw new ZipError(`Failed to extract the archive: ${describe(error)}`);
  } finally {
    zipfile.close();
  }

  for (const name of names) {
    if (!done.has(name)) {
      throw new ZipError(`${displayName(name)} was not found in the archive`);
    }
  }
}
