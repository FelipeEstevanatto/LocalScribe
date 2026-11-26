/**
 * Vision & image tools.
 *
 * Every task runs through Transformers.js in a worker (vision-worker.ts):
 * ONNX Runtime Web on WebGPU where an adapter exists, WASM otherwise. Images are decoded locally
 * and never uploaded. Models are downloaded from Hugging Face on first use and
 * cached by the browser.
 */

import type { RawImage } from '@huggingface/transformers';
import type { PlainImage, VisionWorkerReply, VisionWorkerRequest, VisionWorkerSelection } from './vision-worker';
import type { OcrLine } from './ocr';
import type { MirageScene } from './cactus';

const MODNET_MODEL = 'Xenova/modnet';
const RMBG_MODEL = 'briaai/RMBG-1.4';
const BIREFNET_MODEL = 'studioludens/birefnet-lite-512';
// onnx-community/dfine_n_coco-ONNX returns duplicate, mislabelled boxes;
// this conversion matches the reference model.
const DFINE_MODEL = 'onnx-community/dfine-nano-coco-ONNX';
const SAM3_MODEL = 'onnx-community/sam3-tracker-ONNX';

export type VisionTaskId =
  | 'background-removal'
  | 'depth-estimation'
  | 'object-detection'
  | 'image-segmentation'
  | 'image-classification'
  | 'image-to-text'
  | 'ocr'
  | 'select-object'
  | 'describe-scene';

export type VisionDevice = 'webgpu' | 'wasm';
export type VisionPrecision = 'fp32' | 'fp16' | 'q8';

export interface VisionModelOption {
  id: string;
  revision?: string;
  label: string;
  note: string;
  approxBytes: number;
  /** Size of the FP16 build; omit when the repository has none. */
  halfBytes?: number;
  /** Size of the 8-bit build; omit when the repository has none. */
  compactBytes?: number;
  /** Precision chosen until the user picks another. Defaults to FP32. */
  defaultPrecision?: VisionPrecision;
}

/** A click on the image: positive keeps that area, negative removes it. */
export interface SelectPoint {
  x: number;
  y: number;
  positive: boolean;
}

export interface VisionTaskDefinition {
  id: VisionTaskId;
  title: string;
  short: string;
  description: string;
  output: 'image' | 'depth' | 'boxes' | 'mask' | 'labels' | 'text' | 'ocr' | 'select' | 'scene';
  models: VisionModelOption[];
  defaultModel: string;
}

