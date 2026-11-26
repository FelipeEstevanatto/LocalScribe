/**
 * Runs the export pixel pass on a small worker pool, split into bands of
 * rows. A 1080p frame with key + curve + LUT took about 70 ms on the main
 * thread (269 s of blocking for a 3-minute export); here the page only copies
 * the bands out and back. Small frames, browsers without workers, and any
 * worker failure run the same kernel in the page instead.
 */
import { runPixelPass, type PixelPass } from './pixel-effects-kernel';
import type { PixelWorkerReply, PixelWorkerRequest } from './pixel-effects-worker';

interface Slot {
  worker: Worker;
  luts: Set<string>;
}

const MIN_PARALLEL_PIXELS = 320 * 240;
const IDLE_MS = 20_000;

let slots: Slot[] | null = null;
let disabled = false;
let idleTimer = 0;
let nextId = 0;
const pending = new Map<number, { resolve: (data: Uint8ClampedArray) => void; reject: (error: Error) => void }>();

function poolSize(): number {
  const cores = typeof navigator !== 'undefined' && navigator.hardwareConcurrency > 0 ? navigator.hardwareConcurrency : 4;
  return Math.max(2, Math.min(8, cores - 1));
}

function shutdown(error?: Error): void {
  for (const slot of slots ?? []) slot.worker.terminate();
  slots = null;
  if (error) {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  }
}

function pool(): Slot[] | null {
  if (disabled || typeof Worker === 'undefined') return null;
  if (slots) return slots;
  try {
    slots = Array.from({ length: poolSize() }, () => {
      const worker = new Worker(new URL('./pixel-effects-worker.ts', import.meta.url), { type: 'module', name: 'pixel-effects' });
      worker.onmessage = (event: MessageEvent<PixelWorkerReply>) => {
        const { id, data, error } = event.data;
        const request = pending.get(id);
        if (!request) return;
        pending.delete(id);
        if (data) request.resolve(data);
        else request.reject(new Error(error || 'The pixel worker failed.'));
      };
      worker.onerror = (event) => {
        event.preventDefault();
        // Do not retry workers in this session; the page path still works.
        disabled = true;
        shutdown(new Error(event.message || 'The pixel worker failed.'));
      };
      return { worker, luts: new Set<string>() };
    });
  } catch {
    disabled = true;
    shutdown();
    return null;
  }
  return slots;
}

function scheduleIdle(): void {
  if (typeof window === 'undefined') return;
  window.clearTimeout(idleTimer);
  idleTimer = window.setTimeout(() => {
    if (!pending.size) shutdown();
  }, IDLE_MS);
}

function send(slot: Slot, data: Uint8ClampedArray, pass: PixelPass, lutKey: string | null): Promise<Uint8ClampedArray> {
  const id = ++nextId;
  const { lut, ...plain } = pass;
  const message: PixelWorkerRequest = { id, data, pass: plain, lutKey };
  if (lutKey && lut && !slot.luts.has(lutKey)) {
    message.lut = lut;
    slot.luts.add(lutKey);
  }
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    slot.worker.postMessage(message, [data.buffer]);
  });
}

/**
 * Apply the pass to the whole RGBA buffer. `lutKey` identifies the LUT data so
 * each worker receives it once.
 */
export async function runPixelPassParallel(data: Uint8ClampedArray, pass: PixelPass, lutKey: string | null): Promise<void> {
  const workers = data.length / 4 >= MIN_PARALLEL_PIXELS ? pool() : null;
  if (!workers) {
    runPixelPass(data, pass);
    return;
  }
  const pixels = data.length / 4;
  const band = Math.ceil(pixels / workers.length) * 4;
  const failed: [number, number][] = [];
  await Promise.all(workers.map(async (slot, index) => {
    const start = index * band;
    const end = Math.min(data.length, start + band);
    if (start >= end) return;
    try {
      // Bands are copied out; the original stays untouched until a band returns,
      // so a failed band can still be done here exactly once.
      data.set(await send(slot, data.slice(start, end), pass, pass.lut ? lutKey : null), start);
    } catch {
      failed.push([start, end]);
    }
  }));
  for (const [start, end] of failed) runPixelPass(data, pass, start, end);
  scheduleIdle();
}

/** Stop the workers now (tests; the pool also stops itself when idle). */
export function disposePixelWorkers(): void {
  if (typeof window !== 'undefined') window.clearTimeout(idleTimer);
  shutdown();
}
