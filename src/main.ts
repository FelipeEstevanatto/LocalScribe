import './style.css';
import {
  TARGET_SAMPLE_RATE,
  computePeaks,
  decodeAudioFile,
  MEDIA_ACCEPT,
  VIDEO_ACCEPT,
  formatBytes,
  formatDuration,
  isSupportedFile,
  splitAtSilence,
  type DecodedAudio,
} from './audio';
import {
  RESEARCH_MODELS,
  SUPPORTED_MODELS,
  STUDIO_WHISPER_MODEL_ID,
  STUDIO_WHISPER_VARIANT_ID,
  defaultSelection,
  getModel,
  getVariant,
  type ModelId,
  type ModelVariant,
  type SupportedModel,
} from './catalog';
import { AppError, errorMessage as describeError, isAbortError } from './errors';
import { AsrClient } from './asr-client';
import { setupAppLocale } from './app-locale';
import { setupI18n, translateUi } from './i18n';
import type { setupAudioStudio } from './audio-studio';
import type { setupVideoMerge } from './video-merge';
import type { setupDocumentStudio } from './document-studio';
import type { setupConverterStudio } from './converter-studio';
import type { setupRecordStudio } from './recorder-studio';
import { listVideoProjects } from './video-projects';
import type { setupQuickTools } from './quick-tools';
import { TransferMeter, WorkMeter } from './transfer';
import type { SpeakerLine } from './diarization';
import { PhononPlugin, SupertonicPlugin, type TtsPlugin } from './tts-plugins';
import { isEnglishOnlyEngine, prepareSpeechText } from './tts-text';
import { setupJobTray, type JobHandle } from './jobs';
import { renderEngineStorage, setupOpenMenu, setupShortcutSheet, showTipFor } from './app-ux';
import { sharedFfmpeg } from './audio-ffmpeg';
import { SAMPLE_TRANSCRIPT, wordErrorRate } from './benchmark';
import { openWaveSource, planWaveChunks, summarizeWave, type WaveSource } from './wave-source';
import type { WordTiming } from './transformers-asr';
import { buildExport, EXPORT_FORMATS, realignSegments, type ExportFormat } from './exports';
import { modelFit, prefersCompactModel, readDeviceProfile, type DeviceProfile } from './capabilities';
import { JOB_PRESETS, type JobPreset } from './presets';
import { MicrophoneRecorder } from './recorder';
import { polishTranscript } from './postprocess';
import {
  clearHistory,
  deleteHistory,
  deleteHistoryDatabase,
  getHistory,
  isHistoryEnabled,
  listHistory,
  newHistoryId,
  saveHistory,
  setHistoryEnabled,
  type HistoryEntry,
} from './history';
import {
  KOKORO_VOICES,
  KokoroEngine,
  TTS_FORMATS,
  TinyVocaEngine,
  convertTtsResult,
  ttsResultFromSamples,
  type TtsFormat,
  type TtsOutput,
  type TtsResult,
  type PhonemizerMode,
  type KokoroMode,
} from './tts';
import type { RawImage } from '@huggingface/transformers';
import { WOOF_LICENSE, WOOF_VOICES, WoofTtsEngine, type WoofProgress } from './woof-tts';
import {
  VISION_TASKS,
  getVisionModel,
  getVisionTask,
  isVisionModelLoaded,
  preloadVisionModel,
  runVision,
  type VisionDevice,
  type VisionProgress,
  type VisionPrecision,
  type SelectPoint,
  type VisionResult,
  type VisionTaskId,
} from './vision';
import {
  REVERB_LANGUAGES,
  REVERB_LICENSE,
  ReverbEngine,
  type ReverbProgress,
  type ReverbVoice,
} from './reverb';
import {
  clearModelCache,
  clearOtherCachedModel,
  listOtherCachedModels,
  type OtherCachedModel,
  clearModelCacheFor,
  detectWebGPU,
  getModelCacheStatus,
  getModelCacheStatuses,
  getStorageInfo,
  requestPersistence,
  type Backend,
  type CacheStatus,
  type WebGpuStatus,
} from './model';

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing required element #${id}`);
  return element as T;
}

const els = {
  webgpuBadge: byId<HTMLSpanElement>('webgpu-badge'),
  backendBadge: byId<HTMLSpanElement>('backend-badge'),
  variantCount: byId<HTMLSpanElement>('variant-count'),

  trySampleInline: byId<HTMLButtonElement>('try-sample-inline'),
  recordBtn: byId<HTMLButtonElement>('record-btn'),
  recordPanel: byId<HTMLDivElement>('record-panel'),
  recordStop: byId<HTMLButtonElement>('record-stop'),
  recordCancel: byId<HTMLButtonElement>('record-cancel'),
  recordTime: byId<HTMLSpanElement>('record-time'),
  recordLevel: byId<HTMLDivElement>('record-level'),
  queueAdd: byId<HTMLButtonElement>('queue-add'),
  queueInput: byId<HTMLInputElement>('queue-input'),
  queuePanel: byId<HTMLDivElement>('queue-panel'),
  queueCount: byId<HTMLSpanElement>('queue-count'),
  queueList: byId<HTMLDivElement>('queue-list'),
  queueStart: byId<HTMLButtonElement>('queue-start'),
  queueCancel: byId<HTMLButtonElement>('queue-cancel'),
  queueStatus: byId<HTMLParagraphElement>('queue-status'),
  queueClear: byId<HTMLButtonElement>('queue-clear'),
  queueModel: byId<HTMLElement>('queue-model'),
  queueConfig: byId<HTMLElement>('queue-config'),
  queueSettingsChange: byId<HTMLButtonElement>('queue-settings-change'),
  queueSection: byId<HTMLElement>('transcribe-queue'),

  sessionStrip: byId<HTMLDivElement>('session-strip'),
  sessionModel: byId<HTMLSpanElement>('session-model'),
  sessionDetail: byId<HTMLSpanElement>('session-detail'),
  sessionFit: byId<HTMLSpanElement>('session-fit'),
  sessionCache: byId<HTMLSpanElement>('session-cache'),
  sessionStatusDot: byId<HTMLSpanElement>('session-status-dot'),
  sessionStatus: byId<HTMLSpanElement>('session-status'),
  sessionModelSelect: byId<HTMLSelectElement>('session-model-select'),
  sessionVariantSelect: byId<HTMLSelectElement>('session-variant-select'),
  sessionProgress: byId<HTMLDivElement>('session-progress'),
  sessionProgressLabel: byId<HTMLSpanElement>('session-progress-label'),
  sessionProgressDetail: byId<HTMLSpanElement>('session-progress-detail'),
  sessionProgressBar: byId<HTMLDivElement>('session-progress-bar'),
  sessionCancel: byId<HTMLButtonElement>('session-cancel'),
  deviceWebgpu: byId<HTMLButtonElement>('device-webgpu'),
  deviceCpu: byId<HTMLButtonElement>('device-cpu'),
  sessionPreload: byId<HTMLButtonElement>('session-preload'),


  presetRow: byId<HTMLDivElement>('preset-row'),
  forceCpu: byId<HTMLInputElement>('force-cpu'),
  benchmarkBtn: byId<HTMLButtonElement>('benchmark-btn'),
  benchmarkStatus: byId<HTMLSpanElement>('benchmark-status'),
  benchmarkResult: byId<HTMLDivElement>('benchmark-result'),
  benchmarkReference: byId<HTMLInputElement>('benchmark-reference'),
  benchmarkCancel: byId<HTMLButtonElement>('benchmark-cancel'),
  receiptRun: byId<HTMLButtonElement>('receipt-run'),
  receiptClear: byId<HTMLButtonElement>('receipt-clear'),
  receiptStatus: byId<HTMLParagraphElement>('receipt-status'),
  receiptResult: byId<HTMLDivElement>('receipt-result'),

  viewHome: byId<HTMLDivElement>('view-home'),
  viewTranscribe: byId<HTMLDivElement>('view-transcribe'),
  viewTts: byId<HTMLDivElement>('view-tts'),
  viewAudio: byId<HTMLDivElement>('view-audio'),
  viewVideo: byId<HTMLDivElement>('view-video'),
  viewVision: byId<HTMLDivElement>('view-vision'),
  viewTools: byId<HTMLDivElement>('view-tools'),
  viewDocuments: byId<HTMLDivElement>('view-documents'),
  viewConverter: byId<HTMLDivElement>('view-converter'),
  viewRecord: byId<HTMLDivElement>('view-record'),
  visionTaskGrid: byId<HTMLDivElement>('vision-task-grid'),
  visionActiveTool: byId<HTMLHeadingElement>('vision-active-tool'),
  visionTaskDescription: byId<HTMLParagraphElement>('vision-task-description'),
  visionInput: byId<HTMLInputElement>('vision-input'),
  visionDrop: byId<HTMLButtonElement>('vision-drop'),
  visionFileName: byId<HTMLParagraphElement>('vision-file-name'),
  visionPreview: byId<HTMLImageElement>('vision-preview'),
  visionPreviewEmpty: byId<HTMLSpanElement>('vision-preview-empty'),
  visionModel: byId<HTMLSelectElement>('vision-model'),
  visionDevice: byId<HTMLSelectElement>('vision-device'),
  visionPrecision: byId<HTMLSelectElement>('vision-precision'),
  visionThresholdField: byId<HTMLLabelElement>('vision-threshold-field'),
  visionThreshold: byId<HTMLInputElement>('vision-threshold'),
  visionThresholdValue: byId<HTMLSpanElement>('vision-threshold-value'),
  visionRun: byId<HTMLButtonElement>('vision-run'),
  visionLoad: byId<HTMLButtonElement>('vision-load'),
  visionProgress: byId<HTMLDivElement>('vision-progress'),
  visionProgressLabel: byId<HTMLParagraphElement>('vision-progress-label'),
  visionProgressDetail: byId<HTMLSpanElement>('vision-progress-detail'),
  visionProgressBar: byId<HTMLDivElement>('vision-progress-bar'),
  visionStatus: byId<HTMLParagraphElement>('vision-status'),
  visionCanvas: byId<HTMLCanvasElement>('vision-canvas'),
  visionComparison: byId<HTMLDivElement>('vision-comparison'),
  visionOriginal: byId<HTMLImageElement>('vision-original'),
  visionComparisonSlider: byId<HTMLInputElement>('vision-comparison-slider'),
  visionResultEmpty: byId<HTMLSpanElement>('vision-result-empty'),
  visionSummary: byId<HTMLParagraphElement>('vision-summary'),
  visionLegend: byId<HTMLDivElement>('vision-legend'),
  visionCaption: byId<HTMLParagraphElement>('vision-caption'),
  visionDownload: byId<HTMLAnchorElement>('vision-download'),
  visionModelNote: byId<HTMLParagraphElement>('vision-model-note'),
  visionModelLink: byId<HTMLAnchorElement>('vision-model-link'),
  viewHistory: byId<HTMLDivElement>('view-history'),
  viewSettings: byId<HTMLDivElement>('view-settings'),
  attExtra: byId<HTMLDivElement>('att-extra'),

  menuToggle: byId<HTMLButtonElement>('menu-toggle'),
  sidebar: byId<HTMLElement>('sidebar'),
  sidebarCollapse: byId<HTMLButtonElement>('sidebar-collapse'),
  sidebarOverlay: byId<HTMLDivElement>('sidebar-overlay'),
  pageHeader: byId<HTMLElement>('page-header'),
  pageEyebrow: byId<HTMLParagraphElement>('page-eyebrow'),
  pageTitle: byId<HTMLHeadingElement>('page-title'),
  pageDescription: byId<HTMLParagraphElement>('page-description'),


  queueAddPage: byId<HTMLButtonElement>('queue-add-page'),
  queueEmpty: byId<HTMLDivElement>('queue-empty'),

  ttsModel: byId<HTMLSelectElement>('tts-model'),
  ttsKokoroDevice: byId<HTMLSelectElement>('tts-kokoro-device'),
  ttsKokoroDeviceField: byId<HTMLLabelElement>('tts-kokoro-device-field'),
  ttsLanguageField: byId<HTMLLabelElement>('tts-language-field'),
  ttsLanguage: byId<HTMLSelectElement>('tts-language'),
  ttsReverbFields: byId<HTMLDivElement>('tts-reverb-fields'),
  ttsReverbClip: byId<HTMLInputElement>('tts-reverb-clip'),
  ttsReverbClipStatus: byId<HTMLSpanElement>('tts-reverb-clip-status'),
  ttsReverbTranscript: byId<HTMLTextAreaElement>('tts-reverb-transcript'),
  ttsReverbLanguage: byId<HTMLSelectElement>('tts-reverb-language'),
  ttsReverbBuild: byId<HTMLButtonElement>('tts-reverb-build'),
  ttsReverbVoiceStatus: byId<HTMLParagraphElement>('tts-reverb-voice-status'),
  ttsPhonemizer: byId<HTMLSelectElement>('tts-phonemizer'),
  ttsPhonemizerField: byId<HTMLLabelElement>('tts-phonemizer-field'),
  ttsFormat: byId<HTMLSelectElement>('tts-format'),
  ttsFormatHint: byId<HTMLSpanElement>('tts-format-hint'),
  ttsText: byId<HTMLTextAreaElement>('tts-text'),
  ttsVoice: byId<HTMLSelectElement>('tts-voice'),
  ttsModelTitle: byId<HTMLHeadingElement>('tts-model-title'),
  ttsModelDescription: byId<HTMLParagraphElement>('tts-model-description'),
  ttsModelFacts: byId<HTMLDivElement>('tts-model-facts'),
  ttsModelCaveat: byId<HTMLParagraphElement>('tts-model-caveat'),
  ttsModelLink: byId<HTMLAnchorElement>('tts-model-link'),
  ttsSpeed: byId<HTMLInputElement>('tts-speed'),
  ttsSpeedValue: byId<HTMLSpanElement>('tts-speed-value'),
  ttsGenerateBtn: byId<HTMLButtonElement>('tts-generate-btn'),
  ttsCancelBtn: byId<HTMLButtonElement>('tts-cancel-btn'),
  ttsProgress: byId<HTMLDivElement>('tts-progress'),
  ttsProgressLabel: byId<HTMLParagraphElement>('tts-progress-label'),
  ttsProgressDetail: byId<HTMLSpanElement>('tts-progress-detail'),
  ttsProgressBar: byId<HTMLDivElement>('tts-progress-bar'),
  ttsStatus: byId<HTMLParagraphElement>('tts-status'),
  ttsResult: byId<HTMLDivElement>('tts-result'),
  ttsAudio: byId<HTMLAudioElement>('tts-audio'),
  ttsMeta: byId<HTMLParagraphElement>('tts-meta'),
  ttsDownload: byId<HTMLAnchorElement>('tts-download'),
  ttsCount: byId<HTMLSpanElement>('tts-count'),
  ttsDownloadHint: byId<HTMLParagraphElement>('tts-download-hint'),
  ttsVoiceGrid: byId<HTMLDivElement>('tts-voice-grid'),
  ttsVoiceSummary: byId<HTMLSpanElement>('tts-voice-summary'),
  ttsPreviewAudio: byId<HTMLAudioElement>('tts-preview-audio'),

  errorBanner: byId<HTMLDivElement>('error-banner'),
  errorTitle: byId<HTMLParagraphElement>('error-title'),
  errorMessage: byId<HTMLParagraphElement>('error-message'),
  errorHint: byId<HTMLParagraphElement>('error-hint'),
  errorDismiss: byId<HTMLButtonElement>('error-dismiss'),

  dropZone: byId<HTMLDivElement>('drop-zone'),
  fileInput: byId<HTMLInputElement>('file-input'),
  fileInfo: byId<HTMLDivElement>('file-info'),
  fileName: byId<HTMLParagraphElement>('file-name'),
  fileMeta: byId<HTMLParagraphElement>('file-meta'),
  removeFileBtn: byId<HTMLButtonElement>('remove-file-btn'),
  audioPlayer: byId<HTMLAudioElement>('audio-player'),
  waveform: byId<HTMLCanvasElement>('waveform'),
  segmentPanel: byId<HTMLDivElement>('segment-panel'),
  segmentList: byId<HTMLDivElement>('segment-list'),
  transcribeBtn: byId<HTMLButtonElement>('transcribe-btn'),

  progressPanel: byId<HTMLDivElement>('progress-panel'),
  cancelBtn: byId<HTMLButtonElement>('cancel-btn'),
  downloadProgress: byId<HTMLDivElement>('download-progress'),
  downloadLabel: byId<HTMLSpanElement>('download-label'),
  downloadDetail: byId<HTMLSpanElement>('download-detail'),
  downloadRate: byId<HTMLParagraphElement>('download-rate'),
  downloadBar: byId<HTMLDivElement>('download-bar'),
  inferenceProgress: byId<HTMLDivElement>('inference-progress'),
  inferenceLabel: byId<HTMLSpanElement>('inference-label'),
  inferenceDetail: byId<HTMLSpanElement>('inference-detail'),
  inferenceBar: byId<HTMLDivElement>('inference-bar'),
  progressStatus: byId<HTMLParagraphElement>('progress-status'),

  transcript: byId<HTMLTextAreaElement>('transcript'),
  wordCount: byId<HTMLSpanElement>('word-count'),
  charCount: byId<HTMLSpanElement>('char-count'),
  copyBtn: byId<HTMLButtonElement>('copy-btn'),
  speakersBtn: byId<HTMLButtonElement>('speakers-btn'),
  autoSpeakers: byId<HTMLInputElement>('auto-speakers'),
  speakersStatus: byId<HTMLParagraphElement>('speakers-status'),
  downloadBtn: byId<HTMLButtonElement>('download-btn'),
  exportFormat: byId<HTMLSelectElement>('export-format'),
  polishToggle: byId<HTMLInputElement>('polish-toggle'),
  runStats: byId<HTMLParagraphElement>('run-stats'),
  historyEnabled: byId<HTMLInputElement>('history-enabled'),
  historyClear: byId<HTMLButtonElement>('history-clear'),
  historyList: byId<HTMLDivElement>('history-list'),
  clearBtn: byId<HTMLButtonElement>('clear-btn'),
  statusLine: byId<HTMLParagraphElement>('status-line'),
  downloadHint: byId<HTMLParagraphElement>('download-hint'),

  installApp: byId<HTMLButtonElement>('install-app'),
  buildInfo: byId<HTMLSpanElement>('build-info'),
  offlineBadge: byId<HTMLSpanElement>('offline-badge'),

  modelSelect: byId<HTMLSelectElement>('model-select'),
  modelPicker: byId<HTMLDivElement>('model-picker'),
  variantField: byId<HTMLLabelElement>('variant-field'),
  variantSelect: byId<HTMLSelectElement>('variant-select'),
  languageField: byId<HTMLLabelElement>('language-field'),
  languageSelect: byId<HTMLSelectElement>('language-select'),
  modelDetails: byId<HTMLDivElement>('model-details'),
  modelComparison: byId<HTMLTableSectionElement>('model-comparison'),
  modelChart: byId<HTMLDivElement>('model-chart'),
  downloadedModels: byId<HTMLDivElement>('downloaded-models'),
  researchList: byId<HTMLDivElement>('research-list'),
  cleanModeField: byId<HTMLLabelElement>('clean-mode-field'),
  cleanMode: byId<HTMLInputElement>('clean-mode'),
  presetNote: byId<HTMLParagraphElement>('preset-note'),
  preloadBtn: byId<HTMLButtonElement>('preload-btn'),
  clearCacheBtn: byId<HTMLButtonElement>('clear-cache-btn'),
  clearAllCacheBtn: byId<HTMLButtonElement>('clear-all-cache-btn'),

  webgpuStatus: byId<HTMLSpanElement>('webgpu-status'),
  cacheStatus: byId<HTMLSpanElement>('cache-status'),
  storageStatus: byId<HTMLSpanElement>('storage-status'),
  storageUsageLabel: byId<HTMLSpanElement>('storage-usage-label'),
  storageQuotaLabel: byId<HTMLSpanElement>('storage-quota-label'),
  storageBar: byId<HTMLDivElement>('storage-bar'),
  storageDetail: byId<HTMLParagraphElement>('storage-detail'),

  toast: byId<HTMLDivElement>('toast'),
} as const;

type BusyState = 'idle' | 'decoding' | 'loading' | 'transcribing' | 'recording' | 'clearing' | 'benchmarking';

type AppView =
  | 'home'
  | 'transcribe'
  | 'tts'
  | 'vision'
  | 'tools'
  | 'converter'
  | 'documents'
  | 'record'
  | 'audio'
  | 'video'
  | 'models'
  | 'history'
  | 'settings';

const VIEW_META: Record<
  AppView,
  { eyebrow: string; title: string; description: string }
> = {
  home: {
    eyebrow: 'Local Media studio',
    title: 'LocalScribe',
    description: 'Everything runs in this tab.',
  },
  transcribe: {
    eyebrow: 'Speech & audio',
    title: 'Audio to text',
    description:
      'Upload, record, or try the sample. The selected model runs in this tab on WebGPU or CPU.',
  },
  tts: {
    eyebrow: 'Speech & audio',
    title: 'Text to speech',
    description:
      'Six local voice engines, including zero-shot cloning. Audition voices, generate speech, and export in seven formats.',
  },
  vision: {
    eyebrow: 'Vision & image',
    title: 'Vision studio',
    description:
      'Background removal, depth, object detection, segmentation, classification, and captions, all in this tab.',
  },
  tools: { eyebrow: 'Video & image', title: 'Quick tools', description: '' },
  converter: {
    eyebrow: 'Universal file conversion',
    title: 'File converter',
    description:
      'Convert video, audio, images, and documents on this device.',
  },
  documents: {
    eyebrow: 'Documents & privacy',
    title: 'Documents & privacy',
    description:
      'OCR and redact images or PDFs, then strip metadata, hash files, and package clean copies locally.',
  },
  record: {
    eyebrow: 'Video',
    title: 'Screen recorder',
    description:
      'Capture a screen, tab, or camera with microphone and system audio, all in this tab.',
  },
  audio: {
    eyebrow: 'Audio editing',
    title: 'Audio studio',
    description:
      'Remove vocals, change pitch and tempo, cut, join, and record. Everything runs on this device.',
  },
  video: {
    eyebrow: 'Video',
    title: 'Video editor',
    description:
      'Arrange video, images, and audio on a free multi-track timeline, then export.',
  },
  models: {
    eyebrow: 'Library',
    title: 'Models & storage',
    description:
      'Ten speech models, four voice engines, and nine vision models. Compare size, languages, accuracy, licenses, and cache state.',
  },
  history: {
    eyebrow: 'Library',
    title: 'History',
    description:
      'Transcripts saved in this browser. Text and segment timings only; audio is never stored.',
  },
  settings: {
    eyebrow: 'System',
    title: 'Settings & verification',
    description:
      'Device capabilities, storage, the benchmark, and the per-run request receipt.',
  },
};

let currentView: AppView = 'home';
let initialView: AppView = 'home';

interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  partial: boolean;
  words?: WordTiming[];
}

interface ExportMeta {
  duration: number;
  fileName: string | null;
  modelName: string;
  createdAt: Date;
}

interface AppState {
  file: File | null;
  audio: DecodedAudio | WaveSource | null;
  sourcePeaks: Float32Array | null;
  engine: AsrClient | null;
  busy: BusyState;
  controller: AbortController | null;
  objectUrl: string | null;
  webgpu: WebGpuStatus;
  cacheAvailable: boolean;
  modelId: ModelId;
  variantId: string;
  language: string;
  segments: TranscriptSegment[];
  forceCpu: boolean;
  exportMeta: ExportMeta | null;
}

const initialSelection = defaultSelection();
const state: AppState = {
  file: null,
  audio: null,
  sourcePeaks: null,
  engine: null,
  busy: 'idle',
  controller: null,
  objectUrl: null,
  webgpu: { supported: false },
  cacheAvailable: true,
  modelId: initialSelection.modelId,
  variantId: initialSelection.variantId,
  language: '',
  segments: [],
  forceCpu: false,
  exportMeta: null,
};

const MODEL_KEY = 'localscribe:model';
// Earlier versions saved their only available variant as if it were a choice.
const VARIANT_KEY = 'localscribe:precision-variant';
const CLEAN_KEY = 'localscribe:clean';
const LANGUAGE_KEY = 'localscribe:language';
const LEGACY_PRESET_KEY = 'localscribe:preset';

let webgpuReady: Promise<WebGpuStatus> = Promise.resolve({ supported: false });
let cacheRequestId = 0;
const modelCacheStates = new Map<string, CacheStatus>();
// The full model-cache scan is expensive; coalesce concurrent requests and
// reuse a recent snapshot until a download/delete invalidates it.
const CACHE_STATUS_TTL_MS = 5000;
let cacheStatusSnapshotAt = 0;
let cacheStatusScan: Promise<void> | null = null;
function invalidateCacheStatuses(): void {
  cacheStatusSnapshotAt = 0;
}
let toastTimer: number | null = null;
let lastInferencePercent = -1;
let waveformFrame = 0;
let waveformAnimation = 0;
let waveformPeaks: Float32Array | null = null;
let waveformPeaksFor: AppState['audio'] = null;
let waveformPeaksBuckets = 0;
let waveformGradient: CanvasGradient | null = null;
let waveformGradientWidth = -1;
let ttsEngine: TinyVocaEngine | null = null;
let kokoroEngine: KokoroEngine | null = null;
let woofEngine: WoofTtsEngine | null = null;
let reverbEngine: ReverbEngine | null = null;
let reverbVoice: ReverbVoice | null = null;
let reverbClip: { samples: Float32Array; sampleRate: number; name: string } | null = null;
let reverbBusy = false;
let reverbBuildToken = 0;
let reverbLanguage: (typeof REVERB_LANGUAGES)[number]['id'] = 'en';
type TtsModelId = 'tiny-voca' | 'kokoro' | 'woof' | 'reverb' | 'phonon' | 'supertonic';
let ttsModelId: TtsModelId = 'tiny-voca';

/** Engines that plug in through the TtsPlugin interface. */
const TTS_PLUGINS = new Map<string, TtsPlugin>();
function registerTtsPlugin(plugin: TtsPlugin): void {
  TTS_PLUGINS.set(plugin.id, plugin);
}
registerTtsPlugin(new PhononPlugin(() => state.webgpu.supported));
registerTtsPlugin(new SupertonicPlugin(() => state.webgpu.supported && !state.forceCpu));

function ttsPlugin(): TtsPlugin | null {
  return TTS_PLUGINS.get(ttsModelId) ?? null;
}

const TTS_MODEL_IDS: TtsModelId[] = ['tiny-voca', 'kokoro', 'woof', 'reverb', 'phonon', 'supertonic'];
let ttsLanguage = '';
let ttsPhonemizerMode: PhonemizerMode = 'fast';
let ttsKokoroDevice: KokoroMode = 'wasm';
let ttsFormatId: TtsFormat = 'mp3';
let ttsBusy = false;
let ttsWarmStarted = false;
let ttsCancelled = false;
let ttsAbort: AbortController | null = null;
let ttsObjectUrl: string | null = null;

const SAMPLE_URL = new URL('samples/jfk.wav', document.baseURI).href;
const TTS_TEXT_LIMIT = 8_000;

let visionTaskId: VisionTaskId = 'background-removal';
const visionModelByTask = new Map<VisionTaskId, string>(
  VISION_TASKS.map((task) => [task.id, task.defaultModel]),
);
let visionDevice: VisionDevice = 'wasm';
const visionPrecisionByModel = new Map<string, VisionPrecision>();
let visionSource: RawImage | null = null;
/** Clicks for SAM 3 click-to-select on the current image. */
let visionPoints: SelectPoint[] = [];
let visionSourceUrl: string | null = null;
let visionSourceFile: File | null = null;
let visionImageLoading = false;
let visionDeviceTouched = false;
let visionBusy = false;
let visionResultUrl: string | null = null;
const PREVIEW_TEXT = 'This is how my voice sounds when I read a short sentence.';

const recorder = new MicrophoneRecorder();
let sampleFile: File | null = null;
let recording = false;
let previewBusy = false;
const previewUrls = new Map<string, string>();

function invalidateReverbPreview(): void {
  const key = 'reverb:reference';
  const url = previewUrls.get(key);
  if (!url) return;
  URL.revokeObjectURL(url);
  previewUrls.delete(key);
  els.ttsPreviewAudio.classList.add('hidden');
}

const queueFiles: Array<{
  file: File;
  status: 'queued' | 'running' | 'failed' | 'cancelled' | 'empty' | 'done';
  text?: string;
  error?: string;
}> = [];
let queueRunning = false;
let queuePauseRequested = false;

const fallbackProfile: DeviceProfile = {
  cores: null,
  memoryGB: null,
  mobile: false,
  webgpu: false,
};
let deviceProfile: DeviceProfile = fallbackProfile;

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}
let installPrompt: InstallPromptEvent | null = null;

interface ReceiptBucket {
  count: number;
  bytes: number;
  methods: Set<string>;
  failed: number;
  ranged: number;
}
let receiptArmed = false;
let receiptRunning = false;
let receiptStartedAt = 0;
let receiptBuckets = new Map<string, ReceiptBucket>();

interface RunStats {
  loadMs: number;
  runMs: number;
  audioSeconds: number;
  backend: string;
  segments: number;
}
let lastRunStats: RunStats | null = null;

const jobTray = setupJobTray({
  navigate: (view) => navigate(view as AppView),
  currentView: () => currentView,
  viewTitle: (view) => VIEW_META[view as AppView]?.title ?? view,
});

function startJob(label: string, view: AppView): JobHandle {
  return jobTray.start(label, view);
}

type AudioStudio = ReturnType<typeof setupAudioStudio>;
type VideoEditor = ReturnType<typeof setupVideoMerge>;

let audioEditor: AudioStudio | null = null;
let audioEditorPromise: Promise<AudioStudio> | null = null;

function loadAudioEditor(): Promise<AudioStudio> {
  return audioEditorPromise ??= import('./audio-studio').then(({ setupAudioStudio: setup }) => {
    audioEditor = setup(els.viewAudio, {
      trackJob: (label) => startJob(label, 'audio'),
      transcribe: transcribeLyrics,
      modelName: () => currentModel().name,
      getSample: getSampleFile,
      getTranscribeFile: () => state.file,
      download: saveBlob,
      async sendToTranscribe(file) {
        if (state.busy !== 'idle') throw new Error('Wait for the current transcription task first.');
        navigate('transcribe');
        await handleFile(file);
        if (!state.audio || state.file !== file) throw new Error('Transcribe could not open the edited audio.');
      },
      sendToTts: openTtsReference,
    });
    return audioEditor;
  }).catch((error) => {
    audioEditorPromise = null;
    throw error;
  });
}

async function openTtsReference(file: File): Promise<void> {
  if (ttsBusy || reverbBusy || previewBusy) throw new Error('Wait for the current speech task first.');
  ttsModelId = 'reverb';
  els.ttsReverbClip.value = '';
  els.ttsReverbTranscript.value = '';
  renderTtsModel();
  navigate('tts');
  if (!await loadReverbClip(file)) throw new Error('Text to Speech could not open the reference clip.');
}

/** Put files into an existing file input and let its handler take over. */
function feedInput(input: HTMLInputElement, files: File[]): void {
  const transfer = new DataTransfer();
  for (const file of files) transfer.items.add(file);
  input.files = transfer.files;
  input.dispatchEvent(new Event('change'));
}

let videoEditor: VideoEditor | null = null;
let videoEditorPromise: Promise<VideoEditor> | null = null;

