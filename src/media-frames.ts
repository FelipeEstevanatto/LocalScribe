/**
 * Browser-native frame extraction for Quick Tools.
 *
 * Mediabunny demuxes and WebCodecs decodes; the canvas encodes each frame with
 * the browser's PNG/JPEG encoder. Returns null when the fast path cannot read
 * or decode the file so the caller can keep the FFmpeg fallback.
 */

import { ALL_FORMATS, BlobSource, CanvasSink, Input } from 'mediabunny';

export interface FrameExtractionOptions {
  start: number;
  end: number;
  interval: number;
  limit?: number;
  format: 'png' | 'jpg';
  quality?: number;
}

export interface FilmstripRangeOptions {
  start: number;
  end: number;
  frames: number;
  height: number;
  quality?: number;
}

function canvasToBlob(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  type: string,
  quality?: number,
): Promise<Blob> {
  if ('convertToBlob' in canvas) return canvas.convertToBlob({ type, quality });
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error(`This browser has no ${type} encoder.`)),
      type,
      quality,
    );
  });
}

/**
 * Decode a handful of frames from one source range into a single horizontal
 * strip. Used for deep timeline zoom, where the full-length strip runs out of
 * temporal resolution.
 */
export async function extractFilmstripRange(
  file: Blob,
  options: FilmstripRangeOptions,
  signal?: AbortSignal,
): Promise<Blob | null> {
  const { start, end, frames } = options;
  if (!(end > start) || !(frames > 0)) return null;
  const height = Math.max(32, Math.min(288, Math.round(options.height)));
  const count = Math.max(1, Math.min(64, Math.floor(frames)));
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    if (!(await input.canRead())) return null;
    const track = await input.getPrimaryVideoTrack();
    if (!track || !(await track.canDecode())) return null;
    const first = await track.getFirstTimestamp();
    const sink = new CanvasSink(track, {
      height,
      poolSize: 2,
      decoderOptions: { optimizeForLatency: true },
    });
    const timestamps: number[] = [];
    for (let index = 0; index < count; index += 1) {
      const time = start + ((index + 0.5) / count) * (end - start);
      timestamps.push(Math.max(first, Math.min(end - 1e-6, time)));
    }
    let strip: HTMLCanvasElement | OffscreenCanvas | null = null;
    let context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;
    let frameWidth = 0;
    let slot = 0;
    for await (const wrapped of sink.canvasesAtTimestamps(timestamps, { skipLiveWait: true })) {
      signal?.throwIfAborted();
      if (slot >= count) break;
      if (!wrapped) {
        slot += 1;
        continue;
      }
      if (!strip) {
        frameWidth = Math.max(1, wrapped.canvas.width);
        strip = typeof OffscreenCanvas !== 'undefined'
          ? new OffscreenCanvas(frameWidth * count, height)
          : Object.assign(document.createElement('canvas'), {
            width: frameWidth * count,
            height,
          });
        context = strip.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
        if (!context) return null;
      }
      if (!context) return null;
      context.drawImage(wrapped.canvas, slot * frameWidth, 0, frameWidth, height);
      slot += 1;
    }
    if (!strip || !context) return null;
    return await canvasToBlob(strip, 'image/jpeg', options.quality ?? 0.82);
  } finally {
    input.dispose();
  }
}

/**
 * Decode fewer unique frames and repeat them to fill the timeline strip. This
 * keeps the full-length overview responsive on 4K sources; deep zoom uses the
 * range strip, so the repeated base frames are only a coarse overview.
 */
export async function extractFilmstripRepeated(
  file: Blob,
  options: FilmstripRangeOptions,
  uniqueFrames: number,
  totalFrames: number,
  signal?: AbortSignal,
): Promise<Blob | null> {
  const total = Math.max(1, Math.min(64, Math.floor(totalFrames)));
  const unique = Math.max(1, Math.min(total, Math.floor(uniqueFrames)));
  const strip = await extractFilmstripRange(file, { ...options, frames: unique }, signal);
  if (!strip) return null;
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(strip, { imageOrientation: 'none' });
    const height = Math.max(32, Math.min(288, Math.round(options.height)));
    const frameWidth = Math.max(1, bitmap.width / unique);
    const canvas = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(Math.round(frameWidth * total), height)
      : Object.assign(document.createElement('canvas'), {
        width: Math.round(frameWidth * total),
        height,
      });
    const context = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!context) return null;
    for (let slot = 0; slot < total; slot += 1) {
      const source = Math.min(unique - 1, Math.floor((slot * unique) / total));
      context.drawImage(
        bitmap,
        source * frameWidth, 0, frameWidth, height,
        slot * frameWidth, 0, frameWidth, height,
      );
    }
    return await canvasToBlob(canvas, 'image/jpeg', options.quality ?? 0.82);
  } catch {
    return null;
  } finally {
    bitmap?.close();
  }
}

export async function extractVideoFrames(
  file: Blob,
  options: FrameExtractionOptions,
  signal?: AbortSignal,
  onProgress?: (ratio: number) => void,
): Promise<Blob[] | null> {
  const { start, end, interval, format } = options;
  if (!(interval > 0) || !(end > start)) return null;
  const limit = Math.max(1, Math.min(300, Math.floor(options.limit ?? 300)));
  const requested = Math.ceil((end - start) / interval - 1e-7);
  const count = Math.min(limit, Math.max(1, requested));

  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    if (!(await input.canRead())) return null;
    const track = await input.getPrimaryVideoTrack();
    if (!track || !(await track.canDecode())) return null;
    const first = await track.getFirstTimestamp();
    const sink = new CanvasSink(track, { poolSize: 2 });
    const timestamps: number[] = [];
    for (let index = 0; index < count; index += 1) {
      timestamps.push(Math.max(first, first + Math.min(end - 1e-6, start + index * interval)));
    }
    const type = format === 'png' ? 'image/png' : 'image/jpeg';
    const quality = format === 'jpg' ? (options.quality ?? 0.9) : undefined;
    const blobs: Blob[] = [];
    let bytes = 0;
    let index = 0;
    for await (const wrapped of sink.canvasesAtTimestamps(timestamps, { skipLiveWait: true })) {
      signal?.throwIfAborted();
      index += 1;
      if (!wrapped) continue;
      const blob = await canvasToBlob(wrapped.canvas, type, quality);
      signal?.throwIfAborted();
      if (blob.type !== type) return null;
      blobs.push(blob);
      bytes += blob.size;
      onProgress?.(index / count);
      if (bytes >= 300_000_000) break;
    }
    onProgress?.(1);
    return blobs.length ? blobs : null;
  } finally {
    input.dispose();
  }
}
