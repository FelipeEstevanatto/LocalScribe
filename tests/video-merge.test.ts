import { expect, test } from 'bun:test';
import { parseProbe, type MediaProbe } from '../src/audio-ffmpeg';
import { shiftCues } from '../src/captions';
import { isTextSubtitle, mapEmbeddedCaptions } from '../src/video-source-media';
import { linkedSourceVideos, type ExportJob } from '../src/video-export';
import {
  buildAudioMixPlan,
  buildVideoPlan,
  bitrateForSize,
  canCopyVideo,
  canSkipSoundtrackMix,
  clipTransform,
  hasClipTransform,
  isSequentialVideo,
  planFrameRate,
  targetSize,
  totalLength,
  videoSegments,
  videoStarts,
  type MergeAudio,
} from '../src/video-merge-args';

const h264: MediaProbe = { duration: 10, hasVideo: true, hasAudio: true, videoCodec: 'h264', audioCodec: 'aac', width: 1280, height: 720, fps: 30 };
const music: MergeAudio = { duration: 30, offset: 2, trimStart: 5, trimEnd: 10, volume: 0.8, fadeIn: 1, fadeOut: 2 };
const graphOf = (args: string[]) => args[args.indexOf('-filter_complex') + 1];

test('probe output is parsed into duration, codecs, frame size, and every audio track', () => {
  const log = [
    "Input #0, matroska,webm, from 'input.media':",
    '  Duration: 00:01:02.50, start: 0.000000, bitrate: 2000 kb/s',
    '  Stream #0:0: Video: h264 (High), yuv420p(progressive), 1920x1080 [SAR 1:1 DAR 16:9], 29.97 fps, 29.97 tbr',
    '  Stream #0:1(eng): Audio: aac (LC), 48000 Hz, stereo, fltp (default)',
    '    Metadata:',
    '      title           : Main',
    '  Stream #0:2(spa): Audio: ac3, 48000 Hz, 5.1(side), fltp, 384 kb/s',
    '    Metadata:',
    '      title           : Commentary',
  ].join('\n');
  const probe = parseProbe(log);
  expect(probe).toMatchObject({ duration: 62.5, hasVideo: true, hasAudio: true, videoCodec: 'h264', audioCodec: 'aac', width: 1920, height: 1080, fps: 29.97 });
  expect(probe.audioStreams).toEqual([
    { language: 'eng', codec: 'aac', channels: 'stereo', title: 'Main', sampleRate: 48000 },
    { language: 'spa', codec: 'ac3', channels: '5.1(side)', title: 'Commentary', sampleRate: 48000 },
  ]);
});

test('the soundtrack mixes the original sound with added audio at its offset, trim, and fades', () => {
  const plan = buildAudioMixPlan([{ duration: 10, probe: h264 }], [music], { keepOriginal: true, originalVolume: 0.5, format: 'mp4' })!;
  const graph = graphOf(plan.args);
  expect(graph).toContain('[0:a:0]atrim=start=0.000000:end=10.000000');
  expect(graph).toContain('volume=0.5000[orig]');
  expect(graph).toContain('[1:a:0]atrim=start=5.000000:end=20.000000');
  expect(graph).toContain('afade=t=out:st=13.000000:d=2.000000');
  expect(graph).toContain('adelay=2000:all=1');
  expect(graph).toContain('amix=inputs=2');
  expect(plan.args.slice(-3)).toEqual(['-t', '10.000000', 'mix.m4a']);
});

test('ducking sidechains the added audio from the videos own sound', () => {
  const plan = buildAudioMixPlan([{ duration: 10, probe: h264 }], [music], { keepOriginal: true, originalVolume: 1, format: 'mp4', duck: true })!;
  const graph = graphOf(plan.args);
  expect(graph).toContain('[orig]asplit=2[omix][okey]');
  expect(graph).toContain('[bus][okey]sidechaincompress=');
  expect(graph).toContain('[omix][ducked]amix=inputs=2');
});

test('caption-timed ducking uses the cue spans instead of the sidechain', () => {
  const plan = buildAudioMixPlan(
    [{ duration: 10, probe: h264 }],
    [music],
    { keepOriginal: true, originalVolume: 1, format: 'mp4', duck: true, duckCaptions: true },
    [{ start: 1, end: 2 }, { start: 3, end: 4 }],
  )!;
  const graph = graphOf(plan.args);
  expect(graph).toContain("volume=enable='between(t,1.000000,2.000000)':volume=0.35");
  expect(graph).toContain("volume=enable='between(t,3.000000,4.000000)':volume=0.35");
  expect(graph).not.toContain('sidechaincompress');
});

