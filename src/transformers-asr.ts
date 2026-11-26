/**
 * CPU speech recognition via Transformers.js.
 *
 * Moonshine is a small English ASR family designed for short audio and live
 * transcription. The q8 ONNX exports are roughly 32 MB (tiny) and 66 MB
 * (base), so they are much closer to a WhatsApp-style on-device language pack
 * than Whisper or Parakeet.
 */

// Transformers.js pins its own ORT build. Serve the matching CPU/WASM assets
// from this origin.
import ortFactoryUrl from '../node_modules/@huggingface/transformers/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs?url';
import ortWasmUrl from '../node_modules/@huggingface/transformers/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm?url';

export interface SpeechProgressEvent {
  status?: string;
  name?: string;
  file?: string;
  loaded?: number;
  total?: number;
  progress?: number;
}

export interface SpeechLoadOptions {
  repo: string;
  revision: string;
  dtype: 'fp32' | 'q8' | { encoder_model: 'fp32'; decoder_model_merged: 'q8' };
  timestamps?: 'segment' | 'word';
  language?: string;
  memoryOnly?: boolean;
  onProgress?: (event: SpeechProgressEvent) => void;
}

export interface SpeechResult {
  text: string;
  tokenCount: number;
  frames: number;
  words?: WordTiming[];
}

export interface WordTiming {
  text: string;
  start: number;
  end: number | null;
}

type Recognized = { text?: string; chunks?: Array<{ text: string; timestamp: [number, number | null] }> };

type Transcriber = {
  (
    audio: Float32Array,
    options?: Record<string, unknown>,
  ): Promise<Recognized | Recognized[]>;
  dispose?: () => Promise<void> | void;
};

export class TransformersAsrEngine {
  readonly device = 'wasm' as const;

  private transcriber: Transcriber | null = null;
  private readonly options: SpeechLoadOptions;

  constructor(options: SpeechLoadOptions) {
    this.options = options;
  }

  get isLoaded(): boolean {
    return Boolean(this.transcriber);
  }

  async load(): Promise<void> {
    if (this.transcriber) return;

    const transformers = await import('@huggingface/transformers');
    const env = transformers.env as typeof transformers.env & {
      backends?: {
        onnx?: {
          wasm?: {
            numThreads?: number;
            wasmPaths?: { wasm: string; mjs: string } | string;
          };
        };
      };
    };

    env.allowLocalModels = false;
    env.useBrowserCache = !this.options.memoryOnly;
    env.useWasmCache = !this.options.memoryOnly;
    env.cacheKey = 'transformers-cache';

    const wasm = env.backends?.onnx?.wasm;
    if (wasm) {
      const isolated =
        typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;
      const cores =
        typeof navigator !== 'undefined' && navigator.hardwareConcurrency > 0
          ? navigator.hardwareConcurrency
          : 1;
      wasm.numThreads = isolated ? Math.max(1, Math.min(8, cores)) : 1;
      wasm.wasmPaths = { wasm: ortWasmUrl, mjs: ortFactoryUrl };
    }

    try {
      this.transcriber = (await transformers.pipeline(
        'automatic-speech-recognition',
        this.options.repo,
        {
          revision: this.options.revision,
          dtype: this.options.dtype,
          device: 'wasm',
          progress_callback: (event: SpeechProgressEvent) => {
            this.options.onProgress?.(event);
          },
        },
      )) as unknown as Transcriber;
    } catch (error) {
      throw new Error(
        `The speech model failed to load: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async transcribe(samples: Float32Array): Promise<SpeechResult> {
    const transcriber = this.transcriber;
    if (!transcriber) throw new Error('The speech model is not loaded yet.');

    const mode = this.options.timestamps;
    const output = await transcriber(samples, mode === 'segment' ? {
      do_sample: false,
      chunk_length_s: 30,
      stride_length_s: 5,
      return_timestamps: true,
      force_full_sequences: false,
    } : {
      max_new_tokens: 256,
      ...(mode === 'word' ? { return_timestamps: 'word', task: 'transcribe', language: this.options.language } : {}),
    });
    const entry = Array.isArray(output) ? output[0] : output;
    const text = String(entry?.text ?? '').trim();

    return {
      text,
      tokenCount: 0,
      frames: Math.max(1, Math.floor((samples.length / 16_000) * 100)),
      words: mode === 'word'
        ? entry?.chunks?.map(({ text: word, timestamp: [start, end] }) => ({ text: word, start, end }))
        : undefined,
    };
  }

  async dispose(): Promise<void> {
    const transcriber = this.transcriber;
    this.transcriber = null;
    try {
      await transcriber?.dispose?.();
    } catch {
      // Best effort.
    }
  }
}
