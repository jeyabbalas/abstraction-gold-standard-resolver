/**
 * Seeded randomness for blind review: the order in which a conflict's values
 * are shown is a coin toss per conflict, reproducible from the session seed so
 * a value never changes place when the adjudicator comes back to it.
 */

import { fnv1a } from './util';

/** mulberry32: a small, fast 32-bit PRNG. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A fresh random 32-bit seed. */
export function newSeed(): number {
  const buf = new Uint32Array(1);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(buf);
  else buf[0] = Math.floor(Math.random() * 2 ** 32);
  return buf[0]!;
}

/** Fisher–Yates shuffle of a copy, driven by `rand`. */
export function shuffle<T>(items: readonly T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** The display permutation of `n` items for one cell: indexes into the original order. */
export function cellPermutation(seed: number, record: string, field: string, n: number): number[] {
  const rand = mulberry32(seed ^ fnv1a(`${record}\u0000${field}`));
  // Burn a few values so nearby seeds do not start alike.
  rand();
  rand();
  return shuffle(
    Array.from({ length: n }, (_, i) => i),
    rand,
  );
}
