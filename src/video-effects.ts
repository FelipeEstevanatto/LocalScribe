/**
 * Clip effects, keyframes, and the shared math used by the preview and the
 * exporter.
 *
 * The preview uses CSS filters and clip paths, so it stays on the compositor;
 * the exporter uses Canvas2D filters plus an optional per-pixel pass for
 * chroma key, tone curve, and 3D LUTs. Both read the same normalized values,
 * so a static effect looks the same in both places. Per-pixel effects are
 * export-only (they are far too slow to run at 60 fps on the main thread).
 */

import { runPixelPass, type PixelPass } from './pixel-effects-kernel';
import { normalizeSpeed, normalizeSpeedPoints, type SpeedPoint } from './video-retime';

export type Easing = 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out' | 'hold';

export type BlendMode =
  | 'normal'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'darken'
  | 'lighten'
  | 'color-dodge'
  | 'soft-light';

export interface Keyframe {
  /** Seconds from the start of the visible clip. */
  at: number;
  value: number;
  /** Easing used on the way into this keyframe. */
  easing?: Easing;
}

export interface ClipAnimation {
  scale: Keyframe[];
  x: Keyframe[];
  y: Keyframe[];
  rotation: Keyframe[];
  opacity: Keyframe[];
  volume: Keyframe[];
  brightness: Keyframe[];
  contrast: Keyframe[];
  saturation: Keyframe[];
  hue: Keyframe[];
  blur: Keyframe[];
}

/** Motion transitions reveal the start of a clip from a direction or centre. */
export const MOTION_TRANSITIONS = [
  { value: 'push', label: 'Push' },
  { value: 'slide', label: 'Slide' },
  { value: 'barn-door', label: 'Barn door' },
  { value: 'split', label: 'Split' },
] as const;

export type MotionTransitionType = (typeof MOTION_TRANSITIONS)[number]['value'];

/** Fade transitions that video clips share with text and shape overlays. */
export const CLIP_FADE_TRANSITIONS = [
  { value: 'fade-in', label: 'Fade in' },
  { value: 'fade-out', label: 'Fade out' },
  { value: 'dip', label: 'Dip to black' },
] as const;

export const TRANSITION_TYPES = [
  ...MOTION_TRANSITIONS,
  ...CLIP_FADE_TRANSITIONS,
] as const;

export type ClipTransitionType = (typeof TRANSITION_TYPES)[number]['value'];
export type TransitionAlignment = 'start' | 'center' | 'end';

export interface ClipTransition {
  type: ClipTransitionType;
  /** Visible seconds of the transition. */
  duration: number;
  /** Where the transition marker sits relative to its clip edge. */
  alignment?: TransitionAlignment;
}

export interface MotionTransitionState {
  /** Percentage of the output frame still offscreen at the clip start. */
  offsetX: number;
  offsetY: number;
  /** Percentage cropped from each edge to reveal the clip. */
  reveal: { top: number; right: number; bottom: number; left: number } | null;
}

export function normalizeClipTransition(value?: Partial<ClipTransition> | null): ClipTransition | undefined {
  if (!value || !TRANSITION_TYPES.some((entry) => entry.value === value.type)) return undefined;
  const duration = Number(value.duration);
  const transition: ClipTransition = {
    type: value.type as ClipTransitionType,
    duration: Math.max(0.1, Math.min(2, Number.isFinite(duration) ? duration : 0.5)),
  };
  if (value.alignment === 'start' || value.alignment === 'center' || value.alignment === 'end') {
    transition.alignment = value.alignment;
  }
  return transition;
}

export function isMotionTransitionType(type?: string | null): type is MotionTransitionType {
  return MOTION_TRANSITIONS.some((entry) => entry.value === type);
}

export function hasMotionTransition(value?: Partial<ClipTransition> | null): boolean {
  return isMotionTransitionType(normalizeClipTransition(value)?.type);
}

export function motionTransitionLabel(value?: Partial<ClipTransition> | string | null): string {
  const type = typeof value === 'string' ? value : value?.type;
  return TRANSITION_TYPES.find((entry) => entry.value === type)?.label ?? 'None';
}

