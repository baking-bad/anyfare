import { fixtureTime } from '@anyfare/testing';

import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { Secret } from '@anyfare/common';
import { hashApiKey, type PaymentStatus, type RailName } from '@anyfare/core';
import { createFakeClock, createTestDatabase, type FakeClock, type TestDatabase } from '@anyfare/testing';

import {
  createAccountRepository, createPaymentKeyRepository, createPaymentRepository, createRoutingRepository, hostBlocklist, maxRoutedEndpointsPerHost,
  routedEndpoints, signatures, targetPayments, type Database, type NewTargetPayment, type TargetPaymentStatus,
} from '../../src/index.js';

let database: TestDatabase;
let clock: FakeClock;
let counter = 0;
// The tests run at noon UTC on the 9th
const noon = fixtureTime(0, 9, 12, 0, 0, 0);
const targetPayTo = '0x4444444444444444444444444444444444444444';

beforeAll(async () => {
  database = await createTestDatabase();
  clock = createFakeClock(noon);
});

afterEach(() => {
  clock.set(noon);
});

afterAll(async () => {
  await database?.drop();
});

const next = (): number => {
  counter += 1;

  return counter;
};

const thrown = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  }
  catch (error) {
    return error;
  }
  throw new Error('Expected a rejection');
};

const constraintOf = async (promise: Promise<unknown>): Promise<string | undefined> =>
  ((await thrown(promise)) as { cause?: { constraint?: string } }).cause?.constraint;

// The repositories on one database, and buyer payments with their target legs
const fixtures = (db: Database) => {
  const routing = createRoutingRepository({ db, clock });
  const payments = createPaymentRepository({ db, clock });
  let buyer: Promise<{ readonly accountId: string; readonly keyId: string }> | undefined;

  const newBuyer = async () => {
    const accountId = `acc_${next()}`;
    const keyId = `key_${next()}`;
    await createAccountRepository({ db }).create({ id: accountId, createdAt: clock.now() });
    await createPaymentKeyRepository({ db }).insert({
      id: keyId, accountId, keyHash: hashApiKey(Secret.from(`af_test_${keyId}`)), label: undefined, createdAt: clock.now(),
      allowance: undefined, dailyBudget: 5_000_000n, maxPrice: undefined, expiresAt: undefined,
    });

    return { accountId, keyId };
  };

  /** A buyer payment for a routed call, moved along `path` from its first status: held for credits, verified on chain. */
  const buyerPayment = async (rail: RailName, path: readonly PaymentStatus[] = []): Promise<string> => {
    const index = next();
    const id = `pay_${index}`;
    const call = { id, requestId: `req-${index}`, targetHost: 'api.target.dev', targetPath: `/v1/pools/${index}`, amount: 1_100n };
    if (rail === 'credits') {
      buyer ??= newBuyer();
      const { accountId, keyId } = await buyer;
      await payments.create({ ...call, rail, buyerAccountId: accountId, keyId, network: undefined, asset: undefined, atomicAmount: undefined, status: 'held' });
    }
    else {
      await payments.create({
        ...call, rail, buyerAccountId: undefined, keyId: undefined, network: 'eip155:84532', asset: 'base-usdc', atomicAmount: 1_100n, status: 'verified',
      });
    }
    for (const to of path)
      await payments.changeStatus({ paymentId: id, to });

    return id;
  };

  const targetLeg = (paymentId: string, changes: Partial<NewTargetPayment> = {}): NewTargetPayment => ({
    paymentId,
    protocol: 'x402',
    network: 'eip155:84532',
    asset: 'base-usdc',
    amount: 1_000n,
    atomicAmount: 1_000n,
    payTo: targetPayTo,
    signatureId: `sig_${paymentId}`,
    ...changes,
  });

  /** A buyer payment along `path` whose target leg went to `targetStatus`. */
  const routedCall = async (rail: RailName, path: readonly PaymentStatus[], targetStatus: TargetPaymentStatus, amount = 1_000n): Promise<string> => {
    const paymentId = await buyerPayment(rail, path);
    await routing.recordTargetPayment(targetLeg(paymentId, { amount, atomicAmount: amount }));
    if (targetStatus !== 'signed')
      await routing.updateTargetPayment(paymentId, { status: targetStatus });

    return paymentId;
  };

  return { routing, payments, buyerPayment, targetLeg, routedCall };
};

