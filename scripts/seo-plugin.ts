import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Plugin } from 'vite';
import { QUICK_TOOLS, isImageTool, type QuickTool } from '../src/quick-catalog';
import { QUICK_LANGUAGES, quickTranslate } from '../src/quick-locale';
import { quickCopy } from '../seo/quick-copy';
import {
  ALL_PAGES,
  DEFAULT_STEPS,
  LANGUAGE_PAGES,
  MODELS,
  USE_CASES,
  pageById,
  type SeoPage,
} from '../seo/pages';

const SITE_URL = (process.env.SITE_URL || 'https://localscribe.app').replace(/\/+$/, '');
const SITE_NAME = 'LocalScribe';
const VIDEO_EDITOR_SLUG = 'video-editor';
const OG_IMAGE = `${SITE_URL}/og.jpg`;
const OG_ALT = 'LocalScribe — private speech, video, and vision tools running in your browser';
const OG_LOCALES: Record<string, string> = {
  en: 'en_US',
  pt: 'pt_BR',
  es: 'es_ES',
  fr: 'fr_FR',
  de: 'de_DE',
  zh: 'zh_CN',
  ja: 'ja_JP',
  ko: 'ko_KR',
  ru: 'ru_RU',
};

function iconLinks(rel: string): string {
  return `<link rel="icon" href="${rel}icon.svg" type="image/svg+xml">
  <link rel="icon" href="${rel}icon-192.png" sizes="192x192" type="image/png">
  <link rel="apple-touch-icon" href="${rel}apple-touch-icon.png">`;
}

function socialMeta(options: {
  title: string;
  description: string;
  url: string;
  type?: 'website' | 'article';
  locale?: string;
  alternates?: string[];
}): string {
  const locale = options.locale ?? 'en_US';
  return `
  <meta property="og:type" content="${options.type ?? 'website'}">
  <meta property="og:site_name" content="${SITE_NAME}">
  <meta property="og:title" content="${escapeHtml(options.title)}">
  <meta property="og:description" content="${escapeHtml(options.description)}">
  <meta property="og:url" content="${options.url}">
  <meta property="og:image" content="${OG_IMAGE}">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:alt" content="${OG_ALT}">
  <meta property="og:locale" content="${locale}">
  ${(options.alternates ?? []).map((alternate) => `<meta property="og:locale:alternate" content="${alternate}">`).join('\n  ')}
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(options.title)}">
  <meta name="twitter:description" content="${escapeHtml(options.description)}">
  <meta name="twitter:image" content="${OG_IMAGE}">`;
}

