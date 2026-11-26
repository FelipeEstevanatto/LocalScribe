// Export-only pixel effects (chroma key, tone curve, 3D LUT) on the CPU.
//
//   bun bench/pixel-effects.ts [--width 1920] [--height 1080] [--runs 7]
//
// Also importable in the browser from the Vite dev server:
//   const m = await import('/bench/pixel-effects.ts'); await m.run({ width: 1920, height: 1080 })
//
// It times src/video-effects.ts applyPixelEffects() against a prototype with
// the same arithmetic (per-byte reciprocal tables, no per-pixel closures, a
// typed-array LUT) and checks that both write bit-identical pixels. The
// prototype lives only here; nothing in src/ is changed.
import { applyPixelEffects, normalizeEffects, toneTable, type ClipEffects } from '../src/video-effects';

interface ImageLike { data: Uint8ClampedArray; width: number; height: number }

function makeFrame(width: number, height: number): ImageLike {
  const data = new Uint8ClampedArray(width * height * 4);
  let seed = 12345;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      seed = (seed * 1103515245 + 12345) >>> 0;
      const green = (x + y) % 7 === 0;
      data[index] = green ? 8 : (x * 255) / width;
      data[index + 1] = green ? 250 : (y * 255) / height;
      data[index + 2] = green ? 12 : seed >>> 24;
      data[index + 3] = 255;
    }
  }
  return { data, width, height };
}

function warmLut(size = 33): { name: string; size: number; data: number[] } {
  const data: number[] = [];
  for (let b = 0; b < size; b += 1) {
    for (let g = 0; g < size; g += 1) {
      for (let r = 0; r < size; r += 1) data.push(Math.min(1, (r / (size - 1)) * 1.04), g / (size - 1), Math.max(0, (b / (size - 1)) * 0.96));
    }
  }
  return { name: 'warm', size, data };
}

function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace('#', '');
  return [Number.parseInt(value.slice(0, 2), 16) / 255, Number.parseInt(value.slice(2, 4), 16) / 255, Number.parseInt(value.slice(4, 6), 16) / 255];
}

const INV255 = new Float64Array(256);
for (let byte = 0; byte < 256; byte += 1) INV255[byte] = byte / 255;
// Math.round((b / 255) * 255) === b for every byte, so a tone lookup by byte is
// the same index the original computes.
for (let byte = 0; byte < 256; byte += 1) {
  if (Math.round(INV255[byte] * 255) !== byte) throw new Error('Byte round-trip assumption failed at ' + byte);
}

