import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { Secret } from '@anyfare/common';
import { hashApiKey, type PaymentStatus, type RailName } from '@anyfare/core';
import { createTestDatabase, type TestDatabase } from '@anyfare/testing';

import {
  callDetails, createAccountRepository, createCallRepository, createPaymentKeyRepository, payments, targetPayments, type CallFilter, type CallRepository,
} from '../../src/index.js';

let database: TestDatabase;
let calls: CallRepository;
const accountId = 'acc_calls_1';
const keyId = 'key_calls_1';
const base = 'eip155:84532';
const tempo = 'eip155:42431';
const payTo = '0x4444444444444444444444444444444444444444';
// Every call starts from here, a second apart
const start = Date.parse('2026-11-12T10:00:00.000Z');
const at = (seconds: number): Date => new Date(start + seconds * 1_000);

interface Seed {
  readonly id: string;
  readonly rail: RailName;
  readonly status: PaymentStatus;
  readonly second: number;
  readonly host?: string;
  readonly path?: string;
  readonly network?: string;
  // When the payment was last updated, in seconds after the start. Default: half a second after it was made.
  readonly updated?: number;
}

const seed = async (...rows: readonly Seed[]): Promise<void> => {
  await database.db.insert(payments).values(rows.map(row => ({
    id: row.id,
    requestId: `req-${row.id}`,
    rail: row.rail,
    buyerAccountId: row.rail === 'credits' ? accountId : null,
    keyId: row.rail === 'credits' ? keyId : null,
    targetHost: row.host ?? 'api.example.com',
    targetPath: row.path ?? '/v1/pools',
    network: row.rail === 'credits' ? null : row.network ?? (row.rail === 'mpp' ? tempo : base),
    asset: row.rail === 'credits' ? null : row.rail === 'mpp' ? 'tempo-pathusd' : 'base-usdc',
    amount: 1_100n,
    fee: row.status === 'captured' || row.status === 'settled' ? 100n : null,
    upstreamStatus: 200,
    upstreamLatencyMs: 120,
    status: row.status,
    needsReview: false,
    createdAt: at(row.second),
    updatedAt: row.updated === undefined ? new Date(at(row.second).getTime() + 500) : at(row.updated),
  })));
};

const leg = async (paymentId: string, second: number): Promise<void> => {
  await database.db.insert(targetPayments).values({
    paymentId, protocol: 'x402', network: base, asset: 'base-usdc', amount: 1_000n, atomicAmount: 1_000n, payTo, signatureId: `sig-${paymentId}`, status: 'settled',
    transactionHash: `0x${'ab'.repeat(32)}`, createdAt: at(second), updatedAt: at(second + 1),
  });
};

const ids = async (filter: CallFilter, page: { offset?: number; limit?: number; cap?: number } = {}) => {
  const found = await calls.list({ filter, offset: page.offset ?? 0, limit: page.limit ?? 50, cap: page.cap ?? 1_000 });

  return found.calls.map(call => call.id);
};

beforeAll(async () => {
  database = await createTestDatabase();
  calls = createCallRepository({ db: database.db });
  await createAccountRepository({ db: database.db }).create({ id: accountId, createdAt: at(0) });
  await createPaymentKeyRepository({ db: database.db }).insert({
    id: keyId, accountId, keyHash: hashApiKey(Secret.from('af_test_calls_key')), label: undefined, createdAt: at(0), allowance: undefined,
    dailyBudget: 5_000_000n, maxPrice: undefined, expiresAt: undefined,
  });
});

beforeEach(async () => {
  await database.db.delete(callDetails);
  await database.db.delete(targetPayments);
  await database.db.delete(payments);
});

afterAll(async () => {
  await database?.drop();
});

describe('call details', () => {
  it('keeps a call\'s details once: a second write changes nothing', async () => {
    await seed({ id: 'pay_d1', rail: 'x402', status: 'settled', second: 1 });

    await calls.recordDetails({ paymentId: 'pay_d1', method: 'POST', payer: '0xabc', arrivedAt: at(1) });
    await calls.recordDetails({ paymentId: 'pay_d1', method: 'GET', payer: undefined, arrivedAt: at(2) });

    expect(await database.db.select().from(callDetails).where(eq(callDetails.paymentId, 'pay_d1'))).toEqual([
      { paymentId: 'pay_d1', method: 'POST', payer: '0xabc', arrivedAt: at(1) },
    ]);
  });
});

