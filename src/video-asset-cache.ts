/**
 * Persistent derived-media cache for the video editor.
 *
 * Filmstrips, posters, waveform peaks, and preview proxies are expensive to
 * regenerate but safe to keep across projects. They are stored separately
 * from project payloads and keyed by the source file's media key.
 */

const DATABASE = 'localscribe.video-assets';
const STORE = 'assets';
const VERSION = 1;

interface CacheRecord<T = unknown> {
  key: string;
  value: T;
  updatedAt: number;
}

let database: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  if (database) return database;
  database = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('Asset caching is unavailable.'));
      return;
    }
    const request = indexedDB.open(DATABASE, VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open the asset cache.'));
    request.onblocked = () => reject(new Error('Close other LocalScribe tabs, then try again.'));
  });
  database.catch(() => {
    database = null;
  });
  return database;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Asset cache request failed.'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('Asset cache write failed.'));
    transaction.onabort = () => reject(transaction.error ?? new Error('Asset cache write was cancelled.'));
  });
}

/** Read a cached value. Cache misses and storage failures both return null. */
export async function readCachedAsset<T>(key: string): Promise<T | null> {
  try {
    const db = await openDatabase();
    const transaction = db.transaction(STORE, 'readonly');
    const record = await requestResult(
      transaction.objectStore(STORE).get(key) as IDBRequest<CacheRecord<T> | undefined>,
    );
    return record?.value ?? null;
  } catch {
    return null;
  }
}

/** Write a cached value. Storage failures are non-fatal. */
export async function writeCachedAsset<T>(key: string, value: T): Promise<void> {
  try {
    const db = await openDatabase();
    const transaction = db.transaction(STORE, 'readwrite');
    const record: CacheRecord<T> = { key, value, updatedAt: Date.now() };
    transaction.objectStore(STORE).put(record);
    await transactionDone(transaction);
  } catch {
    // Quota, private mode, and blocked upgrades must never break editing.
  }
}

export async function deleteCachedAsset(key: string): Promise<void> {
  try {
    const db = await openDatabase();
    const transaction = db.transaction(STORE, 'readwrite');
    transaction.objectStore(STORE).delete(key);
    await transactionDone(transaction);
  } catch {
    // Optional cache.
  }
}

/** Keep the cache bounded. Oldest entries are dropped first. */
export async function pruneCachedAssets(maxBytes = 512 * 1024 * 1024): Promise<void> {
  try {
    const db = await openDatabase();
    const transaction = db.transaction(STORE, 'readwrite');
    const store = transaction.objectStore(STORE);
    const records = await requestResult(store.getAll() as IDBRequest<CacheRecord[]>);
    const sizeOf = (value: unknown): number => {
      if (value instanceof Blob) return value.size;
      if (ArrayBuffer.isView(value)) return value.byteLength;
      if (value instanceof ArrayBuffer) return value.byteLength;
      if (value && typeof value === 'object') {
        return Object.values(value as Record<string, unknown>).reduce<number>((sum, item) => sum + sizeOf(item), 0);
      }
      return 0;
    };
    let total = records.reduce((sum, record) => sum + sizeOf(record.value), 0);
    if (total <= maxBytes) return;
    records.sort((a, b) => a.updatedAt - b.updatedAt);
    for (const record of records) {
      if (total <= maxBytes) break;
      total -= sizeOf(record.value);
      store.delete(record.key);
    }
    await transactionDone(transaction);
  } catch {
    // Optional maintenance.
  }
}
