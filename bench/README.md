# Performance benchmarks

These are local, reproducible checks for the parts that dominate the app:
the Qwen/Rumble log-mel frontend, video timeline interaction, media import,
export, and ASR load/cancel behavior.

## Log-mel frontend

```sh
bun run bench:mel
```

30 seconds of 16 kHz test audio, five runs after warmup, median reported.

| Revision | Median | Realtime factor |
| --- | ---: | ---: |
| Direct 400-point DFT | 202.38 ms | 148.2x |
| Exact 400-point mixed-radix FFT | 74.60 ms | 402.1x |

The FFT change is 2.7x faster in the pure frontend. The mixed-radix plan lives
in `src/mixed-fft.ts`; `tests/mixed-fft.test.ts` compares it with a direct DFT
at 5, 6, 10, 25, 200, and 400 points. Zero-padding to 512 was rejected because
it would change the bin spacing and the resulting mel features.

## Video editor and export

### November 2026 optimization pass

Matched before and after runs on Windows with headless Edge 158. Each timing
is the median of three runs using the same generated fixtures, fresh browser
contexts, and a separate Vite dependency cache for each checkout. Both
checkouts include the same working-tree UI edits. [Raw results](../benchmarks/video-editor-optimization.json)

| Case | Before | After |
| --- | ---: | ---: |
| 10 s matching join, click to download | 717 ms | **93 ms** |
| 6 s split join with soundtrack mix | 656 ms | 661 ms |
| 15 s mixed video and still export | 1,948 ms | 2,046 ms |
| 2× retime export, trimmed input | 1,089 ms | **469 ms** |
| 0.5× retime export, trimmed input | 1,925 ms | **472 ms** |
| LUT, tone curve and blur export | 1,114 ms | **999 ms** |
| 4K timeline seek p50 / p95 | 453 / 1,793 ms | **12 / 23 ms** |
| Two-video import, first decoded preview frame | 205 ms | **165 ms** |
| Two-video import, filmstrips and waveforms ready | 461 ms | **433 ms** |
| Eight zoom steps | 116 ms | 122 ms |
| 45 s preview audio, offline stereo frames allocated | 2,160,000 | **0** |

The 4K seek test uses 12 timeline clicks per run. The after run waits for the
automatic 720p proxy, which took 3.29 s median from import while the original
was available for preview. Presented frame timestamps were within one 30 fps
frame of the requested time in both builds. Full quality switched back to
2160p, and Auto switched back to the proxy. The long-audio case played through
a streaming media element after the change.

All 36 exports decoded end to end. Trimmed speed tests met the expected
duration tolerance, and the checked effects export matched decoded frames
(SSIM 1.000). Untouched compatible linked audio was copied without requesting
FFmpeg WASM. The mix and split scenarios continued to use the mix path.
Measured drag and scrub runs had zero main-thread tasks over 50 ms on both
versions. Mixed export and zoom were about 5% slower at the median with
overlapping ranges across the three runs. Headless browser runs do not measure
display refresh pacing.

Run the updated editor harness with `BENCH_RUNS=3` and `BENCH_4K=1`. Set
`BENCH_EXPECT_PROXY=1` for the optimized checkout to check automatic proxy
selection and audio packet copy. Run with `BENCH_ENGINE_ONLY=1` and
`BENCH_4K=0` for the retime, effects, and preview-audio cases. Each checkout
should use its own Vite dependency cache and disable HMR during timed runs.
FFmpeg and ffprobe must be on PATH.

### Earlier timeline and export measurements

Start the dev server, install Playwright if needed, then run:

```sh
bun run dev -- --host 127.0.0.1 --port 5174
bun add -D playwright          # only needed for this benchmark
bunx playwright install chromium
bun run bench:video
```

Set `BENCH_CHROME` to an existing Chromium/Chrome executable to skip the
Playwright browser download.

The script generates two short H.264 clips, two halves of one clip, and an
image with ffmpeg, then measures:

- importing two videos until filmstrips and audio peaks exist
- eight zoom-in steps (rAF-paced)
- a 300 px clip drag, reported as wall time and main-thread long tasks
- a ruler scrub across 60% of the timeline
- exporting two videos plus one image as MP4 (the safe re-encode path)
- exporting two split halves that share one H.264 configuration (the copy path)

Every exported file is decoded with `ffmpeg -v error -i <file> -f null -`;
`decodeErrors` is the number of error lines and must be zero.

Headless Chromium, Windows, 1480 x 1000, two runs each. Values are observed
ranges across clean runs.

