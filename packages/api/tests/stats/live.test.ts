import { describe, expect, it } from 'vitest';

import { createFakeClock } from '@anyfare/testing';

import { StatsUnavailableError } from '../../src/errors.js';
import { createKeyedCache, createLiveCache } from '../../src/stats/live.js';

const deferred = <TValue>() => {
  let resolve!: (value: TValue) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<TValue>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });

  return { promise, resolve, reject };
};

describe('the live numbers\' cache', () => {
  it('serves a burst of readers from one read, and reads again 10 seconds after', async () => {
    const clock = createFakeClock('2026-12-15T12:00:00.000Z');
    const reads: Date[] = [];
    const cache = createLiveCache({ read: async now => (reads.push(now), reads.length), clock });

    expect(await Promise.all([cache.get(), cache.get(), cache.get()])).toEqual([1, 1, 1]);
    clock.advance(9_999);
    expect(await cache.get()).toBe(1);
    clock.advance(1);
    expect(await cache.get()).toBe(2);
    expect(reads).toEqual([new Date('2026-12-15T12:00:00.000Z'), new Date('2026-12-15T12:00:10.000Z')]);
  });

  it('serves the last good value while a read fails, tries again only after a pause, and throws only with no value', async () => {
    const clock = createFakeClock('2026-12-15T12:00:00.000Z');
    let failing = true;
    let reads = 0;
    const cache = createLiveCache({
      read: async () => {
        reads += 1;
        if (failing)
          throw new Error('statement timeout');

        return reads;
      },
      clock,
    });

    // No value yet: the failure is the answer, and the next caller tries again at once
    await expect(cache.get()).rejects.toBeInstanceOf(StatsUnavailableError);
    failing = false;
    expect(await cache.get()).toBe(2);
    failing = true;
    clock.advance(10_000);
    expect(await cache.get()).toBe(2);
    // Within the pause after a failure: the last good value, no read
    clock.advance(4_999);
    expect(await cache.get()).toBe(2);
    expect(reads).toBe(3);
    clock.advance(1);
    failing = false;
    expect(await cache.get()).toBe(4);
  });

  it('shares a read in flight', async () => {
    const clock = createFakeClock('2026-12-15T12:00:00.000Z');
    const pending = deferred<number>();
    let reads = 0;
    const cache = createLiveCache({ read: () => (reads += 1, pending.promise), clock });

    const both = Promise.all([cache.get(), cache.get()]);
    pending.resolve(7);

    expect(await both).toEqual([7, 7]);
    expect(reads).toBe(1);
  });
});

describe('the cache of reads when asked for', () => {
  const setup = (changes: { maxEntries?: number; maxReading?: number } = {}) => {
    const clock = createFakeClock('2026-12-15T12:00:00.000Z');

    return { clock, cache: createKeyedCache<number>({ clock, ttlMs: 60_000, maxEntries: changes.maxEntries ?? 10, maxReading: changes.maxReading ?? 4 }) };
  };

  it('keeps a key\'s value for a minute, and shares one read per key in flight', async () => {
    const { clock, cache } = setup();
    let reads = 0;
    const read = async () => (reads += 1);

    expect(await Promise.all([cache.get('a', read), cache.get('a', read)])).toEqual([1, 1]);
    clock.advance(59_999);
    expect(await cache.get('a', read)).toBe(1);
    clock.advance(1);
    expect(await cache.get('a', read)).toBe(2);
    expect(await cache.get('b', read)).toBe(3);
  });

  it('keeps no failed read, and at most so many values, dropping the oldest first', async () => {
    const { cache } = setup({ maxEntries: 2 });
    let reads = 0;
    const read = async () => (reads += 1);

    await expect(cache.get('a', async () => {
      throw new Error('statement timeout');
    })).rejects.toThrow('statement timeout');
    expect(await cache.get('a', read)).toBe(1);
    await cache.get('b', read);
    await cache.get('c', read);
    // 'a' was the oldest: read again
    expect(await cache.get('a', read)).toBe(4);
    expect(await cache.get('c', read)).toBe(3);
  });

  it('refuses another key while so many reads run', async () => {
    const { cache } = setup({ maxReading: 1 });
    const pending = deferred<number>();

    const running = cache.get('a', () => pending.promise);
    await expect(cache.get('b', async () => 2)).rejects.toBeInstanceOf(StatsUnavailableError);
    // The same key shares the read
    const shared = cache.get('a', async () => 3);
    pending.resolve(1);

    expect([await running, await shared]).toEqual([1, 1]);
    expect(await cache.get('b', async () => 2)).toBe(2);
  });
});
