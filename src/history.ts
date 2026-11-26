/**
 * Optional, local-only transcript history.
 *
 * The flag lives in localStorage so the UI can show the choice immediately,
 * but every transcript is stored in IndexedDB. Audio is never stored. Turning
 * history off deletes the existing database, so the promise in the UI is
 * literal: off means nothing is kept.
 */

import type { ExportSegment } from './exports';

const DB_NAME = 'localscribe-history';
const DB_VERSION = 2;
const STORE = 'entries';
const ENABLED_KEY = 'localscribe:history-enabled';
const MAX_ENTRIES = 50;

export interface HistoryEntry {
  id: string;
  createdAt: number;
  modelId: string;
  modelName: string;
  variantId: string;
  fileName: string | null;
  duration: number;
  backend: string;
  text: string;
  segments: ExportSegment[];
}

let dbPromise: Promise<IDBDatabase> | null = null;

export function isHistoryEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) === '1';
  } catch {
    return false;
  }
}

export function setHistoryEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(ENABLED_KEY, enabled ? '1' : '0');
  } catch {
    // Storage can be disabled; the UI will still reflect the in-memory choice.
  }
}

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB is not available in this browser.'));
        return;
      }

      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('createdAt', 'createdAt');
          return;
        }

        const store = request.transaction?.objectStore(STORE);
        if (store && !store.indexNames.contains('createdAt')) {
          store.createIndex('createdAt', 'createdAt');
        }
      };

      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => db.close();
        resolve(db);
      };

      request.onerror = () => reject(request.error ?? new Error('Could not open history storage.'));
      request.onblocked = () => reject(new Error('History storage is blocked by another tab.'));
    });
  }

  return dbPromise;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('History storage failed.'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('History storage failed.'));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('History storage was aborted.'));
  });
}

export async function listHistory(limit = MAX_ENTRIES): Promise<HistoryEntry[]> {
  const db = await openDb();
  const transaction = db.transaction(STORE, 'readonly');
  const done = transactionDone(transaction);
  const index = transaction.objectStore(STORE).index('createdAt');
  const request = index.openCursor(null, 'prev');
  const entries: HistoryEntry[] = [];

  await new Promise<void>((resolve, reject) => {
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || entries.length >= limit) {
        resolve();
        return;
      }
      entries.push(cursor.value as HistoryEntry);
      cursor.continue();
    };
    request.onerror = () => reject(request.error ?? new Error('Could not read history.'));
  });

  await done;
  return entries;
}

export async function getHistory(id: string): Promise<HistoryEntry | null> {
  const db = await openDb();
  const transaction = db.transaction(STORE, 'readonly');
  const done = transactionDone(transaction);
  const result = await requestToPromise(
    transaction.objectStore(STORE).get(id) as IDBRequest<HistoryEntry | undefined>,
  );
  await done;
  return result ?? null;
}

export async function saveHistory(entry: HistoryEntry): Promise<void> {
  const db = await openDb();

  const write = db.transaction(STORE, 'readwrite');
  write.objectStore(STORE).put(entry);
  await transactionDone(write);

  // Keep the list bounded. The index is ordered oldest first.
  const read = db.transaction(STORE, 'readonly');
  const keys = await requestToPromise(
    read.objectStore(STORE).index('createdAt').getAllKeys(),
  );
  await transactionDone(read);

  if (keys.length > MAX_ENTRIES) {
    const cleanup = db.transaction(STORE, 'readwrite');
    const cleanupStore = cleanup.objectStore(STORE);
    for (const key of keys.slice(0, keys.length - MAX_ENTRIES)) cleanupStore.delete(key);
    await transactionDone(cleanup);
  }
}

export async function deleteHistory(id: string): Promise<void> {
  const db = await openDb();
  const transaction = db.transaction(STORE, 'readwrite');
  transaction.objectStore(STORE).delete(id);
  await transactionDone(transaction);
}

export async function clearHistory(): Promise<void> {
  const db = await openDb();
  const transaction = db.transaction(STORE, 'readwrite');
  transaction.objectStore(STORE).clear();
  await transactionDone(transaction);
}

export async function deleteHistoryDatabase(): Promise<void> {
  if (dbPromise) {
    try {
      const db = await dbPromise;
      db.close();
    } catch {
      // Ignore a failed open.
    }
    dbPromise = null;
  }

  await new Promise<void>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      resolve();
      return;
    }
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error('Could not delete history.'));
    request.onblocked = () => resolve();
  });
}

export function newHistoryId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `h-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
