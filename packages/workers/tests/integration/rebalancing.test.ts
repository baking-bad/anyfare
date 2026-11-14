import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Registry } from '@prometheus-io/client';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createLogger, randomIdGenerator, Secret } from '@anyfare/common';
import { loadPlatformConfig, type Asset, type BalanceReader, type PlatformConfig } from '@anyfare/core';
import {
  createLedger, createRefillRepository, createTreasuryRepository, ledgerAccountIds, refills, type Refill, type RefillRepository,
} from '@anyfare/db';
import {
  createFakeClock, createTestDatabase, encodeBase58, startFakeOneClick, testnetNearUsdcAddress, type FakeClock, type FakeOneClick, type TestDatabase,
} from '@anyfare/testing';
import { createOneClickClient, type OneClickClient } from '@anyfare/topups';

import {
  alertRepeatMs, createRebalancing, createRebalancingMetrics, pendingAfterDeadlineMs, RebalancingFailedError, refusalPauseMs, requestedLimitMs, stuckRequestedMs,
  underFloorAlertMs, unfinishedAlertMs,
  type RebalancingOptions,
} from '../../src/rebalancing.js';
import { createRefillSigner } from '../../src/signerClient.js';

// The rebalancing job against the fake 1Click and a fake Signer: a tiny HTTP server that answers what
// each case needs. By default it asks the fake 1Click for a real quote, so 1Click knows its deposit
// address, and answers that it sent it.

const noon = '2026-11-12T12:00:00.000Z';
const minuteMs = 60_000;
const hourMs = 60 * minuteMs;
const secret = 'signer-secret-0123456789abcdef-0123456789';
// Made-up wallets: the Signer's on Base, Solana and NEAR
const baseWallet = privateKeyToAccount(generatePrivateKey()).address;
const solanaWallet = encodeBase58(randomBytes(32));
const hotWallet = 'hot.anyfare.testnet';
// 1Click's USDC on Base and Solana, to quote refills to
const destinations: Readonly<Record<string, string>> = {
  'base-usdc': 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',
  'solana-usdc': 'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near',
};

const logs: Record<string, unknown>[] = [];
const logger = createLogger({ level: 'debug' }, { write: (line: string) => logs.push(JSON.parse(line) as Record<string, unknown>) });
const linesOf = (message: string) => logs.filter(line => line['msg'] === message);

let database: TestDatabase;
let clock: FakeClock;
let oneClick: FakeOneClick;
let client: OneClickClient;
let config: PlatformConfig;
let repository: RefillRepository;

// The fake Signer: every ask it got, and its answer to each
interface SignerAsk {
  readonly headers: IncomingHttpHeaders;
  readonly body: { readonly refillId: string; readonly asset: string; readonly amount: string };
}
interface SignerAnswer {
  readonly status: number;
  readonly body?: unknown;
  // Holds the answer back, such as past the client's timeout
  readonly delayMs?: number;
  // Cuts the connection without an answer
  readonly destroy?: boolean;
}
const asks: SignerAsk[] = [];
let answerWith: (ask: SignerAsk) => Promise<SignerAnswer> | SignerAnswer;
let signerUrl: string;
let closeSigner: () => Promise<void>;

// What the Signer does: a real EXACT_OUTPUT quote to our wallet, and the transfer it sent
const quoteFor = async (ask: SignerAsk, deadline: string) => client.quote({
  dry: false, swapType: 'EXACT_OUTPUT', slippageTolerance: 50, originAsset: `nep141:${testnetNearUsdcAddress}`, depositType: 'ORIGIN_CHAIN',
  destinationAsset: destinations[ask.body.asset]!, amount: ask.body.amount, refundTo: hotWallet, refundType: 'ORIGIN_CHAIN',
  recipient: ask.body.asset === 'base-usdc' ? baseWallet : solanaWallet, recipientType: 'DESTINATION_CHAIN',
  deadline, depositMode: 'SIMPLE',
});
const transferOf = async (ask: SignerAsk) => {
  // The Signer answers the deadline it asked for, not the quote's own, which is 72 hours later
  const deadline = new Date(clock.now().getTime() + 30 * minuteMs).toISOString();
  const quote = await quoteFor(ask, deadline);

  return {
    depositAddress: quote.quote.depositAddress, amountIn: quote.quote.amountIn, amountOut: quote.quote.amountOut, quoteDeadline: deadline,
    correlationId: quote.correlationId, transactionHash: encodeBase58(randomBytes(32)), quote: quote.raw,
  };
};
const sent = async (ask: SignerAsk): Promise<SignerAnswer> => ({ status: 200, body: { ...ask.body, ...await transferOf(ask) } });
const refusal = (status: number, code: string, fields: Record<string, unknown> = {}): SignerAnswer => ({ status, body: { error: { code, message: `The Signer's ${code}` }, ...fields } });

