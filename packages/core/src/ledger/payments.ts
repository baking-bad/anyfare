import { AnyfareError, type MicroUsd } from '@anyfare/common';

// The `payments` table: one row per paid call, on every rail. Every payment is a routed call to a
// target host and path.

export const paymentStatuses = ['held', 'verified', 'captured', 'settling', 'settled', 'released', 'cancelled', 'failed'] as const;
export type PaymentStatus = typeof paymentStatuses[number];

export const railNames = ['credits', 'x402', 'mpp'] as const;
export type RailName = typeof railNames[number];

/** Recorded before money moves at the end of a call: billable means a 2xx answer. */
export const billingDecisions = ['billable', 'not_billable'] as const;
export type BillingDecision = typeof billingDecisions[number];

// Where each status may go. Credits hold, then capture or release. x402 and MPP verify, then
// settle (maybe through settling) or cancel. Everything else is final.
const nextStatuses: Readonly<Record<PaymentStatus, readonly PaymentStatus[]>> = {
  held: ['captured', 'released'],
  verified: ['settling', 'settled', 'cancelled', 'failed'],
  settling: ['settled', 'failed'],
  captured: [],
  settled: [],
  released: [],
  cancelled: [],
  failed: [],
};

/** The statuses a payment starts in: held for credits, verified for x402 and MPP. */
export const initialPaymentStatuses = ['held', 'verified'] as const satisfies readonly PaymentStatus[];
export type InitialPaymentStatus = typeof initialPaymentStatuses[number];

/** Whether a payment may move from one status to another. */
export const canChangePaymentStatus = (from: PaymentStatus, to: PaymentStatus): boolean => nextStatuses[from].includes(to);

/** The statuses a payment may move to `to` from. */
export const statusesBefore = (to: PaymentStatus): readonly PaymentStatus[] => paymentStatuses.filter(from => canChangePaymentStatus(from, to));

/** What a paid call is, as recorded when it is authorized. */
export interface NewPayment {
  readonly id: string;
  readonly requestId: string | undefined;
  readonly rail: RailName;
  // The credits account that pays, when known. x402 and MPP payers may have none.
  readonly buyerAccountId: string | undefined;
  // The payment key, for credits
  readonly keyId: string | undefined;
  // The call's target
  readonly targetHost: string;
  readonly targetPath: string;
  // On-chain rails: the network, the asset, and the amount in the asset's atomic units
  readonly network: string | undefined;
  readonly asset: string | undefined;
  readonly atomicAmount: bigint | undefined;
  // The price in micro-USD
  readonly amount: MicroUsd;
}

export interface Payment extends NewPayment {
  readonly status: PaymentStatus;
  // The platform's share, set when the payment is captured or settled
  readonly fee: MicroUsd | undefined;
  readonly decision: BillingDecision | undefined;
  readonly upstreamStatus: number | undefined;
  readonly upstreamLatencyMs: number | undefined;
  readonly transactionHash: string | undefined;
  readonly receipt: string | undefined;
  readonly needsReview: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** The change isn't allowed from the payment's current status. */
export class InvalidPaymentStatusChangeError extends AnyfareError {
  readonly code = 'invalid_payment_status_change';
  readonly paymentId: string;

  constructor(paymentId: string, from: PaymentStatus | undefined, to: PaymentStatus) {
    super(from === undefined
      ? `The payment ${paymentId} doesn't exist, so it can't become ${to}`
      : `The payment ${paymentId} can't go from ${from} to ${to}`);

    this.paymentId = paymentId;
  }
}

/** The payment is finished, or doesn't exist, so its billing decision can't be recorded. */
export class PaymentFinalizedError extends AnyfareError {
  readonly code = 'payment_finalized';
  readonly paymentId: string;

  constructor(paymentId: string, status: PaymentStatus | undefined) {
    super(status === undefined
      ? `The payment ${paymentId} doesn't exist`
      : `The payment ${paymentId} is ${status}, so its billing decision can't change`);

    this.paymentId = paymentId;
  }
}

/** The UTC date of a moment: the day a daily budget counts. */
export const utcDay = (moment: Date): string => moment.toISOString().slice(0, 10);

/** An operator reused a credit's reference for another account or amount: references are idempotency keys. */
export class CreditReferenceConflictError extends AnyfareError {
  readonly code = 'idempotency_conflict';

  constructor() {
    super('This reference was already used for another credit: another account or amount');
  }
}
