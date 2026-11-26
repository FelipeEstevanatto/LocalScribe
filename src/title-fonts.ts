/**
 * Font families offered by the title and subtitle editor.
 *
 * The built-in list uses real family names that ship with Windows, macOS, and
 * common Office installs. Chromium browsers can additionally enumerate the
 * fonts installed on this device with the Local Font Access API, so the picker
 * can show previews for every family the machine actually has.
 */

export type TextFontCategory = 'Sans' | 'Serif' | 'Display' | 'Handwriting' | 'Mono' | 'Installed';

export interface TextFontOption {
  label: string;
  value: string;
  category: TextFontCategory;
  /** Present when the family came from the Local Font Access API. */
  installed?: boolean;
}

const SANS = 'sans-serif';
const SERIF = 'serif';
const DISPLAY = '"Arial Black", Impact, sans-serif';
const HAND = 'cursive';
const MONO = 'monospace';

export const TEXT_FONT_OPTIONS: TextFontOption[] = [
  { label: 'System UI', value: `system-ui, -apple-system, "Segoe UI", Roboto, ${SANS}`, category: 'Sans' },
  { label: 'Segoe UI', value: `"Segoe UI", system-ui, -apple-system, ${SANS}`, category: 'Sans' },
  { label: 'Arial', value: `Arial, "Helvetica Neue", Helvetica, ${SANS}`, category: 'Sans' },
  { label: 'Helvetica', value: `"Helvetica Neue", Helvetica, Arial, ${SANS}`, category: 'Sans' },
  { label: 'Calibri', value: `Calibri, Candara, "Segoe UI", ${SANS}`, category: 'Sans' },
  { label: 'Aptos', value: `Aptos, "Segoe UI", Calibri, ${SANS}`, category: 'Sans' },
  { label: 'Candara', value: `Candara, Calibri, "Segoe UI", ${SANS}`, category: 'Sans' },
  { label: 'Corbel', value: `Corbel, "Segoe UI", ${SANS}`, category: 'Sans' },
  { label: 'Tahoma', value: `Tahoma, Verdana, "Segoe UI", ${SANS}`, category: 'Sans' },
  { label: 'Trebuchet MS', value: `"Trebuchet MS", "Segoe UI", ${SANS}`, category: 'Sans' },
  { label: 'Verdana', value: `Verdana, Tahoma, ${SANS}`, category: 'Sans' },
  { label: 'Century Gothic', value: `"Century Gothic", "URW Gothic", Futura, ${SANS}`, category: 'Sans' },
  { label: 'Franklin Gothic', value: `"Franklin Gothic Medium", "Franklin Gothic", "Arial Narrow", ${SANS}`, category: 'Sans' },
  { label: 'Futura', value: `Futura, "Century Gothic", "Avenir Next", ${SANS}`, category: 'Sans' },
  { label: 'Avenir Next', value: `"Avenir Next", Avenir, "Segoe UI", ${SANS}`, category: 'Sans' },
  { label: 'Optima', value: `Optima, Candara, "Segoe UI", ${SANS}`, category: 'Sans' },
  { label: 'Gill Sans', value: `"Gill Sans", "Gill Sans MT", Calibri, ${SANS}`, category: 'Sans' },
  { label: 'Bahnschrift', value: `Bahnschrift, "DIN Alternate", "Segoe UI", ${SANS}`, category: 'Sans' },
  { label: 'Arial Narrow', value: `"Arial Narrow", "Aptos Narrow", "Segoe UI", ${SANS}`, category: 'Sans' },
  { label: 'Microsoft Sans Serif', value: `"Microsoft Sans Serif", "Segoe UI", ${SANS}`, category: 'Sans' },

  { label: 'Georgia', value: `Georgia, "Times New Roman", ${SERIF}`, category: 'Serif' },
  { label: 'Times New Roman', value: `"Times New Roman", Times, ${SERIF}`, category: 'Serif' },
  { label: 'Cambria', value: `Cambria, Constantia, Georgia, ${SERIF}`, category: 'Serif' },
  { label: 'Constantia', value: `Constantia, Cambria, Georgia, ${SERIF}`, category: 'Serif' },
  { label: 'Palatino', value: `"Palatino Linotype", Palatino, "Book Antiqua", Georgia, ${SERIF}`, category: 'Serif' },
  { label: 'Garamond', value: `Garamond, "EB Garamond", Georgia, ${SERIF}`, category: 'Serif' },
  { label: 'Book Antiqua', value: `"Book Antiqua", Palatino, Georgia, ${SERIF}`, category: 'Serif' },
  { label: 'Baskerville', value: `Baskerville, "Baskerville Old Face", Georgia, ${SERIF}`, category: 'Serif' },
  { label: 'Didot', value: `Didot, "Bodoni 72", "Bodoni MT", ${SERIF}`, category: 'Serif' },
  { label: 'Rockwell', value: `Rockwell, "Rockwell Nova", Georgia, ${SERIF}`, category: 'Serif' },
  { label: 'Bookman Old Style', value: `"Bookman Old Style", Bookman, Georgia, ${SERIF}`, category: 'Serif' },
  { label: 'Century Schoolbook', value: `"Century Schoolbook", "New Century Schoolbook", Georgia, ${SERIF}`, category: 'Serif' },
  { label: 'Iowan Old Style', value: `"Iowan Old Style", "Palatino Linotype", Georgia, ${SERIF}`, category: 'Serif' },
  { label: 'Sitka Text', value: `"Sitka Text", Cambria, Georgia, ${SERIF}`, category: 'Serif' },

  { label: 'Impact', value: `Impact, Haettenschweiler, ${DISPLAY}`, category: 'Display' },
  { label: 'Haettenschweiler', value: `Haettenschweiler, Impact, ${DISPLAY}`, category: 'Display' },
  { label: 'Arial Black', value: `"Arial Black", "Arial Bold", Impact, ${SANS}`, category: 'Display' },
  { label: 'Copperplate', value: `Copperplate, "Copperplate Gothic Bold", "Copperplate Gothic Light", ${DISPLAY}`, category: 'Display' },
  { label: 'Stencil', value: `Stencil, "Stencil Std", Impact, ${DISPLAY}`, category: 'Display' },
  { label: 'Playbill', value: `Playbill, "Playbill MT", Impact, ${DISPLAY}`, category: 'Display' },
  { label: 'Showcard Gothic', value: `"Showcard Gothic", Impact, ${DISPLAY}`, category: 'Display' },
  { label: 'Broadway', value: `Broadway, "Broadway MT", Impact, ${DISPLAY}`, category: 'Display' },
  { label: 'Wide Latin', value: `"Wide Latin", "Arial Black", Impact, ${DISPLAY}`, category: 'Display' },
  { label: 'Algerian', value: `Algerian, "Algerian MT", Impact, ${DISPLAY}`, category: 'Display' },
  { label: 'Bauhaus 93', value: `"Bauhaus 93", "Bauhaus", ${DISPLAY}`, category: 'Display' },
  { label: 'Chiller', value: `Chiller, "Chiller MT", Impact, ${DISPLAY}`, category: 'Display' },
  { label: 'Jokerman', value: `Jokerman, "Jokerman MT", ${DISPLAY}`, category: 'Display' },
  { label: 'Ravie', value: `Ravie, "Ravie MT", ${DISPLAY}`, category: 'Display' },
  { label: 'Elephant', value: `Elephant, "Elephant MT", ${DISPLAY}`, category: 'Display' },
  { label: 'Berlin Sans FB', value: `"Berlin Sans FB", "Berlin Sans", ${DISPLAY}`, category: 'Display' },
  { label: 'Magneto', value: `Magneto, "Magneto MT", ${DISPLAY}`, category: 'Display' },
  { label: 'Snap ITC', value: `"Snap ITC", Impact, ${DISPLAY}`, category: 'Display' },
  { label: 'Harrington', value: `Harrington, "Harrington MT", ${DISPLAY}`, category: 'Display' },

  { label: 'Segoe Script', value: `"Segoe Script", "Brush Script MT", ${HAND}`, category: 'Handwriting' },
  { label: 'Segoe Print', value: `"Segoe Print", "Comic Sans MS", ${HAND}`, category: 'Handwriting' },
  { label: 'Comic Sans MS', value: `"Comic Sans MS", "Comic Sans", ${HAND}`, category: 'Handwriting' },
  { label: 'Brush Script MT', value: `"Brush Script MT", "Brush Script", ${HAND}`, category: 'Handwriting' },
  { label: 'Lucida Handwriting', value: `"Lucida Handwriting", "Segoe Script", ${HAND}`, category: 'Handwriting' },
  { label: 'Ink Free', value: `"Ink Free", "Segoe Print", ${HAND}`, category: 'Handwriting' },
  { label: 'Bradley Hand ITC', value: `"Bradley Hand ITC", "Bradley Hand", ${HAND}`, category: 'Handwriting' },
  { label: 'Papyrus', value: `Papyrus, "Papyrus MT", ${HAND}`, category: 'Handwriting' },
  { label: 'Chalkboard', value: `Chalkboard, "Chalkboard SE", "Comic Sans MS", ${HAND}`, category: 'Handwriting' },
  { label: 'Marker Felt', value: `"Marker Felt", "Segoe Print", ${HAND}`, category: 'Handwriting' },
  { label: 'Mistral', value: `Mistral, "Brush Script MT", ${HAND}`, category: 'Handwriting' },
  { label: 'Freestyle Script', value: `"Freestyle Script", "Brush Script MT", ${HAND}`, category: 'Handwriting' },
  { label: 'French Script MT', value: `"French Script MT", "Brush Script MT", ${HAND}`, category: 'Handwriting' },
  { label: 'Edwardian Script ITC', value: `"Edwardian Script ITC", "Edwardian Script", ${HAND}`, category: 'Handwriting' },
  { label: 'Kunstler Script', value: `"Kunstler Script", "Brush Script MT", ${HAND}`, category: 'Handwriting' },
  { label: 'Lucida Calligraphy', value: `"Lucida Calligraphy", "Segoe Script", ${HAND}`, category: 'Handwriting' },

  { label: 'Consolas', value: `Consolas, "Cascadia Mono", ${MONO}`, category: 'Mono' },
  { label: 'Courier New', value: `"Courier New", Courier, ${MONO}`, category: 'Mono' },
  { label: 'Lucida Console', value: `"Lucida Console", Monaco, ${MONO}`, category: 'Mono' },
  { label: 'Cascadia Mono', value: `"Cascadia Mono", "Cascadia Code", Consolas, ${MONO}`, category: 'Mono' },
  { label: 'Menlo', value: `Menlo, Monaco, Consolas, ${MONO}`, category: 'Mono' },
  { label: 'Monaco', value: `Monaco, Menlo, Consolas, ${MONO}`, category: 'Mono' },
  { label: 'SF Mono', value: `"SF Mono", Menlo, Monaco, ${MONO}`, category: 'Mono' },
  { label: 'Andale Mono', value: `"Andale Mono", "Courier New", ${MONO}`, category: 'Mono' },
  { label: 'OCR A Extended', value: `"OCR A Extended", "OCR A Std", ${MONO}`, category: 'Mono' },
];

