import { describe, expect, test } from 'bun:test';
import { retimeSlots } from '../src/quick-video-browser';

function picked(speed: number, sourceFps: number, outputFps: number, seconds: number): number[][] {
  const total = Math.round((seconds / speed) * outputFps);
  const slots: number[][] = Array.from({ length: total }, () => []);
  let next = 0;
  for (let frame = 0; frame < seconds * sourceFps; frame += 1) {
    const [first, last] = retimeSlots(frame / sourceFps, 1 / sourceFps, speed, outputFps, next, total);
    for (let slot = first; slot < last; slot += 1) slots[slot].push(frame);
    next = Math.max(next, last);
  }
  return slots;
}

describe('change-speed frame placement', () => {
  test('a speed-up keeps every Nth frame, starting with the first', () => {
    expect(picked(2, 30, 30, 1).map((s) => s[0])).toEqual(Array.from({ length: 15 }, (_, i) => i * 2));
    expect(picked(4, 30, 30, 2).map((s) => s[0])).toEqual(Array.from({ length: 15 }, (_, i) => i * 4));
  });

  test('slow motion repeats each frame and fills every slot once', () => {
    const slots = picked(0.5, 30, 30, 1);
    expect(slots).toHaveLength(60);
    expect(slots.every((s) => s.length === 1)).toBe(true);
    expect(slots.map((s) => s[0])).toEqual(Array.from({ length: 60 }, (_, i) => Math.floor(i / 2)));
  });

  test('a non-integer speed still fills each slot exactly once, in order', () => {
    const slots = picked(1.5, 30, 30, 3);
    expect(slots).toHaveLength(60);
    expect(slots.every((s) => s.length === 1)).toBe(true);
    const frames = slots.map((s) => s[0]);
    expect(frames.every((f, i) => i === 0 || f > frames[i - 1])).toBe(true);
  });
});
