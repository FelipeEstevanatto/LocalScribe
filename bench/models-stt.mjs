/**
 * Speech to text through the real Transcribe view: cold download, warm run,
 * cached on disk after a reload, and speed on 30 s, 5 min and 30 min.
 *
 *   bun run dev -- --host 127.0.0.1 --port 5174     (or the production preview with BENCH_URL)
 *   bun bench/perf-fixtures.ts --set full
 *   bun bench/models-stt.mjs --model moonshine-tiny --variant q8 --device webgpu,cpu --runs 3
 *
 * One temporary profile per model and device (deleted at the end), so the
 * first run is a true cold download. Phases come from the UI: download panel
 * visible, inference panel visible, and the run-stats line the app prints
 * (decode time, real-time factor, backend, model load time).
 */
const { chromium } = await import(process.env.BENCH_PLAYWRIGHT ?? 'playwright');
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : fallback;
};
const BASE = process.env.BENCH_URL ?? 'http://127.0.0.1:5174';
const model = opt('model', 'moonshine-tiny');
const variant = opt('variant', '');
const devices = opt('device', 'webgpu,cpu').split(',');
const runs = Number(opt('runs', '3'));
const lengths = opt('lengths', '30s,5min,30min').split(',');
const cpu = Number(opt('cpu', '1'));
const GPU_ARGS = ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'];
const fixture = (length) => resolve(`temp/perf/fixtures/speech-${length}.wav`);

const POLL = () => {
  window.__phase = { t0: 0, downloadFirst: null, downloadLast: null, inferenceFirst: null, inferenceLast: null };
  const visible = (id) => { const el = document.getElementById(id); return el && !el.classList.contains('hidden') && el.offsetParent !== null; };
  setInterval(() => {
    const p = window.__phase;
    if (!p.t0) return;
    const now = performance.now() - p.t0;
    if (visible('download-progress')) { p.downloadFirst ??= now; p.downloadLast = now; }
    if (visible('inference-progress')) { p.inferenceFirst ??= now; p.inferenceLast = now; }
  }, 25);
};

async function transcribe(page, file) {
  await page.setInputFiles('#file-input', file);
  await page.waitForFunction(() => !document.getElementById('transcribe-btn').disabled, null, { timeout: 60000 });
  await page.evaluate(() => {
    document.getElementById('run-stats').textContent = '';
    window.__lt = [];
    window.__phase.downloadFirst = window.__phase.downloadLast = window.__phase.inferenceFirst = window.__phase.inferenceLast = null;
    window.__phase.t0 = performance.now();
    window.__usage0 = null;
    navigator.storage.estimate().then((e) => { window.__usage0 = e.usage; });
  });
  const start = Date.now();
  await page.click('#transcribe-btn');
  await page.waitForFunction(() => {
    const stats = document.getElementById('run-stats');
    const error = document.getElementById('error-banner');
    return (stats && !stats.classList.contains('hidden') && stats.textContent.trim()) || (error && !error.classList.contains('hidden'));
  }, null, { timeout: 3 * 3600_000, polling: 100 });
  const wallMs = Date.now() - start;
  return page.evaluate(async (wallMs) => {
    const text = document.getElementById('transcript').value ?? '';
    const error = document.getElementById('error-banner');
    const usage = (await navigator.storage.estimate()).usage;
    const tasks = window.__lt ?? [];
    return {
      wallMs,
      stats: document.getElementById('run-stats').textContent.trim(),
      error: error && !error.classList.contains('hidden') ? error.textContent.trim().slice(0, 300) : null,
      phase: { ...window.__phase, t0: undefined },
      words: (text.match(/\S+/g) ?? []).length,
      head: text.slice(0, 160),
      storageDeltaMB: window.__usage0 != null ? +((usage - window.__usage0) / 1048576).toFixed(1) : null,
      longTasks: tasks.length,
      longTaskMs: Math.round(tasks.reduce((s, t) => s + t, 0)),
      heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null,
    };
  }, wallMs);
}