function loadVideoEditor(): Promise<VideoEditor> {
  return videoEditorPromise ??= import('./video-merge').then(({ setupVideoMerge: setup }) => {
    videoEditor = setup(els.viewVideo, {
      download: saveBlob,
      getTranscriptCues: () => {
        const cues = state.segments
          .filter((segment) => !segment.partial && segment.text.trim())
          .map((segment) => ({ start: segment.start, end: segment.end, text: segment.text.trim() }));
        return cues.length ? cues : null;
      },
      trackJob: (label) => startJob(label, 'video'),
      async sendToTranscribe(file) {
        if (state.busy !== 'idle') throw new Error('Wait for the current transcription task first.');
        navigate('transcribe');
        const result = await handleFile(file);
        if (result === 'cancelled' || state.file !== file) throw new Error('Audio to text could not open this clip.');
      },
      sendToAudioStudio(file) {
        navigate('audio');
        void loadAudioEditor().then((editor) => editor.openFile(file, 'effects'));
      },
      openTts: () => navigate('tts'),
    });
    videoEditor.localizeDefaultName();
    return videoEditor;
  }).catch((error) => {
    videoEditorPromise = null;
    throw error;
  });
}

type DocumentStudio = ReturnType<typeof setupDocumentStudio>;
let documentStudio: DocumentStudio | null = null;
let documentStudioPromise: Promise<DocumentStudio> | null = null;

function loadDocumentStudio(): Promise<DocumentStudio> {
  return documentStudioPromise ??= import('./document-studio').then(({ setupDocumentStudio: setup }) => {
    documentStudio = setup(els.viewDocuments, { download: saveBlob });
    return documentStudio;
  }).catch((error) => {
    documentStudioPromise = null;
    throw error;
  });
}

type RecordStudio = ReturnType<typeof setupRecordStudio>;
let recordStudio: RecordStudio | null = null;
let recordStudioPromise: Promise<RecordStudio> | null = null;

function loadRecordStudio(): Promise<RecordStudio> {
  return recordStudioPromise ??= import('./recorder-studio').then(({ setupRecordStudio: setup }) => {
    recordStudio = setup(els.viewRecord, {
      download: saveBlob,
      openInEditor(file) {
        navigate('video');
        void loadVideoEditor().then((editor) => editor.addFiles([file]));
      },
      transcribe(file) {
        navigate('transcribe');
        void handleFile(file);
      },
    });
    return recordStudio;
  }).catch((error) => {
    recordStudioPromise = null;
    throw error;
  });
}

let quickTools: ReturnType<typeof setupQuickTools> | null = null;
let quickToolsPromise: Promise<ReturnType<typeof setupQuickTools>> | null = null;

function loadQuickTools(): Promise<ReturnType<typeof setupQuickTools>> {
  return quickToolsPromise ??= import('./quick-tools').then(({ setupQuickTools }) => {
    quickTools = setupQuickTools(els.viewTools, {
      download: saveBlob,
      open(file, studio) {
        navigate(studio);
        if (studio === 'video') void loadVideoEditor().then((editor) => editor.addFiles([file]));
        else if (studio === 'vision') feedInput(els.visionInput, [file]);
        else void loadAudioEditor().then((editor) => editor.openFile(file, 'effects'));
      },
    });
    return quickTools;
  }).catch(error => {
    quickToolsPromise = null;
    throw error;
  });
}

let converterStudio: ReturnType<typeof setupConverterStudio> | null = null;
let converterStudioPromise: Promise<ReturnType<typeof setupConverterStudio>> | null = null;

function loadConverterStudio(): Promise<ReturnType<typeof setupConverterStudio>> {
  return converterStudioPromise ??= import('./converter-studio').then(({ setupConverterStudio }) => {
    converterStudio = setupConverterStudio(els.viewConverter, {
      download: saveBlob,
      open(file, studio) {
        navigate(studio);
        if (studio === 'video') void loadVideoEditor().then((editor) => editor.addFiles([file]));
        else if (studio === 'vision') feedInput(els.visionInput, [file]);
        else if (studio === 'audio') void loadAudioEditor().then((editor) => editor.openFile(file, 'effects'));
        else if (studio === 'documents') void loadDocumentStudio().then((editor) => editor.open([file]));
      },
    });
    return converterStudio;
  }).catch(error => {
    converterStudioPromise = null;
    throw error;
  });
}

setupOpenMenu({
  transcribe: (file) => {
    navigate('transcribe');
    void handleFile(file);
  },
  queue: (files) => {
    navigate('transcribe');
    feedInput(els.queueInput, files);
    requestAnimationFrame(focusQueue);
  },
  studio: (file, tool) => {
    navigate('audio');
    void loadAudioEditor().then((editor) => editor.openFile(file, tool as Parameters<typeof editor.openFile>[1]));
  },
  studioBatch: (files) => {
    navigate('audio');
    void loadAudioEditor().then((editor) => editor.batchFiles(files));
  },
  studioJoin: (files) => {
    navigate('audio');
    void loadAudioEditor().then((editor) => editor.joinFiles(files));
  },
  video: (files) => {
    navigate('video');
    void loadVideoEditor().then((editor) => editor.addFiles(files));
  },
  documents: (files) => {
    navigate('documents');
    void loadDocumentStudio().then((studio) => studio.open(files)).catch((error) => showToast(describeError(error)));
  },
  vision: (file) => {
    navigate('vision');
    feedInput(els.visionInput, [file]);
  },
  ttsReference: (file) => {
    void openTtsReference(file).catch((error) => showToast(describeError(error)));
  },
  converter: (files) => {
    navigate('converter');
    void loadConverterStudio().then((studio) => studio.addFiles(files)).catch((error) => showToast(describeError(error)));
  },
  metadata: (file) => {
    navigate('documents');
    void loadDocumentStudio().then((studio) => studio.inspect(file)).catch((error) => showToast(describeError(error)));
  },
  cleanMetadata: (files) => {
    navigate('documents');
    void loadDocumentStudio().then((studio) => studio.clean(files)).catch((error) => showToast(describeError(error)));
  },
  quickTools: (file, tool) => {
    navigate('tools');
    void loadQuickTools().then((studio) => studio.openFile(file, tool)).catch((error) => showToast(describeError(error)));
  },
}, () =>['home', 'tts', 'models', 'history', 'settings'].includes(currentView));
setupShortcutSheet();

/** Speed and time-left meters for model downloads outside the ASR loader. */
const ttsMeter = new TransferMeter();
const visionMeter = new TransferMeter();

function withTransfer(meter: TransferMeter, text: string, loaded?: number, total?: number): string {
  return loaded !== undefined && total ? `${text} · ${meter.describe(loaded, total)}` : text;
}

function downloadPercent(loaded: number | undefined, total: number | undefined, fallback: number, from = 10, span = 80): number {
  return loaded !== undefined && total ? from + (loaded / total) * span : fallback;
}

void init();

/**
 * Register the same-origin worker that adds COOP/COEP on static hosts, caches
 * the app shell for offline use, and reports request destinations for the
 * privacy receipt. Dev and preview already send the headers, so the worker is
 * production-only to avoid interfering with HMR.
 */
function registerServiceWorker(): void {
  if (import.meta.env.DEV) return;
  if (typeof window === 'undefined' || !window.isSecureContext) return;
  if (!('serviceWorker' in navigator)) return;

  const script = new URL('coi-serviceworker.js', document.baseURI);
  const build = document.querySelector<HTMLScriptElement>('script[type="module"][src]')
    ?.src.match(/-([A-Za-z0-9_-]{8,})\.js$/)?.[1];
  if (build) script.searchParams.set('v', build);
  const scope = new URL('./', document.baseURI).href;

  navigator.serviceWorker.addEventListener('message', handleServiceWorkerMessage);
  navigator.serviceWorker.addEventListener('controllerchange', updateOfflineBadge);

  navigator.serviceWorker
    .register(script, { scope })
    .then(() => navigator.serviceWorker.ready)
    .then(() => {
      updateOfflineBadge();
      // Static hosts cannot send COOP/COEP directly. The worker adds them on
      // the next navigation instead of reloading the first visit, so a cold
      // load never pays for a second document request. The badge explains how
      // to get multithreaded WASM immediately.
      if (!window.crossOriginIsolated) {
        els.offlineBadge.title = 'Reload once to enable multithreaded processing.';
      }
    })
    .catch(() => undefined);
}

function updateOfflineBadge(): void {
  const controlled = Boolean(navigator.serviceWorker?.controller);
  setBadge(
    els.offlineBadge,
    controlled ? 'Offline ready' : 'Offline after first visit',
    controlled ? 'good' : 'muted',
  );
}

function handleServiceWorkerMessage(event: MessageEvent): void {
  const data = event.data as
    | {
        type?: string;
        host?: string;
        method?: string;
        bytes?: number | null;
        status?: number;
      }
    | null;

  if (!data) return;

  if (data.type === 'localscribe:receipt-ready') {
    els.receiptStatus.textContent =
      'Receipt connected. Requests are counted while a transcription runs.';
    return;
  }

  if (data.type !== 'localscribe:request') return;
  if (!receiptRunning) return;

  const host = data.host || 'unknown';
  const bucket = receiptBuckets.get(host) ?? {
    count: 0,
    bytes: 0,
    methods: new Set<string>(),
    failed: 0,
    ranged: 0,
  };
  bucket.count += 1;
  bucket.methods.add((data.method || 'GET').toUpperCase());

  const status = typeof data.status === 'number' ? data.status : 0;
  if (status === 206) {
    // Transformers.js probes metadata with one-byte range requests. They are
    // successful, but summing their Content-Length as "received" is misleading.
    bucket.ranged += 1;
  } else if (status >= 200 && status < 300) {
    bucket.bytes +=
      typeof data.bytes === 'number' && data.bytes > 0 ? data.bytes : 0;
  } else {
    bucket.failed += 1;
  }

  receiptBuckets.set(host, bucket);
}

function beginReceiptRun(): void {
  receiptBuckets = new Map();
  receiptStartedAt = performance.now();
  receiptRunning = true;
  els.receiptResult.classList.add('hidden');
  els.receiptStatus.textContent = 'Recording request destinations for this run…';
}

function endReceiptRun(): void {
  if (!receiptRunning) return;
  receiptRunning = false;
  renderReceipt();
  if (receiptArmed) {
    receiptArmed = false;
    els.receiptStatus.textContent = 'Audit complete. Nothing was uploaded.';
  }
}

function renderReceipt(): void {
  const entries = [...receiptBuckets.entries()].sort(
    (a, b) => b[1].count - a[1].count,
  );
  const seconds = receiptStartedAt
    ? (performance.now() - receiptStartedAt) / 1000
    : 0;
  const totalRequests = entries.reduce((sum, [, bucket]) => sum + bucket.count, 0);
  const totalBytes = entries.reduce((sum, [, bucket]) => sum + bucket.bytes, 0);
  const totalFailed = entries.reduce((sum, [, bucket]) => sum + bucket.failed, 0);
  const totalRanged = entries.reduce((sum, [, bucket]) => sum + bucket.ranged, 0);
  const uploads = entries.reduce(
    (sum, [, bucket]) =>
      sum + [...bucket.methods].filter((method) => method !== 'GET').length,
    0,
  );

  els.receiptResult.classList.remove('hidden');

  if (!entries.length) {
    els.receiptResult.textContent =
      'No requests were recorded. The service worker is production-only; the built site records requests after one reload.';
    els.receiptStatus.textContent =
      'No receipt data in this development session.';
    return;
  }

  const rows = entries
    .map(([host, bucket]) => {
      const bytes = bucket.bytes > 0 ? ` · ${formatBytes(bucket.bytes)}` : '';
      const failed = bucket.failed > 0 ? ` · ${bucket.failed} failed` : '';
      const ranged = bucket.ranged > 0 ? ` · ${bucket.ranged} range` : '';
      const methods = [...bucket.methods].join('/');
      const isModelHost = /huggingface\.co|hf\.co|cdn-lfs/i.test(host);
      return `${isModelHost ? 'model' : 'site '}  ${host.padEnd(28)} ${String(
        bucket.count,
      ).padStart(3)} req${bytes}${ranged}${failed} · ${methods}`;
    })
    .join('\n');

  const received = totalBytes > 0 ? ` · ${formatBytes(totalBytes)} received` : '';

  els.receiptResult.textContent =
    `Last run · ${seconds.toFixed(1)} s · ${totalRequests} requests${received}` +
    `${totalRanged > 0 ? ` · ${totalRanged} range probes` : ''}` +
    `${totalFailed > 0 ? ` · ${totalFailed} failed` : ''}\n` +
    `${rows}\n` +
    `Uploads: ${uploads === 0 ? '0 request bodies sent' : `${uploads} non-GET requests`}`;

  els.receiptStatus.textContent =
    `Recorded ${totalRequests} request${totalRequests === 1 ? '' : 's'} during the last run` +
    (totalFailed > 0
      ? `, ${totalFailed} of which failed (likely cached or offline).`
      : totalRanged > 0 && totalBytes === 0
        ? ': metadata range probes only; model weights came from local cache.'
        : '.') +
    ' Audio and text are never part of this report.';
}

function resetReceipt(): void {
  receiptBuckets = new Map();
  receiptArmed = false;
  receiptStartedAt = 0;
  els.receiptResult.classList.add('hidden');
  els.receiptStatus.textContent =
    'No audit yet. The service worker records destinations, methods, and response sizes, never audio or text.';
}

/** One source of truth for what every file picker accepts. */
function applyAcceptLists(): void {
  for (const input of document.querySelectorAll<HTMLInputElement>('input[type="file"]')) {
    const accept = input.accept;
    if (input.dataset.accept === 'video' || (/video\//.test(accept) && !/audio\//.test(accept))) input.accept = VIDEO_ACCEPT;
    else if (/audio\/|video\/|\.wav|\.mp3/.test(accept)) input.accept = MEDIA_ACCEPT;
  }
}

async function init(): Promise<void> {
  registerServiceWorker();
  await setupI18n();
  setupAppLocale();
  applyAcceptLists();

  els.variantCount.textContent = `${SUPPORTED_MODELS.reduce(
    (sum, model) => sum + model.variants.filter(isVariantSupported).length,
    0,
  )} model variants`;

  populateModelOptions();
  loadPreferences();
  applyUrlState();
  renderModelPicker();
  renderPresets();
  renderExportFormats();
  // Model comparison, research cards, TTS controls, and the Vision task grid
  // are rendered when their view is first opened, not on every app load.
  renderHistoryControls();
  renderQueue();
  els.ttsText.maxLength = TTS_TEXT_LIMIT;
  updateTtsCount();
  els.buildInfo.textContent = 'LocalScribe v1.0.0 · static build';
  bindEvents();
  updatePresetNote();
  updateCounts();
  setBackend(null);
  updateOfflineBadge();
  setupInstallPrompt();
  void refreshHistory();
  void sendReceiptPing();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('controllerchange', updateOfflineBadge);
  }

  webgpuReady = detectWebGPU()
    .then((status) => {
      state.webgpu = status;
      deviceProfile = readDeviceProfile(status.supported);
      renderWebGpuStatus();
      renderTtsModel();
      renderModelPicker();
      updatePresetNote();
      renderVisionTask();
      void refreshCacheStatus();
      return status;
    })
    .catch((error: unknown) => {
      const status: WebGpuStatus = {
        supported: false,
        reason: error instanceof Error ? error.message : 'WebGPU detection failed.',
      };
      state.webgpu = status;
      deviceProfile = readDeviceProfile(false);
      renderWebGpuStatus();
      renderTtsModel();
      renderModelPicker();
      renderVisionTask();
      return status;
    });

  const startWithSample =
    new URLSearchParams(location.search).get('sample') === '1';
  const legacyQueue = location.hash.startsWith('#/queue');
  const startView = isVideoEditorPath() ? 'video' : (viewFromHash() ?? initialView);
  navigate(startView, { scroll: false });
  if (legacyQueue) requestAnimationFrame(focusQueue);

  await Promise.allSettled([refreshCacheStatus(), refreshStorageStatus()]);

  if (startWithSample) {
    navigate('transcribe');
    void loadSample();
  }
}

async function sendReceiptPing(): Promise<void> {
  if (import.meta.env.DEV) return;
  if (!('serviceWorker' in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.ready;
    registration.active?.postMessage({ type: 'localscribe:receipt-ping' });
  } catch {
    // The receipt is an enhancement; no worker means no receipt.
  }
}

function setupInstallPrompt(): void {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    installPrompt = event as InstallPromptEvent;
    els.installApp.classList.remove('hidden');
  });

  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    els.installApp.classList.add('hidden');
    showToast('LocalScribe installed.');
  });
}

/* -------------------------------------------------------------------------- */
/* Suite navigation                                                           */
/* -------------------------------------------------------------------------- */

