/** The keyboard shortcuts of the adjudicate view, as a dialog. */

import { kbd, openDialog, type DialogHandle } from '../ui/components';
import { h, type Child } from '../ui/dom';

const isMac = (): boolean => /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || '');

const sep = (text: string) => h('span', { class: 'sc-sep' }, text);

/** Alternatives: `x` or `y`. */
const or = (...alts: Child[]): Child[] => alts.flatMap((a, i) => (i ? [sep('or'), a] : [a]));
/** A pair of keys read as "next / previous". */
const pair = (a: string, b: string): Child[] => [kbd(a), sep('/'), kbd(b)];

interface Item {
  keys: Child;
  label: string;
}

function groups(): { title: string; items: Item[] }[] {
  const undo = isMac() ? kbd('⌘', 'Z') : kbd('Ctrl', 'Z');
  return [
    {
      title: 'Decide',
      items: [
        { keys: [kbd('1'), sep('–'), kbd('9')], label: 'Choose value A–I of the focused field' },
        { keys: kbd('o'), label: 'Enter your own value (veto every source)' },
        { keys: kbd('Enter'), label: 'Confirm the value being edited' },
        { keys: kbd('x'), label: 'Clear the decision' },
        { keys: kbd('f'), label: 'Flag for discussion' },
        { keys: kbd('m'), label: 'Add or edit a note' },
        { keys: or(kbd('z'), undo), label: 'Undo the last change' },
      ],
    },
    {
      title: 'Move',
      items: [
        { keys: pair('j', 'k'), label: 'Next / previous field to review' },
        { keys: pair('n', 'p'), label: 'Next / previous record' },
        { keys: kbd('g'), label: 'Go to a record' },
        { keys: kbd('Enter'), label: 'Next record (when the record is complete)' },
      ],
    },
    {
      title: 'Report',
      items: [
        { keys: kbd('/'), label: 'Search the report' },
        { keys: kbd('w'), label: 'Reflow on / off' },
        { keys: pair('+', '−'), label: 'Larger / smaller text' },
        { keys: kbd('a'), label: 'Show / hide the fields that agree' },
      ],
    },
    {
      title: 'General',
      items: [
        { keys: kbd('?'), label: 'This list' },
        { keys: kbd('Esc'), label: 'Close or cancel' },
      ],
    },
  ];
}

let current: DialogHandle | null = null;

export function openShortcuts(): void {
  if (current) return;
  const body = h(
    'div',
    { class: 'sc-body' },
    h(
      'div',
      { class: 'sc-grid' },
      groups().map((g) =>
        h(
          'section',
          { class: 'sc-group' },
          h('h3', null, g.title),
          h(
            'dl',
            { class: 'sc-list' },
            g.items.map((it) => h('div', { class: 'sc-item' }, h('dt', null, it.keys), h('dd', null, it.label))),
          ),
        ),
      ),
    ),
    h('p', { class: 'sc-note' }, 'Single-key shortcuts work whenever no text box has the focus.'),
  );
  current = openDialog({
    title: 'Keyboard shortcuts',
    body,
    wide: true,
    onClose: () => {
      current = null;
    },
  });
  current.el.classList.add('sc-dialog');
}
