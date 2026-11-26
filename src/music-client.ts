import { abortError } from './errors';
import type { MusicRequest, MusicResponse } from './music-worker';

type Result = Extract<MusicResponse, { type: 'stems' | 'estimate' | 'downloaded' }>;

export type MusicProgress = Extract<MusicResponse, { type: 'progress' }>;

const IDLE_DISPOSE_MS = 45_000;
let shared: { worker: Worker; busy: boolean; idle: number } | null = null;

function workerInstance(): Worker {
  if (shared) return shared.worker;
  const worker = new Worker(new URL('./music-worker.ts', import.meta.url), { type: 'module' });
  shared = { worker, busy: false, idle: 0 };
  return worker;
}

function dispose(): void {
  if (!shared) return;
  window.clearTimeout(shared.idle);
  shared.worker.terminate();
  shared = null;
}

/**
 * Run one music request. The worker keeps its ONNX session alive between runs
 * for the same model, then releases it after a short idle period so a big
 * separation model does not stay in memory for the rest of the session.
 */
export async function runMusicTool(request: MusicRequest, signal: AbortSignal, onProgress: (progress: MusicProgress) => void): Promise<Result> {
  signal.throwIfAborted();
  if (shared?.busy) throw new Error('The separation engine is already running.');
  const worker = workerInstance();
  if (!shared) throw new Error('Could not start the separation engine.');
  window.clearTimeout(shared.idle);
  shared.busy = true;
  let cancel: (() => void) | undefined;
  try {
    return await new Promise<Result>((resolve, reject) => {
      cancel = () => {
        dispose();
        reject(abortError());
      };
      signal.addEventListener('abort', cancel, { once: true });
      worker.onmessage = ({ data }: MessageEvent<MusicResponse>) => {
        if (data.type === 'progress') onProgress(data);
        else if (data.type === 'error') reject(new Error(data.message));
        else resolve(data);
      };
      worker.onerror = (error) => {
        error.preventDefault();
        dispose();
        reject(new Error(error.message || 'The music worker stopped.'));
      };
      worker.onmessageerror = () => reject(new Error('The music worker returned an unreadable result.'));
      worker.postMessage(request);
    });
  } finally {
    if (cancel) signal.removeEventListener('abort', cancel);
    if (shared?.busy) {
      shared.busy = false;
      shared.idle = window.setTimeout(dispose, IDLE_DISPOSE_MS);
    }
  }
}
