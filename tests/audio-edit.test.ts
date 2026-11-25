import { expect, test } from 'bun:test';
import { audioEditArgs, inspectEditorAudio, joinGraph, type AudioEdit } from '../src/audio-edit';

function stereoWave(): Blob {
  const bytes = new ArrayBuffer(44 + 2 * 8);
  const header = new DataView(bytes);
  header.setUint32(0, 0x52494646);
  header.setUint32(4, bytes.byteLength - 8, true);
  header.setUint32(8, 0x57415645);
  header.setUint32(12, 0x666d7420);
  header.setUint32(16, 16, true);
  header.setUint16(20, 3, true);
  header.setUint16(22, 2, true);
  header.setUint32(24, 44100, true);
  header.setUint32(28, 44100 * 8, true);
  header.setUint16(32, 8, true);
  header.setUint16(34, 32, true);
  header.setUint32(36, 0x64617461);
  header.setUint32(40, 16, true);
  header.setFloat32(44, -1, true);
  header.setFloat32(48, 1, true);
  return new Blob([bytes]);
}

test('waveform meters preserve peaks in opposing stereo channels', async () => {
  const audio = await inspectEditorAudio(stereoWave(), new AbortController().signal);
  expect(audio.channels).toBe(2);
  expect(audio.sampleRate).toBe(44100);
  expect(audio.peak).toBe(1);
  expect(audio.rms).toBeCloseTo(Math.SQRT1_2);
  expect(Array.from(audio.peaks)).toEqual([1, 0]);
});

test('middle removal joins both retained ranges and preserves layout after loudness normalization', async () => {
  const audio = { ...await inspectEditorAudio(stereoWave(), new AbortController().signal), duration: 5 };
  const edit: AudioEdit = {
    cut: 'remove', start: 1, end: 2, gain: 0, loudness: -19, ceiling: -3, effect: 'fade-out',
  };
  const args = audioEditArgs(edit, audio);
  const graph = args[args.indexOf('-filter_complex') + 1];
  expect(graph).toContain('concat=n=2:v=0:a=1');
  expect(graph).toContain('aresample=44100:ochl=2c');
  expect(graph).toContain('afade=t=out:st=3.000000000');
  expect(graph).toContain('alimiter=limit=');
  expect(() => audioEditArgs({ ...edit, start: 0, end: 5 }, audio)).toThrow('entire recording');
});

test('joinGraph downmixes with a normalised matrix so 5.1 input cannot clip', () => {
  const { graph } = joinGraph([
    { blob: new Blob(), duration: 2 },
    { blob: new Blob(), duration: 2 },
  ]);
  expect(graph.match(/rematrix_maxval=1/g)?.length).toBe(2);
});