/**
 * Evaluate the entrance progress of a motion transition. The returned offset
 * is in frame percentages and the reveal is the crop still covering the clip.
 */
export function motionTransitionAt(
  value?: Partial<ClipTransition> | null,
  at = 0,
): MotionTransitionState {
  const transition = normalizeClipTransition(value);
  if (!transition || !isMotionTransitionType(transition.type) || at >= transition.duration) {
    return { offsetX: 0, offsetY: 0, reveal: null };
  }
  const progress = easingProgress('ease-out', Math.max(0, at) / transition.duration);
  const closed = (1 - progress) * 100;
  switch (transition.type) {
    case 'push':
      return { offsetX: closed, offsetY: 0, reveal: null };
    case 'slide':
      return { offsetX: 0, offsetY: closed, reveal: null };
    case 'barn-door':
      return {
        offsetX: 0,
        offsetY: 0,
        reveal: { top: 0, right: closed / 2, bottom: 0, left: closed / 2 },
      };
    case 'split':
      return {
        offsetX: 0,
        offsetY: 0,
        reveal: { top: closed / 2, right: 0, bottom: closed / 2, left: 0 },
      };
    default:
      return { offsetX: 0, offsetY: 0, reveal: null };
  }
}

export interface ClipMask {
  shape: 'none' | 'rect' | 'ellipse';
  /** Percentages of the output frame. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Percent of the shorter side, used as a blur radius. */
  feather: number;
}

export interface ClipChroma {
  enabled: boolean;
  /** Hex colour of the screen to remove. */
  color: string;
  /** 0–1. Distance from the key colour that is fully transparent. */
  tolerance: number;
  /** 0–0.5. Soft edge past the tolerance. */
  softness: number;
}

/** Lift / gamma / gain style tone curve, exposed as three sliders. */
export interface ToneCurve {
  shadows: number;
  midtones: number;
  highlights: number;
}

export interface ClipLut {
  name: string;
  /** Edge size of the 3D cube (2–64). */
  size: number;
  /** size³ × RGB, flattened, each channel 0–1. */
  data: number[];
}

export const DYNAMIC_ZOOM_EASINGS = [
  { value: 'linear', label: 'Linear' },
  { value: 'ease-in', label: 'Ease in' },
  { value: 'ease-out', label: 'Ease out' },
  { value: 'ease-in-out', label: 'Ease in and out' },
] as const;

export interface DynamicZoom {
  enabled: boolean;
  from: number;
  to: number;
  easing: (typeof DYNAMIC_ZOOM_EASINGS)[number]['value'];
}

export interface DynamicZoomTiming {
  offset: number;
  duration: number;
}

export function normalizeDynamicZoom(value?: Partial<DynamicZoom>): DynamicZoom {
  return {
    enabled: value?.enabled === true,
    from: clamp(value?.from, 1, 4, 1),
    to: clamp(value?.to, 1, 4, 1.2),
    easing: DYNAMIC_ZOOM_EASINGS.find(({ value: easing }) => easing === value?.easing)?.value ?? 'linear',
  };
}

export function dynamicZoomAt(value: DynamicZoom | undefined, at: number, duration: number): number {
  if (!value?.enabled || !(duration > 0)) return 1;
  const progress = easingProgress(value.easing, at / duration);
  return value.from + (value.to - value.from) * progress;
}

export interface ClipEffects {
  dynamicZoom?: DynamicZoom;
  brightness: number;
  contrast: number;
  saturation: number;
  hue: number;
  blur: number;
  /** Base opacity, multiplied by the opacity keyframes. */
  opacity: number;
  blend: BlendMode;
  mask: ClipMask;
  chroma: ClipChroma;
  curve: ToneCurve;
  lut: ClipLut | null;
  /** Playback speed; 1 = real time. */
  speed: number;
  speedPoints?: SpeedPoint[];
}

export interface ClipState {
  transform: { scale: number; scaleX: number; scaleY: number; x: number; y: number; rotation: number };
  opacity: number;
  volume: number;
}

