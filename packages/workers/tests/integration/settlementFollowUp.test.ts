import { fixtureTime } from '@anyfare/testing';

import { encodeFunctionData, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { Abis, Transaction } from 'viem/tempo';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createLogger, randomIdGenerator } from '@anyfare/common';
import { loadPlatformConfig, type JsonObject, type PlatformConfig } from '@anyfare/core';
import { createLedger, createPaymentRepository, createRoutingRepository, ledgerAccountIds } from '@anyfare/db';
import {
  createFacilitatorLookup, createFacilitators, createMppSettlementCheck, createTempoRpc, encodeMppReceipt, encodeSettleReceipt, mppReceiptGraceMs,
  refusedReason, toMppSettlementRequest, type MppSettlementCheck,
} from '@anyfare/payments';
import {
  createFakeClock, createTestDatabase, nearFacilitatorOff, facilitatorAnswers, moderatoChainId, pathUsdAddress, startFakeFacilitator, startFakeTempoRpc,
  type FakeFacilitator, type FakeTempoRpc, type TempoBroadcast, type TestDatabase,
} from '@anyfare/testing';

import { createSettlementFollowUp, presubmissionRefusals, SettlementFollowUpError, settlingGraceMs } from '../../src/settlementFollowUp.js';

const base = 'eip155:84532';
const solana = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const tempo = 'eip155:42431';
const clock = createFakeClock(fixtureTime(0, 9, 12, 0, 0, 0));
const silent = createLogger({ level: 'silent' });
// The buyer's quote, and the target's price within it: the routing fee is the rest
const quote = 1_000n;
const targetPrice = 800n;
const zeros = { settled: 0, failed: 0, pending: 0, unknown: 0, skipped: 0 };
const settlementPendingReason = 'settlement_pending';

let database: TestDatabase;
let facilitator: FakeFacilitator;
let rpc: FakeTempoRpc;
let config: PlatformConfig;
let graceMs: number;
let counter = 0;

beforeAll(async () => {
  [database, facilitator, rpc] = await Promise.all([createTestDatabase(), startFakeFacilitator({ networks: [base, solana] }), startFakeTempoRpc()]);
  config = await loadPlatformConfig({
    env: {
      CONFIG_PATH: 'config/example.yaml',
      CONFIG: Buffer.from(JSON.stringify({
        facilitators: [{ name: 'cdp', url: facilitator.url, networks: [base, solana] }, nearFacilitatorOff],
      })).toString('base64'),
    },
  });
  graceMs = settlingGraceMs(config);
});

afterAll(async () => {
  await Promise.all([facilitator?.close(), rpc?.close()]);
  await database?.drop();
});

beforeEach(() => {
  facilitator.reset();
  rpc.reset();
});

const payments = () => createPaymentRepository({ db: database.db, clock });
const find = (id: string) => payments().find(id);
const statusOf = async (id: string) => (await find(id))?.status;
const settleRequests = () => facilitator.requests.filter(request => request.path === '/settle');

// The target leg the proxy records once the Signer paid the target, before the buyer's settlement
const recordTargetLeg = async (paymentId: string, protocol: 'x402' | 'mpp' = 'x402'): Promise<void> => {
  const routing = createRoutingRepository({ db: database.db, clock });
  await routing.recordTargetPayment({
    paymentId, protocol, network: base, asset: 'base-usdc', amount: targetPrice, atomicAmount: targetPrice,
    payTo: '0x4444444444444444444444444444444444444444', signatureId: `sig_${paymentId}`,
  });
  await routing.updateTargetPayment(paymentId, { status: 'settled', transactionHash: `0x${counter.toString(16).padStart(64, 'a')}` });
};

interface X402Settling {
  // The buyer got the response: the rail recorded the receipt it sent
  readonly receipt?: string;
  // Recorded with the settle request to repeat. Default: true.
  readonly request?: boolean;
  // The facilitator's settled answer, kept when only the booking failed
  readonly settled?: Record<string, unknown>;
  readonly needsReview?: boolean;
  readonly network?: string;
  // When the buyer's authorization expires, in seconds from now. Default: an hour.
  readonly validForSeconds?: number;
}

