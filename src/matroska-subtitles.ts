import type { SubtitleStreamInfo } from './audio-ffmpeg';

// Matroska Tracks and TrackEntry elements. Media blocks and attachments
// are skipped by their declared size, without loading whole payloads.
const EBML = 0x1a45dfa3;
const SEGMENT = 0x18538067;
const TRACKS = 0x1654ae6b;
const TRACK_ENTRY = 0xae;
const HEADER_WINDOW = 64 * 1024;
const MAX_TRACKS_BYTES = 2 * 1024 * 1024;

interface Element {
  id: number;
  start: number;
  end: number;
  unknownSize: boolean;
}

const subtitleCodecs: Record<string, string> = {
  'S_TEXT/UTF8': 'subrip',
  'S_TEXT/ASS': 'ass',
  'S_TEXT/SSA': 'ssa',
  'S_ASS': 'ass',
  'S_SSA': 'ssa',
  'S_TEXT/WEBVTT': 'webvtt',
  'D_WEBVTT/SUBTITLES': 'webvtt',
  'D_WEBVTT/CAPTIONS': 'webvtt',
  'D_WEBVTT/DESCRIPTIONS': 'webvtt',
  'D_WEBVTT/METADATA': 'webvtt',
  'S_HDMV/PGS': 'hdmv_pgs_subtitle',
  'S_VOBSUB': 'dvd_subtitle',
};

function readVint(bytes: Uint8Array, offset: number, keepMarker: boolean) {
  const first = bytes[offset];
  if (!first) return null;
  let marker = 0x80;
  let width = 1;
  while (!(first & marker)) {
    marker >>= 1;
    width += 1;
  }
  if (width > (keepMarker ? 4 : 8) || offset + width > bytes.length) return null;
  let value = keepMarker ? first : first & (marker - 1);
  let allOnes = !keepMarker && value === marker - 1;
  for (let i = 1; i < width; i += 1) {
    const byte = bytes[offset + i];
    value = value * 256 + byte;
    allOnes &&= byte === 255;
  }
  if (!allOnes && !Number.isSafeInteger(value)) return null;
  return { value, width, allOnes };
}

function elementAt(bytes: Uint8Array, offset: number, limit: number, base = 0): Element | null {
  const id = readVint(bytes, offset, true);
  if (!id) return null;
  const size = readVint(bytes, offset + id.width, false);
  if (!size) return null;
  const start = base + offset + id.width + size.width;
  if (start > limit || (!size.allOnes && size.value > limit - start)) return null;
  return { id: id.value, start, end: size.allOnes ? limit : start + size.value, unknownSize: size.allOnes };
}

function* children(bytes: Uint8Array, start: number, end: number): Generator<Element> {
  while (start < end) {
    const field = elementAt(bytes, start, end);
    if (!field || field.unknownSize) throw new Error('Incomplete Matroska track metadata');
    yield field;
    start = field.end;
  }
}

function readTracks(bytes: Uint8Array): SubtitleStreamInfo[] {
  const tracks: SubtitleStreamInfo[] = [];
  const decoder = new TextDecoder();
  for (const entry of children(bytes, 0, bytes.length)) {
    if (entry.id !== TRACK_ENTRY) continue;
    let subtitle = false;
    let codec = '';
    let language = 'eng';
    let languageTag = '';
    let title = '';
    let isDefault = true;
    let forced = false;
    for (const field of children(bytes, entry.start, entry.end)) {
      const data = bytes.subarray(field.start, field.end);
      switch (field.id) {
        case 0x83: subtitle = data.at(-1) === 17 && !data.subarray(0, -1).some(Boolean); break;
        case 0x86: codec = decoder.decode(data).replace(/\0+$/, ''); break;
        case 0x22b59c: language = decoder.decode(data).replace(/\0+$/, ''); break;
        case 0x22b59d: languageTag = decoder.decode(data).replace(/\0+$/, ''); break;
        case 0x536e: title = decoder.decode(data).replace(/\0+$/, ''); break;
        case 0x88: isDefault = data.some(Boolean); break;
        case 0x55aa: forced = data.some(Boolean); break;
      }
    }
    if (subtitle) {
      if (!codec) throw new Error('Missing Matroska subtitle codec');
      const tag = languageTag || language;
      tracks.push({
        index: tracks.length, codec: subtitleCodecs[codec] ?? codec,
        language: tag && tag !== 'und' ? tag : null, title: title || null, default: isDefault, forced,
      });
    }
  }
  return tracks;
}