/** Extract a readable label from any CSS font-family stack. */
export function fontLabelFromValue(value: string): string {
  const first = value.split(',')[0]?.trim().replace(/^["']|["']$/g, '').replace(/\\"/g, '"') ?? '';
  return first || 'Custom';
}

/** Quote an installed family and append a fallback family. */
export function quoteFontFamily(family: string, fallback = SANS): string {
  const cleaned = family.trim();
  if (!cleaned) return fallback;
  return `"${cleaned.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}", ${fallback}`;
}

interface LocalFontData {
  family: string;
  fullName: string;
  postscriptName: string;
  style: string;
  weight: string;
  blob(): Promise<Blob>;
}

type FontWindow = Window & { queryLocalFonts?: () => Promise<LocalFontData[]> };

export function canLoadInstalledFonts(): boolean {
  return typeof window !== 'undefined' && typeof (window as FontWindow).queryLocalFonts === 'function';
}

/**
 * Read the families installed on this device. Browsers expose styles rather
 * than families, so entries are deduplicated by family name. Families already
 * in the built-in list are skipped to keep the picker free of duplicates.
 */
export async function loadInstalledFontChoices(): Promise<TextFontOption[]> {
  if (typeof window === 'undefined') return [];
  const query = (window as FontWindow).queryLocalFonts;
  if (typeof query !== 'function') return [];
  const available = await query.call(window);
  const seen = new Set(TEXT_FONT_OPTIONS.map((option) => option.label.toLowerCase()));
  const families = new Map<string, string>();
  for (const font of available) {
    const family = String(font.family ?? '').trim();
    const key = family.toLowerCase();
    if (!family || seen.has(key) || families.has(key)) continue;
    families.set(key, family);
  }
  return [...families.values()]
    .sort((a, b) => a.localeCompare(b))
    .map((family) => ({
      label: family,
      value: quoteFontFamily(family),
      category: 'Installed' as const,
      installed: true,
    }));
}
