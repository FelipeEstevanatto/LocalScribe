/**
 * Audio studio stem separation (HTDemucs) through the real view.
 *
 *   ffmpeg -i temp/perf/fixtures/music-3min.wav -t 30 temp/perf/fixtures/music-30s.wav
 *   bun run dev -- --host 127.0.0.1 --port 5174
 *   bun bench/studio.mjs [--runs 2]
 *
 * One temporary profile (deleted afterwards). The first separation of each
 * model is cold (download + session); later ones reuse the cache. Cases: 2, 4
 * and 6 stems, Standard (fp16) and Full (fp32) for 4 stems, 1/2/3 passes, on
 * 30 s and 3 min of 44.1 kHz stereo music. Wall time is Separate click to
 * "Done." in the status line (stems loaded for playback).
 */
const { chromium } = await import(process.env.BENCH_PLAYWRIGHT ?? 'playwright');
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const argv = process.argv.slice(2);
const opt = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : fallback; };
const BASE = process.env.BENCH_URL ?? 'http://127.0.0.1:5174';
const runs = Number(opt('runs', '2'));
const GPU_ARGS = ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'];
const F = (name) => resolve('temp/perf/fixtures', name);

const CASES = [
  // [label, mode, variant, passes, file, repeats]
  ['cold vocals fp16 1 pass', 'vocals', 'fp16', '1', 'music-30s.wav', 1],
  ['vocals fp16 1 pass', 'vocals', 'fp16', '1', 'music-30s.wav', runs],
  ['4 stems fp16 1 pass', 'stems', 'fp16', '1', 'music-30s.wav', runs],
  ['4 stems fp16 2 passes', 'stems', 'fp16', '2', 'music-30s.wav', 1],
  ['4 stems fp16 3 passes', 'stems', 'fp16', '3', 'music-30s.wav', 1],
  ['cold 4 stems fp32 1 pass', 'stems', 'fp32', '1', 'music-30s.wav', 1],
  ['4 stems fp32 1 pass', 'stems', 'fp32', '1', 'music-30s.wav', runs],
  ['cold 6 stems fp16 1 pass', 'stems6', 'fp16', '1', 'music-30s.wav', 1],
  ['6 stems fp16 1 pass', 'stems6', 'fp16', '1', 'music-30s.wav', runs],
  ['vocals fp16 1 pass 3 min', 'vocals', 'fp16', '1', 'music-3min.wav', 1],
  ['4 stems fp16 1 pass 3 min', 'stems', 'fp16', '1', 'music-3min.wav', 1],
  ['6 stems fp16 1 pass 3 min', 'stems6', 'fp16', '1', 'music-3min.wav', 1],
];

const profile = mkdtempSync(join(tmpdir(), 'ls-studio-'));
const context = await chromium.launchPersistentContext(profile, { headless: true, args: GPU_ARGS, viewport: { width: 1480, height: 1000 } });
await context.addInitScript(() => {
  window.__lt = [];
  try { new PerformanceObserver((list) => window.__lt.push(...list.getEntries().map((e) => e.duration))).observe({ type: 'longtask' }); } catch {}
});
const page = context.pages()[0] ?? await context.newPage();
page.on('dialog', (d) => d.accept());
const results = [];
let loaded = null;
for (const [label, mode, variant, passes, file, repeats] of CASES) {
  for (let run = 0; run < repeats; run += 1) {
    let sample = { label, mode, variant, passes, file, run };
    try {
      if (loaded !== file) {
        await page.goto(`${BASE}/?ui=en#/audio`, { waitUntil: 'load' });
        await page.waitForSelector('#studio-input', { state: 'attached' });
        await page.setInputFiles('#studio-input', F(file));
        await page.waitForFunction(() => !document.querySelector('#studio-separate')?.disabled, null, { timeout: 120000 });
        loaded = file;
      }
      await page.click(`[data-stem-mode="${mode}"]`);
      await page.selectOption('#studio-model-variant', variant);
      await page.selectOption('#studio-passes', passes);
      await page.evaluate(() => { window.__lt = []; document.querySelector('#studio-status').textContent = ''; window.__phase = { download: null, separate: null, t0: performance.now() };
        window.__poll = setInterval(() => { const l = document.querySelector('#studio-progress-label')?.textContent ?? ''; const now = performance.now() - window.__phase.t0; if (/Downloading/.test(l)) window.__phase.download = now; if (/Separat|Removing|Splitting|pass/i.test(l) && window.__phase.separate == null) window.__phase.separate = now; }, 50); });
      const t0 = Date.now();
      await page.click('#studio-separate');
      await page.waitForFunction(() => /^Done\.|error|failed|could not/i.test(document.querySelector('#studio-status')?.textContent ?? ''), null, { timeout: 3600000, polling: 100 });
      sample.ms = Date.now() - t0;
      Object.assign(sample, await page.evaluate(() => { clearInterval(window.__poll); const t = window.__lt; return {
        status: document.querySelector('#studio-status')?.textContent?.trim().slice(0, 100),
        downloadEndMs: window.__phase.download && Math.round(window.__phase.download), separateStartMs: window.__phase.separate && Math.round(window.__phase.separate),
        stems: document.querySelectorAll('.stem-row').length,
        longTasks: t.length, longTaskMs: Math.round(t.reduce((s, x) => s + x, 0)), longTaskMax: Math.round(Math.max(0, ...t)),
        heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null,
      }; }));
    } catch (error) {
      sample.error = String(error).split('\n')[0];
      loaded = null;
    }
    results.push(sample);
    console.error(JSON.stringify(sample));
  }
}
const env = await page.evaluate(async () => { const a = navigator.gpu ? await navigator.gpu.requestAdapter() : null; return { userAgent: navigator.userAgent, gpuAdapter: a ? { vendor: a.info.vendor, architecture: a.info.architecture } : null, crossOriginIsolated }; }).catch(() => null);
await context.close();
try { rmSync(profile, { recursive: true, force: true }); } catch { await new Promise((r) => setTimeout(r, 2000)); try { rmSync(profile, { recursive: true, force: true }); } catch { console.error('could not delete', profile); } }
mkdirSync('temp/perf/results', { recursive: true });
writeFileSync('temp/perf/results/studio.json', JSON.stringify({ benchmark: 'studio', base: BASE, env, results }, null, 2));
console.log(JSON.stringify(results, null, 2));