test('track choice, video trims, and silent clips shape the soundtrack', () => {
  const plan = buildAudioMixPlan(
    [{ duration: 10, probe: h264, trimStart: 2, trimEnd: 3, audioTrack: 1 }, { duration: 4, probe: { ...h264, hasAudio: false } }],
    [{ ...music, track: 2 }],
    { keepOriginal: true, originalVolume: 1, format: 'mp4' },
  )!;
  const graph = graphOf(plan.args);
  expect(graph).toContain('[0:a:1]atrim=start=2.000000:end=7.000000');
  expect(graph).toContain('anullsrc=r=48000:cl=stereo,atrim=end=4.000000');
  expect(graph).toContain('concat=n=2:v=0:a=1');
  expect(plan.args).toContain('input-2.media');
  expect(graph).toContain('[1:a:2]atrim');
  expect(plan.duration).toBe(9);
});

test('a silent result has no soundtrack step', () => {
  expect(buildAudioMixPlan([{ duration: 10, probe: { ...h264, hasAudio: false } }], [], { keepOriginal: true, originalVolume: 1, format: 'mp4' })).toBeNull();
});

test('identical clips are copied through the concat demuxer with trims as in/out points', () => {
  const plan = buildVideoPlan(
    [{ duration: 10, probe: h264, trimStart: 1 }, { duration: 5, probe: h264, trimEnd: 2 }],
    { keepOriginal: true, originalVolume: 1, format: 'mp4' },
    { audioCount: 1, soundtrack: true },
  );
  expect(plan.copiesVideo).toBe(true);
  expect(plan.texts[0].content).toBe("file 'input.media'\ninpoint 1.000000\nfile 'input-1.media'\noutpoint 3.000000\n");
  expect(plan.args.slice(0, 8)).toEqual(['-f', 'concat', '-safe', '0', '-i', 'concat.txt', '-i', 'input-3.media']);
  expect(plan.args).toContain('1:a:0');
  expect(plan.duration).toBe(12);
});

test('presets, stills, and size targets force a scaled H.264 encode', () => {
  const settings = { keepOriginal: true, originalVolume: 1, format: 'mp4' as const, preset: 'vertical' as const, targetMB: 20 };
  expect(canCopyVideo([{ duration: 10, probe: h264 }], 'mp4', settings)).toBe(false);
  const plan = buildVideoPlan([{ duration: 10, probe: h264 }, { duration: 4, probe: { ...h264, width: 800, height: 800 }, image: true }], settings, { audioCount: 0, soundtrack: false, srt: '1\n00:00:00,000 --> 00:00:01,000\nHi\n' });
  const graph = graphOf(plan.args);
  expect(graph).toContain('scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920');
  expect(plan.args).toContain('-loop');
  expect(plan.args).toContain('-b:v');
  expect(plan.args).toContain('mov_text');
  expect(plan.args).toContain('-an');
});

test('clip transforms normalize defaults and prevent stream copy', () => {
  expect(clipTransform(undefined)).toEqual({ scale: 1, scaleX: 1, scaleY: 1, x: 0, y: 0, rotation: 0 });
  expect(hasClipTransform(undefined)).toBe(false);
  expect(clipTransform({ scale: 99, x: -999, y: 999, rotation: 720 })).toEqual({
    scale: 10, scaleX: 1, scaleY: 1, x: -200, y: 200, rotation: 360,
  });
  expect(hasClipTransform({ scale: 1.25 })).toBe(true);
  const avc = { ...h264, videoCodec: 'avc' };
  expect(canCopyVideo([{ duration: 10, probe: avc, transform: { scale: 1.2 } }], 'mp4')).toBe(false);
});

test('transformed footage gets an FFmpeg zoom, rotate, and position pass', () => {
  const plan = buildVideoPlan(
    [{ duration: 10, probe: h264, transform: { scale: 1.5, x: 10, y: -5, rotation: 90 } }],
    { keepOriginal: true, originalVolume: 1, format: 'mp4' },
    { audioCount: 0, soundtrack: false },
  );
  expect(plan.copiesVideo).toBe(false);
  const graph = graphOf(plan.args);
  expect(graph).toContain('scale=iw*1.500000:ih*1.500000');
  expect(graph).toContain('rotate=1.570796:ow=rotw(1.570796):oh=roth(1.570796)');
  expect(graph).toContain("overlay=x='(1280-w)/2+(128.000)':y='(720-h)/2+(-36.000)'");
});

