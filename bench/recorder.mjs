/**
 * Screen recorder with Chromium fake capture devices (no permission prompt).
 *
 *   bun run dev -- --host 127.0.0.1 --port 5174
 *   bun bench/recorder.mjs [--seconds 20] [--long 180]
 *
 * Headed, because screen capture and compositor pacing need a real window.
 * Cases: camera, screen and screen + webcam at 1080p30, 1440p60 and 4K30.
 * Measures click to recording, long tasks and heap while recording, Stop to
 * a saved file, and checks the file with ffprobe (frames vs expected).
 * Note: the fake camera is Chromium's synthetic 640x480 pattern and the
 * "screen" is the desktop picked by --auto-select-desktop-capture-source.
 */
const { chromium } = await import(process.env.BENCH_PLAYWRIGHT ?? 'playwright');
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : fallback;
};
const BASE = process.env.BENCH_URL ?? 'http://127.0.0.1:5174';
const seconds = Number(opt('seconds', '20'));
const longSeconds = Number(opt('long', '0'));
const ARGS = ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=d3d11',
  '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--auto-select-desktop-capture-source=Entire screen',
  '--auto-accept-this-tab-capture', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'];
const outDir = 'temp/perf/exports/recorder';
mkdirSync(outDir, { recursive: true });

function probe(file) {
  const result = spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate,avg_frame_rate,nb_read_frames:format=duration,size', '-of', 'json', file], { encoding: 'utf8' });
  return result.status === 0 ? JSON.parse(result.stdout) : { error: result.stderr.slice(0, 300) };
}

const CASES = [];
for (const source of ['camera', 'screen', 'screen-webcam']) {
  for (const [quality, fps] of [['1080', '30'], ['1440', '60'], ['2160', '30']]) CASES.push({ source, quality, fps, seconds });
}
if (longSeconds) CASES.push({ source: 'screen-webcam', quality: '1080', fps: '30', seconds: longSeconds, long: true });

const results = [];
for (const testCase of CASES) {
  const profile = mkdtempSync(join(tmpdir(), 'ls-rec-'));
  const context = await chromium.launchPersistentContext(profile, { headless: false, args: ARGS, viewport: { width: 1480, height: 950 }, acceptDownloads: true, permissions: ['camera', 'microphone'] });
  await context.addInitScript(() => {
    try { Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true }); } catch {}
    window.__lt = [];
    try { new PerformanceObserver((list) => window.__lt.push(...list.getEntries().map((e) => e.duration))).observe({ type: 'longtask' }); } catch {}
  });
  const page = context.pages()[0] ?? await context.newPage();
  page.on('dialog', (d) => d.accept());
  let sample = { ...testCase };
  try {
    await page.goto(`${BASE}/?ui=en#/record`, { waitUntil: 'load' });
    await page.waitForSelector('#rec-start');
    await page.selectOption('#rec-source', testCase.source);
    await page.selectOption('#rec-quality', testCase.quality);
    await page.selectOption('#rec-fps', testCase.fps);
    if (await page.locator('#rec-countdown').isChecked().catch(() => false)) await page.uncheck('#rec-countdown');
    await page.evaluate(() => { window.__lt = []; });
    const t0 = Date.now();
    await page.click('#rec-start');
    await page.waitForFunction(() => /Recording locally|error|denied|cannot/i.test(document.querySelector('#rec-status')?.textContent ?? ''), null, { timeout: 60000, polling: 50 });
    sample.startMs = Date.now() - t0;
    sample.startStatus = await page.evaluate(() => document.querySelector('#rec-status')?.textContent?.trim());
    const heapStart = await page.evaluate(() => performance.memory?.usedJSHeapSize ?? 0);
    const heap = [];
    const until = Date.now() + testCase.seconds * 1000;
    while (Date.now() < until) {
      await page.waitForTimeout(Math.min(5000, until - Date.now()));
      heap.push(await page.evaluate(() => performance.memory?.usedJSHeapSize ?? 0));
    }
    const during = await page.evaluate(() => { const t = window.__lt; window.__lt = []; return { longTasks: t.length, longTaskMs: Math.round(t.reduce((s, x) => s + x, 0)), longTaskMax: Math.round(Math.max(0, ...t)) }; });
    Object.assign(sample, during);
    sample.heapStartMB = +(heapStart / 1048576).toFixed(1);
    sample.heapEndMB = +(heap[heap.length - 1] / 1048576).toFixed(1);
    sample.heapPeakMB = +(Math.max(...heap) / 1048576).toFixed(1);
    const t1 = Date.now();
    await page.click('#rec-stop');
    await page.waitForFunction(() => /Recording saved|No recording data|error/i.test(document.querySelector('#rec-status')?.textContent ?? ''), null, { timeout: 600000, polling: 50 });
    sample.stopToSavedMs = Date.now() - t1;
    sample.meta = await page.evaluate(() => document.querySelector('#rec-result-meta')?.textContent?.trim());
    const download = page.waitForEvent('download', { timeout: 120000 });
    await page.click('#rec-download');
    const saved = await download;
    const file = join(outDir, `${testCase.source}-${testCase.quality}p${testCase.fps}${testCase.long ? '-long' : ''}-${saved.suggestedFilename()}`);
    await saved.saveAs(file);
    sample.file = file;
    sample.probe = probe(file);
    const video = sample.probe.streams?.find((s) => s.codec_type === 'video');
    if (video) {
      const duration = Number(sample.probe.format?.duration) || testCase.seconds;
      sample.framesRead = Number(video.nb_read_frames);
      sample.framesExpected = Math.round(duration * Number(testCase.fps));
      sample.frameDeliveryPct = +((sample.framesRead / sample.framesExpected) * 100).toFixed(1);
    }
  } catch (error) {
    sample.error = String(error).split('\n')[0];
  }
  results.push(sample);
  console.error(JSON.stringify({ ...sample, probe: undefined }));
  await context.close();
  try { rmSync(profile, { recursive: true, force: true }); } catch { await new Promise((r) => setTimeout(r, 1500)); try { rmSync(profile, { recursive: true, force: true }); } catch { console.error('could not delete', profile); } }
}
mkdirSync('temp/perf/results', { recursive: true });
writeFileSync('temp/perf/results/recorder.json', JSON.stringify({ benchmark: 'recorder', base: BASE, results }, null, 2));
console.log(JSON.stringify(results.map(({ probe, ...row }) => row), null, 2));
