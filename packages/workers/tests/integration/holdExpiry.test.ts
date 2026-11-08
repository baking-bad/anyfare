import { fixtureTime } from '@anyfare/testing';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLogger, randomIdGenerator, Secret } from '@anyfare/common';
import { hashApiKey, loadPlatformConfig, type HoldInput, type NewPayment } from '@anyfare/core';
import {
  createAccountRepository, createLedger, createPaymentKeyRepository, createPaymentRepository, createRoutingRepository, ledgerAccountIds,
  type Ledger,
} from '@anyfare/db';
import { createFakeClock, createTestDatabase, type FakeClock, type TestDatabase } from '@anyfare/testing';

import { createHoldExpiry, HoldExpiryFailedError, holdTtlMs } from '../../src/holdExpiry.js';

const ttlMs = 5 * 60_000;
const logger = createLogger({ level: 'silent' });
// The quote a buyer is held for, and the target's price within it: the rest is the routing fee
const quote = 1_000n;
const targetPrice = 800n;

let database: TestDatabase;
let clock: FakeClock;
let ledger: Ledger;
let counter = 0;

beforeAll(async () => {
  database = await createTestDatabase();
  clock = createFakeClock(fixtureTime(0, 10, 12, 0, 0, 0));
  ledger = createLedger({ db: database.db, clock, ids: randomIdGenerator });
});

afterAll(async () => {
  await database?.drop();
});

/** A buyer with $1 and a payment key. */
const newBuyer = async () => {
  counter += 1;
  const buyer = `acc_${counter}`;
  await createAccountRepository({ db: database.db }).create({ id: buyer, createdAt: clock.now() });
  const keyId = `key_${counter}`;
  await createPaymentKeyRepository({ db: database.db }).insert({
    id: keyId, accountId: buyer, keyHash: hashApiKey(Secret.from(`af_test_${keyId}`)), label: undefined, createdAt: clock.now(),
    allowance: undefined, dailyBudget: 5_000_000n, maxPrice: undefined, expiresAt: undefined,
  });
  await ledger.credit({ accountId: buyer, amount: 1_000_000n, reference: `credit-${buyer}` });

  return { buyer, keyId };
};

type Buyer = Awaited<ReturnType<typeof newBuyer>>;

/** A routed call held on credits, as the proxy holds it before it calls the target. */
const hold = async ({ buyer, keyId }: Buyer, changes: Partial<NewPayment> = {}): Promise<string> => {
  counter += 1;
  const result = await ledger.hold({
    payment: {
      id: `pay_${counter}`, requestId: `req-${counter}`, rail: 'credits', buyerAccountId: buyer, keyId, targetHost: 'api.target.test', targetPath: '/v1/quote',
      network: undefined, asset: undefined, atomicAmount: undefined, amount: quote, ...changes,
    } as HoldInput['payment'],
    dailyBudget: 5_000_000n,
    allowance: undefined,
  });
  if (!result.ok)
    throw new Error(result.refusal);

  return result.payment.id;
};

// The target leg the proxy records once the Signer paid the target, before it charges the buyer
const recordTargetLeg = async (paymentId: string): Promise<void> => {
  const routing = createRoutingRepository({ db: database.db, clock });
  await routing.recordTargetPayment({
    paymentId, protocol: 'x402', network: 'eip155:84532', asset: 'base-usdc', amount: targetPrice, atomicAmount: targetPrice,
    payTo: '0x4444444444444444444444444444444444444444', signatureId: `sig_${paymentId}`,
  });
  await routing.updateTargetPayment(paymentId, { status: 'settled', transactionHash: `0x${paymentId}` });
};

const decide = (paymentId: string, decision: 'billable' | 'not_billable') =>
  createPaymentRepository({ db: database.db, clock }).recordDecision({ paymentId, decision, upstreamStatus: decision === 'billable' ? 200 : 500, upstreamLatencyMs: 5 });

const find = (paymentId: string) => createPaymentRepository({ db: database.db, clock }).find(paymentId);
const statusOf = async (paymentId: string) => (await find(paymentId))?.status;

const balancesOf = async (buyer: string) => {
  const found = await ledger.balancesOf([ledgerAccountIds.available(buyer), ledgerAccountIds.held(buyer)]);

  return { available: found.get(ledgerAccountIds.available(buyer)) ?? 0n, held: found.get(ledgerAccountIds.held(buyer)) ?? 0n };
};

const job = (changes: Partial<Parameters<typeof createHoldExpiry>[0]> = {}) => createHoldExpiry({
  payments: createPaymentRepository({ db: database.db, clock }),
  ledger,
  clock,
  ttlMs,
  logger,
  ...changes,
});