describe('the host blocklist', () => {
  it('blocks a host, updates the reason when it is blocked again, and unblocks it', async () => {
    const { routing } = fixtures(database.db);
    const reasonOf = async (host: string) => (await database.db.select().from(hostBlocklist).where(eq(hostBlocklist.host, host)))[0];

    await routing.block({ host: 'blocked.example.com', reason: 'abuse' });
    clock.advance(1_000);
    await routing.block({ host: 'blocked.example.com', reason: 'abuse, reported twice' });

    expect(await routing.isBlocked('blocked.example.com')).toBe(true);
    expect(await routing.isBlocked('open.example.com')).toBe(false);
    // The second block changes the reason, not when the host was first blocked
    expect(await reasonOf('blocked.example.com')).toEqual({ host: 'blocked.example.com', reason: 'abuse, reported twice', createdAt: new Date(noon) });

    expect(await routing.unblock('blocked.example.com')).toBe(true);
    expect(await routing.isBlocked('blocked.example.com')).toBe(false);
    expect(await routing.unblock('blocked.example.com')).toBe(false);
    expect(await reasonOf('blocked.example.com')).toBeUndefined();
  });
});

describe('routed endpoints', () => {
  const endpointOf = async (host: string, path: string) =>
    (await database.db.select().from(routedEndpoints).where(eq(routedEndpoints.host, host))).find(row => row.path === path);

  it('registers an endpoint once, and updates its last price only when one is given', async () => {
    const { routing } = fixtures(database.db);
    const host = `api-${next()}.target.dev`;

    expect(await routing.registerEndpoint({ host, path: '/v1/pools', lastPrice: 1_100n })).toBe('created');
    clock.advance(1_000);
    expect(await routing.registerEndpoint({ host, path: '/v1/pools' })).toBe('exists');
    expect(await endpointOf(host, '/v1/pools')).toEqual({
      host, path: '/v1/pools', feeBps: null, lastPrice: 1_100n, createdAt: new Date(noon), status: 'paid', checkedAt: null, checkMethod: null,
    });

    expect(await routing.registerEndpoint({ host, path: '/v1/pools', lastPrice: 2_200n })).toBe('exists');
    expect(await endpointOf(host, '/v1/pools')).toMatchObject({ lastPrice: 2_200n, createdAt: new Date(noon) });

    // Without a price, the endpoint has none until a call names one
    expect(await routing.registerEndpoint({ host, path: '/v1/swaps' })).toBe('created');
    expect(await endpointOf(host, '/v1/swaps')).toMatchObject({ lastPrice: null });
  });

  it('registers up to the cap per host, then refuses new paths on that host only', async () => {
    const { routing } = fixtures(database.db);
    const host = `api-${next()}.target.dev`;
    await database.db.insert(routedEndpoints).values(Array.from({ length: maxRoutedEndpointsPerHost - 1 }, (_, index) => ({
      host, path: `/v1/item/${index}`, lastPrice: null, createdAt: clock.now(),
    })));

    expect(await routing.registerEndpoint({ host, path: '/v1/last' })).toBe('created');
    expect(await routing.registerEndpoint({ host, path: '/v1/one-too-many' })).toBe('capped');
    // A known endpoint on a capped host is still known, and its price still follows
    expect(await routing.registerEndpoint({ host, path: '/v1/item/0', lastPrice: 500n })).toBe('exists');
    expect(await endpointOf(host, '/v1/item/0')).toMatchObject({ lastPrice: 500n });
    expect(await routing.registerEndpoint({ host: `other-${host}`, path: '/v1/one-too-many' })).toBe('created');
    expect(await endpointOf(host, '/v1/one-too-many')).toBeUndefined();
    expect(await database.db.$count(routedEndpoints, eq(routedEndpoints.host, host))).toBe(maxRoutedEndpointsPerHost);
  });

  it('keeps exactly the cap when many new paths on one host register concurrently', async () => {
    const { routing } = fixtures(database.db);
    const host = `api-${next()}.target.dev`;
    await database.db.insert(routedEndpoints).values(Array.from({ length: maxRoutedEndpointsPerHost - 5 }, (_, index) => ({
      host, path: `/v1/item/${index}`, lastPrice: null, createdAt: clock.now(),
    })));

    const results = await Promise.all(Array.from({ length: 20 }, (_, index) => routing.registerEndpoint({ host, path: `/v1/new/${index}` })));

    expect(results.filter(result => result === 'created')).toHaveLength(5);
    expect(results.filter(result => result === 'capped')).toHaveLength(15);
    expect(await database.db.$count(routedEndpoints, eq(routedEndpoints.host, host))).toBe(maxRoutedEndpointsPerHost);
  });

  it('answers each of many concurrent registrations of one endpoint, and keeps one row', async () => {
    const { routing } = fixtures(database.db);
    const host = `api-${next()}.target.dev`;

    const results = await Promise.all(Array.from({ length: 10 }, () => routing.registerEndpoint({ host, path: '/v1/pools' })));

    expect(results.filter(result => result === 'created')).toHaveLength(1);
    expect(results.filter(result => result === 'exists')).toHaveLength(9);
    expect(await database.db.$count(routedEndpoints, eq(routedEndpoints.host, host))).toBe(1);
  });

  it('sets an endpoint\'s own fee, and back to the default with null', async () => {
    const { routing } = fixtures(database.db);
    const host = `api-${next()}.target.dev`;
    await routing.registerEndpoint({ host, path: '/v1/pools' });

    expect(await routing.endpointFee(host, '/v1/pools')).toBeUndefined();
    expect(await routing.setEndpointFee({ host, path: '/v1/pools', feeBps: 250 })).toBe(true);
    expect(await routing.endpointFee(host, '/v1/pools')).toBe(250);
    expect(await routing.setEndpointFee({ host, path: '/v1/pools', feeBps: 0 })).toBe(true);
    expect(await routing.endpointFee(host, '/v1/pools')).toBe(0);
    expect(await routing.setEndpointFee({ host, path: '/v1/pools', feeBps: null })).toBe(true);
    expect(await routing.endpointFee(host, '/v1/pools')).toBeUndefined();
  });

  it('sets no fee on an endpoint never registered, and refuses a fee outside 0 to 10000 bps in the database', async () => {
    const { routing } = fixtures(database.db);
    const host = `api-${next()}.target.dev`;
    await routing.registerEndpoint({ host, path: '/v1/pools' });

    expect(await routing.setEndpointFee({ host, path: '/v1/unknown', feeBps: 250 })).toBe(false);
    expect(await routing.endpointFee(host, '/v1/unknown')).toBeUndefined();
    expect(await routing.endpointFee(`unknown-${host}`, '/v1/pools')).toBeUndefined();
    expect(await constraintOf(routing.setEndpointFee({ host, path: '/v1/pools', feeBps: 10_001 }))).toBe('routed_endpoints_fee_check');
    expect(await constraintOf(routing.setEndpointFee({ host, path: '/v1/pools', feeBps: -1 }))).toBe('routed_endpoints_fee_check');
    expect(await routing.endpointFee(host, '/v1/pools')).toBeUndefined();
  });
});

