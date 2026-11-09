/** Shared UI components. All text is inserted as text nodes. */

import { h, render, type Child } from './dom';
import { icon, type IconName } from './icons';

// ---------------------------------------------------------------- segmented

export interface SegmentOption<T extends string> {
  value: T;
  label: Child;
  title?: string;
  disabled?: boolean;
}

export interface Segmented<T extends string> {
  el: HTMLElement;
  set(value: T): void;
}

export function segmented<T extends string>(opts: {
  options: SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  label: string;
  size?: 'sm' | 'md';
}): Segmented<T> {
  let current = opts.value;
  const buttons = opts.options.map((o) =>
    h(
      'button',
      {
        type: 'button',
        title: o.title,
        disabled: o.disabled,
        'aria-pressed': String(o.value === current),
        onclick: () => {
          if (o.value === current) return;
          set(o.value);
          opts.onChange(o.value);
        },
      },
      o.label,
    ),
  );
  const el = h('div', { class: ['segmented', opts.size === 'sm' && 'sm'], role: 'group', 'aria-label': opts.label }, buttons);
  function set(value: T) {
    current = value;
    buttons.forEach((b, i) => b.setAttribute('aria-pressed', String(opts.options[i]!.value === value)));
  }
  return { el, set };
}

// ------------------------------------------------------------------ tooltip

let tooltipEl: HTMLDivElement | null = null;

function ensureTooltip(): HTMLDivElement {
  if (!tooltipEl) {
    tooltipEl = h('div', { class: 'tooltip', role: 'tooltip' });
    document.body.appendChild(tooltipEl);
  }
  return tooltipEl;
}

/** Show the shared tooltip near a point (client coordinates) or an element. */
export function showTooltip(at: { x: number; y: number } | Element, content: Child): void {
  const tip = ensureTooltip();
  render(tip, content);
  tip.classList.add('visible');
  const r = at instanceof Element ? at.getBoundingClientRect() : null;
  const x = r ? r.left + r.width / 2 : (at as { x: number }).x;
  const y = r ? r.bottom : (at as { y: number }).y;
  const tw = tip.offsetWidth;
  const th = tip.offsetHeight;
  let left = r ? x - tw / 2 : x + 14;
  let top = r ? y + 8 : y + 14;
  if (left + tw > window.innerWidth - 8) left = r ? window.innerWidth - tw - 8 : x - tw - 14;
  if (left < 8) left = 8;
  if (top + th > window.innerHeight - 8) top = r ? r.top - th - 8 : y - th - 14;
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}

export function hideTooltip(): void {
  tooltipEl?.classList.remove('visible');
}

/** Attach a hover/focus tooltip to an element. */
export function withTooltip<E extends HTMLElement>(el: E, content: Child | (() => Child)): E {
  const show = () => showTooltip(el, typeof content === 'function' ? content() : content);
  el.addEventListener('mouseenter', show);
  el.addEventListener('focus', show);
  el.addEventListener('mouseleave', hideTooltip);
  el.addEventListener('blur', hideTooltip);
  el.addEventListener('pointerdown', hideTooltip);
  return el;
}

export function infoTip(content: Child, label = 'More information'): HTMLButtonElement {
  return withTooltip(h('button', { type: 'button', class: 'info-tip', 'aria-label': label }, icon('info')), () =>
    h('div', { style: { maxWidth: '320px' } }, content),
  );
}

// -------------------------------------------------------------------- menu

