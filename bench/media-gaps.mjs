/**
 * Benchmarks for the media fast-path gaps: Quick Tools re-encodes, frame and
 * audio extraction, video audio-only export, Audio Studio preview/recording,
 * ASR's browser-decoder fallback, and batch trim-silence.
 *
 * Requires Playwright, ffmpeg, and the dev server:
 *   bun add -D playwright
 *   bunx playwright install chromium
 *   bun run dev -- --host 127.0.0.1 --port 5174
 *   bun run bench:media
 *
 * Every exported video is fully decoded with ffmpeg; decodeErrors must be 0.
 */
import { chromium } from 'playwright';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL = process.env.BENCH_URL ?? 'http://127.0.0.1:5174/?ui=en';
const CHROME = process.env.BENCH_CHROME;
const RUNS = Number(process.env.BENCH_RUNS ?? 1);
const media = mkdtempSync(join(tmpdir(), 'localscribe-media-bench-'));
const out = join(media, 'out');
mkdirSync(out, { recursive: true });

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-y', '-v', 'error', ...args]);
}

function decodeErrors(file) {
  const result = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-'], { encoding: 'utf8' });
  return result.stderr.trim() ? result.stderr.trim().split(/\r?\n/).length : 0;
}

console.error('Generating benchmark media in', media);
ffmpeg([
  '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30',
  '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
  '-t', '6', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
  '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-shortest',
  join(media, 'clip-a.mp4'),
]);
ffmpeg([
  '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30',
  '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000',
  '-t', '15', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
  '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-shortest',
  join(media, 'big.mp4'),
]);
ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '30', '-c:a', 'libmp3lame', '-b:a', '128k', join(media, 'voice30.mp3')]);
ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=550:sample_rate=48000', '-t', '10', '-c:a', 'libopus', '-b:a', '96k', join(media, 'recording.webm')]);
ffmpeg([
  '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=20',
  '-af', 'adelay=2000|2000,apad=pad_dur=2', '-t', '24',
  '-c:a', 'libmp3lame', '-b:a', '128k', join(media, 'silence24.mp3'),
]);

const browser = await chromium.launch(CHROME ? { headless: true, executablePath: CHROME } : { headless: true });
const report = { scenarios: [] };

