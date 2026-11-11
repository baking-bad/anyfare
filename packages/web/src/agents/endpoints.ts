import type { SiteSettings } from '../config';
import { exampleCall, exampleLink, type Hosts } from './examples';

// The one list of the endpoints an agent can call. llms-full.txt, the For agents page, its Markdown twin and
// its JSON are all built from it, so they say the same. Every entry is an endpoint that exists in the code:
// tests/agentsTruth.test.ts reads the API's and the proxy's source and fails when an entry has no route.
// To add an endpoint, add it here, with its `source`, and give it an example in examples.ts.

export type EndpointGroup = 'pay' | 'accounts' | 'topups' | 'public';
export type HostName = 'pay' | 'api';

export interface Endpoint {
  readonly id: string;
  readonly group: EndpointGroup;
  // `ANY` is every method the pay host routes; `SSE` is a GET that answers a stream of events
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'ANY' | 'SSE';
  readonly host: HostName;
  // As written for people: `:id` for a path part, `<host>` for a part the caller fills in
  readonly path: string;
  readonly summary: string;
  readonly who: string;
  // The id of its curl example in examples.ts, when it has one, and the ids of other examples that call it
  readonly example?: string;
  readonly alsoExamples?: readonly string[];
  // The query or the body, in words
  readonly request?: readonly string[];
  // The status of the success answer and its body: a JSON value or, for a stream, the text
  readonly answer: { readonly status: number; readonly json?: unknown; readonly text?: string; readonly headers?: Readonly<Record<string, string>> };
  // The error codes the endpoint can answer, as `status code`
  readonly errors: readonly string[];
  readonly notes?: readonly string[];
  // Where the code registers the route: the package, the method as written there, and the path as written there
  readonly source: { readonly package: 'api' | 'proxy'; readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'ANY'; readonly path: string };
}

export const groupTitles: Readonly<Record<EndpointGroup, string>> = {
  pay: 'The pay host',
  accounts: 'Accounts and payment keys',
  topups: 'Top-ups',
  public: 'Public reads',
};

export const groupOrder: readonly EndpointGroup[] = ['pay', 'accounts', 'topups', 'public'];

const time = '2026-11-12T09:00:00.000Z';
const masterErrors = ['401 unauthorized', '401 invalid_key', '401 wrong_key_type'] as const;
const publicErrors = ['429 rate_limited'] as const;

const keyView = {
  id: '<key id>',
  label: 'research',
  allowance: null,
  dailyBudget: '5',
  maxPrice: '0.05',
  expiresAt: null,
  createdAt: time,
  revokedAt: null,
  spent: { today: '0', total: '0' },
  remaining: { allowance: null, dailyBudget: '5' },
};

const topupView = {
  id: '<top-up id>',
  status: 'waiting',
  message: 'Waiting for your transfer',
  network: 'base',
  token: 'USDC',
  amount: '20',
  depositAddress: '<deposit address>',
  depositMemo: null,
  send: '20',
  sendAtLeast: '19.9',
  estimatedCredits: '19.8',
  payBy: '2026-11-12T10:00:00.000Z',
  addressExpiresAt: '2026-11-12T10:00:00.000Z',
  createdAt: time,
  updatedAt: time,
  deposited: null,
  credited: null,
  transaction: null,
  refunded: null,
  refundReason: null,
};

const call = {
  id: 'pay_…',
  at: time,
  service: 'pro-api.coinmarketcap.com',
  path: '/x402/v3/cryptocurrency/quotes/latest',
  method: 'GET',
  paidWith: 'base',
  apiPaidWith: 'base',
  payer: '0x…',
  amount: '0.01',
  status: 'paid',
  apiStatus: 200,
  ms: 340,
};

const byPeriod = <TValue>(value: TValue) => ({ today: value, '7d': value, '30d': value, all: value });

const serviceRow = {
  host: 'pro-api.coinmarketcap.com',
  paidEndpoints: 1,
  priceFrom: '0.01',
  currency: 'USD',
  calls: 12,
  buyers: 3,
  volume: '0.12',
  successRate: 1,
  p50Ms: 340,
  trend: [0, 0, 4, 8],
};

const share = { paidWith: 'base', calls: 12, volume: '0.12' };

