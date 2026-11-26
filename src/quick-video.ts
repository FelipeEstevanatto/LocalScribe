import { AUDIO_FORMATS, audioInputName, type AudioFfmpeg, type AudioFormat, type MediaProbe, type RunOptions } from './audio-ffmpeg';
import { MERGE_FORMATS, type MergeFormat, type MergePreset } from './video-merge-args';
import { sharedMedia } from './media-router';

export const VIDEO_FORMATS = {
  ...MERGE_FORMATS,
  avi: { label: 'AVI', mime: 'video/x-msvideo' },
  m4v: { label: 'M4V', mime: 'video/mp4' },
  mpeg: { label: 'MPEG', mime: 'video/mpeg' },
  '3gp': { label: '3GP', mime: 'video/3gpp' },
};
export type VideoFormat = keyof typeof VIDEO_FORMATS;
export type VideoOperation = 'video-converter' | 'video-compressor' | 'video-trimmer' | 'extract-audio' |
  'rotate-video' | 'video-watermark' | 'video-to-gif' | 'change-speed' | 'extract-frames' | 'reverse-video';

export interface VideoOptions {
  format: VideoFormat;
  audioFormat: AudioFormat;
  resolution: number;
  quality: number;
  targetMB: number;
  range: { start: number; end: number };
  copy: boolean;
  bitrate: number;
  track: number;
  rotation: number;
  flipX: boolean;
  flipY: boolean;
  speed: number;
  audio: 'keep' | 'mute' | 'reverse';
  fps: number;
  loop: number;
  interval: number;
  frameFormat: 'png' | 'jpg';
  overlay?: Blob;
}

export interface ToolFile { name: string; blob: Blob }
export interface VideoOutput { files: ToolFile[]; note?: string }
export interface QuickVideoRun extends RunOptions {
  disk?: FileSystemFileHandle;
}
export interface Size { width: number; height: number }

export const seconds = (value: number) => Number(value.toFixed(6)).toString();
const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);
const src = 'input.media';

export function parseTime(input: string): number {
  const fields = input.trim().split(':');
  if (!fields.length || fields.length > 3 || !fields.every(x => /^\d+(?:\.\d+)?$/.test(x))) return NaN;
  if (fields.slice(0, -1).some(x => !/^\d+$/.test(x))) return NaN;
  if (fields.length > 1 && fields.slice(1).some(x => Number(x) >= 60)) return NaN;
  return fields.reduce((result, part) => result * 60 + Number(part), 0);
}

export function timeLabel(value: number): string {
  const ms = Math.round(value * 1000);
  const components = [Math.floor(ms / 3600000), Math.floor(ms / 60000) % 60, Math.floor(ms / 1000) % 60];
  return components.map(n => String(n).padStart(2, '0')).join(':') + '.' + String(ms % 1000).padStart(3, '0');
}

export function clipRange(start: number, end: number, duration: number): { start: number; end: number } {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= end || end > duration + 0.005) {
    throw new Error('Choose a start and end inside the video.');
  }
  return { start, end: Math.min(end, duration) };
}

export function fitVideo({ width, height }: Size, limit: number): Size {
  const scale = limit ? Math.min(1, limit / Math.min(width, height)) : 1;
  return { width: even(width * scale), height: even(height * scale) };
}

export function tempoFilters(speed: number): string[] {
  if (!Number.isFinite(speed) || speed < 0.1 || speed > 16) throw new Error('Speed must be 0.1× to 16×.');
  const filters: string[] = [];
  while (speed < 0.5) { filters.push('atempo=0.5'); speed *= 2; }
  while (speed > 2) { filters.push('atempo=2'); speed /= 2; }
  if (Math.abs(speed - 1) > 0.00001) filters.push('atempo=' + seconds(speed));
  return filters;
}

function nativeFormat(format: VideoFormat): format is MergeFormat {
  return Object.hasOwn(MERGE_FORMATS, format);
}

