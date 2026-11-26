import { AUDIO_FORMATS, type AudioStreamInfo } from './audio-ffmpeg';
import type { AudioSettings, VideoSettings } from './converter-catalog';

const videoProfiles: Record<string, { muxer: string; video: string; audio: string; codecs?: string[]; audioCodecs?: string[] }> = {
  mp4: { muxer: 'mp4', video: 'libx264', audio: 'aac', codecs: ['mpeg4'], audioCodecs: ['libmp3lame'] },
  mov: { muxer: 'mov', video: 'libx264', audio: 'aac', codecs: ['mpeg4'], audioCodecs: ['libmp3lame'] },
  m4v: { muxer: 'mp4', video: 'libx264', audio: 'aac', codecs: ['mpeg4'], audioCodecs: ['libmp3lame'] },
  mkv: { muxer: 'matroska', video: 'libx264', audio: 'aac', codecs: ['mpeg4', 'libvpx'], audioCodecs: ['opus', 'libmp3lame'] },
  webm: { muxer: 'webm', video: 'libvpx', audio: 'opus' },
  avi: { muxer: 'avi', video: 'mpeg4', audio: 'libmp3lame' },
  wmv: { muxer: 'asf', video: 'wmv2', audio: 'wmav2' },
  flv: { muxer: 'flv', video: 'flv', audio: 'aac', codecs: ['libx264'], audioCodecs: ['libmp3lame'] },
  '3gp': { muxer: '3gp', video: 'libx264', audio: 'aac', codecs: ['mpeg4'] },
  mpg: { muxer: 'mpeg', video: 'mpeg1video', audio: 'mp2' },
  mpeg: { muxer: 'mpeg', video: 'mpeg1video', audio: 'mp2' },
  ogv: { muxer: 'ogg', video: 'libtheora', audio: 'libvorbis' },
  ts: { muxer: 'mpegts', video: 'libx264', audio: 'aac', audioCodecs: ['libmp3lame'] },
};

export function videoOptions(target: string): { codecs: VideoSettings['codec'][]; audio: VideoSettings['audioStream'][] } {
  const profile = videoProfiles[target];
  if (!profile) return { codecs: ['auto'], audio: ['mute'] };
  const codecs = ['auto', 'copy', profile.video, ...(profile.codecs ?? [])];
  const audio = ['keep', 'mute'];
  for (const option of ['aac', 'mp3', 'opus'] as const) {
    const encoder = option === 'mp3' ? 'libmp3lame' : option;
    if (encoder === profile.audio || profile.audioCodecs?.includes(encoder)) audio.push(option);
  }
  return { codecs: codecs as VideoSettings['codec'][], audio: audio as VideoSettings['audioStream'][] };
}

function opus(bitrate: string, channels = '2'): string[] {
  return ['-c:a', 'opus', '-strict', 'experimental', '-ar', '48000', '-ac', channels, '-b:a', bitrate];
}

export function audioArgs(target: string, settings: AudioSettings, output: string, source?: AudioStreamInfo): string[] {
  const args = ['-threads', '1', '-i', 'input.media', '-threads', '1', '-filter_threads', '1', '-map', '0:a:0', '-vn'];
  if (!['opus', 'weba'].includes(target)) {
    if (settings.channels !== 'source') args.push('-ac', settings.channels === 'mono' ? '1' : '2');
    if (settings.sampleRate !== 'source') args.push('-ar', settings.sampleRate);
  }
  if (Math.abs(settings.volume - 1) > 0.01) args.push('-af', `volume=${settings.volume.toFixed(2)}`);
  const stereoOnly = settings.channels === 'mono' || (settings.channels === 'source' && source?.channels === 'mono') ? '1' : '2';
  const bitrate = settings.bitrate;

  switch (target) {
    case 'mp3':
      args.push('-c:a', 'libmp3lame', '-ac', stereoOnly, '-b:a', bitrate);
      break;
    case 'aac':
    case 'm4a':
      args.push('-c:a', 'aac', '-b:a', bitrate);
      if (target === 'm4a') args.push('-f', 'ipod', '-movflags', '+faststart');
      break;
    case 'ogg':
      args.push('-c:a', 'libvorbis', '-q:a', String(Math.round(parseInt(bitrate, 10) / 32)));
      break;
    case 'opus':
    case 'weba':
      args.push(...opus(bitrate, stereoOnly), '-f', target === 'opus' ? 'opus' : 'webm');
      break;
    case 'wma':
      args.push('-c:a', 'wmav2', '-ar', '44100', '-ac', stereoOnly, '-f', 'asf', '-b:a', bitrate);
      break;
    case 'ac3':
      args.push('-c:a', 'ac3', '-ar', settings.sampleRate === '44100' ? '44100' : '48000', '-b:a', bitrate);
      break;
    case 'amr':
      args.push('-c:a', 'pcm_s16le', '-ar', '8000', '-ac', '1', '-f', 's16le');
      break;
    case 'wav':
    case 'flac':
    case 'aiff':
    case 'caf':
      args.push(...AUDIO_FORMATS[target].args);
      break;
    default:
      throw new Error('Unsupported audio output format.');
  }
  return [...args, output];
}

