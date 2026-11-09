/**
 * The report pane: the record's report (plain text, reflowed when it is one
 * long line, or Markdown rendered safely), with
 *  - highlights drawn with the CSS Custom Highlight API (no DOM rewriting):
 *    each candidate's snippets in its color, snippets every candidate shares,
 *    the focused field's search terms, report search, and a flash;
 *  - ticks along the scrollbar showing where the highlights are;
 *  - search (/), text size and reflow controls;
 *  - selection → "Add to value" for the text field being edited.
 */

import { reflow, renderMarkdown, shouldReflow } from '../../core/markdown';
import { TextIndex, type Span } from '../../core/snippets';
import type { Term, TermSet } from '../../core/terms';
import type { RecordKey, ReportDoc } from '../../core/types';
import { collapseWs } from '../../core/util';
import { prefs } from '../../state';
import { withTooltip } from '../../ui/components';
import { debounce, h, render } from '../../ui/dom';
import { plural } from '../../ui/format';
import { icon } from '../../ui/icons';

export type HighlightKind = 'c1' | 'c2' | 'c3' | 'c4' | 'c5' | 'c6' | 'shared' | 'term' | 'search' | 'current' | 'flash';
const KINDS: HighlightKind[] = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'shared', 'term', 'search', 'current', 'flash'];
const PRIORITY: Record<HighlightKind, number> = { term: 0, shared: 1, c1: 2, c2: 2, c3: 2, c4: 2, c5: 2, c6: 2, search: 5, current: 6, flash: 7 };
const hlName = (k: HighlightKind) => `gsr-${k}`;

export const candidateKind = (position: number): HighlightKind => (`c${(position % 6) + 1}`) as HighlightKind;

export const highlightsSupported = (): boolean => typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined';

export interface SnippetGroup {
  kind: HighlightKind;
  snippets: string[];
}

export interface ReportPane {
  el: HTMLElement;
  show(doc: ReportDoc | undefined, record: RecordKey, twins: RecordKey[]): void;
  /** Highlight snippet groups and terms for the focused field; scroll to the first evidence when it is off screen. */
  highlight(groups: SnippetGroup[], terms: Term[], opts?: { scroll?: boolean }): void;
  /** Scroll to a snippet and flash it; false when it is not in the report. */
  flash(snippet: string): boolean;
  /** Whether a snippet occurs in the report verbatim (whitespace aside): 'exact', 'case' (only ignoring case), 'parts' or 'none'. */
  locate(snippet: string): 'exact' | 'case' | 'parts' | 'none';
  setTerms(set: TermSet | null, onChange?: (terms: { add: string[]; off: string[] }) => void): void;
  /** The action offered for a text selection in the report (null: none). */
  setSelectionAction(action: { label: string; run: (text: string) => void } | null): void;
  focusSearch(): void;
  toggleReflow(): void;
  zoom(delta: number): void;
  readonly text: string;
  destroy(): void;
}

const SIZE_MIN = 11;
const SIZE_MAX = 22;