function structuredData(data: unknown): string {
  return `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

function relativePrefix(slug: string): string {
  return '../'.repeat(slug.split('/').length);
}

function appHref(page: SeoPage): string {
  const rel = relativePrefix(page.slug);
  if (page.appQuery) return `${rel}?${page.appQuery}`;
  if (page.preset) return `${rel}?preset=${encodeURIComponent(page.preset)}`;
  return rel;
}

function langFromPage(page: SeoPage): string | null {
  if (!page.appQuery) return null;
  return new URLSearchParams(page.appQuery).get('lang');
}

function modelHref(page: SeoPage, modelId: string): string {
  const rel = relativePrefix(page.slug);
  const language = langFromPage(page);
  const supportsLanguage =
    modelId === 'qwen3-asr-0.6b' || modelId === 'rumble-2-flash';
  return `${rel}?model=${encodeURIComponent(modelId)}${
    language && supportsLanguage ? `&lang=${encodeURIComponent(language)}` : ''
  }`;
}

function relatedHref(page: SeoPage, slug: string): string {
  const rel = relativePrefix(page.slug);
  return `${rel}${slug}/`;
}

function siteHeader(rel: string, ctaHref: string): string {
  return `
  <header class="site-header">
    <a class="brand" href="${rel}">
      <span class="brand-logo">◫</span>
      <span><strong>LocalScribe</strong><small>Local Media studio</small></span>
    </a>
    <nav class="site-nav">
      <a href="${rel}">Home</a>
      <a href="${rel}#/transcribe">Audio to text</a>
      <a href="${rel}#/tts">Text to speech</a>
      <a href="${rel}#/vision">Vision</a>
      <a href="${rel}#/models">Models</a>
      <a class="nav-cta" href="${ctaHref}">Open the app</a>
    </nav>
  </header>`;
}

function footerLinks(slug: string): string {
  const rel = relativePrefix(slug);
  const useCases = USE_CASES.filter((entry) => entry.slug !== 'audio-to-text')
    .slice(0, 6)
    .map((entry) => `<a href="${rel}${entry.slug}/">${escapeHtml(entry.nav)}</a>`)
    .join('');
  const languages = LANGUAGE_PAGES.slice(0, 6)
    .map((entry) => `<a href="${rel}${entry.slug}/">${escapeHtml(entry.nav)}</a>`)
    .join('');

  return `
    <div>
      <p class="footer-label">Use cases</p>
      <div class="footer-links"><a href="${rel}audio-to-text/">Audio to text</a>${useCases}<a href="${rel}use-cases/">All use cases →</a></div>
    </div>
    <div>
      <p class="footer-label">Languages</p>
      <div class="footer-links">${languages}<a href="${rel}languages/">All languages →</a></div>
    </div>
    <div>
      <p class="footer-label">App</p>
      <div class="footer-links">
        <a href="${rel}#/transcribe">Transcriber</a>
        <a href="${rel}#/tts">Text to speech</a>
        <a href="${rel}#/vision">Vision studio</a>
      <a href="${rel}#/vision">Vision</a>
        <a href="${rel}#/models">Models &amp; storage</a>
        <a href="${rel}#/settings">Privacy receipt</a>
      </div>
    </div>
  `;
}

function pageShell(page: SeoPage): string {
  const rel = relativePrefix(page.slug);
  const steps = page.steps ?? DEFAULT_STEPS;
  const faqJson = page.faq.map((item) => ({
    '@type': 'Question',
    name: item.q,
    acceptedAnswer: { '@type': 'Answer', text: item.a },
  }));

  const jsonLd = [
    {
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      name: SITE_NAME,
      applicationCategory: 'MultimediaApplication',
      operatingSystem: 'Any',
      description:
        'Private, in-browser transcription, text to speech, voice cloning, and vision tools with local models.',
      url: `${SITE_URL}/`,
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      featureList: [
        'Local speech-to-text',
        'No upload',
        'Offline after first download',
        'SRT/VTT export',
        'Local text to speech',
      ],
    },
    {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: faqJson,
    },
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: `${SITE_URL}/` },
        { '@type': 'ListItem', position: 2, name: page.eyebrow, item: `${SITE_URL}/${page.slug}/` },
      ],
    },
  ];

  const models = page.modelIds
    .map((id) => MODELS[id])
    .filter(Boolean)
    .map(
      (model) => `
        <tr>
          <th scope="row"><strong>${escapeHtml(model.name)}</strong><br><span class="muted">${escapeHtml(model.bestFor)}</span></th>
          <td class="mono">${escapeHtml(model.size)}</td>
          <td>${escapeHtml(model.languages)}</td>
          <td class="muted">${escapeHtml(model.note)}</td>
          <td><a class="table-link" href="${modelHref(page, model.id)}">Use →</a></td>
        </tr>`,
    )
    .join('');

  const related = page.related
    .map((slug) => pageById(slug))
    .filter((entry): entry is SeoPage => Boolean(entry))
    .map(
      (entry) => `
        <a class="related-card" href="${relatedHref(page, entry.slug)}">
          <span class="related-nav">${escapeHtml(entry.eyebrow)}</span>
          <span class="related-title">${escapeHtml(entry.nav)}</span>
        </a>`,
    )
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#fefbf6">
  <title>${escapeHtml(page.metaTitle)}</title>
  <meta name="description" content="${escapeHtml(page.metaDescription)}">
  <meta name="robots" content="index,follow,max-image-preview:large">
  <link rel="canonical" href="${SITE_URL}/${page.slug}/">
  ${socialMeta({
    title: page.metaTitle,
    description: page.metaDescription,
    url: `${SITE_URL}/${page.slug}/`,
    type: 'article',
  })}
  ${iconLinks(rel)}
  <link rel="stylesheet" href="${rel}seo.css">
  ${structuredData(jsonLd)}
</head>
<body>
  ${siteHeader(rel, appHref(page))}

  <main class="page">
    <nav class="crumbs" aria-label="Breadcrumb">
      <a href="${rel}">Home</a><span>/</span><span>${escapeHtml(page.eyebrow)}</span>
    </nav>

    <section class="hero">
      <p class="kicker">${escapeHtml(page.eyebrow)}</p>
      <h1>${escapeHtml(page.title)}</h1>
      ${page.intro.map((paragraph) => `<p class="lead">${escapeHtml(paragraph)}</p>`).join('')}
      <div class="actions">
        <a class="button primary" href="${appHref(page)}">Open the transcriber</a>
        <a class="button" href="${rel}#/models">Browse all models</a>
      </div>
      <div class="proof">
        <span><strong>0 bytes</strong> uploaded</span>
        <span><strong>10</strong> speech models</span>
        <span><strong>Offline</strong> after first download</span>
        <span><strong>No</strong> account</span>
      </div>
    </section>

    <section class="section">
      <div class="section-head"><h2>How it works</h2><span>Three steps, no backend</span></div>
      <div class="steps">
        ${steps
          .map(
            (step, index) => `
          <article class="step">
            <span class="step-num">0${index + 1}</span>
            <h3>${escapeHtml(step.title)}</h3>
            <p>${escapeHtml(step.body)}</p>
          </article>`,
          )
          .join('')}
      </div>
    </section>

    <section class="section">
      <div class="section-head"><h2>What you get</h2><span>Local by construction</span></div>
      <div class="grid">
        ${page.bullets
          .map(
            (bullet) => `
          <article class="card">
            <h3>${escapeHtml(bullet.title)}</h3>
            <p>${escapeHtml(bullet.body)}</p>
          </article>`,
          )
          .join('')}
      </div>
    </section>

    <section class="section">
      <div class="section-head"><h2>Models for this job</h2><span>Sizes are first-download estimates</span></div>
      <div class="table-wrap">
        <table>
          <thead><tr><th scope="col">Model</th><th scope="col">Download</th><th scope="col">Languages</th><th scope="col">Why</th><th scope="col">Open</th></tr></thead>
          <tbody>${models}</tbody>
        </table>
      </div>
    </section>

    <section class="section split">
      <div>
        <p class="kicker">Why local</p>
        <h2>Check the network instead of trusting a policy</h2>
        <p class="lead">The app is static. Model weights are the only third-party download, and they are cached. The built-in privacy receipt lists every request destination made during a transcription, including failed requests and range probes.</p>
        <a class="button" href="${rel}#/settings">Open the receipt</a>
      </div>
      <aside class="note">
        <p><strong>Audio stays here.</strong> The file is decoded with the Web Audio API and passed to a local ONNX model. There is no server that receives audio or text.</p>
        <p><strong>Offline after the first run.</strong> The service worker caches the app shell and the runtime; model weights live in Cache Storage.</p>
      </aside>
    </section>

    <section class="section">
      <div class="section-head"><h2>Questions</h2><span>${escapeHtml(page.nav)}</span></div>
      <div class="faq">
        ${page.faq
          .map(
            (item) => `
          <details>
            <summary>${escapeHtml(item.q)}</summary>
            <p>${escapeHtml(item.a)}</p>
          </details>`,
          )
          .join('')}
      </div>
    </section>

    <section class="section">
      <div class="section-head"><h2>Related</h2><span>More local speech tools</span></div>
      <div class="related">${related}</div>
    </section>
  </main>

  <footer class="site-footer">
    <div class="footer-grid">${footerLinks(page.slug)}</div>
    <p class="footer-bottom">Static site · no analytics · no cookies · no backend. Model weights are downloaded from Hugging Face and cached locally.</p>
  </footer>
</body>
</html>`;
}

