/**
 * Transcript export builders.
 *
 * Segments carry the timing information produced by the ASR pipeline, so SRT
 * and VTT can be generated without re-running anything. All formats are built
 * in memory and downloaded as a Blob; nothing touches the network.
 */

import type { WordTiming } from './transformers-asr';

export type ExportFormat = 'txt' | 'srt' | 'vtt' | 'md' | 'json' | 'csv';

export interface ExportSegment {
  start: number;
  end: number;
  text: string;
  partial?: boolean;
  words?: WordTiming[];
  /** Speaker name from diarization. */
  speaker?: string;
}

export interface ExportInput {
  text: string;
  segments: ReadonlyArray<ExportSegment>;
  duration: number;
  fileName: string | null;
  modelName: string;
  createdAt: Date;
}

export interface ExportFile {
  body: string;
  extension: string;
  mime: string;
  label: string;
}

export const EXPORT_FORMATS: Array<{
  id: ExportFormat;
  label: string;
  extension: string;
  mime: string;
}> = [
  { id: 'txt', label: 'Plain text', extension: 'txt', mime: 'text/plain;charset=utf-8' },
  { id: 'srt', label: 'Subtitles (SRT)', extension: 'srt', mime: 'application/x-subrip;charset=utf-8' },
  { id: 'vtt', label: 'Web captions (VTT)', extension: 'vtt', mime: 'text/vtt;charset=utf-8' },
  { id: 'md', label: 'Markdown', extension: 'md', mime: 'text/markdown;charset=utf-8' },
  { id: 'json', label: 'JSON', extension: 'json', mime: 'application/json;charset=utf-8' },
  { id: 'csv', label: 'CSV', extension: 'csv', mime: 'text/csv;charset=utf-8' },
];

function pad(value: number, width = 2): string {
  return String(Math.max(0, Math.floor(value))).padStart(width, '0');
}

