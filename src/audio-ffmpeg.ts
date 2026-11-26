import { abortError, AppError, isAbortError } from './errors';

// The vendored libopus traps in WASM. FFmpeg's native encoder works for
// mono and stereo and offers the same Opus containers.
const opusArgs = ['-c:a', 'opus', '-strict', 'experimental', '-ar', '48000', '-b:a', '96k'];

export const AUDIO_FORMATS = {
  mp3: { label: 'MP3', mime: 'audio/mpeg', args: ['-c:a', 'libmp3lame', '-q:a', '2'] },
  wav: { label: 'WAV · PCM', mime: 'audio/wav', args: ['-c:a', 'pcm_s16le'] },
  flac: { label: 'FLAC · lossless', mime: 'audio/flac', args: ['-c:a', 'flac'] },
  m4a: { label: 'M4A · AAC', mime: 'audio/mp4', args: ['-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart'] },
  aac: { label: 'AAC · ADTS', mime: 'audio/aac', args: ['-c:a', 'aac', '-b:a', '192k'] },
  ogg: { label: 'OGG · Vorbis', mime: 'audio/ogg', args: ['-c:a', 'libvorbis', '-q:a', '5'] },
  opus: { label: 'Opus · Ogg', mime: 'audio/ogg', args: opusArgs },
  webm: { label: 'WebM · Opus', mime: 'audio/webm', args: opusArgs },
  aiff: { label: 'AIFF · PCM', mime: 'audio/aiff', args: ['-c:a', 'pcm_s16be'] },
  caf: { label: 'CAF · PCM', mime: 'audio/x-caf', args: ['-c:a', 'pcm_s16le'] },
} as const;

export type AudioFormat = keyof typeof AUDIO_FORMATS;

export function audioInputName(index: number): string {
  return index ? `input-${index}.media` : 'input.media';
}

export interface FfmpegProgress {
  /** 0–1 when the output length is known, otherwise null. */
  ratio: number | null;
  /** Seconds of output written so far. */
  time: number;
}

export interface FfmpegLoadProgress {
  loaded: number;
  total: number;
}

export interface RunOptions {
  signal?: AbortSignal;
  /** Expected output duration in seconds, used for an accurate percentage. */
  duration?: number;
  onProgress?: (progress: FfmpegProgress) => void;
  /** Extra text files (e.g. concat lists) written next to the inputs. */
  texts?: { name: string; content: string }[];
}

export interface MediaProbe {
  duration: number;
  hasVideo: boolean;
  hasAudio: boolean;
  videoCodec: string | null;
  audioCodec: string | null;
  width: number;
  height: number;
  fps: number;
  rotation?: number;
  /** Every audio stream, in file order (stream choice uses this index). */
  audioStreams?: AudioStreamInfo[];
  subtitleStreams?: SubtitleStreamInfo[];
}

export interface AudioStreamInfo {
  codec: string;
  language: string | null;
  channels: string;
  title: string | null;
  sampleRate?: number | null;
}

export interface SubtitleStreamInfo {
  index: number;
  codec: string;
  language: string | null;
  title: string | null;
  default: boolean;
  forced: boolean;
}

type WorkerReply =
  | { type: 'load'; loaded: number; total: number }
  | { type: 'ready'; threads: boolean }
  | { id: number; type: 'progress'; ratio: number | null; time: number }
  | { id: number; type: 'done'; bytes: Uint8Array<ArrayBuffer> }
  | { id: number; type: 'log'; log: string }
  | { id: number; type: 'error'; error: string };

type PendingCommand = {
  resolve: (value: Uint8Array<ArrayBuffer> | string) => void;
  reject: (error: Error) => void;
  onProgress?: (progress: FfmpegProgress) => void;
  onActivity?: () => void;
};

const STALL_MS = 30_000;

