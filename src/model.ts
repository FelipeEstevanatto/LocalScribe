import {
  getModel,
  getVariant,
  resolveModelFiles,
  type ModelFileRole,
  type ModelId,
  type ResolvedModelFile,
  type SupportedModel,
  type ModelVariant,
} from './catalog';
import { AppError, abortError, isAbortError } from './errors';
import { GraniteEngine, type GraniteProgressEvent } from './granite';
import { CactusModel, WHISTLE_LANGUAGES } from './cactus';
import { TransformersAsrEngine, type SpeechProgressEvent, type WordTiming } from './transformers-asr';
import {
  decodeOmnilingualLogits,
  parseOmnilingualTokens,
  type OmnilingualTokens,
} from './omnilingual';
import { computeNemoLogMel } from './mel';
import { MUSIC_MODEL_CACHE } from './music-model';
import {
  QwenTokenizer,
  cleanQwenTranscript,
  qwenAudioTokenLength,
} from './qwen';
import { computeWhisperLogMel } from './whisper-mel';
import { getOrt, type OrtModule } from './ort-runtime';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * ONNX pipelines
 * ─────────────────────────────────────────────────────────────────────────────
 * Supported models use one of two NeMo-style transducer layouts:
 *
 * 1. FUSED TDT — Fluid Speech Pro and Parakeet Redux:
 *    encoder-model / decoder_joint-model, as used by onnx-asr. The decoder and
 *    joint network are one graph:
 *      encoder:      audio_signal [1,128,T], length [1]
 *                 →  outputs [1,1024,T/8], encoded_lengths
 *      decoder_joint: encoder_outputs [1,1024,1], targets [1,1],
 *                     target_length [1], input_states_1/2 [2,1,640]
 *                 →  outputs [1,1,1,8198] (8193 token + 5 duration logits)
 *                    output_states_1/2 [2,1,640]
 *
 * 2. FLUID MINI — split frontend/encoder/decoder/joint:
 *      frontend:     input_features [1,T,128], attention_mask [1,T]
 *                 →  hidden_states [1,T,1024]
 *      encoder:      hidden_states, length
 *                 →  encoder embeddings
 *      decoder:      token [1,1] int64, h_in/c_in [2,1,640]
 *                 →  dec_out, h, c
 *      joint:        encoder_frame, dec_out → 8198 logits
 *
 * Fluid Speech Pro is not a seq2seq encoder-decoder and does not use
 * `input_values` / `attention_mask` / a single `logits` output. TENSOR_ALIASES
 * below exists so a renamed export can be adapted without guessing. A true
 * seq2seq export needs a different decoder loop entirely.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const MODEL_CACHE_NAME = 'fluid-speech-pro-cache';

const CHUNK_SIZE = 32 * 1024 * 1024;
const DOWNLOAD_CONCURRENCY = 4;

const QUOTA_WARNING =
  'The model could not be fully cached because browser storage is full. It will work for this session, but you may need to download it again next time.';
const NO_CACHE_WARNING =
  'This browser does not allow Cache Storage here, so the model cannot be remembered between visits.';

export type Backend = 'webgpu' | 'wasm';

export interface WebGpuStatus {
  supported: boolean;
  shaderF16?: boolean;
  reason?: string;
}

export interface CacheStatus {
  available: boolean;
  cached: boolean;
  bytes: number;
  filesCached: number;
  filesTotal: number;
}

export interface StorageInfo {
  available: boolean;
  usage: number;
  quota: number;
  persisted: boolean;
}

export interface DownloadProgress {
  file: string;
  fileLoaded: number;
  fileTotal: number;
  loaded: number;
  total: number;
  /** Bytes fetched from the network so far (cached chunks are excluded). */
  networkLoaded: number;
  /** Smoothed network throughput, or null until enough samples exist. */
  bytesPerSecond: number | null;
  /** Estimated seconds remaining, or null while the rate is unknown. */
  etaSeconds: number | null;
}

export type LoadPhase = 'storage' | 'download' | 'session' | 'ready';

export interface LoadProgress {
  phase: LoadPhase;
  message: string;
  download?: DownloadProgress;
}

export interface TranscribeProgress {
  framesDone: number;
  framesTotal: number;
}

/** FastConformer encoders subsample 10 ms mel frames by 8. */
const TDT_FRAME_SECONDS = 0.08;

export interface TranscribeOptions {
  signal?: AbortSignal;
  onProgress?: (progress: TranscribeProgress) => void;
  /** Partial text for the current segment, updated while decoding. */
  onPartial?: (text: string) => void;
}

export interface TranscriptionResult {
  text: string;
  tokenCount: number;
  frames: number;
  words?: WordTiming[];
}

export interface EngineOptions {
  modelId: ModelId;
  variantId: string;
  clean: boolean;
  language?: string;
  useWebGPU: boolean;
  onProgress?: (progress: LoadProgress) => void;
  onWarning?: (message: string) => void;
}

/* -------------------------------------------------------------------------- */
/* Browser capability / storage helpers                                       */
/* -------------------------------------------------------------------------- */

export async function detectWebGPU(): Promise<WebGpuStatus> {
  const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;

  if (!gpu) {
    return {
      supported: false,
      reason: 'This browser does not expose the WebGPU API (navigator.gpu).',
    };
  }

  try {
    // Chrome ignores powerPreference on Windows and logs a console warning for
    // it, so only ask for the high-performance adapter elsewhere.
    const windows = /Windows/i.test(navigator.userAgent);
    const adapter = await gpu.requestAdapter(
      windows ? undefined : { powerPreference: 'high-performance' },
    );
    if (!adapter) {
      return {
        supported: false,
        reason: 'No compatible GPU adapter was returned. The CPU (WASM) backend will be used.',
      };
    }
    return { supported: true, shaderF16: adapter.features.has('shader-f16') };
  } catch (error) {
    return {
      supported: false,
      reason: error instanceof Error ? error.message : 'The WebGPU adapter request failed.',
    };
  }
}

export async function requestPersistence(): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

export async function getStorageInfo(): Promise<StorageInfo> {
  try {
    if (!navigator.storage?.estimate) {
      return { available: false, usage: 0, quota: 0, persisted: false };
    }

    const estimate = await navigator.storage.estimate();
    const persisted = navigator.storage.persisted
      ? await navigator.storage.persisted()
      : false;

    return {
      available: true,
      usage: estimate.usage ?? 0,
      quota: estimate.quota ?? 0,
      persisted,
    };
  } catch {
    return { available: false, usage: 0, quota: 0, persisted: false };
  }
}

export async function clearModelCache(): Promise<void> {
  const storage = cacheStorage();
  if (!storage) return;
  await Promise.all([
    storage.delete(MODEL_CACHE_NAME),
    storage.delete('transformers-cache'),
    storage.delete(MUSIC_MODEL_CACHE),
  ]);
}

/**
 * Remove one model family from the shared cache. All variants are included
 * because Fluid Speech Pro's clean graphs share the same weight files.
 */
export async function clearModelCacheFor(modelId: ModelId): Promise<void> {
  const model = getModel(modelId);
  const cleanStates = model.cleanMode ? [false, true] : [false];
  const urls = new Set<string>();

  for (const clean of cleanStates) {
    for (const variant of model.variants) {
      for (const file of resolveModelFiles(modelId, variant.id, clean)) {
        urls.add(file.url);
      }
    }
  }

  if (model.pipeline === 'granite-speech' || model.pipeline === 'moonshine' || model.pipeline === 'whisper') {
    const storage = cacheStorage();
    if (!storage) return;
    const cache = await storage.open('transformers-cache').catch(() => null);
    if (!cache) return;

    const keys = await cache.keys();
    await Promise.all(
      keys
        .filter(
          (request) =>
            request.url.includes(model.repo) || urls.has(request.url),
        )
        .map((request) => cache.delete(request)),
    );
    return;
  }

  const cache = await openCache();
  if (!cache) return;

  await Promise.all([...urls].map((url) => deleteCachedFile(cache, url)));
}

export async function getModelCacheStatus(
  modelId: ModelId,
  variantId: string,
  clean: boolean,
): Promise<CacheStatus> {
  const specs = resolveModelFiles(modelId, variantId, clean);
  const model = getModel(modelId);

  if (model.pipeline === 'granite-speech' || model.pipeline === 'moonshine' || model.pipeline === 'whisper') {
    const storage = cacheStorage();
    const cache = storage
      ? await storage.open('transformers-cache').catch(() => null)
      : null;

    if (!cache) {
      return {
        available: false,
        cached: false,
        bytes: 0,
        filesCached: 0,
        filesTotal: specs.length,
      };
    }

    let bytes = 0;
    let filesCached = 0;

    for (const spec of specs) {
      const response = await cache.match(spec.url).catch(() => undefined);
      if (!response) continue;

      filesCached += 1;
      const length = Number(response.headers.get('content-length'));
      bytes += Number.isFinite(length) && length > 0 ? length : spec.size;
    }

    return {
      available: true,
      cached: filesCached === specs.length,
      bytes,
      filesCached,
      filesTotal: specs.length,
    };
  }

  const cache = await openCache();

  if (!cache) {
    return {
      available: false,
      cached: false,
      bytes: 0,
      filesCached: 0,
      filesTotal: specs.length,
    };
  }

  let bytes = 0;
  let filesCached = 0;
  const requests = await cache.keys();

  for (const spec of specs) {
    const manifest = await readManifest(cache, spec.url);
    if (manifest) {
      filesCached += 1;
      bytes += manifest.size;
      continue;
    }

    // A cancelled/interrupted download leaves individual 32 MB chunks behind.
    // Count them so the UI can say "Partial" and the storage check sees them.
    const prefix = `${spec.url}::chunk:`;
    let partialBytes = 0;

    for (const request of requests) {
      if (!request.url.startsWith(prefix)) continue;
      const index = Number(request.url.slice(prefix.length));
      if (!Number.isInteger(index) || index < 0) continue;
      const expected = Math.min(CHUNK_SIZE, spec.size - index * CHUNK_SIZE);
      if (expected > 0) partialBytes += expected;
    }

    bytes += Math.min(spec.size, partialBytes);
  }

  return {
    available: true,
    cached: filesCached === specs.length,
    bytes,
    filesCached,
    filesTotal: specs.length,
  };
}

export interface ModelCacheRequest {
  modelId: ModelId;
  variantId: string;
  clean: boolean;
}

/**
 * Status for many variants in one pass. Cache Storage round trips and key
 * scans are the expensive part, so open each cache once and derive every
 * variant from a single key snapshot.
 */
export async function getModelCacheStatuses(
  requests: readonly ModelCacheRequest[],
): Promise<CacheStatus[]> {
  const results: CacheStatus[] = new Array(requests.length);
  const transformers: number[] = [];
  const chunked: number[] = [];

  requests.forEach((request, index) => {
    const pipeline = getModel(request.modelId).pipeline;
    if (pipeline === 'granite-speech' || pipeline === 'moonshine' || pipeline === 'whisper') {
      transformers.push(index);
    } else {
      chunked.push(index);
    }
  });

  const unavailable = (filesTotal: number): CacheStatus => ({
    available: false,
    cached: false,
    bytes: 0,
    filesCached: 0,
    filesTotal,
  });

  await Promise.all([
    (async () => {
      if (!transformers.length) return;
      const storage = cacheStorage();
      const cache = storage
        ? await storage.open('transformers-cache').catch(() => null)
        : null;
      const keys = cache ? new Set((await cache.keys().catch(() => [])).map((key) => key.url)) : null;
      for (const index of transformers) {
        const { modelId, variantId, clean } = requests[index];
        const specs = resolveModelFiles(modelId, variantId, clean);
        if (!cache || !keys) {
          results[index] = unavailable(specs.length);
          continue;
        }
        let bytes = 0;
        let filesCached = 0;
        for (const spec of specs) {
          if (!keys.has(spec.url)) continue;
          const response = await cache.match(spec.url).catch(() => undefined);
          if (!response) continue;
          filesCached += 1;
          const length = Number(response.headers.get('content-length'));
          bytes += Number.isFinite(length) && length > 0 ? length : spec.size;
        }
        results[index] = {
          available: true,
          cached: filesCached === specs.length,
          bytes,
          filesCached,
          filesTotal: specs.length,
        };
      }
    })(),
    (async () => {
      if (!chunked.length) return;
      const cache = await openCache();
      const keys = cache ? new Set((await cache.keys().catch(() => [])).map((key) => key.url)) : null;
      for (const index of chunked) {
        const { modelId, variantId, clean } = requests[index];
        const specs = resolveModelFiles(modelId, variantId, clean);
        if (!cache || !keys) {
          results[index] = unavailable(specs.length);
          continue;
        }
        let bytes = 0;
        let filesCached = 0;
        for (const spec of specs) {
          if (keys.has(completeKey(spec.url))) {
            const manifest = await readManifest(cache, spec.url);
            if (manifest) {
              filesCached += 1;
              bytes += manifest.size;
              continue;
            }
          }
          let partialBytes = 0;
          const chunks = Math.ceil(spec.size / CHUNK_SIZE);
          for (let chunk = 0; chunk < chunks; chunk += 1) {
            if (!keys.has(chunkKey(spec.url, chunk))) continue;
            const expected = Math.min(CHUNK_SIZE, spec.size - chunk * CHUNK_SIZE);
            if (expected > 0) partialBytes += expected;
          }
          bytes += Math.min(spec.size, partialBytes);
        }
        results[index] = {
          available: true,
          cached: filesCached === specs.length,
          bytes,
          filesCached,
          filesTotal: specs.length,
        };
      }
    })(),
  ]);

  return results;
}

/* -------------------------------------------------------------------------- */
/* Cache API + resumable model downloads                                      */
/* -------------------------------------------------------------------------- */

interface CachedManifest {
  size: number;
  chunkSize: number;
  chunks: number;
}

type ModelData = Blob | Uint8Array;

interface LoadedFile {
  data: ModelData;
  size: number;
  cached: boolean;
  /** Bytes fetched from the network for this file. */
  networkLoaded: number;
  warning?: string;
}

type FileProgress = (loaded: number, total: number, networkLoaded: number) => void;

async function modelDataToText(data: ModelData): Promise<string> {
  if (data instanceof Uint8Array) return new TextDecoder().decode(data);
  return data.text();
}

async function modelDataToArrayBuffer(data: ModelData): Promise<ArrayBuffer> {
  if (data instanceof Uint8Array) {
    return data.buffer.slice(
      data.byteOffset,
      data.byteOffset + data.byteLength,
    ) as ArrayBuffer;
  }
  return data.arrayBuffer();
}

/**
 * Smoothed download rate over a rolling window. Progress events are frequent
 * enough (roughly 1 MB while a 32 MB chunk is streaming) that the estimate is
 * useful within a few seconds. Cached bytes are deliberately excluded by the
 * caller so a resumed download is not reported at a fake speed.
 */
class DownloadRateMeter {
  private samples: Array<{ time: number; bytes: number }> = [];
  private lastRate: number | null = null;
  private lastRateTime = 0;

  update(bytes: number): number | null {
    if (bytes <= 0) return this.lastRate;

    const now = performance.now();
    this.samples.push({ time: now, bytes });

    // Keep a 6-second window; at least two samples are needed for a delta.
    while (this.samples.length > 2 && now - this.samples[0].time > 6_000) {
      this.samples.shift();
    }

    const oldest = this.samples[0];
    const stable = this.samples.find((sample) => now - sample.time >= 1_000) ?? oldest;
    const elapsed = (now - stable.time) / 1_000;
    const delta = bytes - stable.bytes;

    if (elapsed >= 1 && delta > 0) {
      this.lastRate = delta / elapsed;
      this.lastRateTime = now;
    }

    // Keep the last useful number through a short stall instead of flickering.
    return this.lastRate && now - this.lastRateTime < 10_000 ? this.lastRate : null;
  }
}

function cacheStorage(): CacheStorage | null {
  try {
    return typeof caches === 'undefined' ? null : caches;
  } catch {
    return null;
  }
}

async function openCache(): Promise<Cache | null> {
  const storage = cacheStorage();
  if (!storage) return null;
  try {
    return await storage.open(MODEL_CACHE_NAME);
  } catch {
    return null;
  }
}

function completeKey(url: string): string {
  return `${url}::complete`;
}

function chunkKey(url: string, index: number): string {
  return `${url}::chunk:${index}`;
}

async function readManifest(cache: Cache, url: string): Promise<CachedManifest | null> {
  try {
    const response = await cache.match(completeKey(url));
    if (!response) return null;
    const data = (await response.json()) as Partial<CachedManifest>;
    if (
      typeof data.size !== 'number' ||
      typeof data.chunkSize !== 'number' ||
      typeof data.chunks !== 'number' ||
      data.size <= 0 ||
      data.chunkSize <= 0 ||
      data.chunks < 0
    ) {
      return null;
    }
    return { size: data.size, chunkSize: data.chunkSize, chunks: data.chunks };
  } catch {
    return null;
  }
}

/**
 * Chrome can throw `NotReadableError` when a Cache Storage entry is backed by
 * a file that was evicted, moved, or lost permission. The cache metadata still
 * exists, but reading the response body fails. Treat that (and the other
 * storage-read failures) as a corrupt cache entry rather than a model error.
 */
function isUnreadableStorageError(error: unknown): boolean {
  if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
    if (
      error.name === 'NotReadableError' ||
      error.name === 'DataError' ||
      error.name === 'InvalidStateError' ||
      error.name === 'UnknownError'
    ) {
      return true;
    }
  }

  return (
    error instanceof Error &&
    /could not be read|file was acquired|not readable/i.test(error.message)
  );
}

