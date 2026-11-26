/**
 * Mediabunny-backed media engine.
 *
 * Fast path for modern containers and codecs. Anything it cannot read or
 * write throws UnsupportedMediaError so MediaRouter can use FFmpeg.
 */

import {
  ALL_FORMATS,
  AdtsOutputFormat,
  AudioBufferSink,
  BlobSource,
  BufferTarget,
  Conversion,
  EncodedAudioPacketSource,
  EncodedPacketSink,
  FlacOutputFormat,
  Input,
  Mp3OutputFormat,
  Mp4OutputFormat,
  OggOutputFormat,
  Output,
  Quality,
  WavOutputFormat,
  WebMOutputFormat,
  canEncodeAudio,
  type AudioCodec,
  type OutputFormat,
} from 'mediabunny';
import { AUDIO_FORMATS, type AudioFormat, type MediaProbe } from './audio-ffmpeg';
import {
  UnsupportedMediaError,
  type DecodeOptions,
  type DecodedAudio,
  type EncodeOptions,
  type FormatCapability,
  type MediaEngine,
} from './media-types';
import { concatFloat32, writeFloatWav } from './pcm-audio';

const MAX_FAST_DECODE_SECONDS = 20 * 60;

/**
 * Stream the audio track in decoder-sized buffers and keep only a peak
 * envelope. This avoids decoding a long video into one giant AudioBuffer just
 * to draw its timeline waveform.
 */
export async function streamAudioPeaks(
  file: Blob,
  buckets: number,
  signal?: AbortSignal,
): Promise<Float32Array | null> {
  const count = Math.max(1, Math.floor(buckets));
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    if (!(await input.canRead())) return null;
    const track = (await input.getAudioTracks())[0];
    if (!track || !(await track.canDecode())) return null;
    const duration = await track.computeDuration();
    if (!(duration > 0)) return null;
    const peaks = new Float32Array(count);
    const sink = new AudioBufferSink(track);
    for await (const { buffer, timestamp } of sink.buffers(0, duration, { skipLiveWait: true })) {
      signal?.throwIfAborted();
      const sampleRate = buffer.sampleRate;
      const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index));
      const start = Math.round(timestamp * sampleRate);
      for (let index = 0; index < buffer.length; index += 4) {
        const time = (start + index) / sampleRate;
        const bucket = Math.min(count - 1, Math.max(0, Math.floor((time / duration) * count)));
        let peak = peaks[bucket];
        for (const data of channels) {
          const value = Math.abs(data[index]);
          if (value > peak) peak = value;
        }
        peaks[bucket] = peak;
      }
    }
    return peaks;
  } finally {
    input.dispose();
  }
}

/**
 * Decode only a source time range and keep its peak envelope. Used for the
 * high-resolution waveform around the part of a clip that is zoomed in.
 */
export async function streamAudioPeaksRange(
  file: Blob,
  start: number,
  end: number,
  buckets: number,
  signal?: AbortSignal,
  sampleStep = 1,
): Promise<Float32Array | null> {
  const count = Math.max(1, Math.floor(buckets));
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    if (!(await input.canRead())) return null;
    const track = (await input.getAudioTracks())[0];
    if (!track || !(await track.canDecode())) return null;
    const duration = await track.computeDuration();
    if (!(duration > 0)) return null;
    const from = Math.max(0, Math.min(duration, start));
    const to = Math.max(from, Math.min(duration, end));
    if (!(to > from)) return null;
    const span = to - from;
    const peaks = new Float32Array(count);
    const sink = new AudioBufferSink(track);
    for await (const { buffer, timestamp } of sink.buffers(from, to, { skipLiveWait: true })) {
      signal?.throwIfAborted();
      const sampleRate = buffer.sampleRate;
      const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index));
      const bufferStart = Math.round(timestamp * sampleRate);
      for (let index = 0; index < buffer.length; index += Math.max(1, sampleStep)) {
        const time = (bufferStart + index) / sampleRate;
        if (time < from || time >= to) continue;
        const bucket = Math.min(count - 1, Math.max(0, Math.floor(((time - from) / span) * count)));
        let peak = peaks[bucket];
        for (const data of channels) {
          const value = Math.abs(data[index]);
          if (value > peak) peak = value;
        }
        peaks[bucket] = peak;
      }
    }
    return peaks;
  } finally {
    input.dispose();
  }
}

