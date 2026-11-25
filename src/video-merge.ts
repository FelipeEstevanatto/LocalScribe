/**
 * Video merge: join video clips and still images, and add audio on a
 * scrollable timeline.
 *
 * Video clips can be trimmed at both ends. Audio clips can be moved (start
 * offset), trimmed, faded, and balanced against the videos' own sound, with
 * optional ducking. Captions come from Transcribe or an SRT/VTT file and can
 * be kept as a subtitle track or burned in. The preview plays the timeline
 * live; export runs locally (see video-export.ts).
 */

import { AudioFfmpeg, sharedFfmpeg, type MediaProbe, type SubtitleStreamInfo } from './audio-ffmpeg';
import { QUICK_LOCALE_EVENT } from './app-locale';
import { sharedMedia } from './media-router';
import {
  cueAt,
  defaultSubtitleTextStyle,
  defaultTitleTextStyle,
  drawCaption,
  normalizeTextStyle,
  parseCaptions,
  shiftCues,
  titleAccentThickness,
  titleTextParts,
  toSrt,
  type CaptionStyle,
  type Cue,
  type TextObjectStyle,
  type TitleAccent,
} from './captions';
import { findTitlePreset, TITLE_PRESET_GROUPS, TITLE_PRESETS, titlePresetStyle } from './video-title-presets';
import { CAPTION_PRESETS, normalizeCaptionPreset, presetCaptionStyle, type CaptionPreset } from './video-caption-presets';
import {
  canLoadInstalledFonts,
  fontLabelFromValue,
  loadInstalledFontChoices,
  TEXT_FONT_OPTIONS,
  type TextFontCategory,
  type TextFontOption,
} from './title-fonts';
import { errorMessage, isAbortError } from './errors';
import { translateUi } from './i18n';
import { MicrophoneRecorder } from './recorder';
import { audioContext, bufferPeaks } from './studio-player';
import { pruneCachedAssets, readCachedAsset, writeCachedAsset } from './video-asset-cache';
import { createGlPreview, type GlPreview, type PreviewFallbackReason } from './video-gl-preview';
import { createWebGpuPreview, type WebGpuPreview } from './video-webgpu-preview';
import { buildPreviewFramePlan, gpuPreviewWithinBudget } from './video-preview-plan';
import { createKeyframePanel, type KeyframeClip } from './video-keyframe-panel';
import { previewRenderCache } from './video-render-cache';
import { assDialogueWithText, assSegmentAt, plainAssText, readAssCueStyle, type AssSegment } from './ass-subtitles';
import { renderAssInspector } from './video-ass-inspector';
import type { createAssSurface } from './video-ass-renderer';
import type { ExportJob } from './video-export';
import { readMatroskaSubtitleTracks } from './matroska-subtitles';
import { isTextSubtitle, mapEmbeddedCaptions, prepareSourceAudio, readEmbeddedCaptions, supportsOriginalSubtitleStyle, type EmbeddedCaptions, type EmbeddedTimelineCue } from './video-source-media';

type PreviewCompositor = GlPreview | WebGpuPreview;
import { formatBytes, TransferMeter, WorkMeter } from './transfer';
import {
  deleteVideoProject,
  listVideoProjects,
  loadVideoProject,
  saveVideoProject,
  type VideoProject,
  type VideoProjectSummary,
} from './video-projects';
import {
  audioClipLength,
  buildAudioMixPlan,
  canCopyVideo,
  canSkipSoundtrackMix,
  clipTransform,
  clipPlaybackTime,
  clipSourceTime,
  clipSpeedSpans,
  compareVideoPriority,
  dynamicZoomTimingFor,
  DEFAULT_CLIP_TRANSFORM,
  hasClipTransform,
  MERGE_FORMATS,
  MERGE_PRESETS,
  targetSize,
  videoClipLength,
  type ClipTransform,
  type MergeFormat,
  type MergeLoudness,
  type MergePreset,
  type MergeSettings,
} from './video-merge-args';
import { AUDIO_FORMATS, type AudioFormat } from './audio-ffmpeg';
import { advanceSource, normalizeSpeed, normalizeSpeedPoints, ratesFromTimeline, speedAtSource, type PlaybackRates } from './video-retime';
import { formatClock } from './waveform-view';
import { createZip, readZip } from './zip';
import {
  defaultEmojiGraphic,
  defaultGradientGraphic,
  defaultGraphic,
  defaultPatternGraphic,
  defaultSvgGraphic,
  emojiSpriteUrl,
  graphicGradientCss,
  graphicLabel,
  graphicPatternCss,
  GRAPHIC_GRADIENT_PRESETS,
  GRAPHIC_PATTERN_PRESETS,
  type GraphicClip,
  type GraphicFillType,
  type GraphicGradientPreset,
  type GraphicKind,
  type GraphicPattern,
  type GraphicPatternPreset,
  safeSvgSource,
  sanitizeGraphic,
} from './video-graphics';
import { overlayTransitionOpacity, type OverlayTransition } from './video-overlays';
import {
  AI_PROVIDER_PRESETS,
  callAiProvider,
  providerNeedsKey,
  type AiApiStyle,
  type AiChatMessage,
  type AiProviderId,
  type AiSettings,
  type AiToolCall,
  type AiToolSpec,
} from './video-ai';
import {
  TRANSITION_TYPES,
  animationAt,
  DYNAMIC_ZOOM_EASINGS,
  dynamicZoomAt,
  normalizeDynamicZoom,
  type DynamicZoom,
  type DynamicZoomTiming,
  cssFilter,
  effectAnimationAt,
  effectBadges,
  hasAnimation,
  isMotionTransitionType,
  keyframeNear,
  maskCssStyles,
  motionTransitionAt,
  motionTransitionLabel,
  normalizeAnimation,
  normalizeClipTransition,
  normalizeEffects,
  parseCubeLut,
  withKeyframe,
  withoutKeyframe,
  type ClipAnimation,
  type ClipEffects,
  type ClipTransition,
  type ClipTransitionType,
  type TransitionAlignment,
} from './video-effects';
import {
  VIDEO_EFFECTS,
  applyVideoEffect,
  resetVideoEffects,
  type VideoEffectFilter,
  type VideoEffectPreset,
} from './video-effect-presets';

type Strip = Blob | string | null;

interface ClipProxy {
  blob: Blob;
  width: number;
  height: number;
  compatibility?: boolean;
}

interface VideoClip {
  id: number;
  file: File;
  name: string;
  duration: number;
  start: number;
  track: number;
  trimStart: number;
  trimEnd: number;
  image: boolean;
  audioTrack: number;
  volume: number;
  mute: boolean;
  transform: ClipTransform;
  effects: ClipEffects;
  animation: ClipAnimation;
  transition?: ClipTransition;
  proxy: ClipProxy | null;
  proxyUrl: string;
  probe: MediaProbe;
  peaks: Float32Array | null;
  url: string;
  strip: Strip;
  /** Shared id with the linked audio clip, when this video's sound is split out. */
  linkGroup?: number;
  embeddedCaptions?: EmbeddedCaptions;
  dynamicZoomTiming?: DynamicZoomTiming;
  animationTimeOffset?: number;
  /** Audio start relative to this clip's start. Zero for an extracted soundtrack. */
  linkOffset?: number;
}

interface AudioClip {
  id: number;
  file: File;
  name: string;
  duration: number;
  offset: number;
  trimStart: number;
  trimEnd: number;
  volume: number;
  fadeIn: number;
  fadeOut: number;
  track: number;
  sourceTrack?: number;
  tracks: string[];
  muted: boolean;
  url: string;
  peaks: Float32Array | null;
  element: HTMLAudioElement;
  source: MediaElementAudioSourceNode;
  gain: GainNode;
  /** Shared id with the linked video clip. */
  linkGroup?: number;
  retime?: PlaybackRates;
}

interface VideoState {
  id: number;
  file: File;
  name: string;
  duration: number;
  start: number;
  track: number;
  trimStart: number;
  trimEnd: number;
  image: boolean;
  audioTrack: number;
  volume: number;
  mute: boolean;
  transform: ClipTransform;
  effects: ClipEffects;
  animation: ClipAnimation;
  transition?: ClipTransition;
  proxy: ClipProxy | null;
  probe: MediaProbe;
  peaks: Float32Array | null;
  strip: Strip;
  linkGroup?: number;
  embeddedCaptions?: EmbeddedCaptions;
  linkOffset?: number;
}

interface AudioState {
  id: number;
  file: File;
  name: string;
  duration: number;
  offset: number;
  trimStart: number;
  trimEnd: number;
  volume: number;
  fadeIn: number;
  fadeOut: number;
  track: number;
  sourceTrack?: number;
  tracks: string[];
  muted: boolean;
  peaks: Float32Array | null;
  linkGroup?: number;
  retime?: PlaybackRates;
}

interface MediaAsset {
  id: number;
  key: string;
  file: File;
  kind: 'video' | 'audio' | 'image';
  name: string;
  duration: number;
  probe: MediaProbe;
  url: string;
  strip: Strip;
  /** Geometry version of the cached filmstrip. */
  stripVersion?: number;
  /** High-resolution single frame for the media pool card. */
  poster: Blob | null;
  peaks: Float32Array | null;
  proxy: ClipProxy | null;
  proxyUrl: string;
}

interface Snapshot {
  videos: VideoState[];
  audios: AudioState[];
  assets: Omit<MediaAsset, 'url' | 'proxyUrl'>[];
  selected: { kind: 'video' | 'audio'; id: number } | null;
  time: number;
  captionOffset: number;
  captionSource: string;
  captionMode: string;
  captionFileName: string;
  fileCues: Cue[] | null;
  captionTrackState?: { hidden: boolean; locked: boolean };
  captionPreset?: CaptionPreset;
  videoTrackCount: number;
  audioTrackCount: number;
  videoTrackState: { hidden: boolean; muted: boolean; locked?: boolean; solo?: boolean; gain?: number; opacity?: number; color?: string }[];
  audioTrackState: { muted: boolean; locked?: boolean; solo?: boolean; gain?: number; color?: string }[];
  /** Standalone title overlays. */
  titles: Cue[];
  /** Shape and line overlays. */
  graphics: GraphicClip[];
  /** Multi-camera angle switches. */
  cameraCuts: { at: number; track: number }[];
  /** Original-time spans removed by transcript edits. */
  transcriptEdits: { start: number; end: number }[];
}

interface SavedAsset extends Omit<MediaAsset, 'url' | 'proxyUrl'> {}

interface ProjectSettings {
  format: string;
  preset: string;
  customWidth?: number;
  customHeight?: number;
  /** Optional project frame-rate override. Omit for the source rate. */
  fps?: number;
  targetSize: string;
  exactCuts: boolean;
  normalize: string;
  keepOriginal: boolean;
  originalVolume: string;
  duck: boolean;
  duckCaptions: boolean;
  captionPosition: string;
  captionSize: string;
  subtitleStyles?: Record<string, TextObjectStyle>;
  subtitleTransitions?: Record<string, OverlayTransition>;
}

interface ProjectData {
  state: Snapshot;
  assets: SavedAsset[];
  settings: ProjectSettings;
}

export interface MergeOptions {
  download: (blob: Blob, name: string) => void;
  /** Cues of the current Transcribe result, if any. */
  getTranscriptCues: () => Cue[] | null;
  /** Report a long-running job to the app's job tray. */
  trackJob?: (label: string) => { update: (fraction: number, detail?: string) => void; finish: (message: string, ok?: boolean) => void };
  /** Open this clip in the transcriber and keep the timeline intact. */
  sendToTranscribe?: (file: File) => void | Promise<void>;
  /** Open this clip's sound in the Audio studio. */
  sendToAudioStudio?: (file: File) => void | Promise<void>;
  /** Jump to the Text to speech tab for narration. */
  openTts?: () => void;
}

const SNAP_PX = 8;
/** Playhead snapping is deliberately tighter than clip snapping. */
const PLAYHEAD_SNAP_PX = 5;
const IMAGE_SECONDS = 5;
const MAX_HISTORY = 60;
const MAX_PREVIEW_MIX_SECONDS = 30;
const MAX_PREVIEW_AUDIO_BYTES = 64 * 1024 * 1024;
/**
 * Frames sampled into each video's timeline filmstrip. The strip is rendered
 * at twice the normal row height so deep zoom and HiDPI screens stay sharp.
 */
const FILMSTRIP_FRAMES = 16;
const FILMSTRIP_HEIGHT = 144;
const FILMSTRIP_QUALITY = 0.72;
/** Bump when strip geometry changes so old low-resolution strips are rebuilt. */
const FILMSTRIP_CACHE_VERSION = 3;
/** Waveform resolution. More buckets keep transients sharp at deep zoom. */
const PEAKS_PER_SECOND = 120;
const MIN_PEAK_BUCKETS = 8192;
const MAX_PEAK_BUCKETS = 32768;
/** Keep waveform canvases sharp at deep zoom without unbounded GPU memory. */
const MAX_WAVE_CANVAS_WIDTH = 32767;
const MAX_WAVE_COLUMNS = 8192;
/** Render sharp detail around the viewport instead of stretching the base strip. */
const DETAIL_MARGIN_RATIO = 0.25;
const DETAIL_MARGIN_MIN_SECONDS = 0.1;
const DETAIL_WAVE_PIXELS_PER_BUCKET = 2;
const DETAIL_SYNC_DELAY = 180;
/** Ruler detail thresholds, in CSS pixels between ticks. */
const FRAME_TICK_MIN_PX = 6;
const SECOND_TICK_MIN_PX = 10;
const FIVE_BAND_MIN_PX = 24;
const peakBucketCount = (duration: number): number =>
  Math.min(MAX_PEAK_BUCKETS, Math.max(MIN_PEAK_BUCKETS, Math.ceil(Math.max(0, duration) * PEAKS_PER_SECOND)));

/** Highest peak in a fractional bucket range, so transients survive deep zoom. */
function peakEnvelope(peaks: Float32Array, start: number, end: number): number {
  if (!peaks.length) return 0;
  const last = peaks.length - 1;
  const from = Math.max(0, Math.min(last, start));
  const to = Math.max(from, Math.min(last, end));
  const firstIndex = Math.floor(from);
  const lastIndex = Math.floor(to);
  let peak = peaks[firstIndex];
  for (let index = firstIndex + 1; index <= lastIndex; index += 1) {
    if (peaks[index] > peak) peak = peaks[index];
  }
  return peak;
}

/**
 * Bucket count for a range waveform. Never ask for more buckets than there
 * are source samples, or the extra buckets stay empty and the waveform turns
 * into stripes at extreme zoom.
 */
function detailWaveBuckets(
  detailWidth: number,
  dpr: number,
  sourceFrom: number,
  sourceTo: number,
  sampleRate = DETAIL_WAVE_SAMPLE_FLOOR,
): number {
  const rate = sampleRate > 0 ? sampleRate : DETAIL_WAVE_SAMPLE_FLOOR;
  const sampleCap = Math.max(
    DETAIL_WAVE_BUCKETS_MIN,
    Math.ceil(Math.max(0, sourceTo - sourceFrom) * rate),
  );
  return Math.max(
    DETAIL_WAVE_BUCKETS_MIN,
    Math.min(DETAIL_WAVE_BUCKETS_MAX, Math.ceil(detailWidth * dpr), sampleCap),
  );
}
/** Track geometry: header rows and clips share these exact heights. */
let compactTracks = false;
const trackTopPad = (): number => 0;
const trackBottomPad = (): number => 0;
const videoRowHeight = (): number => (compactTracks ? 56 : 72);
const audioRowHeight = (): number => (compactTracks ? 40 : 52);

function probeFallback(duration: number, hasVideo: boolean): MediaProbe {
  return { duration, hasVideo, hasAudio: !hasVideo, videoCodec: null, audioCodec: null, width: 0, height: 0, fps: 0, audioStreams: [] };
}

function describeTrack(stream: NonNullable<MediaProbe['audioStreams']>[number], index: number): string {
  return [`Track ${index + 1}`, stream.title, stream.language?.toUpperCase(), stream.codec, stream.channels].filter(Boolean).join(' · ');
}

/** Read duration (and size for video) with the browser's media stack. */
function readMetadata(url: string, kind: 'video' | 'audio'): Promise<{ duration: number; width: number; height: number }> {
  return new Promise((resolve) => {
    const media = document.createElement(kind);
    const timer = setTimeout(() => resolve({ duration: 0, width: 0, height: 0 }), 8000);
    media.preload = 'metadata';
    media.muted = true;
    const finish = () => {
      clearTimeout(timer);
      const video = media as HTMLVideoElement;
      resolve({
        duration: Number.isFinite(media.duration) ? media.duration : 0,
        width: kind === 'video' ? video.videoWidth : 0,
        height: kind === 'video' ? video.videoHeight : 0,
      });
      media.removeAttribute('src');
    };
    media.onloadedmetadata = () => {
      if (Number.isFinite(media.duration) && media.duration > 0) {
        finish();
        return;
      }
      // Browser recordings (MediaRecorder WebM) carry no duration. Seeking far
      // past the end makes the element scan the file and report the length.
      media.ondurationchange = () => {
        if (Number.isFinite(media.duration) && media.duration > 0) finish();
      };
      media.currentTime = 1e101;
    };
    media.onerror = () => {
      clearTimeout(timer);
      resolve({ duration: 0, width: 0, height: 0 });
    };
    media.src = url;
  });
}

function thumbnailCanvas(width: number, height: number): HTMLCanvasElement | OffscreenCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

async function thumbnailJpeg(canvas: HTMLCanvasElement | OffscreenCanvas, quality: number): Promise<Blob | null> {
  if (typeof OffscreenCanvas !== 'undefined' && canvas instanceof OffscreenCanvas) {
    return canvas.convertToBlob({ type: 'image/jpeg', quality });
  }
  return new Promise<Blob | null>((resolve) => {
    (canvas as HTMLCanvasElement).toBlob((blob) => resolve(blob), 'image/jpeg', quality);
  });
}

/** A dense strip of thumbnails for the timeline, decoded on demand. */
async function filmstrip(file: Blob, url: string, duration: number): Promise<Blob | null> {
  const options = {
    start: 0,
    end: duration,
    frames: FILMSTRIP_FRAMES,
    height: FILMSTRIP_HEIGHT,
    quality: FILMSTRIP_QUALITY,
  };
  try {
    const { extractFilmstripRange, extractFilmstripRepeated } = await import('./media-frames');
    const repeated = await extractFilmstripRepeated(file, options, 8, FILMSTRIP_FRAMES);
    if (repeated) return repeated;
    const strip = await extractFilmstripRange(file, options);
    if (strip) return strip;
  } catch {
    // Fall through to the video element path for containers WebCodecs skips.
  }
  return filmstripSeeked(url, duration);
}

/** Fallback for formats the Mediabunny sink cannot decode. */
async function filmstripSeeked(url: string, duration: number): Promise<Blob | null> {
  const video = document.createElement('video');
  video.muted = true;
  video.preload = 'auto';
  video.playsInline = true;
  video.src = url;
  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve();
      video.onerror = () => reject(new Error('preview'));
    });
    const frames = FILMSTRIP_FRAMES;
    const width = Math.round((video.videoWidth / Math.max(1, video.videoHeight)) * FILMSTRIP_HEIGHT) || 100;
    const canvas = thumbnailCanvas(width * frames, FILMSTRIP_HEIGHT);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    for (let i = 0; i < frames; i += 1) {
      video.currentTime = Math.min(duration - 0.05, ((i + 0.5) / frames) * duration);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1000);
        video.onseeked = () => { clearTimeout(timer); resolve(); };
      });
      ctx.drawImage(video, i * width, 0, width, FILMSTRIP_HEIGHT);
    }
    return await thumbnailJpeg(canvas, FILMSTRIP_QUALITY);
  } catch {
    return null;
  } finally {
    video.removeAttribute('src');
    video.load();
  }
}

let filmstripActive = 0;
const filmstripQueue: Array<() => void> = [];
const filmstripJobs = new Map<string, Promise<Blob | null>>();

function queueFilmstrip<T>(task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const start = (): void => {
      filmstripActive += 1;
      task().then(resolve, reject).finally(() => {
        filmstripActive -= 1;
        filmstripQueue.shift()?.();
      });
    };
    if (filmstripActive < 2) start();
    else filmstripQueue.push(start);
  });
}

/** Deduplicate strips per media key and decode at most two at a time. */
function filmstripFor(file: Blob, url: string, duration: number, cacheKey: string): Promise<Blob | null> {
  const existing = filmstripJobs.get(cacheKey);
  if (existing) return existing;
  const job = (async () => {
    const cache = `strip:v${FILMSTRIP_CACHE_VERSION}:${cacheKey}`;
    const cached = await readCachedAsset<Blob>(cache);
    if (cached) return cached;
    const produced = await queueFilmstrip(() => filmstrip(file, url, duration));
    if (produced) void writeCachedAsset(cache, produced);
    return produced;
  })();
  filmstripJobs.set(cacheKey, job);
  void job.finally(() => filmstripJobs.delete(cacheKey));
  return job;
}

/**
 * Deep-zoom detail strips and range waveforms are rendered on demand for the
 * part of the timeline that is actually on screen. They stay in memory; the
 * full-length base strip remains the persistent cache.
 */
const DETAIL_STRIP_CACHE_LIMIT = 24;
const DETAIL_ENVELOPE_CACHE_LIMIT = 32;
const DETAIL_STRIP_QUALITY = 0.82;
/** A taller detail source stays sharp on high-DPI displays. */
const DETAIL_STRIP_HEIGHT = 240;
const DETAIL_FRAMES_MAX = 64;
const DETAIL_WAVE_BUCKETS_MIN = 64;
const DETAIL_WAVE_BUCKETS_MAX = 131072;
/** Used when the probe did not report an audio sample rate. */
const DETAIL_WAVE_SAMPLE_FLOOR = 48_000;
/**
 * Display envelope window. Signed min/max envelopes stay continuous, so this
 * can be short enough to show individual cycles without turning into stripes.
 */
const DETAIL_WAVE_WINDOW_SECONDS = 0.00025;
const DETAIL_AUDIO_CACHE_BYTES = 64 * 1024 * 1024;

interface DetailStrip {
  url: string;
  at: number;
}

const detailStripCache = new Map<string, DetailStrip>();
const detailStripJobs = new Map<string, Promise<DetailStrip | null>>();
let detailStripActive = 0;
const detailStripQueue: Array<() => void> = [];

function queueDetailStrip<T>(task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const start = (): void => {
      detailStripActive += 1;
      task().then(resolve, reject).finally(() => {
        detailStripActive -= 1;
        detailStripQueue.shift()?.();
      });
    };
    if (detailStripActive < 1) start();
    else detailStripQueue.push(start);
  });
}

function trimDetailStripCache(): void {
  while (detailStripCache.size > DETAIL_STRIP_CACHE_LIMIT) {
    let oldestKey = '';
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [key, value] of detailStripCache) {
      if (value.at < oldestAt) {
        oldestAt = value.at;
        oldestKey = key;
      }
    }
    if (!oldestKey) break;
    const oldest = detailStripCache.get(oldestKey);
    if (oldest) URL.revokeObjectURL(oldest.url);
    detailStripCache.delete(oldestKey);
  }
}

/** Seek a paused video and wait until the decoded frame is ready to draw. */
function waitForVideoSeek(video: HTMLVideoElement, time: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    let frameTimer = 0;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      video.removeEventListener('seeked', onSeeked);
      window.clearTimeout(timer);
      window.clearTimeout(frameTimer);
      resolve();
    };
    const onSeeked = (): void => {
      if ('requestVideoFrameCallback' in video) {
        frameTimer = window.setTimeout(finish, 90);
        video.requestVideoFrameCallback(() => finish());
      } else {
        finish();
      }
    };
    const timer = window.setTimeout(finish, 1500);
    video.addEventListener('seeked', onSeeked, { once: true });
    try {
      video.currentTime = time;
    } catch {
      finish();
    }
  });
}

/** Decode only [start, end] and return a few dozen sharp thumbnails. */
async function filmstripRange(
  file: Blob,
  url: string,
  duration: number,
  start: number,
  end: number,
  frames: number,
): Promise<Blob | null> {
  try {
    const { extractFilmstripRange } = await import('./media-frames');
    const strip = await extractFilmstripRange(file, {
      start,
      end,
      frames,
      height: DETAIL_STRIP_HEIGHT,
      quality: DETAIL_STRIP_QUALITY,
    });
    if (strip) return strip;
  } catch {
    // Fall through to the video element path for containers WebCodecs skips.
  }
  return filmstripRangeSeeked(url, duration, start, end, frames);
}

/** Fallback frame sampler for formats the Mediabunny sink cannot decode. */
async function filmstripRangeSeeked(
  url: string,
  duration: number,
  start: number,
  end: number,
  frames: number,
): Promise<Blob | null> {
  const video = document.createElement('video');
  video.muted = true;
  video.preload = 'auto';
  video.playsInline = true;
  video.src = url;
  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve();
      video.onerror = () => reject(new Error('detail preview'));
    });
    const length = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : duration;
    const ratio = video.videoWidth / Math.max(1, video.videoHeight);
    const width = Math.round(ratio * DETAIL_STRIP_HEIGHT) || 100;
    const count = Math.max(1, Math.min(DETAIL_FRAMES_MAX, Math.round(frames)));
    const canvas = thumbnailCanvas(width * count, DETAIL_STRIP_HEIGHT);
    const context = canvas.getContext('2d');
    if (!context) return null;
    const from = Math.max(0, Math.min(length, start));
    const to = Math.max(from, Math.min(length, end));
    const span = Math.max(0.001, to - from);
    for (let index = 0; index < count; index += 1) {
      const time = Math.max(0, Math.min(length - 0.001, from + ((index + 0.5) / count) * span));
      await waitForVideoSeek(video, time);
      context.drawImage(video, index * width, 0, width, DETAIL_STRIP_HEIGHT);
    }
    return await thumbnailJpeg(canvas, DETAIL_STRIP_QUALITY);
  } catch {
    return null;
  } finally {
    video.removeAttribute('src');
    video.load();
  }
}

function detailStripFor(
  file: Blob,
  url: string,
  duration: number,
  start: number,
  end: number,
  frames: number,
  cacheKey: string,
): Promise<DetailStrip | null> {
  const key = `${cacheKey}:${start.toFixed(3)}:${end.toFixed(3)}:${frames}`;
  const cached = detailStripCache.get(key);
  if (cached) {
    cached.at = Date.now();
    return Promise.resolve(cached);
  }
  const existing = detailStripJobs.get(key);
  if (existing) return existing;
  const job = queueDetailStrip(async () => {
    const blob = await filmstripRange(file, url, duration, start, end, frames);
    if (!blob) return null;
    const detail: DetailStrip = { url: URL.createObjectURL(blob), at: Date.now() };
    detailStripCache.set(key, detail);
    trimDetailStripCache();
    return detail;
  });
  detailStripJobs.set(key, job);
  void job.finally(() => detailStripJobs.delete(key)).catch(() => undefined);
  return job;
}

interface DetailEnvelope {
  min: Float32Array;
  max: Float32Array;
  at: number;
}

const detailEnvelopeCache = new Map<string, DetailEnvelope>();
const detailEnvelopeJobs = new Map<string, Promise<DetailEnvelope | null>>();
let detailEnvelopeActive = 0;
const detailEnvelopeQueue: Array<() => void> = [];

function queueDetailEnvelope<T>(task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const start = (): void => {
      detailEnvelopeActive += 1;
      task().then(resolve, reject).finally(() => {
        detailEnvelopeActive -= 1;
        detailEnvelopeQueue.shift()?.();
      });
    };
    if (detailEnvelopeActive < 1) start();
    else detailEnvelopeQueue.push(start);
  });
}

function storeDetailEnvelope(key: string, envelope: DetailEnvelope): DetailEnvelope {
  detailEnvelopeCache.set(key, { ...envelope, at: Date.now() });
  while (detailEnvelopeCache.size > DETAIL_ENVELOPE_CACHE_LIMIT) {
    let oldestKey = '';
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [cacheKey, value] of detailEnvelopeCache) {
      if (value.at < oldestAt) {
        oldestAt = value.at;
        oldestKey = cacheKey;
      }
    }
    if (!oldestKey) break;
    detailEnvelopeCache.delete(oldestKey);
  }
  return envelope;
}

interface DecodedAudio {
  buffer: AudioBuffer;
  bytes: number;
  at: number;
}

const decodedAudioCache = new Map<string, DecodedAudio>();
let decodedAudioBytes = 0;

function trimDecodedAudioCache(): void {
  while (decodedAudioBytes > DETAIL_AUDIO_CACHE_BYTES && decodedAudioCache.size) {
    let oldestKey = '';
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [key, value] of decodedAudioCache) {
      if (value.at < oldestAt) {
        oldestAt = value.at;
        oldestKey = key;
      }
    }
    if (!oldestKey) break;
    const oldest = decodedAudioCache.get(oldestKey);
    if (oldest) decodedAudioBytes -= oldest.bytes;
    decodedAudioCache.delete(oldestKey);
  }
}

function bufferEnvelopeRange(
  buffer: AudioBuffer,
  start: number,
  end: number,
  buckets: number,
): { min: Float32Array; max: Float32Array } {
  const count = Math.max(1, Math.floor(buckets));
  const min = new Float32Array(count);
  const max = new Float32Array(count);
  const duration = Math.max(0.001, buffer.duration);
  const from = Math.max(0, Math.min(duration, start));
  const to = Math.max(from, Math.min(duration, end));
  const span = Math.max(0.000001, to - from);
  const first = Math.max(0, Math.floor((from / duration) * buffer.length));
  const last = Math.min(buffer.length, Math.ceil((to / duration) * buffer.length));
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let index = first; index < last; index += 1) {
      const time = (index / buffer.length) * duration;
      const bucket = Math.min(count - 1, Math.max(0, Math.floor(((time - from) / span) * count)));
      const value = data[index];
      if (value < min[bucket]) min[bucket] = value;
      if (value > max[bucket]) max[bucket] = value;
    }
  }
  return { min, max };
}

async function decodedAudioFor(
  file: File,
  cacheKey: string,
  signal: AbortSignal,
): Promise<AudioBuffer | null> {
  const cached = decodedAudioCache.get(cacheKey);
  if (cached) {
    cached.at = Date.now();
    return cached.buffer;
  }
  if (file.size > 160_000_000) return null;
  const buffer = await audioContext().decodeAudioData(await file.arrayBuffer());
  signal.throwIfAborted();
  const bytes = buffer.length * buffer.numberOfChannels * 4;
  if (bytes <= DETAIL_AUDIO_CACHE_BYTES) {
    decodedAudioCache.set(cacheKey, { buffer, bytes, at: Date.now() });
    decodedAudioBytes += bytes;
    trimDecodedAudioCache();
  }
  return buffer;
}

/** High-resolution signed envelope for one source time range. */
function envelopeForRange(
  file: File,
  start: number,
  end: number,
  buckets: number,
  cacheKey: string,
  signal: AbortSignal,
): Promise<DetailEnvelope | null> {
  const key = `${cacheKey}:${start.toFixed(3)}:${end.toFixed(3)}:${buckets}`;
  const cached = detailEnvelopeCache.get(key);
  if (cached) {
    cached.at = Date.now();
    return Promise.resolve(cached);
  }
  const existing = detailEnvelopeJobs.get(key);
  if (existing) return existing;
  const job = queueDetailEnvelope(async () => {
    try {
      const { streamAudioEnvelopeRange } = await import('./mediabunny-engine');
      const envelope = await streamAudioEnvelopeRange(file, start, end, buckets, signal, 1);
      if (envelope) return storeDetailEnvelope(key, { ...envelope, at: Date.now() });
    } catch (error) {
      if (isAbortError(error)) throw error;
    }
    try {
      const buffer = await decodedAudioFor(file, cacheKey, signal);
      if (!buffer) return null;
      const envelope = bufferEnvelopeRange(buffer, start, end, buckets);
      return storeDetailEnvelope(key, { ...envelope, at: Date.now() });
    } catch (error) {
      if (isAbortError(error)) throw error;
      return null;
    }
  });
  detailEnvelopeJobs.set(key, job);
  void job.finally(() => detailEnvelopeJobs.delete(key)).catch(() => undefined);
  return job;
}

/** One large, sharp frame for the media pool instead of an upscaled filmstrip. */
const POSTER_MAX_WIDTH = 1280;
const posterJobs = new Map<string, Promise<Blob | null>>();

async function posterFrame(url: string, duration: number): Promise<Blob | null> {
  const video = document.createElement('video');
  video.muted = true;
  video.preload = 'auto';
  video.playsInline = true;
  video.src = url;
  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve();
      video.onerror = () => reject(new Error('poster'));
    });
    const length = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : duration;
    video.currentTime = Math.max(0.05, Math.min(length - 0.05, length * 0.12));
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1500);
      video.onseeked = () => { clearTimeout(timer); resolve(); };
    });
    const sourceWidth = video.videoWidth || 1280;
    const sourceHeight = video.videoHeight || 720;
    const scale = Math.min(1, POSTER_MAX_WIDTH / sourceWidth);
    const canvas = thumbnailCanvas(
      Math.max(1, Math.round(sourceWidth * scale)),
      Math.max(1, Math.round(sourceHeight * scale)),
    );
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return await thumbnailJpeg(canvas, 0.9);
  } catch {
    return null;
  } finally {
    video.removeAttribute('src');
    video.load();
  }
}

/** Deduplicate posters per media key and share the filmstrip decode queue. */
function posterFor(url: string, duration: number, cacheKey: string): Promise<Blob | null> {
  const existing = posterJobs.get(cacheKey);
  if (existing) return existing;
  const job = (async () => {
    const cached = await readCachedAsset<Blob>(`poster:${cacheKey}`);
    if (cached) return cached;
    const produced = await queueFilmstrip(() => posterFrame(url, duration));
    if (produced) void writeCachedAsset(`poster:${cacheKey}`, produced);
    return produced;
  })();
  posterJobs.set(cacheKey, job);
  void job.finally(() => posterJobs.delete(cacheKey));
  return job;
}

export function setupVideoMerge(root: HTMLElement, options: MergeOptions) {
  const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
    const element = root.querySelector<T>('#video-' + id);
    if (!element) throw new Error('Missing video control: ' + id);
    return element;
  };
  const ffmpeg = sharedFfmpeg();
  const mediaInput = $<HTMLInputElement>('media-input');
  const editor = $('editor');
  const emptyStage = $('empty-stage');
  const emptyTitle = $('empty-title');
  const emptyHint = $('empty-hint');
  const mediaCount = $('media-count');
  const mediaSearch = $<HTMLInputElement>('media-search');
  const mediaKind = $<HTMLSelectElement>('media-kind');
  const effectsSearch = $<HTMLInputElement>('effects-search');
  const effectsGrid = $('effects-grid');
  const effectsCount = $('effects-count');
  const effectsReset = $<HTMLButtonElement>('effects-reset');
  const effectFilterButtons = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-effect-filter]'));
  const mediaSort = $<HTMLSelectElement>('media-sort');
  const mediaList = $('media-list');
  const trackHeaderList = $('track-header-list');
  const timelineTools = $('timeline-tools');
  const timelineBox = $('timeline-box');
  const historyPanel = $('history-panel');
  const historyList = $('history-list');
  const historyClose = $<HTMLButtonElement>('history-close');
  const trackMenu = $('track-menu');
  const timelineMenu = $('timeline-menu');
  const toolRail = $('tool-rail');
  const timecode = $('timecode');
  const stage = $('stage');
  const stageWrap = $('stage-wrap');
  const safe = $('safe');
  const preview = $<HTMLVideoElement>('preview');
  const still = $<HTMLImageElement>('still');
  const preloadVideo = document.createElement('video');
  preloadVideo.muted = true;
  preloadVideo.playsInline = true;
  preloadVideo.preload = 'auto';
  preloadVideo.className = 'video-preload';
  root.append(preloadVideo);
  let warmedVideoKey = '';
  let warmedVideoAt = 0;
  const graphicsLayer = $('graphics-layer');
  const textLayer = $('text-layer');
  const playButton = $<HTMLButtonElement>('play');
  const skipBackButton = $<HTMLButtonElement>('skip-back');
  const skipForwardButton = $<HTMLButtonElement>('skip-forward');
  const loopButton = $<HTMLButtonElement>('loop');
  const muteButton = $<HTMLButtonElement>('mute');
  const previewVolumeInput = $<HTMLInputElement>('volume');
  const previewVolumeValue = $<HTMLOutputElement>('volume-value');
  const aspectSelect = $<HTMLSelectElement>('aspect');
  const qualitySelect = $<HTMLSelectElement>('quality');
  const previewZoomSelect = $<HTMLSelectElement>('preview-zoom');
  const gridToggle = $<HTMLButtonElement>('grid-toggle');
  const stageSnapToggle = $<HTMLButtonElement>('stage-snap');
  const safeToggle = $<HTMLButtonElement>('safe-toggle');
  const fullscreenButton = $<HTMLButtonElement>('fullscreen');
  const maximizeButton = $<HTMLButtonElement>('maximize');
  const compositionGrid = root.querySelector<HTMLElement>('#video-composition-grid');
  const timeLabel = $('time');
  const commandOverlay = $('command-overlay');
  const commandInput = $<HTMLInputElement>('command-input');
  const commandList = $('command-list');
  const commandClose = $<HTMLButtonElement>('command-close');
  const inspector = $('inspector');
  const titleAdd = $<HTMLButtonElement>('title-add');
  const titlePresetGrid = $('title-preset-grid');
  const titlePresetFilter = $<HTMLSelectElement>('title-preset-filter');
  const titleList = $('title-list');
  const embeddedCueEditor = $('embedded-cue-editor');
  const titleSummary = $('title-summary');
  const titleEditor = $('title-editor');
  const titleText = $<HTMLTextAreaElement>('title-text');
  const titleStart = $<HTMLInputElement>('title-start');
  const titleDuration = $<HTMLInputElement>('title-duration');
  const titleTrackSelect = $<HTMLSelectElement>('title-track');
  const textStyleEditor = $('text-style-editor');
  const textStyleTarget = $('text-style-target');
  const textFont = $<HTMLSelectElement>('text-font');
  const fontOpen = $<HTMLButtonElement>('font-open');
  const fontCurrent = $('font-current');
  const fontAa = $('font-aa');
  const fontDialog = $<HTMLDialogElement>('font-dialog');
  const fontClose = $<HTMLButtonElement>('font-close');
  const fontSearch = $<HTMLInputElement>('font-search');
  const fontCategories = $('font-categories');
  const fontList = $('font-list');
  const fontStatus = $('font-status');
  const fontCount = $('font-count');
  const fontLoad = $<HTMLButtonElement>('font-load');
  const textSize = $<HTMLInputElement>('text-size');
  const textWeight = $<HTMLSelectElement>('text-weight');
  const textAlign = $<HTMLSelectElement>('text-align');
  const textColor = $<HTMLInputElement>('text-color');
  const textX = $<HTMLInputElement>('text-x');
  const textY = $<HTMLInputElement>('text-y');
  const textMaxWidth = $<HTMLInputElement>('text-max-width');
  const textRotation = $<HTMLInputElement>('text-rotation');
  const textItalic = $<HTMLInputElement>('text-italic');
  const textUppercase = $<HTMLInputElement>('text-uppercase');
  const textLineHeight = $<HTMLInputElement>('text-line-height');
  const textOutlineWidth = $<HTMLInputElement>('text-outline-width');
  const textOutlineColor = $<HTMLInputElement>('text-outline-color');
  const textShadowBlur = $<HTMLInputElement>('text-shadow-blur');
  const textShadowX = $<HTMLInputElement>('text-shadow-x');
  const textShadowY = $<HTMLInputElement>('text-shadow-y');
  const textShadowColor = $<HTMLInputElement>('text-shadow-color');
  const textBackground = $<HTMLInputElement>('text-background');
  const textBackgroundOpacity = $<HTMLInputElement>('text-background-opacity');
  const textPadding = $<HTMLInputElement>('text-padding');
  const textRadius = $<HTMLInputElement>('text-radius');
  const titleDetails = $<HTMLDetailsElement>('title-details');
  const titleAccent = $<HTMLSelectElement>('title-accent');
  const titleAccentColor = $<HTMLInputElement>('title-accent-color');
  const titleDetailLine = $<HTMLSelectElement>('title-detail-line');
  const titleDetailScale = $<HTMLInputElement>('title-detail-scale');
  const titleDetailColor = $<HTMLInputElement>('title-detail-color');
  const textSoftNote = $('text-soft-note');
  const textStyleReset = $<HTMLButtonElement>('text-style-reset');
  const graphicAddButtons = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-graphic-add]'));
  const graphicList = $('graphic-list');
  const graphicSummary = $('graphic-summary');
  const graphicEditor = $('graphic-editor');
  const graphicFill = $<HTMLInputElement>('graphic-fill');
  const graphicFill2 = $<HTMLInputElement>('graphic-fill2');
  const graphicFillType = $<HTMLSelectElement>('graphic-fill-type');
  const graphicGradientAngle = $<HTMLInputElement>('graphic-gradient-angle');
  const graphicPattern = $<HTMLSelectElement>('graphic-pattern');
  const graphicPatternColor = $<HTMLInputElement>('graphic-pattern-color');
  const graphicPatternScale = $<HTMLInputElement>('graphic-pattern-scale');
  const graphicPaintFields = $('graphic-paint-fields');
  const graphicPatternFields = $('graphic-pattern-fields');
  const graphicSpecialNote = $('graphic-special-note');
  const graphicStroke = $<HTMLInputElement>('graphic-stroke');
  const graphicStrokeWidth = $<HTMLInputElement>('graphic-stroke-width');
  const graphicOpacity = $<HTMLInputElement>('graphic-opacity');
  const graphicRotation = $<HTMLInputElement>('graphic-rotation');
  const graphicX = $<HTMLInputElement>('graphic-x');
  const graphicY = $<HTMLInputElement>('graphic-y');
  const graphicWidth = $<HTMLInputElement>('graphic-width');
  const graphicHeight = $<HTMLInputElement>('graphic-height');
  const graphicStart = $<HTMLInputElement>('graphic-start');
  const graphicDuration = $<HTMLInputElement>('graphic-duration');
  const graphicTrackSelect = $<HTMLSelectElement>('graphic-track');
  const graphicRadius = $<HTMLInputElement>('graphic-radius');
  const patternGrid = $('pattern-grid');
  const gradientGrid = $('gradient-grid');
  const svgImport = $<HTMLButtonElement>('svg-import');
  const svgInput = $<HTMLInputElement>('svg-input');
  const svgList = $('svg-list');
  const emojiGrid = $('emoji-grid');
  const animationRoot = $('animation-panel');
  const animationToggle = $<HTMLButtonElement>('animation-toggle');
  let animationPanel: ReturnType<typeof createKeyframePanel> | undefined;
  const transitionButtons = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-transition]'));
  const aiActionButtons = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-ai-action]'));
  const templateButtons = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-template]'));
  const recipeButtons = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-recipe]'));
  const aiChatLog = $('ai-chat-log');
  const aiPending = $('ai-pending');
  const aiMessage = $<HTMLTextAreaElement>('ai-message');
  const aiSend = $<HTMLButtonElement>('ai-send');
  const aiClear = $<HTMLButtonElement>('ai-clear');
  const aiStep = $('ai-step');
  const aiConnection = $('ai-connection');
  const aiSettingsButton = $<HTMLButtonElement>('ai-settings');
  const aiSettingsModal = $('ai-settings-modal');
  const aiSettingsClose = $<HTMLButtonElement>('ai-settings-close');
  const aiSettingsDone = $<HTMLButtonElement>('ai-settings-done');
  const aiSettingsStatus = $('ai-settings-status');
  const aiProvider = $<HTMLSelectElement>('ai-provider');
  const aiModel = $<HTMLInputElement>('ai-model');
  const aiBase = $<HTMLInputElement>('ai-base');
  const aiCorsNote = $('ai-cors-note');
  const aiStyle = $<HTMLSelectElement>('ai-style');
  const aiPreview = $<HTMLInputElement>('ai-preview');
  const aiAuto = $<HTMLInputElement>('ai-auto');
  const aiKey = $<HTMLInputElement>('ai-key');
  const aiKeyProvider = $('ai-key-provider');
  const aiKeyNote = $('ai-key-note');
  const aiKeyClear = $<HTMLButtonElement>('ai-key-clear');
  const aiSettingsTabs = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-ai-settings-tab]'));
  const aiSettingsPanels = Array.from(root.querySelectorAll<HTMLElement>('[data-ai-settings-panel]'));
  const multicamAngles = $('multicam-angles');
  const multicamCuts = $('multicam-cuts');
  const multicamClear = $<HTMLButtonElement>('multicam-clear');
  const keepOriginal = $<HTMLInputElement>('keep-original');
  const originalVolume = $<HTMLInputElement>('original-volume');
  const originalVolumeValue = $('original-volume-value');
  const duck = $<HTMLInputElement>('duck');
  const duckCaptions = $<HTMLInputElement>('duck-captions');
  const mixer = $('mixer');
  const preset = $<HTMLSelectElement>('preset');
  let customWidth = 0;
  let customHeight = 0;
  const targetSizeInput = $<HTMLInputElement>('target-size');
  const exactCuts = $<HTMLInputElement>('exact-cuts');
  const normalize = $<HTMLSelectElement>('normalize');
  const captionSource = $<HTMLSelectElement>('caption-source');
  const captionFile = $<HTMLInputElement>('caption-file');
  const captionMode = $<HTMLSelectElement>('caption-mode');
  const captionPresetGrid = $('caption-presets');
  const captionPresetNote = $('caption-preset-note');
  const captionPresetButtons: HTMLButtonElement[] = [];
  const captionOffsetInput = $<HTMLInputElement>('caption-offset');
  const captionPosition = $<HTMLSelectElement>('caption-position');
  const captionSize = $<HTMLSelectElement>('caption-size');
  const captionStatus = $('caption-status');
  const captionWarning = $('caption-warning');
  const captionDownload = $<HTMLButtonElement>('caption-download');
  const outputSummary = $('output-summary');
  const exportWarning = $('export-warning');
  const scroll = $('scroll');
  const content = $('content');
  const ruler = $('ruler');
  const grid = $('grid');
  const captionLane = $('lane-caption');
  const videoLane = $('lane-video');
  const audioLane = $('lane-audio');
  const playhead = $('playhead');
  const videoEnd = $('end');
  const zoom = $<HTMLInputElement>('zoom');
  const undoButton = $<HTMLButtonElement>('undo');
  const redoButton = $<HTMLButtonElement>('redo');
  const splitButton = $<HTMLButtonElement>('split');
  const fitButton = $<HTMLButtonElement>('fit');
  const addTrackButton = $<HTMLButtonElement>('add-track');
  const addTrackMenu = $('add-track-menu');
  const addTrackItems = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-add-track]'));
  const sideTabs = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-video-side]'));
  const sidePanels = Array.from(root.querySelectorAll<HTMLElement>('[data-video-panel]'));
  const libraryTitle = $('library-title');
  const libraryKicker = $('library-kicker');
  const libraryCollapse = $<HTMLButtonElement>('library-collapse');
  const libraryRail = $<HTMLButtonElement>('library-rail');
  const libraryPanels = Array.from(root.querySelectorAll<HTMLElement>('[data-video-library-panel]'));
  const inspectorClose = $('inspector-close');
  const inspectorRail = $('inspector-rail');
  const projectName = $<HTMLInputElement>('project-name');
  const searchButton = $<HTMLButtonElement>('search');
  const modeManual = $<HTMLButtonElement>('mode-manual');
  const modeAi = $<HTMLButtonElement>('mode-ai');
  const projectMeta = $('project-meta');
  const projectState = $('project-state');
  const projectSave = $<HTMLButtonElement>('project-save');
  const projectOpen = $<HTMLButtonElement>('project-open');
  const projectReopen = $<HTMLButtonElement>('project-reopen');
  const projectMenu = $('project-menu');
  const projectList = $('project-list');
  const projectNew = $<HTMLButtonElement>('project-new');
  const projectExport = $<HTMLButtonElement>('project-export');
  const projectImport = $<HTMLButtonElement>('project-import');
  const projectRelink = $<HTMLButtonElement>('project-relink');
  const projectFile = $<HTMLInputElement>('project-file');
  const projectRelinkFile = $<HTMLInputElement>('project-relink-file');
  const projectSettingsButton = $<HTMLButtonElement>('project-settings');
  const projectSettingsModal = $('project-settings-modal');
  const projectSettingsClose = $<HTMLButtonElement>('ps-close');
  const projectSettingsCancel = $<HTMLButtonElement>('ps-cancel');
  const projectSettingsSave = $<HTMLButtonElement>('ps-save');
  const projectSettingsStatus = $('ps-status');
  const projectSettingsName = $<HTMLInputElement>('ps-name');
  const projectSettingsResolution = $<HTMLSelectElement>('ps-resolution');
  const projectSettingsCustomRow = $('ps-custom-row');
  const projectSettingsCustomWidth = $<HTMLInputElement>('ps-custom-width');
  const projectSettingsCustomHeight = $<HTMLInputElement>('ps-custom-height');
  const projectSettingsCanvas = $('ps-canvas');
  const projectSettingsFps = $<HTMLSelectElement>('ps-fps');
  const projectSettingsCustomFps = $<HTMLInputElement>('ps-custom-fps');
  const projectSettingsCustomFpsRow = $('ps-custom-fps-row');
  const projectSettingsDuration = $('ps-duration');
  const projectSettingsSummary = $('ps-summary');
  const projectSettingsNormalize = $<HTMLSelectElement>('ps-normalize');
  const projectSettingsKeepOriginal = $<HTMLInputElement>('ps-keep-original');
  const projectSettingsVolume = $<HTMLInputElement>('ps-original-volume');
  const projectSettingsVolumeValue = $('ps-original-volume-value');
  const projectSettingsDuck = $<HTMLInputElement>('ps-duck');
  const projectSettingsDuckCaptions = $<HTMLInputElement>('ps-duck-captions');
  const projectSettingsCaptionSource = $<HTMLSelectElement>('ps-caption-source');
  const projectSettingsCaptionMode = $<HTMLSelectElement>('ps-caption-mode');
  const projectSettingsCaptionPosition = $<HTMLSelectElement>('ps-caption-position');
  const projectSettingsCaptionSize = $<HTMLSelectElement>('ps-caption-size');
  const projectSettingsQuality = $<HTMLSelectElement>('ps-quality');
  const projectSettingsZoom = $<HTMLSelectElement>('ps-zoom');
  const projectSettingsGpuPreview = $<HTMLInputElement>('ps-gpu-preview');
  const projectSettingsNav = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-project-settings-tab]'));
  const projectSettingsPanels = Array.from(root.querySelectorAll<HTMLElement>('[data-project-settings-panel]'));
  const defaultProjectName = (): string => translateUi('Untitled project');
  let projectNameIsDefault = projectName.value.trim() === 'Untitled project' || !projectName.value.trim();
  const format = $<HTMLSelectElement>('format');
  const exportMain = $<HTMLButtonElement>('export-main');
  const exportToggle = $<HTMLButtonElement>('export-toggle');
  const exportMenu = $('export-menu');
  const exportControl = $('export-control');
  const exportButton = $<HTMLButtonElement>('export');
  const exportModal = $('export-modal');
  const exportClose = $<HTMLButtonElement>('export-close');
  const exportCancel = $<HTMLButtonElement>('export-cancel');
  const exportContainer = $<HTMLSelectElement>('export-container');
  const exportResolution = $<HTMLSelectElement>('export-resolution');
  const exportQuality = $<HTMLInputElement>('export-quality');
  const exportQualityValue = $('export-quality-value');
  const exportTarget = $<HTMLInputElement>('export-target');
  const exportLoudness = $<HTMLSelectElement>('export-loudness');
  const exportExact = $<HTMLInputElement>('export-exact');
  const exportModeVideo = $<HTMLInputElement>('export-mode-video');
  const exportModeAudio = $<HTMLInputElement>('export-mode-audio');
  const exportAudioFormat = $<HTMLSelectElement>('export-audio-format');
  const exportAudioFormatField = $('export-audio-format-field');
  const exportPlatformSection = $('export-platform-section');
  const exportVideoSettings = $('export-video-settings');
  const exportSummary = $('export-summary');
  const exportRangeMarked = $<HTMLInputElement>('export-range-marked');
  const exportRangeAll = $<HTMLInputElement>('export-range-all');
  const exportRangeHint = $('export-range-hint');
  const exportSourceMeta = $('export-source-meta');
  const markInButton = $<HTMLButtonElement>('mark-in');
  const markOutButton = $<HTMLButtonElement>('mark-out');
  const markClearButton = $<HTMLButtonElement>('mark-clear');
  const rangeInMarker = $('range-in');
  const rangeOutMarker = $('range-out');
  const rangeRegion = $('range-region');
  const reset = $<HTMLButtonElement>('reset');
  const exportNote = $('export-note');
  const status = $('status');
  const progressBox = $('progress');
  const progressLabel = $('progress-label');
  const progressDetail = $('progress-detail');
  const progressBar = $('progress-bar');
  const progressSub = $('progress-sub');
  const cancel = $<HTMLButtonElement>('cancel');
  let statusTimer = 0;
  new MutationObserver(() => {
    window.clearTimeout(statusTimer);
    status.title = status.textContent?.trim() ?? '';
    if (!status.textContent) return;
    statusTimer = window.setTimeout(() => {
      status.textContent = '';
    }, 6000);
  }).observe(status, { childList: true, characterData: true, subtree: true });
  const recordButton = $<HTMLButtonElement>('record');
  const recordLabel = recordButton.querySelector<HTMLElement>('[data-record-label]');
  const recordPanel = $('record-panel');
  const recordTime = $('record-time');
  const recordLevel = $('record-level');
  const recordStop = $<HTMLButtonElement>('record-stop');
  const recordCancel = $<HTMLButtonElement>('record-cancel');

  for (const [value, spec] of Object.entries(MERGE_FORMATS)) format.add(new Option(spec.label, value));
  for (const [value, spec] of Object.entries(MERGE_PRESETS)) preset.add(new Option(spec.label, value));

  const recorder = new MicrophoneRecorder();
  const ctx = audioContext();  const previewSource = ctx.createMediaElementSource(preview);
  const previewGain = ctx.createGain();
  previewSource.connect(previewGain).connect(ctx.destination);
  preview.volume = 1;
  let audioMixBuffer: AudioBuffer | null = null;
  let audioMixDirty = true;
  let audioMixNeedsStart = false;
  let audioMixTimer = 0;
  let audioMixToken = 0;
  let audioMixSource: AudioBufferSourceNode | null = null;
  let audioMixGain: GainNode | null = null;
  const audioMixBuffers = new Map<File, AudioBuffer>();
  let audioMixBytes = 0;
  let audioMixSignature = '';

  const COMPOSITOR_STORAGE_KEY = 'localscribe.video.previewCompositor';
  const compositorParam = new URLSearchParams(window.location.search).get('compositor');
  let cachedCompositorPreference: 'css' | 'webgl' | 'webgpu' | null = null;
  let gpuPreview: PreviewCompositor | null = null;
  let gpuPreviewUnavailable = false;
  let webgpuFailed = false;
  let compositorNoticeShown = false;

  // CSS pixel parity is guaranteed by WebGPU. WebGL is retained for export
  // parity and browsers without a WebGPU adapter; its CSS colour tolerance is
  // slightly wider because of browser WebGL canvas compositing.
  function compositorPreference(): 'css' | 'webgl' | 'webgpu' {
    if (cachedCompositorPreference) return cachedCompositorPreference;
    const value = compositorParam ?? localStorage.getItem(COMPOSITOR_STORAGE_KEY);
    cachedCompositorPreference = value === 'auto'
      ? 'webgpu'
      : value === 'webgl' || value === 'webgpu' ? value : 'css';
    return cachedCompositorPreference;
  }

  function showCompositorStatus(message: string): void {
    if (compositorNoticeShown) return;
    compositorNoticeShown = true;
    status.textContent = message;
  }

  let cacheCanvas: HTMLCanvasElement | null = null;
  let cachedFrameSignature = '';
  let cacheCaptureTimer = 0;

  function ensureCacheCanvas(): HTMLCanvasElement {
    if (cacheCanvas) return cacheCanvas;
    cacheCanvas = document.createElement('canvas');
    cacheCanvas.className = 'video-preview-cache-canvas';
    cacheCanvas.setAttribute('aria-hidden', 'true');
    stage.append(cacheCanvas);
    return cacheCanvas;
  }

  function hideCacheFrame(): void {
    cachedFrameSignature = '';
    if (cacheCanvas) cacheCanvas.style.display = 'none';
  }

  function showCacheFrame(signature: string, bitmap: ImageBitmap): void {
    const canvas = ensureCacheCanvas();
    if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
    }
    const context = canvas.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0);
    canvas.style.display = 'block';
    cachedFrameSignature = signature;
    gpuPreview?.canvas.style.setProperty('display', 'none');
  }

  function showCssPreview(): void {
    hideCacheFrame();
    preview.style.visibility = '';
    still.style.visibility = '';
  }

  function scheduleCacheCapture(clip: VideoClip): void {
    window.clearTimeout(cacheCaptureTimer);
    cacheCaptureTimer = window.setTimeout(() => {
      if (playing || activeVideo !== clip) return;
      renderGpuPreview(clip, true);
    }, 180);
  }

  let gpuPreviewRefreshFrame = 0;
  let lastGpuRenderAt = 0;

  /**
   * Live edits (transform sliders, effect sliders, drag handles) update the
   * hidden CSS video first. Coalesce those into one GPU refresh on the next
   * frame so the visible composited preview follows immediately.
   */
  function scheduleGpuPreviewRefresh(): void {
    if (compositorPreference() === 'css' || gpuPreviewRefreshFrame) return;
    gpuPreviewRefreshFrame = requestAnimationFrame(() => {
      gpuPreviewRefreshFrame = 0;
      const found = videoAt(Math.min(time, Math.max(0, totalVideo() - 0.001)));
      renderGpuPreview(found?.clip ?? null);
    });
  }

  function previewFrameCaptured(signature: string, bitmap: ImageBitmap): void {
    if (!previewRenderCache.set(signature, bitmap)) bitmap.close();
  }

  function createWebGlCompositor(): GlPreview | null {
    return createGlPreview(stage, {
      onFallback: (reason: PreviewFallbackReason) => {
        if (reason === 'context-lost') {
          gpuPreviewUnavailable = true;
          hideCacheFrame();
          showCssPreview();
          showCompositorStatus('GPU preview stopped after losing the graphics context. Using the standard preview.');
        }
      },
      onFrameCaptured: previewFrameCaptured,
    });
  }

  function createWebGpuCompositor(): WebGpuPreview | null {
    return createWebGpuPreview(stage, {
      onReady: () => {
        renderGpuPreview(activeVideo);
      },
      onFallback: () => {
        if (gpuPreview?.kind === 'webgpu') gpuPreview.dispose();
        gpuPreview = null;
        webgpuFailed = true;
        const fallback = createWebGlCompositor();
        if (fallback) {
          gpuPreview = fallback;
          showCompositorStatus('WebGPU preview is unavailable here. Using the WebGL preview.');
          renderGpuPreview(activeVideo);
        } else {
          gpuPreviewUnavailable = true;
          hideCacheFrame();
          showCssPreview();
          showCompositorStatus('GPU preview is unavailable in this browser. Using the standard preview.');
        }
      },
      onFrameCaptured: previewFrameCaptured,
    });
  }

  function ensureGpuPreview(): PreviewCompositor | null {
    if (gpuPreview) {
      if (gpuPreview.kind === 'webgpu') return gpuPreview;
      return gpuPreview.active ? gpuPreview : null;
    }
    if (gpuPreviewUnavailable) return null;
    const preference = compositorPreference();
    if (preference === 'css') return null;
    if (preference === 'webgpu' && !webgpuFailed) {
      const gpu = createWebGpuCompositor();
      if (gpu) {
        gpuPreview = gpu;
        return gpu;
      }
      webgpuFailed = true;
    }
    const created = createWebGlCompositor();
    if (!created) {
      gpuPreviewUnavailable = true;
      showCompositorStatus('GPU preview is unavailable in this browser. Using the standard preview.');
      return null;
    }
    gpuPreview = created;
    return created;
  }

  let videos: VideoClip[] = [];
  let audios: AudioClip[] = [];
  let assets: MediaAsset[] = [];
  let nextAssetId = 0;
  let nextId = 0;
  let selected: { kind: 'video' | 'audio'; id: number } | null = null;
  /** Every selected clip, including the primary one in `selected`. */
  let selectedClipKeys = new Set<string>();
  /** Primary key the multi-selection was built around; changed keys reset it. */
  let selectionAnchor = '';
  let time = 0;
  let playing = false;
  let scrubbing = false;
  let loopPlayback = false;
  let previewMuted = false;
  let previewVolume = 100;
  let safeGuides = false;
  let compositionGridOn = false;
  let stageSnapEnabled = true;
  let previewQuality: 'auto' | 'full' | 'proxy' = 'auto';
  let previewZoom = 'fit';
  let previewMaximized = false;
  let clock = { at: 0, time: 0 };
  let activeVideo: VideoClip | null = null;
  let previewTransformValue = '';
  let graphicsPreviewKey = '';
  preview.addEventListener('loadeddata', () => renderGpuPreview(activeVideo));
  preview.addEventListener('seeked', () => renderGpuPreview(activeVideo));
  still.addEventListener('load', () => renderGpuPreview(activeVideo));
  let textPreviewKey = '';
  interface GraphicPreviewEntry {
    el: HTMLElement;
    graphic: GraphicClip;
    lastOpacity: number;
  }
  interface TextPreviewEntry {
    anchor: HTMLElement;
    cue: Cue;
    titleIndex: number;
    lastOpacity: number;
  }
  let graphicsPreviewEntries: GraphicPreviewEntry[] = [];
  let textPreviewEntries: TextPreviewEntry[] = [];
  let stageViewportWidth = 0;
  let stageViewportHeight = 0;
  function measureStageViewport(): void {
    stageViewportWidth = stage.clientWidth;
    stageViewportHeight = stage.clientHeight;
  }
  function previewStageWidth(): number {
    if (!stageViewportWidth) measureStageViewport();
    return stageViewportWidth;
  }
  function previewStageHeight(): number {
    if (!stageViewportHeight) measureStageViewport();
    return stageViewportHeight;
  }
  const transformOverlay = document.createElement('div');
  transformOverlay.className = 'video-transform-overlay hidden';
  transformOverlay.innerHTML =
    '<span class="video-align-guide" data-guide="v"></span>' +
    '<span class="video-align-guide" data-guide="h"></span>' +
    '<div class="video-transform-frame" data-transform-frame>' +
    '<span class="video-transform-handle" data-handle="nw"></span>' +
    '<span class="video-transform-handle" data-handle="ne"></span>' +
    '<span class="video-transform-handle" data-handle="sw"></span>' +
    '<span class="video-transform-handle" data-handle="se"></span>' +
    '<span class="video-transform-handle video-transform-edge" data-handle="n"></span>' +
    '<span class="video-transform-handle video-transform-edge" data-handle="e"></span>' +
    '<span class="video-transform-handle video-transform-edge" data-handle="s"></span>' +
    '<span class="video-transform-handle video-transform-edge" data-handle="w"></span>' +
    '<span class="video-transform-rotate" data-handle="rotate" title="Drag to rotate. Snaps near 0, 90, 180, and 270 degrees.">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 6.3"/><path d="M20 4v7h-7"/></svg>' +
    '</span>' +
    '</div>';
  stageWrap.append(transformOverlay);
  const transformFrame = transformOverlay.querySelector<HTMLElement>('[data-transform-frame]')!;
  const alignGuideV = transformOverlay.querySelector<HTMLElement>('[data-guide="v"]')!;
  const alignGuideH = transformOverlay.querySelector<HTMLElement>('[data-guide="h"]')!;
  const graphicOverlay = document.createElement('div');
  graphicOverlay.className = 'video-transform-overlay video-graphic-overlay hidden';
  graphicOverlay.innerHTML =
    '<span class="video-align-guide" data-graphic-guide="v"></span>' +
    '<span class="video-align-guide" data-graphic-guide="h"></span>' +
    '<div class="video-transform-frame video-graphic-frame" data-graphic-frame>' +
    '<span class="video-transform-handle" data-handle="nw"></span>' +
    '<span class="video-transform-handle" data-handle="ne"></span>' +
    '<span class="video-transform-handle" data-handle="sw"></span>' +
    '<span class="video-transform-handle" data-handle="se"></span>' +
    '<span class="video-transform-handle video-transform-edge" data-handle="n"></span>' +
    '<span class="video-transform-handle video-transform-edge" data-handle="e"></span>' +
    '<span class="video-transform-handle video-transform-edge" data-handle="s"></span>' +
    '<span class="video-transform-handle video-transform-edge" data-handle="w"></span>' +
    '<span class="video-transform-rotate" data-handle="rotate" title="Drag to rotate. Snaps near 0, 90, 180, and 270 degrees.">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 6.3"/><path d="M20 4v7h-7"/></svg>' +
    '</span>' +
    '</div>';
  stageWrap.append(graphicOverlay);
  const graphicFrame = graphicOverlay.querySelector<HTMLElement>('[data-graphic-frame]')!;
  const graphicGuideV = graphicOverlay.querySelector<HTMLElement>('[data-graphic-guide="v"]')!;
  const graphicGuideH = graphicOverlay.querySelector<HTMLElement>('[data-graphic-guide="h"]')!;
  const titleOverlay = document.createElement('div');
  titleOverlay.className = 'video-transform-overlay video-title-overlay hidden';
  titleOverlay.innerHTML =
    '<div class="video-title-anchor" data-title-anchor>' +
    '<div class="video-transform-frame video-title-frame" data-title-frame>' +
    '<span class="video-transform-rotate" data-handle="rotate" title="Drag to rotate. Snaps near 0, 90, 180, and 270 degrees.">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 6.3"/><path d="M20 4v7h-7"/></svg>' +
    '</span>' +
    '</div>' +
    '</div>';
  stageWrap.append(titleOverlay);
  const titleAnchor = titleOverlay.querySelector<HTMLElement>('[data-title-anchor]')!;
  const titleFrame = titleOverlay.querySelector<HTMLElement>('[data-title-frame]')!;
  let frame = 0;
  let operation: AbortController | null = null;
  /** Fit-relative timeline zoom. Detail rendering handles the deep end. */
  const MAX_TIMELINE_ZOOM = 120;
  let zoomLevel = 1;
  let fileCues: Cue[] | null = null;
  let titles: Cue[] = [];
  let selectedTitle = -1;
  let selectedSubtitleKey = '';
  let selectedEmbeddedCue: { clipId: number; index: number } | null = null;
  let installedFontChoices: TextFontOption[] = [];
  let activeFontCategory: TextFontCategory | 'All' = 'All';
  let fontLoadBusy = false;
  let subtitleStyles: Record<string, TextObjectStyle> = {};
  let subtitleTransitions: Record<string, OverlayTransition> = {};
  let showSubtitleTrack = false;
  let captionTrackState = { hidden: false, locked: false };
  let captionPreset: CaptionPreset = 'default';
  let graphics: GraphicClip[] = [];
  const importedSvgs: { name: string; dataUrl: string }[] = [];
  let selectedGraphic = -1;
  let cameraCuts: { at: number; track: number }[] = [];
  let captionFileName = '';
  let captionOffset = 0;
  let history: Snapshot[] = [];
  let historyLabels: string[] = [];
  let historyDetails: string[] = [];
  let historySizes: number[] = [];
  let historyBytesTotal = 0;
  const MAX_HISTORY_BYTES = 32 * 1024 * 1024;
  let historyIndex = -1;
  let restoring = false;
  let recording: { at: number } | null = null;
  let videoTrackCount = 1;
  let audioTrackCount = 1;
  let linkClipsEnabled = true;
  let nextLinkGroup = 1;
  let videoTrackState: { hidden: boolean; muted: boolean; locked?: boolean; solo?: boolean; gain?: number; opacity?: number; color?: string }[] = [{ hidden: false, muted: false, locked: false, solo: false, gain: 1, opacity: 1 }];
  let audioTrackState: { muted: boolean; locked?: boolean; solo?: boolean; gain?: number; color?: string }[] = [{ muted: false, locked: false, solo: false, gain: 1 }];
  let videoTrackHeights: number[] = [];
  let audioTrackHeights: number[] = [];
  type InspectorTab = 'video' | 'audio' | 'effects' | 'file';
  let inspectorTab: InspectorTab = 'video';
  const openVideoSections = new Set<string>(['timing', 'transform']);
  let transcriptEdits: { start: number; end: number }[] = [];
  let silenceThreshold = 0.7;
  let rangeIn: number | null = null;
  let rangeOut: number | null = null;
  let snapEnabled = true;
  let timelinePreviousHeight = 300;
  let mediaQuery = '';
  let clipClipboard:
    | { kind: 'video'; clip: VideoState }
    | { kind: 'audio'; clip: AudioState }
    | { kind: 'title'; cue: Cue }
    | { kind: 'graphic'; graphic: GraphicClip }
    | null = null;
  const toolButtons = new Map<string, HTMLButtonElement>();
  const railButtons = new Map<string, HTMLButtonElement>();
  let exportPlatform: 'source' | 'youtube' | 'tiktok' | 'square' | 'twitter' = 'source';
  let currentProjectId = '';
  let autosaveTimer = 0;
  function scheduleAutosave(): void {
    if (!currentProjectId) return;
    window.clearTimeout(autosaveTimer);
    autosaveTimer = window.setTimeout(() => {
      autosaveTimer = 0;
      if (operation || recording) return;
      if (!videos.length && !audios.length && !assets.length && !titles.length && !graphics.length) return;
      void saveCurrentProject();
    }, 3000);
  }
  let currentProjectCreatedAt = 0;
  let savedFingerprint = '';
  let fingerprintCache: string | null = null;
  let projectSaving = false;
  let projectSummaries: VideoProjectSummary[] = [];
  let reopenProjectId = '';

  function selectedVideoClip(): VideoClip | null {
    syncClipSelection();
    for (const key of selectedClipKeys) {
      const selection = clipSelectionFromKey(key);
      if (selection?.kind !== 'video') continue;
      const clip = videos.find((entry) => entry.id === selection.id);
      if (clip) return clip;
    }
    return null;
  }

  function selectedAudioClip(): AudioClip | null {
    syncClipSelection();
    for (const key of selectedClipKeys) {
      const selection = clipSelectionFromKey(key);
      if (selection?.kind !== 'audio') continue;
      const clip = audios.find((entry) => entry.id === selection.id);
      if (clip) return clip;
    }
    return null;
  }

  type ClipSelection = { kind: 'video' | 'audio'; id: number };
  type SelectedClipMember =
    | { kind: 'video'; clip: VideoClip }
    | { kind: 'audio'; clip: AudioClip };

  function clipSelectionKey(selection: ClipSelection): string {
    return `${selection.kind}:${selection.id}`;
  }

  function clipSelectionFromKey(key: string): ClipSelection | null {
    const [kind, rawId] = key.split(':');
    const id = Number(rawId);
    if ((kind === 'video' || kind === 'audio') && Number.isFinite(id)) return { kind, id };
    return null;
  }

  function linkedSelectionFor(selection: ClipSelection): ClipSelection | null {
    if (selection.kind === 'video') {
      const video = videos.find((clip) => clip.id === selection.id);
      if (!video?.linkGroup) return null;
      const audio = audios.find((clip) => clip.linkGroup === video.linkGroup);
      return audio ? { kind: 'audio', id: audio.id } : null;
    }
    const audio = audios.find((clip) => clip.id === selection.id);
    if (!audio?.linkGroup) return null;
    const video = videos.find((clip) => clip.linkGroup === audio.linkGroup);
    return video ? { kind: 'video', id: video.id } : null;
  }

  /** Selecting either half of a linked audio/video pair selects both. */
  function expandLinkedSelection(keys: Set<string>): Set<string> {
    if (!linkClipsEnabled) return keys;
    for (const key of [...keys]) {
      const selection = clipSelectionFromKey(key);
      const linked = selection ? linkedSelectionFor(selection) : null;
      if (linked) keys.add(clipSelectionKey(linked));
    }
    return keys;
  }

  /**
   * Keep the multi-selection aligned with `selected`. Older code paths assign
   * `selected` directly, so a changed primary resets the group at render time.
   */
  function syncClipSelection(): void {
    const key = selected ? clipSelectionKey(selected) : '';
    if (key !== selectionAnchor) {
      selectionAnchor = key;
      selectedClipKeys = new Set(key ? [key] : []);
    }
    if (selected) expandLinkedSelection(selectedClipKeys);
  }

  function isClipSelected(kind: 'video' | 'audio', id: number): boolean {
    return selectedClipKeys.has(`${kind}:${id}`) || (selected?.kind === kind && selected.id === id);
  }

  function setClipSelection(kind: 'video' | 'audio', id: number): void {
    const key = `${kind}:${id}`;
    selectedClipKeys = expandLinkedSelection(new Set([key]));
    selected = { kind, id };
    selectionAnchor = key;
  }

  function toggleClipSelection(kind: 'video' | 'audio', id: number): void {
    syncClipSelection();
    const key = `${kind}:${id}`;
    const pair = [...expandLinkedSelection(new Set([key]))];
    const active = pair.some((entry) => selectedClipKeys.has(entry));
    if (active) {
      for (const entry of pair) selectedClipKeys.delete(entry);
      if (!selected || pair.includes(clipSelectionKey(selected))) {
        const next = [...selectedClipKeys].at(-1);
        selected = next ? clipSelectionFromKey(next) : null;
      }
    } else {
      for (const entry of pair) selectedClipKeys.add(entry);
      selected = { kind, id };
    }
    selectionAnchor = selected ? clipSelectionKey(selected) : '';
  }

  function clearClipSelection(): void {
    selected = null;
    selectedClipKeys = new Set();
    selectionAnchor = '';
  }

  function selectedClipMembers(): SelectedClipMember[] {
    syncClipSelection();
    const members: SelectedClipMember[] = [];
    for (const key of selectedClipKeys) {
      const selection = clipSelectionFromKey(key);
      if (!selection) continue;
      if (selection.kind === 'video') {
        const clip = videos.find((entry) => entry.id === selection.id);
        if (clip) members.push({ kind: 'video', clip });
      } else {
        const clip = audios.find((entry) => entry.id === selection.id);
        if (clip) members.push({ kind: 'audio', clip });
      }
    }
    return members;
  }

  function selectedClipCount(): number {
    syncClipSelection();
    return selectedClipKeys.size;
  }

  function announceClipSelection(): void {
    const count = selectedClipCount();
    if (count > 1) {
      status.textContent = `${count} clips selected. Drag any selected clip to move them together.`;
    } else if (status.textContent?.includes('clips selected. Drag any selected clip')) {
      // Only clear our own hint, not edit/export feedback.
      status.textContent = '';
    }
  }

  interface ClipMove {
    kind: 'video' | 'audio';
    video: VideoClip | null;
    audio: AudioClip | null;
    start: number;
  }

  function groupMovePlan(): ClipMove[] {
    const plan: ClipMove[] = [];
    for (const member of selectedClipMembers()) {
      if (member.kind === 'video') {
        if (videoClipLocked(member.clip)) continue;
        plan.push({ kind: 'video', video: member.clip, audio: null, start: member.clip.start });
      } else {
        if (audioClipLocked(member.clip)) continue;
        plan.push({ kind: 'audio', video: null, audio: member.clip, start: member.clip.offset });
      }
    }
    return plan;
  }

  /** Shift every selected clip by one delta, then catch up unselected linked partners. */
  function applyGroupMove(plan: ClipMove[], delta: number): void {
    for (const move of plan) {
      if (move.video) move.video.start = Math.max(0, move.start + delta);
      else if (move.audio) move.audio.offset = Math.max(0, move.start + delta);
    }
    if (!linkClipsEnabled) return;
    const touched = new Set(plan.map((move) => move.video
      ? clipSelectionKey({ kind: 'video', id: move.video.id })
      : clipSelectionKey({ kind: 'audio', id: move.audio!.id })));
    for (const move of plan) {
      if (move.video) {
        const audio = linkedAudioFor(move.video);
        if (audio && !touched.has(clipSelectionKey({ kind: 'audio', id: audio.id }))) {
          syncLinkedAudioFromVideo(move.video);
        }
      } else if (move.audio) {
        const video = linkedVideoFor(move.audio);
        if (video && !touched.has(clipSelectionKey({ kind: 'video', id: video.id }))) {
          syncLinkedVideoFromAudio(move.audio);
        }
      }
    }
  }

  function snappedGroupDelta(
    plan: ClipMove[],
    primaryStart: number,
    primaryLength: number,
    rawDelta: number,
    excludeAudio?: AudioClip,
    excludeVideo?: VideoClip,
  ): number {
    const minStart = plan.reduce((min, move) => Math.min(min, move.start), Infinity);
    let delta = Math.max(rawDelta, -minStart);
    if (!snapEnabled) return delta;
    const start = Math.max(0, primaryStart + delta);
    const startSnap = snapValue(start, excludeAudio, excludeVideo);
    const endSnap = snapValue(start + primaryLength, excludeAudio, excludeVideo);
    if (startSnap.at !== null) {
      delta = Math.max(-minStart, startSnap.value - primaryStart);
      showSnap(startSnap.at);
    } else if (endSnap.at !== null) {
      delta = Math.max(-minStart, endSnap.value - primaryLength - primaryStart);
      showSnap(endSnap.at);
    } else {
      showSnap(null);
    }
    return delta;
  }

  function inspectorSelectionKind(): 'video' | 'audio' | 'title' | 'shape' | 'subtitle' | null {
    if (selectedVideoClip()) return 'video';
    if (selectedAudioClip()) return 'audio';
    if (selectedTitle >= 0 && titles[selectedTitle]) return 'title';
    if (selectedGraphic >= 0 && graphics[selectedGraphic]) return 'shape';
    if (selectedSubtitleKey) return 'subtitle';
    return null;
  }

  function videoHasOwnSound(clip: VideoClip): boolean {
    return !clip.image && clip.probe.hasAudio;
  }

  function allowedInspectorTabs(): InspectorTab[] {
    const kind = inspectorSelectionKind();
    if (kind === 'title' || kind === 'shape' || kind === 'subtitle') return ['video'];
    if (kind === 'video') {
      const clip = selectedVideoClip()!;
      const tabs: InspectorTab[] = ['video'];
      if (selectedAudioClip() || videoHasOwnSound(clip)) tabs.push('audio');
      tabs.push('effects', 'file');
      return tabs;
    }
    if (kind === 'audio') return ['audio', 'file'];
    return [];
  }

  function defaultInspectorTab(allowed = allowedInspectorTabs()): InspectorTab {
    if (allowed.includes('video')) return 'video';
    if (allowed.includes('audio')) return 'audio';
    return 'video';
  }

  function applyInspectorPanel(): void {
    const kind = inspectorSelectionKind();
    const panel = inspectorTab === 'video' && (kind === 'title' || kind === 'subtitle')
      ? 'text'
      : inspectorTab === 'video' && kind === 'shape'
        ? 'graphics'
        : 'clip';
    for (const entry of sidePanels) {
      entry.classList.toggle('hidden', entry.dataset.videoPanel !== panel);
    }
  }

  function syncInspectorTabs(): void {
    const allowed = allowedInspectorTabs();
    const hasSelection = allowed.length > 0;
    for (const tab of sideTabs) {
      const name = tab.dataset.videoSide as InspectorTab;
      const active = hasSelection && name === inspectorTab;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
      (tab as HTMLButtonElement).disabled = !allowed.includes(name);
    }
  }

  function renderInspectorPanel(): void {
    syncClipAnimation();
    const allowed = allowedInspectorTabs();
    if (!allowed.length) {
      inspectorTab = 'video';
    } else if (!allowed.includes(inspectorTab)) {
      inspectorTab = defaultInspectorTab(allowed);
    }
    applyInspectorPanel();
    const kind = inspectorSelectionKind();
    if (inspectorTab === 'video' && (kind === 'title' || kind === 'subtitle')) renderTitlePanel();
    else if (inspectorTab === 'video' && kind === 'shape') renderGraphicsPanel();
    else renderClipInspector();
    syncInspectorTabs();
    updateToolRail();
    updateTransformOverlay();
  }

  /** Backwards-compatible entry point: always render the whole context-aware inspector. */
  function renderInspector(): void {
    renderInspectorPanel();
  }

  function selectSideTab(name: string): void {
    if (name === 'keys') {
      showClipAnimation(true);
      return;
    }
    let requested: InspectorTab | null = null;
    let force = false;
    if (name === 'multicam' || name === 'transcript') {
      openVideoSections.add(name);
      requested = 'video';
      force = true;
    } else if (name === 'text' || name === 'graphics') {
      requested = 'video';
      force = true;
    } else if (name === 'clip') {
      requested = null;
    } else if (name === 'video' || name === 'audio' || name === 'effects' || name === 'file') {
      requested = name;
      force = true;
    }
    const allowed = allowedInspectorTabs();
    if (!allowed.length) {
      inspectorTab = requested ?? 'video';
    } else if (requested && allowed.includes(requested)) {
      inspectorTab = requested;
    } else if (!force && allowed.includes(inspectorTab)) {
      // Keep the current tab when it still applies to the new selection.
    } else {
      inspectorTab = defaultInspectorTab(allowed);
    }
    renderInspectorPanel();
    updateTransformOverlay();
    if (name === 'multicam' || name === 'transcript') {
      revealInspectorSection(name);
    }
  }

  for (const tab of sideTabs) {
    tab.addEventListener('click', () => selectSideTab(tab.dataset.videoSide ?? 'video'));
  }
  modeManual.addEventListener('click', () => activateManualMode());
  modeAi.addEventListener('click', () => openLibraryPanel('ai'));
  selectSideTab('clip');

  const LIBRARY_META: Record<string, { kicker: string; title: string }> = {
    media: { kicker: 'Library', title: 'Media pool' },
    text: { kicker: 'Generate', title: 'Titles' },
    graphics: { kicker: 'Generate', title: 'Graphics' },
    effects: { kicker: 'Apply', title: 'Effects' },
    transitions: { kicker: 'Apply', title: 'Transitions' },
    captions: { kicker: 'Project', title: 'Captions' },
    audio: { kicker: 'Mix', title: 'Track mixer' },
    ai: { kicker: 'Assistant', title: 'AI editor' },
  };
  const LAYOUT_KEY = 'localscribe.video.layout';
  let poolWidth = 180;
  let inspectorWidth = 340;
  let timelineHeight = 300;
  let inspectorCollapsed = false;
  let libraryCollapsed = false;
  let activeLibrary = 'media';
  let effectFilter: VideoEffectFilter = 'all';
  let effectsPreviewImage = '';
  try {
    const saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? 'null') as {
      pool?: number; inspector?: number; timeline?: number; collapsed?: boolean; libraryCollapsed?: boolean;
      library?: string; compactTracks?: boolean; linkClips?: boolean;
      videoTrackHeights?: number[]; audioTrackHeights?: number[];
    } | null;
    if (saved?.pool) poolWidth = Math.max(120, Math.min(620, saved.pool));
    if (saved?.inspector) inspectorWidth = Math.max(280, Math.min(560, saved.inspector));
    if (saved?.timeline) timelineHeight = Math.max(150, Math.min(900, saved.timeline));
    if (saved?.collapsed) inspectorCollapsed = true;
    if (saved?.libraryCollapsed) libraryCollapsed = true;
    if (saved?.library && saved.library in LIBRARY_META) activeLibrary = saved.library;
    if (saved?.compactTracks) compactTracks = true;
    if (saved?.linkClips === false) linkClipsEnabled = false;
    const validHeights = (values: unknown, min: number): number[] => Array.isArray(values)
      ? values
        .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
        .map((value) => Math.max(min, Math.min(240, Math.round(value))))
      : [];
    if (saved?.videoTrackHeights) videoTrackHeights = validHeights(saved.videoTrackHeights, 48);
    if (saved?.audioTrackHeights) audioTrackHeights = validHeights(saved.audioTrackHeights, 40);
  } catch {
    // Storage is optional.
  }
  const applyLibraryState = (): void => {
    editor.classList.toggle('library-collapsed', libraryCollapsed);
    libraryCollapse.setAttribute('aria-expanded', String(!libraryCollapsed));
    libraryRail.classList.toggle('hidden', !libraryCollapsed);
    libraryRail.setAttribute('aria-expanded', String(!libraryCollapsed));
    for (const panel of libraryPanels) {
      panel.classList.toggle('hidden', panel.dataset.videoLibraryPanel !== activeLibrary);
    }
    const meta = LIBRARY_META[activeLibrary] ?? LIBRARY_META.media;
    libraryTitle.textContent = meta.title;
    libraryKicker.textContent = meta.kicker;
    const aiActive = !libraryCollapsed && activeLibrary === 'ai';
    modeManual.classList.toggle('active', !aiActive);
    modeManual.setAttribute('aria-selected', String(!aiActive));
    modeAi.classList.toggle('active', aiActive);
    modeAi.setAttribute('aria-selected', String(aiActive));
    updateToolRail();
  };
  const applyLayout = (): void => {
    editor.style.setProperty('--video-pool-width', `${poolWidth}px`);
    editor.style.setProperty('--video-inspector-width', `${inspectorWidth}px`);
    editor.classList.toggle('pool-two-columns', poolWidth >= 520);
    root.style.setProperty('--video-timeline-height', `${timelineHeight}px`);
    editor.classList.toggle('inspector-collapsed', inspectorCollapsed);
    inspectorRail.setAttribute('aria-expanded', String(!inspectorCollapsed));
    applyLibraryState();
    updateTimelineTools();
  };
  const saveLayout = (): void => {
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify({
        pool: poolWidth,
        inspector: inspectorWidth,
        timeline: timelineHeight,
        collapsed: inspectorCollapsed,
        libraryCollapsed,
        library: activeLibrary,
        compactTracks,
        linkClips: linkClipsEnabled,
        videoTrackHeights,
        audioTrackHeights,
      }));
    } catch {
      // Storage is optional.
    }
  };
  const setInspectorCollapsed = (collapsed: boolean): void => {
    inspectorCollapsed = collapsed;
    if (!collapsed) poolWidth = Math.min(poolWidth, maxPoolWidth());
    applyLayout();
    saveLayout();
    if (collapsed) inspectorRail.focus({ preventScroll: true });
    else inspectorClose.focus({ preventScroll: true });
  };
  const ensureInspectorOpen = (): void => {
    if (!inspectorCollapsed) return;
    inspectorCollapsed = false;
    applyLayout();
    saveLayout();
  };
  function openLibraryPanel(name: string): void {
    if (!(name in LIBRARY_META)) return;
    activeLibrary = name;
    const wasCollapsed = libraryCollapsed;
    libraryCollapsed = false;
    if (name !== 'media') poolWidth = Math.max(poolWidth, Math.min(260, maxPoolWidth()));
    applyLayout();
    saveLayout();
    if (name === 'audio') renderMixer();
    if (name === 'text') drawTitlePresetThumbnails();
    if (name === 'effects') {
      effectsPreviewImage = captureEffectPreview();
      renderEffectsPanel();
    }
    if (wasCollapsed) libraryCollapse.focus({ preventScroll: true });
  }
  function setLibraryCollapsed(collapsed: boolean): void {
    libraryCollapsed = collapsed;
    applyLayout();
    saveLayout();
    if (collapsed) libraryRail.focus({ preventScroll: true });
    else libraryCollapse.focus({ preventScroll: true });
  }
  function activateManualMode(): void {
    if (activeLibrary === 'ai') activeLibrary = 'media';
    ensureInspectorOpen();
    applyLayout();
    saveLayout();
    selectSideTab('clip');
  }
  inspectorClose.addEventListener('click', () => setInspectorCollapsed(true));
  inspectorRail.addEventListener('click', () => setInspectorCollapsed(false));
  libraryCollapse.addEventListener('click', () => setLibraryCollapsed(true));
  libraryRail.addEventListener('click', () => setLibraryCollapsed(false));
  const maxPoolWidth = () => Math.max(120, Math.min(620, editor.clientWidth - (inspectorCollapsed ? 0 : inspectorWidth) - 220));
  const maxInspectorWidth = () => Math.max(280, Math.min(560, editor.clientWidth - poolWidth - 424));
  const maxTimelineHeight = () => Math.max(
    180,
    Math.min(editor.clientHeight - 220, editor.clientHeight * 0.55),
  );
  if (activeLibrary !== 'media' && !libraryCollapsed) {
    poolWidth = Math.max(poolWidth, Math.min(260, maxPoolWidth()));
  }
  applyLayout();

  for (const handle of root.querySelectorAll<HTMLElement>('[data-video-resize]')) {
    const kind = handle.dataset.videoResize;
    const resize = (delta: number): void => {
      if (kind === 'timeline') {
        timelineHeight = Math.max(150, Math.min(maxTimelineHeight(), timelineHeight + delta));
      } else if (kind === 'pool') {
        poolWidth = Math.max(120, Math.min(maxPoolWidth(), poolWidth + delta));
      } else {
        inspectorWidth = Math.max(280, Math.min(maxInspectorWidth(), inspectorWidth - delta));
        poolWidth = Math.min(poolWidth, maxPoolWidth());
      }
      applyLayout();
    };
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || !window.matchMedia('(min-width: 1000px)').matches) return;
      event.preventDefault();
      event.stopPropagation();
      try { handle.setPointerCapture(event.pointerId); } catch { /* synthetic or already released */ }
      handle.classList.add('dragging');
      const startX = event.clientX;
      const startY = event.clientY;
      const startPool = poolWidth;
      const startInspector = inspectorWidth;
      const startTimeline = timelineHeight;
      const move = (moveEvent: PointerEvent) => {
        if (kind === 'timeline') {
          timelineHeight = Math.max(150, Math.min(maxTimelineHeight(), startTimeline + (startY - moveEvent.clientY)));
        } else {
          const delta = moveEvent.clientX - startX;
          if (kind === 'pool') {
            poolWidth = Math.max(120, Math.min(maxPoolWidth(), startPool + delta));
          } else {
            inspectorWidth = Math.max(280, Math.min(maxInspectorWidth(), startInspector - delta));
            poolWidth = Math.min(poolWidth, maxPoolWidth());
          }
        }
        applyLayout();
      };
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        handle.classList.remove('dragging');
        saveLayout();
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });
    handle.addEventListener('keydown', (event) => {
      const vertical = kind === 'timeline';
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' ||
        (vertical && (event.key === 'ArrowUp' || event.key === 'ArrowDown'))) {
        event.preventDefault();
        if (vertical) {
          const direction = event.key === 'ArrowUp' ? 1 : -1;
          resize(direction * (event.shiftKey ? 60 : 20));
        } else {
          resize((event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 40 : 12));
        }
        saveLayout();
      } else if (event.key === 'Home') {
        event.preventDefault();
        if (kind === 'pool') poolWidth = 180;
        else if (kind === 'inspector') inspectorWidth = 340;
        else timelineHeight = 300;
        applyLayout();
        saveLayout();
      }
    });
    handle.addEventListener('dblclick', () => {
      if (kind === 'pool') poolWidth = 180;
      else if (kind === 'inspector') inspectorWidth = 340;
      else timelineHeight = 300;
      applyLayout();
      saveLayout();
    });
  }
  window.addEventListener('resize', () => {
    if (editor.clientWidth < 900) return;
    const poolCap = maxPoolWidth();
    const inspectorCap = maxInspectorWidth();
    if (poolCap > 140) poolWidth = Math.min(poolWidth, poolCap);
    if (inspectorCap > 280) inspectorWidth = Math.min(inspectorWidth, inspectorCap);
    applyLayout();
  });

  let totalsCache: { video: number; audio: number } | null = null;
  let audioRowsCache: Map<number, number> | null = null;
  let projectFpsCache: number | null = null;
  let projectFpsOverride: number | null = null;
  const PROJECT_FPS_PRESETS = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 120] as const;
  const normalizeProjectFps = (value: unknown): number | null => {
    const fps = Number(value);
    if (!Number.isFinite(fps) || fps < 1 || fps > 240) return null;
    return Math.round(fps * 1000) / 1000;
  };
  let updateFrame = 0;
  function scheduleUpdate(): void {
    if (updateFrame) return;
    updateFrame = requestAnimationFrame(() => {
      updateFrame = 0;
      update();
    });
  }
  function invalidateTimelineDerived(): void {
    if (captionSource.value === 'embedded') invalidateShiftedCues();
    totalsCache = null;
    audioRowsCache = null;
    projectFpsCache = null;
  }
  const totals = () => {
    if (!totalsCache) {
      totalsCache = {
        video: Math.max(0, ...videos.map((clip) => clip.start + videoClipLength(clip))),
        audio: Math.max(0, ...audios.map((clip) => clip.offset + audioClipLength(clip))),
      };
    }
    return totalsCache;
  };
  const totalVideo = () => totals().video;
  const totalAudio = () => totals().audio;
  // Video projects end with the picture; an audio-only timeline ends with its sound.
  const playbackEnd = () => (videos.length ? totalVideo() : totalAudio());
  const videoStart = (clip: VideoClip) => clip.start;
  const contentEnd = () => Math.max(
    totalVideo(),
    totalAudio(),
    ...titles.map((cue) => cue.end),
    ...graphics.map((graphic) => graphic.end),
    6,
  );
  // The seconds represented by one viewport width. It only changes on Fit,
  // project load, or the first import, so moving and trimming clips never
  // rescales the timeline under the pointer.
  let fitSeconds = contentEnd() * 1.1 + 2;
  const fitTimeline = (): void => {
    invalidateTimelineDerived();
    fitSeconds = contentEnd() * 1.1 + 2;
  };
  const timelineLength = () => Math.max(fitSeconds, contentEnd() + 2);
  let timelineViewportWidth = 0;
  const measureTimelineViewport = (): number => {
    timelineViewportWidth = Math.max(320, scroll.clientWidth);
    return timelineViewportWidth;
  };
  const pps = () => ((timelineViewportWidth || measureTimelineViewport()) / Math.max(0.1, fitSeconds)) * zoomLevel;
  interface TimelineWindow {
    start: number;
    end: number;
    left: number;
  }
  function timelineWindow(scale: number): TimelineWindow {
    const width = Math.max(1, timelineViewportWidth || measureTimelineViewport());
    const left = scroll.scrollLeft;
    return {
      start: Math.max(0, (left - width * 1.5) / scale),
      end: (left + width * 2.5) / scale,
      left,
    };
  }
  const inTimelineWindow = (start: number, end: number, range: TimelineWindow, pinned = false): boolean =>
    pinned || (end >= range.start && start <= range.end);
  /** End of the overlays, which can extend past the picture. */
  const overlayEnd = () => Math.max(0, ...titles.map((cue) => cue.end), ...graphics.map((graphic) => graphic.end));
  /** End of the playable preview, including title and shape-only timelines. */
  const previewEnd = () => Math.max(playbackEnd(), overlayEnd());
  /**
   * Scrubbing range. A media project stops at its last clip or overlay; an
   * overlay-only or empty timeline uses the full visible timeline so the
   * playhead can still be moved before any media is added.
   */
  const timelineEnd = () => videos.length > 0 || audios.length > 0 ? previewEnd() : timelineLength();

  const snapLine = document.createElement('div');
  snapLine.className = 'vt-snap hidden';
  content.append(snapLine);
  const marquee = document.createElement('div');
  marquee.className = 'vt-marquee hidden';
  content.append(marquee);

  function embeddedSubtitleClips(): VideoClip[] {
    const visible = videos.filter((clip) => !videoTrackHidden(clip.track));
    if (!visible.some((clip) => clip.embeddedCaptions)) return [];
    return cameraCuts.length || hasVideoOverlap(visible) ? flattenVideoTracks(visible) : visible;
  }

  let assSegmentsCache: AssSegment[] | null = null;
  function styledAssSegments(): AssSegment[] {
    if (captionTrackState.hidden || captionPreset !== 'default' || captionSource.value !== 'embedded') return [];
    assSegmentsCache ??= embeddedSubtitleClips().flatMap((clip) => {
      const captions = clip.embeddedCaptions;
      const script = captions?.assScript;
      if (!captions || !script) return [];
      return clipSpeedSpans(clip).map((span) => ({
        script, cues: captions.cues, file: clip.file,
        start: clip.start + captionOffset + span.start, end: clip.start + captionOffset + span.end,
        sourceStart: span.sourceStart, speed: span.rate,
      }));
    });
    return assSegmentsCache;
  }

  function cues(): Cue[] {
    if (captionSource.value === 'transcript') return editedTranscriptCues();
    if (captionSource.value === 'file') return fileCues ?? [];
    if (captionSource.value === 'embedded') {
      return embeddedSubtitleClips().flatMap(mapEmbeddedCaptions).sort((a, b) => a.start - b.start);
    }
    return [];
  }

  // Transcript-driven editing ------------------------------------------------
  interface TranscriptWord {
    text: string;
    start: number;
    end: number;
    originalStart: number;
    originalEnd: number;
    removed: boolean;
  }

  interface TranscriptRow {
    start: number;
    end: number;
    text: string;
    words: TranscriptWord[];
  }

  function mergeTranscriptEdits(): void {
    transcriptEdits.sort((a, b) => a.start - b.start);
    const merged: { start: number; end: number }[] = [];
    for (const edit of transcriptEdits) {
      const last = merged[merged.length - 1];
      if (last && edit.start <= last.end + 0.02) last.end = Math.max(last.end, edit.end);
      else merged.push({ ...edit });
    }
    transcriptEdits = merged;
  }

  function removedBefore(at: number): number {
    let removed = 0;
    for (const edit of transcriptEdits) {
      if (edit.start >= at) break;
      removed += Math.max(0, Math.min(at, edit.end) - edit.start);
    }
    return removed;
  }

  function mapOriginalTime(at: number): number {
    return Math.max(0, at - removedBefore(at));
  }

  function wordsOfCue(cue: Cue): TranscriptWord[] {
    const tokens = cue.text.split(/\s+/).filter(Boolean);
    if (!tokens.length) return [];
    const weights = tokens.map((token) => Math.max(1, token.replace(/[^\p{L}\p{N}]/gu, '').length));
    const totalWeight = weights.reduce((sum, value) => sum + value, 0);
    const duration = Math.max(0.05, cue.end - cue.start);
    let cursor = cue.start;
    return tokens.map((text, index) => {
      const start = cursor;
      const end = index === tokens.length - 1
        ? cue.end
        : start + (duration * weights[index]) / totalWeight;
      cursor = end;
      return { text, start, end, originalStart: start, originalEnd: end, removed: false };
    });
  }

  function transcriptRows(): TranscriptRow[] {
    const source = options.getTranscriptCues() ?? [];
    return source.map((cue) => {
      const words = wordsOfCue(cue).map((word) => {
        const middle = (word.start + word.end) / 2;
        const removed = transcriptEdits.some((edit) => middle >= edit.start && middle < edit.end);
        return {
          ...word,
          start: mapOriginalTime(word.start),
          end: mapOriginalTime(word.end),
          removed,
        };
      });
      const visible = words.filter((word) => !word.removed);
      return {
        start: mapOriginalTime(cue.start),
        end: mapOriginalTime(cue.end),
        text: visible.map((word) => word.text).join(' '),
        words,
      };
    }).filter((row) => row.words.some((word) => !word.removed));
  }

  function editedTranscriptCues(): Cue[] {
    if (!transcriptEdits.length) return options.getTranscriptCues() ?? [];
    const cues: Cue[] = [];
    for (const row of transcriptRows()) {
      if (!row.text) continue;
      const words = row.words.filter((word) => !word.removed);
      cues.push({
        start: words[0].start,
        end: words[words.length - 1].end,
        text: row.text,
      });
    }
    return cues;
  }

  function deleteTranscriptSpan(start: number, end: number): void {
    if (!(end - start > 0.02)) return;
    const currentStart = mapOriginalTime(start);
    const currentEnd = mapOriginalTime(end);
    if (!(currentEnd - currentStart > 0.02)) return;
    transcriptEdits.push({ start, end });
    mergeTranscriptEdits();
    cutSpan(currentStart, currentEnd, true);
    render();
    seek(Math.min(time, timelineEnd()));
    commit();
    status.textContent = `Removed ${formatClock(end - start, true)} and closed the gap.`;
  }

  function removeTranscriptSilences(threshold: number): void {
    const source = options.getTranscriptCues() ?? [];
    if (!source.length) {
      status.textContent = 'Transcribe a clip first, or load an SRT/VTT file.';
      return;
    }
    const spans: { start: number; end: number }[] = [];
    const minGap = Math.max(0.25, threshold);
    let cursor = 0;
    for (const cue of source) {
      if (cue.start - cursor >= minGap) spans.push({ start: cursor, end: cue.start });
      cursor = Math.max(cursor, cue.end);
    }
    const videoEnd = totalVideo();
    if (videoEnd - cursor >= minGap) spans.push({ start: cursor, end: videoEnd });
    if (!spans.length) {
      status.textContent = `No silence longer than ${minGap.toFixed(2)} s.`;
      return;
    }
    // Descending order keeps earlier original times valid while cutting.
    let removed = 0;
    for (const span of spans.sort((a, b) => b.start - a.start)) {
      const start = mapOriginalTime(span.start);
      const end = mapOriginalTime(span.end);
      if (!(end - start > 0.02)) continue;
      transcriptEdits.push({ start: span.start, end: span.end });
      mergeTranscriptEdits();
      cutSpan(start, end, true);
      removed += end - start;
    }
    render();
    seek(Math.min(time, timelineEnd()));
    commit();
    status.textContent = `Removed ${spans.length} silence${spans.length === 1 ? '' : 's'} (${formatClock(removed, true)}).`;
  }

  let shiftedCuesCache: Cue[] | null = null;
  let shiftedCuesAt = 0;
  let overlayCuesCache: Cue[] | null = null;
  function shiftedCues(): Cue[] {
    const now = performance.now();
    if (shiftedCuesCache && now - shiftedCuesAt < 100) return shiftedCuesCache;
    shiftedCuesCache = shiftCues(cues(), captionOffset);
    shiftedCuesAt = now;
    return shiftedCuesCache;
  }
  function overlayCues(): Cue[] {
    if (overlayCuesCache) return overlayCuesCache;
    const captions = captionTrackState.hidden ? [] : shiftedCues();
    overlayCuesCache = titles.length
      ? [...captions, ...titles].sort((a, b) => a.start - b.start)
      : captions;
    return overlayCuesCache;
  }

  function invalidateShiftedCues(): void {
    shiftedCuesCache = null;
    overlayCuesCache = null;
    assSegmentsCache = null;
  }
  function captionStyle(): CaptionStyle {
    const scale = captionSize.value === 'small' ? 0.8 : captionSize.value === 'large' ? 1.25 : 1;
    return { scale, position: captionPosition.value === 'top' ? 'top' : 'bottom' };
  }

  function subtitleBaseStyle(): TextObjectStyle {
    return presetCaptionStyle(captionPreset, captionStyle());
  }

  const subtitleStyleKey = (text: string): string => text.trim();
  function ensureTitleStyle(cue: Cue): TextObjectStyle {
    cue.style = normalizeTextStyle(cue.style, defaultTitleTextStyle());
    return cue.style;
  }
  function ensureSubtitleStyle(text: string): TextObjectStyle {
    const key = subtitleStyleKey(text);
    return subtitleStyles[key] ?? subtitleBaseStyle();
  }
  function styledOverlayCues(): Cue[] {
    const subtitleBase = subtitleBaseStyle();
    return overlayCues().filter((cue) =>
      !titles.includes(cue) || !videoTrackHidden(titleTrackIndex(cue)),
    ).map((cue) => {
      if (titles.includes(cue)) {
        ensureTitleStyle(cue);
        return cue;
      }
      const key = subtitleStyleKey(cue.text);
      return {
        ...cue,
        style: subtitleStyles[key] ?? subtitleBase,
        transition: subtitleTransitions[key] ?? cue.transition,
      };
    });
  }

  // Local projects ----------------------------------------------------------
  const LAST_PROJECT_KEY = 'localscribe.video.project.last';
  const makeProjectId = (): string => {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
    return `project-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  };
  const sourceFpsOfProject = (): number => {
    const first = videos.find((clip) => !clip.image);
    const fps = first?.probe.fps ?? 0;
    return fps > 0 && fps <= 240 ? Math.round(fps * 1000) / 1000 : 30;
  };
  const fpsOfProject = (): number => {
    if (projectFpsOverride !== null) return projectFpsOverride;
    projectFpsCache ??= sourceFpsOfProject();
    return projectFpsCache;
  };
  const fpsLabel = (fps: number): string =>
    `${Number.isInteger(fps) ? fps : Number(fps.toFixed(3))} fps`;
  const locale = (): string | undefined => document.documentElement.lang || undefined;
  const savedWhen = (at: number): string => {
    const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000));
    const relative = new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' });
    if (minutes < 1) return relative.format(0, 'second');
    if (minutes < 60) return relative.format(-minutes, 'minute');
    const hours = Math.round(minutes / 60);
    if (hours < 24) return relative.format(-hours, 'hour');
    return new Date(at).toLocaleDateString(locale(), { month: 'short', day: 'numeric' });
  };

  function projectSettings(): ProjectSettings {
    return {
      format: format.value,
      preset: preset.value,
      customWidth,
      customHeight,
      fps: projectFpsOverride ?? undefined,
      targetSize: targetSizeInput.value,
      exactCuts: exactCuts.checked,
      normalize: normalize.value,
      keepOriginal: keepOriginal.checked,
      originalVolume: originalVolume.value,
      duck: duck.checked,
      duckCaptions: duckCaptions.checked,
      captionPosition: captionPosition.value,
      captionSize: captionSize.value,
      subtitleStyles,
      subtitleTransitions,
    };
  }

  function applyProjectSettings(settings: ProjectSettings): void {
    if (settings.format && settings.format in MERGE_FORMATS) format.value = settings.format;
    if (settings.preset && settings.preset in MERGE_PRESETS) preset.value = settings.preset;
    customWidth = Number(settings.customWidth) || 0;
    customHeight = Number(settings.customHeight) || 0;
    projectFpsOverride = normalizeProjectFps(settings.fps);
    projectFpsCache = null;
    if (document.activeElement !== projectSettingsCustomWidth) projectSettingsCustomWidth.value = customWidth ? String(customWidth) : '';
    if (document.activeElement !== projectSettingsCustomHeight) projectSettingsCustomHeight.value = customHeight ? String(customHeight) : '';
    targetSizeInput.value = settings.targetSize ?? '';
    exactCuts.checked = Boolean(settings.exactCuts);
    if (['off', 'podcast', 'social'].includes(settings.normalize)) normalize.value = settings.normalize;
    keepOriginal.checked = settings.keepOriginal !== false;
    originalVolume.value = settings.originalVolume ?? '100';
    originalVolumeValue.textContent = `${originalVolume.value}%`;
    duck.checked = Boolean(settings.duck);
    duckCaptions.checked = Boolean(settings.duckCaptions);
    if (settings.captionPosition === 'top' || settings.captionPosition === 'bottom') {
      captionPosition.value = settings.captionPosition;
    }
    if (['small', 'medium', 'large'].includes(settings.captionSize)) captionSize.value = settings.captionSize;
    subtitleStyles = {};
    for (const [key, value] of Object.entries(settings.subtitleStyles ?? {})) {
      if (key.trim()) subtitleStyles[key] = normalizeTextStyle(value, defaultSubtitleTextStyle());
    }
    subtitleTransitions = {};
    for (const [key, value] of Object.entries(settings.subtitleTransitions ?? {})) {
      if (!key.trim()) continue;
      if (value === 'fade-in' || value === 'fade-out' || value === 'dip') subtitleTransitions[key] = value;
    }
  }

  function projectFingerprint(): string {
    fingerprintCache ??= JSON.stringify({
      state: signature(snapshot()),
      assets: assets.map((asset) => asset.key),
      name: projectName.value.trim(),
      settings: projectSettings(),
    });
    return fingerprintCache;
  }

  function invalidateFingerprint(): void {
    fingerprintCache = null;
  }

  let projectStateTimer = 0;
  function scheduleProjectState(): void {
    if (projectStateTimer) return;
    projectStateTimer = window.setTimeout(() => {
      projectStateTimer = 0;
      if (!savedFingerprint) return;
      const saved = projectFingerprint() === savedFingerprint;
      projectState.textContent = saved ? 'Saved locally' : currentProjectId ? 'Unsaved changes' : 'Not saved';
      projectState.className = 'video-project-state ' + (saved ? 'saved' : 'dirty');
    }, 150);
  }

  function updateProjectBar(): void {
    const hasMedia = videos.length > 0 || audios.length > 0 || assets.length > 0;
    if (!hasMedia) {
      projectMeta.textContent = 'No media';
    } else if (!videos.length) {
      const label = document.createElement('span');
      label.textContent = 'Audio only';
      projectMeta.replaceChildren(
        label,
        document.createTextNode(` · ${formatClock(totalAudio(), true)} · ${audios.length}`),
      );
    } else {
      const size = outputDimensions();
      projectMeta.textContent = `${size.width}×${size.height} · ${fpsLabel(fpsOfProject())} · ${formatClock(previewEnd(), true)}`;
    }
    const latest = projectSummaries[0];
    const emptyTimeline = !videos.length && !audios.length && !assets.length;
    if (emptyTimeline && latest && latest.id !== currentProjectId) {
      const target = projectSummaries.find((project) => project.id === reopenProjectId) ?? latest;
      projectReopen.dataset.projectId = target.id;
      const reopenLabel = document.createElement('span');
      reopenLabel.textContent = 'Reopen';
      const reopenName = document.createElement('span');
      reopenName.setAttribute('data-no-i18n', '');
      reopenName.textContent = ` ${target.name}`;
      projectReopen.replaceChildren(reopenLabel, reopenName);
      projectReopen.classList.remove('hidden');
    } else {
      projectReopen.classList.add('hidden');
      projectReopen.removeAttribute('data-project-id');
    }
    projectSave.disabled = projectSaving || !hasMedia || operation !== null || recording !== null;
    projectSave.textContent = projectSaving ? 'Saving…' : 'Save';
    if (!hasMedia) {
      projectState.textContent = '';
      projectState.className = 'video-project-state';
      return;
    }
    if (savedFingerprint) scheduleProjectState();
    else {
      projectState.textContent = currentProjectId ? 'Unsaved changes' : 'Not saved';
      projectState.className = 'video-project-state dirty';
    }
  }

  // Project settings --------------------------------------------------------
  let projectSettingsReturnFocus: HTMLElement | null = null;

  const projectSettingsDimensions = (): { width: number; height: number } => {
    const first = videos.find((clip) => !clip.image) ?? videos[0];
    return targetSize(projectSettingsResolution.value as MergePreset, {
      width: first?.probe.width || 1280,
      height: first?.probe.height || 720,
    }, undefined, {
      width: Number(projectSettingsCustomWidth.value) || customWidth,
      height: Number(projectSettingsCustomHeight.value) || customHeight,
    });
  };

  const projectAspectLabel = (width: number, height: number): string => {
    if (!width || !height) return '';
    const ratio = width / height;
    if (Math.abs(ratio - 16 / 9) < 0.015) return '16:9';
    if (Math.abs(ratio - 9 / 16) < 0.015) return '9:16';
    if (Math.abs(ratio - 4 / 3) < 0.015) return '4:3';
    if (Math.abs(ratio - 1) < 0.008) return '1:1';
    return ratio >= 1 ? `${ratio.toFixed(2)}:1` : `1:${(1 / ratio).toFixed(2)}`;
  };

  function updateProjectSettingsReadouts(): void {
    projectSettingsCustomRow.classList.toggle('hidden', projectSettingsResolution.value !== 'custom');
    const size = projectSettingsDimensions();
    projectSettingsCanvas.textContent = `${size.width}×${size.height} · ${projectAspectLabel(size.width, size.height)}`;
    projectSettingsCustomFpsRow.classList.toggle('hidden', projectSettingsFps.value !== 'custom');
    projectSettingsDuration.textContent = formatClock(previewEnd(), true);
    projectSettingsSummary.textContent = `${videos.length} video · ${audios.length} audio · ${assets.length} media · ${titles.length} title${titles.length === 1 ? '' : 's'} · ${graphics.length} graphic${graphics.length === 1 ? '' : 's'}`;
    projectSettingsVolumeValue.textContent = `${projectSettingsVolume.value}%`;
  }

  function refreshProjectSettingsControlState(): void {
    const keep = projectSettingsKeepOriginal.checked;
    projectSettingsVolume.disabled = !keep;
    projectSettingsDuck.disabled = !keep;
    projectSettingsDuckCaptions.disabled = !keep || !projectSettingsDuck.checked || !shiftedCues().length;
    for (const control of [projectSettingsCaptionSource, projectSettingsCaptionMode, projectSettingsCaptionPosition, projectSettingsCaptionSize]) {
      control.disabled = captionTrackState.locked;
    }
  }

  function markProjectSettingsDirty(): void {
    projectSettingsSave.disabled = false;
    projectSettingsStatus.textContent = 'Unsaved changes · Save to apply them.';
    updateProjectSettingsReadouts();
    refreshProjectSettingsControlState();
  }

  function setProjectSettingsTab(tab: string): void {
    for (const button of projectSettingsNav) {
      const active = button.dataset.projectSettingsTab === tab;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
    }
    for (const panel of projectSettingsPanels) {
      panel.classList.toggle('hidden', panel.dataset.projectSettingsPanel !== tab);
    }
  }

  function syncProjectSettingsForm(): void {
    if (!projectSettingsResolution.options.length) {
      projectSettingsResolution.replaceChildren(
        ...Object.entries(MERGE_PRESETS).map(([value, spec]) => new Option(spec.label, value)),
      );
    }
    projectSettingsResolution.value = preset.value;
    if (!customWidth || !customHeight) {
      const size = outputDimensions();
      customWidth = size.width;
      customHeight = size.height;
    }
    projectSettingsCustomWidth.value = String(customWidth);
    projectSettingsCustomHeight.value = String(customHeight);
    if (!projectSettingsFps.options.length) {
      projectSettingsFps.replaceChildren(
        new Option('Match source', 'source'),
        ...PROJECT_FPS_PRESETS.map((fps) => new Option(fpsLabel(fps), String(fps))),
        new Option('Custom…', 'custom'),
      );
    }
    const sourceFps = sourceFpsOfProject();
    projectSettingsFps.options[0].textContent = videos.some((clip) => !clip.image)
      ? `Match source (${fpsLabel(sourceFps)})`
      : 'Match source';
    if (projectFpsOverride === null) {
      projectSettingsFps.value = 'source';
      projectSettingsCustomFps.value = String(sourceFps);
    } else {
      const presetRate = PROJECT_FPS_PRESETS.some((fps) => Math.abs(fps - projectFpsOverride!) < 0.0005);
      projectSettingsFps.value = presetRate ? String(projectFpsOverride) : 'custom';
      projectSettingsCustomFps.value = String(projectFpsOverride);
    }
    projectSettingsCustomFpsRow.classList.toggle('hidden', projectSettingsFps.value !== 'custom');
    projectSettingsName.value = projectName.value;
    projectSettingsNormalize.value = normalize.value;
    projectSettingsKeepOriginal.checked = keepOriginal.checked;
    projectSettingsVolume.value = originalVolume.value;
    projectSettingsDuck.checked = duck.checked;
    projectSettingsDuckCaptions.checked = duckCaptions.checked;
    projectSettingsCaptionSource.value = captionSource.value;
    projectSettingsCaptionMode.value = captionMode.value;
    projectSettingsCaptionPosition.value = captionPosition.value;
    projectSettingsCaptionSize.value = captionSize.value;
    projectSettingsQuality.value = qualitySelect.value;
    projectSettingsZoom.value = previewZoomSelect.value;
    projectSettingsSave.disabled = true;
    projectSettingsStatus.textContent = 'Changes apply when you save.';
    updateProjectSettingsReadouts();
    refreshProjectSettingsControlState();
  }

  function openProjectSettingsModal(tab = 'master'): void {
    projectSettingsReturnFocus = projectSettingsButton;
    setProjectMenu(false);
    setExportMenu(false);
    syncProjectSettingsForm();
    setProjectSettingsTab(tab);
    projectSettingsModal.classList.remove('hidden');
    projectSettingsModal.setAttribute('aria-hidden', 'false');
    projectSettingsName.focus();
    projectSettingsName.select();
  }

  function closeProjectSettingsModal(): void {
    projectSettingsModal.classList.add('hidden');
    projectSettingsModal.setAttribute('aria-hidden', 'true');
    const target = projectSettingsReturnFocus;
    projectSettingsReturnFocus = null;
    target?.focus({ preventScroll: true });
  }

  function saveProjectSettingsModal(): void {
    const name = projectSettingsName.value.trim() || defaultProjectName();
    projectName.value = name;
    projectNameIsDefault = false;
    preset.value = projectSettingsResolution.value;
    let sizeNote = '';
    if (preset.value === 'custom') {
      const fallback = outputDimensions();
      const width = Number(projectSettingsCustomWidth.value) || fallback.width;
      const height = Number(projectSettingsCustomHeight.value) || fallback.height;
      customWidth = Math.max(2, Math.min(7680, Math.round(width / 2) * 2));
      customHeight = Math.max(2, Math.min(7680, Math.round(height / 2) * 2));
      if (customWidth !== Math.round(width) || customHeight !== Math.round(height)) {
        sizeNote = ` Size set to ${customWidth} × ${customHeight}: video encoders need even dimensions up to 7680.`;
      }
      projectSettingsCustomWidth.value = String(customWidth);
      projectSettingsCustomHeight.value = String(customHeight);
    }
    const fpsChoice = projectSettingsFps.value;
    if (fpsChoice === 'source') {
      projectFpsOverride = null;
    } else if (fpsChoice === 'custom') {
      const customFps = normalizeProjectFps(projectSettingsCustomFps.value);
      if (customFps === null) {
        projectSettingsStatus.textContent = 'Enter a frame rate from 1 to 240 fps.';
        projectSettingsCustomFps.focus();
        projectSettingsCustomFps.select();
        return;
      }
      projectFpsOverride = customFps;
      projectSettingsCustomFps.value = String(customFps);
    } else {
      projectFpsOverride = normalizeProjectFps(fpsChoice);
    }
    projectFpsCache = null;
    normalize.value = projectSettingsNormalize.value;
    keepOriginal.checked = projectSettingsKeepOriginal.checked;
    originalVolume.value = projectSettingsVolume.value;
    originalVolumeValue.textContent = `${originalVolume.value}%`;
    duck.checked = projectSettingsDuck.checked;
    duckCaptions.checked = projectSettingsDuckCaptions.checked;
    if (!captionTrackState.locked) {
      captionSource.value = projectSettingsCaptionSource.value;
      captionMode.value = projectSettingsCaptionMode.value;
      captionPosition.value = projectSettingsCaptionPosition.value;
      captionSize.value = projectSettingsCaptionSize.value;
    }
    qualitySelect.value = projectSettingsQuality.value;
    previewZoomSelect.value = projectSettingsZoom.value;
    const wantsCaptionFile = captionSource.value === 'file' && !fileCues;
    invalidateFingerprint();
    qualitySelect.dispatchEvent(new Event('change', { bubbles: true }));
    previewZoomSelect.dispatchEvent(new Event('change', { bubbles: true }));
    updatePreviewFrame();
    applyOriginalVolume();
    updateCaptions();
    updateProjectBar();
    updateExportMenu();
    update();
    closeProjectSettingsModal();
    if (wantsCaptionFile) captionFile.click();
    else status.textContent = `Project settings updated.${sizeNote}`;
  }

  projectSettingsGpuPreview.checked = compositorPreference() !== 'css';
  projectSettingsGpuPreview.addEventListener('change', () => {
    localStorage.setItem(COMPOSITOR_STORAGE_KEY, projectSettingsGpuPreview.checked ? 'webgpu' : 'css');
    cachedCompositorPreference = null;
    compositorNoticeShown = false;
    gpuPreview?.dispose();
    gpuPreview = null;
    gpuPreviewUnavailable = false;
    webgpuFailed = false;
    if (!projectSettingsGpuPreview.checked) {
      previewRenderCache.clear();
      if (cacheCanvas) {
        cacheCanvas.width = 0;
        cacheCanvas.height = 0;
      }
      hideCacheFrame();
      showCssPreview();
      status.textContent = 'Standard preview enabled.';
      return;
    }
    const created = ensureGpuPreview();
    projectSettingsGpuPreview.checked = Boolean(created);
    if (created) {
      renderGpuPreview(activeVideo);
      status.textContent = 'GPU preview enabled.';
    }
  });
  projectSettingsButton.addEventListener('click', () => openProjectSettingsModal());
  projectSettingsClose.addEventListener('click', closeProjectSettingsModal);
  projectSettingsCancel.addEventListener('click', closeProjectSettingsModal);
  projectSettingsSave.addEventListener('click', saveProjectSettingsModal);
  projectSettingsModal.addEventListener('pointerdown', (event) => {
    if (event.target === projectSettingsModal) closeProjectSettingsModal();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || projectSettingsModal.classList.contains('hidden')) return;
    event.preventDefault();
    closeProjectSettingsModal();
  });
  for (const button of projectSettingsNav) {
    button.addEventListener('click', () => setProjectSettingsTab(button.dataset.projectSettingsTab ?? 'master'));
  }
  for (const control of [
    projectSettingsName, projectSettingsResolution, projectSettingsCustomWidth,
    projectSettingsCustomHeight, projectSettingsFps, projectSettingsCustomFps,
    projectSettingsNormalize, projectSettingsKeepOriginal, projectSettingsVolume,
    projectSettingsDuck, projectSettingsDuckCaptions, projectSettingsCaptionSource,
    projectSettingsCaptionMode, projectSettingsCaptionPosition, projectSettingsCaptionSize,
    projectSettingsQuality, projectSettingsZoom,
  ]) {
    control.addEventListener('input', markProjectSettingsDirty);
    control.addEventListener('change', markProjectSettingsDirty);
  }
  projectSettingsFps.addEventListener('change', () => {
    const custom = projectSettingsFps.value === 'custom';
    projectSettingsCustomFpsRow.classList.toggle('hidden', !custom);
    if (!custom) return;
    if (normalizeProjectFps(projectSettingsCustomFps.value) === null) {
      projectSettingsCustomFps.value = String(fpsOfProject());
    }
    projectSettingsCustomFps.focus();
    projectSettingsCustomFps.select();
  });

  function setProjectMenu(open: boolean): void {
    projectMenu.classList.toggle('hidden', !open);
    projectOpen.setAttribute('aria-expanded', String(open));
    if (!open) return;
    renderProjectList();
    void refreshProjectList();
  }

  function renderProjectList(): void {
    projectList.replaceChildren();
    if (!projectSummaries.length) {
      const empty = document.createElement('p');
      empty.className = 'video-project-empty';
      empty.textContent = 'No saved projects yet. Save this timeline to reopen it after a refresh.';
      projectList.append(empty);
      return;
    }
    for (const project of projectSummaries) {
      const row = document.createElement('div');
      row.className = 'video-project-entry' + (project.id === currentProjectId ? ' current' : '');
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'video-project-open';
      const name = document.createElement('span');
      name.className = 'video-project-entry-name';
      name.textContent = project.name;
      const meta = document.createElement('span');
      meta.className = 'video-project-entry-meta';
      const picture = document.createElement('span');
      picture.textContent = project.width > 0
        ? `${project.width}×${project.height} · ${fpsLabel(project.fps)}`
        : 'Audio only';
      meta.append(
        picture,
        document.createTextNode(` · ${formatClock(project.duration, true)} · ${project.bytes > 0 ? formatBytes(project.bytes) + ' · ' : ''}${savedWhen(project.updatedAt)}`),
      );
      open.append(name, meta);
      open.addEventListener('click', () => void openSavedProject(project.id));
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'video-project-delete';
      remove.title = `${translateUi('Delete')} ${project.name}`;
      remove.setAttribute('aria-label', `${translateUi('Delete')} ${project.name}`);
      remove.textContent = '×';
      remove.addEventListener('click', async (event) => {
        event.stopPropagation();
        if (!confirm(translateUi('Delete this video project? This cannot be undone.'))) return;
        try {
          await deleteVideoProject(project.id);
          if (currentProjectId === project.id) {
            currentProjectId = '';
            currentProjectCreatedAt = 0;
            savedFingerprint = '';
            try { localStorage.removeItem(LAST_PROJECT_KEY); } catch { /* Storage is optional. */ }
          }
          projectSummaries = await listVideoProjects();
          renderProjectList();
          updateProjectBar();
          status.textContent = 'Project deleted from this browser.';
        } catch (error) {
          status.textContent = errorMessage(error);
        }
      });
      row.append(open, remove);
      projectList.append(row);
    }
  }

  async function refreshProjectList(): Promise<void> {
    try {
      projectSummaries = await listVideoProjects();
    } catch {
      projectSummaries = [];
    }
    renderProjectList();
    updateProjectBar();
  }

  /** Snapshot plus the files and settings that make a project portable. */
  function projectData(): ProjectData {
    const state = snapshot();
    return {
      state: {
        ...state,
        assets: [],
        videos: state.videos.map((clip) => ({ ...clip, strip: null })),
      },
      assets: assets.map(({ url: _url, proxyUrl: _proxyUrl, ...asset }) => ({
        ...asset,
        strip: asset.kind === 'image' ? null : asset.strip,
      })),
      settings: projectSettings(),
    };
  }

  /** Count unique media once, plus an estimate for strings and peaks. */
  function estimateProjectBytes(data: ProjectData): number {    let bytes = 512;
    const seen = new Set<object>();
    const walk = (value: unknown): void => {
      if (typeof value === 'string') { bytes += value.length * 2; return; }
      if (!value || typeof value !== 'object') return;
      if (seen.has(value)) return;
      seen.add(value);
      if (value instanceof Blob) { bytes += value.size; return; }
      if (value instanceof ArrayBuffer) { bytes += value.byteLength; return; }
      if (ArrayBuffer.isView(value)) { bytes += value.byteLength; return; }
      if (Array.isArray(value)) {
        for (const item of value) walk(item);
        return;
      }
      for (const item of Object.values(value as Record<string, unknown>)) walk(item);
    };
    walk(data);
    return bytes;
  }

  async function saveCurrentProject(): Promise<void> {
    if (projectSaving) return;
    if (operation || recording) {
      status.textContent = 'Wait for the current job to finish before saving the project.';
      return;
    }
    if (!videos.length && !audios.length && !assets.length) {
      status.textContent = 'Add media before saving a project.';
      return;
    }
    window.clearTimeout(autosaveTimer);
    autosaveTimer = 0;
    projectSaving = true;
    updateProjectBar();
    try {
      const name = projectName.value.trim() || defaultProjectName();
      projectName.value = name;
      const id = currentProjectId || makeProjectId();
      const now = Date.now();
      const createdAt = currentProjectCreatedAt ||
        projectSummaries.find((project) => project.id === id)?.createdAt ||
        now;
      const fingerprintAtSave = projectFingerprint();      const hasVideo = videos.length > 0;
      const size = hasVideo ? outputDimensions() : { width: 0, height: 0 };
      const data = projectData();
      const project: VideoProject = {
        id,
        name,
        version: 1,
        createdAt,
        updatedAt: now,
        width: size.width,
        height: size.height,
        fps: hasVideo ? fpsOfProject() : 0,
        duration: previewEnd(),
        bytes: estimateProjectBytes(data),
        data,
      };
      await saveVideoProject(project);
      currentProjectId = id;
      currentProjectCreatedAt = createdAt;
      reopenProjectId = id;
      try { localStorage.setItem(LAST_PROJECT_KEY, id); } catch { /* Storage is optional. */ }
      savedFingerprint = fingerprintAtSave;
      await refreshProjectList();
      setProjectMenu(false);
      status.textContent = 'Project saved locally. Reopen it from Projects after a refresh.';
    } catch (error) {
      status.textContent = errorMessage(error);
    } finally {
      projectSaving = false;
      updateProjectBar();
    }
  }

  interface PortableFile {
    name: string;
    size: number;
    lastModified: number;
    type: string;
    path: string;
  }

  interface PortableProxy {
    path: string;
    width: number;
    height: number;
    compatibility?: boolean;
  }

  function fileMeta(file: File, path: string): PortableFile {
    return { name: file.name, size: file.size, lastModified: file.lastModified, type: file.type, path };
  }

  function safeArchiveName(name: string): string {
    return name.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80) || 'project';
  }

  async function exportProjectArchive(): Promise<void> {
    if (!videos.length && !audios.length && !assets.length) {
      status.textContent = 'Add media before exporting a project.';
      return;
    }
    try {
      const data = projectData();
      const files = new Map<string, Blob>();
      const mediaPaths = new Map<string, string>();
      let mediaIndex = 0;
      const addMediaFile = (file: File, key: string): void => {
        if (mediaPaths.has(key)) return;
        mediaIndex += 1;
        const path = `media/${String(mediaIndex).padStart(3, '0')}-${safeArchiveName(file.name)}`;
        mediaPaths.set(key, path);
        files.set(path, file);
      };
      for (const asset of assets) addMediaFile(asset.file, asset.key);
      // A media-pool asset can be removed while its clips stay on the
      // timeline. Keep those clip files in the archive too.
      for (const clip of [...videos, ...audios]) addMediaFile(clip.file, mediaKey(clip.file));
      const proxyPaths = new Map<string, PortableProxy>();
      for (const [index, asset] of assets.entries()) {
        if (!asset.proxy) continue;
        const path = `proxies/${String(index + 1).padStart(3, '0')}-${asset.proxy.height || 720}p.mp4`;
        proxyPaths.set(asset.key, { path, width: asset.proxy.width, height: asset.proxy.height, compatibility: asset.proxy.compatibility });
        files.set(path, asset.proxy.blob);
      }
      const portable = {
        format: 'localscribe-video-project',
        version: 2,
        name: projectName.value.trim() || defaultProjectName(),
        createdAt: currentProjectCreatedAt || Date.now(),
        settings: data.settings,
        state: {
          ...data.state,
          videos: data.state.videos.map(({ proxy: _proxy, ...clip }) => ({
            ...clip,
            file: fileMeta(clip.file, mediaPaths.get(mediaKey(clip.file)) ?? ''),
            proxy: proxyPaths.get(mediaKey(clip.file)) ?? null,
            peaks: null,
            strip: null,
          })),
          audios: data.state.audios.map(({ ...clip }) => ({
            ...clip,
            file: fileMeta(clip.file, mediaPaths.get(mediaKey(clip.file)) ?? ''),
            peaks: null,
          })),
        },
        assets: data.assets.map(({ proxy: _proxy, ...asset }) => ({
          ...asset,
          file: fileMeta(asset.file, mediaPaths.get(asset.key) ?? ''),
          proxy: proxyPaths.get(asset.key) ?? null,
          peaks: null,
          strip: null,
          poster: null,
        })),
      };
      files.set('project.json', new Blob([JSON.stringify(portable)], { type: 'application/json' }));
      const archive = await createZip([...files].map(([name, blob]) => ({ name, blob })));
      options.download(archive, `${safeArchiveName(portable.name)}.localscribe.zip`);
      status.textContent = `Exported ${portable.name} with ${mediaPaths.size} media file${mediaPaths.size === 1 ? '' : 's'}.`;
    } catch (error) {
      status.textContent = errorMessage(error);
    }
  }

  async function importProjectArchive(file: File): Promise<void> {
    try {
      const entries = await readZip(file);
      const blobs = new Map(entries.map((entry) => [entry.name, entry.blob]));
      const json = entries.find((entry) => /(^|\/)project\.json$/i.test(entry.name)) ?? entries.find((entry) => /\.json$/i.test(entry.name));
      if (!json) throw new Error('The archive has no project.json.');
      const portable = JSON.parse(await json.blob.text()) as {
        format?: string;
        version?: number;
        name?: string;
        settings?: ProjectSettings;
        state?: Snapshot;
        assets?: (SavedAsset & { file: PortableFile; proxy: PortableProxy | null })[];
      };
      if (portable.format !== 'localscribe-video-project' || !portable.state || !Array.isArray(portable.assets)) {
        throw new Error('This is not a LocalScribe video project archive.');
      }
      const fileFrom = (meta: PortableFile): File => {
        const blob = blobs.get(meta.path);
        if (!blob) throw new Error(`The archive is missing ${meta.path || meta.name}.`);
        return new File([blob], meta.name, { type: meta.type || blob.type, lastModified: meta.lastModified || Date.now() });
      };
      const proxyFrom = (meta: PortableProxy | null): ClipProxy | null => {
        if (!meta) return null;
        const blob = blobs.get(meta.path);
        if (!blob) return null;
        return { blob, width: meta.width || 0, height: meta.height || 0, compatibility: meta.compatibility };
      };
      const importedAssets: SavedAsset[] = portable.assets.map((raw) => {
        const { file, proxy, ...rest } = raw;
        return {
          ...rest,
          file: fileFrom(file),
          proxy: proxyFrom(proxy),
          peaks: null,
          strip: null,
          poster: null,
        } as SavedAsset;
      });
      const importedState: Snapshot = {
        ...portable.state,
        assets: importedAssets,
        audioTrackCount: Math.max(1, portable.state.audioTrackCount ?? 0),
        titles: portable.state.titles ?? [],
        graphics: portable.state.graphics ?? [],
        cameraCuts: portable.state.cameraCuts ?? [],
        videos: portable.state.videos.map((raw) => {
          const clip = raw as unknown as Snapshot['videos'][number] & { file: PortableFile; proxy: PortableProxy | null };
          return {
            ...clip,
            file: fileFrom(clip.file),
            proxy: proxyFrom(clip.proxy),
            transform: clipTransform(clip.transform),
            effects: normalizeEffects(clip.effects),
            animation: normalizeAnimation(clip.animation),
            peaks: null,
            strip: null,
          };
        }),
        audios: portable.state.audios.map((raw) => {
          const clip = raw as unknown as Snapshot['audios'][number] & { file: PortableFile };
          return { ...clip, file: fileFrom(clip.file), peaks: null };
        }),
        transcriptEdits: portable.state.transcriptEdits ?? [],
      };
      const id = makeProjectId();
      const now = Date.now();
      const name = String(portable.name || 'Imported project');
      const settings = portable.settings ?? projectSettings();
      const first = importedAssets.find((asset) => asset.kind !== 'audio');
      const size = targetSize(settings.preset as MergePreset ?? 'source', {
        width: first?.probe.width || 1280,
        height: first?.probe.height || 720,
      }, undefined, {
        width: settings.customWidth,
        height: settings.customHeight,
      });
      const projectDataValue: ProjectData = {
        state: importedState,
        assets: importedAssets,
        settings,
      };
      const project: VideoProject = {
        id,
        name,
        version: 1,
        createdAt: now,
        updatedAt: now,
        width: size.width,
        height: size.height,
        fps: first?.probe.fps || 0,
        duration: Math.max(
          0,
          ...importedState.videos.map((clip) => clip.start + videoClipLength(clip)),
          ...importedState.audios.map((clip) => clip.offset + audioClipLength(clip)),
        ),
        bytes: estimateProjectBytes(projectDataValue),
        data: projectDataValue,
      };
      await saveVideoProject(project);
      await refreshProjectList();
      await openSavedProject(id);
      status.textContent = `Imported “${name}”. Media and preview proxies were restored from the archive.`;
    } catch (error) {
      status.textContent = errorMessage(error);
    }
  }

  function relinkMedia(files: File[]): void {
    if (!files.length) return;
    const byKey = new Map(files.map((file) => [mediaKey(file), file]));
    const byName = new Map(files.map((file) => [file.name, file]));
    let relinked = 0;
    for (const asset of assets) {
      const oldKey = asset.key;
      const replacement = byKey.get(oldKey) ?? byName.get(asset.file.name) ?? byName.get(asset.name);
      if (!replacement) continue;
      URL.revokeObjectURL(asset.url);
      if (asset.file !== replacement && asset.proxy?.compatibility) setAssetProxy(asset, null);
      asset.file = replacement;
      asset.key = mediaKey(replacement);
      asset.url = URL.createObjectURL(replacement);
      relinked += 1;
      for (const clip of videos) {
        if (mediaKey(clip.file) !== oldKey && clip.file.name !== replacement.name) continue;
        URL.revokeObjectURL(clip.url);
        clip.file = replacement;
        clip.url = URL.createObjectURL(replacement);
      }
      for (const clip of audios) {
        if (mediaKey(clip.file) !== oldKey && clip.file.name !== replacement.name) continue;
        URL.revokeObjectURL(clip.url);
        clearAudioSource(clip.element);
        clip.file = replacement;
        clip.url = URL.createObjectURL(replacement);
        clip.element.src = clip.url;
        clip.peaks = null;
        loadAudioPeaks(clip, new AbortController().signal);
      }
    }
    renderMediaPool();
    render();
    commit();
    status.textContent = relinked
      ? `Relinked ${relinked} media file${relinked === 1 ? '' : 's'}.`
      : 'No media in this project matched those filenames.';
  }


  const stripUrls = new Map<Blob, string>();
  const stripUrlSet = new Set<string>();
  function stripUrl(strip: Strip): string {
    if (!strip) return '';
    if (typeof strip === 'string') return strip;
    let url = stripUrls.get(strip);
    if (!url) {
      url = URL.createObjectURL(strip);
      stripUrls.set(strip, url);
      stripUrlSet.add(url);
    }
    return url;
  }

  function releaseStripUrls(): void {
    for (const url of stripUrlSet) URL.revokeObjectURL(url);
    stripUrlSet.clear();
    stripUrls.clear();
  }

  function releaseProjectMedia(): void {
    pause();
    cancelAutoProxy();
    clearAssPreview();
    pendingVideoSeek = null;
    clearAudioSource(originalSound.element);
    sourceAudioController.abort();
    subtitleTask?.controller.abort();
    sourceAudioController = new AbortController();
    ++audioMixToken;
    window.clearTimeout(audioMixTimer);
    audioMixTimer = 0;
    audioMixSignature = '';
    audioMixBuffer = null;
    audioMixDirty = true;
    audioMixBuffers.clear();
    audioMixBytes = 0;
    releaseStripUrls();
    for (const clip of videos) {
      URL.revokeObjectURL(clip.url);
      if (clip.proxyUrl) URL.revokeObjectURL(clip.proxyUrl);
    }
    for (const clip of audios) {
      disposeAudio(clip);
      URL.revokeObjectURL(clip.url);
    }
    for (const asset of assets) {
      URL.revokeObjectURL(asset.url);
      if (asset.proxyUrl) URL.revokeObjectURL(asset.proxyUrl);
    }
  }

  function refreshSavedThumbnails(): void {
    for (const asset of assets) {
      if (asset.kind !== 'video') continue;
      ensurePoster(asset);
      if (asset.strip) continue;
      void filmstripFor(asset.file, asset.url, asset.duration, asset.key).then((strip) => {
        if (!strip || !assets.includes(asset)) return;
        asset.strip = strip;
        asset.stripVersion = FILMSTRIP_CACHE_VERSION;
        for (const clip of videos) {
          if (mediaKey(clip.file) === asset.key) clip.strip = strip;
        }
        renderMediaPool();
        render();
      });
    }
    // A pool asset can be removed while its clips stay on the timeline. The
    // saved project strips clip strips, so rebuild those from the clip file.
    for (const clip of videos) {
      if (clip.image || clip.strip) continue;
      const key = mediaKey(clip.file);
      if (assets.some((asset) => asset.key === key)) continue;
      void filmstripFor(clip.file, clip.url, clip.duration, key).then((strip) => {
        if (!strip || !videos.includes(clip)) return;
        clip.strip = strip;
        render();
      });
    }
  }

  async function openSavedProject(id: string): Promise<void> {
    if (operation || recording) {
      status.textContent = 'Wait for the current job to finish, then open a project.';
      return;
    }
    const project = await loadVideoProject(id).catch((error) => {
      status.textContent = errorMessage(error);
      return null;
    });
    if (!project) return;
    const hasWork = videos.length > 0 || audios.length > 0 || assets.length > 0;
    if (hasWork && projectFingerprint() !== savedFingerprint &&
      !confirm(`${project.name}\n\n${translateUi('Open this project? The current timeline has unsaved changes.')}`)) return;
    const data = project.data as ProjectData | null;
    if (!data?.state || !Array.isArray(data.assets) || !Array.isArray(data.state.videos)) {
      status.textContent = translateUi('This project file could not be read.');
      return;
    }
    try {
      releaseProjectMedia();
      assets = data.assets.map((asset) => {
        const url = URL.createObjectURL(asset.file);
        const currentStrip = asset.kind !== 'video'
          || !asset.strip
          || asset.stripVersion === FILMSTRIP_CACHE_VERSION;
        return {
          ...asset,
          url,
          strip: asset.kind === 'image' ? url : currentStrip ? asset.strip : null,
          stripVersion: asset.kind === 'image' ? FILMSTRIP_CACHE_VERSION : asset.stripVersion,
          poster: asset.poster ?? null,
          peaks: asset.peaks ?? null,
          proxy: asset.proxy ?? null,
          proxyUrl: asset.proxy ? URL.createObjectURL(asset.proxy.blob) : '',
        };
      });
      videos = data.state.videos.map((clip) => {
        const asset = assets.find((entry) => entry.key === mediaKey(clip.file));
        const url = URL.createObjectURL(clip.file);
        return {
          ...clip,
          transform: clipTransform(clip.transform),
          effects: normalizeEffects(clip.effects),
          animation: normalizeAnimation(clip.animation),
          proxy: clip.proxy ?? asset?.proxy ?? null,
          proxyUrl: clip.proxy ? URL.createObjectURL(clip.proxy.blob) : asset?.proxyUrl ?? '',
          peaks: clip.peaks ?? asset?.peaks ?? null,
          url,
          strip: asset?.kind === 'image' ? asset.url : asset?.strip ?? (clip.image ? url : null),
        };
      });
      audios = data.state.audios.map((clip) => {
        const url = URL.createObjectURL(clip.file);
        const asset = assets.find((entry) => entry.key === mediaKey(clip.file));
        return {
          ...clip,
          sourceTrack: restoreSourceTrack(clip),
          peaks: clip.peaks ?? (restoreSourceTrack(clip) === 0 ? asset?.peaks : null) ?? null,
          url,
          ...makeAudio(url),
        };
      });
      for (const clip of videos) if (clip.effects.speed !== 1 || clip.effects.speedPoints?.length) syncRetimeAudio(clip);
      titles = (data.state.titles ?? []).map((cue) => ({
        ...cue,
        style: cue.style ? { ...cue.style } : undefined,
      }));
      graphics = (data.state.graphics ?? []).map((graphic) => sanitizeGraphic(graphic));
      cameraCuts = (data.state.cameraCuts ?? []).map((cut) => ({ ...cut }));
      selectedTitle = -1;
      selectedSubtitleKey = '';
      selectedGraphic = -1;
      selected = data.state.selected ? { ...data.state.selected } : null;
      time = data.state.time;
      captionOffset = data.state.captionOffset;
      captionOffsetInput.value = String(captionOffset);
      captionSource.value = data.state.captionSource;
      captionMode.value = data.state.captionMode;
      captionFileName = data.state.captionFileName;
      captionTrackState = { hidden: false, locked: false, ...data.state.captionTrackState };
      captionPreset = normalizeCaptionPreset(data.state.captionPreset);
      fileCues = data.state.fileCues ? data.state.fileCues.map((cue) => ({ ...cue })) : null;
      invalidateShiftedCues();
      captionLaneKey = '';
      graphicsPreviewKey = '';
      textPreviewKey = '';
      videoTrackCount = Math.max(
        1,
        data.state.videoTrackCount,
        ...videos.map((clip) => clip.track + 1),
        ...titles.map((cue) => titleTrackIndex(cue) + 1),
        ...graphics.map((graphic) => graphicTrackIndex(graphic) + 1),
      );
      videoTrackState = data.state.videoTrackState.map((entry) => ({ ...entry }));
      while (videoTrackState.length < videoTrackCount) videoTrackState.push({ hidden: false, muted: false, locked: false, solo: false });
      audioTrackCount = Math.max(1, data.state.audioTrackCount ?? 0, ...audios.map((clip) => clip.track + 1));
      audioTrackState = (data.state.audioTrackState ?? []).map((entry) => ({ ...entry }));
      while (audioTrackState.length < audioTrackCount) audioTrackState.push({ muted: false, locked: false, solo: false });
      transcriptEdits = (data.state.transcriptEdits ?? []).map((span) => ({ ...span }));
      mergeTranscriptEdits();
      nextId = Math.max(0, ...videos.map((clip) => clip.id), ...audios.map((clip) => clip.id), ...graphics.map((graphic) => graphic.id)) + 1;
      nextLinkGroup = Math.max(0, ...videos.map((clip) => clip.linkGroup ?? 0), ...audios.map((clip) => clip.linkGroup ?? 0)) + 1;
      nextAssetId = Math.max(0, ...assets.map((asset) => asset.id)) + 1;
      activeVideo = null;
      preview.pause();
      preview.removeAttribute('src');
      preview.load();
      previewGain.gain.value = 0;
      still.classList.add('hidden');
      preview.classList.remove('hidden');
      if (data.settings) applyProjectSettings(data.settings);
      else {
        projectFpsOverride = null;
        projectFpsCache = null;
      }
      currentProjectId = project.id;
      currentProjectCreatedAt = project.createdAt;
      reopenProjectId = project.id;
      projectName.value = project.name;
      projectNameIsDefault = false;
      normalizeOverlayTracks();
      fitTimeline();
      zoomLevel = 1;
      zoom.value = '0';
      const openedState = snapshot();
      history = [openedState];
      historyLabels = ['Project opened'];
      historyDetails = [
        `Saved project · ${videos.length} clip${videos.length === 1 ? '' : 's'} · ` +
        `${audios.length} audio${audios.length === 1 ? '' : 's'}`,
      ];
      historySizes = [signature(openedState).length * 2];
      historyBytesTotal = historySizes[0];
      historyIndex = 0;
      updateHistoryButtons();
      renderMediaPool();
      render();
      seek(Math.min(time, timelineEnd()));
      savedFingerprint = projectFingerprint();
      scheduleAudioMix();
      scheduleAutoProxy();
      try { localStorage.setItem(LAST_PROJECT_KEY, project.id); } catch { /* Storage is optional. */ }
      setProjectMenu(false);
      updateProjectBar();
      refreshSavedThumbnails();
      const peaksSignal = new AbortController().signal;
      for (const clip of videos) if (!clip.peaks || clip.peaks.length < MIN_PEAK_BUCKETS) loadVideoPeaks(clip, peaksSignal);
      for (const clip of audios) loadAudioPeaks(clip, peaksSignal);
      status.textContent = `Opened “${project.name}” from this browser.`;
    } catch (error) {
      status.textContent = errorMessage(error);
    }
  }

  function startNewProject(ask = true): void {
    if (operation || recording) {
      status.textContent = 'Wait for the current job to finish before starting a new project.';
      return;
    }
    const hasWork = videos.length > 0 || audios.length > 0 || assets.length > 0;
    if (ask && hasWork && projectFingerprint() !== savedFingerprint &&
      !confirm(translateUi('Start a new project? The current timeline has unsaved changes.'))) return;
    releaseProjectMedia();
    videos = [];
    audios = [];
    assets = [];
    nextAssetId = 0;
    nextId = 0;
    selected = null;
    activeVideo = null;
    fileCues = null;
    captionFileName = '';
    captionOffset = 0;
    captionOffsetInput.value = '0';
    captionSource.value = 'none';
    captionMode.value = 'soft';
    captionPosition.value = 'bottom';
    captionSize.value = 'medium';
    invalidateShiftedCues();
    captionLaneKey = '';
    captionStatus.textContent = '';
    captionWarning.textContent = '';
    format.value = 'mp4';
    preset.value = 'source';
    projectFpsOverride = null;
    projectFpsCache = null;
    targetSizeInput.value = '';
    exactCuts.checked = false;
    normalize.value = 'off';
    keepOriginal.checked = true;
    originalVolume.value = '100';
    originalVolumeValue.textContent = '100%';
    duck.checked = false;
    duckCaptions.checked = false;
    preview.removeAttribute('src');
    preview.load();
    previewGain.gain.value = 0;
    still.classList.add('hidden');
    preview.classList.remove('hidden');
    time = 0;
    videoTrackCount = 1;
    audioTrackCount = 1;
    linkClipsEnabled = true;
    nextLinkGroup = 1;
    videoTrackState = [{ hidden: false, muted: false, locked: false, solo: false, gain: 1 }];
    audioTrackState = [{ muted: false, locked: false, solo: false, gain: 1 }];
    transcriptEdits = [];
    titles = [];
    selectedTitle = -1;
    selectedSubtitleKey = '';
    subtitleStyles = {};
    subtitleTransitions = {};
    showSubtitleTrack = false;
    captionTrackState = { hidden: false, locked: false };
    captionPreset = 'default';
    graphics = [];
    selectedGraphic = -1;
    cameraCuts = [];
    zoomLevel = 1;
    zoom.value = '0';
    fitTimeline();
    currentProjectId = '';
    currentProjectCreatedAt = 0;
    savedFingerprint = '';
    reopenProjectId = '';
    projectName.value = defaultProjectName();
    projectNameIsDefault = true;
    try { localStorage.removeItem(LAST_PROJECT_KEY); } catch { /* Storage is optional. */ }
    history = [];
    historyLabels = [];
    historyDetails = [];
    historySizes = [];
    historyBytesTotal = 0;
    historyIndex = -1;
    window.clearTimeout(audioMixTimer);
    audioMixTimer = 0;
    audioMixBuffer = null;
    audioMixDirty = false;
    stopAudioMix();
    render();
    renderMediaPool();
    commit();
    setProjectMenu(false);
    updateProjectBar();
    status.textContent = 'New project. Add video, audio, or images to begin.';
  }

  async function initializeProjects(): Promise<void> {
    try {
      projectSummaries = await listVideoProjects();
      const last = localStorage.getItem(LAST_PROJECT_KEY);
      if (last && projectSummaries.some((project) => project.id === last)) reopenProjectId = last;
    } catch {
      projectSummaries = [];
    }
    updateProjectBar();
  }

  projectSave.addEventListener('click', () => void saveCurrentProject());
  projectOpen.addEventListener('click', () => setProjectMenu(projectMenu.classList.contains('hidden')));
  projectReopen.addEventListener('click', () => {
    const id = projectReopen.dataset.projectId;
    if (id) void openSavedProject(id);
  });
  projectNew.addEventListener('click', () => startNewProject(true));
  projectExport.addEventListener('click', () => void exportProjectArchive());
  projectImport.addEventListener('click', () => projectFile.click());
  projectFile.addEventListener('change', () => {
    const file = projectFile.files?.[0];
    projectFile.value = '';
    if (file) void importProjectArchive(file);
  });
  projectRelink.addEventListener('click', () => projectRelinkFile.click());
  projectRelinkFile.addEventListener('change', () => {
    const files = Array.from(projectRelinkFile.files ?? []);
    projectRelinkFile.value = '';
    relinkMedia(files);
  });
  projectName.addEventListener('input', () => {
    projectNameIsDefault = false;
    invalidateFingerprint();
    updateProjectBar();
  });
  projectName.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') projectName.blur();
  });
  document.addEventListener('click', (event) => {
    if (projectMenu.classList.contains('hidden')) return;
    if (!(event.target instanceof Element) || !event.target.closest('#video-project-bar')) setProjectMenu(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !projectMenu.classList.contains('hidden')) setProjectMenu(false);
  });

  // Audio preview and history ------------------------------------------------
  function makeAudio(url?: string): { element: HTMLAudioElement; source: MediaElementAudioSourceNode; gain: GainNode } {
    const element = url ? new Audio(url) : new Audio();
    element.preload = 'metadata';
    const source = ctx.createMediaElementSource(element);
    const gain = ctx.createGain();
    source.connect(gain).connect(ctx.destination);
    element.volume = 1;
    return { element, source, gain };
  }

  const extractedAudio = new WeakMap<File, Map<number, Promise<File>>>();
  const audioSources = new WeakMap<HTMLAudioElement, { file: File; index: number; url?: string }>();
  let sourceAudioController = new AbortController();
  const originalSound = makeAudio();

  function embeddedAudioFile(file: File, index: number): Promise<File> {
    let streams = extractedAudio.get(file);
    if (!streams) {
      streams = new Map();
      extractedAudio.set(file, streams);
    }
    const existing = streams.get(index);
    if (existing) return existing;
    const task = prepareSourceAudio(ffmpeg, file, index, sourceAudioController.signal);
    streams.set(index, task);
    void task.catch(() => {
      if (streams.get(index) === task) streams.delete(index);
    });
    return task;
  }

  function clearAudioSource(element: HTMLAudioElement): void {
    element.pause();
    const current = audioSources.get(element);
    if (current?.url) URL.revokeObjectURL(current.url);
    audioSources.delete(element);
    element.removeAttribute('src');
    element.load();
  }

  function needsEmbeddedAudio(file: File, streamCount: number): boolean {
    return streamCount > 1 || /\.mk[va]$/i.test(file.name);
  }

  function ensureAudioSource(element: HTMLAudioElement, file: File, index: number): boolean {
    const current = audioSources.get(element);
    if (current?.file === file && current.index === index) return Boolean(current.url);
    clearAudioSource(element);
    const requested: { file: File; index: number; url?: string } = { file, index };
    audioSources.set(element, requested);
    void embeddedAudioFile(file, index).then((audio) => {
      if (audioSources.get(element) !== requested) return;
      requested.url = URL.createObjectURL(audio);
      element.src = requested.url;
    }).catch((error) => {
      if (audioSources.get(element) === requested && !isAbortError(error)) {
        status.textContent = `Could not preview audio track ${index + 1}: ${errorMessage(error)}`;
      }
    });
    return false;
  }

  function usesSeparateOriginalSound(clip: VideoClip): boolean {
    return Boolean(clip.proxy?.compatibility) || needsEmbeddedAudio(clip.file, clip.probe.audioStreams?.length ?? 0);
  }

  function previewAudioFile(clip: AudioClip): Promise<File> {
    return needsEmbeddedAudio(clip.file, clip.tracks.length)
      ? embeddedAudioFile(clip.file, clip.sourceTrack ?? 0)
      : Promise.resolve(clip.file);
  }

  function restoreSourceTrack(clip: AudioState): number {
    // Older projects stored the stream ordinal and timeline lane in the same field.
    return clip.sourceTrack ?? (clip.tracks.length > 1 && clip.track < clip.tracks.length ? clip.track : 0);
  }

  function disposeAudio(clip: AudioClip): void {
    clearAudioSource(clip.element);
    clip.source.disconnect();
    clip.gain.disconnect();
  }

  function mediaKey(file: File): string {
    return `${file.name}:${file.size}:${file.lastModified}`;
  }

  function ensurePoster(asset: MediaAsset): void {
    if (asset.kind !== 'video' || asset.poster) return;
    void posterFor(asset.url, asset.duration, asset.key).then((poster) => {
      if (!poster || !assets.includes(asset)) return;
      asset.poster = poster;
      renderMediaPool();
    });
  }

  function addAsset(
    file: File,
    kind: MediaAsset['kind'],
    duration: number,
    probe: MediaProbe,
    strip: string | null = null,
    peaks: Float32Array | null = null,
  ): MediaAsset {
    const key = mediaKey(file);
    const existing = assets.find((asset) => asset.key === key);
    if (existing) {
      if (strip) existing.strip = strip;
      if (peaks) existing.peaks = peaks;
      if (duration > 0) existing.duration = duration;
      ensurePoster(existing);
      return existing;
    }
    const asset: MediaAsset = {
      id: ++nextAssetId,
      key,
      file,
      kind,
      name: file.name,
      duration,
      probe,
      url: URL.createObjectURL(file),
      strip,
      poster: null,
      peaks,
      proxy: null,
      proxyUrl: '',
    };
    assets.push(asset);
    if (kind === 'video') scanMatroskaSubtitles(file);
    ensurePoster(asset);
    return asset;
  }

  function setAssetProxy(asset: MediaAsset, proxy: ClipProxy | null): void {
    const previous = new Set<string>();
    if (asset.proxyUrl) previous.add(asset.proxyUrl);
    const nextUrl = proxy ? URL.createObjectURL(proxy.blob) : '';
    asset.proxy = proxy;
    asset.proxyUrl = nextUrl;
    for (const clip of videos) {
      if (mediaKey(clip.file) !== asset.key) continue;
      if (clip.proxyUrl && clip.proxyUrl !== nextUrl) previous.add(clip.proxyUrl);
      clip.proxy = proxy;
      clip.proxyUrl = nextUrl;
    }
    for (const url of previous) {
      if (url !== nextUrl) URL.revokeObjectURL(url);
    }
  }

  const attemptedCompatibilityPreview = new WeakSet<File>();

  async function previewHasPicture(blob: Blob, signal: AbortSignal): Promise<boolean> {
    const element = document.createElement('video');
    const url = URL.createObjectURL(blob);
    try {
      return await new Promise<boolean>((resolve) => {
        const finish = (value: boolean): void => {
          window.clearTimeout(timer);
          signal.removeEventListener('abort', abort);
          resolve(value);
        };
        const abort = () => finish(false);
        const timer = window.setTimeout(() => finish(false), 5000);
        signal.addEventListener('abort', abort, { once: true });
        element.onloadeddata = () => finish(element.videoWidth > 0);
        element.onerror = () => finish(false);
        element.preload = 'auto';
        if (signal.aborted) abort();
        else element.src = url;
      });
    } finally {
      element.onloadeddata = null;
      element.onerror = null;
      element.removeAttribute('src');
      element.load();
      URL.revokeObjectURL(url);
    }
  }

  function prepareCompatibilityPreview(clip: VideoClip, retry = false): void {
    const file = clip.file;
    if (operation || clip.image || (!retry && attemptedCompatibilityPreview.has(file))) return;
    attemptedCompatibilityPreview.add(file);
    void run(`Preparing a playable preview for ${clip.name}…`, async (signal) => {
      const asset = assets.find((entry) => entry.key === mediaKey(file));
      const key = `preview-compat-v1:${mediaKey(file)}`;
      let proxy = await readCachedAsset<ClipProxy>(key);
      if (!proxy) {
        const { remuxVideoPreview } = await import('./mediabunny-engine');
        const copied = await remuxVideoPreview(file, signal).catch(() => null);
        signal.throwIfAborted();
        if (copied && await previewHasPicture(copied, signal)) {
          proxy = { blob: copied, width: clip.probe.width, height: clip.probe.height, compatibility: true };
        } else {
          const scale = Math.min(1, 1280 / (clip.probe.width || 1280), 720 / (clip.probe.height || 720));
          const width = Math.max(2, Math.round((clip.probe.width || 1280) * scale / 2) * 2);
          const height = Math.max(2, Math.round((clip.probe.height || 720) * scale / 2) * 2);
          const blob = await ffmpeg.run(file, [
            '-i', 'input.media', '-map', '0:v:0', '-an',
            '-vf', `scale=${width}:${height},setsar=1`,
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-pix_fmt', 'yuv420p',
            '-force_key_frames', 'expr:gte(t,n_forced*0.5)', '-movflags', '+faststart', 'preview.mp4',
          ], 'preview.mp4', 'video/mp4', {
            signal, duration: clip.duration,
            onProgress: ({ ratio }) => bar(ratio === null ? null : ratio * 100),
          });
          proxy = { blob, width, height, compatibility: true };
        }
        signal.throwIfAborted();
        if (!(await previewHasPicture(proxy.blob, signal))) throw new Error('This browser could not play the generated preview.');
        void writeCachedAsset(key, proxy);
      }
      signal.throwIfAborted();
      if (!videos.some((item) => item.file === file)) return;
      if (asset && assets.includes(asset)) setAssetProxy(asset, proxy);
      else for (const item of videos) {
        if (item.file !== file) continue;
        if (item.proxyUrl) URL.revokeObjectURL(item.proxyUrl);
        item.proxy = proxy;
        item.proxyUrl = URL.createObjectURL(proxy.blob);
      }
      const fallbackClip = videos.find((item) => item.file === file && item.proxy === proxy);
      if (fallbackClip?.proxyUrl && !fallbackClip.strip) {
        void filmstripFor(proxy.blob, fallbackClip.proxyUrl, clip.duration, key).then((strip) => {
          if (!strip) return;
          for (const item of videos) {
            if (item.file === file && item.proxy === proxy) item.strip = strip;
          }
          if (asset && assets.includes(asset) && asset.proxy === proxy) {
            asset.strip = strip;
            asset.stripVersion = FILMSTRIP_CACHE_VERSION;
          }
          scheduleImportedDecorations();
        }).catch(() => undefined);
      }
      renderMediaPool();
      syncMedia(true);
      scheduleImportedDecorations();
      status.textContent = `Playable preview ready for ${clip.name}. Export uses the original file.`;
    });
  }

  function checkPreviewCompatibility(): void {
    const clip = activeVideo;
    if (!clip || clip.image || preview.getAttribute('src') !== clip.url) return;
    if (preview.error || (preview.readyState >= 2 && !preview.videoWidth)) prepareCompatibilityPreview(clip);
  }

  const attemptedAutoProxies = new WeakSet<MediaAsset>();
  let autoProxyTimer = 0;
  let autoProxyJob: { asset: MediaAsset; worker?: Worker } | null = null;

  function cancelAutoProxy(): void {
    window.clearTimeout(autoProxyTimer);
    autoProxyTimer = 0;
    if (!autoProxyJob) return;
    autoProxyJob.worker?.terminate();
    attemptedAutoProxies.delete(autoProxyJob.asset);
    autoProxyJob = null;
  }

  function scheduleAutoProxy(): void {
    if (autoProxyTimer || autoProxyJob || playing || scrubbing || operation || recording ||
        previewQuality === 'full' || !root.checkVisibility()) return;
    const eligible = (entry: MediaAsset): boolean => entry.kind === 'video' && !entry.proxy &&
      Math.max(entry.probe.width, entry.probe.height) >= 3840 && !attemptedAutoProxies.has(entry);
    const asset = assets.find((entry) => entry.file === activeVideo?.file && eligible(entry)) ??
      assets.find(eligible);
    if (!asset) return;
    autoProxyTimer = window.setTimeout(async () => {
      autoProxyTimer = 0;
      if (playing || scrubbing || operation || recording || !root.checkVisibility() || !assets.includes(asset)) return;
      const job: NonNullable<typeof autoProxyJob> = { asset };
      autoProxyJob = job;
      attemptedAutoProxies.add(asset);
      const key = `proxy:short-gop-v1:${asset.key}`;
      const finish = (proxy: ClipProxy | null): void => {
        job.worker?.terminate();
        if (autoProxyJob !== job) return;
        autoProxyJob = null;
        if (proxy && assets.includes(asset) && !asset.proxy) {
          setAssetProxy(asset, proxy);
          renderMediaPool();
          if (!scrubbing) syncMedia(true);
        }
        scheduleAutoProxy();
      };
      try {
        const cached = await readCachedAsset<ClipProxy>(key);
        if (autoProxyJob !== job) return;
        if (cached || !assets.includes(asset)) {
          finish(cached);
          return;
        }
        const scale = Math.min(1280 / asset.probe.width, 720 / asset.probe.height);
        const width = Math.max(2, Math.round(asset.probe.width * scale / 2) * 2);
        const height = Math.max(2, Math.round(asset.probe.height * scale / 2) * 2);
        const worker = new Worker(new URL('./video-proxy-worker.ts', import.meta.url), { type: 'module' });
        job.worker = worker;
        worker.onmessage = ({ data }: MessageEvent<Blob | null>) => {
          const proxy = data ? { blob: data, width, height } : null;
          if (proxy && autoProxyJob === job) void writeCachedAsset(key, proxy);
          finish(proxy);
        };
        worker.onerror = () => finish(null);
        worker.postMessage({ file: asset.file, width, height });
      } catch {
        finish(null);
      }
    }, 750);
  }

  async function buildProxy(asset: MediaAsset): Promise<void> {
    if (asset.kind !== 'video' || operation) return;
    cancelAutoProxy();
    attemptedAutoProxies.add(asset);
    const cachedProxy = await readCachedAsset<{ blob: Blob; width: number; height: number }>(`proxy:${asset.key}`);
    if (cachedProxy?.blob) {
      setAssetProxy(asset, cachedProxy);
      syncMedia(true);
      renderMediaPool();
      render();
      status.textContent = `Cached preview proxy ready for ${asset.name} (${cachedProxy.width}×${cachedProxy.height}).`;
      return;
    }
    const sourceHeight = asset.probe.height || 1080;
    const targetHeight = sourceHeight > 1080 ? 720 : 540;
    const targetWidth = Math.max(2, Math.round(((asset.probe.width || 1280) * targetHeight) / sourceHeight / 2) * 2);
    await run(`Building a ${targetHeight}p preview for ${asset.name}`, async (signal) => {
      const blob = await ffmpeg.run(
        asset.file,
        [
          '-i', 'input.media',
          '-vf', `scale=-2:${targetHeight}:flags=lanczos`,
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24',
          '-force_key_frames', 'expr:gte(t,n_forced*0.5)',
          '-c:a', 'aac', '-b:a', '128k',
          '-movflags', '+faststart',
          'proxy.mp4',
        ],
        'proxy.mp4',
        'video/mp4',
        {
          signal,
          duration: asset.duration,
          onProgress: ({ ratio }) => {
            const fraction = Math.max(0, Math.min(1, ratio ?? 0));
            kind = 'work';
            progressLabel.textContent = `Building a ${targetHeight}p preview`;
            progressDetail.textContent = `${Math.round(fraction * 100)}%`;
            progressSub.textContent = 'Stored with the project; export still uses the original file';
            bar(fraction * 100);
          },
        },
      );
      signal.throwIfAborted();
      setAssetProxy(asset, { blob, width: targetWidth, height: targetHeight });
      syncMedia(true);
      void writeCachedAsset(`proxy:${asset.key}`, { blob, width: targetWidth, height: targetHeight });
      renderMediaPool();
      render();
      commit();
      status.textContent = `Preview proxy ready for ${asset.name} (${targetWidth}×${targetHeight}). Export still uses the original.`;
    }).catch(() => undefined);
  }

  function clearProxy(asset: MediaAsset): void {
    if (autoProxyJob?.asset === asset) cancelAutoProxy();
    attemptedAutoProxies.add(asset);
    setAssetProxy(asset, null);
    syncMedia(true);
    renderMediaPool();
    render();
    commit();
    status.textContent = `Removed the preview proxy for ${asset.name}.`;
  }

  function drawAssetWave(canvas: HTMLCanvasElement, peaks: Float32Array): void {
    // Render well above the largest card size so the waveform stays sharp
    // instead of being stretched from a 150px thumbnail.
    const width = 1024;
    const height = 576;
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return;
    const gradient = context.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, 'rgba(244, 114, 182, 0.95)');
    gradient.addColorStop(0.5, 'rgba(236, 72, 153, 0.88)');
    gradient.addColorStop(1, 'rgba(217, 70, 239, 0.7)');
    context.fillStyle = gradient;
    for (let x = 0; x < width; x += 1) {
      const value = peaks[Math.min(peaks.length - 1, Math.floor((x / width) * peaks.length))] ?? 0;
      const bar = Math.max(1, value * (height - 24));
      context.fillRect(x, (height - bar) / 2, 1, bar);
    }
  }

  interface MediaCardEntry {
    card: HTMLElement;
    asset: MediaAsset;
    thumb: HTMLElement;
    name: HTMLElement;
    meta: HTMLElement;
    proxy: HTMLButtonElement | null;
    thumbKey: string;
  }
  const mediaCardEntries = new Map<number, MediaCardEntry>();
  const pendingMediaThumbs = new WeakMap<HTMLElement, MediaAsset>();
  let mediaThumbObserver: IntersectionObserver | null = null;

  function populateMediaThumb(asset: MediaAsset, thumb: HTMLElement): void {
    thumb.replaceChildren();
    if (asset.kind === 'audio' && asset.peaks) {
      const canvas = document.createElement('canvas');
      drawAssetWave(canvas, asset.peaks);
      thumb.append(canvas);
    } else if (asset.poster) {
      const image = document.createElement('img');
      image.src = stripUrl(asset.poster);
      image.alt = '';
      image.loading = 'lazy';
      image.decoding = 'async';
      thumb.append(image);
    } else if (asset.strip || asset.kind === 'image') {
      const image = document.createElement('img');
      image.src = stripUrl(asset.strip) || asset.url;
      image.alt = '';
      image.loading = 'lazy';
      image.decoding = 'async';
      thumb.append(image);
    } else {
      thumb.textContent = asset.kind === 'video' ? 'Video' : 'Audio';
    }
  }

  function observeMediaThumb(thumb: HTMLElement, asset: MediaAsset): void {
    if (typeof IntersectionObserver === 'undefined') {
      populateMediaThumb(asset, thumb);
      return;
    }
    mediaThumbObserver ??= new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const target = entry.target as HTMLElement;
        const pending = pendingMediaThumbs.get(target);
        if (!pending) continue;
        pendingMediaThumbs.delete(target);
        mediaThumbObserver?.unobserve(target);
        populateMediaThumb(pending, target);
      }
    }, { rootMargin: '240px' });
    pendingMediaThumbs.set(thumb, asset);
    mediaThumbObserver.observe(thumb);
  }

  function thumbKeyFor(asset: MediaAsset): string {
    return `${asset.kind}|${asset.poster ? 'poster' : asset.strip ? 'strip' : ''}|${asset.peaks?.length ?? 0}|${asset.url}`;
  }

  function createMediaCard(asset: MediaAsset): MediaCardEntry {
    const card = document.createElement('div');
    card.className = 'video-asset';
    card.dataset.assetId = String(asset.id);
    card.draggable = true;
    card.title = 'Double-click to insert at the playhead, or drag onto the timeline';
    const thumb = document.createElement('div');
    thumb.className = 'video-asset-thumb';
    const row = document.createElement('div');
    row.className = 'video-asset-row';
    const name = document.createElement('span');
    name.className = 'video-asset-name';
    const insert = document.createElement('button');
    insert.type = 'button';
    insert.className = 'video-asset-insert';
    insert.textContent = '＋';
    insert.title = 'Insert at the playhead';
    const meta = document.createElement('span');
    meta.className = 'video-asset-meta';
    row.append(name, insert);
    card.append(thumb, row, meta);
    const entry: MediaCardEntry = {
      card, asset, thumb, name, meta, proxy: null, thumbKey: '',
    };
    insert.addEventListener('click', (event) => {
      event.stopPropagation();
      insertAsset(entry.asset);
    });
    card.addEventListener('dblclick', () => insertAsset(entry.asset));
    card.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openMediaMenu(entry.asset, event.clientX, event.clientY);
    });
    card.addEventListener('dragstart', (event) => {
      event.dataTransfer?.setData('application/x-video-asset', String(entry.asset.id));
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy';
    });
    if (asset.kind === 'video') {
      const proxy = document.createElement('button');
      proxy.type = 'button';
      proxy.className = 'video-asset-proxy';
      proxy.addEventListener('click', (event) => {
        event.stopPropagation();
        if (entry.asset.proxy) clearProxy(entry.asset);
        else void buildProxy(entry.asset);
      });
      card.append(proxy);
      entry.proxy = proxy;
    }
    return entry;
  }

  function updateMediaCard(entry: MediaCardEntry, asset: MediaAsset): void {
    entry.asset = asset;
    entry.card.dataset.assetId = String(asset.id);
    if (entry.name.textContent !== asset.name) entry.name.textContent = asset.name;
    const metaText = `${asset.kind === 'image' ? 'Image' : asset.kind === 'video' ? 'Video' : 'Audio'} · ${formatClock(asset.duration)}`;
    if (entry.meta.textContent !== metaText) entry.meta.textContent = metaText;
    if (entry.proxy) {
      const hd = Math.max(asset.probe.width || 0, asset.probe.height || 0);
      const proxyLabel = asset.proxy
        ? `Preview ${asset.proxy.height}p · remove`
        : hd > 1080 ? `${hd > 2160 ? '4K' : 'QHD'} · make a preview proxy` : 'Make a preview proxy';
      if (entry.proxy.textContent !== proxyLabel) entry.proxy.textContent = proxyLabel;
      const proxyTitle = asset.proxy
        ? 'Remove the low-resolution preview copy'
        : 'Build a small, fast copy for the timeline; export still uses the original';
      if (entry.proxy.title !== proxyTitle) entry.proxy.title = proxyTitle;
      entry.proxy.classList.toggle('active', Boolean(asset.proxy));
    }
    const thumbKey = thumbKeyFor(asset);
    if (entry.thumbKey === thumbKey) return;
    entry.thumbKey = thumbKey;
    pendingMediaThumbs.delete(entry.thumb);
    mediaThumbObserver?.unobserve(entry.thumb);
    entry.thumb.replaceChildren();
    observeMediaThumb(entry.thumb, asset);
  }

  function renderMediaPool(): void {
    const query = mediaQuery.trim().toLowerCase();
    const kind = mediaKind.value;
    const visible = assets.filter((asset) =>
      (kind === 'all' || asset.kind === kind) &&
      (!query || asset.name.toLowerCase().includes(query)));
    visible.sort((a, b) => mediaSort.value === 'duration'
      ? b.duration - a.duration || a.name.localeCompare(b.name)
      : mediaSort.value === 'recent'
        ? b.id - a.id
        : a.name.localeCompare(b.name));
    mediaCount.textContent = assets.length
      ? `${visible.length} of ${assets.length} item${assets.length === 1 ? '' : 's'} · double-click or drag to insert`
      : 'No media yet';
    const visibleIds = new Set(visible.map((asset) => asset.id));
    for (const [id, entry] of mediaCardEntries) {
      if (visibleIds.has(id)) continue;
      pendingMediaThumbs.delete(entry.thumb);
      mediaThumbObserver?.unobserve(entry.thumb);
      entry.card.remove();
      mediaCardEntries.delete(id);
    }
    mediaList.querySelector('.px-2.py-3')?.remove();
    if (!visible.length && assets.length) {
      const empty = document.createElement('p');
      empty.className = 'px-2 py-3 text-center text-[10px] text-slate-500';
      empty.textContent = 'No media matches this filter.';
      mediaList.append(empty);
      return;
    }
    let index = 0;
    for (const asset of visible) {
      let entry = mediaCardEntries.get(asset.id);
      if (!entry) {
        entry = createMediaCard(asset);
        mediaCardEntries.set(asset.id, entry);
      }
      updateMediaCard(entry, asset);
      const current = mediaList.children[index] as HTMLElement | undefined;
      if (current !== entry.card) mediaList.insertBefore(entry.card, current ?? null);
      index += 1;
    }
  }

  mediaSearch.addEventListener('input', () => {
    mediaQuery = mediaSearch.value;
    renderMediaPool();
  });
  mediaKind.addEventListener('change', renderMediaPool);
  mediaSort.addEventListener('change', renderMediaPool);
  mediaList.addEventListener('scroll', closeTimelineMenu, { passive: true });

  interface MediaUsage {
    kind: 'video' | 'audio';
    id: number;
    start: number;
    end: number;
    label: string;
  }

  function mediaUsages(asset: MediaAsset): MediaUsage[] {
    const usages: MediaUsage[] = [];
    for (const clip of videos) {
      if (mediaKey(clip.file) !== asset.key) continue;
      const start = clip.start;
      const end = start + videoClipLength(clip);
      usages.push({
        kind: 'video',
        id: clip.id,
        start,
        end,
        label: `Video · V${clip.track + 1} · ${formatClock(start)}–${formatClock(end)}`,
      });
    }
    const rows = audioRows();
    for (const clip of audios) {
      if (mediaKey(clip.file) !== asset.key) continue;
      const start = clip.offset;
      const end = start + audioClipLength(clip);
      usages.push({
        kind: 'audio',
        id: clip.id,
        start,
        end,
        label: `Audio · A${(rows.get(clip.id) ?? 0) + 1} · ${formatClock(start)}–${formatClock(end)}`,
      });
    }
    return usages.sort((a, b) => a.start - b.start || (a.kind === b.kind ? a.id - b.id : a.kind === 'video' ? -1 : 1));
  }

  function mediaUsageClip(usage: MediaUsage): VideoClip | AudioClip | null {
    return usage.kind === 'video'
      ? videos.find((clip) => clip.id === usage.id) ?? null
      : audios.find((clip) => clip.id === usage.id) ?? null;
  }

  function scrollToMediaUsage(usage: MediaUsage): void {
    const scale = pps();
    const left = usage.start * scale;
    const right = usage.end * scale;
    const width = scroll.clientWidth;
    if (left < scroll.scrollLeft || right > scroll.scrollLeft + width) {
      scroll.scrollLeft = Math.max(0, left - width * 0.18);
    }
    const clip = mediaUsageClip(usage);
    if (!clip) return;
    const row = usage.kind === 'audio' ? audioRows().get(clip.id) ?? 0 : 0;
    const top = usage.kind === 'video'
      ? videoLane.offsetTop + trackTopPad() + videoTrackTop(clip.track)
      : audioLane.offsetTop + trackTopPad() + audioTrackTop(row);
    const height = usage.kind === 'video'
      ? videoTrackHeight(clip.track)
      : audioTrackHeight(row);
    const viewport = scroll.clientHeight;
    if (top < scroll.scrollTop || top + height > scroll.scrollTop + viewport) {
      scroll.scrollTop = Math.max(0, top - viewport * 0.18);
    }
  }

  function flashMediaUsage(usage: MediaUsage): void {
    const block = (usage.kind === 'video' ? videoLane : audioLane)
      .querySelector<HTMLElement>(`.vt-clip[data-id="${usage.id}"]`);
    if (!block) return;
    block.classList.remove('focus-flash');
    void block.offsetWidth;
    block.classList.add('focus-flash');
    window.setTimeout(() => block.classList.remove('focus-flash'), 1300);
  }

  function focusMediaUsage(usage: MediaUsage): void {
    const clip = mediaUsageClip(usage);
    if (!clip) return;
    setClipSelection(usage.kind, usage.id);
    selectedTitle = -1;
    selectedGraphic = -1;
    selectedSubtitleKey = '';
    selectSideTab('clip');
    seek(usage.start);
    render();
    scrollToMediaUsage(usage);
    flashMediaUsage(usage);
    status.textContent = usage.kind === 'video'
      ? `Focused ${clip.name} on V${(clip as VideoClip).track + 1}.`
      : `Focused ${clip.name} on A${(audioRows().get(clip.id) ?? 0) + 1}.`;
  }

  function selectMediaUsages(asset: MediaAsset, usages: MediaUsage[]): void {
    if (!usages.length) return;
    selectedClipKeys = expandLinkedSelection(new Set(usages.map((usage) => clipSelectionKey(usage))));
    const last = usages[usages.length - 1];
    selected = { kind: last.kind, id: last.id };
    selectionAnchor = clipSelectionKey(selected);
    selectedTitle = -1;
    selectedGraphic = -1;
    selectedSubtitleKey = '';
    selectSideTab('clip');
    seek(usages[0].start);
    render();
    scrollToMediaUsage(usages[0]);
    flashMediaUsage(usages[0]);
    renderInspector();
    announceClipSelection();
    status.textContent = `Selected ${usages.length} timeline clip${usages.length === 1 ? '' : 's'} using ${asset.name}.`;
  }

  function removeMediaFromPool(asset: MediaAsset): void {
    const usages = mediaUsages(asset);
    if (usages.length && !confirm(
      `Remove "${asset.name}" from the media pool?\n\n${usages.length} timeline clip${usages.length === 1 ? '' : 's'} using this file will stay on the timeline.`,
    )) return;
    const entry = mediaCardEntries.get(asset.id);
    if (entry) {
      pendingMediaThumbs.delete(entry.thumb);
      mediaThumbObserver?.unobserve(entry.thumb);
      entry.card.remove();
      mediaCardEntries.delete(asset.id);
    }
    assets = assets.filter((item) => item !== asset);
    if (!usages.length) {
      URL.revokeObjectURL(asset.url);
      if (asset.proxyUrl) URL.revokeObjectURL(asset.proxyUrl);
    }
    renderMediaPool();
    invalidateFingerprint();
    updateProjectBar();
    render();
    commit('Removed media from pool');
    status.textContent = usages.length
      ? `Removed ${asset.name} from the media pool. ${usages.length} timeline clip${usages.length === 1 ? '' : 's'} still use the file.`
      : `Removed ${asset.name} from the media pool.`;
  }

  function deleteMediaWithClips(asset: MediaAsset): void {
    const usages = mediaUsages(asset);
    const videosToRemove = new Set<VideoClip>();
    const audiosToRemove = new Set<AudioClip>();
    for (const usage of usages) {
      const clip = mediaUsageClip(usage);
      if (!clip) continue;
      if (usage.kind === 'video') {
        const video = clip as VideoClip;
        if (videoTrackLocked(video.track)) {
          lockedNotice();
          return;
        }
        videosToRemove.add(video);
      } else {
        const audio = clip as AudioClip;
        if (audioClipLocked(audio)) {
          lockedNotice();
          return;
        }
        audiosToRemove.add(audio);
      }
    }
    const count = videosToRemove.size + audiosToRemove.size;
    if (!count || !confirm(
      `Delete "${asset.name}" from the media pool and remove ${count} timeline clip${count === 1 ? '' : 's'}?`,
    )) return;
    const linkGroups = new Set<number>();
    for (const clip of videosToRemove) if (clip.linkGroup) linkGroups.add(clip.linkGroup);
    for (const clip of audiosToRemove) if (clip.linkGroup) linkGroups.add(clip.linkGroup);
    for (const clip of audiosToRemove) {
      disposeAudio(clip);
      URL.revokeObjectURL(clip.url);
    }
    for (const clip of videosToRemove) {
      URL.revokeObjectURL(clip.url);
      if (clip.proxyUrl) URL.revokeObjectURL(clip.proxyUrl);
      if (activeVideo === clip) activeVideo = null;
    }
    if (audiosToRemove.size) {
      audios = audios.filter((clip) => !audiosToRemove.has(clip));
      audioRowsCache = null;
    }
    if (videosToRemove.size) videos = videos.filter((clip) => !videosToRemove.has(clip));
    if (linkGroups.size) {
      // A linked clip on a different file survives; keep it from pointing at
      // a partner that no longer exists.
      for (const clip of videos) {
        if (!clip.linkGroup || !linkGroups.has(clip.linkGroup)) continue;
        clip.linkGroup = undefined;
        clip.linkOffset = undefined;
      }
      for (const clip of audios) {
        if (clip.linkGroup && linkGroups.has(clip.linkGroup)) clip.linkGroup = undefined;
      }
    }
    const entry = mediaCardEntries.get(asset.id);
    if (entry) {
      pendingMediaThumbs.delete(entry.thumb);
      mediaThumbObserver?.unobserve(entry.thumb);
      entry.card.remove();
      mediaCardEntries.delete(asset.id);
    }
    assets = assets.filter((item) => item !== asset);
    URL.revokeObjectURL(asset.url);
    if (asset.proxyUrl) URL.revokeObjectURL(asset.proxyUrl);
    clearClipSelection();
    renderMediaPool();
    render();
    seek(Math.min(time, timelineEnd()));
    if (!videos.length) {
      preview.removeAttribute('src');
      preview.load();
      previewGain.gain.value = 0;
    }
    commit(`Deleted ${asset.name} and ${count} timeline clip${count === 1 ? '' : 's'}`);
    status.textContent = `Deleted ${asset.name} and ${count} timeline clip${count === 1 ? '' : 's'}.`;
  }

  function addMediaUsageSelect(usages: MediaUsage[]): void {
    const wrap = document.createElement('label');
    wrap.className = 'video-media-usage';
    const caption = document.createElement('span');
    caption.className = 'video-media-usage-label';
    caption.textContent = `Used ${usages.length} times in the timeline`;
    const select = document.createElement('select');
    select.className = 'video-media-usage-select';
    select.setAttribute('aria-label', 'Jump to a timeline usage');
    const placeholder = new Option('Jump to a clip…', '');
    select.append(placeholder);
    for (const [index, usage] of usages.entries()) {
      select.append(new Option(usage.label, String(index)));
    }
    select.value = '';
    select.addEventListener('change', () => {
      const index = Number(select.value);
      if (!Number.isInteger(index) || !usages[index]) return;
      closeTimelineMenu();
      focusMediaUsage(usages[index]);
    });
    wrap.append(caption, select);
    timelineMenu.append(wrap);
  }

  function mediaFilePath(file: File): string {
    const path = (file as File & { path?: unknown }).path;
    return typeof path === 'string' ? path : '';
  }

  function openMediaMenu(asset: MediaAsset, clientX: number, clientY: number): void {
    closeTrackMenu();
    timelineMenu.replaceChildren();
    const usages = mediaUsages(asset);
    const item = timelineMenuItem;
    const separator = timelineMenuSeparator;

    item('Insert at playhead', () => insertAsset(asset));
    if (!usages.length) {
      item('No timeline usage', () => undefined, true);
    } else if (usages.length === 1) {
      item('See usage in timeline', () => focusMediaUsage(usages[0]));
    } else {
      addMediaUsageSelect(usages);
      item('Select all timeline usages', () => selectMediaUsages(asset, usages));
    }
    separator();
    item('Copy file name', () => {
      if (!navigator.clipboard?.writeText) {
        status.textContent = 'Clipboard access is not available in this browser.';
        return;
      }
      void navigator.clipboard.writeText(asset.file.name).then(
        () => { status.textContent = 'File name copied.'; },
        () => { status.textContent = 'Could not copy the file name.'; },
      );
    });
    if (asset.kind === 'video') {
      item(asset.proxy ? 'Remove preview proxy' : 'Create preview proxy', () => {
        if (asset.proxy) clearProxy(asset);
        else void buildProxy(asset);
      }, Boolean(operation) && !asset.proxy);
    }
    const nativePath = mediaFilePath(asset.file);
    const reveal = (window as Window & { showItemInFolder?: (path: string) => void }).showItemInFolder;
    if (nativePath && typeof reveal === 'function') {
      item('Show file location', () => reveal(nativePath));
    } else {
      const location = item('Show file location (not available)', () => undefined, true);
      location.title = 'Browsers do not expose the folder path of imported files.';
    }
    separator();
    const remove = item(
      usages.length
        ? `Remove from media pool (keep ${usages.length} clip${usages.length === 1 ? '' : 's'})`
        : 'Remove media from pool',
      () => removeMediaFromPool(asset),
    );
    remove.title = 'Remove this file from the media pool; timeline clips stay.';
    if (usages.length) {
      const deleteAll = item('Delete media and all timeline clips', () => deleteMediaWithClips(asset));
      deleteAll.title = 'Delete this file and every timeline clip that uses it.';
    }
    placeFloatingMenu(timelineMenu, clientX, clientY);
  }

  function findFreeAudioTrack(start: number, end: number): number {
    for (let track = 0; track < audioTrackCount; track += 1) {
      if (audioTrackLocked(track)) continue;
      const busy = audios.some((clip) => clip.track === track &&
        clip.offset < end - 0.001 &&
        clip.offset + audioClipLength(clip) > start + 0.001);
      if (!busy) return track;
    }
    audioTrackCount += 1;
    while (audioTrackState.length < audioTrackCount) audioTrackState.push({ muted: false, locked: false, solo: false });
    return audioTrackCount - 1;
  }

  function insertAsset(asset: MediaAsset, at = time, track?: number): void {
    const wasEmpty = !videos.length && !audios.length;
    const insertAt = Math.max(0, Math.min(at, playbackEnd()));
    let targetTrack = track;
    if (asset.kind !== 'audio') {
      const selectedVideo = selected?.kind === 'video' ? videos.find((clip) => clip.id === selected!.id) : null;
      targetTrack = Math.max(0, track ?? selectedVideo?.track ?? 0);
      if (targetTrack >= videoTrackCount) {
        videoTrackCount = targetTrack + 1;
        while (videoTrackState.length < videoTrackCount) videoTrackState.push({ hidden: false, muted: false, locked: false, solo: false });
      }
      if (videoTrackLocked(targetTrack)) {
        lockedNotice();
        return;
      }
    }
    if (asset.kind === 'audio') {
      const url = URL.createObjectURL(asset.file);
      const clip: AudioClip = {
        id: ++nextId, file: asset.file, name: asset.name, duration: asset.duration,
        offset: insertAt, trimStart: 0, trimEnd: 0, volume: 1, fadeIn: 0, fadeOut: 0,
        track: findFreeAudioTrack(insertAt, insertAt + asset.duration),
        muted: false, tracks: (asset.probe.audioStreams ?? []).map(describeTrack),
        url, peaks: asset.peaks, ...makeAudio(url),
      };
      audios.push(clip);
      audioRowsCache = null;
      selected = { kind: 'audio', id: clip.id };
    } else {
      const url = URL.createObjectURL(asset.file);
      const duration = asset.kind === 'image' ? Math.max(0.5, asset.duration || IMAGE_SECONDS) : asset.duration;
      const linkedAudio = asset.kind === 'video' && asset.probe.hasAudio;
      const linkGroup = linkedAudio ? ++nextLinkGroup : undefined;
      const clip: VideoClip = {
        id: ++nextId, file: asset.file, name: asset.name, duration,
        start: insertAt, track: targetTrack ?? 0,
        trimStart: 0, trimEnd: 0, image: asset.kind === 'image', audioTrack: 0,
        volume: 1, mute: linkedAudio, transform: { ...DEFAULT_CLIP_TRANSFORM },
        effects: normalizeEffects(), animation: normalizeAnimation(),
        proxy: asset.proxy, proxyUrl: asset.proxyUrl, probe: asset.probe,
        peaks: asset.peaks, url, strip: asset.strip, linkGroup,
      };
      videos.push(clip);
      if (linkedAudio && linkGroup) {
        const audioUrl = URL.createObjectURL(asset.file);
        const audioClip: AudioClip = {
          id: ++nextId, file: asset.file, name: asset.name, duration,
          offset: insertAt, trimStart: 0, trimEnd: 0, volume: 1, fadeIn: 0, fadeOut: 0,
          track: findFreeAudioTrack(insertAt, insertAt + duration),
          tracks: (asset.probe.audioStreams ?? []).map(describeTrack),
          muted: false, linkGroup, url: audioUrl, peaks: asset.peaks, ...makeAudio(audioUrl),
        };
        audios.push(audioClip);
        if (needsEmbeddedAudio(audioClip.file, audioClip.tracks.length)) {
          audioClip.peaks = null;
          loadAudioPeaks(audioClip, new AbortController().signal);
        }
        audioRowsCache = null;
      }
      selected = { kind: 'video', id: clip.id };
      selectedTitle = -1;
      selectedGraphic = -1;
      selectedSubtitleKey = '';
      if (!clip.peaks) loadVideoPeaks(clip, new AbortController().signal);
      if (!clip.strip && !clip.image) {
        void filmstripFor(asset.file, url, duration, asset.key).then((strip) => {
          clip.strip = strip;
          asset.strip = strip;
          asset.stripVersion = FILMSTRIP_CACHE_VERSION;
          render();
          renderMediaPool();
        });
      }
    }
    if (wasEmpty) fitTimeline();
    selectSideTab('clip');
    render();
    seek(insertAt);
    commit('Added to timeline');
  }

  function snapshot(): Snapshot {
    return {
      videos: videos.map(({ id, file, name, duration, start, track, trimStart, trimEnd, image, audioTrack, volume, mute, transform, effects, animation, transition, proxy, probe, peaks, strip, linkGroup, linkOffset, embeddedCaptions }) =>
        ({
          id, file, name, duration, start, track, trimStart, trimEnd, image, audioTrack, volume, mute,
          transform: { ...transform },
          effects: structuredClone(effects),
          animation: normalizeAnimation(animation),
          transition: transition ? { ...transition } : undefined,
          proxy,
          probe, peaks, strip, linkGroup, linkOffset, embeddedCaptions,
        })),
      audios: audios.map(({ id, file, name, duration, offset, trimStart, trimEnd, volume, fadeIn, fadeOut, track, sourceTrack, tracks, muted, peaks, linkGroup, retime }) =>
        ({ id, file, name, duration, offset, trimStart, trimEnd, volume, fadeIn, fadeOut, track, sourceTrack, tracks, muted, peaks, linkGroup, retime })),
      assets: assets.map(({ url: _url, proxyUrl: _proxyUrl, ...asset }) => ({ ...asset })),
      selected: selected ? { ...selected } : null,
      time,
      captionOffset,
      captionSource: captionSource.value,
      captionMode: captionMode.value,
      captionFileName,
      captionTrackState: { ...captionTrackState },
      captionPreset,
      fileCues: fileCues ? fileCues.map((cue) => ({ ...cue })) : null,
      videoTrackCount,
      audioTrackCount,
      videoTrackState: videoTrackState.map((state) => ({ ...state })),
      audioTrackState: audioTrackState.map((state) => ({ ...state })),
      titles: titles.map((cue) => ({ ...cue, style: cue.style ? { ...cue.style } : undefined })),
      graphics: graphics.map((graphic) => ({ ...graphic })),
      cameraCuts: cameraCuts.map((cut) => ({ ...cut })),
      transcriptEdits: transcriptEdits.map((span) => ({ ...span })),
    };
  }

  function signature(state: Snapshot): string {
    return JSON.stringify({
      videos: state.videos.map((clip) => [
        clip.id, clip.name, clip.duration, clip.start, clip.track, clip.trimStart, clip.trimEnd, clip.image,
        clip.audioTrack, clip.volume, clip.mute, clip.probe.videoCodec, clip.probe.width, clip.probe.height,
        hasClipTransform(clip.transform) ? clipTransform(clip.transform) : null,
        JSON.stringify(clip.effects), JSON.stringify(clip.animation),
        clip.transition ? JSON.stringify(clip.transition) : 0, clip.proxy ? 1 : 0, clip.linkGroup ?? 0,
        clip.linkOffset ?? 0, clip.embeddedCaptions?.stream.index, clip.embeddedCaptions?.cues,
        Boolean(clip.embeddedCaptions?.assScript),
      ]),
      audios: state.audios.map((clip) => [
        clip.id, clip.name, clip.duration, clip.offset, clip.trimStart, clip.trimEnd,
        clip.volume, clip.fadeIn, clip.fadeOut, clip.track, clip.sourceTrack, clip.muted, clip.linkGroup ?? 0, clip.retime,
      ]),
      assets: state.assets.map((asset) => [asset.id, asset.key, asset.kind, asset.name]),
      captionOffset: state.captionOffset,
      captionSource: state.captionSource,
      captionMode: state.captionMode,
      captionFileName: state.captionFileName,
      captionTrackState: state.captionTrackState,
      captionPreset: state.captionPreset,
      videoTrackCount: state.videoTrackCount,
      audioTrackCount: state.audioTrackCount,
      videoTrackState: state.videoTrackState,
      audioTrackState: state.audioTrackState,
      titles: state.titles,
      graphics: state.graphics,
      cameraCuts: state.cameraCuts,
      transcriptEdits: state.transcriptEdits,
    });
  }

  function updateHistoryButtons(): void {
    undoButton.disabled = historyIndex <= 0;
    redoButton.disabled = historyIndex < 0 || historyIndex >= history.length - 1;
  }

  function historySeconds(value: number): string {
    return `${Math.max(0, value).toFixed(1)}s`;
  }

  function historyPercent(value: number): string {
    return `${Math.round(value * 100)}%`;
  }

  function historyShort(value: string, max = 26): string {
    const clean = value.replace(/\s+/g, ' ').trim();
    return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
  }

  function historyTrack(index: number): string {
    return `V${Math.max(0, Math.round(index)) + 1}`;
  }

  function graphicHistoryName(graphic: GraphicClip): string {
    if (graphic.kind === 'emoji') return `Emoji ${graphic.emoji ?? ''}`.trim();
    if (graphic.kind === 'svg') return `SVG ${graphic.name ?? 'overlay'}`;
    return graphic.name || graphicLabel(graphic.kind);
  }

  function describeTrackHistory(previous: Snapshot, next: Snapshot): string {
    const videoCount = Math.max(previous.videoTrackState.length, next.videoTrackState.length);
    for (let index = 0; index < videoCount; index += 1) {
      const before = previous.videoTrackState[index];
      const after = next.videoTrackState[index];
      if (!before || !after) continue;
      const label = `V${index + 1}`;
      if ((before.opacity ?? 1) !== (after.opacity ?? 1)) {
        return `${label} opacity ${historyPercent(before.opacity ?? 1)} → ${historyPercent(after.opacity ?? 1)}`;
      }
      if (Boolean(before.hidden) !== Boolean(after.hidden)) {
        return `${label} ${after.hidden ? 'hidden' : 'shown'}`;
      }
      if (Boolean(before.muted) !== Boolean(after.muted)) {
        return `${label} audio ${after.muted ? 'muted' : 'unmuted'}`;
      }
      if (Boolean(before.solo) !== Boolean(after.solo)) {
        return `${label} ${after.solo ? 'soloed' : 'unsoloed'}`;
      }
      if ((before.gain ?? 1) !== (after.gain ?? 1)) {
        return `${label} gain ${historyPercent(before.gain ?? 1)} → ${historyPercent(after.gain ?? 1)}`;
      }
      if (Boolean(before.locked) !== Boolean(after.locked)) {
        return `${label} ${after.locked ? 'locked' : 'unlocked'}`;
      }
      if ((before.color ?? '') !== (after.color ?? '')) return `${label} color changed`;
    }
    const audioCount = Math.max(previous.audioTrackState.length, next.audioTrackState.length);
    for (let index = 0; index < audioCount; index += 1) {
      const before = previous.audioTrackState[index];
      const after = next.audioTrackState[index];
      if (!before || !after) continue;
      const label = `A${index + 1}`;
      if ((before.gain ?? 1) !== (after.gain ?? 1)) {
        return `${label} volume ${historyPercent(before.gain ?? 1)} → ${historyPercent(after.gain ?? 1)}`;
      }
      if (Boolean(before.muted) !== Boolean(after.muted)) {
        return `${label} ${after.muted ? 'muted' : 'unmuted'}`;
      }
      if (Boolean(before.solo) !== Boolean(after.solo)) {
        return `${label} ${after.solo ? 'soloed' : 'unsoloed'}`;
      }
      if (Boolean(before.locked) !== Boolean(after.locked)) {
        return `${label} ${after.locked ? 'locked' : 'unlocked'}`;
      }
      if ((before.color ?? '') !== (after.color ?? '')) return `${label} color changed`;
    }
    return '';
  }

  function describeGraphicHistory(previous: Snapshot, next: Snapshot): string {
    const previousById = new Map(previous.graphics.map((graphic) => [graphic.id, graphic]));
    const nextById = new Map(next.graphics.map((graphic) => [graphic.id, graphic]));
    const added = next.graphics.find((graphic) => !previousById.has(graphic.id));
    if (added) {
      return `${historyShort(graphicHistoryName(added))} · ${historySeconds(added.end - added.start)} · ${historyTrack(graphicTrackIndex(added))}`;
    }
    const removed = previous.graphics.find((graphic) => !nextById.has(graphic.id));
    if (removed) return `${historyShort(graphicHistoryName(removed))} removed`;
    for (const after of next.graphics) {
      const before = previousById.get(after.id);
      if (!before) continue;
      const changes: string[] = [];
      if (Math.round(before.x) !== Math.round(after.x) || Math.round(before.y) !== Math.round(after.y)) {
        changes.push(`move ${Math.round(before.x)}%,${Math.round(before.y)}% → ${Math.round(after.x)}%,${Math.round(after.y)}%`);
      }
      if (Math.round(before.width) !== Math.round(after.width) ||
        Math.round(before.height) !== Math.round(after.height)) {
        changes.push(`resize ${Math.round(before.width)}×${Math.round(before.height)} → ${Math.round(after.width)}×${Math.round(after.height)}%`);
      }
      if (Math.round(before.rotation) !== Math.round(after.rotation)) {
        changes.push(`rotate ${Math.round(before.rotation)}° → ${Math.round(after.rotation)}°`);
      }
      if (Math.round(before.opacity * 100) !== Math.round(after.opacity * 100)) {
        changes.push(`opacity ${historyPercent(before.opacity)} → ${historyPercent(after.opacity)}`);
      }
      if (graphicTrackIndex(before) !== graphicTrackIndex(after)) {
        changes.push(`moved to ${historyTrack(graphicTrackIndex(after))}`);
      }
      if (before.start !== after.start || before.end !== after.end) {
        changes.push(`timing ${formatClock(before.start, true)} → ${formatClock(after.start, true)}`);
      }
      if (before.fill !== after.fill || before.fill2 !== after.fill2 ||
        before.fillType !== after.fillType || before.pattern !== after.pattern ||
        before.emoji !== after.emoji || before.svg !== after.svg) {
        changes.push('appearance changed');
      }
      if (changes.length) return `${historyShort(graphicHistoryName(after), 18)} · ${changes.slice(0, 2).join(' · ')}`;
    }
    return '';
  }

  function describeTitleHistory(previous: Snapshot, next: Snapshot): string {
    const key = (cue: Snapshot['titles'][number]): string =>
      `${cue.text}|${cue.start}|${cue.end}|${titleTrackIndex(cue)}`;
    const previousKeys = new Set(previous.titles.map(key));
    const added = next.titles.find((cue) => !previousKeys.has(key(cue)));
    if (added) {
      return `“${historyShort(added.text, 22)}” · ${historySeconds(added.end - added.start)} · ${historyTrack(titleTrackIndex(added))}`;
    }
    const nextKeys = new Set(next.titles.map(key));
    const removed = previous.titles.find((cue) => !nextKeys.has(key(cue)));
    if (removed) return `“${historyShort(removed.text, 22)}” removed`;
    if (previous.titles.length === next.titles.length) {
      for (let index = 0; index < next.titles.length; index += 1) {
        const before = previous.titles[index];
        const after = next.titles[index];
        if (JSON.stringify(before) !== JSON.stringify(after)) {
          return `“${historyShort(after.text, 22)}” edited`;
        }
      }
    }
    return '';
  }

  function describeEffectChange(before: ClipEffects, after: ClipEffects): string {
    if (before.brightness !== after.brightness) return `brightness ${before.brightness} → ${after.brightness}`;
    if (before.contrast !== after.contrast) return `contrast ${before.contrast} → ${after.contrast}`;
    if (before.saturation !== after.saturation) return `saturation ${before.saturation} → ${after.saturation}`;
    if (before.hue !== after.hue) return `hue ${before.hue}° → ${after.hue}°`;
    if (before.blur !== after.blur) return `blur ${before.blur} → ${after.blur}`;
    if (before.opacity !== after.opacity) return `opacity ${historyPercent(before.opacity)} → ${historyPercent(after.opacity)}`;
    if (before.blend !== after.blend) return `blend ${before.blend} → ${after.blend}`;
    if (before.mask.shape !== after.mask.shape) return `mask ${before.mask.shape} → ${after.mask.shape}`;
    if (before.chroma.enabled !== after.chroma.enabled) return after.chroma.enabled ? 'chroma key on' : 'chroma key off';
    if ((before.lut?.name ?? '') !== (after.lut?.name ?? '')) return after.lut ? `LUT ${after.lut.name}` : 'LUT cleared';
    if (before.curve.shadows !== after.curve.shadows ||
      before.curve.midtones !== after.curve.midtones ||
      before.curve.highlights !== after.curve.highlights) return 'tone curve changed';
    if (before.speed !== after.speed) return `speed ${before.speed}× → ${after.speed}×`;
    return '';
  }

  function describeVideoHistory(previous: Snapshot, next: Snapshot): string {
    const previousById = new Map(previous.videos.map((clip) => [clip.id, clip]));
    const nextById = new Map(next.videos.map((clip) => [clip.id, clip]));
    const added = next.videos.find((clip) => !previousById.has(clip.id));
    if (added) {
      return `${historyShort(added.name, 20)} · ${historySeconds(videoClipLength(added))} · V${added.track + 1}`;
    }
    const removed = previous.videos.find((clip) => !nextById.has(clip.id));
    if (removed) return `${historyShort(removed.name, 20)} removed`;
    for (const after of next.videos) {
      const before = previousById.get(after.id);
      if (!before) continue;
      if (before.start !== after.start) {
        return `${historyShort(after.name, 18)} · moved ${formatClock(before.start, true)} → ${formatClock(after.start, true)}`;
      }
      if (before.trimStart !== after.trimStart || before.trimEnd !== after.trimEnd) {
        const parts: string[] = [];
        if (before.trimStart !== after.trimStart) {
          parts.push(`start ${historySeconds(before.trimStart)} → ${historySeconds(after.trimStart)}`);
        }
        if (before.trimEnd !== after.trimEnd) {
          parts.push(`end ${historySeconds(before.trimEnd)} → ${historySeconds(after.trimEnd)}`);
        }
        return `${historyShort(after.name, 18)} · trim ${parts.join(' / ')}`;
      }
      if (before.track !== after.track) return `${historyShort(after.name, 18)} · moved to V${after.track + 1}`;
      if (before.volume !== after.volume) {
        return `${historyShort(after.name, 18)} · volume ${historyPercent(before.volume)} → ${historyPercent(after.volume)}`;
      }
      if (before.mute !== after.mute) return `${historyShort(after.name, 18)} · ${after.mute ? 'muted' : 'unmuted'}`;
      if ((before.linkGroup ?? 0) !== (after.linkGroup ?? 0)) {
        return `${historyShort(after.name, 18)} · ${after.linkGroup ? 'audio linked' : 'audio unlinked'}`;
      }
      if ((before.linkOffset ?? 0) !== (after.linkOffset ?? 0)) {
        return `${historyShort(after.name, 18)} · audio offset ${historySeconds(after.linkOffset ?? 0)}`;
      }
      if (JSON.stringify(before.transition) !== JSON.stringify(after.transition)) {
        return `${historyShort(after.name, 18)} · ${after.transition ? `${motionTransitionLabel(after.transition)} transition` : 'transition cleared'}`;
      }
      const effect = describeEffectChange(before.effects, after.effects);
      if (effect) return `${historyShort(after.name, 18)} · ${effect}`;
      if (JSON.stringify(before.animation) !== JSON.stringify(after.animation)) {
        return `${historyShort(after.name, 18)} · keyframes updated`;
      }
    }
    return '';
  }

  function describeAudioHistory(previous: Snapshot, next: Snapshot): string {
    const previousById = new Map(previous.audios.map((clip) => [clip.id, clip]));
    const nextById = new Map(next.audios.map((clip) => [clip.id, clip]));
    const added = next.audios.find((clip) => !previousById.has(clip.id));
    if (added) {
      return `${historyShort(added.name, 20)} · ${historySeconds(audioClipLength(added))} · A${added.track + 1}`;
    }
    const removed = previous.audios.find((clip) => !nextById.has(clip.id));
    if (removed) return `${historyShort(removed.name, 20)} removed`;
    for (const after of next.audios) {
      const before = previousById.get(after.id);
      if (!before) continue;
      if (before.offset !== after.offset) {
        return `${historyShort(after.name, 18)} · moved ${formatClock(before.offset, true)} → ${formatClock(after.offset, true)}`;
      }
      if (before.trimStart !== after.trimStart || before.trimEnd !== after.trimEnd) {
        return `${historyShort(after.name, 18)} · trimmed`;
      }
      if (before.track !== after.track) return `${historyShort(after.name, 18)} · moved to A${after.track + 1}`;
      if (before.volume !== after.volume) {
        return `${historyShort(after.name, 18)} · volume ${historyPercent(before.volume)} → ${historyPercent(after.volume)}`;
      }
      if (before.muted !== after.muted) return `${historyShort(after.name, 18)} · ${after.muted ? 'muted' : 'unmuted'}`;
      if (before.fadeIn !== after.fadeIn || before.fadeOut !== after.fadeOut) {
        return `${historyShort(after.name, 18)} · fades ${historySeconds(before.fadeIn)}/${historySeconds(before.fadeOut)} → ${historySeconds(after.fadeIn)}/${historySeconds(after.fadeOut)}`;
      }
    }
    return '';
  }

  function describeAssetHistory(previous: Snapshot, next: Snapshot): string {
    const previousIds = new Set(previous.assets.map((asset) => asset.id));
    const nextIds = new Set(next.assets.map((asset) => asset.id));
    const added = next.assets.find((asset) => !previousIds.has(asset.id));
    if (added) return `${historyShort(added.name, 20)} added to media pool`;
    const removed = previous.assets.find((asset) => !nextIds.has(asset.id));
    if (removed) return `${historyShort(removed.name, 20)} removed from media pool`;
    return '';
  }

  function describeHistory(previous: Snapshot | undefined, next: Snapshot): string {
    if (!previous) return '';
    return describeTrackHistory(previous, next) ||
      describeGraphicHistory(previous, next) ||
      describeTitleHistory(previous, next) ||
      describeVideoHistory(previous, next) ||
      describeAudioHistory(previous, next) ||
      describeAssetHistory(previous, next);
  }

  function commit(label = ''): void {
    if (restoring) return;
    invalidateTimelineDerived();
    invalidateFingerprint();
    const previous = historyIndex >= 0 ? history[historyIndex] : undefined;
    const state = snapshot();
    const stateSignature = signature(state);
    if (previous && signature(previous) === stateSignature) {
      updateHistoryButtons();
      return;
    }
    const detail = describeHistory(previous, state);
    history = history.slice(0, historyIndex + 1);
    historyLabels = historyLabels.slice(0, historyIndex + 1);
    historyDetails = historyDetails.slice(0, historyIndex + 1);
    historySizes = historySizes.slice(0, historyIndex + 1);
    historyBytesTotal = historySizes.reduce((sum, size) => sum + size, 0);
    history.push(state);
    historyLabels.push(label || 'Edit');
    historyDetails.push(detail);
    historySizes.push(stateSignature.length * 2);
    historyBytesTotal += stateSignature.length * 2;
    while (
      history.length > 1 &&
      (history.length > MAX_HISTORY || (history.length > 2 && historyBytesTotal > MAX_HISTORY_BYTES))
    ) {
      history.shift();
      historyLabels.shift();
      historyDetails.shift();
      historyBytesTotal -= historySizes.shift() ?? 0;
    }
    historyIndex = history.length - 1;
    updateHistoryButtons();
    updateProjectBar();
    renderHistoryPanel();
    scheduleAutosave();
    scheduleAudioMix();
  }

  function restore(state: Snapshot): void {
    restoring = true;
    pause();
    // A snapshot taken before a filmstrip or waveform finished building holds
    // null for it. Keep whatever the current session has already built, keyed
    // by media, so undo never drops thumbnails.
    const builtStrips = new Map<string, Strip>();
    const builtPeaks = new Map<string, VideoClip['peaks']>();
    for (const asset of assets) {
      if (asset.strip && asset.kind !== 'image') builtStrips.set(asset.key, asset.strip);
      if (asset.peaks) builtPeaks.set(asset.key, asset.peaks);
    }
    for (const clip of videos) {
      const key = mediaKey(clip.file);
      if (clip.strip && !clip.image && !builtStrips.has(key)) builtStrips.set(key, clip.strip);
      if (clip.peaks && !builtPeaks.has(key)) builtPeaks.set(key, clip.peaks);
    }
    for (const clip of videos) {
      URL.revokeObjectURL(clip.url);
      if (clip.proxyUrl) URL.revokeObjectURL(clip.proxyUrl);
    }
    for (const clip of audios) {
      disposeAudio(clip);
      URL.revokeObjectURL(clip.url);
    }
    for (const asset of assets) {
      URL.revokeObjectURL(asset.url);
      if (asset.proxyUrl) URL.revokeObjectURL(asset.proxyUrl);
    }
    assets = (state.assets ?? []).map((asset) => {
      const url = URL.createObjectURL(asset.file);
      return {
        ...asset,
        url,
        strip: asset.kind === 'image' ? url : asset.strip ?? builtStrips.get(asset.key) ?? null,
        peaks: asset.peaks ?? builtPeaks.get(asset.key) ?? asset.peaks,
        proxyUrl: asset.proxy ? URL.createObjectURL(asset.proxy.blob) : '',
      };
    });
    videos = state.videos.map((clip) => {
      const key = mediaKey(clip.file);
      const asset = assets.find((entry) => entry.key === key);
      const url = URL.createObjectURL(clip.file);
      return {
        ...clip,
        transform: clipTransform(clip.transform),
        effects: normalizeEffects(clip.effects),
        animation: normalizeAnimation(clip.animation),
        proxy: clip.proxy,
        proxyUrl: clip.proxy ? URL.createObjectURL(clip.proxy.blob) : '',
        url,
        strip: asset?.kind === 'image' ? asset.url : clip.image ? url : clip.strip ?? builtStrips.get(key) ?? null,
        peaks: clip.peaks ?? builtPeaks.get(key) ?? null,
      };
    });
    videoTrackCount = Math.max(1, state.videoTrackCount, ...videos.map((clip) => clip.track + 1));
    audioTrackCount = Math.max(1, state.audioTrackCount ?? 0);
    videoTrackState = state.videoTrackState.map((entry) => ({ ...entry }));
    while (videoTrackState.length < videoTrackCount) videoTrackState.push({ hidden: false, muted: false, locked: false, solo: false });
    audioTrackState = state.audioTrackState.map((entry) => ({ ...entry }));
    titles = (state.titles ?? []).map((cue) => ({
      ...cue,
      style: cue.style ? { ...cue.style } : undefined,
    }));
    graphics = (state.graphics ?? []).map((graphic) => sanitizeGraphic(graphic));
    cameraCuts = (state.cameraCuts ?? []).map((cut) => ({ ...cut }));
    normalizeOverlayTracks();
    selectedTitle = -1;
    selectedSubtitleKey = '';
    selectedGraphic = -1;
    transcriptEdits = state.transcriptEdits.map((span) => ({ ...span }));
    mergeTranscriptEdits();
    audios = state.audios.map((clip) => {
      const url = URL.createObjectURL(clip.file);
      return { ...clip, sourceTrack: restoreSourceTrack(clip), url, ...makeAudio(url) };
    });
    for (const clip of videos) if (clip.effects.speed !== 1 || clip.effects.speedPoints?.length) syncRetimeAudio(clip);
    selected = state.selected ? { ...state.selected } : null;
    time = state.time;
    captionOffset = state.captionOffset;
    captionOffsetInput.value = String(captionOffset);
    captionSource.value = state.captionSource;
    captionMode.value = state.captionMode;
    captionFileName = state.captionFileName;
    captionTrackState = { hidden: false, locked: false, ...state.captionTrackState };
    captionPreset = normalizeCaptionPreset(state.captionPreset);
    fileCues = state.fileCues ? state.fileCues.map((cue) => ({ ...cue })) : null;
    invalidateShiftedCues();
    captionLaneKey = '';
    graphicsPreviewKey = '';
    textPreviewKey = '';
    nextId = Math.max(0, ...videos.map((clip) => clip.id), ...audios.map((clip) => clip.id), ...graphics.map((graphic) => graphic.id)) + 1;
    nextAssetId = Math.max(0, ...assets.map((asset) => asset.id)) + 1;
    nextLinkGroup = Math.max(0, ...videos.map((clip) => clip.linkGroup ?? 0), ...audios.map((clip) => clip.linkGroup ?? 0)) + 1;
    activeVideo = null;
    preview.pause();
    preview.removeAttribute('src');
    preview.load();
    previewGain.gain.value = 0;
    renderMediaPool();
    render();
    seek(Math.min(time, timelineEnd()));
    restoring = false;
    // Anything still missing (built in no snapshot and not in memory) is
    // queued again rather than left as a flat block.
    refreshSavedThumbnails();
    for (const clip of videos) {
      if (!clip.image && !clip.peaks && clip.probe?.hasAudio) loadVideoPeaks(clip, new AbortController().signal);
    }
    scheduleAudioMix();
    updateHistoryButtons();
    if (captionSource.value === 'embedded') updateCaptions();
  }

  function undo(): void {
    if (historyIndex <= 0) return;
    historyIndex -= 1;
    restore(history[historyIndex]);
    status.textContent = 'Undone.';
  }

  function redo(): void {
    if (historyIndex < 0 || historyIndex >= history.length - 1) return;
    historyIndex += 1;
    restore(history[historyIndex]);
    status.textContent = 'Redone.';
  }

  // Progress ---------------------------------------------------------------
  const transfer = new TransferMeter();
  const work = new WorkMeter();
  let kind: 'bytes' | 'work' | 'none' = 'none';
  function bar(percent: number | null): void {
    progressBar.classList.toggle('progress-indeterminate', percent === null);
    progressBar.style.width = (percent ?? 100) + '%';
    progressBar.setAttribute('aria-valuenow', String(Math.round(percent ?? 0)));
  }
  function showProgress(label: string, sub = ''): void {
    progressBox.classList.remove('hidden');
    progressLabel.textContent = label;
    progressDetail.textContent = '';
    progressSub.textContent = sub;
    kind = 'none';
    bar(null);
  }
  let jobLabel = '';
  ffmpeg.onLoad(({ loaded, total }) => {
    if (!operation) return;
    if (loaded >= total) {
      showProgress(jobLabel);
      return;
    }
    if (kind !== 'bytes') transfer.reset();
    kind = 'bytes';
    progressBox.classList.remove('hidden');
    progressLabel.textContent = 'Loading the video engine';
    progressDetail.textContent = transfer.describe(loaded, total);
    progressSub.textContent = 'First use only · cached afterwards';
    bar((loaded / total) * 100);
  });

  async function run(label: string, action: (signal: AbortSignal) => Promise<void>): Promise<void> {
    if (operation) return;
    cancelAutoProxy();
    const controller = new AbortController();
    operation = controller;
    status.textContent = '';
    jobLabel = label;
    showProgress(label);
    update();
    try {
      await action(controller.signal);
    } catch (error) {
      status.textContent = isAbortError(error) ? 'Cancelled.' : errorMessage(error);
    } finally {
      operation = null;
      progressBox.classList.add('hidden');
      update();
      scheduleAutoProxy();
      queueMicrotask(checkPreviewCompatibility);
    }
  }
  cancel.addEventListener('click', () => {
    operation?.abort();
    progressLabel.textContent = 'Cancelling…';
  });

  // Adding media -------------------------------------------------------------
  let importDecorationFrame = 0;
  function scheduleImportedDecorations(): void {
    if (importDecorationFrame) return;
    importDecorationFrame = requestAnimationFrame(() => {
      importDecorationFrame = 0;
      renderTimeline();
      renderMediaPool();
    });
  }

  async function addVideos(files: File[]): Promise<void> {
    await run('Reading video…', async (signal) => {
      const wasEmpty = !videos.length && !audios.length;
      let nextStart = totalVideo();
      const probes = new Map<number, Promise<MediaProbe | null>>();
      const prefetchProbe = (index: number): void => {
        if (index < files.length) {
          probes.set(index, sharedMedia().probe(files[index], signal).catch(() => null));
        }
      };
      prefetchProbe(0);
      prefetchProbe(1);
      for (const [i, file] of files.entries()) {
        progressLabel.textContent = `Reading ${file.name}`;
        progressDetail.textContent = `${i + 1} of ${files.length}`;
        const url = URL.createObjectURL(file);
        let probe = await probes.get(i) ?? null;
        probes.delete(i);
        signal.throwIfAborted();
        prefetchProbe(i + 2);
        const meta = probe
          ? { duration: probe.duration, width: probe.width, height: probe.height }
          : await readMetadata(url, 'video');
        const duration = probe?.duration || meta.duration;
        if (!probe?.hasVideo && !meta.width) {
          URL.revokeObjectURL(url);
          throw new Error(`${file.name} has no video track. Add it as audio instead.`);
        }
        if (!duration) {
          URL.revokeObjectURL(url);
          throw new Error(`Could not read the length of ${file.name}.`);
        }
        if (!probe) probe = probeFallback(meta.duration, true);
        if (!probe.width) Object.assign(probe, { width: meta.width, height: meta.height });
        signal.throwIfAborted();
        const linkGroup = probe.hasAudio ? ++nextLinkGroup : undefined;
        const clip: VideoClip = {
          id: ++nextId, file, name: file.name, duration, start: nextStart, track: 0,
          trimStart: 0, trimEnd: 0, image: false, audioTrack: 0, volume: 1, mute: Boolean(linkGroup),
          transform: { ...DEFAULT_CLIP_TRANSFORM },
          effects: normalizeEffects(), animation: normalizeAnimation(),
          proxy: null, proxyUrl: '', probe, peaks: null, url, strip: null, linkGroup,
        };
        const asset = addAsset(file, 'video', duration, probe);
        clip.proxy = asset.proxy;
        clip.proxyUrl = asset.proxyUrl;
        nextStart += duration;
        if (asset.peaks) clip.peaks = asset.peaks;
        videos.push(clip);
        if (linkGroup) {
          const audioUrl = URL.createObjectURL(file);
          const audioClip: AudioClip = {
            id: ++nextId, file, name: file.name, duration,
            offset: clip.start, trimStart: 0, trimEnd: 0, volume: 1, fadeIn: 0, fadeOut: 0,
            track: findFreeAudioTrack(clip.start, clip.start + duration),
            tracks: (probe.audioStreams ?? []).map(describeTrack),
            muted: false, linkGroup, url: audioUrl, peaks: asset.peaks, ...makeAudio(audioUrl),
          };
          audios.push(audioClip);
          if (needsEmbeddedAudio(audioClip.file, audioClip.tracks.length)) {
            audioClip.peaks = null;
            loadAudioPeaks(audioClip, new AbortController().signal);
          }
          audioRowsCache = null;
        }
        selected = { kind: 'video', id: clip.id };
        selectedTitle = -1;
        selectedGraphic = -1;
        selectedSubtitleKey = '';
        if (!clip.peaks) loadVideoPeaks(clip, signal);
        if (i === 0 && wasEmpty) {
          render();
          seekLight(0);
        } else {
          scheduleImportedDecorations();
        }
        void filmstripFor(file, url, duration, asset.key).then((strip) => {
          if (!strip || !assets.includes(asset)) return;
          asset.strip = strip;
          asset.stripVersion = FILMSTRIP_CACHE_VERSION;
          for (const item of videos) {
            if (item.file === file || mediaKey(item.file) === asset.key) item.strip = strip;
          }
          scheduleImportedDecorations();
        });
      }
      if (wasEmpty) {
        fitTimeline();
        render();
        seek(0);
      } else {
        render();
      }
      commit('Added video');
      renderMediaPool();
      status.textContent = audios.length ? 'Video added.' : 'Video added. Now add audio, or add more videos to join them.';
    });
  }

  async function addImages(files: File[]): Promise<void> {
    await run('Reading images…', async () => {
      const wasEmpty = !videos.length && !audios.length;
      let nextStart = totalVideo();
      for (const file of files) {
        const url = URL.createObjectURL(file);
        const bitmap = await createImageBitmap(file).catch(() => null);
        if (!bitmap) {
          URL.revokeObjectURL(url);
          throw new Error(`${file.name} is not an image this browser can read.`);
        }
        // Default a lone still to the length of the audio, for podcast-style videos.
        const longest = Math.max(0, ...audios.map((clip) => clip.offset + audioClipLength(clip)));
        const duration = !videos.length && longest > 0 ? longest : IMAGE_SECONDS;
        const probe: MediaProbe = { ...probeFallback(duration, true), hasAudio: false, width: bitmap.width, height: bitmap.height };
        bitmap.close();
        const asset = addAsset(file, 'image', duration, probe);
        asset.strip = asset.url;
        asset.stripVersion = FILMSTRIP_CACHE_VERSION;
        const clip: VideoClip = {
          id: ++nextId, file, name: file.name, duration, start: nextStart, track: 0,
          trimStart: 0, trimEnd: 0, image: true, audioTrack: 0, volume: 1, mute: false,
          transform: { ...DEFAULT_CLIP_TRANSFORM },
          effects: normalizeEffects(), animation: normalizeAnimation(),
          proxy: null, proxyUrl: '', probe, peaks: null, url, strip: asset.url,
        };
        nextStart += duration;
        videos.push(clip);
        selected = { kind: 'video', id: clip.id };
        selectedTitle = -1;
        selectedGraphic = -1;
        selectedSubtitleKey = '';
      }
      if (wasEmpty) fitTimeline();
      render();
      seek(wasEmpty ? 0 : time);
      commit('Added image');
      renderMediaPool();
      status.textContent = 'Image added. Set how long it shows in the panel on the right.';
    });
  }

  let peaksWorker: Worker | null = null;
  function peaksWorkerFor(): Worker | null {
    if (typeof Worker === 'undefined') return null;
    if (peaksWorker) return peaksWorker;
    const source = `self.onmessage = (event) => {
      const { channels, length, buckets } = event.data;
      const count = Math.max(1, Math.min(buckets, length));
      const size = length / count;
      const peaks = new Float32Array(count);
      for (const data of channels) {
        for (let bucket = 0; bucket < count; bucket += 1) {
          const start = Math.floor(bucket * size);
          const end = Math.min(length, Math.floor((bucket + 1) * size));
          let peak = peaks[bucket];
          for (let index = start; index < end; index += 4) {
            const value = Math.abs(data[index]);
            if (value > peak) peak = value;
          }
          peaks[bucket] = peak;
        }
      }
      self.postMessage(peaks, [peaks.buffer]);
    };`;
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    peaksWorker = new Worker(url);
    return peaksWorker;
  }

  function workerPeaks(buffer: AudioBuffer, buckets: number): Promise<Float32Array | null> {
    const worker = peaksWorkerFor();
    if (!worker) return Promise.resolve(bufferPeaks(buffer, buckets));
    const channels = Array.from(
      { length: buffer.numberOfChannels },
      (_, index) => buffer.getChannelData(index),
    );
    return new Promise((resolve) => {
      const finish = (value: Float32Array | null): void => {
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
        resolve(value);
      };
      const onMessage = (event: MessageEvent<Float32Array>): void => finish(event.data);
      const onError = (): void => {
        worker.terminate();
        peaksWorker = null;
        finish(null);
      };
      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onError);
      worker.postMessage(
        { channels, length: buffer.length, buckets },
        channels.map((channel) => channel.buffer),
      );
    });
  }

  async function decodePeaks(file: File, signal: AbortSignal, duration = 0): Promise<Float32Array | null> {
    const buckets = peakBucketCount(duration);
    try {
      const { streamAudioPeaks } = await import('./mediabunny-engine');
      const peaks = await streamAudioPeaks(file, buckets, signal);
      if (peaks) return peaks;
    } catch (error) {
      if (isAbortError(error)) throw error;
    }
    // The streaming path above handles large files without loading them into
    // memory. Only the Web Audio fallback needs a size guard.
    if (file.size > 400_000_000) return null;
    try {
      const buffer = await audioContext().decodeAudioData(await file.arrayBuffer());
      signal.throwIfAborted();
      if (buffer.length * buffer.numberOfChannels < 20_000_000) return bufferPeaks(buffer, buckets);
      const peaks = await workerPeaks(buffer, buckets);
      signal.throwIfAborted();
      return peaks;
    } catch (error) {
      if (isAbortError(error)) throw error;
      return null;
    }
  }

  let peaksActive = 0;
  const peaksQueue: Array<() => void> = [];
  const peaksJobs = new Map<string, Promise<Float32Array | null>>();
  const peaksPending = new Set<string>();

  function peaksPendingFor(file: File): boolean {
    const prefix = `${mediaKey(file)}:`;
    for (const key of peaksPending) if (key.startsWith(prefix)) return true;
    return false;
  }

  function queuePeaks<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = (): void => {
        peaksActive += 1;
        task().then(resolve, reject).finally(() => {
          peaksActive -= 1;
          peaksQueue.shift()?.();
        });
      };
      if (peaksActive < 1) start();
      else peaksQueue.push(start);
    });
  }

  function peaksFor(file: File, signal: AbortSignal, duration = 0): Promise<Float32Array | null> {
    const buckets = peakBucketCount(duration);
    const key = `${mediaKey(file)}:${buckets}`;
    const existing = peaksJobs.get(key);
    if (existing) return existing;
    const job = queuePeaks(async () => {
      const cacheKey = `peaks:${key}`;
      const cached = await readCachedAsset<Float32Array>(cacheKey);
      if (cached) return cached;
      const peaks = await decodePeaks(file, signal, duration);
      if (peaks) void writeCachedAsset(cacheKey, peaks);
      return peaks;
    });
    peaksPending.add(key);
    refreshWaveLoading(mediaKey(file));
    peaksJobs.set(key, job);
    void job.finally(() => {
      peaksJobs.delete(key);
      peaksPending.delete(key);
      refreshWaveLoading(mediaKey(file));
    }).catch(() => undefined);
    return job;
  }

  /** Read a video file's own audio into peaks for its timeline waveform. */
  function loadVideoPeaks(clip: VideoClip, signal: AbortSignal): void {
    if (clip.image || !clip.probe.hasAudio) return;
    if (clip.peaks && clip.peaks.length >= MIN_PEAK_BUCKETS) return;
    void peaksFor(clip.file, signal, clip.duration).then((peaks) => {
      if (!peaks || !videos.includes(clip)) return;
      clip.peaks = peaks;
      const linkedAudio = linkedAudioFor(clip);
      if (linkedAudio && !needsEmbeddedAudio(linkedAudio.file, linkedAudio.tracks.length)) linkedAudio.peaks = peaks;
      const asset = assets.find((entry) => entry.key === mediaKey(clip.file));
      if (asset) asset.peaks = peaks;
      scheduleImportedDecorations();
    }).catch(() => undefined);
  }

  /** Upgrade old low-resolution audio peaks after a project is opened. */
  function loadAudioPeaks(clip: AudioClip, signal: AbortSignal): void {
    if (clip.peaks && clip.peaks.length >= MIN_PEAK_BUCKETS) return;
    const index = clip.sourceTrack ?? 0;
    const original = clip.file;
    void previewAudioFile(clip).then((file) => peaksFor(file, signal, clip.duration)).then((peaks) => {
      if (!peaks || !audios.includes(clip) || clip.file !== original || (clip.sourceTrack ?? 0) !== index) return;
      clip.peaks = peaks;
      const asset = index === 0 ? assets.find((entry) => entry.key === mediaKey(clip.file)) : null;
      if (asset) asset.peaks = peaks;
      scheduleImportedDecorations();
    }).catch(() => undefined);
  }

  async function addAudios(files: File[]): Promise<void> {
    await run('Reading audio…', async (signal) => {
      const wasEmpty = !videos.length && !audios.length;
      for (const [i, file] of files.entries()) {
        progressLabel.textContent = `Reading ${file.name}`;
        progressDetail.textContent = `${i + 1} of ${files.length}`;
        const url = URL.createObjectURL(file);
        let probe: MediaProbe | null = null;
        try {
          probe = await sharedMedia().probe(file, signal);
        } catch (error) {
          if (isAbortError(error)) throw error;
        }
        let duration = probe?.duration ?? 0;
        if (!duration) duration = (await readMetadata(url, 'audio')).duration;
        if (!duration || (probe && !probe.hasAudio)) {
          URL.revokeObjectURL(url);
          throw new Error(`${file.name} has no readable audio.`);
        }
        const peaks = await decodePeaks(file, signal, duration);
        signal.throwIfAborted();
        // Append after the existing audio. With no video yet, do not clamp to 0.
        const lastEnd = Math.max(0, ...audios.map((clip) => clip.offset + audioClipLength(clip)));
        const offset = audios.length ? (videos.length ? Math.min(totalVideo(), lastEnd) : lastEnd) : 0;
        const clip: AudioClip = {
          id: ++nextId, file, name: file.name, duration, offset, trimStart: 0, trimEnd: 0,
          volume: 1, fadeIn: 0, fadeOut: 0,
          track: findFreeAudioTrack(offset, offset + duration),
          muted: false,
          tracks: (probe?.audioStreams ?? []).map(describeTrack),
          url, peaks, ...makeAudio(url),
        };
        audios.push(clip);
        audioRowsCache = null;
        addAsset(file, 'audio', duration, probe ?? probeFallback(duration, false), null, peaks);
        selected = { kind: 'audio', id: clip.id };
      }
      // The image-first podcast flow: a lone cover should grow to the audio.
      const audioEnd = Math.max(0, ...audios.map((clip) => clip.offset + audioClipLength(clip)));
      if (videos.length && videos.every((clip) => clip.image)) {
        const last = videos[videos.length - 1];
        if (last.start + last.duration + 0.05 < audioEnd) {
          last.duration = Math.max(0.5, audioEnd - last.start);
          render();
        }
      }
      if (wasEmpty) fitTimeline();
      render();
      commit('Added audio');
      renderMediaPool();
      status.textContent = 'Audio added. Drag it on the timeline to move it, or drag its edges to trim.';
    });
  }

  const takeFiles = (input: HTMLInputElement) => {
    const files = Array.from(input.files ?? []);
    input.value = '';
    return files;
  };
  mediaInput.addEventListener('change', () => {
    const files = takeFiles(mediaInput);
    if (files.length) void addFiles(files);
  });

  const isVideo = (file: File) => file.type.startsWith('video/') || /\.(mp4|m4v|mov|qt|mkv|webm|avi|wmv|asf|flv|f4v|3gp|3g2|ts|mts|m2ts|mpg|mpeg|vob|mxf|ogv|dv)$/i.test(file.name);
  const isImage = (file: File) => file.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp|avif|heic|heif|tiff?|svg)$/i.test(file.name);
  const isAudio = (file: File) => file.type.startsWith('audio/') || /\.(mp3|wav|m4a|m4b|m4r|aac|flac|ogg|oga|opus|wma|aif|aiff|caf|amr|ac3|mka|mp2|weba|ra|au|snd|dts|ape|wv)$/i.test(file.name);
  const isCaption = (file: File) => /\.(srt|vtt)$/i.test(file.name);
  const isSupportedFile = (file: File) => isVideo(file) || isImage(file) || isAudio(file) || isCaption(file);
  // MIME types the browser may report while a supported file is being dragged.
  const dragMimeTypes = new Set(['text/plain', 'text/vtt', 'application/x-subrip', 'application/x-srt']);
  const dragHasSupportedFiles = (event: DragEvent): boolean => {
    const data = event.dataTransfer;
    if (!data?.types.includes('Files')) return false;
    const items = Array.from(data.items ?? []).filter((item) => item.kind === 'file');
    // Some platforms hide the MIME type until drop, so let those through.
    if (!items.length) return true;
    return items.some((item) => {
      const type = item.type.toLowerCase();
      return !type || type === 'application/octet-stream' ||
        type.startsWith('video/') || type.startsWith('audio/') || type.startsWith('image/') ||
        dragMimeTypes.has(type);
    });
  };

  /** Route dropped or opened files to the right lane. */
  async function addFiles(files: File[], lane: 'video' | 'audio' | null = null): Promise<void> {
    if (!files.length) return;
    const supported = files.filter(isSupportedFile);
    const skipped = files.length - supported.length;
    if (!supported.length) {
      status.textContent = 'Unsupported file type. Add video, audio, images, or .srt/.vtt captions.';
      return;
    }
    const captions = supported.filter(isCaption);
    const images = supported.filter(isImage);
    const rest = supported.filter((file) => !isCaption(file) && !isImage(file));
    const videoFiles = rest.filter((file) => lane !== 'audio' && isVideo(file));
    const audioFiles = rest.filter((file) => !videoFiles.includes(file) && isAudio(file));
    if (videoFiles.length) await addVideos(videoFiles);
    if (images.length) await addImages(images);
    if (audioFiles.length) await addAudios(audioFiles);
    if (captions.length) await loadCaptionFile(captions[0]);
    if (skipped) {
      const note = `Skipped ${skipped} unsupported file${skipped === 1 ? '' : 's'}.`;
      status.textContent = status.textContent ? `${status.textContent} ${note}` : note;
    }
  }

  // Drag files in: videos go to the video lane, audio files to the audio lane.
  let dragDepth = 0;
  root.addEventListener('dragenter', (event) => {
    if (!dragHasSupportedFiles(event)) return;
    dragDepth += 1;
    root.classList.add('video-dragging');
  });
  root.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) root.classList.remove('video-dragging');
  });
  root.addEventListener('dragover', (event) => {
    const files = event.dataTransfer?.types.includes('Files') ?? false;
    if (files || event.dataTransfer?.types.includes('application/x-video-asset')) {
      event.preventDefault();
      if (files && event.dataTransfer) {
        event.dataTransfer.dropEffect = dragHasSupportedFiles(event) ? 'copy' : 'none';
      }
    }
  });
  root.addEventListener('drop', (event) => {
    const assetId = Number(event.dataTransfer?.getData('application/x-video-asset'));
    if (assetId) {
      if (!(event.target instanceof Element) || !event.target.closest('#video-timeline-box')) return;
      event.preventDefault();
      event.stopPropagation();
      const asset = assets.find((entry) => entry.id === assetId);
      if (asset) {
        const bounds = content.getBoundingClientRect();
        const at = Math.max(0, (event.clientX - bounds.left) / pps());
        const laneTop = videoLane.getBoundingClientRect().top + trackTopPad();
        const track = asset.kind === 'audio'
          ? undefined
          : Math.min(
            videoTrackCount - 1,
            trackAtOffset(event.clientY - laneTop, videoTrackHeights, videoRowHeight(), videoTrackCount),
          );
        insertAsset(asset, at, track);
      }
      return;
    }
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (!files.length) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepth = 0;
    root.classList.remove('video-dragging');
    const target = event.target instanceof Element ? event.target as HTMLElement : null;
    if (!target) return;
    const lane = target.closest('[data-drop="audio"], #video-lane-audio') ? 'audio'
      : target.closest('[data-drop="video"], #video-lane-video') ? 'video' : null;
    void addFiles(files, lane);
  });

  // Timeline rendering --------------------------------------------------------
  function audioRows(): Map<number, number> {
    if (audioRowsCache) return audioRowsCache;
    const rows = new Map<number, number>();
    for (const clip of audios) {
      const row = Math.max(0, Math.round(clip.track || 0));
      if (row >= audioTrackCount) {
        audioTrackCount = row + 1;
        while (audioTrackState.length < audioTrackCount) audioTrackState.push({ muted: false, locked: false, solo: false });
      }
      rows.set(clip.id, row);
    }
    audioRowsCache = rows;
    return rows;
  }

  function linkedAudioFor(video: VideoClip): AudioClip | null {
    if (!video.linkGroup) return null;
    return audios.find((clip) => clip.linkGroup === video.linkGroup) ?? null;
  }

  function linkedVideoFor(audio: AudioClip): VideoClip | null {
    if (!audio.linkGroup) return null;
    return videos.find((clip) => clip.linkGroup === audio.linkGroup) ?? null;
  }

  function sameMediaSource(video: VideoClip, audio: AudioClip): boolean {
    return mediaKey(video.file) === mediaKey(audio.file);
  }

  function linkOffsetOf(video: VideoClip): number {
    return Number.isFinite(video.linkOffset) ? video.linkOffset! : 0;
  }

  /** Extracted soundtracks follow video trims; manually grouped audio keeps its own cut. */
  function followsVideoEdits(video: VideoClip, audio: AudioClip): boolean {
    return sameMediaSource(video, audio) && Math.abs(linkOffsetOf(video)) < 0.001;
  }

  function syncRetimeAudio(video: VideoClip): void {
    const audio = linkedAudioFor(video);
    if (!audio || !followsVideoEdits(video, audio)) return;
    const { speed, speedPoints } = video.effects;
    audio.retime = speed === 1 && !speedPoints?.length ? undefined : { speed, speedPoints };
  }

  function speedEditLocked(clip: VideoClip): boolean {
    const audio = linkedAudioFor(clip);
    return videoClipLocked(clip) || Boolean(audio && followsVideoEdits(clip, audio) && audioClipLocked(audio));
  }

  function speedKeys(clip: VideoClip): NonNullable<KeyframeClip['animation']['speed']> {
    return clipSpeedSpans(clip).map((span) => ({ at: span.start, value: span.rate, easing: 'hold' }));
  }

  function changeClipSpeed(clip: VideoClip, rate: number): void {
    if (speedEditLocked(clip)) {
      lockedNotice();
      return;
    }
    const speed = normalizeSpeed(rate);
    const points = clip.effects.speedPoints;
    if (points?.length && clip.trimStart > 0) {
      clip.effects.speedPoints = normalizeSpeedPoints([...points, { source: clip.trimStart, rate: speed }]);
    } else {
      clip.effects.speed = speed;
      clip.effects.speedPoints = normalizeSpeedPoints(points?.filter(({ source }) => source > 0.000001));
    }
    syncRetimeAudio(clip);
    render();
    seek(time, false);
    commit('Changed clip speed');
  }

  function syncLinkedAudioFromVideo(video: VideoClip): void {
    if (!linkClipsEnabled) return;
    const audio = linkedAudioFor(video);
    if (!audio) return;
    audio.offset = Math.max(0, video.start + linkOffsetOf(video));
    if (followsVideoEdits(video, audio)) {
      audio.trimStart = video.trimStart;
      audio.trimEnd = video.trimEnd;
      syncRetimeAudio(video);
    }
  }

  function syncLinkedVideoFromAudio(audio: AudioClip): void {
    if (!linkClipsEnabled) return;
    const video = linkedVideoFor(audio);
    if (!video) return;
    video.start = Math.max(0, audio.offset - linkOffsetOf(video));
    if (followsVideoEdits(video, audio)) {
      video.trimStart = audio.trimStart;
      video.trimEnd = audio.trimEnd;
    }
  }

  function videoSyncOffset(video: VideoClip): number | null {
    const audio = linkedAudioFor(video);
    if (!audio) return null;
    const start = audio.offset - (video.start + linkOffsetOf(video));
    if (Math.abs(start) > 0.02) return start;
    if (!followsVideoEdits(video, audio)) return 0;
    const end = (audio.offset + audioClipLength(audio)) - (video.start + videoClipLength(video));
    return Math.abs(end) > 0.02 ? end : 0;
  }

  function audioSyncOffset(audio: AudioClip): number | null {
    const video = linkedVideoFor(audio);
    if (!video) return null;
    const start = video.start - (audio.offset - linkOffsetOf(video));
    if (Math.abs(start) > 0.02) return start;
    if (!followsVideoEdits(video, audio)) return 0;
    const end = (video.start + videoClipLength(video)) - (audio.offset + audioClipLength(audio));
    return Math.abs(end) > 0.02 ? end : 0;
  }

  interface LinkedPair {
    video: VideoClip;
    audio: AudioClip;
  }

  function currentLinkedPair(): LinkedPair | null {
    if (selected?.kind === 'video') {
      const video = videos.find((clip) => clip.id === selected!.id);
      if (!video?.linkGroup) return null;
      const audio = linkedAudioFor(video);
      return audio ? { video, audio } : null;
    }
    if (selected?.kind === 'audio') {
      const audio = audios.find((clip) => clip.id === selected!.id);
      if (!audio?.linkGroup) return null;
      const video = linkedVideoFor(audio);
      return video ? { video, audio } : null;
    }
    return null;
  }

  /**
   * The clip to pair with the current selection. A selected clip of the other
   * kind wins; otherwise fall back to the closest unlinked clip from the same
   * source file, which is the sound split out of this video.
   */
  function groupablePair(): LinkedPair | null {
    if (!selected) return null;
    const members = selectedClipMembers();
    if (selected.kind === 'video') {
      const video = videos.find((clip) => clip.id === selected!.id);
      if (!video || video.linkGroup) return null;
      const selectedAudio = members
        .filter((member) => member.kind === 'audio' && !member.clip.linkGroup)
        .map((member) => member.clip as AudioClip)
        .sort((a, b) => Math.abs(a.offset - video.start) - Math.abs(b.offset - video.start))[0];
      const audio = selectedAudio ?? audios
        .filter((clip) => !clip.linkGroup && mediaKey(clip.file) === mediaKey(video.file))
        .sort((a, b) => Math.abs(a.offset - video.start) - Math.abs(b.offset - video.start))[0];
      return audio ? { video, audio } : null;
    }
    const audio = audios.find((clip) => clip.id === selected!.id);
    if (!audio || audio.linkGroup) return null;
    const selectedVideo = members
      .filter((member) => member.kind === 'video' && !member.clip.linkGroup)
      .map((member) => member.clip as VideoClip)
      .sort((a, b) => Math.abs(a.start - audio.offset) - Math.abs(b.start - audio.offset))[0];
    const video = selectedVideo ?? videos
      .filter((clip) => !clip.linkGroup && mediaKey(clip.file) === mediaKey(audio.file))
      .sort((a, b) => Math.abs(a.start - audio.offset) - Math.abs(b.start - audio.offset))[0];
    return video ? { video, audio } : null;
  }

  function ensureLinkMagnet(): void {
    if (linkClipsEnabled) return;
    linkClipsEnabled = true;
    saveLayout();
    updateTimelineTools();
  }

  function syncPairToVideo(pair: LinkedPair): void {
    ensureLinkMagnet();
    pair.video.linkOffset = 0;
    pair.audio.offset = pair.video.start;
    if (sameMediaSource(pair.video, pair.audio)) {
      pair.audio.trimStart = pair.video.trimStart;
      pair.audio.trimEnd = pair.video.trimEnd;
    }
    pair.video.linkGroup = pair.video.linkGroup ?? ++nextLinkGroup;
    pair.audio.linkGroup = pair.video.linkGroup;
    syncRetimeAudio(pair.video);
    render();
    commit('Synced audio to video');
    status.textContent = 'Audio and video now share the same start time.';
  }

  function groupPair(pair: LinkedPair, sync: boolean): void {
    ensureLinkMagnet();
    pair.video.linkGroup = undefined;
    pair.audio.linkGroup = undefined;
    const group = ++nextLinkGroup;
    pair.video.linkGroup = group;
    pair.audio.linkGroup = group;
    const offset = pair.audio.offset - pair.video.start;
    if (sync) {
      pair.video.linkOffset = 0;
      pair.audio.offset = pair.video.start;
      if (sameMediaSource(pair.video, pair.audio)) {
        pair.audio.trimStart = pair.video.trimStart;
        pair.audio.trimEnd = pair.video.trimEnd;
      }
    } else {
      pair.video.linkOffset = offset;
    }
    syncRetimeAudio(pair.video);
    render();
    commit(sync ? 'Grouped and synced audio and video' : 'Grouped audio and video');
    status.textContent = sync
      ? 'Grouped and synced to the video start.'
      : Math.abs(offset) > 0.01
        ? `Grouped; audio is ${offset > 0 ? 'after' : 'before'} the video by ${formatClock(Math.abs(offset), true)}.`
        : 'Grouped at the same start time. Moving one now moves the other.';
  }

  function ungroupPair(pair: LinkedPair): void {
    pair.video.linkGroup = undefined;
    pair.video.linkOffset = undefined;
    pair.audio.linkGroup = undefined;
    render();
    commit('Ungrouped audio and video');
    status.textContent = 'Ungrouped. Audio and video now move independently.';
  }

  function anyVideoSolo(): boolean {
    return videoTrackState.some((state) => Boolean(state.solo));
  }

  function anyAudioSolo(): boolean {
    return audioTrackState.some((state) => Boolean(state.solo));
  }

  function videoTrackOpacity(index: number): number {
    const opacity = videoTrackState[index]?.opacity;
    return Math.max(0, Math.min(1, typeof opacity === 'number' ? opacity : 1));
  }

  function videoTrackHidden(index: number): boolean {
    const state = videoTrackState[index];
    if (!state) return false;
    return Boolean(state.hidden) || videoTrackOpacity(index) <= 0.0001 ||
      (anyVideoSolo() && !state.solo);
  }

  function videoTrackMuted(index: number): boolean {
    const state = videoTrackState[index];
    if (!state) return false;
    return Boolean(state.muted) || (anyVideoSolo() && !state.solo);
  }

  function audioTrackMuted(index: number): boolean {
    const state = audioTrackState[index];
    if (!state) return false;
    return Boolean(state.muted) || (anyAudioSolo() && !state.solo);
  }

  function videoTrackGain(index: number): number {
    return Math.max(0, Math.min(2, videoTrackState[index]?.gain ?? 1));
  }

  function audioTrackGain(index: number): number {
    return Math.max(0, Math.min(2, audioTrackState[index]?.gain ?? 1));
  }

  function videoTrackLocked(index: number): boolean {
    return Boolean(videoTrackState[index]?.locked);
  }

  function audioTrackLocked(index: number): boolean {
    return Boolean(audioTrackState[index]?.locked);
  }

  function videoClipLocked(clip: VideoClip): boolean {
    return videoTrackLocked(clip.track);
  }

  function audioClipLocked(clip: AudioClip): boolean {
    return audioTrackLocked(audioRows().get(clip.id) ?? 0);
  }

  function lockedNotice(): void {
    status.textContent = 'This track is locked. Unlock it in the track header to edit its clips.';
  }

  let captionLaneKey = '';
  function renderCaptionLane(scale: number): void {
    const list = shiftedCues();
    const key = [
      scale.toFixed(4),
      totalVideo().toFixed(2),
      captionSource.value,
      captionOffset,
      captionFileName,
      list.length,
      list[0]?.start ?? 0,
      list[list.length - 1]?.end ?? 0,
      list.reduce((sum, cue) => sum + cue.text.length, 0),
      selectedSubtitleKey,
      showSubtitleTrack,
      captionTrackState.hidden,
      captionTrackState.locked,
    ].join('|');
    if (key === captionLaneKey) return;
    captionLaneKey = key;
    captionLane.querySelectorAll('.vt-cue').forEach((element) => element.remove());
    captionLane.classList.toggle('hidden', !list.length && !showSubtitleTrack);
    captionLane.classList.toggle('captions-hidden', captionTrackState.hidden);
    captionLane.classList.toggle('locked', captionTrackState.locked);
    if (!list.length) return;
    for (const cue of list) {
      if (cue.end <= 0 || cue.start >= contentEnd() + 0.05) continue;
      const block = document.createElement('div');
      block.className = 'vt-cue';
      block.dataset.cueStart = String(cue.start);
      block.dataset.cueText = cue.text;
      block.classList.toggle('selected-subtitle', subtitleStyleKey(cue.text) === selectedSubtitleKey);
      block.style.left = `${cue.start * scale}px`;
      block.style.width = `${Math.max(6, (cue.end - cue.start) * scale)}px`;
      block.textContent = cue.text;
      block.title = `${formatClock(cue.start, true)} · ${cue.text}`;
      block.tabIndex = 0;
      block.setAttribute('role', 'button');
      block.setAttribute('aria-label', `Caption at ${formatClock(cue.start, true)}: ${cue.text}`);
      if (captionTrackState.locked) block.setAttribute('aria-disabled', 'true');
      const activateCue = (): void => {
        if (captionTrackState.locked) {
          lockedNotice();
          return;
        }
        selected = null;
        selectedTitle = -1;
        selectedGraphic = -1;
        selectedSubtitleKey = subtitleStyleKey(cue.text);
        const embedded = cue as Partial<EmbeddedTimelineCue>;
        selectedEmbeddedCue = embedded.embeddedClipId !== undefined && embedded.embeddedCueIndex !== undefined
          ? { clipId: embedded.embeddedClipId, index: embedded.embeddedCueIndex } : null;
        selectSideTab('text');
        ensureInspectorOpen();
        updateGraphicOverlay();
        renderTitlePanel();
        renderTitleBlocks(scale);
        renderGraphicBlocks(scale);
        captionLaneKey = '';
        renderCaptionLane(scale);
      };
      block.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        event.stopPropagation();
        event.preventDefault();
        activateCue();
      });
      block.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          event.stopPropagation();
          activateCue();
        }
      });
      captionLane.append(block);
    }
  }

  function videoTrackHeight(row: number): number {
    return videoTrackHeights[row] ?? videoRowHeight();
  }

  function audioTrackHeight(row: number): number {
    return audioTrackHeights[row] ?? audioRowHeight();
  }

  function trackTop(heights: readonly number[], fallback: number, row: number): number {
    let top = 0;
    for (let index = 0; index < row; index += 1) top += heights[index] ?? fallback;
    return top;
  }

  function videoTrackTop(row: number): number {
    return trackTop(videoTrackHeights, videoRowHeight(), row);
  }

  function audioTrackTop(row: number): number {
    return trackTop(audioTrackHeights, audioRowHeight(), row);
  }

  function tracksHeight(heights: readonly number[], fallback: number, count: number): number {
    let total = 0;
    for (let index = 0; index < count; index += 1) total += heights[index] ?? fallback;
    return total;
  }

  function trackAtOffset(
    offsetY: number,
    heights: readonly number[],
    fallback: number,
    count: number,
  ): number {
    const rows = Math.max(1, count);
    let top = 0;
    for (let row = 0; row < rows; row += 1) {
      const height = heights[row] ?? fallback;
      if (offsetY < top + height) return row;
      top += height;
    }
    return rows;
  }

  function ensureTrackStates(videoRows: number, audioRowsCount: number): void {
    while (videoTrackState.length < videoRows) videoTrackState.push({ hidden: false, muted: false, locked: false, solo: false });
    while (audioTrackState.length < Math.max(1, audioRowsCount)) audioTrackState.push({ muted: false, locked: false, solo: false });
    while (videoTrackHeights.length < Math.max(1, videoRows)) videoTrackHeights.push(videoRowHeight());
    while (audioTrackHeights.length < Math.max(1, audioRowsCount)) audioTrackHeights.push(audioRowHeight());
  }

  function trackButton(label: string, title: string, active: boolean, onClick: (event: MouseEvent) => void, extra = ''): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `vt-track-btn${active ? ` ${extra || 'active'}` : ''}`;
    button.textContent = label;
    button.title = title;
    button.setAttribute('aria-label', title);
    button.addEventListener('click', onClick);
    return button;
  }

  function lockTrackButton(locked: boolean, onClick: (event: MouseEvent) => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `vt-track-btn vt-track-lock${locked ? ' active' : ''}`;
    button.title = locked ? 'Unlock track' : 'Lock track';
    button.setAttribute('aria-label', button.title);
    button.innerHTML = locked
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 7.7-1.5"/></svg>';
    button.addEventListener('click', onClick);
    return button;
  }

  function deleteVideoTrack(index: number): void {
    if (videoTrackLocked(index)) {
      lockedNotice();
      return;
    }
    const removed = videos.filter((clip) => clip.track === index);
    for (const clip of removed) URL.revokeObjectURL(clip.url);
    videos = videos
      .filter((clip) => clip.track !== index)
      .map((clip) => (clip.track > index ? { ...clip, track: clip.track - 1 } : clip));
    let removedTitles = 0;
    for (let cueIndex = titles.length - 1; cueIndex >= 0; cueIndex -= 1) {
      const cue = titles[cueIndex];
      const track = titleTrackIndex(cue);
      if (track === index) {
        titles.splice(cueIndex, 1);
        removedTitles += 1;
        if (selectedTitle === cueIndex) selectedTitle = -1;
        else if (selectedTitle > cueIndex) selectedTitle -= 1;
      } else if (track > index) {
        cue.track = track - 1;
      }
    }
    let removedGraphics = 0;
    for (let graphicIndex = graphics.length - 1; graphicIndex >= 0; graphicIndex -= 1) {
      const graphic = graphics[graphicIndex];
      const track = graphicTrackIndex(graphic);
      if (track === index) {
        graphics.splice(graphicIndex, 1);
        removedGraphics += 1;
        if (selectedGraphic === graphicIndex) selectedGraphic = -1;
        else if (selectedGraphic > graphicIndex) selectedGraphic -= 1;
      } else if (track > index) {
        graphic.track = track - 1;
      }
    }
    videoTrackState.splice(index, 1);
    videoTrackHeights.splice(index, 1);
    videoTrackCount = Math.max(1, videoTrackCount - 1);
    while (videoTrackState.length < videoTrackCount) videoTrackState.push({ hidden: false, muted: false, locked: false, solo: false });
    if (selected?.kind === 'video' && removed.some((clip) => clip.id === selected!.id)) selected = null;
    if (activeVideo && removed.includes(activeVideo)) activeVideo = null;
    invalidateShiftedCues();
    captionLaneKey = '';
    graphicsPreviewKey = '';
    render();
    seek(time);
    commit();
    const removedParts = [
      removed.length ? `${removed.length} clip${removed.length === 1 ? '' : 's'}` : '',
      removedTitles ? `${removedTitles} title${removedTitles === 1 ? '' : 's'}` : '',
      removedGraphics ? `${removedGraphics} shape${removedGraphics === 1 ? '' : 's'}` : '',
    ].filter(Boolean);
    const restored = removedParts.length ? ` Ctrl+Z restores ${removedParts.join(' and ')}.` : '';
    status.textContent = `Video track ${index + 1} deleted.${restored}`;
  }

  function deleteAudioTrack(index: number): void {
    if (audioTrackLocked(index)) {
      lockedNotice();
      return;
    }
    const removed = audios.filter((clip) => clip.track === index);
    for (const clip of removed) {
      disposeAudio(clip);
      URL.revokeObjectURL(clip.url);
    }
    audios = audios
      .filter((clip) => clip.track !== index)
      .map((clip) => (clip.track > index ? { ...clip, track: clip.track - 1 } : clip));
    audioTrackState.splice(index, 1);
    audioTrackHeights.splice(index, 1);
    audioTrackCount = Math.max(1, audioTrackCount - 1);
    if (selected?.kind === 'audio' && removed.some((clip) => clip.id === selected!.id)) selected = null;
    audioRowsCache = null;
    while (audioTrackState.length < audioTrackCount) audioTrackState.push({ muted: false, locked: false, solo: false });
    render();
    seek(time);
    commit();
    status.textContent = `Audio track ${index + 1} deleted.${removed.length ? ' Ctrl+Z restores its clips.' : ''}`;
  }

  function moveAudioTrack(from: number, to: number): void {
    if (from === to) return;
    const [state] = audioTrackState.splice(from, 1);
    audioTrackState.splice(to, 0, state);
    const [height] = audioTrackHeights.splice(from, 1);
    audioTrackHeights.splice(to, 0, height ?? audioRowHeight());
    for (const clip of audios) {
      if (clip.track === from) clip.track = to;
      else if (from < to && clip.track > from && clip.track <= to) clip.track -= 1;
      else if (from > to && clip.track >= to && clip.track < from) clip.track += 1;
    }
    audioRowsCache = null;
    render();
    seek(time);
    commit();
  }

  function addTracks(kind: 'video' | 'audio', count: number): void {
    const total = Math.max(1, Math.min(20, Math.round(count)));
    for (let index = 0; index < total; index += 1) {
      if (kind === 'video') addVideoTrack();
      else addAudioTrack();
    }
  }

  function deleteEmptyTracks(kind: 'video' | 'audio'): void {
    if (kind === 'video') {
      for (let row = videoTrackCount - 1; row >= 0 && videoTrackCount > 1; row -= 1) {
        if (!videos.some((clip) => clip.track === row) &&
          !titles.some((cue) => titleTrackIndex(cue) === row) &&
          !graphics.some((graphic) => graphicTrackIndex(graphic) === row) &&
          !videoTrackLocked(row)) deleteVideoTrack(row);
      }
    } else {
      for (let row = audioTrackCount - 1; row >= 0 && audioTrackCount > 1; row -= 1) {
        if (!audios.some((clip) => clip.track === row) && !audioTrackLocked(row)) deleteAudioTrack(row);
      }
    }
  }

  function closeTrackMenu(): void {
    trackMenu.classList.add('hidden');
    trackMenu.replaceChildren();
  }

  function closeTimelineMenu(): void {
    timelineMenu.classList.add('hidden');
    timelineMenu.replaceChildren();
  }

  function timelineMenuItem(label: string, action: () => void, disabled = false): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'video-track-menu-item';
    button.setAttribute('role', 'menuitem');
    button.textContent = label;
    button.disabled = disabled;
    button.addEventListener('click', () => {
      if (button.disabled) return;
      closeTimelineMenu();
      action();
    });
    timelineMenu.append(button);
    return button;
  }

  function timelineMenuSeparator(): void {
    const line = document.createElement('span');
    line.className = 'video-track-menu-separator';
    timelineMenu.append(line);
  }

  function placeFloatingMenu(menu: HTMLElement, clientX: number, clientY: number): void {
    const margin = 8;
    menu.style.visibility = 'hidden';
    menu.style.left = '0px';
    menu.style.top = '0px';
    menu.classList.remove('hidden');
    const rect = menu.getBoundingClientRect();
    const left = Math.min(Math.max(margin, clientX), Math.max(margin, window.innerWidth - rect.width - margin));
    const top = Math.min(Math.max(margin, clientY), Math.max(margin, window.innerHeight - rect.height - margin));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.style.visibility = '';
  }

  function openTrackMenu(kind: 'video' | 'audio', row: number, clientX: number, clientY: number): void {
    closeTimelineMenu();
    trackMenu.replaceChildren();
    const tracks = kind === 'video' ? videoTrackCount : audioTrackCount;
    const state = kind === 'video'
      ? videoTrackState[row] ?? { hidden: false, muted: false }
      : audioTrackState[row] ?? { muted: false };
    const item = (label: string, action: () => void, disabled = false, className = ''): HTMLButtonElement => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `video-track-menu-item ${className}`.trim();
      button.setAttribute('role', 'menuitem');
      button.textContent = label;
      button.disabled = disabled;
      button.addEventListener('click', () => {
        if (button.disabled) return;
        closeTrackMenu();
        action();
      });
      trackMenu.append(button);
      return button;
    };
    const separator = (): void => {
      const line = document.createElement('span');
      line.className = 'video-track-menu-separator';
      trackMenu.append(line);
    };
    item('Add Track', () => (kind === 'video' ? addVideoTrack() : addAudioTrack()));
    item('Add Tracks…', () => {
      const answer = window.prompt('How many tracks?', '3');
      if (answer === null) return;
      const count = Number(answer);
      if (Number.isFinite(count) && count > 0) addTracks(kind, count);
    });
    item('Add Subtitle Track', () => {
      showSubtitleTrack = true;
      captionLaneKey = '';
      render();
      openLibraryPanel('captions');
      commit('Added subtitle track');
      status.textContent = 'Subtitle lane added. Drop or load an SRT/VTT in the Captions panel.';
    });
    separator();
    item('Move Track Up', () => (kind === 'video' ? moveVideoTrack(row, row - 1) : moveAudioTrack(row, row - 1)), row <= 0);
    item('Move Track Down', () => (kind === 'video' ? moveVideoTrack(row, row + 1) : moveAudioTrack(row, row + 1)), row >= tracks - 1);
    separator();
    item('Delete Track', () => (kind === 'video' ? deleteVideoTrack(row) : deleteAudioTrack(row)), tracks <= 1);
    item('Delete Empty Tracks', () => deleteEmptyTracks(kind), tracks <= 1);
    separator();
    item(state.locked ? 'Unlock Track' : 'Lock Track', () => {
      const target = kind === 'video' ? videoTrackState[row] : audioTrackState[row];
      if (!target) return;
      target.locked = !target.locked;
      render();
      seek(time);
      commit();
      status.textContent = target.locked ? `Track ${row + 1} locked.` : `Track ${row + 1} unlocked.`;
    });
    item('Change Track Color', () => {
      trackMenu.replaceChildren();
      const back = document.createElement('button');
      back.type = 'button';
      back.className = 'video-track-menu-item';
      back.textContent = '← Track color';
      back.addEventListener('click', () => openTrackMenu(kind, row, clientX, clientY));
      trackMenu.append(back);
      const palette = document.createElement('div');
      palette.className = 'video-track-colors';
      const colors: { label: string; value?: string }[] = [
        { label: 'Auto' },
        { label: 'Blue', value: '#38bdf8' },
        { label: 'Teal', value: '#2dd4bf' },
        { label: 'Violet', value: '#a78bfa' },
        { label: 'Amber', value: '#fbbf24' },
        { label: 'Rose', value: '#fb7185' },
        { label: 'Green', value: '#34d399' },
      ];
      const currentColor = kind === 'video' ? videoTrackState[row]?.color : audioTrackState[row]?.color;
      for (const color of colors) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'video-track-color'
          + (color.value ? '' : ' auto')
          + ((color.value ?? undefined) === currentColor ? ' current' : '');
        button.title = color.label;
        button.setAttribute('aria-label', color.label);
        if (color.value) button.style.background = color.value;
        button.addEventListener('click', () => {
          const target = kind === 'video' ? videoTrackState[row] : audioTrackState[row];
          if (!target) return;
          target.color = color.value;
          trackHeaderKey = '';
          render();
          seek(time);
          commit('Changed track color');
          status.textContent = color.value ? `Track ${row + 1} color changed.` : `Track ${row + 1} color cleared.`;
          closeTrackMenu();
        });
        palette.append(button);
      }
      trackMenu.append(palette);
      placeFloatingMenu(trackMenu, clientX, clientY);
    });
    placeFloatingMenu(trackMenu, clientX, clientY);
  }

  trackHeaderList.addEventListener('contextmenu', (event) => {
    const head = (event.target as Element | null)?.closest<HTMLElement>('.vt-head[data-track-kind]');
    if (!head) return;
    const kind = head.dataset.trackKind === 'audio' ? 'audio' : 'video';
    const row = Number(head.dataset.trackRow);
    if (!Number.isFinite(row)) return;
    event.preventDefault();
    event.stopPropagation();
    openTrackMenu(kind, row, event.clientX, event.clientY);
  });

  function openTimelineMenu(kind: 'clip' | 'title' | 'graphic' | 'empty', clientX: number, clientY: number): void {
    closeTrackMenu();
    timelineMenu.replaceChildren();
    const item = timelineMenuItem;
    const separator = timelineMenuSeparator;
    if (kind === 'clip') {
      item('Copy', () => copySelected());
      item('Cut', cutSelected);
      item('Paste at playhead', pasteClipboard, !clipClipboard);
      item('Duplicate', duplicateSelected);
      separator();
      const linked = currentLinkedPair();
      if (linked) {
        item('Ungroup audio and video', () => ungroupPair(linked));
        item('Sync audio to video', () => syncPairToVideo(linked));
        separator();
      } else {
        const pair = groupablePair();
        if (pair) {
          item('Group audio and video (keep offset)', () => groupPair(pair, false));
          item('Group audio and video (sync start)', () => groupPair(pair, true));
          separator();
        }
      }
      item('Split at playhead', splitAtPlayhead);
      const video = selectedVideoClip();
      if (video && !video.image) item('Edit speed points', openSpeedPoints);
      item('Delete', removeSelected);
      item('Ripple delete', rippleDeleteSelected);
    } else if (kind === 'title') {
      item('Copy', () => copySelected());
      item('Cut', cutSelected);
      item('Paste at playhead', pasteClipboard, !clipClipboard);
      item('Duplicate', duplicateSelected);
      separator();
      item('Split at playhead', () => { splitTitleAtPlayhead(); });
      item('Delete', () => deleteTitle(selectedTitle));
      separator();
      item('Edit title text', () => {
        selectSideTab('text');
        ensureInspectorOpen();
        titleText.focus();
      });
    } else if (kind === 'graphic') {
      item('Copy', () => copySelected());
      item('Cut', cutSelected);
      item('Paste at playhead', pasteClipboard, !clipClipboard);
      item('Duplicate', duplicateSelected);
      separator();
      item('Delete', () => deleteGraphic(selectedGraphic));
      separator();
      item('Edit shape', () => {
        selectSideTab('graphics');
        ensureInspectorOpen();
      });
    } else {
      item('Paste at playhead', pasteClipboard, !clipClipboard);
      separator();
      item('Add title at playhead', addTitleAtPlayhead);
      item('Add rectangle', () => addGraphic('rect'));
      item('Add ellipse', () => addGraphic('ellipse'));
      item('Add line', () => addGraphic('line'));
      separator();
      item('Mark In', setRangeIn);
      item('Mark Out', setRangeOut);
      item('Clear In/Out', () => {
        rangeIn = null;
        rangeOut = null;
        updateRangeMarkers();
        commit('Cleared export range');
      }, rangeIn === null && rangeOut === null);
    }
    placeFloatingMenu(timelineMenu, clientX, clientY);
  }

  scroll.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    const target = event.target instanceof Element ? event.target : null;
    const graphicElement = target?.closest<HTMLElement>('.vt-clip-graphic');
    if (graphicElement) {
      const index = Number(graphicElement.dataset.graphicIndex);
      if (!Number.isFinite(index)) return;
      selected = null;
      selectedTitle = -1;
      selectedSubtitleKey = '';
      selectedGraphic = index;
      render();
      renderGraphicsPanel();
      openTimelineMenu('graphic', event.clientX, event.clientY);
      return;
    }
    const titleElement = target?.closest<HTMLElement>('.vt-clip-title');
    if (titleElement) {
      const index = Number(titleElement.dataset.titleIndex);
      if (!Number.isFinite(index)) return;
      selected = null;
      selectedTitle = index;
      selectedSubtitleKey = '';
      selectedGraphic = -1;
      render();
      renderTitlePanel();
      openTimelineMenu('title', event.clientX, event.clientY);
      return;
    }
    const clipElement = target?.closest<HTMLElement>('.vt-clip');
    if (!clipElement) {
      openTimelineMenu('empty', event.clientX, event.clientY);
      return;
    }
    const id = Number(clipElement.dataset.id);
    if (!Number.isFinite(id)) return;
    const kind = clipElement.classList.contains('vt-clip-audio') ? 'audio' : 'video';
    if (!isClipSelected(kind, id) || selectedClipCount() < 1) {
      setClipSelection(kind, id);
    } else {
      selected = { kind, id };
      selectionAnchor = clipSelectionKey(selected);
    }
    selectedTitle = -1;
    selectedGraphic = -1;
    selectedSubtitleKey = '';
    render();
    openTimelineMenu('clip', event.clientX, event.clientY);
  });

  document.addEventListener('pointerdown', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target?.closest('#video-track-menu')) closeTrackMenu();
    if (!target?.closest('#video-timeline-menu')) closeTimelineMenu();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (trackMenu.classList.contains('hidden') && timelineMenu.classList.contains('hidden')) return;
    event.preventDefault();
    closeTrackMenu();
    closeTimelineMenu();
  });
  window.addEventListener('resize', () => {
    closeTrackMenu();
    closeTimelineMenu();
  });
  function syncTrackHeaderScroll(): void {
    trackHeaderList.style.transform = scroll.scrollTop > 0
      ? `translate3d(0, ${-scroll.scrollTop}px, 0)`
      : '';
  }
  scroll.addEventListener('scroll', () => {
    syncTrackHeaderScroll();
    syncAnimationGeometry();
    scheduleTimelineWindowSync();
    scheduleRulerSync();
    scheduleClipLabelSync();
    scheduleDetailSync();
    closeTrackMenu();
    closeTimelineMenu();
  }, { passive: true });
  trackHeaderList.parentElement?.addEventListener('wheel', (event) => {
    if (event.ctrlKey || event.metaKey || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    event.preventDefault();
    scroll.scrollTop += event.deltaY;
  }, { passive: false });

  function moveVideoTrack(from: number, to: number): void {
    if (from === to) return;
    const [state] = videoTrackState.splice(from, 1);
    videoTrackState.splice(to, 0, state);
    const [height] = videoTrackHeights.splice(from, 1);
    videoTrackHeights.splice(to, 0, height ?? videoRowHeight());
    for (const clip of videos) {
      if (clip.track === from) clip.track = to;
      else if (from < to && clip.track > from && clip.track <= to) clip.track -= 1;
      else if (from > to && clip.track >= to && clip.track < from) clip.track += 1;
    }
    for (const cue of titles) {
      const track = titleTrackIndex(cue);
      if (track === from) cue.track = to;
      else if (from < to && track > from && track <= to) cue.track = track - 1;
      else if (from > to && track >= to && track < from) cue.track = track + 1;
    }
    for (const graphic of graphics) {
      const track = graphicTrackIndex(graphic);
      if (track === from) graphic.track = to;
      else if (from < to && track > from && track <= to) graphic.track = track - 1;
      else if (from > to && track >= to && track < from) graphic.track = track + 1;
    }
    render();
    seek(time);
    commit();
  }

  function addTrackResizeHandles(head: HTMLElement, kind: 'video' | 'audio', row: number): void {
    const edges: ('top' | 'bottom')[] = row === 0 ? ['bottom'] : ['top', 'bottom'];
    for (const edge of edges) {
      const handle = document.createElement('span');
      handle.className = `vt-track-resize ${edge}`;
      handle.title = 'Drag to resize track height';
      handle.dataset.edge = edge;
      handle.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        const targetRow = edge === 'top' ? row - 1 : row;
        const heights = kind === 'video' ? videoTrackHeights : audioTrackHeights;
        const fallback = kind === 'video' ? videoRowHeight() : audioRowHeight();
        const minHeight = kind === 'video' ? 48 : 40;
        const startHeight = heights[targetRow] ?? fallback;
        const startY = event.clientY;
        document.body.classList.add('track-resizing');
        const move = (moveEvent: PointerEvent): void => {
          const next = Math.max(minHeight, Math.min(240, Math.round(startHeight + moveEvent.clientY - startY)));
          heights[targetRow] = next;
          renderTimeline();
        };
        const up = (): void => {
          document.removeEventListener('pointermove', move);
          document.removeEventListener('pointerup', up);
          document.removeEventListener('pointercancel', up);
          document.body.classList.remove('track-resizing');
          renderTimeline();
          saveLayout();
        };
        document.addEventListener('pointermove', move);
        document.addEventListener('pointerup', up);
        document.addEventListener('pointercancel', up);
      });
      head.append(handle);
    }
  }

  let trackHeaderKey = '';
  function renderTrackHeaders(videoRows: number, audioRowsCount: number, captionsVisible: boolean, graphicsVisible = false): void {
    const videoCounts = new Array<number>(videoRows).fill(0);
    for (const clip of videos) {
      if (clip.track >= 0 && clip.track < videoCounts.length) videoCounts[clip.track] += 1;
    }
    for (const cue of titles) {
      const track = titleTrackIndex(cue);
      if (track >= 0 && track < videoCounts.length) videoCounts[track] += 1;
    }
    for (const graphic of graphics) {
      const track = graphicTrackIndex(graphic);
      if (track >= 0 && track < videoCounts.length) videoCounts[track] += 1;
    }
    const audioCounts = new Array<number>(audioRowsCount).fill(0);
    const audioRowMap = audioRows();
    for (const clip of audios) {
      const row = audioRowMap.get(clip.id) ?? 0;
      if (row >= 0 && row < audioCounts.length) audioCounts[row] += 1;
    }
    const key = [
      videoRows,
      audioRowsCount,
      captionsVisible ? 1 : 0,
      captionTrackState.hidden,
      captionTrackState.locked,
      graphicsVisible ? 1 : 0,
      videoTrackCount,
      videoCounts.join(','),
      audioCounts.join(','),
      videoTrackHeights.slice(0, videoRows).join(','),
      audioTrackHeights.slice(0, audioRowsCount).join(','),
      videoTrackState.slice(0, videoRows).map((state) => `${state.hidden ? 1 : 0}${state.muted ? 1 : 0}${state.locked ? 1 : 0}${state.solo ? 1 : 0}${state.color ?? ''}`).join(''),
      audioTrackState.slice(0, audioRowsCount).map((state) => `${state.muted ? 1 : 0}${state.locked ? 1 : 0}${state.solo ? 1 : 0}${state.color ?? ''}`).join(''),
    ].join('|');
    if (key === trackHeaderKey) return;
    trackHeaderKey = key;
    trackHeaderList.replaceChildren();
    if (graphicsVisible) {
      const graphic = document.createElement('div');
      graphic.className = 'vt-head vt-head-graphics';
      graphic.textContent = 'Graphics';
      trackHeaderList.append(graphic);
    }
    if (captionsVisible) {
      const caption = document.createElement('div');
      caption.className = 'vt-head vt-head-captions';
      caption.classList.toggle('locked', captionTrackState.locked);
      const name = document.createElement('span');
      name.className = 'vt-track-info';
      name.textContent = 'Captions';
      const hide = trackButton('V', captionTrackState.hidden ? 'Show captions track' : 'Hide captions track', captionTrackState.hidden, () => {
        captionTrackState.hidden = !captionTrackState.hidden;
        invalidateShiftedCues();
        render();
        commit(captionTrackState.hidden ? 'Hid captions track' : 'Showed captions track');
        trackHeaderList.querySelector<HTMLButtonElement>('.vt-head-captions .vt-track-btn')?.focus();
      }, 'hidden-track');
      const lock = lockTrackButton(captionTrackState.locked, () => {
        captionTrackState.locked = !captionTrackState.locked;
        selectedSubtitleKey = '';
        selectedEmbeddedCue = null;
        render();
        commit(captionTrackState.locked ? 'Locked captions track' : 'Unlocked captions track');
        trackHeaderList.querySelector<HTMLButtonElement>('.vt-head-captions .vt-track-lock')?.focus();
      });
      hide.setAttribute('aria-pressed', String(captionTrackState.hidden));
      lock.title = captionTrackState.locked ? 'Unlock captions track' : 'Lock captions track';
      lock.setAttribute('aria-label', lock.title);
      lock.setAttribute('aria-pressed', String(captionTrackState.locked));
      caption.append(name, hide, lock);
      trackHeaderList.append(caption);
    }
    const videoGroup = document.createElement('div');
    videoGroup.className = 'vt-head-group';
    for (let row = 0; row < videoRows; row += 1) {
      const state = videoTrackState[row] ?? { hidden: false, muted: false, locked: false, solo: false };
      const head = document.createElement('div');
      head.className = 'vt-head';
      head.dataset.trackRow = String(row);
      head.dataset.trackKind = 'video';
      head.style.height = `${videoTrackHeight(row)}px`;
      head.classList.toggle('short-track', videoTrackHeight(row) < 46);
      head.classList.toggle('locked', Boolean(state.locked));
      head.classList.toggle('has-track-color', Boolean(state.color));
      if (state.color) head.style.setProperty('--track-color', state.color);
      else head.style.removeProperty('--track-color');
      const grip = document.createElement('button');
      grip.type = 'button';
      grip.className = 'vt-track-grip';
      grip.textContent = '⠿';
      grip.title = 'Drag to reorder video tracks';
      grip.draggable = true;
      grip.addEventListener('dragstart', (event) => {
        event.dataTransfer?.setData('application/x-video-track', String(row));
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
      });
      const badge = document.createElement('span');
      badge.className = 'vt-track-badge';
      badge.textContent = `V${row + 1}`;
      const info = document.createElement('div');
      info.className = 'vt-track-info';
      const name = document.createElement('span');
      name.className = 'vt-track-name';
      name.textContent = `Video ${row + 1}`;
      const sub = document.createElement('span');
      sub.className = 'vt-track-sub';
      const clipCount = videoCounts[row] ?? 0;
      sub.textContent = `${clipCount} clip${clipCount === 1 ? '' : 's'}`;
      info.append(name, sub);
      const hide = trackButton('V', state.hidden ? 'Show video track' : 'Hide video track', state.hidden, () => {
        state.hidden = !state.hidden;
        render();
        seek(time);
        commit();
      }, 'hidden-track');
      const mute = trackButton('M', state.muted ? 'Unmute video track' : 'Mute video track', state.muted, () => {
        state.muted = !state.muted;
        render();
        seek(time);
        commit();
      });
      const solo = trackButton('S', state.solo ? 'Unsolo video track' : 'Solo video track', Boolean(state.solo), () => {
        state.solo = !state.solo;
        render();
        seek(time);
        commit();
      });
      solo.classList.add('vt-track-solo');
      const lock = lockTrackButton(Boolean(state.locked), () => {
        state.locked = !state.locked;
        render();
        seek(time);
        commit();
        status.textContent = state.locked ? `Video track ${row + 1} locked.` : `Video track ${row + 1} unlocked.`;
      });
      head.append(grip, badge, info, hide, mute, solo, lock);
      addTrackResizeHandles(head, 'video', row);
      head.addEventListener('dragover', (event) => {
        if (!event.dataTransfer?.types.includes('application/x-video-track')) return;
        event.preventDefault();
        head.classList.add('drag-over');
      });
      head.addEventListener('dragleave', () => head.classList.remove('drag-over'));
      head.addEventListener('drop', (event) => {
        head.classList.remove('drag-over');
        const from = Number(event.dataTransfer?.getData('application/x-video-track'));
        if (Number.isFinite(from)) {
          event.preventDefault();
          moveVideoTrack(from, row);
        }
      });
      videoGroup.append(head);
    }
    trackHeaderList.append(videoGroup);
    if (audioRowsCount) {
      const audioGroup = document.createElement('div');
      audioGroup.className = 'vt-head-group';
      for (let row = 0; row < audioRowsCount; row += 1) {
        const state = audioTrackState[row] ?? { muted: false, locked: false, solo: false };
        const head = document.createElement('div');
        head.className = 'vt-head vt-head-audio';
        head.dataset.trackRow = String(row);
        head.dataset.trackKind = 'audio';
        head.style.height = `${audioTrackHeight(row)}px`;
        head.classList.toggle('short-track', audioTrackHeight(row) < 46);
        head.classList.toggle('locked', Boolean(state.locked));
        head.classList.toggle('has-track-color', Boolean(state.color));
        if (state.color) head.style.setProperty('--track-color', state.color);
        else head.style.removeProperty('--track-color');
        const badge = document.createElement('span');
        badge.className = 'vt-track-badge';
        badge.textContent = `A${row + 1}`;
        const info = document.createElement('div');
        info.className = 'vt-track-info';
        const name = document.createElement('span');
        name.className = 'vt-track-name';
        name.textContent = `Audio ${row + 1}`;
        const sub = document.createElement('span');
        sub.className = 'vt-track-sub';
        const clipCount = audioCounts[row] ?? 0;
        sub.textContent = `${clipCount} clip${clipCount === 1 ? '' : 's'}`;
        info.append(name, sub);
        const mute = trackButton('M', state.muted ? 'Unmute audio track' : 'Mute audio track', state.muted, () => {
          state.muted = !state.muted;
          render();
          seek(time);
          commit();
        });
        const solo = trackButton('S', state.solo ? 'Unsolo audio track' : 'Solo audio track', Boolean(state.solo), () => {
          state.solo = !state.solo;
          render();
          seek(time);
          commit();
        });
        solo.classList.add('vt-track-solo');
        const lock = lockTrackButton(Boolean(state.locked), () => {
          state.locked = !state.locked;
          render();
          seek(time);
          commit();
          status.textContent = state.locked ? `Audio track ${row + 1} locked.` : `Audio track ${row + 1} unlocked.`;
        });
        head.append(badge, info, mute, solo, lock);
        addTrackResizeHandles(head, 'audio', row);
        audioGroup.append(head);
      }
      trackHeaderList.append(audioGroup);
    }
  }

  /** Repaint the timeline lanes without replacing the inspector's controls. */
  interface VideoDetailRange {
    start: number;
    end: number;
    scale: number;
    frames: number;
    trimStart: number;
    speed: number;
    left: number;
    width: number;
  }
  interface AudioDetailRange {
    start: number;
    end: number;
    scale: number;
    buckets: number;
    trimStart: number;
    left: number;
    width: number;
  }
  interface SoundDetailRange {
    start: number;
    end: number;
    scale: number;
    buckets: number;
    trimStart: number;
    speed: number;
    left: number;
    width: number;
  }
  interface VideoBlockEntry {
    el: HTMLElement;
    clip: VideoClip;
    stripRef: Strip;
    stripCount: number;
    soundKind: '' | 'wave' | 'band';
    waveKey: string;
    detailCanvas: HTMLCanvasElement | null;
    detailRange: VideoDetailRange | null;
    detailKey: string;
    detailPending: boolean;
    stripLoading: HTMLElement | null;
    soundDetailCanvas: HTMLCanvasElement | null;
    soundDetailRange: SoundDetailRange | null;
    soundDetailKey: string;
    soundDetailDraft: boolean;
    transitionKey: string;
    transitionEls: HTMLElement[];
  }
  interface AudioBlockEntry {
    el: HTMLElement;
    clip: AudioClip;
    selected: boolean;
    waveKey: string;
    detailCanvas: HTMLCanvasElement | null;
    detailRange: AudioDetailRange | null;
    detailKey: string;
    detailDraft: boolean;
    detailPending: boolean;
    waveLoading: HTMLElement | null;
  }
  interface GraphicBlockEntry {
    el: HTMLElement;
    graphic: GraphicClip;
    index: number;
    badge: HTMLElement;
    labelEl: HTMLElement;
    geometryKey: string;
    classKey: string;
    label: string;
    aria: string;
    title: string;
    ariaPressed: string;
  }
  interface TitleBlockEntry {
    el: HTMLElement;
    cue: Cue;
    index: number;
    labelEl: HTMLElement;
    geometryKey: string;
    classKey: string;
    label: string;
    aria: string;
    title: string;
    ariaPressed: string;
  }
  const videoBlockEntries = new Map<number, VideoBlockEntry>();
  const audioBlockEntries = new Map<number, AudioBlockEntry>();
  const graphicBlockEntries = new Map<number, GraphicBlockEntry>();
  const titleBlockEntries = new Map<Cue, TitleBlockEntry>();

  /** Repaint selected clip outlines without rebuilding the timeline. */
  function paintClipSelection(): void {
    for (const [id, entry] of videoBlockEntries) {
      const active = isClipSelected('video', id);
      entry.el.classList.toggle('selected', active);
      entry.el.setAttribute('aria-pressed', String(active));
      for (const element of entry.transitionEls) element.classList.toggle('selected', active);
    }
    for (const [id, entry] of audioBlockEntries) {
      const active = isClipSelected('audio', id);
      entry.el.classList.toggle('selected', active);
      entry.el.setAttribute('aria-pressed', String(active));
    }
  }

  function filmstripIdealTile(clip: VideoClip): number {
    const aspect = clip.probe.width > 0 && clip.probe.height > 0
      ? clip.probe.width / clip.probe.height
      : 16 / 9;
    return Math.max(34, Math.min(180, videoTrackHeight(clip.track) * aspect));
  }

  function filmstripCount(clip: VideoClip, width: number): number {
    return Math.max(1, Math.ceil(width / filmstripIdealTile(clip)));
  }

  function videoSoundKind(clip: VideoClip): '' | 'wave' | 'band' {
    if (clip.image || !clip.probe.hasAudio || clip.linkGroup) return '';
    return clip.peaks ? 'wave' : 'band';
  }

  function videoWaveKey(clip: VideoClip, width: number): string {
    return `${clip.trimStart}|${clip.trimEnd}|${clip.duration}|${clip.peaks?.length ?? 0}|${Math.round(width)}`;
  }

  function audioWaveKey(clip: AudioClip, width: number): string {
    return `${clip.trimStart}|${clip.trimEnd}|${clip.fadeIn}|${clip.fadeOut}|${clip.muted}|${clip.peaks?.length ?? 0}|${Math.round(width)}`;
  }

  const clipBadgeKeys = new WeakMap<HTMLElement, string>();
  function renderClipBadges(block: HTMLElement, clip: VideoClip): void {
    renderSpeedBands(block, clip);
    const badges = effectBadges(clip.effects, clip.animation);
    if (clip.transition) badges.push(motionTransitionLabel(clip.transition));
    if (clip.proxy) badges.push('Proxy');
    const key = badges.join('|');
    if (clipBadgeKeys.get(block) === key) return;
    clipBadgeKeys.set(block, key);
    let strip = block.querySelector<HTMLElement>('.vt-clip-badges');
    if (!badges.length) {
      strip?.remove();
      return;
    }
    if (!strip) {
      strip = document.createElement('span');
      strip.className = 'vt-clip-badges';
      block.append(strip);
    }
    strip.replaceChildren();
    for (const badge of badges) {
      const chip = document.createElement('span');
      chip.textContent = badge;
      strip.append(chip);
    }
  }

  function renderSpeedBands(block: HTMLElement, clip: VideoClip): void {
    const shown = !clip.image && (clip.effects.speed !== 1 || Boolean(clip.effects.speedPoints?.length));
    const spans = shown ? clipSpeedSpans(clip) : [];
    const key = spans.map(({ start, end, rate }) => [start, end, rate].join(':')).join('|');
    if ((block.dataset.speedBands ?? '') === key) return;
    block.dataset.speedBands = key;
    block.querySelector('.vt-speed-bands')?.remove();
    if (!spans.length) return;
    const total = spans[spans.length - 1].end;
    const row = document.createElement('span');
    row.className = 'vt-speed-bands';
    row.setAttribute('aria-hidden', 'true');
    for (const span of spans) {
      const band = document.createElement('span');
      band.style.flexBasis = ((span.end - span.start) / total * 100) + '%';
      band.textContent = Math.round(span.rate * 100) + '%';
      row.append(band);
    }
    block.append(row);
  }

  interface TransitionDisplay {
    edge: 'start' | 'end';
    type: ClipTransitionType;
    duration: number;
    alignment: TransitionAlignment;
  }

  function transitionDisplayLabel(display: TransitionDisplay): string {
    if (display.type === 'dip') return display.edge === 'start' ? 'Dip in' : 'Dip out';
    return TRANSITION_TYPES.find((entry) => entry.value === display.type)?.label ?? 'Transition';
  }

  /** Transition markers for a clip, including fades saved before they carried metadata. */
  function videoTransitionDisplays(clip: VideoClip): TransitionDisplay[] {
    const length = videoClipLength(clip);
    const transition = clip.transition;
    if (transition) {
      const alignment = transition.alignment ?? 'center';
      if (transition.type === 'dip') {
        return [
          { edge: 'start', type: transition.type, duration: transition.duration, alignment },
          { edge: 'end', type: transition.type, duration: transition.duration, alignment },
        ];
      }
      if (transition.type === 'fade-out') {
        return [{ edge: 'end', type: transition.type, duration: transition.duration, alignment }];
      }
      return [{ edge: 'start', type: transition.type, duration: transition.duration, alignment }];
    }
    const keys = [...normalizeAnimation(clip.animation).opacity].sort((a, b) => a.at - b.at);
    if (!keys.length) return [];
    const at = (time: number) => keys.find((key) => Math.abs(key.at - time) < 0.02) ?? null;
    const startOne = keys.find((key) => key.at > 0.01 && key.at <= 1.5 && key.value === 1) ?? null;
    const endOne = [...keys].reverse().find((key) =>
      key.at < length - 0.01 && key.at >= length - 1.5 && key.value === 1) ?? null;
    const displays: TransitionDisplay[] = [];
    if (at(0)?.value === 0 && startOne) {
      displays.push({ edge: 'start', type: 'fade-in', duration: startOne.at, alignment: 'center' });
    }
    if (at(length)?.value === 0 && endOne) {
      displays.push({ edge: 'end', type: 'fade-out', duration: length - endOne.at, alignment: 'center' });
    }
    if (displays.length === 2) {
      displays[0].type = 'dip';
      displays[1].type = 'dip';
    }
    return displays;
  }

  function videoTransitionMaxDuration(clip: VideoClip, type: ClipTransitionType): number {
    if (isMotionTransitionType(type)) return 2;
    return Math.max(0.1, Math.min(2, videoClipLength(clip) / 2));
  }

  function updateVideoTransitionOverlayElement(
    element: HTMLElement,
    display: TransitionDisplay,
    clip: VideoClip,
    scale: number,
  ): void {
    const length = videoClipLength(clip);
    const laneHeight = videoTrackHeight(clip.track);
    const height = Math.max(24, Math.min(38, Math.round(laneHeight * 0.54)));
    const top = trackTopPad() + videoTrackTop(clip.track) + Math.round((laneHeight - height) / 2);
    const width = Math.max(64, Math.min(210, display.duration * scale));
    const edge = (display.edge === 'start' ? clip.start : clip.start + length) * scale;
    const left = display.alignment === 'start'
      ? edge
      : display.alignment === 'end'
        ? edge - width
        : edge - width / 2;
    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
    element.style.width = `${width}px`;
    element.style.height = `${height}px`;
    element.dataset.transitionEdge = display.edge;
    element.dataset.transitionAlignment = display.alignment;
    element.title = `${transitionDisplayLabel(display)} · ${display.duration.toFixed(2)}s · ${display.alignment}`;
    const label = element.querySelector<HTMLElement>('.vt-transition-label');
    if (label) label.textContent = transitionDisplayLabel(display);
    for (const handle of element.querySelectorAll<HTMLElement>('.vt-transition-handle')) {
      const locked = (display.alignment === 'start' && handle.dataset.side === 'left') ||
        (display.alignment === 'end' && handle.dataset.side === 'right');
      handle.classList.toggle('locked', locked);
      handle.tabIndex = locked ? -1 : 0;
      handle.setAttribute('aria-disabled', String(locked));
    }
    element.classList.toggle('is-hidden', videoTrackHidden(clip.track));
    element.classList.toggle('is-muted', clip.mute || videoTrackMuted(clip.track));
    element.classList.toggle('locked', videoTrackLocked(clip.track));
    element.classList.toggle('selected', isClipSelected('video', clip.id));
  }

  function refreshVideoTransitionOverlays(entry: VideoBlockEntry, clip: VideoClip, scale: number): void {
    const displays = videoTransitionDisplays(clip);
    displays.forEach((display, index) => {
      const element = entry.transitionEls[index];
      if (element) updateVideoTransitionOverlayElement(element, display, clip, scale);
    });
    entry.transitionKey = displays.map((display) =>
      `${display.edge}:${display.type}:${display.duration.toFixed(3)}:${display.alignment}`).join('|');
  }

  function bindVideoTransitionResize(
    handle: HTMLElement,
    side: -1 | 1,
    entry: VideoBlockEntry,
    clip: VideoClip,
  ): void {
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      const transition = normalizeClipTransition(clip.transition);
      if (!transition || videoClipLocked(clip)) {
        if (transition) lockedNotice();
        return;
      }
      const alignment = transition.alignment ?? 'center';
      if ((alignment === 'start' && side === -1) || (alignment === 'end' && side === 1)) return;
      event.preventDefault();
      event.stopPropagation();
      const startX = event.clientX;
      const startDuration = transition.duration;
      const scale = pps();
      const factor = (transition.alignment ?? 'center') === 'center' ? 2 : 1;
      const maxDuration = videoTransitionMaxDuration(clip, transition.type);
      const overlay = entry.transitionEls.find((element) => element.contains(handle));
      try { handle.setPointerCapture(event.pointerId); } catch { /* synthetic or already released */ }
      overlay?.classList.add('dragging');
      document.body.classList.add('transition-resizing');
      const applyDuration = (next: number): void => {
        const current = normalizeClipTransition(clip.transition);
        if (!current) return;
        const clamped = Math.max(0.1, Math.min(maxDuration, next));
        if (Math.abs(clamped - current.duration) < 0.002) return;
        writeVideoTransition(clip, current.type, clamped, current.alignment ?? 'center');
        refreshVideoTransitionOverlays(entry, clip, scale);
        const input = document.querySelector<HTMLInputElement>(
          '[data-inspector-section="transition"] input[type="number"]',
        );
        if (input) input.value = String(Math.round(clamped * 100) / 100);
        status.textContent = `Transition length ${clamped.toFixed(2)}s.`;
      };
      const move = (moveEvent: PointerEvent): void => {
        const delta = (moveEvent.clientX - startX) / scale;
        applyDuration(startDuration + side * factor * delta);
      };
      const up = (): void => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        document.body.classList.remove('transition-resizing');
        overlay?.classList.remove('dragging');
        render();
        seek(time);
        commit('Adjusted transition');
        const current = normalizeClipTransition(clip.transition);
        if (current) status.textContent = `Transition length ${current.duration.toFixed(2)}s.`;
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });
    handle.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      const transition = normalizeClipTransition(clip.transition);
      if (!transition || videoClipLocked(clip)) return;
      const alignment = transition.alignment ?? 'center';
      if ((alignment === 'start' && side === -1) || (alignment === 'end' && side === 1)) return;
      event.preventDefault();
      event.stopPropagation();
      const step = event.shiftKey ? 0.25 : 0.05;
      const factor = (transition.alignment ?? 'center') === 'center' ? 2 : 1;
      const direction = event.key === 'ArrowRight' ? 1 : -1;
      const next = transition.duration + side * factor * direction * step;
      writeVideoTransition(
        clip,
        transition.type,
        Math.max(0.1, Math.min(videoTransitionMaxDuration(clip, transition.type), next)),
        transition.alignment ?? 'center',
      );
      render();
      seek(time);
      commit('Adjusted transition');
      const current = normalizeClipTransition(clip.transition);
      if (current) status.textContent = `Transition length ${current.duration.toFixed(2)}s.`;
    });
  }

  function updateVideoTransitionOverlays(entry: VideoBlockEntry, clip: VideoClip, scale: number): void {
    const displays = videoTransitionDisplays(clip);
    const key = displays.map((display) =>
      `${display.edge}:${display.type}:${display.duration.toFixed(3)}:${display.alignment}`).join('|');
    if (entry.transitionKey !== key) {
      for (const element of entry.transitionEls) element.remove();
      entry.transitionEls = displays.map(() => {
        const element = document.createElement('span');
        element.className = 'vt-transition';
        const left = document.createElement('span');
        left.className = 'vt-transition-handle left';
        left.dataset.side = 'left';
        left.title = 'Drag to change transition length';
        left.setAttribute('role', 'separator');
        left.setAttribute('aria-orientation', 'vertical');
        left.setAttribute('aria-label', 'Adjust transition start edge');
        const label = document.createElement('span');
        label.className = 'vt-transition-label';
        const right = document.createElement('span');
        right.className = 'vt-transition-handle right';
        right.dataset.side = 'right';
        right.title = 'Drag to change transition length';
        right.setAttribute('role', 'separator');
        right.setAttribute('aria-orientation', 'vertical');
        right.setAttribute('aria-label', 'Adjust transition end edge');
        element.append(left, label, right);
        bindVideoTransitionResize(left, -1, entry, clip);
        bindVideoTransitionResize(right, 1, entry, clip);
        videoLane.append(element);
        return element;
      });
      entry.transitionKey = key;
    }
    displays.forEach((display, index) => {
      const element = entry.transitionEls[index];
      if (element) updateVideoTransitionOverlayElement(element, display, clip, scale);
    });
  }

  function updateVideoBlock(entry: VideoBlockEntry, clip: VideoClip, scale: number): void {
    const block = entry.el;
    const length = videoClipLength(clip);
    const width = Math.max(12, length * scale - 2);
    block.style.left = `${clip.start * scale}px`;
    block.style.top = `${trackTopPad() + videoTrackTop(clip.track)}px`;
    block.style.height = `${videoTrackHeight(clip.track)}px`;
    block.style.bottom = 'auto';
    block.style.width = `${width}px`;
    block.classList.toggle('selected', isClipSelected('video', clip.id));
    block.classList.toggle('is-muted', clip.mute || videoTrackMuted(clip.track));
    block.classList.toggle('is-hidden', videoTrackHidden(clip.track));
    block.classList.toggle('locked', videoTrackLocked(clip.track));
    const trackColor = videoTrackState[clip.track]?.color;
    block.classList.toggle('has-track-color', Boolean(trackColor));
    if (trackColor) block.style.setProperty('--track-color', trackColor);
    else block.style.removeProperty('--track-color');
    block.setAttribute('aria-pressed', String(isClipSelected('video', clip.id)));
    block.title = `${clip.name}\nDrag to move · drag the edges to trim${clip.image ? ' or lengthen' : ''}`;
    let syncBadge = block.querySelector<HTMLElement>('.vt-sync-badge');
    if (!syncBadge) {
      syncBadge = document.createElement('span');
      syncBadge.className = 'vt-sync-badge hidden';
      block.append(syncBadge);
    }
    const syncOffset = videoSyncOffset(clip);
    const outOfSync = syncOffset !== null && Math.abs(syncOffset) > 0.02;
    block.classList.toggle('linked', syncOffset !== null);
    block.classList.toggle('out-of-sync', outOfSync);
    syncBadge.classList.toggle('hidden', !outOfSync);
    if (outOfSync) syncBadge.textContent = `A/V ${syncOffset > 0 ? '+' : ''}${syncOffset.toFixed(2)}s`;
    const label = block.querySelector<HTMLElement>('.vt-clip-label');
    if (label) label.textContent = `${clip.image ? '🖼 ' : ''}${clip.name} · ${formatClock(length)}`;
    renderClipBadges(block, clip);

    if (clip.image) {
      if (entry.stripRef !== clip.strip) {
        entry.stripRef = clip.strip;
        const url = stripUrl(clip.strip);
        block.style.backgroundImage = url ? `url("${url}")` : '';
        block.style.backgroundSize = 'auto 100%';
        block.style.backgroundRepeat = 'repeat-x';
        block.style.backgroundPosition = '0 0';
      }
    } else {
      const count = filmstripCount(clip, width);
      const changed = entry.stripRef !== clip.strip || entry.stripCount !== count;
      if (changed || count > FILMSTRIP_FRAMES) {
        entry.stripRef = clip.strip;
        entry.stripCount = count;
        if (changed) {
          block.querySelector('.vt-filmstrip')?.remove();
          block.style.backgroundImage = '';
          block.style.backgroundSize = '';
          block.style.backgroundRepeat = '';
          block.style.backgroundPosition = '';
        }
        if (clip.strip) addFilmstrip(block, clip, width);
      }
    }

    const soundKind = videoSoundKind(clip);
    if (clip.linkGroup) {
      block.querySelectorAll('.vt-sound-band, .vt-sound-wave, .vt-sound-wave-detail')
        .forEach((element) => element.remove());
      entry.soundDetailCanvas = null;
      entry.soundDetailRange = null;
      entry.soundDetailKey = '';
      entry.soundDetailDraft = false;
    }
    if (soundKind !== entry.soundKind) {
      block.querySelectorAll('.vt-sound-band, .vt-sound-wave, .vt-sound-wave-detail')
        .forEach((element) => element.remove());
      entry.soundKind = soundKind;
      entry.waveKey = '';
      entry.soundDetailRange = null;
      entry.soundDetailKey = '';
      entry.soundDetailDraft = false;
      if (soundKind) {
        const sound = document.createElement(soundKind === 'wave' ? 'canvas' : 'span');
        sound.className = soundKind === 'wave' ? 'vt-sound-wave' : 'vt-sound-band';
        sound.title = clip.mute ? 'Own sound is muted' : 'Own sound moves with this clip';
        if (soundKind === 'wave') {
          const detail = document.createElement('canvas');
          detail.className = 'vt-sound-wave-detail hidden';
          block.append(sound, detail);
        } else {
          block.append(sound);
        }
      }
      entry.soundDetailCanvas = block.querySelector<HTMLCanvasElement>('.vt-sound-wave-detail');
    }
    if (soundKind === 'wave' && clip.peaks) {
      const wave = block.querySelector<HTMLCanvasElement>('.vt-sound-wave');
      const key = videoWaveKey(clip, width);
      if (wave && key !== entry.waveKey) {
        drawVideoWave(wave, clip, width);
        entry.waveKey = key;
      }
    }
    updateVideoTransitionOverlays(entry, clip, scale);
    updateVideoLoading(entry);
  }

  function updateAudioBlock(entry: AudioBlockEntry, clip: AudioClip, scale: number, row: number, trackMuted: boolean): void {
    const block = entry.el;
    const width = Math.max(12, audioClipLength(clip) * scale);
    block.style.left = `${clip.offset * scale}px`;
    block.style.top = `${trackTopPad() + audioTrackTop(row)}px`;
    block.style.height = `${audioTrackHeight(row)}px`;
    block.style.bottom = 'auto';
    block.style.width = `${width}px`;
    block.classList.toggle('selected', isClipSelected('audio', clip.id));
    block.classList.toggle('muted', clip.muted || trackMuted);
    block.classList.toggle('locked', audioTrackLocked(row));
    const trackColor = audioTrackState[row]?.color;
    block.classList.toggle('has-track-color', Boolean(trackColor));
    if (trackColor) block.style.setProperty('--track-color', trackColor);
    else block.style.removeProperty('--track-color');
    block.setAttribute('aria-pressed', String(isClipSelected('audio', clip.id)));
    block.title = `${clip.name}\nDrag to move · drag the edges to trim · drag the top corners to fade`;
    let syncBadge = block.querySelector<HTMLElement>('.vt-sync-badge');
    if (!syncBadge) {
      syncBadge = document.createElement('span');
      syncBadge.className = 'vt-sync-badge hidden';
      block.append(syncBadge);
    }
    const syncOffset = audioSyncOffset(clip);
    const outOfSync = syncOffset !== null && Math.abs(syncOffset) > 0.02;
    block.classList.toggle('linked', syncOffset !== null);
    block.classList.toggle('out-of-sync', outOfSync);
    syncBadge.classList.toggle('hidden', !outOfSync);
    if (outOfSync) syncBadge.textContent = `A/V ${syncOffset > 0 ? '+' : ''}${syncOffset.toFixed(2)}s`;
    const label = block.querySelector<HTMLElement>('.vt-clip-label');
    if (label) label.textContent = clip.name;
    const canvas = block.querySelector<HTMLCanvasElement>('canvas');
    const key = audioWaveKey(clip, width);
    if (canvas && key !== entry.waveKey) {
      drawWave(canvas, clip, width);
      entry.waveKey = key;
    }
    const fadeIn = block.querySelector<HTMLElement>('.vt-fade-in');
    const fadeOut = block.querySelector<HTMLElement>('.vt-fade-out');
    if (fadeIn && fadeOut) {
      const current = audioClipLength(clip);
      fadeIn.style.left = `${Math.min(width - 16, Math.max(11, (clip.fadeIn / Math.max(0.001, current)) * width))}px`;
      fadeOut.style.right = `${Math.min(width - 16, Math.max(11, (clip.fadeOut / Math.max(0.001, current)) * width))}px`;
    }
    updateAudioLoading(entry);
  }

  function titleTrackIndex(cue: Cue): number {
    const track = Number(cue.track);
    return Number.isFinite(track) ? Math.max(0, Math.round(track)) : 0;
  }

  function activateTitle(index: number): void {
    const cue = titles[index];
    if (!cue) return;
    selected = null;
    selectedTitle = index;
    selectedSubtitleKey = '';
    selectedGraphic = -1;
    seek(cue.start);
    selectSideTab('text');
    ensureInspectorOpen();
    renderTitlePanel();
    renderTitleBlocks(pps());
    renderGraphicBlocks(pps());
    captionLaneKey = '';
    renderCaptionLane(pps());
    updateTitleOverlay();
    updateGraphicOverlay();
  }

  function beginTitleTimelineDrag(event: PointerEvent, block: HTMLElement, cue: Cue, index: number): void {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    selected = null;
    selectedTitle = index;
    selectedSubtitleKey = '';
    selectedGraphic = -1;
    clearSelection(block);
    selectSideTab('text');
    ensureInspectorOpen();
    if (time < cue.start || time >= cue.end) seek(cue.start);
    renderTitlePanel();
    updateTitleOverlay();
    updateGraphicOverlay();
    if (videoTrackLocked(titleTrackIndex(cue))) {
      lockedNotice();
      return;
    }
    const origin = {
      x: event.clientX,
      y: event.clientY,
      start: cue.start,
      end: cue.end,
      track: titleTrackIndex(cue),
      scrollLeft: scroll.scrollLeft,
    };
    let dragging = false;
    const apply = (clientX: number, clientY: number): void => {
      const deltaPx = clientX - origin.x + (scroll.scrollLeft - origin.scrollLeft);
      if (!dragging && Math.hypot(deltaPx, clientY - origin.y) < 5) return;
      dragging = true;
      block.classList.add('dragging');
      const length = origin.end - origin.start;
      cue.start = Math.max(0, origin.start + deltaPx / pps());
      cue.end = cue.start + length;
      const laneTop = videoLane.getBoundingClientRect().top + trackTopPad();
      const targetTrack = Math.max(0, trackAtOffset(clientY - laneTop, videoTrackHeights, videoRowHeight(), videoTrackCount));
      if (targetTrack >= videoTrackCount) {
        videoTrackCount = targetTrack + 1;
        ensureTrackStates(videoTrackCount, audioTrackCount);
        status.textContent = `New video track V${videoTrackCount} created.`;
      }
      cue.track = targetTrack;
      block.style.left = `${cue.start * pps()}px`;
      block.style.width = `${Math.max(12, length * pps() - 2)}px`;
      block.style.top = `${trackTopPad() + videoTrackTop(targetTrack)}px`;
      block.style.height = `${videoTrackHeight(targetTrack)}px`;
      layoutVideoLane();
      positionPlayhead();
      renderTitlePanel();
      updateTitleOverlay();
    };
    const move = (moveEvent: PointerEvent): void => {
      if (moveEvent.pointerId !== event.pointerId) return;
      apply(moveEvent.clientX, moveEvent.clientY);
    };
    const up = (upEvent: PointerEvent): void => {
      if (upEvent.pointerId !== event.pointerId) return;
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', up);
      if (dragging) {
        renderTimeline();
        commit('Moved title');
      }
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
  }

  function createTitleBlock(cue: Cue): TitleBlockEntry {
    const el = document.createElement('div');
    el.className = 'vt-clip vt-clip-title';
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
    const badge = document.createElement('span');
    badge.className = 'vt-title-badge';
    badge.textContent = 'T';
    const labelEl = document.createElement('span');
    labelEl.className = 'vt-clip-label';
    el.append(badge, labelEl);
    const entry: TitleBlockEntry = {
      el, cue, index: -1, labelEl,
      geometryKey: '', classKey: '', label: '', aria: '', title: '', ariaPressed: '',
    };
    const startHandle = document.createElement('span');
    startHandle.className = 'vt-gen-handle start';
    startHandle.title = 'Drag to change the title start';
    startHandle.addEventListener('pointerdown', (event) => {
      const index = titles.indexOf(entry.cue);
      if (index >= 0) beginTitleLengthDrag(event, entry.cue, index, 'start');
    });
    const endHandle = document.createElement('span');
    endHandle.className = 'vt-gen-handle end';
    endHandle.title = 'Drag to change the title end';
    endHandle.addEventListener('pointerdown', (event) => {
      const index = titles.indexOf(entry.cue);
      if (index >= 0) beginTitleLengthDrag(event, entry.cue, index, 'end');
    });
    el.append(startHandle, endHandle);
    el.addEventListener('pointerdown', (event) => {
      const index = titles.indexOf(entry.cue);
      if (index >= 0) beginTitleTimelineDrag(event, el, entry.cue, index);
    });
    el.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        event.stopPropagation();
        const index = titles.indexOf(entry.cue);
        if (index >= 0) activateTitle(index);
      }
    });
    return entry;
  }

  function updateTitleBlock(entry: TitleBlockEntry, index: number, scale: number): void {
    const cue = entry.cue;
    const block = entry.el;
    const track = titleTrackIndex(cue);
    cue.track = track;
    const selectedNow = index === selectedTitle;
    const hiddenNow = videoTrackHidden(track);
    const lockedNow = videoTrackLocked(track);
    const trackColor = videoTrackState[track]?.color;
    const classKey = `${selectedNow ? 1 : 0}${hiddenNow ? 1 : 0}${lockedNow ? 1 : 0}${trackColor ? 1 : 0}`;
    if (entry.classKey !== classKey) {
      entry.classKey = classKey;
      block.classList.toggle('selected', selectedNow);
      block.classList.toggle('is-hidden', hiddenNow);
      block.classList.toggle('locked', lockedNow);
      block.classList.toggle('has-track-color', Boolean(trackColor));
    }
    const pressed = String(selectedNow);
    if (entry.ariaPressed !== pressed) {
      entry.ariaPressed = pressed;
      block.setAttribute('aria-pressed', pressed);
    }
    const label = `${cue.text.trim() || 'Title'} · ${formatClock(cue.end - cue.start)}`;
    if (entry.label !== label) {
      entry.label = label;
      entry.labelEl.textContent = label;
    }
    const aria = `Title at ${formatClock(cue.start, true)}: ${cue.text}`;
    if (entry.aria !== aria) {
      entry.aria = aria;
      block.setAttribute('aria-label', aria);
    }
    const title = `${cue.text}\nDrag to move across video tracks · drag the edges to trim`;
    if (entry.title !== title) {
      entry.title = title;
      block.title = title;
    }
    const top = trackTopPad() + videoTrackTop(track);
    const height = videoTrackHeight(track);
    const geometryKey = `${index}|${cue.start}|${cue.end}|${scale}|${top}|${height}|${trackColor ?? ''}`;
    if (entry.geometryKey !== geometryKey) {
      entry.geometryKey = geometryKey;
      block.dataset.titleIndex = String(index);
      block.style.left = `${cue.start * scale}px`;
      block.style.top = `${top}px`;
      block.style.height = `${height}px`;
      block.style.width = `${Math.max(12, (cue.end - cue.start) * scale - 2)}px`;
      if (trackColor) block.style.setProperty('--track-color', trackColor);
      else block.style.removeProperty('--track-color');
    }
  }

  function layoutTitleTimeline(cue: Cue, index: number): void {
    invalidateTimelineDerived();
    const scale = pps();
    const entry = titleBlockEntries.get(cue);
    if (entry) updateTitleBlock(entry, index, scale);
    const length = timelineLength();
    content.style.width = `${Math.ceil(length * scale)}px`;
    renderRuler(scale, length);
    positionPlayhead();
  }

  function renderTitleBlocks(scale: number): void {
    const range = timelineWindow(scale);
    const visible = new Set<Cue>();
    for (const [index, cue] of titles.entries()) {
      if (cue.end <= 0 || cue.start >= contentEnd() + 0.05) continue;
      if (!inTimelineWindow(cue.start, cue.end, range, index === selectedTitle)) continue;
      visible.add(cue);
      let entry = titleBlockEntries.get(cue);
      if (!entry) {
        entry = createTitleBlock(cue);
        titleBlockEntries.set(cue, entry);
        let before: HTMLElement | null = null;
        for (let next = index + 1; next < titles.length; next += 1) {
          const nextEntry = titleBlockEntries.get(titles[next]);
          if (nextEntry?.el.isConnected) {
            before = nextEntry.el;
            break;
          }
        }
        if (before) videoLane.insertBefore(entry.el, before);
        else videoLane.append(entry.el);
      }
      updateTitleBlock(entry, index, scale);
    }
    for (const [cue, entry] of titleBlockEntries) {
      if (visible.has(cue)) continue;
      entry.el.remove();
      titleBlockEntries.delete(cue);
    }
  }

  function syncVideoBlockEntries(scale: number, range: TimelineWindow): void {
    const videoIds = new Set(videos.map((clip) => clip.id));
    for (const [id, entry] of videoBlockEntries) {
      const clip = entry.clip;
      const visible = videoIds.has(id) && inTimelineWindow(
        clip.start,
        clip.start + videoClipLength(clip),
        range,
        isClipSelected('video', id),
      );
      if (visible) continue;
      entry.el.remove();
      for (const element of entry.transitionEls) element.remove();
      videoBlockEntries.delete(id);
    }
    for (const clip of [...videos].sort((a, b) => a.track - b.track || a.start - b.start)) {
      if (!inTimelineWindow(
        clip.start,
        clip.start + videoClipLength(clip),
        range,
        isClipSelected('video', clip.id),
      )) continue;
      let entry = videoBlockEntries.get(clip.id);
      if (entry && entry.clip !== clip) {
        entry.el.remove();
        for (const element of entry.transitionEls) element.remove();
        videoBlockEntries.delete(clip.id);
        entry = undefined;
      }
      if (!entry) {
        const el = videoBlock(clip, scale);
        const width = Math.max(12, videoClipLength(clip) * scale - 2);
        entry = {
          el,
          clip,
          stripRef: clip.strip,
          stripCount: clip.image ? 0 : filmstripCount(clip, width),
          soundKind: videoSoundKind(clip),
          waveKey: videoSoundKind(clip) === 'wave' ? videoWaveKey(clip, width) : '',
          detailCanvas: el.querySelector<HTMLCanvasElement>('.vt-filmstrip-detail'),
          detailRange: null,
          detailKey: '',
          detailPending: false,
          stripLoading: el.querySelector<HTMLElement>('.vt-filmstrip-loading'),
          soundDetailCanvas: el.querySelector<HTMLCanvasElement>('.vt-sound-wave-detail'),
          soundDetailRange: null,
          soundDetailKey: '',
          soundDetailDraft: false,
          transitionKey: '',
          transitionEls: [],
        };
        videoBlockEntries.set(clip.id, entry);
        videoLane.append(el);
      }
      updateVideoBlock(entry, clip, scale);
    }
  }

  function syncAudioBlockEntries(scale: number, rows: Map<number, number>, range: TimelineWindow): void {
    const audioIds = new Set(audios.map((clip) => clip.id));
    for (const [id, entry] of audioBlockEntries) {
      const clip = entry.clip;
      const visible = audioIds.has(id) && inTimelineWindow(
        clip.offset,
        clip.offset + audioClipLength(clip),
        range,
        isClipSelected('audio', id),
      );
      if (visible) continue;
      entry.el.remove();
      audioBlockEntries.delete(id);
    }
    for (const clip of audios) {
      if (!inTimelineWindow(
        clip.offset,
        clip.offset + audioClipLength(clip),
        range,
        isClipSelected('audio', clip.id),
      )) continue;
      const row = rows.get(clip.id) ?? 0;
      const selectedNow = isClipSelected('audio', clip.id);
      let entry = audioBlockEntries.get(clip.id);
      if (entry && (entry.clip !== clip || entry.selected !== selectedNow)) {
        entry.el.remove();
        audioBlockEntries.delete(clip.id);
        entry = undefined;
      }
      if (!entry) {
        const el = audioBlock(clip, scale);
        const width = Math.max(12, audioClipLength(clip) * scale);
        entry = {
          el,
          clip,
          selected: selectedNow,
          waveKey: audioWaveKey(clip, width),
          detailCanvas: el.querySelector<HTMLCanvasElement>('.vt-wave-detail'),
          detailRange: null,
          detailKey: '',
          detailDraft: false,
          detailPending: false,
          waveLoading: el.querySelector<HTMLElement>('.vt-wave-loading'),
        };
        audioBlockEntries.set(clip.id, entry);
        audioLane.append(el);
      }
      updateAudioBlock(entry, clip, scale, row, audioTrackMuted(row));
    }
  }

  let lastTimelineWindowLeft = 0;
  let timelineWindowFrame = 0;
  function syncTimelineWindow(): void {
    const scale = pps();
    const range = timelineWindow(scale);
    syncVideoBlockEntries(scale, range);
    syncAudioBlockEntries(scale, audioRows(), range);
    renderTitleBlocks(scale);
    renderGraphicBlocks(scale);
    lastTimelineWindowLeft = range.left;
    syncClipAnimation();
    scheduleClipLabelSync();
    scheduleDetailSync(80);
  }
  function scheduleTimelineWindowSync(): void {
    if (timelineWindowFrame) return;
    timelineWindowFrame = requestAnimationFrame(() => {
      timelineWindowFrame = 0;
      const width = Math.max(1, timelineViewportWidth || measureTimelineViewport());
      if (Math.abs(scroll.scrollLeft - lastTimelineWindowLeft) < width * 0.5) return;
      syncTimelineWindow();
    });
  }

  let clipLabelFrame = 0;
  function scheduleClipLabelSync(): void {
    if (clipLabelFrame) return;
    clipLabelFrame = requestAnimationFrame(() => {
      clipLabelFrame = 0;
      positionClipLabels();
    });
  }

  /** Keep each clip name inside the visible part of the timeline. */
  function positionClipLabels(): void {
    const scale = pps();
    const viewLeft = scroll.scrollLeft;
    const viewRight = viewLeft + Math.max(1, timelineViewportWidth || measureTimelineViewport());
    for (const entry of videoBlockEntries.values()) {
      const width = entry.el.clientWidth;
      if (!width) continue;
      const left = entry.clip.start * scale;
      const pinned = left + width > viewLeft && left < viewRight
        ? Math.max(left, viewLeft) - left + 8
        : 8;
      entry.el.style.setProperty(
        '--vt-label-left',
        `${Math.min(Math.max(8, pinned), Math.max(8, width - 16))}px`,
      );
    }
    for (const entry of audioBlockEntries.values()) {
      const width = entry.el.clientWidth;
      if (!width) continue;
      const left = entry.clip.offset * scale;
      const pinned = left + width > viewLeft && left < viewRight
        ? Math.max(left, viewLeft) - left + 8
        : 8;
      entry.el.style.setProperty(
        '--vt-label-left',
        `${Math.min(Math.max(8, pinned), Math.max(8, width - 16))}px`,
      );
    }
  }

  interface DetailWindow {
    start: number;
    end: number;
    viewStart: number;
    viewEnd: number;
  }

  let detailSyncTimer = 0;
  function scheduleDetailSync(delay = DETAIL_SYNC_DELAY): void {
    window.clearTimeout(detailSyncTimer);
    detailSyncTimer = window.setTimeout(() => {
      detailSyncTimer = 0;
      syncDetailLayers();
    }, delay);
  }

  function detailWindow(scale: number): DetailWindow {
    const width = Math.max(1, timelineViewportWidth || measureTimelineViewport());
    const viewStart = scroll.scrollLeft / scale;
    const viewEnd = (scroll.scrollLeft + width) / scale;
    const margin = Math.max(DETAIL_MARGIN_MIN_SECONDS, (viewEnd - viewStart) * DETAIL_MARGIN_RATIO);
    return {
      start: Math.max(0, viewStart - margin),
      end: viewEnd + margin,
      viewStart,
      viewEnd,
    };
  }

  function hideVideoDetail(entry: VideoBlockEntry): void {
    entry.detailRange = null;
    entry.detailKey = '';
    entry.detailPending = false;
    const canvas = entry.detailCanvas;
    if (canvas) {
      canvas.classList.add('hidden');
      canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
    }
    updateVideoLoading(entry);
  }

  function updateVideoLoading(entry: VideoBlockEntry): void {
    const loading = !entry.clip.image && (!entry.clip.strip || entry.detailPending);
    entry.stripLoading?.classList.toggle('hidden', !loading);
  }

  function hideAudioDetail(entry: AudioBlockEntry): void {
    entry.detailRange = null;
    entry.detailKey = '';
    entry.detailDraft = false;
    entry.detailPending = false;
    const canvas = entry.detailCanvas;
    if (canvas) {
      canvas.classList.add('hidden');
      canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
    }
    updateAudioLoading(entry);
  }

  function updateAudioLoading(entry: AudioBlockEntry): void {
    const loading = entry.detailPending || peaksPendingFor(entry.clip.file);
    entry.waveLoading?.classList.toggle('hidden', !loading);
  }

  function refreshWaveLoading(fileKey: string): void {
    for (const entry of audioBlockEntries.values()) {
      if (mediaKey(entry.clip.file) === fileKey) updateAudioLoading(entry);
    }
  }

  function drawFilmstripDetail(entry: VideoBlockEntry, detail: DetailStrip): void {
    const canvas = entry.detailCanvas;
    const range = entry.detailRange;
    if (!canvas || !range) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cssWidth = Math.max(1, range.width);
    const cssHeight = Math.max(1, entry.el.clientHeight);
    const pixelWidth = Math.max(1, Math.min(16384, Math.round(cssWidth * dpr)));
    const pixelHeight = Math.max(1, Math.round(cssHeight * dpr));
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    canvas.style.left = `${range.left}px`;
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = '100%';
    canvas.classList.remove('hidden');
    const context = canvas.getContext('2d');
    if (!context) return;
    const image = new Image();
    image.onload = () => {
      if (!canvas.isConnected || entry.detailRange !== range) return;
      context.clearRect(0, 0, pixelWidth, pixelHeight);
      context.drawImage(image, 0, 0, image.naturalWidth, image.naturalHeight, 0, 0, pixelWidth, pixelHeight);
      context.fillStyle = 'rgb(2 6 23 / 0.28)';
      const tileWidth = pixelWidth / range.frames;
      for (let index = 1; index < range.frames; index += 1) {
        context.fillRect(index * tileWidth, 0, Math.max(1, dpr), pixelHeight);
      }
      const vertical = context.createLinearGradient(0, 0, 0, pixelHeight);
      vertical.addColorStop(0, 'rgb(2 6 23 / 0.14)');
      vertical.addColorStop(0.45, 'transparent');
      vertical.addColorStop(1, 'rgb(2 6 23 / 0.22)');
      context.fillStyle = vertical;
      context.fillRect(0, 0, pixelWidth, pixelHeight);
      const horizontal = context.createLinearGradient(0, 0, pixelWidth, 0);
      horizontal.addColorStop(0, 'rgb(2 6 23 / 0.25)');
      horizontal.addColorStop(0.12, 'transparent');
      horizontal.addColorStop(0.88, 'transparent');
      horizontal.addColorStop(1, 'rgb(2 6 23 / 0.25)');
      context.fillStyle = horizontal;
      context.fillRect(0, 0, pixelWidth, pixelHeight);
    };
    image.src = detail.url;
  }

  function drawWaveDetail(entry: AudioBlockEntry, source: Float32Array | DetailEnvelope): void {
    const canvas = entry.detailCanvas;
    const range = entry.detailRange;
    if (!canvas || !range) return;
    const clip = entry.clip;
    const asymmetric = !(source instanceof Float32Array);
    const peaks = asymmetric ? null : source;
    const envelope = asymmetric ? source : null;
    const count = asymmetric ? envelope!.max.length : peaks!.length;
    if (!count) return;
    entry.detailDraft = !asymmetric;
    const width = Math.max(1, range.width);
    const height = 38;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const pixelWidth = Math.max(1, Math.min(MAX_WAVE_CANVAS_WIDTH, Math.round(width * dpr)));
    const pixelHeight = Math.round(height * dpr);
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    canvas.style.left = `${range.left}px`;
    canvas.style.width = `${width}px`;
    canvas.style.height = '100%';
    canvas.classList.remove('hidden');
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, pixelWidth, pixelHeight);
    let loudest = 0;
    if (clip.peaks) {
      for (const value of clip.peaks) if (value > loudest) loudest = value;
    } else if (asymmetric) {
      for (let index = 0; index < count; index += 1) {
        if (envelope!.max[index] > loudest) loudest = envelope!.max[index];
        if (-envelope!.min[index] > loudest) loudest = -envelope!.min[index];
      }
    } else {
      for (const value of peaks!) if (value > loudest) loudest = value;
    }
    const gain = Math.min(6, 0.92 / Math.max(0.001, loudest));
    if (clip.muted) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.16)';
    } else {
      const gradient = ctx.createLinearGradient(0, 0, 0, pixelHeight);
      gradient.addColorStop(0, 'rgba(255, 255, 255, 0.40)');
      gradient.addColorStop(0.5, 'rgba(255, 255, 255, 0.22)');
      gradient.addColorStop(1, 'rgba(255, 255, 255, 0.30)');
      ctx.fillStyle = gradient;
    }
    const columns = Math.max(1, Math.min(MAX_WAVE_CANVAS_WIDTH, pixelWidth));
    const step = pixelWidth / columns;
    const pad = Math.max(1, Math.round(5 * dpr));
    const rangeSeconds = Math.max(0.000001, range.end - range.start);
    const minBucketWindow = DETAIL_WAVE_WINDOW_SECONDS * (count / rangeSeconds);
    const tops = new Float32Array(columns);
    const bottoms = new Float32Array(columns);
    for (let column = 0; column < columns; column += 1) {
      const x = column * step;
      const centerBucket = ((x + step / 2) / pixelWidth) * count;
      const half = Math.max(((step / pixelWidth) * count) / 2, minBucketWindow / 2);
      let top: number;
      let bottom: number;
      if (asymmetric) {
        const first = Math.max(0, Math.floor(centerBucket - half));
        const last = Math.min(count - 1, Math.floor(centerBucket + half));
        let positive = 0;
        let negative = 0;
        for (let index = first; index <= last; index += 1) {
          if (envelope!.max[index] > positive) positive = envelope!.max[index];
          if (envelope!.min[index] < negative) negative = envelope!.min[index];
        }
        const pos = Math.pow(Math.min(1, positive * gain), 0.78);
        const neg = Math.pow(Math.min(1, -negative * gain), 0.78);
        top = pixelHeight / 2 - pos * (pixelHeight - pad) / 2;
        bottom = pixelHeight / 2 + neg * (pixelHeight - pad) / 2;
      } else {
        const peak = peakEnvelope(peaks!, centerBucket - half, centerBucket + half);
        const shaped = Math.pow(Math.min(1, peak * gain), 0.78);
        const h = Math.max(1, shaped * (pixelHeight - pad));
        top = (pixelHeight - h) / 2;
        bottom = top + h;
      }
      if (bottom - top < 1) {
        const middle = (top + bottom) / 2;
        top = middle - 0.5;
        bottom = middle + 0.5;
      }
      tops[column] = top;
      bottoms[column] = bottom;
      ctx.fillRect(x, top, step + 0.5, bottom - top);
    }
    // A bright edge makes the waveform shape readable instead of a white block.
    const edge = Math.max(1, Math.round(dpr));
    ctx.fillStyle = clip.muted ? 'rgba(255, 255, 255, 0.54)' : 'rgba(255, 255, 255, 0.98)';
    for (let column = 0; column < columns; column += 1) {
      const x = column * step;
      ctx.fillRect(x, tops[column], step + 0.5, edge);
      ctx.fillRect(x, bottoms[column] - edge, step + 0.5, edge);
    }
    ctx.fillStyle = 'rgba(255, 255, 255, 0.14)';
    ctx.fillRect(0, pixelHeight / 2, pixelWidth, Math.max(1, Math.round(dpr * 0.5)));
    const length = audioClipLength(clip);
    const fullWidthPx = Math.max(1, Math.round((entry.el.clientWidth || width) * dpr));
    const fadeIn = Math.min(clip.fadeIn, length / 2);
    const fadeOut = Math.min(clip.fadeOut, length / 2);
    if (fadeIn > 0 || fadeOut > 0) {
      ctx.save();
      ctx.translate(-range.left * dpr, 0);
      ctx.fillStyle = 'rgba(2, 6, 23, 0.55)';
      if (fadeIn > 0) {
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo((fadeIn / Math.max(0.001, length)) * fullWidthPx, 0);
        ctx.lineTo(0, pixelHeight);
        ctx.closePath();
        ctx.fill();
      }
      if (fadeOut > 0) {
        ctx.beginPath();
        ctx.moveTo(fullWidthPx, 0);
        ctx.lineTo(fullWidthPx - (fadeOut / Math.max(0.001, length)) * fullWidthPx, 0);
        ctx.lineTo(fullWidthPx, pixelHeight);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    }
  }

  function syncVideoDetail(entry: VideoBlockEntry, scale: number, detailView: DetailWindow): void {
    const clip = entry.clip;
    if (!entry.el.isConnected || !videos.includes(clip) || clip.image || clip.effects.speedPoints?.length) {
      hideVideoDetail(entry);
      return;
    }
    const fullWidth = entry.el.clientWidth || Math.max(12, videoClipLength(clip) * scale - 2);
    if (filmstripCount(clip, fullWidth) <= FILMSTRIP_FRAMES) {
      hideVideoDetail(entry);
      return;
    }
    const clipStart = clip.start;
    const clipEnd = clipStart + videoClipLength(clip);
    if (clipEnd <= detailView.viewStart || clipStart >= detailView.viewEnd) {
      hideVideoDetail(entry);
      return;
    }
    const visibleStart = Math.max(clipStart, detailView.start);
    const visibleEnd = Math.min(clipEnd, detailView.end);
    if (visibleEnd - visibleStart < 0.005) {
      hideVideoDetail(entry);
      return;
    }
    const speed = normalizeEffects(clip.effects).speed;
    const sourceFrom = clipSourceTime(clip, visibleStart - clipStart);
    const sourceTo = clipSourceTime(clip, visibleEnd - clipStart);
    const sourceVisibleFrom = clipSourceTime(clip, Math.max(clipStart, detailView.viewStart) - clipStart);
    const sourceVisibleTo = clipSourceTime(clip, Math.min(clipEnd, detailView.viewEnd) - clipStart);
    if (entry.detailRange
      && entry.detailRange.scale === scale
      && entry.detailRange.trimStart === clip.trimStart
      && entry.detailRange.speed === speed
      && entry.detailRange.start <= sourceVisibleFrom + 0.001
      && entry.detailRange.end >= sourceVisibleTo - 0.001) {
      return;
    }
    const detailLeft = (visibleStart - clipStart) * scale;
    const detailWidth = Math.max(1, (visibleEnd - visibleStart) * scale);
    // A slightly wider detail tile still matches the 256 px source frames but
    // cuts the number of decode seeks for large clips.
    const detailTile = Math.max(filmstripIdealTile(clip), 192);
    const frames = Math.max(2, Math.min(DETAIL_FRAMES_MAX, Math.ceil(detailWidth / detailTile)));
    const key = `${mediaKey(clip.file)}:${sourceFrom.toFixed(3)}:${sourceTo.toFixed(3)}:${frames}:${scale.toFixed(3)}`;
    if (entry.detailKey === key) return;
    entry.detailKey = key;
    entry.detailPending = true;
    updateVideoLoading(entry);
    const compatibility = clip.proxy?.compatibility && clip.proxyUrl ? clip.proxy : null;
    void detailStripFor(
      compatibility?.blob ?? clip.file, compatibility ? clip.proxyUrl : clip.url,
      clip.duration, sourceFrom, sourceTo, frames,
      compatibility ? `preview-compat-v1:${mediaKey(clip.file)}` : mediaKey(clip.file),
    ).then((detail) => {
      if (entry.detailKey !== key) return;
      entry.detailPending = false;
      updateVideoLoading(entry);
      if (!detail || !entry.el.isConnected || !videos.includes(clip)) return;
      entry.detailRange = {
        start: sourceFrom,
        end: sourceTo,
        scale,
        frames,
        trimStart: clip.trimStart,
        speed,
        left: detailLeft,
        width: detailWidth,
      };
      drawFilmstripDetail(entry, detail);
    }).catch(() => {
      if (entry.detailKey !== key) return;
      entry.detailPending = false;
      updateVideoLoading(entry);
    });
  }

  function hideVideoSoundDetail(entry: VideoBlockEntry): void {
    entry.soundDetailRange = null;
    entry.soundDetailKey = '';
    entry.soundDetailDraft = false;
    const canvas = entry.soundDetailCanvas;
    if (!canvas) return;
    canvas.classList.add('hidden');
    canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
  }

  function drawVideoSoundDetail(entry: VideoBlockEntry, source: Float32Array | DetailEnvelope): void {
    const canvas = entry.soundDetailCanvas;
    const range = entry.soundDetailRange;
    if (!canvas || !range) return;
    const clip = entry.clip;
    const asymmetric = !(source instanceof Float32Array);
    const peaks = asymmetric ? null : source;
    const envelope = asymmetric ? source : null;
    const count = asymmetric ? envelope!.max.length : peaks!.length;
    if (!count) return;
    entry.soundDetailDraft = !asymmetric;
    const width = Math.max(1, range.width);
    const height = 20;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const pixelWidth = Math.max(1, Math.min(MAX_WAVE_CANVAS_WIDTH, Math.round(width * dpr)));
    const pixelHeight = Math.round(height * dpr);
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    canvas.style.left = `${4 + range.left}px`;
    canvas.style.width = `${width}px`;
    canvas.style.height = '20px';
    canvas.classList.remove('hidden');
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, pixelWidth, pixelHeight);
    let loudest = 0;
    if (clip.peaks) {
      for (const value of clip.peaks) if (value > loudest) loudest = value;
    } else if (asymmetric) {
      for (let index = 0; index < count; index += 1) {
        if (envelope!.max[index] > loudest) loudest = envelope!.max[index];
        if (-envelope!.min[index] > loudest) loudest = -envelope!.min[index];
      }
    } else {
      for (const value of peaks!) if (value > loudest) loudest = value;
    }
    const gain = Math.min(8, 0.92 / Math.max(0.001, loudest));
    const gradient = ctx.createLinearGradient(0, 0, 0, pixelHeight);
    gradient.addColorStop(0, 'rgba(186, 230, 253, 0.78)');
    gradient.addColorStop(0.5, 'rgba(125, 211, 252, 0.56)');
    gradient.addColorStop(1, 'rgba(56, 189, 248, 0.68)');
    ctx.fillStyle = gradient;
    const columns = Math.max(1, Math.min(MAX_WAVE_CANVAS_WIDTH, pixelWidth));
    const step = pixelWidth / columns;
    const pad = Math.max(1, Math.round(3 * dpr));
    const rangeSeconds = Math.max(0.000001, range.end - range.start);
    const minBucketWindow = DETAIL_WAVE_WINDOW_SECONDS * (count / rangeSeconds);
    const tops = new Float32Array(columns);
    const bottoms = new Float32Array(columns);
    for (let column = 0; column < columns; column += 1) {
      const x = column * step;
      const centerBucket = ((x + step / 2) / pixelWidth) * count;
      const half = Math.max(((step / pixelWidth) * count) / 2, minBucketWindow / 2);
      let top: number;
      let bottom: number;
      if (asymmetric) {
        const first = Math.max(0, Math.floor(centerBucket - half));
        const last = Math.min(count - 1, Math.floor(centerBucket + half));
        let positive = 0;
        let negative = 0;
        for (let index = first; index <= last; index += 1) {
          if (envelope!.max[index] > positive) positive = envelope!.max[index];
          if (envelope!.min[index] < negative) negative = envelope!.min[index];
        }
        const pos = Math.pow(Math.min(1, positive * gain), 0.72);
        const neg = Math.pow(Math.min(1, -negative * gain), 0.72);
        top = pixelHeight / 2 - pos * (pixelHeight - pad) / 2;
        bottom = pixelHeight / 2 + neg * (pixelHeight - pad) / 2;
      } else {
        const peak = peakEnvelope(peaks!, centerBucket - half, centerBucket + half);
        const shaped = Math.pow(Math.min(1, peak * gain), 0.72);
        const h = Math.max(1, shaped * (pixelHeight - pad));
        top = (pixelHeight - h) / 2;
        bottom = top + h;
      }
      if (bottom - top < 1) {
        const middle = (top + bottom) / 2;
        top = middle - 0.5;
        bottom = middle + 0.5;
      }
      tops[column] = top;
      bottoms[column] = bottom;
      ctx.fillRect(x, top, step + 0.5, bottom - top);
    }
    ctx.fillStyle = 'rgba(186, 230, 253, 0.95)';
    for (let column = 0; column < columns; column += 1) {
      const x = column * step;
      ctx.fillRect(x, tops[column], step + 0.5, 1);
      ctx.fillRect(x, bottoms[column] - 1, step + 0.5, 1);
    }
    ctx.fillStyle = 'rgba(125, 211, 252, 0.30)';
    ctx.fillRect(0, pixelHeight / 2, pixelWidth, Math.max(1, Math.round(dpr * 0.5)));
  }

  function syncVideoSoundDetail(entry: VideoBlockEntry, scale: number, detailView: DetailWindow): void {
    const clip = entry.clip;
    const peaks = clip.peaks;
    if (!entry.el.isConnected || !videos.includes(clip) || videoSoundKind(clip) !== 'wave' || !peaks?.length || clip.effects.speedPoints?.length) {
      hideVideoSoundDetail(entry);
      return;
    }
    const fullWidth = entry.el.clientWidth || Math.max(12, videoClipLength(clip) * scale - 2);
    const bucketSeconds = clip.duration / peaks.length;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const needsDetail = bucketSeconds * scale > DETAIL_WAVE_PIXELS_PER_BUCKET
      || fullWidth * dpr > MAX_WAVE_CANVAS_WIDTH;
    if (!needsDetail) {
      hideVideoSoundDetail(entry);
      return;
    }
    const clipStart = clip.start;
    const clipEnd = clipStart + videoClipLength(clip);
    if (clipEnd <= detailView.viewStart || clipStart >= detailView.viewEnd) {
      hideVideoSoundDetail(entry);
      return;
    }
    const visibleStart = Math.max(clipStart, detailView.start);
    const visibleEnd = Math.min(clipEnd, detailView.end);
    if (visibleEnd - visibleStart < 0.005) {
      hideVideoSoundDetail(entry);
      return;
    }
    const speed = normalizeEffects(clip.effects).speed;
    const sourceFrom = clipSourceTime(clip, visibleStart - clipStart);
    const sourceTo = clipSourceTime(clip, visibleEnd - clipStart);
    const sourceVisibleFrom = clipSourceTime(clip, Math.max(clipStart, detailView.viewStart) - clipStart);
    const sourceVisibleTo = clipSourceTime(clip, Math.min(clipEnd, detailView.viewEnd) - clipStart);
    if (!entry.soundDetailDraft
      && entry.soundDetailRange
      && entry.soundDetailRange.scale === scale
      && entry.soundDetailRange.trimStart === clip.trimStart
      && entry.soundDetailRange.speed === speed
      && entry.soundDetailRange.start <= sourceVisibleFrom + 0.001
      && entry.soundDetailRange.end >= sourceVisibleTo - 0.001) {
      return;
    }
    const detailLeft = (visibleStart - clipStart) * scale;
    const detailWidth = Math.max(1, (visibleEnd - visibleStart) * scale);
    const sampleRate = clip.probe.audioStreams?.[0]?.sampleRate ?? DETAIL_WAVE_SAMPLE_FLOOR;
    const buckets = detailWaveBuckets(detailWidth, dpr, sourceFrom, sourceTo, sampleRate);
    const key = `${mediaKey(clip.file)}:${sourceFrom.toFixed(3)}:${sourceTo.toFixed(3)}:${buckets}:${scale.toFixed(3)}:sound`;
    if (entry.soundDetailKey === key) return;
    entry.soundDetailKey = key;
    const baseFrom = Math.max(0, Math.floor((sourceFrom / Math.max(0.001, clip.duration)) * peaks.length));
    const baseTo = Math.min(peaks.length, Math.ceil((sourceTo / Math.max(0.001, clip.duration)) * peaks.length));
    if (baseTo > baseFrom) {
      const slice = peaks.subarray(baseFrom, baseTo);
      entry.soundDetailRange = {
        start: sourceFrom,
        end: sourceTo,
        scale,
        buckets: slice.length,
        trimStart: clip.trimStart,
        speed,
        left: detailLeft,
        width: detailWidth,
      };
      drawVideoSoundDetail(entry, slice);
    }
    void envelopeForRange(
      clip.file,
      sourceFrom,
      sourceTo,
      buckets,
      mediaKey(clip.file),
      new AbortController().signal,
    ).then((detailEnvelope) => {
      if (!detailEnvelope || entry.soundDetailKey !== key || !entry.el.isConnected || !videos.includes(clip)) return;
      entry.soundDetailRange = {
        start: sourceFrom,
        end: sourceTo,
        scale,
        buckets,
        trimStart: clip.trimStart,
        speed,
        left: detailLeft,
        width: detailWidth,
      };
      entry.soundDetailDraft = false;
      drawVideoSoundDetail(entry, detailEnvelope);
    }).catch(() => undefined);
  }

  function syncAudioDetail(entry: AudioBlockEntry, scale: number, detailView: DetailWindow): void {
    const clip = entry.clip;
    const peaks = clip.peaks;
    if (!entry.el.isConnected || !audios.includes(clip) || !peaks?.length || clip.retime?.speedPoints?.length) {
      hideAudioDetail(entry);
      return;
    }
    const bucketSeconds = clip.duration / peaks.length;
    const fullWidth = entry.el.clientWidth || Math.max(12, audioClipLength(clip) * scale);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const needsDetail = bucketSeconds * scale > DETAIL_WAVE_PIXELS_PER_BUCKET
      || fullWidth * dpr > MAX_WAVE_CANVAS_WIDTH;
    if (!needsDetail) {
      hideAudioDetail(entry);
      return;
    }
    const clipStart = clip.offset;
    const clipEnd = clipStart + audioClipLength(clip);
    if (clipEnd <= detailView.viewStart || clipStart >= detailView.viewEnd) {
      hideAudioDetail(entry);
      return;
    }
    const visibleStart = Math.max(clipStart, detailView.start);
    const visibleEnd = Math.min(clipEnd, detailView.end);
    if (visibleEnd - visibleStart < 0.005) {
      hideAudioDetail(entry);
      return;
    }
    const sourceFrom = clipSourceTime(clip, visibleStart - clipStart);
    const sourceTo = clipSourceTime(clip, visibleEnd - clipStart);
    const sourceVisibleFrom = clipSourceTime(clip, Math.max(clipStart, detailView.viewStart) - clipStart);
    const sourceVisibleTo = clipSourceTime(clip, Math.min(clipEnd, detailView.viewEnd) - clipStart);
    if (!entry.detailDraft
      && entry.detailRange
      && entry.detailRange.scale === scale
      && entry.detailRange.trimStart === clip.trimStart && entry.detailKey.startsWith(String(clip.sourceTrack ?? 0) + ':')
      && entry.detailRange.start <= sourceVisibleFrom + 0.001
      && entry.detailRange.end >= sourceVisibleTo - 0.001) {
      return;
    }
    const detailLeft = (visibleStart - clipStart) * scale;
    const detailWidth = Math.max(1, (visibleEnd - visibleStart) * scale);
    const asset = assets.find((entry) => entry.key === mediaKey(clip.file));
    const sampleRate = asset?.probe.audioStreams?.[clip.sourceTrack ?? 0]?.sampleRate ?? DETAIL_WAVE_SAMPLE_FLOOR;
    const buckets = detailWaveBuckets(detailWidth, dpr, sourceFrom, sourceTo, sampleRate);
    const key = `${clip.sourceTrack ?? 0}:${mediaKey(clip.file)}:${sourceFrom.toFixed(3)}:${sourceTo.toFixed(3)}:${buckets}:${scale.toFixed(3)}`;
    if (entry.detailKey === key) return;
    entry.detailKey = key;
    // Draw what the base peaks know immediately at native canvas resolution.
    // This removes the stretched-low-res look while the signed envelope
    // decoder works on the exact range.
    const baseFrom = Math.max(0, Math.floor((sourceFrom / Math.max(0.001, clip.duration)) * peaks.length));
    const baseTo = Math.min(peaks.length, Math.ceil((sourceTo / Math.max(0.001, clip.duration)) * peaks.length));
    if (baseTo > baseFrom) {
      const slice = peaks.subarray(baseFrom, baseTo);
      entry.detailRange = {
        start: sourceFrom,
        end: sourceTo,
        scale,
        buckets: slice.length,
        trimStart: clip.trimStart,
        left: detailLeft,
        width: detailWidth,
      };
      drawWaveDetail(entry, slice);
    }
    entry.detailPending = true;
    updateAudioLoading(entry);
    void previewAudioFile(clip).then((file) => envelopeForRange(
      file, sourceFrom, sourceTo, buckets, mediaKey(file), new AbortController().signal,
    )).catch(() => null).then((detailEnvelope) => {
      if (entry.detailKey !== key) return;
      entry.detailPending = false;
      updateAudioLoading(entry);
      if (!detailEnvelope || !entry.el.isConnected || !audios.includes(clip)) return;
      entry.detailRange = {
        start: sourceFrom,
        end: sourceTo,
        scale,
        buckets,
        trimStart: clip.trimStart,
        left: detailLeft,
        width: detailWidth,
      };
      entry.detailDraft = false;
      drawWaveDetail(entry, detailEnvelope);
    }).catch(() => {
      if (entry.detailKey !== key) return;
      entry.detailPending = false;
      updateAudioLoading(entry);
    });
  }

  function syncDetailLayers(): void {
    if (detailSyncTimer) {
      window.clearTimeout(detailSyncTimer);
      detailSyncTimer = 0;
    }
    const scale = pps();
    const detailView = detailWindow(scale);
    for (const entry of videoBlockEntries.values()) {
      syncVideoDetail(entry, scale, detailView);
      syncVideoSoundDetail(entry, scale, detailView);
    }
    for (const entry of audioBlockEntries.values()) syncAudioDetail(entry, scale, detailView);
  }

  function renderTimeline(): void {
    syncClipSelection();
    invalidateTimelineDerived();
    invalidateFingerprint();
    timelineBox.classList.toggle('video-compact-tracks', compactTracks);
    timelineBox.style.setProperty('--vt-video-row', `${videoRowHeight()}px`);
    timelineBox.style.setProperty('--vt-audio-row', `${audioRowHeight()}px`);
    const scale = pps();
    const length = timelineLength();
    content.style.width = `${Math.ceil(length * scale)}px`;
    renderRuler(scale, length);

    const videoRows = Math.max(
      videoTrackCount,
      1,
      ...videos.map((clip) => clip.track + 1),
      ...titles.map((cue) => titleTrackIndex(cue) + 1),
      ...graphics.map((graphic) => graphicTrackIndex(graphic) + 1),
    );
    videoLane.style.height = `${trackTopPad() + tracksHeight(videoTrackHeights, videoRowHeight(), videoRows) + trackBottomPad()}px`;
    const range = timelineWindow(scale);
    syncVideoBlockEntries(scale, range);
    renderTitleBlocks(scale);

    const rows = audioRows();
    const rowCount = Math.max(1, ...[...rows.values()].map((row) => row + 1));
    const audioRowCount = Math.max(audioTrackCount, audios.length ? rowCount : 0);
    audioLane.style.height = audioRowCount ? `${trackTopPad() + tracksHeight(audioTrackHeights, audioRowHeight(), audioRowCount) + trackBottomPad()}px` : '';
    audioLane.classList.toggle('hidden', !audioRowCount);
    syncAudioBlockEntries(scale, rows, range);

    ensureTrackStates(videoRows, audioRowCount);
    renderCaptionLane(scale);
    renderGraphicBlocks(scale);
    renderTrackHeaders(videoRows, audioRowCount, !captionLane.classList.contains('hidden'), false);
    const end = totalVideo();
    videoEnd.style.left = `${end * scale}px`;
    videoEnd.classList.toggle('hidden', !videos.length);
    videoEnd.title = 'The output ends with the video';
    lastTimelineWindowLeft = range.left;
    positionPlayhead();
    syncTrackHeaderScroll();
    updateRangeMarkers();
    scheduleClipLabelSync();
    scheduleDetailSync();
  }

  function renderMixer(): void {
    mixer.replaceChildren();
    const videoRows = Math.max(
      videoTrackCount,
      ...videos.map((clip) => clip.track + 1),
      ...titles.map((cue) => titleTrackIndex(cue) + 1),
      ...graphics.map((graphic) => graphicTrackIndex(graphic) + 1),
    );
    const rows = audioRows();
    const audioRowsCount = Math.max(audioTrackCount, ...[...rows.values()].map((row) => row + 1));
    const section = (title: string, hint: string): HTMLElement => {
      const head = document.createElement('div');
      head.className = 'video-mixer-section';
      const label = document.createElement('span');
      label.textContent = title;
      const detail = document.createElement('span');
      detail.textContent = hint;
      head.append(label, detail);
      return head;
    };
    interface MixerStripOptions {
      label: string;
      value: number;
      max: number;
      valueName: string;
      onValue: (value: number) => void;
      muted: boolean;
      muteLabel: string;
      muteTitle: string;
      onMute: () => void;
      muteCommit: string;
      soloOn: boolean;
      onSolo: () => void;
      soloCommit: string;
      commitLabel: string;
      resetLabel: string;
      afterCommit?: () => void;
    }
    const strip = (options: MixerStripOptions): HTMLElement => {
      const row = document.createElement('div');
      row.className = 'video-mixer-strip' + (options.muted ? ' is-muted' : '');
      const name = document.createElement('span');
      name.className = 'video-mixer-name';
      name.textContent = options.label;
      const fader = document.createElement('input');
      fader.type = 'range';
      fader.min = '0';
      fader.max = String(Math.round(options.max * 100));
      fader.step = '1';
      fader.value = String(Math.round(options.value * 100));
      fader.className = 'video-mixer-fader';
      fader.setAttribute('aria-label', `${options.label} ${options.valueName}`);
      const value = document.createElement('output');
      value.className = 'video-mixer-value';
      value.textContent = `${Math.round(options.value * 100)}%`;
      fader.addEventListener('input', () => {
        const next = Number(fader.value) / 100;
        value.textContent = `${fader.value}%`;
        options.onValue(next);
      });
      fader.addEventListener('change', () => {
        options.afterCommit?.();
        commit(options.commitLabel);
      });
      fader.addEventListener('dblclick', () => {
        fader.value = '100';
        value.textContent = '100%';
        options.onValue(1);
        options.afterCommit?.();
        commit(options.resetLabel);
      });
      const mute = document.createElement('button');
      mute.type = 'button';
      mute.className = 'vt-track-btn' + (options.muted ? ' active' : '');
      mute.textContent = options.muteLabel;
      mute.title = options.muteTitle;
      mute.setAttribute('aria-label', mute.title);
      mute.addEventListener('click', () => {
        options.onMute();
        render();
        seek(time);
        commit(options.muteCommit);
      });
      const solo = document.createElement('button');
      solo.type = 'button';
      solo.className = 'vt-track-btn vt-track-solo' + (options.soloOn ? ' active' : '');
      solo.textContent = 'S';
      solo.title = `${options.soloOn ? 'Unsolo' : 'Solo'} ${options.label}`;
      solo.setAttribute('aria-label', solo.title);
      solo.addEventListener('click', () => {
        options.onSolo();
        render();
        seek(time);
        commit(options.soloCommit);
      });
      row.append(name, fader, value, mute, solo);
      return row;
    };
    if (videoRows) {
      mixer.append(section('Video tracks', 'opacity'));
      for (let index = 0; index < videoRows; index += 1) {
        const state = videoTrackState[index] ?? { hidden: false, muted: false, locked: false, solo: false };
        mixer.append(strip({
          label: `V${index + 1}`,
          value: state.opacity ?? 1,
          max: 1,
          valueName: 'opacity',
          onValue: (value) => {
            state.opacity = value;
            if (activeVideo?.track === index) applyPreviewTransform(activeVideo);
          },
          muted: Boolean(state.hidden),
          muteLabel: 'H',
          muteTitle: `${state.hidden ? 'Show' : 'Hide'} V${index + 1}`,
          onMute: () => { state.hidden = !state.hidden; },
          muteCommit: 'Toggled video track visibility',
          soloOn: Boolean(state.solo),
          onSolo: () => { state.solo = !state.solo; },
          soloCommit: 'Soloed a video track',
          commitLabel: 'Adjusted video track opacity',
          resetLabel: 'Reset video track opacity',
          afterCommit: () => {
            render();
            seek(time);
          },
        }));
      }
    }
    if (audioRowsCount) {
      mixer.append(section('Audio tracks', 'volume'));
      for (let index = 0; index < audioRowsCount; index += 1) {
        const state = audioTrackState[index] ?? { muted: false, locked: false, solo: false };
        mixer.append(strip({
          label: `A${index + 1}`,
          value: state.gain ?? 1,
          max: 2,
          valueName: 'volume',
          onValue: (value) => {
            state.gain = value;
            scheduleAudioMix();
            syncMedia(true);
          },
          muted: Boolean(state.muted),
          muteLabel: 'M',
          muteTitle: `${state.muted ? 'Unmute' : 'Mute'} A${index + 1}`,
          onMute: () => { state.muted = !state.muted; },
          muteCommit: 'Muted an audio track',
          soloOn: Boolean(state.solo),
          onSolo: () => { state.solo = !state.solo; },
          soloCommit: 'Soloed an audio track',
          commitLabel: 'Adjusted audio track volume',
          resetLabel: 'Reset audio track volume',
        }));
      }
    }
    if (!mixer.childElementCount) {
      const empty = document.createElement('p');
      empty.className = 'text-[10px] text-slate-500';
      empty.textContent = 'Add a video or audio track to mix it here.';
      mixer.append(empty);
    }
  }

  function render(): void {
    renderTimeline();
    renderInspectorPanel();
    if (!libraryCollapsed && activeLibrary === 'audio') renderMixer();
    update();
    updateGraphicOverlay();
    renderTextLayer();
  }

  function timecodeLabel(seconds: number): string {
    const rate = Math.max(1, Math.round(fpsOfProject()));
    const totalFrames = Math.max(0, Math.round(seconds * rate));
    const frames = totalFrames % rate;
    const whole = Math.floor(totalFrames / rate);
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${pad(Math.floor(whole / 3600))}:${pad(Math.floor((whole % 3600) / 60))}:${pad(whole % 60)}:${pad(frames)}`;
  }

  function rulerLabel(seconds: number, step: number): string {
    const pad = (value: number) => String(value).padStart(2, '0');
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    if (step < 1) {
      const precise = (seconds % 60).toFixed(2).padStart(5, '0');
      return `${hours ? `${hours}:` : ''}${pad(minutes)}:${precise}`;
    }
    return `${hours ? `${hours}:` : ''}${pad(minutes)}:${pad(secs)}`;
  }

  let rulerCacheKey = '';
  function renderRuler(scale: number, length: number): void {
    const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    const step = steps.find((value) => value * scale >= 92) ?? 1200;
    const minor = step / 5;
    const majorPx = step * scale;
    const minorPx = minor * scale;
    const fps = Math.max(1, Math.min(240, fpsOfProject() || 30));
    const framePx = scale / fps;
    const secondPx = scale;
    const fivePx = scale * 5;
    const showFrames = framePx >= FRAME_TICK_MIN_PX;
    const showSeconds = secondPx >= SECOND_TICK_MIN_PX;
    const showFives = fivePx >= FIVE_BAND_MIN_PX;
    const viewport = Math.max(1, timelineViewportWidth || measureTimelineViewport());
    const viewStart = scroll.scrollLeft / scale;
    const viewEnd = (scroll.scrollLeft + viewport) / scale;
    const margin = Math.max(step, 120 / scale);
    const firstIndex = Math.max(0, Math.floor((viewStart - margin) / step));
    const lastIndex = Math.max(firstIndex, Math.floor(Math.min(length, viewEnd + margin) / step));
    const key = `${scale.toFixed(4)}:${length.toFixed(3)}:${step}:${firstIndex}:${lastIndex}:${fps}:${showFrames ? 1 : 0}:${showSeconds ? 1 : 0}:${showFives ? 1 : 0}`;
    if (key === rulerCacheKey) return;
    rulerCacheKey = key;

    ruler.style.setProperty('--major-px', `${majorPx}px`);
    ruler.style.setProperty('--minor-px', `${minorPx}px`);
    ruler.style.setProperty('--second-px', `${secondPx}px`);
    ruler.style.setProperty('--five-px', `${fivePx}px`);
    ruler.style.setProperty('--frame-px', `${framePx}px`);
    ruler.style.setProperty('--second-tick', showSeconds ? 'rgb(148 163 184 / 0.34)' : 'transparent');
    ruler.style.setProperty('--five-tick', showFives ? 'rgb(255 255 255 / 0.10)' : 'transparent');
    ruler.style.setProperty('--frame-tick', showFrames ? 'rgb(148 163 184 / 0.18)' : 'transparent');
    grid.style.setProperty('--major-px', `${majorPx}px`);
    grid.style.setProperty('--minor-px', `${minorPx}px`);

    // Bands, 1 s ticks, minor ticks, frame ticks, and grid lines are repeating
    // CSS gradients. Only the labels in and around the viewport stay as DOM.
    ruler.replaceChildren();
    const frames = document.createElement('span');
    frames.className = 'vt-ruler-frames';
    frames.setAttribute('aria-hidden', 'true');
    ruler.append(frames);
    for (let index = firstIndex; index <= lastIndex; index += 1) {
      const at = index * step;
      if (at > length) break;
      if (at > 0 && at >= length - step * 0.5) continue;
      const tick = document.createElement('span');
      tick.className = 'vt-tick major';
      tick.style.left = `${at * scale}px`;
      tick.textContent = rulerLabel(at, step);
      ruler.append(tick);
    }
    grid.replaceChildren();
  }

  let rulerFrame = 0;
  function scheduleRulerSync(): void {
    if (rulerFrame) return;
    rulerFrame = requestAnimationFrame(() => {
      rulerFrame = 0;
      renderRuler(pps(), timelineLength());
    });
  }

  function handles(block: HTMLElement): { left: HTMLElement; right: HTMLElement } {
    const left = document.createElement('span');
    left.className = 'vt-handle vt-handle-start';
    left.title = 'Trim the start';
    const right = document.createElement('span');
    right.className = 'vt-handle vt-handle-end';
    right.title = 'Trim the end';
    block.append(left, right);
    return { left, right };
  }

  function clearSelection(except: HTMLElement): void {
    for (const other of root.querySelectorAll('.vt-clip.selected')) {
      if (other !== except) {
        other.classList.remove('selected');
        other.setAttribute('aria-pressed', 'false');
      }
    }
    except.classList.add('selected');
    except.setAttribute('aria-pressed', 'true');
  }

  function snapTargets(excludeAudio?: AudioClip, excludeVideo?: VideoClip): number[] {
    const targets = [0, totalVideo(), time];
    for (const clip of videos) {
      if (clip === excludeVideo) continue;
      targets.push(videoStart(clip), videoStart(clip) + videoClipLength(clip));
    }
    for (const clip of audios) {
      if (clip === excludeAudio) continue;
      targets.push(clip.offset, clip.offset + audioClipLength(clip));
    }
    return targets;
  }

  function snapValue(value: number, excludeAudio?: AudioClip, excludeVideo?: VideoClip): { value: number; at: number | null } {
    if (!snapEnabled) return { value, at: null };
    let best: { value: number; at: number | null } = { value, at: null };
    let distance = SNAP_PX + 1;
    for (const target of snapTargets(excludeAudio, excludeVideo)) {
      const gap = Math.abs(value - target) * pps();
      if (gap < distance) {
        distance = gap;
        best = { value: target, at: target };
      }
    }
    return distance <= SNAP_PX ? best : { value, at: null };
  }

  function showSnap(at: number | null): void {
    snapLine.classList.toggle('hidden', at === null);
    if (at !== null) snapLine.style.left = `${at * pps()}px`;
  }

  /** Scroll while a pointer sits near either edge of the timeline viewport. */
  function createEdgeScroller(onScroll: () => void): { update: (clientX: number) => void; stop: () => void } {
    let timer = 0;
    let direction = 0;
    const tick = (): void => {
      if (!direction) return;
      const before = scroll.scrollLeft;
      scroll.scrollLeft += direction * 16;
      if (scroll.scrollLeft !== before) onScroll();
    };
    return {
      update: (clientX: number) => {
        const bounds = scroll.getBoundingClientRect();
        const edge = Math.max(34, Math.min(78, bounds.width * 0.08));
        direction = clientX > bounds.right - edge ? 1 : clientX < bounds.left + edge ? -1 : 0;
        if (direction && !timer) timer = window.setInterval(tick, 16);
        else if (!direction && timer) {
          window.clearInterval(timer);
          timer = 0;
        }
      },
      stop: () => {
        if (timer) window.clearInterval(timer);
        timer = 0;
        direction = 0;
      },
    };
  }

  function layoutVideoLane(): void {
    invalidateTimelineDerived();
    const scale = pps();
    for (const clip of videos) {
      const entry = videoBlockEntries.get(clip.id);
      const block = entry?.el;
      if (!block || !entry) continue;
      const length = videoClipLength(clip);
      block.style.left = `${clip.start * scale}px`;
      block.style.top = `${trackTopPad() + videoTrackTop(clip.track)}px`;
      block.style.height = `${videoTrackHeight(clip.track)}px`;
      block.style.bottom = 'auto';
      block.classList.toggle('is-muted', clip.mute || Boolean(videoTrackState[clip.track]?.muted));
      block.classList.toggle('is-hidden', Boolean(videoTrackState[clip.track]?.hidden));
      block.style.width = `${Math.max(12, length * scale - 2)}px`;
      if (clip.strip && clip.image && entry.stripRef !== clip.strip) {
        entry.stripRef = clip.strip;
        block.style.backgroundImage = `url(${clip.strip})`;
        block.style.backgroundSize = 'auto 100%';
        block.style.backgroundRepeat = 'repeat-x';
        block.style.backgroundPosition = '0 0';
      }
      const label = block.querySelector<HTMLElement>('.vt-clip-label');
      if (label) label.textContent = `${clip.image ? '🖼 ' : ''}${clip.name} · ${formatClock(length)}`;
      renderClipBadges(block, clip);
      updateVideoTransitionOverlays(entry, clip, scale);
    }
    for (const [index, cue] of titles.entries()) {
      const block = videoLane.querySelector<HTMLElement>(`.vt-clip-title[data-title-index="${index}"]`);
      if (!block) continue;
      const track = titleTrackIndex(cue);
      block.style.left = `${cue.start * scale}px`;
      block.style.top = `${trackTopPad() + videoTrackTop(track)}px`;
      block.style.height = `${videoTrackHeight(track)}px`;
      block.style.width = `${Math.max(12, (cue.end - cue.start) * scale - 2)}px`;
      block.classList.toggle('is-hidden', videoTrackHidden(track));
      block.classList.toggle('locked', videoTrackLocked(track));
    }
    const videoRows = Math.max(
      videoTrackCount,
      1,
      ...videos.map((entry) => entry.track + 1),
      ...titles.map((cue) => titleTrackIndex(cue) + 1),
      ...graphics.map((graphic) => graphicTrackIndex(graphic) + 1),
    );
    videoLane.style.height = `${trackTopPad() + tracksHeight(videoTrackHeights, videoRowHeight(), videoRows) + trackBottomPad()}px`;
    const end = totalVideo();
    videoEnd.style.left = `${end * scale}px`;
    const length = timelineLength();
    content.style.width = `${Math.ceil(length * scale)}px`;
    renderRuler(scale, length);
    positionPlayhead();
    if (captionSource.value === 'embedded') renderCaptionLane(scale);
    scheduleClipLabelSync();
  }

  function layoutAudioLane(): void {
    const scale = pps();
    const rows = audioRows();
    for (const clip of audios) {
      const block = audioLane.querySelector<HTMLElement>(`.vt-clip[data-id="${clip.id}"]`);
      if (!block) continue;
      const row = rows.get(clip.id) ?? 0;
      const width = Math.max(12, audioClipLength(clip) * scale);
      block.style.left = `${clip.offset * scale}px`;
      block.style.top = `${trackTopPad() + audioTrackTop(row)}px`;
      block.style.height = `${audioTrackHeight(row)}px`;
      block.style.width = `${width}px`;
      const entry = audioBlockEntries.get(clip.id);
      const canvas = block.querySelector<HTMLCanvasElement>('canvas');
      const key = audioWaveKey(clip, width);
      if (entry && canvas && key !== entry.waveKey) {
        drawWave(canvas, clip, width);
        entry.waveKey = key;
      }
    }
    const length = timelineLength();
    content.style.width = `${Math.ceil(length * scale)}px`;
    renderRuler(scale, length);
    scheduleClipLabelSync();
  }

  const filmstripImageCache = new Map<string, HTMLImageElement>();
  function filmstripImage(url: string): HTMLImageElement {
    const cached = filmstripImageCache.get(url);
    if (cached) return cached;
    const image = new Image();
    image.src = url;
    filmstripImageCache.set(url, image);
    return image;
  }

  /** Fill a clip with as many distinct thumbnails as its visible width allows. */
  function addFilmstrip(block: HTMLElement, clip: VideoClip, width: number): void {
    if (!clip.strip || clip.image) return;
    const aspect = clip.probe.width > 0 && clip.probe.height > 0
      ? clip.probe.width / clip.probe.height
      : 16 / 9;
    const idealTile = Math.max(34, Math.min(180, videoTrackHeight(clip.track) * aspect));
    const count = Math.max(1, Math.ceil(width / idealTile));
    const start = clip.trimStart / Math.max(0.001, clip.duration);
    const end = (clip.duration - clip.trimEnd) / Math.max(0.001, clip.duration);
    const lastFrame = FILMSTRIP_FRAMES - 1;
    if (count > FILMSTRIP_FRAMES) {
      // At deep zoom the strip cannot supply a distinct frame per tile.
      // Scale the trimmed span across the clip once instead of repeating
      // frames, which would show the wrong moment twice. Shade and tile
      // separators match the canvas path.
      const url = stripUrl(clip.strip);
      if (!url) {
        block.style.backgroundImage = '';
        return;
      }
      const span = Math.max(0.0001, end - start);
      const stripWidth = width / span;
      const tileWidth = Math.max(1, width / count);
      block.style.backgroundImage = [
        'linear-gradient(90deg, rgb(2 6 23 / 0.25), transparent 12%, transparent 88%, rgb(2 6 23 / 0.25))',
        'linear-gradient(180deg, rgb(2 6 23 / 0.14), transparent 45%, rgb(2 6 23 / 0.22))',
        `repeating-linear-gradient(90deg, transparent 0, transparent ${tileWidth - 1}px, rgb(2 6 23 / 0.28) ${tileWidth - 1}px, rgb(2 6 23 / 0.28) ${tileWidth}px)`,
        `url("${url}")`,
      ].join(', ');
      block.style.backgroundSize = `100% 100%, 100% 100%, ${tileWidth}px 100%, ${stripWidth}px 100%`;
      block.style.backgroundRepeat = 'no-repeat, no-repeat, repeat-x, no-repeat';
      block.style.backgroundPosition = `0 0, 0 0, 0 0, ${-start * stripWidth}px 0`;
      return;
    }
    const url = stripUrl(clip.strip);
    if (!url) return;
    const canvas = document.createElement('canvas');
    canvas.className = 'vt-filmstrip vt-filmstrip-canvas';
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    // The CSS path takes over past 48 tiles, so this only needs to cover
    // roughly 6144 CSS px at 2x; keep headroom for 3x displays.
    const pixelWidth = Math.max(1, Math.min(16384, Math.round(width * dpr)));
    const pixelHeight = Math.max(1, Math.round(videoTrackHeight(clip.track) * dpr));
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
    const draw = (): void => {
      const context = canvas.getContext('2d');
      const image = filmstripImage(url);
      if (!context || !image.complete || image.naturalWidth < 1) return;
      context.clearRect(0, 0, pixelWidth, pixelHeight);
      const sourceWidth = image.naturalWidth / FILMSTRIP_FRAMES;
      const tileWidth = pixelWidth / count;
      for (let index = 0; index < count; index += 1) {
        const fraction = count === 1 ? (start + end) / 2 : start + ((end - start) * index) / (count - 1);
        const frame = Math.max(0, Math.min(lastFrame, Math.round(fraction * lastFrame)));
        context.drawImage(
          image,
          frame * sourceWidth, 0, sourceWidth, image.naturalHeight,
          index * tileWidth, 0, tileWidth + 0.5, pixelHeight,
        );
        if (index > 0) {
          context.fillStyle = 'rgb(2 6 23 / 0.28)';
          context.fillRect(index * tileWidth, 0, Math.max(1, dpr), pixelHeight);
        }
      }
      const vertical = context.createLinearGradient(0, 0, 0, pixelHeight);
      vertical.addColorStop(0, 'rgb(2 6 23 / 0.14)');
      vertical.addColorStop(0.45, 'transparent');
      vertical.addColorStop(1, 'rgb(2 6 23 / 0.22)');
      context.fillStyle = vertical;
      context.fillRect(0, 0, pixelWidth, pixelHeight);
      const horizontal = context.createLinearGradient(0, 0, pixelWidth, 0);
      horizontal.addColorStop(0, 'rgb(2 6 23 / 0.25)');
      horizontal.addColorStop(0.12, 'transparent');
      horizontal.addColorStop(0.88, 'transparent');
      horizontal.addColorStop(1, 'rgb(2 6 23 / 0.25)');
      context.fillStyle = horizontal;
      context.fillRect(0, 0, pixelWidth, pixelHeight);
    };
    block.append(canvas);
    const image = filmstripImage(url);
    if (image.complete) draw();
    else image.addEventListener('load', draw, { once: true });
  }

  /** Draw the video's own audio as a compact waveform over its filmstrip. */
  function drawVideoWave(canvas: HTMLCanvasElement, clip: VideoClip, width: number): void {
    const peaks = clip.peaks;
    if (!peaks?.length) return;
    const height = 20;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const pixelWidth = Math.max(1, Math.min(MAX_WAVE_CANVAS_WIDTH, Math.round(width * dpr)));
    canvas.width = pixelWidth;
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(pixelWidth / Math.max(1, width), 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    let loudest = 0;
    for (const value of peaks) if (value > loudest) loudest = value;
    // Quiet recordings should still read as a waveform, but never amplify
    // silence into a solid bar.
    const gain = Math.min(8, 0.92 / Math.max(0.001, loudest));
    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, 'rgba(186, 230, 253, 0.92)');
    gradient.addColorStop(0.5, 'rgba(125, 211, 252, 0.98)');
    gradient.addColorStop(1, 'rgba(56, 189, 248, 0.82)');
    ctx.fillStyle = gradient;
    const length = videoClipLength(clip);
    const duration = Math.max(0.001, clip.duration);
    const columns = Math.max(1, Math.min(MAX_WAVE_COLUMNS, Math.ceil(width)));
    const step = width / columns;
    for (let column = 0; column < columns; column += 1) {
      const x = column * step;
      const sourceStart = clipSourceTime(clip, (x / Math.max(1, width)) * length);
      const sourceEnd = clipSourceTime(clip, ((x + step) / Math.max(1, width)) * length);
      const peak = peakEnvelope(peaks, (sourceStart / duration) * peaks.length, (sourceEnd / duration) * peaks.length);
      const shaped = Math.pow(Math.min(1, peak * gain), 0.72);
      const h = Math.max(1, shaped * (height - 3));
      ctx.fillRect(x, (height - h) / 2, step + 0.5, h);
    }
    ctx.fillStyle = 'rgba(125, 211, 252, 0.38)';
    ctx.fillRect(0, height / 2, width, 0.5);
  }

  function videoBlock(clip: VideoClip, scale: number): HTMLElement {
    const block = document.createElement('div');
    block.className = 'vt-clip vt-clip-video';
    block.dataset.id = String(clip.id);
    block.tabIndex = 0;
    block.setAttribute('role', 'button');
    block.setAttribute('aria-pressed', String(isClipSelected('video', clip.id)));
    block.classList.toggle('selected', isClipSelected('video', clip.id));
    block.classList.toggle('is-muted', clip.mute || videoTrackMuted(clip.track));
    block.classList.toggle('is-hidden', videoTrackHidden(clip.track));
    const length = videoClipLength(clip);
    const width = Math.max(12, length * scale - 2);
    block.style.left = `${clip.start * scale}px`;
    block.style.top = `${trackTopPad() + videoTrackTop(clip.track)}px`;
    block.style.height = `${videoTrackHeight(clip.track)}px`;
    block.style.bottom = 'auto';
    block.style.width = `${width}px`;
    if (clip.strip && clip.image) {
      const url = stripUrl(clip.strip);
      block.style.backgroundImage = url ? `url("${url}")` : '';
      block.style.backgroundSize = 'auto 100%';
      block.style.backgroundRepeat = 'repeat-x';
      block.style.backgroundPosition = '0 0';
    }
    addFilmstrip(block, clip, width);
    if (!clip.image) {
      const detail = document.createElement('canvas');
      detail.className = 'vt-filmstrip-detail hidden';
      const loading = document.createElement('span');
      loading.className = 'vt-wave-loading vt-filmstrip-loading hidden';
      loading.title = 'Building filmstrip…';
      loading.setAttribute('aria-hidden', 'true');
      block.append(detail, loading);
    }
    const label = document.createElement('span');
    label.className = 'vt-clip-label';
    label.textContent = `${clip.image ? '🖼 ' : ''}${clip.name} · ${formatClock(length)}`;
    block.append(label);
    renderClipBadges(block, clip);
    if (!clip.image && clip.probe.hasAudio) {
      const sound = document.createElement(clip.peaks ? 'canvas' : 'span');
      sound.className = clip.peaks ? 'vt-sound-wave' : 'vt-sound-band';
      sound.title = clip.mute ? 'Own sound is muted' : 'Own sound moves with this clip';
      if (sound instanceof HTMLCanvasElement) {
        drawVideoWave(sound, clip, width);
        const detail = document.createElement('canvas');
        detail.className = 'vt-sound-wave-detail hidden';
        block.append(sound, detail);
      } else {
        block.append(sound);
      }
    }
    block.title = `${clip.name}\nDrag to move · drag the edges to trim${clip.image ? ' or lengthen' : ''}`;
    const { left, right } = handles(block);

    block.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.stopPropagation();
      event.preventDefault();
      const additive = event.ctrlKey || event.metaKey;
      if (additive) {
        toggleClipSelection('video', clip.id);
        selectedGraphic = -1;
        selectedTitle = -1;
        selectedSubtitleKey = '';
        render();
        renderInspector();
        announceClipSelection();
        return;
      }
      const previousKind = selected?.kind ?? null;
      const keepGroup = isClipSelected('video', clip.id) && selectedClipCount() > 1;
      if (keepGroup) {
        selected = { kind: 'video', id: clip.id };
        selectionAnchor = clipSelectionKey(selected);
      } else {
        setClipSelection('video', clip.id);
      }
      selectedGraphic = -1;
      selectedTitle = -1;
      selectedSubtitleKey = '';
      paintClipSelection();
      announceClipSelection();
      selectSideTab('clip');
      if (previousKind !== 'video') inspectorTab = 'video';
      const clipLength = videoClipLength(clip);
      if (time < clip.start || time >= clip.start + clipLength - 0.001) {
        seekLight(clip.start + Math.min(0.05, clipLength / 2), false);
      }
      renderInspector();
      if (videoTrackLocked(clip.track)) {
        lockedNotice();
        return;
      }
      const mode = event.target === left ? 'start' : event.target === right ? 'end' : null;
      const group = selectedClipCount() > 1 ? groupMovePlan() : [];
      try { block.setPointerCapture(event.pointerId); } catch { /* synthetic or already released */ }
      const origin = {
        x: event.clientX,
        y: event.clientY,
        start: clip.start,
        track: clip.track,
        trimStart: clip.trimStart,
        trimEnd: clip.trimEnd,
        duration: clip.duration,
        scrollLeft: scroll.scrollLeft,
      };
      let dragging = false;
      let lastClientX = event.clientX;
      let lastClientY = event.clientY;

      const applyPointer = (clientX: number, clientY: number): void => {
        const deltaPx = clientX - origin.x + (scroll.scrollLeft - origin.scrollLeft);
        if (!mode) {
          if (!dragging && Math.hypot(deltaPx, clientY - origin.y) < 5) return;
          dragging = true;
          block.classList.add('dragging');
          if (group.length > 1) {
            const delta = snappedGroupDelta(group, origin.start, videoClipLength(clip), deltaPx / pps(), undefined, clip);
            applyGroupMove(group, delta);
            clip.track = origin.track;
            layoutVideoLane();
            layoutAudioLane();
            scheduleUpdate();
            return;
          }
          let start = Math.max(0, origin.start + deltaPx / pps());
          const snapStart = snapValue(start, undefined, clip);
          const snapEnd = snapValue(start + videoClipLength(clip), undefined, clip);
          if (snapStart.at !== null) {
            start = snapStart.value;
            showSnap(snapStart.at);
          } else if (snapEnd.at !== null) {
            start = Math.max(0, snapEnd.value - videoClipLength(clip));
            showSnap(snapEnd.at);
          } else {
            showSnap(null);
          }
          clip.start = start;
          const laneTop = videoLane.getBoundingClientRect().top + trackTopPad();
          const targetTrack = trackAtOffset(clientY - laneTop, videoTrackHeights, videoRowHeight(), videoTrackCount);
          if (targetTrack >= videoTrackCount) {
            videoTrackCount = targetTrack + 1;
            while (videoTrackState.length < videoTrackCount) videoTrackState.push({ hidden: false, muted: false, locked: false, solo: false });
            renderTimeline();
            status.textContent = `New video track V${videoTrackCount} created.`;
          }
          clip.track = targetTrack;
          syncLinkedAudioFromVideo(clip);
          layoutVideoLane();
          layoutAudioLane();
          scheduleUpdate();
          return;
        }

        const delta = deltaPx / pps();
        if (clip.image) {
          if (mode === 'start') {
            // The right edge stays put while the left edge follows the pointer.
            const start = Math.max(0, Math.min(origin.start + origin.duration - 0.5, origin.start + delta));
            clip.start = start;
            clip.duration = origin.duration - (start - origin.start);
          } else {
            clip.duration = Math.max(0.5, origin.duration + delta);
          }
        } else if (mode === 'start') {
          // Trim in/out by moving the timeline edge, not by shrinking the clip
          // toward its old start. The source out point and the clip's right
          // edge stay fixed, like a normal NLE.
          const original = { ...clip, ...origin };
          const visible = videoClipLength(original);
          const first = Math.max(0, origin.start + clipPlaybackTime(original, 0));
          const last = origin.start + visible - 0.2;
          const start = Math.max(first, Math.min(last, origin.start + delta));
          clip.start = start;
          clip.trimStart = clipSourceTime(original, start - origin.start);
        } else {
          const end = advanceSource(clip.effects, origin.duration - origin.trimEnd, delta);
          clip.trimEnd = Math.max(0, Math.min(clip.duration - clip.trimStart - 0.2, clip.duration - end));
        }
        if (mode === 'end') {
          const endTime = videoStart(clip) + videoClipLength(clip);
          const snapped = snapValue(endTime, undefined, clip);
          if (snapped.at !== null) {
            const targetLength = Math.max(0.2, snapped.value - videoStart(clip));
            if (clip.image) clip.duration = targetLength;
            else clip.trimEnd = Math.max(0, clip.duration - clipSourceTime(clip, targetLength));
          }
          showSnap(snapped.at);
        }
        syncLinkedAudioFromVideo(clip);
        layoutVideoLane();
        layoutAudioLane();
        scheduleUpdate();
      };

      const edgeScroll = createEdgeScroller(() => applyPointer(lastClientX, lastClientY));
      const move = (moveEvent: PointerEvent) => {
        if (moveEvent.pointerId !== event.pointerId) return;
        lastClientX = moveEvent.clientX;
        lastClientY = moveEvent.clientY;
        applyPointer(lastClientX, lastClientY);
        if (mode || dragging) edgeScroll.update(lastClientX);
      };

      const up = (upEvent: PointerEvent) => {
        if (upEvent.pointerId !== event.pointerId) return;
        edgeScroll.stop();
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
        document.removeEventListener('pointercancel', up);
        block.classList.remove('dragging');
        showSnap(null);
        // A plain click inside a multi-selection narrows it after the drag chance.
        if (keepGroup && !dragging) {
          setClipSelection('video', clip.id);
          announceClipSelection();
        }
        render();
        // Keep the scroll position the edge scroller just reached.
        seek(Math.min(time, playbackEnd()), false);
        commit();
      };
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up);
      document.addEventListener('pointercancel', up);
      if (mode) renderInspector();
    });

    block.addEventListener('dblclick', (event) => {
      event.preventDefault();
      event.stopPropagation();
      selected = { kind: 'video', id: clip.id };
      openVideoSections.add('transform');
      seek(clip.start);
      selectSideTab('video');
    });

    block.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        event.stopPropagation();
        selected = { kind: 'video', id: clip.id };
        render();
      } else if ((event.key === 'Delete' || event.key === 'Backspace') && selected?.id === clip.id) {
        event.preventDefault();
        event.stopPropagation();
        if (videoTrackLocked(clip.track)) lockedNotice();
        else removeSelected();
      } else if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        event.preventDefault();
        event.stopPropagation();
        if (videoTrackLocked(clip.track)) {
          lockedNotice();
          return;
        }
        clip.start = Math.max(0, clip.start + (event.key === 'ArrowLeft' ? -1 : 1));
        render();
        commit();
      } else if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        event.preventDefault();
        event.stopPropagation();
        if (videoTrackLocked(clip.track)) {
          lockedNotice();
          return;
        }
        clip.track = Math.max(0, Math.min(videoTrackCount - 1, clip.track + (event.key === 'ArrowUp' ? -1 : 1)));
        render();
        commit();
      }
    });
    return block;
  }

  function drawWave(canvas: HTMLCanvasElement, clip: AudioClip, width: number): void {
    const peaks = clip.peaks;
    const height = 38;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const pixelWidth = Math.max(1, Math.min(MAX_WAVE_CANVAS_WIDTH, Math.round(width * dpr)));
    const pixelHeight = Math.round(height * dpr);
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx || !peaks?.length) return;
    ctx.setTransform(pixelWidth / Math.max(1, width), 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    let loudest = 0;
    for (const value of peaks) if (value > loudest) loudest = value;
    const gain = Math.min(6, 0.92 / Math.max(0.001, loudest));
    if (clip.muted) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
    } else {
      const gradient = ctx.createLinearGradient(0, 0, 0, height);
      gradient.addColorStop(0, 'rgba(255, 255, 255, 0.95)');
      gradient.addColorStop(0.5, 'rgba(255, 255, 255, 0.8)');
      gradient.addColorStop(1, 'rgba(255, 255, 255, 0.6)');
      ctx.fillStyle = gradient;
    }
    const length = audioClipLength(clip);
    const duration = Math.max(0.001, clip.duration);
    const columns = Math.max(1, Math.min(MAX_WAVE_COLUMNS, Math.ceil(width)));
    const step = width / columns;
    for (let column = 0; column < columns; column += 1) {
      const x = column * step;
      const sourceStart = clipSourceTime(clip, (x / Math.max(1, width)) * length);
      const sourceEnd = clipSourceTime(clip, ((x + step) / Math.max(1, width)) * length);
      const peak = peakEnvelope(peaks, (sourceStart / duration) * peaks.length, (sourceEnd / duration) * peaks.length);
      const shaped = Math.pow(Math.min(1, peak * gain), 0.78);
      const h = Math.max(1, shaped * (height - 5));
      ctx.fillRect(x, (height - h) / 2, step + 0.5, h);
    }
    ctx.fillStyle = 'rgba(255, 255, 255, 0.18)';
    ctx.fillRect(0, height / 2, width, 0.5);
    const fadeIn = Math.min(clip.fadeIn, length / 2);
    const fadeOut = Math.min(clip.fadeOut, length / 2);
    ctx.fillStyle = 'rgba(2, 6, 23, 0.55)';
    if (fadeIn > 0) {
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo((fadeIn / Math.max(0.001, length)) * width, 0);
      ctx.lineTo(0, height);
      ctx.closePath();
      ctx.fill();
    }
    if (fadeOut > 0) {
      ctx.beginPath();
      ctx.moveTo(width, 0);
      ctx.lineTo(width - (fadeOut / Math.max(0.001, length)) * width, 0);
      ctx.lineTo(width, height);
      ctx.closePath();
      ctx.fill();
    }
  }

  function audioBlock(clip: AudioClip, scale: number): HTMLElement {
    const block = document.createElement('div');
    block.className = 'vt-clip vt-clip-audio';
    block.dataset.id = String(clip.id);
    block.tabIndex = 0;
    block.setAttribute('role', 'button');
    block.setAttribute('aria-pressed', String(isClipSelected('audio', clip.id)));
    block.classList.toggle('selected', isClipSelected('audio', clip.id));
    block.classList.toggle('muted', clip.muted);
    const width = Math.max(12, audioClipLength(clip) * scale);
    block.style.left = `${clip.offset * scale}px`;
    block.style.width = `${width}px`;
    block.title = `${clip.name}\nDrag to move · drag the edges to trim · drag the top corners to fade`;
    const canvas = document.createElement('canvas');
    drawWave(canvas, clip, width);
    const detail = document.createElement('canvas');
    detail.className = 'vt-wave-detail hidden';
    const loading = document.createElement('span');
    loading.className = 'vt-wave-loading hidden';
    loading.title = 'Building waveform…';
    loading.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.className = 'vt-clip-label';
    label.textContent = clip.name;
    block.append(canvas, detail, label, loading);
    const { left, right } = handles(block);
    let fadeInHandle: HTMLElement | null = null;
    let fadeOutHandle: HTMLElement | null = null;
    if (selected?.kind === 'audio' && selected.id === clip.id) {
      fadeInHandle = document.createElement('span');
      fadeInHandle.className = 'vt-fade vt-fade-in';
      fadeInHandle.title = 'Drag to set the fade in';
      fadeOutHandle = document.createElement('span');
      fadeOutHandle.className = 'vt-fade vt-fade-out';
      fadeOutHandle.title = 'Drag to set the fade out';
      block.append(fadeInHandle, fadeOutHandle);
    }
    const placeFades = (): void => {
      if (!fadeInHandle || !fadeOutHandle) return;
      const now = audioClipLength(clip);
      fadeInHandle.style.left = `${Math.min(width - 16, Math.max(11, (clip.fadeIn / Math.max(0.001, now)) * width))}px`;
      fadeOutHandle.style.right = `${Math.min(width - 16, Math.max(11, (clip.fadeOut / Math.max(0.001, now)) * width))}px`;
    };
    placeFades();

    block.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.stopPropagation();
      event.preventDefault();
      const additive = event.ctrlKey || event.metaKey;
      if (additive) {
        toggleClipSelection('audio', clip.id);
        selectedGraphic = -1;
        selectedTitle = -1;
        selectedSubtitleKey = '';
        render();
        renderInspector();
        announceClipSelection();
        return;
      }
      const previousKind = selected?.kind ?? null;
      const keepGroup = isClipSelected('audio', clip.id) && selectedClipCount() > 1;
      if (keepGroup) {
        selected = { kind: 'audio', id: clip.id };
        selectionAnchor = clipSelectionKey(selected);
      } else {
        setClipSelection('audio', clip.id);
      }
      selectedGraphic = -1;
      selectedTitle = -1;
      selectedSubtitleKey = '';
      paintClipSelection();
      announceClipSelection();
      selectSideTab('clip');
      if (previousKind !== 'audio') inspectorTab = 'audio';
      if (audioClipLocked(clip)) {
        renderInspector();
        lockedNotice();
        return;
      }
      const mode = event.target === left ? 'start'
        : event.target === right ? 'end'
          : event.target === fadeInHandle ? 'fade-in'
            : event.target === fadeOutHandle ? 'fade-out'
              : 'move';
      const group = selectedClipCount() > 1 ? groupMovePlan() : [];
      const origin = {
        x: event.clientX, y: event.clientY, offset: clip.offset, trimStart: clip.trimStart, trimEnd: clip.trimEnd,
        fadeIn: clip.fadeIn, fadeOut: clip.fadeOut, scrollLeft: scroll.scrollLeft, track: clip.track,
      };
      try { block.setPointerCapture(event.pointerId); } catch { /* synthetic or already released */ }
      block.classList.add('dragging');
      paintClipSelection();
      renderInspector();
      let lastClientX = event.clientX;
      let lastClientY = event.clientY;
      let moved = false;
      const applyPointer = (clientX: number, clientY: number): void => {
        const delta = (clientX - origin.x + (scroll.scrollLeft - origin.scrollLeft)) / pps();
        if (mode === 'move') {
          if (group.length > 1) {
            const groupDelta = snappedGroupDelta(group, origin.offset, audioClipLength(clip), delta, clip, undefined);
            applyGroupMove(group, groupDelta);
            clip.track = origin.track;
            layoutVideoLane();
            layoutAudioLane();
            if (playing) syncMedia(true);
            return;
          }
          let offset = Math.max(0, origin.offset + delta);
          const length = audioClipLength(clip);
          const startSnap = snapValue(offset, clip);
          const endSnap = snapValue(offset + length, clip);
          if (startSnap.at !== null) {
            offset = startSnap.value;
            showSnap(startSnap.at);
          } else if (endSnap.at !== null) {
            offset = Math.max(0, endSnap.value - length);
            showSnap(endSnap.at);
          } else {
            showSnap(null);
          }
          clip.offset = offset;
          const audioLaneTop = audioLane.getBoundingClientRect().top + trackTopPad();
          const audioRowCountNow = Math.max(audioTrackCount, audioRows().size ? Math.max(...audioRows().values()) + 1 : 0);
          const targetTrack = trackAtOffset(clientY - audioLaneTop, audioTrackHeights, audioRowHeight(), audioRowCountNow);
          if (targetTrack >= audioTrackCount) {
            audioTrackCount = targetTrack + 1;
            while (audioTrackState.length < audioTrackCount) audioTrackState.push({ muted: false, locked: false, solo: false });
            audioRowsCache = null;
            renderTimeline();
            status.textContent = `New audio track A${audioTrackCount} created.`;
          }
          clip.track = targetTrack;
        } else if (mode === 'start') {
          // Moving the left edge trims the source and shifts the clip, so the
          // remaining audio stays where it is on the timeline.
          const original = { ...clip, ...origin };
          const earliest = clipPlaybackTime(original, 0);
          let change = Math.max(earliest, Math.min(delta, audioClipLength(original) - 0.1));
          change = Math.max(change, -origin.offset);
          const snapped = snapValue(origin.offset + change, clip);
          if (snapped.at !== null && snapped.value >= origin.offset + earliest) {
            change = snapped.value - origin.offset;
            showSnap(snapped.at);
          } else {
            showSnap(null);
          }
          clip.trimStart = clipSourceTime(original, change);
          clip.offset = origin.offset + change;
        } else if (mode === 'end') {
          const end = advanceSource(clip.retime, clip.duration - origin.trimEnd, delta);
          let trimEnd = Math.max(0, Math.min(clip.duration - clip.trimStart - 0.1, clip.duration - end));
          const endTime = clip.offset + clipPlaybackTime(clip, clip.duration - trimEnd);
          const snapped = snapValue(endTime, clip);
          if (snapped.at !== null) {
            trimEnd = Math.max(0, clip.duration - clipSourceTime(clip, snapped.value - clip.offset));
            showSnap(snapped.at);
          } else {
            showSnap(null);
          }
          clip.trimEnd = Math.min(trimEnd, clip.duration - clip.trimStart - 0.1);
        } else if (mode === 'fade-in') {
          const current = audioLane.querySelector<HTMLElement>(`.vt-clip[data-id="${clip.id}"]`) ?? block;
          clip.fadeIn = Math.max(0, Math.min(audioClipLength(clip) / 2, (clientX - current.getBoundingClientRect().left) / pps()));
          showSnap(null);
        } else {
          const current = audioLane.querySelector<HTMLElement>(`.vt-clip[data-id="${clip.id}"]`) ?? block;
          clip.fadeOut = Math.max(0, Math.min(audioClipLength(clip) / 2, (current.getBoundingClientRect().right - clientX) / pps()));
          showSnap(null);
        }
        if (mode !== 'fade-in' && mode !== 'fade-out') {
          syncLinkedVideoFromAudio(clip);
          layoutVideoLane();
        }
        const scaleNow = pps();
        const current = audioLane.querySelector<HTMLElement>(`.vt-clip[data-id="${clip.id}"]`) ?? block;
        invalidateTimelineDerived();
        current.style.left = `${clip.offset * scaleNow}px`;
        current.style.top = `${trackTopPad() + audioTrackTop(clip.track)}px`;
        current.style.height = `${audioTrackHeight(clip.track)}px`;
        const nextWidth = Math.max(12, audioClipLength(clip) * scaleNow);
        current.style.width = `${nextWidth}px`;
        const currentWave = current.querySelector('canvas') ?? canvas;
        if (mode !== 'move') drawWave(currentWave, clip, nextWidth);
        placeFades();
        if (mode !== 'fade-in' && mode !== 'fade-out') {
          const span = timelineLength();
          const width = Math.ceil(span * scaleNow);
          if (content.style.width !== `${width}px`) {
            content.style.width = `${width}px`;
            renderRuler(scaleNow, span);
          }
        }
        if (playing) syncMedia(true);
      };
      const edgeScroll = createEdgeScroller(() => applyPointer(lastClientX, lastClientY));
      const move = (moveEvent: PointerEvent) => {
        if (moveEvent.pointerId !== event.pointerId) return;
        if (Math.hypot(moveEvent.clientX - event.clientX, moveEvent.clientY - event.clientY) > 2) moved = true;
        lastClientX = moveEvent.clientX;
        lastClientY = moveEvent.clientY;
        applyPointer(lastClientX, lastClientY);
        if (mode !== 'fade-in' && mode !== 'fade-out') edgeScroll.update(lastClientX);
      };
      const up = (upEvent: PointerEvent) => {
        if (upEvent.pointerId !== event.pointerId) return;
        edgeScroll.stop();
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
        document.removeEventListener('pointercancel', up);
        block.classList.remove('dragging');
        showSnap(null);
        if (keepGroup && !moved) {
          setClipSelection('audio', clip.id);
          announceClipSelection();
        }
        render();
        commit();
      };
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up);
      document.addEventListener('pointercancel', up);
    });

    block.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        event.stopPropagation();
        selected = { kind: 'audio', id: clip.id };
        render();
      } else if ((event.key === 'Delete' || event.key === 'Backspace') && selected?.id === clip.id) {
        event.preventDefault();
        event.stopPropagation();
        if (audioClipLocked(clip)) lockedNotice();
        else removeSelected();
      }
    });
    return block;
  }

  let shownTimecode = '';
  let shownTimeLabel = '';
  function positionPlayhead(): void {
    animationPanel?.position(time);
    playhead.style.left = `${time * pps()}px`;
    const nextTimecode = timecodeLabel(time);
    if (nextTimecode !== shownTimecode) {
      shownTimecode = nextTimecode;
      timecode.textContent = nextTimecode;
    }
    const nextTimeLabel = `${formatClock(time, true)} / ${formatClock(timelineEnd(), true)}`;
    if (nextTimeLabel !== shownTimeLabel) {
      shownTimeLabel = nextTimeLabel;
      timeLabel.textContent = nextTimeLabel;
    }
    renderTextLayer();
    renderGraphicsPreview();
  }

  // Inspector ----------------------------------------------------------------
  const decimalPlaces = (value: number): number => {
    const text = String(value);
    const point = text.indexOf('.');
    return point < 0 ? 0 : text.length - point - 1;
  };

  /** Click-drag a number field horizontally, like a value slider in DaVinci. */
  function enableNumberScrub(input: HTMLInputElement): void {
    if (input.dataset.numberScrub) return;
    input.dataset.numberScrub = 'true';
    if (!input.title) input.title = 'Drag left or right to adjust. Hold Shift for faster, Alt for finer.';

    input.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || event.pointerType === 'touch' || input.disabled || input.readOnly) return;
      const bounds = input.getBoundingClientRect();
      // Leave the native up/down spinner buttons alone.
      if (event.clientX >= bounds.right - Math.min(20, bounds.width * 0.22)) return;
      const startValue = Number(input.value);
      if (!Number.isFinite(startValue)) return;
      const parsedStep = Number(input.step);
      const step = Number.isFinite(parsedStep) && parsedStep > 0 ? parsedStep : 1;
      const minText = input.getAttribute('min');
      const maxText = input.getAttribute('max');
      const min = minText !== null && minText !== '' ? Number(minText) : -Infinity;
      const max = maxText !== null && maxText !== '' ? Number(maxText) : Infinity;
      const low = Number.isFinite(min) ? min : -Infinity;
      const high = Number.isFinite(max) ? max : Infinity;
      const base = Number.isFinite(low) ? low : 0;
      const decimals = Math.max(0, Math.min(8, decimalPlaces(step)));
      let dragging = false;
      let startX = event.clientX;

      const move = (moveEvent: PointerEvent) => {
        if (moveEvent.pointerId !== event.pointerId) return;
        const delta = moveEvent.clientX - startX;
        if (!dragging && Math.abs(delta) < 3) return;
        if (!dragging) {
          dragging = true;
          input.classList.add('number-scrub-active');
          document.body.classList.add('number-scrubbing');
          document.getSelection()?.removeAllRanges();
        }
        moveEvent.preventDefault();
        const speed = moveEvent.shiftKey ? 8 : moveEvent.altKey ? 0.25 : 1;
        const steps = (delta / 4) * speed;
        let next = startValue + steps * step;
        next = base + Math.round((next - base) / step) * step;
        next = Math.max(low, Math.min(high, next));
        next = Number(next.toFixed(decimals));
        if (input.value !== String(next)) {
          input.value = String(next);
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
      };

      const finish = (finishEvent: PointerEvent) => {
        if (finishEvent.pointerId !== event.pointerId) return;
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', finish);
        document.removeEventListener('pointercancel', finish);
        input.classList.remove('number-scrub-active');
        document.body.classList.remove('number-scrubbing');
        if (dragging) input.dispatchEvent(new Event('change', { bubbles: true }));
        dragging = false;
        startX = 0;
      };

      input.focus({ preventScroll: true });
      document.addEventListener('pointermove', move, { passive: false });
      document.addEventListener('pointerup', finish);
      document.addEventListener('pointercancel', finish);
    });
  }

  function field(label: string, value: number, attributes: Record<string, string>, onChange: (value: number) => void): HTMLElement {
    const wrap = document.createElement('label');
    wrap.className = 'sfield';
    const caption = document.createElement('span');
    caption.className = 'field-label';
    caption.textContent = label;
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'select font-mono';
    input.value = String(Math.round(value * 100) / 100);
    for (const [key, attribute] of Object.entries(attributes)) input.setAttribute(key, attribute);
    enableNumberScrub(input);
    let liveFrame = 0;
    input.addEventListener('input', () => {
      const parsed = Number(input.value);
      if (!Number.isFinite(parsed)) return;
      onChange(parsed);
      if (liveFrame) return;
      liveFrame = requestAnimationFrame(() => {
        liveFrame = 0;
        renderTimeline();
        seek(Math.min(time, timelineEnd()));
      });
    });
    input.addEventListener('change', () => {
      if (liveFrame) cancelAnimationFrame(liveFrame);
      liveFrame = 0;
      const parsed = Number(input.value);
      if (Number.isFinite(parsed)) onChange(parsed);
      render();
      seek(Math.min(time, timelineEnd()));
      commit();
    });
    wrap.append(caption, input);
    return wrap;
  }

  type AnimKey = keyof ClipAnimation;

  function animatedValue(clip: VideoClip, key: AnimKey, at = time): number {
    const state = clipStateAt(clip, at);
    if (key === 'opacity') return state.opacity;
    if (key === 'volume') return state.volume;
    if (key === 'brightness' || key === 'contrast' || key === 'saturation' || key === 'hue' || key === 'blur') {
      return effectAnimationAt(clip.animation, clipLocalTime(clip, at), clip.effects)[key];
    }
    return state.transform[key];
  }

  function setAnimatedValue(clip: VideoClip, key: AnimKey, value: number): void {
    const at = clipLocalTime(clip);
    const keys = clip.animation[key];
    if (keys.length) {
      const existing = keyframeNear(keys, at, 0.000001);
      clip.animation[key] = withKeyframe(keys, existing?.at ?? at, value, existing?.easing);
      return;
    }
    if (key === 'opacity') {
      clip.effects.opacity = Math.max(0, Math.min(1, value));
      return;
    }
    if (key === 'volume') {
      clip.volume = Math.max(0, value);
      return;
    }
    if (key === 'brightness' || key === 'contrast' || key === 'saturation' || key === 'hue' || key === 'blur') {
      clip.effects[key] = value;
      return;
    }
    clip.transform[key] = value;
  }

  function toggleKeyframe(clip: VideoClip, key: AnimKey): void {
    const at = clipLocalTime(clip);
    const existing = keyframeNear(clip.animation[key], at, 0.000001);
    if (existing) {
      clip.animation[key] = withoutKeyframe(clip.animation[key], existing.at);
      return;
    }
    clip.animation[key] = withKeyframe(clip.animation[key], at, animatedValue(clip, key), 'linear');
  }

  function keyframeButton(clip: VideoClip, key: AnimKey): HTMLButtonElement {
    const at = clipLocalTime(clip);
    const active = Boolean(keyframeNear(clip.animation[key], at, 0.000001));
    const element = document.createElement('button');
    element.type = 'button';
    element.className = 'video-keyframe' + (active ? ' active' : '');
    element.textContent = '◆';
    element.title = active
      ? `Remove the ${key} keyframe at ${formatClock(at, true)}`
      : `Keyframe ${key} at ${formatClock(at, true)}`;
    element.setAttribute('aria-label', element.title);
    element.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleKeyframe(clip, key);
      applyPreviewTransform(activeVideo);
      renderTimeline();
      renderInspector();
      commit();
    });
    return element;
  }

  /** Number field with a keyframe diamond pinned to its top-right corner. */
  function keyField(
    label: string,
    value: number,
    attributes: Record<string, string>,
    onChange: (value: number) => void,
    clip: VideoClip,
    key: AnimKey,
  ): HTMLElement {
    const cell = document.createElement('div');
    cell.className = 'video-key-cell';
    cell.append(field(label, value, attributes, onChange), keyframeButton(clip, key));
    return cell;
  }

  function sliderField(
    label: string,
    value: number,
    min: number,
    max: number,
    step: number,
    format: (value: number) => string,
    onInput: (value: number) => void,
  ): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'video-slider';
    const head = document.createElement('div');
    head.className = 'video-slider-head';
    const caption = document.createElement('span');
    caption.className = 'field-label';
    caption.textContent = label;
    const output = document.createElement('output');
    output.className = 'font-mono text-[11px] text-slate-300';
    output.textContent = format(value);
    head.append(caption, output);
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    input.className = 'studio-range';
    input.addEventListener('input', () => {
      const next = Number(input.value);
      output.textContent = format(next);
      onInput(next);
      invalidateFingerprint();
    });
    input.addEventListener('change', () => {
      applyPreviewTransform(activeVideo);
      renderTimeline();
      commit();
    });
    wrap.append(head, input);
    return wrap;
  }

  function trackPicker(label: string, tracks: string[], value: number, onChange: (value: number) => void): HTMLElement | null {    if (tracks.length < 2) return null;
    const wrap = document.createElement('label');
    wrap.className = 'sfield col-span-2';
    const caption = document.createElement('span');
    caption.className = 'field-label';
    caption.textContent = label;
    const select = document.createElement('select');
    select.className = 'select';
    tracks.forEach((name, i) => select.add(new Option(name, String(i))));
    select.value = String(value);
    select.addEventListener('change', () => onChange(Number(select.value)));
    wrap.append(caption, select);
    return wrap;
  }

  function check(label: string, value: boolean, onChange: (checked: boolean) => void): HTMLElement {
    const wrap = document.createElement('label');
    wrap.className = 'col-span-2 flex items-center gap-2 text-[11px] text-slate-200';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'checkbox';
    input.checked = value;
    input.addEventListener('change', () => onChange(input.checked));
    const text = document.createElement('span');
    text.textContent = label;
    wrap.append(input, text);
    return wrap;
  }

  function button(label: string, action: () => void, variant = 'btn-ghost', disabled = false): HTMLButtonElement {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = variant;
    element.textContent = label;
    element.disabled = disabled;
    element.dataset.action = label;
    element.addEventListener('click', action);
    return element;
  }

  type ClipTarget =
    | { kind: 'video'; clip: VideoClip }
    | { kind: 'audio'; clip: AudioClip };

  function clipAtPlayhead(): ClipTarget | null {
    if (selected?.kind === 'video') {
      const clip = videos.find((entry) => entry.id === selected!.id);
      if (clip) {
        const local = time - videoStart(clip);
        if (local > 0.05 && local < videoClipLength(clip) - 0.05) return { kind: 'video', clip };
      }
    }
    if (selected?.kind === 'audio') {
      const clip = audios.find((entry) => entry.id === selected!.id);
      if (clip) {
        const local = time - clip.offset;
        if (local > 0.05 && local < audioClipLength(clip) - 0.05) return { kind: 'audio', clip };
      }
    }
    const active = videoAt(time);
    if (active) {
      const local = time - active.clip.start;
      if (local > 0.05 && local < videoClipLength(active.clip) - 0.05) return { kind: 'video', clip: active.clip };
    }
    for (const clip of audios) {
      const local = time - clip.offset;
      if (local > 0.05 && local < audioClipLength(clip) - 0.05) return { kind: 'audio', clip };
    }
    return null;
  }

  function* mediaSplitCandidates(): Generator<ClipTarget> {
    const chosen = selectedClipMembers();
    if (!chosen.length) {
      if (selectedTitle >= 0 || selectedGraphic >= 0 || selectedSubtitleKey) return;
      for (const clip of videos) yield { kind: 'video', clip };
      for (const clip of audios) yield { kind: 'audio', clip };
      return;
    }
    const included = new Set(chosen.map(({ clip }) => clip.id));
    yield* chosen;
    for (const target of chosen) {
      if (target.kind === 'video') {
        const clip = linkedAudioFor(target.clip);
        if (clip && !included.has(clip.id)) yield { kind: 'audio', clip };
      } else {
        const clip = linkedVideoFor(target.clip);
        if (clip && !included.has(clip.id)) yield { kind: 'video', clip };
      }
    }
  }

  function intersectsSplit(target: ClipTarget): boolean {
    const [start, length] = target.kind === 'video'
      ? [target.clip.start, videoClipLength(target.clip)]
      : [target.clip.offset, audioClipLength(target.clip)];
    return time > start + 0.001 && time < start + length - 0.001;
  }

  function canSplitAtPlayhead(): boolean {
    const title = !selected && titles[selectedTitle];
    if (title) return time > title.start + 0.05 && time < title.end - 0.05;
    for (const target of mediaSplitCandidates()) if (intersectsSplit(target)) return true;
    return false;
  }

  function splitVideo(clip: VideoClip): VideoClip {
    const local = time - clip.start;
    const right: VideoClip = {
      ...clip,
      id: ++nextId,
      url: URL.createObjectURL(clip.file),
      start: time,
      proxyUrl: clip.proxy ? URL.createObjectURL(clip.proxy.blob) : '',
      transform: clipTransform(clip.transform),
      effects: normalizeEffects(clip.effects),
      animation: normalizeAnimation(clip.animation),
      transition: clip.transition ? { ...clip.transition } : undefined,
      linkGroup: undefined,
      linkOffset: undefined,
    };
    if (clip.image) {
      const sourceSplit = clip.trimStart + local * right.effects.speed;
      right.duration = clip.duration - sourceSplit;
      right.trimStart = 0;
      clip.duration = sourceSplit + clip.trimEnd;
    } else {
      right.trimStart = clipSourceTime(clip, local);
      clip.trimEnd = clip.duration - right.trimStart;
    }
    videos.splice(videos.indexOf(clip) + 1, 0, right);
    return right;
  }

  function splitAudio(clip: AudioClip): AudioClip {
    const sourceSplit = clipSourceTime(clip, time - clip.offset);
    const url = URL.createObjectURL(clip.file);
    const right: AudioClip = {
      ...clip, id: ++nextId, url, offset: time, trimStart: sourceSplit,
      fadeIn: 0, ...makeAudio(url), linkGroup: undefined,
    };
    clip.trimEnd = clip.duration - sourceSplit;
    clip.fadeOut = 0;
    audios.splice(audios.indexOf(clip) + 1, 0, right);
    return right;
  }

  function splitAtPlayhead(): void {
    if (splitTitleAtPlayhead()) return;
    const intersecting = [...mediaSplitCandidates()].filter(intersectsSplit);
    if (!intersecting.length) {
      status.textContent = selected || selectedTitle >= 0 || selectedGraphic >= 0 || selectedSubtitleKey
        ? 'Put the playhead inside the selected video or audio clips to split them.'
        : 'Move the playhead inside a clip, then split.';
      return;
    }

    // If both halves cross the cut, treat a linked pair as one edit for locking.
    const lockedGroups = new Set<number>();
    const blocked = new Set<number>();
    for (const target of intersecting) {
      const clip = target.clip;
      if (!(target.kind === 'video' ? videoClipLocked(target.clip) : audioClipLocked(target.clip))) continue;
      blocked.add(clip.id);
      if (clip.linkGroup !== undefined) lockedGroups.add(clip.linkGroup);
    }
    const videoRights = new Map<VideoClip, VideoClip>();
    const audioRights = new Map<AudioClip, AudioClip>();
    for (const target of intersecting) {
      if (blocked.has(target.clip.id) || (target.clip.linkGroup !== undefined && lockedGroups.has(target.clip.linkGroup))) continue;
      if (target.kind === 'video') videoRights.set(target.clip, splitVideo(target.clip));
      else audioRights.set(target.clip, splitAudio(target.clip));
    }
    if (!videoRights.size && !audioRights.size) {
      lockedNotice();
      return;
    }

    for (const [video, right] of videoRights) {
      const audio = linkedAudioFor(video);
      if (!audio) continue;
      const audioRight = audioRights.get(audio);
      if (audioRight) {
        right.linkGroup = audioRight.linkGroup = ++nextLinkGroup;
        right.linkOffset = 0;
      } else if (audio.offset >= time) {
        right.linkGroup = video.linkGroup;
        right.linkOffset = audio.offset - right.start;
        video.linkGroup = undefined;
        video.linkOffset = undefined;
      }
    }
    for (const [audio, right] of audioRights) {
      if (right.linkGroup !== undefined) continue;
      const video = linkedVideoFor(audio);
      if (video && video.start >= time) {
        right.linkGroup = audio.linkGroup;
        video.linkOffset = right.offset - video.start;
        audio.linkGroup = undefined;
      }
    }

    const moveSelection = (kind: ClipSelection['kind'], left: { id: number }, right: { id: number }): void => {
      if (!selectedClipKeys.delete(clipSelectionKey({ kind, id: left.id }))) return;
      selectedClipKeys.add(clipSelectionKey({ kind, id: right.id }));
      if (selected?.kind === kind && selected.id === left.id) selected = { kind, id: right.id };
    };
    for (const [left, right] of videoRights) moveSelection('video', left, right);
    for (const [left, right] of audioRights) moveSelection('audio', left, right);
    selectionAnchor = selected ? clipSelectionKey(selected) : '';
    invalidateTimelineDerived();
    render();
    seek(time);
    commit('Split at playhead');
    status.textContent = blocked.size ? 'Split at the playhead. Locked tracks skipped.' : 'Split at the playhead.';
  }

  /**
   * Remove a time span from every track and close the gap. Used by transcript
   * word deletion and silence removal; the caller records the edit and commits.
   */
  function cutSpan(start: number, end: number, ripple = true): void {
    const span = end - start;
    if (!(span > 0.02)) return;
    const eps = 0.001;
    const nextVideos: VideoClip[] = [];
    for (const clip of videos) {
      if (videoTrackLocked(clip.track)) {
        nextVideos.push(clip);
        continue;
      }
      const from = clip.start;
      const to = from + videoClipLength(clip);
      if (to <= start + eps || from >= end - eps) {
        nextVideos.push(clip);
        continue;
      }
      const leftLength = Math.max(0, start - from);
      const rightLength = Math.max(0, to - end);
      if (leftLength > 0.02) {
        if (clip.image) nextVideos.push({ ...clip, duration: leftLength });
        else {
          nextVideos.push({ ...clip, trimEnd: Math.max(0, clip.duration - clipSourceTime(clip, leftLength)) });
        }
      }
      if (rightLength > 0.02) {
        const rightStart = ripple ? start : end;
        if (clip.image) {
          nextVideos.push({ ...clip, id: ++nextId, start: rightStart, duration: rightLength, linkGroup: undefined, linkOffset: undefined });
        } else {
          nextVideos.push({
            ...clip,
            id: ++nextId,
            start: rightStart,
            trimStart: clipSourceTime(clip, end - from),
            linkGroup: undefined,
            linkOffset: undefined,
          });
        }
      }
    }
    videos = nextVideos;
    if (ripple) {
      for (const clip of videos) {
        if (videoTrackLocked(clip.track)) continue;
        if (clip.start >= end - eps) clip.start = Math.max(0, clip.start - span);
      }
    }
    if (selected?.kind === 'video' && !videos.some((clip) => clip.id === selected!.id)) selected = null;

    const nextAudios: AudioClip[] = [];
    const audioRowMap = audioRows();
    for (const clip of audios) {
      if (audioTrackLocked(audioRowMap.get(clip.id) ?? 0)) {
        nextAudios.push(clip);
        continue;
      }
      const from = clip.offset;
      const to = from + audioClipLength(clip);
      if (to <= start + eps || from >= end - eps) {
        nextAudios.push(clip);
        continue;
      }
      const leftLength = Math.max(0, start - from);
      const rightLength = Math.max(0, to - end);
      if (leftLength > 0.02) {
        nextAudios.push({ ...clip, trimEnd: Math.max(0, clip.duration - clipSourceTime(clip, leftLength)) });
      }
      if (rightLength > 0.02) {
        const url = clip.url;
        nextAudios.push({
          ...clip,
          id: ++nextId,
          offset: ripple ? start : end,
          trimStart: clipSourceTime(clip, end - from),
          fadeIn: 0,
          ...makeAudio(url),
          linkGroup: undefined,
        });
      }
    }
    audios = nextAudios;
    if (ripple) {
      for (const clip of audios) {
        if (audioTrackLocked(audioRowMap.get(clip.id) ?? 0)) continue;
        if (clip.offset >= end - eps) clip.offset = Math.max(0, clip.offset - span);
      }
    }
    if (selected?.kind === 'audio' && !audios.some((clip) => clip.id === selected!.id)) selected = null;

    if (fileCues && !captionTrackState.locked) {
      const map = (at: number): number => (at <= start ? at : at >= end ? at - span : start);
      fileCues = fileCues
        .map((cue) => ({ ...cue, start: map(cue.start), end: map(cue.end) }))
        .filter((cue) => cue.end - cue.start > 0.04);
    }
    invalidateTimelineDerived();
    invalidateFingerprint();
    invalidateShiftedCues();
    captionLaneKey = '';
    time = Math.min(time, timelineEnd());
  }

  function currentTarget(): ClipTarget | null {
    if (selected?.kind === 'video') {
      const clip = videos.find((entry) => entry.id === selected!.id);
      if (clip) return { kind: 'video', clip };
    }
    if (selected?.kind === 'audio') {
      const clip = audios.find((entry) => entry.id === selected!.id);
      if (clip) return { kind: 'audio', clip };
    }
    return clipAtPlayhead();
  }

  function trimStartToPlayhead(): void {
    const target = currentTarget();
    if (!target) {
      status.textContent = 'Select a clip, then put the playhead inside it.';
      return;
    }
    if (target.kind === 'video' ? videoClipLocked(target.clip) : audioClipLocked(target.clip)) {
      lockedNotice();
      return;
    }
    if (target.kind === 'video') {
      const clip = target.clip;
      const end = clip.start + videoClipLength(clip);
      if (!(time > clip.start + 0.05 && time < end - 0.05)) {
        status.textContent = 'Put the playhead inside the selected clip.';
        return;
      }
      if (clip.image) {
        const end = clip.start + clip.duration;
        clip.start = time;
        clip.duration = Math.max(0.05, end - time);
      } else {
        clip.trimStart = clipSourceTime(clip, time - clip.start);
        clip.start = time;
      }
    } else {
      const clip = target.clip;
      const end = clip.offset + audioClipLength(clip);
      if (!(time > clip.offset + 0.05 && time < end - 0.05)) {
        status.textContent = 'Put the playhead inside the selected clip.';
        return;
      }
      clip.trimStart = clipSourceTime(clip, time - clip.offset);
      clip.offset = time;
    }
    if (target.kind === 'video') syncLinkedAudioFromVideo(target.clip);
    else syncLinkedVideoFromAudio(target.clip);
    render();
    seek(time);
    commit();
    status.textContent = 'Trimmed the clip start to the playhead.';
  }

  function trimEndToPlayhead(): void {
    const target = currentTarget();
    if (!target) {
      status.textContent = 'Select a clip, then put the playhead inside it.';
      return;
    }
    if (target.kind === 'video' ? videoClipLocked(target.clip) : audioClipLocked(target.clip)) {
      lockedNotice();
      return;
    }
    if (target.kind === 'video') {
      const clip = target.clip;
      const end = clip.start + videoClipLength(clip);
      if (!(time > clip.start + 0.05 && time < end - 0.05)) {
        status.textContent = 'Put the playhead inside the selected clip.';
        return;
      }
      if (clip.image) clip.duration = time - clip.start;
      else {
        clip.trimEnd = clip.duration - clipSourceTime(clip, time - clip.start);
      }
    } else {
      const clip = target.clip;
      const end = clip.offset + audioClipLength(clip);
      if (!(time > clip.offset + 0.05 && time < end - 0.05)) {
        status.textContent = 'Put the playhead inside the selected clip.';
        return;
      }
      clip.trimEnd = clip.duration - clipSourceTime(clip, time - clip.offset);
    }
    if (target.kind === 'video') syncLinkedAudioFromVideo(target.clip);
    else syncLinkedVideoFromAudio(target.clip);
    render();
    seek(time);
    commit();
    status.textContent = 'Trimmed the clip end to the playhead.';
  }

  function duplicateSelected(): void {
    if (selectedGraphic >= 0 && !selected && selectedTitle < 0) {
      const graphic = graphics[selectedGraphic];
      if (!graphic) return;
      if (videoTrackLocked(graphicTrackIndex(graphic))) {
        lockedNotice();
        return;
      }
      const length = graphic.end - graphic.start;
      const copy: GraphicClip = {
        ...graphic,
        id: ++nextId,
        start: graphic.end,
        end: graphic.end + length,
      };
      graphics.splice(selectedGraphic + 1, 0, copy);
      selectedGraphic += 1;
      graphicsPreviewKey = '';
      renderGraphicsPreview();
      render();
      seek(copy.start);
      commit('Duplicated graphic overlay');
      status.textContent = 'Duplicated the selected shape.';
      return;
    }
    if (selectedTitle >= 0 && !selected) {
      const cue = titles[selectedTitle];
      if (!cue) return;
      if (videoTrackLocked(titleTrackIndex(cue))) {
        lockedNotice();
        return;
      }
      const length = cue.end - cue.start;
      const copy: Cue = {
        ...cue,
        start: cue.end,
        end: cue.end + length,
        style: cue.style ? { ...cue.style } : undefined,
      };
      titles.splice(selectedTitle + 1, 0, copy);
      selectedTitle += 1;
      invalidateShiftedCues();
      render();
      seek(copy.start);
      commit();
      status.textContent = 'Duplicated the selected title.';
      return;
    }
    const target = currentTarget();
    if (!target) return;
    if (target.kind === 'video' ? videoClipLocked(target.clip) : audioClipLocked(target.clip)) {
      lockedNotice();
      return;
    }
    if (target.kind === 'video') duplicateVideo(target.clip);
    else duplicateAudio(target.clip);
    status.textContent = 'Duplicated the selected clip.';
  }

  function rippleDeleteSelected(): void {
    const target = currentTarget();
    if (!target) return;
    if (target.kind === 'video' ? videoClipLocked(target.clip) : audioClipLocked(target.clip)) {
      lockedNotice();
      return;
    }
    const start = target.kind === 'video' ? target.clip.start : target.clip.offset;
    const end = start + (target.kind === 'video' ? videoClipLength(target.clip) : audioClipLength(target.clip));
    cutSpan(start, end, true);
    selected = null;
    render();
    seek(Math.min(time, timelineEnd()));
    commit();
    status.textContent = 'Removed the clip and closed the gap on every track.';
  }

  function toggleSnap(): void {
    snapEnabled = !snapEnabled;
    updateTimelineTools();
    status.textContent = snapEnabled ? 'Magnetic snapping on.' : 'Magnetic snapping off.';
  }

  function toggleLinkedClips(): void {
    linkClipsEnabled = !linkClipsEnabled;
    if (linkClipsEnabled) {
      for (const clip of videos) syncLinkedAudioFromVideo(clip);
    }
    saveLayout();
    renderTimeline();
    updateTimelineTools();
    status.textContent = linkClipsEnabled
      ? 'Audio/video link on. Linked clips move and trim together.'
      : 'Audio/video link off. Audio and video can drift out of sync.';
  }

  function toggleMaximizeTimeline(): void {
    const max = maxTimelineHeight();
    if (timelineHeight >= max - 2) {
      timelineHeight = timelinePreviousHeight;
    } else {
      timelinePreviousHeight = timelineHeight;
      timelineHeight = max;
    }
    applyLayout();
    saveLayout();
    updateTimelineTools();
  }

  function toggleTrackSize(): void {
    compactTracks = !compactTracks;
    videoTrackHeights = [];
    audioTrackHeights = [];
    timelineBox.classList.toggle('video-compact-tracks', compactTracks);
    render();
    seek(time);
    saveLayout();
    updateTimelineTools();
    status.textContent = compactTracks ? 'Compact tracks.' : 'Large tracks.';
  }

  function toolIcon(name: string): string {
    const wrap = (body: string): string =>
      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
    switch (name) {
      case 'undo': return wrap('<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>');
      case 'redo': return wrap('<path d="m15 14 5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/>');
      case 'copy': return wrap('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5h10"/>');
      case 'cut': return wrap('<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><path d="m8 7.5 12 10M8 16.5l12-10"/>');
      case 'paste': return wrap('<path d="M9 5h6M9 3h6v4H9z"/><path d="M7 5H5v16h14V5h-2"/>');
      case 'history': return wrap('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/>');
      case 'split': return wrap('<path d="M12 3v18"/><path d="m7 7-4 5 4 5M17 7l4 5-4 5"/>');
      case 'trim-start': return wrap('<path d="M5 4v16"/><path d="M19 4v16"/><path d="M9 12h8"/><path d="m7 10-2 2 2 2"/>');
      case 'trim-end': return wrap('<path d="M5 4v16"/><path d="M19 4v16"/><path d="M7 12h8"/><path d="m17 10 2 2-2 2"/>');
      case 'duplicate': return wrap('<rect x="8" y="8" width="11" height="11" rx="2"/><path d="M5 15V5h10"/>');
      case 'delete': return wrap('<path d="M4 7h16"/><path d="M9 7V5h6v2"/><path d="m6 7 1 13h10l1-13"/>');
      case 'ripple': return wrap('<path d="M4 7h11"/><path d="M4 12h7"/><path d="M4 17h11"/><path d="m17 8 4 4-4 4"/>');
      case 'snap': return wrap('<path d="M6 4v8a6 6 0 0 0 12 0V4"/><path d="M10 4v8a2 2 0 0 0 4 0V4"/><path d="M6 4h4M14 4h4M6 7h4M14 7h4"/>');
      case 'linked': return wrap('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>');
      case 'maximize': return wrap('<path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"/>');
      case 'tracks': return wrap('<path d="M4 6h16M4 12h16M4 18h16"/><path d="M8 4v4M14 10v4M10 16v4"/>');
      case 'media': return wrap('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 15 5-4 4 3 3-2 6 5"/><circle cx="9" cy="9" r="1.4"/>');
      case 'search': return wrap('<circle cx="11" cy="11" r="7"/><path d="m16.5 16.5 4 4"/>');
      case 'edit': return wrap('<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>');
      case 'effects': return wrap('<path d="m12 3 1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6Z"/><path d="m19 15 .8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8Z"/><path d="m5 14 .7 1.8L7.5 16l-1.8.7L5 18.5l-.7-1.8L2.5 16l1.8-.2Z"/>');
      case 'captions': return wrap('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M10 10H7a2 2 0 0 0 0 4h3M17 10h-3a2 2 0 0 0 0 4h3"/>');
      case 'audio': return wrap('<path d="M9 18V5l10-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="16" cy="16" r="3"/>');
      case 'transcript': return wrap('<path d="M5 5h14M5 10h14M5 15h9M5 20h6"/><path d="M19 15v5M16.5 17.5h5"/>');
      case 'text': return wrap('<path d="M4 6h16M12 6v13M8 19h8"/>');
      case 'graphics': return wrap('<rect x="3" y="3" width="9" height="9" rx="1"/><circle cx="16.5" cy="16.5" r="4.5"/><path d="m3 18 5-4 3 2"/>');
      case 'transitions': return wrap('<rect x="3" y="6" width="7" height="12" rx="1"/><rect x="14" y="6" width="7" height="12" rx="1"/><path d="M10 12h4"/>');
      case 'keys': return wrap('<path d="m12 3 9 9-9 9-9-9Z"/><path d="m7 12 5-5 5 5-5 5Z"/>');
      case 'multicam': return wrap('<rect x="3" y="7" width="8" height="10" rx="1.5"/><rect x="13" y="7" width="8" height="10" rx="1.5"/><path d="M11 12h2"/>');
      case 'ai': return wrap('<path d="m12 3 1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6Z"/><path d="m19 15 .8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8Z"/><path d="m5 14 .7 1.8L7.5 16l-1.8.7L5 18.5l-.7-1.8L2.5 16l1.8-.2Z"/>');
      default: return wrap('<circle cx="12" cy="12" r="8"/>');
    }
  }

  function renderTimelineTools(): void {
    timelineTools.replaceChildren();
    const entries: { id: string; title: string; separator?: boolean }[] = [
      { id: 'undo', title: 'Undo (Ctrl+Z)' },
      { id: 'redo', title: 'Redo (Ctrl+Shift+Z)' },
      { id: 'history', title: 'Action history', separator: true },
      { id: 'copy', title: 'Copy clip (Ctrl+C)' },
      { id: 'cut', title: 'Cut clip (Ctrl+X)' },
      { id: 'paste', title: 'Paste clip (Ctrl+V)' },
      { id: 'split', title: 'Split at playhead (S)', separator: true },
      { id: 'trim-start', title: 'Trim start to playhead (Q)' },
      { id: 'trim-end', title: 'Trim end to playhead (W)' },
      { id: 'duplicate', title: 'Duplicate clip (Ctrl+D)', separator: true },
      { id: 'delete', title: 'Delete clip (Del)' },
      { id: 'ripple', title: 'Ripple delete (Shift+Del)' },
      { id: 'snap', title: 'Magnetic snapping (N)', separator: true },
      { id: 'linked', title: 'Link audio/video (L)' },
      { id: 'tracks', title: 'Compact or large tracks' },
      { id: 'maximize', title: 'Maximize timeline' },
    ];
    const actions: Record<string, () => void> = {
      undo,
      redo,
      history: () => setHistoryPanel(historyPanel.classList.contains('hidden')),
      copy: copySelected,
      cut: cutSelected,
      paste: pasteClipboard,
      split: splitAtPlayhead,
      'trim-start': trimStartToPlayhead,
      'trim-end': trimEndToPlayhead,
      duplicate: duplicateSelected,
      delete: deleteSelection,
      ripple: rippleDeleteSelected,
      snap: toggleSnap,
      linked: toggleLinkedClips,
      tracks: toggleTrackSize,
      maximize: toggleMaximizeTimeline,
    };
    for (const entry of entries) {
      if (entry.separator) {
        const separator = document.createElement('span');
        separator.className = 'vtool-separator';
        separator.setAttribute('aria-hidden', 'true');
        timelineTools.append(separator);
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'vtool';
      button.dataset.tool = entry.id;
      button.title = entry.title;
      button.setAttribute('aria-label', entry.title);
      button.innerHTML = toolIcon(entry.id);
      button.addEventListener('click', () => actions[entry.id]?.());
      toolButtons.set(entry.id, button);
      timelineTools.append(button);
    }
    updateTimelineTools();
  }

  function updateTimelineTools(): void {
    if (!toolButtons.size) return;
    toolButtons.get('undo')!.disabled = historyIndex <= 0;
    toolButtons.get('redo')!.disabled = historyIndex < 0 || historyIndex >= history.length - 1;
    toolButtons.get('history')!.classList.toggle('active', !historyPanel.classList.contains('hidden'));
    const target = Boolean(selected);
    toolButtons.get('copy')!.disabled = !target;
    toolButtons.get('cut')!.disabled = !target;
    toolButtons.get('paste')!.disabled = !clipClipboard;
    for (const id of ['trim-start', 'trim-end', 'duplicate', 'delete', 'ripple']) {
      toolButtons.get(id)!.disabled = !target;
    }
    toolButtons.get('split')!.disabled = !canSplitAtPlayhead();
    const snap = toolButtons.get('snap')!;
    snap.classList.toggle('active', snapEnabled);
    snap.setAttribute('aria-pressed', String(snapEnabled));
    const linked = toolButtons.get('linked')!;
    linked.classList.toggle('active', linkClipsEnabled);
    linked.setAttribute('aria-pressed', String(linkClipsEnabled));
    linked.title = linkClipsEnabled ? 'Unlink audio/video (L)' : 'Link audio/video (L)';
    const tracks = toolButtons.get('tracks')!;
    tracks.classList.toggle('active', compactTracks);
    tracks.setAttribute('aria-pressed', String(compactTracks));
    const maximize = toolButtons.get('maximize')!;
    const maxed = editor.clientHeight > 0 && timelineHeight >= maxTimelineHeight() - 2;
    maximize.classList.toggle('active', maxed);
    maximize.setAttribute('aria-pressed', String(maxed));
  }

  function renderHistoryPanel(): void {
    if (!historyList) return;
    historyList.replaceChildren();
    if (!history.length) {
      const empty = document.createElement('p');
      empty.className = 'video-history-empty';
      empty.textContent = 'No edits yet.';
      historyList.append(empty);
      return;
    }
    for (let index = history.length - 1; index >= 0; index -= 1) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'video-history-item' + (index === historyIndex ? ' active' : '');
      const copy = document.createElement('span');
      copy.className = 'video-history-copy';
      const name = document.createElement('span');
      name.className = 'video-history-label';
      name.textContent = historyLabels[index] || 'Edit';
      copy.append(name);
      const detailText = historyDetails[index] || '';
      if (detailText) {
        const detail = document.createElement('span');
        detail.className = 'video-history-detail';
        detail.textContent = detailText;
        copy.append(detail);
      }
      const at = document.createElement('span');
      at.className = 'video-history-time';
      at.textContent = formatClock(history[index].time, true);
      row.append(copy, at);
      row.addEventListener('click', () => {
        setHistoryPanel(false);
        historyIndex = index;
        restore(history[index]);
        updateHistoryButtons();
        updateTimelineTools();
        status.textContent = `Restored: ${historyLabels[index] || 'Edit'}.`;
      });
      historyList.append(row);
    }
  }

  function setHistoryPanel(open: boolean): void {
    historyPanel.classList.toggle('hidden', !open);
    if (open) renderHistoryPanel();
    updateTimelineTools();
  }

  historyClose.addEventListener('click', () => setHistoryPanel(false));
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || historyPanel.classList.contains('hidden')) return;
    event.preventDefault();
    setHistoryPanel(false);
  });
  document.addEventListener('click', (event) => {
    if (historyPanel.classList.contains('hidden')) return;
    if (!(event.target instanceof Element) || !event.target.closest('#video-history-panel, [data-tool="history"]')) {
      setHistoryPanel(false);
    }
  });

  let paletteItems: { label: string; hint?: string; keywords?: string; run: () => void }[] = [];
  let paletteIndex = 0;
  let commandReturnFocus: HTMLElement | null = null;

  function paletteActions(): { label: string; hint?: string; keywords?: string; run: () => void }[] {
    const items: { label: string; hint?: string; keywords?: string; run: () => void }[] = [];
    const libraryPanel = (label: string, panelName: string, keywords: string): void => {
      items.push({ label, hint: 'Panel', keywords: `panel ${keywords}`, run: () => openLibraryPanel(panelName) });
    };
    const inspectorPanel = (label: string, tab: string, keywords: string): void => {
      items.push({
        label,
        hint: 'Inspector',
        keywords: `inspector panel ${keywords}`,
        run: () => {
          ensureInspectorOpen();
          selectSideTab(tab);
        },
      });
    };
    items.push({ label: 'Media pool', hint: 'Panel', keywords: 'panel media import', run: () => { openLibraryPanel('media'); mediaSearch.focus(); } });
    inspectorPanel('Edit clip', 'video', 'transform timing inspector');
    inspectorPanel('Clip effects', 'effects', 'effects filter lut');
    libraryPanel('Captions', 'captions', 'captions subtitles srt');
    libraryPanel('Text and titles', 'text', 'title text overlay lower third');
    libraryPanel('Graphics and shapes', 'graphics', 'graphics shape rectangle ellipse line overlay');
    libraryPanel('Transitions', 'transitions', 'fade dip black transition');
    const focusInspectorSection = (label: string, key: 'keys' | 'multicam' | 'transcript', keywords: string): void => {
      items.push({
        label,
        hint: 'Inspector',
        keywords,
        run: () => focusVideoInspectorSection(key),
      });
    };
    focusInspectorSection('Keyframe editor', 'keys', 'keyframe animation keys easing');
    focusInspectorSection('Multi-camera angles', 'multicam', 'multicam camera angle cut switch');
    libraryPanel('Local AI edits', 'ai', 'ai silence filler templates recipes');
    libraryPanel('Track mixer', 'audio', 'audio mixer video opacity volume fader');
    focusInspectorSection('Transcript editing', 'transcript', 'transcript words text');
    items.push({ label: 'Import media…', hint: 'File', keywords: 'add open video audio image', run: () => mediaInput.click() });
    items.push({ label: 'Project settings…', hint: 'Project', keywords: 'project settings resolution frame rate audio captions loudness', run: () => openProjectSettingsModal() });
    items.push({ label: 'Save project', hint: 'Ctrl+S', keywords: 'persist download', run: () => void saveCurrentProject() });
    items.push({ label: 'Export video…', hint: 'Export', keywords: 'render download mp4', run: () => openExportModal() });
    items.push({ label: 'Add a title at playhead', hint: 'Text', keywords: 'title text overlay', run: addTitleAtPlayhead });
    items.push({ label: 'Add a rectangle overlay', hint: 'Graphics', keywords: 'shape box rectangle graphic', run: () => addGraphic('rect') });
    items.push({ label: 'Add an ellipse overlay', hint: 'Graphics', keywords: 'shape circle ellipse graphic', run: () => addGraphic('ellipse') });
    items.push({ label: 'Add a line overlay', hint: 'Graphics', keywords: 'line rule graphic', run: () => addGraphic('line') });
    items.push({ label: 'Remove silences', hint: 'Local AI', keywords: 'silence pause cut', run: () => removeTranscriptSilences(0.7) });
    items.push({ label: 'Remove filler words', hint: 'Local AI', keywords: 'um uh filler', run: removeFillerWords });
    items.push({ label: 'Make it vertical 9:16', hint: 'Template', keywords: 'shorts reels tiktok vertical', run: () => applyTemplate('shorts') });
    items.push({ label: 'Normalize speech', hint: 'Audio', keywords: 'loudness podcast normalize', run: () => { normalize.value = 'podcast'; commit('Normalized speech'); } });
    items.push({ label: 'Undo', hint: 'Ctrl+Z', keywords: 'history back', run: undo });
    items.push({ label: 'Redo', hint: 'Ctrl+Shift+Z', keywords: 'history forward', run: redo });
    items.push({ label: 'Split at playhead', hint: 'S', keywords: 'cut razor', run: splitAtPlayhead });
    items.push({ label: 'Trim start to playhead', hint: 'Q', keywords: 'trim in', run: trimStartToPlayhead });
    items.push({ label: 'Trim end to playhead', hint: 'W', keywords: 'trim out', run: trimEndToPlayhead });
    items.push({ label: 'Duplicate clip', hint: 'Ctrl+D', keywords: 'copy clone', run: duplicateSelected });
    items.push({ label: 'Delete clip', hint: 'Del', keywords: 'remove', run: removeSelected });
    items.push({ label: 'Ripple delete', hint: 'Shift+Del', keywords: 'remove close gap', run: rippleDeleteSelected });
    items.push({ label: 'Copy clip', hint: 'Ctrl+C', keywords: 'clipboard', run: () => void copySelected() });
    items.push({ label: 'Cut clip', hint: 'Ctrl+X', keywords: 'clipboard', run: cutSelected });
    items.push({ label: 'Paste clip', hint: 'Ctrl+V', keywords: 'clipboard', run: pasteClipboard });
    items.push({ label: 'Add video track', hint: 'Track', keywords: 'track layer', run: addVideoTrack });
    items.push({ label: 'Add audio track', hint: 'Track', keywords: 'track layer', run: addAudioTrack });
    items.push({ label: 'Mark In', hint: 'I', keywords: 'range start', run: setRangeIn });
    items.push({ label: 'Mark Out', hint: 'O', keywords: 'range end', run: setRangeOut });
    items.push({ label: 'Clear In/Out', hint: 'Range', keywords: 'range reset', run: () => { rangeIn = null; rangeOut = null; updateRangeMarkers(); commit('Cleared export range'); } });
    items.push({ label: snapEnabled ? 'Turn magnetic snapping off' : 'Turn magnetic snapping on', hint: 'N', keywords: 'magnet snap', run: toggleSnap });
    items.push({ label: linkClipsEnabled ? 'Unlink audio and video' : 'Link audio and video', hint: 'L', keywords: 'magnet linked sync audio video', run: toggleLinkedClips });
    items.push({ label: compactTracks ? 'Use large tracks' : 'Use compact tracks', hint: 'Timeline', keywords: 'track height size', run: toggleTrackSize });
    items.push({ label: 'Maximize timeline', hint: 'Timeline', keywords: 'height expand', run: toggleMaximizeTimeline });
    items.push({ label: previewMaximized ? 'Restore preview' : 'Maximize preview', hint: 'Preview', keywords: 'fullscreen player', run: () => setPreviewMaximized(!previewMaximized) });
    items.push({ label: compositionGridOn ? 'Hide composition grid' : 'Show composition grid', hint: 'Preview', keywords: 'thirds guides', run: () => gridToggle.click() });
    items.push({ label: stageSnapEnabled ? 'Turn canvas snapping off' : 'Turn canvas snapping on', hint: 'Preview', keywords: 'snap align canvas stage', run: () => stageSnapToggle.click() });
    items.push({ label: safeGuides ? 'Hide safe margins' : 'Show safe margins', hint: 'Preview', keywords: 'title action safe', run: () => safeToggle.click() });
    for (const asset of assets) {
      items.push({
        label: `Insert ${asset.name}`,
        hint: `${asset.kind} · ${formatClock(asset.duration)}`,
        keywords: `media insert ${asset.kind} ${asset.name}`,
        run: () => insertAsset(asset, time),
      });
    }
    return items;
  }

  function renderCommandList(): void {
    paletteItems = paletteActions();
    const query = commandInput.value.trim().toLowerCase();
    if (query) {
      paletteItems = paletteItems.filter((item) =>
        item.label.toLowerCase().includes(query) ||
        (item.keywords ?? '').toLowerCase().includes(query));
    }
    paletteItems = paletteItems.slice(0, 80);
    if (paletteIndex >= paletteItems.length) paletteIndex = Math.max(0, paletteItems.length - 1);
    commandList.replaceChildren();
    if (!paletteItems.length) {
      const empty = document.createElement('p');
      empty.className = 'video-command-empty';
      empty.textContent = 'No matching commands.';
      commandList.append(empty);
      return;
    }
    paletteItems.forEach((item, index) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'video-command-item' + (index === paletteIndex ? ' active' : '');
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(index === paletteIndex));
      const label = document.createElement('span');
      label.textContent = item.label;
      const hint = document.createElement('kbd');
      hint.textContent = item.hint ?? '';
      row.append(label, hint);
      row.addEventListener('click', () => runPaletteItem(index));
      commandList.append(row);
    });
  }

  function runPaletteItem(index: number): void {
    const item = paletteItems[index];
    if (!item) return;
    closeCommandPalette();
    item.run();
  }

  function openCommandPalette(): void {
    commandReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    commandOverlay.classList.remove('hidden');
    commandOverlay.setAttribute('aria-hidden', 'false');
    searchButton.setAttribute('aria-expanded', 'true');
    commandInput.value = '';
    paletteIndex = 0;
    renderCommandList();
    commandInput.focus();
  }

  function closeCommandPalette(): void {
    commandOverlay.classList.add('hidden');
    commandOverlay.setAttribute('aria-hidden', 'true');
    searchButton.setAttribute('aria-expanded', 'false');
    commandInput.value = '';
    commandInput.blur();
    const returnTo = commandReturnFocus && commandReturnFocus !== document.body && commandReturnFocus.isConnected
      ? commandReturnFocus
      : searchButton;
    commandReturnFocus = null;
    returnTo.focus({ preventScroll: true });
  }

  commandInput.addEventListener('input', renderCommandList);
  commandInput.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!paletteItems.length) return;
      paletteIndex = (paletteIndex + (event.key === 'ArrowDown' ? 1 : -1) + paletteItems.length) % paletteItems.length;
      renderCommandList();
      commandList.querySelector('.video-command-item.active')?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Enter') {
      event.preventDefault();
      runPaletteItem(paletteIndex);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeCommandPalette();
    }
  });
  commandOverlay.addEventListener('pointerdown', (event) => {
    if (event.target === commandOverlay) closeCommandPalette();
  });
  window.addEventListener('keydown', (event) => {
    if (root.classList.contains('hidden')) return;
    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'k') return;
    event.preventDefault();
    event.stopPropagation();
    if (commandOverlay.classList.contains('hidden')) openCommandPalette();
    else closeCommandPalette();
  }, true);
  searchButton.addEventListener('click', openCommandPalette);
  commandClose.addEventListener('click', closeCommandPalette);
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || commandOverlay.classList.contains('hidden')) return;
    event.preventDefault();
    closeCommandPalette();
  });

  function focusVideoInspectorSection(section: 'keys' | 'multicam' | 'transcript'): void {
    const candidates = videos.filter((entry) => section === 'keys' || !entry.image);
    const selectedClip = selected?.kind === 'video'
      ? candidates.find((entry) => entry.id === selected!.id) ?? null
      : null;
    const activeClip = activeVideo && candidates.includes(activeVideo) ? activeVideo : null;
    const clip = selectedClip ?? activeClip ?? candidates[0] ?? null;
    if (!clip) {
      status.textContent = section === 'transcript'
        ? 'Add or select a video clip first to use transcript editing.'
        : 'Add or select a video clip first.';
      return;
    }
    selected = { kind: 'video', id: clip.id };
    if (section === 'keys') {
      paintClipSelection();
      showClipAnimation(true);
      return;
    }
    ensureInspectorOpen();
    selectSideTab(section);
  }

  function renderToolRail(): void {
    toolRail.replaceChildren();
    const entries: { id: string; title: string; divider?: boolean }[] = [
      { id: 'search', title: 'Search commands (Ctrl+K)' },
      { id: 'media', title: 'Media library' },
      { id: 'text', title: 'Text and titles' },
      { id: 'graphics', title: 'Graphics and shapes' },
      { id: 'effects', title: 'Effects library' },
      { id: 'transitions', title: 'Transitions' },
      { id: 'captions', title: 'Captions' },
      { id: 'audio', title: 'Track mixer' },
      { id: 'divider-library', title: '', divider: true },
      { id: 'edit', title: 'Edit selected clip' },
      { id: 'keys', title: 'Keyframe editor' },
      { id: 'multicam', title: 'Multi-camera angles' },
      { id: 'transcript', title: 'Transcript editing' },
      { id: 'divider-ai', title: '', divider: true },
      { id: 'ai', title: 'AI editor' },
    ];
    const focusClip = (view: 'transform' | 'effects' | 'transcript'): void => {
      let clip = selected?.kind === 'video' ? videos.find((entry) => entry.id === selected!.id) ?? null : null;
      if (!clip) clip = activeVideo;
      if (!clip) {
        status.textContent = 'Select a video clip first.';
        return;
      }
      selected = { kind: 'video', id: clip.id };
      ensureInspectorOpen();
      if (view === 'effects') selectSideTab('effects');
      else if (view === 'transcript') selectSideTab('transcript');
      else {
        openVideoSections.add(view);
        selectSideTab('video');
      }
    };
    const actions: Record<string, () => void> = {
      search: openCommandPalette,
      media: () => {
        openLibraryPanel('media');
        mediaSearch.focus();
        mediaSearch.select();
      },
      text: () => openLibraryPanel('text'),
      graphics: () => openLibraryPanel('graphics'),
      transitions: () => openLibraryPanel('transitions'),
      captions: () => openLibraryPanel('captions'),
      audio: () => openLibraryPanel('audio'),
      edit: () => focusClip('transform'),
      effects: () => openLibraryPanel('effects'),
      keys: () => focusVideoInspectorSection('keys'),
      multicam: () => focusVideoInspectorSection('multicam'),
      transcript: () => focusVideoInspectorSection('transcript'),
      ai: () => openLibraryPanel('ai'),
    };
    for (const entry of entries) {
      if (entry.divider) {
        const divider = document.createElement('span');
        divider.className = 'rail-divider';
        divider.setAttribute('aria-hidden', 'true');
        toolRail.append(divider);
        continue;
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'rail-tool';
      button.dataset.rail = entry.id;
      button.title = entry.title;
      button.setAttribute('aria-label', entry.title);
      button.innerHTML = toolIcon(entry.id);
      button.addEventListener('click', () => {
        actions[entry.id]?.();
        updateToolRail();
      });
      railButtons.set(entry.id, button);
      toolRail.append(button);
    }
    updateToolRail();
  }

  function updateToolRail(): void {
    if (!railButtons.size) return;
    const kind = inspectorSelectionKind();
    let inspectorActive = '';
    if (inspectorTab === 'effects' && kind === 'video') inspectorActive = 'effects';
    else if (animationPanel?.isOpen()) inspectorActive = 'keys';
    else if (inspectorTab === 'video' && kind === 'video' && openVideoSections.has('multicam')) inspectorActive = 'multicam';
    else if (inspectorTab === 'video' && kind === 'video' && openVideoSections.has('transcript')) inspectorActive = 'transcript';
    else if (inspectorTab === 'video' && kind !== null) inspectorActive = 'edit';
    const libraryActive = libraryCollapsed ? '' : activeLibrary;
    for (const [id, button] of railButtons) {
      const isActive = id === libraryActive || id === inspectorActive;
      button.classList.toggle('active', isActive);
      button.setAttribute('aria-pressed', String(isActive));
    }
  }

  renderToolRail();
  renderTimelineTools();

  function copySelected(): boolean {
    if (selectedGraphic >= 0 && !selected && selectedTitle < 0) {
      const graphic = graphics[selectedGraphic];
      if (!graphic) return false;
      clipClipboard = { kind: 'graphic', graphic: { ...graphic } };
      status.textContent = 'Copied the shape. Paste with Ctrl+V.';
      updateTimelineTools();
      return true;
    }
    if (selectedTitle >= 0 && !selected) {
      const cue = titles[selectedTitle];
      if (!cue) return false;
      clipClipboard = {
        kind: 'title',
        cue: { ...cue, style: cue.style ? { ...cue.style } : undefined },
      };
      status.textContent = 'Copied the title. Paste with Ctrl+V.';
      updateTimelineTools();
      return true;
    }
    if (selected?.kind === 'video') {
      const clip = videos.find((entry) => entry.id === selected!.id);
      if (!clip) return false;
      clipClipboard = {
        kind: 'video',
        clip: {
          id: clip.id, file: clip.file, name: clip.name, duration: clip.duration, start: clip.start,
          track: clip.track, trimStart: clip.trimStart, trimEnd: clip.trimEnd, image: clip.image,
          audioTrack: clip.audioTrack, volume: clip.volume, mute: clip.mute,
          transform: { ...clip.transform }, effects: structuredClone(clip.effects),
          animation: normalizeAnimation(clip.animation),
          transition: clip.transition ? { ...clip.transition } : undefined,
          proxy: clip.proxy, probe: clip.probe,
          peaks: clip.peaks, strip: clip.strip, embeddedCaptions: clip.embeddedCaptions,
        },
      };
    } else if (selected?.kind === 'audio') {
      const clip = audios.find((entry) => entry.id === selected!.id);
      if (!clip) return false;
      clipClipboard = {
        kind: 'audio',
        clip: {
          id: clip.id, file: clip.file, name: clip.name, duration: clip.duration, offset: clip.offset,
          trimStart: clip.trimStart, trimEnd: clip.trimEnd, volume: clip.volume, fadeIn: clip.fadeIn,
          fadeOut: clip.fadeOut, track: clip.track, sourceTrack: clip.sourceTrack, tracks: [...clip.tracks], muted: clip.muted, peaks: clip.peaks,
          retime: clip.retime,
        },
      };
    } else {
      status.textContent = 'Select a clip to copy.';
      return false;
    }
    status.textContent = 'Copied the clip. Paste with Ctrl+V.';
    updateTimelineTools();
    return true;
  }

  function cutSelected(): void {
    if (!copySelected()) return;
    if (clipClipboard?.kind === 'title') {
      deleteTitle(selectedTitle);
      status.textContent = 'Cut the title. Paste with Ctrl+V.';
      return;
    }
    if (clipClipboard?.kind === 'graphic') {
      deleteGraphic(selectedGraphic);
      status.textContent = 'Cut the shape. Paste with Ctrl+V.';
      return;
    }
    removeSelected();
    status.textContent = 'Cut the clip. Paste with Ctrl+V.';
  }

  function pasteClipboard(): void {
    if (!clipClipboard) {
      status.textContent = 'Copy a clip first.';
      return;
    }
    const at = Math.max(0, Math.min(time, timelineEnd()));
    if (clipClipboard.kind === 'title') {
      const state = clipClipboard.cue;
      const length = Math.max(0.2, state.end - state.start);
      const track = Math.max(0, Math.min(videoTrackCount - 1, titleTrackIndex(state)));
      if (videoTrackLocked(track)) {
        lockedNotice();
        return;
      }
      titles.push({
        ...state,
        start: at,
        end: at + length,
        style: state.style ? { ...state.style } : undefined,
        track,
      });
      selected = null;
      selectedTitle = titles.length - 1;
      selectedSubtitleKey = '';
      selectedGraphic = -1;
      invalidateShiftedCues();
      selectSideTab('text');
      render();
      seek(at);
      commit();
      status.textContent = 'Pasted the title at the playhead.';
      return;
    }
    if (clipClipboard.kind === 'graphic') {
      const state = clipClipboard.graphic;
      const length = Math.max(0.2, state.end - state.start);
      const track = Math.max(0, Math.min(videoTrackCount - 1, graphicTrackIndex(state)));
      if (videoTrackLocked(track)) {
        lockedNotice();
        return;
      }
      const graphic: GraphicClip = {
        ...state,
        id: ++nextId,
        start: at,
        end: at + length,
        track,
      };
      graphics.push(graphic);
      selected = null;
      selectedTitle = -1;
      selectedSubtitleKey = '';
      selectedGraphic = graphics.length - 1;
      selectSideTab('graphics');
      graphicsPreviewKey = '';
      renderGraphicsPreview();
      renderTimeline();
      seek(at);
      commit('Pasted a shape at the playhead');
      status.textContent = 'Pasted the shape at the playhead.';
      return;
    }
    selectedTitle = -1;
    selectedSubtitleKey = '';
    selectedGraphic = -1;
    if (clipClipboard.kind === 'video') {
      const state = clipClipboard.clip;
      const track = Math.max(0, Math.min(videoTrackCount - 1, state.track));
      if (videoTrackLocked(track)) {
        lockedNotice();
        return;
      }
      const url = URL.createObjectURL(state.file);
      const proxyUrl = state.proxy ? URL.createObjectURL(state.proxy.blob) : '';
      const clip: VideoClip = {
        ...state, id: ++nextId, start: at, track,
        transform: { ...state.transform }, effects: normalizeEffects(structuredClone(state.effects)),
        animation: normalizeAnimation(state.animation), url, proxyUrl, linkGroup: undefined, linkOffset: undefined,
        peaks: state.peaks ? new Float32Array(state.peaks) : null,
      };
      videos.push(clip);
      selected = { kind: 'video', id: clip.id };
      if (!clip.peaks) loadVideoPeaks(clip, new AbortController().signal);
    } else {
      const state = clipClipboard.clip;
      const url = URL.createObjectURL(state.file);
      const clip: AudioClip = {
        ...state, id: ++nextId, offset: at, url,
        tracks: [...state.tracks], peaks: state.peaks ? new Float32Array(state.peaks) : null,
        ...makeAudio(url), linkGroup: undefined,
      };
      audios.push(clip);
      audioRowsCache = null;
      selected = { kind: 'audio', id: clip.id };
    }
    selectSideTab('clip');
    render();
    seek(at);
    commit();
    status.textContent = 'Pasted the clip at the playhead.';
  }

  function duplicateVideo(clip: VideoClip): void {
    const position = videos.indexOf(clip);
    const copy: VideoClip = {
      ...clip, id: ++nextId, url: URL.createObjectURL(clip.file), start: clip.start + videoClipLength(clip),
      linkGroup: undefined, linkOffset: undefined,
    };
    videos.splice(position + 1, 0, copy);
    selected = { kind: 'video', id: copy.id };
    render();
    seek(time);
    commit();
  }

  function duplicateAudio(clip: AudioClip): void {
    const url = URL.createObjectURL(clip.file);
    const copy: AudioClip = {
      ...clip, id: ++nextId, url, offset: clip.offset + audioClipLength(clip), ...makeAudio(url),
      linkGroup: undefined,
    };
    audios.splice(audios.indexOf(clip) + 1, 0, copy);
    selected = { kind: 'audio', id: copy.id };
    render();
    seek(time);
    commit();
  }

  function loopAudio(clip: AudioClip): void {
    const length = audioClipLength(clip);
    if (length <= 0.05) return;
    let offset = clip.offset + length;
    let count = 0;
    while (offset < totalVideo() - 0.01 && count < 50) {
      const url = URL.createObjectURL(clip.file);
      audios.push({
        ...clip, id: ++nextId, url, offset, ...makeAudio(url),
      });
      offset += length;
      count += 1;
    }
    render();
    commit();
    status.textContent = count ? `Added ${count} repeat${count === 1 ? '' : 's'}.` : 'This clip already covers the video.';
  }

  function removeSelected(): void {
    const members = selectedClipMembers();
    if (!members.length) return;
    const videosToRemove = new Set<VideoClip>();
    const audiosToRemove = new Set<AudioClip>();
    for (const member of members) {
      if (member.kind === 'video') {
        const clip = member.clip;
        if (videoClipLocked(clip)) {
          lockedNotice();
          return;
        }
        videosToRemove.add(clip);
        const linked = linkedAudioFor(clip);
        if (linked) {
          if (audioClipLocked(linked)) {
            lockedNotice();
            return;
          }
          audiosToRemove.add(linked);
        }
      } else {
        const clip = member.clip;
        if (audioClipLocked(clip)) {
          lockedNotice();
          return;
        }
        audiosToRemove.add(clip);
        const linked = linkedVideoFor(clip);
        if (linked) {
          if (videoClipLocked(linked)) {
            lockedNotice();
            return;
          }
          videosToRemove.add(linked);
        }
      }
    }
    for (const clip of audiosToRemove) {
      disposeAudio(clip);
      URL.revokeObjectURL(clip.url);
    }
    if (audiosToRemove.size) {
      audios = audios.filter((clip) => !audiosToRemove.has(clip));
      audioRowsCache = null;
    }
    for (const clip of videosToRemove) {
      URL.revokeObjectURL(clip.url);
      if (activeVideo === clip) activeVideo = null;
    }
    if (videosToRemove.size) videos = videos.filter((clip) => !videosToRemove.has(clip));
    clearClipSelection();
    selectedTitle = -1;
    selectedGraphic = -1;
    selectedSubtitleKey = '';
    render();
    seek(Math.min(time, timelineEnd()));
    if (!videos.length) {
      preview.removeAttribute('src');
      preview.load();
      previewGain.gain.value = 0;
    }
    commit();
    announceClipSelection();
    if (members.length > 1) status.textContent = `Removed ${members.length} clips.`;
  }

  function appendInspectorSummary(kicker: string, name: string, detail: string): void {
    const summary = document.createElement('div');
    summary.className = 'video-inspector-summary';
    const label = document.createElement('span');
    label.className = 'eyebrow';
    label.textContent = kicker;
    const title = document.createElement('strong');
    title.textContent = name;
    const meta = document.createElement('small');
    meta.textContent = detail;
    summary.append(label, title, meta);
    inspector.append(summary);
  }

  function inspectorSection(key: string, label: string, defaultOpen = false): HTMLElement {
    if (defaultOpen) openVideoSections.add(key);
    const details = document.createElement('details');
    details.className = 'video-inspector-section';
    details.dataset.inspectorSection = key;
    details.open = openVideoSections.has(key);
    const summary = document.createElement('summary');
    summary.textContent = label;
    const body = document.createElement('div');
    body.className = 'video-inspector-section-body';
    details.append(summary, body);
    details.addEventListener('toggle', () => {
      if (details.open) openVideoSections.add(key);
      else openVideoSections.delete(key);
      updateToolRail();
    });
    inspector.append(details);
    return body;
  }

  /** Open an inspector section and bring it into view so rail and palette shortcuts have a visible effect. */
  function revealInspectorSection(key: string): void {
    const section = inspector.querySelector<HTMLDetailsElement>(`details[data-inspector-section="${key}"]`);
    if (!section) return;
    section.open = true;
    openVideoSections.add(key);
    section.scrollIntoView({ block: 'start' });
    section.querySelector<HTMLElement>('summary')?.focus({ preventScroll: true });
    section.classList.remove('is-revealed');
    void section.offsetWidth;
    section.classList.add('is-revealed');
    window.setTimeout(() => section.classList.remove('is-revealed'), 1300);
  }

  function inspectorGrid(): HTMLElement {
    const grid = document.createElement('div');
    grid.className = 'mt-2 grid grid-cols-2 gap-3';
    return grid;
  }

  function inspectorActions(): HTMLElement {
    const actions = document.createElement('div');
    actions.className = 'video-inspector-actions';
    return actions;
  }

  function renderTranscriptInspector(clip: VideoClip, container: HTMLElement): void {
    const source = options.getTranscriptCues() ?? [];
    if (!source.length) {
      const note = document.createElement('p');
      note.className = 'video-transcript-help';
      note.textContent = 'Transcript editing cuts the video by deleting words and closing the gap on every track. No transcript is loaded yet. Transcribe this clip to bring its words in.';
      container.append(note);
      if (options.sendToTranscribe && !clip.image) {
        container.append(button('Transcribe this clip', () => {
          status.textContent = 'Opening this clip in Audio to text…';
          void Promise.resolve(options.sendToTranscribe!(clip.file)).catch((error) => {
            status.textContent = errorMessage(error);
          });
        }, 'btn-secondary mt-2'));
      }
      return;
    }
    const rows = transcriptRows();
    const wordCount = rows.reduce((sum, row) => sum + row.words.filter((word) => !word.removed).length, 0);
    const help = document.createElement('p');
    help.className = 'video-transcript-help';
    help.textContent = 'Click a word to cut it from every track and close the gap. × removes the whole cue. Every cut can be undone.';
    const meta = document.createElement('p');
    meta.className = 'text-[10px] text-slate-500';
    meta.textContent = `${rows.length} cues · ${wordCount} words · ${transcriptEdits.length} removed span${transcriptEdits.length === 1 ? '' : 's'}`;
    container.append(help, meta);

    const tools = document.createElement('div');
    tools.className = 'video-transcript-tools';
    const threshold = document.createElement('input');
    threshold.type = 'number';
    threshold.min = '0.25';
    threshold.step = '0.1';
    threshold.value = String(silenceThreshold);
    threshold.className = 'select font-mono';
    threshold.title = 'Minimum silence to remove';
    threshold.addEventListener('change', () => {
      silenceThreshold = Math.max(0.25, Number(threshold.value) || 0.7);
      threshold.value = String(silenceThreshold);
    });
    const remove = button('Remove silences', () => removeTranscriptSilences(silenceThreshold), 'btn-secondary');
    tools.append(threshold, remove);
    if (transcriptEdits.length) {
      tools.append(button('Undo last cut', () => undo()));
    }
    container.append(tools);

    const list = document.createElement('div');
    list.className = 'video-transcript-list';
    for (const row of rows) {
      const line = document.createElement('div');
      line.className = 'video-transcript-row';
      const seekButton = document.createElement('button');
      seekButton.type = 'button';
      seekButton.className = 'video-transcript-time';
      seekButton.textContent = formatClock(row.start, true);
      seekButton.title = 'Seek here';
      seekButton.addEventListener('click', () => seek(clip.start + row.start));
      const words = document.createElement('div');
      words.className = 'video-transcript-words';
      for (const word of row.words) {
        if (word.removed) continue;
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'video-transcript-word' + (time >= word.start && time < word.end ? ' active' : '');
        chip.textContent = word.text;
        chip.title = `Delete “${word.text}” and close the gap (${formatClock(word.originalStart, true)})`;
        chip.addEventListener('click', () => deleteTranscriptSpan(word.originalStart, word.originalEnd));
        words.append(chip);
      }
      const removeCue = document.createElement('button');
      removeCue.type = 'button';
      removeCue.className = 'video-transcript-remove';
      removeCue.textContent = '×';
      removeCue.title = 'Remove this whole cue';
      removeCue.addEventListener('click', () => {
        const wordsInRow = row.words;
        if (!wordsInRow.length) return;
        deleteTranscriptSpan(wordsInRow[0].originalStart, wordsInRow[wordsInRow.length - 1].originalEnd);
      });
      line.append(seekButton, words, removeCue);
      list.append(line);
    }
    container.append(list);
    const hint = document.createElement('p');
    hint.className = 'text-[10px] leading-relaxed text-slate-500';
    hint.textContent = 'Click a word to delete it; the picture, sound, and captions close the gap. Every cut is one undo step.';
    container.append(hint);
  }

  function renderVideoTimingFields(clip: VideoClip, container: HTMLElement): void {
    const grid = inspectorGrid();
    grid.append(field('Starts at (s)', clip.start, { min: '0', step: '0.1' }, (value) => {
      clip.start = Math.max(0, value);
      syncLinkedAudioFromVideo(clip);
    }));
    if (clip.image) {
      grid.append(field('Show for (s)', clip.duration, { min: '0.5', step: '0.5' }, (value) => {
        clip.duration = Math.max(0.5, value);
      }));
    } else {
      grid.append(
        field('Trim start (s)', clip.trimStart, {
          min: String(Math.max(0, clipSourceTime(clip, -clip.start))),
          step: '0.1',
        }, (value) => {
          const trimStart = Math.max(0, Math.min(value, clip.duration - clip.trimEnd - 0.2));
          clip.start = Math.max(0, clip.start + clipPlaybackTime(clip, trimStart));
          clip.trimStart = trimStart;
          syncLinkedAudioFromVideo(clip);
        }),
        field('Trim end (s)', clip.trimEnd, { min: '0', step: '0.1' }, (value) => {
          clip.trimEnd = Math.max(0, Math.min(value, clip.duration - clip.trimStart - 0.2));
          syncLinkedAudioFromVideo(clip);
        }),
      );
      const speed = document.createElement('label');
      speed.className = 'sfield';
      const label = document.createElement('span');
      label.className = 'field-label';
      label.textContent = 'Clip speed (%)';
      const input = document.createElement('input');
      input.type = 'number';
      input.className = 'select font-mono';
      input.min = '25';
      input.max = '400';
      input.step = '1';
      input.value = String(Math.round(speedAtSource(clip.effects, clip.trimStart) * 100));
      input.disabled = speedEditLocked(clip);
      input.addEventListener('change', () => {
        if (input.validity.valid && input.value) changeClipSpeed(clip, input.valueAsNumber / 100);
        else input.value = String(Math.round(speedAtSource(clip.effects, clip.trimStart) * 100));
      });
      speed.append(label, input);
      grid.append(speed);
    }
    container.append(grid);
    if (!clip.image) container.append(button('Edit speed points', openSpeedPoints));
  }

  function renderVideoTransformFields(clip: VideoClip, container: HTMLElement): void {
    const state = clipStateAt(clip);
    const set = (key: AnimKey, value: number): void => {
      setAnimatedValue(clip, key, value);
      applyPreviewTransform(clip);
      renderTimeline();
    };
    const grid = inspectorGrid();
    grid.append(
      keyField('Zoom (%)', state.transform.scale * 100, { min: '5', max: '400', step: '1' }, (value) => {
        set('scale', Math.max(0.05, Math.min(4, value / 100)));
      }, clip, 'scale'),
      keyField('Rotation (°)', state.transform.rotation, { min: '-180', max: '180', step: '1' }, (value) => {
        set('rotation', Math.max(-180, Math.min(180, value)));
      }, clip, 'rotation'),
      keyField('Position X (%)', state.transform.x, { min: '-200', max: '200', step: '1' }, (value) => {
        set('x', Math.max(-200, Math.min(200, value)));
      }, clip, 'x'),
      keyField('Position Y (%)', state.transform.y, { min: '-200', max: '200', step: '1' }, (value) => {
        set('y', Math.max(-200, Math.min(200, value)));
      }, clip, 'y'),
      field('Stretch X (%)', clip.transform.scaleX * 100, { min: '5', max: '1000', step: '1' }, (value) => {
        clip.transform.scaleX = Math.max(0.05, Math.min(10, value / 100));
        applyPreviewTransform(clip);
        renderTimeline();
      }),
      field('Stretch Y (%)', clip.transform.scaleY * 100, { min: '5', max: '1000', step: '1' }, (value) => {
        clip.transform.scaleY = Math.max(0.05, Math.min(10, value / 100));
        applyPreviewTransform(clip);
        renderTimeline();
      }),
    );
    const note = document.createElement('p');
    note.className = 'col-span-2 text-[10px] leading-relaxed text-slate-500';
    note.textContent = 'Drag the picture to move, corners to resize, and the round handle to rotate. Hold Ctrl while dragging a corner to keep the opposite corner fixed; Ctrl-drag an edge to stretch with the opposite edge fixed. A diamond adds a keyframe; double-click to reset.';
    grid.append(note);
    container.append(grid);
    const actions = inspectorActions();
    actions.append(button('Open clip animation', () => showClipAnimation(true)));
    actions.append(button('Reset transform', () => {
      clip.transform = { ...DEFAULT_CLIP_TRANSFORM };
      clip.animation.scale = [];
      clip.animation.x = [];
      clip.animation.y = [];
      clip.animation.rotation = [];
      render();
      seek(time);
      commit();
    }, 'btn-ghost', !hasClipTransform(clip.transform) && !hasAnimation(clip.animation)));
    container.append(actions);
  }

  function renderVideoActions(clip: VideoClip, container: HTMLElement): void {
    const actions = inspectorActions();
    actions.append(
      button('Start at playhead', () => { clip.start = Math.max(0, time); render(); commit(); }),
      button('Track above', () => {
        clip.track = Math.max(0, clip.track - 1);
        render();
        seek(time);
        commit();
      }, 'btn-ghost', clip.track === 0),
      button('Track below', () => {
        clip.track = Math.min(videoTrackCount - 1, clip.track + 1);
        render();
        seek(time);
        commit();
      }, 'btn-ghost', clip.track >= videoTrackCount - 1),
      button('Duplicate', () => duplicateVideo(clip)),
      button('Split at playhead', splitAtPlayhead, 'btn-ghost', !canSplitAtPlayhead()),
    );
    if (!clip.image && options.sendToTranscribe) {
      actions.append(button('Transcribe this clip', () => {
        if (!captionTrackState.locked) {
          captionSource.value = 'transcript';
          updateCaptions();
        }
        status.textContent = 'Opening this clip in Audio to text…';
        void Promise.resolve(options.sendToTranscribe!(clip.file)).catch((error) => {
          status.textContent = errorMessage(error);
        });
      }));
    }
    if (!clip.image && probeHasAudio(clip) && options.sendToAudioStudio) {
      actions.append(button('Edit sound in Audio studio', () => {
        status.textContent = 'Opening this clip in the Audio studio…';
        void Promise.resolve(options.sendToAudioStudio!(clip.file)).catch((error) => {
          status.textContent = errorMessage(error);
        });
      }));
    }
    if (options.openTts) {
      actions.append(button('Narrate in Text to speech', () => {
        options.openTts!();
      }));
    }
    const sourceAsset = assets.find((asset) => asset.key === mediaKey(clip.file));
    if (sourceAsset && sourceAsset.kind === 'video') {
      actions.append(button(sourceAsset.proxy ? 'Remove preview proxy' : 'Create preview proxy', () => {
        if (sourceAsset.proxy) clearProxy(sourceAsset);
        else void buildProxy(sourceAsset);
      }));
    }
    actions.append(
      button('Edit effects', () => selectSideTab('effects')),
      button('Remove', removeSelected),
    );
    container.append(actions);
  }

  function probeHasAudio(clip: VideoClip): boolean {
    return clip.probe.hasAudio && !clip.image;
  }

  function videoMeta(clip: VideoClip): string {
    const { probe } = clip;
    return clip.image
      ? `${probe.width}×${probe.height} still`
      : [
        `${formatClock(videoClipLength(clip), true)} of ${formatClock(clip.duration)}`,
        probe.width ? `${probe.width}×${probe.height}` : '',
        probe.fps ? `${Math.round(probe.fps * 100) / 100} fps` : '',
        probe.videoCodec ?? '',
        probe.hasAudio ? 'has sound' : 'no sound',
      ].filter(Boolean).join(' · ');
  }

  function renderVideoTransitionFields(clip: VideoClip, container: HTMLElement): void {
    const transition = normalizeClipTransition(clip.transition);
    if (!transition) {
      const derived = videoTransitionDisplays(clip);
      const note = document.createElement('p');
      note.className = 'text-[10px] leading-relaxed text-slate-500';
      note.textContent = derived.length
        ? `Detected ${derived.map(transitionDisplayLabel).join(' and ')} from opacity keyframes. Add a transition to edit its alignment.`
        : 'No transition on this clip. Drag one from the Transitions library onto the clip.';
      container.append(note, button('Open Transitions', () => openLibraryPanel('transitions')));
      return;
    }
    const grid = inspectorGrid();
    const name = document.createElement('div');
    name.className = 'sfield col-span-2';
    const nameLabel = document.createElement('span');
    nameLabel.className = 'field-label';
    nameLabel.textContent = 'Transition';
    const nameValue = document.createElement('span');
    nameValue.className = 'video-ps-value';
    nameValue.textContent = TRANSITION_TYPES.find((entry) => entry.value === transition.type)?.label ?? 'Transition';
    name.append(nameLabel, nameValue);
    grid.append(
      name,
      field('Duration (s)', transition.duration, { min: '0.1', max: '2', step: '0.05' }, (value) => {
        writeVideoTransition(
          clip,
          transition.type,
          Math.max(0.1, Math.min(2, value)),
          transition.alignment ?? 'center',
        );
      }),
    );
    const alignment = document.createElement('div');
    alignment.className = 'sfield col-span-2';
    const alignmentLabel = document.createElement('span');
    alignmentLabel.className = 'field-label';
    alignmentLabel.textContent = 'Alignment';
    const group = document.createElement('div');
    group.className = 'segmented';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', 'Transition alignment');
    for (const value of ['start', 'center', 'end'] as const) {
      const option = button(value[0].toUpperCase() + value.slice(1), () => {
        clip.transition = { ...transition, alignment: value };
        render();
        commit('Aligned transition');
        status.textContent = `Transition aligned to the ${value}.`;
      }, 'segmented-btn');
      option.setAttribute('aria-pressed', String((transition.alignment ?? 'center') === value));
      group.append(option);
    }
    alignment.append(alignmentLabel, group);
    grid.append(alignment);
    const remove = button('Remove transition', () => {
      writeVideoTransition(clip, 'none', 0, transition.alignment ?? 'center');
      render();
      seek(time);
      commit('Removed transition');
      status.textContent = 'Cleared the video transition.';
    });
    container.append(grid, remove);
    const note = document.createElement('p');
    note.className = 'text-[10px] leading-relaxed text-slate-500';
    note.textContent = 'Alignment moves the timeline badge between the start, centre, and end of the clip edge.';
    container.append(note);
  }

  const dynamicZoomSections = new WeakMap<VideoClip, boolean>();

  function renderDynamicZoom(clip: VideoClip): void {
    let zoom = normalizeDynamicZoom(clip.effects.dynamicZoom);
    const container = inspectorSection('dynamic-zoom', 'Dynamic Zoom');
    const details = container.parentElement as HTMLDetailsElement;
    const summary = details.querySelector('summary')!;
    details.open = dynamicZoomSections.get(clip) ?? zoom.enabled;
    details.addEventListener('toggle', () => {
      if (details.isConnected) dynamicZoomSections.set(clip, details.open);
    });
    const change = (values: Partial<DynamicZoom>): void => {
      zoom = normalizeDynamicZoom({ ...zoom, ...values });
      clip.effects.dynamicZoom = zoom;
      applyPreviewTransform(activeVideo);
    };
    const set = (values: Partial<DynamicZoom>): void => {
      change(values);
      commit('Changed Dynamic Zoom');
      renderInspector();
    };
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.className = 'video-effect-switch';
    toggle.setAttribute('aria-label', 'Enable Dynamic Zoom');
    toggle.checked = zoom.enabled;
    toggle.addEventListener('change', () => {
      dynamicZoomSections.set(clip, toggle.checked);
      set({ enabled: toggle.checked });
      inspector.querySelector<HTMLInputElement>('.video-effect-switch')?.focus({ preventScroll: true });
    });
    summary.classList.add('video-effect-header');
    const title = document.createElement('span');
    title.textContent = 'Dynamic Zoom';
    summary.replaceChildren(toggle, title);
    const controls = document.createElement('fieldset');
    controls.disabled = !zoom.enabled;
    container.append(controls);
    const grid = inspectorGrid();
    grid.append(
      field('Start zoom (%)', zoom.from * 100, { min: '100', max: '400', step: '1' }, (value) => change({ from: value / 100 })),
      field('End zoom (%)', zoom.to * 100, { min: '100', max: '400', step: '1' }, (value) => change({ to: value / 100 })),
    );
    controls.append(grid);
    const label = document.createElement('label');
    label.className = 'sfield';
    const name = document.createElement('span');
    name.className = 'field-label';
    name.textContent = 'Easing';
    const easing = document.createElement('select');
    easing.className = 'select';
    easing.setAttribute('aria-label', 'Easing');
    easing.replaceChildren(...DYNAMIC_ZOOM_EASINGS.map(({ value, label: text }) => new Option(text, value)));
    easing.value = zoom.easing;
    easing.addEventListener('change', () => {
      set({ easing: DYNAMIC_ZOOM_EASINGS.find(({ value }) => value === easing.value)?.value ?? 'linear' });
    });
    label.append(name, easing);
    const actions = document.createElement('div');
    actions.className = 'video-zoom-options';
    actions.append(label, button('Swap', () => set({ from: zoom.to, to: zoom.from })));
    controls.append(actions);
  }

  function renderVideoInspector(clip: VideoClip): void {
    appendInspectorSummary(`${clip.image ? 'Image' : 'Video'} · V${clip.track + 1}`, clip.name, videoMeta(clip));
    const timing = inspectorSection('timing', 'Timing', true);
    renderVideoTimingFields(clip, timing);
    const transition = inspectorSection('transition', 'Transition', Boolean(clip.transition));
    renderVideoTransitionFields(clip, transition);
    const transform = inspectorSection('transform', 'Transform', true);
    renderVideoTransformFields(clip, transform);
    renderDynamicZoom(clip);
    const actions = inspectorSection('actions', 'Actions');
    renderVideoActions(clip, actions);
    if (!clip.image) {
      const transcript = inspectorSection('transcript', 'Transcript editing');
      renderTranscriptInspector(clip, transcript);
    }
    if (!clip.image) {
      const multicam = inspectorSection('multicam', 'Multi-camera');
      const multicamNote = document.createElement('p');
      multicamNote.className = 'text-[10px] leading-relaxed text-slate-500';
      multicamNote.textContent = 'Stack synchronized clips on different video tracks, then cut between their angles at the playhead.';
      const cutsLabel = document.createElement('p');
      cutsLabel.className = 'field-label';
      cutsLabel.textContent = 'Camera cuts';
      multicam.append(multicamNote, multicamAngles, cutsLabel, multicamCuts, multicamClear);
      renderMulticamPanel();
    }
  }

  function renderVideoSoundFields(clip: VideoClip, container: HTMLElement): void {
    const grid = inspectorGrid();
    grid.append(
      keyField('Clip volume (%)', animatedValue(clip, 'volume') * 100, { min: '0', max: '300', step: '5' }, (value) => {
        setAnimatedValue(clip, 'volume', Math.max(0, value) / 100);
        applyOriginalVolume();
        renderTimeline();
      }, clip, 'volume'),
      check('Mute this clip’s sound', clip.mute, (value) => {
        clip.mute = value;
        applyOriginalVolume();
        render();
        commit();
      }),
    );
    const linked = clip.mute ? linkedAudioFor(clip) : null;
    const source = linked && sameMediaSource(clip, linked) ? linked : null;
    const picker = trackPicker('Sound track', (clip.probe.audioStreams ?? []).map(describeTrack),
      source ? source.sourceTrack ?? 0 : clip.audioTrack, (value) => {
        if (source) {
          selectAudioSource(source, value);
          return;
        }
        clip.audioTrack = value;
        commit();
        syncMedia(true);
        status.textContent = `Using audio track ${value + 1} for the video's own sound.`;
      });
    if (picker) grid.append(picker);
    container.append(grid);
    const note = document.createElement('p');
    note.className = 'text-[10px] leading-relaxed text-slate-500';
    note.textContent = 'These controls edit the sound that travels with this video clip. Its timing stays locked to the picture.';
    container.append(note);
  }

  function renderVideoAudioInspector(clip: VideoClip): void {
    appendInspectorSummary(`Audio · V${clip.track + 1}`, clip.name, `${formatClock(videoClipLength(clip), true)} · ${clip.probe.audioCodec ?? 'audio'}`);
    if (!probeHasAudio(clip)) {
      const note = document.createElement('p');
      note.className = 'text-[11px] leading-relaxed text-slate-400';
      note.textContent = clip.image ? 'Images have no sound of their own.' : 'This video has no audio track.';
      inspector.append(note);
      return;
    }
    const sound = inspectorSection('video-sound', 'Sound', true);
    renderVideoSoundFields(clip, sound);
    const actions = inspectorSection('video-audio-actions', 'Actions');
    const row = inspectorActions();
    if (options.sendToAudioStudio) {
      row.append(button('Edit sound in Audio studio', () => {
        status.textContent = 'Opening this clip in the Audio studio…';
        void Promise.resolve(options.sendToAudioStudio!(clip.file)).catch((error) => {
          status.textContent = errorMessage(error);
        });
      }));
    }
    if (options.sendToTranscribe) {
      row.append(button('Transcribe this clip', () => {
        if (!captionTrackState.locked) {
          captionSource.value = 'transcript';
          updateCaptions();
        }
        status.textContent = 'Opening this clip in Audio to text…';
        void Promise.resolve(options.sendToTranscribe!(clip.file)).catch((error) => {
          status.textContent = errorMessage(error);
        });
      }));
    }
    actions.append(row);
  }

  function renderAudioTimingFields(clip: AudioClip, container: HTMLElement): void {
    const grid = inspectorGrid();
    grid.append(
      field('Starts at (s)', clip.offset, { min: '0', step: '0.1' }, (value) => {
        clip.offset = Math.max(0, value);
        syncLinkedVideoFromAudio(clip);
      }),
      field('Skip from start (s)', clip.trimStart, { min: '0', step: '0.1' }, (value) => {
        clip.trimStart = Math.max(0, Math.min(value, clip.duration - clip.trimEnd - 0.1));
        syncLinkedVideoFromAudio(clip);
      }),
      field('Cut from end (s)', clip.trimEnd, { min: '0', step: '0.1' }, (value) => {
        clip.trimEnd = Math.max(0, Math.min(value, clip.duration - clip.trimStart - 0.1));
        syncLinkedVideoFromAudio(clip);
      }),
    );
    container.append(grid);
  }

  function selectAudioSource(clip: AudioClip, index: number): void {
    if ((clip.sourceTrack ?? 0) === index) return;
    clip.sourceTrack = index;
    clip.peaks = null;
    clearAudioSource(clip.element);
    const linked = linkedVideoFor(clip);
    if (linked?.mute && sameMediaSource(linked, clip)) linked.audioTrack = index;
    stopAudioMix();
    commit();
    syncMedia(true);
    const controller = new AbortController();
    loadAudioPeaks(clip, controller.signal);
    renderTimeline();
    const file = clip.file;
    const name = clip.tracks[index] ?? `Audio track ${index + 1}`;
    status.textContent = `Preparing ${name} for preview…`;
    void previewAudioFile(clip).then(() => {
      if (audios.includes(clip) && clip.file === file && clip.sourceTrack === index && !operation) {
        status.textContent = `Using ${name} for preview and export.`;
      }
    }).catch((error) => {
      if (audios.includes(clip) && clip.file === file && clip.sourceTrack === index && !isAbortError(error) && !operation) {
        status.textContent = errorMessage(error);
      }
    });
  }

  function renderAudioSoundFields(clip: AudioClip, container: HTMLElement): void {
    const grid = inspectorGrid();
    grid.append(
      field('Volume (%)', clip.volume * 100, { min: '0', max: '300', step: '5' }, (value) => { clip.volume = Math.max(0, value) / 100; }),
      field('Fade in (s)', clip.fadeIn, { min: '0', step: '0.1' }, (value) => { clip.fadeIn = Math.max(0, value); }),
      field('Fade out (s)', clip.fadeOut, { min: '0', step: '0.1' }, (value) => { clip.fadeOut = Math.max(0, value); }),
      check('Mute this audio clip', clip.muted, (value) => {
        clip.muted = value;
        syncMedia(true);
        render();
        commit();
      }),
    );
    const picker = trackPicker('Audio track', clip.tracks, clip.sourceTrack ?? 0, (value) => selectAudioSource(clip, value));
    if (picker) grid.append(picker);
    container.append(grid);
  }

  function renderAudioActions(clip: AudioClip, container: HTMLElement): void {
    const actions = inspectorActions();
    actions.append(
      button('Start at playhead', () => { clip.offset = Math.max(0, time); render(); commit(); }),
      button('Fit to video', () => {
        clip.offset = 0;
        clip.trimEnd = Math.max(0, Math.min(clip.duration - clip.trimStart - 0.1, clip.duration - clip.trimStart - totalVideo()));
        render();
        commit();
      }),
      button('Duplicate', () => duplicateAudio(clip)),
      button('Loop to fill', () => loopAudio(clip)),
      button('Split at playhead', splitAtPlayhead, 'btn-ghost', !canSplitAtPlayhead()),
      button('Remove', removeSelected),
    );
    if (options.sendToAudioStudio) {
      actions.append(button('Open in Audio studio', () => {
        status.textContent = 'Opening this clip in the Audio studio…';
        void Promise.resolve(options.sendToAudioStudio!(clip.file)).catch((error) => {
          status.textContent = errorMessage(error);
        });
      }));
    }
    container.append(actions);
  }

  function renderAudioInspector(clip: AudioClip): void {
    const length = audioClipLength(clip);
    appendInspectorSummary(
      `Audio · A${clip.track + 1}`,
      clip.name,
      `Plays ${formatClock(clip.offset, true)} → ${formatClock(clip.offset + length, true)} · source ${formatClock(clip.duration)}`,
    );
    const timing = inspectorSection('audio-timing', 'Timing', true);
    renderAudioTimingFields(clip, timing);
    const sound = inspectorSection('audio-sound', 'Sound', true);
    renderAudioSoundFields(clip, sound);
    const actions = inspectorSection('audio-actions', 'Actions');
    renderAudioActions(clip, actions);
  }

  function renderVideoEffectsInspector(clip: VideoClip): void {
    appendInspectorSummary(`Effects · ${clip.image ? 'Image' : 'Video'}`, clip.name, videoMeta(clip));
    const effects = clip.effects;
    const live = (): void => {
      applyPreviewTransform(clip);
      renderTimeline();
      invalidateFingerprint();
    };
    const finish = (): void => {
      live();
      commit();
    };
    const sliders = document.createElement('div');
    sliders.className = 'video-effect-list';
    const keyedSlider = (
      label: string,
      key: AnimKey,
      min: number,
      max: number,
      step: number,
      format: (value: number) => string,
    ): HTMLElement => {
      const cell = document.createElement('div');
      cell.className = 'video-key-cell';
      cell.append(
        sliderField(label, animatedValue(clip, key), min, max, step, format, (value) => {
          setAnimatedValue(clip, key, value);
          live();
        }),
        keyframeButton(clip, key),
      );
      return cell;
    };
    sliders.append(
      keyedSlider('Brightness', 'brightness', -100, 100, 1, (v) => `${v}%`),
      keyedSlider('Contrast', 'contrast', -100, 100, 1, (v) => `${v}%`),
      keyedSlider('Saturation', 'saturation', -100, 100, 1, (v) => `${v}%`),
      keyedSlider('Hue', 'hue', -180, 180, 1, (v) => `${v}°`),
      keyedSlider('Blur', 'blur', 0, 40, 0.5, (v) => `${v} px`),
    );
    const opacityCell = document.createElement('div');
    opacityCell.className = 'video-key-cell';
    opacityCell.append(
      sliderField('Opacity', Math.round(animatedValue(clip, 'opacity') * 100), 0, 100, 1, (v) => `${v}%`, (v) => {
        setAnimatedValue(clip, 'opacity', v / 100);
        live();
      }),
      keyframeButton(clip, 'opacity'),
    );
    sliders.append(opacityCell);

    const blendWrap = document.createElement('label');
    blendWrap.className = 'sfield';
    const blendLabel = document.createElement('span');
    blendLabel.className = 'field-label';
    blendLabel.textContent = 'Blend with the layer below';
    const blend = document.createElement('select');
    blend.className = 'select';
    for (const mode of ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'soft-light']) {
      blend.add(new Option(mode.replace(/-/g, ' '), mode));
    }
    blend.value = effects.blend;
    blend.addEventListener('change', () => {
      effects.blend = blend.value as ClipEffects['blend'];
      finish();
    });
    blendWrap.append(blendLabel, blend);
    sliders.append(blendWrap);

    inspector.append(sliders);
    inspector.append(button('Open clip animation', () => showClipAnimation(true)));

    const maskBox = document.createElement('details');
    maskBox.className = 'video-effect-group';
    maskBox.open = effects.mask.shape !== 'none';
    const maskSummary = document.createElement('summary');
    maskSummary.textContent = 'Mask';
    const maskGrid = document.createElement('div');
    maskGrid.className = 'mt-2 grid grid-cols-2 gap-2';
    const maskShape = document.createElement('label');
    maskShape.className = 'sfield col-span-2';
    const shapeLabel = document.createElement('span');
    shapeLabel.className = 'field-label';
    shapeLabel.textContent = 'Shape';
    const shape = document.createElement('select');
    shape.className = 'select';
    for (const value of ['none', 'rect', 'ellipse']) shape.add(new Option(value === 'none' ? 'Full frame' : value, value));
    shape.value = effects.mask.shape;
    shape.addEventListener('change', () => {
      effects.mask.shape = shape.value as ClipEffects['mask']['shape'];
      finish();
      renderInspector();
    });
    maskShape.append(shapeLabel, shape);
    maskGrid.append(
      maskShape,
      field('X (%)', effects.mask.x, { min: '-100', max: '100', step: '1' }, (v) => { effects.mask.x = v; }),
      field('Y (%)', effects.mask.y, { min: '-100', max: '100', step: '1' }, (v) => { effects.mask.y = v; }),
      field('Width (%)', effects.mask.width, { min: '1', max: '200', step: '1' }, (v) => { effects.mask.width = v; }),
      field('Height (%)', effects.mask.height, { min: '1', max: '200', step: '1' }, (v) => { effects.mask.height = v; }),
      field('Feather (%)', effects.mask.feather, { min: '0', max: '50', step: '1' }, (v) => { effects.mask.feather = v; }),
    );
    maskBox.append(maskSummary, maskGrid);

    const chromaBox = document.createElement('details');
    chromaBox.className = 'video-effect-group';
    chromaBox.open = effects.chroma.enabled;
    const chromaSummary = document.createElement('summary');
    chromaSummary.textContent = 'Chroma key';
    const chromaGrid = document.createElement('div');
    chromaGrid.className = 'mt-2 space-y-2';
    const enabled = document.createElement('label');
    enabled.className = 'flex items-center gap-2 text-[11px] text-slate-200';
    const enabledInput = document.createElement('input');
    enabledInput.type = 'checkbox';
    enabledInput.className = 'checkbox';
    enabledInput.checked = effects.chroma.enabled;
    enabledInput.addEventListener('change', () => {
      effects.chroma.enabled = enabledInput.checked;
      finish();
    });
    const enabledText = document.createElement('span');
    enabledText.textContent = 'Remove this colour (export)';
    enabled.append(enabledInput, enabledText);
    const colour = document.createElement('input');
    colour.type = 'color';
    colour.value = effects.chroma.color;
    colour.className = 'video-color-input';
    colour.title = 'Key colour';
    colour.addEventListener('input', () => { effects.chroma.color = colour.value; invalidateFingerprint(); });
    colour.addEventListener('change', finish);
    chromaGrid.append(
      enabled,
      colour,
      sliderField('Tolerance', effects.chroma.tolerance, 0, 1, 0.01, (v) => v.toFixed(2), (v) => { effects.chroma.tolerance = v; }),
      sliderField('Softness', effects.chroma.softness, 0, 0.5, 0.01, (v) => v.toFixed(2), (v) => { effects.chroma.softness = v; }),
    );
    chromaBox.append(chromaSummary, chromaGrid);

    const toneBox = document.createElement('details');
    toneBox.className = 'video-effect-group';
    toneBox.open = effects.curve.shadows !== 0 || effects.curve.midtones !== 0 || effects.curve.highlights !== 0;
    const toneSummary = document.createElement('summary');
    toneSummary.textContent = 'Tone curve';
    const toneGrid = document.createElement('div');
    toneGrid.className = 'mt-2 space-y-1';
    toneGrid.append(
      sliderField('Shadows', effects.curve.shadows, -100, 100, 1, (v) => `${v}`, (v) => { effects.curve.shadows = v; }),
      sliderField('Midtones', effects.curve.midtones, -100, 100, 1, (v) => `${v}`, (v) => { effects.curve.midtones = v; }),
      sliderField('Highlights', effects.curve.highlights, -100, 100, 1, (v) => `${v}`, (v) => { effects.curve.highlights = v; }),
    );
    toneBox.append(toneSummary, toneGrid);

    const lutBox = document.createElement('div');
    lutBox.className = 'video-effect-group';
    const lutHead = document.createElement('div');
    lutHead.className = 'flex items-center justify-between gap-2';
    const lutLabel = document.createElement('span');
    lutLabel.className = 'field-label';
    lutLabel.textContent = effects.lut ? `LUT · ${effects.lut.name}` : 'LUT (3D .cube)';
    const lutInput = document.createElement('input');
    lutInput.type = 'file';
    lutInput.accept = '.cube,text/plain';
    lutInput.className = 'sr-only';
    const lutButton = document.createElement('button');
    lutButton.type = 'button';
    lutButton.className = 'btn-ghost';
    lutButton.textContent = effects.lut ? 'Replace' : 'Load';
    lutButton.addEventListener('click', () => lutInput.click());
    lutInput.addEventListener('change', async () => {
      const file = lutInput.files?.[0];
      if (!file) return;
      try {
        effects.lut = parseCubeLut(await file.text(), file.name.replace(/\.cube$/i, ''));
        finish();
        renderInspector();
        status.textContent = 'LUT loaded. It is applied when you export.';
      } catch (error) {
        status.textContent = errorMessage(error);
      }
    });
    lutHead.append(lutLabel, lutButton);
    lutBox.append(lutHead, lutInput);
    if (effects.lut) {
      const remove = button('Remove LUT', () => {
        effects.lut = null;
        finish();
        renderInspector();
      });
      lutBox.append(remove);
    }

    inspector.append(maskBox, chromaBox, toneBox, lutBox);
    const note = document.createElement('p');
    note.className = 'text-[10px] leading-relaxed text-slate-500';
    note.textContent = 'With GPU preview enabled, colour, blur, chroma key, tone curve, LUTs, masks, transitions, and blend modes render live. The standard preview keeps colour and blur on the CSS path and leaves pixel effects to export. This build composites one video layer over black, so blend and chroma are single-layer; multi-layer video compositing is not implemented.';
    inspector.append(note);
    const compositing = document.createElement('div');
    compositing.className = 'video-compositing';
    compositing.innerHTML =
      '<p class="field-label">Need node-grade compositing?</p>' +
      '<p class="video-compositing-copy">For 3D scenes, tracking, particles, rotoscoping, and node effects, use a dedicated local compositor. Your files still stay on this device.</p>' +
      '<div class="video-compositing-links">' +
      '<a href="https://wide.video" target="_blank" rel="noopener noreferrer">wide.video</a>' +
      '<a href="https://pikimov.com" target="_blank" rel="noopener noreferrer">Pikimov</a>' +
      '<a href="https://openreel.video" target="_blank" rel="noopener noreferrer">OpenReel</a>' +
      '</div>';
    inspector.append(compositing);
  }

  function fileTypeLabel(file: File): string {
    if (file.type.startsWith('video/')) return `Video · ${file.type.slice(6).toUpperCase()}`;
    if (file.type.startsWith('audio/')) return `Audio · ${file.type.slice(6).toUpperCase()}`;
    if (file.type.startsWith('image/')) return `Image · ${file.type.slice(6).toUpperCase()}`;
    const extension = file.name.split('.').pop()?.toUpperCase();
    return extension ? `${extension} file` : 'File';
  }

  function metadataGroup(title: string, rows: [string, string | null | undefined][]): HTMLElement {
    const group = document.createElement('section');
    group.className = 'video-file-group';
    const heading = document.createElement('p');
    heading.className = 'field-label';
    heading.textContent = title;
    const grid = document.createElement('div');
    grid.className = 'video-file-grid';
    for (const [label, value] of rows) {
      if (value === null || value === undefined || value === '') continue;
      const cell = document.createElement('div');
      cell.className = 'video-file-cell';
      const key = document.createElement('span');
      key.textContent = label;
      const content = document.createElement('strong');
      content.textContent = value;
      cell.append(key, content);
      grid.append(cell);
    }
    group.append(heading, grid);
    return group;
  }

  const embeddedSubtitleLists = new WeakMap<File, SubtitleStreamInfo[]>();
  const matroskaScans = new WeakMap<File, 'reading' | 'unavailable'>();
  const subtitleMessages = new WeakMap<File, { text: string; tone: 'success' | 'error' | 'neutral' }>();
  const subtitleDrafts = new WeakMap<VideoClip, { index: string; preserveStyle: boolean }>();
  let subtitleTask: { file: File; controller: AbortController; label: string } | null = null;

  function scanMatroskaSubtitles(file: File): void {
    if (!/\.(mkv|webm)$/i.test(file.name) || matroskaScans.has(file) || embeddedSubtitleLists.has(file)) return;
    matroskaScans.set(file, 'reading');
    void readMatroskaSubtitleTracks(file).catch(() => null).then((tracks) => {
      if (tracks) {
        embeddedSubtitleLists.set(file, tracks);
        matroskaScans.delete(file);
      } else {
        matroskaScans.set(file, 'unavailable');
      }
      if (selectedVideoClip()?.file === file && inspectorTab === 'file') renderInspector();
    });
  }

  async function runSubtitleTask(
    file: File, label: string, action: (engine: AudioFfmpeg, signal: AbortSignal) => Promise<string>,
  ): Promise<void> {
    if (subtitleTask) return;
    const controller = new AbortController();
    const engine = new AudioFfmpeg({ singleThread: true });
    subtitleTask = { file, controller, label };
    subtitleMessages.delete(file);
    if (!operation) status.textContent = label;
    renderInspector();
    try {
      const message = await action(engine, controller.signal);
      if (message) {
        subtitleMessages.set(file, { text: message, tone: 'success' });
        if (!operation) status.textContent = message;
      }
    } catch (error) {
      const message = controller.signal.aborted ? 'Subtitle operation cancelled.' : errorMessage(error);
      subtitleMessages.set(file, { text: message, tone: controller.signal.aborted ? 'neutral' : 'error' });
      if (!operation) status.textContent = message;
    } finally {
      engine.dispose();
      subtitleTask = null;
      if (inspectorTab === 'file') renderInspector();
    }
  }

  function renderEmbeddedSubtitleControls(clip: VideoClip): void {
    const panel = inspectorSection('embedded-subtitles', 'Embedded subtitles', true);
    panel.classList.add('video-subtitle-import');
    const file = clip.file;
    scanMatroskaSubtitles(file);
    const task = subtitleTask;
    const pending = task?.file === file;
    const message = pending ? { text: task.label, tone: 'pending' } : subtitleMessages.get(file);
    const scanning = matroskaScans.get(file) === 'reading';
    const addStatus = (): void => {
      const state = message ?? (scanning ? { text: 'Reading subtitle tracks…', tone: 'pending' } : null);
      if (!state) return;
      const note = document.createElement('div');
      note.className = 'video-subtitle-status';
      note.dataset.tone = state.tone;
      note.setAttribute('role', 'status');
      const marker = document.createElement('span');
      marker.className = 'video-subtitle-status-mark';
      marker.setAttribute('aria-hidden', 'true');
      marker.textContent = state.tone === 'success' ? '✓' : state.tone === 'error' ? '!' : '';
      const text = document.createElement('span');
      text.textContent = state.text;
      note.append(marker, text);
      panel.append(note);
    };
    const streams = embeddedSubtitleLists.get(file) ?? clip.probe.subtitleStreams;
    if (!streams?.length) {
      if (!streams && !scanning && !pending) {
        panel.append(button('Find embedded subtitles', () => {
          void runSubtitleTask(file, 'Finding embedded subtitles…', async (engine, signal) => {
            const probe = await engine.probe(file, signal);
            if (!probe.hasVideo && !probe.hasAudio && !probe.subtitleStreams?.length) {
              throw new Error('Could not read the file’s stream list. Try finding subtitles again.');
            }
            embeddedSubtitleLists.set(file, probe.subtitleStreams ?? []);
            return '';
          });
        }, 'btn-secondary', Boolean(task)));
      } else if (streams && !scanning) {
        const empty = document.createElement('p');
        empty.className = 'video-subtitle-note';
        empty.textContent = 'This file has no embedded subtitles.';
        panel.append(empty);
      }
      addStatus();
      if (pending) panel.append(button('Cancel', () => task.controller.abort()));
      return;
    }

    const label = document.createElement('label');
    label.className = 'sfield';
    const labelText = document.createElement('span');
    labelText.className = 'field-label';
    labelText.textContent = 'Source track';
    const picker = document.createElement('select');
    picker.className = 'select';
    picker.setAttribute('aria-label', 'Embedded subtitle track');
    picker.disabled = Boolean(task) || captionTrackState.locked;
    const preferred = streams.find((stream) => stream.index === clip.embeddedCaptions?.stream.index) ??
      streams.find((stream) => stream.default && isTextSubtitle(stream)) ?? streams.find(isTextSubtitle);
    for (const stream of streams) {
      const duplicate = streams.some((other) => other !== stream && other.title === stream.title);
      const name = stream.title && !duplicate ? stream.title : `Track ${stream.index + 1}${stream.title ? ` · ${stream.title}` : ''}`;
      const language = stream.language?.toUpperCase() || 'UND';
      const option = new Option(`${language} · ${name}`, String(stream.index));
      option.disabled = !isTextSubtitle(stream);
      if (option.disabled) option.textContent += ' (unsupported)';
      picker.add(option);
    }
    const draft = subtitleDrafts.get(clip);
    picker.value = draft?.index ?? (preferred ? String(preferred.index) : '');
    label.append(labelText, picker);
    const metadata = document.createElement('div');
    metadata.className = 'video-subtitle-track-meta';
    const styleToggle = document.createElement('input');
    styleToggle.type = 'checkbox';
    styleToggle.className = 'checkbox';
    styleToggle.disabled = Boolean(task) || captionTrackState.locked;
    styleToggle.checked = draft?.preserveStyle ?? Boolean(clip.embeddedCaptions?.assScript);
    const styleLabel = document.createElement('label');
    styleLabel.className = 'video-subtitle-preserve';
    const styleText = document.createElement('span');
    styleText.textContent = 'Keep original ASS styling';
    const styleNote = document.createElement('small');
    styleNote.textContent = 'Fonts and effects in preview and burned-in exports.';
    styleText.append(styleNote);
    styleLabel.append(styleToggle, styleText);
    const refreshTrack = (): void => {
      const stream = streams.find((entry) => String(entry.index) === picker.value);
      styleLabel.hidden = !stream || !supportsOriginalSubtitleStyle(stream);
      metadata.replaceChildren();
      if (stream) {
        for (const value of [
          stream.codec.toUpperCase(),
          stream.default ? 'Default' : null, stream.forced ? 'Forced' : null,
        ]) {
          if (!value) continue;
          const chip = document.createElement('span');
          chip.textContent = value;
          metadata.append(chip);
        }
      }
    };
    const saveDraft = (): void => {
      subtitleDrafts.set(clip, { index: picker.value, preserveStyle: styleToggle.checked });
    };
    picker.addEventListener('change', () => { saveDraft(); refreshTrack(); });
    styleToggle.addEventListener('change', saveDraft);
    refreshTrack();
    panel.append(label, metadata, styleLabel);

    const actions = document.createElement('div');
    actions.className = 'video-subtitle-import-actions';
    if (pending) {
      actions.append(button('Cancel', () => task.controller.abort()));
    } else {
      actions.append(button('Import subtitle track', () => {
        const stream = streams.find((entry) => String(entry.index) === picker.value);
        if (!stream || !isTextSubtitle(stream)) return;
        const name = stream.title || `track ${stream.index + 1}`;
        const preserveStyle = styleToggle.checked && supportsOriginalSubtitleStyle(stream);
        void runSubtitleTask(file, `Importing ${name}…`, async (engine, signal) => {
          const captions = await readEmbeddedCaptions(engine, file, stream, signal, preserveStyle);
          signal.throwIfAborted();
          if (captionTrackState.locked || !videos.includes(clip) || clip.file !== file) return '';
          clip.embeddedCaptions = captions;
          captionSource.value = 'embedded';
          if (preserveStyle) {
            captionMode.value = 'burn';
            captionPreset = 'default';
          }
          updateCaptions();
          commit('Imported embedded subtitles');
          const count = captions.cues.length;
          return `Imported ${count} ${count === 1 ? 'cue' : 'cues'} from ${name}.`;
        });
      }, 'btn-primary', !preferred || Boolean(task) || captionTrackState.locked));
      if (clip.embeddedCaptions) {
        actions.append(button('Remove', () => {
          delete clip.embeddedCaptions;
          subtitleMessages.delete(file);
          updateCaptions();
          commit('Removed embedded subtitles');
        }, 'btn-ghost', Boolean(task) || captionTrackState.locked));
        actions.lastElementChild?.setAttribute('aria-label', 'Remove embedded subtitles');
      }
    }
    panel.append(actions);
    addStatus();
    if (clip.embeddedCaptions && !message) {
      const summary = document.createElement('p');
      summary.className = 'video-subtitle-note';
      const count = clip.embeddedCaptions.cues.length;
      summary.textContent = `${clip.embeddedCaptions.stream.title || 'Imported track'} · ${count} ${count === 1 ? 'cue' : 'cues'}`;
      panel.append(summary);
    }
  }

  function renderFileInspector(clip: VideoClip | AudioClip, kind: 'video' | 'audio'): void {
    const file = clip.file;
    const asset = assets.find((entry) => entry.key === mediaKey(file));
    const probe: MediaProbe | null = kind === 'video' ? (clip as VideoClip).probe : asset?.probe ?? null;
    const duration = kind === 'video' ? (clip as VideoClip).duration : (clip as AudioClip).duration;
    appendInspectorSummary('File', file.name, `${formatClock(duration, true)} · ${formatBytes(file.size)}`);
    inspector.append(metadataGroup('File', [
      ['Type', fileTypeLabel(file)],
      ['Size', formatBytes(file.size)],
      ['Last modified', new Date(file.lastModified).toLocaleString()],
      ['Media pool', asset?.name && asset.name !== file.name ? asset.name : null],
    ]));
    if (kind === 'video' && (probe?.hasVideo || (clip as VideoClip).image)) {
      const videoClip = clip as VideoClip;
      inspector.append(metadataGroup('Video', [
        ['Codec', videoClip.image ? 'Still image' : probe?.videoCodec ?? null],
        ['Resolution', probe?.width && probe?.height ? `${probe.width} × ${probe.height}` : null],
        ['Frame rate', probe?.fps ? `${Math.round(probe.fps * 100) / 100} fps` : null],
        ['Rotation', probe?.rotation ? `${probe.rotation}°` : null],
        ['Duration', formatClock(duration, true)],
      ]));
    }
    if (probe?.hasAudio || kind === 'audio') {
      const audioClip = kind === 'audio' ? clip as AudioClip : null;
      const channels = probe?.audioStreams?.[0]?.channels ?? null;
      const format = channels === '1' ? 'Mono' : channels === '2' ? 'Stereo' : channels;
      const sampleRate = probe?.audioStreams?.[0]?.sampleRate;
      inspector.append(metadataGroup('Audio', [
        ['Codec', probe?.audioCodec ?? audioClip?.tracks[0] ?? null],
        ['Format', format],
        ['Sample rate', sampleRate ? `${sampleRate} Hz` : null],
        ['Audio tracks', String(probe?.audioStreams?.length ?? audioClip?.tracks.length ?? 1)],
        ['Track', audioClip ? `A${audioClip.track + 1}` : null],
      ]));
    }
    if (kind === 'video' && !(clip as VideoClip).image) {
      const video = clip as VideoClip;
      renderEmbeddedSubtitleControls(video);
      if (attemptedCompatibilityPreview.has(video.file) && !video.proxy?.compatibility) {
        inspector.append(button('Retry playable preview', () => prepareCompatibilityPreview(video, true)));
      }
    }
    if (probe) {
      const details = document.createElement('details');
      details.className = 'video-inspector-section';
      const summary = document.createElement('summary');
      summary.textContent = 'Metadata';
      const body = document.createElement('div');
      body.className = 'video-inspector-section-body';
      const pre = document.createElement('pre');
      pre.className = 'video-file-json';
      pre.textContent = JSON.stringify(probe, null, 2);
      body.append(pre);
      details.append(summary, body);
      inspector.append(details);
    }
  }

  function renderNoSelectionInspector(): void {
    appendInspectorSummary('Inspector', 'Nothing selected', 'Select a clip, title, or shape on the timeline to see its properties.');
    const note = document.createElement('p');
    note.className = 'text-[11px] leading-relaxed text-slate-400';
    note.textContent = 'The tabs enable themselves from the selection. Video clips expose Video, Audio when they have sound, Effects, and File; text and shapes expose Video; audio clips expose Audio and File.';
    inspector.append(note);
    const compositing = document.createElement('div');
    compositing.className = 'video-compositing';
    compositing.innerHTML =
      '<p class="field-label">Professional compositing</p>' +
      '<p class="video-compositing-copy">When a cut needs 3D, tracking, particles, rotoscoping, or node graphs, hand it to one of these local-first studios. Your media is not uploaded.</p>' +
      '<div class="video-compositing-links">' +
      '<a href="https://wide.video" target="_blank" rel="noopener noreferrer">wide.video</a>' +
      '<a href="https://pikimov.com" target="_blank" rel="noopener noreferrer">Pikimov</a>' +
      '<a href="https://openreel.video" target="_blank" rel="noopener noreferrer">OpenReel</a>' +
      '</div>';
    inspector.append(compositing);
  }

  function renderClipInspector(): void {
    inspector.replaceChildren();
    updateToolRail();
    syncInspectorTabs();
    const video = selectedVideoClip();
    const audio = selectedAudioClip();
    if (video && audio) {
      if (inspectorTab === 'audio') renderAudioInspector(audio);
      else if (inspectorTab === 'effects') renderVideoEffectsInspector(video);
      else if (inspectorTab === 'file') {
        if (selected?.kind === 'audio') renderFileInspector(audio, 'audio');
        else renderFileInspector(video, 'video');
      } else renderVideoInspector(video);
      return;
    }
    if (video) {
      if (inspectorTab === 'audio' && videoHasOwnSound(video)) renderVideoAudioInspector(video);
      else if (inspectorTab === 'effects') renderVideoEffectsInspector(video);
      else if (inspectorTab === 'file') renderFileInspector(video, 'video');
      else renderVideoInspector(video);
      return;
    }
    if (audio) {
      if (inspectorTab === 'file') renderFileInspector(audio, 'audio');
      else renderAudioInspector(audio);
      return;
    }
    if (inspectorSelectionKind() !== null) return;
    renderNoSelectionInspector();
  }
  // Preview playback ---------------------------------------------------------
  function activeCameraTrack(at: number): number | null {
    let track: number | null = null;
    let bestAt = -Infinity;
    for (const cut of cameraCuts) {
      if (cut.at <= at + 0.001 && cut.at >= bestAt) {
        bestAt = cut.at;
        track = cut.track;
      }
    }
    return track;
  }

  function visibleVideoAt(list: readonly VideoClip[], at: number, preferredTrack: number | null): VideoClip | null {
    let top: VideoClip | null = null;
    let camera: VideoClip | null = null;
    for (const clip of list) {
      if (at < clip.start || videoTrackHidden(clip.track) || at >= clip.start + videoClipLength(clip)) continue;
      if (!top || compareVideoPriority(clip.track, clip.start, top.track, top.start) < 0) top = clip;
      if (clip.track === preferredTrack && (!camera || clip.start > camera.start)) {
        camera = clip;
      }
    }
    return camera ?? top;
  }

  function videoAt(at: number): { clip: VideoClip; local: number } | null {
    const found = visibleVideoAt(videos, at, activeCameraTrack(at));
    return found
      ? { clip: found, local: clipSourceTime(found, at - found.start) }
      : null;
  }

  /** Seconds since the visible clip started, clamped to its length. */
  function clipLocalTime(clip: VideoClip, at = time): number {
    return Math.max(0, Math.min(videoClipLength(clip), at - clip.start));
  }

  function clipStateAt(clip: VideoClip, at = time): ReturnType<typeof animationAt> {
    const effects = normalizeEffects(clip.effects);
    return animationAt(clip.animation, clipLocalTime(clip, at), {
      transform: clipTransform(clip.transform),
      opacity: effects.opacity,
      volume: clip.volume,
    });
  }

  function applyOriginalVolume(): void {
    const clip = activeVideo;
    const trackMuted = clip ? videoTrackMuted(clip.track) : false;
    const volume = clip ? clipStateAt(clip).volume : 0;
    const gain = keepOriginal.checked && clip && !clip.image && !clip.mute && !trackMuted
      ? (Number(originalVolume.value) / 100) * volume * videoTrackGain(clip.track) *
        (previewMuted ? 0 : 1) * (previewVolume / 100)
      : 0;
    const separate = clip && usesSeparateOriginalSound(clip);
    originalSound.gain.gain.value = separate ? Math.max(0, gain) : 0;
    previewGain.gain.value = separate ? 0 : Math.max(0, gain);
    preview.volume = 1;
  }

  /** Match the clip inspector's zoom, position, rotation, colour, and mask in the stage. */
  function applyPreviewTransform(clip: VideoClip | null, scheduleGpu = true): void {
    if (!clip) {
      if (previewTransformValue !== '') {
        previewTransformValue = '';
        for (const element of [preview, still]) {
          element.style.transform = '';
          element.style.opacity = '1';
          element.style.filter = 'none';
          element.style.mixBlendMode = 'normal';
          element.style.clipPath = '';
          element.style.maskImage = '';
          element.style.maskSize = '';
          element.style.maskRepeat = '';
          element.style.maskPosition = '';
          element.style.maskMode = '';
          const webkit = element.style as CSSStyleDeclaration & { webkitMaskImage?: string };
          webkit.webkitMaskImage = '';
        }
      }
      if (scheduleGpu) scheduleGpuPreviewRefresh();
      return;
    }
    const effects = effectAnimationAt(clip.animation, clipLocalTime(clip), clip.effects);
    const state = clipStateAt(clip);
    const motion = motionTransitionAt(clip.transition, clipLocalTime(clip));
    const transform = {
      ...state.transform,
      scale: state.transform.scale * dynamicZoomAt(effects.dynamicZoom, clipLocalTime(clip), videoClipLength(clip)),
      x: state.transform.x + motion.offsetX,
      y: state.transform.y + motion.offsetY,
    };
    const filter = cssFilter(effects);
    const reveal = motion.reveal
      ? `inset(${motion.reveal.top}% ${motion.reveal.right}% ${motion.reveal.bottom}% ${motion.reveal.left}%)`
      : '';
    const maskStyles = maskCssStyles(effects, stage.clientWidth || 1, stage.clientHeight || 1);
    const clipPath = reveal || maskStyles.clipPath;
    const maskImage = maskStyles.maskImage;
    const opacity = String(Math.max(0, Math.min(1, state.opacity * videoTrackOpacity(clip.track))));
    const value = `${transform.x}|${transform.y}|${transform.rotation}|${transform.scale}|${transform.scaleX}|${transform.scaleY}|${opacity}|${filter}|${effects.blend}|${clipPath}|${maskImage}`;
    if (value === previewTransformValue) {
      if (scheduleGpu) scheduleGpuPreviewRefresh();
      return;
    }
    previewTransformValue = value;
    const css = `translate(${transform.x}%, ${transform.y}%) rotate(${transform.rotation}deg) scale(${transform.scale * transform.scaleX}, ${transform.scale * transform.scaleY})`;
    for (const element of [preview, still]) {
      element.style.transform = css;
      element.style.opacity = opacity;
      element.style.filter = filter;
      element.style.mixBlendMode = effects.blend === 'normal' ? 'normal' : effects.blend;
      element.style.clipPath = clipPath;
      element.style.maskImage = maskImage;
      element.style.maskSize = maskImage ? '100% 100%' : '';
      element.style.maskRepeat = maskImage ? 'no-repeat' : '';
      element.style.maskPosition = maskImage ? '0 0' : '';
      element.style.maskMode = maskImage ? 'alpha' : '';
      const webkit = element.style as CSSStyleDeclaration & { webkitMaskImage?: string };
      webkit.webkitMaskImage = maskImage;
    }
    const speed = speedAtSource(effects, clipSourceTime(clip, clipLocalTime(clip)));
    if (Math.abs(preview.playbackRate - speed) > 0.001) preview.playbackRate = speed;
    if (scheduleGpu) scheduleGpuPreviewRefresh();
  }

  function renderGpuPreview(clip: VideoClip | null, capture = false): void {
    const compositor = ensureGpuPreview();
    if (!compositor) {
      if (gpuPreview) gpuPreview.clear();
      showCssPreview();
      return;
    }
    if (!clip) {
      compositor.clear();
      showCssPreview();
      return;
    }
    const source = clip.image ? still : preview;
    const sourceWidth = clip.image ? still.naturalWidth : preview.videoWidth;
    const sourceHeight = clip.image ? still.naturalHeight : preview.videoHeight;
    if (sourceWidth < 2 || sourceHeight < 2) {
      compositor.clear();
      showCssPreview();
      return;
    }
    const size = outputDimensions();
    const previewWidth = stageViewportWidth || size.width || 16;
    const previewHeight = stageViewportHeight || size.height || 9;
    const previewDpr = Math.min(2, window.devicePixelRatio || 1);
    if (!gpuPreviewWithinBudget(previewWidth, previewHeight, previewDpr)) {
      compositor.clear();
      showCssPreview();
      showCompositorStatus('GPU preview is limited to 1080p output; using the standard preview at this size.');
      return;
    }
    const plan = buildPreviewFramePlan({
      clipId: String(clip.id),
      source: {
        key: previewSourceUrl(clip) || String(clip.id),
        kind: clip.image ? 'image' : 'video',
        width: sourceWidth,
        height: sourceHeight,
      },
      at: time,
      localTime: clipLocalTime(clip),
      clipDuration: videoClipLength(clip),
      // Cache identity must include the decoded frame, not just the edit time:
      // trims, speed changes, and repeated source assets can map the same
      // effect time to a different picture.
      sourceTime: clip.image ? 0 : preview.currentTime,
      transform: clip.transform,
      effects: clip.effects,
      animation: clip.animation,
      transition: clip.transition,
      trackOpacity: videoTrackOpacity(clip.track),
      stage: {
        width: previewWidth,
        height: previewHeight,
        fit: size.fit,
        dpr: previewDpr,
      },
    });
    if (!capture && !playing) {
      const cached = previewRenderCache.get(plan.signature);
      if (cached) {
        if (cachedFrameSignature !== plan.signature || cacheCanvas?.style.display !== 'block') {
          showCacheFrame(plan.signature, cached);
        }
        preview.style.visibility = 'hidden';
        still.style.visibility = 'hidden';
        return;
      }
    }
    hideCacheFrame();
    // Preview playback is a 60 fps target. Rendering the 165 Hz rAF loop
    // competes with 4K decode on the same GPU and causes missed refreshes
    // without showing any extra video frames.
    if (!capture && playing) {
      const now = performance.now();
      if (now - lastGpuRenderAt < 1000 / 60 - 1) return;
      lastGpuRenderAt = now;
    }
    const result = compositor.render({ plan, source, capture });
    if (result.rendered) {
      preview.style.visibility = 'hidden';
      still.style.visibility = 'hidden';
      if (!capture && !playing) scheduleCacheCapture(clip);
    } else {
      compositor.clear();
      showCssPreview();
    }
  }

  let transformDrag: {
    pointerId: number;
    mode: 'move' | 'scale' | 'rotate';
    handle: string;
    clip: VideoClip;
    clientX: number;
    clientY: number;
    x: number;
    y: number;
    scale: number;
    scaleX: number;
    scaleY: number;
    rotation: number;
    centerX: number;
    centerY: number;
    distance: number;
    angle: number;
    width: number;
    height: number;
    frameWidth: number;
    frameHeight: number;
    anchorX: number;
    anchorY: number;
    cos: number;
    sin: number;
    signX: number;
    signY: number;
  } | null = null;

  function writeAnimatedValue(clip: VideoClip, key: 'scale' | 'x' | 'y' | 'rotation', value: number): void {
    if (clip.animation[key].length) {
      clip.animation[key] = withKeyframe(clip.animation[key], clipLocalTime(clip), value, 'linear');
    } else {
      clip.transform[key] = value;
    }
  }

  interface StageFit {
    stageWidth: number;
    stageHeight: number;
    /** The picture's fitted size before the clip transform. */
    baseWidth: number;
    baseHeight: number;
  }

  function stageFit(clip: VideoClip): StageFit {
    const size = outputDimensions();
    const sourceWidth = clip.probe.width || size.width;
    const sourceHeight = clip.probe.height || size.height;
    const stageWidth = stage.clientWidth;
    const stageHeight = stage.clientHeight;
    const fit = size.fit === 'cover'
      ? Math.max(stageWidth / sourceWidth, stageHeight / sourceHeight)
      : Math.min(stageWidth / sourceWidth, stageHeight / sourceHeight);
    return {
      stageWidth,
      stageHeight,
      baseWidth: size.fit === 'cover' ? stageWidth : sourceWidth * fit,
      baseHeight: size.fit === 'cover' ? stageHeight : sourceHeight * fit,
    };
  }

  type StageGuide = 'center' | 'left' | 'right' | 'top' | 'bottom' | null;

  /**
   * Snap a dragged clip so its centre or an edge lines up with the frame
   * centre or an output border. Rotation is accounted for with a bounding box.
   */
  function snapStageMove(
    clip: VideoClip,
    x: number,
    y: number,
    scale: number,
    rotation: number,
  ): { x: number; y: number; guideX: StageGuide; guideY: StageGuide } {
    if (!stageSnapEnabled) return { x, y, guideX: null, guideY: null };
    const fit = stageFit(clip);
    if (fit.stageWidth < 20 || fit.stageHeight < 20) {
      return { x, y, guideX: null, guideY: null };
    }
    const radians = (Math.abs(rotation) * Math.PI) / 180;
    const cos = Math.abs(Math.cos(radians));
    const sin = Math.abs(Math.sin(radians));
    const boxWidth = scale * (fit.baseWidth * cos + fit.baseHeight * sin);
    const boxHeight = scale * (fit.baseWidth * sin + fit.baseHeight * cos);
    const halfWidth = boxWidth / 2;
    const halfHeight = boxHeight / 2;
    const tolerance = 12;
    const xCandidates: { value: number; guide: StageGuide }[] = [
      { value: 0, guide: 'center' },
      { value: ((halfWidth - fit.stageWidth / 2) / fit.stageWidth) * 100, guide: 'left' },
      { value: ((fit.stageWidth / 2 - halfWidth) / fit.stageWidth) * 100, guide: 'right' },
    ];
    const yCandidates: { value: number; guide: StageGuide }[] = [
      { value: 0, guide: 'center' },
      { value: ((halfHeight - fit.stageHeight / 2) / fit.stageHeight) * 100, guide: 'top' },
      { value: ((fit.stageHeight / 2 - halfHeight) / fit.stageHeight) * 100, guide: 'bottom' },
    ];
    const nearest = (
      value: number,
      candidates: { value: number; guide: StageGuide }[],
      pixelsPerPercent: number,
    ): { value: number; guide: StageGuide } => {
      let best = { value, guide: null as StageGuide };
      let bestDistance = tolerance;
      for (const candidate of candidates) {
        const distance = Math.abs(value - candidate.value) * pixelsPerPercent / 100;
        if (distance < bestDistance) {
          bestDistance = distance;
          best = candidate;
        }
      }
      return best;
    };
    const snappedX = nearest(x, xCandidates, fit.stageWidth);
    const snappedY = nearest(y, yCandidates, fit.stageHeight);
    return {
      x: Math.max(-200, Math.min(200, snappedX.value)),
      y: Math.max(-200, Math.min(200, snappedY.value)),
      guideX: snappedX.guide,
      guideY: snappedY.guide,
    };
  }

  function showStageGuides(guideX: StageGuide, guideY: StageGuide): void {
    const horizontal: Record<string, number> = { center: 50, left: 0, right: 100 };
    const vertical: Record<string, number> = { center: 50, top: 0, bottom: 100 };
    if (guideX) {
      alignGuideV.style.left = `${horizontal[guideX] ?? 50}%`;
      alignGuideV.dataset.kind = guideX === 'center' ? 'center' : 'edge';
      alignGuideV.classList.add('visible');
    } else {
      alignGuideV.classList.remove('visible');
    }
    if (guideY) {
      alignGuideH.style.top = `${vertical[guideY] ?? 50}%`;
      alignGuideH.dataset.kind = guideY === 'center' ? 'center' : 'edge';
      alignGuideH.classList.add('visible');
    } else {
      alignGuideH.classList.remove('visible');
    }
  }

  function hideStageGuides(): void {
    alignGuideV.classList.remove('visible');
    alignGuideH.classList.remove('visible');
  }

  type GraphicGuide = 'center' | 'left' | 'right' | 'top' | 'bottom' | null;
  interface GraphicDragState {
    pointerId: number;
    mode: 'move' | 'scale' | 'rotate';
    handle: string;
    graphic: GraphicClip;
    startClientX: number;
    startClientY: number;
    x: number;
    y: number;
    width: number;
    height: number;
    rotation: number;
    boundsLeft: number;
    boundsTop: number;
    stageWidth: number;
    stageHeight: number;
    frameWidth: number;
    frameHeight: number;
    centerX: number;
    centerY: number;
    anchorX: number;
    anchorY: number;
    angle: number;
    cos: number;
    sin: number;
    signX: number;
    signY: number;
  }
  let graphicDrag: GraphicDragState | null = null;

  function graphicPreviewBox(graphic: GraphicClip): { left: number; top: number; width: number; height: number } {
    const stageWidth = stage.clientWidth;
    const stageHeight = stage.clientHeight;
    const width = Math.max(8, (graphic.width / 100) * stageWidth);
    const height = graphic.kind === 'line'
      ? Math.max(20, Math.max(2, graphic.strokeWidth) + 16)
      : Math.max(8, (graphic.height / 100) * stageHeight);
    const left = (graphic.x / 100) * stageWidth;
    const top = graphic.kind === 'line'
      ? (graphic.y / 100) * stageHeight - height / 2
      : (graphic.y / 100) * stageHeight;
    return { left, top, width, height };
  }

  function showGraphicGuides(guideX: GraphicGuide, guideY: GraphicGuide): void {
    const horizontal: Record<string, number> = { center: 50, left: 0, right: 100 };
    const vertical: Record<string, number> = { center: 50, top: 0, bottom: 100 };
    if (guideX) {
      graphicGuideV.style.left = `${horizontal[guideX] ?? 50}%`;
      graphicGuideV.dataset.kind = guideX === 'center' ? 'center' : 'edge';
      graphicGuideV.classList.add('visible');
    } else {
      graphicGuideV.classList.remove('visible');
    }
    if (guideY) {
      graphicGuideH.style.top = `${vertical[guideY] ?? 50}%`;
      graphicGuideH.dataset.kind = guideY === 'center' ? 'center' : 'edge';
      graphicGuideH.classList.add('visible');
    } else {
      graphicGuideH.classList.remove('visible');
    }
  }

  function hideGraphicGuides(): void {
    graphicGuideV.classList.remove('visible');
    graphicGuideH.classList.remove('visible');
  }

  function snapGraphicMove(graphic: GraphicClip, x: number, y: number): { x: number; y: number; guideX: GraphicGuide; guideY: GraphicGuide } {
    if (!stageSnapEnabled) return { x, y, guideX: null, guideY: null };
    const stageWidth = stage.clientWidth;
    const stageHeight = stage.clientHeight;
    if (stageWidth < 20 || stageHeight < 20) return { x, y, guideX: null, guideY: null };
    const width = graphic.width;
    const height = graphic.kind === 'line' ? 0 : graphic.height;
    const xCandidates: { value: number; guide: GraphicGuide }[] = [
      { value: 0, guide: 'left' },
      { value: 50 - width / 2, guide: 'center' },
      { value: 100 - width, guide: 'right' },
    ];
    const yCandidates: { value: number; guide: GraphicGuide }[] = graphic.kind === 'line'
      ? [
        { value: 0, guide: 'top' },
        { value: 50, guide: 'center' },
        { value: 100, guide: 'bottom' },
      ]
      : [
        { value: 0, guide: 'top' },
        { value: 50 - height / 2, guide: 'center' },
        { value: 100 - height, guide: 'bottom' },
      ];
    const xTolerance = (10 / stageWidth) * 100;
    const yTolerance = (10 / stageHeight) * 100;
    let bestX = x;
    let guideX: GraphicGuide = null;
    let bestXDelta = xTolerance;
    for (const candidate of xCandidates) {
      const delta = Math.abs(x - candidate.value);
      if (delta <= bestXDelta) {
        bestX = candidate.value;
        guideX = candidate.guide;
        bestXDelta = delta;
      }
    }
    let bestY = y;
    let guideY: GraphicGuide = null;
    let bestYDelta = yTolerance;
    for (const candidate of yCandidates) {
      const delta = Math.abs(y - candidate.value);
      if (delta <= bestYDelta) {
        bestY = candidate.value;
        guideY = candidate.guide;
        bestYDelta = delta;
      }
    }
    return { x: bestX, y: bestY, guideX, guideY };
  }

  function updateGraphicOverlay(): void {
    const graphic = graphics[selectedGraphic];
    const visible = Boolean(
      graphic &&
      !selected &&
      selectedTitle < 0 &&
      !videoTrackHidden(graphicTrackIndex(graphic)) &&
      time >= graphic.start &&
      time < graphic.end &&
      !playing &&
      !operation,
    );
    if (!graphic || !visible) {
      graphicOverlay.classList.add('hidden');
      hideGraphicGuides();
      return;
    }
    const stageWidth = stage.clientWidth;
    const stageHeight = stage.clientHeight;
    if (stageWidth < 20 || stageHeight < 20) {
      graphicOverlay.classList.add('hidden');
      return;
    }
    const box = graphicPreviewBox(graphic);
    graphicOverlay.style.left = `${stage.offsetLeft}px`;
    graphicOverlay.style.top = `${stage.offsetTop}px`;
    graphicOverlay.style.width = `${stageWidth}px`;
    graphicOverlay.style.height = `${stageHeight}px`;
    graphicFrame.style.left = `${box.left}px`;
    graphicFrame.style.top = `${box.top}px`;
    graphicFrame.style.width = `${box.width}px`;
    graphicFrame.style.height = `${box.height}px`;
    graphicFrame.style.transform = `rotate(${graphic.rotation}deg)`;
    graphicFrame.classList.toggle('is-line', graphic.kind === 'line');
    graphicOverlay.classList.remove('hidden');
  }

  function beginGraphicDrag(
    event: PointerEvent,
    graphic: GraphicClip,
    mode: 'move' | 'scale' | 'rotate',
    handle: string,
  ): void {
    if (event.button !== 0 || playing || graphicDrag) return;
    event.preventDefault();
    event.stopPropagation();
    const index = graphics.indexOf(graphic);
    if (index < 0) return;
    selectedGraphic = index;
    selected = null;
    selectedTitle = -1;
    selectedSubtitleKey = '';
    selectSideTab('graphics');
    ensureInspectorOpen();
    renderGraphicsPanel();
    graphicsPreviewKey = '';
    renderGraphicsPreview();
    updateGraphicOverlay();

    const bounds = stage.getBoundingClientRect();
    const stageWidth = stage.clientWidth;
    const stageHeight = stage.clientHeight;
    const box = graphicPreviewBox(graphic);
    const signX = handle.includes('w') ? -1 : handle.includes('e') ? 1 : 0;
    const signY = handle.includes('n') ? -1 : handle.includes('s') ? 1 : 0;
    const cos = Math.cos((graphic.rotation * Math.PI) / 180);
    const sin = Math.sin((graphic.rotation * Math.PI) / 180);
    const centerX = bounds.left + box.left + box.width / 2;
    const centerY = bounds.top + box.top + box.height / 2;
    const anchorX = centerX + cos * (-signX * box.width / 2) - sin * (-signY * box.height / 2);
    const anchorY = centerY + sin * (-signX * box.width / 2) + cos * (-signY * box.height / 2);
    const drag: GraphicDragState = {
      pointerId: event.pointerId,
      mode,
      handle,
      graphic,
      startClientX: event.clientX,
      startClientY: event.clientY,
      x: graphic.x,
      y: graphic.y,
      width: graphic.width,
      height: graphic.height,
      rotation: graphic.rotation,
      boundsLeft: bounds.left,
      boundsTop: bounds.top,
      stageWidth,
      stageHeight,
      frameWidth: box.width,
      frameHeight: box.height,
      centerX,
      centerY,
      anchorX,
      anchorY,
      angle: Math.atan2(event.clientY - centerY, event.clientX - centerX),
      cos,
      sin,
      signX,
      signY,
    };
    graphicDrag = drag;
    hideGraphicGuides();

    const move = (moveEvent: PointerEvent): void => {
      if (!graphicDrag || moveEvent.pointerId !== drag.pointerId) return;
      moveEvent.preventDefault();
      if (drag.mode === 'move') {
        const nextX = drag.x + ((moveEvent.clientX - drag.startClientX) / drag.stageWidth) * 100;
        const nextY = drag.y + ((moveEvent.clientY - drag.startClientY) / drag.stageHeight) * 100;
        const snapped = snapGraphicMove(drag.graphic, nextX, nextY);
        drag.graphic.x = Number(Math.max(-50, Math.min(150, snapped.x)).toFixed(2));
        drag.graphic.y = Number(Math.max(-50, Math.min(150, snapped.y)).toFixed(2));
        showGraphicGuides(snapped.guideX, snapped.guideY);
      } else if (drag.mode === 'scale') {
        hideGraphicGuides();
        const dx = moveEvent.clientX - drag.anchorX;
        const dy = moveEvent.clientY - drag.anchorY;
        const localX = dx * drag.cos + dy * drag.sin;
        const localY = -dx * drag.sin + dy * drag.cos;
        let nextWidth = drag.frameWidth;
        let nextHeight = drag.frameHeight;
        if (drag.graphic.kind === 'line') {
          if (drag.signX) nextWidth = Math.max(8, Math.min(drag.stageWidth, Math.abs(localX)));
        } else {
          if (drag.signX) nextWidth = Math.max(8, Math.min(drag.stageWidth, Math.abs(localX)));
          if (drag.signY) nextHeight = Math.max(8, Math.min(drag.stageHeight, Math.abs(localY)));
          if (moveEvent.shiftKey && drag.signX && drag.signY) {
            const ratio = Math.max(nextWidth / drag.frameWidth, nextHeight / drag.frameHeight);
            nextWidth = drag.frameWidth * ratio;
            nextHeight = drag.frameHeight * ratio;
          }
        }
        const localCenterX = drag.signX ? (drag.signX * nextWidth) / 2 : 0;
        const localCenterY = drag.graphic.kind === 'line' ? 0 : drag.signY ? (drag.signY * nextHeight) / 2 : 0;
        const nextCenterX = drag.anchorX + drag.cos * localCenterX - drag.sin * localCenterY;
        const nextCenterY = drag.anchorY + drag.sin * localCenterX + drag.cos * localCenterY;
        const widthPct = Math.max(1, Math.min(100, (nextWidth / drag.stageWidth) * 100));
        const heightPct = drag.graphic.kind === 'line'
          ? drag.height
          : Math.max(1, Math.min(100, (nextHeight / drag.stageHeight) * 100));
        drag.graphic.width = Number(widthPct.toFixed(2));
        drag.graphic.height = Number(heightPct.toFixed(2));
        drag.graphic.x = Number(Math.max(-50, Math.min(150, ((nextCenterX - drag.boundsLeft) / drag.stageWidth) * 100 - widthPct / 2)).toFixed(2));
        drag.graphic.y = drag.graphic.kind === 'line'
          ? Number(drag.y.toFixed(2))
          : Number(Math.max(-50, Math.min(150, ((nextCenterY - drag.boundsTop) / drag.stageHeight) * 100 - heightPct / 2)).toFixed(2));
      } else {
        hideGraphicGuides();
        let rotation = drag.rotation + ((Math.atan2(moveEvent.clientY - drag.centerY, moveEvent.clientX - drag.centerX) - drag.angle) * 180) / Math.PI;
        if (moveEvent.shiftKey) {
          rotation = Math.round(rotation / 15) * 15;
        } else {
          const rightAngle = Math.round(rotation / 90) * 90;
          if (Math.abs(rotation - rightAngle) <= 6) rotation = rightAngle;
        }
        rotation = ((rotation + 180) % 360 + 360) % 360 - 180;
        drag.graphic.rotation = Number(rotation.toFixed(2));
      }
      const previewEntry = graphicsPreviewEntries.find((entry) => entry.graphic === drag.graphic);
      graphicsPreviewKey = '';
      if (previewEntry) {
        styleGraphicPreviewElement(previewEntry.el, drag.graphic);
        updateGraphicsPreviewOpacity();
      } else {
        renderGraphicsPreview();
      }
      updateGraphicOverlay();
      syncGraphicGeometryInputs(drag.graphic);
    };
    const up = (): void => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', up);
      graphicDrag = null;
      hideGraphicGuides();
      graphicsPreviewKey = '';
      renderGraphicsPreview();
      updateGraphicOverlay();
      renderGraphicsPanel();
      commit('Transformed graphic overlay');
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
  }

  graphicFrame.addEventListener('pointerdown', (event) => {
    const graphic = graphics[selectedGraphic];
    if (!graphic) return;
    const handle = (event.target as HTMLElement).closest<HTMLElement>('[data-handle]')?.dataset.handle ?? '';
    const mode = handle === 'rotate' ? 'rotate' : handle ? 'scale' : 'move';
    beginGraphicDrag(event, graphic, mode, handle);
  });

  interface TitleDragState {
    pointerId: number;
    index: number;
    mode: 'move' | 'rotate';
    startClientX: number;
    startClientY: number;
    x: number;
    y: number;
    rotation: number;
    stageWidth: number;
    stageHeight: number;
    anchorX: number;
    anchorY: number;
    angle: number;
  }
  let titleDrag: TitleDragState | null = null;

  function updateTitleOverlay(): void {
    const cue = selectedTitle >= 0 ? titles[selectedTitle] : null;
    const visible = Boolean(
      cue &&
      !selected &&
      !selectedSubtitleKey &&
      time >= cue.start &&
      time < cue.end &&
      !playing &&
      !operation,
    );
    if (!cue || !visible) {
      titleOverlay.classList.add('hidden');
      return;
    }
    const box = textLayer.querySelector<HTMLElement>(`.video-text-anchor[data-title-index="${selectedTitle}"] .video-text-box`);
    if (!box) {
      titleOverlay.classList.add('hidden');
      return;
    }
    const stageWidth = stage.clientWidth;
    const stageHeight = stage.clientHeight;
    if (stageWidth < 20 || stageHeight < 20) {
      titleOverlay.classList.add('hidden');
      return;
    }
    const style = ensureTitleStyle(cue);
    titleOverlay.style.left = `${stage.offsetLeft}px`;
    titleOverlay.style.top = `${stage.offsetTop}px`;
    titleOverlay.style.width = `${stageWidth}px`;
    titleOverlay.style.height = `${stageHeight}px`;
    const anchorX = (style.x / 100) * stageWidth;
    const anchorY = (style.y / 100) * stageHeight;
    const width = box.offsetWidth + 8;
    const height = box.offsetHeight + 8;
    titleAnchor.style.left = `${anchorX}px`;
    titleAnchor.style.top = `${anchorY}px`;
    titleAnchor.style.transform = `rotate(${style.rotation}deg)`;
    titleFrame.style.left = `${style.align === 'left' ? -4 : style.align === 'right' ? -width + 4 : -width / 2}px`;
    titleFrame.style.top = `${-height / 2}px`;
    titleFrame.style.width = `${width}px`;
    titleFrame.style.height = `${height}px`;
    titleOverlay.classList.remove('hidden');
  }

  function beginTitlePreviewDrag(
    event: PointerEvent,
    index: number,
    mode: 'move' | 'rotate',
  ): void {
    if (event.button !== 0 || playing || titleDrag) return;
    const cue = titles[index];
    if (!cue) return;
    event.preventDefault();
    event.stopPropagation();
    selectedTitle = index;
    selected = null;
    selectedSubtitleKey = '';
    selectedGraphic = -1;
    selectSideTab('text');
    ensureInspectorOpen();
    const style = ensureTitleStyle(cue);
    renderTextLayer();
    updateTitleOverlay();
    const bounds = stage.getBoundingClientRect();
    const stageWidth = stage.clientWidth;
    const stageHeight = stage.clientHeight;
    const anchorX = bounds.left + (style.x / 100) * stageWidth;
    const anchorY = bounds.top + (style.y / 100) * stageHeight;
    const drag: TitleDragState = {
      pointerId: event.pointerId,
      index,
      mode,
      startClientX: event.clientX,
      startClientY: event.clientY,
      x: style.x,
      y: style.y,
      rotation: style.rotation,
      stageWidth,
      stageHeight,
      anchorX,
      anchorY,
      angle: Math.atan2(event.clientY - anchorY, event.clientX - anchorX),
    };
    titleDrag = drag;
    const move = (moveEvent: PointerEvent): void => {
      if (!titleDrag || moveEvent.pointerId !== drag.pointerId) return;
      moveEvent.preventDefault();
      const current = ensureTitleStyle(cue);
      if (drag.mode === 'move') {
        current.x = Number(Math.max(-50, Math.min(150, drag.x + ((moveEvent.clientX - drag.startClientX) / drag.stageWidth) * 100)).toFixed(2));
        current.y = Number(Math.max(-20, Math.min(120, drag.y + ((moveEvent.clientY - drag.startClientY) / drag.stageHeight) * 100)).toFixed(2));
      } else {
        let rotation = drag.rotation + (
          (Math.atan2(moveEvent.clientY - drag.anchorY, moveEvent.clientX - drag.anchorX) - drag.angle) * 180
        ) / Math.PI;
        if (moveEvent.shiftKey) {
          rotation = Math.round(rotation / 15) * 15;
        } else {
          const rightAngle = Math.round(rotation / 90) * 90;
          if (Math.abs(rotation - rightAngle) <= 6) rotation = rightAngle;
        }
        current.rotation = Number((((rotation + 180) % 360 + 360) % 360 - 180).toFixed(2));
      }
      renderTextLayer();
      updateTitleOverlay();
      syncTextStyleEditor();
    };
    const up = (): void => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', up);
      titleDrag = null;
      renderTextLayer();
      updateTitleOverlay();
      syncTextStyleEditor();
      commit('Transformed title');
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
  }

  titleFrame.addEventListener('pointerdown', (event) => {
    if (selectedTitle < 0) return;
    const handle = (event.target as HTMLElement).closest<HTMLElement>('[data-handle]')?.dataset.handle ?? '';
    beginTitlePreviewDrag(event, selectedTitle, handle === 'rotate' ? 'rotate' : 'move');
  });

  /** Position the direct-manipulation handles over the visible picture. */
  function updateTransformOverlay(): void {
    updateGraphicOverlay();
    updateTitleOverlay();
    const clip = selected?.kind === 'video' ? videos.find((entry) => entry.id === selected!.id) ?? null : null;
    const show = Boolean(clip && clip === activeVideo && !playing && !operation && videos.length);
    if (!clip || !show) {
      transformOverlay.classList.add('hidden');
      hideStageGuides();
      return;
    }
    const stageWidth = stage.clientWidth;
    const stageHeight = stage.clientHeight;
    if (stageWidth < 20 || stageHeight < 20) {
      transformOverlay.classList.add('hidden');
      return;
    }
    transformOverlay.style.left = `${stage.offsetLeft}px`;
    transformOverlay.style.top = `${stage.offsetTop}px`;
    transformOverlay.style.width = `${stageWidth}px`;
    transformOverlay.style.height = `${stageHeight}px`;
    const size = outputDimensions();
    const sourceWidth = clip.probe.width || size.width;
    const sourceHeight = clip.probe.height || size.height;
    const scale = size.fit === 'cover'
      ? Math.max(stageWidth / sourceWidth, stageHeight / sourceHeight)
      : Math.min(stageWidth / sourceWidth, stageHeight / sourceHeight);
    const frameWidth = size.fit === 'cover' ? stageWidth : sourceWidth * scale;
    const frameHeight = size.fit === 'cover' ? stageHeight : sourceHeight * scale;
    const state = clipStateAt(clip);
    transformFrame.style.width = `${frameWidth}px`;
    transformFrame.style.height = `${frameHeight}px`;
    transformFrame.style.left = `${(stageWidth - frameWidth) / 2}px`;
    transformFrame.style.top = `${(stageHeight - frameHeight) / 2}px`;
    transformFrame.style.transform =
      `translate(${(state.transform.x / 100) * stageWidth}px, ${(state.transform.y / 100) * stageHeight}px) ` +
      `rotate(${state.transform.rotation}deg) scale(${state.transform.scale * state.transform.scaleX}, ${state.transform.scale * state.transform.scaleY})`;
    transformOverlay.classList.remove('hidden');
    if (clip !== transformDrag?.clip) transformOverlay.dataset.clipId = String(clip.id);
  }

  transformFrame.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || playing) return;
    const clip = selected?.kind === 'video' ? videos.find((entry) => entry.id === selected!.id) : null;
    if (!clip || clip !== activeVideo) return;
    const handle = (event.target as HTMLElement).dataset.handle ?? '';
    const mode = handle === 'rotate' ? 'rotate' : handle ? 'scale' : 'move';
    const stageWidth = stage.clientWidth;
    const stageHeight = stage.clientHeight;
    const state = clipStateAt(clip);
    const bounds = stage.getBoundingClientRect();
    const centerX = bounds.left + stageWidth / 2 + (state.transform.x / 100) * stageWidth;
    const centerY = bounds.top + stageHeight / 2 + (state.transform.y / 100) * stageHeight;
    const signX = handle.includes('w') ? -1 : handle.includes('e') ? 1 : 0;
    const signY = handle.includes('n') ? -1 : handle.includes('s') ? 1 : 0;
    const frameWidth = transformFrame.offsetWidth;
    const frameHeight = transformFrame.offsetHeight;
    const cos = Math.cos((state.transform.rotation * Math.PI) / 180);
    const sin = Math.sin((state.transform.rotation * Math.PI) / 180);
    const halfWidth = (frameWidth * state.transform.scale * state.transform.scaleX) / 2;
    const halfHeight = (frameHeight * state.transform.scale * state.transform.scaleY) / 2;
    const anchorLocalX = signX && signY ? -signX * halfWidth : signX ? -signX * halfWidth : 0;
    const anchorLocalY = signX && signY ? -signY * halfHeight : signY ? -signY * halfHeight : 0;
    transformDrag = {
      pointerId: event.pointerId,
      mode,
      handle,
      clip,
      clientX: event.clientX,
      clientY: event.clientY,
      x: state.transform.x,
      y: state.transform.y,
      scale: state.transform.scale,
      scaleX: state.transform.scaleX,
      scaleY: state.transform.scaleY,
      rotation: state.transform.rotation,
      centerX,
      centerY,
      distance: Math.max(8, Math.hypot(event.clientX - centerX, event.clientY - centerY)),
      angle: Math.atan2(event.clientY - centerY, event.clientX - centerX),
      width: stageWidth,
      height: stageHeight,
      frameWidth,
      frameHeight,
      anchorX: centerX + cos * anchorLocalX - sin * anchorLocalY,
      anchorY: centerY + sin * anchorLocalX + cos * anchorLocalY,
      cos,
      sin,
      signX,
      signY,
    };
    try { transformFrame.setPointerCapture(event.pointerId); } catch { /* synthetic or already released */ }
    hideStageGuides();
    event.preventDefault();
    event.stopPropagation();
  });

  transformFrame.addEventListener('pointermove', (event) => {
    const drag = transformDrag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    if (drag.mode === 'move') {
      const x = drag.x + ((event.clientX - drag.clientX) / drag.width) * 100;
      const y = drag.y + ((event.clientY - drag.clientY) / drag.height) * 100;
      const snapped = snapStageMove(drag.clip, x, y, drag.scale, drag.rotation);
      writeAnimatedValue(drag.clip, 'x', Number(snapped.x.toFixed(2)));
      writeAnimatedValue(drag.clip, 'y', Number(snapped.y.toFixed(2)));
      showStageGuides(snapped.guideX, snapped.guideY);
    } else if (drag.mode === 'scale') {
      hideStageGuides();
      const ctrl = event.ctrlKey || event.metaKey;
      if (ctrl && drag.handle && drag.handle !== 'rotate') {
        const dx = event.clientX - drag.anchorX;
        const dy = event.clientY - drag.anchorY;
        const localX = dx * drag.cos + dy * drag.sin;
        const localY = -dx * drag.sin + dy * drag.cos;
        const startWidth = drag.frameWidth * drag.scale * drag.scaleX;
        const startHeight = drag.frameHeight * drag.scale * drag.scaleY;
        let newWidth = startWidth;
        let newHeight = startHeight;
        if (drag.signX && drag.signY) {
          const startVectorX = drag.signX * startWidth;
          const startVectorY = drag.signY * startHeight;
          const factor = (localX * startVectorX + localY * startVectorY) /
            Math.max(1, startWidth * startWidth + startHeight * startHeight);
          const nextScale = Math.max(0.05, Math.min(10, drag.scale * factor));
          const ratio = nextScale / drag.scale;
          newWidth = startWidth * ratio;
          newHeight = startHeight * ratio;
          writeAnimatedValue(drag.clip, 'scale', Number(nextScale.toFixed(4)));
        } else if (drag.signX) {
          const desired = Math.max(8, localX * drag.signX);
          const nextScaleX = Math.max(0.05, Math.min(10, desired / Math.max(1, drag.frameWidth * drag.scale)));
          newWidth = drag.frameWidth * drag.scale * nextScaleX;
          drag.clip.transform.scaleX = nextScaleX;
          drag.clip.transform.scaleY = drag.scaleY;
        } else if (drag.signY) {
          const desired = Math.max(8, localY * drag.signY);
          const nextScaleY = Math.max(0.05, Math.min(10, desired / Math.max(1, drag.frameHeight * drag.scale)));
          newHeight = drag.frameHeight * drag.scale * nextScaleY;
          drag.clip.transform.scaleY = nextScaleY;
          drag.clip.transform.scaleX = drag.scaleX;
        }
        let localCenterX = 0;
        let localCenterY = 0;
        if (drag.signX) localCenterX = (drag.signX * newWidth) / 2;
        if (drag.signY) localCenterY = (drag.signY * newHeight) / 2;
        const newCenterX = drag.anchorX + drag.cos * localCenterX - drag.sin * localCenterY;
        const newCenterY = drag.anchorY + drag.sin * localCenterX + drag.cos * localCenterY;
        const bounds = stage.getBoundingClientRect();
        const stageCenterX = bounds.left + drag.width / 2;
        const stageCenterY = bounds.top + drag.height / 2;
        const nextX = Math.max(-200, Math.min(200, ((newCenterX - stageCenterX) / drag.width) * 100));
        const nextY = Math.max(-200, Math.min(200, ((newCenterY - stageCenterY) / drag.height) * 100));
        writeAnimatedValue(drag.clip, 'x', Number(nextX.toFixed(2)));
        writeAnimatedValue(drag.clip, 'y', Number(nextY.toFixed(2)));
      } else {
        const distance = Math.hypot(event.clientX - drag.centerX, event.clientY - drag.centerY);
        const scale = Math.max(0.05, Math.min(4, drag.scale * (distance / drag.distance)));
        writeAnimatedValue(drag.clip, 'scale', Number(scale.toFixed(4)));
      }
    } else {
      hideStageGuides();
      let rotation = drag.rotation + ((Math.atan2(event.clientY - drag.centerY, event.clientX - drag.centerX) - drag.angle) * 180) / Math.PI;
      if (event.shiftKey) {
        rotation = Math.round(rotation / 15) * 15;
      } else {
        const rightAngle = Math.round(rotation / 90) * 90;
        if (Math.abs(rotation - rightAngle) <= 6) rotation = rightAngle;
      }
      rotation = ((rotation + 180) % 360 + 360) % 360 - 180;
      writeAnimatedValue(drag.clip, 'rotation', Number(rotation.toFixed(2)));
    }
    applyPreviewTransform(drag.clip);
    updateTransformOverlay();
  });

  const endTransformDrag = (event: PointerEvent): void => {
    if (!transformDrag || event.pointerId !== transformDrag.pointerId) return;
    const clip = transformDrag.clip;
    transformDrag = null;
    hideStageGuides();
    try { transformFrame.releasePointerCapture(event.pointerId); } catch { /* already released */ }
    applyPreviewTransform(clip);
    updateTransformOverlay();
    renderInspector();
    commit();
  };
  transformFrame.addEventListener('pointerup', endTransformDrag);
  transformFrame.addEventListener('pointercancel', endTransformDrag);
  transformFrame.addEventListener('dblclick', (event) => {
    event.preventDefault();
    const clip = selected?.kind === 'video' ? videos.find((entry) => entry.id === selected!.id) : null;
    if (!clip) return;
    clip.transform = { ...DEFAULT_CLIP_TRANSFORM };
    clip.animation.scale = [];
    clip.animation.x = [];
    clip.animation.y = [];
    clip.animation.rotation = [];
    applyPreviewTransform(clip);
    updateTransformOverlay();
    render();
    commit();
  });

  function warmNextVideo(): void {
    const now = performance.now();
    if (now - warmedVideoAt < 500) return;
    warmedVideoAt = now;
    let next: VideoClip | null = null;
    let nextStart = Infinity;
    for (const clip of videos) {
      if (clip.image || clip.start <= time + 0.05 || clip.start >= nextStart) continue;
      next = clip;
      nextStart = clip.start;
    }
    if (!next || nextStart - time > 5) {
      if (warmedVideoKey) {
        warmedVideoKey = '';
        preloadVideo.removeAttribute('src');
        preloadVideo.load();
      }
      return;
    }
    const url = previewSourceUrl(next);
    if (url === warmedVideoKey) return;
    warmedVideoKey = url;
    preloadVideo.src = url;
    preloadVideo.load();
  }

  function audioMixSignatureValue(): string {
    return JSON.stringify({
      rate: ctx.sampleRate,
      end: previewEnd(),
      clips: audios.map((clip) => [
        mediaKey(clip.file), clip.offset, clip.trimStart, clip.trimEnd,
        clip.volume, clip.fadeIn, clip.fadeOut, clip.track, clip.sourceTrack, clip.muted, clip.retime,
      ]),
      tracks: audioTrackState.map((state) => [state.muted, state.solo, state.gain ?? 1]),
    });
  }

  async function decodeMixClip(file: File, token: number): Promise<AudioBuffer | null> {
    const existing = audioMixBuffers.get(file);
    if (existing) {
      audioMixBuffers.delete(file);
      audioMixBuffers.set(file, existing);
      return existing;
    }
    try {
      const data = await file.arrayBuffer();
      if (token !== audioMixToken) return null;
      const buffer = await ctx.decodeAudioData(data);
      if (token !== audioMixToken) return null;
      const bytes = buffer.length * buffer.numberOfChannels * Float32Array.BYTES_PER_ELEMENT;
      if (bytes > MAX_PREVIEW_AUDIO_BYTES) return null;
      for (const [key, cached] of audioMixBuffers) {
        if (audioMixBytes + bytes <= MAX_PREVIEW_AUDIO_BYTES) break;
        audioMixBuffers.delete(key);
        audioMixBytes -= cached.length * cached.numberOfChannels * Float32Array.BYTES_PER_ELEMENT;
      }
      audioMixBuffers.set(file, buffer);
      audioMixBytes += bytes;
      return buffer;
    } catch {
      return null;
    }
  }

  async function renderAudioMix(): Promise<void> {
    const token = ++audioMixToken;
    if (!audios.length) {
      audioMixBuffer = null;
      audioMixDirty = false;
      stopAudioMix();
      return;
    }
    // Media elements preserve pitch when the rate changes during playback.
    if (audios.some((clip) => clip.retime)) return;
    const signature = audioMixSignatureValue();
    const end = previewEnd();
    if (end <= 0.01 || end > MAX_PREVIEW_MIX_SECONDS) return;
    const offline = new OfflineAudioContext(2, Math.ceil(end * ctx.sampleRate), ctx.sampleRate);
    const rows = audioRows();
    const sources = new Set<File>();
    let sourceBytes = 0;
    for (const clip of audios) {
      if (token !== audioMixToken) return;
      const row = rows.get(clip.id) ?? 0;
      if (clip.muted || audioTrackMuted(row)) continue;
      const start = Math.max(0, clip.offset);
      if (start >= end) continue;
      const playable = Math.min(audioClipLength(clip), end - start);
      if (!(playable > 0.01)) continue;
      const level = Math.max(0, clip.volume) * audioTrackGain(row);
      if (!(level > 0)) continue;
      // Long sources keep using the streaming media-element preview.
      if (clip.duration * ctx.sampleRate * 2 * Float32Array.BYTES_PER_ELEMENT > MAX_PREVIEW_AUDIO_BYTES ||
          clip.file.size > MAX_PREVIEW_AUDIO_BYTES) return;
      const audioFile = await previewAudioFile(clip).catch(() => null);
      if (!audioFile || token !== audioMixToken) return;
      const buffer = await decodeMixClip(audioFile, token);
      if (!buffer || token !== audioMixToken) return;
      if (!sources.has(audioFile)) {
        sources.add(audioFile);
        sourceBytes += buffer.length * buffer.numberOfChannels * Float32Array.BYTES_PER_ELEMENT;
        if (sourceBytes > MAX_PREVIEW_AUDIO_BYTES) return;
      }
      const fadeIn = Math.min(Math.max(0, clip.fadeIn), playable / 2);
      const fadeOut = Math.min(Math.max(0, clip.fadeOut), playable / 2);
      const source = offline.createBufferSource();
      source.buffer = buffer;
      const gain = offline.createGain();
      gain.gain.setValueAtTime(fadeIn > 0 ? 0 : level, start);
      if (fadeIn > 0) gain.gain.linearRampToValueAtTime(level, start + fadeIn);
      if (fadeOut > 0) {
        gain.gain.setValueAtTime(level, start + playable - fadeOut);
        gain.gain.linearRampToValueAtTime(0, start + playable);
      }
      source.connect(gain).connect(offline.destination);
      source.start(start, clip.trimStart, playable);
    }
    try {
      const rendered = await offline.startRendering();
      if (token !== audioMixToken || signature !== audioMixSignatureValue()) return;
      audioMixBuffer = rendered;
      audioMixDirty = false;
    } catch {
      // Keep the per-clip fallback.
    }
  }

  function scheduleAudioMix(): void {
    const signature = audioMixSignatureValue();
    if (signature === audioMixSignature) return;
    audioMixSignature = signature;
    ++audioMixToken;
    audioMixDirty = true;
    audioMixBuffer = null;
    window.clearTimeout(audioMixTimer);
    audioMixTimer = 0;
    if (!audios.length || previewEnd() > MAX_PREVIEW_MIX_SECONDS) {
      stopAudioMix();
      return;
    }
    audioMixTimer = window.setTimeout(() => {
      audioMixTimer = 0;
      if (!operation && !recording) void renderAudioMix();
    }, 700);
  }

  function stopAudioMix(): void {
    const source = audioMixSource;
    const gain = audioMixGain;
    audioMixSource = null;
    audioMixGain = null;
    audioMixNeedsStart = false;
    if (!source) {
      gain?.disconnect();
      return;
    }
    source.onended = () => {
      source.disconnect();
      gain?.disconnect();
    };
    try {
      if (gain) {
        const now = ctx.currentTime;
        gain.gain.cancelScheduledValues(now);
        gain.gain.setValueAtTime(gain.gain.value, now);
        gain.gain.linearRampToValueAtTime(0, now + 0.02);
        source.stop(now + 0.025);
      } else {
        source.stop();
      }
    } catch {
      source.disconnect();
      gain?.disconnect();
    }
  }

  function startAudioMix(): void {
    if (!audioMixBuffer || audioMixSource) return;
    const offset = Math.max(0, Math.min(time, audioMixBuffer.duration - 0.005));
    if (offset >= audioMixBuffer.duration - 0.005) return;
    const source = ctx.createBufferSource();
    source.buffer = audioMixBuffer;
    const gain = ctx.createGain();
    source.connect(gain).connect(ctx.destination);
    source.onended = () => {
      if (audioMixSource === source) audioMixSource = null;
    };
    source.start(ctx.currentTime + 0.02, offset);
    audioMixSource = source;
    audioMixGain = gain;
    audioMixNeedsStart = false;
  }

  let pendingVideoSeek: number | null = null;

  function flushVideoSeek(): void {
    if (pendingVideoSeek === null || preview.readyState < 1) return;
    const target = pendingVideoSeek;
    pendingVideoSeek = null;
    if (Math.abs(preview.currentTime - target) > 0.0001) preview.currentTime = target;
  }

  preview.addEventListener('loadeddata', checkPreviewCompatibility);
  preview.addEventListener('error', checkPreviewCompatibility);
  preview.addEventListener('loadedmetadata', flushVideoSeek);
  preview.addEventListener('seeked', flushVideoSeek);

  /** Show the right clip and keep its media close to the timeline clock. */
  function syncMedia(force = false, scrub = false): void {
    const found = videoAt(Math.min(time, Math.max(0, totalVideo() - 0.001)));
    applyPreviewTransform(found?.clip ?? null, false);
    if (!found) {
      if (activeVideo) {
        activeVideo = null;
        pendingVideoSeek = null;
        preview.pause();
        preview.classList.add('hidden');
        still.classList.add('hidden');
        previewGain.gain.value = 0;
      }
    } else if (activeVideo !== found.clip ||
        (!found.clip.image && preview.getAttribute('src') !== previewSourceUrl(found.clip))) {
      activeVideo = found.clip;
      pendingVideoSeek = null;
      if (found.clip.image) {
        preview.pause();
        preview.classList.add('hidden');
        still.src = previewSourceUrl(found.clip);
        still.classList.remove('hidden');
      } else {
        still.classList.add('hidden');
        preview.classList.remove('hidden');
        preview.src = previewSourceUrl(found.clip);
      }
      applyOriginalVolume();
      force = true;
    }
    if (found) preview.playbackRate = speedAtSource(found.clip.effects, found.local);
    if (found && !found.clip.image) {
      const drift = Math.abs(preview.currentTime - found.local);
      if (force || drift > 0.25) {
        pendingVideoSeek = found.local;
        if (!scrub || !preview.seeking) flushVideoSeek();
      }
      if (playing && preview.paused) void preview.play().catch(() => undefined);
      if (!playing && !preview.paused) preview.pause();
    }
    renderGpuPreview(found?.clip ?? null);
    if (found?.clip.probe.hasAudio && !found.clip.image && usesSeparateOriginalSound(found.clip) &&
        !found.clip.mute && keepOriginal.checked) {
      const element = originalSound.element;
      const ready = ensureAudioSource(element, found.clip.file, found.clip.audioTrack);
      if (ready && element.readyState >= 1) {
        element.playbackRate = preview.playbackRate;
        if (force || Math.abs(element.currentTime - found.local) > 0.2) element.currentTime = found.local;
        if (playing && element.paused) void element.play().catch(() => undefined);
      }
    } else if (!originalSound.element.paused) {
      originalSound.element.pause();
    }
    const sourceAudible = found && !found.clip.image && found.clip.probe.hasAudio &&
      !found.clip.mute && found.clip.volume > 0;
    applyOriginalVolume();
    const captionDucking = duck.checked && duckCaptions.checked && shiftedCues().length > 0;
    const ducking = captionDucking
      ? Boolean(cueAt(shiftedCues(), time))
      : duck.checked && keepOriginal.checked && sourceAudible;
    const audioRowMap = audioRows();
    if (audios.length && audioMixBuffer && !audioMixDirty) {
      if (audioMixGain) audioMixGain.gain.value = ducking ? 0.35 : 1;
      if (playing) {
        if (audioMixNeedsStart || !audioMixSource) startAudioMix();
      } else {
        stopAudioMix();
      }
      for (const clip of audios) {
        clip.gain.gain.value = 0;
        if (!clip.element.paused) clip.element.pause();
      }
      warmNextVideo();
      return;
    }
    stopAudioMix();
    for (const clip of audios) {
      const length = audioClipLength(clip);
      const active = playing && time >= clip.offset && time < clip.offset + length && time < playbackEnd();
      const local = clipSourceTime(clip, time - clip.offset);
      const trackMuted = audioTrackMuted(audioRowMap.get(clip.id) ?? 0);
      const warm = clip.offset <= time + 5 && clip.offset + length >= time;
      const preload = warm ? 'auto' : 'metadata';
      if (clip.element.preload !== preload) clip.element.preload = preload;
      const ready = !needsEmbeddedAudio(clip.file, clip.tracks.length) ||
        (warm && ensureAudioSource(clip.element, clip.file, clip.sourceTrack ?? 0) && clip.element.readyState >= 1);
      if (!active || !ready) {
        clip.gain.gain.value = 0;
        if (!clip.element.paused) clip.element.pause();
        continue;
      }
      clip.gain.gain.value = clip.muted || trackMuted
        ? 0
        : Math.max(0, clip.volume) * audioTrackGain(audioRowMap.get(clip.id) ?? 0) * fadeGain(clip, time - clip.offset) *
          (ducking ? 0.35 : 1) * (previewMuted ? 0 : 1) * (previewVolume / 100);
      clip.element.volume = 1;
      const rate = speedAtSource(clip.retime, local);
      if (Math.abs(clip.element.playbackRate - rate) > 0.001) {
        clip.element.playbackRate = rate;
        if (clip.element.readyState >= 1) clip.element.currentTime = local;
      }
      if (clip.element.paused) {
        clip.element.currentTime = local;
        void clip.element.play().catch(() => undefined);
      } else if (force || Math.abs(clip.element.currentTime - local) > 0.2) {
        clip.element.currentTime = local;
      }
    }
    warmNextVideo();
  }

  function fadeGain(clip: AudioClip, inside: number): number {
    const length = audioClipLength(clip);

    let gain = 1;
    if (clip.fadeIn > 0) gain = Math.min(gain, inside / Math.min(clip.fadeIn, length / 2));
    if (clip.fadeOut > 0) gain = Math.min(gain, (length - inside) / Math.min(clip.fadeOut, length / 2));
    return Math.max(0, Math.min(1, gain));
  }

  function tick(): void {
    if (!playing) return;
    time = clock.time + (performance.now() - clock.at) / 1000;
    if (time >= previewEnd() - 0.02) {
      if (loopPlayback) {
        time = 0;
        clock = { at: performance.now(), time: 0 };
        stopAudioMix();
        audioMixNeedsStart = true;
        syncMedia(true);
        positionPlayhead();
        frame = requestAnimationFrame(tick);
        return;
      }
      time = previewEnd();
      pause();
      positionPlayhead();
      update();
      return;
    }
    syncMedia();
    positionPlayhead();
    keepPlayheadVisible();
    frame = requestAnimationFrame(tick);
  }

  function keepPlayheadVisible(): void {
    const viewportWidth = timelineViewportWidth || measureTimelineViewport();
    const playheadX = time * pps();
    const x = playheadX - scroll.scrollLeft;
    if (x < 0 || x > viewportWidth - 20) scroll.scrollLeft = playheadX - viewportWidth * 0.15;
  }

  function play(): void {
    if (previewEnd() <= 0.001) return;
    cancelAutoProxy();
    lastGpuRenderAt = 0;
    void ctx.resume();
    if (time >= previewEnd() - 0.05) time = 0;
    playing = true;
    audioMixNeedsStart = true;
    clock = { at: performance.now(), time };
    syncMedia(true);
    updateTransformOverlay();
    setPlayIcon(true);
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(tick);
  }

  function pause(): void {
    playing = false;
    stopAudioMix();
    preview.pause();
    originalSound.element.pause();
    for (const clip of audios) clip.element.pause();
    cancelAnimationFrame(frame);
    setPlayIcon(false);
    updateTransformOverlay();
    renderGpuPreview(activeVideo);
    if (recording) cancelVoiceover();
    scheduleAutoProxy();
  }

  function seekLight(at: number, keepVisible = true, scrub = false): void {
    lastGpuRenderAt = 0;
    time = Math.max(0, Math.min(timelineEnd(), at));
    clock = { at: performance.now(), time };
    stopAudioMix();
    audioMixNeedsStart = playing;
    syncMedia(true, scrub);
    positionPlayhead();
    if (keepVisible) keepPlayheadVisible();
    updateTransformOverlay();
  }

  function seek(at: number, keepVisible = true): void {
    seekLight(at, keepVisible);
    update();
  }

  function setPlayIcon(isPlaying: boolean): void {
    playButton.querySelector('[data-icon="play"]')?.classList.toggle('hidden', isPlaying);
    playButton.querySelector('[data-icon="pause"]')?.classList.toggle('hidden', !isPlaying);
    playButton.setAttribute('aria-label', isPlaying ? 'Pause' : 'Play');
  }

  playButton.addEventListener('click', () => (playing ? pause() : play()));
  skipBackButton.addEventListener('click', () => seek(Math.max(0, time - 5)));
  skipForwardButton.addEventListener('click', () => seek(time + 5));
  loopButton.addEventListener('click', () => {
    loopPlayback = !loopPlayback;
    loopButton.classList.toggle('active', loopPlayback);
    loopButton.setAttribute('aria-pressed', String(loopPlayback));
    status.textContent = loopPlayback ? 'Preview loops at the end.' : 'Preview stops at the end.';
  });
  const volumeIcon = muteButton.querySelector<SVGElement>('[data-icon="volume"]');
  const mutedIcon = muteButton.querySelector<SVGElement>('[data-icon="muted"]');
  const syncPreviewVolume = (): void => {
    const silent = previewMuted || previewVolume <= 0;
    volumeIcon?.classList.toggle('hidden', silent);
    mutedIcon?.classList.toggle('hidden', !silent);
    muteButton.classList.toggle('active', silent);
    muteButton.setAttribute('aria-pressed', String(silent));
    muteButton.title = silent ? 'Unmute the preview' : 'Mute the preview';
    muteButton.setAttribute('aria-label', muteButton.title);
    previewVolumeInput.value = String(Math.round(previewVolume));
    previewVolumeValue.textContent = `${Math.round(previewVolume)}%`;
  };
  syncPreviewVolume();
  muteButton.addEventListener('click', () => {
    if (previewMuted || previewVolume <= 0) {
      previewMuted = false;
      if (previewVolume <= 0) previewVolume = 100;
    } else {
      previewMuted = true;
    }
    syncPreviewVolume();
    applyOriginalVolume();
    syncMedia(true);
    status.textContent = previewMuted
      ? 'Preview muted.'
      : `Preview volume ${Math.round(previewVolume)}%.`;
  });
  previewVolumeInput.addEventListener('input', () => {
    previewVolume = Math.max(0, Math.min(100, Number(previewVolumeInput.value)));
    if (previewVolume > 0) previewMuted = false;
    syncPreviewVolume();
    applyOriginalVolume();
    status.textContent = previewVolume <= 0
      ? 'Preview muted.'
      : `Preview volume ${Math.round(previewVolume)}%.`;
  });
  safeToggle.addEventListener('click', () => {
    safeGuides = !safeGuides;
    safeToggle.classList.toggle('active', safeGuides);
    safeToggle.setAttribute('aria-pressed', String(safeGuides));
    updatePreviewFrame();
  });
  gridToggle.addEventListener('click', () => {
    compositionGridOn = !compositionGridOn;
    compositionGrid?.classList.toggle('hidden', !compositionGridOn);
    gridToggle.classList.toggle('active', compositionGridOn);
    gridToggle.setAttribute('aria-pressed', String(compositionGridOn));
  });
  stageSnapToggle.addEventListener('click', () => {
    stageSnapEnabled = !stageSnapEnabled;
    stageSnapToggle.classList.toggle('active', stageSnapEnabled);
    stageSnapToggle.setAttribute('aria-pressed', String(stageSnapEnabled));
    status.textContent = stageSnapEnabled ? 'Canvas snapping on.' : 'Canvas snapping off.';
  });
  qualitySelect.addEventListener('change', () => {
    previewQuality = qualitySelect.value === 'full' ? 'full' : qualitySelect.value === 'proxy' ? 'proxy' : 'auto';
    if (previewQuality === 'full') cancelAutoProxy();
    else scheduleAutoProxy();
    syncMedia(true);
    status.textContent = activeVideo?.proxy?.compatibility
      ? 'This clip uses a playable preview. Export uses the original.'
      : previewQuality === 'full'
        ? 'Preview uses the original media.'
        : previewQuality === 'proxy'
          ? 'Preview uses proxies when available.'
          : 'Preview picks the fastest source automatically.';
  });
  previewZoomSelect.addEventListener('change', () => {
    previewZoom = previewZoomSelect.value;
    const zoomed = previewZoom !== 'fit';
    stageWrap.classList.toggle('preview-zoomed', zoomed);
    fitStageToWorkspace();
    updateTransformOverlay();
  });
  const syncMaximizeButton = (): void => {
    maximizeButton.classList.toggle('active', previewMaximized);
    maximizeButton.setAttribute('aria-pressed', String(previewMaximized));
    maximizeButton.title = previewMaximized ? 'Restore the workspace (Esc)' : 'Maximize preview';
    maximizeButton.setAttribute('aria-label', maximizeButton.title);
    maximizeButton.querySelector('[data-maximize-icon]')?.classList.toggle('hidden', previewMaximized);
    maximizeButton.querySelector('[data-restore-icon]')?.classList.toggle('hidden', !previewMaximized);
  };
  const setPreviewMaximized = (value: boolean): void => {
    previewMaximized = value;
    editor.classList.toggle('preview-maximized', previewMaximized);
    syncMaximizeButton();
    requestAnimationFrame(() => {
      fitStageToWorkspace();
      updateTransformOverlay();
    });
  };
  maximizeButton.addEventListener('click', () => setPreviewMaximized(!previewMaximized));
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !previewMaximized || event.defaultPrevented || document.fullscreenElement) return;
    if (document.querySelector('[aria-modal="true"]:not(.hidden)')) return;
    event.preventDefault();
    setPreviewMaximized(false);
  });
  aspectSelect.addEventListener('change', () => {
    preset.value = aspectSelect.value;
    invalidateFingerprint();
    update();
    updateProjectBar();
  });
  const syncFullscreenButton = (): void => {
    const active = document.fullscreenElement === stageWrap;
    fullscreenButton.classList.toggle('active', active);
    fullscreenButton.title = active ? 'Exit full screen' : 'Full screen preview';
    fullscreenButton.setAttribute('aria-label', fullscreenButton.title);
  };
  fullscreenButton.addEventListener('click', () => {
    if (document.fullscreenElement === stageWrap) {
      void document.exitFullscreen().catch(() => undefined);
    } else {
      const request = stageWrap.requestFullscreen?.();
      if (request) {
        void request.catch(() => {
          status.textContent = 'Full screen preview is not available in this browser.';
        });
      } else {
        status.textContent = 'Full screen preview is not available in this browser.';
      }
    }
  });
  document.addEventListener('fullscreenchange', syncFullscreenButton);
  keepOriginal.addEventListener('change', () => { applyOriginalVolume(); update(); });
  originalVolume.addEventListener('input', () => {
    originalVolumeValue.textContent = `${originalVolume.value}%`;
    applyOriginalVolume();
  });

  // Seek by clicking or dragging on the ruler; drag empty lane space to marquee-select.
  let scrubFrame = 0;
  let scrubClientX = 0;

  /** A small magnetic pull toward clip edges while scrubbing the playhead. */
  function snapPlayhead(at: number): { time: number; at: number | null } {
    if (!snapEnabled) return { time: at, at: null };
    let best: { time: number; at: number | null } = { time: at, at: null };
    let distance = PLAYHEAD_SNAP_PX + 1;
    const consider = (edge: number): void => {
      const gap = Math.abs(at - edge) * pps();
      if (gap < distance) {
        distance = gap;
        best = { time: edge, at: edge };
      }
    };
    for (const clip of videos) {
      consider(clip.start);
      consider(clip.start + videoClipLength(clip));
    }
    for (const clip of audios) {
      consider(clip.offset);
      consider(clip.offset + audioClipLength(clip));
    }
    for (const cue of titles) {
      consider(cue.start);
      consider(cue.end);
    }
    for (const graphic of graphics) {
      consider(graphic.start);
      consider(graphic.end);
    }
    return distance <= PLAYHEAD_SNAP_PX ? best : { time: at, at: null };
  }

  function seekToClientX(clientX: number, scrub = false): void {
    const bounds = content.getBoundingClientRect();
    const raw = (clientX - bounds.left) / pps();
    const snapped = snapPlayhead(raw);
    seekLight(snapped.time, true, scrub);
    showSnap(snapped.at);
  }

  function seekFromPointer(clientX: number, immediate = false): void {
    scrubClientX = clientX;
    if (immediate) {
      if (scrubFrame) {
        cancelAnimationFrame(scrubFrame);
        scrubFrame = 0;
      }
      seekToClientX(clientX);
      return;
    }
    if (scrubFrame) return;
    scrubFrame = requestAnimationFrame(() => {
      scrubFrame = 0;
      seekToClientX(scrubClientX, true);
    });
  }

  function marqueeHits(left: number, top: number, right: number, bottom: number): ClipSelection[] {
    const hits: ClipSelection[] = [];
    const timeStart = left / pps();
    const timeEnd = right / pps();
    const videoTop = videoLane.offsetTop;
    for (const clip of videos) {
      if (videoTrackLocked(clip.track)) continue;
      const start = clip.start;
      const end = clip.start + videoClipLength(clip);
      if (end <= timeStart || start >= timeEnd) continue;
      const clipTop = videoTop + trackTopPad() + videoTrackTop(clip.track);
      const clipBottom = clipTop + videoTrackHeight(clip.track);
      if (clipBottom <= top || clipTop >= bottom) continue;
      hits.push({ kind: 'video', id: clip.id });
    }
    const rows = audioRows();
    const audioTop = audioLane.offsetTop;
    for (const clip of audios) {
      const row = rows.get(clip.id) ?? 0;
      if (audioTrackLocked(row)) continue;
      const start = clip.offset;
      const end = clip.offset + audioClipLength(clip);
      if (end <= timeStart || start >= timeEnd) continue;
      const clipTop = audioTop + trackTopPad() + audioTrackTop(row);
      const clipBottom = clipTop + audioTrackHeight(row);
      if (clipBottom <= top || clipTop >= bottom) continue;
      hits.push({ kind: 'audio', id: clip.id });
    }
    return hits;
  }

  function applyMarqueeSelection(hits: ClipSelection[], additive: boolean): void {
    syncClipSelection();
    const keys = new Set<string>(additive ? selectedClipKeys : []);
    for (const hit of hits) keys.add(clipSelectionKey(hit));
    selectedClipKeys = expandLinkedSelection(keys);
    const primary = hits.at(-1) ?? (additive ? selected : null);
    selected = primary ? { kind: primary.kind, id: primary.id } : null;
    selectionAnchor = selected ? clipSelectionKey(selected) : '';
  }

  function attachScrubber(target: HTMLElement): void {
    target.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || (event.target instanceof Element && event.target.closest('.vt-clip, .vt-cue'))) return;
      scrubbing = true;
      seekFromPointer(event.clientX, true);
      try { target.setPointerCapture(event.pointerId); } catch { /* synthetic or already released */ }
      const move = (moveEvent: PointerEvent) => seekFromPointer(moveEvent.clientX);
      const finish = (clientX: number | null): void => {
        target.removeEventListener('pointermove', move);
        target.removeEventListener('pointerup', up);
        target.removeEventListener('pointercancel', cancel);
        if (scrubFrame) {
          cancelAnimationFrame(scrubFrame);
          scrubFrame = 0;
        }
        scrubbing = false;
        if (clientX !== null) seekToClientX(clientX);
        showSnap(null);
        render();
        scheduleAutoProxy();
      };
      const up = (upEvent: PointerEvent) => {
        if (upEvent.pointerId !== event.pointerId) return;
        finish(upEvent.clientX);
      };
      const cancel = (cancelEvent: PointerEvent) => {
        if (cancelEvent.pointerId !== event.pointerId) return;
        finish(null);
      };
      target.addEventListener('pointermove', move);
      target.addEventListener('pointerup', up);
      target.addEventListener('pointercancel', cancel);
    });
  }

  attachScrubber(ruler);
  attachScrubber(captionLane);

  function attachMarquee(target: HTMLElement): void {
    target.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || (event.target instanceof Element && event.target.closest('.vt-clip, .vt-cue'))) return;
      const additive = event.ctrlKey || event.metaKey;
      const startX = event.clientX;
      const startY = event.clientY;
      let lastX = startX;
      let lastY = startY;
      let dragging = false;
      if (!additive) {
        clearClipSelection();
        selectedTitle = -1;
        selectedGraphic = -1;
        selectedSubtitleKey = '';
        paintClipSelection();
        renderInspector();
        updateTitleOverlay();
        updateGraphicOverlay();
        announceClipSelection();
      }
      try { target.setPointerCapture(event.pointerId); } catch { /* synthetic or already released */ }

      const updateMarquee = (): void => {
        const contentBounds = content.getBoundingClientRect();
        const left = Math.min(startX, lastX) - contentBounds.left;
        const right = Math.max(startX, lastX) - contentBounds.left;
        const top = Math.min(startY, lastY) - contentBounds.top;
        const bottom = Math.max(startY, lastY) - contentBounds.top;
        marquee.classList.remove('hidden');
        marquee.style.left = `${left}px`;
        marquee.style.top = `${top}px`;
        marquee.style.width = `${Math.max(0, right - left)}px`;
        marquee.style.height = `${Math.max(0, bottom - top)}px`;
        applyMarqueeSelection(marqueeHits(left, top, right, bottom), additive);
        selectedGraphic = -1;
        selectedTitle = -1;
        selectedSubtitleKey = '';
        paintClipSelection();
        updateTitleOverlay();
        updateGraphicOverlay();
        announceClipSelection();
      };

      const move = (moveEvent: PointerEvent) => {
        if (moveEvent.pointerId !== event.pointerId) return;
        lastX = moveEvent.clientX;
        lastY = moveEvent.clientY;
        if (!dragging && Math.hypot(lastX - startX, lastY - startY) < 4) return;
        dragging = true;
        updateMarquee();
      };

      const finish = (clientX: number | null): void => {
        target.removeEventListener('pointermove', move);
        target.removeEventListener('pointerup', up);
        target.removeEventListener('pointercancel', cancel);
        marquee.classList.add('hidden');
        if (dragging || clientX === null) {
          render();
          renderInspector();
          announceClipSelection();
          return;
        }
        seekToClientX(clientX);
        showSnap(null);
        render();
        announceClipSelection();
      };
      const up = (upEvent: PointerEvent) => {
        if (upEvent.pointerId !== event.pointerId) return;
        finish(upEvent.clientX);
      };
      const cancel = (cancelEvent: PointerEvent) => {
        if (cancelEvent.pointerId !== event.pointerId) return;
        finish(null);
      };

      target.addEventListener('pointermove', move);
      target.addEventListener('pointerup', up);
      target.addEventListener('pointercancel', cancel);
    });
  }

  attachMarquee(videoLane);
  attachMarquee(audioLane);

  let zoomFrame = 0;
  let zoomAnchor = { time: 0, x: 0 };
  function setZoom(level: number, anchorTime = time): void {
    if (!zoomFrame) {
      zoomAnchor = { time: anchorTime, x: anchorTime * pps() - scroll.scrollLeft };
      zoomFrame = requestAnimationFrame(() => {
        zoomFrame = 0;
        render();
        scroll.scrollLeft = zoomAnchor.time * pps() - zoomAnchor.x;
        scheduleDetailSync(80);
      });
    }
    zoomLevel = Math.max(1, Math.min(MAX_TIMELINE_ZOOM, level));
    zoom.value = String(Math.round((Math.log(zoomLevel) / Math.log(MAX_TIMELINE_ZOOM)) * 100));
  }
  zoom.addEventListener('input', () => setZoom(MAX_TIMELINE_ZOOM ** (Number(zoom.value) / 100)));
  $('zoom-in').addEventListener('click', () => setZoom(zoomLevel * 1.5));
  $('zoom-out').addEventListener('click', () => setZoom(zoomLevel / 1.5));
  scroll.addEventListener('wheel', (event) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    const bounds = content.getBoundingClientRect();
    setZoom(zoomLevel * (event.deltaY < 0 ? 1.2 : 1 / 1.2), (event.clientX - bounds.left) / pps());
  }, { passive: false });
  if ('ResizeObserver' in window) {
    let timelineResizeFrame = 0;
    let observedWidth = scroll.clientWidth;
    new ResizeObserver(() => {
      // Height-only changes (dragging the timeline divider) do not move time,
      // tracks, or filmstrips. Only a width change needs a timeline rebuild.
      const width = scroll.clientWidth;
      if (width === observedWidth) return;
      observedWidth = width;
      if (timelineResizeFrame) return;
      timelineResizeFrame = requestAnimationFrame(() => {
        timelineResizeFrame = 0;
        measureTimelineViewport();
        renderTimeline();
        update();
      });
    }).observe(scroll);
    new ResizeObserver(() => {
      fitStageToWorkspace();
      updateTransformOverlay();
      renderGpuPreview(activeVideo);
    }).observe(stageWrap);
    new ResizeObserver(() => {
      measureStageViewport();
      renderTextLayer();
      renderGraphicsPreview();
    }).observe(stage);
  }

  document.addEventListener('keydown', (event) => {
    if (root.classList.contains('hidden')) return;
    const target = event.target instanceof Element ? event.target as HTMLElement : null;
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key.toLowerCase() === 's') {
      event.preventDefault();
      void saveCurrentProject();
      return;
    }
    const deleteKey = event.key === 'Delete' || event.key === 'Backspace';
    const editing = target?.closest('input:not([type="range"]):not([type="checkbox"]), textarea, select, [contenteditable="true"], [role="textbox"]');
    if (editing) return;
    const splitKey = !mod && event.key.toLowerCase() === 's' && !target?.closest('[role="dialog"], [role="menu"]');
    if (target?.closest('button') && !deleteKey && !splitKey) return;
    if (deleteKey && target?.closest('[role="dialog"], [role="menu"]')) return;
    if (mod && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
    } else if (mod && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      redo();
    } else if (mod && event.key.toLowerCase() === 'd') {
      event.preventDefault();
      duplicateSelected();
    } else if (mod && event.key.toLowerCase() === 'c') {
      event.preventDefault();
      copySelected();
    } else if (mod && event.key.toLowerCase() === 'x') {
      event.preventDefault();
      cutSelected();
    } else if (mod && event.key.toLowerCase() === 'v') {
      event.preventDefault();
      pasteClipboard();
    } else if (mod) {
      return;
    } else if (event.key === ' ') {
      event.preventDefault();
      if (playing) pause();
      else play();
    } else if ((event.key === 'Delete' || event.key === 'Backspace') && (selected || selectedTitle >= 0 || selectedGraphic >= 0)) {
      event.preventDefault();
      if (selectedTitle >= 0) deleteTitle(selectedTitle);
      else if (selectedGraphic >= 0 && !selected) deleteGraphic(selectedGraphic);
      else if (event.shiftKey) rippleDeleteSelected();
      else removeSelected();
    } else if (event.key.toLowerCase() === 's') {
      event.preventDefault();
      splitAtPlayhead();
    } else if (event.key.toLowerCase() === 'q') {
      event.preventDefault();
      trimStartToPlayhead();
    } else if (event.key.toLowerCase() === 'w') {
      event.preventDefault();
      trimEndToPlayhead();
    } else if (event.key.toLowerCase() === 'n') {
      event.preventDefault();
      toggleSnap();
    } else if (event.key.toLowerCase() === 'l') {
      event.preventDefault();
      toggleLinkedClips();
    } else if (event.key.toLowerCase() === 'i') {
      event.preventDefault();
      setRangeIn();
    } else if (event.key.toLowerCase() === 'o') {
      event.preventDefault();
      setRangeOut();
    } else if (event.key.toLowerCase() === 'k' && selected?.kind === 'video') {
      event.preventDefault();
      const clip = videos.find((entry) => entry.id === selected!.id);
      if (clip) {
        const at = clipLocalTime(clip);
        const pose: AnimKey[] = ['scale', 'x', 'y', 'rotation'];
        const exists = pose.some((key) => keyframeNear(clip.animation[key], at, 0.000001));
        for (const key of pose) {
          if (exists) clip.animation[key] = withoutKeyframe(clip.animation[key], at);
          else clip.animation[key] = withKeyframe(clip.animation[key], at, animatedValue(clip, key), 'linear');
        }
        applyPreviewTransform(clip);
        render();
        commit();
        status.textContent = exists ? 'Removed the pose keyframe.' : 'Added a pose keyframe at the playhead.';
      }
    } else if (event.key.toLowerCase() === 'e' && selected?.kind === 'video') {
      event.preventDefault();
      ensureInspectorOpen();
      selectSideTab('effects');
    } else if (event.key.toLowerCase() === 't' && selected?.kind === 'video') {
      event.preventDefault();
      openVideoSections.add('transform');
      ensureInspectorOpen();
      selectSideTab('video');
    } else if (event.key === 'Home') {
      event.preventDefault();
      seek(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      seek(timelineEnd());
    } else if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      setZoom(zoomLevel * 1.4);
    } else if (event.key === '-') {
      event.preventDefault();
      setZoom(zoomLevel / 1.4);
    } else if (event.altKey && selected?.kind === 'video' && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      event.preventDefault();
      const clip = videos.find((entry) => entry.id === selected!.id);
      if (clip) {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          clip.start = Math.max(0, clip.start + (event.key === 'ArrowLeft' ? -1 : 1));
        } else {
          clip.track = Math.max(0, Math.min(videoTrackCount - 1, clip.track + (event.key === 'ArrowUp' ? -1 : 1)));
        }
        render();
        commit();
      }
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      seek(time + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 1 : 5));
    } else if (event.key === 'Escape' && recording) {
      event.preventDefault();
      cancelVoiceover();
    }
  });

  // Captions -----------------------------------------------------------------
  async function loadCaptionFile(file: File): Promise<void> {
    if (captionTrackState.locked) return;
    let parsed: Cue[] = [];
    // The captions panel is often collapsed, so import problems also go to
    // the editor status line where the user is looking.
    const reportCaptionError = (message: string): void => {
      captionStatus.textContent = message;
      status.textContent = message;
      status.classList.add('text-rose-300');
      window.setTimeout(() => status.classList.remove('text-rose-300'), 6000);
    };
    try {
      parsed = parseCaptions(await file.text());
    } catch (error) {
      reportCaptionError(`Could not import ${file.name}: ${errorMessage(error)} The current captions were kept.`);
      return;
    }
    if (captionTrackState.locked) return;
    if (!parsed.length) {
      reportCaptionError(`${file.name} has no readable cues. Check that it is a valid SRT or WebVTT file. The current captions were kept.`);
      return;
    }
    fileCues = parsed;
    captionFileName = file.name;
    captionSource.value = 'file';
    updateCaptions();
    commit();
    status.textContent = `${parsed.length} caption cue${parsed.length === 1 ? '' : 's'} imported from ${file.name}.`;
  }

  function updateCaptions(): void {
    invalidateShiftedCues();
    captionLaneKey = '';
    const list = cues();
    const none = captionSource.value === 'none';
    const burn = captionMode.value === 'burn';
    captionMode.disabled = none;
    captionOffsetInput.disabled = none;
    captionPosition.disabled = none || !burn;
    captionSize.disabled = none || !burn;
    captionDownload.disabled = !list.length;
    if (captionSource.value === 'transcript') {
      captionStatus.textContent = list.length
        ? `${list.length} cues from the current transcript.`
        : 'No transcript yet. Transcribe the video in Audio to text first.';
    } else if (captionSource.value === 'file') {
      captionStatus.textContent = list.length
        ? `${list.length} cues${captionFileName ? ` from ${captionFileName}` : ''}.`
        : 'No caption file loaded yet.';
    } else if (captionSource.value === 'embedded') {
      captionStatus.textContent = list.length
        ? `${list.length} cues from embedded subtitle tracks.`
        : 'Select a video clip and import an embedded track from its File inspector.';
    } else {
      captionStatus.textContent = '';
    }
    render();
  }
  captionSource.addEventListener('change', () => {
    if (captionSource.value === 'file' && !fileCues) {
      captionFile.click();
      return;
    }
    updateCaptions();
    commit();
  });
  captionFile.addEventListener('change', () => {
    const [file] = takeFiles(captionFile);
    if (file) void loadCaptionFile(file);
    else if (!fileCues) {
      captionSource.value = 'none';
      updateCaptions();
      commit();
    }
  });
  captionMode.addEventListener('change', () => {
    updateCaptions();
    commit();
  });
  for (const preset of CAPTION_PRESETS) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'video-title-preset video-caption-preset';
    card.dataset.captionPreset = preset.id;
    const sample = document.createElement('canvas');
    sample.width = 480;
    sample.height = 170;
    sample.setAttribute('aria-hidden', 'true');
    const context = sample.getContext('2d');
    if (context) {
      context.translate(0, -136);
      drawCaption(context, 'See you tomorrow.', 480, 270, presetCaptionStyle(preset.id));
    }
    const label = document.createElement('strong');
    label.textContent = preset.label;
    card.append(sample, label);
    card.addEventListener('click', () => {
      if (captionTrackState.locked || captionPreset === preset.id) return;
      captionPreset = preset.id;
      if (preset.id !== 'default') captionMode.value = 'burn';
      updateCaptions();
      commit('Changed subtitle preset');
    });
    captionPresetButtons.push(card);
  }
  captionPresetGrid.append(...captionPresetButtons);
  captionOffsetInput.addEventListener('input', () => {
    const value = Number(captionOffsetInput.value);
    captionOffset = Number.isFinite(value) ? value : 0;
    invalidateShiftedCues();
    captionLaneKey = '';
    positionPlayhead();
    renderCaptionLane(pps());
    update();
  });
  captionOffsetInput.addEventListener('change', () => commit('Changed caption offset'));
  captionPosition.addEventListener('change', () => { positionPlayhead(); commit(); });
  captionSize.addEventListener('change', () => { positionPlayhead(); commit(); });
  captionDownload.addEventListener('click', () => {
    const list = shiftedCues();
    if (!list.length) return;
    options.download(new Blob([toSrt(list)], { type: 'application/x-subrip' }), 'captions.srt');
  });

  // Video-track overlays (titles and shapes) --------------------------------
  function graphicTrackIndex(graphic: GraphicClip): number {
    const track = Number(graphic.track);
    return Number.isFinite(track) ? Math.max(0, Math.round(track)) : 0;
  }

  function overlayTrackBusy(track: number, start: number, end: number, ignore?: Cue): boolean {
    if (videos.some((clip) =>
      clip.track === track &&
      clip.start < end - 0.001 &&
      clip.start + videoClipLength(clip) > start + 0.001)) return true;
    if (titles.some((cue) =>
      cue !== ignore &&
      Number.isFinite(cue.track) &&
      titleTrackIndex(cue) === track &&
      cue.start < end - 0.001 &&
      cue.end > start + 0.001)) return true;
    return graphics.some((graphic) =>
      Number.isFinite(graphic.track) &&
      graphicTrackIndex(graphic) === track &&
      graphic.start < end - 0.001 &&
      graphic.end > start + 0.001);
  }

  function firstFreeOverlayTrack(start: number, end: number, ignore?: Cue): number {
    for (let track = 0; track < videoTrackCount; track += 1) {
      if (!videoTrackLocked(track) && !overlayTrackBusy(track, start, end, ignore)) return track;
    }
    videoTrackCount += 1;
    ensureTrackStates(videoTrackCount, audioTrackCount);
    return videoTrackCount - 1;
  }

  function normalizeOverlayTracks(): void {
    for (const cue of titles) {
      if (Number.isFinite(cue.track)) cue.track = Math.max(0, Math.round(Number(cue.track)));
      else cue.track = firstFreeOverlayTrack(cue.start, cue.end, cue);
    }
    for (const graphic of graphics) {
      if (Number.isFinite(graphic.track)) graphic.track = Math.max(0, Math.round(Number(graphic.track)));
      else graphic.track = firstFreeOverlayTrack(graphic.start, graphic.end);
    }
    videoTrackCount = Math.max(
      1,
      videoTrackCount,
      ...titles.map((cue) => titleTrackIndex(cue) + 1),
      ...graphics.map((graphic) => graphicTrackIndex(graphic) + 1),
    );
    ensureTrackStates(videoTrackCount, audioTrackCount);
  }

  function addTitleAtPlayhead(text = 'Your title', seconds = 3, at = time, track?: number, presetId?: string): void {
    const start = Math.max(0, at);
    const available = Math.max(0, playbackEnd() - start);
    const duration = available > 0.5
      ? Math.max(0.5, Math.min(Math.max(0.2, seconds), available))
      : Math.max(0.5, seconds);
    const titleTrack = track === undefined
      ? firstFreeOverlayTrack(start, start + duration)
      : Math.max(0, Math.round(track));
    if (titleTrack >= videoTrackCount) {
      videoTrackCount = titleTrack + 1;
      ensureTrackStates(videoTrackCount, audioTrackCount);
    }
    const preset = findTitlePreset(presetId);
    titles.push({
      start, end: start + duration, text, style: preset ? titlePresetStyle(preset) : defaultTitleTextStyle(), track: titleTrack,
      ...(preset ? { titlePreset: preset.id } : {}),
    });
    selected = null;
    selectedTitle = titles.length - 1;
    selectedSubtitleKey = '';
    selectedGraphic = -1;
    invalidateShiftedCues();
    selectSideTab('text');
    ensureInspectorOpen();
    updateGraphicOverlay();
    renderTimeline();
    seek(start);
    renderTitlePanel();
    commit('Added title');
    status.textContent = 'Title added. Edit it in the inspector.';
  }

  function deleteTitle(index: number): void {
    const cue = titles[index];
    if (!cue) return;
    if (videoTrackLocked(titleTrackIndex(cue))) {
      lockedNotice();
      return;
    }
    titles.splice(index, 1);
    selectedTitle = titles.length ? Math.min(index, titles.length - 1) : -1;
    invalidateShiftedCues();
    captionLaneKey = '';
    renderTimeline();
    renderTitlePanel();
    seek(Math.min(time, timelineEnd()));
    commit('Deleted title');
    status.textContent = 'Deleted title.';
  }

  function deleteGraphic(index: number): void {
    const graphic = graphics[index];
    if (!graphic) return;
    if (videoTrackLocked(graphicTrackIndex(graphic))) {
      lockedNotice();
      return;
    }
    graphics.splice(index, 1);
    selectedGraphic = graphics.length ? Math.min(index, graphics.length - 1) : -1;
    graphicsPreviewKey = '';
    renderGraphicsPreview();
    renderTimeline();
    renderGraphicsPanel();
    seek(Math.min(time, timelineEnd()));
    commit('Deleted graphic overlay');
    status.textContent = 'Deleted shape.';
  }

  /** Split the selected title at the playhead; returns false when no title is selected. */
  function splitTitleAtPlayhead(): boolean {
    const cue = selected ? null : titles[selectedTitle];
    if (!cue) return false;
    if (videoTrackLocked(titleTrackIndex(cue))) {
      lockedNotice();
      return true;
    }
    if (time <= cue.start + 0.05 || time >= cue.end - 0.05) {
      status.textContent = 'Move the playhead inside the selected title to split it.';
      return true;
    }
    const tail: Cue = {
      ...cue,
      start: time,
      style: cue.style ? { ...cue.style } : undefined,
    };
    cue.end = time;
    titles.splice(selectedTitle + 1, 0, tail);
    selectedTitle += 1;
    invalidateShiftedCues();
    renderTimeline();
    renderTitlePanel();
    commit('Split title');
    status.textContent = 'Title split at the playhead.';
    return true;
  }

  function deleteSelection(): void {
    if (selectedTitle >= 0 && !selected) deleteTitle(selectedTitle);
    else if (selectedGraphic >= 0 && !selected) deleteGraphic(selectedGraphic);
    else removeSelected();
  }

  function beginTitleLengthDrag(event: PointerEvent, cue: Cue, index: number, edge: 'start' | 'end'): void {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    selectedTitle = index;
    selected = null;
    selectedGraphic = -1;
    selectSideTab('text');
    ensureInspectorOpen();
    renderTitlePanel();
    renderGraphicBlocks(pps());
    updateGraphicOverlay();
    if (videoTrackLocked(titleTrackIndex(cue))) {
      lockedNotice();
      return;
    }
    const startX = event.clientX;
    const originStart = cue.start;
    const originEnd = cue.end;
    const move = (moveEvent: PointerEvent): void => {
      if (moveEvent.pointerId !== event.pointerId) return;
      const delta = (moveEvent.clientX - startX) / pps();
      if (edge === 'start') cue.start = Math.max(0, Math.min(originEnd - 0.2, originStart + delta));
      else cue.end = Math.max(originStart + 0.2, originEnd + delta);
      invalidateShiftedCues();
      captionLaneKey = '';
      renderTimeline();
      positionPlayhead();
      renderTitlePanel();
    };
    const up = (upEvent: PointerEvent): void => {
      if (upEvent.pointerId !== event.pointerId) return;
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', up);
      renderTitlePanel();
      commit('Resized title');
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
  }

  function currentTextStyleTarget(): {
    kind: 'title' | 'subtitle';
    style: TextObjectStyle;
    label: string;
    assign: (style: TextObjectStyle) => void;
  } | null {
    const cue = selectedTitle >= 0 ? titles[selectedTitle] : null;
    if (cue) {
      return {
        kind: 'title',
        style: ensureTitleStyle(cue),
        label: 'Title',
        assign: (style) => { cue.style = style; },
      };
    }
    if (selectedSubtitleKey && !captionTrackState.locked) {
      const embedded = selectedEmbeddedCue;
      const source = embedded && captionSource.value === 'embedded'
        ? videos.find((clip) => clip.id === embedded.clipId)?.embeddedCaptions : undefined;
      if (captionPreset === 'default' && source?.assScript && embedded && subtitleStyleKey(source.cues[embedded.index]?.text ?? '') === selectedSubtitleKey) {
        return null;
      }
      const key = selectedSubtitleKey;
      return {
        kind: 'subtitle',
        style: ensureSubtitleStyle(key),
        label: `Subtitle · ${key.length > 26 ? `${key.slice(0, 26)}…` : key}`,
        assign: (style) => { subtitleStyles[key] = style; },
      };
    }
    return null;
  }

  function syncTextStyleEditor(): void {
    const target = currentTextStyleTarget();
    if (!target) {
      textStyleEditor.classList.add('hidden');
      textStyleTarget.textContent = '';
      return;
    }
    const style = target.style;
    textStyleEditor.classList.remove('hidden');
    textStyleTarget.textContent = target.label;
    ensureFontOption(style.fontFamily);
    textFont.value = style.fontFamily;
    refreshFontTrigger();
    textSize.value = String(style.fontSize);
    textWeight.value = String(style.fontWeight);
    textAlign.value = style.align;
    textColor.value = style.color;
    textX.value = String(style.x);
    textY.value = String(style.y);
    textMaxWidth.value = String(style.maxWidth);
    textRotation.value = String(style.rotation);
    textItalic.checked = style.italic;
    textUppercase.checked = style.uppercase;
    textLineHeight.value = String(style.lineHeight);
    textOutlineWidth.value = String(style.outlineWidth);
    textOutlineColor.value = style.outlineColor;
    textShadowBlur.value = String(style.shadowBlur);
    textShadowX.value = String(style.shadowX);
    textShadowY.value = String(style.shadowY);
    textShadowColor.value = style.shadowColor;
    textBackground.value = style.background;
    textBackgroundOpacity.value = String(Math.round(style.backgroundOpacity * 100));
    textPadding.value = String(style.padding);
    textRadius.value = String(style.radius);
    const isTitle = target.kind === 'title';
    titleDetails.classList.toggle('hidden', !isTitle);
    textSoftNote.classList.toggle('hidden', isTitle);
    if (isTitle) {
      titleAccent.value = style.accent ?? '';
      titleAccentColor.value = style.accentColor ?? style.color;
      titleAccentColor.disabled = !style.accent;
      titleDetailLine.value = style.detailLine ?? '';
      titleDetailScale.value = String(Math.round((style.detailScale ?? 0.55) * 100));
      titleDetailColor.value = style.detailColor ?? style.color;
      titleDetailScale.disabled = titleDetailColor.disabled = !style.detailLine;
    }
  }

  function applyTextStyleInputs(commitChange: boolean): void {
    const target = currentTextStyleTarget();
    if (!target) return;
    const fallback = target.kind === 'title' ? defaultTitleTextStyle() : subtitleBaseStyle();
    const next = normalizeTextStyle({
      ...target.style,
      fontFamily: textFont.value,
      fontSize: Number(textSize.value),
      fontWeight: Number(textWeight.value),
      italic: textItalic.checked,
      uppercase: textUppercase.checked,
      color: textColor.value,
      align: textAlign.value as TextObjectStyle['align'],
      x: Number(textX.value),
      y: Number(textY.value),
      maxWidth: Number(textMaxWidth.value),
      rotation: Number(textRotation.value),
      lineHeight: Number(textLineHeight.value),
      outlineWidth: Number(textOutlineWidth.value),
      outlineColor: textOutlineColor.value,
      shadowBlur: Number(textShadowBlur.value),
      shadowX: Number(textShadowX.value),
      shadowY: Number(textShadowY.value),
      shadowColor: textShadowColor.value,
      background: textBackground.value,
      backgroundOpacity: Number(textBackgroundOpacity.value) / 100,
      padding: Number(textPadding.value),
      radius: Number(textRadius.value),
      ...(target.kind === 'title' ? {
        accent: (titleAccent.value || undefined) as TitleAccent | undefined,
        accentColor: titleAccentColor.value,
        detailLine: titleDetailLine.value === 'first' || titleDetailLine.value === 'last' ? titleDetailLine.value : undefined,
        detailScale: Number(titleDetailScale.value) / 100,
        detailColor: titleDetailColor.value,
      } : {}),
    }, fallback);
    target.assign(next);
    if (target.kind === 'title') {
      titleAccentColor.disabled = !next.accent;
      titleDetailScale.disabled = titleDetailColor.disabled = !next.detailLine;
    }
    invalidateFingerprint();
    renderTextLayer();
    if (!commitChange) return;
    updateProjectBar();
    if (target.kind === 'title') commit('Styled title');
    else status.textContent = 'Subtitle style updated.';
  }

  function allFontChoices(): TextFontOption[] {
    return installedFontChoices.length ? [...TEXT_FONT_OPTIONS, ...installedFontChoices] : TEXT_FONT_OPTIONS;
  }

  function ensureFontOption(value: string): void {
    if (!value) return;
    if ([...textFont.options].some((option) => option.value === value)) return;
    const known = allFontChoices().find((font) => font.value === value);
    textFont.add(new Option(known?.label ?? fontLabelFromValue(value), value));
  }

  function refreshFontTrigger(): void {
    const selected = textFont.selectedOptions[0];
    fontCurrent.textContent = selected?.textContent?.trim() || fontLabelFromValue(textFont.value);
    fontCurrent.title = fontCurrent.textContent;
    fontOpen.title = `${fontCurrent.textContent}: choose a font`;
    fontAa.style.fontFamily = textFont.value || TEXT_FONT_OPTIONS[0].value;
  }

  function populateFontSelect(): void {
    const previous = textFont.value;
    textFont.replaceChildren(...allFontChoices().map((font) => new Option(font.label, font.value)));
    if (previous) ensureFontOption(previous);
    textFont.value = previous || TEXT_FONT_OPTIONS[0].value;
    refreshFontTrigger();
  }

  function fontPreviewText(): string {
    const cue = selectedTitle >= 0 ? titles[selectedTitle] : null;
    const raw = cue?.text ?? selectedSubtitleKey ?? 'Your title';
    const line = raw.split(/\r?\n/)[0]?.trim() || 'Your title';
    return line.length > 64 ? `${line.slice(0, 64)}…` : line;
  }

  function renderFontCategoryChips(): void {
    const counts = new Map<string, number>();
    for (const font of allFontChoices()) counts.set(font.category, (counts.get(font.category) ?? 0) + 1);
    const categories: Array<TextFontCategory | 'All'> = ['All', 'Sans', 'Serif', 'Display', 'Handwriting', 'Mono'];
    if (installedFontChoices.length) categories.push('Installed');
    fontCategories.replaceChildren(...categories.map((category) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'video-font-chip' + (activeFontCategory === category ? ' active' : '');
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', String(activeFontCategory === category));
      const count = category === 'All' ? allFontChoices().length : counts.get(category) ?? 0;
      button.textContent = `${category} ${count}`;
      button.addEventListener('click', () => {
        activeFontCategory = category;
        renderFontPicker();
      });
      return button;
    }));
  }

  function renderFontPicker(): void {
    const query = fontSearch.value.trim().toLowerCase();
    const choices = allFontChoices();
    const filtered = choices.filter((font) =>
      (activeFontCategory === 'All' || font.category === activeFontCategory) &&
      (!query || font.label.toLowerCase().includes(query) || font.category.toLowerCase().includes(query)));
    const target = currentTextStyleTarget();
    const weight = target?.style.fontWeight ?? 700;
    const italic = target?.style.italic ?? false;
    const sample = fontPreviewText();
    fontLoad.textContent = installedFontChoices.length ? 'Reload installed fonts' : 'Load installed fonts';
    renderFontCategoryChips();
    fontCount.textContent = `${filtered.length} of ${choices.length} families${installedFontChoices.length ? ` · ${installedFontChoices.length} installed famil${installedFontChoices.length === 1 ? 'y' : 'ies'}` : ''}`;
    fontList.replaceChildren();
    if (!filtered.length) {
      const empty = document.createElement('p');
      empty.className = 'video-font-empty';
      empty.textContent = 'No fonts match this search. Try another name or category.';
      fontList.append(empty);
      return;
    }
    for (const font of filtered) {
      const choice = document.createElement('button');
      choice.type = 'button';
      choice.className = 'video-font-choice' + (font.value === textFont.value ? ' active' : '');
      choice.setAttribute('role', 'option');
      choice.setAttribute('aria-selected', String(font.value === textFont.value));
      choice.style.fontFamily = font.value;
      choice.style.fontWeight = String(weight);
      choice.style.fontStyle = italic ? 'italic' : 'normal';
      const name = document.createElement('span');
      name.className = 'video-font-choice-name';
      name.textContent = font.label;
      const preview = document.createElement('span');
      preview.className = 'video-font-choice-sample';
      preview.textContent = sample;
      const badge = document.createElement('span');
      badge.className = 'video-font-badge';
      badge.textContent = font.installed ? 'Installed' : font.category;
      choice.append(name, preview, badge);
      choice.title = `${font.label} · ${font.category}`;
      choice.addEventListener('click', () => applyFontChoice(font.value));
      fontList.append(choice);
    }
  }

  function openFontPicker(): void {
    if (!currentTextStyleTarget()) return;
    fontSearch.value = '';
    activeFontCategory = 'All';
    fontLoad.classList.toggle('hidden', !canLoadInstalledFonts());
    if (installedFontChoices.length) {
      const count = installedFontChoices.length;
      fontStatus.textContent = `${count} installed famil${count === 1 ? 'y is' : 'ies are'} available. Previews render locally.`;
    } else if (!canLoadInstalledFonts()) {
      fontStatus.textContent = 'This browser lists the built-in families. Chrome or Edge can also load fonts installed on this device.';
    } else {
      fontStatus.textContent = 'Fonts render locally. Load installed fonts to see every family on this device.';
    }
    if (!fontDialog.open) fontDialog.showModal();
    fontOpen.setAttribute('aria-expanded', 'true');
    renderFontPicker();
    fontSearch.focus({ preventScroll: true });
    setTimeout(() => {
      if (fontDialog.open && document.activeElement !== fontSearch) fontSearch.focus({ preventScroll: true });
    }, 50);
  }

  function applyFontChoice(value: string): void {
    ensureFontOption(value);
    textFont.value = value;
    refreshFontTrigger();
    textFont.dispatchEvent(new Event('change', { bubbles: true }));
    if (fontDialog.open) fontDialog.close();
  }

  async function loadFontsFromDevice(): Promise<void> {
    if (fontLoadBusy) return;
    fontLoadBusy = true;
    fontLoad.disabled = true;
    fontStatus.textContent = 'Requesting installed fonts…';
    try {
      const fonts = await loadInstalledFontChoices();
      installedFontChoices = fonts;
      populateFontSelect();
      renderFontPicker();
      fontStatus.textContent = fonts.length
        ? `${fonts.length} installed famil${fonts.length === 1 ? 'y' : 'ies'} added. Previews are rendered from fonts on this device.`
        : 'No additional installed families were found. The built-in families are still available.';
    } catch (error) {
      const name = error instanceof DOMException ? error.name : '';
      fontStatus.textContent = name === 'NotAllowedError' || name === 'SecurityError'
        ? 'Permission to read installed fonts was denied. The built-in families still work.'
        : `Installed fonts could not be loaded: ${errorMessage(error)}`;
    } finally {
      fontLoadBusy = false;
      fontLoad.disabled = false;
    }
  }

  const openAssSections = new Set(['Typography']);
  let copiedAssStyle: { file: File; script: string; appearance: NonNullable<ReturnType<typeof readAssCueStyle>> } | undefined;

  function renderEmbeddedCueEditor(): void {
    embeddedCueEditor.replaceChildren();
    embeddedCueEditor.classList.add('hidden');
    const target = selectedEmbeddedCue;
    if (captionTrackState.locked || !target || !selectedSubtitleKey || captionSource.value !== 'embedded') return;
    const clip = videos.find((item) => item.id === target.clipId);
    const captions = clip?.embeddedCaptions;
    const cue = captions?.cues[target.index];
    if (!clip || !captions || !cue || subtitleStyleKey(cue.text) !== selectedSubtitleKey) return;
    const script = captions.assScript;
    const appearance = script && captionPreset === 'default' ? readAssCueStyle(script, cue) : null;
    const current = () => {
      const source = clip.embeddedCaptions;
      const activeCue = source?.cues[target.index];
      return source && activeCue?.assLine === cue.assLine && activeCue
        ? { source, activeCue }
        : null;
    };
    const write = (next: typeof cue, action: string, refresh = true): void => {
      const active = current();
      if (captionTrackState.locked || !active) return;
      const cues = [...active.source.cues];
      cues[target.index] = next;
      clip.embeddedCaptions = { ...active.source, cues };
      selectedSubtitleKey = subtitleStyleKey(next.text);
      if (refresh) updateCaptions();
      else {
        invalidateShiftedCues();
        renderTextLayer();
      }
      commit(action);
    };

    const label = document.createElement('label');
    label.className = 'sfield';
    const caption = document.createElement('span');
    caption.className = 'field-label';
    caption.textContent = 'Subtitle text';
    const input = document.createElement('textarea');
    input.className = 'select video-caption-editor-input';
    input.rows = 3;
    input.value = cue.text;
    input.addEventListener('change', () => {
      const text = input.value.trim();
      const active = current();
      if (!active || !text || text === active.activeCue.text) {
        input.value = active?.activeCue.text ?? cue.text;
        return;
      }
      const next = { ...active.activeCue, text };
      if (next.assEdits?.raw !== undefined) {
        next.assEdits = { ...next.assEdits, raw: assDialogueWithText(next.assEdits.raw, text) };
      }
      write(next, 'Edited embedded subtitle');
    });
    label.append(caption, input);
    const header = document.createElement('div');
    header.className = 'video-caption-inspector-head';
    const heading = document.createElement('strong');
    heading.textContent = 'Caption';
    const source = document.createElement('span');
    source.textContent = captions.stream.title || `Track ${captions.stream.index + 1}`;
    header.append(heading, source);
    const timing = shiftedCues().find((item) => {
      const embedded = item as Partial<EmbeddedTimelineCue>;
      return embedded.embeddedClipId === target.clipId && embedded.embeddedCueIndex === target.index;
    });
    const range = document.createElement('div');
    range.className = 'video-caption-time-range';
    if (timing) range.textContent = `${formatClock(timing.start, true)} – ${formatClock(timing.end, true)}`;
    embeddedCueEditor.append(header, range, label);
    if (script && appearance) {
      const canPaste = () => copiedAssStyle?.file === clip.file && copiedAssStyle.script === script;
      embeddedCueEditor.append(renderAssInspector({
        ...appearance,
        open: openAssSections,
        changed: Boolean(cue.assEdits),
        canPaste: canPaste(),
        onEdit: (edit) => {
          const active = current()?.activeCue;
          if (!active) return;
          write({
            ...active,
            assEdits: {
              ...active.assEdits,
              ...(edit.style ? { style: { ...active.assEdits?.style, ...edit.style } } : {}),
              ...(edit.event ? { event: { ...active.assEdits?.event, ...edit.event } } : {}),
            },
          }, 'Styled embedded subtitle', false);
        },
        onRaw: (raw) => {
          const active = current()?.activeCue;
          const text = plainAssText(raw);
          if (!active || !text || /[\r\n]/.test(raw)) return false;
          write({ ...active, text, assEdits: { ...active.assEdits, raw } }, 'Edited ASS overrides');
          return true;
        },
        onCopy: () => {
          const active = current()?.activeCue;
          const selected = active && readAssCueStyle(script, active);
          if (selected) copiedAssStyle = { file: clip.file, script, appearance: selected };
        },
        onPaste: () => {
          const active = current()?.activeCue;
          if (!active || !copiedAssStyle || !canPaste()) return;
          const copied = copiedAssStyle.appearance;
          write({
            ...active,
            assEdits: {
              style: copied.style,
              event: copied.event,
              raw: assDialogueWithText(copied.raw, active.text),
            },
          }, 'Pasted ASS subtitle style');
        },
        onReset: () => {
          const active = current()?.activeCue;
          if (!active) return;
          write({ ...active, assEdits: undefined }, 'Reset ASS subtitle appearance');
        },
      }));
    }
    embeddedCueEditor.classList.remove('hidden');
  }

  function renderTitlePanel(): void {
    titleList.replaceChildren();
    renderEmbeddedCueEditor();
    const showTitleList = !selectedSubtitleKey;
    titleList.hidden = !showTitleList;
    if (showTitleList && !titles.length) {
      const empty = document.createElement('p');
      empty.className = 'text-[10px] leading-relaxed text-slate-500';
      empty.textContent = 'Generate a title from the library, then select a title or subtitle block on the timeline to edit it.';
      titleList.append(empty);
    } else if (showTitleList) {
      titles.forEach((cue, index) => {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'video-title-item' + (index === selectedTitle ? ' active' : '');
        const text = document.createElement('span');
        text.textContent = cue.text.trim() || 'Untitled';
        const at = document.createElement('small');
        at.textContent = `V${titleTrackIndex(cue) + 1} · ${formatClock(cue.start, true)}`;
        row.append(text, at);
        row.addEventListener('click', () => {
          selected = null;
          selectedTitle = index;
          selectedSubtitleKey = '';
          selectedGraphic = -1;
          seek(cue.start);
          updateGraphicOverlay();
          captionLaneKey = '';
          renderCaptionLane(pps());
          renderTitleBlocks(pps());
          renderGraphicBlocks(pps());
          renderTitlePanel();
        });
        titleList.append(row);
      });
    }
    const cue = selectedTitle >= 0 ? titles[selectedTitle] : null;
    titleSummary.classList.toggle('hidden', !cue);
    if (!cue) {
      titleEditor.classList.add('hidden');
      syncTextStyleEditor();
      return;
    }
    const summaryKicker = document.createElement('span');
    summaryKicker.className = 'eyebrow';
    summaryKicker.textContent = 'Title';
    const summaryName = document.createElement('strong');
    summaryName.textContent = cue.text.trim() || 'Untitled';
    const summaryMeta = document.createElement('small');
    summaryMeta.textContent = `V${titleTrackIndex(cue) + 1} · ${formatClock(cue.start, true)} → ${formatClock(cue.end, true)}`;
    titleSummary.replaceChildren(summaryKicker, summaryName, summaryMeta);
    titleEditor.classList.remove('hidden');
    if (document.activeElement !== titleText) titleText.value = cue.text;
    if (document.activeElement !== titleStart) titleStart.value = String(Number(cue.start.toFixed(2)));
    if (document.activeElement !== titleDuration) {
      titleDuration.value = String(Number((cue.end - cue.start).toFixed(2)));
    }
    const trackCount = Math.max(videoTrackCount, titleTrackIndex(cue) + 1);
    if (titleTrackSelect.options.length !== trackCount) {
      titleTrackSelect.replaceChildren(...Array.from({ length: trackCount }, (_, index) => new Option(`V${index + 1}`, String(index))));
    }
    titleTrackSelect.value = String(titleTrackIndex(cue));
    syncTextStyleEditor();
  }

  titleAdd.addEventListener('click', () => addTitleAtPlayhead());
  function addTitlePreset(id: string, at = time, track?: number): void {
    const preset = findTitlePreset(id);
    if (preset) addTitleAtPlayhead(preset.text, preset.seconds, at, track, preset.id);
  }

  const titlePresetButtons = TITLE_PRESETS.map((preset) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'video-title-preset';
    card.draggable = true;
    card.dataset.titlePreset = preset.id;
    card.dataset.titleGroup = preset.group;
    const thumbnail = document.createElement('canvas');
    thumbnail.width = 480;
    thumbnail.height = 270;
    thumbnail.setAttribute('aria-hidden', 'true');
    const name = document.createElement('strong');
    name.textContent = preset.name;
    card.append(thumbnail, name);
    card.addEventListener('click', () => addTitlePreset(preset.id));
    return card;
  });
  let titleThumbnailsReady = false;
  function drawTitlePresetThumbnails(): void {
    if (titleThumbnailsReady) return;
    titleThumbnailsReady = true;
    for (const [index, preset] of TITLE_PRESETS.entries()) {
      const canvas = titlePresetButtons[index].querySelector('canvas');
      const context = canvas?.getContext('2d');
      if (canvas && context) drawCaption(context, preset.text, canvas.width, canvas.height, titlePresetStyle(preset));
    }
  }
  titlePresetGrid.append(...titlePresetButtons);
  if (activeLibrary === 'text') drawTitlePresetThumbnails();
  titlePresetFilter.replaceChildren(new Option('All presets', ''), ...TITLE_PRESET_GROUPS.map((group) => new Option(group, group)));
  titlePresetFilter.addEventListener('change', () => {
    for (const card of titlePresetButtons) card.hidden = Boolean(titlePresetFilter.value && card.dataset.titleGroup !== titlePresetFilter.value);
  });
  populateFontSelect();
  for (const control of [
    textFont, textSize, textWeight, textAlign, textColor, textX, textY, textMaxWidth,
    textRotation, textItalic, textUppercase, textLineHeight, textOutlineWidth, textOutlineColor,
    textShadowBlur, textShadowX, textShadowY, textShadowColor, textBackground,
    textBackgroundOpacity, textPadding, textRadius,
    titleAccent, titleAccentColor, titleDetailLine, titleDetailScale, titleDetailColor,
  ]) {
    control.addEventListener('input', () => applyTextStyleInputs(false));
    control.addEventListener('change', () => applyTextStyleInputs(true));
  }
  textFont.addEventListener('change', refreshFontTrigger);
  fontOpen.addEventListener('click', openFontPicker);
  fontOpen.setAttribute('aria-expanded', 'false');
  fontClose.addEventListener('click', () => fontDialog.close());
  fontDialog.addEventListener('close', () => fontOpen.setAttribute('aria-expanded', 'false'));
  fontDialog.addEventListener('click', (event) => {
    if (event.target === fontDialog) fontDialog.close();
  });
  fontSearch.addEventListener('input', renderFontPicker);
  fontSearch.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    fontList.querySelector<HTMLButtonElement>('.video-font-choice')?.click();
  });
  fontLoad.addEventListener('click', () => void loadFontsFromDevice());
  new MutationObserver(() => {
    if (root.classList.contains('hidden') && fontDialog.open) fontDialog.close();
  }).observe(root, { attributes: true, attributeFilter: ['class'] });
  textStyleReset.addEventListener('click', () => {
    const target = currentTextStyleTarget();
    if (!target) return;
    const preset = target.kind === 'title' ? findTitlePreset(titles[selectedTitle]?.titlePreset) : undefined;
    if (target.kind === 'subtitle') delete subtitleStyles[selectedSubtitleKey];
    else target.assign(preset ? titlePresetStyle(preset) : defaultTitleTextStyle());
    invalidateFingerprint();
    syncTextStyleEditor();
    renderTextLayer();
    updateProjectBar();
    if (target.kind === 'title') commit('Reset title style');
    status.textContent = 'Text style reset.';
  });
  titleText.addEventListener('input', () => {
    const cue = titles[selectedTitle];
    if (!cue) return;
    cue.text = titleText.value;
    invalidateShiftedCues();
    const entry = titleBlockEntries.get(cue);
    if (entry) updateTitleBlock(entry, selectedTitle, pps());
    else renderTitleBlocks(pps());
    positionPlayhead();
    updateTitleOverlay();
  });
  titleText.addEventListener('change', () => {
    renderTitlePanel();
    commit('Edited title');
  });
  const updateTitleTiming = (): void => {
    const cue = titles[selectedTitle];
    if (!cue) return;
    const start = Math.max(0, Number(titleStart.value) || 0);
    const duration = Math.max(0.2, Number(titleDuration.value) || 0.2);
    cue.start = start;
    cue.end = start + duration;
    invalidateShiftedCues();
    layoutTitleTimeline(cue, selectedTitle);
    updateTitleOverlay();
  };
  titleStart.addEventListener('input', updateTitleTiming);
  titleDuration.addEventListener('input', updateTitleTiming);
  titleStart.addEventListener('change', () => commit('Moved title'));
  titleDuration.addEventListener('change', () => commit('Resized title'));
  titleTrackSelect.addEventListener('change', () => {
    const cue = titles[selectedTitle];
    if (!cue) return;
    const track = Math.max(0, Number(titleTrackSelect.value) || 0);
    if (videoTrackLocked(track)) {
      lockedNotice();
      renderTitlePanel();
      return;
    }
    cue.track = track;
    invalidateShiftedCues();
    renderTimeline();
    renderTitlePanel();
    commit('Moved title to another track');
  });
  // Graphic overlays ---------------------------------------------------------
  const rgbaColor = (hex: string, alpha: number): string => {
    const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
    if (!match) return `rgba(0, 0, 0, ${alpha})`;
    return `rgba(${Number.parseInt(match[1], 16)}, ${Number.parseInt(match[2], 16)}, ${Number.parseInt(match[3], 16)}, ${alpha})`;
  };

  function updateTextPreviewOpacity(): void {
    for (const entry of textPreviewEntries) {
      const opacity = overlayTransitionOpacity(entry.cue.start, entry.cue.end, entry.cue.transition, time) *
        (entry.titleIndex >= 0 ? videoTrackOpacity(entry.titleIndex) : 1);
      if (opacity !== entry.lastOpacity) {
        entry.lastOpacity = opacity;
        entry.anchor.style.opacity = String(opacity);
      }
    }
  }

  interface AssPreviewState {
    file: Blob;
    script: string;
    cues: AssSegment['cues'];
    canvas: HTMLCanvasElement;
    surface?: ReturnType<typeof createAssSurface>;
    pending?: { time: number; width: number; height: number };
    painting: boolean;
    failed: boolean;
    visible: boolean;
    lastFrame?: string;
  }
  let assPreview: AssPreviewState | null = null;

  function clearAssPreview(): void {
    if (!assPreview) return;
    assPreview.surface?.dispose();
    assPreview.canvas.remove();
    assPreview = null;
  }

  function paintAssPreview(state: AssPreviewState): void {
    if (!state.pending || !state.surface || state.painting || state.failed || state !== assPreview) return;
    const { time: at, width, height } = state.pending;
    state.pending = undefined;
    const frameKey = `${at.toFixed(3)}:${width}:${height}`;
    if (frameKey === state.lastFrame) return;
    state.lastFrame = frameKey;
    state.painting = true;
    void state.surface.paint(at, width, height).then(() => {
      if (state === assPreview && state.visible) state.canvas.style.visibility = 'visible';
    }).catch((error) => {
      if (state !== assPreview) return;
      state.failed = true;
      state.canvas.style.visibility = 'hidden';
      status.textContent = `Styled subtitle preview unavailable: ${errorMessage(error)}`;
      renderTextLayer();
    }).finally(() => {
      state.painting = false;
      paintAssPreview(state);
    });
  }

  function updateAssPreview(width: number, height: number): boolean {
    const segments = styledAssSegments();
    if (!segments.length) {
      clearAssPreview();
      return false;
    }
    const segment = assSegmentAt(segments, time);
    if (!segment || width < 20 || height < 20) {
      if (assPreview) {
        assPreview.pending = undefined;
        assPreview.visible = false;
        assPreview.canvas.style.visibility = 'hidden';
        assPreview.lastFrame = undefined;
      }
      return false;
    }
    if (!assPreview || assPreview.file !== segment.file || assPreview.script !== segment.script || assPreview.cues !== segment.cues) {
      clearAssPreview();
      const canvas = document.createElement('canvas');
      canvas.className = 'video-ass-subtitles';
      canvas.setAttribute('aria-hidden', 'true');
      canvas.style.visibility = 'hidden';
      stage.append(canvas);
      const state: AssPreviewState = {
        file: segment.file, script: segment.script, cues: segment.cues, canvas, painting: false, failed: false, visible: true,
      };
      assPreview = state;
      void import('./video-ass-renderer').then(({ createAssSurface }) => {
        if (state !== assPreview) return;
        state.surface = createAssSurface(canvas, segment);
        paintAssPreview(state);
      }).catch((error) => {
        if (state !== assPreview) return;
        state.failed = true;
        status.textContent = `Styled subtitle preview unavailable: ${errorMessage(error)}`;
        renderTextLayer();
      });
    }
    assPreview.visible = true;
    assPreview.pending = {
      time: segment.sourceStart + (time - segment.start) * segment.speed, width, height,
    };
    paintAssPreview(assPreview);
    return !assPreview.failed;
  }

  function renderTextLayer(): void {
    const stageWidth = previewStageWidth();
    const stageHeight = previewStageHeight();
    const ass = updateAssPreview(stageWidth, stageHeight);
    const active = styledOverlayCues().filter((cue) =>
      time >= cue.start && time < cue.end && !(ass && (cue as Partial<EmbeddedTimelineCue>).assStyled));
    const key = active.map((cue) => {
      const style = cue.style ?? subtitleBaseStyle();
      const titleIndex = titles.indexOf(cue);
      return `${titleIndex}|${cue.text}|${cue.start}|${cue.end}|${cue.transition}|${style.fontFamily}|${style.fontSize}|${style.fontWeight}|${style.italic}|${style.uppercase}|${style.color}|${style.align}|${style.x}|${style.y}|${style.maxWidth}|${style.rotation}|${style.lineHeight}|${style.outlineWidth}|${style.outlineColor}|${style.shadowBlur}|${style.shadowColor}|${style.shadowX}|${style.shadowY}|${style.background}|${style.backgroundOpacity}|${style.padding}|${style.radius}|${style.accent}|${style.accentColor}|${style.detailLine}|${style.detailScale}|${style.detailColor}`;
    }).join('||') + `|${stageWidth}x${stageHeight}`;
    if (key === textPreviewKey) {
      updateTextPreviewOpacity();
      return;
    }
    textPreviewKey = key;
    textLayer.replaceChildren();
    textPreviewEntries = [];
    if (!active.length || stageWidth < 20 || stageHeight < 20) return;
    const refScale = stageHeight / 720;
    for (const cue of active) {
      const titleIndex = titles.indexOf(cue);
      const isTitle = titleIndex >= 0;
      const style = normalizeTextStyle(cue.style, isTitle ? defaultTitleTextStyle() : subtitleBaseStyle());
      const anchor = document.createElement('div');
      anchor.className = 'video-text-anchor';
      anchor.style.left = `${style.x}%`;
      anchor.style.top = `${style.y}%`;
      anchor.style.transform = `rotate(${style.rotation}deg)`;
      if (isTitle) anchor.dataset.titleIndex = String(titleIndex);
      const width = (stageWidth * style.maxWidth) / 100;
      const outer = document.createElement('div');
      outer.className = 'video-text-object' + (isTitle ? ' is-title' : '');
      outer.style.left = style.align === 'left' ? '0' : style.align === 'right' ? `${-width}px` : `${-width / 2}px`;
      outer.style.top = '0';
      outer.style.width = `${width}px`;
      outer.style.textAlign = style.align;
      outer.style.transform = 'translateY(-50%)';
      const box = document.createElement('span');
      box.className = 'video-text-box';
      box.style.fontFamily = style.fontFamily;
      box.style.fontSize = `${Math.max(8, Math.min(stageWidth, stageHeight * 1.4) * (style.fontSize / 100))}px`;
      box.style.fontWeight = String(style.fontWeight);
      box.style.fontStyle = style.italic ? 'italic' : 'normal';
      box.style.color = style.color;
      box.style.lineHeight = String(style.lineHeight);
      box.style.padding = `${style.padding * refScale}px`;
      box.style.borderRadius = `${style.radius * refScale}px`;
      if (style.backgroundOpacity > 0.001) {
        box.style.background = rgbaColor(style.background, style.backgroundOpacity);
      }
      if (style.outlineWidth > 0.01) {
        box.style.webkitTextStroke = `${style.outlineWidth * refScale}px ${style.outlineColor}`;
      }
      if (style.shadowBlur > 0.01 || style.shadowX || style.shadowY) {
        box.style.textShadow = `${style.shadowX * refScale}px ${style.shadowY * refScale}px ${style.shadowBlur * refScale}px ${style.shadowColor}`;
      }
      const content = style.uppercase ? cue.text.toUpperCase() : cue.text;
      const parts = titleTextParts(content, style);
      if (parts.length === 1) {
        box.textContent = content;
      } else {
        for (const part of parts) {
          const line = document.createElement('span');
          line.className = 'video-title-line';
          line.textContent = part.text;
          if (part.detail) {
            line.style.fontSize = ((style.detailScale ?? 0.55) * 100) + '%';
            line.style.color = style.detailColor ?? style.color;
          }
          box.append(line);
        }
      }
      if (style.accent && style.accentColor) {
        box.dataset.titleAccent = style.accent;
        box.style.setProperty('--title-accent-color', style.accentColor);
        box.style.setProperty('--title-accent-width', titleAccentThickness(refScale) + 'px');
      }
      if (isTitle) {
        outer.addEventListener('pointerdown', (event) => {
          if (event.button !== 0 || playing) return;
          beginTitlePreviewDrag(event, titleIndex, 'move');
        });
      }
      outer.append(box);
      anchor.append(outer);
      textLayer.append(anchor);
      textPreviewEntries.push({ anchor, cue, titleIndex, lastOpacity: -1 });
    }
    updateTextPreviewOpacity();
    updateTitleOverlay();
  }

  function updateGraphicsPreviewOpacity(): void {
    for (const entry of graphicsPreviewEntries) {
      const opacity = entry.graphic.opacity *
        overlayTransitionOpacity(entry.graphic.start, entry.graphic.end, entry.graphic.transition, time) *
        videoTrackOpacity(graphicTrackIndex(entry.graphic));
      if (opacity !== entry.lastOpacity) {
        entry.lastOpacity = opacity;
        entry.el.style.opacity = String(opacity);
      }
    }
  }

  function styleGraphicPreviewElement(el: HTMLElement, graphic: GraphicClip): void {
    const stageWidth = previewStageWidth();
    const stageHeight = previewStageHeight();
    el.style.left = `${graphic.x}%`;
    el.style.top = `${graphic.y}%`;
    el.style.width = `${graphic.width}%`;
    el.style.transform = `rotate(${graphic.rotation}deg)`;
    el.style.display = '';
    el.style.background = 'transparent';
    el.style.border = '0';
    el.style.borderRadius = '0';
    el.style.backgroundImage = '';
    el.style.backgroundSize = '';
    el.textContent = '';
    if (graphic.kind === 'line') {
      el.style.height = `${Math.max(2, graphic.strokeWidth)}px`;
      el.style.background = graphic.stroke || graphic.fill;
      el.style.transform = `translateY(-50%) rotate(${graphic.rotation}deg)`;
    } else if (graphic.kind === 'svg') {
      el.style.height = `${graphic.height}%`;
      const svgSource = safeSvgSource(graphic.svg);
      el.style.backgroundImage = svgSource ? `url("${svgSource}")` : '';
      el.style.backgroundPosition = 'center';
      el.style.backgroundRepeat = 'no-repeat';
      el.style.backgroundSize = 'contain';
    } else if (graphic.kind === 'emoji') {
      const emoji = graphic.emoji ?? '🙂';
      const sprite = emojiSpriteUrl(emoji);
      el.style.height = `${graphic.height}%`;
      if (sprite) {
        el.style.backgroundImage = `url("${sprite}")`;
        el.style.backgroundPosition = 'center';
        el.style.backgroundRepeat = 'no-repeat';
        el.style.backgroundSize = 'contain';
      } else {
        el.textContent = emoji;
        el.style.display = 'grid';
        el.style.placeItems = 'center';
        el.style.fontFamily = '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
        el.style.fontSize = `${Math.max(8, Math.min((graphic.width / 100) * stageWidth, (graphic.height / 100) * stageHeight) * 0.92)}px`;
        el.style.lineHeight = '1';
      }
    } else {
      el.style.height = `${graphic.height}%`;
      el.style.backgroundColor = graphic.fill;
      const gradient = graphicGradientCss(graphic);
      const pattern = graphicPatternCss(
        graphic.pattern,
        graphic.patternColor || '#ffffff',
        (graphic.patternScale ?? 14) * (stageHeight / 720),
      );
      const images = [pattern?.image, gradient].filter(Boolean) as string[];
      if (images.length) {
        el.style.backgroundImage = images.join(', ');
        const sizes = [pattern?.size, gradient ? 'auto' : ''].filter(Boolean) as string[];
        if (sizes.length) el.style.backgroundSize = sizes.join(', ');
      }
      el.style.borderRadius = graphic.kind === 'ellipse' ? '50%' : `${graphic.radius}px`;
      if (graphic.strokeWidth > 0) {
        el.style.border = `${Math.max(1, graphic.strokeWidth)}px solid ${graphic.stroke}`;
      }
    }
  }

  function renderGraphicsPreview(): void {
    const active = graphics.filter((graphic) =>
      !videoTrackHidden(graphicTrackIndex(graphic)) &&
      time >= graphic.start && time < graphic.end);
    const stageWidth = previewStageWidth();
    const stageHeight = previewStageHeight();
    const key = active.map((graphic) => [
      graphic.id, graphic.kind, graphic.x, graphic.y, graphic.width, graphic.height,
      graphic.rotation, graphic.fill, graphic.fill2, graphic.fillType, graphic.gradientAngle,
      graphic.pattern, graphic.patternColor, graphic.patternScale, graphic.svg ? 1 : 0, graphic.emoji,
      graphic.name, graphic.stroke, graphic.strokeWidth,
      graphic.radius, graphic.transition,
    ].join(':')).join('|') + `|selected:${selectedGraphic}:${selected?.id ?? ''}|stage:${stageWidth}x${stageHeight}`;
    const entriesMatch = graphicsPreviewEntries.length === active.length &&
      graphicsPreviewEntries.every((entry, index) => entry.graphic === active[index]);
    if (key === graphicsPreviewKey && entriesMatch) {
      updateGraphicsPreviewOpacity();
      updateGraphicOverlay();
      return;
    }
    graphicsPreviewKey = key;
    graphicsLayer.replaceChildren();
    graphicsPreviewEntries = [];
    for (const graphic of active) {
      const index = graphics.indexOf(graphic);
      const el = document.createElement('div');
      el.className = `video-graphic video-graphic-${graphic.kind}` + (index === selectedGraphic && !selected ? ' selected' : '');
      styleGraphicPreviewElement(el, graphic);
      el.addEventListener('pointerdown', (event) => {
        if (event.button !== 0 || playing) return;
        beginGraphicDrag(event, graphic, 'move', '');
      });
      graphicsLayer.append(el);
      graphicsPreviewEntries.push({ el, graphic, lastOpacity: -1 });
    }
    updateGraphicsPreviewOpacity();
    updateGraphicOverlay();
  }

  function beginGraphicLengthDrag(event: PointerEvent, graphic: GraphicClip, edge: 'start' | 'end'): void {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    selectedGraphic = graphics.indexOf(graphic);
    if (selectedGraphic < 0) return;
    selected = null;
    selectedTitle = -1;
    selectSideTab('graphics');
    ensureInspectorOpen();
    renderGraphicsPanel();
    renderTitleBlocks(pps());
    updateGraphicOverlay();
    if (videoTrackLocked(graphicTrackIndex(graphic))) {
      lockedNotice();
      return;
    }
    const startX = event.clientX;
    const originStart = graphic.start;
    const originEnd = graphic.end;
    const move = (moveEvent: PointerEvent): void => {
      if (moveEvent.pointerId !== event.pointerId) return;
      const delta = (moveEvent.clientX - startX) / pps();
      if (edge === 'start') graphic.start = Math.max(0, Math.min(originEnd - 0.2, originStart + delta));
      else graphic.end = Math.max(originStart + 0.2, originEnd + delta);
      graphicsPreviewKey = '';
      layoutGraphicTimeline();
      syncGraphicTimingInputs(graphic);
      updateGraphicOverlay();
    };
    const up = (upEvent: PointerEvent): void => {
      if (upEvent.pointerId !== event.pointerId) return;
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', up);
      renderGraphicsPanel();
      renderGraphicsPreview();
      updateGraphicOverlay();
      commit('Resized graphic overlay');
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
  }

  function activateGraphic(index: number, seekTo = true): void {
    const graphic = graphics[index];
    if (!graphic) return;
    selectedGraphic = index;
    selected = null;
    selectedTitle = -1;
    selectedSubtitleKey = '';
    if (seekTo) seek(graphic.start);
    selectSideTab('graphics');
    ensureInspectorOpen();
    renderGraphicsPanel();
    renderGraphicBlocks(pps());
    renderTitleBlocks(pps());
    graphicsPreviewKey = '';
    renderGraphicsPreview();
    updateGraphicOverlay();
  }

  function beginGraphicTimelineDrag(event: PointerEvent, block: HTMLElement, graphic: GraphicClip, index: number): void {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    block.focus({ preventScroll: true });
    selectedGraphic = index;
    selected = null;
    selectedTitle = -1;
    selectedSubtitleKey = '';
    clearSelection(block);
    selectSideTab('graphics');
    ensureInspectorOpen();
    if (time < graphic.start || time >= graphic.end) seek(graphic.start);
    renderGraphicsPanel();
    renderTitleBlocks(pps());
    updateGraphicOverlay();
    if (videoTrackLocked(graphicTrackIndex(graphic))) {
      lockedNotice();
      return;
    }
    const origin = {
      x: event.clientX,
      y: event.clientY,
      start: graphic.start,
      end: graphic.end,
      scrollLeft: scroll.scrollLeft,
    };
    let dragging = false;
    const apply = (clientX: number, clientY: number): void => {
      const deltaPx = clientX - origin.x + (scroll.scrollLeft - origin.scrollLeft);
      if (!dragging && Math.hypot(deltaPx, clientY - origin.y) < 5) return;
      dragging = true;
      block.classList.add('dragging');
      const length = origin.end - origin.start;
      graphic.start = Math.max(0, origin.start + deltaPx / pps());
      graphic.end = graphic.start + length;
      const laneTop = videoLane.getBoundingClientRect().top + trackTopPad();
      const targetTrack = Math.max(0, trackAtOffset(clientY - laneTop, videoTrackHeights, videoRowHeight(), videoTrackCount));
      if (targetTrack >= videoTrackCount) {
        videoTrackCount = targetTrack + 1;
        ensureTrackStates(videoTrackCount, audioTrackCount);
        status.textContent = `New video track V${videoTrackCount} created.`;
      }
      graphic.track = targetTrack;
      block.style.left = `${graphic.start * pps()}px`;
      block.style.width = `${Math.max(12, length * pps() - 2)}px`;
      block.style.top = `${trackTopPad() + videoTrackTop(targetTrack)}px`;
      block.style.height = `${videoTrackHeight(targetTrack)}px`;
      layoutVideoLane();
      positionPlayhead();
      renderGraphicsPanel();
      graphicsPreviewKey = '';
      renderGraphicsPreview();
      updateGraphicOverlay();
    };
    const move = (moveEvent: PointerEvent): void => {
      if (moveEvent.pointerId !== event.pointerId) return;
      apply(moveEvent.clientX, moveEvent.clientY);
    };
    const up = (upEvent: PointerEvent): void => {
      if (upEvent.pointerId !== event.pointerId) return;
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', up);
      if (dragging) {
        renderTimeline();
        commit('Moved graphic overlay');
      }
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
  }

  function createGraphicBlock(graphic: GraphicClip): GraphicBlockEntry {
    const el = document.createElement('div');
    el.className = 'vt-clip vt-clip-graphic';
    el.dataset.graphicId = String(graphic.id);
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
    const badge = document.createElement('span');
    badge.className = 'vt-graphic-badge';
    const labelEl = document.createElement('span');
    labelEl.className = 'vt-clip-label';
    el.append(badge, labelEl);
    const entry: GraphicBlockEntry = {
      el, graphic, index: -1, badge, labelEl,
      geometryKey: '', classKey: '', label: '', aria: '', title: '', ariaPressed: '',
    };
    const startHandle = document.createElement('span');
    startHandle.className = 'vt-gen-handle start';
    startHandle.title = 'Drag to change the shape start';
    startHandle.addEventListener('pointerdown', (event) => beginGraphicLengthDrag(event, entry.graphic, 'start'));
    const endHandle = document.createElement('span');
    endHandle.className = 'vt-gen-handle end';
    endHandle.title = 'Drag to change the shape end';
    endHandle.addEventListener('pointerdown', (event) => beginGraphicLengthDrag(event, entry.graphic, 'end'));
    el.append(startHandle, endHandle);
    el.addEventListener('pointerdown', (event) => {
      const index = graphics.indexOf(entry.graphic);
      if (index >= 0) beginGraphicTimelineDrag(event, el, entry.graphic, index);
    });
    el.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        event.stopPropagation();
        const index = graphics.indexOf(entry.graphic);
        if (index >= 0) activateGraphic(index);
      }
    });
    return entry;
  }

  function updateGraphicBlock(entry: GraphicBlockEntry, index: number, scale: number): void {
    const graphic = entry.graphic;
    const block = entry.el;
    const track = graphicTrackIndex(graphic);
    graphic.track = track;
    const selectedNow = index === selectedGraphic && !selected && selectedTitle < 0;
    const hiddenNow = videoTrackHidden(track);
    const lockedNow = videoTrackLocked(track);
    const trackColor = videoTrackState[track]?.color;
    const classKey = `${selectedNow ? 1 : 0}${hiddenNow ? 1 : 0}${lockedNow ? 1 : 0}${trackColor ? 1 : 0}`;
    if (entry.classKey !== classKey) {
      entry.classKey = classKey;
      block.classList.toggle('selected', selectedNow);
      block.classList.toggle('is-hidden', hiddenNow);
      block.classList.toggle('locked', lockedNow);
      block.classList.toggle('has-track-color', Boolean(trackColor));
    }
    const pressed = String(selectedNow);
    if (entry.ariaPressed !== pressed) {
      entry.ariaPressed = pressed;
      block.setAttribute('aria-pressed', pressed);
    }
    const name = graphicDisplayName(graphic);
    const label = `${name} · ${formatClock(graphic.end - graphic.start)}`;
    if (entry.label !== label) {
      entry.label = label;
      entry.labelEl.textContent = label;
    }
    const aria = `${name} at ${formatClock(graphic.start, true)}`;
    if (entry.aria !== aria) {
      entry.aria = aria;
      block.setAttribute('aria-label', aria);
    }
    const title = `${name}\nDrag to move across video tracks · drag the edges to trim · Del removes it`;
    if (entry.title !== title) {
      entry.title = title;
      block.title = title;
    }
    const badge = graphic.kind === 'emoji'
      ? (graphic.emoji ?? '🙂')
      : graphic.kind === 'svg'
        ? 'S'
        : graphic.kind === 'line'
          ? '╱'
          : graphic.kind === 'ellipse'
            ? '◯'
            : '▭';
    if (entry.badge.textContent !== badge) entry.badge.textContent = badge;
    const top = trackTopPad() + videoTrackTop(track);
    const height = videoTrackHeight(track);
    const width = Math.max(12, (graphic.end - graphic.start) * scale - 2);
    const geometryKey = `${index}|${graphic.start}|${graphic.end}|${scale}|${top}|${height}|${trackColor ?? ''}`;
    if (entry.geometryKey !== geometryKey) {
      entry.geometryKey = geometryKey;
      block.dataset.graphicIndex = String(index);
      block.style.left = `${graphic.start * scale}px`;
      block.style.top = `${top}px`;
      block.style.height = `${height}px`;
      block.style.width = `${width}px`;
      if (trackColor) block.style.setProperty('--track-color', trackColor);
      else block.style.removeProperty('--track-color');
    }
  }

  function renderGraphicBlocks(scale: number): void {
    const range = timelineWindow(scale);
    const visible = new Set<number>();
    for (const [index, graphic] of graphics.entries()) {
      if (graphic.end <= 0 || graphic.start >= contentEnd() + 0.05) continue;
      if (!inTimelineWindow(graphic.start, graphic.end, range, index === selectedGraphic && !selected)) continue;
      visible.add(graphic.id);
      let entry = graphicBlockEntries.get(graphic.id);
      if (!entry) {
        entry = createGraphicBlock(graphic);
        graphicBlockEntries.set(graphic.id, entry);
        videoLane.append(entry.el);
      } else if (entry.graphic !== graphic) {
        entry.graphic = graphic;
      }
      updateGraphicBlock(entry, index, scale);
    }
    for (const [id, entry] of graphicBlockEntries) {
      if (visible.has(id)) continue;
      entry.el.remove();
      graphicBlockEntries.delete(id);
    }
  }

  /** Update graphic placement and timing without rebuilding every timeline block. */
  function layoutGraphicTimeline(): void {
    invalidateTimelineDerived();
    const scale = pps();
    for (const graphic of graphics) {
      const entry = graphicBlockEntries.get(graphic.id);
      if (!entry) continue;
      const block = entry.el;
      const track = graphicTrackIndex(graphic);
      block.style.left = `${graphic.start * scale}px`;
      block.style.top = `${trackTopPad() + videoTrackTop(track)}px`;
      block.style.height = `${videoTrackHeight(track)}px`;
      block.style.width = `${Math.max(12, (graphic.end - graphic.start) * scale - 2)}px`;
      const label = `${graphicDisplayName(graphic)} · ${formatClock(graphic.end - graphic.start)}`;
      if (entry.label !== label) {
        entry.label = label;
        entry.labelEl.textContent = label;
      }
      const aria = `${graphicDisplayName(graphic)} at ${formatClock(graphic.start, true)}`;
      if (entry.aria !== aria) {
        entry.aria = aria;
        block.setAttribute('aria-label', aria);
      }
      entry.geometryKey = '';
    }
    const length = timelineLength();
    content.style.width = `${Math.ceil(length * scale)}px`;
    renderRuler(scale, length);
    positionPlayhead();
  }

  function graphicDisplayName(graphic: GraphicClip): string {
    if (graphic.kind === 'emoji') return `${graphic.emoji ?? '🙂'} Emoji`;
    if (graphic.name) return graphic.name;
    return graphicLabel(graphic.kind);
  }

  function renderGraphicsPanel(): void {
    graphicList.replaceChildren();
    if (!graphics.length) {
      const empty = document.createElement('p');
      empty.className = 'text-[10px] leading-relaxed text-slate-500';
      empty.textContent = 'Add a shape, pattern, gradient, SVG, or emoji from the library, then select it on the timeline to edit it.';
      graphicList.append(empty);
      graphicEditor.classList.add('hidden');
      return;
    }
    if (selectedGraphic < 0 || selectedGraphic >= graphics.length) {
      graphicSummary.classList.add('hidden');
      graphicEditor.classList.add('hidden');
      return;
    }
    graphicSummary.classList.remove('hidden');
    const summaryGraphic = graphics[selectedGraphic];
    const summaryKicker = document.createElement('span');
    summaryKicker.className = 'eyebrow';
    summaryKicker.textContent = summaryGraphic.kind === 'svg' ? 'SVG' : summaryGraphic.kind === 'emoji' ? 'Emoji' : 'Shape';
    const summaryName = document.createElement('strong');
    summaryName.textContent = graphicDisplayName(summaryGraphic);
    const summaryMeta = document.createElement('small');
    summaryMeta.textContent = `V${graphicTrackIndex(summaryGraphic) + 1} · ${formatClock(summaryGraphic.start, true)} → ${formatClock(summaryGraphic.end, true)}`;
    graphicSummary.replaceChildren(summaryKicker, summaryName, summaryMeta);
    graphics.forEach((graphic, index) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'video-graphic-item' + (index === selectedGraphic ? ' active' : '');
      const name = document.createElement('span');
      name.textContent = graphicDisplayName(graphic);
      const at = document.createElement('small');
      at.textContent = `V${graphicTrackIndex(graphic) + 1} · ${formatClock(graphic.start, true)}`;
      row.append(name, at);
      row.addEventListener('click', () => activateGraphic(index));
      graphicList.append(row);
    });
    const graphic = graphics[selectedGraphic];
    graphicEditor.classList.remove('hidden');
    const isPaintable = graphic.kind === 'rect' || graphic.kind === 'ellipse' || graphic.kind === 'line';
    graphicPaintFields.classList.toggle('hidden', !isPaintable);
    graphicSpecialNote.classList.toggle('hidden', isPaintable);
    if (!isPaintable) {
      graphicSpecialNote.textContent = graphic.kind === 'svg'
        ? `${graphic.name || 'SVG'} keeps its own colours. Use position, size, rotation, opacity, and timing below.`
        : `${graphic.emoji ?? 'Emoji'}: use position, size, rotation, opacity, and timing below.`;
    }
    const hasPattern = (graphic.pattern ?? 'none') !== 'none';
    graphicPatternFields.classList.toggle('hidden', !hasPattern);
    const fields: [HTMLInputElement | HTMLSelectElement, string][] = [
      [graphicFill, graphic.fill === 'transparent' ? '#000000' : graphic.fill],
      [graphicFill2, graphic.fill2 || '#22d3ee'],
      [graphicFillType, graphic.fillType ?? 'solid'],
      [graphicGradientAngle, String(Math.round(graphic.gradientAngle ?? 90))],
      [graphicPattern, graphic.pattern ?? 'none'],
      [graphicPatternColor, graphic.patternColor || '#ffffff'],
      [graphicPatternScale, String(Math.round(graphic.patternScale ?? 14))],
      [graphicStroke, graphic.stroke && graphic.stroke !== 'transparent' ? graphic.stroke : '#ffffff'],
      [graphicStrokeWidth, String(graphic.strokeWidth)],
      [graphicOpacity, String(Math.round(graphic.opacity * 100))],
      [graphicRotation, String(Math.round(graphic.rotation))],
      [graphicX, String(Math.round(graphic.x))],
      [graphicY, String(Math.round(graphic.y))],
      [graphicWidth, String(Math.round(graphic.width))],
      [graphicHeight, String(Math.round(graphic.height))],
      [graphicStart, String(Number(graphic.start.toFixed(2)))],
      [graphicDuration, String(Number((graphic.end - graphic.start).toFixed(2)))],
      [graphicRadius, String(Math.round(graphic.radius))],
    ];
    for (const [input, value] of fields) {
      if (document.activeElement !== input) input.value = value;
    }
    const trackCount = Math.max(videoTrackCount, graphicTrackIndex(graphic) + 1);
    if (graphicTrackSelect.options.length !== trackCount) {
      graphicTrackSelect.replaceChildren(...Array.from({ length: trackCount }, (_, index) => new Option(`V${index + 1}`, String(index))));
    }
    graphicTrackSelect.value = String(graphicTrackIndex(graphic));
  }

  function syncGraphicGeometryInputs(graphic: GraphicClip): void {
    const fields: [HTMLInputElement, string][] = [
      [graphicX, String(Math.round(graphic.x))],
      [graphicY, String(Math.round(graphic.y))],
      [graphicWidth, String(Math.round(graphic.width))],
      [graphicHeight, String(Math.round(graphic.height))],
      [graphicRotation, String(Math.round(graphic.rotation))],
    ];
    for (const [input, value] of fields) {
      if (document.activeElement !== input) input.value = value;
    }
  }

  function syncGraphicTimingInputs(graphic: GraphicClip): void {
    const fields: [HTMLInputElement, string][] = [
      [graphicStart, String(Number(graphic.start.toFixed(2)))],
      [graphicDuration, String(Number((graphic.end - graphic.start).toFixed(2)))],
    ];
    for (const [input, value] of fields) {
      if (document.activeElement !== input) input.value = value;
    }
  }

  function applyGraphicInputs(): void {
    const graphic = graphics[selectedGraphic];
    if (!graphic) return;
    const previousStart = graphic.start;
    const previousEnd = graphic.end;
    const isPaintable = graphic.kind === 'rect' || graphic.kind === 'ellipse' || graphic.kind === 'line';
    if (isPaintable) {
      graphic.fill = graphicFill.value;
      graphic.fill2 = graphicFill2.value;
      const fillType = graphicFillType.value as GraphicFillType;
      graphic.fillType = fillType === 'linear' || fillType === 'radial' ? fillType : 'solid';
      graphic.gradientAngle = Math.max(0, Math.min(360, Number(graphicGradientAngle.value) || 0));
      const pattern = graphicPattern.value as GraphicPattern;
      graphic.pattern = pattern === 'none' || GRAPHIC_PATTERN_PRESETS.some((entry) => entry.id === pattern)
        ? pattern
        : 'none';
      graphic.patternColor = graphicPatternColor.value;
      graphic.patternScale = Math.max(4, Math.min(80, Number(graphicPatternScale.value) || 14));
      graphic.stroke = graphicStroke.value;
      graphic.strokeWidth = Math.max(0, Math.min(40, Number(graphicStrokeWidth.value) || 0));
      graphic.radius = Math.max(0, Math.min(200, Number(graphicRadius.value) || 0));
    }
    graphic.opacity = Math.max(0, Math.min(1, (Number(graphicOpacity.value) || 0) / 100));
    graphic.rotation = Math.max(-180, Math.min(180, Number(graphicRotation.value) || 0));
    graphic.x = Math.max(-50, Math.min(150, Number(graphicX.value) || 0));
    graphic.y = Math.max(-50, Math.min(150, Number(graphicY.value) || 0));
    graphic.width = Math.max(1, Math.min(100, Number(graphicWidth.value) || 1));
    graphic.height = Math.max(0, Math.min(100, Number(graphicHeight.value) || 0));
    const start = Math.max(0, Number(graphicStart.value) || 0);
    const duration = Math.max(0.2, Number(graphicDuration.value) || 0.2);
    graphic.start = start;
    graphic.end = start + duration;
    if (graphic.start !== previousStart || graphic.end !== previousEnd) {
      graphicsPreviewKey = '';
      renderTimeline();
    } else {
      renderGraphicsPreview();
    }
  }

  function overlaySpan(at: number, seconds = 4): { start: number; duration: number } {
    const start = Math.max(0, at);
    const end = playbackEnd();
    return {
      start,
      duration: Math.max(1, Math.min(seconds, end > start ? end - start : seconds)),
    };
  }

  function placeGraphic(graphic: GraphicClip, label: string, at: number, track?: number): void {
    const graphicTrack = track === undefined
      ? firstFreeOverlayTrack(graphic.start, graphic.end)
      : Math.max(0, Math.round(track));
    if (graphicTrack >= videoTrackCount) {
      videoTrackCount = graphicTrack + 1;
      ensureTrackStates(videoTrackCount, audioTrackCount);
    }
    graphic.track = graphicTrack;
    graphics.push(graphic);
    selectedGraphic = graphics.length - 1;
    selected = null;
    selectedTitle = -1;
    selectedSubtitleKey = '';
    selectSideTab('graphics');
    ensureInspectorOpen();
    graphicsPreviewKey = '';
    renderGraphicsPreview();
    renderTimeline();
    renderGraphicsPanel();
    seek(Math.max(0, at));
    commit(`Added ${label.toLowerCase()}`);
    status.textContent = `${label} added. Drag it in the timeline or edit its properties.`;
  }

  function addGraphic(kind: GraphicKind, at = time, track?: number): void {
    const { start, duration } = overlaySpan(at);
    placeGraphic(defaultGraphic(kind, ++nextId, start, start + duration), graphicLabel(kind), at, track);
  }

  function addPatternGraphic(preset: GraphicPatternPreset, at = time, track?: number): void {
    const { start, duration } = overlaySpan(at);
    placeGraphic(
      defaultPatternGraphic(preset, ++nextId, start, start + duration),
      `${preset.label} pattern`,
      at,
      track,
    );
  }

  function addGradientGraphic(preset: GraphicGradientPreset, at = time, track?: number): void {
    const { start, duration } = overlaySpan(at);
    placeGraphic(
      defaultGradientGraphic(preset, ++nextId, start, start + duration),
      `${preset.label} gradient`,
      at,
      track,
    );
  }

  function addSvgGraphic(dataUrl: string, name: string, at = time, track?: number): void {
    const { start, duration } = overlaySpan(at);
    placeGraphic(defaultSvgGraphic(++nextId, start, start + duration, dataUrl, name), name || 'SVG', at, track);
  }

  function addEmojiGraphic(emoji: string, at = time, track?: number): void {
    const { start, duration } = overlaySpan(at);
    const size = outputDimensions();
    const height = 22;
    const width = Math.max(6, Math.min(60, (height * size.height) / size.width));
    const box = { x: (100 - width) / 2, y: (100 - height) / 2, width, height };
    placeGraphic(defaultEmojiGraphic(++nextId, start, start + duration, emoji, box), emoji, at, track);
  }

  for (const button of graphicAddButtons) {
    button.addEventListener('click', () => addGraphic((button.dataset.graphicAdd ?? 'rect') as GraphicKind));
  }

  const TITLE_GENERATOR_DATA = 'application/x-video-title-preset';
  const SHAPE_GENERATOR_DATA = 'application/x-video-shape';
  function bindGeneratorDrag(button: HTMLButtonElement, type: string, value: string): void {
    button.draggable = true;
    button.addEventListener('dragstart', (event) => {
      event.dataTransfer?.setData(type, value);
      event.dataTransfer?.setData('text/plain', value);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy';
      button.classList.add('dragging');
    });
    button.addEventListener('dragend', () => {
      button.classList.remove('dragging');
      scroll.classList.remove('generator-drop-target');
    });
  }
  for (const button of titlePresetButtons) {
    bindGeneratorDrag(button, TITLE_GENERATOR_DATA, button.dataset.titlePreset ?? 'title');
  }
  for (const button of graphicAddButtons) {
    bindGeneratorDrag(button, SHAPE_GENERATOR_DATA, button.dataset.graphicAdd ?? 'rect');
  }

  const PATTERN_GENERATOR_DATA = 'application/x-video-pattern';
  const GRADIENT_GENERATOR_DATA = 'application/x-video-gradient';
  const EMOJI_GENERATOR_DATA = 'application/x-video-emoji';
  const SVG_GENERATOR_DATA = 'application/x-video-svg';
  const GRAPHIC_EMOJIS = [
    '😀', '😂', '🥰', '😎', '🤔', '😭', '😡', '👍', '👎', '👏', '🙌', '🎉',
    '🔥', '⭐', '✨', '💡', '❤️', '💙', '💚', '💜', '🖤', '🤍', '✅', '❌',
    '⚡', '🎬', '🎵', '🎤', '📷', '📱', '💻', '🚀', '🌟', '🌈', '☀️', '🌙',
    '☁️', '🍕', '☕', '🏆', '💯', '👀',
  ];

  function swatchCard(label: string, hint: string, apply: (swatch: HTMLElement) => void): HTMLButtonElement {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'video-swatch-card';
    const swatch = document.createElement('span');
    swatch.className = 'video-swatch';
    apply(swatch);
    const strong = document.createElement('strong');
    strong.textContent = label;
    const small = document.createElement('small');
    small.textContent = hint;
    card.append(swatch, strong, small);
    return card;
  }

  function renderSvgLibrary(): void {
    svgList.replaceChildren();
    if (!importedSvgs.length) {
      const empty = document.createElement('p');
      empty.className = 'video-library-note video-svg-empty';
      empty.textContent = 'No SVGs imported yet.';
      svgList.append(empty);
      return;
    }
    importedSvgs.forEach((item, index) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'video-generator-card video-svg-card';
      const thumb = document.createElement('span');
      thumb.className = 'video-svg-thumb';
      const image = document.createElement('img');
      image.src = item.dataUrl;
      image.alt = '';
      thumb.append(image);
      const strong = document.createElement('strong');
      strong.textContent = item.name;
      const small = document.createElement('small');
      small.textContent = 'SVG overlay';
      card.append(thumb, strong, small);
      card.title = 'Add this SVG to the timeline';
      card.addEventListener('click', () => addSvgGraphic(item.dataUrl, item.name));
      bindGeneratorDrag(card, SVG_GENERATOR_DATA, String(index));
      svgList.append(card);
    });
  }

  async function importSvgFile(file: File): Promise<void> {
    if (!/\.svg$/i.test(file.name) && file.type !== 'image/svg+xml') {
      status.textContent = 'Choose an .svg file.';
      return;
    }
    try {
      const text = await file.text();
      if (!/<svg[\s>]/i.test(text)) throw new Error('This file is not an SVG image.');
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error ?? new Error('Could not read the SVG.'));
        reader.readAsDataURL(new Blob([text], { type: 'image/svg+xml' }));
      });
      const item = { name: file.name.replace(/\.svg$/i, '') || 'SVG', dataUrl };
      importedSvgs.push(item);
      while (importedSvgs.length > 24) importedSvgs.shift();
      renderSvgLibrary();
      addSvgGraphic(item.dataUrl, item.name);
      status.textContent = `${item.name} imported as an SVG overlay.`;
    } catch (error) {
      status.textContent = errorMessage(error);
    }
  }

  function renderGraphicLibrary(): void {
    patternGrid.replaceChildren();
    for (const preset of GRAPHIC_PATTERN_PRESETS) {
      const card = swatchCard(preset.label, 'Pattern', (swatch) => {
        swatch.style.backgroundColor = preset.base;
        const pattern = graphicPatternCss(preset.id, preset.color, preset.scale);
        if (pattern) {
          swatch.style.backgroundImage = pattern.image;
          swatch.style.backgroundSize = pattern.size;
        }
      });
      card.title = `Add a ${preset.label.toLowerCase()} panel`;
      card.addEventListener('click', () => addPatternGraphic(preset));
      bindGeneratorDrag(card, PATTERN_GENERATOR_DATA, preset.id);
      patternGrid.append(card);
    }
    gradientGrid.replaceChildren();
    for (const preset of GRAPHIC_GRADIENT_PRESETS) {
      const card = swatchCard(preset.label, 'Gradient', (swatch) => {
        swatch.style.background = preset.type === 'radial'
          ? `radial-gradient(circle at center, ${preset.from}, ${preset.to})`
          : `linear-gradient(${preset.angle}deg, ${preset.from}, ${preset.to})`;
      });
      card.title = `Add a ${preset.label.toLowerCase()} gradient panel`;
      card.addEventListener('click', () => addGradientGraphic(preset));
      bindGeneratorDrag(card, GRADIENT_GENERATOR_DATA, preset.id);
      gradientGrid.append(card);
    }
    emojiGrid.replaceChildren();
    for (const emoji of GRAPHIC_EMOJIS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'video-emoji-button';
      button.textContent = emoji;
      button.title = `Add ${emoji} to the timeline`;
      button.addEventListener('click', () => addEmojiGraphic(emoji));
      bindGeneratorDrag(button, EMOJI_GENERATOR_DATA, emoji);
      emojiGrid.append(button);
    }
    renderSvgLibrary();
  }

  renderGraphicLibrary();
  svgImport.addEventListener('click', () => svgInput.click());
  svgInput.addEventListener('change', () => {
    const [file] = takeFiles(svgInput);
    if (file) void importSvgFile(file);
  });

  scroll.addEventListener('dragover', (event) => {
    const types = event.dataTransfer?.types ?? [];
    if (![
      TITLE_GENERATOR_DATA, SHAPE_GENERATOR_DATA, PATTERN_GENERATOR_DATA,
      GRADIENT_GENERATOR_DATA, EMOJI_GENERATOR_DATA, SVG_GENERATOR_DATA,
    ].some((type) => types.includes(type))) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    scroll.classList.add('generator-drop-target');
  });
  scroll.addEventListener('dragleave', (event) => {
    if (!(event.relatedTarget instanceof Node) || !scroll.contains(event.relatedTarget)) {
      scroll.classList.remove('generator-drop-target');
    }
  });
  scroll.addEventListener('drop', (event) => {
    const data = event.dataTransfer;
    const titleKey = data?.getData(TITLE_GENERATOR_DATA) ?? '';
    const shapeKind = data?.getData(SHAPE_GENERATOR_DATA) ?? '';
    const patternId = data?.getData(PATTERN_GENERATOR_DATA) ?? '';
    const gradientId = data?.getData(GRADIENT_GENERATOR_DATA) ?? '';
    const emoji = data?.getData(EMOJI_GENERATOR_DATA) ?? '';
    const svgIndex = data?.getData(SVG_GENERATOR_DATA) ?? '';
    if (!titleKey && !shapeKind && !patternId && !gradientId && !emoji && !svgIndex) return;
    event.preventDefault();
    event.stopPropagation();
    scroll.classList.remove('generator-drop-target');
    const bounds = content.getBoundingClientRect();
    const at = Math.max(0, (event.clientX - bounds.left) / pps());
    const laneBounds = videoLane.getBoundingClientRect();
    const offsetY = event.clientY - (laneBounds.top + trackTopPad());
    const track = offsetY >= 0 && offsetY < laneBounds.height
      ? Math.max(0, trackAtOffset(offsetY, videoTrackHeights, videoRowHeight(), videoTrackCount))
      : undefined;
    if (titleKey) {
      addTitlePreset(titleKey, at, track);
      status.textContent = 'Title dropped on the timeline.';
      return;
    }
    if (shapeKind) {
      addGraphic((shapeKind || 'rect') as GraphicKind, at, track);
      status.textContent = 'Shape dropped on the timeline.';
      return;
    }
    if (patternId) {
      const preset = GRAPHIC_PATTERN_PRESETS.find((entry) => entry.id === patternId);
      if (preset) {
        addPatternGraphic(preset, at, track);
        status.textContent = 'Pattern dropped on the timeline.';
      }
      return;
    }
    if (gradientId) {
      const preset = GRAPHIC_GRADIENT_PRESETS.find((entry) => entry.id === gradientId);
      if (preset) {
        addGradientGraphic(preset, at, track);
        status.textContent = 'Gradient dropped on the timeline.';
      }
      return;
    }
    if (emoji) {
      addEmojiGraphic(emoji, at, track);
      status.textContent = 'Emoji dropped on the timeline.';
      return;
    }
    const svg = importedSvgs[Number(svgIndex)];
    if (svg) {
      addSvgGraphic(svg.dataUrl, svg.name, at, track);
      status.textContent = 'SVG dropped on the timeline.';
    }
  });
  for (const input of [
    graphicFill, graphicFill2, graphicFillType, graphicGradientAngle, graphicPattern,
    graphicPatternColor, graphicPatternScale, graphicStroke, graphicStrokeWidth, graphicOpacity,
    graphicRotation, graphicX, graphicY, graphicWidth, graphicHeight, graphicStart, graphicDuration, graphicRadius,
  ]) {
    input.addEventListener('input', applyGraphicInputs);
    input.addEventListener('change', () => {
      applyGraphicInputs();
      renderGraphicsPanel();
      commit('Edited graphic overlay');
    });
  }
  graphicTrackSelect.addEventListener('change', () => {
    const graphic = graphics[selectedGraphic];
    if (!graphic) return;
    const track = Math.max(0, Number(graphicTrackSelect.value) || 0);
    if (videoTrackLocked(track)) {
      lockedNotice();
      renderGraphicsPanel();
      return;
    }
    graphic.track = track;
    graphicsPreviewKey = '';
    renderTimeline();
    renderGraphicsPanel();
    commit('Moved graphic overlay');
  });
  function syncAnimationGeometry(): void {
    if (!animationPanel?.isOpen()) return;
    const sidebar = scroll.getBoundingClientRect().left - animationRoot.getBoundingClientRect().left - animationRoot.clientLeft;
    animationPanel.setGeometry({ scale: pps(), left: scroll.scrollLeft, width: scroll.clientWidth, sidebar: Math.max(0, sidebar) });
  }

  function syncClipAnimation(): void {
    if (!animationPanel?.isOpen()) return;
    const clip = selectedVideoClip();
    if (!clip) {
      animationPanel.setClip(null);
      return;
    }
    const duration = videoClipLength(clip);
    const effects: KeyframeClip['effects'] = videoTransitionDisplays(clip).map((transition) => {
      const span = Math.min(duration, transition.duration);
      return {
        label: transitionDisplayLabel(transition),
        start: transition.edge === 'start' ? 0 : duration - span,
        end: transition.edge === 'start' ? span : duration,
        section: 'transition',
      };
    });
    const zoom = normalizeDynamicZoom(clip.effects.dynamicZoom);
    if (zoom.enabled) {
      effects.push({
        label: 'Dynamic Zoom',
        summary: Math.round(zoom.from * 100) + '% → ' + Math.round(zoom.to * 100) + '% · ' + zoom.easing,
        start: 0,
        end: duration,
        section: 'dynamic-zoom',
        sample: (at) => dynamicZoomAt(zoom, at, duration),
      });
    }
    animationPanel.setClip({
      id: clip.id, name: clip.name, start: clip.start, duration,
      animation: { ...clip.animation, speed: clip.image ? undefined : speedKeys(clip) },
      speedLocked: speedEditLocked(clip), locked: videoClipLocked(clip), effects,
    });
    syncAnimationGeometry();
  }

  function showClipAnimation(open: boolean): void {
    if (!animationPanel) return;
    animationPanel.setOpen(open);
    editor.classList.toggle('animation-open', open);
    animationToggle.setAttribute('aria-expanded', String(open));
    animationToggle.classList.toggle('active', open);
    syncClipAnimation();
    if (open) animationRoot.scrollIntoView({ block: 'nearest' });
    else animationToggle.focus({ preventScroll: true });
    updateToolRail();
  }

  function openSpeedPoints(): void {
    showClipAnimation(true);
    animationPanel?.pin('speed');
  }

  // Multi-camera angle switching --------------------------------------------
  function renderMulticamPanel(): void {
    multicamAngles.replaceChildren();
    multicamCuts.replaceChildren();
    const activeTracks = new Map<number, VideoClip>();
    for (const clip of videos) {
      if (videoTrackHidden(clip.track)) continue;
      if (time < clip.start || time >= clip.start + videoClipLength(clip)) continue;
      const existing = activeTracks.get(clip.track);
      if (!existing || clip.start > existing.start) activeTracks.set(clip.track, clip);
    }
    if (!activeTracks.size) {
      const empty = document.createElement('p');
      empty.className = 'text-[10px] leading-relaxed text-slate-500';
      empty.textContent = 'Place synchronized clips on different video tracks, then move the playhead over them.';
      multicamAngles.append(empty);
    } else {
      const active = activeCameraTrack(time);
      for (const [track, clip] of [...activeTracks].sort((a, b) => a[0] - b[0])) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'video-multicam-angle' + (active === track ? ' active' : '');
        const badge = document.createElement('span');
        badge.className = 'video-multicam-badge';
        badge.textContent = `V${track + 1}`;
        const name = document.createElement('span');
        name.textContent = clip.name;
        const action = document.createElement('small');
        action.textContent = active === track ? 'Live' : 'Cut';
        row.append(badge, name, action);
        row.addEventListener('click', () => {
          const at = Number(time.toFixed(2));
          cameraCuts = cameraCuts.filter((cut) => Math.abs(cut.at - at) > 0.05);
          cameraCuts.push({ at, track });
          cameraCuts.sort((a, b) => a.at - b.at);
          selected = { kind: 'video', id: clip.id };
          selectedTitle = -1;
          selectedGraphic = -1;
          render();
          seek(at);
          commit('Cut to a camera angle');
          status.textContent = `Camera cut to V${track + 1} at ${formatClock(at, true)}.`;
        });
        multicamAngles.append(row);
      }
    }
    const sorted = [...cameraCuts].sort((a, b) => a.at - b.at);
    if (!sorted.length) {
      const empty = document.createElement('span');
      empty.className = 'video-key-empty';
      empty.textContent = 'No cuts yet';
      multicamCuts.append(empty);
    } else {
      for (const cut of sorted) {
        const row = document.createElement('span');
        row.className = 'video-multicam-cut';
        const seekButton = document.createElement('button');
        seekButton.type = 'button';
        seekButton.textContent = `${formatClock(cut.at, true)} · V${cut.track + 1}`;
        seekButton.addEventListener('click', () => seek(cut.at));
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'video-key-remove';
        remove.textContent = '×';
        remove.title = 'Remove camera cut';
        remove.addEventListener('click', () => {
          cameraCuts = cameraCuts.filter((entry) => entry !== cut);
          renderMulticamPanel();
          render();
          seek(time);
          commit('Removed camera cut');
        });
        row.append(seekButton, remove);
        multicamCuts.append(row);
      }
    }
  }
  multicamClear.addEventListener('click', () => {
    if (!cameraCuts.length) return;
    cameraCuts = [];
    renderMulticamPanel();
    render();
    seek(time);
    commit('Cleared camera cuts');
    status.textContent = 'Camera cuts cleared.';
  });

  // Effects library ----------------------------------------------------------
  function effectTargetClip(): VideoClip | null {
    const selectedClip = selectedVideoClip();
    if (selectedClip) return selectedClip;
    const clip = videoAt(time)?.clip ?? null;
    if (!clip) return null;
    selected = { kind: 'video', id: clip.id };
    selectedTitle = -1;
    selectedGraphic = -1;
    selectedSubtitleKey = '';
    ensureInspectorOpen();
    selectSideTab('video');
    return clip;
  }

  function applyEffectToSelection(effect: VideoEffectPreset): void {
    const clip = effectTargetClip();
    if (!clip) {
      status.textContent = 'Select a video clip, or move the playhead over one.';
      return;
    }
    if (videoClipLocked(clip)) {
      lockedNotice();
      return;
    }
    clip.effects = applyVideoEffect(effect, clip.effects);
    effectsReset.disabled = false;
    applyPreviewTransform(clip);
    render();
    seek(time);
    commit(`Applied effect: ${effect.name}`);
    status.textContent = `Applied ${effect.name}. Stack another effect or use Reset effects.`;
  }

  function resetEffectStack(): void {
    const clip = effectTargetClip();
    if (!clip) {
      status.textContent = 'Select a video clip, or move the playhead over one.';
      return;
    }
    if (videoClipLocked(clip)) {
      lockedNotice();
      return;
    }
    clip.effects = resetVideoEffects(clip.effects);
    effectsReset.disabled = false;
    applyPreviewTransform(clip);
    render();
    seek(time);
    commit('Reset clip effects');
    status.textContent = 'Colour and blur effects reset.';
  }

  function captureEffectPreview(): string {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 180;
      const context = canvas.getContext('2d');
      if (!context) return '';
      const clip = selectedVideoClip() ?? videoAt(time)?.clip ?? null;
      const source = clip?.image && still.complete && still.naturalWidth
        ? still
        : preview.readyState >= 2 && preview.videoWidth
          ? preview
          : null;
      if (source) {
        const width = source instanceof HTMLVideoElement ? source.videoWidth : source.naturalWidth;
        const height = source instanceof HTMLVideoElement ? source.videoHeight : source.naturalHeight;
        const scale = Math.max(320 / Math.max(1, width), 180 / Math.max(1, height));
        const drawWidth = width * scale;
        const drawHeight = height * scale;
        context.drawImage(source, (320 - drawWidth) / 2, (180 - drawHeight) / 2, drawWidth, drawHeight);
      } else {
        const gradient = context.createLinearGradient(0, 0, 320, 180);
        gradient.addColorStop(0, '#38bdf8');
        gradient.addColorStop(0.5, '#c7d2fe');
        gradient.addColorStop(0.52, '#f59e0b');
        gradient.addColorStop(1, '#7c2d12');
        context.fillStyle = gradient;
        context.fillRect(0, 0, 320, 180);
        context.fillStyle = 'rgba(15,23,42,.5)';
        context.fillRect(0, 112, 320, 68);
      }
      return canvas.toDataURL('image/jpeg', 0.82);
    } catch {
      return '';
    }
  }

  function renderEffectsPanel(): void {
    const query = effectsSearch.value.trim().toLowerCase();
    const list = VIDEO_EFFECTS.filter((effect) =>
      (effectFilter === 'all' || effect.category === effectFilter) &&
      (!query || `${effect.name} ${effect.description}`.toLowerCase().includes(query)),
    );
    for (const button of effectFilterButtons) {
      const id = button.dataset.effectFilter ?? 'all';
      const badge = button.querySelector('span');
      if (badge) {
        badge.textContent = String(id === 'all'
          ? VIDEO_EFFECTS.length
          : VIDEO_EFFECTS.filter((effect) => effect.category === id).length);
      }
      button.classList.toggle('active', id === effectFilter);
    }
    effectsCount.textContent = `${list.length} of ${VIDEO_EFFECTS.length} effects`;
    const clip = selectedVideoClip() ?? videoAt(time)?.clip ?? null;
    effectsReset.disabled = !clip || videoClipLocked(clip);
    effectsGrid.replaceChildren();
    if (!list.length) {
      const empty = document.createElement('p');
      empty.className = 'video-library-note';
      empty.textContent = 'No effects match this search.';
      effectsGrid.append(empty);
      return;
    }
    for (const effect of list) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'video-effect-card';
      card.dataset.effectId = effect.id;
      card.title = `${effect.name}: ${effect.description}`;
      const preview = document.createElement('span');
      preview.className = 'video-effect-preview';
      preview.style.setProperty('--effect-filter', effect.filter);
      const frame = document.createElement('span');
      frame.className = 'video-effect-frame';
      if (effectsPreviewImage) frame.style.backgroundImage = `url("${effectsPreviewImage}")`;
      const badge = document.createElement('em');
      badge.textContent = effect.category.toUpperCase();
      const copy = document.createElement('span');
      copy.className = 'video-effect-copy';
      const name = document.createElement('strong');
      name.textContent = effect.name;
      const description = document.createElement('small');
      description.textContent = effect.description;
      preview.append(frame, badge);
      copy.append(name, description);
      card.append(preview, copy);
      card.addEventListener('click', () => applyEffectToSelection(effect));
      effectsGrid.append(card);
    }
  }

  effectsSearch.addEventListener('input', renderEffectsPanel);
  for (const button of effectFilterButtons) {
    button.addEventListener('click', () => {
      effectFilter = (button.dataset.effectFilter as VideoEffectFilter) ?? 'all';
      renderEffectsPanel();
    });
  }
  effectsReset.addEventListener('click', resetEffectStack);

  // Transitions --------------------------------------------------------------
  const TRANSITION_DATA = 'application/x-video-transition';
  type TransitionTarget = { kind: 'video'; clip: VideoClip } | { kind: 'audio'; clip: AudioClip };
  const normalizeTransition = (value: string): OverlayTransition =>
    value === 'fade-in' || value === 'fade-out' || value === 'dip' ? value : 'none';

  /** Remove the opacity keys created by the clip's previous fade transition. */
  function clearTransitionOpacityKeys(clip: VideoClip): void {
    const previous = clip.transition;
    if (!previous || isMotionTransitionType(previous.type)) return;
    const length = videoClipLength(clip);
    const times = new Set<number>();
    if (previous.type === 'fade-in' || previous.type === 'dip') {
      times.add(0);
      times.add(previous.duration);
    }
    if (previous.type === 'fade-out' || previous.type === 'dip') {
      times.add(Math.max(0, length - previous.duration));
      times.add(length);
    }
    if (!times.size) return;
    clip.animation.opacity = (clip.animation.opacity ?? []).filter((key) =>
      ![...times].some((at) => Math.abs(key.at - at) < 0.01));
  }

  /** Write a transition to the clip and keep its opacity keys in sync. */
  function writeVideoTransition(
    clip: VideoClip,
    type: string,
    duration: number,
    alignment: TransitionAlignment = 'center',
  ): void {
    const length = videoClipLength(clip);
    clearTransitionOpacityKeys(clip);
    if (type === 'none') {
      clip.transition = undefined;
      clip.animation.opacity = [];
      return;
    }
    const transition = normalizeClipTransition({
      type: type as ClipTransitionType,
      duration,
      alignment,
    });
    if (!transition) return;
    if (isMotionTransitionType(transition.type)) {
      clip.transition = transition;
      clip.animation.opacity = [];
      return;
    }
    const fade = Math.max(0.1, Math.min(transition.duration, Math.max(0.1, length / 2)));
    clip.transition = { ...transition, duration: fade };
    let keys = clip.animation.opacity ?? [];
    if (transition.type === 'fade-in' || transition.type === 'dip') {
      keys = withKeyframe(keys, 0, 0, 'ease-in-out');
      keys = withKeyframe(keys, fade, 1, 'ease-in-out');
    }
    if (transition.type === 'fade-out' || transition.type === 'dip') {
      keys = withKeyframe(keys, Math.max(0, length - fade), 1, 'ease-in-out');
      keys = withKeyframe(keys, length, 0, 'ease-in-out');
    }
    clip.animation.opacity = keys;
  }

  function applyTransitionTo(kind: string, target: TransitionTarget): void {
    if (target.kind === 'video') {
      const clip = target.clip;
      if (videoClipLocked(clip)) {
        lockedNotice();
        return;
      }
      const length = videoClipLength(clip);
      const alignment = clip.transition?.alignment ?? 'center';
      if (kind === 'none') {
        writeVideoTransition(clip, 'none', 0, alignment);
      } else if (isMotionTransitionType(kind)) {
        writeVideoTransition(clip, kind, Math.min(1, Math.max(0.35, length / 3)), alignment);
      } else {
        writeVideoTransition(clip, kind, Math.min(0.6, Math.max(0.15, length / 3)), alignment);
      }
      selected = { kind: 'video', id: clip.id };
      selectedGraphic = -1;
      selectedTitle = -1;
      selectedSubtitleKey = '';
      selectSideTab('clip');
      applyPreviewTransform(clip);
      status.textContent = kind === 'none'
        ? 'Cleared the video transition.'
        : isMotionTransitionType(kind)
          ? `Applied ${motionTransitionLabel(kind)} at the clip start.`
          : `Applied ${kind.replace('-', ' ')}.`;
    } else {
      const clip = target.clip;
      if (isMotionTransitionType(kind)) {
        status.textContent = 'Motion transitions apply to video clips only.';
        return;
      }
      if (audioClipLocked(clip)) {
        lockedNotice();
        return;
      }
      const fade = Math.min(1, Math.max(0.1, audioClipLength(clip) / 3));
      if (kind === 'none') {
        clip.fadeIn = 0;
        clip.fadeOut = 0;
      } else {
        if (kind === 'fade-in' || kind === 'dip') clip.fadeIn = fade;
        if (kind === 'fade-out' || kind === 'dip') clip.fadeOut = fade;
      }
      selected = { kind: 'audio', id: clip.id };
      selectedGraphic = -1;
      selectedTitle = -1;
      selectedSubtitleKey = '';
      selectSideTab('clip');
      status.textContent = kind === 'none' ? 'Cleared the audio transition.' : `Applied ${kind.replace('-', ' ')}.`;
    }
    render();
    seek(time);
    if (target.kind === 'video' && kind !== 'none') revealInspectorSection('transition');
    commit('Applied transition');
  }

  function applyGraphicTransition(kind: string, index: number): void {
    if (isMotionTransitionType(kind)) {
      status.textContent = 'Motion transitions apply to video clips only.';
      return;
    }
    const graphic = graphics[index];
    if (!graphic) return;
    graphic.transition = normalizeTransition(kind);
    selectedGraphic = index;
    selected = null;
    selectedTitle = -1;
    selectedSubtitleKey = '';
    selectSideTab('graphics');
    ensureInspectorOpen();
    graphicsPreviewKey = '';
    renderGraphicsPreview();
    renderTimeline();
    renderGraphicsPanel();
    commit('Applied overlay transition');
    status.textContent = kind === 'none' ? 'Cleared the shape transition.' : `Applied ${kind.replace('-', ' ')} to the shape.`;
  }

  function applyTitleTransition(kind: string, index: number): void {
    if (isMotionTransitionType(kind)) {
      status.textContent = 'Motion transitions apply to video clips only.';
      return;
    }
    const cue = titles[index];
    if (!cue) return;
    cue.transition = normalizeTransition(kind);
    selectedTitle = index;
    selected = null;
    selectedGraphic = -1;
    selectedSubtitleKey = '';
    selectSideTab('text');
    ensureInspectorOpen();
    invalidateShiftedCues();
    renderTimeline();
    renderTitlePanel();
    renderTextLayer();
    commit('Applied title transition');
    status.textContent = kind === 'none' ? 'Cleared the title transition.' : `Applied ${kind.replace('-', ' ')} to the title.`;
  }

  function applySubtitleTransition(kind: string, key: string): void {
    if (captionTrackState.locked) {
      lockedNotice();
      return;
    }
    if (!key) return;
    if (isMotionTransitionType(kind)) {
      status.textContent = 'Motion transitions apply to video clips only.';
      return;
    }
    const transition = normalizeTransition(kind);
    if (transition === 'none') delete subtitleTransitions[key];
    else subtitleTransitions[key] = transition;
    selectedTitle = -1;
    selected = null;
    selectedGraphic = -1;
    selectedSubtitleKey = key;
    selectSideTab('text');
    ensureInspectorOpen();
    invalidateFingerprint();
    captionLaneKey = '';
    renderCaptionLane(pps());
    renderTitlePanel();
    renderTextLayer();
    updateProjectBar();
    status.textContent = transition === 'none' ? 'Cleared the subtitle transition.' : `Applied ${transition.replace('-', ' ')} to the subtitle.`;
  }

  function applyTransitionToSelection(kind: string): void {
    if (selectedGraphic >= 0) {
      applyGraphicTransition(kind, selectedGraphic);
      return;
    }
    if (selectedTitle >= 0) {
      applyTitleTransition(kind, selectedTitle);
      return;
    }
    if (selectedSubtitleKey) {
      applySubtitleTransition(kind, selectedSubtitleKey);
      return;
    }
    const target = currentTarget();
    if (!target) {
      status.textContent = 'Select a clip, title, subtitle, or shape first.';
      return;
    }
    applyTransitionTo(kind, target);
  }

  function transitionFromDrop(event: DragEvent): string | null {
    if (!event.dataTransfer?.types.includes(TRANSITION_DATA)) return null;
    return event.dataTransfer.getData(TRANSITION_DATA) || null;
  }

  function clearTransitionDropTargets(): void {
    for (const element of root.querySelectorAll('.transition-drop-target')) {
      element.classList.remove('transition-drop-target');
    }
  }

  function markTransitionDropTarget(event: DragEvent, selector: string): HTMLElement | null {
    if (!event.dataTransfer?.types.includes(TRANSITION_DATA)) return null;
    const element = (event.target as Element | null)?.closest<HTMLElement>(selector) ?? null;
    if (!element) return null;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    for (const other of root.querySelectorAll('.transition-drop-target')) {
      if (other !== element) other.classList.remove('transition-drop-target');
    }
    element.classList.add('transition-drop-target');
    return element;
  }

  function bindTransitionDrop(
    lane: HTMLElement,
    selector: string,
    apply: (kind: string, element: HTMLElement) => void,
  ): void {
    lane.addEventListener('dragover', (event) => {
      markTransitionDropTarget(event, selector);
    });
    lane.addEventListener('dragleave', (event) => {
      const element = (event.target as Element | null)?.closest<HTMLElement>(selector);
      element?.classList.remove('transition-drop-target');
    });
    lane.addEventListener('drop', (event) => {
      const element = markTransitionDropTarget(event, selector);
      const kind = transitionFromDrop(event);
      if (!element || !kind) return;
      event.preventDefault();
      element.classList.remove('transition-drop-target');
      apply(kind, element);
    });
  }

  bindTransitionDrop(videoLane, '.vt-clip', (kind, element) => {
    const titleIndex = Number(element.dataset.titleIndex);
    if (Number.isFinite(titleIndex)) {
      applyTitleTransition(kind, titleIndex);
      return;
    }
    const graphicId = Number(element.dataset.graphicId);
    if (Number.isFinite(graphicId)) {
      const index = graphics.findIndex((graphic) => graphic.id === graphicId);
      if (index >= 0) applyGraphicTransition(kind, index);
      return;
    }
    const clip = videos.find((entry) => entry.id === Number(element.dataset.id));
    if (clip) applyTransitionTo(kind, { kind: 'video', clip });
  });
  bindTransitionDrop(audioLane, '.vt-clip', (kind, element) => {
    const clip = audios.find((entry) => entry.id === Number(element.dataset.id));
    if (clip) applyTransitionTo(kind, { kind: 'audio', clip });
  });
  bindTransitionDrop(captionLane, '.vt-cue', (kind, element) => {
    applySubtitleTransition(kind, element.dataset.cueText ?? '');
  });
  for (const button of transitionButtons) {
    button.addEventListener('click', () => applyTransitionToSelection(button.dataset.transition ?? ''));
    button.addEventListener('dragstart', (event) => {
      const kind = button.dataset.transition ?? '';
      event.dataTransfer?.setData(TRANSITION_DATA, kind);
      event.dataTransfer?.setData('text/plain', kind);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy';
      button.classList.add('dragging');
    });
    button.addEventListener('dragend', () => {
      button.classList.remove('dragging');
      clearTransitionDropTargets();
    });
  }

  // Local AI edits and templates ---------------------------------------------
  function removeFillerWords(): void {
    const source = options.getTranscriptCues() ?? [];
    if (!source.length) {
      status.textContent = 'Transcribe a clip first, then remove filler words.';
      return;
    }
    const fillers = new Set(['um', 'uh', 'erm', 'uhm', 'hmm', 'mm', 'mhm', 'ah', 'er']);
    const spans: { start: number; end: number }[] = [];
    for (const cue of source) {
      for (const word of wordsOfCue(cue)) {
        const clean = word.text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
        if (fillers.has(clean)) spans.push({ start: word.originalStart, end: word.originalEnd });
      }
    }
    if (!spans.length) {
      status.textContent = 'No filler words found.';
      return;
    }
    let removed = 0;
    for (const span of spans.sort((a, b) => b.start - a.start)) {
      const start = mapOriginalTime(span.start);
      const end = mapOriginalTime(span.end);
      if (!(end - start > 0.02)) continue;
      transcriptEdits.push({ start: span.start, end: span.end });
      mergeTranscriptEdits();
      cutSpan(start, end, true);
      removed += end - start;
    }
    render();
    seek(Math.min(time, timelineEnd()));
    commit('Removed filler words');
    status.textContent = `Removed ${spans.length} filler word${spans.length === 1 ? '' : 's'} (${formatClock(removed, true)}).`;
  }

  function applyTemplate(kind: string): void {
    if (kind === 'youtube') {
      preset.value = '1080p';
      aspectSelect.value = 'source';
    } else if (kind === 'shorts') {
      preset.value = 'vertical';
      aspectSelect.value = 'vertical';
    } else if (kind === 'square') {
      preset.value = 'square';
      aspectSelect.value = 'square';
    } else {
      preset.value = 'source';
      if (exportContainer.querySelector('option[value="wav"]')) exportContainer.value = 'wav';
    }
    updatePreviewFrame();
    updateProjectBar();
    commit('Applied project template');
    status.textContent = `Applied the ${kind} project template.`;
  }

  for (const button of templateButtons) {
    button.addEventListener('click', () => applyTemplate(button.dataset.template ?? ''));
  }
  for (const button of aiActionButtons) {
    button.addEventListener('click', () => {
      switch (button.dataset.aiAction) {
        case 'silence': removeTranscriptSilences(0.7); break;
        case 'filler': removeFillerWords(); break;
        case 'captions':
          if (captionTrackState.locked) { lockedNotice(); break; }
          captionSource.value = 'transcript';
          updateCaptions();
          commit('Added captions');
          status.textContent = 'Captions now follow the local transcript.';
          break;
        case 'vertical':
          preset.value = 'vertical';
          aspectSelect.value = 'vertical';
          updatePreviewFrame();
          updateProjectBar();
          commit('Made the project vertical');
          status.textContent = 'Project is now vertical 9:16.';
          break;
        case 'normalize':
          normalize.value = 'podcast';
          commit('Normalized speech');
          status.textContent = 'Exports normalize speech to -16 LUFS.';
          break;
        case 'title': addTitleAtPlayhead(); break;
      }
    });
  }
  for (const button of recipeButtons) {
    button.addEventListener('click', () => {
      if (button.dataset.recipe === 'clean') {
        removeTranscriptSilences(0.7);
        removeFillerWords();
      } else if (button.dataset.recipe === 'social') {
        preset.value = 'vertical';
        aspectSelect.value = 'vertical';
        if (!captionTrackState.locked) captionSource.value = 'transcript';
        updatePreviewFrame();
        updateCaptions();
        updateProjectBar();
        commit('Applied social recipe');
        status.textContent = 'Vertical canvas and transcript captions are ready.';
      } else {
        normalize.value = 'podcast';
        if (exportContainer.querySelector('option[value="wav"]')) exportContainer.value = 'wav';
        commit('Applied podcast recipe');
        status.textContent = 'Podcast loudness is set. Export audio from the Export tab.';
      }
    });
  }

  // AI editor ----------------------------------------------------------------
  interface AiToolDef extends AiToolSpec {
    execute: (args: Record<string, unknown>) => unknown | Promise<unknown>;
  }

  const AI_SETTINGS_KEY = 'localscribe.video.ai.settings';
  const aiProviderIds = Object.keys(AI_PROVIDER_PRESETS) as AiProviderId[];
  const defaultAiSettings = (): AiSettings => {
    const preset = AI_PROVIDER_PRESETS.openai;
    return {
      provider: 'openai',
      model: preset.model,
      baseUrl: preset.baseUrl,
      style: preset.style,
      previewOnly: true,
      autoApprove: false,
    };
  };
  const loadAiSettings = (): AiSettings => {
    const fallback = defaultAiSettings();
    try {
      const saved = JSON.parse(localStorage.getItem(AI_SETTINGS_KEY) ?? 'null') as Partial<AiSettings> | null;
      if (!saved) return fallback;
      const provider = aiProviderIds.includes(saved.provider as AiProviderId) ? saved.provider as AiProviderId : fallback.provider;
      const preset = AI_PROVIDER_PRESETS[provider];
      const style: AiApiStyle = saved.style === 'openai' || saved.style === 'anthropic' ? saved.style : preset.style;
      return {
        provider,
        model: typeof saved.model === 'string' && saved.model.trim() ? saved.model : preset.model,
        baseUrl: typeof saved.baseUrl === 'string' ? saved.baseUrl : preset.baseUrl,
        style,
        previewOnly: typeof saved.previewOnly === 'boolean' ? saved.previewOnly : true,
        autoApprove: typeof saved.autoApprove === 'boolean' ? saved.autoApprove : false,
      };
    } catch {
      return fallback;
    }
  };
  let aiSettings = loadAiSettings();
  const aiSessionKeys: Partial<Record<AiProviderId, string>> = {};
  let aiProviderHistory: AiChatMessage[] = [];
  let aiPendingCalls: AiToolCall[] = [];
  let aiBusy = false;

  function saveAiSettings(): void {
    try {
      localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify({
        provider: aiSettings.provider,
        model: aiSettings.model,
        baseUrl: aiSettings.baseUrl,
        style: aiSettings.style,
        previewOnly: aiSettings.previewOnly,
        autoApprove: aiSettings.autoApprove,
      }));
    } catch {
      // Settings persistence is optional.
    }
  }

  function aiProviderLabel(): string {
    return AI_PROVIDER_PRESETS[aiSettings.provider].label;
  }

  function aiHasSessionKey(): boolean {
    return Boolean(aiSessionKeys[aiSettings.provider]);
  }

  function aiIsConfigured(): boolean {
    return Boolean(
      aiSettings.model.trim() &&
      aiSettings.baseUrl.trim() &&
      (!providerNeedsKey(aiSettings) || aiHasSessionKey()),
    );
  }

  function updateAiConnection(): void {
    const configured = aiIsConfigured();
    aiConnection.textContent = configured
      ? `${aiProviderLabel()} · ${aiSettings.model}`
      : providerNeedsKey(aiSettings) && !aiHasSessionKey()
        ? `${aiProviderLabel()} · API key needed`
        : `${aiProviderLabel()} · add model and base URL`;
    aiConnection.classList.toggle('connected', configured);
    aiConnection.classList.toggle('needs-key', !configured);
    aiKeyProvider.textContent = aiProviderLabel();
    aiCorsNote.classList.toggle('hidden', !/opencode\.ai/i.test(aiSettings.baseUrl));
    aiKeyNote.textContent = aiHasSessionKey()
      ? 'A session key is loaded for this provider. It will be cleared when this tab reloads.'
      : providerNeedsKey(aiSettings)
        ? 'No key for this provider yet.'
        : 'Local endpoints can work without a key.';
    aiStep.textContent = aiBusy ? 'Thinking…' : `${aiTools.length} tools available`;
  }

  function syncAiSettingsForm(): void {
    aiProvider.value = aiSettings.provider;
    aiModel.value = aiSettings.model;
    aiBase.value = aiSettings.baseUrl;
    aiStyle.value = aiSettings.style;
    aiPreview.checked = aiSettings.previewOnly;
    aiAuto.checked = aiSettings.autoApprove;
    aiAuto.disabled = aiSettings.previewOnly;
    aiKey.value = aiSessionKeys[aiSettings.provider] ?? '';
    updateAiConnection();
  }

  function setAiSettingsTab(tab: 'connection' | 'keys'): void {
    for (const button of aiSettingsTabs) {
      const active = button.dataset.aiSettingsTab === tab;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
    }
    for (const panel of aiSettingsPanels) {
      panel.classList.toggle('hidden', panel.dataset.aiSettingsPanel !== tab);
    }
    if (tab === 'keys') aiKey.focus();
  }

  function openAiSettings(tab: 'connection' | 'keys' = 'connection'): void {
    syncAiSettingsForm();
    setAiSettingsTab(tab);
    aiSettingsModal.classList.remove('hidden');
    aiSettingsModal.setAttribute('aria-hidden', 'false');
    aiSettingsStatus.textContent = aiIsConfigured() ? 'Connected for this tab.' : 'Add a model, base URL, and key to connect.';
  }

  function closeAiSettings(): void {
    aiSettingsModal.classList.add('hidden');
    aiSettingsModal.setAttribute('aria-hidden', 'true');
  }

  aiSettingsButton.addEventListener('click', () => openAiSettings('connection'));
  aiSettingsClose.addEventListener('click', closeAiSettings);
  aiSettingsDone.addEventListener('click', closeAiSettings);
  aiSettingsModal.addEventListener('pointerdown', (event) => {
    if (event.target === aiSettingsModal) closeAiSettings();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || aiSettingsModal.classList.contains('hidden')) return;
    event.preventDefault();
    closeAiSettings();
  });
  for (const button of aiSettingsTabs) {
    button.addEventListener('click', () => setAiSettingsTab(button.dataset.aiSettingsTab === 'keys' ? 'keys' : 'connection'));
  }
  aiProvider.addEventListener('change', () => {
    const provider = (aiProvider.value as AiProviderId) ?? 'openai';
    const preset = AI_PROVIDER_PRESETS[provider];
    aiSettings = {
      ...aiSettings,
      provider,
      model: preset.model,
      baseUrl: preset.baseUrl,
      style: preset.style,
    };
    aiModel.value = preset.model;
    aiBase.value = preset.baseUrl;
    aiStyle.value = preset.style;
    aiKey.value = aiSessionKeys[provider] ?? '';
    saveAiSettings();
    updateAiConnection();
  });
  aiModel.addEventListener('input', () => {
    aiSettings.model = aiModel.value;
    saveAiSettings();
    updateAiConnection();
  });
  aiBase.addEventListener('input', () => {
    aiSettings.baseUrl = aiBase.value;
    saveAiSettings();
    updateAiConnection();
  });
  aiStyle.addEventListener('change', () => {
    aiSettings.style = aiStyle.value === 'anthropic' ? 'anthropic' : aiStyle.value === 'openai' ? 'openai' : 'auto';
    saveAiSettings();
    updateAiConnection();
  });
  aiPreview.addEventListener('change', () => {
    aiSettings.previewOnly = aiPreview.checked;
    aiAuto.disabled = aiSettings.previewOnly;
    saveAiSettings();
    updateAiConnection();
  });
  aiAuto.addEventListener('change', () => {
    aiSettings.autoApprove = aiAuto.checked;
    saveAiSettings();
    updateAiConnection();
  });
  aiKey.addEventListener('input', () => {
    aiSessionKeys[aiSettings.provider] = aiKey.value;
    updateAiConnection();
  });
  aiKeyClear.addEventListener('click', () => {
    for (const id of aiProviderIds) delete aiSessionKeys[id];
    aiKey.value = '';
    updateAiConnection();
    aiSettingsStatus.textContent = 'Session keys cleared.';
  });

  function aiLog(role: 'user' | 'assistant' | 'tool' | 'error' | 'system', text: string): void {
    const message = document.createElement('div');
    message.className = `video-ai-message ${role}`;
    const label = document.createElement('span');
    label.className = 'video-ai-message-role';
    label.textContent = role === 'user' ? 'You' : role === 'assistant' ? 'AI' : role === 'tool' ? 'Tool' : role === 'error' ? 'Error' : 'AI editor';
    const body = document.createElement('span');
    body.className = 'video-ai-message-body';
    body.textContent = role === 'tool' && text.length > 2500 ? `${text.slice(0, 2500)}…` : text;
    message.append(label, body);
    aiChatLog.append(message);
    while (aiChatLog.children.length > 120) aiChatLog.firstElementChild?.remove();
    aiChatLog.scrollTop = aiChatLog.scrollHeight;
  }

  function aiWelcome(): void {
    aiLog('system', 'Connect a provider in Settings, then ask me to edit the timeline. I can inspect clips, add media, split/trim/move clips, edit effects, add titles and graphics, captions, tracks, transitions, and more.');
  }

  function aiCompact(value: unknown): string {
    try {
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      return text.length > 24000 ? `${text.slice(0, 24000)}…` : text;
    } catch {
      return String(value);
    }
  }

  function aiVideoClip(args: Record<string, unknown>): VideoClip | null {
    const id = Number(args.clipId);
    if (Number.isFinite(id)) return videos.find((clip) => clip.id === id) ?? null;
    if (selected?.kind === 'video') return videos.find((clip) => clip.id === selected!.id) ?? null;
    return activeVideo;
  }

  function aiClipTarget(args: Record<string, unknown>): { kind: 'video'; clip: VideoClip } | { kind: 'audio'; clip: AudioClip } | null {
    const id = Number(args.clipId);
    if (Number.isFinite(id)) {
      const video = videos.find((clip) => clip.id === id);
      if (video) return { kind: 'video', clip: video };
      const audio = audios.find((clip) => clip.id === id);
      if (audio) return { kind: 'audio', clip: audio };
      return null;
    }
    if (selected?.kind === 'video') {
      const clip = videos.find((entry) => entry.id === selected!.id);
      if (clip) return { kind: 'video', clip };
    }
    if (selected?.kind === 'audio') {
      const clip = audios.find((entry) => entry.id === selected!.id);
      if (clip) return { kind: 'audio', clip };
    }
    return null;
  }

  function aiEffectsInfo(clip: VideoClip): Record<string, unknown> {
    return {
      ...clip.effects,
      lut: clip.effects.lut ? { name: clip.effects.lut.name, size: clip.effects.lut.size } : null,
    };
  }

  function aiEnsureEditable(target: { kind: 'video'; clip: VideoClip } | { kind: 'audio'; clip: AudioClip }): void {
    const locked = target.kind === 'video' ? videoClipLocked(target.clip) : audioClipLocked(target.clip);
    if (locked) throw new Error('That clip is on a locked track. Unlock the track, then retry.');
  }

  function aiVideoInfo(clip: VideoClip): Record<string, unknown> {
    return {
      kind: 'video', id: clip.id, name: clip.name, start: Number(clip.start.toFixed(3)),
      end: Number((clip.start + videoClipLength(clip)).toFixed(3)), track: clip.track,
      sourceDuration: Number(clip.duration.toFixed(3)), trimStart: Number(clip.trimStart.toFixed(3)),
      trimEnd: Number(clip.trimEnd.toFixed(3)), duration: Number(videoClipLength(clip).toFixed(3)),
      image: clip.image, linked: Boolean(clip.linkGroup), linkGroup: clip.linkGroup ?? null,
      linkOffset: clip.linkOffset ?? null,
      muted: clip.mute, volume: clip.volume, transform: clip.transform,
      effects: aiEffectsInfo(clip), animation: clip.animation, transition: clip.transition ?? null,
      hasProxy: Boolean(clip.proxy),
    };
  }

  function aiAudioInfo(clip: AudioClip): Record<string, unknown> {
    return {
      kind: 'audio', id: clip.id, name: clip.name, start: Number(clip.offset.toFixed(3)),
      end: Number((clip.offset + audioClipLength(clip)).toFixed(3)), track: clip.track,
      sourceDuration: Number(clip.duration.toFixed(3)), trimStart: Number(clip.trimStart.toFixed(3)),
      trimEnd: Number(clip.trimEnd.toFixed(3)), duration: Number(audioClipLength(clip).toFixed(3)),
      linked: Boolean(clip.linkGroup), linkGroup: clip.linkGroup ?? null, muted: clip.muted,
      volume: clip.volume, fadeIn: clip.fadeIn, fadeOut: clip.fadeOut,
    };
  }

  function aiState(args: Record<string, unknown> = {}): Record<string, unknown> {
    const offset = Math.max(0, Math.floor(Number(args.offset ?? 0)) || 0);
    const limit = Math.max(1, Math.min(200, Math.floor(Number(args.limit ?? 30)) || 30));
    return {
      playhead: Number(time.toFixed(3)), duration: Number(previewEnd().toFixed(3)),
      selected: selected ? { ...selected } : null,
      tracks: {
        video: videoTrackCount, audio: audioTrackCount,
        videoState: videoTrackState.slice(0, videoTrackCount),
        audioState: audioTrackState.slice(0, audioTrackCount),
      },
      videos: videos.slice(offset, offset + limit).map(aiVideoInfo),
      audios: audios.slice(offset, offset + limit).map(aiAudioInfo),
      clipPage: { offset, limit, videoTotal: videos.length, audioTotal: audios.length },
      media: assets.map((asset) => ({ id: asset.id, name: asset.name, kind: asset.kind, duration: Number(asset.duration.toFixed(2)), hasAudio: Boolean(asset.probe.hasAudio) })),
      titles: titles.map((cue) => ({ ...cue, style: cue.style ? { ...cue.style } : undefined })), graphics: graphics.map((graphic) => ({ ...graphic })),
      captions: { source: captionSource.value, mode: captionMode.value, cues: shiftedCues().length, offset: captionOffset },
      export: { format: format.value, preset: preset.value, loudness: normalize.value, rangeIn, rangeOut },
      linkMagnet: linkClipsEnabled, canUndo: historyIndex > 0, canRedo: historyIndex < history.length - 1,
    };
  }

  const aiProp = (type: string, description: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ type, description, ...extra });
  const aiSchema = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
    type: 'object', properties, required, additionalProperties: false,
  });
  const aiTool = (name: string, description: string, parameters: Record<string, unknown>, execute: AiToolDef['execute']): AiToolDef => ({
    name, description, parameters, execute,
  });

  const AI_CLIP_ID = aiProp('number', 'Clip id from get_state. Defaults to the selected clip.');
  const AI_TIME = aiProp('number', 'Timeline time in seconds.');

  const aiTools: AiToolDef[] = [
    aiTool('get_state', 'Get the timeline, tracks, media, clips, selection, captions, and title/graphic state. Page through clips with offset and limit when the totals are larger than the returned page.', aiSchema({
      offset: aiProp('number', 'First clip index to return. Default 0.', { minimum: 0 }),
      limit: aiProp('number', 'Maximum clips of each kind to return. Default 30, max 200.', { minimum: 1, maximum: 200 }),
    }), (args) => ({ ...aiState(args), toolCount: aiTools.length })),
    aiTool('list_media', 'List media assets available in the media pool.', aiSchema({}), () => assets.map((asset) => ({ id: asset.id, name: asset.name, kind: asset.kind, duration: asset.duration, hasAudio: asset.probe.hasAudio }))),
    aiTool('add_media', 'Insert a media-pool asset into the timeline. Video with sound creates a linked video + audio pair.', aiSchema({
      assetId: aiProp('number', 'Media asset id from list_media.'),
      name: aiProp('string', 'Asset name if assetId is unknown.'),
      at: AI_TIME,
      track: aiProp('number', 'Optional video track index.'),
    }), (args) => {
      const id = Number(args.assetId);
      const name = String(args.name ?? '').toLowerCase();
      const asset = Number.isFinite(id) ? assets.find((entry) => entry.id === id) : assets.find((entry) => entry.name.toLowerCase() === name);
      if (!asset) throw new Error('Media asset not found.');
      insertAsset(asset, Number(args.at ?? time), Number.isFinite(Number(args.track)) ? Number(args.track) : undefined);
      return { inserted: asset.name, selected };
    }),
    aiTool('add_track', 'Add one or more video or audio tracks.', aiSchema({
      kind: aiProp('string', 'video or audio.', { enum: ['video', 'audio'] }),
      count: aiProp('number', 'How many tracks to add. Default 1.', { minimum: 1, maximum: 10 }),
    }), (args) => {
      const kind = args.kind === 'audio' ? 'audio' : 'video';
      const count = Math.max(1, Math.min(10, Number(args.count ?? 1) || 1));
      addTracks(kind, count);
      return { kind, count, videoTracks: videoTrackCount, audioTracks: audioTrackCount };
    }),
    aiTool('delete_track', 'Delete a video or audio track and its clips.', aiSchema({
      kind: aiProp('string', 'video or audio.', { enum: ['video', 'audio'] }),
      index: aiProp('number', 'Zero-based track index.', { minimum: 0 }),
    }, ['kind', 'index']), (args) => {
      const kind = args.kind === 'audio' ? 'audio' : 'video';
      const index = Math.max(0, Math.round(Number(args.index)));
      if (kind === 'video') deleteVideoTrack(index);
      else deleteAudioTrack(index);
      return { kind, index, videoTracks: videoTrackCount, audioTracks: audioTrackCount };
    }),
    aiTool('move_track', 'Reorder a video or audio track.', aiSchema({
      kind: aiProp('string', 'video or audio.', { enum: ['video', 'audio'] }),
      from: aiProp('number', 'Current zero-based index.', { minimum: 0 }),
      to: aiProp('number', 'New zero-based index.', { minimum: 0 }),
    }, ['kind', 'from', 'to']), (args) => {
      const kind = args.kind === 'audio' ? 'audio' : 'video';
      const from = Math.max(0, Math.round(Number(args.from)));
      const to = Math.max(0, Math.round(Number(args.to)));
      if (kind === 'video') moveVideoTrack(from, to);
      else moveAudioTrack(from, to);
      return { kind, from, to };
    }),
    aiTool('set_track', 'Set mute, hide, opacity, lock, solo, gain, or color for a track.', aiSchema({
      kind: aiProp('string', 'video or audio.', { enum: ['video', 'audio'] }),
      index: aiProp('number', 'Zero-based track index.', { minimum: 0 }),
      muted: aiProp('boolean', 'Track mute.'),
      hidden: aiProp('boolean', 'Hide a video track.'),
      opacity: aiProp('number', 'Video track opacity from 0 to 1.', { minimum: 0, maximum: 1 }),
      locked: aiProp('boolean', 'Lock or unlock the track.'),
      solo: aiProp('boolean', 'Solo the track.'),
      gain: aiProp('number', 'Track gain from 0 to 2.', { minimum: 0, maximum: 2 }),
      color: aiProp('string', 'Hex color, or empty to clear.'),
    }, ['kind', 'index']), (args) => {
      const kind = args.kind === 'audio' ? 'audio' : 'video';
      const index = Math.max(0, Math.round(Number(args.index)));
      const state = kind === 'video' ? videoTrackState[index] : audioTrackState[index];
      if (!state) throw new Error('Track not found.');
      if (typeof args.muted === 'boolean') state.muted = args.muted;
      if (typeof args.locked === 'boolean') state.locked = args.locked;
      if (typeof args.solo === 'boolean') state.solo = args.solo;
      if (typeof args.gain === 'number') state.gain = Math.max(0, Math.min(2, args.gain));
      if (typeof args.color === 'string') state.color = args.color || undefined;
      if (kind === 'video' && typeof args.hidden === 'boolean') videoTrackState[index].hidden = args.hidden;
      if (kind === 'video' && typeof args.opacity === 'number') {
        videoTrackState[index].opacity = Math.max(0, Math.min(1, args.opacity));
      }
      render();
      seek(time);
      commit('AI changed track settings');
      return { kind, index, state };
    }),
    aiTool('set_link_magnet', 'Turn linked audio/video movement on or off. Turning it on resynchronizes links.', aiSchema({
      enabled: aiProp('boolean', 'True for linked movement, false for independent movement.'),
    }, ['enabled']), (args) => {
      const enabled = Boolean(args.enabled);
      if (enabled !== linkClipsEnabled) toggleLinkedClips();
      return { linkMagnet: linkClipsEnabled };
    }),
    aiTool('sync_linked_clips', 'Resynchronize every linked audio/video pair from the video side.', aiSchema({}), () => {
      for (const clip of videos) syncLinkedAudioFromVideo(clip);
      renderTimeline();
      commit('AI synchronized linked clips');
      return { linkedPairs: videos.filter((clip) => clip.linkGroup).length };
    }),
    aiTool('select_clip', 'Select a clip and optionally seek to a time.', aiSchema({
      clipId: aiProp('number', 'Clip id from get_state.'),
      at: AI_TIME,
    }, ['clipId']), (args) => {
      const target = aiClipTarget(args);
      if (!target) throw new Error('Clip not found.');
      selected = target.kind === 'video' ? { kind: 'video', id: target.clip.id } : { kind: 'audio', id: target.clip.id };
      const start = target.kind === 'video' ? target.clip.start : target.clip.offset;
      seek(Math.max(0, Math.min(timelineEnd(), Number(args.at ?? start))));
      render();
      return { selected, playhead: time };
    }),
    aiTool('split_clip', 'Split the selected or specified clip at a timeline time.', aiSchema({ clipId: AI_CLIP_ID, at: AI_TIME }), (args) => {
      const at = Number(args.at ?? time);
      const target = aiClipTarget(args);
      if (target) selected = target.kind === 'video' ? { kind: 'video', id: target.clip.id } : { kind: 'audio', id: target.clip.id };
      seek(Math.max(0, Math.min(timelineEnd(), at)));
      splitAtPlayhead();
      return { status: status.textContent, selected };
    }),
    aiTool('trim_clip', 'Trim a clip between two timeline times in seconds.', aiSchema({
      clipId: AI_CLIP_ID,
      start: aiProp('number', 'New visible start time in seconds.'),
      end: aiProp('number', 'New visible end time in seconds.'),
    }), (args) => {
      const target = aiClipTarget(args);
      if (!target) throw new Error('Clip not found. Select a clip or pass clipId.');
      aiEnsureEditable(target);
      if (target.kind === 'video') {
        const clip = target.clip;
        const currentEnd = clip.start + videoClipLength(clip);
        const start = Math.max(clip.start, Math.min(currentEnd - 0.05, Number(args.start ?? clip.start)));
        const end = Math.max(start + 0.05, Math.min(currentEnd, Number(args.end ?? currentEnd)));
        if (clip.image) {
          clip.duration = end - start;
          clip.start = start;
        } else {
          const trimStart = clipSourceTime(clip, start - clip.start);
          const trimEnd = clip.duration - clipSourceTime(clip, end - clip.start);
          clip.trimStart = trimStart;
          clip.trimEnd = Math.max(0, trimEnd);
          clip.start = start;
        }
        syncLinkedAudioFromVideo(clip);
        selected = { kind: 'video', id: clip.id };
      } else {
        const clip = target.clip;
        const currentEnd = clip.offset + audioClipLength(clip);
        const start = Math.max(clip.offset, Math.min(currentEnd - 0.05, Number(args.start ?? clip.offset)));
        const end = Math.max(start + 0.05, Math.min(currentEnd, Number(args.end ?? currentEnd)));
        const trimStart = clipSourceTime(clip, start - clip.offset);
        const trimEnd = clip.duration - clipSourceTime(clip, end - clip.offset);
        clip.trimStart = trimStart;
        clip.trimEnd = Math.max(0, trimEnd);
        clip.offset = start;
        syncLinkedVideoFromAudio(clip);
        selected = { kind: 'audio', id: clip.id };
      }
      render();
      seek(time);
      commit('AI trimmed a clip');
      return { clip: target.kind === 'video' ? aiVideoInfo(target.clip) : aiAudioInfo(target.clip) };
    }),
    aiTool('move_clip', 'Move a clip to a new timeline time and/or track, respecting linked audio/video.', aiSchema({
      clipId: AI_CLIP_ID,
      start: AI_TIME,
      track: aiProp('number', 'New track index.', { minimum: 0 }),
    }), (args) => {
      const target = aiClipTarget(args);
      if (!target) throw new Error('Clip not found.');
      aiEnsureEditable(target);
      if (target.kind === 'video') {
        if (Number.isFinite(Number(args.start))) target.clip.start = Math.max(0, Number(args.start));
        if (Number.isFinite(Number(args.track))) {
          const track = Math.max(0, Math.round(Number(args.track)));
          if (track >= videoTrackCount) {
            videoTrackCount = track + 1;
            while (videoTrackState.length < videoTrackCount) videoTrackState.push({ hidden: false, muted: false, locked: false, solo: false });
          }
          target.clip.track = track;
        }
        syncLinkedAudioFromVideo(target.clip);
      } else {
        if (Number.isFinite(Number(args.start))) target.clip.offset = Math.max(0, Number(args.start));
        if (Number.isFinite(Number(args.track))) {
          const track = Math.max(0, Math.round(Number(args.track)));
          if (track >= audioTrackCount) {
            audioTrackCount = track + 1;
            while (audioTrackState.length < audioTrackCount) audioTrackState.push({ muted: false, locked: false, solo: false });
          }
          target.clip.track = track;
          audioRowsCache = null;
        }
        syncLinkedVideoFromAudio(target.clip);
      }
      render();
      seek(time);
      commit('AI moved a clip');
      return { clip: target.kind === 'video' ? aiVideoInfo(target.clip) : aiAudioInfo(target.clip) };
    }),
    aiTool('set_transform', 'Set static transform values for a video clip.', aiSchema({
      clipId: AI_CLIP_ID,
      scale: aiProp('number', 'Uniform scale.', { minimum: 0.05, maximum: 10 }),
      scaleX: aiProp('number', 'Horizontal stretch.', { minimum: 0.05, maximum: 10 }),
      scaleY: aiProp('number', 'Vertical stretch.', { minimum: 0.05, maximum: 10 }),
      x: aiProp('number', 'Horizontal offset percent.', { minimum: -200, maximum: 200 }),
      y: aiProp('number', 'Vertical offset percent.', { minimum: -200, maximum: 200 }),
      rotation: aiProp('number', 'Rotation degrees.', { minimum: -360, maximum: 360 }),
    }), (args) => {
      const clip = aiVideoClip(args);
      if (!clip) throw new Error('Video clip not found.');
      if (videoClipLocked(clip)) throw new Error('That clip is on a locked track. Unlock the track, then retry.');
      const next = { ...clip.transform };
      if (typeof args.scale === 'number') {
        next.scale = args.scale;
        if (typeof args.scaleX !== 'number') next.scaleX = args.scale;
        if (typeof args.scaleY !== 'number') next.scaleY = args.scale;
      }
      if (typeof args.scaleX === 'number') next.scaleX = args.scaleX;
      if (typeof args.scaleY === 'number') next.scaleY = args.scaleY;
      if (typeof args.x === 'number') next.x = args.x;
      if (typeof args.y === 'number') next.y = args.y;
      if (typeof args.rotation === 'number') next.rotation = args.rotation;
      clip.transform = clipTransform(next);
      applyPreviewTransform(clip);
      applyOriginalVolume();
      render();
      commit('AI transformed a clip');
      return { clip: aiVideoInfo(clip) };
    }),
    aiTool('set_effects', 'Set effects on a video clip.', aiSchema({
      clipId: AI_CLIP_ID,
      brightness: aiProp('number', 'Brightness -100 to 100.', { minimum: -100, maximum: 100 }),
      contrast: aiProp('number', 'Contrast -100 to 100.', { minimum: -100, maximum: 100 }),
      saturation: aiProp('number', 'Saturation -100 to 100.', { minimum: -100, maximum: 100 }),
      hue: aiProp('number', 'Hue -180 to 180.', { minimum: -180, maximum: 180 }),
      blur: aiProp('number', 'Blur 0 to 40 px.', { minimum: 0, maximum: 40 }),
      speed: aiProp('number', 'Speed 0.25 to 4.', { minimum: 0.25, maximum: 4 }),
      opacity: aiProp('number', 'Opacity 0 to 1.', { minimum: 0, maximum: 1 }),
      blend: aiProp('string', 'Blend mode.', { enum: ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'soft-light'] }),
      maskShape: aiProp('string', 'Mask shape.', { enum: ['none', 'rect', 'ellipse'] }),
      maskX: aiProp('number', 'Mask x percent.', { minimum: -100, maximum: 100 }),
      maskY: aiProp('number', 'Mask y percent.', { minimum: -100, maximum: 100 }),
      maskWidth: aiProp('number', 'Mask width percent.', { minimum: 1, maximum: 200 }),
      maskHeight: aiProp('number', 'Mask height percent.', { minimum: 1, maximum: 200 }),
      maskFeather: aiProp('number', 'Mask feather radius percent.', { minimum: 0, maximum: 50 }),
      chromaEnabled: aiProp('boolean', 'Enable chroma key.'),
      chromaColor: aiProp('string', 'Chroma key color as a CSS hex value.'),
      chromaTolerance: aiProp('number', 'Chroma tolerance 0 to 1.', { minimum: 0, maximum: 1 }),
      chromaSoftness: aiProp('number', 'Chroma edge softness 0 to 0.5.', { minimum: 0, maximum: 0.5 }),
      shadows: aiProp('number', 'Tone curve shadows -100 to 100.', { minimum: -100, maximum: 100 }),
      midtones: aiProp('number', 'Tone curve midtones -100 to 100.', { minimum: -100, maximum: 100 }),
      highlights: aiProp('number', 'Tone curve highlights -100 to 100.', { minimum: -100, maximum: 100 }),
    }), (args) => {
      const clip = aiVideoClip(args);
      if (!clip) throw new Error('Video clip not found.');
      if (videoClipLocked(clip)) throw new Error('That clip is on a locked track. Unlock the track, then retry.');
      const effects = { ...clip.effects };
      if (typeof args.brightness === 'number') effects.brightness = args.brightness;
      if (typeof args.contrast === 'number') effects.contrast = args.contrast;
      if (typeof args.saturation === 'number') effects.saturation = args.saturation;
      if (typeof args.hue === 'number') effects.hue = args.hue;
      if (typeof args.blur === 'number') effects.blur = args.blur;
      if (typeof args.speed === 'number' && !clip.image && !speedEditLocked(clip)) effects.speed = args.speed;
      if (typeof args.opacity === 'number') effects.opacity = args.opacity;
      if (typeof args.blend === 'string') effects.blend = args.blend as ClipEffects['blend'];
      if (typeof args.maskShape === 'string' || typeof args.maskX === 'number' || typeof args.maskY === 'number' || typeof args.maskWidth === 'number' || typeof args.maskHeight === 'number' || typeof args.maskFeather === 'number') {
        effects.mask = { ...effects.mask };
        if (args.maskShape === 'none' || args.maskShape === 'rect' || args.maskShape === 'ellipse') effects.mask.shape = args.maskShape;
        if (typeof args.maskX === 'number') effects.mask.x = args.maskX;
        if (typeof args.maskY === 'number') effects.mask.y = args.maskY;
        if (typeof args.maskWidth === 'number') effects.mask.width = args.maskWidth;
        if (typeof args.maskHeight === 'number') effects.mask.height = args.maskHeight;
        if (typeof args.maskFeather === 'number') effects.mask.feather = args.maskFeather;
      }
      if (typeof args.chromaEnabled === 'boolean' || typeof args.chromaColor === 'string' || typeof args.chromaTolerance === 'number' || typeof args.chromaSoftness === 'number') {
        effects.chroma = { ...effects.chroma };
        if (typeof args.chromaEnabled === 'boolean') effects.chroma.enabled = args.chromaEnabled;
        if (typeof args.chromaColor === 'string') effects.chroma.color = args.chromaColor;
        if (typeof args.chromaTolerance === 'number') effects.chroma.tolerance = args.chromaTolerance;
        if (typeof args.chromaSoftness === 'number') effects.chroma.softness = args.chromaSoftness;
      }
      if (typeof args.shadows === 'number' || typeof args.midtones === 'number' || typeof args.highlights === 'number') {
        effects.curve = { ...effects.curve };
        if (typeof args.shadows === 'number') effects.curve.shadows = args.shadows;
        if (typeof args.midtones === 'number') effects.curve.midtones = args.midtones;
        if (typeof args.highlights === 'number') effects.curve.highlights = args.highlights;
      }
      clip.effects = normalizeEffects(effects);
      if (typeof args.speed === 'number') syncRetimeAudio(clip);
      applyPreviewTransform(clip);
      render();
      commit('AI changed clip effects');
      return { effects: aiEffectsInfo(clip) };
    }),
    aiTool('set_volume', 'Set volume or mute for a video or audio clip.', aiSchema({
      clipId: AI_CLIP_ID,
      volume: aiProp('number', 'Volume from 0 to 3.', { minimum: 0, maximum: 3 }),
      mute: aiProp('boolean', 'Mute or unmute.'),
    }), (args) => {
      const target = aiClipTarget(args);
      if (!target) throw new Error('Clip not found.');
      aiEnsureEditable(target);
      if (typeof args.volume === 'number') target.clip.volume = Math.max(0, Math.min(3, args.volume));
      if (typeof args.mute === 'boolean') {
        if (target.kind === 'video') target.clip.mute = args.mute;
        else target.clip.muted = args.mute;
      }
      applyOriginalVolume();
      syncMedia(true);
      render();
      commit('AI changed clip volume');
      return { clip: target.kind === 'video' ? aiVideoInfo(target.clip) : aiAudioInfo(target.clip) };
    }),
    aiTool('set_transition', 'Apply a fade-in, fade-out, dip-to-black, push, slide, barn-door, split, or remove the transition on a clip.', aiSchema({
      clipId: AI_CLIP_ID,
      kind: aiProp('string', 'Transition type.', { enum: ['fade-in', 'fade-out', 'dip', 'push', 'slide', 'barn-door', 'split', 'none'] }),
    }, ['kind']), (args) => {
      const target = aiClipTarget(args);
      if (!target) throw new Error('Clip not found.');
      selected = target.kind === 'video' ? { kind: 'video', id: target.clip.id } : { kind: 'audio', id: target.clip.id };
      selectedGraphic = -1;
      selectedTitle = -1;
      selectedSubtitleKey = '';
      applyTransitionTo(String(args.kind ?? 'none'), target);
      return { status: status.textContent };
    }),
    aiTool('add_title', 'Add a text/title overlay at a timeline time.', aiSchema({
      text: aiProp('string', 'Title text.'),
      start: AI_TIME,
      duration: aiProp('number', 'Duration in seconds.', { minimum: 0.2, maximum: 120 }),
    }, ['text']), (args) => {
      const start = Math.max(0, Number(args.start ?? time));
      const duration = Math.max(0.2, Math.min(120, Number(args.duration ?? 3)));
      const cue: Cue = {
        start,
        end: start + duration,
        text: String(args.text ?? ''),
        style: defaultTitleTextStyle(),
        track: firstFreeOverlayTrack(start, start + duration),
      };
      titles.push(cue);
      selected = null;
      selectedTitle = titles.length - 1;
      selectedSubtitleKey = '';
      selectedGraphic = -1;
      invalidateShiftedCues();
      captionLaneKey = '';
      render();
      seek(start);
      commit('AI added a title');
      return { index: selectedTitle, title: cue };
    }),
    aiTool('update_title', 'Edit an existing title overlay by index.', aiSchema({
      index: aiProp('number', 'Zero-based title index. Defaults to the selected title.', { minimum: 0 }),
      text: aiProp('string', 'New title text.'),
      start: AI_TIME,
      duration: aiProp('number', 'New duration in seconds.', { minimum: 0.2, maximum: 120 }),
    }), (args) => {
      const index = Number.isFinite(Number(args.index))
        ? Math.round(Number(args.index))
        : selectedTitle >= 0 && selectedTitle < titles.length ? selectedTitle : 0;
      const cue = titles[index];
      if (!cue) throw new Error('Title not found.');
      if (typeof args.text === 'string') cue.text = args.text;
      if (typeof args.start === 'number') cue.start = Math.max(0, args.start);
      if (typeof args.duration === 'number') {
        cue.end = cue.start + Math.max(0.2, Math.min(120, args.duration));
      } else if (typeof args.start === 'number' && cue.end < cue.start + 0.2) {
        cue.end = cue.start + 0.2;
      }
      selectedTitle = index;
      invalidateShiftedCues();
      captionLaneKey = '';
      render();
      renderTitlePanel();
      commit('AI edited a title');
      return { index, title: cue };
    }),
    aiTool('delete_title', 'Delete a title overlay by index.', aiSchema({
      index: aiProp('number', 'Zero-based title index. Defaults to the selected title.', { minimum: 0 }),
    }), (args) => {
      const index = Number.isFinite(Number(args.index))
        ? Math.round(Number(args.index))
        : selectedTitle >= 0 && selectedTitle < titles.length ? selectedTitle : 0;
      if (!titles[index]) throw new Error('Title not found.');
      const [removed] = titles.splice(index, 1);
      selectedTitle = Math.min(index, titles.length - 1);
      invalidateShiftedCues();
      captionLaneKey = '';
      render();
      renderTitlePanel();
      commit('AI deleted a title');
      return { removed, titles: titles.length };
    }),
    aiTool('add_graphic', 'Add a rectangle, ellipse, or line overlay.', aiSchema({
      kind: aiProp('string', 'Graphic type.', { enum: ['rect', 'ellipse', 'line'] }),
      start: AI_TIME,
      duration: aiProp('number', 'Duration in seconds.', { minimum: 0.2, maximum: 120 }),
      x: aiProp('number', 'X percent.', { minimum: -50, maximum: 150 }),
      y: aiProp('number', 'Y percent.', { minimum: -50, maximum: 150 }),
      width: aiProp('number', 'Width percent.', { minimum: 1, maximum: 100 }),
      height: aiProp('number', 'Height percent.', { minimum: 0, maximum: 100 }),
      fill: aiProp('string', 'CSS hex color.'),
      stroke: aiProp('string', 'CSS hex color.'),
      opacity: aiProp('number', 'Opacity 0 to 1.', { minimum: 0, maximum: 1 }),
      rotation: aiProp('number', 'Rotation degrees.', { minimum: -180, maximum: 180 }),
    }, ['kind']), (args) => {
      const kind = args.kind === 'ellipse' ? 'ellipse' : args.kind === 'line' ? 'line' : 'rect';
      const start = Math.max(0, Number(args.start ?? time));
      const duration = Math.max(0.2, Math.min(120, Number(args.duration ?? 4)));
      const graphic = defaultGraphic(kind, ++nextId, start, start + duration);
      graphic.track = firstFreeOverlayTrack(start, start + duration);
      if (typeof args.x === 'number') graphic.x = args.x;
      if (typeof args.y === 'number') graphic.y = args.y;
      if (typeof args.width === 'number') graphic.width = args.width;
      if (typeof args.height === 'number') graphic.height = args.height;
      if (typeof args.fill === 'string') graphic.fill = args.fill;
      if (typeof args.stroke === 'string') graphic.stroke = args.stroke;
      if (typeof args.opacity === 'number') graphic.opacity = Math.max(0, Math.min(1, args.opacity));
      if (typeof args.rotation === 'number') graphic.rotation = Math.max(-180, Math.min(180, args.rotation));
      graphics.push(graphic);
      selectedGraphic = graphics.length - 1;
      render();
      seek(start);
      commit('AI added a graphic');
      return { graphic };
    }),
    aiTool('update_graphic', 'Edit an existing rectangle, ellipse, or line overlay.', aiSchema({
      graphicId: aiProp('number', 'Graphic id from get_state. Defaults to the selected overlay.', { minimum: 0 }),
      start: AI_TIME,
      duration: aiProp('number', 'New duration in seconds.', { minimum: 0.2, maximum: 120 }),
      x: aiProp('number', 'X percent.', { minimum: -50, maximum: 150 }),
      y: aiProp('number', 'Y percent.', { minimum: -50, maximum: 150 }),
      width: aiProp('number', 'Width percent.', { minimum: 1, maximum: 100 }),
      height: aiProp('number', 'Height percent.', { minimum: 0, maximum: 100 }),
      fill: aiProp('string', 'CSS hex color.'),
      stroke: aiProp('string', 'CSS hex color.'),
      strokeWidth: aiProp('number', 'Stroke width in pixels.', { minimum: 0, maximum: 40 }),
      opacity: aiProp('number', 'Opacity 0 to 1.', { minimum: 0, maximum: 1 }),
      rotation: aiProp('number', 'Rotation degrees.', { minimum: -180, maximum: 180 }),
      radius: aiProp('number', 'Corner radius in pixels.', { minimum: 0, maximum: 200 }),
    }), (args) => {
      const id = Number(args.graphicId);
      const index = Number.isFinite(id) ? graphics.findIndex((entry) => entry.id === id) : selectedGraphic;
      const graphic = graphics[index];
      if (!graphic) throw new Error('Graphic not found.');
      if (typeof args.x === 'number') graphic.x = Math.max(-50, Math.min(150, args.x));
      if (typeof args.y === 'number') graphic.y = Math.max(-50, Math.min(150, args.y));
      if (typeof args.width === 'number') graphic.width = Math.max(1, Math.min(100, args.width));
      if (typeof args.height === 'number') graphic.height = Math.max(0, Math.min(100, args.height));
      if (typeof args.fill === 'string') graphic.fill = args.fill;
      if (typeof args.stroke === 'string') graphic.stroke = args.stroke;
      if (typeof args.strokeWidth === 'number') graphic.strokeWidth = Math.max(0, Math.min(40, args.strokeWidth));
      if (typeof args.opacity === 'number') graphic.opacity = Math.max(0, Math.min(1, args.opacity));
      if (typeof args.rotation === 'number') graphic.rotation = Math.max(-180, Math.min(180, args.rotation));
      if (typeof args.radius === 'number') graphic.radius = Math.max(0, Math.min(200, args.radius));
      if (typeof args.start === 'number') {
        const length = graphic.end - graphic.start;
        graphic.start = Math.max(0, args.start);
        graphic.end = graphic.start + length;
      }
      if (typeof args.duration === 'number') {
        graphic.end = graphic.start + Math.max(0.2, Math.min(120, args.duration));
      }
      selectedGraphic = index;
      render();
      renderGraphicsPanel();
      commit('AI edited a graphic');
      return { graphic };
    }),
    aiTool('delete_graphic', 'Delete a rectangle, ellipse, or line overlay.', aiSchema({
      graphicId: aiProp('number', 'Graphic id from get_state. Defaults to the selected overlay.', { minimum: 0 }),
    }), (args) => {
      const id = Number(args.graphicId);
      const index = Number.isFinite(id) ? graphics.findIndex((entry) => entry.id === id) : selectedGraphic;
      const graphic = graphics[index];
      if (!graphic) throw new Error('Graphic not found.');
      graphics.splice(index, 1);
      selectedGraphic = Math.min(index, graphics.length - 1);
      render();
      renderGraphicsPanel();
      commit('AI deleted a graphic');
      return { removed: graphic, graphics: graphics.length };
    }),
    aiTool('set_captions', 'Set caption source and mode.', aiSchema({
      source: aiProp('string', 'none, transcript, or file.', { enum: ['none', 'transcript', 'file'] }),
      mode: aiProp('string', 'soft or burn.', { enum: ['soft', 'burn'] }),
    }, ['source']), (args) => {
      if (captionTrackState.locked) throw new Error('Unlock the captions track to change its source.');
      const source = args.source === 'transcript' ? 'transcript' : args.source === 'file' ? 'file' : 'none';
      captionSource.value = source;
      if (args.mode === 'burn' || args.mode === 'soft') captionMode.value = args.mode;
      updateCaptions();
      render();
      commit('AI changed captions');
      return { source, mode: captionMode.value, cues: shiftedCues().length };
    }),
    aiTool('remove_silences', 'Remove silence spans from the timeline and close the gaps.', aiSchema({
      threshold: aiProp('number', 'Minimum silence in seconds.', { minimum: 0.25, maximum: 10 }),
    }), (args) => {
      removeTranscriptSilences(Math.max(0.25, Number(args.threshold ?? 0.7)));
      return { status: status.textContent };
    }),
    aiTool('remove_filler_words', 'Remove filler words from the transcript and timeline.', aiSchema({}), () => {
      removeFillerWords();
      return { status: status.textContent };
    }),
    aiTool('set_aspect', 'Set the project output aspect/preset.', aiSchema({
      preset: aiProp('string', 'source, vertical, square, 2160p, 1080p, 720p, or 480p.', { enum: ['source', 'vertical', 'square', '2160p', '1080p', '720p', '480p'] }),
    }, ['preset']), (args) => {
      const value = String(args.preset ?? 'source');
      preset.value = value;
      aspectSelect.value = value === 'vertical' || value === 'square' ? value : 'source';
      updatePreviewFrame();
      updateProjectBar();
      render();
      commit('AI changed project aspect');
      return { preset: preset.value, aspect: aspectSelect.value };
    }),
    aiTool('set_export', 'Choose export container and preset.', aiSchema({
      format: aiProp('string', 'mp4, mkv, mov, or webm.', { enum: ['mp4', 'mkv', 'mov', 'webm'] }),
      preset: aiProp('string', 'source, vertical, square, 2160p, 1080p, 720p, or 480p.', { enum: ['source', 'vertical', 'square', '2160p', '1080p', '720p', '480p'] }),
    }), (args) => {
      if (typeof args.format === 'string') format.value = args.format;
      if (typeof args.preset === 'string') preset.value = args.preset;
      updateExportMenu();
      commit('AI changed export settings');
      return { format: format.value, preset: preset.value };
    }),
    aiTool('set_loudness', 'Set the export loudness normalization.', aiSchema({
      mode: aiProp('string', 'off, podcast (-16 LUFS), or social (-14 LUFS).', { enum: ['off', 'podcast', 'social'] }),
    }, ['mode']), (args) => {
      const mode = args.mode === 'podcast' ? 'podcast' : args.mode === 'social' ? 'social' : 'off';
      normalize.value = mode;
      commit('AI changed loudness normalization');
      return { loudness: normalize.value };
    }),
    aiTool('mark_range', 'Set the export In/Out range.', aiSchema({
      in: aiProp('number', 'In point in seconds.'),
      out: aiProp('number', 'Out point in seconds.'),
    }), (args) => {
      if (typeof args.in === 'number') rangeIn = Math.max(0, Math.min(playbackEnd(), args.in));
      if (typeof args.out === 'number') rangeOut = Math.max(0, Math.min(playbackEnd(), args.out));
      if (rangeIn !== null && rangeOut !== null && rangeOut <= rangeIn) rangeOut = null;
      updateRangeMarkers();
      commit('AI marked an export range');
      return { rangeIn, rangeOut };
    }),
    aiTool('seek', 'Move the playhead.', aiSchema({ time: AI_TIME }, ['time']), (args) => {
      seek(Math.max(0, Math.min(timelineEnd(), Number(args.time))));
      return { playhead: time };
    }),
    aiTool('rename_project', 'Rename the current project.', aiSchema({
      name: aiProp('string', 'New project name.'),
    }, ['name']), (args) => {
      const name = String(args.name ?? '').trim();
      if (!name) throw new Error('Project name cannot be empty.');
      projectName.value = name;
      projectNameIsDefault = false;
      updateProjectBar();
      commit('AI renamed the project');
      return { name: projectName.value };
    }),
    aiTool('undo', 'Undo the last edit.', aiSchema({}), () => { undo(); return { canUndo: historyIndex > 0, canRedo: historyIndex < history.length - 1 }; }),
    aiTool('redo', 'Redo the next edit.', aiSchema({}), () => { redo(); return { canUndo: historyIndex > 0, canRedo: historyIndex < history.length - 1 }; }),
    aiTool('delete_clip', 'Delete the selected or specified clip, including its linked counterpart.', aiSchema({ clipId: AI_CLIP_ID }), (args) => {
      const target = aiClipTarget(args);
      if (!target) throw new Error('Clip not found.');
      selected = target.kind === 'video' ? { kind: 'video', id: target.clip.id } : { kind: 'audio', id: target.clip.id };
      removeSelected();
      return { status: status.textContent };
    }),
    aiTool('ripple_delete', 'Delete a clip and close the gap on all tracks.', aiSchema({ clipId: AI_CLIP_ID }), (args) => {
      const target = aiClipTarget(args);
      if (!target) throw new Error('Clip not found.');
      selected = target.kind === 'video' ? { kind: 'video', id: target.clip.id } : { kind: 'audio', id: target.clip.id };
      rippleDeleteSelected();
      return { status: status.textContent };
    }),
    aiTool('duplicate_clip', 'Duplicate the selected or specified clip.', aiSchema({ clipId: AI_CLIP_ID }), (args) => {
      const target = aiClipTarget(args);
      if (!target) throw new Error('Clip not found.');
      selected = target.kind === 'video' ? { kind: 'video', id: target.clip.id } : { kind: 'audio', id: target.clip.id };
      duplicateSelected();
      return { status: status.textContent };
    }),
    aiTool('copy_clip', 'Copy the selected or specified clip to the editor clipboard.', aiSchema({ clipId: AI_CLIP_ID }), (args) => {
      const target = aiClipTarget(args);
      if (!target) throw new Error('Clip not found.');
      selected = target.kind === 'video' ? { kind: 'video', id: target.clip.id } : { kind: 'audio', id: target.clip.id };
      return { copied: copySelected(), selected };
    }),
    aiTool('cut_clip', 'Cut the selected or specified clip to the editor clipboard.', aiSchema({ clipId: AI_CLIP_ID }), (args) => {
      const target = aiClipTarget(args);
      if (!target) throw new Error('Clip not found.');
      selected = target.kind === 'video' ? { kind: 'video', id: target.clip.id } : { kind: 'audio', id: target.clip.id };
      cutSelected();
      return { status: status.textContent };
    }),
    aiTool('paste_clip', 'Paste the editor clipboard at the playhead, or at a given time.', aiSchema({ at: AI_TIME }), (args) => {
      if (typeof args.at === 'number') seek(Math.max(0, Math.min(timelineEnd(), args.at)));
      pasteClipboard();
      return { status: status.textContent, selected };
    }),
    aiTool('add_keyframe', 'Add a keyframe to a video clip property.', aiSchema({
      clipId: AI_CLIP_ID,
      property: aiProp('string', 'scale, x, y, rotation, opacity, volume, brightness, contrast, saturation, hue, or blur.', { enum: ['scale', 'x', 'y', 'rotation', 'opacity', 'volume', 'brightness', 'contrast', 'saturation', 'hue', 'blur'] }),
      value: aiProp('number', 'Keyframe value.'),
      at: aiProp('number', 'Clip-local time in seconds. Defaults to the playhead.'),
    }, ['clipId', 'property', 'value']), (args) => {
      const clip = videos.find((entry) => entry.id === Number(args.clipId));
      if (!clip) throw new Error('Video clip not found.');
      if (videoClipLocked(clip)) throw new Error('That clip is on a locked track. Unlock the track, then retry.');
      const property = String(args.property) as keyof ClipAnimation;
      if (!(property in clip.animation)) throw new Error('Unknown keyframe property.');
      const at = Number(args.at ?? clipLocalTime(clip));
      clip.animation[property] = withKeyframe(clip.animation[property], at, Number(args.value), 'linear');
      applyPreviewTransform(clip);
      render();
      commit('AI added a keyframe');
      return { clipId: clip.id, property, at, keys: clip.animation[property] };
    }),
    aiTool('clear_keyframes', 'Clear all keyframes, or one property, on a video clip.', aiSchema({
      clipId: AI_CLIP_ID,
      property: aiProp('string', 'Optional property to clear. Clears every property when omitted.', { enum: ['scale', 'x', 'y', 'rotation', 'opacity', 'volume', 'brightness', 'contrast', 'saturation', 'hue', 'blur'] }),
    }), (args) => {
      const clip = aiVideoClip(args);
      if (!clip) throw new Error('Video clip not found.');
      if (videoClipLocked(clip)) throw new Error('That clip is on a locked track. Unlock the track, then retry.');
      const next = { ...clip.animation } as ClipAnimation;
      if (typeof args.property === 'string') {
        const property = args.property as keyof ClipAnimation;
        if (!(property in next)) throw new Error('Unknown keyframe property.');
        next[property] = [];
      } else {
        for (const key of Object.keys(next) as (keyof ClipAnimation)[]) next[key] = [];
      }
      clip.animation = normalizeAnimation(next);
      applyPreviewTransform(clip);
      render();
      commit('AI cleared keyframes');
      return { clipId: clip.id, animation: clip.animation };
    }),
    aiTool('add_camera_cut', 'Switch the active multi-camera angle at a time.', aiSchema({
      track: aiProp('number', 'Video track index.', { minimum: 0 }),
      at: AI_TIME,
    }, ['track']), (args) => {
      const track = Math.max(0, Math.round(Number(args.track)));
      const at = Math.max(0, Number(args.at ?? time));
      cameraCuts = cameraCuts.filter((cut) => Math.abs(cut.at - at) > 0.05);
      cameraCuts.push({ at, track });
      cameraCuts.sort((a, b) => a.at - b.at);
      render();
      seek(at);
      commit('AI added a camera cut');
      return { at, track };
    }),
    aiTool('clear_camera_cuts', 'Remove every multi-camera cut.', aiSchema({}), () => {
      cameraCuts = [];
      render();
      seek(time);
      commit('AI cleared camera cuts');
      return { cameraCuts: 0 };
    }),
    aiTool('open_export', 'Open the export dialog without starting an export.', aiSchema({}), () => { openExportModal(); return { opened: true }; }),
    aiTool('get_transcript', 'Get the loaded transcript cues.', aiSchema({}), () => options.getTranscriptCues() ?? []),
  ];

  const aiToolSpecs: AiToolSpec[] = aiTools.map(({ name, description, parameters }) => ({ name, description, parameters }));
  const AI_READ_ONLY_TOOLS = new Set(['get_state', 'list_media', 'get_transcript', 'seek', 'select_clip']);

  function aiSystemPrompt(): string {
    const selection = selected
      ? `Selected ${selected.kind} clip id ${selected.id}.`
      : 'Nothing selected.';
    return [
      'You are LocalScribe AI Editor, an expert non-linear video editor using local tools.',
      'Use tool calls to inspect and edit the timeline. Never invent tool names or claim an edit succeeded if the tool result does not say so.',
      'Call get_state before editing when you need clip ids, track indices, or timing. If clipPage shows more clips than it returned, call get_state again with offset to page through them.',
      'Prefer a small number of precise tool calls. Ask one clarifying question if the request is genuinely ambiguous.',
      'The project is local: video, audio, titles, graphics, captions, tracks, keyframes, transitions, multicam, and export are all real editor tools.',
      `Playhead ${formatClock(time, true)}; ${videos.length} video clips; ${audios.length} audio clips; ${videoTrackCount} video tracks; ${audioTrackCount} audio tracks. ${selection}`,
      'Read-only tools (get_state, list_media, get_transcript, seek, select_clip) run immediately. Editing tools change the project.',
      aiSettings.previewOnly
        ? 'Preview mode is ON: editing tool calls are queued for the user to review before they run. Do not say an edit was applied.'
        : aiSettings.autoApprove
          ? 'Auto-approve is ON: editing tool calls run immediately.'
          : 'Editing tool calls are queued for confirmation before they run.',
    ].join('\n');
  }

  async function aiExecuteTool(call: AiToolCall): Promise<string> {
    const tool = aiTools.find((entry) => entry.name === call.name);
    if (!tool) return `Unknown tool: ${call.name}`;
    try {
      const result = await tool.execute(call.arguments ?? {});
      return aiCompact(result);
    } catch (error) {
      return `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  function aiShowPending(): void {
    aiPending.replaceChildren();
    if (!aiPendingCalls.length) {
      aiPending.classList.add('hidden');
      return;
    }
    const title = document.createElement('p');
    title.className = 'video-ai-pending-title';
    title.textContent = `Proposed edits · ${aiPendingCalls.length} tool call${aiPendingCalls.length === 1 ? '' : 's'}`;
    const list = document.createElement('div');
    list.className = 'video-ai-pending-list';
    for (const call of aiPendingCalls) {
      const row = document.createElement('div');
      row.className = 'video-ai-pending-item';
      const name = document.createElement('strong');
      name.textContent = call.name;
      const args = document.createElement('code');
      args.textContent = JSON.stringify(call.arguments);
      row.append(name, args);
      list.append(row);
    }
    const actions = document.createElement('div');
    actions.className = 'video-ai-pending-actions';
    const apply = document.createElement('button');
    apply.type = 'button';
    apply.className = 'btn-primary';
    apply.textContent = 'Apply edits';
    apply.addEventListener('click', () => void aiApplyPending());
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn-ghost';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', aiCancelPending);
    actions.append(apply, cancel);
    aiPending.append(title, list, actions);
    aiPending.classList.remove('hidden');
    updateAiConnection();
  }

  async function aiRunToolCalls(calls: readonly AiToolCall[]): Promise<number> {
    let failures = 0;
    for (const call of calls) {
      aiLog('tool', `Running ${call.name}…`);
      const result = await aiExecuteTool(call);
      if (result.startsWith('Error:')) failures += 1;
      aiLog('tool', result);
      aiProviderHistory.push({ role: 'tool', toolCallId: call.id, name: call.name, content: result });
    }
    return failures;
  }

  async function aiApplyPending(): Promise<void> {
    if (!aiPendingCalls.length || aiBusy) return;
    const calls = [...aiPendingCalls];
    aiPendingCalls = [];
    aiPending.classList.add('hidden');
    aiBusy = true;
    aiSend.disabled = true;
    aiClear.disabled = true;
    aiStep.textContent = 'Applying edits…';
    try {
      const failures = await aiRunToolCalls(calls);
      const applied = calls.length - failures;
      const summary = failures
        ? `Applied ${applied} of ${calls.length} edits; ${failures} failed. Check the tool log above.`
        : `Applied ${calls.length} edit${calls.length === 1 ? '' : 's'}.`;
      aiProviderHistory.push({ role: 'assistant', content: summary });
      aiLog('assistant', summary);
      if (failures) status.textContent = summary;
    } finally {
      aiBusy = false;
      aiSend.disabled = false;
      aiClear.disabled = false;
      updateAiConnection();
    }
  }

  function aiCancelPending(): void {
    const calls = [...aiPendingCalls];
    aiPendingCalls = [];
    aiPending.classList.add('hidden');
    for (const call of calls) {
      aiProviderHistory.push({
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        content: 'Cancelled by the user. No changes were made.',
      });
    }
    aiLog('system', 'Proposed edits discarded.');
    updateAiConnection();
  }

  async function aiRunTurn(text: string): Promise<void> {
    const prompt = text.trim();
    if (!prompt || aiBusy) return;
    if (aiPendingCalls.length) {
      status.textContent = 'Apply or cancel the proposed edits first.';
      return;
    }
    if (providerNeedsKey(aiSettings) && !aiHasSessionKey()) {
      openAiSettings('keys');
      const article = /^[aeiou]/i.test(aiProviderLabel()) ? 'an' : 'a';
      aiSettingsStatus.textContent = `Add ${article} ${aiProviderLabel()} API key to connect.`;
      return;
    }
    if (!aiSettings.model.trim() || !aiSettings.baseUrl.trim()) {
      openAiSettings('connection');
      aiSettingsStatus.textContent = 'Add a model and base URL first.';
      return;
    }
    aiMessage.value = '';
    aiLog('user', prompt);
    aiProviderHistory.push({ role: 'user', content: prompt });
    aiBusy = true;
    aiSend.disabled = true;
    aiClear.disabled = true;
    aiStep.textContent = 'Thinking…';
    try {
      for (let step = 0; step < 6; step += 1) {
        const result = await callAiProvider({
          settings: aiSettings,
          apiKey: aiSessionKeys[aiSettings.provider] ?? '',
          system: aiSystemPrompt(),
          messages: aiProviderHistory,
          tools: aiToolSpecs,
        });
        if (result.text) aiLog('assistant', result.text);
        if (!result.toolCalls.length) {
          aiProviderHistory.push({ role: 'assistant', content: result.text });
          break;
        }
        const auto = !aiSettings.previewOnly && aiSettings.autoApprove;
        if (!auto) {
          const inspect = result.toolCalls.filter((call) => AI_READ_ONLY_TOOLS.has(call.name));
          const edits = result.toolCalls.filter((call) => !AI_READ_ONLY_TOOLS.has(call.name));
          if (!edits.length) {
            aiProviderHistory.push({ role: 'assistant', content: result.text, toolCalls: inspect });
            await aiRunToolCalls(inspect);
            continue;
          }
          aiProviderHistory.push({
            role: 'assistant',
            content: result.text || 'I prepared these timeline edits.',
            toolCalls: result.toolCalls,
          });
          if (inspect.length) await aiRunToolCalls(inspect);
          aiPendingCalls = edits;
          aiLog('system', 'Review the proposed edits below, then apply or cancel them.');
          aiShowPending();
          break;
        }
        aiProviderHistory.push({ role: 'assistant', content: result.text, toolCalls: result.toolCalls });
        await aiRunToolCalls(result.toolCalls);
      }
    } catch (error) {
      if (aiProviderHistory[aiProviderHistory.length - 1]?.role === 'user') aiProviderHistory.pop();
      const message = error instanceof Error ? error.message : String(error);
      aiLog('error', message);
      status.textContent = message;
    } finally {
      aiBusy = false;
      aiSend.disabled = false;
      aiClear.disabled = false;
      updateAiConnection();
    }
  }

  aiSend.addEventListener('click', () => void aiRunTurn(aiMessage.value));
  aiMessage.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    void aiRunTurn(aiMessage.value);
  });
  aiClear.addEventListener('click', () => {
    aiProviderHistory = [];
    aiPendingCalls = [];
    aiPending.classList.add('hidden');
    aiChatLog.replaceChildren();
    aiWelcome();
    updateAiConnection();
  });

  aiWelcome();
  syncAiSettingsForm();
  updateAiConnection();

  // Voiceover ----------------------------------------------------------------
  async function addRecordedVoice(file: File, at: number, signal: AbortSignal): Promise<void> {
    const url = URL.createObjectURL(file);
    let probe: MediaProbe | null = null;
    try {
      probe = await sharedMedia().probe(file, signal);
    } catch (error) {
      if (isAbortError(error)) throw error;
    }
    let duration = probe?.duration ?? 0;
    if (!duration) duration = (await readMetadata(url, 'audio')).duration;
    if (!duration) {
      URL.revokeObjectURL(url);
      throw new Error('The voiceover was recorded, but its length could not be read.');
    }
    const peaks = await decodePeaks(file, signal, duration);
    const asset = addAsset(file, 'audio', duration, probe ?? probeFallback(duration, false), null, peaks);
    const wasEmpty = !videos.length && !audios.length;
    const clip: AudioClip = {
      id: ++nextId, file, name: file.name, duration, offset: Math.min(at, playbackEnd()),
      trimStart: 0, trimEnd: 0, volume: 1, fadeIn: 0, fadeOut: 0,
      track: findFreeAudioTrack(at, at + duration),
      muted: false,
      tracks: (probe?.audioStreams ?? []).map(describeTrack),
      url, peaks, ...makeAudio(url),
    };
    audios.push(clip);
    audioRowsCache = null;
    selected = { kind: 'audio', id: clip.id };
    if (wasEmpty) fitTimeline();
    renderMediaPool();
    render();
    seek(Math.min(at, playbackEnd()));
    commit();
    status.textContent = `Voiceover added at the playhead and to the media pool (${asset.name}).`;
  }

  function startVoiceover(): void {
    if (operation || recording) return;
    pause();
    const at = time;
    recording = { at };
    recordPanel.classList.remove('hidden');
    recordTime.textContent = '0:00';
    recordLevel.style.width = '2%';
    status.textContent = 'Requesting the microphone…';
    update();
    void recorder.start(({ elapsed, level }) => {
      if (!recording) return;
      recordTime.textContent = formatClock(elapsed);
      recordLevel.style.width = `${Math.max(2, Math.round(level * 100))}%`;
    }, 'speech').then(() => {
      if (!recording) return;
      status.textContent = 'Recording voiceover. Press Stop when you are done.';
      update();
    }).catch((error) => {
      recording = null;
      recordPanel.classList.add('hidden');
      status.textContent = errorMessage(error);
      update();
    });
  }

  function stopVoiceover(): void {
    const capture = recording;
    if (!capture) return;
    recording = null;
    recordPanel.classList.add('hidden');
    update();
    const job = options.trackJob?.('Recording voiceover');
    void run('Finishing the voiceover…', async (signal) => {
      const file = await recorder.stop();
      await addRecordedVoice(file, capture.at, signal);
    }).then(() => {
      if (status.textContent.startsWith('Voiceover added')) job?.finish(status.textContent);
      else job?.finish(status.textContent || 'Voiceover failed.', false);
    });
  }

  function cancelVoiceover(): void {
    if (!recording) return;
    recorder.cancel();
    recording = null;
    recordPanel.classList.add('hidden');
    status.textContent = 'Voiceover cancelled.';
    update();
  }

  // Export -------------------------------------------------------------------
  function settings(overrides: Partial<MergeSettings> = {}): MergeSettings {
    const size = Number(targetSizeInput.value);
    return {
      keepOriginal: keepOriginal.checked,
      originalVolume: Number(originalVolume.value) / 100,
      duck: duck.checked,
      duckCaptions: duckCaptions.checked,
      format: format.value as MergeFormat,
      preset: preset.value as MergePreset,
      customWidth,
      customHeight,
      frameRate: projectFpsOverride ?? undefined,
      targetMB: size > 0 ? size : null,
      exactCuts: exactCuts.checked,
      normalize: normalize.value as MergeLoudness,
      quality: 90,
      ...overrides,
    };
  }

  function outputDimensions(): { width: number; height: number; fit: 'contain' | 'cover' } {
    const first = videos.find((clip) => !clip.image) ?? videos[0];
    return targetSize(preset.value as MergePreset, {
      width: first?.probe.width || 1280,
      height: first?.probe.height || 720,
    }, undefined, { width: customWidth, height: customHeight });
  }

  function previewSourceUrl(clip: VideoClip): string {
    if (clip.proxy?.compatibility && clip.proxyUrl) return clip.proxyUrl;
    if (previewQuality === 'full') return clip.url;
    if (scrubbing && clip === activeVideo && preview.getAttribute('src') === clip.url) return clip.url;
    return clip.proxyUrl || clip.url;
  }

  function fitStageToWorkspace(): void {
    if (!window.matchMedia('(min-width: 1000px)').matches) {
      stage.style.width = '';
      stage.style.height = '';
      measureStageViewport();
      return;
    }
    const width = stageWrap.clientWidth;
    const height = stageWrap.clientHeight;
    if (width < 40 || height < 40) return;
    const size = outputDimensions();
    const ratio = size.width / Math.max(1, size.height);
    let nextWidth: number;
    let nextHeight: number;
    if (previewZoom === 'fit') {
      nextWidth = width;
      nextHeight = nextWidth / ratio;
      if (nextHeight > height) {
        nextHeight = height;
        nextWidth = nextHeight * ratio;
      }
    } else {
      const multiplier = Math.max(0.1, Number(previewZoom) || 1);
      nextWidth = width * multiplier;
      nextHeight = nextWidth / ratio;
    }
    stageViewportWidth = Math.max(1, Math.floor(nextWidth));
    stageViewportHeight = Math.max(1, Math.floor(nextHeight));
    stage.style.width = `${stageViewportWidth}px`;
    stage.style.height = `${stageViewportHeight}px`;
  }

  function updatePreviewFrame(): void {
    const size = outputDimensions();
    stage.style.aspectRatio = `${size.width} / ${size.height}`;
    stage.style.setProperty('--stage-ratio', String(size.width / size.height));
    fitStageToWorkspace();
    preview.style.objectFit = size.fit;
    still.style.objectFit = size.fit;
    applyPreviewTransform(activeVideo, false);
    const guides = preset.value === 'vertical' || preset.value === 'square';
    safe.classList.toggle('hidden', !(guides || safeGuides));
    if (aspectSelect.value !== preset.value) {
      const aspect = preset.value === 'vertical' || preset.value === 'square' ? preset.value : 'source';
      aspectSelect.value = aspect;
    }
    updateTransformOverlay();
    renderGraphicsPreview();
    renderGpuPreview(activeVideo);
  }

  function jobCaptions(): ExportJob['captions'] {
    const list = styledOverlayCues();
    const mode = titles.length || captionMode.value === 'burn' ? 'burn' : 'soft';
    const ass = mode === 'burn' ? styledAssSegments() : [];
    if (!list.length && !ass.length) return null;
    return {
      cues: list.filter((cue) => !ass.length || !(cue as Partial<EmbeddedTimelineCue>).assStyled)
        .map((cue) => titles.includes(cue) ? { ...cue, opacity: videoTrackOpacity(titleTrackIndex(cue)) } : cue),
      mode,
      style: subtitleBaseStyle(),
      ass,
    };
  }

  function hasVideoOverlap(list: VideoClip[]): boolean {
    const sorted = [...list].sort((a, b) => a.start - b.start);
    let end = -Infinity;
    for (const clip of sorted) {
      if (clip.start < end - 0.001) return true;
      end = Math.max(end, clip.start + videoClipLength(clip));
    }
    return false;
  }

  function flattenVideoTracks(list: VideoClip[]): VideoClip[] {
    const total = totalVideo();
    if (total <= 0.01) return [];
    const visible = list.filter((clip) => !videoTrackHidden(clip.track));
    const points = [0, total, ...cameraCuts.map((cut) => cut.at)];
    for (const clip of visible) {
      points.push(clip.start);
      points.push(clip.start + videoClipLength(clip));
    }
    points.sort((a, b) => a - b);
    const unique = points.filter((value, index) => value > -0.001 && value <= total + 0.001 && (index === 0 || value - points[index - 1] > 0.02));
    const result: VideoClip[] = [];
    for (let index = 0; index < unique.length - 1; index += 1) {
      const start = Math.max(0, unique[index]);
      const end = Math.min(total, unique[index + 1]);
      if (end - start <= 0.02) continue;
      const clip = visibleVideoAt(visible, start + 0.001, activeCameraTrack(start));
      if (!clip) continue;
      const from = Math.max(start, clip.start);
      const to = Math.min(end, clip.start + videoClipLength(clip));
      const length = to - from;
      if (length <= 0.02) continue;
      if (clip.image) {
        result.push({
          ...clip,
          dynamicZoomTiming: dynamicZoomTimingFor(clip, from - clip.start),
          animationTimeOffset: (clip.animationTimeOffset ?? 0) + from - clip.start,
          track: 0,
          start: from,
          duration: length,
          mute: clip.mute || videoTrackMuted(clip.track),
          volume: clip.volume * videoTrackGain(clip.track),
        });
      } else {
        const trimStart = clipSourceTime(clip, from - clip.start);
        const trimEnd = Math.max(0, clip.duration - clipSourceTime(clip, to - clip.start));
        result.push({
          ...clip,
          dynamicZoomTiming: dynamicZoomTimingFor(clip, from - clip.start),
          animationTimeOffset: (clip.animationTimeOffset ?? 0) + from - clip.start,
          track: 0,
          start: from,
          trimStart,
          trimEnd,
          mute: clip.mute || videoTrackMuted(clip.track),
          volume: clip.volume * videoTrackGain(clip.track),
        });
      }
    }
    return result;
  }

  function exportTracks(): { videos: VideoClip[]; audios: AudioClip[] } {
    const rows = audioRows();
    const visible = videos
      .filter((clip) => !videoTrackHidden(clip.track))
      .map((clip) => ({
        ...clip,
        effects: {
          ...clip.effects,
          opacity: clip.effects.opacity * videoTrackOpacity(clip.track),
        },
      }));
    const flatten = cameraCuts.length > 0 || hasVideoOverlap(visible);
    return {
      videos: flatten
        ? flattenVideoTracks(visible)
        : visible.map((clip) => ({
          ...clip,
          mute: clip.mute || videoTrackMuted(clip.track),
          volume: clip.volume * videoTrackGain(clip.track),
        })),
      audios: audios.map((clip) => ({
        ...clip,
        sourceTrack: clip.sourceTrack ?? 0,
        muted: clip.muted || audioTrackMuted(rows.get(clip.id) ?? 0),
        volume: clip.volume * audioTrackGain(rows.get(clip.id) ?? 0),
      })),
    };
  }

  function hasAudibleAudio(tracks = exportTracks()): boolean {
    const original = keepOriginal.checked && tracks.videos.some((clip) =>
      !clip.image && clip.probe.hasAudio && !clip.mute && clip.volume > 0);
    const added = tracks.audios.some((clip) => !clip.muted && clip.volume > 0);
    return original || added;
  }

  function estimateMB(
    current: ReturnType<typeof settings>,
    tracks = exportTracks(),
    duration = totalVideo(),
  ): number {
    if (current.targetMB) return current.targetMB;
    const total = duration;
    if (total <= 0) return 0;
    const burn = !captionTrackState.hidden && captionMode.value === 'burn' && cues().length > 0;
    if (!burn && canCopyVideo(tracks.videos, current.format, current)) {
      const videoBytes = tracks.videos.reduce((sum, clip) =>
        sum + clip.file.size * (videoClipLength(clip) / Math.max(0.001, clip.duration)), 0);
      const audioBytes = tracks.audios.reduce((sum, clip) =>
        sum + clip.file.size * (audioClipLength(clip) / Math.max(0.001, clip.duration)), 0);
      return (videoBytes + audioBytes) / 1_000_000;
    }
    const rates: Record<MergePreset, number> = {
      source: 5_000_000, '2160p': 28_000_000, '1080p': 6_000_000, '720p': 3_500_000,
      '480p': 1_800_000, vertical: 6_000_000, square: 5_000_000, custom: 6_000_000,
    };
    return total * (rates[current.preset ?? 'source'] + (hasAudibleAudio(tracks) ? 192_000 : 0)) / 8 / 1_000_000;
  }

  // Export range, presets, and the custom export dialog -----------------------
  function rangeBounds(): { start: number; end: number } | null {
    if (rangeIn === null || rangeOut === null) return null;
    const start = Math.min(rangeIn, rangeOut);
    const end = Math.max(rangeIn, rangeOut);
    return end - start >= 0.15 ? { start, end } : null;
  }

  function updateRangeMarkers(): void {
    const scale = pps();
    const mark = (element: HTMLElement, at: number | null, active: boolean): void => {
      element.classList.toggle('hidden', at === null);
      if (at !== null) element.style.left = `${at * scale}px`;
      element.classList.toggle('active', active);
    };
    mark(rangeInMarker, rangeIn, rangeIn !== null);
    mark(rangeOutMarker, rangeOut, rangeOut !== null);
    const range = rangeBounds();
    rangeRegion.classList.toggle('hidden', !range);
    if (range) {
      rangeRegion.style.left = `${range.start * scale}px`;
      rangeRegion.style.width = `${Math.max(2, (range.end - range.start) * scale)}px`;
    }
    markInButton.classList.toggle('active', rangeIn !== null);
    markOutButton.classList.toggle('active', rangeOut !== null);
    exportRangeMarked.disabled = !range;
    exportRangeHint.textContent = range
      ? `${formatClock(range.start, true)} → ${formatClock(range.end, true)} · ${formatClock(range.end - range.start, true)}`
      : 'Set I and O on the timeline';
    if (!range && exportRangeMarked.checked) exportRangeAll.checked = true;
  }

  function setRangeIn(): void {
    if (!videos.length) return;
    rangeIn = time;
    if (rangeOut !== null && rangeOut <= rangeIn + 0.05) rangeOut = null;
    updateRangeMarkers();
    updateExportMenu();
    status.textContent = `Export starts at ${formatClock(rangeIn, true)}. Press O to set the end.`;
  }

  function setRangeOut(): void {
    if (!videos.length) return;
    rangeOut = time;
    if (rangeIn !== null && rangeIn >= rangeOut - 0.05) rangeIn = null;
    updateRangeMarkers();
    updateExportMenu();
    status.textContent = `Export ends at ${formatClock(rangeOut, true)}. Press I to set the start.`;
  }

  function clearRange(): void {
    rangeIn = null;
    rangeOut = null;
    updateRangeMarkers();
    updateExportMenu();
    status.textContent = 'Export range cleared.';
  }

  function sliceForRange(
    sourceVideos: VideoClip[],
    sourceAudios: AudioClip[],
    sourceCues: Cue[],
    start: number,
    end: number,
  ): { videos: VideoClip[]; audios: AudioClip[]; cues: Cue[] } {
    const length = end - start;
    const videosOut: VideoClip[] = [];
    for (const clip of sourceVideos) {
      const from = clip.start;
      const to = from + videoClipLength(clip);
      const a = Math.max(from, start);
      const b = Math.min(to, end);
      if (b - a <= 0.02) continue;
      const copy: VideoClip = {
        ...clip, start: a - start, dynamicZoomTiming: dynamicZoomTimingFor(clip, a - from),
        animationTimeOffset: (clip.animationTimeOffset ?? 0) + a - from,
      };
      if (clip.image) {
        copy.duration = b - a;
      } else {
        copy.trimStart = clipSourceTime(clip, a - from);
        copy.trimEnd = Math.max(0, clip.duration - clipSourceTime(clip, b - from));
      }
      videosOut.push(copy);
    }
    const audiosOut: AudioClip[] = [];
    for (const clip of sourceAudios) {
      const from = clip.offset;
      const to = from + audioClipLength(clip);
      const a = Math.max(from, start);
      const b = Math.min(to, end);
      if (b - a <= 0.02) continue;
      const copy: AudioClip = {
        ...clip,
        offset: a - start,
        trimStart: clipSourceTime(clip, a - from),
        fadeIn: Math.min(clip.fadeIn, b - a),
        fadeOut: Math.min(clip.fadeOut, b - a),
      };
      copy.trimEnd = Math.max(0, clip.duration - clipSourceTime(clip, b - from));
      audiosOut.push(copy);
    }
    const cues: Cue[] = [];
    for (const cue of sourceCues) {
      const a = Math.max(0, cue.start - start);
      const b = Math.min(length, cue.end - start);
      if (b - a > 0.03 && cue.text.trim()) cues.push({ ...cue, start: a, end: b });
    }
    return { videos: videosOut, audios: audiosOut, cues };
  }

  function presetOverrides(key: string): Partial<MergeSettings> | null {
    switch (key) {
      // "Standard" follows the project's timeline resolution, including a
      // custom size, instead of forcing the first clip's source size.
      case 'standard': return { format: 'mp4', preset: preset.value as MergePreset, quality: 90, targetMB: null };
      case '4k': return { format: 'mp4', preset: '2160p', quality: 88, targetMB: null };
      case '1080p': return { format: 'mp4', preset: '1080p', quality: 94, targetMB: null };
      case '720p': return { format: 'mp4', preset: '720p', quality: 88, targetMB: null };
      case 'vertical': return { format: 'mp4', preset: 'vertical', quality: 90, targetMB: null };
      default: return null;
    }
  }

  function estimateSeconds(current: MergeSettings, duration: number): number {
    if (duration <= 0) return 0;
    const factors: Record<MergePreset, number> = {
      source: 0.9, '2160p': 3.2, '1080p': 1.2, '720p': 0.65,
      '480p': 0.35, vertical: 1.4, square: 1.1, custom: 1.2,
    };
    const factor = current.format === 'webm' ? 1.35 : 1;
    return Math.max(3, Math.round(3 + duration * factors[current.preset ?? 'source'] * factor));
  }

  function exportDuration(): number {
    // Quick presets export the whole timeline; the custom dialog chooses a range.
    return totalVideo();
  }

  function updateExportMenu(): void {
    const duration = exportDuration();
    const tracks = exportTracks();
    for (const key of ['standard', '4k', '1080p', '720p', 'vertical']) {
      const overrides = presetOverrides(key);
      if (!overrides) continue;
      const current = settings(overrides);
      const element = root.querySelector<HTMLElement>(`[data-export-estimate="${key}"]`);
      if (element) {
        const mb = estimateMB(current, tracks, duration);
        const seconds = estimateSeconds(current, duration);
        element.textContent = `Est. ~${seconds}s · ~${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
      }
    }
    const audioEstimate = root.querySelector<HTMLElement>('[data-export-estimate="audio"]');
    if (audioEstimate) {
      const mb = duration * 48_000 * 2 * 2 / 1_000_000;
      audioEstimate.textContent = `Est. ~${Math.max(2, Math.round(duration * 0.2))}s · ~${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
    }
    const size = outputDimensions();
    exportSourceMeta.textContent = `${size.width}×${size.height} · ${fpsLabel(fpsOfProject())}`;
  }

  function setExportMenu(open: boolean): void {
    exportMenu.classList.toggle('hidden', !open);
    exportToggle.setAttribute('aria-expanded', String(open));
    exportControl.classList.toggle('open', open);
    if (open) {
      setProjectMenu(false);
      updateExportMenu();
    }
  }

  function openExportModal(): void {
    if (!videos.length) {
      status.textContent = 'Add at least one video or image before exporting.';
      return;
    }
    const containers = Object.entries(MERGE_FORMATS);
    exportContainer.replaceChildren(...containers.map(([value, spec]) => new Option(spec.label, value)));
    exportContainer.value = format.value;
    const presets = Object.entries(MERGE_PRESETS);
    exportResolution.replaceChildren(...presets.map(([value, spec]) => new Option(spec.label, value)));
    exportResolution.value = preset.value;
    exportQuality.value = '90';
    exportQualityValue.textContent = '90%';
    exportTarget.value = targetSizeInput.value;
    exportLoudness.value = normalize.value;
    exportExact.checked = exactCuts.checked;
    exportAudioFormat.replaceChildren(
      ...Object.entries(AUDIO_FORMATS).map(([value, spec]) => new Option(spec.label, value)),
    );
    if (!Object.hasOwn(AUDIO_FORMATS, exportAudioFormat.value)) exportAudioFormat.value = 'mp3';
    exportModeVideo.checked = true;
    exportPlatform = 'source';
    for (const card of exportModal.querySelectorAll<HTMLElement>('[data-export-platform]')) {
      card.classList.toggle('active', card.dataset.exportPlatform === 'source');
    }
    const range = rangeBounds();
    exportRangeMarked.disabled = !range;
    exportRangeAll.checked = true;
    updateRangeMarkers();
    updateModalSummary();
    exportModal.classList.remove('hidden');
    exportClose.focus({ preventScroll: true });
  }

  function closeExportModal(): void {
    exportModal.classList.add('hidden');
  }

  const audioExportMode = (): boolean => exportModeAudio.checked;

  function modalSettings(): MergeSettings {
    const target = Number(exportTarget.value);
    return settings({
      format: exportContainer.value as MergeFormat,
      preset: exportResolution.value as MergePreset,
      quality: Number(exportQuality.value),
      targetMB: target > 0 ? target : null,
      normalize: exportLoudness.value as MergeLoudness,
      exactCuts: exportExact.checked,
    });
  }

  function updateModalSummary(): void {
    const available = rangeBounds();
    const range = exportRangeMarked.checked && !exportRangeMarked.disabled ? available : null;
    const duration = range ? range.end - range.start : totalVideo();
    const audioMode = audioExportMode();
    exportAudioFormatField.classList.toggle('hidden', !audioMode);
    exportPlatformSection.classList.toggle('hidden', audioMode);
    exportVideoSettings.classList.toggle('hidden', audioMode);
    exportButton.textContent = audioMode ? 'Export audio' : 'Export video';
    exportQualityValue.textContent = `${exportQuality.value}%`;
    exportRangeHint.textContent = available
      ? `${formatClock(available.start, true)} → ${formatClock(available.end, true)} · ${formatClock(available.end - available.start, true)}`
      : 'Set I and O on the timeline';
    if (audioMode) {
      const spec = AUDIO_FORMATS[exportAudioFormat.value as AudioFormat] ?? AUDIO_FORMATS.mp3;
      exportSummary.textContent = `${formatClock(duration, true)} · ${spec.label} audio only${range ? ' · marked range' : ''}`;
      return;
    }
    const current = modalSettings();
    const tracks = exportTracks();
    const mb = estimateMB(current, tracks, duration);
    const seconds = estimateSeconds(current, duration);
    const first = videos.find((clip) => !clip.image) ?? videos[0];
    const size = targetSize(current.preset ?? 'source', {
      width: first?.probe.width || 1280,
      height: first?.probe.height || 720,
    }, undefined, { width: current.customWidth, height: current.customHeight });
    exportSummary.textContent =
      `${formatClock(duration, true)} · ${size.width}×${size.height} · ~${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB` +
      ` · estimated ~${seconds}s${range ? ' · marked range' : ''}`;
  }

  for (const card of exportModal.querySelectorAll<HTMLElement>('[data-export-platform]')) {
    card.addEventListener('click', () => {
      exportPlatform = (card.dataset.exportPlatform ?? 'source') as typeof exportPlatform;
      const resolution: Record<typeof exportPlatform, MergePreset> = {
        source: preset.value as MergePreset,
        youtube: '1080p',
        tiktok: 'vertical',
        square: 'square',
        twitter: '1080p',
      };
      exportResolution.value = resolution[exportPlatform];
      exportContainer.value = 'mp4';
      for (const item of exportModal.querySelectorAll<HTMLElement>('[data-export-platform]')) {
        item.classList.toggle('active', item === card);
      }
      updateModalSummary();
    });
  }
  for (const control of [exportContainer, exportResolution, exportTarget, exportLoudness, exportExact, exportModeVideo, exportModeAudio, exportAudioFormat]) {
    control.addEventListener('change', updateModalSummary);
  }
  exportQuality.addEventListener('input', updateModalSummary);
  for (const radio of [exportRangeAll, exportRangeMarked]) {
    radio.addEventListener('change', updateModalSummary);
  }
  exportClose.addEventListener('click', closeExportModal);
  exportCancel.addEventListener('click', closeExportModal);
  exportModal.addEventListener('click', (event) => {
    if (event.target === exportModal) closeExportModal();
  });
  markInButton.addEventListener('click', setRangeIn);
  markOutButton.addEventListener('click', setRangeOut);
  markClearButton.addEventListener('click', clearRange);

  async function exportAudio(target: AudioFormat, range?: { start: number; end: number } | null): Promise<void> {
    if (!videos.length || operation || recording) return;
    let tracks = exportTracks();
    if (range) {
      const sliced = sliceForRange(tracks.videos, tracks.audios, jobCaptions()?.cues ?? [], range.start, range.end);
      if (!sliced.videos.length) {
        status.textContent = 'The marked range has no visible video.';
        return;
      }
      tracks = { videos: sliced.videos, audios: sliced.audios };
    }
    if (!tracks.videos.length) {
      status.textContent = 'Every video track is hidden. Show a track before exporting.';
      return;
    }
    pause();
    const current = settings({ format: 'mp4' });
    const plain = canSkipSoundtrackMix(
      tracks.videos,
      tracks.audios.map((clip) => ({ ...clip, mute: clip.muted })),
      current,
      null,
    );
    const mix = buildAudioMixPlan(
      tracks.videos,
      tracks.audios.map((clip) => ({ ...clip, mute: clip.muted })),
      current,
      current.duckCaptions ? shiftedCues() : undefined,
    );
    if (!plain && !mix) {
      status.textContent = 'There is no audible track to export.';
      return;
    }
    const base = tracks.videos[0].name.replace(/\.[^.]+$/, '') || 'video';
    const name = `${base}-audio.${target}`;
    const job = options.trackJob?.('Exporting ' + name);
    await run(plain ? 'Copying the soundtrack…' : 'Mixing the audio…', async (signal) => {
      work.reset();
      let copied = false;
      let blob: Blob | null = null;
      if (plain) {
        const { exportAudioOnly } = await import('./video-export');
        blob = await exportAudioOnly({
          videos: tracks.videos.map((clip) => ({ ...clip, blob: clip.file })),
          audios: tracks.audios.map((clip) => ({ ...clip, blob: clip.file, mute: clip.muted })),
          settings: current,
          signal,
          onProgress: (fraction, label) => {
            kind = 'work';
            progressBox.classList.remove('hidden');
            progressLabel.textContent = label;
            progressDetail.textContent = work.describe(fraction);
            progressSub.textContent = 'Runs on this device';
            bar(fraction * 100);
            job?.update(fraction, label);
          },
        });
        copied = Boolean(blob);
      }
      if (!blob && mix) {
        blob = await ffmpeg.run(
          [...tracks.videos.map((clip) => clip.file), ...tracks.audios.map((clip) => clip.file)],
          mix.args,
          mix.output,
          mix.mime,
          {
            signal,
            duration: mix.duration,
            onProgress: ({ ratio }) => {
              const fraction = ratio ?? 0;
              kind = 'work';
              progressBox.classList.remove('hidden');
              progressLabel.textContent = 'Mixing the audio';
              progressDetail.textContent = work.describe(fraction);
              progressSub.textContent = 'Runs on this device';
              bar(fraction * 100);
              job?.update(fraction, 'Mixing the audio');
            },
          },
        );
      }
      if (!blob) throw new Error('There is no audible track to export.');
      // A stream-copied AAC track can be used as-is for M4A. Every other
      // format (and every mixed track) needs one local encode.
      if (!copied || target !== 'm4a') {
        const label = `Encoding ${AUDIO_FORMATS[target].label}`;
        blob = await ffmpeg.encode(blob, target, {
          signal,
          onProgress: ({ ratio }) => {
            const fraction = ratio ?? 0;
            kind = 'work';
            progressLabel.textContent = label;
            progressDetail.textContent = work.describe(fraction);
            bar(fraction * 100);
            job?.update(fraction, label);
          },
        });
      }
      options.download(blob, name);
      status.textContent = `Saved ${name} (${(blob.size / 1_000_000).toFixed(1)} MB · audio only${copied ? ' · stream copied' : ''}).`;
      job?.finish(status.textContent);
    }).catch(() => undefined);
    if (status.textContent && !status.textContent.startsWith('Saved')) job?.finish(status.textContent, false);
  }

  async function runExport(
    current: MergeSettings,
    optionsIn: { range?: { start: number; end: number } | null } = {},
  ): Promise<void> {
    if (!videos.length || operation || recording) return;
    let tracks = exportTracks();
    if (!tracks.videos.length) {
      status.textContent = 'Every video track is hidden. Show a track before exporting.';
      return;
    }
    let captions = jobCaptions();
    if (optionsIn.range) {
      const sliced = sliceForRange(
        tracks.videos,
        tracks.audios,
        captions?.cues ?? [],
        optionsIn.range.start,
        optionsIn.range.end,
      );
      if (!sliced.videos.length) {
        status.textContent = 'The marked range has no visible video.';
        return;
      }
      tracks = { videos: sliced.videos, audios: sliced.audios };
      if (captions) {
        const { start, end } = optionsIn.range;
        const ass = captions.ass?.flatMap((segment) => {
          const from = Math.max(start, segment.start);
          const to = Math.min(end, segment.end);
          return to > from ? [{
            ...segment, start: from - start, end: to - start,
            sourceStart: segment.sourceStart + (from - segment.start) * segment.speed,
          }] : [];
        });
        captions = { ...captions, cues: sliced.cues, ass };
      }
    }
    pause();
    const base = tracks.videos[0].name.replace(/\.[^.]+$/, '') || 'video';
    const suffix = optionsIn.range ? '-range' : tracks.audios.length ? '-with-audio' : '-merged';
    const name = `${base}${suffix}.${current.format}`;
    const destination = await pickDestination(name);
    if (destination === 'cancel') return;
    const job = options.trackJob?.('Exporting ' + name);
    await run('Preparing export…', async (signal) => {
      work.reset();
      const { exportVideo } = await import('./video-export');
      let lastProgressAt = -Infinity;
      const result = await exportVideo({
        videos: tracks.videos.map((clip) => ({ ...clip, blob: clip.file })),
        audios: tracks.audios.map((clip) => ({ ...clip, blob: clip.file, mute: clip.muted })),
        settings: current,
        captions,
        graphics: graphics
          .filter((graphic) => !videoTrackHidden(graphicTrackIndex(graphic)))
          .map((graphic) => ({
            ...graphic,
            opacity: graphic.opacity * videoTrackOpacity(graphicTrackIndex(graphic)),
          })),
        writable: destination,
        signal,
        onProgress: (fraction, label) => {
          const now = performance.now();
          if (fraction < 1 && now - lastProgressAt < 100) return;
          lastProgressAt = now;
          kind = 'work';
          progressBox.classList.remove('hidden');
          progressLabel.textContent = label;
          progressDetail.textContent = work.describe(fraction);
          progressSub.textContent = destination ? `Writing to ${name} on your disk` : 'Runs on this device';
          bar(fraction * 100);
          job?.update(fraction, label);
        },
      });
      if (result.blob) options.download(result.blob, name);
      const how = result.engine === 'webcodecs'
        ? `${result.copied ? 'video copied' : 'browser encoder'} · ${result.audioCopied ? 'sound copied' : 'sound mixed'}`
        : `${result.copied ? 'video copied' : 'FFmpeg encoder'} · sound mixed`;
      status.textContent = `Saved ${name} (${(result.bytes / 1_000_000).toFixed(1)} MB · ${how}).`;
      job?.finish(status.textContent);
    }).catch(() => undefined);
    if (status.textContent && !status.textContent.startsWith('Saved')) job?.finish(status.textContent, false);
  }

  function quickExport(key: string): void {
    if (operation || recording) return;
    if (!videos.length) {
      status.textContent = 'Add at least one video or image before exporting.';
      return;
    }
    setExportMenu(false);
    if (key === 'custom') {
      openExportModal();
      return;
    }
    if (key === 'audio') {
      void exportAudio('mp3');
      return;
    }
    const overrides = presetOverrides(key);
    if (overrides) void runExport(settings(overrides));
  }


  function update(): void {
    const busy = operation !== null;
    const recordingNow = recording !== null;
    const blocked = busy || recordingNow;
    updateProjectBar();
    const hasVideo = videos.length > 0;
    const any = hasVideo || audios.length > 0 || assets.length > 0;
    const current = settings();
    const burn = !captionTrackState.hidden && captionMode.value === 'burn' && cues().length > 0;
    const tracks = exportTracks();
    const copy = !burn && canCopyVideo(tracks.videos, current.format, current);
    const hasTrims = tracks.videos.some((clip) => clip.trimStart > 0 || clip.trimEnd > 0);

    const hasMedia = hasVideo || audios.length > 0 || assets.length > 0;
    const hasTimelineContent = hasVideo || audios.length > 0 || titles.length > 0 || graphics.length > 0;
    document.body.classList.toggle('video-editor-open', hasMedia);
    emptyStage.classList.toggle('hidden', hasTimelineContent);
    emptyTitle.textContent = hasTimelineContent ? '' : hasMedia ? 'Add a video or image' : 'Start a project';
    emptyHint.textContent = hasTimelineContent
      ? ''
      : hasMedia
        ? 'Drag a clip from the media pool onto the timeline, or add more media.'
        : 'Drop video, audio, or images anywhere. Everything stays on this device.';
    exportButton.disabled = blocked || !hasVideo || !tracks.videos.length;
    exportMain.disabled = blocked || !hasVideo || !tracks.videos.length;
    exportToggle.disabled = blocked || !hasVideo;
    markInButton.disabled = blocked || !hasVideo;
    markOutButton.disabled = blocked || !hasVideo;
    markClearButton.disabled = blocked || (rangeIn === null && rangeOut === null);
    reset.disabled = blocked;
    mediaInput.disabled = blocked;
    cancel.classList.toggle('hidden', !busy);
    playButton.disabled = previewEnd() <= 0.001 || recordingNow;
    recordButton.disabled = busy;
    if (recordLabel) recordLabel.textContent = recordingNow ? 'Stop voiceover' : 'Voiceover';
    recordButton.classList.toggle('recording', recordingNow);
    recordPanel.classList.toggle('hidden', !recordingNow);
    recordStop.disabled = !recordingNow;
    recordCancel.disabled = !recordingNow;
    undoButton.disabled = historyIndex <= 0 || blocked;
    redoButton.disabled = historyIndex < 0 || historyIndex >= history.length - 1 || blocked;
    splitButton.disabled = blocked || !canSplitAtPlayhead();
    fitButton.disabled = !any || blocked;
    addTrackButton.disabled = blocked || !any;
    for (const control of [format, preset, targetSizeInput, duck, duckCaptions, exactCuts, normalize, keepOriginal, originalVolume]) {
      control.disabled = blocked;
    }
    originalVolume.disabled = blocked || !keepOriginal.checked;
    duck.disabled = blocked || !keepOriginal.checked;
    duckCaptions.disabled = blocked || !keepOriginal.checked || !duck.checked || !shiftedCues().length;
    const captionsBlocked = blocked || captionTrackState.locked;
    for (const button of captionPresetButtons) {
      button.disabled = captionsBlocked;
      button.setAttribute('aria-pressed', String(button.dataset.captionPreset === captionPreset));
    }
    const importedAss = captionSource.value === 'embedded' && videos.some((clip) => clip.embeddedCaptions?.assScript);
    const presetNote = importedAss && captionPreset !== 'default'
      ? 'Choose Default / Original to restore the embedded ASS styling.'
      : captionPreset !== 'default' && captionMode.value === 'soft'
        ? 'Burn subtitles into the picture to include this style in the export.'
        : '';
    captionPresetNote.classList.toggle('hidden', !presetNote);
    if (captionPresetNote.textContent !== presetNote) captionPresetNote.textContent = presetNote;
    captionSource.disabled = captionsBlocked;
    captionFile.disabled = captionsBlocked;
    const none = captionSource.value === 'none';
    const burnMode = captionMode.value === 'burn';
    captionMode.disabled = captionsBlocked || none;
    captionOffsetInput.disabled = captionsBlocked || none;
    captionPosition.disabled = captionsBlocked || none || !burnMode;
    captionSize.disabled = captionsBlocked || none || !burnMode;
    captionDownload.disabled = blocked || !shiftedCues().length;

    updatePreviewFrame();
    updateHistoryButtons();
    updateTimelineTools();
    updateRangeMarkers();
    updateExportMenu();

    if (!hasVideo) {
      exportNote.textContent = 'Add at least one video or image.';
      outputSummary.textContent = '';
      captionWarning.textContent = '';
      exportWarning.textContent = '';
      updateRangeMarkers();
      return;
    }

    const size = outputDimensions();
    outputSummary.textContent = `${size.width}×${size.height} · ${formatClock(totalVideo(), true)} · ≈ ${estimateMB(current, tracks).toFixed(1)} MB`;
    const warnings: string[] = [];
    if (!tracks.videos.length) warnings.push('Every video track is hidden.');
    const audioEnd = Math.max(0, ...audios.map((clip) => clip.offset + audioClipLength(clip)));
    if (audioEnd > totalVideo() + 0.05) {
      warnings.push(`${formatClock(audioEnd - totalVideo(), true)} of audio extends past the video and will be cut.`);
    }
    if (current.targetMB && current.format !== 'webm') {
      const floor = 150_000;
      if (current.targetMB * 8_000_000 / Math.max(0.1, totalVideo()) < floor * 1.2) {
        warnings.push('That target is very small for this duration; the encoder will hit its minimum bitrate.');
      }
    }
    if (copy && hasTrims && !current.exactCuts) {
      warnings.push('Copied cuts align to keyframes. Turn on Exact cuts for frame-accurate trims.');
    }
    if (current.format === 'mov' && !captionTrackState.hidden && captionMode.value === 'soft' && shiftedCues().length) {
      captionWarning.textContent = 'MOV cannot store this soft subtitle track. Choose MP4 or MKV, or burn the captions in.';
    } else {
      captionWarning.textContent = '';
    }
    exportWarning.textContent = warnings.join(' ');
    exportNote.textContent = `${tracks.videos.length} clip${tracks.videos.length === 1 ? '' : 's'} · ${formatClock(totalVideo(), true)} · everything runs on this device.`;
  }
  for (const control of [format, preset, targetSizeInput, duck, duckCaptions, exactCuts, normalize, keepOriginal]) {
    control.addEventListener('change', () => {
      invalidateFingerprint();
      update();
    });
  }
  originalVolume.addEventListener('input', () => {
    invalidateFingerprint();
    update();
  });

  async function pickDestination(name: string): Promise<FileSystemWritableFileStream | null | 'cancel'> {
    const picker = (window as unknown as { showSaveFilePicker?: (options: unknown) => Promise<FileSystemFileHandle> }).showSaveFilePicker;
    if (!picker) return null;
    const extension = name.split('.').pop()!;
    try {
      const handle = await picker({
        suggestedName: name,
        types: [{ description: MERGE_FORMATS[extension as MergeFormat].label + ' video', accept: { [MERGE_FORMATS[extension as MergeFormat].mime]: ['.' + extension] } }],
      });
      return await handle.createWritable();
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return 'cancel';
      return null;
    }
  }

  exportMain.addEventListener('click', () => quickExport('standard'));
  exportToggle.addEventListener('click', (event) => {
    event.stopPropagation();
    setExportMenu(exportMenu.classList.contains('hidden'));
  });
  for (const item of root.querySelectorAll<HTMLButtonElement>('[data-export-preset]')) {
    item.addEventListener('click', () => {
      const key = item.dataset.exportPreset;
      if (key) quickExport(key);
    });
  }
  exportButton.addEventListener('click', () => {
    const range = exportRangeMarked.checked && !exportRangeMarked.disabled ? rangeBounds() : null;
    const audioMode = audioExportMode();
    const format = exportAudioFormat.value as AudioFormat;
    closeExportModal();
    if (audioMode) {
      void exportAudio(format, range);
      return;
    }
    const current = modalSettings();
    void runExport(current, { range });
  });
  document.addEventListener('click', (event) => {
    if (exportMenu.classList.contains('hidden')) return;
    if (!(event.target instanceof Element) || !event.target.closest('#video-export-control')) setExportMenu(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!exportModal.classList.contains('hidden')) {
      event.preventDefault();
      closeExportModal();
    } else if (!exportMenu.classList.contains('hidden')) {
      event.preventDefault();
      setExportMenu(false);
    }
  });

  undoButton.addEventListener('click', undo);
  redoButton.addEventListener('click', redo);
  splitButton.addEventListener('click', splitAtPlayhead);
  fitButton.addEventListener('click', () => {
    if (zoomFrame) {
      cancelAnimationFrame(zoomFrame);
      zoomFrame = 0;
    }
    fitTimeline();
    zoomLevel = 1;
    zoom.value = '0';
    render();
    scroll.scrollLeft = 0;
  });
  function addVideoTrack(): void {
    videoTrackCount += 1;
    videoTrackState.push({ hidden: false, muted: false, locked: false, solo: false });
    render();
    commit();
    status.textContent = `Video track ${videoTrackCount} added.`;
  }

  function addAudioTrack(): void {
    audioTrackCount += 1;
    ensureTrackStates(
      Math.max(videoTrackCount, ...videos.map((clip) => clip.track + 1)),
      audioTrackCount,
    );
    render();
    commit();
    status.textContent = `Audio track ${audioTrackCount} added.`;
  }

  const setAddTrackMenu = (open: boolean): void => {
    addTrackMenu.classList.toggle('hidden', !open);
    addTrackButton.setAttribute('aria-expanded', String(open));
  };
  addTrackButton.addEventListener('click', (event) => {
    event.stopPropagation();
    setAddTrackMenu(addTrackMenu.classList.contains('hidden'));
  });
  for (const item of addTrackItems) {
    item.addEventListener('click', () => {
      setAddTrackMenu(false);
      if (item.dataset.addTrack === 'audio') addAudioTrack();
      else addVideoTrack();
    });
  }
  document.addEventListener('click', (event) => {
    if (addTrackMenu.classList.contains('hidden')) return;
    if (!(event.target instanceof Element) || !event.target.closest('.video-add-track-wrap')) setAddTrackMenu(false);
  });
  recordButton.addEventListener('click', () => {
    if (recording) stopVoiceover();
    else startVoiceover();
  });
  recordStop.addEventListener('click', stopVoiceover);
  recordCancel.addEventListener('click', cancelVoiceover);

  reset.addEventListener('click', () => startNewProject(true));

  window.addEventListener('beforeunload', (event) => {
    if (!videos.length && !audios.length && !recording) return;
    if (!recording && savedFingerprint && projectFingerprint() === savedFingerprint) return;
    event.preventDefault();
    event.returnValue = '';
  });

  originalVolumeValue.textContent = `${originalVolume.value}%`;
  normalize.value = 'off';
  format.value = 'mp4';
  preset.value = 'source';
  for (const input of root.querySelectorAll<HTMLInputElement>('input[type="number"]')) enableNumberScrub(input);
  window.addEventListener(QUICK_LOCALE_EVENT, () => {
    if (!projectNameIsDefault) return;
    projectName.value = defaultProjectName();
    updateProjectBar();
  });
  animationPanel = createKeyframePanel(animationRoot, {
    onClose: () => showClipAnimation(false),
    onSeek: (at, keepVisible = true) => seekLight(at, keepVisible),
    onPause: () => { if (playing) pause(); },
    onChange: (id, animation, label) => {
      const clip = videos.find((clip) => clip.id === id);
      if (!clip || videoClipLocked(clip)) return false;
      const { speed, ...keys } = animation;
      const current = speed ? speedKeys(clip) : [];
      if (speed && (speed.length !== current.length || speed.some(({ at, value }, i) =>
        Math.abs(at - current[i].at) > 0.000001 || value !== current[i].value))) {
        if (speedEditLocked(clip)) return false;
        const rates = ratesFromTimeline(clip.effects, clip.trimStart, clip.duration - clip.trimEnd, speed);
        if (!rates) return false;
        clip.effects = { ...clip.effects, ...rates };
        syncRetimeAudio(clip);
        invalidateTimelineDerived();
      }
      clip.animation = keys;
      if (!label) return true;
      render();
      seek(time, false);
      commit(label);
      return true;
    },
    onEffect: (section) => {
      const clip = selectedVideoClip();
      if (!clip) return;
      setClipSelection('video', clip.id);
      ensureInspectorOpen();
      openVideoSections.add(section);
      selectSideTab('video');
      revealInspectorSection(section);
    },
    sample: (id, property, at) => {
      const clip = videos.find((clip) => clip.id === id);
      if (!clip) return 0;
      return property === 'speed'
        ? speedAtSource(clip.effects, clipSourceTime(clip, clipLocalTime(clip, at)))
        : animatedValue(clip, property, at);
    },
    frameRate: fpsOfProject,
    timecode: timecodeLabel,
  });
  animationToggle.addEventListener('click', () => {
    if (animationPanel?.isOpen()) showClipAnimation(false);
    else focusVideoInspectorSection('keys');
  });
  animationRoot.addEventListener('wheel', (event) => {
    const delta = event.shiftKey ? event.deltaX || event.deltaY : event.deltaX;
    if (!delta || (!event.shiftKey && Math.abs(delta) <= Math.abs(event.deltaY))) return;
    event.preventDefault();
    scroll.scrollLeft += delta * (event.deltaMode === 1 ? 16 : 1);
  }, { passive: false });
  render();
  renderMediaPool();
  renderEffectsPanel();
  commit('Project started');
  void initializeProjects();
  window.setTimeout(() => void pruneCachedAssets(), 4000);

  return {
    update,
    pause,
    activity(): { tone: 'busy' | 'ready' | 'warn'; label: string } | null {
      if (recording) return { tone: 'busy', label: 'Recording a voiceover' };
      if (operation) return { tone: 'busy', label: 'Video editor is working' };
      if (projectSaving) return { tone: 'busy', label: 'Saving the video project' };
      if (videos.length || audios.length || assets.length || titles.length || graphics.length) {
        return { tone: 'ready', label: 'Video project open' };
      }
      return null;
    },
    /** Uptake the current transcript or caption file after a tab switch. */
    refresh: () => {
      updateCaptions();
      scheduleAutoProxy();
    },
    /** Open files from elsewhere in the app (drop menu, Open with…). */
    addFiles: (files: File[]) => addFiles(files),
    /** Localize the untouched default name after the app language is known. */
    localizeDefaultName: () => {
      if (!projectNameIsDefault) return;
      projectName.value = defaultProjectName();
      updateProjectBar();
    },
  };
}
