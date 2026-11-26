/**
 * Heavy video-editor benchmark (scenarios V1 to V14 from the performance brief).
 *
 *   bun bench/perf-fixtures.ts --set full
 *   bun run dev -- --host 127.0.0.1 --port 5174
 *   bun bench/video-heavy.mjs --scenario all --resolution 1080,2160 --backend css,webgl,webgpu --runs 3
 *
 * The browser side lives in bench/video-heavy-page.ts (served by Vite), so the
 * same driver also runs from a browser console without Playwright. This script
 * adds what only a controlled browser can do: a fresh browser profile per run,
 * CPU throttling, CDP traces and heap snapshots, a visible window for frame
 * pacing, real mouse edits measured with Event Timing, and ffprobe/ffmpeg
 * checks of every exported file.
 *
 * Flags:
 *   --scenario  comma list or "all"            (default V1,V2,V4,V5,V12)
 *   --resolution 1080,2160,2160p60             (project output height; p60 sets the project to 60 fps with a 4K60 source)
 *   --backend   css | webgl | webgpu           (comma list; sets ?compositor=)
 *   --runs      measured repetitions per case  (one warm-up is added and discarded unless --no-warmup)
 *   --export    none | comma list of presets   (standard,4k,1080p,720p,vertical,audio,custom-webm,custom-mov,custom-mkv,custom-target,custom-loudness,custom-exact,custom-range, or "all")
 *   --playback  seconds of playback to measure (default 10, 0 to skip)
 *   --seeks     random seeks (default 30)
 *   --memory-edits N  N splits then N undos, heap after each phase
 *   --ui-edits  real mouse edits (clip move, trim drag, inspector switching) measured with Event Timing
 *   --cpu       CDP CPU throttling rate (for example 4)
 *   --trace     write a CDP trace of the first measured run to temp/perf/traces/
 *   --heap      write a heap snapshot after the edits to temp/perf/traces/
 *   --headed    run headed (needed for real frame pacing)
 *   --tag       suffix for result file names
 * Output: one JSON document on stdout, raw per-run JSON in temp/perf/results/.
 */
const { chromium } = await import(process.env.BENCH_PLAYWRIGHT ?? 'playwright');
import { mkdirSync, writeFileSync, existsSync, mkdtempSync, rmSync, createWriteStream, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, cpus, totalmem, release } from 'node:os';
import { spawnSync } from 'node:child_process';

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
  return index >= 0 && argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[index + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);
const ALL = ['V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'V8', 'V9', 'V10', 'V11', 'V12', 'V13', 'V14'];
const ALL_EXPORTS = ['standard', '4k', '1080p', '720p', 'vertical', 'audio', 'custom-webm', 'custom-mov', 'custom-mkv', 'custom-target', 'custom-loudness', 'custom-exact', 'custom-range'];
const scenarioArg = opt('scenario', 'V1,V2,V4,V5,V12');
const scenarios = scenarioArg === 'all' ? ALL : scenarioArg.split(',');
const resolutions = opt('resolution', '1080').split(',').map((token) => {
  const match = /^(\d+)(?:p(\d+))?$/.exec(token);
  return { height: Number(match[1]), fps: match[2] ? Number(match[2]) : 30, label: token };
});
const backends = opt('backend', 'css').split(',');
const runs = Number(opt('runs', '3'));
const warmup = !has('no-warmup');
const exportArg = opt('export', 'none');
const exportsList = exportArg === 'none' ? [] : exportArg === 'all' ? ALL_EXPORTS : exportArg.split(',');
const playback = Number(opt('playback', '10'));
const seeks = Number(opt('seeks', '30'));
const memoryEdits = Number(opt('memory-edits', '0'));
const uiEdits = has('ui-edits');
const cpu = Number(opt('cpu', '1'));
const trace = has('trace');
const heap = has('heap');
const headed = has('headed');
const tag = opt('tag', '');
const BASE = process.env.BENCH_URL ?? 'http://127.0.0.1:5174';
const CHROME = process.env.BENCH_CHROME;
const resultsDir = 'temp/perf/results';
const tracesDir = 'temp/perf/traces';
const exportsDir = 'temp/perf/exports';
const fixturesDir = 'temp/perf/fixtures';
for (const dir of [resultsDir, tracesDir, exportsDir, join(fixturesDir, 'proxies')]) mkdirSync(dir, { recursive: true });

export const GPU_ARGS = ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'];

function ffprobe(file) {
  const result = spawnSync('ffprobe', ['-v', 'error', '-count_packets', '-show_entries',
    'stream=codec_type,codec_name,profile,width,height,r_frame_rate,avg_frame_rate,nb_read_packets,sample_rate,channels,pix_fmt:format=duration,size,format_name',
    '-of', 'json', file], { encoding: 'utf8' });
  return result.status === 0 ? JSON.parse(result.stdout) : { error: result.stderr };
}
function decodeErrors(file) {
  const result = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 64 << 20 });
  return result.status === 0 && !result.stderr.trim() ? 0 : Math.max(1, (result.stderr ?? '').trim().split(/\r?\n/).length);
}
function decodeErrorsPassthrough(file) {
  const result = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-fps_mode', 'passthrough', '-f', 'framemd5', '-'], { encoding: 'utf8', maxBuffer: 256 << 20 });
  return result.status === 0 && !result.stderr.trim() ? 0 : Math.max(1, (result.stderr ?? '').trim().split(String.fromCharCode(10)).length);
}
function probeSize(file) {
  const result = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  const [width, height] = result.stdout.trim().split(',').map(Number);
  return { width, height };
}

