import { expect, test } from 'bun:test';
import { splitLyricLines } from '../src/audio-studio';

test('lyrics split at pauses and sentence ends when word timings exist', () => {
  const words = ['Hello', 'world.', 'How', 'are', 'you', 'today'].map((text, i) => ({ text, start: i < 3 ? i * 0.4 : 3 + i * 0.3, end: (i < 3 ? i * 0.4 : 3 + i * 0.3) + 0.3 }));
  const lines = splitLyricLines([{ start: 0, end: 5, text: words.map((w) => w.text).join(' '), words }]);
  expect(lines.map((line) => line.text)).toEqual(['Hello world.', 'How', 'are you today']);
  expect(lines[2].start).toBeCloseTo(3.9);
});

test('without word timings, phrases share the chunk time by length', () => {
  const lines = splitLyricLines([{ start: 10, end: 20, text: 'And so, my fellow Americans, ask not.' }]);
  expect(lines.map((line) => line.text)).toEqual(['And so,', 'my fellow Americans,', 'ask not.']);
  expect(lines[0].start).toBe(10);
  expect(lines.at(-1)!.end).toBeCloseTo(20);
});
