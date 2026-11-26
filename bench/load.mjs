/**
 * Cold app-shell load benchmark.
 *
 * Build and serve the production output first:
 *   bun run build
 *   bun run preview -- --host 127.0.0.1 --port 4173
 *   bun run bench:load
 *
 * Service workers are blocked so the result measures the first visit. Set
 * BENCH_CPU=4 for a slower mobile-class CPU, and BENCH_URL to another origin.
 */
import { chromium } from 'playwright';

const URL = process.env.BENCH_URL ?? 'http://127.0.0.1:4173/';
const CHROME = process.env.BENCH_CHROME;
const CPU = Number(process.env.BENCH_CPU ?? 1);
const MOBILE = process.env.BENCH_MOBILE === '1';
const browser = await chromium.launch(CHROME ? { headless: true, executablePath: CHROME } : { headless: true });
const context = await browser.newContext({
  viewport: MOBILE ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
  serviceWorkers: 'block',
});
const page = await context.newPage();
await page.addInitScript(() => {
  window.__lcp = 0;
  window.__long = [];
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) window.__lcp = entry.startTime;
  }).observe({ type: 'largest-contentful-paint', buffered: true });
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) window.__long.push(Math.round(entry.duration));
  }).observe({ type: 'longtask', buffered: true });
});
if (CPU !== 1) {
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });
}
const start = Date.now();
await page.goto(URL, { waitUntil: 'load' });
await page.waitForTimeout(2500);
const result = await page.evaluate(() => {
  const nav = performance.getEntriesByType('navigation')[0];
  const resources = performance.getEntriesByType('resource').map((entry) => ({
    name: entry.name.replace(location.origin, ''),
    type: entry.initiatorType,
    transfer: entry.transferSize,
    decoded: entry.decodedBodySize,
  }));
  return {
    dcl: Math.round(nav.domContentLoadedEventEnd),
    load: Math.round(nav.loadEventEnd),
    lcp: Math.round(window.__lcp),
    longTasks: window.__long,
    longTaskTotal: window.__long.reduce((sum, value) => sum + value, 0),
    resources,
    scriptBytes: resources.filter((resource) => resource.type === 'script').reduce((sum, resource) => sum + resource.transfer, 0),
    decodedScriptBytes: resources.filter((resource) => resource.type === 'script').reduce((sum, resource) => sum + resource.decoded, 0),
  };
});
console.log(JSON.stringify({ url: URL, cpu: CPU, wallMs: Date.now() - start, ...result }, null, 2));
await browser.close();
