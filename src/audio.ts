import { AppError, isAbortError } from './errors';
import { sharedFfmpeg } from './audio-ffmpeg';
import { readFloatWav as readPcmWav } from './pcm-audio';

export const TARGET_SAMPLE_RATE = 16_000;

export interface DecodedAudio {
  /** 16 kHz mono PCM in the range roughly [-1, 1]. */
  samples: Float32Array;
  duration: number;
  /** Sample rate of the decoded source before resampling. */
  originalSampleRate: number;
  originalChannels: number;
}

export interface AudioChunk {
  samples: Float32Array;
  /** Offset of this chunk in the original 16 kHz sample stream. */
  startSample: number;
}

export interface AudioAnalysis {
  /** Peak absolute sample value, 0..1. */
  peak: number;
  /** Root-mean-square level, 0..1. */
  rms: number;
  /** Fraction of the recording below the silence threshold, 0..1. */
  silenceRatio: number;
  /** Contiguous non-silent runs longer than 200 ms. */
  speechSegments: number;
  /** Longest silent run in seconds. */
  longestSilence: number;
}

/**
 * Cheap signal summary used by the Audio studio. It is deliberately
 * frame-based and model-free so it can run immediately after decoding.
 */
export function analyzeAudio(
  samples: Float32Array,
  sampleRate = TARGET_SAMPLE_RATE,
): AudioAnalysis {
  const analyzer = createAudioAnalyzer(sampleRate);
  analyzer.add(samples);
  return analyzer.finish();
}

export function createAudioAnalyzer(sampleRate = TARGET_SAMPLE_RATE) {
  const frameSize = Math.max(1, Math.round(sampleRate * 0.02));
  let frameCount = 0;
  let sampleCount = 0;
  let frameLength = 0;
  let frameSquares = 0;
  let peak = 0;
  let sumSquares = 0;
  let silentFrames = 0;
  let longestSilentFrames = 0;
  let currentSilentFrames = 0;
  let speechSegments = 0;
  let inSpeech = false;
  let speechRun = 0;

  function finishFrame(): void {
    frameCount += 1;
    sumSquares += frameSquares;
    const frameRms = Math.sqrt(frameSquares / frameLength);
    frameSquares = 0;
    frameLength = 0;
    const silent = frameRms < 0.008;

    if (silent) {
      silentFrames += 1;
      currentSilentFrames += 1;
      if (currentSilentFrames > longestSilentFrames) {
        longestSilentFrames = currentSilentFrames;
      }
      if (inSpeech) {
        if (speechRun >= 10) speechSegments += 1;
        inSpeech = false;
        speechRun = 0;
      }
    } else {
      currentSilentFrames = 0;
      inSpeech = true;
      speechRun += 1;
    }
  }

  return {
    add(samples: Float32Array): void {
      sampleCount += samples.length;
      for (let index = 0; index < samples.length; index += 1) {
        const value = samples[index];
        const magnitude = Math.abs(value);
        if (magnitude > peak) peak = magnitude;
        frameSquares += value * value;
        frameLength += 1;
        if (frameLength === frameSize) finishFrame();
      }
    },
    finish(): AudioAnalysis {
      if (frameLength) finishFrame();
      return {
        peak,
        rms: sampleCount ? Math.sqrt(sumSquares / sampleCount) : 0,
        silenceRatio: frameCount ? silentFrames / frameCount : 0,
        speechSegments: speechSegments + Number(inSpeech && speechRun >= 10),
        longestSilence: longestSilentFrames * 0.02,
      };
    },
  };
}

type AudioContextConstructor = typeof AudioContext;

function getAudioContextConstructor(): AudioContextConstructor {
  const ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: AudioContextConstructor }).webkitAudioContext;

  if (!ctor) {
    throw new AppError('This browser does not support the Web Audio API.', {
      code: 'NO_WEB_AUDIO',
      hint: 'Use a recent version of Chrome, Edge, Firefox, or Safari.',
    });
  }

  return ctor;
}

