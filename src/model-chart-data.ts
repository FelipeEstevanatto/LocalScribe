/**
 * Static snapshot for the in-app model map.
 *
 * Source: Open ASR Leaderboard (version 20-11-2026) and Open TTS Leaderboard
 * (version 20-11-2026), read through their public Gradio APIs on 2026-11-21.
 * The leaderboard values are average WER / average ER over each board's
 * default English evaluation set. Publisher-reported points are clearly marked
 * and are not directly comparable to the leaderboard points.
 *
 * Do not fetch this at runtime: the chart must work offline and must not add
 * network requests to a privacy-first page.
 */

export type ModelChartSource = 'leaderboard' | 'publisher';
export type ModelChartStatus = 'shipping' | 'candidate' | 'other';

export interface ModelChartPoint {
  id: string;
  name: string;
  short: string;
  /** Parameters in billions. */
  paramsB: number;
  /** Average WER (%) for ASR, average error rate (%) for TTS. Lower is better. */
  score: number;
  source: ModelChartSource;
  status: ModelChartStatus;
  catalogModelId?: string;
  downloadMB?: number;
  languages?: number;
  license?: string;
  rtfx?: number;
  utmos?: number;
  note?: string;
  url?: string;
  /** Optional vertical label offset in SVG units, to separate points at the same x. */
  labelOffsetY?: number;
}

export interface ModelChartDataset {
  id: 'asr' | 'tts';
  label: string;
  title: string;
  subtitle: string;
  scoreLabel: string;
  scoreUnit: string;
  yAxisLabel: string;
  xAxisLabel: string;
  sourceLabel: string;
  sourceUrl: string;
  yDomain: [number, number];
  yTicks: number[];
  xTicks: number[];
  points: ModelChartPoint[];
}

