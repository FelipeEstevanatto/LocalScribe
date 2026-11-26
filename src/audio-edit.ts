import { audioInputName, type AudioFfmpeg, type FfmpegProgress } from './audio-ffmpeg';
import { canRenderFast, renderFastEdit } from './audio-dsp';
import { createAudioAnalyzer } from './audio';

export interface EditorAudio {
  duration: number;
  sampleRate: number;
  channels: number;
  channelMask: number;
  dataOffset: number;
  peak: number;
  rms: number;
  silenceRatio: number;
  activityRegions: number;
  longestSilence: number;
  peaks: Float32Array;
}

export interface AudioEdit {
  start: number;
  end: number;
  cut: 'none' | 'keep' | 'remove';
  gain: number;
  loudness: number | null;
  ceiling: number | null;
  effect: string;
  pitch?: number;
  tempo?: number;
  bass?: number;
  treble?: number;
  /** Fade lengths in seconds; override the fade presets in `effect`. */
  fadeIn?: number;
  fadeOut?: number;
  /** Extra processing switched on alongside `effect`. */
  effects?: string[];
  /** Noise reduction strength in dB (afftdn), 0 to disable. */
  denoise?: number;
}

export interface JobOptions {
  signal: AbortSignal;
  onProgress?: (progress: FfmpegProgress) => void;
}

export interface JoinClip {
  blob: Blob;
  duration: number;
  /** Seconds trimmed from the start and the end of the clip. */
  trimStart?: number;
  trimEnd?: number;
}

const WAV_OUTPUT = ['-vn', '-c:a', 'pcm_f32le', 'output.wav'];

export function prepareEditorAudio(ffmpeg: AudioFfmpeg, file: Blob, job: AbortSignal | JobOptions, additional: string[] = [], duration?: number): Promise<Blob> {
  const { signal, onProgress } = job instanceof AbortSignal ? { signal: job, onProgress: undefined } : job;
  return ffmpeg.run(file, ['-i', 'input.media', '-map', '0:a:0', ...additional, ...WAV_OUTPUT], 'output.wav', 'audio/wav', { signal, onProgress, duration });
}

/** Filter graph that trims, normalizes, and joins clips, optionally crossfading. */
export function joinGraph(clips: readonly JoinClip[], crossfade = 0): { graph: string; duration: number } {
  if (clips.length < 2) throw new Error('Add at least two clips to join.');
  const lengths = clips.map(({ duration, trimStart = 0, trimEnd = 0 }) => duration - trimStart - trimEnd);
  if (lengths.some((length) => !(length > 0.05))) throw new Error('A trimmed clip would be empty. Reduce its trim.');
  const fade = Math.max(0, Math.min(crossfade, ...lengths.map((length) => length / 2)));
  const time = (value: number) => value.toFixed(6);
  const parts = clips.map(({ duration, trimStart = 0, trimEnd = 0 }, i) => {
    const trim = trimStart > 0 || trimEnd > 0 ? `atrim=start=${time(trimStart)}:end=${time(duration - trimEnd)},` : '';
    return `[${i}:a:0]${trim}asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`;
  });
  let tail = '';
  if (fade > 0.01) {
    let previous = 'a0';
    for (let i = 1; i < clips.length; i += 1) {
      const label = i === clips.length - 1 ? 'out' : `x${i}`;
      parts.push(`[${previous}][a${i}]acrossfade=d=${time(fade)}:c1=tri:c2=tri[${label}]`);
      previous = label;
    }
  } else {
    tail = `;${clips.map((_, i) => `[a${i}]`).join('')}concat=n=${clips.length}:v=0:a=1[out]`;
  }
  const total = lengths.reduce((sum, length) => sum + length, 0) - (fade > 0.01 ? fade * (clips.length - 1) : 0);
  return { graph: parts.join(';') + tail, duration: total };
}

export function joinAudio(ffmpeg: AudioFfmpeg, clips: readonly JoinClip[], crossfade: number, job: JobOptions): Promise<Blob> {
  const { graph, duration } = joinGraph(clips, crossfade);
  const inputs = clips.flatMap((_, i) => ['-i', audioInputName(i)]);
  return ffmpeg.run(clips.map(({ blob }) => blob), [...inputs, '-filter_complex', graph, '-map', '[out]', ...WAV_OUTPUT], 'output.wav', 'audio/wav', { ...job, duration });
}

