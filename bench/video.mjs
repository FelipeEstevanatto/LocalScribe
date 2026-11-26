/**
 * Browser benchmark for the video editor and export.
 *
 * Requires Playwright and ffmpeg:
 *   bun add -D playwright
 *   bun run dev -- --host 127.0.0.1 --port 5174
 *   bun bench/video.mjs
 *
 * The dev server must already be running. Results are printed as JSON.
 */
const { chromium } = await import(process.env.BENCH_PLAYWRIGHT ?? 'playwright');
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PAGE_URL = process.env.BENCH_URL ?? 'http://127.0.0.1:5174/?ui=en#/video';
const CHROME = process.env.BENCH_CHROME;
const RUNS = Number(process.env.BENCH_RUNS ?? 2);
const EXPECT_PROXY = process.env.BENCH_EXPECT_PROXY === '1';
const FOUR_K = process.env.BENCH_4K === '1';
const ENGINE_ONLY = process.env.BENCH_ENGINE_ONLY === '1';
const media = mkdtempSync(join(tmpdir(), 'localscribe-bench-'));

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-y', '-v', 'error', ...args]);
}

/** Decode the whole output and count error lines. Zero means it plays cleanly. */
function decodeErrors(file) {
  const result = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-'], { encoding: 'utf8' });
  return result.status === 0 && !result.stderr.trim() ? 0 : Math.max(1, (result.stderr ?? '').trim().split(/\r?\n/).length);
}

console.error('Generating benchmark media in', media);
ffmpeg([
  '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30',
  '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
  '-t', '6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
  join(media, 'clip-a.mp4'),
]);
ffmpeg([
  '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30',
  '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000',
  '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
  join(media, 'clip-b.mp4'),
]);
ffmpeg(['-f', 'lavfi', '-i', 'color=c=purple:s=640x360', '-frames:v', '1', join(media, 'still.png')]);
// Two halves of one encode share SPS/PPS, so the exporter can copy both.
ffmpeg(['-ss', '0', '-i', join(media, 'clip-a.mp4'), '-t', '3', '-c', 'copy', join(media, 'clip-g.mp4')]);
ffmpeg(['-ss', '3', '-i', join(media, 'clip-a.mp4'), '-t', '3', '-c', 'copy', join(media, 'clip-h.mp4')]);
// Same encoder settings as clip-a: video and audio configurations both match.
ffmpeg([
  '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30',
  '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
  '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
  join(media, 'clip-f.mp4'),
]);

const browser = await chromium.launch(CHROME ? { headless: true, executablePath: CHROME } : { headless: true });
const report = { import: [], zoom: [], drag: [], scrub: [], export: [], copyExport: [], copyWithAudio: [], fourK: [], engine: [], previewAudio: [] };

async function openVideo() {
  const page = await browser.newPage({ viewport: { width: 1480, height: 1000 }, serviceWorkers: 'block' });
  const coreRequests = new Set();
  page.on('request', (request) => {
    if (/ffmpeg[^?]*\.wasm/.test(request.url())) coreRequests.add(new URL(request.url()).pathname);
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.addInitScript(() => {
    try { Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true }); } catch { /* ignore */ }
  });
  await page.goto(PAGE_URL);
  await page.locator('#video-ruler').waitFor({ timeout: 15000 });
  // Allow the lazy editor route to bind the media input before dispatching a change.
  await page.waitForFunction(() => document.querySelector('#video-export-main')?.disabled);
  return { page, errors, coreRequests };
}

async function importVideos(page, files) {
  const videoCount = files.filter((file) => file.endsWith('.mp4')).length;
  await page.evaluate((videoCount) => {
    const start = performance.now();
    const timings = window.__videoImport = {};
    const video = document.querySelector('#video-preview');
    video.addEventListener('loadeddata', () => {
      timings.firstFrameMs ??= performance.now() - start;
    }, { once: true });
    const observer = new MutationObserver(() => {
      if (!timings.firstClipMs && document.querySelector('.vt-clip-video')) {
        timings.firstClipMs = performance.now() - start;
      }
      if (document.querySelectorAll('.vt-filmstrip').length >= videoCount &&
          document.querySelectorAll('.vt-clip-audio canvas:not(.vt-wave-detail)').length >= videoCount) {
        timings.assetsMs = performance.now() - start;
        observer.disconnect();
      }
    });
    observer.observe(document.querySelector('#video-content'), { childList: true, subtree: true, attributes: true });
  }, videoCount);
  await page.setInputFiles('#video-media-input', files);
  await page.waitForFunction((count) => document.querySelectorAll('.vt-clip-video').length >= count &&
    document.querySelector('#video-export-main')?.disabled === false &&
    window.__videoImport.assetsMs && window.__videoImport.firstFrameMs, files.length, { timeout: 15000 })
    .catch(async (error) => {
      console.error(await page.evaluate(() => ({
        timings: window.__videoImport,
        status: document.querySelector('#video-status').textContent,
        clips: document.querySelectorAll('.vt-clip-video').length,
        filmstrips: document.querySelectorAll('.vt-filmstrip').length,
        waves: document.querySelectorAll('.vt-clip-audio canvas:not(.vt-wave-detail)').length,
      })));
      throw error;
    });
  return page.evaluate(() => window.__videoImport);
}