export interface AudioEnvelopeRange {
  /** Most negative sample per bucket. */
  min: Float32Array;
  /** Most positive sample per bucket. */
  max: Float32Array;
}

/**
 * Decode only a source time range and keep signed min/max envelopes. This
 * gives the timeline a real asymmetric waveform at deep zoom instead of a
 * symmetrical absolute-peak block.
 */
export async function streamAudioEnvelopeRange(
  file: Blob,
  start: number,
  end: number,
  buckets: number,
  signal?: AbortSignal,
  sampleStep = 1,
): Promise<AudioEnvelopeRange | null> {
  const count = Math.max(1, Math.floor(buckets));
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    if (!(await input.canRead())) return null;
    const track = (await input.getAudioTracks())[0];
    if (!track || !(await track.canDecode())) return null;
    const duration = await track.computeDuration();
    if (!(duration > 0)) return null;
    const from = Math.max(0, Math.min(duration, start));
    const to = Math.max(from, Math.min(duration, end));
    if (!(to > from)) return null;
    const span = to - from;
    const min = new Float32Array(count);
    const max = new Float32Array(count);
    const sink = new AudioBufferSink(track);
    for await (const { buffer, timestamp } of sink.buffers(from, to, { skipLiveWait: true })) {
      signal?.throwIfAborted();
      const sampleRate = buffer.sampleRate;
      const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index));
      const bufferStart = Math.round(timestamp * sampleRate);
      for (let index = 0; index < buffer.length; index += Math.max(1, sampleStep)) {
        const time = (bufferStart + index) / sampleRate;
        if (time < from || time >= to) continue;
        const bucket = Math.min(count - 1, Math.max(0, Math.floor(((time - from) / span) * count)));
        for (const data of channels) {
          const value = data[index];
          if (value < min[bucket]) min[bucket] = value;
          if (value > max[bucket]) max[bucket] = value;
        }
      }
    }
    return { min, max };
  } finally {
    input.dispose();
  }
}

/**
 * Copy one AAC or Opus track into a compatible audio container without decoding. Returns
 * null when the selected codec and container are incompatible.
 */
export async function remuxAudioTrack(
  file: Blob,
  trackIndex: number,
  format: 'm4a' | 'aac' | 'webm',
  signal?: AbortSignal,
  preserveTimeline = false,
): Promise<Blob | null> {
  const codec = format === 'webm' ? 'opus' : 'aac';
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    if (!(await input.canRead())) return null;
    const tracks = await input.getAudioTracks();
    const track = tracks[trackIndex];
    if (!track || (await track.getCodec()) !== codec) return null;
    const config = await track.getDecoderConfig();
    const output = new Output({
      format: format === 'webm' ? new WebMOutputFormat()
        : format === 'm4a' ? new Mp4OutputFormat({ fastStart: 'in-memory' }) : new AdtsOutputFormat(),
      target: new BufferTarget(),
    });
    const source = new EncodedAudioPacketSource(codec);
    output.addAudioTrack(source);
    await output.start();
    const base = preserveTimeline ? await input.getFirstTimestamp() : await track.getFirstTimestamp();
    let first = true;
    for await (const packet of new EncodedPacketSink(track).packets()) {
      signal?.throwIfAborted();
      await source.add(
        packet.clone({ timestamp: packet.timestamp - base }),
        first ? { decoderConfig: config ?? undefined } : undefined,
      );
      first = false;
    }
    await output.finalize();
    const buffer = (output.target as BufferTarget).buffer;
    if (!buffer?.byteLength) return null;
    return new Blob([buffer], { type: format === 'webm' ? 'audio/webm' : format === 'm4a' ? 'audio/mp4' : 'audio/aac' });
  } finally {
    input.dispose();
  }
}

