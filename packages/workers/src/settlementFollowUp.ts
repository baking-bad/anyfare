import { isRecord, type Clock, type Logger } from '@anyfare/common';
import type { JsonObject, Payment, PlatformConfig } from '@anyfare/core';
import type { Ledger, PaymentRepository } from '@anyfare/db';
import {
  encodeSettleReceipt, errorReason, fromMppSettlementRequest, fromSettlementRequest, settlementPending, type Facilitator, type MppSettlementCheck,
  type SettlementRequest,
} from '@anyfare/payments';

// One runner across replicas
export const settlementFollowUpLockId = 7_301_746_202;
export const settlementFollowUpJobName = 'settlement_follow_up';
export const settlementFollowUpIntervalMs = 30_000;
const defaultBatchSize = 100;

/**
 * How long a `settling` payment is left alone after its last update. Both rails record `settling`
 * before they call the facilitator or the Tempo node, so a younger one may still be finalizing. An
 * x402 finalize may call `/settle` twice, and an MPP one broadcasts, then reads the receipt: each call
 * up to `timeouts.settleMs`. A minute more covers the booking after them.
 */
export const settlingGraceMs = (config: { readonly timeouts: Pick<PlatformConfig['timeouts'], 'settleMs'> }): number => 2 * config.timeouts.settleMs + 60_000;

/**
 * Refusals a facilitator decides before it submits anything, from the payload and the requirements
 * alone, so a settle of the same payload that landed earlier can't be why: the x402 names CDP answers,
 * and those of `@x402/evm` and `@x402/svm` 2.30. Refusals that read the chain after a settle may have
 * moved the money (a used nonce, a spent balance or allowance, a simulation, an expired deadline or
 * blockhash, a duplicate) aren't here. Neither are those of a check that can fail for a moment: the
 * signature reasons, which the SDK also answers when a smart wallet's signature can't be read through
 * its RPC. Nor the facilitator client's `refused_<status>`, a 4xx without an answer, which says nothing
 * of what was submitted.
 */
export const presubmissionRefusals: ReadonlySet<string> = new Set([
  // Any scheme. Not `insufficient_funds`: a settle that landed earlier spends the balance it reads.
  'invalid_payload', 'invalid_scheme', 'invalid_network', 'unsupported_scheme', 'invalid_x402_version', 'invalid_payment_requirements',
  'unsupported_asset_transfer_method',
  // EVM: the x402 names
  'invalid_exact_evm_payload_recipient_mismatch', 'invalid_exact_evm_payload_authorization_value',
  'invalid_exact_evm_payload_authorization_valid_after', 'invalid_exact_evm_payload_undeployed_smart_wallet',
  // EVM: @x402/evm, EIP-3009
  'invalid_exact_evm_payload', 'invalid_exact_evm_scheme', 'invalid_exact_evm_network_mismatch', 'invalid_exact_evm_missing_eip712_domain',
  'invalid_exact_evm_non_canonical_signature', 'invalid_exact_evm_failed_to_parse_signature',
  'invalid_exact_evm_recipient_mismatch', 'invalid_exact_evm_authorization_value', 'invalid_exact_evm_payload_authorization_value_mismatch',
  'invalid_exact_evm_token_name_mismatch', 'invalid_exact_evm_token_version_mismatch', 'invalid_exact_evm_eip3009_not_supported',
  // Safe though it reads a balance: the SDK's diagnosis reads the authorization's nonce first, and a
  // settle that landed would have answered `invalid_exact_evm_nonce_already_used` instead
  'invalid_exact_evm_insufficient_balance',
  'eip6492_factory_not_allowed', 'asset_not_deployed_contract',
  // EVM: @x402/evm, Permit2
  'invalid_permit2_signature', 'invalid_permit2_spender', 'invalid_permit2_recipient_mismatch', 'permit2_amount_mismatch', 'permit2_invalid_amount',
  'permit2_invalid_destination', 'permit2_invalid_owner', 'permit2_token_mismatch', 'permit2_not_yet_valid', 'permit2_payment_too_early',
  'permit2_proxy_not_deployed', 'permit2_2612_amount_mismatch', 'invalid_eip2612_extension_format', 'eip2612_from_mismatch', 'eip2612_asset_mismatch',
  'eip2612_spender_not_permit2', 'invalid_erc20_approval_extension_format', 'erc20_approval_from_mismatch', 'erc20_approval_asset_mismatch',
  'erc20_approval_spender_not_permit2',
  // Solana: @x402/svm, the transaction's shape
  'invalid_exact_svm_unsupported_scheme', 'invalid_exact_svm_network_mismatch', 'unsupported_transaction_version',
  'invalid_exact_svm_payload_transaction', 'invalid_exact_svm_payload_transaction_could_not_be_decoded', 'invalid_exact_svm_payload_transaction_size_exceeded',
  'invalid_exact_svm_payload_transaction_instructions_length', 'invalid_exact_svm_payload_transaction_instructions_compute_limit_instruction',
  'invalid_exact_svm_payload_transaction_instructions_compute_limit_instruction_too_high',
  'invalid_exact_svm_payload_transaction_instructions_compute_price_instruction',
  'invalid_exact_svm_payload_transaction_instructions_compute_price_instruction_too_high', 'invalid_exact_svm_payload_transaction_v1_compute_budget_instruction',
  'invalid_exact_svm_payload_transaction_v1_heap_size', 'invalid_exact_svm_payload_transaction_loaded_accounts_data_size_limit_missing',
  'invalid_exact_svm_payload_transaction_fee_payer_transferring_funds', 'invalid_exact_svm_payload_excessive_signers', 'invalid_exact_svm_payload_missing_fee_payer',
  'invalid_exact_svm_fee_payer_mismatch', 'invalid_exact_svm_fee_payer_not_managed_by_facilitator', 'invalid_exact_svm_payload_no_transfer_instruction',
  'invalid_exact_svm_payload_amount_mismatch', 'invalid_exact_svm_payload_mint_mismatch', 'invalid_exact_svm_payload_recipient_mismatch',
  'invalid_exact_svm_payload_memo_count', 'invalid_exact_svm_payload_memo_mismatch', 'invalid_exact_svm_payload_signature_invalid',
  'invalid_exact_svm_payload_unknown_fourth_instruction', 'invalid_exact_svm_payload_unknown_fifth_instruction',
  'invalid_exact_svm_payload_unknown_sixth_instruction', 'invalid_exact_svm_payload_unknown_seventh_instruction',
  'invalid_exact_svm_payload_unknown_optional_instruction',
]);