// The Signer's wallets' balances, by asset, in atomic units: Base well above its $5 floor, Solana at $1, under its $3 floor
const balances = new Map<string, bigint>();
const failing = new Set<string>();
const reads: string[] = [];
const reader: BalanceReader = {
  balance: async ({ address, asset }) => {
    reads.push(`${asset.name} ${address}`);
    if (failing.has(asset.name))
      throw new Error('The RPC didn\'t answer');

    return balances.get(asset.name) ?? 0n;
  },
};

beforeAll(async () => {
  clock = createFakeClock(noon);
  [database, oneClick] = await Promise.all([createTestDatabase(), startFakeOneClick({ now: clock.now })]);
  client = createOneClickClient({ url: oneClick.url, timeoutMs: 2_000 });
  config = await loadPlatformConfig({
    env: {
      CONFIG_PATH: 'config/example.yaml',
      CONFIG: Buffer.from(JSON.stringify({
        topups: { url: oneClick.url }, signer: { wallets: { base: baseWallet, solana: solanaWallet, near: hotWallet } }, rebalancing: { enabled: true },
      })).toString('base64'),
    },
  });
  repository = createRefillRepository({ db: database.db, clock, ids: randomIdGenerator });
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => void (async () => {
      const ask: SignerAsk = { headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as SignerAsk['body'] };
      asks.push(ask);
      const answer = await answerWith(ask);
      if (answer.destroy) {
        request.socket.destroy();
        return;
      }
      setTimeout(() => {
        response.writeHead(answer.status, { 'content-type': 'application/json' });
        response.end(answer.body === undefined ? '' : JSON.stringify(answer.body));
      }, answer.delayMs ?? 0);
    })());
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  signerUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  closeSigner = async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  };
});

beforeEach(() => {
  clock.set(noon);
  logs.length = 0;
  asks.length = 0;
  reads.length = 0;
  answerWith = sent;
  failing.clear();
  balances.set('base-usdc', 100_000_000n);
  balances.set('solana-usdc', 1_000_000n);
});

afterEach(async () => {
  oneClick.reset();
  // Each test follows its own refills
  await database.db.delete(refills);
});

afterAll(async () => {
  await closeSigner?.();
  await oneClick?.close();
  await database?.drop();
});

let registry: Registry;
const job = (changes: Partial<RebalancingOptions> = {}) => {
  registry = new Registry();

  return createRebalancing({
    refills: repository,
    signer: createRefillSigner({ url: signerUrl, secret: Secret.from(secret), timeoutMs: 1_000 }),
    oneClick: client,
    readerFor: (asset: Asset) => asset.network.namespace === 'eip155' || asset.network.namespace === 'solana' ? reader : undefined,
    config,
    metrics: createRebalancingMetrics(registry),
    clock,
    ids: randomIdGenerator,
    logger,
    ...changes,
  });
};
const run = (changes: Partial<RebalancingOptions> = {}) => job(changes)();

const rowsOf = async (asset = 'solana-usdc') => (await database.db.select().from(refills)).filter(row => row.asset === asset);
const only = async (asset = 'solana-usdc'): Promise<Refill> => {
  const rows = await rowsOf(asset);
  expect(rows).toHaveLength(1);

  return (await repository.find(rows[0]!.id))!;
};
// The fake 1Click's status body for an address, to change in a script
const statusBody = async (depositAddress: string): Promise<Record<string, any>> =>
  await (await fetch(`${oneClick.url}/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`)).json() as Record<string, any>;
const transfers = async (reference: string) => createTreasuryRepository({ db: database.db }).findTransfer(reference);

describe('when rebalancing is off', () => {
  it('does nothing at all, not even with a refill due for a poll', async () => {
    await run();
    const refill = await only();
    clock.advance(hourMs);
    logs.length = 0;
    reads.length = 0;
    const requests = oneClick.requests.length;
    const off = { ...config, rebalancing: { ...config.rebalancing, enabled: false } };

    expect(await run({ config: off })).toMatchObject({ polled: 0, created: 0, askedAgain: 0, alerts: 0, errors: 0 });

    expect(asks).toHaveLength(1);
    expect(reads).toEqual([]);
    expect(oneClick.requests).toHaveLength(requests);
    expect(await only()).toEqual(refill);
    expect(logs).toEqual([]);
    expect(await registry.metrics()).not.toContain('rebalancing_refills_total{');
  });
});

