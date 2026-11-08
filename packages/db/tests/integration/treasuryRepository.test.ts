import { fixtureTime } from '@anyfare/testing';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestDatabase, type TestDatabase } from '@anyfare/testing';

import {
  createTreasuryRepository, ledgerTransactions, type ReconciliationRunRecord, type TreasuryRepository, type TreasuryTransferRecord,
} from '../../src/index.js';

let database: TestDatabase;
let treasury: TreasuryRepository;
let counter = 0;
const createdAt = new Date(fixtureTime(0, 9, 12, 0, 0, 0));

beforeAll(async () => {
  database = await createTestDatabase();
  treasury = createTreasuryRepository({ db: database.db });
});

afterAll(async () => {
  await database?.drop();
});

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

// The ledger transaction that booked a transfer
const ledgerTransaction = async (reference: string): Promise<string> => {
  const id = `ltx_${reference}`;
  await database.db.insert(ledgerTransactions).values({ id, operation: 'treasury_transfer', reference, requestId: null, createdAt });

  return id;
};

// $10 of Base USDC became $9.99 of Solana USDC
const transfer = async (changes: Partial<TreasuryTransferRecord> = {}): Promise<TreasuryTransferRecord> => {
  counter += 1;
  const reference = `rebalance-${counter}`;

  return {
    reference,
    fromAsset: 'base-usdc',
    fromAmount: 10_000_000n,
    toAsset: 'solana-usdc',
    toAmount: 9_990_000n,
    transactions: [`0x${'1'.repeat(64)}`, 'https://explorer.example.com/tx/2222'],
    recordedBy: 'operator-1',
    ledgerTransactionId: await ledgerTransaction(reference),
    createdAt,
    ...changes,
  };
};

describe('treasury transfers', () => {
  it('records a transfer and finds it by its reference, with its transaction references as given', async () => {
    const recorded = await transfer();

    await treasury.recordTransfer(recorded);

    expect(await treasury.findTransfer(recorded.reference)).toEqual(recorded);
    expect(await treasury.findTransfer('rebalance-missing')).toBeUndefined();
  });

  it('refuses a second transfer with the same reference, and keeps the first', async () => {
    const recorded = await transfer();
    await treasury.recordTransfer(recorded);

    expect(await constraintOf(treasury.recordTransfer({ ...recorded, toAmount: 9_000_000n }))).toBe('treasury_transfers_pkey');
    expect(await treasury.findTransfer(recorded.reference)).toEqual(recorded);
  });

  it('refuses, in the database, a transfer whose ledger transaction doesn\'t exist, or booked another transfer', async () => {
    const recorded = await transfer();
    await treasury.recordTransfer(recorded);
    const missing = await transfer({ ledgerTransactionId: 'ltx_missing' });
    const reused = await transfer({ ledgerTransactionId: recorded.ledgerTransactionId });

    expect(await constraintOf(treasury.recordTransfer(missing))).toBe('treasury_transfers_ledger_transaction_fk');
    expect(await constraintOf(treasury.recordTransfer(reused))).toBe('treasury_transfers_ledger_transaction_idx');
    expect(await treasury.findTransfer(missing.reference)).toBeUndefined();
    expect(await treasury.findTransfer(reused.reference)).toBeUndefined();
  });

  it('records a transfer that lost nothing', async () => {
    const recorded = await transfer({ toAmount: 10_000_000n });

    await treasury.recordTransfer(recorded);

    expect(await treasury.findTransfer(recorded.reference)).toMatchObject({ fromAmount: 10_000_000n, toAmount: 10_000_000n });
  });

  it.each([
    ['a gain', { toAmount: 10_000_001n }],
    ['nothing sent', { fromAmount: 0n, toAmount: 0n }],
    ['nothing received', { toAmount: 0n }],
    ['a negative amount', { fromAmount: -1n, toAmount: -2n }],
  ] as const)('refuses, in the database, a transfer with %s', async (_case, changes) => {
    const refused = await transfer(changes);

    expect(await constraintOf(treasury.recordTransfer(refused))).toBe('treasury_transfers_amounts_check');
    expect(await treasury.findTransfer(refused.reference)).toBeUndefined();
  });
});

describe('reconciliation runs', () => {
  const run = (id: string, ranAt: string, alerts = 0): ReconciliationRunRecord => ({
    id,
    ranAt: new Date(ranAt),
    results: {
      'base-usdc': { ledger: '10', chain: alerts > 0 ? '12.5' : '10', drift: alerts > 0 ? '2.5' : '0', alert: alerts > 0 },
      'solana-usdc': { ledger: '40', chain: '40', drift: '0', alert: false },
    },
    alerts,
  });

  it('has no latest run before the first', async () => {
    expect(await treasury.latestReconciliationRun()).toBeUndefined();
  });

  it('records each run as it was, and answers the newest by when it ran, not by when it was recorded', async () => {
    const tenth = run('rec_10', fixtureTime(0, 10, 0, 0, 0, 0));
    const twelfth = run('rec_12', fixtureTime(0, 12, 0, 0, 0, 0), 1);
    const eleventh = run('rec_11', fixtureTime(0, 11, 0, 0, 0, 0));

    await treasury.recordReconciliationRun(tenth);
    expect(await treasury.latestReconciliationRun()).toEqual(tenth);

    await treasury.recordReconciliationRun(twelfth);
    await treasury.recordReconciliationRun(eleventh);

    expect(await treasury.latestReconciliationRun()).toEqual(twelfth);
    expect(await constraintOf(treasury.recordReconciliationRun(tenth))).toBe('reconciliation_runs_pkey');
  });

  it('breaks a tie between runs at the same time by ID', async () => {
    const at = fixtureTime(0, 13, 0, 0, 0, 0);
    await treasury.recordReconciliationRun(run('rec_13_b', at));
    await treasury.recordReconciliationRun(run('rec_13_a', at));

    expect((await treasury.latestReconciliationRun())?.id).toBe('rec_13_b');
  });
});
