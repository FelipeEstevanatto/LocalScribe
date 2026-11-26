/**
 * Documents & privacy studio.
 *
 * OCR/redaction uses the local PP-OCR models and rasterised PDF pages. The
 * metadata tab strips image/media/PDF metadata, hashes files, renames them, and
 * packages the result locally. Nothing is uploaded.
 */

import { sharedFfmpeg } from './audio-ffmpeg';
import { asciiPreview, checksumsFor, headText, hexPreview, type FileChecksums } from './file-metadata';
import { sharedMedia } from './media-router';
import type { OcrLine } from './ocr';
import type { PdfMetadataResult, PdfPageImage } from './pdf-doc';
import { createZip } from './zip';

interface DocumentOptions {
  download: (blob: Blob, name: string) => void;
}

interface RedactionBox {
  x: number;
  y: number;
  width: number;
  height: number;
  line?: number;
}

interface DocumentPage {
  image: PdfPageImage;
  lines: OcrLine[];
  boxes: RedactionBox[];
}

const MAX_PDF_PAGES = 30;
const PII = /(?:\b[\w.+-]+@[\w.-]+\.\w{2,}\b)|(?:\+?\d[\d ().-]{7,}\d)|(?:\b(?:\d[ -]*?){13,19}\b)|(?:\b(?:iban|ssn|passport|account|routing|tax id)\b)/i;
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif']);
const MEDIA_EXTENSIONS = new Set(['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'oga', 'opus', 'weba', 'webm', 'mp4', 'm4v', 'mov', 'mkv', 'avi', 'wmv']);

function extensionOf(name: string): string {
  return name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
}

function baseName(name: string): string {
  return name.replace(/\.[^.]+$/, '') || 'file';
}

function isPdfFile(file: File): boolean {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
}

function isImageFile(file: File): boolean {
  return file.type.startsWith('image/') || IMAGE_EXTENSIONS.has(extensionOf(file.name));
}

function safeName(value: string): string {
  return value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').trim() || 'file';
}

function formatSize(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const power = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1000)));
  return `${(bytes / 1000 ** power).toFixed(power ? 1 : 0)} ${units[power]}`;
}

