import type { StoredSession } from '../core/db';
import type { Session } from '../core/session';
import type { State, StateKey, Store } from '../state';

export interface ViewContext {
  store: Store;
  session: Session;
  stored: StoredSession;
}

export interface ViewInstance {
  el: HTMLElement;
  update(state: State, changed: Set<StateKey>): void;
  destroy?(): void;
}

export type ViewFactory = (ctx: ViewContext) => ViewInstance;
