/** Fade transitions shared by text, shape overlays, and their exports. */

export type OverlayTransition = 'fade-in' | 'fade-out' | 'dip' | 'none';

/** Opacity multiplier for an overlay transition at a timeline time. */
export function overlayTransitionOpacity(
  start: number,
  end: number,
  transition: OverlayTransition | undefined,
  time: number,
): number {
  if (!transition || transition === 'none') return 1;
  const duration = Math.max(0, end - start);
  if (duration <= 0.01) return 1;
  const fade = Math.min(0.6, duration / 2);
  let opacity = 1;
  if (transition === 'fade-in' || transition === 'dip') {
    opacity = Math.min(opacity, Math.max(0, (time - start) / fade));
  }
  if (transition === 'fade-out' || transition === 'dip') {
    opacity = Math.min(opacity, Math.max(0, (end - time) / fade));
  }
  return Math.max(0, Math.min(1, opacity));
}