describe('target payments', () => {
  it('records a target leg as signed, then updates its status, receipt and hash', async () => {
    const { routing, buyerPayment, targetLeg } = fixtures(database.db);
    const paymentId = await buyerPayment('credits');
    const leg = targetLeg(paymentId);

    await routing.recordTargetPayment(leg);

    expect(await routing.findTargetPayment(paymentId)).toEqual({
      ...leg, status: 'signed', receipt: null, transactionHash: null, lossBooked: false, buyerCharged: false, createdAt: new Date(noon), updatedAt: new Date(noon),
    });

    // Without a receipt or a hash: only the status and the time change
    clock.advance(1_000);
    await routing.updateTargetPayment(paymentId, { status: 'unknown' });
    expect(await routing.findTargetPayment(paymentId)).toMatchObject({ status: 'unknown', receipt: null, transactionHash: null, updatedAt: clock.now() });

    clock.advance(1_000);
    await routing.updateTargetPayment(paymentId, { status: 'settled', receipt: 'eyJzdWNjZXNzIjp0cnVlfQ', transactionHash: '0xabc' });
    expect(await routing.findTargetPayment(paymentId)).toMatchObject({
      status: 'settled', receipt: 'eyJzdWNjZXNzIjp0cnVlfQ', transactionHash: '0xabc', createdAt: new Date(noon), updatedAt: clock.now(),
    });

    // A later change without them keeps what was recorded
    clock.advance(1_000);
    await routing.updateTargetPayment(paymentId, { status: 'failed' });
    expect(await routing.findTargetPayment(paymentId)).toMatchObject({ status: 'failed', receipt: 'eyJzdWNjZXNzIjp0cnVlfQ', transactionHash: '0xabc', updatedAt: clock.now() });
  });

  it('records an MPP target leg on an x402 buyer payment', async () => {
    const { routing, buyerPayment, targetLeg } = fixtures(database.db);
    const paymentId = await buyerPayment('x402');
    const leg = targetLeg(paymentId, { protocol: 'mpp', network: 'eip155:42431', asset: 'tempo-pathusd', amount: 1_000n, atomicAmount: 1_000n });

    await routing.recordTargetPayment(leg);

    expect(await routing.findTargetPayment(paymentId)).toMatchObject({ ...leg, status: 'signed' });
  });

  it('keeps an atomic amount past a bigint column exactly, as an 18-decimal asset needs', async () => {
    const { routing, buyerPayment, targetLeg } = fixtures(database.db);
    const paymentId = await buyerPayment('x402');
    const atomicAmount = 10n ** 30n + 7n;

    await routing.recordTargetPayment(targetLeg(paymentId, { atomicAmount }));

    expect((await routing.findTargetPayment(paymentId))?.atomicAmount).toBe(atomicAmount);
  });

  it('finds no target leg for a payment without one', async () => {
    const { routing, buyerPayment } = fixtures(database.db);

    expect(await routing.findTargetPayment(await buyerPayment('credits'))).toBeUndefined();
    expect(await routing.findTargetPayment('pay_missing')).toBeUndefined();
  });

  it('refuses, in the database, a target leg without its buyer payment, a second one for a payment, a zero amount and an unknown status', async () => {
    const { routing, buyerPayment, targetLeg } = fixtures(database.db);
    const paymentId = await buyerPayment('credits');
    await routing.recordTargetPayment(targetLeg(paymentId));

    expect(await constraintOf(routing.recordTargetPayment(targetLeg('pay_missing')))).toBe('target_payments_payment_id_payments_id_fk');
    expect(await constraintOf(routing.recordTargetPayment(targetLeg(paymentId)))).toBe('target_payments_pkey');
    expect(await constraintOf(routing.recordTargetPayment(targetLeg(await buyerPayment('credits'), { amount: 0n })))).toBe('target_payments_amount_check');
    expect(await constraintOf(routing.recordTargetPayment(targetLeg(await buyerPayment('credits'), { atomicAmount: 0n })))).toBe('target_payments_amount_check');
    expect(await constraintOf(routing.updateTargetPayment(paymentId, { status: 'paid' as TargetPaymentStatus }))).toBe('target_payments_status_check');
    expect(await constraintOf(routing.recordTargetPayment(targetLeg(await buyerPayment('credits'), { protocol: 'card' as never }))))
      .toBe('target_payments_protocol_check');
  });
});

