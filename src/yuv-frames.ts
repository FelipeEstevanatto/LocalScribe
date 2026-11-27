/**
 * Decoded video frames as raw YUV, without a trip through a canvas.
 *
 * Drawing a frame into a canvas converts it to sRGB with the browser's guess
 * of its colour matrix. For a file without colour tags, Chrome guesses BT.709
 * for HD while FFmpeg-based tools guess BT.601, so a re-encode through a
 * canvas shows different colours from the source in those tools. Copying the
 * Y, U and V planes and scaling them as they are keeps the source's own values
 * (and, passed on to the encoder, its colour description, or its lack of one).
 */
import type { VideoSample } from 'mediabunny';

/** Fixed-point weight scale for the scaling taps. */
const WEIGHT_BITS = 14;

interface Taps {
  /** First source index for each output index. */
  start: Int32Array;
  /** Number of taps for each output index. */
  count: Int32Array;
  /** `size` weights per output index, summing to 1 << WEIGHT_BITS. */
  weights: Int32Array;
  size: number;
}

/**
 * Taps from `source` samples to `target` samples. On a downscale each output
 * sample averages the source span it covers (an area filter), so every source
 * sample counts; plain 2-tap bilinear skips samples past 2x and aliases. On an
 * upscale it is bilinear.
 */
function filterTaps(source: number, target: number): Taps {
  const scale = source / target;
  const size = Math.ceil(scale) + 2;
  const start = new Int32Array(target);
  const count = new Int32Array(target);
  const weights = new Int32Array(target * size);
  const raw = new Float64Array(size);
  for (let i = 0; i < target; i += 1) {
    raw.fill(0);
    let low: number;
    let high: number;
    if (scale > 1) {
      const from = i * scale;
      const to = Math.min(source, (i + 1) * scale);
      low = Math.floor(from);
      high = Math.min(source, Math.ceil(to)) - 1;
      for (let j = low; j <= high; j += 1) raw[j - low] = Math.min(to, j + 1) - Math.max(from, j);
    } else {
      const center = Math.min(source - 1, Math.max(0, (i + 0.5) * scale - 0.5));
      low = Math.floor(center);
      high = Math.min(source - 1, low + 1);
      raw[0] = 1 - (center - low);
      if (high > low) raw[1] = center - low;
    }
    const n = high - low + 1;
    let total = 0;
    for (let k = 0; k < n; k += 1) total += raw[k];
    const offset = i * size;
    let sum = 0;
    let largest = 0;
    for (let k = 0; k < n; k += 1) {
      const weight = Math.round((raw[k] / total) * (1 << WEIGHT_BITS));
      weights[offset + k] = weight;
      sum += weight;
      if (weight > weights[offset + largest]) largest = k;
    }
    // Rounding leftovers go to the largest tap so a flat plane stays flat.
    weights[offset + largest] += (1 << WEIGHT_BITS) - sum;
    start[i] = low;
    count[i] = n;
  }
  return { start, count, weights, size };
}

/**
 * Resample one 8-bit plane with a separable filter (area on a downscale,
 * bilinear on an upscale). `step` is 1 for a planar plane and 2 for
 * one component of an interleaved NV12 chroma plane (with `offset` already
 * pointing at that component).
 */
