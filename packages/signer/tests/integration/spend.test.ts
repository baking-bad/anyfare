import { once } from 'node:events';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger, Secret, type MicroUsd } from '@anyfare/common';
import { closeRedisClient, createRedis, RedisNotReadyError, type Redis } from '@anyfare/db';
import { createTestRedis, type TestRedis } from '@anyfare/testing';

import { createRedisSpendLimits, spendKeyPrefix, type SpendWindowIds } from '../../src/spend.js';

let redis: TestRedis;

beforeAll(async () => {
  redis = await createTestRedis();
});

afterAll(async () => {
  await redis?.cleanup();
});

// Each test on networks of its own, so their counters never meet: the windows follow Redis's clock
let networks = 0;
const nextNetwork = (): string => {
  networks += 1;

  return `test:network-${networks}`;
};

// $0.06 an hour and $0.10 a day, unless a test says otherwise. A null hourly: no hourly limit.
const limits = ({ hourly = 60_000n as MicroUsd | null, daily = 100_000n as MicroUsd, on = redis as Redis } = {}) =>
  createRedisSpendLimits({ redis: on, hourly: hourly ?? undefined, daily });

const keysOf = (network: string, windows: SpendWindowIds) => ({
  hour: `${redis.prefix}${spendKeyPrefix}${network}:hour:${windows.hour}`,
  day: `${redis.prefix}${spendKeyPrefix}${network}:day:${windows.day}`,
});

// Redis's clock, as the windows read it
const redisWindows = async (): Promise<SpendWindowIds> => {
  const [seconds] = await redis.client.time();
  const now = Number(seconds);

  return { hour: Math.floor(now / 3_600), day: Math.floor(now / 86_400) };
};

describe('the spend limits per network in Redis', () => {
  it('adds each amount to the hour and the day, and refuses one that would pass the hour\'s limit', async () => {
    const network = nextNetwork();
    const spend = limits();

    expect(await spend.reserve({ network, amount: 50_000n })).toMatchObject({ refusal: undefined, hour: 50_000n, day: 50_000n });
    expect(await spend.reserve({ network, amount: 10_000n })).toMatchObject({ refusal: undefined, hour: 60_000n, day: 60_000n });
    expect(await spend.reserve({ network, amount: 1n })).toMatchObject({ refusal: 'hourly_limit', hour: 60_000n, day: 60_000n });
  });

  it('takes its windows from Redis\'s clock: the hours and days since the epoch, under <prefix>spend:<network>', async () => {
    const network = nextNetwork();
    const before = await redisWindows();

    const { windows } = await limits().reserve({ network, amount: 1_000n });

    const after = await redisWindows();
    expect([before.hour, after.hour]).toContain(windows.hour);
    expect([before.day, after.day]).toContain(windows.day);
    const keys = keysOf(network, windows);
    expect(await redis.client.get(keys.hour)).toBe('1000');
    expect(await redis.client.get(keys.day)).toBe('1000');
  });

  it('keeps the hour\'s counter for two hours and the day\'s for two days', async () => {
    const network = nextNetwork();
    const { windows } = await limits().reserve({ network, amount: 1_000n });
    const keys = keysOf(network, windows);

    expect(await redis.client.ttl(keys.hour)).toBeGreaterThan(7_000);
    expect(await redis.client.ttl(keys.hour)).toBeLessThanOrEqual(7_200);
    expect(await redis.client.ttl(keys.day)).toBeGreaterThan(172_000);
    expect(await redis.client.ttl(keys.day)).toBeLessThanOrEqual(172_800);
  });

  it('starts a new hour with an empty hour, and keeps the day\'s total across hours', async () => {
    const network = nextNetwork();
    const spend = limits();
    const { windows } = await spend.reserve({ network, amount: 60_000n });
    // The hour's counter gone, as when the clock hour turns
    await redis.client.del(keysOf(network, windows).hour);

    expect(await spend.reserve({ network, amount: 30_000n })).toMatchObject({ refusal: undefined, hour: 30_000n, day: 90_000n });
    expect(await spend.reserve({ network, amount: 20_000n })).toMatchObject({ refusal: 'daily_limit', hour: 30_000n, day: 90_000n });
  });

  it('checks the hour before the day', async () => {
    const network = nextNetwork();
    const spend = limits({ hourly: 60_000n, daily: 60_000n });
    await spend.reserve({ network, amount: 60_000n });

    expect((await spend.reserve({ network, amount: 1n })).refusal).toBe('hourly_limit');
  });

  it('has no hourly limit without one', async () => {
    const network = nextNetwork();
    const spend = limits({ hourly: null });

    expect(await spend.reserve({ network, amount: 100_000n })).toMatchObject({ refusal: undefined, hour: 100_000n, day: 100_000n });
    expect((await spend.reserve({ network, amount: 1n })).refusal).toBe('daily_limit');
  });

  it('adds nothing when it refuses', async () => {
    const network = nextNetwork();
    const spend = limits();
    await spend.reserve({ network, amount: 50_000n });

    for (let attempt = 0; attempt < 3; attempt += 1)
      expect((await spend.reserve({ network, amount: 20_000n })).refusal).toBe('hourly_limit');

    expect(await spend.reserve({ network, amount: 10_000n })).toMatchObject({ refusal: undefined, hour: 60_000n, day: 60_000n });
  });

  it('counts each network apart', async () => {
    const spend = limits();
    await spend.reserve({ network: nextNetwork(), amount: 60_000n });

    expect(await spend.reserve({ network: nextNetwork(), amount: 60_000n })).toMatchObject({ refusal: undefined, hour: 60_000n, day: 60_000n });
  });

  it('keeps counters under another key prefix apart, such as refills per asset, with a limit of their own', async () => {
    const name = nextNetwork();
    const refills = createRedisSpendLimits({ redis, hourly: undefined, daily: 20_000n, keyPrefix: 'refill:spend:' });
    await limits().reserve({ network: name, amount: 60_000n });

    const { refusal, day, windows } = await refills.reserve({ network: name, amount: 20_000n });

    expect({ refusal, day }).toEqual({ refusal: undefined, day: 20_000n });
    expect(await redis.client.get(`${redis.prefix}refill:spend:${name}:day:${windows.day}`)).toBe('20000');
    expect(await redis.client.get(keysOf(name, windows).day)).toBe('60000');
    expect((await refills.reserve({ network: name, amount: 1n })).refusal).toBe('daily_limit');
    await refills.release({ network: name, amount: 20_000n, windows });
    expect(await redis.client.get(`${redis.prefix}refill:spend:${name}:day:${windows.day}`)).toBe('0');
    expect(await redis.client.get(keysOf(name, windows).day)).toBe('60000');
  });

  it('never lets reservations racing from two connections pass a limit together', async () => {
    const network = nextNetwork();
    const second = redis.duplicate();
    await once(second, 'ready');
    const spends = [limits({ hourly: null }), limits({ hourly: null, on: { ...redis, client: second } })];
    try {
      const results = await Promise.all(Array.from({ length: 40 }, (_, index) => spends[index % 2]!.reserve({ network, amount: 7_000n })));
      const passed = results.filter(result => result.refusal === undefined);

      // $0.10 holds 14 of $0.007, and not a 15th
      expect(passed).toHaveLength(14);
      expect(results.filter(result => result.refusal === 'daily_limit')).toHaveLength(26);
      expect(Math.max(...passed.map(result => Number(result.day)))).toBe(98_000);
      expect(await redis.client.get(keysOf(network, passed[0]!.windows).day)).toBe('98000');
    }
    finally {
      await closeRedisClient(second);
    }
  });
});

