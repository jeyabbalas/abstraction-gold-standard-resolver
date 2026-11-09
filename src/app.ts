/** App shell: header, navigation, view lifecycle, the session list and setup. */

import { getFiles, type StoredSession } from './core/db';
import { backup, fileStem } from './core/exporter';
import type { Session, SessionEvent } from './core/session';
import { applyTheme, buildHash, currentMode, navigate, parseHash, tabSession, type State, type StateKey, type Store, type ThemePref, type ViewName } from './state';
import { downloadText, hideTooltip, openMenu, ring, toast, withTooltip } from './ui/components';
import { h, render } from './ui/dom';
import { fmtInt, fmtPct, plural } from './ui/format';
import { icon, type IconName } from './ui/icons';
import { toggleBlind } from './views/blind';
import { openExportDialog } from './views/exportDialog';
import { mountLanding } from './views/landing';
import { openSettingsDialog } from './views/settingsDialog';
import { openShortcuts } from './views/shortcuts';
import type { ViewFactory, ViewInstance } from './views/types';

const NAV: { view: ViewName; label: string; icon: IconName; hint: string }[] = [
  { view: 'adjudicate', label: 'Adjudicate', icon: 'adjudicate', hint: 'Resolve conflicts one report at a time' },
  { view: 'overview', label: 'Overview', icon: 'overview', hint: 'Progress, where the conflicts are, agreement' },
  { view: 'dictionary', label: 'Dictionary', icon: 'dictionary', hint: 'The data dictionary (JSON Schema)' },
];

const LOADERS: Record<ViewName, () => Promise<{ default: ViewFactory }>> = {
  adjudicate: () => import('./views/adjudicate'),
  overview: () => import('./views/overview'),
  dictionary: () => import('./views/dictionary'),
};

const THEME_NEXT: Record<ThemePref, ThemePref> = { auto: 'light', light: 'dark', dark: 'auto' };
const THEME_ICON: Record<ThemePref, IconName> = { auto: 'monitor', light: 'sun', dark: 'moon' };
const THEME_LABEL: Record<ThemePref, string> = { auto: 'Theme: system', light: 'Theme: light', dark: 'Theme: dark' };

