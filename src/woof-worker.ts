/**
 * Underdog Woof inference worker.
 *
 * The CPU port is synchronous typed-array code, so it runs in a worker to keep
 * the page responsive. Weights are cached in the Cache API after the first
 * download. The model and this port are licensed under the Underdog
 * Non-Commercial License 1.0; credit: "Voice by Underdog Woof".
 */

import {
  SAMPLE_RATE,
  TorchRandn,
  WEIGHTS_URL,
  WoofEngine,
  splitWoofText,
} from './woof';
import type { WoofWorkerRequest, WoofWorkerResponse } from './woof-tts';

let engine: WoofEngine | null = null;

const CACHE_NAME = 'localscribe-woof-v1';

function post(message: WoofWorkerResponse, transfer: Transferable[] = []): void {
  (self as unknown as Worker).postMessage(message, transfer);
}

async function openCache(): Promise<Cache | null> {
  if (typeof caches === 'undefined') return null;
  try {
    return await caches.open(CACHE_NAME);
  } catch {
    return null;
  }
}

async function loadWeights(id: number): Promise<ArrayBuffer> {
  const cache = await openCache();
  const cached = await cache?.match(WEIGHTS_URL);
  if (cached) {
    post({
      id,
      type: 'progress',
      phase: 'download',
      loaded: Number(cached.headers.get('content-length') ?? 0),
      total: Number(cached.headers.get('content-length') ?? 0),
      cached: true,
    });
    return cached.arrayBuffer();
  }

  const response = await fetch(WEIGHTS_URL);
  if (!response.ok) {
    throw new Error(`Failed to download Woof weights (HTTP ${response.status}).`);
  }
  if (!response.body) throw new Error('Woof weights: response has no body.');

  const total = Number(response.headers.get('content-length') ?? 0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    loaded += value.length;
    post({
      id,
      type: 'progress',
      phase: 'download',
      loaded,
      total: total > 0 ? total : loaded,
    });
  }

  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }

  if (cache) {
    const copy = bytes.slice();
    await cache
      .put(
        WEIGHTS_URL,
        new Response(copy, {
          headers: { 'content-type': 'application/octet-stream', 'content-length': String(loaded) },
        }),
      )
      .catch(() => undefined);
  }

  return bytes.buffer;
}

async function handleLoad(id: number): Promise<void> {
  post({ id, type: 'progress', phase: 'prepare', loaded: 0, total: 0 });
  const buffer = await loadWeights(id);
  post({ id, type: 'progress', phase: 'prepare', loaded: buffer.byteLength, total: buffer.byteLength });
  engine = WoofEngine.load(buffer);
  post({ id, type: 'loaded' });
}

function handleSynthesize(
  id: number,
  text: string,
  voice: string,
  seed: number,
): void {
  if (!engine) throw new Error('Woof is not loaded yet.');

  const rng = new TorchRandn();
  rng.seed(seed);

  const pieces = splitWoofText(text);
  const queue = pieces.length > 0 ? pieces : [text];
  const chunks: Float32Array[] = [];

  for (let index = 0; index < queue.length; index += 1) {
    const piece = queue[index];
    if (!piece.trim()) continue;
    post({
      id,
      type: 'progress',
      phase: 'synthesize',
      piece: index + 1,
      pieces: queue.length,
      loaded: 0,
      total: 0,
    });
    chunks.push(engine.synthesizePiece(piece, voice, rng));
  }

  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  if (length === 0) throw new Error('Woof returned empty audio.');

  const samples = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    samples.set(chunk, offset);
    offset += chunk.length;
  }

  post({ id, type: 'result', samples, sampleRate: SAMPLE_RATE }, [samples.buffer]);
}

self.onmessage = (event: MessageEvent<WoofWorkerRequest>) => {
  const request = event.data;

  if (request.type === 'load') {
    void handleLoad(request.id).catch((error: unknown) => {
      engine = null;
      post({
        id: request.id,
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    });
    return;
  }

  if (request.type === 'synthesize') {
    try {
      handleSynthesize(request.id, request.text, request.voice, request.seed ?? 0);
    } catch (error) {
      post({
        id: request.id,
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
};