export const DEFAULT_CLIP_EFFECTS: Readonly<ClipEffects> = Object.freeze<ClipEffects>({
  brightness: 0,
  contrast: 0,
  saturation: 0,
  hue: 0,
  blur: 0,
  opacity: 1,
  blend: 'normal',
  mask: { shape: 'none', x: 0, y: 0, width: 100, height: 100, feather: 0 },
  chroma: { enabled: false, color: '#00ff00', tolerance: 0.24, softness: 0.12 },
  curve: { shadows: 0, midtones: 0, highlights: 0 },
  lut: null,
  speed: 1,
});

export const DEFAULT_ANIMATION: Readonly<ClipAnimation> = Object.freeze({
  scale: [],
  x: [],
  y: [],
  rotation: [],
  opacity: [],
  volume: [],
  brightness: [],
  contrast: [],
  saturation: [],
  hue: [],
  blur: [],
});

export const BLEND_MODES: { value: BlendMode; label: string }[] = [
  { value: 'normal', label: 'Normal' },
  { value: 'multiply', label: 'Multiply' },
  { value: 'screen', label: 'Screen' },
  { value: 'overlay', label: 'Overlay' },
  { value: 'darken', label: 'Darken' },
  { value: 'lighten', label: 'Lighten' },
  { value: 'color-dodge', label: 'Color dodge' },
  { value: 'soft-light', label: 'Soft light' },
];

export const EASINGS: { value: Easing; label: string }[] = [
  { value: 'linear', label: 'Linear' },
  { value: 'ease-in', label: 'Ease in' },
  { value: 'ease-out', label: 'Ease out' },
  { value: 'ease-in-out', label: 'Ease in-out' },
  { value: 'hold', label: 'Hold' },
];

const clamp = (value: unknown, low: number, high: number, fallback: number): number => {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? Math.max(low, Math.min(high, number)) : fallback;
};

const cloneKeys = (keys: unknown): Keyframe[] => {
  if (!Array.isArray(keys)) return [];
  return keys
    .map((entry) => {
      const key = entry as Partial<Keyframe>;
      return {
        at: clamp(key.at, 0, 36000, 0),
        value: clamp(key.value, -10000, 10000, 0),
        easing: (EASINGS.some((item) => item.value === key.easing) ? key.easing : 'linear') as Easing,
      };
    })
    .filter((key) => Number.isFinite(key.at))
    .sort((a, b) => a.at - b.at)
    .slice(0, 64);
};

export function normalizeAnimation(value?: Partial<ClipAnimation> | null): ClipAnimation {
  return {
    scale: cloneKeys(value?.scale),
    x: cloneKeys(value?.x),
    y: cloneKeys(value?.y),
    rotation: cloneKeys(value?.rotation),
    opacity: cloneKeys(value?.opacity),
    volume: cloneKeys(value?.volume),
    brightness: cloneKeys(value?.brightness),
    contrast: cloneKeys(value?.contrast),
    saturation: cloneKeys(value?.saturation),
    hue: cloneKeys(value?.hue),
    blur: cloneKeys(value?.blur),
  };
}

