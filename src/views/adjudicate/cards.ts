/**
 * Field cards of the decision pane. A card shows one cell of the record:
 *  - full (open, focused or being changed): the field's definition, each
 *    candidate value with the dictionary's rule for it and who supports it
 *    (a count in blind mode), warnings (not allowed by the schema, breaks a
 *    cross-field rule, differs only trivially, changed since decided), the
 *    remaining allowed values, and the note/flag controls; text fields get a
 *    snippet-by-snippet comparison of the candidates instead;
 *  - compact (resolved, not focused): one line with the consensus value.
 * Candidates are labelled A, B, C… by display position; in blind mode that
 * position comes from a per-cell coin toss, so it says nothing about the source.
 */

import { agreementKey } from '../../core/compare';
import { diffWords } from '../../core/diff';
import type { DisplayCandidate, Session } from '../../core/session';
import { alignSnippets, splitSnippets, type TextIndex } from '../../core/snippets';
import type { FieldInfo, Json, RecordKey, Resolution } from '../../core/types';
import { displayValue } from '../../core/util';
import type { RuleViolation } from '../../core/validate';
import { withTooltip } from '../../ui/components';
import { h, type Child } from '../../ui/dom';
import { fmtDuration, plural, truncate } from '../../ui/format';
import { icon } from '../../ui/icons';
import { ago } from '../landing';
import type { Editor } from './editor';

export interface CardHandlers {
  focus(field: string): void;
  decide(field: string, value: Json): void;
  edit(field: string): void;
  clear(field: string): void;
  flag(field: string): void;
  noteEdit(field: string, open: boolean): void;
  noteSave(field: string, text: string): void;
  reconfirm(field: string): void;
  flash(snippet: string): void;
  goto(record: RecordKey, field?: string): void;
  dictionary(field: string): void;
}

export interface CardOptions {
  session: Session;
  record: RecordKey;
  field: FieldInfo;
  index: TextIndex | null;
  focused: boolean;
  /** Show the full card even when resolved. */
  expanded: boolean;
  editor: Editor | null;
  noteEditing: boolean;
  handlers: CardHandlers;
}

const candClass = (pos: number) => `cand-${(pos % 6) + 1}`;

export function letterBadge(letter: string, pos: number): HTMLElement {
  return h('span', { class: ['cand-letter', candClass(pos)] }, letter);
}

/** Who supports a candidate: a count in blind mode (only with 3+ sources), else the source names. */
function support(session: Session, sources: number[]): Child {
  const n = session.project.sources.length;
  if (session.settings.blind) return n >= 3 ? h('span', { class: 'support' }, `${sources.length} of ${n}`) : null;
  return h(
    'span',
    { class: 'support named' },
    sources.map((i) => h('span', { class: 'source-chip' }, session.sourceLabel(i))),
  );
}

function ruleBadge(violations: RuleViolation[]): Child {
  if (!violations.length) return null;
  return withTooltip(
    h('span', { class: 'warn-badge' }, icon('alert'), violations.length === 1 ? `Rule ${violations[0]!.rule.number}` : `${violations.length} rules`),
    h(
      'div',
      { class: 'tt-rule' },
      h('div', { class: 'tt-title' }, 'Choosing this breaks:'),
      violations.map((v) => h('div', null, h('strong', null, `Rule ${v.rule.number}. `), v.rule.comment || `Involves ${v.rule.fields.join(', ')}`)),
    ),
  );
}

function chosenKey(session: Session, field: FieldInfo, res: Resolution): string | null {
  return res.state === 'decided' || res.state === 'auto' ? agreementKey(field, res.value, session.settings, session.spec) : null;
}

