// In-page driver for the heavy video-editor benchmark.
//
// Served by the Vite dev server and imported inside /video-editor/:
//   const bench = await import('/bench/video-heavy-page.ts');
//   await bench.buildSeed();                          // adds fixtures, exports a seed .zip
//   const result = await bench.runScenario('V5', { resolution: 1080, exports: ['standard'] });
//
// bench/video-heavy.mjs drives it through Playwright; it also runs from any
// browser console. Every number is wall time on the main thread unless named
// otherwise. Fixtures come from /temp/perf/fixtures/ (see bench/PERF-RUNBOOK.md).
import { generateProject, type ScenarioId, type ProxyRef } from './video-project-gen';
import { createZip, readZip } from '../src/zip';

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

export const SEED_FIXTURES: [string, string][] = [
  ['v1080p30-10s.mp4', 'video/mp4'],
  ['mandel1080p30-15s.mp4', 'video/mp4'],
  ['hevc-1080p-10s.mp4', 'video/mp4'],
  ['vp9-1080p-10s.webm', 'video/webm'],
  ['speech-5min.wav', 'audio/wav'],
];

const q = <T extends Element = HTMLElement>(selector: string): T | null => document.querySelector<T>(selector);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const frame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));
const statusText = () => q('#video-status')?.textContent ?? '';

interface Download { name: string; blob: Blob; at: number }
const downloads: Download[] = [];
let hooked = false;
function hookDownloads(): void {
  if (hooked) return;
  hooked = true;
  const original = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    // The driver's own hand-off of an OPFS export is not an app download.
    if (this.dataset.benchHandoff) return original.call(this);
    if (this.download && this.href.startsWith('blob:')) {
      const at = performance.now();
      const name = this.download;
      void fetch(this.href).then((response) => response.blob()).then((blob) => downloads.push({ name, blob, at }));
      // Playwright sets this so the real download still happens and can be saved for ffprobe.
      if ((window as unknown as { __benchPassDownloads?: boolean }).__benchPassDownloads) return original.call(this);
      return;
    }
    return original.call(this);
  };
}

/**
 * Chromium offers showSaveFilePicker, so the editor streams every export to
 * disk. Answer the picker with an OPFS file so the stream-to-disk path runs
 * without a native dialog, then hand the file to Playwright afterwards.
 */