function hasUnreadableStorageCause(error: unknown, depth = 0): boolean {
  if (depth > 4 || !error) return false;
  if (isUnreadableStorageError(error)) return true;

  const cause = (error as { cause?: unknown }).cause;
  return cause ? hasUnreadableStorageCause(cause, depth + 1) : false;
}

async function readCachedFile(
  cache: Cache,
  url: string,
  onProgress?: (loaded: number, total: number) => void,
): Promise<Blob | null> {
  try {
    const manifest = await readManifest(cache, url);
    if (!manifest) return null;

    // Whole-file fallback used when the host does not support Range requests.
    if (manifest.chunks === 0) {
      const response = await cache.match(url);
      if (!response) return null;
      const blob = await response.blob();
      if (blob.size !== manifest.size) return null;
      onProgress?.(blob.size, blob.size);
      return blob;
    }

    const parts: Blob[] = [];
    const readChunk = async (index: number): Promise<Blob | null> => {
      const response = await cache.match(chunkKey(url, index));
      if (!response) return null;
      const blob = await response.blob();
      const expected = Math.min(manifest.chunkSize, manifest.size - index * manifest.chunkSize);
      return blob.size === expected ? blob : null;
    };

    // Read a few chunks at a time. The Cache API can serve these in parallel,
    // and limiting the batch keeps a multi-GB model from materializing every
    // blob at once.
    for (let start = 0; start < manifest.chunks; start += 4) {
      const end = Math.min(start + 4, manifest.chunks);
      const batch = await Promise.all(
        Array.from({ length: end - start }, (_, offset) => readChunk(start + offset)),
      );
      if (batch.some((blob) => !blob)) return null;
      parts.push(...(batch as Blob[]));
    }

    const blob = new Blob(parts);
    if (blob.size !== manifest.size) return null;
    onProgress?.(blob.size, blob.size);
    return blob;
  } catch (error) {
    if (isUnreadableStorageError(error)) {
      // Drop the bad entry so the normal download path can replace it.
      await deleteCachedFile(cache, url);
    }
    return null;
  }
}

async function deleteCachedFile(cache: Cache, url: string): Promise<void> {
  try {
    const requests = await cache.keys();
    const prefix = `${url}::`;
    await Promise.all(
      requests
        .filter((request) => request.url.startsWith(prefix) || request.url === url)
        .map((request) => cache.delete(request)),
    );
  } catch {
    // Cache eviction is best effort.
  }
}

async function fetchRemoteSize(url: string, signal?: AbortSignal): Promise<number | null> {
  try {
    const head = await fetch(url, {
      method: 'HEAD',
      credentials: 'omit',
      signal,
      cache: 'no-store',
    });

    if (head.ok) {
      const length = Number(head.headers.get('content-length'));
      if (Number.isFinite(length) && length > 0) return length;
    }
  } catch (error) {
    if (isAbortError(error)) throw error;
  }

  try {
    const probe = await fetch(url, {
      headers: { Range: 'bytes=0-0' },
      credentials: 'omit',
      signal,
      cache: 'no-store',
    });

    if (probe.status === 206) {
      const contentRange = probe.headers.get('content-range');
      await probe.body?.cancel().catch(() => undefined);
      const match = contentRange?.match(/\/(\d+)\s*$/);
      if (match) {
        const size = Number(match[1]);
        if (Number.isFinite(size) && size > 0) return size;
      }
    } else {
      await probe.body?.cancel().catch(() => undefined);
    }
  } catch (error) {
    if (isAbortError(error)) throw error;
  }

  return null;
}

async function loadFile(
  spec: ResolvedModelFile,
  onProgress: FileProgress,
  signal?: AbortSignal,
  memoryOnly = false,
): Promise<LoadedFile> {
  const cache = memoryOnly ? null : await openCache();

  if (cache) {
    const cached = await readCachedFile(cache, spec.url, (loaded, total) => {
      onProgress(loaded, total, 0);
    });
    if (cached) {
      return { data: cached, size: cached.size, cached: true, networkLoaded: 0 };
    }
    // Do not delete partial chunks here. A file interrupted before its
    // completion manifest was written should resume from the chunks that are
    // already cached; downloadInChunks() verifies and fills only the gaps.
  }

  // Several catalog sizes are rounded (for example an 8,586-byte decoder
  // graph listed as 8,590), so the served length is authoritative. Resolve it
  // before choosing chunk boundaries.
  const total = (await fetchRemoteSize(spec.url, signal)) ?? spec.size;
  if (!Number.isFinite(total) || total <= 0) {
    throw new AppError(`Could not determine the size of ${spec.name}.`, {
      code: 'DOWNLOAD_BAD_SIZE',
      hint: 'Check your connection and try again.',
    });
  }

  onProgress(0, total, 0);

  try {
    if (memoryOnly) {
      return await downloadToMemory(spec.url, total, onProgress, signal);
    }
    return await downloadInChunks(cache, spec.url, total, onProgress, signal);
  } catch (error) {
    if (isAbortError(error) || error instanceof AppError) throw error;
    throw new AppError(`Could not download ${spec.name} from Hugging Face.`, {
      code: 'DOWNLOAD_FAILED',
      cause: error,
      hint: memoryOnly
        ? 'The browser could not keep the model in memory. Close other tabs and try a smaller model.'
        : 'Check your connection, allow huggingface.co through any ad blocker, then retry. Completed chunks are kept, so the download resumes where it stopped.',
    });
  }
}

/**
 * Read a Range response incrementally. Reading the 32 MB chunk as a stream
 * (instead of one arrayBuffer()) is what makes the speed and ETA update while
 * a chunk is arriving rather than jumping once per chunk.
 */
async function readRangeResponse(
  response: Response,
  onBytes: (received: number) => void,
  signal?: AbortSignal,
): Promise<{ blob: Blob; size: number }> {
  if (!response.body) {
    const blob = await response.blob();
    onBytes(blob.size);
    return { blob, size: blob.size };
  }

  const reader = response.body.getReader();
  const chunks: BlobPart[] = [];
  let size = 0;
  let reported = 0;
  let lastReportTime = 0;

  const report = (force = false) => {
    const now = performance.now();
    if (
      force ||
      size - reported >= 1_000_000 ||
      now - lastReportTime >= 250
    ) {
      reported = size;
      lastReportTime = now;
      onBytes(size);
    }
  };

  while (true) {
    if (signal?.aborted) {
      await reader.cancel().catch(() => undefined);
      throw abortError();
    }

    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value as unknown as BlobPart);
    size += value.byteLength;
    report();
  }

  report(true);
  return { blob: new Blob(chunks), size };
}

async function readResponseBytes(
  response: Response,
  onBytes: (received: number) => void,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    onBytes(bytes.byteLength);
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  while (true) {
    if (signal?.aborted) {
      await reader.cancel().catch(() => undefined);
      throw abortError();
    }

    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    onBytes(size);
  }

  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

class RangeUnsupportedError extends Error {}

/**
 * No-cache download used when Cache Storage is unreadable. The result is a
 * plain in-memory Uint8Array, so ONNX Runtime never has to open a browser-
 * backed blob. Chunks are fetched four at a time and written into the final
 * buffer, so there is no second contiguous copy at the end.
 */
async function downloadToMemory(
  url: string,
  total: number,
  onProgress: FileProgress,
  signal?: AbortSignal,
): Promise<LoadedFile> {
  const chunkCount = Math.ceil(total / CHUNK_SIZE);
  let data: Uint8Array;

  try {
    data = new Uint8Array(total);
  } catch {
    throw new AppError(
      `This model needs ${Math.round(total / 1_000_000)} MB of contiguous memory, which the browser could not allocate.`,
      {
        code: 'MODEL_TOO_LARGE',
        hint: 'Use the Compact variant or a smaller model, and close other tabs.',
      },
    );
  }

  const controller = new AbortController();
  const forwardAbort = () => controller.abort();

  if (signal) {
    if (signal.aborted) throw abortError();
    signal.addEventListener('abort', forwardAbort, { once: true });
  }

  let completedBytes = 0;
  let inFlightBytes = 0;

  const report = (): void => {
    const loaded = Math.min(total, completedBytes + inFlightBytes);
    onProgress(loaded, total, loaded);
  };

  const loadChunk = async (index: number): Promise<void> => {
    if (controller.signal.aborted) throw abortError();

    const expected = Math.min(CHUNK_SIZE, total - index * CHUNK_SIZE);
    if (expected <= 0) return;

    const start = index * CHUNK_SIZE;
    const end = start + expected - 1;
    const response = await fetch(url, {
      headers: { Range: `bytes=${start}-${end}` },
      credentials: 'omit',
      signal: controller.signal,
      cache: 'no-store',
    });

    if (response.status !== 206) {
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 200) throw new RangeUnsupportedError();
      throw new AppError(`Hugging Face returned HTTP ${response.status}.`, {
        code: 'DOWNLOAD_HTTP_ERROR',
        hint: 'The model repository may be unavailable. Try again in a moment.',
      });
    }

    let receivedForChunk = 0;
    const bytes = await readResponseBytes(
      response,
      (received) => {
        inFlightBytes += received - receivedForChunk;
        receivedForChunk = received;
        report();
      },
      controller.signal,
    );

    inFlightBytes -= receivedForChunk;

    if (bytes.byteLength !== expected) {
      throw new AppError('A model download chunk was incomplete.', {
        code: 'DOWNLOAD_INCOMPLETE',
        hint: 'Retry the download.',
      });
    }

    data.set(bytes, index * CHUNK_SIZE);
    completedBytes += expected;
    report();
  };

  let nextIndex = 0;
  let rangeUnsupported = false;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= chunkCount) return;

      try {
        await loadChunk(index);
      } catch (error) {
        if (error instanceof RangeUnsupportedError) rangeUnsupported = true;
        controller.abort();
        throw error;
      }
    }
  };

  const concurrency = Math.min(DOWNLOAD_CONCURRENCY, chunkCount);
  const results = await Promise.allSettled(
    Array.from({ length: concurrency }, () => worker()),
  );

  signal?.removeEventListener('abort', forwardAbort);

  if (rangeUnsupported) {
    const whole = await fetch(url, {
      credentials: 'omit',
      signal,
      cache: 'no-store',
    });
    if (!whole.ok) {
      throw new AppError(`Hugging Face returned HTTP ${whole.status}.`, {
        code: 'DOWNLOAD_HTTP_ERROR',
        hint: 'The model repository may be unavailable. Try again in a moment.',
      });
    }
    const bytes = await readResponseBytes(
      whole,
      (received) => onProgress(received, received, received),
      signal,
    );
    return {
      data: bytes,
      size: bytes.byteLength,
      cached: false,
      networkLoaded: bytes.byteLength,
    };
  }

  if (signal?.aborted) throw abortError();

  const failure = results.find(
    (result) => result.status === 'rejected' && !isAbortError(result.reason),
  );
  if (failure?.status === 'rejected') throw failure.reason;

  if (results.some((result) => result.status === 'rejected')) {
    throw abortError();
  }

  return {
    data,
    size: data.byteLength,
    cached: false,
    networkLoaded: completedBytes,
  };
}

async function downloadInChunks(
  cache: Cache | null,
  url: string,
  total: number,
  onProgress: FileProgress,
  signal?: AbortSignal,
): Promise<LoadedFile> {
  const chunkCount = Math.ceil(total / CHUNK_SIZE);
  const parts = new Array<Blob | null>(chunkCount).fill(null);
  let completedBytes = 0;
  let networkLoaded = 0;
  let inFlightBytes = 0;
  let cacheEnabled = cache !== null;
  let warning: string | undefined = cache ? undefined : NO_CACHE_WARNING;

  const controller = new AbortController();
  const forwardAbort = () => controller.abort();

  if (signal) {
    if (signal.aborted) throw abortError();
    signal.addEventListener('abort', forwardAbort, { once: true });
  }

  const report = (): void => {
    onProgress(
      Math.min(total, completedBytes + inFlightBytes),
      total,
      Math.min(total, networkLoaded + inFlightBytes),
    );
  };

  const loadChunk = async (index: number): Promise<void> => {
    if (controller.signal.aborted) throw abortError();

    const expected = Math.min(CHUNK_SIZE, total - index * CHUNK_SIZE);
    if (expected <= 0) return;

    let part: Blob | null = null;

    if (cache) {
      try {
        const stored = await cache.match(chunkKey(url, index));
        if (stored) {
          const candidate = await stored.blob();
          if (candidate.size === expected) part = candidate;
          else await cache.delete(chunkKey(url, index)).catch(() => undefined);
        }
      } catch (error) {
        if (isUnreadableStorageError(error)) {
          await cache.delete(chunkKey(url, index)).catch(() => undefined);
        }
      }
    }

    let fromNetwork = false;

    if (!part) {
      const start = index * CHUNK_SIZE;
      const end = start + expected - 1;
      const response = await fetch(url, {
        headers: { Range: `bytes=${start}-${end}` },
        credentials: 'omit',
        signal: controller.signal,
        cache: 'no-store',
      });

      if (response.status !== 206) {
        await response.body?.cancel().catch(() => undefined);

        // The HF/Xet CDN supports Range today, but a proxy or a future mirror
        // may not. Fall back to one streaming request rather than failing.
        if (response.status === 200) throw new RangeUnsupportedError();
        throw new AppError(`Hugging Face returned HTTP ${response.status}.`, {
          code: 'DOWNLOAD_HTTP_ERROR',
          hint: 'The model repository may be unavailable. Try again in a moment.',
        });
      }

      let receivedForChunk = 0;
      const received = await readRangeResponse(
        response,
        (receivedBytes) => {
          inFlightBytes += receivedBytes - receivedForChunk;
          receivedForChunk = receivedBytes;
          report();
        },
        controller.signal,
      );

      inFlightBytes -= receivedForChunk;

      if (received.size !== expected) {
        throw new AppError('A model download chunk was incomplete.', {
          code: 'DOWNLOAD_INCOMPLETE',
          hint: 'Retry the download; completed chunks are kept.',
        });
      }

      part = received.blob;
      networkLoaded += received.size;
      fromNetwork = true;
    }

    parts[index] = part;
    completedBytes += expected;
    report();

    if (fromNetwork && cache && cacheEnabled) {
      try {
        await cache.put(chunkKey(url, index), new Response(part));
      } catch (error) {
        cacheEnabled = false;
        warning = isQuotaError(error) ? QUOTA_WARNING : NO_CACHE_WARNING;
        await cache.delete(chunkKey(url, index)).catch(() => undefined);
      }
    }
  };

  let nextIndex = 0;
  let rangeUnsupported = false;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= chunkCount) return;

      try {
        await loadChunk(index);
      } catch (error) {
        if (error instanceof RangeUnsupportedError) rangeUnsupported = true;
        controller.abort();
        throw error;
      }
    }
  };

  const concurrency = Math.min(DOWNLOAD_CONCURRENCY, chunkCount);
  const results = await Promise.allSettled(
    Array.from({ length: concurrency }, () => worker()),
  );

  signal?.removeEventListener('abort', forwardAbort);

  if (rangeUnsupported) {
    return downloadWholeFile(cache, url, total, onProgress, signal);
  }

  if (signal?.aborted) throw abortError();

  const failure = results.find(
    (result) => result.status === 'rejected' && !isAbortError(result.reason),
  );
  if (failure?.status === 'rejected') throw failure.reason;

  if (results.some((result) => result.status === 'rejected')) {
    throw abortError();
  }

  const ordered: Blob[] = [];
  for (const part of parts) {
    if (!part) {
      if (cache) await deleteCachedFile(cache, url);
      throw new AppError('The downloaded model file has the wrong size.', {
        code: 'DOWNLOAD_SIZE_MISMATCH',
        hint: 'Clear the cached model and try again.',
      });
    }
    ordered.push(part);
  }

  const blob = new Blob(ordered);

  if (blob.size !== total) {
    if (cache) await deleteCachedFile(cache, url);
    throw new AppError('The downloaded model file has the wrong size.', {
      code: 'DOWNLOAD_SIZE_MISMATCH',
      hint: 'Clear the cached model and try again.',
    });
  }

  if (cache && cacheEnabled) {
    try {
      const manifest: CachedManifest = {
        size: blob.size,
        chunkSize: CHUNK_SIZE,
        chunks: chunkCount,
      };
      await cache.put(completeKey(url), new Response(JSON.stringify(manifest)));
    } catch (error) {
      warning = isQuotaError(error) ? QUOTA_WARNING : NO_CACHE_WARNING;
      cacheEnabled = false;
    }
  }

  return { data: blob, size: blob.size, cached: cacheEnabled, networkLoaded, warning };
}

/**
 * Fallback for servers that ignore Range headers. If Cache Storage is
 * available the response is streamed straight into it (never into a giant
 * ArrayBuffer); otherwise it is collected into memory as a best effort.
 */