describe('a new refill', () => {
  it('asks the Signer to bring a wallet under its floor up to its target, and keeps one in flight per asset across runs', async () => {
    const rebalancing = job();

    expect(await rebalancing()).toMatchObject({ created: 1, sent: 1, errors: 0 });

    // Solana at $1 under a $3 floor: $5 brings it to its $6 target. Base is above its floor.
    expect(reads).toEqual([`base-usdc ${baseWallet}`, `solana-usdc ${solanaWallet}`]);
    expect(asks).toHaveLength(1);
    const [ask] = asks;
    expect(ask!.headers['x-signer-secret']).toBe(secret);
    expect(ask!.headers['x-request-id']).toBe(ask!.body.refillId);
    expect(ask!.body).toEqual({ refillId: expect.stringMatching(/^ref_[0-9a-f-]{36}$/), asset: 'solana-usdc', amount: '5000000' });
    const quote = oneClick.quotes().at(-1)!;
    const refill = await only();
    expect(refill).toMatchObject({
      id: ask!.body.refillId, asset: 'solana-usdc', sourceAsset: 'near-usdc', amount: 5_000_000n, status: 'sent', depositAddress: quote.quote.depositAddress,
      amountIn: BigInt(quote.quote.amountIn), amountOut: 5_000_000n, quoteDeadline: new Date(Date.parse(noon) + 30 * minuteMs), correlationId: quote.correlationId,
      nearTransactionHash: expect.any(String), quote: JSON.parse(JSON.stringify(quote)), nextPollAt: new Date(Date.parse(noon) + 10_000), sentAt: new Date(noon),
    });
    expect(linesOf('A hot wallet is under its floor: the Signer is asked for a refill')).toEqual([expect.objectContaining({
      level: 30, refillId: refill.id, asset: 'solana-usdc', balance: '1', floor: '3', amount: '5',
    })]);
    expect(linesOf('The Signer sent a refill: 1Click\'s status is followed')).toEqual([expect.objectContaining({
      level: 30, refillId: refill.id, depositAddress: refill.depositAddress, transactionHash: refill.nearTransactionHash,
    })]);
    const metrics = await registry.metrics();
    expect(metrics).toContain('rebalancing_refills_total{asset="solana-usdc",status="requested"} 1');
    expect(metrics).toContain('rebalancing_refills_total{asset="solana-usdc",status="sent"} 1');

    // The next run: 1Click still waits for the deposit, and the wallet is still low. Nothing new is asked.
    clock.advance(10_000);
    reads.length = 0;

    expect(await rebalancing()).toMatchObject({ polled: 1, created: 0, sent: 0 });

    expect(asks).toHaveLength(1);
    expect(reads).toEqual([`base-usdc ${baseWallet}`]);
    expect(await only()).toMatchObject({ id: refill.id, status: 'sent', polls: 1, lastStatus: expect.objectContaining({ status: 'PENDING_DEPOSIT' }) });
  });

  it('asks nothing at or above the floor, nor for less than the least refill, and skips a wallet it can\'t read this run', async () => {
    balances.set('solana-usdc', 3_000_000n);
    expect(await run()).toMatchObject({ created: 0, unread: 0, errors: 0 });

    // $0.500001 to a target of $3.5 is under the least refill of $1
    const near = { ...config, rebalancing: { ...config.rebalancing, targets: config.rebalancing.targets.map(target => target.asset.name === 'solana-usdc' ? { ...target, target: 3_500_000n as typeof target.target } : target) } };
    balances.set('solana-usdc', 2_999_999n);
    expect(await run({ config: near })).toMatchObject({ created: 0 });
    expect(linesOf('A hot wallet is under its floor by less than the least refill: no refill')).toEqual([expect.objectContaining({
      level: 20, asset: 'solana-usdc', balance: '2.999999', amount: '0.500001', leastPerRefill: '1',
    })]);

    failing.add('solana-usdc');
    expect(await run()).toMatchObject({ created: 0, unread: 1, errors: 0 });
    expect(linesOf('Couldn\'t read a hot wallet\'s balance: its refill waits for the next run')).toEqual([expect.objectContaining({
      level: 40, asset: 'solana-usdc', network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1', error: expect.objectContaining({ message: 'The RPC didn\'t answer' }),
    })]);
    expect(asks).toEqual([]);
    expect(await database.db.select().from(refills)).toEqual([]);
  });
});

// A refill the Signer sent for the Solana wallet, its first poll due
const sentRefill = async (rebalancing = job()): Promise<Refill> => {
  await rebalancing();
  clock.advance(10_000);

  return only();
};

