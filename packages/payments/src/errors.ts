import { AnyfareError } from '@anyfare/common';
import type { HoldRefusal } from '@anyfare/core';

/** Two or more payment credentials in one request. */
export class MultiplePaymentMethodsError extends AnyfareError {
  readonly code = 'multiple_payment_methods';

  constructor() {
    super('Send exactly one payment credential: a payment key, an x402 payment, or an MPP credential');
  }
}

/** The price is above the payment key's maximum per call. */
export class KeyPriceLimitError extends AnyfareError {
  readonly code = 'key_price_limit';

  constructor() {
    super('The price is above the payment key\'s maximum per call');
  }
}

const refusalMessages: Readonly<Record<HoldRefusal, string>> = {
  insufficient_balance: 'The credits balance doesn\'t cover the price',
  key_budget_exceeded: 'The payment key\'s daily budget doesn\'t cover the price',
  key_allowance_exceeded: 'The payment key\'s allowance doesn\'t cover the price',
};

/** The payment isn't one this call takes, or the facilitator rejected it. Nothing moved. */
export class PaymentInvalidError extends AnyfareError {
  readonly code = 'payment_invalid';
  // The facilitator's invalidReason, or the rail's own, for the log
  readonly reason: string | undefined;
  readonly facilitator: string | undefined;

  constructor(message: string, options?: ErrorOptions & { readonly reason?: string; readonly facilitator?: string }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });

    this.reason = options?.reason;
    this.facilitator = options?.facilitator;
  }
}

/**
 * An MPP payment couldn't be checked before forwarding: the Tempo RPC didn't answer, or the replay
 * store is down. Nothing was paid, and the upstream wasn't called.
 */
export class PaymentUnavailableError extends AnyfareError {
  readonly code = 'payment_unavailable';

  constructor() {
    super('The payment couldn\'t be checked right now. Nothing was paid. Retry the request.');
  }
}

/** Why a settlement failed, for the log: never part of the buyer's answer. */
export interface SettlementFailure {
  // `failed`: nothing was charged. `unknown`: the settlement follow-up repeats it.
  readonly outcome: 'failed' | 'unknown';
  // The facilitator's errorReason, or the RPC's short message
  readonly reason?: string;
  readonly transaction?: string;
  readonly facilitator?: string;
  readonly network?: string;
  readonly cause?: unknown;
}

/**
 * The settlement failed, or its outcome is unknown, so the response isn't sent. A failure charges
 * nothing. An unknown outcome is repeated by a worker, which flags it for review if it settles.
 */
export class SettlementFailedError extends AnyfareError {
  readonly code = 'settlement_failed';
  readonly outcome: SettlementFailure['outcome'] | undefined;
  readonly reason: string | undefined;
  readonly transaction: string | undefined;
  readonly facilitator: string | undefined;
  readonly network: string | undefined;

  constructor(failure?: SettlementFailure) {
    super('The payment couldn\'t be settled, so the response wasn\'t sent. Retry the request.', failure?.cause === undefined ? undefined : { cause: failure.cause });

    this.outcome = failure?.outcome;
    this.reason = failure?.reason;
    this.transaction = failure?.transaction || undefined;
    this.facilitator = failure?.facilitator;
    this.network = failure?.network;
  }
}

/** The ledger refused the hold: the balance, the daily budget, or the allowance. */
export class HoldRefusedError extends AnyfareError {
  readonly code: HoldRefusal;

  /** `topUpUrl`: where top-ups are taken. Given, an empty balance's message says how to add money. */
  constructor(refusal: HoldRefusal, topUpUrl?: string) {
    super(refusal === 'insufficient_balance' && topUpUrl !== undefined
      ? `The credits balance doesn't cover the price. Top up with POST ${topUpUrl} and the account's master key.`
      : refusalMessages[refusal]);

    this.code = refusal;
  }
}