interface HubDefinition {
  slug: string;
  kicker: string;
  title: string;
  metaTitle: string;
  metaDescription: string;
  intro: string;
  links: SeoPage[];
}

const HUBS: HubDefinition[] = [
  {
    slug: 'use-cases',
    kicker: 'Guides',
    title: 'Local speech use cases',
    metaTitle: 'Speech-to-text use cases in the browser | LocalScribe',
    metaDescription:
      'Dictation, meetings, subtitles, podcasts, interviews, lectures, voice notes, calls, and private transcription — local browser workflows and model picks.',
    intro:
      'Each guide maps a recording job to the model, export, and limits that matter. Everything runs in the tab: there is no backend, no account, and no upload for the audio.',
    links: USE_CASES,
  },
  {
    slug: 'languages',
    kicker: 'Coverage',
    title: 'Transcribe these languages in your browser',
    metaTitle: 'Browser transcription language coverage | LocalScribe',
    metaDescription:
      'Coverage across the model shelf: 25 European languages, 45 with Rumble, 30 plus Chinese dialects with Qwen3-ASR, and 1,600+ with Omnilingual.',
    intro:
      'Coverage depends on the model, not the app. Parakeet Redux and Fluid Speech Pro cover 25 European languages, Rumble-2-Flash covers 45 with automatic detection, Qwen3-ASR covers 30 plus 22 Chinese dialects, and Omnilingual ASR covers more than 1,600. Accuracy varies by accent, recording quality, and domain.',
    links: LANGUAGE_PAGES,
  },
];

