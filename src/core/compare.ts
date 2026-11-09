/**
 * Compares the sources' values of one cell (record × field): which distinct
 * values were proposed, by whom, and whether they agree. Strings are compared
 * with whitespace collapsed; for text fields the settings can also ignore
 * letter case and snippet order. Values that differ only in case, punctuation
 * or snippet order are flagged as a minor conflict.
 */

import { sourceValue } from './project';
import { splitSnippets, type SnippetSpec } from './snippets';
import type { Candidate, CellStatus, Comparison, FieldInfo, Json, RecordKey, Resolution, Settings, SourceData } from './types';
import type { CellState } from './types';
import { collapseWs, sameJson, stableStringify } from './util';
import type { Validators } from './validate';

export interface CompareContext {
  sources: readonly SourceData[];
  settings: Settings;
  validators: Validators;
  spec: SnippetSpec;
  field(name: string): FieldInfo | undefined;
}

/** The key two values must share to agree. */
export function agreementKey(field: FieldInfo | undefined, value: Json, settings: Settings, spec: SnippetSpec): string {
  if (typeof value !== 'string') return `j:${stableStringify(value)}`;
  let s = collapseWs(value);
  if (field?.kind === 'text') {
    if (settings.textIgnoreCase) s = s.toLowerCase();
    if (settings.textIgnoreOrder && field.multi) s = splitSnippets(s, spec).sort().join('\u0001');
  }
  return `s:${s}`;
}

/** A looser key: equal loose keys mean the values differ only trivially. */
export function looseKey(value: Json, spec: SnippetSpec): string {
  if (typeof value !== 'string') return `j:${stableStringify(value)}`;
  const parts = splitSnippets(value, spec);
  const norm = (p: string) =>
    p
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  return `s:${(parts.length ? parts : [value]).map(norm).filter(Boolean).sort().join('\u0001')}`;
}

export function compareCell(ctx: CompareContext, record: RecordKey, fieldName: string): Comparison {
  const field = ctx.field(fieldName);
  const values = ctx.sources.map((s) => sourceValue(s, record, fieldName));
  const groups = new Map<string, { sources: number[]; variants: Map<string, { value: Json; count: number; first: number }> }>();
  values.forEach((v, i) => {
    if (v === undefined) return;
    const key = agreementKey(field, v, ctx.settings, ctx.spec);
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { sources: [], variants: new Map() }));
    g.sources.push(i);
    const vk = stableStringify(v);
    const variant = g.variants.get(vk);
    if (variant) variant.count += 1;
    else g.variants.set(vk, { value: v, count: 1, first: i });
  });
  const candidates: Candidate[] = [...groups].map(([key, g]) => {
    // The most common variant the schema allows (ties: the earliest source).
    const variants = [...g.variants.values()].map((v) => ({ ...v, valid: ctx.validators.fieldValid(fieldName, v.value) }));
    variants.sort((a, b) => Number(b.valid) - Number(a.valid) || b.count - a.count || a.first - b.first);
    const best = variants[0]!;
    return { key, value: best.value, sources: g.sources, valid: best.valid };
  });
  const present = values.filter((v) => v !== undefined).length;
  let status: CellStatus;
  if (!present) status = 'empty';
  else if (candidates.length > 1) status = 'conflict';
  else status = present === 1 && ctx.sources.length > 1 ? 'single' : 'agree';
  const minor =
    status === 'conflict' && new Set(candidates.map((c) => looseKey(c.value, ctx.spec))).size === 1;
  return { record, field: fieldName, values, status, candidates, minor };
}

/** The candidate a majority rule accepts, if any: enough sources and strictly more than any other. */
export function majorityCandidate(cmp: Comparison, settings: Settings): Candidate | null {
  if (!settings.majority || cmp.status !== 'conflict') return null;
  const sorted = [...cmp.candidates].sort((a, b) => b.sources.length - a.sources.length);
  const top = sorted[0]!;
  const second = sorted[1];
  if (top.sources.length >= settings.majority && (!second || top.sources.length > second.sources.length) && top.valid) return top;
  return null;
}

/** Whether a cell needs the adjudicator: a conflict, a missing required value, an invalid value, or (by setting) a single source. */
export function needsReview(cmp: Comparison, field: FieldInfo | undefined, settings: Settings): boolean {
  switch (cmp.status) {
    case 'conflict':
      return true;
    case 'empty':
      return !!field?.required;
    case 'single':
      return settings.singleSource === 'review' || !cmp.candidates[0]!.valid;
    case 'agree':
      return !cmp.candidates[0]!.valid;
  }
}

/** The consensus value of a cell: the adjudicator's decision, else what the rules accept, else open. */
export function resolveCell(cmp: Comparison, cell: CellState | undefined, field: FieldInfo | undefined, settings: Settings): Resolution {
  const d = cell?.decision;
  if (d) return { state: 'decided', value: d.value, decision: d };
  switch (cmp.status) {
    case 'agree':
      return cmp.candidates[0]!.valid ? { state: 'auto', value: cmp.candidates[0]!.value, reason: 'agree' } : { state: 'open' };
    case 'single':
      return settings.singleSource === 'accept' && cmp.candidates[0]!.valid
        ? { state: 'auto', value: cmp.candidates[0]!.value, reason: 'single' }
        : { state: 'open' };
    case 'empty':
      return field?.required ? { state: 'open' } : { state: 'absent' };
    case 'conflict': {
      const m = majorityCandidate(cmp, settings);
      return m ? { state: 'auto', value: m.value, reason: 'majority' } : { state: 'open' };
    }
  }
}

/** Sources whose value agrees with `value` (by the agreement key). */
export function agreeingSources(cmp: Comparison, value: Json, field: FieldInfo | undefined, settings: Settings, spec: SnippetSpec): number[] {
  const key = agreementKey(field, value, settings, spec);
  return cmp.candidates.find((c) => c.key === key)?.sources ?? [];
}

/** Whether a decision was made on values that have since changed. */
export function isStale(cmp: Comparison, cell: CellState | undefined, sources: readonly SourceData[]): boolean {
  const d = cell?.decision;
  if (!d || d.kind === 'propagated') return false;
  return sources.some((s, i) => {
    const had = Object.prototype.hasOwnProperty.call(d.snapshot, s.id);
    const now = cmp.values[i];
    if (!had) return now !== undefined;
    return !sameJson(d.snapshot[s.id], now);
  });
}
