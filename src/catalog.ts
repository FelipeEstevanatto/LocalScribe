/**
 * Model catalog for LocalScribe.
 *
 * Every supported entry below is an ONNX export with a real browser-loadable
 * runtime path. Keep "research" entries out of the download/inference flow:
 * they document models that are interesting but need a different runtime or
 * are not speech-to-text at all.
 */

import {
  CACTUS_SCRIPT_BYTES,
  CACTUS_SCRIPT_URL,
  CACTUS_WASM_BYTES,
  CACTUS_WASM_URL,
  WHISTLE_BYTES,
  WHISTLE_LANGUAGES,
  WHISTLE_URL,
} from './cactus';

export type ModelId =
  | 'fluid-mini'
  | 'moonshine-tiny'
  | 'moonshine-base'
  | 'whisper-tiny-timestamped'
  | 'whisper-tiny-en'
  | 'whisper-base-timestamped'
  | 'whisper-small-timestamped'
  | 'fluid-pro'
  | 'parakeet-redux'
  | 'parakeet-ultra'
  | 'phonon-2.5'
  | 'rumble-2-flash'
  | 'qwen3-asr-0.6b'
  | 'qwen3-asr-1.7b'
  | 'omnilingual-300m'
  | 'granite-speech-5'
  | 'whistle';

export type ModelPipeline =
  | 'fused-tdt'
  | 'projected-tdt'
  | 'fluid-mini-tdt'
  | 'qwen3-asr'
  | 'qwen3-asr-webgpu'
  | 'moonshine'
  | 'whisper'
  | 'omnilingual'
  | 'granite-speech'
  | 'cactus';

const WHISPER_LANGUAGES = [
  'Afrikaans', 'Albanian', 'Amharic', 'Arabic', 'Armenian', 'Assamese', 'Azerbaijani',
  'Bashkir', 'Basque', 'Belarusian', 'Bengali', 'Bosnian', 'Breton', 'Bulgarian',
  'Catalan', 'Chinese', 'Croatian', 'Czech', 'Danish', 'Dutch', 'English', 'Estonian',
  'Faroese', 'Finnish', 'French', 'Galician', 'Georgian', 'German', 'Greek', 'Gujarati',
  'Haitian Creole', 'Hausa', 'Hawaiian', 'Hebrew', 'Hindi', 'Hungarian', 'Icelandic',
  'Indonesian', 'Italian', 'Japanese', 'Javanese', 'Kannada', 'Kazakh', 'Khmer', 'Korean',
  'Lao', 'Latin', 'Latvian', 'Lingala', 'Lithuanian', 'Luxembourgish', 'Macedonian',
  'Malagasy', 'Malay', 'Malayalam', 'Maltese', 'Maori', 'Marathi', 'Mongolian', 'Myanmar',
  'Nepali', 'Norwegian', 'Nynorsk', 'Occitan', 'Pashto', 'Persian', 'Polish', 'Portuguese',
  'Punjabi', 'Romanian', 'Russian', 'Sanskrit', 'Serbian', 'Shona', 'Sindhi', 'Sinhala',
  'Slovak', 'Slovenian', 'Somali', 'Spanish', 'Sundanese', 'Swahili', 'Swedish', 'Tagalog',
  'Tajik', 'Tamil', 'Tatar', 'Telugu', 'Thai', 'Tibetan', 'Turkish', 'Turkmen', 'Ukrainian',
  'Urdu', 'Uzbek', 'Vietnamese', 'Welsh', 'Yiddish', 'Yoruba',
];

export type ModelFileRole =
  | 'encoderGraph'
  | 'encoderData'
  | 'frontend'
  | 'convFrontend'
  | 'preprocessorGraph'
  | 'decoderGraph'
  | 'decoderData'
  | 'jointGraph'
  | 'vocab'
  | 'tokenizer'
  | 'tokenizerVocab'
  | 'tokenizerMerges'
  | 'tokenizerConfig'
  | 'preprocessor'
  | 'processor'
  | 'generationConfig'
  | 'chatTemplate'
  | 'audioEncoder'
  | 'audioEncoderData'
  | 'embedTokens'
  | 'embedTokensData'
  | 'config'
  | 'cactusModel'
  | 'cactusScript'
  | 'cactusWasm';

export interface ModelFileSeed {
  role: ModelFileRole;
  name: string;
  size: number;
  /** Absolute URL for files outside the model repository. */
  url?: string;
}

export interface ModelVariant {
  id: string;
  label: string;
  approxBytes: number;
  note: string;
  files: (clean: boolean) => ModelFileSeed[];
  /** Download from a different export than the model's default repository. */
  repo?: string;
  revision?: string;
}

export interface SupportedModel {
  id: ModelId;
  name: string;
  family: string;
  pipeline: ModelPipeline;
  repo: string;
  revision: string;
  description: string;
  languages: string;
  /** Exact language names, not just the count. */
  languagesDetail: string[];
  dialects?: string[];
  /** Optional prompt language names for models that accept a forced language. */
  languageOptions?: string[];
  timestamps?: 'segment' | 'word';
  languageCount: number;
  wer: string;
  release: string;
  license: string;
  licenseUrl: string;
  cleanMode: boolean;
  recommended?: boolean;
  /** Short, job-shaped label shown on the model card. */
  bestFor: string;
  /**
   * Run on WASM unless the user picks WebGPU. Set where the CPU build is the
   * faster default (fluid-mini: 39 s vs 53 s for 5 min on an RTX 3060 Ti; its
   * TDT decode loop is many small kernels).
   */
  preferCpu?: boolean;
  requiresWebGPU?: 'standard' | 'shader-f16';
  /** Audio is split near this many seconds before inference. Default 30. */
  chunkSeconds?: number;
  defaultVariant: string;
  variants: ModelVariant[];
}

export interface ResolvedModelFile extends ModelFileSeed {
  url: string;
}

export type ResearchStatus = 'research' | 'wrong-task' | 'upcoming';

export interface ResearchModel {
  id: string;
  name: string;
  status: ResearchStatus;
  reason: string;
  url: string;
  size?: string;
  release?: string;
  license?: string;
  tags: string[];
}

