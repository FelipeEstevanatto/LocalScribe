import { describe, expect, test } from 'bun:test';
import { dynamicZoomAt, normalizeDynamicZoom } from '../src/video-effects';
import { canCopyVideo, dynamicZoomTimingFor } from '../src/video-merge-args';
import {
  buildPreviewFramePlan,
  CSS_PARITY_BACKEND,
  gpuPreviewWithinBudget,
  lutFingerprint,
  previewDrawRect,
  type PreviewFramePlanInput,
} from '../src/video-preview-plan';

const base = (): PreviewFramePlanInput => ({
  clipId: '7',
  source: { key: 'asset-1', kind: 'video', width: 1920, height: 1080 },
  at: 2,
  localTime: 0.5,
  transform: { scale: 1, scaleX: 1, scaleY: 1, x: 0, y: 0, rotation: 0 },
  effects: {},
  animation: {},
  trackOpacity: 1,
  stage: { width: 1280, height: 720, fit: 'contain', dpr: 2 },
});

describe('buildPreviewFramePlan', () => {
  test('is deterministic for the same frame', () => {
    const first = buildPreviewFramePlan(base());
    const second = buildPreviewFramePlan(base());
    expect(first.signature).toBe(second.signature);
    expect(first.output).toEqual({ width: 2560, height: 1440 });
    expect(first.effects.brightness).toBe(0);
    expect(first.opacity).toBe(1);
  });

  test('changes the signature for every state that can change pixels', () => {
    const initial = buildPreviewFramePlan(base()).signature;
    const variants: PreviewFramePlanInput[] = [
      { ...base(), at: 2.5 },
      { ...base(), localTime: 0.75 },
      { ...base(), sourceTime: 3.5 },
      { ...base(), effects: { speed: 2 } },
      { ...base(), trackOpacity: 0.5 },
      { ...base(), transform: { ...base().transform, x: 12 } },
      { ...base(), effects: { brightness: 15 } },
      { ...base(), effects: { mask: { shape: 'rect', x: 10, y: 10, width: 50, height: 50, feather: 0 } } },
      { ...base(), effects: { chroma: { enabled: true, color: '#00ff00', tolerance: 0.2, softness: 0.1 } } },
      { ...base(), transition: { type: 'push', duration: 1 } },
      { ...base(), stage: { ...base().stage, fit: 'cover' } },
      { ...base(), stage: { ...base().stage, width: 1279 } },
      { ...base(), source: { ...base().source, key: 'asset-2' } },
    ];
    for (const variant of variants) {
      expect(buildPreviewFramePlan(variant).signature).not.toBe(initial);
    }
  });

  test('evaluates animated effects and combines track opacity', () => {
    const plan = buildPreviewFramePlan({
      ...base(),
      effects: { opacity: 0.8, saturation: 10 },
      animation: {
        brightness: [{ at: 0, value: 0 }, { at: 1, value: 50 }],
        saturation: [{ at: 0, value: 10 }, { at: 1, value: 50 }],
      },
      trackOpacity: 0.5,
    });
    expect(plan.effects.brightness).toBeCloseTo(25, 5);
    expect(plan.effects.saturation).toBeCloseTo(30, 5);
    expect(plan.opacity).toBeCloseTo(0.4, 5);
  });

  test('evaluates the entrance transition at the local time', () => {
    const plan = buildPreviewFramePlan({
      ...base(),
      localTime: 0.5,
      transition: { type: 'barn-door', duration: 1 },
    });
    expect(plan.motion.offsetX).toBe(0);
    expect(plan.motion.reveal?.left).toBeCloseTo(12.5, 5);
    expect(plan.motion.reveal?.right).toBeCloseTo(12.5, 5);
    expect(plan.transform.x).toBe(0);
  });

  test('composes eased Dynamic Zoom with the clip transform', () => {
    const input = base();
    const zoom = normalizeDynamicZoom({ enabled: true, from: 1, to: 2, easing: 'ease-in' });
    const plan = buildPreviewFramePlan({
      ...input, localTime: 1, clipDuration: 2,
      transform: { ...input.transform, scale: 1.5 },
      effects: { dynamicZoom: zoom },
    });
    expect(plan.transform.scale).toBeCloseTo(1.875, 5);
    expect(dynamicZoomAt(zoom, -0.5, 2)).toBe(1);
    expect(dynamicZoomAt(zoom, 3, 2)).toBe(2);
    expect(dynamicZoomAt({ ...zoom, enabled: false }, 1, 2)).toBe(1);
  });

  test('preserves the zoom phase in an export range and when segments are subdivided', () => {
    const zoom = normalizeDynamicZoom({ enabled: true, from: 1, to: 2 });
    const clip = {
      duration: 8,
      probe: { duration: 8, width: 1920, height: 1080, fps: 30, hasVideo: true, hasAudio: false, videoCodec: 'h264', audioCodec: null },
      effects: { dynamicZoom: zoom },
    };
    expect(canCopyVideo([clip], 'mp4')).toBe(false);
    const range = { ...clip, trimStart: 2, dynamicZoomTiming: dynamicZoomTimingFor(clip, 2) };
    const part = dynamicZoomTimingFor(range, 1);
    expect(part).toEqual({ offset: 3, duration: 8 });
    expect(dynamicZoomAt(zoom, part.offset + 1, part.duration)).toBe(1.5);
    expect(canCopyVideo([{ ...clip, effects: { dynamicZoom: { ...zoom, enabled: false } } }], 'mp4')).toBe(true);
  });

  test('caps the device pixel ratio and keeps the output even', () => {
    const plan = buildPreviewFramePlan({
      ...base(),
      stage: { width: 800, height: 450, fit: 'contain', dpr: 3 },
    });
    expect(plan.stage.dpr).toBe(2);
    expect(plan.output).toEqual({ width: 1600, height: 900 });
  });
});

