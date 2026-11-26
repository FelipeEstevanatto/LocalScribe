/**
 * Scrollable, zoomable waveform with an optional draggable selection.
 *
 * A transparent native scroller sits over a canvas, so the browser provides
 * the scrollbar and momentum scrolling while the canvas only paints the
 * visible window.
 */

export interface Selection {
  start: number;
  end: number;
}

export interface WaveformOptions {
  height?: number;
  selectable?: boolean;
  ruler?: boolean;
  color?: string;
  label?: string;
  onSeek?: (time: number) => void;
  onSelect?: (selection: Selection | null) => void;
  onZoom?: (zoom: number) => void;
}

const HANDLE_HIT = 9;
const MAX_ZOOM = 200;

export function formatClock(seconds: number, precise = false): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  const whole = precise ? rest.toFixed(2).padStart(5, '0') : String(Math.floor(rest)).padStart(2, '0');
  return `${minutes}:${whole}`;
}

function tickStep(pxPerSecond: number): number {
  const steps = [0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800];
  return steps.find((step) => step * pxPerSecond >= 72) ?? 3600;
}

export class WaveformView {
  readonly element: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly scroller: HTMLDivElement;
  private readonly spacer: HTMLDivElement;
  private readonly options: Required<Pick<WaveformOptions, 'height' | 'selectable' | 'ruler' | 'color'>> & WaveformOptions;
  private peaks: Float32Array = new Float32Array();
  private duration = 0;
  private zoom = 1;
  private playhead = 0;
  private selection: Selection | null = null;
  private markers: number[] = [];
  private labels: { time: number; text: string }[] = [];
  private drag: { id: number; mode: 'new' | 'start' | 'end' | 'move'; anchor: number; x: number; original: Selection | null } | null = null;
  private frame = 0;
  follow = false;

  constructor(options: WaveformOptions = {}) {
    this.options = { height: 128, selectable: false, ruler: true, color: '#818cf8', ...options };
    const { height } = this.options;
    this.element = document.createElement('div');
    this.element.className = 'waveform-view';
    this.element.style.height = `${height + 10}px`;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'waveform-canvas';
    this.canvas.style.height = `${height}px`;
    this.canvas.setAttribute('aria-hidden', 'true');
    this.scroller = document.createElement('div');
    this.scroller.className = 'waveform-scroller';
    this.scroller.tabIndex = 0;
    this.scroller.setAttribute('role', 'slider');
    this.scroller.setAttribute('aria-label', options.label ?? 'Waveform. Click to seek. Left and right arrows move the playhead.');
    this.spacer = document.createElement('div');
    this.spacer.style.height = `${height}px`;
    this.scroller.append(this.spacer);
    this.element.append(this.canvas, this.scroller);

    this.scroller.addEventListener('scroll', () => this.schedule());
    this.scroller.addEventListener('pointerdown', (event) => this.pointerDown(event));
    this.scroller.addEventListener('pointermove', (event) => this.pointerMove(event));
    this.scroller.addEventListener('pointerup', (event) => this.pointerUp(event));
    this.scroller.addEventListener('lostpointercapture', () => { this.drag = null; });
    this.scroller.addEventListener('wheel', (event) => this.wheel(event), { passive: false });
    if ('ResizeObserver' in window) new ResizeObserver(() => this.layout()).observe(this.element);
  }

  setData(peaks: Float32Array, duration: number): void {
    this.peaks = peaks;
    this.duration = duration;
    this.playhead = Math.min(this.playhead, duration);
    if (this.selection && this.selection.end > duration) this.selection = null;
    this.layout();
  }

  setSelectable(selectable: boolean): void {
    this.options.selectable = selectable;
    this.scroller.style.cursor = selectable ? 'text' : 'pointer';
    this.schedule();
  }

  getDuration(): number {
    return this.duration;
  }

  getZoom(): number {
    return this.zoom;
  }

