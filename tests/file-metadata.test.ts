import { expect, test } from 'bun:test';
import {
  adler32Hex,
  asciiPreview,
  checksumsFor,
  crc32Hex,
  headText,
  hexPreview,
} from '../src/file-metadata';

const abc = new TextEncoder().encode('abc');

test('file checksums match known abc vectors', () => {
  expect(crc32Hex(abc)).toBe('352441c2');
  expect(adler32Hex(abc)).toBe('024d0127');
});

test('file byte previews separate hex from printable text', () => {
  expect(hexPreview(new Uint8Array([0x25, 0x50, 0x44, 0x46]))).toBe('25 50 44 46');
  expect(headText(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x0a, 0x00, 0x41]))).toBe('%PDF .A');
  expect(asciiPreview(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x0a, 0x00, 0x41]))).toBe('%PDF\n.A');
});

test('full checksum set works for a browser-style blob', async () => {
  const result = await checksumsFor(new Blob([abc]));
  expect(result?.md5).toBe('900150983cd24fb0d6963f7d28e17f72');
  expect(result?.sha1).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
  expect(result?.sha256).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  expect(result?.sha512).toBe(
    'ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a' +
    '2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f',
  );
  expect(result?.crc32).toBe('352441c2');
  expect(result?.adler32).toBe('024d0127');
});
