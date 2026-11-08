import type { MicroUsd } from '@anyfare/common';

import type { NewPayment, Payment } from './payments.js';

/** Why a hold is refused. Each is a `402` for the buyer. */
export const holdRefusals = ['insufficient_balance', 'key_budget_exceeded', 'key_allowance_exceeded'] as const;
export type HoldRefusal = typeof holdRefusals[number];

export interface HoldInput {
  // A credits payment: rail `credits`, with its buyer and key
  readonly payment: NewPayment & { readonly rail: 'credits'; readonly buyerAccountId: string; readonly keyId: string };
  // The key's limits that count against its spend
  readonly dailyBudget: MicroUsd;
  readonly allowance: MicroUsd | undefined;
}

export type HoldResult =
  | { readonly ok: true; readonly payment: Payment }
  | { readonly ok: false; readonly refusal: HoldRefusal };

/**
 * A settled on-chain payment to book (x402, MPP). Its fee is fixed in its quote: the payment's amount
 * less the target's price.
 */
export interface SettleInput {
  readonly paymentId: string;
  // The asset the buyer paid in, by its registry name, such as base-usdc: its treasury took the money in
  readonly asset: string;
  readonly transactionHash: string | undefined;
  // The settle response, as the rail sends it to the buyer
  readonly receipt: string | undefined;
  // The buyer paid and got no response
  readonly needsReview: boolean;
}

/** A captured or settled payment, and the platform's fee on it: the quote less the target's price. */
export interface CaptureResult {
  readonly payment: Payment;
  readonly fee: MicroUsd;
}

/** A buyer's credits: what they can spend, and what is held for calls in flight. */
export interface CreditsBalance {
  readonly available: MicroUsd;
  readonly held: MicroUsd;
}

/** A key's spend so far: today's, by the UTC day, and over its life. */
export interface KeySpend {
  readonly today: MicroUsd;
  readonly total: MicroUsd;
}

/** One page of a buyer's payments, newest first. */
export interface PaymentPage {
  readonly payments: readonly Payment[];
  // Where the next page starts, or undefined on the last one
  readonly next: string | undefined;
}