const PRO_REPO = 'FluidVoice-Labs/fluid-speech-pro-onnx';
const PRO_REVISION = 'fa588e9f87f1b9ad0ca2e2d8f7eaf84dc3803581';

const MINI_REPO = 'FluidVoice-Labs/fluid-speech-mini-onnx';
const MINI_REVISION = 'fc592620325027419883cf272e70588d8a788c0a';

const MOONSHINE_TINY_REPO = 'onnx-community/moonshine-tiny-ONNX';
const MOONSHINE_TINY_REVISION = 'a6da1241cd305dcd64eab1edbd615f2bb9aabb95';
const MOONSHINE_BASE_REPO = 'onnx-community/moonshine-base-ONNX';
const MOONSHINE_BASE_REVISION = 'b1e9b6aae3c3c7298f10c3798393fdf38e8fbbad';

const OMNILINGUAL_REPO = 'OpenVoiceOS/omnilingual-asr-ctc-300m-onnx';
const OMNILINGUAL_REVISION = 'bc55e1de19af8a907b0a010d06fc4637a2d5bf0c';

const REDUX_REPO = 'Olicorne/parakeet-tdt-0.6b-v3-redux-onnx';
const REDUX_REVISION = 'de66c10f18f6d94cb3e910e48034e45ce51109bc';

// Same exporter and file layout as Redux; vocab.txt is byte-identical.
const ULTRA_REPO = 'Olicorne/parakeet-tdt-0.6b-v3-ultra-onnx';
const ULTRA_REVISION = 'db1fd7a2d89672e8e52383505f0149076faab6f7';
// int4 MatMulNBits encoder with external weights, built for ONNX Runtime WebGPU.
const ULTRA_WEBGPU_REPO = 'ryusei-46/parakeet-ultra-ONNX-WebGPU';
const ULTRA_WEBGPU_REVISION = '9c2bb9be4df050e495f0765470fff9335d8a3bd0';

const RUMBLE_REPO = 'TypeWhisper/Rumble-2-Flash-sherpa-onnx-int8';
const RUMBLE_REVISION = 'a8128305e8e8c4aa5bf6fcd0a8454347ff80d6d1';

const QWEN_REPO = 'csukuangfj2/sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25';
const QWEN_REVISION = '68818b2313fe77bd06f6a7c5068ff3ef59d02b8a';
const QWEN_WEBGPU_REPO = 'subtitleking/qwen3-asr-1.7b-onnx';
const QWEN_WEBGPU_REVISION = 'c777781bb694c71f85a422df5b4850bc141667fa';

const GRANITE_REPO = 'ibm-granite/granite-speech-5.0-2b-ONNX';
const GRANITE_REVISION = 'a9cf1d13d045d65813b4bc80bde8fdd62db4c35c';

const PHONON_REPO = 'enriqueag/phonon-2.5-onnx';
const PHONON_REVISION = '5a76001bd8dfc058632290d2ef594236b7ca2bd4';

const EUROPEAN_25 = [
  'Bulgarian',
  'Croatian',
  'Czech',
  'Danish',
  'Dutch',
  'English',
  'Estonian',
  'Finnish',
  'French',
  'German',
  'Greek',
  'Hungarian',
  'Italian',
  'Latvian',
  'Lithuanian',
  'Maltese',
  'Polish',
  'Portuguese',
  'Romanian',
  'Russian',
  'Slovak',
  'Slovenian',
  'Spanish',
  'Swedish',
  'Ukrainian',
];

const RUMBLE_45 = [
  'Afrikaans',
  'Albanian',
  'Arabic',
  'Basque',
  'Bengali',
  'Bosnian',
  'Cantonese',
  'Catalan',
  'Cebuano',
  'Chinese (Mandarin)',
  'Croatian',
  'Czech',
  'Danish',
  'Dutch',
  'English',
  'Filipino',
  'Finnish',
  'French',
  'German',
  'Greek',
  'Hindi',
  'Hungarian',
  'Icelandic',
  'Indonesian',
  'Italian',
  'Japanese',
  'Korean',
  'Latvian',
  'Lithuanian',
  'Macedonian',
  'Malay',
  'Maltese',
  'Norwegian Bokmål',
  'Persian',
  'Polish',
  'Portuguese',
  'Romanian',
  'Russian',
  'Serbian',
  'Spanish',
  'Swedish',
  'Thai',
  'Turkish',
  'Ukrainian',
  'Vietnamese',
];

const QWEN_30 = [
  'Chinese (Mandarin)',
  'English',
  'Cantonese',
  'Arabic',
  'German',
  'French',
  'Spanish',
  'Portuguese',
  'Indonesian',
  'Italian',
  'Korean',
  'Russian',
  'Thai',
  'Vietnamese',
  'Japanese',
  'Turkish',
  'Hindi',
  'Malay',
  'Dutch',
  'Swedish',
  'Danish',
  'Finnish',
  'Polish',
  'Czech',
  'Filipino',
  'Persian',
  'Greek',
  'Hungarian',
  'Macedonian',
  'Romanian',
];

const QWEN_DIALECTS = [
  'Anhui',
  'Dongbei',
  'Fujian',
  'Gansu',
  'Guizhou',
  'Hebei',
  'Henan',
  'Hubei',
  'Hunan',
  'Jiangxi',
  'Ningxia',
  'Shandong',
  'Shaanxi',
  'Shanxi',
  'Sichuan',
  'Tianjin',
  'Yunnan',
  'Zhejiang',
  'Cantonese (Hong Kong)',
  'Cantonese (Guangdong)',
  'Wu',
  'Minnan',
];

const PRO_COMPACT_FILES = (clean: boolean): ModelFileSeed[] => [
  {
    role: 'encoderGraph',
    name: clean ? 'encoder-model.clean.int8.onnx' : 'encoder-model.int8.onnx',
    size: clean ? 1_293_960 : 955_592,
  },
  { role: 'encoderData', name: 'encoder-model.int8.onnx.data', size: 745_971_712 },
  {
    role: 'decoderGraph',
    name: clean ? 'decoder_joint-model.clean.int8.onnx' : 'decoder_joint-model.int8.onnx',
    size: 8_590,
  },
  { role: 'decoderData', name: 'decoder_joint-model.int8.onnx.data', size: 53_800_000 },
  { role: 'vocab', name: 'vocab.txt', size: 93_939 },
  { role: 'config', name: 'config.json', size: 98 },
];

