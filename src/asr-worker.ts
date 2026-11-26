import { errorMessage } from './errors';
import { AsrEngine } from './model';
import type { AsrRequest, AsrResponse } from './asr-client';

const worker = self as unknown as Worker;
let engine: AsrEngine | undefined;
let queue: Promise<void> = Promise.resolve();
const controllers = new Map<number, AbortController>();

function post(message: AsrResponse): void {
  worker.postMessage(message);
}

async function load(options: Extract<AsrRequest, { type: 'load' }>['options']): Promise<void> {
  engine = new AsrEngine({
    ...options,
    onProgress: (progress) => post({ type: 'loadProgress', progress }),
    onWarning: (message) => post({ type: 'warning', message }),
  });
  await engine.load();
  // Move WebGPU shader/kernel compilation into the load step so the first
  // real chunk does not pay for it. Warmup is best effort.
  if (engine.backend === 'webgpu') {
    await engine.warmup().catch(() => undefined);
  }
  post({ type: 'loaded', backend: engine.backend });
}

async function transcribe(
  request: Extract<AsrRequest, { type: 'transcribe' }>,
  controller: AbortController,
): Promise<void> {
  try {
    if (controller.signal.aborted) throw new DOMException('Transcription cancelled.', 'AbortError');
    if (!engine) throw new Error('Load a speech model before transcribing.');
    const result = await engine.transcribe(request.samples, {
      signal: controller.signal,
      onProgress: (progress) => post({ type: 'transcribeProgress', id: request.id, progress }),
      onPartial: (text) => post({ type: 'partial', id: request.id, text }),
    });
    post({ type: 'result', id: request.id, result });
  } catch (error) {
    const details = error as { code?: string; hint?: string } | null;
    post({
      type: 'error',
      id: request.id,
      message: errorMessage(error),
      code: details?.code,
      hint: details?.hint,
    });
  } finally {
    controllers.delete(request.id);
  }
}

worker.onmessage = ({ data }: MessageEvent<AsrRequest>) => {
  if (data.type === 'cancel') {
    controllers.get(data.id)?.abort();
    return;
  }
  if (data.type === 'load') {
    queue = queue
      .then(() => load(data.options))
      .catch((error) => {
        const details = error as { code?: string; hint?: string } | null;
        post({ type: 'error', message: errorMessage(error), code: details?.code, hint: details?.hint });
      });
    return;
  }
  const controller = new AbortController();
  controllers.set(data.id, controller);
  queue = queue.then(() => transcribe(data, controller));
};
