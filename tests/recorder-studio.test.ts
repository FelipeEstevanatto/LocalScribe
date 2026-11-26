import { expect, test } from 'bun:test';
import {
  autoVideoBitrate,
  availableRecorderFormats,
  clockDuration,
  formatBitrate,
  pickRecorderMime,
  recorderFps,
  recorderResolution,
  recordingExtension,
  recordingName,
} from '../src/recorder-studio';

test('recorder names and extensions follow the selected container', () => {
  const date = new Date(2026, 10, 22, 13, 5, 7);
  expect(recordingName(date, 'video/webm;codecs=vp9,opus')).toBe('recording-20261122-130507.webm');
  expect(recordingName(date, 'video/mp4')).toBe('recording-20261122-130507.mp4');
  expect(recordingExtension('video/webm')).toBe('webm');
  expect(recordingExtension('video/mp4')).toBe('mp4');
});

test('recorder timer formats minutes and hours', () => {
  expect(clockDuration(0)).toBe('00:00');
  expect(clockDuration(65.9)).toBe('01:05');
  expect(clockDuration(3725)).toBe('1:02:05');
});

test('recorder only offers formats the browser can actually record', () => {
  expect(availableRecorderFormats(() => false)).toEqual([]);

  const webmOnly = availableRecorderFormats((mime) => mime.startsWith('video/webm'));
  expect(webmOnly.map((format) => format.id)).toEqual(['webm']);
  expect(webmOnly[0]?.mime).toBe('video/webm;codecs=vp9,opus');
  expect(webmOnly[0]?.extension).toBe('webm');

  const both = availableRecorderFormats(() => true);
  expect(both.map((format) => format.id)).toEqual(['mp4-h264', 'mp4-hevc', 'webm']);
  expect(both[0]?.mime).toContain('avc1');
  expect(both[1]?.label).toBe('MP4 · H.265');
  expect(both[1]?.mime).toContain('hvc1');
  expect(both[2]?.label).toBe('WebM · VP9');

  const hevcOnly = availableRecorderFormats((mime) => mime.includes('hvc1'));
  expect(hevcOnly.map((format) => format.id)).toEqual(['mp4-hevc']);
  expect(hevcOnly[0]?.extension).toBe('mp4');
  expect(hevcOnly[0]?.mime).toContain('hvc1');
});

test('recorder frame-rate presets are constrained to supported values', () => {
  expect(recorderFps('60')).toBe(60);
  expect(recorderFps('50')).toBe(50);
  expect(recorderFps('30')).toBe(30);
  expect(recorderFps('25')).toBe(25);
  expect(recorderFps('24')).toBe(24);
  expect(recorderFps('15')).toBe(15);
  expect(recorderFps('29.97')).toBe(30);
  expect(recorderFps('')).toBe(30);
});

test('recorder resolution presets map to capture sizes', () => {
  expect(recorderResolution('2160')).toEqual({ width: 3840, height: 2160 });
  expect(recorderResolution('1440')).toEqual({ width: 2560, height: 1440 });
  expect(recorderResolution('1080')).toEqual({ width: 1920, height: 1080 });
  expect(recorderResolution('720')).toEqual({ width: 1280, height: 720 });
  expect(recorderResolution('480')).toEqual({ width: 854, height: 480 });
  expect(recorderResolution('0')).toBeNull();
});

test('auto bitrate follows the selected resolution and frame rate', () => {
  expect(autoVideoBitrate('2160')).toBe(18_000_000);
  expect(autoVideoBitrate('1080')).toBe(6_000_000);
  expect(autoVideoBitrate('480')).toBe(2_500_000);
  expect(autoVideoBitrate('0')).toBe(8_000_000);
  expect(autoVideoBitrate('1080', 60)).toBe(9_600_000);
  expect(autoVideoBitrate('1080', 24)).toBe(5_100_000);
  expect(autoVideoBitrate('1080', 15)).toBe(3_600_000);
  expect(formatBitrate(6_000_000)).toBe('6 Mbps');
  expect(formatBitrate(2_500_000)).toBe('2.5 Mbps');
});

test('recorder MIME selection is a no-op outside a browser', () => {
  expect(pickRecorderMime()).toBe('');
});
