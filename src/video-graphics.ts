/** Shape, pattern, SVG, and emoji overlays shared by the preview and exporter. */

import { overlayTransitionOpacity, type OverlayTransition } from './video-overlays';

export type GraphicKind = 'rect' | 'ellipse' | 'line' | 'svg' | 'emoji';
export type GraphicFillType = 'solid' | 'linear' | 'radial';
export type GraphicPattern = 'none' | 'stripes' | 'diagonal' | 'dots' | 'grid' | 'checker' | 'crosshatch';

export interface GraphicClip {
  id: number;
  kind: GraphicKind;
  start: number;
  end: number;
  /** Normal video track row for the overlay, like any other timeline clip. */
  track?: number;
  /** Percentages of the output frame. */
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  fill: string;
  stroke: string;
  strokeWidth: number;
  opacity: number;
  radius: number;
  fillType?: GraphicFillType;
  fill2?: string;
  gradientAngle?: number;
  pattern?: GraphicPattern;
  patternColor?: string;
  patternScale?: number;
  /** data: URL for an imported SVG overlay. */
  svg?: string;
  name?: string;
  emoji?: string;
  transition?: OverlayTransition;
}

export function graphicLabel(kind: GraphicKind): string {
  if (kind === 'rect') return 'Rectangle';
  if (kind === 'ellipse') return 'Ellipse';
  if (kind === 'line') return 'Line';
  if (kind === 'svg') return 'SVG';
  return 'Emoji';
}

export interface GraphicPatternPreset {
  id: Exclude<GraphicPattern, 'none'>;
  label: string;
  base: string;
  color: string;
  scale: number;
}

export const GRAPHIC_PATTERN_PRESETS: GraphicPatternPreset[] = [
  { id: 'stripes', label: 'Stripes', base: '#0f172a', color: '#818cf8', scale: 14 },
  { id: 'diagonal', label: 'Diagonal', base: '#111827', color: '#22d3ee', scale: 16 },
  { id: 'dots', label: 'Dots', base: '#1e1b4b', color: '#f0abfc', scale: 14 },
  { id: 'grid', label: 'Grid', base: '#0f172a', color: '#38bdf8', scale: 16 },
  { id: 'checker', label: 'Checker', base: '#111827', color: '#fbbf24', scale: 18 },
  { id: 'crosshatch', label: 'Crosshatch', base: '#1f2937', color: '#a3e635', scale: 14 },
];

export interface GraphicGradientPreset {
  id: string;
  label: string;
  from: string;
  to: string;
  angle: number;
  type: 'linear' | 'radial';
}

export const GRAPHIC_GRADIENT_PRESETS: GraphicGradientPreset[] = [
  { id: 'sunset', label: 'Sunset', from: '#fb7185', to: '#f59e0b', angle: 120, type: 'linear' },
  { id: 'ocean', label: 'Ocean', from: '#0ea5e9', to: '#22d3ee', angle: 90, type: 'linear' },
  { id: 'neon', label: 'Neon', from: '#8b5cf6', to: '#ec4899', angle: 135, type: 'linear' },
  { id: 'mint', label: 'Mint', from: '#34d399', to: '#06b6d4', angle: 45, type: 'linear' },
  { id: 'ember', label: 'Ember', from: '#f97316', to: '#dc2626', angle: 160, type: 'linear' },
  { id: 'aurora', label: 'Aurora', from: '#22d3ee', to: '#a78bfa', angle: 0, type: 'radial' },
];