/** Repackage playable video for the native preview without encoding frames. */
export async function remuxVideoPreview(file: Blob, signal: AbortSignal): Promise<Blob | null> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const video = await input.getPrimaryVideoTrack();
    const codec = await video?.getCodec();
    const format = new Mp4OutputFormat({ fastStart: 'in-memory' });
    if (!video || !codec || !format.getSupportedCodecs().includes(codec) || !(await video.canDecode())) return null;
    const audio = await input.getPrimaryAudioTrack();
    const audioCodec = await audio?.getCodec();
    // AAC can be carried into the preview unchanged. Other codecs get their own editor audio source.
    const target = new BufferTarget();
    const output = new Output({ format, target });
    const conversion = await Conversion.init({
      input, output, tracks: 'primary',
      video: { codec },
      audio: audioCodec === 'aac' ? { codec: audioCodec } : { discard: true },
    });
    if (!conversion.isValid || conversion.discardedTracks.some((entry) => entry.track === video)) return null;
    const stop = () => void conversion.cancel();
    signal.addEventListener('abort', stop, { once: true });
    try {
      signal.throwIfAborted();
      await conversion.execute();
      signal.throwIfAborted();
      return target.buffer ? new Blob([target.buffer], { type: 'video/mp4' }) : null;
    } finally {
      signal.removeEventListener('abort', stop);
    }
  } finally {
    input.dispose();
  }
}

interface FormatSpec {
  format: () => OutputFormat;
  codec: AudioCodec;
  quality?: Quality;
  sampleRate?: number;
  sampleFormat?: 'u8' | 's16' | 's32' | 'f32';
  ensure?: () => Promise<void>;
}

function formatSpec(format: AudioFormat): FormatSpec | null {
  switch (format) {
    case 'wav':
      return { format: () => new WavOutputFormat(), codec: 'pcm-s16', sampleFormat: 's16' };
    case 'mp3':
      return {
        format: () => new Mp3OutputFormat(),
        codec: 'mp3',
        quality: new Quality({ bitrate: 128e3 }),
        ensure: ensureMp3,
      };
    case 'flac':
      return {
        format: () => new FlacOutputFormat(),
        codec: 'flac',
        sampleFormat: 's16',
        ensure: ensureFlac,
      };
    case 'm4a':
      return {
        format: () => new Mp4OutputFormat({ fastStart: 'in-memory' }),
        codec: 'aac',
        quality: new Quality({ bitrate: 192e3 }),
        ensure: ensureAac,
      };
    case 'aac':
      return {
        format: () => new AdtsOutputFormat(),
        codec: 'aac',
        quality: new Quality({ bitrate: 192e3 }),
        ensure: ensureAac,
      };
    case 'opus':
      return {
        format: () => new OggOutputFormat(),
        codec: 'opus',
        quality: new Quality({ bitrate: 96e3 }),
        sampleRate: 48_000,
      };
    case 'webm':
      return {
        format: () => new WebMOutputFormat(),
        codec: 'opus',
        quality: new Quality({ bitrate: 96e3 }),
        sampleRate: 48_000,
      };
    case 'ogg':
    case 'aiff':
    case 'caf':
      return null;
    default:
      return null;
  }
}

let mp3Encoder: Promise<void> | null = null;
let aacEncoder: Promise<void> | null = null;
let flacEncoder: Promise<void> | null = null;

async function hasNative(codec: AudioCodec): Promise<boolean> {
  try {
    return await canEncodeAudio(codec);
  } catch {
    return false;
  }
}

async function ensureMp3(): Promise<void> {
  if (await hasNative('mp3')) return;
  mp3Encoder ??= import('@mediabunny/mp3-encoder').then(({ registerMp3Encoder }) => {
    registerMp3Encoder();
  });
  await mp3Encoder;
}

async function ensureAac(): Promise<void> {
  if (await hasNative('aac')) return;
  aacEncoder ??= import('@mediabunny/aac-encoder').then(({ registerAacEncoder }) => {
    registerAacEncoder();
  });
  await aacEncoder;
}

async function ensureFlac(): Promise<void> {
  if (await hasNative('flac')) return;
  flacEncoder ??= import('@mediabunny/flac-encoder').then(({ registerFlacEncoder }) => {
    registerFlacEncoder();
  });
  await flacEncoder;
}

function streamCodec(trackCodec: string | null): string {
  return trackCodec ?? 'unknown';
}

export class MediabunnyEngine implements MediaEngine {
  readonly id = 'mediabunny' as const;
  private capabilityCache: Promise<Record<AudioFormat, FormatCapability>> | null = null;

