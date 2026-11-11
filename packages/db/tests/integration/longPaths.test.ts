import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Secret } from '@anyfare/common';
import { hashApiKey, type NewPayment } from '@anyfare/core';
import { createFakeClock, createFakeIdGenerator, createTestDatabase, type TestDatabase } from '@anyfare/testing';

import {
  createAccountRepository, createCallRepository, createLedger, createPaymentKeyRepository, createPaymentRepository, createRoutingRepository, type Ledger,
  type PaymentRepository, type RoutingRepository,
} from '../../src/index.js';

// A payment enters the indexes of public calls as it finishes. A routed path has no bound, so a key
// too long for a btree row would stop it finishing: a buyer's path, however long, never does.

let database: TestDatabase;
let ledger: Ledger;
let payments: PaymentRepository;
let routing: RoutingRepository;
const clock = createFakeClock('2026-11-12T10:00:00.000Z');
const accountId = 'acc_long_paths';
const keyId = 'key_long_paths';
let counter = 0;

// About 6,000 characters that don't compress, far past a btree row's 2,704 bytes
const longPath = (): string => `/v1/${randomBytes(4_500).toString('base64url')}`;

const call = (path: string) => {
  counter += 1;

  return { id: `pay_long_${counter}`, requestId: `req-long-${counter}`, targetHost: 'long.example.com', targetPath: path, amount: 1_100n };
};

const credits = (path: string): NewPayment & { readonly rail: 'credits'; readonly buyerAccountId: string; readonly keyId: string } => ({
  ...call(path), rail: 'credits', buyerAccountId: accountId, keyId, network: undefined, asset: undefined, atomicAmount: undefined,
});

// What the proxy records once the target is paid: the leg the buyer is charged for
const paidLeg = async (paymentId: string): Promise<void> => {
  await routing.recordTargetPayment({
    paymentId, protocol: 'x402', network: 'eip155:84532', asset: 'base-usdc', amount: 1_000n, atomicAmount: 1_000n,
    payTo: '0x4444444444444444444444444444444444444444', signatureId: `sig-${paymentId}`,
  });
  await routing.updateTargetPayment(paymentId, { status: 'settled' });
};

beforeAll(async () => {
  database = await createTestDatabase();
  const { db } = database;
  ledger = createLedger({ db, clock, ids: createFakeIdGenerator('long-') });
  payments = createPaymentRepository({ db, clock });
  routing = createRoutingRepository({ db, clock });
  await createAccountRepository({ db }).create({ id: accountId, createdAt: clock.now() });
  await createPaymentKeyRepository({ db }).insert({
    id: keyId, accountId, keyHash: hashApiKey(Secret.from('af_test_long_paths')), label: undefined, createdAt: clock.now(), allowance: undefined,
    dailyBudget: 50_000_000n, maxPrice: undefined, expiresAt: undefined,
  });
  await ledger.credit({ accountId, amount: 10_000_000n, reference: 'credit-long-paths' });
});

afterAll(async () => {
  await database?.drop();
});

describe('a payment for a long path', () => {
  it('is held and captured, and held and released, with Credits', async () => {
    const captured = credits(longPath());
    const released = credits(longPath());
    expect(captured.targetPath.length).toBeGreaterThan(6_000);

    expect(await ledger.hold({ payment: captured, dailyBudget: 50_000_000n, allowance: undefined })).toMatchObject({ ok: true });
    await paidLeg(captured.id);
    expect((await ledger.capture({ paymentId: captured.id })).payment.status).toBe('captured');
    expect(await ledger.hold({ payment: released, dailyBudget: 50_000_000n, allowance: undefined })).toMatchObject({ ok: true });
    expect((await ledger.release({ paymentId: released.id })).payment.status).toBe('released');

    // And the public reads find it by its path
    const found = await createCallRepository({ db: database.db }).list({ filter: { path: captured.targetPath }, offset: 0, limit: 10, cap: 100 });
    expect(found.calls.map(row => row.id)).toEqual([captured.id]);
  });

  it('settles through settling, and is cancelled, on a chain', async () => {
    const chain = (path: string) => ({
      ...call(path), rail: 'x402' as const, buyerAccountId: undefined, keyId: undefined, network: 'eip155:84532', asset: 'base-usdc', atomicAmount: 1_100n,
    });
    const settled = chain(longPath());
    const cancelled = chain(longPath());

    await payments.create({ ...settled, status: 'verified' });
    await payments.changeStatus({ paymentId: settled.id, to: 'settling', from: 'verified', settlementRequest: { network: 'eip155:84532' } });
    await paidLeg(settled.id);
    const booked = await ledger.settle({ paymentId: settled.id, asset: 'base-usdc', transactionHash: `0x${'ef'.repeat(32)}`, receipt: undefined, needsReview: false });
    expect(booked.payment.status).toBe('settled');
    await payments.create({ ...cancelled, status: 'verified' });
    expect((await payments.changeStatus({ paymentId: cancelled.id, to: 'cancelled', from: 'verified' })).status).toBe('cancelled');
  });
});