test('custom timeline resolution drives the output size and forces a re-encode', () => {
  expect(targetSize('custom', { width: 1920, height: 1080 }, undefined, { width: 1234, height: 678 }))
    .toEqual({ width: 1234, height: 678, fit: 'contain' });
  expect(targetSize('custom', { width: 1920, height: 1080 }, undefined, { width: 1235, height: 677 }))
    .toEqual({ width: 1236, height: 678, fit: 'contain' });
  const plan = buildVideoPlan(
    [{ duration: 10, probe: h264 }],
    { keepOriginal: true, originalVolume: 1, format: 'mp4', preset: 'custom', customWidth: 1234, customHeight: 678 },
    { audioCount: 0, soundtrack: false },
  );
  expect(plan.copiesVideo).toBe(false);
  expect(graphOf(plan.args)).toContain('scale=1234:678');
  expect(canCopyVideo([{ duration: 10, probe: h264 }], 'mp4', { preset: 'custom' })).toBe(false);
});

test('the project frame rate drives encoded plans and disables stream copy', () => {
  const settings = { keepOriginal: true, originalVolume: 1, format: 'mp4' as const, frameRate: 60 };
  const plan = buildVideoPlan([{ duration: 10, probe: h264 }], settings, { audioCount: 0, soundtrack: false });
  expect(plan.copiesVideo).toBe(false);
  expect(graphOf(plan.args)).toContain('fps=60');
  expect(canCopyVideo([{ duration: 10, probe: h264 }], 'mp4', settings)).toBe(false);
  expect(canCopyVideo([{ duration: 10, probe: { ...h264, fps: 60 } }], 'mp4', settings)).toBe(true);
  expect(planFrameRate({ frameRate: 23.976 }, 30)).toBe(23.976);
  expect(planFrameRate({}, 29.97)).toBe(29.97);
  expect(planFrameRate({ frameRate: 0 }, 0)).toBe(30);
});

test('the project frame rate feeds generated stills and timeline gaps', () => {
  const settings = { keepOriginal: true, originalVolume: 1, format: 'mp4' as const, frameRate: 50 };
  const plan = buildVideoPlan(
    [{ duration: 4, probe: h264, start: 0 }, { duration: 4, probe: h264, start: 6 }],
    settings,
    { audioCount: 0, soundtrack: false },
  );
  expect(plan.copiesVideo).toBe(false);
  expect(graphOf(plan.args)).toContain('color=c=black:s=1280x720:r=50');
  expect(graphOf(plan.args)).toContain('fps=50');

  const stills = buildVideoPlan(
    [
      { duration: 4, probe: h264 },
      { duration: 2, probe: { ...h264, width: 800, height: 800 }, image: true },
    ],
    { ...settings, preset: '720p' as const },
    { audioCount: 0, soundtrack: false },
  );
  expect(stills.args[stills.args.indexOf('-framerate') + 1]).toBe('50');
  expect(graphOf(stills.args)).toContain('fps=50');
});

test('transformed clips keep their transform in the segmented path', () => {
  const plan = buildVideoPlan(
    [
      { duration: 4, probe: h264, start: 0, transform: { scale: 1.25, rotation: 45 } },
      { duration: 2, probe: h264, start: 6 },
    ],
    { keepOriginal: true, originalVolume: 1, format: 'mp4' },
    { audioCount: 0, soundtrack: false },
  );
  const graph = graphOf(plan.args);
  expect(graph).toContain('color=c=black:s=1280x720:r=30:d=4.000000[bg0]');
  expect(graph).toContain('rotate=0.785398:ow=rotw(0.785398):oh=roth(0.785398)');
  expect(graph).toContain('[bg0][fg0]overlay=');
  expect(graph).not.toContain('[bg2]');
});

test('size helpers', () => {
  expect(targetSize('720p', { width: 1920, height: 1080 })).toEqual({ width: 1280, height: 720, fit: 'contain' });
  expect(targetSize('source', { width: 641, height: 359 })).toEqual({ width: 642, height: 360, fit: 'contain' });
  expect(targetSize('source', { width: 1920, height: 1080 }, 640)).toEqual({ width: 1138, height: 640, fit: 'contain' });
  expect(targetSize('source', { width: 1080, height: 1920 }, 720)).toEqual({ width: 720, height: 1280, fit: 'contain' });
  expect(bitrateForSize(10, 80, true)).toBe(Math.round((10 * 8_000_000 * 0.97) / 80 - 192_000));
});