export function normalizeEffects(value?: Partial<ClipEffects> | null): ClipEffects {
  const mask = value?.mask ?? DEFAULT_CLIP_EFFECTS.mask;
  const chroma = value?.chroma ?? DEFAULT_CLIP_EFFECTS.chroma;
  const curve = value?.curve ?? DEFAULT_CLIP_EFFECTS.curve;
  const lut = value?.lut;
  return {
    brightness: clamp(value?.brightness, -100, 100, 0),
    contrast: clamp(value?.contrast, -100, 100, 0),
    saturation: clamp(value?.saturation, -100, 100, 0),
    hue: clamp(value?.hue, -180, 180, 0),
    blur: clamp(value?.blur, 0, 40, 0),
    opacity: clamp(value?.opacity, 0, 1, 1),
    blend: (BLEND_MODES.some((mode) => mode.value === value?.blend) ? value?.blend : 'normal') as BlendMode,
    mask: {
      shape: mask.shape === 'rect' || mask.shape === 'ellipse' ? mask.shape : 'none',
      x: clamp(mask.x, -100, 100, 0),
      y: clamp(mask.y, -100, 100, 0),
      width: clamp(mask.width, 1, 200, 100),
      height: clamp(mask.height, 1, 200, 100),
      feather: clamp(mask.feather, 0, 50, 0),
    },
    chroma: {
      enabled: Boolean(chroma.enabled),
      color: /^#[0-9a-f]{6}$/i.test(chroma.color) ? chroma.color.toLowerCase() : '#00ff00',
      tolerance: clamp(chroma.tolerance, 0, 1, 0.24),
      softness: clamp(chroma.softness, 0, 0.5, 0.12),
    },
    curve: {
      shadows: clamp(curve.shadows, -100, 100, 0),
      midtones: clamp(curve.midtones, -100, 100, 0),
      highlights: clamp(curve.highlights, -100, 100, 0),
    },
    lut: lut && Array.isArray(lut.data) && lut.size >= 2 && lut.size <= 64 &&
      lut.data.length === lut.size ** 3 * 3
      ? internLut(lut)
      : null,
    speed: clamp(value?.speed, 0.25, 4, 1),
    speedPoints: normalizeSpeedPoints(value?.speedPoints),
    ...(value?.dynamicZoom ? { dynamicZoom: normalizeDynamicZoom(value.dynamicZoom) } : {}),
  };
}

export function hasVisualEffects(value?: Partial<ClipEffects> | null): boolean {
  const effects = normalizeEffects(value);
  return effects.brightness !== 0 || effects.contrast !== 0 || effects.saturation !== 0 ||
    effects.hue !== 0 || effects.blur !== 0 || effects.opacity < 0.999 || effects.dynamicZoom?.enabled ||
    effects.blend !== 'normal' || effects.mask.shape !== 'none' ||
    effects.chroma.enabled || effects.lut !== null ||
    effects.curve.shadows !== 0 || effects.curve.midtones !== 0 || effects.curve.highlights !== 0;
}

/** True when the exporter must process pixels (alpha or colour transforms). */
export function hasPixelEffects(value?: Partial<ClipEffects> | null): boolean {
  const effects = normalizeEffects(value);
  return effects.chroma.enabled || effects.lut !== null ||
    effects.curve.shadows !== 0 || effects.curve.midtones !== 0 || effects.curve.highlights !== 0;
}

export function hasMask(value?: Partial<ClipEffects> | null): boolean {
  return normalizeEffects(value).mask.shape !== 'none';
}

export function hasAnimation(value?: Partial<ClipAnimation> | null): boolean {
  const animation = normalizeAnimation(value);
  return (Object.keys(animation) as (keyof ClipAnimation)[]).some((key) => animation[key].length > 0);
}

/** True when animation changes the picture (not just the clip volume). */
export function hasVisualAnimation(value?: Partial<ClipAnimation> | null): boolean {
  const animation = normalizeAnimation(value);
  return animation.scale.length > 0 || animation.x.length > 0 || animation.y.length > 0 ||
    animation.rotation.length > 0 || animation.opacity.length > 0 ||
    animation.brightness.length > 0 || animation.contrast.length > 0 ||
    animation.saturation.length > 0 || animation.hue.length > 0 || animation.blur.length > 0;
}

export function hasSpeed(value?: Partial<ClipEffects> | null): boolean {
  return Boolean(value?.speedPoints?.length) || Math.abs(normalizeSpeed(value?.speed) - 1) > 0.0001;
}

/** True when copy/stream-copy is impossible. */
export function needsRender(value?: Partial<ClipEffects> | null, animation?: Partial<ClipAnimation> | null): boolean {
  return hasVisualEffects(value) || hasSpeed(value) || hasAnimation(animation);
}

export function easingProgress(kind: Easing | undefined, t: number): number {
  const x = Math.max(0, Math.min(1, t));
  switch (kind) {
    case 'ease-in': return x * x;
    case 'ease-out': return 1 - (1 - x) * (1 - x);
    case 'ease-in-out': return x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2;
    case 'hold': return 0;
    default: return x;
  }
}

