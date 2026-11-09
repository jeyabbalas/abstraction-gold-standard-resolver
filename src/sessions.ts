/**
 * Session lifecycle: create a session from a folder and the setup choices,
 * reopen a saved one (from the files kept in the browser or a re-chosen
 * folder), and restore a backup file.
 */

import {
  getCells,
  getFiles,
  getSession,
  putCells,
  putFiles,
  putSession,
  requestPersistence,
  sessionStore,
  type SessionBackup,
  type StoredSession,
} from './core/db';
import type { Detection } from './core/detect';
import { buildProject, type ProjectConfig } from './core/project';
import { Session, type SessionMeta } from './core/session';
import type { Project, TextFile } from './core/types';
import { hashText, uid } from './core/util';

export interface Opened {
  session: Session;
  stored: StoredSession;
}

/** The files a session needs: every schema document, the chosen abstractions, the matched reports. */
export function usedFiles(files: readonly TextFile[], det: Detection, project: Project): TextFile[] {
  const keep = new Set<string>();
  for (const s of det.schemas) keep.add(s.path);
  for (const s of project.sources) keep.add(s.path);
  for (const r of project.reports.values()) keep.add(r.path);
  return files.filter((f) => keep.has(f.path));
}

export function newMeta(project: Project): SessionMeta {
  return {
    labels: Object.fromEntries(project.sources.map((s) => [s.id, s.label])),
    blindLog: [],
    terms: {},
    activeMs: 0,
  };
}

export async function createSession(opts: {
  folderName: string;
  files: TextFile[];
  detection: Detection;
  config: ProjectConfig;
  keepFiles: boolean;
}): Promise<Opened> {
  const project = await buildProject(opts.files, opts.config, opts.detection);
  const meta = newMeta(project);
  meta.blindLog.push({ at: Date.now(), blind: opts.config.settings.blind });
  const files = usedFiles(opts.files, opts.detection, project);
  const now = Date.now();
  const stored: StoredSession = {
    id: project.id,
    version: 1,
    name: project.name,
    folderName: opts.folderName,
    createdAt: now,
    updatedAt: now,
    openedAt: now,
    seed: project.seed,
    schemaPath: opts.config.schemaPath,
    keyField: opts.config.keyField,
    sources: project.sources.map((s) => ({ id: s.id, path: s.path, fileName: s.fileName, label: s.label, hash: s.hash })),
    settings: opts.config.settings,
    meta,
    stats: { records: project.records.length, review: 0, open: 0, resolved: 0, flagged: 0 },
    filesStored: opts.keepFiles,
    paths: files.map((f) => f.path),
  };
  const session = new Session(project, opts.config.settings, meta, [], sessionStore(project.id));
  stored.stats = session.stats();
  await putSession(stored);
  if (opts.keepFiles) await putFiles(project.id, files);
  void requestPersistence();
  return { session, stored };
}

export function configOf(stored: StoredSession): ProjectConfig {
  return {
    id: stored.id,
    name: stored.name,
    createdAt: stored.createdAt,
    seed: stored.seed,
    schemaPath: stored.schemaPath,
    keyField: stored.keyField,
    sources: stored.sources.map((s) => ({ id: s.id, path: s.path, label: s.label })),
    settings: stored.settings,
  };
}

export class NeedsFolderError extends Error {}

/** Files of a re-chosen folder that differ from the ones the session was built on. */
export async function changedSources(stored: StoredSession, files: readonly TextFile[]): Promise<string[]> {
  const out: string[] = [];
  for (const s of stored.sources) {
    const f = files.find((x) => x.path === s.path);
    if (!f) out.push(`${s.path} (missing)`);
    else if ((await hashText(f.text)) !== s.hash) out.push(s.path);
  }
  return out;
}

/** Reopen a saved session. Without `files`, the copy kept in the browser is used. */
export async function openSession(id: string, files?: TextFile[]): Promise<Opened> {
  const stored = await getSession(id);
  if (!stored) throw new Error('This session no longer exists in this browser.');
  const own = files ?? (stored.filesStored ? await getFiles(id) : null);
  if (!own) throw new NeedsFolderError('Choose the project folder again to resume this session.');
  const project = await buildProject(own, configOf(stored));
  const cells = await getCells(id);
  // Older or partial backups may lack some fields.
  const defaults: SessionMeta = { labels: {}, blindLog: [], terms: {}, activeMs: 0 };
  const meta: SessionMeta = { ...defaults, ...stored.meta };
  const session = new Session(project, stored.settings, meta, cells, sessionStore(id));
  const now = Date.now();
  const next: StoredSession = { ...stored, openedAt: now, stats: session.stats() };
  // A re-chosen folder whose files differ becomes the session's files (and is kept if files are kept).
  if (files) {
    next.sources = stored.sources.map((s) => ({ ...s, hash: project.sources.find((p) => p.id === s.id)?.hash ?? s.hash }));
    const reportPaths = new Set([...project.reports.values()].map((r) => r.path));
    const keep = files.filter((f) => stored.paths.includes(f.path) || reportPaths.has(f.path));
    next.paths = keep.map((f) => f.path);
    if (stored.filesStored) await putFiles(id, keep);
  }
  await putSession(next);
  return { session, stored: next };
}

/** Restore a backup as a new session (a copy, so it never overwrites the session it came from). */
export async function restoreBackup(backup: SessionBackup, files?: TextFile[]): Promise<Opened> {
  const id = uid('s-');
  const own = backup.files ?? files;
  if (!own) throw new NeedsFolderError('This backup does not include the folder’s files: choose the project folder to restore it.');
  const now = Date.now();
  const stored: StoredSession = {
    ...backup.session,
    id,
    name: backup.session.name,
    openedAt: now,
    updatedAt: now,
    filesStored: true,
  };
  const project = await buildProject(own, configOf(stored));
  await putSession(stored);
  await putFiles(id, own);
  await putCells(id, backup.cells);
  const session = new Session(project, stored.settings, stored.meta, backup.cells, sessionStore(id));
  return { session, stored };
}
