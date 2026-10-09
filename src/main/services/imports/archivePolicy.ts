/**
 * Policy checks for the entry list of an uploaded zip, applied BEFORE anything is
 * written to disk. Pure functions over plain entry descriptors so they do not depend
 * on the zip library (the extractor adapts library entries to `ZipEntryInfo`).
 *
 * The zip library validates names too, but bomb heuristics, symlinks, encryption and
 * the layout whitelist are our responsibility.
 */

export interface ZipEntryInfo {
  /** Entry name exactly as stored in the archive */
  fileName: string;
  uncompressedSize: number;
  compressedSize: number;
  isEncrypted: boolean;
  /** Unix st_mode when the archive was made on Unix (see `getUnixMode`), else undefined */
  unixMode?: number;
}

export interface ArchiveLimits {
  /** Max size of the uploaded zip itself */
  maxZipBytes: number;
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalUncompressedBytes: number;
  maxNameLength: number;
}

export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = {
  maxZipBytes: 200 * 1024 * 1024,
  maxEntries: 5000,
  maxEntryBytes: 256 * 1024 * 1024,
  maxTotalUncompressedBytes: 1024 * 1024 * 1024,
  maxNameLength: 255,
};

/** Cap on reported problems so a hostile archive cannot produce a huge error list. */
const MAX_REPORTED_ERRORS = 50;

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;
const MADE_BY_UNIX = 3;

/**
 * Extracts the Unix mode from zip "version made by" / "external file attributes".
 * Only meaningful when the archive was created on Unix (host system 3); returns
 * undefined otherwise (e.g. Windows-made archives carry no mode).
 */
export function getUnixMode(
  versionMadeBy: number,
  externalFileAttributes: number
): number | undefined {
  if (versionMadeBy >>> 8 !== MADE_BY_UNIX) {
    return undefined;
  }
  return (externalFileAttributes >>> 16) & 0xffff;
}

export function isSymlinkMode(mode: number | undefined): boolean {
  return mode !== undefined && (mode & S_IFMT) === S_IFLNK;
}

function isUnsupportedFileType(mode: number | undefined): boolean {
  if (mode === undefined) return false;
  const type = mode & S_IFMT;
  // type 0 appears in archives that only set permission bits
  return type !== 0 && type !== S_IFREG && type !== S_IFDIR;
}

function isControlCode(code: number): boolean {
  return code < 0x20 || code === 0x7f;
}

export function hasControlCharacters(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    if (isControlCode(value.charCodeAt(i))) return true;
  }
  return false;
}

/** Makes an entry name safe to show in an error message. */
export function displayName(name: string): string {
  let cleaned = '';
  for (let i = 0; i < name.length; i++) {
    cleaned += isControlCode(name.charCodeAt(i)) ? '?' : name[i];
  }
  return cleaned.length > 100 ? `${cleaned.slice(0, 97)}...` : cleaned;
}

/**
 * Returns a reason when the entry name is unsafe, or null when it is acceptable.
 * Directory entries (trailing slash) are checked without the trailing slash.
 */
export function checkEntryName(name: string, maxLength: number): string | null {
  if (name.length === 0) return 'empty name';
  if (name.length > maxLength) return `name longer than ${maxLength} characters`;
  if (hasControlCharacters(name)) return 'contains control characters';
  if (name.includes('\\')) return 'contains a backslash';
  if (name.startsWith('/')) return 'absolute path';
  if (/^[a-zA-Z]:/.test(name)) return 'drive-letter path';

  const body = name.endsWith('/') ? name.slice(0, -1) : name;
  for (const segment of body.split('/')) {
    if (segment === '') return 'empty path segment';
    if (segment === '.' || segment === '..') return 'path traversal segment';
  }
  return null;
}

export function isDirectoryEntry(entry: Pick<ZipEntryInfo, 'fileName'>): boolean {
  return entry.fileName.endsWith('/');
}

export interface ArchiveCheckResult {
  errors: string[];
}

/**
 * Checks the whole entry list against the limits. Collects all problems (up to a cap)
 * instead of stopping at the first, so the user can fix everything in one go.
 */
export function validateArchiveEntries(
  entries: readonly ZipEntryInfo[],
  limits: ArchiveLimits = DEFAULT_ARCHIVE_LIMITS
): ArchiveCheckResult {
  const errors: string[] = [];
  let omitted = 0;
  const add = (message: string): void => {
    if (errors.length < MAX_REPORTED_ERRORS) {
      errors.push(message);
    } else {
      omitted++;
    }
  };

  if (entries.length === 0) {
    return { errors: ['The archive is empty'] };
  }
  if (entries.length > limits.maxEntries) {
    // Do not inspect further: the entry list itself is the problem.
    return {
      errors: [`The archive has ${entries.length} entries; the limit is ${limits.maxEntries}`],
    };
  }

  const seen = new Set<string>();
  let total = 0;

  for (const entry of entries) {
    const label = displayName(entry.fileName);

    const nameProblem = checkEntryName(entry.fileName, limits.maxNameLength);
    if (nameProblem) {
      add(`Unsafe entry "${label}": ${nameProblem}`);
      continue;
    }
    if (entry.isEncrypted) {
      add(`Entry "${label}" is encrypted`);
    }
    if (isSymlinkMode(entry.unixMode)) {
      add(`Entry "${label}" is a symbolic link`);
      continue;
    }
    if (isUnsupportedFileType(entry.unixMode)) {
      add(`Entry "${label}" is not a regular file or directory`);
      continue;
    }

    // Case-insensitive on purpose: two names differing only by case overwrite each other
    // on case-insensitive filesystems (macOS default).
    const key = entry.fileName.normalize('NFC').toLowerCase().replace(/\/$/, '');
    if (seen.has(key)) {
      add(`Duplicate entry "${label}"`);
    }
    seen.add(key);

    if (isDirectoryEntry(entry)) continue;

    if (!Number.isFinite(entry.uncompressedSize) || entry.uncompressedSize < 0) {
      add(`Entry "${label}" has an invalid size`);
      continue;
    }
    if (entry.uncompressedSize > limits.maxEntryBytes) {
      add(`Entry "${label}" is larger than ${formatMb(limits.maxEntryBytes)} when unzipped`);
    }
    total += entry.uncompressedSize;
  }

  if (total > limits.maxTotalUncompressedBytes) {
    add(
      `The archive expands to ${formatMb(total)}; the limit is ` +
        `${formatMb(limits.maxTotalUncompressedBytes)}`
    );
  }
  if (omitted > 0) {
    errors.push(`...and ${omitted} more problems`);
  }
  return { errors };
}

function formatMb(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}