function parseStats(stats) {
  const decode = /([\d.]+) s decode/.exec(stats)?.[1];
  const rtf = /([\d.]+)× real time/.exec(stats)?.[1];
  const load = /([\d.]+) s model load/.exec(stats)?.[1];
  const backend = stats.split('·').map((s) => s.trim()).find((s) => /webgpu|wasm|cpu/i.test(s)) ?? null;
  return { decodeS: decode ? Number(decode) : null, realtimeX: rtf ? Number(rtf) : null, loadS: load ? Number(load) : null, backend };
}

const results = [];
for (const device of devices) {
  const profile = mkdtempSync(join(tmpdir(), 'ls-stt-'));
  const context = await chromium.launchPersistentContext(profile, { headless: true, args: GPU_ARGS, viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(POLL);
  await context.addInitScript(() => {
    window.__lt = [];
    try { new PerformanceObserver((list) => window.__lt.push(...list.getEntries().map((e) => e.duration))).observe({ type: 'longtask' }); } catch {}
  });
  const page = context.pages()[0] ?? await context.newPage();
  page.on('dialog', (d) => d.accept());
  const cdp = await context.newCDPSession(page);
  if (cpu > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
  const open = async () => {
    await page.goto(`${BASE}/?ui=en#/transcribe`, { waitUntil: 'load' });
    await page.waitForSelector('#model-select');
    await page.selectOption('#model-select', model);
    if (variant) await page.selectOption('#variant-select', variant).catch(() => undefined);
    await page.click(device === 'cpu' ? '#device-cpu' : '#device-webgpu').catch(() => undefined);
    await page.waitForTimeout(500);
  };
  await open();
  const env = await page.evaluate(async () => {
    const a = navigator.gpu ? await navigator.gpu.requestAdapter() : null;
    return { userAgent: navigator.userAgent, crossOriginIsolated, hardwareConcurrency: navigator.hardwareConcurrency, gpuAdapter: a ? { vendor: a.info.vendor, architecture: a.info.architecture } : null };
  });
  const row = { model, variant: variant || 'default', device, env, cpuThrottle: cpu, cases: [] };
  const record = async (label, length) => {
    const sample = await transcribe(page, fixture(length));
    Object.assign(sample, parseStats(sample.stats));
    row.cases.push({ label, length, ...sample });
    console.error(`${model}/${variant} ${device} ${label} ${length}: wall ${sample.wallMs} ms · ${sample.stats}${sample.error ? ' · ERROR ' + sample.error : ''}`);
    return sample;
  };
  // Cold: empty profile, includes the download and session creation.
  const cold = await record('cold', '30s');
  if (!cold.error) {
    await record('warm', '30s');
    // Cached on disk but not in memory.
    await open();
    await record('disk-cached', '30s');
    for (const length of lengths) {
      for (let run = 0; run < (length === '30min' ? Math.min(runs, 3) : runs); run += 1) await record('speed', length);
    }
  }
  results.push(row);
  await context.close();
  try { rmSync(profile, { recursive: true, force: true }); } catch { await new Promise((r) => setTimeout(r, 2000)); try { rmSync(profile, { recursive: true, force: true }); } catch { console.error('could not delete', profile); } }
}

mkdirSync('temp/perf/results', { recursive: true });
const name = `temp/perf/results/stt-${model}-${variant || 'default'}${cpu > 1 ? `-cpu${cpu}` : ''}.json`;
writeFileSync(name, JSON.stringify({ benchmark: 'stt', base: BASE, results }, null, 2));
console.log(JSON.stringify(results.map((r) => ({ device: r.device, cases: r.cases.map((c) => ({ label: c.label, length: c.length, wallMs: c.wallMs, decodeS: c.decodeS, realtimeX: c.realtimeX, loadS: c.loadS, backend: c.backend, words: c.words, error: c.error })) })), null, 2));
