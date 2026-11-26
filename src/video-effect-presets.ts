import { normalizeEffects, type ClipEffects } from './video-effects';

export type VideoEffectCategory = 'basic' | 'color' | 'blur' | 'creative' | 'stylize';

export interface VideoEffectPreset {
  id: string;
  name: string;
  description: string;
  category: VideoEffectCategory;
  /** CSS approximation used by the library card preview. */
  filter: string;
  adjust: {
    brightness?: number;
    contrast?: number;
    saturation?: number;
    hue?: number;
    blur?: number;
    curve?: Partial<ClipEffects['curve']>;
  };
}

export const VIDEO_EFFECT_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'basic', label: 'Basic' },
  { id: 'color', label: 'Color' },
  { id: 'blur', label: 'Blur' },
  { id: 'creative', label: 'Creative' },
  { id: 'stylize', label: 'Stylize' },
] as const;

export type VideoEffectFilter = (typeof VIDEO_EFFECT_FILTERS)[number]['id'];

export const VIDEO_EFFECTS: VideoEffectPreset[] = [
  {
    id: 'brightness',
    name: 'Brightness',
    description: 'Lift midtones and highlights',
    category: 'basic',
    filter: 'brightness(1.15)',
    adjust: { brightness: 15 },
  },
  {
    id: 'contrast',
    name: 'Contrast',
    description: 'Punchier shadows and highlights',
    category: 'basic',
    filter: 'contrast(1.2)',
    adjust: { contrast: 20 },
  },
  {
    id: 'saturation',
    name: 'Saturation',
    description: 'Boost or mute colour intensity',
    category: 'basic',
    filter: 'saturate(1.25)',
    adjust: { saturation: 25 },
  },
  {
    id: 'tonal-balance',
    name: 'Tonal balance',
    description: 'Shape shadows, mids, and highlights',
    category: 'basic',
    filter: 'contrast(1.06) brightness(1.03)',
    adjust: { contrast: 4, curve: { shadows: 8, midtones: 4, highlights: -6 } },
  },
  {
    id: 'exposure',
    name: 'Exposure',
    description: 'Open up the whole image',
    category: 'basic',
    filter: 'brightness(1.25) contrast(1.04)',
    adjust: { brightness: 25, contrast: 4 },
  },
  {
    id: 'fade',
    name: 'Fade',
    description: 'Lifted blacks and softer colour',
    category: 'basic',
    filter: 'brightness(1.08) contrast(.85) saturate(.9)',
    adjust: { brightness: 8, contrast: -15, saturation: -10 },
  },
  {
    id: 'warm',
    name: 'Warm',
    description: 'Golden highlights and richer skin',
    category: 'color',
    filter: 'sepia(.16) saturate(1.15) brightness(1.03)',
    adjust: { hue: -8, saturation: 12, brightness: 3 },
  },
  {
    id: 'cool',
    name: 'Cool',
    description: 'Blue shadows and calmer colour',
    category: 'color',
    filter: 'hue-rotate(10deg) saturate(.95) brightness(.98)',
    adjust: { hue: 10, saturation: -5, brightness: -2 },
  },
  {
    id: 'mono',
    name: 'Mono',
    description: 'Remove colour completely',
    category: 'color',
    filter: 'grayscale(1)',
    adjust: { saturation: -100 },
  },
  {
    id: 'sepia',
    name: 'Sepia',
    description: 'Warm archival brown tones',
    category: 'color',
    filter: 'sepia(.7) saturate(.85)',
    adjust: { saturation: -55, hue: 28, brightness: 4 },
  },
  {
    id: 'vivid',
    name: 'Vivid',
    description: 'Bold colour and crisp contrast',
    category: 'color',
    filter: 'saturate(1.35) contrast(1.1)',
    adjust: { saturation: 35, contrast: 10 },
  },
  {
    id: 'vintage',
    name: 'Vintage',
    description: 'Muted colour and soft contrast',
    category: 'color',
    filter: 'sepia(.22) contrast(.9) saturate(.85)',
    adjust: { saturation: -18, contrast: -10, curve: { shadows: 6, highlights: -6 } },
  },
  {
    id: 'soft-blur',
    name: 'Soft blur',
    description: 'Gentle diffusion',
    category: 'blur',
    filter: 'blur(1.5px)',
    adjust: { blur: 3 },
  },
  {
    id: 'heavy-blur',
    name: 'Heavy blur',
    description: 'Strong background haze',
    category: 'blur',
    filter: 'blur(5px)',
    adjust: { blur: 9 },
  },
  {
    id: 'dream',
    name: 'Dream',
    description: 'Soft glow and lifted colour',
    category: 'creative',
    filter: 'blur(1px) brightness(1.1) saturate(1.1)',
    adjust: { blur: 2, brightness: 10, saturation: 10 },
  },
  {
    id: 'glow',
    name: 'Glow',
    description: 'Bright highlights and gentle contrast',
    category: 'creative',
    filter: 'brightness(1.14) contrast(.92) saturate(1.05)',
    adjust: { brightness: 14, contrast: -8, saturation: 5 },
  },
  {
    id: 'bleach',
    name: 'Bleach',
    description: 'Desaturated with strong contrast',
    category: 'creative',
    filter: 'saturate(.6) contrast(1.25)',
    adjust: { saturation: -40, contrast: 25 },
  },
  {
    id: 'neon',
    name: 'Neon',
    description: 'Electric colour and contrast',
    category: 'creative',
    filter: 'saturate(1.45) contrast(1.15) hue-rotate(14deg)',
    adjust: { saturation: 45, contrast: 15, hue: 14 },
  },
  {
    id: 'high-key',
    name: 'High key',
    description: 'Airy, bright, low contrast',
    category: 'stylize',
    filter: 'brightness(1.24) contrast(.88)',
    adjust: { brightness: 24, contrast: -12 },
  },
  {
    id: 'low-key',
    name: 'Low key',
    description: 'Dark, moody, high contrast',
    category: 'stylize',
    filter: 'brightness(.82) contrast(1.18)',
    adjust: { brightness: -18, contrast: 18 },
  },
  {
    id: 'film',
    name: 'Film',
    description: 'Cine contrast with a warm bias',
    category: 'stylize',
    filter: 'contrast(1.12) saturate(.9) sepia(.08)',
    adjust: { contrast: 12, saturation: -10, curve: { shadows: 6, highlights: 4 } },
  },
  {
    id: 'noir',
    name: 'Noir',
    description: 'Monochrome with deep blacks',
    category: 'stylize',
    filter: 'grayscale(1) contrast(1.22)',
    adjust: { saturation: -100, contrast: 22 },
  },
  {
    id: 'pastel',
    name: 'Pastel',
    description: 'Soft, bright, low-contrast colour',
    category: 'stylize',
    filter: 'saturate(.88) brightness(1.12) contrast(.92)',
    adjust: { saturation: -12, brightness: 12, contrast: -8 },
  },
];