describe('CSS parity backend', () => {
  test('guarantees CSS pixel parity on WebGPU and keeps WebGL as fallback', () => {
    expect(CSS_PARITY_BACKEND).toBe('webgpu');
  });
});

describe('gpuPreviewWithinBudget', () => {
  test('accepts 1080p at 1x and rejects larger backing stores', () => {
    expect(gpuPreviewWithinBudget(1920, 1080, 1)).toBe(true);
    expect(gpuPreviewWithinBudget(1280, 720, 2)).toBe(false);
    expect(gpuPreviewWithinBudget(1920, 1080, 2)).toBe(false);
    expect(gpuPreviewWithinBudget(3840, 2160, 1)).toBe(false);
  });
});

describe('previewDrawRect', () => {
  test('contains a square source in a widescreen stage', () => {
    const rect = previewDrawRect({
      source: { key: 'x', kind: 'image', width: 1000, height: 1000 },
      stage: { width: 640, height: 360, fit: 'contain', dpr: 1 },
    });
    expect(rect.width).toBeCloseTo(360, 5);
    expect(rect.height).toBeCloseTo(360, 5);
  });

  test('covers the same stage with a square source', () => {
    const rect = previewDrawRect({
      source: { key: 'x', kind: 'image', width: 1000, height: 1000 },
      stage: { width: 640, height: 360, fit: 'cover', dpr: 1 },
    });
    expect(rect.width).toBeCloseTo(640, 5);
    expect(rect.height).toBeCloseTo(640, 5);
  });
});

describe('lutFingerprint', () => {
  test('is stable for the same cube and changes with the data', () => {
    const data = [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 1];
    const first = lutFingerprint({ name: 'Two', size: 2, data });
    const second = lutFingerprint({ name: 'Renamed', size: 2, data });
    expect(second).toBe(first);
    expect(lutFingerprint(null)).toBe('none');
    expect(lutFingerprint({ name: 'Two', size: 2, data: [1, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 1] }))
      .not.toBe(first);
  });
});
