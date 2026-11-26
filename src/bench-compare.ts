/**
 * Post-implementation benchmark: router + direct Mediabunny.
 *
 * Run against the same /bench/ corpus as bench-baseline.ts so the JSON files
 * can be diffed directly.
 */

import { AUDIO_FORMATS, sharedFfmpeg, type AudioFormat } from './audio-ffmpeg';
import { applyAudioEdit, emptyEdit, getLastEditEngine, inspectEditorAudio, type AudioEdit } from './audio-edit';
import { renderFastEdit } from './audio-dsp';
import { MediabunnyEngine } from './mediabunny-engine';
import { sharedMedia } from './media-router';

type Row = {
  engine: string;
  op: string;
  file: string;
  ms: number;
  bytes?: number;
  heapMB?: number;
  ffmpegLoaded: boolean;
  note?: string;
  ok: boolean;
  error?: string;
};

const benchWin = window as unknown as {
  __bench?: {
    status: 'running' | 'done' | 'error';
    engine: string;
    rows: Row[];
    meta: Record<string, unknown>;
  };
};

const rows: Row[] = [];
const statusEl = document.querySelector<HTMLDivElement>('#status');
const rowsEl = document.querySelector<HTMLTableSectionElement>('#rows');

function status(text: string): void {
  if (statusEl) statusEl.textContent = text;
  if (benchWin.__bench) {
    benchWin.__bench.status = text.startsWith('Benchmark complete') ? 'done' : 'running';
  }
}

function render(): void {
  if (!rowsEl) return;
  rowsEl.innerHTML = rows
    .map(
      (row) => `
        <tr>
          <td>${row.engine}</td>
          <td>${row.op}</td>
          <td>${row.file}</td>
          <td class="num">${row.ms.toFixed(1)}</td>
          <td class="num">${row.bytes ? (row.bytes / 1e6).toFixed(2) : '—'}</td>
          <td class="num">${row.heapMB === undefined ? '—' : row.heapMB.toFixed(1)}</td>
          <td>${row.ffmpegLoaded ? 'yes' : 'no'}</td>
          <td class="${row.ok ? 'ok' : 'err'}">${row.ok ? row.note ?? 'ok' : row.error}</td>
        </tr>
      `,
    )
    .join('');
}

function heap(): number {
  const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  return memory ? memory.usedJSHeapSize / 1e6 : 0;
}

async function file(name: string): Promise<File> {
  const response = await fetch(`/bench/${name}`);
  if (!response.ok) throw new Error(`Could not fetch ${name}: HTTP ${response.status}`);
  const blob = await response.blob();
  return new File([blob], name, { type: blob.type || 'application/octet-stream' });
}

let ffmpegLoaded = false;

