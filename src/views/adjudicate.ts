/**
 * Adjudicate: one record at a time, the report on the left and the cells
 * that need the adjudicator on the right. Keyboard first: 1–9 picks a value,
 * j/k moves between fields, n/p between records; after a decision the next
 * open cell takes focus. A strip of all records (the minimap) and a strip of
 * the record's fields show where the work is.
 */

import type { Session } from '../core/session';
import { TextIndex } from '../core/snippets';
import { fieldTerms } from '../core/terms';
import type { FieldInfo, Json, RecordKey } from '../core/types';
import { navigate, prefs, type Route } from '../state';
import { dialogOpen, hideTooltip, isTyping, openDialog, toast, withTooltip } from '../ui/components';
import { h, render, type Child } from '../ui/dom';
import { fmtInt, plural } from '../ui/format';
import { icon } from '../ui/icons';
import { fieldCard, highlightGroups, resolvedValue, type CardHandlers } from './adjudicate/cards';
import { createEditor, type Editor } from './adjudicate/editor';
import { createMinimap } from './adjudicate/minimap';
import {
  cardFields,
  FILTERS,
  initialRecord,
  matches,
  nextOpen,
  recordList,
  scopeFields,
  scopeLabel,
  stepRecord,
  type FieldScope,
  type RecordFilter,
} from './adjudicate/nav';
import { candidateKind, createReportPane, highlightsSupported, type SnippetGroup } from './adjudicate/report';
import type { ViewFactory } from './types';

const SPLIT_MIN = 26;
const SPLIT_MAX = 70;

/** The shared rules of the dictionary (its top-level description), in a dialog. */
export function openSharedRules(session: Session): void {
  const schema = session.project.schema;
  const paras = schema.description.split(/\n+/).map((p) => p.trim()).filter(Boolean);
  openDialog({
    title: 'Shared rules',
    wide: true,
    body: h(
      'div',
      { class: 'shared-rules' },
      h('p', { class: 'muted' }, `From the data dictionary: ${schema.title}`),
      paras.map((p) => (/^[•\-*·]\s/.test(p) ? h('p', { class: 'bullet' }, p.replace(/^[•\-*·]\s*/, '')) : h('p', null, p))),
    ),
  });
}

