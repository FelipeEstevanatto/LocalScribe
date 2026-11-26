import { buildFftPlan, fft } from './fft';
import type { EditorAudio } from './audio-edit';

export type MusicEstimate = { bpm: number | null; key: string | null; mode: 'major' | 'minor' | null };

const NOTES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
const TONAL_PROFILES = [
  { mode: 'major' as const, profile: [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88] },
  { mode: 'minor' as const, profile: [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17] },
];

export function tappedTempo(times: readonly number[]): number | null {
  if (times.length < 2) return null;
  const intervals = times.slice(1).map((time, index) => time - times[index]).sort((a, b) => a - b);
  const middle = Math.floor(intervals.length / 2);
  const interval = (intervals[middle] + intervals[Math.floor((intervals.length - 1) / 2)]) / 2;
  return interval > 0 ? 60000 / interval : null;
}

function findKey(chroma: Float64Array): Pick<MusicEstimate, 'key' | 'mode'> {
  const average = chroma.reduce((sum, value) => sum + value, 0) / 12;
  const centered = chroma.map((value) => value - average);
  const magnitude = Math.hypot(...centered);
  let bestScore = 0;
  let best: Pick<MusicEstimate, 'key' | 'mode'> = { key: null, mode: null };
  if (!magnitude) return best;
  for (const { mode, profile } of TONAL_PROFILES) {
    const mean = profile.reduce((sum, value) => sum + value, 0) / 12;
    const centeredProfile = profile.map((value) => value - mean);
    const scale = Math.hypot(...centeredProfile) * magnitude;
    for (let note = 0; note < 12; note += 1) {
      const score = centeredProfile.reduce((sum, value, interval) => sum + value * centered[(note + interval) % 12], 0) / scale;
      if (score > Math.max(bestScore, 0.35)) {
        bestScore = score;
        best = { key: NOTES[note], mode };
      }
    }
  }
  return best;
}

function estimateBpm(onsets: number[], frameRate: number): number | null {
  const max = Math.max(0, ...onsets);
  if (!max || onsets.length < frameRate * 3) return null;
  const average = onsets.reduce((sum, value) => sum + value, 0) / onsets.length;
  const centered = onsets.map((value) => value - average);
  let bpm = 0;
  let bestScore = 0;
  const correlate = (lag: number) => {
    let dot = 0, first = 0, second = 0;
    for (let i = lag; i < centered.length; i += 1) {
      const a = centered[i], b = centered[i - lag];
      dot += a * b;
      first += a * a;
      second += b * b;
    }
    return (first && second) ? dot / Math.sqrt(first * second) : 0;
  };
  const firstLag = Math.floor(frameRate * 60 / 200);
  const lastLag = Math.ceil(frameRate * 60 / 55);
  const scores = Array.from({ length: lastLag - firstLag + 3 }, (_, i) => correlate(firstLag + i - 1));
  for (let lag = firstLag; lag <= lastLag; lag += 1) {
    const i = lag - firstLag;
    const left = scores[i], middle = scores[i + 1], right = scores[i + 2];
    if (middle < left || middle < right || middle < 0.15) continue;
    const curvature = 2 * middle - left - right;
    const shift = curvature > 0 ? (right - left) / (2 * curvature) : 0;
    const candidate = 60 * frameRate / (lag + shift);
    if (candidate < 55 || candidate > 200) continue;
    // Interpolate the peak before comparing octave aliases at whole frame lags.
    const score = middle + (right - left) * shift / 4 - 0.09 * Math.abs(Math.log2(candidate / 120));
    if (score > bestScore) {
      bestScore = score;
      bpm = candidate;
    }
  }
  return bpm || null;
}

export async function analyzeTrack(blob: Blob, audio: EditorAudio): Promise<MusicEstimate> {
  // Use the first minute. Analyze the whole track when it is shorter.
  const stride = Math.max(1, Math.round(audio.sampleRate / 9000));
  const frames = Math.floor(Math.min(audio.duration, 60) * audio.sampleRate / stride) * stride;
  const rate = audio.sampleRate / stride;
  const chunk = await blob.slice(audio.dataOffset, audio.dataOffset + frames * audio.channels * 4).arrayBuffer();
  const data = new Float32Array(chunk);
  const mix = new Float32Array(frames / stride);
  for (let i = 0; i < mix.length; i += 1) {
    let sum = 0;
    for (let j = 0; j < stride * audio.channels; j += 1) {
      sum += data[i * stride * audio.channels + j] || 0;
    }
    mix[i] = sum / (stride * audio.channels);
  }

  const size = 4096, hop = 256;
  const plan = buildFftPlan(size);
  const hann = Float64Array.from({ length: size }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / size));
  const real = new Float64Array(size), imag = new Float64Array(size);
  const previous = new Float64Array(size / 2);
  const spectrum = new Float64Array(size / 2);
  const chroma = new Float64Array(12);
  const onsets: number[] = [];
  for (let offset = 0; offset + size <= mix.length; offset += hop) {
    for (let i = 0; i < size; i += 1) real[i] = mix[offset + i] * hann[i];
    imag.fill(0);
    fft(real, imag, plan);
    let flux = 0;
    for (let i = 1; i < spectrum.length; i += 1) {
      spectrum[i] = Math.hypot(real[i], imag[i]);
      const log = Math.log1p(spectrum[i]);
      flux += Math.max(0, log - previous[i]);
      previous[i] = log;
    }
    onsets.push(offset ? flux : 0);
    const low = Math.max(2, Math.ceil(55 * size / rate));
    const high = Math.min(spectrum.length - 2, Math.floor(3500 * size / rate));
    for (let i = low; i <= high; i += 1) {
      const amplitude = spectrum[i], before = spectrum[i - 1], after = spectrum[i + 1];
      if (amplitude < 0.03 || amplitude <= before || amplitude <= after) continue;
      const correction = (after - before) / (2 * (2 * amplitude - before - after));
      const note = 69 + 12 * Math.log2(((i + correction) * rate / size) / 440);
      const nearest = Math.round(note);
      chroma[((nearest % 12) + 12) % 12] += amplitude * (1 - 2 * Math.abs(note - nearest));
    }
  }
  return { bpm: estimateBpm(onsets, rate / hop), ...findKey(chroma) };
}

