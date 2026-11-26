/** Caption cues: parse SRT/VTT, write them back, and draw them on frames. */

import type { OverlayTransition } from './video-overlays';
import { TEXT_FONT_OPTIONS } from './title-fonts';

export { TEXT_FONT_OPTIONS } from './title-fonts';

export const TITLE_ACCENTS = ['side', 'rule', 'frame'] as const;
export type TitleAccent = typeof TITLE_ACCENTS[number];

export interface TextObjectStyle {
  fontFamily: string;
  /** Font size as a percentage of the frame's short side (1.4×height cap). */
  fontSize: number;
  fontWeight: number;
  italic: boolean;
  uppercase: boolean;
  color: string;
  align: 'left' | 'center' | 'right';
  /** Horizontal anchor in percent. */
  x: number;
  /** Vertical centre in percent. */
  y: number;
  /** Maximum line width in percent. */
  maxWidth: number;
  /** Rotation around the text anchor point. */
  rotation: number;
  lineHeight: number;
  /** Outline and shadow sizes are pixels at 720p and scale with the output. */
  outlineWidth: number;
  outlineColor: string;
  shadowBlur: number;
  shadowColor: string;
  shadowX: number;
  shadowY: number;
  background: string;
  backgroundOpacity: number;
  padding: number;
  radius: number;
  accent?: TitleAccent;
  accentColor?: string;
  detailLine?: 'first' | 'last';
  detailScale?: number;
  detailColor?: string;
}

export const DEFAULT_TITLE_TEXT_STYLE: TextObjectStyle = {
  fontFamily: TEXT_FONT_OPTIONS[0].value,
  fontSize: 6,
  fontWeight: 700,
  italic: false,
  uppercase: false,
  color: '#ffffff',
  align: 'center',
  x: 50,
  y: 82,
  maxWidth: 86,
  rotation: 0,
  lineHeight: 1.2,
  outlineWidth: 2,
  outlineColor: '#000000',
  shadowBlur: 12,
  shadowColor: '#000000',
  shadowX: 2,
  shadowY: 3,
  background: '#000000',
  backgroundOpacity: 0,
  padding: 8,
  radius: 8,
};

export const DEFAULT_SUBTITLE_TEXT_STYLE: TextObjectStyle = {
  fontFamily: TEXT_FONT_OPTIONS[0].value,
  fontSize: 4.5,
  fontWeight: 600,
  italic: false,
  uppercase: false,
  color: '#ffffff',
  align: 'center',
  x: 50,
  y: 86,
  maxWidth: 86,
  rotation: 0,
  lineHeight: 1.3,
  outlineWidth: 0,
  outlineColor: '#000000',
  shadowBlur: 0,
  shadowColor: '#000000',
  shadowX: 0,
  shadowY: 2,
  background: '#000000',
  backgroundOpacity: 0.62,
  padding: 10,
  radius: 6,
};

export function defaultTitleTextStyle(): TextObjectStyle {
  return { ...DEFAULT_TITLE_TEXT_STYLE };
}

export function defaultSubtitleTextStyle(): TextObjectStyle {
  return { ...DEFAULT_SUBTITLE_TEXT_STYLE };
}

