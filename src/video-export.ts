/**
 * Video export engine.
 *
 * 1. FFmpeg renders the soundtrack (cheap, audio only).
 * 2. WebCodecs (through Mediabunny) copies each clip, or decodes it with the
 *    browser (AV1, HEVC, VP9, H.264, often hardware accelerated) and encodes
 *    H.264 in hardware, applying trims, presets, stills, and burned captions.
 * 3. Mediabunny interleaves the clips' packets and the soundtrack into the
 *    output, streaming to a file on disk when the browser allows it.
 *
 * Containers Mediabunny cannot read (AVI, WMV, FLV, …) and browsers without
 * WebCodecs fall back to an FFmpeg-only export.
 */

import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  CanvasSource,
  canEncodeVideo,
  Conversion,
  EncodedAudioPacketSource,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  MkvOutputFormat,
  MovOutputFormat,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  StreamTarget,
  TextSubtitleSource,
  WebMOutputFormat,
  type EncodedPacket,
  type InputAudioTrack,
  type InputVideoTrack,
  type OutputFormat,
  type Target,
} from 'mediabunny';
import { assSegmentAt, type AssSegment } from './ass-subtitles';
import type { createAssSurface } from './video-ass-renderer';
import { sharedFfmpeg } from './audio-ffmpeg';
import { concatFloat32, writeFloatWav } from './pcm-audio';
import {
  drawCaption,
  toSrt,
  toVtt,
  type Cue,
  type TextObjectStyle,
} from './captions';
import { drawGraphics, preloadGraphicImages, type GraphicClip } from './video-graphics';
import { overlayTransitionOpacity } from './video-overlays';
import {
  bitrateForSize,
  buildAudioMixPlan,
  buildVideoPlan,
  canSkipSoundtrackMix,
  clipTransform,
  clipPlaybackTime,
  clipSourceTime,
  dynamicZoomTimingFor,
  hasClipTransform,
  isSequentialVideo,
  MERGE_FORMATS,
  targetSize,
  totalLength,
  videoClipLength,
  videoSegments,
  videoStarts,
  type ClipTransform,
  type MergeAudio,
  type MergeSettings,
  type MergeVideo,
} from './video-merge-args';
import {
  animationAt,
  dynamicZoomAt,
  type DynamicZoomTiming,
  compositeOperation,
  cssFilter,
  drawMask,
  effectAnimationAt,
  hasAnimation,
  hasMask,
  hasSpeed,
  lutKey,
  pixelPassFor,
  hasVisualAnimation,
  hasVisualEffects,
  motionTransitionAt,
  needsRender,
  normalizeEffects,
  type ClipEffects,
} from './video-effects';
import { runPixelPassParallel } from './pixel-effects-pool';
import { gpuPixelPassEnabled, runPixelPassGpu } from './pixel-effects-gpu';
import { sharedMedia } from './media-router';

export interface ExportVideoClip extends MergeVideo {
  blob: Blob;
  linkGroup?: number;
}

export interface ExportAudioClip extends MergeAudio {
  blob: Blob;
  linkGroup?: number;
}

export interface ExportJob {
  videos: ExportVideoClip[];
  audios: ExportAudioClip[];
  settings: MergeSettings;
  captions: { cues: Cue[]; mode: 'soft' | 'burn'; style?: TextObjectStyle; ass?: AssSegment[] } | null;
  graphics?: GraphicClip[];
  /** Write here instead of returning a Blob (File System Access stream). */
  writable?: FileSystemWritableFileStream | null;
  signal: AbortSignal;
  onProgress: (fraction: number, label: string) => void;
}

export interface ExportResult {
  blob: Blob | null;
  engine: 'webcodecs' | 'ffmpeg';
  copied: boolean;
  /** True when the video's own audio packets were copied instead of mixed. */
  audioCopied?: boolean;
  bytes: number;
}


function outputFormat(format: MergeSettings['format'], streaming: boolean): OutputFormat {
  if (format === 'mkv') return new MkvOutputFormat();
  if (format === 'webm') return new WebMOutputFormat();
  // Streaming to disk cannot seek back to move the index to the front.
  if (format === 'mov') return new MovOutputFormat({ fastStart: streaming ? false : 'in-memory' });
  return new Mp4OutputFormat({ fastStart: streaming ? false : 'in-memory' });
}

function intermediateFormat(format: MergeSettings['format']): OutputFormat {
  return format === 'webm' ? new WebMOutputFormat() : new Mp4OutputFormat({ fastStart: 'in-memory' });
}

/** VP9 rejects a quantizer-only quality preset; give it a real bitrate. */
function encoderBitrate(
  size: { width: number; height: number },
  codec: 'avc' | 'vp9' | 'vp8',
  target: number | undefined,
  quality?: number,
): number | undefined {
  if (target) return Math.max(250_000, target);
  if (quality && quality > 0) {
    // A rough bits-per-pixel curve: ~0.18 bpp at 80%, ~0.08 at 55%.
    const bpp = 0.003 + (Math.min(100, quality) / 100) ** 2 * 0.27;
    return Math.max(codec === 'avc' ? 250_000 : 500_000, Math.round(size.width * size.height * 30 * bpp));
  }
  if (codec === 'avc') return undefined;
  return Math.max(500_000, Math.round(size.width * size.height * 30 * 0.1));
}



/** True when this browser can run the WebCodecs path at all. */
export function webCodecsSupported(): boolean {
  return typeof VideoEncoder !== 'undefined' && typeof VideoDecoder !== 'undefined' && typeof OffscreenCanvas !== 'undefined';
}

interface Prepared {
  /** Packets of the clip's video track, starting at 0. */
  input: Input;
  video: InputVideoTrack;
  audio: InputAudioTrack | null;
  length: number;
  /** Where this segment starts on the output timeline. */
  start: number;
  /** True when this input is an intermediate that must be disposed. */
  owned: boolean;
}

interface OpenedMedia {
  input: Input;
  video: InputVideoTrack;
  audio: InputAudioTrack | null;
}

function abortable(signal: AbortSignal): void {
  signal.throwIfAborted();
}

async function openTrack(blob: Blob): Promise<OpenedMedia | null> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  try {
    if (!(await input.canRead())) return null;
    const [video, audio] = await Promise.all([input.getPrimaryVideoTrack(), input.getPrimaryAudioTrack()]);
    if (!video) return null;
    return { input, video, audio };
  } catch {
    input.dispose();
    return null;
  }
}

/** Bytes of a decoder description, respecting the view's offset and length. */
function descriptionBytes(description: AllowSharedBufferSource | undefined): number[] {
  if (!description) return [];
  if (ArrayBuffer.isView(description)) {
    return Array.from(new Uint8Array(description.buffer, description.byteOffset, description.byteLength));
  }
  return Array.from(new Uint8Array(description));
}

