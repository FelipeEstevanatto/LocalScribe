/**
 * Whisper-compatible log-mel frontend used by Qwen3-ASR.
 *
 * Qwen3-ASR's conv frontend expects the features produced by
 * kaldi-native-fbank's `OnlineWhisperFbank`, followed by the Whisper
 * normalization used by sherpa-onnx:
 *
 *   25 ms Hann (periodic) window, 10 ms hop, no pre-emphasis or DC removal
 *   400-point real FFT (the window is NOT zero-padded to 512)
 *   128 Slaney/librosa-style mel filters from 0 to 8 kHz
 *   log10(power), clamp to max - 8, then (x + 4) / 4
 *
 * The frame count is `floor(samples / 160)`. With `snip_edges=false`, Kaldi
 * places frame t at `t * 160 - (400 - 160) / 2 = t * 160 - 120`, which is a
 * 120-sample zero pad, not the 200-sample pad used by OpenAI Whisper.
 */

import { createMixedFft } from './mixed-fft';

const SAMPLE_RATE = 16_000;
const N_FFT = 400;
const WINDOW_LENGTH = 400;
const HOP_LENGTH = 160;
const PAD = (WINDOW_LENGTH - HOP_LENGTH) / 2;
const N_MELS = 128;
const N_BINS = N_FFT / 2 + 1;
const LOG_FLOOR = 1e-10;

export interface WhisperMel {
  /** Time-major [frames][nMels] features. */
  data: Float32Array;
  frames: number;
  nMels: number;
}

const byteWindow = (() => {
  const window = new Float64Array(WINDOW_LENGTH);
  const step = (2 * Math.PI) / WINDOW_LENGTH;
  for (let index = 0; index < WINDOW_LENGTH; index += 1) {
    window[index] = 0.5 - 0.5 * Math.cos(step * index);
  }
  return window;
})();

/** Exact 400-point mixed-radix FFT, reused for every frame. */
const fft = createMixedFft(N_FFT);
const fftInputRe = new Float64Array(N_FFT);
const fftInputIm = new Float64Array(N_FFT);
const fftOutputRe = new Float64Array(N_FFT);
const fftOutputIm = new Float64Array(N_FFT);

/** Slaney mel scale, exactly as kaldi-native-fbank defines it. */
function hzToSlaneyMel(freq: number): number {
  if (freq <= 1000) return (freq * 3) / 200;
  return 15 + 14.545078505785561 * Math.log(freq / 1000);
}

function slaneyMelToHz(mel: number): number {
  if (mel <= 15) return (200 / 3) * mel;
  return 1000 * Math.exp((mel - 15) * 0.06875177742094911);
}

/**
 * The 128 x 201 filterbank used by kaldi-native-fbank's librosa mode. This
 * deliberately follows its Hz-domain triangular weights (not librosa's mel-
 * domain ramps) and its `2 / (right - left)` slaney normalization.
 *
 * Stored as a sparse tri-diagonal bank: most of the 201 FFT bins are zero for
 * each of the 128 filters, so only the non-zero taps are kept and evaluated.
 */
const melFilters = (() => {
  const offsets = new Int32Array(N_MELS + 1);
  const indices: number[] = [];
  const weights: number[] = [];
  const lowFreq = 0;
  const highFreq = SAMPLE_RATE / 2;
  const melLow = hzToSlaneyMel(lowFreq);
  const melHigh = hzToSlaneyMel(highFreq);
  const melDelta = (melHigh - melLow) / (N_MELS + 1);
  const fftBinWidth = SAMPLE_RATE / N_FFT;

  for (let bin = 0; bin < N_MELS; bin += 1) {
    offsets[bin] = indices.length;
    const leftHz = slaneyMelToHz(melLow + bin * melDelta);
    const centerHz = slaneyMelToHz(melLow + (bin + 1) * melDelta);
    const rightHz = slaneyMelToHz(melLow + (bin + 2) * melDelta);

    for (let fftBin = 0; fftBin < N_BINS; fftBin += 1) {
      const hz = fftBinWidth * fftBin;
      if (hz <= leftHz || hz >= rightHz) continue;

      const weight =
        hz <= centerHz
          ? (hz - leftHz) / (centerHz - leftHz)
          : (rightHz - hz) / (rightHz - centerHz);

      indices.push(fftBin);
      weights.push(weight * (2 / (rightHz - leftHz)));
    }
  }
  offsets[N_MELS] = indices.length;

  return {
    offsets,
    indices: Int32Array.from(indices),
    weights: Float32Array.from(weights),
  };
})();

export function computeWhisperLogMel(samples: Float32Array): WhisperMel {
  const frames = Math.floor(samples.length / HOP_LENGTH);

  if (frames <= 0) {
    return { data: new Float32Array(0), frames: 0, nMels: N_MELS };
  }

  const data = new Float32Array(frames * N_MELS);
  const power = new Float64Array(N_BINS);
  fftInputIm.fill(0);
  let globalMax = -Infinity;

  for (let frame = 0; frame < frames; frame += 1) {
    const start = frame * HOP_LENGTH - PAD;

    for (let index = 0; index < WINDOW_LENGTH; index += 1) {
      const source = start + index;
      const sample =
        source >= 0 && source < samples.length ? samples[source] : 0;
      fftInputRe[index] = sample * byteWindow[index];
    }

    fft.forward(fftInputRe, fftInputIm, fftOutputRe, fftOutputIm);
    for (let bin = 0; bin < N_BINS; bin += 1) {
      const real = fftOutputRe[bin];
      const imaginary = fftOutputIm[bin];
      power[bin] = real * real + imaginary * imaginary;
    }

    const base = frame * N_MELS;

    const { offsets, indices, weights } = melFilters;
    for (let mel = 0; mel < N_MELS; mel += 1) {
      let energy = 0;
      const from = offsets[mel];
      const to = offsets[mel + 1];

      for (let tap = from; tap < to; tap += 1) {
        energy += power[indices[tap]] * weights[tap];
      }

      energy = Math.max(energy, LOG_FLOOR);
      const value = Math.log10(energy);
      data[base + mel] = value;
      if (value > globalMax) globalMax = value;
    }
  }

  const floor = globalMax - 8;

  for (let index = 0; index < data.length; index += 1) {
    const value = Math.max(data[index], floor);
    data[index] = (value + 4) / 4;
  }

  return { data, frames, nMels: N_MELS };
}
