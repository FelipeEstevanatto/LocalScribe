/**
 * FFmpeg command builders for the video merge tool.
 *
 * Export runs in two steps. `buildAudioMixPlan` renders the whole soundtrack
 * (the videos' own sound plus every added clip, with offsets, trims, fades,
 * track choice, and optional ducking) into one AAC file. The video is then
 * produced either by WebCodecs (see video-export.ts) or, as a fallback, by
 * `buildVideoPlan`, which muxes that soundtrack back in.
 *
 * Pure functions so the commands can be unit tested without FFmpeg.
 */

import { audioInputName, type MediaProbe } from './audio-ffmpeg';
import { advanceSource, playbackSpans, playbackTime, speedAtSource, type PlaybackRates } from './video-retime';
import {
  normalizeAnimation,
  normalizeEffects,
  type DynamicZoomTiming,
  hasAnimation,
  hasSpeed,
  hasVisualEffects,
  volumeExpression,
  type ClipAnimation,
  type ClipEffects,
  type ClipTransition,
} from './video-effects';

/** Picture transform applied inside the output frame, like a clip inspector in an NLE. */
export interface ClipTransform {
  /** Uniform zoom around the frame centre. 1 = 100%. */
  scale: number;
  /** Horizontal stretch multiplier, combined with scale. */
  scaleX: number;
  /** Vertical stretch multiplier, combined with scale. */
  scaleY: number;
  /** Horizontal offset as a percentage of the output frame. 0 = centred. */
  x: number;
  /** Vertical offset as a percentage of the output frame. 0 = centred. */
  y: number;
  /** Clockwise rotation in degrees. */
  rotation: number;
}

export const DEFAULT_CLIP_TRANSFORM: Readonly<ClipTransform> = Object.freeze({
  scale: 1,
  scaleX: 1,
  scaleY: 1,
  x: 0,
  y: 0,
  rotation: 0,
});

const clampTransform = (value: unknown, low: number, high: number, fallback: number): number => {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? Math.max(low, Math.min(high, number)) : fallback;
};

/** Fill defaults and keep saved or typed transforms inside a usable range. */
export function clipTransform(value?: Partial<ClipTransform> | null): ClipTransform {
  return {
    scale: clampTransform(value?.scale, 0.05, 10, 1),
    scaleX: clampTransform(value?.scaleX, 0.05, 10, 1),
    scaleY: clampTransform(value?.scaleY, 0.05, 10, 1),
    x: clampTransform(value?.x, -200, 200, 0),
    y: clampTransform(value?.y, -200, 200, 0),
    rotation: clampTransform(value?.rotation, -360, 360, 0),
  };
}

/** True when the picture differs from a plain, centred, unscaled frame. */
export function hasClipTransform(value?: Partial<ClipTransform> | null): boolean {
  const transform = clipTransform(value);
  return Math.abs(transform.scale - 1) > 0.0001 ||
    Math.abs(transform.scaleX - 1) > 0.0001 ||
    Math.abs(transform.scaleY - 1) > 0.0001 ||
    Math.abs(transform.x) > 0.0001 ||
    Math.abs(transform.y) > 0.0001 ||
    Math.abs(transform.rotation) > 0.0001;
}

export interface MergeVideo {
  duration: number;
  probe: MediaProbe;
  /** Where the clip starts on the timeline. Omit for legacy sequential lists. */
  start?: number;
  /** Video row, 0-based. Higher rows sit on top. */
  track?: number;
  /** Seconds removed from the start and end of the clip. */
  trimStart?: number;
  trimEnd?: number;
  /** A still image shown for `duration` seconds. */
  image?: boolean;
  /** Which audio stream of the file is its "own sound" (0-based among audio streams). */
  audioTrack?: number;
  /** Gain for this clip's own sound, 1 = unchanged. */
  volume?: number;
  /** Drop this clip's own sound without changing the rest of the timeline. */
  mute?: boolean;
  /** Zoom, position, and rotation inside the output frame. */
  transform?: Partial<ClipTransform>;
  /** Colour, mask, key, LUT, and speed for the picture. */
  effects?: Partial<ClipEffects>;
  /** Preserve motion phase when export divides a timeline clip into segments. */
  dynamicZoomTiming?: DynamicZoomTiming;
  animationTimeOffset?: number;
  /** Keyframed transform, opacity, and clip volume. */
  animation?: Partial<ClipAnimation>;
  /** Motion transition played at the clip's start. */
  transition?: ClipTransition;
}

export interface MergeAudio {
  duration: number;
  /** Where the clip starts on the timeline, in seconds (≥ 0). */
  offset: number;
  /** Seconds skipped at the start and end of the source. */
  trimStart: number;
  trimEnd: number;
  /** Linear gain, 1 = unchanged. */
  volume: number;
  fadeIn: number;
  fadeOut: number;
  /** Audio stream to use when the file has several (0-based). */
  track?: number;
  /** Explicit source stream ordinal when track denotes a timeline lane. */
  sourceTrack?: number;
  /** Exclude this clip from the mix. */
  mute?: boolean;
  retime?: PlaybackRates;
}

export type MergeFormat = 'mp4' | 'mkv' | 'mov' | 'webm';
export type MergePreset = 'source' | '2160p' | '1080p' | '720p' | '480p' | 'vertical' | 'square' | 'custom';
export type MergeLoudness = 'off' | 'podcast' | 'social';