function configKey(config: VideoDecoderConfig | null): string {
  if (!config) return 'none';
  return `${config.codec}|${config.codedWidth}x${config.codedHeight}|${descriptionBytes(config.description).join(',')}`;
}

async function sameAudioConfig(tracks: InputAudioTrack[]): Promise<boolean> {
  const configs = await Promise.all(tracks.map((track) => track.getDecoderConfig()));
  const key = (config: AudioDecoderConfig | null) => {
    if (!config) return 'none';
    return `${config.codec}|${config.sampleRate}|${config.numberOfChannels}|${descriptionBytes(config.description).join(',')}`;
  };
  return configs.every((config) => key(config) === key(configs[0]));
}

/** Draw a fitted source into the frame with the clip inspector's transform. */
function drawPicture(
  ctx: OffscreenCanvasRenderingContext2D,
  sourceWidth: number,
  sourceHeight: number,
  size: { width: number; height: number; fit: 'contain' | 'cover' },
  transformValue: Partial<ClipTransform> | undefined,
  draw: (ctx: OffscreenCanvasRenderingContext2D, x: number, y: number, width: number, height: number) => void,
): void {
  const transform = clipTransform(transformValue);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, size.width, size.height);
  const fitScale = size.fit === 'cover'
    ? Math.max(size.width / sourceWidth, size.height / sourceHeight)
    : Math.min(size.width / sourceWidth, size.height / sourceHeight);
  const width = sourceWidth * fitScale;
  const height = sourceHeight * fitScale;
  ctx.save();
  ctx.translate(
    size.width / 2 + (transform.x / 100) * size.width,
    size.height / 2 + (transform.y / 100) * size.height,
  );
  ctx.rotate((transform.rotation * Math.PI) / 180);
  ctx.scale(transform.scale * transform.scaleX, transform.scale * transform.scaleY);
  draw(ctx, -width / 2, -height / 2, width, height);
  ctx.restore();
}

/** Draw a fitted clip with its evaluated transform, filter, and opacity. */
function drawTransformed(
  ctx: OffscreenCanvasRenderingContext2D,
  sourceWidth: number,
  sourceHeight: number,
  size: { width: number; height: number; fit: 'contain' | 'cover' },
  transformValue: Partial<ClipTransform>,
  effectsValue: MergeVideo['effects'],
  draw: (ctx: OffscreenCanvasRenderingContext2D, x: number, y: number, width: number, height: number) => void,
): void {
  const transform = clipTransform(transformValue);
  const effects = normalizeEffects(effectsValue);
  const fitScale = size.fit === 'cover'
    ? Math.max(size.width / sourceWidth, size.height / sourceHeight)
    : Math.min(size.width / sourceWidth, size.height / sourceHeight);
  const width = sourceWidth * fitScale;
  const height = sourceHeight * fitScale;
  ctx.save();
  ctx.filter = cssFilter(effects);
  ctx.translate(
    size.width / 2 + (transform.x / 100) * size.width,
    size.height / 2 + (transform.y / 100) * size.height,
  );
  ctx.rotate((transform.rotation * Math.PI) / 180);
  ctx.scale(transform.scale * transform.scaleX, transform.scale * transform.scaleY);
  draw(ctx, -width / 2, -height / 2, width, height);
  ctx.restore();
}

/** Lazily keep one transparent working layer for the whole segment. */
function clipFrameLayer(width: number, height: number): () => OffscreenCanvasRenderingContext2D {
  let layer: OffscreenCanvasRenderingContext2D | null = null;
  return () => {
    layer ??= new OffscreenCanvas(width, height).getContext('2d')!;
    layer.clearRect(0, 0, width, height);
    return layer;
  };
}

/**
 * Render one clip frame into the output canvas with animation, colour, mask,
 * key, LUT, opacity, and blend mode. Simple clips skip the temporary canvas.
 */
function renderClipFrame(
  ctx: OffscreenCanvasRenderingContext2D,
  sourceWidth: number,
  sourceHeight: number,
  size: { width: number; height: number; fit: 'contain' | 'cover' },
  clip: Pick<ExportVideoClip, 'transform' | 'effects' | 'animation' | 'transition' | 'animationTimeOffset'>,
  at: number,
  zoomTiming: DynamicZoomTiming,
  getLayer: () => OffscreenCanvasRenderingContext2D,
  draw: (ctx: OffscreenCanvasRenderingContext2D, x: number, y: number, width: number, height: number) => void,
): void | Promise<void> {
  const motionTime = at + (clip.animationTimeOffset ?? 0);
  const effects = effectAnimationAt(clip.animation, motionTime, clip.effects);
  const state = animationAt(clip.animation, motionTime, {
    transform: clipTransform(clip.transform),
    opacity: effects.opacity,
    volume: 1,
  });
  const motion = motionTransitionAt(clip.transition, motionTime);
  const transform = {
    ...state.transform,
    scale: state.transform.scale * dynamicZoomAt(effects.dynamicZoom, at + zoomTiming.offset, zoomTiming.duration),
    x: state.transform.x + motion.offsetX,
    y: state.transform.y + motion.offsetY,
  };
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, size.width, size.height);
  const complex = hasVisualEffects(effects) || hasMask(effects) || Boolean(motion.reveal) ||
    Math.abs(state.opacity - 1) > 0.0001;
  if (!complex) {
    drawTransformed(ctx, sourceWidth, sourceHeight, size, transform, effects, draw);
    return;
  }
  const layerCtx = getLayer();
  drawTransformed(layerCtx, sourceWidth, sourceHeight, size, transform, effects, draw);
  const pass = pixelPassFor(effects);
  if (pass && gpuPixelPassEnabled()) {
    // The pass on the GPU, without reading pixels back (worker pool otherwise).
    const result = runPixelPassGpu(layerCtx.canvas, pass, effects.lut ? lutKey(effects.lut) : null);
    if (result) {
      layerCtx.save();
      layerCtx.setTransform(1, 0, 0, 1, 0, 0);
      layerCtx.globalCompositeOperation = 'copy';
      layerCtx.drawImage(result, 0, 0);
      layerCtx.restore();
      compositeLayer(ctx, layerCtx, size, effects, state.opacity, motion.reveal);
      return;
    }
  }
  if (pass) {
    // The per-pixel pass runs on worker threads, band by band; the source frame
    // is already drawn into the layer, so the caller may release it.
    const image = layerCtx.getImageData(0, 0, size.width, size.height);
    return runPixelPassParallel(image.data, pass, effects.lut ? lutKey(effects.lut) : null).then(() => {
      layerCtx.putImageData(image, 0, 0);
      compositeLayer(ctx, layerCtx, size, effects, state.opacity, motion.reveal);
    });
  }
  compositeLayer(ctx, layerCtx, size, effects, state.opacity, motion.reveal);
}

