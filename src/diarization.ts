/**
 * Speaker diarization ("who spoke when") with NVIDIA Nemotron 3 Diarization.
 *
 * The ONNX export runs one step of the Streaming Sortformer: a chunk of log-mel
 * frames plus the cached frame embeddings of earlier chunks in, per-speaker
 * logits (10 ms) and the chunk's embeddings out. The Arrival-Order Speaker
 * Cache that keeps speaker identities stable across chunks is ported here from
 * the reference Transformers implementation
 * (Nemotron3DiarizationSpeakerCache, offline configuration).
 */

import { computeNemoLogMel } from './mel';
import { getOrt } from './ort-runtime';
import { fetchWithProgress } from './transfer';

const REPO = 'onnx-community/Nemotron-3-Diarization-ONNX';
const REVISION = '353b6f8ad2cac3580e982d7fbdf0a010786b0406';
const BASE = `https://huggingface.co/${REPO}/resolve/${REVISION}/onnx/`;
export const DIARIZATION_CACHE = 'localscribe-diarization-v1';

export const DIARIZATION_VARIANTS = {
  // fp16 activations need WebGPU shader-f16; q4 runs everywhere.
  q4f16: { graph: 'model_q4f16.onnx', data: 'model_q4f16.onnx_data', bytes: 73_100_000 },
  q4: { graph: 'model_q4.onnx', data: 'model_q4.onnx_data', bytes: 82_800_000 },
};
export type DiarizationVariant = keyof typeof DIARIZATION_VARIANTS;

/* Offline configuration (config.json, streaming_config) --------------------- */
const SUBSAMPLING = 8;
const NUM_SPEAKERS = 8;
const CHUNK_LENGTH = 340;
const CHUNK_RIGHT_CONTEXT = 40;
const FIFO_LENGTH = 40;
const UPDATE_PERIOD = 300;
const CACHE_LENGTH = 264;
const SILENCE_FRAMES = 1;
const SCORE_THRESHOLD = 0.25;
const LATEST_BOOST = 0.05;
const BUDGET = Math.floor(CACHE_LENGTH / NUM_SPEAKERS) - SILENCE_FRAMES;
const MIN_POSITIVE = Math.floor(BUDGET * 0.5);
const STRONG_BOOSTED = Math.floor(BUDGET * 0.75);
const WEAK_BOOSTED = Math.floor(BUDGET * 1.5);
const HIDDEN = 512;

/** Frames of `width` floats stored back to back. */
class Frames {
  constructor(public data: Float32Array, public width: number) {}
  get length(): number {
    return this.data.length / this.width;
  }
  static empty(width: number): Frames {
    return new Frames(new Float32Array(0), width);
  }
  slice(from: number, to: number): Frames {
    return new Frames(this.data.subarray(from * this.width, to * this.width), this.width);
  }
  static concat(width: number, ...parts: Frames[]): Frames {
    const total = parts.reduce((sum, part) => sum + part.data.length, 0);
    const out = new Float32Array(total);
    let offset = 0;
    for (const part of parts) {
      out.set(part.data, offset);
      offset += part.data.length;
    }
    return new Frames(out, width);
  }
  row(index: number): Float32Array {
    return this.data.subarray(index * this.width, (index + 1) * this.width);
  }
}

/** Frame scores used to pick which frames represent each speaker. */
export function frameScores(probs: Frames): Float64Array {
  const frames = probs.length;
  const scores = new Float64Array(frames * NUM_SPEAKERS);
  const positives = new Int32Array(NUM_SPEAKERS);
  const ln = Math.log;
  for (let f = 0; f < frames; f += 1) {
    const row = probs.row(f);
    let complementSum = 0;
    for (let s = 0; s < NUM_SPEAKERS; s += 1) complementSum += ln(Math.max(1 - row[s], SCORE_THRESHOLD));
    for (let s = 0; s < NUM_SPEAKERS; s += 1) {
      const p = row[s];
      let score = ln(Math.max(p, SCORE_THRESHOLD)) - ln(Math.max(1 - p, SCORE_THRESHOLD)) + complementSum - ln(0.5);
      if (!(p > 0.5)) score = -Infinity;
      scores[f * NUM_SPEAKERS + s] = score;
      if (score > 0) positives[s] += 1;
    }
  }
  for (let f = 0; f < frames; f += 1) {
    const row = probs.row(f);
    for (let s = 0; s < NUM_SPEAKERS; s += 1) {
      const index = f * NUM_SPEAKERS + s;
      const isSpeech = row[s] > 0.5;
      if (!(scores[index] > 0) && isSpeech && positives[s] >= MIN_POSITIVE) scores[index] = -Infinity;
    }
  }
  return scores;
}

