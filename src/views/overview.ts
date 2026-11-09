/**
 * Overview: how far the consensus is, the adjudicator's pace, where the
 * sources disagree (a map of every cell and a table per field), what needs
 * attention (flags, notes, rule violations, decisions on changed values),
 * agreement between the sources (hidden during blind review) and the setup.
 */

import type { StoredSession } from '../core/db';
import type { Session } from '../core/session';
import { fieldAgreement, pace, pairwiseAgreement, sourceScores } from '../core/stats';
import type { FieldInfo, RecordKey } from '../core/types';
import { displayValue } from '../core/util';
import { navigate } from '../state';
import { badge, emptyState, hideTooltip, ring, showTooltip, withTooltip } from '../ui/components';
import { debounce, h, render, type Child } from '../ui/dom';
import { fmtDuration, fmtInt, fmtMetric, fmtPct, plural, truncate } from '../ui/format';
import { icon } from '../ui/icons';
import { toggleBlind } from './blind';
import { openExportDialog } from './exportDialog';
import type { ViewFactory } from './types';

// ------------------------------------------------------------------ helpers

const openCell = (record: RecordKey, field?: string) => navigate('adjudicate', [record], field ? { field } : {});

function firstOpenField(session: Session, record: RecordKey): string | undefined {
  return session.reviewFields(record).find((f) => session.isOpen(record, f));
}

/** The next record with open cells, starting at the one the adjudicator was on. */
export function nextOpenCell(session: Session): { record: RecordKey; field?: string } | null {
  const recs = session.project.records;
  const cur = session.meta.cursor?.record;
  const start = cur ? Math.max(0, recs.indexOf(cur)) : 0;
  for (let i = 0; i < recs.length; i += 1) {
    const r = recs[(start + i) % recs.length]!;
    if (session.summary(r).open > 0) return { record: r, field: firstOpenField(session, r) };
  }
  return null;
}

const dateTime = (ms: number) =>
  new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

function stat(label: string, value: Child, sub?: Child): HTMLElement {
  return h('div', { class: 'ov-stat' }, h('div', { class: 'ov-stat-label' }, label), h('div', { class: 'ov-stat-value num' }, value), sub ? h('div', { class: 'ov-stat-sub' }, sub) : null);
}

function card(title: Child, subtitle: Child | null, body: Child, actions?: Child): HTMLElement {
  return h(
    'section',
    { class: 'card ov-card' },
    h(
      'div',
      { class: 'card-head' },
      h('div', { class: 'card-titles' }, h('h2', { class: 'card-title' }, title), subtitle ? h('p', { class: 'card-subtitle' }, subtitle) : null),
      actions ? h('div', { class: 'card-actions' }, actions) : null,
    ),
    h('div', { class: 'card-body' }, body),
  );
}

// ------------------------------------------------------------------ cell map

type CellKind = 0 | 1 | 2 | 3 | 4 | 5 | 6;
const K_NONE = 0;
const K_OPEN = 1;
const K_DECIDED = 2;
const K_MAJORITY = 3;
const K_FLAG = 4;
const K_STALE = 5;
const K_EMPTY = 6;

function cellKind(session: Session, record: RecordKey, field: string): CellKind {
  if (session.isStale(record, field)) return K_STALE;
  if (session.cell(record, field)?.flag) return K_FLAG;
  const res = session.resolution(record, field);
  if (res.state === 'decided') return K_DECIDED;
  if (session.needsReview(record, field)) return res.state === 'open' ? K_OPEN : K_MAJORITY;
  return res.state === 'absent' ? K_EMPTY : K_NONE;
}

interface MapRow {
  field: FieldInfo;
  y: number;
}

interface CellMap {
  el: HTMLElement;
  paint(): void;
  destroy(): void;
}

