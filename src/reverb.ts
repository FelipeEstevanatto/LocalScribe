/**
 * Reverb-TTS voice cloning.
 *
 * Reverb (software-mansion/Reverb-TTS) is a 297M-parameter zero-shot voice
 * cloner. It runs through Software Mansion's `runntime` runtime on WebGPU with
 * TypeGPU. Weights are int4 (about 191 MB) plus the Higgs Audio v2 codec.
 *
 * License: the Reverb weights are CC BY-NC 4.0 (non-commercial). The runtime
 * itself is MIT. Credit: "Reverb-TTS by Software Mansion".
 */

import type {
  ReverbLanguage,
  TextToSpeech,
  TextToSpeechModel,
  Voice,
  VoiceMaker,
  WeightCache,
} from 'runntime/zoo';

export const REVERB_LANGUAGES: Array<{ id: ReverbLanguage; label: string }> = [
  { id: 'en', label: 'English' },
  { id: 'de', label: 'German' },
  { id: 'fr', label: 'French' },
  { id: 'es', label: 'Spanish' },
  { id: 'it', label: 'Italian' },
  { id: 'pl', label: 'Polish' },
  { id: 'pt', label: 'Portuguese' },
];

export const REVERB_LICENSE =
  'Reverb-TTS by Software Mansion · CC BY-NC 4.0 (non-commercial)';

export interface ReverbProgress {
  phase: 'runtime' | 'weights' | 'ready';
  text: string;
  loaded?: number;
  total?: number;
}

export interface ReverbVoice {
  readonly codes: Int32Array;
  readonly frames: number;
  readonly transcript: string;
  readonly language: ReverbLanguage;
  readonly speechFrames?: number;
}

let runtimeReady: Promise<void> | null = null;

/** Reverb handles one pass at a time; keep each pass short and natural. */
function splitReverbText(text: string): string[] {
  const sentences = text
    .replace(/\s+/gu, ' ')
    .trim()
    .split(/(?<=[.!?…])\s+/u)
    .filter((sentence) => /[\p{L}\p{N}]/u.test(sentence));

  if (sentences.length === 0) return [text];

  const pieces: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    if (current && current.length + sentence.length > 320) {
      pieces.push(current);
      current = sentence;
    } else {
      current = current ? `${current} ${sentence}` : sentence;
    }
  }
  if (current) pieces.push(current);
  return pieces;
}

export async function ensureReverbRuntime(): Promise<void> {
  if (runtimeReady) return runtimeReady;

  runtimeReady = (async () => {
    if (!('gpu' in navigator) || !navigator.gpu) {
      throw new Error(
        'Reverb-TTS needs WebGPU. Use Chrome or Edge with hardware acceleration enabled.',
      );
    }

    const [{ default: tgpu }, runntime] = await Promise.all([
      import('typegpu'),
      import('runntime/zoo'),
    ]);

    const adapter = await navigator.gpu.requestAdapter({
      powerPreference: 'high-performance',
    });
    if (!adapter) {
      throw new Error(
        'No WebGPU adapter is available. Reverb-TTS cannot run on this device.',
      );
    }

    const root = await tgpu.init({
      device: { optionalFeatures: ['subgroups', 'shader-f16'] },
    });
    runntime.initRunntime(root);
  })().catch((error) => {
    runtimeReady = null;
    throw error;
  });

  return runtimeReady;
}

export class ReverbEngine {
  private tts: TextToSpeech | null = null;
  private voiceMaker: VoiceMaker | null = null;
  private cache: WeightCache | undefined;
  get loaded(): boolean {
    return Boolean(this.tts && this.voiceMaker);
  }

  async load(
    onProgress?: (progress: ReverbProgress) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.loaded) return;

    onProgress?.({ phase: 'runtime', text: 'Starting the WebGPU runtime…' });
    await ensureReverbRuntime();

    const runntime = await import('runntime/zoo');
    const config: TextToSpeechModel = runntime.models.textToSpeech.REVERB.INT4;

    if (!this.cache) {
      this.cache = await runntime
        .createOpfsCache('localscribe-reverb')
        .catch(() => undefined);
    }

    let downloaded = 0;
    const onBytes = (chunk: number) => {
      downloaded += chunk;
      onProgress?.({
        phase: 'weights',
        text: `Downloading Reverb-TTS · ${(downloaded / 1_000_000).toFixed(0)} MB…`,
        loaded: downloaded,
      });
    };

    const common = {
      cache: this.cache,
      signal,
      onBytes,
      onProgress: (name: string, done: number, total: number) => {
        const percent = total > 0 ? Math.min(100, (done / total) * 100) : 0;
        onProgress?.({
          phase: 'weights',
          text: `Preparing Reverb-TTS · ${name} · ${percent.toFixed(0)}%`,
          loaded: done,
          total,
        });
      },
    };

    onProgress?.({
      phase: 'weights',
      text: 'Loading the Reverb voice encoder…',
    });
    this.voiceMaker = await runntime.createVoiceMaker(config, common);

    onProgress?.({
      phase: 'weights',
      text: 'Loading the Reverb speech model and codec…',
    });
    this.tts = await runntime.createTextToSpeech(config, common);

    onProgress?.({
      phase: 'ready',
      text: 'Reverb-TTS is ready.',
    });
  }

  async createVoice(
    samples: Float32Array,
    sampleRate: number,
    transcript: string,
    language: ReverbLanguage,
  ): Promise<ReverbVoice> {
    if (!this.voiceMaker) throw new Error('Reverb-TTS is not loaded yet.');
    return this.voiceMaker.fromRecording(samples, {
      sampleRate,
      transcript,
      language,
    });
  }

  async speak(
    text: string,
    voice: ReverbVoice,
    options: { steps?: number; seed?: number } = {},
    onProgress?: (done: number, total: number) => void,
  ): Promise<{ samples: Float32Array; sampleRate: number }> {
    if (!this.tts) throw new Error('Reverb-TTS is not loaded yet.');

    const pieces = splitReverbText(text);
    const chunks: Float32Array[] = [];
    for (let index = 0; index < pieces.length; index += 1) {
      onProgress?.(index, pieces.length);
      chunks.push(
        await this.tts.synthesize(pieces[index], voice as Voice, options),
      );
    }

    const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const samples = new Float32Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      samples.set(chunk, offset);
      offset += chunk.length;
    }

    onProgress?.(pieces.length, pieces.length);
    return { samples, sampleRate: this.tts.sampleRate };
  }

  dispose(): void {
    this.tts?.dispose();
    this.voiceMaker?.dispose();
    this.tts = null;
    this.voiceMaker = null;
  }
}
