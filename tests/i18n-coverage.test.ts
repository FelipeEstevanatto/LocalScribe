import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const LANGS = ['pt', 'es', 'fr', 'de', 'zh', 'ja', 'ko', 'ru'];
const read = (name: string): string[] => JSON.parse(readFileSync(`src/${name}`, 'utf8'));
const english = read('ui-strings.json');

/**
 * Visible strings in index.html that have no entry in ui-strings.json.
 * The number may only go down: new UI text must be added to the source list
 * and to every language pack.
 */
const MAX_UNTRANSLATED = 465;

function visibleStrings(): string[] {
  const html = readFileSync('index.html', 'utf8')
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<svg[\s\S]*?<\/svg>/g, '');
  const found = new Set<string>();
  for (const match of html.matchAll(/>([^<>]+)</g)) {
    const text = match[1].replace(/\s+/g, ' ').trim();
    if (/[A-Za-z]{2}/.test(text) && !text.startsWith('{')) found.add(text.replace(/&amp;/g, '&'));
  }
  for (const match of html.matchAll(/\s(?:placeholder|title|aria-label|alt)="([^"]+)"/g)) {
    const text = match[1].replace(/\s+/g, ' ').trim();
    if (/[A-Za-z]{2}/.test(text)) found.add(text.replace(/&amp;/g, '&'));
  }
  return [...found];
}

describe('UI translations', () => {
  test('every language pack stays index-aligned with the English source', () => {
    for (const lang of LANGS) expect(read(`ui-${lang}.json`).length).toBe(english.length);
  });

  test('no pack has empty entries', () => {
    for (const lang of LANGS) expect(read(`ui-${lang}.json`).filter((entry) => !entry.trim()).length).toBe(0);
  });

  test('the untranslated visible text does not grow', () => {
    const known = new Set(english);
    const missing = visibleStrings().filter((text) => !known.has(text));
    expect(missing.length).toBeLessThanOrEqual(MAX_UNTRANSLATED);
  });

  test('copy uses no em dash', () => {
    for (const name of ['ui-strings.json', ...LANGS.map((lang) => `ui-${lang}.json`)]) {
      expect(read(name).filter((entry) => entry.includes('\u2014'))).toEqual([]);
    }
  });
});
