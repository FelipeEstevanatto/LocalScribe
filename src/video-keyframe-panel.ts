import { EASINGS, valueAt, type Easing, type Keyframe } from './video-effects';
import { keySelectionId, retimeKeys, type KeyProperty, type KeySelection, type PanelAnimation } from './video-keyframe-timing';

interface Property {
  key: KeyProperty;
  label: string;
  group: string;
  unit: string;
  factor: number;
  min: number;
  max: number;
}

const properties: Property[] = [
  { key: 'speed', label: 'Speed', group: 'Timing', unit: '%', factor: 100, min: 25, max: 400 },
  { key: 'scale', label: 'Zoom', group: 'Transform', unit: '%', factor: 100, min: 5, max: 400 },
  { key: 'x', label: 'Position X', group: 'Transform', unit: '%', factor: 1, min: -200, max: 200 },
  { key: 'y', label: 'Position Y', group: 'Transform', unit: '%', factor: 1, min: -200, max: 200 },
  { key: 'rotation', label: 'Rotation', group: 'Transform', unit: '°', factor: 1, min: -180, max: 180 },
  { key: 'opacity', label: 'Opacity', group: 'Composite', unit: '%', factor: 100, min: 0, max: 100 },
  { key: 'volume', label: 'Volume', group: 'Audio', unit: '%', factor: 100, min: 0, max: 200 },
  { key: 'brightness', label: 'Brightness', group: 'Effects', unit: '%', factor: 1, min: -100, max: 100 },
  { key: 'contrast', label: 'Contrast', group: 'Effects', unit: '%', factor: 1, min: -100, max: 100 },
  { key: 'saturation', label: 'Saturation', group: 'Effects', unit: '%', factor: 1, min: -100, max: 100 },
  { key: 'hue', label: 'Hue', group: 'Effects', unit: '°', factor: 1, min: -180, max: 180 },
  { key: 'blur', label: 'Blur', group: 'Effects', unit: ' px', factor: 1, min: 0, max: 40 },
];

export interface KeyframeClip {
  id: number;
  name: string;
  start: number;
  duration: number;
  locked: boolean;
  animation: PanelAnimation;
  speedLocked?: boolean;
  effects: {
    label: string;
    start: number;
    end: number;
    section: 'dynamic-zoom' | 'transition';
    summary?: string;
    sample?: (at: number) => number;
  }[];
}

interface Geometry { scale: number; left: number; width: number; sidebar: number }
interface Options {
  onClose(): void;
  onSeek(time: number, keepVisible?: boolean): void;
  onPause(): void;
  onChange(id: number, animation: PanelAnimation, label?: string): boolean;
  onEffect(section: 'dynamic-zoom' | 'transition'): void;
  sample(id: number, property: KeyProperty, time: number): number;
  frameRate(): number;
  timecode(time: number): string;
}

const round = (value: number, digits = 3): string => String(Number(value.toFixed(digits)));
const visibleKeys = (keys: readonly Keyframe[], duration: number): Keyframe[] => keys.filter((key) => key.at <= duration + 0.000001);
const formatted = (property: Property, value: number) => round(value * property.factor, 2) + property.unit;
const anchored = ({ property, at }: KeySelection) => property === 'speed' && at === 0;

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, label?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  if (label !== undefined) element.textContent = label;
  return element;
}

function button(label: string, action: () => void, className = 'vk-button'): HTMLButtonElement {
  const element = node('button', className, label);
  element.type = 'button';
  element.addEventListener('click', action);
  return element;
}

