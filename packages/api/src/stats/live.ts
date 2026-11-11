import type { Clock } from '@anyfare/common';

import { StatsUnavailableError } from '../errors.js';

// How long the live numbers are kept in the process: a burst of readers costs one read
export const liveCacheMs = 10_000;
// After a failed read, how long the last good value is served before another read is tried
export const liveRetryMs = 5_000;

export interface LiveCache<TValue> {
  /**
   * The value read within the last `ttlMs`, else a new read, shared by every caller while it runs. When a
   * read fails, the last good value, until `retryMs` later; only without one does it throw.
   */
  get(): Promise<TValue>;
}

export const createLiveCache = <TValue>({ read, clock, ttlMs = liveCacheMs, retryMs = liveRetryMs }: {
  readonly read: (now: Date) => Promise<TValue>;
  readonly clock: Clock;
  readonly ttlMs?: number;
  readonly retryMs?: number;
}): LiveCache<TValue> => {
  let kept: { readonly at: number; readonly value: TValue } | undefined;
  let failedAt: number | undefined;
  let reading: Promise<TValue> | undefined;

  const refresh = async (now: Date): Promise<TValue> => {
    try {
      const value = await read(now);
      kept = { at: now.getTime(), value };
      failedAt = undefined;

      return value;
    }
    catch (error) {
      failedAt = now.getTime();
      if (kept)
        return kept.value;
      throw new StatsUnavailableError('The live numbers can\'t be read right now', { cause: error });
    }
    finally {
      reading = undefined;
    }
  };

  return {
    get: () => {
      const now = clock.now().getTime();
      if (kept && now - kept.at < ttlMs)
        return Promise.resolve(kept.value);
      // A read failed a moment ago: the last good value, until the pause is over
      if (kept && failedAt !== undefined && now - failedAt < retryMs)
        return Promise.resolve(kept.value);

      return reading ??= refresh(new Date(now));
    },
  };
};

export interface KeyedCache<TValue> {
  /**
   * The value read for `key` within the last `ttlMs`, else a new read, shared by every caller of the key
   * while it runs. A failed read is not kept. With `maxReading` reads of other keys running, it throws
   * StatsUnavailableError instead of starting another.
   */
  get(key: string, read: () => Promise<TValue>): Promise<TValue>;
}

/** At most `maxEntries` values, the oldest dropped first, and at most `maxReading` reads at once. */
export const createKeyedCache = <TValue>({ clock, ttlMs, maxEntries, maxReading }: {
  readonly clock: Clock;
  readonly ttlMs: number;
  readonly maxEntries: number;
  readonly maxReading: number;
}): KeyedCache<TValue> => {
  const kept = new Map<string, { readonly at: number; readonly value: TValue }>();
  const reading = new Map<string, Promise<TValue>>();

  return {
    get: (key, read) => {
      const now = clock.now().getTime();
      const found = kept.get(key);
      if (found && now - found.at < ttlMs)
        return Promise.resolve(found.value);
      const running = reading.get(key);
      if (running)
        return running;
      if (reading.size >= maxReading)
        return Promise.reject(new StatsUnavailableError('Too many public numbers are being read at once: try again shortly'));

      const promise = (async () => {
        try {
          const value = await read();
          kept.delete(key);
          kept.set(key, { at: now, value });
          while (kept.size > maxEntries)
            kept.delete(kept.keys().next().value!);

          return value;
        }
        finally {
          reading.delete(key);
        }
      })();
      reading.set(key, promise);

      return promise;
    },
  };
};
