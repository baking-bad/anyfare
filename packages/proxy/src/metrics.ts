import { Counter, Histogram, type Registry } from '@prometheus-io/client';

/**
 * What happened to a paid call's payment. Credits: held, then captured or released. x402 and MPP:
 * verified, then settled (or settling) or cancelled, or settlement_failed. A refused payment is
 * payment_invalid when the payment itself was wrong, refused otherwise.
 */
export type PaymentOutcome =
  | 'challenged' | 'held' | 'verified' | 'refused' | 'payment_invalid' | 'captured' | 'released' | 'settled' | 'cancelled' | 'settlement_failed'
  | 'finalize_failed';

/**
 * What a routed call came to:
 * - quoted: the buyer got the quote, as the combined 402 or a payable `GET /_/check`;
 * - paid: the target took our payment and answered 2xx, so the buyer is charged;
 * - refused_host, not_payable, unsupported: the link was refused before any payment;
 * - signer_refused: the Signer didn't sign, or couldn't be reached;
 * - target_refused: the target refused our payment on the paid retry;
 * - loss: the target kept our payment while the buyer wasn't charged.
 */
export type RoutingOutcome = 'quoted' | 'paid' | 'refused_host' | 'not_payable' | 'unsupported' | 'signer_refused' | 'target_refused' | 'loss';

export interface ProxyMetrics {
  keyCacheLookup(result: 'hit' | 'miss'): void;
  invalidation(kind: string): void;
  reconnect(): void;
  /** One target call: its status, or the reason it failed. */
  upstream(outcome: { readonly status: number } | { readonly reason: string }, seconds: number): void;
  payment(rail: string, outcome: PaymentOutcome): void;
  routing(outcome: RoutingOutcome): void;
  rateLimited(limit: string): void;
  rateLimiterError(): void;
}

/**
 * The proxy's metrics on the internal port: target latency and errors, payment key cache hits and
 * misses, invalidation events, payments by rail and outcome, routed calls by outcome, and rate limits.
 * Target hosts are unbounded, so no label carries one.
 */
export const createProxyMetrics = (registry: Registry): ProxyMetrics => {
  const keyCacheLookups = new Counter({
    name: 'proxy_key_cache_lookups_total',
    help: 'Payment key cache lookups, by result: hit or miss',
    labelNames: ['result'] as const,
    registers: [registry],
  });
  const invalidations = new Counter({
    name: 'proxy_invalidation_events_total',
    help: 'Invalidation events received, by kind',
    labelNames: ['kind'] as const,
    registers: [registry],
  });
  const reconnects = new Counter({
    name: 'proxy_invalidation_reconnects_total',
    help: 'Times the invalidation subscription came back after a drop, each clearing the payment key cache',
    registers: [registry],
  });
  const upstreamDuration = new Histogram({
    name: 'proxy_upstream_request_duration_seconds',
    help: 'Target latency until the response headers, by status, or "error"',
    labelNames: ['status'] as const,
    registers: [registry],
  });
  const upstreamErrors = new Counter({
    name: 'proxy_upstream_errors_total',
    help: 'Target calls that got no answer, by reason',
    labelNames: ['reason'] as const,
    registers: [registry],
  });
  const payments = new Counter({
    name: 'proxy_payments_total',
    help: 'Paid calls by rail and outcome: challenged (402), held or verified, refused or payment_invalid, captured or settled, released or cancelled, settlement_failed, finalize_failed',
    labelNames: ['rail', 'outcome'] as const,
    registers: [registry],
  });
  const routing = new Counter({
    name: 'proxy_routing_total',
    help: 'Routed calls by outcome: quoted, paid, refused_host, not_payable, unsupported, signer_refused, target_refused, loss',
    labelNames: ['outcome'] as const,
    registers: [registry],
  });
  const rateLimited = new Counter({
    name: 'proxy_rate_limited_total',
    help: 'Requests answered with 429 rate_limited, by limit',
    labelNames: ['limit'] as const,
    registers: [registry],
  });
  const rateLimiterErrors = new Counter({
    name: 'proxy_rate_limiter_errors_total',
    help: 'Rate limit checks that failed, so the request went through',
    registers: [registry],
  });

  return {
    keyCacheLookup: result => keyCacheLookups.inc({ result }),
    invalidation: kind => invalidations.inc({ kind }),
    reconnect: () => reconnects.inc(),
    upstream: (outcome, seconds) => {
      upstreamDuration.observe({ status: 'status' in outcome ? String(outcome.status) : 'error' }, seconds);
      if ('reason' in outcome)
        upstreamErrors.inc({ reason: outcome.reason });
    },
    payment: (rail, outcome) => payments.inc({ rail, outcome }),
    routing: outcome => routing.inc({ outcome }),
    rateLimited: limit => rateLimited.inc({ limit }),
    rateLimiterError: () => rateLimiterErrors.inc(),
  };
};