export const VISION_TASKS: VisionTaskDefinition[] = [
  {
    id: 'background-removal',
    title: 'Background removal',
    short: 'Remove background',
    description:
      'Cuts out the main subject as a transparent PNG.',
    output: 'image',
    defaultModel: BIREFNET_MODEL,
    models: [
      {
        id: BIREFNET_MODEL,
        revision: '962e67969ec6acec9c19fab76acee4f5e22e990c',
        label: 'BiRefNet-lite 512',
        note: 'Sharp, detailed mattes for hair, fur, and fine edges at 512 × 512. MIT licensed.',
        approxBytes: 191_900_000,
        halfBytes: 98_500_000,
        defaultPrecision: 'fp16',
      },
      {
        id: RMBG_MODEL,
        revision: 'da1d078376e6691105a5530a374a010627fc60b5',
        label: 'RMBG 1.4',
        note: 'General foreground removal for objects, animals, and people. The weights are licensed for non-commercial use.',
        approxBytes: 176_153_355,
        halfBytes: 88_217_533,
        compactBytes: 44_403_226,
      },
      {
        id: MODNET_MODEL,
        label: 'MODNet',
        note: 'Portrait matting for people and headshots.',
        approxBytes: 25_888_640,
        halfBytes: 12_984_781,
        compactBytes: 6_632_188,
      },
    ],
  },
  {
    id: 'depth-estimation',
    title: 'Depth estimation',
    short: 'Depth map',
    description:
      'Estimates a depth map from a single image. Near surfaces are bright, far surfaces are dark.',
    output: 'depth',
    defaultModel: 'onnx-community/depth-anything-v2-small',
    models: [
      {
        id: 'onnx-community/depth-anything-v2-small',
        label: 'Depth Anything V2 Small',
        note: 'Fast monocular depth, good default.',
        approxBytes: 99_060_839,
        halfBytes: 49_642_442,
        compactBytes: 27_258_801,
      },
    ],
  },
  {
    id: 'object-detection',
    title: 'Object detection',
    short: 'Detect objects',
    description:
      'Finds common objects and draws labelled boxes with confidence scores.',
    output: 'boxes',
    defaultModel: DFINE_MODEL,
    models: [
      {
        id: DFINE_MODEL,
        revision: '89df95b0e8575ff9879f13351bafe69bbe8e6823',
        label: 'D-FINE Nano',
        note: 'Real-time COCO detector, 42.8 AP: more accurate than YOLOS Tiny at a fraction of the size. Apache 2.0.',
        approxBytes: 15_434_994,
        compactBytes: 4_807_354,
        defaultPrecision: 'q8',
      },
      {
        id: 'Xenova/yolos-tiny',
        label: 'YOLOS Tiny',
        note: 'Small COCO detector, fastest.',
        approxBytes: 26_227_993,
        halfBytes: 13_341_636,
        compactBytes: 9_661_148,
      },
      {
        id: 'Xenova/detr-resnet-50',
        label: 'DETR ResNet-50',
        note: 'Larger COCO detector with stronger recall.',
        approxBytes: 166_789_212,
        halfBytes: 83_812_437,
        compactBytes: 43_102_531,
      },
    ],
  },
  {
    id: 'image-segmentation',
    title: 'Image segmentation',
    short: 'Segment image',
    description:
      'Colours every pixel by category. The fashion model labels clothes and accessories.',
    output: 'mask',
    defaultModel: 'Xenova/segformer_b0_clothes',
    models: [
      {
        id: 'Xenova/segformer_b0_clothes',
        label: 'SegFormer B0 Clothes',
        note: '18 clothing and accessory categories.',
        approxBytes: 15_199_746,
        halfBytes: 7_871_842,
        compactBytes: 4_384_537,
      },
      {
        id: 'onnx-community/segformer-b3-finetuned-ade-512-512-ONNX',
        label: 'SegFormer B3 ADE20K',
        note: '150 indoor and outdoor scene categories.',
        approxBytes: 190_133_539,
        halfBytes: 95_757_970,
        compactBytes: 49_297_337,
      },
    ],
  },
  {
    id: 'image-classification',
    title: 'Image classification',
    short: 'Classify',
    description:
      'Returns the top ImageNet labels for an image with confidence scores.',
    output: 'labels',
    defaultModel: 'onnx-community/mobilenetv4_conv_small.e2400_r224_in1k',
    models: [
      {
        id: 'onnx-community/mobilenetv4_conv_small.e2400_r224_in1k',
        label: 'MobileNetV4 Small',
        note: 'Modern mobile classifier, fast.',
        approxBytes: 15_086_122,
        halfBytes: 7_563_434,
        compactBytes: 3_931_745,
      },
      {
        id: 'Xenova/vit-base-patch16-224',
        label: 'ViT Base',
        note: 'Classic Vision Transformer classifier.',
        approxBytes: 346_533_752,
        halfBytes: 173_484_848,
        compactBytes: 88_257_413,
      },
    ],
  },
  {
    id: 'select-object',
    title: 'Click to select (SAM 3)',
    short: 'Click to select',
    description:
      'Click any object to cut it out. Shift-click or right-click to remove an area. The image is encoded once, so each extra click takes a fraction of a second.',
    output: 'select',
    defaultModel: SAM3_MODEL,
    models: [
      {
        id: SAM3_MODEL,
        revision: '429305c8a5b3de597243d919a07e4e6bdcd00ef7',
        label: 'SAM 3 tracker',
        note: 'Meta Segment Anything 3, 4-bit. The weights use the SAM License, which allows commercial use with conditions.',
        // 4-bit weights; the half-precision build keeps activations in FP16.
        approxBytes: 378_745_432,
        halfBytes: 302_295_094,
        defaultPrecision: 'fp16',
      },
    ],
  },
  {
    id: 'ocr',
    title: 'Read text (OCR)',
    short: 'Read text',
    description:
      'Finds and reads printed text in photos, screenshots, and documents in 49 languages, including rotated lines. Copy the text or have it read aloud.',
    output: 'ocr',
    defaultModel: 'PaddlePaddle/PP-OCRv6_tiny_det_onnx',
    models: [
      {
        id: 'PaddlePaddle/PP-OCRv6_tiny_det_onnx',
        label: 'PP-OCRv6 tiny',
        note: 'A 1.8 MB text detector plus a 4.5 MB recognizer from PaddleOCR. Apache 2.0.',
        approxBytes: 6_243_229,
      },
    ],
  },
  {
    id: 'describe-scene',
    title: 'Describe the scene (Mirage)',
    short: 'Describe scene',
    description:
      'A 22 MB model that lists the objects in a photo with boxes and attributes, how they relate, any readable text, and a short summary. Fast on any device, but it can mistake similar animals.',
    output: 'scene',
    defaultModel: 'Cactus-Compute/mirage',
    models: [
      {
        id: 'Cactus-Compute/mirage',
        label: 'Mirage',
        note: 'Cactus Compute’s scene-graph model on a 1.3 MB WebAssembly engine. Apache 2.0.',
        approxBytes: 22_947_301,
      },
    ],
  },
  {
    id: 'image-to-text',
    title: 'Image captioning',
    short: 'Caption',
    description:
      'Writes a short English caption describing the image. Runs fully offline after the first load.',
    output: 'text',
    defaultModel: 'Xenova/vit-gpt2-image-captioning',
    models: [
      {
        id: 'Xenova/vit-gpt2-image-captioning',
        label: 'ViT-GPT2',
        note: 'Compact captioning model.',
        approxBytes: 958_465_719,
        halfBytes: 481_936_436,
        compactBytes: 246_053_209,
      },
    ],
  },
];

