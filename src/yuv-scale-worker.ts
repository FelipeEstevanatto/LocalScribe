/** Scales copied I420 or NV12 planes to I420 off the page thread (see yuv-frames.ts). */
import { planesToI420, type YuvPlanes } from './yuv-frames';

const scope = self as unknown as {
  postMessage: (message: { id: number; out?: Uint8Array; error?: string }, transfer?: Transferable[]) => void;
  onmessage: ((event: MessageEvent<{ id: number; planes: YuvPlanes; width: number; height: number }>) => void) | null;
};

scope.onmessage = (event) => {
  const { id, planes, width, height } = event.data;
  try {
    const out = planesToI420(planes, width, height);
    scope.postMessage({ id, out }, [out.buffer]);
  } catch (error) {
    scope.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