describe('following a refill through 1Click', () => {
  it('books a SUCCESS once: what left NEAR, less a part 1Click refunded, and what arrived', async () => {
    const refill = await sentRefill();
    oneClick.setStatus(refill.depositAddress!, 'SUCCESS', { refundedAmount: '400', refundFee: '0' });
    const delivery = (await statusBody(refill.depositAddress!))['swapDetails']['destinationChainTxHashes'][0]['hash'] as string;
    // It arrived: the wallet is above its floor
    balances.set('solana-usdc', 6_000_000n);
    const rebalancing = job();

    expect(await rebalancing()).toMatchObject({ polled: 1, succeeded: 1, created: 0, errors: 0 });

    const left = refill.amountIn! - 400n;
    const booked = await only();
    expect(booked).toMatchObject({
      status: 'succeeded', amountInUsd: left, amountOutUsd: 5_000_000n, refundedAmount: 400n, refundFee: 0n, deliveryTransactionHashes: [delivery],
      ledgerTransactionId: expect.any(String), nextPollAt: undefined, finishedAt: clock.now(), lastStatus: expect.objectContaining({ status: 'SUCCESS' }),
    });
    expect(await transfers(`refill:${refill.id}`)).toEqual({
      reference: `refill:${refill.id}`, fromAsset: 'near-usdc', fromAmount: left, toAsset: 'solana-usdc', toAmount: 5_000_000n,
      transactions: [refill.nearTransactionHash, delivery], recordedBy: 'rebalancing', ledgerTransactionId: booked.ledgerTransactionId, createdAt: clock.now(),
    });
    const treasury = ledgerAccountIds.treasury('solana-usdc');
    expect((await createLedger({ db: database.db, clock, ids: randomIdGenerator }).balancesOf([treasury])).get(treasury)).toBe(-5_000_000n);
    expect(linesOf('A refill arrived and was booked')).toEqual([expect.objectContaining({
      level: 30, refillId: refill.id, asset: 'solana-usdc', source: 'near-usdc', left: (Number(left) / 1e6).toString(), arrived: '5', refunded: '400',
      deliveryTransactions: [delivery],
    })]);
    const metrics = await registry.metrics();
    expect(metrics).toContain('rebalancing_refill_usd_total{asset="solana-usdc"} 5');
    expect(metrics).toContain('rebalancing_refills_total{asset="solana-usdc",status="succeeded"} 1');

    // Never again
    clock.advance(10 * minuteMs);
    expect(await rebalancing()).toMatchObject({ polled: 0, succeeded: 0, created: 0 });
    expect(await only()).toEqual(booked);
  });

  it('ends a REFUNDED refill without booking it, and asks for a new one on the same run', async () => {
    const refill = await sentRefill();
    oneClick.setStatus(refill.depositAddress!, 'REFUNDED', { refundFee: '1000' });

    expect(await run()).toMatchObject({ polled: 1, refunded: 1, created: 1, sent: 1 });

    expect(await repository.find(refill.id)).toMatchObject({
      status: 'refunded', refundedAmount: refill.amountIn, refundFee: 1_000n, refundReason: 'The swap could not complete before the deadline', ledgerTransactionId: undefined,
      nextPollAt: undefined, finishedAt: clock.now(),
    });
    expect(await transfers(`refill:${refill.id}`)).toBeUndefined();
    expect(linesOf('A refill was refunded to the NEAR hot wallet: nothing was booked')).toEqual([expect.objectContaining({
      level: 30, refillId: refill.id, refunded: refill.amountIn!.toString(), refundFee: '1000',
    })]);
    expect((await rowsOf()).map(row => row.status).sort()).toEqual(['refunded', 'sent']);
    expect(asks).toHaveLength(2);
  });

  it('flags a FAILED refill for review with an alert, makes no new refill of its asset, and alerts again each hour while it lasts', async () => {
    const rebalancing = job();
    const refill = await sentRefill(rebalancing);
    oneClick.setStatus(refill.depositAddress!, 'FAILED');

    expect(await rebalancing()).toMatchObject({ polled: 1, review: 1, created: 0, alerts: 0 });

    expect(await only()).toMatchObject({ status: 'review', reason: 'oneclick_failed', nextPollAt: undefined, lastStatus: expect.objectContaining({ status: 'FAILED' }) });
    expect(linesOf('A refill needs review: money may have moved')).toEqual([expect.objectContaining({
      level: 50, alert: true, refillId: refill.id, asset: 'solana-usdc', depositAddress: refill.depositAddress, transactionHash: refill.nearTransactionHash,
      reason: 'oneclick_failed',
    })]);

    clock.advance(30 * minuteMs);
    expect(await rebalancing()).toMatchObject({ created: 0, alerts: 0 });
    // An hour after the review, and after the first run saw the wallet under its floor: both alert
    clock.advance(31 * minuteMs);
    expect(await rebalancing()).toMatchObject({ created: 0, alerts: 2 });
    clock.advance(30 * minuteMs);
    expect(await rebalancing()).toMatchObject({ created: 0, alerts: 0 });

    expect(asks).toHaveLength(1);
    expect(linesOf('A refill still needs review: no new refill of its asset until an operator changes its status')).toEqual([expect.objectContaining({
      level: 50, alert: true, refillId: refill.id, asset: 'solana-usdc', depositAddress: refill.depositAddress, transactionHash: refill.nearTransactionHash,
      reason: 'oneclick_failed',
    })]);
    expect(await registry.metrics()).toContain('rebalancing_refills_total{asset="solana-usdc",status="review"} 1');
  });

  it('polls a swap under way again with the top-up job\'s backoff, and flags a deposit still pending 72 hours past the quote\'s deadline', async () => {
    const refill = await sentRefill();
    const deadline = refill.quoteDeadline!.getTime();
    const nextPoll = async () => (await only()).nextPollAt!.getTime() - clock.now().getTime();

    // In the first hour after it was sent: every 10 s
    for (const status of ['KNOWN_DEPOSIT_TX', 'INCOMPLETE_DEPOSIT', 'PROCESSING'] as const) {
      oneClick.setStatus(refill.depositAddress!, status);
      expect(await run()).toMatchObject({ polled: 1, review: 0, errors: 0 });
      expect(await only()).toMatchObject({ status: 'sent', lastStatus: expect.objectContaining({ status }) });
      expect(await nextPoll()).toBe(10_000);
      clock.advance(10_000);
    }
    // Then every 5 minutes: the deadline, 30 minutes after it was sent, has passed
    expect(deadline).toBe(Date.parse(noon) + 30 * minuteMs);
    oneClick.setStatus(refill.depositAddress!, 'PENDING_DEPOSIT');
    clock.set(new Date(Date.parse(noon) + 2 * hourMs));
    await run();
    expect(await nextPoll()).toBe(5 * minuteMs);
    clock.set(new Date(deadline + pendingAfterDeadlineMs - 5 * minuteMs));
    expect(await run()).toMatchObject({ polled: 1, review: 0 });

    clock.set(new Date(deadline + pendingAfterDeadlineMs));
    expect(await run()).toMatchObject({ polled: 1, review: 1 });

    expect(await only()).toMatchObject({ status: 'review', reason: 'pending_after_deadline' });
    expect(linesOf('A refill needs review: money may have moved')).toEqual([expect.objectContaining({
      alert: true, refillId: refill.id, reason: 'pending_after_deadline', quoteDeadline: refill.quoteDeadline!.toISOString(),
    })]);
  });

  it('polls an unknown refill whose address 1Click doesn\'t know until the quote\'s deadline, then flags it for review', async () => {
    const quoteDeadline = new Date(Date.parse(noon) + 30 * minuteMs).toISOString();
    answerWith = () => refusal(502, 'refill_unknown', {
      outcome: 'unknown', depositAddress: randomBytes(32).toString('hex'), amountIn: '5000501', amountOut: '5000000', quoteDeadline, correlationId: randomUUID(),
      transactionHash: encodeBase58(randomBytes(32)),
    });
    const refill = await sentRefill();
    expect(refill).toMatchObject({ status: 'unknown', quote: undefined, quoteDeadline: new Date(quoteDeadline) });
    expect(linesOf('A refill\'s transaction may have landed: 1Click\'s status is followed')).toHaveLength(1);

    expect(await run()).toMatchObject({ polled: 1, review: 0, errors: 0 });
    expect(await only()).toMatchObject({ status: 'unknown', polls: 1 });
    expect(linesOf('1Click doesn\'t know a refill\'s deposit address yet: it is polled again')).toHaveLength(1);

    clock.set(quoteDeadline);
    expect(await run()).toMatchObject({ polled: 1, review: 1 });
    expect(await only()).toMatchObject({ status: 'review', reason: 'oneclick_not_found' });
    expect(linesOf('A refill needs review: money may have moved')).toEqual([expect.objectContaining({ alert: true, refillId: refill.id, reason: 'oneclick_not_found' })]);
  });

  it('leaves a refill as it was when 1Click doesn\'t answer, and polls it again later', async () => {
    const refill = await sentRefill();
    oneClick.handle('/v0/status', () => ({ status: 503, body: { message: 'Service Unavailable' } }));

    expect(await run()).toMatchObject({ polled: 1, unavailable: 1, review: 0, errors: 0 });

    expect(await only()).toMatchObject({ status: 'sent', lastStatus: undefined, polls: 1, nextPollAt: new Date(clock.now().getTime() + 10_000) });
    expect(linesOf('1Click didn\'t answer for some refills: they are polled again at their next time')).toEqual([expect.objectContaining({
      level: 40, unavailable: 1, reason: 'server_error', status: 503,
    })]);
    expect(refill.status).toBe('sent');
  });
});