export interface MergeSettings {
  keepOriginal: boolean;
  /** Linear gain for the videos' own sound. */
  originalVolume: number;
  format: MergeFormat;
  /** Lower the added audio while the videos' own sound is present. */
  duck?: boolean;
  /** Use caption timing instead of the sidechain detector when ducking. */
  duckCaptions?: boolean;
  preset?: MergePreset;
  /** Custom output size, used when preset is `custom`. */
  customWidth?: number;
  customHeight?: number;
  /** Cap the shorter side of the output (used by Quick Tools resolutions). */
  maxShortEdge?: number;
  /** Aim the whole file at this size (megabytes). */
  targetMB?: number | null;
  /** Encoder quality for browser exports, 0-100. */
  quality?: number;
  /** Project frame rate. Omit to keep each clip's source rate. */
  frameRate?: number;
  /** Force re-encoding even when stream copy would work. */
  reencode?: boolean;
  /** Re-encode when a clip is trimmed instead of snapping to keyframes. */
  exactCuts?: boolean;
  /** Normalize the finished soundtrack to a delivery target. */
  normalize?: MergeLoudness;
}

export interface Plan {
  args: string[];
  output: string;
  mime: string;
  duration: number;
  texts: { name: string; content: string }[];
}

export const MERGE_FORMATS: Record<MergeFormat, { label: string; mime: string }> = {
  mp4: { label: 'MP4 · plays everywhere', mime: 'video/mp4' },
  mkv: { label: 'MKV · flexible container', mime: 'video/x-matroska' },
  mov: { label: 'MOV · Apple editing', mime: 'video/quicktime' },
  webm: { label: 'WebM · web and social', mime: 'video/webm' },
};

export const MERGE_PRESETS: Record<MergePreset, { label: string; width?: number; height?: number; fit: 'contain' | 'cover'; long?: number; upscale?: boolean }> = {
  source: { label: 'Same as the first clip', fit: 'contain' },
  '2160p': { label: '4K · 3840×2160', long: 3840, fit: 'contain', upscale: true },
  '1080p': { label: '1080p', long: 1920, fit: 'contain', upscale: true },
  '720p': { label: '720p · smaller file', long: 1280, fit: 'contain', upscale: true },
  '480p': { label: '480p · smallest', long: 854, fit: 'contain' },
  vertical: { label: 'Vertical 9:16 (Shorts, Reels, TikTok)', width: 1080, height: 1920, fit: 'cover' },
  square: { label: 'Square 1:1', width: 1080, height: 1080, fit: 'cover' },
  custom: { label: 'Custom size (from Project Settings)', fit: 'contain' },
};

export const AUDIO_BITRATE = 192_000;
// Mediabunny names H.264 "avc"; FFmpeg names it "h264". Accept both so the
// copy decision does not depend on which prober answered.
const MP4_SAFE = new Set(['avc', 'h264', 'hevc', 'h265', 'av1', 'mpeg4', 'vp9']);
const WEBM_SAFE = new Set(['vp8', 'vp9', 'av1']);
const t = (value: number) => Math.max(0, value).toFixed(6);
const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);

/** Colour/key/blur filters that FFmpeg can express statically. */
function colourFilters(value?: Partial<ClipEffects> | null): string[] {
  const effects = normalizeEffects(value);
  const filters: string[] = [];
  if (effects.brightness !== 0 || effects.contrast !== 0 || effects.saturation !== 0) {
    filters.push(
      `eq=brightness=${(effects.brightness / 200).toFixed(4)}:` +
      `contrast=${(1 + effects.contrast / 100).toFixed(3)}:` +
      `saturation=${Math.max(0, 1 + effects.saturation / 100).toFixed(3)}`,
    );
  }
  if (effects.hue !== 0) filters.push(`hue=h=${effects.hue.toFixed(2)}`);
  if (effects.blur > 0) filters.push(`gblur=sigma=${Math.max(0.1, effects.blur * 0.5).toFixed(2)}`);
  if (effects.chroma.enabled) {
    filters.push('format=rgba');
    filters.push(`colorkey=0x${effects.chroma.color.slice(1)}:${Math.min(0.9, 0.01 + effects.chroma.tolerance * 0.35).toFixed(3)}:0.1`);
  }
  return filters;
}

/** `atempo` accepts 0.5–2 per instance; chain for the wider speed range. */
function speedAudioChain(speed: number): string[] {
  if (Math.abs(speed - 1) < 0.0001) return [];
  const chain: string[] = [];
  let value = speed;
  while (value > 2.0001) {
    chain.push('atempo=2');
    value /= 2;
  }
  while (value < 0.4999) {
    chain.push('atempo=0.5');
    value /= 0.5;
  }
  chain.push(`atempo=${value.toFixed(4)}`);
  return chain;
}

/** Produces a reusable PCM pad when a soundtrack has retimed sections. */
function retimedAudio(
  graph: string[], input: number, track: number, name: string, clip: MergeVideo | MergeAudio,
): string | null {
  const spans = clipSpeedSpans(clip);
  if (!spans.length) return null;
  const source = '[' + input + ':a:' + track + ']';
  const split = spans.map((_, index) => '[' + name + 's' + index + ']');
  if (spans.length > 1) graph.push(source + 'asplit=' + spans.length + split.join(''));
  const output = spans.map((span, index) => {
    const pad = '[' + name + 'p' + index + ']';
    const filters = [
      'atrim=start=' + t(span.sourceStart) + ':end=' + t(span.sourceEnd),
      'asetpts=PTS-STARTPTS', ...speedAudioChain(span.rate), STEREO,
      'apad', 'atrim=end=' + t(span.end - span.start),
    ];
    graph.push((spans.length === 1 ? source : split[index]) + filters.join(',') + pad);
    return pad;
  });
  if (output.length === 1) return output[0];
  const joined = '[' + name + ']';
  graph.push(output.join('') + 'concat=n=' + output.length + ':v=0:a=1' + joined);
  return joined;
}