/** The value of a resolved cell, as the compact row and the agreed list show it. */
export function resolvedValue(session: Session, record: RecordKey, field: FieldInfo, res: Resolution): HTMLElement {
  if (res.state !== 'decided' && res.state !== 'auto') return h('span', { class: 'muted' }, res.state === 'absent' ? 'no value' : 'open');
  const key = chosenKey(session, field, res);
  const shown = session.displayCandidates(record, field.name);
  const pos = shown.findIndex((d) => d.candidate.key === key);
  const d = res.state === 'decided' ? res.decision : null;
  return h(
    'span',
    { class: 'resolved-value' },
    pos >= 0 && shown.length > 1 ? letterBadge(shown[pos]!.letter, pos) : null,
    h('span', { class: 'rv-text', title: displayValue(res.value) }, truncate(displayValue(res.value), 120)),
    d?.kind === 'custom' ? h('span', { class: 'badge accent' }, 'your value') : null,
    d?.kind === 'propagated' ? h('span', { class: 'badge outline' }, `from record ${d.from}`) : null,
    res.state === 'auto' && res.reason === 'majority' ? h('span', { class: 'badge outline' }, 'majority') : null,
  );
}

// ------------------------------------------------------------------ cards

export function fieldCard(o: CardOptions): HTMLElement {
  const { session, record, field, handlers } = o;
  const cmp = session.comparison(record, field.name);
  const res = session.resolution(record, field.name);
  const cell = session.cell(record, field.name);
  const open = session.isOpen(record, field.name);
  const stale = session.isStale(record, field.name);
  const full = open || o.expanded || !!o.editor || stale;
  const state = open ? 'open' : res.state === 'decided' ? 'decided' : 'auto';

  const flagBtn = withTooltip(
    h(
      'button',
      {
        type: 'button',
        class: ['icon-btn', 'sm', 'flag-btn', cell?.flag && 'on'],
        'aria-pressed': String(!!cell?.flag),
        'aria-label': cell?.flag ? 'Remove the flag' : 'Flag for discussion',
        onclick: (e: Event) => {
          e.stopPropagation();
          handlers.flag(field.name);
        },
      },
      icon('flag'),
    ),
    cell?.flag ? 'Flagged for discussion (f)' : 'Flag for discussion (f)',
  );
  const noteBtn = withTooltip(
    h(
      'button',
      {
        type: 'button',
        class: ['icon-btn', 'sm', cell?.note && 'on'],
        'aria-label': cell?.note ? 'Edit the note' : 'Add a note',
        onclick: (e: Event) => {
          e.stopPropagation();
          handlers.noteEdit(field.name, true);
        },
      },
      icon('note'),
    ),
    cell?.note ? 'Edit the note (m)' : 'Add a note (m)',
  );

  const statusIcon =
    state === 'open'
      ? h('span', { class: 'status-dot open', 'aria-label': 'Open' })
      : h('span', { class: ['status-check', state], 'aria-label': state === 'decided' ? 'Decided' : 'Accepted automatically' }, icon('check'));

  // ------------------------------------------------------------ compact
  if (!full) {
    const row = h(
      'article',
      {
        class: ['field-card', 'compact', state, o.focused && 'focused'],
        tabIndex: -1,
        dataset: { field: field.name },
        'aria-label': `${field.title}: ${displayValue((res as { value?: Json }).value)}`,
        onclick: () => handlers.focus(field.name),
      },
      statusIcon,
      h('span', { class: 'fc-title' }, field.title),
      resolvedValue(session, record, field, res),
      h('span', { class: 'fc-icons' }, cell?.note ? icon('note', { title: 'Has a note' }) : null, cell?.flag ? flagBtn : null),
    );
    return row;
  }

  // --------------------------------------------------------------- full
  const shown = session.displayCandidates(record, field.name);
  const key = chosenKey(session, field, res);
  const decided = res.state === 'decided' ? res.decision : null;

  const head = h(
    'div',
    { class: 'fc-head' },
    statusIcon,
    h(
      'div',
      { class: 'fc-titles' },
      h('h3', { class: 'fc-title' }, field.title),
      h(
        'div',
        { class: 'fc-sub' },
        field.title !== field.name ? h('span', { class: 'mono' }, field.name) : null,
        h('span', null, session.project.schema.categories.find((c) => c.key === field.category)?.title ?? ''),
        cmp.minor ? withTooltip(h('span', { class: 'badge warning' }, 'Minor difference'), 'The values differ only in letter case, punctuation or snippet order.') : null,
      ),
    ),
    h(
      'div',
      { class: 'fc-tools' },
      withTooltip(
        h(
          'button',
          {
            type: 'button',
            class: 'icon-btn sm',
            'aria-label': 'Open in the data dictionary',
            onclick: (e: Event) => {
              e.stopPropagation();
              handlers.dictionary(field.name);
            },
          },
          icon('dictionary'),
        ),
        'Open in the data dictionary',
      ),
      noteBtn,
      flagBtn,
    ),
  );

  // Definition (clamped; expands to the full description with every label's rule).
  const def = field.definition || field.description;
  const defBox = def
    ? h(
        'div',
        { class: 'fc-def' },
        h('p', { class: 'fc-def-text' }, def),
        field.valueDocs.length || def.length > 220
          ? h(
              'button',
              {
                type: 'button',
                class: 'link-btn sm',
                onclick: (e: Event) => {
                  e.stopPropagation();
                  const box = (e.currentTarget as HTMLElement).parentElement!;
                  const isOpen = box.classList.toggle('open');
                  (e.currentTarget as HTMLElement).textContent = isOpen ? 'Less' : field.valueDocs.length ? 'All rules' : 'More';
                },
              },
              field.valueDocs.length ? 'All rules' : 'More',
            )
          : null,
        field.valueDocs.length
          ? h(
              'dl',
              { class: 'fc-rules' },
              field.valueDocs.map((d) => [h('dt', null, d.label), h('dd', null, d.rule)]),
            )
          : null,
      )
    : null;

  // Situation notes.
  const notes: Child[] = [];
  if (cmp.status === 'empty') notes.push(h('div', { class: 'fc-situation' }, icon('alertCircle'), 'No source gave a value, and the field is required.'));
  else if (cmp.status === 'single' && open) {
    const who = session.settings.blind ? 'One source' : session.sourceLabel(cmp.candidates[0]!.sources[0]!);
    notes.push(h('div', { class: 'fc-situation' }, icon('info'), `${who} gave a value; the other${session.project.sources.length > 2 ? 's' : ''} did not.`));
  } else if (cmp.status === 'agree' && open) notes.push(h('div', { class: 'fc-situation' }, icon('alertCircle'), 'The sources agree on a value the schema does not allow.'));

  if (stale) {
    notes.push(
      h(
        'div',
        { class: 'fc-stale' },
        icon('alert'),
        h('span', null, 'The abstractions changed since you decided this cell.'),
        h('button', { type: 'button', class: 'btn btn-sm', onclick: () => handlers.reconfirm(field.name) }, 'Keep my decision'),
        h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onclick: () => handlers.clear(field.name) }, 'Decide again'),
      ),
    );
  }

  const twins = res.state === 'decided' || res.state === 'auto' ? session.twinDisagreements(record, field.name) : [];
  if (twins.length) {
    notes.push(
      h(
        'div',
        { class: 'fc-twins' },
        icon('copy'),
        h('span', null, 'Same report text, different value: '),
        twins.map((t) =>
          h('button', { type: 'button', class: 'link-btn', onclick: () => handlers.goto(t.record, field.name) }, `record ${t.record}`, h('span', { class: 'muted' }, ` (${truncate(displayValue(t.value), 40)})`)),
        ),
      ),
    );
  }

  const body =
    field.kind === 'text' && shown.length
      ? textCandidates(o, shown, key)
      : categoricalCandidates(o, shown, key);

  // Allowed values no source gave (one click overrules every source).
  const others =
    (field.kind === 'categorical' || field.kind === 'boolean') && !o.editor
      ? field.domain.filter((v) => !shown.some((d) => agreementKey(field, v, session.settings, session.spec) === d.candidate.key))
      : [];
  const docs = new Map(field.valueDocs.map((d) => [d.label, d.rule]));
  const otherRow = !o.editor
    ? h(
        'div',
        { class: 'fc-other' },
        others.length ? h('span', { class: 'fc-other-label' }, 'Or') : null,
        others.map((v) => {
          const label = displayValue(v);
          const k = agreementKey(field, v, session.settings, session.spec);
          const chip = h(
            'button',
            {
              type: 'button',
              class: ['value-chip', 'sm', key === k && 'chosen'],
              onclick: (e: Event) => {
                e.stopPropagation();
                handlers.decide(field.name, v);
              },
            },
            label,
          );
          const rule = docs.get(label);
          return rule ? withTooltip(chip, h('div', { class: 'tt-rule' }, h('div', { class: 'tt-title' }, label), rule)) : chip;
        }),
        h(
          'button',
          {
            type: 'button',
            class: 'link-btn other-btn',
            onclick: (e: Event) => {
              e.stopPropagation();
              handlers.edit(field.name);
            },
          },
          o.focused ? h('kbd', null, 'o') : null,
          icon('pencil'),
          field.kind === 'text' ? 'Write your own value' : others.length ? 'Another value…' : 'Your own value…',
        ),
      )
    : null;

  // Note.
  let noteBox: Child = null;
  if (o.noteEditing) {
    const area = h('textarea', { class: 'input note-input', rows: 2, placeholder: 'Why you decided this, or what to discuss', 'aria-label': 'Note' }, cell?.note ?? '');
    area.value = cell?.note ?? '';
    const save = () => handlers.noteSave(field.name, area.value);
    area.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        save();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        handlers.noteEdit(field.name, false);
      }
    });
    noteBox = h(
      'div',
      { class: 'fc-note editing' },
      area,
      h(
        'div',
        { class: 'note-actions' },
        h('span', { class: 'muted' }, '⌘↵ to save'),
        h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => handlers.noteEdit(field.name, false) }, 'Cancel'),
        h('button', { type: 'button', class: 'btn btn-sm btn-primary', onclick: save }, 'Save note'),
      ),
    );
    setTimeout(() => area.focus(), 0);
  } else if (cell?.note) {
    noteBox = h('button', { type: 'button', class: 'fc-note', onclick: () => handlers.noteEdit(field.name, true) }, icon('note'), h('span', null, cell.note));
  }

  const foot = decided
    ? h(
        'div',
        { class: 'fc-foot' },
        h(
          'span',
          { class: 'muted' },
          decided.kind === 'propagated' ? `Copied from record ${decided.from} (identical report)` : `Decided ${ago(decided.at)}`,
          decided.ms ? ` · ${fmtDuration(decided.ms / 1000)}` : '',
          decided.blind ? ' · blind' : ' · sources shown',
        ),
        h(
          'button',
          {
            type: 'button',
            class: 'link-btn',
            onclick: (e: Event) => {
              e.stopPropagation();
              handlers.clear(field.name);
            },
          },
          o.focused ? h('kbd', null, 'x') : null,
          'Clear decision',
        ),
      )
    : res.state === 'auto' && !open
      ? h('div', { class: 'fc-foot' }, h('span', { class: 'muted' }, res.reason === 'majority' ? 'Accepted by the majority rule' : res.reason === 'single' ? 'Only one source gave a value: accepted' : 'All sources agree'))
      : null;

  return h(
    'article',
    {
      class: ['field-card', 'full', state, o.focused && 'focused', o.editor && 'editing'],
      tabIndex: -1,
      dataset: { field: field.name },
      'aria-label': field.title,
      onclick: (e: Event) => {
        if (!o.focused && !(e.target as HTMLElement).closest('button, input, textarea, a')) handlers.focus(field.name);
      },
    },
    head,
    defBox,
    notes,
    body,
    o.editor ? o.editor.el : otherRow,
    noteBox,
    foot,
  );
}

