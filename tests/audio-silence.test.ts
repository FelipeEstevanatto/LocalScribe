import { expect, test } from 'bun:test';
import { trimSilenceBounds } from '../src/audio-silence';

test('silence trim keeps 100 ms around the audible region', () => {
  const rate = 1000;
  const samples = new Float32Array(3000);
  for (let index = 1000; index < 2000; index += 1) samples[index] = 0.5;
  expect(trimSilenceBounds([samples], rate)).toEqual({ start: 900, end: 2100 });
});

test('silence trim measures the loudest channel and handles a silent file', () => {
  const rate = 1000;
  const left = new Float32Array(2000);
  const right = new Float32Array(2000);
  right[1200] = -0.4;
  expect(trimSilenceBounds([left, right], rate)).toEqual({ start: 1100, end: 1301 });

  expect(trimSilenceBounds([new Float32Array(2000)], rate)).toEqual({ start: 0, end: 100 });
});