  async canHandle(file: Blob): Promise<boolean> {
    const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
    try {
      return await input.canRead();
    } catch {
      return false;
    } finally {
      input.dispose();
    }
  }

  async probe(file: Blob, signal?: AbortSignal): Promise<MediaProbe> {
    signal?.throwIfAborted();
    const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
    try {
      if (!(await input.canRead())) throw new UnsupportedMediaError('Mediabunny cannot read this container.');
      const [duration, audioTracks, videoTrack] = await Promise.all([
        input.computeDuration(),
        input.getAudioTracks(),
        input.getPrimaryVideoTrack(),
      ]);
      const audio = audioTracks[0] ?? null;
      const audioStreams = await Promise.all(
        audioTracks.map(async (track) => ({
          codec: streamCodec(await track.getCodec()),
          language: (await track.getLanguageCode()) || null,
          channels: String(await track.getNumberOfChannels()),
          title: await track.getName(),
          sampleRate: await track.getSampleRate(),
        })),
      );
      let width = 0;
      let height = 0;
      let fps = 0;
      let rotation = 0;
      if (videoTrack) {
        width = await videoTrack.getDisplayWidth();
        height = await videoTrack.getDisplayHeight();
        rotation = -(await videoTrack.getRotation());
        try {
          fps = (await videoTrack.computeFrameRateMetrics({ targetPacketCount: 64 })).bestGuessFrameRate;
        } catch {
          fps = 0;
        }
      }
      signal?.throwIfAborted();
      return {
        duration,
        hasVideo: Boolean(videoTrack),
        hasAudio: Boolean(audio),
        videoCodec: videoTrack ? streamCodec(await videoTrack.getCodec()) : null,
        audioCodec: audio ? streamCodec(await audio.getCodec()) : null,
        width,
        height,
        fps,
        rotation,
        audioStreams,
      };
    } finally {
      input.dispose();
    }
  }

  async decode(file: Blob, options: DecodeOptions = {}): Promise<DecodedAudio> {
    const { signal, trim, onProgress } = options;
    signal?.throwIfAborted();
    const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
    try {
      if (!(await input.canRead())) throw new UnsupportedMediaError('Mediabunny cannot read this container.');
      const track = (await input.getAudioTracks())[0];
      if (!track) throw new UnsupportedMediaError('This file has no audio track. Choose a file with sound.');
      if (!(await track.canDecode())) {
        throw new UnsupportedMediaError(`This browser cannot decode ${streamCodec(await track.getCodec())} audio.`);
      }
      const trackDuration = await track.computeDuration();
      const start = Math.max(0, trim?.start ?? 0);
      const end = Math.min(trackDuration, trim?.end ?? trackDuration);
      if (!(end > start)) throw new Error('The trim range is empty.');
      if (end - start > MAX_FAST_DECODE_SECONDS) {
        throw new UnsupportedMediaError('Files longer than 20 minutes use the FFmpeg engine.');
      }
      const sink = new AudioBufferSink(track);
      const channelChunks: Float32Array[][] = [];
      let sampleRate = 0;
      let channels = 0;
      let frames = 0;
      const origin = start;
      for await (const { buffer, timestamp } of sink.buffers(start, end, { skipLiveWait: true })) {
        signal?.throwIfAborted();
        if (!sampleRate) {
          sampleRate = buffer.sampleRate;
          channels = buffer.numberOfChannels;
          if (channels > 2) {
            throw new UnsupportedMediaError('Audio with more than two channels uses the FFmpeg engine.');
          }
          channelChunks.push(...Array.from({ length: channels }, () => []));
        }
        if (buffer.sampleRate !== sampleRate || buffer.numberOfChannels !== channels) {
          throw new UnsupportedMediaError('The audio track changes format mid-stream.');
        }
        const offset = Math.round((timestamp - origin) * sampleRate);
        if (offset > frames) {
          const silence = new Float32Array(offset - frames);
          for (const chunks of channelChunks) chunks.push(silence);
          frames = offset;
        }
        const skip = offset < 0 ? Math.min(-offset, buffer.length) : Math.max(0, frames - offset);
        const count = buffer.length - skip;
        if (count <= 0) continue;
        for (let channel = 0; channel < channels; channel += 1) {
          const source = buffer.getChannelData(channel);
          const chunk = skip > 0 ? source.subarray(skip) : source;
          channelChunks[channel].push(chunk.slice());
        }
        frames += count;
        onProgress?.({
          ratio: Math.min(1, (timestamp + buffer.duration - start) / (end - start)),
          time: Math.min(end, timestamp + buffer.duration),
        });
      }
      if (!sampleRate || !channels || !frames) {
        throw new UnsupportedMediaError('The audio track contains no decodable frames.');
      }
      const planar = channelChunks.map((chunks) => concatFloat32(chunks));
      const wav = writeFloatWav(planar, sampleRate);
      onProgress?.({ ratio: 1, time: end });
      return {
        wav,
        pcm: { channels: planar, sampleRate, channelMask: 0, frames },
        sampleRate,
        channels,
        channelMask: 0,
        duration: frames / sampleRate,
      };
    } finally {
      input.dispose();
    }
  }

