/**
 * App shell: cold and warm loads, service worker install and offline start,
 * and language switch cost, on the production build.
 *
 *   bun run build && bun run preview -- --host 127.0.0.1 --port 4173
 *   bun bench/shell.mjs [--runs 5] [--cpu 4] [--headed]
 *
 * Each run gets its own temporary browser profile (deleted afterwards):
 *   cold     first visit, service workers blocked, empty profile
 *   warm     reload in the same profile (HTTP cache warm), service workers blocked
 *   sw-first first visit with the service worker allowed: install time and precache size
 *   sw-warm  reload controlled by the service worker
 *   offline  the same profile with the network off
 * Language switch: every language from the header menu on the home view and
 * on /video-editor/, first switch (pack fetch) and repeat (pack cached).
 * GPU flags match bench/video-heavy.mjs; the adapter is recorded.
 */
const { chromium } = await import(process.env.BENCH_PLAYWRIGHT ?? 'playwright');
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, cpus, totalmem, release } from 'node:os';

// Chromium can hold profile files for a moment after close (EBUSY on Windows). Retry at the end.
const pendingProfiles = [];
function removeProfile(path) {
  try { rmSync(path, { recursive: true, force: true }); } catch { pendingProfiles.push(path); }
}
async function removePendingProfiles() {
  for (let attempt = 0; attempt < 20 && pendingProfiles.length; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    for (const path of pendingProfiles.splice(0)) {
      try { rmSync(path, { recursive: true, force: true }); } catch { pendingProfiles.push(path); }
    }
  }
  if (pendingProfiles.length) console.error('Could not delete profiles:', pendingProfiles.join(', '));
}
const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : fallback;
};
const BASE = process.env.BENCH_URL ?? 'http://127.0.0.1:4173';
const runs = Number(opt('runs', '5'));
const cpu = Number(opt('cpu', '1'));
const headed = argv.includes('--headed');
const GPU_ARGS = ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'];
const LANGS = ['pt', 'es', 'fr', 'de', 'it', 'ja', 'zh', 'ko', 'en'];

const OBSERVERS = () => {
  window.__lt = [];
  window.__lcp = 0;
  try { new PerformanceObserver((list) => window.__lt.push(...list.getEntries().map((e) => ({ start: e.startTime, duration: e.duration })))).observe({ type: 'longtask', buffered: true }); } catch {}
  try { new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__lcp = e.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true }); } catch {}
};

async function collect(page, cdp) {
  // Wait for a 3 s window without long tasks or new requests (lab TTI approximation), up to 20 s.
  const data = await page.evaluate(async () => {
    const t0 = performance.now();
    let lastRes = performance.getEntriesByType('resource').length;
    let quietSince = performance.now();
    while (performance.now() - quietSince < 3000 && performance.now() - t0 < 20000) {
      await new Promise((r) => setTimeout(r, 100));
      const n = performance.getEntriesByType('resource').length;
      const lastTask = window.__lt.length ? window.__lt[window.__lt.length - 1] : null;
      if (n !== lastRes || (lastTask && lastTask.start + lastTask.duration > quietSince)) {
        lastRes = n;
        quietSince = performance.now();
      }
    }
    const nav = performance.getEntriesByType('navigation')[0];
    const fcp = performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null;
    const resources = performance.getEntriesByType('resource');
    const lastTask = window.__lt.filter((e) => e.start >= (fcp ?? 0)).pop();
    const tti = Math.max(nav.domContentLoadedEventEnd, fcp ?? 0, lastTask ? lastTask.start + lastTask.duration : 0);
    const sum = (list, key) => list.reduce((s, r) => s + (r[key] || 0), 0);
    return {
      ttfb: +nav.responseStart.toFixed(1),
      fcp: fcp && +fcp.toFixed(1),
      lcp: +window.__lcp.toFixed(1),
      dcl: +nav.domContentLoadedEventEnd.toFixed(1),
      load: +nav.loadEventEnd.toFixed(1),
      tti: +tti.toFixed(1),
      longTasks: window.__lt.length,
      longTaskMs: +sum(window.__lt, 'duration').toFixed(1),
      longTaskMax: +Math.max(0, ...window.__lt.map((e) => e.duration)).toFixed(1),
      requests: resources.length + 1,
      transferKB: +((sum(resources, 'transferSize') + nav.transferSize) / 1024).toFixed(1),
      decodedKB: +((sum(resources, 'decodedBodySize') + nav.decodedBodySize) / 1024).toFixed(1),
      scriptTransferKB: +(sum(resources.filter((r) => r.initiatorType === 'script' || /\.js$/.test(r.name)), 'transferSize') / 1024).toFixed(1),
      fromCache: resources.filter((r) => r.transferSize === 0 && r.decodedBodySize > 0).length,
      domNodes: document.getElementsByTagName('*').length,
      controlled: Boolean(navigator.serviceWorker?.controller),
    };
  });
  const metrics = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
  data.scriptDurationMs = +(metrics.ScriptDuration * 1000).toFixed(1);
  data.taskDurationMs = +(metrics.TaskDuration * 1000).toFixed(1);
  data.heapMB = +(metrics.JSHeapUsedSize / 1048576).toFixed(1);
  return data;
}