export function mixKaraoke(ffmpeg: AudioFfmpeg, backing: Blob, voice: Blob, settings: {
  offset: number; backingGain: number; voiceGain: number; voicePitch: number;
}, job: JobOptions, duration?: number): Promise<Blob> {
  const { offset, backingGain, voiceGain, voicePitch } = settings;
  const voiceOffset = offset >= 0 ? `adelay=${Math.round(offset * 1000)}:all=1` : `atrim=start=${-offset},asetpts=PTS-STARTPTS`;
  const voiceFilters = ['aresample=48000:ochl=stereo', ...pitchTempoFilters(48000, voicePitch, 1), voiceOffset, `volume=${voiceGain}dB`];
  const graph = [
    `[0:a:0]aresample=48000:ochl=stereo,volume=${backingGain}dB[backing]`,
    `[1:a:0]${voiceFilters.join(',')}[voice]`,
    `[backing][voice]${mixFilter(2)}[out]`,
  ].join(';');
  return ffmpeg.run([backing, voice], ['-i', audioInputName(0), '-i', audioInputName(1), '-filter_complex', graph, '-map', '[out]', ...WAV_OUTPUT], 'output.wav', 'audio/wav', { ...job, duration });
}

function mixFilter(count: number): string {
  return `amix=inputs=${count}:duration=longest:normalize=0,alimiter=limit=0.89:level=false:latency=true`;
}

/** Mix stems with linear gains (0 mutes a stem, 1 is unity). */
export function stemMixGraph(gains: readonly number[]): string {
  const levels = gains.map((gain, i) => `[${i}:a:0]volume=${gain.toFixed(4)}[stem${i}]`);
  if (gains.length === 1) return `[0:a:0]volume=${gains[0].toFixed(4)},alimiter=limit=0.89:level=false:latency=true[out]`;
  return `${levels.join(';')};${gains.map((_, i) => `[stem${i}]`).join('')}${mixFilter(gains.length)}[out]`;
}

export function mixStems(ffmpeg: AudioFfmpeg, stems: { blob: Blob; gain: number }[], job: JobOptions, duration?: number): Promise<Blob> {
  const audible = stems.filter(({ gain }) => gain > 0);
  if (!audible.length) throw new Error('Every stem is muted. Turn at least one up.');
  const inputs = audible.flatMap((_, i) => ['-i', audioInputName(i)]);
  const graph = stemMixGraph(audible.map(({ gain }) => gain));
  return ffmpeg.run(audible.map(({ blob }) => blob), [...inputs, '-filter_complex', graph, '-map', '[out]', ...WAV_OUTPUT], 'output.wav', 'audio/wav', { ...job, duration });
}

export function pitchTempoFilters(sampleRate: number, pitch: number, tempo: number): string[] {
  const filters: string[] = [];
  const shiftedRate = Math.round(sampleRate * 2 ** (pitch / 12));
  if (shiftedRate !== sampleRate) filters.push(`asetrate=${shiftedRate}`, `aresample=${sampleRate}`);
  let stretch = tempo * sampleRate / shiftedRate;
  while (stretch < 0.5) { filters.push('atempo=0.5'); stretch *= 2; }
  while (stretch > 2) { filters.push('atempo=2'); stretch /= 2; }
  if (Math.abs(stretch - 1) > 0.00001) filters.push(`atempo=${stretch.toFixed(8)}`);
  return filters;
}

