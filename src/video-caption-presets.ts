import { normalizeTextStyle, textStyleFromCaption, type CaptionStyle, type TextObjectStyle } from './captions';

export const CAPTION_PRESETS = [
  { id: 'default', label: 'Default / Original' },
  { id: 'streaming', label: 'Netflix-inspired' },
  { id: 'anime', label: 'Anime' },
] as const;

export type CaptionPreset = typeof CAPTION_PRESETS[number]['id'];

export function normalizeCaptionPreset(value: unknown): CaptionPreset {
  return CAPTION_PRESETS.find(({ id }) => id === value)?.id ?? 'default';
}

export function presetCaptionStyle(preset: CaptionPreset, options?: CaptionStyle): TextObjectStyle {
  const base = textStyleFromCaption(options);
  if (preset === 'default') return base;
  const scale = options?.scale ?? 1;
  return normalizeTextStyle(preset === 'streaming' ? {
    ...base, fontFamily: 'Arial, Helvetica, sans-serif', fontSize: 4.8 * scale, fontWeight: 400,
    color: '#ffffff', backgroundOpacity: 0.48, padding: 8, radius: 3,
    outlineWidth: 0, shadowBlur: 4, shadowX: 0, shadowY: 2,
  } : {
    ...base, fontFamily: '"Trebuchet MS", Arial, sans-serif', fontSize: 5.1 * scale, fontWeight: 700,
    color: '#ffffff', backgroundOpacity: 0, padding: 3,
    outlineWidth: 4, outlineColor: '#000000', shadowBlur: 4, shadowX: 1, shadowY: 2,
  }, base);
}