const PRO_FULL_FILES = (clean: boolean): ModelFileSeed[] => [
  {
    role: 'encoderGraph',
    name: clean ? 'encoder-model.clean.onnx' : 'encoder-model.onnx',
    size: clean ? 1_107_603 : 895_723,
  },
  { role: 'encoderData', name: 'encoder-model.onnx.data', size: 2_594_971_648 },
  {
    role: 'decoderGraph',
    name: clean ? 'decoder_joint-model.clean.onnx' : 'decoder_joint-model.onnx',
    size: clean ? 7_810 : 7_806,
  },
  { role: 'decoderData', name: 'decoder_joint-model.onnx.data', size: 72_548_352 },
  { role: 'vocab', name: 'vocab.txt', size: 93_939 },
  { role: 'config', name: 'config.json', size: 98 },
];

const MINI_FILES = (): ModelFileSeed[] => [
  { role: 'encoderGraph', name: 'encoder.onnx', size: 426_102 },
  { role: 'encoderData', name: 'encoder.onnx.data', size: 253_429_760 },
  { role: 'frontend', name: 'frontend.onnx', size: 8_697_130 },
  { role: 'decoderGraph', name: 'decoder.onnx', size: 24_461_296 },
  { role: 'jointGraph', name: 'joint.onnx', size: 11_840_320 },
  { role: 'tokenizer', name: 'tokenizer.json', size: 1_159_959 },
  { role: 'config', name: 'config.json', size: 508 },
];

const MOONSHINE_FILES = (base: boolean): ModelFileSeed[] => [
  { role: 'config', name: 'config.json', size: base ? 922 : 921 },
  { role: 'generationConfig', name: 'generation_config.json', size: 147 },
  { role: 'preprocessor', name: 'preprocessor_config.json', size: 128 },
  { role: 'tokenizer', name: 'tokenizer.json', size: 3_761_754 },
  { role: 'tokenizerConfig', name: 'tokenizer_config.json', size: 135_735 },
  {
    role: 'encoderGraph',
    name: 'onnx/encoder_model_quantized.onnx',
    size: base ? 20_513_063 : 7_937_661,
  },
  {
    role: 'decoderGraph',
    name: 'onnx/decoder_model_merged_quantized.onnx',
    size: base ? 42_498_870 : 20_243_286,
  },
];

const OMNILINGUAL_FILES = (): ModelFileSeed[] => [
  { role: 'encoderGraph', name: 'model.int8.onnx', size: 328_094_283 },
  { role: 'vocab', name: 'tokens.txt', size: 90_630 },
  { role: 'config', name: 'config.json', size: 89 },
];

const REDUX_FILES = (): ModelFileSeed[] => [
  { role: 'encoderGraph', name: 'w2a8/encoder-model.w2a8.onnx', size: 189_893_007 },
  { role: 'decoderGraph', name: 'int8/decoder_joint-model.int8.onnx', size: 18_203_490 },
  { role: 'vocab', name: 'vocab.txt', size: 93_939 },
  { role: 'config', name: 'config.json', size: 97 },
];

const REDUX_FULL_DECODER_FILES = (): ModelFileSeed[] => [
  ...REDUX_FILES().filter((file) => file.role !== 'decoderGraph'),
  { role: 'decoderGraph', name: 'fp32/decoder_joint-model.onnx', size: 9_296 },
  { role: 'decoderData', name: 'fp32/decoder_joint-model.onnx.data', size: 72_514_072 },
];

const ULTRA_SHARED = (): ModelFileSeed[] => [
  { role: 'vocab', name: 'vocab.txt', size: 93_939 },
  { role: 'config', name: 'config.json', size: 97 },
];

const ULTRA_W4A8_FILES = (): ModelFileSeed[] => [
  { role: 'encoderGraph', name: 'w4a8/encoder-model.w4a8.onnx', size: 383_355_483 },
  { role: 'decoderGraph', name: 'int8/decoder_joint-model.int8.onnx', size: 18_203_490 },
  ...ULTRA_SHARED(),
];

const ULTRA_FULL_DECODER_FILES = (): ModelFileSeed[] => [
  { role: 'encoderGraph', name: 'w4a8/encoder-model.w4a8.onnx', size: 383_355_483 },
  { role: 'decoderGraph', name: 'fp32/decoder_joint-model.onnx', size: 9_296 },
  { role: 'decoderData', name: 'fp32/decoder_joint-model.onnx.data', size: 72_514_072 },
  ...ULTRA_SHARED(),
];

const ULTRA_WEBGPU_FILES = (): ModelFileSeed[] => [
  { role: 'encoderGraph', name: 'int4/encoder.onnx', size: 536_722 },
  { role: 'encoderData', name: 'int4/encoder.onnx.data', size: 423_788_544 },
  { role: 'decoderGraph', name: 'fp32/decoder_joint.onnx', size: 72_525_795 },
  { role: 'vocab', name: 'vocab.txt', size: 93_939 },
  { role: 'config', name: 'config.json', size: 110 },
];

const PHONON_FILES = (): ModelFileSeed[] => [
  { role: 'encoderGraph', name: 'encoder.exact2x2.onnx', size: 362_728_506 },
  { role: 'decoderGraph', name: 'decoder_joint.int8.onnx', size: 17_644_009 },
  { role: 'vocab', name: 'vocab.txt', size: 93_928 },
  { role: 'config', name: 'config.json', size: 1_265 },
];

const RUMBLE_FILES = (): ModelFileSeed[] => [
  { role: 'convFrontend', name: 'conv_frontend.onnx', size: 44_148_280 },
  { role: 'encoderGraph', name: 'encoder.int8.onnx', size: 182_491_662 },
  { role: 'decoderGraph', name: 'decoder.int8.onnx', size: 426_507_858 },
  { role: 'tokenizerVocab', name: 'tokenizer/vocab.json', size: 1_961_918 },
  { role: 'tokenizerMerges', name: 'tokenizer/merges.txt', size: 1_075_910 },
  {
    role: 'tokenizerConfig',
    name: 'tokenizer/tokenizer_config.json',
    size: 13_585,
  },
];