export function defaultGraphic(kind: GraphicKind, id: number, start: number, end: number): GraphicClip {
  if (kind === 'line') {
    return {
      id, kind, start, end,
      x: 20, y: 50, width: 60, height: 0, rotation: 0,
      fill: '#f8fafc', stroke: '#f8fafc', strokeWidth: 6, opacity: 0.9, radius: 0,
      fillType: 'solid', fill2: '#f8fafc', gradientAngle: 90, pattern: 'none',
      patternColor: '#ffffff', patternScale: 14,
    };
  }
  if (kind === 'svg' || kind === 'emoji') {
    return {
      id, kind, start, end,
      x: 35, y: 35, width: 30, height: 30, rotation: 0,
      fill: 'transparent', stroke: 'transparent', strokeWidth: 0, opacity: 1, radius: 0,
      fillType: 'solid', fill2: '#22d3ee', gradientAngle: 90, pattern: 'none',
      patternColor: '#ffffff', patternScale: 14,
    };
  }
  return {
    id, kind, start, end,
    x: 35, y: 38, width: 30, height: 24, rotation: 0,
    fill: kind === 'rect' ? '#6366f1' : '#22d3ee',
    stroke: '#ffffff', strokeWidth: 0, opacity: 0.82, radius: 14,
    fillType: 'solid', fill2: '#22d3ee', gradientAngle: 90, pattern: 'none',
    patternColor: '#ffffff', patternScale: 14,
  };
}

export function defaultPatternGraphic(
  preset: GraphicPatternPreset,
  id: number,
  start: number,
  end: number,
): GraphicClip {
  return {
    ...defaultGraphic('rect', id, start, end),
    x: 20, y: 20, width: 60, height: 60, radius: 14, opacity: 0.95,
    fill: preset.base,
    pattern: preset.id,
    patternColor: preset.color,
    patternScale: preset.scale,
    fillType: 'solid',
    name: `${preset.label} pattern`,
  };
}

export function defaultGradientGraphic(
  preset: GraphicGradientPreset,
  id: number,
  start: number,
  end: number,
): GraphicClip {
  return {
    ...defaultGraphic('rect', id, start, end),
    x: 20, y: 20, width: 60, height: 60, radius: 14, opacity: 0.95,
    fillType: preset.type,
    fill: preset.from,
    fill2: preset.to,
    gradientAngle: preset.angle,
    pattern: 'none',
    name: `${preset.label} gradient`,
  };
}

export function defaultSvgGraphic(
  id: number,
  start: number,
  end: number,
  svg: string,
  name: string,
): GraphicClip {
  return {
    ...defaultGraphic('svg', id, start, end),
    x: 35, y: 35, width: 30, height: 30,
    svg,
    name,
  };
}

