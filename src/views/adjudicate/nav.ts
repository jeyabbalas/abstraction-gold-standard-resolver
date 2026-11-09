/**
 * Which records the adjudicator moves through, and which fields a record
 * shows: a record filter (open conflicts, flagged, …) within a field scope
 * (every field, one group of fields, or a single field for working field by
 * field across records).
 */

import type { Session } from '../../core/session';
import type { RecordKey } from '../../core/types';

export type RecordFilter = 'open' | 'review' | 'all' | 'flagged' | 'notes' | 'violations' | 'stale';

export const FILTERS: { value: RecordFilter; label: string; hint: string }[] = [
  { value: 'open', label: 'Open conflicts', hint: 'Records with cells still waiting for you' },
  { value: 'review', label: 'Needs review', hint: 'Every record with cells that needed you, resolved or not' },
  { value: 'flagged', label: 'Flagged', hint: 'Records with cells flagged for discussion' },
  { value: 'notes', label: 'With notes', hint: 'Records with notes' },
  { value: 'violations', label: 'Rule violations', hint: 'Records whose consensus breaks a cross-field rule' },
  { value: 'stale', label: 'Changed since decided', hint: 'Decisions made on values that have since changed' },
  { value: 'all', label: 'All records', hint: 'Every record, including those where all sources agree' },
];

/** '' (every field), 'cat:<key>' or 'field:<name>'. */
export type FieldScope = string;

export function scopeFields(session: Session, scope: FieldScope): Set<string> | null {
  if (!scope) return null;
  if (scope.startsWith('field:')) {
    const name = scope.slice(6);
    return session.field(name) ? new Set([name]) : null;
  }
  if (scope.startsWith('cat:')) {
    const cat = session.project.schema.categories.find((c) => c.key === scope.slice(4));
    return cat ? new Set(cat.fields) : null;
  }
  return null;
}

export function scopeLabel(session: Session, scope: FieldScope): string {
  if (scope.startsWith('field:')) return session.field(scope.slice(6))?.title ?? scope.slice(6);
  if (scope.startsWith('cat:')) return session.project.schema.categories.find((c) => c.key === scope.slice(4))?.title ?? scope.slice(4);
  return 'All fields';
}

/** Whether a record belongs to the filter within the scope. */
export function matches(session: Session, record: RecordKey, filter: RecordFilter, fields: Set<string> | null): boolean {
  if (filter === 'all') return true;
  if (filter === 'violations') {
    const v = session.violations(record);
    return fields ? v.some((x) => x.rule.fields.some((f) => fields.has(f))) : v.length > 0;
  }
  if (!fields) {
    const s = session.summary(record);
    switch (filter) {
      case 'open':
        return s.open > 0;
      case 'review':
        return s.review > 0;
      case 'flagged':
        return s.flagged > 0;
      case 'notes':
        return s.noted > 0;
      case 'stale':
        return s.stale > 0;
    }
  }
  for (const f of fields) {
    switch (filter) {
      case 'open':
        if (session.isOpen(record, f)) return true;
        break;
      case 'review':
        if (session.needsReview(record, f)) return true;
        break;
      case 'flagged':
        if (session.cell(record, f)?.flag) return true;
        break;
      case 'notes':
        if (session.cell(record, f)?.note) return true;
        break;
      case 'stale':
        if (session.isStale(record, f)) return true;
        break;
    }
  }
  return false;
}

export function recordList(session: Session, filter: RecordFilter, fields: Set<string> | null): RecordKey[] {
  return session.project.records.filter((r) => matches(session, r, filter, fields));
}

/**
 * The next (dir 1) or previous (dir −1) record after `current` in the
 * project's order that matches, wrapping around; null when none other does.
 */
export function stepRecord(
  session: Session,
  current: RecordKey,
  dir: 1 | -1,
  filter: RecordFilter,
  fields: Set<string> | null,
): { record: RecordKey; wrapped: boolean } | null {
  const all = session.project.records;
  const n = all.length;
  const start = Math.max(0, all.indexOf(current));
  for (let i = 1; i < n; i += 1) {
    const idx = start + dir * i;
    const j = ((idx % n) + n) % n;
    const r = all[j]!;
    if (matches(session, r, filter, fields)) return { record: r, wrapped: idx < 0 || idx >= n };
  }
  return null;
}

/** The record to show when none is given: the cursor, else the first with open cells, else the first. */
export function initialRecord(session: Session): RecordKey | null {
  const cur = session.meta.cursor?.record;
  if (cur && session.project.records.includes(cur)) return cur;
  return session.project.records.find((r) => session.summary(r).open > 0) ?? session.project.records[0] ?? null;
}

/**
 * Fields a record shows as cards, in schema order: the ones that need review,
 * plus any the adjudicator decided, flagged or annotated, plus `extra`
 * (agreed fields opened to override them).
 */
export function cardFields(session: Session, record: RecordKey, fields: Set<string> | null, extra: ReadonlySet<string>): string[] {
  return session.fields
    .filter((f) => {
      if (fields && !fields.has(f.name)) return false;
      if (extra.has(f.name)) return true;
      if (session.needsReview(record, f.name)) return true;
      const c = session.cell(record, f.name);
      return !!(c?.decision || c?.flag || c?.note);
    })
    .map((f) => f.name);
}

/** The next open field after `from` among `order` (wrapping), or null. */
export function nextOpen(session: Session, record: RecordKey, order: readonly string[], from: string | null): string | null {
  const start = from ? order.indexOf(from) : -1;
  for (let i = 1; i <= order.length; i += 1) {
    const f = order[(start + i + order.length) % order.length]!;
    if (session.isOpen(record, f)) return f;
  }
  return null;
}