const QWEN_FILES = (): ModelFileSeed[] => [
  { role: 'convFrontend', name: 'conv_frontend.onnx', size: 44_148_281 },
  { role: 'encoderGraph', name: 'encoder.int8.onnx', size: 182_491_662 },
  { role: 'decoderGraph', name: 'decoder.int8.onnx', size: 755_914_231 },
  { role: 'tokenizerVocab', name: 'tokenizer/vocab.json', size: 2_776_833 },
  { role: 'tokenizerMerges', name: 'tokenizer/merges.txt', size: 1_671_853 },
  {
    role: 'tokenizerConfig',
    name: 'tokenizer/tokenizer_config.json',
    size: 12_487,
  },
];

const QWEN_WEBGPU_FILES = (): ModelFileSeed[] => [
  { role: 'encoderGraph', name: 'onnx/audio_encoder_fp16.onnx', size: 108_938 },
  { role: 'encoderData', name: 'onnx/audio_encoder_fp16.onnx_data', size: 634_978_752 },
  { role: 'embedTokens', name: 'onnx/embed_tokens_q4.onnx', size: 675 },
  { role: 'embedTokensData', name: 'onnx/embed_tokens_q4.onnx_data', size: 194_478_080 },
  { role: 'decoderGraph', name: 'onnx/decoder_model_merged_q4.onnx', size: 189_661 },
  { role: 'decoderData', name: 'onnx/decoder_model_merged_q4.onnx_data', size: 1_084_137_472 },
  { role: 'tokenizerVocab', name: 'vocab.json', size: 2_776_833 },
  { role: 'tokenizerMerges', name: 'merges.txt', size: 1_671_853 },
  { role: 'tokenizerConfig', name: 'tokenizer_config.json', size: 12_487 },
  { role: 'preprocessor', name: 'preprocessor_config.json', size: 356 },
];

const GRANITE_FILES = (): ModelFileSeed[] => [
  { role: 'config', name: 'config.json', size: 2_589 },
  { role: 'generationConfig', name: 'generation_config.json', size: 234 },
  { role: 'preprocessor', name: 'preprocessor_config.json', size: 335 },
  { role: 'processor', name: 'processor_config.json', size: 415 },
  { role: 'tokenizer', name: 'tokenizer.json', size: 4_131_268 },
  { role: 'tokenizerConfig', name: 'tokenizer_config.json', size: 675 },
  {
    role: 'audioEncoder',
    name: 'onnx/audio_encoder_q4.onnx',
    size: 349_494,
  },
  {
    role: 'audioEncoderData',
    name: 'onnx/audio_encoder_q4.onnx_data',
    size: 658_277_008,
  },
  {
    role: 'embedTokens',
    name: 'onnx/embed_tokens_q4f16.onnx',
    size: 1_064,
  },
  {
    role: 'embedTokensData',
    name: 'onnx/embed_tokens_q4f16.onnx_data',
    size: 118_817_952,
  },
  {
    role: 'decoderGraph',
    name: 'onnx/decoder_model_merged_q4f16.onnx',
    size: 437_192,
  },
  {
    role: 'decoderData',
    name: 'onnx/decoder_model_merged_q4f16.onnx_data',
    size: 947_786_912,
  },
];

function transformerVariants(
  q8Files: ModelFileSeed[],
  encoderBytes: number,
  decoderBytes: number,
): ModelVariant[] {
  const fp32Files = q8Files.map((file) => {
    if (file.role === 'encoderGraph') {
      return { ...file, name: 'onnx/encoder_model.onnx', size: encoderBytes };
    }
    if (file.role === 'decoderGraph') {
      return { ...file, name: 'onnx/decoder_model_merged.onnx', size: decoderBytes };
    }
    return file;
  });
  return (['fp32', 'q8'] as const).map((id) => {
    const files = id === 'fp32' ? fp32Files : q8Files;
    const approxBytes = files.reduce((sum, file) => sum + file.size, 0);
    return {
      id,
      approxBytes,
      label: `${id === 'fp32' ? 'Highest quality · FP32' : 'Smaller download · Q8'} · ~${Math.round(approxBytes / 1_000_000)} MB`,
      note: id === 'fp32'
        ? 'Full-precision encoder and decoder on CPU/WASM.'
        : 'Smaller quantized encoder and decoder on CPU/WASM.',
      files: () => files,
    };
  });
}

function whisperTimestamped(
  size: 'tiny' | 'base' | 'small',
  revision: string,
  encoderBytes: number,
  decoderBytes: number,
  fp32EncoderBytes: number,
  fp32DecoderBytes: number,
): SupportedModel {
  const title = size[0].toUpperCase() + size.slice(1);
  const files = whisperFiles(encoderBytes, decoderBytes);
  return {
    id: `whisper-${size}-timestamped`,
    name: `Whisper ${title} · Word timestamps`,
    family: 'Whisper · Transformers.js',
    pipeline: 'whisper',
    repo: `onnx-community/whisper-${size}_timestamped`,
    revision,
    description: `The multilingual Whisper ${title} export with estimated start and end times for each word.`,
    languages: 'Multilingual · auto-detect',
    languagesDetail: WHISPER_LANGUAGES,
    languageOptions: WHISPER_LANGUAGES,
    languageCount: WHISPER_LANGUAGES.length,
    timestamps: 'word',
    wer: 'Benchmark locally to compare model variants.',
    release: '2022-09-21',
    license: 'Apache 2.0 (base model)',
    licenseUrl: `https://huggingface.co/openai/whisper-${size}`,
    cleanMode: false,
    bestFor: 'Multilingual transcription with word timing',
    chunkSeconds: 25,
    defaultVariant: 'fp32',
    variants: transformerVariants(files, fp32EncoderBytes, fp32DecoderBytes),
  };
}

function whisperFiles(encoderBytes: number, decoderBytes: number): ModelFileSeed[] {
  return [
    { role: 'config', name: 'config.json', size: 2_300 },
    { role: 'preprocessor', name: 'preprocessor_config.json', size: 339 },
    { role: 'generationConfig', name: 'generation_config.json', size: 3_800 },
    { role: 'tokenizer', name: 'tokenizer.json', size: 2_480_000 },
    { role: 'tokenizerConfig', name: 'tokenizer_config.json', size: 283_000 },
    { role: 'encoderGraph', name: 'onnx/encoder_model_quantized.onnx', size: encoderBytes },
    { role: 'decoderGraph', name: 'onnx/decoder_model_merged_quantized.onnx', size: decoderBytes },
  ];
}