function printable(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (ArrayBuffer.isView(value)) return `<binary ${value.byteLength} bytes>`;
  if (Array.isArray(value)) return value.map(printable).join(', ');
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function magicType(bytes: Uint8Array): string {
  const ascii = (start: number, length: number) => String.fromCharCode(...bytes.slice(start, start + length));
  if (ascii(0, 4) === '%PDF') return 'PDF document';
  if (bytes[0] === 0x89 && ascii(1, 3) === 'PNG') return 'PNG image';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'JPEG image';
  if (ascii(0, 4) === 'GIF8') return 'GIF image';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'WebP image';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') return 'WAV audio';
  if (ascii(0, 4) === 'II*\0' || ascii(0, 4) === 'MM\0*') return 'TIFF image';
  if (ascii(0, 4) === 'fLaC') return 'FLAC audio';
  if (ascii(0, 4) === 'OggS') return 'Ogg audio/video';
  if (ascii(0, 4) === 'FORM' && (ascii(8, 4) === 'AIFF' || ascii(8, 4) === 'AIFC')) return 'AIFF audio';
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return 'Matroska/WebM video';
  if (ascii(4, 4) === 'ftyp') {
    const brand = ascii(8, 4);
    if (brand.startsWith('M4A') || brand.startsWith('M4B')) return 'M4A audio';
    if (brand.startsWith('qt')) return 'QuickTime video';
    return 'MP4-family media';
  }
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return 'ZIP/OpenXML document';
  if (ascii(0, 4) === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) return 'MP3 audio';
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'BMP image';
  return 'Unknown binary';
}

interface MetadataTag {
  tag: string;
  path: string;
  value: string;
}

function formatBinarySize(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  const power = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** power).toFixed(power ? 1 : 0)} ${units[power]}`;
}

/** Human-readable form of a PDF date such as D:20250515211231-03'00'. */
function pdfDate(value: unknown): string {
  if (typeof value !== 'string') return '';
  const match = /^D:(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:(Z)|([+-])(\d{2})'?(\d{2})'?)?/.exec(value);
  if (!match) return value;
  const [, year, month, day, hour, minute, second, zulu, sign, offsetHour, offsetMinute] = match;
  const zone = zulu ? 'UTC' : sign ? `UTC${sign}${offsetHour}:${offsetMinute}` : '';
  return `${year}-${month}-${day} ${hour}:${minute}:${second}${zone ? ` ${zone}` : ''}`;
}

function exifToolPdfDate(value: unknown): string {
  if (typeof value !== 'string') return printable(value);
  const match = /^D:(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(.*)$/.exec(value);
  if (!match) return value;
  const [, year, month, day, hour, minute, second, rest] = match;
  const offset = /^([+-])(\d{2})'?(\d{2})'?/.exec(rest);
  const zone = rest.startsWith('Z')
    ? 'Z'
    : offset
      ? `${offset[1]}${offset[2]}:${offset[3]}`
      : rest.replaceAll("'", '');
  return `${year}:${month}:${day} ${hour}:${minute}:${second}${zone}`;
}

const PDF_INFO_ORDER = [
  'IsLinearized', 'IsAcroFormPresent', 'IsCollectionPresent', 'IsSignaturesPresent',
  'IsXFAPresent', 'Author', 'Creator', 'ModDate', 'PDFFormatVersion', 'Title',
  'Language', 'Subject', 'Keywords', 'Producer', 'CreationDate', 'Trapped', 'EncryptFilterName',
];

const PDF_INFO_LABELS: Record<string, string> = {
  PDFFormatVersion: 'PDFFormat Version',
  IsXFAPresent: 'Is XFAPresent',
  IsAcroFormPresent: 'Is Acro Form Present',
  IsCollectionPresent: 'Is Collection Present',
  IsSignaturesPresent: 'Is Signatures Present',
  IsLinearized: 'Is Linearized',
  ModDate: 'Mod Date',
  CreationDate: 'Creation Date',
  EncryptFilterName: 'Encrypt Filter Name',
};

function humanizeInfoKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
}

function pdfInfoEntries(info: Record<string, unknown>): Array<[string, unknown]> {
  const entries: Array<[string, unknown]> = [];
  const used = new Set<string>();
  for (const key of PDF_INFO_ORDER) {
    if (!(key in info)) continue;
    used.add(key);
    entries.push([`Info / ${PDF_INFO_LABELS[key] ?? humanizeInfoKey(key)}`, info[key]]);
  }
  for (const [key, value] of Object.entries(info)) {
    if (used.has(key)) continue;
    entries.push([`Info / ${PDF_INFO_LABELS[key] ?? humanizeInfoKey(key)}`, value]);
  }
  return entries;
}

const XMP_NAMESPACES: Record<string, string> = { xmpmm: 'xmpMM' };

const XMP_FIELDS: Record<string, string> = {
  format: 'Format',
  title: 'Title',
  creator: 'Creator',
  description: 'Description',
  subject: 'Subject',
  creatortool: 'CreatorTool',
  createdate: 'CreateDate',
  modifydate: 'ModifyDate',
  versionid: 'VersionID',
  renditionclass: 'RenditionClass',
  producer: 'Producer',
  keywords: 'Keywords',
};

function xmpTagName(key: string): string {
  const [namespace, ...rest] = key.split(':');
  const local = rest.join(':');
  const field = XMP_FIELDS[local.toLowerCase()]
    ?? `${local.charAt(0).toUpperCase()}${local.slice(1)}`;
  return `XMP-${XMP_NAMESPACES[namespace] ?? namespace}:${field}`;
}

function xmpViewerEntries(xmp: Record<string, string | string[]>): Array<[string, unknown]> {
  return [
    ['Title', xmp['dc:title']],
    ['Creator', xmp['dc:creator']],
    ['Creator tool', xmp['xmp:creatortool']],
    ['Modify date', xmp['xmp:modifydate']],
    ['Description', xmp['dc:description']],
  ];
}

function buildPdfTags(file: File, pdf: PdfMetadataResult): MetadataTag[] {
  const tags: MetadataTag[] = [];
  const add = (tag: string, value: unknown): void => {
    if (value === null || value === undefined || value === '') return;
    const text = printable(value);
    if (text === '—') return;
    tags.push({ tag, path: `ExifTool.${tag}`, value: text });
  };

  add('File:FileType', 'PDF');
  add('File:FileTypeExtension', 'PDF');
  add('File:MIMEType', file.type || 'application/pdf');

  const info = pdf.info;
  add('PDF:PDFVersion', pdf.pdfVersion);
  add('PDF:Linearized', info.IsLinearized);
  add('PDF:Author', info.Author);
  add('PDF:Creator', info.Creator);
  add('PDF:ModifyDate', exifToolPdfDate(info.ModDate));
  add('PDF:Title', info.Title);
  add('PDF:HasXFA', info.IsXFAPresent);
  add('PDF:Language', info.Language);
  add('PDF:PageCount', pdf.pageCount);
  add('PDF:Subject', info.Subject);
  add('PDF:Keywords', info.Keywords);
  add('PDF:Producer', info.Producer);
  add('PDF:CreateDate', exifToolPdfDate(info.CreationDate));
  add('PDF:Trapped', info.Trapped);
  add('PDF:EncryptFilterName', info.EncryptFilterName);

  if (pdf.xmpToolkit) add('XMP-x:XMPToolkit', pdf.xmpToolkit);
  for (const [key, value] of Object.entries(pdf.xmp)) add(xmpTagName(key), value);
  return tags;
}

function canvasFor(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

function toBlob(canvas: HTMLCanvasElement, type = 'image/png', quality = 0.92): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('The browser could not encode this image.')), type, quality);
  });
}

function lineBox(line: OcrLine): RedactionBox {
  const xs = line.box.map((point) => point[0]);
  const ys = line.box.map((point) => point[1]);
  const pad = 3;
  const x = Math.min(...xs) - pad;
  const y = Math.min(...ys) - pad;
  return {
    x,
    y,
    width: Math.max(2, Math.max(...xs) - Math.min(...xs) + pad * 2),
    height: Math.max(2, Math.max(...ys) - Math.min(...ys) + pad * 2),
  };
}

export function setupDocumentStudio(root: HTMLElement, options: DocumentOptions) {
  const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
    const element = root.querySelector<T>('#' + id);
    if (!element) throw new Error('Missing document control: ' + id);
    return element;
  };

  const canvas = $<HTMLCanvasElement>('doc-canvas');
  const maybeContext = canvas.getContext('2d', { willReadFrequently: true });
  if (!maybeContext) throw new Error('Canvas is not available.');
  const context = maybeContext;

  // Boxes and OCR guides live on a transparent overlay so pointer drags do
  // not force a full-resolution repaint of the page bitmap.
  let overlay: HTMLCanvasElement | null = null;
  let overlayContext: CanvasRenderingContext2D | null = null;
  let overlayFrame = 0;
  function getOverlayContext(): CanvasRenderingContext2D | null {
    if (overlayContext) return overlayContext;
    const element = document.createElement('canvas');
    element.id = 'doc-overlay';
    element.setAttribute('aria-hidden', 'true');
    Object.assign(element.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      width: '100%',
      height: '100%',
      pointerEvents: 'none',
    });
    const parent = canvas.parentElement;
    if (parent) {
      if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
      parent.append(element);
    }
    overlay = element;
    overlayContext = element.getContext('2d');
    return overlayContext;
  }

  const input = $<HTMLInputElement>('doc-input');
  const meta = $('doc-meta');
  const status = $('doc-status');
  const empty = $('doc-empty');
  const pagesNav = $('doc-pages');
  const pageLabel = $('doc-page-label');
  const linesBox = $('doc-lines');
  const detectButton = $<HTMLButtonElement>('doc-ocr');
  const piiButton = $<HTMLButtonElement>('doc-pii');
  const drawButton = $<HTMLButtonElement>('doc-draw');
  const undoButton = $<HTMLButtonElement>('doc-undo');
  const clearButton = $<HTMLButtonElement>('doc-clear');
  const prevButton = $<HTMLButtonElement>('doc-prev');
  const nextButton = $<HTMLButtonElement>('doc-next');
  const pngButton = $<HTMLButtonElement>('doc-download-png');
  const pdfButton = $<HTMLButtonElement>('doc-download-pdf');
  const copyButton = $<HTMLButtonElement>('doc-copy-text');
  const textButton = $<HTMLButtonElement>('doc-download-text');

  const metadataInput = $<HTMLInputElement>('doc-metadata-input');
  const metadataGroups = $('doc-metadata-groups');
  const metadataStatus = $('doc-metadata-status');
  const metadataViewer = $<HTMLButtonElement>('doc-metadata-viewer');
  const metadataRaw = $<HTMLButtonElement>('doc-metadata-raw');
  const metadataJson = $<HTMLButtonElement>('doc-metadata-json');
  const metadataFile = $<HTMLButtonElement>('doc-metadata-file');
  const metadataPreview = $('doc-metadata-preview');
  const metadataCopy = $<HTMLButtonElement>('doc-metadata-copy');
  const metadataDownload = $<HTMLButtonElement>('doc-metadata-download');
  const metadataRecover = $<HTMLButtonElement>('doc-metadata-recover');
  const wordTools = $('doc-word-tools');
  const wordView = $<HTMLButtonElement>('doc-word-view');
  const imageTools = $('doc-image-tools');
  const imageOptimize = $<HTMLButtonElement>('doc-image-optimize');
  const imageInvert = $<HTMLButtonElement>('doc-image-invert');
  const imageFlip = $<HTMLButtonElement>('doc-image-flip');
  const imageRotate = $<HTMLButtonElement>('doc-image-rotate');
  const imageStrip = $<HTMLButtonElement>('doc-image-strip');
  const pdfTools = $('doc-pdf-tools');
  const pdfView = $<HTMLButtonElement>('doc-pdf-view');
  const pdfFlatten = $<HTMLButtonElement>('doc-pdf-flatten');
  const pdfPages = $<HTMLButtonElement>('doc-pdf-pages');
  const pdfLinks = $<HTMLButtonElement>('doc-pdf-links');
  const pdfPassword = $<HTMLInputElement>('doc-pdf-password');
  const pdfUnlock = $<HTMLButtonElement>('doc-pdf-unlock');
  const pdfLock = $<HTMLButtonElement>('doc-pdf-lock');

  const tabs = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-doc-tab]'));
  const panels = Array.from(root.querySelectorAll<HTMLElement>('[data-doc-panel]'));

  function selectTab(id: string | undefined): void {
    if (!id) return;
    for (const item of tabs) item.setAttribute('aria-selected', String(item.dataset.docTab === id));
    for (const panel of panels) panel.classList.toggle('hidden', panel.dataset.docPanel !== id);
  }

  let pages: DocumentPage[] = [];
  let index = 0;
  let bitmap: ImageBitmap | null = null;
  let drawMode = false;
  let drag: { x: number; y: number; width: number; height: number } | null = null;
  let sourceName = 'document';
  let sourceKind: 'pdf' | 'image' = 'image';
  let pdfFile: File | null = null;
  let busy = false;

  const currentPage = (): DocumentPage | null => pages[index] ?? null;

  /** PDF pages beyond the first are rasterized only when actually needed. */
  async function ensurePageRendered(page: DocumentPage, pageNumber: number): Promise<void> {
    if (page.image.width > 0 || !pdfFile) return;
    const { renderPdfPage } = await import('./pdf-doc');
    page.image = await renderPdfPage(pdfFile, pageNumber + 1, 1800);
  }

  function updateButtons(): void {
    const ready = Boolean(bitmap) && !busy;
    detectButton.disabled = !ready;
    piiButton.disabled = !ready || !currentPage()?.lines.length;
    drawButton.disabled = !ready;
    undoButton.disabled = !ready || !currentPage()?.boxes.length;
    clearButton.disabled = !ready || !currentPage()?.boxes.length;
    prevButton.disabled = index <= 0 || busy;
    nextButton.disabled = index >= pages.length - 1 || busy;
    pngButton.disabled = !ready;
    pdfButton.disabled = !ready || !pages.length;
    copyButton.disabled = !ready;
    textButton.disabled = !ready;
    pagesNav.classList.toggle('hidden', pages.length < 2);
    pageLabel.textContent = `${index + 1} / ${Math.max(1, pages.length)}`;
    empty.classList.toggle('hidden', Boolean(bitmap));
    canvas.classList.toggle('hidden', !bitmap);
    drawButton.classList.toggle('active', drawMode);
  }

  function renderBase(): void {
    if (overlay && (overlay.width !== canvas.width || overlay.height !== canvas.height)) {
      overlay.width = canvas.width;
      overlay.height = canvas.height;
    }
    if (!bitmap) {
      overlayContext?.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  }

  function renderOverlay(): void {
    const painter = getOverlayContext();
    if (!painter) return;
    painter.clearRect(0, 0, canvas.width, canvas.height);
    const page = currentPage();
    if (!page || !bitmap) return;
    for (const box of page.boxes) {
      painter.fillStyle = '#05070d';
      painter.fillRect(box.x, box.y, box.width, box.height);
    }
    painter.lineWidth = Math.max(1, canvas.width / 900);
    for (const line of page.lines) {
      const box = lineBox(line);
      painter.strokeStyle = 'rgba(251, 191, 36, 0.65)';
      painter.setLineDash([5, 4]);
      painter.strokeRect(box.x, box.y, box.width, box.height);
    }
    painter.setLineDash([]);
    if (drag) {
      painter.strokeStyle = '#818cf8';
      painter.fillStyle = 'rgba(99, 102, 241, 0.18)';
      painter.lineWidth = 2;
      painter.fillRect(drag.x, drag.y, drag.width, drag.height);
      painter.strokeRect(drag.x, drag.y, drag.width, drag.height);
    }
  }

  function render(): void {
    renderBase();
    renderOverlay();
  }

  /** Coalesce high-rate pointer moves into one overlay repaint per frame. */
  function scheduleOverlay(): void {
    if (overlayFrame) return;
    overlayFrame = requestAnimationFrame(() => {
      overlayFrame = 0;
      renderOverlay();
    });
  }

  function renderLines(): void {
    const page = currentPage();
    linesBox.replaceChildren();
    if (!page?.lines.length) return;
    const title = document.createElement('p');
    title.className = 'doc-lines-title';
    title.textContent = `${page.lines.length} detected line${page.lines.length === 1 ? '' : 's'}`;
    linesBox.append(title);
    page.lines.forEach((line, lineIndex) => {
      const selected = page.boxes.some((box) => box.line === lineIndex);
      const label = document.createElement('label');
      label.className = 'doc-line';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = selected;
      checkbox.addEventListener('change', () => toggleLine(lineIndex, checkbox.checked));
      const text = document.createElement('span');
      text.textContent = line.text;
      const score = document.createElement('small');
      score.textContent = `${Math.round(line.score * 100)}%`;
      label.append(checkbox, text, score);
      linesBox.append(label);
    });
  }

  function toggleLine(lineIndex: number, selected: boolean): void {
    const page = currentPage();
    if (!page) return;
    if (selected) {
      if (!page.boxes.some((box) => box.line === lineIndex)) {
        page.boxes.push({ ...lineBox(page.lines[lineIndex]), line: lineIndex });
      }
    } else {
      page.boxes = page.boxes.filter((box) => box.line !== lineIndex);
    }
    render();
    updateButtons();
    renderLines();
  }

  function setStatus(message: string, tone: 'normal' | 'error' | 'good' = 'normal'): void {
    status.textContent = message;
    status.dataset.tone = tone;
  }

  async function loadPage(next: number): Promise<void> {
    if (next < 0 || next >= pages.length) return;
    index = next;
    await ensurePageRendered(pages[index], index);
    bitmap?.close();
    bitmap = await createImageBitmap(pages[index].image.blob);
    canvas.width = pages[index].image.width;
    canvas.height = pages[index].image.height;
    render();
    renderLines();
    updateButtons();
  }

  async function loadFile(file: File): Promise<void> {
    busy = true;
    updateButtons();
    try {
      pages = [];
      index = 0;
      bitmap?.close();
      bitmap = null;
      linesBox.replaceChildren();
      sourceName = baseName(file.name);
      const pdf = isPdfFile(file);
      sourceKind = pdf ? 'pdf' : 'image';
      pdfFile = pdf ? file : null;
      if (pdf) {
        setStatus('Rendering the first PDF page locally…');
        const { renderPdfPages } = await import('./pdf-doc');
        const rendered = await renderPdfPages(file, { maxPages: MAX_PDF_PAGES, firstPageOnly: true });
        if (!rendered.length) throw new Error('The PDF has no pages.');
        pages = rendered.map((image) => ({ image, lines: [], boxes: [] }));
        meta.textContent = `${file.name} · ${pages.length} page${pages.length === 1 ? '' : 's'} · rendered locally`;
      } else {
        const image = await createImageBitmap(file);
        const width = image.width;
        const height = image.height;
        image.close();
        pages = [{ image: { blob: file, width, height }, lines: [], boxes: [] }];
        meta.textContent = `${file.name} · ${width} × ${height} · ${formatSize(file.size)}`;
      }
      await loadPage(0);
      setStatus(sourceKind === 'pdf' ? 'PDF ready. Run OCR or draw redaction boxes.' : 'Image ready. Run OCR or draw redaction boxes.', 'good');
    } catch (error) {
      pages = [];
      bitmap?.close();
      bitmap = null;
      updateButtons();
      setStatus(error instanceof Error ? error.message : String(error), 'error');
      throw error;
    } finally {
      busy = false;
      updateButtons();
    }
  }

  async function detectText(): Promise<void> {
    const page = currentPage();
    if (!page || busy) return;
    await ensurePageRendered(page, index);
    busy = true;
    updateButtons();
    try {
      setStatus('Loading the local OCR model…');
      const { loadOcr, runOcr } = await import('./ocr');
      await loadOcr((loaded, total) => {
        setStatus(`Downloading OCR model · ${Math.round((loaded / total) * 100)}%`);
      });
      const source = canvasFor(page.image.width, page.image.height);
      const sourceContext = source.getContext('2d', { willReadFrequently: true });
      if (!sourceContext) throw new Error('Could not read the page pixels.');
      const sourceBitmap = page === currentPage() && bitmap
        ? bitmap
        : await createImageBitmap(page.image.blob);
      sourceContext.drawImage(sourceBitmap, 0, 0);
      if (sourceBitmap !== bitmap) sourceBitmap.close();
      const pixels = sourceContext.getImageData(0, 0, source.width, source.height);
      setStatus('Finding text…');
      page.lines = await runOcr(
        { data: pixels.data, width: source.width, height: source.height, channels: 4 },
        {
          maxSide: 1800,
          onProgress: (fraction, text) => setStatus(`${text} · ${Math.round(fraction * 100)}%`),
        },
      );
      page.boxes = [];
      render();
      renderLines();
      setStatus(page.lines.length ? `${page.lines.length} line${page.lines.length === 1 ? '' : 's'} found. Check the lines to redact, or draw boxes.` : 'No text found on this page.', page.lines.length ? 'good' : 'normal');
      updateButtons();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      busy = false;
      updateButtons();
    }
  }

  function selectPii(): void {
    const page = currentPage();
    if (!page) return;
    let selected = 0;
    for (const [lineIndex, line] of page.lines.entries()) {
      if (!PII.test(line.text)) continue;
      selected += 1;
      if (!page.boxes.some((box) => box.line === lineIndex)) {
        page.boxes.push({ ...lineBox(line), line: lineIndex });
      }
    }
    render();
    renderLines();
    updateButtons();
    setStatus(selected ? `${selected} likely sensitive line${selected === 1 ? '' : 's'} selected. Review before exporting.` : 'No obvious emails, phone numbers, or account numbers found.', selected ? 'good' : 'normal');
  }

  function clearBoxes(): void {
    const page = currentPage();
    if (!page) return;
    page.boxes = [];
    render();
    renderLines();
    updateButtons();
  }

  function undoBox(): void {
    const page = currentPage();
    if (!page) return;
    page.boxes.pop();
    render();
    renderLines();
    updateButtons();
  }

  function setDrawMode(next: boolean): void {
    drawMode = next;
    drawButton.classList.toggle('active', drawMode);
    setStatus(drawMode ? 'Drag on the page to add a redaction box.' : 'Redaction boxes stay on this device.');
  }

  function canvasPoint(event: PointerEvent): { x: number; y: number } {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * (canvas.width / Math.max(1, rect.width)),
      y: (event.clientY - rect.top) * (canvas.height / Math.max(1, rect.height)),
    };
  }

  async function pageWithRedactions(page: DocumentPage): Promise<{ blob: Blob; width: number; height: number }> {
    await ensurePageRendered(page, pages.indexOf(page));
    // An unmodified page is already the exact raster we want in the output.
    // Re-encoding it to PNG would only cost time and memory.
    if (!page.boxes.length) {
      return { blob: page.image.blob, width: page.image.width, height: page.image.height };
    }
    const output = canvasFor(page.image.width, page.image.height);
    const outputContext = output.getContext('2d');
    if (!outputContext) throw new Error('Could not create the redacted page.');
    const source = page === currentPage() && bitmap
      ? bitmap
      : await createImageBitmap(page.image.blob);
    outputContext.drawImage(source, 0, 0);
    if (source !== bitmap) source.close();
    outputContext.fillStyle = '#05070d';
    for (const box of page.boxes) outputContext.fillRect(box.x, box.y, box.width, box.height);
    return { blob: await toBlob(output), width: output.width, height: output.height };
  }

  async function downloadPng(): Promise<void> {
    const page = currentPage();
    if (!page) return;
    const output = await pageWithRedactions(page);
    options.download(output.blob, `${sourceName}-redacted.png`);
    setStatus('Redacted PNG downloaded.', 'good');
  }

  async function downloadPdf(): Promise<void> {
    if (!pages.length || busy) return;
    busy = true;
    updateButtons();
    try {
      setStatus('Building the redacted PDF…');
      const { imagesToPdf } = await import('./pdf-doc');
      const rendered = [];
      for (const page of pages) rendered.push(await pageWithRedactions(page));
      const blob = await imagesToPdf(rendered);
      options.download(blob, `${sourceName}-redacted.pdf`);
      setStatus('Redacted PDF downloaded. The original text layer and metadata are gone.', 'good');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      busy = false;
      updateButtons();
    }
  }

  function allText(): string {
    return pages.map((page, pageIndex) => {
      const text = page.lines.map((line) => line.text).join('\n');
      return pages.length > 1 ? `--- Page ${pageIndex + 1} ---\n${text}` : text;
    }).join('\n\n');
  }

  async function copyText(): Promise<void> {
    const text = allText();
    try {
      await navigator.clipboard.writeText(text);
      setStatus('Extracted text copied.', 'good');
    } catch {
      setStatus('Could not copy automatically. Select the text or download it.', 'error');
    }
  }

  function downloadText(): void {
    options.download(new Blob([allText()], { type: 'text/plain;charset=utf-8' }), `${sourceName}-ocr.txt`);
    setStatus('OCR text downloaded.', 'good');
  }

  // Metadata viewer ----------------------------------------------------------
  type MetadataMode = 'viewer' | 'exiftool' | 'json' | 'file' | 'word';
  interface MetadataGroup { title: string; entries: Array<[string, string]> }
  interface MetadataResult {
    file: File;
    groups: MetadataGroup[];
    tags: MetadataTag[];
    raw: unknown;
    fileText: string;
    thumbnail: Blob | null;
    previewUrl: string;
    previewCaption: string;
    wordText?: string;
  }
  let metadata: MetadataResult | null = null;
  let metadataMode: MetadataMode = 'viewer';

  function metadataSetStatus(message: string, tone: 'normal' | 'error' | 'good' = 'normal'): void {
    metadataStatus.textContent = message;
    metadataStatus.dataset.tone = tone;
  }

  function addMetadataGroup(groups: MetadataGroup[], title: string, entries: Array<[string, unknown]>): void {
    const clean = entries
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .map(([key, value]) => [key, printable(value)] as [string, string]);
    if (clean.length) groups.push({ title, entries: clean });
  }

  function metadataTable(rows: Array<{ label: string; path?: string; value: string }>): HTMLTableElement {
    const table = document.createElement('table');
    table.className = 'doc-meta-table';
    const head = document.createElement('thead');
    const headerRow = document.createElement('tr');
    const tagHeading = document.createElement('th');
    tagHeading.scope = 'col';
    tagHeading.textContent = 'Tag';
    const valueHeading = document.createElement('th');
    valueHeading.scope = 'col';
    valueHeading.textContent = 'Value';
    headerRow.append(tagHeading, valueHeading);
    head.append(headerRow);
    const body = document.createElement('tbody');
    for (const entry of rows) {
      const row = document.createElement('tr');
      const heading = document.createElement('th');
      heading.scope = 'row';
      const label = document.createElement('span');
      label.textContent = entry.label;
      heading.append(label);
      if (entry.path) {
        const path = document.createElement('small');
        path.textContent = entry.path;
        heading.append(path);
      }
      const cell = document.createElement('td');
      cell.textContent = entry.value;
      row.append(heading, cell);
      body.append(row);
    }
    table.append(head, body);
    return table;
  }

  function renderMetadata(): void {
    metadataGroups.replaceChildren();
    metadataPreview.replaceChildren();
    if (!metadata) {
      metadataPreview.classList.add('hidden');
      const note = document.createElement('p');
      note.className = 'doc-meta-note';
      note.innerHTML = 'Choose a file to inspect its EXIF, GPS, XMP, IPTC, PDF, media, and filesystem metadata. The same idea as <a class="doc-meta-link" href="https://exif.tools/" target="_blank" rel="noreferrer">exif.tools</a>, processed locally.';
      metadataGroups.append(note);
      metadataCopy.disabled = true;
      metadataDownload.disabled = true;
      metadataRecover.classList.add('hidden');
      imageTools.classList.add('hidden');
      pdfTools.classList.add('hidden');
      wordTools.classList.add('hidden');
      return;
    }
    metadataCopy.disabled = false;
    metadataDownload.disabled = false;
    metadataRecover.classList.toggle('hidden', !metadata.thumbnail);
    imageTools.classList.toggle('hidden', !isImageFile(metadata.file));
    pdfTools.classList.toggle('hidden', !isPdfFile(metadata.file));
    wordTools.classList.toggle('hidden', !/\.docx$/i.test(metadata.file.name));

    metadataPreview.replaceChildren();
    if (metadata.previewUrl) {
      metadataPreview.classList.remove('hidden');
      const image = document.createElement('img');
      image.src = metadata.previewUrl;
      image.alt = `Preview of ${metadata.file.name}`;
      image.loading = 'lazy';
      image.addEventListener('error', () => {
        image.remove();
        metadataPreview.classList.add('hidden');
      });
      metadataPreview.append(image);
      if (metadata.previewCaption) {
        const caption = document.createElement('p');
        caption.className = 'doc-meta-preview-caption';
        caption.textContent = metadata.previewCaption;
        metadataPreview.append(caption);
      }
    } else {
      metadataPreview.classList.add('hidden');
    }

    if (metadataMode === 'file' || metadataMode === 'word' || metadataMode === 'json') {
      const pre = document.createElement('pre');
      pre.className = 'doc-meta-json';
      pre.textContent = metadataMode === 'file'
        ? metadata.fileText
        : metadataMode === 'word'
          ? (metadata.wordText ?? 'Choose “View Word text” to extract the document text.')
          : JSON.stringify(metadata.raw, (_key, value) => {
            if (ArrayBuffer.isView(value)) return `<binary ${value.byteLength} bytes>`;
            return value;
          }, 2);
      metadataGroups.append(pre);
      return;
    }

    if (metadataMode === 'exiftool') {
      const tags = metadata.tags.length
        ? metadata.tags
        : metadata.groups.flatMap((group) => group.entries.map(([tag, value]) => ({ tag, path: group.title, value })));
      const note = document.createElement('p');
      note.className = 'doc-meta-note';
      note.textContent = 'Flat tag list derived from the document information and XMP streams.';
      const details = document.createElement('details');
      details.className = 'doc-meta-group';
      details.open = true;
      const summary = document.createElement('summary');
      summary.textContent = `${tags.length} tag${tags.length === 1 ? '' : 's'}`;
      details.append(summary, metadataTable(tags.map((tag) => ({
        label: tag.tag,
        path: tag.path,
        value: tag.value,
      }))));
      metadataGroups.append(note, details);
      return;
    }

    for (const group of metadata.groups) {
      const details = document.createElement('details');
      details.className = 'doc-meta-group';
      details.open = true;
      const summary = document.createElement('summary');
      summary.textContent = group.title;
      details.append(summary, metadataTable(group.entries.map(([label, value]) => ({ label, value }))));
      metadataGroups.append(details);
    }
  }

  async function identifyFile(file: File, head: Uint8Array, checksums: FileChecksums | null): Promise<string> {
    const magic = magicType(head);
    const lines = [
      `File: ${file.name}`,
      `Detected: ${magic}`,
      `MIME: ${file.type || 'unknown'}`,
      `Size: ${formatSize(file.size)} (${formatBinarySize(file.size)} · ${file.size.toLocaleString()} bytes)`,
      `Modified: ${new Date(file.lastModified).toISOString()}`,
      `Magic bytes: ${hexPreview(head.slice(0, 16))}`,
      `Head text: ${headText(head)}`,
    ];
    if (checksums) {
      lines.push(
        `MD5: ${checksums.md5}`,
        `SHA-1: ${checksums.sha1}`,
        `SHA-256: ${checksums.sha256}`,
        `SHA-512: ${checksums.sha512}`,
        `CRC32: ${checksums.crc32}`,
        `Adler32: ${checksums.adler32}`,
      );
    } else {
      lines.push('Checksums: skipped for files over 100 MB');
    }
    return lines.join('\n');
  }

  async function readMetadata(file: File): Promise<void> {
    metadataSetStatus('Reading metadata locally…');
    if (metadata?.previewUrl) URL.revokeObjectURL(metadata.previewUrl);
    metadata = null;
    let previewUrl = '';
    let previewCaption = '';
    try {
      const head = new Uint8Array(await file.slice(0, 64).arrayBuffer());
      const magic = magicType(head);
      const signature = `${magic} (${hexPreview(head.slice(0, 16))})`;
      const checksums = await checksumsFor(file).catch(() => null);
      const groups: MetadataGroup[] = [];
      const tags: MetadataTag[] = [];
      addMetadataGroup(groups, 'File', [
        ['Name', file.name],
        ['Size', `${formatSize(file.size)} (${formatBinarySize(file.size)} · ${file.size.toLocaleString()} bytes)`],
        ['MIME', file.type || 'unknown'],
        ['Extension', extensionOf(file.name) ? `.${extensionOf(file.name)}` : 'none'],
        ['Last modified', new Date(file.lastModified).toISOString()],
        ['Detected type', magic],
      ]);

      let exifData: unknown = null;
      let thumbnail: Blob | null = null;
      if (isImageFile(file)) {
        previewUrl = URL.createObjectURL(file);
        try {
          const exifr = await import('exifr');
          exifData = await exifr.parse(file, {
            tiff: true,
            ifd1: true,
            exif: true,
            gps: true,
            interop: true,
            xmp: true,
            iptc: true,
            icc: true,
            jfif: true,
            ihdr: true,
            mergeOutput: false,
            translateValues: true,
            reviveValues: true,
          });
          const bytes = await exifr.thumbnail(file);
          if (bytes) thumbnail = new Blob([bytes as BlobPart], { type: 'image/jpeg' });
          if (exifData && typeof exifData === 'object') {
            const labels: Record<string, string> = {
              ifd0: 'Image / TIFF', ifd1: 'Embedded thumbnail', exif: 'Camera / EXIF',
              gps: 'GPS location', interop: 'Interoperability', xmp: 'XMP',
              iptc: 'IPTC', icc: 'ICC color profile', jfif: 'JFIF', ihdr: 'PNG header',
            };
            for (const [key, value] of Object.entries(exifData as Record<string, unknown>)) {
              if (!value || typeof value !== 'object') continue;
              addMetadataGroup(groups, labels[key] ?? key, Object.entries(value as Record<string, unknown>));
            }
          }
        } catch (error) {
          addMetadataGroup(groups, 'EXIF parser', [['Note', error instanceof Error ? error.message : String(error)]]);
        }
      }

      let pdfMeta: PdfMetadataResult | null = null;
      if (isPdfFile(file)) {
        try {
          const pdf = await import('./pdf-doc');
          pdfMeta = await pdf.readPdfMetadata(file, { preview: true });
          const info = pdfMeta.info;
          addMetadataGroup(groups, 'Document details', [
            ['Title', info.Title],
            ['Author', info.Author],
            ['Creator', info.Creator],
            ['Page count', pdfMeta.pageCount],
            ['Modified', pdfDate(info.ModDate) || pdfDate(info.CreationDate)],
          ]);
          addMetadataGroup(groups, 'PDF', [
            ['Document / Encrypted', pdfMeta.encrypted],
            ['Document / Metadata Stream', pdfMeta.metadataStream],
            ['Fingerprints', pdfMeta.fingerprints.join('\n')],
            ...pdfInfoEntries(info),
            ['Page Count', pdfMeta.pageCount],
            ['PDFVersion', pdfMeta.pdfVersion],
          ]);
          addMetadataGroup(groups, 'XMP', xmpViewerEntries(pdfMeta.xmp));
          tags.push(...buildPdfTags(file, pdfMeta));
          addMetadataGroup(groups, 'ExifTool tags', tags.map((tag) => [tag.tag, tag.value]));
          if (pdfMeta.preview) {
            previewUrl = URL.createObjectURL(pdfMeta.preview);
            previewCaption = `PDF page 1 of ${pdfMeta.pageCount} · Original file unchanged`;
          }
        } catch (error) {
          addMetadataGroup(groups, 'PDF document', [['Note', error instanceof Error ? error.message : String(error)]]);
        }
      }

      if (file.type.startsWith('audio/') || file.type.startsWith('video/') || MEDIA_EXTENSIONS.has(extensionOf(file.name))) {
        try {
          const probe = await sharedMedia().probe(file);
          addMetadataGroup(groups, 'Media stream', [
            ['Duration', `${probe.duration.toFixed(2)} s`],
            ['Video codec', probe.videoCodec],
            ['Audio codec', probe.audioCodec],
            ['Dimensions', probe.width && probe.height ? `${probe.width} × ${probe.height}` : null],
            ['Frame rate', probe.fps ? `${probe.fps.toFixed(3)} fps` : null],
            ['Rotation', probe.rotation ? `${probe.rotation}°` : null],
            ['Audio streams', probe.audioStreams?.map((stream) => [stream.codec, stream.channels, stream.language, stream.title].filter(Boolean).join(' · ')).join('\n')],
          ]);
        } catch (error) {
          addMetadataGroup(groups, 'Media stream', [['Note', error instanceof Error ? error.message : String(error)]]);
        }
      }

      const checksumEntries: Array<[string, unknown]> = checksums
        ? [
          ['MD5', checksums.md5],
          ['SHA-1', checksums.sha1],
          ['SHA-256', checksums.sha256],
          ['SHA-512', checksums.sha512],
          ['CRC32', checksums.crc32],
          ['Adler32', checksums.adler32],
        ]
        : [['Checksums', 'Skipped for files over 100 MB']];
      addMetadataGroup(groups, 'Technical details & checksums', [
        ['Name', file.name],
        ['Source', 'Local file'],
        ['Extension', extensionOf(file.name) ? `.${extensionOf(file.name)}` : 'none'],
        ['Detected MIME', file.type || 'application/octet-stream'],
        ['Size', `${formatSize(file.size)} (${file.size.toLocaleString()} bytes)`],
        ['Signature', signature],
        ['Head hex', hexPreview(head.slice(0, 16))],
        ['Head text', headText(head)],
        ...checksumEntries,
        ['First 64 bytes', hexPreview(head)],
        ['ASCII preview', asciiPreview(head)],
      ]);

      const fileText = await identifyFile(file, head, checksums);
      metadata = {
        file,
        groups,
        tags,
        raw: {
          file: {
            name: file.name,
            ext: extensionOf(file.name),
            mimeType: file.type,
            detectedMime: magic,
            size: file.size,
            lastModified: file.lastModified,
            source: 'file',
            signature: { label: magic, mime: file.type || '', ext: extensionOf(file.name) },
            headHex: hexPreview(head.slice(0, 16)),
            headHexLong: hexPreview(head),
            headText: headText(head),
            headTextLong: asciiPreview(head),
            hashes: checksums,
          },
          technical: {
            first64: hexPreview(head),
            asciiPreview: asciiPreview(head),
          },
          exif: exifData,
          pdf: pdfMeta
            ? {
              pageCount: pdfMeta.pageCount,
              pdfVersion: pdfMeta.pdfVersion,
              info: pdfMeta.info,
              xmp: pdfMeta.xmp,
              xmpRaw: pdfMeta.xmpRaw,
              fingerprints: pdfMeta.fingerprints,
              documentInfo: {
                MetadataStream: pdfMeta.metadataStream,
                Encrypted: pdfMeta.encrypted,
              },
              exiftool: tags,
            }
            : null,
          groups,
        },
        fileText,
        thumbnail,
        previewUrl,
        previewCaption,
      };
      metadataSetStatus(
        `Metadata ready · ${groups.length} group${groups.length === 1 ? '' : 's'}${tags.length ? ` · ${tags.length} tags` : ''}.`,
        'good',
      );
      renderMetadata();
    } catch (error) {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      metadata = null;
      metadataSetStatus(error instanceof Error ? error.message : String(error), 'error');
      renderMetadata();
    }
  }

  function selectMetadataMode(mode: MetadataMode): void {
    metadataMode = mode;
    metadataViewer.classList.toggle('active', mode === 'viewer');
    metadataRaw.classList.toggle('active', mode === 'exiftool');
    metadataJson.classList.toggle('active', mode === 'json');
    metadataFile.classList.toggle('active', mode === 'file');
    renderMetadata();
  }

  function downloadMetadata(): void {
    if (!metadata) return;
    if (metadataMode === 'file' || metadataMode === 'word') {
      const body = metadataMode === 'word' ? (metadata.wordText ?? '') : metadata.fileText;
      options.download(
        new Blob([`${body}\n`], { type: 'text/plain;charset=utf-8' }),
        `${baseName(metadata.file.name)}-${metadataMode === 'word' ? 'word' : 'file'}.txt`,
      );
      return;
    }
    if (metadataMode === 'exiftool') {
      const tags = metadata.tags.length
        ? metadata.tags
        : metadata.groups.flatMap((group) => group.entries.map(([tag, value]) => ({ tag, path: group.title, value })));
      const body = tags.map((tag) => `${tag.tag}: ${tag.value}`).join('\n');
      options.download(
        new Blob([body + '\n'], { type: 'text/plain;charset=utf-8' }),
        `${baseName(metadata.file.name)}-exiftool.txt`,
      );
      return;
    }
    const body = JSON.stringify(metadata.raw, (_key, value) => ArrayBuffer.isView(value) ? `<binary ${value.byteLength} bytes>` : value, 2);
    options.download(
      new Blob([body + '\n'], { type: 'application/json;charset=utf-8' }),
      `${baseName(metadata.file.name)}-metadata.json`,
    );
  }

  async function imageVariant(kind: 'optimize' | 'invert' | 'flip' | 'rotate'): Promise<void> {
    if (!metadata || !isImageFile(metadata.file)) return;
    metadataSetStatus(`Creating ${kind} image…`);
    try {
      const bitmap = await createImageBitmap(metadata.file);
      const canvas = canvasFor(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('Could not create the image canvas.');
      if (kind === 'rotate') {
        canvas.width = bitmap.height;
        canvas.height = bitmap.width;
        context.translate(canvas.width / 2, canvas.height / 2);
        context.rotate(Math.PI / 2);
        context.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
      } else {
        context.drawImage(bitmap, 0, 0);
        if (kind === 'invert') {
          const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
          for (let offset = 0; offset < pixels.data.length; offset += 4) {
            pixels.data[offset] = 255 - pixels.data[offset];
            pixels.data[offset + 1] = 255 - pixels.data[offset + 1];
            pixels.data[offset + 2] = 255 - pixels.data[offset + 2];
          }
          context.putImageData(pixels, 0, 0);
        } else if (kind === 'flip') {
          context.clearRect(0, 0, canvas.width, canvas.height);
          context.translate(canvas.width, 0);
          context.scale(-1, 1);
          context.drawImage(bitmap, 0, 0);
        }
      }
      bitmap.close();
      const original = metadata.file.type;
      const type = kind === 'optimize' ? 'image/webp' : original === 'image/jpeg' || original === 'image/webp' ? original : 'image/png';
      const blob = await toBlob(canvas, type, kind === 'optimize' ? 0.85 : 0.94);
      const extension = type === 'image/jpeg' ? 'jpg' : type.split('/')[1];
      options.download(blob, `${baseName(metadata.file.name)}-${kind}.${extension}`);
      metadataSetStatus(`${kind[0].toUpperCase()}${kind.slice(1)} image downloaded.`, 'good');
    } catch (error) {
      metadataSetStatus(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  async function viewWordText(): Promise<void> {
    if (!metadata || !/\.docx$/i.test(metadata.file.name)) return;
    metadataSetStatus('Extracting Word text locally…');
    try {
      const mammoth = await import('mammoth') as unknown as {
        extractRawText: (input: { arrayBuffer: ArrayBuffer }) => Promise<{ value: string }>;
      };
      const result = await mammoth.extractRawText({ arrayBuffer: await metadata.file.arrayBuffer() });
      metadata.wordText = result.value.trim() || '(No text found in this DOCX.)';
      selectMetadataMode('word');
      metadataSetStatus('Word text extracted. Formatting is reduced to plain text.', 'good');
    } catch (error) {
      metadataSetStatus(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  async function flattenPdf(): Promise<void> {
    if (!metadata || !isPdfFile(metadata.file)) return;
    metadataSetStatus('Flattening PDF pages locally…');
    try {
      const pdf = await import('./pdf-doc');
      const pages = await pdf.renderPdfPages(metadata.file, { maxPages: 60, maxSide: 2400 });
      const blob = await pdf.imagesToPdf(pages);
      options.download(blob, `${baseName(metadata.file.name)}-flattened.pdf`);
      metadataSetStatus(`Flattened ${pages.length} page${pages.length === 1 ? '' : 's'}. Text layers and metadata are removed.`, 'good');
    } catch (error) {
      metadataSetStatus(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  async function extractPdfPageImages(): Promise<void> {
    if (!metadata || !isPdfFile(metadata.file)) return;
    const sourceFile = metadata.file;
    metadataSetStatus('Rendering PDF pages…');
    try {
      const pdf = await import('./pdf-doc');
      const pages = await pdf.renderPdfPages(sourceFile, { maxPages: 60, maxSide: 2400 });
      const blob = await createZip(pages.map((page, index) => ({
        name: `${baseName(sourceFile.name)}-page-${String(index + 1).padStart(3, '0')}.png`,
        blob: page.blob,
      })));
      options.download(blob, `${baseName(sourceFile.name)}-pages.zip`);
      metadataSetStatus(`${pages.length} page image${pages.length === 1 ? '' : 's'} extracted.`, 'good');
    } catch (error) {
      metadataSetStatus(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  async function extractPdfPageLinks(): Promise<void> {
    if (!metadata || !isPdfFile(metadata.file)) return;
    const sourceFile = metadata.file;
    metadataSetStatus('Reading PDF annotations…');
    try {
      const pdf = await import('./pdf-doc');
      const links = await pdf.extractPdfLinks(sourceFile);
      const body = links.length
        ? links.map((link) => `p.${link.page}\t${link.title ? `${link.title}\t` : ''}${link.url}`).join('\n')
        : 'No external links found.';
      options.download(new Blob([body + '\n'], { type: 'text/plain;charset=utf-8' }), `${baseName(sourceFile.name)}-links.txt`);
      metadataSetStatus(links.length ? `${links.length} link${links.length === 1 ? '' : 's'} extracted.` : 'No external links found.', links.length ? 'good' : 'normal');
    } catch (error) {
      metadataSetStatus(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  async function unlockPdf(): Promise<void> {
    if (!metadata || !isPdfFile(metadata.file)) return;
    const sourceFile = metadata.file;
    const password = pdfPassword.value;
    metadataSetStatus('Unlocking PDF locally…');
    try {
      const { PDFDocument } = await import('@cantoo/pdf-lib');
      let document;
      try {
        document = await PDFDocument.load(await sourceFile.arrayBuffer(), { password });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(/password/i.test(message)
          ? 'This PDF is protected by an open password. Enter the password above and try again.'
          : message);
      }
      const bytes = await document.save({ useObjectStreams: false });
      options.download(new Blob([bytes as BlobPart], { type: 'application/pdf' }), `${baseName(sourceFile.name)}-unlocked.pdf`);
      pdfPassword.value = '';
      metadataSetStatus('PDF saved without its open password or restrictions.', 'good');
    } catch (error) {
      metadataSetStatus(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  async function lockPdf(): Promise<void> {
    if (!metadata || !isPdfFile(metadata.file)) return;
    const sourceFile = metadata.file;
    const password = pdfPassword.value;
    if (password.length < 4) {
      metadataSetStatus('Enter a password of at least 4 characters to lock this PDF.', 'error');
      return;
    }
    metadataSetStatus('Encrypting PDF locally…');
    try {
      const { PDFDocument } = await import('@cantoo/pdf-lib');
      const document = await PDFDocument.load(await sourceFile.arrayBuffer(), { password });
      document.encrypt({
        userPassword: password,
        ownerPassword: password,
        // Readers may print, but copying or editing requires the password.
        permissions: { printing: 'highResolution', copying: false, modifying: false },
      });
      const bytes = await document.save({ useObjectStreams: false });
      options.download(new Blob([bytes as BlobPart], { type: 'application/pdf' }), `${baseName(sourceFile.name)}-locked.pdf`);
      pdfPassword.value = '';
      metadataSetStatus('PDF locked with AES-256 encryption. Keep the password safe; it cannot be recovered.', 'good');
    } catch (error) {
      metadataSetStatus(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  // Privacy / metadata -------------------------------------------------------
  const privacyInput = $<HTMLInputElement>('doc-privacy-input');
  const privacyAction = $<HTMLSelectElement>('doc-privacy-action');
  const privacyPattern = $<HTMLInputElement>('doc-privacy-pattern');
  const privacyRun = $<HTMLButtonElement>('doc-privacy-run');
  const privacyClear = $<HTMLButtonElement>('doc-privacy-clear');
  const privacyStatus = $('doc-privacy-status');
  const privacyList = $('doc-privacy-list');
  const privacyZip = $<HTMLButtonElement>('doc-privacy-zip');
  let privacyFiles: File[] = [];
  let privacyOutputs: { name: string; blob: Blob }[] = [];
  let checksums: string[] = [];

  function privacySetStatus(message: string, tone: 'normal' | 'error' | 'good' = 'normal'): void {
    privacyStatus.textContent = message;
    privacyStatus.dataset.tone = tone;
  }

  function renderPrivacy(): void {
    privacyList.replaceChildren();
    privacyFiles.forEach((file, index) => {
      const row = document.createElement('li');
      row.className = 'doc-file-row';
      const name = document.createElement('span');
      name.textContent = file.name;
      const detail = document.createElement('small');
      detail.textContent = `${formatSize(file.size)} · ${file.type || extensionOf(file.name).toUpperCase() || 'file'}`;
      row.append(name, detail);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'doc-file-remove';
      remove.textContent = '×';
      remove.setAttribute('aria-label', `Remove ${file.name}`);
      remove.addEventListener('click', () => {
        privacyFiles.splice(index, 1);
        renderPrivacy();
      });
      row.append(remove);
      privacyList.append(row);
    });
    privacyRun.disabled = !privacyFiles.length;
    privacyClear.disabled = !privacyFiles.length;
    privacyZip.disabled = !privacyOutputs.length && !checksums.length;
  }

  async function stripImage(file: File): Promise<File> {
    const bitmap = await createImageBitmap(file);
    try {
      const canvas = canvasFor(bitmap.width, bitmap.height);
      canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
      const format = file.type === 'image/jpeg' || file.type === 'image/webp' ? file.type : 'image/png';
      const blob = await toBlob(canvas, format);
      const ext = format === 'image/jpeg' ? 'jpg' : format.split('/')[1];
      return new File([blob], `${baseName(file.name)}-clean.${ext}`, { type: format });
    } finally {
      bitmap.close();
    }
  }

  async function stripPdf(file: File): Promise<File> {
    const { stripPdfMetadata } = await import('./pdf-doc');
    const blob = await stripPdfMetadata(file);
    return new File([blob], `${baseName(file.name)}-clean.pdf`, { type: 'application/pdf' });
  }

  async function stripMedia(file: File): Promise<File> {
    const ext = extensionOf(file.name) || 'mp4';
    const mime = file.type || {
      mp4: 'video/mp4',
      m4v: 'video/mp4',
      mov: 'video/quicktime',
      mkv: 'video/x-matroska',
      webm: 'video/webm',
      mp3: 'audio/mpeg',
      m4a: 'audio/mp4',
      aac: 'audio/aac',
      wav: 'audio/wav',
      flac: 'audio/flac',
      ogg: 'audio/ogg',
      opus: 'audio/ogg',
    }[ext] || 'application/octet-stream';
    const out = `clean.${ext}`;
    const args = ['-i', 'input.media', '-map', '0', '-c', 'copy', '-map_metadata', '-1', '-map_chapters', '-1', '-fflags', '+bitexact'];
    if (['mp4', 'm4v', 'mov', 'm4a'].includes(ext)) args.push('-movflags', '+faststart');
    args.push(out);
    const blob = await sharedFfmpeg().run(file, args, out, mime);
    return new File([blob], `${baseName(file.name)}-clean.${ext}`, { type: mime });
  }

  async function stripFile(file: File): Promise<File> {
    if (isPdfFile(file)) return stripPdf(file);
    if (isImageFile(file)) return stripImage(file);
    if (file.type.startsWith('audio/') || file.type.startsWith('video/') || MEDIA_EXTENSIONS.has(extensionOf(file.name))) return stripMedia(file);
    return new File([file], file.name, { type: file.type });
  }

  async function sha256(file: Blob): Promise<string> {
    if (file.size > 512 * 1024 * 1024) throw new Error('Files over 512 MB are skipped for checksums.');
    const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  function renamed(file: File, pattern: string, position: number): string {
    const ext = extensionOf(file.name);
    const proposed = safeName(pattern
      .replaceAll('{name}', baseName(file.name))
      .replaceAll('{index}', String(position + 1).padStart(2, '0')));
    return proposed.toLowerCase().endsWith(`.${ext}`) ? proposed : `${proposed}.${ext}`;
  }

  async function processPrivacy(): Promise<void> {
    if (!privacyFiles.length || busy) return;
    busy = true;
    privacyRun.disabled = true;
    privacySetStatus('Processing locally…');
    const action = privacyAction.value;
    const pattern = privacyPattern.value || '{name}-clean';
    privacyOutputs = [];
    checksums = [];
    const failures: string[] = [];
    try {
      for (const [position, file] of privacyFiles.entries()) {
        privacySetStatus(`Processing ${position + 1} of ${privacyFiles.length} · ${file.name}`);
        try {
          let output = new File([file], file.name, { type: file.type });
          if (action === 'strip' || action === 'all') output = await stripFile(file);
          if (action === 'checksums' || action === 'all') {
            const hash = await sha256(output);
            checksums.push(`${hash}  ${output.name}`);
          }
          if (action === 'rename' || action === 'all' || action === 'strip') {
            const name = action === 'strip' ? output.name : renamed(file, pattern, position);
            output = new File([output], name, { type: output.type });
          }
          privacyOutputs.push({ name: output.name, blob: output });
        } catch (error) {
          failures.push(`${file.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (checksums.length) {
        privacyOutputs.push({ name: 'checksums.txt', blob: new Blob([checksums.join('\n') + '\n'], { type: 'text/plain;charset=utf-8' }) });
      }
      privacySetStatus(
        failures.length
          ? `${privacyOutputs.length ? `${privacyOutputs.length} result${privacyOutputs.length === 1 ? '' : 's'} ready. ` : ''}${failures.length} failed: ${failures.join('; ')}`
          : `Ready: ${privacyFiles.length} file${privacyFiles.length === 1 ? '' : 's'} processed.`,
        failures.length ? 'error' : 'good',
      );
    } finally {
      busy = false;
      renderPrivacy();
      privacyRun.disabled = !privacyFiles.length;
    }
  }

  async function downloadPrivacyZip(): Promise<void> {
    if (!privacyOutputs.length) return;
    try {
      privacySetStatus('Building the ZIP…');
      const zip = await createZip(privacyOutputs);
      options.download(zip, `${new Date().toISOString().slice(0, 10)}-privacy-clean.zip`);
      privacySetStatus(`ZIP ready (${formatSize(zip.size)}).`, 'good');
    } catch (error) {
      privacySetStatus(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  // Events -------------------------------------------------------------------
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    input.value = '';
    if (file) void loadFile(file).catch(() => undefined);
  });
  function addPrivacyFiles(files: File[]): void {
    privacyFiles.push(...files);
    privacyOutputs = [];
    checksums = [];
    renderPrivacy();
    privacySetStatus(`${privacyFiles.length} file${privacyFiles.length === 1 ? '' : 's'} queued.`);
  }

  metadataInput.addEventListener('change', () => {
    const file = metadataInput.files?.[0];
    metadataInput.value = '';
    pdfPassword.value = '';
    if (file) void readMetadata(file);
  });
  metadataViewer.addEventListener('click', () => selectMetadataMode('viewer'));
  metadataRaw.addEventListener('click', () => selectMetadataMode('exiftool'));
  metadataJson.addEventListener('click', () => selectMetadataMode('json'));
  metadataFile.addEventListener('click', () => selectMetadataMode('file'));
  metadataCopy.addEventListener('click', () => {
    if (!metadata) return;
    void navigator.clipboard.writeText(JSON.stringify(metadata.raw, (_key, value) => ArrayBuffer.isView(value) ? `<binary ${value.byteLength} bytes>` : value, 2))
      .then(() => metadataSetStatus('Metadata JSON copied.', 'good'))
      .catch(() => metadataSetStatus('Could not copy automatically.', 'error'));
  });
  metadataDownload.addEventListener('click', downloadMetadata);
  wordView.addEventListener('click', () => void viewWordText());
  metadataRecover.addEventListener('click', () => {
    if (!metadata?.thumbnail) return;
    options.download(metadata.thumbnail, `${baseName(metadata.file.name)}-recovered.jpg`);
    metadataSetStatus('Embedded thumbnail recovered.', 'good');
  });
  imageOptimize.addEventListener('click', () => void imageVariant('optimize'));
  imageInvert.addEventListener('click', () => void imageVariant('invert'));
  imageFlip.addEventListener('click', () => void imageVariant('flip'));
  imageRotate.addEventListener('click', () => void imageVariant('rotate'));
  imageStrip.addEventListener('click', () => {
    if (!metadata || !isImageFile(metadata.file)) return;
    selectTab('privacy');
    addPrivacyFiles([metadata.file]);
  });
  pdfView.addEventListener('click', () => {
    if (!metadata || !isPdfFile(metadata.file)) return;
    selectTab('ocr');
    void loadFile(metadata.file);
  });
  pdfFlatten.addEventListener('click', () => void flattenPdf());
  pdfPages.addEventListener('click', () => void extractPdfPageImages());
  pdfLinks.addEventListener('click', () => void extractPdfPageLinks());
  pdfUnlock.addEventListener('click', () => void unlockPdf());
  pdfLock.addEventListener('click', () => void lockPdf());

  privacyInput.addEventListener('change', () => {
    const files = Array.from(privacyInput.files ?? []);
    privacyInput.value = '';
    addPrivacyFiles(files);
  });

  for (const tab of tabs) {
    tab.addEventListener('click', () => selectTab(tab.dataset.docTab));
  }

  detectButton.addEventListener('click', () => void detectText());
  piiButton.addEventListener('click', selectPii);
  drawButton.addEventListener('click', () => setDrawMode(!drawMode));
  undoButton.addEventListener('click', undoBox);
  clearButton.addEventListener('click', clearBoxes);
  prevButton.addEventListener('click', () => void loadPage(index - 1));
  nextButton.addEventListener('click', () => void loadPage(index + 1));
  pngButton.addEventListener('click', () => void downloadPng());
  pdfButton.addEventListener('click', () => void downloadPdf());
  copyButton.addEventListener('click', () => void copyText());
  textButton.addEventListener('click', downloadText);
  privacyRun.addEventListener('click', () => void processPrivacy());
  privacyClear.addEventListener('click', () => {
    privacyFiles = [];
    privacyOutputs = [];
    checksums = [];
    renderPrivacy();
    privacySetStatus('');
  });
  privacyZip.addEventListener('click', () => void downloadPrivacyZip());

  canvas.addEventListener('pointerdown', (event) => {
    if (!drawMode || !bitmap) return;
    canvas.setPointerCapture(event.pointerId);
    const point = canvasPoint(event);
    drag = { x: point.x, y: point.y, width: 0, height: 0 };
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!drag) return;
    const point = canvasPoint(event);
    drag.width = point.x - drag.x;
    drag.height = point.y - drag.y;
    scheduleOverlay();
  });
  canvas.addEventListener('pointerup', (event) => {
    if (!drag) return;
    canvas.releasePointerCapture(event.pointerId);
    const point = canvasPoint(event);
    const x = Math.min(drag.x, point.x);
    const y = Math.min(drag.y, point.y);
    const width = Math.abs(point.x - drag.x);
    const height = Math.abs(point.y - drag.y);
    drag = null;
    if (width > 3 && height > 3) {
      currentPage()?.boxes.push({ x, y, width, height });
      render();
      updateButtons();
    }
  });

  renderPrivacy();
  renderMetadata();
  updateButtons();

  return {
    activity(): { tone: 'busy' | 'ready' | 'warn'; label: string } | null {
      if (busy) return { tone: 'busy', label: 'Processing documents' };
      if (pages.length) return { tone: 'ready', label: 'Document open' };
      if (privacyFiles.length) return { tone: 'ready', label: 'Document batch open' };
      return null;
    },
    show(): void {
      if (!pages.length) setStatus('Choose an image or PDF to begin.');
    },
    async open(files: File[]): Promise<void> {
      if (!files.length) return;
      if (files.length === 1 && (isImageFile(files[0]) || isPdfFile(files[0]))) {
        selectTab('ocr');
        await loadFile(files[0]);
      } else {
        selectTab('privacy');
        addPrivacyFiles(files);
      }
    },
  };
}