async function installLongTask(page) {
  await page.evaluate(() => {
    window.__long = { count: 0, duration: 0 };
    window.__longObserver?.disconnect();
    window.__longObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        window.__long.count += 1;
        window.__long.duration += entry.duration;
      }
    });
    window.__longObserver.observe({ entryTypes: ['longtask'] });
  });
}

if (!ENGINE_ONLY) {
  for (let run = 0; run < RUNS; run += 1) {
    const { page, errors } = await openVideo();
    console.error(`Timeline run ${run + 1}/${RUNS}`);
    const readiness = await importVideos(page, [join(media, 'clip-a.mp4'), join(media, 'clip-b.mp4')]);
    report.import.push({
      run,
      ...readiness,
      ...(await page.evaluate(() => ({
        clips: document.querySelectorAll('.vt-clip-video').length,
        filmstrips: document.querySelectorAll('.vt-filmstrip').length,
        tiles: document.querySelectorAll('.vt-filmstrip-tile').length,
        waves: document.querySelectorAll('.vt-clip-audio canvas:not(.vt-wave-detail)').length,
        heap: performance.memory?.usedJSHeapSize ?? null,
      }))),
      errors: errors.length,
    });

    report.zoom.push({
      run,
      ...(await page.evaluate(async () => {
        const times = [];
        const button = document.querySelector('#video-zoom-in');
        for (let index = 0; index < 8; index += 1) {
          const start = performance.now();
          button.click();
          await new Promise(requestAnimationFrame);
          await new Promise(requestAnimationFrame);
          times.push(performance.now() - start);
        }
        return {
          times,
          totalMs: times.reduce((sum, value) => sum + value, 0),
          zoom: document.querySelector('#video-zoom')?.value,
          width: document.querySelector('#video-content')?.style.width,
          spans: document.querySelectorAll('.vt-band, .vt-tick, .vt-grid-line').length,
          clips: document.querySelectorAll('.vt-clip').length,
        };
      })),
      errors: errors.length,
    });

    await page.evaluate(() => document.querySelector('#video-fit')?.click());
    await page.waitForTimeout(400);
    const clipBox = await page.locator('.vt-clip-video').first().boundingBox();
    await installLongTask(page);
    const dragStart = Date.now();
    await page.mouse.move(clipBox.x + clipBox.width / 2, clipBox.y + clipBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(clipBox.x + clipBox.width / 2 + 300, clipBox.y + clipBox.height / 2, { steps: 30 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    report.drag.push({
      run,
      wallMs: Date.now() - dragStart,
      long: await page.evaluate(() => window.__long),
      ...(await page.evaluate(() => ({
        width: document.querySelector('#video-content')?.style.width,
        meta: document.querySelector('#video-project-meta')?.textContent,
      }))),
      errors: errors.length,
    });

    const rulerBox = await page.locator('#video-ruler').boundingBox();
    await installLongTask(page);
    const scrubStart = Date.now();
    await page.mouse.move(rulerBox.x + rulerBox.width * 0.2, rulerBox.y + rulerBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(rulerBox.x + rulerBox.width * 0.8, rulerBox.y + rulerBox.height / 2, { steps: 40 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    report.scrub.push({
      run,
      wallMs: Date.now() - scrubStart,
      long: await page.evaluate(() => window.__long),
      errors: errors.length,
    });

    await page.close();
  }

  async function exportTimeline(page, files, output) {
    console.error('Exporting', files.map((file) => file.split(/[\\/]/).at(-1)).join(', '));
    await importVideos(page, files);
    await page.waitForTimeout(500);
    const downloadPromise = page.waitForEvent('download', { timeout: 20000 }).catch(() => null);
    const start = Date.now();
    await page.click('#video-export-main');
    const download = await downloadPromise;
    const downloadMs = Date.now() - start;
    if (download) await download.saveAs(output);
    let status = '';
    for (let index = 0; index < 400; index += 1) {
      if (!download) break;
      status = await page.evaluate(() => document.querySelector('#video-status')?.textContent ?? '');
      if (status.startsWith('Saved')) break;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return {
      ms: Date.now() - start,
      downloadMs,
      status,
      download: download?.suggestedFilename() ?? null,
      decodeErrors: download ? decodeErrors(output) : -1,
      ...(await page.evaluate(() => ({
        meta: document.querySelector('#video-project-meta')?.textContent,
        note: document.querySelector('#video-export-note')?.textContent,
        summary: document.querySelector('#video-output-summary')?.textContent,
      }))),
    };
  }

  for (let run = 0; run < RUNS; run += 1) {
    const { page, errors, coreRequests } = await openVideo();
    report.export.push({
      run,
      ...(await exportTimeline(
        page,
        [join(media, 'clip-a.mp4'), join(media, 'clip-b.mp4'), join(media, 'still.png')],
        join(media, `mixed-${run}.mp4`),
      )),
      ffmpegCoreRequests: [...coreRequests],
      errors: errors.length,
    });
    await page.close();
  }

  for (let run = 0; run < RUNS; run += 1) {
    const { page, errors, coreRequests } = await openVideo();
    report.copyExport.push({
      run,
      ...(await exportTimeline(
        page,
        [join(media, 'clip-g.mp4'), join(media, 'clip-h.mp4')],
        join(media, `copy-${run}.mp4`),
      )),
      ffmpegCoreRequests: [...coreRequests],
      errors: errors.length,
    });
    await page.close();
  }

  for (let run = 0; run < RUNS; run += 1) {
    const { page, errors, coreRequests } = await openVideo();
    report.copyWithAudio.push({
      run,
      ...(await exportTimeline(
        page,
        [join(media, 'clip-a.mp4'), join(media, 'clip-f.mp4')],
        join(media, `copy-with-audio-${run}.mp4`),
      )),
      ffmpegCoreRequests: [...coreRequests],
      errors: errors.length,
    });
    await page.close();
  }
}

if (FOUR_K) {
  const fixture = join(media, 'source-4k.mp4');
  ffmpeg([
    '-f', 'lavfi', '-i', 'testsrc2=size=3840x2160:rate=30',
    '-t', '6', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '180',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', fixture,
  ]);
  for (let run = 0; run < RUNS; run += 1) {
    console.error(`4K seek run ${run + 1}/${RUNS}`);
    const { page, errors } = await openVideo();
    const start = Date.now();
    await page.setInputFiles('#video-media-input', fixture);
    await page.waitForFunction(() => document.querySelector('#video-preview')?.readyState >= 2);
    if (EXPECT_PROXY) {
      await page.waitForFunction(() => {
        const video = document.querySelector('#video-preview');
        return video?.readyState >= 2 && video.videoHeight <= 720;
      }, null, { timeout: 60000 });
    }
    const readyMs = Date.now() - start;
    const seek = await page.evaluate(async () => {
      const video = document.querySelector('#video-preview');
      const ruler = document.querySelector('#video-ruler');
      const box = document.querySelector('.vt-clip-video').getBoundingClientRect();
      const duration = video.duration;
      const values = [];
      for (const second of [5.2, .5, 4.5, 1.3, 5.5, 2.8, 4.1, .8, 5, 2.4, 3.6, 1]) {
        const x = box.left + (box.width - 1) * second / duration;
        const start = performance.now();
        const result = await new Promise((resolve, reject) => {
          const id = video.requestVideoFrameCallback((_, metadata) => {
            clearTimeout(timer);
            resolve({ ms: performance.now() - start, error: Math.abs(metadata.mediaTime - second) });
          });
          const timer = setTimeout(() => {
            video.cancelVideoFrameCallback(id);
            reject(new Error('Preview did not present a frame'));
          }, 8000);
          for (const type of ['pointerdown', 'pointerup']) {
            ruler.dispatchEvent(new PointerEvent(type, { clientX: x, pointerId: 1, button: 0, bubbles: true }));
          }
        });
        values.push(result);
      }
      const timings = values.map(({ ms }) => ms).sort((a, b) => a - b);
      return {
        height: video.videoHeight,
        p50: timings[Math.ceil(timings.length * .5) - 1],
        p95: timings[Math.ceil(timings.length * .95) - 1],
        maxFrameError: Math.max(...values.map(({ error }) => error)),
      };
    });
    if (EXPECT_PROXY) {
      await page.selectOption('#video-quality', 'full');
      await page.waitForFunction(() => {
        const video = document.querySelector('#video-preview');
        return video?.readyState >= 2 && video.videoHeight === 2160;
      });
      await page.selectOption('#video-quality', 'auto');
      await page.waitForFunction((seekHeight) => {
        const video = document.querySelector('#video-preview');
        return video?.readyState >= 2 && video.videoHeight === seekHeight;
      }, seek.height);
    }
    report.fourK.push({ run, readyMs, ...seek, errors: errors.length });
    await page.close();
  }
}

if (ENGINE_ONLY) {
  const audioFixture = join(media, '45-seconds.wav');
  ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000', '-t', '45', '-c:a', 'pcm_s16le', audioFixture]);
  const testVideo = readFileSync(join(media, 'clip-a.mp4')).toString('base64');
  for (const mode of ['pixel-effects', 'speed-up', 'slow-down']) {
    for (let run = 0; run < RUNS; run += 1) {
      const { page, errors, coreRequests } = await openVideo();
      const result = await page.evaluate(async ({ testVideo, mode }) => {
        const { exportVideo } = await import('/src/video-export.ts');
        const { MediabunnyEngine } = await import('/src/mediabunny-engine.ts');
        const blob = new Blob([Uint8Array.fromBase64(testVideo)], { type: 'video/mp4' });
        const probe = await new MediabunnyEngine().probe(blob);
        const speed = mode === 'speed-up' ? 2 : mode === 'slow-down' ? 0.5 : 1;
        const lut = { size: 2, name: 'Warm', data: new Float32Array([
          0, 0, 0, 1, 0.1, 0, 0.05, 0.9, 0, 1, 1, 0,
          0, 0, 0.8, 1, 0.1, 0.8, 0.05, 0.9, 0.8, 1, 1, 0.8,
        ]) };
        const effects = mode === 'pixel-effects'
          ? { lut, curve: { shadows: 10, midtones: -12, highlights: 8 }, blur: 3 }
          : { speed };
        const trimStart = 1;
        const trimEnd = 1;
        const start = performance.now();
        const output = await exportVideo({
          videos: [{ blob, probe, duration: probe.duration, trimStart, trimEnd, effects, mute: true }],
          audios: [], settings: { format: 'mp4', keepOriginal: false, originalVolume: 1 }, captions: null,
          signal: AbortSignal.timeout(20000), onProgress: () => undefined,
        });
        window.__engineExport = URL.createObjectURL(output.blob);
        return { ms: performance.now() - start, engine: output.engine, expectedDuration: (probe.duration - trimStart - trimEnd) / speed };
      }, { testVideo, mode });
      const download = page.waitForEvent('download');
      await page.evaluate(() => {
        const anchor = document.createElement('a');
        anchor.href = window.__engineExport;
        anchor.download = 'engine.mp4';
        anchor.click();
      });
      const file = join(media, `${mode}-${run}.mp4`);
      await (await download).saveAs(file);
      const duration = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' }));
      report.engine.push({ mode, run, ...result, duration, decodeErrors: decodeErrors(file), errors: errors.length, ffmpegCoreRequests: [...coreRequests] });
      await page.close();
    }
  }
  const { page, errors } = await openVideo();
  await page.evaluate(() => {
    window.__offlineFrames = [];
    const original = OfflineAudioContext.prototype.startRendering;
    OfflineAudioContext.prototype.startRendering = function () {
      window.__offlineFrames.push(this.length);
      return original.call(this);
    };
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      if (this.tagName === 'AUDIO') window.__previewAudioElement = this;
      return play.call(this);
    };
  });
  await page.setInputFiles('#video-media-input', audioFixture);
  await page.locator('.vt-clip-audio').waitFor();
  await page.waitForTimeout(1400);
  await page.locator('#video-play').click();
  await page.waitForTimeout(400);
  report.previewAudio.push(await page.evaluate(() => ({
    offlineFrames: window.__offlineFrames,
    mediaElementAdvanced: (window.__previewAudioElement?.currentTime ?? 0) > 0.1,
  })));
  report.previewAudio[0].errors = errors.length;
  await page.close();
}

console.log(JSON.stringify(report, null, 2));
await browser.close();

const outputs = [...report.export, ...report.copyExport, ...report.copyWithAudio];
if (EXPECT_PROXY && report.copyWithAudio.some((result) =>
  !result.status.includes('sound copied') || result.ffmpegCoreRequests.length > 0)) {
  process.exitCode = 1;
}
if (outputs.some((result) => result.decodeErrors !== 0 || result.errors !== 0) ||
    report.engine.some((result) => result.decodeErrors !== 0 || result.errors !== 0 ||
      Math.abs(result.duration - result.expectedDuration) > 0.12) ||
    report.previewAudio.some((result) => result.errors !== 0 || (!result.offlineFrames.length && !result.mediaElementAdvanced)) ||
    report.fourK.some((result) => result.errors !== 0 || result.maxFrameError > 0.1)) process.exitCode = 1;