describe('the list of calls', () => {
  it('lists finished calls newest first, with their details and API legs, and never one in flight', async () => {
    await seed(
      { id: 'pay_l1', rail: 'credits', status: 'captured', second: 1 },
      { id: 'pay_l2', rail: 'x402', status: 'settled', second: 2 },
      { id: 'pay_l3', rail: 'mpp', status: 'failed', second: 3 },
      { id: 'pay_l4', rail: 'credits', status: 'held', second: 4 },
      { id: 'pay_l5', rail: 'x402', status: 'verified', second: 5 },
      { id: 'pay_l6', rail: 'x402', status: 'settling', second: 6 },
    );
    await leg('pay_l2', 2);
    await calls.recordDetails({ paymentId: 'pay_l2', method: 'GET', payer: '0xpayer', arrivedAt: at(2) });

    const found = await calls.list({ filter: {}, offset: 0, limit: 10, cap: 100 });

    expect(found.calls.map(call => [call.id, call.status])).toEqual([['pay_l6', 'settling'], ['pay_l3', 'failed'], ['pay_l2', 'settled'], ['pay_l1', 'captured']]);
    expect([found.total, found.totalCapped]).toEqual([4, false]);
    expect(found.calls.find(call => call.id === 'pay_l2')).toEqual({
      id: 'pay_l2', rail: 'x402', status: 'settled', targetHost: 'api.example.com', targetPath: '/v1/pools', network: base, asset: 'base-usdc', amount: 1_100n,
      fee: 100n, upstreamStatus: 200, upstreamLatencyMs: 120, transactionHash: undefined, createdAt: at(2), updatedAt: new Date(at(2).getTime() + 500),
      details: { method: 'GET', payer: '0xpayer', arrivedAt: at(2) },
      leg: {
        protocol: 'x402', network: base, asset: 'base-usdc', amount: 1_000n, payTo, status: 'settled', transactionHash: `0x${'ab'.repeat(32)}`, createdAt: at(2),
        updatedAt: at(3),
      },
    });
    expect(found.calls.find(call => call.id === 'pay_l3')).toMatchObject({ details: undefined, leg: undefined });
  });

  it('filters by how the buyer paid, a part of the host without case, the exact path, and the outcome', async () => {
    await seed(
      { id: 'pay_f1', rail: 'credits', status: 'captured', second: 1, host: 'Quotes.Example.com', path: '/v1/a' },
      { id: 'pay_f2', rail: 'credits', status: 'released', second: 2, host: 'weather.example.org', path: '/v1/b' },
      { id: 'pay_f3', rail: 'x402', status: 'settled', second: 3, host: 'quotes.example.com', path: '/v1/a' },
      { id: 'pay_f4', rail: 'x402', status: 'cancelled', second: 4, host: 'weather.example.org', path: '/v1/a', network: 'near:testnet' },
      { id: 'pay_f5', rail: 'mpp', status: 'settled', second: 5, host: '100_off.example.net', path: '/v1/b' },
    );

    expect(await ids({ paidWith: { rail: 'credits' } })).toEqual(['pay_f2', 'pay_f1']);
    expect(await ids({ paidWith: { rail: 'x402', network: base } })).toEqual(['pay_f3']);
    expect(await ids({ paidWith: { rail: 'x402', network: 'near:testnet' } })).toEqual(['pay_f4']);
    expect(await ids({ paidWith: { rail: 'mpp', network: tempo } })).toEqual(['pay_f5']);
    // A network's payments on another rail never match
    expect(await ids({ paidWith: { rail: 'x402', network: tempo } })).toEqual([]);
    expect(await ids({ hostContains: 'QUOTES' })).toEqual(['pay_f3', 'pay_f1']);
    // LIKE's own characters match themselves
    expect(await ids({ hostContains: '100_off' })).toEqual(['pay_f5']);
    expect(await ids({ hostContains: '1%' })).toEqual([]);
    expect(await ids({ hostContains: 'example._rg' })).toEqual([]);
    expect(await ids({ path: '/v1/a' })).toEqual(['pay_f4', 'pay_f3', 'pay_f1']);
    expect(await ids({ path: '/v1' })).toEqual([]);
    expect(await ids({ outcome: 'paid' })).toEqual(['pay_f5', 'pay_f3', 'pay_f1']);
    expect(await ids({ outcome: 'free' })).toEqual(['pay_f4', 'pay_f2']);
    expect(await ids({ path: '/v1/a', paidWith: { rail: 'credits' } })).toEqual(['pay_f1']);
    expect(await ids({ path: '/v1/a', hostContains: 'weather', outcome: 'free' })).toEqual(['pay_f4']);
    expect(await ids({ paidWith: { rail: 'credits' }, outcome: 'paid', hostContains: 'quotes' })).toEqual(['pay_f1']);
  });

  it('filters by the exact host, alone and with a path, how the buyer paid, a part of the host and the outcome', async () => {
    await seed(
      { id: 'pay_h1', rail: 'credits', status: 'captured', second: 1, host: 'quotes.example.com', path: '/v1/a' },
      { id: 'pay_h2', rail: 'x402', status: 'failed', second: 2, host: 'quotes.example.com', path: '/v1/b' },
      { id: 'pay_h3', rail: 'x402', status: 'settled', second: 3, host: 'quotes.example.com:8443', path: '/v1/a' },
      { id: 'pay_h4', rail: 'x402', status: 'settled', second: 4, host: 'my-quotes.example.com', path: '/v1/a' },
      { id: 'pay_h5', rail: 'x402', status: 'verified', second: 5, host: 'quotes.example.com', path: '/v1/a' },
    );

    // Exactly the host: not one that contains it, nor the same name on another port, nor one in flight
    expect(await ids({ host: 'quotes.example.com' })).toEqual(['pay_h2', 'pay_h1']);
    expect(await ids({ host: 'quotes.example.com:8443' })).toEqual(['pay_h3']);
    expect(await ids({ host: 'example.com' })).toEqual([]);
    expect(await ids({ host: 'quotes.example.com', path: '/v1/a' })).toEqual(['pay_h1']);
    expect(await ids({ host: 'quotes.example.com', paidWith: { rail: 'x402', network: base } })).toEqual(['pay_h2']);
    expect(await ids({ host: 'quotes.example.com', outcome: 'paid' })).toEqual(['pay_h1']);
    expect(await ids({ host: 'my-quotes.example.com', hostContains: 'my-' })).toEqual(['pay_h4']);
    expect(await calls.list({ filter: { host: 'quotes.example.com' }, offset: 0, limit: 10, cap: 100 })).toMatchObject({ total: 2, totalCapped: false });
  });

  it('pages, counts up to the cap, and says when there may be more', async () => {
    await seed(...[1, 2, 3, 4, 5].map(second => ({ id: `pay_p${second}`, rail: 'x402' as const, status: second % 2 === 0 ? 'failed' as const : 'settled' as const, second })));

    expect(await calls.list({ filter: {}, offset: 0, limit: 2, cap: 10 })).toMatchObject({ total: 5, totalCapped: false });
    expect(await ids({}, { offset: 2, limit: 2, cap: 10 })).toEqual(['pay_p3', 'pay_p2']);
    // Five calls over a cap of three: three counted, and there are more
    expect(await calls.list({ filter: {}, offset: 0, limit: 2, cap: 3 })).toMatchObject({ total: 3, totalCapped: true });
    // Never a row past the cap
    expect(await ids({}, { offset: 2, limit: 5, cap: 3 })).toEqual(['pay_p3']);
    expect(await ids({}, { offset: 3, limit: 5, cap: 3 })).toEqual([]);
    // A filter without an index path reads only the newest cap + 1 calls: pay_p1 is past them
    const paid = await calls.list({ filter: { outcome: 'paid' }, offset: 0, limit: 5, cap: 3 });
    expect(paid.calls.map(call => call.id)).toEqual(['pay_p5', 'pay_p3']);
    expect([paid.total, paid.totalCapped]).toEqual([2, true]);
    expect(await calls.list({ filter: { outcome: 'paid' }, offset: 0, limit: 5, cap: 10 })).toMatchObject({ total: 3, totalCapped: false });
  });

  it('never gives a Credits call a payer, even when its details hold one', async () => {
    await seed({ id: 'pay_c1', rail: 'credits', status: 'captured', second: 1 });
    await calls.recordDetails({ paymentId: 'pay_c1', method: 'GET', payer: 'someone', arrivedAt: at(1) });

    expect((await calls.find('pay_c1'))?.details).toEqual({ method: 'GET', payer: undefined, arrivedAt: at(1) });
  });
});

