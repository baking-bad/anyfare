import type { Store } from 'mppx';

import type { MicroUsd } from '@anyfare/common';
import type {
  BillingDecision, CaptureResult, HoldInput, HoldResult, InitialPaymentStatus, JsonObject, NewPayment, Payment, PaymentKey, PaymentStatus,
  SettleInput,
} from '@anyfare/core';

// The rails' ports: what they need from the ledger and from accounts and keys. The adapters live in
// `db`, and apps wire them. Nothing here knows Fastify or Drizzle.

/**
 * Port: the credits side of the ledger. Each operation is one database transaction, keyed by the
 * payment ID, so a retry never moves money twice.
 */
export interface CreditsLedger {
  /**
   * Moves the price from the buyer's available credits to held, counts it against the key's daily
   * budget and allowance, and records the payment as `held`, all at once. Refused when the balance
   * or a limit doesn't cover it. A second hold for the same payment returns the first.
   */
  hold(input: HoldInput): Promise<HoldResult>;
  /**
   * Charges a held payment: the target's price and the platform's fee, the rest of the quote, and
   * records it as `captured`. A second capture moves nothing.
   */
  capture(input: { readonly paymentId: string }): Promise<CaptureResult>;
  /** Gives a held payment back to the buyer, with the key's spend, and records it as `released`. A second release moves nothing. */
  release(input: { readonly paymentId: string }): Promise<{ readonly payment: Payment }>;
}

/** Port: the `payments` rows. Only the status changes the payment status graph allows go through. */
export interface PaymentRecorder {
  /**
   * Records a payment a rail authorized without a hold, such as a verified x402 payment. An MPP payment
   * knows its transaction hash before the broadcast.
   */
  create(payment: NewPayment & { readonly status: InitialPaymentStatus; readonly transactionHash?: string }): Promise<Payment>;
  /** Records the billing decision before the payment is finalized. */
  recordDecision(input: {
    readonly paymentId: string;
    readonly decision: BillingDecision;
    readonly upstreamStatus: number | undefined;
    readonly upstreamLatencyMs: number | undefined;
  }): Promise<Payment>;
  /**
   * Moves a payment to another status. Throws InvalidPaymentStatusChangeError for a change the graph
   * doesn't allow, and with `from`, unless the payment is in that status: of two writers that read the
   * same status, one wins.
   */
  changeStatus(input: {
    readonly paymentId: string;
    readonly to: PaymentStatus;
    readonly from?: PaymentStatus;
    readonly fee?: MicroUsd;
    readonly transactionHash?: string;
    readonly receipt?: string;
    readonly needsReview?: boolean;
    // The settle request to repeat while `settling`. Null clears it.
    readonly settlementRequest?: JsonObject | null;
  }): Promise<Payment>;
  find(paymentId: string): Promise<Payment | undefined>;
}

/**
 * Port: books a settled on-chain payment (x402, MPP) with its change to `settled`, in one database
 * transaction keyed by the payment ID. A second settle moves nothing.
 */
export interface SettlementLedger {
  settle(input: SettleInput): Promise<CaptureResult>;
}

/** Port: payment keys by hash, with their limits. Revoked keys aren't found; expiry is the rail's check. */
export interface KeyStore {
  findByHash(keyHash: string): Promise<PaymentKey | undefined>;
}

/**
 * Port: one-time claims, shared by every proxy replica, such as on an x402 payment's nonce, so one
 * signed payment pays for one call. The first claim of a key wins until its expiry or its release.
 */
export interface ClaimStore {
  /** True for the first claim of the key, until `expiresAtMs`. False while an earlier claim holds it. */
  tryClaim(key: string, expiresAtMs: number): Promise<boolean>;
  /** Gives the key up, so it can be claimed again. */
  release(key: string): Promise<void>;
}

/**
 * Port: the MPP replay store, `mppx`'s atomic key-value store. Shared by every proxy replica, so a
 * credential works once across all of them. `db` implements it on Redis.
 */
export type ReplayStore = Store.AtomicStore;