export function scalePlane(
  source: Uint8Array,
  offset: number,
  stride: number,
  step: number,
  sourceWidth: number,
  sourceHeight: number,
  target: Uint8Array,
  targetOffset: number,
  targetWidth: number,
  targetHeight: number,
): void {
  if (sourceWidth === targetWidth && sourceHeight === targetHeight) {
    for (let y = 0; y < targetHeight; y += 1) {
      const row = offset + y * stride;
      const out = targetOffset + y * targetWidth;
      if (step === 1) target.set(source.subarray(row, row + targetWidth), out);
      else for (let x = 0; x < targetWidth; x += 1) target[out + x] = source[row + x * step];
    }
    return;
  }
  const across = filterTaps(sourceWidth, targetWidth);
  const down = filterTaps(sourceHeight, targetHeight);
  // Vertical pass first, one output row at a time, so the horizontal pass only
  // runs on output rows. The row is kept as value * 256.
  const sums = new Int32Array(sourceWidth);
  const row = new Uint16Array(sourceWidth);
  const shift = WEIGHT_BITS - 8;
  const half = 1 << (shift - 1);
  const finalShift = WEIGHT_BITS + 8;
  const round = 1 << (finalShift - 1);
  // Horizontal taps as flat arrays of `taps` entries per output sample
  // (source index and weight, padded with zero weights).
  let taps = 2;
  for (let x = 0; x < targetWidth; x += 1) taps = Math.max(taps, across.count[x]);
  const at = new Int32Array(targetWidth * taps);
  const wt = new Int32Array(targetWidth * taps);
  for (let x = 0; x < targetWidth; x += 1) {
    for (let k = 0; k < taps; k += 1) {
      const inside = k < across.count[x];
      at[x * taps + k] = inside ? across.start[x] + k : across.start[x];
      wt[x * taps + k] = inside ? across.weights[x * across.size + k] : 0;
    }
  }
  for (let y = 0; y < targetHeight; y += 1) {
    const n = down.count[y];
    const w = y * down.size;
    const line = offset + down.start[y] * stride;
    if (step === 1 && n === 2) {
      // The common cases written out: one pass, no running sums.
      const w0 = down.weights[w];
      const w1 = down.weights[w + 1];
      const l1 = line + stride;
      for (let x = 0; x < sourceWidth; x += 1) row[x] = (source[line + x] * w0 + source[l1 + x] * w1 + half) >> shift;
    } else if (step === 1 && n === 3) {
      const w0 = down.weights[w];
      const w1 = down.weights[w + 1];
      const w2 = down.weights[w + 2];
      const l1 = line + stride;
      const l2 = l1 + stride;
      for (let x = 0; x < sourceWidth; x += 1) {
        row[x] = (source[line + x] * w0 + source[l1 + x] * w1 + source[l2 + x] * w2 + half) >> shift;
      }
    } else {
      sums.fill(0);
      for (let k = 0; k < n; k += 1) {
        const weight = down.weights[w + k];
        const from = line + k * stride;
        if (step === 1) for (let x = 0; x < sourceWidth; x += 1) sums[x] += source[from + x] * weight;
        else for (let x = 0; x < sourceWidth; x += 1) sums[x] += source[from + x * step] * weight;
      }
      for (let x = 0; x < sourceWidth; x += 1) row[x] = (sums[x] + half) >> shift;
    }
    const out = targetOffset + y * targetWidth;
    if (taps === 2) {
      for (let x = 0, t = 0; x < targetWidth; x += 1, t += 2) {
        target[out + x] = (row[at[t]] * wt[t] + row[at[t + 1]] * wt[t + 1] + round) >>> finalShift;
      }
    } else if (taps === 3) {
      for (let x = 0, t = 0; x < targetWidth; x += 1, t += 3) {
        target[out + x] = (row[at[t]] * wt[t] + row[at[t + 1]] * wt[t + 1] + row[at[t + 2]] * wt[t + 2] + round) >>> finalShift;
      }
    } else if (taps === 4) {
      for (let x = 0, t = 0; x < targetWidth; x += 1, t += 4) {
        target[out + x] = (row[at[t]] * wt[t] + row[at[t + 1]] * wt[t + 1] + row[at[t + 2]] * wt[t + 2]
          + row[at[t + 3]] * wt[t + 3] + round) >>> finalShift;
      }
    } else {
      for (let x = 0, t = 0; x < targetWidth; x += 1, t += taps) {
        let sum = round;
        for (let k = 0; k < taps; k += 1) sum += row[at[t + k]] * wt[t + k];
        target[out + x] = sum >>> finalShift;
      }
    }
  }
}

/** Size in bytes of an I420 frame (even dimensions). */
export function i420Size(width: number, height: number): number {
  return width * height + 2 * (width / 2) * (height / 2);
}

/** The decoded formats this module reads. */
export type YuvFormat = 'I420' | 'NV12';

export function isYuvFormat(format: string | null): format is YuvFormat {
  return format === 'I420' || format === 'NV12';
}

/** A decoded frame's bytes as copied out by copyTo, with what is needed to read them. */
export interface YuvPlanes {
  buffer: Uint8Array;
  layout: PlaneLayout[];
  format: YuvFormat;
  width: number;
  height: number;
}

/** Scale copied I420 or NV12 planes into an I420 buffer of the given even size. */
export function planesToI420(planes: YuvPlanes, width: number, height: number): Uint8Array {
  const { buffer, layout, format, width: sourceWidth, height: sourceHeight } = planes;
  const chromaWidth = Math.ceil(sourceWidth / 2);
  const chromaHeight = Math.ceil(sourceHeight / 2);
  const out = new Uint8Array(i420Size(width, height));
  const lumaSize = width * height;
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  scalePlane(buffer, layout[0].offset, layout[0].stride, 1, sourceWidth, sourceHeight, out, 0, width, height);
  if (format === 'I420') {
    scalePlane(buffer, layout[1].offset, layout[1].stride, 1, chromaWidth, chromaHeight, out, lumaSize, halfWidth, halfHeight);
    scalePlane(buffer, layout[2].offset, layout[2].stride, 1, chromaWidth, chromaHeight, out, lumaSize + halfWidth * halfHeight, halfWidth, halfHeight);
  } else {
    scalePlane(buffer, layout[1].offset, layout[1].stride, 2, chromaWidth, chromaHeight, out, lumaSize, halfWidth, halfHeight);
    scalePlane(buffer, layout[1].offset + 1, layout[1].stride, 2, chromaWidth, chromaHeight, out, lumaSize + halfWidth * halfHeight, halfWidth, halfHeight);
  }
  return out;
}

