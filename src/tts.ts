import { sharedMedia } from './media-router';
import type { AudioFormat } from './audio-ffmpeg';
import { fetchWithProgress } from './transfer';
/**
 * tiny-voca text-to-speech.
 *
 * The voice model is a 21 MB ONNX graph bundled with the site. Text is
 * phonemized by dizione inside a local Pyodide worker, so no text or audio is
 * uploaded. The ONNX graph runs on the app's existing ONNX Runtime.
 */

import kokoroFactoryUrl from '../node_modules/kokoro-js/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs?url';
import kokoroWasmUrl from '../node_modules/kokoro-js/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm?url';
import kokoroJsepFactoryUrl from '../node_modules/kokoro-js/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs?url';
import kokoroJsepWasmUrl from '../node_modules/kokoro-js/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm?url';
import { getOrtForTts, type OrtModule } from './ort-runtime';
import {
  phonemizeFast,
  prepareFastPhonemizer,
  type Phonemes,
} from './phonemizer';

const VOICE_ROOT = new URL('tiny-voca/', document.baseURI).href;
const KOKORO_MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';

export const KOKORO_VOICES: Array<{ id: string; label: string }> = [
  { id: 'af_heart', label: 'Heart · American female · A' },
  { id: 'af_bella', label: 'Bella · American female · A-' },
  { id: 'af_nicole', label: 'Nicole · American female · B-' },
  { id: 'af_aoede', label: 'Aoede · American female · C+' },
  { id: 'af_kore', label: 'Kore · American female · C+' },
  { id: 'af_sarah', label: 'Sarah · American female · C+' },
  { id: 'af_alloy', label: 'Alloy · American female · C' },
  { id: 'af_nova', label: 'Nova · American female · C' },
  { id: 'af_sky', label: 'Sky · American female · C-' },
  { id: 'af_jessica', label: 'Jessica · American female · D' },
  { id: 'af_river', label: 'River · American female · D' },
  { id: 'am_michael', label: 'Michael · American male · C+' },
  { id: 'am_fenrir', label: 'Fenrir · American male · C+' },
  { id: 'am_puck', label: 'Puck · American male · C+' },
  { id: 'am_echo', label: 'Echo · American male · D' },
  { id: 'am_eric', label: 'Eric · American male · D' },
  { id: 'am_liam', label: 'Liam · American male · D' },
  { id: 'am_onyx', label: 'Onyx · American male · D' },
  { id: 'am_santa', label: 'Santa · American male · D-' },
  { id: 'am_adam', label: 'Adam · American male · F+' },
  { id: 'bf_emma', label: 'Emma · British female · B-' },
  { id: 'bf_isabella', label: 'Isabella · British female · C' },
  { id: 'bf_alice', label: 'Alice · British female · D' },
  { id: 'bf_lily', label: 'Lily · British female · D' },
  { id: 'bm_george', label: 'George · British male · C' },
  { id: 'bm_fable', label: 'Fable · British male · C' },
  { id: 'bm_lewis', label: 'Lewis · British male · D+' },
  { id: 'bm_daniel', label: 'Daniel · British male · D' },
];

interface TinyVocaConfig {
  sample_rate: number;
  voices: string[];
  vocab: Record<string, number>;
  model: { max_tokens: number };
}

interface WorkerReply {
  type: 'ready' | 'status' | 'phonemes' | 'error';
  id?: number;
  text?: string;
  ids?: number[];
  stress?: number[];
  empty?: boolean;
  message?: string;
  voices?: string[];
  sampleRate?: number;
}

type OrtSession = import('onnxruntime-web').InferenceSession;

