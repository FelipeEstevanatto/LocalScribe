/**
 * Text recognition (OCR) with PaddleOCR PP-OCRv6 tiny: a 1.8 MB DB text
 * detector and a 4.5 MB CTC recognizer covering 49 languages.
 *
 * Pipeline: probability map → connected regions → rotated rectangles
 * (convex hull + minimum-area rectangle, expanded by the DB unclip ratio) →
 * crops straightened onto a 48 px tall strip → CTC greedy decoding.
 */

import { getOrt } from './ort-runtime';
import { fetchWithProgress } from './transfer';

const DET_URL = 'https://huggingface.co/PaddlePaddle/PP-OCRv6_tiny_det_onnx/resolve/2ba1506c0380b8f0b03dd142459aac66d4421f6c/inference.onnx';
const REC_URL = 'https://huggingface.co/PaddlePaddle/PP-OCRv6_tiny_rec_onnx/resolve/2612ab37152ae0a677521bae4e1e3d4fb4cf7c30/inference.onnx';
const DET_BYTES = 1_780_590;
const REC_BYTES = 4_462_639;
export const OCR_BYTES = DET_BYTES + REC_BYTES;
export const OCR_CACHE = 'localscribe-ocr-v1';

// DBPostProcess settings from the detector's inference.yml.
const BIN_THRESHOLD = 0.2;
const BOX_THRESHOLD = 0.4;
const UNCLIP_RATIO = 1.4;
const MAX_CANDIDATES = 3000;
const REC_HEIGHT = 48;
const REC_MAX_WIDTH = 3200;

export type Point = [number, number];

export interface OcrLine {
  text: string;
  score: number;
  /** Corners in image pixels, clockwise from top-left. */
  box: [Point, Point, Point, Point];
}

export interface OcrImage {
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
  channels: number;
}

/* Geometry (pure, unit tested) ---------------------------------------------- */

/** Andrew's monotone chain convex hull. */
export function convexHull(points: Point[]): Point[] {
  const sorted = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (sorted.length < 3) return sorted;
  const cross = (o: Point, a: Point, b: Point) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Point[] = [];
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) lower.pop();
    lower.push(point);
  }
  const upper: Point[] = [];
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const point = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) upper.pop();
    upper.push(point);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

export interface RotatedRect {
  cx: number;
  cy: number;
  /** Long side along `angle`, short side across it. */
  width: number;
  height: number;
  /** Radians, direction of the width axis. */
  angle: number;
}

/** Minimum-area enclosing rectangle by rotating calipers over hull edges. */
export function minAreaRect(hull: Point[]): RotatedRect {
  if (hull.length === 1) return { cx: hull[0][0], cy: hull[0][1], width: 1, height: 1, angle: 0 };
  let best: RotatedRect | null = null;
  let bestArea = Infinity;
  for (let i = 0; i < hull.length; i += 1) {
    const [x1, y1] = hull[i];
    const [x2, y2] = hull[(i + 1) % hull.length];
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const [x, y] of hull) {
      const u = x * cos + y * sin;
      const v = -x * sin + y * cos;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const area = (maxU - minU) * (maxV - minV);
    if (area < bestArea) {
      bestArea = area;
      const cu = (minU + maxU) / 2;
      const cv = (minV + maxV) / 2;
      best = { cx: cu * cos - cv * sin, cy: cu * sin + cv * cos, width: maxU - minU, height: maxV - minV, angle };
    }
  }
  const rect = best!;
  // Normalise: width is the long side, angle within (-90°, 90°].
  if (rect.height > rect.width) {
    [rect.width, rect.height] = [rect.height, rect.width];
    rect.angle += Math.PI / 2;
  }
  while (rect.angle > Math.PI / 2) rect.angle -= Math.PI;
  while (rect.angle <= -Math.PI / 2) rect.angle += Math.PI;
  return rect;
}

/** DB "unclip": grow the box by area × ratio / perimeter on every side. */
export function unclip(rect: RotatedRect, ratio = UNCLIP_RATIO): RotatedRect {
  const area = rect.width * rect.height;
  const perimeter = 2 * (rect.width + rect.height);
  const distance = perimeter > 0 ? (area * ratio) / perimeter : 0;
  return { ...rect, width: rect.width + 2 * distance, height: rect.height + 2 * distance };
}

export function rectCorners(rect: RotatedRect): [Point, Point, Point, Point] {
  const cos = Math.cos(rect.angle);
  const sin = Math.sin(rect.angle);
  const hw = rect.width / 2;
  const hh = rect.height / 2;
  const at = (u: number, v: number): Point => [rect.cx + u * cos - v * sin, rect.cy + u * sin + v * cos];
  return [at(-hw, -hh), at(hw, -hh), at(hw, hh), at(-hw, hh)];
}

