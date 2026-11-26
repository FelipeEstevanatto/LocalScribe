/**
 * Batch trim-silence in the PCM domain. The browser decodes the source and
 * Mediabunny encodes the result, so the 32 MB FFmpeg core is not needed for
 * common formats. Callers keep the FFmpeg filter as a fallback.
 */

import type { AudioFormat } from './audio-ffmpeg';
import { sharedMedia } from './media-router';
import { readFloatWav, writeFloatWav } from './pcm-audio';

export interface SilenceBounds {
  start: number;
  end: number;
}

export function trimSilenceBounds(
  channels: readonly Float32Array[],
  sampleRate: number,
  thresholdDb = -50,
  keepSeconds = 0.1,
): SilenceBounds {
  const frames = channels.reduce((length, channel) => Math.min(length, channel.length), Number.POSITIVE_INFINITY);
  if (!Number.isFinite(frames) || frames <= 0 || sampleRate <= 0) return { start: 0, end: 0 };
  const threshold = 10 ** (thresholdDb / 20);
  let first = -1;
  let last = -1;
  for (let frame = 0; frame < frames; frame += 1) {
    let loud = false;
    for (const channel of channels) {
      if (Math.abs(channel[frame]) >= threshold) {
        loud = true;
        break;
      }
    }
    if (!loud) continue;
    if (first < 0) first = frame;
    last = frame;
  }
  const keep = Math.max(1, Math.round(sampleRate * Math.max(0, keepSeconds)));
  if (first < 0) return { start: 0, end: Math.min(frames, keep) };
  return {
    start: Math.max(0, first - keep),
    end: Math.min(frames, last + 1 + keep),
  };
}

export interface TrimSilenceOptions {
  signal?: AbortSignal;
  onProgress?: (progress: { ratio: number | null; time: number }) => void;
}

export async function trimSilenceFile(
  file: Blob,
  format: AudioFormat,
  options: TrimSilenceOptions = {},
): Promise<Blob> {
  const media = sharedMedia();
  const decoded = await media.decode(file, {
    signal: options.signal,
    onProgress: ({ ratio, time }) => options.onProgress?.({ ratio: ratio === null ? null : ratio * 0.6, time }),
  });
  const pcm = decoded.pcm ?? await readFloatWav(decoded.wav);
  if (!pcm.channels.length) throw new Error('The browser decoder returned no PCM samples.');
  const { start, end } = trimSilenceBounds(pcm.channels, pcm.sampleRate);
  if (!(end > start)) throw new Error('The trimmed audio is empty.');
  const wav = writeFloatWav(
    pcm.channels.map((channel) => channel.subarray(start, end)),
    pcm.sampleRate,
  );
  return media.encode(wav, format, {
    signal: options.signal,
    onProgress: ({ ratio, time }) => options.onProgress?.({ ratio: ratio === null ? null : 0.6 + ratio * 0.4, time }),
  });
}