function hubShell(hub: HubDefinition): string {
  const rel = relativePrefix(hub.slug);
  const jsonLd = [
    {
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      name: hub.title,
      description: hub.metaDescription,
      url: `${SITE_URL}/${hub.slug}/`,
      mainEntity: {
        '@type': 'ItemList',
        itemListElement: hub.links.map((entry, index) => ({
          '@type': 'ListItem',
          position: index + 1,
          name: entry.title,
          url: `${SITE_URL}/${entry.slug}/`,
        })),
      },
    },
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: `${SITE_URL}/` },
        {
          '@type': 'ListItem',
          position: 2,
          name: hub.title,
          item: `${SITE_URL}/${hub.slug}/`,
        },
      ],
    },
  ];

  const cards = hub.links
    .map((entry) => {
      const firstSentence = entry.intro[0]?.split(/(?<=\.)\s/)[0] ?? entry.metaDescription;
      return `
        <a class="card card-link" href="${rel}${entry.slug}/">
          <span class="related-nav">${escapeHtml(entry.eyebrow)}</span>
          <h3>${escapeHtml(entry.nav)}</h3>
          <p>${escapeHtml(firstSentence)}</p>
        </a>`;
    })
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#fefbf6">
  <title>${escapeHtml(hub.metaTitle)}</title>
  <meta name="description" content="${escapeHtml(hub.metaDescription)}">
  <meta name="robots" content="index,follow,max-image-preview:large">
  <link rel="canonical" href="${SITE_URL}/${hub.slug}/">
  ${socialMeta({
    title: hub.metaTitle,
    description: hub.metaDescription,
    url: `${SITE_URL}/${hub.slug}/`,
  })}
  ${iconLinks(rel)}
  <link rel="stylesheet" href="${rel}seo.css">
  ${structuredData(jsonLd)}
</head>
<body>
  ${siteHeader(rel, `${rel}#/transcribe`)}

  <main class="page">
    <nav class="crumbs" aria-label="Breadcrumb">
      <a href="${rel}">Home</a><span>/</span><span>${escapeHtml(hub.kicker)}</span>
    </nav>

    <section class="hero">
      <p class="kicker">${escapeHtml(hub.kicker)}</p>
      <h1>${escapeHtml(hub.title)}</h1>
      <p class="lead">${escapeHtml(hub.intro)}</p>
      <div class="actions">
        <a class="button primary" href="${rel}#/transcribe">Open the transcriber</a>
        <a class="button" href="${rel}#/models">Browse all models</a>
      </div>
      <div class="proof">
        <span><strong>0 bytes</strong> uploaded</span>
        <span><strong>10</strong> speech models</span>
        <span><strong>Offline</strong> after first download</span>
        <span><strong>No</strong> account</span>
      </div>
    </section>

    <section class="section">
      <div class="section-head"><h2>${escapeHtml(hub.kicker)}</h2><span>${hub.links.length} guides</span></div>
      <div class="grid">${cards}</div>
    </section>
  </main>

  <footer class="site-footer">
    <div class="footer-grid">${footerLinks(hub.slug)}</div>
    <p class="footer-bottom">Static site · no analytics · no cookies · no backend. Model weights are downloaded from Hugging Face and cached locally.</p>
  </footer>
