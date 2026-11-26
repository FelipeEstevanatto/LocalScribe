/**
 * Vision inference off the main thread. BiRefNet on WASM blocked the page for
 * 3 to 4 s per image; here the page only posts the decoded pixels and draws
 * what comes back. `vision.ts` is the page side.
 */
import { RawImage } from '@huggingface/transformers';
import { loadedVisionModels, preloadVisionModel, runOnce, type VisionSelection } from './vision-run';
import type { SelectPoint, VisionProgress, VisionResult } from './vision';

export interface PlainImage {
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
  channels: 1 | 2 | 3 | 4;
}

export type VisionWorkerSelection = Omit<VisionSelection, 'onProgress'>;

export type VisionWorkerRequest =
  | { id: number; type: 'load'; selection: VisionWorkerSelection }
  | {
    id: number;
    type: 'run';
    selection: VisionWorkerSelection;
    image: PlainImage;
    /** Same number for the same source image, so SAM encodes it once. */
    imageKey: number;
    threshold?: number;
    topK?: number;
    points?: SelectPoint[];
  };

/** VisionResult with every RawImage replaced by its plain pixels. */
export type PackedVisionResult = unknown;

export type VisionWorkerReply =
  | { id: number; type: 'progress'; progress: VisionProgress }
  | { id: number; type: 'done'; result?: PackedVisionResult; loaded: string[] }
  | { id: number; type: 'error'; name: string; message: string; loaded: string[] };

const scope = self as unknown as {
  postMessage: (message: VisionWorkerReply, transfer?: Transferable[]) => void;
  onmessage: ((event: MessageEvent<VisionWorkerRequest>) => void) | null;
};

let lastImage: { key: number; raw: RawImage } | null = null;

function plain(image: RawImage, transfer: Transferable[]): PlainImage & { rawImage: true } {
  const data = image.data as Uint8Array | Uint8ClampedArray;
  if (data.buffer instanceof ArrayBuffer && !transfer.includes(data.buffer)) transfer.push(data.buffer);
  return { rawImage: true, data, width: image.width, height: image.height, channels: image.channels };
}

function pack(result: VisionResult, transfer: Transferable[]): PackedVisionResult {
  switch (result.kind) {
    case 'image': return { ...result, image: plain(result.image, transfer) };
    case 'depth': return { ...result, image: plain(result.image, transfer) };
    case 'mask': return { ...result, items: result.items.map((item) => ({ ...item, mask: plain(item.mask, transfer) })) };
    case 'select': {
      const packed = { ...result, cutout: plain(result.cutout, transfer) };
      if (result.mask.buffer instanceof ArrayBuffer && !transfer.includes(result.mask.buffer)) transfer.push(result.mask.buffer);
      return packed;
    }
    default: return result;
  }
}

// One job at a time: sessions are not re-entrant, and the page waits anyway.
let queue: Promise<void> = Promise.resolve();

async function handle(message: VisionWorkerRequest): Promise<void> {
  const { id } = message;
  const onProgress = (progress: VisionProgress): void => scope.postMessage({ id, type: 'progress', progress });
  try {
    if (message.type === 'load') {
      await preloadVisionModel({ ...message.selection, onProgress });
      scope.postMessage({ id, type: 'done', loaded: loadedVisionModels() });
      return;
    }
    const { image } = message;
    const raw = lastImage?.key === message.imageKey
      ? lastImage.raw
      : new RawImage(image.data, image.width, image.height, image.channels);
    lastImage = { key: message.imageKey, raw };
    const result = await runOnce({
      ...message.selection,
      onProgress,
      image: raw,
      threshold: message.threshold,
      topK: message.topK,
      points: message.points,
    });
    const transfer: Transferable[] = [];
    const packed = pack(result, transfer);
    scope.postMessage({ id, type: 'done', result: packed, loaded: loadedVisionModels() }, transfer);
  } catch (error) {
    // ONNX Runtime can throw bare numbers (a WASM pointer); the page shows its
    // generic message for those, as it did when inference ran there.
    const name = error instanceof Error ? error.name : 'Error';
    const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
    scope.postMessage({ id, type: 'error', name, message, loaded: loadedVisionModels() });
  }
}

scope.onmessage = (event) => {
  const message = event.data;
  queue = queue.then(() => handle(message));
};
