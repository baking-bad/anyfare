import { Challenge, Credential, Errors, Receipt as MppReceipt, Store } from 'mppx';
import { formatUnits, isAddressEqual, keccak256, TransactionReceiptNotFoundError, type Address, type Hex } from 'viem';
import { getTransactionReceipt } from 'viem/actions';
import { Transaction } from 'viem/tempo';

import { isRecord, usdToAtomic, withTimeout, type Clock, type Logger, type LogSink, type Secret } from '@anyfare/common';
import { InvalidPaymentStatusChangeError, type Payment } from '@anyfare/core';

import { detectMpp, type Credential as RailCredential } from '../credentials.js';
import { PaymentInvalidError, PaymentUnavailableError, SettlementFailedError } from '../errors.js';
import type { PaymentRecorder, SettlementLedger } from '../ports.js';
import type { Authorization, PaymentRail, Quote, Receipt } from '../rail.js';
import { errorReason, nodeHasTransaction, rpcFailure } from './rpc.js';
import { paymentReceiptHeader, toMppSettlementRequest, type MppSettlementRequest } from './settlement.js';
import type { MppAsset, MppServers, MppSetup } from './setup.js';

// Our claim on a credential's transaction while it is authorized, beside `mppx`'s own at broadcast
const authorizedKey = (hash: Hex): string => `authorized:${hash.toLowerCase()}`;
const reasonLength = 200;
// Private: a shared cache must not serve one buyer's paid answer to another
const privateCache = { 'cache-control': 'private' } as const;
// The shortest validity a transaction may have left when it is authorized: enough for the call and
// the broadcast after it. mppx's client signs for 25 seconds.
export const minTransactionWindowMs = 15_000;
// The longest: a transaction valid for longer holds its claim, and its money, open for longer
export const maxTransactionWindowMs = 10 * 60_000;

/**
 * A Tempo charge request for one asset: what the challenge offers and what a credential must match.
 * A type, not an interface, so `mppx` takes it as a record.
 */
export type MppChargeRequest = {
  readonly amount: string;
  readonly currency: Address;
  readonly decimals: number;
  readonly recipient: Address;
  readonly chainId: number;
  readonly supportedModes: readonly ['pull'];
};

/** What the MPP rail keeps between validating and broadcasting. */
export interface MppAuthorization extends Authorization {
  readonly rail: 'mpp';
  // Authorization: Payment …, until the broadcast or the abort
  readonly credential: Secret;
  readonly request: MppChargeRequest;
  // The canonical pay URL the challenge is bound to
  readonly scope: string;
  // The asset's registry name, such as `tempo-pathusd`, whose treasury books the payment
  readonly asset: string;
  readonly settlement: MppSettlementRequest;
  // The transaction's validBefore in milliseconds: after it, the transaction can never be included,
  // so the proxy keeps the target call under it
  readonly deadlineMs: number;
}

export interface MppRailOptions {
  readonly setup: MppSetup;
  readonly recorder: PaymentRecorder;
  readonly ledger: SettlementLedger;
  readonly logger: Logger;
  // Whether a transaction is valid now, and for how long
  readonly clock: Clock;
  // The broadcast's timeout, as settle's, and the receipt read's after a refused broadcast
  readonly settleTimeoutMs: number;
}

const mppOnly = (authorization: Authorization): MppAuthorization => {
  if (authorization.rail !== 'mpp' || !('credential' in authorization))
    throw new TypeError(`The MPP rail can't take a ${authorization.rail} authorization`);

  return authorization as MppAuthorization;
};

// mppx's own refusal, first line only: its details are the buyer's own payment
const reasonOf = (error: Errors.PaymentError): string => error.message.split('\n', 1)[0]!.slice(0, reasonLength);

const pullOnly = 'MPP payments here are signed transactions in pull mode. A transaction you broadcast yourself isn\'t accepted.';

// The validated payment's signed transaction, in pull mode only
const pulledTransaction = (validated: unknown): { readonly serialized: Hex; readonly sender: Address } => {
  const details = isRecord(validated) ? validated['details'] : undefined;
  if (!isRecord(details) || details['mode'] !== 'pull' || typeof details['serializedTransaction'] !== 'string' || typeof details['sender'] !== 'string')
    throw new PaymentInvalidError(pullOnly);

  return { serialized: details['serializedTransaction'] as Hex, sender: details['sender'] as Address };
};

