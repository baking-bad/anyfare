import { createHash } from 'node:crypto';

import { encodeSignedDelegate, SCHEMA, type SignedDelegate } from '@near-js/transactions';
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from '@x402/core/http';
import type { Network, PaymentPayload, PaymentRequired, PaymentRequirements, SettleResponse } from '@x402/core/types';
import { deserialize } from 'borsh';

import { isRecord, usdToAtomic, type Clock, type LogSink, type Logger } from '@anyfare/common';
import { InvalidPaymentStatusChangeError, type JsonObject, type Payment } from '@anyfare/core';

import { detectX402, type Credential } from '../credentials.js';
import { PaymentInvalidError, SettlementFailedError, type SettlementFailure } from '../errors.js';
import type { ClaimStore, PaymentRecorder, SettlementLedger } from '../ports.js';
import type { Authorization, PaymentRail, Quote, Receipt } from '../rail.js';
import type { X402Setup } from './setup.js';

// The header that carries the settle response to the buyer
export const paymentResponseHeader = 'payment-response';
// The x402 pending answer: broadcast, not final yet
export const settlementPending = 'settlement_pending';
const reasonPattern = /^[a-z0-9_]{1,64}$/;
// How long a payment's claim outlives its own deadline, and the longest it is held
const claimGraceMs = 60_000;
const maxClaimMs = 7 * 24 * 60 * 60_000;
const base64Pattern = /^[A-Za-z0-9+/]+=*$/;
// The shortest time a payment may have left to settle when it is authorized: enough for the call
// and the settle after it
export const minPaymentWindowMs = 15_000;
// How long a Solana payment can settle: its transaction's blockhash expires after about 150 blocks
const solanaWindowMs = 60_000;

// The SDK counts a NEAR payment's window of N seconds as N blocks, and a block takes about 0.6 s. We
// count half a second a block, to stay on the early side: our deadline is never later than the chain's.
// The window is measured from when we verify, not from when the buyer signed.
const nearMsPerBlock = 500;

// The transfer method each namespace's `exact` scheme uses when a quote names none
const defaultTransferMethods: Readonly<Record<string, string>> = { eip155: 'eip3009' };

/**
 * Whether a payment uses the transfer method its quote does. The SDK matches a paid quote that
 * merely contains ours, so one that adds `assetTransferMethod: "permit2"` on EVM would otherwise pass.
 */
const sameTransferMethod = (requirements: PaymentRequirements, payload: PaymentPayload): boolean => {
  const paid = payload.accepted.extra?.['assetTransferMethod'];
  const quoted = requirements.extra['assetTransferMethod'] ?? defaultTransferMethods[requirements.network.split(':')[0]!];

  return paid === undefined || paid === quoted;
};

/**
 * Whether an EVM payment is signed for a transfer method its option doesn't offer. The facilitator
 * picks the method from the payload's shape, not from the option, so a Permit2 payload is refused
 * unless the option is Permit2.
 */
const otherTransferMethod = (requirements: PaymentRequirements, payload: PaymentPayload): boolean =>
  requirements.network.startsWith('eip155:') && payload.payload['permit2Authorization'] !== undefined && requirements.extra['assetTransferMethod'] !== 'permit2';

/** Whole seconds, as a decimal string or a number. Undefined when it isn't a non-negative integer. */
const secondsOf = (value: unknown): bigint | undefined => {
  if (typeof value === 'string' && /^[0-9]+$/.test(value))
    return BigInt(value);

  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : undefined;
};

/**
 * A NEAR payment's signed delegate action in its canonical bytes, with its sender. Borsh reads a
 * signed delegate action from the front of its bytes and ignores what follows, so the same action
 * with a byte appended would be another payment to the claim and to the facilitator's settlement key,
 * while the chain runs it once. Such a payload is refused: the bytes must be exactly the action's
 * encoding. Undefined when it isn't base64 of a signed delegate action and nothing more.
 */
const canonicalNearDelegate = (signed: unknown): { readonly bytes: Uint8Array; readonly senderId: string } | undefined => {
  const text = typeof signed === 'string' ? signed.trim() : '';
  if (!base64Pattern.test(text))
    return undefined;
  const bytes = Buffer.from(text, 'base64');
  let canonical: Uint8Array;
  let senderId: unknown;
  try {
    const decoded = deserialize(SCHEMA.SignedDelegate, bytes) as unknown as SignedDelegate;
    senderId = decoded.delegateAction.senderId;
    canonical = encodeSignedDelegate(decoded);
  }
  catch {
    return undefined;
  }

  return typeof senderId === 'string' && senderId !== '' && Buffer.from(canonical).equals(bytes) ? { bytes: canonical, senderId } : undefined;
};