function cellMap(session: Session): CellMap {
  const records = session.project.records;
  const groups = session.project.schema.categories
    .map((c) => ({ title: c.title, fields: c.fields.map((n) => session.field(n)).filter((f): f is FieldInfo => !!f) }))
    .filter((g) => g.fields.length);
  const grouped = groups.length > 1;
  const nFields = groups.reduce((n, g) => n + g.fields.length, 0);
  const rowH = nFields > 140 ? 4 : nFields > 90 ? 5 : 7;
  const gap = grouped ? 6 : 0;

  const rows: MapRow[] = [];
  const labels: { title: string; y: number; h: number }[] = [];
  let y = 0;
  for (const g of groups) {
    const top = y;
    for (const f of g.fields) {
      rows.push({ field: f, y });
      y += rowH;
    }
    labels.push({ title: g.title, y: top, h: y - top });
    y += gap;
  }
  const height = Math.max(rowH, y - gap);

  const canvas = h('canvas', { class: 'ov-map-canvas', role: 'img' });
  const marker = h('div', { class: 'ov-map-marker', hidden: true });
  const gutter = grouped
    ? h(
        'div',
        { class: 'ov-map-gutter', style: { height: `${height}px` } },
        labels.map((l) => h('div', { class: 'ov-map-label', style: { top: `${l.y}px`, height: `${Math.max(l.h, 10)}px` }, title: l.title }, l.title)),
      )
    : null;
  const plot = h('div', { class: 'ov-map-plot' }, canvas, marker);
  const scroller = h('div', { class: 'ov-map-scroll' }, plot);
  const axis = h(
    'div',
    { class: 'ov-map-axis' },
    h('span', null, `Record ${records[0] ?? ''}`),
    h('span', null, `${plural(records.length, 'record')} →`),
    h('span', null, `Record ${records[records.length - 1] ?? ''}`),
  );
  const el = h('div', { class: ['ov-map', grouped && 'grouped'] }, gutter, h('div', { class: 'ov-map-main' }, scroller, axis));

  let colW = 4;
  let kinds = new Uint8Array(0);

  function colors() {
    const cs = getComputedStyle(el);
    const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
    return {
      [K_NONE]: v('--st-agree', '#e3e2dc'),
      [K_EMPTY]: v('--surface-2', '#f3f2ee'),
      [K_OPEN]: v('--st-open', '#e8a317'),
      [K_DECIDED]: v('--st-done', '#2f9e44'),
      [K_MAJORITY]: v('--st-done-tint', 'rgba(47,158,68,.35)'),
      [K_FLAG]: v('--st-flag', '#e0592a'),
      [K_STALE]: v('--st-stale', '#d03b3b'),
    } as Record<CellKind, string>;
  }

  function paint() {
    const avail = Math.max(200, scroller.clientWidth || 900);
    colW = Math.max(2, Math.min(14, Math.floor(avail / Math.max(1, records.length))));
    const width = colW * records.length;
    const dpr = window.devicePixelRatio || 1;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    plot.style.width = `${width}px`;
    if (!kinds.length) {
      // States are computed once: any change to the session redraws the whole view.
      kinds = new Uint8Array(records.length * rows.length);
      records.forEach((r, ci) => rows.forEach((row, ri) => (kinds[ci * rows.length + ri] = cellKind(session, r, row.field.name))));
    }
    canvas.setAttribute(
      'aria-label',
      `Map of ${fmtInt(records.length * rows.length)} cells: ${fmtInt(kinds.filter((k) => k === K_OPEN).length)} open, ${fmtInt(kinds.filter((k) => k === K_DECIDED).length)} decided.`,
    );
    const ctx = canvas.getContext?.('2d');
    if (ctx) {
      const pal = colors();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      const cw = colW > 3 ? colW - 1 : colW;
      const ch = rowH > 4 ? rowH - 1 : rowH;
      for (let ci = 0; ci < records.length; ci += 1) {
        const x = ci * colW;
        for (let ri = 0; ri < rows.length; ri += 1) {
          ctx.fillStyle = pal[kinds[ci * rows.length + ri] as CellKind];
          ctx.fillRect(x, rows[ri]!.y, cw, ch);
        }
      }
    }
    // "You are here": the record the adjudicator was on.
    const cur = session.meta.cursor?.record;
    const ci = cur ? records.indexOf(cur) : -1;
    marker.hidden = ci < 0;
    if (ci >= 0) {
      marker.style.left = `${ci * colW + (colW > 3 ? (colW - 1) / 2 : colW / 2)}px`;
      marker.title = `You were on record ${cur}`;
    }
  }

  function hit(e: MouseEvent): { record: RecordKey; field: FieldInfo; kind: CellKind } | null {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const yy = e.clientY - rect.top;
    const ci = Math.floor(x / colW);
    if (ci < 0 || ci >= records.length) return null;
    const ri = rows.findIndex((r) => yy >= r.y && yy < r.y + rowH);
    if (ri < 0) return null;
    return { record: records[ci]!, field: rows[ri]!.field, kind: kinds[ci * rows.length + ri] as CellKind };
  }

  function describe(record: RecordKey, field: FieldInfo, kind: CellKind): Child {
    const res = session.resolution(record, field.name);
    const value = res.state === 'decided' || res.state === 'auto' ? truncate(displayValue(res.value), 90) : null;
    const cell = session.cell(record, field.name);
    const status: Record<CellKind, string> = {
      [K_NONE]: res.state === 'auto' && res.reason === 'single' ? 'One source only' : 'Sources agree',
      [K_EMPTY]: 'No value (optional field)',
      [K_OPEN]: 'Open: needs your decision',
      [K_DECIDED]: res.state === 'decided' && res.decision.kind === 'custom' ? 'Decided: your own value' : res.state === 'decided' && res.decision.kind === 'propagated' ? 'Decided on an identical report' : 'Decided',
      [K_MAJORITY]: 'Resolved by majority',
      [K_FLAG]: 'Flagged for discussion',
      [K_STALE]: 'Decided, but the source values changed since',
    };
    return h(
      'div',
      null,
      h('div', { class: 'tt-title' }, `Record ${record}`),
      h('div', null, field.title, field.title !== field.name ? h('span', { class: 'tt-muted' }, ` · ${field.name}`) : null),
      h('div', { class: 'tt-muted', style: { marginTop: '4px' } }, status[kind]),
      value !== null ? h('div', { class: 'ov-tt-value' }, value) : null,
      cell?.note ? h('div', { class: 'tt-muted' }, `Note: ${truncate(cell.note, 120)}`) : null,
    );
  }

  canvas.addEventListener('mousemove', (e) => {
    const c = hit(e);
    canvas.style.cursor = c ? 'pointer' : 'default';
    if (c) showTooltip({ x: e.clientX, y: e.clientY }, describe(c.record, c.field, c.kind));
    else hideTooltip();
  });
  canvas.addEventListener('mouseleave', hideTooltip);
  canvas.addEventListener('click', (e) => {
    const c = hit(e);
    if (!c) return;
    hideTooltip();
    openCell(c.record, c.field.name);
  });

  let frame = 0;
  const ro =
    typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => {
          cancelAnimationFrame(frame);
          frame = requestAnimationFrame(() => paint());
        })
      : null;
  ro?.observe(scroller);

  return {
    el,
    paint,
    destroy() {
      ro?.disconnect();
      cancelAnimationFrame(frame);
    },
  };
}

