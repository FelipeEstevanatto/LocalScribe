// Streaming transcript UI cost, reproduced outside the app.
//
// src/main.ts rewrites the whole transcript textarea and rebuilds the whole
// segment list (innerHTML of every row) after each finished chunk, then walks
// every row to highlight the active one. This page module replays that work
// for N segments and compares it with an incremental version that appends one
// row and updates the textarea once per chunk. The visible result (textarea
// value and row markup) is checked for equality.
//
// Browser (Vite dev server): const m = await import('/bench/transcript-ui-page.ts'); await m.run([500, 1000, 2000])

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
}

function formatDuration(seconds: number): string {
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

interface Segment { start: number; end: number; text: string; partial?: boolean }

function rowHtml(segment: Segment, index: number): string {
  return `
        <button
          type="button"
          data-segment-index="${index}"
          class="segment-row flex w-full items-start gap-2 rounded-lg border border-transparent px-2 py-1.5 text-left transition hover:border-white/10 hover:bg-white/5"
        >
          <span class="mt-0.5 shrink-0 font-mono text-[9px] text-slate-400">${formatDuration(segment.start)}</span>
          <span data-segment-text class="min-w-0 flex-1 text-[11px] leading-relaxed ${segment.text ? 'text-slate-300' : 'text-slate-400'}">${escapeHtml(segment.text || (segment.partial ? 'Listening…' : 'No speech'))}</span>
        </button>
      `;
}

function makeSegments(count: number): Segment[] {
  return Array.from({ length: count }, (_, index) => ({
    start: index * 3.5,
    end: index * 3.5 + 3.4,
    text: `And so my fellow Americans, ask not what your country can do for you, segment ${index}.`,
  }));
}

function highlight(list: HTMLElement, segments: Segment[], time: number): void {
  list.querySelectorAll<HTMLElement>('[data-segment-index]').forEach((row) => {
    const segment = segments[Number(row.dataset.segmentIndex)];
    row.classList.toggle('segment-active', Boolean(segment && time >= segment.start && time < segment.end + 0.05));
  });
}

/** Current app behaviour: full rebuild after every chunk. */
function replayFull(textarea: HTMLTextAreaElement, list: HTMLElement, all: Segment[]): number[] {
  const perChunk: number[] = [];
  const segments: Segment[] = all.map((segment) => ({ ...segment, text: '' }));
  for (let index = 0; index < all.length; index += 1) {
    const start = performance.now();
    segments[index].text = all[index].text;
    textarea.value = segments.map((entry) => entry.text).filter(Boolean).join(' ');
    list.innerHTML = segments.map(rowHtml).join('');
    highlight(list, segments, 0);
    void list.offsetHeight; // include style and layout, as the browser would before paint
    perChunk.push(performance.now() - start);
  }
  return perChunk;
}

/** Prototype: rows exist once, the finished row is patched, text is appended. */
function replayIncremental(textarea: HTMLTextAreaElement, list: HTMLElement, all: Segment[]): number[] {
  const perChunk: number[] = [];
  const segments: Segment[] = all.map((segment) => ({ ...segment, text: '' }));
  list.innerHTML = segments.map(rowHtml).join('');
  const rows = Array.from(list.querySelectorAll<HTMLElement>('[data-segment-index]'));
  let text = '';
  let active: HTMLElement | null = null;
  for (let index = 0; index < all.length; index += 1) {
    const start = performance.now();
    segments[index].text = all[index].text;
    text = text ? `${text} ${segments[index].text}` : segments[index].text;
    textarea.value = text;
    const label = rows[index].querySelector<HTMLElement>('[data-segment-text]')!;
    label.textContent = segments[index].text;
    label.classList.toggle('text-slate-300', true);
    label.classList.toggle('text-slate-400', false);
    const next = rows.find((_, i) => 0 >= segments[i].start && 0 < segments[i].end + 0.05) ?? null;
    if (next !== active) {
      active?.classList.remove('segment-active');
      next?.classList.add('segment-active');
      active = next;
    }
    void list.offsetHeight;
    perChunk.push(performance.now() - start);
  }
  return perChunk;
}

function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    totalMs: +values.reduce((sum, value) => sum + value, 0).toFixed(1),
    lastMs: +values[values.length - 1].toFixed(2),
    p50: +sorted[Math.floor(sorted.length / 2)].toFixed(2),
    max: +sorted[sorted.length - 1].toFixed(2),
    over50ms: values.filter((value) => value > 50).length,
  };
}

export async function run(counts = [100, 500, 1000, 2000]) {
  const results: Record<string, unknown>[] = [];
  for (const count of counts) {
    const all = makeSegments(count);
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:-10000px;top:0;width:400px;height:600px;overflow:auto';
    const textarea = document.createElement('textarea');
    const list = document.createElement('div');
    host.append(textarea, list);
    document.body.append(host);
    const full = replayFull(textarea, list, all);
    const fullValue = textarea.value;
    const fullRows = list.innerHTML.replace(/\s+/g, ' ');
    const incremental = replayIncremental(textarea, list, all);
    const equal = fullValue === textarea.value && fullRows === list.innerHTML.replace(/\s+/g, ' ');
    host.remove();
    results.push({ segments: count, full: stats(full), incremental: stats(incremental), sameOutput: equal });
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return { benchmark: 'transcript-ui', userAgent: navigator.userAgent, results };
}