export function normalizeTextStyle(value?: Partial<TextObjectStyle> | null, fallback = DEFAULT_SUBTITLE_TEXT_STYLE): TextObjectStyle {
  const source = value ?? {};
  const number = (key: keyof TextObjectStyle, low: number, high: number): number => {
    const raw = source[key];
    const parsed = typeof raw === 'number' ? raw : fallback[key];
    const numeric = typeof parsed === 'number' ? parsed : Number(parsed);
    return Number.isFinite(numeric) ? Math.max(low, Math.min(high, numeric)) : fallback[key] as number;
  };
  const color = (key: 'color' | 'outlineColor' | 'shadowColor' | 'background'): string => {
    const raw = source[key] ?? fallback[key];
    return typeof raw === 'string' && /^#[0-9a-f]{6}$/i.test(raw) ? raw.toLowerCase() : fallback[key] as string;
  };
  const family = typeof source.fontFamily === 'string' && source.fontFamily.trim()
    ? source.fontFamily
    : fallback.fontFamily;
  const align = source.align === 'left' || source.align === 'right' || source.align === 'center'
    ? source.align
    : fallback.align;
  const optionalColor = (value?: string): string | undefined =>
    typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : undefined;
  const accent = source.accent && TITLE_ACCENTS.includes(source.accent) ? source.accent : undefined;
  const detailLine = source.detailLine === 'first' || source.detailLine === 'last' ? source.detailLine : undefined;
  return {
    fontFamily: family,
    fontSize: number('fontSize', 1, 30),
    fontWeight: Math.round(number('fontWeight', 100, 900) / 100) * 100,
    italic: typeof source.italic === 'boolean' ? source.italic : fallback.italic,
    uppercase: typeof source.uppercase === 'boolean' ? source.uppercase : fallback.uppercase,
    color: color('color'),
    align,
    x: number('x', -50, 150),
    y: number('y', -20, 120),
    maxWidth: number('maxWidth', 5, 100),
    rotation: number('rotation', -180, 180),
    lineHeight: number('lineHeight', 0.8, 3),
    outlineWidth: number('outlineWidth', 0, 30),
    outlineColor: color('outlineColor'),
    shadowBlur: number('shadowBlur', 0, 80),
    shadowColor: color('shadowColor'),
    shadowX: number('shadowX', -80, 80),
    shadowY: number('shadowY', -80, 80),
    background: color('background'),
    backgroundOpacity: number('backgroundOpacity', 0, 1),
    padding: number('padding', 0, 80),
    radius: number('radius', 0, 100),
    ...(accent ? { accent, accentColor: optionalColor(source.accentColor) ?? color('color') } : {}),
    ...(detailLine ? {
      detailLine,
      detailScale: Math.max(0.2, Math.min(1.5, source.detailScale !== undefined && Number.isFinite(source.detailScale) ? source.detailScale : 0.55)),
      detailColor: optionalColor(source.detailColor) ?? color('color'),
    } : {}),
  };
}

export interface Cue {
  start: number;
  end: number;
  text: string;
  style?: TextObjectStyle;
  transition?: OverlayTransition;
  /** Video track row for standalone title cues; subtitles stay in the caption lane. */
  track?: number;
  /** Preset used to create a title, so its appearance can be reset after edits. */
  titlePreset?: string;
  /** Extra opacity from the title's video track, used while burning it in. */
  opacity?: number;
}

export interface CaptionStyle {
  /** Multiplier for the burned-in font size. */
  scale: number;
  position: 'bottom' | 'top';
}

export const DEFAULT_CAPTION_STYLE: CaptionStyle = { scale: 1, position: 'bottom' };

/** Convert the compact project-level caption style into a full text style. */
export function textStyleFromCaption(style: Partial<CaptionStyle> = DEFAULT_CAPTION_STYLE): TextObjectStyle {
  const scale = Math.max(0.2, Math.min(4, Number(style.scale) || 1));
  return normalizeTextStyle({
    ...DEFAULT_SUBTITLE_TEXT_STYLE,
    fontSize: DEFAULT_SUBTITLE_TEXT_STYLE.fontSize * scale,
    y: style.position === 'top' ? 10 : 86,
  }, DEFAULT_SUBTITLE_TEXT_STYLE);
}

/** Move every cue by `offset` seconds, dropping cues that fall before zero. */
export function shiftCues(cues: readonly Cue[], offset: number): Cue[] {
  if (!offset) return cues.map((cue) => ({ ...cue }));
  return cues
    .filter((cue) => cue.end + offset > 0)
    .map((cue) => {
      const start = Math.max(0, cue.start + offset);
      const end = Math.max(start + 0.05, cue.end + offset);
      return { ...cue, start, end };
    })
    .sort((a, b) => a.start - b.start);
}

