/**
 * Text-to-speech engines that plug into the Text to speech page through one
 * interface, instead of a branch per engine in main.ts.
 */

import { getOrt } from './ort-runtime';
import { fetchWithProgress } from './transfer';

export interface PluginVoice {
  id: string;
  /** Option label: "Title · details". */
  label: string;
  title: string;
  meta: string;
  grade?: string;
}

export interface PluginLanguage {
  id: string;
  label: string;
}

export interface PluginProgress {
  text: string;
  loaded?: number;
  total?: number;
}

export interface PluginSpeakOptions {
  text: string;
  voice: string;
  speed: number;
  language?: string;
  signal?: AbortSignal;
  /** Fraction done, when the engine can tell. */
  onProgress?: (fraction: number | null, text: string) => void;
  /** Audio as it is produced, for playback while generating. */
  onChunk?: (pcm: Float32Array, sampleRate: number) => void;
}

export interface PluginFact {
  label: string;
  value: string;
  warn?: boolean;
}

export interface TtsPlugin {
  id: string;
  /** Text in the engine picker. */
  option: string;
  title: string;
  /** Output file prefix and result label. */
  slug: string;
  description: string;
  facts: PluginFact[];
  caveat: string;
  link: { href: string; text: string };
  downloadHint: string;
  /** Whether the speed slider does anything. */
  usesSpeed: boolean;
  /** Streams audio while it generates. */
  streams: boolean;
  /** Prefer WebGPU; still works without it unless requiresWebgpu. */
  requiresWebgpu?: boolean;
  voices(): PluginVoice[];
  languages?(): PluginLanguage[];
  defaultLanguage?: string;
  load(onProgress: (progress: PluginProgress) => void, signal?: AbortSignal): Promise<void>;
  speak(options: PluginSpeakOptions): Promise<{ samples: Float32Array; sampleRate: number }>;
  /** Delete cached weights; resolves to whether anything was removed. */
  clearCache?(): Promise<boolean>;
}

/* Phonon (Gradium) --------------------------------------------------------- */

type PhononModule = typeof import('phonon-tts');
type PhononInstance = Awaited<ReturnType<PhononModule['PhononTTS']['load']>>;

/** Pinned to the revision the package itself is tested against. */
export const PHONON_MODEL = 'hf://gradium/phonon-31m-en@92741c5b07d085ff840e26fea8ce43110b87852f';
const PHONON_BYTES = 64_512_352 + 277_967 + 4_634 + 256_136;

export class PhononPlugin implements TtsPlugin {
  readonly id = 'phonon';
  readonly option = 'Phonon 31M · ~65 MB · streams as it speaks · English';
  readonly title = 'Phonon 31M';
  readonly slug = 'phonon';
  readonly description =
    'Gradium’s 31M-parameter English voice. It starts speaking after the first 80 ms of audio and keeps generating while you listen, from a WebAssembly build in its own worker.';
  readonly facts: PluginFact[] = [
    { label: 'Parameters', value: '31M' },
    { label: 'Model size', value: '~65 MB Q8' },
    { label: 'Output', value: '24 kHz mono' },
    { label: 'Language', value: 'English' },
    { label: 'Voices', value: '1' },
    { label: 'License', value: 'Apache 2.0' },
  ];
  readonly caveat =
    'Runs on the CPU with up to three threads in a worker, or on WebGPU where that is faster. The model downloads once and stays in the browser cache. The speed slider does not affect Phonon.';
  readonly link = { href: 'https://huggingface.co/gradium/phonon-31m-en', text: 'Model card ↗' };
  readonly downloadHint = 'First generation downloads about 65 MB and caches it locally. Playback starts while it is still speaking.';
  readonly usesSpeed = false;
  readonly streams = true;
  private module: PhononModule | null = null;
  private instance: PhononInstance | null = null;
  private loading: Promise<void> | null = null;

  constructor(private readonly preferGpu: () => boolean) {}

  voices(): PluginVoice[] {
    return [{ id: 'default', label: 'Default · English', title: 'Default', meta: 'English' }];
  }

