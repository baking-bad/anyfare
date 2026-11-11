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
  const setup = (changes: { maxBytes?: number; maxEntryBytes?: number; maxReading?: number } = {}) => {
    const clock = createFakeClock('2026-12-15T12:00:00.000Z');
    const cache = createKeyedCache<string>({
      clock, ttlMs: 60_000, maxBytes: changes.maxBytes ?? 1_000, maxEntryBytes: changes.maxEntryBytes ?? 500, maxReading: changes.maxReading ?? 4, sizeOf: value => value.length,
    });

    return { clock, cache };
  };

  it('keeps a key\'s value for a minute, and shares one read per key in flight', async () => {
    const { clock, cache } = setup();
    let reads = 0;
    const read = async () => `value-${reads += 1}`;

    expect(await Promise.all([cache.get('a', read), cache.get('a', read)])).toEqual(['value-1', 'value-1']);
    clock.advance(59_999);
    expect(await cache.get('a', read)).toBe('value-1');
    clock.advance(1);
    expect(await cache.get('a', read)).toBe('value-2');
    expect(await cache.get('b', read)).toBe('value-3');
  });

  it('keeps no failed read and no value over its size, and at most so many bytes, the expired dropped first, then the oldest', async () => {
    const { clock, cache } = setup({ maxBytes: 300, maxEntryBytes: 200 });
    let reads = 0;
    const sized = (size: number) => async () => {
      reads += 1;

      return 'x'.repeat(size);
    };

    await expect(cache.get('failed', async () => {
      throw new Error('statement timeout');
    })).rejects.toThrow('statement timeout');
    // Too large to keep: read every time
    await cache.get('large', sized(201));
    await cache.get('large', sized(201));
    expect([reads, cache.bytes]).toEqual([2, 0]);
    await cache.get('a', sized(100));
    await cache.get('b', sized(100));
    await cache.get('c', sized(100));
    expect(cache.bytes).toBe(300);
    // 'a' was the oldest: dropped to make room
    await cache.get('d', sized(100));
    expect(cache.bytes).toBe(300);
    await cache.get('a', sized(100));
    expect(reads).toBe(7);
    // Past their minute, the expired are dropped before any other
    clock.advance(60_000);
    await cache.get('e', sized(50));
    expect(cache.bytes).toBe(50);
  });

  it('refuses another key while so many reads run', async () => {
    const { cache } = setup({ maxReading: 1 });
    const pending = deferred<string>();

    const running = cache.get('a', () => pending.promise);
    await expect(cache.get('b', async () => 'b')).rejects.toBeInstanceOf(StatsUnavailableError);
    // The same key shares the read
    const shared = cache.get('a', async () => 'other');
    pending.resolve('a');

    expect([await running, await shared]).toEqual(['a', 'a']);
    expect(await cache.get('b', async () => 'b')).toBe('b');
  });
});
