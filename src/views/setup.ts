/**
 * Setup of a new session, shown after a folder is read: which schema, which
 * abstractions (and their display names), who made them, how values are
 * compared, and a live preview of how much work the comparison leaves for
 * the adjudicator. Every guess the detection made can be changed here.
 */

import type { Detection } from '../core/detect';
import { buildProject, defaultLabel, type ProjectConfig } from '../core/project';
import { newSeed } from '../core/random';
import { Session } from '../core/session';
import { DEFAULT_SETTINGS, type LoadIssue, type Project, type Scenario, type Settings } from '../core/types';
import { uid } from '../core/util';
import type { FileSet } from '../core/vfs';
import { createSession, newMeta, type Opened } from '../sessions';
import { callout, infoTip, segmented } from '../ui/components';
import { debounce, h, render } from '../ui/dom';
import { fmtInt, fmtPct, plural } from '../ui/format';
import { icon, type IconName } from '../ui/icons';

export interface SetupPreset {
  scenario?: Scenario;
  blind?: boolean;
  name?: string;
  /** Display names by source path; they stay when the scenario changes. */
  labels?: Record<string, string>;
}

export interface SetupOptions {
  fileSet: FileSet;
  detection: Detection;
  preset?: SetupPreset;
  onCancel(): void;
  onStart(opened: Opened): void;
}

interface Preview {
  project: Project;
  review: number;
  conflicts: number;
  minor: number;
  missing: number;
  invalid: number;
  single: number;
  recordsWithReview: number;
  autoCells: number;
  cells: number;
  twinGroups: number;
  twinRecords: number;
}

const AUTOMATED_NAME = /llm|gpt|model|pipeline|auto|predict|qwen|llama|claude|gemini|mistral|bot|machine|nlp/i;

function guessScenario(det: Detection): Scenario {
  if (det.sources.some((s) => AUTOMATED_NAME.test(s.fileName))) return 'automated';
  return det.sources.length >= 3 ? 'experts' : 'automated';
}

const SCENARIOS: { value: Scenario; icon: IconName; title: string; body: string }[] = [
  {
    value: 'experts',
    icon: 'users',
    title: 'Several expert abstractors',
    body: 'Each file is one expert’s gold standard. You adjudicate where they disagree.',
  },
  {
    value: 'automated',
    icon: 'bot',
    title: 'Human vs. automated',
    body: 'A human gold standard and the best automated pipeline’s output. Either can be right in a conflict.',
  },
];

function computePreview(project: Project, settings: Settings): Preview {
  const session = new Session(project, settings, newMeta(project), [], null);
  let review = 0;
  let conflicts = 0;
  let minor = 0;
  let missing = 0;
  let invalid = 0;
  let single = 0;
  let autoCells = 0;
  let recordsWithReview = 0;
  for (const r of project.records) {
    let any = false;
    for (const f of project.schema.fields) {
      const cmp = session.comparison(r, f.name);
      if (cmp.status === 'conflict') {
        conflicts += 1;
        if (cmp.minor) minor += 1;
      } else if (cmp.status === 'single') single += 1;
      const needs = session.needsReview(r, f.name);
      if (needs) {
        review += 1;
        any = true;
        if (cmp.status === 'empty') missing += 1;
        else if (cmp.status !== 'conflict' && !cmp.candidates[0]?.valid) invalid += 1;
      } else if (session.resolution(r, f.name).state === 'auto') autoCells += 1;
    }
    if (any) recordsWithReview += 1;
  }
  const groups = new Set([...project.twins.values()]);
  return {
    project,
    review,
    conflicts,
    minor,
    missing,
    invalid,
    single,
    recordsWithReview,
    autoCells,
    cells: project.records.length * project.schema.fields.length,
    twinGroups: groups.size,
    twinRecords: project.twins.size,
  };
}

