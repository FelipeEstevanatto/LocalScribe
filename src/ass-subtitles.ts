import type { Cue } from './captions';

export interface AssCue extends Cue {
  assLine?: number;
  assEdits?: AssCueEdits;
}

export interface AssCueEdits {
  style?: Record<string, string>;
  event?: Record<string, string>;
  raw?: string;
}

const STYLE_SECTIONS = new Set(['[v4 styles]', '[v4+ styles]', '[v4++ styles]']);
export const ASS_EVENT_STYLE_FIELDS = ['marginl', 'marginr', 'marginv', 'margint', 'marginb', 'effect'];

export interface AssTrack {
  script: string;
  cues: readonly AssCue[];
  file: Blob;
}

export interface AssSegment extends AssTrack {
  start: number;
  end: number;
  sourceStart: number;
  speed: number;
}

function assTime(text: string): number {
  const match = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(text.trim());
  return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : NaN;
}

function assTextParts(source: string) {
  let drawing = false;
  return source.split(/(\{[^}]*\})/).filter(Boolean).map((raw) => {
    if (raw.startsWith('{')) {
      for (const mode of raw.matchAll(/\\(p\d+|r[^\\}]*)/g)) drawing = mode[1][0] === 'p' && Number(mode[1].slice(1)) > 0;
      return { raw, text: '' };
    }
    return { raw, text: drawing ? '' : raw.replace(/\\[Nn]/g, '\n').replace(/\\h/g, '\u00a0') };
  });
}

export function plainAssText(source: string): string {
  return assTextParts(source).map(({ text }) => text).join('').trim();
}

export function assDialogueWithText(raw: string, text: string): string {
  if (plainAssText(raw) === text) return raw;
  const parts = assTextParts(raw);
  const originalLength = parts.reduce((length, part) => length + [...part.text].length, 0);
  const characters = [...text];
  const encode = (value: string) => value.replace(/[{}]/g, (bracket) => bracket === '{' ? '｛' : '｝')
    .replace(/\r?\n/g, '\\N').replace(/\u00a0/g, '\\h');
  let originalEnd = 0;
  let start = 0;
  const result = parts.map((part) => {
    if (!part.text) return part.raw;
    originalEnd += [...part.text].length;
    const end = Math.round(originalEnd / originalLength * characters.length);
    const replacement = encode(characters.slice(start, end).join(''));
    start = end;
    return replacement;
  }).join('');
  return result + encode(characters.slice(start).join(''));
}

function columns(line: string): string[] {
  return line.slice(line.indexOf(':') + 1).split(',').map((column) => column.trim().toLowerCase());
}

function styleTable(script: string) {
  let active = false;
  let format: string[] = [];
  let insertAt = -1;
  const styles = new Map<string, Record<string, string>>();
  for (const [index, line] of script.split(/\r?\n/).entries()) {
    const value = line.trim();
    if (value.startsWith('[')) active = STYLE_SECTIONS.has(value.toLowerCase());
    if (!active) continue;
    if (/^Format:/i.test(value)) {
      format = columns(value);
      insertAt = index + 1;
    } else if (/^Style:/i.test(value) && format.includes('name')) {
      const values = value.slice(value.indexOf(':') + 1).split(',');
      const style = Object.fromEntries(format.map((key, i) => [key, values[i]?.trim() ?? '']));
      styles.set(style.name.toLowerCase(), style);
      insertAt = index + 1;
    }
  }
  return { format, insertAt, styles };
}