function clock(seconds: number, separator: ',' | '.'): string {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const totalMs = Math.round(safe * 1000);
  const millis = totalMs % 1000;
  const totalSeconds = Math.floor(totalMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const whole = totalSeconds % 60;
  return `${pad(hours)}:${pad(minutes)}:${pad(whole)}${separator}${pad(millis, 3)}`;
}

const MAX_ALIGN_CELLS = 4_000_000;

/**
 * Carry edits made in the transcript text box onto the timed segments.
 *
 * Words are aligned with a longest-common-subsequence pass after trimming the
 * shared prefix and suffix, so typical small edits stay cheap even on long
 * transcripts. Inserted words join the segment of the word before them;
 * deleted words disappear from their segment. Word timings are dropped from a
 * segment whose text changed, because they no longer match. When the text is
 * unchanged the original segments are returned as they are.
 */
export function realignSegments(
  segments: ReadonlyArray<ExportSegment>,
  editedText: string,
): ExportSegment[] {
  const source: Array<{ word: string; segment: number }> = [];
  segments.forEach((segment, index) => {
    for (const word of segment.text.split(/\s+/)) if (word) source.push({ word, segment: index });
  });
  const edited = editedText.split(/\s+/).filter(Boolean);
  if (!segments.length) return [];
  if (source.length === edited.length && source.every((item, i) => item.word === edited[i])) {
    return segments.map((segment) => ({ ...segment }));
  }

  // owner[i] = segment index for edited word i.
  const owner = new Array<number>(edited.length).fill(-1);
  let head = 0;
  while (head < source.length && head < edited.length && source[head].word === edited[head]) {
    owner[head] = source[head].segment;
    head += 1;
  }
  let tailSource = source.length - 1;
  let tailEdited = edited.length - 1;
  while (tailSource >= head && tailEdited >= head && source[tailSource].word === edited[tailEdited]) {
    owner[tailEdited] = source[tailSource].segment;
    tailSource -= 1;
    tailEdited -= 1;
  }

  const rows = tailSource - head + 1;
  const cols = tailEdited - head + 1;
  if (rows > 0 && cols > 0 && rows * cols <= MAX_ALIGN_CELLS) {
    const width = cols + 1;
    const table = new Uint32Array((rows + 1) * width);
    for (let r = rows - 1; r >= 0; r -= 1) {
      for (let c = cols - 1; c >= 0; c -= 1) {
        table[r * width + c] = source[head + r].word === edited[head + c]
          ? table[(r + 1) * width + c + 1] + 1
          : Math.max(table[(r + 1) * width + c], table[r * width + c + 1]);
      }
    }
    let r = 0;
    let c = 0;
    while (r < rows && c < cols) {
      if (source[head + r].word === edited[head + c]) {
        owner[head + c] = source[head + r].segment;
        r += 1;
        c += 1;
      } else if (table[(r + 1) * width + c] >= table[r * width + c + 1]) {
        r += 1;
      } else {
        c += 1;
      }
    }
  } else if (cols > 0 && rows > 0) {
    // Too large to align exactly: spread the changed words proportionally.
    for (let c = 0; c < cols; c += 1) {
      owner[head + c] = source[head + Math.min(rows - 1, Math.floor((c / cols) * rows))].segment;
    }
  }

  // Unmatched (inserted) words follow the previous word, or the next one at the start.
  let previous = -1;
  for (let i = 0; i < owner.length; i += 1) {
    if (owner[i] >= 0) previous = owner[i];
    else if (previous >= 0) owner[i] = previous;
  }
  let next = segments.length - 1;
  for (let i = owner.length - 1; i >= 0; i -= 1) {
    if (owner[i] >= 0) next = owner[i];
    else owner[i] = next;
  }

  const buckets = segments.map(() => [] as string[]);
  edited.forEach((word, i) => buckets[Math.max(0, owner[i])].push(word));
  return segments.map((segment, index) => {
    const text = buckets[index].join(' ');
    const changed = text !== segment.text.split(/\s+/).filter(Boolean).join(' ');
    return changed ? { ...segment, text, words: undefined } : { ...segment };
  });
}

function timedSegments(input: ExportInput): ExportSegment[] {
  const segments = input.segments
    .filter((segment) => segment.text.trim().length > 0)
    .map((segment) => ({
      start: segment.start,
      end: Math.max(segment.start, segment.end),
      text: segment.text.trim(),
      words: segment.words,
      speaker: segment.speaker,
    }));

  if (segments.length) return segments;

  const text = input.text.trim();
  if (!text) return [];
  return [{ start: 0, end: Math.max(1, input.duration), text }];
}

const hasSpeakers = (input: ExportInput) => input.segments.some((segment) => segment.speaker);

/** "Name: text" when the segment has a speaker. */
function labelled(segment: ExportSegment): string {
  const body = segment.text.replace(/\r?\n/g, ' ').trim();
  return segment.speaker ? `${segment.speaker}: ${body}` : body;
}

function plainText(input: ExportInput): string {
  if (hasSpeakers(input)) return `${timedSegments(input).map(labelled).join('\n\n')}\n`;
  const text = input.text.trim();
  if (text) return `${text}\n`;
  return `${timedSegments(input)
    .map((segment) => segment.text)
    .join(' ')}\n`;
}

function srt(input: ExportInput): string {
  return `${timedSegments(input)
    .map((segment, index) => {
      // A "-->" inside the text would be parsed as a timing line.
      return `${index + 1}\n${clock(segment.start, ',')} --> ${clock(segment.end, ',')}\n${labelled(segment).replace(/-->/g, '->')}\n`;
    })
    .join('\n')}`;
}

function vtt(input: ExportInput): string {
  const cues = timedSegments(input)
    .map((segment) => {
      // Cue text must not contain "-->" and must escape & and <, or players
      // read it as a timing line or a tag.
      const body = segment.text.replace(/\r?\n/g, ' ').trim()
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      // WebVTT voice spans name the speaker so players can style or show it.
      const voiced = segment.speaker ? `<v ${segment.speaker.replace(/[<>&]/g, '')}>${body}` : body;
      return `${clock(segment.start, '.')} --> ${clock(segment.end, '.')}\n${voiced}`;
    })
    .join('\n\n');
  return `WEBVTT\n\n${cues}\n`;
}

function markdown(input: ExportInput): string {
  const title = input.fileName ?? 'Untitled recording';
  const totalSeconds = Math.max(0, Math.round(input.duration));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const duration = `${minutes}:${pad(seconds)}`;
  const body = hasSpeakers(input)
    ? timedSegments(input).map((segment) => `**${segment.speaker ?? 'Speaker'}** · ${clock(segment.start, '.').slice(0, 8)}  \n${segment.text}`).join('\n\n')
    : input.text.trim();
  return [
    `# ${title}`,
    '',
    `> Transcribed locally with **${input.modelName}** on ${input.createdAt.toLocaleString()}.`,
    `> Audio length ${duration}. No audio or text left the device.`,
    '',
    body,
    '',
  ].join('\n');
}

function json(input: ExportInput): string {
  return `${JSON.stringify(
    {
      fileName: input.fileName,
      model: input.modelName,
      createdAt: input.createdAt.toISOString(),
      durationSeconds: Number(input.duration.toFixed(3)),
      text: input.text.trim(),
      segments: timedSegments(input).map((segment) => ({
        start: Number(segment.start.toFixed(3)),
        end: Number(segment.end.toFixed(3)),
        text: segment.text,
        speaker: segment.speaker,
        words: segment.words,
        wordTimingSource: segment.words ? 'model-estimated from original transcript' : undefined,
      })),
    },
    null,
    2,
  )}\n`;
}

/**
 * Quote a CSV cell. Text a spreadsheet would run as a formula (a leading =,
 * +, -, @, tab or carriage return, also after leading spaces) gets a leading
 * apostrophe so it opens as data.
 */
export function csvCell(value: string): string {
  const safe = /^[ ]*[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

function csv(input: ExportInput): string {
  // The speaker column only appears once diarization has run.
  const speakers = hasSpeakers(input);
  const rows = timedSegments(input).map((segment) => {
    // Quoting preserves commas and line breaks. Prefix formula-like text so
    // spreadsheets open imported transcripts as data.
    const quoted = csvCell(segment.text);
    if (!speakers) return `${segment.start.toFixed(3)},${segment.end.toFixed(3)},${quoted}`;
    return `${segment.start.toFixed(3)},${segment.end.toFixed(3)},${csvCell(segment.speaker ?? '')},${quoted}`;
  });
  const header = speakers ? 'start_seconds,end_seconds,speaker,text' : 'start_seconds,end_seconds,text';
  return [header, ...rows, ''].join('\r\n');
}

export function buildExport(format: ExportFormat, input: ExportInput): ExportFile {
  const meta = EXPORT_FORMATS.find((entry) => entry.id === format) ?? EXPORT_FORMATS[0];
  let body: string;

  switch (format) {
    case 'srt':
      body = srt(input);
      break;
    case 'vtt':
      body = vtt(input);
      break;
    case 'md':
      body = markdown(input);
      break;
    case 'json':
      body = json(input);
      break;
    case 'csv':
      body = csv(input);
      break;
    default:
      body = plainText(input);
  }

  return {
    body,
    extension: meta.extension,
    mime: meta.mime,
    label: meta.label,
  };
}
