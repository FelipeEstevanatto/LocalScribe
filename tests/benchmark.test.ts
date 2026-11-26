import { expect, test } from 'bun:test';
import { SAMPLE_TRANSCRIPT, wordErrorRate } from '../src/benchmark';
import { getModel, resolveModelFiles, STUDIO_WHISPER_MODEL_ID, STUDIO_WHISPER_VARIANT_ID } from '../src/catalog';

test('WER ignores formatting and counts insertions, deletions, substitutions and empty output', () => {
  expect(wordErrorRate(SAMPLE_TRANSCRIPT, SAMPLE_TRANSCRIPT.toUpperCase().replace(/[.,]/g, ''))).toBe(0);
  expect(wordErrorRate('one two three four', 'one two dog four five')).toBe(0.5);
  expect(wordErrorRate('one two three four', 'two four')).toBe(0.5);
  expect(wordErrorRate('one two', '')).toBe(1);
  expect(wordErrorRate('one', 'two three')).toBe(2);
});

test('WebGPU.Studio benchmark uses the FP32 encoder and Q8 decoder while the app defaults to FP32', () => {
  const model = getModel(STUDIO_WHISPER_MODEL_ID);
  expect(model.repo).toBe('onnx-community/whisper-tiny.en');
  expect(model.defaultVariant).toBe('fp32');
  const files = resolveModelFiles(model.id, STUDIO_WHISPER_VARIANT_ID, false);
  expect(files.find((file) => file.role === 'encoderGraph')?.name).toBe('onnx/encoder_model.onnx');
  expect(files.find((file) => file.role === 'decoderGraph')?.name).toBe('onnx/decoder_model_merged_quantized.onnx');
});
