/**
 * All 16 Quick Tools with their default settings on 1080p and 4K inputs (10 s),
 * plus 5 min 1080p for the video tools, and 1 / 12 / 48 MP images.
 *
 *   bun bench/perf-fixtures.ts --set full
 *   bun run dev -- --host 127.0.0.1 --port 5174
 *   bun bench/quick-tools.mjs [--runs 3] [--inputs 1080p,4k,5min,1mp,12mp,48mp] [--tools a,b]
 *
 * One temporary profile per tool and input (deleted afterwards). The save
 * picker is removed so every output is an in-memory download that Playwright
 * saves; video outputs are checked with ffprobe and a full ffmpeg decode.
 * Wall time is the Run click to the end of processing (status settled).
 */
const { chromium } = await import(process.env.BENCH_PLAYWRIGHT ?? 'playwright');
import { mkdirSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : fallback;
};
const BASE = process.env.BENCH_URL ?? 'http://127.0.0.1:5174';
const runs = Number(opt('runs', '3'));
// Per-run limit. A run that exceeds it is recorded as a timeout (a finding), not retried.
const limitMs = Number(opt('timeout', '300000'));
const FFMPEG_TOOLS = ['change-speed', 'reverse-video', 'extract-frames', 'video-to-gif', 'video-watermark', 'video-collage'];
const GPU_ARGS = ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'];
const F = (name) => resolve('temp/perf/fixtures', name);
const VIDEO_INPUTS = { '1080p': F('v1080p30-10s.mp4'), '4k': F('v2160p30-10s.mp4'), '5min': F('v1080p30-5min.mp4') };
const IMAGE_INPUTS = { '1mp': F('image-1mp.jpg'), '12mp': F('image-12mp.jpg'), '48mp': F('image-48mp.jpg') };
const VIDEO_TOOLS = ['video-converter', 'video-compressor', 'video-trimmer', 'extract-audio', 'rotate-video', 'change-speed', 'reverse-video', 'extract-frames', 'video-to-gif', 'video-watermark', 'video-collage'];
const IMAGE_TOOLS = ['image-converter', 'image-watermark', 'grid-maker', 'background-remover', 'image-collage'];
const tools = opt('tools', [...VIDEO_TOOLS, ...IMAGE_TOOLS].join(',')).split(',');
const inputs = opt('inputs', '1080p,4k,5min,1mp,12mp,48mp').split(',');
const outDir = 'temp/perf/exports/quick';
mkdirSync(outDir, { recursive: true });

function probe(file) {
  const result = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels:format=duration,size', '-of', 'json', file], { encoding: 'utf8' });
  return result.status === 0 ? JSON.parse(result.stdout) : null;
}
function decodeErrors(file) {
  const result = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 64 << 20 });
  return result.status === 0 && !result.stderr.trim() ? 0 : Math.max(1, result.stderr.trim().split(/\r?\n/).length);
}