export const STUDIO_WHISPER_MODEL_ID = 'whisper-tiny-en';
export const STUDIO_WHISPER_VARIANT_ID = 'fp32-q8';
const tinyEnglishFiles = whisperFiles(10_124_993, 30_718_858);
const [tinyEnglishFull, tinyEnglishCompact] = transformerVariants(tinyEnglishFiles, 32_904_992, 118_552_291);
const tinyEnglishHybridFiles = tinyEnglishFull.files(false).map((file) =>
  file.role === 'decoderGraph'
    ? { ...file, name: 'onnx/decoder_model_merged_quantized.onnx', size: 30_718_858 }
    : file,
);

export const SUPPORTED_MODELS: SupportedModel[] = [
  {
    id: 'fluid-mini',
    name: 'Fluid Speech Mini',
    family: 'Parakeet TDT · split frontend/encoder/decoder/joint',
    pipeline: 'fluid-mini-tdt',
    preferCpu: true,
    repo: MINI_REPO,
    revision: MINI_REVISION,
    description:
      'A ~300 MB English dictation model from FluidVoice. It matches Parakeet-level accuracy on the public English test sets and is trained to ignore another voice in the room.',
    languages: 'English',
    languagesDetail: ['English'],
    languageCount: 1,
    wer: '4.53% average on 8 public English sets (self-reported)',
    release: '2026-10-13',
    license: 'CC BY 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    cleanMode: false,
    recommended: true,
    bestFor: 'English dictation',
    defaultVariant: 'default',
    variants: [
      {
        id: 'default',
        label: 'English · 300 MB',
        approxBytes: 300_015_075,
        note:
          'Fast, small, and very accurate for English. The weights are packed at 2/4 bits and stay packed in memory.',
        files: MINI_FILES,
      },
    ],
  },
  {
    id: 'moonshine-tiny',
    name: 'Moonshine Tiny',
    family: 'Moonshine · 27M · Transformers.js',
    pipeline: 'moonshine',
    repo: MOONSHINE_TINY_REPO,
    revision: MOONSHINE_TINY_REVISION,
    description:
      'A 27M-parameter English model built for short voice notes and live transcription on constrained hardware. The q8 ONNX export is about 32 MB, making it the smallest option here.',
    languages: 'English',
    languagesDetail: ['English'],
    languageCount: 1,
    wer: '12.66% average on 8 English sets (Moonshine)',
    release: '2024-10-22',
    license: 'MIT',
    licenseUrl: 'https://opensource.org/license/mit',
    cleanMode: false,
    bestFor: 'Quick voice notes',
    defaultVariant: 'fp32',
    variants: transformerVariants(MOONSHINE_FILES(false), 30_882_331, 78_227_550),
  },
  {
    id: 'moonshine-base',
    name: 'Moonshine Base',
    family: 'Moonshine · 58M · Transformers.js',
    pipeline: 'moonshine',
    repo: MOONSHINE_BASE_REPO,
    revision: MOONSHINE_BASE_REVISION,
    description:
      'The larger 58M-parameter Moonshine English model. It doubles the download to about 66 MB and improves accuracy while keeping the same short-audio design.',
    languages: 'English',
    languagesDetail: ['English'],
    languageCount: 1,
    wer: '10.07% average on 8 English sets (Moonshine)',
    release: '2024-10-22',
    license: 'MIT',
    licenseUrl: 'https://opensource.org/license/mit',
    cleanMode: false,
    bestFor: 'Short clips, more accuracy',
    defaultVariant: 'fp32',
    variants: transformerVariants(MOONSHINE_FILES(true), 80_818_781, 166_211_345),
  },
  {
    id: 'whistle',
    name: 'Whistle',
    family: 'Cactus · 17 MB · WebAssembly',
    pipeline: 'cactus',
    repo: 'Cactus-Compute/whistle',
    revision: '88cb00eeb8928ddbcd410b491584f938ba030b07',
    description:
      'Cactus Compute’s 16.9 MB speech model with word timestamps in seven European languages. It runs on a 1.3 MB WebAssembly engine without WebGPU, so it loads in seconds on almost any device.',
    languages: '7 languages',
    languagesDetail: Object.keys(WHISTLE_LANGUAGES),
    languageOptions: Object.keys(WHISTLE_LANGUAGES),
    languageCount: 7,
    timestamps: 'word',
    wer: 'Not published on the model card',
    release: '2026-09-30',
    license: 'Apache 2.0',
    licenseUrl: 'https://huggingface.co/Cactus-Compute/whistle/blob/main/LICENSE',
    cleanMode: false,
    bestFor: 'Tiny download, any device',
    defaultVariant: 'cq4',
    variants: [
      {
        id: 'cq4',
        label: 'Whistle · 4-bit',
        approxBytes: WHISTLE_BYTES + CACTUS_SCRIPT_BYTES + CACTUS_WASM_BYTES,
        note: 'The only build. Includes the Cactus WebAssembly runtime.',
        files: () => [
          { role: 'cactusModel', name: 'whistle.cact', size: WHISTLE_BYTES, url: WHISTLE_URL },
          { role: 'cactusScript', name: 'cactus.js', size: CACTUS_SCRIPT_BYTES, url: CACTUS_SCRIPT_URL },
          { role: 'cactusWasm', name: 'cactus.wasm', size: CACTUS_WASM_BYTES, url: CACTUS_WASM_URL },
        ],
      },
    ],
  },
  whisperTimestamped('tiny', '517244293732ee2d58139af5814231b7e6830a0d', 10_100_000, 30_700_000, 32_894_434, 118_664_208),
  {
    id: STUDIO_WHISPER_MODEL_ID,
    name: 'Whisper Tiny English',
    family: 'Whisper · Transformers.js',
    pipeline: 'whisper',
    repo: 'onnx-community/whisper-tiny.en',
    revision: '794207fec2761281fe63a23a94b7e9f53a4efbc1',
    description: 'English-only Whisper Tiny. The hybrid CPU option uses the same encoder and decoder precisions as WebGPU.Studio’s WASM preset.',
    languages: 'English',
    languagesDetail: ['English'],
    languageCount: 1,
    timestamps: 'segment',
    wer: 'Compare against the bundled reference in Settings.',
    release: '2022-09-21',
    license: 'Apache 2.0 (base model)',
    licenseUrl: 'https://huggingface.co/openai/whisper-tiny.en',
    cleanMode: false,
    bestFor: 'English clips and reproducible comparison',
    chunkSeconds: 25,
    defaultVariant: 'fp32',
    variants: [
      tinyEnglishFull,
      {
        id: STUDIO_WHISPER_VARIANT_ID,
        label: 'WebGPU.Studio CPU preset · FP32 encoder / Q8 decoder · ~66 MB',
        approxBytes: tinyEnglishHybridFiles.reduce((bytes, file) => bytes + file.size, 0),
        note: 'Full-precision encoder and smaller decoder on CPU/WASM.',
        files: () => tinyEnglishHybridFiles,
      },
      tinyEnglishCompact,
    ],
  },
  whisperTimestamped('base', '608c49e61301901684bc36cac8f74b95ff6b5a8e', 23_200_000, 53_700_000, 82_451_730, 208_686_733),
  whisperTimestamped('small', '65caa70f294b46e1c33ff820aae6b16d048ab818', 92_300_000, 157_000_000, 352_791_798, 615_656_199),
  {
    id: 'fluid-pro',
    name: 'Fluid Speech Pro',
    family: 'FastConformer-TDT · multilingual',
    pipeline: 'fused-tdt',
    repo: PRO_REPO,
    revision: PRO_REVISION,
    description:
      'The original 25-language Fluid Speech Pro model, with optional clean mode. Compact is CPU-friendly; full precision is for desktop WebGPU.',
    languages: '25 European languages',
    languagesDetail: EUROPEAN_25,
    languageCount: 25,
    wer: '6.06 average WER on the Open ASR Leaderboard (model card)',
    release: '2026-11-13',
    license: 'CC BY 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    cleanMode: true,
    bestFor: 'Multilingual meetings',
    defaultVariant: 'compact',
    variants: [
      {
        id: 'compact',
        label: 'Compact · int8 · 801 MB',
        approxBytes: 800_829_931,
        note:
          'Best compatibility. The int8 export is optimized for CPU ONNX Runtime; the encoder still tries WebGPU first.',
        files: PRO_COMPACT_FILES,
      },
      {
        id: 'full',
        label: 'Full precision · fp32 · 2.67 GB',
        approxBytes: 2_668_517_566,
        note:
          'Not loadable in Chromium: its 2.59 GB encoder data file exceeds the roughly 2 GB single ArrayBuffer limit. Use Compact; full precision only works in runtimes that can memory-map the weights.',
        files: PRO_FULL_FILES,
      },
    ],
  },
  {
    id: 'parakeet-redux',
    name: 'Parakeet Redux',
    family: 'Parakeet TDT · ternary encoder',
    pipeline: 'fused-tdt',
    repo: REDUX_REPO,
    revision: REDUX_REVISION,
    description:
      'Moondream’s ternary Parakeet TDT recognizer covers 25 languages. The 2-bit encoder stores its ternary weights losslessly. Choose an FP32 or INT8 decoder.',
    languages: '25 European languages',
    languagesDetail: EUROPEAN_25,
    languageCount: 25,
    wer: '5.69% average WER on 7 English sets (Moondream)',
    release: '2026-09-26',
    license: 'CC BY 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    cleanMode: false,
    bestFor: 'Smallest multilingual',
    defaultVariant: 'fp32-decoder',
    variants: [
      {
        id: 'fp32-decoder',
        label: 'Highest quality · FP32 decoder · 263 MB',
        approxBytes: 262_510_353,
        note: 'Full-precision decoder with the same packed ternary encoder.',
        files: REDUX_FULL_DECODER_FILES,
      },
      {
        id: 'w2a8',
        label: '2-bit encoder + int8 decoder · 208 MB',
        approxBytes: 208_190_533,
        note:
          'The smallest multilingual option. The encoder stores ternary weights packed as 2-bit MatMulNBits; WebGPU is attempted, with WASM fallback.',
        files: REDUX_FILES,
      },
    ],
  },
  {
    id: 'parakeet-ultra',
    name: 'Parakeet Ultra',
    family: 'Parakeet TDT · 0.6B · 4-bit encoder',
    pipeline: 'fused-tdt',
    repo: ULTRA_REPO,
    revision: ULTRA_REVISION,
    description:
      'Moondream’s full-precision sibling of Redux. Same 25 languages, lower error everywhere, and noticeably better on long recordings and noisy audio.',
    languages: '25 European languages',
    languagesDetail: EUROPEAN_25,
    languageCount: 25,
    wer: '5.80% average WER on 7 English sets, 9.55% on 25-language FLEURS (Moondream; Redux: 6.26% / 11.62%)',
    release: '2026-09-22',
    license: 'CC BY 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    cleanMode: false,
    bestFor: 'Best multilingual accuracy under 500 MB',
    defaultVariant: 'w4a8',
    variants: [
      {
        id: 'w4a8',
        label: '4-bit encoder + int8 decoder · 402 MB',
        approxBytes: 401_653_009,
        note: 'The same exporter and layout as Redux, with a 4-bit MatMulNBits encoder. WebGPU is attempted, with WASM fallback.',
        files: ULTRA_W4A8_FILES,
      },
      {
        id: 'fp32-decoder',
        label: '4-bit encoder + FP32 decoder · 456 MB',
        approxBytes: 455_972_887,
        note: 'Full-precision decoder with the same 4-bit encoder.',
        files: ULTRA_FULL_DECODER_FILES,
      },
      {
        id: 'webgpu-int4',
        label: 'WebGPU int4 build · 497 MB',
        approxBytes: 496_945_110,
        note: 'A separate int4 export tuned for ONNX Runtime WebGPU, with an FP32 decoder. Best on a capable GPU.',
        files: ULTRA_WEBGPU_FILES,
        repo: ULTRA_WEBGPU_REPO,
        revision: ULTRA_WEBGPU_REVISION,
      },
    ],
  },
  {
    id: 'phonon-2.5',
    name: 'Phonon-2.5',
    family: 'Phonon TDT · 2-bit encoder · ONNX',
    pipeline: 'projected-tdt',
    repo: PHONON_REPO,
    revision: PHONON_REVISION,
    description:
      'Fermion Research’s compact recognizer for 25 European languages, with automatic language detection and word timestamps.',
    languages: '25 European languages',
    languagesDetail: EUROPEAN_25,
    languageCount: 25,
    timestamps: 'word',
    wer: '5.06% average WER on 7 English sets (Fermion)',
    release: '2026-10-22',
    license: 'CC BY 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    cleanMode: false,
    chunkSeconds: 25,
    bestFor: 'Compact multilingual transcription',
    defaultVariant: 'exact2x2',
    variants: [
      {
        id: 'exact2x2',
        label: '2-bit encoder + INT8 decoder · 380 MB',
        approxBytes: 380_467_708,
        note: 'WebGPU accelerates the encoder. CPU inference is available.',
        files: PHONON_FILES,
      },
    ],
  },
  {
    id: 'rumble-2-flash',
    name: 'Rumble-2-Flash',
    family: 'Qwen3-ASR · 0.5B · KV-cache decoder',
    pipeline: 'qwen3-asr',
    repo: RUMBLE_REPO,
    revision: RUMBLE_REVISION,
    description:
      'Reson8’s 0.5B Qwen3-ASR model, released November 2026. It handles 45 languages with automatic language detection, number formatting, and optional verbatim output, and is tuned for real phone-call audio.',
    languages: '45 languages, detected automatically',
    languagesDetail: RUMBLE_45,
    languageOptions: RUMBLE_45.map((name) =>
      name === 'Chinese (Mandarin)' ? 'Chinese' : name,
    ),
    languageCount: 45,
    wer: '6.60 average English WER on 9 public and private sets (Reson8)',
    release: '2026-11-18',
    license: 'Apache 2.0',
    licenseUrl: 'https://www.apache.org/licenses/LICENSE-2.0',
    cleanMode: false,
    chunkSeconds: 15,
    bestFor: 'Phone audio, 45 languages',
    defaultVariant: 'int8',
    variants: [
      {
        id: 'int8',
        label: 'int8 · 656 MB',
        approxBytes: 656_199_213,
        note:
          'A community sherpa-onnx int8 conversion. The audio encoder tries WebGPU; the KV-cache decoder runs on CPU because it is int8-quantized and needs exact cache control.',
        files: RUMBLE_FILES,
      },
    ],
  },
  {
    id: 'qwen3-asr-0.6b',
    name: 'Qwen3-ASR 0.6B',
    family: 'Qwen3-ASR · 0.6B · KV-cache decoder',
    pipeline: 'qwen3-asr',
    repo: QWEN_REPO,
    revision: QWEN_REVISION,
    description:
      'Alibaba’s official 0.6B Qwen3-ASR model in a sherpa-onnx int8 export. It recognizes 30 languages plus 22 Chinese dialects, including singing voice and songs with background music.',
    languages: '30 languages + 22 Chinese dialects',
    languagesDetail: QWEN_30,
    dialects: QWEN_DIALECTS,
    languageOptions: QWEN_30.map((name) =>
      name === 'Chinese (Mandarin)' ? 'Chinese' : name,
    ),
    languageCount: 30,
    wer: '2.11% / 4.55% WER on LibriSpeech clean / other (Qwen)',
    release: '2026-01-28',
    license: 'Apache 2.0',
    licenseUrl: 'https://www.apache.org/licenses/LICENSE-2.0',
    cleanMode: false,
    chunkSeconds: 15,
    bestFor: 'Asian languages and songs',
    defaultVariant: 'int8',
    variants: [
      {
        id: 'int8',
        label: 'int8 · 987 MB',
        approxBytes: 987_015_347,
        note:
          'The larger Qwen3 decoder is slower than Rumble but covers Chinese dialects and singing. The encoder tries WebGPU; the KV-cache decoder runs on CPU.',
        files: QWEN_FILES,
      },
    ],
  },
  {
    id: 'qwen3-asr-1.7b',
    name: 'Qwen3-ASR 1.7B Preview',
    family: 'Qwen3-ASR · 1.7B · WebGPU',
    pipeline: 'qwen3-asr-webgpu',
    repo: QWEN_WEBGPU_REPO,
    revision: QWEN_WEBGPU_REVISION,
    description: 'A larger Qwen3-ASR model with better results on Brazilian Portuguese and Mandarin in our browser benchmark.',
    languages: '30 languages + 22 Chinese dialects',
    languagesDetail: QWEN_30,
    dialects: QWEN_DIALECTS,
    languageOptions: QWEN_30.map((name) => name === 'Chinese (Mandarin)' ? 'Chinese' : name),
    languageCount: QWEN_30.length,
    wer: '4.3% WER on 22 Brazilian Portuguese clips (LocalScribe)',
    release: '2026-01-28',
    license: 'Apache 2.0',
    licenseUrl: 'https://www.apache.org/licenses/LICENSE-2.0',
    cleanMode: false,
    chunkSeconds: 15,
    requiresWebGPU: 'shader-f16',
    bestFor: 'Brazilian Portuguese and Mandarin',
    defaultVariant: 'q4',
    variants: [
      {
        id: 'q4',
        label: 'FP16 encoder + 4-bit decoder · 1.92 GB',
        approxBytes: 1_918_355_107,
        note: 'The encoder and decoder run on WebGPU.',
        files: QWEN_WEBGPU_FILES,
      },
    ],
  },
  {
    id: 'omnilingual-300m',
    name: 'Omnilingual ASR 300M',
    family: 'OmniASR CTC · 300M · 1,600+ languages',
    pipeline: 'omnilingual',
    repo: OMNILINGUAL_REPO,
    revision: OMNILINGUAL_REVISION,
    description:
      'Meta’s 300M multilingual CTC model, packaged for ONNX Runtime. It covers more than 1,600 languages, including hundreds with no other open ASR model, and takes raw 16 kHz audio without a separate feature frontend.',
    languages: '1,600+ languages',
    languagesDetail: ['1,600+ languages (see the model card)'],
    languageCount: 1600,
    wer: 'Meta: character error rate below 10 for 78% of 1,600+ languages',
    release: '2025-11-10',
    license: 'Apache 2.0',
    licenseUrl: 'https://www.apache.org/licenses/LICENSE-2.0',
    cleanMode: false,
    chunkSeconds: 30,
    bestFor: 'Long-tail languages',
    defaultVariant: 'fp32',
    variants: [
      {
        id: 'fp32',
        label: 'Highest quality · FP32 CTC · 1.30 GB',
        approxBytes: 1_304_670_682,
        note: 'Full-precision CPU model. Requires substantially more storage and memory than INT8.',
        files: () => [
          { role: 'encoderGraph', name: 'model.onnx', size: 1_304_579_963 },
          ...OMNILINGUAL_FILES().filter((file) => file.role !== 'encoderGraph'),
        ],
      },
      {
        id: 'int8',
        label: 'int8 CTC · 328 MB',
        approxBytes: 328_185_002,
        note:
          'Best for long-tail languages. Audio should stay under 40 seconds per pass; the app splits at 30 seconds. Output has no punctuation or capitalization.',
        files: OMNILINGUAL_FILES,
      },
    ],
  },
  {
    id: 'granite-speech-5',
    name: 'Granite Speech 5.0 2B',
    family: 'Granite Speech · 2B · Transformers.js',
    pipeline: 'granite-speech',
    requiresWebGPU: 'standard',
    repo: GRANITE_REPO,
    revision: GRANITE_REVISION,
    description:
      'IBM’s 2B speech-language model, packaged for Transformers.js. It transcribes English, French, German, Spanish, Portuguese, and Japanese with punctuation, and can also translate speech to English.',
    languages: '6 languages + English translation',
    languagesDetail: [
      'English',
      'French',
      'German',
      'Spanish',
      'Portuguese',
      'Japanese',
    ],
    languageCount: 6,
    wer: '2.43% WER (2.31% normalized) on the 73-utterance LibriSpeech dummy set (4-bit ONNX)',
    release: '2026-10-29',
    license: 'Apache 2.0',
    licenseUrl: 'https://www.apache.org/licenses/LICENSE-2.0',
    cleanMode: false,
    chunkSeconds: 30,
    bestFor: 'Punctuation and translation',
    defaultVariant: 'q4f16',
    variants: [
      {
        id: 'q4f16',
        label: '4-bit + fp16 · 1.73 GB',
        approxBytes: 1_729_805_138,
        note:
          'Requires WebGPU: the 4-bit embedding uses GatherBlockQuantized, which has no CPU kernel. Transformers.js manages this model’s own cache and downloads, so it appears as one entry here; the runtime and model weights stay in the browser.',
        files: GRANITE_FILES,
      },
    ],
  },
];