interface DiskFile { name: string; opfsName: string; closedAt: number }
const diskFiles: DiskFile[] = [];
let diskStubbed = false;
export function installDiskStub(): void {
  if (diskStubbed) return;
  diskStubbed = true;
  (window as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker = async (options: { suggestedName?: string }) => {
    const root = await navigator.storage.getDirectory();
    const name = options?.suggestedName ?? 'export.bin';
    const opfsName = `bench-${Date.now()}-${name}`;
    const handle = await root.getFileHandle(opfsName, { create: true });
    return {
      kind: 'file',
      name,
      getFile: () => handle.getFile(),
      createWritable: async (writableOptions?: FileSystemCreateWritableOptions) => {
        const writable = await handle.createWritable(writableOptions);
        const close = writable.close.bind(writable);
        Object.defineProperty(writable, 'close', {
          value: async () => {
            await close();
            diskFiles.push({ name, opfsName, closedAt: performance.now() });
          },
        });
        return writable;
      },
    };
  };
}

async function offerOpfsFile(opfsName: string, downloadName: string): Promise<number> {
  const root = await navigator.storage.getDirectory();
  const file = await (await root.getFileHandle(opfsName)).getFile();
  const url = URL.createObjectURL(file);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = downloadName;
  anchor.dataset.benchHandoff = '1';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return file.size;
}

export async function clearOpfs(): Promise<void> {
  const root = await navigator.storage.getDirectory() as FileSystemDirectoryHandle & { keys(): AsyncIterable<string> };
  for await (const name of root.keys()) if (name.startsWith('bench-')) await root.removeEntry(name).catch(() => undefined);
}

async function waitFor<T>(probe: () => T | null | undefined | false, timeout = 60000, interval = 20): Promise<T | null> {
  const start = performance.now();
  for (;;) {
    const value = probe();
    if (value) return value;
    if (performance.now() - start > timeout) return null;
    await sleep(interval);
  }
}

async function nextDownload(after: number, timeout = 600000): Promise<Download | null> {
  return waitFor(() => downloads.find((entry) => entry.at >= after) ?? null, timeout, 25);
}

const longTasks: PerformanceEntry[] = [];
const loafs: (PerformanceEntry & { blockingDuration?: number })[] = [];
const events: (PerformanceEntry & { processingStart?: number; processingEnd?: number; interactionId?: number })[] = [];
let observing = false;
function observe(): void {
  if (observing) return;
  observing = true;
  try { new PerformanceObserver((list) => longTasks.push(...list.getEntries())).observe({ type: 'longtask', buffered: true }); } catch { /* unsupported */ }
  try { new PerformanceObserver((list) => loafs.push(...list.getEntries())).observe({ type: 'long-animation-frame', buffered: true }); } catch { /* unsupported */ }
  try { new PerformanceObserver((list) => events.push(...list.getEntries())).observe({ type: 'event', buffered: true, durationThreshold: 16 } as PerformanceObserverInit); } catch { /* unsupported */ }
}

function taskStats(since: number, until = Infinity) {
  const tasks = longTasks.filter((task) => task.startTime >= since && task.startTime < until);
  const frames = loafs.filter((entry) => entry.startTime >= since && entry.startTime < until);
  return {
    longTasks: tasks.length,
    longTaskMs: +tasks.reduce((sum, task) => sum + task.duration, 0).toFixed(1),
    longTaskMax: +Math.max(0, ...tasks.map((task) => task.duration)).toFixed(1),
    loafBlockingMs: +frames.reduce((sum, entry) => sum + (entry.blockingDuration ?? 0), 0).toFixed(1),
  };
}

/** Event Timing entries (input to next paint) since a mark, for interactions driven by Playwright. */
export function eventStats(since: number) {
  const list = events.filter((entry) => entry.startTime >= since);
  const durations = list.map((entry) => entry.duration);
  return { count: list.length, ...(durations.length ? summarize(durations) : {}), byType: Object.fromEntries([...new Set(list.map((entry) => entry.name))].map((name) => [name, summarize(list.filter((entry) => entry.name === name).map((entry) => entry.duration))])) };
}

function heapMB(): number | null {
  const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  return memory ? +(memory.usedJSHeapSize / 1048576).toFixed(1) : null;
}

async function fixture(name: string, type: string): Promise<File> {
  const response = await fetch('/temp/perf/fixtures/' + name);
  if (!response.ok) throw new Error(`Missing fixture ${name}. Run the fixture step in bench/PERF-RUNBOOK.md.`);
  return new File([await response.blob()], name.split('/').pop()!, { type, lastModified: 1700000000000 });
}

function feed(input: HTMLInputElement, files: File[]): void {
  const transfer = new DataTransfer();
  for (const file of files) transfer.items.add(file);
  input.files = transfer.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

/** Time a synchronous UI action plus one macrotask for any follow-up work. */
async function timed(action: () => void): Promise<{ syncMs: number; settledMs: number } & ReturnType<typeof taskStats>> {
  const start = performance.now();
  action();
  const syncMs = performance.now() - start;
  await sleep(0);
  const settledMs = performance.now() - start;
  return { syncMs: +syncMs.toFixed(2), settledMs: +settledMs.toFixed(2), ...taskStats(start) };
}

/** Time an action until the next frame after it has been produced (two rAFs). */
async function timedFrame(action: () => void): Promise<number> {
  const start = performance.now();
  action();
  await frame();
  await frame();
  return performance.now() - start;
}

function summarize(values: number[]) {
  if (!values.length) return { n: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1) + 0.5))];
  return { n: sorted.length, min: +sorted[0].toFixed(2), p50: +pick(0.5).toFixed(2), p95: +pick(0.95).toFixed(2), max: +sorted[sorted.length - 1].toFixed(2) };
}

