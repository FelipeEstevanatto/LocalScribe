import { WhisperFeatureExtractor } from '@huggingface/transformers';
import type { InferenceSession, Tensor } from 'onnxruntime-web';
import type { TranscribeOptions, TranscriptionResult } from './model';
import type { OrtModule } from './ort-runtime';
import { cleanQwenTranscript, qwenPrompt, type QwenTokenizer } from './qwen';

// The pinned export uses a growing cache in [batch, heads, sequence, headDim]
// order. Keeping the present tensors on the device avoids a readback per step.
const CACHE_SLOTS = Array.from({ length: 28 }, (_, layer) =>
  [`${layer}.key`, `${layer}.value`],
).flat();
const EMPTY_CACHE_SHAPE = [1, 8, 0, 128];
const END_OF_TEXT = 151643;

export function qwenWebGpuOutputLocations(): Record<string, 'cpu' | 'gpu-buffer'> {
  return Object.fromEntries([
    ['logits', 'cpu'],
    ...CACHE_SLOTS.map((slot) => [`present.${slot}`, 'gpu-buffer'] as const),
  ]);
}

export class QwenWebGpu {
  private readonly extractor: WhisperFeatureExtractor;
  private readonly prompt: ReturnType<typeof qwenPrompt>;

  constructor(
    private readonly ort: OrtModule,
    private readonly encoder: InferenceSession,
    private readonly embedding: InferenceSession,
    private readonly decoder: InferenceSession,
    private readonly tokenizer: QwenTokenizer,
    config: ConstructorParameters<typeof WhisperFeatureExtractor>[0],
    language: string,
  ) {
    this.extractor = new WhisperFeatureExtractor(config);
    this.prompt = qwenPrompt(tokenizer, language);
  }

  async transcribe(samples: Float32Array, options: TranscribeOptions): Promise<TranscriptionResult> {
    options.signal?.throwIfAborted();
    if (!samples.length) return { text: '', tokenCount: 0, frames: 0 };
    // Whisper reflects a 200-sample pad around the waveform.
    const audio = samples.length > 200 ? samples : new Float32Array(400);
    if (audio !== samples) audio.set(samples);
    const { input_features: features } = await this.extractor(audio, { max_length: audio.length });
    options.signal?.throwIfAborted();
    const input = new this.ort.Tensor('float32', features.data as Float32Array, features.dims);
    const { audio_features: encoded } = await this.encoder.run({ input_features: input })
      .finally(() => input.dispose());
    let promptEmbeddings: Tensor | undefined;
    let audioTokens: number;
    try {
      options.signal?.throwIfAborted();
      audioTokens = encoded.dims[0];
      const { before, after } = this.prompt;
      promptEmbeddings = await this.embed([
        ...before, ...Array<number>(audioTokens).fill(this.tokenizer.audioPadId), ...after,
      ]);
      (promptEmbeddings.data as Float32Array).set(encoded.data as Float32Array, before.length * encoded.dims[1]);
    } catch (error) {
      promptEmbeddings?.dispose();
      throw error;
    } finally {
      encoded.dispose();
    }

    const maxTokens = Math.min(512, Math.ceil(24 + (samples.length / 16_000) * 10));
    const tokens = await this.decode(promptEmbeddings, maxTokens, options);
    const text = cleanQwenTranscript(this.tokenizer.decode(tokens));
    options.onProgress?.({ framesDone: maxTokens, framesTotal: maxTokens });
    options.onPartial?.(text);
    return { text, tokenCount: tokens.length, frames: audioTokens };
  }

  private async embed(ids: number[]): Promise<Tensor> {
    const input = new this.ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]);
    const { inputs_embeds } = await this.embedding.run({ input_ids: input })
      .finally(() => input.dispose());
    return inputs_embeds;
  }

  private async decode(
    initialEmbeddings: Tensor,
    maxTokens: number,
    options: TranscribeOptions,
  ): Promise<number[]> {
    const Tensor = this.ort.Tensor;
    let embeddings: Tensor | undefined = initialEmbeddings;
    let cache: Record<string, Tensor> = Object.fromEntries(CACHE_SLOTS.map((slot) => [
      `past_key_values.${slot}`,
      new Tensor('float32', new Float32Array(0), EMPTY_CACHE_SHAPE),
    ]));
    let length = initialEmbeddings.dims[1];
    let position = 0;
    let lastPartialTime = 0;
    const tokens: number[] = [];
    try {
      while (embeddings && tokens.length < maxTokens) {
        options.signal?.throwIfAborted();
        const positions = BigInt64Array.from({ length: length - position }, (_, i) => BigInt(position + i));
        const feeds = {
          inputs_embeds: embeddings,
          attention_mask: new Tensor('int64', new BigInt64Array(length).fill(1n), [1, length]),
          position_ids: new Tensor('int64', positions, [1, positions.length]),
          num_logits_to_keep: new Tensor('int64', BigInt64Array.of(1n), []),
          ...cache,
        };
        embeddings = undefined;
        cache = {};
        const outputs = await this.decoder.run(feeds).finally(() => {
          Object.values(feeds).forEach((tensor) => tensor.dispose());
        });
        for (const slot of CACHE_SLOTS) {
          cache[`past_key_values.${slot}`] = outputs[`present.${slot}`];
        }
        const logits = outputs.logits;
        let token = 0;
        try {
          const values = logits.data as Float32Array;
          for (let index = 1; index < values.length; index += 1) {
            if (values[index] > values[token]) token = index;
          }
        } finally {
          logits.dispose();
        }
        options.signal?.throwIfAborted();
        if (token === this.tokenizer.eosId || token === END_OF_TEXT) break;
        tokens.push(token);
        const now = performance.now();
        if (now - lastPartialTime >= 80) {
          lastPartialTime = now;
          options.onProgress?.({ framesDone: tokens.length, framesTotal: maxTokens });
          options.onPartial?.(cleanQwenTranscript(this.tokenizer.decode(tokens)));
        }
        if (tokens.length === maxTokens) break;
        embeddings = await this.embed([token]);
        position = length;
        length += 1;
      }
      return tokens;
    } finally {
      embeddings?.dispose();
      Object.values(cache).forEach((tensor) => tensor.dispose());
    }
  }
}
