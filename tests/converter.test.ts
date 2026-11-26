import { describe, expect, it } from 'bun:test';
import {
  detectFileFormat,
  getAvailableTargetFormats,
  getDefaultTargetFormat,
  normalizeExtension,
  FORMAT_REGISTRY,
  defaultSettings,
} from '../src/converter-catalog';
import {
  csvToJson,
  convertFile,
  htmlToMarkdown,
  jsonToCsv,
  markdownToHtml,
  rtfToText,
  selectPdfPages,
} from '../src/converter-engine';
import { audioArgs, videoArgs } from '../src/converter-media';

describe('Converter Catalog & Registry', () => {
  it('registers comprehensive media & document formats', () => {
    expect(FORMAT_REGISTRY.mp4).toBeDefined();
    expect(FORMAT_REGISTRY.webm).toBeDefined();
    expect(FORMAT_REGISTRY.mp3).toBeDefined();
    expect(FORMAT_REGISTRY.wav).toBeDefined();
    expect(FORMAT_REGISTRY.flac).toBeDefined();
    expect(FORMAT_REGISTRY.png).toBeDefined();
    expect(FORMAT_REGISTRY.webp).toBeDefined();
    expect(FORMAT_REGISTRY.avif).toBeDefined();
    expect(FORMAT_REGISTRY.ico).toBeDefined();
    expect(FORMAT_REGISTRY.pdf).toBeDefined();
    expect(FORMAT_REGISTRY.docx).toBeDefined();
    expect(FORMAT_REGISTRY.json).toBeDefined();
    expect(FORMAT_REGISTRY.csv).toBeDefined();
  });

  it('normalizes extensions properly', () => {
    expect(normalizeExtension('.MP4')).toBe('mp4');
    expect(normalizeExtension('sample.tar.gz')).toBe('gz');
    expect(normalizeExtension('video.mkv')).toBe('mkv');
    expect(normalizeExtension('   .WEBP  ')).toBe('webp');
  });

  it('detects file category from file object', () => {
    const videoFile = new File([''], 'movie.mp4', { type: 'video/mp4' });
    expect(detectFileFormat(videoFile).category).toBe('video');

    const audioFile = new File([''], 'song.flac', { type: 'audio/flac' });
    expect(detectFileFormat(audioFile).category).toBe('audio');

    const imageFile = new File([''], 'photo.avif', { type: 'image/avif' });
    expect(detectFileFormat(imageFile).category).toBe('image');

    const docFile = new File([''], 'contract.pdf', { type: 'application/pdf' });
    expect(detectFileFormat(docFile).category).toBe('document');
  });

  it('provides target formats and recommended defaults', () => {
    const videoTargets = getAvailableTargetFormats('video', 'mp4');
    expect(videoTargets.some((t) => t.id === 'webm')).toBe(true);
    expect(videoTargets.some((t) => t.id === 'mp3')).toBe(true); // Audio extraction

    const audioTargets = getAvailableTargetFormats('audio', 'mp3');
    expect(audioTargets.some((t) => t.id === 'wav')).toBe(true);
    expect(audioTargets.some((t) => t.id === 'ogg')).toBe(true);

    const imageTargets = getAvailableTargetFormats('image', 'png');
    expect(imageTargets.some((t) => t.id === 'webp')).toBe(true);
    expect(imageTargets.some((t) => t.id === 'pdf')).toBe(true); // Image to PDF

    expect(getDefaultTargetFormat('video', 'mp4')).toBe('webm');
    expect(getDefaultTargetFormat('audio', 'mp3')).toBe('wav');
    expect(getDefaultTargetFormat('image', 'png')).toBe('webp');
    expect(getDefaultTargetFormat('document', 'pdf')).toBe('docx');
  });

  it('initializes default settings with balanced parameters', () => {
    const s = defaultSettings();
    expect(s.video.crf).toBe(23);
    expect(s.audio.bitrate).toBe('192k');
    expect(s.image.quality).toBe(90);
    expect(s.document.dpi).toBe(150);
  });

  it('gives every supported document input a valid default and rejects unknown input', () => {
    for (const ext of ['pdf', 'docx', 'txt', 'markdown', 'htm', 'json', 'csv', 'rtf', 'xml']) {
      const source = detectFileFormat(new File(['fixture'], 'document.' + ext));
      expect(getAvailableTargetFormats(source.category, source.ext).map(format => format.id))
        .toContain(getDefaultTargetFormat(source.category, source.ext));
    }
    expect(detectFileFormat(new File(['fixture'], 'document', { type: 'application/pdf' })).ext).toBe('pdf');
    expect(getDefaultTargetFormat('document', 'xlsx')).toBe('');
  });

  it('uses compatible codecs and explicit muxers for legacy outputs', () => {
    const settings = defaultSettings();
    expect(videoArgs('webm', settings.video, 'out.webm')).toContain('libvpx');
    expect(videoArgs('wmv', settings.video, 'out.wmv')).toContain('wmv2');
    expect(videoArgs('ogv', settings.video, 'out.ogv')).toContain('libtheora');
    expect(audioArgs('weba', settings.audio, 'out.weba').slice(-3)).toEqual(['-f', 'webm', 'out.weba']);
    expect(audioArgs('amr', settings.audio, 'out.pcm')).toContain('8000');
  });
});