| Case | Baseline | Current |
| --- | ---: | ---: |
| Two-video import | 1.15-1.40 s | 1.1-1.9 s |
| Eight zoom steps | 150-201 ms | 87-152 ms |
| Ruler/grid nodes at max zoom | 1,432 | 130 |
| Drag long tasks | 0 | 0 |
| Scrub long tasks | 0 | 0 |
| MP4 export, 15 s mixed timeline | 2.73-2.84 s | 2.6-3.1 s |
| MP4 export, 6 s split copy (sound mixed) | not measured | 0.56-0.72 s |
| MP4 export, 10 s copy (sound copied) | not measured | 0.05-0.19 s |
| Mixed export output | 1.3 MB | 1.3 MB |
| Copy export output | not measured | 1.1 MB |

The zoom path is roughly 24-42% faster and creates 91% fewer ruler/grid nodes.
Import time is flat because the benchmark clips are short; the filmstrip and
peak work is now stored as Blobs and streams audio for long files instead of
decoding the whole track into one `AudioBuffer`. Drag and scrub still produce
no long tasks.

### Video copy and streaming export

The exporter builds the timeline as work segments, then decides whether the
whole timeline can take the packet-copy path. Exact copy is only used when
every segment is an untrimmed, untransformed video clip at the output size,
its rotation is zero, and all source clips share one decoder configuration
(codec, coded size, and SPS/PPS bytes). The comparison respects each
description view's offset and length: reading the underlying `ArrayBuffer`
directly made identical H.264 configurations compare unequal whenever
Mediabunny returned a subarray.

This all-or-nothing rule is required because Mediabunny's MP4/WebM muxer
stores one decoder configuration per video track and reads it from the first
packet. Mixing a copied segment with a WebCodecs-encoded segment produces
different SPS/PPS and corrupts playback; an earlier mixed-copy attempt failed
`ffmpeg` decode with `reference count overflow`, `no frame!`, and `valid data
not found`. When the configurations differ, every segment is re-encoded.

On the copy path no intermediate file is created: exact packets go straight to
the final mux, and audio packets are copied when the codecs and durations also
match. On the encode path only one temporary segment is alive at a time and it
is disposed as soon as its packets are in the final mux, so peak memory no
longer grows by one intermediate file per segment.

The 10 s pure-copy case (6 s + 4 s clips, video and audio copied) takes
0.05-0.19 s from click to downloaded file and decodes cleanly. A 6 s split-clip
case takes 0.56-0.72 s because its soundtrack has to be mixed; the video still
copies. Overlapping timelines, gaps, image segments, and configuration changes
were all checked with `ffprobe` plus a full decode.

## SEO and initial load

The static SEO pages are generated separately from the app shell, so this
section measures two different things: the generated page inventory/metadata,
and the cold app-shell load.

```sh
bun run build
bun run preview -- --host 127.0.0.1 --port 4173
bun run bench:seo
bun run bench:load          # BENCH_CPU=4 for a slower mobile-class CPU
```

`bench:seo` audits every generated `dist/**/index.html` for social images,
JSON-LD, canonical URLs, heading counts, title/description length, broken
internal links, and thin Quick Tools pages. `bench:load` opens the production
build with service workers blocked, so it measures a true first visit.

Before is the previous build at `48db12c`; after is the current build. Load
numbers are medians of three runs on headless Chromium.

| Metric | Before | After |
| --- | ---: | ---: |
| Initial JS | 344.2 KB gzip / 1.03 MB decoded | **123.7 KB gzip / 353 KB decoded** |
| Initial JS + CSS | 369.2 KB gzip | **148.7 KB gzip** |
| DOMContentLoaded, desktop CPU | 290 ms | **171 ms** |
| Startup long task, desktop CPU | 177 ms | **100 ms** |
| Largest Contentful Paint, desktop CPU | 623 ms | **613 ms** |
| DOMContentLoaded, 4x CPU | 827 ms | **676 ms** |
| Startup long task, 4x CPU | 492 ms | **354 ms** |
| Generated pages | 165 | **174** |
| Quick Tools hubs | 0 | **9** |
| Pages with `og:image` / `twitter:image` | 0 / 165 | **174 / 174** |
| Quick pages with JSON-LD | 0 / 144 | **144 / 144** |
| Median Quick Tools page words | 68 | **251** |
| Quick pages under 150 words | 131 | **0** |
| Titles over 60 chars | 7 | **0** |
| Descriptions over 160 chars | 8 | **0** |
| Pages with heading-count issues | 1 | **0** |
| Duplicate titles | 1 | **0** |
| Broken internal links | 0 | **0** |

