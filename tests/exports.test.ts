import { expect, test } from 'bun:test';
import { buildExport } from '../src/exports';

test('CSV preserves timed text and quotes spreadsheet formula prefixes', () => {
  const csv = buildExport('csv', {
    text: '',
    segments: [{ start: 1.2345, end: 3, text: '=example, "quoted"\nsecond line' }],
    duration: 3,
    fileName: 'example.wav',
    modelName: 'Example',
    createdAt: new Date(0),
  });
  expect(csv.body).toBe('start_seconds,end_seconds,text\r\n1.234,3.000,"\'=example, ""quoted""\nsecond line"\r\n');
});

test('JSON accepts legacy segments and exports optional timing metadata', () => {
  const output = buildExport('json', {
    text: 'First. Second.',
    segments: [
      { start: 0, end: 1, text: 'First.' },
      { start: 1, end: 2, text: 'Second.', words: [{ start: 1.1, end: null, text: 'Second.' }] },
    ],
    duration: 2,
    fileName: null,
    modelName: 'Example',
    createdAt: new Date(0),
  });
  expect(JSON.parse(output.body).segments).toEqual([
    { start: 0, end: 1, text: 'First.' },
    { start: 1, end: 2, text: 'Second.', words: [{ start: 1.1, end: null, text: 'Second.' }],
      wordTimingSource: 'model-estimated from original transcript' },
  ]);
});
