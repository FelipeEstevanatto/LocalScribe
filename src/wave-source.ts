import { createAudioAnalyzer, TARGET_SAMPLE_RATE, type AudioAnalysis, type DecodedAudio } from './audio';
import { abortError } from './errors';

export interface WaveSource extends Omit<DecodedAudio, 'samples'> {
  samples: null;
  sampleCount: number;
  read(start: number, end: number): Promise<Float32Array<ArrayBuffer>>;
}

/** Open ASR-ready PCM WAV without reading its audio payload. */
export async function openWaveSource(file: Blob): Promise<WaveSource | null> {
  const header = new DataView(await file.slice(0, 12).arrayBuffer());
  if (header.byteLength < 12 || header.getUint32(0) !== 0x52494646 || header.getUint32(8) !== 0x57415645) {
    return null;
  }

  const limit = header.getUint32(4, true) + 8;
  if (limit > file.size) return null;
  let validFormat = false;
  let dataStart = 0;
  let dataSize = 0;

  for (let offset = 12; offset + 8 <= limit;) {
    const chunk = new DataView(await file.slice(offset, offset + 8).arrayBuffer());
    const kind = chunk.getUint32(0);
    const size = chunk.getUint32(4, true);
    const start = offset + 8;
    if (start + size > limit) return null;
    if (kind === 0x666d7420) {
      if (size < 16) return null;
      const format = new DataView(await file.slice(start, start + 16).arrayBuffer());
      validFormat = format.getUint16(0, true) === 1 && format.getUint16(2, true) === 1 &&
        format.getUint32(4, true) === TARGET_SAMPLE_RATE && format.getUint16(12, true) === 2 &&
        format.getUint16(14, true) === 16;
      if (!validFormat) return null;
    } else if (kind === 0x64617461) {
      dataStart = start;
      dataSize = size;
    }
    if (validFormat && dataSize) break;
    offset = start + size + (size % 2);
  }

  if (!validFormat || !dataSize || dataSize % 2) return null;
  const sampleCount = dataSize / 2;
  return {
    samples: null,
    sampleCount,
    duration: sampleCount / TARGET_SAMPLE_RATE,
    originalSampleRate: TARGET_SAMPLE_RATE,
    originalChannels: 1,
    async read(start, end) {
      const view = new DataView(await file.slice(dataStart + start * 2, dataStart + end * 2).arrayBuffer());
      const pcm = new Float32Array(view.byteLength / 2);
      for (let index = 0; index < pcm.length; index += 1) {
        pcm[index] = view.getInt16(index * 2, true) / 32768;
      }
      return pcm;
    },
  };
}

export async function summarizeWave(source: WaveSource, signal: AbortSignal): Promise<{
  peaks: Float32Array;
  analysis: AudioAnalysis;
}> {
  const analyzer = createAudioAnalyzer();
  const peaks = new Float32Array(900);
  const blockSize = 4 * TARGET_SAMPLE_RATE;
  for (let start = 0; start < source.sampleCount; start += blockSize) {
    if (signal.aborted) throw abortError();
    const samples = await source.read(start, Math.min(start + blockSize, source.sampleCount));
    analyzer.add(samples);
    for (let index = 0; index < samples.length; index += 1) {
      const bucket = Math.floor((start + index) * peaks.length / source.sampleCount);
      peaks[bucket] = Math.max(peaks[bucket], Math.abs(samples[index]));
    }
  }
  if (signal.aborted) throw abortError();
  return { peaks, analysis: analyzer.finish() };
}

/**
 * Plan transcription chunks for a block-read WAV, cutting each boundary at the
 * quietest 100 ms inside a short window around the target length. This matches
 * what `splitAtSilence` does for fully decoded audio, so long WAV imports are
 * not cut mid-word at fixed 30 s marks. Only the search windows are read.
 */
export async function planWaveChunks(
  source: Pick<WaveSource, 'sampleCount' | 'read'>,
  targetSeconds = 30,
  searchSeconds = 2.5,
  sampleRate = TARGET_SAMPLE_RATE,
): Promise<Array<{ startSample: number; endSample: number }>> {
  const total = source.sampleCount;
  if (total <= 0) return [];
  const target = Math.round(Math.max(5, targetSeconds) * sampleRate);
  const search = Math.round(Math.max(0.5, searchSeconds) * sampleRate);
  const minChunk = Math.min(10 * sampleRate, target);
  const windowSize = Math.max(1, Math.round(0.1 * sampleRate));
  const step = Math.max(1, Math.round(0.01 * sampleRate));
  const chunks: Array<{ startSample: number; endSample: number }> = [];
  let start = 0;

  while (total - start > target + search) {
    const from = Math.max(start + minChunk, start + target - search);
    const to = Math.min(total, start + target + search);
    const samples = await source.read(from, to);
    // Prefix sums of energy make every window O(1).
    const energy = new Float64Array(samples.length + 1);
    for (let i = 0; i < samples.length; i += 1) {
      const value = Number.isFinite(samples[i]) ? samples[i] : 0;
      energy[i + 1] = energy[i] + value * value;
    }
    let best = Math.floor(samples.length / 2);
    let bestEnergy = Infinity;
    for (let offset = 0; offset + windowSize <= samples.length; offset += step) {
      const value = energy[offset + windowSize] - energy[offset];
      if (value < bestEnergy) {
        bestEnergy = value;
        best = offset + Math.floor(windowSize / 2);
      }
    }
    const cut = Math.min(total, Math.max(start + minChunk, from + best));
    chunks.push({ startSample: start, endSample: cut });
    start = cut;
  }
  chunks.push({ startSample: start, endSample: total });
  return chunks;
}
