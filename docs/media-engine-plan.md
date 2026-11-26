# Media engine plan: Mediabunny fast path, FFmpeg fallback

Goal: remove the 32 MB FFmpeg/WASM download and worker startup from the common audio
studio and TTS export paths, while keeping every current format and effect available.

Status: **implemented for the performance path.** Phases 0–3 are in place, plus the safe
sample-DSP subset of Phase 4 (trim/cut, gain, fades, mono, reverse). Phase 5 remains the
optional zero-FFmpeg project. Benchmark results are in [`benchmarks/README.md`](../benchmarks/README.md).

## What landed

- `src/media-types.ts` — engine interface, PCM/DecodedAudio, capability types.
- `src/media-router.ts` — Mediabunny first, FFmpeg fallback, capability cache, feature flag.
- `src/mediabunny-engine.ts` — lazy dynamic import, probe, decode, trim, WAV/MP3/FLAC/M4A/
  AAC/Opus/WebM encode, capability checks.
- `src/ffmpeg-engine.ts` — adapter around the existing worker.
- `src/pcm-audio.ts` — planar PCM and float-WAV read/write.
- `src/audio-dsp.ts` — sample-DSP path for trim/cut, gain, fades, mono, reverse.
- `audio-studio.ts` and `tts.ts` — open/export now go through the router.
- Format hints show “Fast local encoder” or “FFmpeg fallback” on focus/change.
- FFmpeg remains lazy and is still used for AIFF/CAF/Vorbis, denoise, loudness, limiting,
  pitch/tempo, reverb, joins/stems, and legacy inputs.
- Mediabunny is dynamically imported; the initial entry grows by about 27 kB gzip, while the
  fast media core is a ~179 kB gzip chunk loaded on first use instead of the 32 MB core.

## Why this shape

The project already uses Mediabunny for video export (`src/video-export.ts`) with FFmpeg
for the soundtrack and as the fallback for AVI/WMV/FLV. That is the proven pattern. Apply
the same split to audio:

- **Mediabunny**: probe, decode to PCM, simple trim, and common-format encode.
- **FFmpeg**: effects that need a real DSP graph, AIFF/CAF/Vorbis, legacy inputs, and the
  video soundtrack/fallback.

This gets the speed win without pretending Mediabunny has an FFmpeg filter graph. It does
not.

## Success criteria

1. Opening a WAV, MP3, M4A, FLAC, Ogg, WebM, MP4 or MKV in Audio studio does **not**
   download or start the FFmpeg core.
2. Exporting WAV, MP3, FLAC, M4A/AAC, Opus, WebM or Ogg-Opus does **not** download or
   start the FFmpeg core.
3. AIFF, CAF, Ogg Vorbis, denoise, loudness normalization, limiting, pitch/tempo and legacy
   inputs still work through the lazy FFmpeg fallback.
4. The format menu says whether a format uses the fast path or the FFmpeg fallback, and
   why a format is unavailable before the user clicks Export.
5. No change to the core transcription path, the privacy receipt, or the no-CDN rule.
6. Build and typecheck pass; the initial bundle grows by only a small amount because
   codec extensions are lazy-loaded.

## Current surface to preserve

| Area | File | What it does today |
| --- | --- | --- |
| FFmpeg worker/client | `src/audio-ffmpeg.ts` | `probe`, arbitrary `run`, `encode`, 32 MB core, load progress, stall recovery |
| Studio effects | `src/audio-edit.ts` | trim/splice, denoise, high/low pass, echo, reverse, mono, bass/treble, gain, pitch/tempo, loudnorm, fades, limiter, join/crossfade, stem mix, karaoke |
| Studio orchestration | `src/audio-studio.ts` | open via `prepareEditorAudio`, export via `ffmpeg.encode`, effects via `applyAudioEdit`, joins/stems/karaoke |
| TTS export | `src/tts.ts` | WAV direct, MP3 via lamejs, other formats via `sharedFfmpeg().encode` |
| Video export | `src/video-export.ts` | Mediabunny video, FFmpeg soundtrack + legacy fallback (keep) |
| App status | `src/app-ux.ts` | reports FFmpeg engine size/state (update) |

