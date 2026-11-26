import type { ClipAnimation, Keyframe } from './video-effects';

export type KeyProperty = keyof ClipAnimation | 'speed';
export type PanelAnimation = ClipAnimation & { speed?: Keyframe[] };
export interface KeySelection {
  property: KeyProperty;
  at: number;
}

export const keySelectionId = ({ property, at }: KeySelection): string => property + ':' + at;

const EPSILON = 0.000001;

/** Move selected keys together while keeping their values, spacing, and incoming easing. */
export function retimeKeys<T extends PanelAnimation>(
  animation: T,
  selection: readonly KeySelection[],
  delta: number,
  duration: number,
): { animation: T; selection: KeySelection[]; delta: number } | null {
  if (!selection.length || !Number.isFinite(delta)) return null;
  if (selection.some(({ property, at }) => property === 'speed' && at === 0)) return null;
  const first = Math.min(...selection.map(({ at }) => at));
  const last = Math.max(...selection.map(({ at }) => at));
  if (first < 0 || last > duration + EPSILON) return null;
  const move = Math.max(-first, Math.min(duration - last, delta));
  const next: PanelAnimation = { ...animation };
  const selected = new Set(selection.map(keySelectionId));
  for (const property of new Set(selection.map((key) => key.property))) {
    const still: Keyframe[] = [];
    const moving: Keyframe[] = [];
    for (const key of animation[property] ?? []) {
      if (selected.has(keySelectionId({ property, at: key.at }))) {
        moving.push({ ...key, at: key.at + move });
      } else {
        still.push(key);
      }
    }
    if (moving.some((key) => still.some((other) => Math.abs(other.at - key.at) < EPSILON))) return null;
    next[property] = [...still, ...moving].sort((a, b) => a.at - b.at);
  }
  return { animation: next as T, selection: selection.map((key) => ({ ...key, at: key.at + move })), delta: move };
}
