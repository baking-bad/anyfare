import { Counter, type Registry } from '@prometheus-io/client';

import { atomicToUsd, formatUsd, isRecord, type Clock, type Logger, type MicroUsd } from '@anyfare/common';
import { TopUpReferenceConflictError, type Asset, type JsonObject, type PlatformConfig } from '@anyfare/core';
import type { DatabaseExecutor, Ledger, PolledTopupStatus, Topup, TopupPoll, TopupRepository } from '@anyfare/db';
import {
  formatTokenAmount, fromOneClickStatus, OneClickNotFoundError, OneClickRefusedError, OneClickUnavailableError, type OneClickClient,
  type OneClickStatus, type OneClickStatusResponse,
} from '@anyfare/topups';

// One runner across replicas
export const topupStatusLockId = 7_301_746_211;
export const topupStatusJobName = 'topup_status';
export const topupStatusIntervalMs = 10_000;
const defaultBatchSize = 50;

const minuteMs = 60_000;
const hourMs = 60 * minuteMs;
const dayMs = 24 * hourMs;
/**
 * How long a top-up may stay `quoting` before its quote's outcome counts as lost: the API asks 1Click
 * once, within its timeout, and records the answer right after.
 */
export const stuckQuotingMs = 10 * minuteMs;
/**
 * How long after its address goes inactive a top-up is still polled when 1Click knows a deposit, or
 * its answers were unclear: a swap under way may finish, or be refunded, after the address's end.
 */
export const pollingWindowAfterExpiryMs = 7 * dayMs;
// How long 1Click may not know a new deposit address before that counts as unclear
const notFoundGraceMs = 10 * minuteMs;
// The detail of the client's error for a status it doesn't know
const unknownStatusDetail = 'status is not a known status';
// What a log line keeps of a value 1Click sent
const maxLoggedLength = 128;
// The statuses that say 1Click has seen a deposit
const depositStatuses: readonly string[] = ['KNOWN_DEPOSIT_TX', 'INCOMPLETE_DEPOSIT', 'PROCESSING'] satisfies readonly OneClickStatus[];

/**
 * Whether the workers poll top-ups: the top-ups section names a recipient and an asset. `enabled` only
 * gates new top-ups in the API: open ones are still followed and credited after it is switched off.
 */
export const pollsTopups = (config: Pick<PlatformConfig, 'topups'>): boolean => config.topups.recipient !== undefined && config.topups.asset !== undefined;

/**
 * When to poll a top-up next, by its age: every 10 s in its first hour, every minute until its
 * pay-by time, every 5 minutes after.
 */
export const nextPollAt = (topup: Pick<Topup, 'createdAt' | 'payBy'>, now: Date): Date => {
  const at = now.getTime();
  const delayMs = at - topup.createdAt.getTime() < hourMs ? 10_000 : at < topup.payBy.getTime() ? minuteMs : 5 * minuteMs;

  return new Date(at + delayMs);
};

/** When polling a top-up ends without a final status: 7 days after its address goes inactive. */
export const pollingEndsAt = (topup: Pick<Topup, 'addressExpiresAt' | 'payBy'>): Date =>
  new Date((topup.addressExpiresAt ?? topup.payBy).getTime() + pollingWindowAfterExpiryMs);

/** What came of one poll, for `workers_topup_polls_total`. */
export const topupPollResults = [
  'waiting', 'incomplete', 'processing', 'expired', 'credited', 'refunded', 'failed', 'review', 'not_found', 'unclear', 'unavailable', 'rejected', 'error',
] as const;
export type TopupPollResult = typeof topupPollResults[number];

export interface TopupStatusMetrics {
  readonly credited: Counter;
  readonly creditedUsd: Counter;
  readonly polls: Counter<'result'>;
}

export const createTopupStatusMetrics = (registry: Registry): TopupStatusMetrics => ({
  credited: new Counter({
    name: 'workers_topups_credited_total',
    help: 'Top-ups whose Credits were added to their accounts',
    registers: [registry],
  }),
  creditedUsd: new Counter({
    name: 'workers_topups_credited_usd_total',
    help: 'What top-ups added to balances, in USD',
    registers: [registry],
  }),
  polls: new Counter({
    name: 'workers_topup_polls_total',
    help: `Polls of 1Click's status, by what came of them: ${topupPollResults.join(', ')}`,
    labelNames: ['result'] as const,
    registers: [registry],
  }),
});