function animatedVolumeChain(clip: MergeVideo): string[] {
  const chain: string[] = [];
  const animation = normalizeAnimation(clip.animation);
  if (animation.volume.length) {
    chain.push(`volume='${volumeExpression(animation.volume, 1)}':eval=frame`);
  } else {
    chain.push(`volume=${(clip.volume ?? 1).toFixed(4)}`);
  }
  return chain;
}

export function audioClipLength(clip: MergeAudio): number {
  return Math.max(0, clipPlaybackTime(clip, clip.duration - clip.trimEnd));
}

function clipRates(clip: MergeVideo | MergeAudio): PlaybackRates | undefined {
  return 'offset' in clip ? clip.retime : clip.effects;
}

export function clipPlaybackTime(clip: MergeVideo | MergeAudio, source: number): number {
  const rates = clipRates(clip);
  return playbackTime(rates, source) - playbackTime(rates, clip.trimStart ?? 0);
}

export function clipSourceTime(clip: MergeVideo | MergeAudio, time: number): number {
  return advanceSource(clipRates(clip), clip.trimStart ?? 0, time);
}

export function clipSpeedSpans(clip: MergeVideo | MergeAudio) {
  return playbackSpans(clipRates(clip), clip.trimStart ?? 0, clip.duration - (clip.trimEnd ?? 0));
}

export function dynamicZoomTimingFor(clip: MergeVideo, offset = 0): DynamicZoomTiming {
  return {
    offset: (clip.dynamicZoomTiming?.offset ?? 0) + offset,
    duration: clip.dynamicZoomTiming?.duration ?? videoClipLength(clip),
  };
}

export function videoClipLength(clip: MergeVideo): number {
  return Math.max(0, clipPlaybackTime(clip, clip.duration - (clip.trimEnd ?? 0)));
}

/** Seconds of source media consumed by a visible clip, including speed. */
export function videoSourceLength(clip: MergeVideo): number {
  return Math.max(0, clip.duration - (clip.trimStart ?? 0) - (clip.trimEnd ?? 0));
}

/** Timeline start for every clip. Legacy lists without starts stay sequential. */
export function videoStarts(videos: readonly MergeVideo[]): number[] {
  const explicit = videos.some((clip) => clip.start !== undefined);
  let cursor = 0;
  return videos.map((clip) => {
    const start = explicit ? Math.max(0, clip.start ?? 0) : cursor;
    cursor = start + videoClipLength(clip);
    return start;
  });
}

export function totalLength(videos: readonly MergeVideo[]): number {
  const starts = videoStarts(videos);
  return Math.max(0, ...videos.map((clip, i) => starts[i] + videoClipLength(clip)));
}

/** True when the clips form one uninterrupted track in their current array order. */
export function isSequentialVideo(videos: readonly MergeVideo[]): boolean {
  const starts = videoStarts(videos);
  let cursor = 0;
  return videos.every((clip, i) => {
    const ok = Math.abs(starts[i] - cursor) < 0.01;
    cursor = starts[i] + videoClipLength(clip);
    return ok;
  });
}

export interface VideoSegment {
  start: number;
  end: number;
  clip?: MergeVideo;
  /** Source time to start at when rendering this segment. */
  sourceStart?: number;
}

/** Track indices run from the top of the timeline down. On the same row, the later clip wins. */
export function compareVideoPriority(aTrack: number = 0, aStart: number, bTrack: number = 0, bStart: number): number {
  return aTrack - bTrack || bStart - aStart;
}

/**
 * Flatten overlapping tracks into one visible sequence from the top row down.
 * Gaps become clip-less segments so the exporter can paint black.
 */
export function videoSegments(videos: readonly MergeVideo[]): VideoSegment[] {
  if (!videos.length) return [];
  const starts = videoStarts(videos);
  const total = totalLength(videos);
  const bounds = new Set<number>([0, total]);
  videos.forEach((clip, i) => {
    bounds.add(starts[i]);
    bounds.add(starts[i] + videoClipLength(clip));
    if (clip.effects?.speedPoints?.length) {
      for (const span of clipSpeedSpans(clip)) bounds.add(starts[i] + span.start);
    }
  });
  const times = [...bounds].filter((t) => t >= 0 && t <= total).sort((a, b) => a - b);
  const segments: VideoSegment[] = [];
  for (let i = 0; i < times.length - 1; i += 1) {
    const a = times[i];
    const b = times[i + 1];
    if (b - a < 0.0001) continue;
    let best = -1;
    videos.forEach((clip, j) => {
      const start = starts[j];
      const end = start + videoClipLength(clip);
      if (start <= a + 0.0001 && end >= b - 0.0001) {
        if (best < 0 || compareVideoPriority(clip.track, start, videos[best].track, starts[best]) < 0) best = j;
      }
    });
    if (best < 0) {
      segments.push({ start: a, end: b });
    } else {
      const clip = videos[best];
      segments.push({
        start: a,
        end: b,
        clip,
        sourceStart: clipSourceTime(clip, a - starts[best]),
      });
    }
  }
  const merged: VideoSegment[] = [];
  for (const segment of segments) {
    const last = merged[merged.length - 1];
    const contiguous = last && Math.abs(last.end - segment.start) < 0.0001;
    const sameClip = contiguous && last.clip === segment.clip;
    const sameGap = contiguous && !last.clip && !segment.clip;
    const rate = speedAtSource(last?.clip?.effects, last?.sourceStart ?? 0);
    const sourceContinues = sameClip && rate === speedAtSource(segment.clip?.effects, segment.sourceStart ?? 0) &&
      Math.abs((last.sourceStart ?? 0) + (last.end - last.start) * rate - (segment.sourceStart ?? 0)) < 0.0001;
    if ((sameClip && sourceContinues) || sameGap) last.end = segment.end;
    else merged.push({ ...segment });
  }
  return merged;
}

