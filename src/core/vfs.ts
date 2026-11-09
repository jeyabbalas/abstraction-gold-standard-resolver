/**
 * Collects the files of an uploaded folder from any of the browser's entry
 * points — a directory <input>, a drag-and-drop of a folder, or a .zip
 * archive — re-roots their paths at the folder, and reads the ones the app
 * understands (JSON, plain text, Markdown) as text.
 */

import { unzip } from 'fflate';
import type { TextFile } from './types';
import { extname } from './util';

export interface RawFile {
  path: string;
  blob: Blob;
}

export interface FileSet {
  /** Name of the folder (or of the archive). */
  name: string;
  files: TextFile[];
  /** Files that were skipped (unsupported type) — for the setup summary. */
  skipped: number;
}

export class UnreadableFileError extends Error {}

/** Extensions read as text. */
export const TEXT_EXTENSIONS = new Set(['json', 'txt', 'text', 'md', 'markdown']);

const isHidden = (path: string): boolean =>
  path.split('/').some((seg) => seg.startsWith('.') || seg === '__MACOSX' || seg === 'Thumbs.db' || seg === 'node_modules');

/** Strip the directory prefix every file shares; the folder is named after it. */
export function reroot(raw: RawFile[], fallbackName: string): { name: string; files: RawFile[] } {
  const visible = raw.filter((f) => !isHidden(f.path));
  if (!visible.length) return { name: fallbackName, files: [] };
  const dirs = visible.map((f) => f.path.split('/').slice(0, -1));
  let common = dirs[0]!;
  for (const d of dirs) {
    let i = 0;
    while (i < common.length && i < d.length && common[i] === d[i]) i += 1;
    common = common.slice(0, i);
    if (!common.length) break;
  }
  const lead = common.length ? `${common.join('/')}/` : '';
  return {
    name: common.length ? common[common.length - 1]! : fallbackName,
    files: visible.map((f) => ({ path: f.path.slice(lead.length), blob: f.blob })),
  };
}

async function readText(file: RawFile): Promise<string> {
  try {
    return await file.blob.text();
  } catch (err) {
    const { name, message } = err as Error;
    throw new UnreadableFileError(`${file.path} could not be read (${name}: ${message.trim().replace(/\.$/, '')}).`);
  }
}

/** Read the supported files of a re-rooted set as text (universal newlines, no BOM). */
export async function readFileSet(raw: RawFile[], fallbackName: string): Promise<FileSet> {
  const { name, files } = reroot(raw, fallbackName);
  const keep = files.filter((f) => TEXT_EXTENSIONS.has(extname(f.path)));
  const texts = await Promise.all(
    keep.map(async (f) => ({ path: f.path, text: (await readText(f)).replace(/^﻿/, '').replace(/\r\n?/g, '\n') })),
  );
  return { name, files: texts, skipped: files.length - keep.length };
}

const stripExt = (name: string): string => name.replace(/\.[^.]+$/, '');

export async function fromZip(blob: Blob, name: string): Promise<FileSet> {
  const buffer = new Uint8Array(await blob.arrayBuffer());
  const entries = await new Promise<Record<string, Uint8Array>>((resolve, reject) =>
    unzip(buffer, (err, data) => (err ? reject(err) : resolve(data))),
  );
  const raw: RawFile[] = [];
  for (const [path, bytes] of Object.entries(entries)) {
    if (path.endsWith('/')) continue; // directory entry
    raw.push({ path: path.replace(/\\/g, '/'), blob: new Blob([bytes as Uint8Array<ArrayBuffer>]) });
  }
  return readFileSet(raw, stripExt(name));
}

/** Files from `<input type="file" webkitdirectory>` (or a multi-file pick, or one .zip). */
export async function fromFileList(list: FileList | File[]): Promise<FileSet> {
  const files = Array.from(list);
  if (files.length === 1 && /\.zip$/i.test(files[0]!.name)) return fromZip(files[0]!, files[0]!.name);
  const raw = files.map((f) => ({ path: (f.webkitRelativePath || f.name).replace(/\\/g, '/'), blob: f as Blob }));
  return readFileSet(raw, 'folder');
}

function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    const out: FileSystemEntry[] = [];
    const next = () =>
      reader.readEntries((batch) => {
        if (!batch.length) resolve(out);
        else {
          out.push(...batch);
          next();
        }
      }, reject);
    next();
  });
}

const entryFile = (entry: FileSystemFileEntry): Promise<File> => new Promise((resolve, reject) => entry.file(resolve, reject));

async function walk(entry: FileSystemEntry, prefix: string, out: RawFile[]): Promise<void> {
  const path = prefix ? `${prefix}/${entry.name}` : entry.name;
  if (entry.isFile) {
    out.push({ path, blob: await entryFile(entry as FileSystemFileEntry) });
  } else if (entry.isDirectory) {
    const children = await readAllEntries((entry as FileSystemDirectoryEntry).createReader());
    await Promise.all(children.map((c) => walk(c, path, out)));
  }
}

/** Files from a drag-and-drop: a folder, several items, or a single .zip. */
export async function fromDataTransfer(dt: DataTransfer): Promise<FileSet> {
  const items = Array.from(dt.items ?? []).filter((i) => i.kind === 'file');
  const entries = items.map((i) => i.webkitGetAsEntry?.()).filter((e): e is FileSystemEntry => !!e);
  if (!entries.length) return fromFileList(Array.from(dt.files));
  if (entries.length === 1 && entries[0]!.isFile && /\.zip$/i.test(entries[0]!.name)) {
    const file = await entryFile(entries[0] as FileSystemFileEntry);
    return fromZip(file, file.name);
  }
  const raw: RawFile[] = [];
  await Promise.all(entries.map((e) => walk(e, '', raw)));
  const fallback = entries.length === 1 && entries[0]!.isDirectory ? entries[0]!.name : 'folder';
  return readFileSet(raw, fallback);
}