describe('Document & Data Transcoding', () => {
  it('converts JSON to CSV and back', () => {
    const sample = [
      { id: '1', name: 'Alice', city: 'Paris' },
      { id: '2', name: 'Bob, Jr.', city: 'New "York"' },
    ];
    const csv = jsonToCsv(JSON.stringify(sample));
    expect(csv).toContain('Alice');
    expect(csv).toContain('"Bob, Jr."');
    expect(csv).toContain('"New ""York"""');

    const back = JSON.parse(csvToJson(csv));
    expect(back.length).toBe(2);
    expect(back[0].name).toBe('Alice');
    expect(back[1].city).toBe('New "York"');
  });

  it('converts Markdown to HTML and HTML to Markdown', () => {
    const md = '# Title\n\nThis is **bold** and *italic* text.\n\n- Item 1\n- Item 2';
    const html = markdownToHtml(md);
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>italic</em>');
    expect(html).toContain('<li>Item 1</li>');

    const back = htmlToMarkdown(html);
    expect(back).toContain('# Title');
    expect(back).toContain('**bold**');
    expect(back).toContain('*italic*');
  });

  it('strips RTF syntax into clean plain text', () => {
    const rtf = '{\\rtf1\\ansi\\deff0 {\\fonttbl {\\f0 Courier;}}\\f0\\fs24 Hello\\par World!\\par}';
    const plain = rtfToText(rtf);
    expect(plain).toBe('Hello\nWorld!');
  });

  it('preserves escaped characters and signed Unicode in RTF', () => {
    const source = String.raw`{\rtf1\ansi{\*\generator Hidden;}\{caf\'e9\}\line \u-10179?\u-8704?}`;
    expect(rtfToText(source)).toBe('{café}\n😀');
  });

  it('preserves multiline CSV cells and duplicate column names', () => {
    const csv = '\uFEFFlabel,label\r\n"two\nlines","with ""quotes"""\r\n';
    expect(JSON.parse(csvToJson(csv))).toEqual([{ label: 'two\nlines', 'label 2': 'with "quotes"' }]);
    expect(JSON.parse(csvToJson(jsonToCsv('[1,2]')))).toEqual([{ Value: '1' }, { Value: '2' }]);
    expect(() => csvToJson('name\n"line')).toThrow('closing quote');
  });

  it('exports valid TXT-to-JSON and rejects unsupported output instead of renaming bytes', async () => {
    const source = new File(['a < b'], 'data.txt', { type: 'text/plain' });
    const result = await convertFile(source, 'json', defaultSettings());
    expect(JSON.parse(await result.blob.text())).toEqual({ text: 'a < b' });
    await expect(convertFile(source, 'rtf', defaultSettings())).rejects.toThrow('not supported');
  });

  it('reads UTF-16 CSV files with a byte order mark', async () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x41, 0, 0x0a, 0, 0xe9, 0]);
    const result = await convertFile(new File([bytes], 'sample.csv'), 'json', defaultSettings());
    expect(JSON.parse(await result.blob.text())).toEqual([{ A: 'é' }]);
  });

  it('uses the selected PDF pages once and rejects invalid ranges', () => {
    expect(selectPdfPages(5, { dpi: 150, pageSelection: 'range', pageRange: '5, 2-4, 3' })).toEqual([2, 3, 4, 5]);
    expect(selectPdfPages(5, { dpi: 72, pageSelection: 'first' })).toEqual([1]);
    expect(() => selectPdfPages(3, { dpi: 72, pageSelection: 'range', pageRange: '2-4' })).toThrow('from 1 to 3');
  });
});
