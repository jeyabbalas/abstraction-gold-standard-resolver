/** Application state, hash routing and theme preference. */

import type { StoredSession } from './core/db';
import type { Session } from './core/session';

export type ViewName = 'adjudicate' | 'overview' | 'dictionary';
export const VIEWS: readonly ViewName[] = ['adjudicate', 'overview', 'dictionary'];
export type ThemePref = 'auto' | 'light' | 'dark';
export type Mode = 'light' | 'dark';

export interface Route {
  view: ViewName;
  /** Path segments after the view, e.g. ['17'] for #/adjudicate/17. */
  path: string[];
  query: URLSearchParams;
}

export interface State {
  session: Session | null;
  stored: StoredSession | null;
  theme: ThemePref;
  mode: Mode;
  route: Route;
}

export type StateKey = keyof State;
export type Listener = (state: State, changed: Set<StateKey>) => void;

export class Store {
  private state: State;
  private listeners = new Set<Listener>();

  constructor(initial: State) {
    this.state = initial;
  }

  get(): State {
    return this.state;
  }

  set(patch: Partial<State>): void {
    const changed = new Set<StateKey>();
    for (const [k, v] of Object.entries(patch) as [StateKey, unknown][]) {
      if (this.state[k] !== v) changed.add(k);
    }
    if (!changed.size) return;
    this.state = { ...this.state, ...patch };
    for (const fn of [...this.listeners]) fn(this.state, changed);
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#\/?/, '');
  const [pathPart = '', queryPart = ''] = raw.split('?');
  const segs = pathPart.split('/').filter(Boolean).map(decodeURIComponent);
  const view = (VIEWS as readonly string[]).includes(segs[0] ?? '') ? (segs[0] as ViewName) : 'adjudicate';
  return { view, path: segs.slice(1), query: new URLSearchParams(queryPart) };
}

export function buildHash(view: ViewName, path: (string | number)[] = [], query: Record<string, string | undefined> = {}): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== '') q.set(k, v);
  const qs = q.toString();
  return `#/${[view, ...path.map((p) => encodeURIComponent(String(p)))].join('/')}${qs ? `?${qs}` : ''}`;
}

export function navigate(view: ViewName, path: (string | number)[] = [], query: Record<string, string | undefined> = {}, replace = false): void {
  const hash = buildHash(view, path, query);
  if (location.hash === hash) return;
  if (replace) history.replaceState(null, '', hash);
  else location.hash = hash;
  if (replace) window.dispatchEvent(new HashChangeEvent('hashchange'));
}

const PREFIX = 'gold-standard-resolver:';
const THEME_KEY = `${PREFIX}theme`;

export function loadThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === 'light' || v === 'dark' || v === 'auto') return v;
  } catch {
    /* storage unavailable */
  }
  return 'auto';
}

export function currentMode(): Mode {
  const t = document.documentElement.dataset.theme;
  if (t === 'light' || t === 'dark') return t;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyTheme(pref: ThemePref): Mode {
  if (pref === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = pref;
  try {
    localStorage.setItem(THEME_KEY, pref);
  } catch {
    /* storage unavailable */
  }
  return currentMode();
}

/** Small per-browser UI preferences (never data). */
export const prefs = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(PREFIX + key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string | null): void {
    try {
      if (value === null) localStorage.removeItem(PREFIX + key);
      else localStorage.setItem(PREFIX + key, value);
    } catch {
      /* storage unavailable */
    }
  },
};

/** The session open in this tab, so a reload reopens it (sessionStorage: per tab, never shared). */
export const tabSession = {
  get(): string | null {
    try {
      return sessionStorage.getItem(`${PREFIX}open`);
    } catch {
      return null;
    }
  },
  set(id: string | null): void {
    try {
      if (id === null) sessionStorage.removeItem(`${PREFIX}open`);
      else sessionStorage.setItem(`${PREFIX}open`, id);
    } catch {
      /* storage unavailable */
    }
  },
};
