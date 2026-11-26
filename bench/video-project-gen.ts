// Heavy video-editor project generator for bench/video-heavy.mjs.
//
// It takes a seed project.json exported from the editor (Project menu >
// Export .zip) that lists the source assets, and builds the V1-V14 timelines
// from the performance brief by cloning the seed's clip schema. Using a real
// export as the seed keeps probes, effect defaults, and the snapshot schema
// identical to what the app writes, so the generator never drifts from it.
//
// Browser: `const gen = await import('/bench/video-project-gen.ts')` from the
// Vite dev server, then `gen.generateProject(seed, 'V5', { resolution: 2160 })`.
// CLI:     bun bench/video-project-gen.ts <seed project.json> <scenario> [--resolution 1080|2160] [--fps 30|60] > project.json
//
// The output is a project.json for an archive whose media paths match the
// seed's, so the seed media files can be zipped next to it unchanged.

export type ScenarioId = 'V1' | 'V2' | 'V3' | 'V4' | 'V5' | 'V6' | 'V7' | 'V8' | 'V9' | 'V10' | 'V11' | 'V12' | 'V13' | 'V14';

export interface GenOptions {
  /** Output height. 1080 or 2160 (custom size, 16:9). */
  resolution?: number;
  fps?: number;
  /** Deterministic PRNG seed. */
  seed?: number;
  /** Preview proxies already in the archive, by asset file name (V13). */
  proxies?: Record<string, ProxyRef>;
}

/** A proxy entry as the editor writes it in project.json (path inside the archive). */
export interface ProxyRef { path: string; width: number; height: number }

export interface GenSummary {
  scenario: ScenarioId;
  videoClips: number;
  audioClips: number;
  titles: number;
  graphics: number;
  cameraCuts: number;
  keyframes: number;
  transitions: number;
  effectClips: number;
  duration: number;
  videoTracks: number;
  audioTracks: number;
  proxiedClips: number;
  /** False when the seed lacks what the scenario needs (for example a 3 min source for V14). */
  faithful: boolean;
  note?: string;
}

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

export const SCENARIOS: Record<ScenarioId, string> = {
  V1: '1 clip, 10 s, no edits (copy path)',
  V2: '20 matching clips joined, about 5 min (packet copy join)',
  V3: '50 cuts from up to 5 sources, mixed codecs, about 10 min',
  V4: '4 stacked video tracks with transform keyframes every 2 s, 3 min',
  V5: 'V4 plus colour, blur, feathered ellipse mask, chroma key, tone curve, 33-point LUT',
  V6: '200 subtitle cues, 20 styled titles',
  V7: '100 graphics: gradient and pattern shapes, SVG, emoji, transitions',
  V8: 'V3 with transitions between every clip',
  V9: 'Speed changes 0.25x to 4x on 10 clips',
  V10: '6 audio tracks with volume keyframes and fades',
  V11: 'Multicam: 4 angles with 120 camera cuts',
  V12: 'Kitchen sink: V3+V4+V5+V6+V7+V8+V9+V10, 10 min',
  V13: 'V12 with 720p/540p preview proxies attached to every video asset (same ffmpeg arguments as the proxy builder in the app)',
  V14: '60 min timeline from 20 x 3 min clips (one 3 min source looped), few effects',
};