/** Every endpoint, in the order the page and the files list them. */
export const endpoints: readonly Endpoint[] = [
  {
    id: 'check', group: 'pay', method: 'GET', host: 'pay', path: '/_/check?url=<link>', summary: 'Is a link payable, at what price, and what we quote. Free, and pays nothing', who: 'No key', example: 'check',
    request: ['`url`: the API\'s link, with or without `https://`. A query string in it stays.'],
    answer: {
      status: 200,
      json: {
        payable: true,
        target: `https://${exampleLink}`,
        price: { amount: '0.01', currency: 'USD', asset: 'base-usdc', network: 'eip155:8453' },
        quote: { amount: '0.01', fee: '0', currency: 'USD' },
        link: `<pay host>/${exampleLink}`,
      },
    },
    errors: ['429 rate_limited'],
    notes: [
      'A link that can\'t be paid is still a `200`: `{ "payable": false, "reason": "...", "message": "..." }`. The reasons are `invalid_target` (not a link), `host_not_allowed` (a host we don\'t route to, our own host, or a private address), `not_payable` (the API asks for no payment), `unsupported_payment` (it asks in a way we don\'t pay) and `upstream_unavailable` (it didn\'t answer).',
      '`price` is what the API asks. `quote` is what you pay through Anyfare, in USD. `link` is the link to call.',
    ],
    source: { package: 'proxy', method: 'GET', path: '/_/check' },
  },
  {
    id: 'routed', group: 'pay', method: 'ANY', host: 'pay', path: '/<host>/<path>', summary: 'Pay any x402 or MPP API: put the pay host in front of its link, without `https://`', who: 'Payment key, x402 or MPP',
    example: 'unpaid', alsoExamples: ['paid-call'],
    request: ['Any method: GET, HEAD, POST, PUT, PATCH, DELETE or OPTIONS. The body and the query go to the API as they are.', 'Send exactly one of: `Authorization: Bearer <payment key>`, `PAYMENT-SIGNATURE` (x402), or `Authorization: Payment ...` (MPP). Without one the answer is the `402`.'],
    answer: { status: 402, text: 'The combined 402 (see "The 402" below). With a payment: the API\'s own answer, and the receipt header.' },
    errors: ['400 invalid_target', '400 host_not_allowed', '400 not_payable', '400 multiple_payment_methods', '401 invalid_key', '401 wrong_key_type', '402 insufficient_balance', '402 key_budget_exceeded', '402 key_allowance_exceeded', '402 key_price_limit', '402 payment_invalid', '429 rate_limited', '502 unsupported_payment', '502 quote_exceeded', '502 settlement_failed', '502 response_too_large', '503 upstream_unavailable', '503 payment_unavailable', '503 facilitator_unavailable'],
    notes: ['You pay only for a `2xx` answer. Any other answer costs nothing.'],
    source: { package: 'proxy', method: 'ANY', path: '/*' },
  },
  {
    id: 'key', group: 'pay', method: 'GET', host: 'pay', path: '/_/key', summary: 'The limits of a payment key and what is left of them, and the balance', who: 'Payment key', example: 'key-status',
    answer: {
      status: 200,
      json: { ...keyView, revokedAt: undefined, remaining: { allowance: null, dailyBudget: '5', balance: '0.1' } },
    },
    errors: ['401 unauthorized', '401 invalid_key', '401 wrong_key_type', '429 rate_limited'],
    notes: ['`remaining.balance` is what the account can spend now.'],
    source: { package: 'proxy', method: 'GET', path: '/_/key' },
  },
  {
    id: 'signup', group: 'accounts', method: 'POST', host: 'api', path: '/v1/accounts', summary: 'Sign up. Returns the master key, once', who: 'No key', example: 'signup', alsoExamples: ['signup-to-file'],
    request: ['No body.'],
    answer: {
      status: 201,
      json: { id: '<account id>', createdAt: time, masterKey: 'afm_live_…', freeCredits: '0.1', notice: 'Store the master key now: it is shown only once. A lost master key can\'t be recovered, and the account is lost with it.' },
    },
    errors: ['429 rate_limited'],
    notes: ['`freeCredits` is the gift of this sign-up in USD. It is `"0"` when there is none: a new account may get free Credits, and this answer says how much.'],
    source: { package: 'api', method: 'POST', path: '/v1/accounts' },
  },
  {
    id: 'account', group: 'accounts', method: 'GET', host: 'api', path: '/v1/account', summary: 'The account the master key belongs to', who: 'Master key', example: 'account',
    answer: { status: 200, json: { id: '<account id>', createdAt: time } },
    errors: masterErrors,
    source: { package: 'api', method: 'GET', path: '/v1/account' },
  },
  {
    id: 'rotate', group: 'accounts', method: 'POST', host: 'api', path: '/v1/account/master-key/rotate', summary: 'A new master key. The old one stops working at once', who: 'Master key', example: 'rotate',
    answer: { status: 200, json: { masterKey: 'afm_live_…' } },
    errors: masterErrors,
    notes: ['Save the new key before you do anything else: it is shown once.'],
    source: { package: 'api', method: 'POST', path: '/v1/account/master-key/rotate' },
  },
  {
    id: 'make-key', group: 'accounts', method: 'POST', host: 'api', path: '/v1/keys', summary: 'Make a payment key with limits. The key is shown once', who: 'Master key', example: 'make-key',
    request: [
      'JSON body, every field optional: `label` (text, at most 60 characters), `dailyBudget` (USD per UTC day), `maxPrice` (USD per call), `allowance` (USD in all), `expiresAt` (a future time, ISO 8601).',
      'Amounts are decimal strings with at most 6 decimals, such as `"0.05"`. Without `dailyBudget` the key gets the platform\'s default.',
    ],
    answer: { status: 201, json: { ...keyView, key: 'af_live_…' } },
    errors: ['400 invalid_request', ...masterErrors],
    source: { package: 'api', method: 'POST', path: '/v1/keys' },
  },
  {
    id: 'list-keys', group: 'accounts', method: 'GET', host: 'api', path: '/v1/keys', summary: 'Every payment key of the account, with what each spent', who: 'Master key', example: 'list-keys',
    answer: { status: 200, json: { keys: [keyView] } },
    errors: masterErrors,
    notes: ['It never returns a key itself.'],
    source: { package: 'api', method: 'GET', path: '/v1/keys' },
  },
  {
    id: 'change-key', group: 'accounts', method: 'PATCH', host: 'api', path: '/v1/keys/:id', summary: 'Change the limits of a payment key', who: 'Master key', example: 'change-key',
    request: ['JSON body with the fields to change: `label`, `allowance`, `dailyBudget`, `maxPrice`, `expiresAt`. `null` clears a limit that is optional. A field you leave out stays as it is.'],
    answer: { status: 200, json: { ...keyView, dailyBudget: '10', maxPrice: null, remaining: { allowance: null, dailyBudget: '10' } } },
    errors: ['400 invalid_request', '404 not_found', ...masterErrors],
    source: { package: 'api', method: 'PATCH', path: '/v1/keys/:id' },
  },
  {
    id: 'revoke-key', group: 'accounts', method: 'DELETE', host: 'api', path: '/v1/keys/:id', summary: 'Revoke a payment key. It stops working at once', who: 'Master key', example: 'revoke-key',
    answer: { status: 200, json: { id: '<key id>', revokedAt: time } },
    errors: ['404 not_found', ...masterErrors],
    source: { package: 'api', method: 'DELETE', path: '/v1/keys/:id' },
  },
  {
    id: 'balance', group: 'accounts', method: 'GET', host: 'api', path: '/v1/balance', summary: 'The Credits balance: available, and held for calls in flight', who: 'Master key', example: 'balance',
    answer: { status: 200, json: { available: '0.1', held: '0' } },
    errors: masterErrors,
    source: { package: 'api', method: 'GET', path: '/v1/balance' },
  },
  {
    id: 'payments', group: 'accounts', method: 'GET', host: 'api', path: '/v1/payments', summary: 'Every call the account paid, newest first, in pages', who: 'Master key', example: 'payments',
    request: ['`limit`: 1 to 100, default 50. `after`: the `next` of the page before.'],
    answer: {
      status: 200,
      json: {
        payments: [{ id: 'pay_…', requestId: '<request id>', rail: 'credits', targetHost: 'pro-api.coinmarketcap.com', targetPath: '/x402/v3/cryptocurrency/quotes/latest', amount: '0.01', status: 'captured', createdAt: time, updatedAt: time }],
        next: null,
      },
    },
    errors: ['400 invalid_request', ...masterErrors],
    notes: ['`next` is `null` on the last page.'],
    source: { package: 'api', method: 'GET', path: '/v1/payments' },
  },
  {
    id: 'topup-options', group: 'topups', method: 'GET', host: 'api', path: '/v1/topups/options', summary: 'The networks and tokens a top-up takes, and the least to send on each', who: 'No key', example: 'topup-options',
    answer: {
      status: 200,
      json: { asset: 'USDC on NEAR', networks: [{ name: 'base', minimum: '1', tokens: [{ symbol: 'USDC', address: '0x…', decimals: 6 }] }] },
    },
    errors: ['503 topups_unavailable', '429 rate_limited'],
    notes: ['`minimum` is in USD. `tokens` is left out while the token list can\'t be read: ask again in a moment.'],
    source: { package: 'api', method: 'GET', path: '/v1/topups/options' },
  },
  {
    id: 'topup', group: 'topups', method: 'POST', host: 'api', path: '/v1/topups', summary: 'Ask for a deposit address: send a token there and the balance grows', who: 'Master key', example: 'topup',
    request: ['JSON body, all three fields required: `network` and `token` as `GET /v1/topups/options` names them, and `amount` in that token\'s units, such as `"20"`.'],
    answer: { status: 201, json: topupView },
    errors: ['400 unsupported_network', '400 unknown_token', '400 ambiguous_token', '400 invalid_amount', '400 amount_too_small', '400 topup_refused', '429 rate_limited', '502 topup_mismatch', '503 topups_unavailable', ...masterErrors],
    notes: ['Send at least `sendAtLeast` to `depositAddress` before `payBy`. When `depositMemo` is not `null`, send it with the transfer. Credits are the USDC on NEAR the swap delivers.'],
    source: { package: 'api', method: 'POST', path: '/v1/topups' },
  },
  {
    id: 'topup-status', group: 'topups', method: 'GET', host: 'api', path: '/v1/topups/:id', summary: 'Where a top-up is', who: 'Master key', example: 'topup-status',
    answer: { status: 200, json: { ...topupView, status: 'credited', message: 'Added to your balance', deposited: '20', credited: '19.8', transaction: '<transaction id>' } },
    errors: ['404 not_found', '503 topups_unavailable', ...masterErrors],
    notes: ['There is no list of top-ups: keep the `id`.'],
    source: { package: 'api', method: 'GET', path: '/v1/topups/:id' },
  },
  {
    id: 'catalog', group: 'public', method: 'GET', host: 'api', path: '/v1/catalog', summary: 'The endpoints Anyfare has routed, with prices and the ways to pay', who: 'No key', example: 'catalog',
    request: ['`q`: part of a host or path. `maxPrice`: USD. `limit`: 1 to 100, default 20. `cursor`: the `next` of the page before.'],
    answer: {
      status: 200,
      json: {
        endpoints: [{
          id: `routed:${exampleLink}`,
          host: 'pro-api.coinmarketcap.com',
          path: '/x402/v3/cryptocurrency/quotes/latest',
          title: exampleLink,
          summary: 'A paid API that Anyfare routes payments to. Unverified: its owner hasn\'t registered it.',
          priceFrom: '0.01',
          currency: 'USD',
          methods: ['credits', 'x402', 'mpp'],
          verified: false,
          updatedAt: time,
          link: `<pay host>/${exampleLink}`,
        }],
        next: null,
      },
    },
    errors: ['400 invalid_request', ...publicErrors],
    source: { package: 'api', method: 'GET', path: '/v1/catalog' },
  },
  {
    id: 'calls', group: 'public', method: 'GET', host: 'api', path: '/v1/calls', summary: 'Finished calls through Anyfare, newest first, in pages', who: 'No key', example: 'calls',
    request: ['`paidWith`: near, base, solana, tempo or credits. `status`: paid or free. `service`: part of a host. `host`: an exact host. `endpoint`: an exact path. `page`: from 1. `size`: 1 to 100, default 20.'],
    answer: { status: 200, json: { calls: [call], page: 1, size: 3, total: 1, totalCapped: false } },
    errors: ['400 invalid_request', ...publicErrors],
    notes: ['`total` is counted up to a cap: `totalCapped` is `true` when there are more. A Credits buyer is never named: `payer` is `null`.'],
    source: { package: 'api', method: 'GET', path: '/v1/calls' },
  },
  {
    id: 'calls-stream', group: 'public', method: 'SSE', host: 'api', path: '/v1/calls/stream', summary: 'Calls as they finish, as server-sent events. The same filters as the list', who: 'No key', example: 'calls-stream',
    answer: {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      text: `retry: 3000\n\nevent: call\ndata: ${JSON.stringify(call)}\n\n: ping`,
    },
    errors: ['429 rate_limited', '503 shutting_down'],
    notes: ['A comment line `: ping` comes every 15 seconds. Open streams are limited per address; over the limit the answer is `429` with `Retry-After`.'],
    source: { package: 'api', method: 'GET', path: '/v1/calls/stream' },
  },
  {
    id: 'receipt', group: 'public', method: 'GET', host: 'api', path: '/v1/calls/:id', summary: 'The public receipt of one call', who: 'No key', example: 'receipt',
    answer: {
      status: 200,
      json: {
        id: 'pay_…',
        at: time,
        status: 'paid',
        apiStatus: 200,
        service: 'pro-api.coinmarketcap.com',
        method: 'GET',
        path: '/x402/v3/cryptocurrency/quotes/latest',
        buyer: { paidWith: 'credits', network: null, asset: 'Credits', amount: '0.01', payer: null, transaction: null, explorerUrl: null, settledAt: time },
        api: { paidWith: 'base', network: 'eip155:8453', asset: 'USDC', amount: '0.01', payTo: '0x…', transaction: '0x…', explorerUrl: null, status: 'settled' },
        apiPrice: '0.01',
        fee: '0',
        ms: { api: 340, total: 520 },
        steps: [{ step: 'received', at: time }, { step: 'authorized', at: time }, { step: 'api_signed', at: time }, { step: 'api_answered', at: time }, { step: 'settled', at: time }],
      },
    },
    errors: ['404 not_found', ...publicErrors],
    notes: ['`api` is `null` when we never paid the API. The last step is `settled` for a paid call and `released` for a free one, and is there only when the payment is final.'],
    source: { package: 'api', method: 'GET', path: '/v1/calls/:id' },
  },
  {
    id: 'stats', group: 'public', method: 'GET', host: 'api', path: '/v1/stats', summary: 'Platform numbers: calls, volume, buyers, services, how buyers paid, top-ups', who: 'No key', example: 'stats',
    answer: {
      status: 200,
      json: {
        updatedAt: time,
        calls: byPeriod(12),
        volume: { ...byPeriod('0.12'), currency: 'USD' },
        buyers: byPeriod(3),
        services: byPeriod(1),
        byPaidWith: byPeriod([share]),
        topups: { '30d': { count: 1, usd: '20' }, all: { count: 1, usd: '20' } },
        daily: [{ day: '2026-11-12', calls: 12, volume: '0.12' }],
      },
    },
    errors: publicErrors,
    notes: ['Counted every few minutes. With nothing counted yet every number is `0` and `updatedAt` is `null`. `daily` is the last 30 UTC days, oldest first.'],
    source: { package: 'api', method: 'GET', path: '/v1/stats' },
  },
  {
    id: 'stats-live', group: 'public', method: 'GET', host: 'api', path: '/v1/stats/live', summary: 'Fresh numbers for today and the last 24 hours, and calls per minute', who: 'No key', example: 'stats-live',
    answer: {
      status: 200,
      json: {
        at: time,
        today: { calls: 12, volume: '0.12', buyers: 3, nearShare: 0.25 },
        last24h: { calls: 12, volume: '0.12', volumeBefore: '0.1' },
        perMinute: [{ minute: '2026-11-12T09:00:00.000Z', calls: 1 }],
      },
    },
    errors: publicErrors,
    source: { package: 'api', method: 'GET', path: '/v1/stats/live' },
  },
  {
    id: 'stats-top', group: 'public', method: 'GET', host: 'api', path: '/v1/stats/top', summary: 'The top services, endpoints, ways to pay and top-up tokens of a period', who: 'No key', example: 'stats-top',
    request: ['`period`: today, 7d, 30d or all. Default 30d.'],
    answer: {
      status: 200,
      json: {
        period: '7d',
        updatedAt: time,
        services: [{ host: 'pro-api.coinmarketcap.com', calls: 12 }],
        endpoints: [{ host: 'pro-api.coinmarketcap.com', path: '/x402/v3/cryptocurrency/quotes/latest', calls: 12 }],
        paidWith: [{ paidWith: 'base', calls: 12 }],
        topupTokens: [{ network: 'base', token: 'USDC', count: 1 }],
      },
    },
    errors: ['400 invalid_request', ...publicErrors],
    source: { package: 'api', method: 'GET', path: '/v1/stats/top' },
  },
  {
    id: 'services', group: 'public', method: 'GET', host: 'api', path: '/v1/services', summary: 'Services with at least one paid call: price, calls, buyers, volume', who: 'No key', example: 'services',
    request: ['`q`: part of a host. `sort`: calls, buyers, volume, endpoints or price. `page`: from 1. `size`: 1 to 100, default 20.'],
    answer: { status: 200, json: { services: [serviceRow], page: 1, size: 3, total: 1, totals: { services: 1, paidEndpoints: 1, calls30d: 12 }, updatedAt: time } },
    errors: ['400 invalid_request', ...publicErrors],
    notes: ['`calls`, `buyers` and `volume` are the last 30 days. `trend` is paid calls per UTC day, oldest first.'],
    source: { package: 'api', method: 'GET', path: '/v1/services' },
  },
  {
    id: 'service', group: 'public', method: 'GET', host: 'api', path: '/v1/services/:host', summary: 'One service: its numbers, endpoints, days, ways to pay and top buyers', who: 'No key', example: 'service',
    request: ['`period`: today, 7d, 30d or all. Default 30d.'],
    answer: {
      status: 200,
      json: {
        host: 'pro-api.coinmarketcap.com',
        period: '30d',
        updatedAt: time,
        paidEndpoints: 1,
        stats: { calls: 12, callsBefore: 8, volume: '0.12', buyers: 3, returningShare: 0.33, successRate: 1, failedCalls: 0, p50Ms: 340, p95Ms: 800 },
        endpoints: [{ path: '/x402/v3/cryptocurrency/quotes/latest', method: 'GET', priceNow: '0.01', calls: 12, buyers: 3, volume: '0.12', successRate: 1, p50Ms: 340, link: `<pay host>/${exampleLink}` }],
        daily: [{ day: '2026-11-12', calls: 12, volume: '0.12', buyers: 3 }],
        byPaidWith: [{ paidWith: 'base', calls: 12, share: 1, buyers: 3, volume: '0.12' }],
        topBuyers: { share: 1, buyers: [{ payer: '0x…', paidWith: 'base', calls: 12, spent: '0.12', lastCallAt: time }] },
      },
    },
    errors: ['400 invalid_request', '404 not_found', ...publicErrors],
    notes: ['`404` when no paid call has reached the host. A Credits buyer is listed with `payer: null` and `paidWith: "credits"`.'],
    source: { package: 'api', method: 'GET', path: '/v1/services/*' },
  },
  {
    id: 'endpoint-stats', group: 'public', method: 'GET', host: 'api', path: '/v1/endpoints/stats', summary: 'The numbers of one endpoint: calls, buyers, volume, days, ways to pay', who: 'No key', example: 'endpoint-stats',
    request: ['`host` and `path`, both required: the exact host and the path without a query. `period`: today, 7d, 30d or all. Default 30d.'],
    answer: {
      status: 200,
      json: {
        host: 'pro-api.coinmarketcap.com',
        path: '/x402/v3/cryptocurrency/quotes/latest',
        period: '30d',
        updatedAt: time,
        stats: { calls: 12, buyers: 3, volume: '0.12', successRate: 1, p50Ms: 340 },
        daily: [{ day: '2026-11-12', calls: 12 }],
        byPaidWith: [{ paidWith: 'base', calls: 12 }],
      },
    },
    errors: ['400 invalid_request', ...publicErrors],
    notes: ['An endpoint with no paid call answers `200` with zeros.'],
    source: { package: 'api', method: 'GET', path: '/v1/endpoints/stats' },
  },
];

/** The host an endpoint is on, as a URL of this deployment. */
export const hostUrl = (hosts: Pick<SiteSettings, 'apiUrl' | 'payUrl'>, host: HostName): string => host === 'pay' ? hosts.payUrl : hosts.apiUrl;

/** The endpoint's full address, such as `https://api.example.com/v1/keys/:id`. */
export const endpointUrl = (hosts: Pick<SiteSettings, 'apiUrl' | 'payUrl'>, endpoint: Endpoint): string => `${hostUrl(hosts, endpoint.host)}${endpoint.path}`;

/** The answer's JSON with the pay host written in where an example holds `<pay host>`. */
export const answerJson = (hosts: Hosts, endpoint: Endpoint): string | undefined => {
  if (endpoint.answer.json === undefined)
    return undefined;

  return JSON.stringify(endpoint.answer.json, null, 2).replaceAll('<pay host>', hosts.payUrl);
};

/** The link the examples call, for the files' prose. */
export const exampleTarget = { check: exampleLink, call: exampleCall } as const;
