# Model radar — November 2026

Research pass over Hugging Face, the Transformers.js / ONNX ecosystem, npm, Hacker News,
Reddit, X, and model-publisher blogs. The goal: find small audio and vision models that are
newer or better than what LocalScribe ships today, and that can realistically run in a browser
tab under the project's existing constraints.

Date of survey: **21 November 2026**. Everything below was checked against a live model repo,
a published browser runtime, or both. Sizes are decimal MB unless noted.

---

## TL;DR

### Audio

| Rank | Model | What it replaces / adds | Size | License | Runtime fit | Effort |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | **Parakeet Ultra** (Moondream) | Better multilingual Parakeet than Redux | ~497 MB (int4 encoder + fp32 decoder) | CC BY 4.0 | Same fused TDT I/O as Redux; WebGPU | S |
| 2 | **Phonon 31M** (Gradium) | Smaller, streaming English TTS; new engine | ~53–65 MB | Apache 2.0 | `phonon-tts` npm, WASM + worker | S–M |
| 3 | **Nemotron 3 Diarization** (NVIDIA) | New capability: who spoke when, 8 speakers | 73 MB (q4f16) / 120 MB (int8) | OpenMDW-1.1 | ONNX; custom frame-classification loop | M |
| 4 | **Whistle** (Cactus) | Ultra-light dictation / low-end devices | **16.9 MB** | Apache 2.0 | `cactus-needle/browser`, WASM workers | S–M |
| 5 | **Supertonic 3** (Supertone) | Multilingual TTS, 31 languages | ~398 MB | OpenRAIL-M | ONNX; needs custom engine or newer TJS | M |
| 6 | **Kitten TTS 2 Mini** | Budget multilingual TTS, 16 languages | 82.7 MB int8 / 47.5 MB int4 | Apache 2.0 | ONNX; needs G2P front-end | M |

### Vision

| Rank | Model | What it replaces / adds | Size | License | Runtime fit | Effort |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | **BiRefNet-lite 512** | Much better background removal than RMBG 1.4 / MODNet | 94 MB fp16 | MIT | Transformers.js + WebGPU, browser-proven | S |
| 2 | **PP-OCRv6 tiny/small** | New task: OCR / document text | 6.3 MB (tiny det+rec) / 30 MB (small) | Apache 2.0 | ONNX; custom pre/post | M |
| 3 | **D-FINE Nano** | Much better COCO detection than YOLOS Tiny | 15.4 MB fp32 / 4.8 MB int8 | Apache 2.0 | Transformers.js `object-detection` | S |
| 4 | **Mirage** (Cactus) | One 22 MB model for caption, detect, OCR, segment, forms | **21.6 MB** | Apache 2.0 | Cactus WASM engine; no high-level JS API yet | L |
| 5 | **SAM 3 tracker** | New task: click/box promptable segmentation | ~307 MB (q4f16) | SAM License (commercial allowed) | Transformers.js `Sam3TrackerModel` | M |
| 6 | **SmolVLM2-256M** | Replaces the 958 MB ViT-GPT2 captioner; adds VQA | ~345 MB int8 | Apache 2.0 | Transformers.js `image-text-to-text` | S–M |
| 7 | **Depth Anything 3 Small** | Better depth than DA2 Small | 105 MB ONNX | Apache 2.0 | ONNX exists; missing processor/config | M |

Release dates: Parakeet Ultra Sep 2026 (browser ONNX Nov 2026), Phonon Oct 2026, Nemotron 3
Diarization Sep 2026, Whistle Sep 2026, Supertonic 3 May 2026, Kitten TTS 2 Nov 2026,
BiRefNet-lite 512 Apr 2026, PP-OCRv6 Jun 2026, D-FINE Nano Sep 2026 ONNX, Mirage Nov 2026,
SAM 3 tracker Nov 2025, SmolVLM2 Feb 2025, Depth Anything 3 Small Nov 2025.

### Do not add (yet)

- **RMBG 3.0** — 16 GB diffusion transformer, 32 GB GPU requirement, self-hosted license. Not a browser model.
- **Cohere Transcribe 2B** — best q4 artifact is a 1.5 GB custom `.oasr` file. Too large and not ONNX.
- **Qwen3-ASR 1.7B** — 4.7 GB fp32; the existing 0.6B is the browser-sized member of the family.
- **Voxtral Mini 4B Realtime / Nemotron 3.5 Transcribe 30B / VibeVoice 7B** — server-class.
- **Fluid Speech Pico** — still announced, not released.
- **YOLO26** — strong, but AGPL-3.0 weights; D-FINE and RF-DETR are Apache-2.0.
- **SigLIP 2 Base** — 1 GB+; too heavy for a small zero-shot classifier.
- **Moonshine Streaming Tiny** — excellent 27M multilingual candidate, but no ONNX export yet.

