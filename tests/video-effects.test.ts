import { describe, expect, test } from 'bun:test';
import {
  animationAt,
  cssFilter,
  hasMotionTransition,
  maskClipPath,
  maskCssStyles,
  motionTransitionAt,
  motionTransitionLabel,
  normalizeClipTransition,
  normalizeEffects,
  parseCubeLut,
  valueAt,
  volumeExpression,
} from '../src/video-effects';
import { canCopyVideo, clipTransform, hasClipTransform, videoClipLength, type MergeVideo } from '../src/video-merge-args';

const probe = {
  duration: 10,
  hasVideo: true,
  hasAudio: true,
  videoCodec: 'avc',
  audioCodec: 'aac',
  width: 1920,
  height: 1080,
  fps: 30,
  rotation: 0,
  audioStreams: [],
};

const clip = (overrides: Partial<MergeVideo> = {}): MergeVideo => ({
  duration: 10,
  probe,
  ...overrides,
});

describe('keyframes', () => {
  test('interpolates linearly between keys', () => {
    expect(valueAt([{ at: 1, value: 0 }, { at: 3, value: 10 }], 2, 99)).toBe(5);
    expect(valueAt([{ at: 1, value: 0 }, { at: 3, value: 10 }], 0, 99)).toBe(0);
    expect(valueAt([{ at: 1, value: 0 }, { at: 3, value: 10 }], 5, 99)).toBe(10);
  });

  test('honours easing and hold', () => {
    expect(valueAt([{ at: 0, value: 0 }, { at: 1, value: 10, easing: 'ease-in' }], 0.5, 0)).toBeCloseTo(2.5, 4);
    expect(valueAt([{ at: 0, value: 0 }, { at: 1, value: 10, easing: 'ease-out' }], 0.5, 0)).toBeCloseTo(7.5, 4);
    expect(valueAt([{ at: 0, value: 0 }, { at: 1, value: 10, easing: 'hold' }], 0.99, 0)).toBe(0);
    expect(valueAt([{ at: 0, value: 0 }, { at: 1, value: 10, easing: 'hold' }, { at: 2, value: 20 }], 1, 0)).toBe(10);
  });

  test('applies animated transform and opacity over the base values', () => {
    const state = animationAt({
      scale: [{ at: 0, value: 1 }, { at: 2, value: 2 }],
      x: [{ at: 0, value: 0 }, { at: 2, value: 50 }],
      opacity: [{ at: 0, value: 1 }, { at: 2, value: 0.5 }],
    }, 1, { transform: { scale: 1, x: 0, y: 0, rotation: 0 }, opacity: 1, volume: 1 });
    expect(state.transform.scale).toBe(1.5);
    expect(state.transform.x).toBe(25);
    expect(state.opacity).toBe(0.75);
  });
});

describe('effects', () => {
  test('normalizes out-of-range values', () => {
    const effects = normalizeEffects({ brightness: 400, speed: 99, opacity: -1 });
    expect(effects.brightness).toBe(100);
    expect(effects.speed).toBe(4);
    expect(effects.opacity).toBe(0);
  });

  test('builds a CSS filter from colour controls', () => {
    expect(cssFilter({ brightness: 20, contrast: -10, saturation: 50, hue: 90, blur: 4 }))
      .toBe('brightness(1.2) contrast(0.9) saturate(1.5) hue-rotate(90deg) blur(4px)');
  });

  test('keeps unfeathered masks on clip-path and feathers with an SVG mask', () => {
    const none = maskCssStyles({}, 640, 360);
    expect(none).toEqual({ clipPath: '', maskImage: '' });
    const hard = maskCssStyles({
      mask: { shape: 'rect', x: 10, y: 10, width: 50, height: 50, feather: 0 },
    }, 640, 360);
    expect(hard.clipPath).toBe(maskClipPath({
      mask: { shape: 'rect', x: 10, y: 10, width: 50, height: 50, feather: 0 },
    }));
    expect(hard.maskImage).toBe('');
    const soft = maskCssStyles({
      mask: { shape: 'rect', x: 10, y: 10, width: 50, height: 50, feather: 9 },
    }, 640, 360);
    expect(soft.clipPath).toBe('');
    expect(soft.maskImage).toContain('data:image/svg+xml');
    expect(decodeURIComponent(soft.maskImage)).toContain('stdDeviation="32.4"');
    const ellipse = maskCssStyles({
      mask: { shape: 'ellipse', x: 10, y: 10, width: 50, height: 50, feather: 5 },
    }, 640, 360);
    expect(decodeURIComponent(ellipse.maskImage)).toContain('<ellipse');
  });

  test('parses a 2x2x2 cube LUT', () => {
    const data = Array.from({ length: 8 }, (_, index) => `${(index % 2)} ${Math.floor(index / 2) % 2} ${Math.floor(index / 4) % 2}`).join('\n');
    const lut = parseCubeLut(`TITLE "Test"\nLUT_3D_SIZE 2\n${data}\n`, 'test');
    expect(lut.size).toBe(2);
    expect(lut.data).toHaveLength(24);
    expect(lut.data[21]).toBe(1);
  });

  test('rejects malformed LUTs', () => {
    expect(() => parseCubeLut('0 0 0\n1 1 1\n')).toThrow();
  });

  test('turns volume keys into an FFmpeg expression', () => {
    const expression = volumeExpression([{ at: 0, value: 1 }, { at: 2, value: 0.5 }], 1);
    expect(expression).toContain('if(lt(t,2.000)');
    expect(expression).toContain('0.5000');
  });
});

