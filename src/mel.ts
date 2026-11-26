import { buildFftPlan, fft, type FftPlan } from './fft';

/**
 * NeMo-compatible log-mel frontend for Fluid Speech Pro / Parakeet TDT.
 *
 * The model expects the exact NeMo `AudioToMelSpectrogramPreprocessor` output:
 *   pre-emphasis 0.97 -> 256 zero samples on each side -> Hann(400) centered
 *   in a 512-point FFT, hop 160 -> power spectrum -> 128 Slaney mel filters
 *   -> log(x + 2^-24) -> per-feature mean / unbiased std normalization.
 *
 * By default only 100 frames per second are kept (`floor(samples / 160)`),
 * matching the feature lengths NeMo passes to the encoder. Some exports (for
 * example Fluid Speech Mini's conv frontend) expect the extra all-padding frame
 * plus a mask; set `trailingFrame` for those.
 */

const LOG_ZERO_GUARD = 2 ** -24;

export interface MelOptions {
  nMels?: number;
  sampleRate?: number;
  nFft?: number;
  winLength?: number;
  hopLength?: number;
  preemphasis?: number;
  /** Include the final all-padding frame (default false). */
  trailingFrame?: boolean;
  /** `channel-first` is [nMels][frames]; `time-first` is [frames][nMels]. */
  layout?: 'channel-first' | 'time-first';
  /** Per-feature mean/std normalization (NeMo ASR). Diarization skips it. Default true. */
  normalize?: boolean;
}

export interface MelFeatures {
  data: Float32Array;
  /** Total frames; includes the trailing padding frame when requested. */
  frames: number;
  /** Frames that contain real audio; always floor(samples / hop). */
  validFrames: number;
  nMels: number;
}



interface MelPlan {
  window: Float64Array;
  fft: FftPlan;
  melOffsets: Int32Array;
  melIndices: Int32Array;
  melWeights: Float32Array;
}

const planCache = new Map<string, MelPlan>();

export function computeNemoLogMel(samples: Float32Array, options: MelOptions = {}): MelFeatures {
  const nMels = Math.max(1, Math.round(options.nMels ?? 128));
  const sampleRate = Math.max(1, Math.round(options.sampleRate ?? 16_000));
  const nFft = Math.max(2, Math.round(options.nFft ?? 512));
  const winLength = Math.max(1, Math.round(options.winLength ?? 400));
  const hopLength = Math.max(1, Math.round(options.hopLength ?? 160));
  const preemphasis = options.preemphasis ?? 0.97;

  if (nFft < winLength) {
    throw new Error('Invalid mel spectrogram configuration: the window is larger than the FFT.');
  }

  const validFrames = Math.floor(samples.length / hopLength);
  const frames = validFrames + (options.trailingFrame && validFrames > 0 ? 1 : 0);
  const timeFirst = options.layout === 'time-first';

  if (validFrames <= 0 || frames <= 0) {
    return {
      data: new Float32Array(nMels),
      frames: 0,
      validFrames: 0,
      nMels,
    };
  }

  const plan = getPlan(nMels, sampleRate, nFft, winLength);

  // Pre-emphasis and the 256-sample symmetric zero pad, written once so each
  // frame can be copied contiguously.
  const pad = nFft >> 1;
  const padded = new Float64Array(samples.length + nFft);
  let previous = 0;

  for (let i = 0; i < samples.length; i += 1) {
    const value = Number.isFinite(samples[i]) ? samples[i] : 0;
    padded[pad + i] = i === 0 ? value : value - preemphasis * previous;
    previous = value;
  }

  const re = new Float64Array(nFft);
  const im = new Float64Array(nFft);
  const melEnergies = new Float64Array(nMels);
  const logMel = new Float32Array(nMels * frames);
  const nFreqs = (nFft >> 1) + 1;

  for (let frame = 0; frame < frames; frame += 1) {
    const offset = frame * hopLength;

    for (let i = 0; i < nFft; i += 1) {
      re[i] = padded[offset + i] * plan.window[i];
      im[i] = 0;
    }

    fft(re, im, plan.fft);
    melEnergies.fill(0);

    for (let bin = 0; bin < nFreqs; bin += 1) {
      const power = re[bin] * re[bin] + im[bin] * im[bin];
      if (power === 0) continue;

      const from = plan.melOffsets[bin];
      const to = plan.melOffsets[bin + 1];

      for (let entry = from; entry < to; entry += 1) {
        melEnergies[plan.melIndices[entry]] += power * plan.melWeights[entry];
      }
    }

    for (let mel = 0; mel < nMels; mel += 1) {
      logMel[mel * frames + frame] = Math.log(melEnergies[mel] + LOG_ZERO_GUARD);
    }
  }

  if (options.normalize === false) {
    const raw = new Float32Array(nMels * frames);
    for (let mel = 0; mel < nMels; mel += 1) {
      for (let frame = 0; frame < validFrames; frame += 1) {
        raw[timeFirst ? frame * nMels + mel : mel * frames + frame] = logMel[mel * frames + frame];
      }
    }
    return { data: raw, frames, validFrames, nMels };
  }

  // Per-feature normalization. NeMo uses an unbiased standard deviation and
  // adds 1e-5 before dividing. The extra padding frame is excluded from the
  // statistics and left at zero.
  const out = new Float32Array(nMels * frames);
  const denominator = validFrames > 1 ? validFrames - 1 : 1;

  for (let mel = 0; mel < nMels; mel += 1) {
    const base = mel * frames;
    let sum = 0;

    for (let frame = 0; frame < validFrames; frame += 1) {
      sum += logMel[base + frame];
    }

    const mean = sum / validFrames;
    let squared = 0;

    for (let frame = 0; frame < validFrames; frame += 1) {
      const delta = logMel[base + frame] - mean;
      squared += delta * delta;
    }

    const std = validFrames > 1 ? Math.sqrt(squared / denominator) : 0;
    const divisor = std + 1e-5;

    for (let frame = 0; frame < validFrames; frame += 1) {
      const value = (logMel[base + frame] - mean) / divisor;
      const index = timeFirst ? frame * nMels + mel : base + frame;
      out[index] = value;
    }
  }

  return { data: out, frames, validFrames, nMels };
}

