import { getOrt } from './ort-runtime';
import { analyzeTrack, type MusicEstimate } from './music-analysis';
import type { EditorAudio } from './audio-edit';
import { fetchWithProgress } from './transfer';
import { MUSIC_MODEL_CACHE, MUSIC_MODEL_VARIANTS, type MusicModelVariant } from './music-model';

export type MusicRequest =
  | { task: 'download'; variant: MusicModelVariant }
  | { task: 'analyze'; blob: Blob; audio: EditorAudio }
  | { task: 'vocals' | 'stems'; variant: MusicModelVariant; blob: Blob; audio: EditorAudio; passes?: number };
export type MusicResponse =
  | { type: 'progress'; message: string; stage: 'download' | 'prepare' | 'separate'; fraction?: number; loaded?: number; total?: number }
  | { type: 'estimate'; estimate: MusicEstimate }
  | { type: 'downloaded' }
  | { type: 'stems'; stems: { name: string; blob: Blob }[] }
  | { type: 'error'; message: string };

const worker = self as unknown as Worker;
const SAMPLE_RATE = 44100;
const FRAMES = 343980;
const OVERLAP = Math.floor(FRAMES / 4);
const STEP = FRAMES - OVERLAP;

function post(message: MusicResponse): void {
  worker.postMessage(message);
}

async function loadWeights(variant: MusicModelVariant, requireCache = false): Promise<ArrayBuffer> {
  const { url, bytes: size } = MUSIC_MODEL_VARIANTS[variant];
  const cache = typeof caches === 'undefined' ? null : await caches.open(MUSIC_MODEL_CACHE).catch(() => null);
  if (requireCache && !cache) throw new Error('The browser cannot save model weights. You can still separate a track directly.');
  const cached = await cache?.match(url);
  if (cached) {
    const bytes = await cached.arrayBuffer().catch(() => null);
    if (bytes?.byteLength === size) return bytes;
    await cache?.delete(url);
  }
  const message = 'Downloading the separation model (first use only)';
  post({ type: 'progress', stage: 'download', message, loaded: 0, total: size });
  let lastPost = 0;
  let bytes: ArrayBuffer;
  try {
    bytes = await fetchWithProgress(url, (loaded, total) => {
      const now = performance.now();
      if (now - lastPost < 150 && loaded < total) return;
      lastPost = now;
      post({ type: 'progress', stage: 'download', message, loaded, total: total || size });
    }, { expectedBytes: size });
  } catch (error) {
    throw new Error('Could not download the HTDemucs model. ' + (error instanceof Error ? error.message : ''));
  }
  if (bytes.byteLength !== size) throw new Error('The HTDemucs download was incomplete.');
  try {
    await cache?.put(url, new Response(bytes));
  } catch {
    if (requireCache) throw new Error('The browser could not save the model. Check storage space or separate a track directly.');
  }
  return bytes;
}

function stereoWav(samples: Float32Array): Blob {
  const header = new DataView(new ArrayBuffer(44));
  header.setUint32(0, 0x52494646);
  header.setUint32(4, 36 + samples.byteLength, true);
  header.setUint32(8, 0x57415645);
  header.setUint32(12, 0x666d7420);
  header.setUint32(16, 16, true);
  header.setUint16(20, 3, true);
  header.setUint16(22, 2, true);
  header.setUint32(24, SAMPLE_RATE, true);
  header.setUint32(28, SAMPLE_RATE * 8, true);
  header.setUint16(32, 8, true);
  header.setUint16(34, 32, true);
  header.setUint32(36, 0x64617461);
  header.setUint32(40, samples.byteLength, true);
  return new Blob([header.buffer, samples.buffer as ArrayBuffer], { type: 'audio/wav' });
}

/** One separation pass over `pcm` (interleaved stereo), accumulating into `output`. */
async function separatePass(
  session: Awaited<ReturnType<Awaited<ReturnType<typeof getOrt>>['InferenceSession']['create']>>,
  ort: Awaited<ReturnType<typeof getOrt>>,
  pcm: Float32Array,
  shift: number,
  picks: number[],
  stemCount: number,
  output: Float32Array[],
  report: (fraction: number, message: string) => void,
): Promise<void> {
  // Shifting the input by a fraction of a second and averaging passes
  // ("shift trick") reduces chunk-boundary artefacts.
  const total = pcm.length / 2 + shift;
  const chunk = new Float32Array(FRAMES * 2);
  const count = Math.max(1, 1 + Math.ceil((total - FRAMES) / STEP));
  for (let segment = 0; segment < count; segment += 1) {
    report(segment / count, 'Separating section ' + (segment + 1) + ' of ' + count);
    const start = segment * STEP;
    const valid = Math.min(FRAMES, total - start);
    chunk.fill(0);
    for (let i = 0; i < valid; i += 1) {
      const source = start + i - shift;
      if (source < 0) continue;
      chunk[i] = pcm[source * 2];
      chunk[FRAMES + i] = pcm[source * 2 + 1];
    }
    const input = new ort.Tensor('float32', chunk, [1, 2, FRAMES]);
    const result = await session.run({ mix: input });
    try {
      const stems = result.stems?.data;
      if (!(stems instanceof Float32Array) || stems.length !== stemCount * 2 * FRAMES) {
        throw new Error('HTDemucs returned an unexpected stem shape.');
      }
      for (let i = 0; i < valid; i += 1) {
        const target = start + i - shift;
        if (target < 0) continue;
        let weight = 1;
        if (segment && i < OVERLAP) weight = i / OVERLAP;
        if (segment < count - 1 && i >= STEP) weight = (FRAMES - i) / OVERLAP;
        picks.forEach((stem, out) => {
          const offset = 2 * FRAMES * stem;
          output[out][target * 2] += stems[offset + i] * weight;
          output[out][target * 2 + 1] += stems[offset + FRAMES + i] * weight;
        });
      }
    } finally {
      for (const tensor of Object.values(result)) tensor.dispose();
      input.dispose();
    }
  }
}

