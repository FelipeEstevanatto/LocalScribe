/**
 * Small PCM/WAV helpers used by the Mediabunny engine.
 *
 * The Audio studio's internal representation is a 32-bit float WAV. Keeping
 * that contract means the playback, waveform, effects, and version history
 * code does not need to change when the decoder/encoder switches engines.
 */

import type { PcmAudio } from './media-types';

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
}

export function concatFloat32(chunks: readonly Float32Array[]): Float32Array {
  if (chunks.length === 1) return chunks[0];
  let length = 0;
  for (const chunk of chunks) length += chunk.length;
  const output = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

export function writeFloatWav(channels: readonly Float32Array[], sampleRate: number): Blob {
  const count = channels.length;
  const frames = channels.reduce((max, channel) => Math.max(max, channel.length), 0);
  const bytes = 44 + frames * count * 4;
  const buffer = new ArrayBuffer(bytes);
  const view = new DataView(buffer);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, bytes - 8, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 3, true); // WAVE_FORMAT_IEEE_FLOAT
  view.setUint16(22, count, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * count * 4, true);
  view.setUint16(32, count * 4, true);
  view.setUint16(34, 32, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, frames * count * 4, true);
  const data = new Float32Array(buffer, 44);
  let offset = 0;
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < count; channel += 1) {
      data[offset + channel] = channels[channel][frame] ?? 0;
    }
    offset += count;
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

export async function readFloatWav(blob: Blob): Promise<PcmAudio> {
  const header = new DataView(await blob.slice(0, 12).arrayBuffer());
  if (header.byteLength !== 12 || header.getUint32(0) !== 0x52494646 || header.getUint32(8) !== 0x57415645) {
    throw new Error('Not a RIFF/WAVE file.');
  }
  let channels = 0;
  let sampleRate = 0;
  let channelMask = 0;
  let dataOffset = 0;
  let dataSize = 0;
  for (let offset = 12; offset + 8 <= blob.size; ) {
    const chunk = new DataView(await blob.slice(offset, offset + 8).arrayBuffer());
    const type = chunk.getUint32(0);
    const length = chunk.getUint32(4, true);
    const data = offset + 8;
    if (data + length > blob.size) break;
    if (type === 0x666d7420 && length >= 16) {
      const format = new DataView(await blob.slice(data, data + Math.min(length, 24)).arrayBuffer());
      const codec = format.getUint16(0, true);
      if ((codec !== 3 && codec !== 0xfffe) || format.getUint16(14, true) !== 32) {
        throw new Error('Only 32-bit float WAV is supported.');
      }
      channels = format.getUint16(2, true);
      sampleRate = format.getUint32(4, true);
      if (codec === 0xfffe && length >= 24) channelMask = format.getUint32(20, true);
    } else if (type === 0x64617461) {
      dataOffset = data;
      dataSize = length;
      break;
    }
    offset = data + length + (length % 2);
  }
  if (!channels || !sampleRate || !dataSize) throw new Error('The WAV file contains no audio data.');
  const frames = Math.floor(dataSize / (channels * 4));
  const planar = Array.from({ length: channels }, () => new Float32Array(frames));
  for (let frame = 0; frame < frames; frame += 16384) {
    const count = Math.min(16384, frames - frame);
    const view = new DataView(
      await blob.slice(dataOffset + frame * channels * 4, dataOffset + (frame + count) * channels * 4).arrayBuffer(),
    );
    for (let local = 0; local < count; local += 1) {
      for (let channel = 0; channel < channels; channel += 1) {
        planar[channel][frame + local] = view.getFloat32((local * channels + channel) * 4, true);
      }
    }
  }
  return { channels: planar, sampleRate, channelMask, frames };
}

export function pcmDuration(pcm: PcmAudio): number {
  return pcm.frames / pcm.sampleRate;
}