test('copy decisions understand Mediabunny codec names, WebM, and exact cuts', () => {
  const avc = { ...h264, videoCodec: 'avc' };
  expect(canCopyVideo([{ duration: 10, probe: avc }], 'mp4')).toBe(true);
  expect(canCopyVideo([{ duration: 10, probe: avc }], 'mp4', { maxShortEdge: 720 })).toBe(false);
  expect(canCopyVideo([{ duration: 10, probe: avc, trimStart: 1 }], 'mp4')).toBe(true);
  expect(canCopyVideo([{ duration: 10, probe: avc, trimStart: 1 }], 'mp4', { exactCuts: true })).toBe(false);
  expect(canCopyVideo([{ duration: 10, probe: { ...avc, videoCodec: 'vp9' } }], 'webm')).toBe(true);
  expect(canCopyVideo([{ duration: 10, probe: avc }], 'webm')).toBe(false);
});

test('a plain join can skip the soundtrack mix until audio packets disagree', () => {
  const settings = { keepOriginal: true, originalVolume: 1, format: 'mp4' as const };
  expect(canSkipSoundtrackMix([{ duration: 10, probe: h264 }], [], settings)).toBe(true);
  expect(canSkipSoundtrackMix([{ duration: 10, probe: h264 }], [], { ...settings, targetMB: 20, preset: '720p' })).toBe(true);
  expect(canSkipSoundtrackMix([{ duration: 10, probe: h264 }], [music], settings)).toBe(false);
  expect(canSkipSoundtrackMix([{ duration: 10, probe: h264, trimStart: 1 }], [], settings)).toBe(false);
  expect(canSkipSoundtrackMix([{ duration: 10, probe: h264 }], [], { ...settings, normalize: 'podcast' as const })).toBe(false);
});

test('muted added audio is left out of the mix', () => {
  const plan = buildAudioMixPlan([{ duration: 10, probe: h264 }], [{ ...music, mute: true }], {
    keepOriginal: true, originalVolume: 1, format: 'mp4',
  })!;
  expect(plan.args).not.toContain('input-1.media');
  expect(graphOf(plan.args)).not.toContain('[1:a:0]');
});

test('the final mix is limited, and per-clip gain and mute survive', () => {
  const plan = buildAudioMixPlan(
    [{ duration: 10, probe: h264, volume: 0.5 }, { duration: 5, probe: h264, mute: true }],
    [],
    { keepOriginal: true, originalVolume: 1, format: 'mp4' },
  )!;
  const graph = graphOf(plan.args);
  expect(graph).toContain('volume=0.5000');
  expect(graph).toContain('anullsrc');
  expect(graph).toContain('alimiter=limit=0.95:level=false');
});

test('loudness normalization and WebM soundtracks use the right filters and container', () => {
  const normalized = buildAudioMixPlan([{ duration: 10, probe: h264 }], [], {
    keepOriginal: true, originalVolume: 1, format: 'mp4', normalize: 'podcast',
  })!;
  expect(graphOf(normalized.args)).toContain('loudnorm=I=-16:TP=-1.5:LRA=11');
  expect(graphOf(normalized.args)).toContain('alimiter=limit=0.95:level=false');

  const webm = buildAudioMixPlan([{ duration: 10, probe: { ...h264, videoCodec: 'vp9' } }], [], {
    keepOriginal: true, originalVolume: 1, format: 'webm',
  })!;
  expect(webm.output).toBe('mix.webm');
  expect(webm.mime).toBe('audio/webm');
  expect(webm.args).toContain('libvorbis');
});

test('WebM video plans pick VP9 and copy the Opus soundtrack', () => {
  const plan = buildVideoPlan(
    [{ duration: 10, probe: { ...h264, videoCodec: 'vp9' } }],
    { keepOriginal: true, originalVolume: 1, format: 'webm', preset: '720p' },
    { audioCount: 0, soundtrack: true },
  );
  expect(plan.args).toContain('libvpx');
  expect(plan.args).toContain('copy');
  expect(plan.output).toBe('output.webm');
});