export function defaultEmojiGraphic(
  id: number,
  start: number,
  end: number,
  emoji: string,
  box?: { x: number; y: number; width: number; height: number },
): GraphicClip {
  return {
    ...defaultGraphic('emoji', id, start, end),
    x: box?.x ?? 44,
    y: box?.y ?? 40,
    width: box?.width ?? 12,
    height: box?.height ?? 20,
    emoji,
    name: emoji,
  };
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** CSS for a pattern layer. Scale is in screen pixels. */
export function graphicPatternCss(
  pattern: GraphicPattern | undefined,
  color: string,
  scale: number,
): { image: string; size: string } | null {
  if (!pattern || pattern === 'none') return null;
  const s = Math.max(4, Math.round(scale));
  const thin = Math.max(1, Math.round(s * 0.08));
  if (pattern === 'stripes' || pattern === 'diagonal') {
    const angle = pattern === 'stripes' ? 45 : 135;
    return {
      image: `repeating-linear-gradient(${angle}deg, transparent 0 ${Math.round(s * 0.55)}px, ${color} ${Math.round(s * 0.55)}px ${s}px)`,
      size: 'auto',
    };
  }
  if (pattern === 'crosshatch') {
    return {
      image: `repeating-linear-gradient(45deg, transparent 0 ${Math.round(s * 0.55)}px, ${color} ${Math.round(s * 0.55)}px ${s}px), repeating-linear-gradient(135deg, transparent 0 ${Math.round(s * 0.55)}px, ${color} ${Math.round(s * 0.55)}px ${s}px)`,
      size: 'auto, auto',
    };
  }
  if (pattern === 'dots') {
    return {
      image: `radial-gradient(circle, ${color} ${Math.max(1, Math.round(s * 0.16))}px, transparent ${Math.max(1, Math.round(s * 0.2))}px)`,
      size: `${s}px ${s}px`,
    };
  }
  if (pattern === 'grid') {
    return {
      image: `linear-gradient(${color} ${thin}px, transparent ${thin}px), linear-gradient(90deg, ${color} ${thin}px, transparent ${thin}px)`,
      size: `${s}px ${s}px, ${s}px ${s}px`,
    };
  }
  return {
    image: `conic-gradient(${color} 90deg, transparent 90deg 180deg, ${color} 180deg 270deg, transparent 270deg)`,
    size: `${s}px ${s}px`,
  };
}

/** CSS for a gradient fill, or null for a solid fill. */
export function graphicGradientCss(graphic: GraphicClip): string | null {
  if (graphic.fillType !== 'linear' && graphic.fillType !== 'radial') return null;
  const from = graphic.fill || '#6366f1';
  const to = graphic.fill2 || from;
  return graphic.fillType === 'radial'
    ? `radial-gradient(circle at center, ${from}, ${to})`
    : `linear-gradient(${Math.round(graphic.gradientAngle ?? 90)}deg, ${from}, ${to})`;
}

function traceShape(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  kind: GraphicKind,
  w: number,
  h: number,
  radius: number,
): void {
  if (kind === 'ellipse') {
    ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
    return;
  }
  const safeRadius = Math.min(Math.max(0, radius), Math.min(w, h) / 2);
  if (safeRadius > 0 && typeof ctx.roundRect === 'function') {
    ctx.roundRect(-w / 2, -h / 2, w, h, safeRadius);
  } else {
    ctx.rect(-w / 2, -h / 2, w, h);
  }
}

function createFill(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  graphic: GraphicClip,
  w: number,
  h: number,
): string | CanvasGradient {
  const from = graphic.fill || '#6366f1';
  const to = graphic.fill2 || from;
  if (graphic.fillType === 'linear') {
    const angle = ((graphic.gradientAngle ?? 90) * Math.PI) / 180;
    const dx = Math.sin(angle);
    const dy = -Math.cos(angle);
    const extent = (Math.abs(w * dx) + Math.abs(h * dy)) / 2;
    const gradient = ctx.createLinearGradient(-dx * extent, -dy * extent, dx * extent, dy * extent);
    gradient.addColorStop(0, from);
    gradient.addColorStop(1, to);
    return gradient;
  }
  if (graphic.fillType === 'radial') {
    const radius = Math.hypot(w, h) / 2;
    const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, radius);
    gradient.addColorStop(0, from);
    gradient.addColorStop(1, to);
    return gradient;
  }
  return from;
}