function videoCodec(format: VideoFormat, quality: number, bitrate?: number): string[] {
  const crf = String(Math.round(42 - quality * 0.32));
  const q = String(Math.round(25 - quality * 0.23));
  switch (format) {
    case 'webm': return ['-c:v', 'libvpx', '-deadline', 'good', '-cpu-used', '5', '-crf', crf, '-b:v', String(bitrate ?? 3_000_000), '-c:a', 'libvorbis'];
    case 'avi': return ['-c:v', 'mpeg4', '-q:v', q, '-c:a', 'libmp3lame'];
    case 'mpeg': return ['-c:v', 'mpeg2video', '-q:v', q, '-r', '30', '-c:a', 'mp2', '-ar', '48000', '-ac', '2'];
    case '3gp': return ['-c:v', 'mpeg4', '-q:v', q, '-c:a', 'aac'];
    default: return ['-c:v', 'libx264', '-preset', 'veryfast', ...(bitrate ? ['-b:v', String(bitrate), '-maxrate', String(bitrate), '-bufsize', String(bitrate * 2)] : ['-crf', crf]), '-c:a', 'aac', '-b:a', '128k'];
  }
}

function formatArgs(format: VideoFormat): string[] {
  return format === 'm4v' ? ['-f', 'mp4'] : [];
}

function targetBitrate(mb: number, duration: number, hasAudio: boolean): number | undefined {
  if (!mb) return undefined;
  const rate = Math.floor(mb * 8_000_000 * 0.95 / duration - (hasAudio ? 128_000 : 0));
  if (rate < 48_000) throw new Error('This size target is too small for the selected duration. Use a larger target or trim the clip.');
  return rate;
}

function outputOptions(options: RunOptions, duration: number): RunOptions {
  return { ...options, duration };
}

function transformFilter(probe: MediaProbe, options: VideoOptions, rotated = false): string[] {
  const width = rotated ? probe.height : probe.width;
  const height = rotated ? probe.width : probe.height;
  const fitted = fitVideo({ width, height }, options.resolution);
  // Scale the decoded display frame. FFmpeg already handles source rotation.
  const cap = options.resolution;
  return cap && (fitted.width !== width || fitted.height !== height)
    ? [`scale=w='if(gte(iw,ih),-2,trunc(min(iw,${cap})/2)*2)':h='if(gte(iw,ih),trunc(min(ih,${cap})/2)*2,-2)'`]
    : [];
}

export function splitImageStream(bytes: Uint8Array<ArrayBuffer>, format: VideoOptions['frameFormat']): Blob[] {
  const frames: Blob[] = [];
  let start = 0;
  if (format === 'png') {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 8;
    while (offset + 12 <= bytes.length) {
      const size = view.getUint32(offset);
      const kind = view.getUint32(offset + 4);
      offset += size + 12;
      if (offset > bytes.length) throw new Error('An extracted PNG is incomplete.');
      if (kind !== 0x49454e44) continue;
      frames.push(new Blob([bytes.subarray(start, offset)], { type: 'image/png' }));
      start = offset;
      offset += 8;
    }
  } else {
    for (let i = 1; i < bytes.length; i++) {
      if (bytes[i - 1] !== 0xff || bytes[i] !== 0xd9) continue;
      if (bytes[start] !== 0xff || bytes[start + 1] !== 0xd8) throw new Error('An extracted JPEG is incomplete.');
      frames.push(new Blob([bytes.subarray(start, i + 1)], { type: 'image/jpeg' }));
      start = i + 1;
    }
  }
  if (!frames.length || start !== bytes.length) throw new Error('No complete frames were extracted.');
  return frames;
}