describe('the Signer\'s answer', () => {
  const unknownAnswer = (): SignerAnswer => refusal(502, 'refill_unknown', {
    outcome: 'unknown', depositAddress: randomBytes(32).toString('hex'), amountIn: '5000501', amountOut: '5000000',
    quoteDeadline: new Date(Date.parse(noon) + 30 * minuteMs).toISOString(), correlationId: randomUUID(), transactionHash: encodeBase58(randomBytes(32)),
  });
  const cases: readonly { readonly name: string; readonly answer: (ask: SignerAsk) => Promise<SignerAnswer> | SignerAnswer; readonly row: Record<string, unknown> }[] = [
    { name: '200', answer: sent, row: { status: 'sent', reason: undefined } },
    { name: '502 refill_unknown', answer: unknownAnswer, row: { status: 'unknown', reason: undefined } },
    { name: '502 refill_failed', answer: () => refusal(502, 'refill_failed', { transactionHash: 'near-tx-failed' }), row: { status: 'failed', reason: 'refill_failed', nearTransactionHash: 'near-tx-failed' } },
    { name: '409 refill_in_progress', answer: () => refusal(409, 'refill_in_progress'), row: { status: 'requested', reason: undefined } },
    { name: '409 payer_busy', answer: () => refusal(409, 'payer_busy'), row: { status: 'not_sent', reason: 'payer_busy' } },
    { name: '422 daily_limit', answer: () => refusal(422, 'signing_refused', { reason: 'daily_limit' }), row: { status: 'not_sent', reason: 'signing_refused:daily_limit' } },
    { name: '422 source_low', answer: () => refusal(422, 'signing_refused', { reason: 'source_low' }), row: { status: 'not_sent', reason: 'signing_refused:source_low' } },
    { name: '502 signing_failed', answer: () => refusal(502, 'signing_failed'), row: { status: 'not_sent', reason: 'signing_failed' } },
    { name: '503 refills_off', answer: () => refusal(503, 'refills_off'), row: { status: 'not_sent', reason: 'refills_off' } },
    { name: '503 oneclick_unavailable', answer: () => refusal(503, 'oneclick_unavailable'), row: { status: 'not_sent', reason: 'oneclick_unavailable' } },
    { name: '503 redis_not_ready', answer: () => refusal(503, 'redis_not_ready'), row: { status: 'not_sent', reason: 'redis_not_ready' } },
    { name: 'a cut connection', answer: () => ({ status: 0, destroy: true }), row: { status: 'requested', reason: undefined } },
    { name: 'a timeout', answer: async ask => ({ ...await sent(ask), delayMs: 1_500 }), row: { status: 'requested', reason: undefined } },
    { name: '500 internal_error', answer: () => refusal(500, 'internal_error'), row: { status: 'requested', reason: undefined } },
  ];

  it.each(cases)('keeps $name as the refill\'s status', async ({ answer, row }) => {
    answerWith = answer;

    expect(await run()).toMatchObject({ created: 1, errors: 0 });

    expect(asks).toHaveLength(1);
    expect(await only()).toMatchObject({ id: asks[0]!.body.refillId, ...row });
    expect(await registry.metrics()).toContain(`rebalancing_refills_total{asset="solana-usdc",status="${row['status'] as string}"} 1`);
  });

  it('alerts an operator to move USDC to the NEAR hot wallet on 422 source_low', async () => {
    answerWith = () => refusal(422, 'signing_refused', { reason: 'source_low' });

    await run();

    expect(linesOf('The Signer refused a refill: the NEAR hot wallet holds too little, move USDC to it from the NEAR treasury')).toEqual([expect.objectContaining({
      level: 40, alert: true, refillId: asks[0]!.body.refillId, asset: 'solana-usdc', status: 422, code: 'signing_refused', reason: 'source_low',
    })]);
  });

  it('asks again with the same ID for a refill whose answer never arrived, and keeps the answer the Signer stored', async () => {
    // The Signer sent, and its answer came after the workers stopped waiting
    let stored: SignerAnswer | undefined;
    answerWith = async ask => {
      stored ??= await sent(ask);

      return asks.length === 1 ? { ...stored, delayMs: 1_500 } : stored;
    };

    expect(await run()).toMatchObject({ created: 1, noAnswer: 1, sent: 0 });
    expect(await only()).toMatchObject({ status: 'requested' });
    expect(linesOf('The Signer\'s answer to a refill never arrived: it is asked again next run, with the same ID')).toEqual([expect.objectContaining({
      level: 40, refillId: asks[0]!.body.refillId, code: 'timeout',
    })]);

    clock.advance(5 * minuteMs);
    expect(await run()).toMatchObject({ askedAgain: 1, created: 0, sent: 1 });

    expect(asks.map(ask => ask.body)).toEqual([asks[0]!.body, asks[0]!.body]);
    expect(await only()).toMatchObject({ id: asks[0]!.body.refillId, status: 'sent', depositAddress: (stored!.body as Record<string, unknown>)['depositAddress'] });
  });
});

