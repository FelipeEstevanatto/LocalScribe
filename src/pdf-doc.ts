/**
 * PDF rendering and creation kept in a lazy chunk.
 *
 * PDF pages are rasterized to PNG blobs so the editor only keeps one decoded
 * bitmap alive at a time. Redacted output is rebuilt from the edited pages,
 * which also drops the original text layer and metadata.
 */

// @cantoo/pdf-lib (a pdf-lib fork with encryption) is the one PDF writer;
// Document studio already needs it for protect/unlock.
import { PDFDocument } from '@cantoo/pdf-lib';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export async function openPdf(file: Blob) {
  return pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
}

export interface PdfPageImage {
  blob: Blob;
  width: number;
  height: number;
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Could not encode the PDF page.')), 'image/png');
  });
}

export async function renderPdfPage(
  file: Blob,
  number: number,
  maxSide = 1800,
): Promise<PdfPageImage> {
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  const pdfDocument = await loadingTask.promise;
  try {
    const page = await pdfDocument.getPage(number);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(2.4, maxSide / Math.max(base.width, base.height));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(viewport.width));
    canvas.height = Math.max(1, Math.round(viewport.height));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not create a PDF page canvas.');
    await page.render({ canvas, canvasContext: context, viewport }).promise;
    const image = { blob: await canvasBlob(canvas), width: canvas.width, height: canvas.height };
    page.cleanup();
    return image;
  } finally {
    await loadingTask.destroy();
  }
}

export async function renderPdfPages(
  file: Blob,
  options: {
    maxPages?: number;
    maxSide?: number;
    signal?: AbortSignal;
    firstPageOnly?: boolean;
    /** Called with the document's real page count, which may exceed maxPages. */
    onPageCount?: (count: number) => void;
  } = {},
): Promise<PdfPageImage[]> {
  const maxPages = Math.max(1, Math.min(60, options.maxPages ?? 30));
  const maxSide = Math.max(600, options.maxSide ?? 1800);
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  const pdfDocument = await loadingTask.promise;
  const pages: PdfPageImage[] = [];
  try {
    options.onPageCount?.(pdfDocument.numPages);
    const count = Math.min(pdfDocument.numPages, maxPages);
    const renderCount = options.firstPageOnly ? 1 : count;
    for (let number = 1; number <= renderCount; number += 1) {
      options.signal?.throwIfAborted();
      const page = await pdfDocument.getPage(number);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(2.4, maxSide / Math.max(base.width, base.height));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(viewport.width));
      canvas.height = Math.max(1, Math.round(viewport.height));
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Could not create a PDF page canvas.');
      await page.render({ canvas, canvasContext: context, viewport }).promise;
      pages.push({ blob: await canvasBlob(canvas), width: canvas.width, height: canvas.height });
      page.cleanup();
    }
    // Placeholders keep the page count stable; document-studio renders them
    // on demand when the user navigates to or exports those pages.
    for (let number = renderCount + 1; number <= count; number += 1) {
      pages.push({ blob: new Blob(), width: 0, height: 0 });
    }
  } finally {
    await loadingTask.destroy();
  }
  return pages;
}

export interface PdfMetadataResult {
  pageCount: number;
  pdfVersion: string;
  info: Record<string, unknown>;
  fingerprints: string[];
  xmp: Record<string, string | string[]>;
  xmpRaw: string;
  metadataStream: boolean;
  encrypted: boolean;
  xmpToolkit: string;
  preview: Blob | null;
}

function xmpValue(value: unknown): string | string[] {
  if (Array.isArray(value)) return value.map((entry) => String(entry));
  if (value && typeof value === 'object') return JSON.stringify(value);
  return String(value ?? '');
}

