/** Word-level diff of two strings (LCS over tokens), for showing how two text values differ. */

export interface DiffPart {
  type: 'same' | 'add' | 'del';
  text: string;
}

/** Words and the whitespace/punctuation between them, so the diff can be re-joined exactly. */
export function tokenize(s: string): string[] {
  return s.match(/[\p{L}\p{N}]+|\s+|[^\s\p{L}\p{N}]/gu) ?? [];
}

/**
 * Diff `a` → `b`: 'del' parts are only in `a`, 'add' parts only in `b`.
 * Falls back to a whole replacement for very long inputs.
 */
export function diffWords(a: string, b: string, maxTokens = 1500): DiffPart[] {
  const x = tokenize(a);
  const y = tokenize(b);
  if (x.length * y.length > maxTokens * maxTokens) {
    return [
      ...(a ? [{ type: 'del' as const, text: a }] : []),
      ...(b ? [{ type: 'add' as const, text: b }] : []),
    ];
  }
  const n = x.length;
  const m = y.length;
  // LCS lengths, row-major (n+1)×(m+1).
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * w + j] = x[i] === y[j] ? dp[(i + 1) * w + j + 1]! + 1 : Math.max(dp[(i + 1) * w + j]!, dp[i * w + j + 1]!);
    }
  }
  const out: DiffPart[] = [];
  const push = (type: DiffPart['type'], text: string) => {
    const last = out[out.length - 1];
    if (last && last.type === type) last.text += text;
    else out.push({ type, text });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      push('same', x[i]!);
      i += 1;
      j += 1;
    } else if (dp[(i + 1) * w + j]! >= dp[i * w + j + 1]!) {
      push('del', x[i]!);
      i += 1;
    } else {
      push('add', y[j]!);
      j += 1;
    }
  }
  while (i < n) push('del', x[i++]!);
  while (j < m) push('add', y[j++]!);
  // Whitespace-only changes between equal words read better as unchanged.
  return out.map((p) => (p.type !== 'same' && !p.text.trim() ? { type: 'same' as const, text: p.text } : p)).reduce<DiffPart[]>((acc, p) => {
    const last = acc[acc.length - 1];
    if (last && last.type === p.type) last.text += p.text;
    else acc.push({ ...p });
    return acc;
  }, []);
}

/** Share of `a`'s and `b`'s tokens they have in common (0–1), a rough similarity. */
export function similarity(a: string, b: string): number {
  const parts = diffWords(a, b);
  let same = 0;
  let total = 0;
  for (const p of parts) {
    const len = p.text.replace(/\s+/g, '').length;
    if (p.type === 'same') {
      same += 2 * len;
      total += 2 * len;
    } else total += len;
  }
  return total ? same / total : 1;
}
