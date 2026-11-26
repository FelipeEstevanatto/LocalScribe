import { abortError, AppError } from './errors';
import type {
  Backend,
  EngineOptions,
  LoadProgress,
  TranscribeOptions,
  TranscribeProgress,
  TranscriptionResult,
} from './model';

type WorkerOptions = Omit<EngineOptions, 'onProgress' | 'onWarning'>;

export type AsrRequest =
  | { type: 'load'; options: WorkerOptions }
  | { type: 'transcribe'; id: number; samples: Float32Array }
  | { type: 'cancel'; id: number };

export type AsrResponse =
  | { type: 'loadProgress'; progress: LoadProgress }
  | { type: 'warning'; message: string }
  | { type: 'loaded'; backend: Backend | null }
  | { type: 'transcribeProgress'; id: number; progress: TranscribeProgress }
  | { type: 'partial'; id: number; text: string }
  | { type: 'result'; id: number; result: TranscriptionResult }
  | { type: 'error'; id?: number; message: string; code?: string; hint?: string };

/** One worker owns one model session and runs one request at a time. */
export class AsrClient {
  backend: Backend | null = null;
  private worker: Worker | null = null;
  private cancelPending: (() => void) | undefined;
  private nextRequest = 1;

  constructor(private readonly options: EngineOptions) {}

  get modelId() { return this.options.modelId; }
  get variantId() { return this.options.variantId; }
  get clean() { return this.options.clean; }
  get language() { return this.options.language; }

  async load(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw abortError();
    if (this.backend) return;
    const { onProgress, onWarning, ...options } = this.options;
    await this.request<void>({ type: 'load', options }, signal, (message, complete) => {
      if (message.type === 'loadProgress') onProgress?.(message.progress);
      if (message.type === 'warning') onWarning?.(message.message);
      if (message.type === 'loaded') {
        this.backend = message.backend;
        complete();
      }
    });
  }

  async transcribe(samples: Float32Array, options: TranscribeOptions = {}): Promise<TranscriptionResult> {
    if (options.signal?.aborted) throw abortError();
    if (!this.backend) throw new AppError('Load a speech model before transcribing.');
    // The source may be a view into the audio used for playback and retry.
    const owned = new Float32Array(samples);
    const id = this.nextRequest++;
    return this.request<TranscriptionResult>(
      { type: 'transcribe', id, samples: owned }, options.signal,
      (message, complete) => {
        if (message.type === 'transcribeProgress') options.onProgress?.(message.progress);
        if (message.type === 'partial') options.onPartial?.(message.text);
        if (message.type === 'result') complete(message.result);
      },
      [owned.buffer],
      id,
    );
  }

  async dispose(): Promise<void> {
    this.cancelPending?.();
    this.terminate();
  }

  private terminate(): void {
    this.worker?.terminate();
    this.worker = null;
    this.backend = null;
  }

  private request<T>(
    request: AsrRequest,
    signal: AbortSignal | undefined,
    receive: (message: AsrResponse, complete: (result: T) => void) => void,
    transfer: Transferable[] = [],
    id?: number,
  ): Promise<T> {
    if (this.cancelPending) return Promise.reject(new AppError('The speech model is already busy.'));
    const worker = this.worker ??= new Worker(new URL('./asr-worker.ts', import.meta.url), { type: 'module' });

    return new Promise<T>((resolve, reject) => {
      const cleanup = () => {
        worker.onmessage = null;
        worker.onerror = null;
        worker.onmessageerror = null;
        signal?.removeEventListener('abort', cancel);
        this.cancelPending = undefined;
      };
      const fail = (error: unknown) => {
        cleanup();
        this.terminate();
        reject(error);
      };
      const cancel = () => {
        cleanup();
        // Keep the loaded model alive. The worker aborts its own controller
        // and serializes the next request behind the cancelled one.
        if (id !== undefined) worker.postMessage({ type: 'cancel', id });
        reject(abortError());
      };
      this.cancelPending = cancel;
      signal?.addEventListener('abort', cancel, { once: true });
      worker.onmessage = ({ data }: MessageEvent<AsrResponse>) => {
        if (id !== undefined && 'id' in data && data.id !== undefined && data.id !== id) return;
        if (data.type === 'error') {
          fail(new AppError(data.message, { code: data.code, hint: data.hint }));
          return;
        }
        try {
          receive(data, (result) => {
            cleanup();
            resolve(result);
          });
        } catch (error) {
          fail(error);
        }
      };
      worker.onerror = (event) => fail(new AppError('The speech worker stopped unexpectedly.', {
        code: 'ASR_WORKER_FAILED',
        hint: 'Retry the transcription, or select a smaller model or the CPU backend.',
        cause: event.message,
      }));
      worker.onmessageerror = () => fail(new AppError('The speech worker returned an unreadable response.'));
      try {
        worker.postMessage(request, transfer);
      } catch (error) {
        fail(error);
      }
    });
  }
}