---

### Gaps where nothing better was found

- **Speech enhancement / denoise.** No credible open model under ~50 MB with a permissive
  license surfaced. The small VAD/voice-focus models (Silero, ai-coustics) detect speech;
  they do not clean it. Keep the existing FFmpeg filters for now.
- **Forced alignment / word-level timestamps.** Qwen3 ForcedAligner is 0.6B (~1.2 GB), and the
  small wav2vec2 aligners are English-only and non-commercial. Not worth replacing the
  segment-level timing yet.
- **Image classification.** MobileNetV4 Small is still the right size/accuracy point. SigLIP 2
  and DINOv3 are better representations but 0.5–1.5 GB; only add them if the product needs
  zero-shot labels or image search, not as a classifier swap.

---

## Audio

### 1. Parakeet Ultra — the best drop-in upgrade

**Repo:** [`ryusei-46/parakeet-ultra-ONNX-WebGPU`](https://huggingface.co/ryusei-46/parakeet-ultra-ONNX-WebGPU)
(revision `9c2bb9be4df050e495f0765470fff9335d8a3bd0`)
**Base model:** [`moondream/parakeet-ultra`](https://huggingface.co/moondream/parakeet-ultra)
**License:** CC BY 4.0
**Browser status:** used in production by [Transcriber](https://transcriber.tools.ryusei.io/en), tested on
ONNX Runtime Web 1.26 / WebGPU.

Why it matters:

- Same 0.6B Parakeet TDT architecture as the existing Redux entry, so the existing fused TDT
  decoder, tokenizer, and chunking path can be reused.
- Moondream reports **5.80% vs 6.26%** average WER on 7 English sets, **9.55% vs 11.62%** on
  25-language FLEURS, and **1.94% vs 2.71%** on TED-LIUM long-form. It is better in noise and
  long recordings. These are publisher numbers, not independent.
- The browser conversion keeps the TDT decoder/joint in FP32 and quantizes the FastConformer
  encoder to 4-bit (`MatMulNBits`, block 32) because ORT Web has no WebGPU `Attention` kernel.
  Tested at **24–29× real time** on an AMD Radeon 780M.
- I/O names match the `onnx-asr` `nemo-conformer-tdt` layout the project already understands:
  - encoder: `audio_signal [1,128,T]`, `length [1]` → `outputs [1,1024,T/8]`, `encoded_lengths`
  - decoder_joint: `encoder_outputs`, `targets`, `target_length`, `input_states_1/2` → logits
    8193 vocabulary + 5 duration, `output_states_1/2`
- The NeMo log-mel recipe in the repo (pre-emphasis 0.97, 256-sample pad, 400/160/512 FFT,
  128 Slaney mels, `log(x+2^-24)`, per-feature mean/unbiased std) is exactly what
  [`src/mel.ts`](../src/mel.ts) already implements.

Files:

| Path | Size |
| --- | --- |
| `int4/encoder.onnx` | 0.5 MB |
| `int4/encoder.onnx.data` | 423.8 MB |
| `fp32/decoder_joint.onnx` | 72.5 MB |
| `vocab.txt` | 94 KB |
| `config.json` | — |

Integration notes:

- Add a `fused-tdt` entry with a variant whose files use the `int4/` and `fp32/` subdirectories.
  The downloader's external-data name must be `encoder.onnx.data`, not
  `int4/encoder.onnx.data`; if `dataNameFor()` returns the subdirectory path, add a per-role
  override or strip the directory when handing `externalData` to ORT.
- The vocabulary is 8192 SentencePiece pieces + `<blk>` at 8192. The existing Redux
  vocabulary is the same shape.
- This is a WebGPU-first model. Keep the WASM fallback, but expect it to be slow; label the
  card "WebGPU recommended".
- It complements rather than replaces Fluid Speech Mini: Mini is English-only, 302 MB, and
  matches Ultra on English. Ultra is the multilingual choice.

Community signal: Moondream's launch post and @vikhyatk's thread; independent
[Whisper Notes comparison](https://whispernotes.app/blog/parakeet-ultra-vs-parakeet-v3) found
Ultra better in 24 languages and worse in none, at the same speed.

---

### 2. Phonon 31M — the easiest new TTS engine

**Repos:** [`gradium/phonon-31m-en`](https://huggingface.co/gradium/phonon-31m-en) and
[`onnx-community/phonon-31m-en-ONNX`](https://huggingface.co/onnx-community/phonon-31m-en-ONNX)
**License:** Apache 2.0
**Browser package:** [`phonon-tts`](https://www.npmjs.com/package/phonon-tts) 0.7.1 (13 Nov 2026),
WASM worker + Web Audio streaming.

Why it matters:

- 31M parameters, **64.5 MB q8** (28 MB q4 model + 25 MB Mimi decoder in the ONNX repo),
  24 kHz mono, English.
- Streams 80 ms chunks; time-to-first-audio is the selling point.
- Apache 2.0, unlike the current Woof and Reverb engines.
- The npm package hides the Rust/WASM runtime, so the app can add a fifth TTS engine without
  another Pyodide or ONNX graph path:

```js
import { PhononTTS } from 'phonon-tts';
const tts = await PhononTTS.load({ lang: 'en' });
const wav = await tts.synthWav('Hello from your own browser.');
```

- The model family also has **phonon-40m-multilingual** (CC BY-NC 4.0, 74.6 MB q8, French,
  German, Spanish and others) and a 40M English model. Those are the natural follow-ups if
  the 31M English voice lands well.
- Transformers.js 4.4 (`4.4.0-next.0` is on npm) adds native Phonon support via
  [PR #1811](https://github.com/huggingface/transformers.js/pull/1811). The npm package is the
  lower-risk path today.

Community signal: the r/LocalLLaMA thread
["Phonon is now open-source"](https://www.reddit.com/r/LocalLLaMA/comments/1xaw2vt/phonon_is_now_opensource_31m_and_40m_tts_models/)
and the browser demo on the model card.

---

### 3. Nemotron 3 Diarization — closes the "no diarization" gap

**Repo:** [`onnx-community/Nemotron-3-Diarization-ONNX`](https://huggingface.co/onnx-community/Nemotron-3-Diarization-ONNX)
**Base:** [`nvidia/Nemotron-3-Diarization`](https://huggingface.co/nvidia/Nemotron-3-Diarization)
**License:** OpenMDW-1.1 (commercial and non-commercial use allowed)
**Size:** 73 MB q4f16, 120 MB int8, 199 MB fp16

Why it matters:

- 100M-parameter streaming Sortformer successor. Up to **8 speakers**, "who spoke when",
  ordered by first arrival.
- Output is a simple `[T, 8]` tensor of per-speaker activity probabilities at 10 ms frame
  resolution; offline-style inference uses a 30.4 s buffer, streaming can go down to 80 ms.
- This is exactly the missing piece called out in the README's "Speaker diarization needs a
  streaming Sortformer ONNX export plus a speaker-embedding model" note. Nemotron 3 needs no
  separate embedding model.
- Integration is a custom frame-classification loop: 16 kHz audio → 128-bin log-mel →
  model → `[T,8]` → merge consecutive active frames into speaker turns. The app already has
  the mel frontend, chunking, and segment UI to hang it on.
- A lighter two-stage alternative already has Transformers.js classes:
  `onnx-community/pyannote-segmentation-3.0` (5.9 MB) + WeSpeaker ResNet34 (26.6 MB), but it
  needs clustering and is more code for a worse speaker-count story.

Recommended UI: a "Speakers" toggle on the transcript that labels each segment `Speaker 1…8`,
with a colored chip. No audio is stored.

---

### 4. Whistle — the "fits anywhere" ASR

**Repo:** [`Cactus-Compute/whistle`](https://huggingface.co/Cactus-Compute/whistle)
**Runtime:** [`cactus-needle`](https://www.npmjs.com/package/cactus-needle) 0.3.0,
`cactus-needle/browser`, WASM workers, Vite-compatible.
**License:** Apache 2.0
**Size:** **16.9 MB** (`.cact`), 7 languages: English, German, French, Spanish, Italian,
Dutch, Polish.

Why it matters:

- A genuinely tiny ASR with **word timestamps**, **language detection/forcing**, **keyword
  boosting**, and **speech embeddings** (`embed()`), all in the browser.
- Published WER **10.27% vs 12.46%** for greedy Whisper Base on the paired LibriSpeech sample;
  **5.7× faster** on a 10-second clip. It does not beat larger models, but it is excellent for
  the low-end/mobile slot and for live dictation.
- The browser package handles model download, caching, worker setup, and streaming:

```js
import { Whistle } from 'cactus-needle/browser';
const whistle = new Whistle();
const { text } = await whistle.transcribe(samples);
```

- Caveat: `cactus-needle` is an independent browser/Node wrapper, not an official Cactus
  Compute package. Check its release cadence and pin the version before shipping.
- Use it as the "Tiny / low-end" preset and as a live microphone path. Do not position it as
  an accuracy upgrade over Mini/Ultra.
- The same Cactus engine can load **Mirage** (vision) and **Needle 3** (tool calling) into one
  WASM runtime, which is a nice architectural story if the project ever wants a shared
  on-device runtime.

Community signal: **964 points / 185 comments** on Hacker News
(["Whistle: Speech to Text in 16.9 MB"](https://news.ycombinator.com/item?id=50008427)),
r/LocalLLaMA threads, and independent tests. The HN thread is candid that quality is "meh"
next to bigger models; that matches its intended slot.

---

### 5. Supertonic 3 — best small multilingual TTS

**Repo:** [`Supertone/supertonic-3`](https://huggingface.co/Supertone/supertonic-3)
**License:** OpenRAIL-M
**Size:** ~398 MB ONNX (`vector_estimator` 256.5 MB, `vocoder` 101.4 MB, `text_encoder`
36.4 MB, `duration_predictor` 3.7 MB)
**Languages:** 31, output 44.1 kHz.

Why it matters:

- The HF **Open TTS Leaderboard** (20 Nov 2026) places Supertonic 3 alongside Kokoro and
  Fish s2-pro at the top of English WER for open models, and it is the best small model for
  many languages at once.
- The current TTS tab is English-only except Reverb (7 languages, non-commercial). Supertonic
  would add 31 languages and a much smaller multilingual download than Qwen3-TTS or MOSS.
- It supports simple expression tags (`<laugh>`, `<breath>`, `<sigh>`) and preset voice
  styles.
- Caveat: the installed Transformers.js 4.3.2 `Supertonic` implementation expects the
  Supertonic 2 graph layout (`text_encoder`, `latent_denoiser`, `voice_decoder`), while
  Supertonic 3 ships `text_encoder`, `duration_predictor`, `vector_estimator`, `vocoder`.
  This needs either a newer Transformers.js, a dedicated engine like Reverb, or a small
  adapter.

Community signal: r/LocalLLaMA "Best Audio Models" and "TTS Benchmark Comparison" threads;
the Open TTS Leaderboard; the browser demo at [supertonic3.github.io](https://supertonic3.github.io/).

---

### 6. Kitten TTS 2 Mini — budget multilingual TTS

**Repo:** [`KittenML/kitten-tts-2-mini`](https://huggingface.co/KittenML/kitten-tts-2-mini)
**License:** Apache 2.0
**Size:** 82.7 MB int8 / 47.5 MB int4, 24 kHz
**Coverage:** 16 languages, 118 voices.

Why it matters:

- The Apache-2.0 answer to "multilingual TTS but tiny". English, German, Spanish, Italian,
  Portuguese, Russian, Hindi, French, Danish, Finnish, Japanese, Korean, Dutch, Swedish,
  Swahili, Turkish.
- ONNX graph is simple: `input_ids [1,T] int64`, `style [1,256] float32`, `speed [1] float32`
  → `waveform [N]` plus `durations [T]`.
- The work is the text front-end: English uses a misaki lexicon + CMUdict + a 0.75M BART G2P;
  other languages use eSpeak NG. The project already ships eSpeak NG, so the non-English path
  is mostly wiring. English needs the misaki/BART assets (5–7 MB).
- The pico/nano variants are 8–17 MB per language if a "minimum download" mode is ever wanted.

Community signal: r/LocalLLaMA and r/LocalLLM launch threads, Show HN, and the KittenTTS docs.
Quality is below Kokoro/Supertonic for English narration; the value is coverage per MB.

---

## Vision

### 1. BiRefNet-lite 512 — background removal upgrade

**Repo:** [`studioludens/birefnet-lite-512`](https://huggingface.co/studioludens/birefnet-lite-512)
**License:** MIT
**Size:** 183 MB fp32 / 94 MB fp16 ONNX
**Browser status:** production use at [Repper](https://repper.app); the model card documents
why the 1024×1024 BiRefNet exports OOM in `onnxruntime-web` and why 512×512 fixes it.

Why it matters:

- The current general model is RMBG 1.4 (176 MB, non-commercial). BiRefNet-lite is MIT and
  produces much better hair/edge mattes; the repo says edge quality is indistinguishable from
  the 1024 reference at 512.
- It is a straightforward extension of the existing custom background-removal path:

```js
const model = await AutoModel.from_pretrained('studioludens/birefnet-lite-512', {
  dtype: 'fp16', device: 'webgpu',
});
const processor = await AutoProcessor.from_pretrained('studioludens/birefnet-lite-512');
const { pixel_values } = await processor(image);
const { logits } = await model({ input_image: pixel_values });
// sigmoid, resize, putAlpha
```

- Keep MODNet for portraits and RMBG 1.4 for anyone who wants the old behavior.

Alternative: `onnx-community/MVANet-ONNX` (85 MB q4f16, MIT) works with the dedicated
`background-removal` pipeline, but BiRefNet-lite is the stronger quality story.

Do not add RMBG 3.0: it is a 16 GB generative model that needs a 32 GB GPU.

---

### 2. PP-OCRv6 — a new vision task in 6 MB

**Repos:**
[`PP-OCRv6_tiny_det_onnx`](https://huggingface.co/PaddlePaddle/PP-OCRv6_tiny_det_onnx) (1.8 MB),
[`PP-OCRv6_tiny_rec_onnx`](https://huggingface.co/PaddlePaddle/PP-OCRv6_tiny_rec_onnx) (4.5 MB),
[`PP-OCRv6_small_det_onnx`](https://huggingface.co/PaddlePaddle/PP-OCRv6_small_det_onnx) (9.6 MB),
[`PP-OCRv6_small_rec_onnx`](https://huggingface.co/PaddlePaddle/PP-OCRv6_small_rec_onnx) (20.6 MB)
**License:** Apache 2.0
**Coverage:** the PP-OCRv6 family is announced as 50-language OCR; verify the tiny dictionary
for non-Latin scripts before claiming full coverage. Small is the safer general pick.

Why it matters:

- Tiny is **1.5M parameters** for detection and **7.7M** for recognition, yet Paddle reports
  88.4% printed-English recognition accuracy and **0.35 s/image on an Apple M4 CPU** with
  ONNX Runtime.
- This is a brand-new task for the Vision studio ("Extract text") at a download size smaller
  than most single images. It pairs naturally with the existing image input and the
  copy/download result UI.
- Runs on plain ONNX Runtime Web; no Transformers.js model class is involved. The integration
  is preprocessing (resize/normalize), DB post-processing for detection, CTC decode for
  recognition, and line sorting. The repo ships `inference.json`/`inference.yml` with the
  dictionary and preprocessing parameters.
- Add "OCR" as a vision task with tiny/small variants. Do not try to run the 34.5M medium
  model first; tiny/small are the browser sweet spot.

Community signal: the HF blog
["PP-OCRv6 on Hugging Face: 50-Language OCR from 1.5M to 34.5M"](https://huggingface.co/blog/PaddlePaddle/pp-ocrv6),
r/LocalLLaMA's release thread, and PaddlePaddle's X thread.

---

### 3. D-FINE Nano — detection upgrade

**Repo:** [`onnx-community/dfine-nano-coco-ONNX`](https://huggingface.co/onnx-community/dfine-nano-coco-ONNX)
**License:** Apache 2.0
**Size:** 15.4 MB fp32 / 4.8 MB int8 / 10.9 MB q4
**Accuracy:** 42.8 COCO AP with 4M parameters (D-FINE paper).

Why it matters:

- The current default is YOLOS Tiny (26 MB), a 2021 model. D-FINE Nano is smaller, newer, and
  several AP points stronger.
- It has a native Transformers.js class (`DFineForObjectDetection`) and works with the existing
  `object-detection` pipeline, so it is a catalog swap plus a size/label update.
- Keep DETR ResNet-50 as the "higher recall" option, or replace it with RF-DETR Nano
  (`Roboflow/rf-detr-nano`, 122 MB, Apache 2.0) if the Transformers.js `rf_detr` path is
  wired up. RF-DETR is stronger but larger and slower.

Community signal: r/computervision D-FINE thread; Roboflow's 2026 detector comparison.

---

### 4. Mirage — the 22 MB multi-task vision model

**Repo:** [`Cactus-Compute/mirage`](https://huggingface.co/Cactus-Compute/mirage)
**License:** Apache 2.0
**Size:** **21.6 MB** (`.cact`, 51.3M parameters)
**Capabilities:** scene description, object boxes + attributes, segmentation masks, OCR
(Latin script), spatial relations, and multiple-choice/form decisions in one pass.
**Languages:** English, German, French, Spanish, Italian, Dutch, Polish.

Why it matters:

- It would replace the 958 MB ViT-GPT2 captioner with a 22 MB model that also detects, reads
  text, and segments. On a Galaxy S26 it runs in 74 ms on the NPU / 107 ms on the CPU.
- The same Cactus WASM engine already powers the browser demo, so the runtime exists.
- The catch: there is no high-level JS API for Mirage yet. `cactus-needle` 0.3.0 wraps
  Needle 3 and Whistle only. Integration means calling the raw WASI component
  (`cactus.js` / `cactus.wasm` from Cactus release 4.0.0) or waiting for an official wrapper.
- Quality is "small model" quality: Cactus's own VQA experiment scored 31.3/100 with a
  text-only reader. Treat it as a fast structured-perception layer, not a replacement for a
  real VLM.

Recommendation: fund a one-day spike. If the raw WASM call is manageable, this is the most
differentiating vision addition on the list.

---

### 5. SAM 3 tracker — click-to-segment

**Repo:** [`onnx-community/sam3-tracker-ONNX`](https://huggingface.co/onnx-community/sam3-tracker-ONNX)
**License:** SAM License (royalty-free, commercial use allowed with use restrictions)
**Size:** ~307 MB q4f16 (vision encoder 295.6 MB + prompt/mask decoder 11 MB)
**Runtime:** Transformers.js `Sam3TrackerModel` + `AutoProcessor`.

Why it matters:

- Adds interactive segmentation: click a point or draw a box, get a mask. This is a different
  interaction from the existing category segmentation and is a natural fit for the image
  canvas.
- The q4f16 vision encoder is the size that fits a tab; the FP32 encoder is 1.87 GB and should
  not be offered.
- The model card includes a complete Transformers.js example with `input_points`,
  `input_labels`, `input_boxes`, and `post_process_masks`.

Caveat: the repo has no license tag; cite the Meta SAM License and link it in `NOTICE`.

---

### 6. SmolVLM2-256M — captioning and VQA upgrade

**Repo:** [`HuggingFaceTB/SmolVLM2-256M-Video-Instruct`](https://huggingface.co/HuggingFaceTB/SmolVLM2-256M-Video-Instruct)
**License:** Apache 2.0
**Size:** ~345 MB int8 (decoder 138 MB + vision encoder 94 MB + embeddings 114 MB);
fp16 is ~572 MB.
**Runtime:** Transformers.js `image-text-to-text`.

Why it matters:

- The current captioner is ViT-GPT2 at **958 MB**, a 2022 model with short, generic captions.
  SmolVLM2 is smaller, Apache-2.0, and can answer questions about an image or a short video.
- It is the safe, TJS-native replacement if Mirage's runtime spike fails.
- It is not a state-of-the-art captioner; keep expectations at "useful description and simple
  VQA", not "detailed scene graph".

Alternative: `onnx-community/Florence-2-base` (MIT, ~380 MB int8) is better at detailed
captions, OCR, and phrase grounding, but needs task-prompt plumbing.

---

### 7. Depth Anything 3 Small — depth upgrade with one gap

**Repo:** [`onnx-community/depth-anything-v3-small`](https://huggingface.co/onnx-community/depth-anything-v3-small)
**License:** Apache 2.0
**Size:** 104.7 MB ONNX (external data)
**Base:** [`depth-anything/DA3-SMALL`](https://huggingface.co/depth-anything/DA3-SMALL) (137 MB
safetensors, Apache 2.0).

Why it matters:

- DA3 Small is the Apache-2.0 member of the Depth Anything 3 family (Large/Giant are
  CC BY-NC). It is newer and stronger than the DA2 Small already in the catalog.
- The ONNX repo has `model_type: depth_anything` and a `transformers.js_config`, but **no
  `preprocessor_config.json`** (404 at survey time). Transformers.js 4.3.2's DepthAnything
  class is a thin wrapper, so this needs a custom processor or a repo fix before it can be
  treated as a drop-in.
- If the processor mismatch is resolved, swap DA2 Small for DA3 Small at the same size.

---

## Supporting/infrastructure models

These are small but high-leverage, even though they are not headline model cards.

| Model | Size | License | Use |
| --- | --- | --- | --- |
| [Silero VAD v6.2 ONNX](https://huggingface.co/istupakov/silero-vad-onnx) | 2.3 MB | MIT | Replace/augment the 10 ms energy silence splitter; better cuts in noise, and a speech-probability track for live recording. |
| [Pipecat Voice Reader](https://huggingface.co/pipecat-ai/voice-reader) | 14.2 MB tiny int8 / 28.6 MB base int8 | BSD-2-Clause | Experimental tone/emotion/sarcasm/energy cues for the audio editor. Novel "how did this sound" panel; label as experimental. |
| [WeSpeaker ResNet34](https://huggingface.co/onnx-community/wespeaker-voxceleb-resnet34-LM) | 26.6 MB | CC BY 4.0 | Speaker embeddings for the lighter pyannote diarization path, or for "find the same voice" in history. |
| [Pyannote segmentation 3.0](https://huggingface.co/onnx-community/pyannote-segmentation-3.0) | 5.9 MB | MIT | Two-stage diarization alternative to Nemotron 3. |

---

## Watchlist

| Model | Why it is not in the list yet | Trigger to revisit |
| --- | --- | --- |
| [Moonshine Streaming Tiny multilingual](https://huggingface.co/moonshine-ai/moonshine-streaming-tiny-es) | 27M params, 108 MB fp32, 7 languages, MIT, but **no ONNX export** and no Transformers.js `MoonshineStreaming` class. | An `onnx-community` conversion or upstream TJS support. |
| [Nemotron 3.5 ASR Streaming 0.6B](https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b) | 40 locales, streaming, but 742 MB q8 GGUF and a new RNN-T/CTC pipeline. | A sub-300 MB ONNX export and a streaming UI. |
| [RF-DETR Nano](https://huggingface.co/Roboflow/rf-detr-nano) | 122 MB, Apache 2.0, stronger than D-FINE, but no maintained ONNX export for the TJS `rf_detr` class. | An official ONNX export or `onnx-community` conversion. |
| [Kokoro v1.1-zh ONNX](https://huggingface.co/onnx-community/Kokoro-82M-v1.1-zh-ONNX) | Adds Chinese to the existing Kokoro engine, but the bundled `kokoro-js` path is English-only and needs a Chinese phonemizer. | A Chinese G2P that can run in the existing TTS worker. |
| Demucs / stem separation ONNX | Small community exports exist, but no clear license/quality leader and the models are heavy for a tab. | A well-maintained MIT/Apache 4-stem ONNX export under 200 MB. |
| [Qwen3-ASR 1.7B](https://huggingface.co/Qwen/Qwen3-ASR-1.7B) | Best-in-family accuracy, but 4.7 GB fp32; the 0.6B is already the browser-sized member. | A sub-1 GB int4 sherpa/ONNX export. |

## Suggested rollout

### Sprint 1 — low risk, clear wins

1. **Parakeet Ultra** as a new `fused-tdt` variant. Reuse the Redux path; verify the int4
   encoder on WebGPU and the external-data name handling.
2. **BiRefNet-lite 512** as the new default background remover; keep RMBG 1.4 and MODNet.
3. **D-FINE Nano** as the new default detector; keep DETR ResNet-50.
4. **PP-OCRv6 tiny** as a new "Extract text" vision task.

These are all catalog/UI-level changes with existing inference idioms.

### Sprint 2 — new capabilities

5. **Phonon 31M** as a fifth TTS engine (WASM worker, streaming, Apache 2.0).
6. **Nemotron 3 Diarization** with a "Speakers" toggle on the transcript.
7. **Whistle** as the "Tiny / low-end" ASR preset and live-dictation option.

### Sprint 3 — spike / watch

8. **Mirage** WASM spike; if it works, replace ViT-GPT2 and add detection/OCR/segment from one
   model.
9. **SAM 3 tracker** click-to-segment.
10. **Supertonic 3** if multilingual TTS is a priority; otherwise **Kitten TTS 2 Mini**.
11. **Depth Anything 3 Small** once a processor exists.
12. **Moonshine Streaming Tiny multilingual** if/when an ONNX export appears; it is 27M
    parameters, 108 MB fp32, and seven languages.

---

## In-app model map

The Models page now has an interactive **Quality vs. size** map, built from the same public
leaderboards as the FluidVoice reference chart:

- **Speech to text** — 42 points. Solid points are the Open ASR Leaderboard average WER
  (20 Nov 2026 snapshot); hollow diamonds are publisher-reported averages from the LocalScribe
  catalog and the Parakeet Ultra candidate. The Pareto frontier is computed only from
  leaderboard points.
- **Text to speech** — 22 points from the Open TTS Leaderboard (Seed-TTS English), including
  Kokoro, tiny-voca and Underdog Woof, plus the Supertonic 3 and Phonon 31M candidates.

The chart is a static, offline snapshot (`src/model-chart-data.ts`) and adds no runtime network
requests. Clicking an in-app ASR point selects that model; all points have hover/tap details.
The source stamp links back to the live leaderboard.

Readings worth noting:

- **Fluid Speech Pro** sits on the ASR frontier at 0.63B / 6.06% — #4 among open models on the
  board, and the best accuracy per parameter among the multilingual entries.
- **Kroko ASR XL** at 0.15B / 6.59% is the surprise of the board: tiny, English-only, custom
  license, and almost exactly Rumble-2-Flash's English WER at one-third the parameters.
- **Parakeet Ultra / Redux / Fluid Mini** show better publisher numbers than the leaderboard
  frontier, but they are hollow diamonds because the benchmarks differ. The chart does not
  pretend they are directly comparable.
- **TTS:** Kokoro is 0.76% ER at 80M; **Supertonic 3** is 0.75% at 100M with 31 languages, but
  slightly lower UTMOS (4.45 vs 4.50). **tiny-voca** is excellent for 4.5M. **Underdog Woof**
  is 0.92% at 38M — its value is voice character and licensing, not intelligibility.

There is no equivalent single vision leaderboard, so a vision scatter would mix incompatible
metrics. The next step there is small multiples per task (background-removal MAE, detection AP,
OCR accuracy, depth AbsRel) rather than one shared y-axis.

## Methodology and caveats

- Model lists came from the Hugging Face API (`library=transformers.js`, `library=onnx`,
  pipeline tags, author lists, and search), not from a single "best models" article.
- Sizes were read from the HF file trees (`/tree/main?recursive=true&expand=true`), not from
  rounded marketing copy. They can change when a repo is revised; pin the revisions above.
- Accuracy numbers are the publisher's unless explicitly called independent. The Open ASR
  Leaderboard, Open TTS Leaderboard, and independent blog tests were used where available.
- "Browser fit" means either a published browser demo, an existing Transformers.js class, or
  a plain ONNX graph whose inputs/outputs the project can already handle. It does not mean the
  model has been benchmarked inside LocalScribe.
- The project's 2 GB single-file limit is not a concern for any P0/P1 pick; the largest here
  is Supertonic 3 at ~398 MB and SAM 3 at ~307 MB.
- Licenses were read from the HF model tags and model cards. `NOTICE` needs a new entry for
  every CC BY / OpenRAIL / OpenMDW / SAM-licensed model that ships.

## Sources

Primary model cards and repos are linked inline. Community and secondary sources:

- [Whistle: Speech to Text in 16.9 MB](https://cactuscompute.com/blog/whistle) ·
  [HN discussion](https://news.ycombinator.com/item?id=50008427) ·
  [MarkTechPost test](https://www.marktechpost.com/2026/10/21/cactus-whistle-vs-whisper-base-speech-to-text-benchmark-cpu-guide/)
- [Moondream Parakeet Redux and Ultra](https://moondream.ai/blog/introducing-parakeet-redux-and-ultra) ·
  [Whisper Notes comparison](https://whispernotes.app/blog/parakeet-ultra-vs-parakeet-v3)
- [Parakeet Ultra browser ONNX](https://huggingface.co/ryusei-46/parakeet-ultra-ONNX-WebGPU)
- [Phonon 31M](https://huggingface.co/gradium/phonon-31m-en) ·
  [phonon-tts npm](https://www.npmjs.com/package/phonon-tts)
- [Supertonic 3](https://huggingface.co/Supertone/supertonic-3) ·
  [Open TTS Leaderboard](https://huggingface.co/blog/open-tts-leaderboard)
- [Kitten TTS 2 Mini](https://huggingface.co/KittenML/kitten-tts-2-mini) ·
  [KittenTTS docs](https://github.com/KittenML/KittenTTS/blob/main/docs/kitten-tts-2-tiny.md)
- [Nemotron 3 Diarization](https://huggingface.co/nvidia/Nemotron-3-Diarization) ·
  [ONNX conversion](https://huggingface.co/onnx-community/Nemotron-3-Diarization-ONNX)
- [Mirage](https://cactuscompute.com/blog/mirage) ·
  [Cactus runtime](https://huggingface.co/Cactus-Compute/cactus)
- [PP-OCRv6 blog](https://huggingface.co/blog/PaddlePaddle/pp-ocrv6) ·
  [PP-OCRv6 paper](https://arxiv.org/html/2606.13108v1)
- [D-FINE](https://github.com/Peterande/D-FINE) ·
  [RF-DETR / YOLO26 comparison](https://roboflow.com/blog/best-object-detection-models)
- [BiRefNet-lite 512](https://huggingface.co/studioludens/birefnet-lite-512) ·
  [BiRefNet](https://github.com/zhengpeng7/birefnet)
- [SAM 3 license summary](https://roboflow.com/model-licenses/segment-anything-3)
- [SmolVLM2-256M](https://huggingface.co/HuggingFaceTB/SmolVLM2-256M-Video-Instruct)
- [Depth Anything 3 Small ONNX](https://huggingface.co/onnx-community/depth-anything-v3-small)
- [Silero VAD ONNX](https://huggingface.co/istupakov/silero-vad-onnx)
- [Pipecat Voice Reader](https://huggingface.co/pipecat-ai/voice-reader)
- [RMBG 3.0 self-host requirements](https://docs.bria.ai/self-hosted/rmbg-3)