export function videoArgs(target: string, settings: VideoSettings, output: string, sourceFps = 25): string[] {
  const args = ['-threads', '1', '-i', 'input.media', '-threads', '1', '-filter_threads', '1', '-filter_complex_threads', '1', '-map', '0:V:0'];
  if (target === 'gifv') {
    return [...args, '-an', '-vf', "fps=15,scale='min(480,iw)':-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse", '-loop', '0', '-f', 'gif', output];
  }

  const profile = videoProfiles[target];
  if (!profile) throw new Error('Unsupported video output format.');
  const options = videoOptions(target);
  const selectedCodec = options.codecs.includes(settings.codec) ? settings.codec : 'auto';
  const codec = selectedCodec === 'auto' ? profile.video : selectedCodec;
  if (codec === 'copy') {
    if (settings.resolution !== 'source' || settings.fps !== 'source') {
      throw new Error('Stream copy requires the original resolution and frame rate. Choose Auto to resize or change frame rate.');
    }
    args.push('-c:v', 'copy');
  } else {
    const filters: string[] = [];
    if (settings.resolution === 'custom' && settings.customWidth && settings.customHeight) {
      filters.push(`scale=${settings.customWidth}:${settings.customHeight}`);
    } else if (settings.resolution !== 'source' && settings.resolution !== 'custom') {
      filters.push(`scale=-2:${parseInt(settings.resolution, 10)}`);
    }
    filters.push('pad=ceil(iw/2)*2:ceil(ih/2)*2');
    args.push('-vf', filters.join(','), '-pix_fmt', 'yuv420p', '-c:v', codec);
    if (codec === 'libx264') args.push('-preset', 'veryfast', '-crf', String(settings.crf));
    else if (codec === 'libvpx') {
      args.push('-deadline', 'good', '-cpu-used', '5', '-crf', String(settings.crf), '-b:v', '2M');
    } else {
      args.push('-q:v', String(Math.round(2 + (settings.crf - 15) / 3)));
    }
    if (profile.muxer === 'mpeg') {
      const fps = settings.fps === 'source' ? sourceFps || 25 : Number(settings.fps);
      const rates = [24, 25, 30, 50, 60];
      const nearest = rates.reduce((best, value) => Math.abs(value - fps) < Math.abs(best - fps) ? value : best);
      args.push('-r', String(nearest));
    } else if (settings.fps !== 'source') args.push('-r', settings.fps);
  }

  if (settings.audioStream === 'mute') {
    args.push('-an');
  } else {
    args.push('-map', '0:a:0?');
    const selectedAudio = options.audio.includes(settings.audioStream) ? settings.audioStream : 'keep';
    const audio = selectedAudio === 'keep' ? profile.audio : selectedAudio === 'mp3' ? 'libmp3lame' : selectedAudio;
    if (audio === 'opus') args.push(...opus(settings.audioBitrate));
    else if (audio === 'libvorbis') args.push('-c:a', audio, '-q:a', '5');
    else {
      args.push('-c:a', audio, '-b:a', settings.audioBitrate);
      if (['libmp3lame', 'wmav2', 'mp2'].includes(audio)) args.push('-ac', '2');
      if (audio === 'mp2') args.push('-ar', '44100');
      if (profile.muxer === 'flv' && audio === 'libmp3lame') args.push('-ar', '44100');
    }
  }
  if (['mp4', 'mov', '3gp'].includes(profile.muxer)) args.push('-movflags', '+faststart');
  return [...args, '-f', profile.muxer, output];
}
