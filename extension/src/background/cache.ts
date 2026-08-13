/**
 * IndexedDB cache for routing results.
 *
 * Keyed on origin rounded to 5 decimals (~1.1 m): precise enough to tell two properties
 * apart, coarse enough that re-clicking the same pin always hits. The arrival bucket is
 * a resolved Dublin-local instant, so a whole session shares one key.
 */
import type { Itinerary } from '../shared/types';

const DB_NAME = 'dpt-cache';
const STORE = 'plans';
const VERSION = 1;

const TTL_OK_MS = 7 * 24 * 3600 * 1000;
const TTL_EMPTY_MS = 60 * 60 * 1000;
const MAX_ENTRIES = 5000;

interface Entry {
  key: string;
  itineraries: Itinerary[];
  fetchedAt: number;
  lastUsed: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'key' });
        store.createIndex('lastUsed', 'lastUsed');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(STORE, mode);
        const request = run(transaction.objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      })
  );
}

export function planKey(
  origin: [number, number],
  destId: string,
  optionsHash: string,
  arrivalBucket: string
): string {
  const lng = origin[0].toFixed(5);
  const lat = origin[1].toFixed(5);
  return `plan:${lat},${lng}|${destId}|${optionsHash}|${arrivalBucket}`;
}

export async function readPlan(key: string): Promise<Itinerary[] | null> {
  let entry: Entry | undefined;
  try {
    entry = await tx<Entry | undefined>('readonly', (s) => s.get(key) as IDBRequest<Entry | undefined>);
  } catch {
    return null; // a broken cache must never break routing
  }
  if (!entry) return null;

  const ttl = entry.itineraries.length ? TTL_OK_MS : TTL_EMPTY_MS;
  if (Date.now() - entry.fetchedAt > ttl) return null;

  entry.lastUsed = Date.now();
  void tx('readwrite', (s) => s.put(entry as Entry)).catch(() => undefined);
  return entry.itineraries;
}

export async function writePlan(key: string, itineraries: Itinerary[]): Promise<void> {
  const entry: Entry = { key, itineraries, fetchedAt: Date.now(), lastUsed: Date.now() };
  try {
    await tx('readwrite', (s) => s.put(entry));
    await evictIfNeeded();
  } catch {
    /* cache failures are never fatal */
  }
}

async function evictIfNeeded(): Promise<void> {
  const count = await tx<number>('readonly', (s) => s.count());
  if (count <= MAX_ENTRIES) return;

  const excess = count - MAX_ENTRIES;
  const db = await openDb();
  await new Promise<void>((resolve) => {
    const store = db.transaction(STORE, 'readwrite').objectStore(STORE);
    const cursorRequest = store.index('lastUsed').openCursor();
    let removed = 0;
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor || removed >= excess) return resolve();
      cursor.delete();
      removed++;
      cursor.continue();
    };
    cursorRequest.onerror = () => resolve();
  });
}

export async function clearCache(): Promise<void> {
  try {
    await tx('readwrite', (s) => s.clear());
  } catch {
    /* ignore */
  }
}
