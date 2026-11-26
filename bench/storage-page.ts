// In-page benchmark for the Models and storage view and History.
//
// Served by the Vite dev server:
//   const bench = await import('/bench/storage-page.ts');
//   await bench.cacheScan({ repos: 12, filesPerRepo: 3, mb: 20, contentLength: false });
//   await bench.history(1000);
//
// cacheScan fills Cache Storage with synthetic model entries (shaped like the
// transformers.js cache: one cache, many repos) and times listOtherCachedModels
// with and without content-length headers, since the scan reads whole blobs
// when the header is missing. history() writes N saved transcripts straight
// into the app's IndexedDB store and times listHistory, saveHistory (which
// trims to the 50 newest) and opening the History view.
import { listOtherCachedModels } from '../src/model';
import { listHistory, saveHistory, newHistoryId, type HistoryEntry } from '../src/history';

const now = () => performance.now();

export async function cacheScan(options: { repos?: number; filesPerRepo?: number; mb?: number; contentLength?: boolean } = {}) {
  const repos = options.repos ?? 12;
  const files = options.filesPerRepo ?? 3;
  const size = Math.round((options.mb ?? 20) * 1048576);
  const cache = await caches.open('transformers-cache');
  const payload = new Uint8Array(size);
  const fill = now();
  for (let repo = 0; repo < repos; repo += 1) {
    for (let file = 0; file < files; file += 1) {
      const url = `https://huggingface.co/bench-org/bench-model-${repo}/resolve/main/onnx/model_${file}.onnx`;
      const headers: Record<string, string> = { 'content-type': 'application/octet-stream' };
      if (options.contentLength) headers['content-length'] = String(size);
      await cache.put(url, new Response(new Blob([payload]), { headers }));
    }
  }
  const fillMs = now() - fill;
  const timings: number[] = [];
  let rows = 0;
  for (let run = 0; run < 5; run += 1) {
    const start = now();
    rows = (await listOtherCachedModels()).length;
    timings.push(now() - start);
  }
  await caches.delete('transformers-cache');
  timings.sort((a, b) => a - b);
  return { repos, filesPerRepo: files, mbPerFile: options.mb ?? 20, contentLength: Boolean(options.contentLength), totalMB: repos * files * (options.mb ?? 20), fillMs: Math.round(fillMs), rows, scanMs: { min: +timings[0].toFixed(1), median: +timings[2].toFixed(1), max: +timings[4].toFixed(1) } };
}

function entry(index: number): HistoryEntry {
  const segments = Array.from({ length: 60 }, (_, i) => ({ start: i * 5, end: i * 5 + 5, text: `Segment ${i} of transcript ${index} with some words in it.` }));
  return {
    id: newHistoryId(), createdAt: 1700000000000 + index * 1000, modelId: 'moonshine-tiny', modelName: 'Moonshine Tiny', variantId: 'q8',
    fileName: `recording-${index}.wav`, duration: 300, backend: 'wasm', text: segments.map((s) => s.text).join(' '), segments: segments as unknown as HistoryEntry['segments'],
  };
}

export async function history(count = 1000) {
  // Let the app create the database, then write straight into its store (the app keeps at most 50 entries).
  await listHistory(1);
  const start = now();
  const write = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open('localscribe-history'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  const tx = write.transaction('entries', 'readwrite');
  for (let index = 0; index < count; index += 1) tx.objectStore('entries').put(entry(index));
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
  write.close();
  const seedMs = now() - start;
  const list: number[] = [];
  for (let run = 0; run < 5; run += 1) {
    const t = now();
    await listHistory();
    list.push(now() - t);
  }
  const t = now();
  await saveHistory(entry(count + 1));
  const saveTrimMs = now() - t;
  const t2 = now();
  await saveHistory(entry(count + 2));
  const saveSteadyMs = now() - t2;
  list.sort((a, b) => a - b);
  return { seeded: count, seedMs: Math.round(seedMs), listMs: { min: +list[0].toFixed(1), median: +list[2].toFixed(1), max: +list[4].toFixed(1) }, saveWithTrimMs: +saveTrimMs.toFixed(1), saveSteadyMs: +saveSteadyMs.toFixed(1), remaining: (await listHistory(5000)).length };
}