/** Same arguments as buildProxy() in src/video-merge.ts, so V13 uses what the app would build. */
function ensureProxy(name) {
  const source = join(fixturesDir, name);
  const { width, height } = probeSize(source);
  const targetHeight = height > 1080 ? 720 : 540;
  const targetWidth = Math.max(2, Math.round(((width || 1280) * targetHeight) / height / 2) * 2);
  const file = `proxies/${name.replace(/\.[^.]+$/, '')}-${targetHeight}p.mp4`;
  const target = join(fixturesDir, file);
  if (!existsSync(target)) {
    spawnSync('ffmpeg', ['-y', '-v', 'error', '-i', source, '-vf', `scale=-2:${targetHeight}:flags=lanczos`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24',
      '-force_key_frames', 'expr:gte(t,n_forced*0.5)', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', target]);
  }
  return { file, width: targetWidth, height: targetHeight };
}

const BASE_SEED = [
  ['v1080p30-10s.mp4', 'video/mp4'],
  ['mandel1080p30-15s.mp4', 'video/mp4'],
  ['hevc-1080p-10s.mp4', 'video/mp4'],
  ['vp9-1080p-10s.webm', 'video/webm'],
  ['speech-5min.wav', 'audio/wav'],
];
function seedFor(scenario, resolution) {
  if (scenario === 'V14') return [['v1080p30-3min-4M.mp4', 'video/mp4'], ['speech-5min.wav', 'audio/wav']];
  const seed = BASE_SEED.map((entry) => [...entry]);
  if (resolution.height >= 2160) seed[0] = [resolution.fps >= 60 ? 'v2160p60-20s.mp4' : 'v2160p30-10s.mp4', 'video/mp4'];
  else if (resolution.fps >= 60) seed[0] = ['v1080p60-1min.mp4', 'video/mp4'];
  return seed;
}

const browserVersions = new Set();
async function launch(profile) {
  return chromium.launchPersistentContext(profile, {
    headless: !headed,
    ...(CHROME ? { executablePath: CHROME } : {}),
    // On Windows, '--enable-features=Vulkan' gives headless Chromium the
    // SwiftShader software adapter. D3D11 through ANGLE plus the blocklist
    // override gets the real GPU in headless and headed runs.
    args: [...GPU_ARGS, '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
    viewport: { width: 1600, height: 1000 },
    acceptDownloads: true,
  });
}

async function cdpStream(cdp, handle, path) {
  const out = createWriteStream(path);
  for (;;) {
    const chunk = await cdp.send('IO.read', { handle, size: 1 << 20 });
    out.write(chunk.base64Encoded ? Buffer.from(chunk.data, 'base64') : chunk.data);
    if (chunk.eof) break;
  }
  await cdp.send('IO.close', { handle });
  await new Promise((resolve) => out.end(resolve));
}

async function startTrace(cdp) {
  await cdp.send('Tracing.start', {
    transferMode: 'ReturnAsStream',
    traceConfig: { includedCategories: ['devtools.timeline', 'v8.execute', 'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.frame', 'disabled-by-default-v8.cpu_profiler', 'blink.user_timing', 'loading', 'gpu'] },
  });
}
async function stopTrace(cdp, path) {
  const done = new Promise((resolve) => cdp.once('Tracing.tracingComplete', resolve));
  await cdp.send('Tracing.end');
  const { stream } = await done;
  await cdpStream(cdp, stream, path);
}

async function heapSnapshot(cdp, path) {
  const out = createWriteStream(path);
  const onChunk = ({ chunk }) => out.write(chunk);
  cdp.on('HeapProfiler.addHeapSnapshotChunk', onChunk);
  await cdp.send('HeapProfiler.enable');
  await cdp.send('HeapProfiler.collectGarbage');
  await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
  cdp.off('HeapProfiler.addHeapSnapshotChunk', onChunk);
  await new Promise((resolve) => out.end(resolve));
  return +(statSync(path).size / 1048576).toFixed(1);
}

async function cdpHeap(cdp) {
  const metrics = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((entry) => [entry.name, entry.value]));
  return { JSHeapUsedMB: +(metrics.JSHeapUsedSize / 1048576).toFixed(1), JSHeapTotalMB: +(metrics.JSHeapTotalSize / 1048576).toFixed(1), Nodes: metrics.Nodes, JSEventListeners: metrics.JSEventListeners, ScriptDuration: metrics.ScriptDuration, LayoutDuration: metrics.LayoutDuration, RecalcStyleDuration: metrics.RecalcStyleDuration, TaskDuration: metrics.TaskDuration };
}

// Counts object URLs, decoders, encoders and frames that were created and not released.
const COUNTERS = () => {
  const counters = { objectUrls: 0, revoked: 0, videoDecoders: 0, videoDecodersClosed: 0, videoEncoders: 0, videoFramesOpen: 0, audioContexts: 0 };
  window.__benchCounters = counters;
  const create = URL.createObjectURL;
  URL.createObjectURL = function (object) { counters.objectUrls += 1; return create.call(URL, object); };
  const revoke = URL.revokeObjectURL;
  URL.revokeObjectURL = function (url) { counters.revoked += 1; return revoke.call(URL, url); };
  if (window.VideoDecoder) {
    const Original = window.VideoDecoder;
    window.VideoDecoder = class extends Original {
      constructor(init) { super(init); counters.videoDecoders += 1; }
      close() { counters.videoDecodersClosed += 1; return super.close(); }
    };
    window.VideoDecoder.isConfigSupported = Original.isConfigSupported.bind(Original);
  }
  if (window.VideoEncoder) {
    const Original = window.VideoEncoder;
    window.VideoEncoder = class extends Original { constructor(init) { super(init); counters.videoEncoders += 1; } };
    window.VideoEncoder.isConfigSupported = Original.isConfigSupported.bind(Original);
  }
  if (window.AudioContext) {
    const Original = window.AudioContext;
    window.AudioContext = class extends Original { constructor(options) { super(options); counters.audioContexts += 1; } };
  }
};

/** Real mouse edits, measured with Event Timing in the page. */
async function mouseEdits(page) {
  const since = await page.evaluate(() => performance.now());
  const out = {};
  const box = async (selector, index = 0) => {
    const handles = await page.$$(selector);
    const handle = handles[index];
    return handle ? handle.boundingBox() : null;
  };
  // Clip move: drag the second clip 60 px to the right in 12 steps, then undo.
  let clip = await box('.vt-clip', 1);
  if (clip) {
    const t0 = Date.now();
    await page.mouse.move(clip.x + clip.width / 2, clip.y + clip.height / 2);
    await page.mouse.down();
    for (let step = 1; step <= 12; step += 1) await page.mouse.move(clip.x + clip.width / 2 + step * 5, clip.y + clip.height / 2);
    await page.mouse.up();
    out.moveWallMs = Date.now() - t0;
    await page.keyboard.press('Control+z');
  }
  // Trim drag on the end handle of the first clip.
  clip = await box('.vt-clip', 0);
  if (clip) {
    await page.mouse.click(clip.x + clip.width / 2, clip.y + clip.height / 2);
    await page.waitForTimeout(150);
    const handle = await box('.vt-clip .vt-handle-end', 0);
    if (handle) {
      const t0 = Date.now();
      await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
      await page.mouse.down();
      for (let step = 1; step <= 10; step += 1) await page.mouse.move(handle.x + handle.width / 2 - step * 4, handle.y + handle.height / 2);
      await page.mouse.up();
      out.trimWallMs = Date.now() - t0;
      await page.keyboard.press('Control+z');
    }
  }
  // Effect slider drag in the inspector for the selected clip.
  const slider = await box('#video-inspector input[type=range]', 0);
  if (slider) {
    const t0 = Date.now();
    await page.mouse.move(slider.x + 4, slider.y + slider.height / 2);
    await page.mouse.down();
    for (let step = 1; step <= 10; step += 1) await page.mouse.move(slider.x + 4 + (slider.width - 8) * step / 10, slider.y + slider.height / 2);
    await page.mouse.up();
    out.sliderWallMs = Date.now() - t0;
    await page.keyboard.press('Control+z');
  }
  // Inspector switching: click up to 8 different blocks (video, audio, title, graphic).
  const blocks = await page.$$('.vt-clip');
  const picks = [0, 1, 2, 3, Math.floor(blocks.length / 2), blocks.length - 1, blocks.length - 2, 5].filter((index, at, list) => index >= 0 && index < blocks.length && list.indexOf(index) === at);
  const t0 = Date.now();
  for (const index of picks) {
    const target = await blocks[index].boundingBox();
    if (target && target.width > 4) await page.mouse.click(target.x + Math.min(target.width / 2, 20), target.y + target.height / 2);
    await page.waitForTimeout(80);
  }
  out.inspectorClicks = picks.length;
  out.inspectorWallMs = Date.now() - t0;
  await page.waitForTimeout(300);
  out.events = await page.evaluate((since) => window.__bench.eventStats(since), since);
  return out;
}

const env = { os: `Windows ${release()}`, cpu: cpus()[0]?.model, logicalCores: cpus().length, ramGB: Math.round(totalmem() / 2 ** 30), build: 'Vite dev server', cpuThrottle: cpu, headed };
const summary = [];
let adapterNote = null;

for (const scenario of scenarios) {
  for (const resolution of resolutions) {
    const seed = seedFor(scenario, resolution);
    const proxies = scenario === 'V13'
      ? Object.fromEntries(seed.filter(([, type]) => type.startsWith('video/')).map(([name]) => [name, ensureProxy(name)]))
      : undefined;
    for (const backend of backends) {
      const samples = [];
      for (let run = warmup ? 0 : 1; run <= runs; run += 1) {
        const profile = mkdtempSync(join(tmpdir(), 'ls-vh-'));
        const context = await launch(profile);
        browserVersions.add(context.browser()?.version() ?? 'persistent');
        const page = context.pages()[0] ?? await context.newPage();
        page.on('dialog', (dialog) => dialog.accept());
        page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) console.error('navigated', frame.url()); });
        page.on('pageerror', (error) => console.error('pageerror', String(error).slice(0, 300)));
        const saved = [];
        page.on('download', async (download) => {
          const name = download.suggestedFilename();
          if (/\.localscribe\.zip$/.test(name)) return;
          const file = join(exportsDir, `${scenario}-${resolution.label}-${backend}-${run}${tag ? '-' + tag : ''}-${name}`);
          saved.push({ name, file, done: download.saveAs(file).then(() => file) });
        });
        await page.addInitScript(COUNTERS);
        const cdp = await context.newCDPSession(page);
        await cdp.send('Performance.enable');
        if (cpu > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
        const query = backend === 'css' ? '?compositor=css&ui=en' : `?compositor=${backend}&ui=en`;
        await page.goto(`${BASE}/video-editor/${query}`);
        await page.waitForSelector('#video-media-input', { state: 'attached' });
        await page.waitForFunction(() => document.querySelector('#video-export-main'));
        let result;
        try {
          const prep = await page.evaluate(async (seedList) => {
            const bench = await import('/bench/video-heavy-page.ts');
            window.__bench = bench;
            const environment = await bench.environment();
            const seed = await bench.buildSeed(seedList);
            window.__benchPassDownloads = true;
            return { environment, seed };
          }, seed);
          if (!adapterNote) {
            adapterNote = prep.environment.gpuAdapter;
            console.error(`WebGPU adapter: ${JSON.stringify(adapterNote)}`);
            if (/swiftshader/i.test(JSON.stringify(adapterNote ?? ''))) console.error('Warning: software GPU adapter. Discard GPU numbers.');
          }
          const tracePath = join(tracesDir, `${scenario}-${resolution.label}-${backend}${cpu > 1 ? `-cpu${cpu}` : ''}${tag ? '-' + tag : ''}.json`);
          const tracing = trace && run === 1;
          if (tracing) await startTrace(cdp);
          result = await page.evaluate(async (args) => window.__bench.runScenario(args.scenario, args.options), {
            scenario,
            options: { resolution: resolution.height, fps: resolution.fps, exports: exportsList, playback, seeks, memoryEdits, proxies },
          });
          if (tracing) {
            await stopTrace(cdp, tracePath);
            result.trace = tracePath;
          }
          result.environment = { ...env, ...prep.environment, browser: context.browser()?.version() ?? null };
          result.seed = prep.seed;
          result.cdpAfterRun = await cdpHeap(cdp);
          if (uiEdits) result.mouseEdits = await mouseEdits(page);
          if (heap && run === 1) {
            const path = join(tracesDir, `${scenario}-${resolution.label}-${backend}${tag ? '-' + tag : ''}.heapsnapshot`);
            result.heapSnapshot = { path, sizeMB: await heapSnapshot(cdp, path) };
          }
          result.cdpEnd = await cdpHeap(cdp);
          // Pair exported files with their exports and check them.
          await page.waitForTimeout(1500);
          for (const entry of result.exports ?? []) {
            const match = saved.find((item) => item.name === entry.downloadName);
            if (!match) continue;
            const file = await match.done;
            entry.file = file;
            entry.probe = ffprobe(file);
            entry.decodeErrors = decodeErrors(file);
            // '-f null' derives its time base from r_frame_rate; variable-rate files (retime) then
            // report timestamp collisions that are not decode errors. Recheck with passthrough timing.
            if (entry.decodeErrors) entry.decodeErrorsPassthrough = decodeErrorsPassthrough(file);
          }
          await page.evaluate(() => window.__bench.clearOpfs()).catch(() => undefined);
        } catch (error) {
          result = { scenario, error: String(error).slice(0, 2000) };
        }
        result.backend = backend;
        result.run = run;
        result.cpuThrottle = cpu;
        result.resolutionLabel = resolution.label;
        writeFileSync(join(resultsDir, `vh2-${scenario}-${resolution.label}-${backend}${cpu > 1 ? `-cpu${cpu}` : ''}${headed ? '-headed' : ''}${tag ? '-' + tag : ''}-${run}.json`), JSON.stringify(result, null, 2));
        if (run > 0) samples.push(result); // run 0 is the warm-up
        await context.close();
        removeProfile(profile);
      }
      const pick = (fn) => samples.map(fn).filter((value) => typeof value === 'number' && value >= 0).sort((a, b) => a - b);
      const med = (values) => (values.length ? values[Math.floor(values.length / 2)] : null);
      const max = (values) => (values.length ? values[values.length - 1] : null);
      const row = {
        scenario, resolution: resolution.label, backend, runs: samples.length, errors: samples.filter((r) => r.error).length,
        importMs: med(pick((r) => r.importMs)),
        importLongTaskMs: med(pick((r) => r.importTasks?.longTaskMs)),
        firstFrameMs: med(pick((r) => r.firstPreviewFrameMs)),
        filmstripsMs: med(pick((r) => r.filmstripsReadyMs)),
        zoomP95: med(pick((r) => r.zoom?.p95)),
        scrollP95: med(pick((r) => r.scroll?.p95)),
        splitMs: med(pick((r) => r.edits?.split?.p50)),
        undoMs: med(pick((r) => r.edits?.undo?.p50)),
        redoMs: med(pick((r) => r.edits?.redo?.p50)),
        redoP95: max(pick((r) => r.edits?.redo?.p95)),
        seekHandlerP95: max(pick((r) => r.seek?.handler?.p95)),
        seekPresentedP50: med(pick((r) => r.seek?.presented?.p50)),
        seekPresentedP95: max(pick((r) => r.seek?.presented?.p95)),
        seekTimeouts: samples.map((r) => r.seek?.timeouts ?? null),
        playbackFps: med(pick((r) => r.playback?.videoCallbacksPerSecond)),
        playbackSkipped: med(pick((r) => r.playback?.skippedSourceFrames)),
        playbackDropped: med(pick((r) => r.playback?.droppedVideoFrames)),
        rafP95: med(pick((r) => r.playback?.rafInterval?.p95)),
        backendSeen: [...new Set(samples.map((r) => r.playback?.backend ?? r.backendAfterImport))],
        saveTotalMs: med(pick((r) => r.save?.totalMs)),
        heapMB: med(pick((r) => r.cdpAfterRun?.JSHeapUsedMB)),
        exports: exportsList.map((preset, index) => {
          const times = pick((r) => r.exports?.[index]?.ms);
          const first = samples.find((r) => r.exports?.[index]?.ms > 0)?.exports[index];
          return { preset, ms: med(times), min: times[0] ?? null, max: max(times), bytes: first?.bytes ?? null, status: first?.status ?? null, decodeErrors: samples.map((r) => r.exports?.[index]?.decodeErrors ?? null) };
        }),
      };
      for (const entry of row.exports) {
        if (entry.ms && entry.max && (entry.max - entry.ms) / entry.ms > 0.15) entry.warning = `spread ${(((entry.max - entry.ms) / entry.ms) * 100).toFixed(0)}% over median`;
      }
      summary.push(row);
      console.error(JSON.stringify(row));
    }
  }
}

console.error('\nscenario  res      backend  import  split  redo95  seekPres95  pbFps  skip  save   heap');
for (const row of summary) {
  console.error(`${row.scenario.padEnd(9)} ${String(row.resolution).padEnd(8)} ${row.backend.padEnd(8)} ${String(row.importMs).padStart(6)} ${String(row.splitMs).padStart(6)} ${String(row.redoP95).padStart(7)} ${String(row.seekPresentedP95).padStart(11)} ${String(row.playbackFps).padStart(6)} ${String(row.playbackSkipped).padStart(5)} ${String(row.saveTotalMs).padStart(6)} ${String(row.heapMB).padStart(6)}`);
}
const out = { benchmark: 'video-heavy', base: BASE, environment: { ...env, gpuAdapter: adapterNote }, cpu, runs, exports: exportsList, summary };
writeFileSync(join(resultsDir, `vh2-summary-${scenarios.join('_').slice(0, 40)}-${resolutions.map((r) => r.label).join('_')}-${backends.join('_')}${cpu > 1 ? `-cpu${cpu}` : ''}${headed ? '-headed' : ''}${tag ? '-' + tag : ''}.json`), JSON.stringify(out, null, 2));
await removePendingProfiles();
console.log(JSON.stringify(out, null, 2));
