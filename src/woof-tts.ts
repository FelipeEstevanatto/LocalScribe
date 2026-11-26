/**
 * Client for the Underdog Woof worker.
 *
 * Woof (ConwayResearch/Underdog-Woof) is a 40.6 MB, two-voice English TTS
 * model that ships NumPy weights and a Python reference instead of ONNX. The
 * worker in `woof-worker.ts` runs a typed-array TypeScript port of that
 * reference. Weights are cached in the Cache API after the first load.
 *
 * License: Underdog Non-Commercial License 1.0 (weights and port). Credit:
 * "Voice by Underdog Woof". Commercial use requires a license from Underdog.
 */

import { ttsResultFromSamples, type TtsResult } from './tts';
import { VOICES } from './woof';
import WoofWorker from './woof-worker?worker';

export interface WoofProgress {
  phase: 'download' | 'prepare' | 'synthesize';
  loaded: number;
  total: number;
  cached?: boolean;
  piece?: number;
  pieces?: number;
}

export type WoofWorkerRequest =
  | { id: number; type: 'load' }
  | { id: number; type: 'synthesize'; text: string; voice: string; seed: number };

export type WoofWorkerResponse =
  | ({
      id: number;
      type: 'progress';
    } & WoofProgress)
  | { id: number; type: 'loaded' }
  | { id: number; type: 'result'; samples: Float32Array; sampleRate: number }
  | { id: number; type: 'error'; message: string };

interface Pending {
  resolve: (message: WoofWorkerResponse) => void;
  reject: (error: unknown) => void;
  onMessage?: (message: WoofWorkerResponse) => void;
  cleanups: Array<() => void>;
}

function abortError(): DOMException {
  return new DOMException('The operation was cancelled.', 'AbortError');
}

type WoofWorkerPayload =
  | { type: 'load' }
  | { type: 'synthesize'; text: string; voice: string; seed: number };

export class WoofTtsEngine {
  private worker: Worker | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;

  private spawn(): Worker {
    if (this.worker) return this.worker;
    const worker = new WoofWorker({ name: 'woof-tts' });

    worker.onmessage = (event: MessageEvent<WoofWorkerResponse>) => {
      const message = event.data;
      const pending = this.pending.get(message.id);
      if (!pending) return;

      if (message.type === 'progress') {
        pending.onMessage?.(message);
        return;
      }

      this.finish(message.id);
      if (message.type === 'error') pending.reject(new Error(message.message));
      else pending.resolve(message);
    };

    worker.onerror = (event) => {
      const error = new Error(event.message || 'The Woof worker crashed.');
      for (const [id] of this.pending) {
        const pending = this.pending.get(id);
        this.finish(id);
        pending?.reject(error);
      }
      this.worker = null;
    };

    this.worker = worker;
    return worker;
  }

  private finish(id: number): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    for (const cleanup of pending.cleanups) cleanup();
  }

  private request(
    payload: WoofWorkerPayload,
    options: {
      signal?: AbortSignal;
      onMessage?: (message: WoofWorkerResponse) => void;
    } = {},
  ): Promise<WoofWorkerResponse> {
    const id = this.nextId++;
    const worker = this.spawn();

    return new Promise<WoofWorkerResponse>((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(abortError());
        return;
      }

      const onAbort = () => {
        // The CPU engine is synchronous, so the only way to interrupt it is to
        // stop the worker. The next request starts a fresh worker.
        this.worker?.terminate();
        this.worker = null;
        for (const [pendingId] of this.pending) {
          const pending = this.pending.get(pendingId);
          this.finish(pendingId);
          pending?.reject(abortError());
        }
        reject(abortError());
      };

      options.signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, {
        resolve,
        reject,
        onMessage: options.onMessage,
        cleanups: [
          () => options.signal?.removeEventListener('abort', onAbort),
        ],
      });

      worker.postMessage({ ...payload, id } as WoofWorkerRequest);
    });
  }

  async load(
    onProgress?: (progress: WoofProgress) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.request(
      { type: 'load' },
      {
        signal,
        onMessage: (message) => {
          if (message.type === 'progress') onProgress?.(message);
        },
      },
    );
  }

  async speak(
    text: string,
    voice: string,
    onProgress?: (progress: WoofProgress) => void,
    signal?: AbortSignal,
  ): Promise<TtsResult> {
    const message = await this.request(
      { type: 'synthesize', text, voice, seed: 0 },
      {
        signal,
        onMessage: (progress) => {
          if (progress.type === 'progress') onProgress?.(progress);
        },
      },
    );

    if (message.type !== 'result') {
      throw new Error('Woof returned an unexpected response.');
    }

    return ttsResultFromSamples(message.samples, message.sampleRate);
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    for (const [id] of this.pending) {
      const pending = this.pending.get(id);
      this.finish(id);
      pending?.reject(abortError());
    }
  }
}

export const WOOF_VOICES = VOICES.map((voice) => ({
  id: voice.id,
  label: `${voice.name} · English · Underdog Woof`,
}));

export const WOOF_LICENSE =
  'Underdog Non-Commercial License 1.0 · voice by Underdog Woof';
