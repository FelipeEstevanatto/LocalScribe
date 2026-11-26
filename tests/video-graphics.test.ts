import { describe, expect, test } from 'bun:test';
import {
  defaultEmojiGraphic,
  defaultGradientGraphic,
  defaultGraphic,
  defaultPatternGraphic,
  defaultSvgGraphic,
  drawGraphics,
  graphicGradientCss,
  graphicLabel,
  graphicPatternCss,
  GRAPHIC_GRADIENT_PRESETS,
  GRAPHIC_PATTERN_PRESETS,
  preloadGraphicImages,
  type GraphicClip,
} from '../src/video-graphics';

function fakeContext() {
  const calls: string[] = [];
  const ctx = {
    save: () => calls.push('save'),
    restore: () => calls.push('restore'),
    translate: () => calls.push('translate'),
    rotate: () => calls.push('rotate'),
    beginPath: () => calls.push('beginPath'),
    roundRect: (...args: number[]) => calls.push(`roundRect:${args.join(',')}`),
    rect: (...args: number[]) => calls.push(`rect:${args.join(',')}`),
    ellipse: (...args: number[]) => calls.push(`ellipse:${args.length}`),
    fill: () => calls.push('fill'),
    stroke: () => calls.push('stroke'),
    moveTo: () => calls.push('moveTo'),
    lineTo: () => calls.push('lineTo'),
    clip: () => calls.push('clip'),
    arc: () => calls.push('arc'),
    fillRect: () => calls.push('fillRect'),
    fillText: (...args: unknown[]) => calls.push(`fillText:${String(args[0])}`),
    createLinearGradient: () => {
      calls.push('linearGradient');
      return { addColorStop: (stop: number, color: string) => calls.push(`stop:${stop}:${color}`) } as CanvasGradient;
    },
    createRadialGradient: () => {
      calls.push('radialGradient');
      return { addColorStop: (stop: number, color: string) => calls.push(`stop:${stop}:${color}`) } as CanvasGradient;
    },
    set fillStyle(value: string | CanvasGradient) { calls.push(`fillStyle:${typeof value === 'string' ? value : 'gradient'}`); },
    set strokeStyle(value: string) { calls.push(`strokeStyle:${value}`); },
    set lineWidth(value: number) { calls.push(`lineWidth:${value}`); },
    set lineCap(value: string) { calls.push(`lineCap:${value}`); },
    set font(value: string) { calls.push(`font:${value.split(' ')[0]}`); },
    set textAlign(value: string) { calls.push(`textAlign:${value}`); },
    set textBaseline(value: string) { calls.push(`textBaseline:${value}`); },
    set globalAlpha(value: number) { calls.push(`alpha:${value}`); },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

describe('graphic overlays', () => {
  test('builds rectangle, ellipse and line defaults', () => {
    const rect = defaultGraphic('rect', 1, 1, 3);
    const ellipse = defaultGraphic('ellipse', 2, 1, 3);
    const line = defaultGraphic('line', 3, 1, 3);
    expect(graphicLabel(rect.kind)).toBe('Rectangle');
    expect(graphicLabel(ellipse.kind)).toBe('Ellipse');
    expect(graphicLabel(line.kind)).toBe('Line');
    expect(rect.fill).toBe('#6366f1');
    expect(ellipse.fill).toBe('#22d3ee');
    expect(line.strokeWidth).toBeGreaterThan(0);
    expect(rect.end - rect.start).toBe(2);
  });

  test('draws only graphics active at the requested time', () => {
    const graphic: GraphicClip = {
      ...defaultGraphic('rect', 1, 1, 3),
      x: 10, y: 20, width: 30, height: 40, rotation: 15, strokeWidth: 2,
    };
    const { ctx, calls } = fakeContext();
    drawGraphics(ctx, 1000, 500, [graphic], 2);
    expect(calls).toContain('fill');
    expect(calls).toContain('stroke');
    expect(calls).toContain('translate');
    expect(calls).toContain('rotate');
    expect(calls.some((call) => call.startsWith('roundRect:'))).toBe(true);
    expect(calls).toContain('alpha:0.82');

    const outside = fakeContext();
    drawGraphics(outside.ctx, 1000, 500, [graphic], 5);
    expect(outside.calls).toEqual([]);
  });

  test('applies per-shape transition opacity', () => {
    const graphic: GraphicClip = {
      ...defaultGraphic('rect', 1, 1, 3),
      transition: 'fade-in',
    };
    const start = fakeContext();
    drawGraphics(start.ctx, 1000, 500, [graphic], 1);
    expect(start.calls).toContain('alpha:0');
    const middle = fakeContext();
    drawGraphics(middle.ctx, 1000, 500, [graphic], 2);
    expect(middle.calls).toContain('alpha:0.82');
  });

  test('library presets create pattern, gradient, SVG, and emoji overlays', () => {
    const pattern = defaultPatternGraphic(GRAPHIC_PATTERN_PRESETS[0], 4, 1, 5);
    expect(pattern.pattern).toBe('stripes');
    expect(pattern.patternColor).toBeTruthy();
    expect(graphicPatternCss(pattern.pattern, '#fff', 12)?.image).toContain('repeating-linear-gradient');

    const gradient = defaultGradientGraphic(GRAPHIC_GRADIENT_PRESETS[0], 5, 1, 5);
    expect(gradient.fillType).toBe('linear');
    expect(gradient.fill2).toBeTruthy();
    expect(gradient.fill).not.toBe(gradient.fill2);
    expect(graphicGradientCss(gradient)).toContain(`linear-gradient(${GRAPHIC_GRADIENT_PRESETS[0].angle}deg`);
    const radialPreset = GRAPHIC_GRADIENT_PRESETS.find((preset) => preset.type === 'radial')!;
    const radial = defaultGradientGraphic(radialPreset, 6, 1, 5);
    expect(graphicGradientCss(radial)).toContain('radial-gradient');

    const svg = defaultSvgGraphic(7, 1, 5, 'data:image/svg+xml;base64,PHN2Zy8+', 'Logo');
    expect(svg.kind).toBe('svg');
    expect(svg.name).toBe('Logo');
    expect(svg.svg).toContain('image/svg+xml');

    const emoji = defaultEmojiGraphic(8, 1, 5, '🎉');
    expect(emoji.kind).toBe('emoji');
    expect(emoji.emoji).toBe('🎉');
    expect(graphicLabel('emoji')).toBe('Emoji');
  });

  test('preloading graphics outside the browser is a no-op', async () => {
    await expect(preloadGraphicImages([
      defaultSvgGraphic(9, 0, 5, 'data:image/svg+xml;base64,PHN2Zy8+', 'Logo'),
      defaultEmojiGraphic(10, 0, 5, '🎉'),
    ])).resolves.toBeUndefined();
  });

  test('draws gradient, pattern, and emoji fills', () => {
    const gradient = { ...defaultGradientGraphic(GRAPHIC_GRADIENT_PRESETS[0], 8, 0, 5), opacity: 1, strokeWidth: 0 };
    const gradientContext = fakeContext();
    drawGraphics(gradientContext.ctx, 800, 400, [gradient], 1);
    expect(gradientContext.calls).toContain('linearGradient');
    expect(gradientContext.calls).toContain('fillStyle:gradient');

    const pattern = { ...defaultPatternGraphic(GRAPHIC_PATTERN_PRESETS[3], 9, 0, 5), opacity: 1, strokeWidth: 0 };
    const patternContext = fakeContext();
    drawGraphics(patternContext.ctx, 800, 400, [pattern], 1);
    expect(patternContext.calls).toContain('clip');
    expect(patternContext.calls).toContain('fill');

    const emoji = { ...defaultEmojiGraphic(10, 0, 5, '🎉'), opacity: 1 };
    const emojiContext = fakeContext();
    drawGraphics(emojiContext.ctx, 800, 400, [emoji], 1);
    expect(emojiContext.calls).toContain('fillText:🎉');
    expect(emojiContext.calls).toContain('textAlign:center');
  });

  test('draws a rotated line with the configured stroke', () => {
    const line: GraphicClip = {
      ...defaultGraphic('line', 2, 0, 10),
      x: 25, y: 50, width: 50, rotation: -30, strokeWidth: 8,
    };
    const { ctx, calls } = fakeContext();
    drawGraphics(ctx, 800, 400, [line], 1);
    expect(calls).toContain('moveTo');
    expect(calls).toContain('lineTo');
    expect(calls).toContain('stroke');
    expect(calls).toContain('lineWidth:8');
    expect(calls).toContain('lineCap:round');
  });
});
