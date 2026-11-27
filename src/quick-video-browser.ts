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
import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  CanvasSink,
  CanvasSource,
  Conversion,
  Input,
  Mp4OutputFormat,
  Output,
  VideoSample,
  VideoSampleSink,
  VideoSampleSource,
  type InputVideoTrack,
} from 'mediabunny';
import { i420Size, sampleToI420 } from './yuv-frames';
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

/**
 * FFmpeg output options that clear the colour tags of an H.264 stream and
 * leave out the MP4 colr box. The browser encoder writes its own tags (BT.709
 * or BT.601); for a source without tags, the output must have none either, so
 * each player shows it the way it shows the source.
 */
const UNTAG_VIDEO = [
  '-bsf:v', 'h264_metadata=colour_primaries=2:transfer_characteristics=2:matrix_coefficients=2:video_full_range_flag=0',
  '-color_primaries', 'unspecified', '-color_trc', 'unspecified', '-colorspace', 'unspecified',
];

/** True when the file itself has no colour tags (the decoder then guesses). */
async function hasNoColourTags(track: InputVideoTrack): Promise<boolean> {
  const colorSpace = await track.getColorSpace();
  return !colorSpace.matrix && !colorSpace.primaries && !colorSpace.transfer;
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
): Promise<{ blob: Blob; untagged: boolean } | null> {
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
    if (!target.buffer) return null;
    // Frames go to the encoder as decoded (no canvas) when the size is kept,
    // so an untagged source keeps its values and only the tags need clearing.
    const sameSize = width === track.displayWidth && height === track.displayHeight;
    return { blob: new Blob([target.buffer], { type: 'video/mp4' }), untagged: sameSize && await hasNoColourTags(track) };
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
  const retimed = await retimedVideo(file, probe, options, outputFps, run.signal,
    (ratio) => report((withAudio ? 0.85 : 1) * ratio));
  if (!retimed) return null;
  const video = retimed.blob;
  const untag = retimed.untagged ? UNTAG_VIDEO : [];
  if (!withAudio) {
    if (!retimed.untagged) return video;
    return ffmpeg.run(video, ['-i', audioInputName(0), '-map', '0:v:0', '-c', 'copy', ...untag, '-movflags', '+faststart', 'video.mp4'],
      'video.mp4', 'video/mp4', { ...run, duration: outputDuration, onProgress: undefined });
  }
  const full = start === 0 && Math.abs(end - probe.duration) <= 0.005;
  const seek = [...(start > 0 ? ['-ss', seconds(start)] : []), ...(!full ? ['-t', seconds(span)] : [])];
  const audio = await ffmpeg.run(file, [...seek, '-i', 'input.media', '-map', '0:a:0', '-vn',
    '-af', ['asetpts=PTS-STARTPTS', ...tempoFilters(speed)].join(','), '-c:a', 'aac', '-b:a', '128k', 'audio.m4a'],
  'audio.m4a', 'audio/mp4', { ...run, duration: outputDuration, onProgress: undefined });
  run.signal?.throwIfAborted();
  report(0.95);
  return ffmpeg.run([video, audio], ['-i', audioInputName(0), '-i', audioInputName(1), '-map', '0:v:0', '-map', '1:a:0',
    '-c', 'copy', ...untag, '-shortest', '-movflags', '+faststart', 'video.mp4'],
  'video.mp4', 'video/mp4', { ...run, duration: outputDuration, onProgress: undefined });
}

/** Frames held per block while reversing: about 256 MB of RGBA at output size. */
export function reverseBlockFrames(width: number, height: number): number {
  return Math.max(4, Math.min(120, Math.floor(256_000_000 / (width * height * 4))));
}

interface ReverseJob {
  track: InputVideoTrack;
  width: number;
  height: number;
  fps: number;
  total: number;
  start: number;
  end: number;
  speed: number;
  quality: number;
  run: QuickVideoRun;
  /** Share of the progress bar the video takes (the sound takes the rest). */
  share: number;
  /** The source file's colour description (not the decoder's guess). */
  colorSpace: VideoColorSpaceInit;
}

/**
 * Source times for forward output frames [first, last): frame j shows source
 * time start + j * speed / fps. The small offset keeps a time that lands on a
 * frame boundary on that frame.
 */
