import { describe, expect, test } from 'bun:test';
import { normalizeEffects } from '../src/video-effects';
import {
  VIDEO_EFFECTS,
  applyVideoEffect,
  resetVideoEffects,
  type VideoEffectPreset,
} from '../src/video-effect-presets';

const preset = (id: string): VideoEffectPreset => {
  const found = VIDEO_EFFECTS.find((effect) => effect.id === id);
  if (!found) throw new Error('Missing effect preset: ' + id);
  return found;
};

describe('effect preset library', () => {
  test('has unique, complete presets in every category', () => {
    expect(new Set(VIDEO_EFFECTS.map((effect) => effect.id)).size).toBe(VIDEO_EFFECTS.length);
    for (const category of ['basic', 'color', 'blur', 'creative', 'stylize']) {
      expect(VIDEO_EFFECTS.some((effect) => effect.category === category)).toBe(true);
    }
    expect(VIDEO_EFFECTS.every((effect) =>
      Boolean(effect.name && effect.description && effect.filter))).toBe(true);
  });

  test('stacks colour adjustments on top of the current clip', () => {
    expect(applyVideoEffect(preset('brightness')).brightness).toBe(15);
    expect(applyVideoEffect(preset('contrast'), { brightness: 10 }).contrast).toBe(20);
    expect(applyVideoEffect(preset('brightness'), { brightness: 95 }).brightness).toBe(100);
    expect(applyVideoEffect(preset('mono'), { saturation: 40 }).saturation).toBe(-60);
    expect(applyVideoEffect(preset('tonal-balance')).curve).toEqual({
      shadows: 8,
      midtones: 4,
      highlights: -6,
    });
  });

  test('resets the colour stack but preserves masks, keying, LUTs, and speed', () => {
    const current = normalizeEffects({
      brightness: 42,
      contrast: 20,
      saturation: -10,
      hue: 60,
      blur: 5,
      opacity: 0.4,
      blend: 'screen',
      mask: { shape: 'rect', x: 10, y: 10, width: 80, height: 60, feather: 2 },
      chroma: { enabled: true, color: '#00ff00', tolerance: 0.3, softness: 0.1 },
      speed: 2,
      curve: { shadows: 12, midtones: -4, highlights: 8 },
    });
    const reset = resetVideoEffects(current);
    expect(reset.brightness).toBe(0);
    expect(reset.contrast).toBe(0);
    expect(reset.saturation).toBe(0);
    expect(reset.hue).toBe(0);
    expect(reset.blur).toBe(0);
    expect(reset.curve).toEqual({ shadows: 0, midtones: 0, highlights: 0 });
    expect(reset.mask).toEqual(current.mask);
    expect(reset.chroma).toEqual(current.chroma);
    expect(reset.speed).toBe(2);
    expect(reset.opacity).toBe(0.4);
    expect(reset.blend).toBe('screen');
  });
});