/** Text regions of a probability map as rotated rectangles in map pixels. */
export function findTextRegions(map: Float32Array, width: number, height: number): { rect: RotatedRect; score: number }[] {
  const seen = new Uint8Array(width * height);
  const regions: { rect: RotatedRect; score: number }[] = [];
  const stack: number[] = [];
  for (let start = 0; start < map.length && regions.length < MAX_CANDIDATES; start += 1) {
    if (seen[start] || map[start] <= BIN_THRESHOLD) continue;
    seen[start] = 1;
    stack.push(start);
    const edge: Point[] = [];
    let sum = 0;
    let count = 0;
    while (stack.length) {
      const index = stack.pop()!;
      const x = index % width;
      const y = (index - x) / width;
      sum += map[index];
      count += 1;
      let boundary = false;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) {
          boundary = true;
          continue;
        }
        const next = ny * width + nx;
        if (map[next] <= BIN_THRESHOLD) {
          boundary = true;
          continue;
        }
        if (!seen[next]) {
          seen[next] = 1;
          stack.push(next);
        }
      }
      // Pixel corners of boundary pixels are enough for the hull.
      if (boundary) edge.push([x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1]);
    }
    if (count < 6) continue;
    const score = sum / count;
    if (score < BOX_THRESHOLD) continue;
    const rect = minAreaRect(convexHull(edge));
    if (Math.min(rect.width, rect.height) < 3) continue;
    regions.push({ rect: unclip(rect), score });
  }
  return regions;
}

/** CTC greedy decoding: best class per step, merge repeats, drop blanks. */
export function ctcDecode(probs: Float32Array, steps: number, classes: number, dictionary: readonly string[]): { text: string; score: number } {
  let text = '';
  let previous = -1;
  let total = 0;
  let kept = 0;
  for (let t = 0; t < steps; t += 1) {
    let best = 0;
    let bestValue = -Infinity;
    const base = t * classes;
    for (let c = 0; c < classes; c += 1) {
      if (probs[base + c] > bestValue) {
        bestValue = probs[base + c];
        best = c;
      }
    }
    if (best !== 0 && best !== previous) {
      // Class 0 is blank, then the dictionary, then a final space.
      text += best - 1 < dictionary.length ? dictionary[best - 1] : ' ';
      total += bestValue;
      kept += 1;
    }
    previous = best;
  }
  return { text: text.trim(), score: kept ? total / kept : 0 };
}

/* Inference ------------------------------------------------------------------ */

type Ort = Awaited<ReturnType<typeof getOrt>>;
type Session = Awaited<ReturnType<Ort['InferenceSession']['create']>>;
let models: { det: Session; rec: Session; ort: Ort; dictionary: string[] } | null = null;

async function cachedModel(url: string, expected: number, onBytes: (loaded: number) => void, signal?: AbortSignal): Promise<Uint8Array> {
  const cache = typeof caches === 'undefined' ? null : await caches.open(OCR_CACHE).catch(() => null);
  const hit = await cache?.match(url);
  if (hit) {
    const bytes = new Uint8Array(await hit.arrayBuffer());
    onBytes(bytes.byteLength);
    return bytes;
  }
  const bytes = await fetchWithProgress(url, (loaded) => onBytes(loaded), { signal, expectedBytes: expected });
  await cache?.put(url, new Response(bytes)).catch(() => undefined);
  return new Uint8Array(bytes);
}

export function ocrReady(): boolean {
  return models !== null;
}

export async function loadOcr(onProgress?: (loaded: number, total: number) => void, signal?: AbortSignal): Promise<void> {
  if (models) return;
  let det = 0;
  let rec = 0;
  const report = () => onProgress?.(det + rec, OCR_BYTES);
  const [detBytes, recBytes, dictionary] = await Promise.all([
    cachedModel(DET_URL, DET_BYTES, (bytes) => { det = bytes; report(); }, signal),
    cachedModel(REC_URL, REC_BYTES, (bytes) => { rec = bytes; report(); }, signal),
    import('./ocr-dict.json').then((module) => module.default as string[]),
  ]);
  const ort = await getOrt('wasm');
  const options = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' } as Parameters<Ort['InferenceSession']['create']>[1];
  const [detSession, recSession] = await Promise.all([
    ort.InferenceSession.create(detBytes, options),
    ort.InferenceSession.create(recBytes, options),
  ]);
  models = { det: detSession, rec: recSession, ort, dictionary };
}

/** Sample the source image into a canvas-free BGR CHW tensor. */
function bgrTensor(
  sample: (x: number, y: number, out: number[]) => void,
  width: number,
  height: number,
  normalize: (channel: number, value: number) => number,
): Float32Array {
  const out = new Float32Array(3 * width * height);
  const rgb = [0, 0, 0];
  const plane = width * height;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      sample(x, y, rgb);
      const index = y * width + x;
      // PaddleOCR feeds BGR images.
      out[index] = normalize(0, rgb[2]);
      out[plane + index] = normalize(1, rgb[1]);
      out[2 * plane + index] = normalize(2, rgb[0]);
    }
  }
  return out;
}