/** Output frame size for a preset, based on the first clip. */
export function targetSize(
  preset: MergePreset,
  first: { width: number; height: number },
  maxShortEdge?: number,
  custom?: { width?: number; height?: number },
): { width: number; height: number; fit: 'contain' | 'cover' } {
  const width = first.width || 1280;
  const height = first.height || 720;
  if (maxShortEdge && maxShortEdge > 0) {
    const scale = Math.min(1, maxShortEdge / Math.min(width, height));
    return { width: even(width * scale), height: even(height * scale), fit: 'contain' };
  }
  if (preset === 'custom') {
    const customWidth = Number(custom?.width);
    const customHeight = Number(custom?.height);
    if (Number.isFinite(customWidth) && Number.isFinite(customHeight) && customWidth >= 2 && customHeight >= 2) {
      return {
        width: even(Math.max(2, Math.min(7680, customWidth))),
        height: even(Math.max(2, Math.min(7680, customHeight))),
        fit: 'contain',
      };
    }
  }
  const spec = MERGE_PRESETS[preset];
  if (spec.width && spec.height) return { width: spec.width, height: spec.height, fit: spec.fit };
  if (!spec.long) return { width: even(width), height: even(height), fit: 'contain' };
  const scale = spec.upscale
    ? spec.long / Math.max(width, height)
    : Math.min(1, spec.long / Math.max(width, height));
  return { width: even(width * scale), height: even(height * scale), fit: 'contain' };
}

/** Output frame rate for a plan: the project override, else the first clip's rate. */
export function planFrameRate(
  settings: Pick<MergeSettings, 'frameRate'>,
  sourceFps: number,
): number {
  const requested = Number(settings.frameRate);
  if (Number.isFinite(requested) && requested >= 1 && requested <= 240) {
    return Math.round(requested * 1000) / 1000;
  }
  return sourceFps > 0 && sourceFps <= 240 ? Math.round(sourceFps * 1000) / 1000 : 30;
}

/** Video bitrate that lands the file near `targetMB`. */
export function bitrateForSize(targetMB: number, duration: number, hasAudio: boolean): number {
  const total = (targetMB * 8_000_000 * 0.97) / Math.max(0.1, duration);
  return Math.max(150_000, Math.round(total - (hasAudio ? AUDIO_BITRATE : 0)));
}

/** Whether every clip can be joined by stream copy (same codec, size, and rate). */
export function canCopyVideo(
  videos: readonly MergeVideo[],
  format: MergeFormat,
  settings: Pick<MergeSettings, 'preset' | 'maxShortEdge' | 'targetMB' | 'reencode' | 'exactCuts' | 'frameRate'> = {},
): boolean {
  if (!videos.length || settings.reencode || settings.targetMB || settings.maxShortEdge ||
    (settings.preset ?? 'source') !== 'source') return false;
  if (settings.frameRate && videos.some(({ probe }) =>
    Math.abs((probe.fps || 0) - settings.frameRate!) >= 0.01)) return false;
  if (settings.exactCuts && videos.some((clip) => (clip.trimStart ?? 0) > 0 || (clip.trimEnd ?? 0) > 0)) return false;
  if (videos.some((clip) => hasClipTransform(clip.transform))) return false;
  if (videos.some((clip) => hasVisualEffects(clip.effects) || hasSpeed(clip.effects) ||
    hasAnimation(clip.animation) || clip.transition)) return false;
  if (!isSequentialVideo(videos)) return false;
  const [first] = videos;
  const codec = first.probe.videoCodec;
  if (!codec || videos.some((clip) => clip.image)) return false;
  if (format === 'webm' ? !WEBM_SAFE.has(codec) : format !== 'mkv' && !MP4_SAFE.has(codec)) return false;
  return videos.every(({ probe }) =>
    probe.videoCodec === codec && probe.width === first.probe.width && probe.height === first.probe.height &&
    Math.abs((probe.fps || 0) - (first.probe.fps || 0)) < 0.05);
}

/**
 * True when the soundtrack is only the videos' own sound, unchanged. Such a
 * project can copy audio packets instead of rendering a new mix with FFmpeg.
 */
export function canSkipSoundtrackMix(
  videos: readonly MergeVideo[],
  audios: readonly MergeAudio[],
  settings: Pick<MergeSettings, 'keepOriginal' | 'originalVolume' | 'duck' | 'normalize' | 'targetMB' | 'preset'>,
  captions?: { mode: 'soft' | 'burn' } | null,
): boolean {
  if (!videos.length || audios.length || !settings.keepOriginal || settings.originalVolume !== 1) return false;
  // Size targets and picture presets change the video bitrate, not the audio.
  if (settings.duck || (settings.normalize ?? 'off') !== 'off') return false;
  if (captions?.mode === 'burn' || !isSequentialVideo(videos)) return false;
  return videos.every((clip) =>
    !clip.image && !(clip.trimStart ?? 0) && !(clip.trimEnd ?? 0) && clip.probe.hasAudio &&
    !hasSpeed(clip.effects) && !hasAnimation(clip.animation) &&
    !clip.mute && (clip.volume ?? 1) === 1 && (clip.audioTrack ?? 0) === 0);
}

// rematrix_maxval=1 keeps a 5.1 to stereo downmix from clipping (FFmpeg's default
// matrix is not normalised and float WAV output does not clamp).
const STEREO = 'aresample=48000:ochl=stereo:rematrix_maxval=1,aformat=sample_fmts=fltp:channel_layouts=stereo';

