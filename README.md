# LocalScribe

Privacy-first audio, voice, and vision tools that run entirely in the browser. Choose a model, drop an
OGG, WAV, MP3, M4A, MP4, or WebM file (or record a note), and get editable text without sending
audio to a server.

There is no backend, no account, and no analytics. The audio file never leaves the tab.

- **Selectable speech models** — Fluid Speech, Moonshine, timestamped Whisper, Parakeet Redux, Parakeet Ultra, Phonon-2, Rumble-2-Flash, Qwen3-ASR, Omnilingual ASR, Granite Speech, and Whistle.
- **A local text-to-speech tab** — four voice engines: tiny-voca (21 MB, two voices, bundled), Kokoro-82M (28 US/UK voices, FP32 or Q8), Underdog Woof (41 MB, two voices, no ONNX), and Reverb-TTS (297M, zero-shot voice cloning in seven languages, WebGPU). Output can be MP3 (default), WAV, OGG, FLAC, M4A, WebM, or Opus.
- **Vision studio** — background removal, depth estimation, object detection, image segmentation, ImageNet classification, and image captioning through Transformers.js.
- **A proper Model Setup card** — pick a model, choose WebGPU or WASM, load or reload, and watch inline progress with a cancel button. The status dot shows ready, busy, cached, or partial at a glance.
- **WebGPU first** — the heavy encoders request WebGPU; WASM is the fallback. Granite Speech requires WebGPU.
- **Multi-threaded WASM on static hosts** - a header-only service worker adds COOP/COEP on the next navigation so ONNX Runtime can use up to 8 CPU threads on GitHub Pages. The first visit never reloads itself.
- **Runtime asset selection** — CPU-only sessions load the 15 MB WASM runtime, not the 29 MB WebGPU build. The runtime is fetched while model files download.
- **Parallel model downloads** — four 32 MB ranges in flight, resumable chunks, and parallel cache reads. A warm 300 MB model loads in about a second.
- **Download speed and ETA** — streamed 32 MB Range chunks, a rolling throughput estimate, and a remaining-time estimate in the model download card.
- **Resumable model cache** — completed chunks are stored in the Cache API, so an interrupted download resumes where it stopped.
- **Model cards with cache state** — each model shows its language count, size, and a **Not cached / Partial / Cached / Ready now** badge. The selected card also says whether it is downloaded and verified or loaded in memory. The variant selector appears only when a model has more than one supported variant.
- **Quota-aware storage panel** — shows bytes used, percentage of the browser's site quota, free space, and whether storage is persistent.
- **Downloaded-models list** — clear one model or all cached models; each row shows Cached/Partial/Ready now.
- **Streaming transcript** — text appears segment by segment while decoding; the final text stays editable.
- **Audio ↔ transcript segments** — every silence-split segment is listed with its timestamp. Click a segment to seek the audio, and the active segment is highlighted during playback.
- **Language override** — Rumble-2-Flash and Qwen3-ASR can auto-detect or force one of their supported languages.
- **Clean mode** — optional filler/repetition removal for Fluid Speech Pro.
- **Long recordings** — silence-aware segmentation keeps memory bounded.
- **No third-party runtime CDN** — ONNX Runtime Web, Transformers.js, and their WASM binaries are bundled with the site. Only model weights are fetched from Hugging Face.
- **Microphone and dictation** — record in the tab, stop, and the clip is decoded and transcribed. A dictation clean-up pass turns spoken punctuation and number words into text and digits.
- **A sample you can try first** — a bundled 12-second public-domain clip runs without a file picker.
- **Job presets** — voice note, English dictation, multilingual, meeting, best accuracy, translation, and long-tail languages choose a sensible model, language, and clean mode.
- **Exports that match the job** — TXT, SRT, VTT, Markdown, JSON, and CSV from the same transcript.
- **Opt-in local history** — text and timings in IndexedDB, no audio. Turning it off deletes the database.
- **Batch queue in Audio to text** — add several files below the recorder and run them one at a time with the model, language, backend, and clean mode chosen above; each result can be saved to history.
- **Offline after the first visit** — the service worker caches the app shell and the runtime actually used, and the model weights stay in Cache Storage.
- **Privacy receipt** — a per-run count of request destinations, methods, and response sizes, so “no upload” is something you can inspect rather than a claim.
- **Device fit labels and a benchmark** — each model says whether it runs here, and “Test this device” measures model load and decode speed on the sample.
- **Shareable state** — model, variant, language, clean mode, CPU mode, and tab are reflected in the URL and restored on load.
- **Voice gallery** — every Kokoro and tiny-voca voice is selectable as a card, with a local preview.
- **A suite shell** - a persistent sidebar switches between Audio to text, Text to speech, Audio studio, Video editor, Screen recorder, Quick tools, Vision studio, Documents & privacy, Models & storage, History, and Settings & verification. The sidebar collapses to an icon rail and remembers the choice. The UI is a dark navy/indigo/cyan studio with a gradient rail and per-section status.
- **Audio studio** — a local audio editor with focused tools: vocal remover and 4-stem splitter (HTDemucs) with a mute/solo stem mixer, live pitch and tempo changes, a cutter with draggable handles and fades, effects, a joiner with crossfades, a key and BPM finder, and a recorder with karaoke. Every tool shares one track with multi-step undo.
- **Video editor** — a free multi-track timeline for video clips, still images, and audio. A media pool sits left of the preview; project media can be double-clicked or dragged onto the timeline. Right-click a media card to insert it, jump to or select its timeline uses, copy the file name, manage its preview proxy, remove it from the pool, or delete it together with every timeline clip that uses it; browsers do not expose local folder paths, so the file-location item explains that limitation. Dropping files on the editor accepts video, audio, images, and `.srt`/`.vtt` captions; other file types are rejected. Track headers name each video/audio row, mute or hide it, and video rows can be dragged up or down. Drag clips across time and between video rows, trim any edge without moving the clip's opposite edge, split at the playhead (**S**), delete the selected clip, title, or graphic with **Del** (or **Backspace**), and undo every edit (**Ctrl+Z**). Click or drag the ruler to scrub, with a small magnetic snap to clip edges; Ctrl-click clips or drag a selection box over empty track space to select several, then move or delete them together. A clip's **Transform** tab zooms, rotates, and repositions its picture in the frame; the preview and both export engines use the same transform. Numeric fields can be clicked and dragged left or right to scrub their value, with Shift for faster and Alt for finer adjustments. Timeline clips fill their track rows exactly, with a full row of distinct filmstrip thumbnails that resamples as you zoom, ruler-aligned vertical grid lines behind the clips, and a live waveform for each video's own audio. Past deep zoom the editor renders extra frames and a high-resolution signed min/max range waveform for the visible span on demand, so thumbnails and audio transients stay sharp without decoding the whole file again. The full-length strip builds from a small set of unique frames for a fast first view, then the viewport pass fills in exact frames. The ruler adds frame ticks beneath each second once there is room, keeps only the labels around the viewport, and timeline zoom reaches 120×. A small spinner marks an audio clip while its waveform is built and a video clip while its filmstrip is built or refined. Moving or trimming a clip never rescales the timeline; the view auto-scrolls when the pointer reaches either edge. One compact timeline bar holds the edit tools, In/Out marks, track add, fit, zoom, and a master preview volume/mute control. A project bar at the top shows the project name, output resolution, frame rate, and duration; **Save project** stores the timeline and its media in IndexedDB on this device, and **Projects** reopens saved work after a refresh. The clip inspector can be closed to give the media pool and preview more room, and the right-edge rail restores it. A video's own sound is shown as a strip inside its clip; overlapping audio clips auto-stack into rows, with offsets, per-clip volume and mute, draggable fade handles, loop-to-fill, and track choice for multi-track files. Linked sound follows its video live while dragging or trimming; right-click either clip to ungroup them, group them at their current offset, or sync the audio back to the video start. Audio-only timelines can be played and scrubbed before a picture is added. The left library switches between the media pool, title and shape generators, an OpenReel-style effects library with stackable colour and blur presets, transitions, captions, a track mixer with video opacity and audio volume, and the AI editor. It collapses to a slim rail like the inspector, and the active library panel is remembered. The inspector only edits what is on the timeline or selected: Clip, Title, Shape, Keys, and Multi tabs, with the selected clip's fields split into Timing, Transform, Effects, Sound, Actions, and Transcript. Duck music under speech from the sidechain detector or caption timing, add captions from Audio to text or an SRT/VTT file with an offset and a caption lane, preview the real output aspect with safe-area guides, and export at the source size, 1080p/720p/480p, vertical 9:16, square, WebM, or a target file size. Loudness normalization, exact cuts, audio-only export, `.srt` download, voiceover recording, and handoffs to Audio to text, Audio studio, and Text to speech are built in.
- **AI editor** — connect OpenAI, Anthropic, DeepSeek, OpenCode, or a custom OpenAI-compatible endpoint, then edit the timeline by chatting. The model uses 46 local tools to inspect and change tracks, clips, trims, transforms, effects, titles, graphics, captions, keyframes, multicam cuts, and export settings. Edits can require confirmation or auto-approve, and the API key stays in memory for the tab and clears on reload.
- **Fast path with a compatibility fallback** — Mediabunny/WebCodecs handles common containers, decoding, simple trims, MP3/FLAC/M4A/AAC/Opus/WebM exports, Quick Tools video re-encodes, frame and AAC extraction, audio-only export, and Audio Studio previews without the 32 MB FFmpeg core. Every tool still falls back to bundled FFmpeg for AIFF, CAF, Ogg Vorbis, denoise, loudness, limiting, pitch/tempo, joins/stems, and legacy inputs (WMA, AMR, AC-3, DTS, APE, WavPack, AVI, WMV, MPEG-TS, …).
- **Documents & privacy** — OCR and black-box redaction for images and multi-page PDFs, plus a batch toolkit that strips image/media/PDF metadata, computes SHA-256 checksums, renames files, and packages clean copies in a ZIP.
- **Screen recorder** — capture a screen, tab, or camera with microphone and system audio, pause/resume, download the recording, open it in the video editor, or transcribe it.
- **Lazy route loading** - only the selected language pack and the current tool's code start with the app. Audio Studio, Video Editor, Quick Tools, Documents & privacy, Screen recorder, speaker diarization, the model chart, and the MP3 encoder are fetched on first use, keeping the initial script around 124 KB gzip.
- **Background jobs** - separation, exports, and transcription keep running while you switch tools. A tray shows progress, the sidebar marks the busy tool and shows a dot when a video project, audio session, transcript, image, or recording is still open in another tab, the tab title shows the percentage, and a browser notification fires when a job finishes while you are elsewhere.
- **Drop anywhere** — drop files on any page (or open them with the installed app) and choose a tool from the menu. Press **?** for keyboard shortcuts.
- **Local voice cloning** — Reverb-TTS builds a reusable voice from a 3–20 second reference clip and its transcript. The clip is decoded locally and never uploaded. Reverb is non-commercial (CC BY-NC 4.0).
- **A WebGPU / WASM device toggle** — switch the inference backend from the session strip or Settings, with the WebGPU option disabled when no adapter is available.
- **Programmatic SEO pages** — 20 static use-case and language pages plus 144 localized Quick Tools pages and 9 hub pages, each with unique copy, canonicals, Open Graph/Twitter images, structured data, breadcrumbs, and internal links. The build also emits a multilingual `sitemap.xml` and `robots.txt`.

