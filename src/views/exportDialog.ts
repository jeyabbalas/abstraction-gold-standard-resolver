/** Export: the consensus gold standard, the adjudication log, a summary and a session backup. */

import { getFiles, type StoredSession } from '../core/db';
import { adjudicationLog, completeRecords, consensusRecords, CSV_BOM, exportZip, fileStem, summary, toCsv, type ConsensusScope } from '../core/exporter';
import type { Session } from '../core/session';
import { callout, downloadBlob, downloadText, openDialog, toast, type DialogHandle } from '../ui/components';
import { h, render } from '../ui/dom';
import { fmtInt, plural } from '../ui/format';
import { icon } from '../ui/icons';

let current: DialogHandle | null = null;

export function openExportDialog(session: Session, stored: StoredSession): void {
  if (current) return;
  const stem = fileStem(session.project.name);
  const stats = session.stats();
  const total = session.project.records.length;
  const complete = completeRecords(session).length;
  const incomplete = total - complete;
  let scope: ConsensusScope = 'complete';

  const notes = h('div', { class: 'exp-notes' });
  const consensusCount = h('span', { class: 'exp-file-count num' });

  function option(value: ConsensusScope, title: string, help: string): HTMLElement {
    const input = h('input', { type: 'radio', name: 'exp-scope', value, checked: scope === value });
    input.addEventListener('change', () => {
      if (!input.checked) return;
      scope = value;
      paint();
    });
    return h('label', { class: 'exp-option' }, input, h('div', null, h('strong', null, title), h('span', null, help)));
  }

  function paint() {
    const n = scope === 'complete' ? complete : total;
    consensusCount.textContent = plural(n, 'record');
    render(
      notes,
      stats.open
        ? callout('warning', [
            h('strong', null, `${plural(stats.open, 'cell')} in ${plural(incomplete, 'record')} still ${stats.open === 1 ? 'needs' : 'need'} a decision.`),
            h(
              'div',
              null,
              scope === 'complete'
                ? 'Those records are left out of the consensus file. The log lists every cell that needed review either way.'
                : 'Their open cells are null in the consensus file. The log lists every cell that needed review either way.',
            ),
          ])
        : callout('good', h('strong', null, `Every conflict is resolved: the consensus covers all ${plural(total, 'record')}.`)),
      session.settings.blind
        ? callout('info', 'The log and the summary name the source of every value. To stay blind, open them after you finish adjudicating.')
        : null,
    );
  }

  const fileRow = (name: string, what: string, extra: HTMLElement | null, onDownload: (() => void) | null) =>
    h(
      'li',
      { class: 'exp-file' },
      icon('file'),
      h('div', { class: 'exp-file-text' }, h('code', null, name), h('span', null, what, extra ? [' ', extra] : null)),
      onDownload
        ? h(
            'button',
            { type: 'button', class: 'icon-btn sm', title: `Download ${name} on its own`, 'aria-label': `Download ${name} on its own`, onclick: onDownload },
            icon('download'),
          )
        : null,
    );

  const scopeChoice = stats.open
    ? h(
        'fieldset',
        { class: 'exp-scope' },
        h('legend', null, 'Records in the consensus file'),
        option('complete', 'Complete records only', `${fmtInt(complete)} of ${plural(total, 'record')}: every conflict resolved.`),
        option('all', 'All records', `${plural(total, 'record')}; ${plural(stats.open, 'open cell')} exported as null.`),
      )
    : null;

  const body = h(
    'div',
    { class: 'exp-body' },
    scopeChoice,
    notes,
    h(
      'div',
      { class: 'exp-files' },
      h('div', { class: 'form-label' }, 'In the archive'),
      h(
        'ul',
        null,
        fileRow(`${stem}_consensus.json`, 'The consensus gold standard, a JSON array of records in the schema’s shape:', consensusCount, () =>
          downloadText(JSON.stringify(consensusRecords(session, scope), null, 2), `${stem}_consensus.json`, 'application/json'),
        ),
        fileRow(
          `${stem}_adjudication_log.csv`,
          'One row per reviewed cell: each source’s value, the consensus, how it was reached, timing, flags and notes.',
          null,
          () => downloadText(CSV_BOM + toCsv(adjudicationLog(session)), `${stem}_adjudication_log.csv`, 'text/csv'),
        ),
        fileRow(`${stem}_summary.json`, 'Counts, settings, blind-review history and agreement statistics.', null, () =>
          downloadText(JSON.stringify(summary(session, stored), null, 2), `${stem}_summary.json`, 'application/json'),
        ),
        fileRow(
          `${stem}_session_backup.json`,
          stored.filesStored
            ? 'Restores this session in another browser, with the folder’s files.'
            : 'Restores this session in another browser (the folder is chosen again there).',
          null,
          null,
        ),
      ),
    ),
  );

  const cancel = h('button', { type: 'button', class: 'btn btn-ghost' }, 'Cancel');
  const zipBtn = h('button', { type: 'button', class: 'btn btn-primary' }, icon('download'), 'Download .zip');
  cancel.addEventListener('click', () => current?.close());
  zipBtn.addEventListener('click', async () => {
    zipBtn.disabled = true;
    try {
      const files = stored.filesStored ? await getFiles(stored.id) : null;
      const bytes = exportZip(session, stored, files, scope);
      downloadBlob(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/zip' }), `${stem}_export.zip`);
      toast('Export downloaded.');
      current?.close();
    } catch (err) {
      console.error(err);
      toast(`Export failed: ${(err as Error).message ?? String(err)}`);
    } finally {
      zipBtn.disabled = false;
    }
  });

  paint();
  current = openDialog({
    title: 'Export',
    body,
    footer: [cancel, zipBtn],
    onClose: () => {
      current = null;
    },
    initialFocus: () => zipBtn,
  });
  current.el.classList.add('exp-dialog');
}