function compositeLayer(
  ctx: OffscreenCanvasRenderingContext2D,
  layerCtx: OffscreenCanvasRenderingContext2D,
  size: { width: number; height: number },
  effects: ClipEffects,
  opacity: number,
  reveal: ReturnType<typeof motionTransitionAt>['reveal'],
): void {
  const motion = { reveal };
  drawMask(layerCtx, size.width, size.height, effects);
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, opacity));
  ctx.globalCompositeOperation = compositeOperation(effects.blend);
  if (motion.reveal) {
    const left = (motion.reveal.left / 100) * size.width;
    const top = (motion.reveal.top / 100) * size.height;
    const right = (motion.reveal.right / 100) * size.width;
    const bottom = (motion.reveal.bottom / 100) * size.height;
    ctx.beginPath();
    ctx.rect(left, top, Math.max(0, size.width - left - right), Math.max(0, size.height - top - bottom));
    ctx.clip();
  }
  ctx.drawImage(layerCtx.canvas, 0, 0, size.width, size.height);
  ctx.restore();
}

/** Render one still image as a short clip in the output codec. */
async function stillClip(
  blob: Blob, length: number, size: { width: number; height: number; fit: 'contain' | 'cover' },
  captions: ((ctx: OffscreenCanvasRenderingContext2D, time: number) => void | Promise<void>) | null, bitrate: number | undefined,
  signal: AbortSignal, onProgress: (fraction: number) => void,
  codec: 'avc' | 'vp9' | 'vp8' = 'avc', clip?: ExportVideoClip, frameRate?: number, zoomTiming?: DynamicZoomTiming,
): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(size.width, size.height);
  const ctx = canvas.getContext('2d')!;
  const webm = codec !== 'avc';
  const output = new Output({
    format: webm ? new WebMOutputFormat() : new Mp4OutputFormat({ fastStart: 'in-memory' }),
    target: new BufferTarget(),
  });
  const getLayer = clipFrameLayer(size.width, size.height);
  const moving = Boolean(clip && (hasAnimation(clip.animation) || hasVisualEffects(clip.effects) ||
    clip.transition));
  const requested = Number(frameRate);
  const projectFps = Number.isFinite(requested) && requested >= 1 && requested <= 240 ? requested : 0;
  const fps = moving ? projectFps || 30 : captions ? 10 : 2;
  const effectiveBitrate = bitrate ?? (codec === 'avc'
    ? QUALITY_HIGH
    : Math.max(500_000, Math.round(size.width * size.height * 30 * 0.1)));
  const source = new CanvasSource(canvas, { codec, bitrate: effectiveBitrate, keyFrameInterval: 2 });
  output.addVideoTrack(source, { frameRate: fps });
  await output.start();
  const frames = Math.max(1, Math.ceil(length * fps));
  for (let frame = 0; frame < frames; frame += 1) {
    abortable(signal);
    const time = frame / fps;
    if (clip) {
      await renderClipFrame(ctx, bitmap.width, bitmap.height, size, clip, time, zoomTiming ?? dynamicZoomTimingFor(clip), getLayer, (target, x, y, w, h) => {
        target.drawImage(bitmap, x, y, w, h);
      });
    } else {
      drawPicture(ctx, bitmap.width, bitmap.height, size, undefined, (target, x, y, w, h) => {
        target.drawImage(bitmap, x, y, w, h);
      });
    }
    if (captions) await captions(ctx, time);
    await source.add(time, Math.min(1 / fps, length - time));
    onProgress(frame / frames);
  }
  bitmap.close();
  await output.finalize();
  return new Blob([output.target.buffer!], { type: webm ? 'video/webm' : 'video/mp4' });
}

/** Fill a timeline gap with black frames so the output keeps real time. */
async function blackClip(
  length: number,
  size: { width: number; height: number },
  bitrate: number | undefined,
  signal: AbortSignal,
  onProgress: (fraction: number) => void,
  codec: 'avc' | 'vp9' | 'vp8',
  overlay: ((ctx: OffscreenCanvasRenderingContext2D, time: number) => void | Promise<void>) | null = null,
  frameRate?: number,
): Promise<Blob> {
  const webm = codec !== 'avc';
  const canvas = new OffscreenCanvas(size.width, size.height);
  const ctx = canvas.getContext('2d')!;
  const output = new Output({
    format: webm ? new WebMOutputFormat() : new Mp4OutputFormat({ fastStart: 'in-memory' }),
    target: new BufferTarget(),
  });
  const requested = Number(frameRate);
  const projectFps = Number.isFinite(requested) && requested >= 1 && requested <= 240 ? requested : 0;
  const fps = overlay && projectFps ? projectFps : 10;
  const effectiveBitrate = bitrate ?? (codec === 'avc'
    ? QUALITY_HIGH
    : Math.max(500_000, Math.round(size.width * size.height * 30 * 0.1)));
  const source = new CanvasSource(canvas, { codec, bitrate: effectiveBitrate, keyFrameInterval: 2 });
  output.addVideoTrack(source, { frameRate: fps });
  await output.start();
  const frames = Math.max(1, Math.ceil(length * fps));
  for (let frame = 0; frame < frames; frame += 1) {
    abortable(signal);
    const time = frame / fps;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, size.width, size.height);
    if (overlay) await overlay(ctx, time);
    await source.add(time, Math.min(1 / fps, length - time));
    onProgress(frame / frames);
  }
  await output.finalize();
  return new Blob([output.target.buffer!], { type: webm ? 'video/webm' : 'video/mp4' });
}

/**
 * True when the soundtrack is only the videos' own sound, but trims mean the
 * packets cannot simply be copied. This can still avoid FFmpeg by decoding the
 * trimmed ranges and encoding one AAC track in the browser.
 */
function originalSoundOnly(
  videos: readonly ExportVideoClip[],
  audios: readonly ExportAudioClip[],
  settings: MergeSettings,
  captions: ExportJob['captions'],
): boolean {
  if (audios.length || !settings.keepOriginal || settings.originalVolume !== 1) return false;
  if (settings.duck || (settings.normalize ?? 'off') !== 'off') return false;
  if (captions?.mode === 'burn' || !isSequentialVideo(videos)) return false;
  return videos.every((clip) =>
    !clip.image && clip.probe.hasAudio && !clip.mute &&
    !hasSpeed(clip.effects) && !hasAnimation(clip.animation) &&
    (clip.volume ?? 1) === 1 && (clip.audioTrack ?? 0) === 0);
}