</body>
</html>`;
}

async function writeFileIfChanged(filePath: string, content: string): Promise<void> {
  try {
    const existing = await readFile(filePath, 'utf8');
    if (existing === content) return;
  } catch {
    // New file.
  }
  await writeFile(filePath, content, 'utf8');
}

function appSeoMeta(): string {
  const title = 'LocalScribe — local speech, voice, and vision tools';
  const description = 'Transcribe, dictate, clone a voice, and process images locally. No uploads, no accounts, no backend.';
  const jsonLd = [
    {
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      name: SITE_NAME,
      applicationCategory: 'MultimediaApplication',
      operatingSystem: 'Any',
      description:
        'Private, in-browser transcription, dictation, text to speech, voice cloning, and vision tools. No uploads, no accounts, no backend.',
      url: `${SITE_URL}/`,
      image: OG_IMAGE,
      screenshot: OG_IMAGE,
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      featureList: [
        'Local speech-to-text',
        'No uploads',
        'Offline after first download',
        'SRT/VTT export',
        'Local text to speech',
        'Local video and image tools',
      ],
    },
    {
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: SITE_NAME,
      url: `${SITE_URL}/`,
      inLanguage: 'en',
    },
    {
      '@context': 'https://schema.org',
      '@type': 'Organization',
      name: SITE_NAME,
      url: `${SITE_URL}/`,
      logo: `${SITE_URL}/icon-512.png`,
    },
  ];

  return `
  <link rel="canonical" href="${SITE_URL}/">
  <meta name="robots" content="index,follow,max-image-preview:large">
  ${socialMeta({ title, description, url: `${SITE_URL}/` })}
  ${structuredData(jsonLd)}
`;
}

function toolsHubPage(locale: string): string {
  const t = (value: string) => escapeHtml(quickTranslate(locale, value));
  const copy = quickCopy(locale);
  const slug = `tools/${locale}`;
  const base = relativePrefix(slug);
  const url = `${SITE_URL}/${slug}/`;
  const languageTag = locale === 'zh' ? 'zh-Hans' : locale;
  const title = `${quickTranslate(locale, 'Quick tools')} | LocalScribe`;
  const description = `${quickTranslate(locale, 'Quick tools')}: ${quickTranslate(locale, 'Video tools')} / ${quickTranslate(locale, 'Image tools')}.`;
  const alternates = QUICK_LANGUAGES.map(([code]) =>
    `<link rel="alternate" hreflang="${code === 'zh' ? 'zh-Hans' : code}" href="${SITE_URL}/tools/${code}/">`).join('\n');
  const languages = QUICK_LANGUAGES.map(([code, name]) =>
    `<a href="../${code}/" lang="${code === 'zh' ? 'zh-Hans' : code}" hreflang="${code === 'zh' ? 'zh-Hans' : code}"${code === locale ? ' aria-current="page"' : ''}>${escapeHtml(name)}</a>`).join('');
  const tools = QUICK_TOOLS.map(([id, name, toolDescription]) => `
    <a class="card card-link" href="./${id}/">
      <span class="related-nav">${isImageTool(id) ? t('Image tools') : t('Video tools')}</span>
      <h3>${t(name)}</h3>
      <p>${t(toolDescription)}</p>
    </a>`).join('');
  const jsonLd = [
    {
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      name: quickTranslate(locale, 'Quick tools'),
      description,
      url,
      inLanguage: languageTag,
      mainEntity: {
        '@type': 'ItemList',
        itemListElement: QUICK_TOOLS.map(([id, name], index) => ({
          '@type': 'ListItem',
          position: index + 1,
          name: quickTranslate(locale, name),
          url: `${SITE_URL}/tools/${locale}/${id}/`,
        })),
      },
    },
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: copy.home, item: `${SITE_URL}/` },
        { '@type': 'ListItem', position: 2, name: quickTranslate(locale, 'Quick tools'), item: url },
      ],
    },
  ];

  return `<!doctype html>
<html lang="${languageTag}">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#fefbf6">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<meta name="robots" content="index,follow,max-image-preview:large">
<link rel="canonical" href="${url}">
<link rel="alternate" hreflang="x-default" href="${SITE_URL}/tools/en/">
${alternates}
${socialMeta({
  title,
  description,
  url,
  locale: OG_LOCALES[locale],
  alternates: QUICK_LANGUAGES.filter(([code]) => code !== locale).map(([code]) => OG_LOCALES[code]),
})}
${iconLinks(base)}
<link rel="stylesheet" href="${base}seo.css">
${structuredData(jsonLd)}
</head>
<body>
<header class="site-header">
  <a class="brand" href="${base}">LocalScribe</a>
  <details class="tool-language">
    <summary aria-label="${t('Change language')}">${escapeHtml(QUICK_LANGUAGES.find(([code]) => code === locale)?.[1] ?? 'English')}</summary>
    <nav aria-label="${t('Language')}">${languages}</nav>
  </details>