/** Read the float32 WAV produced by the local FFmpeg worker in bounded blocks. */
export async function inspectEditorAudio(blob: Blob, signal: AbortSignal): Promise<EditorAudio> {
  const header = new DataView(await blob.slice(0, 12).arrayBuffer());
  if (header.byteLength !== 12 || header.getUint32(0) !== 0x52494646 || header.getUint32(8) !== 0x57415645) {
    throw new Error('FFmpeg did not return a readable WAV file.');
  }
  let channels = 0;
  let channelMask = 0;
  let sampleRate = 0;
  let start = 0;
  let size = 0;
  for (let offset = 12; offset + 8 <= blob.size;) {
    signal.throwIfAborted();
    const chunk = new DataView(await blob.slice(offset, offset + 8).arrayBuffer());
    const type = chunk.getUint32(0);
    const length = chunk.getUint32(4, true);
    const data = offset + 8;
    if (data + length > blob.size) break;
    if (type === 0x666d7420 && length >= 16) {
      const format = new DataView(await blob.slice(data, data + Math.min(length, 24)).arrayBuffer());
      const codec = format.getUint16(0, true);
      if ((codec !== 3 && codec !== 0xfffe) || format.getUint16(14, true) !== 32) break;
      channels = format.getUint16(2, true);
      sampleRate = format.getUint32(4, true);
      if (codec === 0xfffe && length >= 24) channelMask = format.getUint32(20, true);
    } else if (type === 0x64617461) {
      start = data;
      size = length;
      break;
    }
    offset = data + length + (length % 2);
  }
  const frameBytes = channels * 4;
  const frames = Math.floor(size / frameBytes);
  if (!channels || !sampleRate || !frames) throw new Error('This file contains no playable audio.');

  const peaks = new Float32Array(Math.min(65536, frames));
  const analyzer = createAudioAnalyzer(sampleRate);
  let peak = 0;
  let squares = 0;
  for (let frame = 0; frame < frames; frame += 16384) {
    signal.throwIfAborted();
    const count = Math.min(16384, frames - frame);
    const view = new DataView(await blob.slice(start + frame * frameBytes, start + (frame + count) * frameBytes).arrayBuffer());
    const levels = new Float32Array(count);
    for (let local = 0; local < count; local += 1) {
      const bucket = Math.floor((frame + local) * peaks.length / frames);
      let energy = 0;
      for (let channel = 0; channel < channels; channel += 1) {
        const magnitude = Math.abs(view.getFloat32((local * channels + channel) * 4, true));
        if (!Number.isFinite(magnitude)) continue;
        peaks[bucket] = Math.max(peaks[bucket], magnitude);
        peak = Math.max(peak, magnitude);
        energy += magnitude * magnitude;
      }
      levels[local] = Math.sqrt(energy / channels);
      squares += energy;
    }
    analyzer.add(levels);
  }
  const { silenceRatio, speechSegments, longestSilence } = analyzer.finish();
  return {
    duration: frames / sampleRate, sampleRate, channels, channelMask, dataOffset: start,
    peak, rms: Math.sqrt(squares / (frames * channels)),
    silenceRatio, activityRegions: speechSegments, longestSilence, peaks,
  };
}

