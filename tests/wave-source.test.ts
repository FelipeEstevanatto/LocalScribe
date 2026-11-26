import { describe, expect, test } from 'bun:test';
import { analyzeAudio, TARGET_SAMPLE_RATE } from '../src/audio';
import { openWaveSource, summarizeWave } from '../src/wave-source';

// Include an odd-sized metadata chunk so this exercises RIFF padding too.
function makeWave(samples: Int16Array, rate = TARGET_SAMPLE_RATE): Blob {
  const offset = 54;
  const buffer = new ArrayBuffer(offset + samples.byteLength);
  const view = new DataView(buffer);
  view.setUint32(0, 0x52494646);
  view.setUint32(4, buffer.byteLength - 8, true);
  view.setUint32(8, 0x57415645);
  view.setUint32(12, 0x4a554e4b);
  view.setUint32(16, 1, true);
  view.setUint32(22, 0x666d7420);
  view.setUint32(26, 16, true);
  view.setUint16(30, 1, true);
  view.setUint16(32, 1, true);
  view.setUint32(34, rate, true);
  view.setUint32(38, rate * 2, true);
  view.setUint16(42, 2, true);
  view.setUint16(44, 16, true);
  view.setUint32(46, 0x64617461);
  view.setUint32(50, samples.byteLength, true);
  samples.forEach((sample, index) => view.setInt16(offset + index * 2, sample, true));
  return new Blob([buffer]);
}

describe('bounded PCM WAV input', () => {
  test('reads sample-aligned slices and matches whole-file signal analysis', async () => {
    const samples = new Int16Array(130 * TARGET_SAMPLE_RATE + 7);
    // Speech begins before a block boundary and ends in the next block.
    samples.fill(-16_384, 63_040, 66_880);
    samples[samples.length - 1] = 8192;
    const source = (await openWaveSource(makeWave(samples)))!;
    expect(source.samples).toBeNull();
    expect(source.duration).toBe(samples.length / TARGET_SAMPLE_RATE);
    expect([...await source.read(63_038, 63_042)]).toEqual([0, 0, -0.5, -0.5]);
    const result = await summarizeWave(source, new AbortController().signal);
    expect(result.analysis).toEqual(analyzeAudio(Float32Array.from(samples, (sample) => sample / 32768)));
    expect(result.peaks[899]).toBe(0.25);
  });

  test('leaves unsupported or truncated files for the native decoder', async () => {
    const samples = Int16Array.of(-32768, 32767);
    expect(await openWaveSource(makeWave(samples, 48_000))).toBeNull();
    expect(await openWaveSource(makeWave(samples).slice(0, -1))).toBeNull();
  });

  test('stops at the next read boundary when cancelled', async () => {
    const source = (await openWaveSource(makeWave(new Int16Array(9 * TARGET_SAMPLE_RATE))))!;
    const controller = new AbortController();
    const read = source.read;
    let reads = 0;
    source.read = async (start, end) => {
      reads += 1;
      controller.abort();
      return read(start, end);
    };
    await expect(summarizeWave(source, controller.signal)).rejects.toHaveProperty('name', 'AbortError');
    expect(reads).toBe(1);
  });
});
