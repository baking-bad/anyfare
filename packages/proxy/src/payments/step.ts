import { AnyfareError, formatUsd, type IdGenerator, type Logger, type LogSink, type MicroUsd } from '@anyfare/common';
import type { BillingDecision } from '@anyfare/core';
import {
  billingDecision, buildPaymentRequired, detectCredential, PaymentInvalidError, SettlementFailedError, type Authorization, type CredentialDetector,
  type PaymentRail, type PaymentRecorder, type PaymentRequired, type Quote, type Receipt, type RequestHeaders,
} from '@anyfare/payments';

import type { PaymentOutcome, ProxyMetrics } from '../metrics.js';
import type { ProxyLimits } from './limits.js';

// Payment IDs: `pay_<id>`
export const paymentIdPrefix = 'pay_';

/** What a paid call's outcome line reports, filled in as the call goes. */
export interface PaidCallTrace {
  // The routed target's host and path
  readonly subject: Readonly<Record<string, string>>;
  readonly verifyMs: number;
  upstreamMs?: number;
  // Undefined: no answer from the target
  upstreamStatus?: number | undefined;
  upstreamRequestId?: string;
  decision?: BillingDecision;
}

/** A call whose payment is authorized: what to finalize or abort once the answer is known. */
export interface PaidCall {
  readonly rail: PaymentRail;
  readonly authorization: Authorization;
  // The request's logger, so the call's lines carry its request ID
  readonly log: LogSink;
  readonly trace: PaidCallTrace;
}

export type PaymentStart =
  // No credential, or one whose rail isn't served: the combined 402
  | { readonly kind: 'challenge'; readonly response: PaymentRequired }
  // Authorized: pay the target, then call it
  | { readonly kind: 'paid'; readonly call: PaidCall };

/** A routed call's buyer side: the quote for the target, paid with credits, x402, or MPP. */
export interface RoutedCallInput {
  readonly headers: RequestHeaders;
  // The request's logger. Default: the step's.
  readonly log?: LogSink;
  // The client IP, for the unpaid limit
  readonly ip: string;
  readonly requestId: string;
  readonly host: string;
  readonly path: string;
  // The routing link, such as https://pay.anyfare.agents.bakingbad.dev/api.example.com/v1/pools
  readonly resource: string;
  // The target's price plus the routing fee
  readonly quote: MicroUsd;
}

/** What the target answered, for the billing decision. */
export interface TargetOutcome {
  // Undefined: no answer
  readonly status: number | undefined;
  readonly latencyMs: number;
  readonly upstreamRequestId?: string | undefined;
  // False when the answer never reached the buyer, such as one who left: never billable. Default: true.
  readonly delivered?: boolean;
}

/** The proxy's payment step: authorize before the target is paid, then decide, record, and finalize. */
export interface PaymentStep {
  /**
   * Detects the credential, checks the limits, and authorizes it at the quote, or returns the
   * combined 402. Throws a coded error for two credentials, a bad key, a refused hold, or a limit.
   */
  begin(input: RoutedCallInput): Promise<PaymentStart>;
  /**
   * Records the billing decision on the payment row before anything is finalized. The target's own
   * request ID, when it sent one, goes on the call's outcome line.
   */
  decide(call: PaidCall, outcome: TargetOutcome): Promise<BillingDecision>;
  /**
   * Captures after a billable answer, releases otherwise. Never throws: a failure is logged, and the
   * hold expiry worker finishes the payment from its recorded decision.
   */
  finish(call: PaidCall, decision: BillingDecision): Promise<void>;
  /**
   * Finalizes a rail that settles before the response (x402 and MPP) and returns its receipt. Throws
   * SettlementFailedError when the response must not go out.
   */
  settleNow(call: PaidCall): Promise<Receipt>;
  /** Waits for every finish in flight, so shutdown finishes or releases its holds. */
  drain(): Promise<void>;
}