// Unix seconds, as the payload carries them
const secondsPattern = /^\d{1,15}$/;

/** An EVM payment's deadline in Unix seconds: EIP-3009's `validBefore`, or Permit2's `deadline`. Undefined: none found. */
const evmDeadlineOf = (request: SettlementRequest): number | undefined => {
  const payload: unknown = request.paymentPayload.payload;
  const authorization = isRecord(payload) ? payload['authorization'] : undefined;
  const permit2 = isRecord(payload) ? payload['permit2Authorization'] : undefined;
  const value = isRecord(authorization) ? authorization['validBefore'] : isRecord(permit2) ? permit2['deadline'] : undefined;
  const text = typeof value === 'number' || typeof value === 'string' ? String(value) : '';

  return secondsPattern.test(text) ? Number(text) : undefined;
};

type SettleResponse = Awaited<ReturnType<Facilitator['settle']>>;

export interface SettlementFollowUpOptions {
  readonly payments: Pick<PaymentRepository, 'listSettling' | 'claimSettling' | 'changeStatus'>;
  readonly ledger: Pick<Ledger, 'settle'>;
  readonly facilitatorFor: (network: string) => Facilitator | undefined;
  // Reads an MPP transaction's receipt on the Tempo node. Without it, MPP payments wait.
  readonly mppCheck?: MppSettlementCheck;
  // What "updated too recently" and "a deadline ahead" are measured against
  readonly clock: Clock;
  // timeouts.settleMs: the grace period, and how far ahead a deadline must be for a refusal to be final
  readonly settleMs: number;
  readonly logger: Logger;
  readonly batchSize?: number;
}

export interface SettlementFollowUpResult {
  readonly settled: number;
  readonly failed: number;
  // Broadcast, not final yet: tried again next run
  readonly pending: number;
  // Undecided: no facilitator or Tempo node to ask, no answer, a booking that failed, or a payment that
  // needs review. Tried again, and the run fails, until it's decided.
  readonly unknown: number;
  // Couldn't be tried: no settle request or asset
  readonly skipped: number;
}

/** Some settlements couldn't be decided. They are tried again next run, and the job stays stale. */
export class SettlementFollowUpError extends Error {
  constructor(readonly result: SettlementFollowUpResult) {
    super(`${result.unknown + result.skipped} settling payments couldn't be decided`);
  }
}