## Working in the app

### Recording and dictation

**Record from microphone** asks for permission, shows a live level meter and timer, and turns the
recording into the same `File` the upload path uses. The clip is decoded by the Web Audio API and
never uploaded. Stopping a recording starts transcription automatically. `Esc` cancels a recording.
Microphone access requires HTTPS or `localhost`.

**Clean up dictated punctuation and numbers** is opt-in. It is applied to the final transcript:
“comma”, “full stop”, “question mark”, and number words become punctuation and digits. The parser
deliberately leaves ambiguous sequences alone (for example “ten thirty” is not turned into 40).

### Presets, model fit, and the session strip

The preset row chooses a model for a job: voice note (Moonshine Tiny), English dictation (Fluid
Speech Mini), multilingual (Parakeet Ultra), meeting (Qwen3-ASR), best English accuracy (Phonon-2),
translation (Granite Speech, WebGPU only), and long-tail languages (Omnilingual). Every preset is
just a model, language, and clean-mode selection; it can be changed afterwards.

The session strip above the input shows the selected model, variant, estimated fit for this device,
cache state, and backend. Model cards carry a **Best for** label and a **Runs here** / **WebGPU
required** / **Heavy on mobile** label. A model that cannot run is still inspectable, but the app
explains why before a download starts.


### Text to speech and voice cloning

The TTS tab has six engines. **tiny-voca** is bundled and starts immediately. **Kokoro-82M** runs through kokoro-js on WASM or WebGPU. **Underdog Woof** is a 41 MB NumPy model with no ONNX graph; a typed-array port runs in a worker, and the weights are cached with the Cache API. **Reverb-TTS** is a 297M zero-shot cloner that runs on WebGPU through Software Mansion's `runntime` runtime. **Phonon 31M** (Gradium, Apache 2.0, ~65 MB) streams English speech while it generates, from a WebAssembly build in its own worker. **Supertonic 3** (Supertone, ~398 MB) speaks 31 languages with 10 preset voices and plays each sentence as soon as it is ready; its weights use OpenRAIL-M, which forbids some uses such as impersonation without consent. New engines plug in through one `TtsPlugin` interface in `src/tts-plugins.ts`.

For Reverb, choose a clean 3–20 second clip of one speaker, type exactly what the clip says, and press **Build voice**. The reference is decoded locally, encoded into codec frames on the GPU, and reused for any text in the selected language. The first load downloads the int4 model and codec and caches them in OPFS.

Woof and Reverb are **non-commercial** models. Woof requires the credit "Voice by Underdog Woof" and Reverb requires "Reverb-TTS by Software Mansion". See `NOTICE` for the full license text and links.

### Audio studio

Open or drop a file in **Audio studio**, then pick a tool from the tab bar:

- **Vocal remover** separates vocals and music, or splits into vocals, drums, bass, and other. Each stem has volume, mute, solo, and its own download; **Download mix** renders whatever you hear.
- **Pitch & tempo** previews key and speed changes live while playing (an AudioWorklet pitch shifter plus pitch-preserving playback), then renders them at full quality with FFmpeg. Detected key and BPM update to show the result.
- **Cutter** keeps or deletes a selection with optional fade in and fade out. Drag across the waveform, drag the handles, Shift-drag to move the selection, and Ctrl + scroll to zoom.
- **Vocal remover** also offers a 6-stem model (adds guitar and piano) and High/Best quality, which average two or three shifted passes. **All stems (ZIP)** saves every stem at once.
- **Effects** plays rumble removal, voice clarity, reverb, mono, volume, and EQ live; **Render a 10 s preview** lets you hear noise reduction, loudness, and the limiter before applying.
- **Lyrics** transcribes the words with the model chosen in Audio to text (cleanest after separating the vocals), shows them on the waveform, highlights the current line, saves .lrc or .srt, and drives the karaoke lyrics display.
- **Batch** converts, normalizes, trims silence, applies the current effects or pitch, or separates vocals for many files and downloads them as one ZIP.
- **Joiner**, **Key & BPM**, and **Recorder & karaoke** cover crossfaded joins, tap tempo, and singing over the current track.
- Press **M** to drop markers while listening, **[ ]** to jump between them, and **R** or double-click to select the part between two markers. After each result, suggested next steps appear under the status line.

Each applied change becomes a new version: Ctrl+Z and Ctrl+Shift+Z step through them, and **Revert to original** is itself undoable. Downloads include unapplied pitch and effect settings, so the file matches what you hear. Long jobs show a progress bar with time left; the separation model shows download size, speed, and time left on first use, and the FFmpeg fallback shows its size only when an effect or format actually needs it.

The Mediabunny fast path decodes common formats without the FFmpeg core. Simple cuts, gain, fades, mono, reverse, 10 s previews, recording decode, and batch silence trimming also stay in the browser/PCM path. FFmpeg runs locally for the effects that need a full DSP graph and for fallback formats, preserving the sample rate and channels while editing. When the page is cross-origin isolated it uses the multithreaded FFmpeg build (thread counts are capped to avoid the fixed thread-pool deadlock); if a job crashes or reports nothing for 30 seconds, it restarts single-threaded and retries automatically.

### GPU preview

**Project settings → Playback → GPU preview (beta)** switches the stage to a WebGL2 compositor. It draws the transformed source, brightness/contrast/saturation/hue, a separable Gaussian blur, chroma key, the tone table, 3D LUTs, rectangle and ellipse masks with feathering, motion transitions, opacity, and the clip's blend mode. The same preview-frame plan (`src/video-preview-plan.ts`) also drives an optional WebGPU backend; add `?compositor=webgpu` to try it. If the adapter, device, shader, or context is unavailable, the editor falls back to WebGL2 and then to the existing CSS preview. Export still uses the WebCodecs/Canvas2D path and is unchanged.

Paused frames are kept in a bounded 48 MB / 24-frame LRU keyed by the frame-plan signature (`src/video-render-cache.ts`). Any edit that changes the plan produces a new signature, so stale frames are never shown. The `scripts/preview-parity.html` and `scripts/gpu-parity.html` harnesses compare the compositor against the export renderer; all 47 fixtures (aspect ratios, alpha stills, filters, blur, chroma colours, tone/LUTs, masks, transitions, blend modes, and video) are within a mean channel error of 1.62 and p95 of 4, with antialiasing-only outliers at transformed and masked edges. At 1280×720 on an RTX 3060 Ti, the WebGL path measured p95 frame times of 0.5 ms for colour, 1.3 ms with blur, and 3.7 ms with the full effect stack; the Canvas2D export reference measured 47 ms, 14 ms, and 146 ms for the same frames. At 1920×1080 the WebGL p95 was 2.1 ms, 6.2 ms, and 4.1 ms. The WebGPU backend matched the WebGL output within a mean of 0.11 in these fixtures, but its p95 was 4.0–4.8 ms at 720p and 4.4–12.4 ms at 1080p. WebGPU is the preferred backend when GPU preview is enabled because its CSS colour parity is inside the gate; WebGL remains the compatibility fallback. The adapter probe records one NVIDIA Ampere device for both power preferences, no software fallback, so an integrated-GPU profile was unavailable on this machine.