type MusicSession = Awaited<ReturnType<Awaited<ReturnType<typeof getOrt>>['InferenceSession']['create']>>;

let sessionCache: { variant: MusicModelVariant; session: MusicSession } | null = null;

/** Reuse the ONNX session while the same separation model stays selected. */
async function getSession(variant: MusicModelVariant): Promise<MusicSession> {
  if (sessionCache?.variant === variant) return sessionCache.session;
  if (sessionCache) {
    await sessionCache.session.release().catch(() => undefined);
    sessionCache = null;
  }
  const ort = await getOrt('wasm');
  const weights = await loadWeights(variant);
  post({ type: 'progress', stage: 'prepare', message: 'Starting the separation engine…' });
  // Constant folding on this export can make large temporary tensors and exceed
  // the browser's WASM memory limit. Leave the model graph intact.
  ort.env.wasm.numThreads = Math.min(ort.env.wasm.numThreads ?? 1, 4);
  const session = await ort.InferenceSession.create(weights, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'disabled',
    extra: { session: { disable_prepacking: '1' } },
  });
  sessionCache = { variant, session };
  return session;
}

async function separate(blob: Blob, audio: EditorAudio, vocalsOnly: boolean, variant: MusicModelVariant, passes: number): Promise<void> {
  if (audio.channels !== 2 || audio.sampleRate !== SAMPLE_RATE) throw new Error('The separator needs stereo audio at 44.1 kHz.');
  const ort = await getOrt('wasm');
  const session = await getSession(variant);
  try {
    const total = Math.round(audio.duration * SAMPLE_RATE);
    const pcm = new Float32Array(await blob.slice(audio.dataOffset, audio.dataOffset + total * 8).arrayBuffer());
    const all = MUSIC_MODEL_VARIANTS[variant].stems;
    const vocalIndex = all.indexOf('Vocals');
    const names = vocalsOnly ? ['Vocals', 'Instrumental'] : all;
    const picks = vocalsOnly ? [vocalIndex] : all.map((_, i) => i);
    const output = names.map(() => new Float32Array(pcm.length));
    const count = Math.max(1, Math.round(passes));
    for (let pass = 0; pass < count; pass += 1) {
      // Spread the shifts over half a second; the first pass is unshifted.
      const shift = pass === 0 ? 0 : Math.round((SAMPLE_RATE / 2) * (pass / count));
      await separatePass(session, ort, pcm, shift, picks, all.length, output, (fraction, message) => {
        post({
          type: 'progress', stage: 'separate', fraction: (pass + fraction) / count,
          message: count > 1 ? `Pass ${pass + 1} of ${count} · ${message}` : message,
        });
      });
    }
    if (count > 1) for (const stem of output) for (let i = 0; i < stem.length; i += 1) stem[i] /= count;
    post({ type: 'progress', stage: 'separate', message: 'Writing stems', fraction: 1 });
    if (vocalsOnly) {
      for (let i = 0; i < pcm.length; i += 1) output[1][i] = pcm[i] - output[0][i];
    }
    post({ type: 'stems', stems: names.map((name, i) => ({ name, blob: stereoWav(output[i]) })) });
  } catch (error) {
    // An inference failure may leave the session in a bad state; rebuild it
    // on the next run instead of reusing it.
    sessionCache = null;
    await session.release().catch(() => undefined);
    throw error;
  }
}

worker.onmessage = async ({ data }: MessageEvent<MusicRequest>) => {
  try {
    if (data.task === 'download') {
      await loadWeights(data.variant, true);
      post({ type: 'downloaded' });
    } else if (data.task === 'analyze') {
      post({ type: 'estimate', estimate: await analyzeTrack(data.blob, data.audio) });
    } else {
      await separate(data.blob, data.audio, data.task === 'vocals', data.variant, data.passes ?? 1);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    post({
      type: 'error',
      message: /bad_alloc|out of memory/i.test(message)
        ? 'The browser ran out of memory during separation. Close other tabs or try the smaller HTDemucs download.'
        : message,
    });
  }
};