export interface MenuItem {
  label: string;
  icon?: IconName;
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

export function openMenu(anchor: Element, items: (MenuItem | 'separator')[]): void {
  const spaced = items.some((it) => it !== 'separator' && it.icon);
  const menu = h(
    'div',
    { class: 'menu', role: 'menu' },
    items.map((it) =>
      it === 'separator'
        ? h('div', { class: 'menu-sep', role: 'separator' })
        : h(
            'button',
            {
              type: 'button',
              role: 'menuitem',
              class: it.danger ? 'danger' : undefined,
              disabled: it.disabled,
              onclick: () => {
                close();
                it.onSelect();
              },
            },
            it.icon ? icon(it.icon) : spaced ? h('span', { class: 'menu-icon-space', 'aria-hidden': 'true' }) : null,
            h('span', { class: 'menu-label' }, it.label),
            it.hint ? h('span', { class: 'menu-hint' }, it.hint) : null,
          ),
    ),
  );
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  const left = Math.min(window.innerWidth - menu.offsetWidth - 8, r.right - menu.offsetWidth);
  menu.style.left = `${Math.max(8, left)}px`;
  const top = r.bottom + 6 + menu.offsetHeight > window.innerHeight - 8 ? r.top - menu.offsetHeight - 6 : r.bottom + 6;
  menu.style.top = `${Math.max(8, top)}px`;
  (menu.querySelector('button:not(:disabled)') as HTMLButtonElement | null)?.focus();
  const buttons = () => [...menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
  const onDown = (e: Event) => {
    if (!menu.contains(e.target as Node)) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const list = buttons();
      const i = list.indexOf(document.activeElement as HTMLButtonElement);
      list[(i + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length]?.focus();
    }
  };
  setTimeout(() => {
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
  });
  function close() {
    menu.remove();
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
  }
}

// ------------------------------------------------------------------ dialogs

export interface DialogHandle {
  close(): void;
  el: HTMLElement;
}

/** Open dialogs, innermost last: only the top one answers Esc and Tab. */
const dialogStack: object[] = [];
/** True while a modal dialog is open (views pause their keyboard shortcuts). */
export const dialogOpen = (): boolean => dialogStack.length > 0;

export function openDialog(opts: {
  title: Child;
  body: Child;
  footer?: Child;
  wide?: boolean;
  onClose?: () => void;
  /** Element to focus first. */
  initialFocus?: () => HTMLElement | null;
}): DialogHandle {
  const closeBtn = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close' }, icon('x'));
  const panel = h(
    'div',
    { class: ['dialog', opts.wide && 'wide'], role: 'dialog', 'aria-modal': 'true' },
    h('div', { class: 'dialog-head' }, h('h2', null, opts.title), closeBtn),
    h('div', { class: 'dialog-body' }, opts.body),
    opts.footer ? h('div', { class: 'dialog-foot' }, opts.footer) : null,
  );
  const backdrop = h('div', { class: 'dialog-backdrop' }, panel);
  const previous = document.activeElement as HTMLElement | null;
  document.body.appendChild(backdrop);
  const token = {};
  dialogStack.push(token);
  requestAnimationFrame(() => backdrop.classList.add('open'));
  const onKey = (e: KeyboardEvent) => {
    if (dialogStack[dialogStack.length - 1] !== token) return;
    if (e.key === 'Escape') {
      e.stopImmediatePropagation();
      close();
    } else if (e.key === 'Tab') {
      // Keep focus inside the dialog.
      const focusable = [...panel.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter(
        (el) => !el.hasAttribute('disabled') && el.offsetParent !== null,
      );
      if (!focusable.length) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };
  document.addEventListener('keydown', onKey, true);
  backdrop.addEventListener('pointerdown', (e) => {
    if (e.target === backdrop) close();
  });
  closeBtn.addEventListener('click', () => close());
  setTimeout(() => (opts.initialFocus?.() ?? closeBtn).focus(), 0);
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    const at = dialogStack.indexOf(token);
    if (at >= 0) dialogStack.splice(at, 1);
    document.removeEventListener('keydown', onKey, true);
    backdrop.classList.remove('open');
    setTimeout(() => backdrop.remove(), 160);
    previous?.focus?.();
    opts.onClose?.();
  }
  return { close, el: panel };
}

/** A yes/no question. Resolves true when confirmed. */
export function confirmDialog(opts: { title: string; body: Child; confirm: string; cancel?: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    let answered = false;
    const ok = h('button', { type: 'button', class: ['btn', opts.danger ? 'btn-danger' : 'btn-primary'] }, opts.confirm);
    const cancel = h('button', { type: 'button', class: 'btn btn-ghost' }, opts.cancel ?? 'Cancel');
    const d = openDialog({
      title: opts.title,
      body: h('div', { class: 'confirm-body' }, opts.body),
      footer: [cancel, ok],
      initialFocus: () => ok,
      onClose: () => {
        if (!answered) resolve(false);
      },
    });
    ok.addEventListener('click', () => {
      answered = true;
      resolve(true);
      d.close();
    });
    cancel.addEventListener('click', () => d.close());
  });
}

// ----------------------------------------------------------- badges, labels

export type Tone = 'critical' | 'serious' | 'warning' | 'good' | 'neutral' | 'outline' | 'accent';

export function badge(text: Child, tone: Tone = 'neutral', iconName?: IconName): HTMLSpanElement {
  return h('span', { class: ['badge', tone !== 'neutral' && tone] }, iconName ? icon(iconName) : null, text);
}

export function emptyState(opts: { icon?: IconName; title: Child; body?: Child; action?: Child }): HTMLElement {
  return h(
    'div',
    { class: 'empty' },
    opts.icon ? icon(opts.icon) : null,
    h('strong', null, opts.title),
    opts.body ? h('div', null, opts.body) : null,
    opts.action ?? null,
  );
}

export function callout(tone: 'warning' | 'critical' | 'good' | 'info', content: Child): HTMLElement {
  const iconName: IconName = tone === 'good' ? 'checkCircle' : tone === 'info' ? 'info' : 'alert';
  return h('div', { class: ['callout', tone !== 'info' && tone], role: tone === 'critical' ? 'alert' : undefined }, icon(iconName), h('div', null, content));
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(message: Child, opts: { action?: { label: string; run: () => void }; ms?: number } = {}): void {
  document.querySelector('.toast')?.remove();
  const el = h(
    'div',
    { class: 'toast', role: 'status' },
    h('span', null, message),
    opts.action
      ? h(
          'button',
          {
            type: 'button',
            class: 'toast-action',
            onclick: () => {
              el.remove();
              opts.action!.run();
            },
          },
          opts.action.label,
        )
      : null,
  );
  document.body.appendChild(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), opts.ms ?? (opts.action ? 5000 : 2600));
}

/** A small progress ring (SVG). */
export function ring(fraction: number, size = 18, stroke = 3): SVGSVGElement {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('class', 'ring');
  svg.setAttribute('aria-hidden', 'true');
  const f = Math.max(0, Math.min(1, fraction));
  // Static markup with numeric values only.
  svg.innerHTML = `<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke-width="${stroke}" class="ring-track"/><circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke-width="${stroke}" class="ring-fill" stroke-linecap="round" stroke-dasharray="${(c * f).toFixed(2)} ${c.toFixed(2)}" transform="rotate(-90 ${size / 2} ${size / 2})"/>`;
  return svg;
}

// ---------------------------------------------------------------- downloads

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function downloadText(text: string, filename: string, type = 'text/plain'): void {
  downloadBlob(new Blob([text], { type }), filename);
}

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied to clipboard');
  } catch {
    toast('Copy failed — your browser blocked clipboard access');
  }
}

/** Is the event target a text-entry element (where single-key shortcuts must not fire)? */
export function isTyping(e: Event): boolean {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
}

export function kbd(...keys: string[]): HTMLElement {
  return h('span', { class: 'kbds' }, keys.map((k) => h('kbd', null, k)));
}
