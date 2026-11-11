import { describe, expect, it } from 'vitest';

import { createLogger, type Clock } from '@anyfare/common';
import type { EndpointNumbers } from '@anyfare/core';
import type { StatsRepository } from '@anyfare/db';

import { createEndpointStats, noStats, type EndpointStatsOptions } from '../../src/routing/checkStats.js';

const log = createLogger({ level: 'silent' });
const numbers: EndpointNumbers = { calls: 402, buyers: 33, volume: '4.02', successRate: 0.99, p50Ms: 340, byPaidWith: [] };
const stored = (recent: EndpointNumbers) => ({ row: { recent: { today: recent, '7d': recent, '30d': recent } }, marks: {} }) as never;

/** A clock the test moves, and a stats store whose reads the test answers, or never. */
const setup = (options: Partial<EndpointStatsOptions> = {}) => {
  let time = Date.parse('2026-11-12T09:00:00.000Z');
  const clock: Clock = { now: () => new Date(time) };
  const reads: { readonly host: string; readonly path: string; readonly timeoutMs: number | undefined; answer(value: unknown): void; fail(error: Error): void }[] = [];
  const stats: Pick<StatsRepository, 'endpoint'> = {
    endpoint: (host, path, read) => new Promise((resolve, reject) => {
      reads.push({ host, path, timeoutMs: read?.timeoutMs, answer: resolve as (value: unknown) => void, fail: reject });
    }),
  };
  const endpointStats = createEndpointStats({ stats, busy: () => false, clock, timeoutMs: 200, ...options });

  return { endpointStats, reads, tick: (ms: number) => { time += ms; } };
};

describe('an endpoint\'s numbers for a check', () => {
  it('are read with the statement timeout, kept a minute by host and path, and zeros for an endpoint with no row', async () => {
    const { endpointStats, reads, tick } = setup();

    const first = endpointStats.get('api.example.com', '/v1/pools', log);
    reads[0]!.answer(stored(numbers));
    expect(await first).toEqual({ calls: 402, buyers: 33, volume: '4.02', successRate: 0.99, p50Ms: 340 });
    expect(reads.map(read => [read.host, read.path, read.timeoutMs])).toEqual([['api.example.com', '/v1/pools', 200]]);
    tick(59_000);
    expect(await endpointStats.get('api.example.com', '/v1/pools', log)).toMatchObject({ calls: 402 });
    expect(reads).toHaveLength(1);

    tick(2_000);
    const again = endpointStats.get('api.example.com', '/v1/pools', log);
    reads[1]!.answer(undefined);
    expect(await again).toEqual(noStats);
  });

  it('share one read among the checks of one endpoint', async () => {
    const { endpointStats, reads } = setup();

    const both = Promise.all([endpointStats.get('api.example.com', '/v1/a', log), endpointStats.get('api.example.com', '/v1/a', log)]);
    reads[0]!.answer(stored(numbers));

    expect((await both).map(item => item?.calls)).toEqual([402, 402]);
    expect(reads).toHaveLength(1);
  });

  it('are null at once past two reads in flight, which count until they end, whoever stopped waiting', async () => {
    const { endpointStats, reads } = setup();

    const waiting = [endpointStats.get('a.example.com', '/v1', log), endpointStats.get('b.example.com', '/v1', log)];
    expect(await endpointStats.get('c.example.com', '/v1', log)).toBeNull();
    // The two waits give up after their timeout, and their reads still run
    expect(await Promise.all(waiting)).toEqual([null, null]);
    expect(await endpointStats.get('c.example.com', '/v1', log)).toBeNull();
    expect(reads).toHaveLength(2);

    reads[0]!.answer(stored(numbers));
    reads[1]!.fail(new Error('canceling statement due to statement timeout'));
    await new Promise(resolve => setImmediate(resolve));
    const next = endpointStats.get('c.example.com', '/v1', log);
    reads[2]!.answer(undefined);
    expect(await next).toEqual(noStats);
    // The answer that came late is kept; the failed one is read again
    expect(await endpointStats.get('a.example.com', '/v1', log)).toMatchObject({ calls: 402 });
    void endpointStats.get('b.example.com', '/v1', log);
    expect(reads).toHaveLength(4);
  });

  it('are null at once, and read nothing, while the pool has no connection to spare', async () => {
    const { endpointStats, reads } = setup({ busy: () => true });

    expect(await endpointStats.get('api.example.com', '/v1/pools', log)).toBeNull();
    expect(reads).toHaveLength(0);
  });

  it('keep at most their bounds, the oldest leaving first', async () => {
    const { endpointStats, reads } = setup({ maxEntries: 2 });
    for (const path of ['/v1/a', '/v1/b', '/v1/c']) {
      const pending = endpointStats.get('api.example.com', path, log);
      reads.at(-1)!.answer(stored(numbers));
      await pending;
    }

    void endpointStats.get('api.example.com', '/v1/c', log);
    expect(reads).toHaveLength(3);
    void endpointStats.get('api.example.com', '/v1/a', log);
    expect(reads).toHaveLength(4);

    const small = setup({ maxChars: 200 });
    for (const path of ['/v1/a', '/v1/b']) {
      const pending = small.endpointStats.get('api.example.com', path, log);
      small.reads.at(-1)!.answer(stored(numbers));
      await pending;
    }
    void small.endpointStats.get('api.example.com', '/v1/a', log);
    expect(small.reads).toHaveLength(3);
  });

  it('are zeros, without a read, for a host or path too long to be stored', async () => {
    const { endpointStats, reads } = setup();

    expect(await endpointStats.get('api.example.com', `/${'a'.repeat(2_048)}`, log)).toEqual(noStats);
    expect(await endpointStats.get(`${'a'.repeat(256)}.example.com`, '/v1', log)).toEqual(noStats);
    expect(reads).toHaveLength(0);
  });
});