</header>
<main class="page">
  <nav class="crumbs" aria-label="Breadcrumb"><a href="${base}">${escapeHtml(copy.home)}</a><span>/</span><span>${t('Quick tools')}</span></nav>
  <section class="hero">
    <p class="kicker">${t('Quick tools')}</p>
    <h1>${t('Quick tools')}</h1>
    <p class="lead">${t('Drop a file or browse')}. ${escapeHtml(copy.formatsBody)}</p>
    <div class="actions"><a class="button primary" href="${base}?ui=${locale}#/tools">${t('Open tool')}</a></div>
  </section>
  <section class="section">
    <div class="section-head"><h2>${t('Video tools')} / ${t('Image tools')}</h2><span>${QUICK_TOOLS.length} ${t('Tool')}</span></div>
    <div class="grid">${tools}</div>
  </section>
  <section class="section">
    <div class="section-head"><h2>${escapeHtml(copy.guidesTitle)}</h2></div>
    <div class="related">
      <a class="related-card" href="${base}use-cases/"><span class="related-title">${escapeHtml(copy.useCases)}</span></a>
      <a class="related-card" href="${base}languages/"><span class="related-title">${escapeHtml(copy.languages)}</span></a>
      <a class="related-card" href="${base}audio-to-text/"><span class="related-title">Audio to text</span></a>
    </div>
  </section>