export function mountSetup(parent: HTMLElement, opts: SetupOptions): { destroy(): void } {
  const { fileSet, detection: det } = opts;
  const preset = opts.preset ?? {};

  // ---------------------------------------------------------------- state
  let schemaPath = det.schemaPath ?? '';
  let keyField = det.keyField ?? '';
  const selected = new Set(det.sources.map((s) => s.path));
  const labels = new Map<string, string>(Object.entries(preset.labels ?? {}));
  const edited = new Set<string>(labels.keys());
  let settings: Settings = { ...DEFAULT_SETTINGS, scenario: preset.scenario ?? guessScenario(det), blind: preset.blind ?? true };
  let name = preset.name ?? fileSet.name;
  let keepFiles = true;
  let preview: Preview | null = null;
  let previewError: string | null = null;
  let starting = false;
  let destroyed = false;
  let token = 0;

  const chosen = () => det.sources.filter((s) => selected.has(s.path));
  function resetLabels() {
    chosen().forEach((s, i) => {
      if (!edited.has(s.path)) labels.set(s.path, defaultLabel(s.fileName, i, settings.scenario));
    });
  }
  resetLabels();

  const el = h('div', { class: 'setup' });
  parent.appendChild(el);

  // --------------------------------------------------------------- pieces
  const sourcesBox = h('div', { class: 'source-list' });
  const scenarioBox = h('div', { class: 'scenario-grid', role: 'radiogroup', 'aria-label': 'Who made the abstractions' });
  const compareBox = h('div', { class: 'setup-rows' });
  const schemaBox = h('div');
  const previewBox = h('div', { class: 'setup-preview', 'aria-live': 'polite' });
  const startBtn = h('button', { type: 'button', class: 'btn btn-primary btn-lg setup-start' });
  const startError = h('div');

  function section(n: number, title: string, help: string | null, body: HTMLElement, aside?: HTMLElement) {
    return h(
      'section',
      { class: 'setup-section' },
      h('div', { class: 'setup-section-head' }, h('span', { class: 'step' }, String(n)), h('div', null, h('h2', null, title), help ? h('p', null, help) : null), aside ?? null),
      body,
    );
  }

  function paintSchema() {
    const current = det.schemas.find((s) => s.path === schemaPath);
    const pick =
      det.schemas.length > 1
        ? h(
            'select',
            {
              class: 'select',
              'aria-label': 'Schema file',
              onchange: (e: Event) => {
                schemaPath = (e.target as HTMLSelectElement).value;
                refresh();
              },
            },
            det.schemas.map((s) => h('option', { value: s.path, selected: s.path === schemaPath }, s.path)),
          )
        : h('span', { class: 'mono file-name' }, schemaPath);
    const p = preview?.project.schema;
    render(
      schemaBox,
      h(
        'div',
        { class: 'schema-line' },
        icon('dictionary'),
        h('div', null, h('div', { class: 'schema-title' }, current?.title || p?.title || 'Data dictionary'), pick),
        p
          ? h(
              'div',
              { class: 'schema-stats' },
              h('span', null, plural(p.fields.length, 'field')),
              p.categories.length > 1 ? h('span', null, plural(p.categories.length, 'group')) : null,
              p.rules.length ? h('span', null, plural(p.rules.length, 'cross-field rule')) : null,
            )
          : null,
      ),
    );
  }

  function paintSources() {
    const rows = det.sources.map((s) => {
      const on = selected.has(s.path);
      const box = h('input', {
        type: 'checkbox',
        checked: on,
        'aria-label': `Include ${s.path}`,
        onchange: (e: Event) => {
          if ((e.target as HTMLInputElement).checked) selected.add(s.path);
          else selected.delete(s.path);
          resetLabels();
          paintSources();
          paintCompare();
          refresh();
        },
      });
      const label = h('input', {
        class: 'input',
        value: labels.get(s.path) ?? '',
        disabled: !on,
        'aria-label': `Display name of ${s.fileName}`,
        maxlength: 40,
        oninput: (e: Event) => {
          labels.set(s.path, (e.target as HTMLInputElement).value);
          edited.add(s.path);
        },
      });
      return h(
        'div',
        { class: ['source-row', !on && 'off'] },
        h('label', { class: 'source-file' }, box, h('span', null, h('span', { class: 'mono' }, s.path), h('span', { class: 'muted' }, plural(s.records.length, 'record')))),
        label,
      );
    });
    render(
      sourcesBox,
      h('div', { class: 'source-head' }, h('span', null, 'File'), h('span', null, 'Shown as')),
      rows,
      chosen().length < 2 ? callout('warning', 'Choose at least two abstractions to compare.') : null,
    );
  }

  function paintScenario() {
    render(
      scenarioBox,
      SCENARIOS.map((sc) => {
        const on = settings.scenario === sc.value;
        return h(
          'button',
          {
            type: 'button',
            role: 'radio',
            'aria-checked': String(on),
            class: ['scenario-card', on && 'on'],
            onclick: () => {
              if (settings.scenario === sc.value) return;
              settings = { ...settings, scenario: sc.value };
              resetLabels();
              paintScenario();
              paintSources();
              paintCompare();
            },
          },
          h('span', { class: 'scenario-icon' }, icon(sc.icon)),
          h('span', { class: 'scenario-text' }, h('strong', null, sc.title), h('span', null, sc.body)),
          h('span', { class: 'scenario-check' }, icon(on ? 'checkCircle' : 'circle')),
        );
      }),
    );
  }

  function toggleRow(opts2: { title: string; help: string; checked: boolean; onChange: (on: boolean) => void; disabled?: boolean; aside?: HTMLElement | null }) {
    return h(
      'label',
      { class: ['check-row', opts2.disabled && 'disabled'] },
      h('input', { type: 'checkbox', checked: opts2.checked, disabled: opts2.disabled, onchange: (e: Event) => opts2.onChange((e.target as HTMLInputElement).checked) }),
      h('div', null, h('strong', null, opts2.title, opts2.aside ?? null), h('span', null, opts2.help)),
    );
  }

  function paintCompare() {
    const n = chosen().length;
    const keyOpt = det.keys.find((k) => k.field === keyField);
    const blindHelp =
      settings.scenario === 'automated'
        ? 'Recommended. You will not see which value came from the automated pipeline, and a coin toss sets the order of each conflict’s values.'
        : 'Optional for anonymous expert files. When off, each value shows its abstractor, always in the same order.';
    const single = segmented<'accept' | 'review'>({
      label: 'Values only one source gave',
      size: 'sm',
      value: settings.singleSource,
      options: [
        { value: 'accept', label: 'Accept' },
        { value: 'review', label: 'Review' },
      ],
      onChange: (v) => {
        settings = { ...settings, singleSource: v };
        refresh();
      },
    });
    const majorityOptions = n >= 3 ? Array.from({ length: n - 2 }, (_, i) => i + 2) : [];
    if (settings.majority && !majorityOptions.includes(settings.majority)) settings = { ...settings, majority: 0 };
    render(
      compareBox,
      h(
        'div',
        { class: 'setup-row' },
        h('div', { class: 'setup-row-label' }, h('strong', null, 'Linking key'), h('span', null, 'The property that names each record’s report file.')),
        det.keys.length
          ? h(
              'div',
              { class: 'setup-row-control' },
              h(
                'select',
                {
                  class: 'select',
                  'aria-label': 'Linking key',
                  onchange: (e: Event) => {
                    keyField = (e.target as HTMLSelectElement).value;
                    paintCompare();
                    refresh();
                  },
                },
                det.keys.map((k) => h('option', { value: k.field, selected: k.field === keyField }, k.field)),
              ),
              keyOpt
                ? h(
                    'span',
                    { class: ['key-note', keyOpt.matched < keyOpt.distinct && 'warn'] },
                    det.reports.length ? `${fmtInt(keyOpt.matched)} of ${fmtInt(keyOpt.distinct)} records have a report` : 'No report files found',
                  )
                : null,
            )
          : callout('critical', 'No property identifies the records: each needs a key (such as record_id) that is unique and names its report file.'),
      ),
      h('div', { class: 'setup-sep' }),
      toggleRow({
        title: 'Blind review',
        help: blindHelp,
        checked: settings.blind,
        onChange: (on) => {
          settings = { ...settings, blind: on };
          paintCompare();
        },
        aside: settings.scenario === 'automated' && settings.blind ? h('span', { class: 'badge accent' }, 'Recommended') : null,
      }),
      h('div', { class: 'setup-sep' }),
      h(
        'div',
        { class: 'setup-row' },
        h('div', { class: 'setup-row-label' }, h('strong', null, 'Values only one source gave'), h('span', null, 'When the other sources left a cell empty or lack the record.')),
        h('div', { class: 'setup-row-control' }, single.el, preview ? h('span', { class: 'key-note' }, plural(preview.single, 'cell')) : null),
      ),
      majorityOptions.length
        ? h(
            'div',
            { class: 'setup-row' },
            h('div', { class: 'setup-row-label' }, h('strong', null, 'Majority'), h('span', null, 'Accept a value enough sources share without asking you (it still shows as a majority decision).')),
            h(
              'div',
              { class: 'setup-row-control' },
              h(
                'select',
                {
                  class: 'select',
                  'aria-label': 'Majority rule',
                  onchange: (e: Event) => {
                    settings = { ...settings, majority: Number((e.target as HTMLSelectElement).value) };
                    refresh();
                  },
                },
                h('option', { value: '0', selected: !settings.majority }, 'Off: review every conflict'),
                majorityOptions.map((m) => h('option', { value: String(m), selected: settings.majority === m }, `Accept when ${m} of ${n} agree`)),
              ),
            ),
          )
        : null,
      h('div', { class: 'setup-sep' }),
      toggleRow({
        title: 'Text: ignore letter case',
        help: 'Snippets that differ only in upper/lower case agree.',
        checked: settings.textIgnoreCase,
        onChange: (on) => {
          settings = { ...settings, textIgnoreCase: on };
          refresh();
        },
      }),
      toggleRow({
        title: 'Text: ignore snippet order',
        help: 'Snippet lists with the same snippets in another order agree.',
        checked: settings.textIgnoreOrder,
        onChange: (on) => {
          settings = { ...settings, textIgnoreOrder: on };
          refresh();
        },
      }),
      h('div', { class: 'setup-sep' }),
      toggleRow({
        title: 'Apply decisions to identical reports',
        help: preview?.twinGroups
          ? `${plural(preview.twinRecords, 'record')} share their report text with another (${plural(preview.twinGroups, 'group')}). A decision on one fills the same open cell of the others.`
          : 'A decision on one record fills the same open cell of records with byte-identical report text.',
        checked: settings.propagate,
        onChange: (on) => {
          settings = { ...settings, propagate: on };
        },
      }),
      toggleRow({
        title: 'Move on after each decision',
        help: 'Focus the next open conflict as soon as you decide one.',
        checked: settings.autoAdvance,
        onChange: (on) => {
          settings = { ...settings, autoAdvance: on };
        },
      }),
    );
  }

  function issueList(issues: LoadIssue[]) {
    if (!issues.length) return null;
    const order = { error: 0, warning: 1, info: 2 } as const;
    const sorted = [...issues].sort((a, b) => order[a.level] - order[b.level]);
    return h(
      'details',
      { class: 'setup-issues', open: issues.some((i) => i.level === 'error') },
      h('summary', null, icon('alert'), plural(issues.length, 'note'), ' about the files'),
      h(
        'ul',
        null,
        sorted.map((i) => h('li', { class: i.level }, i.message)),
      ),
    );
  }

  function paintPreview() {
    const n = chosen().length;
    let body: HTMLElement;
    if (previewError) {
      body = callout('critical', [h('strong', null, 'These choices do not work yet.'), h('div', null, previewError)]);
    } else if (!preview) {
      body = h('div', { class: 'landing-progress' }, h('div', { class: 'spinner' }), 'Comparing the abstractions…');
    } else {
      const p = preview;
      const records = p.project.records.length;
      body = h(
        'div',
        null,
        h(
          'div',
          { class: 'preview-hero' },
          h('div', { class: 'preview-num' }, fmtInt(p.review)),
          h('div', { class: 'preview-label' }, p.review === 1 ? 'cell needs you' : 'cells need you', h('span', null, `in ${fmtInt(p.recordsWithReview)} of ${plural(records, 'record')}`)),
        ),
        h(
          'ul',
          { class: 'preview-list' },
          h('li', null, h('span', null, 'Conflicts'), h('strong', null, fmtInt(p.conflicts))),
          p.minor ? h('li', { class: 'sub' }, h('span', null, 'only case, punctuation or order'), h('strong', null, fmtInt(p.minor))) : null,
          p.missing ? h('li', null, h('span', null, 'Required but empty'), h('strong', null, fmtInt(p.missing))) : null,
          p.invalid ? h('li', null, h('span', null, 'Not allowed by the schema'), h('strong', null, fmtInt(p.invalid))) : null,
          settings.singleSource === 'review' && p.single ? h('li', null, h('span', null, 'Given by one source only'), h('strong', null, fmtInt(p.single))) : null,
          h('li', { class: 'muted-row' }, h('span', null, 'Accepted automatically'), h('strong', null, `${fmtInt(p.autoCells)} · ${fmtPct(p.cells ? p.autoCells / p.cells : 0, 1)}`)),
        ),
        issueList(p.project.issues),
      );
    }
    const ready = !!preview && !previewError && n >= 2 && !starting;
    startBtn.disabled = !ready;
    render(startBtn, starting ? h('span', { class: 'spinner' }) : null, starting ? 'Saving…' : 'Start adjudicating', starting ? null : icon('arrowRight'));
    const nameInput = h('input', {
      class: 'input',
      value: name,
      maxlength: 80,
      'aria-label': 'Session name',
      oninput: (e: Event) => {
        name = (e.target as HTMLInputElement).value;
      },
    });
    render(
      previewBox,
      h('div', { class: 'preview-title' }, 'Preview'),
      body,
      h('div', { class: 'setup-sep' }),
      h('div', { class: 'form-row' }, h('label', null, 'Session name'), nameInput),
      toggleRow({
        title: 'Keep the files in this browser',
        help: 'Resume without choosing the folder again. They stay on this computer.',
        checked: keepFiles,
        onChange: (on) => {
          keepFiles = on;
        },
      }),
      startBtn,
      startError,
      det.issues.length ? issueList(det.issues) : null,
    );
  }

  // -------------------------------------------------------------- preview
  const rebuild = debounce(async () => {
    const my = ++token;
    const n = chosen().length;
    if (!schemaPath || !keyField || n < 1) {
      preview = null;
      previewError = !schemaPath ? 'Choose a schema.' : !keyField ? 'No linking key: the records cannot be matched to reports.' : 'Choose the abstractions to compare.';
      paintPreview();
      return;
    }
    try {
      const project = await buildProject(fileSet.files, configFor(), det);
      if (my !== token || destroyed) return;
      preview = computePreview(project, settings);
      previewError = null;
    } catch (err) {
      if (my !== token || destroyed) return;
      preview = null;
      previewError = (err as Error).message || String(err);
    }
    paintSchema();
    paintCompare();
    paintPreview();
  }, 180);

  function refresh() {
    preview = null;
    previewError = null;
    paintPreview();
    void rebuild();
  }

  function configFor(): ProjectConfig {
    return {
      id: uid('s-'),
      name: name.trim() || fileSet.name,
      createdAt: Date.now(),
      seed: newSeed(),
      schemaPath,
      keyField,
      sources: chosen().map((s, i) => ({ id: `src-${i + 1}`, path: s.path, label: (labels.get(s.path) ?? '').trim() || defaultLabel(s.fileName, i, settings.scenario) })),
      settings,
    };
  }

  startBtn.addEventListener('click', async () => {
    if (starting) return;
    starting = true;
    render(startError);
    paintPreview();
    try {
      const opened = await createSession({ folderName: fileSet.name, files: fileSet.files, detection: det, config: configFor(), keepFiles });
      if (!destroyed) opts.onStart(opened);
    } catch (err) {
      console.error(err);
      starting = false;
      paintPreview();
      render(startError, callout('critical', [h('strong', null, 'The session could not be created.'), h('div', null, (err as Error).message || String(err))]));
    }
  });

  // --------------------------------------------------------------- layout
  const reportsTxt = det.reports.filter((r) => r.format === 'text').length;
  const reportsMd = det.reports.length - reportsTxt;
  render(
    el,
    h(
      'div',
      { class: 'setup-inner' },
      h(
        'div',
        { class: 'setup-head' },
        h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => opts.onCancel() }, icon('arrowLeft'), 'Back'),
        h('h1', null, 'Set up the session'),
        h(
          'p',
          { class: 'setup-found' },
          h('span', { class: 'mono' }, fileSet.name),
          h('span', null, plural(fileSet.files.length, 'file'), ' read'),
          h('span', null, plural(det.sources.length, 'abstraction')),
          h('span', null, plural(det.reports.length, 'report'), reportsMd && reportsTxt ? ` (${fmtInt(reportsTxt)} text, ${fmtInt(reportsMd)} Markdown)` : reportsMd ? ' (Markdown)' : ''),
          fileSet.skipped ? h('span', { class: 'muted' }, `${fmtInt(fileSet.skipped)} other files ignored`) : null,
        ),
      ),
      h(
        'div',
        { class: 'setup-grid' },
        h(
          'div',
          { class: 'setup-form' },
          section(1, 'Data dictionary', 'The JSON Schema that defines every field. Its descriptions and rules are shown next to each conflict.', schemaBox),
          section(2, 'Abstractions to reconcile', 'Each file is a JSON array of records. Display names appear when blind review is off.', sourcesBox),
          section(3, 'Who made them?', null, scenarioBox),
          section(
            4,
            'How to compare',
            null,
            compareBox,
            infoTip(
              h(
                'div',
                null,
                h('p', null, 'Values are compared with whitespace collapsed. Cells where the sources agree are accepted automatically; you can still override any of them.'),
                h('p', null, 'You can change these settings later, except the linking key.'),
              ),
            ),
          ),
        ),
        h('aside', { class: 'setup-aside' }, previewBox),
      ),
    ),
  );
  paintSchema();
  paintSources();
  paintScenario();
  paintCompare();
  paintPreview();
  void rebuild();

  return {
    destroy() {
      destroyed = true;
      el.remove();
    },
  };
}
