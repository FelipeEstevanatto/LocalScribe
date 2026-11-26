import { expect, test } from 'bun:test';
import { drawCaption, normalizeTextStyle, titleTextParts } from '../src/captions';
import { findTitlePreset, TITLE_PRESETS, titlePresetStyle } from '../src/video-title-presets';

test('each preset supplies an independent, distinct style for an editable title', () => {
  const styles = TITLE_PRESETS.map(titlePresetStyle);
  expect(styles.length).toBeGreaterThan(4);
  expect(new Set(styles.map((style) => JSON.stringify(style))).size).toBe(styles.length);
  const preset = findTitlePreset('lower')!;
  const changed = titlePresetStyle(preset);
  changed.accent = 'frame';
  expect(titlePresetStyle(preset).accent).toBe('side');
  expect(titleTextParts(preset.text, titlePresetStyle(preset))).toEqual([
    { text: 'Alex Morgan', detail: false },
    { text: 'Documentary filmmaker', detail: true },
  ]);
});

test('burned lower thirds draw the accent and their supporting text in a separate size and color', () => {
  const preset = findTitlePreset('lower')!;
  const title = titlePresetStyle(preset);
  const rows: { text: string; font: string; color: string; y: number }[] = [];
  const accents: { color: string; width: number }[] = [];
  const ctx = {
    font: '',
    fillStyle: '',
    save() {}, restore() {}, translate() {}, rotate() {}, beginPath() {}, roundRect() {}, fill() {},
    measureText(text: string) { return { width: text.length * 13 }; },
    fillRect(_x: number, _y: number, width: number) { accents.push({ color: this.fillStyle, width }); },
    fillText(text: string, _x: number, y: number) { rows.push({ text, font: this.font, color: this.fillStyle, y }); },
  };
  drawCaption(ctx as never, preset.text, 1280, 720, normalizeTextStyle(title));
  expect(accents).toEqual([{ color: '#61aaff', width: 3 }]);
  expect(rows.map(({ text, color }) => [text, color])).toEqual([
    ['Alex Morgan', '#ffffff'],
    ['Documentary filmmaker', '#b7d6ff'],
  ]);
  expect(rows[0].font).toContain('73px');
  expect(rows[1].font).toContain('40.15px');
  expect(rows[0].y).toBeLessThan(rows[1].y);
});