## Architecture

### New seam

Add `src/media-types.ts`:

```ts
export interface MediaProbe { /* existing shape, moved from audio-ffmpeg.ts */ }
export interface AudioStreamInfo { /* existing shape */ }

export interface DecodedAudio {
  /** Float WAV, matching the current version.blob representation. */
  wav: Blob;
  /** Optional planar PCM for analysis and future DSP. */
  pcm?: PcmAudio;
  sampleRate: number;
  channels: number;
  channelMask: number;
  duration: number;
}

export interface PcmAudio {
  /** Planar channel chunks; avoids one giant interleaved allocation. */
  channels: Float32Array[];
  sampleRate: number;
  channelMask: number;
  frames: number;
}

export interface DecodeOptions {
  signal?: AbortSignal;
  trim?: { start: number; end: number };
  onProgress?: (progress: { ratio: number | null; time: number }) => void;
}

export interface EncodeOptions {
  signal?: AbortSignal;
  onProgress?: (progress: { ratio: number | null; time: number }) => void;
  quality?: 'low' | 'medium' | 'high' | number;
}

export interface FormatCapability {
  fast: boolean;
  fallback: boolean;
  reason?: string;
}

export interface MediaEngine {
  readonly id: 'mediabunny' | 'ffmpeg';
  canHandle(file: Blob): Promise<boolean>;
  probe(file: Blob, signal?: AbortSignal): Promise<MediaProbe>;
  decode(file: Blob, options?: DecodeOptions): Promise<DecodedAudio>;
  trim(file: Blob, start: number, end: number, options?: DecodeOptions): Promise<DecodedAudio>;
  encode(source: Blob, format: AudioFormat, options?: EncodeOptions): Promise<Blob>;
  capabilities(): Promise<Record<AudioFormat, FormatCapability>>;
}
```

Add `src/media-router.ts`:

- `probe`: Mediabunny if `canHandle`, else FFmpeg.
- `decode`/`trim`: Mediabunny if `canHandle` and the audio track `canDecode()`, else
  FFmpeg. Fall back only on `UnsupportedMediaError`, not on abort/corruption.
- `encode`: Mediabunny if the format is fast-capable, else FFmpeg. On an unexpected
  encoder failure, retry once on FFmpeg and record the reason.
- Cache `canHandle` per `Blob` (WeakMap) and capabilities per session.
- Expose `lastEngine` and `lastFallbackReason` for Settings diagnostics.

Add `src/ffmpeg-engine.ts`:

- Adapter around the existing `AudioFfmpeg`; no changes to the worker protocol.
- `decode` = `prepareEditorAudio` + `inspectEditorAudio` + PCM read.
- `encode` = `AudioFfmpeg.encode`.
- `capabilities` = every format true (fallback always available).

Add `src/mediabunny-engine.ts`:

- `canHandle`: `new Input({ source: new BlobSource(file), formats: ALL_FORMATS })` and
  `await input.canRead()`.
- `probe`: `computeDuration`, primary video/audio tracks, audio track list, codec,
  channels, language, name. Use `computeFrameRateMetrics` only for video; the studio can
  skip video metrics.
- `decode`: `getAudioTracks()[0]` (matches `-map 0:a:0`), check `canDecode()`,
  `AudioSampleSink`, copy to `f32-planar`, assemble planar chunks by timestamp.
- `trim`: `Conversion.init({ input, output: WAV pcm-f32, trim })`; later replace with
  sample slicing when the PCM path is stable.
- `encode`: `Conversion.init({ input: float WAV, output: format, audio: { codec, quality } })`
  with `BufferTarget`.
- `capabilities`: for each format, check the output format supports the codec and
  `canEncodeAudio` passes; import/register extensions first.
- Always dispose `Input` in `finally`; `conversion.cancel()` on abort.

### PCM and WAV helpers

Add `src/pcm-audio.ts`:

- `PcmAudio` assembly from `AudioSample` chunks with timestamp gaps filled by silence.
- `pcmToFloatWav(pcm): Blob` — writes the float WAV the studio already uses.
- `readFloatWav(blob): Promise<PcmAudio>` — inverse for DSP/legacy paths.
- `analyzePcm(pcm, channelMask): EditorAudio` — refactor the analysis currently inside
  `inspectEditorAudio` so both engines can use it without writing/re-reading a WAV.
