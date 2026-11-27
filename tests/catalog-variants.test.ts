import { expect, test } from 'bun:test';
import { defaultSelection, findModel, getModel, resolveModelFiles } from '../src/catalog';
import { modelNeedsWebGpu } from '../src/capabilities';

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

test('old Phonon selections resolve to the multilingual TDT replacement', () => {
  const model = getModel('phonon-2.5');
  expect(findModel('phonon-2')).toBe(model);
  expect(model.timestamps).toBe('word');
  expect(model.languagesDetail).toContain('Portuguese');
  expect(modelNeedsWebGpu(model, { supported: false })).toBe(false);
  expect(defaultSelection().modelId).toBe('fluid-mini');
});

test('the Qwen preview requires shader-f16 and fits under the model picker limit', () => {
  const model = getModel('qwen3-asr-1.7b');
  const files = resolveModelFiles(model.id, model.defaultVariant, false);
  expect(model.chunkSeconds).toBe(15);
  expect(modelNeedsWebGpu(model, { supported: true, shaderF16: false })).toBe(true);
  expect(modelNeedsWebGpu(model, { supported: true, shaderF16: true })).toBe(false);
  expect(model.variants[0].approxBytes).toBe(files.reduce((sum, file) => sum + file.size, 0));
  expect(model.variants[0].approxBytes).toBeLessThan(2_000_000_000);
  expect(files.filter((file) => file.name.endsWith('.onnx_data')).map((file) => file.role))
    .toEqual(['encoderData', 'embedTokensData', 'decoderData']);
});
