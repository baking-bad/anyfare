import type { ClientSvmSigner } from '@x402/svm';
import type { LocalAccount } from 'viem';

import { AnyfareError, atomicToUsd, formatUsd, type Clock, type IdGenerator, type LogSink, type MicroUsd } from '@anyfare/common';
import type { Asset, PlatformConfig, RebalancingTarget } from '@anyfare/core';
import { RedisNotReadyError } from '@anyfare/db';
import {
  AmbiguousTokenError, OneClickRefusedError, OneClickUnavailableError, UnknownTokenError, type OneClickClient, type OneClickDepositQuoteResponse,
  type OneClickQuoteRequest, type OneClickToken, type TokenCatalog,
} from '@anyfare/topups';

import { NearRpcError, NearStoreError, type NearLease, type NearPayerStore, type NearWallet } from './near.js';
import type { NearTransfer, NearTransferOutcome } from './nearTransfer.js';
import { checkRefillQuote, refillAtomicAmount } from './refillQuote.js';
import type { RefillAnswer, RefillStore, RefillUnknown } from './refillStore.js';
import { PayerBusyError, SigningFailedError, SigningRefusedError, type SigningRefusal } from './sign.js';
import type { SpendEntry, SpendLimits } from './spend.js';

/** Rebalancing is off, or the Signer can't refill this asset: no wallet, no 1Click client, or no token for it. Nothing stays reserved. */
export class RefillsOffError extends AnyfareError {
  readonly code = 'refills_off';
}

/** The asset isn't a target of rebalancing. */
export class UnknownRefillAssetError extends AnyfareError {
  readonly code = 'invalid_request';
}

/** Another ask with this refill ID is in progress, or one of them left its outcome unrecorded. Nothing was done. */
export class RefillInProgressError extends AnyfareError {
  readonly code = 'refill_in_progress';
}

/** The refill ID already has an outcome for another asset or amount. Nothing was done. */
export class RefillIdConflictError extends AnyfareError {
  readonly code = 'refill_id_conflict';
}

/** 1Click refused the quote or didn't answer. Nothing was sent, and nothing stays reserved. */
export class RefillQuoteUnavailableError extends AnyfareError {
  readonly code = 'oneclick_unavailable';
}

/** `POST /internal/v1/refills`: deliver `amount` to the Signer's own wallet that holds `asset`. */
export interface RefillRequest {
  // The workers' ID for this refill: one transfer at most per ID
  readonly refillId: string;
  // A rebalancing target's asset name
  readonly asset: string;
  // What the target wallet must receive
  readonly amount: MicroUsd;
}

/** What a refill came to. A replay answers the outcome kept under its ID, and sends nothing. */
export type RefillResult =
  | { readonly kind: 'sent'; readonly answer: RefillAnswer; readonly replay: boolean }
  // Nothing moved, nothing stays reserved, and the ID may be asked again
  | { readonly kind: 'failed'; readonly transactionHash: string; readonly message: string }
  // The source asset may have moved: the reservation stays, and the ID answers this from now on
  | { readonly kind: 'unknown'; readonly body: RefillUnknown; readonly replay: boolean };

export interface Refiller {
  /**
   * Refills, or throws a refusal: RefillsOffError, UnknownRefillAssetError, RefillInProgressError,
   * RefillIdConflictError, SigningRefusedError, PayerBusyError, RefillQuoteUnavailableError,
   * SigningFailedError, or RedisNotReadyError. A refusal leaves nothing reserved or pending.
   */
  refill(request: RefillRequest, log: LogSink): Promise<RefillResult>;
}

export interface RefillerOptions {
  readonly config: PlatformConfig;
  // The Signer's wallets: the NEAR hot wallet pays, and each target's wallet receives
  readonly wallets: { readonly base?: Pick<LocalAccount, 'address'>; readonly solana?: Pick<ClientSvmSigner, 'address'>; readonly near?: NearWallet };
  // Transfers from the NEAR hot wallet. Undefined without one.
  readonly transfer: NearTransfer | undefined;
  // 1Click, and its token list. Undefined: every refill is refused.
  readonly oneClick: Pick<OneClickClient, 'quote'> | undefined;
  readonly tokens: Pick<TokenCatalog, 'resolve'> | undefined;
  // The day's refills per target asset
  readonly spend: SpendLimits;
  readonly store: RefillStore;
  // The NEAR hot wallet's lease, shared with its x402 payments
  readonly nearStore: Pick<NearPayerStore, 'takeLease' | 'releaseLease'>;
  // How long a refill holds the lease: past its transaction's send and lookups
  readonly leaseMs: number;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  // The amount of each refill that went through, for the metrics
  readonly onRefilled?: (refill: { readonly asset: string; readonly amount: MicroUsd }) => void;
}

