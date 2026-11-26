/**
 * App-wide UI translation.
 *
 * The English strings in `ui-strings.json` are the source copy from the app
 * shell and every view. Each language pack keeps the same order, so the DOM
 * translator can look up exact labels, buttons, placeholders, and tooltips
 * without touching user content such as transcripts or file names.
 */

import { isQuickLanguage, loadQuickTerms, quickTranslate, type QuickLanguage } from './quick-locale';

const STORAGE_KEY = 'localscribe.quickLocale';
const ATTRIBUTES = ['placeholder', 'title', 'aria-label', 'alt'] as const;
const TEXT_SKIP = [
  'script',
  'style',
  'noscript',
  'textarea',
  'input',
  'code',
  'pre',
  'svg',
  '[contenteditable="true"]',
  '[data-no-i18n]',
  '.vt-clip-label',
  '.video-asset-name',
  '.video-project-entry-name',
  '.storage-project-name',
  '#file-name',
  '#studio-name',
  '#history-list',
  '#segment-list',
  '.transcript',
].join(',');

const ATTRIBUTE_SKIP = [
  'script',
  'style',
  'noscript',
  'svg',
  '[data-no-i18n]',
  '.vt-clip-label',
  '.video-asset-name',
  '.video-project-entry-name',
  '.storage-project-name',
  '#file-name',
  '#studio-name',
  '#history-list',
  '#segment-list',
].join(',');

type Pack = readonly string[];

// No pack ships in the main chunk: English is the page's own copy, and a
// non-English pack (with the English list it is aligned to) is fetched when
// the user chooses that language. That keeps the initial JS about 125 KB
// smaller (gzip) and avoids building lookup Maps on startup.
const loaders: Record<QuickLanguage, () => Promise<Pack>> = {
  en: () => import('./ui-strings.json').then((module) => module.default as Pack),
  pt: () => import('./ui-pt.json').then((module) => module.default as Pack),
  es: () => import('./ui-es.json').then((module) => module.default as Pack),
  fr: () => import('./ui-fr.json').then((module) => module.default as Pack),
  de: () => import('./ui-de.json').then((module) => module.default as Pack),
  zh: () => import('./ui-zh.json').then((module) => module.default as Pack),
  ja: () => import('./ui-ja.json').then((module) => module.default as Pack),
  ko: () => import('./ui-ko.json').then((module) => module.default as Pack),
  ru: () => import('./ui-ru.json').then((module) => module.default as Pack),
};

// English is the page's own copy; nothing to load for it.
const packs = new Set<QuickLanguage>(['en']);
const dictionaries = new Map<QuickLanguage, Map<string, string>>();

function buildDictionary(language: QuickLanguage, english: Pack, strings: Pack): void {
  if (language === 'en' || strings.length !== english.length) return;
  const map = new Map<string, string>();
  for (let index = 0; index < english.length; index += 1) {
    if (strings[index]) map.set(english[index], strings[index]);
  }
  dictionaries.set(language, map);
}

async function loadPack(language: QuickLanguage): Promise<void> {
  if (packs.has(language)) return;
  try {
    // The English source list (index-aligned with every pack) and the Quick
    // tools table are only needed for other languages, so they are not in the
    // entry chunk.
    const [english, strings] = await Promise.all([loaders.en(), loaders[language](), loadQuickTerms()]);
    packs.add(language);
    buildDictionary(language, english, strings);
  } catch {
    // Translation is an enhancement; keep the English source copy.
  }
}

const sourceText = new WeakMap<Text, string>();
const sourceAttributes = new WeakMap<Element, Record<string, string>>();
let language: QuickLanguage = 'en';
let observer: MutationObserver | null = null;
let applying = false;
let ready = false;

function preferredLanguage(): QuickLanguage {
  const explicit = new URLSearchParams(location.search).get('ui');
  if (isQuickLanguage(explicit)) return explicit;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isQuickLanguage(saved)) return saved;
  } catch {
    // Storage is optional.
  }
  return 'en';
}

function translated(value: string): string {
  const dictionary = language === 'en' ? null : dictionaries.get(language);
  if (!dictionary) return value;
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) return value;
  const target = dictionary.get(text) ?? quickTranslate(language, text);
  if (!target || target === text) return value;
  const leading = value.match(/^\s*/)?.[0] ?? '';
  const trailing = value.match(/\s*$/)?.[0] ?? '';
  return leading + target + trailing;
}

