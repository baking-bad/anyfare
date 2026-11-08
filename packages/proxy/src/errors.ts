import { AnyfareError, type ErrorStatusTable } from '@anyfare/common';

// Every AnyfareError code the proxy answers with, and its status. A code missing here answers an
// opaque 500.
export const errorStatuses = {
  // The link isn't /<host>/<path> with a DNS host
  invalid_target: 400,
  // A host we don't route to, and a target that asks for no payment
  host_not_allowed: 400,
  not_payable: 400,
  // No option we pay, or a paid retry above the quote. The buyer pays nothing.
  unsupported_payment: 502,
  quote_exceeded: 502,
  // Two or more payment credentials
  multiple_payment_methods: 400,
  // GET /_/key without a payment key
  unauthorized: 401,
  // An unknown, revoked, expired, or malformed payment key, and a master key
  invalid_key: 401,
  wrong_key_type: 401,
  // The hold or the key's limits refused the price
  insufficient_balance: 402,
  key_budget_exceeded: 402,
  key_allowance_exceeded: 402,
  key_price_limit: 402,
  // An x402 payment that doesn't match the price, or that the facilitator rejected. An MPP credential
  // that doesn't match, was used before, or that the Tempo node refuses.
  payment_invalid: 402,
  rate_limited: 429,
  // x402 and MPP: the settlement failed or its outcome is unknown, or the answer is over the buffer limit
  settlement_failed: 502,
  response_too_large: 502,
  // The target or the Signer failed: one opaque answer
  upstream_unavailable: 503,
  // A facilitator didn't answer a verify: nothing was paid
  facilitator_unavailable: 503,
  // MPP: the Tempo RPC or the replay store couldn't check the credential: nothing was paid
  payment_unavailable: 503,
  // Redis is down, such as for an x402 payment's claim: nothing was paid
  redis_not_ready: 503,
} as const satisfies ErrorStatusTable;

/** An x402 or MPP buyer's answer over the buffer limit. It isn't sent, and the buyer's payment is cancelled. */
export class ResponseTooLargeError extends AnyfareError {
  readonly code = 'response_too_large';

  constructor() {
    super('The response is over the size a payment can wait for, so it wasn\'t sent. Nothing was charged.');
  }
}

/** `GET /_/key` without a payment key. */
export class KeyRequiredError extends AnyfareError {
  readonly code = 'unauthorized';

  constructor() {
    super('GET /_/key needs a payment key: Authorization: Bearer <key>');
  }
}

/**
 * Any failure of the target or the Signer. One opaque answer: nothing about the target leaks. The
 * cause, such as the transport's error, is for the log only.
 */
export class UpstreamUnavailableError extends AnyfareError {
  readonly code = 'upstream_unavailable';

  constructor(options?: ErrorOptions) {
    super('The upstream is unavailable', options);
  }
}
