/**
 * Shared ONNX Runtime Web loader.
 *
 * The WebGPU build is about twice the size of the CPU/WASM build, so CPU-only
 * sessions load `onnxruntime-web/wasm` instead of `onnxruntime-web/webgpu`.
 * Both exports expose the same API. Once a module has been imported, later
 * callers reuse it, which lets STT and tiny-voca share one runtime.
 */

export type OrtModule = typeof import('onnxruntime-web');
export type OrtBackend = 'wasm' | 'webgpu';

const modules = new Map<OrtBackend, Promise<OrtModule>>();
const configured = new WeakSet<object>();

function configure(ort: OrtModule): void {
  if (configured.has(ort)) return;

  // Multi-threaded WASM needs SharedArrayBuffer, which in turn needs a
  // cross-origin-isolated page (COOP + COEP). Without isolation ORT must stay
  // single-threaded, otherwise session creation fails on the main thread.
  const isolated =
    typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;
  const cores =
    typeof navigator !== 'undefined' && navigator.hardwareConcurrency > 0
      ? navigator.hardwareConcurrency
      : 1;
  ort.env.wasm.numThreads = isolated ? Math.max(1, Math.min(8, cores)) : 1;
  ort.env.wasm.simd = true;
  ort.env.logLevel = 'error';

  const env = ort.env as unknown as {
    webgpu?: { powerPreference?: 'low-power' | 'high-performance' };
  };
  // Chrome ignores this on Windows and logs a warning on every adapter
  // request. Leave the browser default there; keep the hint elsewhere.
  const windows = typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent);
  if (env.webgpu && !windows) env.webgpu.powerPreference = 'high-performance';

  configured.add(ort);
}

export async function getOrt(backend: OrtBackend): Promise<OrtModule> {
  let promise = modules.get(backend);

  if (!promise) {
    const loader =
      backend === 'webgpu'
        ? import('onnxruntime-web/webgpu')
        : import('onnxruntime-web/wasm');

    promise = (loader as Promise<OrtModule>).catch((error) => {
      // Do not poison later attempts if a transient chunk request failed.
      modules.delete(backend);
      throw error;
    });
    modules.set(backend, promise);
  }

  const ort = await promise;
  configure(ort);
  return ort;
}

/**
 * Reuse whichever runtime is already loaded. tiny-voca only needs the WASM
 * backend, but if STT already fetched the WebGPU build there is no reason to
 * download the smaller CPU build as well.
 */
export async function getOrtForTts(): Promise<OrtModule> {
  if (modules.has('webgpu')) return getOrt('webgpu');
  return getOrt('wasm');
}