A visible-tab screenshot and pacing harness (`scripts/css-parity.html` and `scripts/preview-benchmark.html`) compares the actual CSS preview with WebGL and WebGPU. Goldens are in `benchmarks/golden/`. WebGPU CSS parity is mean ≤1.50 and p95 ≤4 across the matrix; WebGL is close but wider (worst mean 2.02, p95 6), including feathered masks after the CSS preview moved to an SVG Gaussian alpha mask. At 167 Hz the simple and effect-heavy previews are refresh-locked at 6.2 ms p95 for CSS, WebGL, and WebGPU; a renderer trace shows CSS paint+raster at about 0.13 ms/frame and WebGL render at 0.4 ms p95, so the plan’s 20% heavy-preview p95 gain has no headroom. The replacement gates in `benchmarks/ACCEPTANCE.md` were explicitly approved by the owner: WebGPU CSS parity, no CSS regression for CSS-expressible effects, <16.7 ms p95 for pixel effects CSS cannot render, and CSS fallback above 1080p. At 4K the CSS compositor is faster than the multi-pass GPU preview (6.2 ms vs 23.5/34.5 ms p95), so the editor falls back to CSS above a 1080p backing-store budget. The same deterministic 3840×2160 video at a 1280×720 preview measures CSS frame p95 at 6.2 ms with 0.049–0.051 ms Paint p95, WebGL frame p95 at 6.2 ms with 8.99–9.32 ms WebGL GPU timer p95, and WebGPU frame p95 at 6.2 ms with 0.5 ms render-call p95. All three backends use the same source and preview size. After downscaling 4K uploads to 720p and deduplicating visual renders, no backend drops a 60 fps frame. `renderPreviewToTarget()` in `src/video-preview-capture.ts` adds an offscreen bitmap path for stills and future cache fills; both backends match the live render pixel-for-pixel.

### MKV, embedded audio, and subtitles

Drop the MKV into the Video editor. When the browser cannot display its
picture, the editor prepares a playable preview locally. It first tries to
remux the original video and can build a smaller H.264 preview through
FFmpeg when needed. Export reads the original file.

Select the linked audio clip and choose **Audio → Audio track** to change
which embedded stream you hear and export. Moving that clip to another
timeline lane preserves the stream selection. Standard export combines the
timeline audio into one soundtrack.

Select a video clip and open **File → Embedded subtitles**. MKV and WebM
tracks are listed automatically when the editor can read their headers.
If the picker shows **Find embedded subtitles**, click it to run the fallback
scan. Select a stream and click **Import subtitle track**.
Click a caption block on the timeline to edit its text. Imported captions
follow the clip through moves, trims, splits, and speed changes. SRT and
WebVTT import as text. For ASS and SSA, enable **Keep original ASS styling**
to use the script’s styles and attached Matroska fonts in preview and
burned-in exports. Leave it off to import plain text. Soft subtitle export
uses text cues. Image-based tracks such as PGS and VobSub are outside the
editable caption workflow.

### Video export

Export uses the browser's encoders through Mediabunny first. A plain join of matching clips can copy both video and audio packets without FFmpeg or a re-encode; when clips differ it decodes and encodes H.264 (MP4/MOV/MKV) or VP9 (WebM), usually in hardware. The soundtrack is only sent through FFmpeg when it actually needs mixing, ducking, fades, or normalization; WebM uses Vorbis because the bundled core's libopus is unstable. Where the browser supports it, export asks where to save and streams the file to disk, so large files never sit in memory. Containers WebCodecs cannot read (AVI, WMV, FLV) fall back to an FFmpeg-only export; burned-in captions need the WebCodecs path. MP4/MKV keep soft captions, MOV cannot. Audio-only export copies AAC packets for a plain timeline and only renders a new mix when the project needs one. Export supports WAV, MP3, FLAC, M4A, AAC, Ogg Vorbis, Opus, WebM, AIFF, and CAF. **Use as TTS reference** sends the edited WAV to Reverb's reference-clip input. Add the spoken transcript there to build a voice.

### Transcript editing, keyframes, effects, and proxies

The **Transcript editing** section turns the current Audio to text result into an editing surface. Choose it from the tool rail, the command search, or the Video inspector; the inspector opens and scrolls straight to it. Click any word to delete it and close the gap across every video and audio track; **Remove silences** finds pauses longer than the threshold and cuts them in one pass. With no transcript loaded, the section explains the workflow and offers a button that opens the selected clip in Audio to text. Every edit is a normal undo step, captions follow the cuts, and the timeline stays in place.

**Transform** now supports keyframes. Drag the picture in the preview to move it, drag a corner to resize, and drag the round handle to rotate; double-click resets the pose. Each transform property, opacity, volume, and the colour controls have a diamond that adds or removes a keyframe at the playhead, with linear, ease-in, ease-out, ease-in-out, or hold timing.

**Effects** adds brightness, contrast, saturation, hue, blur, opacity, blend modes, rectangular or elliptical masks with feathering, chroma key, a three-slider tone curve, 3D `.cube` LUTs, and per-clip speed from 0.25× to 4×. Colour, blur, opacity, blend, and mask preview live; chroma key, tone curve, and LUT are applied during export, where per-pixel work does not stall playback.

For 1440p and 4K sources, **Create preview proxy** builds a 540p or 720p H.264 copy in the local FFmpeg worker and switches the stage to it while export still reads the original file. Proxies are saved with the project.

The project menu can **Export .zip** and **Import .zip**: the archive contains `project.json`, every media file, and any proxies, so a project survives clearing site data or moving to another browser profile. **Relink media…** matches replacement files by name when a source disappears.

Export lives in the top-right split button. The menu holds MP4 Standard (best match), 4K, 1080p High Quality, 720p Compact, Vertical 9:16, and Audio Only (WAV); **Custom export…** opens a dialog with platform presets (YouTube, TikTok/Reels, Instagram square, Twitter/X), container, resolution, quality, target size, loudness, exact cuts, and **Entire timeline / Marked In–Out**. Press **I** and **O** on the timeline to mark a range. The language picker now sits in the sidebar.

On desktop, the editor is a locked workspace rather than a scrolling page: the timeline is docked at the bottom, the library and inspector scroll independently, and the dividers resize the library width, inspector width, and timeline height with the mouse (double-click a divider to reset it). The library can widen to 620px; the media pool switches to a multi-column card grid as it grows. The library and inspector both collapse to slim edge rails.

The inspector follows the timeline selection with four tabs. **Video** holds the selected type's controls: timing and transform for video and images, the full text editor for titles and subtitles, and shape geometry for graphics. **Audio** is enabled for audio clips and for videos with their own sound. **Effects** is enabled for video and image clips. **File** shows the source file's codecs, resolution, frame rate, channels, size, and raw probe metadata. Tabs that do not apply are disabled; selecting a title or shape leaves Video as the only active tab. Keyframes, transcript editing, and multi-camera cuts live as collapsible sections inside Video.

The Graphics library adds pattern panels, gradient panels, SVG import, and a colour emoji grid. Patterns and gradients are real fills, not flat images: any rectangle or ellipse can switch between solid, linear-gradient, and radial-gradient fills, then layer stripes, diagonal lines, dots, a grid, a checkerboard, or crosshatch over the colour. Imported SVG overlays keep their own colours and scale cleanly, and emoji overlays use the system colour emoji font. All of them are normal video-track clips that can be moved, trimmed, resized, rotated, transitioned, and exported.

