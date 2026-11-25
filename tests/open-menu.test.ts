import { describe, expect, test } from 'bun:test';
import { targetsFor, type OpenHandlers } from '../src/app-ux';

const noop = () => undefined;
const handlers: OpenHandlers = {
  transcribe: noop, queue: noop, studio: noop, studioBatch: noop, studioJoin: noop, video: noop,
  vision: noop, documents: noop, ttsReference: noop, converter: noop, metadata: noop, cleanMetadata: noop,
  quickTools: noop,
};
const labels = (files: File[]) => targetsFor(files, handlers).map((target) => target.label);

describe('drop-anywhere menu', () => {
  test('DOCX gets the converter and metadata viewer instead of an empty menu', () => {
    const items = labels([new File(['x'], 'report.docx')]);
    expect(items).toContain('Convert format');
    expect(items).toContain('Inspect metadata');
  });

  test('an unknown type can still be inspected', () => {
    expect(labels([new File(['x'], 'data.bin')])).toEqual(['Inspect metadata']);
  });

  test('PDF offers OCR, conversion and metadata', () => {
    const items = labels([new File(['x'], 'scan.pdf', { type: 'application/pdf' })]);
    expect(items).toEqual(expect.arrayContaining(['OCR & redact', 'Convert format', 'Inspect metadata']));
  });
});