describe('the alerts', () => {
  it('alerts once an hour on a wallet still under its floor an hour after the first run saw it', async () => {
    // The Signer is busy each time: nothing moves, and the wallet stays under
    answerWith = () => refusal(409, 'payer_busy');
    const rebalancing = job();
    const at = async (minutes: number) => {
      clock.set(new Date(Date.parse(noon) + minutes * minuteMs));

      return (await rebalancing()).alerts;
    };

    expect(await at(0)).toBe(0);
    expect(await at(30)).toBe(0);
    expect(await at(underFloorAlertMs / minuteMs)).toBe(1);
    expect(await at(90)).toBe(0);
    expect(await at(60 + alertRepeatMs / minuteMs)).toBe(1);
    // Back above the floor, then under again: the hour starts again
    balances.set('solana-usdc', 4_000_000n);
    expect(await at(125)).toBe(0);
    balances.set('solana-usdc', 1_000_000n);
    expect(await at(130)).toBe(0);
    expect(await at(185)).toBe(0);
    expect(await at(190)).toBe(1);

    expect(linesOf('A hot wallet has been under its floor for over an hour')).toEqual([
      expect.objectContaining({ level: 50, alert: true, asset: 'solana-usdc', balance: '1', floor: '3', since: noon }),
      expect.objectContaining({ alert: true, asset: 'solana-usdc', since: noon }),
      expect.objectContaining({ alert: true, asset: 'solana-usdc', since: new Date(Date.parse(noon) + 130 * minuteMs).toISOString() }),
    ]);
  });

  it('alerts once an hour on a refill requested for over 10 minutes, with its ID, asking the Signer again each run', async () => {
    answerWith = () => ({ status: 0, destroy: true });
    const rebalancing = job();
    const at = async (minutes: number) => {
      clock.set(new Date(Date.parse(noon) + minutes * minuteMs));

      return (await rebalancing()).alerts;
    };

    expect(await at(0)).toBe(0);
    expect(await at(5)).toBe(0);
    expect(await at(stuckRequestedMs / minuteMs)).toBe(1);
    expect(await at(40)).toBe(0);
    // The refill again, and the wallet under its floor for an hour
    expect(await at(70)).toBe(2);

    const refill = await only();
    expect(refill.status).toBe('requested');
    expect(new Set(asks.map(ask => ask.body.refillId))).toEqual(new Set([refill.id]));
    expect(asks).toHaveLength(5);
    expect(linesOf('A refill has waited over 10 minutes for the Signer\'s answer: it is asked again each run')).toEqual([
      expect.objectContaining({ level: 50, alert: true, refillId: refill.id, asset: 'solana-usdc', amount: '5', depositAddress: null, transactionHash: null, createdAt: noon }),
      expect.objectContaining({ alert: true, refillId: refill.id }),
    ]);
    expect(linesOf('A hot wallet has been under its floor for over an hour')).toEqual([expect.objectContaining({ asset: 'solana-usdc', since: noon })]);
  });

  it('fails the run when a refill can\'t be acted on, and acts on the others', async () => {
    answerWith = () => refusal(409, 'payer_busy');
    const broken = { ...repository, recordAnswer: async () => { throw new Error('The database is gone'); } };

    const error = await job({ refills: broken })().catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(RebalancingFailedError);
    expect((error as RebalancingFailedError).result).toMatchObject({ created: 1, errors: 1 });
    expect(linesOf('Failed to act on a refill')).toEqual([expect.objectContaining({ level: 50, asset: 'solana-usdc', step: 'decide' })]);
  });

  it('flags a refill whose sent answer can\'t be kept for review, with an alert naming its deposit address and transaction', async () => {
    const broken = { ...repository, recordAnswer: async () => { throw new Error('The database is gone'); } };

    expect(await job({ refills: broken })()).toMatchObject({ created: 1, review: 1, errors: 0 });

    const refill = await only();
    expect(refill).toMatchObject({ status: 'review', reason: 'answer_not_kept' });
    expect(linesOf('The Signer sent a refill, but its answer couldn\'t be kept: follow its deposit address by hand')).toEqual([expect.objectContaining({
      level: 50, alert: true, refillId: refill.id, answer: 'sent', depositAddress: oneClick.quotes().at(-1)!.quote.depositAddress, transactionHash: expect.any(String),
      error: expect.objectContaining({ message: 'The database is gone' }),
    })]);
  });

  it('alerts on a sent answer for a refill whose row changed meanwhile', async () => {
    const changed = { ...repository, recordAnswer: async () => undefined };

    expect(await job({ refills: changed })()).toMatchObject({ created: 1, sent: 0, errors: 0 });

    expect(linesOf('The Signer sent a refill, but its answer couldn\'t be kept: follow its deposit address by hand')).toEqual([expect.objectContaining({
      alert: true, refillId: asks[0]!.body.refillId, depositAddress: oneClick.quotes().at(-1)!.quote.depositAddress,
    })]);
  });

  it('alerts once an hour on a refill not finished an hour after it was sent', async () => {
    const rebalancing = job();
    const refill = await sentRefill(rebalancing);
    oneClick.setStatus(refill.depositAddress!, 'PROCESSING');
    const at = async (minutes: number) => {
      clock.set(new Date(Date.parse(noon) + minutes * minuteMs));
      await rebalancing();

      return linesOf('A refill hasn\'t finished an hour after it was sent').length;
    };

    expect(await at(59)).toBe(0);
    expect(await at(unfinishedAlertMs / minuteMs)).toBe(1);
    expect(await at(90)).toBe(1);
    expect(await at(120)).toBe(2);
    expect(linesOf('A refill hasn\'t finished an hour after it was sent')[0]).toMatchObject({
      level: 50, alert: true, refillId: refill.id, status: 'sent', depositAddress: refill.depositAddress, transactionHash: refill.nearTransactionHash,
      sentAt: noon, lastStatus: 'PROCESSING',
    });
  });
});