function viewFromHash(): AppView | null {
  const raw = location.hash.replace(/^#\/?/, '').split('?')[0];
  // The queue now lives inside Audio to text; keep old links working.
  if (raw === 'queue') return 'transcribe';
  // The video editor has its own path route; keep the old hash alias working.
  if (raw === 'video' || raw === 'video-editor') return 'video';
  const views: AppView[] = [
    'home',
    'transcribe',
    'tts',
    'vision',
    'tools',
    'documents',
    'converter',
    'record',
    'audio',
    'video',
    'models',
    'history',
    'settings',
  ];
  return views.includes(raw as AppView) ? (raw as AppView) : null;
}

const VIDEO_EDITOR_SLUG = 'video-editor';

function isVideoEditorPath(): boolean {
  return /\/video-editor\/?$/i.test(location.pathname);
}

/** Root of the deployed app, e.g. "/" or "/audio-to-text/". */
function appRootPath(): string {
  const match = location.pathname.match(/^(.*\/)video-editor\/?$/i);
  if (match) return match[1] || '/';
  const directory = location.pathname.replace(/[^/]*$/, '');
  return directory || '/';
}

function focusQueue(): void {
  els.queueSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function closeSidebar(): void {
  els.sidebar.classList.remove('open');
  els.sidebarOverlay.classList.add('hidden');
  els.menuToggle.setAttribute('aria-expanded', 'false');
  document.body.classList.remove('sidebar-open');
}

function toggleSidebar(): void {
  const open = !els.sidebar.classList.contains('open');
  els.sidebar.classList.toggle('open', open);
  els.sidebarOverlay.classList.toggle('hidden', !open);
  els.menuToggle.setAttribute('aria-expanded', String(open));
  document.body.classList.toggle('sidebar-open', open);
}

const SIDEBAR_COLLAPSED_KEY = 'localscribe.sidebar.collapsed';

function setSidebarCollapsed(collapsed: boolean): void {
  document.body.classList.toggle('sidebar-collapsed', collapsed);
  els.sidebarCollapse.setAttribute('aria-expanded', String(!collapsed));
  els.sidebarCollapse.setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
  els.sidebarCollapse.setAttribute('title', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
  try {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch {
    // Storage is optional.
  }
}

try {
  setSidebarCollapsed(localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1');
} catch {
  setSidebarCollapsed(false);
}
els.sidebarCollapse.addEventListener('click', () => {
  setSidebarCollapsed(!document.body.classList.contains('sidebar-collapsed'));
});
for (const link of els.sidebar.querySelectorAll<HTMLElement>('[data-view-link]')) {
  const label = link.querySelector('span')?.textContent?.trim();
  if (label) link.title = label;
}

type SidebarActivity = { tone: 'busy' | 'ready' | 'warn'; label: string };
const sidebarActivities = new Map<AppView, SidebarActivity>();

function paintSidebarActivity(view: AppView): void {
  const link = els.sidebar.querySelector<HTMLElement>(`[data-view-link="${view}"]`);
  if (!link) return;
  const activity = sidebarActivities.get(view);
  const visible = Boolean(activity) && (currentView !== view || activity?.tone === 'busy');
  let dot = link.querySelector<HTMLElement>('.sidebar-activity');
  const base = link.querySelector('span')?.textContent?.trim() || link.title || view;
  if (!visible || !activity) {
    dot?.remove();
    link.classList.remove('has-activity');
    link.removeAttribute('data-activity-tone');
    link.title = base;
    link.removeAttribute('aria-label');
    return;
  }
  if (!dot) {
    dot = document.createElement('span');
    dot.className = 'sidebar-activity';
    dot.setAttribute('role', 'img');
    link.append(dot);
  }
  dot.dataset.tone = activity.tone;
  dot.title = activity.label;
  dot.setAttribute('aria-label', activity.label);
  link.classList.add('has-activity');
  link.dataset.activityTone = activity.tone;
  link.title = `${base}: ${activity.label}`;
  link.setAttribute('aria-label', `${base}, ${activity.label}`);
}

function setSidebarActivity(view: AppView, activity: SidebarActivity | null): void {
  const previous = sidebarActivities.get(view);
  if (!activity) {
    if (!previous) return;
    sidebarActivities.delete(view);
  } else {
    if (previous?.tone === activity.tone && previous.label === activity.label) return;
    sidebarActivities.set(view, activity);
  }
  paintSidebarActivity(view);
}

function paintAllSidebarActivities(): void {
  for (const view of sidebarActivities.keys()) paintSidebarActivity(view);
}

function refreshSidebarActivities(): void {
  if (state.busy !== 'idle') {
    const labels: Record<BusyState, string> = {
      idle: '',
      decoding: 'Decoding audio',
      loading: 'Loading a speech model',
      transcribing: 'Transcribing audio',
      recording: 'Recording from the microphone',
      clearing: 'Clearing speech models',
      benchmarking: 'Benchmarking a speech model',
    };
    setSidebarActivity('transcribe', { tone: 'busy', label: labels[state.busy] });
  } else if (els.transcript.value.trim()) {
    setSidebarActivity('transcribe', { tone: 'ready', label: 'Transcript open' });
  } else if (state.audio) {
    setSidebarActivity('transcribe', { tone: 'ready', label: 'Audio open' });
  } else {
    setSidebarActivity('transcribe', null);
  }

  if (ttsBusy || reverbBusy || previewBusy) {
    setSidebarActivity('tts', { tone: 'busy', label: 'Generating speech' });
  } else {
    setSidebarActivity('tts', ttsObjectUrl ? { tone: 'ready', label: 'Speech ready' } : null);
  }

  if (visionBusy) {
    setSidebarActivity('vision', { tone: 'busy', label: 'Processing an image' });
  } else {
    setSidebarActivity(
      'vision',
      visionSource || visionResultUrl ? { tone: 'ready', label: 'Image open' } : null,
    );
  }

  setSidebarActivity('audio', audioEditor?.activity() ?? null);
  setSidebarActivity('video', videoEditor?.activity() ?? null);
  setSidebarActivity('record', recordStudio?.activity() ?? null);
  setSidebarActivity('documents', documentStudio?.activity() ?? null);
  setSidebarActivity('converter', converterStudio?.activity() ?? null);
}

refreshSidebarActivities();
window.setInterval(refreshSidebarActivities, 600);

function navigate(
  view: AppView,
  options: { scroll?: boolean; updateHash?: boolean } = {},
): void {
  currentView = view;
  document.body.dataset.view = view;

  els.viewHome.classList.toggle('hidden', view !== 'home');
  els.viewTranscribe.classList.toggle(
    'hidden',
    view !== 'transcribe' && view !== 'models',
  );
  els.viewTts.classList.toggle('hidden', view !== 'tts');
  els.viewVision.classList.toggle('hidden', view !== 'vision');
  els.viewTools.classList.toggle('hidden', view !== 'tools');
  els.viewDocuments.classList.toggle('hidden', view !== 'documents');
  els.viewConverter.classList.toggle('hidden', view !== 'converter');
  els.viewRecord.classList.toggle('hidden', view !== 'record');
  if (view === 'converter') {
    void loadConverterStudio().catch((error) => showToast(describeError(error)));
  }
  if (view === 'tools') {
    void loadQuickTools().then(studio => {
      if (currentView === 'tools') studio.show();
    }).catch(error => showToast(describeError(error)));
  } else quickTools?.pause();
  if (view === 'documents') {
    void loadDocumentStudio().then((studio) => {
      if (currentView === 'documents') studio.show();
    }).catch((error) => showToast(describeError(error)));
  }
  if (view === 'record') {
    void loadRecordStudio().then((studio) => {
      if (currentView === 'record') studio.show();
    }).catch((error) => showToast(describeError(error)));
  } else recordStudio?.pause();
  els.viewAudio.classList.toggle('hidden', view !== 'audio');
  els.viewVideo.classList.toggle('hidden', view !== 'video');
  if (view !== 'audio') audioEditor?.pause();
  if (view !== 'video') videoEditor?.pause();
  if (view === 'video') {
    void loadVideoEditor().then((editor) => {
      if (currentView === 'video') editor.refresh();
    }).catch((error) => showToast(describeError(error)));
  }
  if (view === 'audio') {
    void loadAudioEditor().then((editor) => {
      if (currentView === 'audio') editor.updateControls();
    }).catch((error) => showToast(describeError(error)));
  }
  els.viewHistory.classList.toggle('hidden', view !== 'history');
  els.viewSettings.classList.toggle('hidden', view !== 'settings');

  els.pageHeader.classList.toggle('hidden', view === 'home');
  const meta = VIEW_META[view];
  els.pageEyebrow.textContent = meta.eyebrow;
  els.pageTitle.textContent = meta.title;
  els.pageDescription.textContent = meta.description;

  for (const link of document.querySelectorAll<HTMLElement>(
    '#sidebar [data-view-link]',
  )) {
    if (link.dataset.viewLink === view) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  paintAllSidebarActivities();

  if (options.updateHash !== false) {
    const existingTool = new URLSearchParams(location.hash.split('?')[1]).get('tool');
    const route = view === 'tools'
      ? 'tools?tool=' + encodeURIComponent(existingTool || quickTools?.current() || 'video-converter')
      : view;
    const root = appRootPath();
    const search = location.search;
    if (view === 'video') {
      window.history.replaceState(null, '', `${root}${VIDEO_EDITOR_SLUG}/${search}`);
    } else {
      window.history.replaceState(null, '', `${root}${search}#/${route}`);
    }
  }

  syncUrlState();
  closeSidebar();

  if (view === 'tts') {
    renderTtsModel();
    renderTtsFormats();
    renderReverbLanguages();
    renderVoiceGallery();
  }
  if (view === 'vision') renderVisionTask();
  if (view === 'history') void refreshHistory();
  if (view === 'models') {
    renderModelComparison();
    renderResearchModels();
    renderModelCards();
    void refreshCacheStatus();
    void renderEngineStorage(byId<HTMLDivElement>('engine-storage-list'), () => sharedFfmpeg().multithreaded);
  }
  showTipFor(view);
  if (view === 'settings') {
    void refreshStorageStatus();
    void refreshCacheStatus();
    updateOfflineBadge();
  }
  refreshSidebarActivities();
  if (options.scroll !== false) {
    window.scrollTo({ top: 0, behavior: 'auto' });
  }
}

/* -------------------------------------------------------------------------- */
/* Home                                                                       */
/* -------------------------------------------------------------------------- */

function bindEvents(): void {
  els.menuToggle.addEventListener('click', toggleSidebar);
  els.sidebarOverlay.addEventListener('click', closeSidebar);

  document.addEventListener('click', (event) => {
    const link = (event.target as HTMLElement).closest<HTMLElement>(
      '[data-view-link]',
    );
    if (!link) return;
    event.preventDefault();
    const view = link.dataset.viewLink as AppView | undefined;
    if (view && VIEW_META[view]) navigate(view);
  });

  window.addEventListener('hashchange', () => {
    const legacyQueue = location.hash.startsWith('#/queue');
    const view = viewFromHash();
    // An unknown route goes Home and fixes the URL, matching a fresh load,
    // instead of leaving the previous tool under a bad address. In-page
    // anchors (#section) are not routes and are left alone.
    if (!view && location.hash.startsWith('#/')) {
      navigate('home');
      return;
    }
    if (view && view !== currentView) navigate(view, { updateHash: false });
    else if (view === 'tools') void loadQuickTools().then(studio => studio.show()).catch(error => showToast(describeError(error)));
    if (legacyQueue) {
      requestAnimationFrame(focusQueue);
      history.replaceState(history.state, '', `${location.pathname}${location.search}#/transcribe`);
    }
  });

  els.queueAddPage.addEventListener('click', () => {
    if (state.busy !== 'idle') return;
    els.queueInput.click();
  });

  els.audioPlayer.addEventListener('timeupdate', () => {
    highlightSegmentAtTime();
    // The rAF animation already redraws the waveform while playing.
    if (els.audioPlayer.paused) scheduleWaveformDraw();
  });
  els.audioPlayer.addEventListener('seeking', () => {
    highlightSegmentAtTime();
    scheduleWaveformDraw();
  });
  els.audioPlayer.addEventListener('play', startWaveformAnimation);
  els.audioPlayer.addEventListener('pause', stopWaveformAnimation);
  els.audioPlayer.addEventListener('ended', stopWaveformAnimation);

  els.waveform.addEventListener('click', (event) => {
    const audio = state.audio;
    if (!audio) return;
    const rect = els.waveform.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    els.audioPlayer.currentTime = ratio * audio.duration;
    highlightSegmentAtTime();
    scheduleWaveformDraw();
  });

  els.waveform.addEventListener('keydown', (event) => {
    if (!state.audio) return;
    const step = event.shiftKey ? 10 : 2;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      const delta = event.key === 'ArrowLeft' ? -step : step;
      els.audioPlayer.currentTime = Math.max(
        0,
        Math.min(
          state.audio.duration,
          els.audioPlayer.currentTime + delta,
        ),
      );
      scheduleWaveformDraw();
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      els.audioPlayer.currentTime =
        event.key === 'Home' ? 0 : state.audio.duration;
      scheduleWaveformDraw();
    }
  });

  els.speakersBtn.addEventListener('click', () => void detectSpeakers());
  try { els.autoSpeakers.checked = localStorage.getItem(AUTO_SPEAKERS_KEY) === '1'; } catch { /* storage unavailable */ }
  els.autoSpeakers.addEventListener('change', () => {
    try { localStorage.setItem(AUTO_SPEAKERS_KEY, els.autoSpeakers.checked ? '1' : '0'); } catch { /* storage unavailable */ }
  });

  els.segmentList.addEventListener('click', (event) => {
    const chip = (event.target as HTMLElement).closest<HTMLElement>('[data-speaker-chip]');
    if (chip) {
      renameSpeaker(Number(chip.dataset.speakerChip), chip);
      return;
    }
    const line = (event.target as HTMLElement).closest<HTMLElement>('[data-speaker-line]');
    if (line && speakerLines) {
      const entry = speakerLines[Number(line.dataset.speakerLine)];
      if (entry) {
        els.audioPlayer.currentTime = entry.start;
        void els.audioPlayer.play().catch(() => undefined);
      }
      return;
    }
    const row = (event.target as HTMLElement).closest<HTMLElement>(
      '[data-segment-index]',
    );
    if (!row) return;
    const index = Number(row.dataset.segmentIndex);
    const segment = state.segments[index];
    if (!segment) return;
    els.audioPlayer.currentTime = segment.start;
    void els.audioPlayer.play().catch(() => undefined);
    highlightSegmentAtTime();
  });

  document
    .querySelectorAll<HTMLAnchorElement>('a[href="#models"]')
    .forEach((link) =>
      link.addEventListener('click', (event) => {
        event.preventDefault();
        navigate('models');
      }),
    );

  els.ttsSpeed.addEventListener('input', () => {
    els.ttsSpeedValue.textContent = `${Number(els.ttsSpeed.value).toFixed(2)}×`;
  });

  // tiny-voca's first run is dominated by the local Pyodide + phonemizer
  // startup. Begin that work once the user starts typing, so the Generate click
  // usually finds it already warm. Kokoro is not prefetched because its model
  // is much larger.
  els.ttsText.addEventListener('input', warmTinyVoca);

  els.ttsModel.addEventListener('change', () => {
    const value = els.ttsModel.value as TtsModelId;
    ttsModelId = TTS_MODEL_IDS.includes(value) ? value : 'tiny-voca';
    ttsLanguage = '';
    renderTtsModel();
  });

  els.ttsLanguage.addEventListener('change', () => {
    ttsLanguage = els.ttsLanguage.value;
  });

  els.ttsReverbClip.addEventListener('change', () => {
    void loadReverbClip();
  });

  els.ttsReverbTranscript.addEventListener('input', () => {
    reverbVoice = null;
    invalidateReverbPreview();
    updateReverbUi();
  });

  els.ttsReverbLanguage.addEventListener('change', () => {
    reverbLanguage =
      (els.ttsReverbLanguage.value as (typeof REVERB_LANGUAGES)[number]['id']) ||
      'en';
    reverbVoice = null;
    invalidateReverbPreview();
    updateReverbUi();
  });

  els.ttsReverbBuild.addEventListener('click', () => {
    void buildReverbVoice();
  });

  els.ttsPhonemizer.addEventListener('change', () => {
    ttsPhonemizerMode =
      els.ttsPhonemizer.value === 'accurate' ? 'accurate' : 'fast';
    if (ttsEngine) void ttsEngine.dispose();
    ttsEngine = null;
    ttsWarmStarted = false;
    renderTtsModel();
    els.ttsStatus.textContent =
      ttsPhonemizerMode === 'fast'
        ? 'Fast phonemizer selected. Start typing to warm it up.'
        : 'Accurate dizione phonemizer selected. The first generation loads the local Python runtime.';
    if (els.ttsText.value.trim()) warmTinyVoca();
  });

  els.ttsKokoroDevice.addEventListener('change', () => {
    const mode = els.ttsKokoroDevice.value;
    ttsKokoroDevice = mode === 'webgpu' || mode === 'wasm-q8' ? mode : 'wasm';
    if (kokoroEngine) void kokoroEngine.dispose();
    kokoroEngine = null;
    els.ttsPreviewAudio.pause();
    els.ttsPreviewAudio.removeAttribute('src');
    els.ttsPreviewAudio.classList.add('hidden');
    renderTtsModel();
    els.ttsStatus.textContent =
      ttsKokoroDevice === 'webgpu'
        ? 'Kokoro will use WebGPU. The first generation downloads the fp32 model.'
        : 'Kokoro will use the CPU/WASM backend.';
  });

  els.ttsFormat.addEventListener('change', () => {
    ttsFormatId = (els.ttsFormat.value as TtsFormat) || 'mp3';
    refreshTtsFormatHint();
  });
  els.ttsFormat.addEventListener('focus', refreshTtsFormatHint);

  els.ttsGenerateBtn.addEventListener('click', () => {
    void generateSpeech();
  });

  els.visionTaskGrid.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>(
      '[data-vision-task]',
    );
    if (!button) return;
    const id = button.dataset.visionTask as VisionTaskId;
    if (!id || id === visionTaskId) return;
    visionTaskId = id;
    visionPoints = [];
    clearVisionResult();
    renderVisionTask();
  });

  // Click-to-select: map the click to image pixels and rerun the decoder.
  const addVisionPoint = (event: MouseEvent, positive: boolean) => {
    if (visionTaskId !== 'select-object' || !visionSource || visionBusy) return;
    const rect = els.visionCanvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const x = ((event.clientX - rect.left) / rect.width) * visionSource.width;
    const y = ((event.clientY - rect.top) / rect.height) * visionSource.height;
    visionPoints = [...visionPoints, { x, y, positive }];
    void runVisionTask();
  };
  els.visionCanvas.addEventListener('click', (event) => addVisionPoint(event, !event.shiftKey));
  els.visionCanvas.addEventListener('contextmenu', (event) => {
    if (visionTaskId !== 'select-object') return;
    event.preventDefault();
    addVisionPoint(event, false);
  });

  els.visionModel.addEventListener('change', () => {
    visionModelByTask.set(visionTaskId, els.visionModel.value);
    renderVisionTask();
    clearVisionResult();
  });

  els.visionDevice.addEventListener('change', () => {
    visionDevice =
      els.visionDevice.value === 'webgpu' ? 'webgpu' : 'wasm';
    visionDeviceTouched = true;
    clearVisionResult();
    renderVisionTask();
  });

  els.visionThreshold.addEventListener('input', () => {
    els.visionThresholdValue.textContent = Number(
      els.visionThreshold.value,
    ).toFixed(2);
  });

  els.visionPrecision.addEventListener('change', () => {
    const value = els.visionPrecision.value;
    visionPrecisionByModel.set(els.visionModel.value, value === 'fp16' || value === 'q8' ? value : 'fp32');
    clearVisionResult();
    renderVisionTask();
  });

  els.visionInput.addEventListener('change', () => {
    const file = els.visionInput.files?.[0];
    els.visionInput.value = '';
    if (file) void loadVisionImage(file);
  });

  els.visionDrop.addEventListener('click', () => {
    if (!visionBusy && !visionImageLoading) els.visionInput.click();
  });
  els.visionDrop.addEventListener('dragover', (event) => {
    event.preventDefault();
    if (!visionBusy && !visionImageLoading) els.visionDrop.classList.add('is-dragging');
  });
  els.visionDrop.addEventListener('dragleave', () => {
    els.visionDrop.classList.remove('is-dragging');
  });
  els.visionDrop.addEventListener('drop', (event) => {
    event.preventDefault();
    els.visionDrop.classList.remove('is-dragging');
    const file = event.dataTransfer?.files?.[0];
    if (file) void loadVisionImage(file);
  });

  els.visionRun.addEventListener('click', () => {
    void runVisionTask();
  });
  els.visionLoad.addEventListener('click', () => {
    void runVisionTask(true);
  });

  els.visionComparisonSlider.addEventListener('input', updateVisionComparison);

  els.ttsCancelBtn.addEventListener('click', () => {
    ttsCancelled = true;
    ttsAbort?.abort();
    els.ttsCancelBtn.disabled = true;
    els.ttsCancelBtn.textContent = 'Cancelling…';
    els.ttsStatus.textContent = 'Stopping after the current sentence…';
  });

  els.fileInput.addEventListener('change', () => {
    const file = els.fileInput.files?.[0];
    if (file) void handleFile(file);
  });

  els.dropZone.addEventListener('click', (event) => {
    if (state.busy !== 'idle') return;
    if (event.target === els.fileInput) return;
    els.fileInput.click();
  });

  els.dropZone.addEventListener('keydown', (event) => {
    if (state.busy !== 'idle') return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      els.fileInput.click();
    }
  });

  for (const type of ['dragenter', 'dragover'] as const) {
    els.dropZone.addEventListener(type, (event) => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      if (state.busy === 'idle') els.dropZone.classList.add('drag-over');
    });
  }

  for (const type of ['dragleave', 'dragend'] as const) {
    els.dropZone.addEventListener(type, () => {
      els.dropZone.classList.remove('drag-over');
    });
  }

  els.dropZone.addEventListener('drop', (event) => {
    event.preventDefault();
    els.dropZone.classList.remove('drag-over');
    if (state.busy !== 'idle') return;
    const file = event.dataTransfer?.files?.[0];
    if (file) void handleFile(file);
  });

  els.removeFileBtn.addEventListener('click', () => {
    if (state.busy !== 'idle') return;
    resetAudio();
    resetTranscript();
    clearError();
    setStatus('Select an audio file to begin.');
  });

  els.transcribeBtn.addEventListener('click', () => {
    void transcribe();
  });

  els.cancelBtn.addEventListener('click', () => {
    if (!state.controller) return;
    state.controller.abort();
    els.cancelBtn.disabled = true;
    els.cancelBtn.textContent = 'Cancelling…';
    els.progressStatus.textContent = 'Stopping after the current step…';
  });

  els.preloadBtn.addEventListener('click', () => {
    void preloadModel();
  });

  els.clearCacheBtn.addEventListener('click', () => {
    void clearCache();
  });

  els.clearAllCacheBtn.addEventListener('click', () => {
    void clearAllCache();
  });

  els.modelComparison.addEventListener('click', (event) => {
    if (state.busy !== 'idle') return;
    const row = (event.target as HTMLElement).closest<HTMLElement>(
      '[data-model-id]',
    );
    const modelId = row?.dataset.modelId as ModelId | undefined;
    if (!modelId) return;

    const model = getModel(modelId);
    state.modelId = model.id;
    state.variantId = model.defaultVariant;
    renderModelPicker();
    handleModelSettingsChange();
  });

  els.modelPicker.addEventListener('click', (event) => {
    if (state.busy !== 'idle') return;
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>(
      '[data-model-id]',
    );
    if (!button) return;
    const modelId = button.dataset.modelId;
    if (!modelId || modelId === state.modelId) return;
    els.modelSelect.value = modelId;
    els.modelSelect.dispatchEvent(new Event('change', { bubbles: true }));
  });

  els.modelSelect.addEventListener('change', () => {
    state.modelId = els.modelSelect.value as ModelId;
    state.variantId = getModel(state.modelId).defaultVariant;
    renderModelPicker();
    handleModelSettingsChange();
  });

  els.sessionModelSelect.addEventListener('change', () => {
    if (state.busy !== 'idle') {
      els.sessionModelSelect.value = state.modelId;
      return;
    }
    state.modelId = els.sessionModelSelect.value as ModelId;
    state.variantId = getModel(state.modelId).defaultVariant;
    renderModelPicker();
    handleModelSettingsChange();
  });

  for (const select of [els.variantSelect, els.sessionVariantSelect]) {
    select.addEventListener('change', () => {
      state.variantId = select.value;
      renderModelPicker();
      handleModelSettingsChange();
    });
  }

  els.languageSelect.addEventListener('change', () => {
    state.language = els.languageSelect.value;
    renderModelDetails();
    updatePresetNote();
    handleModelSettingsChange();
  });

  els.cleanMode.addEventListener('change', () => {
    handleModelSettingsChange();
  });

  els.downloadedModels.addEventListener('click', (event) => {
    if (state.busy !== 'idle') return;
    const target = event.target as HTMLElement;
    const clearButton = target.closest<HTMLButtonElement>('[data-clear-model]');
    if (clearButton) {
      event.preventDefault();
      void clearModelCacheForId(clearButton.dataset.clearModel as ModelId);
      return;
    }

    const clearOther = target.closest<HTMLButtonElement>('[data-clear-other]');
    if (clearOther) {
      event.preventDefault();
      const row = otherCachedModels[Number(clearOther.dataset.clearOther)];
      if (!row || !window.confirm(`Delete the cached ${row.label} files (${formatBytes(row.bytes)})? They download again on next use.`)) return;
      clearOther.disabled = true;
      void clearOtherCachedModel(row)
        .then(() => {
          invalidateCacheStatuses();
          return Promise.allSettled([refreshCacheStatus(), refreshStorageStatus()]);
        })
        .then(() => showToast(`${row.label} removed from this browser.`));
      return;
    }

    const selectButton = target.closest<HTMLButtonElement>('[data-model-id]');
    if (selectButton) {
      event.preventDefault();
      const modelId = selectButton.dataset.modelId as ModelId;
      const variantId = selectButton.dataset.variantId ?? '';
      state.modelId = modelId;
      state.variantId = getVariant(getModel(modelId), variantId).id;
      renderModelPicker();
      handleModelSettingsChange();
    }
  });

  els.errorDismiss.addEventListener('click', clearError);

  els.transcript.addEventListener('input', () => {
    updateCounts();
    updateTranscriptButtons();
    scheduleHistoryEditSave();
  });

  els.copyBtn.addEventListener('click', () => {
    void copyTranscript();
  });

  els.downloadBtn.addEventListener('click', downloadTranscript);

  els.clearBtn.addEventListener('click', () => {
    if (state.busy !== 'idle') return;
    resetTranscript();
    setStatus('Transcript cleared.');
  });

  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      if (state.busy === 'idle' && state.audio) void transcribe();
    }

    if (event.key === 'Escape' && recording) {
      event.preventDefault();
      cancelRecording();
    }
  });

  els.trySampleInline.addEventListener('click', () => {
    void loadSample();
  });

  els.queueAdd.addEventListener('click', () => {
    if (state.busy !== 'idle') return;
    focusQueue();
    els.queueInput.click();
  });

  els.queueSettingsChange.addEventListener('click', () => {
    els.sessionStrip.scrollIntoView({ behavior: 'smooth', block: 'center' });
    window.setTimeout(() => els.sessionModelSelect.focus({ preventScroll: true }), 350);
  });

  els.queueInput.addEventListener('change', () => {
    const files = [...(els.queueInput.files ?? [])];
    els.queueInput.value = '';
    if (!files.length) return;

    let rejected = 0;
    for (const file of files) {
      if (!isSupportedFile(file)) {
        rejected += 1;
        continue;
      }
      queueFiles.push({ file, status: 'queued' });
    }

    renderQueue();
    if (rejected) {
      showToast(`${rejected} · ${translateUi('Not audio or video')}`);
    } else {
      showToast(`${translateUi('Added to queue')} · ${files.length}`);
    }
  });

  els.queueClear.addEventListener('click', () => {
    if (queueRunning) return;
    queueFiles.length = 0;
    els.queueStatus.textContent = '';
    renderQueue();
  });

  els.queueStart.addEventListener('click', () => {
    void runQueue();
  });
  els.queueCancel.addEventListener('click', () => {
    // First click: finish the current file, then stop. Second click: stop now.
    if (!queuePauseRequested) {
      queuePauseRequested = true;
      els.queueCancel.textContent = translateUi('Stop now');
      els.queueStatus.textContent = translateUi('The queue will pause after this file.');
      return;
    }
    state.controller?.abort();
    els.queueCancel.disabled = true;
    els.queueStatus.textContent = translateUi('Stopping the current file…');
  });

  els.queueList.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const retry = target.closest<HTMLButtonElement>('[data-queue-retry]');
    if (retry) {
      const entry = queueFiles[Number(retry.dataset.queueRetry)];
      if (entry) {
        entry.status = 'queued';
        entry.error = undefined;
        void runQueue(entry);
      }
      return;
    }
    const download = target.closest<HTMLButtonElement>('[data-queue-download]');
    if (download) {
      const entry = queueFiles[Number(download.dataset.queueDownload)];
      if (entry?.text) {
        const name = entry.file.name.replace(/\.[^.]+$/, '') || 'transcript';
        saveBlob(new Blob([entry.text, '\n'], { type: 'text/plain;charset=utf-8' }), `${name}.txt`);
      }
      return;
    }
    if (queueRunning) return;
    const button = target.closest<HTMLButtonElement>('[data-queue-remove]');
    const index = Number(button?.dataset.queueRemove);
    if (!button || Number.isNaN(index)) return;
    queueFiles.splice(index, 1);
    renderQueue();
  });

  els.recordBtn.addEventListener('click', () => {
    void startRecording();
  });

  els.recordStop.addEventListener('click', () => {
    void stopRecording();
  });

  els.recordCancel.addEventListener('click', () => {
    cancelRecording();
  });

  els.presetRow.addEventListener('click', (event) => {
    if (state.busy !== 'idle') return;
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>(
      '[data-preset-id]',
    );
    if (!button) return;
    const preset = JOB_PRESETS.find((entry) => entry.id === button.dataset.presetId);
    if (preset) applyPreset(preset);
  });

  els.exportFormat.addEventListener('change', () => {
    updateDownloadLabel();
  });

  els.polishToggle.addEventListener('change', () => {
    if (els.polishToggle.checked) {
      setStatus('Dictation clean-up will be applied to the next finished transcript.');
    }
  });

  els.historyEnabled.addEventListener('change', () => {
    void toggleHistory(els.historyEnabled.checked);
  });

  els.historyClear.addEventListener('click', () => {
    void clearAllHistory();
  });

  els.historyList.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const remove = target.closest<HTMLButtonElement>('[data-history-delete]');
    if (remove) {
      const id = remove.dataset.historyDelete;
      if (id) void removeHistoryEntry(id);
      return;
    }

    const open = target.closest<HTMLButtonElement>('[data-history-id]');
    if (open) {
      const id = open.dataset.historyId;
      if (id) void openHistoryEntry(id);
    }
  });

  els.forceCpu.addEventListener('change', () => {
    setInferenceDevice(els.forceCpu.checked);
  });

  els.deviceWebgpu.addEventListener('click', () => {
    setInferenceDevice(false);
  });

  els.deviceCpu.addEventListener('click', () => {
    setInferenceDevice(true);
  });

  els.sessionPreload.addEventListener('click', () => {
    void preloadModel();
  });

  els.sessionCancel.addEventListener('click', () => {
    if (!state.controller) return;
    state.controller.abort();
    els.sessionCancel.disabled = true;
    els.sessionCancel.textContent = 'Cancelling…';
  });

  els.benchmarkBtn.addEventListener('click', () => {
    void runBenchmark();
  });
  els.benchmarkCancel.addEventListener('click', () => state.controller?.abort());

  els.receiptRun.addEventListener('click', () => {
    receiptArmed = true;
    receiptBuckets = new Map();
    els.receiptResult.classList.add('hidden');
    els.receiptStatus.textContent =
      'Armed. Start a transcription; the next run will be recorded.';
  });

  els.receiptClear.addEventListener('click', () => {
    resetReceipt();
  });

  els.installApp.addEventListener('click', () => {
    void installApp();
  });

  els.ttsText.addEventListener('input', updateTtsCount);

  els.ttsVoiceGrid.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const preview = target.closest<HTMLButtonElement>('[data-voice-preview]');
    if (preview) {
      const id = preview.dataset.voicePreview;
      if (id) void previewVoice(id);
      return;
    }

    const card = target.closest<HTMLButtonElement>('[data-voice-id]');
    if (!card) return;
    const id = card.dataset.voiceId;
    if (!id) return;
    els.ttsVoice.value = id;
    renderVoiceSelection();
  });

  els.ttsVoiceGrid.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const card = (event.target as HTMLElement).closest<HTMLElement>('[data-voice-id]');
    if (!card) return;
    event.preventDefault();
    els.ttsVoice.value = card.dataset.voiceId ?? '';
    renderVoiceSelection();
  });

  window.addEventListener('beforeunload', (event) => {
    if (state.busy !== 'idle' || recording) {
      event.preventDefault();
      event.returnValue = '';
    }
  });

  if ('ResizeObserver' in window) {
    const observer = new ResizeObserver(() => {
      if (state.audio) scheduleWaveformDraw();
    });
    observer.observe(els.waveform);
  }
}

/* -------------------------------------------------------------------------- */
/* File handling                                                              */
/* -------------------------------------------------------------------------- */

async function handleFile(file: File): Promise<'cancelled' | void> {
  if (state.busy !== 'idle') return;

  clearError();

  if (!isSupportedFile(file)) {
    showError(
      new AppError(`“${file.name}” is not a supported audio file.`, {
        code: 'UNSUPPORTED_FILE',
        hint: 'Use OGG, WAV, MP3, M4A, MP4, or WebM. If the file is audio with a different extension, convert it first.',
      }),
    );
    els.fileInput.value = '';
    return;
  }

  resetAudio();
  resetTranscript();

  state.file = file;
  els.fileInfo.classList.remove('hidden');
  els.fileName.textContent = file.name;
  els.fileMeta.textContent = `${formatBytes(file.size)} · decoding locally…`;
  els.progressPanel.classList.remove('hidden');
  els.progressStatus.textContent = 'Reading audio locally…';
  els.downloadProgress.classList.add('hidden');
  els.inferenceProgress.classList.add('hidden');

  const controller = new AbortController();
  state.controller = controller;
  setBusy('decoding');

  try {
    const source = await openWaveSource(file);
    const streamed = source && source.duration >= 120 ? source : null;
    const decoded = streamed ?? await decodeAudioFile(file, {
      signal: controller.signal,
      onFallback: (message) => {
        els.fileMeta.textContent = `${formatBytes(file.size)} · ${message}`;
      },
    });
    if (controller.signal.aborted) throw controller.signal.reason;
    if (streamed) {
      const { peaks } = await summarizeWave(streamed, controller.signal);
      state.sourcePeaks = peaks;
    }
    state.audio = decoded;

    const url = URL.createObjectURL(file);
    state.objectUrl = url;
    els.audioPlayer.src = url;
    els.audioPlayer.classList.remove('hidden');
    els.waveform.classList.remove('hidden');
    els.fileMeta.textContent = `${formatBytes(file.size)} · ${formatDuration(decoded.duration)} · ${
      decoded.originalChannels === 1 ? 'mono' : `${decoded.originalChannels}ch`
    } ${Math.round(decoded.originalSampleRate / 1000)} kHz → 16 kHz mono`;

    scheduleWaveformDraw();
    els.transcribeBtn.disabled = false;
    setStatus(`Ready to transcribe ${formatDuration(decoded.duration)} of audio on this device.`);
  } catch (error) {
    resetAudio();
    if (controller.signal.aborted) {
      setStatus('Audio import cancelled.');
      return 'cancelled';
    }
    showError(error);
  } finally {
    state.controller = null;
    els.fileInput.value = '';
    setBusy('idle');
  }
}

/* -------------------------------------------------------------------------- */
/* Sample, microphone, presets, URL state                                     */
/* -------------------------------------------------------------------------- */

async function getSampleFile(): Promise<File> {
  if (sampleFile) return sampleFile;

  const response = await fetch(SAMPLE_URL, { cache: 'force-cache' });
  if (!response.ok) {
    throw new AppError('The sample clip could not be loaded.', {
      code: 'SAMPLE_UNAVAILABLE',
      hint: 'Check the connection, or drop your own audio file instead.',
    });
  }

  const blob = await response.blob();
  sampleFile = new File([blob], 'jfk-sample.wav', {
    type: 'audio/wav',
    lastModified: Date.now(),
  });
  return sampleFile;
}

async function loadSample(): Promise<void> {
  if (state.busy !== 'idle') return;
  navigate('transcribe');
  clearError();

  try {
    const file = await getSampleFile();
    await handleFile(file);
    if (state.busy !== 'idle' || !state.audio) return;

    const model = currentModel();
    const variant = currentVariant();
    const status = await getModelCacheStatus(model.id, variant.id, currentClean()).catch(
      () => null,
    );

    if (status?.cached) {
      await transcribe();
      return;
    }

    setStatus(
      `Sample ready. Transcribe to download ${formatBytes(variant.approxBytes)} and run ${model.name}.`,
    );
    els.transcribeBtn.focus();
    showToast('Sample loaded. One click to transcribe.');
  } catch (error) {
    showError(error);
  }
}

async function startRecording(): Promise<void> {
  if (state.busy !== 'idle' || recording) return;

  clearError();
  resetAudio();
  resetTranscript();

  recording = true;
  els.recordPanel.classList.remove('hidden');
  els.recordLevel.style.width = '2%';
  els.recordTime.textContent = '0:00';
  setBusy('recording');
  setStatus('Requesting microphone access…');

  try {
    await recorder.start(({ elapsed, level }) => {
      els.recordTime.textContent = formatDuration(elapsed);
      els.recordLevel.style.width = `${Math.max(2, Math.round(level * 100))}%`;
    });
    setStatus('Recording. Press Stop and transcribe when you are done.');
  } catch (error) {
    recording = false;
    els.recordPanel.classList.add('hidden');
    setBusy('idle');
    showError(error);
  }
}

async function stopRecording(): Promise<void> {
  if (!recording) return;

  els.recordStop.disabled = true;
  els.recordStop.textContent = 'Finishing…';

  try {
    const file = await recorder.stop();
    recording = false;
    els.recordPanel.classList.add('hidden');
    els.recordLevel.style.width = '0%';
    setBusy('idle');
    await handleFile(file);
    if (state.busy === 'idle' && state.audio) await transcribe();
  } catch (error) {
    recording = false;
    els.recordPanel.classList.add('hidden');
    setBusy('idle');
    if (!isAbortError(error)) showError(error);
  } finally {
    els.recordStop.disabled = false;
    els.recordStop.textContent = 'Stop and transcribe';
  }
}

function cancelRecording(): void {
  if (!recording) return;
  recorder.cancel();
  recording = false;
  els.recordPanel.classList.add('hidden');
  els.recordLevel.style.width = '0%';
  els.recordTime.textContent = '0:00';
  setBusy('idle');
  setStatus('Recording cancelled.');
}

/**
 * Whether the selected speech model will actually run on the CPU. Granite
 * Speech requires WebGPU and ignores the CPU preference, so labels must not
 * claim WASM for it.
 */
function modelRunsOnCpu(model = currentModel()): boolean {
  if (model.pipeline === 'granite-speech') return false;
  return state.forceCpu || !state.webgpu.supported;
}

function renderQueueSettings(): void {
  const model = currentModel();
  const variant = currentVariant();
  const rawLabel = variant.label;
  const variantLabel = rawLabel.startsWith(model.name)
    ? rawLabel.slice(model.name.length).replace(/^[\s·-]+/, '')
    : rawLabel;
  const parts = [variantLabel || variant.id, modelRunsOnCpu(model) ? 'WASM' : model.pipeline === 'granite-speech' ? 'WebGPU (required)' : 'WebGPU'];
  if (model.languageOptions?.length) {
    const language = els.languageSelect.selectedOptions[0]?.textContent?.trim();
    parts.push(language || 'Auto-detect');
  }
  if (currentClean()) parts.push('Clean mode');
  els.queueModel.textContent = model.name;
  els.queueConfig.textContent = '· ' + parts.join(' · ');
}

function renderQueue(): void {
  renderQueueSettings();
  const count = queueFiles.length;
  const hasFiles = count > 0;
  els.queuePanel.classList.toggle('hidden', !hasFiles);
  els.queueEmpty.classList.toggle('hidden', hasFiles);
  els.queueCount.textContent = `${translateUi('Files')} · ${count}`;
  els.queueStart.disabled =
    !queueFiles.some((entry) => entry.status !== 'done') || queueRunning || state.busy !== 'idle';
  els.queueClear.disabled = queueRunning || count === 0;
  els.queueCancel.classList.toggle('hidden', !queueRunning);
  els.queueCancel.disabled = !queueRunning || Boolean(state.controller?.signal.aborted);
  if (!queueRunning) els.queueCancel.textContent = translateUi('Pause queue');
  els.queueAddPage.disabled = queueRunning || state.busy !== 'idle';
  els.queueSettingsChange.disabled = queueRunning || state.busy !== 'idle';

  els.queueList.innerHTML = queueFiles
    .map(
      ({ file, status, text, error }, index) => `
        <div class="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/5 bg-white/[0.03] px-2 py-1.5">
          <span class="min-w-0 flex-1 truncate text-[10px] text-slate-300" data-no-i18n>${escapeHtml(
            file.name,
          )}</span>
          <span class="shrink-0 font-mono text-[9px] text-slate-400">${formatBytes(
            file.size,
          )}</span>
          <span class="text-[10px] text-slate-400" role="status">${{
            queued: 'Queued', running: 'Processing', failed: 'Failed',
            cancelled: 'Cancelled', empty: 'No speech found', done: 'Complete',
          }[status]}</span>
          ${text ? `<button type="button" data-queue-download="${index}" class="btn-ghost" aria-label="${escapeHtml(translateUi('Download transcript'))} · ${escapeHtml(file.name)}">TXT</button>` : ''}
          ${status === 'failed' || status === 'cancelled' || status === 'empty'
            ? `<button type="button" data-queue-retry="${index}" class="btn-ghost" ${queueRunning || state.busy !== 'idle' ? 'disabled' : ''} aria-label="${escapeHtml(translateUi('Retry'))} · ${escapeHtml(file.name)}">${escapeHtml(translateUi('Retry'))}</button>`
            : ''}
          <button
            type="button"
            data-queue-remove="${index}"
            class="icon-btn h-6 w-6 shrink-0"
            aria-label="${escapeHtml(translateUi('Remove from queue'))} · ${escapeHtml(file.name)}"
            ${queueRunning ? 'disabled' : ''}
          >×</button>
          ${error ? `<p class="w-full text-[10px] text-rose-300">${escapeHtml(error)}</p>` : ''}
        </div>
      `,
    )
    .join('');
}

async function runQueue(only?: (typeof queueFiles)[number]): Promise<void> {
  if (queueRunning || state.busy !== 'idle') return;
  const pending = only ? [only] : queueFiles.filter((entry) => entry.status !== 'done');
  if (!pending.length) return;

  queueRunning = true;
  queuePauseRequested = false;
  renderQueue();

  const total = pending.length;
  let done = 0;
  let cancelled = false;

  try {
    for (const entry of pending) {
      entry.status = 'running';
      entry.error = undefined;
      els.queueStatus.textContent = `${translateUi('Processing')} ${entry.file.name}…`;
      renderQueue();
      const imported = await handleFile(entry.file);
      const outcome = imported ?? (state.audio && state.file === entry.file ? await transcribe() : 'failed');
      entry.status = outcome ?? 'failed';
      if (entry.status === 'failed') {
        entry.error = els.errorMessage.textContent || 'The file could not be transcribed.';
      }
      if (entry.status === 'done') {
        entry.text = els.transcript.value;
        done += 1;
      }
      renderQueue();
      if (entry.status === 'cancelled' || queuePauseRequested) {
        cancelled = true;
        break;
      }
    }
  } finally {
    queueRunning = false;
    renderQueue();
  }

  const message = `${translateUi(cancelled ? 'Queue paused' : 'Queue finished')} · ${done}/${total}`;
  els.queueStatus.textContent = message;
  setStatus(message);
  showToast(message);
}

function renderPresets(): void {
  els.presetRow.innerHTML = JOB_PRESETS.map((preset) => {
    const active = preset.modelId === state.modelId;
    const blocked = Boolean(preset.requiresWebGPU && !state.webgpu.supported);
    const classes = active
      ? 'border-indigo-400/50 bg-indigo-500/[0.10] text-white'
      : 'border-white/10 bg-white/[0.03] text-slate-300 hover:border-white/20 hover:text-white';

    return `
      <button
        type="button"
        data-preset-id="${preset.id}"
        aria-pressed="${active}"
        ${blocked ? 'disabled' : ''}
        title="${blocked ? 'This preset needs WebGPU, which is unavailable here.' : preset.detail}"
        class="rounded-xl border px-3 py-2 text-left transition disabled:cursor-not-allowed disabled:opacity-40 ${classes}"
      >
        <span class="block text-[11px] font-semibold">${preset.label}</span>
        <span class="mt-0.5 block text-[9px] text-slate-400">${preset.detail}</span>
      </button>
    `;
  }).join('');
}

function applyPreset(preset: JobPreset): void {
  const model = getModel(preset.modelId);
  state.modelId = model.id;
  state.variantId = model.defaultVariant;
  state.language =
    preset.language && model.languageOptions?.includes(preset.language)
      ? preset.language
      : '';
  els.cleanMode.checked = Boolean(preset.clean && model.cleanMode);

  renderModelPicker();
  handleModelSettingsChange();
  els.dropZone.scrollIntoView({ behavior: 'smooth', block: 'center' });
  showToast(`Preset: ${preset.label} · ${model.name}`);
}

function applyUrlState(): void {
  const params = new URLSearchParams(location.search);
  const preset = JOB_PRESETS.find((entry) => entry.id === params.get('preset'));

  if (preset) {
    const model = getModel(preset.modelId);
    state.modelId = model.id;
    state.variantId = model.defaultVariant;
    state.language =
      preset.language && model.languageOptions?.includes(preset.language)
        ? preset.language
        : '';
    els.cleanMode.checked = Boolean(preset.clean && model.cleanMode);
  }

  const model = params.get('model');
  if (model && SUPPORTED_MODELS.some((entry) => entry.id === model)) {
    state.modelId = model as ModelId;
    state.variantId = getModel(state.modelId).defaultVariant;
  }

  const variant = params.get('variant');
  if (
    variant &&
    getModel(state.modelId).variants.some((entry) => entry.id === variant)
  ) {
    state.variantId = variant;
  }

  const language = params.get('lang');
  if (language && getModel(state.modelId).languageOptions?.includes(language)) {
    state.language = language;
  }

  if (params.get('clean') === '1' && getModel(state.modelId).cleanMode) {
    els.cleanMode.checked = true;
  }

  if (params.get('cpu') === '1') {
    state.forceCpu = true;
    els.forceCpu.checked = true;
  }

  if (preset || params.get('model')) initialView = 'transcribe';
  if (params.get('tab') === 'tts') initialView = 'tts';
}

