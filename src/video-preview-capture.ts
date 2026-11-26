/**
 * Offscreen preview rendering for stills, thumbnails, and future cache fills.
 *
 * The live compositor renders to the visible canvas. This module creates a
 * detached compositor at an explicit target size, renders one plan, and
 * returns an ImageBitmap. It is intentionally a separate context so a capture
 * never resizes or clears the live preview.
 */

import type { GlPreview, PreviewFallbackReason } from './video-gl-preview';
import { createGlPreview } from './video-gl-preview';
import { createWebGpuPreview, type WebGpuPreview } from './video-webgpu-preview';
import type { PreviewFramePlan } from './video-preview-plan';

export type PreviewCaptureBackend = 'webgl' | 'webgpu';

export interface PreviewCaptureOptions {
  backend?: PreviewCaptureBackend;
  /** Milliseconds before returning null instead of waiting forever. */
  timeoutMs?: number;
}

export interface PreviewCaptureTarget {
  width: number;
  height: number;
}

function detachedStage(width: number, height: number): HTMLDivElement {
  const stage = document.createElement('div');
  stage.setAttribute('aria-hidden', 'true');
  stage.style.cssText = [
    'position:fixed',
    'left:-10000px',
    'top:0',
    'pointer-events:none',
    'opacity:0',
    `width:${width}px`,
    `height:${height}px`,
    'overflow:hidden',
    'contain:strict',
  ].join(';');
  document.body.append(stage);
  return stage;
}

/**
 * Render a single plan at `target` and return a GPU drawing-buffer bitmap.
 * The caller owns the bitmap and should close it when finished.
 */
export async function renderPreviewToTarget(
  source: HTMLVideoElement | HTMLImageElement,
  plan: PreviewFramePlan,
  target: PreviewCaptureTarget,
  options: PreviewCaptureOptions = {},
): Promise<ImageBitmap | null> {
  if (typeof document === 'undefined' || typeof createImageBitmap !== 'function') return null;
  const width = Math.max(1, Math.round(target.width));
  const height = Math.max(1, Math.round(target.height));
  const backend = options.backend === 'webgpu' ? 'webgpu' : 'webgl';
  const targetPlan: PreviewFramePlan = {
    ...plan,
    stage: { ...plan.stage, width, height, dpr: 1 },
    output: { width, height },
    signature: `${plan.signature}|capture:${backend}:${width}x${height}`,
  };
  const stage = detachedStage(width, height);
  let compositor: GlPreview | WebGpuPreview | null = null;
  let timer = 0;
  let done = false;
  let finishCapture: ((value: ImageBitmap | null) => void) | null = null;
  const bitmap = new Promise<ImageBitmap | null>((resolve) => {
    finishCapture = (value: ImageBitmap | null): void => {
      if (done) {
        value?.close();
        return;
      }
      done = true;
      window.clearTimeout(timer);
      resolve(value);
    };
    timer = window.setTimeout(() => finishCapture?.(null), Math.max(1000, options.timeoutMs ?? 5000));
  });
  const onFrameCaptured = (signature: string, value: ImageBitmap): void => {
    if (signature === targetPlan.signature) finishCapture?.(value);
    else value.close();
  };
  const onFallback = (_reason: PreviewFallbackReason): void => finishCapture?.(null);
  compositor = backend === 'webgpu'
    ? createWebGpuPreview(stage, { onFrameCaptured, onFallback })
    : createGlPreview(stage, { preserveDrawingBuffer: true, onFrameCaptured, onFallback });

  try {
    if (!compositor) return null;
    if ('ready' in compositor) {
      const ready = await compositor.ready;
      if (!ready || !compositor.active) return null;
    }
    const result = compositor.render({ plan: targetPlan, source, capture: true });
    if (!result.rendered) return null;
    return await bitmap;
  } finally {
    window.clearTimeout(timer);
    compositor?.dispose();
    stage.remove();
  }
}
