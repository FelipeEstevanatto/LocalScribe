/**
 * File converter, video targets: the browser path. MP4, MOV, MKV and WebM
 * sources going to MP4, MOV, MKV or WebM with the Auto codec use the editor's
 * exporter: streams the target container accepts are copied (mp4 to mov took
 * 25.6 s in single-thread FFmpeg, a copy takes about 0.2 s) and the rest is
 * encoded with WebCodecs. Anything else, or any failure, returns null and the
 * caller uses FFmpeg as before.
 */
import type { VideoSettings } from './converter-catalog';
import { MERGE_FORMATS, type MergeFormat, type MergeSettings } from './video-merge-args';

const BROWSER_SOURCES = /\.(mp4|m4v|mov|webm|mkv)$/i;
/**
 * Source video codecs (Mediabunny names) each target keeps as they are with
 * the Auto codec. Others are re-encoded, as FFmpeg's Auto did: an MP4 from the
 * converter should still play everywhere, so VP9 or AV1 becomes H.264.
 */
const KEEP_CODECS: Record<MergeFormat, readonly string[]> = {
  mp4: ['avc', 'hevc'],
  mov: ['avc', 'hevc'],
  mkv: ['avc', 'hevc', 'vp8', 'vp9', 'av1'],
  webm: ['vp8', 'vp9', 'av1'],
};

export function isBrowserVideoTarget(target: string): target is MergeFormat {
  return Object.hasOwn(MERGE_FORMATS, target);
}

/** The converter's CRF (x264 scale) as the exporter's 0-100 quality. */
export function crfQuality(crf: number): number {
  return Math.max(1, Math.min(100, Math.round((42 - crf) / 0.32)));
}

/** True when the settings mean the same thing on the browser path. */
export function canConvertInBrowser(fileName: string, target: string, settings: VideoSettings): boolean {
  return isBrowserVideoTarget(target) && BROWSER_SOURCES.test(fileName) && settings.codec === 'auto' &&
    (settings.audioStream === 'keep' || settings.audioStream === 'mute') && settings.resolution !== 'custom';
}

export async function convertVideoInBrowser(
  file: File,
  target: string,
  settings: VideoSettings,
  signal: AbortSignal | undefined,
  onProgress: (ratio: number) => void,
): Promise<{ blob: Blob; copied: boolean } | null> {
  if (!canConvertInBrowser(file.name, target, settings) || !isBrowserVideoTarget(target)) return null;
  const { exportVideo, webCodecsSupported } = await import('./video-export');
  if (!webCodecsSupported()) return null;
  const { sharedMedia } = await import('./media-router');
  const router = sharedMedia();
  const probe = await router.probe(file, signal);
  if (router.lastEngine === 'ffmpeg' || !probe.hasVideo || !probe.width || !probe.height || !(probe.duration > 0)) return null;

  const job: MergeSettings = {
    format: target,
    keepOriginal: settings.audioStream === 'keep',
    originalVolume: 1,
    preset: 'source',
    targetMB: null,
    quality: crfQuality(settings.crf),
    reencode: !KEEP_CODECS[target].includes(probe.videoCodec ?? ''),
  };
  if (settings.resolution !== 'source') {
    // FFmpeg scaled to this height (scale=-2:h). The exporter caps the short
    // side, which is the same thing for landscape video that is not upscaled.
    const height = Number.parseInt(settings.resolution, 10);
    if (!(height > 0) || probe.height > probe.width || height > probe.height) return null;
    if (height < probe.height) job.maxShortEdge = height;
  }
  if (settings.fps !== 'source') {
    const fps = Number(settings.fps);
    if (!(fps > 0)) return null;
    job.frameRate = fps;
  }
  const controller = new AbortController();
  const stop = (): void => controller.abort(signal?.reason);
  signal?.addEventListener('abort', stop, { once: true });
  try {
    const result = await exportVideo({
      videos: [{ blob: file, probe, duration: probe.duration, trimStart: 0, trimEnd: 0 }],
      audios: [],
      captions: null,
      settings: job,
      writable: null,
      signal: controller.signal,
      onProgress: (fraction) => onProgress(fraction),
    });
    if (!result.blob) return null;
    return { blob: result.blob, copied: result.copied };
  } finally {
    signal?.removeEventListener('abort', stop);
  }
}