When a shot needs 3D, tracking, particles, rotoscoping, or node graphs, the Effects panel and the empty inspector link to three local-first studios: [wide.video](https://wide.video), [Pikimov](https://pikimov.com), and [OpenReel](https://openreel.video). They run on your machine too, so handing off a shot does not mean uploading it.

### Project settings

The project bar stays on one compact row: editing mode, the project name and save state, command search, saved projects, save, and export. The gear opens **Project Settings** with a DaVinci-style sidebar for **Master Settings**, **Audio**, **Subtitles and Transcript**, and **Playback**. Master Settings changes the project name and timeline resolution, including a custom width and height, and shows the derived frame rate, canvas, duration, and clip counts. Custom sizes drive the preview canvas and the export encoder at that exact resolution. Audio sets loudness normalization, the video's own sound level, and ducking. Subtitles sets the caption source, style, position, and size. Playback sets preview quality and zoom. **Save** applies every changed section at once; **Cancel** leaves the project untouched. Project settings travel with the IndexedDB project, so reopening a project restores its canvas, mix, caption, and preview defaults.

### Timeline menus

Transition cards in the library animate a miniature preview of each effect. **Fade in**, **fade out**, and **dip to black** work on video, audio, titles, subtitles, and shapes. **Push**, **slide**, **barn door**, and **split** are motion entrances for video clips: they animate the clip's start from the right, from the bottom, or open it horizontally or vertically from the centre. Click a card to apply it to the current selection, or drag it directly onto a video clip, audio clip, title, subtitle, or shape. Dropping selects the object and applies the transition in place. Right-click a clip for **Copy**, **Cut**, **Paste**, **Duplicate**, **Split**, **Delete**, and **Ripple Delete**. Right-click empty timeline space for paste, titles, shapes, and In/Out marks. Right-click a track header for add, delete, move, lock, empty-track cleanup, and track color. Track color tints the header and its clips. Drag the top or bottom edge of a track header to resize that track; the compact/large track command resets the heights. Titles and shapes are ordinary blocks on the video tracks, not separate overlay lanes: drag one sideways to retime it, up or down to move it between video tracks, or use its edge handles to trim. The Title and Shape inspectors also have track selectors. Title presets and shape cards can be dragged from the library directly onto the timeline at the drop position; dropping one over a video row places it on that track. Both support copy, cut, paste, duplicate, delete, transitions, track colours, hiding, locking, and track reordering like other clips. The empty-stage prompt disappears as soon as the timeline contains a clip, audio, title, or shape. Titles and shapes can be dragged in the preview; shapes resize from any edge or corner; both rotate with snapping near 0, 90, 180, and 270 degrees. Menus measure themselves and stay inside the viewport, so options near the bottom of a tall track stack remain reachable.

### Text objects

Titles and subtitle cues are editable text objects, not fixed caption presets. Titles sit on video tracks and can be moved between them like clips; subtitles stay in the caption lane. Select either and use the inspector's Text tab to change the font, size, weight, italic and uppercase modes, colour, alignment, X/Y position, maximum width, line height, outline width and colour, shadow blur/offset/colour, background colour and opacity, padding, and corner radius. The font field opens a searchable preview picker with 78 built-in families across sans, serif, display, handwriting, and mono styles. Every row previews the current title text in its own face. In Chromium browsers, **Load installed fonts** adds every family installed on the device after a local permission prompt; the names and previews never leave the machine. Title styles are stored on the title itself and can be undone; subtitle overrides are saved with the project. The preview renders every active text object, and burned-in exports use the same per-object styling. Soft subtitle tracks keep the cue text only. An empty timeline, or one containing only titles and shapes, can still be scrubbed across the full visible range; playback runs to the last overlay even without a video clip.

### AI editor

The **AI editor** in the library connects the editor to a model you choose. **Settings** takes a provider (OpenAI, Anthropic, DeepSeek, OpenCode, or a custom OpenAI-compatible endpoint), a model ID, a base URL, and a session API key. Provider and model settings persist; the key lives only in memory for the current tab and is gone after a reload. Requests go straight from the browser to that provider, and nothing else leaves the machine.

OpenAI, Anthropic, and DeepSeek accept browser requests directly. OpenCode Console may block them with CORS, so you can point its base URL at a proxy that allows your origin. The model edits through 46 local tools rather than free-text commands. It can read the full timeline state and media pool, then add media, create and reorder tracks, select, copy, cut, paste, split, trim, move, duplicate, ripple-delete, and relink clips, change transforms, effects (including masks, chroma key, and tone curves), volume, transitions, keyframes, and multicam cuts, add or edit titles and graphics, set captions, loudness, and export options, mark an In/Out range, rename the project, and undo or redo. A short agent loop feeds each tool result back to the model, and read-only inspection tools run without waiting for approval.

**Preview edits only** shows the proposed tool calls in the panel with **Apply edits** and **Cancel**; **Auto-approve** runs them immediately. Turning preview off leaves confirmation on unless auto-approve is also checked. The panel keeps a chat log with per-tool results and can be cleared without touching the project.

### Vision studio

Vision studio uses BiRefNet-lite 512 (MIT, FP16 by default on WebGPU) for background removal; it gives much cleaner edges on hair and fur. BRIA RMBG 1.4 (non-commercial weights) and MODNet (Apache 2.0, portraits) remain available. Object detection defaults to D-FINE Nano (4.5 MB at Q8, 42.8 COCO AP), with YOLOS Tiny and DETR as alternatives. **Click to select** uses SAM 3 tracker (4-bit, about 300 MB): click an object to cut it out, Shift-click or right-click to remove an area; the image is encoded once, so each extra click takes under a second. Its weights use Meta's SAM License. **Read text** runs PP-OCRv6 tiny (6.2 MB, Apache 2.0) for rotated and multi-line text, with copy and read-aloud buttons. **Describe scene** runs Cactus Compute's 22 MB Mirage on a 1.3 MB WebAssembly engine and returns objects with boxes and attributes, relations, readable text, and a summary as JSON; it is fast but can confuse similar animals. Other tasks include depth estimation, segmentation, ImageNet classification, and captioning. Use **Load model** to prepare the selected variant before adding an image. Results can be downloaded as PNG or read as labels and scores.

In **Settings → Benchmark this device**, compare the selected speech model against a written reference for the bundled JFK clip. The report shows word error rate, model load time including any required downloads, and median inference time over three warm runs. The optional WebGPU.Studio WASM preset runs its Whisper Tiny English model and FP32 encoder/Q8 decoder locally on the same audio. This is a one-clip comparison and does not measure hardware WebGPU, live dictation, or general accuracy.

Every model is lazy-loaded and cached by the browser after the first run. Images are decoded in the tab and never sent anywhere.

### Quick tools

Open **Quick tools** in the sidebar or link directly to `#/tools?tool=video-converter`.
The workspace includes video conversion, compression, precise trimming, audio and frame extraction,
rotation and mirroring, speed, reverse, GIFs, watermarks, image resizing and conversion, drawing grids,
manual background cleanup, and image and video collages. From Vision Studio, **Refine mask** opens
an AI cutout in the erase/restore editor with the original image available behind the mask.

The tool picker and settings are available in nine languages from the top-right language menu, with public pages under
`/tools/<language>/<tool>/`. Files are processed locally. A browser that cannot preview a particular
container can still export it when the local codec supports it. [Verification and compatibility notes](docs/quick-tools-verification.md)

### Documents & privacy

**Metadata viewer** is the default tab. Drop any file to see a page preview, filesystem details, detected type and magic bytes, **MD5 / SHA-1 / SHA-256 / SHA-512 / CRC32 / Adler32** checksums, head bytes and ASCII preview, EXIF camera settings, GPS, XMP, IPTC, ICC, PNG headers, PDF Info and XMP streams, fingerprints, linearization/form/signature flags, PDF version and page count, ExifTool-style tags, and audio/video stream details. The **Viewer**, **ExifTool**, **JSON**, and **file(1)** tabs expose the same data at different levels of detail; embedded EXIF thumbnails can be recovered. The page links to [exif.tools](https://exif.tools/) for comparison, but all parsing and checksumming happens locally. Image tools add optimize, invert, flip, rotate, strip, resize/convert, remove-background, and thumbnail recovery; PDF tools add page viewing, flatten/repair, page-image extraction, link extraction, and password unlock/lock (AES-256); DOCX files get a plain-text Word viewer.

**OCR & redaction** renders images and PDF pages locally, detects text with the same PP-OCR model used by Vision studio, and turns every detected line into a checkbox. **Select PII** looks for emails, phone numbers, card/account numbers, and labelled identifiers. You can also drag custom redaction boxes over the page. The redacted output is a new PNG or a new PDF built from the redacted page images, so the original text layer and metadata are gone. The extracted OCR text can be copied or downloaded as TXT.

**Metadata & privacy** accepts a batch of images, audio, video, and PDFs. It strips image metadata through canvas re-encoding, media metadata through a local FFmpeg stream copy with `-map_metadata -1`, and PDF metadata through pdf-lib. It can compute SHA-256 checksums, rename outputs from a `{name}` / `{index}` pattern, and download the results as a ZIP with a checksums file. Files never leave the tab.

The exif.tools gene-symbol Excel suite (Gene Excel Updater, Escape Excel, Gene Updater) is a separate bioinformatics application for XLSX/ODS package repair and HGNC symbol migration. It is not reimplemented here; the Documents view links to it alongside the other external exif.tools resources. PDF.CAB also remains an external link.

### Screen recorder

Choose **Screen or tab**, **Screen + webcam**, or **Camera**; a capture resolution from **480p to 4K** or the source size; a frame rate from **15 to 60 fps**; a video bitrate from **2.5 to 35 Mbps** or a resolution- and frame-rate-based **Auto**; and **MP4 (H.264)**, **MP4 (H.265/HEVC)**, or **WebM (VP9)** output when the browser supports them. Resolution, frame rate, and bitrate are targets passed to the browser, so a screen share or camera may choose a lower size or rate; the compositor never upscales beyond the source. Audio is fixed at 128 kbps. Options that do not apply are hidden: webcam placement only appears for screen + webcam, and system audio only appears for screen capture. Microphone and system-audio toggles and an optional three-second countdown round out the controls. In screen + webcam mode, choose any of nine overlay positions, a small/medium/large size, and mirroring; the screen and webcam are composited on a local canvas while recording. Recording uses `MediaRecorder`; system and microphone audio are mixed locally through Web Audio. While sharing a screen, the live self-preview is replaced by a mirror guard and the recorder's own tab is excluded from the tab picker, so the capture cannot recurse into itself; a **Show preview** toggle brings the live preview back when you want it. The finished file can be downloaded, opened in the video editor, or sent to Audio to text. Screen/system-audio support depends on the browser and platform.

### Exports, history, and the queue

The transcript can be downloaded as TXT, SRT, VTT, Markdown, JSON, or CSV. SRT, VTT, JSON, and CSV
include segment times. JSON and Markdown also include model and recording details.

**History on this device** is off by default. When enabled, finished transcripts are stored in
IndexedDB (text and segment timings only; audio is never persisted). Turning the switch off deletes
the database. History entries can be reopened, deleted individually, or cleared together.

**The batch queue** lives in **Audio to text**, below the recorder. It accepts multiple audio or
video files and processes them one at a time using the model, language, backend, and clean mode
shown in its settings row; **Change settings** jumps to the model controls above. Completed rows
offer a TXT download. Failed and cancelled rows can be retried, and pausing leaves the remaining
files queued. Turn on history to keep completed transcripts after closing the app.

Speech recognition runs in a dedicated worker. Imports of 16 kHz mono, 16-bit PCM WAV files at
least two minutes long read audio in bounded blocks and retain waveform peaks for seeking.
Other inputs use the browser’s Web Audio decoder, which loads the full decoded audio into memory.

### Offline and the privacy receipt

The production build registers a same-origin service worker. It adds COOP/COEP on hosts that
cannot send those headers, caches the app shell and the runtime assets actually used, and serves the
cached shell when the network is unavailable. A model that has been downloaded once can be used
offline. The browser may still evict cached weights under storage pressure; the storage panel shows
whether storage is persistent.

**Advanced → Privacy receipt** records the destination, method, and response size of every request
made while a transcription runs. Model weights appear under `huggingface.co`; other hosts are
labelled as site requests. Failed requests (for example metadata checks while offline) are counted
separately and never reported as received bytes. Audio and transcript text are not part of the
report. The receipt needs the service worker, so it is available in a production build, not the Vite
dev server.

### Benchmark and shareable state

**Test this device** loads the sample clip and measures model load plus decode time for WebGPU (when
available) and CPU/WASM, then reports the faster backend. It disposes the benchmark sessions when it
finishes; the next transcription reloads the model from cache.

The URL mirrors the selected model, variant, language, clean mode, CPU mode, and tab. For example
`?model=qwen3-asr-0.6b&lang=French&tab=tts` restores that state. `?sample=1` opens with the sample
clip loaded.

### Not in this build

- **Models split into sub-2 GB shards** are not available. Fluid Speech Pro Full is a single
  2.59 GB file, so it remains blocked with an explanation instead of failing mid-load.
- **Phrase boosting / custom vocabulary** is planned but not wired into the decode loops yet.

## Suite pages and routing

The app is a static shell with hash routes:

| Route | Page |
| --- | --- |
| `/` | Home: featured tools and a short list of everything else |
| `#/transcribe` | Audio to text: input, session strip, transcript, presets, and the batch queue |
| `#/tts` | Text to speech: voice gallery, generation, exports |
| `#/audio` | Audio studio: vocal remover, pitch and tempo, cutter, effects, joiner, key and BPM, recorder |
| `#/video` | Video editor: local projects, free multi-track timeline, filmstrip thumbnails, media pool, split, undo, stacked audio, collapsible inspector, captions, and export |
| `#/documents` | OCR and redaction for images/PDFs, plus batch metadata stripping, SHA-256 checksums, renaming, and ZIP packaging |
| `#/record` | Screen/tab/camera recorder with microphone and system audio, pause/resume, editor handoff, and transcription |
| `#/queue` | Legacy alias that opens the queue inside Audio to text |
| `#/models` | Model shelf, variants, downloads, comparison, research |
| `#/history` | Opt-in local transcripts, stored in IndexedDB |
| `#/settings` | Device, storage, benchmark, force CPU/WASM, privacy receipt |

The sidebar is fixed on desktop and becomes an off-canvas drawer with a top bar on mobile. The
page header, active navigation item, and document URL update together. Model, variant, language,
clean mode, CPU mode, and tab remain shareable through the query string.

## Programmatic pages and SEO

The production build generates 20 static pages from [`seo/pages.ts`](seo/pages.ts) through the Vite
plugin in [`scripts/seo-plugin.ts`](scripts/seo-plugin.ts):

- Use cases: `/audio-to-text/`, `/dictation/`, `/meetings/`, `/subtitles/`,
  `/podcast-transcription/`, `/interview-transcription/`, `/lecture-transcription/`,
  `/voice-notes/`, `/call-recordings/`, `/private-transcription/`
- Languages: `/languages/spanish/`, `/french/`, `/german/`, `/portuguese/`, `/japanese/`,
  `/chinese/`, `/hindi/`, `/arabic/`

Each page has its own title, description, intro, bullets, FAQ, model table, related links,
canonical URL, Open Graph/Twitter tags, and JSON-LD (`SoftwareApplication`, `FAQPage`,
`BreadcrumbList`). The calls to action link back to the app with a preset or an explicit
model/language query, and the app lands on the transcriber with that state applied.

The same build writes `sitemap.xml` and `robots.txt`, injects the canonical/Open Graph tags into
the app's `index.html`, and generates 144 localized Quick Tools pages plus 9 locale hubs. The
sitemap includes `hreflang` alternates for those tool pages, and every page gets a shared
1200×630 social image. `public/_headers` adds immutable caching for hashed assets and COOP/COEP
on hosts that honor static header files (GitHub Pages ignores it). Set the deployment origin
before building:

```bash
SITE_URL=https://your-domain.example npm run build
```

On GitHub Pages with a project path, include the path:

```bash
SITE_URL=https://<user>.github.io/<repo> npm run build
```

The default is `https://localscribe.app`. If you deploy elsewhere without setting `SITE_URL`, the
canonical URLs and sitemap will point at the wrong origin. The Vite dev server does not serve the
generated pages; run `npm run build && npm run preview` to inspect them locally.

## Supported models

| Model | Download | Languages | Reported accuracy | Pipeline |
| --- | --- | --- | --- | --- |
| **Fluid Speech Mini** *(default)* | **~300 MB** | English | 4.53% average on 8 public English sets (self-reported) | Split frontend → encoder → decoder + joint |
| **Moonshine Tiny** | **~113 MB FP32 / 32 MB Q8** | English | 12.66% average on 8 English sets (Moonshine) | Transformers.js / WASM |
| **Moonshine Base** | **~251 MB FP32 / 67 MB Q8** | English | 10.07% average on 8 English sets (Moonshine) | Transformers.js / WASM |
| **Whisper Tiny / Base / Small Timestamped** | **~154 / 294 / 971 MB FP32** | 99 languages | Use the local benchmark | Transformers.js / WASM, optional Q8, estimated words in JSON |
| **Fluid Speech Pro — Compact** | **~801 MB** | 25 European languages | 6.06 average WER on the Open ASR Leaderboard (model card) | Fused FastConformer-TDT |
| **Fluid Speech Pro — Full** | **~2.67 GB** | 25 European languages | Same model, fp32 weights | Fused FastConformer-TDT · **blocked in Chromium** |
| **Parakeet Redux** | **~263 MB FP32 decoder / 208 MB INT8 decoder** | 25 European languages | 5.69% average on 7 English sets (Moondream) | Fused 2-bit Parakeet TDT |
| **Parakeet Ultra** | **402 MB (4-bit encoder) / 456 MB FP32 decoder / 497 MB WebGPU int4** | 25 European languages | 5.80% on 7 English sets, 9.55% on FLEURS (Redux 6.26% / 11.62%, same harness) | Fused 4-bit Parakeet TDT |
| **Phonon-2** | **~736 MB exact / 688 MB INT8** | English | 5.21% average on 7 English sets (Fermion); int8 export 4.35% on LibriSpeech dev-clean | Fused Phonon TDT + exact preprocessor |
| **Rumble-2-Flash** | **~656 MB** | 45 languages, auto-detected | 6.60 average English WER on 9 sets (Reson8) | Qwen3 conv frontend + encoder + KV-cache decoder |
| **Qwen3-ASR 0.6B** | **~987 MB** | 30 languages + 22 Chinese dialects | 2.11% / 4.55% WER on LibriSpeech clean / other (Qwen) | Qwen3 conv frontend + encoder + KV-cache decoder |
| **Omnilingual ASR 300M** | **~1.30 GB FP32 / 328 MB INT8** | 1,600+ languages | Meta: CER < 10 for 78% of languages | OmniASR CTC · raw waveform |
| **Granite Speech 5.0 2B** | **~1.73 GB** | 6 languages + English translation | 2.43% WER on the 73-utterance LibriSpeech dummy set (4-bit ONNX) | Transformers.js / WebGPU |
| **Whistle** | **~18 MB** (17 MB model + 1.3 MB engine) | English, German, French, Spanish, Italian, Dutch, Polish | Not published on the model card | Cactus WebAssembly engine · word timestamps |

Fluid Speech Mini is the default English dictation model. Vision, Kokoro, Moonshine, Whisper, and Omnilingual default to FP32. Parakeet Redux defaults to the FP32 decoder with its losslessly packed ternary encoder. Phonon-2 defaults to its lossless encoder and FP32 decoder. Choose a compact variant for lower download and memory requirements. Some browser exports have a single precision, and Fluid Speech Pro’s FP32 package exceeds the loader’s single-file limit.

The picker also shows model family, the **exact language names**, release date, license, accuracy notes, and a per-variant size. The comparison table lists every model’s exact languages; Qwen3-ASR also lists its 22 Chinese dialects. A language override appears for Rumble-2-Flash and Qwen3-ASR, with **Auto-detect** as the default.

### Granite Speech requires WebGPU

Granite Speech’s 4-bit `embed_tokens` uses `GatherBlockQuantized`, which ONNX Runtime only implements for WebGPU. On a browser without a WebGPU adapter the app shows a clear error and does **not** download the 1.7 GB of weights. Use a WebGPU-capable desktop Chrome or Edge for Granite; all other models have a CPU/WASM path.

### Text to speech

The **Text to speech** tab has two English models.

**tiny-voca** by Muhammed Nazeem:

| Property | Value |
| --- | --- |
| Parameters | 4.5M |
| Model | 21 MB ONNX, bundled with the site |
| Voices | F2 (female) and M2 (male), American English |
| Output | 24 kHz mono; WAV or a selected export format |
| Language | English |
| License | Apache 2.0 |

**Fast phonemizer (default).** The default path uses dizione's 125k-word IPA lexicon plus [eSpeak NG](https://github.com/espeak-ng/espeak-ng) for unknown words. It needs about 3 MB, no Pyodide, and no NumPy, so the voice starts almost immediately. It is context-free for the small homograph set, so unusual names and noun/verb stress pairs are less reliable.

**Accurate phonemizer.** Selecting *Accurate* uses dizione inside a bundled Pyodide + NumPy worker. That path keeps dizione's context, homograph, number, and text-normalization rules. The first run loads about 25 MB of runtime files plus the 21 MB voice model and 5 MB phonemizer data; later generations start immediately. Typing starts the selected phonemizer in the background.

Both paths run locally; no text or audio is uploaded.

**Kokoro-82M** by hexgrad:

| Property | Value |
| --- | --- |
| Parameters | 82M |
| Model | ~325 MB FP32 or ~88 MB Q8, downloaded from Hugging Face and cached |
| Voices | 28 American and British English voices |
| Output | 24 kHz mono; WAV or a selected export format |
| Language | English (the bundled kokoro-js phonemizer) |
| Compute | CPU FP32 or Q8, WebGPU FP32 |
| License | Apache 2.0 |

Kokoro uses FP32 on CPU/WASM by default and also supports FP32 on WebGPU. Select the smaller Q8 CPU option to reduce the download from about 325 MB to 88 MB. The model and voice files are cached locally after the first generation.

### TTS output formats

The format selector defaults to **MP3 · 128 kbps**. WAV is written directly by the app. MP3 is encoded in the browser with `@breezystack/lamejs`. FLAC, M4A/AAC, WebM/Opus, and Opus/Ogg use Mediabunny with WebCodecs or a lazy extension encoder, so they do **not** load FFmpeg. Ogg Vorbis uses the FFmpeg fallback. The 32 MB FFmpeg core is emitted by Vite and is loaded from the app's origin only when a fallback format or DSP effect is used. Audio and text still never leave the browser.

### Audio Intelligence

Open an audio or video file, join an ordered list of files, or record from your microphone. The editor supports waveform selection, cuts, independent pitch and tempo controls, EQ, fades, reverb, loudness normalization, and ten export formats. Key and BPM estimates use up to the first minute of each selected file. Tap Tempo works without a file.

HTDemucs splits a track into vocals and accompaniment or into four stems. Preview and save stems individually, adjust their gains for a remix, or open the instrumental as backing for karaoke. Karaoke combines the accompaniment and recorded voice with adjustable level, pitch, and timing. HTDemucs defaults to the 316 MB FP32 weights. The optional 166 MB download stores the weights at FP16 and still runs inference in FP32. Either variant can be cached before opening a file. Audio processing takes place in the browser.


The download button uses the selected extension (`tiny-voca.mp3`, `kokoro.flac`, and so on), and the player previews the encoded file rather than a hidden WAV.

### Runtime, download, and threading performance

The app picks the smallest ONNX Runtime build for the job:

| Session | Runtime fetched | Approx. size |
| --- | --- | --- |
| CPU/WASM (`onnxruntime-web/wasm`) | `ort.wasm.bundle.min.mjs` + threaded SIMD WASM | 15 MB |
| WebGPU-enabled (`onnxruntime-web/webgpu`) | WebGPU bundle + asyncify WASM | 29 MB |

The runtime import and the model-file download run concurrently instead of waiting for one to finish.

On a static host without custom headers, `public/coi-serviceworker.js` adds `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` to same-origin responses. That makes the page cross-origin isolated, which unlocks `SharedArrayBuffer` and up to eight ONNX Runtime WASM threads. The first visit reloads once while the worker installs; hosts that already send COOP/COEP skip the worker entirely. If a browser blocks service workers, the app still runs single-threaded.

Measured on this development machine with Fluid Speech Mini and the same 5.5-second clip:

| Path | Time |
| --- | --- |
| Single-threaded WASM | 3.6 s |
| 8-thread WASM | 1.0 s |
| Cached 300 MB model load | 1.3 s |

Model files are downloaded as 32 MB `Range` requests, four at a time, and successful chunks go straight into Cache Storage. A real `Content-Length`/`Content-Range` probe is used because several catalog sizes are rounded, and a warm cache reads chunks four at a time. On the same connection, a cold Fluid Speech Mini model setup fell from 22.0 s to 15.6 s. These numbers depend on the network, CPU, and browser; the direction is consistent, not the exact ratio.

### Researched but not selectable

- **Fluid Speech Pico** — 159 MB announced, not released yet.

### Voice engines and licenses

- **tiny-voca** — 4.5M params, 21 MB ONNX bundled with the site, two English voices, Apache 2.0.
- **Kokoro-82M** — 82M params, ~325 MB FP32 on CPU or WebGPU, ~88 MB Q8 on CPU, Apache 2.0, 28 English voices, 24 kHz output.
- **Underdog Woof** — 38.2M params, 41 MB NumPy weights, two English voices. A typed-array port runs in a worker. Non-commercial under the Underdog Non-Commercial License 1.0; credit "Voice by Underdog Woof".
- **Reverb-TTS** — 297M voice-cloning model, int4 weights plus the Higgs Audio v2 codec, seven languages, WebGPU through runntime. Non-commercial under CC BY-NC 4.0; credit "Reverb-TTS by Software Mansion".
- **Phonon 31M** — Gradium's 31M English model, ~65 MB Q8, streams while it speaks, Apache 2.0, through `phonon-tts` (MIT OR Apache-2.0).
- **Supertonic 3** — Supertone's flow-matching model, ~398 MB FP32, 31 languages, 10 preset voices, 44.1 kHz. OpenRAIL-M: allowed for commercial use, but with use-based restrictions (no impersonation without consent, no deceptive content, and others). Read the license before publishing audio.

The last two are explicitly non-commercial. See [`NOTICE`](NOTICE) for links and full terms.

## Quick start

Requirements: Node.js 20.19+ or 22.12+ (Vite 7), and a modern browser. The lockfile pins the versions that were built and smoke-tested here (Vite 7.3, ONNX Runtime Web 1.31, Transformers.js 4.3.2).

```bash
npm install
npm run dev
```

Open the URL Vite prints. Drop an audio or video file, press **Try the sample clip**, or use the
microphone, then press **Transcribe locally**. The selected model is downloaded on first use; the
first run also loads the runtime WASM.

```bash
npm run build      # type-check + static build into dist/
npm run preview    # serve the production build locally
npm run typecheck  # TypeScript only
```

## Deploy to GitHub Pages

1. Push the repository to GitHub.
2. In **Settings → Pages → Build and deployment**, set **Source** to **GitHub Actions**.
3. Push to `main`. `.github/workflows/deploy.yml` runs `npm ci`, builds the site, and deploys `dist/`.

`vite.config.ts` uses `base: './'`, so the site works at `https://<user>.github.io/<repo>/` without editing the repository name.

The workflow uses `npm ci` and the committed `package-lock.json`. If you add dependencies, run `npm install` locally and commit the updated lockfile.

Set `SITE_URL` in the deploy workflow (or locally) so canonicals and the sitemap use the real origin:

```yaml
- run: npm run build
  env:
    SITE_URL: https://<user>.github.io/<repo>
```

## How it works

```text
File or recording
  │  Web Audio API: decode + downmix + OfflineAudioContext resample to 16 kHz
  ▼
Float32Array · mono
  │  split at the quietest point near the model's chunk length
  ▼
Model-specific frontend
  │
  ├─ Fluid Speech Pro / Parakeet Redux
  │    fused FastConformer encoder → fused TDT decoder_joint
  │
  ├─ Phonon-2
  │    exact Phonon preprocessor → fused TDT encoder / decoder_joint
  │
  ├─ Fluid Speech Mini
  │    NeMo log-mel → conv frontend → encoder → decoder + joint
  │
  ├─ Rumble-2-Flash / Qwen3-ASR 0.6B
  │    Whisper log-mel → conv frontend → masked encoder
  │    → prompt with audio placeholders → KV-cache decoder
  │
  ├─ Moonshine Tiny / Base
  │    Transformers.js feature extractor → encoder → decoder
  │
  ├─ Omnilingual ASR 300M
  │    raw 16 kHz waveform → wav2vec2 CTC encoder → greedy CTC
  │
  └─ Granite Speech 5.0 2B
       Transformers.js processor → WebGPU encoder → projector → LLM decoder
  ▼
Editable text

Text to speech
  text → fast JS lexicon/eSpeak or Pyodide/dizione → phoneme ids/stress
       → tiny-voca ONNX → 24 kHz waveform
       → MP3 (lamejs) or WAV, or Mediabunny/WebCodecs for FLAC/M4A/WebM/Opus
         (Ogg Vorbis falls back to FFmpeg)
```

### Fluid Speech Pro / Parakeet Redux I/O

Both use the `onnx-asr` fused layout:

```text
encoder-model*.onnx
  audio_signal      float32 [1, 128, T]
  length            int64   [1]
  outputs           float32 [1, 1024, T/8]
  encoded_lengths   int64   [1]

decoder_joint-model*.onnx
  encoder_outputs   float32 [1, 1024, 1]
  targets           int32   [1, 1]       previous token (blank first)
  target_length     int32   [1]
  input_states_1    float32 [2, 1, 640]
  input_states_2    float32 [2, 1, 640]
  outputs           float32 [1, 1, 1, 8198]  8193 token + 5 duration logits
  output_states_1   float32 [2, 1, 640]
  output_states_2   float32 [2, 1, 640]
```

### Fluid Speech Mini I/O

```text
frontend.onnx   input_features float32 [1, T, 128], attention_mask int64 [1, T]
             →  hidden_states  float32 [1, T', 1024]
encoder.onnx    hidden_states  float32 [1, T', 1024], length int64 [1]
             →  encoder_out    float32 [1, T', 1024]
decoder.onnx    token int64 [1, 1], h_in/c_in float32 [2, 1, 640]
             →  decoder_out float32 [1, 640], h_out/c_out float32 [2, 1, 640]
joint.onnx      encoder_frame float32 [1, 1024], decoder_out float32 [1, 640]
             →  logits float32 [1, 8198]
```

Fluid Speech Mini’s tokenizer is a `tokenizer.json` (BPE, 8193 entries, `<blank>` at id 8192), not a `vocab.txt`.

### Qwen3-ASR I/O

Rumble-2-Flash and Qwen3-ASR 0.6B use the sherpa-onnx Qwen3 export:

```text
conv_frontend.onnx
  input_features          float32 [1, frames, 128]     Whisper log-mel
  conv_output             float32 [1, tokens, 896]

encoder.int8.onnx
  input_features          float32 [1, tokens, 896]
  feature_attention_mask  bool    [1, tokens]
  audio_features          float32 [1, tokens, 1024]

decoder.int8.onnx
  input_ids               int64   [1, seq]
  audio_features          float32 [1, tokens, 1024]
  attention_mask          int64   [1, seq]
  cache_position          int64   [seq]
  cache_key_i/value_i     float32 [1, max_total_len, 8, 128] × 14 or 28 layers
  logits                  float32 [1, seq, vocab]
  key_delta_i/value_delta_i float32 [1, seq, 8, 128]
```

The decoder emits KV **deltas**, which are copied into preallocated caches. The cache tensors must be passed at their full `max_total_len`; the export rejects shorter slices even though the dimension is symbolic. The int8 decoder stays on WASM because its dynamic-quantized matmuls and KV cache are not a good fit for WebGPU.

Whisper log-mel is implemented in [`src/whisper-mel.ts`](src/whisper-mel.ts): 25 ms Hann window, 10 ms hop, 400-point FFT, 128 Slaney mel bins, `log10`, clamp, and `(x + 4) / 4`. The frame offset is Kaldi’s `t * 160 - 120`, not OpenAI Whisper’s `t * 160 - 200`.

### Granite Speech I/O

Granite is loaded through Transformers.js:

```js
AutoProcessor.from_pretrained(repo);
GraniteSpeechForConditionalGeneration.from_pretrained(repo, {
  dtype: { audio_encoder: 'q4', embed_tokens: 'q4f16', decoder_model_merged: 'q4f16' },
  device: 'webgpu',
});
```

The prompt is `<|audio|>transcribe the speech with proper punctuation and capitalization.` The model files and runtime use the `transformers-cache` Cache Storage bucket. The app configures Transformers.js to load ONNX Runtime WASM from the site itself, not a CDN.

### Tensor-name adaptation

- Fused exports: adjust `TENSOR_ALIASES` in [`src/model.ts`](src/model.ts).
- Fluid Speech Mini: adjust `resolveMiniNames()` in the same file.
- Qwen3: adjust `resolveQwenNames()` and the prompt in `transcribeQwen()`.
- The TDT decoder loops use the actual TDT rule: emit a non-blank token, advance the prediction state, and advance the encoder frame by the predicted duration. If duration is 0 and the token is blank, advance one frame; if duration is 0 and the token is non-blank, stay on the frame up to 10 symbols.
- Qwen3’s auto-detect output starts with `language <Name>.`; the app strips only that leading scaffold.

## Download and caching behavior

- TDT and Qwen3 model files are downloaded with HTTP **Range** requests in 32 MB chunks and written to the Cache API (`fluid-speech-pro-cache`).
- Chunks are streamed, so the download card can show **% complete, bytes transferred, current MB/s, and an estimated time remaining** while a chunk is still arriving.
- Cached bytes are excluded from the throughput estimate, so a resumed download does not report a fake speed.
- A small completion manifest is written after the file size is verified.
- Interrupted downloads resume on the next attempt. Completed chunks are kept when you cancel.
- If browser Cache Storage itself is unreadable (`NotReadableError`), the app skips the old cache retry and downloads the weights once into a plain memory `Uint8Array`, so ONNX Runtime never reopens a browser-backed Blob. Chunks in that fallback are still fetched four at a time.
- A single ONNX file above roughly 2 GB cannot be allocated as one buffer in Chromium, so Fluid Speech Pro Full is rejected before download with a clear message. Compact is the supported large multilingual variant.
- Raw numeric ONNX Runtime aborts (for example `20384952`) are reported as a WebAssembly memory/operator failure instead of an unexplained number.
- Granite Speech uses Transformers.js’s own Cache Storage bucket (`transformers-cache`). Its progress callback feeds the same speed/ETA card, and clearing the model removes its cached files.
- tiny-voca’s model and lexicon are static files in `public/`; the fast path fetches the 3.4 MB lexicon and lazily loads eSpeak. The accurate path also serves Pyodide and NumPy from `public/`. All are cached by the browser’s normal HTTP cache.
- The app requests persistent storage before the first download. Browsers may deny it; the UI then shows **Best effort**.
- If storage runs out mid-download, the current session keeps the chunks it already has and tries to continue without caching. A warning is shown.
- The **Downloaded models** list shows every cached/partial model variant. Use its trash button to clear one model or **Clear all** to remove both cache buckets.
- Model weights are never stored in `localStorage` or IndexedDB.

Why not one giant `ArrayBuffer`? Cached model files are assembled into a `Blob` and handed to ONNX Runtime, so a normal cached model is not materialized in the JS heap. If the browser cannot reopen that Blob (`NotReadableError`), the fallback downloads into one plain `Uint8Array`. A single file above roughly 2 GB cannot be allocated as one Chromium buffer, which is why the fp32 encoder (2.59 GB) is blocked.

## Privacy
- Audio is decoded, resampled, and transcribed in the tab. It is never uploaded.
- No backend, analytics, cookies, font CDN, or runtime CDN.
- The only external requests are Hugging Face model weights when you choose to download a model, plus links you click.
- Hugging Face sees normal request metadata (IP address, user agent) when weights are downloaded, but never audio or transcript content.
- The only local preferences are the selected model/variant and clean-mode toggle in `localStorage`.

## Browser support and limitations

- **WebGPU** varies by browser/OS. Chrome/Edge desktop and recent Chromium are the best-tested. Without WebGPU, TDT and Qwen3 models run on multi-threaded WASM; on GitHub Pages the isolation service worker supplies the COOP/COEP headers.
- **Granite Speech requires WebGPU** and will not run on the CPU. It is blocked before download when no adapter is available.
- **Fluid Speech Mini** is English-only.
- **Parakeet Redux**, **Fluid Speech Pro**, **Rumble-2-Flash**, and **Qwen3-ASR** cover different multilingual sets; see the table and the exact language list in the picker.
- **Phonon-2** is English only. Its ONNX package uses a separate 1.2 MB preprocessor graph, so its features match Fermion’s reference runtime.
- **Fluid Speech Pro on CPU is slow.** In a one-thread WASM test, a 5.5-second clip took about 65 seconds. Use WebGPU for Pro, or choose Mini/Redux on CPU.
- **Qwen3-ASR 0.6B is slower on CPU than Rumble.** Its int8 KV-cache decoder runs on WASM. With eight WASM threads, a 30-second clip took about 12 seconds with Qwen3-ASR and about 9 seconds with Rumble-2-Flash. The decoder reserve was tightened to match realistic speech token rates, which reduces the cache copied per token.
- **The full-precision Pro model** stores its weights in one 2.59 GB external-data file. Chromium cannot allocate a single buffer that large, so the app blocks it before downloading and points to Compact.
- **Clean mode** is available only for Fluid Speech Pro.
- There is no fixed duration or file-size cap. Long audio uses more memory while it is decoded and resampled; very large recordings are limited by the browser and the machine’s available memory. Long audio is split at silence for inference; Qwen3 models use 15-second chunks to bound their KV cache.
- **tiny-voca is English only**. Unknown words are handled by dizione’s small G2P model, so unusual names can be mispronounced.
- OGG and M4A decoding depends on browser codecs. WAV/MP3 are the most portable.
- No streaming, word timestamps, diarization, or translation (Granite can translate only through a different prompt).
- Accuracy claims are the model publishers’ reported numbers; test on your own audio, accents, and noise.

## Troubleshooting

| Symptom | What to try |
| --- | --- |
| “WebGPU unavailable” | Use a recent Chrome/Edge desktop build. Check `chrome://gpu`. TDT/Qwen fall back to WASM; Granite does not. |
| Granite says “requires WebGPU” | Open the app in a WebGPU-capable desktop browser, or choose Rumble-2-Flash / Qwen3-ASR. |
| Download is slow | The card shows speed and ETA. A wired connection or a smaller model helps. Completed chunks resume. |
| "Not enough browser storage" | Clear a cached model, free disk space, or choose Mini/Redux. Full Pro is blocked in Chromium because one weight file is larger than the browser's single-buffer limit; Granite needs about 1.73 GB. |
| Fluid Speech Pro is very slow | It is running on the CPU fallback. Use WebGPU, or switch to Mini/Redux. Check that `crossOriginIsolated` is `true` so the CPU path gets multiple WASM threads. |
| Qwen3-ASR 0.6B is slow | Its int8 KV-cache decoder runs on CPU. Rumble-2-Flash is much faster for the same engine. |
| Redux output looks wrong | Try Fluid Speech Mini for English. The Redux int8 decoder is a compression trade-off. |
| OGG/M4A will not decode | Try Chrome/Firefox or convert to WAV/MP3. |
| "The requested file could not be read" / `NotReadableError` | The browser lost access to a cached or Blob-backed model file. The app retries once without Cache Storage, downloading the weights into a plain memory buffer. If it repeats, close other tabs and try a smaller model. |
| "Chromium cannot allocate a single buffer this large" | Fluid Speech Pro Full packs 2.59 GB into one file, above Chromium's single-buffer limit. Choose Compact. |
| ONNX Runtime shows a raw number such as `20384952` | That is a release-build WASM abort with no message. The app now labels it as a memory/operator failure; use Compact or a smaller model. |
| The page reloads once on the first visit | That is the isolation service worker installing COOP/COEP headers. Later visits do not reload. If it is blocked, the app continues single-threaded. |
| CPU transcription is slower than the README numbers | Check `crossOriginIsolated` in DevTools. If it is `false`, the service worker or the host's headers are missing, so ONNX Runtime is limited to one thread. |
| Text to speech is slow the first time | Fast mode loads the 3.4 MB lexicon and eSpeak; Accurate mode loads the Pyodide + NumPy runtime. Later generations reuse them. |
| The first OGG Vorbis/AIFF/CAF export is slow | Those use the lazy 32 MB FFmpeg fallback. FLAC, M4A/AAC, WebM/Opus, and Opus/Ogg use the fast encoder; MP3 and WAV never load FFmpeg. |
| A TTS format fails to export | MP3 and WAV need no extra codecs. If an ffmpeg format fails, try MP3 or WAV; the error text comes from the local encoder worker. |
| tiny-voca mispronounces a word | Fast mode is lexicon-based with an eSpeak fallback. Switch Phonemizer to Accurate for dizione’s context and homograph rules, or spell names phonetically. |
| Cache says “Best effort” | The browser denied persistent storage; it may evict the cache under pressure. Re-downloading works. |
| Need to compare or roll back the media engine | Append `?mediaEngine=ffmpeg` to force the FFmpeg path, or `?mediaEngine=mediabunny` to prefer the fast path. The default is `auto` with a lazy FFmpeg fallback. |
| Want to change a model revision | Edit the revision in `src/catalog.ts`. Cache keys include the revision. |
| Want to add a fused TDT model | Add an entry and file specs to `src/catalog.ts`; the existing fused TDT path can handle the same I/O. |
| Want to add another Qwen3-ASR export | Add a `qwen3-asr` entry with `conv_frontend.onnx`, `encoder*.onnx`, `decoder*.onnx`, and the tokenizer directory. |
| Console says nodes were not assigned to the preferred execution provider | That was a benign ONNX Runtime WebGPU shape-node message; the app now sets the ORT log level to `error` so it no longer floods the console. |
| Language is wrong on a short clip | Choose the language explicitly in the model card instead of Auto-detect. |

## Project structure

```text
.
├── .github/workflows/deploy.yml
├── index.html
├── package.json
├── package-lock.json
├── tsconfig.json
├── vite.config.ts
├── seo/
│   └── pages.ts        use-case + language page data and model metadata
├── scripts/
│   └── seo-plugin.ts   static page, sitemap, robots, and canonical generator
├── LICENSE
├── NOTICE
└── src/
    ├── main.ts       suite routing, model picker, progress/ETA, transcript actions
    ├── catalog.ts    Model metadata, variants, files, research entries
    ├── audio.ts      Web Audio decode, resample, silence chunking, analysis
    ├── capabilities.ts Device profile and per-model fit labels
    ├── exports.ts    TXT/SRT/VTT/Markdown/JSON builders
    ├── history.ts    opt-in IndexedDB transcript history
    ├── presets.ts    job presets
    ├── recorder.ts   MediaRecorder microphone capture
    ├── postprocess.ts spoken punctuation and number clean-up
    ├── mel.ts        NeMo log-mel for Fluid/Parakeet
    ├── whisper-mel.ts Whisper log-mel for Qwen3-ASR
    ├── qwen.ts       Qwen3 BPE tokenizer, prompt helpers, transcript cleanup
    ├── granite.ts    Transformers.js Granite engine
    ├── transformers-asr.ts  Transformers.js Moonshine and Whisper inference
    ├── omnilingual.ts OmniASR CTC tokenizer and greedy decoder
    ├── ort-runtime.ts Shared ORT loader, backend choice, WASM thread setup
    ├── phonemizer.ts Fast JS IPA lexicon + eSpeak phonemizer
    ├── tts.ts        tiny-voca + Kokoro engines, MP3/WAV encoding, ffmpeg client
    ├── media-types.ts      MediaEngine interface, PCM, capability types
    ├── media-router.ts     Mediabunny first; FFmpeg lazy fallback
    ├── mediabunny-engine.ts probe/decode/trim/encode fast path
    ├── ffmpeg-engine.ts    adapter around the existing FFmpeg worker
    ├── pcm-audio.ts        planar PCM + float WAV helpers
    ├── audio-dsp.ts        sample-DSP trim/cut, gain, fades, mono, reverse
    ├── model.ts      Cache/download, TDT + Mini + Qwen3 inference
    ├── errors.ts
    ├── style.css
    └── vite-env.d.ts
public/
    ├── coi-serviceworker.js  COOP/COEP, app-shell cache, request reporting
    ├── seo.css               generated landing-page stylesheet
    ├── samples/              bundled JFK sample + provenance
    ├── icon.svg              app icon
    ├── manifest.webmanifest  installable app manifest
    ├── tts-worker.js         local Pyodide/dizione phonemizer
    ├── pyodide/              Pyodide core + NumPy wheel
    └── tiny-voca/            ONNX voice model, config, phonemizer data
```

## Credits and license

- **Fluid Speech Pro** and **Fluid Speech Mini** by FluidVoice — **CC BY 4.0**. Fluid Speech Mini is built on NVIDIA Parakeet TDT 0.6B v3 and Moondream Parakeet Ultra.
- **Parakeet Redux** by Moondream, based on NVIDIA Parakeet TDT 0.6B v3 — **CC BY 4.0**.
- **Parakeet Ultra** by Moondream, based on NVIDIA Parakeet TDT 0.6B v3 — **CC BY 4.0**.
- **Rumble-2-Flash** by Reson8 — **Apache 2.0**.
- **Qwen3-ASR 0.6B** by Alibaba Cloud — **Apache 2.0**.
- **Phonon-2** by Fermion Research, ONNX export by Tiyuvta — **CC BY 4.0**.
- **Granite Speech 5.0 2B** by IBM — **Apache 2.0**.
- **Moonshine Tiny/Base** by Useful Sensors / Moonshine AI — **MIT**.
- **Omnilingual ASR 300M** by Meta AI, ONNX export by OpenVoiceOS — **Apache 2.0**.
- **Whistle** and **Mirage** by Cactus Compute, with the **Cactus** WebAssembly runtime — **Apache 2.0**.
- **Nemotron 3 Diarization** by NVIDIA, ONNX export by onnx-community — **OpenMDW-1.1**. Used by **Detect speakers**.
- **SAM 3 tracker** by Meta, ONNX export by onnx-community — **SAM License**.
- **PP-OCRv6 tiny** by PaddlePaddle — **Apache 2.0**.
- **Phonon 31M** by Gradium — **Apache 2.0**.
- **Supertonic 3** by Supertone — **OpenRAIL-M** (use-based restrictions).
- **tiny-voca** by Muhammed Nazeem — **Apache 2.0**.
- **Kokoro-82M** by hexgrad, via **kokoro-js** — **Apache 2.0**.
- **dizione** by Muhammed Nazeem — **Apache 2.0**; its data derives from CMUdict and the Wikipedia Homograph Data.
- **phonemizer** by Xenova — **Apache 2.0**; the bundled **eSpeak NG** engine is **GPL-3.0-or-later**. It is loaded lazily only by the Fast tiny-voca path.
- **@breezystack/lamejs** — **LGPL-3.0**. MP3 encoding is loaded as a JavaScript module; its source is available on npm.
- **Mediabunny** by David Vanilagy — **MPL-2.0**. Fast media path and video export. The optional encoder extensions are lazy-loaded: MP3 (LAME), AAC (libavcodec), and FLAC (libFLAC). See [`NOTICE`](NOTICE).
- **fix-webm-duration** by Yury Sitnikov — **MIT**. Adds the duration metadata MediaRecorder omits from WebM recordings.
- **ffmpeg.wasm** (`@ffmpeg/core`) - **GPL-2.0-or-later**. The core runs in a separate WebAssembly worker built from `src/ffmpeg-worker.js`; see [`NOTICE`](NOTICE) for the distribution note.
- **Transformers.js** by Hugging Face - **Apache 2.0**.
- **PDF.js** (`pdfjs-dist`) - **Apache-2.0**. Renders PDF preview and redaction pages and reads PDF Info/XMP metadata; the worker is lazy-loaded.
- **pdf-lib** - **MIT**. Builds redacted PDFs and removes PDF metadata.
- **@cantoo/pdf-lib** - **MIT**. Fork of pdf-lib used to unlock PDFs and add AES-256 password protection.
- **exifr** - **MIT**. Reads EXIF, GPS, XMP, IPTC, ICC, and image metadata in the metadata viewer.
- **spark-md5** - **WTFPL OR MIT**. Computes the MD5 checksum shown in the metadata viewer.
- **Mammoth** - **BSD-2-Clause**. Extracts plain text from DOCX files in the Word viewer.
- **Pyodide** - **MPL-2.0**; **NumPy** - **BSD-3-Clause**.
- **ONNX Runtime Web** — MIT.
- **Application code** — MIT. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).

This is an independent demo and is not affiliated with FluidVoice, NVIDIA, Moondream, Reson8, Alibaba Cloud, IBM, Hugging Face, or Fermion Research.