/**
 * How long a refill holds the NEAR payer's lease, in ms: its transfer's reads (two rounds, each read
 * tried twice), its send, its lookups and the last lookup or resend that may run past them, plus a
 * minute, and at least 2 minutes. With the default timeouts: 125 s.
 */
export const refillLeaseMs = ({ readMs, sendMs, pollBudgetMs }: { readonly readMs: number; readonly sendMs: number; readonly pollBudgetMs: number }): number =>
  Math.max(120_000, 5 * readMs + 2 * sendMs + pollBudgetMs + 60_000);

/**
 * The quote ID a refill holds the NEAR payer's lease under. Its colon is outside the pattern of the
 * proxy's quote IDs, so `POST /internal/v1/quotes/:quoteId/release` can never free a refill's lease.
 */
export const refillLeaseQuoteId = (refillId: string): string => `refill:${refillId}`;

const refuse = (message: string, reason: SigningRefusal): never => {
  throw new SigningRefusedError(message, reason);
};

// The same address: an EVM one in any letter case
const sameAddress = (asset: Asset, left: string, right: string): boolean =>
  asset.network.namespace === 'eip155' ? left.toLowerCase() === right.toLowerCase() : left === right;

// What a refill needs before anything is reserved
interface Prerequisites {
  readonly target: RebalancingTarget;
  readonly source: Asset;
  readonly near: NearWallet;
  readonly transfer: NearTransfer;
  // The Signer's own wallet on the target's chain
  readonly recipient: string;
  readonly oneClick: Pick<OneClickClient, 'quote'>;
  readonly tokens: Pick<TokenCatalog, 'resolve'>;
}

/**
 * Refills the Signer's hot wallets on Base and Solana from its NEAR hot wallet, through 1Click. It asks
 * for the quote itself, so a caller can only refill our own wallets, within the limits: the recipient
 * is the Signer's wallet on the target's chain, and refunds go back to the NEAR hot wallet. In order:
 * the asset and the wallets; the ID's replay record; the amount and the day's reservation per target
 * asset; a real EXACT_OUTPUT quote and its check; the hot wallet's balance; the payer's lease; one
 * transaction; its outcome. Only the transaction's outcome leaves anything behind.
 */
