import { describe, expect, test } from 'bun:test';
import { defaultSettings } from '../src/converter-catalog';
import { canConvertInBrowser, crfQuality } from '../src/converter-video';

describe('converter browser video path', () => {
  const auto = defaultSettings().video;

  test('takes Auto conversions between MP4, MOV, MKV and WebM', () => {
    expect(canConvertInBrowser('clip.mp4', 'mov', auto)).toBe(true);
    expect(canConvertInBrowser('clip.webm', 'mp4', auto)).toBe(true);
    expect(canConvertInBrowser('clip.MKV', 'webm', auto)).toBe(true);
  });

  test('leaves legacy inputs, other targets and explicit choices to FFmpeg', () => {
    expect(canConvertInBrowser('clip.avi', 'mp4', auto)).toBe(false);
    expect(canConvertInBrowser('clip.mp4', 'avi', auto)).toBe(false);
    expect(canConvertInBrowser('clip.mp4', 'gifv', auto)).toBe(false);
    expect(canConvertInBrowser('clip.mp4', 'mp4', { ...auto, codec: 'copy' })).toBe(false);
    expect(canConvertInBrowser('clip.mp4', 'mp4', { ...auto, codec: 'libx264' })).toBe(false);
    expect(canConvertInBrowser('clip.mp4', 'mp4', { ...auto, audioStream: 'mp3' })).toBe(false);
    expect(canConvertInBrowser('clip.mp4', 'mp4', { ...auto, resolution: 'custom', customWidth: 640, customHeight: 360 })).toBe(false);
  });

  test('maps CRF to the exporter quality scale', () => {
    expect(crfQuality(23)).toBe(59);
    expect(crfQuality(18)).toBeGreaterThan(crfQuality(28));
    expect(crfQuality(60)).toBe(1);
    expect(crfQuality(0)).toBe(100);
  });
});