const factory: ViewFactory = ({ session }) => {
  // ------------------------------------------------------------------ state
  let record: RecordKey | null = null;
  let focus: string | null = null;
  let filter: RecordFilter = (FILTERS.some((f) => f.value === prefs.get('filter')) ? prefs.get('filter') : 'open') as RecordFilter;
  let scope: FieldScope = '';
  let showAgreed = prefs.get('showAgreed') === '1';
  const promoted = new Set<string>();
  let expanded: string | null = null;
  let editing: { field: string; editor: Editor } | null = null;
  let noteEditing: string | null = null;
  let index: TextIndex | null = null;
  let order: string[] = [];
  let suspended = false;
  let completeFocus = false;
  let picker: { close(): void } | null = null;

  const fieldsInScope = () => scopeFields(session, scope);
  const field = (name: string): FieldInfo => session.field(name)!;

  // --------------------------------------------------------------- elements
  const report = createReportPane();
  const minimap = createMinimap(session, (r) => goRecord(r));

  const prevBtn = withTooltip(h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Previous record' }, icon('chevronLeft')), 'Previous record (p)');
  const nextBtn = withTooltip(h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Next record' }, icon('chevronRight')), 'Next record (n)');
  const recordBtn = withTooltip(h('button', { type: 'button', class: 'record-btn', 'aria-haspopup': 'dialog' }), 'Go to a record (g)');
  const position = h('span', { class: 'record-pos num' });
  const filterSel = h('select', { class: 'select inline-select', 'aria-label': 'Records to go through' });
  const scopeSel = h('select', { class: 'select inline-select scope-select', 'aria-label': 'Fields to work on' });
  prevBtn.addEventListener('click', () => step(-1));
  nextBtn.addEventListener('click', () => step(1));
  recordBtn.addEventListener('click', () => openPicker());

  const bar = h(
    'div',
    { class: 'adj-bar' },
    h('div', { class: 'record-nav' }, prevBtn, recordBtn, nextBtn, position),
    minimap.el,
    h('div', { class: 'adj-filters' }, h('label', { class: 'filter-label' }, icon('filter'), filterSel), scopeSel),
  );

  const head = h('div', { class: 'dec-head' });
  const list = h('div', { class: 'dec-list' });
  const agreedBox = h('div', { class: 'agreed' });
  const scrollBox = h('div', { class: 'dec-scroll' }, list, agreedBox);
  const decisions = h('section', { class: 'decision-pane', 'aria-label': 'Cells to decide' }, head, scrollBox);
  const split = h('div', { class: 'adj-split', role: 'separator', 'aria-orientation': 'vertical', 'aria-label': 'Resize the report', tabIndex: 0 });
  const bodyEl = h('div', { class: 'adj-body' }, report.el, split, decisions);
  const el = h('div', { class: 'adj' }, bar, bodyEl);
  const saved = Number(prefs.get('split'));
  if (saved >= SPLIT_MIN && saved <= SPLIT_MAX) bodyEl.style.setProperty('--report-w', `${saved}%`);
  if (!highlightsSupported()) {
    report.el.appendChild(h('div', { class: 'report-note' }, 'This browser cannot highlight snippets in the report (it lacks the CSS Custom Highlight API). Everything else works.'));
  }

  const visible = () => el.isConnected && !el.closest('[hidden]');

  // ------------------------------------------------------------- mutations
  /** Run session changes, then paint once. */
  function mutate(fn: () => void) {
    suspended = true;
    try {
      fn();
    } finally {
      suspended = false;
    }
    refreshOrder();
    paint();
  }

  function refreshOrder() {
    if (record === null) {
      order = [];
      return;
    }
    order = cardFields(session, record, fieldsInScope(), promoted);
  }

  /** Review and open cells of the current record within the field scope. */
  function counts(): { review: number; open: number } {
    if (record === null) return { review: 0, open: 0 };
    const fields = fieldsInScope();
    if (!fields) {
      const s = session.summary(record);
      return { review: s.review, open: s.open };
    }
    let review = 0;
    let open = 0;
    for (const f of fields) {
      if (!session.needsReview(record, f)) continue;
      review += 1;
      if (session.isOpen(record, f)) open += 1;
    }
    return { review, open };
  }

  function decide(f: string, value: Json) {
    if (record === null) return;
    // Deciding an open cell moves on (when auto-advance is on); changing a resolved one stays put.
    const wasOpen = session.isOpen(record, f);
    mutate(() => {
      session.decide(record!, f, value);
      if (editing?.field === f) editing = null;
      if (expanded === f) expanded = null;
      if (wasOpen && session.settings.autoAdvance) {
        const next = nextOpen(session, record!, order, f);
        if (next) setFocus(next);
        else if (counts().open === 0) {
          setFocus(null);
          completeFocus = true;
        } else setFocus(f);
      } else setFocus(f);
    });
    if (focus) scrollToCard(focus);
    updateReport(false);
    if (completeFocus) {
      completeFocus = false;
      requestAnimationFrame(() => (list.querySelector('.complete-banner .btn-primary') as HTMLElement | null)?.focus({ preventScroll: true }));
      list.closest('.dec-scroll')?.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }

  function clear(f: string) {
    if (record === null) return;
    mutate(() => {
      session.clearDecision(record!, f);
      expanded = null;
      setFocus(f);
    });
    updateReport(false);
  }

  function undo() {
    const r = session.undo();
    if (!r) {
      toast('Nothing to undo.');
      return;
    }
    const what = r.label === 'decision' ? 'decision' : r.label === 'clear' ? 'clearing' : r.label;
    toast(`Undone: ${what} on ${session.field(r.field)?.title ?? r.field}${r.record !== record ? ` (record ${r.record})` : ''}.`);
    if (r.record !== record) goRecord(r.record, r.field);
    else {
      refreshOrder();
      setFocus(r.field);
      paint();
      scrollToCard(r.field);
      updateReport(false);
    }
  }

  // ------------------------------------------------------------- focusing
  function setFocus(f: string | null) {
    if (f && record !== null && !order.includes(f)) {
      promoted.add(f);
      refreshOrder();
    }
    if (focus !== f) {
      if (editing && editing.field !== f) editing = null;
      if (noteEditing && noteEditing !== f) noteEditing = null;
      if (expanded && expanded !== f) expanded = null;
    }
    focus = f;
    if (record !== null) session.focus(record, f);
  }

  function focusField(f: string | null, opts: { scroll?: boolean } = {}) {
    setFocus(f);
    paint();
    if (f && opts.scroll !== false) scrollToCard(f);
    updateReport(true);
  }

  function scrollToCard(f: string) {
    requestAnimationFrame(() => {
      const card = list.querySelector<HTMLElement>(`[data-field="${CSS.escape(f)}"]`);
      if (!card) return;
      card.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      const active = document.activeElement as HTMLElement | null;
      const typingNow = !!active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT' || active.isContentEditable);
      if (!typingNow) card.focus({ preventScroll: true });
    });
  }

  function moveField(dir: 1 | -1) {
    if (!order.length) return;
    const i = focus ? order.indexOf(focus) : -1;
    const j = i < 0 ? (dir > 0 ? 0 : order.length - 1) : Math.max(0, Math.min(order.length - 1, i + dir));
    focusField(order[j]!);
  }

  // ------------------------------------------------------------ navigation
  function goRecord(r: RecordKey, f?: string) {
    navigate('adjudicate', [r], f ? { field: f } : {});
  }

  function step(dir: 1 | -1) {
    if (record === null) return;
    const next = stepRecord(session, record, dir, filter, fieldsInScope());
    if (!next) {
      const label = FILTERS.find((x) => x.value === filter)!.label.toLowerCase();
      toast(filter === 'open' ? 'No other record has open conflicts here. Everything else is resolved.' : `No other record in “${label}”.`);
      return;
    }
    if (next.wrapped) toast(dir > 0 ? 'Back to the first record.' : 'Jumped to the last record.');
    goRecord(next.record);
  }

  function showRecord(r: RecordKey, f?: string) {
    record = r;
    promoted.clear();
    expanded = null;
    editing = null;
    noteEditing = null;
    picker?.close();
    hideTooltip();
    const doc = session.project.reports.get(r);
    report.show(doc, r, session.project.twins.get(r) ?? []);
    index = report.text ? new TextIndex(report.text) : null;
    refreshOrder();
    const target = f && session.field(f) ? f : nextOpen(session, r, order, null) ?? null;
    setFocus(target);
    paint();
    list.closest('.dec-scroll')?.scrollTo({ top: 0 });
    if (target) scrollToCard(target);
    updateReport(true);
  }

  function handleRoute(route: Route) {
    const r = route.path[0];
    const f = route.query.get('field') ?? undefined;
    if (!r) {
      const init = initialRecord(session);
      if (init !== null) navigate('adjudicate', [init], f ? { field: f } : {}, true);
      else paintEmpty();
      return;
    }
    if (!session.project.records.includes(r)) {
      toast(`There is no record ${r}.`);
      const init = initialRecord(session);
      if (init !== null) navigate('adjudicate', [init], {}, true);
      return;
    }
    if (r !== record) showRecord(r, f);
    else if (f && f !== focus) focusField(f);
  }

  // ---------------------------------------------------------------- paint
  function paint() {
    paintBar();
    paintDecisions();
  }

  function paintEmpty() {
    render(head);
    render(list, h('div', { class: 'empty' }, h('strong', null, 'No records.'), 'The abstractions have no records to adjudicate.'));
  }

  function paintBar() {
    if (record === null) return;
    const fields = fieldsInScope();
    const inList = recordList(session, filter, fields);
    const i = inList.indexOf(record);
    render(recordBtn, h('span', { class: 'record-label' }, 'Record'), h('strong', { class: 'num' }, record), icon('chevronDown'));
    const fl = FILTERS.find((x) => x.value === filter)!;
    render(position, inList.length ? (i >= 0 ? `${fmtInt(i + 1)} of ${fmtInt(inList.length)}` : `${fmtInt(inList.length)} in list`) : 'none in list');
    position.title = `${fl.label}${scope ? ` · ${scopeLabel(session, scope)}` : ''}`;
    const others = inList.filter((x) => x !== record).length;
    prevBtn.disabled = others === 0;
    nextBtn.disabled = others === 0;
    if (document.activeElement !== filterSel && document.activeElement !== scopeSel) paintFilterOptions(false);
    minimap.paint(record, filter === 'all' ? undefined : (x) => matches(session, x, filter, fields));
  }

  function paintFilterOptions(withCounts: boolean) {
    const fields = fieldsInScope();
    render(
      filterSel,
      FILTERS.map((f) =>
        h(
          'option',
          { value: f.value, selected: f.value === filter, title: f.hint },
          withCounts ? `${f.label} (${fmtInt(recordList(session, f.value, fields).length)})` : f.label,
        ),
      ),
    );
    const cats = session.project.schema.categories.filter((c) => c.fields.length);
    const openIn = (names: string[]) => (withCounts ? session.project.records.reduce((n, r) => n + names.filter((f) => session.isOpen(r, f)).length, 0) : null);
    const label = (text: string, n: number | null) => (n === null ? text : `${text} (${fmtInt(n)} open)`);
    render(
      scopeSel,
      h('option', { value: '', selected: !scope }, 'All fields'),
      cats.length > 1
        ? h(
            'optgroup',
            { label: 'Groups' },
            cats.map((c) => h('option', { value: `cat:${c.key}`, selected: scope === `cat:${c.key}` }, label(c.title, openIn(c.fields)))),
          )
        : null,
      h(
        'optgroup',
        { label: 'One field at a time' },
        session.fields.map((f) => h('option', { value: `field:${f.name}`, selected: scope === `field:${f.name}` }, label(f.title, openIn([f.name])))),
      ),
    );
  }

  filterSel.addEventListener('focus', () => paintFilterOptions(true));
  scopeSel.addEventListener('focus', () => paintFilterOptions(true));
  filterSel.addEventListener('mousedown', () => {
    if (document.activeElement !== filterSel) paintFilterOptions(true);
  });
  scopeSel.addEventListener('mousedown', () => {
    if (document.activeElement !== scopeSel) paintFilterOptions(true);
  });
  filterSel.addEventListener('change', () => {
    filter = filterSel.value as RecordFilter;
    prefs.set('filter', filter);
    filterSel.blur();
    afterFilterChange();
  });
  scopeSel.addEventListener('change', () => {
    scope = scopeSel.value;
    scopeSel.blur();
    afterFilterChange();
  });

  function afterFilterChange() {
    if (record === null) return;
    const fields = fieldsInScope();
    refreshOrder();
    if (!matches(session, record, filter, fields)) {
      const next = stepRecord(session, record, 1, filter, fields);
      if (next) {
        goRecord(next.record);
        return;
      }
      toast('No record matches this filter.');
    }
    const target = focus && order.includes(focus) ? focus : nextOpen(session, record, order, null) ?? order[0] ?? null;
    focusField(target);
  }

  function handlers(): CardHandlers {
    return {
      focus: (f) => focusField(f, { scroll: false }),
      decide,
      edit: (f) => openEditor(f),
      clear,
      flag: (f) => {
        if (record === null) return;
        mutate(() => {
          session.toggleFlag(record!, f);
          setFocus(f);
        });
      },
      noteEdit: (f, on) => {
        noteEditing = on ? f : null;
        if (on) setFocus(f);
        paint();
        if (!on) scrollToCard(f);
      },
      noteSave: (f, text) => {
        if (record === null) return;
        noteEditing = null;
        mutate(() => session.setNote(record!, f, text));
        scrollToCard(f);
      },
      reconfirm: (f) => {
        if (record === null) return;
        mutate(() => session.reconfirm(record!, f));
        toast('Decision kept.');
      },
      flash: (s) => {
        if (!report.flash(s)) toast('This snippet is not in the report.');
      },
      goto: (r, f) => goRecord(r, f),
      dictionary: (f) => navigate('dictionary', [f]),
    };
  }

  function openEditor(f: string) {
    if (record === null) return;
    const fi = field(f);
    const res = session.resolution(record, f);
    let initial: Json | undefined;
    if (res.state === 'decided' || res.state === 'auto') initial = res.value;
    else if (fi.kind === 'text') {
      const best = [...session.comparison(record, f).candidates].sort((a, b) => b.sources.length - a.sources.length)[0];
      initial = best?.value;
    }
    setFocus(f);
    const editor = createEditor({
      session,
      record,
      field: fi,
      report,
      initial,
      onSubmit: (v) => decide(f, v),
      onCancel: () => {
        editing = null;
        paint();
        scrollToCard(f);
        updateReport(false);
      },
    });
    editing = { field: f, editor };
    paint();
    scrollToCard(f);
    updateReport(false);
    requestAnimationFrame(() => editor.focus());
  }

  function paintDecisions() {
    if (record === null) return;
    const r = record;
    const s = counts();
    const fields = fieldsInScope();
    const hs = handlers();

    // Header: record, counts, field strip, rule violations.
    const strip = order.length
      ? h(
          'div',
          { class: 'field-strip', role: 'list', 'aria-label': 'Fields of this record' },
          order.map((f) => {
            const open = session.isOpen(r, f);
            const res = session.resolution(r, f);
            const st = open ? 'open' : res.state === 'decided' ? 'decided' : 'auto';
            const cell = session.cell(r, f);
            return withTooltip(
              h(
                'button',
                {
                  type: 'button',
                  role: 'listitem',
                  class: ['strip-seg', st, f === focus && 'focused', cell?.flag && 'flagged'],
                  'aria-label': `${field(f).title}: ${st}`,
                  onclick: () => focusField(f),
                },
              ),
              h('div', null, h('div', { class: 'tt-title' }, field(f).title), open ? 'Open' : st === 'decided' ? 'Decided' : 'Accepted automatically', cell?.flag ? ' · flagged' : ''),
            );
          }),
        )
      : null;
    const violations = session.violations(r).filter((v) => !fields || v.rule.fields.some((f) => fields.has(f)));
    const agreedCount = agreedTotal();
    const scopeNote = scope ? h('span', { class: 'scope-note' }, icon('filter'), scopeLabel(session, scope), h('button', { type: 'button', class: 'link-btn', onclick: () => resetScope() }, 'All fields')) : null;
    render(
      head,
      h(
        'div',
        { class: 'dec-title' },
        h('h2', null, `Record ${r}`),
        h(
          'div',
          { class: 'dec-counts' },
          s.review ? h('span', { class: s.open ? 'open' : 'done' }, s.open ? `${fmtInt(s.open)} open` : 'Complete') : h('span', null, 'Nothing to resolve'),
          s.review && s.open < s.review ? h('span', null, `${fmtInt(s.review - s.open)} resolved`) : null,
          h('span', { class: 'muted' }, `${fmtInt(agreedCount)} agree`),
          scopeNote,
        ),
        session.project.schema.description
          ? withTooltip(h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => openSharedRules(session) }, icon('dictionary'), 'Shared rules'), 'The dictionary’s rules for every field')
          : null,
      ),
      strip,
      violations.length
        ? h(
            'div',
            { class: 'violations', role: 'status' },
            violations.map((v) =>
              h(
                'div',
                { class: 'violation' },
                icon('alert'),
                h('div', null, h('strong', null, `Rule ${v.rule.number}`), ' ', v.rule.comment || 'A cross-field rule is broken.', ' ', h('span', { class: 'violation-fields' }, v.rule.fields.map((f) => h('button', { type: 'button', class: 'field-link', onclick: () => focusField(f) }, session.field(f)?.title ?? f)))),
              ),
            ),
          )
        : null,
    );

    // Cards.
    const banner = completeBanner(s.review, s.open);
    render(
      list,
      banner,
      order.map((f) =>
        fieldCard({
          session,
          record: r,
          field: field(f),
          index,
          focused: f === focus,
          expanded: f === expanded || f === focus || promoted.has(f),
          editor: editing?.field === f ? editing.editor : null,
          noteEditing: noteEditing === f,
          handlers: hs,
        }),
      ),
    );

    // Agreed fields.
    paintAgreed(fields, agreedCount);
  }

  function completeBanner(review: number, open: number): Child {
    if (record === null) return null;
    if (!review && !order.length) {
      return h('div', { class: 'complete-banner calm' }, icon('checkCircle'), h('div', null, h('strong', null, 'The sources agree on every field of this record.'), h('span', null, 'Open the agreed fields below to check or override any of them.')), nextRecordBtn());
    }
    if (review && !open) {
      return h('div', { class: 'complete-banner' }, icon('checkCircle'), h('div', null, h('strong', null, 'This record is complete.'), h('span', null, `${plural(review, 'cell')} resolved.`)), nextRecordBtn());
    }
    return null;
  }

  function nextRecordBtn(): HTMLElement {
    const next = record !== null ? stepRecord(session, record, 1, filter, fieldsInScope()) : null;
    return next
      ? h('button', { type: 'button', class: 'btn btn-primary btn-sm', onclick: () => goRecord(next.record) }, `Next record`, h('kbd', null, 'n'))
      : h('span', { class: 'muted' }, filter === 'open' ? 'No open conflicts left.' : 'Last record in this list.');
  }

  function agreedTotal(): number {
    const fields = fieldsInScope();
    return session.fields.filter((f) => (!fields || fields.has(f.name)) && !order.includes(f.name)).length;
  }

  function resetScope() {
    scope = '';
    afterFilterChange();
  }

  function paintAgreed(fields: Set<string> | null, count: number) {
    if (record === null) return;
    const r = record;
    if (!count) {
      render(agreedBox);
      return;
    }
    const open = showAgreed || (!order.length && count > 0);
    const toggle = h(
      'button',
      {
        type: 'button',
        class: 'agreed-toggle',
        'aria-expanded': String(open),
        onclick: () => {
          showAgreed = !open;
          prefs.set('showAgreed', showAgreed ? '1' : '0');
          paintAgreed(fieldsInScope(), count);
        },
      },
      icon(open ? 'chevronDown' : 'chevronRight'),
      h('span', null, `${plural(count, 'field')} ${count === 1 ? 'agrees' : 'agree'} or ${count === 1 ? 'was' : 'were'} accepted`),
      h('kbd', null, 'a'),
    );
    if (!open) {
      render(agreedBox, toggle);
      return;
    }
    const groups = session.project.schema.categories
      .map((c) => ({ c, fields: c.fields.filter((f) => (!fields || fields.has(f)) && !order.includes(f) && session.field(f)) }))
      .filter((g) => g.fields.length);
    const showCats = groups.length > 1;
    render(
      agreedBox,
      toggle,
      h(
        'div',
        { class: 'agreed-list' },
        groups.map((g) => [
          showCats ? h('div', { class: 'agreed-cat' }, g.c.title) : null,
          g.fields.map((f) => {
            const fi = field(f);
            const res = session.resolution(r, f);
            return h(
              'div',
              { class: ['agreed-row', f === focus && 'focused'], dataset: { agreed: f } },
              h('button', { type: 'button', class: 'agreed-name', onclick: () => peek(f), title: 'Show its evidence in the report' }, fi.title),
              resolvedValue(session, r, fi, res),
              withTooltip(
                h('button', { type: 'button', class: 'icon-btn sm', 'aria-label': `Override ${fi.title}`, onclick: () => override(f) }, icon('pencil')),
                'Overrule the sources with your own value',
              ),
            );
          }),
        ]),
      ),
    );
  }

  /** Show an agreed field's evidence in the report without opening it. */
  function peek(f: string) {
    focus = f;
    if (record !== null) session.focus(record, f);
    paintAgreed(fieldsInScope(), agreedTotal());
    updateReport(true);
    for (const c of list.querySelectorAll('.field-card.focused')) c.classList.remove('focused');
  }

  function override(f: string) {
    promoted.add(f);
    refreshOrder();
    setFocus(f);
    openEditor(f);
  }

  // ---------------------------------------------------------------- report
  function updateReport(scroll: boolean) {
    if (record === null) return;
    if (!focus) {
      report.setTerms(null);
      report.highlight([], [], { scroll: false });
      report.setSelectionAction(null);
      return;
    }
    const f = field(focus);
    const name = focus;
    const terms = fieldTerms(f, session.meta.terms[name]);
    report.setTerms(terms, (t) => {
      session.setTerms(name, t);
      updateReport(false);
    });
    const groups: SnippetGroup[] = highlightGroups(session, record, f, index).map((g) => ({
      kind: g.kind === 'shared' ? 'shared' : candidateKind(g.kind),
      snippets: g.snippets,
    }));
    report.highlight(groups, terms.active, { scroll });
    report.setSelectionAction(
      f.kind === 'text'
        ? {
            label: editing?.field === name ? 'Add to your value' : 'Use in your value',
            run: (text) => {
              if (editing?.field !== name) openEditor(name);
              requestAnimationFrame(() => editing?.editor.addSnippet(text));
            },
          }
        : null,
    );
  }

  // ------------------------------------------------------------ record picker
  function openPicker() {
    if (picker) {
      picker.close();
      return;
    }
    const input = h('input', { class: 'input', placeholder: 'Type a record key', 'aria-label': 'Record key', spellcheck: false });
    const listEl = h('div', { class: 'picker-list', role: 'listbox' });
    const pop = h('div', { class: 'picker', role: 'dialog', 'aria-label': 'Go to a record' }, input, listEl);
    document.body.appendChild(pop);
    const rect = recordBtn.getBoundingClientRect();
    pop.style.left = `${Math.max(8, rect.left)}px`;
    pop.style.top = `${rect.bottom + 6}px`;
    let items: RecordKey[] = [];
    let active = 0;
    const paintList = () => {
      const q = input.value.trim().toLowerCase();
      const all = session.project.records;
      const starts = q ? all.filter((x) => x.toLowerCase().startsWith(q)) : all;
      const contains = q ? all.filter((x) => !x.toLowerCase().startsWith(q) && x.toLowerCase().includes(q)) : [];
      items = [...starts, ...contains].slice(0, 400);
      active = Math.min(active, Math.max(0, items.length - 1));
      render(
        listEl,
        items.length
          ? items.map((x, i) => {
              const s = session.summary(x);
              return h(
                'button',
                {
                  type: 'button',
                  role: 'option',
                  class: ['picker-item', i === active && 'active', x === record && 'current'],
                  'aria-selected': String(i === active),
                  onclick: () => choose(x),
                },
                h('span', { class: ['status-dot', s.review === 0 ? 'agree' : s.open ? 'open' : 'done'] }),
                h('span', { class: 'num' }, x),
                h('span', { class: 'muted' }, s.review === 0 ? 'agree' : s.open ? `${fmtInt(s.open)} open` : 'complete'),
                s.flagged ? icon('flag', { class: 'picker-flag' }) : null,
              );
            })
          : h('div', { class: 'picker-empty' }, 'No record matches.'),
      );
      listEl.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
    };
    const choose = (x: RecordKey) => {
      close();
      goRecord(x);
    };
    const onDown = (e: Event) => {
      if (!pop.contains(e.target as Node) && e.target !== recordBtn && !recordBtn.contains(e.target as Node)) close();
    };
    input.addEventListener('input', () => {
      active = 0;
      paintList();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % Math.max(1, items.length);
        paintList();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const x = items[active];
        if (x !== undefined) choose(x);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    });
    setTimeout(() => document.addEventListener('pointerdown', onDown, true));
    function close() {
      pop.remove();
      document.removeEventListener('pointerdown', onDown, true);
      picker = null;
    }
    picker = { close };
    const cur = record !== null ? session.project.records.indexOf(record) : 0;
    active = Math.max(0, cur);
    paintList();
    input.focus();
  }

  // -------------------------------------------------------------- splitter
  split.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    split.setPointerCapture(e.pointerId);
    split.classList.add('dragging');
    const box = bodyEl.getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      const pct = Math.max(SPLIT_MIN, Math.min(SPLIT_MAX, ((ev.clientX - box.left) / box.width) * 100));
      bodyEl.style.setProperty('--report-w', `${pct.toFixed(1)}%`);
    };
    const up = () => {
      split.classList.remove('dragging');
      split.removeEventListener('pointermove', move);
      split.removeEventListener('pointerup', up);
      split.removeEventListener('pointercancel', up);
      const v = parseFloat(bodyEl.style.getPropertyValue('--report-w'));
      if (Number.isFinite(v)) prefs.set('split', v.toFixed(1));
    };
    split.addEventListener('pointermove', move);
    split.addEventListener('pointerup', up);
    split.addEventListener('pointercancel', up);
  });
  split.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const cur = parseFloat(bodyEl.style.getPropertyValue('--report-w')) || 46;
    const v = Math.max(SPLIT_MIN, Math.min(SPLIT_MAX, cur + (e.key === 'ArrowRight' ? 2 : -2)));
    bodyEl.style.setProperty('--report-w', `${v}%`);
    prefs.set('split', String(v));
  });

  // -------------------------------------------------------------- keyboard
  function onKey(e: KeyboardEvent) {
    if (!visible() || dialogOpen() || e.defaultPrevented || record === null) return;
    const typing = isTyping(e);
    const k = e.key;
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && k.toLowerCase() === 'z') {
      if (typing) return;
      e.preventDefault();
      undo();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey || typing) return;
    const target = e.target as HTMLElement | null;
    const onButton = !!target?.closest?.('button, a, select, [role="separator"]');
    switch (k) {
      case 'j':
        e.preventDefault();
        moveField(1);
        return;
      case 'k':
        e.preventDefault();
        moveField(-1);
        return;
      case 'n':
        e.preventDefault();
        step(1);
        return;
      case 'p':
        e.preventDefault();
        step(-1);
        return;
      case 'g':
        e.preventDefault();
        openPicker();
        return;
      case '/':
        e.preventDefault();
        report.focusSearch();
        return;
      case 'w':
        e.preventDefault();
        report.toggleReflow();
        return;
      case '+':
      case '=':
        e.preventDefault();
        report.zoom(1);
        return;
      case '-':
      case '_':
        e.preventDefault();
        report.zoom(-1);
        return;
      case 'a': {
        e.preventDefault();
        showAgreed = !showAgreed;
        prefs.set('showAgreed', showAgreed ? '1' : '0');
        paintDecisions();
        if (showAgreed) agreedBox.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        return;
      }
      case 'z':
        e.preventDefault();
        undo();
        return;
      case 'Enter': {
        if (onButton) return;
        if (counts().open === 0) {
          e.preventDefault();
          step(1);
        } else if (!focus) {
          e.preventDefault();
          focusField(nextOpen(session, record, order, null));
        }
        return;
      }
      case 'Escape':
        if (editing || noteEditing || expanded) {
          e.preventDefault();
          editing = null;
          noteEditing = null;
          expanded = null;
          paint();
          updateReport(false);
        }
        return;
    }
    if (!focus) return;
    const f = focus;
    if (/^[1-9]$/.test(k)) {
      const shown = session.displayCandidates(record, f);
      const d = shown[Number(k) - 1];
      if (d) {
        e.preventDefault();
        decide(f, d.candidate.value);
      }
      return;
    }
    switch (k) {
      case 'o':
        e.preventDefault();
        openEditor(f);
        return;
      case 'x':
        if (session.cell(record, f)?.decision) {
          e.preventDefault();
          clear(f);
        }
        return;
      case 'f':
        e.preventDefault();
        handlers().flag(f);
        return;
      case 'm':
        e.preventDefault();
        handlers().noteEdit(f, true);
        return;
    }
  }

  const onActivity = () => session.activity();
  window.addEventListener('keydown', onKey);
  window.addEventListener('pointerdown', onActivity, { passive: true });
  window.addEventListener('keydown', onActivity, { passive: true });

  // ------------------------------------------------------------ session events
  const unsubscribe = session.subscribe((e) => {
    if (e.type === 'saving' || suspended) return;
    if (record === null) return;
    if (e.type === 'cells') {
      if (e.cells.some((c) => c.record === record)) {
        refreshOrder();
        paintDecisions();
      }
      paintBar();
    } else if (e.type === 'settings') {
      refreshOrder();
      paint();
      updateReport(false);
    } else if (e.type === 'meta') {
      paintDecisions();
    }
  });

  return {
    el,
    update(state, changed) {
      if (changed.has('route')) handleRoute(state.route);
      if (changed.has('mode') || changed.has('theme')) paintBar();
    },
    destroy() {
      unsubscribe();
      picker?.close();
      report.destroy();
      minimap.destroy();
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onActivity);
      window.removeEventListener('keydown', onActivity);
    },
  };
};

export default factory;
