import { createHash } from 'node:crypto';

import { withTimeout, type Clock, type LogSink, type MicroUsd } from '@anyfare/common';
import { rateLimitClient } from '@anyfare/core';
import { maxCheckedEndpointsPerHost, maxCheckedPathLength, RedisNotReadyError, type Redis, type RoutingRepository } from '@anyfare/db';

import type { CheckMethod } from './check.js';
import type { EndpointRegistrar, ListingOutcome } from './support.js';

// A payable check lists its endpoint, through the registrar a paid call registers with, and says whether
// it is listed, without waiting for the listing: anyone can check a link they own, so what it may add is
// capped. The proxy reads only what it must to answer, by keys, in a statement of its own on the shared
// pool, never while the pool has no connection to spare. The internal API keeps the caps per host, per
// parent domain and in all, under its locks.

/** A host name a check lists: at most 253 characters and a port. */
const maxHostLength = 259;
// A path of printable ASCII, without a query: a check's comes from a parsed URL, so it always is
const listablePath = /^\/[\x21-\x3e\x40-\x7e]*$/;

/** At most this many new hosts a day per client: an IPv4 address, or an IPv6 /64. */
export const newHostsPerClient = 20;
const dayS = 86_400;

/** The per-client limit of hosts a client's checks add to the checked pool, shared by every replica. */
export interface NewHostLimit {
  /**
   * Whether the client may add this host today: true when it added it already today, whatever became of that,
   * or has room for one more of its 20. Throws when it can't tell.
   */
  admit(client: string, host: string): Promise<boolean>;
}

/**
 * The limit in Redis: a set per client of the hosts it added, each as a digest, at most 20, gone a day after
 * its first. One that gets past 20 in a race takes itself out again.
 */
export const createNewHostLimit = ({ redis }: { readonly redis: Redis }): NewHostLimit => ({
  admit: async (client, host) => {
    if (!redis.client.isReady)
      throw new RedisNotReadyError();
    const key = `${redis.prefix}rl:proxy:newHosts:${client}`;
    const member = createHash('sha256').update(host).digest('hex').slice(0, 32);
    // A host it added already passes, even while a racing 21st is in the set for a moment
    const [added, size] = await redis.client.multi().sAdd(key, member).sCard(key).expire(key, dayS, 'NX').exec() as unknown as [number, number, number];
    if (added === 0 || size <= newHostsPerClient)
      return true;
    await redis.client.sRem(key, member);

    return false;
  },
});

export interface CheckListingOptions {
  readonly registrar: Pick<EndpointRegistrar, 'list' | 'lists'>;
  readonly endpoints: Pick<RoutingRepository, 'endpointListing'>;
  readonly newHosts: NewHostLimit;
  // Whether the database pool has no connection to spare: then nothing is read, and nothing listed
  readonly busy: () => boolean;
  readonly clock: Clock;
  // How long a listing's answer stands, so a burst of checks of one link is one write. Default: a minute.
  readonly refreshMs?: number;
  // The endpoints whose answer it keeps, by a digest of their host and path
  readonly maxEntries?: number;
  // Reads in flight at once, in the whole process
  readonly maxReading?: number;
  // The read's statement timeout on the database, and how long the listing waits for it, or for the limit
  readonly timeoutMs?: number;
  // How long a check waits for the listing's answer: past it, `listed` is false and the listing goes on
  readonly answerMs?: number;
}

export const checkListingDefaults = { refreshMs: 60_000, maxEntries: 10_000, maxReading: 2, timeoutMs: 1_000, answerMs: 150 } as const;

export interface ListingRequest {
  readonly host: string;
  readonly path: string;
  readonly method: CheckMethod;
  // Our quote, as the endpoint's price
  readonly quote: MicroUsd;
  readonly ip: string;
  readonly requestId: string;
  readonly log: LogSink;
}

