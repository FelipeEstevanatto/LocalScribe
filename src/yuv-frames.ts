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

/**
 * Copy a decoded 8-bit I420 or NV12 sample into an I420 buffer of the given
 * even size. Returns null for other formats (10-bit, RGB), which the caller
 * handles another way.
 */
export async function sampleToI420(sample: VideoSample, width: number, height: number): Promise<Uint8Array | null> {
  const format = sample.format;
  if (format !== 'I420' && format !== 'NV12') return null;
  const buffer = new Uint8Array(sample.allocationSize());
  const layout = await sample.copyTo(buffer);
  const sourceWidth = sample.visibleRect.width;
  const sourceHeight = sample.visibleRect.height;
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
