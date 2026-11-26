# Browser video editors — landscape and performance, November 2026

Scope: editors that open local files, edit, and export **without uploading the media**.
Cloud editors (CapCut Online, VEED, Kapwing, Flixier, Canva, 123apps' editor) are out
except as a reference point. SDKs and single-job tools are listed separately.

Method: vendor documentation, public benchmarks, GitHub READMEs, and hands-on reports
from launch threads. Figures come from the sources at the bottom; they are directional,
not a controlled benchmark of this machine.

---

## 1. The performance reality

Every browser editor is one of three architectures. The choice explains almost all of
the speed, memory, and format differences between products.

### A. WebCodecs + canvas/WebGPU compositor (the fast path)

- Decode and encode on the device's hardware codec.
- Frames are painted on a canvas (2D, WebGL, or WebGPU) and muxed in JS.
- Preview is real-time; export is usually 1–5× realtime at 1080p.
- The limits are codec *availability*, not CPU: H.264/HEVC/10-bit support depends on
  the browser and the OS, and Firefox is still the weak spot.

Measured examples:

| Test | WebCodecs | FFmpeg.wasm |
| --- | --- | --- |
| Same MP4 → WebM/VP8 conversion, M2 MacBook Air, Chrome 131 | **7.4 s** | **113.3 s** (Remotion benchmark) |
| 30 s 1080p H.264 encode | **2–5 s** | **30–60 s** (Velocaption) |
| 10-min 1080p H.264 compress | — | **45 min** vs 81 s native x264, single-threaded (ffmpeg-webCLI paper) |

The gap is roughly 15–30×, mostly because one path uses the GPU and the other runs
software codecs inside a WASM sandbox.

### B. FFmpeg.wasm for the whole pipeline

- Maximum format coverage, because it is the real FFmpeg.
- CPU-only, memory-bound, and fragile past a few minutes of 1080p.
- The WASM heap ceiling blocks known cases: 1080p VP9 at any length, and GIF from a
  10-minute clip (ffmpeg-webCLI paper). A developer who built a full FFmpeg.wasm editor
  reported it "fell over on longer videos"; another said long-form pushed them to a
  cloud pipeline.
- Editor UX is usually "pick a command, wait, download", not a live timeline.

### C. DOM `<video>` elements + CSS

- The easiest to build; what a lot of young editors do.
- Preview is whatever the browser's video element can play; compositing is CSS.
- Scrubbing is not frame-accurate, effects are limited, and multiple 4K decoders
  compete for the same hardware. Fine for short social clips, not for a real NLE.

### Memory and scale

- A Chromium tab is practically capped around 4 GB of JS/WASM memory. Tooscut's FAQ
  addresses the question directly; ffmpeg-webCLI hits it.
- VidStudio's own guidance: no arbitrary cap, but about **2 hours of 1080p** on a
  modern laptop, limited by RAM. A commenter processed **3+ hours** through it.
- The only way past that is not to hold the media in memory: stream frames and write
  the export straight to disk. wide.video does this (File System Access, "unlimited
  export sizes" since 1.6.8/1.6.25); our export already streams where supported.
- 4K preview is the other cliff. Editors that survive it either generate proxies
  (wide.video) or ask for a lot of RAM (Pikimov recommends 16 GB for HD work).

### Browser reach

- WebCodecs: Chromium and Safari are solid; Firefox shipped it but encode and
  HEVC/10-bit paths are still patchy. Real-world reports on VidStudio include
  `hvc1` (HEVC) failures on Firefox and 10-bit import failures on Windows.
- WebGPU: now in Chromium, Safari 26, and Firefox 141+, but driver maturity varies.
  Editors that gate on it (KubeezCut, Tooscut) still effectively mean "desktop Chrome
  or Edge".
- Practical conclusion: **Chromium desktop is the target; everything else is a
  graceful fallback.** That is true for every product below, not just ours.

---

## 2. Ranking

Ranked by overall usefulness as a *complete local editor* in November 2026, not by
GitHub stars or marketing. "Best at" is the one job it would be chosen for.

| # | Editor | Best at | Performance | Biggest limitation | License / price |
| --- | --- | --- | --- | --- | --- |
| 1 | **wide.video** | The most complete local NLE: 4K/120 fps, unlimited layers, captions with diarization and translation, TTS, background removal, stabilizer, multicam, proxies, huge codec list | WebGL filters + WebCodecs export + bundled FFmpeg for formats; writes exports straight to disk, background-tab export | Closed source; one maintainer; complex UI; Chromium best | Free, no account, no watermark |
| 2 | **Pikimov** | Motion design / After Effects replacement: 3 editors (classic, 2D, 3D), keyframes, expressions, particles, tracking, rotoscoping | Three.js/WebGL + GLSL passes; Mediabunny mux/demux; 4K; 16 GB RAM recommended | Chrome/Edge/Opera only; no Safari/Firefox; closed source; desktop app is Patreon-only | Free, no account |
| 3 | **OpenReel** | Best open-source breadth: keyframes, transitions, captions/SRT, EQ/ducking, color wheels/curves/LUTs, chroma key, 3D workspace | MediaBunny + WebCodecs + WebGPU + Three.js; browser-codec exports | Young project; ProRes/alpha only via desktop alpha; large projects need GPU/RAM | MIT, free |
| 4 | **FreeCut** | Desktop NLE semantics: ripple/roll/slip/slide, source monitor with insert/overwrite, nested sequences, GPU scopes, on-device transcription | WebGPU/WebCodecs; project files in a folder you pick | Beta; Chrome/Edge 113+; no broad format story yet | MIT, free |
| 5 | **Tooscut** | Cleanest GPU compositor architecture: Rust/wgpu → WASM, canvas timeline, bezier keyframes, real-time effects | Near-native preview claims; hardware export; small feature surface | Elastic License 2.0 (source-available, not OSI); 73 commits; basic effect set; 4 GB tab ceiling | Free, source-available |
| 6 | **VidStudio** | Long-form proof and pragmatic split: WebCodecs decode, Pixi/WebGL render, FFmpeg.wasm only for final mux/edge cases | Handled 3+ hours in a third-party test; 4K H.264/AAC export, VP9/Opus fallback | Closed source; HEVC/10-bit/Firefox gaps; ~2 h 1080p memory guidance; limited clip ops and track reordering; LGPL questions around its FFmpeg use | Free, no account |
| 7 | **Omniclip** | The simplest credible open-source timeline: trim/split, text, transitions, filters, 4K, WebRTC collaboration | WebCodecs; smooth on short clips | No keyframes or audio editing; >5 GB can crash an 8 GB machine; no Firefox; v2 in progress | MIT, free |
| 8 | **KubeezCut** | WebGPU effect stack + wide export menu (MP4/WebM/MOV/MKV; H.264/H.265/VP8/VP9/AV1), 5 GB imports | WebGPU shaders, WebCodecs encode; OPFS + IndexedDB | Very new; Chrome/Edge 113+; AI features are a cloud add-on | MIT, free |
| 9 | **Clipchamp** | Mainstream UX and Windows integration; the only big-name editor that keeps media local | Local preview and export; WebCodecs/FFmpeg hybrid historically | Microsoft account; project state in the cloud; 4K behind M365; shallow timeline | Free 1080p, paid 4K |
| 10 | **Mastershot Studio** | Free 4K with local AI tools (subtitles, silence cut, background removal, denoise) | Local, browser-native; new, so no independent benchmarks yet | Account required; launched Oct 2026; vendor-authored comparisons | Free; Pro $7/mo for cloud backup |

### Boundary cases

- **OpenCut (classic)** — huge mindshare (~88k stars at peak), MIT, CapCut-like UI.
  But the classic repo was **archived 17 May 2026**, the Rust rewrite is not ready, and
  contributions are paused. Basic MP4/WebM, no effects depth. Watch the rewrite; don't
  copy the classic.
- **editing.video, SnipStudio, BrowserCut, edit.video** — simple local timelines or
  single-job tools. BrowserCut is FFmpeg.wasm with an 8 GB file claim; it is a
  converter, not an editor.
- **FFmpeg WebCLI** — full FFmpeg in an offline PWA, 30+ operations, parity with native
  output except memory-bound cases. Great utility, no timeline.
- **Diffusion Studio** — commercial local editor with AI agents; its core engine is
  MPL-2.0 but renders a watermark unless licensed. Strong engine, not a direct consumer
  competitor.
- **SDK/engine layer**: Mediabunny (mux/demux, what we and several above use),
  Diffusion Studio Core, WebAV, Twick, Remotion `@remotion/web-renderer`, IMG.LY CE.SDK,
  Editframe, Rendley SDK. This is where "build vs buy" lives; none is a complete editor.

---

## 3. What the leaders do that we do not

Current timeline (verified in `src/video-merge.ts` and `src/video-projects.ts`):
multi-track video/image/audio, trim/split, drag between rows, static transforms,
per-clip volume/mute/fades, loop-to-fill, stacked audio rows, captions lane with
SRT/VTT import, ducking, safe areas, aspect/resolution presets, MP4/MOV/MKV/WebM,
loudness, exact cuts, audio-only export, voiceover, IndexedDB projects with media,
background jobs, direct-to-disk export, FFmpeg fallback.

That is already ahead of OpenCut, Omniclip, and Clipchamp on local-first workflow.
The gaps are concentrated in four areas:

| Gap | Who has it | Impact | Effort |
| --- | --- | --- | --- |
| **Text-based editing** — delete words to cut video, remove silences from the transcript | wide.video, Descript, VidStudio (captions only) | Highest. We already have ASR, segment timings, and a transcript UI. Turns a 40-minute interview edit into minutes | M |
| **Keyframes and animation** — animate transform, opacity, volume, effect params with easing | Pikimov, OpenReel, Tooscut, KubeezCut, FreeCut | High. "Static transform" is the single biggest capability gap vs every editor above us | M–L |
| **Color/effects pipeline** — LUTs, curves, brightness/contrast/saturation, blur, sharpen, chroma key, blend modes, masks, speed ramps | wide.video, Pikimov, OpenReel, KubeezCut | High for social/marketing work; also the reason these feel like "real" editors | L |
| **Proxy workflow for 4K** — generate a 540p/720p preview copy, switch on demand | wide.video, FreeCut (folder/proxy ideas) | Medium now, high as 4K footage grows. Prevents the 4 GB cliff and keeps scrubbing smooth | S–M |
| **Project portability** — export/import a project file, relink missing media | FreeCut (folder), wide.video (folder projects) | Medium. IndexedDB-only means "clear site data" deletes the edit | S |
| **Caption styling** — presets, per-word karaoke highlight, speaker colors | wide.video, VidStudio (karaoke), Submagic-style tools | Medium. We already have karaoke in Audio studio; reuse it | S–M |

### What not to chase

- **Pikimov's 3D compositing, particles, expressions** — a different product with a
  different audience. Adding it dilutes the "local media studio" position.
- **Real-time collaboration** — only Omniclip and cloud editors have it; it contradicts
  the no-backend promise.
- **A full FFmpeg.wasm pipeline** — slower, memory-bound, and worse than what we have.
  Keep FFmpeg for what WebCodecs cannot do (legacy containers, DSP, odd codecs), which
  is exactly the current split.

### Recommended order

1. Text-based editing + silence removal from the transcript (leverages our ASR; parity
   with wide.video; unique in the local open-source set).
2. Keyframe model with bezier easing, first on transform/opacity/volume, then effects.
3. Color + effect stack on a WebGPU/WebGL pass, starting with the cheap 80%: LUT,
   brightness/contrast/saturation, blur, chroma key, blend modes.
4. Proxy generation in the existing FFmpeg worker, with automatic switch above 1080p.
5. Project export/import (`.zip` with media + JSON) and a relink flow.
6. Caption presets, karaoke highlight, speaker colors.

---

## 4. Sources

- wide.video docs and changelog (v1.8.0, 2026-11-13): features, formats, direct-to-disk
  export, proxies, GPU HEVC, PWA. <https://wide.video/app/1.8.0/docs/llms.txt>
- Pikimov FAQ (2026-06-12): 4K, 16 GB RAM guidance, Chrome/Edge/Opera only, formats,
  stack (Three.js, Ember, MediaBunny). <https://docs.pikimov.com/faq>
- OpenReel README: stack, features, desktop export caveats.
  <https://github.com/Augani/openreel-video>
- FreeCut, per Mastershot's October 2026 comparison and its README.
  <https://freecut.net/> · <https://github.com/walterlow/freecut>
- Tooscut README and docs: WebGPU + Rust/WASM, Elastic License 2.0.
  <https://github.com/mohebifar/tooscut> · <https://docs.tooscut.app>
- VidStudio editor page and Show HN thread: long-form, codec gaps, memory guidance,
  architecture. <https://vidstudio.app/video-editor> ·
  <https://news.ycombinator.com/item?id=47847558>
- Omniclip README and Show HN thread: MIT, 4K, v2, limitations.
  <https://github.com/omni-media/omniclip>
- KubeezCut launch post: WebGPU, 5 GB imports, export matrix, browser requirements.
  <https://dev.to/sebyx07/i-built-a-free-browser-video-editor-with-webgpu-webcodecs-optional-ai-generation-2eo0>
- Clipchamp support: local preview/export, cloud project data, work-account backup.
  <https://support.microsoft.com/en-gb/clipchamp/how-clipchamp-stores-and-processes-media-files-in-editing-projects>
- Mastershot's 73-editor comparison (2026-10-18), used for the local/cloud split and
  pricing. It is vendor-authored; cross-checked where possible.
  <https://mastershot.app/blog/online-video-editors-compared>
- Remotion WebCodecs vs FFmpeg.wasm benchmark (M2 Air, Chrome 131).
  <https://github.com/remotion-dev/webcodecs-benchmark>
- ffmpeg-webCLI paper: 10-minute 1080p compress in 45 min vs 81 s native, VP9/GIF heap
  ceiling. <https://arxiv.org/html/2608.28950v1>
- Velocaption, WebCodecs vs FFmpeg.wasm summary: 30 s 1080p encode, 2–5 s vs 30–60 s.
  <https://velocaption.com/blog/webcodecs-browser-video-editing>
- OpenCut classic archive notice (2026-05-17) and rewrite status.
  <https://github.com/opencut-app/opencut-classic>
