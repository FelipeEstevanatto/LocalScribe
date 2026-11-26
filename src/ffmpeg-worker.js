/*
 * Local FFmpeg worker for audio editing, export, and video muxing.
 *
 * Protocol (main → worker):
 *   { id, kind: 'run', inputs: [{ name, blob }], texts?: [{ name, content }], args, output, duration? }
 *   { id, kind: 'probe', inputs: [{ name, blob }] }
 * Worker → main:
 *   { type: 'load', loaded, total }          core download progress
 *   { id, type: 'progress', ratio, time }   encode progress (ratio 0–1 or null)
 *   { id, type: 'done', bytes }             output file
 *   { id, type: 'log', log }                probe output
 *   { id, type: 'error', error }
 *
 * Inputs are mounted read-only with WORKERFS so large videos are read lazily
 * from the File objects instead of being copied into WASM memory.
 */

import createSingleThreadCore from '@ffmpeg/core';
import wasmAsset from '@ffmpeg/core/wasm?url';

// Served untouched by scripts/ffmpeg-mt-plugin.ts (dev middleware + build copy).
// The worker lives in src/ (dev) or assets/ (build), one level below the app.
const mtCoreAsset = '../ffmpeg-mt/ffmpeg-core.js';
const mtWasmAsset = '../ffmpeg-mt/ffmpeg-core.wasm';
const mtWorkerAsset = '../ffmpeg-mt/ffmpeg-core.worker.js';

// The multithreaded core needs SharedArrayBuffer (cross-origin isolation,
// which the app sets up) and spreads filters and encoders over CPU cores.
const MULTITHREAD = self.crossOriginIsolated === true && typeof SharedArrayBuffer !== 'undefined' &&
  (self.navigator?.hardwareConcurrency ?? 1) > 1 && !String(self.name).endsWith('-st');
const resolve = (asset) => new URL(asset, self.location.href).href;
const WASM_URL = resolve(MULTITHREAD ? mtWasmAsset : wasmAsset);
const WASM_BYTES = MULTITHREAD ? 32_718_323 : 32_232_419;

let corePromise = null;
let queue = Promise.resolve();

async function fetchWasm() {
  const response = await fetch(WASM_URL);
  if (!response.ok) throw new Error(`Could not load FFmpeg (HTTP ${response.status}).`);
  const total = Number(response.headers.get('content-length')) || WASM_BYTES;
  if (!response.body) return new Uint8Array(await response.arrayBuffer());
  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;
  let lastPost = 0;
  self.postMessage({ type: 'load', loaded: 0, total });
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    const now = performance.now();
    if (now - lastPost > 100) {
      lastPost = now;
      self.postMessage({ type: 'load', loaded, total: Math.max(total, loaded) });
    }
  }
  self.postMessage({ type: 'load', loaded, total: loaded });
  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function getCore() {
  if (!corePromise) {
    corePromise = (async () => {
      const wasmBinary = await fetchWasm();
      // ffmpeg-core's locateFile reads a base64 JSON payload after the '#'
      // rather than using a normal Emscripten locateFile callback. Thread
      // workers import the same URL, so it must point at the core script.
      let core;
      if (MULTITHREAD) {
        const coreUrl = resolve(mtCoreAsset);
        const info = btoa(JSON.stringify({ wasmURL: WASM_URL, workerURL: resolve(mtWorkerAsset) }));
        const { default: createCore } = await import(/* @vite-ignore */ coreUrl);
        core = await createCore({ mainScriptUrlOrBlob: `${coreUrl}#${info}`, wasmBinary });
      } else {
        const info = btoa(JSON.stringify({ wasmURL: WASM_URL }));
        core = await createSingleThreadCore({ mainScriptUrlOrBlob: `${self.location.href}#${info}`, wasmBinary });
      }
      self.postMessage({ type: 'ready', threads: MULTITHREAD });
      try { core.FS.mkdir('/in'); } catch { /* exists */ }
      try { core.FS.mkdir('/work'); } catch { /* exists */ }
      core.FS.chdir('/work');
      return core;
    })();
    corePromise.catch(() => { corePromise = null; });
  }
  return corePromise;
}

/**
 * The multithreaded core has a fixed pool of 32 thread workers and cannot
 * spawn more while a command runs, so FFmpeg's automatic thread count (which
 * can exceed the pool on many-core machines) deadlocks. Cap decoders, filters,
 * and encoders explicitly.
 */
