import { expect, test } from 'bun:test';
import { advanceSource, playbackSpans, playbackTime, ratesFromTimeline, speedAtSource } from '../src/video-retime';

test('speed points map source and timeline in both directions, including on a trim', () => {
  const rates = { speed: 1, speedPoints: [{ source: 2, rate: 2 }, { source: 4, rate: 0.5 }] };
  expect(playbackSpans(rates, 1, 5)).toEqual([
    { sourceStart: 1, sourceEnd: 2, start: 0, end: 1, rate: 1 },
    { sourceStart: 2, sourceEnd: 4, start: 1, end: 2, rate: 2 },
    { sourceStart: 4, sourceEnd: 5, start: 2, end: 4, rate: 0.5 },
  ]);
  expect(advanceSource(rates, 1, 1.5)).toBe(3);
  expect(advanceSource(rates, 5, -2.5)).toBe(3);
  expect(playbackTime(rates, 5) - playbackTime(rates, 1)).toBe(4);
  expect(speedAtSource(rates, 2)).toBe(2);
});

test('retimed key edits keep their requested timeline positions and retain hidden source points', () => {
  const rates = { speed: 1, speedPoints: [{ source: 0.5, rate: 0.5 }, { source: 8, rate: 1.5 }] };
  const changed = ratesFromTimeline(rates, 1, 7, [{ at: 0, value: 2 }, { at: 2, value: 0.5 }])!;
  expect(changed).toEqual({ speed: 1, speedPoints: [
    { source: 0.5, rate: 0.5 }, { source: 1, rate: 2 }, { source: 5, rate: 0.5 }, { source: 8, rate: 1.5 },
  ] });
  expect(playbackTime(changed, 5) - playbackTime(changed, 1)).toBe(2);
  expect(ratesFromTimeline(rates, 1, 7, [{ at: 0, value: 4 }, { at: 2, value: 0.5 }])).toBeNull();
});