export async function readPdfMetadata(
  file: Blob,
  options: { preview?: boolean } = {},
): Promise<PdfMetadataResult> {
  const data = new Uint8Array(await file.arrayBuffer());
  // PDF.js transfers the byte array to its worker, so read the header first.
  const header = new TextDecoder('latin1').decode(data.slice(0, 16));
  const loadingTask = pdfjs.getDocument({ data });
  const pdfDocument = await loadingTask.promise;
  try {
    const metadata = await pdfDocument.getMetadata();
    const info = (metadata.info ?? {}) as Record<string, unknown>;
    const xmp: Record<string, string | string[]> = {};
    let xmpRaw = '';
    if (metadata.metadata) {
      try {
        xmpRaw = String(metadata.metadata.getRaw() ?? '');
      } catch {
        xmpRaw = '';
      }
      for (const [key, value] of metadata.metadata as unknown as Iterable<[string, unknown]>) {
        xmp[key] = xmpValue(value);
      }
    }
    const versionMatch = /^%PDF-(\d+\.\d+)/.exec(header);
    const xmpToolkit = /x:xmptk="([^"]+)"/i.exec(xmpRaw)?.[1] ?? '';
    let preview: Blob | null = null;
    if (options.preview && pdfDocument.numPages > 0) {
      try {
        const page = await pdfDocument.getPage(1);
        const base = page.getViewport({ scale: 1 });
        const scale = Math.min(2.4, 640 / Math.max(base.width, base.height));
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(viewport.width));
        canvas.height = Math.max(1, Math.round(viewport.height));
        const context = canvas.getContext('2d');
        if (context) {
          await page.render({ canvas, canvasContext: context, viewport }).promise;
          preview = await canvasBlob(canvas);
        }
        page.cleanup();
      } catch {
        preview = null;
      }
    }
    return {
      pageCount: pdfDocument.numPages,
      pdfVersion: String(info.PDFFormatVersion ?? versionMatch?.[1] ?? ''),
      info,
      fingerprints: pdfDocument.fingerprints.filter((value): value is string => Boolean(value)),
      xmp,
      xmpRaw,
      metadataStream: Boolean(metadata.metadata) || xmpRaw.length > 0,
      encrypted: info.EncryptFilterName != null || info.Encrypted === true,
      xmpToolkit,
      preview,
    };
  } finally {
    await loadingTask.destroy();
  }
}

export interface PdfLink {
  page: number;
  url: string;
  title: string;
}

export async function extractPdfLinks(file: Blob): Promise<PdfLink[]> {
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  const pdfDocument = await loadingTask.promise;
  const links: PdfLink[] = [];
  try {
    for (let number = 1; number <= pdfDocument.numPages; number += 1) {
      const page = await pdfDocument.getPage(number);
      const annotations = await page.getAnnotations();
      for (const annotation of annotations) {
        const link = annotation as { subtype?: string; url?: string; unsafeUrl?: string; title?: string };
        if (link.subtype !== 'Link') continue;
        const url = link.url ?? link.unsafeUrl ?? '';
        if (!/^(https?:|mailto:)/i.test(url)) continue;
        links.push({ page: number, url, title: link.title ?? '' });
      }
      page.cleanup();
    }
  } finally {
    await loadingTask.destroy();
  }
  return links;
}

/** One page per image. JPEG pages are embedded as JPEG, everything else as PNG. */
export async function imagesToPdf(pages: PdfPageImage[]): Promise<Blob> {
  const document = await PDFDocument.create();
  document.setTitle('');
  document.setAuthor('');
  document.setSubject('');
  document.setKeywords([]);
  document.setProducer('LocalScribe');
  document.setCreator('LocalScribe');
  for (const page of pages) {
    const bytes = await page.blob.arrayBuffer();
    const image = page.blob.type === 'image/jpeg' ? await document.embedJpg(bytes) : await document.embedPng(bytes);
    const output = document.addPage([page.width, page.height]);
    output.drawImage(image, { x: 0, y: 0, width: page.width, height: page.height });
  }
  const bytes = await document.save({ useObjectStreams: false });
  return new Blob([bytes as unknown as BlobPart], { type: 'application/pdf' });
}

export async function stripPdfMetadata(file: Blob): Promise<Blob> {
  const document = await PDFDocument.load(await file.arrayBuffer());
  document.setTitle('');
  document.setAuthor('');
  document.setSubject('');
  document.setKeywords([]);
  document.setProducer('LocalScribe');
  document.setCreator('LocalScribe');
  const bytes = await document.save({ useObjectStreams: false });
  return new Blob([bytes as unknown as BlobPart], { type: 'application/pdf' });
}