/** Environment block for the report. */
export async function environment(): Promise<Json> {
  const adapter = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<{ info?: Record<string, string> } | null> } }).gpu
    ? await (navigator as unknown as { gpu: { requestAdapter(): Promise<{ info?: Record<string, string> } | null> } }).gpu.requestAdapter()
    : null;
  const intervals: number[] = [];
  let last = await frame();
  for (let index = 0; index < 30; index += 1) {
    const now = await frame();
    intervals.push(now - last);
    last = now;
  }
  const refresh = summarize(intervals);
  return {
    userAgent: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? null,
    crossOriginIsolated,
    gpuAdapter: adapter ? { vendor: adapter.info?.vendor, architecture: adapter.info?.architecture, device: adapter.info?.device, description: adapter.info?.description } : null,
    rafIntervalP50: 'p50' in refresh ? refresh.p50 : null,
    visibility: document.visibilityState,
    devicePixelRatio,
  };
}

let seedProject: Json = null;
let seedMedia: { name: string; blob: Blob }[] = [];

/** Add the fixture set to an empty editor, export it, and keep project.json plus media as the generator seed. */
export async function buildSeed(fixtures = SEED_FIXTURES): Promise<{ assets: number; ms: number; names: string[] }> {
  hookDownloads();
  observe();
  installDiskStub();
  const start = performance.now();
  const files = await Promise.all(fixtures.map(([name, type]) => fixture(name, type)));
  feed(q<HTMLInputElement>('#video-media-input')!, files);
  await waitFor(() => document.querySelectorAll('.video-asset, [data-asset-id]').length >= fixtures.length, 120000);
  await sleep(1500);
  const before = performance.now();
  q<HTMLButtonElement>('#video-project-export')!.click();
  const archive = await nextDownload(before, 120000);
  if (!archive) throw new Error('Project export did not produce a download.');
  const entries = await readZip(new File([archive.blob], archive.name));
  seedProject = JSON.parse(await entries.find((entry) => entry.name === 'project.json')!.blob.text());
  seedMedia = entries.filter((entry) => entry.name !== 'project.json');
  return { assets: seedProject.assets.length, ms: Math.round(performance.now() - start), names: seedProject.assets.map((asset: Json) => asset.name) };
}

export interface RunOptions {
  resolution?: number;
  fps?: number;
  /** Export presets to run in order: standard, 4k, 1080p, 720p, vertical, audio, custom-webm, custom-mov, custom-mkv, custom-target, custom-loudness, custom-exact, custom-range. */
  exports?: string[];
  seeks?: number;
  editRepeats?: number;
  /** Seconds of playback to measure (0 = skip). */
  playback?: number;
  /** Preview proxies to attach: asset file name -> proxy file under /temp/perf/fixtures/. */
  proxies?: Record<string, { file: string; width: number; height: number }>;
  /** Long-edit memory pass: this many splits then the same number of undos. */
  memoryEdits?: number;
  /** Change the generated project before import, for one-off variations. */
  mutate?: (project: Json) => void;
}

/** Wait for a presented video frame on #video-preview whose media time matches the element's current time within one frame. */
function presentedFrame(video: HTMLVideoElement, frameDuration: number, timeout = 2000): Promise<{ at: number; mediaTime: number; target: number } | null> {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        resolve(null);
      }
    }, timeout);
    const callback = (_now: number, meta: VideoFrameCallbackMetadata) => {
      if (done) return;
      if (Math.abs(meta.mediaTime - video.currentTime) <= frameDuration + 0.002) {
        done = true;
        clearTimeout(timer);
        resolve({ at: performance.now(), mediaTime: meta.mediaTime, target: video.currentTime });
        return;
      }
      video.requestVideoFrameCallback(callback);
    };
    // Chromium drops pending frame callbacks when the element loads a new source
    // (a seek into another clip), so register again on each load and seek.
    const rearm = () => { if (!done) video.requestVideoFrameCallback(callback); };
    for (const type of ['loadedmetadata', 'loadeddata', 'seeked']) video.addEventListener(type, rearm);
    const cleanup = () => { for (const type of ['loadedmetadata', 'loadeddata', 'seeked']) video.removeEventListener(type, rearm); };
    setTimeout(cleanup, timeout + 50);
    video.requestVideoFrameCallback(callback);
  });
}