/** A settling x402 payment for a routed call, as the rail leaves it. */
const settling = async ({ receipt, request = true, settled, needsReview, network = base, validForSeconds = 3_600 }: X402Settling = {}): Promise<string> => {
  counter += 1;
  const id = `pay_settling_${counter}`;
  await payments().create({
    id, requestId: `req-${counter}`, rail: 'x402', buyerAccountId: undefined, keyId: undefined, targetHost: 'api.target.test', targetPath: '/v1/quote',
    network, asset: network === solana ? 'solana-usdc' : 'base-usdc', atomicAmount: quote, amount: quote, status: 'verified',
  });
  await recordTargetLeg(id);
  const validBefore = String(Math.floor(clock.now().getTime() / 1_000) + validForSeconds);
  const settlementRequest = {
    paymentPayload: network === solana
      ? { x402Version: 2, accepted: { network }, payload: { transaction: `transaction-${counter}` } }
      : { x402Version: 2, accepted: { network }, payload: { authorization: { from: '0x5555555555555555555555555555555555555555', nonce: `0x${counter}`, validBefore } } },
    paymentRequirements: { network },
    ...settled ? { settled } : {},
  } as unknown as JsonObject;
  await payments().changeStatus({
    paymentId: id,
    to: 'settling',
    ...receipt ? { receipt, transactionHash: '0xbroadcast' } : {},
    ...needsReview === undefined ? {} : { needsReview },
    ...request ? { settlementRequest } : {},
  });

  return id;
};

const followUpWith = (overrides: { logger?: typeof silent; mppCheck?: MppSettlementCheck; payments?: ReturnType<typeof payments> } = {}) => createSettlementFollowUp({
  payments: overrides.payments ?? payments(),
  ledger: createLedger({ db: database.db, clock, ids: randomIdGenerator }),
  facilitatorFor: createFacilitatorLookup(config, createFacilitators({ config, cdpApiKey: () => { throw new Error('No CDP key in tests'); }, clock })),
  ...overrides.mppCheck ? { mppCheck: overrides.mppCheck } : {},
  clock,
  settleMs: config.timeouts.settleMs,
  logger: overrides.logger ?? silent,
});

/** One run, once the payments settling now have waited out the grace period. */
const followUp = async ({ logger = silent, mppCheck, waitMs = graceMs + 1_000 }: { logger?: typeof silent; mppCheck?: MppSettlementCheck; waitMs?: number } = {}) => {
  clock.advance(waitMs);

  return followUpWith({ logger, ...mppCheck ? { mppCheck } : {} })();
};

const undecided = async (run: Promise<unknown>): Promise<unknown> => {
  const error = await run.catch((thrown: unknown) => thrown);
  expect(error).toBeInstanceOf(SettlementFollowUpError);

  return (error as SettlementFollowUpError).result;
};

const capture = () => {
  const lines: Record<string, unknown>[] = [];

  return { lines, logger: createLogger({ level: 'debug' }, { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) }) };
};

