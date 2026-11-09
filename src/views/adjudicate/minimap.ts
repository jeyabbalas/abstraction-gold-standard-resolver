/**
 * A strip with one sliver per record, in record order: amber while it has
 * open cells, green once they are all resolved, faint when the sources
 * agreed on everything; a dot marks flags; the current record is outlined.
 * Hover names the record; click goes there.
 */

import type { Session } from '../../core/session';
import type { RecordKey } from '../../core/types';
import { hideTooltip, showTooltip } from '../../ui/components';
import { h } from '../../ui/dom';
import { fmtInt, plural } from '../../ui/format';

export interface Minimap {
  el: HTMLElement;
  paint(current: RecordKey | null, inFilter?: (r: RecordKey) => boolean): void;
  destroy(): void;
}

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export function createMinimap(session: Session, onPick: (record: RecordKey) => void): Minimap {
  const canvas = h('canvas', { class: 'minimap-canvas', 'aria-hidden': 'true' });
  const el = h('div', { class: 'minimap', role: 'img', 'aria-label': 'Records: open, resolved and agreed' }, canvas);
  const records = session.project.records;
  let current: RecordKey | null = null;
  let filter: ((r: RecordKey) => boolean) | undefined;

  function at(clientX: number): RecordKey | null {
    const box = canvas.getBoundingClientRect();
    if (!box.width || !records.length) return null;
    const i = Math.floor(((clientX - box.left) / box.width) * records.length);
    return records[Math.max(0, Math.min(records.length - 1, i))] ?? null;
  }

  function draw() {
    const box = el.getBoundingClientRect();
    const w = Math.max(40, Math.floor(box.width));
    const hgt = Math.max(10, Math.floor(box.height));
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(hgt * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${hgt}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hgt);
    const colors = {
      open: cssVar('--st-open', '#e8a317'),
      done: cssVar('--st-done', '#2f9e44'),
      agree: cssVar('--st-agree', '#e3e2dc'),
      flag: cssVar('--st-flag', '#e0592a'),
      ink: cssVar('--ink', '#0b0b0b'),
    };
    const n = records.length;
    const cw = w / n;
    const gap = cw >= 4 ? 1 : 0;
    const top = 3;
    const barH = hgt - 6;
    records.forEach((r, i) => {
      const s = session.summary(r);
      ctx.globalAlpha = filter && !filter(r) ? 0.35 : 1;
      ctx.fillStyle = s.review === 0 ? colors.agree : s.open > 0 ? colors.open : colors.done;
      const x = i * cw;
      ctx.fillRect(x, top, Math.max(1, cw - gap), barH);
      if (s.flagged) {
        ctx.fillStyle = colors.flag;
        ctx.fillRect(x, 0, Math.max(1, cw - gap), 2.5);
      }
    });
    ctx.globalAlpha = 1;
    const ci = current === null ? -1 : records.indexOf(current);
    if (ci >= 0) {
      const x = ci * cw;
      ctx.strokeStyle = colors.ink;
      ctx.lineWidth = 1.5;
      const cwide = Math.max(3, cw - gap);
      ctx.strokeRect(x - (cwide > cw ? (cwide - cw) / 2 : 0) + 0.75, 0.75, cwide - 1.5 + (cw < 3 ? 1 : 0), hgt - 1.5);
    }
  }

  canvas.addEventListener('mousemove', (e) => {
    const r = at(e.clientX);
    if (r === null) return;
    const s = session.summary(r);
    showTooltip(
      { x: e.clientX, y: e.clientY },
      h(
        'div',
        null,
        h('div', { class: 'tt-title' }, `Record ${r}`),
        h('div', null, s.review === 0 ? 'All sources agree' : s.open ? `${fmtInt(s.open)} of ${plural(s.review, 'cell')} open` : `${plural(s.review, 'cell')} resolved`),
        s.flagged ? h('div', null, plural(s.flagged, 'flag')) : null,
      ),
    );
  });
  canvas.addEventListener('mouseleave', hideTooltip);
  canvas.addEventListener('click', (e) => {
    const r = at(e.clientX);
    if (r !== null) onPick(r);
  });

  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => draw()) : null;
  ro?.observe(el);

  return {
    el,
    paint(cur, inFilter) {
      current = cur;
      filter = inFilter;
      draw();
    },
    destroy() {
      ro?.disconnect();
    },
  };
}