/** What makes a payment single-use, and for how long: its claim, and on NEAR its payer's. */
interface PaymentClaim {
  readonly key: string;
  // NEAR: the payer's own claim, held with the payment's, so a payer has one payment in flight
  readonly payerKey?: string;
  readonly expiresAtMs: number;
}

/**
 * What makes a signed payment single-use, and how long to hold it. On EVM: the EIP-3009 (or Permit2)
 * nonce, in lowercase, held until the signature's own deadline, since it verifies until then. On
 * Solana: a SHA-256 of the signed transaction's bytes, so another spelling of the same base64 is the
 * same payment. On NEAR: the same over the signed delegate action's canonical bytes, and a second
 * claim on its sender. A delegate action's nonce is per access key and the buyer's client reads it
 * from the chain, so a payer's second payment signed while the first hasn't landed carries the same
 * nonce, and only one of them can land. Held at least for the option's timeout, plus a minute each,
 * and at most a week: on NEAR, longer than the delegate action can execute. Undefined when the
 * payload has no nonce, deadline, or transaction, or a NEAR action that isn't canonical.
 */
const claimOf = (requirements: PaymentRequirements, payload: PaymentPayload, nowMs: number): PaymentClaim | undefined => {
  const shortest = BigInt(nowMs + requirements.maxTimeoutSeconds * 1_000 + claimGraceMs);
  const longest = BigInt(nowMs + maxClaimMs);
  const until = (deadlineMs: bigint): number => Number(deadlineMs < shortest ? shortest : deadlineMs > longest ? longest : deadlineMs);
  const hashOf = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

  if (requirements.network.startsWith('eip155:')) {
    const permit2 = requirements.extra['assetTransferMethod'] === 'permit2';
    const signed = payload.payload[permit2 ? 'permit2Authorization' : 'authorization'];
    const nonce = isRecord(signed) ? signed['nonce'] : undefined;
    const validBefore = isRecord(signed) ? secondsOf(signed[permit2 ? 'deadline' : 'validBefore']) : undefined;
    if (typeof nonce !== 'string' || nonce === '' || validBefore === undefined)
      return undefined;

    return { key: `x402:${requirements.network}:${nonce.toLowerCase()}`, expiresAtMs: until(validBefore * 1_000n + BigInt(claimGraceMs)) };
  }
  if (requirements.network.startsWith('solana:')) {
    const signed = payload.payload['transaction'];
    const text = typeof signed === 'string' ? signed.trim() : '';
    const bytes = base64Pattern.test(text) ? Buffer.from(text, 'base64') : Buffer.alloc(0);
    if (bytes.length === 0)
      return undefined;

    return { key: `x402:${requirements.network}:${hashOf(bytes)}`, expiresAtMs: until(shortest) };
  }
  if (requirements.network.startsWith('near:')) {
    const delegate = canonicalNearDelegate(payload.payload['signedDelegateAction']);
    if (!delegate)
      return undefined;

    return {
      key: `x402:${requirements.network}:${hashOf(delegate.bytes)}`, payerKey: `x402:${requirements.network}:payer:${delegate.senderId}`, expiresAtMs: until(shortest),
    };
  }

  return undefined;
};

/**
 * The moment after which a payment can no longer settle, in milliseconds since the epoch. On EVM: its
 * authorization's validBefore, or Permit2's deadline. On Solana: a minute from now, a blockhash's
 * lifetime. On NEAR: the option's timeout counted in blocks of about 0.6 s, counted as 0.5 s. Undefined when the payload has no deadline.
 */
const deadlineOf = (requirements: PaymentRequirements, payload: PaymentPayload, nowMs: number): number | undefined => {
  if (requirements.network.startsWith('solana:'))
    return nowMs + solanaWindowMs;
  if (requirements.network.startsWith('near:'))
    return nowMs + requirements.maxTimeoutSeconds * nearMsPerBlock;
  const permit2 = requirements.extra['assetTransferMethod'] === 'permit2';
  const signed = payload.payload[permit2 ? 'permit2Authorization' : 'authorization'];
  const seconds = isRecord(signed) ? secondsOf(signed[permit2 ? 'deadline' : 'validBefore']) : undefined;

  return seconds === undefined ? undefined : Number(seconds * 1_000n);
};

