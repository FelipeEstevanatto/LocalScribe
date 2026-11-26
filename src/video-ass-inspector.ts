import type { AssCueEdits } from './ass-subtitles';

type Fields = Record<string, string>;
type FieldSpec = [key: string, label: string, type?: 'number' | 'flag' | 'color'];

const STYLE_GROUPS: [label: string, fields: FieldSpec[]][] = [
  ['Typography', [
    ['fontname', 'Font family'], ['fontsize', 'Font size (script px)', 'number'],
    ['bold', 'Bold', 'flag'], ['italic', 'Italic', 'flag'],
    ['underline', 'Underline', 'flag'], ['strikeout', 'Strikethrough', 'flag'],
    ['primarycolour', 'Text color', 'color'], ['secondarycolour', 'Karaoke color', 'color'],
  ]],
  ['Layout', [
    ['alignment', 'Anchor alignment', 'number'], ['angle', 'Rotation (°)', 'number'],
    ['scalex', 'Scale X (%)', 'number'], ['scaley', 'Scale Y (%)', 'number'],
    ['spacing', 'Letter spacing', 'number'],
    ['marginl', 'Left margin', 'number'], ['marginr', 'Right margin', 'number'],
    ['marginv', 'Vertical margin', 'number'], ['margint', 'Top margin', 'number'], ['marginb', 'Bottom margin', 'number'],
  ]],
  ['Outline, shadow and box', [
    ['borderstyle', 'Border mode', 'number'], ['outline', 'Outline width', 'number'],
    ['shadow', 'Shadow depth', 'number'], ['outlinecolour', 'Outline color', 'color'],
    ['tertiarycolour', 'Outline color', 'color'], ['backcolour', 'Shadow / box color', 'color'],
  ]],
];

const EVENT_FIELDS: FieldSpec[] = [
  ['marginl', 'Left margin', 'number'], ['marginr', 'Right margin', 'number'],
  ['marginv', 'Vertical margin', 'number'], ['margint', 'Top margin', 'number'],
  ['marginb', 'Bottom margin', 'number'], ['effect', 'Event effect'],
];

interface AssInspectorOptions {
  name: string;
  style: Fields;
  event: Fields;
  raw: string;
  open: Set<string>;
  changed: boolean;
  canPaste: boolean;
  onEdit: (edit: AssCueEdits) => void;
  onRaw: (raw: string) => boolean;
  onCopy: () => void;
  onPaste: () => void;
  onReset: () => void;
}

function action(label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn-secondary';
  button.textContent = label;
  button.addEventListener('click', onClick);
  return button;
}

function assColorValue(value: string): number {
  return (/^&H/i.test(value) ? parseInt(value.slice(2), 16) : Number(value)) >>> 0;
}

function assColorSwatch(value: string): string {
  const bgr = assColorValue(value);
  const rgb = ((bgr & 0xff) << 16) | (bgr & 0xff00) | ((bgr >>> 16) & 0xff);
  return '#' + rgb.toString(16).padStart(6, '0');
}

function editField([key, title, type]: FieldSpec, value: string, update: (value: string) => void): HTMLElement {
  const label = document.createElement('label');
  label.className = 'sfield';
  const caption = document.createElement('span');
  caption.className = 'field-label';
  caption.textContent = title;
  const input = document.createElement('input');
  input.className = type === 'flag' ? 'checkbox' : 'select';
  input.type = type === 'flag' ? 'checkbox' : type === 'number' ? 'number' : 'text';
  input.value = value;
  if (type === 'flag') {
    input.checked = Number(value) !== 0;
    label.className = 'video-ass-flag';
  }
  if (type === 'number') input.step = 'any';
  if (type === 'color') {
    input.placeholder = '&HAABBGGRR';
    input.spellcheck = false;
    input.title = 'ASS color in &HAABBGGRR order. Alpha 00 is opaque.';
  }
  let current = value;
  const swatch = type === 'color' ? document.createElement('input') : null;
  input.addEventListener('change', () => {
    const next = type === 'flag' ? (input.checked ? '-1' : '0') : input.value.trim();
    const valid = !/[,{}\r\n]/.test(next) &&
      (type !== 'number' || (next !== '' && Number.isFinite(Number(next)))) &&
      (type !== 'color' || /^(?:&H[\da-f]{1,8}&?|-?\d+)$/i.test(next)) &&
      (key !== 'fontname' || next !== '');
    if (!valid) {
      input.value = current;
      return;
    }
    if (next !== current) update(next);
    current = next;
    if (swatch) swatch.value = assColorSwatch(next);
  });
  label.append(caption, input);
  if (!swatch) return label;
  swatch.type = 'color';
  swatch.className = 'video-color-input';
  swatch.value = assColorSwatch(value);
  swatch.setAttribute('aria-label', 'Choose ' + title.toLowerCase());
  swatch.addEventListener('change', () => {
    const rgb = Number('0x' + swatch.value.slice(1));
    const bgr = (((assColorValue(current) & 0xff000000) | ((rgb & 0xff) << 16) | (rgb & 0xff00) | (rgb >>> 16))) >>> 0;
    input.value = /^&H/i.test(current) ? '&H' + bgr.toString(16).toUpperCase().padStart(8, '0') : String(bgr);
    input.dispatchEvent(new Event('change'));
  });
  const row = document.createElement('div');
  row.className = 'video-ass-color-field';
  row.append(label, swatch);
  return row;
}

