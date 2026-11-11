import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import { x402Client } from '@x402/core/client';
import { decodePaymentRequiredHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader, encodePaymentSignatureHeader } from '@x402/core/http';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { eq, sql } from 'drizzle-orm';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createAddressPolicy, createLogger, OutboundHttp, randomIdGenerator, Secret, systemClock, type MicroUsd, type Server,
} from '@anyfare/common';
import { findAsset, generateApiKey, hashApiKey, loadPlatformConfig, type PlatformConfig } from '@anyfare/core';
import {
  callDetails, callDetailsTimeoutMs, createAccountRepository, createLedger, createPaymentKeyRepository, createPostgres, payments, targetPayments,
  type CallRepository, type Database,
} from '@anyfare/db';
import { createFacilitators, initializeX402, type X402Setup } from '@anyfare/payments';
import { createApp as createSigner } from '@anyfare/signer';
import {
  createFakeResolver, createTestDatabase, createTestRedis, encodeBase58, nearFacilitatorOff, startFakeFacilitator, startFakeUpstream, type FakeFacilitator,
  type FakeUpstream, type TestDatabase, type TestRedis,
} from '@anyfare/testing';

import { createApp, type ProxyDependencies } from '../../src/app.js';
import { maxPendingDetails } from '../../src/routing/callDetails.js';
import { createSignerClient } from '../../src/routing/support.js';

// A paid routed call keeps its method, its payer and its arrival for the public reads, best effort

const base = 'eip155:84532';
const solana = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const signerSecret = 'signer-secret-0123456789abcdef-0123456789';
const targetPayTo = '0x3333333333333333333333333333333333333333';
const targetTransaction = `0x${'cd'.repeat(32)}`;
const generous = { requests: 100_000, windowSeconds: 60 };
// The target's price, $0.001, and our quote at no fee
const price: MicroUsd = 1_000n;

let database: TestDatabase;
let redis: TestRedis;
let config: PlatformConfig;
let target: FakeUpstream;
let facilitator: FakeFacilitator;
let http: OutboundHttp;
let signer: Server;
let signerUrl: string;
let x402: X402Setup;
let usdc: string;
const signerWallet = privateKeyToAccount(generatePrivateKey());

/** A buyer account with a payment key and credits, written as the Platform API writes them. */
const createBuyer = async (db: Database) => {
  const id = `acc_${randomUUID()}`;
  const keyId = `key_${randomUUID()}`;
  await createAccountRepository({ db }).create({ id, createdAt: systemClock.now() });
  const key = generateApiKey('payment', config.keyPrefixes);
  await createPaymentKeyRepository({ db }).insert({
    id: keyId, accountId: id, keyHash: hashApiKey(key), label: undefined, createdAt: systemClock.now(), allowance: undefined, dailyBudget: 5_000_000n,
    maxPrice: undefined, expiresAt: undefined,
  });
  await createLedger({ db, clock: systemClock, ids: randomIdGenerator }).credit({ accountId: id, amount: 1_000_000n, reference: `credit-${id}` });

  return { id, keyId, key: key.expose() };
};

beforeAll(async () => {
  [database, redis, target, facilitator] = await Promise.all([
    createTestDatabase(), createTestRedis(), startFakeUpstream({ hosts: ['api.target.test'] }),
    startFakeFacilitator({ networks: [base, solana], feePayer: encodeBase58(Uint8Array.from({ length: 32 }, () => 9)) }),
  ]);
  config = await loadPlatformConfig({
    env: {
      CONFIG_PATH: 'config/example.yaml',
      CONFIG: Buffer.from(JSON.stringify({
        urls: { website: 'https://www.anyfare.test', api: 'https://api.anyfare.test', pay: 'https://pay.anyfare.test' },
        rateLimits: { signup: generous, paymentKey: generous, unpaidIp: generous },
        facilitators: [{ name: 'cdp', url: facilitator.url, networks: [base, solana] }, nearFacilitatorOff],
        mpp: { enabled: false },
      })).toString('base64'),
    },
  });
  usdc = findAsset(config, 'base-usdc')!.address;
  target.handle(async (request, response) => {
    const path = request.path.split('?')[0]!;
    if (path === '/.well-known/anyfare.json') {
      response.writeHead(404).end();
      return;
    }
    if (typeof request.headers['payment-signature'] !== 'string') {
      const required = encodePaymentRequiredHeader({
        x402Version: 2, error: 'Payment required', resource: { url: `https://api.target.test:${target.port}${path}`, description: 'Pools', mimeType: 'application/json' },
        accepts: [{ scheme: 'exact', network: base, amount: String(price), asset: usdc, payTo: targetPayTo, maxTimeoutSeconds: 60, extra: { name: 'USDC', version: '2' } }],
      } as never);
      response.writeHead(402, { 'payment-required': required, 'content-type': 'application/json' }).end('{}');
      return;
    }
    const settled = encodePaymentResponseHeader({ success: true, transaction: targetTransaction, network: base, payer: signerWallet.address } as never);
    response.writeHead(200, { 'content-type': 'application/json', 'payment-response': settled }).end('{"pools":[1,2,3]}');
  });
  http = new OutboundHttp({
    ownHosts: config.ownHosts,
    resolver: createFakeResolver({ 'api.target.test': '127.0.0.1' }),
    addressPolicy: createAddressPolicy({ allow: ['127.0.0.0/8'] }),
    ca: target.ca,
    connectTimeoutMs: 5_000,
    totalTimeoutMs: 5_000,
  });
  signer = createSigner({ config, logger: createLogger({ level: 'silent' }), postgres: database.postgres, redis, secret: Secret.from(signerSecret), wallets: { base: signerWallet } });
  signerUrl = `http://127.0.0.1:${(await signer.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 })).port}`;
  x402 = await initializeX402({
    config, facilitators: createFacilitators({ config, cdpApiKey: () => { throw new Error('No CDP auth'); }, clock: systemClock }), timeoutMs: 5_000,
  });
});