/** Extensions the local FFmpeg build can read, beyond what browsers decode. */
export const AUDIO_EXTENSIONS = [
  'wav', 'mp3', 'm4a', 'aac', 'flac', 'ogg', 'oga', 'opus', 'webm', 'weba', 'mka', 'wma', 'aiff', 'aif', 'aifc',
  'caf', 'alac', 'ac3', 'eac3', 'dts', 'thd', 'mlp', 'amr', 'awb', '3ga', 'ape', 'wv', 'tta', 'mpc', 'dsf', 'dff',
  'au', 'snd', 'voc', 'w64', 'rf64', 'gsm', 'ra', 'rm', 'mp2', 'mpa', 'spx', 'tak', 'm4b', 'm4r',
];
export const VIDEO_EXTENSIONS = [
  'mp4', 'm4v', 'mov', 'qt', 'mkv', 'webm', 'avi', 'wmv', 'asf', 'flv', 'f4v', '3gp', '3g2', 'ts', 'mts', 'm2ts',
  'mpg', 'mpeg', 'vob', 'mxf', 'ogv', 'dv', 'divx', 'rmvb', 'nut',
];
export const MEDIA_EXTENSIONS = [...AUDIO_EXTENSIONS, ...VIDEO_EXTENSIONS];
/** `accept` value for every audio-bearing input. */
export const MEDIA_ACCEPT = ['audio/*', 'video/*', ...MEDIA_EXTENSIONS.map((ext) => '.' + ext)].join(',');
export const VIDEO_ACCEPT = ['video/*', ...VIDEO_EXTENSIONS.map((ext) => '.' + ext)].join(',');

export function fileExtension(file: File): string {
  return file.name.includes('.') ? file.name.split('.').pop()!.toLowerCase() : '';
}

export function isVideoFile(file: File): boolean {
  return file.type.startsWith('video/') || VIDEO_EXTENSIONS.includes(fileExtension(file));
}

export function isSupportedFile(file: File): boolean {
  if (MEDIA_EXTENSIONS.includes(fileExtension(file))) return true;
  const type = file.type.toLowerCase();
  return type.startsWith('audio/') || type.startsWith('video/');
}

export interface DecodeOptions {
  /** Called when the browser cannot decode the file and FFmpeg takes over. */
  onFallback?: (message: string, fraction: number | null) => void;
  signal?: AbortSignal;
}