describe('hold expiry', () => {
  it('captures a hold left with a billable decision and its target leg, releases one with no decision, then moves nothing on a second run', async () => {
    const buyer = await newBuyer();
    clock.set(fixtureTime(0, 10, 12, 0, 0, 0));
    const billable = await hold(buyer);
    await recordTargetLeg(billable);
    await decide(billable, 'billable');
    const undecided = await hold(buyer);
    const notBillable = await hold(buyer);
    await decide(notBillable, 'not_billable');
    clock.set(fixtureTime(0, 10, 12, 4, 0, 0));
    const recent = await hold(buyer);
    const platform = [ledgerAccountIds.treasury('base-usdc'), ledgerAccountIds.routingFees];
    const platformBefore = await ledger.balancesOf(platform);
    // The time comes from the Clock port: 5 minutes and 1 second after the first holds
    clock.set(fixtureTime(0, 10, 12, 5, 1, 0));

    const first = await job()();
    const after = await balancesOf(buyer.buyer);
    const platformAfter = await ledger.balancesOf(platform);
    const second = await job()();

    expect(first).toEqual({ captured: 1, released: 2, failed: 0 });
    expect(await Promise.all([billable, undecided, notBillable, recent].map(statusOf))).toEqual(['captured', 'released', 'released', 'held']);
    expect(second).toEqual({ captured: 0, released: 0, failed: 0 });
    expect(await balancesOf(buyer.buyer)).toEqual(after);
    // The buyer paid one call, and one more is still held
    expect(after).toEqual({ available: 998_000n, held: 1_000n });
    // The target's price went out of the treasury of its leg's asset, and the rest of the quote is the fee
    expect(await find(billable)).toMatchObject({ status: 'captured', fee: quote - targetPrice });
    const moved = (id: string) => (platformAfter.get(id) ?? 0n) - (platformBefore.get(id) ?? 0n);
    expect(moved(ledgerAccountIds.treasury('base-usdc'))).toBe(targetPrice);
    expect(moved(ledgerAccountIds.routingFees)).toBe(quote - targetPrice);
  });

  it('pages through more holds than one batch', async () => {
    const buyer = await newBuyer();
    clock.set(fixtureTime(0, 11, 8, 0, 0, 0));
    const ids = await Promise.all(Array.from({ length: 5 }, () => hold(buyer)));
    clock.set(fixtureTime(0, 12, 12, 0, 0, 0));

    const result = await job({ batchSize: 2 })();

    expect(result.released).toBeGreaterThanOrEqual(5);
    expect(new Set(await Promise.all(ids.map(statusOf)))).toEqual(new Set(['released']));
  });

  it('finishes every hold it can, then fails the run for one it can\'t, which the next run tries again', async () => {
    const buyer = await newBuyer();
    clock.set(fixtureTime(0, 13, 8, 0, 0, 0));
    // Billable without a target leg: the ledger refuses to charge the buyer for a call nobody paid
    const broken = await hold(buyer);
    await decide(broken, 'billable');
    const fine = await hold(buyer);
    clock.set(fixtureTime(0, 14, 12, 0, 0, 0));

    const error = await job()().catch((thrown: unknown) => thrown);
    const again = await job()().catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(HoldExpiryFailedError);
    expect((error as HoldExpiryFailedError).result).toMatchObject({ failed: 1 });
    expect(await statusOf(fine)).toBe('released');
    expect(await statusOf(broken)).toBe('held');
    expect((again as HoldExpiryFailedError).result).toEqual({ captured: 0, released: 0, failed: 1 });
    // Done with it: the later tests' runs shouldn't trip over it
    await ledger.release({ paymentId: broken });
  });

  it('logs each hold it can\'t finish at error, with the payment and its decision', async () => {
    const lines: Record<string, unknown>[] = [];
    const capturing = createLogger({ level: 'debug' }, { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) });
    const buyer = await newBuyer();
    clock.set(fixtureTime(0, 15, 8, 0, 0, 0));
    const broken = await hold(buyer);
    await decide(broken, 'billable');
    clock.set(fixtureTime(0, 15, 12, 0, 0, 0));

    await expect(job({ logger: capturing })()).rejects.toBeInstanceOf(HoldExpiryFailedError);

    expect(lines.find(line => line['msg'] === 'Failed to finish an expired hold')).toMatchObject({
      level: 50, paymentId: broken, decision: 'billable', error: { message: expect.stringContaining('has no target leg') },
    });
    await ledger.release({ paymentId: broken });
  });
});

describe('the hold TTL', () => {
  it('is longer than the proxy\'s total timeout, and at least 5 minutes', async () => {
    const config = await loadPlatformConfig({ env: { CONFIG_PATH: 'config/example.yaml' } });

    expect(holdTtlMs(config)).toBe(5 * 60_000);
    expect(holdTtlMs(config)).toBeGreaterThan(config.timeouts.requestMs);
    expect(holdTtlMs({ timeouts: { ...config.timeouts, requestMs: 400_000 } })).toBe(800_000);
  });
});
