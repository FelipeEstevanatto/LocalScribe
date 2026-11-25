/**
 * Audio studio: a single-track editor with focused tools (vocal remover,
 * pitch and tempo, cutter, effects, joiner, key and BPM finder, recorder and
 * karaoke). Every tool works on the same track and pushes a new version, so
 * undo and redo cover all of them. All processing runs locally.
 */

import { AUDIO_FORMATS, sharedFfmpeg, type AudioFormat, type FfmpegProgress } from './audio-ffmpeg';
import { sharedMedia } from './media-router';
import {
  applyAudioEdit,
  emptyEdit,
  inspectEditorAudio,
  joinAudio,
  mixKaraoke,
  mixStems,
  prepareEditorAudio,
  type AudioEdit,
  type EditorAudio,
  type JobOptions,
} from './audio-edit';
import { canRenderFast, renderFastEdit, sliceFloatWav } from './audio-dsp';
import { trimSilenceFile } from './audio-silence';
import { errorMessage, isAbortError } from './errors';
import { tappedTempo, type MusicEstimate } from './music-analysis';
import { runMusicTool, type MusicProgress } from './music-client';
import { MUSIC_MODEL_VARIANTS, type MusicModelVariant } from './music-model';
import { toSrt } from './captions';
import { createZip } from './zip';
import type { JobHandle } from './jobs';
import { MicrophoneRecorder } from './recorder';
import { bufferPeaks, StemMixer, TrackPlayer } from './studio-player';
import { TransferMeter, WorkMeter } from './transfer';
import { formatClock, WaveformView } from './waveform-view';

interface Version {
  blob: Blob;
  audio: EditorAudio;
  label: string;
}

interface BatchItem {
  file: File;
  status: string;
  fraction: number;
  result: Blob | null;
  name: string;
}

interface JoinItem {
  id: number;
  name: string;
  blob: Blob;
  duration: number;
  trimStart: number;
  trimEnd: number;
}

export interface LyricLine {
  start: number;
  end: number;
  text: string;
  words?: { text: string; start: number; end: number | null }[];
}

interface StudioOptions {
  trackJob?: (label: string) => JobHandle;
  transcribe?: (file: File, signal: AbortSignal, onProgress: (fraction: number, message: string) => void) => Promise<LyricLine[]>;
  modelName?: () => string;
  getSample: () => Promise<File>;
  getTranscribeFile: () => File | null;
  sendToTranscribe: (file: File) => Promise<void>;
  sendToTts: (file: File) => Promise<void>;
  download: (blob: Blob, name: string) => void;
}

type Tab = 'remover' | 'pitch' | 'cutter' | 'effects' | 'joiner' | 'keybpm' | 'record' | 'lyrics' | 'batch';

const TABS: Record<Tab, { title: string; description: string; needsTrack: boolean }> = {
  remover: { title: 'Vocal remover', description: 'Separate the voice from the music, or split a song into vocals, drums, bass, and other.', needsTrack: true },
  pitch: { title: 'Pitch & tempo', description: 'Change the key or speed of any song. Hear the result live before you save it.', needsTrack: true },
  cutter: { title: 'Audio cutter', description: 'Trim a song or recording, cut out a part, and add fades.', needsTrack: true },
  effects: { title: 'Effects', description: 'Adjust volume and tone, reduce noise, normalize loudness, and more.', needsTrack: true },
  joiner: { title: 'Audio joiner', description: 'Combine several tracks into one, with optional crossfades.', needsTrack: false },
  keybpm: { title: 'Key & BPM finder', description: 'Find the key and tempo of a song.', needsTrack: false },
  record: { title: 'Recorder & karaoke', description: 'Record your voice, or sing over the studio track.', needsTrack: false },
  lyrics: { title: 'Lyrics', description: 'Transcribe the words of a song with timings, and follow along while it plays.', needsTrack: true },
  batch: { title: 'Batch', description: 'Convert, normalize, or separate many files at once.', needsTrack: false },
};

const NOTES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
const STEM_COLORS: Record<string, string> = {
  Vocals: '#f472b6',
  Instrumental: '#818cf8',
  Drums: '#fbbf24',
  Bass: '#34d399',
  Other: '#38bdf8',
  Guitar: '#fb923c',
  Piano: '#a78bfa',
};
const MAX_VERSIONS = 16;

/**
 * Break long recognized chunks into singable lines: at pauses, sentence ends,
 * or about nine words. Without word timings, phrases get times in proportion
 * to their length.
 */
export function splitLyricLines(lines: LyricLine[]): LyricLine[] {
  const out: LyricLine[] = [];
  for (const line of lines) {
    if (line.words?.length) {
      let current: NonNullable<LyricLine['words']> = [];
      const flush = () => {
        if (!current.length) return;
        const last = current[current.length - 1];
        out.push({ start: current[0].start, end: last.end ?? last.start, text: current.map((word) => word.text.trim()).join(' '), words: current });
        current = [];
      };
      line.words.forEach((word, i) => {
        const previous = line.words![i - 1];
        const gap = previous ? word.start - (previous.end ?? previous.start) : 0;
        if (current.length && (gap > 0.6 || current.length >= 9 || /[.!?]$/.test(previous.text.trim()))) flush();
        current.push(word);
      });
      flush();
      continue;
    }
    const phrases = line.text.split(/(?<=[.!?,;:])\s+/).map((phrase) => phrase.trim()).filter(Boolean);
    const chars = phrases.reduce((sum, phrase) => sum + phrase.length, 0) || 1;
    let at = line.start;
    for (const phrase of phrases) {
      const length = ((line.end - line.start) * phrase.length) / chars;
      out.push({ start: at, end: at + length, text: phrase });
      at += length;
    }
  }
  return out;
}
const TAB_KEY = 'localscribe.studio.tab';

function transposeKey(key: string, semitones: number): string {
  const index = NOTES.indexOf(key);
  if (index < 0) return key;
  return NOTES[(((index + Math.round(semitones)) % 12) + 12) % 12];
}

function signed(value: number, digits = 1): string {
  const text = Math.abs(value) % 1 === 0 ? String(Math.abs(value)) : Math.abs(value).toFixed(digits);
  return (value > 0 ? '+' : value < 0 ? '−' : '') + text;
}

function dbfs(value: number): string {
  return value > 0 ? (20 * Math.log10(value)).toFixed(1) + ' dBFS' : '−∞ dBFS';
}

/** Duration via the browser's own demuxer, with FFmpeg as the fallback. */
async function mediaDuration(blob: Blob, signal: AbortSignal): Promise<number> {
  const url = URL.createObjectURL(blob);
  try {
    const duration = await new Promise<number>((resolve) => {
      const media = document.createElement('video');
      const done = (value: number) => {
        clearTimeout(timer);
        media.removeAttribute('src');
        resolve(value);
      };
      const timer = setTimeout(() => done(0), 6000);
      media.preload = 'metadata';
      media.onloadedmetadata = () => done(Number.isFinite(media.duration) ? media.duration : 0);
      media.onerror = () => done(0);
      media.src = url;
    });
    if (duration > 0) return duration;
  } finally {
    URL.revokeObjectURL(url);
  }
  const probe = await sharedMedia().probe(blob, signal);
  if (!probe.hasAudio || !probe.duration) throw new Error('This file has no readable audio track.');
  return probe.duration;
}

