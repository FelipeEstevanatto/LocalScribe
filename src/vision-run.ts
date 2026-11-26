/**
 * Vision inference: Transformers.js pipelines, PP-OCR, SAM and Mirage. Runs in
 * `vision-worker.ts` (or in the page where module workers are missing); the
 * page talks to it through `vision.ts`.
 */

import type { RawImage } from '@huggingface/transformers';
import type { OcrLine } from './ocr';
import type { MirageScene } from './cactus';
import {
  getVisionTask,
  type SelectPoint,
  type VisionDevice,
  type VisionLabel,
  type VisionPrecision,
  type VisionProgress,
  type VisionResult,
  type VisionSegment,
  type VisionTaskId,
} from './vision';

type LoadedPipeline = ((
  input: RawImage,
  options?: Record<string, unknown>,
) => Promise<unknown>) & { dispose?: () => Promise<void> | void };

export interface VisionSelection {
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

/** Keys of the pipelines that are loaded and ready (for the page side). */
export function loadedVisionModels(): string[] {
  return [...pipelineCache].filter(([, entry]) => entry.ready).map(([key]) => key);
}

export { visionModelKey };

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
    const tryLoad = async (target: VisionDevice, dtype: VisionPrecision): Promise<LoadedPipeline> => {
      const revision = getVisionTask(task).models.find((entry) => entry.id === model)?.revision;
      // Several files download in parallel; report their combined bytes.
      const files = new Map<string, { loaded: number; total: number }>();
      const options = {
        device: target,
        dtype,
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
          dtype: dtype === 'fp16' ? 'q4f16' : 'q4',
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
      return await tryLoad(device, precision);
    } catch (error) {
      if (device === 'webgpu') {
        onProgress?.({
          phase: 'loading',
          text: 'WebGPU failed; retrying on the CPU/WASM backend…',
        });
        // FP16 is a WebGPU build; the CPU backend gets the FP32 weights.
        return tryLoad('wasm', precision === 'fp16' ? 'fp32' : precision);
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

/** Drop a loaded pipeline (after it failed at run time). */
async function evictPipeline(selection: VisionSelection): Promise<void> {
  const key = visionModelKey(selection);
  const entry = pipelineCache.get(key);
  if (!entry) return;
  pipelineCache.delete(key);
  await entry.promise.then((loaded) => loaded.dispose?.()).catch(() => undefined);
}

/**
 * Run a task. When WebGPU fails at run time (an adapter exists but the device
 * cannot be created or is lost), run it again on the CPU/WASM backend instead
 * of ending in a generic error.
 */
export async function runVision(options: RunVisionOptions): Promise<VisionResult> {
  try {
    return await runOnce(options);
  } catch (error) {
    if (options.device !== 'webgpu' || options.task === 'ocr' || options.task === 'describe-scene') throw error;
    console.warn('WebGPU vision run failed; retrying on WASM.', error);
    options.onProgress?.({ phase: 'loading', text: 'WebGPU failed; retrying on the CPU/WASM backend…' });
    await evictPipeline(options);
    return runOnce({ ...options, device: 'wasm', precision: options.precision === 'fp16' ? 'fp32' : options.precision });
  }
}

/** One run without the WASM retry (the worker's page side retries in a fresh worker). */
export async function runOnce(options: RunVisionOptions): Promise<VisionResult> {
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