function* dialogueRows(script: string) {
  let events = false;
  let format: string[] = [];
  for (const [line, value] of script.split(/\r?\n/).entries()) {
    const trimmed = value.trimStart();
    if (trimmed.startsWith('[')) {
      events = trimmed.trim().toLowerCase() === '[events]';
      continue;
    }
    if (!events) continue;
    if (/^Format:/i.test(trimmed)) {
      format = columns(value);
      continue;
    }
    if (!/^Dialogue:/i.test(trimmed) || format.at(-1) !== 'text') continue;
    const fields: string[] = [];
    const prefix = value.slice(0, value.indexOf(':') + 1);
    let end = prefix.length;
    for (let i = 0; i < format.length - 1 && end > 0; i += 1) {
      const comma = value.indexOf(',', end);
      fields.push(value.slice(end, comma));
      end = comma + 1;
    }
    if (end === 0) continue;
    const start = assTime(fields[format.indexOf('start')] ?? '');
    const stop = assTime(fields[format.indexOf('end')] ?? '');
    if (stop > start) yield { line, start, end: stop, raw: value.slice(end), prefix, fields, format };
  }
}

export function readAssCues(script: string): AssCue[] {
  const cues: AssCue[] = [];
  for (const row of dialogueRows(script)) {
    const text = plainAssText(row.raw);
    if (text) cues.push({ start: row.start, end: row.end, text, assLine: row.line });
  }
  return cues.sort((a, b) => a.start - b.start);
}

export function readAssCueStyle(script: string, cue: AssCue) {
  const row = [...dialogueRows(script)].find(({ line }) => line === cue.assLine);
  if (!row) return null;
  const { styles } = styleTable(script);
  const name = row.fields[row.format.indexOf('style')]?.trim().replace(/^\*/, '') ?? '';
  const base = styles.get(name.toLowerCase()) ?? styles.get('default');
  const event = Object.fromEntries(ASS_EVENT_STYLE_FIELDS.flatMap((key) => {
    const index = row.format.indexOf(key);
    return index < 0 ? [] : [[key, row.fields[index].trim()]];
  }));
  return {
    name, style: { ...base, ...cue.assEdits?.style }, event: { ...event, ...cue.assEdits?.event },
    raw: assDialogueWithText(cue.assEdits?.raw ?? row.raw, cue.text),
  };
}

export function assScriptWithEdits(track: AssTrack): string {
  const byLine = new Map(track.cues.map((cue) => [cue.assLine, cue]));
  const lines = track.script.split(/\r?\n/);
  const table = track.cues.some((cue) => cue.assEdits?.style) ? styleTable(track.script) : undefined;
  const definitions: string[] = [];
  let changed = false;
  for (const row of dialogueRows(track.script)) {
    const cue = byLine.get(row.line);
    if (!cue) continue;
    const edits = cue.assEdits;
    const raw = edits?.raw ?? assDialogueWithText(row.raw, cue.text);
    if (!edits && raw === row.raw) continue;
    const fields = [...row.fields];
    const styleIndex = row.format.indexOf('style');
    if (edits?.style && table && table.insertAt >= 0 && styleIndex >= 0) {
      const baseName = fields[styleIndex].trim().replace(/^\*/, '').toLowerCase();
      const base = table.styles.get(baseName) ?? table.styles.get('default');
      let name = 'LocalscribeCue' + row.line;
      while (table.styles.has(name.toLowerCase())) name += '_';
      fields[styleIndex] = name;
      definitions.push('Style: ' + table.format.map((key) => key === 'name' ? name : edits.style?.[key] ?? base?.[key] ?? '').join(','));
    }
    for (const key of ASS_EVENT_STYLE_FIELDS) {
      const index = row.format.indexOf(key);
      const value = edits?.event?.[key];
      if (index >= 0 && value !== undefined) fields[index] = value;
    }
    lines[row.line] = row.prefix + fields.join(',') + ',' + raw;
    changed = true;
  }
  if (table && definitions.length) lines.splice(table.insertAt, 0, ...definitions);
  return changed ? lines.join('\n') : track.script;
}

export function assEventSpans(script: string): ReadonlyArray<{ start: number; end: number }> {
  return [...dialogueRows(script)].map(({ start, end }) => ({ start, end }));
}

export function assSegmentAt(segments: readonly AssSegment[], time: number): AssSegment | undefined {
  return segments.find((segment) => segment.start <= time && time < segment.end);
}
