/**
 * Cactus runtime: a 1.3 MB single-threaded WebAssembly engine that runs
 * Cactus Compute's `.cact` models (Whistle speech recognition, Mirage scene
 * description) through a small C API. Each model gets its own runtime
 * instance, so speech and vision models can stay loaded together.
 */

import { fetchWithProgress } from './transfer';

/** Pinned runtime release and model revisions. */
const CACTUS_REPO = 'https://huggingface.co/Cactus-Compute/cactus/resolve/f4ab2741203a282c6e7b89983de2b5e5b2e805a8/releases/4.1.4/wasm/';
export const CACTUS_SCRIPT_URL = `${CACTUS_REPO}cactus.js`;
export const CACTUS_WASM_URL = `${CACTUS_REPO}cactus.wasm`;
export const CACTUS_SCRIPT_BYTES = 62_247;
export const CACTUS_WASM_BYTES = 1_274_011;
export const WHISTLE_URL = 'https://huggingface.co/Cactus-Compute/whistle/resolve/88cb00eeb8928ddbcd410b491584f938ba030b07/whistle.cact';
export const WHISTLE_BYTES = 16_919_407;
export const MIRAGE_URL = 'https://huggingface.co/Cactus-Compute/mirage/resolve/3d03cee88c0acbe4e71b94b567ab14e6e55f40c9/mirage.cact';
export const MIRAGE_BYTES = 21_611_043;
export const CACTUS_CACHE = 'localscribe-cactus-v1';

/** Whistle's languages, by the names the model picker uses. */
export const WHISTLE_LANGUAGES: Record<string, string> = {
  English: 'en',
  German: 'de',
  French: 'fr',
  Spanish: 'es',
  Italian: 'it',
  Dutch: 'nl',
  Polish: 'pl',
};

interface CactusModule {
  HEAPU8: Uint8Array;
  _malloc(bytes: number): number;
  _free(pointer: number): void;
  _cactus_load(pointer: number, bytes: bigint): number;
  _cactus_models(): number;
  _cactus_last_error(): number;
  _cactus_reset(): void;
  _cactus_transcribe(pcm: number, samples: number, language: number, keywords: number, wordTimestamps: number, out: number, capacity: number): number;
  _cactus_describe(rgb: number, width: number, height: number, options: number, language: number, keywords: number, out: number, capacity: number): number;
  UTF8ToString(pointer: number): string;
}

type CactusFactory = (options: { wasmBinary: ArrayBuffer; print?: (text: string) => void; printErr?: (text: string) => void }) => Promise<CactusModule>;

const OUTPUT_BYTES = 1 << 18;

/**
 * The runtime ships as an Emscripten script that defines `createCactus`.
 * Evaluate it in a function scope so it does not touch globals.
 */
function factoryFromScript(script: string): CactusFactory {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function('module', 'exports', 'define', `${script}\nreturn createCactus;`)(undefined, undefined, undefined) as CactusFactory;
}

export class CactusModel {
  private constructor(private readonly module: CactusModule) {}

  static async create(script: string, wasm: ArrayBuffer, model: Uint8Array): Promise<CactusModel> {
    const module = await factoryFromScript(script)({ wasmBinary: wasm, print: () => undefined, printErr: () => undefined });
    const pointer = module._malloc(model.byteLength);
    module.HEAPU8.set(model, pointer);
    const status = module._cactus_load(pointer, BigInt(model.byteLength));
    if (status !== 0) {
      throw new Error(`The Cactus runtime could not load this model: ${module.UTF8ToString(module._cactus_last_error()) || `status ${status}`}.`);
    }
    return new CactusModel(module);
  }

  private string(value: string | null | undefined): number {
    if (!value) return 0;
    const bytes = new TextEncoder().encode(value);
    const pointer = this.module._malloc(bytes.length + 1);
    this.module.HEAPU8.set(bytes, pointer);
    this.module.HEAPU8[pointer + bytes.length] = 0;
    return pointer;
  }

