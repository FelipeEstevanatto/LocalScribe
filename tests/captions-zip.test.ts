import { expect, test } from 'bun:test';
import {
  cueAt,
  drawCaption,
  normalizeTextStyle,
  parseCaptions,
  shiftCues,
  textStyleFromCaption,
  toSrt,
  toVtt,
  type TextObjectStyle,
} from '../src/captions';
import { crc32, createZip } from '../src/zip';
import { overlayTransitionOpacity } from '../src/video-overlays';
import { readFloatWav, MEDIA_ACCEPT, isSupportedFile } from '../src/audio';

test('SRT and VTT round-trip through cues', () => {
  const srt = '1\r\n00:00:01,500 --> 00:00:03,000\r\nHello <i>there</i>\r\n\r\n2\r\n00:01:00,000 --> 00:01:02,250\r\nSecond\nline\r\n';
  const cues = parseCaptions(srt);
  expect(cues).toEqual([
    { start: 1.5, end: 3, text: 'Hello there' },
    { start: 60, end: 62.25, text: 'Second\nline' },
  ]);
  expect(parseCaptions(toVtt(cues))).toEqual(cues);
  expect(toSrt(cues)).toContain('00:01:00,000 --> 00:01:02,250');
  expect(cueAt(cues, 2)?.text).toBe('Hello there');
  expect(cueAt(cues, 10)).toBeNull();
});

test('text objects normalize style values and survive cue shifts', () => {
  const style = normalizeTextStyle({
    fontSize: 99,
    fontWeight: 650,
    x: -999,
    y: 999,
    maxWidth: 0,
    outlineWidth: -4,
    backgroundOpacity: 2,
    color: '#ABCDEF',
    align: 'right',
    fontFamily: 'Georgia, serif',
  });
  expect(style.fontSize).toBe(30);
  expect(style.fontWeight).toBe(700);
  expect(style.x).toBe(-50);
  expect(style.y).toBe(120);
  expect(style.maxWidth).toBe(5);
  expect(style.outlineWidth).toBe(0);
  expect(style.backgroundOpacity).toBe(1);
  expect(style.color).toBe('#abcdef');
  expect(style.align).toBe('right');
  expect(style.fontFamily).toBe('Georgia, serif');
  const top = textStyleFromCaption({ scale: 1.25, position: 'top' });
  expect(top.fontSize).toBeGreaterThan(5);
  expect(top.y).toBe(10);
  const cues = parseCaptions('1\n00:00:01,000 --> 00:00:02,000\nHello\n');
  cues[0].style = style;
  const shifted = shiftCues(cues, 2);
  expect(shifted[0].start).toBe(3);
  expect(shifted[0].style).toEqual(style);
});

test('overlay transitions fade in, out, dip, and clear deterministically', () => {
  expect(overlayTransitionOpacity(10, 20, 'fade-in', 10)).toBe(0);
  expect(overlayTransitionOpacity(10, 20, 'fade-in', 10.3)).toBeCloseTo(0.5);
  expect(overlayTransitionOpacity(10, 20, 'fade-in', 11)).toBe(1);
  expect(overlayTransitionOpacity(10, 20, 'fade-out', 19.4)).toBeCloseTo(1);
  expect(overlayTransitionOpacity(10, 20, 'fade-out', 19.7)).toBeCloseTo(0.5);
  expect(overlayTransitionOpacity(10, 20, 'fade-out', 20)).toBe(0);
  expect(overlayTransitionOpacity(10, 20, 'dip', 10)).toBe(0);
  expect(overlayTransitionOpacity(10, 20, 'dip', 15)).toBe(1);
  expect(overlayTransitionOpacity(10, 20, 'dip', 20)).toBe(0);
  expect(overlayTransitionOpacity(10, 20, 'none', 10)).toBe(1);
  expect(overlayTransitionOpacity(10, 20, undefined, 20)).toBe(1);
});

test('burned text uses the per-object font, color, outline, and position', () => {
  const draws: { text: string; x: number; y: number; color: string; font: string }[] = [];
  const strokes: { text: string; color: string }[] = [];
  const ctx = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    lineJoin: '',
    font: '',
    textAlign: '',
    textBaseline: '',
    globalAlpha: 1,
    shadowColor: '',
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    save() {},
    restore() {},
    translate() {},
    rotate() {},
    beginPath() {},
    fill() {},
    roundRect() {},
    measureText(text: string) { return { width: text.length * 20 }; },
    fillText(text: string, x: number, y: number) {
      draws.push({ text, x, y, color: this.fillStyle, font: this.font });
    },
    strokeText(text: string) {
      strokes.push({ text, color: this.strokeStyle });
    },
  };
  const style: TextObjectStyle = {
    ...normalizeTextStyle({ fontFamily: 'Georgia, serif', fontSize: 8, fontWeight: 700, color: '#ff0000', x: 20, y: 30, align: 'left' }),
    outlineWidth: 3,
    outlineColor: '#00ff00',
    backgroundOpacity: 0,
  };
  drawCaption(ctx as never, 'Hello', 1920, 1080, style);
  expect(draws[0].text).toBe('Hello');
  expect(draws[0].color).toBe('#ff0000');
  expect(draws[0].font).toContain('Georgia, serif');
  expect(draws[0].font).toContain('700');
  expect(draws[0].x).toBeCloseTo(15);
  expect(draws[0].y).toBeCloseTo(0);
  expect(strokes[0].color).toBe('#00ff00');
});

test('ZIP archives store files with correct checksums', async () => {
  expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  const zip = await createZip([
    { name: 'a.txt', blob: new Blob(['hello']) },
    { name: 'a.txt', blob: new Blob(['world']) },
  ]);
  const bytes = new Uint8Array(await zip.arrayBuffer());
  const view = new DataView(bytes.buffer);
  expect(view.getUint32(0, true)).toBe(0x04034b50);
  expect(view.getUint32(bytes.length - 22, true)).toBe(0x06054b50);
  expect(view.getUint16(bytes.length - 22 + 10, true)).toBe(2);
  expect(new TextDecoder().decode(bytes)).toContain('a (2).txt');
});

test('float WAV reader and format lists', () => {
  const header = new DataView(new ArrayBuffer(44 + 8));
  header.setUint32(0, 0x52494646);
  header.setUint32(8, 0x57415645);
  header.setUint32(12, 0x666d7420);
  header.setUint32(16, 16, true);
  header.setUint32(36, 0x64617461);
  header.setUint32(40, 8, true);
  header.setFloat32(44, 0.5, true);
  header.setFloat32(48, -0.25, true);
  expect(Array.from(readFloatWav(header.buffer))).toEqual([0.5, -0.25]);
  expect(MEDIA_ACCEPT).toContain('.wma');
  expect(isSupportedFile(new File([], 'call.amr'))).toBe(true);
  expect(isSupportedFile(new File([], 'notes.txt'))).toBe(false);
});
