/**
 * Search terms that help find the evidence for a field in a report: words of
 * the field name (stemmed, generic words dropped) and short phrases the
 * definition quotes as report wording (“high-grade serous carcinoma”). The
 * adjudicator can switch terms off and add their own; they are kept per field.
 */

import type { FieldInfo } from './types';

/** Name parts that carry no clinical meaning. */
const STOP = new Set([
  'and', 'or', 'of', 'the', 'in', 'to', 'with', 'for', 'by', 'on', 'not', 'no', 'yes', 'any', 'all',
  'text', 'other', 'others', 'specific', 'type', 'types', 'status', 'flag', 'value', 'code', 'id',
  'histo', 'histology', 'histologic', 'ca', 'primary', 'secondary', 'second', 'involv', 'involvement', 'involved',
  'site', 'sites', 'evaluated', 'conditions', 'condition', 'suspected', 'identified', 'present', 'presence',
  'bu', 'bo', 'uc', 'oc', 'ocperifal', 'peri', 'fal', 'gyn', 'nongyn', 'non', 'metas', 'spread', 'or_suspected', 'cancer',
]);

/** Split a field name into words: snake_case, camelCase, digits. */
export function nameWords(name: string): string[] {
  return name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map((w) => w.toLowerCase())
    .filter(Boolean);
}

/** A light stem: long words lose their last two letters so related forms match (metastasis → metastas). */
export function stemWord(w: string): string {
  return w.length >= 9 ? w.slice(0, -2) : w;
}

/** Phrases the description quotes as examples of report wording. */
export function quotedPhrases(description: string, exclude: readonly string[] = []): string[] {
  const out: string[] = [];
  const skip = new Set(exclude.map((e) => e.toLowerCase()));
  const re = /[“"]([^”"\n]{3,48})[”"]/g;
  for (let m = re.exec(description); m; m = re.exec(description)) {
    const p = m[1]!.trim().replace(/[,.;:]+$/, '');
    const l = p.toLowerCase();
    if (p.length < 3 || skip.has(l) || out.some((o) => o.toLowerCase() === l)) continue;
    out.push(p);
  }
  return out;
}

export interface Term {
  /** The term as shown. */
  text: string;
  /** What is searched for (at a word start, ignoring case): a stem for name words. */
  needle: string;
  origin: 'name' | 'definition' | 'custom';
}

export interface TermSet {
  /** Suggested terms (from the name and the description). */
  suggested: Term[];
  /** Terms in use: suggested minus switched off, plus added. */
  active: Term[];
  added: string[];
  off: string[];
}

export function fieldTerms(field: FieldInfo, custom?: { add?: string[]; off?: string[] }, limit = 10): TermSet {
  const fromName: Term[] = nameWords(field.name)
    .filter((w) => w.length >= 4 && !STOP.has(w))
    .map((w) => ({ text: w, needle: stemWord(w), origin: 'name' }));
  const labels = field.domain.map((v) => String(v));
  const fromDesc: Term[] = quotedPhrases(field.description, [...labels, ...field.quickValues])
    .filter((p) => !/^(yes|no)$/i.test(p))
    .map((p) => ({ text: p, needle: p, origin: 'definition' }));
  const suggested: Term[] = [];
  for (const t of [...fromName, ...fromDesc]) {
    if (suggested.length >= limit) break;
    if (!suggested.some((s) => s.text.toLowerCase() === t.text.toLowerCase())) suggested.push(t);
  }
  const off = custom?.off ?? [];
  const added = custom?.add ?? [];
  const active: Term[] = [
    ...suggested.filter((t) => !off.includes(t.text)),
    ...added.filter((a) => !suggested.some((t) => t.text === a)).map((a): Term => ({ text: a, needle: a, origin: 'custom' })),
  ];
  return { suggested, active, added, off };
}