/** Decode each trimmed range with WebCodecs and encode one browser AAC track. */
async function renderBrowserSoundtrack(
  videos: readonly ExportVideoClip[],
  signal: AbortSignal,
  onProgress?: (fraction: number, label: string) => void,
): Promise<Blob | null> {
  const { MediabunnyEngine } = await import('./mediabunny-engine');
  const engine = new MediabunnyEngine();
  let sampleRate = 0;
  let channelCount = 0;
  let channels: Float32Array[][] = [];
  for (const [index, clip] of videos.entries()) {
    signal.throwIfAborted();
    if (hasSpeed(clip.effects) || hasAnimation(clip.animation)) return null;
    const start = clip.trimStart ?? 0;
    const end = clip.duration - (clip.trimEnd ?? 0);
    if (!(end > start)) return null;
    const decoded = await engine.trim(clip.blob, start, end, { signal });
    if (!decoded.pcm?.channels.length || decoded.duration + 0.05 < end - start) return null;
    if (!sampleRate) {
      sampleRate = decoded.sampleRate;
      channelCount = decoded.pcm.channels.length;
      channels = Array.from({ length: channelCount }, () => []);
    } else if (decoded.sampleRate !== sampleRate || decoded.pcm.channels.length !== channelCount) {
      return null;
    }
    for (let channel = 0; channel < channelCount; channel += 1) {
      channels[channel].push(decoded.pcm.channels[channel]);
    }
    onProgress?.((index + 1) / videos.length * 0.6, 'Decoding the soundtrack');
  }
  if (!sampleRate || !channelCount) return null;
  const wav = writeFloatWav(channels.map((chunks) => concatFloat32(chunks)), sampleRate);
  const encoded = await sharedMedia().encode(wav, 'm4a', {
    signal,
    onProgress: ({ ratio }) => onProgress?.(0.6 + (ratio ?? 0) * 0.4, 'Encoding the soundtrack'),
  });
  return encoded;
}