async function downloadWholeFile(
  cache: Cache | null,
  url: string,
  totalHint: number,
  onProgress: FileProgress,
  signal?: AbortSignal,
): Promise<LoadedFile> {
  const response = await fetch(url, {
    credentials: 'omit',
    signal,
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new AppError(`Hugging Face returned HTTP ${response.status}.`, {
      code: 'DOWNLOAD_HTTP_ERROR',
      hint: 'The model repository may be unavailable. Try again in a moment.',
    });
  }

  const total = Number(response.headers.get('content-length')) || totalHint;
  let loaded = 0;

  if (!response.body) {
    const blob = await response.blob();
    onProgress(blob.size, blob.size, blob.size);
    return {
      data: blob,
      size: blob.size,
      cached: false,
      networkLoaded: blob.size,
      warning: NO_CACHE_WARNING,
    };
  }

  if (!cache) {
    const reader = response.body.getReader();
    const chunks: BlobPart[] = [];

    while (true) {
      if (signal?.aborted) throw abortError();
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value as unknown as BlobPart);
      loaded += value.byteLength;
      onProgress(loaded, total, loaded);
    }

    const blob = new Blob(chunks);
    return {
      data: blob,
      size: blob.size,
      cached: false,
      networkLoaded: loaded,
      warning: NO_CACHE_WARNING,
    };
  }

  const counted = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        loaded += chunk.byteLength;
        onProgress(Math.min(loaded, total), total, loaded);
        controller.enqueue(chunk);
      },
    }),
  );

  try {
    await cache.put(url, new Response(counted, { headers: { 'content-type': 'application/octet-stream' } }));
    const stored = await cache.match(url);
    if (!stored) throw new Error('The browser did not store the model response.');

    const blob = await stored.blob();
    const manifest: CachedManifest = {
      size: blob.size,
      chunkSize: blob.size,
      chunks: 0,
    };
    await cache.put(completeKey(url), new Response(JSON.stringify(manifest)));

    return { data: blob, size: blob.size, cached: true, networkLoaded: loaded };
  } catch (error) {
    if (isQuotaError(error)) {
      throw new AppError('There is not enough browser storage for this model.', {
        code: 'QUOTA_EXCEEDED',
        cause: error,
        hint: 'Free up disk space, choose the Compact model, or clear the cached model and try again.',
      });
    }
    throw new AppError('The browser could not store the downloaded model.', {
      code: 'CACHE_WRITE_FAILED',
      cause: error,
      hint: 'Free up disk space or try a different browser.',
    });
  }
}

function isQuotaError(error: unknown): boolean {
  if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
    return error.name === 'QuotaExceededError' || error.code === 22;
  }
  return error instanceof Error && /quota|storage/i.test(error.message);
}

/* -------------------------------------------------------------------------- */
/* Vocabulary / token decoding                                                */
/* -------------------------------------------------------------------------- */

const BYTE_TOKEN = /^<0x([0-9a-fA-F]{2})>$/;

export class VocabularyTokenizer {
  readonly tokens: string[];
  readonly size: number;
  readonly blankId: number;
  private readonly decoder = new TextDecoder();
  private readonly skipIds: ReadonlySet<number>;
  private readonly spaceReplacement: string;

  constructor(
    vocabText: string,
    options: {
      blankId?: number;
      skipIds?: Iterable<number>;
      spaceReplacement?: string;
    } = {},
  ) {
    const tokens: string[] = [];
    let blankId = options.blankId ?? -1;
    this.skipIds = new Set(options.skipIds ?? []);
    this.spaceReplacement = options.spaceReplacement ?? '\u2581';

    for (const rawLine of vocabText.split(/\r?\n/)) {
      const line = rawLine.replace(/\r$/, '');
      if (!line) continue;

      let token = line;
      let id = tokens.length;

      // The official vocab is "token id" separated by a single space.
      const lastSpace = line.lastIndexOf(' ');
      if (lastSpace > 0 && /^\d+$/.test(line.slice(lastSpace + 1))) {
        id = Number(line.slice(lastSpace + 1));
        token = line.slice(0, lastSpace);
      } else {
        // Be tolerant of an "id token" file too.
        const firstSpace = line.indexOf(' ');
        if (firstSpace > 0 && /^\d+$/.test(line.slice(0, firstSpace))) {
          id = Number(line.slice(0, firstSpace));
          token = line.slice(firstSpace + 1);
        }
      }

      while (tokens.length < id) tokens.push('');
      tokens[id] = token;

      if (token === '<blk>' && blankId < 0) blankId = id;
    }

    if (tokens.length < 2) {
      throw new AppError('The model vocabulary could not be read.', {
        code: 'VOCAB_INVALID',
        hint: 'The downloaded vocab.txt looks invalid. Clear the cached model and try again.',
      });
    }

    this.tokens = tokens;
    this.size = tokens.length;
    this.blankId = blankId >= 0 ? blankId : tokens.length - 1;
  }

  /**
   * Build a tokenizer from a Hugging Face tokenizer.json. Fluid Speech Mini
   * ships this format (Parakeet vocabulary) instead of a vocab.txt.
   */
  static fromTokenizerJson(
    text: string,
    options: { blankId: number; padId?: number },
  ): VocabularyTokenizer {
    try {
      const data = JSON.parse(text) as {
        model?: { vocab?: Record<string, number> };
        added_tokens?: Array<{ id: number; content: string; special?: boolean }>;
        decoder?: { replacement?: string };
      };
      const vocab = data.model?.vocab ?? {};
      const added = data.added_tokens ?? [];
      const maxId = Math.max(
        -1,
        ...Object.values(vocab).filter((id): id is number => Number.isInteger(id)),
        ...added.map((token) => token.id),
      );

      if (maxId < 1) throw new Error('empty tokenizer vocabulary');

      const tokens = new Array<string>(maxId + 1).fill('');
      for (const [token, id] of Object.entries(vocab)) {
        if (Number.isInteger(id) && id >= 0) tokens[id] = token;
      }

      const skipIds = new Set<number>([options.blankId]);
      if (options.padId !== undefined) skipIds.add(options.padId);
      for (const token of added) {
        tokens[token.id] = token.content;
        if (token.special) skipIds.add(token.id);
      }

      const lines = tokens
        .map((token, id) => (token ? `${token} ${id}` : ''))
        .filter(Boolean)
        .join('\n');

      return new VocabularyTokenizer(lines, {
        blankId: options.blankId,
        skipIds,
        spaceReplacement: data.decoder?.replacement ?? '\u2581',
      });
    } catch (error) {
      throw new AppError('The model tokenizer could not be read.', {
        code: 'VOCAB_INVALID',
        cause: error,
        hint: 'The downloaded tokenizer.json looks invalid. Clear the cached model and try again.',
      });
    }
  }

  /**
   * Word timings from TDT tokens and the encoder frame each was emitted at.
   * SentencePiece marks a word start with the space replacement character.
   */
  wordTimings(ids: readonly number[], frames: readonly number[], frameSeconds: number, lastFrame: number): WordTiming[] {
    const words: { ids: number[]; frame: number }[] = [];
    ids.forEach((id, index) => {
      if (this.skipIds.has(id)) return;
      const raw = this.tokens[id] ?? '';
      if (!raw || raw === '<blk>') return;
      const startsWord = raw.startsWith(this.spaceReplacement) || !words.length;
      if (startsWord) words.push({ ids: [id], frame: frames[index] ?? 0 });
      else words[words.length - 1].ids.push(id);
    });
    return words
      .map((word, index) => ({
        text: this.decode(word.ids).trim(),
        start: word.frame * frameSeconds,
        end: ((words[index + 1]?.frame ?? lastFrame) || word.frame + 1) * frameSeconds,
      }))
      .filter((word) => word.text.length > 0);
  }

  decode(ids: readonly number[]): string {
    let text = '';
    const pendingBytes: number[] = [];

    const flushBytes = () => {
      if (!pendingBytes.length) return;
      text += this.decoder.decode(Uint8Array.from(pendingBytes));
      pendingBytes.length = 0;
    };

    for (const id of ids) {
      if (this.skipIds.has(id)) continue;
      const raw = this.tokens[id];
      if (!raw) continue;

      const byte = raw.match(BYTE_TOKEN);
      if (byte) {
        pendingBytes.push(Number.parseInt(byte[1], 16));
        continue;
      }

      flushBytes();

      if (
        raw === '<blk>' ||
        raw === '<pad>' ||
        raw === '<s>' ||
        raw === '</s>' ||
        raw === '<unk>' ||
        (raw.startsWith('<|') && raw.endsWith('|>'))
      ) {
        continue;
      }

      text += this.spaceReplacement ? raw.split(this.spaceReplacement).join(' ') : raw;
    }

    flushBytes();
    return text.replace(/\s+/g, ' ').trim();
  }
}

/* -------------------------------------------------------------------------- */
/* ONNX Runtime setup                                                         */
/* -------------------------------------------------------------------------- */

type OrtSession = import('onnxruntime-web').InferenceSession;
type OrtTensor = import('onnxruntime-web').Tensor;
type SessionOptions = NonNullable<Parameters<OrtModule['InferenceSession']['create']>[1]>;

interface OrtNodeMetadata {
  name: string;
  type?: string;
  /** ONNX Runtime Web reports input shapes as `shape`; older builds use `dimensions`. */
  shape?: readonly (number | string)[];
  dimensions?: readonly (number | string)[];
}

/* -------------------------------------------------------------------------- */
/* Tensor names and configuration                                             */
/* -------------------------------------------------------------------------- */

interface TensorNames {
  encoderAudio: string;
  encoderLength: string;
  encoderOut: string;
  encoderOutLengths: string;
  decoderEncoder: string;
  decoderTargets: string;
  decoderTargetLength: string;
  decoderState1: string;
  decoderState2: string;
  decoderOut: string;
  decoderState1Out: string;
  decoderState2Out: string;
}

/**
 * Change these aliases if the FluidVoice export renames tensors.
 *
 * `attention_mask` is only a name fallback. This TDT export uses a scalar
 * `length` [1], not a seq2seq attention mask [1, T]. If a future export really
 * expects `attention_mask`, makeLengthTensor() must build a mask instead.
 */
const TENSOR_ALIASES = {
  encoderAudio: ['audio_signal', 'input_values', 'input_features', 'features'],
  encoderLength: ['length', 'input_lengths', 'attention_mask'],
  encoderOut: ['outputs', 'logits', 'encoder_outputs'],
  encoderOutLengths: ['encoded_lengths', 'output_lengths'],
  decoderEncoder: ['encoder_outputs', 'encoder_out'],
  decoderTargets: ['targets', 'input_ids'],
  decoderTargetLength: ['target_length', 'target_lengths'],
  decoderState1: ['input_states_1', 'state_1'],
  decoderState2: ['input_states_2', 'state_2'],
  decoderOut: ['outputs', 'logits'],
  decoderState1Out: ['output_states_1', 'state_1_out'],
  decoderState2Out: ['output_states_2', 'state_2_out'],
} as const;

interface QwenNames {
  convFeatures: string;
  convOut: string;
  encoderFeatures: string;
  encoderMask: string;
  encoderOut: string;
  inputIds: string;
  audioFeatures: string;
  attentionMask: string;
  cachePosition: string;
  logits: string;
  cacheKeyInputs: string[];
  cacheValueInputs: string[];
  keyDeltas: string[];
  valueDeltas: string[];
}

function resolveQwenNames(
  conv: OrtSession,
  encoder: OrtSession,
  decoder: OrtSession,
): QwenNames {
  if (conv.outputNames.length < 1 || encoder.outputNames.length < 1) {
    throw new AppError('The Qwen3-ASR export has an unexpected output layout.', {
      code: 'TENSOR_MISMATCH',
      hint: 'Re-download the model or check the export revision.',
    });
  }

  const decoderInputs = decoder.inputNames;
  const decoderOutputs = decoder.outputNames;

  if (decoderInputs.length < 6 || (decoderInputs.length - 4) % 2 !== 0) {
    throw new AppError('The Qwen3-ASR decoder is missing its KV-cache inputs.', {
      code: 'TENSOR_MISMATCH',
      hint: `Expected 4 inputs plus key/value pairs, received: ${decoderInputs.join(', ')}.`,
    });
  }

  if (decoderOutputs.length < 3 || (decoderOutputs.length - 1) % 2 !== 0) {
    throw new AppError('The Qwen3-ASR decoder is missing its KV-cache outputs.', {
      code: 'TENSOR_MISMATCH',
      hint: `Expected logits plus key/value deltas, received: ${decoderOutputs.join(', ')}.`,
    });
  }

  const cacheInputs = decoderInputs.slice(4);
  const deltaOutputs = decoderOutputs.slice(1);

  return {
    convFeatures: pickName(
      conv.inputNames,
      ['input_features', 'features'],
      'conv frontend features input',
    ),
    convOut: conv.outputNames[0],
    encoderFeatures: pickName(
      encoder.inputNames,
      ['input_features', 'inputs_embeds'],
      'encoder features input',
    ),
    encoderMask: pickName(
      encoder.inputNames,
      ['feature_attention_mask', 'attention_mask'],
      'encoder mask input',
    ),
    encoderOut: encoder.outputNames[0],
    inputIds: pickName(decoder.inputNames, ['input_ids'], 'decoder input IDs'),
    audioFeatures: pickName(
      decoder.inputNames,
      ['audio_features', 'audio_embeds'],
      'decoder audio features',
    ),
    attentionMask: pickName(
      decoder.inputNames,
      ['attention_mask'],
      'decoder attention mask',
    ),
    cachePosition: pickName(
      decoder.inputNames,
      ['cache_position'],
      'decoder cache position',
    ),
    logits: decoderOutputs[0],
    cacheKeyInputs: cacheInputs.filter((_, index) => index % 2 === 0),
    cacheValueInputs: cacheInputs.filter((_, index) => index % 2 === 1),
    keyDeltas: deltaOutputs.filter((_, index) => index % 2 === 0),
    valueDeltas: deltaOutputs.filter((_, index) => index % 2 === 1),
  };
}

interface MiniNames {
  frontendFeatures: string;
  frontendMask: string;
  frontendOut: string;
  encoderHidden: string;
  encoderLength: string;
  encoderOut: string;
  decoderToken: string;
  decoderH: string;
  decoderC: string;
  decoderOut: string;
  decoderHOut: string;
  decoderCOut: string;
  jointEncoder: string;
  jointDecoder: string;
  jointOut: string;
}

function outputName(session: OrtSession, index: number, role: string): string {
  const name = session.outputNames[index];
  if (!name) {
    throw new AppError(`This ONNX export is missing its ${role} output.`, {
      code: 'TENSOR_MISMATCH',
      hint: `Expected at least ${index + 1} outputs, received: ${session.outputNames.join(', ') || '(none)'}.`,
    });
  }
  return name;
}

function resolveMiniNames(
  frontend: OrtSession,
  encoder: OrtSession,
  decoder: OrtSession,
  joint: OrtSession,
): MiniNames {
  if (frontend.outputNames.length < 1 || encoder.outputNames.length < 1 || joint.outputNames.length < 1) {
    throw new AppError('The Fluid Speech Mini export has an unexpected number of outputs.', {
      code: 'TENSOR_MISMATCH',
      hint: 'Re-download the model or check the export revision.',
    });
  }

  return {
    frontendFeatures: pickName(frontend.inputNames, ['input_features', 'features'], 'frontend features input'),
    frontendMask: pickName(frontend.inputNames, ['attention_mask', 'feature_attention_mask'], 'frontend mask input'),
    frontendOut: frontend.outputNames[0],
    encoderHidden: pickName(encoder.inputNames, ['hidden_states', 'encoder_hidden_states'], 'encoder hidden input'),
    encoderLength: pickName(encoder.inputNames, ['length', 'input_lengths'], 'encoder length input'),
    encoderOut: encoder.outputNames[0],
    decoderToken: pickName(decoder.inputNames, ['token', 'targets'], 'decoder token input'),
    decoderH: pickName(decoder.inputNames, ['h_in', 'input_states_1'], 'decoder h input'),
    decoderC: pickName(decoder.inputNames, ['c_in', 'input_states_2'], 'decoder c input'),
    decoderOut: outputName(decoder, 0, 'decoder'),
    decoderHOut: outputName(decoder, 1, 'decoder h'),
    decoderCOut: outputName(decoder, 2, 'decoder c'),
    jointEncoder: pickName(joint.inputNames, ['encoder_frame', 'encoder_outputs'], 'joint encoder input'),
    jointDecoder: pickName(joint.inputNames, ['decoder_out', 'decoder_outputs'], 'joint decoder input'),
    jointOut: joint.outputNames[0],
  };
}

function resolveTensorNames(encoder: OrtSession, decoder: OrtSession): TensorNames {
  return {
    encoderAudio: pickName(encoder.inputNames, TENSOR_ALIASES.encoderAudio, 'encoder audio input'),
    encoderLength: pickName(encoder.inputNames, TENSOR_ALIASES.encoderLength, 'encoder length input'),
    encoderOut: pickName(encoder.outputNames, TENSOR_ALIASES.encoderOut, 'encoder output'),
    encoderOutLengths: pickName(
      encoder.outputNames,
      TENSOR_ALIASES.encoderOutLengths,
      'encoder output lengths',
    ),
    decoderEncoder: pickName(
      decoder.inputNames,
      TENSOR_ALIASES.decoderEncoder,
      'decoder encoder input',
    ),
    decoderTargets: pickName(
      decoder.inputNames,
      TENSOR_ALIASES.decoderTargets,
      'decoder targets input',
    ),
    decoderTargetLength: pickName(
      decoder.inputNames,
      TENSOR_ALIASES.decoderTargetLength,
      'decoder target length input',
    ),
    decoderState1: pickName(
      decoder.inputNames,
      TENSOR_ALIASES.decoderState1,
      'decoder state 1 input',
    ),
    decoderState2: pickName(
      decoder.inputNames,
      TENSOR_ALIASES.decoderState2,
      'decoder state 2 input',
    ),
    decoderOut: pickName(decoder.outputNames, TENSOR_ALIASES.decoderOut, 'decoder logits output'),
    decoderState1Out: pickName(
      decoder.outputNames,
      TENSOR_ALIASES.decoderState1Out,
      'decoder state 1 output',
    ),
    decoderState2Out: pickName(
      decoder.outputNames,
      TENSOR_ALIASES.decoderState2Out,
      'decoder state 2 output',
    ),
  };
}

