/**
 * Pure preview-frame planner shared by every compositor backend.
 *
 * The plan contains no DOM nodes or GPU handles. It is deterministic for a
 * clip, a local time, and a stage size, so the same plan can drive the WebGL
 * preview, the WebGPU preview, the CSS fallback, and the frame cache.
 */

import {
  animationAt,
  dynamicZoomAt,
  effectAnimationAt,
  motionTransitionAt,
  type ClipAnimation,
  type ClipEffects,
  type ClipState,
  type ClipTransition,
  type MotionTransitionState,
} from './video-effects';
import { clipTransform, type ClipTransform } from './video-merge-args';

/** Bump when the preview renderer's observable output changes. */
export const PREVIEW_PLAN_VERSION = 2;

/**
 * GPU preview is capped at a 1080p backing store. Above that, the browser's
 * CSS compositor is faster than the multi-pass preview (measured at 4K), so
 * the editor falls back to CSS instead of dropping frames.
 */
export const MAX_GPU_PREVIEW_PIXELS = 1920 * 1080;

/**
 * CSS pixel-parity is guaranteed by the WebGPU backend. WebGL remains the
 * compatibility/export-parity fallback and has a slightly wider CSS colour
 * tolerance due to browser WebGL compositing.
 */
export const CSS_PARITY_BACKEND = 'webgpu' as const;

export function gpuPreviewWithinBudget(width: number, height: number, dpr: number): boolean {
  const ratio = Math.max(0.5, Math.min(2, Number.isFinite(dpr) ? dpr : 1));
  return Math.max(1, width) * Math.max(1, height) * ratio * ratio <= MAX_GPU_PREVIEW_PIXELS;
}

export type PreviewBackend = 'css' | 'webgl' | 'webgpu';
export type PreviewFit = 'contain' | 'cover';

export interface PreviewSourceInfo {
  /** Stable media key. Object URLs are not stable across project reloads. */
  key: string;
  kind: 'video' | 'image';
  width: number;
  height: number;
}

export interface PreviewStage {
  /** CSS pixels. */
  width: number;
  height: number;
  fit: PreviewFit;
  /** Device pixel ratio used for the backing store, already capped by caller. */
  dpr: number;
}

export interface PreviewFramePlanInput {
  clipId: string;
  source: PreviewSourceInfo;
  /** Timeline seconds, used only for diagnostics and the cache signature. */
  at: number;
  /** Seconds from the start of the visible clip. */
  localTime: number;
  clipDuration?: number;
  /** Decoded source time (trim + speed applied) for cache identity. */
  sourceTime?: number;
  transform?: Partial<ClipTransform> | null;
  effects?: Partial<ClipEffects> | null;
  animation?: Partial<ClipAnimation> | null;
  transition?: Partial<ClipTransition> | null;
  /** Track opacity, multiplied with the clip's own opacity. */
  trackOpacity?: number;
  stage: PreviewStage;
}

export interface PreviewFramePlan {
  version: number;
  clipId: string;
  source: PreviewSourceInfo;
  at: number;
  localTime: number;
  sourceTime: number;
  transform: ClipTransform;
  effects: ClipEffects;
  motion: MotionTransitionState;
  /** Clip opacity (effects.opacity plus opacity keyframes) × track opacity. */
  opacity: number;
  stage: PreviewStage;
  /** Backing-store pixels for the preview canvas. */
  output: { width: number; height: number };
  signature: string;
}

const number = (value: unknown, fallback = 0): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

const round = (value: number, places = 4): number => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

const lutFingerprints = new WeakMap<number[], string>();

/** A cheap, stable hash of the LUT cube, cached per backing array. */
export function lutFingerprint(lut: ClipEffects['lut']): string {
  if (!lut) return 'none';
  const cached = lutFingerprints.get(lut.data);
  if (cached) return cached;
  let first = 2166136261;
  let second = 2246822519;
  for (let index = 0; index < lut.data.length; index += 1) {
    const byte = Math.max(0, Math.min(255, Math.round(number(lut.data[index]) * 255)));
    first ^= byte;
    first = Math.imul(first, 16777619);
    if ((index & 7) === 0) {
      second ^= byte + index;
      second = Math.imul(second, 2246822519);
    }
  }
  const fingerprint = `${lut.size}:${first >>> 0}:${second >>> 0}`;
  lutFingerprints.set(lut.data, fingerprint);
  return fingerprint;
}

function stateFor(input: PreviewFramePlanInput, effects: ClipEffects): ClipState {
  return animationAt(input.animation, Math.max(0, input.localTime), {
    transform: clipTransform(input.transform),
    opacity: effects.opacity,
    volume: 1,
  });
}