function syncUrlState(): void {
  const params = new URLSearchParams(location.search);
  const model = currentModel();

  if (state.modelId === initialSelection.modelId) params.delete('model');
  else params.set('model', state.modelId);

  if (state.variantId === model.defaultVariant) params.delete('variant');
  else params.set('variant', state.variantId);

  if (state.language) params.set('lang', state.language);
  else params.delete('lang');

  if (currentClean()) params.set('clean', '1');
  else params.delete('clean');

  if (state.forceCpu) params.set('cpu', '1');
  else params.delete('cpu');

  params.delete('tab');

  params.delete('preset');
  params.delete('sample');

  const query = params.toString();
  window.history.replaceState(
    null,
    '',
    `${location.pathname}${query ? `?${query}` : ''}${location.hash}`,
  );
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

/* -------------------------------------------------------------------------- */
/* Export, history, stats                                                     */
/* -------------------------------------------------------------------------- */

function renderExportFormats(): void {
  els.exportFormat.replaceChildren();
  for (const format of EXPORT_FORMATS) {
    const option = document.createElement('option');
    option.value = format.id;
    option.textContent = `${format.label} · .${format.extension}`;
    els.exportFormat.append(option);
  }
  els.exportFormat.value = 'txt';
  updateDownloadLabel();
}

function updateDownloadLabel(): void {
  const format = els.exportFormat.value as ExportFormat;
  const meta = EXPORT_FORMATS.find((entry) => entry.id === format);
  setButtonLabel(els.downloadBtn, `Download .${meta?.extension ?? 'txt'}`);
}

function currentExportMeta(): ExportMeta {
  return (
    state.exportMeta ?? {
      duration: state.audio?.duration ?? 0,
      fileName: state.file?.name ?? null,
      modelName: currentModel().name,
      createdAt: new Date(),
    }
  );
}

function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.style.display = 'none';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function renderHistoryControls(): void {
  els.historyEnabled.checked = isHistoryEnabled();
  els.historyClear.disabled = !els.historyEnabled.checked;
  if (!els.historyEnabled.checked) {
    els.historyList.innerHTML =
      '<p class="rounded-lg border border-white/5 bg-white/[0.03] px-3 py-2 text-[10px] leading-relaxed text-slate-400">History is off. Nothing is saved.</p>';
  }
}

async function refreshHistory(): Promise<void> {
  if (!isHistoryEnabled()) {
    renderHistoryControls();
    return;
  }

  try {
    const entries = await listHistory();
    renderHistoryList(entries);
  } catch {
    els.historyList.innerHTML =
      '<p class="rounded-lg border border-amber-400/20 bg-amber-400/[0.06] px-3 py-2 text-[10px] leading-relaxed text-amber-300">History storage is unavailable in this browser context.</p>';
  }
}

function renderHistoryList(entries: HistoryEntry[]): void {
  if (!entries.length) {
    els.historyList.innerHTML =
      '<p class="rounded-lg border border-white/5 bg-white/[0.03] px-3 py-2 text-[10px] leading-relaxed text-slate-400">No saved transcripts yet.</p>';
    els.historyClear.disabled = true;
    return;
  }

  els.historyClear.disabled = false;
  els.historyList.innerHTML = entries
    .map((entry) => {
      const excerpt = entry.text.replace(/\s+/g, ' ').slice(0, 90);
      const date = new Date(entry.createdAt).toLocaleString();
      return `
        <div class="flex items-start gap-2 rounded-lg border border-white/5 bg-white/[0.03] p-2">
          <button type="button" data-history-id="${entry.id}" class="min-w-0 flex-1 text-left">
            <span class="block truncate text-[11px] font-medium text-slate-200">${escapeHtml(
              entry.fileName ?? 'Untitled recording',
            )}</span>
            <span class="mt-0.5 block truncate text-[10px] text-slate-400">${escapeHtml(
              date,
            )} · ${formatDuration(entry.duration)} · ${escapeHtml(entry.modelName)}</span>
            <span class="mt-0.5 block truncate text-[10px] text-slate-400">${escapeHtml(
              excerpt,
            )}</span>
          </button>
          <button type="button" data-history-delete="${entry.id}" class="icon-btn shrink-0" aria-label="Delete this saved transcript">
            <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
              <path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13M10 11v5M14 11v5" />
            </svg>
          </button>
        </div>
      `;
    })
    .join('');
}

async function toggleHistory(enabled: boolean): Promise<void> {
  setHistoryEnabled(enabled);
  els.historyClear.disabled = !enabled;

  if (!enabled) {
    await deleteHistoryDatabase().catch(() => undefined);
    els.historyList.innerHTML =
      '<p class="rounded-lg border border-white/5 bg-white/[0.03] px-3 py-2 text-[10px] leading-relaxed text-slate-400">History is off. Nothing is saved.</p>';
    showToast('History deleted from this device.');
    return;
  }

  showToast('History is on. New transcripts are saved locally.');
  await refreshHistory();
}

function persistTranscript(text: string): void {
  if (!isHistoryEnabled() || !state.exportMeta) return;

  const entry: HistoryEntry = lastHistoryEntry = {
    id: newHistoryId(),
    createdAt: Date.now(),
    modelId: state.modelId,
    modelName: state.exportMeta.modelName,
    variantId: state.variantId,
    fileName: state.exportMeta.fileName,
    duration: state.exportMeta.duration,
    backend: state.engine?.backend ?? 'wasm',
    text,
    segments: state.segments.map((segment) => ({
      start: segment.start,
      end: segment.end,
      text: segment.text,
      words: segment.words,
    })),
  };

  void saveHistory(entry)
    .then(refreshHistory)
    .catch(() => showToast('The transcript could not be saved to history.'));
}

async function openHistoryEntry(id: string): Promise<void> {
  if (state.busy !== 'idle') return;

  const entry = await getHistory(id);
  if (!entry) {
    showToast('That history entry is gone.');
    await refreshHistory();
    return;
  }

  resetAudio();
  state.segments = entry.segments.map((segment) => ({
    start: segment.start,
    end: segment.end,
    text: segment.text,
    partial: false,
    words: segment.words,
  }));
  state.exportMeta = {
    duration: entry.duration,
    fileName: entry.fileName,
    modelName: entry.modelName,
    createdAt: new Date(entry.createdAt),
  };

  els.transcript.value = entry.text;
  lastHistoryEntry = entry;
  navigate('transcribe');
  renderSegments();
  updateCounts();
  updateTranscriptButtons();

  els.runStats.classList.remove('hidden');
  els.runStats.textContent = `${formatDuration(entry.duration)} audio · ${
    entry.modelName
  } · saved ${new Date(entry.createdAt).toLocaleString()} · audio is not stored`;
  setStatus('History entry loaded. The original audio is not kept by this app.');
  showToast('Loaded from history.');
}

async function removeHistoryEntry(id: string): Promise<void> {
  await deleteHistory(id).catch(() => undefined);
  await refreshHistory();
}

async function clearAllHistory(): Promise<void> {
  const confirmed = window.confirm(
    translateUi('Delete every saved transcript from this browser? This cannot be undone.'),
  );
  if (!confirmed) return;

  await clearHistory().catch(() => undefined);
  await refreshHistory();
  showToast('Saved transcripts deleted.');
}

function showRunStats(stats: RunStats, modelName: string): void {
  const seconds = stats.runMs / 1000;
  const speed = seconds > 0 ? stats.audioSeconds / seconds : 0;
  els.runStats.classList.remove('hidden');
  els.runStats.textContent =
    `${formatDuration(stats.audioSeconds)} audio · ${seconds.toFixed(1)} s decode · ${speed.toFixed(
      1,
    )}× real time · ${stats.segments} segment${stats.segments === 1 ? '' : 's'} · ${
      stats.backend
    }${stats.loadMs > 0 ? ` · ${(stats.loadMs / 1000).toFixed(1)} s model load` : ''}`;
  els.runStats.title = `Model: ${modelName}`;
}

/* -------------------------------------------------------------------------- */
/* Benchmark                                                                  */
/* -------------------------------------------------------------------------- */

async function runBenchmark(): Promise<void> {
  if (state.busy !== 'idle') return;

  const model = currentModel();
  const variant = currentVariant();
  const controller = new AbortController();
  const { signal } = controller;
  const jobs: Array<{ label: string; options: ConstructorParameters<typeof AsrClient>[0] }> = [];
  const options = { modelId: model.id, variantId: variant.id, clean: currentClean(), language: state.language };
  const selected = `${model.name} · ${variant.id}`;
  if (state.webgpu.supported && !['moonshine', 'whisper', 'omnilingual', 'cactus'].includes(model.pipeline)) {
    jobs.push({ label: `${selected} · WebGPU requested`, options: { ...options, useWebGPU: true } });
  }
  if (model.pipeline !== 'granite-speech') {
    jobs.push({ label: `${selected} · CPU`, options: { ...options, useWebGPU: false } });
  }
  if (els.benchmarkReference.checked) {
    jobs.push({ label: 'WebGPU.Studio · Whisper Tiny English WASM preset', options: {
      modelId: STUDIO_WHISPER_MODEL_ID, variantId: STUDIO_WHISPER_VARIANT_ID, clean: false, useWebGPU: false,
    } });
  }
  if (!jobs.length) {
    els.benchmarkStatus.textContent = 'The selected model requires WebGPU.';
    return;
  }

  state.controller = controller;
  setBusy('benchmarking');
  els.benchmarkResult.classList.remove('hidden');
  els.benchmarkResult.textContent = 'Reference · ' + SAMPLE_TRANSCRIPT;
  els.benchmarkStatus.textContent = 'Loading the sample clip…';
  let failures = 0;

  try {
    const decoded = await decodeAudioFile(await getSampleFile());
    if (!decoded.samples.length) throw new Error('The sample clip produced no audio.');
    signal.throwIfAborted();
    if (state.engine) await dropEngine();

    for (const job of jobs) {
      signal.throwIfAborted();
      els.benchmarkStatus.textContent = `${job.label} · loading…`;
      const engine = new AsrClient(job.options);
      try {
        const { modelId, variantId, clean } = job.options;
        const cache = await getModelCacheStatus(modelId, variantId, clean).catch(() => null);
        const cacheLabel = !cache?.available ? 'cache unavailable' : cache.cached
          ? 'weights cached' : cache.bytes > 0 ? 'weights partly cached' : 'weights uncached';
        signal.throwIfAborted();
        const loadStart = performance.now();
        await engine.load(signal);
        const loadMs = performance.now() - loadStart;
        els.benchmarkStatus.textContent = `${job.label} · warming up and timing three passes…`;
        const result = await engine.transcribe(decoded.samples, { signal });
        const timings = [];
        for (let pass = 0; pass < 3; pass += 1) {
          const start = performance.now();
          await engine.transcribe(decoded.samples, { signal });
          timings.push(performance.now() - start);
        }
        const runMs = timings.sort((a, b) => a - b)[1];
        const wer = wordErrorRate(SAMPLE_TRANSCRIPT, result.text) * 100;
        const speed = decoded.duration / (runMs / 1000);
        els.benchmarkResult.textContent += `\n\n${job.label} (${engine.backend}) · ${wer.toFixed(1)}% WER\nLoad ${(loadMs / 1000).toFixed(2)} s (${cacheLabel}) · Warm ${(runMs / 1000).toFixed(2)} s · ${speed.toFixed(1)}× real time\n${result.text || 'No transcript'}`;
      } catch (error) {
        if (signal.aborted) throw error;
        failures += 1;
        els.benchmarkResult.textContent += `\n\n${job.label} · ${describeError(error)}`;
      } finally {
        await engine.dispose();
      }
    }
    els.benchmarkStatus.textContent = failures
      ? 'Benchmark finished with errors. See results below.'
      : 'Benchmark complete. Load time includes any required downloads.';
  } catch (error) {
    els.benchmarkStatus.textContent = signal.aborted ? 'Benchmark cancelled.' : describeError(error);
  } finally {
    state.controller = null;
    setBusy('idle');
    void refreshCacheStatus();
    void refreshStorageStatus();
  }
}

/* -------------------------------------------------------------------------- */
/* Session strip / proof strip                                                */
/* -------------------------------------------------------------------------- */

function renderSessionStatus(
  text: string,
  tone: 'idle' | 'busy' | 'ready' | 'warn',
): void {
  els.sessionStatus.textContent = text;
  const dot = els.sessionStatusDot;
  dot.classList.remove('is-ready', 'is-busy', 'is-warn');
  if (tone === 'ready') dot.classList.add('is-ready');
  else if (tone === 'busy') dot.classList.add('is-busy');
  else if (tone === 'warn') dot.classList.add('is-warn');
}

function renderSession(): void {
  const model = currentModel();
  const variant = currentVariant();
  const fit = modelFit(model, variant, deviceProfile);
  const status = modelCacheStates.get(variantCacheKey(model.id, variant.id));
  const loaded =
    state.engine?.modelId === model.id &&
    state.engine.variantId === variant.id;

  els.sessionModel.textContent = model.name;
  els.sessionModelSelect.value = model.id;
  els.sessionDetail.textContent = `${variant.label} · ${model.bestFor}`;
  setBadge(els.sessionFit, fit.label, fit.tone);
  els.sessionFit.title = fit.detail;

  if (state.engine?.modelId === model.id) {
    setBadge(els.sessionCache, 'Ready now', 'good');
  } else if (status?.cached) {
    setBadge(els.sessionCache, 'Cached', 'good');
  } else if (status && status.filesCached > 0) {
    setBadge(els.sessionCache, 'Partial', 'warn');
  } else if (status) {
    setBadge(els.sessionCache, 'Not cached', 'muted');
  } else {
    setBadge(els.sessionCache, 'Checking…', 'muted');
  }

  const webgpuAvailable = state.webgpu.supported;
  const webgpuOnly = currentModel().pipeline === 'granite-speech';
  const onCpu = modelRunsOnCpu();
  els.deviceWebgpu.disabled = state.busy !== 'idle' || !webgpuAvailable;
  // A WebGPU-only model cannot run on the CPU, so the toggle shows WebGPU
  // as the active device and explains why CPU is unavailable.
  els.deviceCpu.disabled = state.busy !== 'idle' || webgpuOnly;
  els.deviceCpu.title = webgpuOnly ? 'This model requires WebGPU and cannot run on the CPU.' : '';
  els.deviceWebgpu.setAttribute('aria-pressed', String(webgpuAvailable && !onCpu));
  els.deviceCpu.setAttribute('aria-pressed', String(onCpu));

  if (state.busy === 'loading') {
    renderSessionStatus('Loading model…', 'busy');
  } else if (state.busy === 'transcribing') {
    renderSessionStatus('Transcribing…', 'busy');
  } else if (state.busy === 'decoding') {
    renderSessionStatus('Decoding audio…', 'busy');
  } else if (loaded) {
    renderSessionStatus('Ready', 'ready');
  } else if (status?.cached) {
    renderSessionStatus('Cached · ready to load', 'idle');
  } else if (status && status.filesCached > 0) {
    renderSessionStatus('Partial download', 'warn');
  } else if (state.webgpu.supported) {
    renderSessionStatus('Not loaded', 'idle');
  } else {
    renderSessionStatus('WASM CPU', 'idle');
  }

  els.sessionModelSelect.disabled = state.busy !== 'idle';
  els.sessionVariantSelect.disabled = state.busy !== 'idle';
  els.sessionPreload.disabled =
    state.busy !== 'idle' ||
    (model.pipeline === 'granite-speech' && !state.webgpu.supported);
  setButtonLabel(
    els.sessionPreload,
    state.busy === 'loading'
      ? 'Loading…'
      : loaded
        ? 'Reload model'
        : status?.cached
          ? 'Load model'
          : 'Download & load',
  );

  const cached = Boolean(status?.cached);
  els.downloadHint.textContent =
    model.pipeline === 'granite-speech' && !state.webgpu.supported
      ? 'This model requires WebGPU and will not run in this browser.'
      : cached
        ? 'Model is cached. This run loads from disk.'
        : `First run downloads about ${formatBytes(variant.approxBytes)} from Hugging Face.`;

}

/* -------------------------------------------------------------------------- */
/* TTS gallery, count, install                                                */
/* -------------------------------------------------------------------------- */

interface VoiceCard {
  id: string;
  title: string;
  meta: string;
  grade: string;
}

function currentVoiceCards(): VoiceCard[] {
  const plugin = ttsPlugin();
  if (plugin) {
    return plugin.voices().map((voice) => ({ id: voice.id, title: voice.title, meta: voice.meta, grade: voice.grade ?? '' }));
  }

  if (ttsModelId === 'reverb') {
    return [
      {
        id: 'reference',
        title: reverbVoice ? 'Reference voice · ready' : 'Reference voice',
        meta: reverbClip
          ? `${reverbClip.name} · ${REVERB_LANGUAGES.find((entry) => entry.id === reverbLanguage)?.label ?? reverbLanguage}`
          : 'Add a clip to clone',
        grade: 'NC',
      },
    ];
  }

  if (ttsModelId === 'woof') {
    return WOOF_VOICES.map((voice) => {
      const [title, meta] = voice.label.split(' · ');
      return {
        id: voice.id,
        title: title ?? voice.label,
        meta: meta ?? '',
        grade: 'NC',
      };
    });
  }

  if (ttsModelId === 'kokoro') {
    return KOKORO_VOICES.map((voice) => {
      const [title, meta, grade] = voice.label.split(' · ');
      return {
        id: voice.id,
        title: title ?? voice.label,
        meta: meta ?? '',
        grade: grade ?? '',
      };
    });
  }

  return [
    { id: '0', title: 'F2', meta: 'Female · American English', grade: '' },
    { id: '1', title: 'M2', meta: 'Male · American English', grade: '' },
  ];
}

function renderVoiceGallery(): void {
  const voices = currentVoiceCards();
  const selected = els.ttsVoice.value || voices[0]?.id || '';

  els.ttsVoiceGrid.innerHTML = voices
    .map((voice) => {
      const active = voice.id === selected;
      return `
        <div
          role="button"
          tabindex="0"
          data-voice-id="${voice.id}"
          aria-pressed="${active}"
          class="voice-card ${active ? 'voice-card-active' : ''}"
        >
          <span class="flex items-start justify-between gap-2">
            <span class="min-w-0">
              <span class="block truncate text-[11px] font-semibold text-white">${escapeHtml(
                voice.title,
              )}</span>
              <span class="mt-0.5 block truncate text-[9px] text-slate-400">${escapeHtml(
                voice.meta,
              )}</span>
            </span>
            ${voice.grade ? `<span class="badge badge-muted shrink-0">${escapeHtml(voice.grade)}</span>` : ''}
          </span>
          <button
            type="button"
            data-voice-preview="${voice.id}"
            class="mt-2 w-full rounded-lg border border-white/10 bg-white/5 px-2 py-2 text-[10px] font-medium text-slate-300 transition hover:border-white/20 hover:text-white"
            aria-label="Preview ${escapeHtml(voice.title)}"
          >Preview</button>
        </div>
      `;
    })
    .join('');

  renderVoiceSelection();
}

function renderVoiceSelection(): void {
  const voices = currentVoiceCards();
  let selected = els.ttsVoice.value;

  if (!voices.some((voice) => voice.id === selected)) {
    const first = voices[0]?.id ?? '';
    els.ttsVoice.value = first;
    selected = first;
  }

  for (const card of els.ttsVoiceGrid.querySelectorAll<HTMLElement>('[data-voice-id]')) {
    const active = card.dataset.voiceId === selected;
    card.classList.toggle('voice-card-active', active);
    card.setAttribute('aria-pressed', String(active));
  }

  const current = voices.find((voice) => voice.id === selected);
  els.ttsVoiceSummary.textContent = `${voices.length} voice${
    voices.length === 1 ? '' : 's'
  }${current ? ` · ${current.title}` : ''}`;
}

async function previewVoice(id: string): Promise<void> {
  if (ttsBusy || previewBusy) return;

  const key = ttsModelId === 'kokoro'
    ? `${ttsModelId}:${ttsKokoroDevice}:${id}`
    : `${ttsModelId}:${ttsLanguage}:${id}`;
  const cached = previewUrls.get(key);

  if (cached) {
    els.ttsPreviewAudio.src = cached;
    els.ttsPreviewAudio.classList.remove('hidden');
    await els.ttsPreviewAudio.play().catch(() => undefined);
    return;
  }

  previewBusy = true;
  els.ttsKokoroDevice.disabled = true;
  els.ttsStatus.textContent = 'Preparing a local voice preview…';

  try {
    let result: TtsResult;
    const plugin = ttsPlugin();

    if (plugin) {
      await plugin.load((progress) => {
        els.ttsStatus.textContent = withTransfer(ttsMeter, progress.text, progress.loaded, progress.total);
      });
      const audio = await plugin.speak({
        text: plugin.languages ? previewTextFor(ttsLanguage || plugin.defaultLanguage || 'en') : PREVIEW_TEXT,
        voice: id,
        speed: 1,
        language: ttsLanguage || plugin.defaultLanguage,
      });
      result = ttsResultFromSamples(audio.samples, audio.sampleRate);
    } else if (ttsModelId === 'kokoro') {
      if (!kokoroEngine) kokoroEngine = new KokoroEngine(ttsKokoroDevice);
      await kokoroEngine.load((progress) => {
        els.ttsStatus.textContent = withTransfer(ttsMeter, progress.text, progress.loaded, progress.total);
      });
      result = await kokoroEngine.speak(PREVIEW_TEXT, id, 1);
    } else if (ttsModelId === 'woof') {
      if (!woofEngine) woofEngine = new WoofTtsEngine();
      await woofEngine.load((progress) => {
        els.ttsStatus.textContent = progress.phase === 'download' && !progress.cached
          ? withTransfer(ttsMeter, 'Downloading Woof weights', progress.loaded, progress.total)
          : woofProgressText(progress);
      });
      result = await woofEngine.speak(PREVIEW_TEXT, id, (progress) => {
        els.ttsStatus.textContent = woofProgressText(progress);
      });
    } else if (ttsModelId === 'reverb') {
      const voice = reverbVoice ?? (await buildReverbVoice());
      if (!voice || !reverbEngine) {
        els.ttsStatus.textContent =
          'Add a reference clip and transcript to preview the cloned voice.';
        return;
      }
      const audio = await reverbEngine.speak(PREVIEW_TEXT, voice);
      result = ttsResultFromSamples(audio.samples, audio.sampleRate);
    } else {
      if (!ttsEngine) ttsEngine = new TinyVocaEngine(ttsPhonemizerMode);
      await ttsEngine.load((progress) => {
        els.ttsStatus.textContent = withTransfer(ttsMeter, progress.text, progress.loaded, progress.total);
      });
      result = await ttsEngine.speak(PREVIEW_TEXT, Number(id), 1);
    }

    previewUrls.set(key, result.url);
    els.ttsPreviewAudio.src = result.url;
    els.ttsPreviewAudio.classList.remove('hidden');
    await els.ttsPreviewAudio.play().catch(() => undefined);
    els.ttsStatus.textContent =
      'Preview ready. Pick another voice or generate the full text.';
  } catch (error) {
    els.ttsStatus.textContent = describeError(error);
  } finally {
    previewBusy = false;
    els.ttsKokoroDevice.disabled = ttsBusy;
  }
}

function updateTtsCount(): void {
  const length = els.ttsText.value.length;
  els.ttsCount.textContent = `${length.toLocaleString()} / ${TTS_TEXT_LIMIT.toLocaleString()}`;
  els.ttsCount.classList.toggle('text-rose-300', length >= TTS_TEXT_LIMIT);
}

function updateReverbUi(): void {
  if (ttsModelId !== 'reverb') return;

  const hasClip = Boolean(reverbClip);
  const hasTranscript = els.ttsReverbTranscript.value.trim().length > 0;
  const ready = Boolean(reverbVoice);
  const blocked = !state.webgpu.supported;

  els.ttsReverbBuild.disabled = reverbBusy || blocked || !hasClip || !hasTranscript;
  setButtonLabel(
    els.ttsReverbBuild,
    reverbBusy
      ? 'Building…'
      : ready
        ? 'Rebuild voice'
        : 'Build voice',
  );

  if (blocked) {
    els.ttsReverbVoiceStatus.textContent =
      'Reverb-TTS needs WebGPU, which this browser does not expose.';
  } else if (reverbBusy) {
    els.ttsReverbVoiceStatus.textContent = 'Building the reference voice…';
  } else if (ready) {
    els.ttsReverbVoiceStatus.textContent = 'Reference voice ready. Generate speech or preview it below.';
  } else if (!hasClip) {
    els.ttsReverbVoiceStatus.textContent =
      'Add a clip and its transcript to build a reusable voice.';
  } else if (!hasTranscript) {
    els.ttsReverbVoiceStatus.textContent =
      'Type what the reference clip says, then build the voice.';
  } else {
    els.ttsReverbVoiceStatus.textContent = 'Ready to build the reference voice.';
  }
}

const REVERB_MIN_SECONDS = 3;
const REVERB_MAX_SECONDS = 20;

async function loadReverbClip(file = els.ttsReverbClip.files?.[0]): Promise<boolean> {
  const request = ++reverbBuildToken;
  reverbVoice = null;
  reverbClip = null;
  invalidateReverbPreview();
  updateReverbUi();

  if (!file) {
    els.ttsReverbClipStatus.textContent =
      'Choose a short recording of one speaker. The clip is decoded locally and never uploaded.';
    renderVoiceGallery();
    return false;
  }

  els.ttsReverbClipStatus.textContent = `Decoding ${file.name}…`;

  try {
    const decoded = await decodeAudioFile(file, {
      onFallback: (message) => { els.ttsReverbClipStatus.textContent = `${file.name} · ${message}`; },
    });
    if (request !== reverbBuildToken) return false;
    // Reverb needs 3-20 s of one speaker. Shorter clips give a poor voice and
    // longer ones exceed what the reference encoder was built for.
    if (decoded.duration < REVERB_MIN_SECONDS || decoded.duration > REVERB_MAX_SECONDS) {
      els.ttsReverbClipStatus.textContent = `${file.name} · ${formatDuration(decoded.duration)} · ` +
        `the reference clip must be ${REVERB_MIN_SECONDS}-${REVERB_MAX_SECONDS} seconds. ` +
        (decoded.duration < REVERB_MIN_SECONDS ? 'Choose a longer clip.' : 'Trim it in Audio studio, or choose a shorter clip.');
      els.ttsStatus.textContent = 'The reference clip length is outside 3-20 seconds.';
      updateReverbUi();
      renderVoiceGallery();
      return false;
    }
    reverbClip = {
      samples: decoded.samples,
      sampleRate: TARGET_SAMPLE_RATE,
      name: file.name,
    };
    els.ttsReverbClipStatus.textContent = `${file.name} · ${formatDuration(
      decoded.duration,
    )} · 16 kHz mono · local only`;
    els.ttsStatus.textContent =
      'Reference clip decoded. Add its transcript, then build the voice.';
  } catch (error) {
    if (request !== reverbBuildToken) return false;
    els.ttsReverbClipStatus.textContent =
      error instanceof Error ? error.message : 'Could not decode that clip.';
    els.ttsStatus.textContent = 'Could not decode the reference clip.';
  }

  updateReverbUi();
  renderVoiceGallery();
  return Boolean(reverbClip);
}

async function buildReverbVoice(
  signal?: AbortSignal,
  onProgress?: (progress: ReverbProgress) => void,
): Promise<ReverbVoice | null> {
  if (reverbBusy) return reverbVoice;
  if (!reverbClip) {
    els.ttsStatus.textContent = 'Add a reference clip first.';
    return null;
  }

  const transcript = els.ttsReverbTranscript.value.trim();
  if (!transcript) {
    els.ttsStatus.textContent = 'Type what the reference clip says first.';
    els.ttsReverbTranscript.focus();
    return null;
  }

  if (!state.webgpu.supported) {
    els.ttsStatus.textContent =
      'Reverb-TTS needs WebGPU, which this browser does not expose.';
    return null;
  }

  const token = ++reverbBuildToken;
  reverbBusy = true;
  updateReverbUi();
  els.ttsReverbVoiceStatus.textContent = 'Starting the Reverb runtime…';

  try {
    if (!reverbEngine) reverbEngine = new ReverbEngine();

    await reverbEngine.load((progress) => {
      const percent =
        progress.phase === 'runtime'
          ? 5
          : progress.phase === 'ready'
            ? 95
            : progress.total && progress.total > 0
              ? 10 + (progress.loaded ?? 0) / progress.total * 80
              : 30;
      const text = withTransfer(ttsMeter, progress.text, progress.loaded, progress.total);
      els.ttsReverbVoiceStatus.textContent = text;
      if (onProgress) onProgress({ ...progress, text });
      else {
        els.ttsStatus.textContent = text;
        els.ttsProgress.classList.remove('hidden');
        els.ttsProgressLabel.textContent = text;
        els.ttsProgressDetail.textContent = `${Math.round(percent)}%`;
        setBar(els.ttsProgressBar, percent);
      }
    }, signal);

    if (token !== reverbBuildToken) return null;

    els.ttsReverbVoiceStatus.textContent = 'Encoding the reference voice…';
    const voice = await reverbEngine.createVoice(
      reverbClip.samples,
      reverbClip.sampleRate,
      transcript,
      reverbLanguage,
    );

    if (token !== reverbBuildToken) return null;

    reverbVoice = voice;
    els.ttsReverbVoiceStatus.textContent = `Voice ready · ${voice.frames} codec frames · ${REVERB_LANGUAGES.find(
      (entry) => entry.id === reverbLanguage,
    )?.label ?? reverbLanguage}`;
    els.ttsStatus.textContent =
      'Reference voice ready. Generate speech in that voice.';
    renderVoiceGallery();
    return voice;
  } catch (error) {
    if (!isAbortError(error)) {
      els.ttsReverbVoiceStatus.textContent = describeError(error);
      els.ttsStatus.textContent = describeError(error);
    }
    return null;
  } finally {
    if (token === reverbBuildToken) {
      reverbBusy = false;
      updateReverbUi();
    }
  }
}

function woofProgressText(progress: WoofProgress): string {
  if (progress.phase === 'download') {
    if (progress.cached) return 'Loading Woof weights from the local cache…';
    const mb = (loaded: number) => (loaded / 1_000_000).toFixed(1);
    const total = progress.total > 0 ? ` of ${mb(progress.total)} MB` : '';
    return `Downloading Woof weights · ${mb(progress.loaded)}${total} MB…`;
  }
  if (progress.phase === 'prepare') return 'Preparing the Woof runtime…';
  if (progress.piece) {
    return `Synthesizing with Woof · sentence ${progress.piece} of ${progress.pieces ?? progress.piece}…`;
  }
  return 'Synthesizing with Woof…';
}

function updateTtsDownloadHint(): void {
  const plugin = ttsPlugin();
  if (plugin) {
    els.ttsDownloadHint.textContent = plugin.downloadHint;
    return;
  }

  if (ttsModelId === 'kokoro') {
    els.ttsDownloadHint.textContent =
      ttsKokoroDevice === 'wasm-q8'
        ? 'First generation downloads about 88 MB (Q8). Later runs use the local cache.'
        : 'First generation downloads about 325 MB (FP32). Later runs use the local cache.';
    return;
  }

  if (ttsModelId === 'woof') {
    els.ttsDownloadHint.textContent =
      'First generation downloads about 41 MB and caches it locally. Voice by Underdog Woof · non-commercial license.';
    return;
  }

  if (ttsModelId === 'reverb') {
    els.ttsDownloadHint.textContent =
      'First generation downloads the int4 Reverb model (~191 MB) plus the codec and caches them in OPFS. Reverb-TTS is non-commercial.';
    return;
  }

  els.ttsDownloadHint.textContent =
    'The 21 MB tiny-voca model is bundled with the site, so there is no model download.';
}

/* -------------------------------------------------------------------------- */
/* Vision & image                                                             */
/* -------------------------------------------------------------------------- */

const VISION_COLORS = [
  '#818cf8',
  '#22d3ee',
  '#34d399',
  '#fbbf24',
  '#fb7185',
  '#a78bfa',
  '#f97316',
  '#38bdf8',
  '#4ade80',
  '#f472b6',
  '#facc15',
  '#2dd4bf',
];

function renderVisionTask(): void {
  const task = getVisionTask(visionTaskId);

  if (!els.visionTaskGrid.childElementCount) {
    els.visionTaskGrid.innerHTML = VISION_TASKS.map((entry) => `
      <button type="button" data-vision-task="${entry.id}" class="vision-task" aria-pressed="false">
        <img class="vision-task-preview" src="${import.meta.env.BASE_URL}vision-previews/${entry.id}.webp" width="320" height="320" alt="" loading="lazy" decoding="async" draggable="false" />
        <span class="vision-task-title">${escapeHtml(entry.short)}</span>
      </button>
    `).join('');
  }

  els.visionActiveTool.textContent = task.short;
  els.visionTaskDescription.textContent = task.description;

  const selected = visionModelByTask.get(task.id) ?? task.defaultModel;
  visionModelByTask.set(task.id, selected);
  els.visionModel.replaceChildren();
  for (const model of task.models) {
    const option = document.createElement('option');
    option.value = model.id;
    option.textContent = model.label;
    els.visionModel.append(option);
  }
  els.visionModel.value = selected;

  const model = getVisionModel(task, selected);
  els.visionModelLink.href = `https://huggingface.co/${model.id}`;

  els.visionThresholdField.classList.toggle(
    'hidden',
    task.output !== 'boxes',
  );

  const webgpuOption = els.visionDevice.querySelector<HTMLOptionElement>(
    'option[value="webgpu"]',
  );
  if (webgpuOption) {
    webgpuOption.disabled = !state.webgpu.supported;
    webgpuOption.textContent = state.webgpu.supported
      ? 'WebGPU'
      : 'WebGPU · unavailable';
  }
  if (!state.webgpu.supported && visionDevice === 'webgpu') {
    visionDevice = 'wasm';
  }
  if (state.webgpu.supported && !visionDeviceTouched) {
    visionDevice = 'webgpu';
  }
  els.visionDevice.value = visionDevice;
  const canUseHalf = visionDevice === 'webgpu' && state.webgpu.shaderF16;
  if (!canUseHalf && visionPrecisionByModel.get(model.id) === 'fp16') visionPrecisionByModel.delete(model.id);
  const precision = effectiveVisionPrecision(model);
  const sizes = { fp32: model.approxBytes, fp16: model.halfBytes, q8: model.compactBytes };
  // SAM 3 ships 4-bit weights; its precision choice only changes activations.
  const quantized = task.output === 'select';
  els.visionPrecision.replaceChildren(new Option(quantized ? `4-bit / FP32 · ${formatBytes(sizes.fp32)}` : `FP32 · ${formatBytes(sizes.fp32)}`, 'fp32'));
  if (sizes.q8) els.visionPrecision.add(new Option(`Q8 · ${formatBytes(sizes.q8)}`, 'q8'));
  if (canUseHalf && sizes.fp16) {
    els.visionPrecision.add(new Option(quantized ? `4-bit / FP16 · ${formatBytes(sizes.fp16)}` : `FP16 · ${formatBytes(sizes.fp16)}`, 'fp16'), 1);
  }
  els.visionPrecision.value = precision;
  els.visionModelNote.textContent = model.note + ' The model is cached after download. Images are processed locally.';

  for (const button of els.visionTaskGrid.querySelectorAll<HTMLButtonElement>('button')) {
    button.setAttribute('aria-pressed', String(button.dataset.visionTask === task.id));
    button.disabled = visionBusy;
  }
  els.visionModel.disabled = visionBusy;
  els.visionDevice.disabled = visionBusy;
  els.visionPrecision.disabled = visionBusy;
  const loaded = isVisionModelLoaded({ task: task.id, model: model.id, device: visionDevice, precision });
  els.visionLoad.disabled = visionBusy || visionImageLoading || loaded;
  setButtonLabel(els.visionLoad, loaded ? 'Model ready' : 'Load model');
  if (!visionBusy) setButtonLabel(els.visionRun, task.output === 'select' ? 'Start selection' : task.short);
  els.visionRun.disabled = visionBusy || visionImageLoading || !visionSource;
  els.visionDrop.setAttribute('aria-disabled', String(visionBusy || visionImageLoading));
}

/**
 * The precision a vision model runs at: the user's pick, else the model's
 * default, limited to builds that exist and to what this device can run.
 */
function effectiveVisionPrecision(model: ReturnType<typeof getVisionModel>): VisionPrecision {
  let precision = visionPrecisionByModel.get(model.id) ?? model.defaultPrecision ?? 'fp32';
  if (precision === 'q8' && !model.compactBytes) precision = 'fp32';
  if (precision === 'fp16' && (!model.halfBytes || !(visionDevice === 'webgpu' && state.webgpu.shaderF16))) precision = 'fp32';
  return precision;
}

async function loadVisionImage(file: File): Promise<void> {
  if (visionBusy || visionImageLoading) {
    els.visionStatus.textContent = 'Wait for the current vision task to finish.';
    return;
  }

  if (!file.type.startsWith('image/')) {
    els.visionStatus.textContent = 'Choose an image file (PNG, JPEG, WebP, or BMP).';
    return;
  }

  els.visionStatus.textContent = `Decoding ${file.name}…`;
  visionImageLoading = true;
  els.visionRun.disabled = true;
  els.visionLoad.disabled = true;
  els.visionDrop.setAttribute('aria-disabled', 'true');

  try {
    const { RawImage } = await import('@huggingface/transformers');
    const image = await RawImage.fromBlob(file);

    if (visionSourceUrl) URL.revokeObjectURL(visionSourceUrl);
    visionSourceUrl = URL.createObjectURL(file);
    visionSourceFile = file;
    visionSource = image;
    visionPoints = [];

    els.visionPreview.src = visionSourceUrl;
    els.visionPreview.classList.remove('hidden');
    els.visionPreviewEmpty.classList.add('hidden');
    els.visionDrop.setAttribute('aria-label', `Replace image: ${file.name}`);
    els.visionFileName.textContent = `${file.name} · ${image.width}×${image.height}`;

    clearVisionResult();
    els.visionStatus.textContent = 'Image ready.';
  } catch (error) {
    // Drop the previous image so Run cannot silently process a picture the
    // user just tried to replace.
    if (visionSourceUrl) URL.revokeObjectURL(visionSourceUrl);
    visionSourceUrl = null;
    visionSourceFile = null;
    visionSource = null;
    visionPoints = [];
    els.visionPreview.removeAttribute('src');
    els.visionPreview.classList.add('hidden');
    els.visionPreviewEmpty.classList.remove('hidden');
    els.visionDrop.setAttribute('aria-label', 'Add an image');
    els.visionFileName.textContent = '';
    clearVisionResult();
    els.visionStatus.textContent = `Could not decode ${file.name}: ${describeError(
      error,
    )}. Choose another image.`;
  } finally {
    visionImageLoading = false;
  }

  renderVisionTask();
}

function clearVisionResult(): void {
  document.getElementById('vision-ocr-actions')?.remove();
  els.visionStatus.textContent = '';
  els.visionCanvas.classList.add('hidden');
  els.visionCanvas.style.cursor = '';
  els.visionComparison.hidden = true;
  els.visionOriginal.removeAttribute('src');
  els.visionResultEmpty.classList.remove('hidden');
  els.visionResultEmpty.textContent = visionSource ? 'Run the selected tool to see its result.' : 'Add an image to get started.';
  els.visionSummary.textContent = '';
  els.visionLegend.replaceChildren();
  els.visionCaption.classList.add('hidden');
  els.visionCaption.textContent = '';
  els.visionDownload.classList.add('hidden');
  els.visionProgress.classList.add('hidden');

  if (visionResultUrl) {
    URL.revokeObjectURL(visionResultUrl);
    visionResultUrl = null;
  }
}

function updateVisionComparison(): void {
  const slider = els.visionComparisonSlider;
  els.visionComparison.style.setProperty('--vision-split', `${slider.value}%`);
  slider.setAttribute('aria-valuetext', `${slider.value}% original`);
}

function rawImageData(image: RawImage): ImageData {
  const { width, height, data } = image;
  const channels = image.channels;
  if (channels === 4 && data.length === width * height * 4) {
    // The decoder already produced RGBA. A typed-array view avoids copying
    // 48 MB for a 12 MP image.
    return new ImageData(
      new Uint8ClampedArray(data.buffer as ArrayBuffer, data.byteOffset, data.length),
      width,
      height,
    );
  }
  const out = new Uint8ClampedArray(width * height * 4);

  for (let index = 0; index < width * height; index += 1) {
    const source = index * channels;
    const target = index * 4;
    if (channels === 1) {
      const value = data[source];
      out[target] = value;
      out[target + 1] = value;
      out[target + 2] = value;
      out[target + 3] = 255;
    } else if (channels === 2) {
      const value = data[source];
      out[target] = value;
      out[target + 1] = value;
      out[target + 2] = value;
      out[target + 3] = data[source + 1];
    } else {
      out[target] = data[source];
      out[target + 1] = data[source + 1];
      out[target + 2] = data[source + 2];
      out[target + 3] = channels === 4 ? data[source + 3] : 255;
    }
  }

  return new ImageData(out, width, height);
}

function drawRawImage(canvas: HTMLCanvasElement, image: RawImage): void {
  // Preview canvases are display-sized, not source-sized. The full-resolution
  // image/File is still kept for inference and download.
  const scale = Math.min(1, 1600 / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  canvas.width = width;
  canvas.height = height;
  canvas.parentElement?.style.setProperty('--vision-image-ratio', String(image.width / image.height));
  const context = canvas.getContext('2d');
  if (!context) return;
  const pixels = rawImageData(image);
  if (scale === 1) {
    context.putImageData(pixels, 0, 0);
    return;
  }
  const source = document.createElement('canvas');
  source.width = image.width;
  source.height = image.height;
  source.getContext('2d')?.putImageData(pixels, 0, 0);
  context.drawImage(source, 0, 0, width, height);
}

function drawSourceImage(canvas: HTMLCanvasElement): void {
  if (visionSource) drawRawImage(canvas, visionSource);
}

function visionDownloadBlob(
  blob: Blob,
  filename: string,
): void {
  if (visionResultUrl) URL.revokeObjectURL(visionResultUrl);
  visionResultUrl = URL.createObjectURL(blob);
  els.visionDownload.href = visionResultUrl;
  els.visionDownload.download = filename;
  els.visionDownload.classList.remove('hidden');
}

function renderVisionLegend(
  items: Array<{ label: string; score: number }>,
  showColors: boolean,
): void {
  els.visionLegend.innerHTML = items
    .slice(0, 10)
    .map((item, index) => {
      const color = VISION_COLORS[index % VISION_COLORS.length];
      return `
        <div class="flex items-center justify-between gap-2 rounded-lg border border-white/5 bg-white/[0.03] px-2 py-1">
          <span class="flex min-w-0 items-center gap-1.5">
            ${showColors ? `<span class="h-2 w-2 shrink-0 rounded-full" style="background:${color}"></span>` : ''}
            <span class="truncate text-[10px] text-slate-300">${escapeHtml(item.label)}</span>
          </span>
          <span class="shrink-0 font-mono text-[9px] text-slate-500">${(item.score * 100).toFixed(1)}%</span>
        </div>
      `;
    })
    .join('');
}

/** Undo and reset buttons for click-to-select. */
function renderSelectActions(): void {
  document.getElementById('vision-ocr-actions')?.remove();
  if (!visionPoints.length) return;
  const row = document.createElement('div');
  row.id = 'vision-ocr-actions';
  row.className = 'mt-2 flex flex-wrap gap-2';
  const undo = document.createElement('button');
  undo.type = 'button';
  undo.className = 'btn-secondary';
  undo.textContent = 'Undo last click';
  undo.addEventListener('click', () => {
    visionPoints = visionPoints.slice(0, -1);
    void runVisionTask();
  });
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'btn-ghost';
  reset.textContent = 'Clear clicks';
  reset.addEventListener('click', () => {
    visionPoints = [];
    void runVisionTask();
  });
  row.append(undo, reset);
  els.visionCaption.after(row);
}

/** Copy and read-aloud buttons under the OCR text. */
function renderOcrActions(text: string): void {
  document.getElementById('vision-ocr-actions')?.remove();
  if (!text) return;
  const row = document.createElement('div');
  row.id = 'vision-ocr-actions';
  row.className = 'mt-2 flex flex-wrap gap-2';
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'btn-secondary';
  copy.textContent = 'Copy text';
  copy.addEventListener('click', () => {
    void navigator.clipboard?.writeText(text).then(() => showToast('Text copied.'), () => showToast('Copy is blocked in this browser.'));
  });
  const speak = document.createElement('button');
  speak.type = 'button';
  speak.className = 'btn-ghost';
  speak.textContent = 'Read it aloud';
  speak.addEventListener('click', () => {
    els.ttsText.value = text.slice(0, TTS_TEXT_LIMIT);
    updateTtsCount();
    navigate('tts');
  });
  row.append(copy, speak);
  els.visionCaption.after(row);
}

async function drawVisionResult(result: VisionResult): Promise<void> {
  document.getElementById('vision-ocr-actions')?.remove();
  els.visionCanvas.classList.remove('hidden');
  els.visionResultEmpty.classList.add('hidden');

  if (result.kind === 'image') {
    drawRawImage(els.visionCanvas, result.image);
    if (visionSourceUrl) {
      els.visionOriginal.src = visionSourceUrl;
      els.visionComparisonSlider.value = '50';
      updateVisionComparison();
      els.visionComparison.hidden = false;
    }
    const blob = await result.image.toBlob('image/png');
    visionDownloadBlob(blob, `${visionTaskId}.png`);
    const source = visionSourceFile;
    if (source) {
      const row = document.createElement('div');
      row.id = 'vision-ocr-actions';
      row.className = 'mt-3';
      const refine = document.createElement('button');
      refine.type = 'button';
      refine.className = 'btn-secondary';
      refine.textContent = 'Refine mask';
      refine.addEventListener('click', () => {
        navigate('tools');
        void loadQuickTools().then(studio => studio.refine(source, blob)).catch(error => showToast(describeError(error)));
      });
      row.append(refine);
      els.visionCaption.after(row);
    }
    els.visionSummary.textContent = `Transparent PNG · ${result.image.width}×${result.image.height}`;
    return;
  }

  if (result.kind === 'depth') {
    drawRawImage(els.visionCanvas, result.image);
    const blob = await result.image.toBlob('image/png');
    visionDownloadBlob(blob, 'depth-map.png');
    els.visionSummary.textContent = `Depth map · ${result.image.width}×${result.image.height} · near is bright`;
    return;
  }

  if (result.kind === 'scene') {
    drawSourceImage(els.visionCanvas);
    const context = els.visionCanvas.getContext('2d');
    if (!context) return;
    const { width, height } = els.visionCanvas;
    const objects = (result.scene.objects ?? []).slice().sort((a, b) => b.score - a.score);
    // Mirage boxes are on a 0–1000 grid.
    objects.forEach((object, index) => {
      const color = VISION_COLORS[index % VISION_COLORS.length];
      const [x1, y1, x2, y2] = object.bbox;
      const x = (x1 / 1000) * width;
      const y = (y1 / 1000) * height;
      context.strokeStyle = color;
      context.lineWidth = Math.max(2, width / 400);
      context.strokeRect(x, y, ((x2 - x1) / 1000) * width, ((y2 - y1) / 1000) * height);
      context.font = `700 ${Math.max(11, width / 60)}px ui-sans-serif, system-ui, sans-serif`;
      const label = object.name;
      const labelWidth = context.measureText(label).width + 8;
      context.fillStyle = color;
      context.fillRect(x, Math.max(0, y - 20), labelWidth, 20);
      context.fillStyle = '#070b14';
      context.fillText(label, x + 4, Math.max(14, y - 6));
    });
    renderVisionLegend(objects.map((object) => {
      const details = Object.values(object.description ?? {}).filter(Boolean).join(', ');
      return { label: details ? `${object.name} · ${details}` : object.name, score: object.score };
    }), true);
    const scene = Object.values(result.scene.scene ?? {}).filter(Boolean).join(' · ');
    const summary = (result.scene.reasoning ?? '').split('|').map((part) => part.trim()).filter((part) => part && !part.startsWith('lang:'))[0] ?? '';
    const text = (result.scene.text ?? []).filter((entry) => entry.score >= 0.4).map((entry) => entry.string);
    const name = (id: number) => result.scene.objects?.find((object) => object.id === id)?.name ?? 'object';
    const relations = (result.scene.relations ?? []).slice(0, 6).map((relation) => `${name(relation.subject)} ${relation.predicate.replace(/_/g, ' ')} ${name(relation.object)}`);
    els.visionCaption.textContent = [
      summary && `Summary: ${summary}`,
      scene && `Scene: ${scene}`,
      relations.length ? `Relations: ${relations.join('; ')}` : '',
      text.length ? `Text: ${text.join(', ')}` : '',
    ].filter(Boolean).join('\n');
    els.visionCaption.classList.remove('hidden');
    els.visionSummary.textContent = `${objects.length} object${objects.length === 1 ? '' : 's'} · Mirage scene graph`;
    visionDownloadBlob(new Blob([`${JSON.stringify(result.scene, null, 2)}\n`], { type: 'application/json' }), 'scene.json');
    return;
  }

  if (result.kind === 'select') {
    drawSourceImage(els.visionCanvas);
    const context = els.visionCanvas.getContext('2d');
    if (!context) return;
    // Dim everything outside the selection and tint the selection.
    const pixels = context.getImageData(0, 0, result.width, result.height);
    const data = pixels.data;
    for (let i = 0; i < result.mask.length; i += 1) {
      const o = i * 4;
      if (result.mask[i]) {
        data[o] = data[o] * 0.6 + 129 * 0.4;
        data[o + 1] = data[o + 1] * 0.6 + 140 * 0.4;
        data[o + 2] = data[o + 2] * 0.6 + 248 * 0.4;
      } else {
        data[o] *= 0.35;
        data[o + 1] *= 0.35;
        data[o + 2] *= 0.35;
      }
    }
    context.putImageData(pixels, 0, 0);
    const radius = Math.max(5, result.width / 120);
    for (const point of result.points) {
      context.beginPath();
      context.arc(point.x, point.y, radius, 0, Math.PI * 2);
      context.fillStyle = point.positive ? '#34d399' : '#f87171';
      context.fill();
      context.lineWidth = Math.max(2, radius / 3);
      context.strokeStyle = '#ffffff';
      context.stroke();
    }
    els.visionCanvas.style.cursor = 'crosshair';
    const blob = await result.cutout.toBlob('image/png');
    visionDownloadBlob(blob, 'selection.png');
    const area = result.mask.reduce((sum, value) => sum + (value ? 1 : 0), 0) / result.mask.length;
    els.visionSummary.textContent = `Selection · ${Math.round(area * 100)}% of the image · confidence ${Math.round(result.score * 100)}%`;
    els.visionCaption.textContent = visionPoints.length
      ? 'Click to add more of the object. Shift-click or right-click to remove an area.'
      : 'Selected the object in the centre. Click the object you want, or Shift-click / right-click to remove an area.';
    els.visionCaption.classList.remove('hidden');
    renderSelectActions();
    return;
  }

  if (result.kind === 'ocr') {
    drawSourceImage(els.visionCanvas);
    const context = els.visionCanvas.getContext('2d');
    if (!context) return;
    const width = els.visionCanvas.width;
    result.lines.forEach((line, index) => {
      const color = VISION_COLORS[index % VISION_COLORS.length];
      context.strokeStyle = color;
      context.lineWidth = Math.max(2, width / 600);
      context.beginPath();
      line.box.forEach(([x, y], corner) => (corner ? context.lineTo(x, y) : context.moveTo(x, y)));
      context.closePath();
      context.stroke();
      const [x, y] = line.box[0];
      context.font = `700 ${Math.max(10, width / 70)}px ui-sans-serif, system-ui, sans-serif`;
      const label = String(index + 1);
      const labelWidth = context.measureText(label).width + 8;
      context.fillStyle = color;
      context.fillRect(x, Math.max(0, y - 18), labelWidth, 18);
      context.fillStyle = '#070b14';
      context.fillText(label, x + 4, Math.max(13, y - 5));
    });
    const text = result.lines.map((line) => line.text).join('\n');
    els.visionSummary.textContent = `${result.lines.length} line${result.lines.length === 1 ? '' : 's'} of text read`;
    renderVisionLegend(result.lines.map((line, index) => ({ label: `${index + 1}. ${line.text}`, score: line.score })), true);
    els.visionCaption.textContent = text || 'No text found.';
    els.visionCaption.classList.remove('hidden');
    renderOcrActions(text);
    const blob = new Blob([text + '\n'], { type: 'text/plain;charset=utf-8' });
    visionDownloadBlob(blob, 'text.txt');
    return;
  }

  if (result.kind === 'boxes') {
    drawSourceImage(els.visionCanvas);
    const context = els.visionCanvas.getContext('2d');
    if (!context) return;
    const width = els.visionCanvas.width;
    const height = els.visionCanvas.height;

    result.items.forEach((item, index) => {
      const color = VISION_COLORS[index % VISION_COLORS.length];
      const x = (item.xmin ?? 0) * width;
      const y = (item.ymin ?? 0) * height;
      const boxWidth = ((item.xmax ?? 0) - (item.xmin ?? 0)) * width;
      const boxHeight = ((item.ymax ?? 0) - (item.ymin ?? 0)) * height;
      context.strokeStyle = color;
      context.lineWidth = Math.max(2, width / 500);
      context.strokeRect(x, y, boxWidth, boxHeight);
      context.font = `600 ${Math.max(11, width / 60)}px ui-sans-serif, system-ui, sans-serif`;
      const label = `${item.label} ${(item.score * 100).toFixed(0)}%`;
      const textWidth = context.measureText(label).width;
      context.fillStyle = color;
      context.fillRect(x, Math.max(0, y - 20), textWidth + 8, 20);
      context.fillStyle = '#070b14';
      context.fillText(label, x + 4, Math.max(14, y - 6));
    });

    els.visionSummary.textContent = `${result.items.length} object${
      result.items.length === 1 ? '' : 's'
    } detected`;
    renderVisionLegend(result.labels, true);
    const blob = await new Promise<Blob | null>((resolve) =>
      els.visionCanvas.toBlob(resolve, 'image/png'),
    );
    if (blob) visionDownloadBlob(blob, 'object-detection.png');
    return;
  }

  if (result.kind === 'mask') {
    drawSourceImage(els.visionCanvas);
    const context = els.visionCanvas.getContext('2d');
    if (!context) return;
    const base = context.getImageData(
      0,
      0,
      els.visionCanvas.width,
      els.visionCanvas.height,
    );
    const width = base.width;
    const height = base.height;

    result.items.forEach((item, index) => {
      const color = VISION_COLORS[index % VISION_COLORS.length];
      const [red, green, blue] = [1, 3, 5].map((offset) =>
        Number.parseInt(color.slice(offset, offset + 2), 16),
      );
      const mask = item.mask;
      const maskChannels = mask.channels;

      for (let y = 0; y < height; y += 1) {
        const maskY = Math.min(
          mask.height - 1,
          Math.floor((y * mask.height) / height),
        );
        for (let x = 0; x < width; x += 1) {
          const maskX = Math.min(
            mask.width - 1,
            Math.floor((x * mask.width) / width),
          );
          const maskIndex = (maskY * mask.width + maskX) * maskChannels;
          const value =
            maskChannels === 1
              ? mask.data[maskIndex]
              : mask.data[maskIndex + maskChannels - 1];
          if (value < 96) continue;
          const target = (y * width + x) * 4;
          base.data[target] = Math.round(
            base.data[target] * 0.45 + red * 0.55,
          );
          base.data[target + 1] = Math.round(
            base.data[target + 1] * 0.45 + green * 0.55,
          );
          base.data[target + 2] = Math.round(
            base.data[target + 2] * 0.45 + blue * 0.55,
          );
        }
      }
    });

    context.putImageData(base, 0, 0);
    els.visionSummary.textContent = `${result.items.length} segment${
      result.items.length === 1 ? '' : 's'
    } found`;
    renderVisionLegend(result.labels, true);
    const blob = await new Promise<Blob | null>((resolve) =>
      els.visionCanvas.toBlob(resolve, 'image/png'),
    );
    if (blob) visionDownloadBlob(blob, 'segmentation.png');
    return;
  }

  if (result.kind === 'labels') {
    els.visionCanvas.classList.add('hidden');
    renderVisionLegend(result.items, false);
    return;
  }

  els.visionCanvas.classList.add('hidden');
  els.visionCaption.textContent = result.text;
  els.visionCaption.classList.remove('hidden');
}

async function runVisionTask(loadOnly = false): Promise<void> {
  if (visionBusy || visionImageLoading) return;
  if (!loadOnly && !visionSource) {
    els.visionStatus.textContent = 'Add an image first.';
    return;
  }

  const task = getVisionTask(visionTaskId);
  const model = visionModelByTask.get(task.id) ?? task.defaultModel;
  const image = visionSource;

  visionBusy = true;
  visionDeviceTouched = true;
  if (!loadOnly) clearVisionResult();
  els.visionProgress.classList.remove('hidden');
  els.visionProgressLabel.textContent = 'Preparing the vision model…';
  els.visionProgressDetail.textContent = '0%';
  setBar(els.visionProgressBar, 0);
  els.visionStatus.textContent = loadOnly
    ? 'Loading the selected model…'
    : `Running ${task.title.toLowerCase()} on this device…`;
  renderVisionTask();
  setButtonLabel(loadOnly ? els.visionLoad : els.visionRun, loadOnly ? 'Loading…' : 'Running…');

  try {
    const options = {
      task: task.id,
      model,
      device: visionDevice,
      precision: effectiveVisionPrecision(getVisionModel(task, model)),
      threshold: Number(els.visionThreshold.value),
      onProgress: (progress: VisionProgress) => {
        const percent = progress.percent ?? (progress.phase === 'running' ? 90 : 10);
        els.visionProgressLabel.textContent = progress.loaded !== undefined && progress.total
          ? `Downloading the model · ${visionMeter.describe(progress.loaded, progress.total)}`
          : progress.text;
        els.visionProgressDetail.textContent = `${Math.round(percent)}%`;
        setBar(els.visionProgressBar, percent);
      },
    };
    if (loadOnly) {
      await preloadVisionModel(options);
      els.visionStatus.textContent = image ? 'Model ready. Run the task on your image.' : 'Model ready. Add an image when you’re ready.';
      return;
    }
    if (!image) return;
    const result = await runVision({ ...options, image, points: visionTaskId === 'select-object' ? visionPoints : undefined });

    await drawVisionResult(result);
    els.visionStatus.textContent = 'Result ready.';
    els.visionProgressDetail.textContent = '100%';
    setBar(els.visionProgressBar, 100);
  } catch (error) {
    console.error('[LocalScribe vision]', error);
    els.visionStatus.textContent = `The vision task failed: ${describeError(error)}`;
    els.visionProgress.classList.add('hidden');
  } finally {
    visionBusy = false;
    els.visionProgress.classList.add('hidden');
    renderVisionTask();
  }
}

async function installApp(): Promise<void> {
  if (!installPrompt) {
    showToast('Use the browser menu → Install app.');
    return;
  }

  try {
    await installPrompt.prompt();
    const choice = await installPrompt.userChoice.catch(() => null);
    installPrompt = null;
    els.installApp.classList.add('hidden');

    if (choice?.outcome === 'accepted') showToast('Installing LocalScribe…');
  } catch {
    installPrompt = null;
    els.installApp.classList.add('hidden');
    showToast('Use the browser menu → Install app.');
  }
}

function resetAudio(): void {
  if (state.objectUrl) {
    URL.revokeObjectURL(state.objectUrl);
    state.objectUrl = null;
  }

  state.file = null;
  state.audio = null;
  state.sourcePeaks = null;
  speakerProbCache = null;
  state.segments = [];
  state.exportMeta = null;
  lastRunStats = null;
  renderSegments();

  els.runStats.classList.add('hidden');
  els.runStats.textContent = '';

  els.audioPlayer.pause();
  els.audioPlayer.removeAttribute('src');
  els.audioPlayer.load();
  els.audioPlayer.classList.add('hidden');
  els.waveform.classList.add('hidden');
  els.fileInfo.classList.add('hidden');
  els.fileName.textContent = '';
  els.fileMeta.textContent = '';
  els.fileInput.value = '';
  els.transcribeBtn.disabled = true;

  clearWaveform();
}

/* -------------------------------------------------------------------------- */
/* Speakers                                                                   */
/* -------------------------------------------------------------------------- */

let speakerLines: SpeakerLine[] | null = null;
let speakerNames: string[] = [];
let diarizing = false;
let speakerProbCache: {
  audio: DecodedAudio | WaveSource;
  webgpu: boolean;
  shaderF16: boolean;
  probs: Float32Array;
  frames: number;
} | null = null;
let lastHistoryEntry: HistoryEntry | null = null;
const SPEAKER_COLORS = ['#818cf8', '#f472b6', '#34d399', '#fbbf24', '#38bdf8', '#fb923c', '#a78bfa', '#f87171'];
const AUTO_SPEAKERS_KEY = 'localscribe.autoSpeakers';

function speakerName(index: number): string {
  return speakerNames[index] || `Speaker ${index + 1}`;
}

function speakerText(lines: SpeakerLine[]): string {
  return lines.map((line) => `${speakerName(line.speaker)}: ${line.text}`).join('\n\n');
}

function renderSpeakerLines(): void {
  const lines = speakerLines ?? [];
  els.segmentPanel.classList.toggle('hidden', !lines.length);
  els.segmentList.innerHTML = lines
    .map((line, index) => `
      <div data-speaker-line="${index}" class="segment-row flex w-full cursor-pointer items-start gap-2 rounded-lg border border-transparent px-2 py-1.5 text-left transition hover:border-white/10 hover:bg-white/5">
        <span class="mt-0.5 shrink-0 font-mono text-[9px] text-slate-400">${formatDuration(line.start)}</span>
        <span class="min-w-0 flex-1 text-[11px] leading-relaxed text-slate-300">
          <button type="button" data-speaker-chip="${line.speaker}" class="speaker-chip" style="--speaker:${SPEAKER_COLORS[line.speaker % SPEAKER_COLORS.length]}" title="Rename this speaker">${escapeHtml(speakerName(line.speaker))}</button>
          ${escapeHtml(line.text)}
        </span>
      </div>`)
    .join('');
}

function renameSpeaker(index: number, chip: HTMLElement): void {
  const input = document.createElement('input');
  input.className = 'speaker-rename';
  input.value = speakerName(index);
  input.setAttribute('aria-label', 'Speaker name');
  chip.replaceWith(input);
  input.focus();
  input.select();
  const commit = (save: boolean) => {
    if (save) {
      const name = input.value.trim().slice(0, 40);
      speakerNames[index] = name;
      if (speakerLines) els.transcript.value = speakerText(speakerLines);
      updateCounts();
      persistSpeakers();
    }
    renderSpeakerLines();
  };
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') commit(true);
    if (event.key === 'Escape') commit(false);
  });
  input.addEventListener('blur', () => commit(true), { once: true });
}

