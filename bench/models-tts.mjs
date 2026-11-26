/**
 * Text to speech through the real TTS view.
 *
 *   bun bench/models-tts.mjs --engines tiny-voca,tiny-voca-accurate,kokoro-q8,woof,phonon --runs 3
 *
 * Per engine, one temporary profile (deleted at the end): a cold 100-character
 * generation (download, runtime and session start), then 100, 1,000 and 5,000
 * characters as WAV (no encoder), then 1,000 characters in every output
 * format. Wall time is click to "audio is ready"; the first preview audio
 * source time is recorded when the engine streams. GPU flags match the other
 * benches and the adapter is recorded.
 */
const { chromium } = await import(process.env.BENCH_PLAYWRIGHT ?? 'playwright');
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : fallback;
};
const BASE = process.env.BENCH_URL ?? 'http://127.0.0.1:5174';
const engines = opt('engines', 'tiny-voca,kokoro-q8,woof,phonon').split(',');
const runs = Number(opt('runs', '3'));
const sizes = opt('sizes', '100,1000,5000').split(',').map(Number);
const formats = opt('formats', 'mp3,wav,ogg,flac,m4a,webm,opus').split(',');
const GPU_ARGS = ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'];

const CONFIG = {
  'tiny-voca': { model: 'tiny-voca', phonemizer: 'fast' },
  'tiny-voca-accurate': { model: 'tiny-voca', phonemizer: 'accurate' },
  'kokoro-q8': { model: 'kokoro', device: 'wasm-q8' },
  'kokoro-webgpu': { model: 'kokoro', device: 'webgpu' },
  'kokoro-wasm': { model: 'kokoro', device: 'wasm' },
  woof: { model: 'woof' },
  phonon: { model: 'phonon' },
  supertonic: { model: 'supertonic' },
};

const SENTENCES = [
  'The quick brown fox jumps over the lazy dog near the quiet river bank.',
  'Local speech tools keep every recording on this device and never upload a byte.',
  'Each sentence in this benchmark has a similar length and ordinary punctuation.',
  'We measure how long the voice takes to finish a paragraph of plain English text.',
  'Numbers like 42 and dates like March 3rd are read the way a person would say them.',
];
function text(chars) {
  let out = '';
  for (let index = 0; out.length < chars; index += 1) out += (out ? ' ' : '') + SENTENCES[index % SENTENCES.length];
  return out.slice(0, chars).replace(/\s+\S*$/, '.');
}

async function generate(page, chars, format) {
  await page.selectOption('#tts-format', format);
  await page.fill('#tts-text', text(chars));
  await page.waitForFunction(() => !document.getElementById('tts-generate-btn').disabled, null, { timeout: 600000 });
  await page.evaluate(() => {
    window.__lt = [];
    window.__ttsT0 = performance.now();
    window.__firstPreview = null;
    const audio = document.getElementById('tts-preview-audio');
    const observer = new MutationObserver(() => { if (audio.getAttribute('src') && window.__firstPreview == null) window.__firstPreview = performance.now() - window.__ttsT0; });
    observer.observe(audio, { attributes: true, attributeFilter: ['src'] });
    document.getElementById('tts-status').textContent = '';
  });
  const start = Date.now();
  await page.click('#tts-generate-btn');
  await page.waitForFunction(() => /audio is ready|error|failed|could not|not available/i.test(document.getElementById('tts-status').textContent), null, { timeout: 3600_000, polling: 50 });
  const wallMs = Date.now() - start;
  return page.evaluate((wallMs) => ({
    wallMs,
    status: document.getElementById('tts-status').textContent.trim().slice(0, 200),
    meta: document.getElementById('tts-meta').textContent.trim(),
    firstPreviewMs: window.__firstPreview != null ? Math.round(window.__firstPreview) : null,
    longTasks: window.__lt.length,
    longTaskMs: Math.round(window.__lt.reduce((s, t) => s + t, 0)),
    longTaskMax: Math.round(Math.max(0, ...window.__lt)),
    heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null,
    ffmpegLoaded: performance.getEntriesByType('resource').some((e) => /ffmpeg[^/]*.wasm|ffmpeg-core|core-mt/i.test(e.name)),
  }), wallMs);
}

const results = [];
for (const engine of engines) {
  const config = CONFIG[engine];
  const profile = mkdtempSync(join(tmpdir(), 'ls-tts-'));
  const context = await chromium.launchPersistentContext(profile, { headless: true, args: GPU_ARGS, viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(() => {
    window.__lt = [];
    try { new PerformanceObserver((list) => window.__lt.push(...list.getEntries().map((e) => e.duration))).observe({ type: 'longtask' }); } catch {}
  });
  const page = context.pages()[0] ?? await context.newPage();
  page.on('dialog', (d) => d.accept());
  const open = async () => {
    await page.goto(`${BASE}/?ui=en#/tts`, { waitUntil: 'load' });
    await page.waitForSelector('#tts-model');
    await page.selectOption('#tts-model', config.model);
    await page.waitForTimeout(300);
    if (config.device) await page.selectOption('#tts-kokoro-device', config.device);
    if (config.phonemizer) await page.selectOption('#tts-phonemizer', config.phonemizer);
    await page.waitForTimeout(300);
  };
  await open();
  const env = await page.evaluate(async () => {
    const a = navigator.gpu ? await navigator.gpu.requestAdapter() : null;
    return { userAgent: navigator.userAgent, crossOriginIsolated, gpuAdapter: a ? { vendor: a.info.vendor, architecture: a.info.architecture } : null };
  });
  const row = { engine, config, env, cases: [] };
  const record = async (label, chars, format) => {
    const sample = await generate(page, chars, format);
    row.cases.push({ label, chars, format, ...sample });
    console.error(`${engine} ${label} ${chars} ${format}: ${sample.wallMs} ms · ${sample.meta} · ${sample.status.slice(0, 80)}`);
    return sample;
  };
  try {
    const cold = await record('cold', 100, 'wav');
    if (/ready/i.test(cold.status)) {
      await open();
      await record('disk-cached', 100, 'wav');
      for (const chars of sizes) for (let run = 0; run < runs; run += 1) await record('speed', chars, 'wav');
      for (const format of formats) for (let run = 0; run < Math.min(2, runs); run += 1) await record('format', 1000, format);
    }
  } catch (error) {
    row.error = String(error).split('\n')[0];
    console.error(engine, row.error);
  }
  results.push(row);
  await context.close();
  try { rmSync(profile, { recursive: true, force: true }); } catch { await new Promise((r) => setTimeout(r, 2000)); try { rmSync(profile, { recursive: true, force: true }); } catch { console.error('could not delete', profile); } }
}
mkdirSync('temp/perf/results', { recursive: true });
writeFileSync(`temp/perf/results/tts-${engines.join('_')}.json`, JSON.stringify({ benchmark: 'tts', base: BASE, results }, null, 2));
console.log(JSON.stringify(results.map((r) => ({ engine: r.engine, error: r.error, cases: r.cases.map((c) => [c.label, c.chars, c.format, c.wallMs, c.meta, c.firstPreviewMs]) })), null, 2));