describe('the settlement follow-up for x402', () => {
  it('repeats the identical settle, books a settled payment, and flags it for review only when the buyer got no response', async () => {
    const answered = await settling({ receipt: 'eyJzdWNjZXNzIjpmYWxzZX0=' });
    const unanswered = await settling();
    const before = settleRequests().length;

    const result = await followUp();

    expect(result).toEqual({ ...zeros, settled: 2 });
    expect(await find(answered)).toMatchObject({ status: 'settled', needsReview: false, receipt: 'eyJzdWNjZXNzIjpmYWxzZX0=', fee: quote - targetPrice });
    expect(await find(unanswered)).toMatchObject({ status: 'settled', needsReview: true, transactionHash: expect.stringMatching(/^0x[0-9a-f]{64}$/), receipt: expect.any(String) });
    expect(settleRequests().slice(before).map(request => request.body)).toEqual([
      expect.objectContaining({ x402Version: 2, paymentPayload: expect.objectContaining({ x402Version: 2 }), paymentRequirements: { network: base } }),
      expect.objectContaining({ x402Version: 2 }),
    ]);
    // Final: nothing left to repeat
    expect(await followUp()).toEqual(zeros);
  });

  it('books the target\'s price out of its leg\'s treasury, the buyer\'s money into its asset\'s, and the rest as the fee', async () => {
    const platform = [ledgerAccountIds.treasury('base-usdc'), ledgerAccountIds.routingFees];
    const ledger = createLedger({ db: database.db, clock, ids: randomIdGenerator });
    const before = await ledger.balancesOf(platform);
    await settling({ receipt: 'eyJ9' });

    expect(await followUp()).toMatchObject({ settled: 1 });

    const after = await ledger.balancesOf(platform);
    const moved = (id: string) => (after.get(id) ?? 0n) - (before.get(id) ?? 0n);
    // In from the buyer, out to the target, in the same treasury
    expect(moved(ledgerAccountIds.treasury('base-usdc'))).toBe(targetPrice - quote);
    expect(moved(ledgerAccountIds.routingFees)).toBe(quote - targetPrice);
  });

  it('books a settled answer the rail kept when only its booking failed, without asking the facilitator again', async () => {
    const settled = { success: true, transaction: `0x${'c'.repeat(64)}`, network: base, payer: '0x5555555555555555555555555555555555555555' };
    const kept = await settling({ settled, receipt: encodeSettleReceipt(settled as never), needsReview: true });
    const before = facilitator.requests.length;

    const result = await followUp();

    expect(result).toEqual({ ...zeros, settled: 1 });
    expect(facilitator.requests.slice(before)).toEqual([]);
    expect(await find(kept)).toMatchObject({
      status: 'settled', needsReview: true, transactionHash: settled.transaction, receipt: encodeSettleReceipt(settled as never), fee: quote - targetPrice,
    });
  });

  it('encodes the receipt from the kept answer when the rail recorded none', async () => {
    const settled = { success: true, transaction: `0x${'e'.repeat(64)}`, network: base, payer: '0x5555555555555555555555555555555555555555' };
    const kept = await settling({ settled });
    const before = facilitator.requests.length;

    expect(await followUp()).toEqual({ ...zeros, settled: 1 });

    expect(facilitator.requests.slice(before)).toEqual([]);
    const booked = await find(kept);
    expect(booked).toMatchObject({ status: 'settled', needsReview: true, transactionHash: settled.transaction });
    expect(JSON.parse(Buffer.from(booked!.receipt!, 'base64').toString('utf8'))).toEqual(settled);
  });

  it('waits twice the settle timeout and a minute: a finalize may settle twice, or broadcast and then read the receipt', () => {
    expect(graceMs).toBe(2 * config.timeouts.settleMs + 60_000);
    expect(settlingGraceMs({ timeouts: { ...config.timeouts, settleMs: 45_000 } })).toBe(150_000);
  });

  it('leaves a payment updated too recently to its finalize, and follows it up once the grace period has passed', async () => {
    const young = await settling();
    const before = settleRequests().length;

    // Twice the settle timeout and a minute: not yet
    const early = await followUp({ waitMs: 2 * config.timeouts.settleMs + 60_000 });

    expect(early).toEqual(zeros);
    expect(settleRequests().length).toBe(before);
    expect(await statusOf(young)).toBe('settling');
    expect(await followUp({ waitMs: 1 })).toEqual({ ...zeros, settled: 1 });
    expect(await statusOf(young)).toBe('settled');
  });

  it('leaves a pending payment for the next run, and flags it for review once the facilitator calls its authorization expired', async () => {
    const { lines, logger } = capture();
    const pending = await settling({ receipt: 'eyJ9' });
    facilitator.handle('/settle', facilitatorAnswers.pending('0xstill'));

    const first = await followUp();
    // After a broadcast, an expired authorization may be the one that landed
    facilitator.handle('/settle', facilitatorAnswers.failed('invalid_exact_evm_payload_authorization_valid_before'));
    const second = await undecided(followUp({ logger }));

    expect(first).toEqual({ ...zeros, pending: 1 });
    expect(second).toEqual({ ...zeros, unknown: 1 });
    expect(await find(pending)).toMatchObject({ status: 'settling', needsReview: true, fee: undefined });
    expect(lines.find(line => line['paymentId'] === pending && line['alert'] === true)).toMatchObject({
      level: 50, facilitator: 'cdp', reason: 'invalid_exact_evm_payload_authorization_valid_before', msg: expect.stringContaining('needs review'),
    });
    await payments().changeStatus({ paymentId: pending, to: 'failed', settlementRequest: null });
  });

  it('never sends a payment flagged for review to the facilitator again, nor marks it failed, and counts it on every run with its alert', async () => {
    const { lines, logger } = capture();
    const flagged = await settling({ receipt: 'eyJ9' });
    facilitator.handle('/settle', facilitatorAnswers.failed('invalid_exact_evm_nonce_already_used'));
    await undecided(followUp());
    const before = facilitator.requests.length;
    facilitator.handle('/settle', facilitatorAnswers.failed('invalid_exact_evm_recipient_mismatch'));

    const runs = [await undecided(followUp({ logger })), await undecided(followUp({ logger, waitMs: 1 }))];

    expect(runs).toEqual([{ ...zeros, unknown: 1 }, { ...zeros, unknown: 1 }]);
    expect(facilitator.requests.slice(before)).toEqual([]);
    expect(await find(flagged)).toMatchObject({ status: 'settling', needsReview: true });
    expect(lines.filter(line => line['paymentId'] === flagged && line['alert'] === true)).toEqual([
      expect.objectContaining({ level: 50, msg: 'A settling payment flagged for review is waiting for an operator' }),
      expect.objectContaining({ level: 50, msg: 'A settling payment flagged for review is waiting for an operator' }),
    ]);
    await payments().changeStatus({ paymentId: flagged, to: 'failed', settlementRequest: null });
  });

  it.each([
    'invalid_exact_evm_recipient_mismatch',
    'invalid_exact_evm_payload_recipient_mismatch',
    'invalid_payload',
    'invalid_exact_evm_insufficient_balance',
  ])('marks a payment refused with %s, decided before any submission, failed while its deadline is well ahead', async reason => {
    const refused = await settling();
    facilitator.handle('/settle', facilitatorAnswers.failed(reason));

    expect(await followUp()).toEqual({ ...zeros, failed: 1 });
    expect(await find(refused)).toMatchObject({ status: 'failed', needsReview: false, fee: undefined });
  });

  it('flags a refusal decided before any submission for review once the deadline is within the settle timeout, or unknown', async () => {
    // Expires 20 seconds after the run: a settle may still have landed in time
    const closing = await settling({ validForSeconds: graceMs / 1_000 + 21 });
    const noDeadline = await settling({ request: false });
    await payments().changeStatus({
      paymentId: noDeadline, to: 'settling', settlementRequest: { paymentPayload: { x402Version: 2, payload: {} }, paymentRequirements: { network: base } },
    });
    facilitator.handle('/settle', facilitatorAnswers.failed('invalid_exact_evm_recipient_mismatch'));

    expect(await undecided(followUp())).toEqual({ ...zeros, unknown: 2 });
    expect(await Promise.all([closing, noDeadline].map(async id => (await find(id))?.needsReview))).toEqual([true, true]);
    for (const id of [closing, noDeadline])
      await payments().changeStatus({ paymentId: id, to: 'failed', settlementRequest: null });
  });

  it.each([
    'invalid_exact_evm_nonce_already_used',
    'invalid_exact_evm_payload_authorization_valid_before',
    'permit2_deadline_expired',
    'permit2_insufficient_balance',
    'insufficient_funds',
    'invalid_exact_evm_signature',
    'invalid_exact_evm_payload_signature',
    'invalid_exact_evm_transaction_failed',
    'invalid_exact_evm_transaction_simulation_failed',
    'unknown_settlement_error',
    'execution reverted',
  ])('keeps a payment the facilitator refuses with %s settling, flags it for review with an alert, and fails the run', async reason => {
    const { lines, logger } = capture();
    const used = await settling({ receipt: 'eyJ9' });
    facilitator.handle('/settle', facilitatorAnswers.failed(reason));

    expect(await undecided(followUp({ logger }))).toEqual({ ...zeros, unknown: 1 });

    expect(await find(used)).toMatchObject({ status: 'settling', needsReview: true, fee: undefined });
    expect(lines.find(line => line['paymentId'] === used && line['alert'] === true)).toMatchObject({ level: 50, facilitator: 'cdp', network: base, reason });
    await payments().changeStatus({ paymentId: used, to: 'failed', settlementRequest: null });
  });

  it.each([400, 404, 409])('flags a payment whose repeated settle the facilitator refuses with a plain %i for review: nothing says what was submitted', async status => {
    const refused = await settling();
    facilitator.handle('/settle', () => ({ status, body: { errorType: 'invalid_request', errorMessage: 'refused' } }));
    const { lines, logger } = capture();

    expect(await undecided(followUp({ logger }))).toEqual({ ...zeros, unknown: 1 });

    expect(await find(refused)).toMatchObject({ status: 'settling', needsReview: true });
    expect(lines.find(line => line['paymentId'] === refused && line['alert'] === true)).toMatchObject({ reason: `refused_${status}` });
    await payments().changeStatus({ paymentId: refused, to: 'failed', settlementRequest: null });
  });

  it.each([
    ['duplicate_settlement', 'review'],
    ['invalid_exact_svm_transaction_simulation_failed', 'review'],
    ['invalid_exact_svm_transaction_failed', 'review'],
    ['invalid_exact_svm_verification_failed', 'review'],
    ['invalid_exact_svm_payload_mint_mismatch', 'failed'],
    ['invalid_exact_svm_payload_transaction_could_not_be_decoded', 'failed'],
  ] as const)('on Solana, takes %s as %s', async (reason, outcome) => {
    const refused = await settling({ network: solana });
    facilitator.handle('/settle', facilitatorAnswers.failed(reason));

    const result = outcome === 'failed' ? await followUp() : await undecided(followUp());

    expect(result).toEqual(outcome === 'failed' ? { ...zeros, failed: 1 } : { ...zeros, unknown: 1 });
    expect(await find(refused)).toMatchObject(outcome === 'failed' ? { status: 'failed' } : { status: 'settling', needsReview: true });
    if (outcome === 'review')
      await payments().changeStatus({ paymentId: refused, to: 'failed', settlementRequest: null });
  });

  it('lists only reasons of @x402/evm and @x402/svm decided before a submission as final', () => {
    for (const reason of [
      'invalid_exact_evm_nonce_already_used', 'duplicate_settlement', 'permit2_invalid_nonce', 'invalid_exact_evm_failed_to_verify_signature', 'insufficient_funds',
      'invalid_exact_evm_signature', 'invalid_exact_evm_payload_signature', refusedReason(400), refusedReason(409), settlementPendingReason,
    ])
      expect(presubmissionRefusals.has(reason)).toBe(false);
  });

  it('fails the run when the facilitator doesn\'t answer, keeping the payment settling for the next one', async () => {
    const waiting = await settling();
    facilitator.handle('/settle', facilitatorAnswers.unavailable);

    const error = await followUp().catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(SettlementFollowUpError);
    expect((error as SettlementFollowUpError).result).toEqual({ ...zeros, unknown: 1 });
    expect(await statusOf(waiting)).toBe('settling');
    facilitator.reset();
    expect(await followUp()).toEqual({ ...zeros, settled: 1 });
    expect(await statusOf(waiting)).toBe('settled');
  });

  it('skips a payment it can\'t repeat, and fails the run so it gets looked at', async () => {
    const orphan = await settling({ request: false });

    const error = await followUp().catch((thrown: unknown) => thrown);

    expect((error as SettlementFollowUpError).result).toEqual({ ...zeros, skipped: 1 });
    expect(await statusOf(orphan)).toBe('settling');
    await payments().changeStatus({ paymentId: orphan, to: 'failed' });
  });

  it('asks the facilitator once when two runners follow up the same payment at the same time', async () => {
    const shared = await settling();
    facilitator.handle('/settle', request => ({ ...facilitatorAnswers.settled(request), delayMs: 100 }));
    const before = settleRequests().length;
    clock.advance(graceMs + 1_000);

    const results = await Promise.all([followUpWith()(), followUpWith()()]);

    expect(settleRequests().length - before).toBe(1);
    expect(results).toEqual(expect.arrayContaining([{ ...zeros, settled: 1 }, zeros]));
    expect(await statusOf(shared)).toBe('settled');
  });

  it('skips a payment another runner claimed after this one listed it, counting nothing', async () => {
    const shared = await settling();
    clock.advance(graceMs + 1_000);
    // A runner whose list was read before the other runner's claim
    const listed = await payments().listSettling({ limit: 100, updatedBefore: new Date(clock.now().getTime() - graceMs) });
    const stale = { ...payments(), listSettling: async () => listed };
    const first = await followUpWith()();
    const before = settleRequests().length;

    const second = await followUpWith({ payments: stale })();

    expect(first).toEqual({ ...zeros, settled: 1 });
    expect(second).toEqual(zeros);
    expect(settleRequests().length).toBe(before);
    expect(await statusOf(shared)).toBe('settled');
  });

  it('counts a payment as undecided while the workers have no facilitator for its network', async () => {
    const waiting = await settling();
    clock.advance(graceMs + 1_000);
    const before = facilitator.requests.length;

    const result = await undecided(createSettlementFollowUp({
      payments: payments(), ledger: createLedger({ db: database.db, clock, ids: randomIdGenerator }), facilitatorFor: () => undefined, clock,
      settleMs: config.timeouts.settleMs, logger: silent,
    })());

    expect(result).toEqual({ ...zeros, unknown: 1 });
    expect(facilitator.requests.length).toBe(before);
    expect(await statusOf(waiting)).toBe('settling');
    expect(await followUp({ waitMs: 1 })).toEqual({ ...zeros, settled: 1 });
  });

  it('counts a settled payment the ledger can\'t book as undecided, and books it on a later run', async () => {
    const { lines, logger } = capture();
    counter += 1;
    // No target leg yet: the ledger refuses to book a call nobody paid
    const id = `pay_settling_${counter}`;
    await payments().create({
      id, requestId: `req-${counter}`, rail: 'x402', buyerAccountId: undefined, keyId: undefined, targetHost: 'api.target.test', targetPath: '/v1/quote',
      network: base, asset: 'base-usdc', atomicAmount: quote, amount: quote, status: 'verified',
    });
    await payments().changeStatus({
      paymentId: id, to: 'settling', settlementRequest: { paymentPayload: { x402Version: 2, payload: {} }, paymentRequirements: { network: base } },
    });

    const error = await followUp({ logger }).catch((thrown: unknown) => thrown);
    await recordTargetLeg(id);
    const later = await followUp();

    expect((error as SettlementFollowUpError).result).toEqual({ ...zeros, unknown: 1 });
    expect(lines.find(line => line['paymentId'] === id && line['msg'] === 'The settlement follow-up couldn\'t book a settled payment')).toMatchObject({
      level: 50, error: { message: expect.stringContaining('has no target leg') },
    });
    expect(later).toEqual({ ...zeros, settled: 1 });
    expect(await statusOf(id)).toBe('settled');
  });
});