function drawPattern(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  pattern: GraphicPattern,
  color: string,
  scale: number,
  w: number,
  h: number,
): void {
  const s = Math.max(4, scale);
  const span = Math.hypot(w, h) * 1.2;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = Math.max(1, s * 0.16);
  if (pattern === 'dots') {
    for (let y = -h / 2; y <= h / 2; y += s) {
      for (let x = -w / 2; x <= w / 2; x += s) {
        ctx.beginPath();
        ctx.arc(x, y, Math.max(1, s * 0.16), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    return;
  }
  if (pattern === 'grid') {
    for (let x = -w / 2; x <= w / 2; x += s) {
      ctx.beginPath();
      ctx.moveTo(x, -h / 2);
      ctx.lineTo(x, h / 2);
      ctx.stroke();
    }
    for (let y = -h / 2; y <= h / 2; y += s) {
      ctx.beginPath();
      ctx.moveTo(-w / 2, y);
      ctx.lineTo(w / 2, y);
      ctx.stroke();
    }
    return;
  }
  if (pattern === 'checker') {
    let row = 0;
    for (let y = -h / 2; y <= h / 2; y += s) {
      let column = 0;
      for (let x = -w / 2; x <= w / 2; x += s) {
        if ((row + column) % 2 === 0) ctx.fillRect(x, y, s, s);
        column += 1;
      }
      row += 1;
    }
    return;
  }
  const angles = pattern === 'crosshatch'
    ? [-Math.PI / 4, Math.PI / 4]
    : [pattern === 'stripes' ? -Math.PI / 4 : Math.PI / 4];
  for (const angle of angles) {
    ctx.save();
    ctx.rotate(angle);
    for (let x = -span; x <= span; x += s) {
      ctx.beginPath();
      ctx.moveTo(x, -span);
      ctx.lineTo(x, span);
      ctx.stroke();
    }
    ctx.restore();
  }
}

const EMOJI_FONT = '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", "Twemoji Mozilla", sans-serif';
const emojiSpriteCache = new Map<string, HTMLCanvasElement | null>();
const emojiUrlCache = new Map<string, string>();

/**
 * Rasterise an emoji and crop it to its actual ink bounds. Browsers draw
 * colour emoji with bearings that can extend well past the em box, so the old
 * font-size math made emoji spill outside their transform handles.
 */
function buildEmojiSprite(emoji: string): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  const size = 512;
  const source = document.createElement('canvas');
  source.width = size;
  source.height = size;
  const context = source.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  context.clearRect(0, 0, size, size);
  context.font = `420px ${EMOJI_FONT}`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(emoji, size / 2, size / 2);

  const pixels = context.getImageData(0, 0, size, size).data;
  let minX = size;
  let minY = size;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (pixels[(y * size + x) * 4 + 3] < 8) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < minX || maxY < minY) return null;

  // Keep a little transparent padding for antialiased edges.
  minX = Math.max(0, minX - 2);
  minY = Math.max(0, minY - 2);
  maxX = Math.min(size - 1, maxX + 2);
  maxY = Math.min(size - 1, maxY + 2);
  const width = maxX - minX + 1;
  const height = maxY - minY + 1;
  const sprite = document.createElement('canvas');
  sprite.width = width;
  sprite.height = height;
  const spriteContext = sprite.getContext('2d');
  if (!spriteContext) return null;
  spriteContext.drawImage(source, minX, minY, width, height, 0, 0, width, height);
  return sprite;
}

export function emojiSprite(emoji: string): HTMLCanvasElement | null {
  const key = emoji || '🙂';
  if (emojiSpriteCache.has(key)) return emojiSpriteCache.get(key) ?? null;
  const sprite = buildEmojiSprite(key);
  emojiSpriteCache.set(key, sprite);
  return sprite;
}

export function emojiSpriteUrl(emoji: string): string {
  const key = emoji || '🙂';
  const cached = emojiUrlCache.get(key);
  if (cached !== undefined) return cached;
  let url = '';
  try {
    const sprite = emojiSprite(key);
    url = sprite ? sprite.toDataURL('image/png') : '';
  } catch {
    url = '';
  }
  emojiUrlCache.set(key, url);
  return url;
}

const graphicImageCache = new Map<string, HTMLImageElement>();
const graphicImagePromises = new Map<string, Promise<HTMLImageElement | null>>();

function loadGraphicImage(src: string): Promise<HTMLImageElement | null> {
  if (typeof Image === 'undefined') return Promise.resolve(null);
  const existing = graphicImageCache.get(src);
  if (existing) return Promise.resolve(existing);
  const pending = graphicImagePromises.get(src);
  if (pending) return pending;
  const promise = new Promise<HTMLImageElement | null>((resolve) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => {
      graphicImageCache.set(src, image);
      graphicImagePromises.delete(src);
      resolve(image);
    };
    image.onerror = () => {
      graphicImagePromises.delete(src);
      resolve(null);
    };
    image.src = src;
  });
  graphicImagePromises.set(src, promise);
  return promise;
}