  trim(file: Blob, start: number, end: number, options: DecodeOptions = {}): Promise<DecodedAudio> {
    return this.decode(file, { ...options, trim: { start, end } });
  }

  async encode(source: Blob, format: AudioFormat, options: EncodeOptions = {}): Promise<Blob> {
    const spec = formatSpec(format);
    if (!spec) throw new UnsupportedMediaError(`${format.toUpperCase()} is not available on the fast path.`);
    await spec.ensure?.();
    if (spec.codec !== 'pcm-s16' && !(await canEncodeAudio(spec.codec))) {
      throw new UnsupportedMediaError(`This browser cannot encode ${spec.codec} audio.`);
    }
    const input = new Input({ source: new BlobSource(source), formats: ALL_FORMATS });
    const duration = await input.computeDuration();
    const output = new Output({ format: spec.format(), target: new BufferTarget() });
    try {
      const conversion = await Conversion.init({
        input,
        output,
        tracks: 'primary',
        // Audio formats in MP4 containers must not accidentally keep video.
        video: { discard: true },
        audio: {
          codec: spec.codec,
          ...(spec.quality ? { quality: spec.quality } : {}),
          ...(spec.sampleRate ? { sampleRate: spec.sampleRate } : {}),
          ...(spec.sampleFormat ? { sampleFormat: spec.sampleFormat } : {}),
        },
        showWarnings: false,
      });
      if (!conversion.isValid) {
        throw new UnsupportedMediaError(
          `Mediabunny cannot create a valid ${format.toUpperCase()} conversion.`,
        );
      }
      const cancel = (): void => {
        void conversion.cancel();
      };
      options.signal?.addEventListener('abort', cancel, { once: true });
      conversion.onProgress = (progress) => {
        options.onProgress?.({ ratio: progress, time: progress * duration });
      };
      try {
        await conversion.execute();
      } finally {
        options.signal?.removeEventListener('abort', cancel);
      }
      options.signal?.throwIfAborted();
      const buffer = (output.target as BufferTarget).buffer;
      if (!buffer || !buffer.byteLength) throw new Error('The encoder returned an empty file.');
      return new Blob([buffer], { type: AUDIO_FORMATS[format].mime });
    } finally {
      input.dispose();
    }
  }

  capabilities(): Promise<Record<AudioFormat, FormatCapability>> {
    this.capabilityCache ??= this.readCapabilities();
    return this.capabilityCache;
  }

  private async readCapabilities(): Promise<Record<AudioFormat, FormatCapability>> {
    const entries = await Promise.all(
      (Object.keys(AUDIO_FORMATS) as AudioFormat[]).map(async (format) => {
        const spec = formatSpec(format);
        if (!spec) {
          return [format, { fast: false, fallback: true, reason: 'Uses the FFmpeg fallback.' }] as const;
        }
        let fast = false;
        try {
          // Extension-backed codecs are bundled and lazy-loaded on first use.
          // Do not import them just to render a format hint.
          fast = spec.codec === 'pcm-s16' || Boolean(spec.ensure) || (await canEncodeAudio(spec.codec)) === true;
        } catch {
          fast = false;
        }
        return [
          format,
          fast
            ? { fast: true, fallback: true }
            : { fast: false, fallback: true, reason: 'Uses the FFmpeg fallback in this browser.' },
        ] as const;
      }),
    );
    return Object.fromEntries(entries) as Record<AudioFormat, FormatCapability>;
  }
}