  load(onProgress: (progress: PluginProgress) => void): Promise<void> {
    if (this.instance) return Promise.resolve();
    this.loading ??= (async () => {
      onProgress({ text: 'Starting the Phonon runtime…' });
      this.module ??= await import('phonon-tts');
      const files = new Map<string, { loaded: number; total: number }>();
      this.instance = await this.module.PhononTTS.load({
        lang: 'en',
        model: PHONON_MODEL,
        quant: 'q8',
        device: this.preferGpu() ? 'auto' : 'cpu',
        onProgress: ({ file, loaded, total, cached }) => {
          files.set(file, { loaded, total: total ?? loaded });
          let sumLoaded = 0;
          let sumTotal = 0;
          for (const entry of files.values()) {
            sumLoaded += entry.loaded;
            sumTotal += entry.total;
          }
          onProgress({
            text: cached ? 'Loading Phonon from the local cache' : 'Downloading Phonon',
            loaded: sumLoaded,
            total: Math.max(sumTotal, PHONON_BYTES),
          });
        },
      });
    })().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  async speak({ text, signal, onProgress, onChunk }: PluginSpeakOptions): Promise<{ samples: Float32Array; sampleRate: number }> {
    if (!this.instance || !this.module) throw new Error('Phonon is not loaded.');
    const stream = this.instance.stream(text, { signal });
    const chunks: Float32Array[] = [];
    let samples = 0;
    for await (const pcm of stream) {
      chunks.push(pcm);
      samples += pcm.length;
      onChunk?.(pcm, stream.sampleRate);
      onProgress?.(null, `Speaking · ${(samples / stream.sampleRate).toFixed(1)} s generated`);
    }
    await stream.done;
    signal?.throwIfAborted();
    return { samples: this.module.concatPcm(chunks), sampleRate: stream.sampleRate };
  }

  get runsOn(): string {
    return this.instance ? `${this.instance.device === 'webgpu' ? 'WebGPU' : `CPU · ${this.instance.threads} thread${this.instance.threads === 1 ? '' : 's'}`}` : '';
  }

  async clearCache(): Promise<boolean> {
    this.instance?.dispose();
    this.instance = null;
    const module = this.module ?? await import('phonon-tts');
    return module.clearCache();
  }
}

/* Supertonic 3 (Supertone) -------------------------------------------------- */

const SUPERTONIC_BASE = 'https://huggingface.co/Supertone/supertonic-3/resolve/3cadd1ee6394adea1bd021217a0e650ede09a323/';
export const SUPERTONIC_CACHE = 'localscribe-supertonic-v1';
const SUPERTONIC_GRAPHS = {
  duration: { file: 'onnx/duration_predictor.onnx', bytes: 3_700_147 },
  encoder: { file: 'onnx/text_encoder.onnx', bytes: 36_416_150 },
  estimator: { file: 'onnx/vector_estimator.onnx', bytes: 256_534_781 },
  vocoder: { file: 'onnx/vocoder.onnx', bytes: 101_424_195 },
} as const;
type SupertonicGraph = keyof typeof SUPERTONIC_GRAPHS;
const SUPERTONIC_INDEXER = { file: 'onnx/unicode_indexer.json', bytes: 277_676 };
const SUPERTONIC_BYTES = Object.values(SUPERTONIC_GRAPHS).reduce((sum, graph) => sum + graph.bytes, 0) + SUPERTONIC_INDEXER.bytes;
/** Matches the reference web demo. */
const SUPERTONIC_STEPS = 8;
const SUPERTONIC_RATE = 44_100;
const SUPERTONIC_CHUNK = 512;
const SUPERTONIC_COMPRESS = 6;
const SUPERTONIC_LATENT = 24;
export const SUPERTONIC_LANGUAGES: readonly string[] = [
  'en', 'ko', 'ja', 'ar', 'bg', 'cs', 'da', 'de', 'el', 'es', 'et', 'fi', 'fr', 'hi', 'hr', 'hu',
  'id', 'it', 'lt', 'lv', 'nl', 'pl', 'pt', 'ro', 'ru', 'sk', 'sl', 'sv', 'tr', 'uk', 'vi',
];
const SUPERTONIC_VOICES = ['F1', 'F2', 'F3', 'F4', 'F5', 'M1', 'M2', 'M3', 'M4', 'M5'];

const SUPERTONIC_REPLACEMENTS: Record<string, string> = {
  '–': '-', '‑': '-', '—': '-', _: ' ', '“': '"', '”': '"', '‘': "'", '’': "'",
  '´': "'", '`': "'", '[': ' ', ']': ' ', '|': ' ', '/': ' ', '#': ' ', '→': ' ', '←': ' ',
};

/** Text clean-up from Supertone's reference helper, then language tags. */
export function supertonicText(text: string, language: string): string {
  let out = text.normalize('NFKD');
  out = out.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]+/gu, '');
  for (const [from, to] of Object.entries(SUPERTONIC_REPLACEMENTS)) out = out.replaceAll(from, to);
  out = out.replace(/[♥☆♡©\\]/g, '');
  out = out.replaceAll('@', ' at ').replaceAll('e.g.,', 'for example, ').replaceAll('i.e.,', 'that is, ');
  out = out.replace(/ ([,.!?;:'])/g, '$1');
  out = out.replace(/"{2,}/g, '"').replace(/'{2,}/g, "'");
  out = out.replace(/\s+/g, ' ').trim();
  if (!/[.!?;:,'"')\]}…。」』】〉》›»]$/.test(out)) out += '.';
  return `<${language}>${out}</${language}>`;
}