function rulerClick(ruler: HTMLElement, x: number): void {
  const y = ruler.getBoundingClientRect().top + 4;
  ruler.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y, button: 0, pointerId: 1 }));
  ruler.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x, clientY: y, button: 0, pointerId: 1 }));
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x, clientY: y, button: 0, pointerId: 1 }));
}

/** Which preview backend is drawing right now. */
export function activeBackend(): string {
  const canvas = q<HTMLCanvasElement>('.video-preview-canvas');
  const video = q<HTMLVideoElement>('#video-preview');
  if (canvas && video?.style.visibility === 'hidden') return canvas.getContext ? 'gpu-canvas' : 'canvas';
  return 'css';
}

async function measurePlayback(seconds: number, fps: number): Promise<Json> {
  const play = q<HTMLButtonElement>('#video-play');
  const video = q<HTMLVideoElement>('#video-preview');
  if (!play || !video) return null;
  const rafTimes: number[] = [];
  const mediaSteps: number[] = [];
  let lastMedia = -1;
  let lastPresented = -1;
  let presentedGaps = 0;
  let callbacks = 0;
  let running = true;
  const onFrame = (_now: number, meta: VideoFrameCallbackMetadata) => {
    if (!running) return;
    callbacks += 1;
    if (lastMedia >= 0) mediaSteps.push(meta.mediaTime - lastMedia);
    if (lastPresented >= 0 && meta.presentedFrames - lastPresented > 1) presentedGaps += meta.presentedFrames - lastPresented - 1;
    lastMedia = meta.mediaTime;
    lastPresented = meta.presentedFrames;
    video.requestVideoFrameCallback(onFrame);
  };
  const rafLoop = (now: number) => {
    if (!running) return;
    rafTimes.push(now);
    requestAnimationFrame(rafLoop);
  };
  const qualityStart = video.getVideoPlaybackQuality();
  const start = performance.now();
  play.click();
  video.requestVideoFrameCallback(onFrame);
  requestAnimationFrame(rafLoop);
  await sleep(seconds * 1000);
  running = false;
  const qualityEnd = video.getVideoPlaybackQuality();
  play.click();
  await sleep(200);
  const intervals = rafTimes.slice(1).map((time, index) => time - rafTimes[index]);
  const frameDuration = 1 / fps;
  // A step of more than 1.5 frames in media time (not a clip switch) is a skipped source frame.
  const skipped = mediaSteps.filter((step) => step > frameDuration * 1.5 && step < 1).reduce((sum, step) => sum + Math.round(step / frameDuration) - 1, 0);
  return {
    seconds,
    backend: activeBackend(),
    videoCallbacksPerSecond: +(callbacks / seconds).toFixed(1),
    skippedSourceFrames: skipped,
    presentedGaps,
    droppedVideoFrames: qualityEnd.droppedVideoFrames - qualityStart.droppedVideoFrames,
    totalVideoFrames: qualityEnd.totalVideoFrames - qualityStart.totalVideoFrames,
    rafInterval: summarize(intervals),
    rafOver20ms: intervals.filter((value) => value > 20).length,
    ...taskStats(start),
  };
}

