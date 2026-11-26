/**
 * Microphone capture that produces the same File shape as the upload path.
 *
 * MediaRecorder is used only as a container/encoder; the resulting blob is
 * decoded by the existing Web Audio pipeline, so recording and file upload
 * share every downstream step. Nothing is uploaded.
 */

import { AppError } from './errors';

export interface RecorderUpdate {
  elapsed: number;
  /** 0..1 RMS level for the meter. */
  level: number;
}

type RecorderListener = (update: RecorderUpdate) => void;

const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
];

function extensionFor(mime: string): string {
  if (mime.includes('mp4')) return 'm4a';
  if (mime.includes('ogg')) return 'ogg';
  return 'webm';
}

function timestampName(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(
    date.getHours(),
  )}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export class MicrophoneRecorder {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: BlobPart[] = [];
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private samples: Float32Array | null = null;
  private animation = 0;
  private startedAt = 0;
  private listener: RecorderListener | null = null;
  private mimeType = '';
  private cancelled = false;
  private stopping: Promise<File> | null = null;

  get active(): boolean {
    return this.recorder?.state === 'recording';
  }

  async start(listener: RecorderListener, mode: 'speech' | 'music' = 'speech'): Promise<void> {
    if (this.active) return;

    if (!navigator.mediaDevices?.getUserMedia) {
      throw new AppError('This browser cannot record from a microphone.', {
        code: 'NO_MICROPHONE_API',
        hint: 'Use a recent Chrome, Edge, Firefox, or Safari over HTTPS (or localhost).',
      });
    }

    if (typeof MediaRecorder === 'undefined') {
      throw new AppError('This browser cannot encode a recording.', {
        code: 'NO_MEDIA_RECORDER',
        hint: 'Upload an audio file instead, or open the page in a recent Chrome, Edge, or Firefox.',
      });
    }

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: mode === 'speech' ? 1 : { ideal: 2 },
          echoCancellation: mode === 'speech',
          noiseSuppression: mode === 'speech',
          autoGainControl: mode === 'speech',
        },
      });
    } catch (error) {
      const name = error instanceof DOMException ? error.name : '';
      const denied = name === 'NotAllowedError' || name === 'SecurityError';
      throw new AppError(
        denied
          ? 'Microphone permission was denied.'
          : 'No microphone could be opened.',
        {
          code: 'MICROPHONE_FAILED',
          cause: error,
          hint: denied
            ? 'Allow microphone access in the address-bar permission menu, then try again.'
            : 'Check that a microphone is connected and not in use by another app.',
        },
      );
    }

    this.mimeType =
      typeof MediaRecorder.isTypeSupported === 'function'
        ? (MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type)) ?? '')
        : '';
    this.chunks = [];
    this.cancelled = false;
    this.stopping = null;
    this.listener = listener;

    try {
      this.recorder = new MediaRecorder(this.stream, {
        ...(this.mimeType ? { mimeType: this.mimeType } : {}),
        audioBitsPerSecond: mode === 'speech' ? 128_000 : 256_000,
      });
    } catch (error) {
      this.releaseStream();
      throw new AppError('The recording encoder could not be started.', {
        code: 'RECORDER_FAILED',
        cause: error,
        hint: 'Upload an audio file instead, or try a different browser.',
      });
    }

    this.recorder.addEventListener('dataavailable', (event) => {
      if (event.data.size > 0) this.chunks.push(event.data);
    });

    this.startedAt = performance.now();
    this.setupMeter();

    try {
      this.recorder.start(1000);
      this.tick();
    } catch (error) {
      this.releaseStream();
      this.recorder = null;
      throw new AppError('The recording encoder could not be started.', {
        code: 'RECORDER_FAILED',
        cause: error,
        hint: 'Upload an audio file instead, or try a different browser.',
      });
    }
  }

  private setupMeter(): void {
    if (!this.stream) return;

    const AudioCtor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

    if (!AudioCtor) return;

    try {
      this.audioContext = new AudioCtor();
      const source = this.audioContext.createMediaStreamSource(this.stream);
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.smoothingTimeConstant = 0.7;
      source.connect(this.analyser);
      this.samples = new Float32Array(this.analyser.fftSize);
    } catch {
      this.analyser = null;
    }
  }

  private tick = (): void => {
    if (!this.recorder || this.cancelled) return;

    const elapsed = (performance.now() - this.startedAt) / 1000;
    let level = 0;

    if (this.analyser && this.samples) {
      this.analyser.getFloatTimeDomainData(this.samples as Float32Array<ArrayBuffer>);
      let sum = 0;
      for (const sample of this.samples) sum += sample * sample;
      level = Math.min(1, Math.sqrt(sum / this.samples.length) * 4.5);
    }

    this.listener?.({ elapsed, level });
    this.animation = requestAnimationFrame(this.tick);
  };

  async stop(): Promise<File> {
    if (this.stopping) return this.stopping;

    this.stopping = new Promise<File>((resolve, reject) => {
      const recorder = this.recorder;
      if (!recorder) {
        reject(new AppError('No recording is in progress.', { code: 'NOT_RECORDING' }));
        return;
      }

      const finish = () => {
        if (this.animation) cancelAnimationFrame(this.animation);
        this.animation = 0;
        this.releaseStream();

        if (this.cancelled) {
          this.chunks = [];
          reject(new AppError('Recording cancelled.', { code: 'RECORDING_CANCELLED' }));
          return;
        }

        const mime = this.mimeType || recorder.mimeType || 'audio/webm';
        const blob = new Blob(this.chunks, { type: mime });
        this.chunks = [];

        if (!blob.size) {
          reject(
            new AppError('The recording was empty.', {
              code: 'EMPTY_RECORDING',
              hint: 'Check the selected microphone and try again.',
            }),
          );
          return;
        }

        const extension = extensionFor(mime);
        resolve(
          new File([blob], `recording-${timestampName()}.${extension}`, {
            type: mime,
            lastModified: Date.now(),
          }),
        );
      };

      if (recorder.state === 'inactive') {
        finish();
        return;
      }

      recorder.addEventListener('stop', finish, { once: true });
      try {
        recorder.stop();
      } catch (error) {
        finish();
        reject(error);
      }
    });

    return this.stopping;
  }

  cancel(): void {
    this.cancelled = true;
    this.chunks = [];
    if (this.animation) cancelAnimationFrame(this.animation);
    this.animation = 0;

    if (this.recorder && this.recorder.state !== 'inactive') {
      try {
        this.recorder.stop();
      } catch {
        // The stop event may already be queued.
      }
    }

    this.recorder = null;
    this.releaseStream();
  }

  private releaseStream(): void {
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }

    if (this.audioContext) {
      void this.audioContext.close().catch(() => undefined);
      this.audioContext = null;
    }

    this.analyser = null;
    this.samples = null;
  }
}
