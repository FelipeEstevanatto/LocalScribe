import { AudioFfmpeg, AUDIO_FORMATS, type AudioFormat, type MediaProbe } from './audio-ffmpeg';
import { isAbortError } from './errors';
import { QUICK_TOOLS, isImageTool, quickTool, type QuickTool } from './quick-catalog';
import { VIDEO_FORMATS, clipRange, parseTime, processVideo, timeLabel, type ToolFile, type VideoFormat, type VideoOperation, type VideoOptions } from './quick-video';
import { IMAGE_FORMATS, canvasFor, decodeImage, drawGrid, drawLayer, drawWatermark, encodeImage, renderVideoCollage, toBlob, type ImageFormat, type Layer, type Watermark } from './quick-canvas';
import { createZip } from './zip';
import { sharedMedia } from './media-router';
import { preferredQuickLanguage, QUICK_LOCALE_EVENT, setAppLocaleDisabled } from './app-locale';
import { quickTranslate, type QuickLanguage } from './quick-locale';

interface QuickOptions {
  download(blob: Blob, name: string): void;
  open(file: File, studio: 'vision' | 'video' | 'audio'): void;
}

interface Source {
  file: File;
  url: string;
  bitmap?: ImageBitmap;
  probe?: MediaProbe;
}

const videoAccept = 'video/*,.mkv,.avi,.mpeg,.mpg,.m4v,.3gp,.ogv';
const imageAccept = 'image/*,.tif,.tiff,.ico';
const resolutions = [['0', 'Source'], ['1080', '1080p'], ['720', '720p'], ['640', '640p'], ['480', '480p'], ['360', '360p']] as const;
const positions = ['top-left', 'top-center', 'top-right', 'middle-left', 'middle-center', 'middle-right', 'bottom-left', 'bottom-center', 'bottom-right'];
const percent = (value: number) => value / 100;
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const nameOf = (file: File) => file.name.replace(/\.[^.]+$/, '') || 'media';
type CropEdge = 'left' | 'right' | 'top' | 'bottom';
type LayerDrag = {
  layer: Layer;
  mode: 'move' | 'resize' | CropEdge;
  x: number;
  y: number;
  start: Pick<Layer, 'x' | 'y' | 'width' | 'height' | CropEdge>;
};