/** Run the WebCodecs path. Returns null when it cannot handle these inputs. */
async function exportWithWebCodecs(
  job: ExportJob,
  soundtrack: Blob | null,
  target: Target,
  streaming: boolean,
  allowAudioCopy = false,
  linkedAudio = false,
): Promise<{ copied: boolean; audioCopied: boolean } | null> {
  if (!webCodecsSupported()) return null;
  const { videos, settings, signal } = job;
  const opened: (OpenedMedia | null)[] = [];
  for (const clip of videos) opened.push(clip.image ? null : await openTrack(clip.blob));
  if (videos.some((clip, i) => !clip.image && !opened[i])) {
    for (const entry of opened) entry?.input.dispose();
    return null;
  }

  const starts = videoStarts(videos);
  const order = videos
    .map((clip, index) => ({ clip, index, start: starts[index] }))
    .sort((a, b) => a.start - b.start || (b.clip.track ?? 0) - (a.clip.track ?? 0));
  const firstEntry = order.find((entry) => !entry.clip.image) ?? order[0];
  const firstTrack = firstEntry ? opened[firstEntry.index]?.video : undefined;
  const firstSize = firstTrack
    ? { width: firstTrack.displayWidth, height: firstTrack.displayHeight }
    : { width: firstEntry?.clip.probe.width || 1280, height: firstEntry?.clip.probe.height || 720 };
  const size = targetSize(settings.preset ?? 'source', firstSize, settings.maxShortEdge, {
    width: settings.customWidth,
    height: settings.customHeight,
  });
  const total = totalLength(videos);
  const burn = job.captions?.mode === 'burn' && job.captions.cues.length ? job.captions.cues : null;
  const ass = job.captions?.mode === 'burn' ? job.captions.ass ?? [] : [];
  const graphics = job.graphics ?? [];
  const hasGraphics = graphics.length > 0;
  if (hasGraphics) await preloadGraphicImages(graphics);
  const tracks = opened.filter(Boolean).map((entry) => entry!.video);
  const audioTracks = opened.filter(Boolean).map((entry) => entry!.audio);
  const sourceCodec = firstTrack?.codec ?? null;
  const sourceAudioCodec = audioTracks.find(Boolean)?.codec ?? null;
  const outFormat = outputFormat(settings.format, streaming);
  const formatCodecs = outFormat.getSupportedCodecs();
  if (job.captions?.mode === 'soft' && job.captions.cues.length && !formatCodecs.includes('webvtt')) {
    for (const entry of opened) entry?.input.dispose();
    return null;
  }

  // Copying the soundtrack packets avoids an FFmpeg mix entirely for a plain
  // join. If the clips' audio streams do not match, the caller renders a mix
  // and tries again instead of emitting a silent file.
  const wantsAudioCopy = allowAudioCopy && !soundtrack &&
    canSkipSoundtrackMix(videos, job.audios, settings, job.captions);
  // Audio packets can be copied even when the video is re-encoded (for
  // example H.264 clips going to WebM); the two decisions are independent.
  let copyAudio = wantsAudioCopy && sourceAudioCodec !== null &&
    formatCodecs.includes(sourceAudioCodec) &&
    audioTracks.length === videos.length && audioTracks.every(Boolean);
  if (copyAudio) {
    if (audioTracks.length > 1) copyAudio = await sameAudioConfig(audioTracks as InputAudioTrack[]);
    if (copyAudio) {
      for (const [i, track] of audioTracks.entries()) {
        if (!track) { copyAudio = false; break; }
        const audioLength = await track.computeDuration();
        const videoLength = videoClipLength(videos[i]);
        if (audioLength + 0.05 < videoLength) { copyAudio = false; break; }
        if (linkedAudio) {
          const media = opened[i]!;
          const [audioStart, videoStart, streams] = await Promise.all([
            track.getFirstTimestamp(), media.video.getFirstTimestamp(), media.input.getAudioTracks(),
          ]);
          if (streams.length !== 1 || Math.abs(audioLength - videoLength) > 0.05 ||
              Math.abs(audioStart - videoStart) > 0.025) {
            copyAudio = false;
            break;
          }
        }
      }
    }
  }
  if (wantsAudioCopy && !copyAudio) {
    for (const entry of opened) entry?.input.dispose();
    return null;
  }

  let bitrate: number | undefined;
  const hasAudio = Boolean(soundtrack) || copyAudio;
  if (settings.targetMB) bitrate = bitrateForSize(settings.targetMB, total, hasAudio);
  let encodeCodec: 'avc' | 'vp9' | 'vp8' = 'avc';

  // Per-segment pass: copy exact packets where possible, transcode the rest
  // into a temporary container, and feed each temporary into the final mux
  // immediately so only one intermediate is alive at a time.
  interface WorkSegment {
    start: number;
    length: number;
    sourceStart: number;
    clip: ExportVideoClip | null;
    index: number | null;
  }
  const timelineStarts = videoStarts(videos);
  const sequential = isSequentialVideo(videos);
  const work: WorkSegment[] = sequential
    ? videos.map((clip, i) => ({
      start: timelineStarts[i],
      length: videoClipLength(clip),
      sourceStart: clip.trimStart ?? 0,
      clip,
      index: i,
    }))
    : videoSegments(videos).map((segment) => ({
      start: segment.start,
      length: segment.end - segment.start,
      sourceStart: segment.sourceStart ?? 0,
      clip: segment.clip ? (segment.clip as ExportVideoClip) : null,
      index: segment.clip ? videos.indexOf(segment.clip as ExportVideoClip) : null,
    }));

  // Different frame rates still concatenate as variable-frame-rate packets, but
  // keep the old copy guarantee: one uniform timeline configuration.
  const fps = videos[0]?.probe.fps ?? 0;
  const sameFps = videos.every((clip) => Math.abs((clip.probe.fps || 0) - fps) < 0.05);
  const copySegments = work.map((segment) => {
    const clip = segment.clip;
    if (!clip || clip.image || burn || ass.length || hasGraphics || !sameFps) return false;
    if (settings.frameRate && Math.abs(fps - settings.frameRate) > 0.01) return false;
    if (settings.reencode || settings.targetMB || (settings.preset ?? 'source') !== 'source') return false;
    if (hasClipTransform(clip.transform)) return false;
    if (needsRender(clip.effects, clip.animation) || clip.transition) return false;
    if (segment.index === null || segment.sourceStart !== 0) return false;
    // A trim of the clip's tail can be copied by simply stopping packet
    // emission at the trim point; only exact cuts need a re-encode. Trimming
    // the head still requires a keyframe-aligned re-encode.
    if ((clip.trimStart ?? 0) > 0) return false;
    if (settings.exactCuts && (clip.trimEnd ?? 0) > 0) return false;
    if (Math.abs(segment.length - videoClipLength(clip)) > 1e-6) return false;
    const media = opened[segment.index];
    if (!media) return false;
    const track = media.video;
    if (track.displayWidth !== size.width || track.displayHeight !== size.height) return false;
    if (!track.codec || !formatCodecs.includes(track.codec)) return false;
    return true;
  });
  for (let index = 0; index < copySegments.length; index += 1) {
    if (!copySegments[index]) continue;
    const track = opened[work[index].index!]?.video;
    if (!track || (await track.getRotation()) !== 0) copySegments[index] = false;
  }

  // MP4/WebM stores one decoder configuration per video track, and the
  // Mediabunny muxer reads it from the first packet. A copied segment and an
  // encoded segment have different SPS/PPS, so mixing them corrupts playback.
  // Only take the copy path when every segment has the same configuration.
  let copied = false;
  let outputCodec = sourceCodec;
  let needsEncode = true;
  if (
    work.length > 0 &&
    work.every((segment, index) => Boolean(segment.clip) && !segment.clip!.image && copySegments[index])
  ) {
    const configs = await Promise.all(
      work.map((segment) => opened[segment.index!]!.video.getDecoderConfig()),
    );
    const firstKey = configKey(configs[0]);
    if (configs.every((config) => configKey(config) === firstKey)) {
      copied = true;
      needsEncode = false;
      copySegments.fill(true);
    }
  }
  if (needsEncode) {
    copySegments.fill(false);
    if (settings.format === 'webm') {
      const vp9Rate = encoderBitrate(size, 'vp9', bitrate, settings.quality);
      const vp8Rate = encoderBitrate(size, 'vp8', bitrate, settings.quality);
      const vp9 = formatCodecs.includes('vp9') && await canEncodeVideo('vp9', { width: size.width, height: size.height, bitrate: vp9Rate });
      const vp8 = !vp9 && formatCodecs.includes('vp8') && await canEncodeVideo('vp8', { width: size.width, height: size.height, bitrate: vp8Rate });
      if (vp9) encodeCodec = 'vp9';
      else if (vp8) encodeCodec = 'vp8';
      else {
        for (const entry of opened) entry?.input.dispose();
        return null;
      }
    }
    outputCodec = encodeCodec;
    const encodable = await canEncodeVideo(encodeCodec, { width: size.width, height: size.height, bitrate: encoderBitrate(size, encodeCodec, bitrate, settings.quality) });
    const decodable = await Promise.all(tracks.map((track) => track.canDecode()));
    if (!encodable || decodable.some((ok) => !ok)) {
      for (const entry of opened) entry?.input.dispose();
      return null;
    }
  }
  const encodeRate = encoderBitrate(size, encodeCodec, bitrate, settings.quality);

  const captionStyle = job.captions?.style;
  let completed = 0;
  const progress = (index: number, part: number, label: string) => {
    const length = work[index]?.length ?? 0;
    job.onProgress(0.1 + 0.8 * Math.min(1, (completed + part * length) / total), label);
  };

  let subtitleSurface: ReturnType<typeof createAssSurface> | null = null;
  let subtitleTrack: AssSegment | null = null;

  async function drawAss(ctx: OffscreenCanvasRenderingContext2D, at: number): Promise<void> {
    const track = assSegmentAt(ass, at);
    if (!track) return;
    if (!subtitleSurface || !subtitleTrack || subtitleTrack.file !== track.file ||
        subtitleTrack.script !== track.script || subtitleTrack.cues !== track.cues) {
      subtitleSurface?.dispose();
      const { createAssSurface } = await import('./video-ass-renderer');
      const canvas = document.createElement('canvas');
      canvas.width = size.width;
      canvas.height = size.height;
      subtitleSurface = createAssSurface(canvas, track);
      subtitleTrack = track;
    }
    await subtitleSurface.draw(ctx, track.sourceStart + (at - track.start) * track.speed, size.width, size.height);
  }

  async function prepareSegment(index: number, segment: WorkSegment, copyIt: boolean): Promise<Prepared> {
    const clip = segment.clip;
    const length = segment.length;
    const zoomTiming = clip && segment.index !== null
      ? dynamicZoomTimingFor(clip, segment.start - timelineStarts[segment.index])
      : { offset: 0, duration: length };
    const overlay = burn || ass.length || hasGraphics
      ? (ctx: OffscreenCanvasRenderingContext2D, time: number) => {
        const at = segment.start + time;
        drawGraphics(ctx, size.width, size.height, graphics, at);
        if (burn) {
          for (const cue of burn) {
            if (at < cue.start) break;
            if (at >= cue.end) continue;
            drawCaption(
              ctx,
              cue.text,
              size.width,
              size.height,
              cue.style ?? captionStyle,
              overlayTransitionOpacity(cue.start, cue.end, cue.transition, at) * (cue.opacity ?? 1),
            );
          }
        }
        if (ass.length) return drawAss(ctx, at);
      }
      : null;
    const label = clip
      ? `${copyIt ? 'Copying' : 'Encoding'} segment ${index + 1} of ${work.length}`
      : 'Rendering a gap';
    if (copyIt && segment.index !== null) {
      return { ...opened[segment.index]!, length, start: segment.start, owned: false };
    }

    let blob: Blob;
    if (!clip) {
      blob = await blackClip(
        length, size, encodeRate, signal, (part) => progress(index, part, label),
        encodeCodec, overlay, settings.frameRate,
      );
    } else if (clip.image) {
      blob = await stillClip(
        clip.blob, length, size, overlay, encodeRate, signal,
        (part) => progress(index, part, label), encodeCodec, clip, settings.frameRate, zoomTiming,
      );
    } else {
      const input = opened[segment.index!]!.input;
      const sourceStart = segment.sourceStart;
      const retimed = hasSpeed(clip.effects);
      const localStart = clipPlaybackTime(clip, sourceStart);
      const sourceEnd = clipSourceTime(clip, localStart + length);
      const frameClip = { ...clip, animationTimeOffset: (clip.animationTimeOffset ?? 0) + localStart };
      const intermediate = new Output({ format: intermediateFormat(settings.format), target: new BufferTarget() });
      const transformed = hasClipTransform(clip.transform);
      const styled = hasVisualEffects(clip.effects) || hasAnimation(clip.animation) ||
        Boolean(clip.transition);
      const canvas = overlay || transformed || styled ? new OffscreenCanvas(size.width, size.height) : null;
      const ctx = canvas?.getContext('2d') ?? null;
      const getLayer = clipFrameLayer(size.width, size.height);
      const conversion = await Conversion.init({
        input,
        output: intermediate,
        tracks: 'primary',
        audio: { discard: true },
        trim: { start: sourceStart, end: sourceEnd },
        video: {
          codec: encodeCodec,
          width: size.width,
          height: size.height,
          fit: size.fit,
          // No frameRate: combined with trim it collapses frames; the
          // container keeps each frame's own timestamp anyway.
          bitrate: encodeRate ?? QUALITY_HIGH,
          // Small WebM frames often have no hardware VP9 encoder; let
          // Chrome pick software instead of rejecting the config.
          hardwareAcceleration: settings.format === 'webm' ? 'no-preference' : 'prefer-hardware',
          forceTranscode: true,
          ...(canvas && ctx ? { processedWidth: size.width, processedHeight: size.height } : {}),
          ...(canvas || retimed
            ? {
              process: (sample) => {
                // Conversion has already rebased and clamped the sample to the source trim.
                if (retimed) {
                  const start = clipPlaybackTime(clip, sourceStart + sample.timestamp);
                  const end = clipPlaybackTime(clip, Math.min(sourceEnd, sourceStart + sample.timestamp + sample.duration));
                  sample.setTimestamp(Math.max(0, start - localStart));
                  sample.setDuration(Math.max(0.000001, end - start));
                }
                if (!canvas || !ctx) return sample;
                let rendered: void | Promise<void> = undefined;
                if (styled) {
                  rendered = renderClipFrame(ctx, sample.displayWidth, sample.displayHeight, size, frameClip, sample.timestamp, zoomTiming, getLayer, (target, x, y, w, h) => {
                    sample.draw(target, x, y, w, h);
                  });
                } else {
                  drawPicture(ctx, sample.displayWidth, sample.displayHeight, size, clip.transform, (target, x, y, w, h) => {
                    sample.draw(target, x, y, w, h);
                  });
                }
                if (rendered) {
                  const at = sample.timestamp;
                  return rendered.then(() => overlay?.(ctx, at)).then(() => canvas);
                }
                const combined = overlay?.(ctx, sample.timestamp);
                return combined ? combined.then(() => canvas) : canvas;
              },
            }
            : {}),
        },
      });
      if (!conversion.isValid) throw new Error('This clip cannot be converted in this browser.');
      conversion.onProgress = (part) => progress(index, part, label);
      const stop = () => void conversion.cancel();
      signal.addEventListener('abort', stop, { once: true });
      try {
        await conversion.execute();
      } finally {
        signal.removeEventListener('abort', stop);
      }
      abortable(signal);
      blob = new Blob([intermediate.target.buffer!], {
        type: settings.format === 'webm' ? 'video/webm' : 'video/mp4',
      });
    }

    const reopened = await openTrack(blob);
    if (!reopened) throw new Error('The converted segment could not be read back.');
    return {
      ...reopened,
      audio: clip && segment.index !== null ? (opened[segment.index]?.audio ?? reopened.audio) : null,
      length,
      start: segment.start,
      owned: true,
    };
  }

  try {
    job.onProgress(0.9, 'Writing the file');
    const output = new Output({ format: outFormat, target });
    const videoSource = new EncodedVideoPacketSource(outputCodec!);
    output.addVideoTrack(videoSource, { rotation: copied ? await tracks[0].getRotation() : 0 });
    let audioSource: EncodedAudioPacketSource | null = null;
    let audioInput: Input | null = null;
    if (soundtrack) {
      audioInput = new Input({ source: new BlobSource(soundtrack), formats: ALL_FORMATS });
      const track = await audioInput.getPrimaryAudioTrack();
      if (track) {
        audioSource = new EncodedAudioPacketSource((await track.getCodec()) ?? 'aac');
        output.addAudioTrack(audioSource);
      }
    } else if (copyAudio && sourceAudioCodec) {
      audioSource = new EncodedAudioPacketSource(sourceAudioCodec);
      output.addAudioTrack(audioSource);
    }
    let subtitles: TextSubtitleSource | null = null;
    if (job.captions?.mode === 'soft' && job.captions.cues.length && outFormat.getSupportedCodecs().includes('webvtt')) {
      subtitles = new TextSubtitleSource('webvtt');
      output.addSubtitleTrack(subtitles, { languageCode: 'und' });
    }
    await output.start();

    async function* videoPackets(): AsyncGenerator<{ packet: EncodedPacket; meta?: EncodedVideoChunkMetadata }> {
      let lastConfig = '';
      for (const [index, segment] of work.entries()) {
        const media = await prepareSegment(index, segment, copySegments[index]);
        try {
          const config = await media.video.getDecoderConfig();
          const key = configKey(config);
          const base = await media.video.getFirstTimestamp();
          for await (const packet of new EncodedPacketSink(media.video).packets()) {
            const time = packet.timestamp - base;
            if (time >= media.length - 0.0005) break;
            yield {
              packet: packet.clone({ timestamp: media.start + time }),
              meta: key !== lastConfig ? { decoderConfig: config ?? undefined } : undefined,
            };
            lastConfig = key;
          }
        } finally {
          if (media.owned) media.input.dispose();
        }
        completed += segment.length;
        job.onProgress(0.1 + 0.8 * Math.min(1, completed / total), 'Writing the file');
      }
    }

    async function* audioPackets(): AsyncGenerator<{ packet: EncodedPacket; meta?: EncodedAudioChunkMetadata }> {
      if (audioInput && audioSource) {
        const track = await audioInput.getPrimaryAudioTrack();
        if (!track) return;
        const config = await track.getDecoderConfig();
        let first = true;
        for await (const packet of new EncodedPacketSink(track).packets()) {
          if (packet.timestamp >= total) break;
          yield { packet, meta: first ? { decoderConfig: config ?? undefined } : undefined };
          first = false;
        }
        return;
      }
      if (!copyAudio || !audioSource) return;
      let first = true;
      for (let index = 0; index < videos.length; index += 1) {
        const clip = opened[index]?.audio;
        if (!clip) continue;
        const config = await clip.getDecoderConfig();
        const base = await clip.getFirstTimestamp();
        const length = videoClipLength(videos[index]);
        const start = timelineStarts[index];
        for await (const packet of new EncodedPacketSink(clip).packets()) {
          const time = packet.timestamp - base;
          if (time >= length - 0.0005) break;
          yield {
            packet: packet.clone({ timestamp: start + time }),
            meta: first ? { decoderConfig: config ?? undefined } : undefined,
          };
          first = false;
        }
      }
    }

    // Interleave by timestamp so the muxer can flush as it goes.
    const video = videoPackets();
    const audio = audioPackets();
    let nextVideo = await video.next();
    let nextAudio = await audio.next();
    let written = 0;
    while (!nextVideo.done || !nextAudio.done) {
      abortable(signal);
      const takeVideo = nextAudio.done || (!nextVideo.done && nextVideo.value.packet.timestamp <= nextAudio.value.packet.timestamp);
      if (takeVideo && !nextVideo.done) {
        await videoSource.add(nextVideo.value.packet, nextVideo.value.meta);
        written = Math.max(written, nextVideo.value.packet.timestamp);
        nextVideo = await video.next();
      } else if (!nextAudio.done) {
        await audioSource!.add(nextAudio.value.packet, nextAudio.value.meta);
        nextAudio = await audio.next();
      }
      job.onProgress(0.9 + 0.1 * Math.min(1, written / total), 'Writing the file');
    }
    if (subtitles && job.captions) {
      await subtitles.add(toVtt(job.captions.cues.filter((cue) => cue.start < total)));
    }
    await output.finalize();
    audioInput?.dispose();
    return { copied, audioCopied: copyAudio };
  } finally {
    (subtitleSurface as ReturnType<typeof createAssSurface> | null)?.dispose();
    for (const entry of opened) entry?.input.dispose();
  }
}