/** Parse `ffmpeg -i` output into the fields the editors need. */
export function parseProbe(log: string): MediaProbe {
  const duration = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(log);
  const video = /Stream #\d+:\d+[^:]*: Video: ([\w-]+)[^\n]*?(\d{2,5})x(\d{2,5})/.exec(log);
  const fps = /(\d+(?:\.\d+)?) fps/.exec(log);
  const audio = /Stream #\d+:\d+[^:]*: Audio: ([\w-]+)/.exec(log);
  const rotation = /rotation of\s*(-?\d+(?:\.\d+)?)\s+degrees/i.exec(log);
  const audioStreams: AudioStreamInfo[] = [];
  const subtitleStreams: SubtitleStreamInfo[] = [];
  const lines = log.split(/\r?\n/);
  lines.forEach((line, i) => {
    const match = /Stream #\d+:\d+(?:\[[^\]]*\])?(?:\(([^)]+)\))?: (Audio|Subtitle): ([\w-]+)/.exec(line);
    if (!match) return;
    let title: string | null = null;
    for (let j = i + 1; j < Math.min(lines.length, i + 6) && !/Stream #/.test(lines[j]); j += 1) {
      const meta = /^\s+(?:title|handler_name)\s*:\s*(.+)$/.exec(lines[j]);
      if (meta && !/SoundHandler|Core Media Audio/i.test(meta[1])) title = meta[1].trim();
    }
    const language = match[1] && match[1] !== 'und' ? match[1] : null;
    if (match[2] === 'Subtitle') {
      subtitleStreams.push({
        index: subtitleStreams.length, codec: match[3], language, title,
        default: line.includes('(default)'), forced: line.includes('(forced)'),
      });
      return;
    }
    const channels = /Audio: [\w-]+[^,]*(?:,[^,]*Hz)?,\s*([^,]+)/.exec(line)?.[1] ?? '';
    const rate = /(\d+(?:\.\d+)?)\s*Hz/.exec(line);
    audioStreams.push({
      language,
      codec: match[3],
      channels: channels.trim(),
      title,
      sampleRate: rate ? Math.round(Number(rate[1])) : null,
    });
  });
  return {
    duration: duration ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]) : 0,
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    videoCodec: video?.[1] ?? null,
    audioCodec: audio?.[1] ?? null,
    width: video ? Number(video[2]) : 0,
    height: video ? Number(video[3]) : 0,
    fps: fps ? Number(fps[1]) : 0,
    ...(rotation ? { rotation: Number(rotation[1]) } : {}),
    audioStreams,
    subtitleStreams,
  };
}

export class AudioFfmpeg {
  private worker: Worker | null = null;
  private nextId = 0;
  private pending = new Map<number, PendingCommand>();
  private loadListeners = new Set<(progress: FfmpegLoadProgress) => void>();
  /** True once the multithreaded core is running. */
  multithreaded = false;

  constructor(options: { singleThread?: boolean } = {}) {
    this.singleThread = options.singleThread ?? false;
  }

  dispose(): void {
    this.stop(abortError());
  }

  /** True once the worker has been created (the core may still be loading). */
  get loaded(): boolean {
    return this.worker !== null;
  }

  /** Subscribe to FFmpeg core download progress (about 32 MB, once). */
  onLoad(listener: (progress: FfmpegLoadProgress) => void): () => void {
    this.loadListeners.add(listener);
    return () => this.loadListeners.delete(listener);
  }

  /** Set after the multithreaded core misbehaves; later workers stay single-threaded. */
  private singleThread = false;