/** Sentence-packed chunks; Korean and Japanese use shorter ones. */
export function supertonicChunks(text: string, language: string): string[] {
  const maxLength = language === 'ko' || language === 'ja' ? 120 : 300;
  const chunks: string[] = [];
  for (const paragraph of text.trim().split(/\n\s*\n+/)) {
    const trimmed = paragraph.trim();
    if (!trimmed) continue;
    const sentences = trimmed.split(/(?<!Mr\.|Mrs\.|Ms\.|Dr\.|Prof\.|Sr\.|Jr\.|Ph\.D\.|etc\.|e\.g\.|i\.e\.|vs\.|Inc\.|Ltd\.|Co\.|Corp\.|St\.|Ave\.|Blvd\.)(?<!\b[A-Z]\.)(?<=[.!?。！？])\s*/);
    let current = '';
    for (const sentence of sentences) {
      if (!sentence) continue;
      if (current && current.length + sentence.length + 1 > maxLength) {
        chunks.push(current.trim());
        current = sentence;
      } else {
        current += (current ? ' ' : '') + sentence;
      }
    }
    if (current.trim()) chunks.push(current.trim());
  }
  return chunks;
}

type OrtModule = Awaited<ReturnType<typeof getOrt>>;
type OrtSession = Awaited<ReturnType<OrtModule['InferenceSession']['create']>>;
type OrtTensor = InstanceType<OrtModule['Tensor']>;
type SupertonicStyle = { ttl: OrtTensor; dp: OrtTensor };

async function supertonicFetch(file: string, expected: number, onBytes: (loaded: number) => void, signal?: AbortSignal): Promise<ArrayBuffer> {
  const url = SUPERTONIC_BASE + file;
  const cache = typeof caches === 'undefined' ? null : await caches.open(SUPERTONIC_CACHE).catch(() => null);
  const hit = await cache?.match(url);
  if (hit) {
    const bytes = await hit.arrayBuffer();
    onBytes(bytes.byteLength);
    return bytes;
  }
  const bytes = await fetchWithProgress(url, (loaded) => onBytes(loaded), { signal, expectedBytes: expected });
  await cache?.put(url, new Response(bytes)).catch(() => undefined);
  return bytes;
}

export class SupertonicPlugin implements TtsPlugin {
  readonly id = 'supertonic';
  readonly option = 'Supertonic 3 · ~398 MB · 31 languages · 10 voices';
  readonly title = 'Supertonic 3';
  readonly slug = 'supertonic';
  readonly description =
    'Supertone’s multilingual voice model: 31 languages, 10 preset voices, and simple tags such as <laugh>, <breath>, and <sigh>. A flow-matching model that makes 44.1 kHz speech in a few denoising steps.';
  readonly facts: PluginFact[] = [
    { label: 'Model size', value: '~398 MB FP32' },
    { label: 'Output', value: '44.1 kHz mono' },
    { label: 'Languages', value: '31' },
    { label: 'Voices', value: '10 presets' },
    { label: 'Steps', value: String(SUPERTONIC_STEPS) },
    { label: 'License', value: 'OpenRAIL-M', warn: true },
  ];
  readonly caveat =
    'The weights use the OpenRAIL-M license, which forbids some uses, such as impersonating people without consent or making deceptive content. Read it before you publish audio. Long text is split into sentences and spoken one sentence at a time.';
  readonly link = { href: 'https://huggingface.co/Supertone/supertonic-3', text: 'Model card ↗' };
  readonly downloadHint = 'First generation downloads about 398 MB and caches it locally. Each sentence plays as soon as it is ready.';
  readonly usesSpeed = true;
  readonly streams = true;
  readonly defaultLanguage = 'en';
  private sessions: Record<SupertonicGraph, OrtSession> | null = null;
  private ort: OrtModule | null = null;
  private indexer: number[] = [];
  private styles = new Map<string, SupertonicStyle>();
  private loading: Promise<void> | null = null;
  backend: 'webgpu' | 'wasm' | '' = '';

