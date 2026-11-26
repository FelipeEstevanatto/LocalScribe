/**
 * Baseline benchmark for the current FFmpeg audio path.
 *
 * This page is intentionally separate from the app. It exercises the same
 * functions the Audio studio uses today, over a fixed corpus in /bench/.
 * Results are stored in window.__bench for automation.
 */

import { AUDIO_FORMATS, sharedFfmpeg, type AudioFormat } from './audio-ffmpeg';
import {
  applyAudioEdit,
  emptyEdit,
  inspectEditorAudio,
  prepareEditorAudio,
  type AudioEdit,
} from './audio-edit';

type Row = {
  engine: string;
  op: string;
  file: string;
  ms: number;
  bytes?: number;
  heapMB?: number;
  note?: string;
  ok: boolean;
  error?: string;
};

declare global {
  interface Window {
    __bench?: {
      status: 'running' | 'done' | 'error';
      engine: string;
      rows: Row[];
      meta: Record<string, unknown>;
    };
  }
}

const rows: Row[] = [];
const statusEl = document.querySelector<HTMLDivElement>('#status');
const rowsEl = document.querySelector<HTMLTableSectionElement>('#rows');

function status(text: string): void {
  if (statusEl) statusEl.textContent = text;
  if (!window.__bench) return;
  window.__bench.status = text.startsWith('Benchmark complete') ? 'done' : 'running';
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

async function measure(
  engine: string,
  op: string,
  label: string,
  action: () => Promise<{ bytes?: number; note?: string } | void>,
): Promise<void> {
  status(`${op} · ${label}`);
  const beforeHeap = heap();
  const started = performance.now();
  try {
    const result = await action();
    const ms = performance.now() - started;
    rows.push({
      engine,
      op,
      file: label,
      ms,
      bytes: result?.bytes,
      heapMB: heap() - beforeHeap,
      note: result?.note,
      ok: true,
    });
  } catch (error) {
    rows.push({
      engine,
      op,
      file: label,
      ms: performance.now() - started,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  if (window.__bench) window.__bench.rows = rows;
  render();
}

async function run(): Promise<void> {
  const ffmpeg = sharedFfmpeg();
  // The MT assets are optional in this working tree; force the deterministic
  // single-threaded core so the baseline does not depend on them.
  (ffmpeg as unknown as { singleThread: boolean }).singleThread = true;
  (ffmpeg as unknown as { multithreaded: boolean }).multithreaded = false;

  let loadStart = 0;
  let loadEnd = 0;
  let loadBytes = 0;
  let loadTotal = 0;
  ffmpeg.onLoad(({ loaded, total }) => {
    if (!loadStart) loadStart = performance.now();
    loadBytes = loaded;
    loadTotal = Math.max(total, loaded);
    if (loaded >= total) loadEnd = performance.now();
  });

  window.__bench = {
    status: 'running',
    engine: 'ffmpeg-st',
    rows,
    meta: {
      userAgent: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency,
      crossOriginIsolated: self.crossOriginIsolated,
    },
  };

  const formats10 = [
    'wav', 'mp3', 'm4a', 'flac', 'ogg', 'opus', 'webm', 'aac', 'aiff', 'caf', 'mp4', 'avi',
  ];
  const formats60 = ['wav', 'mp3', 'm4a', 'flac', 'ogg'];
  const signal = new AbortController().signal;

  // Probe and decode every 10-second container, then the 60-second set.
  for (const format of formats10) {
    const name = `bench-10s.${format}`;
    await measure('ffmpeg-st', 'probe', name, async () => {
      const result = await ffmpeg.probe(await file(name), signal);
      return { note: `${result.audioCodec ?? 'no audio'} · ${result.hasAudio ? 'audio' : 'no audio'}` };
    });
    await measure('ffmpeg-st', 'decode', name, async () => {
      const blob = await prepareEditorAudio(ffmpeg, await file(name), signal);
      const audio = await inspectEditorAudio(blob, signal);
      return { bytes: blob.size, note: `${audio.sampleRate} Hz · ${audio.channels} ch · ${audio.duration.toFixed(2)} s` };
    });
  }

  for (const format of formats60) {
    const name = `bench-60s.${format}`;
    await measure('ffmpeg-st', 'probe', name, async () => {
      const result = await ffmpeg.probe(await file(name), signal);
      return { note: `${result.audioCodec ?? 'no audio'} · ${result.hasAudio ? 'audio' : 'no audio'}` };
    });
    await measure('ffmpeg-st', 'decode', name, async () => {
      const blob = await prepareEditorAudio(ffmpeg, await file(name), signal);
      const audio = await inspectEditorAudio(blob, signal);
      return { bytes: blob.size, note: `${audio.sampleRate} Hz · ${audio.channels} ch · ${audio.duration.toFixed(2)} s` };
    });
    await measure('ffmpeg-st', 'trim 10 s', name, async () => {
      const blob = await prepareEditorAudio(ffmpeg, await file(name), signal, ['-ss', '10', '-t', '10']);
      const audio = await inspectEditorAudio(blob, signal);
      return { bytes: blob.size, note: `${audio.duration.toFixed(2)} s` };
    });
  }

  // One decoded 60-second float WAV is the source for export and effects.
  status('Preparing the 60-second float WAV…');
  const sixty = await file('bench-60s.wav');
  const source = await prepareEditorAudio(ffmpeg, sixty, signal);
  const sourceAudio = await inspectEditorAudio(source, signal);
  const sourceNote = `${sourceAudio.sampleRate} Hz · ${sourceAudio.channels} ch`;

  for (const format of Object.keys(AUDIO_FORMATS) as AudioFormat[]) {
    await measure('ffmpeg-st', 'encode', format, async () => {
      const blob = await ffmpeg.encode(source, format, { signal });
      return { bytes: blob.size, note: `${AUDIO_FORMATS[format].label} · source ${sourceNote}` };
    });
  }

  const easy: AudioEdit = {
    ...emptyEdit(sourceAudio.duration),
    gain: 6,
    effect: 'fades',
    fadeIn: 1,
    fadeOut: 1,
  };
  await measure('ffmpeg-st', 'effects easy', 'gain 6 dB + 1 s fades', async () => {
    const blob = await applyAudioEdit(ffmpeg, source, easy, sourceAudio, signal);
    const audio = await inspectEditorAudio(blob, signal);
    return { bytes: blob.size, note: `${audio.duration.toFixed(2)} s · peak ${audio.peak.toFixed(3)}` };
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
  await measure('ffmpeg-st', 'effects hard', 'denoise + loudness + limiter + pitch/tempo + reverb', async () => {
    const blob = await applyAudioEdit(ffmpeg, source, hard, sourceAudio, signal);
    const audio = await inspectEditorAudio(blob, signal);
    return { bytes: blob.size, note: `${audio.duration.toFixed(2)} s · peak ${audio.peak.toFixed(3)}` };
  });

  if (window.__bench) {
    window.__bench.meta = {
      ...window.__bench.meta,
      loadStartMs: loadStart ? Number((loadStart - performance.timeOrigin).toFixed(1)) : null,
      loadEndMs: loadEnd ? Number((loadEnd - performance.timeOrigin).toFixed(1)) : null,
      loadWallMs: loadStart && loadEnd ? Number((loadEnd - loadStart).toFixed(1)) : null,
      loadBytes,
      loadTotal,
      rowCount: rows.length,
    };
  }
  status(`Benchmark complete. ${rows.filter((row) => row.ok).length}/${rows.length} operations passed.`);
}

run().catch((error) => {
  status(`Benchmark failed: ${error instanceof Error ? error.message : String(error)}`);
  if (window.__bench) window.__bench.status = 'error';
  console.error(error);
});
