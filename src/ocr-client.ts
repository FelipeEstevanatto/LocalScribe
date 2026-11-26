/**
 * Page side of the OCR worker. Same calls as `ocr.ts` (loadOcr, runOcr,
 * ocrReady), but inference runs in `ocr-worker.ts`, so a 30-page document no
 * longer blocks the page for about a second per page. Browsers without module
 * workers fall back to running `ocr.ts` in the page.
 */
import type { OcrImage, OcrLine } from './ocr';
import type { OcrWorkerReply, OcrWorkerRequest } from './ocr-worker';

export type { OcrImage, OcrLine } from './ocr';

interface Pending {
  resolve: (lines: OcrLine[] | undefined) => void;
  reject: (error: Error) => void;
  onDownload?: (loaded: number, total: number) => void;
  onProgress?: (fraction: number, text: string) => void;
}

let worker: Worker | null = null;
let ready = false;
let nextId = 0;
const pending = new Map<number, Pending>();

function failAll(error: Error): void {
  for (const request of pending.values()) request.reject(error);
  pending.clear();
}

function ocrWorker(): Worker {
  if (worker) return worker;
  const created = new Worker(new URL('./ocr-worker.ts', import.meta.url), { type: 'module', name: 'ocr' });
  created.onmessage = (event: MessageEvent<OcrWorkerReply>) => {
    const reply = event.data;
    const request = pending.get(reply.id);
    if (!request) return;
    if (reply.type === 'download') request.onDownload?.(reply.loaded, reply.total);
    else if (reply.type === 'progress') request.onProgress?.(reply.fraction, reply.text);
    else {
      pending.delete(reply.id);
      if (reply.type === 'done') request.resolve(reply.lines);
      else {
        const error = new Error(reply.message);
        error.name = reply.name;
        request.reject(error);
      }
    }
  };
  created.onerror = (event) => {
    event.preventDefault();
    created.terminate();
    if (worker === created) worker = null;
    ready = false;
    failAll(new Error(event.message || 'The OCR worker failed.'));
  };
  worker = created;
  return created;
}

function request(
  message: { type: 'load' } | { type: 'run'; image: OcrImage; maxSide?: number },
  signal: AbortSignal | undefined,
  handlers: Pick<Pending, 'onDownload' | 'onProgress'>,
): Promise<OcrLine[] | undefined> {
  signal?.throwIfAborted();
  const target = ocrWorker();
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const onAbort = (): void => target.postMessage({ id, type: 'cancel' } satisfies OcrWorkerRequest);
    signal?.addEventListener('abort', onAbort, { once: true });
    const done = (): void => signal?.removeEventListener('abort', onAbort);
    pending.set(id, {
      ...handlers,
      resolve: (lines) => { done(); resolve(lines); },
      reject: (error) => { done(); reject(signal?.aborted ? signal.reason ?? error : error); },
    });
    target.postMessage({ id, ...message } as OcrWorkerRequest);
  });
}

const inPage = typeof Worker === 'undefined';

export function ocrReady(): boolean {
  return ready;
}

export async function loadOcr(onProgress?: (loaded: number, total: number) => void, signal?: AbortSignal): Promise<void> {
  if (inPage) {
    const ocr = await import('./ocr');
    await ocr.loadOcr(onProgress, signal);
  } else {
    await request({ type: 'load' }, signal, { onDownload: onProgress });
  }
  ready = true;
}

export async function runOcr(
  image: OcrImage,
  options: { maxSide?: number; signal?: AbortSignal; onProgress?: (fraction: number, text: string) => void } = {},
): Promise<OcrLine[]> {
  if (inPage) return (await import('./ocr')).runOcr(image, options);
  // The image is copied, not transferred: callers keep showing it.
  const plain: OcrImage = { data: image.data, width: image.width, height: image.height, channels: image.channels };
  return (await request({ type: 'run', image: plain, maxSide: options.maxSide }, options.signal, { onProgress: options.onProgress })) ?? [];
}
