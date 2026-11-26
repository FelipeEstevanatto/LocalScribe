# Performance runbook

How to regenerate the fixtures and rerun every benchmark from the November 2026
performance audit. Results go to `temp/perf/results/`, traces to
`temp/perf/traces/` (both gitignored).

## 1. Fixtures

```sh
bun bench/perf-fixtures.ts --set core     # about 120 MB, needed by the editor bench
bun bench/perf-fixtures.ts --set full     # adds long speech, music, 4K60, VFR, 10-bit, AVI/WMV, images (several GB)
```

Every ffmpeg command is written to `temp/perf/fixtures/commands.json`.
Existing files are skipped, so the command is safe to rerun.

## 2. No browser needed

```sh
bun run bench:mel                                    # log-mel frontend
bun bench/pixel-effects.ts                           # export-only chroma/tone/LUT loop, prototype parity check
bun bench/checksums-page.ts 10 50 100                # metadata viewer checksums (JavaScriptCore, indicative only)
bunx vite build --sourcemap --outDir temp/perf/build-sm --emptyOutDir
bun bench/bundle-attribution.ts temp/perf/build-sm --entry-only --top 40   # what is in the entry chunk
bun bench/bundle-attribution.ts temp/perf/build-sm --top 4                  # every chunk
```

## 3. In-page modules (any Chromium, no Playwright)

Start the dev server (`.claude/launch.json` config `dev`, or `bun run dev --port 5174`).
Vite serves `bench/` and `temp/perf/fixtures/`, so these run from the console:

```js
// Editor: open http://localhost:5174/video-editor/ first.
window.confirm = () => true;               // the import asks before replacing a timeline
const bench = await import('/bench/video-heavy-page.ts');
await bench.buildSeed();                    // adds the core fixtures and exports a seed project
await bench.runScenario('V5', { resolution: 1080, export: 'standard' });
await bench.verifyLastExport();             // codec, size, duration, packet count via Mediabunny

// Any page on the dev server:
await (await import('/bench/transcript-ui-page.ts')).run([100, 500, 1000]);
await (await import('/bench/checksums-page.ts')).run([10, 100]);
await (await import('/bench/pixel-effects.ts')).run({ width: 1920, height: 1080 });
```

Calls over about 40 s should be started without `await` and polled
(`window.__results`), because browser automation tools time out.

Each imported scenario is saved as a project in IndexedDB. Delete the
`bench-V*` projects afterwards (Projects menu), or clear site data for the
dev origin: a full V1 to V14 pass stores several GB.

## 4. Playwright

Playwright is a dev dependency, and its Chromium is installed with
`bunx playwright install chromium`.

GPU notes (Windows, checked with Chromium 159 on an RTX 3060 Ti):

- WebGPU needs a secure context, so test on `http://localhost` or
  `127.0.0.1`, never a `data:` URL.
- Headless Chromium with `--enable-features=Vulkan`, or with no flags, gets
  no adapter or the SwiftShader software adapter. Use
  `--enable-unsafe-webgpu --ignore-gpu-blocklist --use-angle=d3d11` to get the
  real GPU headless. A headed window gets the real GPU without flags.
- `video-heavy.mjs` prints the adapter it got and warns on SwiftShader.
- `channel: 'msedge'` also works. Chrome is not installed on this machine.

```sh
bun run dev -- --host 127.0.0.1 --port 5174
bun bench/video-heavy.mjs --scenario all --resolution 1080,2160 --backend css,webgl,webgpu --runs 3 --export standard
bun bench/video-heavy.mjs --scenario V4,V12 --cpu 4 --trace           # throttled, with CDP traces
bun bench/video-heavy.mjs --scenario V4 --headed --backend webgl      # real frame pacing needs a visible window
bun run build && bun run preview -- --host 127.0.0.1 --port 4173
bun bench/routes.mjs --runs 5 && bun bench/routes.mjs --cpu 4
bun run bench:load && bun run bench:video && bun run bench:media     # existing harnesses
```

`video-heavy.mjs` saves each export to `temp/perf/exports/` and runs
`ffprobe` and `ffmpeg -v error -f null` on it. One warm-up run per case is
discarded; cases with more than 15% export spread are flagged.

## 5. Rules

- Report the environment block (OS, CPU, RAM, GPU adapter, browser,
  `crossOriginIsolated`, dev or production build, cache state).
- Keep the benchmark tab visible when frame pacing or `requestAnimationFrame`
  matters. A hidden tab throttles timers and stops painting.
- At least 5 runs per case (3 over 60 s), median, p95 or max, min.