describe('a refill asked again', () => {
  it.each(['refills_off', 'redis_not_ready'])('stays requested when the Signer answers 503 %s before it reads the ID\'s record, and is followed once it answers', async code => {
    // The first ask sent, and its answer was lost; the second is refused before the record is read; the third gets it
    let stored: SignerAnswer | undefined;
    answerWith = async ask => {
      stored ??= await sent(ask);

      return asks.length === 1 ? { ...stored, delayMs: 1_500 } : asks.length === 2 ? refusal(503, code) : stored;
    };
    const rebalancing = job();

    expect(await rebalancing()).toMatchObject({ created: 1, noAnswer: 1 });
    clock.advance(5 * minuteMs);
    expect(await rebalancing()).toMatchObject({ askedAgain: 1, notSent: 0, noAnswer: 1 });
    expect(await only()).toMatchObject({ status: 'requested' });
    expect(linesOf('The Signer refused a refill asked again before it read the ID\'s record: it may have sent at the first ask, so it is asked again next run'))
      .toEqual([expect.objectContaining({ level: 40, refillId: asks[0]!.body.refillId, status: 503, code })]);
    clock.advance(5 * minuteMs);
    expect(await rebalancing()).toMatchObject({ askedAgain: 1, sent: 1, created: 0 });

    expect(await only()).toMatchObject({ status: 'sent', depositAddress: (stored!.body as Record<string, unknown>)['depositAddress'] });
    expect(new Set(asks.map(ask => ask.body.refillId)).size).toBe(1);
    expect(await registry.metrics()).not.toContain('status="not_sent"');
  });

  it('goes to review after 24 hours requested, without asking the Signer again: past its memory of the ID, a re-ask could send twice', async () => {
    answerWith = () => ({ status: 0, destroy: true });
    const rebalancing = job();
    await rebalancing();
    clock.set(new Date(Date.parse(noon) + requestedLimitMs - minuteMs));
    expect(await rebalancing()).toMatchObject({ askedAgain: 1, review: 0 });

    clock.set(new Date(Date.parse(noon) + requestedLimitMs));
    expect(await rebalancing()).toMatchObject({ askedAgain: 0, review: 1, created: 0 });

    expect(asks).toHaveLength(2);
    const refill = await only();
    expect(refill).toMatchObject({ status: 'review', reason: 'requested_too_long' });
    expect(linesOf('A refill needs review: money may have moved')).toEqual([expect.objectContaining({
      alert: true, refillId: refill.id, reason: 'requested_too_long', createdAt: noon,
    })]);
  });
});