test('caption offsets shift cues and drop the ones before zero', () => {
  const cues = [{ start: 1, end: 2, text: 'a' }, { start: 5, end: 6, text: 'b' }];
  expect(shiftCues(cues, 1)).toEqual([{ start: 2, end: 3, text: 'a' }, { start: 6, end: 7, text: 'b' }]);
  expect(shiftCues(cues, -1.5).map((cue) => cue.text)).toEqual(['a', 'b']);
  expect(shiftCues(cues, -10)).toEqual([]);
});

test('free-positioned clips keep gaps and stay independent of array order', () => {
  const first = { duration: 4, probe: h264, start: 0, track: 0 };
  const second = { duration: 4, probe: h264, start: 6, track: 0 };
  expect(videoStarts([first, second])).toEqual([0, 6]);
  expect(totalLength([first, second])).toBe(10);
  expect(isSequentialVideo([first, second])).toBe(false);
  const segments = videoSegments([first, second]).map((segment) => ({
    start: segment.start,
    end: segment.end,
    name: segment.clip === first ? 'first' : segment.clip === second ? 'second' : 'gap',
    sourceStart: segment.sourceStart,
  }));
  expect(segments).toEqual([
    { start: 0, end: 4, name: 'first', sourceStart: 0 },
    { start: 4, end: 6, name: 'gap', sourceStart: undefined },
    { start: 6, end: 10, name: 'second', sourceStart: 0 },
  ]);
});

test('overlapping video tracks prefer the upper timeline row and reveal the lower clip on either side', () => {
  const low = { duration: 8, probe: h264, start: 0, track: 1 };
  const high = { duration: 2, probe: h264, start: 1, track: 0 };
  const segments = videoSegments([low, high]);
  expect(videoSegments([high, low])).toEqual(segments);
  expect(segments.map((segment) => ({
    start: segment.start,
    end: segment.end,
    name: segment.clip === low ? 'low' : segment.clip === high ? 'high' : 'gap',
    sourceStart: segment.sourceStart,
  }))).toEqual([
    { start: 0, end: 1, name: 'low', sourceStart: 0 },
    { start: 1, end: 3, name: 'high', sourceStart: 0 },
    { start: 3, end: 8, name: 'low', sourceStart: 3 },
  ]);
  expect(canCopyVideo([low, high], 'mp4')).toBe(false);
});

test('free-positioned video audio is delayed to its timeline start', () => {
  const plan = buildAudioMixPlan(
    [
      { duration: 4, probe: h264, start: 0 },
      { duration: 4, probe: h264, start: 6 },
    ],
    [],
    { keepOriginal: true, originalVolume: 1, format: 'mp4' },
  )!;
  const graph = graphOf(plan.args);
  expect(plan.duration).toBe(10);
  expect(graph).toContain('adelay=6000:all=1');
  expect(graph).toContain('amix=inputs=2');
});

test('speed points split FFmpeg picture and linked sound into matching sections', () => {
  const retime = { speed: 1, speedPoints: [{ source: 2, rate: 2 }] };
  const video = { duration: 6, probe: h264, start: 0, mute: true, effects: retime };
  const audio = { duration: 6, offset: 0, trimStart: 0, trimEnd: 0, volume: 1, fadeIn: 0, fadeOut: 0, retime };
  const settings = { keepOriginal: true, originalVolume: 1, format: 'mp4' as const };
  expect(videoSegments([video]).map(({ start, end, sourceStart }) => [start, end, sourceStart])).toEqual([[0, 2, 0], [2, 4, 2]]);
  const picture = buildVideoPlan([video], settings, { audioCount: 1, soundtrack: true });
  expect(picture.duration).toBe(4);
  expect(graphOf(picture.args)).toContain('setpts=PTS/2.0000');
  const sound = buildAudioMixPlan([video], [audio], settings)!;
  expect(sound.duration).toBe(4);
  expect(graphOf(sound.args)).toContain('asplit=2');
  expect(graphOf(sound.args)).toContain('atempo=2.0000');
});

test('segmented video plans paint gaps and re-encode overlapping rows', () => {
  const plan = buildVideoPlan(
    [
      { duration: 4, probe: h264, start: 0 },
      { duration: 4, probe: h264, start: 6 },
    ],
    { keepOriginal: true, originalVolume: 1, format: 'mp4' },
    { audioCount: 0, soundtrack: false },
  );
  expect(plan.copiesVideo).toBe(false);
  expect(graphOf(plan.args)).toContain('color=c=black');
  expect(graphOf(plan.args)).toContain('concat=n=3:v=1:a=0');
  expect(plan.duration).toBe(10);
});

