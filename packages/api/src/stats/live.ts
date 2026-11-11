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

/**
 * One value read within the last `ttlMs`, else a new read, shared by every caller while it runs. A failed read is
 * never kept: each caller of it sees its error, and the next caller reads again.
 */
export const createSnapshotCache = <TValue>({ read, clock, ttlMs }: {
  readonly read: () => Promise<TValue>;
  readonly clock: Clock;
  readonly ttlMs: number;
}): { get(): Promise<TValue> } => {
  let kept: { readonly at: number; readonly value: TValue } | undefined;
  let reading: Promise<TValue> | undefined;

  return {
    get: () => {
      const now = clock.now().getTime();
      if (kept && now - kept.at < ttlMs)
        return Promise.resolve(kept.value);

      return reading ??= (async () => {
        try {
          const value = await read();
          kept = { at: now, value };

          return value;
        }
        finally {
          reading = undefined;
        }
      })();
    },
  };
};

export interface KeyedCache<TValue> {
  /**
   * The value read for `key` within the last `ttlMs`, else a new read, shared by every caller of the key
   * while it runs. A failed read is not kept, nor a value larger than `maxEntryBytes`. With `maxReading`
   * reads of other keys running, it throws StatsUnavailableError instead of starting another.
   */
  get(key: string, read: () => Promise<TValue>): Promise<TValue>;
  // What it keeps now, as `sizeOf` measures it
  readonly bytes: number;
}

/**
 * At most `maxBytes` of values in all, as `sizeOf` measures them: the expired dropped first, then the
 * oldest. At most `maxReading` reads at once.
 */
export const createKeyedCache = <TValue>({ clock, ttlMs, maxBytes, maxEntryBytes, maxReading, sizeOf }: {
  readonly clock: Clock;
  readonly ttlMs: number;
  readonly maxBytes: number;
  readonly maxEntryBytes: number;
  readonly maxReading: number;
  readonly sizeOf: (value: TValue) => number;
}): KeyedCache<TValue> => {
  // In the order they were kept, oldest first
  const kept = new Map<string, { readonly at: number; readonly value: TValue; readonly bytes: number }>();
  const reading = new Map<string, Promise<TValue>>();
  let bytes = 0;
  const drop = (key: string): void => {
    bytes -= kept.get(key)?.bytes ?? 0;
    kept.delete(key);
  };

  return {
    get: (key, read) => {
      const now = clock.now().getTime();
      const found = kept.get(key);
      if (found && now - found.at < ttlMs)
        return Promise.resolve(found.value);
      if (found)
        drop(key);
      const running = reading.get(key);
      if (running)
        return running;
      if (reading.size >= maxReading)
        return Promise.reject(new StatsUnavailableError('Too many public numbers are being read at once: try again shortly'));

      const promise = (async () => {
        try {
          const value = await read();
          const size = sizeOf(value);
          if (size > maxEntryBytes)
            return value;
          // The expired first, then the oldest, until it fits
          for (const [other, entry] of kept) {
            if (now - entry.at >= ttlMs)
              drop(other);
          }
          while (bytes + size > maxBytes && kept.size > 0)
            drop(kept.keys().next().value!);
          kept.set(key, { at: now, value, bytes: size });
          bytes += size;

          return value;
        }
        finally {
          reading.delete(key);
        }
      })();
      reading.set(key, promise);

      return promise;
    },
    get bytes() {
      return bytes;
    },
  };
};
