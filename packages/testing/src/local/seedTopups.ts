import type { IdGenerator, MicroUsd } from '@anyfare/common';
import type { Asset, JsonObject, PlatformConfig, TopupStatus } from '@anyfare/core';
import { createLedger, createTopupRepository, type Database } from '@anyfare/db';
import { buildQuoteRequest } from '@anyfare/topups';

import type { FakeClock } from '../clock.js';
import { defaultOneClickTokens, type FakeOneClickToken } from '../oneClick.js';
import { encodeBase58 } from '../solanaRpc.js';
import type { SeededRandom } from './random.js';
import { seedRequestPrefix, seedTopupPrefix, type ChainName } from './seedData.js';

// Top-ups the way the API and the workers write them: a quote, a deposit address, polls of 1Click, and
// for the ones that arrived, Credits booked in the ledger.

export interface TopupAccount {
  readonly id: string;
}

export interface TopupSpec {
  readonly account: TopupAccount;
  readonly blockchain: string;
  readonly symbol: string;
  readonly usd: number;
  readonly status: TopupStatus;
  // When the client asked
  readonly at: Date;
}

export interface TopupSeeding {
  readonly db: Database;
  readonly config: PlatformConfig;
  readonly clock: FakeClock;
  readonly ids: IdGenerator;
  readonly random: SeededRandom;
  readonly now: Date;
  // The request ID of the next top-up
  readonly requestId: () => string;
  readonly hash: (chain: ChainName, index: number) => string;
}

const minuteMs = 60_000;

const settingsOf = (config: PlatformConfig) => {
  const asset: Asset = config.topups.asset ?? config.assets.find(candidate => candidate.network.chain === 'near')!;

  return {
    asset,
    recipient: config.topups.recipient ?? 'treasury.anyfare.testnet',
    refundTo: config.topups.refundTo ?? 'treasury.anyfare.testnet',
    slippageBps: config.topups.slippageBps,
    deadlineMinutes: config.topups.deadlineMinutes,
    stablecoins: config.topups.stablecoins,
  };
};

const findToken = (blockchain: string, symbol: string): FakeOneClickToken => {
  const token = defaultOneClickTokens.find(candidate => candidate.blockchain === blockchain && candidate.symbol === symbol);
  if (!token)
    throw new Error(`The seed has no token ${symbol} on ${blockchain}`);

  return token;
};

/** What a top-up of this many dollars credits: 1Click keeps a basis point or two. */
export const creditedFor = (usd: number): MicroUsd => BigInt(Math.floor(usd * 1_000_000 * 0.9998)) as MicroUsd;

const depositAddressOf = (blockchain: string, random: SeededRandom): string => {
  if (blockchain === 'sol')
    return encodeBase58(random.bytes(32));
  if (blockchain === 'near')
    return random.hex(64);
  if (blockchain === 'btc')
    return `bc1q${random.hex(38)}`;

  return `0x${random.hex(40)}`;
};

const originHashOf = (blockchain: string, random: SeededRandom): string => {
  if (blockchain === 'sol')
    return encodeBase58(random.bytes(64));
  if (blockchain === 'near')
    return encodeBase58(random.bytes(32));
  if (blockchain === 'btc')
    return random.hex(64);

  return `0x${random.hex(64)}`;
};

