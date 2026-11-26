/**
 * Granite Speech 5.0 2B via Transformers.js.
 *
 * This file is loaded with a dynamic import so the Transformers.js runtime is
 * only shipped when the user selects the Granite model. Model files and the
 * runtime cache are managed by Transformers.js itself (`transformers-cache`).
 */

// Transformers.js pins its own onnxruntime-web build. Import that exact
// runtime's WASM assets so the model executes with a matching ABI and no CDN.
import ortFactoryUrl from '../node_modules/@huggingface/transformers/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs?url';
import ortWasmUrl from '../node_modules/@huggingface/transformers/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm?url';

export interface GraniteProgressEvent {
  status?: string;
  name?: string;
  file?: string;
  loaded?: number;
  total?: number;
  progress?: number;
}

export interface GraniteLoadOptions {
  repo: string;
  revision: string;
  useWebGPU: boolean;
  /** Skip Transformers.js Cache Storage and keep model files in memory. */
  memoryOnly?: boolean;
  onProgress?: (event: GraniteProgressEvent) => void;
  onWarning?: (message: string) => void;
}

export interface GraniteResult {
  text: string;
  tokenCount: number;
  frames: number;
}

type GraniteProcessor = {
  tokenizer: {
    apply_chat_template: (
      messages: Array<{ role: string; content: string }>,
      options: { add_generation_prompt: boolean; tokenize: boolean },
    ) => string;
  };
  (text: string, audio: Float32Array): Promise<Record<string, unknown>>;
  batch_decode: (
    ids: unknown,
    options: { skip_special_tokens: boolean },
  ) => string | string[];
};

type GraniteModel = {
  generate: (inputs: Record<string, unknown>) => Promise<{
    dims: number[];
    slice: (start: unknown, end: unknown) => unknown;
  }>;
  dispose?: () => Promise<void> | void;
};

const PROMPT =
  '<|audio|>transcribe the speech with proper punctuation and capitalization.';

export class GraniteEngine {
  device: 'webgpu' | 'wasm' = 'webgpu';

  private processor: GraniteProcessor | null = null;
  private model: GraniteModel | null = null;
  private readonly options: GraniteLoadOptions;

  constructor(options: GraniteLoadOptions) {
    this.options = options;
  }

  get isLoaded(): boolean {
    return Boolean(this.processor && this.model);
  }

  async load(): Promise<void> {
    if (this.isLoaded) return;

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
      wasm.numThreads = 1;
      // Keep the runtime self-hosted. Transformers.js otherwise defaults to
      // jsDelivr, which would be a third-party runtime CDN.
      wasm.wasmPaths = { wasm: ortWasmUrl, mjs: ortFactoryUrl };
    }

    const progress_callback = (event: GraniteProgressEvent) => {
      this.options.onProgress?.(event);
    };

    let processor;
    try {
      processor = await transformers.AutoProcessor.from_pretrained(
        this.options.repo,
        {
          revision: this.options.revision,
          progress_callback,
        },
      );
    } catch (error) {
      throw new Error(
        `Granite processor failed to load: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    const dtype = {
      audio_encoder: 'q4',
      embed_tokens: 'q4f16',
      decoder_model_merged: 'q4f16',
    } as const;

    let model: GraniteModel;
    this.device = 'webgpu';

    if (!this.options.useWebGPU) {
      throw new Error(
        'Granite Speech requires WebGPU. Its 4-bit embedding has no CPU kernel.',
      );
    }

    try {
      model = (await transformers.GraniteSpeechForConditionalGeneration.from_pretrained(
        this.options.repo,
        {
          revision: this.options.revision,
          dtype,
          device: 'webgpu',
          progress_callback,
        },
      )) as unknown as GraniteModel;
    } catch (error) {
      throw new Error(
        `Granite Speech could not start on WebGPU: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    this.processor = processor as unknown as GraniteProcessor;
    this.model = model;
  }

  async transcribe(samples: Float32Array): Promise<GraniteResult> {
    const processor = this.processor;
    const model = this.model;

    if (!processor || !model) {
      throw new Error('Granite Speech is not loaded yet.');
    }

    const text = processor.tokenizer.apply_chat_template(
      [{ role: 'user', content: PROMPT }],
      { add_generation_prompt: true, tokenize: false },
    );
    const inputs = await processor(text, samples);
    const inputIds = inputs.input_ids as { dims?: number[] } | undefined;
    const promptLength = Number(inputIds?.dims?.at(-1) ?? 0);

    const ids = await model.generate({
      ...inputs,
      max_new_tokens: 256,
    });

    const output =
      promptLength > 0
        ? ids.slice(null, [promptLength, null])
        : ids;

    const decoded = processor.batch_decode(output, {
      skip_special_tokens: true,
    });
    const transcript = Array.isArray(decoded) ? decoded[0] ?? '' : decoded;
    const tokenCount = Math.max(0, Number(ids.dims?.[1] ?? promptLength) - promptLength);

    return {
      text: String(transcript).trim(),
      tokenCount,
      frames: Math.max(1, Math.floor((samples.length / 16_000) * 100)),
    };
  }

  async dispose(): Promise<void> {
    const model = this.model;
    this.model = null;
    this.processor = null;

    try {
      await model?.dispose?.();
    } catch {
      // Best effort.
    }
  }
}
