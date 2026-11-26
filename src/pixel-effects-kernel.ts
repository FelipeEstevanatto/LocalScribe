/**
 * The export-only per-pixel pass (chroma key, tone curve, 3D LUT) as a plain
 * function over RGBA bytes, so the page and the pixel-effects workers run the
 * same code. Same arithmetic as the first version, with per-byte reciprocal
 * tables, no per-pixel closures and the LUT in a Float64Array: about 23%
 * faster per 1080p frame and bit-identical (bench/pixel-effects.ts).
 */

export interface PixelPass {
  /** Key colour as 0-1 RGB, or null when chroma key is off. */
  key: [number, number, number] | null;
  tolerance: number;
  softness: number;
  /** Tone curve output per input byte, already divided by 255. */
  tone: Float64Array | null;
  lutSize: number;
  /** size³ × RGB LUT values. */
  lut: Float64Array | null;
}

const INV255 = new Float64Array(256);
for (let byte = 0; byte < 256; byte += 1) INV255[byte] = byte / 255;

/** Apply the pass to RGBA bytes in [start, end) (multiples of 4). */
export function runPixelPass(data: Uint8ClampedArray, pass: PixelPass, start = 0, end = data.length): void {
  const { key, tone, lut: values } = pass;
  const n = pass.lutSize;
  const stride = n * 3;
  const plane = stride * n;
  const k0 = key ? key[0] : 0;
  const k1 = key ? key[1] : 0;
  const k2 = key ? key[2] : 0;
  const tolerance = pass.tolerance;
  const softness = pass.softness;
  for (let index = start; index < end; index += 4) {
    if (data[index + 3] === 0) continue;
    let r: number;
    let g: number;
    let b: number;
    if (key) {
      // Chroma distance favours the green/blue difference, like a real keyer.
      r = INV255[data[index]];
      g = INV255[data[index + 1]];
      b = INV255[data[index + 2]];
      const dr = r - k0;
      const dg = g - k1;
      const db = b - k2;
      const distance = Math.sqrt(dr * dr * 0.5 + dg * dg + db * db * 0.5);
      if (distance < tolerance) {
        data[index + 3] = 0;
        continue;
      }
      if (distance < tolerance + softness) data[index + 3] = Math.round(data[index + 3] * ((distance - tolerance) / softness));
    }
    if (tone) {
      r = tone[data[index]];
      g = tone[data[index + 1]];
      b = tone[data[index + 2]];
    } else {
      r = INV255[data[index]];
      g = INV255[data[index + 1]];
      b = INV255[data[index + 2]];
    }
    if (values) {
      const rf = Math.max(0, Math.min(n - 1, r * (n - 1)));
      const gf = Math.max(0, Math.min(n - 1, g * (n - 1)));
      const bf = Math.max(0, Math.min(n - 1, b * (n - 1)));
      const r0 = Math.floor(rf);
      const g0 = Math.floor(gf);
      const b0 = Math.floor(bf);
      const r1 = Math.min(n - 1, r0 + 1);
      const g1 = Math.min(n - 1, g0 + 1);
      const b1 = Math.min(n - 1, b0 + 1);
      const tr = rf - r0;
      const tg = gf - g0;
      const tb = bf - b0;
      const greenStep = (g1 - g0) * stride;
      const redStep = (r1 - r0) * 3;
      let lowIndex = b0 * plane + g0 * stride + r0 * 3;
      let highIndex = b1 * plane + g0 * stride + r0 * 3;
      let out0 = 0;
      let out1 = 0;
      let out2 = 0;
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
      r = out0;
      g = out1;
      b = out2;
    }
    data[index] = Math.round(r * 255);
    data[index + 1] = Math.round(g * 255);
    data[index + 2] = Math.round(b * 255);
  }
}