describe('unbooked routing losses', () => {
  // A database of its own, so the list holds only this block's legs
  let lossDatabase: TestDatabase;

  beforeAll(async () => {
    lossDatabase = await createTestDatabase();
  });

  afterAll(async () => {
    await lossDatabase?.drop();
  });

  it('lists settled target legs whose buyer was never charged, oldest first, up to the limit', async () => {
    const { routing, routedCall } = fixtures(lossDatabase.db);
    // Created out of order: the list follows the target legs' times
    clock.set(fixtureTime(0, 9, 12, 0, 3, 0));
    const failed = await routedCall('x402', ['settling', 'failed'], 'settled', 1_000n);
    clock.set(fixtureTime(0, 9, 12, 0, 1, 0));
    const released = await routedCall('credits', ['released'], 'settled', 2_000n);
    clock.set(fixtureTime(0, 9, 12, 0, 2, 0));
    const cancelled = await routedCall('mpp', ['cancelled'], 'settled', 3_000n);
    clock.set(fixtureTime(0, 9, 12, 0, 0, 0));
    // Target legs that weren't paid, or not known to be
    await routedCall('x402', ['failed'], 'signed');
    await routedCall('x402', ['failed'], 'failed');
    await routedCall('credits', ['released'], 'unknown');
    // Buyers who were charged, or may still be
    await routedCall('x402', ['settled'], 'settled');
    await routedCall('credits', ['captured'], 'settled');
    await routedCall('credits', [], 'settled');
    await routedCall('x402', [], 'settled');
    await routedCall('x402', ['settling'], 'settled');
    // A loss already booked, and a leg whose buyer the ledger charged
    const booked = await routedCall('x402', ['failed'], 'settled');
    await lossDatabase.db.update(targetPayments).set({ lossBooked: true }).where(eq(targetPayments.paymentId, booked));
    const charged = await routedCall('x402', ['failed'], 'settled');
    await lossDatabase.db.update(targetPayments).set({ buyerCharged: true }).where(eq(targetPayments.paymentId, charged));

    const losses = await routing.listUnbookedLosses(10);

    expect(losses).toEqual([
      { paymentId: released, amount: 2_000n, asset: 'base-usdc', targetHost: 'api.target.dev', buyerStatus: 'released' },
      { paymentId: cancelled, amount: 3_000n, asset: 'base-usdc', targetHost: 'api.target.dev', buyerStatus: 'cancelled' },
      { paymentId: failed, amount: 1_000n, asset: 'base-usdc', targetHost: 'api.target.dev', buyerStatus: 'failed' },
    ]);
    expect((await routing.listUnbookedLosses(2)).map(loss => loss.paymentId)).toEqual([released, cancelled]);
  });
});

