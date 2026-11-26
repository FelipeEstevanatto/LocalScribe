/**
 * Static SEO audit for the generated dist/ tree.
 *
 * Run after `bun run build`:
 *   bun run bench:seo
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

const root = join(process.cwd(), 'dist');
const pages = [];

async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full);
    else if (entry.name === 'index.html') pages.push(full);
  }
}
await walk(root);

const report = [];
const links = new Set();
const isFile = async (path) => {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
};

for (const file of pages) {
  const html = await readFile(file, 'utf8');
  // Standalone noindex screens (for example /video-editor/) are intentionally
  // outside the indexable SEO inventory and may use their own base URL.
  if (/<meta name="robots" content="noindex/i.test(html)) continue;
  const path = relative(root, file).replace(/\\/g, '/');
  const title = /<title>(.*?)<\/title>/s.exec(html)?.[1] ?? '';
  const description = /<meta name="description" content="(.*?)"/s.exec(html)?.[1] ?? '';
  const canonical = /<link rel="canonical" href="(.*?)"/s.exec(html)?.[1] ?? '';
  const h1 = (html.match(/<h1[\s>]/g) ?? []).length;
  const text = html
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<[^>]+>/g, ' ');
  const cjk = (text.match(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/g) ?? []).length;
  const words = text.split(/\s+/).filter(Boolean).length + cjk;
  const jsonLd = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  let validJsonLd = true;
  for (const block of jsonLd) {
    try {
      JSON.parse(block);
    } catch {
      validJsonLd = false;
    }
  }
  for (const match of html.matchAll(/href="([^"]+)"/g)) {
    const href = match[1];
    if (!href || href.startsWith('#') || href.startsWith('http') || href.startsWith('mailto:') || href.startsWith('data:')) continue;
    const clean = href.split('?')[0].split('#')[0];
    if (clean) links.add(resolve(dirname(file), clean));
  }
  report.push({
    path,
    title,
    titleLen: title.length,
    descLen: description.length,
    canonical,
    canonicalSlash: canonical.endsWith('/'),
    h1,
    words,
    ogImage: /property="og:image"/.test(html),
    twitterImage: /name="twitter:image"/.test(html),
    jsonLd: jsonLd.length,
    validJsonLd,
    lang: /<html lang="([^"]+)"/.exec(html)?.[1] ?? '',
  });
}

const brokenLinks = [];
for (const link of links) {
  const found = (await isFile(link)) || (await isFile(join(link, 'index.html')));
  if (!found) brokenLinks.push(relative(root, link).replace(/\\/g, '/'));
}

const quick = report.filter((page) => /^tools\/[^/]+\/[^/]+\/index\.html$/.test(page.path));
const hubs = report.filter((page) => /^tools\/[^/]+\/index\.html$/.test(page.path));
const sortedQuickWords = quick.map((page) => page.words).sort((a, b) => a - b);
const duplicateTitles = [...report.reduce((map, page) => {
  const key = page.title ?? '';
  map.set(key, (map.get(key) ?? 0) + 1);
  return map;
}, new Map())].filter(([, count]) => count > 1).map(([title]) => title);

console.log(JSON.stringify({
  pages: report.length,
  quickToolPages: quick.length,
  toolsHubs: hubs.length,
  missingOgImage: report.filter((page) => !page.ogImage).length,
  missingTwitterImage: report.filter((page) => !page.twitterImage).length,
  missingJsonLd: report.filter((page) => page.jsonLd === 0).length,
  invalidJsonLd: report.filter((page) => !page.validJsonLd).length,
  pagesWithoutCanonicalSlash: report.filter((page) => !page.canonicalSlash).length,
  h1NotOne: report.filter((page) => page.h1 !== 1).map((page) => page.path),
  titleOver60: report.filter((page) => page.titleLen > 60).length,
  longTitles: report.filter((page) => page.titleLen > 60).map((page) => ({ path: page.path, length: page.titleLen, title: page.title })),
  descriptionOver160: report.filter((page) => page.descLen > 160).length,
  longDescriptions: report.filter((page) => page.descLen > 160).map((page) => ({ path: page.path, length: page.descLen })),
  thinQuickPages: quick.filter((page) => page.words < 150).length,
  thinQuickPaths: quick.filter((page) => page.words < 150).map((page) => page.path),
  quickWordsMin: sortedQuickWords[0] ?? 0,
  quickWordsMedian: sortedQuickWords[Math.floor(sortedQuickWords.length / 2)] ?? 0,
  brokenLinkCount: brokenLinks.length,
  brokenLinks: brokenLinks.slice(0, 20),
  duplicateTitles,
}, null, 2));
