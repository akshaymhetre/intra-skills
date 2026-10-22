// A deterministic ZIP writer for plugin archives (docs/API.md "Claude Code plugin marketplace").
// The same files always give the same bytes: entries sorted by path, every timestamp
// 1980-01-01 00:00, unix mode in the external attributes, DEFLATE at a fixed level, no extra
// fields and no comments. No ZIP64: a bundle is far below 4 GiB and 65535 entries.
import { crc32, deflateRawSync } from "node:zlib";

export interface ZipEntry {
  path: string;
  /** Unix permission bits, e.g. 0o644 or 0o755. */
  mode: number;
  content: Uint8Array;
}

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const END_SIG = 0x06054b50;
const VERSION_NEEDED = 20; // 2.0: DEFLATE
const VERSION_MADE_BY = (3 << 8) | VERSION_NEEDED; // 3 = unix, so external attributes carry the mode
const FLAG_UTF8 = 0x0800;
const METHOD_DEFLATE = 8;
const DOS_TIME = 0; // 00:00:00
const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01
export const ZIP_DEFLATE_LEVEL = 9;
const S_IFREG = 0o100000;

/** Bytewise order of the UTF-8 paths, so the order never depends on locale. */
function byPath(a: ZipEntry, b: ZipEntry): number {
  return Buffer.compare(Buffer.from(a.path, "utf8"), Buffer.from(b.path, "utf8"));
}

export function buildZip(entries: ZipEntry[]): Buffer {
  const sorted = [...entries].sort(byPath);
  if (sorted.length > 0xffff) throw new Error("too many entries for a ZIP without ZIP64");
  const seen = new Set<string>();
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of sorted) {
    if (seen.has(e.path)) throw new Error(`duplicate ZIP entry ${e.path}`);
    seen.add(e.path);
    const name = Buffer.from(e.path, "utf8");
    const data = Buffer.from(e.content.buffer, e.content.byteOffset, e.content.byteLength);
    const crc = crc32(data) >>> 0;
    const packed = deflateRawSync(data, { level: ZIP_DEFLATE_LEVEL });
    if (packed.length > 0xfffffffe || data.length > 0xfffffffe || offset > 0xfffffffe) throw new Error("ZIP entry too large without ZIP64");

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(VERSION_NEEDED, 4);
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(METHOD_DEFLATE, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra field length
    locals.push(local, name, packed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_SIG, 0);
    central.writeUInt16LE(VERSION_MADE_BY, 4);
    central.writeUInt16LE(VERSION_NEEDED, 6);
    central.writeUInt16LE(FLAG_UTF8, 8);
    central.writeUInt16LE(METHOD_DEFLATE, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk number start
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE((((S_IFREG | (e.mode & 0o7777)) << 16) >>> 0), 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + packed.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_SIG, 0);
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // disk with the central directory
  end.writeUInt16LE(sorted.length, 8);
  end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // comment length
  return Buffer.concat([...locals, cd, end]);
}
