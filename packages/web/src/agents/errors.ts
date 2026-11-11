// Every error code an agent can meet on the two hosts, its status, and what to do. An error is always
// `{ "error": { "code": "...", "message": "..." } }`. tests/agentsTruth.test.ts checks each code against the
// source of the API, the pay host and the payment code.

export interface ErrorDoc {
  readonly code: string;
  readonly status: number;
  // Where it comes from
  readonly host: 'pay' | 'api' | 'both';
  // What to do
  readonly action: string;
}

export const errorDocs: readonly ErrorDoc[] = [
  { code: 'invalid_request', status: 400, host: 'api', action: 'The request is malformed. The message says what is wrong. Fix it and send it again.' },
  { code: 'invalid_target', status: 400, host: 'pay', action: 'The link is not /<host>/<path> with a DNS name. Check it with GET /_/check.' },
  { code: 'host_not_allowed', status: 400, host: 'pay', action: 'Anyfare does not route to this host: it is blocked, it is our own, or it is a private address. Use another API.' },
  { code: 'not_payable', status: 400, host: 'pay', action: 'The API asks for no payment, or not in a way a call can answer. Call it directly.' },
  { code: 'multiple_payment_methods', status: 400, host: 'pay', action: 'Send exactly one of a payment key, an x402 payment and an MPP payment.' },
  { code: 'unsupported_network', status: 400, host: 'api', action: 'Top-ups do not come from that network. The message lists the networks, and GET /v1/topups/options too.' },
  { code: 'unknown_token', status: 400, host: 'api', action: 'No such token on that network. Use a symbol or address from GET /v1/topups/options. Never send a key here.' },
  { code: 'ambiguous_token', status: 400, host: 'api', action: 'More than one token has that symbol. Send its contract address.' },
  { code: 'invalid_amount', status: 400, host: 'api', action: 'The amount has more decimals than the token has, or is not a plain decimal.' },
  { code: 'amount_too_small', status: 400, host: 'api', action: 'The top-up is worth less than the network\'s minimum. Send more.' },
  { code: 'topup_refused', status: 400, host: 'api', action: 'The swap service refused the quote. No address was made. Change the token or the amount.' },
  { code: 'unauthorized', status: 401, host: 'both', action: 'No key was sent. Send Authorization: Bearer <key>: the master key to the API host, a payment key to GET /_/key.' },
  { code: 'invalid_key', status: 401, host: 'both', action: 'The key is unknown, revoked, expired, or not a key. Ask your user for a new one.' },
  { code: 'wrong_key_type', status: 401, host: 'both', action: 'A master key went to the pay host, or a payment key to the API host. Use the other key.' },
  { code: 'insufficient_balance', status: 402, host: 'pay', action: 'The balance does not cover the price. Ask your user to top up, then call again.' },
  { code: 'key_budget_exceeded', status: 402, host: 'pay', action: 'The key\'s daily budget is spent. It resets at 00:00 UTC. Ask your user before you raise it.' },
  { code: 'key_allowance_exceeded', status: 402, host: 'pay', action: 'The key\'s allowance is spent. Ask your user for a new key or a higher allowance.' },
  { code: 'key_price_limit', status: 402, host: 'pay', action: 'The price is above the key\'s highest price per call. Ask your user before you raise it.' },
  { code: 'payment_invalid', status: 402, host: 'pay', action: 'The x402 or MPP payment does not match an option, was used before, or was refused. Nothing moved. Request the call again for the options and sign a new payment.' },
  { code: 'not_found', status: 404, host: 'api', action: 'No such thing for this account: a key, a top-up, or a call that is not finished.' },
  { code: 'rate_limited', status: 429, host: 'both', action: 'Too many requests from this address. Wait Retry-After seconds.' },
  { code: 'unsupported_payment', status: 502, host: 'pay', action: 'The API asks in a way Anyfare does not pay. Nothing was charged. Use another API.' },
  { code: 'quote_exceeded', status: 502, host: 'pay', action: 'The API raised its price after the quote. Nothing was charged. Check the link again.' },
  { code: 'settlement_failed', status: 502, host: 'pay', action: 'The payment could not be settled, so the answer was not sent. Retry the call.' },
  { code: 'response_too_large', status: 502, host: 'pay', action: 'The answer is too big to wait for a payment. Nothing was charged.' },
  { code: 'topup_mismatch', status: 502, host: 'api', action: 'The quote was not what you asked for, so no address was given. Nothing to send. Ask again.' },
  { code: 'upstream_unavailable', status: 503, host: 'pay', action: 'The API or our payer failed. Nothing was charged. Retry later.' },
  { code: 'facilitator_unavailable', status: 503, host: 'pay', action: 'The service that checks x402 payments did not answer. Nothing was paid. Retry.' },
  { code: 'payment_unavailable', status: 503, host: 'pay', action: 'A payment could not be checked, or another one on NEAR is in flight. Nothing was paid. Retry after Retry-After.' },
  { code: 'redis_not_ready', status: 503, host: 'pay', action: 'Anyfare is not ready. Nothing was paid. Retry in a moment.' },
  { code: 'topups_unavailable', status: 503, host: 'api', action: 'Top-ups are off, or the swap service did not answer. Nothing to send. Retry later.' },
  { code: 'stats_unavailable', status: 503, host: 'api', action: 'A public number could not be read within its bounds just now. Try again in a few seconds.' },
  { code: 'shutting_down', status: 503, host: 'api', action: 'The server is restarting. Open the stream again.' },
];