// ------------------------------------------------------------ categorical

function categoricalCandidates(o: CardOptions, shown: DisplayCandidate[], key: string | null): HTMLElement {
  const { session, record, field, handlers } = o;
  const docs = new Map(field.valueDocs.map((d) => [d.label, d.rule]));
  return h(
    'div',
    { class: 'cand-list', role: 'list' },
    shown.map((d, pos) => {
      const label = displayValue(d.candidate.value);
      const rule = docs.get(label);
      const chosen = key === d.candidate.key;
      const violations = session.violationsWith(record, field.name, d.candidate.value);
      return h(
        'button',
        {
          type: 'button',
          role: 'listitem',
          class: ['cand-row', candClass(pos), chosen && 'chosen', !d.candidate.valid && 'invalid'],
          'aria-pressed': String(chosen),
          'aria-label': `${d.letter}: ${label}`,
          onclick: (e: Event) => {
            e.stopPropagation();
            handlers.decide(field.name, d.candidate.value);
          },
        },
        h('span', { class: 'cand-key' }, o.focused && pos < 9 ? h('kbd', null, String(pos + 1)) : null),
        shown.length > 1 ? letterBadge(d.letter, pos) : null,
        h(
          'span',
          { class: 'cand-main' },
          h('span', { class: 'cand-value' }, label),
          rule ? h('span', { class: 'cand-rule' }, rule) : null,
        ),
        h(
          'span',
          { class: 'cand-side' },
          !d.candidate.valid ? h('span', { class: 'warn-badge critical' }, icon('alertCircle'), 'Not allowed') : null,
          ruleBadge(violations),
          support(session, d.candidate.sources),
          chosen ? h('span', { class: 'chosen-mark' }, icon('check')) : null,
        ),
      );
    }),
  );
}