async function reverseVideo(ffmpeg: AudioFfmpeg, file: File, probe: MediaProbe, options: VideoOptions, run: RunOptions): Promise<Blob> {
  const { start, end } = options.range;
  const duration = end - start;
  const { width, height } = fitVideo(probe, options.resolution);
  const fps = options.fps || Math.min(30, probe.fps || 30);
  // Reverse bounded blocks, quantized to output frame boundaries. The final
  // command muxes original or reversed audio over the concatenated video.
  const blockSeconds = Math.min(8, 56_000_000 / (width * height * 1.5 * fps));
  const frameCount = Math.max(1, Math.ceil(duration * fps - 1e-7));
  const blockFrames = Math.max(1, Math.floor(blockSeconds * fps));
  const count = Math.ceil(frameCount / blockFrames);
  const pieces: Blob[] = [];
  for (let last = frameCount; last > 0;) {
    run.signal?.throwIfAborted();
    const first = Math.max(0, last - blockFrames);
    const chunkLength = Math.min(duration - first / fps, (last - first) / fps);
    const filters = [...transformFilter(probe, options), `fps=${fps}`, 'reverse', 'setpts=PTS-STARTPTS'];
    const args = ['-ss', seconds(start + first / fps), '-t', seconds(chunkLength), '-i', src, '-map', '0:v:0', '-an',
      '-vf', filters.join(','), ...videoCodec('mp4', options.quality), '-pix_fmt', 'yuv420p', 'piece.mp4'];
    const base = pieces.length;
    pieces.push(await ffmpeg.run(file, args, 'piece.mp4', 'video/mp4', {
      ...outputOptions(run, chunkLength),
      onProgress: (progress) => run.onProgress?.({ ...progress, ratio: 0.9 * (base + (progress.ratio ?? 0)) / count }),
    }));
    last = first;
  }
  const texts = [{ name: 'pieces.txt', content: pieces.map((_, i) => `file '${audioInputName(i)}'`).join('\n') }];
  const args = ['-f', 'concat', '-safe', '0', '-i', 'pieces.txt', '-map', '0:v:0'];
  const inputs = [...pieces];
  if (probe.hasAudio && options.audio !== 'mute') {
    inputs.push(file);
    args.splice(6, 0, '-ss', seconds(start), '-t', seconds(duration), '-i', audioInputName(pieces.length));
    args.push('-map', '1:a:0', '-af', ['asetpts=PTS-STARTPTS', ...(options.audio === 'reverse' ? ['areverse'] : []), ...tempoFilters(options.speed)].join(','),
      '-c:a', 'aac', '-b:a', '128k', '-shortest');
  }
  if (options.speed === 1) args.push('-c:v', 'copy');
  else args.push('-vf', `settb=AVTB,setpts=(PTS-STARTPTS)/${seconds(options.speed)},fps=${fps}`,
    ...videoCodec('mp4', options.quality), '-pix_fmt', 'yuv420p');
  args.push('-movflags', '+faststart', 'reverse.mp4');
  return ffmpeg.run(inputs, args, 'reverse.mp4', 'video/mp4', { ...outputOptions(run, duration / options.speed), texts,
    onProgress: (progress) => run.onProgress?.({ ...progress, ratio: 0.9 + 0.1 * (progress.ratio ?? 0) }) });
}

/** Map a Quick Tools pixel cap onto the editor's output presets. */
function resolutionSettings(resolution: number): { preset: MergePreset; maxShortEdge?: number } {
  if (resolution === 1080) return { preset: '1080p' };
  if (resolution === 720) return { preset: '720p' };
  if (resolution === 480) return { preset: '480p' };
  if (resolution > 0) return { preset: 'source', maxShortEdge: resolution };
  return { preset: 'source' };
}

