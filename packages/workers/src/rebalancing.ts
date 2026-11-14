import { Counter, type Registry } from '@prometheus-io/client';

import { atomicToUsd, formatUsd, isRecord, type Clock, type IdGenerator, type Logger, type MicroUsd } from '@anyfare/common';
import { TreasuryTransferReferenceConflictError, type Asset, type BalanceReader, type JsonObject, type PlatformConfig, type RebalancingTarget } from '@anyfare/core';
import type { Refill, RefillAnswer, RefillRepository, RefillStatus } from '@anyfare/db';
import {
  OneClickNotFoundError, OneClickRefusedError, OneClickUnavailableError, type OneClickClient, type OneClickStatus, type OneClickStatusResponse,
} from '@anyfare/topups';

import { RunStoppedError } from './scheduler.js';
import type { RefillSigner, SignerRefill } from './signerClient.js';
import { nextPollAt } from './topupStatus.js';

// One runner across replicas
export const rebalancingLockId = 7_301_746_214;
export const rebalancingJobName = 'rebalancing';
/** The pause between runs: rebalancing.intervalSeconds. */
export const rebalancingIntervalMs = (config: Pick<PlatformConfig, 'rebalancing'>): number => config.rebalancing.intervalSeconds * 1_000;
const defaultBatchSize = 50;

const minuteMs = 60_000;
const hourMs = 60 * minuteMs;
// A sent refill's first poll of 1Click
export const firstRefillPollMs = 10_000;
// A refill still `requested` this long after it was made: the Signer's answer is overdue
export const stuckRequestedMs = 10 * minuteMs;
// How long a target may stay under its floor before it alerts
export const underFloorAlertMs = hourMs;
// How often an alert about the same refill or target repeats while it lasts
export const alertRepeatMs = hourMs;
// How long after a refill's deadline, the one the Signer asked 1Click for, 1Click may still be waiting for its deposit
export const pendingAfterDeadlineMs = 72 * hourMs;
/**
 * The longest a refill stays `requested` and asked again: the Signer keeps an ID's record 7 days, and a
 * re-ask after that would send again. Past it, an operator decides.
 */
export const requestedLimitMs = 24 * hourMs;
// How long a sent refill may take to finish before it alerts
export const unfinishedAlertMs = hourMs;
// How long an asset gets no new refill after the Signer refused one for its day's cap or a short NEAR hot wallet
export const refusalPauseMs = hourMs;
// The refusals that pause an asset's refills
const pausingReasons: readonly string[] = ['signing_refused:daily_limit', 'signing_refused:source_low'];
// The 503s the Signer may answer before it reads an ID's record: for an ID asked before, it may have sent
const beforeRecordCodes: readonly string[] = ['refills_off', 'redis_not_ready'];
// What a log line keeps of a value 1Click sent
const maxLoggedLength = 128;
const digitsPattern = /^\d{1,40}$/;

/** What a target's balance calls for. */
export type RefillDecision =
  | { readonly kind: 'above_floor' }
  // Under the floor, but the refill would be under leastPerRefill
  | { readonly kind: 'below_least'; readonly amount: MicroUsd }
  | { readonly kind: 'refill'; readonly amount: MicroUsd };

/**
 * Whether a hot wallet needs a refill, and of how much: nothing at or above its floor; under it, what
 * brings it up to its target, at most `mostPerRefill`, and nothing when that is under `leastPerRefill`.
 */
export const decideRefill = ({ balance, target, leastPerRefill, mostPerRefill }: {
  readonly balance: MicroUsd;
  readonly target: Pick<RebalancingTarget, 'floor' | 'target'>;
  readonly leastPerRefill: MicroUsd;
  readonly mostPerRefill: MicroUsd;
}): RefillDecision => {
  if (balance >= target.floor)
    return { kind: 'above_floor' };
  const missing = target.target - balance;
  const amount = (missing < mostPerRefill ? missing : mostPerRefill) as MicroUsd;

  return amount < leastPerRefill ? { kind: 'below_least', amount } : { kind: 'refill', amount };
};

/**
 * What a refill 1Click completed moved, in micro-USD: what left the NEAR hot wallet, the quote's
 * amountIn less what 1Click refunded to it, rounded up, and what arrived, rounded down, each read with
 * its asset's decimals. Undefined when the refund is more than amountIn.
 */