export const createRefiller = ({
  config, wallets, transfer, oneClick, tokens, spend, store, nearStore, leaseMs, clock, ids, onRefilled,
}: RefillerOptions): Refiller => {
  const { rebalancing } = config;
  const targetNames = rebalancing.targets.map(target => target.asset.name).join(', ');

  // 1. The checks that need nothing reserved
  const prerequisitesOf = (asset: string): Prerequisites => {
    if (!rebalancing.enabled)
      throw new RefillsOffError('Rebalancing is off: rebalancing.enabled is false');
    const target = rebalancing.targets.find(item => item.asset.name === asset);
    if (!target)
      throw new UnknownRefillAssetError(`The asset isn't a rebalancing target. Targets: ${targetNames}`);
    const { source } = rebalancing;
    if (!source)
      throw new RefillsOffError('rebalancing.source is not set');
    const near = wallets.near;
    if (!near || !transfer)
      throw new RefillsOffError('The Signer holds no NEAR wallet, which pays refills');
    if (config.signer.wallets.near !== near.accountId)
      throw new RefillsOffError('The Signer\'s NEAR wallet isn\'t signer.wallets.near');
    const { network } = target.asset;
    const chain = network.chain === 'base' || network.chain === 'solana' ? network.chain : undefined;
    const recipient = chain && config.signer.wallets[chain];
    const held = chain === 'base' ? wallets.base?.address : chain === 'solana' ? wallets.solana?.address : undefined;
    if (recipient === undefined || held === undefined)
      throw new RefillsOffError(`The Signer holds no wallet on ${network.title}, which a refill of ${asset} goes to`);
    if (!sameAddress(target.asset, recipient, held))
      throw new RefillsOffError(`The Signer's wallet on ${network.title} isn't signer.wallets.${chain}`);
    if (!oneClick || !tokens)
      throw new RefillsOffError('The Signer has no 1Click client');

    return { target, source, near, transfer, recipient, oneClick, tokens };
  };

  // 1Click's token for a registry asset, by its contract or mint on 1Click's network, with the registry's
  // decimals: amounts are read by the registry's
  const assetIdOf = async (resolver: Pick<TokenCatalog, 'resolve'>, asset: Asset, blockchain: string): Promise<OneClickToken> => {
    let token: OneClickToken;
    try {
      token = await resolver.resolve({ blockchain, token: asset.address });
    }
    catch (error) {
      if (error instanceof UnknownTokenError || error instanceof AmbiguousTokenError)
        throw new RefillsOffError(`1Click's token list has no single token for ${asset.name} on ${blockchain}`);
      if (error instanceof OneClickUnavailableError)
        throw new RefillQuoteUnavailableError(error.message);
      throw error;
    }
    if (token.decimals !== asset.decimals)
      throw new RefillsOffError(`1Click lists ${asset.name} on ${blockchain} with ${token.decimals} decimals, and the registry with ${asset.decimals}`);

    return token;
  };

  // What a deposit address must never be: our own accounts, and the source token's contract
  const ours = [
    ...rebalancing.source ? [rebalancing.source.address] : [],
    ...Object.values(config.signer.wallets).filter(wallet => wallet !== undefined),
    ...[config.topups.recipient, config.topups.refundTo].filter(account => account !== undefined),
    ...config.assets.map(asset => asset.payTo).filter(payTo => payTo !== undefined),
  ];

  // A reservation goes back. If it can't, the day counts more than left the hot wallet, never less.
  const giveBack = async (reservation: SpendEntry, log: LogSink): Promise<void> => {
    try {
      await spend.release(reservation);
    }
    catch (error) {
      log.error({ asset: reservation.network, amount: formatUsd(reservation.amount), error }, 'The Signer couldn\'t give back a refill\'s reservation');
    }
  };

  // The pending marker goes, so the ID may be asked again. If it can't, the ID stays in progress: safe.
  const abandon = async (refillId: string, marker: string, log: LogSink): Promise<void> => {
    try {
      await store.abandon(refillId, marker);
    }
    catch (error) {
      log.error({ refillId, error }, 'The Signer couldn\'t delete a refill\'s pending marker: the ID stays in progress');
    }
  };

  // The lease goes, only while this refill holds it. If it can't, it expires on its own.
  const freeLease = async (lease: NearLease, log: LogSink): Promise<void> => {
    try {
      await nearStore.releaseLease(lease);
    }
    catch (error) {
      log.error({ quoteId: lease.quoteId, error }, 'The Signer couldn\'t release the NEAR payer\'s lease after a refill: it expires on its own');
    }
  };

  // A chain read failed before anything was sent
  const fromChain = async <TResult>(read: () => Promise<TResult>, log: LogSink): Promise<TResult> => {
    try {
      return await read();
    }
    catch (error) {
      if (error instanceof NearStoreError) {
        log.error({ error }, 'The Signer\'s Redis failed on the NEAR nonce: no refill was sent');
        throw error.cause instanceof RedisNotReadyError ? error.cause : new RedisNotReadyError();
      }
      if (error instanceof NearRpcError)
        throw new SigningFailedError('NEAR', error.message);
      throw error;
    }
  };

  // One line for each refusal, as the sign route writes them
  const logRefusal = (error: unknown, fields: Readonly<Record<string, unknown>>, log: LogSink): void => {
    if (error instanceof SigningRefusedError) {
      const line = { ...fields, result: 'refused', reason: error.reason, message: error.message, ...error.spend };
      // The hot wallet is short: an operator moves money to it from the NEAR treasury by hand
      if (error.reason === 'source_low')
        log.warn({ ...line, alert: true }, 'Refused a refill');
      else
        log.info(line, 'Refused a refill');
    }
    else if (error instanceof PayerBusyError || error instanceof RefillInProgressError)
      log.info({ ...fields, result: 'busy', reason: error.code, message: error.message }, 'Refused a refill');
    else if (error instanceof UnknownRefillAssetError || error instanceof RefillIdConflictError)
      log.info({ ...fields, result: 'refused', reason: error.code, message: error.message }, 'Refused a refill');
    else if (error instanceof RefillsOffError || error instanceof RefillQuoteUnavailableError)
      log.warn({ ...fields, result: 'refused', reason: error.code, message: error.message }, 'Refused a refill');
    else if (error instanceof SigningFailedError)
      log.warn({ ...fields, result: 'refused', reason: error.code, message: error.reason }, 'Refused a refill');
  };

  const refill = async ({ refillId, asset, amount }: RefillRequest, log: LogSink): Promise<RefillResult> => {
    const started = performance.now();
    const fields = { refillId, asset, amount: formatUsd(amount) };
    const durationMs = () => Math.round(performance.now() - started);
    let needs: Prerequisites;
    try {
      needs = prerequisitesOf(asset);
    }
    catch (error) {
      logRefusal(error, { ...fields, durationMs: durationMs() }, log);
      throw error;
    }
    const { target, source, near, recipient } = needs;

    // 2. The ID's record: an outcome is answered again, and a refill in progress is left alone
    const marker = ids.next();
    const held = await store.claim(refillId, marker);
    const asked = held?.state === 'sent' ? held.answer : held?.state === 'unknown' ? held : undefined;
    if (asked && (asked.asset !== asset || asked.amount !== amount.toString())) {
      const error = new RefillIdConflictError('This refill ID was asked for another asset or amount');
      logRefusal(error, { ...fields, durationMs: durationMs() }, log);
      throw error;
    }
    if (held?.state === 'sent') {
      log.info({ ...fields, result: 'replayed', outcome: 'sent', transactionHash: held.answer.transactionHash, durationMs: durationMs() }, 'Answered a refill again');

      return { kind: 'sent', answer: held.answer, replay: true };
    }
    if (held?.state === 'unknown') {
      log.info({ ...fields, result: 'replayed', outcome: 'unknown', transactionHash: held.body.transactionHash, durationMs: durationMs() }, 'Answered a refill again');

      return { kind: 'unknown', body: held.body, replay: true };
    }
    if (held) {
      const error = new RefillInProgressError('A refill with this ID is in progress: ask again later');
      logRefusal(error, { ...fields, durationMs: durationMs() }, log);
      throw error;
    }

    let reservation: SpendEntry | undefined;
    // Before the transaction is sent, every refusal leaves nothing reserved or pending
    const undo = async () => {
      if (reservation)
        await giveBack(reservation, log);
      await abandon(refillId, marker, log);
    };
    let answer: OneClickDepositQuoteResponse;
    let outcome: NearTransferOutcome;
    let amountIn: bigint;
    let amountOut: bigint;
    // When 1Click starts to refund a swap that hasn't finished: the deadline we ask for
    let payBy: string;
    try {
      // 3. The amount, then its reservation against the day's cap for the asset, by Redis's clock
      if (amount < rebalancing.leastPerRefill || amount > rebalancing.mostPerRefill)
        refuse(`A refill is from ${formatUsd(rebalancing.leastPerRefill)} to ${formatUsd(rebalancing.mostPerRefill)} USD`, 'refill_amount');
      const reserved = await spend.reserve({ network: asset, amount });
      if (reserved.refusal) {
        throw new SigningRefusedError('The day\'s refills of this asset would pass rebalancing.mostPerAssetPerDay', 'daily_limit', {
          window: 'day', spent: formatUsd(reserved.day), limit: formatUsd(rebalancing.mostPerAssetPerDay),
        });
      }
      reservation = { network: asset, amount, windows: reserved.windows };

      // 4. A real quote: exactly the amount, delivered to our own wallet, refunded to the NEAR hot wallet
      const [origin, destination] = await Promise.all([assetIdOf(needs.tokens, source, 'near'), assetIdOf(needs.tokens, target.asset, target.blockchain)]);
      const atomicAmount = refillAtomicAmount(amount, target.asset.decimals);
      payBy = new Date(clock.now().getTime() + rebalancing.deadlineMinutes * 60_000).toISOString();
      const request: OneClickQuoteRequest & { readonly dry: false } = {
        dry: false,
        swapType: 'EXACT_OUTPUT',
        slippageTolerance: rebalancing.slippageBps,
        originAsset: origin.assetId,
        depositType: 'ORIGIN_CHAIN',
        destinationAsset: destination.assetId,
        amount: atomicAmount.toString(),
        refundTo: near.accountId,
        refundType: 'ORIGIN_CHAIN',
        recipient,
        recipientType: 'DESTINATION_CHAIN',
        deadline: payBy,
        depositMode: 'SIMPLE',
      };
      try {
        answer = await needs.oneClick.quote(request);
      }
      catch (error) {
        // The client's short message only: never 1Click's body
        if (error instanceof OneClickRefusedError || error instanceof OneClickUnavailableError)
          throw new RefillQuoteUnavailableError(error.message);
        throw error;
      }

      // 5. The quote's check. Then what leaves the hot wallet beyond the amount counts toward the day too.
      const rejection = checkRefillQuote(answer, {
        amount, atomicAmount, sourceDecimals: source.decimals, targetDecimals: target.asset.decimals, maxFeeBps: rebalancing.maxFeeBps, request, ours,
        now: clock.now(),
      });
      if (rejection !== undefined)
        refuse(rejection, 'quote_rejected');
      amountIn = BigInt(answer.quote.amountIn);
      amountOut = BigInt(answer.quote.amountOut);
      const beyond = atomicToUsd(amountIn, { decimals: source.decimals, rounding: 'ceil' }) - amount;
      if (beyond > 0n) {
        await spend.add({ ...reservation, amount: beyond });
        reservation = { ...reservation, amount: reservation.amount + beyond };
      }

      // 6. The hot wallet holds amountIn, and keeps rebalancing.sourceFloor for what it pays itself
      const balance = await fromChain(() => needs.transfer.balanceOf(source.address, near.accountId), log);
      if (balance < amountIn)
        refuse(`The NEAR hot wallet holds less ${source.name} than the quote's amountIn: move some from the NEAR treasury to it`, 'source_low');
      if (balance - amountIn < refillAtomicAmount(rebalancing.sourceFloor, source.decimals)) {
        refuse(`The refill would leave the NEAR hot wallet under rebalancing.sourceFloor, ${formatUsd(rebalancing.sourceFloor)} USD of ${source.name}: `
          + 'move some from the NEAR treasury to it', 'source_low');
      }

      // 7. The payer's lease: the transaction uses the key's nonce, as the hot wallet's x402 payments do
      const lease: NearLease = { accountId: near.accountId, quoteId: refillLeaseQuoteId(refillId) };
      let taken;
      try {
        taken = await nearStore.takeLease(lease, leaseMs);
      }
      catch (error) {
        // Redis may have set the lease before its reply was lost
        await freeLease(lease, log);
        throw error;
      }
      if (taken !== 'taken')
        throw new PayerBusyError();

      // 8 and 9. One transaction, and its outcome. Then the lease goes, whatever came of it.
      try {
        outcome = await fromChain(() => needs.transfer.transfer({ token: source.address, receiverId: answer.quote.depositAddress, amount: amountIn }), log);
      }
      finally {
        await freeLease(lease, log);
      }
    }
    catch (error) {
      await undo();
      logRefusal(error, { ...fields, durationMs: durationMs() }, log);
      throw error;
    }

    const facts = {
      depositAddress: answer.quote.depositAddress, amountIn: amountIn.toString(), amountOut: amountOut.toString(), quoteDeadline: payBy,
      correlationId: answer.correlationId,
    };
    // 1Click's cost in USD, for the line
    const fee = atomicToUsd(amountIn, { decimals: source.decimals, rounding: 'ceil' }) - atomicToUsd(amountOut, { decimals: target.asset.decimals, rounding: 'floor' });
    const line = {
      ...fields, ...facts, fee: formatUsd(fee), transactionHash: outcome.transactionHash, nonce: outcome.nonce.toString(), registers: outcome.registers,
    };
    // The outcome under the ID. If it can't be kept, the ID stays in progress: nothing is sent twice.
    const keep = async (record: Parameters<RefillStore['settle']>[1]): Promise<void> => {
      try {
        await store.settle(refillId, record);
      }
      catch (error) {
        log.error({ refillId, transactionHash: outcome.transactionHash, error, alert: true }, 'The Signer couldn\'t keep a refill\'s outcome: its ID stays in progress');
      }
    };

    // 10. The answer
    if (outcome.kind === 'sent') {
      const body: RefillAnswer = { refillId, asset, amount: amount.toString(), ...facts, transactionHash: outcome.transactionHash, quote: answer.raw };
      await keep({ state: 'sent', answer: body });
      onRefilled?.({ asset, amount });
      log.info({ ...line, result: 'sent', durationMs: durationMs() }, 'Refilled a hot wallet');

      return { kind: 'sent', answer: body, replay: false };
    }
    if (outcome.kind === 'failed') {
      await undo();
      log.warn({ ...line, result: 'failed', reason: outcome.reason, durationMs: durationMs() }, 'A refill\'s transaction failed: nothing moved');

      return { kind: 'failed', transactionHash: outcome.transactionHash, message: `The refill's transaction failed, and nothing moved: ${outcome.reason}` };
    }
    const body: RefillUnknown = { outcome: 'unknown', transactionHash: outcome.transactionHash, ...facts };
    await keep({ state: 'unknown', asset, amount: amount.toString(), body });
    log.error({ ...line, result: 'unknown', reason: outcome.reason, alert: true, durationMs: durationMs() },
      'A refill\'s outcome is unknown: the source asset may have moved. Follow 1Click\'s status for the deposit address');

    return { kind: 'unknown', body, replay: false };
  };

  return { refill };
};
