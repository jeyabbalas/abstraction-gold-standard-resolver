/**
 * The adjudicator's own value for a cell (overruling every source):
 *  - categorical fields: any allowed value, each with its rule;
 *  - snippet-list text fields: a composer — toggle the candidates' snippets,
 *    add a selection from the report, or type — that keeps snippets in
 *    report order and checks each one against the report text;
 *  - other kinds: a plain input (number, boolean, JSON).
 */

import type { Session } from '../../core/session';
import { joinSnippets, sortByReport, splitSnippets, TextIndex } from '../../core/snippets';
import type { FieldInfo, Json, RecordKey } from '../../core/types';
import { collapseWs, displayValue } from '../../core/util';
import { withTooltip } from '../../ui/components';
import { debounce, h, render } from '../../ui/dom';
import { truncate } from '../../ui/format';
import { icon } from '../../ui/icons';
import type { ReportPane } from './report';

export interface EditorOptions {
  session: Session;
  record: RecordKey;
  field: FieldInfo;
  report: ReportPane;
  /** Value to start from (the current decision or a candidate). */
  initial?: Json;
  onSubmit(value: Json): void;
  onCancel(): void;
}

export interface Editor {
  el: HTMLElement;
  /** Add a snippet (from a report selection). */
  addSnippet(text: string): void;
  focus(): void;
}

/** Whether the field accepts values outside its listed domain. */
function acceptsFreeText(session: Session, field: FieldInfo): boolean {
  return !field.domain.length || session.validators.fieldValid(field.name, '\u0000free text probe\u0000');
}

