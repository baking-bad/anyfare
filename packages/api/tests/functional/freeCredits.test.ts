import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger, type Clock, type Server } from '@anyfare/common';
import { loadPlatformConfig, type PlatformConfig, type RateLimiter } from '@anyfare/core';
import { auditLog, createRedisRateLimiter, ledgerTransactions, RedisNotReadyError } from '@anyfare/db';
import { createFakeClock, createTestDatabase, createTestRedis, type TestDatabase, type TestRedis } from '@anyfare/testing';

import { createApp } from '../../src/app.js';

const base64 = (yaml: string) => Buffer.from(yaml).toString('base64');
// The example config with the gift as given, and a sign-up limit no test reaches unless it says so
const loadConfig = (freeCredits: string, signup = '{ requests: 1000, windowSeconds: 60 }') => loadPlatformConfig({
  env: { CONFIG_PATH: 'config/example.yaml', CONFIG: base64(`rateLimits:\n  signup: ${signup}\nfreeCredits: ${freeCredits}\n`) },
});

interface Started {
  readonly url: string;
  readonly metricsUrl: string;
  readonly logs: Record<string, unknown>[];
}

interface Signup {
  readonly status: number;
  readonly body: { readonly id: string; readonly masterKey: string; readonly freeCredits: string };
}

let database: TestDatabase;
let redis: TestRedis;
const servers: Server[] = [];

beforeAll(async () => {
  [database, redis] = await Promise.all([createTestDatabase(), createTestRedis()]);
});

afterAll(async () => {
  await Promise.all(servers.map(server => server.close()));
  await Promise.all([database?.drop(), redis?.cleanup()]);
});

// Behind a trusted proxy on 127.0.0.1, so X-Forwarded-For gives the client IP
const start = async (config: PlatformConfig, { clock, limiter }: { clock?: Clock; limiter?: RateLimiter } = {}): Promise<Started> => {
  const logs: Record<string, unknown>[] = [];
  const logger = createLogger({}, { write: (line: string) => logs.push(JSON.parse(line) as Record<string, unknown>) });
  const server = createApp({ config, logger, postgres: database.postgres, redis, trustProxy: '127.0.0.1', clock, limiter });
  servers.push(server);
  const { port, metricsPort } = await server.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 });

  return { url: `http://127.0.0.1:${port}`, metricsUrl: `http://127.0.0.1:${metricsPort}/metrics`, logs };
};

const signup = async (app: Started, ip: string): Promise<Signup> => {
  const response = await fetch(`${app.url}/v1/accounts`, { method: 'POST', headers: { 'x-forwarded-for': ip } });

  return { status: response.status, body: await response.json() as Signup['body'] };
};

const balanceOf = async (app: Started, masterKey: string): Promise<unknown> =>
  (await fetch(`${app.url}/v1/balance`, { headers: { authorization: `Bearer ${masterKey}` } })).json();

const ledgerOperationsOf = async (accountId: string): Promise<string[]> =>
  (await database.db.select().from(ledgerTransactions).where(eq(ledgerTransactions.reference, accountId))).map(row => row.operation);

const counted = (key: string) => redis.client.get(`${redis.prefix}rl:${key}`);

// api_free_credits_total by result, from the metrics listener
const decisions = async (app: Started): Promise<Record<string, number>> => {
  const text = await (await fetch(app.metricsUrl)).text();

  return Object.fromEntries([...text.matchAll(/^api_free_credits_total\{result="(\w+)"\} (\d+)$/gm)].map(match => [match[1]!, Number(match[2])]));
};

const createdLines = (app: Started) => app.logs.filter(line => line['msg'] === 'An account was created');