function skipped(node: Node): boolean {
  const element = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
  return Boolean(element?.closest(TEXT_SKIP));
}

function attributesSkipped(element: Element): boolean {
  return Boolean(element.closest(ATTRIBUTE_SKIP));
}

function translateTextNode(node: Text, force: boolean): void {
  if (skipped(node)) return;
  const current = node.nodeValue ?? '';
  const known = sourceText.get(node);
  if (known === undefined) {
    sourceText.set(node, current);
    const next = translated(current);
    if (next !== current) node.nodeValue = next;
    return;
  }
  if (force) {
    const next = translated(known);
    if (next !== current) node.nodeValue = next;
    return;
  }
  // A dynamic update replaced our translation. Remember the new English text
  // before translating it again.
  if (current !== translated(known)) {
    sourceText.set(node, current);
    const next = translated(current);
    if (next !== current) node.nodeValue = next;
  }
}

function translateElementAttributes(element: Element, force: boolean): void {
  if (attributesSkipped(element)) return;
  let originals = sourceAttributes.get(element);
  for (const attribute of ATTRIBUTES) {
    if (!element.hasAttribute(attribute)) continue;
    const current = element.getAttribute(attribute) ?? '';
    if (!originals) {
      originals = {};
      sourceAttributes.set(element, originals);
    }
    const known = originals[attribute];
    if (known === undefined) {
      originals[attribute] = current;
      element.setAttribute(attribute, translated(current));
      continue;
    }
    if (force) {
      element.setAttribute(attribute, translated(known));
      continue;
    }
    if (current !== translated(known)) {
      originals[attribute] = current;
      element.setAttribute(attribute, translated(current));
    }
  }
}

function translateSubtree(root: Node, force = false): void {
  if (root.nodeType === Node.TEXT_NODE) {
    translateTextNode(root as Text, force);
    return;
  }
  if (!(root instanceof Element) && !(root instanceof DocumentFragment) && root !== document.body) return;
  if (root instanceof Element) translateElementAttributes(root, force);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === Node.TEXT_NODE) translateTextNode(node as Text, force);
    else translateElementAttributes(node as Element, force);
  }
}

/**
 * Only non-English sessions need a MutationObserver, and then only to translate
 * the nodes that actually changed. Re-walking the whole body on every batch is
 * far too expensive for editors that update labels constantly.
 */
function startObserver(): void {
  if (observer || language === 'en') return;
  observer = new MutationObserver((records) => {
    if (applying) return;
    applying = true;
    for (const record of records) {
      if (record.type === 'childList') {
        for (const node of record.addedNodes) translateSubtree(node);
      } else if (record.type === 'characterData') {
        translateTextNode(record.target as Text, false);
      } else if (record.target instanceof Element) {
        translateElementAttributes(record.target, false);
      }
    }
    applying = false;
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: [...ATTRIBUTES],
  });
}

export function currentAppLanguage(): QuickLanguage {
  return language;
}

/** Translate a string outside the DOM, such as a confirm() message. */
export function translateUi(text: string): string {
  return translated(text);
}

export async function setAppLanguage(next: QuickLanguage): Promise<void> {
  // setupI18n already applied the initial language. Switching to the same pack
  // would needlessly force a full-body re-translation.
  if (next === language && packs.has(next)) return;
  language = next;
  document.documentElement.lang = next === 'zh' ? 'zh-Hans' : next;
  await loadPack(next);
  if (language !== next) return;
  applying = true;
  translateSubtree(document.body, true);
  applying = false;
  if (language === 'en') {
    observer?.disconnect();
    observer = null;
  } else {
    startObserver();
  }
}

export async function setupI18n(): Promise<void> {
  if (ready) return;
  ready = true;
  language = preferredLanguage();
  await loadPack(language);
  applying = true;
  document.documentElement.lang = language === 'zh' ? 'zh-Hans' : language;
  // English is the source copy. No translation pass or observer is needed.
  if (language !== 'en') translateSubtree(document.body);
  applying = false;
  startObserver();
}