async function open(profile, serviceWorkers) {
  const context = await chromium.launchPersistentContext(profile, {
    headless: !headed,
    args: GPU_ARGS,
    serviceWorkers,
    viewport: { width: 1440, height: 900 },
  });
  await context.addInitScript(OBSERVERS);
  const page = context.pages()[0] ?? await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  if (cpu > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
  return { context, page, cdp };
}

const URL0 = `${BASE}/?ui=en#/home`;
const samples = { cold: [], warm: [], swFirst: [], swWarm: [], offline: [] };
let environment = null;
for (let run = 0; run <= runs; run += 1) {
  // Service worker blocked: cold then warm.
  let profile = mkdtempSync(join(tmpdir(), 'ls-shell-'));
  let { context, page, cdp } = await open(profile, 'block');
  await page.goto(URL0, { waitUntil: 'load' });
  const cold = await collect(page, cdp);
  if (!environment) {
    environment = await page.evaluate(async () => {
      const adapter = navigator.gpu ? await navigator.gpu.requestAdapter() : null;
      return { userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency, crossOriginIsolated, gpuAdapter: adapter ? { vendor: adapter.info.vendor, architecture: adapter.info.architecture, description: adapter.info.description } : null };
    });
    console.error('adapter', JSON.stringify(environment.gpuAdapter));
  }
  await page.reload({ waitUntil: 'load' });
  const warm = await collect(page, cdp);
  await context.close();
  removeProfile(profile);

  // Service worker allowed: install, controlled reload, offline start.
  profile = mkdtempSync(join(tmpdir(), 'ls-shell-'));
  ({ context, page, cdp } = await open(profile, 'allow'));
  const t0 = Date.now();
  await page.goto(URL0, { waitUntil: 'load' });
  const swFirst = await collect(page, cdp);
  const install = await page.evaluate(async () => {
    const start = performance.now();
    if (!navigator.serviceWorker) return null;
    const registration = await Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(() => r(null), 60000))]);
    const readyAt = performance.now();
    let bytes = 0;
    let entries = 0;
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) {
        const response = await cache.match(request);
        entries += 1;
        bytes += Number(response.headers.get('content-length')) || (await response.clone().blob()).size;
      }
    }
    return { activated: Boolean(registration?.active), readyAfterLoadMs: Math.round(readyAt - start), readyAtMs: Math.round(readyAt), cacheEntries: entries, precacheMB: +(bytes / 1048576).toFixed(2), caches: await caches.keys() };
  });
  swFirst.install = install;
  swFirst.installWallMs = Date.now() - t0;
  await page.reload({ waitUntil: 'load' });
  const swWarm = await collect(page, cdp);
  await context.setOffline(true);
  let offline;
  try {
    await page.reload({ waitUntil: 'load', timeout: 20000 });
    offline = await collect(page, cdp);
  } catch (error) {
    offline = { error: String(error).split('\n')[0] };
  }
  await context.close();
  removeProfile(profile);
  if (run > 0) {
    samples.cold.push(cold);
    samples.warm.push(warm);
    samples.swFirst.push(swFirst);
    samples.swWarm.push(swWarm);
    samples.offline.push(offline);
  }
  console.error(`run ${run}: cold fcp ${cold.fcp} lcp ${cold.lcp} tti ${cold.tti}; warm fcp ${warm.fcp}; sw ready ${install?.readyAtMs}; offline fcp ${offline.fcp ?? offline.error}`);
}

