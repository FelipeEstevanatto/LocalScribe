/**
 * Models and storage cache scan, and History with 1,000 seeded entries.
 *
 *   bun run dev -- --host 127.0.0.1 --port 5174
 *   bun bench/storage.mjs
 *
 * Runs bench/storage-page.ts in a fresh temporary profile (deleted afterwards).
 */
const { chromium } = await import(process.env.BENCH_PLAYWRIGHT ?? 'playwright');
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const BASE = process.env.BENCH_URL ?? 'http://127.0.0.1:5174';
const profile = mkdtempSync(join(tmpdir(), 'ls-store-'));
const context = await chromium.launchPersistentContext(profile, { headless: true, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'] });
const page = context.pages()[0] ?? await context.newPage();
await page.goto(`${BASE}/?ui=en#/home`, { waitUntil: 'load' });
const out = await page.evaluate(async () => {
  const bench = await import('/bench/storage-page.ts');
  const scans = [];
  for (const contentLength of [true, false]) scans.push(await bench.cacheScan({ repos: 12, filesPerRepo: 3, mb: 20, contentLength }));
  scans.push(await bench.cacheScan({ repos: 4, filesPerRepo: 2, mb: 150, contentLength: false }));
  const history = await bench.history(1000);
  return { scans, history };
});
// Open the History view with 50 stored entries and the Models view.
for (const route of ['#/history', '#/models']) {
  const t0 = Date.now();
  await page.goto(`${BASE}/?ui=en${route}`, { waitUntil: 'load' });
  await page.waitForTimeout(800);
  out[`open ${route}`] = { wallMs: Date.now() - t0, domNodes: await page.evaluate(() => document.getElementsByTagName('*').length) };
}
await context.close();
try { rmSync(profile, { recursive: true, force: true }); } catch { await new Promise((r) => setTimeout(r, 2000)); try { rmSync(profile, { recursive: true, force: true }); } catch {} }
mkdirSync('temp/perf/results', { recursive: true });
writeFileSync('temp/perf/results/storage.json', JSON.stringify({ benchmark: 'storage', base: BASE, ...out }, null, 2));
console.log(JSON.stringify(out, null, 2));
