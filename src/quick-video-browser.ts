/**
 * Quick tools: change-speed through WebCodecs. FFmpeg WASM re-encoded the
 * whole video at source size on the CPU (10 s of 4K did not finish in 300 s,
 * 5 min of 1080p took 199 s).
 *
 * The video is re-encoded by Mediabunny with the GPU encoder at a constant
 * output frame rate: each source frame is placed on the output grid after
 * dividing its time by the speed (frames are skipped for a speed-up and
 * repeated for slow motion), so the file plays at the chosen fps like
 * FFmpeg's output did. The
 * sound still goes through FFmpeg's atempo (pitch kept), which is audio-only
 * and quick, and FFmpeg muxes the two without re-encoding.
 */
import { ALL_FORMATS, BlobSource, BufferTarget, Conversion, Input, Mp4OutputFormat, Output } from 'mediabunny';
import { audioInputName, type AudioFfmpeg, type MediaProbe } from './audio-ffmpeg';
import { fitVideo, seconds, tempoFilters, type QuickVideoRun, type VideoOptions } from './quick-video';

/**
 * Output frame slots [first, last) that a source frame covers after its time
 * is divided by `speed`, on a grid of `fps`, never before `nextSlot`.
 */
export function retimeSlots(timestamp: number, duration: number, speed: number, fps: number, nextSlot: number, totalSlots: number): [number, number] {
  const from = timestamp / speed;
  const to = (timestamp + duration) / speed;
  const first = Math.max(nextSlot, Math.ceil(from * fps - 1e-6));
  const last = Math.min(Math.ceil(to * fps - 1e-6), totalSlots);
  return [first, Math.max(first, last)];
}

/** Same bits-per-pixel curve as the exporter's browser encodes. */
function bitrateFor(width: number, height: number, fps: number, quality: number): number {
  const bpp = 0.003 + (Math.min(100, Math.max(1, quality)) / 100) ** 2 * 0.27;
  return Math.max(250_000, Math.round(width * height * fps * bpp));
}

async function retimedVideo(
  file: Blob,
  probe: MediaProbe,
  options: VideoOptions,
  outputFps: number,
  signal: AbortSignal | undefined,
  onProgress: (ratio: number) => void,
): Promise<Blob | null> {
  const speed = options.speed;
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track || !(await track.canDecode())) return null;
    const { width, height } = fitVideo(probe, options.resolution);
    const sourceFrame = 1 / (probe.fps || 30);
    const totalSlots = Math.max(1, Math.round(((options.range.end - options.range.start) / speed) * outputFps));
    let nextSlot = 0;
    const target = new BufferTarget();
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target });
    const conversion = await Conversion.init({
      input,
      output,
      tracks: 'primary',
      audio: { discard: true },
      trim: { start: options.range.start, end: options.range.end },
      video: {
        codec: 'avc',
        width,
        height,
        fit: 'contain',
        bitrate: bitrateFor(width, height, outputFps, options.quality),
        forceTranscode: true,
        hardwareAcceleration: 'prefer-hardware',
        process: (sample) => {
          // Output slots k / fps covered by this frame once retimed. The
          // sample is already rebased to the trim start.
          const [first, last] = retimeSlots(sample.timestamp, sample.duration || sourceFrame, speed, outputFps, nextSlot, totalSlots);
          if (first >= last) return null;
          const frames = [];
          for (let slot = first; slot < last; slot += 1) {
            const frame = slot === first ? sample : sample.clone();
            frame.setTimestamp(slot / outputFps);
            frame.setDuration(1 / outputFps);
            frames.push(frame);
          }
          nextSlot = last;
          return frames;
        },
      },
    });
    if (!conversion.isValid) return null;
    conversion.onProgress = (progress) => onProgress(progress);
    const stop = (): void => void conversion.cancel();
    signal?.addEventListener('abort', stop, { once: true });
    try {
      signal?.throwIfAborted();
      await conversion.execute();
      signal?.throwIfAborted();
    } finally {
      signal?.removeEventListener('abort', stop);
    }
    return target.buffer ? new Blob([target.buffer], { type: 'video/mp4' }) : null;
  } finally {
    input.dispose();
  }
}

/**
 * Change the speed with the browser encoder. Returns null when this browser or
 * file cannot take the path (the caller then uses FFmpeg).
 */
export async function changeSpeedInBrowser(
  ffmpeg: AudioFfmpeg,
  file: File,
  probe: MediaProbe,
  options: VideoOptions,
  run: QuickVideoRun,
): Promise<Blob | null> {
  if (typeof VideoEncoder === 'undefined' || typeof VideoDecoder === 'undefined') return null;
  const speed = options.speed;
  if (!Number.isFinite(speed) || speed < 0.1 || speed > 16) return null;
  const { start, end } = options.range;
  const span = end - start;
  const outputDuration = span / speed;
  const outputFps = options.fps || Math.min(60, Math.max(1, Math.round(probe.fps || 30)));
  const withAudio = probe.hasAudio && options.audio !== 'mute';
  const report = (ratio: number): void => run.onProgress?.({ ratio, time: ratio * outputDuration });
  const video = await retimedVideo(file, probe, options, outputFps, run.signal,
    (ratio) => report((withAudio ? 0.85 : 1) * ratio));
  if (!video) return null;
  if (!withAudio) return video;
  const full = start === 0 && Math.abs(end - probe.duration) <= 0.005;
  const seek = [...(start > 0 ? ['-ss', seconds(start)] : []), ...(!full ? ['-t', seconds(span)] : [])];
  const audio = await ffmpeg.run(file, [...seek, '-i', 'input.media', '-map', '0:a:0', '-vn',
    '-af', ['asetpts=PTS-STARTPTS', ...tempoFilters(speed)].join(','), '-c:a', 'aac', '-b:a', '128k', 'audio.m4a'],
  'audio.m4a', 'audio/mp4', { ...run, duration: outputDuration, onProgress: undefined });
  run.signal?.throwIfAborted();
  report(0.95);
  return ffmpeg.run([video, audio], ['-i', audioInputName(0), '-i', audioInputName(1), '-map', '0:v:0', '-map', '1:a:0',
    '-c', 'copy', '-shortest', '-movflags', '+faststart', 'video.mp4'],
  'video.mp4', 'video/mp4', { ...run, duration: outputDuration, onProgress: undefined });
}
