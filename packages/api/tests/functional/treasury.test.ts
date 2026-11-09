import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger, parseUsd, randomIdGenerator, Secret } from '@anyfare/common';
import { loadPlatformConfig, reconcile, type PlatformConfig } from '@anyfare/core';
import { auditLog, createLedger, createTreasuryRepository, ledgerAccountIds } from '@anyfare/db';
import { createFakeClock, createTestDatabase, createTestRedis, fixtureTime, type TestDatabase, type TestRedis } from '@anyfare/testing';

import { createApp, type ApiServer } from '../../src/app.js';

const internalSecret = 'internal-secret-0123456789abcdef-xyz';
const clock = createFakeClock(fixtureTime(0, 9, 10, 0, 0, 0));

let database: TestDatabase;
let redis: TestRedis;
let config: PlatformConfig;
let server: ApiServer;
let internalUrl: string;

beforeAll(async () => {
  [database, redis] = await Promise.all([createTestDatabase(), createTestRedis()]);
  config = await loadPlatformConfig({ env: { CONFIG_PATH: 'config/example.yaml' } });
  server = createApp({ config, logger: createLogger({ level: 'silent' }), postgres: database.postgres, redis, clock, internalSecret: Secret.from(internalSecret) });
  const { internalPort } = await server.listen({ host: '127.0.0.1', port: 0, metricsPort: 0, internalPort: 0 });
  internalUrl = `http://127.0.0.1:${internalPort!}`;
});

afterAll(async () => {
  await server?.close();
  await Promise.all([database?.drop(), redis?.cleanup()]);
});

const operator = { 'x-internal-secret': internalSecret, 'x-internal-caller': 'operator' };

