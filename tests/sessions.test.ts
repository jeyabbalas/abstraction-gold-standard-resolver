/** Sessions saved in IndexedDB (fake-indexeddb): save, reopen, re-choose the folder, back up, restore, delete. */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { deleteSession, getCells, getFiles, getSession, isBackup, listSessions } from '../src/core/db';
import { detect } from '../src/core/detect';
import { backup } from '../src/core/exporter';
import type { Session } from '../src/core/session';
import { DEFAULT_SETTINGS } from '../src/core/types';
import { changedSources, createSession, NeedsFolderError, openSession, restoreBackup } from '../src/sessions';
import { folder } from './helpers';

let n = 0;

async function create(keepFiles: boolean) {
  const files = folder();
  const det = detect('test', files);
  n += 1;
  return createSession({
    folderName: 'test',
    files,
    detection: det,
    keepFiles,
    config: {
      id: `s-test-${n}`,
      name: `Test ${n}`,
      createdAt: 0,
      seed: 7,
      schemaPath: det.schemaPath!,
      keyField: det.keyField!,
      sources: det.sources.map((src, i) => ({ id: `src-${i + 1}`, path: src.path, label: `Source ${i + 1}` })),
      settings: { ...DEFAULT_SETTINGS },
    },
  });
}

/** Resolves once every write the session started has finished. */
function settled(session: Session): Promise<void> {
  return new Promise((resolve) => {
    const check = () => (session.saving === 0 ? resolve() : setTimeout(check, 2));
    check();
  });
}

describe('sessions in IndexedDB', () => {
  it('saves decisions, notes, flags and settings, and reopens them', async () => {
    const { session, stored } = await create(true);
    session.decide('2', 'Histology', 'Serous');
    session.setNote('2', 'Spread', 'Check the nodes.');
    session.toggleFlag('2', 'Spread');
    session.updateSettings({ autoAdvance: false });
    session.flushMeta();
    await settled(session);
    session.detach();

    const again = await openSession(stored.id);
    expect(again.session.resolution('2', 'Histology')).toMatchObject({ state: 'decided', value: 'Serous' });
    expect(again.session.cell('2', 'Spread')).toMatchObject({ note: 'Check the nodes.', flag: true });
    expect(again.session.settings.autoAdvance).toBe(false);
    expect(again.session.stats()).toEqual(session.stats());
    again.session.detach();
  });

  it('asks for the folder when the files were not kept, and notices changed files', async () => {
    const { session, stored } = await create(false);
    session.decide('2', 'Histology', 'Serous');
    await settled(session);
    session.detach();
    expect(await getFiles(stored.id)).toBeNull();
    await expect(openSession(stored.id)).rejects.toBeInstanceOf(NeedsFolderError);

    const same = folder();
    expect(await changedSources(stored, same)).toEqual([]);
    // Abstractor A's value for record 2 changes after the decision: the decision becomes stale.
    const edited = same.map((f) => (f.path === 'gold/a.json' ? { ...f, text: f.text.replace('"Serous"', '"Not applicable"') } : f));
    expect(await changedSources(stored, edited)).toEqual(['gold/a.json']);
    const reopened = await openSession(stored.id, edited);
    expect(reopened.session.resolution('2', 'Histology')).toMatchObject({ state: 'decided', value: 'Serous' });
    expect(reopened.session.isStale('2', 'Histology')).toBe(true);
    const hashOf = (s: typeof stored) => s.sources.find((x) => x.path === 'gold/a.json')!.hash;
    expect(hashOf(reopened.stored)).not.toBe(hashOf(stored));
    expect(hashOf((await getSession(stored.id))!)).toBe(hashOf(reopened.stored));
    reopened.session.detach();
  });

  it('backs up and restores a session as a copy, and deletes one', async () => {
    const { session, stored } = await create(true);
    session.decide('2', 'Spread', 'Identified');
    session.toggleFlag('2', 'Histology');
    await settled(session);
    const file = JSON.parse(JSON.stringify(backup(session, (await getSession(stored.id))!, await getFiles(stored.id))));
    expect(isBackup(file)).toBe(true);
    session.detach();

    const restored = await restoreBackup(file);
    expect(restored.stored.id).not.toBe(stored.id);
    expect(restored.session.resolution('2', 'Spread')).toMatchObject({ state: 'decided', value: 'Identified' });
    expect(restored.session.cell('2', 'Histology')?.flag).toBe(true);
    expect((await getCells(restored.stored.id)).length).toBe((await getCells(stored.id)).length);
    expect((await listSessions()).map((s) => s.id)).toEqual(expect.arrayContaining([stored.id, restored.stored.id]));
    restored.session.detach();

    // A backup without files needs the folder.
    const { files: _files, ...withoutFiles } = file;
    void _files;
    await expect(restoreBackup(withoutFiles)).rejects.toBeInstanceOf(NeedsFolderError);

    await deleteSession(restored.stored.id);
    expect(await getSession(restored.stored.id)).toBeUndefined();
    expect(await getCells(restored.stored.id)).toEqual([]);
    expect(await getFiles(restored.stored.id)).toBeNull();
    expect(await getSession(stored.id)).toBeDefined();
  });
});