function pickName(available: readonly string[], aliases: readonly string[], role: string): string {
  const found = aliases.find((alias) => available.includes(alias));
  if (found) return found;

  throw new AppError(`This ONNX export is missing its ${role} tensor.`, {
    code: 'TENSOR_MISMATCH',
    hint: `Available tensors: ${available.join(', ') || '(none)'}. If this is a different Fluid Speech Pro export, update the aliases in src/model.ts. A true seq2seq export needs a different decoder loop.`,
  });
}

interface CreateSessionArgs {
  ort: OrtModule;
  graph: ArrayBuffer | Uint8Array;
  data?: ModelData;
  dataName?: string;
  label: string;
  preferWebGPU: boolean;
  onWarning: (message: string) => void;
}

async function createSession({
  ort,
  graph,
  data,
  dataName,
  label,
  preferWebGPU,
  onWarning,
}: CreateSessionArgs): Promise<{ session: OrtSession; backend: Backend }> {
  const graphBytes = graph instanceof Uint8Array ? graph : new Uint8Array(graph);
  const externalData: Array<{ path: string; data: ModelData }> = [];
  if (data) {
    const externalPaths = findExternalDataPaths(graphBytes);
    if (!externalPaths.length && dataName) {
      // If the protobuf scan missed the location string, provide the two common
      // spellings. ONNX Runtime only mounts the one the graph references.
      externalPaths.push(dataName, `./${dataName}`);
    }

    for (const path of externalPaths) {
      externalData.push({ path, data });
    }
  }

  const baseOptions: Record<string, unknown> = {
    executionProviders: preferWebGPU ? ['webgpu', 'wasm'] : ['wasm'],
    ...(externalData.length ? { externalData } : {}),
    graphOptimizationLevel: 'all',
    preferredOutputLocation: 'cpu',
  };

  try {
    const session = await ort.InferenceSession.create(
      graphBytes,
      baseOptions as SessionOptions,
    );
    return { session, backend: preferWebGPU ? 'webgpu' : 'wasm' };
  } catch (error) {
    if (!preferWebGPU) throw error;
    onWarning(
      `${label} could not initialize on WebGPU. Retrying on the CPU backend; this can be slower.`,
    );
    const fallbackOptions: Record<string, unknown> = {
      ...baseOptions,
      executionProviders: ['wasm'],
    };
    const session = await ort.InferenceSession.create(
      graphBytes,
      fallbackOptions as SessionOptions,
    );
    return { session, backend: 'wasm' };
  }
}

function findExternalDataPaths(graph: ArrayBuffer | Uint8Array): string[] {
  const bytes = graph instanceof Uint8Array ? graph : new Uint8Array(graph);
  const text = new TextDecoder('latin1').decode(bytes);
  const matches = text.match(/[A-Za-z0-9_./\\-]+\.onnx\.data/g) ?? [];
  return [...new Set(matches)];
}

function inputMetadata(session: OrtSession): OrtNodeMetadata[] | undefined {
  const metadata = (
    session as unknown as {
      inputMetadata?: OrtNodeMetadata[];
    }
  ).inputMetadata;

  if (!metadata) return undefined;

  return metadata.map((entry) => ({
    ...entry,
    dimensions: entry.dimensions ?? entry.shape,
  }));
}

function positiveDims(value: readonly (number | string)[] | undefined): number[] | null {
  if (!value || value.length === 0) return null;
  if (!value.every((dim) => typeof dim === 'number' && Number.isFinite(dim) && dim > 0)) {
    return null;
  }
  return value as number[];
}

function product(values: readonly number[]): number {
  return values.reduce((total, value) => total * value, 1);
}

/* -------------------------------------------------------------------------- */
/* Model configuration                                                        */
/* -------------------------------------------------------------------------- */

interface ResolvedConfig {
  featuresSize: number;
  subsampling: number;
  maxTokensPerStep: number;
  blankTokenId: number;
  padTokenId: number;
  eosTokenId: number;
  durations: number[];
  decoderLayers: number;
  decoderHidden: number;
  encoderHidden: number;
  samplingRate: number;
  nFft: number;
  hopLength: number;
  winLength: number;
  preemphasis: number;
  numMelBins: number;
  maxSinglePassSeconds: number;
  subsamplingKernel: number;
  subsamplingStride: number;
  subsamplingLayers: number;
  frontendChunkFrames: number;
}

const CONFIG_DEFAULTS: ResolvedConfig = {
  featuresSize: 128,
  subsampling: 8,
  maxTokensPerStep: 10,
  blankTokenId: 8192,
  padTokenId: 2,
  eosTokenId: 3,
  durations: [0, 1, 2, 3, 4],
  decoderLayers: 2,
  decoderHidden: 640,
  encoderHidden: 1024,
  samplingRate: 16_000,
  nFft: 512,
  hopLength: 160,
  winLength: 400,
  preemphasis: 0.97,
  numMelBins: 128,
  maxSinglePassSeconds: 40,
  subsamplingKernel: 3,
  subsamplingStride: 2,
  subsamplingLayers: 3,
  frontendChunkFrames: 50,
};

function resolveConfig(text: string): ResolvedConfig {
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    const durationsRaw = Array.isArray(raw.durations) ? raw.durations : null;
    const durations = durationsRaw
      ?.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
      .map((value) => Math.max(0, Math.round(value)));

    return {
      featuresSize: intInRange(
        raw.features_size ?? raw.num_mel_bins,
        CONFIG_DEFAULTS.featuresSize,
        8,
        512,
      ),
      subsampling: intInRange(
        raw.subsampling_factor,
        CONFIG_DEFAULTS.subsampling,
        1,
        64,
      ),
      maxTokensPerStep: intInRange(
        raw.max_tokens_per_step ?? raw.max_symbols_per_step ?? raw.max_tokens_per_frame,
        CONFIG_DEFAULTS.maxTokensPerStep,
        1,
        100,
      ),
      blankTokenId: intInRange(
        raw.blank_token_id,
        CONFIG_DEFAULTS.blankTokenId,
        0,
        1_000_000,
      ),
      padTokenId: intInRange(raw.pad_token_id, CONFIG_DEFAULTS.padTokenId, 0, 1_000_000),
      eosTokenId: intInRange(raw.eos_token_id, CONFIG_DEFAULTS.eosTokenId, 0, 1_000_000),
      durations: durations && durations.length ? durations : CONFIG_DEFAULTS.durations,
      decoderLayers: intInRange(raw.decoder_layers, CONFIG_DEFAULTS.decoderLayers, 1, 64),
      decoderHidden: intInRange(
        raw.decoder_hidden_size,
        CONFIG_DEFAULTS.decoderHidden,
        1,
        8192,
      ),
      encoderHidden: intInRange(
        raw.encoder_hidden_size,
        CONFIG_DEFAULTS.encoderHidden,
        1,
        8192,
      ),
      samplingRate: intInRange(raw.sampling_rate, CONFIG_DEFAULTS.samplingRate, 8000, 48000),
      nFft: intInRange(raw.n_fft, CONFIG_DEFAULTS.nFft, 64, 4096),
      hopLength: intInRange(raw.hop_length, CONFIG_DEFAULTS.hopLength, 1, 1024),
      winLength: intInRange(raw.win_length, CONFIG_DEFAULTS.winLength, 16, 4096),
      preemphasis:
        typeof raw.preemphasis === 'number' && Number.isFinite(raw.preemphasis)
          ? raw.preemphasis
          : CONFIG_DEFAULTS.preemphasis,
      numMelBins: intInRange(
        raw.num_mel_bins ?? raw.features_size,
        CONFIG_DEFAULTS.numMelBins,
        8,
        512,
      ),
      maxSinglePassSeconds:
        typeof raw.max_single_pass_seconds === 'number' &&
        Number.isFinite(raw.max_single_pass_seconds)
          ? raw.max_single_pass_seconds
          : CONFIG_DEFAULTS.maxSinglePassSeconds,
      subsamplingKernel: intInRange(
        raw.subsampling_kernel,
        CONFIG_DEFAULTS.subsamplingKernel,
        1,
        64,
      ),
      subsamplingStride: intInRange(
        raw.subsampling_stride,
        CONFIG_DEFAULTS.subsamplingStride,
        1,
        8,
      ),
      subsamplingLayers: intInRange(
        raw.subsampling_layers,
        CONFIG_DEFAULTS.subsamplingLayers,
        1,
        8,
      ),
      frontendChunkFrames: intInRange(
        raw.frontend_chunk_frames,
        CONFIG_DEFAULTS.frontendChunkFrames,
        1,
        4096,
      ),
    };
  } catch {
    return { ...CONFIG_DEFAULTS };
  }
}

function intInRange(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const rounded = Math.round(value);
  if (rounded < min || rounded > max) return fallback;
  return rounded;
}

/* -------------------------------------------------------------------------- */
/* Engine                                                                     */
/* -------------------------------------------------------------------------- */

export class AsrEngine {
  readonly modelId: ModelId;
  readonly variantId: string;
  readonly model: SupportedModel;
  readonly variant: ModelVariant;
  readonly clean: boolean;
  readonly language: string;

  backend: Backend | null = null;
  warning: string | null = null;

  private readonly useWebGPU: boolean;
  private readonly onProgress?: (progress: LoadProgress) => void;
  private readonly onWarning?: (message: string) => void;

  private ort: OrtModule | null = null;
  private encoder: OrtSession | null = null;
  private decoder: OrtSession | null = null;
  private frontend: OrtSession | null = null;
  private joint: OrtSession | null = null;
  private convFrontend: OrtSession | null = null;
  private preprocessor: OrtSession | null = null;
  private granite: GraniteEngine | null = null;
  private transformersAsr: TransformersAsrEngine | null = null;
  private cactus: CactusModel | null = null;
  private omnilingualSession: OrtSession | null = null;
  private omnilingualTokens: OmnilingualTokens | null = null;
  private tokenizer: VocabularyTokenizer | null = null;
  private qwenTokenizer: QwenTokenizer | null = null;
  private config: ResolvedConfig = { ...CONFIG_DEFAULTS };
  private names: TensorNames | null = null;
  private miniNames: MiniNames | null = null;
  private qwenNames: QwenNames | null = null;
  private featuresFirst = true;
  private frontendTimeFirst = true;
  private encoderTimeFirst = true;
  private jointEncoderDims: number[] = [1, 1024];
  private jointDecoderDims: number[] | null = null;
  private decoderHidden = 1024;
  private stateDims: [number[], number[]] = [
    [2, 1, 640],
    [2, 1, 640],
  ];
  private lengthDtype: 'int64' | 'int32' = 'int64';
  private miniTokenDtype: 'int64' | 'int32' = 'int64';
  private loading: Promise<void> | null = null;
  private memoryOnly = false;
  private disposed = false;

  constructor(options: EngineOptions) {
    this.modelId = options.modelId;
    this.variantId = options.variantId;
    this.model = getModel(options.modelId);
    this.variant = getVariant(this.model, options.variantId);
    this.clean = this.model.cleanMode ? options.clean : false;
    this.language = this.model.languageOptions?.includes(options.language ?? '')
      ? options.language ?? ''
      : '';
    this.useWebGPU = options.useWebGPU;
    this.onProgress = options.onProgress;
    this.onWarning = options.onWarning;
  }

  get isLoaded(): boolean {
    if (this.model.pipeline === 'granite-speech') {
      return Boolean(this.granite?.isLoaded);
    }

    if (this.model.pipeline === 'moonshine' || this.model.pipeline === 'whisper') {
      return Boolean(this.transformersAsr?.isLoaded);
    }

    if (this.model.pipeline === 'omnilingual') {
      return Boolean(this.omnilingualSession && this.omnilingualTokens);
    }

    if (this.model.pipeline === 'cactus') return Boolean(this.cactus);

    if (!this.ort) return false;

    if (this.model.pipeline === 'qwen3-asr') {
      return Boolean(
        this.convFrontend &&
          this.encoder &&
          this.decoder &&
          this.qwenTokenizer &&
          this.qwenNames,
      );
    }

    if (!this.encoder || !this.decoder || !this.tokenizer) return false;
    if (this.model.pipeline === 'fluid-mini-tdt') {
      return Boolean(this.frontend && this.joint && this.miniNames);
    }
    return Boolean(this.names);
  }

  async load(signal?: AbortSignal): Promise<void> {
    if (this.isLoaded) return;
    if (this.loading) return this.loading;

    this.loading = this.loadWithCacheRecovery(signal).finally(() => {
      this.loading = null;
    });

    return this.loading;
  }

  /**
   * Run a short silent chunk so WebGPU shader and kernel compilation happens
   * before the first real transcription. Best effort: a model that dislikes
   * the input simply skips the warmup.
   */
  async warmup(signal?: AbortSignal): Promise<void> {
    if (this.backend !== 'webgpu' || !this.isLoaded) return;
    if (this.model.pipeline === 'cactus' || this.model.pipeline === 'granite-speech') return;
    const silence = new Float32Array(16_000);
    await this.transcribe(silence, { signal });
  }