let historyEditTimer = 0;

/** Save manual transcript edits to the matching history entry, debounced. */
function scheduleHistoryEditSave(): void {
  window.clearTimeout(historyEditTimer);
  if (!lastHistoryEntry || !isHistoryEnabled() || speakerLines) return;
  historyEditTimer = window.setTimeout(() => {
    const entry = lastHistoryEntry;
    if (!entry || !isHistoryEnabled()) return;
    entry.text = els.transcript.value;
    entry.segments = realignSegments(entry.segments, entry.text).map((segment) => ({
      start: segment.start,
      end: segment.end,
      text: segment.text,
      words: segment.words,
    }));
    void saveHistory(entry).then(refreshHistory).catch(() => undefined);
  }, 800);
}

/** Update the history entry of this transcript with the speaker turns. */
function persistSpeakers(): void {
  if (!speakerLines || !lastHistoryEntry || !isHistoryEnabled()) return;
  lastHistoryEntry.text = els.transcript.value;
  lastHistoryEntry.segments = speakerLines.map((line) => ({
    start: line.start, end: line.end, text: line.text, speaker: speakerName(line.speaker),
  }));
  void saveHistory(lastHistoryEntry).then(refreshHistory).catch(() => undefined);
}

async function detectSpeakers(): Promise<void> {
  const audio = state.audio;
  if (!audio || diarizing || !state.segments.some((segment) => segment.text.trim())) return;
  diarizing = true;
  updateTranscriptButtons();
  setButtonLabel(els.speakersBtn, 'Detecting…');
  els.speakersStatus.classList.remove('hidden');
  const job = startJob('Detecting speakers', 'transcribe');
  const meter = new TransferMeter();
  const controller = new AbortController();
  try {
    const { alignSpeakers, loadDiarizer, speakerProbabilities, speakerTurns, wordsFromSegments } =
      await import('./diarization');
    await loadDiarizer({
      webgpu: state.webgpu.supported && !state.forceCpu,
      shaderF16: Boolean(state.webgpu.shaderF16),
      signal: controller.signal,
      onProgress: (progress) => {
        els.speakersStatus.textContent = progress.loaded !== undefined && progress.total
          ? `${progress.text} · ${meter.describe(progress.loaded, progress.total)}`
          : progress.text;
        if (progress.loaded !== undefined && progress.total) job.update(progress.loaded / progress.total, progress.text);
      },
    });
    const webgpu = state.webgpu.supported && !state.forceCpu;
    const shaderF16 = Boolean(state.webgpu.shaderF16);
    let probs: Float32Array;
    let frames: number;
    if (
      speakerProbCache?.audio === audio &&
      speakerProbCache.webgpu === webgpu &&
      speakerProbCache.shaderF16 === shaderF16
    ) {
      ({ probs, frames } = speakerProbCache);
      els.speakersStatus.textContent = 'Reusing the speaker analysis for this audio.';
    } else {
      const samples = audio.samples ?? await (audio as unknown as { read: (a: number, b: number) => Promise<Float32Array>; sampleCount: number })
        .read(0, (audio as unknown as { sampleCount: number }).sampleCount);
      const work = new WorkMeter();
      ({ probs, frames } = await speakerProbabilities(samples, {
        signal: controller.signal,
        onProgress: (progress) => {
          if (progress.fraction === undefined) return;
          els.speakersStatus.textContent = `${progress.text} · ${work.describe(progress.fraction)}`;
          job.update(progress.fraction, progress.text);
        },
      }));
      speakerProbCache = { audio, webgpu, shaderF16, probs, frames };
    }
    const turns = speakerTurns(probs, frames);
    const words = wordsFromSegments(state.segments, turns);
    speakerLines = alignSpeakers(words, turns);
    speakerNames = [];
    const count = new Set(speakerLines.map((line) => line.speaker)).size;
    els.transcript.value = speakerText(speakerLines);
    updateCounts();
    renderSpeakerLines();
    persistSpeakers();
    const timing = state.segments.some((segment) => segment.words?.length) ? 'word timings' : 'estimated word timings';
    els.speakersStatus.textContent = `${count} speaker${count === 1 ? '' : 's'} found · ${speakerLines.length} turns · aligned with ${timing}. Click a name to rename it.`;
    job.finish(`${count} speaker${count === 1 ? '' : 's'} found.`);
  } catch (error) {
    els.speakersStatus.textContent = describeError(error);
    job.finish('Speaker detection failed.', false);
  } finally {
    diarizing = false;
    setButtonLabel(els.speakersBtn, 'Detect speakers');
    updateTranscriptButtons();
  }
}