export function getVisionTask(id: string): VisionTaskDefinition {
  return VISION_TASKS.find((task) => task.id === id) ?? VISION_TASKS[0];
}

export function getVisionModel(
  task: VisionTaskDefinition,
  id: string,
): VisionModelOption {
  return task.models.find((model) => model.id === id) ?? task.models[0];
}

export interface VisionProgress {
  phase: 'loading' | 'running' | 'ready';
  text: string;
  percent?: number;
  /** Combined download bytes, when files are being fetched. */
  loaded?: number;
  total?: number;
}

export interface VisionBox {
  label: string;
  score: number;
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
}

export interface VisionLabel {
  label: string;
  score: number;
}

export interface VisionSegment {
  label: string;
  score: number;
  mask: RawImage;
}

export type VisionResult =
  | { kind: 'image'; image: RawImage; label: string }
  | { kind: 'depth'; image: RawImage }
  | { kind: 'boxes'; items: VisionBox[]; labels: VisionLabel[] }
  | { kind: 'mask'; items: VisionSegment[]; labels: VisionLabel[] }
  | { kind: 'labels'; items: VisionLabel[] }
  | { kind: 'text'; text: string }
  | { kind: 'ocr'; lines: OcrLine[] }
  | { kind: 'scene'; scene: MirageScene }
  | { kind: 'select'; cutout: RawImage; mask: Uint8Array; width: number; height: number; score: number; points: SelectPoint[] };

export interface VisionSelection {
  task: VisionTaskId;
  model: string;
  device: VisionDevice;
  precision?: VisionPrecision;
  onProgress?: (progress: VisionProgress) => void;
}

export interface RunVisionOptions extends VisionSelection {
  image: RawImage;
  threshold?: number;
  topK?: number;
  /** Clicks for "select-object"; the image centre when empty. */
  points?: SelectPoint[];
}

/*
 * Inference runs in vision-worker.ts so the page stays responsive (BiRefNet on
 * WASM blocked it for 3 to 4 s per image). Mirage ("describe-scene") and
 * browsers without module workers run vision-run.ts in the page.
 */

type VisionRun = typeof import('./vision-run');
let pageRun: VisionRun | null = null;
let worker: Worker | null = null;
let nextId = 0;
let nextImageKey = 0;
const imageKeys = new WeakMap<RawImage, number>();
const loadedKeys = new Set<string>();
const pending = new Map<number, {
  resolve: (reply: Extract<VisionWorkerReply, { type: 'done' }>) => void;
  reject: (error: Error) => void;
  onProgress?: (progress: VisionProgress) => void;
}>();

function runsInPage(task: VisionTaskId): boolean {
  return task === 'describe-scene' || typeof Worker === 'undefined';
}

async function inPage(): Promise<VisionRun> {
  pageRun ??= await import('./vision-run');
  return pageRun;
}

function selectionKey({ task, model, device, precision = 'fp32' }: VisionSelection): string {
  return `${task}:${model}:${device}:${precision}`;
}

