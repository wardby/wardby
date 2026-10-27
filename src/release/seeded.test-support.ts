/**
 * A small seeded generator for the release suite's properties (no new dependency): mulberry32,
 * plus the few helpers the generators need. Every property runs a fixed number of cases from a
 * fixed seed, so a run is deterministic; WARDBY_RELEASE_SEED explores other seeds, and a failing
 * case names its seed and index so it can be replayed alone.
 */

export interface Rng {
  /** A float in [0, 1). */
  next(): number;
  /** An integer in [min, max], both included. */
  int(min: number, max: number): number;
  /** True with probability p. */
  bool(p?: number): boolean;
  pick<T>(items: readonly T[]): T;
  /** A new array in a random order. */
  shuffle<T>(items: readonly T[]): T[];
  /** `length` characters from `alphabet`. */
  string(length: number, alphabet?: string): string;
}

const BASE62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

export function rng(seed: number): Rng {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));
  return {
    next,
    int,
    bool: (p = 0.5) => next() < p,
    pick: <T>(items: readonly T[]) => {
      if (items.length === 0) throw new Error("rng.pick: no items");
      return items[int(0, items.length - 1)];
    },
    shuffle: <T>(items: readonly T[]) => {
      const out = [...items];
      for (let i = out.length - 1; i > 0; i--) {
        const j = int(0, i);
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },
    string: (length: number, alphabet = BASE62) =>
      Array.from({ length }, () => alphabet[int(0, alphabet.length - 1)]).join(""),
  };
}

/** The suite's base seed: fixed unless WARDBY_RELEASE_SEED names another. */
export function baseSeed(): number {
  const raw = process.env.WARDBY_RELEASE_SEED;
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : 20261019;
}

/**
 * Runs `property` on `cases` generated cases, case i seeded from (base seed, salt, i). A failure
 * is rethrown with the seed and case index, so `WARDBY_RELEASE_SEED=<seed>` replays it.
 */
export async function forAll(
  salt: string,
  cases: number,
  property: (r: Rng, index: number) => void | Promise<void>,
): Promise<number> {
  const seed = baseSeed();
  const saltHash = [...salt].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 7);
  for (let index = 0; index < cases; index++) {
    try {
      await property(rng((seed ^ saltHash) + index * 0x9e3779b1), index);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const wrapped = new Error(`${salt}: case ${index} of seed ${seed} failed: ${message}`);
      (wrapped as Error & { cause?: unknown }).cause = err;
      throw wrapped;
    }
  }
  return cases;
}