</main>
<footer class="site-footer"><p class="footer-bottom">Static site · no analytics · no cookies · no backend. Files stay on this device.</p></footer>
</body></html>`;
}

const QUICK_TITLE_OVERRIDES: Record<string, string> = {
  'es:video-converter': 'Conversor de vídeo en el navegador',
  'pt:video-converter': 'Conversor de vídeo local',
};

function quickToolPage(locale: string, id: QuickTool, title: string, description: string): string {
  const t = (value: string) => escapeHtml(quickTranslate(locale, value));
  const copy = quickCopy(locale);
  const base = '../../../';
  const slug = `tools/${locale}/${id}/`;
  const url = `${SITE_URL}/${slug}`;
  const href = `${base}?ui=${locale}#/tools?tool=${id}`;
  const languageTag = locale === 'zh' ? 'zh-Hans' : locale;
  const titleText = QUICK_TITLE_OVERRIDES[`${locale}:${id}`] ?? quickTranslate(locale, title);
  const descriptionText = quickTranslate(locale, description);
  const alternates = QUICK_LANGUAGES.map(([code]) =>
    `<link rel="alternate" hreflang="${code === 'zh' ? 'zh-Hans' : code}" href="${SITE_URL}/tools/${code}/${id}/">`).join('\n');
  const localeAlternates = QUICK_LANGUAGES
    .filter(([code]) => code !== locale)
    .map(([code]) => OG_LOCALES[code]);
  const related = QUICK_TOOLS.filter(([key]) => key !== id && isImageTool(key) === isImageTool(id))
    .slice(0, 6)
    .map(([key, name]) => `<a class="related-card" href="../${key}/"><span class="related-title">${t(name)}</span></a>`)
    .join('');
  const languages = QUICK_LANGUAGES.map(([code, name]) =>
    `<a href="../../${code}/${id}/" lang="${code === 'zh' ? 'zh-Hans' : code}" hreflang="${code === 'zh' ? 'zh-Hans' : code}"${code === locale ? ' aria-current="page"' : ''}>${escapeHtml(name)}</a>`).join('');
  const languageName = QUICK_LANGUAGES.find(([code]) => code === locale)?.[1] ?? 'English';
  const steps = copy.steps.map((step, index) => `
    <article class="step">
      <span class="step-num">0${index + 1}</span>
      <p>${escapeHtml(step)}</p>
    </article>`).join('');
  const faq = copy.faqs.map((item) => `
    <details>
      <summary>${escapeHtml(item.q)}</summary>
      <p>${escapeHtml(item.a)}</p>
    </details>`).join('');
  const faqJson = copy.faqs.map((item) => ({
    '@type': 'Question',
    name: item.q,
    acceptedAnswer: { '@type': 'Answer', text: item.a },
  }));
  const jsonLd = [
    {
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      name: `${SITE_NAME} ${titleText}`,
      applicationCategory: 'MultimediaApplication',
      operatingSystem: 'Any',
      description: descriptionText,
      url,
      image: OG_IMAGE,
      inLanguage: languageTag,
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    },
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: copy.home, item: `${SITE_URL}/` },
        { '@type': 'ListItem', position: 2, name: titleText, item: url },
      ],
    },
    {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: faqJson,
    },
  ];

  return `<!doctype html>
<html lang="${languageTag}">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#fefbf6">
<title>${escapeHtml(titleText)} | LocalScribe</title>
<meta name="description" content="${escapeHtml(descriptionText)}">
<meta name="robots" content="index,follow,max-image-preview:large">
<link rel="canonical" href="${url}">
<link rel="alternate" hreflang="x-default" href="${SITE_URL}/tools/en/${id}/">
${alternates}
${socialMeta({ title: `${titleText} | LocalScribe`, description: descriptionText, url, locale: OG_LOCALES[locale], alternates: localeAlternates })}
${iconLinks(base)}
<link rel="stylesheet" href="${base}seo.css">
${structuredData(jsonLd)}
</head>
<body>
<header class="site-header">
  <a class="brand" href="${base}">LocalScribe</a>
  <details class="tool-language">
    <summary aria-label="${t('Change language')} · ${escapeHtml(languageName)}">${escapeHtml(languageName)}</summary>
    <nav aria-label="${t('Language')}">${languages}</nav>
  </details>
</header>
<main class="page">
  <nav class="crumbs" aria-label="Breadcrumb">
    <a href="${base}">${escapeHtml(copy.home)}</a><span>/</span><span>${escapeHtml(titleText)}</span>
  </nav>
  <section class="hero">
    <p class="kicker">${t('Quick tools')}</p>
    <h1>${escapeHtml(titleText)}</h1>
    <p class="lead">${escapeHtml(descriptionText)}</p>
    <div class="actions"><a class="button primary" href="${href}">${t('Open tool')}</a></div>
    <div class="proof">
      ${copy.proof.map((item) => `<span>${escapeHtml(item)}</span>`).join('')}
    </div>
  </section>
  <section class="section">
    <div class="section-head"><h2>${escapeHtml(copy.howTitle)}</h2><span>${t('Quick tools')}</span></div>
    <div class="steps">${steps}</div>
  </section>
  <section class="section split">
    <div>
      <p class="kicker">${escapeHtml(copy.privacyTitle)}</p>
      <p class="lead">${escapeHtml(copy.privacyBody)}</p>
    </div>
    <aside class="note">
      <p><strong>${escapeHtml(copy.formatsTitle)}</strong></p>
      <p>${escapeHtml(copy.formatsBody)}</p>
    </aside>
  </section>
  <section class="section">
    <img src="${base}quick-preview.jpg" width="640" height="336" alt="${escapeHtml(copy.imageAlt)}" loading="lazy" decoding="async" style="display:block;max-width:100%;height:auto;border:1px solid var(--line);border-radius:14px">
  </section>
  <section class="section">
    <div class="section-head"><h2>${escapeHtml(copy.faqTitle)}</h2><span>${t('Quick tools')}</span></div>
    <div class="faq">${faq}</div>
  </section>
  <section class="section">
    <div class="section-head"><h2>${escapeHtml(copy.relatedTitle)}</h2><span>${t('Quick tools')}</span></div>
    <div class="related">${related}</div>
  </section>
  <section class="section">
    <div class="section-head"><h2>${escapeHtml(copy.guidesTitle)}</h2></div>
    <div class="related">
      <a class="related-card" href="${base}use-cases/"><span class="related-title">${escapeHtml(copy.useCases)}</span></a>
      <a class="related-card" href="${base}languages/"><span class="related-title">${escapeHtml(copy.languages)}</span></a>
      <a class="related-card" href="${base}tools/${locale}/"><span class="related-title">${escapeHtml(copy.allTools)}</span></a>
    </div>
  </section>
</main>
<footer class="site-footer"><p class="footer-bottom">Static site · no analytics · no cookies · no backend. Files stay on this device.</p></footer>
</body></html>`;
}