/** Ensure SVG and emoji overlays are ready before the exporter draws its first frame. */
export async function preloadGraphicImages(graphics: readonly GraphicClip[]): Promise<void> {
  for (const graphic of graphics) {
    if (graphic.kind === 'emoji') emojiSprite(graphic.emoji ?? '🙂');
  }
  const urls = [...new Set(graphics.flatMap((graphic) => graphic.kind === 'svg' && graphic.svg ? [graphic.svg] : []))];
  await Promise.all(urls.map((src) => loadGraphicImage(src)));
}

/** Draw every active graphic over a frame. Coordinates are percentages of the frame. */
export function drawGraphics(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  width: number,
  height: number,
  graphics: readonly GraphicClip[],
  time: number,
): void {
  for (const graphic of graphics) {
    if (time < graphic.start || time >= graphic.end) continue;
    const w = Math.max(0.001, (graphic.width / 100) * width);
    const h = Math.max(0.001, (graphic.height / 100) * height);
    const cx = ((graphic.x + graphic.width / 2) / 100) * width;
    const cy = ((graphic.y + graphic.height / 2) / 100) * height;
    ctx.save();
    ctx.globalAlpha = clamp01(graphic.opacity) * overlayTransitionOpacity(graphic.start, graphic.end, graphic.transition, time);
    ctx.translate(cx, cy);
    ctx.rotate((graphic.rotation * Math.PI) / 180);
    if (graphic.kind === 'line') {
      ctx.strokeStyle = graphic.stroke || graphic.fill;
      ctx.lineWidth = Math.max(1, graphic.strokeWidth);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(-w / 2, 0);
      ctx.lineTo(w / 2, 0);
      ctx.stroke();
    } else if (graphic.kind === 'svg') {
      const image = graphic.svg ? graphicImageCache.get(graphic.svg) : null;
      if (image && image.complete && image.naturalWidth > 0) {
        const scale = Math.min(w / image.naturalWidth, h / image.naturalHeight);
        const drawWidth = image.naturalWidth * scale;
        const drawHeight = image.naturalHeight * scale;
        ctx.drawImage(image, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
      }
    } else if (graphic.kind === 'emoji') {
      const sprite = emojiSprite(graphic.emoji ?? '🙂');
      if (sprite) {
        const scale = Math.min(w / sprite.width, h / sprite.height);
        const drawWidth = sprite.width * scale;
        const drawHeight = sprite.height * scale;
        ctx.drawImage(sprite, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
      } else {
        ctx.save();
        ctx.beginPath();
        ctx.rect(-w / 2, -h / 2, w, h);
        ctx.clip();
        const fontSize = Math.max(8, Math.min(w, h) * 0.8);
        ctx.font = `${fontSize}px ${EMOJI_FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(graphic.emoji ?? '🙂', 0, 0);
        ctx.restore();
      }
    } else {
      ctx.beginPath();
      traceShape(ctx, graphic.kind, w, h, graphic.radius);
      if (graphic.fill && graphic.fill !== 'transparent') {
        ctx.fillStyle = createFill(ctx, graphic, w, h);
        ctx.fill();
      }
      if (graphic.pattern && graphic.pattern !== 'none') {
        ctx.save();
        ctx.beginPath();
        traceShape(ctx, graphic.kind, w, h, graphic.radius);
        ctx.clip();
        drawPattern(ctx, graphic.pattern, graphic.patternColor || '#ffffff', (graphic.patternScale ?? 14) * (height / 720), w, h);
        ctx.restore();
      }
      if (graphic.strokeWidth > 0 && graphic.stroke) {
        ctx.beginPath();
        traceShape(ctx, graphic.kind, w, h, graphic.radius);
        ctx.lineWidth = Math.max(0.5, graphic.strokeWidth);
        ctx.strokeStyle = graphic.stroke;
        ctx.stroke();
      }
    }
    ctx.restore();
  }
}
