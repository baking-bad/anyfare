import type { Clock } from '@anyfare/common';

/** One-time claims in memory, the shape of the payments package's ClaimStore port. */
export interface MemoryClaimStore {
  /** The claims held now, by key, with their expiry in milliseconds since the epoch. */
  readonly claims: ReadonlyMap<string, number>;
  tryClaim(key: string, expiresAtMs: number): Promise<boolean>;
  release(key: string): Promise<void>;
}

const systemClock: Clock = { now: () => new Date() };

/** A claim store for tests: the first claim of a key wins until it expires by the clock, or is released. */
export const createMemoryClaimStore = ({ clock = systemClock }: { readonly clock?: Clock } = {}): MemoryClaimStore => {
  const claims = new Map<string, number>();

  return {
    claims,
    tryClaim: async (key, expiresAtMs) => {
      const held = claims.get(key);
      if (held !== undefined && held > clock.now().getTime())
        return false;

      claims.set(key, expiresAtMs);
      return true;
    },
    release: async key => {
      claims.delete(key);
    },
  };
};