/**
 * Audio-only M4A for a plain timeline. Matching AAC packets are copied straight
 * into the MP4 muxer, so no decoder, encoder, or FFmpeg worker is involved.
 * Returns null when the project needs a real mix or the sources are not AAC.
 */
export async function exportAudioOnly(
  job: Pick<ExportJob, 'videos' | 'audios' | 'settings' | 'signal' | 'onProgress'>,
): Promise<Blob | null> {
  const { videos, audios, settings, signal } = job;
  if (!videos.length) return null;
  if (!canSkipSoundtrackMix(videos, audios, settings, null)) {
    if (!originalSoundOnly(videos, audios, settings, null)) return null;
    try {
      return await renderBrowserSoundtrack(videos, signal, job.onProgress);
    } catch (error) {
      if (signal.aborted) throw error;
      console.warn('Browser audio export unavailable; using FFmpeg.', error);
      return null;
    }
  }
  const opened: (OpenedMedia | null)[] = [];
  for (const clip of videos) opened.push(await openTrack(clip.blob));
  const tracks = opened.map((entry) => entry?.audio ?? null);
  try {
    if (tracks.some((track) => !track)) return null;
    if ((await tracks[0]!.getCodec()) !== 'aac') return null;
    if (tracks.length > 1 && !(await sameAudioConfig(tracks as InputAudioTrack[]))) return null;
    for (const [index, track] of tracks.entries()) {
      const length = videoClipLength(videos[index]);
      if ((await track!.computeDuration()) + 0.05 < length) return null;
    }

    const starts = videoStarts(videos);
    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
      target: new BufferTarget(),
    });
    const source = new EncodedAudioPacketSource('aac');
    output.addAudioTrack(source);
    await output.start();
    let first = true;
    for (const [index, track] of tracks.entries()) {
      signal.throwIfAborted();
      const audio = track!;
      const config = await audio.getDecoderConfig();
      const base = await audio.getFirstTimestamp();
      const length = videoClipLength(videos[index]);
      for await (const packet of new EncodedPacketSink(audio).packets()) {
        signal.throwIfAborted();
        const time = packet.timestamp - base;
        if (time >= length - 0.0005) break;
        await source.add(
          packet.clone({ timestamp: starts[index] + time }),
          first ? { decoderConfig: config ?? undefined } : undefined,
        );
        first = false;
      }
      job.onProgress((index + 1) / videos.length, 'Copying the soundtrack');
    }
    if (first) return null;
    await output.finalize();
    const buffer = (output.target as BufferTarget).buffer;
    return buffer?.byteLength ? new Blob([buffer], { type: 'audio/mp4' }) : null;
  } catch (error) {
    if (signal.aborted) throw error;
    console.warn('AAC-only export unavailable; using FFmpeg.', error);
    return null;
  } finally {
    for (const entry of opened) entry?.input.dispose();
  }
}

