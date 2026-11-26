import { expect, test } from 'bun:test';
import { QUICK_TOOLS, quickTool } from '../src/quick-catalog';
import { QUICK_LANGUAGES, quickTranslate } from '../src/quick-locale';
import { clipRange, fitVideo, parseTime, splitImageStream, tempoFilters, timeLabel, VIDEO_FORMATS } from '../src/quick-video';
import { parseProbe } from '../src/audio-ffmpeg';

test('the quick tool catalog retains stable routes and translated titles', () => {
  expect(QUICK_TOOLS).toHaveLength(16);
  expect(new Set(QUICK_TOOLS.map(([id]) => id)).size).toBe(16);
  expect(Object.keys(VIDEO_FORMATS)).toHaveLength(8);
  expect(quickTool(null)).toBe('video-converter');
  for (const [locale] of QUICK_LANGUAGES.slice(1)) {
    for (const [id, title] of QUICK_TOOLS) {
      expect(quickTool(id)).toBe(id);
      expect(quickTranslate(locale, title)).not.toBe(title);
    }
  }
});

test('exact range accepts millisecond input and rejects invalid boundaries', () => {
  expect(parseTime('01:03:02.125')).toBe(3782.125);
  expect(timeLabel(3782.125)).toBe('01:03:02.125');
  expect(parseTime('00:61:00')).toBeNaN();
  expect(parseTime('1.5:14')).toBeNaN();
  expect(clipRange(0.125, 1.235, 1.2346)).toEqual({ start: 0.125, end: 1.2346 });
  expect(() => clipRange(1.5, 0.5, 3)).toThrow();
});

test('video output preserves orientation and extreme audio rates decompose safely', () => {
  expect(fitVideo({ width: 2160, height: 3840 }, 720)).toEqual({ width: 720, height: 1280 });
  const chain = (speed: number) => tempoFilters(speed).map(filter => Number(filter.split('=')[1]));
  for (const speed of [0.1, 0.25, 0.5, 1, 2, 4, 16]) {
    expect(chain(speed).every(step => step >= 0.5 && step <= 2)).toBe(true);
    expect(chain(speed).reduce((product, step) => product * step, 1)).toBeCloseTo(speed, 5);
  }
  expect(parseProbe('Stream #0:0: Video: h264 (avc1), yuv420p, 1920x1080\n displaymatrix: rotation of -90.00 degrees').rotation).toBe(-90);
});

test('frame splitting respects image boundaries and reports corrupt streams', async () => {
  // Minimal JPEG markers are sufficient to exercise the pipe boundary parser.
  const stream = Uint8Array.of(255, 216, 10, 255, 217, 255, 216, 20, 255, 217);
  const frames = splitImageStream(stream, 'jpg');
  expect(frames.map(frame => frame.size)).toEqual([5, 5]);
  expect(new Uint8Array(await frames[1].arrayBuffer())[2]).toBe(20);
  expect(() => splitImageStream(stream.subarray(0, 8), 'jpg')).toThrow();
});