  constructor(private readonly preferGpu: () => boolean) {}

  voices(): PluginVoice[] {
    return SUPERTONIC_VOICES.map((id) => {
      const title = `${id.startsWith('F') ? 'Female' : 'Male'} ${id.slice(1)}`;
      return { id, label: `${title} · all languages`, title, meta: 'All 31 languages' };
    });
  }

  languages(): PluginLanguage[] {
    const names = typeof Intl.DisplayNames === 'function' ? new Intl.DisplayNames(['en'], { type: 'language' }) : null;
    return SUPERTONIC_LANGUAGES
      .map((id) => ({ id, label: names?.of(id) ?? id }))
      .sort((a, b) => (a.id === 'en' ? -1 : b.id === 'en' ? 1 : a.label.localeCompare(b.label)));
  }

  load(onProgress: (progress: PluginProgress) => void, signal?: AbortSignal): Promise<void> {
    if (this.sessions) return Promise.resolve();
    this.loading ??= (async () => {
      const loadedBytes = new Map<string, number>();
      const report = (file: string) => (loaded: number) => {
        loadedBytes.set(file, loaded);
        let sum = 0;
        for (const value of loadedBytes.values()) sum += value;
        onProgress({ text: 'Downloading Supertonic 3', loaded: sum, total: SUPERTONIC_BYTES });
      };
      const indexerBytes = await supertonicFetch(SUPERTONIC_INDEXER.file, SUPERTONIC_INDEXER.bytes, report(SUPERTONIC_INDEXER.file), signal);
      this.indexer = JSON.parse(new TextDecoder().decode(indexerBytes)) as number[];
      // Fetch and start one graph at a time so only one buffer is alive; on
      // a WebGPU retry the graphs come back from the Cache API.
      const create = async (backend: 'webgpu' | 'wasm') => {
        const ort = await getOrt(backend);
        const options = { executionProviders: [backend], graphOptimizationLevel: 'all' } as Parameters<OrtModule['InferenceSession']['create']>[1];
        const sessions = {} as Record<SupertonicGraph, OrtSession>;
        try {
          for (const name of Object.keys(SUPERTONIC_GRAPHS) as SupertonicGraph[]) {
            const graph = SUPERTONIC_GRAPHS[name];
            const bytes = await supertonicFetch(graph.file, graph.bytes, report(graph.file), signal);
            onProgress({ text: `Starting Supertonic 3 · ${name}…` });
            sessions[name] = await ort.InferenceSession.create(new Uint8Array(bytes), options);
          }
        } catch (error) {
          await Promise.all(Object.values(sessions).map((session) => session.release().catch(() => undefined)));
          throw error;
        }
        return { ort, sessions };
      };
      let created: Awaited<ReturnType<typeof create>> | null = null;
      if (this.preferGpu()) {
        try {
          created = await create('webgpu');
          this.backend = 'webgpu';
        } catch (error) {
          console.warn('[Supertonic] WebGPU failed, using WebAssembly', error);
        }
      }
      if (!created) {
        created = await create('wasm');
        this.backend = 'wasm';
      }
      this.ort = created.ort;
      this.sessions = created.sessions;
    })().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  private async style(voice: string, signal?: AbortSignal): Promise<SupertonicStyle> {
    const id = SUPERTONIC_VOICES.includes(voice) ? voice : 'F1';
    const cached = this.styles.get(id);
    if (cached) return cached;
    const ort = this.ort!;
    const bytes = await supertonicFetch(`voice_styles/${id}.json`, 292_046, () => undefined, signal);
    const json = JSON.parse(new TextDecoder().decode(bytes)) as Record<'style_ttl' | 'style_dp', { dims: number[]; data: unknown[] }>;
    const tensor = (entry: { dims: number[]; data: unknown[] }) =>
      new ort.Tensor('float32', Float32Array.from(entry.data.flat(Infinity) as number[]), entry.dims);
    const style = { ttl: tensor(json.style_ttl), dp: tensor(json.style_dp) };
    this.styles.set(id, style);
    return style;
  }

  private async infer(text: string, language: string, style: SupertonicStyle, speed: number, onStep: (step: number) => void): Promise<Float32Array> {
    const ort = this.ort!;
    const sessions = this.sessions!;
    const tagged = supertonicText(text, language);
    // The reference indexes the first UTF-16 unit of each code point.
    const ids = Array.from(tagged).map((char) => BigInt(this.indexer[char.charCodeAt(0)] ?? 0));
    const textIds = new ort.Tensor('int64', BigInt64Array.from(ids), [1, ids.length]);
    const textMask = new ort.Tensor('float32', new Float32Array(ids.length).fill(1), [1, 1, ids.length]);

    const { duration } = await sessions.duration.run({ text_ids: textIds, style_dp: style.dp, text_mask: textMask });
    const seconds = (duration.data as Float32Array)[0] / speed;
    const { text_emb: textEmb } = await sessions.encoder.run({ text_ids: textIds, style_ttl: style.ttl, text_mask: textMask });

    const wavLength = Math.floor(seconds * SUPERTONIC_RATE);
    const latentLength = Math.max(1, Math.ceil(wavLength / (SUPERTONIC_CHUNK * SUPERTONIC_COMPRESS)));
    const latentDim = SUPERTONIC_LATENT * SUPERTONIC_COMPRESS;
    let latent = new Float32Array(latentDim * latentLength);
    for (let i = 0; i < latent.length; i += 1) {
      const u1 = Math.max(1e-10, Math.random());
      latent[i] = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * Math.random());
    }
    const latentMask = new ort.Tensor('float32', new Float32Array(latentLength).fill(1), [1, 1, latentLength]);
    const totalStep = new ort.Tensor('float32', Float32Array.of(SUPERTONIC_STEPS), [1]);
    for (let step = 0; step < SUPERTONIC_STEPS; step += 1) {
      const result = await sessions.estimator.run({
        noisy_latent: new ort.Tensor('float32', latent, [1, latentDim, latentLength]),
        text_emb: textEmb,
        style_ttl: style.ttl,
        text_mask: textMask,
        latent_mask: latentMask,
        total_step: totalStep,
        current_step: new ort.Tensor('float32', Float32Array.of(step), [1]),
      });
      latent = Float32Array.from(result.denoised_latent.data as Float32Array);
      onStep(step + 1);
    }
    const { wav_tts: wav } = await sessions.vocoder.run({ latent: new ort.Tensor('float32', latent, [1, latentDim, latentLength]) });
    const data = wav.data as Float32Array;
    return data.slice(0, Math.min(data.length, wavLength));
  }