export function setupAudioStudio(root: HTMLElement, options: StudioOptions) {
  const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
    const element = root.querySelector<T>('#studio-' + id);
    if (!element) throw new Error('Missing studio control: ' + id);
    return element;
  };
  const ffmpeg = sharedFfmpeg();
  const player = new TrackPlayer();
  const mixer = new StemMixer();
  const recorder = new MicrophoneRecorder();

  // Elements -----------------------------------------------------------------
  const tabs = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-studio-tab]'));
  const panels = Array.from(root.querySelectorAll<HTMLElement>('[data-studio-panel]'));
  const input = $<HTMLInputElement>('input');
  const drop = $('drop');
  const dropTitle = $('drop-title');
  const dropDesc = $('drop-desc');
  const sample = $<HTMLButtonElement>('sample');
  const useTranscribe = $<HTMLButtonElement>('use-transcribe');
  const progressBox = $('progress');
  const progressLabel = $('progress-label');
  const progressDetail = $('progress-detail');
  const progressBar = $('progress-bar');
  const progressSub = $('progress-sub');
  const cancel = $<HTMLButtonElement>('cancel');
  const status = $('status');
  const trackBox = $('track');
  const nameLabel = $('name');
  const metaLabel = $('meta');
  const undoButton = $<HTMLButtonElement>('undo');
  const redoButton = $<HTMLButtonElement>('redo');
  const revert = $<HTMLButtonElement>('revert');
  const playButton = $<HTMLButtonElement>('play');
  const timeLabel = $('time');
  const historyLabel = $('history');
  const zoom = $<HTMLInputElement>('zoom');
  const previewNote = $('preview-note');
  const exportBox = $('export');
  const format = $<HTMLSelectElement>('format');
  const formatHint = $('format-hint');
  const downloadButton = $<HTMLButtonElement>('download');
  const toTranscribe = $<HTMLButtonElement>('to-transcribe');
  const toTts = $<HTMLButtonElement>('to-tts');
  const pendingNote = $('pending');
  const nextBox = $('next');
  const markersLabel = $('markers');
  const markersClear = $<HTMLButtonElement>('markers-clear');
  const passes = $<HTMLSelectElement>('passes');
  const separateSize = $('separate-size');
  const stemsZip = $<HTMLButtonElement>('stems-zip');
  const effectsPreview = $<HTMLButtonElement>('effects-preview');
  const karaokeLyrics = $('karaoke-lyrics');
  const lyricsRun = $<HTMLButtonElement>('lyrics-run');
  const lyricsSource = $('lyrics-source');
  const lyricsList = $('lyrics');
  const lyricsLrc = $<HTMLButtonElement>('lyrics-lrc');
  const lyricsSrt = $<HTMLButtonElement>('lyrics-srt');
  const batchInput = $<HTMLInputElement>('batch-input');
  const batchOp = $<HTMLSelectElement>('batch-op');
  const batchRun = $<HTMLButtonElement>('batch-run');
  const batchClear = $<HTMLButtonElement>('batch-clear');
  const batchZip = $<HTMLButtonElement>('batch-zip');
  const batchList = $('batch-list');

  // Remover
  const stemModeButtons = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-stem-mode]'));
  const modelVariant = $<HTMLSelectElement>('model-variant');
  const separate = $<HTMLButtonElement>('separate');
  const mixerBox = $('mixer');
  const mixerPlay = $<HTMLButtonElement>('mixer-play');
  const mixerTime = $('mixer-time');
  const mixerPresets = $('mixer-presets');
  const stemList = $('stems');
  const mixDownload = $<HTMLButtonElement>('mix-download');
  const mixOpen = $<HTMLButtonElement>('mix-open');

  // Pitch
  const pitch = $<HTMLInputElement>('pitch');
  const pitchValue = $('pitch-value');
  const tempo = $<HTMLInputElement>('tempo');
  const tempoValue = $('tempo-value');
  const keyLine = $('key-line');
  const bpmLine = $('bpm-line');
  const pitchApply = $<HTMLButtonElement>('pitch-apply');
  const pitchReset = $<HTMLButtonElement>('pitch-reset');

  // Cutter
  const selStart = $<HTMLInputElement>('sel-start');
  const selEnd = $<HTMLInputElement>('sel-end');
  const selLength = $('sel-length');
  const selAll = $<HTMLButtonElement>('sel-all');
  const selPlay = $<HTMLButtonElement>('sel-play');
  const selLoop = $<HTMLInputElement>('sel-loop');
  const cutModeButtons = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-cut-mode]'));
  const fadeIn = $<HTMLInputElement>('fade-in');
  const fadeOut = $<HTMLInputElement>('fade-out');
  const cutApply = $<HTMLButtonElement>('cut-apply');
  const cutSummary = $('cut-summary');

  // Effects
  const gain = $<HTMLInputElement>('gain');
  const bass = $<HTMLInputElement>('bass');
  const treble = $<HTMLInputElement>('treble');
  const denoise = $<HTMLInputElement>('denoise');
  const loudness = $<HTMLSelectElement>('loudness');
  const ceiling = $<HTMLSelectElement>('ceiling');
  const effectChecks = Array.from(root.querySelectorAll<HTMLInputElement>('[data-effect]'));
  const effectsApply = $<HTMLButtonElement>('effects-apply');
  const effectsReset = $<HTMLButtonElement>('effects-reset');

  // Joiner
  const joinInput = $<HTMLInputElement>('join-input');
  const joinCurrent = $<HTMLButtonElement>('join-current');
  const crossfade = $<HTMLInputElement>('crossfade');
  const joinTimeline = $('join-timeline');
  const joinButton = $<HTMLButtonElement>('join');
  const joinTotal = $('join-total');

  // Key & BPM
  const keyResult = $('key');
  const bpmResult = $('bpm');
  const analyze = $<HTMLButtonElement>('analyze');
  const analyzeFiles = $<HTMLInputElement>('analyze-files');
  const analysisResults = $('analysis-results');
  const tap = $<HTMLButtonElement>('tap');
  const tapResult = $('tap-result');
  const tapReset = $<HTMLButtonElement>('tap-reset');

  // Recorder
  const recordButton = $<HTMLButtonElement>('record');
  const recordTime = $('record-time');
  const recordLevel = $('record-level');
  const recordStop = $<HTMLButtonElement>('record-stop');
  const recordCancel = $<HTMLButtonElement>('record-cancel');
  const karaoke = $<HTMLInputElement>('karaoke');
  const takeBox = $('take');
  const mixTake = $<HTMLButtonElement>('mix');
  const takeVoice = $<HTMLButtonElement>('take-voice');

  // State --------------------------------------------------------------------
  let tab: Tab = 'remover';
  let versions: Version[] = [];
  let index = -1;
  let name = '';
  let operation: AbortController | null = null;
  let estimate: MusicEstimate | null = null;
  let estimateFor: Blob | null = null;
  let stemMode: 'vocals' | 'stems' | 'stems6' = 'vocals';
  let cutMode: 'keep' | 'remove' = 'keep';
  let stemViews: WaveformView[] = [];
  let joinItems: JoinItem[] = [];
  let joinId = 0;
  let recording: { backing: Version | null; offset: number } | null = null;
  let take: { backing: Version; voice: File; offset: number } | null = null;
  const taps: number[] = [];
  let markers: number[] = [];
  let lyrics: LyricLine[] = [];
  let batchItems: BatchItem[] = [];

  const current = (): Version | null => versions[index] ?? null;

  for (const [value, spec] of Object.entries(AUDIO_FORMATS)) format.add(new Option(spec.label, value));

  const fastFormats = new Set<AudioFormat>(['wav', 'mp3', 'flac', 'm4a', 'aac', 'opus', 'webm']);
  function refreshFormatHint(): void {
    const selected = format.value as AudioFormat;
    formatHint.textContent = fastFormats.has(selected)
      ? 'Fast local encoder · no FFmpeg download.'
      : 'FFmpeg fallback · loads the audio engine once.';
  }
  format.addEventListener('focus', refreshFormatHint, { once: true });
  format.addEventListener('change', refreshFormatHint);

  const wave = new WaveformView({
    height: 148,
    selectable: false,
    label: 'Track waveform. Click to seek. Drag to select in the cutter.',
    onSeek: (time) => {
      player.seek(time);
      wave.setPlayhead(time);
    },
    onSelect: () => syncSelectionFields(),
    onZoom: (value) => { zoom.value = String(Math.round((Math.log(value) / Math.log(200)) * 100)); },
  });
  wave.follow = true;
  $('wave').append(wave.element);

  // Progress -----------------------------------------------------------------
  const transfer = new TransferMeter();
  const work = new WorkMeter();
  let progressKind: 'bytes' | 'work' | 'none' = 'none';

  function setBar(percent: number | null): void {
    progressBar.classList.toggle('progress-indeterminate', percent === null);
    const value = percent === null ? 100 : Math.max(0, Math.min(100, percent));
    progressBar.style.width = value + '%';
    progressBar.setAttribute('aria-valuenow', String(Math.round(value)));
  }

  let activeJob: JobHandle | null = null;
  const progress = {
    show(label: string, sub = ''): void {
      activeJob?.update(0, label);
      progressBox.classList.remove('hidden');
      progressLabel.textContent = label;
      progressDetail.textContent = '';
      progressSub.textContent = sub;
      progressKind = 'none';
      setBar(null);
    },
    bytes(label: string, loaded: number, total: number, sub = ''): void {
      if (progressKind !== 'bytes') transfer.reset();
      progressKind = 'bytes';
      progressBox.classList.remove('hidden');
      progressLabel.textContent = label;
      progressDetail.textContent = transfer.describe(loaded, total);
      progressSub.textContent = sub;
      setBar(total > 0 ? (loaded / total) * 100 : null);
      if (total > 0) activeJob?.update(loaded / total, label);
    },
    work(label: string, fraction: number, sub = ''): void {
      if (progressKind !== 'work') work.reset();
      progressKind = 'work';
      progressBox.classList.remove('hidden');
      progressLabel.textContent = label;
      progressDetail.textContent = work.describe(fraction);
      progressSub.textContent = sub;
      setBar(fraction * 100);
      activeJob?.update(fraction, label);
    },
    hide(): void {
      progressBox.classList.add('hidden');
      progressKind = 'none';
    },
  };

  let jobLabel = '';
  ffmpeg.onLoad(({ loaded, total }) => {
    if (!operation) return;
    if (loaded >= total) progress.show(jobLabel);
    else progress.bytes('Loading the audio engine', loaded, total, 'First use only · cached afterwards');
  });

  /** FFmpeg job options that drive the progress bar. */
  function job(signal: AbortSignal, label: string): JobOptions {
    jobLabel = label;
    progress.show(label);
    return {
      signal,
      onProgress: ({ ratio, time }: FfmpegProgress) => {
        if (ratio !== null) progress.work(label, ratio);
        else progressDetail.textContent = formatClock(time) + ' processed';
      },
    };
  }

  interface NextStep {
    label: string;
    run: () => void;
  }

  /** Status line plus optional one-click next steps. */
  function say(message: string, next: NextStep[] = []): void {
    status.textContent = message;
    nextBox.replaceChildren(...next.map(({ label, run: action }) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'next-chip';
      chip.textContent = label;
      chip.addEventListener('click', () => {
        nextBox.classList.add('hidden');
        action();
      });
      return chip;
    }));
    nextBox.classList.toggle('hidden', !next.length);
  }

  const goTo = (target: Tab, label: string): NextStep => ({ label, run: () => selectTab(target) });
  const downloadStep: NextStep = { label: 'Download', run: () => downloadButton.click() };

  async function run(label: string, action: (signal: AbortSignal) => Promise<void>): Promise<void> {
    if (operation) return;
    const controller = new AbortController();
    operation = controller;
    say('');
    activeJob = options.trackJob?.(label === 'Opening the file…' ? 'Opening a file' : label.replace(/…$/, '')) ?? null;
    progress.show(label);
    cancel.disabled = false;
    update();
    let ok = true;
    try {
      await action(controller.signal);
    } catch (error) {
      ok = false;
      say(isAbortError(error) ? 'Cancelled.' : errorMessage(error));
    } finally {
      operation = null;
      activeJob?.finish(status.textContent || (ok ? 'Done.' : 'Stopped.'), ok);
      activeJob = null;
      progress.hide();
      update();
    }
  }

  // Versions -----------------------------------------------------------------
  function pushVersion(version: Version, reset = false): void {
    if (reset) {
      versions = [version];
    } else {
      versions = versions.slice(0, index + 1);
      versions.push(version);
      // Keep the original plus the most recent edits.
      if (versions.length > MAX_VERSIONS) versions.splice(1, versions.length - MAX_VERSIONS);
    }
    index = versions.length - 1;
    showCurrent();
  }

  function showCurrent(): void {
    const version = current();
    const position = player.currentTime;
    player.setSource(version?.blob ?? null);
    if (!version) {
      update();
      return;
    }
    const { audio } = version;
    nameLabel.textContent = name + (index > 0 ? ' · edited' : '');
    metaLabel.textContent = [
      formatClock(audio.duration, true),
      (audio.sampleRate / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 }) + ' kHz',
      audio.channels === 1 ? 'mono' : audio.channels === 2 ? 'stereo' : audio.channels + ' channels',
      'peak ' + dbfs(audio.peak),
      'RMS ' + dbfs(audio.rms),
    ].join(' · ');
    historyLabel.textContent = versions.length > 1 ? `Version ${index + 1} of ${versions.length} · ${version.label}` : '';
    wave.setData(audio.peaks, audio.duration);
    const selection = wave.getSelection();
    if (!selection || selection.end > audio.duration) wave.setSelection(null);
    const time = Math.min(position, audio.duration);
    player.audio.addEventListener('loadedmetadata', () => player.seek(time), { once: true });
    wave.setPlayhead(time);
    if (estimateFor !== version.blob) {
      estimate = null;
      estimateFor = null;
      keyResult.textContent = bpmResult.textContent = '-';
    }
    syncSelectionFields();
    updatePitchLabels();
    updateTime(time);
    update();
  }

  async function setSource(blob: Blob, sourceName: string, signal: AbortSignal, label = 'Original'): Promise<void> {
    progress.show('Reading the waveform…');
    const audio = await inspectEditorAudio(blob, signal);
    signal.throwIfAborted();
    name = sourceName;
    clearStems();
    clearMarkersAndLyrics();
    resetPitch();
    resetEffects();
    pushVersion({ blob, audio, label }, true);
  }

  async function addVersion(blob: Blob, label: string, signal: AbortSignal): Promise<void> {
    progress.show('Reading the waveform…');
    const audio = await inspectEditorAudio(blob, signal);
    signal.throwIfAborted();
    pushVersion({ blob, audio, label });
  }

  async function open(read: () => Promise<File>): Promise<void> {
    await run('Opening the file…', async (signal) => {
      const file = await read();
      const decoded = await sharedMedia().decode(file, job(signal, 'Decoding ' + file.name));
      await setSource(decoded.wav, file.name, signal);
      say(TABS[tab].needsTrack ? `${file.name} is ready.` : `${file.name} is open in the studio.`);
    });
  }

  async function decodeRecording(file: Blob, signal: AbortSignal, label: string): Promise<Blob> {
    const decoded = await sharedMedia().decode(file, job(signal, label));
    return decoded.wav;
  }

  // Controls state -----------------------------------------------------------
  const pitchPending = () => Number(pitch.value) !== 0 || Number(tempo.value) !== 100;
  const effectsPending = () =>
    Number(gain.value) !== 0 || Number(bass.value) !== 0 || Number(treble.value) !== 0 || Number(denoise.value) !== 0 ||
    loudness.value !== '' || ceiling.value !== '' || effectChecks.some((check) => check.checked);

  function update(): void {
    const busy = operation !== null || recording !== null;
    const version = current();
    const needsTrack = TABS[tab].needsTrack;
    drop.classList.toggle('hidden', !needsTrack || !!version);
    dropTitle.textContent = TABS[tab].title;
    dropDesc.textContent = TABS[tab].description;
    trackBox.classList.toggle('hidden', !version);
    exportBox.classList.toggle('hidden', !version);
    for (const panel of panels) {
      const panelTab = panel.dataset.studioPanel as Tab;
      panel.classList.toggle('hidden', panelTab !== tab || (TABS[panelTab].needsTrack && !version));
    }
    useTranscribe.classList.toggle('hidden', !options.getTranscribeFile());
    for (const element of [input, sample, useTranscribe, joinInput, analyzeFiles]) element.disabled = busy;
    cancel.classList.toggle('hidden', !operation);

    undoButton.disabled = busy || index <= 0;
    redoButton.disabled = busy || index >= versions.length - 1;
    revert.disabled = busy || index === 0;
    playButton.disabled = !version || !!recording;

    const pending = pitchPending() || effectsPending();
    pendingNote.classList.toggle('hidden', !pending);
    previewNote.classList.toggle('hidden', !(pitchPending() || Number(gain.value) || Number(bass.value) || Number(treble.value)));
    for (const button of [downloadButton, toTranscribe, toTts]) button.disabled = busy || !version;

    separate.disabled = busy || !version;
    mixDownload.disabled = mixOpen.disabled = stemsZip.disabled = busy || !mixer.stems.length;
    effectsPreview.disabled = busy || !version;
    lyricsRun.disabled = busy || !version;
    batchRun.disabled = busy || !batchItems.some((item) => !item.result);
    batchZip.disabled = busy || !batchItems.some((item) => item.result);
    pitchApply.disabled = busy || !version || !pitchPending();
    pitchReset.disabled = !pitchPending();
    effectsApply.disabled = busy || !version || !effectsPending();
    effectsReset.disabled = !effectsPending();
    const selection = wave.getSelection();
    cutApply.disabled = busy || !version || (!selection && !Number(fadeIn.value) && !Number(fadeOut.value));
    selPlay.disabled = !version || !selection;
    analyze.disabled = busy || !version;
    joinCurrent.disabled = busy || !version;
    joinButton.disabled = busy || joinItems.length < 2;
    recordButton.disabled = busy;
    karaoke.disabled = busy || !version;
    recordStop.classList.toggle('hidden', !recording || !!operation);
    recordCancel.classList.toggle('hidden', !recording || !!operation);
    recordButton.classList.toggle('recording', !!recording);
    takeBox.classList.toggle('hidden', !take);
    mixTake.disabled = takeVoice.disabled = busy || !take;
    if (!version && karaoke.checked) karaoke.checked = false;
  }

  // Tabs ---------------------------------------------------------------------
  function selectTab(next: Tab, focus = false): void {
    tab = next;
    for (const button of tabs) {
      const selected = button.dataset.studioTab === next;
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
      if (selected && focus) button.focus();
    }
    wave.setSelectable(next === 'cutter');
    if (next !== 'cutter') player.range = null;
    if (next !== 'remover' && next !== 'lyrics' && mixer.playing) mixer.pause();
    if (next === 'lyrics') describeLyricSource();
    try { localStorage.setItem(TAB_KEY, next); } catch { /* storage unavailable */ }
    update();
  }

  tabs.forEach((button, position) => {
    button.addEventListener('click', () => selectTab(button.dataset.studioTab as Tab));
    button.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
      event.preventDefault();
      const next = tabs[(position + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      selectTab(next.dataset.studioTab as Tab, true);
    });
  });

  // Transport ----------------------------------------------------------------
  function setPlayIcon(button: HTMLButtonElement, playing: boolean): void {
    button.querySelector('[data-icon="play"]')?.classList.toggle('hidden', playing);
    button.querySelector('[data-icon="pause"]')?.classList.toggle('hidden', !playing);
    button.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  }

  function updateTime(time: number): void {
    const duration = current()?.audio.duration ?? 0;
    const rate = Number(tempo.value) / 100;
    const shown = rate !== 1 ? ` · ${formatClock(duration / rate)} at ${tempo.value}%` : '';
    timeLabel.textContent = `${formatClock(time, true)} / ${formatClock(duration, true)}${shown}`;
  }

  player.onTime = (time) => {
    wave.setPlayhead(time);
    updateTime(time);
  };
  player.onState = (playing) => setPlayIcon(playButton, playing);
  playButton.addEventListener('click', () => {
    if (mixer.playing) mixer.pause();
    void player.toggle().catch((error) => say(errorMessage(error)));
  });

  const zoomFromSlider = () => 200 ** (Number(zoom.value) / 100);
  zoom.addEventListener('input', () => wave.setZoom(zoomFromSlider()));
  $('zoom-in').addEventListener('click', () => wave.setZoom(wave.getZoom() * 1.6));
  $('zoom-out').addEventListener('click', () => wave.setZoom(wave.getZoom() / 1.6));

  undoButton.addEventListener('click', () => {
    if (index <= 0) return;
    index -= 1;
    showCurrent();
    say('Undone: ' + versions[index + 1].label + '.');
  });
  redoButton.addEventListener('click', () => {
    if (index >= versions.length - 1) return;
    index += 1;
    showCurrent();
    say('Redone: ' + versions[index].label + '.');
  });
  revert.addEventListener('click', () => {
    if (!versions.length) return;
    pushVersion({ ...versions[0], label: 'Reverted to original' });
    say('Original audio restored. Undo brings your edits back.');
  });

  // Opening files ------------------------------------------------------------
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    input.value = '';
    if (file) void open(async () => file);
  });
  sample.addEventListener('click', () => void open(options.getSample));
  useTranscribe.addEventListener('click', () => {
    const file = options.getTranscribeFile();
    if (file) void open(async () => file);
  });
  cancel.addEventListener('click', () => {
    operation?.abort();
    cancel.disabled = true;
    progressLabel.textContent = 'Cancelling…';
  });

  // Drag and drop anywhere on the studio.
  let dragDepth = 0;
  root.addEventListener('dragenter', (event) => {
    if (!event.dataTransfer?.types.includes('Files')) return;
    dragDepth += 1;
    root.classList.add('studio-dragging');
  });
  root.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) root.classList.remove('studio-dragging');
  });
  root.addEventListener('dragover', (event) => {
    if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
  });
  root.addEventListener('drop', (event) => {
    if (!event.dataTransfer?.files.length) return;
    event.preventDefault();
    dragDepth = 0;
    root.classList.remove('studio-dragging');
    if (operation || recording) return;
    const files = Array.from(event.dataTransfer.files);
    if (tab === 'joiner') void addJoinFiles(files);
    else if (tab === 'keybpm' && files.length > 1) void analyzeMany(files);
    else void open(async () => files[0]);
  });

  // Rendering with pending settings -------------------------------------------
  function pendingEdit(duration: number): AudioEdit {
    return {
      ...emptyEdit(duration),
      pitch: Number(pitch.value),
      tempo: Number(tempo.value) / 100,
      gain: Number(gain.value),
      bass: Number(bass.value),
      treble: Number(treble.value),
      denoise: Number(denoise.value),
      loudness: loudness.value === '' ? null : Number(loudness.value),
      ceiling: ceiling.value === '' ? null : Number(ceiling.value),
      effects: effectChecks.filter((check) => check.checked).map((check) => check.dataset.effect ?? ''),
    };
  }

  /** The current version with unapplied pitch/effect settings rendered in. */
  async function renderHeard(signal: AbortSignal): Promise<Blob> {
    const version = current();
    if (!version) throw new Error('Open a file first.');
    if (!pitchPending() && !effectsPending()) return version.blob;
    return applyAudioEdit(ffmpeg, version.blob, pendingEdit(version.audio.duration), version.audio, job(signal, 'Rendering your settings'));
  }

  function baseName(): string {
    return name.replace(/\.[^.]+$/, '') || 'audio';
  }

  function outputName(extension: string, suffix = ''): string {
    const edited = index > 0 || pitchPending() || effectsPending();
    return `${baseName()}${suffix || (edited ? '-edited' : '')}.${extension}`;
  }

  downloadButton.addEventListener('click', () => {
    const selected = format.value as AudioFormat;
    void run('Preparing your download…', async (signal) => {
      const blob = await renderHeard(signal);
      const encoded = await sharedMedia().encode(blob, selected, job(signal, `Encoding ${selected.toUpperCase()}`));
      options.download(encoded, outputName(selected));
      say(`Saved ${outputName(selected)}.`);
    });
  });

  function send(action: (file: File) => Promise<void>): void {
    void run('Preparing the audio…', async (signal) => {
      const blob = await renderHeard(signal);
      player.pause();
      await action(new File([blob], outputName('wav'), { type: 'audio/wav' }));
      say('Audio sent.');
    });
  }
  toTranscribe.addEventListener('click', () => send(options.sendToTranscribe));
  toTts.addEventListener('click', () => send(options.sendToTts));

  // Vocal remover ------------------------------------------------------------
  for (const button of stemModeButtons) {
    button.addEventListener('click', () => {
      const mode = button.dataset.stemMode;
      stemMode = mode === 'stems' || mode === 'stems6' ? mode : 'vocals';
      for (const other of stemModeButtons) other.setAttribute('aria-pressed', String(other === button));
      describeSeparation();
    });
  }

  function clearStems(): void {
    mixer.clear();
    stemViews = [];
    stemList.replaceChildren();
    mixerPresets.replaceChildren();
    mixerBox.classList.add('hidden');
  }

  function musicProgress(update: MusicProgress): void {
    if (update.stage === 'download' && update.total) {
      progress.bytes('Downloading the separation model', update.loaded ?? 0, update.total, 'First use only · cached afterwards');
    } else if (update.stage === 'separate' && update.fraction !== undefined) {
      progress.work(update.message, update.fraction, 'AI separation runs on this device');
    } else {
      progress.show(update.message);
    }
  }

  function separationVariant(): MusicModelVariant {
    return ((stemMode === 'stems6' ? '6s-' : '') + modelVariant.value) as MusicModelVariant;
  }

  function describeSeparation(): void {
    const spec = MUSIC_MODEL_VARIANTS[separationVariant()];
    const megabytes = Math.round(spec.bytes / 1_000_000);
    const runs = Number(passes.value);
    separateSize.textContent = `${megabytes} MB download on first use.${runs > 1 ? ` ${runs} passes take ${runs}× longer.` : ''}`;
  }
  modelVariant.addEventListener('change', describeSeparation);
  passes.addEventListener('change', describeSeparation);

  separate.addEventListener('click', () => {
    const version = current();
    if (!version) return;
    const task = stemMode === 'vocals' ? 'vocals' : 'stems';
    const variant = separationVariant();
    const runs = Number(passes.value);
    const label = task === 'vocals' ? 'Removing vocals' : `Splitting into ${MUSIC_MODEL_VARIANTS[variant].stems.length} stems`;
    void run(label + '…', async (signal) => {
      let { blob, audio } = version;
      if (audio.sampleRate !== 44100 || audio.channels !== 2) {
        blob = await prepareEditorAudio(ffmpeg, blob, job(signal, 'Converting to 44.1 kHz stereo'), ['-ar', '44100', '-ac', '2'], audio.duration);
        audio = await inspectEditorAudio(blob, signal);
      }
      player.pause();
      const result = await runMusicTool({ task, variant, blob, audio, passes: runs }, signal, musicProgress);
      signal.throwIfAborted();
      if (result.type !== 'stems') return;
      progress.show('Loading stems for playback…');
      await mixer.load(result.stems);
      renderStems();
      const steps: NextStep[] = [
        { label: 'Change the key of the music', run: () => openMixIn('pitch', (name) => name !== 'Vocals') },
        { label: 'Transcribe the lyrics', run: () => { selectTab('lyrics'); lyricsRun.click(); } },
        { label: 'Download all stems (ZIP)', run: () => stemsZip.click() },
      ];
      say(task === 'vocals'
        ? 'Done. Mute or solo a stem, then download the mix.'
        : `Done. Balance the ${result.stems.length} stems, then download the mix or each stem.`, steps);
    });
  });

  function renderStems(): void {
    stemList.replaceChildren();
    stemViews = [];
    mixerPresets.replaceChildren();
    const duration = mixer.duration;
    mixer.stems.forEach((stem, i) => {
      const row = document.createElement('div');
      row.className = 'stem-row';
      const color = STEM_COLORS[stem.name] ?? '#818cf8';
      row.style.setProperty('--stem-color', color);

      const head = document.createElement('div');
      head.className = 'stem-head';
      const title = document.createElement('p');
      title.className = 'stem-name';
      title.textContent = stem.name;
      const controls = document.createElement('div');
      controls.className = 'flex items-center gap-1';
      const toggle = (label: string, key: 'muted' | 'solo', hint: string) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'stem-toggle';
        button.textContent = label;
        button.title = hint;
        button.setAttribute('aria-label', hint + ' ' + stem.name);
        button.setAttribute('aria-pressed', String(stem[key]));
        button.addEventListener('click', () => {
          stem[key] = !stem[key];
          button.setAttribute('aria-pressed', String(stem[key]));
          mixer.refreshGains();
          refreshStemStates();
        });
        return button;
      };
      const save = document.createElement('button');
      save.type = 'button';
      save.className = 'stem-toggle';
      save.title = 'Download ' + stem.name;
      save.setAttribute('aria-label', 'Download ' + stem.name);
      save.innerHTML = '<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>';
      save.addEventListener('click', () => downloadStems([i]));
      controls.append(toggle('M', 'muted', 'Mute'), toggle('S', 'solo', 'Solo'), save);
      head.append(title, controls);

      const volume = document.createElement('input');
      volume.type = 'range';
      volume.min = '0';
      volume.max = '150';
      volume.value = '100';
      volume.className = 'studio-range stem-volume';
      volume.setAttribute('aria-label', stem.name + ' volume');
      const volumeValue = document.createElement('output');
      volumeValue.className = 'w-10 text-right font-mono text-[10px] text-slate-400';
      volumeValue.textContent = '100%';
      volume.addEventListener('input', () => {
        stem.volume = Number(volume.value) / 100;
        volumeValue.textContent = volume.value + '%';
        mixer.refreshGains();
      });
      const volumeRow = document.createElement('div');
      volumeRow.className = 'flex items-center gap-2';
      volumeRow.append(volume, volumeValue);

      const view = new WaveformView({ height: 52, ruler: false, color, label: stem.name + ' waveform. Click to seek.', onSeek: (time) => mixer.seek(time) });
      view.setData(bufferPeaks(stem.buffer), duration);
      stemViews.push(view);

      const side = document.createElement('div');
      side.className = 'stem-side';
      side.append(head, volumeRow);
      row.append(side, view.element);
      stemList.append(row);
    });

    const preset = (label: string, apply: (name: string) => { muted: boolean; solo: boolean }) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn-ghost';
      button.textContent = label;
      button.addEventListener('click', () => {
        for (const stem of mixer.stems) Object.assign(stem, apply(stem.name));
        for (const row of stemList.querySelectorAll('.stem-row')) {
          const stem = mixer.stems[Array.from(stemList.children).indexOf(row)];
          const [mute, solo] = row.querySelectorAll<HTMLButtonElement>('.stem-toggle');
          mute.setAttribute('aria-pressed', String(stem.muted));
          solo.setAttribute('aria-pressed', String(stem.solo));
        }
        mixer.refreshGains();
        refreshStemStates();
      });
      mixerPresets.append(button);
    };
    preset('Music only', (stemName) => ({ muted: stemName === 'Vocals', solo: false }));
    preset('Vocals only', (stemName) => ({ muted: stemName !== 'Vocals', solo: false }));
    preset('All', () => ({ muted: false, solo: false }));

    mixerBox.classList.remove('hidden');
    mixerTime.textContent = `0:00 / ${formatClock(duration)}`;
    refreshStemStates();
    update();
  }

  function refreshStemStates(): void {
    const gains = mixer.effectiveGains();
    Array.from(stemList.children).forEach((row, i) => row.classList.toggle('stem-silent', gains[i] === 0));
  }

  mixer.onTime = (time) => {
    for (const view of stemViews) view.setPlayhead(time);
    mixerTime.textContent = `${formatClock(time)} / ${formatClock(mixer.duration)}`;
  };
  mixer.onState = (playing) => setPlayIcon(mixerPlay, playing);
  mixerPlay.addEventListener('click', () => {
    player.pause();
    void mixer.toggle();
  });

  function mixName(): string {
    const gains = mixer.effectiveGains();
    const audible = mixer.stems.filter((_, i) => gains[i] > 0).map(({ name: stemName }) => stemName.toLowerCase());
    if (audible.length === mixer.stems.length) return 'mix';
    if (mixer.stems.length === 2 && audible.length === 1) return audible[0] === 'vocals' ? 'vocals' : 'instrumental';
    if (audible.length === mixer.stems.length - 1 && !audible.includes('vocals')) return 'instrumental';
    return audible.join('-');
  }

  async function renderMix(signal: AbortSignal): Promise<Blob> {
    const gains = mixer.effectiveGains();
    const unity = gains.filter((value) => value > 0);
    const soleIndex = gains.findIndex((value) => value > 0);
    if (unity.length === 1 && Math.abs(unity[0] - 1) < 0.001) return mixer.stems[soleIndex].blob;
    return mixStems(ffmpeg, mixer.stems.map((stem, i) => ({ blob: stem.blob, gain: gains[i] })), job(signal, 'Mixing stems'), mixer.duration);
  }

  function downloadStems(indices: number[]): void {
    const selected = format.value as AudioFormat;
    void run('Preparing the stem…', async (signal) => {
      for (const i of indices) {
        const stem = mixer.stems[i];
        const encoded = await sharedMedia().encode(stem.blob, selected, job(signal, `Encoding ${stem.name} as ${selected.toUpperCase()}`));
        options.download(encoded, `${baseName()}-${stem.name.toLowerCase()}.${selected}`);
      }
      say('Stem saved.');
    });
  }

  mixDownload.addEventListener('click', () => {
    const selected = format.value as AudioFormat;
    void run('Preparing the mix…', async (signal) => {
      mixer.pause();
      const blob = await renderMix(signal);
      const encoded = await sharedMedia().encode(blob, selected, job(signal, `Encoding ${selected.toUpperCase()}`));
      const fileName = `${baseName()}-${mixName()}.${selected}`;
      options.download(encoded, fileName);
      say(`Saved ${fileName}.`);
    });
  });
  mixOpen.addEventListener('click', () => {
    void run('Preparing the mix…', async (signal) => {
      mixer.pause();
      const blob = await renderMix(signal);
      const label = 'Stems: ' + mixName();
      // Stems are float WAVs already; mixes come back from FFmpeg as float WAV.
      await addVersion(blob, label, signal);
      say('The mix is now the studio track. Use any tool on it, or undo to go back.');
    });
  });

  // Pitch & tempo ------------------------------------------------------------
  function updatePitchLabels(): void {
    const semitones = Number(pitch.value);
    const rate = Number(tempo.value) / 100;
    pitchValue.textContent = semitones === 0 ? '0 semitones' : `${signed(semitones)} semitone${Math.abs(semitones) === 1 ? '' : 's'}`;
    tempoValue.textContent = `${tempo.value}%`;
    player.setPitch(semitones);
    player.setTempo(rate);
    if (estimate?.key) {
      const shifted = transposeKey(estimate.key, semitones);
      keyLine.textContent = semitones && Math.round(semitones) === semitones
        ? `Key: ${estimate.key} ${estimate.mode ?? ''} → ${shifted} ${estimate.mode ?? ''}`
        : `Key: ${estimate.key} ${estimate.mode ?? ''}${semitones ? ' (between keys)' : ''}`;
    }
    if (estimate?.bpm) {
      bpmLine.textContent = rate === 1 ? `Tempo: ${Math.round(estimate.bpm)} BPM` : `Tempo: ${Math.round(estimate.bpm)} → ${Math.round(estimate.bpm * rate)} BPM`;
    } else {
      bpmLine.textContent = 'Tempo changes keep the pitch.';
    }
    updateTime(player.currentTime);
    update();
  }

  function resetPitch(): void {
    pitch.value = '0';
    tempo.value = '100';
    updatePitchLabels();
  }

  pitch.addEventListener('input', updatePitchLabels);
  tempo.addEventListener('input', updatePitchLabels);
  pitch.addEventListener('dblclick', () => { pitch.value = '0'; updatePitchLabels(); });
  tempo.addEventListener('dblclick', () => { tempo.value = '100'; updatePitchLabels(); });
  pitchReset.addEventListener('click', resetPitch);
  pitchApply.addEventListener('click', () => {
    const version = current();
    if (!version) return;
    const semitones = Number(pitch.value);
    const rate = Number(tempo.value) / 100;
    const edit: AudioEdit = { ...emptyEdit(version.audio.duration), pitch: semitones, tempo: rate };
    void run('Changing pitch and tempo…', async (signal) => {
      const blob = await applyAudioEdit(ffmpeg, version.blob, edit, version.audio, job(signal, 'Rendering pitch and tempo'));
      const parts = [semitones ? `${signed(semitones)} st` : '', rate !== 1 ? `${tempo.value}% tempo` : ''].filter(Boolean);
      const previous = estimate;
      resetPitch();
      await addVersion(blob, 'Pitch ' + parts.join(', '), signal);
      if (previous) {
        estimate = {
          key: previous.key && Math.round(semitones) === semitones ? transposeKey(previous.key, semitones) : null,
          mode: previous.mode,
          bpm: previous.bpm ? previous.bpm * rate : null,
        };
        estimateFor = current()?.blob ?? null;
        showEstimate();
      }
      say('Pitch and tempo applied.', [downloadStep, goTo('keybpm', 'Check key & BPM'), goTo('cutter', 'Trim it')]);
    });
  });
  root.querySelector('[data-studio-detect]')?.addEventListener('click', () => detect());

  // Cutter -------------------------------------------------------------------
  function syncSelectionFields(): void {
    const selection = wave.getSelection();
    const version = current();
    selStart.value = selection ? selection.start.toFixed(2) : '';
    selEnd.value = selection ? selection.end.toFixed(2) : '';
    selStart.placeholder = '0.00';
    selEnd.placeholder = version ? version.audio.duration.toFixed(2) : '';
    selLength.textContent = selection ? formatClock(selection.end - selection.start, true) : '-';
    if (selection && player.range) player.range = { ...selection, loop: selLoop.checked };
    describeCut();
    update();
  }

  function describeCut(): void {
    const version = current();
    if (!version) return;
    const selection = wave.getSelection();
    const fades = [Number(fadeIn.value) ? `fade in ${fadeIn.value}s` : '', Number(fadeOut.value) ? `fade out ${fadeOut.value}s` : ''].filter(Boolean);
    if (!selection) {
      cutSummary.textContent = fades.length ? `Applies ${fades.join(' and ')} to the whole track.` : 'Select a region on the waveform.';
      return;
    }
    const length = selection.end - selection.start;
    const result = cutMode === 'keep' ? length : version.audio.duration - length;
    cutSummary.textContent = result < 0.05
      ? 'Nothing would be left. Adjust the selection or switch between Keep and Delete.'
      : `Result: ${formatClock(result, true)}${fades.length ? ' with ' + fades.join(' and ') : ''}.`;
  }

  function fieldSelection(): void {
    const version = current();
    if (!version) return;
    const start = Number.isFinite(selStart.valueAsNumber) ? selStart.valueAsNumber : 0;
    const end = Number.isFinite(selEnd.valueAsNumber) ? selEnd.valueAsNumber : version.audio.duration;
    wave.setSelection({ start: Math.max(0, start), end: Math.min(version.audio.duration, end) });
    wave.reveal(start);
    syncSelectionFields();
  }
  selStart.addEventListener('change', fieldSelection);
  selEnd.addEventListener('change', fieldSelection);
  selAll.addEventListener('click', () => {
    const version = current();
    if (!version) return;
    wave.setSelection({ start: 0, end: version.audio.duration });
    syncSelectionFields();
  });
  selPlay.addEventListener('click', () => {
    const selection = wave.getSelection();
    if (!selection) return;
    mixer.pause();
    player.range = { ...selection, loop: selLoop.checked };
    player.seek(selection.start);
    void player.play().catch((error) => say(errorMessage(error)));
  });
  selLoop.addEventListener('change', () => {
    if (player.range) player.range.loop = selLoop.checked;
  });
  for (const button of cutModeButtons) {
    button.addEventListener('click', () => {
      cutMode = button.dataset.cutMode === 'remove' ? 'remove' : 'keep';
      for (const other of cutModeButtons) other.setAttribute('aria-pressed', String(other === button));
      describeCut();
    });
  }
  const fadeLabel = (input: HTMLInputElement, output: HTMLElement) => {
    output.textContent = Number(input.value) ? `${Number(input.value).toFixed(1)} s` : 'Off';
    describeCut();
    update();
  };
  fadeIn.addEventListener('input', () => fadeLabel(fadeIn, $('fade-in-value')));
  fadeOut.addEventListener('input', () => fadeLabel(fadeOut, $('fade-out-value')));
  cutApply.addEventListener('click', () => {
    const version = current();
    if (!version) return;
    const selection = wave.getSelection();
    // Deleting (nearly) everything would leave no audio. Say so instead of
    // failing with "This file contains no playable audio."
    if (selection && cutMode === 'remove' && version.audio.duration - (selection.end - selection.start) < 0.05) {
      cutSummary.textContent = 'This would delete the whole track. Leave some audio unselected, or use Revert to original.';
      return;
    }
    if (selection && cutMode === 'keep' && selection.end - selection.start < 0.05) {
      cutSummary.textContent = 'The selection is too short to keep. Drag across the waveform to select a longer part.';
      return;
    }
    const edit: AudioEdit = {
      ...emptyEdit(version.audio.duration),
      cut: selection ? cutMode : 'none',
      start: selection?.start ?? 0,
      end: selection?.end ?? version.audio.duration,
      fadeIn: Number(fadeIn.value),
      fadeOut: Number(fadeOut.value),
    };
    void run('Cutting…', async (signal) => {
      const blob = await applyAudioEdit(ffmpeg, version.blob, edit, version.audio, job(signal, 'Rendering the cut'));
      const label = selection ? (cutMode === 'keep' ? 'Trimmed' : 'Deleted a section') : 'Fades';
      player.range = null;
      wave.setSelection(null);
      fadeIn.value = fadeOut.value = '0';
      fadeLabel(fadeIn, $('fade-in-value'));
      fadeLabel(fadeOut, $('fade-out-value'));
      await addVersion(blob, label, signal);
      say('Cut applied. Undo with Ctrl+Z.', [downloadStep, { label: 'Join with another track', run: () => { selectTab('joiner'); joinCurrent.click(); } }, goTo('effects', 'Add effects')]);
    });
  });

  // Effects ------------------------------------------------------------------
  const effectLabels: [HTMLInputElement, string, (value: number) => string][] = [
    [gain, 'gain-value', (value) => `${signed(value)} dB`.replace(/^0 dB$/, '0 dB')],
    [bass, 'bass-value', (value) => `${signed(value)} dB`],
    [treble, 'treble-value', (value) => `${signed(value)} dB`],
    [denoise, 'denoise-value', (value) => (value ? `${value} dB` : 'Off')],
  ];
  function updateEffects(): void {
    for (const [control, id, describe] of effectLabels) $(id).textContent = describe(Number(control.value));
    player.setTone({ gain: Number(gain.value), bass: Number(bass.value), treble: Number(treble.value) });
    const on = (name: string) => effectChecks.some((check) => check.checked && check.dataset.effect === name);
    player.setFilters({ rumble: on('rumble'), voice: on('voice'), reverb: on('reverb'), mono: on('mono') });
    update();
  }
  function resetEffects(): void {
    gain.value = bass.value = treble.value = denoise.value = '0';
    loudness.value = ceiling.value = '';
    for (const check of effectChecks) check.checked = false;
    updateEffects();
  }
  for (const control of [gain, bass, treble, denoise]) {
    control.addEventListener('input', updateEffects);
    control.addEventListener('dblclick', () => { control.value = '0'; updateEffects(); });
  }
  for (const control of [loudness, ceiling, ...effectChecks]) control.addEventListener('change', updateEffects);
  effectsReset.addEventListener('click', resetEffects);
  effectsApply.addEventListener('click', () => {
    const version = current();
    if (!version) return;
    const full = pendingEdit(version.audio.duration);
    const edit: AudioEdit = { ...full, pitch: 0, tempo: 1 };
    void run('Applying effects…', async (signal) => {
      const blob = await applyAudioEdit(ffmpeg, version.blob, edit, version.audio, job(signal, 'Rendering effects'));
      resetEffects();
      await addVersion(blob, 'Effects', signal);
      const peak = current()?.audio.peak ?? 0;
      say(peak > 1 ? 'Effects applied. Peaks go above 0 dBFS and may clip; try the peak limiter.' : 'Effects applied.', [downloadStep, { label: 'Transcribe it', run: () => toTranscribe.click() }]);
    });
  });

  // Joiner -------------------------------------------------------------------
  function renderJoin(): void {
    joinTimeline.replaceChildren();
    if (!joinItems.length) {
      const empty = document.createElement('p');
      empty.className = 'join-empty';
      empty.textContent = 'Add two or more tracks. Drag them to change the order.';
      joinTimeline.append(empty);
    }
    const fade = Number(crossfade.value);
    joinItems.forEach((item, position) => {
      const length = Math.max(0, item.duration - item.trimStart - item.trimEnd);
      const clip = document.createElement('div');
      clip.className = 'join-clip';
      clip.draggable = true;
      clip.style.width = `${Math.max(180, Math.min(520, length * 6))}px`;
      clip.dataset.id = String(item.id);
      clip.innerHTML = `
        <div class="flex items-start justify-between gap-2">
          <span class="join-index">${position + 1}</span>
          <div class="min-w-0 flex-1"><p class="truncate text-xs font-medium text-white"></p><p class="join-length font-mono text-[10px] text-slate-400"></p></div>
          <div class="flex gap-0.5">
            <button type="button" class="stem-toggle" data-move="-1" aria-label="Move earlier">←</button>
            <button type="button" class="stem-toggle" data-move="1" aria-label="Move later">→</button>
            <button type="button" class="stem-toggle" data-remove aria-label="Remove">✕</button>
          </div>
        </div>
        <div class="mt-2 grid grid-cols-2 gap-2">
          <label class="text-[10px] text-slate-400">Trim start (s)<input type="number" min="0" step="0.1" class="select mt-0.5 py-1 text-xs" data-trim="start" /></label>
          <label class="text-[10px] text-slate-400">Trim end (s)<input type="number" min="0" step="0.1" class="select mt-0.5 py-1 text-xs" data-trim="end" /></label>
        </div>`;
      clip.querySelector('p')!.textContent = item.name;
      clip.querySelector('.join-length')!.textContent = `${formatClock(length, true)}${item.trimStart || item.trimEnd ? ` of ${formatClock(item.duration)}` : ''}`;
      const [trimStart, trimEnd] = clip.querySelectorAll<HTMLInputElement>('[data-trim]');
      trimStart.value = String(item.trimStart);
      trimEnd.value = String(item.trimEnd);
      for (const field of [trimStart, trimEnd]) {
        field.addEventListener('change', () => {
          const value = Math.max(0, Number(field.value) || 0);
          if (field.dataset.trim === 'start') item.trimStart = Math.min(value, item.duration - item.trimEnd - 0.1);
          else item.trimEnd = Math.min(value, item.duration - item.trimStart - 0.1);
          renderJoin();
        });
      }
      clip.querySelectorAll<HTMLButtonElement>('[data-move]').forEach((button) => {
        const target = position + Number(button.dataset.move);
        button.disabled = target < 0 || target >= joinItems.length;
        button.addEventListener('click', () => {
          [joinItems[position], joinItems[target]] = [joinItems[target], joinItems[position]];
          renderJoin();
        });
      });
      clip.querySelector('[data-remove]')!.addEventListener('click', () => {
        joinItems.splice(position, 1);
        renderJoin();
      });
      clip.addEventListener('dragstart', (event) => {
        event.dataTransfer?.setData('text/x-join', String(item.id));
        clip.classList.add('dragging');
      });
      clip.addEventListener('dragend', () => clip.classList.remove('dragging'));
      clip.addEventListener('dragover', (event) => {
        if (event.dataTransfer?.types.includes('text/x-join')) event.preventDefault();
      });
      clip.addEventListener('drop', (event) => {
        const id = Number(event.dataTransfer?.getData('text/x-join'));
        if (!id) return;
        event.preventDefault();
        event.stopPropagation();
        const from = joinItems.findIndex((entry) => entry.id === id);
        if (from < 0 || from === position) return;
        const [moved] = joinItems.splice(from, 1);
        joinItems.splice(position, 0, moved);
        renderJoin();
      });
      joinTimeline.append(clip);
      if (fade > 0 && position < joinItems.length - 1) {
        const marker = document.createElement('span');
        marker.className = 'join-fade';
        marker.textContent = `${fade.toFixed(1)}s`;
        marker.title = 'Crossfade';
        joinTimeline.append(marker);
      }
    });
    const lengths = joinItems.map((item) => Math.max(0, item.duration - item.trimStart - item.trimEnd));
    const total = lengths.reduce((sum, value) => sum + value, 0) - (joinItems.length > 1 ? fade * (joinItems.length - 1) : 0);
    joinTotal.textContent = joinItems.length ? `${joinItems.length} tracks · about ${formatClock(Math.max(0, total))} total` : '';
    update();
  }

  async function addJoinFiles(files: File[]): Promise<void> {
    await run('Reading tracks…', async (signal) => {
      for (const [i, file] of files.entries()) {
        progress.work(`Reading ${file.name}`, i / files.length);
        const duration = await mediaDuration(file, signal);
        joinItems.push({ id: ++joinId, name: file.name, blob: file, duration, trimStart: 0, trimEnd: 0 });
      }
      renderJoin();
      say(joinItems.length < 2 ? 'Add at least one more track.' : 'Arrange the tracks, then join them.');
    });
  }

  joinInput.addEventListener('change', () => {
    const files = Array.from(joinInput.files ?? []);
    joinInput.value = '';
    if (files.length) void addJoinFiles(files);
  });
  joinCurrent.addEventListener('click', () => {
    const version = current();
    if (!version) return;
    joinItems.push({ id: ++joinId, name: name + (index > 0 ? ' (edited)' : ''), blob: version.blob, duration: version.audio.duration, trimStart: 0, trimEnd: 0 });
    renderJoin();
  });
  crossfade.addEventListener('input', () => {
    $('crossfade-value').textContent = Number(crossfade.value) ? `${Number(crossfade.value).toFixed(1)} s` : 'Off';
    renderJoin();
  });
  joinButton.addEventListener('click', () => {
    const clips = joinItems.map(({ blob, duration, trimStart, trimEnd }) => ({ blob, duration, trimStart, trimEnd }));
    const fade = Number(crossfade.value);
    void run('Joining tracks…', async (signal) => {
      const blob = await joinAudio(ffmpeg, clips, fade, job(signal, `Joining ${clips.length} tracks`));
      await setSource(blob, 'joined.wav', signal, 'Joined');
      say('Joined. The result is now the studio track.', [downloadStep, goTo('effects', 'Normalize loudness'), goTo('cutter', 'Trim it')]);
    });
  });

  // Key & BPM ----------------------------------------------------------------
  function describeEstimate({ bpm, key, mode }: MusicEstimate): string {
    return `${key ? `${key} ${mode}` : 'Key unclear'} · ${bpm ? Math.round(bpm) + ' BPM' : 'tempo unclear'}`;
  }

  function showEstimate(): void {
    keyResult.textContent = estimate?.key ? `${estimate.key} ${estimate.mode === 'minor' ? 'min' : 'maj'}` : '-';
    bpmResult.textContent = estimate?.bpm ? `${Math.round(estimate.bpm)}` : '-';
    if (!estimate) keyLine.innerHTML = 'Original key unknown. <button type="button" class="text-indigo-300 underline-offset-2 hover:underline" data-studio-detect>Detect key &amp; BPM</button>';
    keyLine.querySelector('[data-studio-detect]')?.addEventListener('click', () => detect());
    if (estimate && !estimate.key) keyLine.textContent = 'Key could not be detected.';
    updatePitchLabels();
  }

  function detect(): void {
    const version = current();
    if (!version) return;
    void run('Listening for key and tempo…', async (signal) => {
      progress.show('Analyzing key and tempo', 'Runs on this device');
      const result = await runMusicTool({ task: 'analyze', blob: version.blob, audio: version.audio }, signal, () => {});
      if (result.type !== 'estimate') return;
      estimate = result.estimate;
      estimateFor = version.blob;
      showEstimate();
      say(describeEstimate(result.estimate) + '.');
    });
  }
  analyze.addEventListener('click', detect);

  async function analyzeMany(files: File[]): Promise<void> {
    analysisResults.replaceChildren();
    await run('Analyzing files…', async (signal) => {
      for (const file of files) {
        const row = document.createElement('li');
        row.className = 'flex justify-between gap-2 rounded-lg border border-white/10 px-2 py-1.5';
        const label = document.createElement('span');
        label.className = 'min-w-0 truncate';
        label.textContent = file.name;
        const value = document.createElement('span');
        value.className = 'shrink-0 font-mono text-slate-400';
        value.textContent = 'Waiting…';
        row.append(label, value);
        analysisResults.append(row);
      }
      for (const [i, file] of files.entries()) {
        const value = analysisResults.children[i].lastElementChild as HTMLElement;
        try {
          progress.work(`Analyzing ${file.name}`, i / files.length, `${i + 1} of ${files.length}`);
          value.textContent = 'Analyzing…';
          const blob = await prepareEditorAudio(ffmpeg, file, { signal }, ['-t', '90']);
          const audio = await inspectEditorAudio(blob, signal);
          const result = await runMusicTool({ task: 'analyze', blob, audio }, signal, () => {});
          if (result.type === 'estimate') value.textContent = describeEstimate(result.estimate);
        } catch (error) {
          value.textContent = isAbortError(error) ? 'Cancelled' : 'Could not read';
          signal.throwIfAborted();
        }
      }
      say('Analysis finished.');
    });
  }
  analyzeFiles.addEventListener('change', () => {
    const files = Array.from(analyzeFiles.files ?? []);
    analyzeFiles.value = '';
    if (files.length) void analyzeMany(files);
  });

  tap.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    const now = performance.now();
    if (taps.length && now - taps[taps.length - 1] > 2500) taps.length = 0;
    taps.push(now);
    if (taps.length > 12) taps.shift();
    const bpm = tappedTempo(taps);
    tapResult.textContent = bpm === null ? 'Keep tapping…' : `${bpm.toFixed(1)} BPM`;
    tap.classList.remove('tap-flash');
    void tap.offsetWidth;
    tap.classList.add('tap-flash');
  });
  tapReset.addEventListener('click', () => {
    taps.length = 0;
    tapResult.textContent = 'Tap along to the beat.';
  });

  // Recorder & karaoke -------------------------------------------------------
  function startRecording(): void {
    const backing = karaoke.checked ? current() : null;
    const capture = { backing, offset: 0 };
    recording = capture;
    take = null;
    void run('Opening the microphone…', async () => {
      try {
        let elapsed = 0;
        player.pause();
        mixer.pause();
        await recorder.start((state) => {
          elapsed = state.elapsed;
          recordTime.textContent = formatClock(state.elapsed);
          recordLevel.style.width = `${Math.min(100, state.level * 140)}%`;
        }, 'music');
        if (backing) {
          player.range = null;
          player.seek(0);
          await player.play();
          capture.offset = player.currentTime - elapsed;
        }
        say(backing ? 'Recording over the studio track. Press Stop when you are done.' : 'Recording. Press Stop when you are done.');
      } catch (error) {
        recording = null;
        recordTime.textContent = '0:00';
        recorder.cancel();
        throw error;
      }
    });
  }

  recordButton.addEventListener('click', () => {
    if (recording) recordStop.click();
    else startRecording();
  });
  recordStop.addEventListener('click', () => {
    const capture = recording;
    if (!capture) return;
    void run('Finishing the recording…', async (signal) => {
      player.pause();
      try {
        const voice = await recorder.stop();
        if (capture.backing) {
          take = { backing: capture.backing, voice, offset: capture.offset };
          say('Take recorded. Balance it below, then mix.');
        } else {
          const blob = await decodeRecording(voice, signal, 'Decoding the recording');
          await setSource(blob, voice.name, signal, 'Recording');
          say('Recording opened in the studio.', [goTo('effects', 'Remove noise'), { label: 'Transcribe it', run: () => toTranscribe.click() }, downloadStep]);
        }
      } finally {
        recording = null;
        recordLevel.style.width = '0';
      }
    });
  });
  recordCancel.addEventListener('click', () => {
    recorder.cancel();
    player.pause();
    recording = null;
    recordTime.textContent = '0:00';
    recordLevel.style.width = '0';
    say('Recording discarded.');
    update();
  });
  const takeLabels: [string, (value: number) => string][] = [
    ['backing-gain', (value) => `${signed(value)} dB`],
    ['vocal-gain', (value) => `${signed(value)} dB`],
    ['vocal-pitch', (value) => `${signed(value)} st`],
    ['vocal-offset', (value) => `${signed(value)} ms`],
  ];
  for (const [id, describe] of takeLabels) {
    const control = $<HTMLInputElement>(id);
    control.addEventListener('input', () => { $(id + '-value').textContent = describe(Number(control.value)); });
  }
  mixTake.addEventListener('click', () => {
    if (!take) return;
    const captured = take;
    const setting = (id: string) => Number($<HTMLInputElement>(id).value);
    void run('Mixing your take…', async (signal) => {
      const blob = await mixKaraoke(ffmpeg, captured.backing.blob, captured.voice, {
        offset: captured.offset + setting('vocal-offset') / 1000,
        backingGain: setting('backing-gain'),
        voiceGain: setting('vocal-gain'),
        voicePitch: setting('vocal-pitch'),
      }, job(signal, 'Mixing voice and backing'), captured.backing.audio.duration);
      take = null;
      await setSource(blob, 'karaoke-mix.wav', signal, 'Karaoke mix');
      say('Karaoke mix is now the studio track.');
    });
  });
  takeVoice.addEventListener('click', () => {
    if (!take) return;
    const voice = take.voice;
    void run('Opening your voice…', async (signal) => {
      const blob = await decodeRecording(voice, signal, 'Decoding the recording');
      take = null;
      await setSource(blob, voice.name, signal, 'Recording');
      say('Voice recording opened in the studio.');
    });
  });

  // Keyboard -----------------------------------------------------------------
  document.addEventListener('keydown', (event) => {
    if (root.classList.contains('hidden')) return;
    const target = event.target as HTMLElement;
    const typing = target.closest('input:not([type="range"]):not([type="checkbox"]), textarea, select, [contenteditable="true"]');
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key.toLowerCase() === 'z' && !typing) {
      event.preventDefault();
      (event.shiftKey ? redoButton : undoButton).click();
      return;
    }
    if (mod && event.key.toLowerCase() === 'y' && !typing) {
      event.preventDefault();
      redoButton.click();
      return;
    }
    if (typing || mod || !current()) return;
    if (event.key === ' ' && !target.closest('button')) {
      event.preventDefault();
      if (tab === 'remover' && mixer.stems.length) mixerPlay.click();
      else playButton.click();
    } else if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && target.closest('.waveform-scroller')) {
      event.preventDefault();
      const step = (event.shiftKey ? 1 : 5) * (event.key === 'ArrowLeft' ? -1 : 1);
      player.seek(player.currentTime + step);
    } else if (event.key === 'Home' && target.closest('.waveform-scroller')) {
      event.preventDefault();
      player.seek(0);
    } else if (event.key === 'm' || event.key === 'M') {
      event.preventDefault();
      addMarker(player.currentTime);
    } else if (event.key === '[' || event.key === ']') {
      event.preventDefault();
      jumpMarker(event.key === ']' ? 1 : -1);
    } else if (event.key === 'r' || event.key === 'R') {
      event.preventDefault();
      selectBetweenMarkers(player.currentTime);
    }
  });

  // Markers ------------------------------------------------------------------
  function renderMarkers(): void {
    wave.setMarkers(markers);
    markersLabel.textContent = markers.length ? `${markers.length} marker${markers.length === 1 ? '' : 's'}` : '';
    markersLabel.classList.toggle('hidden', !markers.length);
    markersClear.classList.toggle('hidden', !markers.length);
  }

  function addMarker(time: number): void {
    if (!current() || markers.some((marker) => Math.abs(marker - time) < 0.05)) return;
    markers = [...markers, time].sort((a, b) => a - b);
    renderMarkers();
    say(`Marker ${markers.indexOf(time) + 1} at ${formatClock(time, true)}. Press R to select the part around the playhead.`);
  }

  function jumpMarker(direction: 1 | -1): void {
    const version = current();
    if (!version) return;
    const now = player.currentTime;
    const candidates = direction > 0 ? markers.filter((marker) => marker > now + 0.05) : markers.filter((marker) => marker < now - 0.05).reverse();
    player.seek(candidates[0] ?? (direction > 0 ? version.audio.duration : 0));
  }

  function selectBetweenMarkers(time: number): void {
    const version = current();
    if (!version) return;
    const start = Math.max(0, ...markers.filter((marker) => marker <= time));
    const end = Math.min(version.audio.duration, ...markers.filter((marker) => marker > time));
    if (tab !== 'cutter') selectTab('cutter');
    wave.setSelection({ start, end });
    syncSelectionFields();
    say(`Selected ${formatClock(start, true)} → ${formatClock(end, true)}.`, [
      { label: 'Play it', run: () => selPlay.click() },
      { label: 'Loop it', run: () => { selLoop.checked = true; selPlay.click(); } },
    ]);
  }

  function clearMarkersAndLyrics(): void {
    markers = [];
    lyrics = [];
    renderMarkers();
    renderLyrics();
  }

  markersClear.addEventListener('click', () => {
    markers = [];
    renderMarkers();
  });
  wave.element.addEventListener('dblclick', (event) => {
    if (!current()) return;
    selectBetweenMarkers(wave.timeAtClientX(event.clientX));
  });

  // Stems to other tools, and ZIP --------------------------------------------
  function openMixIn(tool: Tab, keep: (name: string) => boolean): void {
    if (!mixer.stems.length) return;
    for (const stem of mixer.stems) {
      stem.muted = !keep(stem.name);
      stem.solo = false;
    }
    mixer.refreshGains();
    refreshStemStates();
    stemList.querySelectorAll<HTMLButtonElement>('.stem-toggle[aria-pressed]').forEach((button, i) => {
      const stem = mixer.stems[Math.floor(i / 2)];
      button.setAttribute('aria-pressed', String(i % 2 === 0 ? stem.muted : stem.solo));
    });
    selectTab(tool);
    mixOpen.click();
  }

  stemsZip.addEventListener('click', () => {
    const selected = format.value as AudioFormat;
    void run('Packing stems…', async (signal) => {
      mixer.pause();
      const files: { name: string; blob: Blob }[] = [];
      for (const [i, stem] of mixer.stems.entries()) {
        const encoded = await sharedMedia().encode(stem.blob, selected, job(signal, `Encoding ${stem.name} (${i + 1} of ${mixer.stems.length})`));
        files.push({ name: `${baseName()}-${stem.name.toLowerCase()}.${selected}`, blob: encoded });
      }
      progress.show('Writing the ZIP file');
      options.download(await createZip(files), `${baseName()}-stems.zip`);
      say(`Saved ${files.length} stems in ${baseName()}-stems.zip.`);
    });
  });

  // Rendered effects preview --------------------------------------------------
  let previewPlayer: HTMLAudioElement | null = null;
  effectsPreview.addEventListener('click', () => {
    const version = current();
    if (!version) return;
    const from = Math.max(0, Math.min(player.currentTime, version.audio.duration - 10));
    void run('Rendering a preview…', async (signal) => {
      player.pause();
      const previewDuration = Math.min(10, Math.max(0, version.audio.duration - from));
      if (!(previewDuration > 0)) throw new Error('Move the playhead somewhere with audio first.');
      const edit = { ...pendingEdit(previewDuration), cut: 'none' as const, start: 0, end: previewDuration };
      let rendered: Blob;
      if (canRenderFast(edit) && version.blob.size <= 200_000_000) {
        const slice = await sliceFloatWav(version.blob, from, previewDuration, { signal });
        rendered = await renderFastEdit(slice, edit, job(signal, 'Rendering effects'));
      } else {
        const slice = await prepareEditorAudio(ffmpeg, version.blob, job(signal, 'Cutting 10 seconds'), ['-ss', from.toFixed(3), '-t', '10']);
        const audio = await inspectEditorAudio(slice, signal);
        rendered = await applyAudioEdit(ffmpeg, slice, pendingEdit(audio.duration), audio, job(signal, 'Rendering effects'));
      }
      previewPlayer?.pause();
      if (previewPlayer?.src) URL.revokeObjectURL(previewPlayer.src);
      previewPlayer = new Audio(URL.createObjectURL(rendered));
      await previewPlayer.play().catch(() => undefined);
      say(`Playing the rendered preview from ${formatClock(from)}.`, [
        { label: 'Stop preview', run: () => previewPlayer?.pause() },
        { label: 'Apply effects', run: () => effectsApply.click() },
      ]);
    });
  });

  // Lyrics -------------------------------------------------------------------
  function lyricSource(): { blob: Blob; label: string } | null {
    const vocals = mixer.stems.find((stem) => stem.name === 'Vocals');
    if (vocals) return { blob: vocals.blob, label: 'Using the separated vocals.' };
    const version = current();
    return version ? { blob: version.blob, label: 'Using the full track. Separate the vocals first for cleaner lyrics.' } : null;
  }

  function describeLyricSource(): void {
    const source = lyricSource();
    const model = options.modelName?.();
    lyricsSource.textContent = source ? `${source.label}${model ? ` Model: ${model}.` : ''}` : '';
  }

  function renderLyrics(): void {
    lyricsList.replaceChildren(...lyrics.map((line, index) => {
      const item = document.createElement('li');
      item.className = 'lyrics-line';
      item.dataset.index = String(index);
      const stamp = document.createElement('time');
      stamp.textContent = formatClock(line.start);
      const text = document.createElement('span');
      if (line.words?.length) {
        line.words.forEach((word, i) => {
          const span = document.createElement('span');
          span.className = 'lyrics-word';
          span.textContent = (i ? ' ' : '') + word.text.trim();
          text.append(span);
        });
      } else {
        text.textContent = line.text;
      }
      item.append(stamp, text);
      item.addEventListener('click', () => {
        if (mixer.playing) mixer.seek(line.start);
        else player.seek(line.start);
      });
      return item;
    }));
    const words = lyrics.flatMap((line) => line.words?.length
      ? line.words.map((word) => ({ time: word.start, text: word.text.trim() }))
      : [{ time: line.start, text: line.text }]);
    wave.setLabels(words);
    lyricsLrc.disabled = lyricsSrt.disabled = !lyrics.length;
    activeLine = -1;
    describeLyricSource();
  }

  let activeLine = -1;
  function followLyrics(time: number): void {
    if (!lyrics.length) {
      karaokeLyrics.classList.add('hidden');
      return;
    }
    let index = -1;
    for (let i = 0; i < lyrics.length; i += 1) if (lyrics[i].start <= time + 0.05) index = i;
    if (index !== activeLine) {
      lyricsList.querySelector('.lyrics-line.active')?.classList.remove('active');
      const item = lyricsList.children[index] as HTMLElement | undefined;
      item?.classList.add('active');
      if (item && tab === 'lyrics') item.scrollIntoView({ block: 'nearest' });
      activeLine = index;
    }
    const line = lyrics[index];
    if (line?.words?.length) {
      const spans = lyricsList.children[index]?.querySelectorAll('.lyrics-word');
      line.words.forEach((word, i) => spans?.[i]?.classList.toggle('sung', word.start <= time));
    }
    const showKaraoke = tab === 'record' && karaoke.checked;
    karaokeLyrics.classList.toggle('hidden', !showKaraoke);
    if (showKaraoke) {
      const now = line?.text ?? '…';
      const next = lyrics[index + 1]?.text ?? '';
      if (karaokeLyrics.dataset.line !== String(index)) {
        karaokeLyrics.dataset.line = String(index);
        karaokeLyrics.innerHTML = '<p class="now"></p><p class="next"></p>';
        karaokeLyrics.querySelector('.now')!.textContent = now;
        karaokeLyrics.querySelector('.next')!.textContent = next;
      }
    }
  }

  const trackTime = player.onTime;
  player.onTime = (time) => {
    trackTime?.(time);
    followLyrics(time);
  };
  const mixerTimeHandler = mixer.onTime;
  mixer.onTime = (time) => {
    mixerTimeHandler?.(time);
    followLyrics(time);
  };
  karaoke.addEventListener('change', () => followLyrics(player.currentTime));

  lyricsRun.addEventListener('click', () => {
    const source = lyricSource();
    if (!source) return;
    if (!options.transcribe) {
      say('Lyrics need the Audio to text tool, which is not available here.');
      return;
    }
    const transcribe = options.transcribe;
    void run('Transcribing lyrics…', async (signal) => {
      player.pause();
      mixer.pause();
      const file = new File([source.blob], 'vocals.wav', { type: 'audio/wav' });
      lyrics = splitLyricLines(await transcribe(file, signal, (fraction, message) => progress.work(message, fraction, options.modelName?.() ?? '')));
      renderLyrics();
      say(lyrics.length ? `Found ${lyrics.length} line${lyrics.length === 1 ? '' : 's'}. Play the track to follow along.` : 'No words were recognized.', lyrics.length ? [
        { label: 'Sing along (karaoke)', run: () => { karaoke.checked = true; selectTab('record'); followLyrics(player.currentTime); } },
        { label: 'Save .lrc', run: () => lyricsLrc.click() },
      ] : []);
    });
  });

  lyricsLrc.addEventListener('click', () => {
    const stamp = (seconds: number) => {
      const minutes = Math.floor(seconds / 60);
      return `[${String(minutes).padStart(2, '0')}:${(seconds - minutes * 60).toFixed(2).padStart(5, '0')}]`;
    };
    const text = lyrics.map((line) => `${stamp(line.start)}${line.text}`).join('\n') + '\n';
    options.download(new Blob([text], { type: 'text/plain;charset=utf-8' }), `${baseName()}.lrc`);
  });
  lyricsSrt.addEventListener('click', () => {
    options.download(new Blob([toSrt(lyrics)], { type: 'application/x-subrip;charset=utf-8' }), `${baseName()}.srt`);
  });

  // Batch --------------------------------------------------------------------
  const BATCH_SUFFIX: Record<string, string> = {
    convert: '', normalize: '-normalized', effects: '-effects', pitch: '-pitch', 'trim-silence': '-trimmed', instrumental: '-instrumental', vocals: '-vocals',
  };

  function renderBatch(): void {
    batchList.replaceChildren(...batchItems.map((item, index) => {
      const row = document.createElement('li');
      row.className = 'batch-row';
      const name = document.createElement('span');
      name.className = 'min-w-0 truncate';
      name.textContent = item.file.name;
      const state = document.createElement('span');
      state.className = 'text-[11px] text-slate-400';
      state.textContent = item.status;
      const actions = document.createElement('span');
      actions.className = 'flex gap-1';
      if (item.result) {
        const save = document.createElement('button');
        save.type = 'button';
        save.className = 'stem-toggle';
        save.textContent = 'Save';
        save.addEventListener('click', () => options.download(item.result!, item.name));
        actions.append(save);
      }
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'stem-toggle';
      remove.textContent = '✕';
      remove.setAttribute('aria-label', 'Remove ' + item.file.name);
      remove.disabled = operation !== null;
      remove.addEventListener('click', () => {
        batchItems.splice(index, 1);
        renderBatch();
      });
      actions.append(remove);
      const track = document.createElement('div');
      track.className = 'progress-track';
      const bar = document.createElement('div');
      bar.className = 'progress-bar';
      bar.style.width = `${Math.round(item.fraction * 100)}%`;
      track.append(bar);
      row.append(name, state, actions, track);
      return row;
    }));
    batchRun.disabled = operation !== null || !batchItems.some((item) => !item.result);
    batchZip.disabled = operation !== null || !batchItems.some((item) => item.result);
    batchClear.disabled = operation !== null || !batchItems.length;
  }

  async function processBatchItem(item: BatchItem, op: string, signal: AbortSignal, report: (fraction: number) => void): Promise<Blob> {
    const selected = format.value as AudioFormat;
    const spec = AUDIO_FORMATS[selected];
    const step = (from: number, span: number): JobOptions => ({
      signal,
      onProgress: ({ ratio }) => report(from + span * (ratio ?? 0)),
    });
    if (op === 'convert') return sharedMedia().encode(item.file, selected, step(0, 1));
    if (op === 'trim-silence') {
      try {
        return await trimSilenceFile(item.file, selected, step(0, 1));
      } catch (error) {
        if (isAbortError(error)) throw error;
        console.warn('Fast trim-silence unavailable; using FFmpeg.', error);
      }
      const gate = 'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.1';
      return ffmpeg.run(item.file, ['-i', 'input.media', '-map', '0:a:0', '-vn', '-af', `${gate},areverse,${gate},areverse`, ...spec.args, `output.${selected}`], `output.${selected}`, spec.mime, step(0, 1));
    }
    const separation = op === 'instrumental' || op === 'vocals';
    const wav = await prepareEditorAudio(ffmpeg, item.file, step(0, 0.15), separation ? ['-ar', '44100', '-ac', '2'] : []);
    const audio = await inspectEditorAudio(wav, signal);
    let rendered: Blob;
    if (separation) {
      const result = await runMusicTool({ task: 'vocals', variant: modelVariant.value as MusicModelVariant, blob: wav, audio, passes: 1 }, signal, (update) => {
        if (update.stage === 'separate' && update.fraction !== undefined) report(0.15 + 0.7 * update.fraction);
        else if (update.stage === 'download' && update.total) progress.bytes('Downloading the separation model', update.loaded ?? 0, update.total, 'First use only');
      });
      if (result.type !== 'stems') throw new Error('Separation returned no stems.');
      rendered = result.stems.find((stem) => stem.name === (op === 'vocals' ? 'Vocals' : 'Instrumental'))!.blob;
    } else {
      const base = emptyEdit(audio.duration);
      const edit: AudioEdit = op === 'normalize'
        ? { ...base, loudness: -14, ceiling: -1 }
        : op === 'pitch'
          ? { ...base, pitch: Number(pitch.value), tempo: Number(tempo.value) / 100 }
          : { ...pendingEdit(audio.duration), pitch: 0, tempo: 1 };
      rendered = await applyAudioEdit(ffmpeg, wav, edit, audio, step(0.15, 0.7));
    }
    return sharedMedia().encode(rendered, selected, step(0.85, 0.15));
  }

  batchInput.addEventListener('change', () => {
    const files = Array.from(batchInput.files ?? []);
    batchInput.value = '';
    for (const file of files) batchItems.push({ file, status: 'Waiting', fraction: 0, result: null, name: file.name });
    renderBatch();
  });
  batchClear.addEventListener('click', () => {
    batchItems = [];
    renderBatch();
  });
  batchRun.addEventListener('click', () => {
    const op = batchOp.value;
    const pending = batchItems.filter((item) => !item.result);
    if (op === 'effects' && !effectsPending()) {
      say('Set something in the Effects tab first, then run the batch.', [goTo('effects', 'Open Effects')]);
      return;
    }
    if (op === 'pitch' && !pitchPending()) {
      say('Set a key or tempo change in the Pitch & tempo tab first.', [goTo('pitch', 'Open Pitch & tempo')]);
      return;
    }
    void run(`Processing ${pending.length} files…`, async (signal) => {
      let done = 0;
      for (const [index, item] of pending.entries()) {
        item.status = 'Working…';
        renderBatch();
        try {
          const label = `File ${index + 1} of ${pending.length} · ${item.file.name}`;
          item.result = await processBatchItem(item, op, signal, (fraction) => {
            item.fraction = fraction;
            progress.work(label, (index + fraction) / pending.length);
            const bar = batchList.children[batchItems.indexOf(item)]?.querySelector<HTMLElement>('.progress-bar');
            if (bar) bar.style.width = `${Math.round(fraction * 100)}%`;
          });
          const extension = format.value;
          item.name = `${item.file.name.replace(/\.[^.]+$/, '')}${BATCH_SUFFIX[op] ?? ''}.${extension}`;
          item.status = `Done · ${(item.result.size / 1_000_000).toFixed(1)} MB`;
          item.fraction = 1;
          done += 1;
        } catch (error) {
          if (isAbortError(error)) {
            item.status = 'Cancelled';
            renderBatch();
            throw error;
          }
          item.status = errorMessage(error);
        }
        renderBatch();
      }
      say(`${done} of ${pending.length} files processed.`, done ? [{ label: 'Download all (ZIP)', run: () => batchZip.click() }] : []);
    }).then(renderBatch);
  });
  batchZip.addEventListener('click', () => {
    const files = batchItems.filter((item) => item.result).map((item) => ({ name: item.name, blob: item.result! }));
    void run('Writing the ZIP file…', async () => {
      options.download(await createZip(files), `localscribe-batch-${new Date().toISOString().slice(0, 10)}.zip`);
      say(`Saved ${files.length} files in one ZIP.`);
    });
  });

  // Init ---------------------------------------------------------------------
  let saved: string | null = null;
  try { saved = localStorage.getItem(TAB_KEY); } catch { /* storage unavailable */ }
  selectTab(saved && saved in TABS ? (saved as Tab) : 'remover');
  updateEffects();
  updatePitchLabels();
  describeSeparation();
  renderMarkers();

  return {
    activity(): { tone: 'busy' | 'ready' | 'warn'; label: string } | null {
      if (operation) return { tone: 'busy', label: 'Audio studio is working' };
      if (recording) return { tone: 'busy', label: 'Recording audio' };
      if (take) return { tone: 'ready', label: 'Recording take ready' };
      if (current()) return { tone: 'ready', label: 'Audio open' };
      if (joinItems.length) return { tone: 'ready', label: 'Audio join open' };
      if (batchItems.length) return { tone: 'ready', label: 'Audio batch open' };
      return null;
    },
    updateControls: update,
    /** Open a file in the studio, optionally switching tool. */
    openFile(file: File, tool?: Tab): void {
      if (tool) selectTab(tool);
      void open(async () => file);
    },
    joinFiles(files: File[]): void {
      selectTab('joiner');
      void addJoinFiles(files);
    },
    batchFiles(files: File[]): void {
      selectTab('batch');
      for (const file of files) batchItems.push({ file, status: 'Waiting', fraction: 0, result: null, name: file.name });
      renderBatch();
    },
    selectTool(tool: string): void {
      if (tool in TABS) selectTab(tool as Tab);
    },
    pause(): void {
      player.pause();
      mixer.pause();
    },
  };
}