// ------------------------------------------------------------------- text

function textCandidates(o: CardOptions, shown: DisplayCandidate[], key: string | null): HTMLElement {
  const { session, record, field, handlers, index } = o;
  const spec = session.spec;
  const isSentinel = (v: Json) => typeof v === 'string' && spec.sentinels.includes(v.trim());
  const lists = shown.map((d) => (field.multi ? splitSnippets(d.candidate.value, spec) : typeof d.candidate.value === 'string' && !isSentinel(d.candidate.value) ? [d.candidate.value] : []));
  const aligned = alignSnippets(lists, index);
  const multiCol = shown.length > 1;

  // Snippet-by-snippet comparison.
  const table =
    aligned.length && field.multi
      ? h(
          'div',
          { class: ['snip-table', multiCol && 'multi'], style: { '--cols': shown.length } },
          multiCol
            ? h(
                'div',
                { class: 'snip-row head' },
                h('span', { class: 'snip-text' }, plural(aligned.length, 'snippet')),
                shown.map((d, pos) => h('span', { class: 'snip-mark' }, letterBadge(d.letter, pos))),
              )
            : null,
          aligned.map((a) => {
            const everyone = a.members.length === shown.length;
            return h(
              'div',
              { class: ['snip-row', everyone && multiCol && 'shared'] },
              h(
                'button',
                {
                  type: 'button',
                  class: 'snip-text',
                  title: a.located ? 'Show in the report' : 'Not found in the report',
                  onclick: (e: Event) => {
                    e.stopPropagation();
                    handlers.flash(a.text);
                  },
                },
                !a.exact
                  ? withTooltip(h('span', { class: 'snip-warn' }, icon('alert')), a.located ? 'Only partly found in the report, or with other letter case' : 'Not found in the report')
                  : null,
                a.text,
              ),
              multiCol
                ? shown.map((_, pos) =>
                    h('span', { class: ['snip-mark', candClass(pos)] }, a.members.includes(pos) ? h('span', { class: 'snip-dot', 'aria-label': 'included' }) : h('span', { class: 'snip-none', 'aria-label': 'not included' })),
                  )
                : null,
            );
          }),
        )
      : null;

  // One choice per candidate.
  const choices = h(
    'div',
    { class: 'cand-list text' },
    shown.map((d, pos) => {
      const chosen = key === d.candidate.key;
      const value = d.candidate.value;
      const list = lists[pos]!;
      const missing = list.filter((s) => {
        const m = index?.locateSnippet(s).matches ?? [];
        return !m.some((x) => x.exact && !x.caseInsensitive);
      }).length;
      const violations = session.violationsWith(record, field.name, value);
      let main: Child;
      if (isSentinel(value) || !list.length) main = h('span', { class: 'cand-value' }, displayValue(value));
      else if (field.multi) main = h('span', { class: 'cand-value' }, `${plural(list.length, 'snippet')}`, h('span', { class: 'cand-preview' }, truncate(list.join(' · '), 140)));
      else if (shown.length === 2 && typeof value === 'string' && typeof shown[1 - pos]!.candidate.value === 'string') {
        const other = shown[1 - pos]!.candidate.value as string;
        const parts = pos === 0 ? diffWords(value, other) : diffWords(other, value);
        main = h(
          'span',
          { class: 'cand-value diff' },
          parts.filter((p) => p.type === 'same' || p.type === (pos === 0 ? 'del' : 'add')).map((p) => (p.type === 'same' ? p.text : h('mark', { class: 'diff-mark' }, p.text))),
        );
      } else main = h('span', { class: 'cand-value' }, displayValue(value));
      return h(
        'button',
        {
          type: 'button',
          class: ['cand-row', candClass(pos), chosen && 'chosen', !d.candidate.valid && 'invalid'],
          'aria-pressed': String(chosen),
          onclick: (e: Event) => {
            e.stopPropagation();
            handlers.decide(field.name, value);
          },
        },
        h('span', { class: 'cand-key' }, o.focused && pos < 9 ? h('kbd', null, String(pos + 1)) : null),
        shown.length > 1 ? letterBadge(d.letter, pos) : null,
        h('span', { class: 'cand-main' }, main),
        h(
          'span',
          { class: 'cand-side' },
          missing ? withTooltip(h('span', { class: 'warn-badge' }, icon('alert'), missing === list.length && list.length === 1 ? 'Not in report' : `${missing} not in report`), 'Snippets not found verbatim in the report (whitespace aside).') : null,
          !d.candidate.valid ? h('span', { class: 'warn-badge critical' }, icon('alertCircle'), 'Not allowed') : null,
          ruleBadge(violations),
          support(session, d.candidate.sources),
          chosen ? h('span', { class: 'chosen-mark' }, icon('check')) : null,
        ),
      );
    }),
  );

  return h('div', { class: 'text-compare' }, table, choices);
}

