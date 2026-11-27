import { describe, expect, test } from 'bun:test';
import { i420Size, planesToI420, scalePlane } from '../src/yuv-frames';

describe('YUV plane scaling', () => {
  test('same size copies the visible rows (planar and interleaved)', () => {
    const source = Uint8Array.from({ length: 4 * 3 }, (_, i) => i);
    const out = new Uint8Array(3 * 2);
    scalePlane(source, 0, 4, 1, 3, 2, out, 0, 3, 2);
    expect([...out]).toEqual([0, 1, 2, 4, 5, 6]);
    // NV12-style: every second byte, starting at offset 1.
    const nv = Uint8Array.from([10, 20, 11, 21, 12, 22, 13, 23]);
    const v = new Uint8Array(2 * 2);
    scalePlane(nv, 1, 4, 2, 2, 2, v, 0, 2, 2);
    expect([...v]).toEqual([20, 21, 22, 23]);
  });

  test('a flat plane stays flat and a ramp stays a ramp when downscaled', () => {
    const flat = new Uint8Array(1920 * 1080).fill(77);
    const small = new Uint8Array(1280 * 720);
    scalePlane(flat, 0, 1920, 1, 1920, 1080, small, 0, 1280, 720);
    expect(small.every((value) => value === 77)).toBe(true);
    const ramp = Uint8Array.from({ length: 256 * 4 }, (_, i) => i % 256);
    const half = new Uint8Array(128 * 2);
    scalePlane(ramp, 0, 256, 1, 256, 4, half, 0, 128, 2);
    for (let x = 1; x < 128; x += 1) expect(half[x]).toBeGreaterThan(half[x - 1]);
    expect(half[0]).toBeLessThanOrEqual(1);
    expect(half[127]).toBeGreaterThanOrEqual(254);
  });

  test('NV12 and I420 planes give the same I420 frame', () => {
    const width = 8;
    const height = 4;
    const luma = Uint8Array.from({ length: width * height }, (_, i) => i * 3);
    const u = Uint8Array.from({ length: 8 }, (_, i) => 100 + i);
    const v = Uint8Array.from({ length: 8 }, (_, i) => 200 + i);
    const i420 = new Uint8Array([...luma, ...u, ...v]);
    const nv12 = new Uint8Array([...luma, ...[...u].flatMap((value, i) => [value, v[i]])]);
    const fromI420 = planesToI420({ buffer: i420, format: 'I420', width, height,
      layout: [{ offset: 0, stride: 8 }, { offset: 32, stride: 4 }, { offset: 40, stride: 4 }] }, 4, 2);
    const fromNv12 = planesToI420({ buffer: nv12, format: 'NV12', width, height,
      layout: [{ offset: 0, stride: 8 }, { offset: 32, stride: 8 }] }, 4, 2);
    expect([...fromNv12]).toEqual([...fromI420]);
    expect(fromI420.length).toBe(i420Size(4, 2));
  });

  test('I420 size', () => {
    expect(i420Size(1280, 720)).toBe(1280 * 720 * 1.5);
  });
});