export function seoPages(): Plugin {
  let outDir = 'dist';

  return {
    name: 'localscribe-seo',
    apply: 'build',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    async closeBundle() {
      const generated = [];

      for (const page of ALL_PAGES) {
        const directory = path.join(outDir, page.slug);
        await mkdir(directory, { recursive: true });
        await writeFileIfChanged(path.join(directory, 'index.html'), pageShell(page));
        generated.push(`/${page.slug}/`);
      }

      for (const hub of HUBS) {
        const directory = path.join(outDir, hub.slug);
        await mkdir(directory, { recursive: true });
        await writeFileIfChanged(path.join(directory, 'index.html'), hubShell(hub));
        generated.push(`/${hub.slug}/`);
      }

      const toolPaths: { locale: string; id: string }[] = [];
      const toolHubPaths: string[] = [];
      for (const [locale] of QUICK_LANGUAGES) {
        const hubSlug = `tools/${locale}`;
        const hubDirectory = path.join(outDir, hubSlug);
        await mkdir(hubDirectory, { recursive: true });
        await writeFileIfChanged(path.join(hubDirectory, 'index.html'), toolsHubPage(locale));
        toolHubPaths.push(`/${hubSlug}/`);
        for (const [id, title, description] of QUICK_TOOLS) {
          const slug = `tools/${locale}/${id}`;
          const directory = path.join(outDir, slug);
          await mkdir(directory, { recursive: true });
          await writeFileIfChanged(path.join(directory, 'index.html'), quickToolPage(locale, id, title, description));
          toolPaths.push({ locale, id });
        }
      }

      const today = new Date().toISOString().slice(0, 10);
      const urls = [
        `  <url><loc>${SITE_URL}/</loc><lastmod>${today}</lastmod><changefreq>weekly</changefreq><priority>1.0</priority></url>`,
        ...HUBS.map(
          (hub) =>
            `  <url><loc>${SITE_URL}/${hub.slug}/</loc><lastmod>${today}</lastmod><changefreq>monthly</changefreq><priority>0.9</priority></url>`,
        ),
        ...ALL_PAGES.map(
          (page) =>
            `  <url><loc>${SITE_URL}/${page.slug}/</loc><lastmod>${today}</lastmod><changefreq>monthly</changefreq><priority>${
              page.slug.startsWith('languages/') ? '0.7' : '0.8'
            }</priority></url>`,
        ),
        ...toolHubPaths.map((slug) =>
          `  <url><loc>${SITE_URL}${slug}</loc><lastmod>${today}</lastmod><changefreq>monthly</changefreq><priority>0.6</priority></url>`),
        ...toolPaths.map(({ locale, id }) => {
          const alternates = QUICK_LANGUAGES.map(([code]) =>
            `<xhtml:link rel="alternate" hreflang="${code === 'zh' ? 'zh-Hans' : code}" href="${SITE_URL}/tools/${code}/${id}/"/>`).join('');
          return `  <url><loc>${SITE_URL}/tools/${locale}/${id}/</loc><lastmod>${today}</lastmod>${alternates}<xhtml:link rel="alternate" hreflang="x-default" href="${SITE_URL}/tools/en/${id}/"/></url>`;
        }),
      ].join('\n');

      const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls}\n</urlset>\n`;
      await writeFile(path.join(outDir, 'sitemap.xml'), sitemap, 'utf8');
      await writeFile(
        path.join(outDir, 'robots.txt'),
        `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}/sitemap.xml\n`,
        'utf8',
      );

      const indexPath = path.join(outDir, 'index.html');
      let index = await readFile(indexPath, 'utf8');
      if (!index.includes('rel="canonical"')) {
        index = index.replace('</head>', `${appSeoMeta()}</head>`);
        await writeFile(indexPath, index, 'utf8');
      }

      // A real /video-editor/ entry point, so a refresh or a shared editor URL
      // works on static hosts without a server-side rewrite.
      const videoEditorDir = path.join(outDir, VIDEO_EDITOR_SLUG);
      await mkdir(videoEditorDir, { recursive: true });
      const videoEditorHtml = index
        .replace('<head>', '<head>\n    <base href="../" />')
        .replace(
          /<link rel="canonical"[^>]*>/,
          `<link rel="canonical" href="${SITE_URL}/${VIDEO_EDITOR_SLUG}/" />`,
        )
        .replace(
          /<meta name="robots"[^>]*>/,
          '<meta name="robots" content="noindex,follow" />',
        );
      await writeFileIfChanged(path.join(videoEditorDir, 'index.html'), videoEditorHtml);
      generated.push(`/${VIDEO_EDITOR_SLUG}/`);

      console.log(
        `[seo] generated ${generated.length + toolHubPaths.length + toolPaths.length} pages, sitemap.xml, robots.txt (${SITE_URL})`,
      );
    },
  };
}