const results = [];
for (const tool of tools) {
  const isVideo = VIDEO_TOOLS.includes(tool);
  for (const input of inputs) {
    const file = isVideo ? VIDEO_INPUTS[input] : IMAGE_INPUTS[input];
    if (!file || !existsSync(file)) continue;
    // Heavy reverse/gif on 5 min input are capped by the tools; still measured once.
    const runCount = FFMPEG_TOOLS.includes(tool) && (input === '4k' || input === '5min') ? 1 : input === '5min' || input === '48mp' ? Math.min(runs, 2) : runs;
    const samples = [];
    for (let run = 0; run < runCount; run += 1) {
      const profile = mkdtempSync(join(tmpdir(), 'ls-qt-'));
      const context = await chromium.launchPersistentContext(profile, { headless: true, args: GPU_ARGS, viewport: { width: 1480, height: 1000 }, acceptDownloads: true });
      await context.addInitScript(() => {
        try { Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true }); } catch {}
        window.__lt = [];
        try { new PerformanceObserver((list) => window.__lt.push(...list.getEntries().map((e) => e.duration))).observe({ type: 'longtask' }); } catch {}
      });
      const page = context.pages()[0] ?? await context.newPage();
      page.on('dialog', (d) => d.accept());
      const ffmpegCore = [];
      page.on('request', (request) => { if (/ffmpeg-core|ffmpeg-mt|core-mt/.test(request.url())) ffmpegCore.push(request.url()); });
      let sample;
      try {
        await page.goto(`${BASE}/?ui=en#/tools?tool=${tool}`, { waitUntil: 'load' });
        await page.waitForSelector('#quick-input', { state: 'attached' });
        await page.waitForTimeout(500);
        const files = /collage/.test(tool) ? [file, file, file, file] : [file];
        await page.setInputFiles('#quick-input', files);
        await page.waitForFunction(() => !document.querySelector('#quick-run')?.disabled, null, { timeout: 120000 });
        // Defaults are used except where the default is a no-op.
        if (tool === 'rotate-video') await page.selectOption('#q-rotation', '90').catch(() => undefined);
        if (tool === 'change-speed') { await page.fill('#q-speed', '2').catch(() => undefined); await page.dispatchEvent('#q-speed', 'change').catch(() => undefined); }
        const t0 = Date.now();
        await page.click('#quick-run');
        // Done when a result link appears, or the run stops with an error. FFmpeg
        // paths print progress lines into the status, so the status alone is not enough.
        await page.waitForFunction(() => {
          if (document.querySelector('#quick-output .quick-result-list a')) return true;
          const status = document.querySelector('#quick-status')?.textContent ?? '';
          return document.querySelector('#quick-cancel')?.hidden === true && /error|failed|could not|cannot|unsupported/i.test(status);
        }, null, { timeout: limitMs, polling: 50 });
        const ms = Date.now() - t0;
        const info = await page.evaluate(() => ({
          status: document.querySelector('#quick-status')?.textContent?.trim().slice(0, 200),
          items: [...document.querySelectorAll('#quick-output .quick-result-list li > span')].map((n) => n.textContent).slice(0, 4),
          links: document.querySelectorAll('#quick-output .quick-result-list a').length,
          longTasks: window.__lt.length, longTaskMs: Math.round(window.__lt.reduce((s, t) => s + t, 0)), longTaskMax: Math.round(Math.max(0, ...window.__lt)),
          heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null,
        }));
        sample = { run, ms, ffmpegCore: ffmpegCore.length > 0, ...info };
        if (run === 0 && info.links) {
          const download = page.waitForEvent('download', { timeout: 120000 });
          await page.click('#quick-output .quick-result-list a');
          const saved = await download;
          const target = join(outDir, `${tool}-${input}-${saved.suggestedFilename()}`);
          await saved.saveAs(target);
          sample.output = target;
          if (/\.(mp4|webm|mov|mkv|m4a|mp3|gif|ogg|wav)$/i.test(target)) {
            sample.probe = probe(target);
            sample.decodeErrors = decodeErrors(target);
          }
        }
      } catch (error) {
        const message = String(error).split('\n')[0];
        sample = { run, error: message, ...(/Timeout/i.test(message) ? { timeout: true, limitMs } : {}) };
      }
      samples.push(sample);
      await context.close();
      try { rmSync(profile, { recursive: true, force: true }); } catch { await new Promise((r) => setTimeout(r, 1500)); try { rmSync(profile, { recursive: true, force: true }); } catch { console.error('could not delete', profile); } }
    }
    const times = samples.map((s) => s.ms).filter((v) => typeof v === 'number').sort((a, b) => a - b);
    const row = { tool, input, runs: samples.length, median: times[Math.floor(times.length / 2)] ?? null, min: times[0] ?? null, max: times[times.length - 1] ?? null, samples };
    results.push(row);
    console.error(`${tool} ${input}: median ${row.median} ms (min ${row.min}, max ${row.max}) · ${samples[0]?.status ?? samples[0]?.error} · ffmpeg ${samples[0]?.ffmpegCore} · decodeErrors ${samples[0]?.decodeErrors ?? '-'}`);
  }
}
mkdirSync('temp/perf/results', { recursive: true });
writeFileSync(`temp/perf/results/quick-tools${tools.length < 16 ? '-' + tools.join('_').slice(0, 60) : ''}.json`, JSON.stringify({ benchmark: 'quick-tools', base: BASE, results }, null, 2));
console.log(JSON.stringify(results.map(({ samples, ...row }) => ({ ...row, status: samples[0]?.status ?? samples[0]?.error, ffmpeg: samples[0]?.ffmpegCore, decodeErrors: samples[0]?.decodeErrors })), null, 2));