describe('the follow-up\'s lines', () => {
  it('logs each settlement it finishes, and each that fails for good with the facilitator\'s reason, by payment ID', async () => {
    const { lines, logger } = capture();
    const settled = await settling({ receipt: 'eyJ9' });
    await followUp({ logger });
    const failing = await settling();
    facilitator.handle('/settle', facilitatorAnswers.failed('invalid_exact_evm_recipient_mismatch'));
    await followUp({ logger });
    const undecided = await settling();
    facilitator.handle('/settle', facilitatorAnswers.unavailable);
    await expect(followUp({ logger })).rejects.toBeInstanceOf(SettlementFollowUpError);

    expect(lines.find(line => line['paymentId'] === settled && line['msg'] === 'The settlement follow-up settled a payment')).toMatchObject({
      level: 30, rail: 'x402', network: base, facilitator: 'cdp', transaction: expect.any(String), needsReview: false,
    });
    expect(lines.find(line => line['paymentId'] === failing && line['msg'] === 'A settlement failed for good. Nothing was booked.')).toMatchObject({
      level: 40, facilitator: 'cdp', reason: 'invalid_exact_evm_recipient_mismatch',
    });
    expect(lines.find(line => line['paymentId'] === undecided && line['msg'] === 'A settlement is still undecided')).toMatchObject({
      level: 40, facilitator: 'cdp', error: { code: 'facilitator_unavailable', path: '/settle', status: 503, network: base },
    });
    facilitator.reset();
    await followUp();
  });
});