/** Merge caption spans so a long transcript stays a manageable filter graph. */
function duckSpans(cues: readonly { start: number; end: number }[], total: number): { start: number; end: number }[] {
  const spans = cues
    .map((cue) => ({ start: Math.max(0, cue.start), end: Math.min(total, cue.end) }))
    .filter((cue) => cue.end > cue.start)
    .sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end + 0.25) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }
  return merged.slice(0, 400);
}

/**
 * Render the soundtrack: inputs are [videos..., audios...]. Returns null when
 * the result would be silent. `cues` enables caption-timed ducking.
 */
export function buildAudioMixPlan(
  videos: readonly MergeVideo[],
  audios: readonly MergeAudio[],
  settings: MergeSettings,
  cues?: readonly { start: number; end: number }[],
): Plan | null {
  const total = totalLength(videos);
  if (!(total > 0)) throw new Error('Add a video first.');
  const starts = videoStarts(videos);
  const explicitStarts = videos.some((clip) => clip.start !== undefined);
  const args: string[] = [];
  const graph: string[] = [];
  let input = 0;

  const audible = (clip: MergeVideo) =>
    !clip.image && clip.probe.hasAudio && !clip.mute && (clip.volume ?? 1) > 0;
  const wantOriginal = settings.keepOriginal && settings.originalVolume > 0 && videos.some(audible);
  let original: string | null = null;
  if (wantOriginal && explicitStarts) {
    const parts: string[] = [];
    videos.forEach((clip, i) => {
      if (!audible(clip)) return;
      const length = videoClipLength(clip);
      const speed = normalizeEffects(clip.effects).speed;
      args.push('-i', audioInputName(i));
      const sourceStart = clip.trimStart ?? 0;
      const delay = starts[i] > 0 ? `,adelay=${Math.round(starts[i] * 1000)}:all=1` : '';
      const retimed = clip.effects?.speedPoints?.length ? retimedAudio(graph, input, clip.audioTrack ?? 0, 'rateo' + i, clip) : null;
      const speedChain = speedAudioChain(speed);
      graph.push(
        (retimed ?? `[${input}:a:${clip.audioTrack ?? 0}]atrim=start=${t(sourceStart)}:end=${t(sourceStart + length * speed)},` +
          `asetpts=PTS-STARTPTS,${speedChain.length ? speedChain.join(',') + ',' : ''}`) +
        `${animatedVolumeChain(clip).join(',')},${STEREO}${delay}[o${i}]`,
      );
      parts.push(`[o${i}]`);
      input += 1;
    });
    if (parts.length) {
      const gain = `volume=${settings.originalVolume.toFixed(4)}`;
      graph.push(parts.length > 1
        ? `${parts.join('')}amix=inputs=${parts.length}:duration=longest:normalize=0:dropout_transition=0,${gain}[orig]`
        : `${parts[0]}${gain}[orig]`);
      original = '[orig]';
    }
  } else if (wantOriginal) {
    const parts: string[] = [];
    videos.forEach((clip, i) => {
      const length = videoClipLength(clip);
      const speed = normalizeEffects(clip.effects).speed;
      if (audible(clip)) {
        args.push('-i', audioInputName(i));
        const start = clip.trimStart ?? 0;
        const retimed = clip.effects?.speedPoints?.length ? retimedAudio(graph, input, clip.audioTrack ?? 0, 'rateo' + i, clip) : null;
        const speedChain = speedAudioChain(speed);
        graph.push(
          (retimed ?? `[${input}:a:${clip.audioTrack ?? 0}]atrim=start=${t(start)}:end=${t(start + length * speed)},` +
            `asetpts=PTS-STARTPTS,${speedChain.length ? speedChain.join(',') + ',' : ''}`) +
          `${animatedVolumeChain(clip).join(',')},${STEREO},apad,atrim=end=${t(length)}[o${i}]`,
        );
        input += 1;
      } else {
        graph.push(`anullsrc=r=48000:cl=stereo,atrim=end=${t(length)},aformat=sample_fmts=fltp:channel_layouts=stereo[o${i}]`);
      }
      parts.push(`[o${i}]`);
    });
    graph.push(`${parts.join('')}concat=n=${videos.length}:v=0:a=1,volume=${settings.originalVolume.toFixed(4)}[orig]`);
    original = '[orig]';
  }

  const added: string[] = [];
  audios.forEach((clip, i) => {
    const length = audioClipLength(clip);
    const visible = Math.min(length, total - clip.offset);
    if (clip.offset >= total || visible <= 0.01 || clip.volume <= 0 || clip.mute) return;
    args.push('-i', audioInputName(videos.length + i));
    const stream = clip.sourceTrack ?? clip.track ?? 0;
    const retimed = clip.retime ? retimedAudio(graph, input, stream, 'ratea' + i, clip) : null;
    const chain = [
      ...(retimed ? [] : [`atrim=start=${t(clip.trimStart)}:end=${t(clip.trimStart + length)}`, 'asetpts=PTS-STARTPTS', STEREO]),
      `volume=${clip.volume.toFixed(4)}`,
    ];
    const fadeIn = Math.min(clip.fadeIn, length / 2);
    const fadeOut = Math.min(clip.fadeOut, length / 2);
    if (fadeIn > 0) chain.push(`afade=t=in:d=${t(fadeIn)}`);
    if (fadeOut > 0) chain.push(`afade=t=out:st=${t(length - fadeOut)}:d=${t(fadeOut)}`);
    if (clip.offset > 0) chain.push(`adelay=${Math.round(clip.offset * 1000)}:all=1`);
    graph.push(`${retimed ?? `[${input}:a:${stream}]`}${chain.join(',')}[add${i}]`);
    added.push(`[add${i}]`);
    input += 1;
  });

  if (!original && !added.length) return null;

  let bus: string | null = null;
  if (added.length) {
    graph.push(added.length > 1
      ? `${added.join('')}amix=inputs=${added.length}:duration=longest:normalize=0:dropout_transition=0[bus]`
      : `${added[0]}anull[bus]`);
    bus = '[bus]';
  }
  let captionsDucked = false;
  if (settings.duck && settings.duckCaptions && bus && cues?.length) {
    const spans = duckSpans(cues, total);
    if (spans.length) {
      const filters = spans.map((span) =>
        `volume=enable='between(t,${t(span.start)},${t(span.end)})':volume=0.35`);
      graph.push(`${bus}${filters.join(',')}[captionduck]`);
      bus = '[captionduck]';
      captionsDucked = true;
    }
  }
  const mix: string[] = [];
  if (original && bus && settings.duck && !captionsDucked) {
    // The videos' own sound pushes the added audio down while it plays.
    graph.push(`${original}asplit=2[omix][okey]`);
    graph.push(`${bus}[okey]sidechaincompress=threshold=0.02:ratio=10:attack=15:release=400:makeup=1[ducked]`);
    mix.push('[omix]', '[ducked]');
  } else {
    if (original) mix.push(original);
    if (bus) mix.push(bus);
  }
  const head = mix.length > 1
    ? `${mix.join('')}amix=inputs=${mix.length}:duration=longest:normalize=0:dropout_transition=0`
    : `${mix[0]}anull`;
  const post: string[] = [];
  if (settings.normalize === 'podcast') post.push('loudnorm=I=-16:TP=-1.5:LRA=11');
  else if (settings.normalize === 'social') post.push('loudnorm=I=-14:TP=-1:LRA=11');
  // Limit once, after every gain stage, so a single clip at 200% cannot clip.
  post.push('alimiter=limit=0.95:level=false');
  graph.push(`${head}${post.map((filter) => `,${filter}`).join('')},apad,atrim=end=${t(total)}[aout]`);

  const webm = settings.format === 'webm';
  const output = webm ? 'mix.webm' : 'mix.m4a';
  return {
    args: [
      ...args, '-filter_complex', graph.join(';'), '-map', '[aout]',
      // The bundled FFmpeg core's libopus crashes; Vorbis is the compatible
      // WebM audio codec there. WebCodecs output is still Opus when copied.
      ...(webm ? ['-c:a', 'libvorbis', '-b:a', '160k'] : ['-c:a', 'aac', '-b:a', '192k']),
      '-ac', '2', '-t', t(total), output,
    ],
    output,
    mime: webm ? 'audio/webm' : 'audio/mp4',
    duration: total,
    texts: [],
  };
}

