import { Registry } from '@prometheus-io/client';

import { createApp as createApi, type ApiServer } from '@anyfare/api';
import { createLogger, Secret } from '@anyfare/common';
import { createPaidWith, hashApiKey, type PaymentStatus, type PlatformConfig } from '@anyfare/core';
import {
  callDetails, createAccountRepository, createLedger, createPaymentKeyRepository, createStatsCounter, createStatsRepository, createTopupRepository, payments,
  type Database, type Postgres,
} from '@anyfare/db';
import { createFakeIdGenerator, fixtureTime, type FakeClock, type TestRedis } from '@anyfare/testing';

import { createAllStats, createPublicStatsMetrics, createRecentStats, type PublicStatsOptions } from '../../src/publicStats.js';

// Seeding calls and top-ups as the proxy, the rails and the top-up job leave them, running the public
// numbers' two counts, and reading their answers through the API, for the public numbers' tests.

export const ways = {
  credits: { rail: 'credits', network: null },
  base: { rail: 'x402', network: 'eip155:84532' },
  near: { rail: 'x402', network: 'near:testnet' },
  solana: { rail: 'x402', network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1' },
  tempo: { rail: 'mpp', network: 'eip155:42431' },
  // A network this deployment doesn't run: named by its ID
  mainnet: { rail: 'x402', network: 'eip155:8453' },
} as const;

export interface SeededCall {
  readonly at: string;
  readonly host: string;
  readonly path: string;
  readonly way: keyof typeof ways;
  readonly status: PaymentStatus;
  readonly amount?: bigint;
  // The API's time. Undefined: the API never answered.
  readonly ms?: number;
  // A Credits buyer's account, whose key is `key_<account>`
  readonly account?: string;
  // A chain payer's address
  readonly payer?: string;
  // Undefined: no details, as for a call recorded before they were kept
  readonly method?: string;
  // Columns no answer may show
  readonly requestId?: string;
  readonly receipt?: string;
  readonly settlementRequest?: Record<string, string>;
}

let counter = 0;

/** A call as the proxy and the rails leave it: its payment, and its details when they were kept. */
export const seedCall = async (db: Database, call: SeededCall): Promise<string> => {
  counter += 1;
  const id = `pay_stats_${counter}`;
  const at = new Date(call.at);
  const way = ways[call.way];
  await db.insert(payments).values({
    id, requestId: call.requestId ?? `req-${id}`, rail: way.rail, buyerAccountId: call.account ?? null, keyId: call.account === undefined ? null : `key_${call.account}`,
    targetHost: call.host, targetPath: call.path, network: way.network, asset: way.network === null ? null : 'base-usdc',
    atomicAmount: way.network === null ? null : call.amount ?? 10_000n, amount: call.amount ?? 10_000n, fee: null,
    upstreamStatus: call.ms === undefined ? null : 200, upstreamLatencyMs: call.ms ?? null, status: call.status, transactionHash: null, receipt: call.receipt ?? null,
    settlementRequest: call.settlementRequest ?? null, needsReview: false, createdAt: at, updatedAt: new Date(at.getTime() + 500),
  });
  if (call.method !== undefined)
    await db.insert(callDetails).values({ paymentId: id, method: call.method, payer: call.payer ?? null, arrivedAt: new Date(at.getTime() - 10) });

  return id;
};

/** A Credits buyer: its account and its payment key `key_<account>`. */
export const seedBuyer = async (db: Database, account: string, at: Date): Promise<void> => {
  await createAccountRepository({ db }).create({ id: account, createdAt: at });
  await createPaymentKeyRepository({ db }).insert({
    id: `key_${account}`, accountId: account, keyHash: hashApiKey(Secret.from(`af_test_${account}`)), label: undefined, createdAt: at,
    allowance: undefined, dailyBudget: 5_000_000n, maxPrice: undefined, expiresAt: undefined,
  });
};

/** A top-up of `account` through its life: quoted, then credited at `credited` with the ledger's top-up, or refunded, or still waiting. */
export const seedTopup = async (db: Database, clock: FakeClock, input: {
  readonly account: string;
  readonly network: string;
  readonly token: string;
  readonly credits: bigint;
  readonly end: { readonly credited: string } | 'refunded' | 'waiting';
}): Promise<void> => {
  counter += 1;
  const id = `top_stats_${counter}`;
  const depositAddress = `deposit-${counter}`;
  clock.set(fixtureTime(0, 12, 8, 0, 0, 0));
  const repository = createTopupRepository({ db, clock });
  await repository.create({
    id, accountId: input.account, requestId: undefined, network: input.network, blockchain: input.network, tokenSymbol: input.token, originAsset: `asset-${input.token}`,
    tokenDecimals: 6, amount: input.credits, destinationAsset: 'near-usdc', recipient: 'treasury.anyfare.testnet', refundTo: 'treasury.anyfare.testnet',
    payBy: new Date(fixtureTime(0, 13)), quoteRequest: {},
  });
  await repository.markQuoted(id, {
    quoteResponse: {}, correlationId: `corr-${counter}`, depositAddress, depositMemo: undefined, addressExpiresAt: new Date(fixtureTime(0, 13)),
    sendAmount: input.credits, sendAtLeast: input.credits, estimatedCredits: input.credits, nextPollAt: new Date(fixtureTime(0, 12, 8, 1, 0, 0)),
  });
  const poll = { oneClickStatus: 'SUCCESS', lastStatus: {}, polledAt: clock.now() };
  if (input.end === 'refunded') {
    await repository.markRefunded(id, 'waiting', { poll, refundedAmount: input.credits, refundReason: 'expired', refundTxHash: undefined });
    return;
  }
  if (input.end === 'waiting')
    return;
  clock.set(input.end.credited);
  const credited = await repository.markCredited({
    id, from: 'waiting', credit: { poll, creditedAmount: input.credits, deliveryTxHash: undefined, refundedAmount: undefined },
    book: tx => createLedger({ db: tx, clock, ids: createFakeIdGenerator(`ledger-${counter}-`) })
      .topUp({ accountId: input.account, asset: 'near-usdc', amount: input.credits, reference: depositAddress }),
  });
  if (credited?.status !== 'credited')
    throw new Error('The seeded top-up wasn\'t credited');
};

/** The two counts on this database. */
export const statsJobs = (db: Database, config: PlatformConfig, clock: FakeClock, changes: Partial<PublicStatsOptions> = {}) => {
  const options: PublicStatsOptions = {
    counter: createStatsCounter({ db, ways: createPaidWith(config).ways }),
    store: createStatsRepository({ db }),
    config,
    metrics: createPublicStatsMetrics(new Registry(), clock),
    clock,
    ...changes,
  };

  return { recent: createRecentStats(options), all: createAllStats(options), options };
};

const generous = { requests: 1_000_000, windowSeconds: 60 };

/** The API on this database, read without listening. */
export const statsApi = (postgres: Postgres, redis: TestRedis, config: PlatformConfig, clock: FakeClock): {
  readonly server: ApiServer;
  get<TBody = Record<string, unknown>>(path: string): Promise<{ readonly status: number; readonly text: string; readonly body: TBody }>;
} => {
  const server = createApi({
    config: { ...config, rateLimits: { ...config.rateLimits, publicReads: generous } }, logger: createLogger({ level: 'silent' }), postgres, redis, clock,
  });

  return {
    server,
    get: async <TBody>(path: string) => {
      const response = await server.app.inject({ method: 'GET', url: path });

      return { status: response.statusCode, text: response.body, body: JSON.parse(response.body) as TBody };
    },
  };
};