function curve(keys: readonly Keyframe[], duration: number, sample: (at: number) => number) {
  const anchors = [0, ...keys.map(({ at }) => at).filter((at) => at > 0 && at < duration), duration];
  const times = anchors.flatMap((at, index) => {
    const end = anchors[index + 1];
    if (end === undefined) return [at];
    return [...Array.from({ length: 12 }, (_, step) => at + (end - at) * step / 12), end - (end - at) * 0.000001];
  });
  const samples = times.map(sample);
  const low = Math.min(...samples);
  const high = Math.max(...samples);
  const height = (value: number) => high === low ? 50 : 84 - (value - low) / (high - low) * 68;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('vk-curve');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('viewBox', '0 0 1000 100');
  svg.setAttribute('preserveAspectRatio', 'none');
  const path = document.createElementNS(svg.namespaceURI, 'path');
  path.setAttribute('d', times.map((at, i) => (i ? 'L' : 'M') + round(at / duration * 1000) + ' ' + round(height(samples[i]))).join(' '));
  path.setAttribute('vector-effect', 'non-scaling-stroke');
  svg.append(path);
  return { svg, height, low, high };
}

export function createKeyframePanel(root: HTMLElement, options: Options) {
  root.tabIndex = -1;
  const title = node('strong', 'vk-title', 'Clip animation');
  const add = node('select', 'vk-input');
  add.setAttribute('aria-label', 'Add animated property');
  const time = node('span', 'vk-time');
  const detail = node('div', 'vk-detail');
  const rows = node('div', 'vk-rows');
  const feedback = node('span', 'vk-feedback');
  feedback.setAttribute('role', 'status');
  const previous = button('‹', () => jump(-1));
  previous.setAttribute('aria-label', 'Previous keyframe');
  const next = button('›', () => jump(1));
  next.setAttribute('aria-label', 'Next keyframe');
  const close = button('×', options.onClose);
  close.setAttribute('aria-label', 'Close clip animation');
  const toolbar = node('div', 'vk-toolbar');
  toolbar.append(title, previous, next, time, add, close);
  root.append(toolbar, detail, rows, feedback);

  let clip: KeyframeClip | null = null;
  let open = false;
  let playhead = 0;
  let geometry: Geometry = { scale: 1, left: 0, width: 0, sidebar: 158 };
  let selection: KeySelection[] = [];
  const pinned = new Set<KeyProperty>();
  const graphs = new Set<KeyProperty>();
  let signature = '';
  let ruler: HTMLElement | null = null;
  let cancelDrag: (() => void) | undefined;

  const px = (at: number) => at * geometry.scale;
  const local = () => clip ? playhead - clip.start : 0;
  const snap = (at: number) => Math.round(at * options.frameRate()) / options.frameRate();
  const sample = (property: KeyProperty, at: number) => clip ? options.sample(clip.id, property, clip.start + at) : 0;
  const lookup = (key: KeySelection) => clip?.animation[key.property]?.find((entry) => entry.at === key.at);
  const speedLocked = () => Boolean(clip?.speedLocked && selection.some(({ property }) => property === 'speed'));

  function shownProperty(key: KeyProperty): boolean {
    const keys = clip?.animation[key];
    return pinned.has(key) || (key === 'speed'
      ? Boolean(keys && (keys.length > 1 || keys[0]?.value !== 1))
      : Boolean(keys?.length));
  }

  function navigationKeys(): Keyframe[] {
    if (!clip) return [];
    const animation = clip.animation;
    return visibleKeys(selection.length === 1
      ? animation[selection[0].property] ?? []
      : properties.flatMap(({ key }) => shownProperty(key) ? animation[key] ?? [] : []), clip.duration);
  }

  function jump(direction: number): void {
    if (!clip) return;
    const times = navigationKeys().map(({ at }) => at).sort((a, b) => a - b);
    const at = direction > 0 ? times.find((at) => at > local() + 0.00001) : times.reverse().find((at) => at < local() - 0.00001);
    if (at !== undefined) options.onSeek(clip.start + at);
  }

  function select(key: KeySelection, additive: boolean): void {
    const id = keySelectionId(key);
    if (!additive) selection = [key];
    else if (selection.some((entry) => keySelectionId(entry) === id)) selection = selection.filter((entry) => keySelectionId(entry) !== id);
    else selection = [...selection, key];
    updateSelection();
  }

  function change(animation: PanelAnimation, label: string, seek?: number): boolean {
    if (!clip || clip.locked) return false;
    const start = clip.start;
    if (!options.onChange(clip.id, animation, label)) {
      feedback.textContent = 'That speed change would place a speed point beyond the available media.';
      return false;
    }
    if (seek !== undefined) options.onSeek(start + seek);
    return true;
  }

  function revealProperty(property: KeyProperty): void {
    const row = rows.querySelector<HTMLElement>('[data-lane="' + property + '"]');
    if (!row) return;
    const viewport = rows.getBoundingClientRect();
    const bounds = row.getBoundingClientRect();
    const top = viewport.top + (ruler?.clientHeight ?? 0);
    if (bounds.top < top) rows.scrollTop += bounds.top - top;
    else if (bounds.bottom > viewport.bottom) rows.scrollTop += bounds.bottom - viewport.bottom;
  }

  function addKey(property: KeyProperty, at: number): void {
    if (!clip || clip.locked) return;
    const clamped = Math.max(0, Math.min(clip.duration, snap(at)));
    if (property === 'speed' && (clip.speedLocked || clamped >= clip.duration - 0.000001)) return;
    const keys = clip.animation[property] ?? [];
    const existing = keys.find((key) => Math.abs(key.at - clamped) <= 0.000001);
    if (existing) {
      select({ property, at: existing.at }, false);
      if (!rows.querySelector('[data-lane="' + property + '"]')) paint();
      revealProperty(property);
      options.onSeek(clip.start + existing.at);
      return;
    }
    if (keys.length >= (property === 'speed' ? 65 : 64)) {
      feedback.textContent = 'This property already has 64 keyframes.';
      return;
    }
    const previous = selection;
    selection = [{ property, at: clamped }];
    const updated = [...keys, { at: clamped, value: sample(property, clamped), easing: property === 'speed' ? 'hold' as const : 'linear' as const }].sort((a, b) => a.at - b.at);
    if (!change({ ...clip.animation, [property]: updated }, property === 'speed' ? 'Added speed point' : 'Added keyframe', clamped)) selection = previous;
    revealProperty(property);
  }

  function removeSelection(): void {
    if (!clip || clip.locked || !selection.length || speedLocked() || selection.some(anchored)) return;
    const animation = { ...clip.animation };
    const selected = new Set(selection.map(keySelectionId));
    for (const property of new Set(selection.map(({ property }) => property))) {
      pinned.add(property);
      animation[property] = animation[property]?.filter(({ at }) => !selected.has(keySelectionId({ property, at }))) ?? [];
    }
    const previous = selection;
    selection = [];
    if (!change(animation, previous.every(({ property }) => property === 'speed') ? 'Deleted speed points' : 'Deleted keyframes')) {
      selection = previous;
    }
  }

  function moveSelection(delta: number, anchor: number): boolean {
    if (!clip || clip.locked || speedLocked()) return false;
    const result = retimeKeys(clip.animation, selection, delta, clip.duration);
    if (!result) {
      feedback.textContent = 'A keyframe already occupies that time.';
      return false;
    }
    if (result.delta) {
      const previous = selection;
      selection = result.selection;
      if (!change(result.animation, selection.length > 1 ? 'Moved keyframes' : 'Moved keyframe', anchor + result.delta)) {
        selection = previous;
        return false;
      }
    }
    return true;
  }

  function controls(): void {
    detail.replaceChildren();
    if (!clip || !selection.length) {
      const message = !clip ? 'Select a video clip to edit its animation.' : clip.locked
        ? 'Unlock the video track to edit its keys.'
        : 'Drag keys to retime. Shift-click to select several.';
      detail.append(node('span', 'vk-message', message));
      return;
    }
    const primary = selection[0];
    const key = lookup(primary);
    const property = properties.find(({ key }) => key === primary.property)!;
    const locked = clip.locked || speedLocked();
    const fixed = selection.some(anchored);
    if (selection.length === 1 && key) {
      detail.append(node('strong', 'vk-selection', property.label));
      const number = (label: string, value: number, min: number, max: number, onChange: (value: number) => boolean, disabled = false) => {
        const field = node('label', 'vk-field', label);
        const input = node('input', 'vk-input');
        input.type = 'number';
        input.step = 'any';
        input.min = String(min);
        input.max = String(max);
        input.value = round(value, 6);
        input.disabled = locked || disabled;
        input.addEventListener('change', () => {
          const next = input.valueAsNumber;
          if (!Number.isFinite(next) || next < min || next > max || !onChange(next)) input.value = round(value, 6);
        });
        field.append(input);
        return field;
      };
      const edit = (part: Partial<Keyframe>): boolean => {
        if (!clip) return false;
        const updated = (clip.animation[primary.property] ?? []).map((entry) => entry.at === primary.at ? { ...entry, ...part } : entry);
        return change({ ...clip.animation, [primary.property]: updated }, primary.property === 'speed' ? 'Changed speed' : 'Edited keyframe');
      };
      detail.append(
        number('Clip time (s)', key.at, 0, clip.duration, (at) => moveSelection(at - key.at, key.at), fixed),
        number('Value ' + property.unit.trim(), key.value * property.factor, property.min, property.max,
          (value) => edit({ value: value / property.factor })),
      );
      const easingLabel = node('label', 'vk-field', 'Easing into key');
      const easing = node('select', 'vk-input');
      easing.setAttribute('aria-label', 'Easing into key');
      easing.replaceChildren(...EASINGS.map(({ value, label }) => new Option(label, value)));
      easing.value = key.easing ?? 'linear';
      easing.disabled = locked;
      easing.addEventListener('change', () => edit({ easing: easing.value as Easing }));
      easingLabel.append(easing);
      if (primary.property === 'speed') detail.append(node('span', 'vk-message', 'Rate applies until the next point'));
      else detail.append(easingLabel);
    } else {
      detail.append(node('strong', 'vk-selection', selection.length + ' keys selected'));
    }
    const earlier = button('−1 frame', () => moveSelection(-1 / options.frameRate(), primary.at));
    const later = button('+1 frame', () => moveSelection(1 / options.frameRate(), primary.at));
    const remove = button('Delete', removeSelection);
    earlier.disabled = later.disabled = remove.disabled = locked || fixed;
    detail.append(earlier, later, remove);
  }

  function updateSelection(): void {
    const selected = new Set(selection.map(keySelectionId));
    for (const marker of rows.querySelectorAll<HTMLButtonElement>('.vk-key')) {
      marker.setAttribute('aria-pressed', String(selected.has(marker.dataset.key ?? '')));
    }
    controls();
    position(playhead);
  }

  function startDrag(event: PointerEvent, key: KeySelection, marker: HTMLButtonElement): void {
    if (!clip || event.button !== 0) return;
    event.stopPropagation();
    if (event.shiftKey) {
      select(key, true);
      options.onSeek(clip.start + key.at, false);
      return;
    }
    if (!selection.some((picked) => keySelectionId(picked) === keySelectionId(key))) select(key, false);
    options.onPause();
    options.onSeek(clip.start + key.at, false);
    if (clip.locked || speedLocked() || selection.some(anchored)) return;
    const original = clip;
    const picked = [...selection];
    const markers = picked.map((entry) => rows.querySelector<HTMLElement>('[data-key="' + keySelectionId(entry) + '"]'));
    const x = event.clientX;
    const left = geometry.left;
    let moved = false;
    let result: ReturnType<typeof retimeKeys<PanelAnimation>> = null;
    marker.setPointerCapture(event.pointerId);
    const move = (pointer: PointerEvent): void => {
      if (pointer.pointerId !== event.pointerId || (!moved && Math.abs(pointer.clientX - x) < 3)) return;
      moved = true;
      const delta = (pointer.clientX - x + geometry.left - left) / geometry.scale;
      const candidate = retimeKeys(original.animation, picked, snap(key.at + delta) - key.at, original.duration);
      if (!candidate) {
        feedback.textContent = 'A keyframe already occupies that time.';
        return;
      }
      if (!options.onChange(original.id, candidate.animation)) {
        feedback.textContent = 'That speed point would be beyond the available media.';
        return;
      }
      feedback.textContent = '';
      result = candidate;
      options.onSeek(original.start + key.at + candidate.delta, false);
      for (const [i, entry] of candidate.selection.entries()) markers[i]?.style.setProperty('left', px(original.start + entry.at) + 'px');
    };
    const cleanup = (): void => {
      marker.removeEventListener('pointermove', move);
      marker.removeEventListener('pointerup', end);
      marker.removeEventListener('pointercancel', cancel);
      marker.removeEventListener('lostpointercapture', cancel);
      if (marker.hasPointerCapture(event.pointerId)) marker.releasePointerCapture(event.pointerId);
      cancelDrag = undefined;
    };
    const end = (pointer: PointerEvent): void => {
      if (pointer.pointerId !== event.pointerId) return;
      cleanup();
      if (result?.delta) {
        selection = result.selection;
        change(result.animation, selection.length > 1 ? 'Moved keyframes' : 'Moved keyframe');
      } else if (result) {
        options.onChange(original.id, original.animation);
      } else if (!moved) {
        select(key, false);
      }
    };
    const cancel = (): void => {
      cleanup();
      if (result) {
        options.onChange(original.id, original.animation);
        options.onSeek(original.start + key.at, false);
      }
      if (clip?.id === original.id) paint();
    };
    cancelDrag = cancel;
    marker.addEventListener('pointermove', move);
    marker.addEventListener('pointerup', end);
    marker.addEventListener('pointercancel', cancel);
    marker.addEventListener('lostpointercapture', cancel);
  }

  function lane(label: HTMLElement, className = '') {
    const row = node('div', ('vk-row ' + className).trim());
    const view = node('div', 'vk-view');
    const strip = node('div', 'vk-strip');
    view.append(strip, node('span', 'vk-playhead'));
    row.append(label, view);
    rows.append(row);
    view.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || (event.target as Element).closest('button')) return;
      const fromPointer = (pointer: PointerEvent) => {
        const at = (pointer.clientX - view.getBoundingClientRect().left + geometry.left) / geometry.scale;
        options.onSeek(Math.max(0, snap(at)), false);
      };
      options.onPause();
      fromPointer(event);
      view.setPointerCapture(event.pointerId);
      const scrub = (pointer: PointerEvent) => { if (pointer.pointerId === event.pointerId) fromPointer(pointer); };
      view.addEventListener('pointermove', scrub);
      view.addEventListener('lostpointercapture', () => view.removeEventListener('pointermove', scrub), { once: true });
    });
    return { row, strip, view };
  }

  function band(strip: HTMLElement, start: number, end: number): HTMLElement {
    const range = node('div', 'vk-band');
    range.style.left = px(start) + 'px';
    range.style.width = Math.max(1, px(end - start)) + 'px';
    strip.append(range);
    return range;
  }

  function paint(): void {
    const hadFocus = root.contains(document.activeElement);
    rows.replaceChildren();
    ruler = null;
    if (!clip) {
      title.textContent = 'Clip animation';
      add.disabled = previous.disabled = next.disabled = true;
      controls();
      if (hadFocus && !root.contains(document.activeElement)) root.focus({ preventScroll: true });
      return;
    }
    const current = clip;
    title.textContent = current.name;
    title.title = current.name;
    const shown = properties.filter(({ key }) => shownProperty(key));
    const available = properties.filter((property) => !shown.includes(property) &&
      (property.key !== 'speed' || (current.animation.speed && !current.speedLocked)));
    add.replaceChildren(new Option('Add property…', ''), ...available.map(({ key, group, label }) => new Option(group + ' · ' + label, key)));
    add.disabled = current.locked || !available.length;
    ruler = lane(node('div', 'vk-lane-label', 'Timeline'), 'vk-ruler').view;
    for (const effect of current.effects) {
      const effectButton = button(effect.label, () => options.onEffect(effect.section), 'vk-effect-button');
      effectButton.title = effect.summary ?? effect.label;
      const { strip } = lane(effectButton, 'vk-effect');
      const range = band(strip, current.start + effect.start, current.start + effect.end);
      if (effect.sample && effect.end > effect.start) range.append(curve([], effect.end - effect.start, effect.sample).svg);
      range.append(node('span', 'vk-effect-title', effect.summary ?? effect.label));
    }
    let group = '';
    for (const property of shown) {
      if (group !== property.group) {
        group = property.group;
        lane(node('div', 'vk-lane-label', group), 'vk-group');
      }
      const head = node('div', 'vk-lane-label');
      const amount = node('span', 'vk-value');
      amount.dataset.property = property.key;
      const graphButton = button(graphs.has(property.key) ? '▾' : '▸', () => {
        if (graphs.has(property.key)) graphs.delete(property.key);
        else graphs.add(property.key);
        paint();
        rows.querySelector<HTMLButtonElement>('[data-graph="' + property.key + '"]')?.focus();
      });
      graphButton.setAttribute('aria-label', property.label + ' value graph');
      graphButton.setAttribute('aria-expanded', String(graphs.has(property.key)));
      graphButton.dataset.graph = property.key;
      const insert = button('+', () => addKey(property.key, local()));
      insert.dataset.insert = property.key;
      insert.setAttribute('aria-label', property.key === 'speed' ? 'Add speed point at playhead' : 'Add ' + property.label + ' key at playhead');
      const name = node('span', 'vk-property', property.label);
      name.title = property.label;
      head.append(graphButton, name, amount, insert);
      const { row, strip } = lane(head, graphs.has(property.key) ? 'vk-expanded' : '');
      row.dataset.lane = property.key;
      const range = band(strip, current.start, current.start + current.duration);
      const keys = current.animation[property.key] ?? [];
      const fallback = keys.length ? 0 : sample(property.key, 0);
      const graph = graphs.has(property.key) && current.duration > 0
        ? curve(keys, current.duration, (at) => valueAt(keys, at, fallback))
        : null;
      if (graph) {
        range.append(graph.svg);
        amount.title = formatted(property, graph.low) + ' to ' + formatted(property, graph.high);
      }
      for (const key of visibleKeys(keys, current.duration)) {
        const identity = { property: property.key, at: key.at };
        const marker = node('button', 'vk-key');
        marker.type = 'button';
        marker.dataset.key = keySelectionId(identity);
        marker.title = property.label + ' · ' + formatted(property, key.value) + ' · ' + options.timecode(current.start + key.at);
        marker.setAttribute('aria-label', marker.title);
        marker.style.left = px(current.start + key.at) + 'px';
        if (graph) marker.style.top = graph.height(key.value) + '%';
        marker.addEventListener('pointerdown', (event) => startDrag(event, identity, marker));
        marker.addEventListener('click', (event) => {
          if (event.detail) return;
          select(identity, event.shiftKey);
          options.onSeek(current.start + key.at);
        });
        strip.append(marker);
      }
    }
    if (!shown.length) rows.append(node('p', 'vk-empty', 'Choose Add property to place your first keyframe.'));
    align();
    updateSelection();
    if (hadFocus && !root.contains(document.activeElement)) root.focus({ preventScroll: true });
  }

  function align(): void {
    if (!open) return;
    root.style.setProperty('--vk-sidebar', geometry.sidebar + 'px');
    root.style.setProperty('--vk-width', geometry.width + 'px');
    root.style.setProperty('--vk-shift', -geometry.left + 'px');
    if (ruler) {
      ruler.querySelectorAll('.vk-tick').forEach((tick) => tick.remove());
      const target = 82 / geometry.scale;
      const base = Math.pow(10, Math.floor(Math.log10(target)));
      const step = [1, 2, 5, 10].map((value) => value * base).find((value) => value >= target) ?? base * 10;
      const first = Math.ceil(geometry.left / geometry.scale / step);
      const last = Math.floor((geometry.left + geometry.width) / geometry.scale / step);
      for (let i = first; i <= last; i++) {
        const tick = node('span', 'vk-tick', options.timecode(i * step));
        tick.style.left = px(i * step) - geometry.left + 'px';
        ruler.append(tick);
      }
    }
  }

  function position(at: number): void {
    playhead = at;
    if (!open || !clip) return;
    const within = local() >= -0.000001 && local() <= clip.duration + 0.000001;
    root.style.setProperty('--vk-playhead', px(at) - geometry.left + 'px');
    const timestamp = options.timecode(at) + (within ? ' · ' + round(Math.max(0, local())) + ' s in clip' : ' · Outside clip');
    if (time.textContent !== timestamp) time.textContent = timestamp;
    const keys = navigationKeys();
    previous.disabled = !keys.some(({ at }) => at < local() - 0.00001);
    next.disabled = !keys.some(({ at }) => at > local() + 0.00001);
    for (const output of rows.querySelectorAll<HTMLElement>('.vk-value')) {
      const property = properties.find(({ key }) => key === output.dataset.property)!;
      const value = formatted(property, sample(property.key, local()));
      if (output.textContent !== value) output.textContent = value;
    }
    for (const insert of rows.querySelectorAll<HTMLButtonElement>('[data-insert]')) {
      insert.disabled = clip.locked || !within || (insert.dataset.insert === 'speed' && (Boolean(clip.speedLocked) || local() >= clip.duration - 0.000001));
    }
  }

  add.addEventListener('change', () => {
    if (!clip || !add.value) return;
    const property = add.value as KeyProperty;
    pinned.add(property);
    if (local() >= 0 && local() <= clip.duration) addKey(property, local());
    else {
      paint();
      revealProperty(property);
    }
  });
  root.addEventListener('keydown', (event) => {
    if (!selection.length || (event.target as Element).closest('input, select')) return;
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      event.stopPropagation();
      removeSelection();
    }
  });

  return {
    isOpen: () => open,
    pin(property: KeyProperty): void {
      if (!open || !clip) return;
      if (!shownProperty(property)) {
        pinned.add(property);
        paint();
      }
      revealProperty(property);
    },
    setOpen(value: boolean): void {
      if (open === value) return;
      if (!value) cancelDrag?.();
      open = value;
      root.hidden = !value;
      if (value) paint();
    },
    setClip(value: KeyframeClip | null): void {
      if (cancelDrag && clip?.id === value?.id) return;
      if (value?.id !== clip?.id) {
        cancelDrag?.();
        selection = [];
        pinned.clear();
        graphs.clear();
        rows.scrollTop = 0;
      }
      clip = value;
      if (!open) return;
      const next = clip ? JSON.stringify(clip) : '';
      if (next === signature && rows.childElementCount) return;
      signature = next;
      selection = selection.filter((key) => lookup(key));
      feedback.textContent = '';
      paint();
    },
    setGeometry(value: Geometry): void {
      const scaleChanged = geometry.scale !== value.scale;
      const changed = scaleChanged || geometry.left !== value.left || geometry.width !== value.width || geometry.sidebar !== value.sidebar;
      geometry = value;
      if (!open || !changed) return;
      if (scaleChanged && !cancelDrag) paint();
      else {
        align();
        position(playhead);
      }
    },
    position,
  };
}