/** Whether a payment carries any x402 extension. This resource offers none. */
const carriesExtensions = (payload: PaymentPayload): boolean => {
  const { extensions } = payload as { extensions?: unknown };

  return extensions !== undefined && extensions !== null && !(isRecord(extensions) && Object.keys(extensions).length === 0);
};

/** What the x402 rail keeps between verify and settle. */
export interface X402Authorization extends Authorization {
  readonly rail: 'x402';
  readonly payload: PaymentPayload;
  readonly requirements: PaymentRequirements;
  // The asset's registry name, such as `base-usdc`, whose treasury books the payment
  readonly asset: string;
  // The claim on the payment's nonce, released when nothing settles
  readonly claim: string;
  // NEAR: the claim on the payer, released once the payment is final or nothing settles
  readonly payerClaim?: string;
  // When the payment can no longer settle: the proxy keeps the call under it
  readonly deadlineMs: number;
}

export interface X402RailOptions {
  readonly setup: X402Setup;
  readonly recorder: PaymentRecorder;
  readonly ledger: SettlementLedger;
  // One call per signed payment, across every proxy replica
  readonly claims: ClaimStore;
  // For the claims' expiry
  readonly clock: Clock;
  readonly logger: Logger;
}

/**
 * What the settlement follow-up finishes for a payment still `settling`. Without `settled`, it repeats
 * the settle with the facilitator until the outcome is final. With `settled`, the facilitator already
 * settled it and only the booking failed: the follow-up books that answer with `ledger.settle` and
 * doesn't call the facilitator again.
 */
export interface SettlementRequest {
  readonly paymentPayload: PaymentPayload;
  readonly paymentRequirements: PaymentRequirements;
  readonly settled?: SettleResponse;
}

export const toSettlementRequest = (payload: PaymentPayload, requirements: PaymentRequirements, settled?: SettleResponse): JsonObject =>
  ({ paymentPayload: payload, paymentRequirements: requirements, ...settled ? { settled } : {} }) as unknown as JsonObject;

export const fromSettlementRequest = (value: JsonObject | undefined): SettlementRequest | undefined =>
  isRecord(value) && isRecord(value['paymentPayload']) && isRecord(value['paymentRequirements']) && (value['settled'] === undefined || isRecord(value['settled']))
    ? value as unknown as SettlementRequest
    : undefined;

/** A settle response as the `PAYMENT-RESPONSE` header carries it to the buyer. */
export const encodeSettleReceipt = (result: SettleResponse): string => encodePaymentResponseHeader(result);

const x402Only = (authorization: Authorization): X402Authorization => {
  if (authorization.rail !== 'x402' || !('payload' in authorization))
    throw new TypeError(`The x402 rail can't take a ${authorization.rail} authorization`);

  return authorization as X402Authorization;
};

const decode = (credential: Credential): PaymentPayload => {
  if (credential.rail !== 'x402')
    throw new TypeError(`The x402 rail can't take a ${credential.rail} credential`);
  try {
    if (credential.version !== 2)
      throw new PaymentInvalidError('x402 v1 (X-PAYMENT) isn\'t accepted. Pay with PAYMENT-SIGNATURE (x402 v2).');

    let payload: unknown;
    try {
      payload = decodePaymentSignatureHeader(credential.header.expose());
    }
    catch {
      throw new PaymentInvalidError('PAYMENT-SIGNATURE isn\'t an x402 payment: base64 of its JSON');
    }
    if (!isRecord(payload) || payload['x402Version'] !== 2 || !isRecord(payload['accepted']) || !isRecord(payload['payload']))
      throw new PaymentInvalidError('PAYMENT-SIGNATURE isn\'t an x402 v2 payment');

    return payload as unknown as PaymentPayload;
  }
  finally {
    credential.header.destroy();
  }
};