describe('the pauses', () => {
  it('makes no new refill of an asset booked on the same run, though a lagging read still shows it low', async () => {
    const refill = await sentRefill();
    oneClick.setStatus(refill.depositAddress!, 'SUCCESS');

    expect(await run()).toMatchObject({ succeeded: 1, created: 0 });

    expect(asks).toHaveLength(1);
    expect(await rowsOf()).toHaveLength(1);
  });

  it.each(['source_low', 'daily_limit'])('asks nothing for an hour after the Signer refused for %s, across restarts, so a refusal repeats at most hourly', async reason => {
    answerWith = () => refusal(422, 'signing_refused', { reason });

    // A new process each run: the pause is read from the last row
    await run();
    clock.advance(refusalPauseMs - minuteMs);
    expect(await run()).toMatchObject({ created: 0 });
    expect(asks).toHaveLength(1);
    clock.advance(minuteMs);
    expect(await run()).toMatchObject({ created: 1, notSent: 1 });

    expect(asks).toHaveLength(2);
    if (reason === 'source_low')
      expect(linesOf('The Signer refused a refill: the NEAR hot wallet holds too little, move USDC to it from the NEAR treasury')).toHaveLength(2);
  });

  it('flags a REFUNDED answer for another deposit address for review, and ends nothing', async () => {
    const refill = await sentRefill();
    oneClick.setStatus(refill.depositAddress!, 'REFUNDED');
    const body = await statusBody(refill.depositAddress!);
    oneClick.handle('/v0/status', () => ({ status: 200, body: { ...body, quoteResponse: { ...body['quoteResponse'], quote: { ...body['quoteResponse']['quote'], depositAddress: 'f'.repeat(64) } } } }));

    expect(await run()).toMatchObject({ polled: 1, refunded: 0, review: 1 });

    expect(await only()).toMatchObject({ status: 'review', reason: 'deposit_address_mismatch', refundedAmount: undefined });
    expect(linesOf('A refill needs review: money may have moved')).toEqual([expect.objectContaining({
      alert: true, refillId: refill.id, reason: 'deposit_address_mismatch', oneClickStatus: 'REFUNDED', received: 'f'.repeat(64),
    })]);
  });

  it.each([
    { name: 'more than the quote\'s amountOut', details: { amountOut: '5000001' }, reason: 'amount_out_above_quote' },
    // Fifty digits: 1Click's client takes it, and it reads as 400 only when the zeros are dropped
    { name: 'a refund it can\'t read', details: { refundedAmount: `${'0'.repeat(47)}400` }, reason: 'unreadable_refund' },
  ])('flags a SUCCESS with $name for review, with an alert, and books nothing', async ({ details, reason }) => {
    const refill = await sentRefill();
    oneClick.setStatus(refill.depositAddress!, 'SUCCESS', details);
    balances.set('solana-usdc', 6_000_000n);

    expect(await run()).toMatchObject({ polled: 1, succeeded: 0, review: 1 });

    expect(await only()).toMatchObject({ status: 'review', reason, ledgerTransactionId: undefined });
    expect(await transfers(`refill:${refill.id}`)).toBeUndefined();
    expect(linesOf('A refill needs review: money may have moved')).toEqual([expect.objectContaining({ alert: true, refillId: refill.id, reason })]);
  });
});