export function createReportPane(): ReportPane {
  let doc: ReportDoc | undefined;
  let index: TextIndex | null = null;
  let nodes: Text[] = [];
  let starts: number[] = [];
  let lastGroups: SnippetGroup[] = [];
  let lastTerms: Term[] = [];
  let termSet: TermSet | null = null;
  let onTerms: ((t: { add: string[]; off: string[] }) => void) | undefined;
  let selectionAction: { label: string; run: (text: string) => void } | null = null;
  let searchHits: Span[] = [];
  let searchAt = -1;
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  const ranges = new Map<HighlightKind, Range[]>();

  let size = Number(prefs.get('reportSize')) || 14;
  let reflowPref = (prefs.get('reflow') as 'auto' | 'on' | 'off' | null) ?? 'auto';

  // ------------------------------------------------------------- elements
  const title = h('div', { class: 'report-title' });
  const searchInput = h('input', { class: 'report-search-input', type: 'search', placeholder: 'Search the report', 'aria-label': 'Search the report', spellcheck: false });
  const searchCount = h('span', { class: 'report-search-count num' });
  const prevBtn = h('button', { type: 'button', class: 'icon-btn sm', 'aria-label': 'Previous match' }, icon('chevronUp'));
  const nextBtn = h('button', { type: 'button', class: 'icon-btn sm', 'aria-label': 'Next match' }, icon('chevronDown'));
  const search = h('div', { class: 'report-search' }, icon('search'), searchInput, searchCount, prevBtn, nextBtn);
  const reflowBtn = h('button', { type: 'button', class: 'icon-btn sm' }, icon('wrap'));
  const smaller = h('button', { type: 'button', class: 'icon-btn sm', 'aria-label': 'Smaller text' }, icon('minus'));
  const larger = h('button', { type: 'button', class: 'icon-btn sm', 'aria-label': 'Larger text' }, icon('plus'));
  withTooltip(reflowBtn, () => (reflowOn() ? 'Show the original line breaks (w)' : 'Break long lines at the report’s spacing (w)'));
  withTooltip(smaller, 'Smaller text (−)');
  withTooltip(larger, 'Larger text (+)');
  const toolbar = h('div', { class: 'report-toolbar' }, title, h('div', { class: 'report-tools' }, search, reflowBtn, h('span', { class: 'tool-sep' }), smaller, larger));
  const termsRow = h('div', { class: 'report-terms', hidden: true });
  const body = h('div', { class: 'report-body', tabIndex: 0, 'aria-label': 'Report text' });
  const marks = h('div', { class: 'report-marks', 'aria-hidden': 'true' });
  const scroller = h('div', { class: 'report-scroll' }, body);
  const selBtn = h('button', { type: 'button', class: 'selection-action', hidden: true }, icon('plus'), h('span'));
  const el = h('section', { class: 'report-pane', 'aria-label': 'Report' }, toolbar, termsRow, h('div', { class: 'report-frame' }, scroller, marks, selBtn));

  const reflowOn = () => doc?.format === 'text' && (reflowPref === 'on' || (reflowPref === 'auto' && shouldReflow(doc.text)));

  function applySize() {
    body.style.setProperty('--report-size', `${size}px`);
  }
  applySize();

  // --------------------------------------------------------------- index
  function buildIndex() {
    nodes = [];
    starts = [];
    let text = '';
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n as Text;
      nodes.push(t);
      starts.push(text.length);
      text += t.data;
    }
    index = text ? new TextIndex(text) : null;
  }

  function pointAt(offset: number): { node: Text; offset: number } | null {
    if (!nodes.length) return null;
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    const node = nodes[lo]!;
    return { node, offset: Math.min(node.data.length, offset - starts[lo]!) };
  }

  function toRange(span: Span): Range | null {
    const a = pointAt(span.start);
    const b = pointAt(span.end);
    if (!a || !b) return null;
    const r = document.createRange();
    try {
      r.setStart(a.node, a.offset);
      r.setEnd(b.node, b.offset);
    } catch {
      return null;
    }
    return r;
  }

  // ----------------------------------------------------------- highlights
  function setKind(kind: HighlightKind, list: Range[]) {
    ranges.set(kind, list);
    if (!highlightsSupported()) return;
    if (!list.length) {
      CSS.highlights.delete(hlName(kind));
      return;
    }
    const hl = new Highlight(...list);
    hl.priority = PRIORITY[kind];
    CSS.highlights.set(hlName(kind), hl);
  }

  function clearAll() {
    for (const k of KINDS) setKind(k, []);
  }

  function snippetSpans(snippet: string): Span[] {
    if (!index) return [];
    return index.locateSnippet(snippet).matches.map((m) => ({ start: m.start, end: m.end }));
  }

  const paintMarks = debounce(() => {
    render(marks);
    const total = scroller.scrollHeight;
    if (!total || !el.isConnected) return;
    const frameH = scroller.clientHeight;
    const base = scroller.getBoundingClientRect().top - scroller.scrollTop;
    const ticks: HTMLElement[] = [];
    for (const kind of ['term', 'shared', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'search'] as HighlightKind[]) {
      for (const r of ranges.get(kind) ?? []) {
        const rect = r.getBoundingClientRect();
        if (!rect.height && !rect.width) continue;
        const top = ((rect.top - base) / total) * frameH;
        ticks.push(h('span', { class: ['mark', `mark-${kind}`], style: { top: `${Math.max(0, Math.min(frameH - 3, top)).toFixed(1)}px` } }));
      }
    }
    render(marks, ticks);
  }, 60);

  function scrollToRange(r: Range, force = false) {
    const rect = r.getBoundingClientRect();
    const box = scroller.getBoundingClientRect();
    const visible = rect.top >= box.top + 8 && rect.bottom <= box.bottom - 8;
    if (visible && !force) return;
    const target = scroller.scrollTop + (rect.top - box.top) - box.height / 3;
    scroller.scrollTo({ top: Math.max(0, target), behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }

  function applyHighlights(scroll: boolean) {
    for (const k of KINDS) if (k !== 'search' && k !== 'current' && k !== 'flash') setKind(k, []);
    const first: Range[] = [];
    for (const g of lastGroups) {
      const list: Range[] = [];
      for (const s of g.snippets) for (const sp of snippetSpans(s)) {
        const r = toRange(sp);
        if (r) list.push(r);
      }
      setKind(g.kind, [...(ranges.get(g.kind) ?? []), ...list]);
      first.push(...list);
    }
    const termRanges: Range[] = [];
    if (index) {
      for (const t of lastTerms) for (const sp of index.findAll(t.needle, { wordStart: true, limit: 200 })) {
        const r = toRange(sp);
        if (r) termRanges.push(r);
      }
    }
    setKind('term', termRanges);
    if (scroll) {
      const target = (first.length ? first : termRanges).sort((a, b) => a.compareBoundaryPoints(Range.START_TO_START, b))[0];
      if (target) scrollToRange(target);
    }
    paintMarks();
  }

  // --------------------------------------------------------------- search
  function runSearch(keepPosition = false) {
    const q = searchInput.value.trim();
    searchHits = q && index ? index.findAll(q, { limit: 500 }) : [];
    if (!keepPosition) searchAt = searchHits.length ? 0 : -1;
    setKind('search', searchHits.map(toRange).filter((r): r is Range => !!r));
    showCurrent();
    paintMarks();
  }

  function showCurrent() {
    const sp = searchAt >= 0 ? searchHits[searchAt] : undefined;
    const r = sp ? toRange(sp) : null;
    setKind('current', r ? [r] : []);
    if (r) scrollToRange(r);
    searchCount.textContent = searchInput.value.trim() ? (searchHits.length ? `${searchAt + 1}/${searchHits.length}` : '0') : '';
    search.classList.toggle('active', !!searchInput.value.trim());
  }

  function stepSearch(dir: 1 | -1) {
    if (!searchHits.length) return;
    searchAt = (searchAt + dir + searchHits.length) % searchHits.length;
    showCurrent();
  }

  searchInput.addEventListener('input', () => runSearch());
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      stepSearch(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (searchInput.value) {
        searchInput.value = '';
        runSearch();
      } else searchInput.blur();
    }
  });
  prevBtn.addEventListener('click', () => stepSearch(-1));
  nextBtn.addEventListener('click', () => stepSearch(1));

  // --------------------------------------------------------------- render
  function paintTitle(record: RecordKey, twins: RecordKey[]) {
    render(
      title,
      icon('file'),
      h('span', { class: 'report-name' }, doc ? doc.name : `Record ${record}`),
      doc?.format === 'markdown' ? h('span', { class: 'badge outline' }, 'Markdown') : null,
      twins.length
        ? withTooltip(
            h('span', { class: 'badge twin-badge' }, icon('copy'), `Same text as ${twins.length === 1 ? `record ${twins[0]}` : plural(twins.length, 'record')}`),
            `Byte-identical report text: ${twins.join(', ')}.`,
          )
        : null,
    );
  }

  function paintBody() {
    if (!doc) {
      render(body, h('div', { class: 'report-missing' }, icon('file'), h('strong', null, 'No report file for this record.'), h('span', null, 'Decide from the abstractions and the dictionary alone.')));
    } else if (doc.format === 'markdown') {
      const div = h('div', { class: 'report-md' });
      // markdown-it with html disabled: raw HTML in the report is escaped; links are inert.
      div.innerHTML = renderMarkdown(doc.text);
      render(body, div);
    } else {
      render(body, h('div', { class: 'report-text' }, reflowOn() ? reflow(doc.text) : doc.text));
    }
    reflowBtn.hidden = doc?.format !== 'text';
    reflowBtn.classList.toggle('on', !!reflowOn());
    reflowBtn.setAttribute('aria-pressed', String(!!reflowOn()));
    reflowBtn.setAttribute('aria-label', 'Reflow long lines');
    buildIndex();
  }

  function paintTerms() {
    if (!termSet) {
      termsRow.hidden = true;
      return;
    }
    termsRow.hidden = false;
    const all = [...termSet.suggested, ...termSet.added.filter((a) => !termSet!.suggested.some((t) => t.text === a)).map((a): Term => ({ text: a, needle: a, origin: 'custom' }))];
    const activeSet = new Set(termSet.active.map((t) => t.text));
    const counts = new Map<string, number>();
    if (index) for (const t of all) counts.set(t.text, index.findAll(t.needle, { wordStart: true, limit: 99 }).length);
    const input = h('input', { class: 'term-input', placeholder: 'Add a term', 'aria-label': 'Add a search term', spellcheck: false, maxlength: 60 });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const v = collapseWs(input.value);
        if (!v || !termSet) return;
        const add = termSet.added.includes(v) ? termSet.added : [...termSet.added, v];
        onTerms?.({ add, off: termSet.off.filter((o) => o !== v) });
      } else if (e.key === 'Escape') {
        e.stopPropagation();
        input.blur();
      }
    });
    render(
      termsRow,
      h('span', { class: 'terms-label' }, 'Terms'),
      all.map((t) => {
        const on = activeSet.has(t.text);
        const n = counts.get(t.text) ?? 0;
        return withTooltip(
          h(
            'button',
            {
              type: 'button',
              class: ['term-chip', on && 'on', !n && 'none', t.origin === 'custom' && 'custom'],
              'aria-pressed': String(on),
              onclick: () => {
                if (!termSet) return;
                if (t.origin === 'custom') onTerms?.({ add: termSet.added.filter((a) => a !== t.text), off: termSet.off });
                else onTerms?.({ add: termSet.added, off: on ? [...termSet.off, t.text] : termSet.off.filter((o) => o !== t.text) });
              },
            },
            t.text,
            h('span', { class: 'term-count num' }, String(n)),
            t.origin === 'custom' ? icon('x') : null,
          ),
          t.origin === 'custom'
            ? `Your term. ${plural(n, 'match', 'matches')} in this report. Click to remove.`
            : `${t.origin === 'name' ? 'From the field name' : 'Quoted in the field’s definition'}. ${plural(n, 'match', 'matches')} in this report. Click to ${on ? 'hide' : 'show'}.`,
        );
      }),
      input,
    );
  }

  // ------------------------------------------------------------ selection
  function hideSelection() {
    selBtn.hidden = true;
  }

  function onMouseUp() {
    setTimeout(() => {
      const sel = window.getSelection();
      if (!selectionAction || !sel || sel.isCollapsed || !sel.rangeCount) return hideSelection();
      const r = sel.getRangeAt(0);
      if (!body.contains(r.commonAncestorContainer)) return hideSelection();
      const text = collapseWs(sel.toString());
      if (text.length < 2) return hideSelection();
      const rect = r.getBoundingClientRect();
      const frame = scroller.parentElement!.getBoundingClientRect();
      render(selBtn, icon('plus'), h('span', null, selectionAction.label));
      selBtn.hidden = false;
      const left = Math.min(frame.width - selBtn.offsetWidth - 8, Math.max(8, rect.left - frame.left + rect.width / 2 - selBtn.offsetWidth / 2));
      const top = rect.top - frame.top - selBtn.offsetHeight - 8;
      selBtn.style.left = `${left}px`;
      selBtn.style.top = `${top < 4 ? rect.bottom - frame.top + 8 : top}px`;
      selBtn.onclick = () => {
        selectionAction?.run(text);
        sel.removeAllRanges();
        hideSelection();
      };
    }, 0);
  }
  body.addEventListener('mouseup', onMouseUp);
  body.addEventListener('keyup', (e) => {
    if (e.shiftKey) onMouseUp();
  });
  scroller.addEventListener('scroll', hideSelection, { passive: true });
  const onSelectionChange = () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) hideSelection();
  };
  document.addEventListener('selectionchange', onSelectionChange);

  marks.addEventListener('pointerdown', (e) => {
    const box = marks.getBoundingClientRect();
    const frac = (e.clientY - box.top) / box.height;
    scroller.scrollTo({ top: frac * scroller.scrollHeight - scroller.clientHeight / 2, behavior: 'smooth' });
  });

  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => paintMarks()) : null;
  ro?.observe(scroller);

  // ------------------------------------------------------------------ api
  reflowBtn.addEventListener('click', () => api.toggleReflow());
  smaller.addEventListener('click', () => api.zoom(-1));
  larger.addEventListener('click', () => api.zoom(1));

  const api: ReportPane = {
    el,
    get text() {
      return index?.text ?? '';
    },
    show(next, record, twins) {
      doc = next;
      paintTitle(record, twins.filter((t) => t !== record));
      paintBody();
      scroller.scrollTop = 0;
      hideSelection();
      clearAll();
      lastGroups = [];
      lastTerms = [];
      if (searchInput.value.trim()) runSearch();
      paintTerms();
    },
    highlight(groups, terms, opts = {}) {
      lastGroups = groups;
      lastTerms = terms;
      applyHighlights(opts.scroll ?? true);
    },
    flash(snippet) {
      const spans = snippetSpans(snippet);
      const r = spans[0] ? toRange(spans[0]) : null;
      if (!r) return false;
      setKind('flash', spans.map(toRange).filter((x): x is Range => !!x));
      scrollToRange(r, false);
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => setKind('flash', []), 1400);
      return true;
    },
    locate(snippet) {
      if (!index) return 'none';
      const m = index.locateSnippet(snippet).matches;
      if (!m.length) return 'none';
      if (m.some((x) => x.exact && !x.caseInsensitive)) return 'exact';
      if (m.some((x) => x.exact)) return 'case';
      return 'parts';
    },
    setTerms(set, onChange) {
      termSet = set;
      onTerms = onChange;
      paintTerms();
    },
    setSelectionAction(action) {
      selectionAction = action;
      if (!action) hideSelection();
    },
    focusSearch() {
      searchInput.focus();
      searchInput.select();
    },
    toggleReflow() {
      if (doc?.format !== 'text') return;
      reflowPref = reflowOn() ? 'off' : 'on';
      prefs.set('reflow', reflowPref);
      const top = scroller.scrollTop / Math.max(1, scroller.scrollHeight);
      paintBody();
      applyHighlights(false);
      if (searchInput.value.trim()) runSearch(true);
      scroller.scrollTop = top * scroller.scrollHeight;
    },
    zoom(delta) {
      size = Math.max(SIZE_MIN, Math.min(SIZE_MAX, size + delta));
      prefs.set('reportSize', String(size));
      applySize();
      paintMarks();
    },
    destroy() {
      clearAll();
      ro?.disconnect();
      clearTimeout(flashTimer);
      document.removeEventListener('selectionchange', onSelectionChange);
    },
  };
  return api;
}
