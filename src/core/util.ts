/** Small helpers shared by the core modules. */

import type { Json } from './types';

export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
export const naturalCompare = (a: string, b: string): number => collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);

export const basename = (path: string): string => path.split('/').pop() ?? path;
export const dirname = (path: string): string => {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
};
export const stem = (path: string): string => basename(path).replace(/\.[^.]+$/, '');
export const extname = (path: string): string => {
  const m = /\.([^./]+)$/.exec(path);
  return m ? m[1]!.toLowerCase() : '';
};

/** JSON with object keys sorted, so equal values serialize equally. */
export function stableStringify(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
}

export const sameJson = (a: Json | undefined, b: Json | undefined): boolean => stableStringify(a) === stableStringify(b);

/** How a value reads in the interface: strings as they are, everything else as JSON. */
export function displayValue(value: Json | undefined): string {
  if (value === undefined) return '(no value)';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

export const collapseWs = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** Hex SHA-256 of a text, or a 64-bit FNV-1a fallback where Web Crypto is unavailable. */
export async function hashText(text: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    try {
      const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text));
      return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    } catch {
      /* fall through */
    }
  }
  return `fnv-${fnv1a(text).toString(16)}`;
}

/** 32-bit FNV-1a. */
export function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function uid(prefix = ''): string {
  const rand = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}${rand}`;
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/** Escape a string for use in a RegExp. */
export const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function groupBy<T, K>(items: Iterable<T>, key: (item: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    let list = out.get(k);
    if (!list) out.set(k, (list = []));
    list.push(item);
  }
  return out;
}