  private result(written: number, out: number): string {
    const text = this.module.UTF8ToString(out);
    this.module._free(out);
    if (written < 0 || !text) {
      throw new Error(this.module.UTF8ToString(this.module._cactus_last_error()) || 'The Cactus runtime returned no result.');
    }
    return text;
  }

  /** 16 kHz mono PCM in; text, detected language and word timings out. */
  transcribe(pcm: Float32Array, language?: string): { text: string; language?: string; words: { text: string; start: number; end: number }[] } {
    const { module } = this;
    const audio = module._malloc(pcm.length * 4);
    new Float32Array(module.HEAPU8.buffer, audio, pcm.length).set(pcm);
    const lang = this.string(language);
    const out = module._malloc(OUTPUT_BYTES);
    try {
      const written = module._cactus_transcribe(audio, pcm.length, lang, 0, 1, out, OUTPUT_BYTES);
      const json = JSON.parse(this.result(written, out)) as {
        text?: string;
        language?: string;
        words?: { word: string; start: number; end: number }[];
      };
      return {
        text: (json.text ?? '').trim(),
        language: json.language,
        words: (json.words ?? []).map((word) => ({ text: word.word, start: word.start, end: word.end })),
      };
    } finally {
      module._free(audio);
      if (lang) module._free(lang);
    }
  }

  /** RGBA pixels in; Mirage's scene graph out. */
  describe(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number, channels = 4): MirageScene {
    const { module } = this;
    const rgb = module._malloc(width * height * 3);
    const heap = module.HEAPU8;
    for (let i = 0, j = rgb; i < width * height; i += 1, j += 3) {
      heap[j] = rgba[i * channels];
      heap[j + 1] = rgba[i * channels + (channels > 2 ? 1 : 0)];
      heap[j + 2] = rgba[i * channels + (channels > 2 ? 2 : 0)];
    }
    const out = module._malloc(OUTPUT_BYTES);
    try {
      const written = module._cactus_describe(rgb, width, height, 0, 0, 0, out, OUTPUT_BYTES);
      return JSON.parse(this.result(written, out)) as MirageScene;
    } finally {
      module._free(rgb);
    }
  }
}

/** Mirage output. Boxes are [x1, y1, x2, y2] on a 0–1000 grid. */
export interface MirageScene {
  scene?: Record<string, string>;
  objects?: { id: number; name: string; bbox: [number, number, number, number]; score: number; position?: string; description?: Record<string, string> }[];
  text?: { string: string; bbox: [number, number, number, number]; score: number }[];
  relations?: { subject: number; predicate: string; object: number }[];
  events?: { actor: number; action: string }[];
  reasoning?: string;
}

/** Download into the Cache API once, with byte progress. */
export async function cactusFetch(url: string, expected: number, onBytes: (loaded: number) => void, signal?: AbortSignal): Promise<ArrayBuffer> {
  const cache = typeof caches === 'undefined' ? null : await caches.open(CACTUS_CACHE).catch(() => null);
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

let mirage: Promise<CactusModel> | null = null;

/** Load Mirage with the runtime; reports combined bytes. */
export function loadMirage(onProgress?: (loaded: number, total: number) => void, signal?: AbortSignal): Promise<CactusModel> {
  mirage ??= (async () => {
    const total = CACTUS_SCRIPT_BYTES + CACTUS_WASM_BYTES + MIRAGE_BYTES;
    const parts = [0, 0, 0];
    const report = (index: number) => (loaded: number) => {
      parts[index] = loaded;
      onProgress?.(parts[0] + parts[1] + parts[2], total);
    };
    const [script, wasm, model] = await Promise.all([
      cactusFetch(CACTUS_SCRIPT_URL, CACTUS_SCRIPT_BYTES, report(0), signal),
      cactusFetch(CACTUS_WASM_URL, CACTUS_WASM_BYTES, report(1), signal),
      cactusFetch(MIRAGE_URL, MIRAGE_BYTES, report(2), signal),
    ]);
    return CactusModel.create(new TextDecoder().decode(script), wasm, new Uint8Array(model));
  })().catch((error) => {
    mirage = null;
    throw error;
  });
  return mirage;
}