const SENTENCE_END =
  /(?<=[.!?…]["'”’)\]]?)\s+(?=["'“‘(\[]?[A-Z0-9])/u;
const CLOSING = /[.!?…,;:]["'”’)\]]*$/u;

function finished(text: string): string {
  const body = text.replace(/\s+$/u, '');
  if (!body) return text;

  const last = body.split(/\s+/u).pop() ?? '';
  const marked = /[\p{L}\p{N}]/u.test(last)
    ? CLOSING.test(last)
    : /[.!?…]/u.test(last) || /^[,;:]$/u.test(last);

  return marked ? text : `${body}.`;
}

function sentences(text: string): string[] {
  return text
    .replace(/\s+/gu, ' ')
    .trim()
    .split(SENTENCE_END)
    .map((part) => part.trim())
    .filter((part) => /[\p{L}\p{N}]/u.test(part));
}

function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const write = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };

  write(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, 'data');
  view.setUint32(40, samples.length * 2, true);

  const pcm = new Int16Array(buffer, 44);
  for (let index = 0; index < samples.length; index += 1) {
    const value = Math.max(-1, Math.min(1, samples[index]));
    pcm[index] = value < 0 ? value * 0x8000 : value * 0x7fff;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

function limitPeak(samples: Float32Array): void {
  let loudest = 0;
  for (let index = 0; index < samples.length; index += 1) {
    loudest = Math.max(loudest, Math.abs(samples[index]));
  }
  if (loudest <= 0.99) return;
  const scale = 0.99 / loudest;
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] *= scale;
  }
}

export interface TtsProgress {
  phase: 'runtime' | 'phonemes' | 'model' | 'ready';
  text: string;
  /** Download bytes when weights are being fetched. */
  loaded?: number;
  total?: number;
}

export interface TtsResult {
  url: string;
  blob: Blob;
  duration: number;
  sampleRate: number;
}

/** Wrap raw mono PCM in a WAV blob and an object URL for the audio player. */
export function ttsResultFromSamples(
  samples: Float32Array,
  sampleRate: number,
): TtsResult {
  limitPeak(samples);
  const blob = encodeWav(samples, sampleRate);
  return {
    url: URL.createObjectURL(blob),
    blob,
    duration: samples.length / sampleRate,
    sampleRate,
  };
}

export type TtsFormat =
  | 'mp3'
  | 'wav'
  | 'ogg'
  | 'flac'
  | 'm4a'
  | 'webm'
  | 'opus';

export const TTS_FORMATS: Array<{
  id: TtsFormat;
  label: string;
  extension: string;
  mime: string;
}> = [
  { id: 'mp3', label: 'MP3 · 128 kbps (default)', extension: 'mp3', mime: 'audio/mpeg' },
  { id: 'wav', label: 'WAV · 16-bit PCM', extension: 'wav', mime: 'audio/wav' },
  { id: 'ogg', label: 'OGG Vorbis', extension: 'ogg', mime: 'audio/ogg' },
  { id: 'flac', label: 'FLAC · lossless', extension: 'flac', mime: 'audio/flac' },
  { id: 'm4a', label: 'M4A · AAC', extension: 'm4a', mime: 'audio/mp4' },
  { id: 'webm', label: 'WebM · Opus', extension: 'webm', mime: 'audio/webm' },
  { id: 'opus', label: 'Opus · Ogg container', extension: 'opus', mime: 'audio/ogg' },
];

export interface TtsOutput {
  url: string;
  blob: Blob;
  duration: number;
  sampleRate: number;
  format: TtsFormat;
  extension: string;
  mime: string;
}

async function encodeMp3Pcm(pcm: Int16Array, sampleRate: number): Promise<Blob> {
  const { Mp3Encoder } = await import('@breezystack/lamejs');
  const encoder = new Mp3Encoder(1, sampleRate, 128);
  const chunks: Uint8Array[] = [];
  const blockSize = 1152;

  for (let index = 0; index < pcm.length; index += blockSize) {
    const block = pcm.subarray(index, Math.min(index + blockSize, pcm.length));
    const encoded = encoder.encodeBuffer(block);
    if (encoded.length > 0) chunks.push(new Uint8Array(encoded));
  }

  const tail = encoder.flush();
  if (tail.length > 0) chunks.push(new Uint8Array(tail));

  return new Blob(chunks as BlobPart[], { type: 'audio/mpeg' });
}


export async function convertTtsResult(
  result: TtsResult,
  format: TtsFormat,
  onStatus?: (text: string) => void,
): Promise<TtsOutput> {
  const meta = TTS_FORMATS.find((entry) => entry.id === format) ?? TTS_FORMATS[0];

  if (format === 'wav') {
    return {
      ...result,
      format,
      extension: meta.extension,
      mime: meta.mime,
    };
  }

  if (format === 'mp3') {
    onStatus?.('Encoding MP3…');
    const buffer = await result.blob.arrayBuffer();
    const pcm = new Int16Array(buffer, 44, (buffer.byteLength - 44) / 2);
    const blob = await encodeMp3Pcm(pcm, result.sampleRate);
    return {
      blob,
      url: URL.createObjectURL(blob),
      duration: result.duration,
      sampleRate: result.sampleRate,
      format,
      extension: meta.extension,
      mime: meta.mime,
    };
  }

  onStatus?.('Encoding locally…');
  const blob = await sharedMedia().encode(result.blob, format as AudioFormat);
  return {
    blob,
    url: URL.createObjectURL(blob),
    duration: result.duration,
    sampleRate: result.sampleRate,
    format,
    extension: meta.extension,
    mime: meta.mime,
  };
}

export type PhonemizerMode = 'fast' | 'accurate';

export class TinyVocaEngine {
  private worker: Worker | null = null;
  private ort: OrtModule | null = null;
  private session: OrtSession | null = null;
  private config: TinyVocaConfig | null = null;
  private ready: Promise<void> | null = null;
  private nextRequest = 1;
  private pending = new Map<
    number,
    { resolve: (value: Phonemes | null) => void; reject: (error: Error) => void }
  >();
  private loadResolve: (() => void) | null = null;
  private loadReject: ((error: Error) => void) | null = null;
  private onLoadStatus: ((text: string) => void) | null = null;

  constructor(private readonly mode: PhonemizerMode = 'fast') {}

  get isLoaded(): boolean {
    return Boolean(
      this.session &&
        this.config &&
        (this.mode === 'fast' || this.worker),
    );
  }

  async load(onProgress?: (progress: TtsProgress) => void): Promise<void> {
    if (this.isLoaded) return;
    if (this.ready) return this.ready;

    this.onLoadStatus = (text) => {
      onProgress?.({
        phase: text.startsWith('Loading the voice') ? 'model' : 'runtime',
        text,
      });
    };

    this.ready = this.doLoad(onProgress).finally(() => {
      this.ready = null;
    });
    return this.ready;
  }

  private async doLoad(onProgress?: (progress: TtsProgress) => void): Promise<void> {
    const fast = this.mode === 'fast';
    onProgress?.({
      phase: fast ? 'phonemes' : 'runtime',
      text: fast
        ? 'Loading the fast English lexicon…'
        : 'Starting the local voice runtime…',
    });

    const ortPromise = getOrtForTts();
    void ortPromise.catch(() => undefined);

    if (fast) {
      await prepareFastPhonemizer();
    } else {
      const worker = new Worker(
        new URL('tts-worker.js', document.baseURI),
        { type: 'classic', name: 'tiny-voca-phonemizer' },
      );
      this.worker = worker;

      const workerReady = new Promise<void>((resolve, reject) => {
        this.loadResolve = resolve;
        this.loadReject = reject;
      });

      worker.onmessage = (event: MessageEvent<WorkerReply>) => {
        const message = event.data;

        if (message.type === 'status') {
          const text = message.text ?? 'Loading the local voice runtime…';
          const phase = text.toLowerCase().includes('phonemizer')
            ? 'phonemes'
            : 'runtime';
          onProgress?.({ phase, text });
          this.onLoadStatus?.(text);
          return;
        }

        if (message.type === 'ready') {
          this.loadResolve?.();
          this.loadResolve = null;
          this.loadReject = null;
          return;
        }

        if (message.type === 'error') {
          const error = new Error(message.message ?? 'The local voice failed.');
          if (typeof message.id === 'number') {
            this.pending.get(message.id)?.reject(error);
            this.pending.delete(message.id);
          } else {
            this.loadReject?.(error);
            this.loadReject = null;
            this.loadResolve = null;
          }
          return;
        }

        if (message.type === 'phonemes' && typeof message.id === 'number') {
          const request = this.pending.get(message.id);
          this.pending.delete(message.id);

          if (!request) return;
          if (message.empty) {
            request.resolve(null);
          } else {
            request.resolve({
              ids: message.ids ?? [],
              stress: message.stress ?? [],
              text: message.text ?? '',
            });
          }
        }
      };

      worker.onerror = (event) => {
        const error = new Error(event.message || 'The local voice worker failed.');
        this.loadReject?.(error);
        this.loadResolve = null;
        this.loadReject = null;
        for (const request of this.pending.values()) request.reject(error);
        this.pending.clear();
      };

      worker.postMessage({ type: 'load' });
      await workerReady;
    }

    const ort = await ortPromise;
    this.ort = ort;

    onProgress?.({ phase: 'model', text: 'Loading the tiny-voca voice model…' });
    const [configText, modelBytes] = await Promise.all([
      fetch(new URL('config.json', VOICE_ROOT)).then((response) => {
        if (!response.ok) throw new Error('Could not load the tiny-voca config.');
        return response.text();
      }),
      fetchWithProgress(new URL('model.onnx', VOICE_ROOT).href, (loaded, total) => {
        onProgress?.({ phase: 'model', text: 'Downloading the tiny-voca voice', loaded, total });
      }).then((bytes) => new Uint8Array(bytes)).catch(() => {
        throw new Error('Could not load the tiny-voca model.');
      }),
    ]);

    this.config = JSON.parse(configText) as TinyVocaConfig;
    this.session = await ort.InferenceSession.create(modelBytes, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });

    onProgress?.({ phase: 'ready', text: 'tiny-voca is ready.' });
  }

  private async phonemize(text: string): Promise<Phonemes | null> {
    if (this.mode === 'fast') {
      const config = this.config;
      if (!config) throw new Error('The local voice is not loaded yet.');
      return phonemizeFast(text, config);
    }

    const worker = this.worker;
    if (!worker) throw new Error('The local voice is not loaded yet.');

    const id = this.nextRequest++;
    return new Promise<Phonemes | null>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ type: 'phonemize', id, text });
    });
  }

  private async fit(
    sentence: string,
    maxTokens: number,
  ): Promise<Phonemes[]> {
    const result = await this.phonemize(sentence);
    if (!result || result.ids.length === 0) return [];
    if (result.ids.length <= maxTokens - 12) return [result];

    const clauses = sentence.split(/(?<=[,;:…?"])\s+/u);
    if (clauses.length > 1) {
      const out: Phonemes[] = [];
      for (const clause of clauses) {
        out.push(...(await this.fit(clause, maxTokens)));
      }
      return out;
    }

    const words = sentence.split(' ');
    if (words.length < 2) return [];
    const half = Math.ceil(words.length / 2);
    return [
      ...(await this.fit(words.slice(0, half).join(' '), maxTokens)),
      ...(await this.fit(words.slice(half).join(' '), maxTokens)),
    ];
  }

  private async synthesize(
    phones: Phonemes,
    voice: number,
    speed: number,
  ): Promise<Float32Array> {
    const ort = this.ort;
    const session = this.session;
    if (!ort || !session) throw new Error('The voice model is not loaded yet.');

    const int64 = (values: number[]) =>
      new ort.Tensor(
        'int64',
        BigInt64Array.from(values.map((value) => BigInt(value))),
        [1, values.length],
      );
    const scalar = (value: number) =>
      new ort.Tensor('float32', Float32Array.of(value), [1]);

    const outputs = await session.run({
      tokens: int64(phones.ids),
      stress: int64(phones.stress),
      voice: new ort.Tensor(
        'int64',
        BigInt64Array.of(BigInt(voice)),
        [1],
      ),
      speed: scalar(speed),
      pitch_shift: scalar(0),
      pitch_range: scalar(1),
    });

    const audio = outputs.audio;
    if (!audio || !(audio.data instanceof Float32Array)) {
      throw new Error('The voice model did not return audio.');
    }

    return audio.data.slice();
  }

  async speak(
    text: string,
    voice: number,
    speed: number,
    onProgress?: (index: number, total: number) => void,
    shouldCancel?: () => boolean,
  ): Promise<TtsResult> {
    await this.load();
    const config = this.config;
    if (!config) throw new Error('The voice model is not loaded yet.');

    const list = sentences(finished(text));
    if (!list.length) throw new Error('Type some English text to speak.');

    const chunks: Float32Array[] = [];
    const maxTokens = config.model.max_tokens;

    for (let index = 0; index < list.length; index += 1) {
      if (shouldCancel?.()) {
        const error = new Error('Speech generation cancelled.');
        error.name = 'AbortError';
        throw error;
      }

      onProgress?.(index, list.length);
      const utterances = await this.fit(list[index], maxTokens);
      for (const phones of utterances) {
        if (shouldCancel?.()) {
          const error = new Error('Speech generation cancelled.');
          error.name = 'AbortError';
          throw error;
        }
        chunks.push(await this.synthesize(phones, voice, speed));
      }
    }

    onProgress?.(list.length, list.length);

    if (!chunks.length) {
      throw new Error('tiny-voca only reads English text, and nothing in the text could be pronounced.');
    }

    const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const audio = new Float32Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      audio.set(chunk, offset);
      offset += chunk.length;
    }
    limitPeak(audio);

    const blob = encodeWav(audio, config.sample_rate);
    return {
      blob,
      url: URL.createObjectURL(blob),
      duration: audio.length / config.sample_rate,
      sampleRate: config.sample_rate,
    };
  }

  async dispose(): Promise<void> {
    this.worker?.terminate();
    this.worker = null;
    this.session = null;
    this.config = null;
    this.ort = null;
    this.loadReject?.(new Error('The voice was unloaded.'));
    this.loadResolve = null;
    this.loadReject = null;
    for (const request of this.pending.values()) {
      request.reject(new Error('The voice was unloaded.'));
    }
    this.pending.clear();
  }
}

interface KokoroAudio {
  audio: Float32Array;
  sampling_rate: number;
}

type KokoroModule = {
  KokoroTTS: {
    from_pretrained: (
      model: string,
      options: {
        dtype: string;
        device: string;
        progress_callback?: (event: {
          status?: string;
          file?: string;
          loaded?: number;
          total?: number;
        }) => void;
      },
    ) => Promise<{
      model: { dispose: () => Promise<void> };
      generate: (
        text: string,
        options: { voice: string; speed: number },
      ) => Promise<KokoroAudio>;
    }>;
  };
  env: { wasmPaths: unknown };
};

export type KokoroMode = 'wasm' | 'webgpu' | 'wasm-q8';

/**
 * Resolve with `promise`, or reject with an AbortError as soon as `signal`
 * aborts. The underlying work is not stopped, but the caller is released.
 */
export function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  const abort = (): Error => {
    const error = new Error('Speech generation cancelled.');
    error.name = 'AbortError';
    return error;
  };
  if (signal.aborted) return Promise.reject(abort());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abort());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error: unknown) => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