/** Add `boost` to each speaker's `count` best frames (torch.topk along frames). */
function boostScores(scores: Float64Array, frames: number, count: number, boost: number): void {
  const take = Math.min(count, frames);
  const order = new Int32Array(frames);
  for (let s = 0; s < NUM_SPEAKERS; s += 1) {
    for (let f = 0; f < frames; f += 1) order[f] = f;
    order.sort((a, b) => scores[b * NUM_SPEAKERS + s] - scores[a * NUM_SPEAKERS + s] || a - b);
    for (let i = 0; i < take; i += 1) scores[order[i] * NUM_SPEAKERS + s] += boost;
  }
}

/**
 * Keep the CACHE_LENGTH most informative frames, grouped by speaker and in
 * order within a speaker, plus one silence slot per speaker.
 */
export function compressCache(embeds: Frames, probs: Frames, silence: Float32Array): { embeds: Frames; probs: Frames } {
  const frames = probs.length;
  const scores = frameScores(probs);
  for (let f = CACHE_LENGTH; f < frames; f += 1) {
    for (let s = 0; s < NUM_SPEAKERS; s += 1) scores[f * NUM_SPEAKERS + s] += LATEST_BOOST;
  }
  boostScores(scores, frames, STRONG_BOOSTED, -2 * Math.log(0.5));
  boostScores(scores, frames, WEAK_BOOSTED, -Math.log(0.5));

  // Flattened per speaker: index = speaker * (frames + 1) + frame; the extra
  // frame is the silence slot with an infinite score.
  const scored = frames + SILENCE_FRAMES;
  const sentinel = scored * NUM_SPEAKERS;
  const candidates: { index: number; score: number }[] = [];
  for (let s = 0; s < NUM_SPEAKERS; s += 1) {
    for (let f = 0; f < scored; f += 1) {
      const score = f < frames ? scores[f * NUM_SPEAKERS + s] : Infinity;
      candidates.push({ index: s * scored + f, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.index - b.index);
  const picked = candidates.slice(0, CACHE_LENGTH).map(({ index, score }) => (score === -Infinity ? sentinel : index));
  picked.sort((a, b) => a - b);

  const outEmbeds = new Float32Array(CACHE_LENGTH * HIDDEN);
  const outProbs = new Float32Array(CACHE_LENGTH * NUM_SPEAKERS);
  picked.forEach((index, i) => {
    const frame = index === sentinel ? frames : Math.min(index % scored, frames);
    if (frame >= frames) {
      outEmbeds.set(silence, i * HIDDEN);
    } else {
      outEmbeds.set(embeds.row(frame), i * HIDDEN);
      outProbs.set(probs.row(frame), i * NUM_SPEAKERS);
    }
  });
  return { embeds: new Frames(outEmbeds, HIDDEN), probs: new Frames(outProbs, NUM_SPEAKERS) };
}

/** Arrival-Order Speaker Cache and FIFO queue (offline sizes). */
export class SpeakerCache {
  embeds = Frames.empty(HIDDEN);
  probs = Frames.empty(NUM_SPEAKERS);
  fifo = Frames.empty(HIDDEN);
  compressed = false;

  cached(): Frames {
    return Frames.concat(HIDDEN, this.embeds, this.fifo);
  }

  /** Sigmoid of the 10 ms logits, averaged to the 80 ms encoder rate. */
  static pool(logits: Float32Array, inputFrames: number): Frames {
    const out = new Float32Array(inputFrames * NUM_SPEAKERS);
    const available = logits.length / NUM_SPEAKERS;
    for (let f = 0; f < inputFrames; f += 1) {
      for (let k = 0; k < SUBSAMPLING; k += 1) {
        const t = f * SUBSAMPLING + k;
        if (t >= available) break;
        for (let s = 0; s < NUM_SPEAKERS; s += 1) {
          out[f * NUM_SPEAKERS + s] += 1 / (1 + Math.exp(-logits[t * NUM_SPEAKERS + s])) / SUBSAMPLING;
        }
      }
    }
    return new Frames(out, NUM_SPEAKERS);
  }

  update(inputEmbeds: Frames, logits: Float32Array, silence: Float32Array, chunkFrames: number): void {
    const numCache = this.embeds.length;
    const numFifo = this.fifo.length;
    const probs = SpeakerCache.pool(logits, inputEmbeds.length);
    const chunkStart = numCache + numFifo;
    const chunkEmbeds = inputEmbeds.slice(chunkStart, chunkStart + chunkFrames);
    let fifoEmbeds = Frames.concat(HIDDEN, this.fifo, chunkEmbeds);

    const fifoCount = fifoEmbeds.length;
    const popped = fifoCount <= FIFO_LENGTH ? 0 : Math.min(Math.max(UPDATE_PERIOD, fifoCount - FIFO_LENGTH), fifoCount);
    if (popped) {
      const fifoProbs = Frames.concat(
        NUM_SPEAKERS,
        probs.slice(numCache, numCache + numFifo),
        probs.slice(chunkStart, chunkStart + chunkFrames),
      );
      // An uncompressed cache holds plain chunk frames whose probabilities this
      // step re-estimates; a compressed one keeps the stored probabilities.
      const storedProbs = this.compressed ? this.probs : probs.slice(0, numCache);
      let cacheEmbeds = Frames.concat(HIDDEN, this.embeds, fifoEmbeds.slice(0, popped));
      let cacheProbs = Frames.concat(NUM_SPEAKERS, storedProbs, fifoProbs.slice(0, popped));
      fifoEmbeds = fifoEmbeds.slice(popped, fifoEmbeds.length);
      if (cacheEmbeds.length > CACHE_LENGTH) {
        ({ embeds: cacheEmbeds, probs: cacheProbs } = compressCache(cacheEmbeds, cacheProbs, silence));
        this.compressed = true;
      }
      this.embeds = new Frames(cacheEmbeds.data.slice(), HIDDEN);
      this.probs = new Frames(cacheProbs.data.slice(), NUM_SPEAKERS);
    }
    this.fifo = new Frames(fifoEmbeds.data.slice(), HIDDEN);
  }
}

/* Model --------------------------------------------------------------------- */

type Ort = Awaited<ReturnType<typeof getOrt>>;
type Session = Awaited<ReturnType<Ort['InferenceSession']['create']>>;
let loaded: { session: Session; ort: Ort; variant: DiarizationVariant; backend: 'webgpu' | 'wasm' } | null = null;

async function cachedFetch(url: string, expected: number, signal: AbortSignal | undefined, onBytes: (loaded: number, total: number) => void): Promise<ArrayBuffer> {
  const cache = typeof caches === 'undefined' ? null : await caches.open(DIARIZATION_CACHE).catch(() => null);
  const hit = await cache?.match(url);
  if (hit) {
    const bytes = await hit.arrayBuffer();
    onBytes(bytes.byteLength, bytes.byteLength);
    return bytes;
  }
  const bytes = await fetchWithProgress(url, onBytes, { signal, expectedBytes: expected });
  await cache?.put(url, new Response(bytes)).catch(() => undefined);
  return bytes;
}

export interface DiarizationProgress {
  stage: 'download' | 'prepare' | 'run';
  text: string;
  loaded?: number;
  total?: number;
  fraction?: number;
}

export async function loadDiarizer(options: { webgpu: boolean; shaderF16: boolean; signal?: AbortSignal; onProgress?: (progress: DiarizationProgress) => void }): Promise<void> {
  const variant: DiarizationVariant = options.webgpu && options.shaderF16 ? 'q4f16' : 'q4';
  const backend = options.webgpu ? 'webgpu' : 'wasm';
  if (loaded?.variant === variant && loaded.backend === backend) return;
  const spec = DIARIZATION_VARIANTS[variant];
  let graphBytes = 0;
  const report = (dataLoaded: number, dataTotal: number) => options.onProgress?.({
    stage: 'download', text: 'Downloading the speaker model', loaded: dataLoaded + graphBytes, total: dataTotal + 410_000,
  });
  const graph = await cachedFetch(BASE + spec.graph, 410_000, options.signal, (bytes) => { graphBytes = bytes; });
  const data = await cachedFetch(BASE + spec.data, spec.bytes, options.signal, report);
  options.onProgress?.({ stage: 'prepare', text: 'Starting the speaker model…' });
  const ort = await getOrt(backend);
  const session = await ort.InferenceSession.create(new Uint8Array(graph), {
    executionProviders: backend === 'webgpu' ? ['webgpu', 'wasm'] : ['wasm'],
    externalData: [{ path: spec.data, data: new Uint8Array(data) }],
    graphOptimizationLevel: 'all',
  } as Parameters<Ort['InferenceSession']['create']>[1]);
  loaded = { session, ort, variant, backend };
}

export function diarizerReady(): boolean {
  return loaded !== null;
}

/**
 * Per-speaker activity probabilities, one row of 8 every 10 ms, for 16 kHz
 * mono audio.
 */
export async function speakerProbabilities(samples: Float32Array, options: { signal?: AbortSignal; onProgress?: (progress: DiarizationProgress) => void } = {}): Promise<{ probs: Float32Array; frames: number }> {
  if (!loaded) throw new Error('Load the speaker model first.');
  const { session, ort } = loaded;
  const mel = computeNemoLogMel(samples, { layout: 'time-first', normalize: false });
  const melFrames = mel.validFrames;
  const embedFrames = Math.ceil(melFrames / SUBSAMPLING);
  const cache = new SpeakerCache();
  const out = new Float32Array(melFrames * NUM_SPEAKERS);
  let written = 0;

  for (let start = 0; start < embedFrames; start += CHUNK_LENGTH) {
    options.signal?.throwIfAborted();
    const end = Math.min(start + CHUNK_LENGTH, embedFrames);
    const chunkFrames = end - start;
    const melFrom = start * SUBSAMPLING;
    const melTo = Math.min(Math.min(end + CHUNK_RIGHT_CONTEXT, embedFrames) * SUBSAMPLING, melFrames);
    const features = mel.data.subarray(melFrom * 128, melTo * 128);
    const featureFrames = melTo - melFrom;
    const cached = cache.cached();
    const maskLength = cached.length + Math.ceil(featureFrames / SUBSAMPLING);

    const feeds = {
      input_features: new ort.Tensor('float32', features.slice(), [1, featureFrames, 128]),
      cached_embeds: new ort.Tensor('float32', cached.data.slice(), [1, cached.length, HIDDEN]),
      // Mask over the whole step at the encoder rate: cached frames, then the
      // chunk's stacked frames (8 mel frames each, the last group zero-padded).
      attention_mask: new ort.Tensor('int64', new BigInt64Array(maskLength).fill(1n), [1, maskLength]),
    };
    const result = await session.run(feeds);
    try {
      const logits = result.logits.data as Float32Array;
      const chunkEmbeds = new Frames((result.chunk_embeds.data as Float32Array).slice(), HIDDEN);
      const silence = (result.silence_embeds.data as Float32Array).slice();
      const inputEmbeds = Frames.concat(HIDDEN, cached, chunkEmbeds);
      cache.update(inputEmbeds, logits, silence, chunkFrames);

      const from = cached.length * SUBSAMPLING;
      const count = Math.min(chunkFrames * SUBSAMPLING, melFrames - written);
      for (let t = 0; t < count; t += 1) {
        for (let s = 0; s < NUM_SPEAKERS; s += 1) {
          out[(written + t) * NUM_SPEAKERS + s] = 1 / (1 + Math.exp(-logits[(from + t) * NUM_SPEAKERS + s]));
        }
      }
      written += count;
    } finally {
      for (const tensor of Object.values(feeds)) tensor.dispose?.();
      for (const tensor of Object.values(result)) tensor.dispose?.();
    }
    options.onProgress?.({ stage: 'run', text: 'Finding who spoke when', fraction: end / embedFrames });
  }
  return { probs: out, frames: written };
}

/* Post-processing ------------------------------------------------------------ */

export interface SpeakerTurn {
  speaker: number;
  start: number;
  end: number;
}

/**
 * Turn 10 ms probabilities into speaker turns: hysteresis thresholds, then
 * drop blips and bridge short gaps, then number speakers by first appearance.
 */
export function speakerTurns(
  probs: Float32Array,
  frames: number,
  options: { onset?: number; offset?: number; minSpeech?: number; minGap?: number; frameSeconds?: number } = {},
): SpeakerTurn[] {
  const { onset = 0.5, offset = 0.4, minSpeech = 0.25, minGap = 0.3, frameSeconds = 0.01 } = options;
  const turns: SpeakerTurn[] = [];
  for (let s = 0; s < NUM_SPEAKERS; s += 1) {
    const raw: SpeakerTurn[] = [];
    let open = -1;
    for (let f = 0; f <= frames; f += 1) {
      const p = f < frames ? probs[f * NUM_SPEAKERS + s] : 0;
      if (open < 0 && p >= onset) open = f;
      else if (open >= 0 && p < offset) {
        raw.push({ speaker: s, start: open * frameSeconds, end: f * frameSeconds });
        open = -1;
      }
    }
    const merged: SpeakerTurn[] = [];
    for (const turn of raw) {
      const last = merged[merged.length - 1];
      if (last && turn.start - last.end < minGap) last.end = turn.end;
      else merged.push({ ...turn });
    }
    turns.push(...merged.filter((turn) => turn.end - turn.start >= minSpeech));
  }
  turns.sort((a, b) => a.start - b.start || a.end - b.end);
  // Renumber by first appearance (the model already orders by arrival, but
  // channels can be empty after filtering).
  const order = new Map<number, number>();
  for (const turn of turns) if (!order.has(turn.speaker)) order.set(turn.speaker, order.size);
  return turns.map((turn) => ({ ...turn, speaker: order.get(turn.speaker)! }));
}

/* Aligning a transcript ----------------------------------------------------- */

export interface TimedWord {
  text: string;
  start: number;
  end: number;
}

export interface SpeakerLine {
  speaker: number;
  start: number;
  end: number;
  text: string;
}

/** The speaker talking the most during [start, end), or the nearest one. */
function speakerAt(turns: SpeakerTurn[], start: number, end: number): number {
  let best = -1;
  let bestOverlap = 0;
  for (const turn of turns) {
    const overlap = Math.min(end, turn.end) - Math.max(start, turn.start);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = turn.speaker;
    }
  }
  if (best >= 0) return best;
  let nearest = 0;
  let distance = Infinity;
  const middle = (start + end) / 2;
  for (const turn of turns) {
    const gap = middle < turn.start ? turn.start - middle : middle > turn.end ? middle - turn.end : 0;
    if (gap < distance) {
      distance = gap;
      nearest = turn.speaker;
    }
  }
  return nearest;
}

/**
 * Words with times. Segments without word timings get their words spread over
 * the speech inside the segment, in proportion to word length.
 */
export function wordsFromSegments(
  segments: ReadonlyArray<{ start: number; end: number; text: string; words?: ReadonlyArray<{ text: string; start: number; end: number | null }> }>,
  turns: SpeakerTurn[],
): TimedWord[] {
  const words: TimedWord[] = [];
  for (const segment of segments) {
    if (segment.words?.length) {
      for (const word of segment.words) words.push({ text: word.text.trim(), start: word.start, end: word.end ?? word.start + 0.2 });
      continue;
    }
    const tokens = segment.text.split(/\s+/).filter(Boolean);
    if (!tokens.length) continue;
    // Speech intervals inside the segment (union of turns), or the whole span.
    const spans = turns
      .map((turn) => ({ start: Math.max(turn.start, segment.start), end: Math.min(turn.end, segment.end) }))
      .filter((span) => span.end > span.start)
      .sort((a, b) => a.start - b.start);
    const union: { start: number; end: number }[] = [];
    for (const span of spans) {
      const last = union[union.length - 1];
      if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
      else union.push({ ...span });
    }
    if (!union.length) union.push({ start: segment.start, end: segment.end });
    const speech = union.reduce((sum, span) => sum + span.end - span.start, 0);
    const weights = tokens.map((token) => token.length + 1);
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    let consumed = 0;
    const timeAt = (offset: number) => {
      let left = offset;
      for (const span of union) {
        const length = span.end - span.start;
        if (left <= length) return span.start + left;
        left -= length;
      }
      return union[union.length - 1].end;
    };
    tokens.forEach((token, i) => {
      const from = (consumed / totalWeight) * speech;
      consumed += weights[i];
      const to = (consumed / totalWeight) * speech;
      words.push({ text: token, start: timeAt(from), end: timeAt(to) });
    });
  }
  return words;
}

/** Group words into lines by speaker. */
export function alignSpeakers(words: TimedWord[], turns: SpeakerTurn[]): SpeakerLine[] {
  const lines: SpeakerLine[] = [];
  if (!turns.length) {
    return words.length ? [{ speaker: 0, start: words[0].start, end: words[words.length - 1].end, text: words.map((word) => word.text).join(' ') }] : [];
  }
  for (const word of words) {
    const speaker = speakerAt(turns, word.start, Math.max(word.end, word.start + 0.01));
    const last = lines[lines.length - 1];
    if (last && last.speaker === speaker && word.start - last.end < 2) {
      last.text += ' ' + word.text;
      last.end = Math.max(last.end, word.end);
    } else {
      lines.push({ speaker, start: word.start, end: word.end, text: word.text });
    }
  }
  return lines;
}