async function runExport(preset: string, duration: number, scenario: string): Promise<Json> {
  const start = performance.now();
  const before = statusText();
  const diskBefore = diskFiles.length;
  const downloadsBefore = downloads.length;
  const resources = performance.getEntriesByType('resource').length;
  const heapStart = heapMB();
  let heapPeak = heapStart ?? 0;
  const heapTimer = setInterval(() => {
    const value = heapMB();
    if (value && value > heapPeak) heapPeak = value;
  }, 250);
  if (preset.startsWith('custom')) {
    q<HTMLButtonElement>('#video-export-toggle')?.click();
    q<HTMLButtonElement>('[data-export-preset="custom"]')!.click();
    await sleep(200);
    const set = (selector: string, value: string) => {
      const element = q<HTMLInputElement | HTMLSelectElement>(selector);
      if (!element) return false;
      if (element instanceof HTMLInputElement && element.type === 'checkbox') element.checked = value === 'true';
      else element.value = value;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    };
    q<HTMLButtonElement>('[data-export-platform="source"]')?.click();
    const variant = preset.slice('custom-'.length);
    // The dialog remembers the last container; reset it so each variant changes one thing.
    set('#video-export-container', variant === 'webm' || variant === 'mov' || variant === 'mkv' ? variant : 'mp4');
    set('#video-export-target', '');
    set('#video-export-exact', 'false');
    const loudnessSelect = q<HTMLSelectElement>('#video-export-loudness');
    if (loudnessSelect && variant !== 'loudness') set('#video-export-loudness', loudnessSelect.options[0]?.value ?? loudnessSelect.value);
    if (variant === 'target') set('#video-export-target', String(Math.max(5, Math.round(duration * 0.25))));
    if (variant === 'loudness') {
      const loud = q<HTMLSelectElement>('#video-export-loudness');
      if (loud) set('#video-export-loudness', [...loud.options].map((option) => option.value).find((value) => value && value !== 'off' && value !== 'none') ?? loud.value);
    }
    if (variant === 'exact') set('#video-export-exact', 'true');
    if (variant === 'range') {
      q<HTMLInputElement>('#video-export-range-marked')?.click();
    }
    await sleep(100);
    q<HTMLButtonElement>('#video-export')!.click();
  } else if (preset === 'standard') {
    q<HTMLButtonElement>('#video-export-main')!.click();
  } else {
    q<HTMLButtonElement>('#video-export-toggle')?.click();
    q<HTMLButtonElement>(`[data-export-preset="${preset}"]`)!.click();
  }
  const done = await waitFor(() => {
    if (diskFiles.length > diskBefore) return { kind: 'disk' as const };
    if (downloads.length > downloadsBefore) return { kind: 'memory' as const };
    const text = statusText();
    if (text !== before && /could not|failed|error|cancel/i.test(text) && !q('#video-progress:not(.hidden)')) return { kind: 'error' as const };
    return null;
  }, 3 * 3600_000, 50);
  const end = performance.now();
  clearInterval(heapTimer);
  await waitFor(() => /^Saved /.test(statusText()) || done?.kind !== 'disk', 10000);
  const status = statusText();
  const ffmpegLoaded = performance.getEntriesByType('resource').slice(resources).some((entry) => /ffmpeg[^/]*.wasm|ffmpeg-core|core-mt/i.test(entry.name));
  const result: Json = {
    preset, ms: Math.round(end - start), status, ffmpegLoaded, heapStartMB: heapStart, heapPeakMB: heapPeak,
    perOutputSecond: +((end - start) / 1000 / Math.max(0.1, duration)).toFixed(3), ...taskStats(start, end),
  };
  if (done?.kind === 'disk') {
    const file = diskFiles[diskFiles.length - 1];
    result.sink = 'stream-to-disk';
    result.downloadName = `${scenario}-${preset}-${file.name}`;
    result.bytes = await offerOpfsFile(file.opfsName, result.downloadName);
  } else if (done?.kind === 'memory') {
    const file = downloads[downloads.length - 1];
    result.sink = 'in-memory download';
    result.downloadName = file.name;
    result.bytes = file.blob.size;
    (window as unknown as { __lastExport?: Blob }).__lastExport = file.blob;
  } else {
    result.ms = -1;
  }
  await sleep(500);
  return result;
}