export const bookingAmounts = ({ amountIn, refundedAmount, amountOut, source, target }: {
  readonly amountIn: bigint;
  readonly refundedAmount: bigint | undefined;
  readonly amountOut: bigint;
  readonly source: Pick<Asset, 'decimals'>;
  readonly target: Pick<Asset, 'decimals'>;
}): { readonly amountInUsd: MicroUsd; readonly amountOutUsd: MicroUsd } | undefined => {
  const left = amountIn - (refundedAmount ?? 0n);
  if (left < 0n)
    return undefined;

  return {
    amountInUsd: atomicToUsd(left, { decimals: source.decimals, rounding: 'ceil' }),
    amountOutUsd: atomicToUsd(amountOut, { decimals: target.decimals, rounding: 'floor' }),
  };
};

/** What a poll of 1Click does to a sent or unknown refill. */
export type RefillPollStep = 'book' | 'refunded' | 'review' | 'wait';

const pollSteps: Readonly<Record<OneClickStatus, RefillPollStep>> = {
  SUCCESS: 'book',
  REFUNDED: 'refunded',
  // Money left the NEAR hot wallet and 1Click didn't finish: an operator decides
  FAILED: 'review',
  PENDING_DEPOSIT: 'wait',
  KNOWN_DEPOSIT_TX: 'wait',
  INCOMPLETE_DEPOSIT: 'wait',
  PROCESSING: 'wait',
};

/** The step for a 1Click status. */
export const pollStepOf = (status: OneClickStatus): RefillPollStep => pollSteps[status];

/**
 * How a refill's row keeps the Signer's answer: sent or unknown, followed through 1Click from
 * `nextPollAt`; failed or not sent, final. `keep`: it stays `requested`, and is asked again with the
 * same ID on the next run, which is safe, since the Signer never sends twice for one ID. An ID asked
 * `again` that the Signer refused before it read the ID's record, `refills_off` or `redis_not_ready`,
 * may have sent at its first ask: it is kept too.
 */
export const refillAnswerOf = (answer: SignerRefill, nextPoll: Date, again = false): RefillAnswer | 'keep' => {
  switch (answer.kind) {
    case 'sent':
    case 'unknown': {
      const { depositAddress, amountIn, amountOut, quoteDeadline, correlationId, transactionHash } = answer.transfer;
      const transfer = { depositAddress, amountIn, amountOut, quoteDeadline, correlationId, nearTransactionHash: transactionHash, nextPollAt: nextPoll };

      return answer.kind === 'sent' ? { status: 'sent', transfer, quote: answer.quote } : { status: 'unknown', transfer };
    }
    case 'failed':
      return { status: 'failed', reason: 'refill_failed', nearTransactionHash: answer.transactionHash };
    case 'not_sent':
      if (again && answer.status === 503 && beforeRecordCodes.includes(answer.code))
        return 'keep';

      return { status: 'not_sent', reason: answer.reason === undefined ? answer.code : `${answer.code}:${answer.reason}` };
    // The Signer holds a pending marker for the ID, or its answer never arrived
    case 'in_progress':
    case 'no_answer':
      return 'keep';
  }
};

export interface RebalancingMetrics {
  readonly refills: Counter<'asset' | 'status'>;
  readonly refillUsd: Counter<'asset'>;
}

export const createRebalancingMetrics = (registry: Registry): RebalancingMetrics => ({
  refills: new Counter({
    name: 'rebalancing_refills_total',
    help: 'Refills of the Signer\'s hot wallets, by target asset and the status each moved to',
    labelNames: ['asset', 'status'] as const,
    registers: [registry],
  }),
  refillUsd: new Counter({
    name: 'rebalancing_refill_usd_total',
    help: 'What the booked refills delivered to the Signer\'s hot wallets, in USD, per target asset',
    labelNames: ['asset'] as const,
    registers: [registry],
  }),
});