export function renderAssInspector(options: AssInspectorOptions): HTMLElement {
  const root = document.createElement('div');
  root.className = 'video-ass-inspector';
  const heading = document.createElement('div');
  heading.className = 'video-caption-appearance';
  const title = document.createElement('strong');
  title.textContent = 'ASS appearance';
  const name = document.createElement('span');
  name.textContent = options.name || 'Default style';
  heading.append(title, name);
  const actions = document.createElement('div');
  actions.className = 'video-ass-actions';
  const feedback = document.createElement('p');
  feedback.className = 'video-subtitle-note';
  feedback.setAttribute('role', 'status');
  const paste = action('Paste style', options.onPaste);
  paste.disabled = !options.canPaste;
  paste.title = 'Paste a style copied from this source track';
  const reset = action('Reset appearance', options.onReset);
  reset.disabled = !options.changed;
  actions.append(action('Copy style', () => {
    options.onCopy();
    paste.disabled = false;
    feedback.textContent = 'Style copied. Select another caption from this track to paste it.';
  }), paste, reset);
  root.append(heading, actions, feedback);

  const section = (title: string): HTMLElement => {
    const details = document.createElement('details');
    details.className = 'video-caption-style-group';
    details.open = options.open.has(title);
    details.addEventListener('toggle', () => {
      if (!details.isConnected) return;
      if (details.open) options.open.add(title);
      else options.open.delete(title);
    });
    const summary = document.createElement('summary');
    summary.textContent = title;
    const body = document.createElement('div');
    body.className = 'video-caption-style-fields';
    details.append(summary, body);
    root.append(details);
    return body;
  };
  const fields = (title: string, specs: FieldSpec[], values: Fields, kind: 'style' | 'event'): void => {
    const relevant = specs.filter(([key]) => Object.hasOwn(values, key));
    if (!relevant.length) return;
    const grid = document.createElement('div');
    grid.className = 'video-ass-field-grid';
    for (const spec of relevant) {
      const [key] = spec;
      grid.append(editField(spec, values[key], (value) => {
        options.onEdit({ [kind]: { [key]: value } });
        reset.disabled = false;
      }));
    }
    section(title).append(grid);
  };
  for (const [title, specs] of STYLE_GROUPS) fields(title, specs, options.style, 'style');
  fields('Cue margins and effect', EVENT_FIELDS, options.event, 'event');
  const known = new Set(['name', ...STYLE_GROUPS.flatMap(([, specs]) => specs.map(([key]) => key))]);
  fields('Other style fields', Object.keys(options.style).filter((key) => !known.has(key)).map((key) => [key, key]), options.style, 'style');

  const overrides = section('Inline overrides');
  const help = document.createElement('p');
  help.className = 'video-subtitle-note';
  help.textContent = 'ASS tags can override the base style for parts of a cue. Edit tags here for position, motion, karaoke, and other effects.';
  const raw = document.createElement('textarea');
  raw.className = 'select video-caption-editor-input video-ass-raw';
  raw.setAttribute('aria-label', 'ASS dialogue and overrides');
  raw.spellcheck = false;
  raw.rows = 4;
  raw.value = options.raw;
  overrides.append(help, raw, action('Apply inline overrides', () => {
    if (!options.onRaw(raw.value)) feedback.textContent = 'Enter dialogue on one ASS line. Use \\N for a line break.';
  }));
  return root;
}
