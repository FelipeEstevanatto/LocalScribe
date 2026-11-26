/**
 * checksumsFor() in a worker: a 100 MB file blocked the page for about 0.9 s
 * (MD5, CRC32 and Adler32 are plain loops). The Blob is passed by reference,
 * so the bytes are read in the worker. Falls back to the page without workers.
 */
import { checksumsFor, type FileChecksums } from './file-metadata';

let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<number, { resolve: (value: FileChecksums | null) => void; reject: (error: Error) => void }>();

function checksumWorker(): Worker {
  if (worker) return worker;
  const created = new Worker(new URL('./checksum-worker.ts', import.meta.url), { type: 'module', name: 'checksums' });
  created.onmessage = (event: MessageEvent<{ id: number; checksums?: FileChecksums | null; error?: string }>) => {
    const request = pending.get(event.data.id);
    if (!request) return;
    pending.delete(event.data.id);
    if (event.data.error !== undefined) request.reject(new Error(event.data.error));
    else request.resolve(event.data.checksums ?? null);
  };
  created.onerror = (event) => {
    event.preventDefault();
    created.terminate();
    if (worker === created) worker = null;
    const error = new Error(event.message || 'The checksum worker failed.');
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  worker = created;
  return created;
}

export async function checksumsOffThread(file: Blob): Promise<FileChecksums | null> {
  if (typeof Worker === 'undefined') return checksumsFor(file);
  const target = checksumWorker();
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    target.postMessage({ id, file });
  });
}
