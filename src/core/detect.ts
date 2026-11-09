/**
 * Reads an uploaded folder and works out what each file is: the JSON Schema,
 * the abstractions to compare (JSON arrays of records), and the reports
 * (plain text or Markdown), plus the property that links each record to its
 * report file. Folder names do not matter; every guess can be changed at setup.
 */

import { keyFieldCandidates, rankSchemas, schemaScore } from './schema';
import type { AbstractionRecord, LoadIssue, ReportFormat, TextFile } from './types';
import { basename, dirname, extname, isObj, naturalCompare, stem } from './util';

export interface SourceOption {
  path: string;
  fileName: string;
  records: AbstractionRecord[];
}

export interface ReportFile {
  path: string;
  name: string;
  stem: string;
  dir: string;
  format: ReportFormat;
}

export interface KeyOption {
  field: string;
  /** Share of records (all sources) with a usable key value. */
  coverage: number;
  /** Share of each source's keyed records whose key is unique there (the minimum over sources). */
  unique: number;
  /** Distinct key values with a report file. */
  matched: number;
  /** Distinct key values. */
  distinct: number;
}

export interface Detection {
  name: string;
  schemas: { path: string; title: string; score: number }[];
  schemaPath: string | null;
  sources: SourceOption[];
  reports: ReportFile[];
  keys: KeyOption[];
  keyField: string | null;
  /** JSON files that could not be parsed. */
  issues: LoadIssue[];
  /** Parsed JSON by path (schemas and sources), kept for building the project. */
  json: Map<string, unknown>;
}

export const REPORT_EXTENSIONS = new Set(['txt', 'text', 'md', 'markdown']);

/** Canonical string form of a key value, or null when it cannot be a key. */
export function canonicalKey(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string' && value.trim()) return value.trim();
  return null;
}

/** Records of a parsed JSON file: an array of objects, or `{records: [...]}` / `{data: [...]}`. */
export function recordsOf(json: unknown): AbstractionRecord[] | null {
  let list: unknown = json;
  if (isObj(json)) list = Array.isArray(json.records) ? json.records : Array.isArray(json.data) ? json.data : null;
  if (!Array.isArray(list) || !list.length) return null;
  const objects = list.filter(isObj);
  if (objects.length < list.length / 2) return null;
  return objects;
}

/** Find a record's report: by file stem, file name, case-insensitively, or as a number. */
export function reportMatcher(reports: readonly ReportFile[], preferDir?: string | null): (key: string) => ReportFile | undefined {
  const exact = new Map<string, ReportFile>();
  const lower = new Map<string, ReportFile>();
  const numeric = new Map<string, ReportFile>();
  const ordered = [...reports].sort((a, b) => Number(b.dir === preferDir) - Number(a.dir === preferDir) || naturalCompare(a.path, b.path));
  const put = (map: Map<string, ReportFile>, k: string, r: ReportFile) => {
    if (!map.has(k)) map.set(k, r);
  };
  for (const r of ordered) {
    put(exact, r.stem, r);
    put(exact, r.name, r);
    put(lower, r.stem.toLowerCase(), r);
    put(lower, r.name.toLowerCase(), r);
    if (/^\d+$/.test(r.stem)) put(numeric, String(Number.parseInt(r.stem, 10)), r);
  }
  return (key: string) =>
    exact.get(key) ??
    lower.get(key.toLowerCase()) ??
    (/^\d+$/.test(key) ? numeric.get(String(Number.parseInt(key, 10))) : undefined) ??
    // A key that carries an extension ("17.txt") or a path ("reports/17").
    exact.get(stem(key)) ??
    lower.get(stem(key).toLowerCase());
}

function keyOptions(sources: SourceOption[], reports: ReportFile[], schemaOrder: string[]): KeyOption[] {
  if (!sources.length) return [];
  const fields = new Set<string>();
  for (const s of sources) for (const r of s.records.slice(0, 200)) for (const k of Object.keys(r)) fields.add(k);
  const match = reportMatcher(reports);
  const out: KeyOption[] = [];
  for (const field of fields) {
    let total = 0;
    let keyed = 0;
    let unique = 1;
    const values = new Set<string>();
    for (const s of sources) {
      const seen = new Set<string>();
      let dup = 0;
      let n = 0;
      for (const r of s.records) {
        total += 1;
        const k = canonicalKey(r[field]);
        if (k === null) continue;
        keyed += 1;
        n += 1;
        if (seen.has(k)) dup += 1;
        seen.add(k);
        values.add(k);
      }
      unique = Math.min(unique, n ? (n - dup) / n : 0);
    }
    const coverage = total ? keyed / total : 0;
    if (coverage < 0.9 || unique < 0.9) continue;
    let matched = 0;
    if (reports.length) for (const v of values) if (match(v)) matched += 1;
    out.push({ field, coverage, unique, matched, distinct: values.size });
  }
  const rank = (f: string) => {
    const i = schemaOrder.indexOf(f);
    return i < 0 ? 1e6 : i;
  };
  return out.sort((a, b) => b.matched - a.matched || rank(a.field) - rank(b.field) || b.unique - a.unique || naturalCompare(a.field, b.field));
}

export function detect(name: string, files: readonly TextFile[]): Detection {
  const issues: LoadIssue[] = [];
  const json = new Map<string, unknown>();
  const reports: ReportFile[] = [];
  for (const f of files) {
    const ext = extname(f.path);
    if (ext === 'json') {
      try {
        json.set(f.path, JSON.parse(f.text));
      } catch (err) {
        issues.push({ level: 'warning', message: `${f.path} is not valid JSON (${(err as Error).message}); skipped.` });
      }
    } else if (REPORT_EXTENSIONS.has(ext)) {
      reports.push({
        path: f.path,
        name: basename(f.path),
        stem: stem(f.path),
        dir: dirname(f.path),
        format: ext === 'md' || ext === 'markdown' ? 'markdown' : 'text',
      });
    }
  }

  const schemas = rankSchemas([...json].map(([path, j]) => ({ path, json: j })));
  const schemaPath = schemas[0]?.path ?? null;
  const sources: SourceOption[] = [];
  for (const [path, j] of json) {
    if (path === schemaPath || schemaScore(j) > 0) continue;
    const records = recordsOf(j);
    if (records) sources.push({ path, fileName: basename(path), records });
  }
  sources.sort((a, b) => naturalCompare(a.path, b.path));

  const schemaJson = schemaPath ? json.get(schemaPath) : null;
  let schemaOrder: string[] = [];
  if (isObj(schemaJson)) {
    const rec = isObj(schemaJson.properties) ? schemaJson : isObj(schemaJson.items) ? schemaJson.items : null;
    if (rec && isObj(rec.properties)) schemaOrder = [...keyFieldCandidates(rec), ...Object.keys(rec.properties)];
  }
  const keys = keyOptions(sources, reports, schemaOrder);
  return {
    name,
    schemas,
    schemaPath,
    sources,
    reports: reports.sort((a, b) => naturalCompare(a.path, b.path)),
    keys,
    keyField: keys[0]?.field ?? null,
    issues,
    json,
  };
}

/** The report directory most records' reports live in (for display), or null. */
export function mainReportDir(reports: readonly ReportFile[], keys: Iterable<string>): string | null {
  const match = reportMatcher(reports);
  const counts = new Map<string, number>();
  for (const k of keys) {
    const r = match(k);
    if (r) counts.set(r.dir, (counts.get(r.dir) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}
