import { describe, expect, it } from 'vitest';

import {
  type ArchiveLimits,
  checkEntryName,
  DEFAULT_ARCHIVE_LIMITS,
  displayName,
  getUnixMode,
  isSymlinkMode,
  type ZipEntryInfo,
  validateArchiveEntries,
} from '../../../../src/main/services/imports/archivePolicy';

function entry(fileName: string, extra: Partial<ZipEntryInfo> = {}): ZipEntryInfo {
  return { fileName, uncompressedSize: 10, compressedSize: 5, isEncrypted: false, ...extra };
}

const SMALL: ArchiveLimits = {
  ...DEFAULT_ARCHIVE_LIMITS,
  maxEntries: 3,
  maxEntryBytes: 100,
  maxTotalUncompressedBytes: 150,
};

describe('checkEntryName', () => {
  it('accepts ordinary names and directory entries', () => {
    expect(checkEntryName('results.json', 255)).toBeNull();
    expect(checkEntryName('traces/case-1/with-1.jsonl', 255)).toBeNull();
    expect(checkEntryName('traces/', 255)).toBeNull();
  });

  it.each([
    ['', 'empty name'],
    ['/etc/passwd', 'absolute path'],
    ['C:/Windows/x', 'drive-letter path'],
    ['c:evil', 'drive-letter path'],
    ['a\\b', 'contains a backslash'],
    ['../x', 'path traversal segment'],
    ['a/../x', 'path traversal segment'],
    ['a/./x', 'path traversal segment'],
    ['a//x', 'empty path segment'],
    ['a\u0000b', 'contains control characters'],
    ['a\nb', 'contains control characters'],
  ])('rejects %j', (name, reason) => {
    expect(checkEntryName(name, 255)).toBe(reason);
  });

  it('rejects overlong names', () => {
    expect(checkEntryName('a'.repeat(256), 255)).toContain('longer than');
  });
});

describe('unix mode helpers', () => {
  const UNIX = 3 << 8;
  const WINDOWS = 0;

  it('reads the mode only for Unix-made archives', () => {
    expect(getUnixMode(UNIX | 30, (0o100644 << 16) >>> 0)).toBe(0o100644);
    expect(getUnixMode(WINDOWS | 20, (0o120777 << 16) >>> 0)).toBeUndefined();
  });

  it('detects symlinks', () => {
    expect(isSymlinkMode(0o120777)).toBe(true);
    expect(isSymlinkMode(0o100644)).toBe(false);
    expect(isSymlinkMode(0o040755)).toBe(false);
    expect(isSymlinkMode(undefined)).toBe(false);
  });
});

describe('displayName', () => {
  it('strips control characters and truncates', () => {
    expect(displayName('a\u0000b\nc')).toBe('a?b?c');
    expect(displayName('x'.repeat(200))).toHaveLength(100);
  });
});

describe('validateArchiveEntries', () => {
  it('accepts a clean archive', () => {
    const result = validateArchiveEntries([entry('results.json'), entry('traces/')], SMALL);
    expect(result.errors).toEqual([]);
  });

  it('rejects an empty archive', () => {
    expect(validateArchiveEntries([]).errors).toEqual(['The archive is empty']);
  });

  it('rejects too many entries without inspecting them', () => {
    const entries = ['a', 'b', 'c', 'd'].map((n) => entry(n));
    const { errors } = validateArchiveEntries(entries, SMALL);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('4 entries');
  });

  it('flags unsafe names', () => {
    const { errors } = validateArchiveEntries([entry('../evil'), entry('/abs')], SMALL);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain('path traversal');
    expect(errors[1]).toContain('absolute path');
  });

  it('flags encrypted entries', () => {
    const { errors } = validateArchiveEntries([entry('a', { isEncrypted: true })], SMALL);
    expect(errors).toEqual(['Entry "a" is encrypted']);
  });

  it('flags symlinks and special files', () => {
    const { errors } = validateArchiveEntries(
      [entry('link', { unixMode: 0o120777 }), entry('fifo', { unixMode: 0o010644 })],
      SMALL
    );
    expect(errors).toEqual([
      'Entry "link" is a symbolic link',
      'Entry "fifo" is not a regular file or directory',
    ]);
  });

  it('accepts regular files and directories with unix modes', () => {
    const { errors } = validateArchiveEntries(
      [entry('d/', { unixMode: 0o040755 }), entry('d/f', { unixMode: 0o100644 })],
      SMALL
    );
    expect(errors).toEqual([]);
  });

  it('flags duplicates, including case-only differences', () => {
    const { errors } = validateArchiveEntries([entry('a.json'), entry('A.JSON')], SMALL);
    expect(errors).toEqual(['Duplicate entry "A.JSON"']);
  });

  it('flags an entry that is too large when unzipped', () => {
    const { errors } = validateArchiveEntries([entry('big', { uncompressedSize: 101 })], SMALL);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('larger than');
  });

  it('flags a total that exceeds the limit even when each entry is fine', () => {
    const entries = [entry('a', { uncompressedSize: 80 }), entry('b', { uncompressedSize: 80 })];
    const { errors } = validateArchiveEntries(entries, SMALL);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('expands to');
  });

  it('rejects negative or non-finite sizes', () => {
    const { errors } = validateArchiveEntries(
      [entry('a', { uncompressedSize: -1 }), entry('b', { uncompressedSize: Number.NaN })],
      SMALL
    );
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain('invalid size');
  });

  it('caps the number of reported problems', () => {
    const limits = { ...DEFAULT_ARCHIVE_LIMITS, maxEntries: 1000 };
    const entries = Array.from({ length: 200 }, (_, i) => entry(`../x${i}`));
    const { errors } = validateArchiveEntries(entries, limits);
    expect(errors).toHaveLength(51);
    expect(errors[50]).toBe('...and 150 more problems');
  });

  it('never echoes control characters from names', () => {
    const { errors } = validateArchiveEntries([entry('../a\u0000b')], SMALL);
    // eslint-disable-next-line no-control-regex -- asserting their absence
    expect(errors.join('')).not.toMatch(/[\u0000-\u001f]/);
  });
});