/** Copy a decoded I420 or NV12 sample's planes out of the frame. */
async function copyPlanes(sample: VideoSample, format: YuvFormat): Promise<YuvPlanes> {
  const buffer = new Uint8Array(sample.allocationSize());
  const layout = await sample.copyTo(buffer);
  return { buffer, layout, format, width: sample.visibleRect.width, height: sample.visibleRect.height };
}

/**
 * Copy a decoded 8-bit I420 or NV12 sample into an I420 buffer of the given
 * even size. Returns null for other formats (10-bit, RGB), which the caller
 * handles another way.
 */
export async function sampleToI420(sample: VideoSample, width: number, height: number): Promise<Uint8Array | null> {
  const format = sample.format;
  if (!isYuvFormat(format)) return null;
  return planesToI420(await copyPlanes(sample, format), width, height);
}

/** A frame handed to the scaler: its I420 bytes arrive in `result`. */
export interface PendingI420 {
  result: Promise<Uint8Array>;
}

/**
 * Turns decoded samples into I420 at a fixed output size, scaling in a pool of
 * workers. Scaling in JavaScript takes about 8 ms per 1080p frame (17 ms from 4K) on
 * the page thread, which kept the decoder and encoder waiting.
 */
export interface YuvScaler {
  /**
   * Copy the sample's planes (the sample may be closed once this resolves) and
   * start scaling them. Null for a format this module does not read.
   */
  add(sample: VideoSample): Promise<PendingI420 | null>;
  close(): void;
}

interface ScaleReply {
  id: number;
  out?: Uint8Array;
  error?: string;
}

/** Workers used for scaling: a few, leaving cores for the decoder and encoder. */
function scalerWorkerCount(): number {
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
  return Math.max(1, Math.min(4, cores - 2));
}

export function createYuvScaler(width: number, height: number): YuvScaler {
  if (typeof Worker === 'undefined') {
    return {
      async add(sample) {
        const format = sample.format;
        if (!isYuvFormat(format)) return null;
        const planes = await copyPlanes(sample, format);
        return { result: Promise.resolve(planesToI420(planes, width, height)) };
      },
      close() {},
    };
  }
  const workers: Worker[] = [];
  const count = scalerWorkerCount();
  const pending = new Map<number, { resolve: (out: Uint8Array) => void; reject: (error: Error) => void }>();
  // Copied source frames waiting for a worker, kept small so a 4K source
  // (12 MB a frame) does not pile up in memory.
  const limit = count * 2;
  const waiting: (() => void)[] = [];
  let nextId = 0;
  let nextWorker = 0;
  let failure: Error | null = null;
  const settle = (id: number): void => {
    pending.delete(id);
    waiting.shift()?.();
  };
  const fail = (error: Error): void => {
    failure ??= error;
    for (const [id, request] of pending) {
      request.reject(error);
      settle(id);
    }
  };
  for (let index = 0; index < count; index += 1) {
    const worker = new Worker(new URL('./yuv-scale-worker.ts', import.meta.url), { type: 'module', name: 'yuv-scale' });
    worker.onmessage = (event: MessageEvent<ScaleReply>) => {
      const request = pending.get(event.data.id);
      if (!request) return;
      settle(event.data.id);
      if (event.data.out) request.resolve(event.data.out);
      else request.reject(new Error(event.data.error ?? 'Scaling failed.'));
    };
    worker.onerror = (event) => {
      event.preventDefault();
      fail(new Error(event.message || 'The scaling worker failed.'));
    };
    workers.push(worker);
  }
  return {
    async add(sample) {
      if (failure) throw failure;
      const format = sample.format;
      if (!isYuvFormat(format)) return null;
      if (format === 'I420' && sample.visibleRect.width === width && sample.visibleRect.height === height) {
        // Same size: copy straight into a packed I420 buffer, no scaling.
        const out = new Uint8Array(i420Size(width, height));
        const half = (width / 2) * (height / 2);
        await sample.copyTo(out, { layout: [
          { offset: 0, stride: width },
          { offset: width * height, stride: width / 2 },
          { offset: width * height + half, stride: width / 2 },
        ] });
        return { result: Promise.resolve(out) };
      }
      while (pending.size >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
      const planes = await copyPlanes(sample, format);
      const id = ++nextId;
      const result = new Promise<Uint8Array>((resolve, reject) => pending.set(id, { resolve, reject }));
      // Frames dropped after a failure or cancel are never awaited.
      result.catch(() => undefined);
      workers[nextWorker].postMessage({ id, planes, width, height }, [planes.buffer.buffer]);
      nextWorker = (nextWorker + 1) % workers.length;
      return { result };
    },
    close() {
      for (const worker of workers) worker.terminate();
      fail(new Error('The scaler was closed.'));
    },
  };
}