/**
 * Whether a payable check's endpoint is listed once its listing goes through: true when it was, or its
 * listing is on its way and nothing the proxy knows keeps it out; false when the blocklist (the host's name or
 * a parent domain's), a cap, the per-client limit of new hosts, a full queue, or a read not made in time keeps
 * it out. A host joining the checked pool, one the count doesn't store and no check reached before, costs its
 * client one of 20 a day, once; while Redis fails, nothing joins. The check waits for this at most `answerMs`,
 * and the listing goes on after it. Never throws.
 */
export const createCheckListing = ({
  registrar, endpoints, newHosts, busy, clock, refreshMs = checkListingDefaults.refreshMs, maxEntries = checkListingDefaults.maxEntries,
  maxReading = checkListingDefaults.maxReading, timeoutMs = checkListingDefaults.timeoutMs, answerMs = checkListingDefaults.answerMs,
}: CheckListingOptions) => {
  // In the order they were kept, oldest first
  const kept = new Map<string, { readonly at: number; readonly listed: boolean }>();
  const reading = new Map<string, Promise<boolean>>();

  const keep = (key: string, listed: boolean): void => {
    kept.delete(key);
    kept.set(key, { at: clock.now().getTime(), listed });
    while (kept.size > maxEntries)
      kept.delete(kept.keys().next().value!);
  };
  // How the listing ended: a cap or the blocklist stands until the answer is stale; anything but a listing is tried again
  const heard = (key: string) => (outcome: ListingOutcome): void => {
    if (outcome === 'capped')
      keep(key, false);
    else if (outcome !== 'listed')
      kept.delete(key);
  };

  const admits = async (client: string, host: string, log: LogSink): Promise<boolean> => {
    try {
      return await withTimeout(() => newHosts.admit(client, host), { timeoutMs });
    }
    catch (error) {
      log.warn({ error }, 'The new hosts\' limit couldn\'t be read, so the check lists no new host');

      return false;
    }
  };

  const decide = async (key: string, request: ListingRequest): Promise<boolean> => {
    const { host, path, log } = request;
    let state;
    try {
      state = await withTimeout(() => endpoints.endpointListing(host, path, { timeoutMs }), { timeoutMs });
    }
    catch (error) {
      log.warn({ error, host }, 'The endpoint\'s listing couldn\'t be read for the check: it lists nothing');

      return false;
    }
    // A host the blocklist names, or names a parent domain of; or a new endpoint on a host that holds its 20
    if (state.blocked || (state.status === undefined && state.checkedEndpoints >= maxCheckedEndpointsPerHost)) {
      keep(key, false);

      return false;
    }
    const client = rateLimitClient(request.ip);
    const joinsPool = !state.stored && !state.checkedHost;
    if (joinsPool && !await admits(client, host, log))
      return false;
    const queued = registrar.list(
      { host, path, quote: request.quote, method: request.method, mayAddHost: joinsPool },
      { client, requestId: request.requestId, onOutcome: heard(key) },
    );
    if (queued)
      keep(key, true);

    return queued;
  };

  // The decision, or false once the check has waited long enough: the decision goes on
  const inTime = (pending: Promise<boolean>): Promise<boolean> => new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), answerMs);
    timer.unref();
    void pending.then(listed => {
      clearTimeout(timer);
      resolve(listed);
    });
  });

  const list = async (request: ListingRequest): Promise<boolean> => {
    const { host, path } = request;
    if (!registrar.lists() || host.length > maxHostLength || path.length > maxCheckedPathLength || !listablePath.test(path))
      return false;
    const key = createHash('sha256').update(`${host} ${path}`).digest('hex');
    const hit = kept.get(key);
    if (hit && clock.now().getTime() - hit.at < refreshMs)
      return hit.listed;
    let pending = reading.get(key);
    if (!pending) {
      if (reading.size >= maxReading || busy())
        return false;
      pending = decide(key, request).catch(() => false);
      reading.set(key, pending);
      const done = (): void => {
        if (reading.get(key) === pending)
          reading.delete(key);
      };
      pending.then(done, done);
    }

    return inTime(pending);
  };

  return { list, kept: (): number => kept.size };
};

export type CheckListing = ReturnType<typeof createCheckListing>;