/** FFmpeg plan for free-positioned clips, gaps, and overlapping track rows. */
function buildSegmentedVideoPlan(
  videos: readonly MergeVideo[],
  settings: MergeSettings,
  extras: { audioCount: number; soundtrack: boolean; srt?: string | null },
): Plan & { copiesVideo: boolean } {
  const total = totalLength(videos);
  const starts = videoStarts(videos);
  const ordered = videos
    .map((clip, index) => ({ clip, start: starts[index] }))
    .sort((a, b) => a.start - b.start || compareVideoPriority(a.clip.track, a.start, b.clip.track, b.start));
  const first = ordered.find((entry) => !entry.clip.image)?.clip.probe ?? ordered[0]?.clip.probe ?? videos[0].probe;
  const { width, height, fit } = targetSize(settings.preset ?? 'source', first, settings.maxShortEdge, {
    width: settings.customWidth,
    height: settings.customHeight,
  });
  const fps = planFrameRate(settings, first.fps);
  const output = `output.${settings.format}`;
  const args: string[] = [];
  const texts: Plan['texts'] = [];
  const graph: string[] = [];
  const segments = videoSegments(videos);
  const usage = new Map<number, number>();
  for (const segment of segments) {
    if (!segment.clip) continue;
    const index = videos.indexOf(segment.clip);
    usage.set(index, (usage.get(index) ?? 0) + 1);
  }
  videos.forEach((clip, index) => {
    if (clip.image) args.push('-loop', '1', '-framerate', String(fps), '-t', t(videoClipLength(clip)));
    args.push('-i', audioInputName(index));
  });

  const labels = new Map<number, string[]>();
  for (const [index, count] of usage) {
    if (count > 1) {
      const outs = Array.from({ length: count }, (_, k) => `[s${index}_${k}]`).join('');
      graph.push(`[${index}:v:0]split=${count}${outs}`);
      labels.set(index, Array.from({ length: count }, (_, k) => `[s${index}_${k}]`));
    } else {
      labels.set(index, [`[${index}:v:0]`]);
    }
  }

  const fitFilter = fit === 'cover'
    ? `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`
    : `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`;
  const used = new Map<number, number>();
  const parts: string[] = [];
  segments.forEach((segment, index) => {
    const out = `[v${index}]`;
    if (!segment.clip) {
      graph.push(`color=c=black:s=${width}x${height}:r=${fps}:d=${t(segment.end - segment.start)},format=yuv420p${out}`);
    } else {
      const sourceIndex = videos.indexOf(segment.clip);
      const usedIndex = used.get(sourceIndex) ?? 0;
      used.set(sourceIndex, usedIndex + 1);
      const available = labels.get(sourceIndex) ?? [`[${sourceIndex}:v:0]`];
      const label = available[Math.min(usedIndex, available.length - 1)];
      const start = segment.sourceStart ?? (segment.clip.trimStart ?? 0);
      const length = segment.end - segment.start;
      const transform = clipTransform(segment.clip.transform);
      const effects = normalizeEffects(segment.clip.effects);
      const rate = speedAtSource(segment.clip.effects, start);
      const sourceLength = length * rate;
      const speedFilter = Math.abs(rate - 1) > 0.0001 ? `setpts=PTS/${rate.toFixed(4)},` : '';
      const colour = colourFilters(effects);
      if (hasClipTransform(transform)) {
        const angle = (transform.rotation * Math.PI) / 180;
        const x = (transform.x / 100) * width;
        const y = (transform.y / 100) * height;
        const zoomX = transform.scale * transform.scaleX;
        const zoomY = transform.scale * transform.scaleY;
        const zoom = Math.abs(zoomX - 1) < 0.0001 && Math.abs(zoomY - 1) < 0.0001 ? '' : `scale=iw*${zoomX.toFixed(6)}:ih*${zoomY.toFixed(6)},`;
        graph.push(`color=c=black:s=${width}x${height}:r=${fps}:d=${t(length)}[bg${index}]`);
        graph.push(
          `${label}trim=start=${t(start)}:end=${t(start + sourceLength)},setpts=PTS-STARTPTS,${speedFilter}${fitFilter},setsar=1,` +
          `${zoom}${colour.length ? colour.join(',') + ',' : ''}rotate=${angle.toFixed(6)}:ow=rotw(${angle.toFixed(6)}):oh=roth(${angle.toFixed(6)}):c=black,format=rgba[fg${index}]`,
        );
        graph.push(
          `[bg${index}][fg${index}]overlay=x='(${width}-w)/2+(${x.toFixed(3)})':y='(${height}-h)/2+(${y.toFixed(3)})':shortest=1,` +
          `fps=${fps},format=yuv420p${out}`,
        );
      } else {
        graph.push(
          `${label}trim=start=${t(start)}:end=${t(start + sourceLength)},setpts=PTS-STARTPTS,${speedFilter}${fitFilter},setsar=1,` +
          `${colour.length ? colour.join(',') + ',' : ''}fps=${fps},format=yuv420p${out}`,
        );
      }
    }
    parts.push(out);
  });
  graph.push(`${parts.join('')}concat=n=${segments.length}:v=1:a=0[vout]`);

  let audioMap: string | null = null;
  let nextInput = videos.length;
  if (extras.soundtrack) {
    args.push('-i', audioInputName(videos.length + extras.audioCount));
    audioMap = `${nextInput}:a:0`;
    nextInput += 1;
  }
  let subtitleMap: string | null = null;
  if (extras.srt) {
    texts.push({ name: 'captions.srt', content: extras.srt });
    args.push('-i', 'captions.srt');
    subtitleMap = `${nextInput}:s:0`;
  }

  args.push('-filter_complex', graph.join(';'), '-map', '[vout]');
  if (audioMap) args.push('-map', audioMap);
  if (subtitleMap) args.push('-map', subtitleMap);
  if (settings.format === 'webm') {
    if (settings.targetMB) {
      const rate = bitrateForSize(settings.targetMB, total, Boolean(audioMap));
      args.push('-c:v', 'libvpx', '-b:v', String(rate), '-maxrate', String(Math.round(rate * 1.5)), '-bufsize', String(rate * 2), '-pix_fmt', 'yuv420p');
    } else {
      args.push('-c:v', 'libvpx', '-crf', '12', '-b:v', '2M', '-pix_fmt', 'yuv420p');
    }
  } else if (settings.targetMB) {
    const rate = bitrateForSize(settings.targetMB, total, Boolean(audioMap));
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-b:v', String(rate), '-maxrate', String(Math.round(rate * 1.5)), '-bufsize', String(rate * 2), '-pix_fmt', 'yuv420p');
  } else {
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p');
  }
  if (audioMap) args.push('-c:a', 'copy');
  else args.push('-an');
  if (subtitleMap) args.push('-c:s', settings.format === 'mkv' ? 'srt' : settings.format === 'webm' ? 'webvtt' : 'mov_text');
  args.push('-t', t(total));
  if (settings.format === 'mp4' || settings.format === 'mov') args.push('-movflags', '+faststart');
  args.push(output);

  return {
    args,
    output,
    mime: MERGE_FORMATS[settings.format].mime,
    duration: total,
    texts,
    copiesVideo: false,
  };
}