/** FFmpeg-only path for containers WebCodecs cannot read. */
async function exportWithFfmpeg(job: ExportJob, soundtrack: Blob | null): Promise<{ blob: Blob; copied: boolean }> {
  if (job.captions?.mode === 'burn') {
    throw new Error('Burned-in captions need WebCodecs, which cannot read one of these files. Use soft captions or convert the clip to MP4 first.');
  }
  if (job.graphics?.length) {
    throw new Error('Shape overlays need WebCodecs, which cannot read one of these files. Convert the clip to MP4 first.');
  }
  const ffmpeg = sharedFfmpeg();
  const plan = buildVideoPlan(job.videos, job.settings, {
    audioCount: job.audios.length,
    soundtrack: Boolean(soundtrack),
    srt: job.captions?.mode === 'soft' && job.captions.cues.length ? toSrt(job.captions.cues) : null,
  });
  const inputs: Blob[] = [...job.videos.map((clip) => clip.blob), ...job.audios.map((clip) => clip.blob)];
  if (soundtrack) inputs.push(soundtrack);
  const label = plan.copiesVideo ? 'Joining video (copied)' : 'Encoding video';
  const blob = await ffmpeg.run(inputs, plan.args, plan.output, plan.mime, {
    signal: job.signal,
    duration: plan.duration,
    texts: plan.texts,
    onProgress: ({ ratio }) => job.onProgress(0.1 + 0.9 * (ratio ?? 0), label),
  });
  return { blob, copied: plan.copiesVideo };
}

