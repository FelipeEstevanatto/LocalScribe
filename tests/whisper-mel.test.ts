import { expect, test } from 'bun:test';
import { computeWhisperLogMel } from '../src/whisper-mel';

const SAMPLE_RATE = 16_000;
const N_FFT = 400;
const HOP = 160;
const PAD = (N_FFT - HOP) / 2;
const N_BINS = N_FFT / 2 + 1;
const N_MELS = 128;

function hzToSlaneyMel(freq: number): number {
  return freq <= 1000 ? (freq * 3) / 200 : 15 + 14.545078505785561 * Math.log(freq / 1000);
}

function slaneyMelToHz(mel: number): number {
  return mel <= 15 ? (200 / 3) * mel : 1000 * Math.exp((mel - 15) * 0.06875177742094911);
}

function referenceLogMel(samples: Float32Array): Float32Array {
  const frames = Math.floor(samples.length / HOP);
  const data = new Float32Array(frames * N_MELS);
  const window = new Float64Array(N_FFT);
  for (let index = 0; index < N_FFT; index += 1) {
    window[index] = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / N_FFT);
  }
  const filters = new Float64Array(N_MELS * N_BINS);
  const melLow = hzToSlaneyMel(0);
  const melHigh = hzToSlaneyMel(SAMPLE_RATE / 2);
  const delta = (melHigh - melLow) / (N_MELS + 1);
  for (let mel = 0; mel < N_MELS; mel += 1) {
    const left = slaneyMelToHz(melLow + mel * delta);
    const center = slaneyMelToHz(melLow + (mel + 1) * delta);
    const right = slaneyMelToHz(melLow + (mel + 2) * delta);
    for (let bin = 0; bin < N_BINS; bin += 1) {
      const hz = (SAMPLE_RATE / N_FFT) * bin;
      if (hz <= left || hz >= right) continue;
      const weight = hz <= center ? (hz - left) / (center - left) : (right - hz) / (right - center);
      filters[mel * N_BINS + bin] = weight * (2 / (right - left));
    }
  }
  let globalMax = -Infinity;
  const power = new Float64Array(N_BINS);
  for (let frame = 0; frame < frames; frame += 1) {
    const start = frame * HOP - PAD;
    for (let bin = 0; bin < N_BINS; bin += 1) {
      let real = 0;
      let imaginary = 0;
      for (let index = 0; index < N_FFT; index += 1) {
        const source = start + index;
        const sample = source >= 0 && source < samples.length ? samples[source] : 0;
        const value = sample * window[index];
        const angle = (2 * Math.PI * bin * index) / N_FFT;
        real += value * Math.cos(angle);
        imaginary -= value * Math.sin(angle);
      }
      power[bin] = real * real + imaginary * imaginary;
    }
    for (let mel = 0; mel < N_MELS; mel += 1) {
      let energy = 0;
      for (let bin = 0; bin < N_BINS; bin += 1) energy += power[bin] * filters[mel * N_BINS + bin];
      const value = Math.log10(Math.max(energy, 1e-10));
      data[frame * N_MELS + mel] = value;
      globalMax = Math.max(globalMax, value);
    }
  }
  const floor = globalMax - 8;
  for (let index = 0; index < data.length; index += 1) {
    data[index] = (Math.max(data[index], floor) + 4) / 4;
  }
  return data;
}

test('whisper log-mel matches a direct 400-point DFT reference', () => {
  const samples = new Float32Array(HOP * 12);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] =
      Math.sin((2 * Math.PI * 220 * index) / SAMPLE_RATE) * 0.4 +
      Math.cos((2 * Math.PI * 730 * index) / SAMPLE_RATE) * 0.2;
  }
  const expected = referenceLogMel(samples);
  const actual = computeWhisperLogMel(samples).data;
  let maxError = 0;
  for (let index = 0; index < expected.length; index += 1) {
    maxError = Math.max(maxError, Math.abs(actual[index] - expected[index]));
  }
  expect(maxError).toBeLessThan(1e-5);
});

test('whisper log-mel returns one time-major feature row per 10 ms hop', () => {
  const samples = new Float32Array(16_000);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = Math.sin((2 * Math.PI * 440 * index) / 16_000) * 0.5;
  }

  const mel = computeWhisperLogMel(samples);

  expect(mel.frames).toBe(100);
  expect(mel.nMels).toBe(128);
  expect(mel.data.length).toBe(100 * 128);
  expect(mel.data.every((value) => Number.isFinite(value))).toBe(true);
});

test('whisper log-mel clamps silence to the normalization floor', () => {
  const mel = computeWhisperLogMel(new Float32Array(16_000));

  expect(mel.frames).toBe(100);
  // log10(1e-10) = -10, global max -10, floor -18, then (x + 4) / 4 = -1.5.
  for (const value of mel.data) expect(value).toBeCloseTo(-1.5, 5);
});