// ------------------------------------------------------------------ fields table

interface FieldRow {
  field: FieldInfo;
  category: string;
  review: number;
  open: number;
  decided: number;
  custom: number;
  conflicts: number;
  n: number;
  agree: number;
  kappa: number | null;
}

type SortKey = 'field' | 'category' | 'review' | 'open' | 'custom' | 'agreement' | 'kappa';

function fieldRows(session: Session): FieldRow[] {
  const catTitle = new Map(session.project.schema.categories.map((c) => [c.key, c.title]));
  return session.fields.map((f) => {
    let review = 0;
    let open = 0;
    let decided = 0;
    let custom = 0;
    let conflicts = 0;
    for (const r of session.project.records) {
      if (session.comparison(r, f.name).status === 'conflict') conflicts += 1;
      const d = session.cell(r, f.name)?.decision;
      if (d) {
        decided += 1;
        if (d.kind === 'custom') custom += 1;
      }
      if (session.needsReview(r, f.name)) {
        review += 1;
        if (session.resolution(r, f.name).state === 'open') open += 1;
      }
    }
    const a = fieldAgreement(session, f);
    return { field: f, category: catTitle.get(f.category) ?? f.category, review, open, decided, custom, conflicts, n: a.n, agree: a.agree, kappa: a.kappa };
  });
}

function sortValue(r: FieldRow, key: SortKey): number | string {
  switch (key) {
    case 'field':
      return r.field.order;
    case 'category':
      return r.category;
    case 'review':
      return r.review;
    case 'open':
      return r.open;
    case 'custom':
      return r.custom;
    case 'agreement':
      return r.n ? r.agree / r.n : -1;
    case 'kappa':
      return r.kappa ?? -2;
  }
}

// ------------------------------------------------------------------ view

