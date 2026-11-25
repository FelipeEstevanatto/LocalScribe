/**
 * Universal Converter Engine.
 *
 * Implements 100% local, client-side conversions for:
 * - Video (transcoding, codecs, resolution scaling, gif snippet creation, fps, crf)
 * - Audio extraction from video
 * - Audio transcoding (sample rates, bitrates, channels, volume)
 * - Image conversion (PNG, JPG, WebP, GIF, BMP, TIFF, ICO, SVG, AVIF, Image to PDF)
 * - Document conversion (PDF to Image, PDF to Text, DOCX to HTML/TXT/MD/PDF, Markdown, HTML, JSON/CSV, RTF)
 */

import { Marked } from 'marked';
import TurndownService from 'turndown';
import { AudioFfmpeg, type RunOptions } from './audio-ffmpeg';
import {
  type ConverterSettings,
  detectFileFormat,
  getAvailableTargetFormats,
  FORMAT_REGISTRY,
  normalizeExtension,
} from './converter-catalog';
import type { PdfPageImage } from './pdf-doc';
import { audioArgs, videoArgs } from './converter-media';
import { canvasFor, decodeImage, toBlob } from './quick-canvas';

export interface ConversionProgress {
  ratio: number; // 0.0 to 1.0
  stage: string; // e.g. "Transcoding", "Rendering pages", etc.
}

export interface ConvertedResult {
  blob: Blob;
  name: string;
  mime: string;
}

const nameWithoutExt = (filename: string) => filename.replace(/\.[^.]+$/, '') || 'converted';

// Keep converter cancellation and legacy codec failures isolated from the editors.
const converterFfmpeg = new AudioFfmpeg({ singleThread: true });

async function runFfmpeg<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  try {
    return await task();
  } catch (error) {
    signal?.throwIfAborted();
    if (!(error instanceof Error) || !/memory access|unreachable|RuntimeError/i.test(error.message)) throw error;
    converterFfmpeg.dispose();
    return task();
  }
}

async function convertMedia(
  file: File, target: string, settings: ConverterSettings, signal?: AbortSignal,
  onProgress?: (p: ConversionProgress) => void,
): Promise<ConvertedResult> {
  const { ext, mime, category } = FORMAT_REGISTRY[target];
  const audio = category === 'audio';
  const stage = audio ? 'Encoding audio' : 'Encoding video';
  onProgress?.({ ratio: 0.05, stage: 'Preparing media' });
  const ffmpeg = converterFfmpeg;
  const probe = await runFfmpeg(() => ffmpeg.probe(file, signal), signal);
  if (audio ? !probe.hasAudio : !probe.hasVideo) throw new Error(audio ? 'This file has no audio track.' : 'This file has no video track.');
  const options: RunOptions = {
    signal, duration: probe.duration,
    onProgress: progress => onProgress?.({ ratio: 0.05 + 0.9 * Math.max(0, Math.min(1, progress.ratio ?? 0)), stage }),
  };
  const output = 'output.' + (target === 'amr' ? 'pcm' : ext);
  const args = audio ? audioArgs(target, settings.audio, output, probe.audioStreams?.[0]) : videoArgs(target, settings.video, output, probe.fps);
  let blob: Blob;
  try {
    blob = await runFfmpeg(() => ffmpeg.run(file, args, output, mime, options), signal);
  } catch (error) {
    if (!audio && target !== 'gifv' && settings.video.codec === 'copy' && !signal?.aborted) {
      throw new Error('The source video cannot be copied into this format. Choose Auto for the video codec.', { cause: error });
    }
    throw error;
  }
  if (target === 'amr') {
    const { default: encoder } = await import('amr-js/library/amrnb.js');
    const pcm = new DataView(await blob.arrayBuffer());
    signal?.throwIfAborted();
    const samples = new Float32Array(Math.ceil(pcm.byteLength / 320) * 160);
    for (let i = 0; i < pcm.byteLength / 2; i++) samples[i] = pcm.getInt16(i * 2, true) / 32768;
    const data = encoder.encode(samples, 8000, 7);
    if (!data || data.byteLength < 7) throw new Error('Could not encode AMR audio.');
    blob = new Blob([new Uint8Array(data)], { type: mime });
  }
  return { blob, name: nameWithoutExt(file.name) + '.' + ext, mime };
}