/** Linear/eased sample of a keyframe list, clamped at both ends. */
export function valueAt(keys: readonly Keyframe[] | undefined, at: number, fallback: number): number {
  if (!keys?.length) return fallback;
  if (at <= keys[0].at) return keys[0].value;
  const last = keys[keys.length - 1];
  if (at >= last.at) return last.value;
  for (let index = 1; index < keys.length; index += 1) {
    const right = keys[index];
    if (at > right.at) continue;
    if (at === right.at) return right.value;
    const left = keys[index - 1];
    const span = right.at - left.at;
    if (span < 0.0001) return right.value;
    const progress = easingProgress(right.easing, (at - left.at) / span);
    return left.value + (right.value - left.value) * progress;
  }
  return last.value;
}

/** Insert or replace a keyframe at `at`; keys stay sorted. */
export function withKeyframe(keys: readonly Keyframe[], at: number, value: number, easing: Easing = 'linear'): Keyframe[] {
  const next = keys.map((key) => ({ ...key })).filter((key) => Math.abs(key.at - at) > 0.000001);
  next.push({ at: Math.max(0, at), value, easing });
  return next.sort((a, b) => a.at - b.at).slice(0, 64);
}

export function withoutKeyframe(keys: readonly Keyframe[], at: number): Keyframe[] {
  return keys.filter((key) => Math.abs(key.at - at) > 0.000001);
}

export function keyframeNear(keys: readonly Keyframe[] | undefined, at: number, tolerance = 0.05): Keyframe | null {
  if (!keys?.length) return null;
  let best: Keyframe | null = null;
  for (const key of keys) {
    if (Math.abs(key.at - at) <= tolerance && (!best || Math.abs(key.at - at) < Math.abs(best.at - at))) best = key;
  }
  return best;
}

export function animationAt(
  animation: Partial<ClipAnimation> | null | undefined,
  at: number,
  base: ClipState,
): ClipState {
  return {
    transform: {
      scale: valueAt(animation?.scale, at, base.transform.scale),
      scaleX: base.transform.scaleX,
      scaleY: base.transform.scaleY,
      x: valueAt(animation?.x, at, base.transform.x),
      y: valueAt(animation?.y, at, base.transform.y),
      rotation: valueAt(animation?.rotation, at, base.transform.rotation),
    },
    opacity: valueAt(animation?.opacity, at, base.opacity),
    volume: valueAt(animation?.volume, at, base.volume),
  };
}

/** Evaluate animated colour parameters over the clip's static effect stack. */
export function effectAnimationAt(
  animation: Partial<ClipAnimation> | null | undefined,
  at: number,
  value?: Partial<ClipEffects> | null,
): ClipEffects {
  const base = normalizeEffects(value);
  return {
    ...base,
    brightness: Math.max(-100, Math.min(100, valueAt(animation?.brightness, at, base.brightness))),
    contrast: Math.max(-100, Math.min(100, valueAt(animation?.contrast, at, base.contrast))),
    saturation: Math.max(-100, Math.min(100, valueAt(animation?.saturation, at, base.saturation))),
    hue: Math.max(-180, Math.min(180, valueAt(animation?.hue, at, base.hue))),
    blur: Math.max(0, Math.min(40, valueAt(animation?.blur, at, base.blur))),
  };
}

/** CSS filter string used by the stage. */
export function cssFilter(value?: Partial<ClipEffects> | null): string {
  const effects = normalizeEffects(value);
  const filters: string[] = [];
  if (effects.brightness !== 0) filters.push(`brightness(${(100 + effects.brightness) / 100})`);
  if (effects.contrast !== 0) filters.push(`contrast(${(100 + effects.contrast) / 100})`);
  if (effects.saturation !== 0) filters.push(`saturate(${(100 + effects.saturation) / 100})`);
  if (effects.hue !== 0) filters.push(`hue-rotate(${effects.hue}deg)`);
  if (effects.blur > 0) filters.push(`blur(${effects.blur}px)`);
  return filters.length ? filters.join(' ') : 'none';
}

