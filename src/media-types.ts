import type { AudioFormat, MediaProbe } from './audio-ffmpeg';

/** A container or codec the fast path cannot handle. The router falls back. */
export class UnsupportedMediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedMediaError';
  }
}

/** Planar float PCM. Chunks are kept per channel to avoid one huge interleave. */
export interface PcmAudio {
  channels: Float32Array[];
  sampleRate: number;
  channelMask: number;
  frames: number;
}

export interface DecodedAudio {
  /** Float WAV, matching the Audio studio's internal version.blob. */
  wav: Blob;
  /** Optional planar PCM for analysis and future DSP. */
  pcm?: PcmAudio;
  sampleRate: number;
  channels: number;
  channelMask: number;
  duration: number;
}

export interface DecodeOptions {
  signal?: AbortSignal;
  trim?: { start: number; end: number };
  onProgress?: (progress: { ratio: number | null; time: number }) => void;
}

export interface EncodeOptions {
  signal?: AbortSignal;
  onProgress?: (progress: { ratio: number | null; time: number }) => void;
}

export interface FormatCapability {
  /** The Mediabunny/WebCodecs path can write this format in this browser. */
  fast: boolean;
  /** The FFmpeg worker can write this format. */
  fallback: boolean;
  reason?: string;
}

export interface MediaEngine {
  readonly id: 'mediabunny' | 'ffmpeg';
  canHandle(file: Blob): Promise<boolean>;
  probe(file: Blob, signal?: AbortSignal): Promise<MediaProbe>;
  decode(file: Blob, options?: DecodeOptions): Promise<DecodedAudio>;
  trim(file: Blob, start: number, end: number, options?: DecodeOptions): Promise<DecodedAudio>;
  encode(source: Blob, format: AudioFormat, options?: EncodeOptions): Promise<Blob>;
  capabilities(): Promise<Record<AudioFormat, FormatCapability>>;
}
