import { expect, test } from 'bun:test';
import { canRenderFast, renderFastEdit, sliceFloatWav } from '../src/audio-dsp';
import { resampleMono } from '../src/audio';
import type { AudioEdit } from '../src/audio-edit';
import { inspectEditorAudio } from '../src/audio-edit';
import { writeFloatWav } from '../src/pcm-audio';

function baseEdit(): AudioEdit {
  return {
    start: 0,
    end: 1,
    cut: 'none',
    gain: 0,
    loudness: null,
    ceiling: null,
    effect: '',
  };
}

function source(): Blob {
  const frames = 8000;
  return writeFloatWav([new Float32Array(frames).fill(0.5), new Float32Array(frames).fill(-0.5)], 8000);
}

test('fast path covers only the simple PCM edits', () => {
  expect(canRenderFast(baseEdit())).toBe(true);
  expect(canRenderFast({ ...baseEdit(), gain: 6, effect: 'fades' })).toBe(true);
  expect(canRenderFast({ ...baseEdit(), effect: 'reverse' })).toBe(true);
  expect(canRenderFast({ ...baseEdit(), effect: 'mono' })).toBe(true);
  expect(canRenderFast({ ...baseEdit(), denoise: 12 })).toBe(false);
  expect(canRenderFast({ ...baseEdit(), loudness: -16 })).toBe(false);
  expect(canRenderFast({ ...baseEdit(), ceiling: -1 })).toBe(false);
  expect(canRenderFast({ ...baseEdit(), pitch: 2 })).toBe(false);
  expect(canRenderFast({ ...baseEdit(), tempo: 1.1 })).toBe(false);
  expect(canRenderFast({ ...baseEdit(), bass: 3 })).toBe(false);
  expect(canRenderFast({ ...baseEdit(), effect: 'reverb' })).toBe(false);
});

test('gain and fades are applied in the PCM domain', async () => {
  const signal = new AbortController().signal;
  const gained = await renderFastEdit(source(), { ...baseEdit(), gain: 6 }, { signal });
  const audio = await inspectEditorAudio(gained, signal);
  expect(audio.duration).toBeCloseTo(1, 3);
  expect(audio.peak).toBeCloseTo(0.5 * 10 ** (6 / 20), 3);

  const faded = await renderFastEdit(source(), { ...baseEdit(), effect: 'fades', fadeIn: 0.1, fadeOut: 0.1 }, { signal });
  const fadedAudio = await inspectEditorAudio(faded, signal);
  expect(fadedAudio.peaks[0]).toBeLessThan(0.01);
  expect(fadedAudio.peaks[fadedAudio.peaks.length - 1]).toBeLessThan(0.01);
});

test('keep/remove cuts preserve the expected length', async () => {
  const signal = new AbortController().signal;
  const kept = await renderFastEdit(source(), { ...baseEdit(), cut: 'keep', start: 0.25, end: 0.75 }, { signal });
  expect((await inspectEditorAudio(kept, signal)).duration).toBeCloseTo(0.5, 3);

  const removed = await renderFastEdit(source(), { ...baseEdit(), cut: 'remove', start: 0.25, end: 0.75 }, { signal });
  expect((await inspectEditorAudio(removed, signal)).duration).toBeCloseTo(0.5, 3);
});

test('mono averages the first two channels', async () => {
  const signal = new AbortController().signal;
  const mono = await renderFastEdit(source(), { ...baseEdit(), effect: 'mono' }, { signal });
  const audio = await inspectEditorAudio(mono, signal);
  expect(audio.channels).toBe(2);
  expect(audio.peak).toBeLessThan(0.001);
});

test('a PCM slice keeps the requested window and sample rate', async () => {
  const signal = new AbortController().signal;
  const sliced = await sliceFloatWav(source(), 0.25, 0.5, { signal });
  const audio = await inspectEditorAudio(sliced, signal);
  expect(audio.duration).toBeCloseTo(0.5, 3);
  expect(audio.sampleRate).toBe(8000);
  expect(audio.peak).toBeCloseTo(0.5, 3);
});

test('resampling downmixes and preserves the duration', () => {
  const rate = 48_000;
  const left = new Float32Array(rate);
  const right = new Float32Array(rate).fill(-1);
  left.fill(1);
  const mono = resampleMono([left, right], rate, 16_000);
  expect(mono.length).toBe(16_000);
  expect(mono[0]).toBeCloseTo(0, 5);
  expect(mono.every((value) => Math.abs(value) < 0.001)).toBe(true);
});
