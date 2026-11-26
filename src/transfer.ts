/**
 * Shared progress helpers: download throughput (MB/s), time remaining, and
 * streamed fetches that report bytes as they arrive.
 */

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function formatEta(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return 'estimating…';
  if (seconds <= 0.5) return 'finishing…';
  if (seconds < 60) return `~${Math.max(1, Math.ceil(seconds))}s left`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  if (minutes < 60) return `~${minutes}m ${String(rest).padStart(2, '0')}s left`;
  return `~${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m left`;
}

/**
 * Smoothed byte-rate meter. Feed it cumulative byte counts; it reports a
 * stable MB/s figure and the time left for the remaining bytes.
 */
export class TransferMeter {
  private started = false;
  private startedAt = 0;
  private lastAt = 0;
  private lastBytes = 0;
  private rate: number | null = null;

  update(loaded: number, total: number, now = performance.now()): { percent: number; bytesPerSecond: number | null; etaSeconds: number | null } {
    if (!this.started || loaded < this.lastBytes) {
      this.started = true;
      this.startedAt = now;
      this.lastAt = now;
      this.lastBytes = loaded;
      this.rate = null;
    }
    const elapsed = (now - this.lastAt) / 1000;
    // The first second is mostly connection setup; do not guess from it.
    if (elapsed >= 0.25 && now - this.startedAt >= 1000) {
      const instant = (loaded - this.lastBytes) / elapsed;
      this.rate = this.rate === null ? instant : this.rate * 0.7 + instant * 0.3;
      this.lastAt = now;
      this.lastBytes = loaded;
    }
    const percent = total > 0 ? Math.min(100, (loaded / total) * 100) : 0;
    const etaSeconds = this.rate && this.rate > 0 && total > 0 ? Math.max(0, (total - loaded) / this.rate) : null;
    return { percent, bytesPerSecond: this.rate, etaSeconds };
  }

  /** "12.3 MB / 166 MB · 8.4 MB/s · ~15s left" */
  describe(loaded: number, total: number): string {
    const { bytesPerSecond, etaSeconds } = this.update(loaded, total);
    const size = total > 0 ? `${formatBytes(loaded)} / ${formatBytes(total)}` : formatBytes(loaded);
    if (total > 0 && loaded >= total) return `${size} · done`;
    if (!bytesPerSecond) return `${size} · measuring speed…`;
    return `${size} · ${formatBytes(bytesPerSecond)}/s · ${formatEta(etaSeconds)}`;
  }

  reset(): void {
    this.started = false;
    this.lastBytes = 0;
    this.rate = null;
  }
}

/**
 * Time-based ETA for work measured as a 0–1 fraction (encoding, separation).
 * Uses the average pace since the start, which is steadier than an
 * instantaneous rate for CPU-bound jobs.
 */
export class WorkMeter {
  private startedAt = performance.now();
  private lastFraction = 0;

  update(fraction: number, now = performance.now()): { percent: number; etaSeconds: number | null } {
    const clamped = Math.max(0, Math.min(1, fraction));
    if (clamped < this.lastFraction) this.startedAt = now;
    this.lastFraction = clamped;
    const elapsed = (now - this.startedAt) / 1000;
    const etaSeconds = clamped > 0.01 && elapsed > 0.5 ? (elapsed / clamped) * (1 - clamped) : null;
    return { percent: clamped * 100, etaSeconds };
  }

  describe(fraction: number): string {
    const { percent, etaSeconds } = this.update(fraction);
    return `${Math.round(percent)}% · ${formatEta(etaSeconds)}`;
  }

  reset(): void {
    this.startedAt = performance.now();
    this.lastFraction = 0;
  }
}

/**
 * Fetch a URL into memory while reporting cumulative bytes. Falls back to a
 * single arrayBuffer() call when the body cannot be streamed.
 */
export async function fetchWithProgress(
  url: string,
  onProgress: (loaded: number, total: number) => void,
  options: { signal?: AbortSignal; expectedBytes?: number } = {},
): Promise<ArrayBuffer> {
  const response = await fetch(url, { signal: options.signal });
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}.`);
  const header = Number(response.headers.get('content-length')) || 0;
  const total = header || options.expectedBytes || 0;
  if (!response.body) {
    const bytes = await response.arrayBuffer();
    onProgress(bytes.byteLength, total || bytes.byteLength);
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  onProgress(0, total);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress(loaded, Math.max(total, loaded));
  }
  const out = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}
