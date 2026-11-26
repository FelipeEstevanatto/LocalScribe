import { expect, test } from 'bun:test';
import { getModel, resolveModelFiles } from '../src/catalog';

test('Parakeet Ultra variants resolve to the right repository and pinned revision', () => {
  const [encoder] = resolveModelFiles('parakeet-ultra', 'w4a8', false);
  expect(encoder.url).toBe('https://huggingface.co/Olicorne/parakeet-tdt-0.6b-v3-ultra-onnx/resolve/db1fd7a2d89672e8e52383505f0149076faab6f7/w4a8/encoder-model.w4a8.onnx');

  const webgpu = resolveModelFiles('parakeet-ultra', 'webgpu-int4', false);
  expect(webgpu.every((file) => file.url.startsWith('https://huggingface.co/ryusei-46/parakeet-ultra-ONNX-WebGPU/resolve/9c2bb9be4df050e495f0765470fff9335d8a3bd0/'))).toBe(true);
  expect(webgpu.map((file) => file.role)).toEqual(['encoderGraph', 'encoderData', 'decoderGraph', 'vocab', 'config']);
});

test('each Ultra variant size matches its files', () => {
  const model = getModel('parakeet-ultra');
  for (const variant of model.variants) {
    const total = variant.files(false).reduce((sum, file) => sum + file.size, 0);
    expect(total).toBe(variant.approxBytes);
  }
});