function getPlan(
  nMels: number,
  sampleRate: number,
  nFft: number,
  winLength: number,
): MelPlan {
  const key = `${nMels}:${sampleRate}:${nFft}:${winLength}`;
  const cached = planCache.get(key);
  if (cached) return cached;

  if ((nFft & (nFft - 1)) !== 0) {
    throw new Error('The FFT size must be a power of two.');
  }
  if (winLength > nFft) {
    throw new Error('The window length cannot exceed the FFT size.');
  }

  const window = new Float64Array(nFft);
  const offset = (nFft - winLength) >> 1;

  for (let i = 0; i < winLength; i += 1) {
    const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / Math.max(1, winLength - 1));
    window[offset + i] = hann;
  }

  const fftPlan = buildFftPlan(nFft);
  const filterbank = buildMelFilterbank(nMels, sampleRate, nFft);

  const plan: MelPlan = {
    window,
    fft: fftPlan,
    melOffsets: filterbank.offsets,
    melIndices: filterbank.indices,
    melWeights: filterbank.weights,
  };

  planCache.set(key, plan);
  return plan;
}

/**
 * Slaney mel filterbank, matching librosa.filters.mel(..., htk=False,
 * norm='slaney') as used by NeMo. Stored sparsely by FFT bin because each bin
 * touches at most two triangles.
 */
function buildMelFilterbank(
  nMels: number,
  sampleRate: number,
  nFft: number,
): { offsets: Int32Array; indices: Int32Array; weights: Float32Array } {
  const nFreqs = (nFft >> 1) + 1;
  const lowMel = hzToMel(0);
  const highMel = hzToMel(sampleRate / 2);
  const melPoints = new Float64Array(nMels + 2);

  for (let i = 0; i < nMels + 2; i += 1) {
    melPoints[i] = lowMel + ((highMel - lowMel) * i) / (nMels + 1);
  }

  const hzPoints = new Float64Array(nMels + 2);
  for (let i = 0; i < nMels + 2; i += 1) {
    hzPoints[i] = melToHz(melPoints[i]);
  }

  const offsets = new Int32Array(nFreqs + 1);
  const indices: number[] = [];
  const weights: number[] = [];

  for (let bin = 0; bin < nFreqs; bin += 1) {
    const frequency = (bin * sampleRate) / nFft;

    for (let mel = 0; mel < nMels; mel += 1) {
      const lower = hzPoints[mel];
      const center = hzPoints[mel + 1];
      const upper = hzPoints[mel + 2];

      let weight = 0;
      if (frequency >= lower && frequency <= center && center > lower) {
        weight = (frequency - lower) / (center - lower);
      } else if (frequency > center && frequency <= upper && upper > center) {
        weight = (upper - frequency) / (upper - center);
      }

      if (weight > 0) {
        const slaney = 2 / (upper - lower);
        indices.push(mel);
        weights.push(weight * slaney);
      }
    }

    offsets[bin + 1] = indices.length;
  }

  return {
    offsets,
    indices: Int32Array.from(indices),
    weights: Float32Array.from(weights),
  };
}

function hzToMel(hz: number): number {
  const fSp = 200 / 3;
  const minLogHz = 1000;
  const minLogMel = 15;
  const logStep = Math.log(6.4) / 27;

  return hz < minLogHz ? hz / fSp : minLogMel + Math.log(hz / minLogHz) / logStep;
}

function melToHz(mel: number): number {
  const fSp = 200 / 3;
  const minLogHz = 1000;
  const minLogMel = 15;
  const logStep = Math.log(6.4) / 27;

  return mel < minLogMel ? mel * fSp : minLogHz * Math.exp(logStep * (mel - minLogMel));
}