export interface TopupStatusOptions {
  readonly topups: Pick<
    TopupRepository,
    'listDue' | 'claimPoll' | 'recordPoll' | 'markCredited' | 'markRefunded' | 'markFailed' | 'markExpired' | 'flagForReview' | 'listStuckQuoting' | 'markQuoteUnknown'
  >;
  // The ledger on a database or a transaction: each credit is booked on the transaction that marks its top-up credited
  readonly ledger: (db: DatabaseExecutor) => Pick<Ledger, 'topUp'>;
  readonly oneClick: Pick<OneClickClient, 'status'>;
  // The registry, for the asset each top-up delivers
  readonly config: Pick<PlatformConfig, 'assets'>;
  readonly metrics: TopupStatusMetrics;
  // What "due", a top-up's age and its deadlines are measured against
  readonly clock: Clock;
  readonly logger: Logger;
  readonly batchSize?: number;
}

export interface TopupStatusResult {
  // Asked 1Click about
  readonly polled: number;
  readonly credited: number;
  readonly refunded: number;
  // Failed at 1Click
  readonly failed: number;
  readonly expired: number;
  // Flagged for review: no longer polled
  readonly review: number;
  // 1Click's answer said nothing usable about the swap: polled again
  readonly unclear: number;
  // 1Click didn't answer: polled again at the next scheduled time
  readonly unavailable: number;
  // 1Click refused our key, or answered in a shape we don't know: polled again, and the run fails
  readonly rejected: number;
  // Left quoting, moved to quote_unknown
  readonly stuck: number;
  // Couldn't be acted on, such as the database failing: tried again next run, and the run fails
  readonly errors: number;
}

/**
 * Some top-ups couldn't be acted on: the database failed, or 1Click refused our key or answered in a
 * shape we don't know. They are tried again next run, and the job stays stale.
 */
export class TopupStatusFailedError extends Error {
  constructor(readonly result: TopupStatusResult) {
    super(`${result.errors + result.rejected} top-ups couldn't be acted on`);
  }
}

interface Mismatch {
  readonly reason: string;
  readonly expected?: unknown;
  readonly received?: unknown;
}

const clip = (value: unknown): unknown => typeof value === 'string' ? value.slice(0, maxLoggedLength) : value;

/**
 * Why a SUCCESS isn't for the quote this top-up asked for, or undefined when it is: the quote 1Click
 * answers with must be for the row's deposit address, deliver the row's asset to the row's recipient
 * on its chain, not inside intents.near where reconciliation can't see it, refund to the row's account,
 * and name an amount out above 0.
 */
const mismatchOf = (topup: Topup, answer: OneClickStatusResponse, quote: Record<string, unknown>, request: Record<string, unknown>, asset: Asset | undefined): Mismatch | undefined => {
  if (quote['depositAddress'] !== topup.depositAddress)
    return { reason: 'deposit_address_mismatch', expected: topup.depositAddress, received: clip(quote['depositAddress']) };
  if (request['recipient'] !== topup.recipient)
    return { reason: 'recipient_mismatch', expected: topup.recipient, received: clip(request['recipient']) };
  if (!asset)
    return { reason: 'unknown_destination_asset', expected: topup.destinationAsset };
  if (request['destinationAsset'] !== `nep141:${asset.address}`)
    return { reason: 'destination_asset_mismatch', expected: `nep141:${asset.address}`, received: clip(request['destinationAsset']) };
  if (request['recipientType'] !== 'DESTINATION_CHAIN')
    return { reason: 'recipient_type_mismatch', expected: 'DESTINATION_CHAIN', received: clip(request['recipientType']) };
  if (request['refundTo'] !== topup.refundTo)
    return { reason: 'refund_to_mismatch', expected: topup.refundTo, received: clip(request['refundTo']) };
  const { amountOut } = answer.swapDetails;
  if (amountOut === undefined || !/^[0-9]+$/.test(amountOut) || BigInt(amountOut) <= 0n)
    return { reason: 'no_amount_out', received: amountOut ?? null };

  return undefined;
};

