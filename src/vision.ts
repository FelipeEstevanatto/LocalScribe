/**
 * Vision & image tools.
 *
 * Every task runs through Transformers.js in this tab: ONNX Runtime Web on
 * WebGPU where an adapter exists, WASM otherwise. Images are decoded locally
 * and never uploaded. Models are downloaded from Hugging Face on first use and
 * cached by the browser.
 */

import type { RawImage } from '@huggingface/transformers';
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

type LoadedPipeline = ((
  input: RawImage,
  options?: Record<string, unknown>,
) => Promise<unknown>) & { dispose?: () => Promise<void> | void };

interface VisionSelection {
  task: VisionTaskId;
  model: string;
  device: VisionDevice;
  precision?: VisionPrecision;
  onProgress?: (progress: VisionProgress) => void;
}

interface PipelineCacheEntry {
  promise: Promise<LoadedPipeline>;
  ready: boolean;
  lastUsed: number;
}
const pipelineCache = new Map<string, PipelineCacheEntry>();
const MAX_VISION_PIPELINES = 2;

function visionModelKey({ task, model, device, precision = 'fp32' }: VisionSelection): string {
  return `${task}:${model}:${device}:${precision}`;
}

export function isVisionModelLoaded(selection: VisionSelection): boolean {
  return pipelineCache.get(visionModelKey(selection))?.ready ?? false;
}

export async function preloadVisionModel(selection: VisionSelection): Promise<void> {
  await loadPipeline(selection);
}