const invalid = (message: string, reason: string): PaymentInvalidError => new PaymentInvalidError(message, { reason });

/**
 * The credential's signed transaction, checked before any RPC call: signed for our chain, valid now,
 * and valid long enough for the call and the broadcast, but not for longer than we hold a claim.
 * Returns its validBefore, in Unix seconds.
 */
const checkTransaction = (payload: unknown, chainId: number, nowMs: number): number => {
  if (!isRecord(payload) || payload['type'] !== 'transaction' || typeof payload['signature'] !== 'string')
    throw new PaymentInvalidError(pullOnly);
  let transaction: { readonly chainId?: number; readonly validAfter?: number; readonly validBefore?: number };
  try {
    transaction = Transaction.deserialize(payload['signature'] as Hex);
  }
  catch {
    throw new PaymentInvalidError('The MPP credential\'s transaction isn\'t a signed Tempo transaction');
  }

  const { validAfter, validBefore } = transaction;
  if (transaction.chainId !== chainId)
    throw invalid('The payment\'s transaction is signed for another chain. Request the resource again, and sign it for this one.', 'wrong_chain');
  if (validAfter !== undefined && validAfter * 1_000 > nowMs)
    throw invalid('The payment\'s transaction isn\'t valid yet. Sign it without validAfter, or with one that has passed.', 'not_yet_valid');
  if (typeof validBefore !== 'number')
    throw invalid('The payment\'s transaction must expire: sign it with validBefore, as mppx\'s client does', 'too_long');
  const windowMs = validBefore * 1_000 - nowMs;
  if (windowMs <= 0)
    throw invalid('The payment\'s transaction has expired. Request the resource again, and sign a new one.', 'too_short');
  if (windowMs < minTransactionWindowMs)
    throw invalid(`The payment's transaction expires too soon. Sign it valid for at least ${minTransactionWindowMs / 1_000} seconds.`, 'too_short');
  if (windowMs > maxTransactionWindowMs)
    throw invalid(`The payment's transaction is valid for too long. Sign it valid for at most ${maxTransactionWindowMs / 60_000} minutes.`, 'too_long');

  return validBefore;
};

// What a finalize that already ran answered, from the payment's row
const storedReceipt = (row: Payment): Receipt => ({
  headers: row.receipt === undefined ? { ...privateCache } : { [paymentReceiptHeader]: row.receipt, ...privateCache },
  settlement: { status: row.status === 'settled' ? 'settled' : 'settling', transaction: row.transactionHash },
});

/**
 * MPP: the Tempo charge in pull mode, charged after a billable answer like x402. The challenge offers
 * each Tempo asset at or above its minimum price, bound to the canonical pay URL, each from its own
 * `mppx` server. Authorize checks the signed transaction's chain and validity window, validates the
 * credential, which moves nothing, claims its transaction in the shared replay store, and records the
 * payment as `verified` with the transaction hash. The authorization's `deadlineMs` is the
 * transaction's validBefore: the proxy keeps the target call under it. Finalize records the payment
 * as `settling` with the hash, broadcasts, waits for the receipt, and books it. A broadcast that
 * certainly charged nothing is `failed`; any other stays `settling`, for the settlement follow-up to
 * read on chain. Abort cancels: the transaction is never broadcast. Finalize and abort read the
 * payment first, so running either twice moves money once.
 */