export function maskClipPath(value?: Partial<ClipEffects> | null): string {
  const mask = normalizeEffects(value).mask;
  if (mask.shape === 'none') return '';
  const right = Math.max(0, 100 - mask.x - mask.width);
  const bottom = Math.max(0, 100 - mask.y - mask.height);
  if (mask.shape === 'ellipse') {
    return `ellipse(${mask.width / 2}% ${mask.height / 2}% at ${mask.x + mask.width / 2}% ${mask.y + mask.height / 2}%)`;
  }
  return `inset(${mask.y}% ${right}% ${bottom}% ${mask.x}% round ${Math.min(24, mask.feather)}%)`;
}

export interface MaskCssStyles {
  /** Hard shape for unfeathered masks and motion reveals. */
  clipPath: string;
  /** SVG mask with a real Gaussian feather, matching drawMask(). */
  maskImage: string;
}

/**
 * CSS-preview mask styles. Unfeathered masks stay on clip-path; feathered
 * masks use an SVG alpha mask with the same Gaussian radius as the exporter,
 * so the fallback preview and the GPU compositor show the same edge.
 */
export function maskCssStyles(
  value: Partial<ClipEffects> | null | undefined,
  width: number,
  height: number,
): MaskCssStyles {
  const mask = normalizeEffects(value).mask;
  if (mask.shape === 'none') return { clipPath: '', maskImage: '' };
  if (mask.feather <= 0) return { clipPath: maskClipPath(value), maskImage: '' };
  const stageWidth = Math.max(1, width);
  const stageHeight = Math.max(1, height);
  const x = (mask.x / 100) * stageWidth;
  const y = (mask.y / 100) * stageHeight;
  const boxWidth = (mask.width / 100) * stageWidth;
  const boxHeight = (mask.height / 100) * stageHeight;
  const radius = (mask.feather / 100) * Math.min(stageWidth, stageHeight);
  const shape = mask.shape === 'ellipse'
    ? `<ellipse cx="${x + boxWidth / 2}" cy="${y + boxHeight / 2}" rx="${Math.max(0.01, boxWidth / 2)}" ry="${Math.max(0.01, boxHeight / 2)}" fill="white" filter="url(#m)"/>`
    : `<rect x="${x}" y="${y}" width="${Math.max(0.01, boxWidth)}" height="${Math.max(0.01, boxHeight)}" fill="white" filter="url(#m)"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${stageWidth}" height="${stageHeight}" viewBox="0 0 ${stageWidth} ${stageHeight}"><defs><filter id="m" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="${radius}"/></filter></defs>${shape}</svg>`;
  return {
    clipPath: '',
    maskImage: `url("data:image/svg+xml,${encodeURIComponent(svg)}")`,
  };
}

export function compositeOperation(blend: BlendMode): GlobalCompositeOperation {
  return blend === 'normal' ? 'source-over' : blend as GlobalCompositeOperation;
}

/** Tonemap curve sampled into a 256-entry byte table. */
export function toneTable(curve: ToneCurve): Uint8ClampedArray {
  const table = new Uint8ClampedArray(256);
  const lift = (curve.shadows / 100) * 0.18;
  const gamma = 2 ** (-(curve.midtones / 100));
  const gain = 1 + (curve.highlights / 100) * 0.32;
  for (let index = 0; index < 256; index += 1) {
    const value = index / 255;
    const toned = Math.min(1, Math.max(0, value ** gamma * gain + lift * (1 - value)));
    table[index] = Math.round(toned * 255);
  }
  return table;
}

function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace('#', '');
  return [
    Number.parseInt(value.slice(0, 2), 16) / 255,
    Number.parseInt(value.slice(2, 4), 16) / 255,
    Number.parseInt(value.slice(4, 6), 16) / 255,
  ];
}

const lutValues = new WeakMap<readonly number[], Float64Array>();

/**
 * The per-pixel pass for these effects (chroma key, tone curve, LUT), or null
 * when there is nothing to do. The LUT's Float64Array copy is made once per LUT.
 */