function renderSegments(): void {
  if (speakerLines) {
    renderSpeakerLines();
    return;
  }
  const segments = state.segments;

  if (!segments.length) {
    els.segmentPanel.classList.add('hidden');
    els.segmentList.replaceChildren();
    return;
  }

  els.segmentPanel.classList.remove('hidden');
  els.segmentList.innerHTML = segments
    .map(
      (segment, index) => `
        <button
          type="button"
          data-segment-index="${index}"
          class="segment-row flex w-full items-start gap-2 rounded-lg border border-transparent px-2 py-1.5 text-left transition hover:border-white/10 hover:bg-white/5"
        >
          <span class="mt-0.5 shrink-0 font-mono text-[9px] text-slate-400">${formatDuration(
            segment.start,
          )}</span>
          <span data-segment-text class="min-w-0 flex-1 text-[11px] leading-relaxed ${
            segment.text ? 'text-slate-300' : 'text-slate-400'
          }">${escapeHtml(segment.text || (segment.partial ? 'Listening…' : 'No speech'))}</span>
        </button>
      `,
    )
    .join('');

  highlightSegmentAtTime();
}

function updateSegmentRow(index: number): void {
  const segment = state.segments[index];
  if (!segment) return;
  const row = els.segmentList.querySelector<HTMLElement>(`[data-segment-index="${index}"]`);
  const text = row?.querySelector<HTMLElement>('[data-segment-text]');
  if (!text) {
    renderSegments();
    return;
  }
  const label = segment.text || (segment.partial ? 'Listening…' : 'No speech');
  text.textContent = label;
  text.classList.toggle('text-slate-300', Boolean(segment.text));
  text.classList.toggle('text-slate-400', !segment.text);
}

function highlightSegmentAtTime(): void {
  const time = els.audioPlayer.currentTime || 0;
  // Only the highlighted rows change; scanning the segment array is cheap,
  // touching every row's classList on each timeupdate was not.
  const active = new Set<number>();
  state.segments.forEach((segment, index) => {
    if (time >= segment.start && time < segment.end + 0.05) active.add(index);
  });
  for (const row of els.segmentList.querySelectorAll<HTMLElement>('.segment-active[data-segment-index]')) {
    if (!active.has(Number(row.dataset.segmentIndex))) row.classList.remove('segment-active');
  }
  for (const index of active) {
    els.segmentList.querySelector<HTMLElement>(`[data-segment-index="${index}"]`)?.classList.add('segment-active');
  }
}

function scheduleWaveformDraw(): void {
  if (waveformFrame) cancelAnimationFrame(waveformFrame);
  waveformFrame = requestAnimationFrame(() => {
    waveformFrame = 0;
    drawWaveform();
  });
}

function startWaveformAnimation(): void {
  if (waveformAnimation || els.audioPlayer.paused) return;
  const tick = () => {
    waveformAnimation = 0;
    drawWaveform();
    if (!els.audioPlayer.paused) {
      waveformAnimation = requestAnimationFrame(tick);
    }
  };
  waveformAnimation = requestAnimationFrame(tick);
}

function stopWaveformAnimation(): void {
  if (waveformAnimation) cancelAnimationFrame(waveformAnimation);
  waveformAnimation = 0;
  scheduleWaveformDraw();
}

function drawWaveform(): void {
  const audio = state.audio;
  if (!audio) return;

  const width = els.waveform.clientWidth;
  const height = els.waveform.clientHeight;
  if (width <= 0 || height <= 0) return;

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const pixelWidth = Math.round(width * dpr);
  const pixelHeight = Math.round(height * dpr);
  if (els.waveform.width !== pixelWidth) els.waveform.width = pixelWidth;
  if (els.waveform.height !== pixelHeight) els.waveform.height = pixelHeight;

  const context = els.waveform.getContext('2d');
  if (!context) return;

  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, width, height);

  const bucketCount = Math.max(120, Math.min(900, Math.round(width / 3)));

  if (waveformPeaksFor !== audio || waveformPeaksBuckets !== bucketCount) {
    waveformPeaks = computePeaks(audio.samples ?? state.sourcePeaks ?? new Float32Array(), bucketCount);
    waveformPeaksFor = audio;
    waveformPeaksBuckets = bucketCount;
  }

  const peaks = waveformPeaks;
  if (!peaks) return;

  const barWidth = width / bucketCount;
  const center = height / 2;
  const duration = audio.duration;
  const progress =
    duration > 0
      ? Math.max(0, Math.min(1, els.audioPlayer.currentTime / duration))
      : 0;
  const progressX = width * progress;

  const drawBars = (fill: string | CanvasGradient) => {
    context.fillStyle = fill;
    for (let index = 0; index < bucketCount; index += 1) {
      const amplitude = Math.max(0.02, peaks[index]);
      const barHeight = Math.max(1.5, amplitude * (height - 6));
      const x = index * barWidth;
      context.fillRect(
        x,
        center - barHeight / 2,
        Math.max(1, barWidth - 1),
        barHeight,
      );
    }
  };

  drawBars('rgba(148, 163, 184, 0.24)');

  if (progress > 0) {
    if (waveformGradientWidth !== width || !waveformGradient) {
      waveformGradient = context.createLinearGradient(0, 0, width, 0);
      waveformGradient.addColorStop(0, 'rgba(129, 140, 248, 0.95)');
      waveformGradient.addColorStop(0.5, 'rgba(56, 189, 248, 0.95)');
      waveformGradient.addColorStop(1, 'rgba(34, 211, 238, 0.9)');
      waveformGradientWidth = width;
    }

    context.save();
    context.beginPath();
    context.rect(0, 0, progressX, height);
    context.clip();
    drawBars(waveformGradient);
    context.restore();

    context.fillStyle = 'rgba(224, 231, 255, 0.95)';
    context.fillRect(Math.max(0, progressX - 1), 0, 2, height);
    context.beginPath();
    context.arc(progressX, 4, 3, 0, Math.PI * 2);
    context.fill();
  }

  els.waveform.setAttribute('aria-valuenow', String(Math.round(progress * 100)));
}

function clearWaveform(): void {
  waveformPeaks = null;
  waveformPeaksFor = null;
  waveformPeaksBuckets = 0;
  const context = els.waveform.getContext('2d');
  if (context) {
    context.clearRect(0, 0, els.waveform.width, els.waveform.height);
  }
  els.waveform.width = 0;
  els.waveform.height = 0;
}

/* -------------------------------------------------------------------------- */
/* Model lifecycle                                                            */
/* -------------------------------------------------------------------------- */

async function ensureEngine(signal: AbortSignal): Promise<AsrClient> {
  const gpu = await webgpuReady;
  const model = currentModel();
  const variant = currentVariant();
  const clean = currentClean();
  const forceCpu = state.forceCpu && model.pipeline !== 'granite-speech';
  const wantWebgpu = gpu.supported && !forceCpu;

  if (state.engine && forceCpu && state.engine.backend === 'webgpu') {
    await dropEngine();
  }

  if (
    state.engine?.backend &&
    state.engine.modelId === model.id &&
    state.engine.variantId === variant.id &&
    state.engine.clean === clean &&
    state.engine.language === state.language
  ) {
    setBackend(state.engine.backend);
    return state.engine;
  }

  if (state.engine) {
    await dropEngine();
  }

  if (model.pipeline === 'granite-speech' && !gpu.supported) {
    throw new AppError('Granite Speech requires WebGPU.', {
      code: 'WEBGPU_REQUIRED',
      hint:
        'This browser has no WebGPU adapter, and Granite’s 4-bit embedding has no CPU kernel. Choose Rumble-2-Flash, Qwen3-ASR, Fluid Speech, or Parakeet Redux, or open the app in a WebGPU-capable Chrome or Edge.',
    });
  }

  await requestPersistence().catch(() => false);

  const cacheStatus = await getModelCacheStatus(model.id, variant.id, clean);
  const needed = Math.max(0, variant.approxBytes - cacheStatus.bytes);

  if (needed > 0) {
    const storage = await getStorageInfo();
    if (
      storage.available &&
      storage.quota > 0 &&
      storage.quota - storage.usage < needed * 1.05
    ) {
      throw new AppError(
        `There may not be enough browser storage for ${model.name}.`,
        {
          code: 'LOW_STORAGE',
          hint:
            `It needs about ${formatBytes(needed)} more. ` +
            (variant.approxBytes > 500_000_000
              ? 'Free up disk space or choose a smaller model, such as Parakeet Redux (208 MB).'
              : 'Free up disk space, or clear a cached model you no longer need.'),
        },
      );
    }
  }

  const engine = new AsrClient({
    modelId: model.id,
    variantId: variant.id,
    clean,
    language: state.language,
    useWebGPU: wantWebgpu,
    onProgress: renderLoadProgress,
    onWarning: (message) => showToast(message),
  });

  state.engine = engine;

  try {
    await engine.load(signal);
    setBackend(engine.backend);

    invalidateCacheStatuses();
    await Promise.allSettled([refreshCacheStatus(), refreshStorageStatus()]);
    return engine;
  } catch (error) {
    await engine.dispose().catch(() => undefined);
    if (state.engine === engine) state.engine = null;
    throw error;
  }
}

async function dropEngine(): Promise<void> {
  const engine = state.engine;
  if (!engine) return;
  state.engine = null;
  setBackend(null);
  await engine.dispose().catch(() => undefined);
}

function setInferenceDevice(cpu: boolean): void {
  if (state.busy !== 'idle') {
    els.forceCpu.checked = state.forceCpu;
    renderSession();
    return;
  }

  if (!cpu && !state.webgpu.supported) {
    els.forceCpu.checked = state.forceCpu;
    renderSession();
    showToast('WebGPU is not available in this browser.');
    return;
  }

  if (state.forceCpu === cpu) {
    renderSession();
    return;
  }

  state.forceCpu = cpu;
  els.forceCpu.checked = cpu;
  handleModelSettingsChange();
  showToast(
    cpu
      ? 'WASM CPU selected for the next model load.'
      : 'WebGPU selected for the next model load.',
  );
}