/** Prototype: identical arithmetic, fewer allocations and lookups per pixel. */
export function applyPixelEffectsPrototype(image: ImageLike, value?: Partial<ClipEffects> | null): void {
  const effects = normalizeEffects(value);
  const data = image.data;
  const curve = effects.curve;
  const tone = (curve.shadows || curve.midtones || curve.highlights) ? toneTable(curve) : null;
  // Tone output as the same doubles the original produces: table[i] / 255.
  const toneNorm = tone ? Float64Array.from(tone, (entry) => entry / 255) : null;
  const lut = effects.lut;
  const values = lut ? Float64Array.from(lut.data) : null;
  const n = lut ? lut.size : 0;
  const stride = n * 3;
  const plane = stride * n;
  const key = effects.chroma.enabled ? hexToRgb(effects.chroma.color) : null;
  const k0 = key ? key[0] : 0, k1 = key ? key[1] : 0, k2 = key ? key[2] : 0;
  const tolerance = effects.chroma.tolerance;
  const softness = Math.max(0.0001, effects.chroma.softness);
  for (let index = 0; index < data.length; index += 4) {
    if (data[index + 3] === 0) continue;
    let r: number, g: number, b: number;
    if (key) {
      r = INV255[data[index]];
      g = INV255[data[index + 1]];
      b = INV255[data[index + 2]];
      const dr = r - k0, dg = g - k1, db = b - k2;
      const distance = Math.sqrt(dr * dr * 0.5 + dg * dg + db * db * 0.5);
      if (distance < tolerance) {
        data[index + 3] = 0;
        continue;
      }
      if (distance < tolerance + softness) data[index + 3] = Math.round(data[index + 3] * ((distance - tolerance) / softness));
    }
    if (toneNorm) {
      r = toneNorm[data[index]];
      g = toneNorm[data[index + 1]];
      b = toneNorm[data[index + 2]];
    } else {
      r = INV255[data[index]];
      g = INV255[data[index + 1]];
      b = INV255[data[index + 2]];
    }
    if (values) {
      const rf = Math.max(0, Math.min(n - 1, r * (n - 1)));
      const gf = Math.max(0, Math.min(n - 1, g * (n - 1)));
      const bf = Math.max(0, Math.min(n - 1, b * (n - 1)));
      const r0 = Math.floor(rf), g0 = Math.floor(gf), b0 = Math.floor(bf);
      const r1 = Math.min(n - 1, r0 + 1), g1 = Math.min(n - 1, g0 + 1), b1 = Math.min(n - 1, b0 + 1);
      const tr = rf - r0, tg = gf - g0, tb = bf - b0;
      const greenStep = (g1 - g0) * stride;
      const redStep = (r1 - r0) * 3;
      let lowIndex = b0 * plane + g0 * stride + r0 * 3;
      let highIndex = b1 * plane + g0 * stride + r0 * 3;
      let out0 = 0, out1 = 0, out2 = 0;
      for (let channel = 0; channel < 3; channel += 1, lowIndex += 1, highIndex += 1) {
        let base = values[lowIndex];
        const lowGreen = base + (values[lowIndex + redStep] - base) * tr;
        base = values[highIndex];
        const highGreen = base + (values[highIndex + redStep] - base) * tr;
        base = values[lowIndex + greenStep];
        const lowBlue = lowGreen + ((base + (values[lowIndex + greenStep + redStep] - base) * tr) - lowGreen) * tg;
        base = values[highIndex + greenStep];
        const highBlue = highGreen + ((base + (values[highIndex + greenStep + redStep] - base) * tr) - highGreen) * tg;
        const value = lowBlue + (highBlue - lowBlue) * tb;
        if (channel === 0) out0 = value;
        else if (channel === 1) out1 = value;
        else out2 = value;
      }
      r = out0; g = out1; b = out2;
    }
    data[index] = Math.round(r * 255);
    data[index + 1] = Math.round(g * 255);
    data[index + 2] = Math.round(b * 255);
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

export async function run(options: { width?: number; height?: number; runs?: number } = {}) {
  const width = options.width ?? 1920;
  const height = options.height ?? 1080;
  const runs = options.runs ?? 7;
  const cases: Record<string, Partial<ClipEffects>> = {
    chroma: { chroma: { enabled: true, color: '#00ff00', tolerance: 0.24, softness: 0.12 } },
    tone: { curve: { shadows: 8, midtones: 5, highlights: -6 } },
    lut33: { lut: warmLut(33) },
    all: { chroma: { enabled: true, color: '#00ff00', tolerance: 0.24, softness: 0.12 }, curve: { shadows: 8, midtones: 5, highlights: -6 }, lut: warmLut(33) },
  };
  const source = makeFrame(width, height);
  const results: Record<string, unknown> = {};
  for (const [name, effects] of Object.entries(cases)) {
    const original: number[] = [];
    const prototype: number[] = [];
    let identical = true;
    for (let run = 0; run <= runs; run += 1) {
      const a = { ...source, data: new Uint8ClampedArray(source.data) };
      const b = { ...source, data: new Uint8ClampedArray(source.data) };
      let start = performance.now();
      applyPixelEffects(a as unknown as ImageData, effects);
      const t1 = performance.now() - start;
      start = performance.now();
      applyPixelEffectsPrototype(b, effects);
      const t2 = performance.now() - start;
      if (run > 0) {
        original.push(t1);
        prototype.push(t2);
      }
      if (run === runs) {
        for (let index = 0; index < a.data.length; index += 1) {
          if (a.data[index] !== b.data[index]) {
            identical = false;
            break;
          }
        }
      }
    }
    results[name] = {
      originalMedianMs: +median(original).toFixed(1),
      originalMaxMs: +Math.max(...original).toFixed(1),
      prototypeMedianMs: +median(prototype).toFixed(1),
      prototypeMaxMs: +Math.max(...prototype).toFixed(1),
      speedup: +(median(original) / median(prototype)).toFixed(2),
      bitIdentical: identical,
    };
  }
  return { benchmark: 'pixel-effects', width, height, runs, runtime: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown', results };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (name: string, fallback: number) => {
    const index = args.indexOf(name);
    return index >= 0 ? Number(args[index + 1]) : fallback;
  };
  console.log(JSON.stringify(await run({ width: flag('--width', 1920), height: flag('--height', 1080), runs: flag('--runs', 7) }), null, 2));
}