function reverseTimes(job: ReverseJob, first: number, last: number): number[] {
  const times: number[] = [];
  for (let j = first; j < last; j += 1) times.push(Math.min(job.end - 1e-4, job.start + (j * job.speed) / job.fps + 1e-4));
  return times;
}

/**
 * Reverse from raw I420 frames: decoded planes are copied and scaled as they
 * are, and the encoder gets the source file's colour description. Returns null
 * when the decoder hands out a format this path does not read.
 */
async function reverseFramesYuv(job: ReverseJob): Promise<Blob | null> {
  const { width, height, fps, total, run } = job;
  const sink = new VideoSampleSink(job.track);
  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target });
  const source = new VideoSampleSource({
    codec: 'avc',
    bitrate: bitrateFor(width, height, fps, job.quality),
    keyFrameInterval: 2,
    hardwareAcceleration: 'prefer-hardware',
  });
  output.addVideoTrack(source, { frameRate: fps });
  const block = Math.max(4, Math.min(120, Math.floor(256_000_000 / i420Size(width, height))));
  const colorSpace = job.colorSpace;
  let started = false;
  let written = 0;
  for (let last = total; last > 0;) {
    run.signal?.throwIfAborted();
    const first = Math.max(0, last - block);
    const frames: (Uint8Array | null)[] = [];
    for await (const sample of sink.samplesAtTimestamps(reverseTimes(job, first, last))) {
      if (!sample) {
        frames.push(null);
        continue;
      }
      try {
        const data = await sampleToI420(sample, width, height);
        if (!data) {
          if (started) throw new Error(`Unsupported decoded frame format ${sample.format}.`);
          await output.cancel().catch(() => undefined);
          return null;
        }
        frames.push(data);
      } finally {
        sample.close();
      }
    }
    if (!started) {
      await output.start();
      started = true;
    }
    for (let index = frames.length - 1; index >= 0; index -= 1) {
      const data = frames[index] ?? frames.find(Boolean);
      if (!data) throw new Error('The video could not be decoded.');
      const frame = new VideoSample(data, {
        format: 'I420',
        codedWidth: width,
        codedHeight: height,
        timestamp: written / fps,
        duration: 1 / fps,
        colorSpace,
      });
      try {
        await source.add(frame);
      } finally {
        frame.close();
      }
      written += 1;
    }
    run.onProgress?.({ ratio: job.share * (written / total), time: written / fps });
    last = first;
  }
  await output.finalize();
  return target.buffer ? new Blob([target.buffer], { type: 'video/mp4' }) : null;
}

/** Reverse through a canvas (rotated sources, formats the YUV path does not read). */
async function reverseFramesCanvas(job: ReverseJob): Promise<Blob | null> {
  const { width, height, fps, total, run } = job;
  const sink = new CanvasSink(job.track, { width, height, fit: 'contain' });
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  if (!context) return null;
  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target });
  const source = new CanvasSource(canvas, {
    codec: 'avc',
    bitrate: bitrateFor(width, height, fps, job.quality),
    keyFrameInterval: 2,
    hardwareAcceleration: 'prefer-hardware',
  });
  output.addVideoTrack(source, { frameRate: fps });
  await output.start();
  const block = reverseBlockFrames(width, height);
  let written = 0;
  for (let last = total; last > 0;) {
    run.signal?.throwIfAborted();
    const first = Math.max(0, last - block);
    const frames: (ImageBitmap | null)[] = [];
    for await (const wrapped of sink.canvasesAtTimestamps(reverseTimes(job, first, last))) {
      frames.push(wrapped ? await createImageBitmap(wrapped.canvas) : null);
    }
    for (let index = frames.length - 1; index >= 0; index -= 1) {
      const frame = frames[index] ?? frames.find(Boolean) ?? null;
      context.fillStyle = '#000';
      context.fillRect(0, 0, width, height);
      if (frame) context.drawImage(frame, 0, 0, width, height);
      await source.add(written / fps, 1 / fps);
      written += 1;
    }
    for (const frame of frames) frame?.close();
    run.onProgress?.({ ratio: job.share * (written / total), time: written / fps });
    last = first;
  }
  await output.finalize();
  return target.buffer ? new Blob([target.buffer], { type: 'video/mp4' }) : null;
}