/** View untouched extracted sound as original audio for the packet-copy attempt. */
export function linkedSourceVideos(job: ExportJob): ExportVideoClip[] | null {
  if (!job.videos.length || job.videos.length !== job.audios.length) return null;
  const byGroup = new Map(job.audios.map((clip) => [clip.linkGroup, clip]));
  if (byGroup.size !== job.audios.length) return null;
  const starts = videoStarts(job.videos);
  const seen = new Set<number>();
  const videos: ExportVideoClip[] = [];
  for (const [index, video] of job.videos.entries()) {
    const group = video.linkGroup;
    const audio = byGroup.get(group);
    if (group === undefined || seen.has(group) || !audio || !video.mute || audio.blob !== video.blob) return null;
    if (audio.mute || audio.volume !== 1 || audio.fadeIn || audio.fadeOut || audio.retime ||
        (audio.sourceTrack ?? audio.track ?? 0) !== 0) return null;
    if (audio.offset !== starts[index] || audio.duration !== video.duration || audio.trimStart || audio.trimEnd) return null;
    seen.add(group);
    videos.push({ ...video, mute: false, volume: 1, audioTrack: 0 });
  }
  return canSkipSoundtrackMix(videos, [], job.settings, job.captions) ? videos : null;
}

export async function exportVideo(job: ExportJob): Promise<ExportResult> {
  const { videos, audios, settings, signal } = job;
  const ffmpeg = sharedFfmpeg();
  const streaming = Boolean(job.writable);
  let bytes = 0;

  const makeTarget = (): Target => {
    bytes = 0;
    return job.writable
      ? new StreamTarget(new WritableStream({
        write: async (chunk: { data: Uint8Array; position: number }) => {
          bytes = Math.max(bytes, chunk.position + chunk.data.byteLength);
          await job.writable!.write({ type: 'write', position: chunk.position, data: chunk.data as Uint8Array<ArrayBuffer> });
        },
      }), { chunked: true })
      : new BufferTarget();
  };

  let soundtrack: Blob | null = null;
  let mixTried = false;
  let mixError: unknown = null;
  const ensureSoundtrack = async (): Promise<void> => {
    if (mixTried || soundtrack) return;
    mixTried = true;
    try {
      const mix = buildAudioMixPlan(
        videos,
        audios,
        settings,
        settings.duckCaptions ? job.captions?.cues : undefined,
      );
      if (!mix) return;
      job.onProgress(0, 'Mixing the soundtrack');
      soundtrack = await ffmpeg.run(
        [...videos.map((clip) => clip.blob), ...audios.map((clip) => clip.blob)],
        mix.args,
        mix.output,
        mix.mime,
        {
          signal,
          duration: mix.duration,
          onProgress: ({ ratio }) => job.onProgress(0.1 * (ratio ?? 0), 'Mixing the soundtrack'),
        },
      );
      signal.throwIfAborted();
    } catch (error) {
      mixError = error;
      throw error;
    }
  };

  const attempt = async (allowAudioCopy: boolean) => {
    const target = makeTarget();
    const result = await exportWithWebCodecs(job, soundtrack, target, streaming, allowAudioCopy);
    return { target, result };
  };

  const finish = async (target: Target, result: { copied: boolean; audioCopied: boolean }): Promise<ExportResult> => {
    if (job.writable) {
      await job.writable.close();
      return { blob: null, engine: 'webcodecs', copied: result.copied, audioCopied: result.audioCopied, bytes };
    }
    const buffer = (target as BufferTarget).buffer!;
    return {
      blob: new Blob([buffer], { type: MERGE_FORMATS[settings.format].mime }),
      engine: 'webcodecs',
      copied: result.copied,
      audioCopied: result.audioCopied,
      bytes: buffer.byteLength,
    };
  };

  const linkedVideos = linkedSourceVideos(job);
  if (linkedVideos) {
    const target = makeTarget();
    try {
      const result = await exportWithWebCodecs({ ...job, videos: linkedVideos, audios: [] }, null, target, streaming, true, true);
      if (result?.audioCopied) return await finish(target, result);
    } catch (error) {
      if (signal.aborted) {
        await job.writable?.abort().catch(() => undefined);
        throw error;
      }
      // A streaming attempt may have written headers or packets before failing.
      if (job.writable) {
        await job.writable.truncate(0);
        await job.writable.seek(0);
      }
      console.warn('Linked audio could not be copied; using the original mix.', error);
    }
  }

  const plain = canSkipSoundtrackMix(videos, audios, settings, job.captions);
  // Trimmed original sound cannot be packet-copied without drift, but it can be
  // decoded and re-encoded in the browser. Real mixes still use FFmpeg.
  if (!plain) {
    let browser: Blob | null = null;
    if (originalSoundOnly(videos, audios, settings, job.captions)) {
      try {
        browser = await renderBrowserSoundtrack(videos, signal, job.onProgress);
      } catch (error) {
        if (signal.aborted) throw error;
        console.warn('Browser soundtrack unavailable; using FFmpeg.', error);
      }
    }
    if (browser) {
      soundtrack = browser;
      mixTried = true;
    } else {
      await ensureSoundtrack();
    }
  }

  try {
    let { target, result } = await attempt(plain);
    if (!result && plain) {
      // Audio packets did not match; fall back to the FFmpeg mix once.
      await ensureSoundtrack();
      ({ target, result } = await attempt(false));
    }
    if (result) return await finish(target, result);
  } catch (error) {
    if (signal.aborted) {
      await job.writable?.abort().catch(() => undefined);
      throw error;
    }
    if (mixError === error) throw error;
    // Some clip could not be handled by the browser's codecs; FFmpeg may.
    console.warn('WebCodecs export failed, using FFmpeg.', error);
    await ensureSoundtrack();
  }

  await ensureSoundtrack();
  if (job.captions?.mode === 'burn' && job.captions.ass?.length) {
    await job.writable?.abort().catch(() => undefined);
    throw new Error('Burning original subtitle styling requires a working browser video encoder and ASS renderer.');
  }
  if (job.videos.some((clip) => clip.effects?.dynamicZoom?.enabled)) {
    await job.writable?.abort().catch(() => undefined);
    throw new Error('Dynamic Zoom requires the browser video encoder. Try Chrome or Edge.');
  }
  if (job.videos.some((clip) => hasVisualAnimation(clip.animation))) {
    await job.writable?.abort().catch(() => undefined);
    throw new Error('Keyframed transform, opacity, or colour needs the browser encoder. Use Chrome or Edge, or remove the keyframes to export this file.');
  }
  let fallback: { blob: Blob; copied: boolean };
  try {
    fallback = await exportWithFfmpeg(job, soundtrack);
  } catch (error) {
    await job.writable?.abort().catch(() => undefined);
    throw error;
  }
  const { blob, copied } = fallback;
  if (job.writable) {
    // Discard anything the WebCodecs attempt wrote before it gave up.
    await job.writable.truncate(0);
    await job.writable.seek(0);
    await job.writable.write(blob);
    await job.writable.close();
    return { blob: null, engine: 'ffmpeg', copied, audioCopied: false, bytes: blob.size };
  }
  return { blob, engine: 'ffmpeg', copied, audioCopied: false, bytes: blob.size };
}