export function createEditor(opts: EditorOptions): Editor {
  const { session, record, field } = opts;
  const actions = h('div', { class: 'editor-actions' });
  const cancel = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => opts.onCancel() }, 'Cancel');

  // ------------------------------------------------------- categorical
  if (field.kind === 'categorical' || field.kind === 'boolean') {
    const domain: Json[] = field.kind === 'boolean' && !field.domain.length ? [true, false] : field.domain;
    const docs = new Map(field.valueDocs.map((d) => [d.label, d.rule]));
    const free = acceptsFreeText(session, field) ? h('input', { class: 'input', placeholder: 'Another value', 'aria-label': 'Another value', maxlength: 200 }) : null;
    const submitFree = () => {
      const v = collapseWs(free?.value ?? '');
      if (v) opts.onSubmit(v);
    };
    free?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submitFree();
      } else if (e.key === 'Escape') {
        e.stopPropagation();
        opts.onCancel();
      }
    });
    const chips = domain.map((v, i) => {
      const label = displayValue(v);
      const rule = docs.get(label);
      const chip = h(
        'button',
        { type: 'button', class: 'value-chip', onclick: () => opts.onSubmit(v) },
        i < 9 ? h('kbd', null, String(i + 1)) : null,
        h('span', null, label),
      );
      return rule ? withTooltip(chip, h('div', { class: 'tt-rule' }, h('div', { class: 'tt-title' }, label), rule)) : chip;
    });
    const el = h(
      'div',
      { class: 'editor', role: 'group', 'aria-label': 'Your own value' },
      h('div', { class: 'editor-title' }, icon('pencil'), 'Your value', h('span', { class: 'muted' }, 'Overrules every source')),
      h('div', { class: 'value-chips' }, chips),
      free ? h('div', { class: 'editor-free' }, free, h('button', { type: 'button', class: 'btn btn-sm', onclick: submitFree }, 'Use')) : null,
      actions,
    );
    render(actions, cancel);
    el.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return;
      const n = Number(e.key);
      if (n >= 1 && n <= 9 && domain[n - 1] !== undefined) {
        e.preventDefault();
        e.stopPropagation();
        opts.onSubmit(domain[n - 1]!);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        opts.onCancel();
      }
    });
    return {
      el,
      addSnippet(text) {
        if (free) {
          free.value = text;
          free.focus();
        }
      },
      focus() {
        (el.querySelector('.value-chip') as HTMLElement | null)?.focus();
      },
    };
  }

  // ------------------------------------------------------------ text
  if (field.kind === 'text') {
    const spec = session.spec;
    const index = opts.report.text ? new TextIndex(opts.report.text) : null;
    const cmp = session.comparison(record, field.name);
    const pool: string[] = [];
    const seen = new Set<string>();
    for (const c of cmp.candidates) {
      for (const s of field.multi ? splitSnippets(c.value, spec) : typeof c.value === 'string' && !spec.sentinels.includes(c.value) ? [c.value] : []) {
        const k = collapseWs(s);
        if (!seen.has(k)) {
          seen.add(k);
          pool.push(s);
        }
      }
    }
    const ordered = field.multi ? sortByReport(pool, index) : pool;
    const quick = [...new Set([...field.quickValues, ...spec.sentinels.filter((s) => field.description.includes(s))])];
    const start = typeof opts.initial === 'string' ? opts.initial : opts.initial === undefined ? '' : displayValue(opts.initial);
    const area = h('textarea', { class: 'input editor-text', rows: 3, spellcheck: false, 'aria-label': 'Your value' }, start);
    area.value = start;
    const poolBox = h('div', { class: 'snippet-pool' });
    const checks = h('div', { class: 'editor-checks' });

    const parts = (): string[] => (field.multi ? splitSnippets(area.value, spec) : collapseWs(area.value) && !spec.sentinels.includes(collapseWs(area.value)) ? [area.value] : []);
    const setParts = (list: string[]) => {
      const sorted = field.multi ? sortByReport(list, index) : list;
      area.value = sorted.length ? joinSnippets(sorted, spec) : quick[0] ?? '';
      paint();
    };
    const status = (s: string): 'exact' | 'case' | 'parts' | 'none' => opts.report.locate(s);

    function paint() {
      const present = new Set(parts().map(collapseWs));
      render(
        poolBox,
        ordered.length ? h('span', { class: 'pool-label' }, field.multi ? 'Snippets the sources gave' : 'Values the sources gave') : null,
        ordered.map((s) => {
          const on = present.has(collapseWs(s));
          return withTooltip(
            h(
              'button',
              {
                type: 'button',
                class: ['pool-chip', on && 'on'],
                'aria-pressed': String(on),
                onclick: () => {
                  if (!field.multi) {
                    area.value = s;
                    paint();
                    return;
                  }
                  const cur = parts();
                  const k = collapseWs(s);
                  setParts(on ? cur.filter((p) => collapseWs(p) !== k) : [...cur, s]);
                },
              },
              icon(on ? 'check' : 'plus'),
              h('span', null, truncate(s, 90)),
            ),
            s.length > 90 ? s : on ? 'Click to remove' : 'Click to add',
          );
        }),
        quick.map((q) =>
          h(
            'button',
            {
              type: 'button',
              class: ['pool-chip', 'quick', collapseWs(area.value) === q && 'on'],
              onclick: () => {
                area.value = q;
                paint();
              },
            },
            q,
          ),
        ),
      );
      paintChecks();
    }

    const paintChecks = debounce(() => {
      const list = parts();
      const v = collapseWs(area.value);
      const valid = !v || session.validators.fieldValid(field.name, v);
      const rows = list.map((s) => {
        const st = status(s);
        return h(
          'li',
          { class: `check-${st}` },
          icon(st === 'exact' ? 'check' : 'alert'),
          h('span', { class: 'check-text' }, truncate(s, 120)),
          h('span', { class: 'check-note' }, st === 'exact' ? 'in the report' : st === 'case' ? 'in the report, other letter case' : st === 'parts' ? 'only partly in the report' : 'not in the report'),
        );
      });
      render(
        checks,
        rows.length ? h('ul', null, rows) : null,
        !valid ? h('div', { class: 'check-invalid' }, icon('alert'), 'Not allowed by the schema') : null,
      );
    }, 120);

    area.addEventListener('input', () => paint());
    area.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        opts.onCancel();
      }
    });

    function submit() {
      const v = field.multi ? (parts().length ? joinSnippets(sortByReport(parts(), index), spec) : collapseWs(area.value)) : collapseWs(area.value);
      if (!v) {
        area.focus();
        return;
      }
      opts.onSubmit(v);
    }

    const sortBtn = field.multi
      ? h(
          'button',
          { type: 'button', class: 'btn btn-ghost btn-sm', title: 'Put the snippets in report order', onclick: () => setParts(parts()) },
          'Order as in report',
        )
      : null;
    render(actions, cancel, sortBtn, h('button', { type: 'button', class: 'btn btn-primary btn-sm', onclick: submit }, 'Use this value', h('kbd', null, '↵')));
    const el = h(
      'div',
      { class: 'editor', role: 'group', 'aria-label': 'Your own value' },
      h(
        'div',
        { class: 'editor-title' },
        icon('pencil'),
        'Your value',
        h('span', { class: 'muted' }, field.multi ? `Snippets joined by “${(spec.separator ?? ' ').trim()}”, in report order. Select report text to add it.` : 'Overrules every source'),
      ),
      poolBox,
      area,
      checks,
      actions,
    );
    paint();
    return {
      el,
      addSnippet(text) {
        const s = collapseWs(text);
        if (!s) return;
        if (field.multi) {
          const cur = parts();
          if (!cur.some((p) => collapseWs(p) === s)) setParts([...cur, s]);
        } else {
          area.value = s;
          paint();
        }
        area.focus();
      },
      focus() {
        area.focus();
        area.setSelectionRange(area.value.length, area.value.length);
      },
    };
  }

  // ------------------------------------------------------ number, JSON
  const isNum = field.kind === 'number';
  const input = h('input', { class: 'input', type: isNum ? 'number' : 'text', step: 'any', 'aria-label': 'Your value' });
  if (opts.initial !== undefined) input.value = isNum ? String(opts.initial) : JSON.stringify(opts.initial);
  const err = h('div', { class: 'check-invalid', hidden: true });
  function submit() {
    let v: Json;
    try {
      v = isNum ? Number(input.value) : (JSON.parse(input.value) as Json);
      if (isNum && (!input.value.trim() || !Number.isFinite(v))) throw new Error('Enter a number.');
    } catch (e) {
      err.hidden = false;
      render(err, icon('alert'), isNum ? 'Enter a number.' : `Not valid JSON (${(e as Error).message}).`);
      return;
    }
    opts.onSubmit(v);
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      opts.onCancel();
    }
  });
  render(actions, cancel, h('button', { type: 'button', class: 'btn btn-primary btn-sm', onclick: submit }, 'Use this value'));
  const el = h('div', { class: 'editor', role: 'group', 'aria-label': 'Your own value' }, h('div', { class: 'editor-title' }, icon('pencil'), 'Your value'), input, err, actions);
  return {
    el,
    addSnippet(text) {
      input.value = text;
    },
    focus() {
      input.focus();
    },
  };
}