/**
 * Reverse with the browser decoder and encoder. The source is decoded in
 * blocks from the end (frames kept at output size), each block is written in
 * reverse order, and the sound (original or reversed, with the speed) comes
 * from FFmpeg's audio-only filters. FFmpeg WASM reversed and concatenated
 * re-encoded blocks on the CPU, which did not finish 5 minutes in 300 s.
 * Returns null when the browser or file cannot take this path.
 */
export async function reverseInBrowser(
  ffmpeg: AudioFfmpeg,
  file: File,
  probe: MediaProbe,
  options: VideoOptions,
  run: QuickVideoRun,
): Promise<Blob | null> {
  if (typeof VideoEncoder === 'undefined' || typeof VideoDecoder === 'undefined' || typeof OffscreenCanvas === 'undefined') return null;
  const speed = options.speed;
  if (!Number.isFinite(speed) || speed < 0.1 || speed > 16) return null;
  const { start, end } = options.range;
  const span = end - start;
  const outputDuration = span / speed;
  const fps = options.fps || Math.min(30, probe.fps || 30);
  const total = Math.max(1, Math.ceil(outputDuration * fps - 1e-7));
  const withAudio = probe.hasAudio && options.audio !== 'mute';
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  let video: Blob | null = null;
  // The encoder writes its own colour tags (BT.601 for these frames); an
  // untagged source must give an untagged output, so the mux clears them.
  let keepUntagged = false;
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track || !(await track.canDecode())) return null;
    const { width, height } = fitVideo(probe, options.resolution);
    // What the file itself says about its colours. The decoder reports its own
    // guess (BT.709 for HD) when the file says nothing.
    const colorSpace = await track.getColorSpace();
    const untagged = await hasNoColourTags(track);
    const job: ReverseJob = {
      track, width, height, fps, total, start, end, speed, quality: options.quality, run,
      share: withAudio ? 0.9 : 1, colorSpace,
    };
    // A file without colour tags is shown with BT.709 by browsers (and mpv,
    // VLC) but BT.601 by FFmpeg-based tools. Drawing it through a canvas would
    // bake the browser's choice into the output; copying the YUV planes keeps
    // the source's values and leaves the output untagged too, so every player
    // shows it as it shows the source. Tagged files are unambiguous and take
    // the faster canvas path (the YUV copy is about 3x slower).
    if (untagged && (await track.getRotation()) === 0) {
      video = await reverseFramesYuv(job);
      keepUntagged = Boolean(video);
    }
    video ??= await reverseFramesCanvas(job);
  } finally {
    input.dispose();
  }
  if (!video) return null;
  const untagVideo = keepUntagged ? UNTAG_VIDEO : [];
  if (!withAudio) {
    if (!keepUntagged) return video;
    return ffmpeg.run(video, ['-i', audioInputName(0), '-map', '0:v:0', '-c', 'copy', ...untagVideo, '-movflags', '+faststart', 'reverse.mp4'],
      'reverse.mp4', 'video/mp4', { ...run, duration: outputDuration, onProgress: undefined });
  }
  const full = start === 0 && Math.abs(end - probe.duration) <= 0.005;
  const seek = [...(start > 0 ? ['-ss', seconds(start)] : []), ...(!full ? ['-t', seconds(span)] : [])];
  const filters = ['asetpts=PTS-STARTPTS', ...(options.audio === 'reverse' ? ['areverse'] : []), ...tempoFilters(speed)];
  const audio = await ffmpeg.run(file, [...seek, '-i', 'input.media', '-map', '0:a:0', '-vn', '-af', filters.join(','),
    '-c:a', 'aac', '-b:a', '128k', 'audio.m4a'], 'audio.m4a', 'audio/mp4', { ...run, duration: outputDuration, onProgress: undefined });
  run.signal?.throwIfAborted();
  return ffmpeg.run([video, audio], ['-i', audioInputName(0), '-i', audioInputName(1), '-map', '0:v:0', '-map', '1:a:0',
    '-c', 'copy', ...untagVideo, '-shortest', '-movflags', '+faststart', 'reverse.mp4'],
  'reverse.mp4', 'video/mp4', { ...run, duration: outputDuration, onProgress: undefined });
}