/** Stack a preset on top of the clip's existing colour adjustments. */
export function applyVideoEffect(
  preset: VideoEffectPreset,
  current?: Partial<ClipEffects> | null,
): ClipEffects {
  const effects = normalizeEffects(current);
  const adjust = preset.adjust;
  return normalizeEffects({
    ...effects,
    brightness: effects.brightness + (adjust.brightness ?? 0),
    contrast: effects.contrast + (adjust.contrast ?? 0),
    saturation: effects.saturation + (adjust.saturation ?? 0),
    hue: effects.hue + (adjust.hue ?? 0),
    blur: effects.blur + (adjust.blur ?? 0),
    curve: {
      shadows: effects.curve.shadows + (adjust.curve?.shadows ?? 0),
      midtones: effects.curve.midtones + (adjust.curve?.midtones ?? 0),
      highlights: effects.curve.highlights + (adjust.curve?.highlights ?? 0),
    },
  });
}

/** Clear the preset stack without touching masks, keying, LUTs, or speed. */
export function resetVideoEffects(current?: Partial<ClipEffects> | null): ClipEffects {
  const effects = normalizeEffects(current);
  return normalizeEffects({
    ...effects,
    brightness: 0,
    contrast: 0,
    saturation: 0,
    hue: 0,
    blur: 0,
    curve: { shadows: 0, midtones: 0, highlights: 0 },
  });
}