export const RESEARCH_MODELS: ResearchModel[] = [
  {
    id: 'fluid-pico',
    name: 'Fluid Speech Pico',
    status: 'upcoming',
    reason:
      'Announced as a 159 MB English model with 4.64% WER, but the weights are not released yet.',
    url: 'https://fluidvoice.com/labs',
    size: '159 MB (announced)',
    release: 'coming soon',
    license: 'CC BY 4.0 (expected)',
    tags: ['English', 'Not released'],
  },
  {
    id: 'moss-transcribe-diarize',
    name: 'MOSS-Transcribe-Diarize 0.9B',
    status: 'research',
    reason: 'The INT4 prototype matched the current diarizer on six speaker turns and generated text on silence.',
    url: 'https://huggingface.co/moonbox-dev/MOSS-Transcribe-Diarize-ONNX',
    size: '745 MB INT4',
    release: '2026-11-26',
    license: 'Apache 2.0',
    tags: ['Speaker labels', 'Segment timestamps'],
  },
  {
    id: 'oruk-fourier-2b',
    name: 'Oruk Fourier 2B',
    status: 'research',
    reason: 'The INT8 model exceeds the model picker’s 2 GB limit and scored 41.2% WER on four noisy English clips in our native CPU test.',
    url: 'https://huggingface.co/oruk/oruk-fourier-2b',
    size: '2.41 GB INT8',
    release: '2026-11-25',
    license: 'CC BY-NC 4.0',
    tags: ['English'],
  },
];

