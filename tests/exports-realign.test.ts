import { describe, expect, test } from 'bun:test';
import { buildExport, csvCell, realignSegments } from '../src/exports';

const segments = [
  { start: 0, end: 2, text: 'hello there world' },
  { start: 2, end: 4, text: 'second part here' },
  { start: 4, end: 6, text: 'and the end' },
];

describe('realignSegments', () => {
  test('returns the same text when nothing changed', () => {
    expect(realignSegments(segments, 'hello there world second part here and the end').map((s) => s.text))
      .toEqual(segments.map((s) => s.text));
  });

  test('carries a word fix into the right segment', () => {
    const out = realignSegments(segments, 'hello there world second chapter here and the end');
    expect(out.map((s) => s.text)).toEqual(['hello there world', 'second chapter here', 'and the end']);
  });

  test('handles deletions and insertions', () => {
    const out = realignSegments(segments, 'hello world second part here NEW and the end');
    expect(out[0].text).toBe('hello world');
    expect(out[1].text).toBe('second part here NEW');
    expect(out[2].text).toBe('and the end');
  });

  test('timed exports use the edited words', () => {
    const text = 'hello there world second chapter here and the end';
    const srt = buildExport('srt', {
      text, segments: realignSegments(segments, text), duration: 6, fileName: 'a.wav', modelName: 'm', createdAt: new Date(0),
    }).body;
    expect(srt).toContain('second chapter here');
    expect(srt).not.toContain('second part here');
  });
});

describe('export escaping', () => {
  const base = { duration: 2, fileName: 'a.wav', modelName: 'm', createdAt: new Date(0) };
  test('VTT cue text cannot contain an arrow or raw tags', () => {
    const body = buildExport('vtt', { ...base, text: 'x', segments: [{ start: 0, end: 1, text: 'a --> b <i>c</i> & d' }] }).body;
    const cue = body.split('\n')[3];
    expect(cue).not.toContain('-->');
    expect(cue).toContain('&lt;i&gt;');
    expect(cue).toContain('&amp;');
  });
  test('CSV neutralises formula-like cells, including the speaker', () => {
    expect(csvCell('=SUM(A1)')).toBe(`"'=SUM(A1)"`);
    expect(csvCell('  @cmd')).toBe(`"'  @cmd"`);
    expect(csvCell('plain, text')).toBe('"plain, text"');
  });
});
