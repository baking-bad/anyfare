import { describe, expect, it } from 'vitest';

import { createLogger, type MicroUsd } from '@anyfare/common';
import type { EndpointListing } from '@anyfare/db';
import { createFakeClock } from '@anyfare/testing';

import { createCheckListing, newHostsPerClient, type CheckListingOptions, type ListingRequest, type NewHostLimit } from '../../src/routing/listing.js';
import type { CheckedEndpoint, ListingOutcome } from '../../src/routing/support.js';

// A payable check's listing: what it reads, what it charges a client, what it sends, what it answers, and how
// long the check waits for it

const log = createLogger({ level: 'silent' });
const request = (changes: Partial<ListingRequest> = {}): ListingRequest => ({
  host: 'api.target.test', path: '/v1/pools', method: 'GET', quote: 1_100n as MicroUsd, ip: '198.51.100.7', requestId: 'req-listing-1', log, ...changes,
});
const unlisted: EndpointListing = { status: undefined, hostListed: false, checkedEndpoints: 0, stored: false, checkedHost: false, blocked: false, paidCapped: false };
const inPool: EndpointListing = { status: 'checked', hostListed: true, checkedEndpoints: 1, stored: false, checkedHost: true, blocked: false, paidCapped: false };
// A host the count stores, with an endpoint a check listed
const stored: EndpointListing = { ...inPool, stored: true };

interface Fixture {
  readonly reads: { host: string; path: string }[];
  readonly listed: { endpoint: CheckedEndpoint; client: string | undefined; onOutcome?: (outcome: ListingOutcome) => void }[];
  readonly admitted: string[];
  readonly clock: ReturnType<typeof createFakeClock>;
  readonly list: (input: ListingRequest) => Promise<boolean>;
}

/** The new hosts' limit as Redis keeps it, in memory: a set per client, 20 at most. */
const memoryLimit = (): NewHostLimit & { readonly asked: string[] } => {
  const sets = new Map<string, Set<string>>();
  const asked: string[] = [];

  return {
    asked,
    admit: async (client, host) => {
      asked.push(`${client} ${host}`);
      const set = sets.get(client) ?? new Set<string>();
      sets.set(client, set);
      if (set.has(host))
        return true;
      if (set.size >= newHostsPerClient)
        return false;
      set.add(host);

      return true;
    },
  };
};

const fixture = (options: {
  readonly state?: (host: string, path: string) => EndpointListing | Promise<EndpointListing>;
  readonly newHosts?: NewHostLimit;
  readonly queues?: boolean;
  readonly lists?: boolean;
  readonly busy?: () => boolean;
  readonly overrides?: Partial<CheckListingOptions>;
} = {}): Fixture => {
  const reads: Fixture['reads'] = [];
  const listed: Fixture['listed'] = [];
  const limit = options.newHosts ?? memoryLimit();
  const admitted: string[] = [];
  const clock = createFakeClock('2026-11-12T12:00:00.000Z');
  const listing = createCheckListing({
    registrar: {
      lists: () => options.lists ?? true,
      list: (endpoint, context) => {
        if (options.queues === false)
          return false;
        listed.push({ endpoint, client: context?.client, ...context?.onOutcome === undefined ? {} : { onOutcome: context.onOutcome } });

        return true;
      },
    },
    endpoints: {
      endpointListing: async (host, path) => {
        reads.push({ host, path });

        return options.state?.(host, path) ?? unlisted;
      },
    },
    newHosts: {
      admit: async (client, host) => {
        const allowed = await limit.admit(client, host);
        if (allowed)
          admitted.push(`${client} ${host}`);

        return allowed;
      },
    },
    busy: options.busy ?? (() => false),
    clock,
    ...options.overrides,
  });

  return { reads, listed, admitted, clock, list: listing.list };
};

const held = () => {
  let release!: () => void;
  const promise = new Promise<void>(resolve => {
    release = resolve;
  });

  return { promise, release };
};