afterAll(async () => {
  await signer?.close();
  await Promise.all([http?.close(), target?.close(), facilitator?.close()]);
  await Promise.all([database?.drop(), redis?.cleanup()]);
});

/** A proxy on the shared database, target and Signer, with some dependencies of its own, and its log lines. */
const withProxy = async (overrides: Partial<ProxyDependencies>, work: (link: (path: string) => string, lines: Record<string, unknown>[]) => Promise<void>): Promise<void> => {
  const lines: Record<string, unknown>[] = [];
  const proxy = createApp({
    config, logger: createLogger({}, { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) }), postgres: database.postgres, redis, http, x402,
    signer: createSignerClient({ url: signerUrl, secret: Secret.from(signerSecret), timeoutMs: 5_000 }), ...overrides,
  });
  const { port } = await proxy.listen({ host: '127.0.0.1', port: 0, metricsPort: 0 });
  try {
    await work(path => `http://127.0.0.1:${port}/api.target.test:${target.port}${path}`, lines);
  }
  finally {
    await proxy.close();
  }
};

const detailsOf = async (paymentId: string) => (await database.db.select().from(callDetails).where(eq(callDetails.paymentId, paymentId)))[0];
const paymentOfRequest = async (requestId: string) => (await database.db.select().from(payments).where(eq(payments.requestId, requestId)))[0];
const paymentOfBuyer = async (accountId: string) => (await database.db.select().from(payments).where(eq(payments.buyerAccountId, accountId)))[0];
const balance = async (accountId: string): Promise<bigint> => (await createLedger({ db: database.db, clock: systemClock, ids: randomIdGenerator }).balance(accountId)).available;

