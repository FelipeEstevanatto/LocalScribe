import { describe, expect, test } from 'bun:test';
import { PreviewRenderCache, type CacheFrame } from '../src/video-render-cache';

class Frame implements CacheFrame {
  closed = false;
  constructor(readonly width: number, readonly height: number) {}
  close(): void {
    this.closed = true;
  }
}

const frame = (width = 10, height = 10): Frame => new Frame(width, height);

describe('PreviewRenderCache', () => {
  test('stores, retrieves, and promotes entries in LRU order', () => {
    const cache = new PreviewRenderCache<Frame>(1000, 2);
    const first = frame();
    const second = frame();
    expect(cache.set('a', first, 100)).toBe(true);
    expect(cache.set('b', second, 100)).toBe(true);
    expect(cache.get('a')).toBe(first);
    const third = frame();
    cache.set('c', third, 100);
    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(false);
    expect(second.closed).toBe(true);
    expect(cache.stats()).toMatchObject({ entries: 2, bytes: 200, hits: 1, misses: 0, evictions: 1 });
  });

  test('evicts oldest entries when the byte budget is exceeded', () => {
    const cache = new PreviewRenderCache<Frame>(300, 10);
    const first = frame();
    const second = frame();
    const third = frame();
    cache.set('a', first, 100);
    cache.set('b', second, 100);
    cache.set('c', third, 100);
    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(true);
    expect(cache.has('c')).toBe(true);
    cache.set('d', frame(), 100);
    expect(cache.has('a')).toBe(false);
    expect(cache.has('b')).toBe(true);
    expect(first.closed).toBe(true);
  });

  test('rejects a single frame larger than the cache', () => {
    const cache = new PreviewRenderCache<Frame>(100, 4);
    const oversized = frame();
    expect(cache.set('big', oversized, 101)).toBe(false);
    expect(oversized.closed).toBe(true);
    expect(cache.size).toBe(0);
  });

  test('replaces and closes an existing key', () => {
    const cache = new PreviewRenderCache<Frame>(1000, 4);
    const first = frame();
    const replacement = frame();
    cache.set('a', first, 10);
    cache.set('a', replacement, 20);
    expect(first.closed).toBe(true);
    expect(cache.get('a')).toBe(replacement);
    expect(cache.stats().bytes).toBe(20);
  });

  test('invalidates matching keys and clears everything', () => {
    const cache = new PreviewRenderCache<Frame>(1000, 8);
    const frames = ['clip-1:frame-a', 'clip-1:frame-b', 'clip-2:frame-a'].map((key) => {
      const value = frame();
      cache.set(key, value, 10);
      return value;
    });
    expect(cache.invalidate((key) => key.startsWith('clip-1:'))).toBe(2);
    expect(cache.has('clip-1:frame-a')).toBe(false);
    expect(cache.has('clip-2:frame-a')).toBe(true);
    expect(frames[0].closed).toBe(true);
    expect(frames[1].closed).toBe(true);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(frames[2].closed).toBe(true);
  });

  test('records misses without changing the cache', () => {
    const cache = new PreviewRenderCache<Frame>(1000, 4);
    expect(cache.get('missing')).toBeNull();
    expect(cache.stats().misses).toBe(1);
    expect(cache.size).toBe(0);
  });
});