describe('free Credits on sign-up', () => {
  it('give the first three accounts from one client IP $0.10 each and the fourth nothing, while another IP still gets them', async () => {
    const app = await start(await loadConfig('{ enabled: true }'));

    const fromOneIp: Signup[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1)
      fromOneIp.push(await signup(app, '203.0.113.10'));
    const otherIp = await signup(app, '203.0.113.11');

    expect(fromOneIp.map(result => result.status)).toEqual([201, 201, 201, 201]);
    expect(fromOneIp.map(result => result.body.freeCredits)).toEqual(['0.1', '0.1', '0.1', '0']);
    expect(otherIp).toMatchObject({ status: 201, body: { freeCredits: '0.1' } });
    const [first, , , fourth] = fromOneIp.map(result => result.body);
    expect(await balanceOf(app, first!.masterKey)).toEqual({ available: '0.1', held: '0' });
    expect(await balanceOf(app, fourth!.masterKey)).toEqual({ available: '0', held: '0' });
    expect(await ledgerOperationsOf(first!.id)).toEqual(['promotion']);
    expect(await ledgerOperationsOf(fourth!.id)).toEqual([]);
    expect(await counted('api:free-credits:203.0.113.10')).toBe('4');
    const [firstAudit] = await database.db.select().from(auditLog).where(eq(auditLog.subjectId, first!.id));
    expect(firstAudit?.details).toEqual({ masterKeyId: expect.stringMatching(/^key_/), freeCredits: '0.1' });
    const [fourthAudit] = await database.db.select().from(auditLog).where(eq(auditLog.subjectId, fourth!.id));
    expect(fourthAudit?.details).toMatchObject({ freeCredits: '0' });
    expect(createdLines(app).map(line => [line['accountId'], line['freeCredits']])).toEqual([
      ...fromOneIp.map(result => [result.body.id, result.body.freeCredits]),
      [otherIp.body.id, '0.1'],
    ]);
    expect(await decisions(app)).toEqual({ given: 4, ip_limit: 1 });
  });

  it('count two IPv6 addresses in one /64 as one client', async () => {
    const app = await start(await loadConfig('{ enabled: true, perIp: { requests: 1, windowSeconds: 86400 } }'));

    const first = await signup(app, '2001:db8:a:b::1');
    const sameSubnet = await signup(app, '2001:db8:a:b:ffff::2');
    const otherSubnet = await signup(app, '2001:db8:a:c::1');

    expect([first, sameSubnet, otherSubnet].map(result => [result.status, result.body.freeCredits])).toEqual([[201, '0.1'], [201, '0'], [201, '0.1']]);
    expect(await counted('api:free-credits:2001:db8:a:b::/64')).toBe('2');
  });

  it('give nothing and book nothing while the gift is off, without a call to the limiter', async () => {
    const calls: string[] = [];
    const real = createRedisRateLimiter({ redis });
    const limiter: RateLimiter = { hit: (key, limit) => (calls.push(key), real.hit(key, limit)) };
    const app = await start(await loadConfig('{ enabled: false }'), { limiter });

    const { status, body } = await signup(app, '203.0.113.20');

    expect(status).toBe(201);
    expect(body.freeCredits).toBe('0');
    expect(await balanceOf(app, body.masterKey)).toEqual({ available: '0', held: '0' });
    expect(await ledgerOperationsOf(body.id)).toEqual([]);
    expect(calls).toEqual(['api:signup:203.0.113.20']);
    expect(createdLines(app)).toEqual([expect.objectContaining({ accountId: body.id, freeCredits: '0' })]);
    expect(await decisions(app)).toEqual({});
  });

  it('stop for the UTC day once the next gift would pass the daily cap, across client IPs, and start again the next day', async () => {
    const clock = createFakeClock('2026-11-11T23:59:00.000Z');
    const app = await start(await loadConfig('{ enabled: true, amount: "0.1", maxPerDay: "0.2" }'), { clock });

    const today = [await signup(app, '203.0.113.30'), await signup(app, '203.0.113.31'), await signup(app, '203.0.113.32')];
    clock.set('2026-11-12T00:00:30.000Z');
    const tomorrow = await signup(app, '203.0.113.33');

    expect(today.map(result => [result.status, result.body.freeCredits])).toEqual([[201, '0.1'], [201, '0.1'], [201, '0']]);
    expect(await ledgerOperationsOf(today[2]!.body.id)).toEqual([]);
    expect(tomorrow.body.freeCredits).toBe('0.1');
    expect(await counted('api:free-credits-day:2026-11-11')).toBe('3');
    expect(await counted('api:free-credits-day:2026-11-12')).toBe('1');
    expect(await decisions(app)).toEqual({ given: 3, day_limit: 1 });
  });

  it('count against the daily cap only a client IP still under its own limit', async () => {
    const clock = createFakeClock('2026-11-13T09:00:00.000Z');
    const app = await start(await loadConfig('{ enabled: true, perIp: { requests: 1, windowSeconds: 86400 }, maxPerDay: "0.2" }'), { clock });

    const results = [await signup(app, '203.0.113.40'), await signup(app, '203.0.113.40'), await signup(app, '203.0.113.41')];

    expect(results.map(result => result.body.freeCredits)).toEqual(['0.1', '0', '0.1']);
    expect(await counted('api:free-credits-day:2026-11-13')).toBe('2');
    expect(await decisions(app)).toEqual({ given: 2, ip_limit: 1 });
  });

  it('create the account with no gift and log one warning when Redis is not ready for the limiter', async () => {
    const real = createRedisRateLimiter({ redis });
    // The signup limit still counts; the gift's counts find Redis not ready
    const limiter: RateLimiter = {
      hit: async (key, limit) => {
        if (key.startsWith('api:free-credits'))
          throw new RedisNotReadyError();

        return real.hit(key, limit);
      },
    };
    const app = await start(await loadConfig('{ enabled: true }'), { limiter });

    const { status, body } = await signup(app, '203.0.113.50');

    expect(status).toBe(201);
    expect(body.freeCredits).toBe('0');
    expect(await balanceOf(app, body.masterKey)).toEqual({ available: '0', held: '0' });
    expect(await ledgerOperationsOf(body.id)).toEqual([]);
    expect(app.logs.filter(line => line['level'] === 40)).toEqual([expect.objectContaining({
      msg: 'The rate limiter failed, so the new account gets no free credits',
      error: expect.objectContaining({ code: 'redis_not_ready' }),
    })]);
    expect(await decisions(app)).toEqual({ unavailable: 1 });
  });

  it('use up no gift on a sign-up the signup limit refuses, or on one with a body it refuses', async () => {
    const app = await start(await loadConfig('{ enabled: true }', '{ requests: 2, windowSeconds: 60 }'));

    const created = await signup(app, '203.0.113.60');
    const refusedBody = await fetch(`${app.url}/v1/accounts`, {
      method: 'POST', headers: { 'x-forwarded-for': '203.0.113.60', 'content-type': 'application/json' }, body: JSON.stringify({ name: 1 }),
    });
    const overLimit = await signup(app, '203.0.113.60');

    expect(created).toMatchObject({ status: 201, body: { freeCredits: '0.1' } });
    expect(refusedBody.status).toBe(400);
    expect(overLimit.status).toBe(429);
    expect(await counted('api:signup:203.0.113.60')).toBe('3');
    expect(await counted('api:free-credits:203.0.113.60')).toBe('1');
  });
});