// Language switches (one profile, service worker blocked).
const language = [];
for (const path of ['/?ui=en#/home', '/video-editor/?ui=en']) {
  const profile = mkdtempSync(join(tmpdir(), 'ls-shell-'));
  const { context, page } = await open(profile, 'block');
  await page.goto(`${BASE}${path}`, { waitUntil: 'load' });
  await page.waitForTimeout(1500);
  for (const pass of ['first', 'repeat']) {
    for (const code of LANGS) {
      const result = await page.evaluate(async (code) => {
        const toggle = document.querySelector('[data-language]')?.closest('[hidden], div, nav, section')?.parentElement?.querySelector('button');
        const item = document.querySelector(`[data-language="${code}"]`);
        if (!item) return { code, error: 'no menu item' };
        const before = window.__lt.length;
        const resBefore = performance.getEntriesByType('resource').length;
        const start = performance.now();
        item.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        const target = code === 'zh' ? 'zh-Hans' : code;
        while (document.documentElement.lang !== target && performance.now() - start < 10000) await new Promise((r) => setTimeout(r, 5));
        // translateSubtree runs right after the pack loads; wait two frames for it and the paint.
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const tasks = window.__lt.slice(before);
        const added = performance.getEntriesByType('resource').slice(resBefore);
        return { code, ms: +(performance.now() - start).toFixed(1), longTasks: tasks.length, longTaskMax: +Math.max(0, ...tasks.map((t) => t.duration)).toFixed(1), fetchedKB: +(added.reduce((s, r) => s + r.transferSize, 0) / 1024).toFixed(1), domNodes: document.getElementsByTagName('*').length, toggle: Boolean(toggle) };
      }, code);
      language.push({ path, pass, ...result });
      await page.waitForTimeout(300);
    }
  }
  await context.close();
  removeProfile(profile);
}

const stat = (list, key) => {
  const values = list.map((s) => s[key]).filter((v) => typeof v === 'number').sort((a, b) => a - b);
  if (!values.length) return null;
  return { median: values[Math.floor(values.length / 2)], min: values[0], max: values[values.length - 1] };
};
const keys = ['ttfb', 'fcp', 'lcp', 'dcl', 'tti', 'longTasks', 'longTaskMs', 'longTaskMax', 'requests', 'transferKB', 'scriptTransferKB', 'scriptDurationMs', 'heapMB', 'domNodes'];
const table = Object.fromEntries(Object.entries(samples).map(([name, list]) => [name, Object.fromEntries(keys.map((key) => [key, stat(list, key)]))]));
const swInstall = { readyAtMs: stat(samples.swFirst.map((s) => s.install ?? {}), 'readyAtMs'), precacheMB: samples.swFirst[0]?.install?.precacheMB, cacheEntries: samples.swFirst[0]?.install?.cacheEntries, offlineErrors: samples.offline.filter((s) => s.error).length, offlineControlled: samples.offline.map((s) => s.controlled ?? null) };
const out = { benchmark: 'shell', base: BASE, cpu, runs, headed, environment: { os: `Windows ${release()}`, cpu: cpus()[0]?.model, logicalCores: cpus().length, ramGB: Math.round(totalmem() / 2 ** 30), build: 'production (vite preview)', ...environment }, table, swInstall, language, samples };
mkdirSync('temp/perf/results', { recursive: true });
writeFileSync(`temp/perf/results/shell-cpu${cpu}${headed ? '-headed' : ''}.json`, JSON.stringify(out, null, 2));
await removePendingProfiles();
console.log(JSON.stringify({ table, swInstall, language }, null, 2));