export interface PaymentStepOptions {
  // The rails that take payments, in challenge order
  readonly rails: readonly PaymentRail[];
  // Every kind of credential, served or not, so two of any kind get 400
  readonly detectors: readonly CredentialDetector[];
  readonly recorder: Pick<PaymentRecorder, 'recordDecision'>;
  readonly limits: ProxyLimits;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  readonly metrics: Pick<ProxyMetrics, 'payment'>;
}

// Credits holds and captures; x402 and MPP verify and settle
const outcomes = (rail: PaymentRail): Readonly<Record<'authorized' | 'finalized' | 'aborted', PaymentOutcome>> => rail.settlesBeforeResponse
  ? { authorized: 'verified', finalized: 'settled', aborted: 'cancelled' }
  : { authorized: 'held', finalized: 'captured', aborted: 'released' };

// Refusals the buyer caused: logged at info with their code. Anything else is the platform's fault.
const buyerRefusals = new Set([
  'insufficient_balance', 'key_budget_exceeded', 'key_allowance_exceeded', 'key_price_limit', 'payment_invalid', 'invalid_key', 'wrong_key_type',
]);

const roundMs = (started: number): number => Math.round(performance.now() - started);

/** The fields every line about a paid call carries. */
const callFields = ({ rail, authorization, trace }: PaidCall): Record<string, unknown> => ({
  paymentId: authorization.paymentId,
  rail: rail.name,
  ...authorization.network === undefined ? {} : { network: authorization.network },
  ...authorization.asset === undefined ? {} : { asset: authorization.asset },
  amount: formatUsd(authorization.amount),
  ...trace.subject,
  ...trace.decision === undefined ? {} : { decision: trace.decision },
  verifyMs: trace.verifyMs,
  ...trace.upstreamMs === undefined ? {} : { upstreamMs: trace.upstreamMs },
  upstreamStatus: trace.upstreamStatus ?? null,
  ...trace.upstreamRequestId === undefined ? {} : { upstreamRequestId: trace.upstreamRequestId },
});

/** What a failed settlement says: its outcome, the facilitator's errorReason or the RPC's message, the transaction. */
const settlementFields = (error: SettlementFailedError): Record<string, unknown> => ({
  ...error.outcome === undefined ? {} : { outcome: error.outcome },
  ...error.reason === undefined ? {} : { reason: error.reason },
  ...error.transaction === undefined ? {} : { transaction: error.transaction },
  ...error.facilitator === undefined ? {} : { facilitator: error.facilitator },
});

