export const QUICK_LANGUAGES = [
  ['en', 'English'], ['pt', 'Português (Brasil)'], ['es', 'Español'], ['fr', 'Français'],
  ['de', 'Deutsch'], ['zh', '简体中文'], ['ja', '日本語'], ['ko', '한국어'], ['ru', 'Русский'],
] as const;
export type QuickLanguage = typeof QUICK_LANGUAGES[number][0];

export function isQuickLanguage(value: string | null): value is QuickLanguage {
  return QUICK_LANGUAGES.some(([id]) => id === value);
}

let rows: ReadonlyMap<string, readonly string[]> | null = null;
let loadingTerms: Promise<void> | null = null;

/** Load the translation table. i18n loads it with every non-English pack. */
export function loadQuickTerms(): Promise<void> {
  if (rows) return Promise.resolve();
  loadingTerms ??= import('./quick-locale-terms')
    .then((module) => { rows = module.QUICK_TERMS; })
    .catch(() => { loadingTerms = null; });
  return loadingTerms;
}

/** For build scripts, which import the table directly. */
export function useQuickTerms(table: ReadonlyMap<string, readonly string[]>): void {
  rows = table;
}

export function quickTranslate(locale: string, text: string): string {
  const index = QUICK_LANGUAGES.findIndex(([id]) => id === locale);
  if (index < 1 || !text) return text;
  const translation = rows?.get(text)?.[index];
  if (translation) return translation;
  return text;
}