function parseTime(value: string): number {
  const match = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/.exec(value.trim());
  if (!match) return NaN;
  const [, hours = '0', minutes, seconds, fraction] = match;
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds) + Number(fraction.padEnd(3, '0')) / 1000;
}

/** Parse SubRip or WebVTT text into cues. */
export function parseCaptions(text: string): Cue[] {
  const cues: Cue[] = [];
  const blocks = text.replace(/\r/g, '').replace(/^﻿/, '').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n').filter((line) => line.trim() !== '');
    const timing = lines.findIndex((line) => line.includes('-->'));
    if (timing < 0) continue;
    const [from, to] = lines[timing].split('-->');
    const start = parseTime(from);
    const end = parseTime(to.split(/\s+/).filter(Boolean)[0] ?? '');
    const body = lines.slice(timing + 1).join('\n').replace(/<[^>]+>/g, '').trim();
    if (Number.isFinite(start) && Number.isFinite(end) && end > start && body) cues.push({ start, end, text: body });
  }
  return cues.sort((a, b) => a.start - b.start);
}

function stamp(seconds: number, separator: '.' | ','): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const pad = (value: number, size = 2) => String(value).padStart(size, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}${separator}${pad(ms % 1000, 3)}`;
}

export function toVtt(cues: readonly Cue[]): string {
  return 'WEBVTT\n\n' + cues.map((cue) => `${stamp(cue.start, '.')} --> ${stamp(cue.end, '.')}\n${cue.text}`).join('\n\n') + '\n';
}

export function toSrt(cues: readonly Cue[]): string {
  return cues.map((cue, i) => `${i + 1}\n${stamp(cue.start, ',')} --> ${stamp(cue.end, ',')}\n${cue.text}`).join('\n\n') + '\n';
}

export function cueAt(cues: readonly Cue[], time: number): Cue | null {
  for (const cue of cues) {
    if (time >= cue.start && time < cue.end) return cue;
    if (cue.start > time) break;
  }
  return null;
}

/** Word-wrap a caption to fit `maxWidth`, keeping existing line breaks. */
function wrap(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (ctx.measureText(next).width > maxWidth && line) {
        lines.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    if (line) lines.push(line);
  }
  return lines.slice(-3);
}

export function titleTextParts(text: string, style: TextObjectStyle): { text: string; detail: boolean }[] {
  const index = style.detailLine === 'first' ? text.indexOf('\n') : style.detailLine === 'last' ? text.lastIndexOf('\n') : -1;
  if (index < 0) return [{ text, detail: false }];
  const first = text.slice(0, index).trim();
  const last = text.slice(index + 1).trim();
  if (!first || !last) return [{ text, detail: false }];
  return [{ text: first, detail: style.detailLine === 'first' }, { text: last, detail: style.detailLine === 'last' }];
}

export function titleAccentThickness(scale: number): number {
  return Math.max(0.5, 3 * scale);
}

/** Draw a styled text object or caption on a frame. */
export function drawCaption(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  text: string,
  width: number,
  height: number,
  style: CaptionStyle | TextObjectStyle = DEFAULT_CAPTION_STYLE,
  opacity = 1,
): void {
  const resolved = style && 'scale' in style
    ? textStyleFromCaption(style)
    : normalizeTextStyle(style, DEFAULT_SUBTITLE_TEXT_STYLE);
  const scale = height / 720;
  const size = Math.max(8, Math.round(Math.min(width, height * 1.4) * (resolved.fontSize / 100)));
  const content = resolved.uppercase ? text.toUpperCase() : text;
  const alpha = Math.max(0, Math.min(1, opacity));
  ctx.save();
  ctx.globalAlpha = alpha;
  const font = (fontSize: number) => (resolved.italic ? 'italic ' : '') + resolved.fontWeight + ' ' + fontSize + 'px ' + resolved.fontFamily;
  ctx.textBaseline = 'middle';
  ctx.textAlign = resolved.align === 'left' ? 'left' : resolved.align === 'right' ? 'right' : 'center';
  const padding = Math.max(0, resolved.padding * scale);
  const maxWidth = width * (resolved.maxWidth / 100);
  const textWidth = resolved.detailLine || resolved.accent ? Math.max(1, maxWidth - padding * 2) : maxWidth;
  let textHeight = 0;
  let maxLine = 0;
  const rows = titleTextParts(content, resolved).flatMap((part) => {
    const fontSize = part.detail ? Math.round(size * (resolved.detailScale ?? 0.55) * 100) / 100 : size;
    const lineHeight = fontSize * resolved.lineHeight;
    const face = font(fontSize);
    ctx.font = face;
    return wrap(ctx, part.text, textWidth).map((line) => {
      const offset = textHeight + lineHeight / 2;
      textHeight += lineHeight;
      maxLine = Math.max(maxLine, ctx.measureText(line).width);
      return { line, offset, face, color: part.detail ? resolved.detailColor ?? resolved.color : resolved.color };
    });
  });
  if (!rows.length) {
    ctx.restore();
    return;
  }
  const boxHeight = textHeight + padding * 2;
  const boxWidth = Math.min(maxWidth, maxLine + padding * 2);
  const anchorX = width * (resolved.x / 100);
  const anchorY = height * (resolved.y / 100);
  const left = resolved.align === 'left'
    ? 0
    : resolved.align === 'right'
      ? -boxWidth
      : -boxWidth / 2;
  const top = -boxHeight / 2;
  ctx.translate(anchorX, anchorY);
  ctx.rotate((resolved.rotation * Math.PI) / 180);
  if (resolved.backgroundOpacity > 0.001) {
    ctx.globalAlpha = resolved.backgroundOpacity * alpha;
    ctx.fillStyle = resolved.background;
    ctx.beginPath();
    ctx.roundRect(left, top, boxWidth, boxHeight, Math.max(0, resolved.radius * scale));
    ctx.fill();
    ctx.globalAlpha = alpha;
  }
  const textX = resolved.align === 'left'
    ? padding
    : resolved.align === 'right'
      ? -padding
      : 0;
  if (resolved.accent && resolved.accentColor) {
    const thickness = Math.min(titleAccentThickness(scale), boxWidth, boxHeight);
    ctx.fillStyle = resolved.accentColor;
    if (resolved.accent === 'frame') {
      ctx.strokeStyle = resolved.accentColor;
      ctx.lineWidth = thickness;
      ctx.beginPath();
      ctx.roundRect(left + thickness / 2, top + thickness / 2, boxWidth - thickness, boxHeight - thickness,
        Math.max(0, resolved.radius * scale - thickness / 2));
      ctx.stroke();
    } else if (resolved.accent === 'side') {
      ctx.fillRect(left, top, thickness, boxHeight);
    } else {
      ctx.fillRect(left + boxWidth * 0.32, top + boxHeight - thickness, boxWidth * 0.36, thickness);
    }
  }
  if (resolved.outlineWidth > 0.01) {
    ctx.strokeStyle = resolved.outlineColor;
    ctx.lineWidth = resolved.outlineWidth * scale;
    ctx.lineJoin = 'round';
    for (const row of rows) {
      ctx.font = row.face;
      ctx.strokeText(row.line, textX, top + padding + row.offset);
    }
  }
  if (resolved.shadowBlur > 0.01 || resolved.shadowX || resolved.shadowY) {
    ctx.shadowColor = resolved.shadowColor;
    ctx.shadowBlur = resolved.shadowBlur * scale;
    ctx.shadowOffsetX = resolved.shadowX * scale;
    ctx.shadowOffsetY = resolved.shadowY * scale;
  }
  for (const row of rows) {
    ctx.font = row.face;
    ctx.fillStyle = row.color;
    ctx.fillText(row.line, textX, top + padding + row.offset);
  }
  ctx.restore();
}
