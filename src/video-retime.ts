export interface SpeedPoint {
  /** Source time in seconds where this rate begins. */
  source: number;
  rate: number;
}

export interface PlaybackRates {
  speed?: number;
  speedPoints?: readonly SpeedPoint[];
}

export const normalizeSpeed = (rate: unknown): number =>
  typeof rate === 'number' && Number.isFinite(rate) ? Math.max(0.25, Math.min(4, rate)) : 1;

export function normalizeSpeedPoints(points?: readonly SpeedPoint[]): SpeedPoint[] | undefined {
  if (!Array.isArray(points)) return undefined;
  const distinct = new Map<number, number>();
  for (const point of points) {
    if (point && Number.isFinite(point.source) && point.source >= 0) distinct.set(point.source, normalizeSpeed(point.rate));
  }
  return distinct.size ? [...distinct].sort(([a], [b]) => a - b).slice(0, 64)
    .map(([source, rate]) => ({ source, rate })) : undefined;
}

export function speedAtSource(rates: PlaybackRates | undefined, source: number): number {
  let rate = normalizeSpeed(rates?.speed);
  for (const point of rates?.speedPoints ?? []) {
    if (point.source > source + 0.00000001) break;
    rate = point.rate;
  }
  return rate;
}

export function playbackTime(rates: PlaybackRates | undefined, source: number): number {
  let rate = normalizeSpeed(rates?.speed);
  let previous = 0;
  let elapsed = 0;
  for (const point of rates?.speedPoints ?? []) {
    if (point.source >= source) break;
    elapsed += (point.source - previous) / rate;
    previous = point.source;
    rate = point.rate;
  }
  return elapsed + (source - previous) / rate;
}

export function sourceTime(rates: PlaybackRates | undefined, time: number): number {
  let rate = normalizeSpeed(rates?.speed);
  let source = 0;
  let remaining = time;
  for (const point of rates?.speedPoints ?? []) {
    const span = (point.source - source) / rate;
    if (remaining <= span) break;
    remaining -= span;
    source = point.source;
    rate = point.rate;
  }
  return source + remaining * rate;
}

export function advanceSource(rates: PlaybackRates | undefined, source: number, elapsed: number): number {
  return rates?.speedPoints?.length
    ? sourceTime(rates, playbackTime(rates, source) + elapsed)
    : source + elapsed * normalizeSpeed(rates?.speed);
}

export function playbackSpans(rates: PlaybackRates | undefined, from: number, to: number) {
  if (!(to > from)) return [];
  const edges = [from, ...(rates?.speedPoints ?? []).map(({ source }) => source)
    .filter((source) => source > from + 0.000001 && source < to - 0.000001), to];
  let time = 0;
  return edges.slice(0, -1).map((start, i) => {
    const end = edges[i + 1];
    const rate = speedAtSource(rates, start);
    const length = (end - start) / rate;
    const span = { sourceStart: start, sourceEnd: end, start: time, end: time + length, rate };
    time += length;
    return span;
  });
}

export interface TimelineSpeedPoint { at: number; value: number }

/** Rebuild the shown source ranges while keeping the edited points at their timeline times. */
export function ratesFromTimeline(
  rates: PlaybackRates, from: number, to: number, keys: readonly TimelineSpeedPoint[],
): { speed: number; speedPoints?: SpeedPoint[] } | null {
  if (!keys.length || keys[0].at !== 0) return null;
  const old = rates.speedPoints ?? [];
  const saved = old.filter(({ source }) => source < from - 0.000001 || source >= to - 0.000001);
  let source = from;
  let rate = normalizeSpeed(keys[0].value);
  const base = from > 0 && old.length ? normalizeSpeed(rates.speed) : rate;
  if (from > 0 && old.length) saved.push({ source: from, rate });
  for (let index = 1; index < keys.length; index++) {
    const span = keys[index].at - keys[index - 1].at;
    source += span * rate;
    if (!(span > 0.000001) || source >= to - 0.000001) return null;
    rate = normalizeSpeed(keys[index].value);
    saved.push({ source, rate });
  }
  if (saved.length > 64) return null;
  return { speed: base, speedPoints: normalizeSpeedPoints(saved) };
}
