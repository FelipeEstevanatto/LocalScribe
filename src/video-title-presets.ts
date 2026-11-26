import { defaultTitleTextStyle, normalizeTextStyle, type TextObjectStyle } from './captions';
import { TEXT_FONT_OPTIONS } from './title-fonts';

export const TITLE_PRESET_GROUPS = ['Headlines', 'Lower thirds', 'Cards & credits'] as const;
export type TitlePresetGroup = typeof TITLE_PRESET_GROUPS[number];

interface TitlePreset {
  id: string;
  name: string;
  group: TitlePresetGroup;
  text: string;
  seconds: number;
  style: Partial<TextObjectStyle>;
}

const font = (label: string) => TEXT_FONT_OPTIONS.find((option) => option.label === label)?.value;

export const TITLE_PRESETS: readonly TitlePreset[] = [
  {
    id: 'title', name: 'Clean Title', group: 'Headlines', text: 'Your title', seconds: 3,
    style: { y: 50, fontSize: 10, fontWeight: 600, outlineWidth: 0, shadowBlur: 9 },
  },
  {
    id: 'lower', name: 'Name & Role', group: 'Lower thirds', text: 'Alex Morgan\nDocumentary filmmaker', seconds: 5,
    style: {
      x: 7, y: 82, align: 'left', maxWidth: 62, fontSize: 7.2, lineHeight: 1.28,
      background: '#0c1c34', backgroundOpacity: 0.94, padding: 22, radius: 0,
      detailLine: 'last', detailScale: 0.55, detailColor: '#b7d6ff', accent: 'side', accentColor: '#61aaff',
      outlineWidth: 0, shadowBlur: 0, shadowX: 0, shadowY: 0,
    },
  },
  {
    id: 'opening', name: 'Film Opening', group: 'Cards & credits', text: 'A FILM BY ALEX MORGAN\nA New Story', seconds: 5,
    style: {
      y: 49, maxWidth: 87, fontFamily: font('Georgia'), fontSize: 13, lineHeight: 1.24, fontWeight: 400,
      color: '#fff2d7', detailLine: 'first', detailScale: 0.3, detailColor: '#e4b471',
      outlineWidth: 0, shadowBlur: 14, padding: 26, accent: 'rule', accentColor: '#e4b471',
    },
  },
  {
    id: 'quote', name: 'Editorial Quote', group: 'Cards & credits', text: '“Stay curious.”\n— Alex Morgan', seconds: 5,
    style: {
      y: 49, maxWidth: 80, fontFamily: font('Georgia'), fontSize: 11.5, fontWeight: 400, italic: true, color: '#f9ecd9',
      background: '#27213d', backgroundOpacity: 0.9, padding: 31, radius: 13, outlineWidth: 0, shadowBlur: 0,
      shadowX: 0, shadowY: 0, detailLine: 'last', detailScale: 0.46, detailColor: '#c8b3ea',
    },
  },
  {
    id: 'impact', name: 'Impact Headline', group: 'Headlines', text: 'MAKE IT COUNT', seconds: 3,
    style: {
      y: 48, fontFamily: font('Impact'), fontSize: 16, fontWeight: 900, uppercase: true, maxWidth: 92,
      color: '#161c24', background: '#f8da57', backgroundOpacity: 1, radius: 0, padding: 21,
      outlineWidth: 0, shadowBlur: 0, shadowX: 0, shadowY: 0,
    },
  },
  {
    id: 'outline', name: 'Outline Headline', group: 'Headlines', text: 'AFTER HOURS', seconds: 3,
    style: {
      y: 50, fontFamily: font('Arial Black'), fontSize: 14, fontWeight: 900, uppercase: true, maxWidth: 93,
      color: '#141827', outlineWidth: 9, outlineColor: '#f8f5ff', shadowBlur: 9,
    },
  },
  {
    id: 'magazine', name: 'Magazine', group: 'Headlines', text: 'The Weekend Edit\nA guide to slowing down', seconds: 5,
    style: {
      x: 9, y: 47, maxWidth: 81, align: 'left', fontFamily: font('Georgia'), fontSize: 10.5, fontWeight: 400,
      color: '#302820', background: '#f3e5cf', backgroundOpacity: 1, radius: 0, padding: 27,
      outlineWidth: 0, shadowBlur: 0, shadowX: 0, shadowY: 0,
      detailLine: 'last', detailScale: 0.45, detailColor: '#8b493e',
    },
  },
  {
    id: 'neon', name: 'Neon Stamp', group: 'Headlines', text: 'AFTER DARK', seconds: 3,
    style: {
      x: 51, y: 52, rotation: -8, fontFamily: font('Arial Black'), fontSize: 11, fontWeight: 900, uppercase: true,
      color: '#ff9bd9', maxWidth: 86, background: '#220c35', backgroundOpacity: 0.95, radius: 8,
      accent: 'frame', accentColor: '#ff5cb8', padding: 22, outlineWidth: 0, shadowColor: '#d83a8e', shadowBlur: 11,
      shadowX: 0, shadowY: 0,
    },
  },
  {
    id: 'location', name: 'Location Tag', group: 'Lower thirds', text: 'Kyoto, Japan', seconds: 4,
    style: {
      x: 93, y: 84, align: 'right', maxWidth: 65, fontSize: 6.7, fontWeight: 700,
      color: '#082c2b', background: '#a6ede0', backgroundOpacity: 1, radius: 100, padding: 17,
      outlineWidth: 0, shadowBlur: 0, shadowX: 0, shadowY: 0,
    },
  },
  {
    id: 'broadcast', name: 'Broadcast', group: 'Lower thirds', text: 'LIVE REPORT\nFrom the studio', seconds: 4,
    style: {
      x: 6, y: 79, align: 'left', maxWidth: 79, fontFamily: font('Arial'), fontSize: 8, fontWeight: 900,
      detailLine: 'last', detailScale: 0.54, detailColor: '#ffdad7', color: '#ffffff', background: '#9c242d',
      backgroundOpacity: 0.97, accent: 'side', accentColor: '#ff9a77', radius: 0, padding: 21,
      outlineWidth: 0, shadowBlur: 0, shadowX: 0, shadowY: 0,
    },
  },
  {
    id: 'chapter', name: 'Chapter Card', group: 'Cards & credits', text: 'CHAPTER 01\nThe Turning Point', seconds: 4,
    style: {
      x: 9, y: 53, maxWidth: 82, align: 'left', fontFamily: font('Cascadia Mono'), fontSize: 8, fontWeight: 700,
      color: '#edfdf0', detailLine: 'first', detailScale: 0.53, detailColor: '#a5e897', outlineWidth: 0,
      background: '#102b26', backgroundOpacity: 0.96, radius: 0, padding: 25, accent: 'frame', accentColor: '#6db686',
      shadowBlur: 0, shadowX: 0, shadowY: 0,
    },
  },
  {
    id: 'credits', name: 'End Credit', group: 'Cards & credits', text: 'DIRECTED BY\nAlex Morgan', seconds: 5,
    style: {
      y: 54, maxWidth: 85, fontFamily: font('Times New Roman'), fontSize: 10.8, fontWeight: 400,
      color: '#f5f4ef', detailLine: 'first', detailScale: 0.42, detailColor: '#c8cbd5',
      background: '#080b12', backgroundOpacity: 0.9, radius: 0, padding: 25, outlineWidth: 0, shadowBlur: 0,
      shadowX: 0, shadowY: 0, accent: 'rule', accentColor: '#b0b5c3',
    },
  },
];

export function findTitlePreset(id?: string): TitlePreset | undefined {
  return TITLE_PRESETS.find((preset) => preset.id === id);
}

export function titlePresetStyle(preset: TitlePreset): TextObjectStyle {
  return normalizeTextStyle(preset.style, defaultTitleTextStyle());
}
