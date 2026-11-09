/**
 * The data dictionary: every field with its definition, valid values and
 * rules (rendered by json-schema-data-dictionary), the schema's shared rules,
 * and its cross-field rules with the records whose consensus breaks them.
 *
 * Routes: #/dictionary/<field> jumps to a field; ?tab=shared|rules opens the
 * other sections.
 */

import {
  renderDataDictionary,
  schemaDocumentsToTable,
  type DataDictionaryCategory,
  type DataDictionaryElement,
  type DataDictionaryRow,
  type DataDictionaryTable,
  type JsonSchema,
} from 'json-schema-data-dictionary';
import type { RuleInfo, SchemaModel } from '../core/types';
import { basename } from '../core/util';
import { navigate, type Mode } from '../state';
import { badge, callout, downloadText, emptyState, segmented, withTooltip } from '../ui/components';
import { h, render, type Child } from '../ui/dom';
import { fmtInt, plural } from '../ui/format';
import { icon } from '../ui/icons';
import type { ViewFactory } from './types';

type Tab = 'variables' | 'shared' | 'rules';
const TABS: readonly Tab[] = ['variables', 'shared', 'rules'];

// ------------------------------------------------------------------ helpers

/** The node at a JSON pointer ('' is the root). */
function atPointer(root: unknown, pointer: string): unknown {
  if (!pointer) return root;
  return pointer
    .split('/')
    .slice(1)
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'))
    .reduce<unknown>((node, seg) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[seg] : undefined), root);
}

/** The dictionary table of the schema, regrouped into the model's categories (the key field leads). */
function dictionaryTable(schema: SchemaModel): DataDictionaryTable {
  const documents = schema.documents.map((d) => ({ uri: `file:///${encodeURI(d.path)}`, name: basename(d.path), schema: d.json as JsonSchema }));
  const rootIndex = Math.max(0, schema.documents.findIndex((d) => d.path === schema.path));
  const table = schemaDocumentsToTable(documents, { rootIndex });
  const top = (row: DataDictionaryRow): string => {
    const first = row.__path?.[0];
    return first && first.kind === 'property' ? first.name : row['Variable name'];
  };
  const byField = new Map<string, DataDictionaryRow[]>();
  for (const row of table.rows) {
    const name = top(row);
    let list = byField.get(name);
    if (!list) byField.set(name, (list = []));
    list.push(row);
  }
  if (schema.categories.length <= 1 && !schema.categories[0]?.description) {
    return { ...table, title: schema.title, description: undefined, comment: undefined };
  }
  const placed = new Set<string>();
  const categories: DataDictionaryCategory[] = schema.categories.map((cat, i) => {
    const names = [...(i === 0 ? [schema.keyField] : []), ...cat.fields];
    for (const n of names) placed.add(n);
    return { id: cat.key, title: cat.title, description: cat.description || undefined, rows: names.flatMap((n) => byField.get(n) ?? []) };
  });
  // Anything the model does not place (it should not happen) stays visible.
  const rest = [...byField].filter(([n]) => !placed.has(n)).flatMap(([, rows]) => rows);
  if (rest.length) categories.push({ id: 'other-rows', title: 'Other', rows: rest });
  return { ...table, title: schema.title, description: undefined, comment: undefined, categories };
}

/** Prose with bullet and numbered lines turned into lists; a short "Lead-in:" is set in bold. */
function prose(text: string): HTMLElement[] {
  const out: HTMLElement[] = [];
  let list: HTMLElement | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) {
      list = null;
      continue;
    }
    const bullet = /^[•·▪◦*-]\s+(.*)$/.exec(line);
    const numbered = /^\d+[.)]\s+(.*)$/.exec(line);
    const item = bullet ?? numbered;
    if (item) {
      const tag = numbered ? 'OL' : 'UL';
      if (!list || list.tagName !== tag) {
        list = numbered ? h('ol') : h('ul');
        out.push(list);
      }
      list.appendChild(h('li', null, leadIn(item[1]!)));
      continue;
    }
    list = null;
    out.push(h('p', null, leadIn(line)));
  }
  return out;
}