export const MODEL_CHART_DATASETS: ModelChartDataset[] = [
  {
    id: 'asr',
    label: 'Speech to text',
    title: 'Accuracy vs. size',
    subtitle:
      'Average word error rate on the Open ASR Leaderboard, 20 November 2026. Lower is better; smaller is left.',
    scoreLabel: 'Average WER',
    scoreUnit: '%',
    yAxisLabel: 'Average WER % · lower is better',
    xAxisLabel: 'Model size · parameters, log scale · ← smaller',
    sourceLabel: 'Open ASR Leaderboard',
    sourceUrl: 'https://huggingface.co/spaces/hf-audio/open_asr_leaderboard',
    yDomain: [4, 14],
    yTicks: [4, 6, 8, 10, 12, 14],
    xTicks: [0.02, 0.05, 0.1, 0.3, 1, 3, 10, 30],
    points: [
    { id: "fluid-pro", name: "Fluid Speech Pro", short: "Fluid Pro", paramsB: 0.63, score: 6.06, source: "leaderboard", status: "shipping", catalogModelId: "fluid-pro", downloadMB: 801, languages: 25, license: "cc-by-4.0", rtfx: 3690.47, note: "The 0.63B multilingual model in this app. Compact variant is 801 MB; Full is 2.67 GB.", url: "https://huggingface.co/FluidVoice-Labs/fluid-speech-pro" },
    { id: "parakeet-v3", name: "Parakeet TDT 0.6B v3", short: "Parakeet v3", paramsB: 0.6, score: 7.04, source: "leaderboard", status: "other", languages: 26, license: "cc-by-4.0", rtfx: 6321.9, note: "The base model behind Parakeet Redux and Ultra.", url: "https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3" },
    { id: "qwen3-0.6b", name: "Qwen3-ASR 0.6B", short: "Qwen 0.6B", paramsB: 0.78, score: 7.07, source: "leaderboard", status: "shipping", catalogModelId: "qwen3-asr-0.6b", downloadMB: 987, languages: 52, license: "apache-2.0", rtfx: 749.52, note: "The 0.6B Qwen3-ASR in this app.", url: "https://huggingface.co/Qwen/Qwen3-ASR-0.6B-hf" },
    { id: "qwen3-1.7b", name: "Qwen3-ASR 1.7B", short: "Qwen 1.7B", paramsB: 2.04, score: 6.15, source: "leaderboard", status: "other", languages: 52, license: "apache-2.0", rtfx: 835.62, note: "Larger sibling of the app's Qwen3-ASR. Better accuracy, but 4.7 GB in FP32.", url: "https://huggingface.co/Qwen/Qwen3-ASR-1.7B-hf" },
    { id: "rumble", name: "Rumble-2-Flash", short: "Rumble", paramsB: 0.51, score: 6.6, source: "leaderboard", status: "shipping", catalogModelId: "rumble-2-flash", downloadMB: 656, languages: 45, license: "apache-2.0", rtfx: 6338.31, note: "The 45-language Qwen3-based model in this app. The leaderboard row evaluates English.", url: "https://huggingface.co/Reson8/Rumble-2-Flash" },
    { id: "granite", name: "Granite Speech 5.0 2B", short: "Granite 5", paramsB: 2.31, score: 6.68, source: "leaderboard", status: "shipping", catalogModelId: "granite-speech-5", downloadMB: 1730, languages: 6, license: "apache-2.0", rtfx: 548.43, note: "The 2B WebGPU-only model in this app.", url: "https://huggingface.co/ibm-granite/granite-speech-5.0-2b" },
    { id: "musci", name: "Musci ASR", short: "Musci", paramsB: 2.04, score: 5.7, source: "leaderboard", status: "other", languages: 52, license: "apache-2.0", rtfx: 774.69, note: "Current leaderboard leader. 52 languages, 2B-class.", url: "https://huggingface.co/Musci-research/Musci-ASR-qwen-1019-hf" },
    { id: "cohere", name: "Cohere Transcribe", short: "Cohere", paramsB: 2, score: 6.72, source: "leaderboard", status: "other", languages: 14, license: "apache-2.0", rtfx: 923.71, note: "2B, 14 languages. q4 export is still 1.5 GB, so not a browser candidate.", url: "https://huggingface.co/CohereLabs/cohere-transcribe-03-2026" },
    { id: "canary-qwen", name: "Canary-Qwen 2.5B", short: "Canary-Qwen", paramsB: 2.5, score: 6.92, source: "leaderboard", status: "other", languages: 1, license: "cc-by-4.0", rtfx: 881.67, note: "English leader on the older leaderboard; 2.5B.", url: "https://huggingface.co/nvidia/canary-qwen-2.5b" },
    { id: "canary-1b", name: "Canary 1B v2", short: "Canary 1B", paramsB: 1, score: 8.43, source: "leaderboard", status: "other", languages: 25, license: "cc-by-4.0", rtfx: 1853.68, note: "25 languages, 1B.", url: "https://huggingface.co/nvidia/canary-1b-v2" },
    { id: "parakeet-v2", name: "Parakeet TDT 0.6B v2", short: "Parakeet v2", paramsB: 0.6, score: 6.93, source: "leaderboard", status: "other", languages: 1, license: "cc-by-4.0", rtfx: 6148.32, note: "English-only predecessor of v3.", url: "https://huggingface.co/nvidia/parakeet-tdt-0.6b-v2" },
    { id: "whisper-turbo", name: "Whisper Large v3 Turbo", short: "Whisper Turbo", paramsB: 0.8, score: 8.75, source: "leaderboard", status: "other", languages: 99, license: "mit", rtfx: 808.92, note: "99 languages, 0.8B, MIT.", url: "https://huggingface.co/openai/whisper-large-v3-turbo" },
    { id: "whisper-v3", name: "Whisper Large v3", short: "Whisper v3", paramsB: 2, score: 8.24, source: "leaderboard", status: "other", languages: 99, license: "apache-2.0", rtfx: 470.74, note: "99 languages, 2B-class.", url: "https://huggingface.co/openai/whisper-large-v3" },
    { id: "voxtral-3b", name: "Voxtral Mini 3B", short: "Voxtral 3B", paramsB: 5, score: 8.32, source: "leaderboard", status: "other", languages: 8, license: "apache-2.0", rtfx: 179.78, note: "8 languages, 3B.", url: "https://huggingface.co/mistralai/Voxtral-Mini-3B-2507" },
    { id: "voxtral-4b", name: "Voxtral Mini 4B Realtime", short: "Voxtral 4B", paramsB: 4, score: 9.72, source: "leaderboard", status: "other", languages: 13, license: "apache-2.0", rtfx: 103.48, note: "Streaming, 13 languages, 4B.", url: "https://huggingface.co/mistralai/Voxtral-Mini-4B-Realtime-2602" },
    { id: "moss", name: "MOSS Transcribe Diarize", short: "MOSS", paramsB: 0.91, score: 6.91, source: "leaderboard", status: "other", languages: 50, license: "apache-2.0", rtfx: 387.46, note: "50 languages plus diarization, 0.91B.", url: "https://huggingface.co/OpenMOSS-Team/MOSS-Transcribe-Diarize" },
    { id: "fun-asr", name: "Fun-ASR Nano", short: "Fun-ASR", paramsB: 0.83, score: 8.54, source: "leaderboard", status: "other", languages: 4, license: "apache-2.0", rtfx: 506.37, note: "Chinese/English/Japanese, 0.83B.", url: "https://huggingface.co/FunAudioLLM/Fun-ASR-Nano-2512-hf" },
    { id: "nemotron-stream", name: "Nemotron Streaming 0.6B", short: "Nemotron Stream", paramsB: 0.62, score: 7.47, source: "leaderboard", status: "other", languages: 1, license: "nvidia-open-model-license", rtfx: 1115.95, note: "English streaming baseline.", url: "https://huggingface.co/nvidia/nemotron-speech-streaming-en-0.6b" },
    { id: "nemotron-35-stream", name: "Nemotron 3.5 ASR Streaming", short: "Nemotron 3.5 Stream", paramsB: 0.64, score: 11.09, source: "leaderboard", status: "other", languages: 40, license: "OpenMDW-1.1", rtfx: 1353.11, note: "40 locales, streaming; 742 MB q8.", url: "https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b" },
    { id: "kroko", name: "Kroko ASR XL", short: "Kroko", paramsB: 0.15, score: 6.59, source: "leaderboard", status: "other", languages: 1, license: "kroko-community-model-license-2.1", rtfx: 27988.46, note: "A 0.15B English model that is remarkably strong for its size.", url: "https://huggingface.co/Banafo/Kroko-ASR-XL-EN-Offline" },
    { id: "thewhisper", name: "TheWhisper Large v3 Turbo", short: "TheWhisper", paramsB: 0.8, score: 6.74, source: "leaderboard", status: "other", languages: 28, license: "cc-by-4.0", rtfx: 1183.92, note: "Optimized 0.8B Whisper Turbo.", url: "https://huggingface.co/TheStageAI/thewhisper-large-v3-turbo" },
    { id: "ark-06", name: "ARK ASR 0.6B", short: "ARK 0.6B", paramsB: 1.15, score: 6.75, source: "leaderboard", status: "other", languages: 19, license: "apache-2.0", rtfx: 664.56, note: "19 languages, 0.6B.", url: "https://huggingface.co/Edge0/ARK-ASR-0.6B" },
    { id: "phonon-25", name: "Phonon-2.5", short: "Phonon 2.5", paramsB: 0.6, score: 7.16, source: "leaderboard", status: "other", languages: 25, license: "cc-by-4.0", rtfx: 1898.26, note: "The newer Phonon family entry on the leaderboard; the app ships Phonon-2.", url: "https://huggingface.co/FermionResearch/Phonon-2.5" },
    { id: "granite-470", name: "Granite 5.0 470M TurboCTC (NC)", short: "Granite 470M", paramsB: 0.47, score: 6.98, source: "leaderboard", status: "other", languages: 1, license: "cc-by-nc-sa-4.0", rtfx: 21082.03, note: "0.47B non-commercial CTC model.", url: "https://huggingface.co/ibm-granite/granite-speech-5.0-470m-turboctc-nc" },
    { id: "owsm", name: "OWSM CTC v4 1B", short: "OWSM", paramsB: 1, score: 9.26, source: "leaderboard", status: "other", languages: 75, license: "cc-by-4.0", rtfx: 783.3, note: "75 languages, 1B CTC.", url: "https://huggingface.co/espnet/owsm_ctc_v4_1B" },
    { id: "audio8", name: "Audio8 ASR 0.1B", short: "Audio8", paramsB: 0.32, score: 9.3, source: "leaderboard", status: "other", languages: 7, license: "apache-2.0", rtfx: 725.78, note: "7 languages, 0.32B.", url: "https://huggingface.co/Edge0/Audio8-ASR-0.1B" },
    { id: "futo", name: "FUTO ASR4All L", short: "FUTO", paramsB: 0.1, score: 9.97, source: "leaderboard", status: "other", languages: 1, license: "futo-model-weights-ethical-use-1.0", rtfx: 20971.29, note: "0.1B English model with a custom ethical-use license.", url: "https://huggingface.co/futo-org/asr4all-l" },
    { id: "niagara", name: "Niagara 84M", short: "Niagara", paramsB: 0.08, score: 10.9, source: "leaderboard", status: "other", languages: 1, license: "applied-brain-research-open-license", rtfx: 1940.83, note: "84M English model with a custom license.", url: "https://huggingface.co/abr-ai/niagara-84m-batch.en" },
    { id: "sov", name: "SOV Transcribe 1", short: "SOV", paramsB: 26.6, score: 5.96, source: "leaderboard", status: "other", languages: 7, license: "apache-2.0", rtfx: 600.92, note: "26.6B, 7 languages.", url: "https://huggingface.co/salesforce-sovereign-intelligence/SOV-Transcribe-1" },
    { id: "hojo", name: "Hojo ASR V1", short: "Hojo", paramsB: 5.18, score: 6.74, source: "leaderboard", status: "other", languages: 2, license: "apache-2.0", rtfx: 73.39, note: "5.18B, 2 languages.", url: "https://huggingface.co/HojoAI/Hojo-ASR-V1" },
    { id: "higgs-stt", name: "Higgs Audio v3 STT", short: "Higgs STT", paramsB: 2.68, score: 6.98, source: "leaderboard", status: "other", languages: 1, license: "apache-2.0", rtfx: 109.65, note: "2.68B English STT.", url: "https://huggingface.co/bosonai/higgs-audio-v3-stt" },
    { id: "luciole", name: "Luciole 8B Audio", short: "Luciole", paramsB: 8.69, score: 8.73, source: "leaderboard", status: "other", languages: 7, license: "apache-2.0", rtfx: 999.2, note: "8.69B French/English audio model.", url: "https://huggingface.co/OpenLLM-France/Luciole-8B-Audio-1.0" },
    { id: "vibevoice", name: "VibeVoice ASR", short: "VibeVoice", paramsB: 8, score: 9.54, source: "leaderboard", status: "other", languages: 50, license: "mit", rtfx: 217.89, note: "8B, 50 languages.", url: "https://huggingface.co/microsoft/VibeVoice-ASR-HF" },
    { id: "zipformer", name: "Zipformer 290M", short: "Zipformer", paramsB: 0.29, score: 8.07, source: "leaderboard", status: "other", languages: 1, license: "cc-by-nc-4.0", rtfx: 22109.49, note: "0.29B non-commercial transducer.", url: "https://huggingface.co/soundsgoodai/Zipformer-cr-ctc-transducer-XL-290M" },
    { id: "granite-41", name: "Granite Speech 4.1 2B", short: "Granite 4.1", paramsB: 2, score: 7.03, source: "leaderboard", status: "other", languages: 6, license: "apache-2.0", rtfx: 546.84, note: "Previous Granite generation.", url: "https://huggingface.co/ibm-granite/granite-speech-4.1-2b" },
    { id: "omniasr-7b", name: "OmniASR 7B LLM", short: "OmniASR 7B", paramsB: 7.81, score: 9.51, source: "leaderboard", status: "other", languages: 1676, license: "apache-2.0", rtfx: 145.14, note: "The 7B LLM member of the OmniASR family. The app ships the 300M CTC model.", url: "https://huggingface.co/hf-audio/omniasr-llm-7b-v2" },
    { id: "fluid-mini", name: "Fluid Speech Mini", short: "Fluid Mini", paramsB: 0.6, score: 4.53, source: "publisher", status: "shipping", catalogModelId: "fluid-mini", downloadMB: 300, languages: 1, license: "CC BY 4.0", note: "FluidVoice, average on 8 English sets. Not the leaderboard mix." },
    { id: "parakeet-redux", name: "Parakeet Redux", short: "Redux", paramsB: 0.6, score: 5.69, source: "publisher", status: "shipping", catalogModelId: "parakeet-redux", downloadMB: 263, languages: 25, license: "CC BY 4.0", note: "Moondream, average on 7 English sets. Ternary encoder.", labelOffsetY: 16 },
    { id: "parakeet-ultra", name: "Parakeet Ultra", short: "Ultra", paramsB: 0.6, score: 5.8, source: "publisher", status: "candidate", downloadMB: 497, languages: 25, license: "CC BY 4.0", note: "Moondream, average on 7 English sets. int4 WebGPU ONNX export." },
    { id: "phonon-2", name: "Phonon-2", short: "Phonon-2", paramsB: 0.6, score: 5.21, source: "publisher", status: "shipping", catalogModelId: "phonon-2", downloadMB: 736, languages: 1, license: "CC BY 4.0", note: "Fermion, average on 7 English sets. English-only." },
    { id: "moonshine-tiny", name: "Moonshine Tiny", short: "Moonshine Tiny", paramsB: 0.027, score: 12.66, source: "publisher", status: "shipping", catalogModelId: "moonshine-tiny", downloadMB: 113, languages: 1, license: "MIT", note: "Moonshine, average on 8 English sets." },
    { id: "moonshine-base", name: "Moonshine Base", short: "Moonshine Base", paramsB: 0.061, score: 10.07, source: "publisher", status: "shipping", catalogModelId: "moonshine-base", downloadMB: 251, languages: 1, license: "MIT", note: "Moonshine, average on 8 English sets." },
    ],
  },
  {
    id: 'tts',
    label: 'Text to speech',
    title: 'Quality vs. size',
    subtitle:
      'Average error rate on the Open TTS Leaderboard (Seed-TTS, English), 20 November 2026. Lower is better; smaller is left.',
    scoreLabel: 'Average ER',
    scoreUnit: '%',
    yAxisLabel: 'Average ER % · lower is better',
    xAxisLabel: 'Model size · parameters, log scale · ← smaller',
    sourceLabel: 'Open TTS Leaderboard',
    sourceUrl: 'https://huggingface.co/spaces/hf-audio/open_tts_leaderboard',
    yDomain: [0.68, 1.05],
    yTicks: [0.7, 0.8, 0.9, 1.0],
    xTicks: [0.001, 0.003, 0.01, 0.03, 0.1, 0.3, 1],
    points: [
    { id: "ming", name: "Ming 3.0 TTS", short: "Ming 3.0", paramsB: 1.48, score: 0.72, source: "leaderboard", status: "other", languages: 7, license: "mit", rtfx: 1.14, utmos: 4.34, note: "0.5B core; 1.48B on the leaderboard including the codec. 7 languages, voice cloning.", url: "https://huggingface.co/inclusionAI/Ming-3.0-tts-0.5B" },
    { id: "omnivoice", name: "OmniVoice", short: "OmniVoice", paramsB: 0.81, score: 0.75, source: "leaderboard", status: "other", languages: 646, license: "cc-by-nc", rtfx: 40.6, utmos: 4.38, note: "0.81B, 646 languages, voice cloning. Non-commercial.", url: "https://huggingface.co/k2-fsa/OmniVoice" },
    { id: "supertonic-3", name: "Supertonic 3", short: "Supertonic 3", paramsB: 0.1, score: 0.75, source: "leaderboard", status: "candidate", downloadMB: 398, languages: 31, license: "Open RAIL-M", rtfx: 45.73, utmos: 4.45, note: "31 languages, ~99M params, 44.1 kHz, OpenRAIL-M.", url: "https://huggingface.co/Supertone/supertonic-3" },
    { id: "kokoro", name: "Kokoro-82M", short: "Kokoro", paramsB: 0.08, score: 0.76, source: "leaderboard", status: "shipping", downloadMB: 88, languages: 8, license: "Apache 2.0", rtfx: 74.27, utmos: 4.5, note: "The app's Kokoro engine. 325 MB FP32, 88 MB Q8.", url: "https://huggingface.co/hexgrad/Kokoro-82M" },
    { id: "inflect-mini", name: "Inflect Mini v3", short: "Inflect Mini", paramsB: 0.0343, score: 0.76, source: "leaderboard", status: "other", languages: 1, license: "apache-2.0", rtfx: 52.36, utmos: 4.48, note: "34.3M, English, Apache 2.0.", url: "https://huggingface.co/owensong/Inflect-Mini-v3" },
    { id: "inflect-micro", name: "Inflect Micro v3", short: "Inflect Micro", paramsB: 0.0118, score: 0.79, source: "leaderboard", status: "other", languages: 1, license: "apache-2.0", rtfx: 66.5, utmos: 4.35, note: "11.8M, English, Apache 2.0.", url: "https://huggingface.co/owensong/Inflect-Micro-v3" },
    { id: "magpie", name: "Magpie TTS 357M", short: "Magpie", paramsB: 0.31, score: 0.79, source: "leaderboard", status: "other", languages: 9, license: "custom", rtfx: 14.98, utmos: 4.46, note: "0.31B, 9 languages.", url: "https://huggingface.co/nvidia/magpie_tts_multilingual_357m" },
    { id: "fish-s2", name: "Fish S2 Pro", short: "Fish S2", paramsB: 4.95, score: 0.78, source: "leaderboard", status: "other", languages: 83, license: "custom", rtfx: 0.4, utmos: 4.44, note: "4.95B, 83 languages, voice cloning.", url: "https://huggingface.co/fishaudio/s2-pro" },
    { id: "audio8-tts", name: "Audio8 TTS 0.6B", short: "Audio8 TTS", paramsB: 0.94, score: 0.81, source: "leaderboard", status: "other", languages: 23, license: "apache-2.0", rtfx: 11.63, utmos: 4.43, note: "0.94B, 23 languages, voice cloning.", url: "https://huggingface.co/Edge0/Audio8-TTS-Realistic-0.6b" },
    { id: "phonon-31m", name: "Phonon 31M", short: "Phonon 31M", paramsB: 0.0411, score: 0.82, source: "leaderboard", status: "candidate", downloadMB: 65, languages: 1, license: "Apache 2.0", rtfx: 3.87, utmos: 4.45, note: "31M core plus the Mimi codec; 41.1M on the leaderboard. English, 24 kHz streaming.", url: "https://huggingface.co/gradium/phonon-31m-en" },
    { id: "tiny-voca", name: "tiny-voca (F2)", short: "tiny-voca", paramsB: 0.0045, score: 0.83, source: "leaderboard", status: "shipping", downloadMB: 21, languages: 1, license: "apache-2.0", rtfx: 54.93, utmos: 4.42, note: "The app's bundled 4.5M English voice. 21 MB, Apache 2.0.", url: "https://huggingface.co/n4ze3m/tiny-voca" },
    { id: "paradee", name: "Paradee 8M", short: "Paradee", paramsB: 0.008, score: 0.83, source: "leaderboard", status: "other", languages: 4, license: "apache-2.0", rtfx: 41.77, utmos: 4.37, note: "8M, 4 languages, Apache 2.0.", url: "https://huggingface.co/sahilmahendrakar/Paradee-8M-v1.3" },
    { id: "pivo", name: "PiVo 1.4M", short: "PiVo", paramsB: 0.0014, score: 0.83, source: "leaderboard", status: "other", languages: 1, license: "apache-2.0", rtfx: 12.04, utmos: 4.33, note: "1.4M, English, Apache 2.0.", url: "https://huggingface.co/empero-ai/PiVo-1.4M" },
    { id: "phonon-40m", name: "Phonon 40M (NC)", short: "Phonon 40M", paramsB: 0.0505, score: 0.85, source: "leaderboard", status: "other", languages: 1, license: "CC-BY-NC-4.0", rtfx: 2.93, utmos: 4.45, note: "40M, English, CC BY-NC 4.0.", url: "https://huggingface.co/gradium/phonon-40m-en" },
    { id: "pocket", name: "Pocket TTS", short: "Pocket", paramsB: 0.1, score: 0.85, source: "leaderboard", status: "other", languages: 6, license: "cc-by-4.0", rtfx: 9.09, utmos: 4.33, note: "0.1B, 6 languages, CC BY 4.0.", url: "https://huggingface.co/kyutai/pocket-tts" },
    { id: "cosyvoice3", name: "CosyVoice3 0.5B", short: "CosyVoice3", paramsB: 0.11, score: 0.88, source: "leaderboard", status: "other", languages: 9, license: "cc-by-4.0", rtfx: 2.94, utmos: 4.29, note: "0.11B, 9 languages, voice cloning.", url: "https://huggingface.co/FunAudioLLM/Fun-CosyVoice3-0.5B-2512" },
    { id: "auk", name: "AuK", short: "AuK", paramsB: 1.53, score: 0.88, source: "leaderboard", status: "other", languages: 2, license: "mit", rtfx: 6.07, utmos: 4.26, note: "1.53B, 2 languages, MIT.", url: "https://huggingface.co/tencent/AuK" },
    { id: "steer-edge", name: "Steer TTS Edge (NC)", short: "Steer Edge", paramsB: 0.0155, score: 0.9, source: "leaderboard", status: "other", languages: 1, license: "cc-by-nc-4.0", rtfx: 86.3, utmos: 4.3, note: "15.5M, English, CC BY-NC 4.0.", url: "https://huggingface.co/WhissleAI/steer-tts-edge" },
    { id: "woof", name: "Underdog Woof", short: "Woof", paramsB: 0.038, score: 0.92, source: "leaderboard", status: "shipping", downloadMB: 41, languages: 1, license: "Underdog NC 1.0", rtfx: 13.94, utmos: 4.44, note: "The app's 38M English voice. Non-commercial; two voices.", url: "https://huggingface.co/ConwayResearch/Underdog-Woof" },
    { id: "qwen3-tts", name: "Qwen3-TTS 1.7B", short: "Qwen3-TTS", paramsB: 1.92, score: 0.94, source: "leaderboard", status: "other", languages: 10, license: "Apache 2.0", rtfx: 13.45, utmos: 4.41, note: "1.7B core; 1.92B on the leaderboard including the codec. 10 languages.", url: "https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice" },
    { id: "chatterbox", name: "Chatterbox", short: "Chatterbox", paramsB: 0.8, score: 1, source: "leaderboard", status: "other", license: "mit", rtfx: 1.99, utmos: 4.4, note: "0.8B, voice cloning, MIT.", url: "https://huggingface.co/ResembleAI/chatterbox" },
    { id: "lfm25", name: "LFM2.5 Audio 1.5B", short: "LFM2.5", paramsB: 1.53, score: 1, source: "leaderboard", status: "other", languages: 1, license: "custom", rtfx: 1.78, utmos: 4.33, note: "1.53B, English, custom license.", url: "https://huggingface.co/LiquidAI/LFM2.5-Audio-1.5B" },
    ],
  },
];
