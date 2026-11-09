/**
 * Report snippets: free-text values are lists of exact report snippets joined
 * by a separator (' || '), with source whitespace collapsed. This module
 * splits and joins such lists, locates snippets in the report text, and
 * aligns the snippet lists of several candidates for comparison.
 *
 * A few dictionaries document constructed forms ("X primary in Y",
 * "SITE :: DIAGNOSIS", "Site not stated: X"); those are located part by part.
 */

import { collapseWs } from './util';

export interface SnippetSpec {
  separator: string | null;
  /** Whole-value labels that are not report text ('Not identified'). */
  sentinels: readonly string[];
}

/** The snippets of a text value (sentinels and empty parts excluded). */
export function splitSnippets(value: unknown, spec: SnippetSpec): string[] {
  if (typeof value !== 'string') return [];
  const parts = spec.separator ? value.split(spec.separator.trim()) : [value];
  return parts.map((s) => s.trim()).filter((s) => s && !spec.sentinels.includes(s));
}

export function joinSnippets(snippets: readonly string[], spec: SnippetSpec): string {
  return snippets.join(spec.separator ?? ' ');
}

export interface Span {
  /** Offsets into the indexed text, [start, end). */
  start: number;
  end: number;
}

export interface SnippetMatch extends Span {
  /** The snippet (or part of a constructed snippet) that matched. */
  text: string;
  /** The whole snippet matched verbatim (modulo whitespace). */
  exact: boolean;
  /** It matched only ignoring letter case. */
  caseInsensitive: boolean;
}

/** Phrases the constructed forms add that are not report text. */
const CONSTRUCTED = /^(?:histology not stated|site not stated|secondary site not stated|unknown primary(?: site)?|unknown(?: site)?|primary|not stated)$/i;
const PART_SPLIT = /\s+::\s+|\s*\.\.\.\s*|\s*…\s*|\s+primary in\s+|\s+in\s+(?=[A-Z])|:\s+|\s+-\s+/;

/** Whitespace-normalized index of a text, for locating snippets. */
export class TextIndex {
  readonly text: string;
  private readonly norm: string;
  private readonly lower: string | null;
  /** Offset in `text` of each normalized character. */
  private readonly map: Int32Array;

  constructor(text: string) {
    this.text = text;
    let norm = '';
    const map: number[] = [];
    let inSpace = false;
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i]!;
      if (/\s/.test(ch)) {
        if (!inSpace && norm.length) {
          norm += ' ';
          map.push(i);
        }
        inSpace = true;
      } else {
        norm += ch;
        map.push(i);
        inSpace = false;
      }
    }
    this.norm = norm;
    this.map = Int32Array.from(map);
    const lower = norm.toLowerCase();
    this.lower = lower.length === norm.length ? lower : null;
  }

  private find(needle: string, from: number): { idx: number; ci: boolean } | null {
    if (!needle) return null;
    let idx = this.norm.indexOf(needle, from);
    if (idx < 0) idx = this.norm.indexOf(needle);
    if (idx >= 0) return { idx, ci: false };
    if (this.lower) {
      const n = needle.toLowerCase();
      if (n.length === needle.length) {
        idx = this.lower.indexOf(n, from);
        if (idx < 0) idx = this.lower.indexOf(n);
        if (idx >= 0) return { idx, ci: true };
      }
    }
    return null;
  }

  private span(idx: number, length: number): Span {
    return { start: this.map[idx]!, end: this.map[idx + length - 1]! + 1 };
  }

  /** Every occurrence of a phrase (case-insensitive), as spans of `text`. */
  findAll(phrase: string, opts: { wordStart?: boolean; limit?: number } = {}): Span[] {
    const needle = collapseWs(phrase).toLowerCase();
    if (!needle || !this.lower) return [];
    const out: Span[] = [];
    let from = 0;
    while (out.length < (opts.limit ?? 500)) {
      const idx = this.lower.indexOf(needle, from);
      if (idx < 0) break;
      from = idx + 1;
      if (opts.wordStart && idx > 0 && /[\p{L}\p{N}]/u.test(this.lower[idx - 1]!)) continue;
      out.push(this.span(idx, needle.length));
    }
    return out;
  }

  /** Where one snippet occurs; constructed snippets are located part by part. */
  locateSnippet(snippet: string, cursor = 0): { matches: SnippetMatch[]; next: number } {
    const s = collapseWs(snippet);
    const hit = this.find(s, cursor);
    if (hit) {
      return { matches: [{ ...this.span(hit.idx, s.length), text: snippet, exact: true, caseInsensitive: hit.ci }], next: hit.idx + 1 };
    }
    const parts = s
      .split(PART_SPLIT)
      .map((p) => p.trim())
      .filter((p) => p.length >= 3 && !CONSTRUCTED.test(p));
    const matches: SnippetMatch[] = [];
    for (const part of parts) {
      const ph = this.find(part, cursor);
      if (ph) matches.push({ ...this.span(ph.idx, part.length), text: part, exact: false, caseInsensitive: ph.ci });
    }
    return { matches, next: cursor };
  }

  /** Locate each snippet of a list, preferring occurrences in list order. */
  locateAll(snippets: readonly string[]): { snippet: string; matches: SnippetMatch[] }[] {
    let cursor = 0;
    return snippets.map((snippet) => {
      const r = this.locateSnippet(snippet, cursor);
      cursor = r.next;
      return { snippet, matches: r.matches };
    });
  }
}

// ----------------------------------------------------------------- alignment

export interface AlignedSnippet {
  /** The snippet as the first candidate that has it wrote it. */
  text: string;
  /** Comparison key (whitespace-collapsed). */
  key: string;
  /** Indexes (into the candidates passed) of the candidates that include it. */
  members: number[];
  /** Position in the report (Infinity when it is not report text). */
  position: number;
  located: boolean;
  exact: boolean;
}

/**
 * The union of the candidates' snippets, each with the candidates that
 * include it, ordered by where it occurs in the report (unlocated snippets
 * last, in candidate order).
 */
export function alignSnippets(lists: readonly (readonly string[])[], index: TextIndex | null): AlignedSnippet[] {
  const byKey = new Map<string, AlignedSnippet>();
  let seq = 0;
  const order = new Map<string, number>();
  lists.forEach((list, ci) => {
    for (const snippet of list) {
      const key = collapseWs(snippet);
      let row = byKey.get(key);
      if (!row) {
        const loc = index?.locateSnippet(snippet).matches ?? [];
        const exact = loc.some((m) => m.exact && !m.caseInsensitive);
        row = {
          text: snippet,
          key,
          members: [],
          position: loc.length ? Math.min(...loc.map((m) => m.start)) : Number.POSITIVE_INFINITY,
          located: loc.length > 0,
          exact,
        };
        byKey.set(key, row);
        order.set(key, seq++);
      }
      if (!row.members.includes(ci)) row.members.push(ci);
    }
  });
  return [...byKey.values()].sort((a, b) => a.position - b.position || order.get(a.key)! - order.get(b.key)!);
}

/** Snippets ordered by where they occur in the report (unlocated ones keep their place at the end). */
export function sortByReport(snippets: readonly string[], index: TextIndex | null): string[] {
  if (!index) return [...snippets];
  const pos = snippets.map((s, i) => {
    const m = index.locateSnippet(s).matches;
    return { s, i, p: m.length ? Math.min(...m.map((x) => x.start)) : Number.POSITIVE_INFINITY };
  });
  return pos.sort((a, b) => a.p - b.p || a.i - b.i).map((x) => x.s);
}
