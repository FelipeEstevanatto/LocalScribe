import { expect, test } from 'bun:test';
import { getModel, resolveModelFiles, type ModelId } from '../src/catalog';

test('Transformer speech models default to FP32 and keep a separate Q8 package', () => {
  const ids: ModelId[] = [
    'moonshine-tiny', 'moonshine-base', 'whisper-tiny-timestamped',
    'whisper-base-timestamped', 'whisper-small-timestamped',
  ];
  for (const id of ids) {
    expect(getModel(id).defaultVariant).toBe('fp32');
    const quality = resolveModelFiles(id, 'fp32', false);
    const compact = resolveModelFiles(id, 'q8', false);
    expect(quality.find((file) => file.role === 'encoderGraph')?.name).toBe('onnx/encoder_model.onnx');
    expect(quality.find((file) => file.role === 'decoderGraph')?.name).toBe('onnx/decoder_model_merged.onnx');
    expect(compact.find((file) => file.role === 'encoderGraph')?.name).toBe('onnx/encoder_model_quantized.onnx');
    expect(compact.find((file) => file.role === 'decoderGraph')?.name).toBe('onnx/decoder_model_merged_quantized.onnx');
  }
});

test('Redux shares its ternary encoder across precisions and mounts the FP32 decoder data', () => {
  const id = 'parakeet-redux';
  expect(getModel(id).defaultVariant).toBe('fp32-decoder');
  const quality = resolveModelFiles(id, 'fp32-decoder', false);
  const compact = resolveModelFiles(id, 'w2a8', false);
  expect(quality.find((file) => file.role === 'encoderGraph')?.url)
    .toBe(compact.find((file) => file.role === 'encoderGraph')?.url);
  expect(quality.find((file) => file.role === 'decoderData')?.name).toBe('fp32/decoder_joint-model.onnx.data');
  expect(compact.some((file) => file.role === 'decoderData')).toBe(false);
});