/** Read the samples of a mono float32 WAV produced by FFmpeg. */
export function readFloatWav(buffer: ArrayBuffer): Float32Array {
  const view = new DataView(buffer);
  for (let offset = 12; offset + 8 <= buffer.byteLength;) {
    const id = view.getUint32(offset);
    const size = view.getUint32(offset + 4, true);
    if (id === 0x64617461) {
      const length = Math.min(size, buffer.byteLength - offset - 8);
      return new Float32Array(buffer.slice(offset + 8, offset + 8 + length - (length % 4)));
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error('FFmpeg returned no audio samples.');
}

/** Decode with the local FFmpeg build (WMA, AMR, AC-3, DTS, APE, …). */
async function decodeWithFfmpeg(file: File, options: DecodeOptions): Promise<DecodedAudio> {
  const ffmpeg = sharedFfmpeg();
  const stop = ffmpeg.onLoad(({ loaded, total }) => {
    options.onFallback?.(`Loading the converter · ${Math.round((loaded / total) * 100)}%`, loaded / total);
  });
  try {
    options.onFallback?.('Converting with the local decoder…', null);
    const blob = await ffmpeg.run(
      file,
      ['-i', 'input.media', '-map', '0:a:0', '-vn', '-ac', '1', '-ar', String(TARGET_SAMPLE_RATE), '-c:a', 'pcm_f32le', '-f', 'wav', 'output.wav'],
      'output.wav',
      'audio/wav',
      {
        signal: options.signal,
        onProgress: ({ ratio, time }) => {
          options.onFallback?.(
            ratio === null ? `Converting · ${formatDuration(time)} done` : `Converting · ${Math.round(ratio * 100)}%`,
            ratio,
          );
        },
      },
    );
    const samples = readFloatWav(await blob.arrayBuffer());
    if (!samples.length) throw new Error('empty');
    return { samples, duration: samples.length / TARGET_SAMPLE_RATE, originalSampleRate: TARGET_SAMPLE_RATE, originalChannels: 1 };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new AppError(`“${file.name}” has no audio this app can read.`, {
      code: 'AUDIO_DECODE_FAILED',
      cause: error,
      hint: error instanceof Error && /matches no streams|0:a:0/i.test(error.message)
        ? 'The file contains no audio track.'
        : 'The file may be damaged or use a codec that is not included. Try converting it to WAV or MP3.',
    });
  } finally {
    stop();
  }
}

/**
 * Linear resampling and channel averaging for the Mediabunny decode path.
 * ASR only needs 16 kHz mono, so a short windowed sinc would add cost without
 * changing recognition quality.
 */
export function resampleMono(
  channels: readonly Float32Array[],
  sourceRate: number,
  targetRate = TARGET_SAMPLE_RATE,
): Float32Array {
  const frames = channels.reduce((length, channel) => Math.min(length, channel.length), Number.POSITIVE_INFINITY);
  if (!Number.isFinite(frames) || frames <= 0 || sourceRate <= 0 || targetRate <= 0) return new Float32Array();
  const count = channels.length;
  if (count === 1 && sourceRate === targetRate) return channels[0].slice();
  const outputFrames = Math.max(1, Math.round((frames * targetRate) / sourceRate));
  const output = new Float32Array(outputFrames);
  const step = sourceRate / targetRate;
  for (let frame = 0; frame < outputFrames; frame += 1) {
    const position = frame * step;
    const first = Math.min(frames - 1, Math.floor(position));
    const second = Math.min(frames - 1, first + 1);
    const fraction = position - first;
    let value = 0;
    for (const channel of channels) {
      value += channel[first] * (1 - fraction) + channel[second] * fraction;
    }
    output[frame] = value / count;
  }
  return output;
}

/** Try WebCodecs/Mediabunny before paying for the FFmpeg core. */
async function decodeWithMediabunny(file: File, options: DecodeOptions): Promise<DecodedAudio> {
  const { sharedMedia } = await import('./media-router');
  options.onFallback?.('Reading with the browser media engine…', null);
  const decoded = await sharedMedia().decode(file, {
    signal: options.signal,
    onProgress: ({ ratio }) => {
      options.onFallback?.(
        ratio === null ? 'Reading with the browser media engine…' : `Reading · ${Math.round(ratio * 100)}%`,
        ratio,
      );
    },
  });
  const pcm = decoded.pcm ?? await readPcmWav(decoded.wav);
  if (!pcm.channels.length) throw new Error('The browser decoder returned no PCM samples.');
  const samples = resampleMono(pcm.channels, pcm.sampleRate);
  if (!samples.length) throw new Error('The browser decoder returned no samples.');
  return {
    samples,
    duration: samples.length / TARGET_SAMPLE_RATE,
    originalSampleRate: pcm.sampleRate,
    originalChannels: pcm.channels.length,
  };
}

/**
 * Decode any format the browser's Web Audio implementation understands and
 * resample it to 16 kHz mono.
 *
 * OGG Vorbis is supported by Chromium and Firefox. Safari does not ship an OGG
 * decoder, so a friendly decoding error is surfaced there instead of failing
 * silently. The decoded buffer is resampled with OfflineAudioContext; this also
 * performs the stereo-to-mono downmix using the Web Audio channel rules.
 */
export async function decodeAudioFile(file: File, options: DecodeOptions = {}): Promise<DecodedAudio> {
  try {
    return await decodeWithBrowser(file);
  } catch (error) {
    // The browser only knows a few codecs; the WebCodecs path covers some of
    // those before the 32 MB FFmpeg core is worth loading.
    if (error instanceof AppError && error.code === 'AUDIO_DECODE_FAILED') {
      try {
        return await decodeWithMediabunny(file, options);
      } catch (fastError) {
        if (isAbortError(fastError)) throw fastError;
        return decodeWithFfmpeg(file, options);
      }
    }
    throw error;
  }
}

async function decodeWithBrowser(file: File): Promise<DecodedAudio> {
  const AudioCtor = getAudioContextConstructor();
  let context: AudioContext;

  try {
    context = new AudioCtor();
  } catch (error) {
    throw new AppError('Could not start the browser audio decoder.', {
      code: 'AUDIO_CONTEXT_FAILED',
      cause: error,
      hint: 'Close other tabs using audio, then reload the page and try again.',
    });
  }

  try {
    let decoded: AudioBuffer;

    try {
      const bytes = await file.arrayBuffer();
      decoded = await context.decodeAudioData(bytes);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const unreadable =
        (typeof DOMException !== 'undefined' &&
          error instanceof DOMException &&
          error.name === 'NotReadableError') ||
        /could not be read|file was acquired/i.test(detail);
      const outOfMemory =
        error instanceof RangeError || /allocation|out of memory|too large/i.test(detail);

      throw new AppError(
        unreadable
          ? `The browser could not read “${file.name}”.`
          : outOfMemory
            ? `“${file.name}” is too large for this browser to hold in memory.`
            : `This browser could not decode “${file.name}”.`,
        {
          code: unreadable
            ? 'FILE_NOT_READABLE'
            : outOfMemory
              ? 'AUDIO_OUT_OF_MEMORY'
              : 'AUDIO_DECODE_FAILED',
          cause: error,
          hint: unreadable
            ? 'The file may have been moved, renamed, or deleted after you selected it. Pick it again.'
            : outOfMemory
              ? 'There is no fixed duration limit, but the whole recording must fit in memory. Try a shorter file, close other tabs, or use a device with more RAM.'
              : 'OGG and M4A support varies by browser. Try Chrome or Firefox, or convert the file to WAV or MP3.',
        },
      );
    }

    if (!decoded.length || decoded.duration <= 0) {
      throw new AppError('That audio file is empty or has no playable samples.', {
        code: 'EMPTY_AUDIO',
      });
    }

    const originalSampleRate = decoded.sampleRate;
    const originalChannels = decoded.numberOfChannels;
    let samples: Float32Array;

    if (originalSampleRate === TARGET_SAMPLE_RATE && originalChannels === 1) {
      samples = decoded.getChannelData(0).slice();
    } else {
      try {
        const length = Math.max(1, Math.ceil(decoded.duration * TARGET_SAMPLE_RATE));
        const offline = new OfflineAudioContext(1, length, TARGET_SAMPLE_RATE);
        const source = offline.createBufferSource();
        source.buffer = decoded;
        source.connect(offline.destination);
        source.start(0);
        const rendered = await offline.startRendering();
        samples = rendered.getChannelData(0).slice();
      } catch (error) {
        throw new AppError('Could not resample that audio to 16 kHz mono.', {
          code: 'RESAMPLE_FAILED',
          cause: error,
          hint: 'Try a shorter file, or a recent desktop version of Chrome, Edge, Firefox, or Safari.',
        });
      }
    }

    if (!samples.length) {
      throw new AppError('No audio samples were produced from that file.', {
        code: 'EMPTY_AUDIO',
      });
    }

    return {
      samples,
      duration: samples.length / TARGET_SAMPLE_RATE,
      originalSampleRate,
      originalChannels,
    };
  } finally {
    // Some browsers reject close() if the context is already closed; that is
    // harmless and should never mask the real decoding result.
    void context.close().catch(() => undefined);
  }
}

/**
 * Split long recordings at the quietest point near a target length.
 *
 * TDT/FastConformer encoders are happy with a single utterance, but a 30-minute
 * file would create a very large attention problem and a giant GPU allocation.
 * Cutting in a short low-energy window avoids slicing through a word.
 */
export function splitAtSilence(
  samples: Float32Array,
  sampleRate = TARGET_SAMPLE_RATE,
  targetSeconds = 30,
  searchSeconds = 2.5,
): AudioChunk[] {
  if (!samples.length) return [];

  const target = Math.max(5, targetSeconds) * sampleRate;
  const search = Math.max(0.5, searchSeconds) * sampleRate;
  const minChunk = Math.min(10 * sampleRate, target);

  if (samples.length <= target + search) {
    return [{ samples, startSample: 0 }];
  }

  // A 10 ms energy envelope is enough to find a quiet cut point. Keeping this
  // at frame resolution (rather than one Float64 per sample) saves hundreds of
  // megabytes on a 30-minute recording.
  const frameSize = Math.max(1, Math.round(0.01 * sampleRate));
  const frameCount = Math.ceil(samples.length / frameSize);
  const frameEnergy = new Float64Array(frameCount + 1);

  for (let frame = 0; frame < frameCount; frame += 1) {
    const from = frame * frameSize;
    const to = Math.min(samples.length, from + frameSize);
    let energy = 0;

    for (let i = from; i < to; i += 1) {
      const value = Number.isFinite(samples[i]) ? samples[i] : 0;
      energy += value * value;
    }

    frameEnergy[frame + 1] = frameEnergy[frame] + energy;
  }

  const windowFrames = Math.max(1, Math.round((0.1 * sampleRate) / frameSize));
  const stepFrames = Math.max(1, Math.round((0.01 * sampleRate) / frameSize));
  const chunks: AudioChunk[] = [];
  let start = 0;

  while (samples.length - start > target + search) {
    const ideal = start + target;
    const low = Math.max(start + minChunk, ideal - search);
    const high = Math.min(samples.length, ideal + search);
    const lowFrame = Math.max(0, Math.floor(low / frameSize));
    const highFrame = Math.min(frameCount, Math.ceil(high / frameSize));
    const bestFrame = findQuietestPoint(
      frameEnergy,
      lowFrame,
      highFrame,
      windowFrames,
      stepFrames,
    );

    let cut = bestFrame * frameSize + Math.round((windowFrames * frameSize) / 2);
    cut = Math.max(start + minChunk, Math.min(samples.length, cut));

    if (cut <= start) cut = Math.min(samples.length, ideal);

    chunks.push({ samples: samples.subarray(start, cut), startSample: start });
    start = cut;
  }

  if (start < samples.length) {
    chunks.push({ samples: samples.subarray(start), startSample: start });
  }

  return chunks;
}

function findQuietestPoint(
  prefix: Float64Array,
  low: number,
  high: number,
  window: number,
  step: number,
): number {
  const first = Math.max(0, Math.floor(low));
  const last = Math.min(prefix.length - window - 1, Math.floor(high) - window);
  if (last <= first) return Math.round((low + high) / 2);

  let bestPosition = first;
  let bestEnergy = Number.POSITIVE_INFINITY;

  for (let position = first; position <= last; position += step) {
    const energy = prefix[position + window] - prefix[position];
    if (energy < bestEnergy) {
      bestEnergy = energy;
      bestPosition = position;
    }
  }

  return Math.round(bestPosition + window / 2);
}

/**
 * Peak envelope for the little waveform preview. One pass over the samples,
 * downsampled to `buckets` columns.
 */
export function computePeaks(samples: Float32Array, buckets = 480): Float32Array {
  const peaks = new Float32Array(buckets);
  if (!samples.length || buckets <= 0) return peaks;

  const samplesPerBucket = samples.length / buckets;

  for (let bucket = 0; bucket < buckets; bucket += 1) {
    const start = Math.floor(bucket * samplesPerBucket);
    const end = Math.min(samples.length, Math.floor((bucket + 1) * samplesPerBucket));
    let peak = 0;

    for (let i = start; i < end; i += 1) {
      const value = Math.abs(samples[i]);
      if (value > peak) peak = value;
    }

    peaks[bucket] = peak;
  }

  return peaks;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  // Decimal units, matching Hugging Face and the model card (1 MB = 1,000,000 B).
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1000)));
  const value = bytes / 1000 ** exponent;
  const digits = value >= 100 || exponent === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[exponent]}`;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const whole = Math.round(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}