async function createIcoFromPng(canvas: HTMLCanvasElement): Promise<Blob> {
  const png = await toBlob(canvas);
  const header = new DataView(new ArrayBuffer(22));
  header.setUint16(2, 1, true);
  header.setUint16(4, 1, true);
  header.setUint8(6, canvas.width % 256);
  header.setUint8(7, canvas.height % 256);
  header.setUint16(10, 1, true);
  header.setUint16(12, 32, true);
  header.setUint32(14, png.size, true);
  header.setUint32(18, 22, true);
  return new Blob([header.buffer, png], { type: 'image/x-icon' });
}

async function encodeCanvas(canvas: HTMLCanvasElement, target: string, quality: number, signal?: AbortSignal): Promise<Blob> {
  const { mime, ext } = FORMAT_REGISTRY[target];
  if (target === 'ico') return createIcoFromPng(canvas);
  if (target === 'svg') {
    const image = canvas.toDataURL('image/png');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" height="${canvas.height}"><image href="${image}" width="100%" height="100%"/></svg>`;
    return new Blob([svg], { type: mime });
  }
  if (target === 'avif') {
    const { encodeAvif } = await import('./converter-avif');
    const image = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
    signal?.throwIfAborted();
    return encodeAvif(image, quality);
  }
  if (target === 'png' || target === 'jpg' || target === 'jpeg') return toBlob(canvas, mime, quality / 100);
  if (target === 'webp') {
    try { return await toBlob(canvas, mime, quality / 100); } catch { /* Use the bundled WebP encoder. */ }
  }
  const output = 'output.' + (target === 'tif' ? 'tiff' : ext);
  const codec = target === 'webp' ? ['-c:v', 'libwebp', '-quality', String(quality)] : [];
  const png = await toBlob(canvas);
  return runFfmpeg(() => converterFfmpeg.run(png, ['-i', 'input.media', '-frames:v', '1', ...codec, output], output, mime, signal), signal);
}

