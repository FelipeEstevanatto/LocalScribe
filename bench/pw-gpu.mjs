/**
 * Playwright with the GPU flags this machine needs, for harnesses that accept
 * BENCH_PLAYWRIGHT (bench/video.mjs, bench/routes.mjs, bench/video-heavy.mjs):
 *
 *   BENCH_PLAYWRIGHT=./pw-gpu.mjs bun bench/video.mjs
 *
 * On Windows, headless Chromium without these flags gets no adapter or the
 * SwiftShader software adapter. The first launch prints the adapter it got.
 */
import * as playwright from 'playwright';

export const GPU_ARGS = ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'];
const original = playwright.chromium;
let reported = false;

async function report(browser) {
  if (reported) return;
  reported = true;
  const page = await browser.newPage();
  await page.goto(process.env.BENCH_ADAPTER_URL ?? 'http://127.0.0.1:5174/robots.txt').catch(() => undefined);
  const adapter = await page.evaluate(async () => {
    const a = navigator.gpu && await navigator.gpu.requestAdapter();
    return a ? `${a.info.vendor} ${a.info.architecture}` : 'none';
  }).catch(() => 'unknown');
  console.error(`[pw-gpu] Chromium ${browser.version()}, WebGPU adapter: ${adapter}`);
  await page.close();
}

export const chromium = {
  ...original,
  launch: async (options = {}) => {
    const browser = await original.launch({ ...options, args: [...(options.args ?? []), ...GPU_ARGS] });
    await report(browser);
    return browser;
  },
  launchPersistentContext: (dir, options = {}) => original.launchPersistentContext(dir, { ...options, args: [...(options.args ?? []), ...GPU_ARGS] }),
};
export default { ...playwright, chromium };
