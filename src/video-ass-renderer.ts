import JASSUB from 'jassub';
import workerUrl from 'jassub/dist/worker/worker.js?worker&url';
import wasmUrl from 'jassub/dist/wasm/jassub-worker.wasm?url';
import wasmWorkerUrl from 'jassub/dist/wasm/jassub-worker.js?url';
import modernWasmUrl from 'jassub/dist/wasm/jassub-worker-modern.wasm?url';
import modernWasmWorkerUrl from 'jassub/dist/wasm/jassub-worker-modern.js?url';
import fallbackFont from 'jassub/dist/default.woff2?url';
import { assEventSpans, assScriptWithEdits, type AssTrack } from './ass-subtitles';
import { readMatroskaFonts } from './matroska-subtitles';

const fontCache = new WeakMap<Blob, Promise<Uint8Array[]>>();

export function createAssSurface(canvas: HTMLCanvasElement, track: AssTrack) {
  const script = assScriptWithEdits(track);
  const events = assEventSpans(script);
  let fonts = fontCache.get(track.file);
  if (!fonts) {
    fonts = readMatroskaFonts(track.file).catch(() => []);
    fontCache.set(track.file, fonts);
  }
  let disposed = false;
  let instance: JASSUB | null = null;
  const ready = fonts.then(async (embeddedFonts) => {
    if (disposed) return;
    instance = new JASSUB({
      canvas, subContent: script, fonts: [...embeddedFonts, fallbackFont],
      availableFonts: { 'liberation sans': fallbackFont },
      queryFonts: false, workerUrl, wasmUrl, wasmWorkerUrl, modernWasmUrl, modernWasmWorkerUrl,
    });
    await instance.ready;
  });
  let size = '';
  return {
    ready,
    async paint(time: number, width: number, height: number): Promise<void> {
      await ready;
      if (disposed || !instance) return;
      await instance.manualRender({ mediaTime: time, width, height, expectedDisplayTime: performance.now() });
    },
    async draw(ctx: OffscreenCanvasRenderingContext2D, time: number, width: number, height: number): Promise<void> {
      if (!events.some((cue) => cue.start <= time && time < cue.end)) return;
      await ready;
      if (disposed || !instance) return;
      const key = width + 'x' + height;
      if (size !== key) {
        await instance.resize(false, width, height);
        size = key;
      }
      // JASSUB's worker capture makes the just-rendered frame available before
      // the browser commits the worker canvas to the page.
      const frame = await instance.renderer._drawCapture(time);
      if (!frame) return;
      const bitmap = await createImageBitmap(new ImageData(new Uint8ClampedArray(frame.data), frame.width, frame.height));
      try { ctx.drawImage(bitmap, 0, 0, width, height); }
      finally { bitmap.close(); }
    },
    dispose(): void {
      disposed = true;
      if (instance) void instance.destroy().catch(() => undefined);
      else canvas.remove();
    },
  };
}