const SEEK_HEAD = 0x114d9b74;
const ATTACHMENTS = 0x1941a469;

function uint(bytes: Uint8Array): number {
  let value = 0;
  for (const byte of bytes) value = value * 256 + byte;
  return value;
}

function seekPosition(bytes: Uint8Array, id: number): number | null {
  for (const seek of children(bytes, 0, bytes.length)) {
    if (seek.id !== 0x4dbb) continue;
    let targetId = 0;
    let position = -1;
    for (const field of children(bytes, seek.start, seek.end)) {
      const value = uint(bytes.subarray(field.start, field.end));
      if (field.id === 0x53ab) targetId = value;
      if (field.id === 0x53ac) position = value;
    }
    if (targetId === id && Number.isSafeInteger(position) && position >= 0) return position;
  }
  return null;
}

async function findSegmentElement(file: Blob, id: number): Promise<Element | null> {
  let windowOffset = -1;
  let bytes: Uint8Array = new Uint8Array();
  const readElement = async (at: number, end: number) => {
    if (at >= end) return null;
    if (at < windowOffset || at + 12 > windowOffset + bytes.length) {
      windowOffset = at;
      bytes = new Uint8Array(await file.slice(at, Math.min(end, at + HEADER_WINDOW)).arrayBuffer());
    }
    return elementAt(bytes, at - windowOffset, end, windowOffset);
  };
  const header = await readElement(0, file.size);
  if (header?.id !== EBML || header.unknownSize) return null;
  let segment = await readElement(header.end, file.size);
  while (segment && (segment.id === 0xec || segment.id === 0xbf) && !segment.unknownSize) {
    segment = await readElement(segment.end, file.size);
  }
  if (segment?.id !== SEGMENT) return null;
  let position = segment.start;
  for (let i = 0; i < 128; i += 1) {
    const element = await readElement(position, segment.end);
    if (!element || element.unknownSize) return null;
    if (element.id === id) return element;
    if (element.id === SEEK_HEAD && element.end - element.start <= HEADER_WINDOW) {
      try {
        const indexed = seekPosition(new Uint8Array(await file.slice(element.start, element.end).arrayBuffer()), id);
        if (indexed !== null) {
          const target = await readElement(segment.start + indexed, segment.end);
          if (target?.id === id && !target.unknownSize) return target;
        }
      } catch {
        // Malformed seek indexes do not prevent scanning the main headers.
      }
    }
    position = element.end;
  }
  return null;
}

/** Read only header metadata. Null leaves discovery to the FFmpeg probe. */
export async function readMatroskaSubtitleTracks(file: Blob): Promise<SubtitleStreamInfo[] | null> {
  const tracks = await findSegmentElement(file, TRACKS);
  if (!tracks || tracks.end - tracks.start > MAX_TRACKS_BYTES) return null;
  try {
    return readTracks(new Uint8Array(await file.slice(tracks.start, tracks.end).arrayBuffer()));
  } catch {
    return null;
  }
}

const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024;

/** Fonts are read from the source file when needed and stay on-device. */
export async function readMatroskaFonts(file: Blob): Promise<Uint8Array[]> {
  const attachments = await findSegmentElement(file, ATTACHMENTS);
  if (!attachments || attachments.end - attachments.start > MAX_ATTACHMENT_BYTES) return [];
  try {
    const bytes = new Uint8Array(await file.slice(attachments.start, attachments.end).arrayBuffer());
    const fonts: Uint8Array[] = [];
    const decoder = new TextDecoder();
    for (const attachment of children(bytes, 0, bytes.length)) {
      if (attachment.id !== 0x61a7) continue;
      let fontFile = false;
      let data: Uint8Array | undefined;
      for (const field of children(bytes, attachment.start, attachment.end)) {
        const value = bytes.subarray(field.start, field.end);
        if (field.id === 0x466e) fontFile ||= /\.(ttf|otf|ttc|otc|woff2?)\0*$/i.test(decoder.decode(value));
        if (field.id === 0x4660) fontFile ||= /font|opentype|truetype/i.test(decoder.decode(value));
        if (field.id === 0x465c) data = value;
      }
      if (fontFile && data?.length) fonts.push(data.slice());
    }
    return fonts;
  } catch {
    return [];
  }
}