export const createPaymentStep = ({ rails, detectors, recorder, limits, ids, logger, metrics }: PaymentStepOptions): PaymentStep => {
  const finishing = new Set<Promise<void>>();

  const settle = async (call: PaidCall, decision: BillingDecision): Promise<void> => {
    const { rail, authorization, log } = call;
    const started = performance.now();
    try {
      if (decision === 'billable')
        await rail.finalize(authorization);
      else
        await rail.abort(authorization);
      const outcome = outcomes(rail)[decision === 'billable' ? 'finalized' : 'aborted'];
      metrics.payment(rail.name, outcome);
      // One line per paid call
      log.info({ ...callFields(call), decision, paymentStatus: outcome, settleMs: roundMs(started) }, 'Paid call finished');
    }
    catch (error) {
      metrics.payment(rail.name, 'finalize_failed');
      // A ledger write that failed: the worker finishes the payment from its recorded decision
      log.error({ ...callFields(call), error, decision, paymentStatus: 'finalize_failed', settleMs: roundMs(started) },
        'Failed to finish a payment. The hold expiry worker finishes it.');
    }
  };

  return {
    begin: async ({ headers, ip, log = logger, requestId, host, path, resource, quote: price }) => {
      const subject = { host, path };
      const quote: Quote = {
        paymentId: `${paymentIdPrefix}${ids.next()}`,
        requestId,
        resource,
        priceMicroUsd: price,
        description: `${host}${path}, through Anyfare`,
        subject: { targetHost: host, targetPath: path },
      };
      const credential = detectCredential(detectors, headers);
      const rail = credential && rails.find(candidate => candidate.name === credential.rail);
      if (!credential || !rail) {
        await limits.unpaid(ip);
        metrics.payment(credential?.rail ?? 'none', 'challenged');

        return { kind: 'challenge', response: await buildPaymentRequired(rails, quote) };
      }

      if (credential.rail === 'credits' && credential.key.kind === 'payment')
        await limits.paymentKey(credential.key.hash);
      let authorization: Authorization;
      const started = performance.now();
      try {
        authorization = await rail.authorize(credential, { ...quote, log });
      }
      catch (error) {
        metrics.payment(rail.name, error instanceof PaymentInvalidError ? 'payment_invalid' : 'refused');
        const fields = { paymentId: quote.paymentId, rail: rail.name, amount: formatUsd(quote.priceMicroUsd), ...subject, verifyMs: roundMs(started) };
        const code = error instanceof AnyfareError ? error.code : undefined;
        // A refusal the buyer caused is info, with its code and the facilitator's reason
        if (code !== undefined && buyerRefusals.has(code)) {
          const { reason, facilitator } = error as Partial<PaymentInvalidError>;
          log.info({ ...fields, code, ...reason === undefined ? {} : { reason }, ...facilitator === undefined ? {} : { facilitator } }, 'Paid call refused');
        }
        // A facilitator, the Tempo RPC, or the replay store that failed: the platform's fault
        else
          log.warn({ ...fields, ...code === undefined ? {} : { code }, error }, 'Paid call refused: the payment couldn\'t be checked');
        throw error;
      }
      metrics.payment(rail.name, outcomes(rail).authorized);

      return { kind: 'paid', call: { rail, authorization, log, trace: { subject, verifyMs: roundMs(started) } } };
    },
    decide: async (call, { status, latencyMs, upstreamRequestId, delivered = true }) => {
      const { authorization, trace, log } = call;
      const decision = delivered ? billingDecision(status) : 'not_billable';
      trace.decision = decision;
      trace.upstreamStatus = status;
      trace.upstreamMs = latencyMs;
      if (upstreamRequestId !== undefined)
        trace.upstreamRequestId = upstreamRequestId;
      try {
        await recorder.recordDecision({ paymentId: authorization.paymentId, decision, upstreamStatus: status, upstreamLatencyMs: latencyMs });
      }
      catch (error) {
        // Without a recorded decision the worker releases: the buyer is never charged by mistake
        log.error({ error, paymentId: authorization.paymentId, decision }, 'Failed to record the billing decision');
      }

      return decision;
    },
    finish: async (call, decision) => {
      // Tracked from the call on, so a drain that starts right after sees it
      const finished = settle(call, decision);
      finishing.add(finished);
      try {
        await finished;
      }
      finally {
        finishing.delete(finished);
      }
    },
    settleNow: async call => {
      const { rail, authorization, log } = call;
      const started = performance.now();
      try {
        const receipt = await rail.finalize(authorization);
        metrics.payment(rail.name, 'settled');
        const { settlement } = receipt;
        const fields = {
          ...callFields(call), paymentStatus: settlement?.status ?? 'settled', settleMs: roundMs(started),
          ...settlement?.transaction === undefined ? {} : { transaction: settlement.transaction },
        };
        // Broadcast, not final yet, is the platform's to watch: the follow-up finishes it
        if (settlement?.status === 'settling')
          log.warn({ ...fields, reason: 'settlement_pending' }, 'Paid call finished: its settlement is pending');
        else
          log.info(fields, 'Paid call finished');

        return receipt;
      }
      catch (error) {
        metrics.payment(rail.name, 'settlement_failed');
        const fields = { ...callFields(call), settleMs: roundMs(started) };
        // A failed or unknown settlement says why; anything else, such as a ledger write, is an error
        if (error instanceof SettlementFailedError)
          log.warn({ ...fields, paymentStatus: error.outcome === 'unknown' ? 'settling' : 'failed', ...settlementFields(error) }, 'Paid call failed to settle');
        else
          log.error({ ...fields, paymentStatus: 'settlement_failed', error }, 'Paid call failed to settle');
        throw error;
      }
    },
    drain: async () => {
      while (finishing.size > 0)
        await Promise.allSettled([...finishing]);
    },
  };
};
