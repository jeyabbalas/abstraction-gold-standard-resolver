/**
 * Minimal DOM builder. Text children are always inserted as text nodes (never
 * parsed as HTML), so values from uploaded files are safe to pass straight in.
 */

export type Child = Node | string | number | null | undefined | false | Child[];

type Handler = (event: never) => void;

export interface Attrs {
  class?: string | (string | false | null | undefined)[] | Record<string, boolean | undefined>;
  style?: string | Partial<Record<string, string | number>>;
  dataset?: Record<string, string | number | undefined>;
  [key: string]: unknown;
}

export function cx(value: Attrs['class']): string {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.filter(Boolean).join(' ');
  return Object.entries(value)
    .filter(([, on]) => on)
    .map(([k]) => k)
    .join(' ');
}

/** Properties set directly rather than as attributes. */
const PROPS = new Set(['value', 'checked', 'disabled', 'selected', 'indeterminate', 'hidden', 'open', 'tabIndex']);

function applyAttrs(el: Element, attrs: Attrs | null | undefined): void {
  if (!attrs) return;
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) {
      if (PROPS.has(key) && value === false) (el as unknown as Record<string, unknown>)[key] = false;
      continue;
    }
    if (key === 'class') {
      const c = cx(value as Attrs['class']);
      if (c) el.setAttribute('class', c);
    } else if (key === 'style') {
      if (typeof value === 'string') el.setAttribute('style', value);
      else {
        const style = (el as HTMLElement).style;
        for (const [prop, v] of Object.entries(value as Record<string, string | number>)) {
          if (v === undefined || v === null) continue;
          if (prop.startsWith('--')) style.setProperty(prop, String(v));
          else (style as unknown as Record<string, string>)[prop] = typeof v === 'number' ? `${v}px` : v;
        }
      }
    } else if (key === 'dataset') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (v !== undefined) (el as HTMLElement).dataset[k] = String(v);
      }
    } else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (PROPS.has(key)) {
      (el as unknown as Record<string, unknown>)[key] = value;
    } else if (value === true) {
      el.setAttribute(key, '');
    } else {
      el.setAttribute(key, String(value));
    }
  }
}

export function append(parent: Node, ...children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(parent, ...child);
    else if (child instanceof Node) parent.appendChild(child);
    else parent.appendChild(document.createTextNode(String(child)));
  }
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Attrs | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  applyAttrs(el, attrs);
  append(el, ...children);
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export function s<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs?: Record<string, string | number | undefined> | null,
  ...children: (SVGElement | string | null | undefined | false)[]
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs ?? {})) if (v !== undefined) el.setAttribute(k, String(v));
  for (const c of children) {
    if (!c) continue;
    el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

/** Replace all children of `el`. */
export function render(el: Element, ...children: Child[]): void {
  el.replaceChildren();
  append(el, ...children);
}

/** Subscribe to an event and return the unsubscribe function. */
export function listen<K extends keyof WindowEventMap>(
  target: Window,
  type: K,
  fn: (e: WindowEventMap[K]) => void,
  opts?: AddEventListenerOptions,
): () => void;
export function listen<K extends keyof DocumentEventMap>(
  target: Document,
  type: K,
  fn: (e: DocumentEventMap[K]) => void,
  opts?: AddEventListenerOptions,
): () => void;
export function listen<K extends keyof HTMLElementEventMap>(
  target: HTMLElement,
  type: K,
  fn: (e: HTMLElementEventMap[K]) => void,
  opts?: AddEventListenerOptions,
): () => void;
export function listen(target: EventTarget, type: string, fn: Handler, opts?: AddEventListenerOptions): () => void {
  target.addEventListener(type, fn as EventListener, opts);
  return () => target.removeEventListener(type, fn as EventListener, opts);
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): (...args: A) => void {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (...args: A) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