/** Snippet groups to highlight in the report for a field (by candidate display position). */
export function highlightGroups(session: Session, record: RecordKey, field: FieldInfo, index: TextIndex | null): { kind: number | 'shared'; snippets: string[] }[] {
  if (field.kind !== 'text') return [];
  const shown = session.displayCandidates(record, field.name);
  const spec = session.spec;
  const lists = shown.map((d) =>
    field.multi ? splitSnippets(d.candidate.value, spec) : typeof d.candidate.value === 'string' && !spec.sentinels.includes(d.candidate.value.trim()) ? [d.candidate.value] : [],
  );
  const res = session.resolution(record, field.name);
  // A decided value of the adjudicator's own: show its snippets as the shared color too.
  if (res.state === 'decided' && res.decision.kind === 'custom') lists.push(field.multi ? splitSnippets(res.value, spec) : typeof res.value === 'string' ? [res.value] : []);
  const aligned = alignSnippets(lists, index);
  const out = new Map<number | 'shared', string[]>();
  for (const a of aligned) {
    const inShown = a.members.filter((m) => m < shown.length);
    const k: number | 'shared' = !inShown.length || (inShown.length === shown.length && shown.length > 1) ? 'shared' : inShown[0]!;
    if (!out.has(k)) out.set(k, []);
    out.get(k)!.push(a.text);
  }
  return [...out].map(([kind, snippets]) => ({ kind, snippets }));
}
