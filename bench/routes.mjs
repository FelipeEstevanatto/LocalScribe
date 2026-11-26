/**
 * Per-route first-open cost on the production build.
 *
 *   bun run build && bun run preview -- --host 127.0.0.1 --port 4173
 *   bun add -D playwright   (ask first; not installed by default)
 *   bun bench/routes.mjs [--cpu 4] [--runs 5]
 *
 * For each route, a fresh context with service workers blocked opens the app
 * at #/home, then switches to the route and records the new requests (chunks,
 * WASM, JSON, images), bytes, time until requests settle, long tasks, and DOM
 * size. A second pass opens every route directly (cold) and records
 * DOMContentLoaded, FCP, LCP and the startup long task.
 */
const { chromium } = await import(process.env.BENCH_PLAYWRIGHT ?? 'playwright');
import { mkdirSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : fallback;
};
const BASE = process.env.BENCH_URL ?? 'http://127.0.0.1:4173';
const cpu = Number(opt('cpu', '1'));
const runs = Number(opt('runs', '5'));
const ROUTES = ['#/transcribe', '#/tts', '#/audio', '#/tools', '#/tools?tool=video-converter', '#/tools?tool=image-converter', '#/tools?tool=background-remover',
  '#/vision', '#/documents', '#/converter', '#/record', '#/models', '#/history', '#/settings', '/video-editor/'];

const settle = `async (t0) => {
  let last = performance.getEntriesByType('resource').length, since = performance.now();
  while (performance.now() - since < 700 && performance.now() - t0 < 15000) {
    await new Promise((r) => setTimeout(r, 50));
    const n = performance.getEntriesByType('resource').length;
    if (n !== last) { last = n; since = performance.now(); }
  }
}`;

// Same GPU flags as bench/video-heavy.mjs: without them headless Chromium on Windows gets SwiftShader.
const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'], ...(process.env.BENCH_CHROME ? { executablePath: process.env.BENCH_CHROME } : {}) });
let adapter = null;
{
  const probe = await browser.newPage();
  await probe.goto(`${BASE}/robots.txt`);
  adapter = await probe.evaluate(async () => { const a = navigator.gpu && await navigator.gpu.requestAdapter(); return a ? { vendor: a.info.vendor, architecture: a.info.architecture } : null; });
  await probe.close();
  console.error('adapter', JSON.stringify(adapter), browser.version());
}
const results = [];
for (const route of ROUTES) {
  const samples = [];
  for (let run = 0; run <= runs; run += 1) {
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    if (cpu > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
    await page.addInitScript(() => {
      window.__lt = [];
      new PerformanceObserver((list) => window.__lt.push(...list.getEntries().map((e) => ({ start: e.startTime, duration: e.duration })))).observe({ type: 'longtask', buffered: true });
      window.__lcp = 0;
      new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__lcp = e.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true });
    });
    const direct = route.startsWith('/') ? `${BASE}${route}?ui=en` : `${BASE}/?ui=en#/home`;
    await page.goto(direct, { waitUntil: 'load' });
    const sample = await page.evaluate(async ({ route, settleSource }) => {
      const settle = eval(settleSource);
      await settle(performance.now());
      const nav = performance.getEntriesByType('navigation')[0];
      const base = {
        dcl: nav.domContentLoadedEventEnd,
        fcp: performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null,
        lcp: window.__lcp,
        startupLongTaskMax: Math.max(0, ...window.__lt.map((e) => e.duration)),
      };
      if (route.startsWith('/')) {
        const res = performance.getEntriesByType('resource');
        return { ...base, requests: res.length, transferKB: res.reduce((s, r) => s + r.transferSize, 0) / 1024, decodedKB: res.reduce((s, r) => s + r.decodedBodySize, 0) / 1024, domNodes: document.getElementsByTagName('*').length };
      }
      const before = performance.getEntriesByType('resource').length;
      const ltBefore = window.__lt.length;
      const t0 = performance.now();
      location.hash = route;
      await settle(t0);
      const added = performance.getEntriesByType('resource').slice(before);
      return {
        ...base,
        requests: added.length,
        transferKB: added.reduce((s, r) => s + r.transferSize, 0) / 1024,
        decodedKB: added.reduce((s, r) => s + r.decodedBodySize, 0) / 1024,
        settledMs: added.length ? Math.max(...added.map((a) => a.responseEnd)) - t0 : 0,
        longTaskMs: window.__lt.slice(ltBefore).reduce((s, e) => s + e.duration, 0),
        files: added.map((a) => a.name.split('/').pop()),
        domNodes: document.getElementsByTagName('*').length,
      };
    }, { route, settleSource: settle });
    if (run > 0) samples.push(sample);
    await context.close();
  }
  const median = (key) => {
    const values = samples.map((s) => s[key]).filter((v) => typeof v === 'number').sort((a, b) => a - b);
    return values.length ? +values[Math.floor(values.length / 2)].toFixed(1) : null;
  };
  results.push({ route, runs: samples.length, requests: samples[0].requests, transferKB: median('transferKB'), decodedKB: median('decodedKB'), settledMs: median('settledMs'), longTaskMs: median('longTaskMs'), dcl: median('dcl'), fcp: median('fcp'), lcp: median('lcp'), domNodes: median('domNodes'), files: samples[0].files });
}
const version = browser.version();
await browser.close();
mkdirSync('temp/perf/results', { recursive: true });
const out = { benchmark: 'routes', base: BASE, cpu, runs, adapter, browser: version, build: 'production (vite preview)', results };
writeFileSync(`temp/perf/results/routes-cpu${cpu}.json`, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