export interface RebalancingOptions {
  readonly refills: Pick<RefillRepository, 'create' | 'findLatest' | 'listInFlight' | 'recordAnswer' | 'listDue' | 'claimPoll' | 'recordPoll' | 'finish' | 'book'>;
  // Undefined: no refill is asked for, and the refills already sent are still followed
  readonly signer?: RefillSigner;
  readonly oneClick: Pick<OneClickClient, 'status'>;
  // The balance reader for an asset's chain. Undefined: none, and its targets are skipped.
  readonly readerFor: (asset: Asset) => BalanceReader | undefined;
  readonly config: Pick<PlatformConfig, 'assets' | 'rebalancing' | 'signer'>;
  readonly metrics: RebalancingMetrics;
  readonly clock: Clock;
  // Refill IDs: ref_<ID>
  readonly ids: IdGenerator;
  readonly logger: Logger;
  readonly batchSize?: number;
}

export interface RebalancingResult {
  // Asked 1Click about
  readonly polled: number;
  readonly succeeded: number;
  readonly refunded: number;
  // Flagged for an operator: money may have moved
  readonly review: number;
  // New refills made, and refills asked of the Signer again
  readonly created: number;
  readonly askedAgain: number;
  // The Signer's answers
  readonly sent: number;
  readonly unknown: number;
  readonly failed: number;
  readonly notSent: number;
  // Left requested: the Signer holds the ID, or didn't answer
  readonly inProgress: number;
  readonly noAnswer: number;
  // 1Click didn't answer: polled again at the next time
  readonly unavailable: number;
  // Targets skipped: their balance couldn't be read
  readonly unread: number;
  readonly alerts: number;
  // Couldn't be acted on, such as the database failing: tried again next run, and the run fails
  readonly errors: number;
}

/** Some refills or targets couldn't be acted on. They are tried again next run, and the job stays stale. */
export class RebalancingFailedError extends Error {
  constructor(readonly result: RebalancingResult) {
    super(`${result.errors} refills or targets couldn't be acted on`);
  }
}

const clip = (value: unknown): unknown => typeof value === 'string' ? value.slice(0, maxLoggedLength) : value;

const amountOf = (value: string | undefined): bigint | undefined => value !== undefined && digitsPattern.test(value) ? BigInt(value) : undefined;

// A refill's fields for a line
const whereOf = (refill: Refill) => ({
  refillId: refill.id,
  asset: refill.asset,
  amount: formatUsd(refill.amount),
  depositAddress: refill.depositAddress ?? null,
  transactionHash: refill.nearTransactionHash ?? null,
});

/**
 * The rebalancing job: keeps the Signer's hot wallets on Base and Solana between their floor and
 * target, by asking the Signer for refills paid from its NEAR hot wallet through 1Click. With
 * rebalancing off, or without the Signer, steps 2 to 4 are left out: nothing is asked of the Signer, and
 * what it already sent is still followed, booked and alerted on. One run, in order:
 *
 * 1. Follows the sent and unknown refills that are due through 1Click's status for their deposit
 *    address. SUCCESS books the refill, in one transaction with the ledger's treasury transfer;
 *    REFUNDED ends it, and nothing is booked; FAILED, PENDING_DEPOSIT 72 hours past the refill's
 *    deadline, and an address 1Click doesn't know past that deadline flag it for review. The deadline
 *    is the one the Signer asked 1Click for. Anything else, or 1Click not answering, polls it again later.
 * 2. Asks the Signer again for each refill still `requested`, with the same ID: its first answer never
 *    arrived, and the Signer answers what it did then, without sending twice.
 * 3. For each target without a refill in flight, reads the Signer's wallet on the target's chain, and
 *    under the floor makes a refill up to the target and asks the Signer for it.
 * 4. Keeps each answer: see `refillAnswerOf`.
 * 5. Alerts once an hour on a target under its floor for an hour, a refill `requested` for more than
 *    10 minutes, and each refill in review. The times are this process's: a restart starts them again.
 *
 * Throws RebalancingFailedError after the run when any refill couldn't be acted on.
 */