export function audioEditArgs(edit: AudioEdit, audio: EditorAudio): string[] {
  const { duration, sampleRate } = audio;
  const { cut, start, end, gain, loudness, ceiling, effect, pitch = 0, tempo = 1, bass = 0, treble = 0, effects = [], denoise = 0 } = edit;
  if (!Number.isFinite(pitch) || Math.abs(pitch) > 12 || !Number.isFinite(tempo) || tempo < 0.5 || tempo > 2) {
    throw new Error('Use −12 to +12 semitones and a tempo from 0.5× to 2×.');
  }
  if (!Number.isFinite(bass) || !Number.isFinite(treble) || Math.max(Math.abs(bass), Math.abs(treble)) > 12) {
    throw new Error('Use bass and treble gains from −12 to +12 dB.');
  }
  if (!Number.isFinite(gain) || gain < -60 || gain > 30) throw new Error('Gain must be between −60 and +30 dB.');
  if (loudness !== null && (!Number.isFinite(loudness) || loudness < -70 || loudness > -5)) {
    throw new Error('Choose a loudness target from −70 to −5 LUFS.');
  }
  if (ceiling !== null && (!Number.isFinite(ceiling) || ceiling < -24 || ceiling > 0)) {
    throw new Error('Choose a peak ceiling from −24 to 0 dBFS.');
  }
  if (cut !== 'none' && (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > duration || end - start < 1 / sampleRate)) {
    throw new Error('Select a valid time range before cutting.');
  }

  const time = (value: number) => value.toFixed(9);
  const filters: string[] = [];
  const retained = cut === 'keep' ? end - start : cut === 'remove' ? duration - (end - start) : duration;
  if (retained < 1 / sampleRate) throw new Error('The edit would remove the entire recording.');
  const resultDuration = retained / tempo;
  const on = (name: string) => effect === name || effects.includes(name);
  if (denoise > 0) filters.push(`afftdn=nr=${Math.min(40, denoise).toFixed(1)}`);
  else if (on('denoise')) filters.push('afftdn=nr=12');
  if (on('rumble')) filters.push('highpass=f=80');
  if (on('voice')) filters.push('highpass=f=120', 'lowpass=f=3500');
  if (on('reverb')) filters.push('aecho=0.8:0.86:45|95|165:0.26|0.16|0.08');
  if (on('reverse')) filters.push('areverse');
  if (on('mono')) filters.push('pan=mono|c0=0.5*c0+0.5*c1', `aresample=${sampleRate}:ochl=stereo`);
  if (bass) filters.push(`bass=g=${bass}`);
  if (treble) filters.push(`treble=g=${treble}`);
  if (gain) filters.push(`volume=${gain}dB`);
  if (pitch || tempo !== 1) filters.push(...pitchTempoFilters(sampleRate, pitch, tempo));
  if (loudness !== null) {
    const layout = audio.channelMask ? `0x${audio.channelMask.toString(16)}` : `${audio.channels}c`;
    filters.push(`loudnorm=I=${loudness}:TP=-1.5:LRA=11`, `aresample=${sampleRate}:ochl=${layout}`);
  }
  const preset = Math.min(1, resultDuration / 2);
  const fadeIn = Math.min(resultDuration, edit.fadeIn ?? (effect === 'fade-in' || effect === 'fades' ? preset : 0));
  const fadeOut = Math.min(resultDuration, edit.fadeOut ?? (effect === 'fade-out' || effect === 'fades' ? preset : 0));
  if (fadeIn > 0) filters.push(`afade=t=in:d=${time(fadeIn)}`);
  if (fadeOut > 0) filters.push(`afade=t=out:st=${time(resultDuration - fadeOut)}:d=${time(fadeOut)}`);
  if (ceiling !== null) filters.push(`alimiter=limit=${(10 ** (ceiling / 20)).toFixed(8)}:level=false:latency=true`);

  const input = ['-i', 'input.media'];
  if (cut === 'remove' && start > 0 && end < duration) {
    const splice = `[0:a:0]asplit=2[a][b];[a]atrim=end=${time(start)},asetpts=PTS-STARTPTS[left];[b]atrim=start=${time(end)},asetpts=PTS-STARTPTS[right];[left][right]concat=n=2:v=0:a=1`;
    return [...input, '-filter_complex', `${splice}${filters.length ? ',' + filters.join(',') : ''}[edited]`, '-map', '[edited]', ...WAV_OUTPUT];
  }
  if (cut !== 'none') {
    const from = cut === 'keep' ? start : start === 0 ? end : 0;
    const to = cut === 'keep' ? end : start === 0 ? duration : start;
    filters.unshift(`atrim=start=${time(from)}:end=${time(to)}`, 'asetpts=PTS-STARTPTS');
  }
  return [...input, '-map', '0:a:0', ...(filters.length ? ['-af', filters.join(',')] : []), ...WAV_OUTPUT];
}

/** Output length of an edit, for progress reporting. */
export function editedDuration(edit: AudioEdit, audio: EditorAudio): number {
  const span = Math.max(0, edit.end - edit.start);
  const retained = edit.cut === 'keep' ? span : edit.cut === 'remove' ? audio.duration - span : audio.duration;
  return retained / (edit.tempo || 1);
}

export async function applyAudioEdit(ffmpeg: AudioFfmpeg, source: Blob, edit: AudioEdit, audio: EditorAudio, job: AbortSignal | JobOptions): Promise<Blob> {
  const { signal, onProgress } = job instanceof AbortSignal ? { signal: job, onProgress: undefined } : job;
  // FFmpeg writes pcm_f32le WAV, the same format renderFastEdit reads, so a
  // previously loaded FFmpeg core is not a reason to re-decode a simple edit.
  if (canRenderFast(edit) && source.size <= 200_000_000) {
    lastEditEngine = 'dsp';
    return renderFastEdit(source, edit, { signal, onProgress });
  }
  lastEditEngine = 'ffmpeg';
  return ffmpeg.run(source, audioEditArgs(edit, audio), 'output.wav', 'audio/wav', { signal, onProgress, duration: editedDuration(edit, audio) });
}

let lastEditEngine: 'dsp' | 'ffmpeg' = 'ffmpeg';

/** Diagnostic only: which engine handled the most recent applyAudioEdit call. */
export function getLastEditEngine(): 'dsp' | 'ffmpeg' {
  return lastEditEngine;
}

/** A neutral edit: nothing changes until fields are set. */
export function emptyEdit(duration: number): AudioEdit {
  return { start: 0, end: duration, cut: 'none', gain: 0, loudness: null, ceiling: null, effect: '' };
}
