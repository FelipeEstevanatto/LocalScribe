import type { ModelId } from './catalog';

/**
 * Job-shaped starting points. The model shelf is the product's strength, but a
 * first-time visitor should not have to compare ten error rates to choose.
 */
export interface JobPreset {
  id: string;
  label: string;
  detail: string;
  modelId: ModelId;
  language?: string;
  clean?: boolean;
  requiresWebGPU?: boolean;
}

export const JOB_PRESETS: JobPreset[] = [
  {
    id: 'voice-note',
    label: 'Voice note',
    detail: 'Short clips · Moonshine Tiny',
    modelId: 'moonshine-tiny',
  },
  {
    id: 'dictation',
    label: 'English dictation',
    detail: 'Best default · 300 MB',
    modelId: 'fluid-mini',
  },
  {
    id: 'multilingual',
    label: 'Multilingual',
    detail: '25 languages · Parakeet Ultra · 402 MB',
    modelId: 'parakeet-ultra',
  },
  {
    id: 'meeting',
    label: 'Meeting',
    detail: 'Auto language · 987 MB',
    modelId: 'qwen3-asr-0.6b',
  },
  {
    id: 'accuracy',
    label: 'Compact multilingual transcription',
    detail: '25 languages · Phonon-2.5 · 380 MB',
    modelId: 'phonon-2.5',
  },
  {
    id: 'translation',
    label: 'Punctuation + translation',
    detail: 'WebGPU · 1.73 GB',
    modelId: 'granite-speech-5',
    requiresWebGPU: true,
  },
  {
    id: 'long-tail',
    label: 'Long-tail languages',
    detail: '1,600+ languages · Omnilingual',
    modelId: 'omnilingual-300m',
  },
];
