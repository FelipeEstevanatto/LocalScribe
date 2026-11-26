/**
 * Local project storage for the video editor.
 *
 * Project summaries live in one IndexedDB store so the Projects menu never
 * has to read media blobs. The editor state and its files live in a second
 * store keyed by the same id. Nothing leaves the browser.
 */

export interface VideoProjectSummary {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  width: number;
  height: number;
  fps: number;
  duration: number;
  /** Approximate bytes stored in IndexedDB, including media and filmstrips. */
  bytes: number;
}

export interface VideoProject extends VideoProjectSummary {
  version: 1;
  data: unknown;
}

const DATABASE = 'localscribe.video-projects';
const VERSION = 1;
const SUMMARIES = 'projects';
const PAYLOADS = 'payloads';
let database: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  if (database) return database;
  database = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('This browser cannot store projects locally.'));
      return;
    }
    const request = indexedDB.open(DATABASE, VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SUMMARIES)) db.createObjectStore(SUMMARIES, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(PAYLOADS)) db.createObjectStore(PAYLOADS, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open local project storage.'));
    request.onblocked = () => reject(new Error('Close other LocalScribe tabs, then try again.'));
  });
  database.catch(() => {
    database = null;
  });
  return database;
}

function finished(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('Local project storage failed.'));
    transaction.onabort = () => reject(transaction.error ?? new Error('Saving the project was cancelled.'));
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Local project storage failed.'));
  });
}

export async function listVideoProjects(): Promise<VideoProjectSummary[]> {
  const db = await openDatabase();
  const transaction = db.transaction(SUMMARIES, 'readonly');
  const rows = await requestResult(transaction.objectStore(SUMMARIES).getAll() as IDBRequest<VideoProjectSummary[]>);
  return rows
    .map((row) => ({ ...row, bytes: Number(row.bytes) || 0 }))
    .sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name));
}

export async function saveVideoProject(project: VideoProject): Promise<void> {
  const db = await openDatabase();
  const transaction = db.transaction([SUMMARIES, PAYLOADS], 'readwrite');
  const { data, ...summary } = project;
  transaction.objectStore(SUMMARIES).put(summary);
  transaction.objectStore(PAYLOADS).put({ id: project.id, data });
  await finished(transaction);
}

export async function loadVideoProject(id: string): Promise<VideoProject | null> {
  const db = await openDatabase();
  const transaction = db.transaction([SUMMARIES, PAYLOADS], 'readonly');
  const [summary, payload] = await Promise.all([
    requestResult(transaction.objectStore(SUMMARIES).get(id) as IDBRequest<VideoProjectSummary | undefined>),
    requestResult(transaction.objectStore(PAYLOADS).get(id) as IDBRequest<{ id: string; data: unknown } | undefined>),
  ]);
  if (!summary || !payload) return null;
  return { ...summary, version: 1, data: payload.data };
}

export async function deleteVideoProject(id: string): Promise<void> {
  const db = await openDatabase();
  const transaction = db.transaction([SUMMARIES, PAYLOADS], 'readwrite');
  transaction.objectStore(SUMMARIES).delete(id);
  transaction.objectStore(PAYLOADS).delete(id);
  await finished(transaction);
}