/**
 * FFmpeg-only video plan. Inputs are [videos..., audios..., soundtrack?]; the
 * soundtrack file index is `videos.length + audioCount`.
 */
export function buildVideoPlan(
  videos: readonly MergeVideo[],
  settings: MergeSettings,
  extras: { audioCount: number; soundtrack: boolean; srt?: string | null },
): Plan & { copiesVideo: boolean } {
  if (!videos.length) throw new Error('Add a video first.');
  if (videos.some((clip) => clip.effects?.speedPoints?.length) ||
      (videos.some((clip) => clip.start !== undefined) && !isSequentialVideo(videos))) {
    return buildSegmentedVideoPlan(videos, settings, extras);
  }
  const total = totalLength(videos);
  const copy = canCopyVideo(videos, settings.format, settings);
  const output = `output.${settings.format}`;
  const args: string[] = [];
  const texts: Plan['texts'] = [];
  const graph: string[] = [];
  let videoMap: string;
  let nextInput: number;

  if (copy) {
    // The concat demuxer joins identical streams without re-encoding; trims
    // land on the nearest keyframes.
    texts.push({
      name: 'concat.txt',
      content: videos.map((clip, i) => {
        const lines = [`file '${audioInputName(i)}'`];
        if (clip.trimStart) lines.push(`inpoint ${t(clip.trimStart)}`);
        if (clip.trimEnd) lines.push(`outpoint ${t(clip.duration - clip.trimEnd)}`);
        return lines.join('\n');
      }).join('\n') + '\n',
    });
    args.push('-f', 'concat', '-safe', '0', '-i', 'concat.txt');
    videoMap = '0:v:0';
    nextInput = 1;
  } else {
    const first = videos.find((clip) => !clip.image)?.probe ?? videos[0].probe;
    const { width, height, fit } = targetSize(settings.preset ?? 'source', first, settings.maxShortEdge, {
      width: settings.customWidth,
      height: settings.customHeight,
    });
    const fps = planFrameRate(settings, first.fps);
    const fitFilter = fit === 'cover'
      ? `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`
      : `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`;
    const parts: string[] = [];
    videos.forEach((clip, i) => {
      const length = videoClipLength(clip);
      const effects = normalizeEffects(clip.effects);
      const sourceLength = length * effects.speed;
      if (clip.image) args.push('-loop', '1', '-framerate', String(fps), '-t', t(length));
      args.push('-i', audioInputName(i));
      const trim = clip.image ? `trim=duration=${t(length)}` : `trim=start=${t(clip.trimStart ?? 0)}:end=${t((clip.trimStart ?? 0) + sourceLength)}`;
      const speedFilter = !clip.image && Math.abs(effects.speed - 1) > 0.0001 ? `setpts=PTS/${effects.speed.toFixed(4)},` : '';
      const colour = clip.image ? [] : colourFilters(effects);
      const transform = clipTransform(clip.transform);
      if (hasClipTransform(transform)) {
        const angle = (transform.rotation * Math.PI) / 180;
        const x = (transform.x / 100) * width;
        const y = (transform.y / 100) * height;
        const zoomX = transform.scale * transform.scaleX;
        const zoomY = transform.scale * transform.scaleY;
        const zoom = Math.abs(zoomX - 1) < 0.0001 && Math.abs(zoomY - 1) < 0.0001 ? '' : `scale=iw*${zoomX.toFixed(6)}:ih*${zoomY.toFixed(6)},`;
        graph.push(`color=c=black:s=${width}x${height}:r=${fps}:d=${t(length)}[bg${i}]`);
        graph.push(
          `[${i}:v:0]${trim},setpts=PTS-STARTPTS,${speedFilter}${fitFilter},setsar=1,${zoom}` +
          `${colour.length ? colour.join(',') + ',' : ''}rotate=${angle.toFixed(6)}:ow=rotw(${angle.toFixed(6)}):oh=roth(${angle.toFixed(6)}):c=black,format=rgba[fg${i}]`,
        );
        graph.push(
          `[bg${i}][fg${i}]overlay=x='(${width}-w)/2+(${x.toFixed(3)})':y='(${height}-h)/2+(${y.toFixed(3)})':shortest=1,` +
          `fps=${fps},format=yuv420p[v${i}]`,
        );
      } else {
        graph.push(
          `[${i}:v:0]${trim},setpts=PTS-STARTPTS,${speedFilter}${fitFilter},setsar=1,` +
          `${colour.length ? colour.join(',') + ',' : ''}fps=${fps},format=yuv420p[v${i}]`,
        );
      }
      parts.push(`[v${i}]`);
    });
    graph.push(`${parts.join('')}concat=n=${videos.length}:v=1:a=0[vout]`);
    videoMap = '[vout]';
    nextInput = videos.length;
  }

  let audioMap: string | null = null;
  if (extras.soundtrack) {
    args.push('-i', audioInputName(videos.length + extras.audioCount));
    audioMap = `${nextInput}:a:0`;
    nextInput += 1;
  }
  let subtitleMap: string | null = null;
  if (extras.srt) {
    texts.push({ name: 'captions.srt', content: extras.srt });
    args.push('-i', 'captions.srt');
    subtitleMap = `${nextInput}:s:0`;
    nextInput += 1;
  }

  if (graph.length) args.push('-filter_complex', graph.join(';'));
  args.push('-map', videoMap);
  if (audioMap) args.push('-map', audioMap);
  if (subtitleMap) args.push('-map', subtitleMap);
  if (copy) {
    args.push('-c:v', 'copy');
  } else if (settings.format === 'webm') {
    // libvpx-vp9 exhausts memory in the bundled core; VP8 is reliable.
    if (settings.targetMB) {
      const rate = bitrateForSize(settings.targetMB, total, Boolean(audioMap));
      args.push('-c:v', 'libvpx', '-b:v', String(rate), '-maxrate', String(Math.round(rate * 1.5)), '-bufsize', String(rate * 2), '-pix_fmt', 'yuv420p');
    } else {
      args.push('-c:v', 'libvpx', '-crf', '12', '-b:v', '2M', '-pix_fmt', 'yuv420p');
    }
  } else if (settings.targetMB) {
    const rate = bitrateForSize(settings.targetMB, total, Boolean(audioMap));
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-b:v', String(rate), '-maxrate', String(Math.round(rate * 1.5)), '-bufsize', String(rate * 2), '-pix_fmt', 'yuv420p');
  } else {
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p');
  }
  if (audioMap) args.push('-c:a', 'copy');
  else args.push('-an');
  if (subtitleMap) args.push('-c:s', settings.format === 'mkv' ? 'srt' : settings.format === 'webm' ? 'webvtt' : 'mov_text');
  args.push('-t', t(total));
  if (settings.format === 'mp4' || settings.format === 'mov') args.push('-movflags', '+faststart');
  args.push(output);

  return { args, output, mime: MERGE_FORMATS[settings.format].mime, duration: total, texts, copiesVideo: copy };
}
