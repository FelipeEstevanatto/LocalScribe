import { describe, expect, test } from 'bun:test';
import { unscannedPages } from '../src/document-studio';

describe('redaction page coverage', () => {
  test('lists every page OCR has not checked', () => {
    expect(unscannedPages([{ scanned: true }, {}, { scanned: false }])).toEqual([2, 3]);
  });
  test('is empty once all pages are scanned', () => {
    expect(unscannedPages([{ scanned: true }, { scanned: true }])).toEqual([]);
  });
});