function rng(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

function identityLut(size = 33): { name: string; size: number; data: number[] } {
  const data: number[] = [];
  for (let b = 0; b < size; b += 1) {
    for (let g = 0; g < size; g += 1) {
      for (let r = 0; r < size; r += 1) {
        // A mild warm grade so the LUT pass is not optimised away.
        data.push(Math.min(1, (r / (size - 1)) * 1.04), g / (size - 1), Math.max(0, (b / (size - 1)) * 0.96));
      }
    }
  }
  return { name: 'bench-warm-33', size, data };
}

function emptyAnimation(): Json {
  return { blur: [], brightness: [], contrast: [], hue: [], opacity: [], rotation: [], saturation: [], scale: [], volume: [], x: [], y: [] };
}

const TRANSITIONS = ['fade-in', 'dip', 'push', 'slide', 'barn-door', 'split'];

export function generateProject(seedProject: Json, scenario: ScenarioId, options: GenOptions = {}): { project: Json; summary: GenSummary } {
  const random = rng(options.seed ?? 1234);
  const seed = clone(seedProject);
  const videoAssets = seed.assets.filter((asset: Json) => asset.kind === 'video');
  const audioAssets = seed.assets.filter((asset: Json) => asset.kind === 'audio');
  if (!videoAssets.length) throw new Error('The seed project needs at least one video asset.');
  const templateVideo = seed.state.videos[0];
  if (!templateVideo) throw new Error('The seed project needs one video clip on the timeline.');
  const height = options.resolution ?? 1080;
  const width = Math.round((height * 16) / 9);

  let nextId = 1000;
  let nextLink = 500;
  const videos: Json[] = [];
  const audios: Json[] = [];
  const titles: Json[] = [];
  const graphics: Json[] = [];
  const cameraCuts: Json[] = [];
  let keyframes = 0;
  let transitions = 0;
  let effectClips = 0;
  let faithful = true;
  let note: string | undefined;

  const makeVideo = (asset: Json, start: number, length: number, track: number, trimStart = 0): Json => {
    const clip = clone(templateVideo);
    Object.assign(clip, {
      id: nextId++,
      file: clone(asset.file),
      name: asset.name,
      duration: asset.duration,
      probe: clone(asset.probe),
      start,
      track,
      trimStart: Math.min(trimStart, Math.max(0, asset.duration - 0.5)),
      trimEnd: Math.max(0, asset.duration - Math.min(trimStart, Math.max(0, asset.duration - 0.5)) - length),
      animation: emptyAnimation(),
      transition: undefined,
      proxy: null,
      peaks: null,
      strip: null,
      linkGroup: undefined,
      linkOffset: undefined,
      mute: false,
    });
    videos.push(clip);
    return clip;
  };
  const clipLength = (clip: Json): number => Math.max(0, clip.duration - clip.trimStart - clip.trimEnd) / (clip.effects.speed || 1);
  const pickVideo = (index: number): Json => videoAssets[index % videoAssets.length];

  const sequence = (cuts: number, total: number, track = 0, sources = videoAssets.length): Json[] => {
    const out: Json[] = [];
    let at = 0;
    for (let index = 0; index < cuts; index += 1) {
      const asset = pickVideo(index % sources);
      const length = Math.min(asset.duration, total / cuts);
      const trim = Math.max(0, (asset.duration - length) * random());
      out.push(makeVideo(asset, at, length, track, trim));
      at += length;
    }
    return out;
  };

  const loopSource = (asset: Json, total: number, track: number): Json[] => {
    const out: Json[] = [];
    for (let at = 0; at < total - 0.01; at += asset.duration) {
      out.push(makeVideo(asset, at, Math.min(asset.duration, total - at), track));
    }
    return out;
  };

  const addTransformKeys = (clip: Json): void => {
    const length = clipLength(clip);
    for (let at = 0; at <= length + 1e-6; at += 2) {
      clip.animation.x.push({ at, value: -20 + 40 * random() });
      clip.animation.y.push({ at, value: -20 + 40 * random() });
      clip.animation.scale.push({ at, value: 0.3 + 0.4 * random() });
      clip.animation.rotation.push({ at, value: -15 + 30 * random() });
      clip.animation.opacity.push({ at, value: 0.6 + 0.4 * random() });
      keyframes += 5;
    }
  };

  const addEffects = (clip: Json): void => {
    Object.assign(clip.effects, {
      brightness: 0.1, contrast: 0.15, saturation: 0.2, hue: 12, blur: 3,
      mask: { shape: 'ellipse', x: 5, y: 5, width: 90, height: 90, feather: 20 },
      chroma: { enabled: true, color: '#00ff00', tolerance: 0.24, softness: 0.12 },
      curve: { shadows: 0.08, midtones: 0.05, highlights: -0.06 },
      lut: identityLut(33),
    });
    effectClips += 1;
  };

  const pip = (total: number): void => {
    for (let track = 0; track < 4; track += 1) {
      for (const clip of loopSource(pickVideo(track), total, track)) {
        if (track > 0) Object.assign(clip.transform, { scale: 0.45, x: track * 10 - 20, y: track * 8 - 12 });
        addTransformKeys(clip);
      }
    }
  };

  const addTitles = (count: number, total: number): void => {
    for (let index = 0; index < count; index += 1) {
      const start = (total / count) * index;
      titles.push({
        start, end: start + Math.min(4, total / count),
        text: `Benchmark title ${index + 1}`,
        track: 5,
        style: { fontFamily: 'Inter', fontSize: 7, fontWeight: 700, italic: false, uppercase: false, color: '#ffffff', align: 'center', x: 50, y: 20, maxWidth: 80, rotation: 0, lineHeight: 1.2, outlineWidth: 4, outlineColor: '#000000', shadowBlur: 8, shadowColor: '#000000', shadowX: 2, shadowY: 2, background: 'rgba(0,0,0,0.4)' },
        transition: index % 2 ? 'fade-in' : 'dip',
      });
    }
  };

  const fileCues = (count: number, total: number): Json[] => Array.from({ length: count }, (_, index) => {
    const start = (total / count) * index;
    return { start, end: start + Math.min(2.5, (total / count) * 0.9), text: `Subtitle line ${index + 1} with a few words` };
  });

  const addGraphics = (count: number, total: number): void => {
    const svg = 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="#f60"/></svg>');
    for (let index = 0; index < count; index += 1) {
      const start = (total / count) * index;
      const kind = index % 10 === 0 ? 'svg' : index % 5 === 1 ? 'emoji' : index % 2 ? 'ellipse' : 'rect';
      graphics.push({
        id: 9000 + index, kind, start, end: start + Math.min(5, total / count * 2), track: 6,
        x: 10 + (index * 7) % 70, y: 10 + (index * 11) % 70, width: 15, height: 15, rotation: (index * 13) % 360,
        fill: '#3b82f6', stroke: '#ffffff', strokeWidth: 2, opacity: 0.9, radius: 8,
        fillType: index % 3 === 0 ? 'linear' : index % 3 === 1 ? 'radial' : 'solid', fill2: '#f43f5e', gradientAngle: 45,
        pattern: ['none', 'stripes', 'dots', 'grid', 'checker'][index % 5], patternColor: '#ffffff', patternScale: 1,
        ...(kind === 'svg' ? { svg } : {}), ...(kind === 'emoji' ? { emoji: '🎬' } : {}),
        transition: TRANSITIONS[index % 3] === 'fade-in' ? 'fade-in' : 'dip',
      });
    }
  };

  const addTransitions = (clips: Json[]): void => {
    for (const [index, clip] of clips.entries()) {
      if (!index) continue;
      clip.transition = { type: TRANSITIONS[index % TRANSITIONS.length], duration: 0.5 };
      transitions += 1;
    }
  };

  const addSpeed = (clips: Json[]): void => {
    const speeds = [0.25, 0.5, 2, 4];
    for (const [index, clip] of clips.slice(0, 10).entries()) clip.effects.speed = speeds[index % speeds.length];
    // Re-pack the main track after the length change.
    let at = 0;
    for (const clip of clips) {
      clip.start = at;
      at += clipLength(clip);
    }
  };

  const addAudio = (tracks: number, total: number): void => {
    const sources = audioAssets.length ? audioAssets : videoAssets.filter((asset: Json) => asset.probe.hasAudio);
    if (!sources.length) return;
    for (let track = 0; track < tracks; track += 1) {
      const asset = sources[track % sources.length];
      for (let at = 0; at < total - 0.01; at += asset.duration) {
        const length = Math.min(asset.duration, total - at);
        audios.push({
          id: nextId++, file: clone(asset.file), name: asset.name, duration: asset.duration,
          offset: at, trimStart: 0, trimEnd: Math.max(0, asset.duration - length), volume: 0.8,
          fadeIn: 0.5, fadeOut: 0.5, track, tracks: asset.probe.audioStreams?.map((_: Json, i: number) => `Track ${i + 1}`) ?? [],
          muted: false, peaks: null,
        });
      }
    }
  };

  const linkAudio = (clips: Json[]): void => {
    for (const clip of clips) {
      if (!clip.probe.hasAudio || clip.track !== 0) continue;
      const link = nextLink++;
      clip.linkGroup = link;
      clip.mute = true;
      audios.push({
        id: nextId++, file: clone(clip.file), name: clip.name, duration: clip.duration, offset: clip.start,
        trimStart: clip.trimStart, trimEnd: clip.trimEnd, volume: 1, fadeIn: 0, fadeOut: 0, track: 0,
        tracks: ['Track 1'], muted: false, peaks: null, linkGroup: link,
        ...(clip.effects.speed !== 1 ? { retime: clip.effects.speed } : {}),
      });
    }
  };

  let state: Json = {};
  const settings = clone(seed.settings);
  settings.preset = 'custom';
  settings.customWidth = width;
  settings.customHeight = height;

  switch (scenario) {
    case 'V1':
      settings.preset = 'source';
      linkAudio([makeVideo(pickVideo(0), 0, Math.min(10, pickVideo(0).duration), 0)]);
      break;
    case 'V2': {
      settings.preset = 'source';
      linkAudio(loopSource(pickVideo(0), 300, 0));
      break;
    }
    case 'V3':
      linkAudio(sequence(50, 600));
      break;
    case 'V4':
      pip(180);
      break;
    case 'V5':
      pip(180);
      videos.forEach(addEffects);
      break;
    case 'V6':
      linkAudio(sequence(18, 180));
      addTitles(20, 180);
      state.fileCues = fileCues(200, 180);
      state.captionSource = 'file';
      state.captionMode = 'burn';
      break;
    case 'V7':
      linkAudio(sequence(18, 180));
      addGraphics(100, 180);
      break;
    case 'V8': {
      const clips = sequence(50, 600);
      addTransitions(clips);
      linkAudio(clips);
      break;
    }
    case 'V9': {
      const clips = sequence(20, 200);
      addSpeed(clips);
      linkAudio(clips);
      break;
    }
    case 'V10': {
      linkAudio(sequence(18, 180));
      addAudio(6, 180);
      for (const clip of audios) {
        const length = Math.max(0, clip.duration - clip.trimStart - clip.trimEnd);
        clip.volumeKeys = [{ at: 0, value: 0.2 }, { at: length / 2, value: 1 }, { at: length, value: 0.4 }];
      }
      settings.duck = true;
      settings.normalize = 'ebu';
      break;
    }
    case 'V11': {
      for (let angle = 0; angle < 4; angle += 1) loopSource(pickVideo(angle), 600, angle);
      for (let index = 0; index < 120; index += 1) cameraCuts.push({ at: index * 5, track: index % 4 });
      linkAudio(videos.filter((clip) => clip.track === 0));
      break;
    }
    case 'V12':
    case 'V13': {
      const main = sequence(50, 600);
      addTransitions(main);
      addSpeed(main);
      linkAudio(main);
      for (let track = 1; track < 4; track += 1) {
        for (const clip of loopSource(pickVideo(track), 180, track)) {
          Object.assign(clip.transform, { scale: 0.45, x: track * 10 - 20, y: track * 8 - 12 });
          addTransformKeys(clip);
          addEffects(clip);
        }
      }
      addTitles(20, 600);
      state.fileCues = fileCues(200, 600);
      state.captionSource = 'file';
      state.captionMode = 'burn';
      addGraphics(100, 600);
      addAudio(5, 600);
      if (scenario === 'V13' && !Object.keys(options.proxies ?? {}).length) {
        faithful = false;
        note = 'V13 without proxies attached is the same as V12.';
      }
      break;
    }
    case 'V14': {
      // 20 x 3 min clips. Loop one long source so the timeline is really 60 min.
      const long = videoAssets.find((asset: Json) => asset.duration >= 170);
      if (long) {
        const clips: Json[] = [];
        for (let index = 0; index < 20; index += 1) clips.push(makeVideo(long, index * Math.min(180, long.duration), Math.min(180, long.duration), 0));
        // A few effects: colour on every fourth clip.
        clips.forEach((clip, index) => { if (index % 4 === 0) Object.assign(clip.effects, { brightness: 0.05, contrast: 0.1 }); });
        linkAudio(clips);
      } else {
        faithful = false;
        note = 'No source of 3 min or longer in the seed; timeline is shorter than 60 min.';
        linkAudio(sequence(20, 3600, 0, videoAssets.length));
      }
      break;
    }
    default:
      throw new Error(`Unknown scenario ${scenario}`);
  }

  if (options.fps) settings.fps = options.fps;
  let proxiedClips = 0;
  const proxies = options.proxies ?? {};
  for (const asset of seed.assets) asset.proxy = proxies[asset.name] ?? asset.proxy ?? null;
  for (const clip of videos) {
    const proxy = proxies[clip.name];
    if (proxy) {
      clip.proxy = proxy;
      proxiedClips += 1;
    }
  }
  const videoTracks = Math.max(1, ...videos.map((clip) => clip.track + 1), titles.length ? 6 : 0, graphics.length ? 7 : 0);
  const audioTracks = Math.max(1, ...audios.map((clip) => clip.track + 1));
  state = {
    ...clone(seed.state),
    ...state,
    videos,
    audios,
    titles,
    graphics,
    cameraCuts,
    selected: null,
    time: 0,
    videoTrackCount: videoTracks,
    audioTrackCount: audioTracks,
    videoTrackState: Array.from({ length: videoTracks }, () => ({ hidden: false, muted: false, locked: false, solo: false, gain: 1, opacity: 1 })),
    audioTrackState: Array.from({ length: audioTracks }, () => ({ muted: false, locked: false, solo: false, gain: 1 })),
    transcriptEdits: [],
  };
  if (!state.fileCues) state.fileCues = null;

  const duration = Math.max(0, ...videos.map((clip) => clip.start + clipLength(clip)), ...audios.map((clip) => clip.offset + Math.max(0, clip.duration - clip.trimStart - clip.trimEnd)));
  const project = { ...seed, name: `bench-${scenario}-${height}p`, settings, state, assets: seed.assets };
  return {
    project,
    summary: {
      scenario, videoClips: videos.length, audioClips: audios.length, titles: titles.length, graphics: graphics.length,
      cameraCuts: cameraCuts.length, keyframes, transitions, effectClips, duration: +duration.toFixed(3),
      videoTracks, audioTracks, proxiedClips, faithful, ...(note ? { note } : {}),
    },
  };
}

if (import.meta.main) {
  const [seedPath, scenario = 'V1', ...rest] = process.argv.slice(2);
  if (!seedPath) {
    console.error('Usage: bun bench/video-project-gen.ts <seed project.json> <V1..V14> [--resolution 1080|2160] [--fps 30|60]');
    process.exit(1);
  }
  const flag = (name: string): number | undefined => {
    const index = rest.indexOf(name);
    return index >= 0 ? Number(rest[index + 1]) : undefined;
  };
  const { readFileSync } = await import('node:fs');
  const seed = JSON.parse(readFileSync(seedPath, 'utf8'));
  const { project, summary } = generateProject(seed, scenario as ScenarioId, { resolution: flag('--resolution'), fps: flag('--fps') });
  console.error(JSON.stringify(summary));
  console.log(JSON.stringify(project));
}
