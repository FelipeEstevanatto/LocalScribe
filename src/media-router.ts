/**
 * Chooses the fast Mediabunny path when it can handle the operation and falls
 * back to the existing FFmpeg worker otherwise.
 *
 * The FFmpeg object is constructed eagerly but its 32 MB worker/core is still
 * loaded only on the first actual FFmpeg operation.
 */

import { isAbortError } from './errors';
import { FfmpegEngine } from './ffmpeg-engine';
import type { MediabunnyEngine } from './mediabunny-engine';
import type { AudioFormat, MediaProbe } from './audio-ffmpeg';
import {
  UnsupportedMediaError,
  type DecodeOptions,
  type DecodedAudio,
  type EncodeOptions,
  type FormatCapability,
  type MediaEngine,
} from './media-types';

type EngineId = 'mediabunny' | 'ffmpeg';

function forcedEngine(): EngineId | null {
  try {
    const value = new URLSearchParams(location.search).get('mediaEngine')
      ?? localStorage.getItem('mediaEngine');
    return value === 'ffmpeg' || value === 'mediabunny' ? value : null;
  } catch {
    return null;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A video may be a perfectly valid file and still have no sound to edit. */
function missingAudio(error: unknown): boolean {
  return error instanceof UnsupportedMediaError && /no audio track/i.test(error.message);
}

class MediaRouter {
  private readonly ffmpeg = new FfmpegEngine();
  private mediabunnyPromise: Promise<MediabunnyEngine> | null = null;
  private capabilityCache: Promise<Record<AudioFormat, FormatCapability>> | null = null;

  lastEngine: EngineId | null = null;
  lastFallbackReason: string | null = null;

  private async fastEngine(): Promise<MediabunnyEngine> {
    this.mediabunnyPromise ??= import('./mediabunny-engine').then(
      ({ MediabunnyEngine }) => new MediabunnyEngine(),
    );
    return this.mediabunnyPromise;
  }

  private get fast(): boolean {
    return forcedEngine() !== 'ffmpeg';
  }

  private get canFallback(): boolean {
    return true;
  }

  async probe(file: Blob, signal?: AbortSignal): Promise<MediaProbe> {
    if (this.fast) {
      try {
        const engine = await this.fastEngine();
        if (await engine.canHandle(file)) {
          const result = await engine.probe(file, signal);
          this.lastEngine = 'mediabunny';
          return result;
        }
      } catch (error) {
        if (isAbortError(error) || !this.canFallback) throw error;
        this.lastFallbackReason = describeError(error);
      }
    }
    this.lastEngine = 'ffmpeg';
    return this.ffmpeg.probe(file, signal);
  }

  async decode(file: Blob, options: DecodeOptions = {}): Promise<DecodedAudio> {
    if (this.fast) {
      try {
        const engine = await this.fastEngine();
        if (await engine.canHandle(file)) {
          const result = await engine.decode(file, options);
          this.lastEngine = 'mediabunny';
          return result;
        }
      } catch (error) {
        if (isAbortError(error) || missingAudio(error) || !this.canFallback) throw error;
        this.lastFallbackReason = describeError(error);
      }
    }
    this.lastEngine = 'ffmpeg';
    return this.ffmpeg.decode(file, options);
  }

  async trim(file: Blob, start: number, end: number, options: DecodeOptions = {}): Promise<DecodedAudio> {
    if (this.fast) {
      try {
        const engine = await this.fastEngine();
        if (await engine.canHandle(file)) {
          const result = await engine.trim(file, start, end, options);
          this.lastEngine = 'mediabunny';
          return result;
        }
      } catch (error) {
        if (isAbortError(error) || missingAudio(error) || !this.canFallback) throw error;
        this.lastFallbackReason = describeError(error);
      }
    }
    this.lastEngine = 'ffmpeg';
    return this.ffmpeg.trim(file, start, end, options);
  }

  async encode(source: Blob, format: AudioFormat, options: EncodeOptions = {}): Promise<Blob> {
    // WAV and FLAC are faster in FFmpeg's C filters once the worker is already
    // warm. The fast path still wins when the worker would have to load.
    if ((format === 'wav' || format === 'flac') && this.ffmpeg.loaded) {
      this.lastEngine = 'ffmpeg';
      return this.ffmpeg.encode(source, format, options);
    }
    if (this.fast) {
      try {
        const engine = await this.fastEngine();
        const capabilities = await this.capabilities();
        if (capabilities[format]?.fast) {
          const result = await engine.encode(source, format, options);
          this.lastEngine = 'mediabunny';
          return result;
        }
        this.lastFallbackReason = capabilities[format]?.reason ?? 'Fast path unavailable.';
      } catch (error) {
        if (isAbortError(error) || !this.canFallback) throw error;
        this.lastFallbackReason = describeError(error);
      }
    }
    this.lastEngine = 'ffmpeg';
    return this.ffmpeg.encode(source, format, options);
  }

  capabilities(): Promise<Record<AudioFormat, FormatCapability>> {
    this.capabilityCache ??= this.readCapabilities();
    return this.capabilityCache;
  }

  resetCapabilities(): void {
    this.capabilityCache = null;
  }

  private async readCapabilities(): Promise<Record<AudioFormat, FormatCapability>> {
    try {
      const fast = await (await this.fastEngine()).capabilities();
      return Object.fromEntries(
        Object.entries(fast).map(([format, capability]) => [
          format,
          {
            ...capability,
            fallback: true,
            ...(capability.fast ? {} : { reason: capability.reason ?? 'FFmpeg fallback.' }),
          },
        ]),
      ) as Record<AudioFormat, FormatCapability>;
    } catch (error) {
      const reason = `Fast path unavailable: ${describeError(error)}`;
      const formats = await this.ffmpeg.capabilities();
      return Object.fromEntries(
        Object.entries(formats).map(([format, capability]) => [
          format,
          { ...capability, fast: false, fallback: true, reason },
        ]),
      ) as Record<AudioFormat, FormatCapability>;
    }
  }
}

let shared: MediaRouter | null = null;

export function sharedMedia(): MediaRouter {
  shared ??= new MediaRouter();
  return shared;
}

export type { MediaEngine, EngineId };
export { UnsupportedMediaError };
