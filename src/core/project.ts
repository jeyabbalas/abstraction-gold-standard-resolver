/**
 * Builds a {@link Project} — schema, sources, reports and the records to
 * adjudicate — from the folder's files and the choices made at setup. The
 * same function rebuilds a saved session from the files kept in IndexedDB.
 */

import { canonicalKey, detect, mainReportDir, recordsOf, reportMatcher, type Detection } from './detect';
import { buildSchemaModel, schemaScore } from './schema';
import type { AbstractionRecord, Json, LoadIssue, Project, RecordKey, ReportDoc, Settings, SourceData, TextFile } from './types';
import { basename, collapseWs, hashText, naturalCompare } from './util';

export class ProjectError extends Error {}

export interface SourceConfig {
  id: string;
  path: string;
  label: string;
}

export interface ProjectConfig {
  id: string;
  name: string;
  createdAt: number;
  seed: number;
  schemaPath: string;
  keyField: string;
  sources: SourceConfig[];
  settings: Settings;
}

/** Default display labels: "Abstractor 1, 2, …" for experts; the file stem otherwise. */
export function defaultLabel(fileName: string, index: number, scenario: Settings['scenario']): string {
  if (scenario === 'experts') return `Abstractor ${index + 1}`;
  return fileName.replace(/\.json$/i, '').replace(/[_-]+/g, ' ').trim() || `Source ${index + 1}`;
}

export async function buildProject(files: readonly TextFile[], config: ProjectConfig, detection?: Detection): Promise<Project> {
  const det = detection ?? detect(config.name, files);
  const issues: LoadIssue[] = [...det.issues];
  const textOf = new Map(files.map((f) => [f.path, f.text]));

  // --- schema ---------------------------------------------------------------
  const schemaDocs = [...det.json]
    .filter(([path, j]) => path === config.schemaPath || schemaScore(j) > 0)
    .map(([path, json]) => ({ path, json }));
  if (!schemaDocs.some((d) => d.path === config.schemaPath)) throw new ProjectError(`The schema ${config.schemaPath} is not in the folder.`);
  const schema = buildSchemaModel(schemaDocs, { path: config.schemaPath, keyField: config.keyField });
  const keyField = config.keyField;
  const fieldNames = new Set(schema.fields.map((f) => f.name));

  // --- sources --------------------------------------------------------------
  if (config.sources.length < 1) throw new ProjectError('Choose at least one abstraction to adjudicate.');
  const sources: SourceData[] = [];
  const keyValues = new Map<RecordKey, Json>();
  for (const sc of config.sources) {
    const text = textOf.get(sc.path);
    if (text === undefined) throw new ProjectError(`${sc.path} is not in the folder.`);
    const list = recordsOf(det.json.get(sc.path));
    if (!list) throw new ProjectError(`${sc.path} does not hold a JSON array of records.`);
    const records = new Map<RecordKey, AbstractionRecord>();
    const duplicateKeys: RecordKey[] = [];
    let unkeyed = 0;
    const extra = new Set<string>();
    const missing = new Set<string>();
    for (const r of list) {
      const key = canonicalKey(r[keyField]);
      if (key === null) {
        unkeyed += 1;
        continue;
      }
      if (records.has(key)) duplicateKeys.push(key);
      records.set(key, r);
      if (!keyValues.has(key)) keyValues.set(key, r[keyField] as Json);
      for (const k of Object.keys(r)) if (k !== keyField && !fieldNames.has(k)) extra.add(k);
      for (const f of fieldNames) if (!(f in r)) missing.add(f);
    }
    const name = basename(sc.path);
    if (unkeyed) issues.push({ level: 'warning', message: `${name}: ${unkeyed} record(s) without a ${keyField} were skipped.` });
    if (duplicateKeys.length) {
      issues.push({ level: 'warning', message: `${name}: ${duplicateKeys.length} duplicate ${keyField}(s) (e.g. ${duplicateKeys.slice(0, 3).join(', ')}); the last record is used.` });
    }
    if (extra.size) issues.push({ level: 'info', message: `${name}: ${extra.size} field(s) not in the schema are ignored (e.g. ${[...extra].slice(0, 3).join(', ')}).` });
    if (missing.size) {
      issues.push({ level: 'warning', message: `${name}: some records lack ${missing.size} field(s) (e.g. ${[...missing].slice(0, 3).join(', ')}); those cells have no value from this source.` });
    }
    sources.push({ id: sc.id, path: sc.path, fileName: name, label: sc.label, hash: await hashText(text), records, duplicateKeys });
  }

  // --- records ----------------------------------------------------------------
  const all = new Set<RecordKey>();
  for (const s of sources) for (const k of s.records.keys()) all.add(k);
  const records = [...all].sort(naturalCompare);
  if (!records.length) throw new ProjectError(`None of the abstractions has records with a ${keyField}.`);
  if (sources.length > 1) {
    const partial = records.filter((k) => sources.some((s) => !s.records.has(k)));
    if (partial.length) {
      issues.push({ level: 'info', message: `${partial.length} record(s) are missing from at least one abstraction (e.g. ${partial.slice(0, 4).join(', ')}).` });
    }
  }

  // --- reports ----------------------------------------------------------------
  const preferDir = mainReportDir(det.reports, records);
  const match = reportMatcher(det.reports, preferDir);
  const reports = new Map<RecordKey, ReportDoc>();
  const noReport: RecordKey[] = [];
  for (const key of records) {
    const r = match(key);
    const text = r ? textOf.get(r.path) : undefined;
    if (!r || text === undefined) {
      noReport.push(key);
      continue;
    }
    reports.set(key, { key, path: r.path, name: r.name, text, format: r.format });
  }
  if (noReport.length) {
    issues.push({
      level: noReport.length === records.length ? 'error' : 'warning',
      message: `${noReport.length} record(s) have no report file (e.g. ${noReport.slice(0, 4).join(', ')}): they can be adjudicated, but without the report text.`,
    });
  }

  // --- identical reports --------------------------------------------------------
  const byText = new Map<string, RecordKey[]>();
  for (const key of records) {
    const doc = reports.get(key);
    if (!doc) continue;
    const t = collapseWs(doc.text);
    if (!t) continue;
    let g = byText.get(t);
    if (!g) byText.set(t, (g = []));
    g.push(key);
  }
  const twins = new Map<RecordKey, RecordKey[]>();
  for (const g of byText.values()) if (g.length > 1) for (const k of g) twins.set(k, g);

  return {
    id: config.id,
    name: config.name,
    createdAt: config.createdAt,
    seed: config.seed,
    schema,
    keyField,
    sources,
    reports,
    records,
    keyValues,
    twins,
    issues,
  };
}

/** Field values of a record that are JSON (undefined when the source has no value). */
export function sourceValue(source: SourceData, key: RecordKey, field: string): Json | undefined {
  const rec = source.records.get(key);
  if (!rec || !(field in rec)) return undefined;
  const v = rec[field];
  return v === undefined ? undefined : (v as Json);
}
