/**
 * Document studio: open + OCR (PP-OCR, every page) on text and scanned PDFs of
 * 3, 30 and 200 pages, redacted PDF build, and the privacy batch of 100 files.
 *
 *   bun bench/doc-fixtures.ts
 *   bun run dev -- --host 127.0.0.1 --port 5174
 *   bun bench/documents.mjs [--runs 3] [--pages 3,30,200]
 *
 * One temporary profile for the whole run (the OCR model downloads once; the
 * first OCR is reported as cold). Deleted afterwards.
 */
const { chromium } = await import(process.env.BENCH_PLAYWRIGHT ?? 'playwright');
import { mkdirSync, writeFileSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : fallback;
};
const BASE = process.env.BENCH_URL ?? 'http://127.0.0.1:5174';
const runs = Number(opt('runs', '3'));
const pageCounts = opt('pages', '3,30,200').split(',').map(Number);
const kinds = opt('kinds', 'text,scanned').split(',');
const GPU_ARGS = ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'];
const D = (name) => resolve('temp/perf/fixtures/docs', name);

const profile = mkdtempSync(join(tmpdir(), 'ls-doc-'));
const context = await chromium.launchPersistentContext(profile, { headless: true, args: GPU_ARGS, viewport: { width: 1480, height: 1000 }, acceptDownloads: true });
await context.addInitScript(() => {
  try { Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true }); } catch {}
  window.__lt = [];
  try { new PerformanceObserver((list) => window.__lt.push(...list.getEntries().map((e) => e.duration))).observe({ type: 'longtask' }); } catch {}
});
const page = context.pages()[0] ?? await context.newPage();
page.on('dialog', (d) => d.accept());
const status = () => page.evaluate(() => document.querySelector('#doc-status')?.textContent ?? '');
const tasks = () => page.evaluate(() => { const t = window.__lt; window.__lt = []; return { longTasks: t.length, longTaskMs: Math.round(t.reduce((s, x) => s + x, 0)), longTaskMax: Math.round(Math.max(0, ...t)) }; });
const env = await (async () => {
  await page.goto(`${BASE}/?ui=en#/documents`, { waitUntil: 'load' });
  return page.evaluate(async () => { const a = navigator.gpu ? await navigator.gpu.requestAdapter() : null; return { userAgent: navigator.userAgent, gpuAdapter: a ? { vendor: a.info.vendor, architecture: a.info.architecture } : null }; });
})();

const results = { env, ocr: [], privacy: [] };
let first = true;
for (const kind of kinds) {
  for (const pages of pageCounts) {
    const file = D(`${kind}-${pages}p.pdf`);
    for (let run = 0; run < (pages >= 200 ? Math.min(runs, 2) : runs); run += 1) {
      await page.goto(`${BASE}/?ui=en#/documents`, { waitUntil: 'load' });
      await page.waitForSelector('#doc-input', { state: 'attached' });
      await tasks();
      const t0 = Date.now();
      await page.setInputFiles('#doc-input', file);
      await page.waitForFunction(() => /ready\. Run OCR|could not|error/i.test(document.querySelector('#doc-status')?.textContent ?? ''), null, { timeout: 600000, polling: 50 });
      const openMs = Date.now() - t0;
      const openTasks = await tasks();
      const t1 = Date.now();
      await page.click('#doc-ocr');
      await page.waitForFunction(() => /found|No text found|error|failed/i.test(document.querySelector('#doc-status')?.textContent ?? '') && !/Finding text|Loading|Downloading/.test(document.querySelector('#doc-status')?.textContent ?? ''), null, { timeout: 3600000, polling: 100 });
      const ocrMs = Date.now() - t1;
      const ocrStatus = await status();
      const ocrTasks = await tasks();
      // Auto-select sensitive lines, then build the redacted PDF.
      let pdfMs = null;
      let pdfBytes = null;
      try {
        await page.click('#doc-pii');
        await page.waitForTimeout(200);
        const download = page.waitForEvent('download', { timeout: 1800000 });
        const t2 = Date.now();
        await page.click('#doc-download-pdf');
        const saved = await download;
        pdfMs = Date.now() - t2;
        const target = join(tmpdir(), `ls-doc-${Date.now()}.pdf`);
        await saved.saveAs(target);
        const { statSync } = await import('node:fs');
        pdfBytes = statSync(target).size;
        rmSync(target, { force: true });
      } catch (error) {
        pdfMs = String(error).split('\n')[0];
      }
      const heapMB = await page.evaluate(() => performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null);
      const sample = { kind, pages, run, label: first ? 'cold (model download)' : 'warm', openMs, openTasks, ocrMs, perPageMs: Math.round(ocrMs / pages), ocrStatus: ocrStatus.slice(0, 120), ocrTasks, redactedPdfMs: pdfMs, redactedPdfMB: pdfBytes && +(pdfBytes / 1048576).toFixed(2), heapMB };
      first = false;
      results.ocr.push(sample);
      console.error(JSON.stringify(sample));
    }
  }
}

// Privacy batch: 100 mixed files, each action.
const batch = readdirSync(D('privacy-100')).map((name) => join(D('privacy-100'), name));
for (const action of ['strip', 'checksums', 'rename', 'all']) {
  for (let run = 0; run < runs; run += 1) {
    await page.goto(`${BASE}/?ui=en#/documents`, { waitUntil: 'load' });
    await page.waitForSelector('#doc-privacy-input', { state: 'attached' });
    await page.setInputFiles('#doc-privacy-input', batch);
    await page.selectOption('#doc-privacy-action', action);
    await tasks();
    const t0 = Date.now();
    await page.click('#doc-privacy-run');
    await page.waitForFunction(() => {
      const text = document.querySelector('#doc-privacy-status')?.textContent ?? '';
      return text && !/Processing|Working|…/.test(text);
    }, null, { timeout: 600000, polling: 50 });
    const ms = Date.now() - t0;
    const sample = { action, run, files: batch.length, ms, status: (await page.evaluate(() => document.querySelector('#doc-privacy-status')?.textContent ?? '')).slice(0, 120), ...(await tasks()) };
    results.privacy.push(sample);
    console.error(JSON.stringify(sample));
  }
}
await context.close();
try { rmSync(profile, { recursive: true, force: true }); } catch { await new Promise((r) => setTimeout(r, 2000)); try { rmSync(profile, { recursive: true, force: true }); } catch { console.error('could not delete', profile); } }
mkdirSync('temp/perf/results', { recursive: true });
writeFileSync('temp/perf/results/documents.json', JSON.stringify({ benchmark: 'documents', base: BASE, ...results }, null, 2));
console.log(JSON.stringify(results, null, 2));