describe('the settlement follow-up for MPP, through the Tempo node', () => {
  const recipient = '0x2222222222222222222222222222222222222222';
  const payer = privateKeyToAccount(generatePrivateKey());
  const check = (at = clock) => createMppSettlementCheck({ rpc: createTempoRpc({ network: config.mpp.network, url: rpc.url }), timeoutMs: 1_000, clock: at });
  // In Unix seconds, past both the real time the node checks and the test's clock
  const validBefore = () => Math.floor(Math.max(Date.now(), clock.now().getTime()) / 1_000) + 3_600;

  /** A payer's signed TIP-20 transfer to our recipient, as the buyer's MPP credential carries it. */
  const signTransfer = (amount: bigint, until: number): Promise<Hex> => {
    counter += 1;
    const data = encodeFunctionData({ abi: Abis.tip20, functionName: 'transfer', args: [recipient, amount] });

    return payer.signTransaction({
      type: 'tempo', chainId: moderatoChainId, calls: [{ to: pathUsdAddress, data }], nonce: counter, gas: 100_000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n,
      validBefore: until,
    }, { serializer: Transaction.serialize });
  };

  /** Broadcasts it to the node, which treats it as `outcome` says, and returns its hash. */
  const broadcast = async (raw: Hex, outcome: TempoBroadcast): Promise<Hex> => {
    rpc.broadcast(outcome);
    const response = await fetch(rpc.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransactionSync', params: [raw] }),
    });
    await response.text();
    rpc.reset();

    return rpc.transactions.at(-1)!;
  };

  /** A settling MPP payment whose broadcast outcome was unknown, as the rail leaves it: a hash and no receipt. */
  const settlingMpp = async ({ hash, until, amount = quote, receipt }: { hash: Hex; until: number; amount?: bigint; receipt?: string }): Promise<string> => {
    counter += 1;
    const id = `pay_mpp_settling_${counter}`;
    await payments().create({
      id, requestId: `req-${counter}`, rail: 'mpp', buyerAccountId: undefined, keyId: undefined, targetHost: 'api.target.test', targetPath: '/v1/quote',
      network: tempo, asset: 'tempo-pathusd', atomicAmount: quote, amount: quote, status: 'verified', transactionHash: hash,
    });
    await recordTargetLeg(id, 'mpp');
    await payments().changeStatus({
      paymentId: id,
      to: 'settling',
      transactionHash: hash,
      ...receipt === undefined ? {} : { receipt, needsReview: true },
      settlementRequest: toMppSettlementRequest({
        rail: 'mpp', transactionHash: hash, validBefore: until, currency: pathUsdAddress, sender: payer.address, recipient, amount: amount.toString(),
      }),
    });

    return id;
  };

  it('reads the transaction\'s receipt, books a settled one once, flagged for review, and never broadcasts', async () => {
    const until = validBefore();
    const hash = await broadcast(await signTransfer(quote, until), 'confirm');
    const paid = await settlingMpp({ hash, until });
    const mppCheck = check();

    const result = await followUp({ mppCheck });

    expect(result).toEqual({ ...zeros, settled: 1 });
    expect(rpc.calls.map(call => call.method)).toEqual(['eth_getTransactionReceipt']);
    expect(await find(paid)).toMatchObject({
      status: 'settled', needsReview: true, transactionHash: hash, receipt: encodeMppReceipt(hash, clock.now()), fee: quote - targetPrice,
    });
    expect(await followUp({ mppCheck })).toEqual(zeros);
    expect(rpc.rawTransactions).toEqual([]);
  });

  it('keeps the receipt the rail recorded when its booking failed, and the payment flagged for review', async () => {
    const until = validBefore();
    const hash = await broadcast(await signTransfer(quote, until), 'confirm');
    const paid = await settlingMpp({ hash, until, receipt: 'eyJyZWNlaXB0Ijp0cnVlfQ' });

    expect(await followUp({ mppCheck: check() })).toEqual({ ...zeros, settled: 1 });
    expect(await find(paid)).toMatchObject({ status: 'settled', needsReview: true, receipt: 'eyJyZWNlaXB0Ijp0cnVlfQ' });
  });

  it('leaves a transaction the node holds but hasn\'t included for the next run, then books it once it is', async () => {
    const until = validBefore();
    const hash = await broadcast(await signTransfer(quote, until), 'already-known-pending');
    const waiting = await settlingMpp({ hash, until });

    const first = await followUp({ mppCheck: check() });
    rpc.include(hash);
    const second = await followUp({ mppCheck: check() });

    expect(first).toEqual({ ...zeros, pending: 1 });
    expect(second).toEqual({ ...zeros, settled: 1 });
    expect(await statusOf(waiting)).toBe('settled');
  });

  it('marks a reverted or transferless transaction failed, and one never included once its window has passed', async () => {
    const until = validBefore();
    const reverted = await settlingMpp({ hash: await broadcast(await signTransfer(quote, until), 'revert'), until });
    // The transaction pays less than the payment expects
    const transferless = await settlingMpp({ hash: await broadcast(await signTransfer(quote - 1n, until), 'confirm'), until });
    const never = await settlingMpp({ hash: `0x${'d'.repeat(64)}`, until });

    const first = await followUp({ mppCheck: check() });
    const pastWindow = createFakeClock(new Date(until * 1_000 + mppReceiptGraceMs + 1_000));
    const second = await followUp({ mppCheck: check(pastWindow) });

    expect(first).toEqual({ ...zeros, failed: 2, pending: 1 });
    expect(second).toEqual({ ...zeros, failed: 1 });
    expect(await Promise.all([reverted, transferless, never].map(statusOf))).toEqual(['failed', 'failed', 'failed']);
    expect(await find(transferless)).toMatchObject({ fee: undefined });
  });

  it('never marks a payment flagged for review failed, whatever the node says, and books it once it settles', async () => {
    const until = validBefore();
    const reverted = await settlingMpp({ hash: await broadcast(await signTransfer(quote, until), 'revert'), until, receipt: 'eyJyZWNlaXB0Ijp0cnVlfQ' });
    const { lines, logger } = capture();

    const result = await undecided(followUp({ mppCheck: check(), logger }));

    expect(result).toEqual({ ...zeros, unknown: 1 });
    expect(await find(reverted)).toMatchObject({ status: 'settling', needsReview: true });
    expect(lines.find(line => line['paymentId'] === reverted && line['alert'] === true)).toMatchObject({
      level: 50, rail: 'mpp', msg: 'A settling payment flagged for review is waiting for an operator',
    });
    await payments().changeStatus({ paymentId: reverted, to: 'failed', settlementRequest: null });
  });

  it('fails the run when the Tempo node doesn\'t answer, or the workers have none, keeping the payment settling', async () => {
    const until = validBefore();
    const hash = await broadcast(await signTransfer(quote, until), 'confirm');
    const waiting = await settlingMpp({ hash, until });
    const { lines, logger } = capture();

    rpc.unavailable(true);
    const unanswered = await followUp({ mppCheck: check(), logger }).catch((thrown: unknown) => thrown);
    rpc.unavailable(false);
    const unset = await followUp().catch((thrown: unknown) => thrown);

    expect((unanswered as SettlementFollowUpError).result).toEqual({ ...zeros, unknown: 1 });
    expect((unset as SettlementFollowUpError).result).toEqual({ ...zeros, unknown: 1 });
    expect(await statusOf(waiting)).toBe('settling');
    expect(lines.find(line => line['paymentId'] === waiting && line['msg'] === 'An MPP payment is still undecided')).toMatchObject({
      level: 40, rail: 'mpp', network: tempo, transaction: hash, reason: expect.any(String),
    });
    expect(JSON.stringify(lines)).not.toContain(rpc.url);
    expect(await followUp({ mppCheck: check() })).toEqual({ ...zeros, settled: 1 });
  });
});
