/** Session settings. Changes apply at once; the session saves them. */

import type { Session } from '../core/session';
import type { Settings } from '../core/types';
import { openDialog, segmented, type DialogHandle } from '../ui/components';
import { h, type Child } from '../ui/dom';
import { plural } from '../ui/format';
import { icon, type IconName } from '../ui/icons';
import { toggleBlind } from './blind';

const SCENARIOS: Record<Settings['scenario'], { icon: IconName; title: string; help: string }> = {
  experts: { icon: 'users', title: 'Several experts’ gold standards', help: 'Each file is one expert’s abstraction of the same reports.' },
  automated: { icon: 'bot', title: 'Human vs. automated abstraction', help: 'A human gold standard and an automated pipeline’s output; either can win a conflict.' },
  other: { icon: 'layers', title: 'Other comparison', help: 'Abstractions of the same reports, compared field by field.' },
};

type BoolKey = 'textIgnoreCase' | 'textIgnoreOrder' | 'propagate' | 'autoAdvance';

let current: DialogHandle | null = null;

export function openSettingsDialog(session: Session): void {
  if (current) return;
  const { project } = session;
  /** Repaint functions, run when the settings change (here or elsewhere). */
  const syncs: (() => void)[] = [];

  const section = (title: string, ...children: Child[]) => h('section', { class: 'set-section' }, h('h3', null, title), children);

  function checkRow(key: BoolKey, title: string, help: Child, disabled = false): HTMLElement {
    const input = h('input', { type: 'checkbox', checked: session.settings[key], disabled });
    input.addEventListener('change', () => session.updateSettings({ [key]: input.checked } as Partial<Settings>));
    syncs.push(() => {
      input.checked = session.settings[key];
    });
    return h('label', { class: ['check-row', disabled && 'disabled'] }, input, h('div', null, h('strong', null, title), h('span', null, help)));
  }

  // ------------------------------------------------------------ blind review
  const blindState = h('span', { class: 'set-switch-state' });
  const blindHelp = h('span', { class: 'set-row-help' });
  const blindSwitch = h(
    'button',
    { type: 'button', role: 'switch', class: 'set-switch', 'aria-label': 'Blind review' },
    h('span', { class: 'set-switch-knob', 'aria-hidden': 'true' }),
  );
  blindSwitch.addEventListener('click', () => void toggleBlind(session).then(paintBlind));
  function paintBlind() {
    const on = session.settings.blind;
    blindSwitch.setAttribute('aria-checked', String(on));
    blindState.textContent = on ? 'On' : 'Off';
    blindHelp.textContent = on
      ? 'Sources are hidden and each conflict’s values appear in a coin-tossed order, labeled A, B, C….'
      : 'Each value shows the abstraction it came from, in a fixed order. Decisions are logged as unblinded.';
  }
  syncs.push(paintBlind);
  paintBlind();

  const scenario = SCENARIOS[session.settings.scenario] ?? SCENARIOS.other;
  const review = section(
    'Review',
    h(
      'div',
      { class: 'set-scenario' },
      icon(scenario.icon),
      h('div', null, h('strong', null, scenario.title), h('span', null, scenario.help)),
      h('span', { class: 'set-scenario-tag' }, 'Chosen at setup'),
    ),
    h(
      'div',
      { class: 'set-row' },
      h('div', { class: 'set-row-text' }, h('strong', null, 'Blind review'), blindHelp),
      h('div', { class: 'set-switch-wrap' }, blindState, blindSwitch),
    ),
  );

  // ---------------------------------------------------------------- sources
  const sources = section(
    'Source labels',
    h('p', { class: 'form-help' }, 'How each abstraction is named when blind review is off, in the adjudication log and in the summary.'),
    h(
      'div',
      { class: 'set-sources' },
      project.sources.map((s, i) => {
        const input = h('input', { class: 'input', value: session.sourceLabel(i), 'aria-label': `Label of ${s.fileName}`, maxlength: 60 });
        const commit = () => {
          session.setLabel(s.id, input.value);
          input.value = session.sourceLabel(i);
        };
        input.addEventListener('change', commit);
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
            input.blur();
          }
        });
        return h(
          'div',
          { class: 'set-source' },
          h('span', { class: 'set-source-n num' }, String(i + 1)),
          input,
          h('code', { class: 'set-source-file', title: s.path }, s.path),
        );
      }),
    ),
  );

  // ------------------------------------------------------------- comparison
  const hasText = session.fields.some((f) => f.kind === 'text');
  const hasMulti = session.fields.some((f) => f.kind === 'text' && f.multi);
  let singles = 0;
  for (const r of project.records) for (const f of session.fields) if (session.comparison(r, f.name).status === 'single') singles += 1;

  const single = segmented<Settings['singleSource']>({
    options: [
      { value: 'accept', label: 'Accept as is' },
      { value: 'review', label: 'Review each' },
    ],
    value: session.settings.singleSource,
    onChange: (v) => session.updateSettings({ singleSource: v }),
    label: 'Values only one source gave',
    size: 'sm',
  });
  syncs.push(() => single.set(session.settings.singleSource));

  const k = project.sources.length;
  let majority: HTMLElement | null = null;
  if (k >= 3) {
    const sel = h(
      'select',
      { class: 'select inline-select', 'aria-label': 'Majority auto-accept' },
      h('option', { value: '0' }, 'Off'),
      Array.from({ length: k - 1 }, (_, i) => i + 2).map((n) => h('option', { value: String(n) }, `${n} or more sources`)),
    );
    sel.value = String(session.settings.majority);
    sel.addEventListener('change', () => session.updateSettings({ majority: Number(sel.value) }));
    syncs.push(() => {
      sel.value = String(session.settings.majority);
    });
    majority = h(
      'div',
      { class: 'set-row' },
      h(
        'div',
        { class: 'set-row-text' },
        h('strong', null, 'Majority auto-accept'),
        h('span', { class: 'set-row-help' }, 'Accept a value at least this many sources share (and more than any other value) without asking you.'),
      ),
      sel,
    );
  }

  const comparison = section(
    'Comparison',
    hasText
      ? h(
          'div',
          { class: 'set-stack' },
          checkRow('textIgnoreCase', 'Ignore letter case in text fields', 'Text values that differ only in capitalization agree.'),
          hasMulti ? checkRow('textIgnoreOrder', 'Ignore snippet order', 'Snippet lists with the same snippets in another order agree.') : null,
          h('p', { class: 'form-help' }, 'Changing these recomputes which cells conflict. Your decisions are kept.'),
        )
      : null,
    h(
      'div',
      { class: 'set-row' },
      h(
        'div',
        { class: 'set-row-text' },
        h('strong', null, 'Values only one source gave'),
        h(
          'span',
          { class: 'set-row-help' },
          singles
            ? `${plural(singles, 'cell')} ${singles === 1 ? 'has' : 'have'} a value from one source only. Accept uses it as is; Review asks you to confirm each.`
            : 'Every value comes from more than one source in this folder.',
        ),
      ),
      single.el,
    ),
    majority,
  );

  // --------------------------------------------------------------- workflow
  const groups = new Set(project.twins.values()).size;
  const workflow = section(
    'Workflow',
    h(
      'div',
      { class: 'set-stack' },
      checkRow(
        'propagate',
        'Apply decisions to identical reports',
        groups
          ? `${plural(project.twins.size, 'record')} have the same report text as another record (${plural(groups, 'group')}). A decision on one fills the same field of the others while it is open.`
          : 'No two reports in this folder are identical.',
      ),
      checkRow('autoAdvance', 'Move on after each decision', 'Focus the next open field, and offer the next record when this one is complete.'),
    ),
  );

  const done = h('button', { type: 'button', class: 'btn btn-primary' }, 'Done');
  const unsubscribe = session.subscribe((e) => {
    if (e.type === 'settings') for (const fn of syncs) fn();
  });
  current = openDialog({
    title: 'Settings',
    body: h(
      'div',
      { class: 'set-body' },
      review,
      sources,
      comparison,
      workflow,
      h('p', { class: 'set-foot-note' }, 'Changes apply at once and are saved with the session.'),
    ),
    footer: done,
    onClose: () => {
      unsubscribe();
      current = null;
    },
    initialFocus: () => blindSwitch,
  });
  current.el.classList.add('set-dialog');
  done.addEventListener('click', () => current?.close());
}
