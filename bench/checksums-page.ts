// Metadata viewer checksums (src/file-metadata.ts) on large inputs.
//
// Browser (Vite dev server): const m = await import('/bench/checksums-page.ts'); await m.run([10, 50, 100])
// Bun:                       bun bench/checksums-page.ts 10 50 100
//
// Times each part of checksumsFor() separately (read, SHA-1/256/512 in
// parallel via WebCrypto, MD5 via spark-md5, CRC32, Adler32) and compares the
// byte-wise CRC32 with a slice-by-8 prototype that returns the same value.
import SparkMD5 from 'spark-md5';
import { adler32Hex, checksumsFor, crc32Hex } from '../src/file-metadata';

const tables: Uint32Array[] = [];
function sliceTables(): Uint32Array[] {
  if (tables.length) return tables;
  const base = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    base[index] = value >>> 0;
  }
  tables.push(base);
  for (let table = 1; table < 8; table += 1) {
    const next = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) next[index] = (tables[table - 1][index] >>> 8) ^ base[tables[table - 1][index] & 0xff];
    tables.push(next);
  }
  return tables;
}

/** Prototype: slice-by-8 CRC32, same polynomial and output as crc32Hex. */
export function crc32Slice8Hex(bytes: Uint8Array): string {
  const [t0, t1, t2, t3, t4, t5, t6, t7] = sliceTables();
  let crc = 0xffffffff;
  let index = 0;
  const end8 = bytes.length - (bytes.length % 8);
  for (; index < end8; index += 8) {
    const a = (crc ^ (bytes[index] | (bytes[index + 1] << 8) | (bytes[index + 2] << 16) | (bytes[index + 3] << 24))) >>> 0;
    crc = t7[a & 0xff] ^ t6[(a >>> 8) & 0xff] ^ t5[(a >>> 16) & 0xff] ^ t4[a >>> 24] ^
      t3[bytes[index + 4]] ^ t2[bytes[index + 5]] ^ t1[bytes[index + 6]] ^ t0[bytes[index + 7]];
  }
  for (; index < bytes.length; index += 1) crc = t0[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
}

function time<T>(fn: () => T): [T, number] {
  const start = performance.now();
  const value = fn();
  return [value, +(performance.now() - start).toFixed(1)];
}

export async function run(sizesMB = [10, 50, 100]) {
  const results: Record<string, unknown>[] = [];
  for (const mb of sizesMB) {
    const bytes = new Uint8Array(mb * 1024 * 1024);
    let seed = 1;
    for (let index = 0; index < bytes.length; index += 1) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      bytes[index] = seed >>> 24;
    }
    const blob = new Blob([bytes]);
    let start = performance.now();
    const buffer = await blob.arrayBuffer();
    const readMs = +(performance.now() - start).toFixed(1);
    start = performance.now();
    await Promise.all(['SHA-1', 'SHA-256', 'SHA-512'].map((name) => crypto.subtle.digest(name, buffer)));
    const shaMs = +(performance.now() - start).toFixed(1);
    const [, md5Ms] = time(() => SparkMD5.ArrayBuffer.hash(buffer));
    const [crc, crcMs] = time(() => crc32Hex(bytes));
    const [crc8, crc8Ms] = time(() => crc32Slice8Hex(bytes));
    const [, adlerMs] = time(() => adler32Hex(bytes));
    start = performance.now();
    await checksumsFor(blob);
    const totalMs = +(performance.now() - start).toFixed(1);
    results.push({ mb, readMs, shaParallelMs: shaMs, md5Ms, crc32Ms: crcMs, crc32Slice8Ms: crc8Ms, crcIdentical: crc === crc8, adler32Ms: adlerMs, checksumsForTotalMs: totalMs });
  }
  return { benchmark: 'checksums', runtime: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown', results };
}

if (import.meta.main) {
  const sizes = process.argv.slice(2).map(Number).filter(Boolean);
  console.log(JSON.stringify(await run(sizes.length ? sizes : [10, 50, 100]), null, 2));
}
