import type { Clock } from '@anyfare/common';
import { createBlocklistMatcher } from '@anyfare/core';
import { createStatsRepository, type Database } from '@anyfare/db';

import { createSnapshotCache } from '../stats/live.js';

// The operator's blocklist, as the public reads match it: a host and every subdomain of it. It is small, so it is
// read whole, in one statement giving up after 2 s, and kept 5 s in the process: a host blocked shows nowhere
// public within seconds. A failed read is never kept.
export const blocklistCacheMs = 5_000;
export const blocklistReadTimeoutMs = 2_000;

/** Whether the blocklist names a host or a parent domain of it, as last read. Throws when it can't be read. */
export interface BlocklistCache {
  get(): Promise<(host: string) => boolean>;
}

export const createBlocklistCache = ({ db, clock }: { readonly db: Database; readonly clock: Clock }): BlocklistCache => {
  const store = createStatsRepository({ db });

  return createSnapshotCache({
    read: async () => createBlocklistMatcher(await store.blocklist({ timeoutMs: blocklistReadTimeoutMs })),
    clock,
    ttlMs: blocklistCacheMs,
  });
};