The initial JS reduction comes from loading only the selected language pack,
splitting out Audio Studio, Video Editor, Quick Tools, Diarization, the model
chart, and the MP3 encoder, and setting those up on first use. The first visit
also no longer reloads the page to enable COOP/COEP; the service worker adds
isolation on the next navigation, and the cache name now includes the build
hash.

Route chunks load on first use: Audio Studio is 47.6 KB minified, Video Editor
is 83.3 KB, Quick Tools is 52.7 KB, the selected language pack is 29-54 KB, and
the MP3 encoder is 169 KB. None of them are part of the initial script.

`_headers` is included for hosts that support static header files (Cloudflare
Pages, Netlify): hashed assets get an immutable one-year cache and the app gets
COOP/COEP response headers. GitHub Pages ignores it.

## Media fast-path gaps

```sh
bun run dev -- --host 127.0.0.1 --port 5174
bun add -D playwright
bunx playwright install chromium
bun run bench:media
```

The script generates its own 6 s and 15 s H.264 clips, a 30 s MP3, a 10 s
Opus recording, and a 24 s MP3 with silence at both ends. Each scenario uses a
fresh browser context so the FFmpeg core is cold. Every exported video is
decoded end to end with `ffmpeg -f null -`; any decode error fails the run.

"Before" is the previous FFmpeg path. "After" is the current path, measured
three times; the table shows the observed range and median.

| Scenario | Before | After | Change |
| --- | ---: | ---: | ---: |
| Quick Video converter, 6 s 640x360 | 1.65 s | 0.83-1.43 s (1.01 s) | ~1.6x |
| Quick Video compressor, 15 s 720p to 3 MB | 8.78 s | 2.62-2.95 s (2.84 s) | 3.1x |
| Quick Video exact trim, 4 s | 1.22 s | 0.83-1.01 s (0.97 s) | 1.3x |
| Extract 12 frames | 0.67 s | 0.14-0.18 s (0.15 s) | 4.4x |
| Extract AAC, 6 s | 0.47 s | 0.034-0.037 s | 12.7x |
| Video editor audio-only, 6 s | 0.93 s | 0.10-0.13 s | 8.3x |
| Audio Studio 10 s effects preview | 0.54 s | 0.16-0.17 s | 3.2x |
| ASR forced browser decode fallback, 30 s | 0.44 s | 0.22-0.24 s | 1.9x |
| Recording decode, 10 s Opus/WebM | 0.41 s | 0.086-0.103 s | ~4.5x |
| Batch trim silence, 24 s to 20.2 s | 0.40 s | 0.27-0.37 s | 1.2-1.5x |

No Quick Video re-encode, frame extraction, AAC extraction, audio-only export,
audio preview, ASR fallback, or batch trim in this run requested the FFmpeg
core (`ffmpegCore: false`). Exact trims decode the trimmed audio in the browser
and encode one AAC track; the old path loaded a fresh FFmpeg worker for the
same work.

The compressor now lands at 2.86 MB for a 3 MB target. The batch trim result
is encoded at 128 kbps CBR instead of FFmpeg's VBR MP3, so a pure-tone test file
is larger even though it processes faster; real speech/music files are close.

## Compact device defaults

No timing is involved; this is a download and memory check. With a 4 GB or
mobile profile, a fresh install now selects:

| Default | Before | After |
| --- | ---: | ---: |
| Speech model | Fluid Speech Mini, ~300 MB | Whisper Tiny multilingual Q8, ~44 MB |
| Kokoro when selected | FP32, ~325 MB | Q8, ~88 MB |

A capable desktop with WebGPU still defaults to Fluid Speech Mini and Kokoro
FP32. Saved user choices and URL `model`/`variant` parameters always win.

## ASR load, warmup, and cancellation

Measured with the bundled `jfk.wav` and the local model cache:

- **Cancellation:** after loading Whistle, cancelling a long transcription and
  starting again reports `0.0 s model load`. The previous behavior terminated
  the worker, and the next run paid a ~3.8 s cache reload for the same model.
- The client tags each request with an id, keeps the loaded worker and ONNX
  sessions alive, sends a per-request cancel, and ignores late partials and
  results from a cancelled run.
- **Warmup:** on WebGPU models, load now runs one second of silence through the
  engine before reporting ready. Fluid Speech Mini loaded with WebGPU + WASM
  and the first real 11 s clip then decoded in 3.0 s. WASM-only warmup was
  removed after it made load slower without improving the first real chunk.
- Cactus (WASM-only) and Granite (large Transformers.js model) skip warmup.