function visionWorker(): Worker {
  if (worker) return worker;
  const created = new Worker(new URL('./vision-worker.ts', import.meta.url), { type: 'module', name: 'vision' });
  created.onmessage = (event: MessageEvent<VisionWorkerReply>) => {
    const reply = event.data;
    const request = pending.get(reply.id);
    if (!request) return;
    if (reply.type === 'progress') {
      request.onProgress?.(reply.progress);
      return;
    }
    pending.delete(reply.id);
    loadedKeys.clear();
    for (const key of reply.loaded) loadedKeys.add(key);
    if (reply.type === 'done') request.resolve(reply);
    else {
      const error = new Error(reply.message);
      error.name = reply.name;
      request.reject(error);
    }
  };
  created.onerror = (event) => {
    event.preventDefault();
    created.terminate();
    if (worker === created) worker = null;
    loadedKeys.clear();
    const error = new Error(event.message || 'The vision worker failed.');
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  worker = created;
  return created;
}

function plainSelection({ task, model, device, precision }: VisionSelection): VisionWorkerSelection {
  return { task, model, device, precision };
}

function post(
  message: DistributiveOmit<VisionWorkerRequest, 'id'>,
  onProgress?: (progress: VisionProgress) => void,
): Promise<Extract<VisionWorkerReply, { type: 'done' }>> {
  const target = visionWorker();
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    target.postMessage({ ...message, id } as VisionWorkerRequest);
  });
}

export function isVisionModelLoaded(selection: VisionSelection): boolean {
  if (runsInPage(selection.task)) return pageRun?.isVisionModelLoaded(selection) ?? false;
  return loadedKeys.has(selectionKey(webgpuFailed ? onCpu(selection) : selection));
}

/**
 * WebGPU failed in this session (an adapter exists but the device cannot be
 * created, or it was lost). ONNX Runtime is left unusable in that worker, so
 * the run is repeated on WASM in a fresh worker, and later WebGPU runs go
 * straight to WASM.
 */
let webgpuFailed = false;

function restartWorker(): void {
  worker?.terminate();
  worker = null;
  loadedKeys.clear();
  const error = new Error('The vision worker was restarted.');
  for (const request of pending.values()) request.reject(error);
  pending.clear();
}

function onCpu<T extends VisionSelection>(selection: T): T {
  if (selection.device !== 'webgpu') return selection;
  // FP16 is a WebGPU build; the CPU backend gets the FP32 weights.
  return { ...selection, device: 'wasm', precision: selection.precision === 'fp16' ? 'fp32' : selection.precision };
}

async function withWasmFallback<T, S extends VisionSelection>(selection: S, run: (selection: S) => Promise<T>): Promise<T> {
  if (webgpuFailed) return run(onCpu(selection));
  try {
    return await run(selection);
  } catch (error) {
    if (selection.device !== 'webgpu') throw error;
    console.warn('WebGPU vision failed; retrying on WASM in a fresh worker.', error);
    webgpuFailed = true;
    selection.onProgress?.({ phase: 'loading', text: 'WebGPU failed; retrying on the CPU/WASM backend…' });
    restartWorker();
    return run(onCpu(selection));
  }
}

export async function preloadVisionModel(selection: VisionSelection): Promise<void> {
  if (runsInPage(selection.task)) {
    await (await inPage()).preloadVisionModel(selection);
    return;
  }
  await withWasmFallback(selection, async (chosen) => {
    await post({ type: 'load', selection: plainSelection(chosen) }, chosen.onProgress);
  });
}

export async function runVision(options: RunVisionOptions): Promise<VisionResult> {
  if (runsInPage(options.task)) return (await inPage()).runVision(options);
  return withWasmFallback(options, runInWorker);
}

async function runInWorker(options: RunVisionOptions): Promise<VisionResult> {
  const { image } = options;
  let imageKey = imageKeys.get(image);
  if (imageKey === undefined) {
    imageKey = ++nextImageKey;
    imageKeys.set(image, imageKey);
  }
  // Copied, not transferred: the page keeps showing the source image.
  const plain: PlainImage = { data: image.data as Uint8Array | Uint8ClampedArray, width: image.width, height: image.height, channels: image.channels };
  const reply = await post({
    type: 'run',
    selection: plainSelection(options),
    image: plain,
    imageKey,
    threshold: options.threshold,
    topK: options.topK,
    points: options.points,
  }, options.onProgress);
  return unpack(reply.result as VisionResult);
}

async function unpack(result: VisionResult): Promise<VisionResult> {
  const { RawImage: Raw } = await import('@huggingface/transformers');
  const raw = (value: unknown): RawImage => {
    const image = value as PlainImage;
    return new Raw(image.data, image.width, image.height, image.channels);
  };
  switch (result.kind) {
    case 'image': return { ...result, image: raw(result.image) };
    case 'depth': return { ...result, image: raw(result.image) };
    case 'mask': return { ...result, items: result.items.map((item) => ({ ...item, mask: raw(item.mask) })) };
    case 'select': return { ...result, cutout: raw(result.cutout) };
    default: return result;
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