describe('giving a reservation back', () => {
  it('takes the amount off both windows, so the next payment has it again', async () => {
    const network = nextNetwork();
    const spend = limits();
    await spend.reserve({ network, amount: 20_000n });
    const reserved = await spend.reserve({ network, amount: 40_000n });

    await spend.release({ network, amount: 40_000n, windows: reserved.windows });

    const keys = keysOf(network, reserved.windows);
    expect(await redis.client.get(keys.hour)).toBe('20000');
    expect(await redis.client.get(keys.day)).toBe('20000');
    expect(await spend.reserve({ network, amount: 40_000n })).toMatchObject({ refusal: undefined, hour: 60_000n });
    // Its expiry stays
    expect(await redis.client.ttl(keys.hour)).toBeGreaterThan(7_000);
  });

  it('never goes below 0, and leaves a counter that expired gone', async () => {
    const network = nextNetwork();
    const spend = limits();
    const { windows } = await spend.reserve({ network, amount: 1_000n });
    const keys = keysOf(network, windows);
    await redis.client.del(keys.day);

    await spend.release({ network, amount: 5_000n, windows });

    expect(await redis.client.get(keys.hour)).toBe('0');
    expect(await redis.client.ttl(keys.hour)).toBeGreaterThan(7_000);
    expect(await redis.client.exists(keys.day)).toBe(0);
  });

  it('counts in the windows of the reservation, not the current ones', async () => {
    const network = nextNetwork();
    const spend = limits();
    const { windows } = await spend.reserve({ network, amount: 10_000n });
    const earlier = { hour: windows.hour - 1, day: windows.day - 1 };
    await redis.client.set(keysOf(network, earlier).hour, '10000');

    await spend.release({ network, amount: 10_000n, windows: earlier });

    expect(await redis.client.get(keysOf(network, earlier).hour)).toBe('0');
    expect(await redis.client.get(keysOf(network, windows).hour)).toBe('10000');
  });
});

describe('adding a payment\'s other costs', () => {
  it('adds the amount to both windows without a limit, so the next reservation sees it', async () => {
    const network = nextNetwork();
    const spend = limits();
    const { windows } = await spend.reserve({ network, amount: 59_000n });

    await spend.add({ network, amount: 2_000n, windows });

    const keys = keysOf(network, windows);
    expect(await redis.client.get(keys.hour)).toBe('61000');
    expect(await redis.client.get(keys.day)).toBe('61000');
    expect(await redis.client.ttl(keys.day)).toBeGreaterThan(172_000);
    expect(await spend.reserve({ network, amount: 1n })).toMatchObject({ refusal: 'hourly_limit', hour: 61_000n });
  });
});

describe('while Redis is down', () => {
  it('fails at once, so nothing is signed', async () => {
    // Port 1 refuses connections, so the client keeps reconnecting
    const down = createRedis({ url: Secret.from('redis://127.0.0.1:1'), logger: createLogger({ level: 'silent' }) });
    const network = nextNetwork();
    const windows = await redisWindows();
    try {
      const spend = limits({ on: down });

      await expect(spend.reserve({ network, amount: 1_000n })).rejects.toThrow(RedisNotReadyError);
      await expect(spend.release({ network, amount: 1_000n, windows })).rejects.toThrow(RedisNotReadyError);
      await expect(spend.add({ network, amount: 1_000n, windows })).rejects.toThrow(RedisNotReadyError);
    }
    finally {
      await down.close();
    }
  });
});