  /** Zoom keeping `anchor` (seconds) under the same screen position. */
  setZoom(zoom: number, anchor?: number): void {
    const width = this.scroller.clientWidth;
    const next = Math.max(1, Math.min(MAX_ZOOM, zoom));
    if (!width || !this.duration) {
      this.zoom = next;
      this.layout();
      return;
    }
    const focus = anchor ?? (this.follow ? this.playhead : this.timeAtX(width / 2));
    const screenX = this.xForTime(focus);
    this.zoom = next;
    this.spacer.style.width = `${width * this.zoom}px`;
    this.scroller.scrollLeft = (focus / this.duration) * width * this.zoom - Math.max(0, Math.min(width, screenX));
    this.options.onZoom?.(this.zoom);
    this.schedule();
  }

  setPlayhead(time: number): void {
    this.playhead = Math.max(0, Math.min(this.duration, time));
    if (this.follow && this.zoom > 1) {
      const x = this.xForTime(this.playhead);
      const width = this.scroller.clientWidth;
      if (x < 0 || x > width * 0.92) this.scroller.scrollLeft += x - width * 0.1;
    }
    this.schedule();
  }

  setSelection(selection: Selection | null, notify = false): void {
    if (selection) {
      const start = Math.max(0, Math.min(selection.start, selection.end));
      const end = Math.min(this.duration, Math.max(selection.start, selection.end));
      this.selection = end - start > 0.001 ? { start, end } : null;
    } else {
      this.selection = null;
    }
    if (notify) this.options.onSelect?.(this.selection);
    this.schedule();
  }

  getSelection(): Selection | null {
    return this.selection;
  }

  /** Marker times in seconds (drawn as numbered amber lines). */
  setMarkers(markers: number[]): void {
    this.markers = [...markers].sort((a, b) => a - b);
    this.schedule();
  }

  /** Timed text (lyrics) drawn along the bottom edge when there is room. */
  setLabels(labels: { time: number; text: string }[]): void {
    this.labels = labels;
    this.schedule();
  }

  /** Time under a client X coordinate, for double-click handling. */
  timeAtClientX(clientX: number): number {
    return this.timeAtX(clientX - this.scroller.getBoundingClientRect().left);
  }

  /** Scroll so `time` is visible. */
  reveal(time: number): void {
    const x = this.xForTime(time);
    const width = this.scroller.clientWidth;
    if (x < 0 || x > width) this.scroller.scrollLeft += x - width / 3;
  }

  private pxPerSecond(): number {
    return this.duration ? (this.scroller.clientWidth * this.zoom) / this.duration : 0;
  }

  private xForTime(time: number): number {
    return time * this.pxPerSecond() - this.scroller.scrollLeft;
  }

  private timeAtX(x: number): number {
    const pps = this.pxPerSecond();
    if (!pps) return 0;
    return Math.max(0, Math.min(this.duration, (x + this.scroller.scrollLeft) / pps));
  }

  private eventX(event: PointerEvent | WheelEvent): number {
    return event.clientX - this.scroller.getBoundingClientRect().left;
  }

  private layout(): void {
    const width = this.scroller.clientWidth;
    this.spacer.style.width = `${Math.max(width, width * this.zoom)}px`;
    this.schedule();
  }

  private schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  private pointerDown(event: PointerEvent): void {
    if (event.button !== 0 || !this.duration) return;
    // Leave the native scrollbar usable.
    if (event.offsetY > this.options.height) return;
    const x = this.eventX(event);
    const time = this.timeAtX(x);
    let mode: 'new' | 'start' | 'end' | 'move' = 'new';
    if (this.options.selectable && this.selection) {
      const startX = this.xForTime(this.selection.start);
      const endX = this.xForTime(this.selection.end);
      if (Math.abs(x - startX) <= HANDLE_HIT) mode = 'start';
      else if (Math.abs(x - endX) <= HANDLE_HIT) mode = 'end';
      else if (x > startX && x < endX && event.shiftKey) mode = 'move';
    }
    this.drag = { id: event.pointerId, mode, anchor: time, x, original: this.selection ? { ...this.selection } : null };
    this.scroller.setPointerCapture(event.pointerId);
    this.scroller.focus({ preventScroll: true });
    event.preventDefault();
  }