function humanBytes(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(0)} MB`;
}

async function loadPipeline(selection: VisionSelection): Promise<LoadedPipeline> {
  const { task, model, device, precision = 'fp32', onProgress } = selection;
  const key = visionModelKey(selection);
  const cached = pipelineCache.get(key);
  if (cached) {
    cached.lastUsed = Date.now();
    return cached.promise;
  }

  const promise = (async () => {
    for (const [loadedKey, loaded] of [...pipelineCache]) {
      if (!loadedKey.startsWith(`${task}:${model}:`)) continue;
      pipelineCache.delete(loadedKey);
      try {
        await (await loaded.promise).dispose?.();
      } catch {
        // A failed session must not prevent loading the chosen variant.
      }
    }
    const transformers = await import('@huggingface/transformers');
    transformers.env.allowLocalModels = false;
    const tryLoad = async (target: VisionDevice): Promise<LoadedPipeline> => {
      const revision = getVisionTask(task).models.find((entry) => entry.id === model)?.revision;
      // Several files download in parallel; report their combined bytes.
      const files = new Map<string, { loaded: number; total: number }>();
      const options = {
        device: target,
        dtype: precision,
        revision,
        progress_callback: (event: {
          status?: string;
          file?: string;
          loaded?: number;
          total?: number;
        }) => {
          if (!onProgress) return;
          if (event.status === 'progress' && event.total && event.total > 0) {
            files.set(event.file ?? 'model', { loaded: event.loaded ?? 0, total: event.total });
            let loaded = 0;
            let total = 0;
            for (const entry of files.values()) {
              loaded += entry.loaded;
              total += entry.total;
            }
            onProgress({
              phase: 'loading',
              text: `Downloading the model · ${humanBytes(loaded)} / ${humanBytes(total)}`,
              percent: (loaded / total) * 100,
              loaded,
              total,
            });
          } else if (event.status === 'ready') {
            onProgress({ phase: 'loading', text: 'Preparing the model…', percent: 100 });
          }
        },
      };
      if (task === 'describe-scene') {
        const { loadMirage } = await import('./cactus');
        const mirage = await loadMirage((loaded, total) => onProgress?.({
          phase: 'loading', text: 'Downloading Mirage', percent: (loaded / total) * 100, loaded, total,
        }));
        const describe = async (image: RawImage) => mirage.describe(image.data as Uint8ClampedArray, image.width, image.height, image.channels);
        return describe as unknown as LoadedPipeline;
      }
      if (task === 'ocr') {
        const ocr = await import('./ocr');
        await ocr.loadOcr((loaded, total) => onProgress?.({
          phase: 'loading', text: 'Downloading the OCR models', percent: (loaded / total) * 100, loaded, total,
        }));
        const read = async (image: RawImage) => ocr.runOcr(
          { data: image.data as Uint8ClampedArray, width: image.width, height: image.height, channels: image.channels },
          { onProgress: (fraction, text) => onProgress?.({ phase: 'running', text, percent: fraction * 100 }) },
        );
        return read as unknown as LoadedPipeline;
      }
      if (task === 'select-object') {
        const processor = await transformers.AutoProcessor.from_pretrained(model, { revision });
        const network = await transformers.Sam3TrackerModel.from_pretrained(model, {
          ...options,
          dtype: precision === 'fp16' ? 'q4f16' : 'q4',
        } as never);
        // Encode each image once; clicks only rerun the small decoder.
        let encoded: { image: RawImage; inputs: Record<string, unknown>; embeddings: Record<string, unknown> } | null = null;
        const select = async (image: RawImage, points: SelectPoint[]) => {
          if (encoded?.image !== image) {
            onProgress?.({ phase: 'running', text: 'Encoding the image (once per image)…', percent: 40 });
            const inputs = await processor(image) as Record<string, unknown>;
            const embeddings = await (network as unknown as { get_image_embeddings: (inputs: unknown) => Promise<Record<string, unknown>> }).get_image_embeddings(inputs);
            encoded = { image, inputs, embeddings };
          }
          onProgress?.({ phase: 'running', text: 'Selecting…', percent: 85 });
          const prompt = await processor(image, {
            input_points: [[points.map((point) => [point.x, point.y])]],
            input_labels: [[points.map((point) => (point.positive ? 1 : 0))]],
          }) as Record<string, unknown>;
          const outputs = await network({
            ...encoded.embeddings,
            input_points: prompt.input_points,
            input_labels: prompt.input_labels,
          } as never) as { pred_masks: InstanceType<typeof transformers.Tensor>; iou_scores: InstanceType<typeof transformers.Tensor> };
          const masks = await (processor as unknown as {
            post_process_masks: (...args: unknown[]) => Promise<InstanceType<typeof transformers.Tensor>[]>;
          }).post_process_masks(outputs.pred_masks, prompt.original_sizes, prompt.reshaped_input_sizes);
          // Masks come as [1, point batch, candidates, H, W]; keep the best candidate.
          const scores = outputs.iou_scores.data as Float32Array;
          let best = 0;
          for (let i = 1; i < scores.length; i += 1) if (scores[i] > scores[best]) best = i;
          const all = masks[0].data as Uint8Array;
          const size = image.width * image.height;
          const mask = all.slice(best * size, (best + 1) * size);
          const alpha = new Uint8ClampedArray(size);
          for (let i = 0; i < size; i += 1) alpha[i] = mask[i] ? 255 : 0;
          const cutout = image.clone().putAlpha(new transformers.RawImage(alpha, image.width, image.height, 1));
          return { cutout, mask, width: image.width, height: image.height, score: scores[best] ?? 0, points };
        };
        return Object.assign(select, {
          dispose: async () => { encoded = null; await network.dispose(); },
        }) as unknown as LoadedPipeline;
      }
      if (task === 'background-removal') {
        const processor = await transformers.AutoProcessor.from_pretrained(model, { revision });
        const network = await transformers.AutoModel.from_pretrained(model, options);
        // Exports name their tensors differently (input/output for RMBG and
        // MODNet, input_image/output_image for BiRefNet), so read the session.
        const session = (network as unknown as { sessions?: Record<string, { inputNames?: string[]; outputNames?: string[] }> })
          .sessions?.model;
        const inputName = session?.inputNames?.[0] ?? 'input';
        const outputNames = session?.outputNames ?? [];
        const outputName = ['output', 'output_image', 'alphas', 'logits'].find((name) => outputNames.includes(name))
          ?? outputNames[outputNames.length - 1]
          ?? 'output';
        const removeBackground = async (image: RawImage): Promise<RawImage> => {
          const { pixel_values } = await processor(image);
          const outputs = await network({ [inputName]: pixel_values }) as Record<string, InstanceType<typeof transformers.Tensor>>;
          let matte = outputs[outputName] ?? Object.values(outputs)[0];
          // RMBG and MODNet return a 0–1 matte; BiRefNet returns logits.
          const data = matte.data as Float32Array;
          let low = Infinity;
          let high = -Infinity;
          for (let i = 0; i < data.length; i += 97) {
            if (data[i] < low) low = data[i];
            if (data[i] > high) high = data[i];
          }
          if (low < -0.01 || high > 1.01) matte = matte.sigmoid();
          const first = (matte as unknown as Record<number, typeof matte>)[0];
          const mask = await transformers.RawImage
            .fromTensor(first.mul(255).to('uint8'))
            .resize(image.width, image.height);
          return image.clone().putAlpha(mask);
        };
        return Object.assign(removeBackground, {
          dispose: async () => { await network.dispose(); },
        });
      }
      const pipe = await transformers.pipeline(task as never, model as never, options);
      return pipe as unknown as LoadedPipeline;
    };

    try {
      return await tryLoad(device);
    } catch (error) {
      if (device === 'webgpu' && precision !== 'fp16') {
        onProgress?.({
          phase: 'loading',
          text: 'WebGPU failed; retrying on the CPU/WASM backend…',
        });
        return tryLoad('wasm');
      }
      throw error;
    }
  })();

  const entry = { promise, ready: false, lastUsed: Date.now() };
  pipelineCache.set(key, entry);
  // Vision models are hundreds of MB. Keep only the two most recently used
  // pipelines so exploring tasks cannot pin gigabytes of sessions in memory.
  if (pipelineCache.size > MAX_VISION_PIPELINES) {
    const evictable = [...pipelineCache.entries()]
      .filter(([entryKey, value]) => entryKey !== key && value.ready)
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [entryKey, value] of evictable.slice(0, pipelineCache.size - MAX_VISION_PIPELINES)) {
      pipelineCache.delete(entryKey);
      void value.promise.then((loaded) => loaded.dispose?.()).catch(() => undefined);
    }
  }
  void promise.then(
    () => { entry.ready = true; },
    () => { if (pipelineCache.get(key) === entry) pipelineCache.delete(key); },
  );
  return promise;
}

export interface RunVisionOptions extends VisionSelection {
  image: RawImage;
  threshold?: number;
  topK?: number;
  /** Clicks for "select-object"; the image centre when empty. */
  points?: SelectPoint[];
}

export async function runVision(options: RunVisionOptions): Promise<VisionResult> {
  const { task, image, onProgress } = options;
  onProgress?.({ phase: 'loading', text: 'Preparing the vision model…' });
  const pipe = await loadPipeline(options);

  onProgress?.({
    phase: 'running',
    text:
      task === 'image-to-text'
        ? 'Writing a caption…'
        : task === 'depth-estimation'
          ? 'Estimating depth…'
          : task === 'image-classification'
            ? 'Classifying the image…'
            : 'Running inference…',
  });

  if (task === 'select-object') {
    const points = options.points?.length
      ? options.points
      : [{ x: image.width / 2, y: image.height / 2, positive: true }];
    const selection = (await (pipe as unknown as (image: RawImage, points: SelectPoint[]) => Promise<Omit<Extract<VisionResult, { kind: 'select' }>, 'kind'>>)(image, points));
    onProgress?.({ phase: 'ready', text: 'Selection ready.', percent: 100 });
    return { kind: 'select', ...selection };
  }

  if (task === 'describe-scene') {
    const scene = (await pipe(image)) as MirageScene;
    const count = scene.objects?.length ?? 0;
    onProgress?.({ phase: 'ready', text: `${count} object${count === 1 ? '' : 's'} described.`, percent: 100 });
    return { kind: 'scene', scene };
  }

  if (task === 'ocr') {
    const lines = (await pipe(image)) as OcrLine[];
    onProgress?.({ phase: 'ready', text: `${lines.length} line${lines.length === 1 ? '' : 's'} of text found.`, percent: 100 });
    return { kind: 'ocr', lines };
  }

  if (task === 'background-removal') {
    const output = (await pipe(image)) as RawImage;
    onProgress?.({ phase: 'ready', text: 'Cutout ready.', percent: 100 });
    return { kind: 'image', image: output, label: 'Transparent PNG' };
  }

  if (task === 'depth-estimation') {
    const output = (await pipe(image)) as {
      depth?: RawImage;
      predicted_depth?: unknown;
    };
    if (!output.depth) throw new Error('The depth model returned no depth map.');
    onProgress?.({ phase: 'ready', text: 'Depth map ready.', percent: 100 });
    return { kind: 'depth', image: output.depth };
  }

  if (task === 'object-detection') {
    const output = (await pipe(image, {
      threshold: options.threshold ?? 0.5,
      percentage: true,
    })) as Array<{
      label: string;
      score: number;
      box: { xmin: number; ymin: number; xmax: number; ymax: number };
    }>;
    const items = output
      .map((item) => ({
        label: item.label,
        score: item.score,
        xmin: item.box.xmin,
        ymin: item.box.ymin,
        xmax: item.box.xmax,
        ymax: item.box.ymax,
      }))
      .sort((a, b) => b.score - a.score);
    onProgress?.({
      phase: 'ready',
      text: `${items.length} object${items.length === 1 ? '' : 's'} found.`,
      percent: 100,
    });
    return {
      kind: 'boxes',
      items,
      labels: items.map((item) => ({ label: item.label, score: item.score })),
    };
  }

  if (task === 'image-segmentation') {
    const output = (await pipe(image)) as VisionSegment[];
    const sorted = output.slice().sort((a, b) => b.score - a.score);
    onProgress?.({
      phase: 'ready',
      text: `${sorted.length} segment${sorted.length === 1 ? '' : 's'} found.`,
      percent: 100,
    });
    return {
      kind: 'mask',
      items: sorted,
      labels: sorted.map((item) => ({ label: item.label, score: item.score })),
    };
  }

  if (task === 'image-classification') {
    const output = (await pipe(image, {
      top_k: options.topK ?? 5,
    })) as VisionLabel[];
    onProgress?.({ phase: 'ready', text: 'Classification ready.', percent: 100 });
    return { kind: 'labels', items: output };
  }

  const output = (await pipe(image, {
    max_new_tokens: 64,
  })) as Array<{ generated_text?: string }>;
  const text = output[0]?.generated_text?.trim() ?? '';
  onProgress?.({ phase: 'ready', text: 'Caption ready.', percent: 100 });
  return { kind: 'text', text: text || 'No caption was generated.' };
}