describe('signatures', () => {
  it('records what the Signer signed, and reads it back as it was', async () => {
    const { routing } = fixtures(database.db);
    const index = next();
    const signature = {
      id: `sig_${index}`, requestId: `req-${index}`, quoteId: `pay_${index}`, protocol: 'x402' as const, network: 'eip155:84532', asset: 'base-usdc',
      // Past a bigint column: $1,000 of an 18-decimal asset
      atomicAmount: 10n ** 21n, amount: 1_000_000_000n, payTo: targetPayTo, resource: 'https://api.target.dev/v1/pools', createdAt: clock.now(),
    };

    await routing.recordSignature(signature);
    await routing.recordSignature({ ...signature, id: `sig_${index}_bare`, requestId: undefined });

    expect(await database.db.select().from(signatures).where(eq(signatures.id, signature.id))).toEqual([signature]);
    expect(await database.db.select().from(signatures).where(eq(signatures.id, `sig_${index}_bare`))).toEqual([{ ...signature, id: `sig_${index}_bare`, requestId: null }]);
    expect(await constraintOf(routing.recordSignature(signature))).toBe('signatures_pkey');
    expect(await constraintOf(routing.recordSignature({ ...signature, id: `sig_${index}_card`, protocol: 'card' as never }))).toBe('signatures_protocol_check');
  });
});