async function measure(
  engine: string,
  op: string,
  label: string,
  action: () => Promise<{ bytes?: number; note?: string } | void>,
): Promise<void> {
  status(`${engine} · ${op} · ${label}`);
  const beforeHeap = heap();
  const started = performance.now();
  try {
    const result = await action();
    rows.push({
      engine,
      op,
      file: label,
      ms: performance.now() - started,
      bytes: result?.bytes,
      heapMB: heap() - beforeHeap,
      ffmpegLoaded,
      note: result?.note,
      ok: true,
    });
  } catch (error) {
    rows.push({
      engine,
      op,
      file: label,
      ms: performance.now() - started,
      ffmpegLoaded,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  if (benchWin.__bench) benchWin.__bench.rows = rows;
  render();
}

async function run(): Promise<void> {
  const ffmpeg = sharedFfmpeg();
  (ffmpeg as unknown as { singleThread: boolean }).singleThread = true;
  (ffmpeg as unknown as { multithreaded: boolean }).multithreaded = false;
  ffmpeg.onLoad(() => {
    ffmpegLoaded = true;
  });

  benchWin.__bench = {
    status: 'running',
    engine: 'router',
    rows,
    meta: {
      userAgent: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency,
      crossOriginIsolated: self.crossOriginIsolated,
    },
  };

  const media = sharedMedia();
  const mb = new MediabunnyEngine();
  const signal = new AbortController().signal;
  const signalFor = (): AbortSignal => signal;

  await measure('router', 'capabilities', 'all formats', async () => {
    const started = performance.now();
    const caps = await media.capabilities();
    const fast = Object.entries(caps)
      .filter(([, value]) => value.fast)
      .map(([format]) => format);
    return {
      note: `${fast.join(', ')} · discovered in ${(performance.now() - started).toFixed(0)} ms`,
    };
  });

  const common10 = ['wav', 'mp3', 'm4a', 'flac', 'ogg', 'opus', 'webm', 'aac', 'mp4'];
  const fallback10 = ['aiff', 'caf', 'avi'];
  const common60 = ['wav', 'mp3', 'm4a', 'flac', 'ogg'];

  for (const format of common10) {
    const name = `bench-10s.${format}`;
    await measure('router', 'probe', name, async () => {
      const result = await media.probe(await file(name), signalFor());
      return { note: `${result.audioCodec ?? 'no audio'} · ${media.lastEngine}` };
    });
    await measure('router', 'decode', name, async () => {
      const result = await media.decode(await file(name), { signal: signalFor() });
      return { bytes: result.wav.size, note: `${result.sampleRate} Hz · ${result.channels} ch · ${media.lastEngine}` };
    });
  }

  for (const format of fallback10) {
    const name = `bench-10s.${format}`;
    await measure('router', 'probe', name, async () => {
      const result = await media.probe(await file(name), signalFor());
      return { note: `${result.audioCodec ?? 'no audio'} · ${media.lastEngine}` };
    });
    await measure('router', 'decode', name, async () => {
      const result = await media.decode(await file(name), { signal: signalFor() });
      return { bytes: result.wav.size, note: `${result.sampleRate} Hz · ${result.channels} ch · ${media.lastEngine}` };
    });
  }

  for (const format of common60) {
    const name = `bench-60s.${format}`;
    await measure('router', 'probe', name, async () => {
      const result = await media.probe(await file(name), signalFor());
      return { note: `${result.audioCodec ?? 'no audio'} · ${media.lastEngine}` };
    });
    await measure('router', 'decode', name, async () => {
      const result = await media.decode(await file(name), { signal: signalFor() });
      return { bytes: result.wav.size, note: `${result.sampleRate} Hz · ${result.channels} ch · ${media.lastEngine}` };
    });
    await measure('router', 'trim 10 s', name, async () => {
      const result = await media.trim(await file(name), 10, 20, { signal: signalFor() });
      return { bytes: result.wav.size, note: `${result.duration.toFixed(2)} s · ${media.lastEngine}` };
    });
  }

  status('Preparing the 60-second source…');
  const decodedSource = await media.decode(await file('bench-60s.wav'), { signal: signalFor() });
  const sourceAudio = await inspectEditorAudio(decodedSource.wav, signalFor());
  const sourceNote = `${sourceAudio.sampleRate} Hz · ${sourceAudio.channels} ch · ${media.lastEngine}`;

  const dspEasy: AudioEdit = {
    ...emptyEdit(sourceAudio.duration),
    gain: 6,
    effect: 'fades',
    fadeIn: 1,
    fadeOut: 1,
  };
  await measure('dsp', 'effects easy', 'gain 6 dB + 1 s fades', async () => {
    const blob = await renderFastEdit(decodedSource.wav, dspEasy, { signal: signalFor() });
    const audio = await inspectEditorAudio(blob, signalFor());
    return { bytes: blob.size, note: `${audio.duration.toFixed(2)} s · peak ${audio.peak.toFixed(3)} · sample DSP` };
  });

  const fastFormats: AudioFormat[] = ['wav', 'mp3', 'flac', 'm4a', 'aac', 'opus', 'webm'];
  const fallbackFormats: AudioFormat[] = ['ogg', 'aiff', 'caf'];
  for (const format of [...fastFormats, ...fallbackFormats]) {
    await measure('router', 'encode', format, async () => {
      media.lastFallbackReason = null;
      const blob = await media.encode(decodedSource.wav, format, { signal: signalFor() });
      return {
        bytes: blob.size,
        note: `${AUDIO_FORMATS[format].label} · ${media.lastEngine}${media.lastFallbackReason ? ` · ${media.lastFallbackReason}` : ''} · source ${sourceNote}`,
      };
    });
  }

  // Direct Mediabunny numbers, independent of the router's FFmpeg fallback.
  for (const format of ['wav', 'mp3', 'm4a', 'flac', 'ogg'] as const) {
    const name = `bench-60s.${format}`;
    await measure('mediabunny', 'decode', name, async () => {
      const result = await mb.decode(await file(name), { signal: signalFor() });
      return { bytes: result.wav.size, note: `${result.sampleRate} Hz · ${result.channels} ch` };
    });
  }
  for (const format of fastFormats) {
    await measure('mediabunny', 'encode', format, async () => {
      const blob = await mb.encode(decodedSource.wav, format, { signal: signalFor() });
      return { bytes: blob.size, note: `${AUDIO_FORMATS[format].label} · direct` };
    });
  }

  const easy: AudioEdit = {
    ...emptyEdit(sourceAudio.duration),
    gain: 6,
    effect: 'fades',
    fadeIn: 1,
    fadeOut: 1,
  };
  await measure('auto', 'effects easy', 'gain 6 dB + 1 s fades', async () => {
    const blob = await applyAudioEdit(ffmpeg, decodedSource.wav, easy, sourceAudio, signalFor());
    const audio = await inspectEditorAudio(blob, signalFor());
    return { bytes: blob.size, note: `${audio.duration.toFixed(2)} s · peak ${audio.peak.toFixed(3)} · ${getLastEditEngine()}` };
  });

  const hard: AudioEdit = {
    ...emptyEdit(sourceAudio.duration),
    denoise: 12,
    loudness: -16,
    ceiling: -1,
    pitch: 2,
    tempo: 1.05,
    effect: 'reverb',
  };
  await measure('auto', 'effects hard', 'denoise + loudness + limiter + pitch/tempo + reverb', async () => {
    const blob = await applyAudioEdit(ffmpeg, decodedSource.wav, hard, sourceAudio, signalFor());
    const audio = await inspectEditorAudio(blob, signalFor());
    return { bytes: blob.size, note: `${audio.duration.toFixed(2)} s · peak ${audio.peak.toFixed(3)} · ${getLastEditEngine()}` };
  });

  if (benchWin.__bench) {
    benchWin.__bench.meta = {
      ...benchWin.__bench.meta,
      ffmpegLoaded,
      lastFallbackReason: media.lastFallbackReason,
      rowCount: rows.length,
    };
  }
  status(`Benchmark complete. ${rows.filter((row) => row.ok).length}/${rows.length} operations passed.`);
}

run().catch((error) => {
  status(`Benchmark failed: ${error instanceof Error ? error.message : String(error)}`);
  if (benchWin.__bench) benchWin.__bench.status = 'error';
  console.error(error);
});