describe('one call', () => {
  it('finds a finished call by its ID, and none that is unknown or in flight', async () => {
    await seed({ id: 'pay_o1', rail: 'x402', status: 'settled', second: 1 }, { id: 'pay_o2', rail: 'x402', status: 'verified', second: 2 });

    expect(await calls.find('pay_o1')).toMatchObject({ id: 'pay_o1', status: 'settled' });
    expect(await calls.find('pay_o2')).toBeUndefined();
    expect(await calls.find('pay_none')).toBeUndefined();
  });
});

describe('calls as they become final', () => {
  it('reads them in the order they became final, after a position, never one settling or in flight', async () => {
    await seed(
      { id: 'pay_s1', rail: 'x402', status: 'settled', second: 1, updated: 30 },
      { id: 'pay_s2', rail: 'credits', status: 'captured', second: 2, updated: 10 },
      { id: 'pay_s3', rail: 'x402', status: 'settling', second: 3, updated: 11 },
      { id: 'pay_s4', rail: 'credits', status: 'held', second: 4, updated: 12 },
      { id: 'pay_s5', rail: 'mpp', status: 'failed', second: 5, updated: 10 },
      { id: 'pay_s6', rail: 'credits', status: 'released', second: 6, updated: 5 },
    );

    const read = async (after: { updatedAt: Date; id: string }, limit = 10) => (await calls.finalizedAfter({ after, limit })).map(call => call.id);

    expect(await read({ updatedAt: at(6), id: '' })).toEqual(['pay_s2', 'pay_s5', 'pay_s1']);
    // Same time: by ID
    expect(await read({ updatedAt: at(10), id: 'pay_s2' })).toEqual(['pay_s5', 'pay_s1']);
    expect(await read({ updatedAt: at(0), id: '' }, 2)).toEqual(['pay_s6', 'pay_s2']);
    expect(await read({ updatedAt: at(30), id: 'pay_s1' })).toEqual([]);
  });
});
