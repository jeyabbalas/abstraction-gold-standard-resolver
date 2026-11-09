/**
 * Start page: the sessions saved in this browser (resume, back up, delete),
 * a drop zone for a new project folder (or a .zip of it), restoring a backup
 * file, and one-click synthetic demos. A loaded folder opens the setup screen
 * in place.
 */

import {
  BACKUP_FORMAT,
  deleteSession,
  forgetFiles,
  getCells,
  getFiles,
  isBackup,
  listSessions,
  storedSize,
  type SessionBackup,
  type StoredSession,
} from '../core/db';
import { detect } from '../core/detect';
import { fileStem } from '../core/exporter';
import { ProjectError } from '../core/project';
import { SchemaError } from '../core/schema';
import type { TextFile } from '../core/types';
import { fromDataTransfer, fromFileList, UnreadableFileError, type FileSet } from '../core/vfs';
import { changedSources, NeedsFolderError, openSession, restoreBackup, type Opened } from '../sessions';
import { parseHash, type Store } from '../state';
import { callout, confirmDialog, downloadText, openDialog, openMenu, ring, toast, withTooltip } from '../ui/components';
import { h, render } from '../ui/dom';
import { fmtInt, fmtPct, plural } from '../ui/format';
import { icon } from '../ui/icons';
import { mountSetup, type SetupPreset } from './setup';

const TREE: [string, string][] = [
  ['my_project/', ''],
  ['├── data_dictionary.json', 'JSON Schema of one record'],
  ['├── reports/', 'one per record: <key>.txt or <key>.md'],
  ['└── gold_standards/', 'two or more abstractions to reconcile'],
  ['    ├── abstractor_1.json', 'a JSON array of records'],
  ['    └── abstractor_2.json', ''],
];

interface DemoScenario {
  id: string;
  title: string;
  description: string;
  blind: boolean;
  sources: string[];
  /** Optional display names, one per source. */
  labels?: string[];
}

interface DemoManifest {
  title: string;
  schema: string;
  reports: string[];
  scenarios: DemoScenario[];
}

/** "just now", "5 min ago", "yesterday", or a date. */
export function ago(ts: number, now = Date.now()): string {
  const s = Math.max(0, (now - ts) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 2 * 86400) return 'yesterday';
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} days ago`;
  return new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

const fmtBytes = (n: number): string =>
  n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : n < 1024 ** 3 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`;

/** Pick a folder (or a .zip) with a temporary input. */
function pickFiles(kind: 'folder' | 'zip' | 'json'): Promise<FileList | null> {
  return new Promise((resolve) => {
    const input = h('input', {
      type: 'file',
      class: 'visually-hidden',
      tabIndex: -1,
      ...(kind === 'folder' ? { webkitdirectory: true, multiple: true } : { accept: kind === 'zip' ? '.zip,application/zip' : '.json,application/json' }),
    });
    input.addEventListener('change', () => {
      resolve(input.files?.length ? input.files : null);
      input.remove();
    });
    input.addEventListener('cancel', () => {
      resolve(null);
      input.remove();
    });
    document.body.appendChild(input);
    input.click();
  });
}

async function readBackup(file: File): Promise<SessionBackup> {
  let json: unknown;
  try {
    json = JSON.parse(await file.text());
  } catch {
    throw new ProjectError(`${file.name} is not a JSON file.`);
  }
  if (!isBackup(json)) throw new ProjectError(`${file.name} is not a session backup of this app.`);
  return json;
}

