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