export function modelBaseUrl(model: SupportedModel): string {
  return `https://huggingface.co/${model.repo}/resolve/${model.revision}/`;
}

export function hfUrl(model: SupportedModel, fileName: string): string {
  return `${modelBaseUrl(model)}${fileName}`;
}

export function findModel(modelId: string | null): SupportedModel | undefined {
  const id = modelId === 'phonon-2' ? 'phonon-2.5' : modelId;
  return SUPPORTED_MODELS.find((entry) => entry.id === id);
}

export function getModel(modelId: ModelId): SupportedModel {
  const model = findModel(modelId);
  if (!model) {
    throw new Error(`Unknown model: ${modelId}`);
  }
  return model;
}

export function getVariant(model: SupportedModel, variantId: string): ModelVariant {
  const variant =
    model.variants.find((entry) => entry.id === variantId) ??
    model.variants.find((entry) => entry.id === model.defaultVariant) ??
    model.variants[0];

  if (!variant) {
    throw new Error(`Model ${model.id} has no variants.`);
  }
  return variant;
}

export function resolveModelFiles(
  modelId: ModelId,
  variantId: string,
  clean: boolean,
): ResolvedModelFile[] {
  const model = getModel(modelId);
  const variant = getVariant(model, variantId);
  const effectiveClean = model.cleanMode ? clean : false;

  const source = variant.repo
    ? { ...model, repo: variant.repo, revision: variant.revision ?? 'main' }
    : model;
  return variant.files(effectiveClean).map((file) => ({
    ...file,
    url: file.url ?? hfUrl(source, file.name),
  }));
}

export function defaultSelection(): { modelId: ModelId; variantId: string } {
  const model = SUPPORTED_MODELS.find((entry) => entry.recommended) ?? SUPPORTED_MODELS[0];
  return { modelId: model.id, variantId: model.defaultVariant };
}
