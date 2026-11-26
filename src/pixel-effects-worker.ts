/** One band of rows of the export pixel pass; see pixel-effects-pool.ts. */
import { runPixelPass, type PixelPass } from './pixel-effects-kernel';

export interface PixelWorkerRequest {
  id: number;
  data: Uint8ClampedArray;
  pass: Omit<PixelPass, 'lut'>;
  /** LUT cache key; `lut` is sent only the first time a worker needs it. */
  lutKey: string | null;
  lut?: Float64Array;
}

export interface PixelWorkerReply {
  id: number;
  data?: Uint8ClampedArray;
  error?: string;
}

const scope = self as unknown as {
  postMessage: (message: PixelWorkerReply, transfer?: Transferable[]) => void;
  onmessage: ((event: MessageEvent<PixelWorkerRequest>) => void) | null;
};

const luts = new Map<string, Float64Array>();

scope.onmessage = (event) => {
  const { id, data, pass, lutKey, lut } = event.data;
  try {
    let values: Float64Array | null = null;
    if (lutKey) {
      if (lut) {
        if (luts.size >= 4) luts.delete(luts.keys().next().value as string);
        luts.set(lutKey, lut);
      }
      values = luts.get(lutKey) ?? null;
      if (!values) throw new Error('missing-lut');
    }
    runPixelPass(data, { ...pass, lut: values });
    scope.postMessage({ id, data }, [data.buffer]);
  } catch (error) {
    scope.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