/** Native-format converter, compressor, and exact trim through WebCodecs. */
async function browserVideoExport(
  file: File,
  probe: MediaProbe,
  operation: VideoOperation,
  options: VideoOptions,
  run: QuickVideoRun,
  base: string,
): Promise<VideoOutput | null> {
  if (!['video-converter', 'video-trimmer', 'video-compressor'].includes(operation)) return null;
  const format = operation === 'video-compressor' ? 'mp4' : options.format;
  if (!nativeFormat(format) || typeof VideoEncoder === 'undefined') return null;
  if (options.rotation || options.flipX || options.flipY || options.overlay) return null;
  // "Fast cut" promises a keyframe stream copy. The WebCodecs exporter can
  // only copy when the head is not trimmed, so a fast cut that moves the
  // start goes to FFmpeg's stream copy instead of being silently re-encoded.
  if (operation === 'video-trimmer' && options.copy && options.range.start > 0) return null;
  const { preset, maxShortEdge } = resolutionSettings(options.resolution);
  const mime = VIDEO_FORMATS[format].mime;
  try {
    const { exportVideo } = await import('./video-export');
    const writable = run.disk ? await run.disk.createWritable() : null;
    const result = await exportVideo({
      videos: [{
        blob: file,
        probe,
        duration: probe.duration,
        trimStart: options.range.start,
        trimEnd: Math.max(0, probe.duration - options.range.end),
      }],
      audios: [],
      captions: null,
      settings: {
        format,
        keepOriginal: options.audio !== 'mute',
        originalVolume: 1,
        preset,
        maxShortEdge,
        targetMB: operation === 'video-compressor' && options.targetMB > 0 ? options.targetMB : null,
        quality: options.quality,
        // "Copy compatible streams" is the only way to keep the source codec.
        reencode: operation === 'video-compressor' || !options.copy,
      },
      writable,
      signal: run.signal ?? new AbortController().signal,
      onProgress: (ratio) => run.onProgress?.({ ratio, time: ratio * Math.max(0, options.range.end - options.range.start) }),
    });
    const how = result.engine === 'ffmpeg'
      ? 'Re-encoded for compatibility.'
      : result.copied ? 'Video stream copied.' : 'Re-encoded in the browser.';
    if (writable && run.disk) {
      const saved = await run.disk.getFile();
      return { files: [{ name: saved.name, blob: new Blob([saved], { type: mime }) }], note: how };
    }
    if (!result.blob) return null;
    return { files: [{ name: `${base}-${operation}.${format}`, blob: result.blob }], note: how };
  } catch (error) {
    if (run.signal?.aborted) run.signal.throwIfAborted();
    console.warn('Browser video export unavailable; using FFmpeg.', error);
    return null;
  }
}

/** Copy AAC or use the fast audio encoder before asking FFmpeg. */
async function browserAudioExport(
  file: File,
  probe: MediaProbe,
  options: VideoOptions,
  run: QuickVideoRun,
): Promise<Blob | null> {
  if (options.track !== 0) return null;
  if (options.copy && (options.audioFormat === 'm4a' || options.audioFormat === 'aac')) {
    try {
      const { remuxAudioTrack } = await import('./mediabunny-engine');
      const blob = await remuxAudioTrack(file, 0, options.audioFormat, run.signal);
      if (blob) return blob;
    } catch (error) {
      if (run.signal?.aborted) run.signal.throwIfAborted();
      console.warn('AAC remux unavailable; using FFmpeg.', error);
    }
  }
  if (!options.copy && !options.bitrate) {
    try {
      return await sharedMedia().encode(file, options.audioFormat, {
        signal: run.signal,
        onProgress: ({ ratio, time }) => run.onProgress?.({
          ratio,
          time: time ?? (ratio ?? 0) * probe.duration,
        }),
      });
    } catch (error) {
      if (run.signal?.aborted) run.signal.throwIfAborted();
      console.warn('Fast audio export unavailable; using FFmpeg.', error);
    }
  }
  return null;
}