  async speak({ text, voice, speed, language, signal, onProgress, onChunk }: PluginSpeakOptions): Promise<{ samples: Float32Array; sampleRate: number }> {
    if (!this.sessions || !this.ort) throw new Error('Supertonic 3 is not loaded.');
    const lang = language && SUPERTONIC_LANGUAGES.includes(language) ? language : 'en';
    const style = await this.style(voice, signal);
    const chunks = supertonicChunks(text, lang);
    const silence = new Float32Array(Math.floor(0.3 * SUPERTONIC_RATE));
    const parts: Float32Array[] = [];
    // Speed 1 in this app maps to the reference demo's default of 1.05.
    const pace = Math.max(0.5, Math.min(2, speed * 1.05));
    for (let index = 0; index < chunks.length; index += 1) {
      signal?.throwIfAborted();
      const pcm = await this.infer(chunks[index], lang, style, pace, (step) => {
        onProgress?.((index + step / SUPERTONIC_STEPS) / chunks.length, `Sentence ${index + 1} of ${chunks.length} · step ${step} of ${SUPERTONIC_STEPS}`);
      });
      if (index > 0) {
        parts.push(silence);
        onChunk?.(silence, SUPERTONIC_RATE);
      }
      parts.push(pcm);
      onChunk?.(pcm, SUPERTONIC_RATE);
    }
    const samples = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
    let offset = 0;
    for (const part of parts) {
      samples.set(part, offset);
      offset += part.length;
    }
    return { samples, sampleRate: SUPERTONIC_RATE };
  }

  get runsOn(): string {
    return this.backend === 'webgpu' ? 'WebGPU' : this.backend === 'wasm' ? 'CPU (WebAssembly)' : '';
  }

  async clearCache(): Promise<boolean> {
    await Promise.all(Object.values(this.sessions ?? {}).map((session) => session.release().catch(() => undefined)));
    this.sessions = null;
    this.styles.clear();
    if (typeof caches === 'undefined') return false;
    return caches.delete(SUPERTONIC_CACHE);
  }
}