export function mountLanding(parent: HTMLElement, store: Store): { destroy(): void } {
  const el = h('div', { class: 'landing' });
  parent.appendChild(el);
  let setup: { destroy(): void } | null = null;
  let destroyed = false;
  let busy = false;

  const status = h('div', { class: 'landing-status', 'aria-live': 'polite' });
  const sessionsBox = h('section', { class: 'landing-section', 'aria-label': 'Saved sessions' });
  const demoBox = h('section', { class: 'landing-section demo-section', hidden: true, 'aria-label': 'Synthetic demos' });

  function opened(o: Opened) {
    if (destroyed) return;
    store.set({ session: o.session, stored: o.stored, route: parseHash(location.hash) });
  }

  function setStage(text: string) {
    render(status, h('div', { class: 'landing-progress' }, h('div', { class: 'spinner' }), text));
  }

  function showError(err: unknown, title = 'This folder could not be loaded.') {
    console.error(err);
    const known = err instanceof ProjectError || err instanceof SchemaError || err instanceof UnreadableFileError || err instanceof NeedsFolderError;
    render(
      status,
      callout('critical', [
        h('strong', null, known ? title : 'Something went wrong.'),
        h('div', null, (err as Error)?.message || String(err)),
        err instanceof UnreadableFileError
          ? h('div', null, 'The browser would not read it: the file changed after it was chosen, or security software blocked it. Choosing the folder with the button (rather than dropping it) can work where dropping does not.')
          : null,
      ]),
    );
  }

  /** Run a loading step with the spinner; one at a time. */
  async function run(step: () => Promise<void>) {
    if (busy) return;
    busy = true;
    el.classList.add('busy');
    try {
      await step();
    } catch (err) {
      showError(err);
    } finally {
      busy = false;
      el.classList.remove('busy');
    }
  }

  // ------------------------------------------------------------ new folder

  async function loadFolder(collect: () => Promise<FileSet>, preset?: SetupPreset) {
    setStage('Reading files…');
    const set = await collect();
    // A dropped backup file restores it.
    if (set.files.length === 1 && /\.json$/i.test(set.files[0]!.path)) {
      let json: unknown = null;
      try {
        json = JSON.parse(set.files[0]!.text);
      } catch {
        /* not JSON: handled below */
      }
      if (isBackup(json)) {
        await restore(json);
        return;
      }
    }
    if (!set.files.length) throw new ProjectError('No readable files were found. Choose the project folder itself: the one that holds the schema, the reports and the abstraction files.');
    setStage('Recognizing the files…');
    await new Promise((r) => setTimeout(r, 0));
    const detection = detect(set.name, set.files);
    if (!detection.schemaPath) {
      throw new ProjectError(
        `No JSON Schema was found among the ${plural(set.files.length, 'file')}. The folder needs the data dictionary: a JSON Schema describing one record (an object with "properties").`,
      );
    }
    if (!detection.sources.length) {
      throw new ProjectError('No abstraction file was found. Each abstraction is a JSON array of records (objects) with a key that names the report file.');
    }
    render(status);
    showSetup(set, detection, preset);
  }

  function showSetup(set: FileSet, detection: ReturnType<typeof detect>, preset?: SetupPreset) {
    setup?.destroy();
    render(el);
    window.scrollTo(0, 0);
    setup = mountSetup(el, {
      fileSet: set,
      detection,
      preset,
      onCancel: () => {
        setup?.destroy();
        setup = null;
        showHome();
      },
      onStart: opened,
    });
  }

  // --------------------------------------------------------------- resume

  /** Ask for the project folder of a session whose files were not kept, then open it. */
  function askFolder(stored: StoredSession, then: (files: TextFile[]) => Promise<void>) {
    const err = h('div');
    const choose = async (kind: 'folder' | 'zip') => {
      const list = await pickFiles(kind);
      if (!list) return;
      try {
        render(err, h('div', { class: 'landing-progress' }, h('div', { class: 'spinner' }), 'Reading files…'));
        const set = await fromFileList(list);
        const changed = await changedSources(stored, set.files);
        const missing = changed.filter((c) => c.endsWith('(missing)'));
        if (missing.length === stored.sources.length) {
          render(err, callout('critical', [h('strong', null, 'This is not the session’s folder.'), h('div', null, `None of its abstraction files is there (${stored.sources.map((s) => s.path).join(', ')}).`)]));
          return;
        }
        if (missing.length) {
          render(err, callout('critical', [h('strong', null, 'Files are missing.'), h('div', null, missing.join(', '))]));
          return;
        }
        if (changed.length) {
          const ok = await confirmDialog({
            title: 'Some files changed',
            body: [
              h('p', null, 'These abstraction files differ from the ones the session was built on:'),
              h('ul', null, changed.map((c) => h('li', { class: 'mono' }, c))),
              h('p', null, 'Decisions on cells whose values changed will be marked for a second look.'),
            ],
            confirm: 'Open with these files',
          });
          if (!ok) {
            render(err);
            return;
          }
        }
        d.close();
        await run(() => then(set.files));
      } catch (e) {
        render(err, callout('critical', (e as Error).message || String(e)));
      }
    };
    const d = openDialog({
      title: 'Choose the project folder',
      body: [
        h('p', null, `The files of “${stored.name}” are not kept in this browser. Choose the folder it was made from (${stored.folderName}) to resume; your decisions are kept.`),
        err,
      ],
      footer: [
        h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => d.close() }, 'Cancel'),
        h('button', { type: 'button', class: 'btn', onclick: () => void choose('zip') }, icon('archive'), 'Choose .zip'),
        h('button', { type: 'button', class: 'btn btn-primary', onclick: () => void choose('folder') }, icon('folderOpen'), 'Choose folder'),
      ],
    });
  }

  function resume(stored: StoredSession) {
    void run(async () => {
      setStage(`Opening ${stored.name}…`);
      try {
        opened(await openSession(stored.id));
      } catch (err) {
        if (!(err instanceof NeedsFolderError)) throw err;
        render(status);
        askFolder(stored, async (files) => {
          setStage(`Opening ${stored.name}…`);
          opened(await openSession(stored.id, files));
        });
      }
    });
  }

  async function restore(backup: SessionBackup) {
    setStage('Restoring the backup…');
    try {
      opened(await restoreBackup(backup));
      toast('Backup restored as a new session.');
    } catch (err) {
      if (!(err instanceof NeedsFolderError)) throw err;
      render(status);
      askFolder(backup.session, async (files) => {
        setStage('Restoring the backup…');
        opened(await restoreBackup(backup, files));
        toast('Backup restored as a new session.');
      });
    }
  }

  async function downloadBackup(stored: StoredSession) {
    const data: SessionBackup = {
      format: BACKUP_FORMAT,
      version: 1,
      exportedAt: new Date().toISOString(),
      session: stored,
      cells: await getCells(stored.id),
      ...(stored.filesStored ? { files: (await getFiles(stored.id)) ?? undefined } : {}),
    };
    downloadText(JSON.stringify(data), `${fileStem(stored.name)}_session_backup.json`, 'application/json');
    toast('Backup downloaded. Restore it from this page in any browser.');
  }

  // ------------------------------------------------------------- sessions

  async function paintSessions() {
    let sessions: StoredSession[];
    try {
      sessions = await listSessions();
    } catch (err) {
      render(sessionsBox, callout('warning', [h('strong', null, 'Saved sessions are unavailable.'), h('div', null, (err as Error).message)]));
      return;
    }
    if (destroyed) return;
    if (!sessions.length) {
      render(sessionsBox);
      sessionsBox.hidden = true;
      return;
    }
    sessionsBox.hidden = false;
    const size = await storedSize().catch(() => null);
    let persisted = false;
    try {
      persisted = (await navigator.storage?.persisted?.()) ?? false;
    } catch {
      /* unknown */
    }
    render(
      sessionsBox,
      h('div', { class: 'section-head' }, h('h2', null, 'Continue where you left off'), h('span', { class: 'muted' }, plural(sessions.length, 'session'))),
      h('div', { class: 'session-list' }, sessions.map(sessionCard)),
      h(
        'p',
        { class: 'storage-note' },
        icon('database'),
        h(
          'span',
          null,
          size !== null ? `Sessions take about ${fmtBytes(size)} of this browser’s storage. ` : 'Sessions are saved in this browser’s storage. ',
          persisted ? 'The browser keeps it until you delete it.' : 'The browser may clear it if the disk runs low on space: back up sessions you care about.',
        ),
      ),
    );
  }

  function sessionCard(s: StoredSession): HTMLElement {
    const st = s.stats;
    const frac = st.review ? st.resolved / st.review : 1;
    const done = st.review > 0 && st.open === 0;
    const resumeBtn = h('button', { type: 'button', class: ['btn', 'btn-sm', !done && 'btn-primary'], onclick: () => resume(s) }, done ? 'Open' : 'Resume', icon('arrowRight'));
    const more = h('button', { type: 'button', class: 'icon-btn', 'aria-label': `More actions for ${s.name}`, 'aria-haspopup': 'menu' }, icon('more'));
    more.addEventListener('click', () =>
      openMenu(more, [
        { label: 'Back up…', icon: 'save', onSelect: () => void downloadBackup(s).catch((e: Error) => toast(`Backup failed: ${e.message}`)) },
        {
          label: 'Forget the stored files',
          icon: 'archive',
          disabled: !s.filesStored,
          onSelect: async () => {
            const ok = await confirmDialog({
              title: 'Forget the stored files?',
              body: [
                h('p', null, 'The copy of the folder kept in this browser (reports, schema, abstractions) is removed. Your decisions are kept.'),
                h('p', null, 'To resume, you will choose the project folder again.'),
              ],
              confirm: 'Forget files',
              danger: true,
            });
            if (!ok) return;
            await forgetFiles(s.id);
            toast('Stored files removed.');
            void paintSessions();
          },
        },
        'separator',
        {
          label: 'Delete session…',
          icon: 'trash',
          danger: true,
          onSelect: async () => {
            const ok = await confirmDialog({
              title: `Delete “${s.name}”?`,
              body: [
                h('p', null, `Its ${plural(st.resolved, 'resolved cell')}, notes and flags are removed from this browser. This cannot be undone.`),
                h('p', { class: 'muted' }, 'Back it up first if you might need it.'),
              ],
              confirm: 'Delete session',
              danger: true,
            });
            if (!ok) return;
            await deleteSession(s.id);
            toast('Session deleted.');
            void paintSessions();
          },
        },
      ]),
    );
    const card = h(
      'div',
      { class: ['session-card', done && 'done'] },
      h('div', { class: 'session-ring' }, ring(frac, 40, 4), h('span', { class: 'session-pct' }, st.review ? fmtPct(frac, 0) : '—')),
      h(
        'div',
        { class: 'session-main' },
        h('button', { type: 'button', class: 'session-name', onclick: () => resume(s) }, s.name),
        h(
          'div',
          { class: 'session-meta' },
          h('span', null, `${fmtInt(st.records)} records`),
          h('span', null, plural(s.sources.length, 'abstraction')),
          h('span', null, st.review ? `${fmtInt(st.resolved)} of ${fmtInt(st.review)} resolved` : 'no conflicts'),
          st.flagged ? h('span', { class: 'flagged' }, icon('flag'), plural(st.flagged, 'flag')) : null,
        ),
        h(
          'div',
          { class: 'session-meta muted' },
          h('span', null, `Opened ${ago(s.openedAt)}`),
          h('span', null, s.settings.blind ? 'Blind review' : 'Sources shown'),
          s.filesStored
            ? h('span', null, 'Files kept in this browser')
            : withTooltip(h('span', { class: 'needs-folder' }, icon('folderOpen'), 'Needs the folder'), 'The files are not kept in this browser: you will choose the project folder to resume.'),
        ),
      ),
      h('div', { class: 'session-actions' }, resumeBtn, more),
    );
    return card;
  }

  // ---------------------------------------------------------------- demos

  async function paintDemos() {
    let manifest: DemoManifest;
    try {
      const res = await fetch('./demo/manifest.json', { cache: 'no-cache' });
      if (!res.ok) return;
      manifest = (await res.json()) as DemoManifest;
      if (!Array.isArray(manifest.scenarios) || !manifest.scenarios.length) return;
    } catch {
      return;
    }
    if (destroyed) return;
    demoBox.hidden = false;
    render(
      demoBox,
      h('div', { class: 'section-head' }, h('h2', null, 'Try it with synthetic data'), h('span', { class: 'muted' }, 'Invented reports and abstractions, safe to explore')),
      h(
        'div',
        { class: 'demo-grid' },
        manifest.scenarios.map((sc) =>
          h(
            'button',
            { type: 'button', class: 'demo-card', onclick: () => void run(() => openDemo(manifest, sc)) },
            h('span', { class: 'demo-icon' }, icon(sc.sources.length > 2 ? 'users' : 'bot')),
            h('span', { class: 'demo-text' }, h('strong', null, sc.title), h('span', null, sc.description)),
            h('span', { class: 'demo-go' }, icon('arrowRight')),
          ),
        ),
      ),
    );
  }

  async function openDemo(manifest: DemoManifest, sc: DemoScenario) {
    setStage('Downloading the demo files…');
    const paths = [manifest.schema, ...manifest.reports, ...sc.sources];
    const url = (p: string) => `./demo/${p.split('/').map(encodeURIComponent).join('/')}`;
    const files = await Promise.all(
      paths.map(async (path): Promise<TextFile> => {
        const res = await fetch(url(path));
        if (!res.ok) throw new ProjectError(`The demo file ${path} could not be downloaded (${res.status}).`);
        return { path, text: (await res.text()).replace(/^﻿/, '').replace(/\r\n?/g, '\n') };
      }),
    );
    const scenario = sc.sources.length > 2 || /expert|panel|abstractor/i.test(sc.id) ? 'experts' : 'automated';
    const labels = Object.fromEntries(sc.sources.flatMap((p, i) => (sc.labels?.[i] ? [[p, sc.labels[i]]] : [])));
    await loadFolder(async () => ({ name: `demo_${sc.id}`, files, skipped: 0 }), { scenario, blind: sc.blind, name: `${sc.title} (demo)`, labels });
  }

  // ------------------------------------------------------------------ home

  const dropzone = (() => {
    const chooseFolder = h('button', { type: 'button', class: 'btn btn-primary btn-lg' }, icon('folderOpen'), 'Choose folder');
    const chooseZip = h('button', { type: 'button', class: 'btn btn-lg' }, icon('archive'), 'Choose .zip');
    const restoreBtn = h('button', { type: 'button', class: 'link-btn' }, icon('history'), 'Restore a session backup…');
    chooseFolder.addEventListener('click', async () => {
      const list = await pickFiles('folder');
      if (list) void run(() => loadFolder(() => fromFileList(list)));
    });
    chooseZip.addEventListener('click', async () => {
      const list = await pickFiles('zip');
      if (list) void run(() => loadFolder(() => fromFileList(list)));
    });
    restoreBtn.addEventListener('click', async () => {
      const list = await pickFiles('json');
      const file = list?.[0];
      if (file) void run(async () => restore(await readBackup(file)));
    });
    const zone = h(
      'div',
      { class: 'dropzone', role: 'region', 'aria-label': 'Drop a project folder here' },
      h('div', { class: 'dropzone-icon' }, icon('folderOpen')),
      h('div', { class: 'dropzone-title' }, 'Drop a project folder here'),
      h('div', { class: 'dropzone-sub' }, 'or a .zip of it: the JSON Schema, the reports and two or more abstractions'),
      h('div', { class: 'dropzone-actions' }, chooseFolder, chooseZip),
      h('div', { class: 'dropzone-foot' }, restoreBtn),
    );
    let depth = 0;
    zone.addEventListener('dragenter', (e) => {
      e.preventDefault();
      depth += 1;
      zone.classList.add('over');
    });
    zone.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    });
    zone.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (!depth) zone.classList.remove('over');
    });
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      depth = 0;
      zone.classList.remove('over');
      const dt = e.dataTransfer;
      if (dt) void run(() => loadFolder(() => fromDataTransfer(dt)));
    });
    return zone;
  })();

  // Dropping anywhere on the start page works too.
  const onWindowDragOver = (e: DragEvent) => {
    if (!setup) e.preventDefault();
  };
  const onWindowDrop = (e: DragEvent) => {
    if (setup || dropzone.contains(e.target as Node)) return;
    e.preventDefault();
    const dt = e.dataTransfer;
    if (dt) void run(() => loadFolder(() => fromDataTransfer(dt)));
  };
  window.addEventListener('dragover', onWindowDragOver);
  window.addEventListener('drop', onWindowDrop);

  function showHome() {
    document.title = 'Gold Standard Resolver';
    render(
      el,
      h(
        'div',
        { class: 'landing-inner' },
        h(
          'div',
          { class: 'landing-hero' },
          h('h1', null, 'Reconcile abstractions into one gold standard'),
          h(
            'p',
            null,
            'Load the reports, the data dictionary and two or more abstractions of them: from several expert abstractors, or a human gold standard and the best automated pipeline. You see only the cells where they disagree, next to the report and the dictionary’s rules, and decide each one, or overrule them all with your own value.',
          ),
        ),
        sessionsBox,
        h(
          'section',
          { class: 'landing-section', 'aria-label': 'New session' },
          h('div', { class: 'section-head' }, h('h2', null, 'Start a new session')),
          dropzone,
          status,
        ),
        demoBox,
        h(
          'div',
          { class: 'landing-grid' },
          h(
            'section',
            { class: 'landing-panel' },
            h('h2', null, icon('folderOpen'), 'What the folder holds'),
            h(
              'pre',
              { class: 'tree' },
              TREE.map(([path, note]) => h('div', null, h('span', { class: 'tree-path' }, path), note ? h('span', { class: 'tree-note' }, note) : null)),
            ),
            h(
              'p',
              { class: 'muted' },
              'Names and layout do not matter: each file is recognized by its content. Every record carries a key (such as record_id) that names its report file.',
            ),
          ),
          h(
            'section',
            { class: 'landing-panel' },
            h('h2', null, icon('shield'), 'Private by design'),
            h('p', null, 'Everything runs in your browser. Reports and abstractions are read from your disk and never uploaded.'),
            h(
              'p',
              null,
              'Each decision is saved in this browser (IndexedDB) the moment you make it, so you can close the tab and pick up later. Back up a session to move it to another computer.',
            ),
          ),
        ),
      ),
    );
    void paintSessions();
  }

  showHome();
  void paintDemos();

  return {
    destroy() {
      destroyed = true;
      setup?.destroy();
      window.removeEventListener('dragover', onWindowDragOver);
      window.removeEventListener('drop', onWindowDrop);
      el.remove();
    },
  };
}