test('only untouched linked sound is eligible to use the audio packet-copy fast path', () => {
  const blob = new Blob(['source']);
  const video = { blob, probe: h264, duration: 10, start: 0, mute: true, linkGroup: 1 };
  const audio = {
    blob, duration: 10, offset: 0, trimStart: 0, trimEnd: 0,
    volume: 1, fadeIn: 0, fadeOut: 0, track: 0, linkGroup: 1,
  };
  const job: ExportJob = {
    videos: [video],
    audios: [audio],
    settings: { format: 'mp4', keepOriginal: true, originalVolume: 1 },
    captions: null,
    signal: new AbortController().signal,
    onProgress: () => undefined,
  };
  expect(linkedSourceVideos(job)).toEqual([{ ...video, mute: false, volume: 1, audioTrack: 0 }]);
  expect(job.videos[0].mute).toBe(true);
  for (const edit of [
    { offset: 0.1 }, { volume: 0.5 }, { fadeIn: 0.25 }, { trimEnd: 0.25 }, { mute: true },
    { track: 1 }, { blob: new Blob(['other source']) }, { linkGroup: 2 },
  ]) {
    expect(linkedSourceVideos({ ...job, audios: [{ ...audio, ...edit }] })).toBeNull();
  }
  expect(linkedSourceVideos({ ...job, videos: [{ ...video, mute: false }] })).toBeNull();
  expect(linkedSourceVideos({ ...job, audios: [audio, audio] })).toBeNull();
  for (const edit of [{ duck: true }, { normalize: 'social' as const }, { keepOriginal: false }]) {
    expect(linkedSourceVideos({ ...job, settings: { ...job.settings, ...edit } })).toBeNull();
  }
});

test('embedded subtitle probing preserves subtitle ordinals, labels and dispositions', () => {
  const probe = parseProbe([
    '  Stream #0:0: Video: h264, yuv420p, 640x360, 30 fps',
    '  Stream #0:1(jpn): Audio: aac, 48000 Hz, stereo, fltp',
    '  Stream #0:2(eng): Subtitle: subrip (default) (forced)',
    '    Metadata:',
    '      title           : Dialogue',
    '  Stream #0:3(jpn): Subtitle: hdmv_pgs_subtitle',
  ].join('\n'));
  const streams = probe.subtitleStreams!;
  expect(streams).toEqual([
    { index: 0, codec: 'subrip', language: 'eng', title: 'Dialogue', default: true, forced: true },
    { index: 1, codec: 'hdmv_pgs_subtitle', language: 'jpn', title: null, default: false, forced: false },
  ]);
  expect(streams.map(isTextSubtitle)).toEqual([true, false]);
  expect(probe.audioStreams?.[0].channels).toBe('stereo');
});

test('embedded cues follow the visible source range across trim, split and speed edits', () => {
  const embeddedCaptions = {
    stream: { index: 0, codec: 'subrip', language: 'eng', title: null, default: true, forced: false },
    cues: [{ start: 1, end: 5, text: 'Spans the cut' }, { start: 8, end: 9, text: 'Out of range' }],
  };
  const clip = { id: 1, probe: h264, duration: 10, start: 12, trimStart: 2, trimEnd: 3, effects: { speed: 2 }, embeddedCaptions };
  const left = mapEmbeddedCaptions({ ...clip, trimEnd: 6 });
  const right = mapEmbeddedCaptions({ ...clip, id: 2, start: 13, trimStart: 4 });
  expect(left).toEqual([{ start: 12, end: 13, text: 'Spans the cut', embeddedClipId: 1, embeddedCueIndex: 0 }]);
  expect(right).toEqual([{ start: 13, end: 13.5, text: 'Spans the cut', embeddedClipId: 2, embeddedCueIndex: 0 }]);
});

test('moving an audio clip to another lane does not change its selected input stream', () => {
  const job = buildAudioMixPlan(
    [{ probe: h264, duration: 10, mute: true }],
    [{ ...music, track: 4, sourceTrack: 1 }],
    { format: 'mp4', keepOriginal: false, originalVolume: 1 },
  );
  expect(job).not.toBeNull();
  expect(graphOf(job!.args)).toContain('[0:a:1]');
  expect(graphOf(job!.args)).not.toContain('[0:a:4]');
});
