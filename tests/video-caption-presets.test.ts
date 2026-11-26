import { expect, test } from 'bun:test';
import { textStyleFromCaption } from '../src/captions';
import { normalizeCaptionPreset, presetCaptionStyle } from '../src/video-caption-presets';

test('caption presets change typography and treatment while honoring position and size', () => {
  const layout = { position: 'top' as const, scale: 1.25 };
  const streaming = presetCaptionStyle('streaming', layout);
  const anime = presetCaptionStyle('anime', layout);
  expect(streaming.y).toBe(anime.y);
  expect(streaming.fontSize).toBeCloseTo(presetCaptionStyle('streaming').fontSize * 1.25);
  expect(streaming.fontFamily).toContain('Arial');
  expect(streaming.backgroundOpacity).toBeGreaterThan(0);
  expect(anime.backgroundOpacity).toBe(0);
  expect(anime.outlineWidth).toBeGreaterThan(streaming.outlineWidth);
  expect(presetCaptionStyle(normalizeCaptionPreset(undefined), layout)).toEqual(textStyleFromCaption(layout));
});