/**
 * The settlement follow-up finishes every `settling` payment whose finalize has had its time. Each is
 * claimed before the facilitator or the Tempo node is asked about it, so two runners never ask twice.
 *
 * x402: a payment whose settle request carries the facilitator's `settled` answer was paid, and only
 * its booking failed: it is booked from that answer, without the facilitator. A payment flagged for
 * review is never sent again: it waits for an operator. Any other repeats the identical settle.
 * Settled → booked. Pending → next run. A refusal decided before anything was submitted, while the
 * payment's deadline is still well ahead → `failed`, nothing booked. Any other refusal may follow a
 * settle that landed, so the payment is flagged for review, kept `settling`, and an operator decides.
 *
 * MPP: reads the transaction's receipt on the Tempo node, never broadcasting it. Settled → booked.
 * Reverted, without the expected transfer, or expired → `failed`, unless flagged for review. Not
 * found yet → next run.
 *
 * A booked payment is flagged for review when the buyer got no response. The ledger's settle moves
 * money once, so a rerun after a crash books nothing twice.
 */
export const createSettlementFollowUp = ({
  payments, ledger, facilitatorFor, mppCheck, clock, settleMs, logger, batchSize = defaultBatchSize,
}: SettlementFollowUpOptions) => async (): Promise<SettlementFollowUpResult> => {
  const counts = { settled: 0, failed: 0, pending: 0, unknown: 0, skipped: 0 };
  const now = clock.now().getTime();

  const book = async (payment: Payment, asset: string, settlement: {
    readonly transactionHash: string | undefined;
    readonly receipt: string | undefined;
    readonly needsReview: boolean;
  }, where: Readonly<Record<string, unknown>>): Promise<void> => {
    try {
      await ledger.settle({ paymentId: payment.id, asset, ...settlement });
    }
    catch (error) {
      counts.unknown += 1;
      logger.error({ ...where, error, transaction: settlement.transactionHash ?? null }, 'The settlement follow-up couldn\'t book a settled payment');
      return;
    }
    counts.settled += 1;
    // Each settlement the follow-up finishes
    logger.info({ ...where, transaction: settlement.transactionHash ?? null, needsReview: settlement.needsReview }, 'The settlement follow-up settled a payment');
  };

  // The buyer paid, and the response never went out, or the rail already flagged the payment
  const unanswered = (payment: Payment): boolean => payment.needsReview || payment.receipt === undefined;

  const markFailed = async (payment: Payment): Promise<void> => {
    await payments.changeStatus({ paymentId: payment.id, to: 'failed', from: 'settling', settlementRequest: null });
    counts.failed += 1;
  };

  // Already flagged: undecided, with its alert, on every run until an operator acts
  const awaitingReview = (payment: Payment, where: Readonly<Record<string, unknown>>): void => {
    counts.unknown += 1;
    logger.error({ ...where, transaction: payment.transactionHash ?? null, alert: true }, 'A settling payment flagged for review is waiting for an operator');
  };

  // The money may have moved: never failed. Flagged, kept settling, and undecided until an operator acts.
  const flagForReview = async (payment: Payment, where: Readonly<Record<string, unknown>>, reason: string | null, transaction: string | undefined): Promise<void> => {
    await payments.changeStatus({ paymentId: payment.id, to: 'settling', from: 'settling', needsReview: true });
    counts.unknown += 1;
    logger.error({ ...where, reason, transaction: transaction || payment.transactionHash || null, alert: true },
      'The facilitator refused a settle that may have landed before: the payment needs review');
  };

  // Of two runners that listed the payment, only the one that claims it asks about it
  const claim = (payment: Payment): Promise<boolean> => payments.claimSettling({ paymentId: payment.id, seenUpdatedAt: payment.updatedAt });

  // Whether a refusal proves nothing was ever submitted, so the payment can be `failed`
  const finalRefusal = (payment: Payment, request: SettlementRequest, reason: string | undefined): boolean => {
    if (reason === undefined || !presubmissionRefusals.has(reason))
      return false;
    // Solana's transactions expire with their blockhash, which the payload doesn't carry: the reason alone decides
    if (payment.network?.startsWith('solana:'))
      return true;
    const deadline = evmDeadlineOf(request);

    return deadline !== undefined && deadline * 1_000 - now > settleMs;
  };

  // MPP: the transaction's receipt by its hash on the Tempo node
  const followMpp = async (payment: Payment, settlementRequest: JsonObject | undefined): Promise<void> => {
    const request = fromMppSettlementRequest(settlementRequest);
    const { asset } = payment;
    const where = { paymentId: payment.id, rail: 'mpp', network: payment.network ?? null };
    if (!request || asset === undefined) {
      counts.skipped += 1;
      logger.error(where, 'A settling MPP payment has no settlement request or asset to check it with');
      return;
    }
    if (!mppCheck) {
      counts.unknown += 1;
      logger.error(where, 'A settling MPP payment waits: the workers have no Tempo node to check it with');
      return;
    }
    if (!await claim(payment))
      return;

    let result;
    try {
      result = await mppCheck(request);
    }
    catch (error) {
      counts.unknown += 1;
      // viem's short message only: never the node's request
      logger.warn({ ...where, reason: errorReason(error), transaction: request.transactionHash }, 'An MPP payment is still undecided');
      return;
    }
    if (result.status === 'settled')
      await book(payment, asset, { transactionHash: request.transactionHash, receipt: payment.receipt ?? result.receipt, needsReview: unanswered(payment) }, where);
    else if (payment.needsReview)
      awaitingReview(payment, where);
    else if (result.status === 'failed') {
      await markFailed(payment);
      logger.warn({ ...where, transaction: request.transactionHash, reason: result.reason }, 'An MPP payment failed for good. Nothing was booked.');
    }
    else
      counts.pending += 1;
  };

  // x402: the facilitator's answer, kept or asked for again
  const followX402 = async (payment: Payment, settlementRequest: JsonObject | undefined): Promise<void> => {
    const { network, asset } = payment;
    const request = fromSettlementRequest(settlementRequest);
    const where = { paymentId: payment.id, rail: payment.rail, network: network ?? null };
    if (!request || asset === undefined) {
      counts.skipped += 1;
      logger.error(where, 'A settling payment has no settle request or asset to finish it with');
      return;
    }
    if (request.settled) {
      // The facilitator settled it, and the booking failed: book that answer. The buyer got no response.
      // The receipt the rail encoded from it, when recorded: the settle request is stored as JSON whose
      // key order may change, which would change the encoding.
      const { settled } = request;
      await book(payment, asset, {
        transactionHash: settled.transaction || payment.transactionHash, receipt: payment.receipt ?? encodeSettleReceipt(settled), needsReview: true,
      }, where);
      return;
    }
    if (payment.needsReview) {
      awaitingReview(payment, where);
      return;
    }

    const facilitator = network === undefined ? undefined : facilitatorFor(network);
    if (!facilitator) {
      counts.unknown += 1;
      logger.error(where, 'A settling payment waits: the workers have no facilitator to repeat its settle with');
      return;
    }
    if (!await claim(payment))
      return;
    const at = { ...where, facilitator: facilitator.name };
    let result: SettleResponse;
    try {
      result = await facilitator.settle(request.paymentPayload, request.paymentRequirements);
    }
    catch (error) {
      counts.unknown += 1;
      logger.warn({ ...at, error }, 'A settlement is still undecided');
      return;
    }

    if (result.success) {
      const transaction = result.transaction || payment.transactionHash;
      await book(payment, asset, { transactionHash: transaction, receipt: payment.receipt ?? encodeSettleReceipt(result), needsReview: unanswered(payment) }, at);
    }
    else if (result.errorReason === settlementPending) {
      counts.pending += 1;
      logger.debug({ ...at, transaction: result.transaction || null }, 'A settlement is still pending');
    }
    else if (finalRefusal(payment, request, result.errorReason)) {
      await markFailed(payment);
      logger.warn({ ...at, reason: result.errorReason ?? null, transaction: result.transaction || null }, 'A settlement failed for good. Nothing was booked.');
    }
    else
      await flagForReview(payment, at, result.errorReason ?? null, result.transaction);
  };

  // Only rows whose finalize has had its time
  const updatedBefore = new Date(now - settlingGraceMs({ timeouts: { settleMs } }));
  let after: { readonly createdAt: Date; readonly id: string } | undefined;
  for (;;) {
    const page = await payments.listSettling({ limit: batchSize, updatedBefore, ...(after ? { after } : {}) });
    // One at a time: each is a facilitator or node call, then a ledger transaction
    for (const { payment, settlementRequest } of page) {
      try {
        await (payment.rail === 'mpp' ? followMpp : followX402)(payment, settlementRequest);
      }
      catch (error) {
        // Such as the database, while recording what the answer said
        counts.unknown += 1;
        logger.error({ error, paymentId: payment.id, rail: payment.rail }, 'Failed to follow up a settlement');
      }
    }
    const last = page.at(-1);
    if (!last || page.length < batchSize)
      break;
    after = { createdAt: last.payment.createdAt, id: last.payment.id };
  }

  // The scheduler's line carries these counts at info
  if (counts.settled + counts.failed > 0)
    logger.debug(counts, 'Followed up settlements');
  if (counts.unknown + counts.skipped > 0)
    throw new SettlementFollowUpError(counts);

  return counts;
};
