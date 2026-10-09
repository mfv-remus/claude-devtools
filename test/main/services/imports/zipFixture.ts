/**
 * Minimal zip writer for tests (stored entries only). Lets tests craft hostile archives
 * (unsafe names, symlinks, encryption flag, lying sizes) without a zip dependency.
 * Not for production use.
 */

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export interface FakeZipEntry {
  name: string;
  data?: string | Buffer;
  /** Unix st_mode, e.g. 0o120777 for a symlink. Sets "made by Unix". */
  unixMode?: number;
  /** Sets general purpose flag bit 0 (traditional encryption) and adds the 12-byte header */
  encrypted?: boolean;
  /** With `encrypted`: omit the header, producing a size mismatch the zip library rejects */
  malformedEncryption?: boolean;
  /** Written in both headers instead of the real size (to test size validation) */
  declaredSize?: number;
  /** Compression method written in the headers (data stays stored) */
  method?: number;
}

export function buildZip(entries: FakeZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.data ?? '');
    // Traditional encryption prefixes stored data with a 12-byte header (yauzl checks this)
    const stored =
      entry.malformedEncryption || !entry.encrypted
        ? data
        : Buffer.concat([Buffer.alloc(12), data]);
    const size = entry.declaredSize ?? data.length;
    const flags = (entry.encrypted ? 1 : 0) | 0x0800; // bit 11: UTF-8 names
    const method = entry.method ?? 0;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, stored);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(entry.unixMode === undefined ? 20 : (3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.unixMode ?? 0) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + stored.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}