/**
 * Build the immutable description of one preview frame.
 *
 * Effects are evaluated at the clip-local time exactly like the exporter, so
 * keyframed colour, blur, opacity, and transform values stay in sync.
 */
export function buildPreviewFramePlan(input: PreviewFramePlanInput): PreviewFramePlan {
  const localTime = Math.max(0, number(input.localTime));
  const sourceTime = Math.max(0, number(input.sourceTime, localTime));
  const at = Math.max(0, number(input.at));
  const effects = effectAnimationAt(input.animation, localTime, input.effects);
  const state = stateFor(input, effects);
  const motion = motionTransitionAt(input.transition, localTime);
  const transform = {
    ...state.transform,
    scale: state.transform.scale * dynamicZoomAt(effects.dynamicZoom, localTime, input.clipDuration ?? 0),
    x: state.transform.x + motion.offsetX,
    y: state.transform.y + motion.offsetY,
  };
  const stage: PreviewStage = {
    width: Math.max(1, round(input.stage.width, 2)),
    height: Math.max(1, round(input.stage.height, 2)),
    fit: input.stage.fit === 'cover' ? 'cover' : 'contain',
    dpr: Math.max(0.5, Math.min(2, number(input.stage.dpr, 1))),
  };
  const source: PreviewSourceInfo = {
    key: input.source.key,
    kind: input.source.kind === 'image' ? 'image' : 'video',
    width: Math.max(1, Math.round(number(input.source.width, 16))),
    height: Math.max(1, Math.round(number(input.source.height, 9))),
  };
  const output = {
    width: Math.max(1, Math.round(stage.width * stage.dpr)),
    height: Math.max(1, Math.round(stage.height * stage.dpr)),
  };
  const trackOpacity = clamp01(number(input.trackOpacity, 1));
  const opacity = clamp01(state.opacity * trackOpacity);
  const mask = effects.mask;
  const chroma = effects.chroma;
  const curve = effects.curve;

  const signature = [
    `v${PREVIEW_PLAN_VERSION}`,
    input.clipId,
    source.key,
    source.kind,
    source.width,
    source.height,
    round(at, 3),
    round(localTime, 3),
    round(sourceTime, 3),
    round(transform.x, 3),
    round(transform.y, 3),
    round(transform.scale, 4),
    round(transform.scaleX, 4),
    round(transform.scaleY, 4),
    round(transform.rotation, 3),
    round(effects.brightness, 3),
    round(effects.contrast, 3),
    round(effects.saturation, 3),
    round(effects.hue, 3),
    round(effects.blur, 3),
    round(effects.speed, 3),
    round(opacity, 4),
    effects.blend,
    mask.shape,
    round(mask.x, 3),
    round(mask.y, 3),
    round(mask.width, 3),
    round(mask.height, 3),
    round(mask.feather, 3),
    chroma.enabled ? 1 : 0,
    chroma.color,
    round(chroma.tolerance, 4),
    round(chroma.softness, 4),
    round(curve.shadows, 3),
    round(curve.midtones, 3),
    round(curve.highlights, 3),
    lutFingerprint(effects.lut),
    round(motion.offsetX, 3),
    round(motion.offsetY, 3),
    motion.reveal
      ? `${round(motion.reveal.top, 3)},${round(motion.reveal.right, 3)},` +
        `${round(motion.reveal.bottom, 3)},${round(motion.reveal.left, 3)}`
      : 'none',
    stage.width,
    stage.height,
    stage.fit,
    stage.dpr,
    output.width,
    output.height,
  ].join('|');

  return {
    version: PREVIEW_PLAN_VERSION,
    clipId: input.clipId,
    source,
    at,
    localTime,
    sourceTime,
    transform,
    effects,
    motion,
    opacity,
    stage,
    output,
    signature,
  };
}

/** The plan's normalized stage-space geometry, useful for tests and caches. */
export function previewDrawRect(
  plan: Pick<PreviewFramePlan, 'source' | 'stage'>,
): { width: number; height: number } {
  const sourceAspect = plan.source.width / Math.max(1, plan.source.height);
  const stageAspect = plan.stage.width / Math.max(1, plan.stage.height);
  const fillWidth = plan.stage.fit === 'cover'
    ? sourceAspect <= stageAspect
    : sourceAspect > stageAspect;
  if (fillWidth) {
    return { width: plan.stage.width, height: plan.stage.width / sourceAspect };
  }
  return { width: plan.stage.height * sourceAspect, height: plan.stage.height };
}