export function pixelPassFor(value?: Partial<ClipEffects> | null): PixelPass | null {
  const effects = normalizeEffects(value);
  if (!hasPixelEffects(effects)) return null;
  const curve = effects.curve;
  const table = (curve.shadows || curve.midtones || curve.highlights) ? toneTable(curve) : null;
  const lut = effects.lut;
  let values: Float64Array | null = null;
  if (lut) {
    values = lutValues.get(lut.data) ?? null;
    if (!values) {
      values = Float64Array.from(lut.data);
      lutValues.set(lut.data, values);
    }
  }
  return {
    key: effects.chroma.enabled ? hexToRgb(effects.chroma.color) : null,
    tolerance: effects.chroma.tolerance,
    softness: Math.max(0.0001, effects.chroma.softness),
    // table[byte] / 255 is what the per-pixel loop used to compute.
    tone: table ? Float64Array.from(table, (entry) => entry / 255) : null,
    lutSize: lut ? lut.size : 0,
    lut: values,
  };
}

/** Apply chroma key, tone curve, and LUT in one pass. Export-only. */
export function applyPixelEffects(image: ImageData, value?: Partial<ClipEffects> | null): void {
  const pass = pixelPassFor(value);
  if (pass) runPixelPass(image.data, pass);
}

/** Feathered mask drawn into a clip-sized canvas. */
export function drawMask(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  width: number,
  height: number,
  value: Partial<ClipEffects> | null | undefined,
): void {
  const mask = normalizeEffects(value).mask;
  if (mask.shape === 'none') return;
  const x = (mask.x / 100) * width;
  const y = (mask.y / 100) * height;
  const w = (mask.width / 100) * width;
  const h = (mask.height / 100) * height;
  ctx.save();
  ctx.globalCompositeOperation = 'destination-in';
  ctx.fillStyle = '#fff';
  if (mask.feather > 0) {
    const radius = (mask.feather / 100) * Math.min(width, height);
    ctx.filter = `blur(${Math.max(0.5, radius)}px)`;
  }
  ctx.beginPath();
  if (mask.shape === 'ellipse') ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
  else ctx.rect(x, y, w, h);
  ctx.fill();
  ctx.restore();
}

/** Piecewise-linear FFmpeg volume expression from keyframes. */
export function volumeExpression(keys: readonly Keyframe[] | undefined, fallback: number): string {
  const list = (keys ?? []).slice(0, 12);
  if (!list.length) return fallback.toFixed(4);
  if (list.length === 1) return Math.max(0, list[0].value).toFixed(4);
  let expression = Math.max(0, list[list.length - 1].value).toFixed(4);
  for (let index = list.length - 1; index > 0; index -= 1) {
    const left = list[index - 1];
    const right = list[index];
    const span = Math.max(0.0001, right.at - left.at);
    const segment = `(${Math.max(0, left.value).toFixed(4)}+(${Math.max(0, right.value).toFixed(4)}-${Math.max(0, left.value).toFixed(4)})*(t-${left.at.toFixed(3)})/${span.toFixed(3)})`;
    expression = `if(lt(t,${right.at.toFixed(3)}),${segment},${expression})`;
  }
  if (list[0].at > 0.001) expression = `if(lt(t,${list[0].at.toFixed(3)}),${Math.max(0, list[0].value).toFixed(4)},${expression})`;
  return expression;
}

// LUTs are large (a 33³ cube is 108k numbers) and never change once loaded, so
// every clip, history snapshot and saved payload shares one frozen object per
// distinct LUT. Snapshots copy effects without the LUT, signatures write a
// short content key, and IndexedDB stores a shared object once per put.
const internedLuts = new WeakSet<ClipLut>();
const lutKeys = new WeakMap<ClipLut, string>();
const lutsByKey = new Map<string, WeakRef<ClipLut>>();
const lutRegistry = typeof FinalizationRegistry === 'function'
  ? new FinalizationRegistry<string>((key) => {
    if (!lutsByKey.get(key)?.deref()) lutsByKey.delete(key);
  })
  : null;

function lutContentKey(lut: ClipLut): string {
  // Exact: hashes the float64 bits, so two LUTs that differ anywhere differ here.
  const view = new Float64Array(1);
  const words = new Uint32Array(view.buffer);
  let first = 2166136261;
  let second = 2246822519;
  for (let index = 0; index < lut.data.length; index += 1) {
    view[0] = lut.data[index];
    first = Math.imul(first ^ words[0], 16777619);
    first = Math.imul(first ^ words[1], 16777619);
    second = Math.imul(second ^ (words[0] + index), 2246822519);
    second = Math.imul(second ^ words[1], 3266489917);
  }
  return `${lut.size}:${lut.data.length}:${(first >>> 0).toString(36)}:${(second >>> 0).toString(36)}`;
}

