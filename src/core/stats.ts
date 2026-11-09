/**
 * Agreement statistics: between the sources (percent agreement, Cohen's or
 * Fleiss' kappa on categorical fields) and of each source with the
 * consensus, plus the adjudicator's pace.
 */

import { agreementKey } from './compare';
import type { Session } from './session';
import type { FieldInfo, Json } from './types';

export interface PairAgreement {
  a: number;
  b: number;
  /** Cells both sources gave a value for. */
  n: number;
  agree: number;
  /** Cohen's kappa over categorical cells (null when undefined). */
  kappa: number | null;
}

export interface SourceScore {
  source: number;
  /** Cells with a consensus value the source gave a value for. */
  n: number;
  /** …of which the source's value matches the consensus. */
  match: number;
  /** Review cells (conflicts) with a consensus the source gave a value for. */
  reviewN: number;
  reviewMatch: number;
}

/** Cohen's kappa from paired labels. */
export function cohenKappa(pairs: readonly [string, string][]): number | null {
  const n = pairs.length;
  if (!n) return null;
  const pa = new Map<string, number>();
  const pb = new Map<string, number>();
  let agree = 0;
  for (const [a, b] of pairs) {
    if (a === b) agree += 1;
    pa.set(a, (pa.get(a) ?? 0) + 1);
    pb.set(b, (pb.get(b) ?? 0) + 1);
  }
  const po = agree / n;
  let pe = 0;
  for (const [k, ca] of pa) pe += (ca / n) * ((pb.get(k) ?? 0) / n);
  if (pe >= 1) return po === 1 ? 1 : null;
  return (po - pe) / (1 - pe);
}

/** Fleiss' kappa: each item lists the label every rater gave (same rater count per item). */
export function fleissKappa(items: readonly string[][]): number | null {
  const N = items.length;
  if (!N) return null;
  const n = items[0]!.length;
  if (n < 2 || items.some((it) => it.length !== n)) return null;
  const totals = new Map<string, number>();
  let pBar = 0;
  for (const it of items) {
    const counts = new Map<string, number>();
    for (const l of it) counts.set(l, (counts.get(l) ?? 0) + 1);
    let s = 0;
    for (const [l, c] of counts) {
      s += c * (c - 1);
      totals.set(l, (totals.get(l) ?? 0) + c);
    }
    pBar += s / (n * (n - 1));
  }
  pBar /= N;
  let pe = 0;
  for (const c of totals.values()) pe += (c / (N * n)) ** 2;
  if (pe >= 1) return pBar === 1 ? 1 : null;
  return (pBar - pe) / (1 - pe);
}

function keyOf(session: Session, field: FieldInfo, v: Json): string {
  return agreementKey(field, v, session.settings, session.spec);
}

/** Pairwise agreement between sources, over the given fields (default: all). */
export function pairwiseAgreement(session: Session, fields: readonly FieldInfo[] = session.fields): PairAgreement[] {
  const k = session.project.sources.length;
  const out: PairAgreement[] = [];
  for (let a = 0; a < k; a += 1) {
    for (let b = a + 1; b < k; b += 1) {
      let n = 0;
      let agree = 0;
      const pairs: [string, string][] = [];
      for (const record of session.project.records) {
        for (const f of fields) {
          const cmp = session.comparison(record, f.name);
          const va = cmp.values[a];
          const vb = cmp.values[b];
          if (va === undefined || vb === undefined) continue;
          n += 1;
          const ka = keyOf(session, f, va);
          const kb = keyOf(session, f, vb);
          if (ka === kb) agree += 1;
          if (f.kind === 'categorical') pairs.push([`${f.name}\u0000${ka}`, `${f.name}\u0000${kb}`]);
        }
      }
      out.push({ a, b, n, agree, kappa: fields.length === 1 && fields[0]!.kind === 'categorical' ? cohenKappa(pairs) : null });
    }
  }
  return out;
}

/** Per-field agreement among all sources: share of cells (all sources present) where all agree, and kappa. */
export function fieldAgreement(session: Session, field: FieldInfo): { n: number; agree: number; kappa: number | null } {
  const k = session.project.sources.length;
  let n = 0;
  let agree = 0;
  const items: string[][] = [];
  for (const record of session.project.records) {
    const cmp = session.comparison(record, field.name);
    if (cmp.values.some((v) => v === undefined)) continue;
    n += 1;
    if (cmp.candidates.length === 1) agree += 1;
    if (field.kind === 'categorical') items.push(cmp.values.map((v) => keyOf(session, field, v as Json)));
  }
  let kappa: number | null = null;
  if (field.kind === 'categorical' && items.length) {
    kappa = k === 2 ? cohenKappa(items.map((it) => [it[0]!, it[1]!] as [string, string])) : fleissKappa(items);
  }
  return { n, agree, kappa };
}

/** How often each source's value matches the consensus. */
export function sourceScores(session: Session, fields: readonly FieldInfo[] = session.fields): SourceScore[] {
  const scores: SourceScore[] = session.project.sources.map((_, source) => ({ source, n: 0, match: 0, reviewN: 0, reviewMatch: 0 }));
  for (const record of session.project.records) {
    for (const f of fields) {
      const r = session.resolution(record, f.name);
      if (r.state !== 'decided' && r.state !== 'auto') continue;
      const cmp = session.comparison(record, f.name);
      const review = session.needsReview(record, f.name);
      const target = keyOf(session, f, r.value);
      cmp.values.forEach((v, i) => {
        if (v === undefined) return;
        const s = scores[i]!;
        const ok = keyOf(session, f, v) === target;
        s.n += 1;
        if (ok) s.match += 1;
        if (review) {
          s.reviewN += 1;
          if (ok) s.reviewMatch += 1;
        }
      });
    }
  }
  return scores;
}

export interface Pace {
  decisions: number;
  timed: number;
  medianMs: number | null;
  totalMs: number;
  /** Estimated time to resolve the open cells at the median pace. */
  remainingMs: number | null;
}

export function pace(session: Session): Pace {
  const times: number[] = [];
  let decisions = 0;
  for (const c of session.allCells()) {
    const d = c.decision;
    if (!d || d.kind === 'propagated') continue;
    decisions += 1;
    if (d.ms !== undefined && d.ms > 500) times.push(d.ms);
  }
  times.sort((a, b) => a - b);
  const median = times.length ? times[Math.floor((times.length - 1) / 2)]! : null;
  const open = session.stats().open;
  return {
    decisions,
    timed: times.length,
    medianMs: median,
    totalMs: session.meta.activeMs,
    remainingMs: median !== null && times.length >= 3 ? median * open : null,
  };
}