export function mountApp(root: HTMLElement, store: Store): void {
  const header = h('header', { class: 'app-header' });
  const main = h('main', { class: 'app-main', id: 'main' });
  render(root, header, main);

  const instances = new Map<ViewName, { view: ViewInstance; wrap: HTMLElement; pending: Set<StateKey> }>();
  const loading = new Map<ViewName, Promise<void>>();
  let landing: { destroy(): void } | null = null;
  let current: Session | null = null;
  let unsubscribe: (() => void) | null = null;

  // ------------------------------------------------------------- header
  const themeBtn = h('button', { type: 'button', class: 'icon-btn' });
  const paintTheme = (pref: ThemePref) => {
    render(themeBtn, icon(THEME_ICON[pref]));
    themeBtn.setAttribute('aria-label', `${THEME_LABEL[pref]} (click to change)`);
    themeBtn.title = `${THEME_LABEL[pref]} — click to change`;
  };
  themeBtn.addEventListener('click', () => {
    const next = THEME_NEXT[store.get().theme];
    store.set({ theme: next, mode: applyTheme(next) });
  });
  paintTheme(store.get().theme);

  const progressBtn = h('button', { type: 'button', class: 'progress-btn' });
  const blindBtn = h('button', { type: 'button', class: 'blind-btn' });
  const saveDot = h('span', { class: 'save-dot', role: 'status', 'aria-live': 'polite' });
  let lastSaved = 0;
  let saveError: string | null = null;

  function paintProgress(session: Session) {
    const st = session.stats();
    const frac = st.review ? st.resolved / st.review : 1;
    render(
      progressBtn,
      ring(frac, 18, 3),
      h('span', { class: 'progress-num' }, st.review ? `${fmtInt(st.resolved)} / ${fmtInt(st.review)}` : 'No conflicts'),
    );
    progressBtn.setAttribute('aria-label', `${fmtInt(st.resolved)} of ${fmtInt(st.review)} cells resolved. Open the overview.`);
  }

  function paintBlind(session: Session) {
    const blind = session.settings.blind;
    blindBtn.classList.toggle('on', blind);
    render(blindBtn, icon(blind ? 'eyeOff' : 'eye'), h('span', null, blind ? 'Blind' : 'Sources shown'));
    blindBtn.setAttribute('aria-pressed', String(blind));
    blindBtn.setAttribute('aria-label', blind ? 'Blind review is on. Click to reveal the sources.' : 'Sources are shown. Click to switch blind review on.');
  }

  function paintSave(session: Session) {
    const pending = session.saving;
    saveDot.className = ['save-dot', saveError ? 'error' : pending ? 'pending' : 'ok'].join(' ');
    render(saveDot, icon(saveError ? 'alert' : 'database'));
  }

  withTooltip(progressBtn, () => {
    const s = store.get().session;
    if (!s) return '';
    const st = s.stats();
    const complete = s.project.records.filter((r) => s.summary(r).review > 0 && s.summary(r).open === 0).length;
    const withReview = s.project.records.filter((r) => s.summary(r).review > 0).length;
    return h(
      'div',
      null,
      h('div', { class: 'tt-title' }, `${fmtPct(st.review ? st.resolved / st.review : 1, 0)} resolved`),
      h('div', null, `${fmtInt(st.resolved)} of ${plural(st.review, 'cell')} that need you are resolved.`),
      h('div', null, `${fmtInt(complete)} of ${plural(withReview, 'record')} with conflicts are complete.`),
      st.flagged ? h('div', null, `${plural(st.flagged, 'cell')} flagged for discussion.`) : null,
      h('div', { class: 'tt-muted', style: { marginTop: '4px' } }, 'Click for the overview.'),
    );
  });
  withTooltip(saveDot, () =>
    saveError
      ? h('div', null, h('div', { class: 'tt-title' }, 'Not saved'), h('div', null, saveError), h('div', { class: 'tt-muted' }, 'Back up the session from the menu to keep your work.'))
      : store.get().session?.saving
        ? 'Saving…'
        : h(
            'div',
            null,
            h('div', { class: 'tt-title' }, 'Saved in this browser'),
            h('div', null, lastSaved ? `Last change saved at ${new Date(lastSaved).toLocaleTimeString()}.` : 'Every decision is saved as you make it.'),
            h('div', { class: 'tt-muted' }, 'Stored on this computer only (IndexedDB).'),
          ),
  );
  progressBtn.addEventListener('click', () => navigate('overview'));
  blindBtn.addEventListener('click', () => {
    const s = store.get().session;
    if (s) void toggleBlind(s);
  });

  const exportBtn = h('button', { type: 'button', class: 'btn btn-sm', title: 'Download the consensus gold standard and the adjudication log' }, icon('download'), h('span', null, 'Export'));
  exportBtn.addEventListener('click', () => {
    const { session, stored } = store.get();
    if (session && stored) openExportDialog(session, stored);
  });

  const menuBtn = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Session menu', 'aria-haspopup': 'menu' }, icon('more'));
  menuBtn.addEventListener('click', () => {
    const { session, stored } = store.get();
    if (!session || !stored) return;
    openMenu(menuBtn, [
      { label: 'Settings…', icon: 'settings', onSelect: () => openSettingsDialog(session) },
      { label: 'Keyboard shortcuts', icon: 'keyboard', hint: '?', onSelect: () => openShortcuts() },
      'separator',
      {
        label: 'Back up session…',
        icon: 'save',
        onSelect: async () => {
          const files = stored.filesStored ? await getFiles(stored.id) : null;
          const data = backup(session, stored, files);
          downloadText(JSON.stringify(data), `${fileStem(session.project.name)}_session_backup.json`, 'application/json');
          toast('Backup downloaded. Restore it from the start page in any browser.');
        },
      },
      { label: 'Close session', icon: 'logOut', onSelect: () => closeSession() },
    ]);
  });

  function closeSession() {
    const s = store.get().session;
    s?.flushMeta();
    history.replaceState(null, '', location.pathname + location.search);
    store.set({ session: null, stored: null, route: parseHash('') });
  }

  function paintHeader(state: State) {
    const brand = h(
      'button',
      { type: 'button', class: 'brand', title: state.session ? 'Back to your sessions' : undefined, onclick: () => state.session && closeSession() },
      icon('logo', { class: 'brand-mark' }),
      h('span', { class: 'brand-name' }, 'Gold Standard Resolver'),
    );
    if (!state.session) {
      render(header, brand, h('div', { class: 'header-actions' }, themeBtn));
      return;
    }
    const s = state.session;
    const p = s.project;
    const sessionInfo = h(
      'div',
      { class: 'brand-session', title: p.schema.title },
      h('strong', null, p.name),
      h('span', null, `${fmtInt(p.records.length)} records · ${plural(p.sources.length, 'abstraction')}`),
    );
    const nav = h(
      'nav',
      { class: 'app-nav', 'aria-label': 'Views' },
      NAV.map((n) =>
        withTooltip(
          h('a', { href: buildHash(n.view), 'aria-current': state.route.view === n.view ? 'page' : undefined, dataset: { view: n.view } }, icon(n.icon), h('span', null, n.label)),
          n.hint,
        ),
      ),
    );
    paintProgress(s);
    paintBlind(s);
    paintSave(s);
    render(
      header,
      h('div', { class: 'brand-group' }, brand, h('span', { class: 'brand-sep' }), sessionInfo),
      nav,
      h('div', { class: 'header-actions' }, progressBtn, blindBtn, saveDot, exportBtn, menuBtn, themeBtn),
    );
  }

  function paintNav(view: ViewName) {
    for (const a of header.querySelectorAll<HTMLAnchorElement>('.app-nav a')) {
      if (a.dataset.view === view) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
  }

  // -------------------------------------------------------------- views
  function destroyViews() {
    for (const { view } of instances.values()) view.destroy?.();
    instances.clear();
    loading.clear();
    render(main);
  }

  async function ensureView(name: ViewName, session: Session, stored: StoredSession): Promise<void> {
    if (instances.has(name)) return;
    if (!loading.has(name)) {
      loading.set(
        name,
        (async () => {
          const wrap = h('div', { class: 'view', dataset: { view: name } }, h('div', { class: 'empty' }, h('div', { class: 'spinner' })));
          main.appendChild(wrap);
          try {
            const mod = await LOADERS[name]();
            if (current !== session) return;
            const view = mod.default({ store, session, stored });
            render(wrap, view.el);
            instances.set(name, { view, wrap, pending: new Set() });
          } catch (err) {
            console.error(err);
            render(wrap, h('div', { class: 'empty' }, h('strong', null, 'This view failed to load.'), String((err as Error).message ?? err)));
          }
        })(),
      );
    }
    await loading.get(name);
  }

  async function showView(state: State) {
    const { session, stored } = state;
    if (!session || !stored) return;
    const name = state.route.view;
    paintNav(name);
    hideTooltip();
    for (const wrap of main.querySelectorAll<HTMLElement>('.view')) wrap.hidden = wrap.dataset.view !== name;
    const fresh = !instances.has(name);
    await ensureView(name, session, stored);
    const inst = instances.get(name);
    if (!inst || store.get().route.view !== name) return;
    inst.wrap.hidden = false;
    const all = new Set<StateKey>(['session', 'stored', 'theme', 'mode', 'route']);
    const changed = fresh ? all : new Set([...inst.pending, 'route' as StateKey]);
    inst.pending.clear();
    inst.view.update(store.get(), changed);
    document.title = `${NAV.find((n) => n.view === name)!.label} · ${session.project.name} · Gold Standard Resolver`;
  }

  // ------------------------------------------------------------ lifecycle
  function onSession(state: State) {
    destroyViews();
    landing?.destroy();
    landing = null;
    unsubscribe?.();
    unsubscribe = null;
    if (current && current !== state.session) current.detach();
    current = state.session;
    saveError = null;
    tabSession.set(state.stored?.id ?? null);
    paintHeader(state);
    if (!state.session || !state.stored) {
      document.title = 'Gold Standard Resolver';
      landing = mountLanding(main, store);
      return;
    }
    const s = state.session;
    unsubscribe = s.subscribe((e: SessionEvent) => {
      if (e.type === 'cells' || (e.type === 'settings' && e.changed.some((k) => k !== 'blind' && k !== 'autoAdvance'))) paintProgress(s);
      if (e.type === 'settings' && e.changed.includes('blind')) paintBlind(s);
      if (e.type === 'saving') {
        if (e.error) {
          saveError = e.error;
          toast(`Could not save: ${e.error}`);
        } else if (!e.pending) {
          saveError = null;
          lastSaved = Date.now();
        }
        paintSave(s);
      }
    });
    // Default landing view: the record the adjudicator was on.
    if (!location.hash || location.hash === '#' || location.hash === '#/') {
      const cur = s.meta.cursor;
      navigate('adjudicate', cur ? [cur.record] : [], cur?.field ? { field: cur.field } : {}, true);
    }
    void showView(store.get());
  }

  store.subscribe((state, changed) => {
    if (changed.has('theme')) paintTheme(state.theme);
    if (changed.has('session')) {
      onSession(state);
      return;
    }
    if (!state.session) return;
    if (changed.has('route')) {
      void showView(state);
      changed.delete('route');
      if (!changed.size) return;
    }
    for (const [name, inst] of instances) {
      if (name === state.route.view && !inst.wrap.hidden) inst.view.update(state, changed);
      else for (const k of changed) inst.pending.add(k);
    }
  });

  window.addEventListener('hashchange', () => store.set({ route: parseHash(location.hash) }));
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener('change', () => store.set({ mode: currentMode() }));
  window.addEventListener('keydown', (e) => {
    if (e.key === '?' && !(e.target as HTMLElement)?.closest?.('input, textarea, select, [contenteditable]') && !document.querySelector('.dialog')) {
      e.preventDefault();
      openShortcuts();
    }
  });
  window.addEventListener('beforeunload', () => store.get().session?.flushMeta());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') store.get().session?.flushMeta();
  });

  onSession(store.get());
}
