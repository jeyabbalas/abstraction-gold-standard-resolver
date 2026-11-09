/**
 * What the adjudicator takes away:
 *  - the consensus gold standard: a JSON array of records in the schema's shape;
 *  - the adjudication log: one row per cell with every source's value, the
 *    consensus, how it was reached, notes and flags (CSV);
 *  - a summary (counts, settings, blind-mode history, agreement with the consensus);
 *  - a session backup that restores the session in another browser.
 */

import { zipSync, strToU8 } from 'fflate';
import { BACKUP_FORMAT, type SessionBackup, type StoredSession } from './db';
import type { Session } from './session';
import { fieldAgreement, pace, pairwiseAgreement, sourceScores } from './stats';
import type { Json, RecordKey, TextFile } from './types';
import { displayValue } from './util';

export type ConsensusScope = 'complete' | 'all';

/** Records whose every review cell is resolved. */
export function completeRecords(session: Session): RecordKey[] {
  return session.project.records.filter((r) => session.summary(r).open === 0);
}

/**
 * The consensus records: the key first, then fields in schema order. With
 * scope 'all', records with open cells are included and open cells are null.
 */
export function consensusRecords(session: Session, scope: ConsensusScope): Record<string, Json>[] {
  const records = scope === 'complete' ? completeRecords(session) : session.project.records;
  return records.map((r) => session.consensusRecord(r, { withKey: true, withOpen: scope === 'all' }));
}

const iso = (ms: number | undefined) => (ms ? new Date(ms).toISOString() : '');

export interface LogRow {
  [column: string]: string | number | boolean;
}

/** One row per cell (only cells that needed review or were touched, unless `all`). */
export function adjudicationLog(session: Session, all = false): LogRow[] {
  const { project } = session;
  const rows: LogRow[] = [];
  const catTitle = new Map(project.schema.categories.map((c) => [c.key, c.title]));
  for (const record of project.records) {
    for (const f of session.fields) {
      const cmp = session.comparison(record, f.name);
      const cell = session.cell(record, f.name);
      const review = session.needsReview(record, f.name);
      if (!all && !review && !cell) continue;
      const res = session.resolution(record, f.name);
      const value = res.state === 'decided' || res.state === 'auto' ? res.value : undefined;
      const d = cell?.decision;
      const row: LogRow = {
        record: record,
        field: f.name,
        category: catTitle.get(f.category) ?? f.category,
        comparison: cmp.status,
        minor_difference: cmp.minor,
        needs_review: review,
      };
      project.sources.forEach((s, i) => {
        const v = cmp.values[i];
        row[`value: ${session.sourceLabel(i)}`] = v === undefined ? '' : displayValue(v);
        void s;
      });
      row.consensus = value === undefined ? '' : displayValue(value);
      row.resolution =
        res.state === 'decided' ? (d!.kind === 'custom' ? 'adjudicator value' : d!.kind === 'propagated' ? 'identical report' : 'adjudicator chose') : res.state === 'auto' ? `automatic (${res.reason})` : res.state;
      row.agreeing_sources = value === undefined ? '' : session.agreeingSources(record, f.name, value).map((i) => session.sourceLabel(i)).join('; ');
      row.decided_blind = d ? d.blind : '';
      row.decided_at = iso(d?.at);
      row.seconds = d?.ms !== undefined ? Math.round(d.ms / 100) / 10 : '';
      row.propagated_from = d?.from ?? '';
      row.stale = d ? session.isStale(record, f.name) : false;
      row.flagged = !!cell?.flag;
      row.note = cell?.note ?? '';
      rows.push(row);
    }
  }
  return rows;
}

/** Byte-order mark: spreadsheet apps then read the CSV as UTF-8. */
export const CSV_BOM = '\uFEFF';

export function toCsv(rows: readonly LogRow[]): string {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]!);
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.map(esc).join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\r\n');
}

export function summary(session: Session, stored?: StoredSession): Record<string, unknown> {
  const { project } = session;
  const stats = session.stats();
  const complete = completeRecords(session).length;
  let custom = 0;
  let decided = 0;
  let propagated = 0;
  let blindDecisions = 0;
  for (const c of session.allCells()) {
    if (!c.decision) continue;
    decided += 1;
    if (c.decision.kind === 'custom') custom += 1;
    if (c.decision.kind === 'propagated') propagated += 1;
    if (c.decision.blind) blindDecisions += 1;
  }
  const scores = sourceScores(session);
  const p = pace(session);
  return {
    session: { name: project.name, created: iso(project.createdAt), exported: new Date().toISOString(), id: project.id },
    schema: { title: project.schema.title, file: project.schema.path, fields: project.schema.fields.length, key: project.keyField },
    sources: project.sources.map((s, i) => ({ label: session.sourceLabel(i), file: s.path, sha256: s.hash, records: s.records.size })),
    settings: session.settings,
    blind_mode_history: session.meta.blindLog.map((b) => ({ at: iso(b.at), blind: b.blind })),
    counts: {
      records: stats.records,
      records_complete: complete,
      cells: stats.records * project.schema.fields.length,
      cells_needing_review: stats.review,
      cells_open: stats.open,
      decisions: decided,
      decisions_adjudicator_value: custom,
      decisions_propagated_to_identical_reports: propagated,
      decisions_made_blind: blindDecisions,
      flagged: stats.flagged,
    },
    agreement_with_consensus: scores.map((s) => ({
      source: session.sourceLabel(s.source),
      cells: s.n,
      match: s.match,
      rate: s.n ? s.match / s.n : null,
      review_cells: s.reviewN,
      review_match: s.reviewMatch,
      review_rate: s.reviewN ? s.reviewMatch / s.reviewN : null,
    })),
    agreement_between_sources: pairwiseAgreement(session).map((p2) => ({
      a: session.sourceLabel(p2.a),
      b: session.sourceLabel(p2.b),
      cells: p2.n,
      agree: p2.agree,
      rate: p2.n ? p2.agree / p2.n : null,
    })),
    field_agreement: session.fields.map((f) => {
      const a = fieldAgreement(session, f);
      return { field: f.name, cells: a.n, all_agree: a.agree, rate: a.n ? a.agree / a.n : null, kappa: a.kappa };
    }),
    time: { active_minutes: Math.round(p.totalMs / 6000) / 10, median_seconds_per_decision: p.medianMs !== null ? Math.round(p.medianMs / 100) / 10 : null },
    ...(stored ? { folder: stored.folderName } : {}),
  };
}

export function backup(session: Session, stored: StoredSession, files: TextFile[] | null): SessionBackup {
  return {
    format: BACKUP_FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    session: { ...stored, settings: session.settings, meta: session.meta, stats: session.stats() },
    cells: session.allCells(),
    ...(files ? { files } : {}),
  };
}

export const fileStem = (name: string): string =>
  name
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || 'session';

/** Everything in one archive. */
export function exportZip(session: Session, stored: StoredSession, files: TextFile[] | null, scope: ConsensusScope): Uint8Array {
  const stemName = fileStem(session.project.name);
  return zipSync({
    [`${stemName}_consensus.json`]: strToU8(JSON.stringify(consensusRecords(session, scope), null, 2)),
    [`${stemName}_adjudication_log.csv`]: strToU8(CSV_BOM + toCsv(adjudicationLog(session))),
    [`${stemName}_summary.json`]: strToU8(JSON.stringify(summary(session, stored), null, 2)),
    [`${stemName}_session_backup.json`]: strToU8(JSON.stringify(backup(session, stored, files))),
  });
}