- Keep `inspectEditorAudio` as a wrapper over `readFloatWav` + `analyzePcm` for
  compatibility and tests.

Channel support: fast path only for mono/stereo at first. Fall back to FFmpeg for >2
channels until channel-layout mapping is tested.

## Format matrix

| Format | Container | Codec | Fast path | Fallback |
| --- | --- | --- | --- | --- |
| WAV | WAVE | pcm-s16 | ✅ built-in | — |
| MP3 | MP3 | mp3 | ✅ `@mediabunny/mp3-encoder` | — |
| FLAC | FLAC | flac | ✅ `@mediabunny/flac-encoder` | — |
| M4A | MP4 | aac | ✅ WebCodecs or `@mediabunny/aac-encoder` | — |
| AAC | ADTS | aac | ✅ same | — |
| OPUS | Ogg | opus | ✅ WebCodecs, if available | FFmpeg |
| WEBM | WebM | opus | ✅ WebCodecs, if available | FFmpeg |
| OGG | Ogg | vorbis | ❌ no browser encoder / no extension | FFmpeg |
| AIFF | AIFF | pcm-s16be | ❌ no container | FFmpeg |
| CAF | CAF | pcm-s16le | ❌ no container | FFmpeg |

Input fast path: MP4, MOV, MKV, WebM, Ogg, MP3, WAV, AAC, FLAC, TS, HLS.
Input fallback: AIFF, CAF, WMA, AMR, APE, WV, TTA, MPC, DSF, DFF, AVI, WMV, FLV and the
rest of the `MEDIA_EXTENSIONS` long tail.

TTS uses the same matrix minus AIFF/CAF; Ogg Vorbis remains the only TTS fallback.

## Phase plan

### Phase 0 — Baseline and guardrails (1–2 days)

- Add a benchmark corpus: 10 s, 1 min, 10 min of WAV, MP3, M4A, FLAC, Ogg, WebM, MP4.
- Record today's numbers: cold/warm open, export, peak memory, FFmpeg core download.
- Add feature-flag plumbing: `mediaEngine=auto|mediabunny|ffmpeg` from URL/localStorage.
- Add tests for the current format/effect behavior so the fallback can't silently change.
- Add a Settings diagnostics row for the selected engine and last fallback reason.

Exit: benchmarks and flags committed; current behavior covered by tests.

### Phase 1 — Seam and adapters (2–3 days)

- Add `media-types.ts`, `media-router.ts`, `ffmpeg-engine.ts`.
- Implement `MediabunnyEngine.canHandle` and `probe` only.
- Keep the default engine on FFmpeg; no user-visible change.
- Unit tests: router selection, unsupported container, corrupt file, abort.
- Add `@mediabunny/mp3-encoder`, `aac-encoder`, `flac-encoder` to `package.json` but do
  not import them at startup.

Exit: seam compiles and is tested; behavior unchanged.

### Phase 2 — Studio open/probe via Mediabunny (3–5 days)

- Implement `decode` + `trim` in `MediabunnyEngine`.
- Refactor `inspectEditorAudio` into `analyzePcm`; add `readFloatWav`/`pcmToFloatWav`.
- Change `audio-studio.ts` `open()` to use `media.decode`; keep `prepareEditorAudio` for
  the fallback and for effects.
- `setSource` accepts precomputed `EditorAudio` so the WAV is not analyzed twice.
- Use the first audio track, matching `-map 0:a:0`.
- Fast path only for mono/stereo; >2 channels -> FFmpeg.
- Abort: dispose the `Input`; cancel `Conversion`; break sample iterators.
- Progress: map sample timestamps to the studio's `{ratio, time}`.

Exit: opening common formats makes **zero** FFmpeg requests; AIFF/CAF/AVI/WMV/FLV still
work through fallback; WAV/FLAC PCM matches FFmpeg, lossy formats are within tolerance.

### Phase 3 — Common-format export and gating (3–4 days)

