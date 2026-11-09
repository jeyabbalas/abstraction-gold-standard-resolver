/** Switching blind review on and off (turning it off asks first, because it is logged). */

import type { Session } from '../core/session';
import { confirmDialog, toast } from '../ui/components';
import { h } from '../ui/dom';

/** Turn blind mode off (after confirming) or on. */
export async function toggleBlind(session: Session): Promise<void> {
  if (!session.settings.blind) {
    session.updateSettings({ blind: true });
    toast('Blind review on: sources are hidden and each conflict’s values are shuffled.');
    return;
  }
  const ok = await confirmDialog({
    title: 'Reveal the sources?',
    body: [
      h('p', null, 'Each value will show which abstraction it came from, in a fixed order.'),
      h(
        'p',
        null,
        'Decisions you make from now on are recorded as ',
        h('strong', null, 'unblinded'),
        ' in the adjudication log. You can switch blind review back on at any time.',
      ),
    ],
    confirm: 'Reveal sources',
  });
  if (ok) session.updateSettings({ blind: false });
}
