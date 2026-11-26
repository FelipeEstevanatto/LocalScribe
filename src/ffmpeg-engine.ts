/**
 * FFmpeg adapter for the MediaEngine seam.
 *
 * This keeps the existing AudioFfmpeg worker as the compatibility and DSP
 * fallback. The worker itself stays lazy: constructing this object does not
 * download or start the 32 MB core.
 */

import {
  AUDIO_FORMATS,
  sharedFfmpeg,
  type AudioFormat,
  type MediaProbe,
} from './audio-ffmpeg';
import { inspectEditorAudio, prepareEditorAudio } from './audio-edit';
import type {
  DecodeOptions,
  DecodedAudio,
  EncodeOptions,
  FormatCapability,
  MediaEngine,
} from './media-types';

export class FfmpegEngine implements MediaEngine {
  readonly id = 'ffmpeg' as const;
  private readonly client = sharedFfmpeg();

  get loaded(): boolean {
    return this.client.loaded;
  }

  async canHandle(): Promise<boolean> {
    return true;
  }

  probe(file: Blob, signal?: AbortSignal): Promise<MediaProbe> {
    return this.client.probe(file, signal);
  }

  async decode(file: Blob, options: DecodeOptions = {}): Promise<DecodedAudio> {
    const signal = options.signal ?? new AbortController().signal;
    const wav = await prepareEditorAudio(this.client, file, {
      signal,
      onProgress: options.onProgress,
    });
    const audio = await inspectEditorAudio(wav, signal);
    return {
      wav,
      sampleRate: audio.sampleRate,
      channels: audio.channels,
      channelMask: audio.channelMask,
      duration: audio.duration,
    };
  }

  async trim(file: Blob, start: number, end: number, options: DecodeOptions = {}): Promise<DecodedAudio> {
    const signal = options.signal ?? new AbortController().signal;
    const wav = await prepareEditorAudio(
      this.client,
      file,
      { signal, onProgress: options.onProgress },
      ['-ss', String(start), '-t', String(Math.max(0, end - start))],
    );
    const audio = await inspectEditorAudio(wav, signal);
    return {
      wav,
      sampleRate: audio.sampleRate,
      channels: audio.channels,
      channelMask: audio.channelMask,
      duration: audio.duration,
    };
  }

  encode(source: Blob, format: AudioFormat, options: EncodeOptions = {}): Promise<Blob> {
    return this.client.encode(source, format, options);
  }

  async capabilities(): Promise<Record<AudioFormat, FormatCapability>> {
    return Object.fromEntries(
      (Object.keys(AUDIO_FORMATS) as AudioFormat[]).map((format) => [
        format,
        { fast: false, fallback: true, reason: 'FFmpeg fallback.' },
      ]),
    ) as Record<AudioFormat, FormatCapability>;
  }
}
