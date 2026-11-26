/**
 * File-level fingerprints used by the metadata viewer: cryptographic hashes,
 * checksums, and the first-bytes preview shown by tools like exif.tools.
 */

export interface FileChecksums {
  md5: string;
  sha1: string;
  sha256: string;
  sha512: string;
  crc32: string;
  adler32: string;
}

export const CHECKSUM_SIZE_LIMIT = 100 * 1024 * 1024;

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function hexPreview(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(' ');
}

/** Single-line printable preview, matching the "Head Text" field. */
export function headText(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => {
    if (byte === 9 || byte === 10 || byte === 13) return ' ';
    return byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : '.';
  }).join('');
}

/** Multi-line ASCII preview that keeps line breaks and tabs. */
export function asciiPreview(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => {
    if (byte === 9 || byte === 10 || byte === 13) return String.fromCharCode(byte);
    return byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : '.';
  }).join('');
}

let crcTable: Uint32Array | null = null;

function makeCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

export function crc32Hex(bytes: Uint8Array): string {
  crcTable ??= makeCrcTable();
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc = crcTable[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
}

export function adler32Hex(bytes: Uint8Array): string {
  const mod = 65521;
  let a = 1;
  let b = 0;
  for (let index = 0; index < bytes.length;) {
    const end = Math.min(index + 5552, bytes.length);
    for (; index < end; index += 1) {
      a += bytes[index];
      b += a;
    }
    a %= mod;
    b %= mod;
  }
  return (((b << 16) | a) >>> 0).toString(16).padStart(8, '0');
}

export async function checksumsFor(file: Blob): Promise<FileChecksums | null> {
  if (file.size > CHECKSUM_SIZE_LIMIT) return null;
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const { default: SparkMD5 } = await import('spark-md5');

  let sha1 = '';
  let sha256 = '';
  let sha512 = '';
  if (globalThis.crypto?.subtle) {
    const [one, two, five] = await Promise.all([
      crypto.subtle.digest('SHA-1', buffer),
      crypto.subtle.digest('SHA-256', buffer),
      crypto.subtle.digest('SHA-512', buffer),
    ]);
    sha1 = hex(new Uint8Array(one));
    sha256 = hex(new Uint8Array(two));
    sha512 = hex(new Uint8Array(five));
  }

  return {
    md5: SparkMD5.ArrayBuffer.hash(buffer),
    sha1,
    sha256,
    sha512,
    crc32: crc32Hex(bytes),
    adler32: adler32Hex(bytes),
  };
}