/** Bilinear sample of the source at (x, y) in source pixels. */
function sampler(image: OcrImage) {
  const { data, width, height, channels } = image;
  // Clamp coordinates once per sample instead of 8 times (once per channel
  // lookup). Sampling values are unchanged, so OCR accuracy is preserved.
  const channelIndex = [0, 1, 2].map((value) => Math.min(value, channels - 1));
  return (fx: number, fy: number, out: number[]) => {
    const rawX = Math.floor(fx);
    const rawY = Math.floor(fy);
    const ax = fx - rawX;
    const ay = fy - rawY;
    const x0 = Math.min(width - 1, Math.max(0, rawX));
    const y0 = Math.min(height - 1, Math.max(0, rawY));
    const x1 = Math.min(width - 1, x0 + 1);
    const y1 = Math.min(height - 1, y0 + 1);
    const topLeft = (y0 * width + x0) * channels;
    const topRight = (y0 * width + x1) * channels;
    const bottomLeft = (y1 * width + x0) * channels;
    const bottomRight = (y1 * width + x1) * channels;
    const topWeight = 1 - ax;
    const leftWeight = 1 - ay;
    for (let c = 0; c < 3; c += 1) {
      const channel = channelIndex[c];
      const top = data[topLeft + channel] * topWeight + data[topRight + channel] * ax;
      const bottom = data[bottomLeft + channel] * topWeight + data[bottomRight + channel] * ax;
      out[c] = top * leftWeight + bottom * ay;
    }
  };
}

const DET_MEAN = [0.485, 0.456, 0.406];
const DET_STD = [0.229, 0.224, 0.225];

export async function runOcr(image: OcrImage, options: { maxSide?: number; signal?: AbortSignal; onProgress?: (fraction: number, text: string) => void } = {}): Promise<OcrLine[]> {
  if (!models) throw new Error('Load the OCR model first.');
  const { det, rec, ort, dictionary } = models;
  const sample = sampler(image);

  // Detection at up to maxSide pixels, both sides multiples of 32.
  const maxSide = options.maxSide ?? 1280;
  const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
  const detWidth = Math.max(32, Math.round((image.width * scale) / 32) * 32);
  const detHeight = Math.max(32, Math.round((image.height * scale) / 32) * 32);
  const sx = image.width / detWidth;
  const sy = image.height / detHeight;
  const detInput = bgrTensor(
    (x, y, out) => sample((x + 0.5) * sx - 0.5, (y + 0.5) * sy - 0.5, out),
    detWidth,
    detHeight,
    (channel, value) => (value / 255 - DET_MEAN[channel]) / DET_STD[channel],
  );
  options.onProgress?.(0.05, 'Finding text');
  const detOut = await det.run({ x: new ort.Tensor('float32', detInput, [1, 3, detHeight, detWidth]) });
  const mapTensor = Object.values(detOut)[0];
  const map = mapTensor.data as Float32Array;
  const regions = findTextRegions(map, detWidth, detHeight);
  for (const tensor of Object.values(detOut)) tensor.dispose?.();

  // Back to source pixels, reading order: top to bottom, then left to right.
  const boxes = regions.map(({ rect }) => ({
    ...rect,
    cx: rect.cx * sx,
    cy: rect.cy * sy,
    width: rect.width * (Math.abs(Math.cos(rect.angle)) * sx + Math.abs(Math.sin(rect.angle)) * sy),
    height: rect.height * (Math.abs(Math.sin(rect.angle)) * sx + Math.abs(Math.cos(rect.angle)) * sy),
  }));
  boxes.sort((a, b) => (Math.abs(a.cy - b.cy) < Math.min(a.height, b.height) * 0.5 ? a.cx - b.cx : a.cy - b.cy));

  const lines: OcrLine[] = [];
  for (const [i, box] of boxes.entries()) {
    options.signal?.throwIfAborted();
    options.onProgress?.(0.1 + 0.9 * (i / Math.max(1, boxes.length)), `Reading line ${i + 1} of ${boxes.length}`);
    const width = Math.min(REC_MAX_WIDTH, Math.max(8, Math.round((REC_HEIGHT * box.width) / Math.max(1, box.height))));
    const cos = Math.cos(box.angle);
    const sin = Math.sin(box.angle);
    const recInput = bgrTensor(
      (x, y, out) => {
        // Map strip pixel → rectangle coordinates → source pixel.
        const u = ((x + 0.5) / width - 0.5) * box.width;
        const v = ((y + 0.5) / REC_HEIGHT - 0.5) * box.height;
        sample(box.cx + u * cos - v * sin - 0.5, box.cy + u * sin + v * cos - 0.5, out);
      },
      width,
      REC_HEIGHT,
      (_, value) => (value / 255 - 0.5) / 0.5,
    );
    const recOut = await rec.run({ x: new ort.Tensor('float32', recInput, [1, 3, REC_HEIGHT, width]) });
    const tensor = Object.values(recOut)[0];
    const [, steps, classes] = tensor.dims as number[];
    const decoded = ctcDecode(tensor.data as Float32Array, steps, classes, dictionary);
    for (const out of Object.values(recOut)) out.dispose?.();
    if (decoded.text && decoded.score >= 0.5) lines.push({ text: decoded.text, score: decoded.score, box: rectCorners(box) });
  }
  return lines;
}