// Whether the row shows 1Click has seen a deposit at some poll
const rowKnowsDeposit = (topup: Topup): boolean =>
  topup.status === 'incomplete' || topup.status === 'processing' || topup.depositedAmount !== undefined || topup.originTxHashes.length > 0
  || (topup.oneClickStatus !== undefined && depositStatuses.includes(topup.oneClickStatus));

/**
 * The top-up status job. 1Click has no webhooks, so each run polls the top-ups that are due, oldest
 * due first, each claimed before 1Click is asked so no other runner acts on it. A top-up stops being
 * polled only on a definitive outcome, or when its polling window ends:
 *
 * - PENDING_DEPOSIT, KNOWN_DEPOSIT_TX: `waiting`, or `expired` once its pay-by time has passed, polled
 *   again; 1Click refunds a deposit that comes after it. Once the address is inactive, a top-up with
 *   no deposit ever known is `expired` for good.
 * - INCOMPLETE_DEPOSIT: `incomplete`, PROCESSING: `processing`, with what was deposited. Polled again.
 * - SUCCESS: the quote 1Click answers with is checked against the row, then the amount out is added to
 *   the account's balance and the row is `credited`, in one transaction. The ledger books a top-up
 *   once per deposit address, and the row is locked and checked first, so a second runner adds
 *   nothing. An answer that isn't for our quote is flagged for review and credits nothing.
 * - REFUNDED: `refunded`, nothing credited. The refund lands in the token sent, inside intents.near,
 *   and an operator returns it by hand.
 * - FAILED: `failed`, flagged for review.
 *
 * An unclear answer, such as an address 1Click doesn't know after 10 minutes, a refusal, or a status
 * the client doesn't know, is never definitive: it warns, and the top-up is polled again. 1Click not
 * answering leaves the top-up for its next poll. A refused key or an answer in a changed shape is
 * polled again too, and fails the run. A top-up 1Click knows a deposit for, or that got no clear
 * answer, is polled until 7 days after its address goes inactive, then flagged for review.
 *
 * Each run also moves the top-ups left `quoting` for more than 10 minutes to `quote_unknown`: their
 * quote's outcome was never recorded, so nobody was given an address. Throws TopupStatusFailedError
 * after the run when any top-up couldn't be acted on.
 */