- Implement `encode` in `MediabunnyEngine` using the format matrix.
- Lazily import and register the MP3/AAC/FLAC encoders only when needed. The MP3
  extension is about 130 KB gzipped (single file, bundled worker/WASM); AAC and FLAC are
  similar. They are per-format lazy chunks, not startup cost.
- Use `WavOutputFormat` + `pcm-s16` for WAV; `Mp4OutputFormat({ fastStart: 'in-memory' })`
  for M4A; `AdtsOutputFormat` for AAC; `OggOutputFormat` for Opus; `WebMOutputFormat` for
  WebM.
- Quality mapping: MP3 ~192 kbps (or a tested LAME quality), AAC 192 kbps, Opus 96–128
  kbps. FLAC is lossless.
- Change `audio-studio.ts` `download()` and stem downloads to `media.encode`.
- Change `tts.ts` `convertTtsResult` to `media.encode` for FLAC/M4A/WebM/Opus; keep lamejs
  for MP3 and direct WAV.
- Add `capabilities()` and a format hint in the studio/TTS selects:
  - "MP3 · fast local encoder"
  - "AIFF · FFmpeg fallback (loads the audio engine once)"
  - disabled with a reason if neither engine can write it.
- Keep AIFF/CAF/Ogg Vorbis on FFmpeg.

Exit: common exports make zero FFmpeg requests; fallback formats still work; output files
play, seek, and have the expected duration/sample rate/channels.

### Phase 4 — Easy effects on Web Audio/sample DSP (5–8 days, incremental)

Add `src/audio-dsp.ts` and route effects by capability:

| Effect | Phase 4 fast path | Keep on FFmpeg |
| --- | --- | --- |
| Trim/cut/splice | ✅ sample slicing | — |
| Gain, fades | ✅ sample math | — |
| Highpass/lowpass, bass/treble | ✅ BiquadFilter / biquad | — |
| Mono | ✅ downmix | — |
| Reverse | ✅ sample reverse | — |
| Join/crossfade | ✅ sample concat/crossfade | until validated |
| Stem mix | 🟡 gains; limiter still FFmpeg at first | until limiter validated |
| Reverb/echo | later | ✅ initially |
| Denoise | ❌ | ✅ always |
| Loudness normalization | ❌ | ✅ always |
| Limiter | ❌ | ✅ until custom limiter is trusted |
| Pitch/tempo | ❌ | ✅ always for now |

Routing rule:

```ts
function needsFfmpeg(edit: AudioEdit): boolean {
  return edit.denoise > 0
    || edit.effect === 'denoise'
    || edit.effect === 'reverb'
    || (edit.effects ?? []).some((e) => e === 'denoise' || e === 'reverb')
    || edit.loudness !== null
    || edit.ceiling !== null
    || (edit.pitch ?? 0) !== 0
    || (edit.tempo ?? 1) !== 1;
}
```

- `applyAudioEdit` becomes a router: DSP for easy edits, FFmpeg for the rest.
- `joinAudio`/`mixKaraoke`/`mixStems` get their own routing:
  - karaoke: DSP when `voicePitch === 0`; FFmpeg when pitch != 0.
  - join: FFmpeg first, then DSP once crossfade tests pass.
  - stems: FFmpeg first, then DSP once the limiter is validated.
- A/B test each moved effect against the FFmpeg output; lengths, peaks, RMS, and listening.
- Keep `studio-player.ts` preview graphs as the reference for preview/export consistency.

Exit: easy edits no longer load FFmpeg; hard edits still do; outputs match within agreed
tolerances.

### Phase 5 — Optional zero-FFmpeg mode (2–4 weeks, separate decision)

Only if the product no longer needs FFmpeg at all:

- Add a libvorbis WASM custom coder for Ogg Vorbis, or drop Vorbis in favor of Ogg Opus.
- Add AIFF/CAF muxers/demuxers for the PCM variants.
- Implement or adopt denoise (RNNoise/spectral), EBU R128 loudness, a lookahead limiter,
  and a time-stretch/pitch-shift engine.