async function preloadModel(): Promise<void> {
  if (state.busy !== 'idle') return;

  const model = currentModel();
  const variant = currentVariant();
  const clean = currentClean();

  if (
    state.engine &&
    state.engine.modelId === model.id &&
    state.engine.variantId === variant.id &&
    state.engine.clean === clean &&
    state.engine.language === state.language
  ) {
    showToast('Model is already loaded.');
    setStatus('Model ready.');
    return;
  }

  clearError();
  state.controller = new AbortController();
  setBusy('loading');
  resetProgressBars();
  els.downloadProgress.classList.remove('hidden');
  els.progressStatus.textContent = 'Preparing the model…';
  els.sessionProgress.classList.remove('hidden');
  els.sessionCancel.classList.remove('hidden');
  els.sessionCancel.disabled = false;
  els.sessionCancel.textContent = 'Cancel';
  els.sessionProgressLabel.textContent = 'Preparing the model…';
  els.sessionProgressDetail.textContent = '0%';
  setBar(els.sessionProgressBar, 0);

  const panelRect = els.progressPanel.getBoundingClientRect();
  if (panelRect.top < 0 || panelRect.bottom > window.innerHeight) {
    els.progressPanel.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  try {
    await ensureEngine(state.controller.signal);
    setStatus('Model loaded and ready. Select an audio file to transcribe.');
    showToast('Model ready.');
  } catch (error) {
    if (isAbortError(error)) {
      setStatus('Model download cancelled. Completed chunks are kept for next time.');
    } else {
      showError(error);
    }
  } finally {
    state.controller = null;
    setBusy('idle');
    els.sessionProgress.classList.add('hidden');
    els.sessionCancel.classList.add('hidden');
    void refreshCacheStatus();
    void refreshStorageStatus();
  }
}

function handleModelSettingsChange(): void {
  savePreferences();
  updatePresetNote();
  renderSession();
  renderQueueSettings();
  renderPresets();
  syncUrlState();
  void refreshCacheStatus();

  const engine = state.engine;
  if (!engine) return;

  const model = currentModel();
  const variant = currentVariant();
  if (
    engine.modelId === model.id &&
    engine.variantId === variant.id &&
    engine.clean === currentClean() &&
    engine.language === state.language
  ) {
    // The selected model, precision, language, and clean mode are unchanged;
    // keep the loaded sessions so the next run starts immediately.
    return;
  }

  state.engine = null;
  setBackend(null);
  setStatus('Model settings changed. The new model will load on next use.');
  void engine.dispose().catch(() => undefined);
}

async function clearCache(): Promise<void> {
  if (state.busy !== 'idle') return;

  const model = currentModel();
  const confirmed = window.confirm(
    `${model.name}\n\n${translateUi('Delete this model from this browser? You will need to download it again before using it.')}`,
  );
  if (!confirmed) return;

  clearError();
  setBusy('clearing');
  els.progressPanel.classList.remove('hidden');
  els.downloadProgress.classList.add('hidden');
  els.inferenceProgress.classList.add('hidden');
  els.progressStatus.textContent = `Deleting cached ${model.name} files…`;

  try {
    const engine = state.engine;
    if (engine && engine.modelId === model.id) {
      state.engine = null;
      setBackend(null);
      await engine.dispose().catch(() => undefined);
    }

    await clearModelCacheFor(model.id);
    invalidateCacheStatuses();
    await Promise.allSettled([refreshCacheStatus(), refreshStorageStatus()]);
    setStatus(`${model.name} was removed from the cache.`);
    showToast('Model cache cleared.');
  } catch (error) {
    showError(error);
  } finally {
    setBusy('idle');
  }
}

async function clearModelCacheForId(modelId: ModelId): Promise<void> {
  if (state.busy !== 'idle') return;
  const model = getModel(modelId);
  const confirmed = window.confirm(
    `${model.name}\n\n${translateUi('Delete this model from this browser? You will need to download it again before using it.')}`,
  );
  if (!confirmed) return;

  clearError();

  try {
    const engine = state.engine;
    if (engine && engine.modelId === modelId) {
      state.engine = null;
      setBackend(null);
      await engine.dispose().catch(() => undefined);
    }

    await clearModelCacheFor(modelId);
    invalidateCacheStatuses();
    await Promise.allSettled([refreshCacheStatus(), refreshStorageStatus()]);
    setStatus(`${model.name} was removed from the cache.`);
    showToast('Model cache cleared.');
  } catch (error) {
    showError(error);
  }
}

async function clearAllCache(): Promise<void> {
  if (state.busy !== 'idle') return;

  const confirmed = window.confirm(
    translateUi('Delete every cached speech, voice, and vision model from this browser? You will need to download them again before the next run.'),
  );
  if (!confirmed) return;

  clearError();
  setBusy('clearing');
  els.progressPanel.classList.remove('hidden');
  els.downloadProgress.classList.add('hidden');
  els.inferenceProgress.classList.add('hidden');
  els.progressStatus.textContent = 'Deleting all cached model files…';

  try {
    const engine = state.engine;
    state.engine = null;
    setBackend(null);
    if (engine) await engine.dispose().catch(() => undefined);

    await clearModelCache();
    invalidateCacheStatuses();
    if (typeof caches !== 'undefined') {
      // Speaker detection, OCR, and the Cactus engine (Mirage) keep their own caches.
      await Promise.all(
        ['localscribe-woof-v1', 'localscribe-diarization-v1', 'localscribe-ocr-v1', 'localscribe-cactus-v1']
          .map((name) => caches.delete(name).catch(() => false)),
      );
    }
    // Phonon and Supertonic own their caches and loaded sessions.
    await Promise.allSettled([...TTS_PLUGINS.values()].map((plugin) => plugin.clearCache?.()));
    if (navigator.storage?.getDirectory) {
      await navigator.storage
        .getDirectory()
        .then((root) => root.removeEntry('localscribe-reverb', { recursive: true }))
        .catch(() => undefined);
    }
    reverbEngine?.dispose();
    reverbEngine = null;
    reverbVoice = null;
    woofEngine?.dispose();
    woofEngine = null;
    invalidateCacheStatuses();
    await Promise.allSettled([refreshCacheStatus(), refreshStorageStatus()]);
    setStatus('All cached models deleted.');
    showToast('All model caches cleared.');
  } catch (error) {
    showError(error);
  } finally {
    setBusy('idle');
  }
}

/* -------------------------------------------------------------------------- */
/* Transcription                                                              */
/* -------------------------------------------------------------------------- */

async function planAudioChunks(audio: DecodedAudio | WaveSource): Promise<Array<{
  startSample: number;
  endSample: number;
  samples?: Float32Array;
}>> {
  const seconds = currentModel().chunkSeconds ?? 30;
  if (audio.samples) {
    return splitAtSilence(audio.samples, TARGET_SAMPLE_RATE, seconds).map((chunk) => ({
      ...chunk,
      endSample: chunk.startSample + chunk.samples.length,
    }));
  }
  return planWaveChunks(audio, seconds);
}

async function transcribe(): Promise<'done' | 'empty' | 'cancelled' | 'failed' | undefined> {
  const audio = state.audio;
  if (!audio || state.busy !== 'idle') return;

  clearError();
  resetTranscript();
  state.exportMeta = null;
  lastInferencePercent = -1;
  lastRunStats = null;
  els.runStats.classList.add('hidden');
  beginReceiptRun();

  state.controller = new AbortController();
  const signal = state.controller.signal;

  setBusy('transcribing');
  transcribeJob = startJob(`Transcribing ${state.file?.name ?? 'audio'}`, 'transcribe');
  // What the job tray reports when this run ends. Each exit path sets it.
  let jobOutcome: { message: string; ok: boolean } = { message: 'Stopped.', ok: false };
  resetProgressBars();
  els.progressPanel.classList.remove('hidden');
  els.downloadProgress.classList.add('hidden');
  els.inferenceProgress.classList.add('hidden');
  els.progressStatus.textContent = 'Preparing the model…';

  const started = performance.now();
  let modelReady = false;

  try {
    const loadStart = performance.now();
    const engine = await ensureEngine(signal);
    const loadMs = performance.now() - loadStart;
    modelReady = true;
    const runStart = performance.now();
    const chunks = await planAudioChunks(audio);

    if (!chunks.length) {
      throw new AppError('That file did not contain any audio to transcribe.', {
        code: 'NO_AUDIO',
      });
    }

    els.downloadProgress.classList.add('hidden');
    els.inferenceProgress.classList.remove('hidden');
    els.progressStatus.textContent = 'Transcribing on this device…';

    state.segments = chunks.map((chunk) => ({
      start: chunk.startSample / TARGET_SAMPLE_RATE,
      end: chunk.endSample / TARGET_SAMPLE_RATE,
      text: '',
      partial: true,
    }));
    renderSegments();

    let lastPartialUi = 0;
    // Segments fill in order, so the transcript is the finished segments plus
    // the one in progress. Keep the finished part instead of re-joining every
    // segment on each update (O(n²) over a long file).
    let finishedText = '';
    const joinText = (head: string, tail: string): string => (head && tail ? `${head} ${tail}` : head || tail);
    for (let index = 0; index < chunks.length; index += 1) {
      if (signal.aborted) throw new DOMException('Transcription cancelled.', 'AbortError');

      const chunk = chunks[index];
      updateInference(
        index,
        chunks.length,
        0,
        `Segment ${index + 1} of ${chunks.length} · ${formatDuration(chunk.startSample / TARGET_SAMPLE_RATE)}`,
      );

      const samples = audio.samples ? chunk.samples! : await audio.read(chunk.startSample, chunk.endSample);
      const result = await engine.transcribe(samples, {
        signal,
        onPartial: (text) => {
          const segment = state.segments[index];
          if (!segment) return;
          segment.text = text.trim();
          segment.partial = true;
          const now = performance.now();
          if (now - lastPartialUi >= 150) {
            lastPartialUi = now;
            els.transcript.value = joinText(finishedText, segment.text);
            updateCounts();
            updateTranscriptButtons();
          }
          updateSegmentRow(index);
        },
        onProgress: (progress) => {
          updateInference(
            index,
            chunks.length,
            progress.framesTotal > 0 ? progress.framesDone / progress.framesTotal : 0,
            `Segment ${index + 1} of ${chunks.length} · ${formatDuration(chunk.startSample / TARGET_SAMPLE_RATE)}`,
          );
        },
      });

      const segment = state.segments[index];
      if (segment) {
        segment.text = result.text.trim();
        segment.partial = false;
        segment.words = result.words?.flatMap((word) => {
          if (!Number.isFinite(word.start)) return [];
          const start = Math.max(segment.start, Math.min(segment.start + word.start, segment.end));
          const end = word.end !== null && Number.isFinite(word.end)
            ? Math.max(start, Math.min(segment.start + word.end, segment.end))
            : null;
          return [{ text: word.text, start, end }];
        });
      }

      finishedText = joinText(finishedText, segment?.text ?? '');
      els.transcript.value = finishedText;
      updateCounts();
      updateTranscriptButtons();
      // The rows already exist; patch this one instead of rebuilding the list.
      updateSegmentRow(index);
      highlightSegmentAtTime();
      updateInference(index + 1, chunks.length, 0, `Segment ${index + 1} of ${chunks.length} complete`);
    }

    const rawText = state.segments
      .map((entry) => entry.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    let text = rawText;
    if (els.polishToggle.checked && rawText) {
      const options = { punctuation: true, numbers: true };
      state.segments = state.segments.map((segment) => ({
        ...segment,
        text: polishTranscript(segment.text, options),
      }));
      text = polishTranscript(rawText, options);
      renderSegments();
    }

    // Punctuation or blank tokens alone are not a transcript.
    if (!/[\p{L}\p{N}]/u.test(text)) text = '';
    els.transcript.value = text;
    updateCounts();
    updateTranscriptButtons();

    if (text) {
      state.exportMeta = {
        duration: audio.duration,
        fileName: state.file?.name ?? null,
        modelName: currentModel().name,
        createdAt: new Date(),
      };
      lastRunStats = {
        loadMs,
        runMs: performance.now() - runStart,
        audioSeconds: audio.duration,
        backend: engine.backend ?? 'wasm',
        segments: chunks.length,
      };
      showRunStats(lastRunStats, currentModel().name);
      persistTranscript(text);
    }

    const elapsed = (performance.now() - started) / 1000;
    const decodeSeconds = (performance.now() - runStart) / 1000;

    if (text) {
      setStatus(
        `Done in ${elapsed.toFixed(1)} s · ${decodeSeconds.toFixed(1)} s decode · ${
          chunks.length
        } segment${chunks.length === 1 ? '' : 's'}. The text is fully editable.`,
      );
      showToast('Transcript ready.');
      jobOutcome = { message: 'Transcript ready.', ok: true };
    } else {
      setStatus('No speech was detected. Try a clearer recording or a different file.');
      jobOutcome = { message: 'No speech detected.', ok: false };
    }

    if (text && els.autoSpeakers.checked) queueMicrotask(() => void detectSpeakers());
    return text ? 'done' : 'empty';
  } catch (error) {
    if (isAbortError(error)) {
      const partial = els.transcript.value.trim();

      if (!modelReady) {
        setStatus('Model setup cancelled. Downloaded chunks are kept for next time.');
        showToast('Model setup cancelled.');
      } else {
        setStatus(
          partial
            ? 'Transcription cancelled. The partial transcript was kept.'
            : 'Transcription cancelled.',
        );
        showToast('Transcription cancelled.');
      }
      jobOutcome = { message: partial ? 'Cancelled. Partial transcript kept.' : 'Cancelled.', ok: false };
      return 'cancelled';
    } else {
      showError(error);
      jobOutcome = { message: 'Transcription failed.', ok: false };
      return 'failed';
    }
  } finally {
    if (state.engine && !state.engine.backend) await dropEngine();
    state.controller = null;
    setBusy('idle');
    transcribeJob?.finish(jobOutcome.message, jobOutcome.ok);
    transcribeJob = null;
    els.downloadProgress.classList.add('hidden');
    els.inferenceProgress.classList.add('hidden');
    endReceiptRun();
    void refreshCacheStatus();
    void refreshStorageStatus();
  }
}

let transcribeJob: JobHandle | null = null;

/**
 * Transcribe audio for the studio's lyrics view with the model chosen in
 * Audio to text. Returns timed lines, with word timings when the model has them.
 */
async function transcribeLyrics(
  file: File,
  signal: AbortSignal,
  onProgress: (fraction: number, message: string) => void,
): Promise<{ start: number; end: number; text: string; words?: { text: string; start: number; end: number | null }[] }[]> {
  if (state.busy !== 'idle') throw new Error('Audio to text is busy. Wait for it to finish first.');
  setBusy('transcribing');
  try {
    onProgress(0, 'Decoding the vocals');
    const decoded = await decodeAudioFile(file, { signal });
    onProgress(0.02, `Loading ${currentModel().name}`);
    const engine = await ensureEngine(signal);
    const chunks = await planAudioChunks(decoded);
    const lines: { start: number; end: number; text: string; words?: { text: string; start: number; end: number | null }[] }[] = [];
    for (const [index, chunk] of chunks.entries()) {
      signal.throwIfAborted();
      const start = chunk.startSample / TARGET_SAMPLE_RATE;
      const end = chunk.endSample / TARGET_SAMPLE_RATE;
      const samples = chunk.samples ?? decoded.samples.subarray(chunk.startSample, chunk.endSample);
      const result = await engine.transcribe(samples, {
        signal,
        onProgress: (progress) => onProgress(
          0.05 + 0.95 * ((index + (progress.framesTotal ? progress.framesDone / progress.framesTotal : 0)) / chunks.length),
          `Listening · part ${index + 1} of ${chunks.length}`,
        ),
      });
      const text = result.text.trim();
      if (!text) continue;
      lines.push({
        start,
        end,
        text,
        words: result.words?.filter((word) => Number.isFinite(word.start)).map((word) => ({
          text: word.text,
          start: start + word.start,
          end: word.end !== null && Number.isFinite(word.end) ? start + word.end : null,
        })),
      });
    }
    return lines;
  } finally {
    if (state.engine && !state.engine.backend) await dropEngine();
    setBusy('idle');
  }
}

function updateInference(
  segmentIndex: number,
  segmentCount: number,
  segmentFraction: number,
  label: string,
): void {
  const fraction = Math.max(0, Math.min(1, segmentFraction));
  const percent = Math.max(
    0,
    Math.min(100, ((segmentIndex + fraction) / Math.max(1, segmentCount)) * 100),
  );

  if (
    fraction > 0 &&
    fraction < 1 &&
    Math.abs(percent - lastInferencePercent) < 0.35
  ) {
    return;
  }

  lastInferencePercent = percent;
  transcribeJob?.update(percent / 100, label);
  setBar(els.inferenceBar, percent);
  els.inferenceLabel.textContent = label;
  els.inferenceDetail.textContent = `${Math.round(percent)}%`;
}

/* -------------------------------------------------------------------------- */
/* Progress rendering                                                         */
/* -------------------------------------------------------------------------- */

function renderLoadProgress(progress: {
  phase: 'storage' | 'download' | 'session' | 'ready';
  message: string;
  download?: {
    file: string;
    fileLoaded: number;
    fileTotal: number;
    loaded: number;
    total: number;
    networkLoaded: number;
    bytesPerSecond: number | null;
    etaSeconds: number | null;
  };
}): void {
  els.progressPanel.classList.remove('hidden');
  els.progressStatus.textContent = progress.message;

  const percent = Math.max(
    0,
    Math.min(
      100,
      progress.download && progress.download.total > 0
        ? (progress.download.loaded / progress.download.total) * 100
        : progress.phase === 'session' || progress.phase === 'ready'
          ? 100
          : 0,
    ),
  );

  els.sessionProgress.classList.remove('hidden');
  els.sessionProgressLabel.textContent = progress.message;
  els.sessionProgressDetail.textContent = `${Math.round(percent)}%`;
  setBar(els.sessionProgressBar, percent);
  if (progress.phase === 'ready') {
    els.sessionCancel.classList.add('hidden');
  }

  if (progress.download) {
    els.downloadProgress.classList.remove('hidden');
    els.inferenceProgress.classList.add('hidden');

    setBar(els.downloadBar, percent);
    els.downloadLabel.textContent = `Model download · ${progress.download.file}`;
    els.downloadDetail.textContent = `${Math.round(percent)}% · ${formatBytes(
      progress.download.loaded,
    )} / ${formatBytes(progress.download.total)}`;
    els.downloadRate.textContent = formatDownloadStats(progress.download);
  }

  if (progress.phase === 'session' || progress.phase === 'ready') {
    els.downloadProgress.classList.remove('hidden');
    setBar(els.downloadBar, 100);
    els.downloadLabel.textContent = 'Model files';
    els.downloadDetail.textContent = progress.phase === 'ready' ? 'Ready' : 'Downloaded';
    els.downloadRate.textContent =
      progress.phase === 'ready' ? 'Initializing inference sessions…' : 'Download complete';
  }

  if (progress.phase === 'download' && !progress.download) {
    els.downloadRate.textContent = 'Finalizing model files…';
  }

  if (progress.phase === 'storage') {
    els.downloadProgress.classList.add('hidden');
    els.inferenceProgress.classList.add('hidden');
  }
}

function formatDownloadStats(download: {
  loaded: number;
  total: number;
  networkLoaded: number;
  bytesPerSecond: number | null;
  etaSeconds: number | null;
}): string {
  if (download.loaded >= download.total) return 'Download complete';

  if (download.networkLoaded === 0) {
    return 'Checking cached chunks…';
  }

  if (download.bytesPerSecond && download.bytesPerSecond > 0) {
    const speed = `${formatBytes(download.bytesPerSecond)}/s`;
    if (download.etaSeconds === null) return `${speed} · estimating time…`;
    if (download.etaSeconds <= 0.5) return `${speed} · finishing…`;
    return `${speed} · ${formatEta(download.etaSeconds)} left`;
  }

  return 'Calculating download speed…';
}

function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'finishing';
  if (seconds < 60) return `~${Math.max(1, Math.ceil(seconds))}s`;
  return `~${formatDuration(seconds)}`;
}

function setBar(bar: HTMLElement, percent: number): void {
  const clamped = Math.max(0, Math.min(100, percent));
  bar.style.width = `${clamped}%`;
  bar.setAttribute('aria-valuenow', String(Math.round(clamped)));
}

function resetProgressBars(): void {
  setBar(els.downloadBar, 0);
  setBar(els.inferenceBar, 0);
  els.downloadDetail.textContent = '0%';
  els.inferenceDetail.textContent = '0%';
  els.downloadLabel.textContent = 'Model download';
  els.inferenceLabel.textContent = 'Transcription';
  els.downloadRate.textContent = 'Calculating download speed…';
  lastInferencePercent = -1;
}

/* -------------------------------------------------------------------------- */
/* Status / model settings UI                                                 */
/* -------------------------------------------------------------------------- */

function currentModel(): SupportedModel {
  return getModel(state.modelId);
}

function currentVariant(): ModelVariant {
  return getVariant(currentModel(), state.variantId);
}

function isVariantSupported(variant: ModelVariant): boolean {
  return variant.approxBytes < 2_000_000_000;
}

function languageCountLabel(model: SupportedModel): string {
  if (model.languageCount === 1) return 'English';
  return `${model.languageCount.toLocaleString()}${model.languageCount >= 1000 ? '+' : ''} languages`;
}

function variantCacheKey(modelId: ModelId, variantId: string): string {
  return `${modelId}:${variantId}`;
}

function modelCardVariant(model: SupportedModel): ModelVariant {
  return model.id === state.modelId
    ? currentVariant()
    : getVariant(model, model.defaultVariant);
}

function currentClean(): boolean {
  return currentModel().cleanMode && els.cleanMode.checked;
}

function populateModelOptions(): void {
  els.modelSelect.replaceChildren();
  els.sessionModelSelect.replaceChildren();

  for (const model of SUPPORTED_MODELS) {
    const variant = getVariant(model, model.defaultVariant);
    const label = `${model.name} · ${languageCountLabel(model)} · ${formatBytes(
      variant.approxBytes,
    )}`;

    const option = document.createElement('option');
    option.value = model.id;
    option.textContent = label;
    els.modelSelect.append(option);

    const sessionOption = document.createElement('option');
    sessionOption.value = model.id;
    sessionOption.textContent = label;
    els.sessionModelSelect.append(sessionOption);
  }

  els.modelSelect.value = state.modelId;
  els.sessionModelSelect.value = state.modelId;
}

function renderModelPicker(): void {
  const model = currentModel();
  const availableVariants = model.variants.filter(isVariantSupported);

  if (!availableVariants.some((variant) => variant.id === state.variantId)) {
    state.variantId = availableVariants[0]?.id ?? model.defaultVariant;
  }

  els.modelSelect.value = model.id;
  els.variantSelect.replaceChildren();

  for (const variant of availableVariants) {
    const option = document.createElement('option');
    option.value = variant.id;
    option.textContent = variant.label;
    els.variantSelect.append(option);
  }

  els.variantSelect.value = state.variantId;
  els.variantField.classList.toggle('hidden', availableVariants.length <= 1);
  els.sessionVariantSelect.replaceChildren(
    ...availableVariants.map((variant) => new Option(variant.label, variant.id)),
  );
  els.sessionVariantSelect.value = state.variantId;
  els.sessionVariantSelect.classList.toggle('hidden', availableVariants.length <= 1);
  els.cleanModeField.classList.toggle('hidden', !model.cleanMode);
  els.cleanMode.disabled = state.busy !== 'idle' || !model.cleanMode;
  if (!model.cleanMode) els.cleanMode.checked = false;

  const languageOptions = model.languageOptions ?? [];
  els.languageField.classList.toggle('hidden', languageOptions.length === 0);
  els.languageSelect.replaceChildren();

  if (languageOptions.length > 0) {
    const auto = document.createElement('option');
    auto.value = '';
    auto.textContent = 'Auto-detect';
    els.languageSelect.append(auto);

    for (const language of languageOptions) {
      const option = document.createElement('option');
      option.value = language;
      option.textContent = language;
      els.languageSelect.append(option);
    }

    if (!languageOptions.includes(state.language)) state.language = '';
    els.languageSelect.value = state.language;
  } else {
    state.language = '';
  }

  renderModelDetails();
  if (currentView === 'models') renderModelComparison();
  renderModelCards();
  renderPresets();
  renderSession();
  updatePresetNote();
}

function renderModelDetails(): void {
  const model = currentModel();
  const variant = currentVariant();
  const languageBadge =
    model.languageCount === 1 ? 'English only' : languageCountLabel(model);

  els.modelDetails.innerHTML = `
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div class="min-w-0">
        <div class="flex flex-wrap items-center gap-2">
          <p class="text-sm font-semibold text-white">${model.name}</p>
          ${model.recommended ? '<span class="badge badge-good">Recommended</span>' : ''}
          <span class="badge badge-muted">${languageBadge}</span>
          <span class="badge badge-muted">${formatBytes(variant.approxBytes)}</span>
          <span class="badge badge-muted">${model.bestFor}</span>
        </div>
        <p class="mt-1 text-[11px] text-slate-400">${model.family}</p>
      </div>
      <a
        class="text-[11px] font-medium text-indigo-300 underline decoration-indigo-300/30 underline-offset-2 transition hover:text-[#8f452b]"
        href="https://huggingface.co/${model.repo}"
        target="_blank"
        rel="noreferrer"
      >Model card ↗</a>
    </div>
    <div class="mt-3 flex flex-wrap items-center gap-2">
      <span id="model-status-badge" class="badge badge-muted">Checking…</span>
      <span id="model-status-detail" class="text-[10px] leading-relaxed text-slate-400">Checking Cache Storage…</span>
    </div>
    <p class="mt-3 text-xs leading-relaxed text-slate-400">${model.description}</p>
    ${
      model.id === 'fluid-pro'
        ? '<p class="mt-2 text-[10px] leading-relaxed text-slate-400">Chromium build: only the Compact variant is available; Full precision needs a runtime that can memory-map its 2.59 GB weight file.</p>'
        : ''
    }
    <div class="mt-3 grid gap-3 border-t border-white/5 pt-3 sm:grid-cols-2">
      <div>
        <span class="field-label">Accuracy</span>
        <p class="mt-1 text-[11px] leading-relaxed text-slate-300">${model.wer}</p>
      </div>
      <div>
        <span class="field-label">Released</span>
        <p class="mt-1 text-[11px] text-slate-300">${formatRelease(model.release)}</p>
      </div>
      <div>
        <span class="field-label">License</span>
        <p class="mt-1 text-[11px] text-slate-300">
          <a class="underline decoration-white/10 underline-offset-2 transition hover:text-white" href="${model.licenseUrl}" target="_blank" rel="noreferrer">${model.license}</a>
        </p>
      </div>
      <div>
        <span class="field-label">Variant</span>
        <p class="mt-1 text-[11px] text-slate-300">${variant.label}</p>
      </div>
    </div>
    <div class="mt-3 border-t border-white/5 pt-3">
      <span class="field-label">Exact languages</span>
      <p class="mt-1 text-[11px] leading-relaxed text-slate-300">${model.languagesDetail.join(', ')}</p>
      ${
        model.dialects?.length
          ? `<p class="mt-1.5 text-[10px] leading-relaxed text-slate-400"><span class="text-slate-400">Chinese dialects:</span> ${model.dialects.join(', ')}</p>`
          : ''
      }
      ${
        model.languageOptions?.length
          ? `<p class="mt-1.5 text-[10px] text-slate-400">Inference language: <span class="text-slate-300">${state.language || 'Auto-detect'}</span></p>`
          : ''
      }
    </div>
  `;

  renderSelectedModelStatus(modelCacheStates.get(variantCacheKey(model.id, variant.id)));
}

function renderModelCards(): void {
  if (!els.modelPicker) return;

  els.modelPicker.innerHTML = SUPPORTED_MODELS.map((model) => {
    const variant = modelCardVariant(model);
    const status = modelCacheStates.get(variantCacheKey(model.id, variant.id));
    const selected = model.id === state.modelId;
    const loaded =
      state.engine?.modelId === model.id &&
      state.engine.variantId === variant.id;
    const blocked =
      model.pipeline === 'granite-speech' && !state.webgpu.supported;
    const languageLabel = languageCountLabel(model);
    const fit = modelFit(model, variant, deviceProfile);

    let badge = 'Checking…';
    let tone = 'badge-muted';
    let detail = 'Checking Cache Storage…';

    if (loaded) {
      badge = 'Ready now';
      tone = 'badge-good';
      detail = `Loaded and validated · ${state.engine?.backend === 'webgpu' ? 'WebGPU' : 'WASM'}`;
    } else if (blocked) {
      badge = 'WebGPU needed';
      tone = 'badge-warn';
      detail = 'Granite requires a WebGPU adapter in this browser.';
    } else if (status?.available === false) {
      badge = 'Cache unavailable';
      tone = 'badge-warn';
      detail = 'This browser does not allow Cache Storage here.';
    } else if (status?.cached) {
      badge = 'Cached';
      tone = 'badge-good';
      detail = `${formatBytes(status.bytes)} already downloaded · ready to load`;
    } else if (status && status.filesCached > 0) {
      badge = 'Partial';
      tone = 'badge-warn';
      detail = `${formatBytes(status.bytes)} cached · download can resume`;
    } else if (status) {
      badge = 'Not cached';
      tone = 'badge-muted';
      detail = `About ${formatBytes(variant.approxBytes)} to download`;
    }

    return `
      <button
        type="button"
        role="radio"
        aria-checked="${selected}"
        data-model-id="${model.id}"
        ${state.busy === 'idle' ? '' : 'disabled'}
        class="group flex min-h-[112px] flex-col rounded-xl border p-3 text-left transition ${
          selected
            ? 'border-indigo-400/50 bg-indigo-500/[0.09] ring-1 ring-indigo-400/25'
            : 'border-white/10 bg-white/[0.03] hover:border-white/20 hover:bg-white/5'
        } disabled:cursor-not-allowed disabled:opacity-60"
      >
        <span class="flex items-start justify-between gap-2">
          <span class="min-w-0">
            <span class="block truncate text-xs font-semibold text-white">${model.name}</span>
            ${model.recommended ? '<span class="mt-0.5 inline-block rounded bg-emerald-400/10 px-1 py-0.5 text-[8px] font-semibold uppercase tracking-wide text-emerald-300">Recommended</span>' : ''}
          </span>
          <span class="badge ${tone} shrink-0">${badge}</span>
        </span>
        <span class="mt-1 block truncate text-[10px] text-slate-400">${model.family}</span>
        <span class="mt-1 block truncate text-[9px] font-medium text-indigo-300">${model.bestFor}</span>
        <span class="mt-2 flex flex-wrap gap-1">
          <span class="rounded-md bg-white/5 px-1.5 py-0.5 text-[9px] text-slate-400">${languageLabel}</span>
          <span class="rounded-md bg-white/5 px-1.5 py-0.5 text-[9px] text-slate-400">${formatBytes(variant.approxBytes)}</span>
          <span class="rounded-md bg-white/5 px-1.5 py-0.5 text-[9px] ${
            fit.tone === 'warn' ? 'text-amber-300' : 'text-emerald-300'
          }" title="${fit.detail}">${fit.label}</span>
        </span>
        <span class="mt-auto block pt-2 text-[10px] leading-relaxed ${
          tone === 'badge-good'
            ? 'text-emerald-300'
            : tone === 'badge-warn'
              ? 'text-amber-300'
              : 'text-slate-400'
        }">${detail}</span>
      </button>
    `;
  }).join('');
}

function renderSelectedModelStatus(status?: CacheStatus): void {
  const badge = document.getElementById('model-status-badge');
  const detail = document.getElementById('model-status-detail');
  if (!badge || !detail) return;

  const model = currentModel();
  const variant = currentVariant();
  renderSession();
  const loaded =
    state.engine?.modelId === model.id &&
    state.engine.variantId === variant.id;
  const blocked =
    model.pipeline === 'granite-speech' && !state.webgpu.supported;

  if (loaded) {
    setBadge(badge, 'Ready now', 'good');
    detail.textContent = `Loaded and validated · ${state.engine?.backend === 'webgpu' ? 'WebGPU + WASM' : 'WASM CPU'}`;
    return;
  }

  if (blocked) {
    setBadge(badge, 'WebGPU required', 'warn');
    detail.textContent = 'This browser has no WebGPU adapter, so this model cannot run here.';
    return;
  }

  if (!status) {
    setBadge(badge, 'Checking…', 'muted');
    detail.textContent = 'Checking Cache Storage…';
    return;
  }

  if (status.available === false) {
    setBadge(badge, 'Cache unavailable', 'warn');
    detail.textContent = 'This browser does not allow Cache Storage here.';
  } else if (status.cached) {
    setBadge(badge, 'Cached', 'good');
    detail.textContent = `${formatBytes(status.bytes)} downloaded · ready to load`;
  } else if (status.filesCached > 0) {
    setBadge(badge, 'Partial', 'warn');
    detail.textContent = `${formatBytes(status.bytes)} cached · ${formatBytes(
      Math.max(0, variant.approxBytes - status.bytes),
    )} remaining`;
  } else {
    setBadge(badge, 'Not cached', 'muted');
    detail.textContent = `About ${formatBytes(variant.approxBytes)} will be downloaded once`;
  }
}

function renderModelComparison(): void {
  els.modelComparison.innerHTML = SUPPORTED_MODELS.map((model) => {
    const variant = getVariant(model, model.defaultVariant);
    const languages = model.languagesDetail.join(', ');
    const selected = model.id === state.modelId;
    return `
      <tr
        data-model-id="${model.id}"
        class="cursor-pointer align-top transition hover:bg-white/5 ${
          selected ? 'bg-indigo-500/[0.06]' : ''
        }"
        title="Select ${model.name}"
      >
        <td class="px-3 py-2">
          <span class="font-medium text-slate-200">${model.name}</span>
          ${model.recommended ? '<span class="ml-1.5 rounded bg-emerald-400/10 px-1 py-0.5 text-[8px] font-semibold uppercase tracking-wide text-emerald-300">Recommended</span>' : ''}
        </td>
        <td class="max-w-[260px] px-3 py-2 text-slate-400" title="${languages}">${languages}</td>
        <td class="whitespace-nowrap px-3 py-2 font-mono text-slate-300">${formatBytes(variant.approxBytes)}</td>
        <td class="px-3 py-2 text-slate-400">${model.wer}</td>
        <td class="whitespace-nowrap px-3 py-2 text-slate-400">${formatRelease(model.release)}</td>
      </tr>
    `;
  }).join('');

  if (currentView === 'models') renderPerformanceChart();
}

function renderPerformanceChart(): void {
  void import('./model-chart').then(({ renderModelChart }) => {
    if (currentView !== 'models') return;
    renderModelChart(els.modelChart, {
      selectedModelId: state.modelId,
      onSelectModel: (modelId) => {
        if (state.busy !== 'idle') return;
        const model = getModel(modelId as ModelId);
        state.modelId = model.id;
        state.variantId = model.defaultVariant;
        renderModelPicker();
        handleModelSettingsChange();
      },
    });
  }).catch((error) => showToast(describeError(error)));
}

function renderResearchModels(): void {
  els.researchList.innerHTML = RESEARCH_MODELS.map((model) => {
    const statusLabel =
      model.status === 'wrong-task'
        ? 'Not speech-to-text'
        : model.status === 'upcoming'
          ? 'Coming soon'
          : 'Needs different runtime';
    const tone = model.status === 'wrong-task' ? 'badge-warn' : 'badge-muted';

    return `
      <div class="rounded-xl border border-white/5 bg-white/[0.03] p-3">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <p class="text-xs font-medium text-white">${model.name}</p>
          <span class="badge ${tone}">${statusLabel}</span>
        </div>
        <p class="mt-1.5 text-[10px] leading-relaxed text-slate-400">${model.reason}</p>
        <div class="mt-2 flex flex-wrap gap-1">
          ${model.tags.map((tag) => `<span class="rounded-md bg-white/5 px-1.5 py-0.5 text-[9px] text-slate-400">${tag}</span>`).join('')}
        </div>
        <div class="mt-2 flex flex-wrap items-center gap-2 text-[9px] text-slate-400">
          ${model.size ? `<span>${model.size}</span>` : ''}
          ${model.release ? `<span>· ${model.release}</span>` : ''}
          ${model.license ? `<span>· ${model.license}</span>` : ''}
        </div>
        <a class="mt-2 inline-block text-[10px] font-medium text-indigo-300 underline decoration-indigo-300/30 underline-offset-2 transition hover:text-indigo-300" href="${model.url}" target="_blank" rel="noreferrer">
          Open source ↗
        </a>
      </div>
    `;
  }).join('');
}

function formatRelease(value: string): string {
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

function loadPreferences(): void {
  try {
    const savedModel = localStorage.getItem(MODEL_KEY);
    const savedVariant = localStorage.getItem(VARIANT_KEY);
    const legacyPreset = localStorage.getItem(LEGACY_PRESET_KEY);
    const compact = prefersCompactModel(readDeviceProfile('gpu' in navigator));

    const model = SUPPORTED_MODELS.find((entry) => entry.id === savedModel);

    const preferredVariant = (entry: SupportedModel): string => {
      if (savedVariant && entry.variants.some((variant) => variant.id === savedVariant)) return savedVariant;
      if (compact && entry.variants.some((variant) => variant.id === 'q8')) return 'q8';
      return entry.defaultVariant;
    };

    if (model) {
      state.modelId = model.id;
      state.variantId = preferredVariant(model);
    } else if (legacyPreset === 'compact' || legacyPreset === 'full') {
      state.modelId = 'fluid-pro';
      state.variantId = legacyPreset;
    } else if (compact) {
      state.modelId = 'whisper-tiny-timestamped';
      state.variantId = 'q8';
    }

    const savedLanguage = localStorage.getItem(LANGUAGE_KEY) ?? '';
    state.language = currentModel().languageOptions?.includes(savedLanguage)
      ? savedLanguage
      : '';

    els.cleanMode.checked =
      currentModel().cleanMode && localStorage.getItem(CLEAN_KEY) === '1';

    // Kokoro is opt-in, but when it is picked on a weak device use the Q8
    // build instead of the 325 MB fp32 download.
    ttsKokoroDevice = compact ? 'wasm-q8' : 'wasm';
  } catch {
    // Storage can be disabled; defaults are fine.
  }
}

function savePreferences(): void {
  try {
    localStorage.setItem(MODEL_KEY, state.modelId);
    localStorage.setItem(VARIANT_KEY, state.variantId);
    localStorage.setItem(LANGUAGE_KEY, state.language);
    localStorage.setItem(CLEAN_KEY, els.cleanMode.checked ? '1' : '0');
  } catch {
    // Best effort.
  }
}

function updatePresetNote(): void {
  const model = currentModel();
  const variant = currentVariant();
  let note = `${variant.note} About ${formatBytes(variant.approxBytes)} is downloaded once${
    state.cacheAvailable ? ' and kept in Cache Storage' : ''
  }.`;

  if (model.languageCount === 1) {
    note +=
      ' English only; choose Fluid Speech Pro or Parakeet Redux for 25 languages, Rumble for 45, or Qwen3-ASR for 30 plus Chinese dialects.';
  }

  if (model.languageOptions?.length) {
    note += state.language
      ? ` Inference is forced to ${state.language}; choose Auto-detect for mixed audio.`
      : ' The model will detect the language automatically.';
  }

  if (model.pipeline === 'granite-speech') {
    note += state.webgpu.supported
      ? ' WebGPU is available, so this model can run here.'
      : ' This browser has no WebGPU adapter, and Granite cannot run on CPU; pick Rumble-2-Flash or Qwen3-ASR instead.';
  }

  if (model.cleanMode && currentClean()) {
    note += ' Clean mode is on, so fillers and repeated words may be removed.';
  } else if (!model.cleanMode) {
    note += ' Clean mode is not available for this model.';
  }

  if (!state.webgpu.supported && model.id === 'fluid-pro') {
    note +=
      ' Without WebGPU, Fluid Speech Pro runs on the multi-threaded CPU backend and is still much slower than Fluid Speech Mini or Parakeet Redux on this machine.';
  }

  if (
    variant.approxBytes > 1_000_000_000 &&
    model.pipeline !== 'granite-speech'
  ) {
    if (!state.webgpu.supported) {
      note +=
        ' WebGPU is unavailable in this browser, so this large model runs on the CPU; watch memory use and prefer Compact.';
    }

    const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
    if (typeof memory === 'number' && memory > 0 && memory < 8) {
      note += ` This device reports about ${memory} GB of RAM; a smaller model is the safer choice.`;
    }
  }

  els.presetNote.textContent = note;
}

async function refreshCacheStatus(): Promise<void> {
  const requestId = ++cacheRequestId;
  const model = currentModel();
  const variant = currentVariant();

  try {
    const status = await getModelCacheStatus(model.id, variant.id, currentClean());
    if (requestId !== cacheRequestId) return;

    state.cacheAvailable = status.available;
    modelCacheStates.set(variantCacheKey(model.id, variant.id), status);
    renderSelectedModelStatus(status);
    renderModelCards();
    updatePresetNote();

    const graniteBlocked =
      model.pipeline === 'granite-speech' && !state.webgpu.supported;

    if (graniteBlocked) {
      setTone(els.cacheStatus, 'WebGPU required', 'warn');
      setButtonLabel(els.preloadBtn, 'WebGPU required');
    } else if (!status.available) {
      setTone(els.cacheStatus, 'Unavailable', 'warn');
      setButtonLabel(els.preloadBtn, 'Download model');
    } else if (status.cached) {
      setTone(els.cacheStatus, `Cached · ${formatBytes(status.bytes)}`, 'good');
      setButtonLabel(els.preloadBtn, 'Load cached model');
    } else if (status.filesCached > 0) {
      setTone(els.cacheStatus, `Partial · ${formatBytes(status.bytes)}`, 'warn');
      setButtonLabel(els.preloadBtn, 'Resume download');
    } else {
      setTone(els.cacheStatus, 'Not cached', 'muted');
      setButtonLabel(els.preloadBtn, 'Download & prepare model');
    }

    els.preloadBtn.disabled = state.busy !== 'idle' || graniteBlocked;
    els.clearCacheBtn.disabled = state.busy !== 'idle' || !status.available;
    void refreshDownloadedModels();
  } catch {
    if (requestId !== cacheRequestId) return;
    state.cacheAvailable = false;
    modelCacheStates.delete(variantCacheKey(model.id, variant.id));
    renderModelCards();
    updatePresetNote();
    const badge = document.getElementById('model-status-badge');
    const detail = document.getElementById('model-status-detail');
    if (badge) setBadge(badge, 'Cache unavailable', 'warn');
    if (detail) detail.textContent = 'This browser does not allow Cache Storage here.';
    setTone(els.cacheStatus, 'Unavailable', 'warn');
    els.clearCacheBtn.disabled = true;
    els.clearAllCacheBtn.disabled = true;
  }
}

async function refreshDownloadedModels(): Promise<void> {
  const now = Date.now();
  if (cacheStatusScan) return cacheStatusScan;
  if (
    cacheStatusSnapshotAt &&
    now - cacheStatusSnapshotAt < CACHE_STATUS_TTL_MS &&
    modelCacheStates.size > 0
  ) {
    return;
  }

  cacheStatusScan = (async () => {
    const targets = SUPPORTED_MODELS.flatMap((model) =>
      model.variants.filter(isVariantSupported).map((variant) => ({
        model,
        variant,
        clean: model.cleanMode ? currentClean() : false,
      })),
    );
    const statuses = await getModelCacheStatuses(
      targets.map(({ model, variant, clean }) => ({
        modelId: model.id,
        variantId: variant.id,
        clean,
      })),
    );

    const entries: Array<{
      model: SupportedModel;
      variant: ModelVariant;
      bytes: number;
      cached: boolean;
    }> = [];
    targets.forEach(({ model, variant }, index) => {
      const status = statuses[index];
      modelCacheStates.set(variantCacheKey(model.id, variant.id), status);
      if (status.bytes > 0 || status.cached) {
        entries.push({ model, variant, bytes: status.bytes, cached: status.cached });
      }
    });

    entries.sort((a, b) =>
      a.model.name === b.model.name
        ? a.variant.label.localeCompare(b.variant.label)
        : a.model.name.localeCompare(b.model.name),
    );

    if (!entries.length) {
      renderModelCards();
      els.downloadedModels.innerHTML =
        '<p class="rounded-xl border border-white/5 bg-white/[0.03] px-3 py-3 text-[11px] text-slate-400">Nothing downloaded yet. The selected model will appear here after its first download.</p>';
      els.clearAllCacheBtn.disabled = true;
      cacheStatusSnapshotAt = Date.now();
      await appendOtherCachedModels(true);
      return;
    }

    els.downloadedModels.innerHTML = entries
      .map(({ model, variant, cached }) => {
        const loaded =
          state.engine?.modelId === model.id &&
          state.engine.variantId === variant.id;
        const badge = loaded ? 'Ready now' : cached ? 'Cached' : 'Partial';
        const tone = loaded || cached ? 'badge-good' : 'badge-warn';
        return `
        <div class="flex items-center justify-between gap-3 rounded-xl border border-white/5 bg-white/[0.03] px-3 py-2">
          <button type="button" class="min-w-0 flex-1 text-left" data-model-id="${model.id}" data-variant-id="${variant.id}">
            <span class="flex items-center gap-2">
              <span class="truncate text-xs font-medium text-slate-200">${model.name}</span>
              <span class="badge ${tone}">${badge}</span>
            </span>
            <span class="mt-0.5 block truncate text-[10px] text-slate-400">${variant.label}${cached ? '' : ' · download can resume'}</span>
          </button>
          <button type="button" class="icon-btn shrink-0" data-clear-model="${model.id}" aria-label="Delete cached ${model.name}">
            <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
              <path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13M10 11v5M14 11v5" />
            </svg>
          </button>
        </div>
      `;
      })
      .join('');

    renderModelCards();
    els.clearAllCacheBtn.disabled = state.busy !== 'idle';
    cacheStatusSnapshotAt = Date.now();
    await appendOtherCachedModels(false);
  })();

  try {
    await cacheStatusScan;
  } finally {
    cacheStatusScan = null;
  }
}

let otherCachedModels: OtherCachedModel[] = [];

/**
 * Add voice, vision, OCR, separation and other caches under the speech
 * models, so every byte the app stores can be seen and cleared here.
 */
async function appendOtherCachedModels(speechListEmpty: boolean): Promise<void> {
  otherCachedModels = await listOtherCachedModels().catch(() => []);
  if (!otherCachedModels.length) return;
  if (speechListEmpty) els.downloadedModels.innerHTML = '';
  const rows = otherCachedModels.map((row, index) => `
    <div class="flex items-center justify-between gap-3 rounded-xl border border-white/5 bg-white/[0.03] px-3 py-2">
      <span class="min-w-0 flex-1">
        <span class="flex items-center gap-2">
          <span class="truncate text-xs font-medium text-slate-200" data-no-i18n>${escapeHtml(row.label)}</span>
          <span class="badge badge-good">Cached</span>
        </span>
        <span class="mt-0.5 block truncate text-[10px] text-slate-400">${formatBytes(row.bytes)}</span>
      </span>
      <button type="button" class="icon-btn shrink-0" data-clear-other="${index}" aria-label="Delete cached ${escapeHtml(row.label)}">
        <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
          <path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13M10 11v5M14 11v5" />
        </svg>
      </button>
    </div>`).join('');
  els.downloadedModels.insertAdjacentHTML(
    'beforeend',
    `<p class="mt-3 px-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">Voice, vision, and tool models</p>${rows}`,
  );
  els.clearAllCacheBtn.disabled = state.busy !== 'idle';
}

async function refreshStorageStatus(): Promise<void> {
  const [info, projects] = await Promise.all([
    getStorageInfo(),
    listVideoProjects().catch(() => []),
  ]);
  const projectBytes = projects.reduce((sum, project) => sum + (project.bytes || 0), 0);
  const projectsLine = document.createElement('span');
  projectsLine.className = 'storage-detail-projects';
  const projectsName = document.createElement('span');
  projectsName.textContent = 'Video projects';
  const projectsValue = document.createElement('strong');
  projectsValue.textContent = `${projects.length} · ${formatBytes(projectBytes)}`;
  projectsLine.append(projectsName, projectsValue);
  const note = document.createElement('span');
  note.className = 'storage-detail-note';

  if (!info.available) {
    setTone(els.storageStatus, 'Unavailable', 'warn');
    els.storageUsageLabel.textContent = '-';
    els.storageQuotaLabel.textContent = '-';
    setBar(els.storageBar, 0);
    note.textContent = 'Storage estimation is not available in this browser.';
    els.storageDetail.replaceChildren(note, projectsLine);
    return;
  }

  const used = Math.max(info.usage, projectBytes);
  const percent = info.quota > 0 ? (used / info.quota) * 100 : 0;
  setTone(
    els.storageStatus,
    info.persisted ? 'Persistent' : 'Best effort',
    info.persisted ? 'good' : 'warn',
  );

  els.storageUsageLabel.textContent = formatBytes(used);
  els.storageQuotaLabel.textContent = `${percent < 10 ? percent.toFixed(1) : Math.round(percent)}% · ${formatBytes(info.quota)}`;
  setBar(els.storageBar, percent);
  note.textContent = info.persisted
    ? 'Storage is persistent.'
    : 'The browser may evict the cached model under storage pressure.';
  els.storageDetail.replaceChildren(projectsLine, note);
}

function renderWebGpuStatus(): void {
  if (state.webgpu.supported) {
    setBadge(els.webgpuBadge, 'WebGPU ready', 'good');
    setTone(els.webgpuStatus, 'Available', 'good');
    els.webgpuStatus.title = 'The encoder will request the WebGPU execution provider first.';
  } else {
    setBadge(els.webgpuBadge, 'WASM mode', 'warn');
    setTone(els.webgpuStatus, 'Unavailable', 'warn');
    els.webgpuStatus.title =
      state.webgpu.reason ?? 'WebGPU is unavailable. The WASM CPU backend will be used.';
  }
}

function setBackend(backend: Backend | null): void {
  if (!backend) {
    setBadge(els.backendBadge, 'Not loaded', 'muted');
    els.backendBadge.title = '';
    return;
  }

  if (backend === 'webgpu') {
    setBadge(els.backendBadge, 'WebGPU + WASM', 'good');
    els.backendBadge.title =
      'The encoder initialized with WebGPU. The small TDT decoder runs on WASM to avoid per-token GPU round trips.';
  } else {
    setBadge(els.backendBadge, 'WASM (CPU)', 'warn');
    els.backendBadge.title = 'The encoder and decoder are running on the CPU via WebAssembly.';
  }
}

function setBadge(
  element: HTMLElement,
  text: string,
  tone: 'good' | 'warn' | 'muted',
): void {
  const label = element.querySelector<HTMLElement>('[data-badge-text]');
  if (label) label.textContent = text;
  else element.textContent = text;

  element.classList.remove('badge-good', 'badge-warn', 'badge-muted');
  element.classList.add(
    tone === 'good' ? 'badge-good' : tone === 'warn' ? 'badge-warn' : 'badge-muted',
  );
}

function setTone(
  element: HTMLElement,
  text: string,
  tone: 'good' | 'warn' | 'muted' | 'normal',
): void {
  element.textContent = text;
  element.classList.remove(
    'text-emerald-300',
    'text-amber-300',
    'text-slate-400',
    'text-slate-300',
  );
  element.classList.add(
    tone === 'good'
      ? 'text-emerald-300'
      : tone === 'warn'
        ? 'text-amber-300'
        : tone === 'muted'
          ? 'text-slate-400'
          : 'text-slate-300',
  );
}

function setButtonLabel(button: HTMLButtonElement, label: string): void {
  const span = button.querySelector<HTMLElement>('[data-label]');
  if (span) span.textContent = label;
  else button.textContent = label;
}

/* -------------------------------------------------------------------------- */
/* Busy state / transcript actions                                            */
/* -------------------------------------------------------------------------- */

function setBusy(next: BusyState): void {
  state.busy = next;
  const idle = next === 'idle';
  const recordingNow = next === 'recording';
  const cancellable = next === 'decoding' || next === 'loading' || next === 'transcribing';

  els.fileInput.disabled = !idle;
  els.modelSelect.disabled = !idle;
  els.variantSelect.disabled = !idle;
  els.languageSelect.disabled =
    !idle || !(currentModel().languageOptions?.length);
  els.cleanMode.disabled = !idle || !currentModel().cleanMode;
  els.preloadBtn.disabled =
    !idle ||
    (currentModel().pipeline === 'granite-speech' && !state.webgpu.supported);
  els.sessionPreload.disabled =
    !idle ||
    (currentModel().pipeline === 'granite-speech' && !state.webgpu.supported);
  els.sessionModelSelect.disabled = !idle;
  els.sessionCancel.classList.toggle('hidden', next !== 'loading');
  if (next !== 'loading') {
    els.sessionCancel.disabled = false;
  }
  els.clearCacheBtn.disabled = !idle || !state.cacheAvailable;
  els.clearAllCacheBtn.disabled = !idle || !state.cacheAvailable;
  els.removeFileBtn.disabled = !idle;
  els.transcribeBtn.disabled = !idle || !state.audio;
  els.recordBtn.disabled = !idle;
  els.trySampleInline.disabled = !idle;
  els.speakersBtn.disabled = !idle || diarizing || !state.audio || !els.transcript.value.trim();
  els.queueAdd.disabled = !idle;
  els.benchmarkBtn.disabled = !idle;
  els.benchmarkReference.disabled = !idle;
  els.benchmarkCancel.classList.toggle('hidden', next !== 'benchmarking');
  els.forceCpu.disabled = !idle;
  els.exportFormat.disabled = !idle;
  els.transcript.readOnly = !idle;
  els.dropZone.setAttribute('aria-disabled', String(!idle));
  els.dropZone.classList.toggle('opacity-60', !idle);
  renderModelCards();
  renderPresets();
  renderQueue();
  renderSession();

  els.cancelBtn.classList.toggle('hidden', !cancellable);
  els.cancelBtn.disabled = false;
  els.cancelBtn.textContent = 'Cancel';

  document.body.classList.toggle('is-busy', !idle && !recordingNow);
  document.body.classList.toggle('is-recording', recordingNow);
  els.progressPanel.classList.toggle('hidden', idle || recordingNow);

  if (idle) {
    els.downloadProgress.classList.add('hidden');
    els.inferenceProgress.classList.add('hidden');
  }
}

function resetTranscript(): void {
  els.transcript.value = '';
  state.segments = [];
  speakerLines = null;
  els.speakersStatus.classList.add('hidden');
  state.exportMeta = null;
  els.runStats.classList.add('hidden');
  els.runStats.textContent = '';
  renderSegments();
  updateCounts();
  updateTranscriptButtons();
}

function updateCounts(): void {
  const text = els.transcript.value;
  const trimmed = text.trim();
  const words = trimmed ? trimmed.split(/\s+/).length : 0;

  els.wordCount.textContent = `${words} word${words === 1 ? '' : 's'}`;
  els.charCount.textContent = `${text.length} char${text.length === 1 ? '' : 's'}`;
}

function updateTranscriptButtons(): void {
  const hasText = els.transcript.value.trim().length > 0;
  els.copyBtn.disabled = !hasText;
  els.downloadBtn.disabled = !hasText;
  els.speakersBtn.disabled = !hasText || !state.audio || state.busy !== 'idle' || diarizing;
  els.clearBtn.disabled = !hasText;
}

async function copyTranscript(): Promise<void> {
  const text = els.transcript.value;
  if (!text) return;

  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable.');
    await navigator.clipboard.writeText(text);
  } catch {
    try {
      els.transcript.focus();
      els.transcript.select();
      const copied = document.execCommand('copy');
      window.getSelection()?.removeAllRanges();
      if (!copied) throw new Error('execCommand copy failed.');
    } catch (error) {
      showError(
        new AppError('Could not copy the transcript automatically.', {
          code: 'COPY_FAILED',
          cause: error,
          hint: 'Select the text and copy it manually with Ctrl+C or Cmd+C.',
        }),
      );
      return;
    }
  }

  showToast('Copied to clipboard.');
}

function downloadTranscript(): void {
  const text = els.transcript.value.trim();
  if (!text) return;

  const format = (els.exportFormat.value as ExportFormat) || 'txt';
  const meta = currentExportMeta();
  const file = buildExport(format, {
    text,
    segments: speakerLines
      ? speakerLines.map((line) => ({ start: line.start, end: line.end, text: line.text, speaker: speakerName(line.speaker) }))
      : realignSegments(state.segments, text),
    duration: meta.duration,
    fileName: meta.fileName,
    modelName: meta.modelName,
    createdAt: meta.createdAt,
  });

  const baseName =
    (meta.fileName ?? 'transcript')
      .replace(/\.[^.]+$/, '')
      .replace(/[^\w.-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'transcript';

  saveBlob(new Blob([file.body], { type: file.mime }), `${baseName}.${file.extension}`);
  showToast(`${file.label} downloaded.`);
}

/* -------------------------------------------------------------------------- */
/* Feedback                                                                   */
/* -------------------------------------------------------------------------- */

function renderReverbLanguages(): void {
  els.ttsReverbLanguage.replaceChildren();
  for (const language of REVERB_LANGUAGES) {
    const option = document.createElement('option');
    option.value = language.id;
    option.textContent = language.label;
    els.ttsReverbLanguage.append(option);
  }
  els.ttsReverbLanguage.value = reverbLanguage;
}

function renderTtsFormats(): void {
  els.ttsFormat.replaceChildren();
  for (const format of TTS_FORMATS) {
    const option = document.createElement('option');
    option.value = format.id;
    option.textContent = format.label;
    els.ttsFormat.append(option);
  }
  els.ttsFormat.value = ttsFormatId;
}

function refreshTtsFormatHint(): void {
  const selected = (els.ttsFormat.value as TtsFormat) || 'mp3';
  const fast = new Set<TtsFormat>(['mp3', 'wav', 'flac', 'm4a', 'webm', 'opus']);
  els.ttsFormatHint.textContent = fast.has(selected)
    ? 'Fast local encoder · no FFmpeg download.'
    : 'FFmpeg fallback · loads the audio engine once.';
}

function renderTtsModel(): void {
  const kokoro = ttsModelId === 'kokoro';
  const woof = ttsModelId === 'woof';
  const reverb = ttsModelId === 'reverb';
  const previousVoice = els.ttsVoice.value;
  els.ttsModel.value = ttsModelId;
  els.ttsKokoroDeviceField.classList.toggle('hidden', !kokoro);
  els.ttsPhonemizerField.classList.toggle('hidden', kokoro || woof || reverb);
  els.ttsReverbFields.classList.toggle('hidden', !reverb);
  els.ttsPhonemizer.value = ttsPhonemizerMode;
  const plugin = ttsPlugin();
  if (plugin) els.ttsPhonemizerField.classList.add('hidden');
  const languages = plugin?.languages?.() ?? [];
  els.ttsLanguageField.classList.toggle('hidden', !languages.length);
  if (languages.length) {
    if (!languages.some((entry) => entry.id === ttsLanguage)) ttsLanguage = plugin?.defaultLanguage ?? languages[0].id;
    els.ttsLanguage.replaceChildren(...languages.map((entry) => new Option(entry.label, entry.id)));
    els.ttsLanguage.value = ttsLanguage;
  }

  const webgpuOption = els.ttsKokoroDevice.querySelector<HTMLOptionElement>(
    'option[value="webgpu"]',
  );
  if (webgpuOption) {
    webgpuOption.disabled = !state.webgpu.supported;
    webgpuOption.textContent = state.webgpu.supported
      ? 'WebGPU · fp32 · ~325 MB'
      : 'WebGPU · unavailable in this browser';
  }
  if (!state.webgpu.supported && ttsKokoroDevice === 'webgpu') {
    ttsKokoroDevice = 'wasm';
  }
  els.ttsKokoroDevice.value = ttsKokoroDevice;
  els.ttsVoice.replaceChildren();

  if (plugin) {
    els.ttsModelTitle.textContent = plugin.title;
    els.ttsModelDescription.textContent = plugin.description;
    els.ttsModelFacts.innerHTML = plugin.facts
      .map((fact) => `<div><p class="field-label">${escapeHtml(fact.label)}</p><p class="mt-1 ${fact.warn ? 'text-amber-200/80' : 'text-slate-300'}">${escapeHtml(fact.value)}</p></div>`)
      .join('');
    els.ttsModelCaveat.textContent = plugin.caveat;
    els.ttsModelLink.href = plugin.link.href;
    els.ttsModelLink.textContent = plugin.link.text;
    for (const voice of plugin.voices()) els.ttsVoice.append(new Option(voice.label, voice.id));
  } else if (reverb) {
    els.ttsModelTitle.textContent = 'Reverb-TTS';
    els.ttsModelDescription.textContent =
      'A 297M-parameter zero-shot voice cloner in seven languages. Give it 3–20 seconds of clean speech and its transcript, and it speaks any text in that voice through the ruNNtime WebGPU runtime.';
    els.ttsModelFacts.innerHTML = `
      <div><p class="field-label">Parameters</p><p class="mt-1 text-slate-300">297M</p></div>
      <div><p class="field-label">Model size</p><p class="mt-1 text-slate-300">~191 MB int4</p></div>
      <div><p class="field-label">Output</p><p class="mt-1 text-slate-300">24 kHz mono</p></div>
      <div><p class="field-label">Languages</p><p class="mt-1 text-slate-300">7</p></div>
      <div><p class="field-label">Voices</p><p class="mt-1 text-slate-300">Zero-shot clone</p></div>
      <div><p class="field-label">License</p><p class="mt-1 text-amber-200/80">Non-commercial</p></div>
    `;
    els.ttsModelCaveat.textContent =
      `${REVERB_LICENSE}. Needs WebGPU with shader-f16 for the best path; the runtime and codec are downloaded once and cached in OPFS. The reference clip is decoded locally and never uploaded.`;
    els.ttsModelLink.href = 'https://huggingface.co/software-mansion/Reverb-TTS';
    els.ttsModelLink.textContent = 'Model card ↗';

    const option = document.createElement('option');
    option.value = 'reference';
    option.textContent = 'Reference voice · your clip';
    els.ttsVoice.append(option);
  } else if (woof) {
    els.ttsModelTitle.textContent = 'Underdog Woof';
    els.ttsModelDescription.textContent =
      'A 38.2M-parameter English text-to-speech model in a 41 MB NumPy weight file. Two voices, 24 kHz output, and no ONNX graph: a typed-array port of the reference runtime runs in a local worker.';
    els.ttsModelFacts.innerHTML = `
      <div><p class="field-label">Parameters</p><p class="mt-1 text-slate-300">38.2M</p></div>
      <div><p class="field-label">Model size</p><p class="mt-1 text-slate-300">41 MB NPZ</p></div>
      <div><p class="field-label">Output</p><p class="mt-1 text-slate-300">24 kHz mono</p></div>
      <div><p class="field-label">Language</p><p class="mt-1 text-slate-300">English</p></div>
      <div><p class="field-label">Voices</p><p class="mt-1 text-slate-300">Juno, Mira</p></div>
      <div><p class="field-label">License</p><p class="mt-1 text-amber-200/80">Non-commercial</p></div>
    `;
    els.ttsModelCaveat.textContent =
      `Weights and port: ${WOOF_LICENSE}. Commercial use needs a license from Underdog. The first generation downloads about 41 MB and caches it locally. The CPU worker keeps the page responsive; the speed slider does not affect Woof.`;
    els.ttsModelLink.href =
      'https://huggingface.co/ConwayResearch/Underdog-Woof';
    els.ttsModelLink.textContent = 'Model card ↗';

    for (const voice of WOOF_VOICES) {
      const option = document.createElement('option');
      option.value = voice.id;
      option.textContent = voice.label;
      els.ttsVoice.append(option);
    }
  } else if (kokoro) {
    els.ttsModelTitle.textContent = 'Kokoro-82M';
    els.ttsModelDescription.textContent =
      'An 82M-parameter StyleTTS2 model with 28 English voices. The selected weights download on first use. Apache 2.0.';
    els.ttsModelFacts.innerHTML = `
      <div><p class="field-label">Parameters</p><p class="mt-1 text-slate-300">82M</p></div>
      <div><p class="field-label">Model size</p><p class="mt-1 text-slate-300">${ttsKokoroDevice === 'wasm-q8' ? '~88 MB Q8' : '~325 MB FP32'}</p></div>
      <div><p class="field-label">Output</p><p class="mt-1 text-slate-300">24 kHz mono</p></div>
      <div><p class="field-label">Language</p><p class="mt-1 text-slate-300">English</p></div>
      <div><p class="field-label">Voices</p><p class="mt-1 text-slate-300">28 US/UK</p></div>
      <div><p class="field-label">Released</p><p class="mt-1 text-slate-300">Jan 2025</p></div>
    `;
    els.ttsModelCaveat.textContent =
      ttsKokoroDevice === 'webgpu'
        ? 'Kokoro runs through kokoro-js on WebGPU with the fp32 ONNX model (about 325 MB, downloaded once). The first load also compiles GPU kernels; later generations reuse them. No text is uploaded.'
        : `Kokoro runs on CPU/WASM with ${ttsKokoroDevice === 'wasm-q8' ? 'Q8' : 'FP32'} weights. The model and voice files are cached locally after the first generation.`;
    els.ttsModelLink.href =
      'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX';
    els.ttsModelLink.textContent = 'Model card ↗';

    for (const voice of KOKORO_VOICES) {
      const option = document.createElement('option');
      option.value = voice.id;
      option.textContent = voice.label;
      els.ttsVoice.append(option);
    }
  } else {
    els.ttsModelTitle.textContent = 'tiny-voca';
    els.ttsModelDescription.textContent =
      'A 4.5M-parameter English text-to-speech model trained from scratch. Two voices, 24 kHz output, and a source-filter waveform generator. Apache 2.0.';
    els.ttsModelFacts.innerHTML = `
      <div><p class="field-label">Parameters</p><p class="mt-1 text-slate-300">4.5M</p></div>
      <div><p class="field-label">Model size</p><p class="mt-1 text-slate-300">21 MB ONNX</p></div>
      <div><p class="field-label">Output</p><p class="mt-1 text-slate-300">24 kHz mono</p></div>
      <div><p class="field-label">Language</p><p class="mt-1 text-slate-300">English</p></div>
      <div><p class="field-label">Voices</p><p class="mt-1 text-slate-300">F2, M2</p></div>
      <div><p class="field-label">Released</p><p class="mt-1 text-slate-300">Nov 2026</p></div>
    `;
    els.ttsModelCaveat.textContent =
      ttsPhonemizerMode === 'fast'
        ? 'The fast phonemizer uses dizione’s 125k-word IPA lexicon plus a local eSpeak-ng fallback (about 3 MB). It skips Pyodide and NumPy, so the first generation starts almost immediately; unusual names use eSpeak. No text leaves the browser.'
        : 'Text is phonemized by dizione inside a local Pyodide worker. dizione’s context and homograph model is more accurate for unusual names. The first run loads about 25 MB of runtime files plus the 21 MB voice model and 5 MB phonemizer data; no network request carries your text.';
    els.ttsModelLink.href = 'https://github.com/n4ze3m/tiny-voca';
    els.ttsModelLink.textContent = 'Model source ↗';

    for (const [value, label] of [
      ['0', 'F2 · female, American English'],
      ['1', 'M2 · male, American English'],
    ] as const) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      els.ttsVoice.append(option);
    }
  }

  renderVoiceGallery();
  updateTtsDownloadHint();
  updateTtsCount();
  updateReverbUi();

  if (!ttsBusy) {
    els.ttsGenerateBtn.disabled = (reverb || Boolean(plugin?.requiresWebgpu)) && !state.webgpu.supported;
  }

  if (reverb && !state.webgpu.supported) {
    els.ttsStatus.textContent =
      'Reverb-TTS needs WebGPU. This browser or device has no usable adapter, so choose another voice engine.';
  }

  if (
    previousVoice &&
    [...els.ttsVoice.options].some((option) => option.value === previousVoice)
  ) {
    els.ttsVoice.value = previousVoice;
    renderVoiceSelection();
  }
}

/** Plays PCM chunks back to back as an engine produces them. */
class LivePlayer {
  private context: AudioContext | null = null;
  private at = 0;

  push(pcm: Float32Array, sampleRate: number): void {
    this.context ??= new AudioContext({ sampleRate });
    const buffer = this.context.createBuffer(1, pcm.length, sampleRate);
    buffer.getChannelData(0).set(pcm);
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);
    // A short lead keeps the first chunks from underrunning.
    this.at = Math.max(this.at, this.context.currentTime + 0.12);
    source.start(this.at);
    this.at += buffer.duration;
  }

  stop(): void {
    void this.context?.close().catch(() => undefined);
    this.context = null;
  }
}

/** A short preview sentence in the engine's language. */
function previewTextFor(language: string): string {
  const samples: Record<string, string> = {
    en: PREVIEW_TEXT,
    es: 'Hola, esta es una vista previa de mi voz, generada en tu propio dispositivo.',
    fr: 'Bonjour, ceci est un aperçu de ma voix, généré sur votre appareil.',
    de: 'Hallo, das ist eine Vorschau meiner Stimme, direkt auf deinem Gerät erzeugt.',
    pt: 'Olá, esta é uma prévia da minha voz, gerada no seu próprio aparelho.',
    it: 'Ciao, questa è un’anteprima della mia voce, generata sul tuo dispositivo.',
    ja: 'こんにちは。これはあなたの端末で作られた音声のプレビューです。',
    ko: '안녕하세요. 이 기기에서 만든 목소리 미리 듣기입니다.',
  };
  return samples[language] ?? PREVIEW_TEXT;
}

function warmTinyVoca(): void {
  if (ttsWarmStarted || ttsBusy || ttsModelId !== 'tiny-voca') return;
  ttsWarmStarted = true;

  if (!ttsEngine) ttsEngine = new TinyVocaEngine(ttsPhonemizerMode);
  void ttsEngine.load().catch(() => {
    // A real Generate click will retry and show the error.
    ttsWarmStarted = false;
  });
}

async function generateSpeech(): Promise<void> {
  if (ttsBusy) return;

  const prepared = prepareSpeechText(els.ttsText.value);
  const text = prepared.text;
  if (!text) {
    els.ttsStatus.textContent = 'Type some English text first.';
    els.ttsText.focus();
    return;
  }
  if (isEnglishOnlyEngine(ttsModelId) && prepared.nonLatinShare > 0.3) {
    els.ttsStatus.textContent = 'This voice only speaks English, and most of this text is in another script. Choose Supertonic 3 or Reverb-TTS for other languages.';
    els.ttsText.focus();
    return;
  }

  if (text.length > TTS_TEXT_LIMIT) {
    els.ttsStatus.textContent = `Shorten the text to ${TTS_TEXT_LIMIT.toLocaleString()} characters.`;
    els.ttsText.focus();
    return;
  }

  const format = ttsFormatId;

  ttsBusy = true;
  els.ttsKokoroDevice.disabled = true;
  // Switching engine or voice mid-generation used to warm another engine on
  // the shared phonemizer and leave Kokoro stuck. Lock them until it ends.
  els.ttsModel.disabled = true;
  els.ttsVoice.disabled = true;
  ttsCancelled = false;
  ttsAbort = new AbortController();
  els.ttsGenerateBtn.disabled = true;
  els.ttsCancelBtn.classList.remove('hidden');
  els.ttsCancelBtn.disabled = false;
  els.ttsCancelBtn.textContent = 'Cancel';
  els.ttsResult.classList.add('hidden');
  els.ttsProgress.classList.remove('hidden');
  els.ttsProgressLabel.textContent = 'Starting the local voice…';
  els.ttsProgressDetail.textContent = '0%';
  setBar(els.ttsProgressBar, 0);

  let result: TtsResult | null = null;
  const plugin = ttsPlugin();
  let live: LivePlayer | null = null;

  try {
    if (plugin) {
      await plugin.load((progress) => {
        const percent = downloadPercent(progress.loaded, progress.total, 5, 5, 85);
        els.ttsProgressLabel.textContent = withTransfer(ttsMeter, progress.text, progress.loaded, progress.total);
        els.ttsProgressDetail.textContent = `${Math.round(percent)}%`;
        setBar(els.ttsProgressBar, percent);
      }, ttsAbort.signal);
      if (plugin.streams) live = new LivePlayer();
      const audio = await plugin.speak({
        text,
        voice: els.ttsVoice.value,
        speed: Number(els.ttsSpeed.value),
        language: ttsLanguage || plugin.defaultLanguage,
        signal: ttsAbort.signal,
        onChunk: live ? (pcm, rate) => live!.push(pcm, rate) : undefined,
        onProgress: (fraction, label) => {
          els.ttsProgressLabel.textContent = label + (live ? ' · playing as it speaks' : '');
          els.ttsProgressDetail.textContent = fraction === null ? '' : `${Math.round(fraction * 100)}%`;
          setBar(els.ttsProgressBar, fraction === null ? 90 : fraction * 100);
        },
      });
      result = ttsResultFromSamples(audio.samples, audio.sampleRate);
    } else if (ttsModelId === 'kokoro') {
      if (!kokoroEngine) kokoroEngine = new KokoroEngine(ttsKokoroDevice);
      await kokoroEngine.load((progress) => {
        const percent = progress.phase === 'ready' ? 100 : downloadPercent(progress.loaded, progress.total, 10, 5, 90);
        els.ttsProgressLabel.textContent = withTransfer(ttsMeter, progress.text, progress.loaded, progress.total);
        els.ttsProgressDetail.textContent = `${Math.round(percent)}%`;
        setBar(els.ttsProgressBar, percent);
      });

      result = await kokoroEngine.speak(
        text,
        els.ttsVoice.value,
        Number(els.ttsSpeed.value),
        (done, total) => {
          const percent = total > 0 ? (done / total) * 100 : 0;
          els.ttsProgressLabel.textContent =
            done >= total
              ? 'Finishing the audio…'
              : `Synthesizing sentence ${Math.min(done + 1, total)} of ${total}…`;
          els.ttsProgressDetail.textContent = `${Math.round(percent)}%`;
          setBar(els.ttsProgressBar, percent);
        },
        () => ttsCancelled,
        ttsAbort.signal,
      );
    } else if (ttsModelId === 'woof') {
      if (!woofEngine) woofEngine = new WoofTtsEngine();

      await woofEngine.load((progress) => {
        const percent =
          progress.phase === 'prepare'
            ? 95
            : progress.total > 0
              ? Math.min(90, (progress.loaded / progress.total) * 90)
              : 5;
        els.ttsProgressLabel.textContent = progress.phase === 'download' && !progress.cached
          ? withTransfer(ttsMeter, 'Downloading Woof weights', progress.loaded, progress.total)
          : woofProgressText(progress);
        els.ttsProgressDetail.textContent = `${Math.round(percent)}%`;
        setBar(els.ttsProgressBar, percent);
      }, ttsAbort.signal);

      result = await woofEngine.speak(
        text,
        els.ttsVoice.value,
        (progress) => {
          const percent =
            progress.pieces && progress.pieces > 0
              ? ((progress.piece ?? 0) / progress.pieces) * 100
              : 0;
          els.ttsProgressLabel.textContent = woofProgressText(progress);
          els.ttsProgressDetail.textContent = `${Math.round(percent)}%`;
          setBar(els.ttsProgressBar, percent);
        },
        ttsAbort.signal,
      );
    } else if (ttsModelId === 'reverb') {
      if (!reverbClip) {
        throw new Error('Add a reference clip and its transcript first.');
      }
      if (!els.ttsReverbTranscript.value.trim()) {
        throw new Error('Type what the reference clip says first.');
      }

      const voice =
        reverbVoice ??
        (await buildReverbVoice(ttsAbort.signal, (progress) => {
          const percent = progress.phase === 'ready' ? 90 : downloadPercent(progress.loaded, progress.total, 25, 5, 80);
          els.ttsProgressLabel.textContent = progress.text;
          els.ttsProgressDetail.textContent = `${percent}%`;
          setBar(els.ttsProgressBar, percent);
        }));

      if (!voice || !reverbEngine) {
        throw new Error('The reference voice could not be built.');
      }

      els.ttsProgressLabel.textContent = 'Cloning the reference voice…';
      els.ttsProgressDetail.textContent = '92%';
      setBar(els.ttsProgressBar, 92);

      const audio = await reverbEngine.speak(
        text,
        voice,
        { steps: 8, seed: 0 },
        (done, total) => {
          const percent = total > 0 ? 92 + (done / total) * 8 : 92;
          els.ttsProgressLabel.textContent = `Cloning the reference voice · ${Math.min(
            done + 1,
            total,
          )} of ${total}…`;
          els.ttsProgressDetail.textContent = `${Math.round(percent)}%`;
          setBar(els.ttsProgressBar, percent);
        },
      );
      result = ttsResultFromSamples(audio.samples, audio.sampleRate);
    } else {
      if (!ttsEngine) ttsEngine = new TinyVocaEngine(ttsPhonemizerMode);

      await ttsEngine.load((progress) => {
        const percent =
          progress.phase === 'ready'
            ? 100
            : progress.phase === 'model'
              ? downloadPercent(progress.loaded, progress.total, 55, 40, 55)
              : progress.phase === 'phonemes'
                ? 35
                : 15;
        els.ttsProgressLabel.textContent = withTransfer(ttsMeter, progress.text, progress.loaded, progress.total);
        els.ttsProgressDetail.textContent = `${Math.round(percent)}%`;
        setBar(els.ttsProgressBar, percent);
      });

      result = await ttsEngine.speak(
        text,
        Number(els.ttsVoice.value),
        Number(els.ttsSpeed.value),
        (done, total) => {
          const percent = total > 0 ? (done / total) * 100 : 0;
          els.ttsProgressLabel.textContent =
            done >= total
              ? 'Finishing the audio…'
              : `Synthesizing sentence ${Math.min(done + 1, total)} of ${total}…`;
          els.ttsProgressDetail.textContent = `${Math.round(percent)}%`;
          setBar(els.ttsProgressBar, percent);
        },
        () => ttsCancelled,
      );
    }

    els.ttsProgressLabel.textContent = 'Encoding the selected format…';
    els.ttsProgressDetail.textContent = '100%';
    setBar(els.ttsProgressBar, 100);

    const generated = result;
    const output = await convertTtsResult(generated, format, (status) => {
      els.ttsProgressLabel.textContent = status;
    });

    if (output.url !== generated.url) URL.revokeObjectURL(generated.url);
    result = null;

    els.ttsProgressLabel.textContent = 'Speech ready.';
    els.ttsProgressDetail.textContent = '100%';
    setBar(els.ttsProgressBar, 100);
    showSpeechResult(output);
    els.ttsStatus.textContent = `The ${output.extension.toUpperCase()} audio is ready. Play it here or download it; everything was generated locally.`;
  } catch (error) {
    live?.stop();
    if (result) URL.revokeObjectURL(result.url);
    if (isAbortError(error) || (error instanceof Error && error.name === 'AbortError')) {
      els.ttsStatus.textContent = 'Speech generation cancelled.';
    } else {
      els.ttsStatus.textContent = describeError(error);
    }
    els.ttsProgress.classList.add('hidden');
  } finally {
    ttsBusy = false;
    els.ttsKokoroDevice.disabled = previewBusy;
    els.ttsModel.disabled = false;
    els.ttsVoice.disabled = false;
    ttsAbort = null;
    els.ttsGenerateBtn.disabled = false;
    els.ttsCancelBtn.classList.add('hidden');
    els.ttsCancelBtn.disabled = false;
    els.ttsCancelBtn.textContent = 'Cancel';
  }
}

function showSpeechResult(result: TtsOutput): void {
  if (ttsObjectUrl) URL.revokeObjectURL(ttsObjectUrl);
  ttsObjectUrl = result.url;

  els.ttsAudio.src = result.url;
  els.ttsDownload.href = result.url;
  const plugin = ttsPlugin();
  els.ttsDownload.download = `${
    plugin ? plugin.slug : ttsModelId === 'kokoro'
      ? 'kokoro'
      : ttsModelId === 'woof'
        ? 'underdog-woof'
        : ttsModelId === 'reverb'
          ? 'reverb-tts'
          : 'tiny-voca'
  }.${result.extension}`;
  els.ttsDownload.textContent = `Download ${result.extension.toUpperCase()}`;
  els.ttsMeta.textContent = `${result.sampleRate / 1000} kHz mono · ${result.extension.toUpperCase()} · ${formatDuration(result.duration)} · ${
    plugin ? plugin.title : ttsModelId === 'kokoro'
      ? 'Kokoro-82M'
      : ttsModelId === 'woof'
        ? 'Underdog Woof'
        : ttsModelId === 'reverb'
          ? 'Reverb-TTS'
          : 'tiny-voca'
  }`;
  els.ttsResult.classList.remove('hidden');
}

function setStatus(message: string): void {
  els.statusLine.textContent = message;
}

function clearError(): void {
  els.errorBanner.classList.add('hidden');
  els.errorMessage.textContent = '';
  els.errorHint.textContent = '';
  els.errorHint.classList.add('hidden');
}

function showError(error: unknown): void {
  console.error('[LocalScribe]', error);

  let title = 'Something went wrong';
  let hint = '';

  if (error instanceof AppError) {
    hint = error.hint ?? '';

    if (error.code.includes('AUDIO') || error.code.includes('FILE') || error.code === 'RESAMPLE_FAILED') {
      title = 'Could not read that audio';
    } else if (
      error.code.includes('STORAGE') ||
      error.code.includes('QUOTA') ||
      error.code.includes('CACHE')
    ) {
      title = 'Storage problem';
    } else if (
      error.code.includes('MODEL') ||
      error.code.includes('DOWNLOAD') ||
      error.code.includes('TENSOR') ||
      error.code.includes('DECODER') ||
      error.code.includes('ENCODER') ||
      error.code.includes('FRONTEND') ||
      error.code.includes('RANGE') ||
      error.code.includes('VOCAB') ||
      error.code.includes('TDT')
    ) {
      title = 'Model problem';
    }
  }

  els.errorTitle.textContent = title;
  els.errorMessage.textContent = describeError(error);
  els.errorHint.textContent = hint;
  els.errorHint.classList.toggle('hidden', !hint);
  els.errorBanner.classList.remove('hidden');
  els.errorBanner.scrollIntoView({ behavior: 'smooth', block: 'center' });

  setStatus('See the message above for details.');
}

function showToast(message: string): void {
  if (toastTimer !== null) {
    window.clearTimeout(toastTimer);
    toastTimer = null;
  }

  els.toast.textContent = message;
  els.toast.classList.remove('hidden');

  toastTimer = window.setTimeout(() => {
    els.toast.classList.add('hidden');
    toastTimer = null;
  }, 3200);
}