const THREADS = String(Math.max(2, Math.min(4, self.navigator?.hardwareConcurrency ?? 4)));
function withThreadCap(args) {
  if (!MULTITHREAD || args.includes('-threads')) return args;
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    // Each decoder would otherwise take a thread per core; two inputs can
    // exhaust the pool. Two threads per input is plenty for decoding.
    if (args[i] === '-i') out.push('-threads', '2');
    // Filter graphs keep their own thread pool sized to the core count; one
    // thread there is what avoids the deadlock (codecs still use THREADS).
    if (i === args.length - 1) out.push('-threads', THREADS, '-filter_threads', '1', '-filter_complex_threads', '1');
    out.push(args[i]);
  }
  return out;
}

function removeIfPresent(core, name) {
  try {
    core.FS.unlink(name);
  } catch {
    // The file was never created.
  }
}

function mountInputs(core, inputs) {
  const files = inputs.map(({ name, blob }) => new File([blob], name));
  try {
    core.FS.mount(core.FS.filesystems.WORKERFS, { files }, '/in');
    for (const { name } of inputs) core.FS.symlink(`/in/${name}`, `/work/${name}`);
    return true;
  } catch {
    try { core.FS.unmount('/in'); } catch { /* not mounted */ }
    return false;
  }
}

async function writeInputs(core, inputs) {
  if (mountInputs(core, inputs)) return true;
  for (const { name, blob } of inputs) core.FS.writeFile(name, new Uint8Array(await blob.arrayBuffer()));
  return false;
}

function cleanup(core, inputs, texts, output, mounted) {
  for (const { name } of inputs) removeIfPresent(core, name);
  for (const { name } of texts) removeIfPresent(core, name);
  if (output) removeIfPresent(core, output);
  if (mounted) {
    try { core.FS.unmount('/in'); } catch { /* already gone */ }
  }
}

async function handle(data) {
  const { id, kind, inputs = [], texts = [], args = [], output, duration } = data;
  let core = null;
  let mounted = false;
  const logs = [];

  try {
    core = await getCore();
    core.setLogger(({ type, message: raw }) => {
      const message = String(raw ?? '');
      if (kind === 'probe') {
        logs.push(message);
        return;
      }
      if (type !== 'stderr') return;
      logs.push(message);
      if (logs.length > 14) logs.shift();
    });
    let lastPost = 0;
    core.setProgress(({ progress, time }) => {
      if (kind !== 'run') return;
      const now = performance.now();
      if (now - lastPost < 120) return;
      lastPost = now;
      const seconds = Number(time) / 1_000_000;
      let ratio = null;
      if (duration > 0 && Number.isFinite(seconds) && seconds > 0) ratio = seconds / duration;
      else if (Number.isFinite(progress) && progress > 0) ratio = progress;
      self.postMessage({ id, type: 'progress', ratio: ratio === null ? null : Math.min(1, ratio), time: seconds });
    });

    mounted = await writeInputs(core, inputs);
    for (const { name, content } of texts) core.FS.writeFile(name, content);

    if (kind === 'probe') {
      // The log level persists inside the core between commands, so probes
      // must raise it again to see the stream summary.
      core.exec('-hide_banner', '-loglevel', 'info', ...inputs.flatMap(({ name }) => ['-i', name]));
      self.postMessage({ id, type: 'log', log: logs.join('\n') });
      return;
    }

    removeIfPresent(core, output);
    core.exec('-hide_banner', '-loglevel', 'error', '-stats', ...withThreadCap(args));
    const code = core.ret;
    if (code !== 0) {
      throw new Error(logs.filter((line) => !line.startsWith('Aborted(')).join(' ') || `FFmpeg exited with code ${code}.`);
    }
    const bytes = core.FS.readFile(output);
    self.postMessage({ id, type: 'done', bytes }, [bytes.buffer]);
  } catch (error) {
    if (!core || error instanceof WebAssembly.RuntimeError) corePromise = null;
    self.postMessage({ id, type: 'error', error: String((error && error.message) || error) });
  } finally {
    if (core) {
      try { core.reset(); } catch { /* core is unusable; it reloads next time */ }
      cleanup(core, inputs, texts, output, mounted);
    }
  }
}

self.onmessage = ({ data }) => {
  // FFmpeg's single core cannot run two commands at once, so jobs queue.
  queue = queue.then(() => handle(data));
};
