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
      return `${index + 1}\n${clock(segment.start, ',')} --> ${clock(segment.end, ',')}\n${labelled(segment)}\n`;
    })
    .join('\n')}`;
}

function vtt(input: ExportInput): string {
  const cues = timedSegments(input)
    .map((segment) => {
      const body = segment.text.replace(/\r?\n/g, ' ').trim();
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

function csv(input: ExportInput): string {
  // The speaker column only appears once diarization has run.
  const speakers = hasSpeakers(input);
  const rows = timedSegments(input).map((segment) => {
    // Quoting preserves commas and line breaks. Prefix formula-like text so
    // spreadsheets open imported transcripts as data.
    const text = /^[=+\-@]/.test(segment.text) ? `'${segment.text}` : segment.text;
    const quoted = `"${text.replace(/"/g, '""')}"`;
    if (!speakers) return `${segment.start.toFixed(3)},${segment.end.toFixed(3)},${quoted}`;
    const speaker = (segment.speaker ?? '').replace(/"/g, '""');
    return `${segment.start.toFixed(3)},${segment.end.toFixed(3)},"${speaker}",${quoted}`;
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
