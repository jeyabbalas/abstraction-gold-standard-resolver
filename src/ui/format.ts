/** Number and text formatting shared by every view. */

const MINUS = '−';

/** Metric in [0, 1] with fixed decimals (3 by default, as scores.txt prints). */
export function fmtMetric(x: number | null | undefined, digits = 3): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return '—';
  return x.toFixed(digits);
}

export function fmtPct(x: number | null | undefined, digits = 1): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return '—';
  return `${(x * 100).toFixed(digits)}%`;
}

const intFmt = new Intl.NumberFormat('en-US');
export function fmtInt(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return intFmt.format(Math.round(n));
}

const compactFmt = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
export function fmtCompact(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return compactFmt.format(n);
}

/** Durations: 42.1 s, 12m 05s, 1h 04m. */
export function fmtDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ${String(Math.round(seconds % 60)).padStart(2, '0')}s`;
  const hrs = Math.floor(m / 60);
  return `${hrs}h ${String(m % 60).padStart(2, '0')}m`;
}

/** Interval as "[0.991, 0.998]". */
export function fmtCI(lo: number | null | undefined, hi: number | null | undefined, digits = 3): string {
  if (lo === null || lo === undefined || hi === null || hi === undefined) return '';
  return `[${fmtSigned(lo, digits, false)}, ${fmtSigned(hi, digits, false)}]`;
}

/** Signed value with a true minus sign; `plus` adds "+" to positives. */
export function fmtSigned(x: number | null | undefined, digits = 3, plus = true): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return '—';
  const v = Math.abs(x) < 0.5 * 10 ** -digits ? 0 : x;
  const body = Math.abs(v).toFixed(digits);
  if (v < 0) return `${MINUS}${body}`;
  return plus && v > 0 ? `+${body}` : body;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${fmtInt(n)} ${n === 1 ? one : many}`;
}

/** "Hysterectomy" stays; "BU_polyp" → "BU polyp" (only for prose, never for ids). */
export function humanize(name: string): string {
  return name.replace(/_/g, ' ');
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
