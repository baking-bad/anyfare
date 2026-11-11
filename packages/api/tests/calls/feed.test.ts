import { setTimeout as sleep } from 'node:timers/promises';

import { afterEach, describe, expect, it } from 'vitest';

import { createLogger } from '@anyfare/common';
import type { CallRecord, CallRepository } from '@anyfare/db';
import { createFakeClock } from '@anyfare/testing';

import { createCallFeed, pollBatch, type CallFeed } from '../../src/calls/feed.js';

const start = Date.parse('2026-11-12T10:00:00.000Z');
const feeds: CallFeed[] = [];

afterEach(async () => {
  await Promise.all(feeds.splice(0).map(feed => feed.close()));
});

const call = (id: string, finishedAfterMs: number): CallRecord => ({
  id, rail: 'credits', status: 'captured', targetHost: 'api.example.com', targetPath: '/v1/x', network: undefined, asset: undefined, amount: 1_000n, fee: 0n,
  upstreamStatus: 200, upstreamLatencyMs: 10, transactionHash: undefined, createdAt: new Date(start), updatedAt: new Date(start + finishedAfterMs),
  details: undefined, leg: undefined,
});

// The final payments, as the index of final payments reads them
const createStore = () => {
  const rows: CallRecord[] = [];
  let reads = 0;
  let failures = 0;
  const store: Pick<CallRepository, 'finalizedAfter'> = {
    finalizedAfter: async ({ after, limit }) => {
      reads += 1;
      if (failures > 0) {
        failures -= 1;
        throw new Error('The database is down');
      }
      const time = after.updatedAt.getTime();

      return rows
        .filter(row => row.updatedAt.getTime() > time || (row.updatedAt.getTime() === time && row.id > after.id))
        .sort((left, right) => left.updatedAt.getTime() - right.updatedAt.getTime() || (left.id < right.id ? -1 : 1))
        .slice(0, limit);
    },
  };

  return {
    store,
    add: (...calls: CallRecord[]) => rows.push(...calls),
    get reads() {
      return reads;
    },
    failNext: (count: number) => {
      failures = count;
    },
  };
};

const lines: Record<string, unknown>[] = [];
const logger = createLogger({}, { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) });

const feedOn = (store: Pick<CallRepository, 'finalizedAfter'>, pollMs = 5) => {
  const feed = createCallFeed({ calls: store, clock: createFakeClock(new Date(start)), logger, pollMs });
  feeds.push(feed);
  const heard: string[] = [];
  const unsubscribe = feed.subscribe(row => heard.push(row.id));

  return { feed, heard, unsubscribe };
};

describe('the feed of finished calls', () => {
  it('hands out each call that becomes final once, and none from before it started', async () => {
    const calls = createStore();
    calls.add(call('pay_before', -1_000));
    const { heard } = feedOn(calls.store);

    calls.add(call('pay_after', 1_000));
    await expect.poll(() => heard).toEqual(['pay_after']);
    const reads = calls.reads;
    await expect.poll(() => calls.reads).toBeGreaterThan(reads + 3);

    expect(heard).toEqual(['pay_after']);
  });

  it('picks up a call written late, with a last update before one already handed out', async () => {
    const calls = createStore();
    const { heard } = feedOn(calls.store);
    calls.add(call('pay_late_b', 3_000));
    await expect.poll(() => heard).toEqual(['pay_late_b']);

    calls.add(call('pay_late_a', 1_000));

    await expect.poll(() => heard).toEqual(['pay_late_b', 'pay_late_a']);
  });

  it('follows on at once from a full read, so a burst comes out whole and once each, within one poll', async () => {
    const calls = createStore();
    calls.add(...Array.from({ length: pollBatch * 2 + 5 }, (_, index) => call(`pay_burst_${String(index).padStart(4, '0')}`, 1_000)));
    // A poll long enough to tell: waiting one after each full read takes two more
    const pollMs = 1_000;
    const { heard } = feedOn(calls.store, pollMs);

    await expect.poll(() => heard.length, { timeout: 5_000 }).toBeGreaterThan(0);
    const first = performance.now();
    await expect.poll(() => heard.length, { timeout: 5_000 }).toBe(pollBatch * 2 + 5);

    expect(performance.now() - first).toBeLessThan(pollMs / 2);
    expect(new Set(heard).size).toBe(heard.length);
    expect(calls.reads).toBe(3);
  });

  it('never lets a writer whose clock runs fast move the reads past other writers\' calls', async () => {
    const calls = createStore();
    const { heard } = feedOn(calls.store);
    // An hour ahead of our clock
    calls.add(call('pay_fast_clock', 3_600_000));
    await expect.poll(() => heard).toEqual(['pay_fast_clock']);

    calls.add(call('pay_true_clock', 2_000));

    await expect.poll(() => heard).toEqual(['pay_fast_clock', 'pay_true_clock']);
  });

  it('stops reading when nobody listens', async () => {
    const calls = createStore();
    const { unsubscribe } = feedOn(calls.store);
    await expect.poll(() => calls.reads).toBeGreaterThan(1);

    unsubscribe();
    await sleep(20);
    const reads = calls.reads;
    await sleep(50);

    expect(calls.reads).toBe(reads);
  });

  it('logs a failing read once, keeps reading, and says when it reads again', async () => {
    const calls = createStore();
    lines.length = 0;
    calls.failNext(3);
    const { heard } = feedOn(calls.store);
    calls.add(call('pay_after_outage', 1_000));

    await expect.poll(() => heard).toEqual(['pay_after_outage']);

    expect(lines.filter(line => line['msg'] === 'Finished calls couldn\'t be read. The stream retries every poll.')).toHaveLength(1);
    expect(lines.filter(line => line['msg'] === 'Finished calls are read again')).toHaveLength(1);
  });
});