export const createRebalancing = ({
  refills, signer, oneClick, readerFor, config, metrics, clock, ids, logger, batchSize = defaultBatchSize,
}: RebalancingOptions) => {
  const { rebalancing } = config;
  // When each target was first seen under its floor, by asset: this process's memory
  const underSince = new Map<string, { readonly since: number; balance: MicroUsd }>();
  // When each alert last fired, by `target:<asset>` or `refill:<ID>`
  const alertedAt = new Map<string, number>();

  return async (stopping?: AbortSignal): Promise<RebalancingResult> => {
    const counts = {
      polled: 0, succeeded: 0, refunded: 0, review: 0, created: 0, askedAgain: 0, sent: 0, unknown: 0, failed: 0, notSent: 0, inProgress: 0, noAnswer: 0,
      unavailable: 0, unread: 0, alerts: 0, errors: 0,
    };
    // Off, or no Signer to ask: only what was already sent is followed
    const asks = rebalancing.enabled && signer !== undefined;

    const assetNamed = (name: string): Asset | undefined => config.assets.find(asset => asset.name === name);
    const moved = (refill: Pick<Refill, 'asset'>, status: RefillStatus): void => metrics.refills.inc({ asset: refill.asset, status });
    const checkStopping = (): void => {
      if (stopping?.aborted)
        throw new RunStoppedError(counts);
    };
    // The first time 1Click didn't answer this run, for the run's one warning
    let firstUnavailable: OneClickUnavailableError | OneClickRefusedError | undefined;

    const review = async (refill: Refill, reason: string, details: Readonly<Record<string, unknown>> = {}, lastStatus?: JsonObject): Promise<void> => {
      if (!await refills.finish(refill.id, refill.status, { status: 'review', reason, lastStatus }))
        return;
      counts.review += 1;
      moved(refill, 'review');
      // This line is the refill's first alert: the hourly ones follow
      alertedAt.set(`refill:${refill.id}`, clock.now().getTime());
      logger.error({ ...whereOf(refill), status: refill.status, reason, ...details, alert: true }, 'A refill needs review: money may have moved');
    };

    // A final answer must be for the refill's quote: one for another deposit address goes to review. True when it went.
    const reviewedMismatch = async (refill: Refill, answer: OneClickStatusResponse): Promise<boolean> => {
      const quoteResponse = answer.raw['quoteResponse'];
      const quote = isRecord(quoteResponse) ? quoteResponse['quote'] : undefined;
      if (!isRecord(quote) || quote['depositAddress'] === refill.depositAddress)
        return false;
      await review(refill, 'deposit_address_mismatch', {
        oneClickStatus: answer.status, received: clip(quote['depositAddress']), correlationId: answer.correlationId,
      }, answer.raw as JsonObject);

      return true;
    };

    // 1. SUCCESS: what left NEAR and what arrived, booked once
    const book = async (refill: Refill, answer: OneClickStatusResponse): Promise<void> => {
      const lastStatus = answer.raw as JsonObject;
      if (await reviewedMismatch(refill, answer))
        return;
      const source = assetNamed(refill.sourceAsset);
      const target = assetNamed(refill.asset);
      const { amountOut: delivered, refundedAmount: refundedText, refundFee: refundFeeText } = answer.swapDetails;
      const amountOut = amountOf(delivered);
      const refundedAmount = amountOf(refundedText);
      // A refund we can't read could hide what came back, and more than the quote's amountOut can't be ours to book
      if (refundedText !== undefined && refundedAmount === undefined) {
        await review(refill, 'unreadable_refund', { refunded: clip(refundedText), correlationId: answer.correlationId }, lastStatus);
        return;
      }
      if (amountOut !== undefined && refill.amountOut !== undefined && amountOut > refill.amountOut) {
        await review(refill, 'amount_out_above_quote', {
          amountOut: amountOut.toString(), quoteAmountOut: refill.amountOut.toString(), correlationId: answer.correlationId,
        }, lastStatus);
        return;
      }
      const amounts = source && target && refill.amountIn !== undefined && amountOut !== undefined && amountOut > 0n
        ? bookingAmounts({ amountIn: refill.amountIn, refundedAmount, amountOut, source, target })
        : undefined;
      if (!amounts || amounts.amountInUsd <= 0n || amounts.amountOutUsd <= 0n) {
        await review(refill, 'unreadable_success', {
          amountIn: refill.amountIn?.toString() ?? null, amountOut: clip(delivered) ?? null, refunded: clip(refundedText) ?? null, correlationId: answer.correlationId,
        }, lastStatus);
        return;
      }
      const deliveryTransactionHashes = answer.swapDetails.destinationChainTxHashes.map(transaction => transaction.hash);
      let booked: Refill | undefined;
      try {
        booked = await refills.book({
          id: refill.id, from: refill.status, lastStatus, ...amounts, deliveryTransactionHashes,
          refundedAmount: refundedAmount === 0n ? undefined : refundedAmount, refundFee: amountOf(refundFeeText),
        });
      }
      catch (error) {
        // The ledger refused it: a transfer that would gain USD, or another under the same reference. Never a second booking.
        if (!(error instanceof RangeError) && !(error instanceof TreasuryTransferReferenceConflictError))
          throw error;
        await review(refill, 'ledger_refused', {
          message: error.message, amountInUsd: formatUsd(amounts.amountInUsd), amountOutUsd: formatUsd(amounts.amountOutUsd),
        }, lastStatus);
        return;
      }
      // Another runner booked it
      if (!booked)
        return;
      // A balance read later this run may not show it yet
      bookedAssets.add(refill.asset);
      counts.succeeded += 1;
      moved(refill, 'succeeded');
      metrics.refillUsd.inc({ asset: refill.asset }, Number(formatUsd(amounts.amountOutUsd)));
      logger.info({
        ...whereOf(refill), source: refill.sourceAsset, left: formatUsd(amounts.amountInUsd), arrived: formatUsd(amounts.amountOutUsd),
        cost: formatUsd((amounts.amountInUsd - amounts.amountOutUsd) as MicroUsd), deliveryTransactions: deliveryTransactionHashes,
        ...refundedAmount === undefined || refundedAmount === 0n ? {} : { refunded: refundedAmount.toString() },
      }, 'A refill arrived and was booked');
    };

    // 1. REFUNDED: the money is back in the NEAR hot wallet, less 1Click's fee, which reconciliation shows
    const refund = async (refill: Refill, answer: OneClickStatusResponse): Promise<void> => {
      if (await reviewedMismatch(refill, answer))
        return;
      const { refundedAmount, refundFee, refundReason } = answer.swapDetails;
      const changed = await refills.finish(refill.id, refill.status, {
        status: 'refunded', lastStatus: answer.raw as JsonObject, refundedAmount: amountOf(refundedAmount), refundFee: amountOf(refundFee),
        refundReason: clip(refundReason) as string | undefined,
      });
      if (!changed)
        return;
      counts.refunded += 1;
      moved(refill, 'refunded');
      logger.info({
        ...whereOf(refill), refunded: clip(refundedAmount) ?? null, refundFee: clip(refundFee) ?? null, refundReason: clip(refundReason) ?? null,
      }, 'A refill was refunded to the NEAR hot wallet: nothing was booked');
    };

    const pollError = async (refill: Refill, error: unknown, at: Date): Promise<void> => {
      if (error instanceof OneClickNotFoundError) {
        // 1Click never saw the quote's address: past the deadline, it never will
        if (refill.quoteDeadline !== undefined && at.getTime() >= refill.quoteDeadline.getTime())
          await review(refill, 'oneclick_not_found', { quoteDeadline: refill.quoteDeadline.toISOString() });
        else
          logger.debug(whereOf(refill), '1Click doesn\'t know a refill\'s deposit address yet: it is polled again');
        return;
      }
      if (error instanceof OneClickUnavailableError || error instanceof OneClickRefusedError) {
        // The claim already moved its next poll
        counts.unavailable += 1;
        firstUnavailable ??= error;
        return;
      }
      throw error;
    };

    const follow = async (listed: Refill): Promise<void> => {
      const at = clock.now();
      const next = nextPollAt({ createdAt: listed.sentAt ?? listed.createdAt, payBy: listed.quoteDeadline ?? listed.createdAt }, at);
      // Of two runners that listed it, only the one that claims it asks 1Click
      const refill = await refills.claimPoll({ id: listed.id, seenUpdatedAt: listed.updatedAt, nextPollAt: next });
      if (!refill)
        return;
      // The database ties an address to every status that is polled
      const depositAddress = refill.depositAddress!;
      counts.polled += 1;
      let answer: OneClickStatusResponse;
      try {
        answer = await oneClick.status({ depositAddress });
      }
      catch (error) {
        await pollError(refill, error, at);
        return;
      }
      const lastStatus = answer.raw as JsonObject;
      switch (pollStepOf(answer.status)) {
        case 'book':
          await book(refill, answer);
          return;
        case 'refunded':
          await refund(refill, answer);
          return;
        case 'review':
          await review(refill, 'oneclick_failed', { correlationId: answer.correlationId }, lastStatus);
          return;
        case 'wait': {
          const late = refill.quoteDeadline !== undefined && at.getTime() >= refill.quoteDeadline.getTime() + pendingAfterDeadlineMs;
          if (answer.status === 'PENDING_DEPOSIT' && late)
            await review(refill, 'pending_after_deadline', { quoteDeadline: refill.quoteDeadline!.toISOString() }, lastStatus);
          else
            await refills.recordPoll(refill.id, refill.status, { lastStatus, nextPollAt: next });
        }
      }
    };

    // 2 and 4. One ask of the Signer, and its answer kept. `again`: the ID was asked before.
    const ask = async (refill: Refill, again: boolean): Promise<void> => {
      if (!signer)
        return;
      const answer = await signer.refill({ refillId: refill.id, asset: refill.asset, amount: refill.amount });
      const kept = refillAnswerOf(answer, new Date(clock.now().getTime() + firstRefillPollMs), again);
      const fields = { refillId: refill.id, asset: refill.asset, amount: formatUsd(refill.amount) };
      if (kept === 'keep') {
        if (answer.kind === 'in_progress') {
          counts.inProgress += 1;
          logger.info({ ...fields, message: answer.message }, 'The Signer is still on a refill, or stopped in the middle of it: it is asked again next run');
        }
        else if (answer.kind === 'no_answer') {
          counts.noAnswer += 1;
          logger.warn({ ...fields, status: answer.status ?? null, code: answer.code ?? null, message: answer.message },
            'The Signer\'s answer to a refill never arrived: it is asked again next run, with the same ID');
        }
        else if (answer.kind === 'not_sent') {
          counts.noAnswer += 1;
          logger.warn({ ...fields, status: answer.status, code: answer.code, message: answer.message },
            'The Signer refused a refill asked again before it read the ID\'s record: it may have sent at the first ask, so it is asked again next run');
        }
        return;
      }
      let changed: Refill | undefined;
      let failure: unknown;
      try {
        changed = await refills.recordAnswer(refill.id, kept);
      }
      catch (error) {
        failure = error;
      }
      if (!changed) {
        // Money moved, or may have: never dropped without a word
        if (kept.status === 'sent' || kept.status === 'unknown') {
          logger.error({
            ...fields, answer: kept.status, depositAddress: kept.transfer.depositAddress, transactionHash: kept.transfer.nearTransactionHash,
            ...failure === undefined ? {} : { error: failure }, alert: true,
          }, 'The Signer sent a refill, but its answer couldn\'t be kept: follow its deposit address by hand');
          if (failure !== undefined && await refills.finish(refill.id, 'requested', { status: 'review', reason: 'answer_not_kept' }).catch(() => undefined)) {
            counts.review += 1;
            moved(refill, 'review');
            alertedAt.set(`refill:${refill.id}`, clock.now().getTime());
            return;
          }
        }
        if (failure !== undefined)
          throw failure;
        return;
      }
      moved(refill, kept.status);
      switch (answer.kind) {
        case 'sent':
          counts.sent += 1;
          logger.info({
            ...fields, depositAddress: answer.transfer.depositAddress, amountIn: answer.transfer.amountIn.toString(), amountOut: answer.transfer.amountOut.toString(),
            transactionHash: answer.transfer.transactionHash, correlationId: answer.transfer.correlationId,
          }, 'The Signer sent a refill: 1Click\'s status is followed');
          return;
        case 'unknown':
          counts.unknown += 1;
          logger.warn({ ...fields, depositAddress: answer.transfer.depositAddress, transactionHash: answer.transfer.transactionHash },
            'A refill\'s transaction may have landed: 1Click\'s status is followed');
          return;
        case 'failed':
          counts.failed += 1;
          logger.warn({ ...fields, transactionHash: answer.transactionHash ?? null, message: answer.message }, 'A refill\'s transaction failed: nothing moved');
          return;
        case 'not_sent': {
          counts.notSent += 1;
          const line = { ...fields, status: answer.status, code: answer.code, reason: answer.reason ?? null, message: answer.message };
          // The NEAR hot wallet is short: an operator moves USDC to it from the NEAR treasury
          if (answer.code === 'signing_refused' && answer.reason === 'source_low')
            logger.warn({ ...line, alert: true }, 'The Signer refused a refill: the NEAR hot wallet holds too little, move USDC to it from the NEAR treasury');
          else
            logger.info(line, 'The Signer refused a refill, or was busy: nothing moved');
        }
      }
    };

    // Each refill or target on its own: one that fails is counted, and the others go on
    const each = async <TItem>(items: readonly TItem[], work: (item: TItem) => Promise<void>, failure: (item: TItem) => Readonly<Record<string, unknown>>): Promise<void> => {
      for (const item of items) {
        checkStopping();
        try {
          await work(item);
        }
        catch (error) {
          counts.errors += 1;
          logger.error({ error, ...failure(item) }, 'Failed to act on a refill');
        }
      }
    };

    // The assets booked this run
    const bookedAssets = new Set<string>();

    // 1. Follow open refills
    await each(await refills.listDue({ now: clock.now(), limit: batchSize }), follow, refill => ({ refillId: refill.id, step: 'follow' }));
    if (firstUnavailable) {
      logger.warn({
        unavailable: counts.unavailable, reason: firstUnavailable instanceof OneClickUnavailableError ? firstUnavailable.reason : 'refused',
        status: firstUnavailable.status ?? null, message: firstUnavailable.message,
      }, '1Click didn\'t answer for some refills: they are polled again at their next time');
    }

    // 2. Ask again for requested refills. Their assets get no other ask this run.
    const askedAgain = new Set<string>();
    const requested = asks ? (await refills.listInFlight()).filter(refill => refill.status === 'requested') : [];
    await each(requested, async refill => {
      askedAgain.add(refill.asset);
      // Past the Signer's memory of the ID a re-ask could send again: an operator decides
      if (clock.now().getTime() - refill.createdAt.getTime() >= requestedLimitMs) {
        await review(refill, 'requested_too_long', { createdAt: refill.createdAt.toISOString() });
        return;
      }
      counts.askedAgain += 1;
      await ask(refill, true);
    }, refill => ({ refillId: refill.id, step: 'ask_again' }));

    // 3. Decide new refills
    const inFlight = new Set((await refills.listInFlight()).map(refill => refill.asset));
    const decide = async (target: RebalancingTarget): Promise<void> => {
      const { asset } = target;
      if (inFlight.has(asset.name) || askedAgain.has(asset.name) || bookedAssets.has(asset.name))
        return;
      const chain = asset.network.chain;
      const wallet = chain === 'base' || chain === 'solana' ? config.signer.wallets[chain] : undefined;
      const reader = readerFor(asset);
      let held: bigint;
      try {
        if (wallet === undefined || !reader)
          throw new Error(`No ${wallet === undefined ? 'Signer wallet' : 'balance reader'} on ${asset.network.title}`);
        held = await reader.balance({ address: wallet, asset });
      }
      catch (error) {
        // Skipped this run. The treasury's balance monitor alerts on reads that keep failing.
        counts.unread += 1;
        logger.warn({ error, asset: asset.name, network: asset.network.id }, 'Couldn\'t read a hot wallet\'s balance: its refill waits for the next run');
        return;
      }
      const balance = atomicToUsd(held, { decimals: asset.decimals, rounding: 'floor' });
      const decision = decideRefill({ balance, target, leastPerRefill: rebalancing.leastPerRefill, mostPerRefill: rebalancing.mostPerRefill });
      if (decision.kind === 'above_floor') {
        underSince.delete(asset.name);
        alertedAt.delete(`target:${asset.name}`);
        return;
      }
      const under = underSince.get(asset.name);
      if (under)
        under.balance = balance;
      else
        underSince.set(asset.name, { since: clock.now().getTime(), balance });
      if (decision.kind === 'below_least') {
        logger.debug({ asset: asset.name, balance: formatUsd(balance), amount: formatUsd(decision.amount), leastPerRefill: formatUsd(rebalancing.leastPerRefill) },
          'A hot wallet is under its floor by less than the least refill: no refill');
        return;
      }
      // The Signer refused the last one for the day's cap or a short NEAR hot wallet: an hour's pause, from the row, so restarts keep it
      const latest = await refills.findLatest(asset.name);
      const refusedAt = latest?.status === 'not_sent' && latest.reason !== undefined && pausingReasons.includes(latest.reason)
        ? (latest.finishedAt ?? latest.updatedAt).getTime()
        : undefined;
      if (refusedAt !== undefined && clock.now().getTime() - refusedAt < refusalPauseMs) {
        logger.debug({ asset: asset.name, refillId: latest!.id, reason: latest!.reason, until: new Date(refusedAt + refusalPauseMs).toISOString() },
          'A hot wallet is under its floor, but the Signer refused its last refill within the hour: no refill yet');
        return;
      }
      const created = await refills.create({ id: `ref_${ids.next()}`, asset: asset.name, sourceAsset: rebalancing.source!.name, amount: decision.amount });
      if (created === 'busy')
        return;
      counts.created += 1;
      moved(created, 'requested');
      logger.info({ refillId: created.id, asset: asset.name, balance: formatUsd(balance), floor: formatUsd(target.floor), amount: formatUsd(decision.amount) },
        'A hot wallet is under its floor: the Signer is asked for a refill');
      await ask(created, false);
    };
    // A config without a source is refused while rebalancing is on
    if (asks && rebalancing.source)
      await each(rebalancing.targets, decide, target => ({ asset: target.asset.name, step: 'decide' }));

    // 5. Alerts, once an hour each while it lasts
    const now = clock.now().getTime();
    const seen = new Set<string>();
    const alert = (key: string, firstAt: number, line: () => void): void => {
      seen.add(key);
      const last = alertedAt.get(key);
      if (now < firstAt || (last !== undefined && now - last < alertRepeatMs))
        return;
      alertedAt.set(key, now);
      counts.alerts += 1;
      line();
    };
    for (const [asset, under] of underSince) {
      const target = rebalancing.targets.find(item => item.asset.name === asset);
      alert(`target:${asset}`, under.since + underFloorAlertMs, () => logger.error({
        asset, balance: formatUsd(under.balance), floor: target ? formatUsd(target.floor) : null, since: new Date(under.since).toISOString(), alert: true,
      }, 'A hot wallet has been under its floor for over an hour'));
    }
    for (const refill of await refills.listInFlight()) {
      if (refill.status === 'requested') {
        alert(`refill:${refill.id}`, refill.createdAt.getTime() + stuckRequestedMs, () => logger.error({
          ...whereOf(refill), createdAt: refill.createdAt.toISOString(), alert: true,
        }, asks
          ? 'A refill has waited over 10 minutes for the Signer\'s answer: it is asked again each run'
          : 'A refill waits for the Signer\'s answer, and no refill is asked for now: turn rebalancing on, so the Signer is asked again'));
      }
      else if ((refill.status === 'sent' || refill.status === 'unknown') && refill.sentAt !== undefined) {
        alert(`refill:${refill.id}`, refill.sentAt.getTime() + unfinishedAlertMs, () => logger.error({
          ...whereOf(refill), status: refill.status, sentAt: refill.sentAt!.toISOString(), lastStatus: refill.lastStatus?.['status'] ?? null, alert: true,
        }, 'A refill hasn\'t finished an hour after it was sent'));
      }
      else if (refill.status === 'review') {
        alert(`refill:${refill.id}`, refill.updatedAt.getTime(), () => logger.error({
          ...whereOf(refill), reason: refill.reason ?? null, alert: true,
        }, 'A refill still needs review: no new refill of its asset until an operator changes its status'));
      }
    }
    // Alerts that no longer apply start again from nothing
    for (const key of alertedAt.keys()) {
      if (!seen.has(key))
        alertedAt.delete(key);
    }

    if (counts.errors > 0)
      throw new RebalancingFailedError(counts);

    return counts;
  };
};
