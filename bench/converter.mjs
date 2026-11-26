/**
 * File converter: single files per category and image batches of 50 and 300,
 * plus the ZIP build. Conversions in the app run one at a time.
 *
 *   bun run dev -- --host 127.0.0.1 --port 5174
 *   bun bench/converter.mjs [--runs 3]
 *
 * One temporary profile per case (deleted afterwards). Wall time is Convert
 * All to the last row completed; ZIP time is the click to the download event.
 */
const { chromium } = await import(process.env.BENCH_PLAYWRIGHT ?? 'playwright');
import { mkdirSync, writeFileSync, mkdtempSync, rmSync, copyFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : fallback;
};
const BASE = process.env.BENCH_URL ?? 'http://127.0.0.1:5174';
const runs = Number(opt('runs', '3'));
const GPU_ARGS = ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'];
const F = (name) => resolve('temp/perf/fixtures', name);

// Batch inputs: distinct file names of the same 1 MP JPEG.
const batchDir = resolve('temp/perf/fixtures/batch');
mkdirSync(batchDir, { recursive: true });
const batchFiles = Array.from({ length: 300 }, (_, index) => {
  const target = join(batchDir, `photo-${String(index + 1).padStart(3, '0')}.jpg`);
  if (!existsSync(target)) copyFileSync(F('image-1mp.jpg'), target);
  return target;
});

const CASES = [
  { name: 'image jpg to png, 1 file 12 MP', files: [F('image-12mp.jpg')], search: 'png' },
  { name: 'image jpg to webp, 1 file 12 MP', files: [F('image-12mp.jpg')], search: 'webp' },
  { name: 'image jpg to avif, 1 file 1 MP', files: [F('image-1mp.jpg')], search: 'avif' },
  { name: 'audio wav to mp3, 5 min', files: [F('speech-5min.wav')], search: 'mp3' },
  { name: 'audio wav to flac, 5 min', files: [F('speech-5min.wav')], search: 'flac' },
  { name: 'audio flac to ogg, 5 min', files: [F('speech-5min.flac')], search: 'ogg' },
  { name: 'video mp4 to webm, 1080p 10 s', files: [F('v1080p30-10s.mp4')], search: 'webm' },
  { name: 'video mp4 to mov, 1080p 10 s', files: [F('v1080p30-10s.mp4')], search: 'mov' },
  { name: 'video avi to mp4 (FFmpeg)', files: [F('legacy.avi')], search: 'mp4' },
  { name: 'image batch 50 jpg to webp', files: batchFiles.slice(0, 50), search: 'webp', zip: true },
  { name: 'image batch 300 jpg to webp', files: batchFiles, search: 'webp', zip: true, runs: 1 },
];

const results = [];
for (const testCase of CASES) {
  const samples = [];
  for (let run = 0; run < (testCase.runs ?? runs); run += 1) {
    const profile = mkdtempSync(join(tmpdir(), 'ls-conv-'));
    const context = await chromium.launchPersistentContext(profile, { headless: true, args: GPU_ARGS, viewport: { width: 1480, height: 1000 }, acceptDownloads: true });
    await context.addInitScript(() => {
      window.__lt = [];
      try { new PerformanceObserver((list) => window.__lt.push(...list.getEntries().map((e) => e.duration))).observe({ type: 'longtask' }); } catch {}
    });
    const page = context.pages()[0] ?? await context.newPage();
    const ffmpegCore = [];
    page.on('request', (request) => { if (/ffmpeg-core|ffmpeg-mt|core-mt/.test(request.url())) ffmpegCore.push(request.url()); });
    let sample;
    try {
      await page.goto(`${BASE}/?ui=en#/converter`, { waitUntil: 'load' });
      await page.waitForSelector('#converter-file-input', { state: 'attached' });
      const addStart = Date.now();
      await page.setInputFiles('#converter-file-input', testCase.files);
      await page.waitForFunction((n) => document.querySelectorAll('#converter-queue-list [data-queue-id]').length >= n, testCase.files.length, { timeout: 120000 });
      const addMs = Date.now() - addStart;
      await page.click('#converter-batch-target-btn');
      await page.fill('#converter-format-search', testCase.search);
      await page.waitForTimeout(150);
      const label = await page.locator('#converter-format-grid button').first().textContent();
      await page.locator('#converter-format-grid button').first().click();
      await page.waitForFunction(() => !document.querySelector('#converter-convert-all').disabled, null, { timeout: 30000 });
      await page.evaluate(() => { window.__lt = []; });
      const start = Date.now();
      await page.click('#converter-convert-all');
      await page.waitForFunction((n) => {
        const rows = [...document.querySelectorAll('#converter-queue-list [data-queue-id]')];
        const finished = rows.filter((row) => /%\)|Failed|failed/.test(row.textContent)).length;
        return finished >= n && document.querySelector('#converter-cancel-all').classList.contains('hidden');
      }, testCase.files.length, { timeout: 3600000, polling: 100 });
      const ms = Date.now() - start;
      const info = await page.evaluate(() => ({
        failed: [...document.querySelectorAll('#converter-queue-list [data-queue-id]')].filter((row) => /Failed|failed/.test(row.textContent)).length,
        firstRow: document.querySelector('#converter-queue-list [data-queue-id]')?.textContent.replace(/\s+/g, ' ').trim().slice(0, 160),
        longTasks: window.__lt.length, longTaskMs: Math.round(window.__lt.reduce((s, t) => s + t, 0)), longTaskMax: Math.round(Math.max(0, ...window.__lt)),
        heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null,
      }));
      sample = { run, target: label.replace(/\s+/g, ' ').trim().slice(0, 40), addMs, ms, perFileMs: +(ms / testCase.files.length).toFixed(1), ffmpegCore: ffmpegCore.length > 0, ...info };
      if (testCase.zip) {
        const t0 = Date.now();
        const download = page.waitForEvent('download', { timeout: 600000 });
        await page.click('#converter-download-zip');
        const saved = await download;
        sample.zipMs = Date.now() - t0;
        const target = join(tmpdir(), `ls-conv-${Date.now()}.zip`);
        await saved.saveAs(target);
        const { statSync } = await import('node:fs');
        sample.zipMB = +(statSync(target).size / 1048576).toFixed(1);
        rmSync(target, { force: true });
      }
    } catch (error) {
      sample = { run, error: String(error).split('\n')[0] };
    }
    samples.push(sample);
    await context.close();
    try { rmSync(profile, { recursive: true, force: true }); } catch { await new Promise((r) => setTimeout(r, 1500)); try { rmSync(profile, { recursive: true, force: true }); } catch { console.error('could not delete', profile); } }
  }
  const times = samples.map((s) => s.ms).filter((v) => typeof v === 'number').sort((a, b) => a - b);
  const row = { name: testCase.name, files: testCase.files.length, median: times[Math.floor(times.length / 2)] ?? null, min: times[0] ?? null, max: times[times.length - 1] ?? null, samples };
  results.push(row);
  console.error(`${row.name}: median ${row.median} ms (min ${row.min}, max ${row.max}) per file ${samples[0]?.perFileMs} · zip ${samples[0]?.zipMs ?? '-'} ms · ffmpeg ${samples[0]?.ffmpegCore} · ${samples[0]?.error ?? samples[0]?.firstRow ?? ''}`);
}
mkdirSync('temp/perf/results', { recursive: true });
writeFileSync('temp/perf/results/converter.json', JSON.stringify({ benchmark: 'converter', base: BASE, results }, null, 2));
console.log(JSON.stringify(results.map(({ samples, ...row }) => ({ ...row, first: samples[0] })), null, 2));