const postTo = async (path: string, body: unknown, headers: Record<string, string>) => {
  const response = await fetch(`${internalUrl}${path}`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  return { status: response.status, body: await response.json() as Record<string, unknown> };
};

const post = (body: unknown, headers: Record<string, string> = operator) => postTo('/internal/v1/treasury/transfers', body, headers);

const actions = async (subjectId: string) => (await database.db.select().from(auditLog).where(eq(auditLog.subjectId, subjectId))).map(entry => entry.action);

describe('POST /internal/v1/treasury/transfers', () => {
  const transfer = {
    reference: 'swap-1',
    from: { asset: 'base-usdc', amount: '100' },
    to: { asset: 'solana-usdc', amount: '99.5' },
    transactions: ['0xabc', 'f00d'],
  };

  it('books a rebalancing once and records it: the source treasury holds less, the target more, the difference is conversion cost', async () => {
    const created = await post(transfer);
    const replayed = await post(transfer);
    const balances = await createLedger({ db: database.db, clock, ids: randomIdGenerator })
      .balancesOf([ledgerAccountIds.treasury('base-usdc'), ledgerAccountIds.treasury('solana-usdc'), ledgerAccountIds.conversion]);
    const stored = await createTreasuryRepository({ db: database.db }).findTransfer('swap-1');

    expect(created).toMatchObject({ status: 201, body: { reference: 'swap-1', conversionCost: '0.5', replayed: false, createdAt: clock.now().toISOString() } });
    expect(replayed).toMatchObject({ status: 200, body: { replayed: true, transactionId: created.body['transactionId'] } });
    expect(Object.fromEntries(balances)).toEqual({
      'platform:treasury:base-usdc': 100_000_000n, 'platform:treasury:solana-usdc': -99_500_000n, 'platform:conversion': -500_000n,
    });
    expect(stored).toMatchObject({
      fromAsset: 'base-usdc', fromAmount: 100_000_000n, toAsset: 'solana-usdc', toAmount: 99_500_000n, transactions: ['0xabc', 'f00d'],
      recordedBy: 'operator', ledgerTransactionId: created.body['transactionId'],
    });
    expect(await actions('swap-1')).toEqual(['treasury.transfer', 'treasury.transfer']);
  });

  it('refuses a reused reference for another transfer, and writes nothing for it', async () => {
    const conflict = await post({ ...transfer, to: { asset: 'solana-usdc', amount: '99' } });

    expect(conflict).toMatchObject({ status: 409, body: { error: { code: 'idempotency_conflict' } } });
    expect(await actions('swap-1')).toHaveLength(2);
  });

  it('refuses a gain, one asset, zero amounts, and an asset outside the registry', async () => {
    const refused = async (reference: string, change: Record<string, unknown>) => {
      expect((await post({ ...transfer, reference, ...change })).status, reference).toBe(400);
      expect(await actions(reference), reference).toEqual([]);
    };

    await refused('gain', { to: { asset: 'solana-usdc', amount: '101' } });
    await refused('same', { to: { asset: 'base-usdc', amount: '99' } });
    await refused('zero-to', { to: { asset: 'solana-usdc', amount: '0' } });
    await refused('zero-from', { from: { asset: 'base-usdc', amount: '0' }, to: { asset: 'solana-usdc', amount: '0' } });
    await refused('unknown-to', { to: { asset: 'doge', amount: '99' } });
    await refused('unknown-from', { from: { asset: 'doge', amount: '100' } });
    await refused('no-transactions', { transactions: [] });
  });

  it('needs the shared secret', async () => {
    expect((await post({ ...transfer, reference: 'swap-2' }, {})).status).toBe(401);
    expect((await post({ ...transfer, reference: 'swap-2' }, { 'x-internal-secret': 'wrong' })).status).toBe(401);
    expect(await createTreasuryRepository({ db: database.db }).findTransfer('swap-2')).toBeUndefined();
  });
});

describe('POST /internal/v1/treasury/fundings', () => {
  const funding = {
    reference: 'fund-near-1',
    asset: 'near-usdc',
    amount: '10',
    transactions: ['8xQm4hYtzUe9rWbJ2vNcK7pLd3sFgA6TqE1uRiPoZy5', 'https://explorer.example.com/tx/fund-near-1'],
    note: 'The owner funded the treasury account',
  };
  const fund = (body: unknown, headers: Record<string, string> = operator) => postTo('/internal/v1/treasury/fundings', body, headers);
  const ledger = () => createLedger({ db: database.db, clock, ids: randomIdGenerator });
  const nearUsdc = () => config.assets.filter(asset => asset.name === 'near-usdc');

  it('books money put in from outside once and records it: the treasury holds more, so reconciliation sees it', async () => {
    const chainBalances = new Map([['near-usdc', parseUsd('10')]]);
    const unbooked = reconcile({ assets: nearUsdc(), ledgerBalances: await ledger().balancesOf([ledgerAccountIds.treasury('near-usdc')]), chainBalances });

    const fundedAt = clock.now();
    const created = await fund(funding);
    // The audit entries get different times, so their order is the calls'
    clock.advance(1_000);
    const replayed = await fund(funding);
    const balances = await ledger().balancesOf([ledgerAccountIds.treasury('near-usdc'), ledgerAccountIds.capital]);
    const stored = await createTreasuryRepository({ db: database.db }).findFunding('fund-near-1');

    expect(created).toEqual({
      status: 201, body: { reference: 'fund-near-1', transactionId: expect.any(String), replayed: false, createdAt: fundedAt.toISOString() },
    });
    expect(replayed).toEqual({ status: 200, body: { ...created.body, replayed: true } });
    expect(Object.fromEntries(balances)).toEqual({ 'platform:treasury:near-usdc': -10_000_000n, 'platform:capital': 10_000_000n });
    expect(stored).toEqual({
      reference: 'fund-near-1', asset: 'near-usdc', amount: 10_000_000n, transactions: funding.transactions, note: funding.note, recordedBy: 'operator',
      ledgerTransactionId: created.body['transactionId'], createdAt: fundedAt,
    });
    // The $10 on chain drifted from a ledger that knew nothing of it; booked, the two agree
    expect(unbooked.get('near-usdc')).toMatchObject({ ledger: 0n, drift: 10_000_000n, alert: true });
    expect(reconcile({ assets: nearUsdc(), ledgerBalances: balances, chainBalances }).get('near-usdc'))
      .toEqual({ ledger: 10_000_000n, chain: 10_000_000n, drift: 0n, alert: false });
    const entries = await database.db.select().from(auditLog).where(eq(auditLog.subjectId, 'fund-near-1')).orderBy(auditLog.occurredAt, auditLog.id);
    expect(entries).toEqual([false, true].map(replay => expect.objectContaining({
      actorKind: 'internal_api', actorId: 'operator', action: 'treasury.funding', subjectKind: 'treasury_funding',
      details: { asset: 'near-usdc', amount: '10000000', transactionId: created.body['transactionId'], replayed: replay },
    })));
  });

  it('refuses a reused reference for another amount or asset, and writes nothing for it', async () => {
    const amount = await fund({ ...funding, amount: '11' });
    const asset = await fund({ ...funding, asset: 'base-usdc' });

    expect(amount).toMatchObject({ status: 409, body: { error: { code: 'idempotency_conflict' } } });
    expect(asset).toMatchObject({ status: 409, body: { error: { code: 'idempotency_conflict' } } });
    expect(await actions('fund-near-1')).toHaveLength(2);
    expect(await createTreasuryRepository({ db: database.db }).findFunding('fund-near-1')).toMatchObject({ asset: 'near-usdc', amount: 10_000_000n });
  });

  it('refuses an unknown asset, a zero amount, an amount above $100,000, no transactions and a long note, and writes nothing', async () => {
    const refused = async (reference: string, change: Record<string, unknown>) => {
      expect(await fund({ ...funding, reference, ...change }), reference).toMatchObject({ status: 400, body: { error: { code: 'invalid_request' } } });
      expect(await actions(reference), reference).toEqual([]);
      expect(await createTreasuryRepository({ db: database.db }).findFunding(reference), reference).toBeUndefined();
    };

    await refused('fund-unknown-asset', { asset: 'doge' });
    await refused('fund-zero', { amount: '0' });
    await refused('fund-negative', { amount: '-1' });
    await refused('fund-too-much', { amount: '100000.000001' });
    await refused('fund-too-large', { amount: '99999999999999999999' });
    await refused('fund-no-transactions', { transactions: [] });
    await refused('fund-too-many-transactions', { transactions: Array.from({ length: 21 }, (_, index) => `tx-${index}`) });
    await refused('fund-long-note', { note: 'n'.repeat(201) });
    await refused('fund-no-transactions-field', { transactions: undefined });
  });

  it('takes exactly $100,000 without a note', async () => {
    const { note: _note, ...withoutNote } = funding;

    const created = await fund({ ...withoutNote, reference: 'fund-most', asset: 'base-usdc', amount: '100000' });

    expect(created.status).toBe(201);
    expect(await createTreasuryRepository({ db: database.db }).findFunding('fund-most')).toMatchObject({ amount: 100_000_000_000n, note: null });
  });

  it('needs the shared secret', async () => {
    expect((await fund({ ...funding, reference: 'fund-2' }, {})).status).toBe(401);
    expect((await fund({ ...funding, reference: 'fund-2' }, { 'x-internal-secret': 'wrong' })).status).toBe(401);
    expect(await createTreasuryRepository({ db: database.db }).findFunding('fund-2')).toBeUndefined();
    expect(await actions('fund-2')).toEqual([]);
  });
});
