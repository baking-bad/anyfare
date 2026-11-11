import { createHash } from 'node:crypto';

import { withTimeout, type Clock, type LogSink } from '@anyfare/common';
import { maxListedHostLength, maxListedPathLength, type EndpointNumbers } from '@anyfare/core';
import type { StatsRepository } from '@anyfare/db';

// An endpoint's numbers for `GET /_/check`, from what the workers counted. The read shares the proxy's
// database pool with paid calls, so it stays small: a cache in front, one read per endpoint at a time,
// a couple at most in the whole process, and none while the pool has no connection to spare.

/** An endpoint's paid calls through Anyfare over 30 days. */
export interface CheckStats {
  readonly calls: number;
  readonly buyers: number;
  readonly volume: string;
  readonly successRate: number | null;
  readonly p50Ms: number | null;
}

export const noStats: CheckStats = { calls: 0, buyers: 0, volume: '0', successRate: null, p50Ms: null };

const countOf = (value: unknown): number => Number.isFinite(value) ? Math.max(0, Math.round(value as number)) : 0;

/** A stored endpoint's numbers as a check shows them, each of the type the answer says. */
export const checkStatsOf = (numbers: EndpointNumbers | undefined): CheckStats => numbers === undefined
  ? noStats
  : {
    calls: countOf(numbers.calls),
    buyers: countOf(numbers.buyers),
    volume: typeof numbers.volume === 'string' ? numbers.volume.slice(0, 40) : '0',
    successRate: Number.isFinite(numbers.successRate) ? numbers.successRate : null,
    p50Ms: Number.isFinite(numbers.p50Ms) ? countOf(numbers.p50Ms) : null,
  };

export interface EndpointStatsOptions {
  readonly stats: Pick<StatsRepository, 'endpoint'>;
  // Whether the database pool has no connection to spare: a read would wait for one, so none starts
  readonly busy: () => boolean;
  readonly clock: Clock;
  // How long a read's numbers are kept. Default: a minute, about as often as the workers count.
  readonly ttlMs?: number;
  readonly maxEntries?: number;
  // The kept numbers' size, keys included, in characters
  readonly maxChars?: number;
  // Reads in flight at once, in the whole process
  readonly maxReading?: number;
  // A read's statement timeout on the database, and how long a check waits for it
  readonly timeoutMs?: number;
}

export const endpointStatsDefaults = { ttlMs: 60_000, maxEntries: 2_000, maxChars: 512 * 1024, maxReading: 2, timeoutMs: 1_000 } as const;

/**
 * An endpoint's numbers over 30 days: zeros for one the workers keep no row for, and null, at once, when
 * they can't be read now: the reads in flight are at their cap, the pool has no connection to spare, or
 * the read failed or took too long. Never a read of the payments. Kept by a digest of the host and path.
 */
export const createEndpointStats = ({
  stats, busy, clock, ttlMs = endpointStatsDefaults.ttlMs, maxEntries = endpointStatsDefaults.maxEntries, maxChars = endpointStatsDefaults.maxChars,
  maxReading = endpointStatsDefaults.maxReading, timeoutMs = endpointStatsDefaults.timeoutMs,
}: EndpointStatsOptions) => {
  const kept = new Map<string, { readonly stats: CheckStats; readonly expiresAt: number; readonly chars: number }>();
  const reading = new Map<string, Promise<CheckStats>>();
  let chars = 0;

  const drop = (key: string): void => {
    const entry = kept.get(key);
    if (entry) {
      kept.delete(key);
      chars -= entry.chars;
    }
  };
  // The oldest entries leave first, until both bounds hold
  const keep = (key: string, value: CheckStats): void => {
    drop(key);
    const size = key.length + JSON.stringify(value).length;
    kept.set(key, { stats: value, expiresAt: clock.now().getTime() + ttlMs, chars: size });
    chars += size;
    for (const oldest of kept.keys()) {
      if (kept.size <= maxEntries && chars <= maxChars)
        break;
      drop(oldest);
    }
  };

  /** A new read of the endpoint, counted among those in flight until it really ends, whoever waits for it. */
  const read = (key: string, host: string, path: string): Promise<CheckStats> => {
    const pending = stats.endpoint(host, path, { timeoutMs }).then(found => {
      const value = checkStatsOf(found?.row.recent['30d']);
      keep(key, value);

      return value;
    });
    reading.set(key, pending);
    const done = (): void => {
      if (reading.get(key) === pending)
        reading.delete(key);
    };
    pending.then(done, done);

    return pending;
  };

  const get = async (host: string, path: string, log: LogSink): Promise<CheckStats | null> => {
    // A longer host or path is counted, never stored
    if (host.length > maxListedHostLength || path.length > maxListedPathLength)
      return noStats;
    const key = createHash('sha256').update(`${host} ${path}`).digest('hex');
    const hit = kept.get(key);
    if (hit && hit.expiresAt > clock.now().getTime())
      return hit.stats;
    drop(key);
    let pending = reading.get(key);
    if (!pending) {
      if (reading.size >= maxReading || busy())
        return null;
      pending = read(key, host, path);
    }
    try {
      return await withTimeout(() => pending, { timeoutMs });
    }
    catch (error) {
      log.warn({ error, host }, 'The endpoint\'s numbers couldn\'t be read for the check: answered without them');

      return null;
    }
  };

  return { get, reading: (): number => reading.size };
};

export type EndpointStats = ReturnType<typeof createEndpointStats>;
