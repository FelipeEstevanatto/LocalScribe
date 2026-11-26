/**
 * PP-OCR off the main thread. Owns the detection and recognition sessions;
 * `ocr-client.ts` is the page side. One request runs at a time per message,
 * and a "cancel" message aborts the matching request between model calls.
 */
import { loadOcr, runOcr, type OcrImage, type OcrLine } from './ocr';

export type OcrWorkerRequest =
  | { id: number; type: 'load' }
  | { id: number; type: 'run'; image: OcrImage; maxSide?: number }
  | { id: number; type: 'cancel' };

export type OcrWorkerReply =
  | { id: number; type: 'download'; loaded: number; total: number }
  | { id: number; type: 'progress'; fraction: number; text: string }
  | { id: number; type: 'done'; lines?: OcrLine[] }
  | { id: number; type: 'error'; name: string; message: string };

const scope = self as unknown as { postMessage: (message: OcrWorkerReply) => void; onmessage: ((event: MessageEvent<OcrWorkerRequest>) => void) | null };
const controllers = new Map<number, AbortController>();

scope.onmessage = async (event) => {
  const message = event.data;
  if (message.type === 'cancel') {
    controllers.get(message.id)?.abort();
    return;
  }
  const { id } = message;
  const controller = new AbortController();
  controllers.set(id, controller);
  try {
    if (message.type === 'load') {
      await loadOcr((loaded, total) => scope.postMessage({ id, type: 'download', loaded, total }), controller.signal);
      scope.postMessage({ id, type: 'done' });
    } else {
      const lines = await runOcr(message.image, {
        maxSide: message.maxSide,
        signal: controller.signal,
        onProgress: (fraction, text) => scope.postMessage({ id, type: 'progress', fraction, text }),
      });
      scope.postMessage({ id, type: 'done', lines });
    }
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    scope.postMessage({ id, type: 'error', name: failure.name, message: failure.message });
  } finally {
    controllers.delete(id);
  }
};