/** Import one generated scenario and measure interaction and (optionally) export costs. */
export async function runScenario(scenario: ScenarioId, options: RunOptions = {}): Promise<Json> {
  if (!seedProject) throw new Error('Call buildSeed() first.');
  hookDownloads();
  observe();
  installDiskStub();
  const fps = options.fps ?? 30;
  const proxyRefs: Record<string, ProxyRef> = {};
  const proxyMedia: { name: string; blob: Blob }[] = [];
  for (const [assetName, proxy] of Object.entries(options.proxies ?? {})) {
    const path = `proxies/${String(proxyMedia.length + 1).padStart(3, '0')}-${proxy.height}p.mp4`;
    const response = await fetch('/temp/perf/fixtures/' + proxy.file);
    if (!response.ok) throw new Error(`Missing proxy ${proxy.file}`);
    proxyMedia.push({ name: path, blob: await response.blob() });
    proxyRefs[assetName] = { path, width: proxy.width, height: proxy.height };
  }
  const { project, summary } = generateProject(seedProject, scenario, { resolution: options.resolution ?? 1080, fps: options.fps, proxies: proxyRefs });
  options.mutate?.(project);
  const json = JSON.stringify(project);
  const archive = await createZip([
    ...seedMedia.map((entry) => ({ name: entry.name, blob: entry.blob })),
    ...proxyMedia,
    { name: 'project.json', blob: new Blob([json], { type: 'application/json' }) },
  ]);
  const result: Json = { scenario, resolution: options.resolution ?? 1080, fps, summary, projectJsonKB: +(json.length / 1024).toFixed(1), archiveMB: +(archive.size / 1048576).toFixed(1), heapBeforeMB: heapMB() };

  // Import.
  const importStart = performance.now();
  feed(q<HTMLInputElement>('#video-project-file')!, [new File([archive], `bench-${scenario}.localscribe.zip`, { type: 'application/zip' })]);
  const imported = await waitFor(() => /Imported/.test(statusText()), 300000);
  result.importMs = imported ? Math.round(performance.now() - importStart) : -1;
  result.importTasks = taskStats(importStart);
  const video = q<HTMLVideoElement>('#video-preview');
  const firstFrame = await waitFor(() => (video && video.readyState >= 2) || null, 30000);
  result.firstPreviewFrameMs = firstFrame ? Math.round(performance.now() - importStart) : -1;
  const ready = await waitFor(() => !document.querySelector('.vt-filmstrip-loading, .vt-wave-loading') || null, 30000, 100);
  result.loadingLeft = document.querySelectorAll('.vt-filmstrip-loading, .vt-wave-loading').length;
  result.filmstripsReadyMs = ready ? Math.round(performance.now() - importStart) : -1;
  await sleep(300);
  result.timeline = {
    clipBlocks: document.querySelectorAll('.vt-clip').length,
    cueBlocks: document.querySelectorAll('.vt-cue').length,
    domNodes: document.getElementsByTagName('*').length,
    timelineNodes: q('#video-timeline, .vt-content, .video-timeline')?.getElementsByTagName('*').length ?? null,
    videoElements: document.querySelectorAll('video').length,
    previewSrcIsProxy: null as boolean | null,
  };
  result.backendAfterImport = activeBackend();
  result.heapAfterImportMB = heapMB();

  // Zoom: 8 steps in, 8 out, each until the next produced frame.
  const zoom = q<HTMLInputElement>('#video-zoom');
  if (zoom) {
    const steps: number[] = [];
    const start = performance.now();
    for (const value of [12, 25, 37, 50, 62, 75, 87, 100, 87, 75, 62, 50, 37, 25, 12, 0]) {
      steps.push(await timedFrame(() => {
        zoom.value = String(value);
        zoom.dispatchEvent(new Event('input', { bubbles: true }));
      }));
    }
    result.zoom = { ...summarize(steps), ...taskStats(start) };
    // Zoom in a little so the scroll pass has work to do.
    zoom.value = '50';
    zoom.dispatchEvent(new Event('input', { bubbles: true }));
    await frame();
    await frame();
  }

  // Horizontal scroll of the full timeline, one step per frame.
  const scroller = q<HTMLElement>('.vt-scroll, #video-timeline-scroll');
  if (scroller) {
    const frames: number[] = [];
    const start = performance.now();
    const width = scroller.scrollWidth;
    for (let x = 0; x <= width; x += Math.max(100, width / 60)) frames.push(await timedFrame(() => { scroller.scrollLeft = x; }));
    result.scroll = { scrollWidth: width, ...summarize(frames), ...taskStats(start) };
    scroller.scrollLeft = 0;
    zoom && (zoom.value = '0', zoom.dispatchEvent(new Event('input', { bubbles: true })));
    await frame();
    await frame();
  }

  // Seeks: click the ruler at random positions. Two numbers per seek:
  // handler (dispatch plus one macrotask) and click to presented frame
  // (requestVideoFrameCallback with the frame matching the element's time).
  const seekRuler = q<HTMLElement>('.vt-ruler');
  if (seekRuler && video && (options.seeks ?? 30) > 0) {
    const handler: number[] = [];
    const presented: number[] = [];
    const presentedGpu: number[] = [];
    let timeouts = 0;
    let offByMoreThanFrame = 0;
    let state = 7;
    const start = performance.now();
    for (let index = 0; index < (options.seeks ?? 30); index += 1) {
      state = (state * 48271) % 2147483647;
      const box = seekRuler.getBoundingClientRect();
      // Stay inside the visible part of the video clips so every seek lands on a frame.
      const right = Math.min(box.right - 2, Math.max(box.left + 4, ...[...document.querySelectorAll<HTMLElement>('.vt-clip')].map((clip) => clip.getBoundingClientRect().right)));
      const x = box.left + 2 + (state / 2147483647) * Math.max(1, right - box.left - 4);
      const begin = performance.now();
      const waiter = presentedFrame(video, 1 / fps);
      rulerClick(seekRuler, x);
      handler.push(performance.now() - begin);
      const shown = await waiter;
      if (!shown) {
        timeouts += 1;
      } else {
        presented.push(shown.at - begin);
        if (Math.abs(shown.mediaTime - shown.target) > 1 / fps + 0.002) offByMoreThanFrame += 1;
        if (activeBackend() !== 'css') {
          await frame();
          presentedGpu.push(performance.now() - begin);
        }
      }
      await sleep(30);
    }
    result.seek = { handler: summarize(handler), presented: summarize(presented), presentedWithGpuFrame: summarize(presentedGpu), timeouts, offByMoreThanFrame, ...taskStats(start) };
  }

  // Playback pacing.
  if ((options.playback ?? 0) > 0 && seekRuler) {
    rulerClick(seekRuler, seekRuler.getBoundingClientRect().left + 2);
    await sleep(500);
    result.playback = await measurePlayback(options.playback!, fps);
    if (video) result.timeline.previewSrcIsProxy = /blob:/.test(video.currentSrc) ? null : false;
  }

  // Edit operations: split, undo, redo. Each split commits a snapshot, so this
  // also measures snapshot(), signature(), and history cost on heavy projects.
  const split = q<HTMLButtonElement>('#video-split');
  const undo = q<HTMLButtonElement>('#video-undo');
  const redo = q<HTMLButtonElement>('#video-redo');
  const firstClip = q<HTMLElement>('.vt-clip');
  const rulerForSplit = q<HTMLElement>('.vt-ruler');
  if (firstClip && rulerForSplit) {
    const clipBox = firstClip.getBoundingClientRect();
    rulerClick(rulerForSplit, clipBox.left + Math.max(4, clipBox.width * 0.4));
    await sleep(150);
  }
  result.splitEnabled = split ? !split.disabled : false;
  const repeats = options.editRepeats ?? 6;
  const splitTimes: number[] = [];
  const undoTimes: number[] = [];
  const redoTimes: number[] = [];
  const editStart = performance.now();
  for (let index = 0; index < repeats; index += 1) {
    if (firstClip && rulerForSplit && split?.disabled) {
      const clipBox = firstClip.getBoundingClientRect();
      rulerClick(rulerForSplit, clipBox.left + Math.max(4, clipBox.width * (0.3 + index * 0.05)));
      await sleep(80);
    }
    if (split && !split.disabled) splitTimes.push(await timedFrame(() => split.click()));
    if (undo && !undo.disabled) undoTimes.push(await timedFrame(() => undo.click()));
    if (redo && !redo.disabled) redoTimes.push(await timedFrame(() => redo.click()));
    if (undo && !undo.disabled) await timedFrame(() => undo.click());
  }
  result.edits = { split: summarize(splitTimes), undo: summarize(undoTimes), redo: summarize(redoTimes), ...taskStats(editStart) };

  // Manual save (the same path autosave takes).
  const save = q<HTMLButtonElement>('#video-project-save');
  if (save) {
    const start = performance.now();
    save.click();
    const syncMs = performance.now() - start;
    await waitFor(() => /saved locally/i.test(statusText()), 120000);
    result.save = { syncMs: +syncMs.toFixed(1), totalMs: Math.round(performance.now() - start), ...taskStats(start) };
    const estimate = await navigator.storage.estimate();
    result.storageUsageMB = +((estimate.usage ?? 0) / 1048576).toFixed(1);
  }
  result.heapAfterEditsMB = heapMB();

  // Long edit pass for memory: N splits at moving playheads, then N undos.
  if ((options.memoryEdits ?? 0) > 0 && split && undo && rulerForSplit) {
    const box = rulerForSplit.getBoundingClientRect();
    const splitsDone: number[] = [];
    const start = performance.now();
    for (let index = 0; index < options.memoryEdits!; index += 1) {
      rulerClick(rulerForSplit, box.left + 5 + ((index * 37) % Math.max(10, box.width - 10)));
      await sleep(20);
      if (!split.disabled) splitsDone.push(await timedFrame(() => split.click()));
    }
    result.heapAfterManyEditsMB = heapMB();
    const undos: number[] = [];
    for (let index = 0; index < options.memoryEdits! && !undo.disabled; index += 1) undos.push(await timedFrame(() => undo.click()));
    result.memoryPass = { splits: summarize(splitsDone), undos: summarize(undos), ...taskStats(start) };
    result.heapAfterUndosMB = heapMB();
  }

  // Exports.
  if (options.exports?.length) {
    const duration = summary.duration;
    if (options.exports.includes('custom-range') && rulerForSplit) {
      const box = rulerForSplit.getBoundingClientRect();
      rulerClick(rulerForSplit, box.left + box.width * 0.1);
      await sleep(100);
      q<HTMLButtonElement>('#video-mark-in')?.click();
      rulerClick(rulerForSplit, box.left + box.width * 0.2);
      await sleep(100);
      q<HTMLButtonElement>('#video-mark-out')?.click();
    }
    result.exports = [];
    for (const preset of options.exports) {
      result.exports.push(await runExport(preset, preset === 'custom-range' ? duration * 0.1 : duration, scenario));
    }
  }
  result.counters = (window as unknown as { __benchCounters?: Json }).__benchCounters ?? null;
  return result;
}

/** Inspect the last in-memory export with Mediabunny (codec, size, duration, packet count). */
export async function verifyLastExport(): Promise<Json> {
  const blob = (window as unknown as { __lastExport?: Blob }).__lastExport;
  if (!blob) return null;
  const { Input, ALL_FORMATS, BlobSource, EncodedPacketSink } = await import('mediabunny');
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
  const track = await input.getPrimaryVideoTrack();
  const audio = await input.getPrimaryAudioTrack();
  let packets = 0;
  if (track) {
    const sink = new EncodedPacketSink(track);
    for await (const _packet of sink.packets()) packets += 1;
  }
  return {
    duration: await input.computeDuration(),
    video: track ? { codec: track.codec, width: track.displayWidth, height: track.displayHeight, packets } : null,
    audio: audio ? { codec: audio.codec, sampleRate: audio.sampleRate, channels: audio.numberOfChannels } : null,
  };
}