export const createMppRail = ({ setup, recorder, ledger, logger, clock, settleTimeoutMs }: MppRailOptions): PaymentRail => {
  const { network } = setup;
  const offered = (quote: Quote): readonly MppAsset[] => setup.assets.filter(asset => asset.minPrice <= quote.priceMicroUsd);
  const serversOf = (currency: Address): MppServers => {
    const servers = setup.servers.get(currency.toLowerCase());
    if (!servers)
      throw new Error(`MPP has no server for ${currency}`);

    return servers;
  };
  const chargeRequest = (asset: MppAsset, quote: Quote): MppChargeRequest => ({
    // Exact, and never below the price
    amount: formatUnits(usdToAtomic(quote.priceMicroUsd, { decimals: asset.decimals, rounding: 'ceil' }), asset.decimals),
    currency: asset.address,
    decimals: asset.decimals,
    recipient: setup.recipient,
    chainId: setup.chainId,
    supportedModes: ['pull'],
  });

  const validate = async (servers: MppServers, header: string, request: MppChargeRequest, scope: string, log: LogSink): Promise<unknown> => {
    try {
      return await servers.validator.validateCredential(header, { request, scope });
    }
    catch (error) {
      if (error instanceof Errors.PaymentError)
        throw new PaymentInvalidError(`The payment was refused: ${reasonOf(error)}`, { reason: reasonOf(error) });
      const failure = rpcFailure(error);
      // viem's short message only: its full message carries the signed transaction
      if (failure === 'unavailable' || failure === 'pending') {
        log.warn({ reason: errorReason(error), network }, 'The Tempo RPC didn\'t answer while an MPP payment was checked');
        throw new PaymentUnavailableError();
      }
      if (failure === 'refused')
        throw new PaymentInvalidError('The Tempo node refused the payment\'s transaction in simulation, such as for an insufficient balance', { reason: errorReason(error) });

      log.warn({ reason: errorReason(error), network }, 'An MPP credential failed its check');
      throw new PaymentInvalidError('The MPP credential isn\'t a valid payment for this call', { reason: errorReason(error) });
    }
  };

  // A claim that can't be released expires on its own: the buyer's retry waits for it
  const release = async (hash: Hex, log: LogSink): Promise<void> => {
    try {
      await setup.store.delete(authorizedKey(hash));
    }
    catch (error) {
      log.warn({ reason: errorReason(error), transaction: hash }, 'The MPP payment\'s claim couldn\'t be released. It expires on its own.');
    }
  };

  const authorize = async (header: string, quote: Quote): Promise<Omit<MppAuthorization, 'credential'>> => {
    const log = quote.log ?? logger;
    let credential;
    try {
      credential = Credential.deserialize(header);
    }
    catch {
      throw new PaymentInvalidError('Authorization: Payment isn\'t an MPP credential');
    }
    const { challenge } = credential;
    const currency = challenge.request['currency'];
    const asset = offered(quote).find(candidate => typeof currency === 'string' && isAddressEqual(candidate.address, currency as Address));
    if (!asset)
      throw new PaymentInvalidError('The payment doesn\'t match an option for this price. Request the resource again for the current options.');
    const validBefore = checkTransaction(credential.payload, setup.chainId, clock.now().getTime());

    const servers = serversOf(asset.address);
    const request = chargeRequest(asset, quote);
    const { serialized, sender } = pulledTransaction(await validate(servers, header, request, quote.resource, log));
    const transaction = Transaction.deserialize(serialized);
    // The hash of the canonical envelope, as the node derives it: known before the broadcast
    const transactionHash = keccak256(await Transaction.serialize(transaction as Parameters<typeof Transaction.serialize>[0]));

    // A credential works once, on every replica: claimed until both the challenge and the transaction expire
    const challengeExpires = Date.parse(challenge.expires ?? '');
    const claimUntil = Math.max(validBefore * 1_000, Number.isFinite(challengeExpires) ? challengeExpires : 0);
    let claimed: boolean;
    try {
      claimed = await Store.tryClaim(setup.store, authorizedKey(transactionHash), claimUntil);
    }
    catch (error) {
      log.error({ reason: errorReason(error) }, 'The MPP replay store failed');
      throw new PaymentUnavailableError();
    }
    if (!claimed)
      throw new PaymentInvalidError('This payment credential was already used. Request the resource again, and pay the new challenge.');

    const atomicAmount = usdToAtomic(quote.priceMicroUsd, { decimals: asset.decimals, rounding: 'ceil' });
    try {
      await recorder.create({
        id: quote.paymentId,
        requestId: quote.requestId,
        rail: 'mpp',
        buyerAccountId: undefined,
        keyId: undefined,
        targetHost: quote.subject.targetHost,
        targetPath: quote.subject.targetPath,
        network,
        asset: asset.name,
        atomicAmount,
        amount: quote.priceMicroUsd,
        status: 'verified',
        transactionHash,
      });
    }
    catch (error) {
      // Nothing was forwarded, so the same credential may try again
      await release(transactionHash, log);
      throw error;
    }

    return {
      rail: 'mpp',
      paymentId: quote.paymentId,
      amount: quote.priceMicroUsd,
      buyer: `address:${network}:${sender.toLowerCase()}`,
      receipt: undefined,
      network,
      ...quote.log ? { log: quote.log } : {},
      request,
      scope: quote.resource,
      asset: asset.name,
      deadlineMs: validBefore * 1_000,
      settlement: {
        rail: 'mpp',
        transactionHash,
        validBefore,
        currency: asset.address,
        sender,
        recipient: setup.recipient,
        amount: atomicAmount.toString(),
      },
    };
  };

  /**
   * What a failed broadcast did. `failed` only when nothing can have been charged: the transaction was
   * included and reverted, or its receipt can't be found after a refusal. A refusal alone proves
   * nothing: mppx refuses a payment whose receipt it can't match, and a node refuses a transaction the
   * buyer broadcast itself, so its receipt is read once. A node that says it already holds the
   * transaction, or that its nonce is used, may still include it, so that refusal is `unknown` even
   * without a receipt: the follow-up fails it once its validity window and the grace have passed. A
   * timeout, an RPC or replay store failure, or a receipt that can't be read is `unknown` too: the
   * settlement follow-up reads the receipt.
   */
  const broadcastOutcome = async (error: unknown, hash: Hex): Promise<'failed' | 'unknown'> => {
    if (error instanceof Error && error.message.startsWith('Transaction reverted'))
      return 'failed';
    if (!(error instanceof Errors.PaymentError) && rpcFailure(error) !== 'refused')
      return 'unknown';
    try {
      await withTimeout(() => getTransactionReceipt(setup.rpc.client(settleTimeoutMs), { hash }), { timeoutMs: settleTimeoutMs });

      return 'unknown';
    }
    catch (readError) {
      return readError instanceof TransactionReceiptNotFoundError && !nodeHasTransaction(error) ? 'failed' : 'unknown';
    }
  };

  // What a finalize that already ran answered, from the payment's row. Undefined unless it is settled
  // or settling.
  const answered = (row: Payment | undefined, transaction: Hex): Receipt | undefined => {
    if (row?.status === 'settled' || (row?.status === 'settling' && row.receipt !== undefined))
      return storedReceipt(row);
    // Settling without a receipt: another finalize is broadcasting, or one stopped during its
    // broadcast. The outcome is unknown, and the settlement follow-up reads the receipt.
    if (row?.status === 'settling')
      throw new SettlementFailedError({ outcome: 'unknown', transaction: row.transactionHash ?? transaction, network });

    return undefined;
  };

  const broadcastAndBook = async ({ paymentId, credential, request, scope, asset, settlement, log = logger }: MppAuthorization): Promise<Receipt> => {
    const { transactionHash: transaction } = settlement;
    const settlementRequest = toMppSettlementRequest(settlement);

    // A finalize that already ran: its receipt, without broadcasting again
    const row = await recorder.find(paymentId);
    const before = answered(row, transaction);
    if (before)
      return before;
    if (row?.status !== 'verified')
      throw new InvalidPaymentStatusChangeError(paymentId, row?.status, 'settled');

    // Before the broadcast, so a crash or a deploy during it leaves the payment where the settlement
    // follow-up finds it, with the hash to read the receipt by. Only from verified: of two finalizes
    // that read it verified, one broadcasts, and the other answers what the row says.
    try {
      await recorder.changeStatus({ paymentId, to: 'settling', from: 'verified', transactionHash: transaction, settlementRequest });
    }
    catch (error) {
      if (!(error instanceof InvalidPaymentStatusChangeError))
        throw error;
      const after = answered(await recorder.find(paymentId), transaction);
      if (after)
        return after;
      throw error;
    }
    let header: string;
    try {
      header = credential.expose();
    }
    catch (error) {
      // Given up meanwhile, such as by an abort, so never broadcast here. The follow-up reads the receipt.
      throw new SettlementFailedError({ outcome: 'unknown', transaction, network, cause: error });
    }

    let paid: MppReceipt.Receipt;
    try {
      paid = await withTimeout(
        () => serversOf(settlement.currency).broadcaster.broadcastCredential(header, { request, scope }),
        { timeoutMs: settleTimeoutMs },
      );
    }
    catch (error) {
      const reason = errorReason(error);
      const outcome = await broadcastOutcome(error, transaction);
      if (outcome === 'failed') {
        log.warn({ paymentId, reason, transaction, network }, 'The MPP payment was refused or reverted. Nothing was charged.');
        try {
          await recorder.changeStatus({ paymentId, to: 'failed', settlementRequest: null });
        }
        catch (recordError) {
          log.error({ error: recordError, paymentId, transaction, network }, 'The failed MPP payment couldn\'t be recorded as failed. The settlement follow-up finds it settling.');
        }
      }
      else
        log.warn({ paymentId, reason, transaction, network }, 'The MPP broadcast\'s outcome is unknown. The settlement follow-up reads its receipt.');
      throw new SettlementFailedError({ outcome, reason, transaction, network, cause: error });
    }

    const receipt = MppReceipt.serialize(paid);
    const reference = paid.reference;
    try {
      await ledger.settle({ paymentId, asset, transactionHash: reference, receipt, needsReview: false });
    }
    catch (error) {
      // The buyer paid on chain, and the booking failed. The settlement follow-up reads the receipt
      // on chain and books it.
      log.error({ error, paymentId, transaction: reference, network }, 'The MPP payment settled, but its booking failed. The settlement follow-up books it.');
      try {
        await recorder.changeStatus({
          paymentId,
          to: 'settling',
          transactionHash: reference,
          receipt,
          // The buyer paid and got no response
          needsReview: true,
          settlementRequest,
        });
      }
      catch (recordError) {
        log.error({ error: recordError, paymentId, transaction: reference, network }, 'The settled MPP payment couldn\'t be recorded for review. It needs review.');
      }
      throw new SettlementFailedError({ outcome: 'unknown', reason: 'booking_failed', transaction: reference, network, cause: error });
    }

    return { headers: { [paymentReceiptHeader]: receipt, ...privateCache }, settlement: { status: 'settled', transaction: reference } };
  };

  return {
    name: 'mpp',
    settlesBeforeResponse: true,
    detect: detectMpp,
    challenge: async quote => {
      const assets = offered(quote);
      if (assets.length === 0)
        return undefined;

      const challenges = await Promise.all(assets.map(asset => serversOf(asset.address).validator.challenge.tempo.charge({
        ...chargeRequest(asset, quote),
        description: quote.description,
        scope: quote.resource,
      })));

      return { headers: { 'www-authenticate': challenges.map(challenge => Challenge.serialize(challenge)).join(', ') } };
    },
    authorize: async (credential: RailCredential, quote) => {
      if (credential.rail !== 'mpp')
        throw new TypeError(`The MPP rail can't take a ${credential.rail} credential`);
      try {
        const authorization: MppAuthorization = { ...await authorize(credential.header.expose(), quote), credential: credential.header };

        return authorization;
      }
      catch (error) {
        credential.header.destroy();
        throw error;
      }
    },
    finalize: async authorization => {
      const mpp = mppOnly(authorization);
      try {
        return await broadcastAndBook(mpp);
      }
      finally {
        // Broadcast or not, never again
        mpp.credential.destroy();
      }
    },
    abort: async authorization => {
      const { paymentId, credential } = mppOnly(authorization);
      // Never broadcast after an abort
      credential.destroy();
      const row = await recorder.find(paymentId);
      // An abort that already ran, or a broadcast that failed: nothing to give back
      if (row?.status === 'cancelled' || row?.status === 'failed')
        return;
      if (row?.status === 'settled' || row?.status === 'settling')
        throw new Error(`The payment ${paymentId} is ${row.status}: it can't be cancelled after its settlement`);

      await recorder.changeStatus({ paymentId, to: 'cancelled' });
    },
  };
};
