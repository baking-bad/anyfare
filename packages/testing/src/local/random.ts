// A seeded random source, so the seed makes the same data every run.

export interface SeededRandom {
  /** A number in [0, 1). */
  next(): number;
  /** An integer in [0, bound). */
  int(bound: number): number;
  /** An integer in [from, to]. */
  between(from: number, to: number): number;
  pick<TItem>(items: readonly TItem[]): TItem;
  /** An index drawn by weight. */
  weighted(weights: readonly number[]): number;
  bytes(size: number): Uint8Array;
  hex(length: number): string;
  /** Shuffles a copy. */
  shuffle<TItem>(items: readonly TItem[]): TItem[];
}

/** mulberry32: small, fast, and the same sequence for the same seed. */
export const createSeededRandom = (seed: number): SeededRandom => {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);

    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
  const int = (bound: number): number => Math.floor(next() * bound);
  const bytes = (size: number): Uint8Array => Uint8Array.from({ length: size }, () => int(256));

  return {
    next,
    int,
    between: (from, to) => from + int(to - from + 1),
    pick: items => items[int(items.length)]!,
    weighted: weights => {
      const total = weights.reduce((sum, weight) => sum + weight, 0);
      let point = next() * total;
      for (const [index, weight] of weights.entries()) {
        point -= weight;
        if (point < 0)
          return index;
      }

      return weights.length - 1;
    },
    bytes,
    hex: length => Array.from(bytes(Math.ceil(length / 2)), byte => byte.toString(16).padStart(2, '0')).join('').slice(0, length),
    shuffle: items => {
      const copy = [...items];
      for (let index = copy.length - 1; index > 0; index--) {
        const other = int(index + 1);
        [copy[index], copy[other]] = [copy[other]!, copy[index]!];
      }

      return copy;
    },
  };
};