  private pointerMove(event: PointerEvent): void {
    const x = this.eventX(event);
    if (!this.drag) {
      if (this.options.selectable && this.selection) {
        const near = Math.abs(x - this.xForTime(this.selection.start)) <= HANDLE_HIT ||
          Math.abs(x - this.xForTime(this.selection.end)) <= HANDLE_HIT;
        this.scroller.style.cursor = near ? 'ew-resize' : 'text';
      }
      return;
    }
    if (this.drag.id !== event.pointerId) return;
    const time = this.timeAtX(x);
    const width = this.scroller.clientWidth;
    // Auto-scroll while dragging near the edges.
    if (this.zoom > 1 && (x < 16 || x > width - 16)) this.scroller.scrollLeft += x < 16 ? -12 : 12;
    if (!this.options.selectable) return;
    const { mode, anchor, original } = this.drag;
    if (mode === 'new' && Math.abs(x - this.drag.x) > 3) this.setSelection({ start: anchor, end: time }, true);
    else if (mode === 'start' && original) this.setSelection({ start: Math.min(time, original.end - 0.01), end: original.end }, true);
    else if (mode === 'end' && original) this.setSelection({ start: original.start, end: Math.max(time, original.start + 0.01) }, true);
    else if (mode === 'move' && original) {
      const length = original.end - original.start;
      const start = Math.max(0, Math.min(this.duration - length, original.start + time - anchor));
      this.setSelection({ start, end: start + length }, true);
    }
  }

  private pointerUp(event: PointerEvent): void {
    if (!this.drag || this.drag.id !== event.pointerId) return;
    const moved = Math.abs(this.eventX(event) - this.drag.x) > 3;
    if (!moved && (this.drag.mode === 'new' || this.drag.mode === 'move')) this.options.onSeek?.(this.drag.anchor);
    this.drag = null;
  }