export const createTopupStatus = ({
  topups, ledger, oneClick, config, metrics, clock, logger, batchSize = defaultBatchSize,
}: TopupStatusOptions) => async (): Promise<TopupStatusResult> => {
  const counts = { polled: 0, credited: 0, refunded: 0, failed: 0, expired: 0, review: 0, unclear: 0, unavailable: 0, rejected: 0, stuck: 0, errors: 0 };
  // The first time 1Click didn't answer this run, for the run's one warning
  let firstUnavailable: OneClickUnavailableError | undefined;
  const runAt = clock.now();
  const counted = (result: TopupPollResult): void => metrics.polls.inc({ result });
  const whereOf = (topup: Topup) => ({ topupId: topup.id, accountId: topup.accountId, depositAddress: topup.depositAddress ?? null });

  const review = async (topup: Topup, reason: string, details: Readonly<Record<string, unknown>> = {}, poll?: TopupPoll): Promise<void> => {
    if (!await topups.flagForReview(topup.id, topup.status, { reason, poll }))
      return;
    counts.review += 1;
    counted('review');
    logger.error({ ...whereOf(topup), status: topup.status, reason, ...details, alert: true }, 'A top-up needs review');
  };

  // The polling window ended without a definitive outcome: an operator decides
  const endPolling = (topup: Topup, poll?: TopupPoll): Promise<void> =>
    review(topup, 'polling_ended', { detail: 'Polling ended without a final status', pollingEndedAt: pollingEndsAt(topup).toISOString() }, poll);

  // An answer that says nothing usable about the swap. Never definitive: polled again, until the window ends.
  const unclear = async (topup: Topup, ended: boolean, reason: string, details: Readonly<Record<string, unknown>> = {}): Promise<void> => {
    counts.unclear += 1;
    counted('unclear');
    logger.warn({ ...whereOf(topup), status: topup.status, reason, ...details, alert: true }, 'A top-up\'s status is unclear: it is polled again');
    if (ended)
      await endPolling(topup);
  };

  // Our key refused, or an answer in a shape we don't know: the config or 1Click changed. Polled again, and the run fails.
  const rejected = async (topup: Topup, ended: boolean, error: Pick<OneClickUnavailableError, 'reason' | 'status' | 'detail'>): Promise<void> => {
    counts.rejected += 1;
    counted('rejected');
    logger.error({
      ...whereOf(topup), reason: error.reason, status: error.status ?? null, detail: error.detail ?? null, alert: true,
    }, 'A top-up\'s status can\'t be read: 1Click refused our key or answered in a shape we don\'t know');
    if (ended)
      await endPolling(topup);
  };

  const pollError = async (topup: Topup, error: unknown, at: Date, ended: boolean): Promise<void> => {
    if (error instanceof OneClickNotFoundError) {
      if (at.getTime() - topup.createdAt.getTime() < notFoundGraceMs) {
        counted('not_found');
        logger.debug(whereOf(topup), '1Click doesn\'t know a new top-up\'s address yet: it is polled again');
        return;
      }
      await unclear(topup, ended, 'oneclick_not_found');
      return;
    }
    if (error instanceof OneClickRefusedError) {
      await unclear(topup, ended, 'oneclick_refused', { answerStatus: error.status, message: error.reason });
      return;
    }
    if (error instanceof OneClickUnavailableError && error.reason === 'invalid_answer' && error.detail === unknownStatusDetail) {
      await unclear(topup, ended, 'unknown_status');
      return;
    }
    if (error instanceof OneClickUnavailableError && (error.reason === 'auth_failed' || error.reason === 'invalid_answer')) {
      await rejected(topup, ended, error);
      return;
    }
    if (error instanceof OneClickUnavailableError) {
      // The claim already moved its next poll
      counts.unavailable += 1;
      counted('unavailable');
      firstUnavailable ??= error;
      if (ended)
        await endPolling(topup);
      return;
    }
    throw error;
  };

  const record = async (topup: Topup, to: PolledTopupStatus & TopupPollResult, poll: TopupPoll, next: Date): Promise<void> => {
    if (await topups.recordPoll(topup.id, topup.status, { to, poll, nextPollAt: next }))
      counted(to);
  };

  const expiredLine = (topup: Topup, final: boolean): void => {
    counts.expired += 1;
    logger.info({
      ...whereOf(topup), payBy: topup.payBy.toISOString(), addressExpiresAt: topup.addressExpiresAt?.toISOString() ?? null, final,
    }, 'A top-up expired');
  };

  // PENDING_DEPOSIT or KNOWN_DEPOSIT_TX: waiting, expired past the pay-by time, and expired for good
  // once the address is inactive, unless 1Click ever knew a deposit
  const wait = async (topup: Topup, answer: OneClickStatusResponse, poll: TopupPoll, next: Date, at: Date, ended: boolean): Promise<void> => {
    const inactive = topup.addressExpiresAt !== undefined && at.getTime() >= topup.addressExpiresAt.getTime();
    const depositKnown = answer.status === 'KNOWN_DEPOSIT_TX' || poll.depositedAmount !== undefined || (poll.originTxHashes?.length ?? 0) > 0 || rowKnowsDeposit(topup);
    if (inactive && !depositKnown) {
      if (!await topups.markExpired(topup.id, topup.status, poll))
        return;
      counted('expired');
      if (topup.status === 'expired')
        logger.debug(whereOf(topup), 'An expired top-up\'s address is inactive: it is no longer polled');
      else
        expiredLine(topup, true);
      return;
    }
    if (ended) {
      await endPolling(topup, poll);
      return;
    }
    if (!inactive && at.getTime() < topup.payBy.getTime()) {
      await record(topup, 'waiting', poll, next);
      return;
    }
    if (!await topups.recordPoll(topup.id, topup.status, { to: 'expired', poll, nextPollAt: next }))
      return;
    counted('expired');
    if (topup.status !== 'expired')
      expiredLine(topup, false);
  };

  // What an operator needs to return a refund by hand
  const refundFields = (topup: Topup, refunded: bigint | undefined, refundReason: string | undefined, refundTransaction: string | undefined) => ({
    topupId: topup.id,
    accountId: topup.accountId,
    refunded: refunded === undefined ? null : formatTokenAmount(refunded, topup.tokenDecimals),
    token: topup.tokenSymbol,
    network: topup.network,
    refundReason: clip(refundReason) ?? null,
    refundTransaction: refundTransaction ?? null,
    originTransactions: topup.originTxHashes,
    depositAddress: topup.depositAddress ?? null,
  });

  const credit = async (topup: Topup, answer: OneClickStatusResponse, poll: TopupPoll, depositAddress: string, ended: boolean): Promise<void> => {
    const quoteResponse = answer.raw['quoteResponse'];
    const quote = isRecord(quoteResponse) ? quoteResponse['quote'] : undefined;
    const request = isRecord(quoteResponse) ? quoteResponse['quoteRequest'] : undefined;
    if (!isRecord(quote) || !isRecord(request)) {
      // A changed format, not an answer about our quote
      await rejected(topup, ended, { reason: 'invalid_answer', status: undefined, detail: 'quoteResponse has no quote or quoteRequest' });
      return;
    }
    const asset = config.assets.find(candidate => candidate.name === topup.destinationAsset);
    const mismatch = mismatchOf(topup, answer, quote, request, asset);
    if (mismatch || !asset) {
      await review(topup, mismatch?.reason ?? 'unknown_destination_asset', { ...mismatch, correlationId: answer.correlationId }, poll);
      return;
    }
    const amountOut = BigInt(answer.swapDetails.amountOut!);
    const amount: MicroUsd = atomicToUsd(amountOut, { decimals: asset.decimals, rounding: 'floor' });
    if (amount <= 0n) {
      await review(topup, 'amount_out_below_a_micro_dollar', { amountOut: amountOut.toString(), correlationId: answer.correlationId }, poll);
      return;
    }
    const { refundedAmount, refundReason } = answer.swapDetails;
    // An excess 1Click returned to the refund account
    const refunded = refundedAmount === undefined || BigInt(refundedAmount) === 0n ? undefined : BigInt(refundedAmount);
    const delivery = answer.swapDetails.destinationChainTxHashes[0]?.hash;

    let credited: Topup | undefined;
    try {
      credited = await topups.markCredited({
        id: topup.id,
        from: topup.status,
        credit: { poll, creditedAmount: amount, deliveryTxHash: delivery, refundedAmount: refunded },
        book: tx => ledger(tx).topUp({ accountId: topup.accountId, asset: asset.name, amount, reference: depositAddress }),
      });
    }
    catch (error) {
      // The ledger booked another account, asset or amount under this deposit address: never a second credit
      if (!(error instanceof TopUpReferenceConflictError))
        throw error;
      await review(topup, 'ledger_reference_conflict', { amount: formatUsd(amount), correlationId: answer.correlationId }, poll);
      return;
    }
    // Another runner credited it, or flagged it
    if (!credited)
      return;
    counts.credited += 1;
    counted('credited');
    metrics.credited.inc();
    metrics.creditedUsd.inc(Number(formatUsd(amount)));
    logger.info({
      topupId: topup.id,
      accountId: topup.accountId,
      amount: formatUsd(amount),
      network: topup.network,
      token: topup.tokenSymbol,
      depositAddress,
      transaction: delivery ?? null,
      ...refunded === undefined ? {} : { refunded: formatTokenAmount(refunded, topup.tokenDecimals) },
    }, 'A top-up was credited');
    if (refunded !== undefined)
      logger.warn({
        ...refundFields(credited, refunded, refundReason, undefined),
        alert: true,
      }, 'A top-up\'s excess was refunded: return it by hand');
  };

  const refund = async (topup: Topup, answer: OneClickStatusResponse, poll: TopupPoll): Promise<void> => {
    const { refundedAmount, refundReason, destinationChainTxHashes } = answer.swapDetails;
    const refunded = refundedAmount === undefined ? undefined : BigInt(refundedAmount);
    const refundTransaction = destinationChainTxHashes[0]?.hash;
    const changed = await topups.markRefunded(topup.id, topup.status, { poll, refundedAmount: refunded, refundReason, refundTxHash: refundTransaction });
    if (!changed)
      return;
    counts.refunded += 1;
    counted('refunded');
    logger.warn({ ...refundFields(changed, refunded, refundReason, refundTransaction), alert: true }, 'A top-up was refunded: return it by hand');
  };

  const fail = async (topup: Topup, answer: OneClickStatusResponse, poll: TopupPoll): Promise<void> => {
    const changed = await topups.markFailed(topup.id, topup.status, { poll, reason: 'oneclick_failed' });
    if (!changed)
      return;
    counts.failed += 1;
    counted('failed');
    logger.error({
      ...whereOf(topup),
      correlationId: answer.correlationId,
      network: topup.network,
      token: topup.tokenSymbol,
      deposited: changed.depositedAmount === undefined ? null : formatTokenAmount(changed.depositedAmount, topup.tokenDecimals),
      originTransactions: changed.originTxHashes,
      alert: true,
    }, 'A top-up failed at 1Click');
  };

  const follow = async (listed: Topup): Promise<void> => {
    const at = clock.now();
    const next = nextPollAt(listed, at);
    // Of two runners that listed it, only the one that claims it asks 1Click
    const topup = await topups.claimPoll({ id: listed.id, seenUpdatedAt: listed.updatedAt, nextPollAt: next });
    if (!topup)
      return;
    const { depositAddress } = topup;
    // The database ties an address to every status that is polled
    if (depositAddress === undefined) {
      await review(topup, 'no_deposit_address');
      return;
    }
    counts.polled += 1;
    // Past it, any outcome that isn't definitive ends the polling
    const ended = at.getTime() >= pollingEndsAt(topup).getTime();

    let answer: OneClickStatusResponse;
    try {
      answer = await oneClick.status({ depositAddress, depositMemo: topup.depositMemo });
    }
    catch (error) {
      await pollError(topup, error, at, ended);
      return;
    }
    const details = answer.swapDetails;
    const poll: TopupPoll = {
      oneClickStatus: answer.status,
      lastStatus: answer.raw as JsonObject,
      polledAt: at,
      depositedAmount: details.depositedAmount === undefined ? undefined : BigInt(details.depositedAmount),
      originTxHashes: details.originChainTxHashes.map(transaction => transaction.hash),
    };

    switch (fromOneClickStatus(answer.status)) {
      case 'waiting':
        await wait(topup, answer, poll, next, at, ended);
        return;
      case 'incomplete':
      case 'processing':
        if (ended)
          await endPolling(topup, poll);
        else
          await record(topup, answer.status === 'PROCESSING' ? 'processing' : 'incomplete', poll, next);
        return;
      case 'success':
        await credit(topup, answer, poll, depositAddress, ended);
        return;
      case 'refunded':
        await refund(topup, answer, poll);
        return;
      case 'failed':
        await fail(topup, answer, poll);
        return;
    }
  };

  // Top-ups whose quote's outcome was never recorded. An address 1Click may have made was never given out.
  for (const topup of await topups.listStuckQuoting({ before: new Date(runAt.getTime() - stuckQuotingMs), limit: batchSize })) {
    try {
      if (!await topups.markQuoteUnknown(topup.id, 'stuck_quoting'))
        continue;
      counts.stuck += 1;
      logger.error({
        topupId: topup.id, accountId: topup.accountId, network: topup.network, token: topup.tokenSymbol, amount: formatTokenAmount(topup.amount, topup.tokenDecimals),
        createdAt: topup.createdAt.toISOString(), alert: true,
      }, 'A top-up was stuck asking for its quote');
    }
    catch (error) {
      counts.errors += 1;
      logger.error({ error, topupId: topup.id }, 'Failed to move a top-up stuck asking for its quote');
    }
  }

  // One at a time: each is a call to 1Click, and maybe a ledger transaction
  for (const listed of await topups.listDue({ now: runAt, limit: batchSize })) {
    try {
      await follow(listed);
    }
    catch (error) {
      // Such as the database, while recording what 1Click said
      counts.errors += 1;
      counted('error');
      logger.error({ error, topupId: listed.id }, 'Failed to act on a top-up\'s status');
    }
  }

  if (firstUnavailable)
    logger.warn({
      unavailable: counts.unavailable, reason: firstUnavailable.reason, status: firstUnavailable.status ?? null, detail: firstUnavailable.detail ?? null,
    }, '1Click didn\'t answer for some top-ups: they are polled again at their next time');
  if (counts.errors + counts.rejected > 0)
    throw new TopupStatusFailedError(counts);

  return counts;
};
