/**
 * Seeded, deterministic PRNG (S4): xmur3 string hash feeding mulberry32.
 * Same seed string => identical number sequence => identical track.
 */

/** xmur3 string hash: returns a generator producing 32-bit seeds. */
function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

/** Deterministic float generator in [0, 1) for a seed string. */
export function createRng(seed: string): () => number {
  const seeder = xmur3(seed);
  let a = seeder();
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform integer in [min, max] (inclusive). */
export function randInt(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

/** Pick a random element. */
export function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)];
}

/** True with probability p. */
export function chance(rng: () => number, p: number): boolean {
  return rng() < p;
}