  private wheel(event: WheelEvent): void {
    if (!this.duration) return;
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      const anchor = this.timeAtX(this.eventX(event));
      this.setZoom(this.zoom * (event.deltaY < 0 ? 1.25 : 0.8), anchor);
      return;
    }
    if (this.zoom > 1 && Math.abs(event.deltaY) > Math.abs(event.deltaX) && event.shiftKey) {
      event.preventDefault();
      this.scroller.scrollLeft += event.deltaY;
    }
  }

  private draw(): void {
    const width = this.scroller.clientWidth;
    const { height, ruler, selectable, color } = this.options;
    if (!width) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const pixelWidth = Math.round(width * dpr);
    const pixelHeight = Math.round(height * dpr);
    // Assigning canvas.width/height reallocates the backing store and resets
    // the context. Playhead ticks call draw() at frame rate, so only resize
    // when the element's size actually changed.
    if (this.canvas.width !== pixelWidth) this.canvas.width = pixelWidth;
    if (this.canvas.height !== pixelHeight) this.canvas.height = pixelHeight;
    const cssWidth = `${width}px`;
    if (this.canvas.style.width !== cssWidth) this.canvas.style.width = cssWidth;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    if (!this.duration || !this.peaks.length) return;

    const top = ruler ? 18 : 0;
    const body = height - top;
    const mid = top + body / 2;
    const pps = this.pxPerSecond();
    const left = this.scroller.scrollLeft / pps;
    const selection = selectable ? this.selection : null;
    const selStart = selection ? this.xForTime(selection.start) : 0;
    const selEnd = selection ? this.xForTime(selection.end) : 0;

    if (selection) {
      ctx.fillStyle = 'rgba(129, 140, 248, 0.16)';
      ctx.fillRect(selStart, top, selEnd - selStart, body);
    }

    // Centre line.
    ctx.fillStyle = 'rgba(148, 163, 184, 0.18)';
    ctx.fillRect(0, mid, width, 1);

    const bar = this.zoom > 6 ? 1 : 2;
    const gap = this.zoom > 6 ? 0 : 1;
    const perBucket = this.peaks.length / this.duration;
    for (let x = 0; x < width; x += bar + gap) {
      const t0 = left + x / pps;
      const t1 = left + (x + bar + gap) / pps;
      if (t0 >= this.duration) break;
      const first = Math.floor(t0 * perBucket);
      const last = Math.max(first + 1, Math.ceil(t1 * perBucket));
      let peak = 0;
      for (let i = first; i < last && i < this.peaks.length; i += 1) peak = Math.max(peak, this.peaks[i]);
      const h = Math.max(1, Math.min(1, peak) * (body - 6));
      const inside = !selection || (x + bar > selStart && x < selEnd);
      ctx.fillStyle = inside ? color : 'rgba(100, 116, 139, 0.55)';
      ctx.fillRect(x, mid - h / 2, bar, h);
    }

    if (ruler) {
      ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
      ctx.fillRect(0, 0, width, top);
      const step = tickStep(pps);
      ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textBaseline = 'middle';
      const first = Math.floor(left / step) * step;
      for (let t = first; t <= left + width / pps + step; t += step) {
        const x = Math.round(this.xForTime(t)) + 0.5;
        if (x < -40 || x > width + 40) continue;
        ctx.fillStyle = 'rgba(148, 163, 184, 0.45)';
        ctx.fillRect(x, top - 6, 1, 6);
        ctx.fillStyle = 'rgba(203, 213, 225, 0.75)';
        ctx.fillText(formatClock(t, step < 1), x + 3, top / 2);
      }
    }

    if (selection) {
      for (const x of [selStart, selEnd]) {
        if (x < -10 || x > width + 10) continue;
        ctx.fillStyle = '#a5b4fc';
        ctx.fillRect(x - 1, top, 2, body);
        ctx.beginPath();
        ctx.roundRect(x - 5, top + body / 2 - 14, 10, 28, 4);
        ctx.fill();
        ctx.fillStyle = '#312e81';
        ctx.fillRect(x - 1.5, top + body / 2 - 6, 1, 12);
        ctx.fillRect(x + 0.5, top + body / 2 - 6, 1, 12);
      }
    }

    if (this.labels.length) {
      ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
      ctx.textBaseline = 'alphabetic';
      let lastEnd = -Infinity;
      for (const label of this.labels) {
        const x = this.xForTime(label.time);
        if (x < -80 || x > width) continue;
        const textWidth = ctx.measureText(label.text).width;
        if (x < lastEnd + 4) continue;
        ctx.fillStyle = 'rgba(2, 6, 23, 0.7)';
        ctx.fillRect(x - 1, height - 15, textWidth + 6, 14);
        ctx.fillStyle = '#e2e8f0';
        ctx.fillText(label.text, x + 2, height - 4);
        lastEnd = x + textWidth + 6;
      }
    }

    this.markers.forEach((marker, index) => {
      const x = this.xForTime(marker);
      if (x < -10 || x > width + 10) return;
      ctx.fillStyle = 'rgba(251, 191, 36, 0.85)';
      ctx.fillRect(x - 0.5, 0, 1, height);
      ctx.beginPath();
      ctx.roundRect(x - 7, top + 2, 14, 13, 3);
      ctx.fill();
      ctx.fillStyle = '#1c1917';
      ctx.font = 'bold 9px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(index + 1), x, top + 9);
      ctx.textAlign = 'start';
    });

    const playX = this.xForTime(this.playhead);
    if (playX >= -2 && playX <= width + 2) {
      ctx.fillStyle = '#f8fafc';
      ctx.fillRect(playX - 0.75, 0, 1.5, height);
      ctx.beginPath();
      ctx.moveTo(playX - 5, 0);
      ctx.lineTo(playX + 5, 0);
      ctx.lineTo(playX, 7);
      ctx.fill();
    }
  }
}
