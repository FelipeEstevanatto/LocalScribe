/**
 * Catalog and format definitions for the Universal File Converter (VERT feature set).
 *
 * Supports video, audio, image, and document conversions,
 * with context-aware compatible target formats and configurable options.
 */

export type FileCategory = 'video' | 'audio' | 'image' | 'document';

export interface FormatMeta {
  id: string;
  label: string;
  category: FileCategory;
  ext: string;
  mime: string;
  description: string;
  popular?: boolean;
}

export interface VideoSettings {
  resolution: 'source' | '1080p' | '720p' | '480p' | '360p' | '240p' | 'custom';
  customWidth?: number;
  customHeight?: number;
  codec: 'auto' | 'libx264' | 'libvpx' | 'mpeg4' | 'copy';
  crf: number; // 15 to 35 (23 default)
  fps: 'source' | '60' | '30' | '24' | '15';
  audioStream: 'keep' | 'mute' | 'aac' | 'mp3' | 'opus';
  audioBitrate: '64k' | '128k' | '192k' | '256k' | '320k';
}

export interface AudioSettings {
  bitrate: '64k' | '96k' | '128k' | '192k' | '256k' | '320k';
  sampleRate: 'source' | '48000' | '44100' | '22050' | '16000';
  channels: 'source' | 'stereo' | 'mono';
  volume: number; // 0.2 to 2.5 (1.0 default)
}

export interface ImageSettings {
  quality: number; // 10 to 100 (90 default)
  resizeMode: 'none' | 'percent' | 'custom';
  scalePercent: 25 | 50 | 75 | 100 | 150 | 200;
  customWidth?: number;
  customHeight?: number;
  keepAspectRatio: boolean;
  grayscale: boolean;
  backgroundColor: 'white' | 'black' | 'transparent';
  rotation: 0 | 90 | 180 | 270;
}

export interface DocumentSettings {
  dpi: 72 | 150 | 300;
  pageSelection: 'all' | 'first' | 'range';
  pageRange?: string; // e.g. "1-3"
}

export interface ConverterSettings {
  video: VideoSettings;
  audio: AudioSettings;
  image: ImageSettings;
  document: DocumentSettings;
}

export function defaultSettings(): ConverterSettings {
  return {
    video: {
      resolution: 'source',
      codec: 'auto',
      crf: 23,
      fps: 'source',
      audioStream: 'keep',
      audioBitrate: '192k',
    },
    audio: {
      bitrate: '192k',
      sampleRate: 'source',
      channels: 'source',
      volume: 1.0,
    },
    image: {
      quality: 90,
      resizeMode: 'none',
      scalePercent: 100,
      keepAspectRatio: true,
      grayscale: false,
      backgroundColor: 'white',
      rotation: 0,
    },
    document: {
      dpi: 150,
      pageSelection: 'all',
    },
  };
}

