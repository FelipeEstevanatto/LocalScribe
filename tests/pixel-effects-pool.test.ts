import { afterAll, describe, expect, test } from 'bun:test';
import { runPixelPass } from '../src/pixel-effects-kernel';
import { disposePixelWorkers, runPixelPassParallel } from '../src/pixel-effects-pool';
import { pixelPassFor } from '../src/video-effects';

function frame(width: number, height: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < data.length; index += 4) {
    data[index] = (index * 7) & 255;
    data[index + 1] = index % 36 === 0 ? 250 : (index * 3) & 255;
    data[index + 2] = (index * 13) & 255;
    data[index + 3] = index % 44 === 0 ? 0 : 255;
  }
  return data;
}

function lut(size: number): { name: string; size: number; data: number[] } {
  const data: number[] = [];
  for (let b = 0; b < size; b += 1) for (let g = 0; g < size; g += 1) for (let r = 0; r < size; r += 1) {
    data.push(Math.min(1, (r / (size - 1)) * 1.04), g / (size - 1), Math.max(0, (b / (size - 1)) * 0.96));
  }
  return { name: 'warm', size, data };
}

afterAll(() => disposePixelWorkers());

describe('pixel effects worker pool', () => {
  test('bands on workers give the same bytes as the page kernel', async () => {
    const pass = pixelPassFor({
      chroma: { enabled: true, color: '#00ff00', tolerance: 0.24, softness: 0.12 },
      curve: { shadows: 8, midtones: 5, highlights: -6 },
      lut: lut(9),
    })!;
    const source = frame(641, 479);
    const inline = new Uint8ClampedArray(source);
    runPixelPass(inline, pass);
    const parallel = new Uint8ClampedArray(source);
    await runPixelPassParallel(parallel, pass, 'warm-9');
    expect(Buffer.from(parallel).equals(Buffer.from(inline))).toBe(true);
    // A second frame reuses the LUT the workers already hold.
    const again = new Uint8ClampedArray(source);
    await runPixelPassParallel(again, pass, 'warm-9');
    expect(Buffer.from(again).equals(Buffer.from(inline))).toBe(true);
  });

  test('small frames run in the page', async () => {
    const pass = pixelPassFor({ curve: { shadows: 10, midtones: 0, highlights: 0 } })!;
    const source = frame(32, 32);
    const inline = new Uint8ClampedArray(source);
    runPixelPass(inline, pass);
    const parallel = new Uint8ClampedArray(source);
    await runPixelPassParallel(parallel, pass, null);
    expect(Buffer.from(parallel).equals(Buffer.from(inline))).toBe(true);
  });
});
