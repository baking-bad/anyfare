import { once } from 'node:events';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createLogger, Secret } from '@anyfare/common';
import { createTestRedis, type TestRedis } from '@anyfare/testing';

import { createRedis, createRedisReplayStore, RedisNotReadyError, type Redis } from '../../src/index.js';

let redis: TestRedis;
// A second connection with the same prefix: another proxy replica on the same Redis
let replica: Redis;

beforeAll(async () => {
  redis = await createTestRedis();
  replica = createRedis({ url: redis.url, logger: createLogger({ level: 'silent' }), prefix: redis.prefix });
  await once(replica.client, 'ready');
});

afterAll(async () => {
  await replica?.close();
  await redis?.cleanup();
});

const inOneMinute = () => Date.now() + 60_000;
// A claim's expiry is our clock's time, which Redis reads against its own: they may differ by this
// much either way, as with a Redis in a VM whose clock lags for a moment
const maxClockSkewMs = 1_000;

describe('the replay store', () => {
  it('claims a credential once across replicas, under <prefix>mpp: until the claim expires', async () => {
    const first = createRedisReplayStore({ redis });
    const second = createRedisReplayStore({ redis: replica });
    const expires = inOneMinute();

    const claims = await Promise.all([first.tryClaim('mppx:charge:0xabc', expires), second.tryClaim('mppx:charge:0xabc', expires)]);

    expect([...claims].sort()).toEqual([false, true]);
    expect(await second.tryClaim('mppx:charge:0xabc', expires)).toBe(false);
    const key = `${redis.prefix}mpp:mppx:charge:0xabc`;
    expect(JSON.parse((await redis.client.get(key))!)).toEqual({ expires, type: 'mppx:replay' });
    const before = Date.now();
    const ttl = await redis.client.pTTL(key);
    const after = Date.now();
    // What's left of the minute by our clock, give or take the skew
    expect(ttl).toBeGreaterThanOrEqual(expires - after - maxClockSkewMs);
    expect(ttl).toBeLessThanOrEqual(expires - before + maxClockSkewMs);
  });

  it('claims a key again once the first claim has expired', async () => {
    const store = createRedisReplayStore({ redis });

    const expires = Date.now() + 50;
    expect(await store.tryClaim('mppx:charge:0xdef', expires)).toBe(true);

    // Claimable again once Redis's clock passes the expiry, at most the skew after ours does
    await vi.waitFor(async () => expect(await store.tryClaim('mppx:charge:0xdef', inOneMinute())).toBe(true), {
      timeout: expires - Date.now() + maxClockSkewMs + 500, interval: 20,
    });
  });

  it('claims a released key again at once, on any replica', async () => {
    const first = createRedisReplayStore({ redis });
    const second = createRedisReplayStore({ redis: replica });
    const key = 'x402:eip155:84532:0xnonce';

    expect(await first.tryClaim(key, inOneMinute())).toBe(true);
    expect(await second.tryClaim(key, inOneMinute())).toBe(false);
    await first.release(key);

    expect(await redis.client.exists(`${redis.prefix}mpp:${key}`)).toBe(0);
    expect(await second.tryClaim(key, inOneMinute())).toBe(true);
    expect(await first.tryClaim(key, inOneMinute())).toBe(false);
  });

  it('releases a key nobody holds without an error', async () => {
    const store = createRedisReplayStore({ redis });

    await expect(store.release('x402:eip155:84532:0xunknown')).resolves.toBeUndefined();
    expect(await store.tryClaim('x402:eip155:84532:0xunknown', inOneMinute())).toBe(true);
  });

  it('refuses a claim without a valid expiry', async () => {
    const store = createRedisReplayStore({ redis });

    await expect(store.tryClaim('mppx:charge:0x1', Number.NaN)).rejects.toThrow(RangeError);
    await expect(store.tryClaim('mppx:charge:0x1', 0)).rejects.toThrow(RangeError);
  });

  it('gets, puts, and deletes JSON values', async () => {
    const store = createRedisReplayStore({ redis });

    expect(await store.get('value')).toBeNull();
    await store.put('value', { count: 1, tags: ['a'] });
    expect(await replica.client.get(`${redis.prefix}mpp:value`)).toBe('{"count":1,"tags":["a"]}');
    expect(await store.get('value')).toEqual({ count: 1, tags: ['a'] });
    await store.delete('value');
    expect(await store.get('value')).toBeNull();
  });

  it('updates atomically across replicas: no change is lost', async () => {
    const first = createRedisReplayStore({ redis });
    const second = createRedisReplayStore({ redis: replica });
    const increment = (store: typeof first) => store.update('counter', current => ({
      op: 'set' as const,
      value: (typeof current === 'number' ? current : 0) + 1,
      result: undefined,
    }));

    try {
      await Promise.all(Array.from({ length: 20 }, (_, index) => increment(index % 2 === 0 ? first : second)));

      expect(await first.get('counter')).toBe(20);
      expect(await first.update('counter', current => ({ op: 'noop', result: current }))).toBe(20);
      expect(await second.update('counter', () => ({ op: 'delete', result: 'gone' }))).toBe('gone');
      expect(await first.get('counter')).toBeNull();
    }
    finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  it('throws RedisNotReadyError at once while Redis is disconnected, so nothing is taken unclaimed', async () => {
    const closed = createRedis({ url: Secret.from('redis://127.0.0.1:1'), logger: createLogger({ level: 'silent' }), prefix: redis.prefix });
    const store = createRedisReplayStore({ redis: closed });

    try {
      await expect(store.tryClaim('mppx:charge:0x2', inOneMinute())).rejects.toThrow(RedisNotReadyError);
      await expect(store.get('value')).rejects.toThrow(RedisNotReadyError);
      await expect(store.update('value', () => ({ op: 'noop', result: undefined }))).rejects.toThrow(RedisNotReadyError);
      await expect(store.release('mppx:charge:0x2')).rejects.toThrow(RedisNotReadyError);
    }
    finally {
      await closed.close();
    }
  });
});
