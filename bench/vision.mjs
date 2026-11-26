/**
 * Vision studio through the real view: background removal (BiRefNet FP16),
 * object detection (D-FINE, Q8 when offered) and OCR (PP-OCR) on 1, 12 and
 * 48 MP images, WebGPU and WASM.
 *
 *   bun bench/perf-fixtures.ts --set full
 *   bun run dev -- --host 127.0.0.1 --port 5174
 *   bun bench/vision.mjs [--runs 3] [--devices webgpu,wasm]
 *
 * One temporary profile per device (deleted afterwards), so the first run of
 * each task is cold (download + session). Wall time is Run to "Result ready.".
 */
const { chromium } = await import(process.env.BENCH_PLAYWRIGHT ?? 'playwright');
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const argv = process.argv.slice(2);
const opt = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : fallback; };
const BASE = process.env.BENCH_URL ?? 'http://127.0.0.1:5174';
const runs = Number(opt('runs', '3'));
const devices = opt('devices', 'webgpu,wasm').split(',');
const GPU_ARGS = ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'];
const IMAGES = { '1mp': resolve('temp/perf/fixtures/image-1mp.jpg'), '12mp': resolve('temp/perf/fixtures/image-12mp.jpg'), '48mp': resolve('temp/perf/fixtures/image-48mp.jpg') };
const TASKS = [
  { task: 'background-removal', precision: 'fp16' },
  { task: 'object-detection', precision: 'q8' },
  { task: 'ocr', precision: null },
];

const results = [];
for (const device of devices) {
  const profile = mkdtempSync(join(tmpdir(), 'ls-vision-'));
  const context = await chromium.launchPersistentContext(profile, { headless: true, args: GPU_ARGS, viewport: { width: 1480, height: 1000 } });
  await context.addInitScript(() => {
    window.__lt = [];
    try { new PerformanceObserver((list) => window.__lt.push(...list.getEntries().map((e) => e.duration))).observe({ type: 'longtask' }); } catch {}
  });
  const page = context.pages()[0] ?? await context.newPage();
  for (const { task, precision } of TASKS) {
    let first = true;
    for (const [size, file] of Object.entries(IMAGES)) {
      for (let run = 0; run < (first ? 1 : (size === '48mp' ? Math.min(2, runs) : runs)); run += 1) {
        const sample = { device, task, size, run, label: first ? 'cold' : 'warm' };
        try {
          await page.goto(`${BASE}/?ui=en#/vision`, { waitUntil: 'load' });
          await page.click(`[data-vision-task="${task}"]`);
          await page.waitForTimeout(200);
          await page.selectOption('#vision-device', device).catch(() => undefined);
          if (precision) await page.selectOption('#vision-precision', precision).catch(() => undefined);
          sample.model = await page.evaluate(() => document.querySelector('#vision-model')?.selectedOptions?.[0]?.textContent?.trim());
          sample.precision = await page.evaluate(() => document.querySelector('#vision-precision')?.value);
          const d0 = Date.now();
          await page.setInputFiles('#vision-input', file);
          await page.waitForFunction(() => /Image ready|Could not/.test(document.querySelector('#vision-status')?.textContent ?? ''), null, { timeout: 120000, polling: 50 });
          sample.decodeMs = Date.now() - d0;
          await page.evaluate(() => { window.__lt = []; });
          const t0 = Date.now();
          await page.click('#vision-run');
          await page.waitForFunction(() => /Result ready|failed/.test(document.querySelector('#vision-status')?.textContent ?? ''), null, { timeout: 1800000, polling: 50 });
          sample.ms = Date.now() - t0;
          Object.assign(sample, await page.evaluate(() => { const t = window.__lt; return {
            status: document.querySelector('#vision-status')?.textContent?.trim().slice(0, 140),
            summary: document.querySelector('#vision-summary')?.textContent?.trim().slice(0, 140),
            longTasks: t.length, longTaskMs: Math.round(t.reduce((s, x) => s + x, 0)), longTaskMax: Math.round(Math.max(0, ...t)),
          }; }));
        } catch (error) {
          sample.error = String(error).split('\n')[0];
        }
        first = false;
        results.push(sample);
        console.error(JSON.stringify(sample));
      }
    }
  }
  await context.close();
  try { rmSync(profile, { recursive: true, force: true }); } catch { await new Promise((r) => setTimeout(r, 2000)); try { rmSync(profile, { recursive: true, force: true }); } catch { console.error('could not delete', profile); } }
}
mkdirSync('temp/perf/results', { recursive: true });
writeFileSync('temp/perf/results/vision.json', JSON.stringify({ benchmark: 'vision', base: BASE, results }, null, 2));
console.log(JSON.stringify(results, null, 2));
