import { describe, expect, it } from 'vitest';

import type { Logger } from '@anyfare/common';
import type { Database } from '@anyfare/db';
import { createFakeClock } from '@anyfare/testing';

import { StatsUnavailableError } from '../../src/errors.js';
import { blocklistStaleMs, createBlocklistCache, maxBlocklistEntries } from '../../src/public/blocklist.js';

// The blocklist as the public reads match it, without a database: bounded, and kept through a failed read for a minute

const noon = new Date('2026-11-20T12:00:00.000Z');

const fixture = (entries: () => readonly string[] | Promise<readonly string[]>) => {
  const clock = createFakeClock(noon);
  const reads: number[] = [];
  const lines: string[] = [];
  const cache = createBlocklistCache({
    db: {} as Database, clock,
    logger: {
      warn: (_fields: unknown, message?: string) => {
        lines.push(`warn ${message}`);
      },
      error: (_fields: unknown, message?: string) => {
        lines.push(`error ${message}`);
      },
    } as Pick<Logger, 'warn' | 'error'>,
    read: async limit => {
      reads.push(limit);

      return entries();
    },
  });

  return { cache, clock, reads, lines };
};

describe('the blocklist the public reads match', () => {
  it('reads one past its bound, uses its first entries, and says so once, an error', async () => {
    const long = Array.from({ length: maxBlocklistEntries + 1 }, (_, index) => `blocked-${index}.example`);
    const { cache, clock, reads, lines } = fixture(() => long);

    const isBlocked = await cache.get();
    clock.advance(5_000);
    await cache.get();

    expect(reads).toEqual([maxBlocklistEntries + 1, maxBlocklistEntries + 1]);
    expect([isBlocked('a.blocked-0.example'), isBlocked(`blocked-${maxBlocklistEntries - 1}.example`), isBlocked(`blocked-${maxBlocklistEntries}.example`)])
      .toEqual([true, true, false]);
    expect(lines).toEqual(['error The blocklist is longer than the public reads match: its first entries are used']);
  });

  it('serves the last list read for a minute while a read fails, tries again every few seconds, and then answers that it can\'t', async () => {
    let failing = false;
    const { cache, clock, reads, lines } = fixture(() => {
      if (failing)
        throw new Error('canceling statement due to statement timeout');

      return ['evil.example'];
    });

    expect((await cache.get())('a.evil.example')).toBe(true);
    failing = true;
    clock.advance(5_000);
    // Read again, failed: the last list
    expect((await cache.get())('a.evil.example')).toBe(true);
    clock.advance(1_000);
    // Within the pause: no read
    expect((await cache.get())('a.evil.example')).toBe(true);
    expect(reads).toHaveLength(2);
    clock.advance(blocklistStaleMs - 6_000);
    // A minute after the last good read: none to serve
    await expect(cache.get()).rejects.toBeInstanceOf(StatsUnavailableError);
    failing = false;
    clock.advance(1);
    expect((await cache.get())('b.evil.example')).toBe(true);
    expect(lines).toEqual(['warn The blocklist couldn\'t be read: the last one read serves for a minute']);
  });

  it('answers that it can\'t with no list ever read', async () => {
    const { cache } = fixture(() => {
      throw new Error('Connection terminated');
    });

    await expect(cache.get()).rejects.toBeInstanceOf(StatsUnavailableError);
  });
});
