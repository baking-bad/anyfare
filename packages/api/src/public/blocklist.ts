import type { Clock, Logger } from '@anyfare/common';
import { createBlocklistMatcher } from '@anyfare/core';
import { createStatsRepository, type Database } from '@anyfare/db';

import { StatsUnavailableError } from '../errors.js';

// The operator's blocklist, as the public reads match it: a host and every subdomain of it. It is small, so it is
// read whole, in one statement giving up after 2 s, and kept 5 s in the process: a host blocked shows nowhere
// public within seconds. A list longer than its bound is an error, logged once, and its first entries are used. When
// a read fails, the last good list serves for a minute while a read is tried again every few seconds; with none ever
// read, the public reads answer 503.
export const blocklistCacheMs = 5_000;
export const blocklistReadTimeoutMs = 2_000;
export const maxBlocklistEntries = 10_000;
export const blocklistStaleMs = 60_000;
export const blocklistRetryMs = 5_000;

/** Whether the blocklist names a host or a parent domain of it, as last read. Throws when it can't be read. */
export interface BlocklistCache {
  get(): Promise<(host: string) => boolean>;
}

export const createBlocklistCache = ({ db, clock, logger, read }: {
  readonly db: Database;
  readonly clock: Clock;
  readonly logger?: Pick<Logger, 'warn' | 'error'>;
  // Its first entries, at most `limit`. Default: from `db`.
  readonly read?: (limit: number) => Promise<readonly string[]>;
}): BlocklistCache => {
  const store = createStatsRepository({ db });
  const readEntries = read ?? (limit => store.blocklist({ limit, timeoutMs: blocklistReadTimeoutMs }));
  let kept: { readonly at: number; readonly match: (host: string) => boolean } | undefined;
  let failedAt: number | undefined;
  let reading: Promise<(host: string) => boolean> | undefined;
  let overLong = false;

  const refresh = async (now: number): Promise<(host: string) => boolean> => {
    try {
      // One past the bound, to know it is past it
      const entries = await readEntries(maxBlocklistEntries + 1);
      if (entries.length > maxBlocklistEntries && !overLong)
        logger?.error({ max: maxBlocklistEntries }, 'The blocklist is longer than the public reads match: its first entries are used');
      overLong = entries.length > maxBlocklistEntries;
      const match = createBlocklistMatcher(entries.slice(0, maxBlocklistEntries));
      kept = { at: now, match };
      failedAt = undefined;

      return match;
    }
    catch (error) {
      if (failedAt === undefined)
        logger?.warn({ error }, 'The blocklist couldn\'t be read: the last one read serves for a minute');
      failedAt = now;
      if (kept && now - kept.at < blocklistStaleMs)
        return kept.match;
      throw new StatsUnavailableError('The blocklist can\'t be read right now: try again shortly', { cause: error });
    }
    finally {
      reading = undefined;
    }
  };

  return {
    get: () => {
      const now = clock.now().getTime();
      if (kept && now - kept.at < blocklistCacheMs)
        return Promise.resolve(kept.match);
      // A read failed a moment ago: the last good list until the pause is over, while it is no older than a minute
      if (kept && failedAt !== undefined && now - failedAt < blocklistRetryMs && now - kept.at < blocklistStaleMs)
        return Promise.resolve(kept.match);

      return reading ??= refresh(now);
    },
  };
};
