/**
 * Log-mel frontend microbenchmark.
 *
 * Qwen3-ASR and Rumble-2-Flash run every chunk through computeWhisperLogMel.
 * This measures the pure JS frontend in isolation, so frontend changes can be
 * compared without downloading a model or waiting for inference.
 *
 * Run with: bun run bench:mel
 */
import { computeWhisperLogMel } from '../src/whisper-mel';

const SECONDS = 30;
const SAMPLE_RATE = 16_000;
const RUNS = 5;

const samples = new Float32Array(SECONDS * SAMPLE_RATE);
let seed = 0x12345678;
const noise = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 0xffffffff;
};
for (let index = 0; index < samples.length; index += 1) {
  const t = index / SAMPLE_RATE;
  samples[index] =
    0.22 * Math.sin(2 * Math.PI * 180 * t) +
    0.14 * Math.sin(2 * Math.PI * 420 * t) +
    0.05 * (noise() * 2 - 1);
}

// Warm the JIT and the filter tables.
computeWhisperLogMel(samples.subarray(0, SAMPLE_RATE * 2));

const times: number[] = [];
let frames = 0;
for (let run = 0; run < RUNS; run += 1) {
  const start = performance.now();
  const mel = computeWhisperLogMel(samples);
  times.push(performance.now() - start);
  frames = mel.frames;
}

times.sort((a, b) => a - b);
const median = times[Math.floor(times.length / 2)];
console.log(JSON.stringify({
  benchmark: 'whisper-log-mel',
  seconds: SECONDS,
  frames,
  runs: RUNS,
  medianMs: Number(median.toFixed(2)),
  minMs: Number(times[0].toFixed(2)),
  maxMs: Number(times[times.length - 1].toFixed(2)),
  realtimeFactor: Number((SECONDS * 1000 / median).toFixed(1)),
}, null, 2));
