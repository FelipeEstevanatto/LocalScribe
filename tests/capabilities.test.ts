import { expect, test } from 'bun:test';
import { prefersCompactModel } from '../src/capabilities';

test('compact defaults are chosen for phones, low RAM, few cores, and CPU-only browsers', () => {
  expect(prefersCompactModel({ cores: 8, memoryGB: 8, mobile: true, webgpu: true })).toBe(true);
  expect(prefersCompactModel({ cores: 8, memoryGB: 4, mobile: false, webgpu: true })).toBe(true);
  expect(prefersCompactModel({ cores: 4, memoryGB: 16, mobile: false, webgpu: true })).toBe(true);
  expect(prefersCompactModel({ cores: 8, memoryGB: 8, mobile: false, webgpu: false })).toBe(true);
});

test('full defaults stay on a capable desktop', () => {
  expect(prefersCompactModel({ cores: 16, memoryGB: 16, mobile: false, webgpu: true })).toBe(false);
  expect(prefersCompactModel({ cores: null, memoryGB: null, mobile: false, webgpu: true })).toBe(false);
});
