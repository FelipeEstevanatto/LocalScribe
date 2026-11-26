/**
 * Kokoro off the main thread. kokoro-js (transformers.js + ONNX Runtime)
 * blocked the page for the whole generation, about 9 s per 100 characters on
 * WASM. The page side (`KokoroEngine` in tts.ts) sends one sentence at a time.
 */
import kokoroFactoryUrl from '../node_modules/kokoro-js/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs?url';
import kokoroWasmUrl from '../node_modules/kokoro-js/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm?url';
import kokoroJsepFactoryUrl from '../node_modules/kokoro-js/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs?url';
import kokoroJsepWasmUrl from '../node_modules/kokoro-js/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm?url';

export type KokoroWorkerRequest =
  | { id: number; type: 'load'; model: string; device: 'wasm' | 'webgpu'; dtype: string }
  | { id: number; type: 'generate'; text: string; voice: string; speed: number }
  | { id: number; type: 'dispose' };

export type KokoroWorkerReply =
  | { id: number; type: 'download'; file: string; status: string; loaded: number; total: number }
  | { id: number; type: 'done'; audio?: Float32Array; sampleRate?: number }
  | { id: number; type: 'error'; name: string; message: string };

interface KokoroTts {
  model: { dispose: () => Promise<void> };
  generate: (text: string, options: { voice: string; speed: number }) => Promise<{ audio: Float32Array; sampling_rate: number }>;
}

type KokoroModule = {
  KokoroTTS: {
    from_pretrained: (model: string, options: {
      dtype: string;
      device: string;
      progress_callback?: (event: { status?: string; file?: string; loaded?: number; total?: number }) => void;
    }) => Promise<KokoroTts>;
  };
  env: { wasmPaths: unknown };
};

const scope = self as unknown as {
  postMessage: (message: KokoroWorkerReply, transfer?: Transferable[]) => void;
  onmessage: ((event: MessageEvent<KokoroWorkerRequest>) => void) | null;
};

let tts: KokoroTts | null = null;
// Messages are handled one after another so a generate never races a load.
let queue: Promise<void> = Promise.resolve();

async function handle(message: KokoroWorkerRequest): Promise<void> {
  const { id } = message;
  try {
    if (message.type === 'load') {
      if (!tts) {
        const module = (await import('kokoro-js')) as unknown as KokoroModule;
        module.env.wasmPaths = message.device === 'webgpu'
          ? { wasm: kokoroJsepWasmUrl, mjs: kokoroJsepFactoryUrl }
          : { wasm: kokoroWasmUrl, mjs: kokoroFactoryUrl };
        tts = await module.KokoroTTS.from_pretrained(message.model, {
          dtype: message.dtype,
          device: message.device,
          progress_callback: (event) => {
            if (event.status !== 'progress' && event.status !== 'done') return;
            scope.postMessage({
              id, type: 'download', status: event.status, file: event.file ?? 'Kokoro model',
              loaded: Number(event.loaded) || 0, total: Number(event.total) || 0,
            });
          },
        });
      }
      scope.postMessage({ id, type: 'done' });
    } else if (message.type === 'generate') {
      if (!tts) throw new Error('The Kokoro model is not loaded yet.');
      const result = await tts.generate(message.text, { voice: message.voice, speed: message.speed });
      const audio = result.audio;
      scope.postMessage({ id, type: 'done', audio, sampleRate: result.sampling_rate }, [audio.buffer]);
    } else {
      const loaded = tts;
      tts = null;
      await loaded?.model.dispose().catch(() => undefined);
      scope.postMessage({ id, type: 'done' });
    }
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    scope.postMessage({ id, type: 'error', name: failure.name, message: failure.message });
  }
}

scope.onmessage = (event) => {
  const message = event.data;
  queue = queue.then(() => handle(message));
};