describe('non-uniform transform stretch', () => {
  test('normalizes independent X/Y stretch and marks the transform', () => {
    const stretched = clipTransform({ scale: 1.2, scaleX: 1.5, scaleY: 0.75 });
    expect(stretched.scaleX).toBe(1.5);
    expect(stretched.scaleY).toBe(0.75);
    expect(hasClipTransform(stretched)).toBe(true);
    expect(hasClipTransform(clipTransform({}))).toBe(false);
    expect(clipTransform({ scaleX: 99 }).scaleX).toBe(10);
    expect(clipTransform({ scaleY: 0 }).scaleY).toBe(0.05);
  });

  test('preserves stretch through animation evaluation', () => {
    const state = animationAt([], 0, {
      transform: clipTransform({ scale: 1.1, scaleX: 1.4, scaleY: 0.8 }),
      opacity: 1,
      volume: 1,
    });
    expect(state.transform.scale).toBeCloseTo(1.1, 5);
    expect(state.transform.scaleX).toBeCloseTo(1.4, 5);
    expect(state.transform.scaleY).toBeCloseTo(0.8, 5);
  });
});

describe('motion transitions', () => {
  test('normalizes supported types and clamps the duration', () => {
    expect(normalizeClipTransition({ type: 'push', duration: 0.5 })).toEqual({ type: 'push', duration: 0.5 });
    expect(normalizeClipTransition({ type: 'split', duration: 99 })?.duration).toBe(2);
    expect(normalizeClipTransition({ type: 'wipe' as never })).toBeUndefined();
    expect(normalizeClipTransition(null)).toBeUndefined();
    expect(motionTransitionLabel('barn-door')).toBe('Barn door');
    expect(motionTransitionLabel(undefined)).toBe('None');
  });

  test('pushes and slides the clip into place', () => {
    expect(motionTransitionAt({ type: 'push', duration: 1 }, 0).offsetX).toBeCloseTo(100, 5);
    expect(motionTransitionAt({ type: 'push', duration: 1 }, 1).offsetX).toBe(0);
    expect(motionTransitionAt({ type: 'slide', duration: 1 }, 0).offsetY).toBeCloseTo(100, 5);
    expect(motionTransitionAt({ type: 'slide', duration: 1 }, 1).offsetY).toBe(0);
  });

  test('barn door and split reveal from the centre', () => {
    expect(motionTransitionAt({ type: 'barn-door', duration: 1 }, 0).reveal)
      .toEqual({ top: 0, right: 50, bottom: 0, left: 50 });
    expect(motionTransitionAt({ type: 'split', duration: 1 }, 0).reveal)
      .toEqual({ top: 50, right: 0, bottom: 50, left: 0 });
    expect(motionTransitionAt({ type: 'barn-door', duration: 1 }, 1).reveal).toBeNull();
  });

  test('motion transitions force a re-encode', () => {
    expect(canCopyVideo([clip({ transition: { type: 'push', duration: 0.5 } })], 'mp4')).toBe(false);
  });

  test('fade transitions carry alignment without becoming motion transitions', () => {
    const fade = normalizeClipTransition({ type: 'fade-in', duration: 0.5, alignment: 'end' });
    expect(fade).toEqual({ type: 'fade-in', duration: 0.5, alignment: 'end' });
    expect(hasMotionTransition(fade)).toBe(false);
    expect(motionTransitionAt(fade, 0)).toEqual({ offsetX: 0, offsetY: 0, reveal: null });
    expect(motionTransitionLabel(fade)).toBe('Fade in');
    expect(motionTransitionLabel('dip')).toBe('Dip to black');
    expect(canCopyVideo([clip({ transition: fade })], 'mp4')).toBe(false);
  });
});

describe('timeline length', () => {
  test('speed divides the visible length', () => {
    expect(videoClipLength(clip({ effects: { speed: 2 } }))).toBe(5);
    expect(videoClipLength(clip({ trimStart: 2, trimEnd: 2, effects: { speed: 2 } }))).toBe(3);
  });

  test('effects and keyframes disable stream copy', () => {
    expect(canCopyVideo([clip()], 'mp4')).toBe(true);
    expect(canCopyVideo([clip({ effects: { brightness: 10 } })], 'mp4')).toBe(false);
    expect(canCopyVideo([clip({ animation: { scale: [{ at: 0, value: 1 }, { at: 1, value: 1.2 }] } })], 'mp4')).toBe(false);
    expect(canCopyVideo([clip({ effects: { speed: 1.5 } })], 'mp4')).toBe(false);
  });
});
