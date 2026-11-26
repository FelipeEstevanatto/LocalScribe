/**
 * Sample-level fast path for the simple Audio studio edits.
 *
 * This deliberately handles only edits that are unambiguous in the PCM
 * domain: trim/cut, gain, fades, mono, and reverse. Anything involving
 * denoise, loudness, limiting, pitch/tempo, EQ, reverb, joins, or stems stays
 * on the FFmpeg filter graph.
 */

import type { AudioEdit } from './audio-edit';
import type { FfmpegProgress } from './audio-ffmpeg';
import { readFloatWav, writeFloatWav } from './pcm-audio';

export interface FastEditOptions {
  signal?: AbortSignal;
  onProgress?: (progress: FfmpegProgress) => void;
}

const SIMPLE_EFFECTS = new Set(['', 'fade-in', 'fade-out', 'fades', 'reverse', 'mono']);

export function canRenderFast(edit: AudioEdit): boolean {
  if ((edit.denoise ?? 0) > 0) return false;
  if (edit.loudness !== null || edit.ceiling !== null) return false;
  if ((edit.pitch ?? 0) !== 0 || (edit.tempo ?? 1) !== 1) return false;
  if ((edit.bass ?? 0) !== 0 || (edit.treble ?? 0) !== 0) return false;
  if (edit.effect && !SIMPLE_EFFECTS.has(edit.effect)) return false;
  for (const effect of edit.effects ?? []) {
    if (effect !== 'mono' && effect !== 'reverse') return false;
  }
  return true;
}

function slice(channels: Float32Array[], from: number, to: number): Float32Array[] {
  return channels.map((channel) => channel.subarray(from, to));
}

function concat(left: Float32Array[], right: Float32Array[]): Float32Array[] {
  return left.map((channel, index) => {
    const other = right[index];
    const output = new Float32Array(channel.length + other.length);
    output.set(channel, 0);
    output.set(other, channel.length);
    return output;
  });
}

function reverse(channels: Float32Array[]): Float32Array[] {
  return channels.map((channel) => channel.slice().reverse());
}

function toMono(channels: Float32Array[]): Float32Array[] {
  if (channels.length === 1) return [channels[0].slice(), channels[0].slice()];
  const frames = channels[0].length;
  const mono = new Float32Array(frames);
  const a = channels[0];
  const b = channels[1] ?? channels[0];
  for (let frame = 0; frame < frames; frame += 1) mono[frame] = (a[frame] + b[frame]) / 2;
  return [mono, mono.slice()];
}

function applyGain(channels: Float32Array[], db: number): void {
  if (!db) return;
  const gain = 10 ** (db / 20);
  for (const channel of channels) {
    for (let frame = 0; frame < channel.length; frame += 1) channel[frame] *= gain;
  }
}

function applyFade(channels: Float32Array[], sampleRate: number, fadeIn: number, fadeOut: number): void {
  if (!fadeIn && !fadeOut) return;
  const frames = channels[0].length;
  const inFrames = Math.min(frames, Math.round(fadeIn * sampleRate));
  const outFrames = Math.min(frames, Math.round(fadeOut * sampleRate));
  for (const channel of channels) {
    for (let frame = 0; frame < inFrames; frame += 1) channel[frame] *= frame / inFrames;
    for (let frame = 0; frame < outFrames; frame += 1) {
      channel[frames - 1 - frame] *= frame / outFrames;
    }
  }
}

/** Slice an existing float WAV without loading FFmpeg. */
export async function sliceFloatWav(
  source: Blob,
  start: number,
  duration: number,
  options: FastEditOptions = {},
): Promise<Blob> {
  options.signal?.throwIfAborted();
  const pcm = await readFloatWav(source);
  options.signal?.throwIfAborted();
  const from = Math.max(0, Math.min(pcm.frames, Math.round(start * pcm.sampleRate)));
  const to = Math.max(from, Math.min(pcm.frames, from + Math.round(duration * pcm.sampleRate)));
  return writeFloatWav(pcm.channels.map((channel) => channel.subarray(from, to)), pcm.sampleRate);
}

export async function renderFastEdit(
  source: Blob,
  edit: AudioEdit,
  options: FastEditOptions = {},
): Promise<Blob> {
  const { signal, onProgress } = options;
  signal?.throwIfAborted();
  onProgress?.({ ratio: 0.05, time: 0 });
  const pcm = await readFloatWav(source);
  signal?.throwIfAborted();
  onProgress?.({ ratio: 0.25, time: 0 });
  const sampleRate = pcm.sampleRate;
  const total = pcm.frames;
  const start = Math.max(0, Math.min(total, Math.round(edit.start * sampleRate)));
  const end = Math.max(start, Math.min(total, Math.round(edit.end * sampleRate)));

  let channels = pcm.channels;
  if (edit.cut === 'keep') {
    channels = slice(channels, start, end);
  } else if (edit.cut === 'remove') {
    if (start === 0) channels = slice(channels, end, total);
    else if (end === total) channels = slice(channels, 0, start);
    else channels = concat(slice(channels, 0, start), slice(channels, end, total));
  }
  signal?.throwIfAborted();

  const on = (name: string): boolean => edit.effect === name || (edit.effects ?? []).includes(name);
  if (on('reverse')) channels = reverse(channels);
  if (on('mono')) channels = toMono(channels);
  applyGain(channels, edit.gain);

  const duration = channels[0].length / sampleRate;
  const preset = Math.min(1, duration / 2);
  const fadeIn = Math.min(duration, edit.fadeIn ?? (edit.effect === 'fade-in' || edit.effect === 'fades' ? preset : 0));
  const fadeOut = Math.min(duration, edit.fadeOut ?? (edit.effect === 'fade-out' || edit.effect === 'fades' ? preset : 0));
  applyFade(channels, sampleRate, fadeIn, fadeOut);
  signal?.throwIfAborted();
  onProgress?.({ ratio: 0.85, time: duration });

  const output = writeFloatWav(channels, sampleRate);
  onProgress?.({ ratio: 1, time: duration });
  return output;
}