export const FORMAT_REGISTRY: Record<string, FormatMeta> = {
  // Video formats
  mp4: { id: 'mp4', label: 'MP4', category: 'video', ext: 'mp4', mime: 'video/mp4', description: 'MPEG-4 Part 14 universal container', popular: true },
  webm: { id: 'webm', label: 'WebM', category: 'video', ext: 'webm', mime: 'video/webm', description: 'WebM open HTML5 video', popular: true },
  mkv: { id: 'mkv', label: 'MKV', category: 'video', ext: 'mkv', mime: 'video/x-matroska', description: 'Matroska multimedia container', popular: true },
  avi: { id: 'avi', label: 'AVI', category: 'video', ext: 'avi', mime: 'video/x-msvideo', description: 'Audio Video Interleave container' },
  mov: { id: 'mov', label: 'MOV', category: 'video', ext: 'mov', mime: 'video/quicktime', description: 'Apple QuickTime Movie', popular: true },
  wmv: { id: 'wmv', label: 'WMV', category: 'video', ext: 'wmv', mime: 'video/x-ms-wmv', description: 'Windows Media Video' },
  flv: { id: 'flv', label: 'FLV', category: 'video', ext: 'flv', mime: 'video/x-flv', description: 'Flash Video format' },
  gifv: { id: 'gifv', label: 'GIF (Video)', category: 'video', ext: 'gif', mime: 'image/gif', description: 'Looping animated GIF video snippet', popular: true },
  '3gp': { id: '3gp', label: '3GP', category: 'video', ext: '3gp', mime: 'video/3gpp', description: '3GPP mobile multimedia' },
  mpg: { id: 'mpg', label: 'MPG', category: 'video', ext: 'mpg', mime: 'video/mpeg', description: 'MPEG-1/MPEG-2 Video' },
  mpeg: { id: 'mpeg', label: 'MPEG', category: 'video', ext: 'mpeg', mime: 'video/mpeg', description: 'MPEG-1/MPEG-2 Video' },
  ogv: { id: 'ogv', label: 'OGV', category: 'video', ext: 'ogv', mime: 'video/ogg', description: 'Ogg Theora open video' },
  ts: { id: 'ts', label: 'TS', category: 'video', ext: 'ts', mime: 'video/mp2t', description: 'MPEG Transport Stream' },
  m4v: { id: 'm4v', label: 'M4V', category: 'video', ext: 'm4v', mime: 'video/x-m4v', description: 'Apple iTunes Video' },

  // Audio formats
  mp3: { id: 'mp3', label: 'MP3', category: 'audio', ext: 'mp3', mime: 'audio/mpeg', description: 'MPEG-1 Audio Layer III', popular: true },
  wav: { id: 'wav', label: 'WAV', category: 'audio', ext: 'wav', mime: 'audio/wav', description: 'Uncompressed PCM waveform audio', popular: true },
  flac: { id: 'flac', label: 'FLAC', category: 'audio', ext: 'flac', mime: 'audio/flac', description: 'Free Lossless Audio Codec', popular: true },
  aac: { id: 'aac', label: 'AAC', category: 'audio', ext: 'aac', mime: 'audio/aac', description: 'Advanced Audio Coding' },
  m4a: { id: 'm4a', label: 'M4A', category: 'audio', ext: 'm4a', mime: 'audio/mp4', description: 'MPEG-4 Audio container', popular: true },
  ogg: { id: 'ogg', label: 'OGG', category: 'audio', ext: 'ogg', mime: 'audio/ogg', description: 'Ogg Vorbis audio', popular: true },
  opus: { id: 'opus', label: 'OPUS', category: 'audio', ext: 'opus', mime: 'audio/ogg', description: 'Opus high-efficiency audio', popular: true },
  aiff: { id: 'aiff', label: 'AIFF', category: 'audio', ext: 'aiff', mime: 'audio/aiff', description: 'Audio Interchange File Format' },
  wma: { id: 'wma', label: 'WMA', category: 'audio', ext: 'wma', mime: 'audio/x-ms-wma', description: 'Windows Media Audio' },
  caf: { id: 'caf', label: 'CAF', category: 'audio', ext: 'caf', mime: 'audio/x-caf', description: 'Apple Core Audio Format' },
  ac3: { id: 'ac3', label: 'AC3', category: 'audio', ext: 'ac3', mime: 'audio/ac3', description: 'Dolby Digital AC-3 Audio' },
  amr: { id: 'amr', label: 'AMR', category: 'audio', ext: 'amr', mime: 'audio/amr', description: 'Adaptive Multi-Rate Speech' },
  weba: { id: 'weba', label: 'WebA', category: 'audio', ext: 'weba', mime: 'audio/webm', description: 'WebM Audio stream' },

  // Image formats
  png: { id: 'png', label: 'PNG', category: 'image', ext: 'png', mime: 'image/png', description: 'Portable Network Graphics (lossless)', popular: true },
  jpg: { id: 'jpg', label: 'JPG', category: 'image', ext: 'jpg', mime: 'image/jpeg', description: 'JPEG standard compressed image', popular: true },
  jpeg: { id: 'jpeg', label: 'JPEG', category: 'image', ext: 'jpeg', mime: 'image/jpeg', description: 'JPEG standard compressed image' },
  webp: { id: 'webp', label: 'WebP', category: 'image', ext: 'webp', mime: 'image/webp', description: 'Google modern web image format', popular: true },
  gif: { id: 'gif', label: 'GIF', category: 'image', ext: 'gif', mime: 'image/gif', description: 'Graphics Interchange Format', popular: true },
  bmp: { id: 'bmp', label: 'BMP', category: 'image', ext: 'bmp', mime: 'image/bmp', description: 'Windows Bitmap image' },
  tiff: { id: 'tiff', label: 'TIFF', category: 'image', ext: 'tiff', mime: 'image/tiff', description: 'Tagged Image File Format' },
  tif: { id: 'tif', label: 'TIF', category: 'image', ext: 'tif', mime: 'image/tiff', description: 'Tagged Image File Format' },
  ico: { id: 'ico', label: 'ICO', category: 'image', ext: 'ico', mime: 'image/x-icon', description: 'Windows Icon resource file', popular: true },
  svg: { id: 'svg', label: 'SVG', category: 'image', ext: 'svg', mime: 'image/svg+xml', description: 'Scalable Vector Graphics' },
  avif: { id: 'avif', label: 'AVIF', category: 'image', ext: 'avif', mime: 'image/avif', description: 'AV1 next-gen image format', popular: true },

  // Document & data formats
  pdf: { id: 'pdf', label: 'PDF', category: 'document', ext: 'pdf', mime: 'application/pdf', description: 'Portable Document Format', popular: true },
  docx: { id: 'docx', label: 'DOCX', category: 'document', ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', description: 'Microsoft Word Document', popular: true },
  txt: { id: 'txt', label: 'TXT', category: 'document', ext: 'txt', mime: 'text/plain', description: 'Plain text file', popular: true },
  html: { id: 'html', label: 'HTML', category: 'document', ext: 'html', mime: 'text/html', description: 'HyperText Markup Language', popular: true },
  htm: { id: 'htm', label: 'HTM', category: 'document', ext: 'htm', mime: 'text/html', description: 'HyperText Markup Language' },
  md: { id: 'md', label: 'Markdown', category: 'document', ext: 'md', mime: 'text/markdown', description: 'Markdown formatted document', popular: true },
  json: { id: 'json', label: 'JSON', category: 'document', ext: 'json', mime: 'application/json', description: 'JavaScript Object Notation', popular: true },
  csv: { id: 'csv', label: 'CSV', category: 'document', ext: 'csv', mime: 'text/csv', description: 'Comma-Separated Values', popular: true },
  rtf: { id: 'rtf', label: 'RTF', category: 'document', ext: 'rtf', mime: 'application/rtf', description: 'Rich Text Format' },
  xml: { id: 'xml', label: 'XML', category: 'document', ext: 'xml', mime: 'application/xml', description: 'Extensible Markup Language' },
};

/** Normalizes file extension to lowercase without leading dot */
export function normalizeExtension(nameOrExt: string): string {
  const clean = nameOrExt.trim().toLowerCase();
  if (clean.includes('.')) {
    return clean.split('.').pop() || '';
  }
  return clean.replace(/^\./, '');
}

const aliases: Record<string, string> = {
  markdown: 'md', htm: 'html', text: 'txt', log: 'txt', jpe: 'jpg', aif: 'aiff', oga: 'ogg',
  m2ts: 'ts', mts: 'ts', vob: 'mpeg', qt: 'mov',
};

function canonicalExtension(ext: string): string {
  const normalized = normalizeExtension(ext);
  return Object.hasOwn(aliases, normalized) ? aliases[normalized] : normalized;
}

export function detectFileFormat(file: File): { category: FileCategory; ext: string; meta?: FormatMeta } {
  const extension = file.name.includes('.') ? canonicalExtension(file.name) : '';
  const mime = file.type.toLowerCase().split(';')[0];
  const registered = Object.hasOwn(FORMAT_REGISTRY, extension) ? FORMAT_REGISTRY[extension] : undefined;
  if (registered) return { category: registered.category, ext: registered.id, meta: registered };

  const byMime = Object.values(FORMAT_REGISTRY).find(format => format.mime === mime);
  if (byMime) return { category: byMime.category, ext: byMime.id, meta: byMime };
  if (mime.startsWith('video/')) return { category: 'video', ext: extension };
  if (mime.startsWith('audio/')) return { category: 'audio', ext: extension };
  if (mime.startsWith('image/')) return { category: 'image', ext: extension };
  return { category: 'document', ext: extension };
}

/** Returns list of available target formats for a given source category and extension */
export function getAvailableTargetFormats(sourceCategory: FileCategory, sourceExt: string): FormatMeta[] {
  const normExt = canonicalExtension(sourceExt);

  if (sourceCategory === 'video') {
    // Videos can convert to other video formats or extract to audio formats
    const videoTargets = Object.values(FORMAT_REGISTRY).filter((f) => f.category === 'video' && f.id !== normExt);
    const audioTargets = Object.values(FORMAT_REGISTRY).filter((f) => f.category === 'audio');
    return [...videoTargets, ...audioTargets];
  }

  if (sourceCategory === 'audio') {
    // Audio files convert to other audio formats
    return Object.values(FORMAT_REGISTRY).filter((f) => f.category === 'audio' && f.id !== normExt);
  }

  if (sourceCategory === 'image') {
    // Image files convert to other image formats, plus PDF
    const imageTargets = Object.values(FORMAT_REGISTRY).filter((f) => f.category === 'image' && f.id !== normExt);
    return [...imageTargets, FORMAT_REGISTRY.pdf];
  }

  if (sourceCategory === 'document') {
    if (normExt === 'pdf') {
      // PDF can convert to docx, html, images, or text/md
      return [
        FORMAT_REGISTRY.docx,
        FORMAT_REGISTRY.html,
        FORMAT_REGISTRY.png,
        FORMAT_REGISTRY.jpg,
        FORMAT_REGISTRY.webp,
        FORMAT_REGISTRY.txt,
        FORMAT_REGISTRY.md,
      ];
    }
    if (normExt === 'docx') {
      // DOCX can convert to HTML, TXT, MD, PDF
      return [FORMAT_REGISTRY.html, FORMAT_REGISTRY.txt, FORMAT_REGISTRY.md, FORMAT_REGISTRY.pdf];
    }
    if (normExt === 'md' || normExt === 'markdown') {
      return [FORMAT_REGISTRY.html, FORMAT_REGISTRY.txt, FORMAT_REGISTRY.pdf];
    }
    if (normExt === 'html' || normExt === 'htm') {
      return [FORMAT_REGISTRY.md, FORMAT_REGISTRY.txt, FORMAT_REGISTRY.pdf];
    }
    if (normExt === 'json') {
      return [FORMAT_REGISTRY.csv, FORMAT_REGISTRY.txt];
    }
    if (normExt === 'csv') {
      return [FORMAT_REGISTRY.json, FORMAT_REGISTRY.txt];
    }
    if (normExt === 'rtf') {
      return [FORMAT_REGISTRY.txt, FORMAT_REGISTRY.html, FORMAT_REGISTRY.md];
    }
    if (normExt === 'txt' || normExt === 'xml') {
      return [FORMAT_REGISTRY.pdf, FORMAT_REGISTRY.html, FORMAT_REGISTRY.md, FORMAT_REGISTRY.json];
    }
  }

  return [];
}

/** Determines a recommended default target format for a source file */
export function getDefaultTargetFormat(sourceCategory: FileCategory, sourceExt: string): string {
  const normExt = canonicalExtension(sourceExt);

  if (sourceCategory === 'video') {
    return normExt === 'mp4' ? 'webm' : 'mp4';
  }
  if (sourceCategory === 'audio') {
    return normExt === 'mp3' ? 'wav' : 'mp3';
  }
  if (sourceCategory === 'image') {
    if (normExt === 'png') return 'webp';
    if (normExt === 'jpg' || normExt === 'jpeg') return 'png';
    return 'jpg';
  }
  if (sourceCategory === 'document') {
    if (normExt === 'pdf') return 'docx';
    if (normExt === 'docx') return 'pdf';
    if (normExt === 'md') return 'html';
    if (normExt === 'html') return 'md';
    if (normExt === 'json') return 'csv';
    if (normExt === 'csv') return 'json';
    if (normExt === 'rtf') return 'txt';
    return getAvailableTargetFormats(sourceCategory, normExt)[0]?.id ?? '';
  }
  return 'mp4';
}