function leadIn(line: string): Child {
  const m = /^([^.:]{2,48}):\s+(.+)$/.exec(line);
  return m ? [h('strong', null, `${m[1]}:`), ` ${m[2]}`] : line;
}

// --------------------------------------------------------------------- view

const createDictionaryView: ViewFactory = ({ session }) => {
  const { schema } = session.project;
  const categorical = schema.fields.filter((f) => f.kind === 'categorical').length;
  const text = schema.fields.filter((f) => f.kind === 'text').length;
  let tab: Tab = 'variables';

  // ---------------------------------------------------------------- header
  const schemaButton = () =>
    h(
      'button',
      {
        type: 'button',
        class: 'btn btn-sm',
        title: `Download ${basename(schema.path)}`,
        onclick: () => downloadText(JSON.stringify(schema.root, null, 2), basename(schema.path), 'application/json'),
      },
      icon('download'),
      'Schema',
    );

  const tabs = segmented<Tab>({
    options: [
      { value: 'variables', label: ['Fields ', h('span', { class: 'count' }, fmtInt(schema.fields.length))] },
      { value: 'shared', label: 'Shared rules', disabled: !schema.description && !schema.comment },
      { value: 'rules', label: ['Cross-field rules ', h('span', { class: 'count' }, fmtInt(schema.rules.length))], disabled: !schema.rules.length },
    ],
    value: tab,
    onChange: (v) => navigate('dictionary', [], v === 'variables' ? {} : { tab: v }, true),
    label: 'Dictionary sections',
  });

  const head = h(
    'div',
    { class: 'page-head dict-head' },
    h(
      'div',
      null,
      h('h1', null, 'Data dictionary'),
      h('p', null, schema.title, ' · ', h('code', null, schema.path)),
    ),
    h(
      'div',
      { class: 'dict-meta' },
      withTooltip(badge(`Key: ${schema.keyField}`, 'outline'), 'The property that links each record to its report file.'),
      badge(`${fmtInt(categorical)} categorical`, 'outline'),
      text ? withTooltip(badge(`${fmtInt(text)} free text`, 'outline'), 'Text fields hold exact report snippets.') : null,
      schemaButton(),
    ),
  );

  // ---------------------------------------------------------------- panels
  const host = h('div', { class: 'dict-host' });
  const varsPanel = h('div', { class: 'dict-panel dict-vars' }, host);
  const sharedPanel = h('div', { class: 'dict-panel dict-scroll', hidden: true });
  const rulesPanel = h('div', { class: 'dict-panel dict-scroll', hidden: true });
  const panels: Record<Tab, HTMLElement> = { variables: varsPanel, shared: sharedPanel, rules: rulesPanel };

  const el = h('div', { class: 'page dict-page' }, head, h('div', { class: 'dict-tabs' }, tabs.el), varsPanel, sharedPanel, rulesPanel);

  // Shared rules (static).
  const sections = schema.categories.filter((c) => c.description);
  render(
    sharedPanel,
    h(
      'article',
      { class: 'dict-prose' },
      schema.description ? [h('h2', null, 'Shared rules'), h('p', { class: 'dict-lede' }, 'Rules that apply to every field.'), prose(schema.description)] : null,
      sections.length
        ? [
            h('h2', null, 'Sections'),
            h(
              'dl',
              { class: 'dict-sections' },
              sections.map((c) => [h('dt', null, c.title, h('span', { class: 'muted' }, ` · ${plural(c.fields.length, 'field')}`)), h('dd', null, prose(c.description))]),
            ),
          ]
        : null,
      schema.comment ? [h('h2', null, 'Schema notes'), prose(schema.comment)] : null,
    ),
  );

  // Cross-field rules (they list the records whose consensus breaks them, so they refresh).
  const fieldChip = (name: string) => {
    const f = session.field(name);
    return withTooltip(
      h('button', { type: 'button', class: 'chip dict-field-chip', onclick: () => navigate('dictionary', [name]) }, h('code', null, name)),
      f && f.title !== name ? f.title : 'Show in the dictionary',
    );
  };

  function paintRules() {
    const broken = new Map<number, { record: string; fields: string[] }[]>();
    for (const record of session.project.records) {
      for (const v of session.violations(record)) {
        let list = broken.get(v.rule.index);
        if (!list) broken.set(v.rule.index, (list = []));
        list.push({ record, fields: v.fields });
      }
    }
    const recordDoc = schema.documents.find((d) => d.path === schema.recordDoc)?.json;
    const recordSchema = atPointer(recordDoc, schema.recordPointer) as { allOf?: unknown[] } | undefined;
    const item = (rule: RuleInfo) => {
      const hits = broken.get(rule.index) ?? [];
      const json = recordSchema?.allOf?.[rule.index];
      return h(
        'li',
        { class: 'dict-rule' },
        h(
          'div',
          { class: 'dict-rule-head' },
          h('span', { class: 'dict-rule-num num' }, `Rule ${rule.number}`),
          rule.fix ? withTooltip(badge('Skip pattern', 'outline'), 'A skip pattern the abstraction enforces (x-fix).') : null,
          hits.length
            ? withTooltip(badge(`Broken in ${plural(hits.length, 'record')}`, 'warning', 'alert'), 'The current consensus of these records breaks this rule.')
            : null,
        ),
        h('p', { class: ['dict-rule-text', !rule.comment && 'muted'] }, rule.comment || 'The schema does not describe this rule.'),
        h(
          'div',
          { class: 'dict-rule-fields' },
          rule.ifFields.length ? [h('span', { class: 'dict-rule-k' }, 'If'), rule.ifFields.map(fieldChip)] : null,
          rule.thenFields.length ? [h('span', { class: 'dict-rule-k' }, 'then'), rule.thenFields.map(fieldChip)] : null,
        ),
        hits.length
          ? h(
              'div',
              { class: 'dict-rule-records' },
              h('span', { class: 'dict-rule-k' }, 'Records'),
              hits.slice(0, 24).map((hit) =>
                h(
                  'button',
                  {
                    type: 'button',
                    class: 'chip num',
                    title: `Open record ${hit.record}`,
                    onclick: () => navigate('adjudicate', [hit.record], { field: hit.fields[0] ?? rule.thenFields[0] ?? rule.fields[0] }),
                  },
                  hit.record,
                ),
              ),
              hits.length > 24 ? h('span', { class: 'muted' }, `+${fmtInt(hits.length - 24)} more`) : null,
            )
          : null,
        json !== undefined
          ? h(
              'details',
              { class: 'disclosure dict-rule-json' },
              h('summary', null, icon('chevronRight'), 'JSON'),
              h('pre', null, JSON.stringify(json, null, 2)),
            )
          : null,
      );
    };
    const brokenCount = [...broken.values()].reduce((n, l) => n + l.length, 0);
    render(
      rulesPanel,
      h(
        'article',
        { class: 'dict-prose dict-rules' },
        h('h2', null, 'Cross-field rules'),
        h(
          'p',
          { class: 'dict-lede' },
          'Conditions the values of one record must meet together. The consensus is checked against them as you decide.',
        ),
        brokenCount
          ? callout('warning', `${plural(brokenCount, 'rule violation')} in the current consensus. Open a record to fix it, or confirm the values if the rule does not apply.`)
          : callout('good', 'The current consensus meets every rule.'),
        schema.rules.length ? h('ol', { class: 'dict-rule-list' }, schema.rules.map(item)) : emptyState({ icon: 'list', title: 'This schema has no cross-field rules.' }),
      ),
    );
  }

  // ------------------------------------------------------- the dictionary
  let dict: DataDictionaryElement | null = null;
  let dictError: string | null = null;
  let table: DataDictionaryTable | null = null;

  function mountDictionary(mode: Mode) {
    try {
      table ??= dictionaryTable(schema);
      dict = renderDataDictionary(host, table, {
        theme: mode,
        expandCategories: true,
        searchPlaceholder: 'Search fields, definitions and values…  (press / to focus)',
      });
    } catch (err) {
      console.error(err);
      dictError = (err as Error).message ?? String(err);
      render(
        host,
        emptyState({
          icon: 'alert',
          title: 'The dictionary could not be drawn from this schema.',
          body: dictError,
          action: schemaButton(),
        }),
      );
    }
  }

  /** Jump to a field's row: the component's own "go to" (it clears the search and opens the section). */
  let gotoTimer: ReturnType<typeof setTimeout> | undefined;
  function gotoField(name: string, attempt = 0) {
    clearTimeout(gotoTimer);
    const root = dict?.shadowRoot ?? dict;
    if (!root || !root.querySelector('[data-dd-row]')) {
      if (attempt < 20 && !dictError) gotoTimer = setTimeout(() => gotoField(name, attempt + 1), 50);
      return;
    }
    const trigger = h('button', { type: 'button', hidden: true, dataset: { ddGoto: name } });
    (root.querySelector('[data-dd-root]') ?? root).appendChild(trigger);
    trigger.click();
    trigger.remove();
    // The component scrolls smoothly; a long way is jumped instead (no ten-second glide through the table).
    requestAnimationFrame(() => {
      const viewport = root.querySelector<HTMLElement>('[data-dd-viewport]');
      const row = [...root.querySelectorAll<HTMLElement>('[data-dd-row]')].find((r) => r.querySelector('.dd-col-name code')?.textContent === name);
      if (!viewport || !row || viewport.scrollHeight <= viewport.clientHeight) return;
      const margin = Number.parseFloat(getComputedStyle(row).scrollMarginTop) || 0;
      const delta = row.getBoundingClientRect().top - viewport.getBoundingClientRect().top - margin;
      if (Math.abs(delta) > viewport.clientHeight * 2) viewport.scrollTo({ top: viewport.scrollTop + delta, behavior: 'instant' });
    });
  }

  // --------------------------------------------------------------- refresh
  let rulesDirty = true;
  const visible = () => el.isConnected && !el.closest('[hidden]');
  const unsubscribe = session.subscribe((e) => {
    if (e.type !== 'cells') return;
    rulesDirty = true;
    if (tab === 'rules' && visible()) {
      rulesDirty = false;
      paintRules();
    }
  });

  function showTab(next: Tab) {
    tab = next;
    tabs.set(next);
    for (const t of TABS) panels[t].hidden = t !== next;
    if (next === 'rules' && rulesDirty) {
      rulesDirty = false;
      paintRules();
    }
  }

  return {
    el,
    update(state, changed) {
      if (!dict && !dictError) mountDictionary(state.mode);
      else if (changed.has('mode') && dict) {
        dict.setAttribute('data-theme', state.mode);
        dict.shadowRoot?.querySelector('.dd-root')?.setAttribute('data-theme', state.mode);
      }
      if (!changed.has('route') || state.route.view !== 'dictionary') return;
      const field = state.route.path[0] ?? null;
      const asked = state.route.query.get('tab');
      const next: Tab = field ? 'variables' : TABS.includes(asked as Tab) ? (asked as Tab) : 'variables';
      showTab(next);
      if (field) requestAnimationFrame(() => gotoField(field));
    },
    destroy() {
      clearTimeout(gotoTimer);
      unsubscribe();
    },
  };
};

export default createDictionaryView;

/** For tests. */
export const _internal = { dictionaryTable, prose, atPointer };