const createOverviewView: ViewFactory = ({ session, stored }) => {
  const el = h('div', { class: 'page ov-page' });
  let dirty = true;
  let map: CellMap | null = null;
  let showAll = false;
  let sort: { key: SortKey; dir: 1 | -1 } = { key: 'open', dir: -1 };
  let rowsCache: FieldRow[] | null = null;
  const tableHost = h('div', { class: 'ov-table-host' });
  const tableActions = h('div', { class: 'ov-table-actions' });

  const visible = () => el.isConnected && !el.closest('[hidden]');
  const renderSoon = debounce(() => {
    if (visible() && dirty) renderAll();
  }, 150);
  const unsubscribe = session.subscribe((e) => {
    if (e.type === 'saving') return;
    dirty = true;
    if (visible()) renderSoon();
  });

  // ---------------------------------------------------------------- head and hero
  function head(): HTMLElement {
    const next = nextOpenCell(session);
    const action = next
      ? h('button', { type: 'button', class: 'btn btn-primary', onclick: () => openCell(next.record, next.field) }, 'Continue adjudicating', icon('arrowRight'))
      : h('button', { type: 'button', class: 'btn btn-primary', onclick: () => openExportDialog(session, stored) }, icon('download'), 'Export the consensus');
    return h(
      'div',
      { class: 'page-head' },
      h('div', null, h('h1', null, 'Overview'), h('p', null, 'How far the consensus is, where the sources disagree, and what still needs you.')),
      h('div', { class: 'ov-head-actions' }, action),
    );
  }

  function hero(): HTMLElement {
    const st = session.stats();
    const frac = st.review ? st.resolved / st.review : 1;
    let withReview = 0;
    let complete = 0;
    let stale = 0;
    for (const r of session.project.records) {
      const s = session.summary(r);
      if (s.review > 0) {
        withReview += 1;
        if (s.open === 0) complete += 1;
      }
      stale += s.stale;
    }
    let decisions = 0;
    let own = 0;
    let propagated = 0;
    for (const c of session.allCells()) {
      if (!c.decision) continue;
      decisions += 1;
      if (c.decision.kind === 'custom') own += 1;
      if (c.decision.kind === 'propagated') propagated += 1;
    }
    const p = pace(session);
    const pct = h('div', { class: 'ov-ring-label' }, h('strong', { class: 'num' }, fmtPct(frac, 0)), h('span', null, 'resolved'));
    const headline = st.review
      ? h('div', { class: 'ov-headline num' }, h('strong', null, fmtInt(st.resolved)), ` of ${plural(st.review, 'cell')} that need you are resolved`)
      : h('div', { class: 'ov-headline' }, h('strong', null, 'No conflicts'), ': the sources agree on every cell');
    const chips = h(
      'div',
      { class: 'ov-hero-chips' },
      st.open ? badge(`${fmtInt(st.open)} open`, 'warning') : badge('Nothing open', 'good', 'check'),
      st.flagged ? badge(`${fmtInt(st.flagged)} flagged`, 'serious', 'flag') : null,
      stale ? withTooltip(badge(`${fmtInt(stale)} changed since decided`, 'critical', 'alert'), 'The sources’ values changed after you decided these cells (the folder was chosen again with different files).') : null,
    );
    return h(
      'section',
      { class: 'card ov-hero' },
      h(
        'div',
        { class: 'ov-hero-top' },
        h('div', { class: 'ov-ring' }, ring(frac, 96, 9), pct),
        h(
          'div',
          { class: 'ov-hero-text' },
          headline,
          h(
            'div',
            { class: 'ov-hero-sub' },
            `${plural(session.project.records.length, 'record')} · ${plural(session.fields.length, 'field')} · ${plural(session.project.sources.length, 'abstraction')}`,
          ),
          chips,
        ),
      ),
      h(
        'div',
        { class: 'ov-stats' },
        stat(
          'Records complete',
          withReview ? [fmtInt(complete), h('span', { class: 'ov-stat-of' }, ` / ${fmtInt(withReview)}`)] : '—',
          withReview ? 'of the records with conflicts' : 'No record has conflicts',
        ),
        stat('Decisions', fmtInt(decisions), decisions ? [`${fmtInt(own)} own value${own === 1 ? '' : 's'}`, propagated ? ` · ${fmtInt(propagated)} on identical reports` : null] : 'None yet'),
        stat('Active time', p.totalMs ? fmtDuration(p.totalMs / 1000) : '—', 'Pauses over 3 minutes do not count'),
        stat(
          'Median per decision',
          p.medianMs !== null ? fmtDuration(p.medianMs / 1000) : '—',
          p.timed ? `over ${plural(p.timed, 'timed decision')}` : 'After your first decisions',
        ),
        stat(
          'Estimated time left',
          p.remainingMs !== null ? fmtDuration(p.remainingMs / 1000) : st.open ? '—' : 'Done',
          p.remainingMs !== null ? `${plural(st.open, 'open cell')} at your median pace` : st.open ? 'After a few more decisions' : 'Nothing left to decide',
        ),
      ),
    );
  }

  // ---------------------------------------------------------------- fields
  function paintTable() {
    const all = (rowsCache ??= fieldRows(session));
    const active = all.filter((r) => r.review > 0 || r.conflicts > 0 || r.decided > 0);
    const rows = showAll ? all : active;
    const dir = sort.dir;
    rows.sort((a, b) => {
      const va = sortValue(a, sort.key);
      const vb = sortValue(b, sort.key);
      const c = typeof va === 'string' || typeof vb === 'string' ? String(va).localeCompare(String(vb)) : va - vb;
      return c * dir || b.review - a.review || a.field.order - b.field.order;
    });
    render(
      tableActions,
      all.length > active.length
        ? h(
            'label',
            { class: 'checkbox' },
            h('input', {
              type: 'checkbox',
              checked: showAll,
              onchange: (e: Event) => {
                showAll = (e.target as HTMLInputElement).checked;
                paintTable();
              },
            }),
            `Show all ${fmtInt(all.length)} fields`,
          )
        : null,
    );
    if (!rows.length) {
      render(tableHost, emptyState({ icon: 'checkCircle', title: 'No field has conflicts.', body: 'The sources agree on every cell.' }));
      return;
    }
    const th = (key: SortKey, label: Child, cls?: string, tip?: string) => {
      const cell = h(
        'th',
        {
          class: cls,
          'data-sort': key,
          'aria-sort': sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined,
          tabIndex: 0,
          title: tip,
        },
        label,
      );
      const act = () => {
        sort = sort.key === key ? { key, dir: sort.dir === 1 ? -1 : 1 } : { key, dir: key === 'field' || key === 'category' ? 1 : -1 };
        paintTable();
        (tableHost.querySelector(`th[data-sort="${key}"]`) as HTMLElement | null)?.focus();
      };
      cell.addEventListener('click', act);
      cell.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          act();
        }
      });
      return cell;
    };
    const k = session.project.sources.length;
    const go = (r: FieldRow) => {
      const name = r.field.name;
      const recs = session.project.records;
      const target = recs.find((rec) => session.isOpen(rec, name)) ?? recs.find((rec) => session.needsReview(rec, name)) ?? recs.find((rec) => session.comparison(rec, name).status === 'conflict');
      if (target) openCell(target, name);
      else navigate('dictionary', [name]);
    };
    const body = rows.map((r) => {
      const done = r.review - r.open;
      const tr = h(
        'tr',
        { class: 'ov-row', tabIndex: 0, title: r.open ? `Open the next open ${r.field.name} cell` : `Open ${r.field.name}` },
        h('td', null, h('div', { class: 'ov-field' }, h('span', { class: 'ov-field-title' }, r.field.title), r.field.title !== r.field.name ? h('code', null, r.field.name) : null)),
        h('td', { class: 'muted ov-cat' }, r.category),
        h('td', { class: 'num' }, r.review ? fmtInt(r.review) : h('span', { class: 'muted' }, '0')),
        h(
          'td',
          { class: 'num ov-progress-cell' },
          r.review
            ? h(
                'div',
                { class: 'ov-progress' },
                h('span', { class: 'ov-bar', 'aria-hidden': 'true' }, h('span', { style: { width: `${(done / r.review) * 100}%` } })),
                r.open ? h('span', { class: 'ov-open num' }, fmtInt(r.open)) : h('span', { class: 'ov-done' }, icon('check')),
              )
            : h('span', { class: 'muted' }, '—'),
        ),
        h('td', { class: 'num' }, r.custom ? fmtInt(r.custom) : h('span', { class: 'muted' }, '0')),
        h('td', { class: 'num', title: r.n ? `All ${k} sources agree in ${fmtInt(r.agree)} of ${plural(r.n, 'record')} where each has a value` : undefined }, r.n ? fmtPct(r.agree / r.n, 0) : '—'),
        h('td', { class: 'num' }, r.kappa === null ? h('span', { class: 'muted' }, '—') : fmtMetric(r.kappa, 2)),
      );
      tr.addEventListener('click', () => go(r));
      tr.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') go(r);
      });
      return tr;
    });
    render(
      tableHost,
      h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          { class: 'tbl ov-table' },
          h(
            'thead',
            null,
            h(
              'tr',
              null,
              th('field', 'Field'),
              th('category', 'Section'),
              th('review', 'To review', 'num', 'Cells that need you: conflicts, invalid values and missing required values'),
              th('open', 'Open', 'num', 'Cells still without a consensus value'),
              th('custom', 'Own values', 'num', 'Decisions on a value no source gave'),
              th('agreement', 'Agreement', 'num', 'Records where every source gave the same value'),
              th('kappa', 'κ', 'num ov-kappa', k === 2 ? 'Cohen’s kappa between the two sources (categorical fields)' : 'Fleiss’ kappa among the sources (categorical fields)'),
            ),
          ),
          h('tbody', null, body),
        ),
      ),
    );
  }

  // ---------------------------------------------------------------- attention
  function attention(): HTMLElement {
    type Item = { record: RecordKey; field?: string; title: Child; detail?: Child };
    const flagged: Item[] = [];
    const notes: Item[] = [];
    const violations: Item[] = [];
    const stale: Item[] = [];
    const fieldTitle = (name: string) => session.field(name)?.title ?? name;
    const pos = new Map(session.project.records.map((r, i) => [r, i]));
    const cells = session.allCells().sort((a, b) => (pos.get(a.record) ?? 0) - (pos.get(b.record) ?? 0) || (session.field(a.field)?.order ?? 0) - (session.field(b.field)?.order ?? 0));
    for (const c of cells) {
      if (c.flag) flagged.push({ record: c.record, field: c.field, title: fieldTitle(c.field), detail: c.note ? truncate(c.note, 140) : undefined });
      if (c.note) notes.push({ record: c.record, field: c.field, title: fieldTitle(c.field), detail: truncate(c.note, 140) });
    }
    for (const r of session.project.records) {
      const s = session.summary(r);
      if (s.violations) {
        for (const v of session.violations(r)) {
          violations.push({ record: r, field: v.fields[0] ?? v.rule.thenFields[0], title: `Rule ${v.rule.number}`, detail: v.rule.comment ? truncate(v.rule.comment, 140) : v.fields.join(', ') });
        }
      }
      if (s.stale) {
        for (const f of session.fields) if (session.isStale(r, f.name)) stale.push({ record: r, field: f.name, title: f.title, detail: 'The sources’ values changed after you decided.' });
      }
    }
    const list = (title: string, iconName: 'flag' | 'note' | 'alert' | 'history', items: Item[], empty: string) => ({ title, iconName, items, empty });
    const lists = [
      list('Flagged', 'flag', flagged, 'nothing flagged'),
      list('Notes', 'note', notes, 'no notes'),
      list('Rule violations', 'alert', violations, 'no rule violations'),
      list('Changed since decided', 'history', stale, 'no decisions on changed values'),
    ];
    const shown = lists.filter((l) => l.items.length);
    const clean = lists.filter((l) => !l.items.length).map((l) => l.empty);
    const cap = 40;
    return card(
      'Needs attention',
      'Flags, notes, cross-field rules the consensus breaks, and decisions whose source values changed.',
      [
        shown.length
          ? h(
              'div',
              { class: 'ov-lists' },
              shown.map((l) =>
                h(
                  'div',
                  { class: 'ov-list' },
                  h('h3', null, icon(l.iconName), l.title, h('span', { class: 'ov-list-count num' }, fmtInt(l.items.length))),
                  h(
                    'ul',
                    null,
                    l.items.slice(0, cap).map((it) =>
                      h(
                        'li',
                        null,
                        h(
                          'button',
                          { type: 'button', class: 'ov-item', onclick: () => openCell(it.record, it.field) },
                          h('span', { class: 'ov-item-head' }, h('span', { class: 'ov-item-rec num' }, `Record ${it.record}`), h('span', { class: 'ov-item-title' }, it.title)),
                          it.detail ? h('span', { class: 'ov-item-detail' }, it.detail) : null,
                        ),
                      ),
                    ),
                  ),
                  l.items.length > cap ? h('div', { class: 'ov-list-more muted' }, `+${fmtInt(l.items.length - cap)} more`) : null,
                ),
              ),
            )
          : null,
        clean.length
          ? h('p', { class: 'ov-clean' }, icon('checkCircle'), shown.length ? `Also: ${clean.join(', ')}.` : `${clean.join(', ').replace(/^./, (c) => c.toUpperCase())}.`)
          : null,
      ],
    );
  }

  // ---------------------------------------------------------------- agreement
  function agreement(): HTMLElement {
    if (session.settings.blind) {
      return card(
        'Agreement between the sources',
        null,
        h(
          'div',
          { class: 'ov-locked' },
          icon('lock'),
          h('strong', null, 'Hidden during blind review'),
          h('p', null, 'How often each abstraction matches the consensus would show which one tends to win, which can sway the decisions still to make.'),
          h('button', { type: 'button', class: 'btn btn-sm', onclick: () => void toggleBlind(session) }, icon('eye'), 'Reveal sources…'),
        ),
      );
    }
    const scores = sourceScores(session);
    const pairs = pairwiseAgreement(session);
    const best = (vals: (number | null)[]) => Math.max(...vals.map((v) => v ?? -1));
    const rates = scores.map((s) => (s.n ? s.match / s.n : null));
    const reviewRates = scores.map((s) => (s.reviewN ? s.reviewMatch / s.reviewN : null));
    const bestRate = best(rates);
    const bestReview = best(reviewRates);
    const pct = (v: number | null, num: number, den: number, isBest: boolean) =>
      h('td', { class: ['num', isBest && scores.length > 1 && 'best'], title: den ? `${fmtInt(num)} of ${fmtInt(den)}` : undefined }, v === null ? '—' : fmtPct(v, 1));
    return card(
      'Agreement between the sources',
      'Uses the same comparison as the conflicts (whitespace, and the text options in Settings). Cells still open are left out.',
      h(
        'div',
        { class: 'ov-agree' },
        h(
          'div',
          null,
          h('h3', { class: 'ov-subhead' }, 'Each source against the consensus'),
          h(
            'div',
            { class: 'table-wrap' },
            h(
              'table',
              { class: 'tbl' },
              h('thead', null, h('tr', null, h('th', null, 'Source'), h('th', { class: 'num' }, 'Cells'), h('th', { class: 'num' }, 'Matches'), h('th', { class: 'num', title: 'On the cells that needed review' }, 'On conflicts'))),
              h(
                'tbody',
                null,
                scores.map((s, i) =>
                  h(
                    'tr',
                    null,
                    h(
                      'td',
                      null,
                      h(
                        'div',
                        { class: 'ov-source', title: session.project.sources[s.source]?.path },
                        h('strong', null, session.sourceLabel(s.source)),
                        h('code', null, session.project.sources[s.source]?.fileName ?? ''),
                      ),
                    ),
                    h('td', { class: 'num' }, fmtInt(s.n)),
                    pct(rates[i]!, s.match, s.n, rates[i] === bestRate),
                    pct(reviewRates[i]!, s.reviewMatch, s.reviewN, reviewRates[i] === bestReview),
                  ),
                ),
              ),
            ),
          ),
        ),
        pairs.length
          ? h(
              'div',
              null,
              h('h3', { class: 'ov-subhead' }, 'Between sources'),
              h(
                'div',
                { class: 'table-wrap' },
                h(
                  'table',
                  { class: 'tbl' },
                  h('thead', null, h('tr', null, h('th', null, 'Pair'), h('th', { class: 'num' }, 'Cells'), h('th', { class: 'num' }, 'Agree'))),
                  h(
                    'tbody',
                    null,
                    pairs.map((p) =>
                      h(
                        'tr',
                        null,
                        h('td', null, `${session.sourceLabel(p.a)} · ${session.sourceLabel(p.b)}`),
                        h('td', { class: 'num' }, fmtInt(p.n)),
                        h('td', { class: 'num', title: `${fmtInt(p.agree)} of ${fmtInt(p.n)}` }, p.n ? fmtPct(p.agree / p.n, 1) : '—'),
                      ),
                    ),
                  ),
                ),
              ),
            )
          : null,
      ),
    );
  }

  // ---------------------------------------------------------------- setup details
  function details(st: StoredSession): HTMLElement {
    const s = session.settings;
    const { project } = session;
    const textRule = s.textIgnoreCase && s.textIgnoreOrder ? 'Ignore letter case and snippet order' : s.textIgnoreCase ? 'Ignore letter case' : s.textIgnoreOrder ? 'Ignore snippet order' : 'Exact (whitespace aside)';
    const scenario = s.scenario === 'experts' ? 'Several experts’ gold standards' : s.scenario === 'automated' ? 'Human vs. automated abstraction' : 'Other comparison';
    const row = (k: string, v: Child) => [h('dt', null, k), h('dd', null, v)];
    const log = session.meta.blindLog.slice(-8).reverse();
    return card(
      'Session',
      null,
      h(
        'div',
        { class: 'ov-details' },
        h(
          'dl',
          { class: 'ov-dl' },
          row('Folder', st.folderName),
          row('Created', dateTime(project.createdAt || st.createdAt)),
          row('Schema', [project.schema.title, ' · ', h('code', null, project.schema.path)]),
          row('Key field', h('code', null, project.keyField)),
          row('Records', `${fmtInt(project.records.length)} (${fmtInt(project.reports.size)} with a report)`),
          row('Scenario', scenario),
          row(
            'Abstractions',
            h(
              'ul',
              { class: 'ov-sources' },
              project.sources.map((src, i) =>
                h('li', null, h('strong', null, session.sourceLabel(i)), h('span', null, h('code', null, src.path), h('span', { class: 'muted' }, ` · ${plural(src.records.size, 'record')}`))),
              ),
            ),
          ),
          row('Files', st.filesStored ? 'Kept in this browser' : 'Not kept: choose the folder again to resume'),
        ),
        h(
          'dl',
          { class: 'ov-dl' },
          row('Blind review', s.blind ? 'On' : 'Off'),
          row('Text comparison', textRule),
          row('One-source values', s.singleSource === 'accept' ? 'Accepted as is' : 'Reviewed'),
          project.sources.length >= 3 ? row('Majority', s.majority ? `Auto-accept a value ${s.majority} or more sources share` : 'Off') : null,
          row('Identical reports', s.propagate ? 'Decisions apply to all' : 'Decided one by one'),
          row('After a decision', s.autoAdvance ? 'Move to the next open field' : 'Stay'),
          row(
            'Blind history',
            log.length
              ? h('ul', { class: 'ov-log' }, log.map((b) => h('li', null, h('span', { class: ['ov-log-dot', b.blind && 'on'] }), b.blind ? 'Blind on' : 'Sources shown', h('span', { class: 'muted' }, ` · ${dateTime(b.at)}`))))
              : h('span', { class: 'muted' }, 'No changes'),
          ),
        ),
      ),
    );
  }

  // ---------------------------------------------------------------- layout
  function renderAll() {
    dirty = false;
    rowsCache = null;
    map?.destroy();
    map = cellMap(session);
    const legend = h(
      'div',
      { class: 'legend ov-legend' },
      h('span', { class: 'legend-item' }, h('span', { class: 'ov-swatch', style: { background: 'var(--st-open)' } }), 'Open'),
      h('span', { class: 'legend-item' }, h('span', { class: 'ov-swatch', style: { background: 'var(--st-done)' } }), 'Decided'),
      session.settings.majority ? h('span', { class: 'legend-item' }, h('span', { class: 'ov-swatch', style: { background: 'var(--st-done-tint)' } }), 'Majority') : null,
      h('span', { class: 'legend-item' }, h('span', { class: 'ov-swatch', style: { background: 'var(--st-agree)' } }), 'No conflict'),
      h('span', { class: 'legend-item' }, h('span', { class: 'ov-swatch', style: { background: 'var(--st-flag)' } }), 'Flagged'),
      h('span', { class: 'legend-item' }, h('span', { class: 'ov-swatch', style: { background: 'var(--st-stale)' } }), 'Changed since decided'),
    );
    render(
      el,
      head(),
      hero(),
      card('Map of the cells', 'Each column is a record and each row a field, grouped by section. Hover for details; click to open the cell.', [map.el, legend]),
      card('Fields', 'Where the sources disagree. Click a field to open its next open cell.', tableHost, tableActions),
      attention(),
      h('div', { class: 'grid-2 ov-bottom' }, agreement(), details(stored)),
    );
    paintTable();
    requestAnimationFrame(() => map?.paint());
  }

  return {
    el,
    update(_state, changed) {
      if (dirty) renderAll();
      else if (changed.has('mode') || changed.has('route')) map?.paint();
    },
    destroy() {
      unsubscribe();
      map?.destroy();
      hideTooltip();
    },
  };
};

export default createOverviewView;

/** For tests. */
export const _internal = { fieldRows, cellKind };
