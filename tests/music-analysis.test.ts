import { expect, test } from 'bun:test';
import { analyzeTrack, tappedTempo } from '../src/music-analysis';
import type { EditorAudio } from '../src/audio-edit';

const audio: EditorAudio = {
  sampleRate: 22050,
  duration: 12,
  channels: 1,
  channelMask: 0,
  dataOffset: 44,
  peak: 0,
  rms: 0,
  silenceRatio: 0,
  activityRegions: 0,
  longestSilence: 0,
  peaks: new Float32Array(),
};

test('key and tempo analysis detects a 120 BPM C major pattern without halving the beat', async () => {
  const samples = Float32Array.from({ length: audio.sampleRate * audio.duration }, (_, frame) => {
    const time = frame / audio.sampleRate;
    const chord = [261.6256, 329.6276, 391.9954].reduce((sum, frequency, index) =>
      sum + (index === 0 ? 1 : 0.6) * Math.sin(2 * Math.PI * frequency * time), 0);
    return chord * (0.3 + 0.6 * Math.exp(-(time % 0.5) * 18)) / 4;
  });
  const estimate = await analyzeTrack(new Blob([new ArrayBuffer(audio.dataOffset), samples]), audio);
  expect(estimate.key).toBe('C');
  expect(estimate.mode).toBe('major');
  expect(Math.round(estimate.bpm!)).toBe(120);
});

test('silence has no detectable key or through-beat', async () => {
  const samples = new Float32Array(audio.sampleRate * audio.duration);
  expect(await analyzeTrack(new Blob([new ArrayBuffer(audio.dataOffset), samples]), audio))
    .toEqual({ key: null, mode: null, bpm: null });
});

test('tap tempo tolerates a missed beat', () => {
  expect(tappedTempo([100])).toBeNull();
  expect(tappedTempo([0, 500, 1000, 2000, 2500])).toBe(120);
});