export class KokoroEngine {
  private tts: Awaited<
    ReturnType<KokoroModule['KokoroTTS']['from_pretrained']>
  > | null = null;
  private loading: Promise<void> | null = null;
  private pending: Promise<unknown> | null = null;
  constructor(private readonly mode: KokoroMode = 'wasm') {}

  get isLoaded(): boolean {
    return Boolean(this.tts);
  }

  async load(onProgress?: (progress: TtsProgress) => void): Promise<void> {
    if (this.tts) return;
    if (this.loading) return this.loading;

    const device = this.mode === 'webgpu' ? 'webgpu' : 'wasm';
    const dtype = this.mode === 'wasm-q8' ? 'q8' : 'fp32';
    this.loading = (async () => {
      const module = (await import('kokoro-js')) as unknown as KokoroModule;
      module.env.wasmPaths =
        device === 'webgpu'
          ? { wasm: kokoroJsepWasmUrl, mjs: kokoroJsepFactoryUrl }
          : { wasm: kokoroWasmUrl, mjs: kokoroFactoryUrl };

      onProgress?.({
        phase: 'runtime',
        text:
          device === 'webgpu'
            ? 'Loading Kokoro with WebGPU (fp32)…'
            : `Loading Kokoro on CPU (${dtype})…`,
      });

      const files = new Map<string, { loaded: number; total: number }>();
      this.tts = await module.KokoroTTS.from_pretrained(KOKORO_MODEL, {
        dtype,
        device,
        progress_callback: (event) => {
          if (event.status !== 'progress' && event.status !== 'done') return;
          const file = event.file ?? 'Kokoro model';
          const previous = files.get(file);
          const total = Number(event.total) || previous?.total || 0;
          const loaded = event.status === 'done' ? total : Number(event.loaded) || 0;
          files.set(file, { loaded, total });
          let sumLoaded = 0;
          let sumTotal = 0;
          for (const entry of files.values()) {
            sumLoaded += entry.loaded;
            sumTotal += entry.total;
          }
          onProgress?.({ phase: 'model', text: 'Downloading Kokoro', loaded: sumLoaded, total: sumTotal });
        },
      });
    })().finally(() => {
      this.loading = null;
    });

    return this.loading;
  }

