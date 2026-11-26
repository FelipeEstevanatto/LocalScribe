import type { AudioFfmpeg, SubtitleStreamInfo } from './audio-ffmpeg';
import { parseCaptions, type Cue } from './captions';
import { readAssCues, type AssCue } from './ass-subtitles';
import { clipPlaybackTime, type MergeVideo } from './video-merge-args';

export interface EmbeddedCaptions {
  stream: SubtitleStreamInfo;
  cues: AssCue[];
  assScript?: string;
}

export interface EmbeddedTimelineCue extends Cue {
  embeddedClipId?: number;
  embeddedCueIndex: number;
  assStyled?: boolean;
}

export function mapEmbeddedCaptions(
  clip: MergeVideo & { id?: number; embeddedCaptions?: EmbeddedCaptions },
): EmbeddedTimelineCue[] {
  if (!clip.embeddedCaptions || clip.image) return [];
  const from = clip.trimStart ?? 0;
  const to = clip.duration - (clip.trimEnd ?? 0);
  const offset = clip.start ?? 0;
  return clip.embeddedCaptions.cues.flatMap((cue, index) => {
    const start = Math.max(from, cue.start);
    const end = Math.min(to, cue.end);
    return end > start ? [{
      ...cue,
      start: offset + clipPlaybackTime(clip, start),
      end: offset + clipPlaybackTime(clip, end),
      embeddedClipId: clip.id,
      embeddedCueIndex: index,
      ...(clip.embeddedCaptions?.assScript ? { assStyled: true } : {}),
    }] : [];
  });
}

export function isTextSubtitle(stream: SubtitleStreamInfo): boolean {
  return ['subrip', 'srt', 'webvtt', 'ass', 'ssa', 'mov_text', 'text'].includes(stream.codec);
}

export function supportsOriginalSubtitleStyle(stream: SubtitleStreamInfo): boolean {
  return stream.codec === 'ass' || stream.codec === 'ssa';
}

export async function readEmbeddedCaptions(
  ffmpeg: AudioFfmpeg, file: File, stream: SubtitleStreamInfo, signal: AbortSignal, preserveStyle = false,
): Promise<EmbeddedCaptions> {
  if (!isTextSubtitle(stream)) throw new Error('This subtitle stream contains images or uses an unsupported text format.');
  if (preserveStyle && supportsOriginalSubtitleStyle(stream)) {
    const blob = await ffmpeg.run(file, [
      '-copyts', '-start_at_zero', '-i', 'input.media', '-map', '0:s:' + stream.index,
      '-c:s', stream.codec === 'ass' ? 'copy' : 'ass', 'captions.ass',
    ], 'captions.ass', 'text/x-ass', signal);
    const assScript = await blob.text();
    if (!/^Dialogue:/mi.test(assScript)) throw new Error('This subtitle stream has no readable ASS events.');
    return { stream, cues: readAssCues(assScript), assScript };
  }
  const blob = await ffmpeg.run(file, [
    '-copyts', '-start_at_zero', '-i', 'input.media', '-map', '0:s:' + stream.index,
    '-c:s', 'webvtt', 'captions.vtt',
  ], 'captions.vtt', 'text/vtt', signal);
  const cues = parseCaptions(await blob.text());
  if (!cues.length) throw new Error('This subtitle stream has no readable cues.');
  return { stream, cues };
}

export async function prepareSourceAudio(
  ffmpeg: AudioFfmpeg, file: File, index: number, signal: AbortSignal,
): Promise<File> {
  const { remuxAudioTrack } = await import('./mediabunny-engine');
  let copied = await remuxAudioTrack(file, index, 'm4a', signal, true).catch(() => null);
  signal.throwIfAborted();
  if (!copied && typeof Audio !== 'undefined' && new Audio().canPlayType('audio/webm; codecs="opus"')) {
    copied = await remuxAudioTrack(file, index, 'webm', signal, true).catch(() => null);
  }
  signal.throwIfAborted();
  const blob = copied ?? await ffmpeg.run(file, [
    '-copyts', '-start_at_zero', '-i', 'input.media', '-map', '0:a:' + index,
    '-vn', '-af', 'aresample=async=1:first_pts=0',
    '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', 'track.m4a',
  ], 'track.m4a', 'audio/mp4', signal);
  const extension = blob.type === 'audio/webm' ? 'webm' : 'm4a';
  return new File([blob], `${file.name}.stream-${index}.${extension}`, { type: blob.type, lastModified: file.lastModified });
}