  private getWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('./ffmpeg-worker.js', import.meta.url), {
      type: 'module',
      // The worker reads its name to pick the core; "-st" forces one thread.
      name: this.singleThread ? 'local-ffmpeg-st' : 'local-ffmpeg',
    });
    this.worker = worker;
    worker.onmessage = ({ data }: MessageEvent<WorkerReply>) => {
      if (data.type === 'ready') {
        this.multithreaded = data.threads;
        return;
      }
      if (data.type === 'load') {
        for (const listener of this.loadListeners) listener({ loaded: data.loaded, total: data.total });
        // Downloading the core is activity, not a stall.
        for (const command of this.pending.values()) command.onActivity?.();
        return;
      }
      const command = this.pending.get(data.id);
      if (!command) return;
      if (data.type === 'progress') {
        command.onProgress?.({ ratio: data.ratio, time: data.time });
        return;
      }
      this.pending.delete(data.id);
      if (data.type === 'done') command.resolve(data.bytes);
      else if (data.type === 'log') command.resolve(data.log);
      else command.reject(new Error(data.error || 'FFmpeg returned no output.'));
    };
    worker.onerror = (event) => {
      event.preventDefault();
      this.stop(new Error(event.message || 'The local FFmpeg worker could not load. Reload the app and try again.'));
    };
    worker.onmessageerror = () => this.stop(new Error('The FFmpeg response could not be read.'));
    return worker;
  }

  private stop(error: Error): void {
    this.worker?.terminate();
    this.worker = null;
    for (const command of this.pending.values()) command.reject(error);
    this.pending.clear();
  }

  private async send<T extends Uint8Array<ArrayBuffer> | string>(
    message: Record<string, unknown>,
    signal?: AbortSignal,
    onProgress?: (progress: FfmpegProgress) => void,
  ): Promise<T> {
    try {
      return await this.sendOnce<T>(message, signal, onProgress);
    } catch (error) {
      // The multithreaded core can deadlock or crash on unusual command
      // combinations. Retry once on the single-threaded core.
      if (signal?.aborted || this.singleThread || !this.multithreaded || !(error instanceof Error)) throw error;
      if (!/stalled|memory access out of bounds|RuntimeError|unreachable|Aborted\(|could not load/i.test(error.message)) throw error;
      console.warn('Multithreaded FFmpeg failed; retrying single-threaded.', error);
      this.singleThread = true;
      this.multithreaded = false;
      this.stop(new Error('Restarting FFmpeg single-threaded.'));
      return this.sendOnce<T>(message, signal, onProgress);
    }
  }

  private sendOnce<T extends Uint8Array<ArrayBuffer> | string>(
    message: Record<string, unknown>,
    signal?: AbortSignal,
    onProgress?: (progress: FfmpegProgress) => void,
  ): Promise<T> {
    signal?.throwIfAborted();
    const worker = this.getWorker();
    const id = ++this.nextId;
    // Terminating is the only way to interrupt a running FFmpeg command.
    const cancel = () => this.stop(abortError());
    signal?.addEventListener('abort', cancel, { once: true });
    // A healthy job reports progress about twice a second; long silence on
    // the multithreaded core means a deadlock.
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(watchdog);
      if (this.singleThread) return;
      watchdog = setTimeout(() => {
        // Only the multithreaded core deadlocks; a single-threaded one is
        // just slow, so keep waiting.
        if (this.multithreaded) this.fail(id, new Error('FFmpeg stalled.'));
        else arm();
      }, STALL_MS);
    };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as PendingCommand['resolve'],
        reject,
        onProgress: (progress) => {
          arm();
          onProgress?.(progress);
        },
        onActivity: arm,
      });
      worker.postMessage({ id, ...message });
      arm();
    }).finally(() => {
      clearTimeout(watchdog);
      this.pending.delete(id);
      signal?.removeEventListener('abort', cancel);
    });
  }

  /** Fail one command and restart the worker (a stalled core cannot recover). */
  private fail(id: number, error: Error): void {
    const command = this.pending.get(id);
    this.pending.delete(id);
    const others = [...this.pending.values()];
    this.pending.clear();
    this.worker?.terminate();
    this.worker = null;
    command?.reject(error);
    for (const other of others) other.reject(new Error('FFmpeg stalled.'));
  }

  async run(
    source: Blob | readonly Blob[],
    args: readonly string[],
    output: string,
    mime: string,
    signalOrOptions?: AbortSignal | RunOptions,
  ): Promise<Blob> {
    const options: RunOptions = signalOrOptions instanceof AbortSignal ? { signal: signalOrOptions } : signalOrOptions ?? {};
    const blobs = source instanceof Blob ? [source] : source;
    const inputs = blobs.map((blob, index) => ({ name: audioInputName(index), blob }));
    try {
      const bytes = await this.send<Uint8Array<ArrayBuffer>>(
        { kind: 'run', inputs, texts: options.texts ?? [], args, output, duration: options.duration ?? 0 },
        options.signal,
        options.onProgress,
      );
      return new Blob([bytes], { type: mime });
    } catch (error) {
      if (isAbortError(error)) throw error;
      const detail = error instanceof Error ? error.message : String(error);
      // A selected MP4 can be a valid video with no audio stream. Do not leak
      // FFmpeg's raw "Stream map '0:a:0' matches no streams" message.
      if (/matches no streams|stream map ['"]?0:a:0|0:a:0/i.test(detail)) {
        throw new AppError('This file has no audio track. Choose a file with sound.', {
          code: 'AUDIO_TRACK_MISSING',
          cause: error,
        });
      }
      throw error;
    }
  }

  async probe(source: Blob, signal?: AbortSignal): Promise<MediaProbe> {
    const log = await this.send<string>({ kind: 'probe', inputs: [{ name: audioInputName(0), blob: source }] }, signal);
    return parseProbe(log);
  }

  encode(source: Blob, format: AudioFormat, options: RunOptions = {}): Promise<Blob> {
    const spec = AUDIO_FORMATS[format];
    const output = `output.${format}`;
    return this.run(source, ['-i', 'input.media', '-map', '0:a:0', '-vn', ...spec.args, output], output, spec.mime, options);
  }
}

let shared: AudioFfmpeg | null = null;

/** One FFmpeg worker for the whole app, so the 32 MB core loads once. */
export function sharedFfmpeg(): AudioFfmpeg {
  shared ??= new AudioFfmpeg();
  return shared;
}