  async speak(
    text: string,
    voice: string,
    speed: number,
    onProgress?: (index: number, total: number) => void,
    shouldCancel?: () => boolean,
    signal?: AbortSignal,
  ): Promise<TtsResult> {
    // A cancelled run may still be finishing its last sentence inside ONNX
    // Runtime. Wait for it so two runs never share the session at once.
    await this.pending?.catch(() => undefined);
    await this.load();
    const tts = this.tts;
    if (!tts) throw new Error('The Kokoro model is not loaded yet.');

    const list = sentences(finished(text));
    if (!list.length) throw new Error('Type some English text to speak.');

    const chunks: Float32Array[] = [];
    let sampleRate = 24_000;

    for (let index = 0; index < list.length; index += 1) {
      if (shouldCancel?.()) {
        const error = new Error('Speech generation cancelled.');
        error.name = 'AbortError';
        throw error;
      }

      onProgress?.(index, list.length);
      const run = tts.generate(list[index], { voice, speed });
      this.pending = run;
      const audio = await raceAbort(run, signal);
      this.pending = null;
      chunks.push(audio.audio);
      if (audio.sampling_rate > 0) sampleRate = audio.sampling_rate;
    }

    onProgress?.(list.length, list.length);
    if (!chunks.length) throw new Error('Kokoro did not return any audio.');

    const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const samples = new Float32Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      samples.set(chunk, offset);
      offset += chunk.length;
    }
    limitPeak(samples);

    const blob = encodeWav(samples, sampleRate);
    return {
      blob,
      url: URL.createObjectURL(blob),
      duration: samples.length / sampleRate,
      sampleRate,
    };
  }

  async dispose(): Promise<void> {
    const tts = this.tts;
    this.tts = null;
    await tts?.model.dispose().catch(() => undefined);
  }
}
