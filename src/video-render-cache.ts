/**
 * Bounded LRU cache for composited preview frames.
 *
 * Keys are PreviewFramePlan signatures, so any edit that changes the plan
 * invalidates the affected frames without a separate bookkeeping pass.
 */

export interface CacheFrame {
  readonly width: number;
  readonly height: number;
  close?(): void;
}

export interface RenderCacheStats {
  entries: number;
  bytes: number;
  maxEntries: number;
  maxBytes: number;
  hits: number;
  misses: number;
  evictions: number;
}

interface Entry<T extends CacheFrame> {
  frame: T;
  bytes: number;
}

export class PreviewRenderCache<T extends CacheFrame = ImageBitmap> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly defaultMaxEntries: number;
  private readonly maxBytes: number;
  private totalBytes = 0;
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(maxBytes = 48 * 1024 * 1024, maxEntries = 24) {
    this.maxBytes = Math.max(1, Math.round(maxBytes));
    this.defaultMaxEntries = Math.max(1, Math.round(maxEntries));
  }

  get size(): number {
    return this.entries.size;
  }

  get bytes(): number {
    return this.totalBytes;
  }

  /** Look up a frame and mark it as most recently used. */
  get(key: string): T | null {
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses += 1;
      return null;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.hits += 1;
    return entry.frame;
  }

  peek(key: string): T | null {
    return this.entries.get(key)?.frame ?? null;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  /**
   * Store a frame. Oversized frames are rejected (and closed) rather than
   * evicting the whole cache for a single entry.
   */
  set(key: string, frame: T, bytes?: number): boolean {
    if (!key) return false;
    const size = Math.max(0, Math.round(
      bytes ?? frame.width * frame.height * 4,
    ));
    if (size > this.maxBytes) {
      frame.close?.();
      return false;
    }
    const previous = this.entries.get(key);
    if (previous) {
      this.totalBytes -= previous.bytes;
      this.entries.delete(key);
      previous.frame.close?.();
    }
    this.entries.set(key, { frame, bytes: size });
    this.totalBytes += size;
    this.prune();
    return this.entries.has(key);
  }

  delete(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.entries.delete(key);
    this.totalBytes -= entry.bytes;
    entry.frame.close?.();
    return true;
  }

  invalidate(predicate: (key: string) => boolean): number {
    let removed = 0;
    for (const key of [...this.entries.keys()]) {
      if (predicate(key) && this.delete(key)) removed += 1;
    }
    return removed;
  }

  clear(): void {
    for (const entry of this.entries.values()) entry.frame.close?.();
    this.entries.clear();
    this.totalBytes = 0;
  }

  stats(): RenderCacheStats {
    return {
      entries: this.entries.size,
      bytes: this.totalBytes,
      maxEntries: this.defaultMaxEntries,
      maxBytes: this.maxBytes,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
    };
  }

  private prune(): void {
    while (this.entries.size > this.defaultMaxEntries || this.totalBytes > this.maxBytes) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (oldestKey === undefined) return;
      const entry = this.entries.get(oldestKey);
      this.entries.delete(oldestKey);
      if (entry) {
        this.totalBytes -= entry.bytes;
        entry.frame.close?.();
        this.evictions += 1;
      }
    }
  }
}

/** Session cache shared by the preview compositor and its cache overlay. */
export const previewRenderCache = new PreviewRenderCache<ImageBitmap>();
