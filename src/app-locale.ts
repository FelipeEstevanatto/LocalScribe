/**
 * The global language menu. It lives in the app shell so it stays visible on
 * the Speech & audio pages and Quick tools, and always points at the language
 * used by the localized tool pages.
 */

import { setAppLanguage } from './i18n';
import { QUICK_LANGUAGES, isQuickLanguage, quickTranslate, type QuickLanguage } from './quick-locale';

export const QUICK_LOCALE_EVENT = 'localscribe:quick-locale';
const STORAGE_KEY = 'localscribe.quickLocale';

export function preferredQuickLanguage(): QuickLanguage {
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

function localizedUrl(language: QuickLanguage): URL {
  const url = new URL(location.href);
  url.searchParams.set('ui', language);
  const route = new URLSearchParams(url.hash.split('?')[1]);
  if (!route.has('tool')) route.set('tool', 'video-converter');
  url.hash = '/tools?' + route.toString();
  return url;
}

function languageName(language: QuickLanguage): string {
  return QUICK_LANGUAGES.find(([code]) => code === language)?.[1] ?? 'English';
}

export function setAppLocaleDisabled(disabled: boolean): void {
  const toggle = document.getElementById('quick-locale-toggle') as HTMLButtonElement | null;
  if (toggle) toggle.disabled = disabled;
}

export function setupAppLocale(): void {
  const root = document.getElementById('quick-locale');
  const toggle = document.getElementById('quick-locale-toggle') as HTMLButtonElement | null;
  const label = document.getElementById('quick-locale-name');
  const options = document.getElementById('quick-locale-options');
  if (!root || !toggle || !label || !options) return;

  let language = preferredQuickLanguage();
  const onTools = () => location.hash.startsWith('#/tools');

  const refresh = (): void => {
    const name = languageName(language);
    label.textContent = name;
    toggle.title = quickTranslate(language, 'Change language');
    toggle.setAttribute('aria-label', `${quickTranslate(language, 'Change language')} · ${name}`);
    options.setAttribute('aria-label', quickTranslate(language, 'Language'));
    document.documentElement.lang = language === 'zh' ? 'zh-Hans' : language;
    for (const item of options.querySelectorAll<HTMLAnchorElement>('a')) {
      if (item.dataset.language === language) item.setAttribute('aria-current', 'true');
      else item.removeAttribute('aria-current');
    }
  };

  const close = (focusToggle = false): void => {
    options.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
    if (focusToggle) toggle.focus();
  };

  const open = (next: boolean): void => {
    if (next) {
      for (const item of options.querySelectorAll<HTMLAnchorElement>('a')) {
        const code = item.dataset.language;
        if (code && isQuickLanguage(code)) item.href = localizedUrl(code).href;
      }
    }
    options.hidden = !next;
    toggle.setAttribute('aria-expanded', String(next));
  };

  const choose = (next: QuickLanguage): void => {
    if (next !== language) {
      if (onTools()) {
        // Pin the implicit locale in this history entry, so Back restores the
        // language the user just left.
        const explicit = new URLSearchParams(location.search).get('ui');
        if (!isQuickLanguage(explicit)) {
          const current = localizedUrl(language);
          history.replaceState(history.state, '', current);
        }
      }
      language = next;
      try { localStorage.setItem(STORAGE_KEY, language); } catch { /* Storage is optional. */ }
      if (onTools()) {
        const target = localizedUrl(language);
        history.pushState(history.state, '', target);
      } else {
        // Keep the current view and remember the choice in its URL.
        const target = new URL(location.href);
        target.searchParams.set('ui', language);
        history.replaceState(history.state, '', target);
      }
      void setAppLanguage(language).then(() => {
        refresh();
        window.dispatchEvent(new CustomEvent<QuickLanguage>(QUICK_LOCALE_EVENT, { detail: language }));
      });
    }
    close(true);
  };

  for (const [code, name] of QUICK_LANGUAGES) {
    const item = document.createElement('a');
    item.textContent = name;
    item.dataset.language = code;
    item.lang = item.hreflang = code === 'zh' ? 'zh-Hans' : code;
    item.href = localizedUrl(code).href;
    item.addEventListener('click', (event) => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      event.preventDefault();
      choose(code);
    });
    options.append(item);
  }

  toggle.addEventListener('click', () => open(options.hidden));
  document.addEventListener('pointerdown', (event) => {
    if (!options.hidden && event.target instanceof Node && !root.contains(event.target)) close();
  });
  root.addEventListener('focusout', (event) => {
    if (event.relatedTarget instanceof Node && !root.contains(event.relatedTarget)) close();
  });
  root.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || options.hidden) return;
    event.preventDefault();
    close(true);
  });
  window.addEventListener('popstate', () => {
    const next = preferredQuickLanguage();
    if (next === language) return;
    language = next;
    void setAppLanguage(language).then(() => {
      refresh();
      window.dispatchEvent(new CustomEvent<QuickLanguage>(QUICK_LOCALE_EVENT, { detail: language }));
    });
  });

  toggle.disabled = false;
  void setAppLanguage(language);
  refresh();
}