async function convertImageFile(
  file: File, target: string, settings: ConverterSettings, signal?: AbortSignal,
  onProgress?: (p: ConversionProgress) => void,
): Promise<ConvertedResult> {
  onProgress?.({ ratio: 0.15, stage: 'Decoding image' });
  const input = await converterImageSource(file, signal);
  const { bitmap } = input;
  const image = settings.image;
  let canvas: HTMLCanvasElement;
  try {
    let { width, height } = input;
    if (image.resizeMode === 'percent') {
      width *= image.scalePercent / 100;
      height *= image.scalePercent / 100;
    } else if (image.resizeMode === 'custom' && image.customWidth && image.customHeight) {
      if (image.keepAspectRatio) {
        const ratio = Math.min(image.customWidth / width, image.customHeight / height);
        width *= ratio;
        height *= ratio;
      } else {
        width = image.customWidth;
        height = image.customHeight;
      }
    }
    if (target === 'ico') {
      const ratio = Math.min(1, 256 / Math.max(width, height));
      width *= ratio;
      height *= ratio;
    }
    width = Math.max(1, Math.round(width));
    height = Math.max(1, Math.round(height));
    const sideways = image.rotation === 90 || image.rotation === 270;
    canvas = canvasFor({ width: sideways ? height : width, height: sideways ? width : height });
    const ctx = canvas.getContext('2d')!;
    if (['jpg', 'jpeg'].includes(target) || (target === 'bmp' && image.backgroundColor !== 'transparent')) {
      ctx.fillStyle = image.backgroundColor === 'black' ? 'black' : 'white';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    if (image.grayscale) ctx.filter = 'grayscale(100%)';
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate(image.rotation * Math.PI / 180);
    ctx.drawImage(bitmap, -width / 2, -height / 2, width, height);
  } finally {
    input.release();
  }
  signal?.throwIfAborted();
  onProgress?.({ ratio: 0.6, stage: 'Encoding image' });
  const { ext, mime } = FORMAT_REGISTRY[target];
  let blob: Blob;
  if (target === 'pdf') {
    const { imagesToPdf } = await import('./pdf-doc');
    blob = await imagesToPdf([{ blob: await toBlob(canvas), width: canvas.width, height: canvas.height }]);
  } else {
    blob = await encodeCanvas(canvas, target, image.quality, signal);
  }
  return { blob, name: nameWithoutExt(file.name) + '.' + ext, mime };
}

async function converterImageSource(file: File, signal?: AbortSignal): Promise<{
  bitmap: ImageBitmap | HTMLImageElement;
  width: number;
  height: number;
  release: () => void;
}> {
  const source = detectFileFormat(file).ext;
  if (source === 'svg') {
    const url = URL.createObjectURL(file.slice(0, undefined, 'image/svg+xml'));
    const image = new Image();
    image.src = url;
    try {
      await image.decode();
      signal?.throwIfAborted();
      return { bitmap: image, width: image.naturalWidth, height: image.naturalHeight, release: () => URL.revokeObjectURL(url) };
    } catch (error) {
      URL.revokeObjectURL(url);
      throw error;
    }
  }

  let bitmap: ImageBitmap;
  if (source === 'avif') {
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      signal?.throwIfAborted();
      const { decodeAvif } = await import('./converter-avif');
      bitmap = await decodeAvif(file);
    }
  } else {
    bitmap = await runFfmpeg(() => decodeImage(file, converterFfmpeg, signal), signal);
  }
  return { bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
}

// ---------------------------------------------------------------------------
// Helper: Document, Text & Data Conversions
// ---------------------------------------------------------------------------

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const markdown = new Marked({ renderer: { html: token => escapeHtml(token.text) } });
const turndown = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced', emDelimiter: '*' });
turndown.remove(['head', 'script', 'style', 'noscript', 'template', 'iframe']);

export function markdownToHtml(md: string): string {
  return markdown.parse(md, { async: false });
}

export function htmlToMarkdown(html: string): string {
  return turndown.turndown(html);
}

function htmlToText(html: string): string {
  const template = document.createElement('template');
  template.innerHTML = html;
  for (const node of template.content.querySelectorAll('head,script,style,noscript,template,iframe,title,meta,link')) node.remove();
  for (const br of template.content.querySelectorAll('br')) br.replaceWith('\n');
  for (const block of template.content.querySelectorAll('h1,h2,h3,h4,h5,h6,p,div,li,blockquote,pre,tr,th,td')) {
    block.append(block.matches('th,td') ? '\t' : '\n');
  }
  return (template.content.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim();
}

function csvCell(value: unknown): string {
  if (value === undefined || value === null) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

export function jsonToCsv(raw: string): string {
  const parsed: unknown = JSON.parse(raw.replace(/^\uFEFF/, ''));
  const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
  if (record(parsed)) {
    return ['Key,Value', ...Object.entries(parsed).map(([key, value]) => [csvCell(key), csvCell(value)].join(','))].join('\r\n');
  }
  if (!Array.isArray(parsed)) return 'Value\r\n' + csvCell(parsed);
  if (!parsed.length) return 'Value';
  if (!parsed.every(record)) return ['Value', ...parsed.map(csvCell)].join('\r\n');
  const headers = [...new Set(parsed.flatMap(row => Object.keys(row)))];
  if (!headers.length) return ['Value', ...parsed.map(csvCell)].join('\r\n');
  return [headers.map(csvCell).join(','), ...parsed.map(row => headers.map(header => csvCell(row[header])).join(','))].join('\r\n');
}

export function csvToJson(raw: string): string {
  const input = raw.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let closedQuote = false;
  function addCell(): void {
    row.push(cell);
    cell = '';
    closedQuote = false;
  }
  function addRow(): void {
    const hasData = row.length > 0 || cell !== '' || closedQuote;
    addCell();
    if (hasData) rows.push(row);
    row = [];
  }
  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (quoted) {
      if (char === '"' && input[index + 1] === '"') {
        cell += '"';
        index++;
      } else if (char === '"') {
        quoted = false;
        closedQuote = true;
      } else cell += char;
    } else if (char === ',') addCell();
    else if (char === '\r' || char === '\n') {
      addRow();
      if (char === '\r' && input[index + 1] === '\n') index++;
    } else if (char === '"' && !cell && !closedQuote) quoted = true;
    else if (closedQuote) throw new Error('Unexpected text after a quoted CSV value.');
    else cell += char;
  }
  if (quoted) throw new Error('A quoted CSV value is missing its closing quote.');
  if (row.length || cell || closedQuote) addRow();
  const headers = rows.shift();
  if (!headers) return '[]';
  const used = new Set<string>();
  const width = rows.reduce((max, values) => Math.max(max, values.length), headers.length);
  const keys = Array.from({ length: width }, (_, index) => {
    const base = headers[index] || 'Column ' + (index + 1);
    let key = base;
    for (let suffix = 2; used.has(key); suffix++) key = base + ' ' + suffix;
    used.add(key);
    return key;
  });
  return JSON.stringify(rows.map(values => Object.fromEntries(keys.map((key, index) => [key, values[index] ?? '']))), null, 2);
}

export function rtfToText(rtf: string): string {
  const omit = new Set(['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'header', 'footer', 'fldinst']);
  const groups = [{ skip: false, fallback: 1 }];
  let decoder = new TextDecoder('windows-1252');
  let remainingFallback = 0;
  let out = '';
  const tokens = /\\([a-z]+)(-?\d+)? ?|\\'([\da-f]{2})|\\([^a-z])|[{}]|[^{}\\]/gi;
  const symbols: Record<string, string> = { par: '\n', line: '\n', tab: '\t', emdash: '\u2014', endash: '\u2013', bullet: '\u2022', lquote: '\u2018', rquote: '\u2019', ldblquote: '\u201c', rdblquote: '\u201d' };
  function append(value: string): void {
    if (remainingFallback > 0) remainingFallback--;
    else out += value;
  }
  for (const token of rtf.matchAll(tokens)) {
    const [raw, word, parameter, hex, symbol] = token;
    const group = groups[groups.length - 1];
    if (raw === '{') groups.push({ ...group });
    else if (raw === '}') {
      if (groups.length > 1) groups.pop();
      remainingFallback = 0;
    } else if (symbol === '*' || omit.has(word)) group.skip = true;
    else if (!group.skip) {
      if (word === 'ansicpg' && parameter) {
        try { decoder = new TextDecoder('windows-' + parameter); } catch { /* Keep the default code page. */ }
      } else if (word === 'uc') {
        group.fallback = Math.max(0, Number(parameter) || 0);
      } else if (word === 'u' && parameter) {
        out += String.fromCharCode(Number(parameter));
        remainingFallback = group.fallback;
      } else if (word && Object.hasOwn(symbols, word)) append(symbols[word]);
      else if (hex) append(decoder.decode(Uint8Array.of(parseInt(hex, 16))));
      else if (symbol && '{}\\~_'.includes(symbol)) append(symbol === '~' ? '\u00a0' : symbol === '_' ? '\u2011' : symbol);
      else if (!word && !symbol && raw !== '\r' && raw !== '\n') append(raw);
    }
  }
  return out.trim();
}

async function textToPdf(title: string, text: string, signal?: AbortSignal): Promise<Blob> {
  const { PDFDocument, StandardFonts } = await import('pdf-lib');
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const paragraphs = text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n');
  const encodable = (value: string): boolean => {
    try {
      font.encodeText(value);
      return true;
    } catch {
      return false;
    }
  };
  // Without a canvas there is no way to draw characters Helvetica lacks.
  if (typeof document === 'undefined' && !paragraphs.every(encodable)) {
    return rasterTextToPdf(title, text, signal);
  }
  const margin = 42;
  const width = 595;
  const height = 842;
  const size = 12;
  const lineHeight = 18;
  const available = width - 2 * margin;
  let page = pdf.addPage([width, height]);
  let y = height - margin;
  pdf.setTitle(title);

  function nextLine(): void {
    if (y < margin) {
      page = pdf.addPage([width, height]);
      y = height - margin;
    }
  }

  function draw(line: string): void {
    nextLine();
    if (line) page.drawText(line, { x: margin, y, size, font });
    y -= lineHeight;
  }

  // Lines with characters the standard PDF font cannot encode (CJK, emoji,
  // most non-Latin scripts) are drawn as images. Every other line stays real,
  // selectable text, instead of rasterising the whole document.
  const scale = 3;
  const fontCss = `${size * scale}px Helvetica, Arial, "Noto Sans", "Noto Sans CJK JP", "Segoe UI", "Segoe UI Emoji", sans-serif`;
  let measureContext: CanvasRenderingContext2D | null = null;
  const measure = (value: string): number => {
    measureContext ??= canvasFor({ width: 8, height: 8 }).getContext('2d')!;
    measureContext.font = fontCss;
    return measureContext.measureText(value).width / scale;
  };

  async function drawRaster(line: string): Promise<void> {
    nextLine();
    if (line.trim()) {
      const canvas = canvasFor({ width: Math.ceil(available * scale), height: lineHeight * scale });
      const ctx = canvas.getContext('2d')!;
      ctx.font = fontCss;
      ctx.fillStyle = '#000';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(line, 0, Math.round(lineHeight * scale * 0.72));
      const png = await pdf.embedPng(await (await toBlob(canvas)).arrayBuffer());
      page.drawImage(png, { x: margin, y: y - lineHeight * 0.28, width: available, height: lineHeight });
    }
    y -= lineHeight;
  }

  async function drawWrappedRaster(paragraph: string): Promise<void> {
    let line = '';
    for (const word of paragraph.match(/\S+\s*|^\s+/g) ?? []) {
      if (line && measure(line + word.trimEnd()) > available) {
        await drawRaster(line.trimEnd());
        line = '';
      }
      line += word;
    }
    await drawRaster(line.trimEnd());
  }

  for (const paragraph of paragraphs) {
    signal?.throwIfAborted();
    if (!encodable(paragraph)) {
      await drawWrappedRaster(paragraph);
      continue;
    }
    let line = '';
    let lineWidth = 0;
    for (const word of paragraph.match(/\S+\s*|^\s+/g) ?? []) {
      const wordWidth = font.widthOfTextAtSize(word, size);
      if (lineWidth + wordWidth > available && line) {
        draw(line.trimEnd());
        line = '';
        lineWidth = 0;
      }
      if (wordWidth > available) {
        for (const character of word) {
          const characterWidth = font.widthOfTextAtSize(character, size);
          if (lineWidth + characterWidth > available) {
            draw(line);
            line = '';
            lineWidth = 0;
          }
          line += character;
          lineWidth += characterWidth;
        }
      } else {
        line += word;
        lineWidth += wordWidth;
      }
    }
    draw(line.trimEnd());
  }
  return new Blob([new Uint8Array(await pdf.save())], { type: 'application/pdf' });
}

async function rasterTextToPdf(title: string, text: string, signal?: AbortSignal): Promise<Blob> {
  const canvas = canvasFor({ width: 1240, height: 1754 });
  const ctx = canvas.getContext('2d')!;
  const pages: PdfPageImage[] = [];
  const margin = 84;
  const lineHeight = 34;
  const maxWidth = canvas.width - 2 * margin;
  let y = 140;

  function startPage(): void {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#111827';
    ctx.font = 'bold 28px sans-serif';
    ctx.fillText(title, margin, 80, maxWidth);
    ctx.font = '24px sans-serif';
  }

  async function savePage(): Promise<void> {
    signal?.throwIfAborted();
    pages.push({ blob: await toBlob(canvas), width: canvas.width, height: canvas.height });
  }

  startPage();
  for (const paragraph of text.replace(/\r\n?/g, '\n').split('\n')) {
    let line = '';
    for (const word of paragraph.match(/\S+\s*|^\s+/g) ?? []) {
      if (line && ctx.measureText(line + word.trimEnd()).width > maxWidth) {
        ctx.fillText(line, margin, y, maxWidth);
        y += lineHeight;
        line = '';
        if (y > canvas.height - margin) {
          await savePage();
          startPage();
          y = 140;
        }
      }
      line += word;
    }
    ctx.fillText(line, margin, y, maxWidth);
    y += lineHeight;
    if (y > canvas.height - margin) {
      await savePage();
      startPage();
      y = 140;
    }
  }
  if (y !== 140 || pages.length === 0) await savePage();
  const { imagesToPdf } = await import('./pdf-doc');
  return imagesToPdf(pages);
}

type PdfTextPage = { number: number; heading: string | null; lines: string[] };

export function selectPdfPages(total: number, settings: ConverterSettings['document']): number[] {
  if (settings.pageSelection === 'first') return [1];
  if (settings.pageSelection === 'all') return Array.from({ length: total }, (_, index) => index + 1);
  const pages = new Set<number>();
  for (const item of (settings.pageRange ?? '').split(',')) {
    const match = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(item);
    const first = Number(match?.[1]);
    const last = Number(match?.[2] ?? match?.[1]);
    if (!match || first < 1 || last < first || last > total) {
      throw new Error('Enter page numbers from 1 to ' + total + ', such as 1 or 1-3, 5.');
    }
    for (let number = first; number <= last; number++) pages.add(number);
  }
  return [...pages].sort((a, b) => a - b);
}

async function createDocx(pageBlocks: PdfTextPage[]): Promise<Blob> {
  let bodyContent = '';
  for (const block of pageBlocks) {
    if (block.heading) {
      bodyContent += `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${escapeHtml(block.heading)}</w:t></w:r></w:p>`;
    }
    for (const line of block.lines) {
      bodyContent += `<w:p><w:r><w:t xml:space="preserve">${escapeHtml(line)}</w:t></w:r></w:p>`;
    }
  }

  const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${bodyContent}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:body>
</w:document>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>
</w:styles>`;

  const { createZip } = await import('./zip');
  return createZip([
    { name: '[Content_Types].xml', blob: new Blob([contentTypes], { type: 'application/xml' }) },
    { name: '_rels/.rels', blob: new Blob([rels], { type: 'application/xml' }) },
    { name: 'word/_rels/document.xml.rels', blob: new Blob([docRels], { type: 'application/xml' }) },
    { name: 'word/styles.xml', blob: new Blob([styles], { type: 'application/xml' }) },
    { name: 'word/document.xml', blob: new Blob([docXml], { type: 'application/xml' }) },
  ]);
}

async function convertPdf(
  file: File, target: string, settings: ConverterSettings, signal?: AbortSignal,
  onProgress?: (p: ConversionProgress) => void,
): Promise<ConvertedResult> {
  const { openPdf } = await import('./pdf-doc');
  const loading = await openPdf(file);
  const cancel = () => { void loading.destroy().catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    signal?.throwIfAborted();
    const pdf = await loading.promise;
    const numbers = selectPdfPages(pdf.numPages, settings.document);
    const base = nameWithoutExt(file.name);
    const { ext, mime, category } = FORMAT_REGISTRY[target];
    const images: { name: string; blob: Blob }[] = [];
    const textPages: PdfTextPage[] = [];
    for (const [index, number] of numbers.entries()) {
      signal?.throwIfAborted();
      const page = await pdf.getPage(number);
      try {
        if (category === 'image') {
          const viewport = page.getViewport({ scale: settings.document.dpi / 72 });
          const limit = Math.min(1, 8192 / Math.max(viewport.width, viewport.height), Math.sqrt(32_000_000 / (viewport.width * viewport.height)));
          const fitted = limit < 1 ? page.getViewport({ scale: (settings.document.dpi / 72) * limit }) : viewport;
          const canvas = canvasFor({ width: Math.max(1, Math.floor(fitted.width)), height: Math.max(1, Math.floor(fitted.height)) });
          const render = page.render({ canvas, viewport: fitted });
          const cancelRender = () => render.cancel();
          signal?.addEventListener('abort', cancelRender, { once: true });
          try {
            await render.promise;
            const blob = await encodeCanvas(canvas, target, 92, signal);
            const suffix = pdf.numPages === 1 ? '' : '-page-' + number;
            images.push({ name: base + suffix + '.' + ext, blob });
          } finally {
            signal?.removeEventListener('abort', cancelRender);
            canvas.width = 0;
          }
        } else {
          const content = await page.getTextContent();
          const lines: string[] = [];
          let line = '';
          let previousY: number | undefined;
          for (const item of content.items) {
            if (!('str' in item)) continue;
            const y = item.transform[5];
            if (line && previousY !== undefined && Math.abs(y - previousY) > 5) {
              lines.push(line.trimEnd());
              line = '';
            }
            line += item.str;
            previousY = y;
            if (item.hasEOL) {
              lines.push(line.trimEnd());
              line = '';
            }
          }
          if (line.trim()) lines.push(line.trimEnd());
          textPages.push({ number, heading: pdf.numPages > 1 ? 'Page ' + number : null, lines });
        }
      } finally {
        page.cleanup();
      }
      onProgress?.({ ratio: 0.15 + 0.75 * ((index + 1) / numbers.length), stage: category === 'image' ? 'Rendering PDF pages' : 'Extracting PDF text' });
    }
    if (images.length === 1) return { ...images[0], mime };
    if (images.length > 1) {
      const { createZip } = await import('./zip');
      return { blob: await createZip(images), name: base + '-' + ext + '-pages.zip', mime: 'application/zip' };
    }
    if (!textPages.some(page => page.lines.some(line => line.trim()))) {
      throw new Error('These pages have no selectable text. Open the PDF in OCR & redact to read scanned pages.');
    }
    let blob: Blob;
    if (target === 'docx') {
      blob = (await createDocx(textPages)).slice(0, undefined, mime);
    } else {
      const formatted = textPages.map(page => {
        if (target === 'html') {
          const heading = page.heading ? '<h2>' + escapeHtml(page.heading) + '</h2>\n' : '';
          return heading + page.lines.map(line => '<p>' + escapeHtml(line) + '</p>').join('\n');
        }
        const heading = page.heading ? (target === 'md' ? '## ' : '') + page.heading + '\n\n' : '';
        return heading + page.lines.join('\n');
      }).join('\n\n');
      blob = new Blob([target === 'html' ? wrapHtml(base, formatted) : formatted], { type: mime });
    }
    return { blob, name: base + '.' + ext, mime };
  } finally {
    signal?.removeEventListener('abort', cancel);
    await loading.destroy();
  }
}

function wrapHtml(title: string, content: string): string {
  const policy = "default-src 'none'; img-src data: https: http:; style-src 'unsafe-inline'";
  return '<!doctype html>\n<html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="' + policy + '"><title>' + escapeHtml(title) + '</title></head><body>\n' + content + '\n</body></html>';
}

function xmlToJson(xml: string): string {
  const parsed = new DOMParser().parseFromString(xml, 'application/xml');
  if (parsed.querySelector('parsererror')) throw new Error('Could not read this XML document.');
  function toObject(element: Element): object {
    return {
      name: element.tagName,
      attributes: Object.fromEntries(Array.from(element.attributes, attr => [attr.name, attr.value])),
      children: Array.from(element.childNodes).flatMap((node): (object | string)[] => {
        if (node instanceof Element) return [toObject(node)];
        if (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.CDATA_SECTION_NODE) return [node.nodeValue ?? ''];
        return [];
      }),
    };
  }
  return JSON.stringify(toObject(parsed.documentElement), null, 2);
}

async function readDocumentText(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const prefix = (bytes[0] << 8) | bytes[1];
  const encoding = prefix === 0xfffe ? 'utf-16le' : prefix === 0xfeff ? 'utf-16be' : 'utf-8';
  return new TextDecoder(encoding).decode(bytes);
}

async function convertDocumentFile(
  file: File, target: string, settings: ConverterSettings, signal?: AbortSignal,
  onProgress?: (p: ConversionProgress) => void,
): Promise<ConvertedResult> {
  const base = nameWithoutExt(file.name);
  const source = detectFileFormat(file).ext;
  if (source === 'pdf') return convertPdf(file, target, settings, signal, onProgress);
  onProgress?.({ ratio: 0.15, stage: 'Reading document' });
  const { ext, mime } = FORMAT_REGISTRY[target];
  let content: string;
  if (source === 'docx') {
    const mammoth = await import('mammoth');
    const arrayBuffer = await file.arrayBuffer();
    if (target === 'txt' || target === 'pdf') content = (await mammoth.extractRawText({ arrayBuffer })).value;
    else {
      const html = (await mammoth.convertToHtml({ arrayBuffer })).value;
      content = target === 'md' ? htmlToMarkdown(html) : wrapHtml(base, html);
    }
  } else {
    const raw = await readDocumentText(file);
    if (source === 'md') {
      const html = markdownToHtml(raw);
      content = target === 'html' ? wrapHtml(base, html) : htmlToText(html);
    } else if (source === 'html') {
      content = target === 'md' ? htmlToMarkdown(raw) : htmlToText(raw);
    } else if (source === 'json' && target === 'csv') {
      content = jsonToCsv(raw);
    } else if (source === 'csv' && target === 'json') {
      content = csvToJson(raw);
    } else if (source === 'xml' && target === 'json') {
      content = xmlToJson(raw);
    } else {
      const plain = source === 'rtf' ? rtfToText(raw) : raw;
      if (target === 'html') content = wrapHtml(base, '<pre>' + escapeHtml(plain) + '</pre>');
      else if (target === 'json') content = JSON.stringify({ text: plain }, null, 2);
      else if (target === 'md') {
        let fenceLength = 3;
        for (const match of plain.matchAll(/~+/g)) fenceLength = Math.max(fenceLength, match[0].length + 1);
        const fence = '~'.repeat(fenceLength);
        content = fence + '\n' + plain + '\n' + fence;
      } else content = plain;
    }
  }
  signal?.throwIfAborted();
  const blob = target === 'pdf' ? await textToPdf(base, content, signal) : new Blob([content], { type: mime });
  return { blob, name: base + '.' + ext, mime };
}

// ---------------------------------------------------------------------------
// Universal Dispatcher
// ---------------------------------------------------------------------------

export async function convertFile(
  file: File,
  targetExt: string,
  settings: ConverterSettings,
  signal?: AbortSignal,
  onProgress?: (progress: ConversionProgress) => void,
): Promise<ConvertedResult> {
  signal?.throwIfAborted();
  const { category, ext } = detectFileFormat(file);
  const target = normalizeExtension(targetExt);
  if (!getAvailableTargetFormats(category, ext).some(format => format.id === target)) {
    throw new Error('This input and output format combination is not supported.');
  }
  const result = category === 'video' || category === 'audio'
    ? await convertMedia(file, target, settings, signal, onProgress)
    : category === 'image'
      ? await convertImageFile(file, target, settings, signal, onProgress)
      : await convertDocumentFile(file, target, settings, signal, onProgress);
  signal?.throwIfAborted();
  if (!result.blob.size && category !== 'document') throw new Error('The converter did not produce a file.');
  onProgress?.({ ratio: 1, stage: 'Complete' });
  return result;
}