async function open(path, patchAudio = false) {
  const context = await browser.newContext({ viewport: { width: 1480, height: 1000 }, acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  const ffmpegCore = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('request', (request) => {
    if (/ffmpeg-core|ffmpeg-mt/.test(request.url())) ffmpegCore.push(request.url());
  });
  if (patchAudio) {
    await page.addInitScript(() => {
      Object.defineProperty(AudioContext.prototype, 'decodeAudioData', {
        configurable: true,
        value: () => Promise.reject(new DOMException('forced browser decode failure', 'EncodingError')),
      });
    });
  }
  await page.goto(`${URL}#${path}`);
  await page.waitForTimeout(600);
  return { page, context, errors, ffmpegCore };
}

const quickDone = () => {
  const status = document.querySelector('#quick-status')?.textContent ?? '';
  return document.querySelector('#quick-cancel')?.hidden === true
    && status.length > 0 && !/Processing on this device|Opening media/.test(status);
};

async function quick(name, tool, file, setup, save) {
  const { page, context, errors, ffmpegCore } = await open(`/tools?tool=${tool}`);
  await page.setInputFiles('#quick-input', file);
  await page.waitForFunction(() => !document.querySelector('#quick-run')?.disabled, { timeout: 90000 });
  if (setup) await setup(page);
  const start = Date.now();
  await page.click('#quick-run');
  await page.waitForFunction(quickDone, { timeout: 180000 });
  const statusMs = Date.now() - start;
  let decode = null;
  let filePath = null;
  if (save) {
    filePath = join(out, `${name}.${save}`);
    const download = page.waitForEvent('download', { timeout: 60000 });
    await page.click('#quick-output .quick-result-list a');
    await (await download).saveAs(filePath);
    decode = decodeErrors(filePath);
  }
  report.scenarios.push({
    name,
    ms: Date.now() - start,
    statusMs,
    status: await page.evaluate(() => document.querySelector('#quick-status')?.textContent?.trim()),
    items: await page.evaluate(() => [...document.querySelectorAll('#quick-output .quick-result-list li > span')].map((node) => node.textContent)),
    ffmpegCore: ffmpegCore.length > 0,
    decodeErrors: decode,
    errors,
  });
  await context.close();
}

for (let run = 0; run < RUNS; run += 1) {
  await quick('quick-converter', 'video-converter', join(media, 'clip-a.mp4'), null, 'mp4');
  await quick('quick-compressor', 'video-compressor', join(media, 'big.mp4'), async (page) => {
    await page.selectOption('#q-target', 'custom');
    await page.fill('#q-target-size', '3');
    await page.dispatchEvent('#q-target-size', 'change');
  }, 'mp4');
  await quick('quick-exact-trim', 'video-trimmer', join(media, 'clip-a.mp4'), async (page) => {
    await page.uncheck('#q-copy');
    await page.fill('#q-start', '00:00:01.000');
    await page.fill('#q-end', '00:00:05.000');
    await page.dispatchEvent('#q-start', 'change');
    await page.dispatchEvent('#q-end', 'change');
  }, 'mp4');
  await quick('quick-extract-frames', 'extract-frames', join(media, 'clip-a.mp4'), async (page) => {
    await page.fill('#q-interval', '0.5');
    await page.selectOption('#q-frame-format', 'jpg');
  }, null);
  await quick('quick-extract-audio', 'extract-audio', join(media, 'clip-a.mp4'), async (page) => {
    await page.selectOption('#q-audio-format', 'm4a');
    await page.check('#q-copy');
  }, 'm4a');

  {
    const { page, context, errors, ffmpegCore } = await open('/video');
    await page.setInputFiles('#video-media-input', join(media, 'clip-a.mp4'));
    await page.waitForFunction(() => {
      const clip = document.querySelector('.vt-clip-video');
      return clip && clip.querySelector('.vt-filmstrip') && clip.querySelector('.vt-sound-wave');
    }, { timeout: 90000 });
    await page.waitForFunction(() => !document.querySelector('#video-export-audio')?.disabled, { timeout: 30000 });
    const start = Date.now();
    const download = page.waitForEvent('download', { timeout: 180000 });
    await page.click('#video-export-audio');
    const file = join(out, 'video-audio-only.m4a');
    await (await download).saveAs(file);
    await page.waitForFunction(() => (document.querySelector('#video-status')?.textContent ?? '').startsWith('Saved'), { timeout: 30000 });
    report.scenarios.push({
      name: 'video-audio-only',
      ms: Date.now() - start,
      status: await page.evaluate(() => document.querySelector('#video-status')?.textContent?.trim()),
      ffmpegCore: ffmpegCore.length > 0,
      decodeErrors: decodeErrors(file),
      errors,
    });
    await context.close();
  }

  {
    const { page, context, errors, ffmpegCore } = await open('/audio');
    await page.setInputFiles('#studio-input', join(media, 'voice30.mp3'));
    await page.click('[data-studio-tab="effects"]');
    await page.waitForFunction(() => !document.querySelector('#studio-effects-preview')?.disabled
      && (document.querySelector('#studio-name')?.textContent?.trim().length ?? 0) > 0, { timeout: 120000 });
    const start = Date.now();
    await page.click('#studio-effects-preview');
    await page.waitForFunction(() => /Playing the rendered preview|Could not|error/i.test(
      document.querySelector('#studio-status')?.textContent ?? ''), { timeout: 180000 });
    report.scenarios.push({
      name: 'audio-studio-preview',
      ms: Date.now() - start,
      status: await page.evaluate(() => document.querySelector('#studio-status')?.textContent?.trim()),
      ffmpegCore: ffmpegCore.length > 0,
      errors,
    });
    await context.close();
  }

  {
    const { page, context, errors, ffmpegCore } = await open('/transcribe', true);
    await page.setInputFiles('#file-input', join(media, 'voice30.mp3'));
    const start = Date.now();
    await page.waitForFunction(() => !document.querySelector('#transcribe-btn')?.disabled
      || /error|could not|no audio|failed/i.test(document.querySelector('#file-meta')?.textContent ?? ''), { timeout: 180000 });
    report.scenarios.push({
      name: 'asr-browser-decode-fallback',
      ms: Date.now() - start,
      status: await page.evaluate(() => document.querySelector('#file-meta')?.textContent?.trim()),
      ffmpegCore: ffmpegCore.length > 0,
      errors,
    });
    await context.close();
  }

  {
    const { page, context, errors } = await open('/transcribe');
    await page.evaluate(() => {
      const input = document.createElement('input');
      input.type = 'file';
      input.id = 'bench-file';
      document.body.append(input);
    });
    await page.setInputFiles('#bench-file', join(media, 'recording.webm'));
    const result = await page.evaluate(async () => {
      const { sharedMedia } = await import('/src/media-router.ts');
      const file = document.querySelector('#bench-file').files[0];
      const start = performance.now();
      const decoded = await sharedMedia().decode(file, { signal: new AbortController().signal });
      return { ms: performance.now() - start, duration: decoded.duration };
    });
    report.scenarios.push({ name: 'recording-decode', ...result, errors });
    await context.close();
  }

  {
    const { page, context, errors } = await open('/transcribe');
    await page.evaluate(() => {
      const input = document.createElement('input');
      input.type = 'file';
      input.id = 'bench-file';
      document.body.append(input);
    });
    await page.setInputFiles('#bench-file', join(media, 'silence24.mp3'));
    const result = await page.evaluate(async () => {
      const { trimSilenceFile } = await import('/src/audio-silence.ts');
      const file = document.querySelector('#bench-file').files[0];
      const start = performance.now();
      const blob = await trimSilenceFile(file, 'mp3', { signal: new AbortController().signal });
      return { ms: performance.now() - start, bytes: blob.size };
    });
    report.scenarios.push({ name: 'batch-trim-silence', ...result, errors });
    await context.close();
  }
}

console.log(JSON.stringify(report, null, 2));
await browser.close();