export function setupQuickTools(root: HTMLElement, options: QuickOptions) {
  const ffmpeg = new AudioFfmpeg();
  const get = <T extends HTMLElement>(id: string) => root.querySelector<T>('#quick-' + id)!;
  const input = get<HTMLInputElement>('input');
  const drop = get<HTMLButtonElement>('drop');
  const nav = get<HTMLSelectElement>('tool');
  const toolGrid = get('tool-grid');
  const toolCount = get('tool-count');
  const activeLabel = get('active-label');
  const settingsTitle = get('settings-title');
  const rotatePreview = get<HTMLVideoElement>('video');
  const canvas = get<HTMLCanvasElement>('canvas');
  const controls = get<HTMLFieldSetElement>('controls');
  const form = get<HTMLFormElement>('form');
  const description = get('description');
  const status = get('status');
  const progress = get<HTMLProgressElement>('progress');
  const output = get('output');
  const cancel = get<HTMLButtonElement>('cancel');
  const run = get<HTMLButtonElement>('run');
  const handoff = get<HTMLButtonElement>('handoff');
  const directSave = get<HTMLButtonElement>('direct-save');
  const settingsNote = get('settings-note');
  const meta = get('meta');
  const canvasContext = canvas.getContext('2d', { willReadFrequently: true })!;
  let tool: QuickTool = 'video-converter';
  let language = preferredQuickLanguage();
  let source: Source | null = null;
  let logo: ImageBitmap | undefined;
  let initialMask: ImageBitmap | undefined;
  let working: AbortController | null = null;
  let layers: Layer[] = [];
  let layerSelection = 0;
  let urls: string[] = [];
  let original: ImageData | null = null;
  let paintedMask: ImageData | null = null;
  let mask: Uint8ClampedArray<ArrayBufferLike> = new Uint8ClampedArray();
  let sampled: [number, number, number] | null = null;
  let undo: Uint8ClampedArray[] = [];
  let redo: Uint8ClampedArray[] = [];
  let stroke: { x: number; y: number } | null = null;
  let drag: LayerDrag | null = null;
  let collageTime = 0;
  let playing = false;
  let frame = 0;
  const t = (value: string) => quickTranslate(language, value);
  const isCollage = () => tool === 'video-collage' || tool === 'image-collage';
  const isImage = () => isImageTool(tool);
  const isCutout = () => tool === 'background-remover';

  const TOOL_GROUPS: { label: string; ids: QuickTool[] }[] = [
    {
      label: 'Video',
      ids: ['video-converter', 'video-compressor', 'video-trimmer', 'rotate-video', 'change-speed', 'reverse-video', 'extract-frames', 'video-to-gif', 'video-watermark', 'video-collage'],
    },
    { label: 'Audio', ids: ['extract-audio'] },
    {
      label: 'Image',
      ids: ['image-converter', 'image-watermark', 'grid-maker', 'background-remover', 'image-collage'],
    },
  ];

  function toolIcon(id: QuickTool): string {
    const paths: Record<QuickTool, string> = {
      'video-converter': '<rect x="3" y="5" width="13" height="14" rx="2.5"/><path d="m16 10 5-3v10l-5-3"/>',
      'video-compressor': '<path d="M4 8h16M4 16h16M9 12h6"/><path d="m8 4 4 4 4-4M8 20l4-4 4 4"/>',
      'video-trimmer': '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12"/>',
      'extract-audio': '<path d="M4 10v4M8 7v10M12 5v14M16 8v8M20 11v2"/>',
      'rotate-video': '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
      'change-speed': '<path d="M4 14a8 8 0 1 1 16 0"/><path d="m12 14 4-5"/><path d="M4 18h16"/>',
      'reverse-video': '<path d="M3 12a9 9 0 1 0 9-9"/><path d="M3 3v5h5"/><path d="M10 9v6l5-3z"/>',
      'extract-frames': '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 15h18M8 5v10M16 5v10"/>',
      'video-to-gif': '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m10 9 5 3-5 3z"/>',
      'video-watermark': '<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11Z"/>',
      'video-collage': '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
      'image-converter': '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="m21 16-5-5L6 21"/>',
      'image-watermark': '<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11Z"/>',
      'grid-maker': '<path d="M4 4h16v16H4zM4 10h16M4 16h16M10 4v16M16 4v16"/>',
      'background-remover': '<path d="m7 20 12-12a2.8 2.8 0 0 0-4-4L3 16v4h4Z"/><path d="m14 7 3 3"/>',
      'image-collage': '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    };
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[id]}</svg>`;
  }

  function renderToolGrid(): void {
    toolGrid.replaceChildren();
    for (const group of TOOL_GROUPS) {
      const heading = document.createElement('p');
      heading.className = 'quick-tool-group';
      heading.dataset.quickGroup = group.label;
      heading.textContent = t(group.label);
      toolGrid.append(heading);
      for (const id of group.ids) {
        const entry = QUICK_TOOLS.find(([key]) => key === id)!;
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'quick-tool-card';
        card.dataset.tool = id;
        card.setAttribute('aria-pressed', String(id === tool));
        card.innerHTML = `<span class="quick-tool-icon">${toolIcon(id)}</span><span class="quick-tool-copy"><span class="quick-tool-name"></span><span class="quick-tool-desc"></span></span>`;
        card.querySelector('.quick-tool-name')!.textContent = t(entry[1]);
        card.querySelector('.quick-tool-desc')!.textContent = t(entry[2]);
        card.addEventListener('click', () => {
          if (working) return;
          nav.value = id;
          selectTool(quickTool(id), true);
        });
        toolGrid.append(card);
      }
    }
    toolCount.textContent = String(QUICK_TOOLS.length);
  }

  function localizeToolGrid(): void {
    for (const heading of toolGrid.querySelectorAll<HTMLElement>('.quick-tool-group')) {
      heading.textContent = t(heading.dataset.quickGroup!);
    }
    for (const card of toolGrid.querySelectorAll<HTMLButtonElement>('[data-tool]')) {
      const entry = QUICK_TOOLS.find(([key]) => key === card.dataset.tool)!;
      card.querySelector('.quick-tool-name')!.textContent = t(entry[1]);
      card.querySelector('.quick-tool-desc')!.textContent = t(entry[2]);
    }
    syncToolSelection();
  }

  function syncToolSelection(): void {
    const entry = QUICK_TOOLS.find(([key]) => key === tool)!;
    activeLabel.textContent = t(entry[1]);
    description.textContent = t(entry[2]);
    settingsTitle.textContent = t(entry[1]);
    for (const card of toolGrid.querySelectorAll<HTMLButtonElement>('[data-tool]')) {
      card.setAttribute('aria-pressed', String(card.dataset.tool === tool));
    }
    const selectedCard = toolGrid.querySelector<HTMLElement>(`[data-tool="${tool}"]`);
    requestAnimationFrame(() => selectedCard?.scrollIntoView({ block: 'nearest' }));
  }

  function localizeText(node: HTMLElement, key: string): void {
    node.dataset.quickLabel = key;
    node.textContent = t(key);
  }

  function field(id: string): HTMLInputElement | HTMLSelectElement {
    return controls.querySelector<HTMLInputElement | HTMLSelectElement>('#q-' + id)!;
  }
  function value(id: string, fallback = ''): string { return field(id)?.value ?? fallback; }
  function number(id: string, fallback = 0): number { return Number(value(id, String(fallback))); }
  function checked(id: string): boolean { return (field(id) as HTMLInputElement | null)?.checked ?? false; }

  function label(id: string, title: string, control: HTMLInputElement | HTMLSelectElement): void {
    const wrapper = document.createElement('label');
    wrapper.className = 'quick-field';
    const text = document.createElement('span');
    localizeText(text, title);
    control.id = 'q-' + id;
    if (control.type !== 'checkbox' && control.type !== 'range') control.className = 'select';
    wrapper.append(text, control);
    controls.append(wrapper);
  }

  function numeric(id: string, title: string, initial: number, low: number, high: number, step = 1, type = 'number'): void {
    const control = document.createElement('input');
    control.type = type;
    control.min = String(low);
    control.max = String(high);
    control.step = String(step);
    control.value = String(initial);
    control.required = true;
    label(id, title, control);
  }

  function select(id: string, title: string, values: readonly (readonly [string, string])[], initial?: string): void {
    const control = document.createElement('select');
    for (const [key, text] of values) {
      const option = new Option('', key);
      localizeText(option, text);
      control.add(option);
    }
    if (initial) control.value = initial;
    label(id, title, control);
  }

  function entry(id: string, title: string, initial = '', type = 'text'): void {
    const control = document.createElement('input');
    control.type = type;
    if (type === 'file') control.accept = imageAccept;
    else control.value = initial;
    label(id, title, control);
  }

  function toggle(id: string, title: string, initial = false): void {
    const control = document.createElement('input');
    control.type = 'checkbox';
    control.checked = initial;
    label(id, title, control);
  }

  function button(title: string, onClick: () => void, host: HTMLElement = controls): HTMLButtonElement {
    const control = document.createElement('button');
    control.type = 'button';
    control.className = 'btn-secondary';
    localizeText(control, title);
    control.addEventListener('click', onClick);
    host.append(control);
    return control;
  }

  function markFields(): void {
    entry('text', 'Text');
    entry('logo', 'Logo image', '', 'file');
    select('position', 'Position', positions.map(pos => [pos, pos.replace('-', ' ')]), 'bottom-right');
    numeric('mark-size', 'Size (%)', 8, 2, 75);
    numeric('opacity', 'Opacity (%)', 85, 1, 100);
    numeric('margin', 'Edge margin (%)', 4, 0, 35);
    toggle('tile', 'Tile 3 × 3');
  }

  function rangeFields(): void {
    const length = source?.probe?.duration ?? 0;
    entry('start', 'Start time', timeLabel(0));
    entry('end', 'End time', timeLabel(length));
    const scrub = (id: string, name: string, initial: number) => {
      numeric(id + '-handle', name, initial, 0, Math.max(0.001, length), 0.001, 'range');
      field(id + '-handle').addEventListener('input', () => {
        field(id).value = timeLabel(number(id + '-handle'));
        seekPreview(number(id + '-handle'));
      });
      field(id).addEventListener('change', () => {
        const seconds = parseTime(value(id));
        if (Number.isFinite(seconds)) { field(id + '-handle').value = String(seconds); seekPreview(seconds); }
      });
    };
    scrub('start', 'Start range handle', 0);
    scrub('end', 'End range handle', length);
    button('Set start at playhead', () => setRangePoint('start'));
    button('Set end at playhead', () => setRangePoint('end'));
    const step = 1 / (source?.probe?.fps || 30);
    button('Previous frame', () => seekPreview(rotatePreview.currentTime - step));
    button('Next frame', () => seekPreview(rotatePreview.currentTime + step));
  }

  function makeSettings(resetRange = false): void {
    const previous = new Map(Array.from(controls.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input,select')).map(el => [
      el.id, { value: el.value, checked: el instanceof HTMLInputElement && el.checked },
    ]));
    controls.replaceChildren();
    if (isCollage()) {
      select('aspect', 'Canvas ratio', [['landscape', '16:9'], ['vertical', '9:16'], ['square', '1:1'], ['classic', '4:3'], ['custom', 'Custom']]);
      numeric('width', 'Width (px)', 1280, 2, 4096, isImage() ? 1 : 2);
      numeric('height', 'Height (px)', 720, 2, 4096, isImage() ? 1 : 2);
      entry('background', 'Background color', '#162437', 'color');
      toggle('transparent', 'Transparent background');
      toggle('snap', 'Snap to grid', true);
      if (!isImage()) {
        select('audio', 'Audio source', [['mute', 'Mute'], ...layers.map((layer, index) => [String(index), layer.file.name] as const)]);
        button(playing ? 'Pause collage' : 'Play collage', toggleCollage);
        numeric('collage-time', 'Preview time', collageTime, 0, Math.max(0.01, collageDuration()), 0.01, 'range');
      }
      if (layers.length) {
        select('layer', 'Layer', layers.map((layer, index) => [String(index), layer.file.name]), String(layerSelection));
        const layer = layers[layerSelection];
        for (const [key, title, min, max] of [
          ['x', 'X (%)', -100, 100], ['y', 'Y (%)', -100, 100], ['width', 'Layer width (%)', 1, 200],
          ['height', 'Layer height (%)', 1, 200], ['left', 'Crop left (%)', 0, 90], ['right', 'Crop right (%)', 0, 90],
          ['top', 'Crop top (%)', 0, 90], ['bottom', 'Crop bottom (%)', 0, 90], ['radius', 'Corner rounding (%)', 0, 50],
        ] as const) numeric('layer-' + key, title, Math.round(layer[key] * 100), min, max);
        if (!isImage()) select('layer-end', 'When this clip ends', [['freeze', 'Freeze'], ['loop', 'Loop']], layer.end);
        button('Move layer forward', () => moveLayer(1));
        button('Move layer backward', () => moveLayer(-1));
        button('Duplicate layer', () => { void duplicateLayer(); });
        button('Remove layer', removeLayer);
        button('Fit layers to canvas', () => { arrangeLayers(); makeSettings(); draw(); });
        button('Center layer', () => {
          layer.x = (1 - layer.width) / 2;
          layer.y = (1 - layer.height) / 2;
          makeSettings(); draw();
        });
      }
    } else if (tool === 'image-converter') {
      const width = source?.bitmap?.width ?? 1280, height = source?.bitmap?.height ?? 720;
      select('image-format', 'Format', IMAGE_FORMATS.map(format => [format, format.toUpperCase()]));
      select('scale', 'Resize', [['100', 'Original'], ['75', '75%'], ['50', '50%'], ['25', '25%'], ['custom', 'Custom']]);
      numeric('width', 'Width (px)', width, 1, 8192);
      numeric('height', 'Height (px)', height, 1, 8192);
      toggle('lock', 'Lock aspect ratio', true);
      numeric('quality', 'Quality (%)', 90, 1, 100);
      select('quality-preset', 'Quality preset', [['custom', 'Custom'], ['100', 'Original'], ['92', 'High'], ['82', 'Medium'], ['72', 'Low']]);
      entry('matte', 'JPEG background', '#ffffff', 'color');
    } else if (tool === 'grid-maker') {
      numeric('rows', 'Rows', 8, 1, 80);
      numeric('columns', 'Columns', 8, 1, 80);
      entry('line-color', 'Line color', '#ffffff', 'color');
      numeric('line-width', 'Line width (px)', 2, 1, 24);
      numeric('opacity', 'Opacity (%)', 85, 1, 100);
      toggle('labels', 'Label cells', true);
      toggle('gray', 'Grayscale');
      select('paper', 'Paper size', [['210,297', 'A4'], ['297,420', 'A3'], ['216,279', 'US Letter'], ['279,432', 'Tabloid']]);
    } else if (isCutout()) {
      select('brush', 'Mode', [['pick', 'Pick background color'], ['erase', 'Erase brush'], ['restore', 'Restore brush']]);
      entry('key-color', 'Background color', '#ffffff', 'color');
      numeric('tolerance', 'Color tolerance', 28, 0, 255);
      numeric('brush-size', 'Brush size (px)', 35, 1, 500);
      button('Remove sampled color', keyColor);
      button('Undo', () => swapMask(undo, redo));
      button('Redo', () => swapMask(redo, undo));
      button('Reset mask', () => { rememberMask(); resetMask(initialMask); draw(); });
    } else if (tool.includes('watermark')) {
      markFields();
    } else if (!isImage()) {
      if (tool === 'extract-audio') {
        const tracks = source?.probe?.audioStreams ?? [];
        select('track', 'Audio track', tracks.length ? tracks.map((track, index) => [
          String(index), [index + 1, track.title, track.codec, track.language, track.channels].filter(Boolean).join(' · '),
        ] as const) : [['0', 'Default track']]);
        select('audio-format', 'Audio format', Object.entries(AUDIO_FORMATS).map(([key, spec]) => [key, spec.label]));
        select('bitrate', 'Audio bitrate', [['0', 'Default quality'], ...[64, 96, 128, 192, 256, 320].map(n => [String(n), n + ' kbps'] as const)]);
        toggle('copy', 'Match source AAC');
      } else {
        if (tool === 'video-converter' || tool === 'video-trimmer') {
          select('video-format', 'Format', Object.keys(VIDEO_FORMATS).map(key => [key, key.toUpperCase()]));
          toggle('copy', tool === 'video-trimmer' ? 'Fast cut (keyframe stream copy)' : 'Copy compatible streams', tool === 'video-trimmer');
          if (tool === 'video-converter') button('Extract audio instead', () => selectTool('extract-audio', true));
        }
        if (tool === 'video-compressor') {
          select('target', 'Target', [['0', 'Quality mode'], ['16', '16 MB'], ['25', '25 MB'], ['100', '100 MB'], ['custom', 'Custom size']]);
          numeric('target-size', 'Custom target (MB)', 20, 1, 8000, 0.1);
        }
        if (['video-converter', 'video-compressor', 'change-speed', 'reverse-video', 'video-to-gif'].includes(tool)) {
          select('resolution', 'Resolution', resolutions, tool === 'video-to-gif' ? '480' : tool === 'reverse-video' ? '720' : '0');
        }
        if (!['extract-frames', 'video-to-gif'].includes(tool)) {
          numeric('quality', 'Quality (%)', 80, 1, 100);
          select('quality-preset', 'Quality preset', [['custom', 'Custom'], ['95', 'High'], ['80', 'Medium'], ['55', 'Low']]);
        }
        if (['video-trimmer', 'change-speed', 'reverse-video', 'extract-frames', 'video-to-gif'].includes(tool)) rangeFields();
        if (tool === 'rotate-video') {
          select('rotation', 'Rotation', [['0', 'None'], ['90', '90° right'], ['180', '180°'], ['270', '90° left']]);
          toggle('flip-x', 'Mirror horizontally'); toggle('flip-y', 'Mirror vertically');
          toggle('copy', 'Use MP4 rotation metadata when compatible', true);
        }
        if (tool === 'change-speed' || tool === 'reverse-video') {
          select('speed-preset', 'Speed preset', [['custom', 'Custom'], ...[0.25, 0.5, 1, 1.5, 2, 4, 8].map(speed => [String(speed), speed + '×'] as const)]);
          numeric('speed', 'Speed (×)', 1, 0.1, 16, 0.01);
          select('audio', 'Audio', [['keep', 'Keep audio'], ['mute', 'Mute'], ...(tool === 'reverse-video' ? [['reverse', 'Reverse audio'] as const] : [])]);
        }
        if (tool === 'change-speed') select('fps', 'Frame rate', [['0', 'Source'], ['15', '15 FPS'], ['24', '24 FPS'], ['30', '30 FPS'], ['60', '60 FPS']]);
        if (tool === 'video-to-gif') {
          select('fps', 'Frame rate', [['10', '10 FPS'], ['15', '15 FPS'], ['24', '24 FPS']], '15');
          select('loop', 'Loop', [['0', 'Infinite'], ['-1', 'Once'], ['2', 'Three times']]);
        }
        if (tool === 'extract-frames') {
          numeric('interval', 'Interval (s)', 1, 0.1, 3600, 0.1);
          select('frame-format', 'Frame format', [['png', 'PNG'], ['jpg', 'JPG']]);
          button('Extract current frame', () => { void exportCurrent(true); });
        }
      }
    }
    for (const el of controls.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input,select')) {
      if (el.id.startsWith('q-layer') || el.id === 'q-collage-time') continue;
      if (resetRange && ['q-start', 'q-end', 'q-start-handle', 'q-end-handle', 'q-track'].includes(el.id)) continue;
      const prior = previous.get(el.id);
      if (!prior || el.type === 'file') continue;
      el.value = prior.value;
      if (el instanceof HTMLInputElement) el.checked = prior.checked;
    }
  }

  function setRangePoint(id: 'start' | 'end'): void {
    field(id).value = timeLabel(rotatePreview.currentTime);
    field(id + '-handle').value = String(rotatePreview.currentTime);
  }

  function seekPreview(seconds: number): void {
    if (Number.isFinite(rotatePreview.duration)) rotatePreview.currentTime = clamp(seconds, 0, rotatePreview.duration);
  }

  function watermark(): Watermark {
    return { text: value('text'), logo, position: value('position', 'bottom-right'), size: percent(number('mark-size', 8)),
      opacity: percent(number('opacity', 85)), margin: percent(number('margin', 4)), tile: checked('tile') };
  }

  function collageSize() { return { width: number('width', 1280), height: number('height', 720) }; }
  function collageDuration(): number { return Math.max(0, ...layers.map(layer => layer.probe?.duration || 0)); }

  function drawLayerFrame(guides = true): void {
    const size = collageSize();
    if (size.width < 2 || size.height < 2 || size.width * size.height > 16_800_000) return;
    if (canvas.width !== size.width) canvas.width = size.width;
    if (canvas.height !== size.height) canvas.height = size.height;
    canvasContext.clearRect(0, 0, size.width, size.height);
    if (!checked('transparent')) { canvasContext.fillStyle = value('background', '#162437'); canvasContext.fillRect(0, 0, size.width, size.height); }
    for (const layer of layers) {
      if (layer.source instanceof HTMLVideoElement && layer.source.readyState < 2) continue;
      drawLayer(canvasContext, layer, size);
    }
    const selected = guides ? layers[layerSelection] : undefined;
    if (selected) {
      const x = selected.x * size.width, y = selected.y * size.height;
      const w = selected.width * size.width, h = selected.height * size.height;
      const unit = Math.max(4, size.width / (canvas.clientWidth || 600) * 4);
      canvasContext.strokeStyle = '#a5b4fc';
      canvasContext.lineWidth = unit / 2;
      canvasContext.strokeRect(x, y, w, h);
      canvasContext.fillStyle = '#fff';
      for (const [dx, dy] of [[x, y + h / 2], [x + w, y + h / 2], [x + w / 2, y],
        [x + w / 2, y + h], [x + w, y + h]]) {
        canvasContext.fillRect(dx - unit, dy - unit, unit * 2, unit * 2);
      }
    }
  }

  function resizeForImage(limit = Infinity): { width: number; height: number } {
    const bitmap = source?.bitmap;
    if (!bitmap) return { width: 1, height: 1 };
    let width = bitmap.width, height = bitmap.height;
    if (tool === 'image-converter') {
      const scale = value('scale', '100');
      if (scale === 'custom') { width = number('width'); height = number('height'); }
      else { width = Math.max(1, Math.round(width * Number(scale) / 100)); height = Math.max(1, Math.round(height * Number(scale) / 100)); }
    }
    const ratio = Math.min(1, limit / Math.max(width, height));
    return { width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio)) };
  }

  function paintImage(context: CanvasRenderingContext2D, width: number, height: number): void {
    if (!source?.bitmap) return;
    if (tool === 'image-converter' && value('image-format') === 'jpeg') {
      context.fillStyle = value('matte', '#ffffff'); context.fillRect(0, 0, width, height);
    }
    if (tool === 'grid-maker' && checked('gray')) context.filter = 'grayscale(100%)';
    context.drawImage(source.bitmap, 0, 0, width, height);
    context.filter = 'none';
    if (tool === 'image-watermark') drawWatermark(context, width, height, watermark());
    if (tool === 'grid-maker') {
      drawGrid(context, width, height, number('rows', 8), number('columns', 8), value('line-color', '#ffffff'),
        number('line-width', 2) * width / source.bitmap.width, percent(number('opacity', 85)), checked('labels'));
    }
  }

  function createMaskImage(): ImageData {
    if (!original) throw new Error('Open an image before editing its mask.');
    const pixels = paintedMask ??= new ImageData(new Uint8ClampedArray(original.data), original.width, original.height);
    for (let i = 0; i < mask.length; i++) pixels.data[i * 4 + 3] = mask[i];
    return pixels;
  }

  function draw(): void {
    settingsNote.textContent = tool === 'image-converter'
      ? t(value('image-format') === 'jpeg' ? 'JPEG replaces transparency with the selected background.'
        : value('image-format') === 'gif' ? 'Image conversion exports a still GIF with a limited palette.' : '')
      : '';
    if (isCollage()) { drawLayerFrame(); return; }
    if (isCutout() && original) {
      if (canvas.width !== original.width || canvas.height !== original.height) {
        canvas.width = original.width; canvas.height = original.height;
      }
      canvasContext.putImageData(createMaskImage(), 0, 0);
      return;
    }
    if (isImage() && source?.bitmap) {
      const size = resizeForImage(1400);
      canvas.width = size.width; canvas.height = size.height;
      paintImage(canvasContext, size.width, size.height);
      if (tool === 'grid-maker') {
        const [paperWidth, paperHeight] = value('paper', '210,297').split(',').map(Number);
        const scale = Math.min(paperWidth / size.width, paperHeight / size.height);
        meta.textContent = source.file.name + ' · ' + (size.width * scale / number('columns', 8)).toFixed(1) + ' × ' +
          (size.height * scale / number('rows', 8)).toFixed(1) + ' mm / ' + t('cell');
      }
      return;
    }
    if (tool === 'video-watermark' && source?.probe) {
      const width = rotatePreview.videoWidth || source.probe.width;
      const height = rotatePreview.videoHeight || source.probe.height;
      const ratio = Math.min(1, 1400 / Math.max(width, height));
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      canvasContext.clearRect(0, 0, canvas.width, canvas.height);
      drawWatermark(canvasContext, canvas.width, canvas.height, watermark());
      canvas.style.setProperty('--quick-overlay-ratio', String(width / height));
    }
    const rotation = tool === 'rotate-video' ? number('rotation') : 0;
    rotatePreview.style.transform = rotation || checked('flip-x') || checked('flip-y')
      ? `rotate(${rotation}deg) scale(${checked('flip-x') ? -1 : 1},${checked('flip-y') ? -1 : 1}) scale(${rotation % 180 ? 0.72 : 1})` : '';
    if (tool === 'change-speed') {
      // Some browsers reject playback rates that their export engines can encode.
      try { rotatePreview.playbackRate = clamp(number('speed', 1), 0.25, 4); } catch { /* export supports the complete range */ }
      rotatePreview.muted = value('audio') === 'mute';
    }
    if (tool === 'video-compressor' && source?.probe) {
      const target = value('target') === 'custom' ? number('target-size') : number('target');
      const { width, height, duration } = source.probe;
      const resolution = number('resolution');
      const scale = resolution ? Math.min(1, resolution / Math.min(width, height)) : 1;
      const rough = target ? target * 0.95 : source.file.size / 1_000_000 * scale * scale * (0.3 + number('quality', 80) / 100);
      meta.textContent = source.file.name + ' · ' + width + '×' + height + ' · ' + timeLabel(duration) +
        ' · ' + t('Estimated size') + ' ≈ ' + rough.toFixed(2) + ' MB' + (target ? ' · ' + t('Target') + ' ≤ ' + target + ' MB' : '');
    }
  }

  function resetMask(seed?: ImageBitmap): void {
    if (!original) return;
    if (seed) {
      const scratch = canvasFor(original);
      const ctx = scratch.getContext('2d')!;
      ctx.drawImage(seed, 0, 0, original.width, original.height);
      const pixels = ctx.getImageData(0, 0, original.width, original.height).data;
      mask = Uint8ClampedArray.from({ length: original.width * original.height }, (_, i) => pixels[i * 4 + 3]);
    } else {
      mask = Uint8ClampedArray.from({ length: original.width * original.height }, (_, i) => original!.data[i * 4 + 3]);
    }
  }

  function initMask(seed?: ImageBitmap): void {
    original = null; paintedMask = null; sampled = null; undo = []; redo = [];
    if (!source?.bitmap) return;
    const scratch = canvasFor(source.bitmap);
    const ctx = scratch.getContext('2d')!;
    ctx.drawImage(source.bitmap, 0, 0);
    original = ctx.getImageData(0, 0, scratch.width, scratch.height);
    resetMask(seed);
  }

  function rememberMask(): void {
    if (!mask.length) return;
    undo.push(mask.slice());
    const cap = Math.max(1, Math.floor(64_000_000 / mask.length));
    if (undo.length > cap) undo.shift();
    redo = [];
  }

  function swapMask(from: Uint8ClampedArray[], to: Uint8ClampedArray[]): void {
    const snapshot = from.pop();
    if (!snapshot) return;
    to.push(mask);
    mask = snapshot;
    draw();
  }

  function keyColor(): void {
    if (!original) return;
    rememberMask();
    const hex = value('key-color', '#ffffff').substring(1);
    const [r, g, b] = sampled ?? [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16));
    const tolerance = number('tolerance');
    const data = original.data;
    for (let i = 0; i < mask.length; i++) {
      const j = 4 * i;
      if (Math.hypot(data[j] - r, data[j + 1] - g, data[j + 2] - b) <= tolerance) mask[i] = 0;
    }
    draw();
  }

  function applyBrush(x: number, y: number): void {
    if (!original || !paintedMask) return;
    const { width, height, data } = original;
    const r = number('brush-size', 35) / 2;
    const left = Math.max(0, Math.floor(x - r)), right = Math.min(width - 1, Math.ceil(x + r));
    const top = Math.max(0, Math.floor(y - r)), bottom = Math.min(height - 1, Math.ceil(y + r));
    const restore = value('brush') === 'restore';
    for (let j = top; j <= bottom; j++) for (let i = left; i <= right; i++) {
      const weight = clamp(r + 0.5 - Math.hypot(i - x, j - y), 0, 1);
      const offset = j * width + i;
      mask[offset] += ((restore ? data[offset * 4 + 3] : 0) - mask[offset]) * weight;
      paintedMask.data[offset * 4 + 3] = mask[offset];
    }
    canvasContext.putImageData(paintedMask, 0, 0, left, top, right - left + 1, bottom - top + 1);
  }

  function arrangeLayers(): void {
    const columns = Math.max(1, Math.ceil(Math.sqrt(layers.length)));
    const rows = Math.max(1, Math.ceil(layers.length / columns));
    const size = collageSize();
    for (const [i, layer] of layers.entries()) {
      const width = layer.probe?.width || (layer.source as ImageBitmap).width;
      const height = layer.probe?.height || (layer.source as ImageBitmap).height;
      const scale = Math.min(size.width / columns / width, size.height / rows / height) * 0.94;
      layer.width = width * scale / size.width;
      layer.height = height * scale / size.height;
      layer.x = (i % columns + 0.5) / columns - layer.width / 2;
      layer.y = (Math.floor(i / columns) + 0.5) / rows - layer.height / 2;
    }
  }

  function moveLayer(direction: number): void {
    const next = layerSelection + direction;
    if (next < 0 || next >= layers.length) return;
    const selectedAudio = layers[number('audio', -1)];
    [layers[layerSelection], layers[next]] = [layers[next], layers[layerSelection]];
    layerSelection = next;
    makeSettings();
    if (!isImage()) field('audio').value = selectedAudio ? String(layers.indexOf(selectedAudio)) : 'mute';
    draw();
  }

  function disposeLayer(layer: Layer): void {
    if (layer.source instanceof HTMLVideoElement) { layer.source.pause(); layer.source.removeAttribute('src'); layer.source.load(); }
    else layer.source.close();
    if (layer.url) URL.revokeObjectURL(layer.url);
  }

  async function probeVideo(file: File, signal: AbortSignal): Promise<MediaProbe> {
    const router = sharedMedia();
    const probe = await router.probe(file, signal);
    if (!probe.hasVideo || !probe.width || !probe.height || !Number.isFinite(probe.duration) || probe.duration <= 0) {
      throw new Error(t('Could not read a video track.'));
    }
    const sideways = Math.abs(probe.rotation ?? 0) % 180 === 90;
    if (router.lastEngine === 'ffmpeg' && sideways) return { ...probe, width: probe.height, height: probe.width };
    return probe;
  }

  function removeLayer(): void {
    const [layer] = layers.splice(layerSelection, 1);
    if (layer) disposeLayer(layer);
    layerSelection = Math.max(0, Math.min(layers.length - 1, layerSelection));
    makeSettings(); update(); draw();
  }

  async function duplicateLayer(): Promise<void> {
    const layer = layers[layerSelection];
    if (layer) await loadFiles([layer.file], layer);
  }

  async function createLayer(file: File, signal: AbortSignal): Promise<Layer> {
    let media: ImageBitmap | HTMLVideoElement;
    let probe: MediaProbe | undefined;
    let url: string | undefined;
    if (isImage()) media = await decodeImage(file, ffmpeg, signal);
    else {
      probe = await probeVideo(file, signal);
      const video = document.createElement('video');
      video.muted = true; video.preload = 'auto'; video.playsInline = true;
      url = URL.createObjectURL(file);
      video.src = url;
      video.addEventListener('loadeddata', draw, { once: true });
      video.addEventListener('seeked', draw);
      media = video;
    }
    return { file, source: media, url, probe, x: 0, y: 0, width: 0.6, height: 0.6, left: 0, right: 0, top: 0, bottom: 0, radius: 0, end: 'freeze' };
  }

  function updateCollageTime(time: number): void {
    collageTime = time;
    for (const layer of layers) {
      if (!(layer.source instanceof HTMLVideoElement) || !layer.probe || !layer.source.readyState) continue;
      const duration = layer.probe.duration;
      const next = layer.end === 'loop' ? time % duration : Math.min(time, duration - 0.02);
      if (Math.abs(layer.source.currentTime - next) > (playing ? 0.18 : 0.005)) layer.source.currentTime = Math.max(0, next);
    }
  }

  function pause(): void {
    rotatePreview.pause();
    cancelAnimationFrame(frame);
    playing = false;
    for (const layer of layers) if (layer.source instanceof HTMLVideoElement) layer.source.pause();
  }

  function toggleCollage(): void {
    if (playing) {
      pause(); makeSettings(); return;
    }
    if (collageTime >= collageDuration()) collageTime = 0;
    playing = true;
    for (const layer of layers) {
      if (!(layer.source instanceof HTMLVideoElement)) continue;
      layer.source.loop = layer.end === 'loop';
      layer.source.muted = layer !== layers[number('audio', -1)];
      void layer.source.play().catch(() => undefined);
    }
    makeSettings();
    const started = performance.now() - collageTime * 1000;
    const tick = () => {
      if (!playing) return;
      updateCollageTime(Math.min(collageDuration(), (performance.now() - started) / 1000));
      if (field('collage-time')) field('collage-time').value = String(collageTime);
      draw();
      if (collageTime >= collageDuration()) { pause(); makeSettings(); } else frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
  }

  function setStatus(text: string): void { localizeText(status, text); }

  function disposeSource(item: Source | null): void {
    if (!item) return;
    URL.revokeObjectURL(item.url);
    item.bitmap?.close();
  }

  function setResult(files: ToolFile[] = []): void {
    for (const url of urls) URL.revokeObjectURL(url);
    urls = [];
    output.replaceChildren();
    if (!files.length) return;
    const title = document.createElement('h2');
    localizeText(title, 'Result');
    output.append(title);
    const previewHolder = document.createElement('div');
    previewHolder.className = 'quick-result-preview';
    output.append(previewHolder);
    function preview(file: ToolFile, url: string): void {
      delete previewHolder.dataset.quickLabel;
      previewHolder.replaceChildren();
      if (file.blob.type.startsWith('image/')) {
        const img = document.createElement('img');
        img.alt = file.name;
        img.src = url;
        previewHolder.append(img);
      } else if (file.blob.type.startsWith('video/') || file.blob.type.startsWith('audio/')) {
        const media = document.createElement(file.blob.type.startsWith('video/') ? 'video' : 'audio');
        media.controls = true;
        media.preload = 'metadata';
        media.src = url;
        media.setAttribute('aria-label', file.name);
        media.addEventListener('error', () => {
          if (media.parentNode === previewHolder) localizeText(previewHolder, 'This browser cannot preview the file. You can still download it.');
        });
        previewHolder.append(media);
      }
    }
    const actions = document.createElement('div');
    actions.className = 'quick-actions';
    output.append(actions);
    if (files.length > 1) {
      button('Download ZIP', () => {
        void createZip(files).then(zip => options.download(zip, (source ? nameOf(source.file) : 'media') + '-frames.zip'))
          .catch(error => setStatus(error instanceof Error ? error.message : String(error)));
      }, actions);
    }
    const list = document.createElement('ul');
    list.className = 'quick-result-list';
    for (const file of files) {
      const item = document.createElement('li');
      const url = URL.createObjectURL(file.blob);
      urls.push(url);
      const title = document.createElement('span');
      title.textContent = file.name + ' · ' + (file.blob.size / 1_000_000).toFixed(2) + ' MB';
      item.append(title);
      if (files.length > 1) button('Preview', () => preview(file, url), item);
      const download = document.createElement('a');
      download.className = 'btn-primary';
      download.href = url;
      download.download = file.name;
      localizeText(download, 'Download');
      item.append(download);
      if (files.length === 1) button('Open in studio', () => openInStudio(file), item);
      list.append(item);
    }
    output.append(list);
    preview(files[0], urls[0]);
  }

  function openInStudio(item: ToolFile): void {
    const type = item.blob.type;
    const studio = type.startsWith('image/') ? 'vision' : type.startsWith('audio/') ? 'audio' : 'video';
    options.open(new File([item.blob], item.name, { type }), studio);
  }

  function update(): void {
    const hasSource = isCollage() ? layers.length > 0 : !!source;
    const hasBusy = !!working;
    input.disabled = drop.disabled = nav.disabled = hasBusy;
    setAppLocaleDisabled(hasBusy);
    for (const card of toolGrid.querySelectorAll<HTMLButtonElement>('[data-tool]')) card.disabled = hasBusy;
    drop.textContent = t(isCollage() ? 'Drop or add files' : hasSource ? 'Replace image or video' : 'Drop a file or browse');
    input.accept = isImage() ? imageAccept : videoAccept;
    input.multiple = isCollage();
    run.disabled = !hasSource || hasBusy;
    cancel.hidden = !hasBusy;
    controls.disabled = hasBusy;
    handoff.hidden = !source || isCollage();
    handoff.disabled = hasBusy;
    directSave.hidden = !canSaveDirectly();
    directSave.disabled = !hasSource || hasBusy;
    rotatePreview.hidden = !source || isImage() || isCollage();
    canvas.hidden = !hasSource || (!isImage() && !isCollage() && tool !== 'video-watermark');
    canvas.classList.toggle('quick-overlay', tool === 'video-watermark');
    updateFieldVisibility();
    if (!hasSource) {
      meta.textContent = isImage()
        ? t('PNG, JPEG, WebP, GIF, TIFF · drag a file or browse.')
        : t('MP4, MOV, MKV, WebM, AVI · drag a file or browse.');
    }
    if (isCollage()) meta.textContent = layers.length + ' / ' + (isImage() ? '12' : '4') + ' ' + t('layers');
  }

  function updateFieldVisibility(): void {
    const show = (id: string, visible: boolean) => {
      const input = field(id);
      if (!input) return;
      input.disabled = !visible;
      if (input.parentElement) input.parentElement.hidden = !visible;
    };
    if (tool === 'video-compressor') show('target-size', value('target') === 'custom');
    if (tool === 'image-converter') {
      const format = value('image-format');
      const lossy = format === 'jpeg' || format === 'webp';
      show('quality', lossy);
      show('quality-preset', lossy);
      show('matte', format === 'jpeg');
    }
    if (tool === 'extract-audio') {
      const format = value('audio-format');
      const aac = format === 'aac' || format === 'm4a';
      show('copy', aac);
      show('bitrate', ['mp3', 'ogg', 'aac', 'm4a'].includes(format) && !(aac && checked('copy')));
    }
  }

  type DiskPicker = (options: { suggestedName: string }) => Promise<FileSystemFileHandle>;
  const diskPicker = () => (window as Window & { showSaveFilePicker?: DiskPicker }).showSaveFilePicker;
  function canSaveDirectly(): boolean {
    if (!['video-converter', 'video-trimmer', 'video-compressor'].includes(tool)) return false;
    if (!diskPicker() || typeof VideoEncoder === 'undefined') return false;
    const format = tool === 'video-compressor' ? 'mp4' : value('video-format');
    return ['mp4', 'mov', 'mkv', 'webm'].includes(format);
  }

  function progressUpdate(ratio: number | null): void {
    progress.hidden = false;
    if (ratio === null) progress.removeAttribute('value');
    else progress.value = clamp(ratio, 0, 1);
  }

  async function perform(message: string, action: (signal: AbortSignal) => Promise<void>): Promise<void> {
    if (working) return;
    const operation = new AbortController();
    working = operation;
    setStatus(message); progressUpdate(null); update();
    try {
      await action(operation.signal);
    } catch (error) {
      setStatus(isAbortError(error) ? 'Cancelled.' : error instanceof Error ? error.message : String(error));
    } finally {
      working = null;
      progress.hidden = true;
      update();
    }
  }

  async function loadFiles(files: File[], duplicate?: Layer, seeded?: Blob): Promise<void> {
    if (!files.length) return;
    await perform('Opening media…', async (signal) => {
      pause();
      if (isCollage()) {
        const max = isImage() ? 12 : 4;
        if (layers.length + files.length > max) throw new Error(t('Too many layers for this canvas.') + ' ' + max);
        const added: Layer[] = [];
        try {
          for (const file of files) added.push(await createLayer(file, signal));
          signal.throwIfAborted();
        } catch (error) {
          for (const layer of added) disposeLayer(layer);
          throw error;
        }
        const first = layers.length;
        layers.push(...added);
        layerSelection = layers.length - 1;
        if (duplicate) Object.assign(added[0], { x: duplicate.x + 0.03, y: duplicate.y + 0.03, width: duplicate.width, height: duplicate.height,
          left: duplicate.left, right: duplicate.right, top: duplicate.top, bottom: duplicate.bottom, radius: duplicate.radius, end: duplicate.end });
        else if (!first) arrangeLayers();
        else for (const layer of added) { layer.x = 0.2; layer.y = 0.2; }
      } else {
        const file = files[0];
        const bitmap = isImage() ? await decodeImage(file, ffmpeg, signal) : undefined;
        const probe = !isImage() ? await probeVideo(file, signal) : undefined;
        if (bitmap && (bitmap.width > 8192 || bitmap.height > 8192 || bitmap.width * bitmap.height > 32_000_000)) {
          bitmap.close();
          throw new Error(t('This image exceeds the canvas size limit.'));
        }
        let maskSeed: ImageBitmap | undefined;
        try {
          maskSeed = seeded ? await decodeImage(seeded, ffmpeg, signal) : undefined;
          signal.throwIfAborted();
        } catch (error) {
          bitmap?.close(); maskSeed?.close();
          throw error;
        }
        disposeSource(source);
        source = { file, bitmap, probe, url: URL.createObjectURL(file) };
        initialMask?.close(); initialMask = maskSeed;
        if (probe) rotatePreview.src = source.url;
        else rotatePreview.removeAttribute('src');
        meta.textContent = file.name + ' · ' + (probe
          ? `${probe.width}×${probe.height} · ${timeLabel(probe.duration)}` : `${bitmap!.width}×${bitmap!.height}`);
        if (isCutout()) initMask(initialMask);
      }
      setResult();
      makeSettings(true); draw();
      setStatus('Ready.');
    });
  }

  function getVideoOptions(probe: MediaProbe, currentFrame: boolean): VideoOptions {
    let range = !currentFrame && field('start') ? clipRange(parseTime(value('start')), parseTime(value('end')), probe.duration)
      : { start: 0, end: probe.duration };
    let interval = number('interval', 1);
    if (currentFrame) {
      const frameTime = 1 / (probe.fps || 25);
      const start = clamp(rotatePreview.currentTime, 0, Math.max(0, probe.duration - frameTime));
      range = { start, end: Math.min(probe.duration, start + frameTime) };
      interval = frameTime;
    }
    return {
      range, interval,
      format: value('video-format', 'mp4') as VideoFormat,
      audioFormat: value('audio-format', 'mp3') as AudioFormat,
      resolution: number('resolution'), quality: number('quality', 80),
      targetMB: value('target') === 'custom' ? number('target-size') : number('target'),
      copy: checked('copy'), bitrate: number('bitrate'), track: number('track'), rotation: number('rotation'),
      flipX: checked('flip-x'), flipY: checked('flip-y'), speed: number('speed', 1), audio: value('audio', 'keep') as VideoOptions['audio'],
      fps: number('fps'), loop: number('loop'), frameFormat: value('frame-format', 'png') as VideoOptions['frameFormat'],
    };
  }

  async function exportCurrent(currentFrame = false, disk?: FileSystemFileHandle): Promise<void> {
    if ((!isCollage() && !source) || (isCollage() && !layers.length) || !form.reportValidity()) return;
    await perform('Processing on this device…', async (signal) => {
      pause();
      setResult();
      const report = ({ ratio }: { ratio: number | null }) => progressUpdate(ratio);
      if (isCollage()) {
        const size = collageSize();
        if (size.width * size.height > 16_800_000) throw new Error(t('This image exceeds the canvas size limit.'));
        if (isImage()) {
          drawLayerFrame(false);
          try {
            const blob = await toBlob(canvas);
            signal.throwIfAborted();
            setResult([{ name: 'image-collage.png', blob }]);
          } finally { drawLayerFrame(); }
        }
        else {
          const transparent = checked('transparent');
          const blob = await renderVideoCollage(ffmpeg, layers, size, value('background'), transparent, layers[number('audio', -1)], signal, report);
          setResult([{ name: 'video-collage.' + (transparent ? 'webm' : 'mp4'), blob }]);
        }
      } else if (source?.bitmap) {
        if (tool === 'image-watermark' && !value('text').trim() && !logo) throw new Error(t('Enter watermark text or choose a logo.'));
        const canvas = canvasFor(resizeForImage());
        const context = canvas.getContext('2d')!;
        if (isCutout()) context.putImageData(createMaskImage(), 0, 0);
        else paintImage(context, canvas.width, canvas.height);
        const format = value('image-format', 'png') as ImageFormat;
        let blob: Blob, extension = format === 'jpeg' ? 'jpg' : format;
        try {
          blob = await encodeImage(canvas, format, number('quality', 90), ffmpeg, signal);
        } catch (error) {
          signal.throwIfAborted();
          if (format === 'png') throw error;
          blob = await toBlob(canvas); extension = 'png';
          signal.throwIfAborted();
          setResult([{ name: nameOf(source.file) + '-' + tool + '.png', blob }]);
          setStatus('The selected encoder could not export. A PNG is available instead.');
          return;
        }
        signal.throwIfAborted();
        setResult([{ name: nameOf(source.file) + '-' + tool + '.' + extension, blob }]);
      } else if (source?.probe) {
        const settings = getVideoOptions(source.probe, currentFrame);
        if (tool === 'video-watermark') {
          if (!value('text').trim() && !logo) throw new Error(t('Enter watermark text or choose a logo.'));
          const width = rotatePreview.videoWidth || source.probe.width;
          const height = rotatePreview.videoHeight || source.probe.height;
          const overlay = canvasFor({ width: Math.ceil(width / 2) * 2, height: Math.ceil(height / 2) * 2 });
          drawWatermark(overlay.getContext('2d')!, overlay.width, overlay.height, watermark());
          settings.overlay = await toBlob(overlay);
        }
        const generated = await processVideo(ffmpeg, tool as VideoOperation, source.file, source.probe, settings, { signal, onProgress: report, disk });
        signal.throwIfAborted();
        setResult(generated.files);
        setStatus(generated.note ?? 'Export ready.');
        return;
      }
      setStatus('Export ready.');
    });
  }

  function selectTool(next: QuickTool, updateUrl = false): void {
    if (working) return;
    const nextImage = isImageTool(next);
    if (next !== tool) {
      pause();
      if (isImage() !== nextImage || isCollage() || next === 'image-collage' || next === 'video-collage') {
        disposeSource(source); source = null;
        initialMask?.close(); initialMask = undefined;
        for (const layer of layers) disposeLayer(layer);
        layers = [];
        rotatePreview.removeAttribute('src');
        rotatePreview.load();
      }
      original = null; paintedMask = null; mask = new Uint8ClampedArray(); undo = []; redo = [];
      logo?.close(); logo = undefined;
      controls.replaceChildren();
      tool = next;
      if (isCutout()) initMask(initialMask);
      setResult();
      setStatus('');
    }
    nav.value = next;
    syncToolSelection();
    rotatePreview.style.transform = '';
    rotatePreview.muted = false;
    try { rotatePreview.playbackRate = 1; } catch { /* browser does not support rate adjustment */ }
    makeSettings(); update(); draw();
    if (updateUrl) history.replaceState(null, '', `${location.pathname}${location.search}#/tools?tool=${next}`);
  }

  function syncLanguageFromUrl(): void {
    const next = preferredQuickLanguage();
    if (next === language) return;
    language = next;
    refreshLocale();
  }

  function refreshLocale(): void {
    root.lang = language === 'zh' ? 'zh-Hans' : language;
    for (const node of root.querySelectorAll<HTMLElement>('[data-quick-label]')) node.textContent = t(node.dataset.quickLabel!);
    for (const group of nav.querySelectorAll<HTMLOptGroupElement>('optgroup')) group.label = t(group.dataset.quickGroup!);
    for (const [node, label] of [[progress, 'Progress'], [canvas, 'Preview'], [rotatePreview, 'Preview']] as const) {
      node.setAttribute('aria-label', t(label));
    }
    localizeToolGrid();
    makeSettings();
    update();
    if (!working) draw();
  }

  window.addEventListener(QUICK_LOCALE_EVENT, (event) => {
    const next = (event as CustomEvent<QuickLanguage>).detail;
    if (next === language) return;
    language = next;
    refreshLocale();
  });

  function pointer(event: PointerEvent): { x: number; y: number } {
    const area = canvas.getBoundingClientRect();
    return { x: clamp((event.clientX - area.left) / area.width, 0, 0.99999), y: clamp((event.clientY - area.top) / area.height, 0, 0.99999) };
  }

  function dragMode(layer: Layer, { x, y }: { x: number; y: number }): LayerDrag['mode'] | null {
    const near = (a: number, b: number, limit: number) => Math.abs(a - b) < 11 / Math.max(limit, 1);
    const right = layer.x + layer.width, bottom = layer.y + layer.height;
    const nearX = (v: number) => near(x, v, canvas.clientWidth);
    const nearY = (v: number) => near(y, v, canvas.clientHeight);
    if (nearX(right) && nearY(bottom)) return 'resize';
    if (nearY((layer.y + bottom) / 2)) {
      if (nearX(layer.x)) return 'left';
      if (nearX(right)) return 'right';
    }
    if (nearX((layer.x + right) / 2)) {
      if (nearY(layer.y)) return 'top';
      if (nearY(bottom)) return 'bottom';
    }
    return null;
  }

  function applyLayerDrag(point: { x: number; y: number }, drag: LayerDrag): void {
    const { layer, start, mode } = drag;
    const step = checked('snap') ? 100 : 1000;
    const snap = (value: number) => Math.round(value * step) / step;
    const x = point.x - drag.x, y = point.y - drag.y;
    if (mode === 'move') {
      layer.x = clamp(snap(start.x + x), -1, 1);
      layer.y = clamp(snap(start.y + y), -1, 1);
    } else if (mode === 'resize') {
      layer.width = clamp(snap(start.width + x), 0.02, 2);
      layer.height = clamp(snap(start.height + y), 0.02, 2);
    } else {
      const horizontal = mode === 'left' || mode === 'right';
      const startEdge = mode === 'left' || mode === 'top';
      const remaining = horizontal ? 1 - start.left - start.right : 1 - start.top - start.bottom;
      const delta = (horizontal ? x / start.width : y / start.height) * (startEdge ? 1 : -1);
      const edgeLimit = Math.min(0.9, start[mode] + remaining * (1 - 0.01 / (horizontal ? start.width : start.height)));
      const crop = clamp(start[mode] + delta * remaining, 0, edgeLimit);
      const removed = (crop - start[mode]) / remaining;
      layer[mode] = crop;
      if (horizontal) {
        layer.width = start.width * (1 - removed);
        if (startEdge) layer.x = start.x + start.width * removed;
      } else {
        layer.height = start.height * (1 - removed);
        if (startEdge) layer.y = start.y + start.height * removed;
      }
    }
    for (const key of ['x', 'y', 'width', 'height', 'left', 'right', 'top', 'bottom'] as const) {
      field('layer-' + key).value = String(Math.round(layer[key] * 100));
    }
    draw();
  }

  canvas.addEventListener('pointerdown', event => {
    if (working || event.button !== 0) return;
    const point = pointer(event);
    const { x, y } = point;
    if (isCollage()) {
      const selected = layers[layerSelection];
      const mode = selected && dragMode(selected, point);
      let index = mode ? layerSelection : layers.length - 1;
      if (!mode) {
        for (; index >= 0; index--) {
          const layer = layers[index];
          if (x >= layer.x && x <= layer.x + layer.width && y >= layer.y && y <= layer.y + layer.height) break;
        }
      }
      if (index < 0) return;
      layerSelection = index;
      const layer = layers[index];
      drag = { layer, x, y, start: { ...layer }, mode: mode || 'move' };
      canvas.setPointerCapture(event.pointerId);
      makeSettings();
    } else if (isCutout() && original) {
      const px = x * original.width, py = y * original.height;
      if (value('brush') === 'pick') {
        const i = (Math.floor(py) * original.width + Math.floor(px)) * 4;
        sampled = [original.data[i], original.data[i + 1], original.data[i + 2]];
        field('key-color').value = '#' + sampled.map(byte => byte.toString(16).padStart(2, '0')).join('');
        setStatus('Color sampled. Adjust tolerance and remove the sampled color.');
        return;
      }
      rememberMask();
      stroke = { x: px, y: py };
      canvas.setPointerCapture(event.pointerId);
      applyBrush(px, py);
    }
  });
  canvas.addEventListener('pointermove', event => {
    const { x, y } = pointer(event);
    if (drag) applyLayerDrag({ x, y }, drag);
    else if (stroke && original) {
      const px = x * original.width, py = y * original.height;
      const dx = px - stroke.x, dy = py - stroke.y;
      const count = Math.max(1, Math.ceil(Math.hypot(dx, dy) / Math.max(1, number('brush-size') / 4)));
      for (let i = 1; i <= count; i++) applyBrush(stroke.x + dx * i / count, stroke.y + dy * i / count);
      stroke = { x: px, y: py };
    }
  });
  canvas.addEventListener('lostpointercapture', () => { stroke = null; drag = null; });

  const setField = (id: string, value: number) => { field(id).value = String(value); };
  form.addEventListener('input', (event) => {
    const target = event.target as HTMLInputElement;
    const key = target.id.slice(2);
    if (key === 'key-color') sampled = null;
    if (key === 'aspect') {
      const sizes: Record<string, [number, number]> = { landscape: [1280, 720], vertical: [720, 1280], square: [1080, 1080], classic: [1200, 900] };
      const size = sizes[target.value];
      if (size) { setField('width', size[0]); setField('height', size[1]); }
    }
    if (key === 'layer') { layerSelection = Number(target.value); makeSettings(); }
    if (key.startsWith('layer-') && layers[layerSelection]) {
      const layer = layers[layerSelection];
      const field = key.slice(6);
      if (field === 'end') layer.end = target.value as Layer['end'];
      else if (target.validity.valid) {
        const value = percent(Number(target.value));
        if (field === 'left' && value + layer.right >= 0.98 || field === 'right' && value + layer.left >= 0.98 ||
          field === 'top' && value + layer.bottom >= 0.98 || field === 'bottom' && value + layer.top >= 0.98) {
          target.value = String(Math.round(layer[field] * 100));
        } else layer[field as 'x' | 'y' | 'width' | 'height' | 'left' | 'right' | 'top' | 'bottom' | 'radius'] = value;
      }
    }
    if (key === 'collage-time') { pause(); updateCollageTime(Number(target.value)); }
    if (key === 'speed-preset' && target.value !== 'custom') setField('speed', Number(target.value));
    if (key === 'speed') field('speed-preset').value = 'custom';
    if (key === 'quality-preset' && target.value !== 'custom') setField('quality', Number(target.value));
    if (key === 'quality') field('quality-preset').value = 'custom';
    if ((key === 'width' || key === 'height') && source?.bitmap && tool === 'image-converter' && target.validity.valid) {
      field('scale').value = 'custom';
      if (checked('lock')) {
        const ratio = source.bitmap.width / source.bitmap.height;
        setField(key === 'width' ? 'height' : 'width', Math.max(1, Math.round(Number(target.value) * (key === 'width' ? 1 / ratio : ratio))));
      }
    }
    if (key === 'scale' && target.value !== 'custom' && source?.bitmap) {
      setField('width', resizeForImage().width);
      setField('height', resizeForImage().height);
    }
    updateFieldVisibility();
    if (form.checkValidity()) draw();
    directSave.hidden = !canSaveDirectly();
  });
  controls.addEventListener('change', (event) => {
    const target = event.target as HTMLInputElement;
    if (target.id !== 'q-logo') return;
    const file = target.files?.[0];
    if (file) void perform('Opening media…', async signal => {
      const next = await decodeImage(file, ffmpeg, signal);
      logo?.close(); logo = next; draw(); setStatus('Ready.');
    });
  });
  rotatePreview.addEventListener('loadedmetadata', draw);
  rotatePreview.addEventListener('error', () => {
    if (source?.probe) setStatus('This browser cannot preview the file. You can still export it.');
  });
  drop.addEventListener('click', () => input.click());
  drop.addEventListener('dragover', (event) => { event.preventDefault(); if (!working) drop.classList.add('is-dragging'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('is-dragging'));
  drop.addEventListener('drop', (event) => {
    event.preventDefault();
    drop.classList.remove('is-dragging');
    if (working) return;
    const files = Array.from(event.dataTransfer?.files ?? []);
    void loadFiles(isCollage() ? files : files.slice(0, 1));
  });
  input.addEventListener('change', () => {
    const files = Array.from(input.files ?? []);
    input.value = '';
    void loadFiles(files);
  });
  nav.addEventListener('change', () => selectTool(quickTool(nav.value), true));
  cancel.addEventListener('click', () => working?.abort());
  form.addEventListener('submit', event => { event.preventDefault(); void exportCurrent(); });
  directSave.addEventListener('click', () => {
    const picker = diskPicker();
    if (!source || !picker || !form.reportValidity()) return;
    const selected = source;
    const selectedTool = tool;
    const format = tool === 'video-compressor' ? 'mp4' : value('video-format', 'mp4');
    const name = nameOf(source.file) + '-' + tool + '.' + format;
    void picker.call(window, { suggestedName: name }).then(handle => {
      if (source === selected && tool === selectedTool) return exportCurrent(false, handle);
    }).catch(error => {
      if (!isAbortError(error)) setStatus(error instanceof Error ? error.message : String(error));
    });
  });
  handoff.addEventListener('click', () => {
    if (source) options.open(source.file, isImage() ? 'vision' : 'video');
  });

  for (const [image, label] of [[false, 'Video tools'], [true, 'Image tools']] as const) {
    const group = document.createElement('optgroup');
    group.dataset.quickGroup = label;
    for (const [id, title] of QUICK_TOOLS) {
      if (isImageTool(id) !== image) continue;
      const option = new Option('', id);
      localizeText(option, title);
      group.append(option);
    }
    nav.append(group);
  }
  renderToolGrid();
  refreshLocale();
  selectTool(tool);

  return {
    current: () => tool,
    show() {
      syncLanguageFromUrl();
      const query = new URLSearchParams(location.hash.split('?')[1]);
      if (query.has('tool')) selectTool(quickTool(query.get('tool')));
    },
    pause,
    async refine(file: File, cutout: Blob) {
      selectTool('background-remover', true);
      await loadFiles([file], undefined, cutout);
    },
  };
}
