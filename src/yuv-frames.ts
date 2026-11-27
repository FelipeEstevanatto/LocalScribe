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

/**
 * Bilinear resample of one 8-bit plane. `step` is 1 for a planar plane and 2
 * for one component of an interleaved NV12 chroma plane (with `offset` already
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
  const scaleX = sourceWidth / targetWidth;
  const scaleY = sourceHeight / targetHeight;
  const maxX = sourceWidth - 1;
  const maxY = sourceHeight - 1;
  // Horizontal taps are the same for every row.
  const x0s = new Int32Array(targetWidth);
  const x1s = new Int32Array(targetWidth);
  const fxs = new Float32Array(targetWidth);
  for (let x = 0; x < targetWidth; x += 1) {
    const sx = Math.min(maxX, Math.max(0, (x + 0.5) * scaleX - 0.5));
    const x0 = Math.floor(sx);
    x0s[x] = x0 * step;
    x1s[x] = Math.min(maxX, x0 + 1) * step;
    fxs[x] = sx - x0;
  }
  for (let y = 0; y < targetHeight; y += 1) {
    const sy = Math.min(maxY, Math.max(0, (y + 0.5) * scaleY - 0.5));
    const y0 = Math.floor(sy);
    const fy = sy - y0;
    const row0 = offset + y0 * stride;
    const row1 = offset + Math.min(maxY, y0 + 1) * stride;
    const out = targetOffset + y * targetWidth;
    for (let x = 0; x < targetWidth; x += 1) {
      const fx = fxs[x];
      const top = source[row0 + x0s[x]] + (source[row0 + x1s[x]] - source[row0 + x0s[x]]) * fx;
      const bottom = source[row1 + x0s[x]] + (source[row1 + x1s[x]] - source[row1 + x0s[x]]) * fx;
      target[out + x] = Math.round(top + (bottom - top) * fy);
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
 * workers. Bilinear scaling in JavaScript took about 8 ms per 1080p frame on
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