describe('the details of a paid routed call', () => {
  it('keeps the method, the payer and the arrival of a call paid with x402', async () => {
    const wallet = privateKeyToAccount(generatePrivateKey());
    const requestId = `details-x402-${randomUUID()}`;

    await withProxy({}, async link => {
      const required = decodePaymentRequiredHeader((await fetch(link('/v1/x402'))).headers.get('payment-required')!);
      const client = new x402Client().register(base, new ExactEvmScheme(wallet));
      const signature = encodePaymentSignatureHeader(await client.createPaymentPayload({ ...required, accepts: required.accepts.filter(option => option.network === base) }));
      const before = Date.now();
      const response = await fetch(link('/v1/x402'), { headers: { 'payment-signature': signature, 'x-request-id': requestId } });
      expect(response.status).toBe(200);
      const payment = await paymentOfRequest(requestId);
      await expect.poll(async () => (await detailsOf(payment!.id))?.method).toBe('GET');
      const details = await detailsOf(payment!.id);

      expect(payment).toMatchObject({ rail: 'x402', status: 'settled' });
      expect(details).toMatchObject({ method: 'GET', payer: wallet.address });
      expect(details!.arrivedAt.getTime()).toBeGreaterThanOrEqual(before - 5);
      expect(details!.arrivedAt.getTime()).toBeLessThanOrEqual(payment!.createdAt.getTime());
    });
  });

  it('keeps no payer for a Credits call, and nothing of its query string, body or headers', async () => {
    const paying = await createBuyer(database.db);

    await withProxy({}, async link => {
      const response = await fetch(link('/v1/credits?token=secret-in-query'), {
        method: 'POST', body: 'secret-in-body', headers: { authorization: `Bearer ${paying.key}`, 'content-type': 'text/plain', 'x-secret': 'secret-in-header' },
      });
      expect(response.status).toBe(200);
      const payment = await paymentOfBuyer(paying.id);
      await expect.poll(async () => (await detailsOf(payment!.id))?.method).toBe('POST');
      const details = await detailsOf(payment!.id);
      const leg = (await database.db.select().from(targetPayments).where(eq(targetPayments.paymentId, payment!.id)))[0];

      expect(details).toMatchObject({ method: 'POST', payer: null });
      expect(payment!.targetPath).toBe('/v1/credits');
      const written = JSON.stringify([payment, details, leg], (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value);
      for (const secret of ['secret-in-query', 'secret-in-body', 'secret-in-header', 'token='])
        expect(written, secret).not.toContain(secret);
      // The details never name the buyer's account or key
      expect(JSON.stringify(details)).not.toContain(paying.id);
      expect(JSON.stringify(details)).not.toContain(paying.keyId);
    });
  });

  it('answers and charges a call as before when the details can\'t be written, with one warn line', async () => {
    const paying = await createBuyer(database.db);
    const failing: Pick<CallRepository, 'recordDetails'> = { recordDetails: async () => { throw new Error('The database refused the details'); } };

    await withProxy({ callDetails: failing }, async (link, lines) => {
      const response = await fetch(link('/v1/failing-details'), { headers: { authorization: `Bearer ${paying.key}` } });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ pools: [1, 2, 3] });
      await expect.poll(async () => (await paymentOfBuyer(paying.id))?.status).toBe('captured');
      const payment = await paymentOfBuyer(paying.id);
      expect(await balance(paying.id)).toBe(1_000_000n - price);
      expect((await database.db.select().from(targetPayments).where(eq(targetPayments.paymentId, payment!.id)))[0]).toMatchObject({ status: 'settled', buyerCharged: true });
      expect(await detailsOf(payment!.id)).toBeUndefined();
      expect(lines.filter(line => line['msg'] === 'A call\'s details couldn\'t be kept. The call goes on.')).toEqual([
        expect.objectContaining({ level: 40, paymentId: payment!.id }),
      ]);
    });
  });

  it('keeps paying calls in normal time while detail writes stall, with at most two of the pool\'s connections held for them', async () => {
    const paying = await createBuyer(database.db);
    const silent = createLogger({ level: 'silent' });
    // Another connection holds the details table, so every details write waits on its lock
    const locker = createPostgres({ url: database.url, logger: silent });
    const watcher = createPostgres({ url: database.url, logger: silent });
    let unlock!: () => void;
    const unlocked = new Promise<void>(resolve => {
      unlock = resolve;
    });
    let locked!: () => void;
    const isLocked = new Promise<void>(resolve => {
      locked = resolve;
    });
    const holding = locker.db.transaction(async tx => {
      await tx.execute(sql`lock table call_details in exclusive mode`);
      locked();
      await unlocked;
    });
    await isLocked;
    // The most details writes waiting on the lock at once, each on a connection of the proxy's pool
    let most = 0;
    let watching = true;
    const watch = (async () => {
      while (watching) {
        const { rows } = await watcher.db.execute<{ waiting: number }>(sql`
          select count(*)::int as waiting from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock' and query ilike 'insert into "call_details"%'`);
        most = Math.max(most, rows[0]?.waiting ?? 0);
        await sleep(10);
      }
    })();

    try {
      await withProxy({}, async (link, lines) => {
        const durations = await Promise.all(Array.from({ length: 8 }, async (_, index) => {
          const started = performance.now();
          const response = await fetch(link(`/v1/stalled-${index}`), { headers: { authorization: `Bearer ${paying.key}` } });
          expect(response.status).toBe(200);
          await response.arrayBuffer();

          return performance.now() - started;
        }));

        // Well inside the time a stalled write takes to give up
        for (const duration of durations)
          expect(duration).toBeLessThan(callDetailsTimeoutMs * 0.75);
        // The writes past the cap were dropped; those in flight give up on their statement timeout, the lock still held
        expect(lines.filter(line => line['msg'] === 'A call\'s details were not kept: too many writes are in flight. The call goes on.').length)
          .toBeGreaterThanOrEqual(8 - maxPendingDetails - 1);
        await expect.poll(() => lines.filter(line => line['msg'] === 'A call\'s details couldn\'t be kept. The call goes on.').length, { timeout: callDetailsTimeoutMs * 3 })
          .toBe(maxPendingDetails);
      });
    }
    finally {
      watching = false;
      await watch;
      unlock();
      await holding;
      await Promise.all([locker.close(), watcher.close()]);
    }

    expect(most).toBeGreaterThan(0);
    expect(most).toBeLessThanOrEqual(maxPendingDetails);
    // The timeout was the write's alone: every connection of the pool has none
    const settings = await Promise.all(Array.from({ length: 10 }, () => database.db.execute<{ timeout: string }>(sql`
      select current_setting('statement_timeout') as timeout from pg_sleep(0.1)`)));
    expect(new Set(settings.map(result => result.rows[0]?.timeout))).toEqual(new Set(['0']));
  // The stalled writes take their statement timeout to give up
  }, 20_000);

  it('never waits for a slow write: the call answers first', async () => {
    const paying = await createBuyer(database.db);
    let written = false;
    const slow: Pick<CallRepository, 'recordDetails'> = {
      recordDetails: () => new Promise(resolve => setTimeout(() => {
        written = true;
        resolve();
      }, 1_500)),
    };

    await withProxy({ callDetails: slow }, async link => {
      const response = await fetch(link('/v1/slow-details'), { headers: { authorization: `Bearer ${paying.key}` } });

      expect(response.status).toBe(200);
      expect(written).toBe(false);
      await expect.poll(async () => (await paymentOfBuyer(paying.id))?.status).toBe('captured');
    });
    // Shutdown waited for it
    expect(written).toBe(true);
  });
});
