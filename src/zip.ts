/**
 * Minimal ZIP writer (stored, no compression). Audio and video are already
 * compressed, so storing keeps it fast and the archive streams from Blobs
 * without loading every file into memory at once.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array, seed = 0): number {
  let crc = ~seed >>> 0;
  for (let i = 0; i < bytes.length; i += 1) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return ~crc >>> 0;
}

async function blobCrc(blob: Blob): Promise<number> {
  let crc = 0;
  const step = 8 * 1024 * 1024;
  for (let offset = 0; offset < blob.size; offset += step) {
    crc = crc32(new Uint8Array(await blob.slice(offset, offset + step).arrayBuffer()), crc);
  }
  return crc;
}

function dosTime(date: Date): { time: number; date: number } {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/** Unique names inside the archive ("a.mp3", "a (2).mp3", …). */
export function uniqueNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((name) => {
    const count = seen.get(name) ?? 0;
    seen.set(name, count + 1);
    if (!count) return name;
    const dot = name.lastIndexOf('.');
    return dot > 0 ? `${name.slice(0, dot)} (${count + 1})${name.slice(dot)}` : `${name} (${count + 1})`;
  });
}

export async function createZip(files: { name: string; blob: Blob }[], now = new Date()): Promise<Blob> {
  if (files.some(({ blob }) => blob.size >= 0xffffffff) || files.length >= 0xffff) {
    throw new Error('These files are too large for a ZIP archive. Download them one by one.');
  }
  const encoder = new TextEncoder();
  const { time, date } = dosTime(now);
  const parts: BlobPart[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const names = uniqueNames(files.map(({ name }) => name));
  for (const [index, { blob }] of files.entries()) {
    const name = encoder.encode(names[index]);
    const crc = await blobCrc(blob);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true);
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, blob.size, true);
    local.setUint32(22, blob.size, true);
    local.setUint16(26, name.length, true);
    parts.push(local.buffer, name, blob);

    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(8, 0x0800, true);
    entry.setUint16(12, time, true);
    entry.setUint16(14, date, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, blob.size, true);
    entry.setUint32(24, blob.size, true);
    entry.setUint16(28, name.length, true);
    entry.setUint32(42, offset, true);
    const record = new Uint8Array(46 + name.length);
    record.set(new Uint8Array(entry.buffer), 0);
    record.set(name, 46);
    central.push(record);
    offset += 30 + name.length + blob.size;
  }
  const centralSize = central.reduce((sum, record) => sum + record.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central as BlobPart[], end.buffer], { type: 'application/zip' });
}

interface ZipEntry {
  name: string;
  blob: Blob;
}

/**
 * Read a ZIP archive written by this app (stored) or by common tools
 * (deflated). ZIP64 and encrypted entries are not supported.
 */
export async function readZip(archive: Blob): Promise<ZipEntry[]> {
  const view = new DataView(await archive.arrayBuffer());
  const length = view.byteLength;
  let eocd = -1;
  for (let at = length - 22; at >= Math.max(0, length - 66_000); at -= 1) {
    if (view.getUint32(at, true) === 0x06054b50) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) throw new Error('This is not a readable ZIP archive.');
  const count = view.getUint16(eocd + 10, true);
  const directorySize = view.getUint32(eocd + 12, true);
  const directoryOffset = view.getUint32(eocd + 16, true);
  if (directoryOffset + directorySize > length) throw new Error('The ZIP central directory is incomplete.');
  const encoder = new TextDecoder();
  const entries: ZipEntry[] = [];
  let cursor = directoryOffset;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > length || view.getUint32(cursor, true) !== 0x02014b50) break;
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = encoder.decode(new Uint8Array(view.buffer, view.byteOffset + cursor + 46, nameLength));
    cursor += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/')) continue;
    if (localOffset + 30 > length || view.getUint32(localOffset, true) !== 0x04034b50) {
      throw new Error(`The ZIP entry ${name} is corrupt.`);
    }
    const localName = view.getUint16(localOffset + 26, true);
    const localExtra = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + localName + localExtra;
    const end = start + compressedSize;
    if (end > length) throw new Error(`The ZIP entry ${name} is truncated.`);
    const raw = archive.slice(start, end);
    if (!compressedSize) {
      entries.push({ name, blob: new Blob([]) });
    } else if (method === 0) {
      entries.push({ name, blob: raw });
    } else if (method === 8) {
      const stream = raw.stream().pipeThrough(new DecompressionStream('deflate-raw'));
      entries.push({ name, blob: new Blob([await new Response(stream).arrayBuffer()]) });
    } else {
      throw new Error(`The ZIP entry ${name} uses an unsupported compression method (${method}).`);
    }
  }
  if (!entries.length) throw new Error('The ZIP archive is empty.');
  return entries;
}
