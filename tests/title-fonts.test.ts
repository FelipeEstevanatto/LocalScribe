import { describe, expect, test } from 'bun:test';
import {
  canLoadInstalledFonts,
  fontLabelFromValue,
  loadInstalledFontChoices,
  quoteFontFamily,
  TEXT_FONT_OPTIONS,
} from '../src/title-fonts';

describe('title font choices', () => {
  test('offers a large, unique set of real families', () => {
    expect(TEXT_FONT_OPTIONS.length).toBeGreaterThan(60);
    const labels = TEXT_FONT_OPTIONS.map((font) => font.label.toLowerCase());
    const values = TEXT_FONT_OPTIONS.map((font) => font.value);
    expect(new Set(labels).size).toBe(labels.length);
    expect(new Set(values).size).toBe(values.length);
  });

  test('covers every font category', () => {
    const categories = new Set(TEXT_FONT_OPTIONS.map((font) => font.category));
    for (const category of ['Sans', 'Serif', 'Display', 'Handwriting', 'Mono']) {
      expect(categories.has(category as never)).toBe(true);
    }
  });

  test('derives readable labels from CSS stacks', () => {
    expect(fontLabelFromValue('"Segoe Script", "Brush Script MT", cursive')).toBe('Segoe Script');
    expect(fontLabelFromValue("'Marker Felt', cursive")).toBe('Marker Felt');
    expect(fontLabelFromValue('')).toBe('Custom');
  });

  test('quotes installed family names and escapes quotes', () => {
    expect(quoteFontFamily('My Font')).toBe('"My Font", sans-serif');
    expect(quoteFontFamily('Arial', 'serif')).toBe('"Arial", serif');
    expect(quoteFontFamily('A"B')).toBe('"A\\"B", sans-serif');
  });

  test('gracefully skips installed-font access outside the browser', async () => {
    if (typeof window !== 'undefined') return;
    expect(canLoadInstalledFonts()).toBe(false);
    expect(await loadInstalledFontChoices()).toEqual([]);
  });
});
