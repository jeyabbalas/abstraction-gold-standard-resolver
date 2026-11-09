// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import type { StoredSession } from '../src/core/db';
import type { Session } from '../src/core/session';
import { parseHash, Store, type StateKey } from '../src/state';
import { _internal as dictInternal } from '../src/views/dictionary';
import createDictionaryView from '../src/views/dictionary';
import { openExportDialog } from '../src/views/exportDialog';
import createOverviewView, { _internal as ovInternal, nextOpenCell } from '../src/views/overview';
import { openSettingsDialog } from '../src/views/settingsDialog';
import { openShortcuts } from '../src/views/shortcuts';
import { makeSession } from './helpers';

const ALL = new Set<StateKey>(['session', 'stored', 'theme', 'mode', 'route']);

function storedOf(session: Session): StoredSession {
  return {
    id: session.project.id,
    version: 1,
    name: session.project.name,
    folderName: 'test-folder',
    createdAt: 0,
    updatedAt: 0,
    openedAt: 0,
    seed: session.project.seed,
    schemaPath: session.project.schema.path,
    keyField: session.project.keyField,
    sources: session.project.sources.map((s) => ({ id: s.id, path: s.path, fileName: s.fileName, label: s.label, hash: s.hash })),
    settings: session.settings,
    meta: session.meta,
    stats: session.stats(),
    filesStored: false,
    paths: [],
  };
}

function mount(session: Session, hash: string) {
  const stored = storedOf(session);
  const store = new Store({ session, stored, theme: 'light', mode: 'light', route: parseHash(hash) });
  return { store, stored };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('overview', () => {
  it('counts conflicts per field and finds the next open cell', async () => {
    const session = await makeSession();
    const rows = ovInternal.fieldRows(session);
    const cancer = rows.find((r) => r.field.name === 'Cancer')!;
    // Records 3 and 4 disagree (No vs Cannot determine); record 5 has an invalid value from one source.
    expect(cancer.conflicts).toBe(2);
    expect(cancer.open).toBeGreaterThanOrEqual(2);
    const next = nextOpenCell(session);
    expect(next).not.toBeNull();
    expect(session.isOpen(next!.record, next!.field!)).toBe(true);
  });

  it('hides per-source agreement during blind review and shows it otherwise', async () => {
    const session = await makeSession({ blind: true });
    const { store, stored } = mount(session, '#/overview');
    const view = createOverviewView({ store, session, stored });
    document.body.appendChild(view.el);
    view.update(store.get(), ALL);
    expect(view.el.textContent).toContain('Hidden during blind review');
    expect(view.el.querySelector('.ov-table')).not.toBeNull();
    session.updateSettings({ blind: false });
    view.update(store.get(), new Set<StateKey>(['route']));
    expect(view.el.textContent).not.toContain('Hidden during blind review');
    expect(view.el.textContent).toContain('Each source against the consensus');
    expect(view.el.textContent).toContain('Source 1');
    view.destroy?.();
  });
});

describe('dictionary', () => {
  it('regroups the dictionary into the schema sections, key field first', async () => {
    const session = await makeSession();
    const table = dictInternal.dictionaryTable(session.project.schema);
    expect(table.categories.map((c) => c.id)).toEqual(['procedures', 'disease', 'other']);
    expect(table.categories[0]!.rows[0]!['Variable name']).toBe('record_id');
  });

  it('turns bullet lines into lists and bolds a short lead-in', () => {
    const els = dictInternal.prose('Labels: what each means.\n• Yes: present\n• No: absent\nPlain line.');
    expect(els.map((e) => e.tagName)).toEqual(['P', 'UL', 'P']);
    expect(els[0]!.querySelector('strong')!.textContent).toBe('Labels:');
    expect(els[1]!.querySelectorAll('li')).toHaveLength(2);
  });

  it('opens the rules tab from the route', async () => {
    const session = await makeSession();
    const { store, stored } = mount(session, '#/dictionary?tab=rules');
    const view = createDictionaryView({ store, session, stored });
    document.body.appendChild(view.el);
    view.update(store.get(), ALL);
    expect(view.el.textContent).toContain('Rule 7');
    expect(view.el.textContent).toContain('Node metastasis is spread.');
    view.destroy?.();
  });
});

describe('dialogs', () => {
  it('lists the shortcuts once', () => {
    openShortcuts();
    openShortcuts();
    expect(document.querySelectorAll('.sc-dialog')).toHaveLength(1);
    expect(document.body.textContent).toContain('Undo the last change');
  });

  it('applies settings as they change', async () => {
    const session = await makeSession({ blind: false });
    openSettingsDialog(session);
    const dialog = document.querySelector('.set-dialog')!;
    const propagate = [...dialog.querySelectorAll('label.check-row')].find((l) => l.textContent?.includes('identical reports'))!;
    const box = propagate.querySelector('input')!;
    expect(box.checked).toBe(true);
    box.checked = false;
    box.dispatchEvent(new Event('change'));
    expect(session.settings.propagate).toBe(false);
    // Switching blind review on needs no confirmation.
    (dialog.querySelector('.set-switch') as HTMLButtonElement).click();
    await Promise.resolve();
    expect(session.settings.blind).toBe(true);
  });

  it('offers the export files', async () => {
    const session = await makeSession();
    openExportDialog(session, storedOf(session));
    const text = document.querySelector('.exp-dialog')!.textContent!;
    expect(text).toContain('Test_consensus.json');
    expect(text).toContain('Test_adjudication_log.csv');
    expect(text).toContain('still need');
  });
});