/**
 * x402: requirements per request from the quote, with the SDK's resource server, one `exact` option
 * per offered asset at or above its minimum price. Claims the payment's nonce, so one signed payment
 * pays for one call, and on NEAR its payer, so a payer has one payment in flight. Then verifies
 * through the network's facilitator before forwarding, and records the payment as `verified`. Settles after a billable response, before any byte goes out, and books
 * it. Otherwise cancels: nothing settles. Finalize and abort read the payment first, so running either
 * twice moves money once.
 */
export const createX402Rail = ({ setup, recorder, ledger, claims, clock, logger }: X402RailOptions): PaymentRail => {
  const { server } = setup;

  // A claim that can't be released expires on its own: the buyer's retry waits for it
  const release = async (log: LogSink, ...keys: readonly (string | undefined)[]): Promise<void> => {
    for (const claim of keys) {
      if (claim === undefined)
        continue;
      try {
        await claims.release(claim);
      }
      catch (error) {
        log.warn({ error, claim }, 'The payment\'s claim couldn\'t be released. It expires on its own.');
      }
    }
  };

  // What a finalize that already ran answered, from the payment's row
  const storedReceipt = (row: Payment): Receipt => {
    const status = row.status === 'settled' ? 'settled' : 'settling';

    return { headers: row.receipt === undefined ? {} : { [paymentResponseHeader]: row.receipt }, settlement: { status, transaction: row.transactionHash } };
  };

  // The same quote gives the same requirements, so the paid retry matches what the 402 offered
  const requirementsFor = async (quote: Quote): Promise<PaymentRequirements[]> => {
    const offered = setup.assets.filter(asset => asset.minPrice <= quote.priceMicroUsd);
    const lists = await Promise.all(offered.map(asset => server.buildPaymentRequirements({
      scheme: 'exact',
      network: asset.network as Network,
      payTo: asset.payTo,
      // Exact, and never below the price
      price: { amount: usdToAtomic(quote.priceMicroUsd, { decimals: asset.decimals, rounding: 'ceil' }).toString(), asset: asset.address, extra: { ...asset.extra } },
    })));

    return lists.flat();
  };

  // Nothing was charged, so the buyer may pay with the same signature again
  const settlementFailed = async (authorization: X402Authorization, failure: SettlementFailure): Promise<never> => {
    await recorder.changeStatus({ paymentId: authorization.paymentId, to: 'failed', settlementRequest: null });
    await release(authorization.log ?? logger, authorization.claim, authorization.payerClaim);
    throw new SettlementFailedError(failure);
  };

  return {
    name: 'x402',
    settlesBeforeResponse: true,
    detect: detectX402,
    challenge: async quote => {
      const accepts = await requirementsFor(quote);
      if (accepts.length === 0)
        return undefined;

      const resource = { url: quote.resource, description: quote.description };
      const required = await server.createPaymentRequiredResponse(accepts, resource, 'Payment required');

      return { headers: { 'payment-required': encodePaymentRequiredHeader(required) }, body: { ...required } };
    },
    authorize: async (credential, quote) => {
      const payload = decode(credential);
      const matched = server.findMatchingRequirements(await requirementsFor(quote), payload);
      const requirements = matched && sameTransferMethod(matched, payload) ? matched : undefined;
      if (!requirements)
        throw new PaymentInvalidError('The payment doesn\'t match an option for this price. Request the resource again for the current options.');
      const asset = setup.assetName(requirements.network, requirements.asset);
      if (!asset)
        throw new PaymentInvalidError('The payment\'s asset isn\'t offered');
      // The extensions it echoes must be the ones this challenge offers, as the SDK's HTTP server
      // checks. The challenge offers none, so a payment that carries any is refused.
      const echoed = server.validateExtensions({ x402Version: 2, resource: { url: quote.resource }, accepts: [requirements] } satisfies PaymentRequired, payload);
      if (!echoed.valid || carriesExtensions(payload)) {
        throw new PaymentInvalidError('The payment carries extensions this resource doesn\'t offer. Request the resource again for the current options.', {
          reason: 'extension_echo_mismatch',
        });
      }
      if (otherTransferMethod(requirements, payload)) {
        throw new PaymentInvalidError('The payment uses a transfer method this option doesn\'t offer. Request the resource again for the current options.', {
          reason: 'transfer_method',
        });
      }
      const nowMs = clock.now().getTime();
      const single = claimOf(requirements, payload, nowMs);
      const deadlineMs = deadlineOf(requirements, payload, nowMs);
      if (single === undefined || deadlineMs === undefined)
        throw new PaymentInvalidError('The payment has no nonce, deadline, or transaction in its exact encoding to make it single-use', { reason: 'invalid_payload' });
      // A payment that expires before the call and its settle can finish would let the answer out unpaid
      if (deadlineMs - nowMs < minPaymentWindowMs) {
        throw new PaymentInvalidError(`The payment expires too soon. Sign it valid for at least ${minPaymentWindowMs / 1_000} seconds.`, {
          reason: 'too_short',
        });
      }

      // Concurrent calls with one signature: the first claim verifies, the others are refused
      const claim = single.key;
      const { payerKey: payerClaim } = single;
      const log = quote.log ?? logger;
      if (!await claims.tryClaim(claim, single.expiresAtMs))
        throw new PaymentInvalidError('This payment was already used. Request the resource again and sign a new one.', { reason: 'replayed' });
      // NEAR: then the payer's, so a payer's second payment waits for its first to be final
      let payerFree = true;
      if (payerClaim !== undefined) {
        try {
          payerFree = await claims.tryClaim(payerClaim, single.expiresAtMs);
        }
        catch (error) {
          await release(log, claim);
          throw error;
        }
      }
      if (!payerFree) {
        await release(log, claim);
        throw new PaymentInvalidError('This payer has another NEAR payment in flight, which this one\'s nonce would collide with. Pay again once it has settled.', {
          reason: 'payer_busy',
        });
      }

      const facilitator = setup.facilitatorFor(requirements.network)?.name;
      let verified: Awaited<ReturnType<typeof server.verifyPayment>>;
      try {
        verified = await server.verifyPayment(payload, requirements);
        if (!verified.isValid) {
          const reason = verified.invalidReason && reasonPattern.test(verified.invalidReason) ? verified.invalidReason : undefined;
          throw new PaymentInvalidError(`The facilitator rejected the payment${reason ? `: ${reason}` : ''}`, {
            reason: verified.invalidReason?.slice(0, 200) ?? 'unknown', ...facilitator === undefined ? {} : { facilitator },
          });
        }

        await recorder.create({
          id: quote.paymentId,
          requestId: quote.requestId,
          rail: 'x402',
          buyerAccountId: undefined,
          keyId: undefined,
          targetHost: quote.subject.targetHost,
          targetPath: quote.subject.targetPath,
          network: requirements.network,
          asset,
          atomicAmount: BigInt(requirements.amount),
          amount: quote.priceMicroUsd,
          status: 'verified',
        });
      }
      catch (error) {
        // Nothing was forwarded, so the same signature may try again
        await release(log, claim, payerClaim);
        throw error;
      }
      const authorization: X402Authorization = {
        rail: 'x402',
        paymentId: quote.paymentId,
        amount: quote.priceMicroUsd,
        buyer: `address:${requirements.network}:${verified.payer ?? 'unknown'}`,
        receipt: undefined,
        network: requirements.network,
        payload,
        requirements,
        asset,
        claim,
        ...payerClaim === undefined ? {} : { payerClaim },
        deadlineMs,
        ...quote.log ? { log: quote.log } : {},
      };

      return authorization;
    },
    finalize: async (authorization): Promise<Receipt> => {
      const x402 = x402Only(authorization);
      const { paymentId, payload, requirements, asset, payerClaim, log = logger } = x402;
      const { network } = requirements;
      const facilitator = setup.facilitatorFor(network)?.name;
      const where = { facilitator, network };

      // What a finalize that already ran answered, from the payment's row. Undefined unless it is
      // settled or settling.
      const answered = (row: Payment | undefined): Receipt | undefined => {
        if (row?.status === 'settled' || (row?.status === 'settling' && row.receipt !== undefined))
          return storedReceipt(row);
        // Settling without a receipt: another finalize is settling, or one stopped during its settle.
        // The outcome is unknown, and the settlement follow-up repeats it.
        if (row?.status === 'settling') {
          throw new SettlementFailedError({
            outcome: 'unknown', ...row.transactionHash ? { transaction: row.transactionHash } : {}, ...facilitator === undefined ? {} : { facilitator }, network,
          });
        }

        return undefined;
      };

      // A finalize that already ran: its receipt, without asking the facilitator again
      const row = await recorder.find(paymentId);
      const before = answered(row);
      if (before)
        return before;
      if (row?.status !== 'verified')
        throw new InvalidPaymentStatusChangeError(paymentId, row?.status, 'settled');

      const request = toSettlementRequest(payload, requirements);
      // Before the settle, so a crash or a deploy during it leaves the payment where the settlement
      // follow-up finds it, with the settle to repeat. A settle that landed before the crash may then
      // be answered as a used nonce: the follow-up takes such an answer as needing review, never as
      // a failed settlement. Only from verified: of two finalizes that read it verified, one settles,
      // and the other answers what the row says.
      try {
        await recorder.changeStatus({ paymentId, to: 'settling', from: 'verified', settlementRequest: request });
      }
      catch (error) {
        if (!(error instanceof InvalidPaymentStatusChangeError))
          throw error;
        const after = answered(await recorder.find(paymentId));
        if (after)
          return after;
        throw error;
      }
      let result: SettleResponse;
      try {
        result = await server.settlePayment(payload, requirements);
      }
      catch (error) {
        // A timeout or a 503: the outcome is unknown. The payment stays settling, and the settlement
        // follow-up repeats it.
        log.warn({ error, paymentId, ...where }, 'The settlement\'s outcome is unknown. The settlement follow-up repeats it.');
        const reason = (error as { reason?: unknown }).reason;

        throw new SettlementFailedError({
          outcome: 'unknown', ...typeof reason === 'string' ? { reason } : {}, ...facilitator === undefined ? {} : { facilitator }, network, cause: error,
        });
      }

      if (result.success) {
        // Final on chain: the payer's next payment reads a nonce past this one's. The payment's own
        // claim stays until it expires, so the same signature never pays twice.
        await release(log, payerClaim);
        const receipt = encodePaymentResponseHeader(result);
        const transaction = result.transaction || undefined;
        try {
          await ledger.settle({ paymentId, asset, transactionHash: transaction, receipt, needsReview: false });
        }
        catch (error) {
          // The buyer paid on chain, and the booking failed. The settlement follow-up books the settled
          // answer it keeps, without settling again.
          log.error({ error, paymentId, transaction, ...where }, 'The payment settled, but its booking failed. The settlement follow-up books it.');
          try {
            await recorder.changeStatus({
              paymentId,
              to: 'settling',
              ...transaction ? { transactionHash: transaction } : {},
              receipt,
              // The buyer paid and got no response
              needsReview: true,
              settlementRequest: toSettlementRequest(payload, requirements, result),
            });
          }
          catch (recordError) {
            log.error({ error: recordError, paymentId, transaction, ...where }, 'The settled payment couldn\'t be recorded as settling. It needs review.');
          }
          throw new SettlementFailedError({
            outcome: 'unknown', reason: 'booking_failed', ...transaction ? { transaction } : {}, ...facilitator === undefined ? {} : { facilitator }, network, cause: error,
          });
        }

        return { headers: { [paymentResponseHeader]: receipt }, settlement: { status: 'settled', transaction } };
      }
      if (result.errorReason === settlementPending && result.transaction) {
        // Broadcast, not final: the response goes out, and the worker finishes the settlement
        const receipt = encodePaymentResponseHeader(result);
        await recorder.changeStatus({ paymentId, to: 'settling', transactionHash: result.transaction, receipt, settlementRequest: request });

        return { headers: { [paymentResponseHeader]: receipt }, settlement: { status: 'settling', transaction: result.transaction } };
      }

      const reason = result.errorReason ?? 'unknown';
      log.warn({ paymentId, reason, transaction: result.transaction || undefined, ...where }, 'The settlement failed. Nothing was charged.');
      return settlementFailed(x402, {
        outcome: 'failed', reason, ...result.transaction ? { transaction: result.transaction } : {}, ...facilitator === undefined ? {} : { facilitator }, network,
      });
    },
    abort: async authorization => {
      const { paymentId, claim, payerClaim, log = logger } = x402Only(authorization);
      const row = await recorder.find(paymentId);
      // An abort that already ran, or a settlement that failed: nothing to give back
      if (row?.status === 'cancelled' || row?.status === 'failed')
        return;
      if (row?.status === 'settled' || row?.status === 'settling')
        throw new Error(`The payment ${paymentId} is ${row.status}: it can't be cancelled after its settlement`);

      await recorder.changeStatus({ paymentId, to: 'cancelled' });
      await release(log, claim, payerClaim);
    },
  };
};
