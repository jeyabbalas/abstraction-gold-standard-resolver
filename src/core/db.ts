/**
 * IndexedDB persistence. Three stores:
 *  - sessions: one document per session (setup choices, settings, labels, progress);
 *  - files: the folder's files a session uses (so it can be resumed without the folder);
 *  - cells: one row per touched cell (decision, note, flag), written as soon as it changes.
 * Everything stays in this browser's storage; nothing leaves the computer.
 */

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { SessionMeta, SessionStats, SessionStore } from './session';
import type { CellState, RecordKey, Settings, TextFile } from './types';

export interface StoredSource {
  id: string;
  path: string;
  fileName: string;
  label: string;
  hash: string;
}

export interface StoredSession {
  id: string;
  version: 1;
  name: string;
  folderName: string;
  createdAt: number;
  updatedAt: number;
  openedAt: number;
  seed: number;
  schemaPath: string;
  keyField: string;
  sources: StoredSource[];
  settings: Settings;
  meta: SessionMeta;
  stats: SessionStats;
  /** The folder's files are kept in the files store. */
  filesStored: boolean;
  /** Paths of the files the session uses (for choosing the folder again). */
  paths: string[];
}

type StoredCell = CellState & { sessionId: string };

interface Schema extends DBSchema {
  sessions: { key: string; value: StoredSession };
  files: { key: string; value: { sessionId: string; files: TextFile[] } };
  cells: { key: [string, RecordKey, string]; value: StoredCell; indexes: { session: string } };
}

const DB_NAME = 'gold-standard-resolver';
let dbPromise: Promise<IDBPDatabase<Schema>> | null = null;

export class StorageUnavailableError extends Error {}

export function db(): Promise<IDBPDatabase<Schema>> {
  if (!dbPromise) {
    if (typeof indexedDB === 'undefined') return Promise.reject(new StorageUnavailableError('This browser does not offer IndexedDB storage.'));
    dbPromise = openDB<Schema>(DB_NAME, 1, {
      upgrade(database) {
        database.createObjectStore('sessions', { keyPath: 'id' });
        database.createObjectStore('files', { keyPath: 'sessionId' });
        const cells = database.createObjectStore('cells', { keyPath: ['sessionId', 'record', 'field'] });
        cells.createIndex('session', 'sessionId');
      },
      blocked() {
        console.warn('IndexedDB upgrade blocked by another tab.');
      },
    }).catch((err: Error) => {
      dbPromise = null;
      throw new StorageUnavailableError(`Browser storage is unavailable (${err.message}).`);
    });
  }
  return dbPromise;
}

/** For tests: forget the open connection. */
export function resetDbConnection(): void {
  dbPromise = null;
}

export async function listSessions(): Promise<StoredSession[]> {
  const all = await (await db()).getAll('sessions');
  return all.sort((a, b) => b.openedAt - a.openedAt);
}

export async function getSession(id: string): Promise<StoredSession | undefined> {
  return (await db()).get('sessions', id);
}

export async function putSession(session: StoredSession): Promise<void> {
  await (await db()).put('sessions', session);
}

export async function putFiles(sessionId: string, files: TextFile[]): Promise<void> {
  await (await db()).put('files', { sessionId, files });
}

export async function getFiles(sessionId: string): Promise<TextFile[] | null> {
  return (await (await db()).get('files', sessionId))?.files ?? null;
}

/** Drop the stored copy of the folder (decisions are kept). */
export async function forgetFiles(sessionId: string): Promise<void> {
  const d = await db();
  const tx = d.transaction(['files', 'sessions'], 'readwrite');
  await tx.objectStore('files').delete(sessionId);
  const s = await tx.objectStore('sessions').get(sessionId);
  if (s) await tx.objectStore('sessions').put({ ...s, filesStored: false });
  await tx.done;
}

export async function getCells(sessionId: string): Promise<CellState[]> {
  const rows = await (await db()).getAllFromIndex('cells', 'session', sessionId);
  return rows.map(({ sessionId: _s, ...cell }) => cell);
}

export async function putCells(sessionId: string, cells: CellState[]): Promise<void> {
  const d = await db();
  const tx = d.transaction('cells', 'readwrite');
  await Promise.all([...cells.map((c) => tx.store.put({ ...c, sessionId })), tx.done]);
}

export async function deleteSession(sessionId: string): Promise<void> {
  const d = await db();
  const tx = d.transaction(['sessions', 'files', 'cells'], 'readwrite');
  await tx.objectStore('sessions').delete(sessionId);
  await tx.objectStore('files').delete(sessionId);
  const idx = tx.objectStore('cells').index('session');
  for (let cursor = await idx.openCursor(sessionId); cursor; cursor = await cursor.continue()) await cursor.delete();
  await tx.done;
}

/** The {@link SessionStore} that writes one session's changes to IndexedDB. */
export function sessionStore(sessionId: string): SessionStore {
  return {
    async putCell(cell) {
      await (await db()).put('cells', { ...cell, sessionId });
    },
    async deleteCell(record, field) {
      await (await db()).delete('cells', [sessionId, record, field]);
    },
    async putMeta(settings: Settings, meta: SessionMeta, stats: SessionStats) {
      const d = await db();
      const tx = d.transaction('sessions', 'readwrite');
      const s = await tx.store.get(sessionId);
      if (s) await tx.store.put({ ...s, settings, meta, stats, updatedAt: Date.now() });
      await tx.done;
    },
  };
}

/** Ask the browser not to evict this site's storage under pressure (best effort). */
export async function requestPersistence(): Promise<boolean> {
  try {
    if (await navigator.storage?.persisted?.()) return true;
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

/**
 * Roughly how much the saved sessions take (kept files, cells, session
 * records), in characters. The browser's own estimate covers the whole
 * origin, which on GitHub Pages is shared with the owner's other sites.
 */
export async function storedSize(): Promise<number> {
  const d = await db();
  let n = 0;
  const tx = d.transaction(['sessions', 'files', 'cells']);
  for (let c = await tx.objectStore('files').openCursor(); c; c = await c.continue()) {
    for (const f of c.value.files) n += f.path.length + f.text.length;
  }
  for (let c = await tx.objectStore('cells').openCursor(); c; c = await c.continue()) n += JSON.stringify(c.value).length;
  for (const s of await tx.objectStore('sessions').getAll()) n += JSON.stringify(s).length;
  await tx.done;
  return n;
}

// ------------------------------------------------------------------ backups

export const BACKUP_FORMAT = 'gold-standard-resolver/session';

export interface SessionBackup {
  format: typeof BACKUP_FORMAT;
  version: 1;
  exportedAt: string;
  session: StoredSession;
  cells: CellState[];
  files?: TextFile[];
}

export function isBackup(json: unknown): json is SessionBackup {
  const o = json as Partial<SessionBackup> | null;
  return !!o && o.format === BACKUP_FORMAT && o.version === 1 && !!o.session && Array.isArray(o.cells);
}