- Accept that legacy AVI/WMV/FLV/WMA/AMR inputs will no longer open.
- Update `NOTICE` for every new WASM/codec license.
- Remove FFmpeg only after a release with the fallback and a clean rollback path.

This is not needed for the performance goal. Phases 1–4 already remove FFmpeg from the
common path.

## UI and diagnostics

- Studio format select: add a capability hint per option; do not fail after the click.
- TTS format select: same.
- Settings: "Media engine — Mediabunny/WebCodecs fast path, FFmpeg fallback on demand";
  show the last fallback reason and a "Prefer FFmpeg" diagnostic toggle.
- Errors: when a container/codec is unsupported by both engines, say which format to use.
- Keep the privacy receipt honest: extension WASM is same-origin and loaded only on use;
  no new hosts.

## Testing

Unit (Bun):

- Router chooses fast/fallback per container and per format.
- `canHandle` returns false for AIFF/CAF/AVI/WMV/FLV.
- `capabilities` gating with mocked `canEncodeAudio`.
- `analyzePcm` matches `inspectEditorAudio` on the existing stereo WAV fixture.
- `pcmToFloatWav`/`readFloatWav` round-trip.
- Abort and error fallback behavior.

Browser integration:

- Open each format; check the network panel shows no FFmpeg core for fast formats.
- Export each format; parse the output back with Mediabunny and check codec/duration/
  sample rate/channels.
- A/B compare WAV/FLAC samples and lossy duration/levels against FFmpeg.
- Test TTS exports and the studio's stems/join/karaoke.
- Test Chrome/Edge, Firefox and Safari; disable or fall back when `canEncodeAudio` fails.
- Test offline: extension chunks cached after first use; no CDN.
- Test the service worker after adding lazy chunks.

Performance:

- Cold/warm open for 10 s/1 min/10 min files.
- Export time and peak memory per format.
- FFmpeg core bytes downloaded on a common open/export (target: 0).

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Browser lacks an encoder (Opus/AAC) | `canEncodeAudio` gate; FFmpeg fallback; show reason |
| Mediabunny can't decode a codec | `track.canDecode()` check; FFmpeg fallback |
| Sample-rate/channel mismatch | Preserve source layout; fast path mono/stereo only; FFmpeg for >2 channels |
| Timestamp gaps/negative timestamps | PCM assembler with silence fill; tests |
| Large-file memory | Planar chunk assembly; size guard; FFmpeg fallback |
| MP3/AAC/Opus duration or gapless differences | Duration tests; per-format fallback if needed |
| Effect behavior changes | A/B tests; keep FFmpeg for reverb/denoise/loudness/limiter/pitch initially |
| Bundle/caching | Lazy-import extensions; check Vite chunks and service worker |
| Licensing | MPL-2.0 core; audit WASM builds for LAME/libavcodec/libFLAC terms; update NOTICE |
| Other agent's uncommitted work | Use a worktree/branch; add new files first; touch `audio-studio.ts` minimally |

## Rough sequence and effort

| Phase | Effort | User-visible result |
| --- | --- | --- |
| 0 | 1–2 days | Benchmarks + flag + diagnostics |
| 1 | 2–3 days | Seam, no behavior change |
| 2 | 3–5 days | Fast studio open; no 32 MB load for common files |
| 3 | 3–4 days | Fast exports + format hints |
| 4 | 5–8 days | Easy effects off FFmpeg |
| 5 | 2–4 weeks | Optional zero-FFmpeg mode |

Total for the performance goal (0–4): roughly 3 weeks for one developer, plus browser QA.

## First PR

Keep it small and reversible:

1. Add `media-types.ts` and move/re-export `MediaProbe`/`AudioStreamInfo`.
2. Add `media-router.ts` and `ffmpeg-engine.ts` with tests.
3. Add `mediabunny-engine.ts` with `canHandle` + `probe` only.
4. Add `@mediabunny/mp3-encoder`, `aac-encoder`, `flac-encoder` as dependencies but no
   startup imports.
5. Add the Settings diagnostics row and the `mediaEngine` feature flag.
6. No UI path changes yet.

Then land Phase 2 and Phase 3 as separate PRs so a regression can be reverted without
losing the seam.