function sameLutData(left: readonly number[], right: readonly number[]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (!Object.is(left[index], right[index])) return false;
  }
  return true;
}

/** The shared, frozen copy of a LUT with this name and data. */
export function internLut(lut: ClipLut): ClipLut {
  if (internedLuts.has(lut)) return lut;
  const name = String(lut.name || 'LUT');
  const size = Math.round(lut.size);
  const content = lutContentKey(lut);
  const key = `${content}|${name}`;
  const existing = lutsByKey.get(key)?.deref();
  if (existing && existing.size === size && sameLutData(existing.data, lut.data)) return existing;
  // The wrapper is frozen; the data array is not. Engines read frozen arrays
  // through a slow path (JavaScriptCore: 10x slower in the export loop), and
  // nothing writes to LUT data once it is parsed.
  const shared = Object.freeze<ClipLut>({ name, size, data: lut.data });
  internedLuts.add(shared);
  lutKeys.set(shared, content);
  if (!existing) {
    lutsByKey.set(key, new WeakRef(shared));
    lutRegistry?.register(shared, key);
  }
  return shared;
}

/** Short content key for a LUT, used in signatures instead of the data. */
export function lutKey(lut: ClipLut | null | undefined): string | null {
  if (!lut) return null;
  let key = lutKeys.get(lut);
  if (!key) {
    key = lutContentKey(lut);
    lutKeys.set(lut, key);
  }
  return `${lut.name}|${key}`;
}

/** Deep copy of clip effects that shares the (immutable) LUT instead of copying it. */
export function cloneEffects(effects: ClipEffects): ClipEffects {
  const copy: ClipEffects = structuredClone({ ...effects, lut: null });
  copy.lut = effects.lut ? internLut(effects.lut) : null;
  return copy;
}

/** JSON of clip effects with the LUT written as its content key. */
export function effectsSignature(effects: ClipEffects | null | undefined): string {
  if (!effects) return JSON.stringify(effects);
  return JSON.stringify({ ...effects, lut: lutKey(effects.lut) });
}

/** Parse an Adobe .cube LUT (3D only). Throws on malformed input. */
export function parseCubeLut(text: string, name = 'LUT'): ClipLut {
  let size = 0;
  const data: number[] = [];
  for (const line of text.replace(/\r/g, '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const sizeMatch = /^LUT_3D_SIZE\s+(\d+)/i.exec(trimmed);
    if (sizeMatch) {
      size = Number(sizeMatch[1]);
      continue;
    }
    if (/^[A-Z_]+\s/i.test(trimmed)) continue;
    const parts = trimmed.split(/\s+/).map(Number);
    if (parts.length >= 3 && parts.every((value) => Number.isFinite(value))) {
      data.push(parts[0], parts[1], parts[2]);
    }
    if (data.length > 64 ** 3 * 3) throw new Error('This LUT is larger than the 64³ limit.');
  }
  if (size < 2 || size > 64) throw new Error('This is not a 3D .cube LUT (missing or invalid LUT_3D_SIZE).');
  if (data.length !== size ** 3 * 3) throw new Error('This LUT is incomplete or has the wrong number of entries.');
  return internLut({ name, size, data });
}

export function effectBadges(value?: Partial<ClipEffects> | null, animation?: Partial<ClipAnimation> | null): string[] {
  const effects = normalizeEffects(value);
  const badges: string[] = [];
  if (effects.speedPoints?.length) badges.push('Speed points');
  else if (hasSpeed(effects)) badges.push(`${effects.speed.toFixed(2)}×`);
  if (hasVisualEffects(effects)) badges.push(effects.lut ? 'LUT' : 'FX');
  if (hasMask(effects)) badges.push('Mask');
  if (effects.chroma.enabled) badges.push('Key');
  if (hasAnimation(animation)) badges.push('◆');
  return badges;
}