describe('a payable check\'s listing', () => {
  it('lists a new endpoint of a new host, charging its client for the host, with our quote, the check\'s method and the client', async () => {
    const { list, reads, listed, admitted } = fixture();

    expect(await list(request({ method: 'POST' }))).toBe(true);

    expect(reads).toEqual([{ host: 'api.target.test', path: '/v1/pools' }]);
    expect(admitted).toEqual(['198.51.100.7 api.target.test']);
    expect(listed).toEqual([{
      endpoint: { host: 'api.target.test', path: '/v1/pools', quote: 1_100n, method: 'POST', mayAddHost: true }, client: '198.51.100.7', onOutcome: expect.any(Function),
    }]);
  });

  it('updates the time of a listed endpoint at most once a minute however often it is checked, charging its client only for a host in the pool', async () => {
    for (const [state, charged] of [[stored, false], [inPool, true]] as const) {
      const { list, reads, listed, admitted, clock } = fixture({ state: () => state });

      const answers = [await list(request()), await list(request()), await list(request())];
      clock.advance(59_999);
      answers.push(await list(request()));
      clock.advance(1);
      answers.push(await list(request()));

      expect(answers).toEqual([true, true, true, true, true]);
      expect(reads).toHaveLength(2);
      expect(listed.map(item => item.endpoint.mayAddHost)).toEqual([charged, charged]);
      // One of its 20 hosts a day, asked at each refresh, the second time at no cost
      expect(admitted).toEqual(charged ? ['198.51.100.7 api.target.test', '198.51.100.7 api.target.test'] : []);
    }
  });

  it('reads and lists once for a burst of checks of one link at once', async () => {
    const gate = held();
    const { list, reads, listed, admitted } = fixture({
      state: async () => {
        await gate.promise;

        return unlisted;
      },
    });

    const burst = Array.from({ length: 10 }, () => list(request()));
    gate.release();

    expect(await Promise.all(burst)).toEqual(Array.from({ length: 10 }, () => true));
    expect([reads.length, listed.length, admitted.length]).toEqual([1, 1, 1]);
  });

  it('charges every check of a host the count doesn\'t store, new to the pool or in it, one of a paid call outside the count included, and none of a stored one', async () => {
    const states: Record<string, EndpointListing> = {
      'pool.target.test': { ...unlisted, hostListed: true, checkedHost: true, checkedEndpoints: 3 },
      'stored.target.test': { ...unlisted, status: 'paid', hostListed: true, stored: true },
      'old-paid.target.test': { ...unlisted, status: 'paid', hostListed: true },
    };
    const { list, listed, admitted } = fixture({ state: host => states[host] ?? unlisted });

    for (const host of Object.keys(states))
      expect(await list(request({ host })), host).toBe(true);

    expect(admitted).toEqual(['198.51.100.7 pool.target.test', '198.51.100.7 old-paid.target.test']);
    expect(listed.map(item => [item.endpoint.host, item.endpoint.mayAddHost])).toEqual([
      ['pool.target.test', true], ['stored.target.test', false], ['old-paid.target.test', true],
    ]);
  });

  it('refreshes no host of the pool for a client past its 20 of the day, the pool\'s own hosts included', async () => {
    const { list, listed } = fixture({
      state: (host, path) => (host.startsWith('pool-') ? { ...inPool, status: path === '/v1/pools' ? 'checked' : undefined } : unlisted),
    });

    for (let index = 0; index < 20; index += 1)
      expect(await list(request({ host: `new-${index}.target.test` }))).toBe(true);

    // A host a check reached before is no free refresh, nor a new endpoint of it: its listed endpoint stays listed
    expect(await list(request({ host: 'pool-1.target.test', path: '/v1/new' }))).toBe(false);
    expect(await list(request({ host: 'pool-1.target.test' }))).toBe(true);
    expect(listed).toHaveLength(20);
  });

  it('lists no new endpoint of a host at its 1,000 paid ones, and says so for a minute, while one listed already still updates', async () => {
    const { list, reads, listed, clock } = fixture({
      state: (_host, path) => ({ ...stored, status: path === '/v1/listed' ? 'paid' : undefined, checkedEndpoints: 0, paidCapped: true }),
    });

    expect(await list(request({ path: '/v1/new' }))).toBe(false);
    expect(await list(request({ path: '/v1/new' }))).toBe(false);
    expect(await list(request({ path: '/v1/listed' }))).toBe(true);
    clock.advance(60_000);
    expect(await list(request({ path: '/v1/new' }))).toBe(false);

    expect(reads.map(read => read.path)).toEqual(['/v1/new', '/v1/listed', '/v1/new']);
    expect(listed.map(item => item.endpoint.path)).toEqual(['/v1/listed']);
  });

  it('lists nothing of a host of more than 8 labels, and says listed for an endpoint of one a paid call listed', async () => {
    const deep = Array.from({ length: 127 }, () => 'a').join('.');
    const { list, reads, listed } = fixture({ state: host => (host === deep ? { ...stored, status: 'paid' } : unlisted) });
    const named = (labels: number) => Array.from({ length: labels }, (_, index) => `l${index}`).join('.');

    expect(await list(request({ host: named(8) }))).toBe(true);
    expect(await list(request({ host: `${named(8)}:8443` }))).toBe(true);
    expect(await list(request({ host: named(9) }))).toBe(false);
    expect(await list(request({ host: deep }))).toBe(true);

    expect(reads.map(read => read.host)).toEqual([named(8), `${named(8)}:8443`, named(9), deep]);
    // Only those of 8 labels at most go to the internal API
    expect(listed.map(item => item.endpoint.host)).toEqual([named(8), `${named(8)}:8443`]);
  });

  it('says listed for an endpoint listed before, whether or not its refresh goes through: its client past its 20, or the pool full', async () => {
    const limit = memoryLimit();
    for (let index = 0; index < newHostsPerClient; index += 1)
      await limit.admit('198.51.100.7', `other-${index}.target.test`);
    const paidOutside = { ...unlisted, status: 'paid' as const, hostListed: true };
    const past = fixture({ newHosts: limit, state: () => paidOutside });
    const full = fixture({ state: () => paidOutside });

    // The client counted 20 hosts today: no refresh, and the endpoint is still listed
    expect(await past.list(request())).toBe(true);
    expect(past.listed).toEqual([]);
    // The internal API found no room in the pool: still listed, for the next minute too
    expect(await full.list(request())).toBe(true);
    full.listed[0]!.onOutcome?.('capped');
    expect(await full.list(request())).toBe(true);
    // A full queue sends nothing: still listed
    const queueFull = fixture({ queues: false, state: () => paidOutside });
    expect(await queueFull.list(request())).toBe(true);
    // A new endpoint the pool had no room for is not
    const fresh = fixture();
    expect(await fresh.list(request({ path: '/v1/new' }))).toBe(true);
    fresh.listed[0]!.onOutcome?.('capped');
    expect(await fresh.list(request({ path: '/v1/new' }))).toBe(false);
  });

  it('lists nothing of a host the blocklist names or names a parent domain of, nor a new endpoint of a host that holds 20, and says so for a minute', async () => {
    const { list, reads, listed, admitted, clock } = fixture({
      state: host => (host === 'a.evil.test' ? { ...unlisted, blocked: true } : { ...unlisted, hostListed: true, checkedHost: true, checkedEndpoints: 20 }),
    });

    expect(await list(request({ host: 'a.evil.test' }))).toBe(false);
    expect(await list(request({ host: 'full.target.test' }))).toBe(false);
    expect(await list(request({ host: 'a.evil.test' }))).toBe(false);
    clock.advance(60_000);
    expect(await list(request({ host: 'a.evil.test' }))).toBe(false);

    expect([reads.length, listed.length, admitted.length]).toEqual([3, 0, 0]);
  });

  it('lists the 20th new host of a client in a day and none after it, charging each host once whatever its paths, and retries free', async () => {
    const { list, listed, admitted } = fixture();

    const answers = [];
    for (let index = 0; index < 21; index += 1)
      answers.push(await list(request({ host: `host-${index}.target.test` })));
    // Another path of a host it added already: no charge, no refusal
    const again = await list(request({ host: 'host-3.target.test', path: '/v1/other' }));
    // A listing that failed, tried again: no second charge
    listed[0]!.onOutcome?.('failed');
    const retried = await list(request({ host: 'host-0.target.test' }));

    expect(answers).toEqual([...Array.from({ length: 20 }, () => true), false]);
    expect([again, retried]).toEqual([true, true]);
    expect(admitted.filter(entry => entry.endsWith('host-3.target.test'))).toHaveLength(2);
    expect(new Set(admitted).size).toBe(20);
    // Another client has 20 of its own
    expect(await list(request({ host: 'host-21.target.test', ip: '198.51.100.8' }))).toBe(true);
  });

  it('counts IPv6 clients per /64', async () => {
    const limit = memoryLimit();
    const { list } = fixture({ newHosts: limit });

    await list(request({ host: 'a.target.test', ip: '2001:db8:1:2:aaaa::1' }));
    await list(request({ host: 'b.target.test', ip: '2001:db8:1:2:bbbb::2' }));
    await list(request({ host: 'c.target.test', ip: '2001:db8:1:3::1' }));

    expect(limit.asked).toEqual(['2001:db8:1:2::/64 a.target.test', '2001:db8:1:2::/64 b.target.test', '2001:db8:1:3::/64 c.target.test']);
  });

  it('lists no host of the pool while the limit can\'t be read, new or not, and still updates one the count stores', async () => {
    const failing: NewHostLimit = { admit: async () => { throw new Error('Redis is down'); } };
    const down = fixture({ newHosts: failing });
    const pooled = fixture({ newHosts: failing, state: () => inPool });
    const counted = fixture({ newHosts: failing, state: () => stored });

    // A new host lists nothing; one a check listed before stays listed, with no refresh
    expect([await down.list(request()), await pooled.list(request())]).toEqual([false, true]);
    expect([down.listed, pooled.listed]).toEqual([[], []]);
    expect(await counted.list(request())).toBe(true);
    expect(counted.listed).toHaveLength(1);
  });

  it('lists nothing for a path past 512 characters, one with a query or not of printable ASCII, or a host past 259; and reads nothing for them', async () => {
    const { list, reads, listed } = fixture();

    // At each bound, and one past it
    expect(await list(request({ path: `/${'a'.repeat(511)}` }))).toBe(true);
    expect(await list(request({ host: `${'h'.repeat(254)}.test` }))).toBe(true);
    for (const path of [`/${'a'.repeat(512)}`, `/${'b'.repeat(2_999)}`, '/v1/x?token=1', '/v1/é', '/v1/a b'])
      expect(await list(request({ path })), path.slice(0, 20)).toBe(false);
    expect(await list(request({ host: `${'h'.repeat(255)}.test` }))).toBe(false);

    expect(reads).toHaveLength(2);
    expect(listed).toHaveLength(2);
  });

  it('reads and lists nothing without the internal API, while the pool has no connection to spare, or past two reads at once', async () => {
    const noApi = fixture({ lists: false });
    const busy = fixture({ busy: () => true });
    const gate = held();
    const crowded = fixture({
      state: async () => {
        await gate.promise;

        return unlisted;
      },
      overrides: { answerMs: 5_000 },
    });

    expect(await noApi.list(request())).toBe(false);
    expect(await busy.list(request())).toBe(false);
    const first = [crowded.list(request({ path: '/v1/a' })), crowded.list(request({ path: '/v1/b' }))];
    expect(await crowded.list(request({ path: '/v1/c' }))).toBe(false);
    gate.release();
    expect(await Promise.all(first)).toEqual([true, true]);

    expect([noApi.reads.length, busy.reads.length, crowded.reads.length]).toEqual([0, 0, 2]);
  });

  it('lists nothing when the read fails or takes past its timeout, and tries again at the next check', async () => {
    let calls = 0;
    const { list, listed } = fixture({
      state: async () => {
        calls += 1;
        if (calls === 1)
          throw new Error('Connection terminated unexpectedly');
        if (calls === 2)
          return new Promise<EndpointListing>(() => undefined);

        return unlisted;
      },
      overrides: { timeoutMs: 50, answerMs: 1_000 },
    });

    expect(await list(request())).toBe(false);
    expect(await list(request())).toBe(false);
    expect(await list(request())).toBe(true);
    expect(listed).toHaveLength(1);
  });

  it.each([
    ['the database\'s read', 'read'],
    ['the new hosts\' limit', 'limit'],
  ])('answers within 150 ms while %s stalls, false, and lists once it goes on', async (_case, stalled) => {
    const gate = held();
    const { list, listed } = fixture({
      state: async () => {
        if (stalled === 'read')
          await gate.promise;

        return unlisted;
      },
      newHosts: {
        admit: async () => {
          if (stalled === 'limit')
            await gate.promise;

          return true;
        },
      },
    });
    const started = performance.now();

    expect(await list(request())).toBe(false);
    const tookMs = performance.now() - started;
    gate.release();
    await new Promise(resolve => setTimeout(resolve, 20));

    expect(tookMs).toBeGreaterThanOrEqual(140);
    expect(tookMs).toBeLessThan(400);
    // The listing went on, and its answer stands for the next check
    expect(listed).toHaveLength(1);
    expect(await list(request())).toBe(true);
  });

  it('lists nothing when the queue is full, and tries again at the next check', async () => {
    const { list, reads } = fixture({ queues: false });

    expect(await list(request())).toBe(false);
    expect(await list(request())).toBe(false);
    expect(reads).toHaveLength(2);
  });

  it('keeps how a listing ended: a cap for a minute, a failure or a refusal not at all', async () => {
    const { list, listed, reads } = fixture({ state: () => ({ ...unlisted, hostListed: true, checkedHost: true }) });

    expect(await list(request({ path: '/v1/capped' }))).toBe(true);
    listed[0]!.onOutcome?.('capped');
    expect(await list(request({ path: '/v1/capped' }))).toBe(false);
    expect(await list(request({ path: '/v1/failed' }))).toBe(true);
    listed[1]!.onOutcome?.('failed');
    expect(await list(request({ path: '/v1/failed' }))).toBe(true);
    listed[2]!.onOutcome?.('refused');
    expect(await list(request({ path: '/v1/failed' }))).toBe(true);

    expect(reads.map(read => read.path)).toEqual(['/v1/capped', '/v1/failed', '/v1/failed', '/v1/failed']);
  });

  it('keeps at most its entries, the oldest leaving first', async () => {
    const { list, reads } = fixture({ state: () => inPool, overrides: { maxEntries: 2 } });

    for (const path of ['/v1/a', '/v1/b', '/v1/c', '/v1/c', '/v1/b', '/v1/a'])
      await list(request({ path }));

    expect(reads.map(read => read.path)).toEqual(['/v1/a', '/v1/b', '/v1/c', '/v1/a']);
  });
});