export async function processVideo(ffmpeg: AudioFfmpeg, operation: VideoOperation, file: File, probe: MediaProbe, options: VideoOptions, run: QuickVideoRun): Promise<VideoOutput> {
  const base = file.name.replace(/\.[^.]+$/, '') || 'video';
  const { start, end } = options.range;
  const duration = end - start;
  const full = start === 0 && Math.abs(end - probe.duration) <= 0.005;
  const seek = [...(start > 0 ? ['-ss', seconds(start)] : []), ...(!full ? ['-t', seconds(duration)] : [])];
  const command = (inputs: Blob | Blob[], args: string[], out: string, mime: string, span = duration) =>
    ffmpeg.run(inputs, [...args, out], out, mime, outputOptions(run, span));
  const one = (blob: Blob, extension: string, note?: string): VideoOutput => ({
    files: [{ name: `${base}-${operation}.${extension}`, blob }], note,
  });
  // Converting to the container the file already uses, with nothing else to
  // change, re-encoded the video and made it larger (1.29 MB to 2.02 MB in
  // the review). Copy the streams instead; quality cannot improve anyway.
  const sourceExt = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (operation === 'video-converter' && !options.copy && sourceExt === options.format && !options.resolution &&
    !options.rotation && !options.flipX && !options.flipY && !options.overlay) {
    options = { ...options, copy: true };
  }
  if (operation === 'extract-audio') {
    const { audioFormat, track } = options;
    const spec = AUDIO_FORMATS[audioFormat];
    const codec = probe.audioStreams?.[track]?.codec ?? (track === 0 ? probe.audioCodec : null);
    if (!codec) throw new Error('Choose an available audio track.');
    const fast = await browserAudioExport(file, probe, options, run);
    if (fast) return one(fast, audioFormat, options.copy ? 'AAC copied from source.' : 'Audio exported.');
    const copy = options.copy && codec === 'aac' && (audioFormat === 'aac' || audioFormat === 'm4a');
    const lossy = ['aac', 'm4a', 'mp3', 'ogg'].includes(audioFormat);
    const args = copy ? ['-c:a', 'copy'] : lossy && options.bitrate
      ? ['-c:a', spec.args[1], '-b:a', options.bitrate + 'k'] : [...spec.args];
    return one(await command(file, ['-i', src, '-map', `0:a:${track}`, '-vn', ...args], 'audio.' + audioFormat, spec.mime),
      audioFormat, copy ? 'AAC copied from source.' : 'Audio exported.');
  }
  if (operation === 'extract-frames') {
    const requested = Math.ceil(duration / options.interval - 1e-7);
    const number = Math.min(300, Math.max(1, requested));
    const format = options.frameFormat;
    const { extractVideoFrames } = await import('./media-frames');
    const fast = await extractVideoFrames(file, {
      start,
      end,
      interval: options.interval,
      limit: 300,
      format,
      quality: 0.9,
    }, run.signal, (ratio) => run.onProgress?.({ ratio, time: start + ratio * duration })).catch((error) => {
      if (run.signal?.aborted) run.signal.throwIfAborted();
      console.warn('Browser frame extraction unavailable; using FFmpeg.', error);
      return null;
    });
    if (fast) {
      return {
        files: fast.map((blob, i) => ({ name: `${base}-${String(i + 1).padStart(3, '0')}.${format}`, blob })),
        note: fast.length + ' frames · ' + timeLabel(start) + ' + ' + options.interval + ' s intervals' +
          (fast.length < requested ? ' · Use a shorter range or a longer interval to export the remainder.' : ''),
      };
    }
    const chunkSize = Math.max(1, Math.min(40, Math.floor(64_000_000 / (probe.width * probe.height * 4))));
    const frames: Blob[] = [];
    let bytes = 0;
    for (let offset = 0; offset < number; offset += chunkSize) {
      run.signal?.throwIfAborted();
      const count = Math.min(chunkSize, number - offset);
      const chunkStart = start + offset * options.interval;
      const span = Math.min(end - chunkStart, count * options.interval);
      const blob = await ffmpeg.run(file, ['-ss', seconds(chunkStart), '-t', seconds(Math.max(span, 0.001)), '-i', src,
        '-map', '0:v:0', '-an', '-vf', `fps=1/${seconds(options.interval)}:start_time=0`, '-frames:v', String(count),
        '-c:v', format === 'png' ? 'png' : 'mjpeg', ...(format === 'jpg' ? ['-q:v', '3'] : []), '-f', 'image2pipe', 'frames.bin'],
      'frames.bin', 'application/octet-stream', { ...run, duration: span,
        onProgress: (progress) => run.onProgress?.({ ...progress, ratio: (offset + count * (progress.ratio ?? 0)) / number }) });
      frames.push(...splitImageStream(new Uint8Array(await blob.arrayBuffer()), format));
      bytes += blob.size;
      if (bytes >= 300_000_000) break;
    }
    return { files: frames.map((frame, i) => ({ name: `${base}-${String(i + 1).padStart(3, '0')}.${format}`, blob: frame })),
      note: frames.length + ' frames · ' + timeLabel(start) + ' + ' + options.interval + ' s intervals' +
        (frames.length < requested ? ' · Use a shorter range or a longer interval to export the remainder.' : '') };
  }
  if (operation === 'video-to-gif') {
    const filters = [`fps=${options.fps || 15}`, ...transformFilter(probe, options)];
    const graph = `[0:v]${filters.join(',')},split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a[v]`;
    return one(await command(file, [...seek, '-i', src, '-filter_complex', graph, '-map', '[v]', '-an', '-loop', String(options.loop)],
      'clip.gif', 'image/gif'), 'gif');
  }
  if (operation === 'reverse-video') return one(await reverseVideo(ffmpeg, file, probe, options, run), 'mp4');
  const format = operation === 'video-converter' || operation === 'video-trimmer' ? options.format : 'mp4';
  const mime = VIDEO_FORMATS[format].mime;
  const out = 'video.' + format;
  if (operation === 'video-compressor' && options.targetMB && !options.resolution && full &&
    /\.mp4$/i.test(file.name) && file.size <= options.targetMB * 1_000_000) {
    const header = new Uint8Array(await file.slice(4, 8).arrayBuffer());
    if (String.fromCharCode(...header) === 'ftyp') {
      return one(new Blob([file], { type: mime }), 'mp4', 'Source already fits the size target. No re-encoding needed.');
    }
  }
  const fastExport = await browserVideoExport(file, probe, operation, options, run, base);
  if (fastExport) return fastExport;
  if ((operation === 'video-converter' || operation === 'video-trimmer') && options.copy && !options.resolution) {
    try {
      return one(await command(file, [...seek, '-i', src, '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy',
        '-avoid_negative_ts', 'make_zero', ...formatArgs(format)], out, mime), format, 'Stream copy. Fast cuts can align to a nearby keyframe.');
    } catch (error) {
      run.signal?.throwIfAborted();
      if (operation === 'video-trimmer') throw new Error('Fast copy is incompatible with this output. Choose Exact trim.');
      console.debug('Quick conversion will re-encode:', error);
    }
  }
  const angle = options.rotation;
  if (operation === 'rotate-video' && options.copy && (angle === 90 || angle === 180 || angle === 270) &&
    !options.flipX && !options.flipY && /\.(mp4|m4v|mov)$/i.test(file.name) && (format === 'mp4' || format === 'mov' || format === 'm4v')) {
    // Rewrite only the display matrix; the packets are copied unchanged.
    try {
      const { rotateByMetadata } = await import('./video-rotate');
      const rotated = await rotateByMetadata(file, angle, format === 'mov' ? 'mov' : 'mp4', run.signal,
        (ratio) => run.onProgress?.({ ratio, time: ratio * duration }));
      if (rotated) return one(new Blob([rotated], { type: mime }), format, 'Rotation metadata updated.');
    } catch (error) {
      run.signal?.throwIfAborted();
      console.warn('Rotation by remux unavailable; using FFmpeg.', error);
    }
  }
  if (operation === 'rotate-video' && options.copy && angle && !options.flipX && !options.flipY && /\.mp4$/i.test(file.name)) {
    // Depending on the compiled FFmpeg version, assigning rotation metadata
    // to stream copy is handled through the MOV muxer's rotate tag.
    try {
      const rotation = (((probe.rotation ?? 0) - angle) % 360 + 360) % 360;
      const result = await command(file, ['-i', src, '-map', '0:v:0', '-map', '0:a?', '-c', 'copy', '-metadata:s:v:0', `rotate=${rotation}`], out, mime);
      const metadata = await ffmpeg.probe(result, run.signal);
      if ((((metadata.rotation ?? 0) % 360) + 360) % 360 === rotation) return one(result, format, 'Rotation metadata updated.');
    } catch {
      run.signal?.throwIfAborted();
    }
  }
  const filters: string[] = [];
  if (operation === 'rotate-video') {
    if (angle === 90) filters.push('transpose=clock');
    if (angle === 270) filters.push('transpose=cclock');
    if (angle === 180) filters.push('hflip', 'vflip');
    if (options.flipX) filters.push('hflip');
    if (options.flipY) filters.push('vflip');
  }
  filters.push(...transformFilter(probe, options, operation === 'rotate-video' && (angle === 90 || angle === 270)));
  if (operation === 'change-speed') filters.push(`setpts=(PTS-STARTPTS)/${seconds(options.speed)}`);
  if (options.fps && operation === 'change-speed') filters.push(`fps=${options.fps}`);
  filters.push('pad=ceil(iw/2)*2:ceil(ih/2)*2');
  const inputs: Blob[] = [file];
  const args = [...seek, '-i', src];
  if (operation === 'video-watermark') {
    if (!options.overlay) throw new Error('Enter watermark text or choose a logo.');
    inputs.push(options.overlay);
    args.push('-i', audioInputName(1), '-filter_complex', `[0:v]${filters.join(',')}[source];[source][1:v]overlay=0:0:format=auto[v]`, '-map', '[v]');
  } else {
    args.push('-map', '0:v:0', '-vf', filters.join(','));
  }
  if (options.audio === 'mute') args.push('-an');
  else {
    args.push('-map', '0:a:0?');
    if (probe.hasAudio && operation === 'change-speed') args.push('-af', ['asetpts=PTS-STARTPTS', ...tempoFilters(options.speed)].join(','));
  }
  const target = operation === 'video-compressor' ? targetBitrate(options.targetMB, duration, probe.hasAudio && options.audio !== 'mute') : undefined;
  args.push(...videoCodec(format, options.quality, target), '-pix_fmt', 'yuv420p', ...formatArgs(format));
  if (format === 'mp4' || format === 'mov' || format === 'm4v') args.push('-movflags', '+faststart');
  let blob = await command(inputs, args, out, mime, operation === 'change-speed' ? duration / options.speed : duration);
  if (target && blob.size > options.targetMB * 1_000_000 && target > 48_000) {
    const retryRate = Math.max(48_000, Math.floor(target * options.targetMB * 940_000 / blob.size));
    // Retry with the measured output-to-target ratio using the same dimensions.
    const retryArgs = [...args];
    for (const [option, value] of [['-b:v', retryRate], ['-maxrate', retryRate], ['-bufsize', retryRate * 2]] as const) {
      retryArgs[retryArgs.indexOf(option) + 1] = String(value);
    }
    const retry = await command(inputs, retryArgs, out, mime);
    if (retry.size < blob.size) blob = retry;
  }
  const note = target && blob.size > options.targetMB * 1_000_000
    ? 'Export exceeded the size target. Lower the resolution or shorten the clip.' : 'Re-encoded for the selected settings.';
  return one(blob, format, note);
}