const uuidOf = (random: SeededRandom): string => {
  const hex = random.hex(32);

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/**
 * Makes one top-up and takes it to its status through the repository's own transitions, with the clock
 * moving as the real flow's times do. Returns the Credits it booked, in micro-USD: 0 for any other status.
 */
export const seedTopup = async (seeding: TopupSeeding, spec: TopupSpec): Promise<MicroUsd> => {
  const { db, config, clock, ids, random, requestId } = seeding;
  const repository = createTopupRepository({ db, clock });
  const settings = settingsOf(config);
  const token = findToken(spec.blockchain, spec.symbol);
  const network = config.topups.networks.find(candidate => candidate.blockchain === spec.blockchain)?.name ?? spec.blockchain;
  const amount = BigInt(Math.round(spec.usd / token.price * 10 ** token.decimals));
  const minimum = amount * 99n / 100n;
  const credits = creditedFor(spec.usd);
  const address = depositAddressOf(spec.blockchain, random);
  const iso = (time: Date): string => time.toISOString();

  clock.set(spec.at);
  const request = buildQuoteRequest({ topups: settings, token, amount, now: spec.at, dry: false });
  const created = await repository.create({
    id: `${seedTopupPrefix}${ids.next().slice(5)}`,
    accountId: spec.account.id,
    requestId: requestId(),
    network,
    blockchain: spec.blockchain,
    tokenSymbol: spec.symbol,
    originAsset: token.assetId,
    tokenDecimals: token.decimals,
    amount,
    destinationAsset: settings.asset.name,
    recipient: request.recipient,
    refundTo: request.refundTo,
    payBy: new Date(request.deadline),
    quoteRequest: JSON.parse(JSON.stringify(request)) as JsonObject,
  });
  const { id } = created;

  if (spec.status === 'quoting')
    return 0n as MicroUsd;
  clock.advance(900);
  if (spec.status === 'quote_failed') {
    await repository.markQuoteFailed(id, { error: 'Amount is too low for the bridge to carry it' });

    return 0n as MicroUsd;
  }
  if (spec.status === 'quote_unknown') {
    await repository.markQuoteUnknown(id, 'timeout');

    return 0n as MicroUsd;
  }

  const correlationId = uuidOf(random);
  const deadline = new Date(request.deadline);
  const quote = {
    amountIn: amount.toString(),
    minAmountIn: minimum.toString(),
    amountOut: credits.toString(),
    minAmountOut: (credits * 99n / 100n).toString(),
    amountInUsd: spec.usd.toFixed(4),
    amountOutUsd: (Number(credits) / 1_000_000).toFixed(4),
    timeEstimate: 90,
    depositAddress: address,
    deadline: iso(deadline),
    timeWhenInactive: iso(deadline),
  };
  const pollEvery = 10 * minuteMs;
  const firstPoll = new Date(spec.at.getTime() + 15_000);
  // An open top-up's next poll is far off, so the workers leave it alone until its address expires
  const farPoll = new Date(seeding.now.getTime() + 10 * 24 * 60 * minuteMs);
  await repository.markQuoted(id, {
    quoteResponse: { correlationId, timestamp: iso(spec.at), signature: `ed25519:${random.hex(64)}`, quoteRequest: JSON.parse(JSON.stringify(request)) as JsonObject, quote } as JsonObject,
    correlationId,
    depositAddress: address,
    depositMemo: undefined,
    addressExpiresAt: deadline,
    sendAmount: amount,
    sendAtLeast: minimum,
    estimatedCredits: credits,
    nextPollAt: spec.status === 'waiting' ? farPoll : firstPoll,
  });
  if (spec.status === 'waiting')
    return 0n as MicroUsd;

  const originHash = originHashOf(spec.blockchain, random);
  const poll = (status: string, at: Date, details: Record<string, unknown> = {}, deposited: bigint | undefined = amount) => ({
    oneClickStatus: status,
    lastStatus: { correlationId, status, updatedAt: iso(at), swapDetails: { depositedAmount: deposited?.toString() ?? null, ...details } } as JsonObject,
    polledAt: at,
    depositedAmount: deposited,
    originTxHashes: [originHash],
  });

  if (spec.status === 'expired') {
    clock.set(new Date(deadline.getTime() + minuteMs));
    await repository.markExpired(id, 'waiting', { ...poll('PENDING_DEPOSIT', clock.now(), {}, undefined), originTxHashes: undefined });

    return 0n as MicroUsd;
  }
  if (spec.status === 'incomplete') {
    clock.set(new Date(spec.at.getTime() + 5 * minuteMs));
    await repository.recordPoll(id, 'waiting', {
      to: 'incomplete', poll: poll('INCOMPLETE_DEPOSIT', clock.now(), {}, amount / 2n), nextPollAt: farPoll,
    });

    return 0n as MicroUsd;
  }

  // Received: processing
  clock.set(new Date(spec.at.getTime() + 5 * minuteMs));
  await repository.recordPoll(id, 'waiting', { to: 'processing', poll: poll('PROCESSING', clock.now()), nextPollAt: new Date(clock.now().getTime() + pollEvery) });
  if (spec.status === 'processing') {
    // Still converting: the next poll is far off, so the workers leave it alone
    await repository.recordPoll(id, 'processing', { to: 'processing', poll: poll('PROCESSING', clock.now()), nextPollAt: farPoll });

    return 0n as MicroUsd;
  }

  clock.advance(2 * minuteMs);
  if (spec.status === 'refunded') {
    await repository.markRefunded(id, 'processing', {
      poll: poll('REFUNDED', clock.now(), { refundedAmount: amount.toString(), refundReason: 'PARTIALLY_FILLED' }),
      refundedAmount: amount,
      refundReason: 'The swap could not be filled within the slippage',
      refundTxHash: originHashOf(spec.blockchain, random),
    });

    return 0n as MicroUsd;
  }
  if (spec.status === 'failed') {
    await repository.markFailed(id, 'processing', { poll: poll('FAILED', clock.now()), reason: 'The swap failed on 1Click\'s side' });

    return 0n as MicroUsd;
  }

  const delivery = seeding.hash('near', Math.abs(Number.parseInt(correlationId.slice(0, 6), 16)));
  await repository.markCredited({
    id,
    from: 'processing',
    credit: {
      poll: poll('SUCCESS', clock.now(), { amountOut: credits.toString(), destinationChainTxHashes: [{ hash: delivery, explorerUrl: '' }] }),
      creditedAmount: credits,
      deliveryTxHash: delivery,
      refundedAmount: undefined,
    },
    book: tx => createLedger({ db: tx, clock, ids }).topUp({
      accountId: spec.account.id, asset: settings.asset.name, amount: credits, reference: address, requestId: `${seedRequestPrefix}topup:${id}`,
    }),
  });

  return credits;
};