  /**
   * Chrome can keep valid Cache Storage metadata while losing the backing
   * file. Reads then throw NotReadableError. Clear only this model once and
   * retry; if it still fails, load the weights into memory without touching
   * Cache Storage at all.
   */
  private async loadWithCacheRecovery(signal?: AbortSignal): Promise<void> {
    const recoverable = (error: unknown): boolean =>
      !this.disposed &&
      !isAbortError(error) &&
      hasUnreadableStorageCause(error);

    try {
      await this.doLoad(signal);
      return;
    } catch (error) {
      if (!recoverable(error)) throw error;
    }

    // A cache-backed Blob can become unreadable after the browser evicts or
    // locks its backing file. Clearing and retrying through Cache Storage can
    // fail the same way and forces another multi-hundred-MB download. Go
    // straight to the memory-backed path, which needs one download and never
    // asks ONNX Runtime to reopen a Cache Storage blob.
    this.memoryOnly = true;
    this.recordWarning(
      'The cached model files could not be read. The model will be downloaded once and held in memory for this session.',
    );
    this.emit({
      phase: 'storage',
      message: 'Cached model files were unreadable; retrying in memory…',
    });

    await this.releaseSessions();
    await clearModelCacheFor(this.modelId);

    try {
      await this.doLoad(signal);
    } catch (error) {
      if (recoverable(error)) {
        throw new AppError('The browser could not read the model files.', {
          code: 'CACHE_UNREADABLE',
          cause: error,
          hint: 'The model was retried without Cache Storage but the browser still could not read it. Close other tabs to free memory, or try a smaller model. If this is an in-private window, open a normal window.',
        });
      }
      throw error;
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.releaseSessions();
  }

  async transcribe(
    samples: Float32Array,
    options: TranscribeOptions = {},
  ): Promise<TranscriptionResult> {
    if (this.model.pipeline === 'granite-speech') {
      return this.transcribeGranite(samples, options);
    }

    if (this.model.pipeline === 'moonshine' || this.model.pipeline === 'whisper') {
      return this.transcribeWithTransformers(samples, options);
    }

    if (this.model.pipeline === 'omnilingual') {
      return this.transcribeOmnilingual(samples, options);
    }

    if (this.model.pipeline === 'cactus') {
      return this.transcribeCactus(samples, options);
    }

    if (this.model.pipeline === 'qwen3-asr') {
      return this.transcribeQwen(samples, options);
    }

    if (this.model.pipeline === 'fluid-mini-tdt') {
      return this.transcribeMini(samples, options);
    }

    const ort = this.ort;
    const encoder = this.encoder;
    const decoder = this.decoder;
    const tokenizer = this.tokenizer;
    const names = this.names;

    if (!ort || !encoder || !decoder || !tokenizer || !names) {
      throw new AppError('The model is not loaded yet.', {
        code: 'MODEL_NOT_READY',
        hint: 'Load the model first, then try again.',
      });
    }

    if (options.signal?.aborted) throw abortError();
    await yieldToUi();

    const padded = samples.length < 160 ? padSamples(samples, 160) : samples;
    let featureData: Float32Array;
    let featureFrames: number;
    let featureLength: number;
    let featureNMels: number;

    if (this.preprocessor) {
      const waveform = new ort.Tensor('float32', padded, [1, padded.length]);
      const waveformLens = new ort.Tensor(
        'int64',
        BigInt64Array.of(BigInt(padded.length)),
        [1],
      );
      const preprocessed = await this.preprocessor.run({
        waveforms: waveform,
        waveforms_lens: waveformLens,
      });
      const featuresTensor = preprocessed.features;
      const featuresLengthTensor = preprocessed.features_lens;

      if (
        !featuresTensor ||
        !(featuresTensor.data instanceof Float32Array) ||
        featuresTensor.dims.length !== 3
      ) {
        throw new AppError('The model preprocessor did not return features.', {
          code: 'PREPROCESSOR_OUTPUT_MISSING',
          hint: `Returned tensors: ${Object.keys(preprocessed).join(', ') || '(none)'}.`,
        });
      }

      featureData = featuresTensor.data;
      featureNMels = Number(featuresTensor.dims[1]);
      featureFrames = Number(featuresTensor.dims[2]);
      featureLength = featureFrames;

      if (featuresLengthTensor) {
        const value = Number(
          (featuresLengthTensor.data as ArrayLike<number | bigint>)[0],
        );
        if (Number.isFinite(value) && value > 0) {
          featureLength = Math.min(featureFrames, Math.floor(value));
        }
      }
    } else {
      const features = computeNemoLogMel(padded, {
        nMels: this.config.featuresSize,
      });

      if (features.frames <= 0) {
        return { text: '', tokenCount: 0, frames: 0 };
      }

      featureData = this.featuresFirst
        ? features.data
        : transposeFeatures(features.data, features.nMels, features.frames);
      featureFrames = features.frames;
      featureLength = features.frames;
      featureNMels = features.nMels;
    }

    if (featureFrames <= 0 || featureLength <= 0) {
      return { text: '', tokenCount: 0, frames: 0 };
    }

    const featureDims: [number, number, number] = this.featuresFirst
      ? [1, featureNMels, featureFrames]
      : [1, featureFrames, featureNMels];

    const audioTensor = new ort.Tensor('float32', featureData, featureDims);
    const lengthTensor = this.makeLengthTensor(ort, featureLength);
    const encoderOutputs = await encoder.run({
      [names.encoderAudio]: audioTensor,
      [names.encoderLength]: lengthTensor,
    });
    disposeTensor(audioTensor);
    disposeTensor(lengthTensor);

    const encoderTensor = encoderOutputs[names.encoderOut];
    if (!encoderTensor) {
      throw new AppError('The encoder did not return its expected output tensor.', {
        code: 'ENCODER_OUTPUT_MISSING',
        hint: `Returned tensors: ${Object.keys(encoderOutputs).join(', ') || '(none)'}.`,
      });
    }

    if (!(encoderTensor.data instanceof Float32Array)) {
      throw new AppError('The encoder output is not float32.', {
        code: 'ENCODER_DTYPE',
        hint: 'This export uses a different precision. Try the Compact or Full preset again.',
      });
    }

    const encoded = this.readEncoderOutput(encoderTensor);
    const encodedLengthTensor = encoderOutputs[names.encoderOutLengths];

    let encodedFrames = encoded.frames;
    if (encodedLengthTensor) {
      const value = Number((encodedLengthTensor.data as ArrayLike<number | bigint>)[0]);
      if (Number.isFinite(value) && value > 0) {
        encodedFrames = Math.min(encodedFrames, Math.floor(value));
      }
    }



    if (encodedFrames <= 0) {
      disposeTensor(encoderTensor);
      disposeTensor(encodedLengthTensor);
      return { text: '', tokenCount: 0, frames: 0 };
    }

    const tokenIds: number[] = [];
    const maxTokens = this.config.maxTokensPerStep;
    const blankId = Math.min(tokenizer.blankId, tokenizer.size - 1);

    let state1: OrtTensor = new ort.Tensor(
      'float32',
      new Float32Array(product(this.stateDims[0])),
      this.stateDims[0],
    );
    let state2: OrtTensor = new ort.Tensor(
      'float32',
      new Float32Array(product(this.stateDims[1])),
      this.stateDims[1],
    );

    let frame = 0;
    let emitted = 0;
    let lastToken = blankId;
    const tokenFrames: number[] = [];
    let iterations = 0;
    let lastReportedFrame = -1;
    let lastReportTime = 0;
    let lastPartialTime = 0;
    const guard = encodedFrames * (maxTokens + 2) + 128;

    try {
      while (frame < encodedFrames) {
        if (options.signal?.aborted) throw abortError();
        iterations += 1;
        if (iterations > guard) {
          throw new AppError('The decoder did not make progress.', {
            code: 'DECODE_STALLED',
            hint: 'Try a shorter recording or the Compact preset.',
          });
        }

        const frameTensor = new ort.Tensor(
          'float32',
          encoded.data.subarray(frame * encoded.hidden, (frame + 1) * encoded.hidden),
          [1, encoded.hidden, 1],
        );
        const targetTensor = new ort.Tensor(
          'int32',
          Int32Array.of(lastToken),
          [1, 1],
        );
        const targetLengthTensor = new ort.Tensor(
          'int32',
          Int32Array.of(1),
          [1],
        );

        const decoderOutputs = await decoder.run({
          [names.decoderEncoder]: frameTensor,
          [names.decoderTargets]: targetTensor,
          [names.decoderTargetLength]: targetLengthTensor,
          [names.decoderState1]: state1,
          [names.decoderState2]: state2,
        });
        disposeTensor(frameTensor);
        disposeTensor(targetTensor);
        disposeTensor(targetLengthTensor);

        const logitsTensor = decoderOutputs[names.decoderOut];
        if (!logitsTensor || !(logitsTensor.data instanceof Float32Array)) {
          throw new AppError('The decoder did not return float32 logits.', {
            code: 'DECODER_OUTPUT_MISSING',
            hint: `Returned tensors: ${Object.keys(decoderOutputs).join(', ') || '(none)'}.`,
          });
        }

        const logits = logitsTensor.data;
        const durationBins = logits.length - tokenizer.size;

        if (durationBins <= 0) {
          throw new AppError('This export does not include TDT duration logits.', {
            code: 'NOT_TDT',
            hint: 'This app implements the FastConformer-TDT export. A CTC or seq2seq export needs a different decoder.',
          });
        }

        const token = argmax(logits, 0, tokenizer.size);
        // The argmax over the duration logits is an absolute index (8193..8197);
        // the frame advance is the index within those five bins.
        const step = argmax(logits, tokenizer.size, logits.length) - tokenizer.size;

        if (token !== blankId) {
          tokenIds.push(token);
          tokenFrames.push(frame);
          lastToken = token;
          emitted += 1;

          const partialNow = performance.now();
          if (options.onPartial && partialNow - lastPartialTime >= 80) {
            lastPartialTime = partialNow;
            options.onPartial(tokenizer.decode(tokenIds));
          }

          const nextState1 = decoderOutputs[names.decoderState1Out];
          const nextState2 = decoderOutputs[names.decoderState2Out];

          if (!nextState1 || !nextState2) {
            throw new AppError('The decoder did not return its recurrent state.', {
              code: 'DECODER_STATE_MISSING',
              hint: 'This export is incompatible with the TDT decoder in src/model.ts.',
            });
          }

          // The recurrent states live into the next iteration; everything else
          // (including the previous states and the logits) can be released now.
          const oldState1 = state1;
          const oldState2 = state2;
          state1 = nextState1;
          state2 = nextState2;
          disposeTensor(oldState1);
          disposeTensor(oldState2);
        }

        for (const tensor of Object.values(decoderOutputs)) {
          if (tensor === state1 || tensor === state2) continue;
          disposeTensor(tensor);
        }

        if (step > 0) {
          frame += step;
          emitted = 0;
        } else if (token === blankId || emitted >= maxTokens) {
          frame += 1;
          emitted = 0;
        }

        const now = performance.now();
        if (
          options.onProgress &&
          (frame - lastReportedFrame >= 8 || now - lastReportTime >= 60)
        ) {
          options.onProgress({ framesDone: Math.min(frame, encodedFrames), framesTotal: encodedFrames });
          lastReportedFrame = frame;
          lastReportTime = now;
        }
      }

      options.onProgress?.({ framesDone: encodedFrames, framesTotal: encodedFrames });
      options.onPartial?.(tokenizer.decode(tokenIds));
    } finally {
      disposeTensor(state1);
      disposeTensor(state2);
      disposeTensor(encoderTensor);
      disposeTensor(encodedLengthTensor);
    }

    return {
      text: tokenizer.decode(tokenIds),
      tokenCount: tokenIds.length,
      frames: encodedFrames,
      // Each encoder frame is 8 mel frames of 10 ms.
      words: tokenizer.wordTimings(tokenIds, tokenFrames, TDT_FRAME_SECONDS, encodedFrames),
    };
  }

  private async transcribeOmnilingual(
    samples: Float32Array,
    options: TranscribeOptions,
  ): Promise<TranscriptionResult> {
    const ort = this.ort;
    const session = this.omnilingualSession;
    const tokens = this.omnilingualTokens;

    if (!ort || !session || !tokens) {
      throw new AppError('The model is not loaded yet.', {
        code: 'MODEL_NOT_READY',
        hint: 'Load the model first, then try again.',
      });
    }

    if (options.signal?.aborted) throw abortError();
    await yieldToUi();

    const input = new ort.Tensor('float32', samples, [1, samples.length]);
    options.onProgress?.({ framesDone: 1, framesTotal: 4 });

    try {
      const outputs = await session.run({ x: input });
      const logits = outputs.logits;

      if (
        !logits ||
        !(logits.data instanceof Float32Array) ||
        logits.dims.length !== 3
      ) {
        throw new AppError('The Omnilingual model did not return CTC logits.', {
          code: 'DECODER_OUTPUT_MISSING',
          hint: `Returned tensors: ${Object.keys(outputs).join(', ') || '(none)'}.`,
        });
      }

      if (options.signal?.aborted) throw abortError();
      options.onProgress?.({ framesDone: 4, framesTotal: 4 });

      const decoded = decodeOmnilingualLogits(
        logits.data,
        Number(logits.dims[1]),
        Number(logits.dims[2]),
        tokens,
      );
      const frames = Number(logits.dims[1]);
      disposeTensor(logits);
      options.onPartial?.(decoded.text);

      return {
        text: decoded.text,
        tokenCount: decoded.tokenCount,
        frames,
      };
    } finally {
      disposeTensor(input);
    }
  }

  /** Whistle runs synchronously in WebAssembly inside the ASR worker. */
  private async transcribeCactus(
    samples: Float32Array,
    options: TranscribeOptions,
  ): Promise<TranscriptionResult> {
    const engine = this.cactus;
    if (!engine) {
      throw new AppError('The model is not loaded yet.', {
        code: 'MODEL_NOT_READY',
        hint: 'Load the model first, then try again.',
      });
    }
    if (options.signal?.aborted) throw abortError();
    options.onProgress?.({ framesDone: 1, framesTotal: 4 });
    await yieldToUi();
    const result = engine.transcribe(samples, WHISTLE_LANGUAGES[this.language] || undefined);
    if (options.signal?.aborted) throw abortError();
    options.onProgress?.({ framesDone: 4, framesTotal: 4 });
    options.onPartial?.(result.text);
    return {
      text: result.text,
      tokenCount: result.words.length,
      frames: Math.round(samples.length / 160),
      words: result.words,
    };
  }

  private async transcribeWithTransformers(
    samples: Float32Array,
    options: TranscribeOptions,
  ): Promise<TranscriptionResult> {
    const engine = this.transformersAsr;
    if (!engine?.isLoaded) {
      throw new AppError('The model is not loaded yet.', {
        code: 'MODEL_NOT_READY',
        hint: 'Load the model first, then try again.',
      });
    }

    if (options.signal?.aborted) throw abortError();
    await yieldToUi();
    options.onProgress?.({ framesDone: 1, framesTotal: 4 });

    const result = await engine.transcribe(samples);

    if (options.signal?.aborted) throw abortError();
    options.onProgress?.({ framesDone: 4, framesTotal: 4 });
    options.onPartial?.(result.text);

    return result;
  }

  /**
   * Granite Speech is driven by Transformers.js. Its generate() call is not
   * streamed, so progress is shown as an indeterminate final step.
   */
  private async transcribeGranite(
    samples: Float32Array,
    options: TranscribeOptions,
  ): Promise<TranscriptionResult> {
    const engine = this.granite;

    if (!engine?.isLoaded) {
      throw new AppError('The model is not loaded yet.', {
        code: 'MODEL_NOT_READY',
        hint: 'Load the model first, then try again.',
      });
    }

    if (options.signal?.aborted) throw abortError();
    await yieldToUi();

    options.onProgress?.({ framesDone: 1, framesTotal: 10 });
    const result = await engine.transcribe(samples);

    if (options.signal?.aborted) throw abortError();
    options.onProgress?.({ framesDone: 10, framesTotal: 10 });
    options.onPartial?.(result.text);

    return {
      text: result.text,
      tokenCount: result.tokenCount,
      frames: result.frames,
    };
  }

  /**
   * Qwen3-ASR: Whisper log-mel → conv frontend → masked encoder → prompt with
   * audio placeholders → decoder with a per-layer KV cache. The decoder emits
   * key/value deltas, which are copied into the preallocated caches after each
   * run. The cache tensors must be passed at their full `max_total_len`; the
   * export rejects shorter slices even though the dimension is symbolic.
   */
  private async transcribeQwen(
    samples: Float32Array,
    options: TranscribeOptions,
  ): Promise<TranscriptionResult> {
    const ort = this.ort;
    const conv = this.convFrontend;
    const encoder = this.encoder;
    const decoder = this.decoder;
    const tokenizer = this.qwenTokenizer;
    const names = this.qwenNames;

    if (!ort || !conv || !encoder || !decoder || !tokenizer || !names) {
      throw new AppError('The model is not loaded yet.', {
        code: 'MODEL_NOT_READY',
        hint: 'Load the model first, then try again.',
      });
    }

    if (options.signal?.aborted) throw abortError();
    await yieldToUi();

    const features = computeWhisperLogMel(samples);

    if (features.frames < 2) {
      return { text: '', tokenCount: 0, frames: 0 };
    }

    const convTensor = new ort.Tensor('float32', features.data, [
      1,
      features.frames,
      features.nMels,
    ]);
    const convOutputs = await conv.run({ [names.convFeatures]: convTensor });
    const convOutput = convOutputs[names.convOut];

    if (!convOutput || !(convOutput.data instanceof Float32Array)) {
      throw new AppError('The Qwen audio frontend did not return float32 features.', {
        code: 'FRONTEND_OUTPUT_MISSING',
        hint: `Returned tensors: ${Object.keys(convOutputs).join(', ') || '(none)'}.`,
      });
    }

    const convDims = convOutput.dims;
    if (convDims.length !== 3) {
      disposeTensor(convOutput);
      throw new AppError('The Qwen audio frontend returned an unexpected shape.', {
        code: 'FRONTEND_SHAPE',
        hint: `Expected [1, frames, hidden], received [${convDims.join(', ')}].`,
      });
    }

    const convFrames = Number(convDims[1]);
    const audioTokens = Math.min(
      qwenAudioTokenLength(features.frames),
      convFrames,
    );

    if (convFrames <= 0 || audioTokens <= 0) {
      disposeTensor(convOutput);
      return { text: '', tokenCount: 0, frames: 0 };
    }

    const mask = new Uint8Array(convFrames);
    mask.fill(1, 0, audioTokens);
    const encoderOutputs = await encoder.run({
      [names.encoderFeatures]: convOutput,
      [names.encoderMask]: new ort.Tensor('bool', mask, [1, convFrames]),
    });
    disposeTensor(convOutput);

    const audioTensor = encoderOutputs[names.encoderOut];
    if (!audioTensor || !(audioTensor.data instanceof Float32Array)) {
      throw new AppError('The Qwen encoder did not return float32 audio features.', {
        code: 'ENCODER_OUTPUT_MISSING',
        hint: `Returned tensors: ${Object.keys(encoderOutputs).join(', ') || '(none)'}.`,
      });
    }

    const audioDims = audioTensor.dims;
    if (audioDims.length !== 3) {
      disposeTensor(audioTensor);
      throw new AppError('The Qwen encoder returned an unexpected shape.', {
        code: 'ENCODER_SHAPE',
        hint: `Expected [1, tokens, hidden], received [${audioDims.join(', ')}].`,
      });
    }

    const encodedTokens = Number(audioDims[1]);
    const audioHidden = Number(audioDims[2]);

    if (encodedTokens < audioTokens || audioHidden <= 0) {
      disposeTensor(audioTensor);
      throw new AppError('The Qwen encoder returned too few audio features.', {
        code: 'ENCODER_LENGTH',
        hint: `Needed ${audioTokens} tokens, received ${encodedTokens}.`,
      });
    }

    const audioData = (audioTensor.data as Float32Array).subarray(
      0,
      audioTokens * audioHidden,
    );

    const before = tokenizer.encode(
      '<|im_start|>system\n<|im_end|>\n<|im_start|>user\n<|audio_start|>',
    );
    let after = tokenizer.encode(
      '<|audio_end|><|im_end|>\n<|im_start|>assistant\n',
    );
    if (this.language) {
      after = [
        ...after,
        ...tokenizer.encode(`language ${this.language}`),
        tokenizer.asrTextId,
      ];
    }
    const source = [
      ...before,
      ...new Array<number>(audioTokens).fill(tokenizer.audioPadId),
      ...after,
    ];
    const contextLength = source.length;

    // The decoder receives the full KV cache on every token, and ORT copies
    // that cache into WASM each step. Keep the reserve proportional to speech
    // (roughly 4-5 text tokens per second) instead of the much higher audio
    // token rate; the EOS token normally stops generation well before this.
    const maxNewTokens = Math.min(
      512,
      Math.max(48, Math.ceil(audioTokens * 0.5) + 16),
    );

    const metadata = inputMetadata(decoder);
    const keyMetadata = metadata?.find(
      (entry) => entry.name === names.cacheKeyInputs[0],
    );
    const keyDims = keyMetadata?.dimensions;

    if (!keyDims || keyDims.length < 4) {
      console.info(
        '[LocalScribe] qwen decoder metadata ' +
          JSON.stringify(metadata?.slice(0, 6)),
      );
      disposeTensor(audioTensor);
      throw new AppError('The Qwen decoder KV-cache shape is not recognized.', {
        code: 'TENSOR_MISMATCH',
        hint: 'Re-download the model or check the export revision.',
      });
    }

    const kvHeads = typeof keyDims[2] === 'number' ? keyDims[2] : 8;
    const headDim = typeof keyDims[3] === 'number' ? keyDims[3] : 128;
    const staticMax =
      typeof keyDims[1] === 'number' && keyDims[1] > 0 ? keyDims[1] : null;
    const maxTotalLen = staticMax
      ? Math.min(staticMax, contextLength + maxNewTokens + 4)
      : contextLength + maxNewTokens + 4;

    if (maxTotalLen <= contextLength) {
      disposeTensor(audioTensor);
      throw new AppError('The Qwen decoder KV cache is too small for this audio.', {
        code: 'CONTEXT_TOO_LONG',
        hint: 'Try a shorter recording or split the file into smaller parts.',
      });
    }

    const kvType = keyMetadata?.type === 'float16' ? 'float16' : 'float32';
    const CacheArray = kvType === 'float16' ? Uint16Array : Float32Array;
    const cacheElements = maxTotalLen * kvHeads * headDim;
    const caches = names.cacheKeyInputs.map(() => ({
      key: new CacheArray(cacheElements),
      value: new CacheArray(cacheElements),
    }));
    const keyTensors = caches.map(
      (entry) =>
        new ort.Tensor(kvType, entry.key, [1, maxTotalLen, kvHeads, headDim]),
    );
    const valueTensors = caches.map(
      (entry) =>
        new ort.Tensor(kvType, entry.value, [1, maxTotalLen, kvHeads, headDim]),
    );

    const sourceIds = new BigInt64Array(contextLength);
    for (let index = 0; index < contextLength; index += 1) {
      sourceIds[index] = BigInt(source[index]);
    }

    const sourceMask = new BigInt64Array(contextLength);
    sourceMask.fill(1n);
    const sourcePositions = new BigInt64Array(contextLength);
    for (let index = 0; index < contextLength; index += 1) {
      sourcePositions[index] = BigInt(index);
    }

    const audioFeaturesTensor = new ort.Tensor('float32', audioData, [
      1,
      audioTokens,
      audioHidden,
    ]);

    const feeds: Record<string, OrtTensor> = {
      [names.inputIds]: new ort.Tensor('int64', sourceIds, [1, contextLength]),
      [names.audioFeatures]: audioFeaturesTensor,
      [names.attentionMask]: new ort.Tensor(
        'int64',
        sourceMask,
        [1, contextLength],
      ),
      [names.cachePosition]: new ort.Tensor('int64', sourcePositions, [
        contextLength,
      ]),
    };

    for (let layer = 0; layer < caches.length; layer += 1) {
      feeds[names.cacheKeyInputs[layer]] = keyTensors[layer];
      feeds[names.cacheValueInputs[layer]] = valueTensors[layer];
    }

    const copyDeltas = (
      outputs: Record<string, OrtTensor>,
      position: number,
      length: number,
    ): void => {
      const perPosition = kvHeads * headDim;

      for (let layer = 0; layer < caches.length; layer += 1) {
        const key = outputs[names.keyDeltas[layer]];
        const value = outputs[names.valueDeltas[layer]];

        if (!key || !value) {
          throw new AppError('The Qwen decoder did not return its KV deltas.', {
            code: 'DECODER_OUTPUT_MISSING',
            hint: `Returned tensors: ${Object.keys(outputs).join(', ') || '(none)'}.`,
          });
        }

        const keyData = key.data as Float32Array | Uint16Array;
        const valueData = value.data as Float32Array | Uint16Array;
        caches[layer].key.set(
          keyData.subarray(0, length * perPosition),
          position * perPosition,
        );
        caches[layer].value.set(
          valueData.subarray(0, length * perPosition),
          position * perPosition,
        );

        disposeTensor(key);
        disposeTensor(value);
      }
    };

    const generated: number[] = [];
    let currentLength = contextLength;
    let nextToken = -1;

    const prefill = await decoder.run(feeds);
    const prefillLogits = prefill[names.logits];

    if (!prefillLogits || !(prefillLogits.data instanceof Float32Array)) {
      throw new AppError('The Qwen decoder did not return float32 logits.', {
        code: 'DECODER_OUTPUT_MISSING',
        hint: `Returned tensors: ${Object.keys(prefill).join(', ') || '(none)'}.`,
      });
    }

    const vocabulary = Number(prefillLogits.dims[2]);
    if (vocabulary <= tokenizer.audioPadId) {
      throw new AppError('The Qwen decoder vocabulary is not recognized.', {
        code: 'VOCAB_SIZE',
        hint: `The decoder returned ${vocabulary} logits per token.`,
      });
    }

    const lastOffset = (contextLength - 1) * vocabulary;
    nextToken =
      argmax(prefillLogits.data, lastOffset, lastOffset + vocabulary) -
      lastOffset;
    disposeTensor(prefillLogits);
    copyDeltas(prefill, 0, contextLength);

    const progressTotal = Math.max(
      8,
      Math.min(maxNewTokens, Math.ceil(audioTokens * 0.3) + 8),
    );
    let lastReportTime = 0;
    let lastPartialTime = 0;

    try {
      while (generated.length < maxNewTokens) {
        if (options.signal?.aborted) throw abortError();

        if (nextToken === tokenizer.eosId) break;

        generated.push(nextToken);

        options.onProgress?.({
          framesDone: Math.min(generated.length, progressTotal),
          framesTotal: progressTotal,
        });

        const partialNow = performance.now();
        if (options.onPartial && partialNow - lastPartialTime >= 80) {
          lastPartialTime = partialNow;
          options.onPartial(cleanQwenTranscript(tokenizer.decode(generated)));
        }

        if (currentLength >= maxTotalLen || generated.length >= maxNewTokens) {
          break;
        }

        const stepIds = BigInt64Array.of(BigInt(nextToken));
        const stepMask = BigInt64Array.of(1n);
        const stepPosition = BigInt64Array.of(BigInt(currentLength));
        const stepFeeds: Record<string, OrtTensor> = {
          [names.inputIds]: new ort.Tensor('int64', stepIds, [1, 1]),
          [names.audioFeatures]: audioFeaturesTensor,
          [names.attentionMask]: new ort.Tensor('int64', stepMask, [1, 1]),
          [names.cachePosition]: new ort.Tensor('int64', stepPosition, [1]),
        };

        for (let layer = 0; layer < caches.length; layer += 1) {
          stepFeeds[names.cacheKeyInputs[layer]] = keyTensors[layer];
          stepFeeds[names.cacheValueInputs[layer]] = valueTensors[layer];
        }

        const step = await decoder.run(stepFeeds);
        const logits = step[names.logits];

        if (!logits || !(logits.data instanceof Float32Array)) {
          throw new AppError('The Qwen decoder stopped returning logits.', {
            code: 'DECODER_OUTPUT_MISSING',
            hint: `Returned tensors: ${Object.keys(step).join(', ') || '(none)'}.`,
          });
        }

        const offset = (Number(logits.dims[1]) - 1) * vocabulary;
        nextToken =
          argmax(logits.data, offset, offset + vocabulary) - offset;
        disposeTensor(logits);
        copyDeltas(step, currentLength, 1);
        currentLength += 1;

        const now = performance.now();
        if (now - lastReportTime >= 80) {
          lastReportTime = now;
          await yieldToUi();
        }
      }

      options.onProgress?.({
        framesDone: progressTotal,
        framesTotal: progressTotal,
      });
      options.onPartial?.(cleanQwenTranscript(tokenizer.decode(generated)));

      return {
        text: cleanQwenTranscript(tokenizer.decode(generated)),
        tokenCount: generated.length,
        frames: audioTokens,
      };
    } finally {
      disposeTensor(audioFeaturesTensor);
    }
  }

  /**
   * Fluid Speech Mini uses a split frontend/encoder/decoder/joint graph. The
   * conv frontend is run in time chunks (as in the model's reference
   * transcribe.py) to keep activations bounded.
   */
  private async transcribeMini(
    samples: Float32Array,
    options: TranscribeOptions,
  ): Promise<TranscriptionResult> {
    const ort = this.ort;
    const frontend = this.frontend;
    const encoder = this.encoder;
    const decoder = this.decoder;
    const joint = this.joint;
    const tokenizer = this.tokenizer;
    const names = this.miniNames;

    if (!ort || !frontend || !encoder || !decoder || !joint || !tokenizer || !names) {
      throw new AppError('The model is not loaded yet.', {
        code: 'MODEL_NOT_READY',
        hint: 'Load the model first, then try again.',
      });
    }

    if (options.signal?.aborted) throw abortError();
    await yieldToUi();

    const padded = samples.length < 160 ? padSamples(samples, 160) : samples;
    const features = computeNemoLogMel(padded, {
      nMels: this.config.numMelBins,
      sampleRate: this.config.samplingRate,
      nFft: this.config.nFft,
      winLength: this.config.winLength,
      hopLength: this.config.hopLength,
      preemphasis: this.config.preemphasis,
      trailingFrame: true,
      layout: 'time-first',
    });

    if (features.validFrames <= 0) {
      return { text: '', tokenCount: 0, frames: 0 };
    }

    const frames = features.frames;
    const nMels = features.nMels;
    const mask = new BigInt64Array(frames);
    mask.fill(1n, 0, features.validFrames);

    const validEncoderFrames = this.subsampled(features.validFrames);
    const total = this.subsampled(frames);
    const factor = this.config.subsamplingStride ** this.config.subsamplingLayers;
    const chunkFrames = this.config.frontendChunkFrames;
    const encoderHidden = this.config.encoderHidden;
    const hiddenStates = new Float32Array(total * encoderHidden);

    for (let a = 0; a < total; a += chunkFrames) {
      if (options.signal?.aborted) throw abortError();

      const b = Math.min(a + chunkFrames, total);
      const count = b - a;
      const start = a ? factor * (a - 1) : 0;
      const end = Math.min(frames, factor * (b + 1));
      const skip = a ? 1 : 0;
      const featureSlice = features.data.subarray(start * nMels, end * nMels);
      const frontendData = this.frontendTimeFirst
        ? featureSlice
        : transposeEncoder(featureSlice, end - start, nMels);
      const frontendTensor = new ort.Tensor(
        'float32',
        frontendData,
        this.frontendTimeFirst
          ? [1, end - start, nMels]
          : [1, nMels, end - start],
      );
      const maskTensor = new ort.Tensor('int64', mask.slice(start, end), [1, end - start]);
      const frontendOutputs = await frontend.run({
        [names.frontendFeatures]: frontendTensor,
        [names.frontendMask]: maskTensor,
      });
      const frontendTensorOut = frontendOutputs[names.frontendOut];

      if (!frontendTensorOut || !(frontendTensorOut.data instanceof Float32Array)) {
        throw new AppError('The audio frontend did not return float32 features.', {
          code: 'FRONTEND_OUTPUT_MISSING',
          hint: `Returned tensors: ${Object.keys(frontendOutputs).join(', ') || '(none)'}.`,
        });
      }

      const yDims = frontendTensorOut.dims;
      if (yDims.length < 2) {
        throw new AppError('The audio frontend returned an unexpected shape.', {
          code: 'FRONTEND_SHAPE',
          hint: `Expected [1, frames, hidden] or [1, hidden, frames], received [${yDims.join(', ')}].`,
        });
      }

      const timeFirst = yDims[yDims.length - 1] === encoderHidden;
      const outHidden = timeFirst
        ? yDims[yDims.length - 1]
        : yDims[yDims.length - 2];
      const timeDim = timeFirst
        ? yDims[yDims.length - 2]
        : yDims[yDims.length - 1];

      if (outHidden !== encoderHidden) {
        throw new AppError('The audio frontend hidden size does not match the encoder.', {
          code: 'FRONTEND_HIDDEN_MISMATCH',
          hint: `Frontend outputs ${outHidden}, encoder expects ${encoderHidden}.`,
        });
      }

      const yData = frontendTensorOut.data;

      for (let i = 0; i < count; i += 1) {
        const sourceFrame = Math.min(skip + i, Math.max(0, timeDim - 1));
        const destination = (a + i) * encoderHidden;

        if (timeFirst) {
          hiddenStates.set(
            yData.subarray(sourceFrame * encoderHidden, (sourceFrame + 1) * encoderHidden),
            destination,
          );
        } else {
          for (let hidden = 0; hidden < encoderHidden; hidden += 1) {
            hiddenStates[destination + hidden] =
              yData[hidden * timeDim + sourceFrame];
          }
        }
      }
    }

    const encoderData = this.encoderTimeFirst
      ? hiddenStates
      : transposeEncoder(hiddenStates, total, encoderHidden);
    const encoderTensor = new ort.Tensor(
      'float32',
      encoderData,
      this.encoderTimeFirst
        ? [1, total, encoderHidden]
        : [1, encoderHidden, total],
    );
    const lengthTensor = this.makeLengthTensor(ort, validEncoderFrames);
    const encoderOutputs = await encoder.run({
      [names.encoderHidden]: encoderTensor,
      [names.encoderLength]: lengthTensor,
    });
    const encoderTensorOut = encoderOutputs[names.encoderOut];

    if (!encoderTensorOut || !(encoderTensorOut.data instanceof Float32Array)) {
      throw new AppError('The encoder did not return float32 embeddings.', {
        code: 'ENCODER_OUTPUT_MISSING',
        hint: `Returned tensors: ${Object.keys(encoderOutputs).join(', ') || '(none)'}.`,
      });
    }

    const encoded = this.readEncoderOutput(encoderTensorOut);
    const encodedFrames = Math.min(encoded.frames, validEncoderFrames);

    if (encodedFrames <= 0) {
      disposeTensor(encoderTensorOut);
      return { text: '', tokenCount: 0, frames: 0 };
    }

    let state1: OrtTensor = new ort.Tensor(
      'float32',
      new Float32Array(product(this.stateDims[0])),
      this.stateDims[0],
    );
    let state2: OrtTensor = new ort.Tensor(
      'float32',
      new Float32Array(product(this.stateDims[1])),
      this.stateDims[1],
    );
    let decoderState1: OrtTensor = state1;
    let decoderState2: OrtTensor = state2;

    const firstDecode = await decoder.run({
      [names.decoderToken]: this.makeMiniTokenTensor(ort, this.config.blankTokenId),
      [names.decoderH]: decoderState1,
      [names.decoderC]: decoderState2,
    });
    let decoderOut = firstDecode[names.decoderOut];
    decoderState1 = firstDecode[names.decoderHOut];
    decoderState2 = firstDecode[names.decoderCOut];

    if (!decoderOut || !decoderState1 || !decoderState2) {
      disposeTensor(encoderTensorOut);
      throw new AppError('The Mini decoder did not return its expected tensors.', {
        code: 'DECODER_OUTPUT_MISSING',
        hint: `Returned tensors: ${Object.keys(firstDecode).join(', ') || '(none)'}.`,
      });
    }

    const tokenIds: number[] = [];
    const miniFrames: number[] = [];
    const maxTokens = this.config.maxTokensPerStep;
    const budget = Math.max(1, encodedFrames * maxTokens - 1);
    const guard = encodedFrames * (maxTokens + 2) + 128;
    let frame = 0;
    let iterations = 0;
    let lastReportedFrame = -1;
    let lastReportTime = 0;
    let lastPartialTime = 0;

    try {
      while (frame < encodedFrames) {
        if (options.signal?.aborted) throw abortError();
        iterations += 1;
        if (iterations > guard) {
          throw new AppError('The decoder did not make progress.', {
            code: 'DECODE_STALLED',
            hint: 'Try a shorter recording.',
          });
        }

        const frameData = encoded.data.slice(
          frame * encoded.hidden,
          (frame + 1) * encoded.hidden,
        );
        const frameDims =
          product(this.jointEncoderDims) === encoded.hidden
            ? this.jointEncoderDims
            : [1, encoded.hidden];
        const frameTensor = new ort.Tensor('float32', frameData, frameDims);

        const decoderOutData = decoderOut.data as Float32Array;
        const decoderDims =
          this.jointDecoderDims &&
          product(this.jointDecoderDims) === decoderOutData.length
            ? this.jointDecoderDims
            : decoderOut.dims;
        const decoderTensor =
          decoderOut.dims.join(',') === decoderDims.join(',')
            ? decoderOut
            : new ort.Tensor('float32', decoderOutData, decoderDims);

        const jointOutputs = await joint.run({
          [names.jointEncoder]: frameTensor,
          [names.jointDecoder]: decoderTensor,
        });
        disposeTensor(frameTensor);
        if (decoderTensor !== decoderOut) disposeTensor(decoderTensor);
        const logitsTensor = jointOutputs[names.jointOut];

        if (!logitsTensor || !(logitsTensor.data instanceof Float32Array)) {
          throw new AppError('The joint network did not return float32 logits.', {
            code: 'DECODER_OUTPUT_MISSING',
            hint: `Returned tensors: ${Object.keys(jointOutputs).join(', ') || '(none)'}.`,
          });
        }

        const logits = logitsTensor.data;
        const vocabulary = tokenizer.size;

        if (logits.length <= vocabulary) {
          throw new AppError('This Mini export does not include duration logits.', {
            code: 'NOT_TDT',
            hint: 'Use the Fluid Speech Mini ONNX export from the catalog revision.',
          });
        }

        const token = argmax(logits, 0, vocabulary);
        const durationBin = argmax(logits, vocabulary, logits.length) - vocabulary;
        const step = this.config.durations[durationBin] ?? 0;
        const advance =
          token === this.config.blankTokenId && step === 0 ? 1 : step;

        for (const tensor of Object.values(jointOutputs)) disposeTensor(tensor);

        tokenIds.push(token);
        miniFrames.push(frame);
        frame += advance;

        const partialNow = performance.now();
        if (options.onPartial && partialNow - lastPartialTime >= 80) {
          lastPartialTime = partialNow;
          options.onPartial(tokenizer.decode(tokenIds));
        }

        if (
          frame >= encodedFrames ||
          tokenIds.length >= budget ||
          token === this.config.eosTokenId
        ) {
          break;
        }

        if (token !== this.config.blankTokenId) {
          const tokenTensor = this.makeMiniTokenTensor(ort, token);
          const oldOut = decoderOut;
          const oldState1 = decoderState1;
          const oldState2 = decoderState2;
          const next = await decoder.run({
            [names.decoderToken]: tokenTensor,
            [names.decoderH]: decoderState1,
            [names.decoderC]: decoderState2,
          });
          decoderOut = next[names.decoderOut];
          decoderState1 = next[names.decoderHOut];
          decoderState2 = next[names.decoderCOut];

          if (!decoderOut || !decoderState1 || !decoderState2) {
            throw new AppError('The Mini decoder lost its recurrent state.', {
              code: 'DECODER_STATE_MISSING',
              hint: 'Re-download the model or check the export revision.',
            });
          }

          disposeTensor(tokenTensor);
          disposeTensor(oldOut);
          disposeTensor(oldState1);
          disposeTensor(oldState2);
          for (const tensor of Object.values(next)) {
            if (tensor === decoderOut || tensor === decoderState1 || tensor === decoderState2) continue;
            disposeTensor(tensor);
          }
        }

        const now = performance.now();
        if (
          options.onProgress &&
          (frame - lastReportedFrame >= 8 || now - lastReportTime >= 60)
        ) {
          options.onProgress({
            framesDone: Math.min(frame, encodedFrames),
            framesTotal: encodedFrames,
          });
          lastReportedFrame = frame;
          lastReportTime = now;
        }
      }

      options.onProgress?.({ framesDone: encodedFrames, framesTotal: encodedFrames });
      options.onPartial?.(tokenizer.decode(tokenIds));
    } finally {
      disposeTensor(decoderOut);
      disposeTensor(decoderState1);
      disposeTensor(decoderState2);
      disposeTensor(state1);
      disposeTensor(state2);
      disposeTensor(encoderTensorOut);
    }

    return {
      text: tokenizer.decode(tokenIds),
      tokenCount: tokenIds.length,
      frames: encodedFrames,
      words: tokenizer.wordTimings(tokenIds, miniFrames, TDT_FRAME_SECONDS, encodedFrames),
    };
  }

  private subsampled(frames: number): number {
    const { subsamplingKernel, subsamplingStride, subsamplingLayers } = this.config;
    const padding = ((subsamplingKernel - 1) >> 1) * 2 - subsamplingKernel;
    let value = frames;

    for (let layer = 0; layer < subsamplingLayers; layer += 1) {
      value = Math.floor((value + padding) / subsamplingStride + 1);
    }

    return value;
  }

  private makeMiniTokenTensor(ort: OrtModule, token: number): OrtTensor {
    if (this.miniTokenDtype === 'int32') {
      return new ort.Tensor('int32', Int32Array.of(token), [1, 1]);
    }
    return new ort.Tensor('int64', BigInt64Array.of(BigInt(token)), [1, 1]);
  }

  private async doLoad(signal?: AbortSignal): Promise<void> {
    this.emit({ phase: 'storage', message: 'Preparing local storage…' });

    if (signal?.aborted) throw abortError();

    try {
      if (this.model.pipeline === 'granite-speech') {
        await this.loadGranite(signal);

        if (this.disposed) throw abortError('Model loading was cancelled.');
        this.emit({ phase: 'ready', message: 'Model ready.' });
        return;
      }

      if (this.model.pipeline === 'moonshine' || this.model.pipeline === 'whisper') {
        await this.loadTransformersAsr(signal);

        if (this.disposed) throw abortError('Model loading was cancelled.');
        this.emit({ phase: 'ready', message: 'Model ready.' });
        return;
      }

      const specs = resolveModelFiles(this.modelId, this.variantId, this.clean);

      // A single file above ~2 GB cannot be allocated as a contiguous buffer
      // in Chromium, and ONNX Runtime's external-data path needs one buffer per
      // file. Fail before downloading 2.6 GB that cannot be loaded.
      const oversizedFile = specs.find((spec) => spec.size >= 2_000_000_000);
      if (oversizedFile) {
        throw new AppError(
          `The ${oversizedFile.name} file is ${Math.round(oversizedFile.size / 1_000_000)} MB. Chromium cannot allocate a single buffer this large in a tab.`,
          {
            code: 'MODEL_FILE_TOO_LARGE',
            hint: 'Choose the Compact variant. Full precision needs a runtime that can memory-map the external weights.',
          },
        );
      }

      const ortPromise = getOrt(this.useWebGPU ? 'webgpu' : 'wasm');
      // If the download fails before we await this, the import must not surface
      // as an unhandled rejection.
      void ortPromise.catch(() => undefined);

      const totalBytes = specs.reduce((sum, spec) => sum + spec.size, 0);
      const blobs = new Map<ModelFileRole, ModelData>();
      const rateMeter = new DownloadRateMeter();
      let loadedBytes = 0;
      let networkLoadedBytes = 0;

      for (const spec of specs) {
        if (signal?.aborted) throw abortError();
        if (this.disposed) throw abortError('Model loading was cancelled.');

        this.emit({
          phase: 'download',
          message: `Downloading ${spec.name}…`,
          download: {
            file: spec.name,
            fileLoaded: 0,
            fileTotal: spec.size,
            loaded: loadedBytes,
            total: totalBytes,
            networkLoaded: networkLoadedBytes,
            bytesPerSecond: null,
            etaSeconds: null,
          },
        });

        const file = await loadFile(
          spec,
          (fileLoaded, fileTotal, fileNetworkLoaded) => {
            const loaded = Math.min(totalBytes, loadedBytes + fileLoaded);
            const networkLoaded = networkLoadedBytes + fileNetworkLoaded;
            const bytesPerSecond = rateMeter.update(networkLoaded);
            const etaSeconds =
              bytesPerSecond && bytesPerSecond > 0
                ? Math.max(0, (totalBytes - loaded) / bytesPerSecond)
                : null;

            this.emit({
              phase: 'download',
              message: `Downloading ${spec.name}…`,
              download: {
                file: spec.name,
                fileLoaded,
                fileTotal,
                loaded,
                total: totalBytes,
                networkLoaded,
                bytesPerSecond,
                etaSeconds,
              },
            });
          },
          signal,
          this.memoryOnly,
        );

        blobs.set(spec.role, file.data);
        loadedBytes += file.size;
        networkLoadedBytes += file.networkLoaded;

        if (file.warning) this.recordWarning(file.warning);
      }

      if (signal?.aborted) throw abortError();
      if (this.disposed) throw abortError('Model loading was cancelled.');

      const ort = await ortPromise;
      this.ort = ort;

      this.emit({ phase: 'download', message: 'Model files ready.' });

      if (this.model.pipeline === 'cactus') {
        const script = blobs.get('cactusScript');
        const wasm = blobs.get('cactusWasm');
        const weights = blobs.get('cactusModel');
        if (!script || !wasm || !weights) {
          throw new AppError('The model download is incomplete.', {
            code: 'MODEL_FILES_MISSING',
            hint: 'Clear the cached model and try again.',
          });
        }
        this.emit({ phase: 'session', message: 'Starting the Cactus engine…' });
        this.cactus = await CactusModel.create(
          await modelDataToText(script),
          await modelDataToArrayBuffer(wasm),
          new Uint8Array(await modelDataToArrayBuffer(weights)),
        );
        this.backend = 'wasm';
        if (this.disposed) throw abortError('Model loading was cancelled.');
        this.emit({ phase: 'ready', message: 'Model ready.' });
        return;
      }

      if (this.model.pipeline === 'omnilingual') {
        await this.loadOmnilingualSession(ort, blobs, signal);

        if (this.disposed) throw abortError('Model loading was cancelled.');
        this.emit({ phase: 'ready', message: 'Model ready.' });
        return;
      }

      if (this.model.pipeline === 'qwen3-asr') {
        await this.loadQwenSessions(ort, blobs, signal);

        if (this.disposed) throw abortError('Model loading was cancelled.');
        this.emit({ phase: 'ready', message: 'Model ready.' });
        return;
      }

      const configBlob = blobs.get('config');
      const vocabBlob = blobs.get('vocab');
      const tokenizerBlob = blobs.get('tokenizer');

      if (!configBlob || (!vocabBlob && !tokenizerBlob)) {
        throw new AppError('The model download is incomplete.', {
          code: 'MODEL_FILES_MISSING',
          hint: 'Clear the cached model and try again.',
        });
      }

      this.config = resolveConfig(await modelDataToText(configBlob));

      if (tokenizerBlob) {
        this.tokenizer = VocabularyTokenizer.fromTokenizerJson(
          await modelDataToText(tokenizerBlob),
          {
            blankId: this.config.blankTokenId,
            padId: this.config.padTokenId,
          },
        );
      } else if (vocabBlob) {
        this.tokenizer = new VocabularyTokenizer(
          await modelDataToText(vocabBlob),
        );
      }

      const dataNameFor = (role: ModelFileRole): string | undefined =>
        specs.find((spec) => spec.role === role)?.name;

      if (this.model.pipeline === 'fluid-mini-tdt') {
        await this.loadMiniSessions(ort, blobs, dataNameFor, signal);
      } else {
        await this.loadFusedSessions(ort, blobs, dataNameFor, signal);
      }

      if (this.disposed) throw abortError('Model loading was cancelled.');

      this.emit({ phase: 'ready', message: 'Model ready.' });
    } catch (error) {
      await this.releaseSessions();

      if (isAbortError(error) || error instanceof AppError) throw error;

      const storageFailure = hasUnreadableStorageCause(error);
      if (!storageFailure) {
        console.error('[LocalScribe] model load failed', error);
      }

      const numericAbort = typeof error === 'number';
      const detail = numericAbort
        ? `ONNX Runtime aborted with code ${error}. Release builds of the WebAssembly runtime omit the underlying message.`
        : error instanceof Error
          ? error.message
          : String(error);

      throw new AppError('The model could not be loaded on this device.', {
        code: 'MODEL_LOAD_FAILED',
        cause: error,
        hint:
          (numericAbort
            ? 'This usually means the model exceeded the browser’s roughly 4 GB WebAssembly limit or used an operator this backend cannot run. Try the Compact variant or a smaller model. '
            : '') +
          `Underlying error: ${detail}${detail.endsWith('.') ? '' : '.'} ` +
          'If this repeats, close other tabs to free memory and use a recent desktop build of Chrome or Edge. A failed WebGPU attempt already falls back to CPU.',
      });
    }
  }

  private async loadTransformersAsr(signal?: AbortSignal): Promise<void> {
    const specs = resolveModelFiles(this.modelId, this.variantId, this.clean);
    const totalBytes = this.variant.approxBytes;
    const loadedByFile = new Map<string, number>();
    const meter = new DownloadRateMeter();
    let loadedBytes = 0;

    const onProgress = (event: SpeechProgressEvent): void => {
      if (event.status !== 'progress' && event.status !== 'done') return;

      const rawFile = event.file ?? event.name ?? 'model file';
      const spec = specs.find(
        (entry) => rawFile === entry.name || rawFile.endsWith(`/${entry.name}`),
      );
      const key = spec?.name ?? rawFile;
      const fileTotal = Number(event.total) || spec?.size || 0;
      const loaded =
        event.status === 'done'
          ? fileTotal
          : Math.min(Number(event.loaded) || 0, fileTotal || Infinity);
      const previous = loadedByFile.get(key) ?? 0;

      if (loaded <= previous) return;

      loadedByFile.set(key, loaded);
      loadedBytes += loaded - previous;

      const total = Math.max(totalBytes, loadedBytes);
      const bytesPerSecond = meter.update(loadedBytes);
      const etaSeconds =
        bytesPerSecond && bytesPerSecond > 0
          ? Math.max(0, (total - loadedBytes) / bytesPerSecond)
          : null;

      this.emit({
        phase: 'download',
        message: `Downloading ${spec?.name ?? rawFile}…`,
        download: {
          file: spec?.name ?? rawFile,
          fileLoaded: loaded,
          fileTotal: fileTotal || loaded,
          loaded: loadedBytes,
          total,
          networkLoaded: loadedBytes,
          bytesPerSecond,
          etaSeconds,
        },
      });
    };

    this.emit({ phase: 'storage', message: 'Preparing local storage…' });

    const engine = new TransformersAsrEngine({
      repo: this.model.repo,
      revision: this.model.revision,
      dtype: this.variant.id === 'fp32-q8'
        ? { encoder_model: 'fp32', decoder_model_merged: 'q8' }
        : this.variant.id === 'q8' ? 'q8' : 'fp32',
      timestamps: this.model.timestamps,
      language: this.language.toLowerCase() || undefined,
      memoryOnly: this.memoryOnly,
      onProgress,
    });

    this.transformersAsr = engine;

    if (signal?.aborted) throw abortError();

    this.emit({
      phase: 'session',
      message: `Loading ${this.model.name} with Transformers.js…`,
    });

    await engine.load();

    if (signal?.aborted) throw abortError();
    this.backend = engine.device;
  }

  private async loadGranite(signal?: AbortSignal): Promise<void> {
    if (!this.useWebGPU) {
      throw new AppError('Granite Speech requires WebGPU.', {
        code: 'WEBGPU_REQUIRED',
        hint:
          'Its 4-bit GatherBlockQuantized embedding has no CPU kernel. Use a WebGPU-capable Chrome or Edge, or choose Rumble-2-Flash, Qwen3-ASR, Fluid Speech, or Parakeet Redux.',
      });
    }

    const specs = resolveModelFiles(this.modelId, this.variantId, this.clean);
    const totalBytes = this.variant.approxBytes;
    const loadedByFile = new Map<string, number>();
    const meter = new DownloadRateMeter();
    let loadedBytes = 0;

    const onProgress = (event: GraniteProgressEvent): void => {
      if (event.status !== 'progress' && event.status !== 'done') return;

      const rawFile = event.file ?? event.name ?? 'model file';
      const spec = specs.find(
        (entry) => rawFile === entry.name || rawFile.endsWith(`/${entry.name}`),
      );
      const key = spec?.name ?? rawFile;
      const fileTotal = Number(event.total) || spec?.size || 0;
      const loaded =
        event.status === 'done'
          ? fileTotal
          : Math.min(Number(event.loaded) || 0, fileTotal || Infinity);
      const previous = loadedByFile.get(key) ?? 0;

      if (loaded <= previous) return;

      loadedByFile.set(key, loaded);
      loadedBytes += loaded - previous;

      const total = Math.max(totalBytes, loadedBytes);
      const bytesPerSecond = meter.update(loadedBytes);
      const etaSeconds =
        bytesPerSecond && bytesPerSecond > 0
          ? Math.max(0, (total - loadedBytes) / bytesPerSecond)
          : null;

      this.emit({
        phase: 'download',
        message: `Downloading ${spec?.name ?? rawFile}…`,
        download: {
          file: spec?.name ?? rawFile,
          fileLoaded: loaded,
          fileTotal: fileTotal || loaded,
          loaded: loadedBytes,
          total,
          networkLoaded: loadedBytes,
          bytesPerSecond,
          etaSeconds,
        },
      });
    };

    this.emit({ phase: 'storage', message: 'Preparing local storage…' });

    const engine = new GraniteEngine({
      repo: this.model.repo,
      revision: this.model.revision,
      useWebGPU: this.useWebGPU,
      memoryOnly: this.memoryOnly,
      onProgress,
      onWarning: (message) => this.recordWarning(message),
    });

    this.granite = engine;

    if (signal?.aborted) throw abortError();

    this.emit({
      phase: 'session',
      message: 'Loading Granite Speech with Transformers.js…',
    });

    await engine.load();

    if (signal?.aborted) throw abortError();
    this.backend = engine.device;
  }

  private async loadOmnilingualSession(
    ort: OrtModule,
    blobs: Map<ModelFileRole, ModelData>,
    signal?: AbortSignal,
  ): Promise<void> {
    const modelBlob = blobs.get('encoderGraph');
    const tokensBlob = blobs.get('vocab');

    if (!modelBlob || !tokensBlob) {
      throw new AppError('The model download is incomplete.', {
        code: 'MODEL_FILES_MISSING',
        hint: 'Clear the cached model and try again.',
      });
    }

    if (signal?.aborted) throw abortError();

    this.emit({
      phase: 'session',
      message: `Loading ${this.model.name} into ONNX Runtime…`,
    });

    const result = await createSession({
      ort,
      graph: await modelDataToArrayBuffer(modelBlob),
      label: this.model.name,
      preferWebGPU: false,
      onWarning: (message) => this.recordWarning(message),
    });
    this.omnilingualSession = result.session;
    this.backend = result.backend;
    this.omnilingualTokens = parseOmnilingualTokens(
      await modelDataToText(tokensBlob),
    );

    if (signal?.aborted) throw abortError();
  }

  private async loadQwenSessions(
    ort: OrtModule,
    blobs: Map<ModelFileRole, ModelData>,
    signal?: AbortSignal,
  ): Promise<void> {
    const convBlob = blobs.get('convFrontend');
    const encoderGraphBlob = blobs.get('encoderGraph');
    const decoderGraphBlob = blobs.get('decoderGraph');
    const vocabBlob = blobs.get('tokenizerVocab');
    const mergesBlob = blobs.get('tokenizerMerges');
    const tokenizerConfigBlob = blobs.get('tokenizerConfig');

    if (
      !convBlob ||
      !encoderGraphBlob ||
      !decoderGraphBlob ||
      !vocabBlob ||
      !mergesBlob ||
      !tokenizerConfigBlob
    ) {
      throw new AppError('The model download is incomplete.', {
        code: 'MODEL_FILES_MISSING',
        hint: 'Clear the cached model and try again.',
      });
    }

    this.emit({
      phase: 'session',
      message: `Loading the ${this.model.name} audio frontend…`,
    });

    const convResult = await createSession({
      ort,
      graph: await modelDataToArrayBuffer(convBlob),
      label: `${this.model.name} conv frontend`,
      preferWebGPU: this.useWebGPU,
      onWarning: (message) => this.recordWarning(message),
    });
    this.convFrontend = convResult.session;

    if (signal?.aborted) throw abortError();
    if (this.disposed) throw abortError('Model loading was cancelled.');

    this.emit({
      phase: 'session',
      message: `Loading the ${this.model.name} encoder into ONNX Runtime…`,
    });

    const encoderResult = await createSession({
      ort,
      graph: await modelDataToArrayBuffer(encoderGraphBlob),
      label: `${this.model.name} encoder`,
      preferWebGPU: this.useWebGPU,
      onWarning: (message) => this.recordWarning(message),
    });
    this.encoder = encoderResult.session;
    this.backend = encoderResult.backend;

    if (signal?.aborted) throw abortError();
    if (this.disposed) throw abortError('Model loading was cancelled.');

    this.emit({
      phase: 'session',
      message: `Loading the ${this.model.name} KV-cache decoder…`,
    });

    // The int8 decoder uses dynamic-quantized matmuls that are not a good fit
    // for WebGPU, and its KV cache is passed as CPU tensors. Keep it on WASM.
    const decoderResult = await createSession({
      ort,
      graph: await modelDataToArrayBuffer(decoderGraphBlob),
      label: `${this.model.name} decoder`,
      preferWebGPU: false,
      onWarning: (message) => this.recordWarning(message),
    });
    this.decoder = decoderResult.session;

    this.qwenNames = resolveQwenNames(
      this.convFrontend,
      this.encoder,
      this.decoder,
    );

    try {
      this.qwenTokenizer = new QwenTokenizer(
        await modelDataToText(vocabBlob),
        await modelDataToText(mergesBlob),
        await modelDataToText(tokenizerConfigBlob),
      );
    } catch (error) {
      throw new AppError('The Qwen tokenizer could not be read.', {
        code: 'VOCAB_INVALID',
        cause: error,
        hint: 'Clear the cached model and try again.',
      });
    }

    console.info(`[LocalScribe] ${this.model.name} Qwen3 tensors`, {
      convInputs: this.convFrontend.inputNames,
      convOutputs: this.convFrontend.outputNames,
      encoderInputs: this.encoder.inputNames,
      encoderOutputs: this.encoder.outputNames,
      decoderInputs: this.decoder.inputNames,
      decoderOutputs: this.decoder.outputNames,
      backend: this.backend,
    });
  }

  private async loadFusedSessions(
    ort: OrtModule,
    blobs: Map<ModelFileRole, ModelData>,
    dataNameFor: (role: ModelFileRole) => string | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    const encoderGraphBlob = blobs.get('encoderGraph');
    const decoderGraphBlob = blobs.get('decoderGraph');
    const preprocessorBlob = blobs.get('preprocessorGraph');

    if (!encoderGraphBlob || !decoderGraphBlob) {
      throw new AppError('The model download is incomplete.', {
        code: 'MODEL_FILES_MISSING',
        hint: 'Clear the cached model and try again.',
      });
    }

    if (preprocessorBlob) {
      this.emit({
        phase: 'session',
        message: `Loading the ${this.model.name} audio preprocessor…`,
      });

      const preprocessorResult = await createSession({
        ort,
        graph: await modelDataToArrayBuffer(preprocessorBlob),
        label: `${this.model.name} preprocessor`,
        preferWebGPU: false,
        onWarning: (message) => this.recordWarning(message),
      });
      this.preprocessor = preprocessorResult.session;
    }

    this.emit({
      phase: 'session',
      message: `Loading the ${this.model.name} encoder into ONNX Runtime…`,
    });

    const encoderResult = await createSession({
      ort,
      graph: await modelDataToArrayBuffer(encoderGraphBlob),
      data: blobs.get('encoderData'),
      dataName: dataNameFor('encoderData'),
      label: `${this.model.name} encoder`,
      preferWebGPU: this.useWebGPU,
      onWarning: (message) => this.recordWarning(message),
    });

    this.encoder = encoderResult.session;
    this.backend = encoderResult.backend;

    if (signal?.aborted) throw abortError();
    if (this.disposed) throw abortError('Model loading was cancelled.');

    this.emit({ phase: 'session', message: 'Loading the TDT decoder…' });

    const decoderResult = await createSession({
      ort,
      graph: await modelDataToArrayBuffer(decoderGraphBlob),
      data: blobs.get('decoderData'),
      dataName: dataNameFor('decoderData'),
      label: `${this.model.name} decoder`,
      preferWebGPU: false,
      onWarning: (message) => this.recordWarning(message),
    });

    this.decoder = decoderResult.session;
    this.names = resolveTensorNames(this.encoder, this.decoder);
    this.readEncoderLayout(this.encoder);
    this.readDecoderMetadata(this.decoder);
    this.readLengthDtype(this.encoder);

    // Keep the console useful when adapting to a different export. The app
    // itself never logs audio or transcript content.
    console.info(`[LocalScribe] ${this.model.name} encoder tensors`, {
      inputs: this.encoder.inputNames,
      outputs: this.encoder.outputNames,
      backend: this.backend,
    });
    console.info(`[LocalScribe] ${this.model.name} decoder tensors`, {
      inputs: this.decoder.inputNames,
      outputs: this.decoder.outputNames,
    });
  }

  private async loadMiniSessions(
    ort: OrtModule,
    blobs: Map<ModelFileRole, ModelData>,
    dataNameFor: (role: ModelFileRole) => string | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    const frontendBlob = blobs.get('frontend');
    const encoderGraphBlob = blobs.get('encoderGraph');
    const decoderGraphBlob = blobs.get('decoderGraph');
    const jointGraphBlob = blobs.get('jointGraph');

    if (!frontendBlob || !encoderGraphBlob || !decoderGraphBlob || !jointGraphBlob) {
      throw new AppError('The model download is incomplete.', {
        code: 'MODEL_FILES_MISSING',
        hint: 'Clear the cached model and try again.',
      });
    }

    this.emit({ phase: 'session', message: 'Loading the audio frontend…' });

    const frontendResult = await createSession({
      ort,
      graph: await modelDataToArrayBuffer(frontendBlob),
      label: `${this.model.name} frontend`,
      preferWebGPU: this.useWebGPU,
      onWarning: (message) => this.recordWarning(message),
    });
    this.frontend = frontendResult.session;

    if (signal?.aborted) throw abortError();
    if (this.disposed) throw abortError('Model loading was cancelled.');

    this.emit({ phase: 'session', message: 'Loading the encoder into ONNX Runtime…' });

    const encoderResult = await createSession({
      ort,
      graph: await modelDataToArrayBuffer(encoderGraphBlob),
      data: blobs.get('encoderData'),
      dataName: dataNameFor('encoderData'),
      label: `${this.model.name} encoder`,
      preferWebGPU: this.useWebGPU,
      onWarning: (message) => this.recordWarning(message),
    });
    this.encoder = encoderResult.session;
    this.backend = encoderResult.backend;

    if (signal?.aborted) throw abortError();
    if (this.disposed) throw abortError('Model loading was cancelled.');

    this.emit({ phase: 'session', message: 'Loading the TDT decoder…' });

    const decoderResult = await createSession({
      ort,
      graph: await modelDataToArrayBuffer(decoderGraphBlob),
      label: `${this.model.name} decoder`,
      preferWebGPU: false,
      onWarning: (message) => this.recordWarning(message),
    });
    this.decoder = decoderResult.session;

    this.emit({ phase: 'session', message: 'Loading the joint network…' });

    const jointResult = await createSession({
      ort,
      graph: await modelDataToArrayBuffer(jointGraphBlob),
      label: `${this.model.name} joint network`,
      preferWebGPU: false,
      onWarning: (message) => this.recordWarning(message),
    });
    this.joint = jointResult.session;

    this.miniNames = resolveMiniNames(
      this.frontend,
      this.encoder,
      this.decoder,
      this.joint,
    );
    this.readMiniMetadata();

    console.info(`[LocalScribe] ${this.model.name} frontend tensors`, {
      inputs: this.frontend.inputNames,
      outputs: this.frontend.outputNames,
    });
    console.info(`[LocalScribe] ${this.model.name} encoder tensors`, {
      inputs: this.encoder.inputNames,
      outputs: this.encoder.outputNames,
      backend: this.backend,
    });
    console.info(`[LocalScribe] ${this.model.name} decoder/joint tensors`, {
      decoderInputs: this.decoder.inputNames,
      decoderOutputs: this.decoder.outputNames,
      jointInputs: this.joint.inputNames,
      jointOutputs: this.joint.outputNames,
    });
  }

  private readMiniMetadata(): void {
    const frontend = this.frontend;
    const encoder = this.encoder;
    const decoder = this.decoder;
    const joint = this.joint;
    const names = this.miniNames;

    if (!frontend || !encoder || !decoder || !joint || !names) return;

    const frontendInputs = inputMetadata(frontend);
    const featureDims = positiveDims(
      frontendInputs?.find((entry) => entry.name === names.frontendFeatures)?.dimensions,
    );
    this.frontendTimeFirst = !(
      featureDims &&
      featureDims.length >= 3 &&
      featureDims[1] === this.config.featuresSize
    );

    const encoderInputs = inputMetadata(encoder);
    const hiddenDims = positiveDims(
      encoderInputs?.find((entry) => entry.name === names.encoderHidden)?.dimensions,
    );
    this.encoderTimeFirst = !(
      hiddenDims &&
      hiddenDims.length >= 2 &&
      hiddenDims[1] === this.config.encoderHidden
    );

    const lengthMeta = encoderInputs?.find((entry) => entry.name === names.encoderLength);
    this.lengthDtype = lengthMeta?.type === 'int32' ? 'int32' : 'int64';

    const decoderInputs = inputMetadata(decoder);
    const tokenMeta = decoderInputs?.find((entry) => entry.name === names.decoderToken);
    this.miniTokenDtype = tokenMeta?.type === 'int32' ? 'int32' : 'int64';

    const hDims = positiveDims(
      decoderInputs?.find((entry) => entry.name === names.decoderH)?.dimensions,
    );
    const cDims = positiveDims(
      decoderInputs?.find((entry) => entry.name === names.decoderC)?.dimensions,
    );
    this.stateDims = [
      hDims ?? [this.config.decoderLayers, 1, this.config.decoderHidden],
      cDims ?? [this.config.decoderLayers, 1, this.config.decoderHidden],
    ];

    const jointInputs = inputMetadata(joint);
    const frameDims = positiveDims(
      jointInputs?.find((entry) => entry.name === names.jointEncoder)?.dimensions,
    );
    this.jointEncoderDims =
      frameDims && product(frameDims) === this.config.encoderHidden
        ? frameDims
        : [1, this.config.encoderHidden];

    const decoderDims = positiveDims(
      jointInputs?.find((entry) => entry.name === names.jointDecoder)?.dimensions,
    );
    this.jointDecoderDims =
      decoderDims && product(decoderDims) === this.config.decoderHidden
        ? decoderDims
        : null;

    this.decoderHidden = this.config.encoderHidden;
  }

  private emit(progress: LoadProgress): void {
    this.onProgress?.(progress);
  }

  private recordWarning(message: string): void {
    if (this.warning) return;
    this.warning = message;
    this.onWarning?.(message);
  }

  private makeLengthTensor(ort: OrtModule, frameCount: number): OrtTensor {
    if (this.lengthDtype === 'int32') {
      return new ort.Tensor('int32', Int32Array.of(frameCount), [1]);
    }
    return new ort.Tensor('int64', BigInt64Array.of(BigInt(frameCount)), [1]);
  }

  private readEncoderLayout(session: OrtSession): void {
    const meta = inputMetadata(session)?.find(
      (entry) => entry.name === this.names?.encoderAudio,
    );
    const dims = meta?.dimensions;
    // [1, 128, T] is the official export. [1, T, 128] is accepted too.
    this.featuresFirst = !(dims && dims.length >= 3 && dims[2] === this.config.featuresSize);
  }

  private readDecoderMetadata(session: OrtSession): void {
    const meta = inputMetadata(session);
    const first = positiveDims(
      meta?.find((entry) => entry.name === this.names?.decoderState1)?.dimensions,
    );
    const second = positiveDims(
      meta?.find((entry) => entry.name === this.names?.decoderState2)?.dimensions,
    );
    const encoderInput = positiveDims(
      meta?.find((entry) => entry.name === this.names?.decoderEncoder)?.dimensions,
    );

    this.stateDims = [first ?? [2, 1, 640], second ?? [2, 1, 640]];

    if (encoderInput && encoderInput.length >= 2 && encoderInput[1] > 0) {
      this.decoderHidden = encoderInput[1];
    }
  }

  private readLengthDtype(session: OrtSession): void {
    const meta = inputMetadata(session)?.find(
      (entry) => entry.name === this.names?.encoderLength,
    );
    this.lengthDtype = meta?.type === 'int32' ? 'int32' : 'int64';
  }

  private readEncoderOutput(tensor: OrtTensor): {
    data: Float32Array;
    frames: number;
    hidden: number;
  } {
    const dims = tensor.dims;
    if (dims.length !== 3) {
      throw new AppError('The encoder output has an unexpected shape.', {
        code: 'ENCODER_SHAPE',
        hint: `Expected three dimensions, received [${dims.join(', ')}].`,
      });
    }

    const data = tensor.data as Float32Array;
    const second = Number(dims[1]);
    const third = Number(dims[2]);
    let result: { data: Float32Array; frames: number; hidden: number };

    // The decode loops slice one contiguous frame vector at a time, so always
    // hand them time-major [T, hidden] data. For the official exports the
    // encoder is already [1, T, hidden]; [1, hidden, T] is transposed.
    if (third === this.decoderHidden) {
      result = { data, frames: second, hidden: third };
    } else if (second === this.decoderHidden) {
      result = {
        data: transposeFeatures(data, second, third),
        frames: third,
        hidden: second,
      };
    } else if (data.length % this.decoderHidden === 0) {
      result = {
        data,
        frames: data.length / this.decoderHidden,
        hidden: this.decoderHidden,
      };
    } else {
      throw new AppError('The encoder output feature size is not recognized.', {
        code: 'ENCODER_FEATURE_SIZE',
        hint: `Encoder output shape: [${dims.join(', ')}]. This app expects a channel-major [1, hidden, frames] or time-major [1, frames, hidden] output.`,
      });
    }

    if (result.hidden !== this.decoderHidden) {
      throw new AppError('The encoder and decoder feature sizes do not match.', {
        code: 'ENCODER_DECODER_MISMATCH',
        hint: `The encoder outputs ${result.hidden} features, but the decoder expects ${this.decoderHidden}. This export is not compatible with the TDT pipeline in src/model.ts.`,
      });
    }

    return result;
  }

  private async releaseSessions(): Promise<void> {
    const encoder = this.encoder;
    const decoder = this.decoder;
    const frontend = this.frontend;
    const joint = this.joint;
    const convFrontend = this.convFrontend;
    const preprocessor = this.preprocessor;
    const granite = this.granite;
    const transformersAsr = this.transformersAsr;
    const omnilingualSession = this.omnilingualSession;

    this.encoder = null;
    this.decoder = null;
    this.frontend = null;
    this.joint = null;
    this.convFrontend = null;
    this.preprocessor = null;
    this.granite = null;
    this.transformersAsr = null;
    this.cactus = null;
    this.omnilingualSession = null;
    this.omnilingualTokens = null;
    this.tokenizer = null;
    this.qwenTokenizer = null;
    this.qwenNames = null;
    this.names = null;
    this.miniNames = null;
    this.backend = null;

    await granite?.dispose().catch(() => undefined);
    await transformersAsr?.dispose().catch(() => undefined);

    for (const session of [encoder, decoder, frontend, joint, convFrontend, preprocessor, omnilingualSession]) {
      if (!session) continue;
      try {
        const release = (session as unknown as { release?: () => Promise<void> }).release;
        if (typeof release === 'function') await release.call(session);
      } catch {
        // Disposal is best effort; freeing the reference is enough for GC.
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

function transposeFeatures(data: Float32Array, nMels: number, frames: number): Float32Array {
  const out = new Float32Array(data.length);
  for (let mel = 0; mel < nMels; mel += 1) {
    for (let frame = 0; frame < frames; frame += 1) {
      out[frame * nMels + mel] = data[mel * frames + frame];
    }
  }
  return out;
}

function transposeEncoder(data: Float32Array, frames: number, hidden: number): Float32Array {
  const out = new Float32Array(data.length);
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < hidden; channel += 1) {
      out[channel * frames + frame] = data[frame * hidden + channel];
    }
  }
  return out;
}

function argmax(values: Float32Array, start: number, end: number): number {
  let bestIndex = start;
  let bestValue = Number.NEGATIVE_INFINITY;

  for (let index = start; index < end; index += 1) {
    const value = values[index];
    if (value > bestValue) {
      bestValue = value;
      bestIndex = index;
    }
  }

  return bestIndex;
}

function padSamples(samples: Float32Array, length: number): Float32Array {
  const out = new Float32Array(length);
  out.set(samples.subarray(0, length));
  return out;
}

function disposeTensor(tensor: unknown): void {
  if (!tensor) return;
  const disposable = tensor as { dispose?: () => void };
  if (typeof disposable.dispose === 'function') {
    try {
      disposable.dispose();
    } catch {
      // Ignore: GC still owns the object.
    }
  }
}

function yieldToUi(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
