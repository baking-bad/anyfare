import type { FastifySchema } from 'fastify';

// What the OpenAPI document says of the routed call. It takes any method, body and query, and answers with the paid
// API's own answer, so no schema of the route can describe it: these words do. The route has no schema Fastify
// validates or serializes with.

const string = { type: 'string' } as const;
const anything = { '*/*': { schema: {} } } as const;
const textHeader = (description: string) => ({ description, schema: string });

const creditsSchema = {
  type: 'object',
  description: 'Pay with Credits: send a payment key as Authorization: Bearer <key>.',
  properties: {
    price: { type: 'string', description: 'The quote, in USD' },
    currency: { type: 'string', enum: ['USD'] },
    authorization: { type: 'string', description: 'How the payment key goes in' },
    signup: { type: 'object', description: 'Where an account is made, on the Platform API', properties: { method: string, url: string }, required: ['method', 'url'] },
    topUp: {
      type: 'object',
      description: 'Where Credits are bought with a token, when this host takes top-ups',
      properties: { method: string, url: string, options: string },
      required: ['method', 'url', 'options'],
    },
  },
  required: ['price', 'currency', 'authorization', 'signup'],
} as const;

/** The combined 402's body: one part for each way this host takes the quote. */
export const paymentRequiredSchema = {
  type: 'object',
  description: 'The ways to pay the quote. The x402 fields are those of the PAYMENT-REQUIRED header, there when this host takes x402.',
  properties: {
    x402Version: { type: 'integer' },
    error: string,
    resource: { type: 'object', description: 'x402: the link the payment is for' },
    accepts: { type: 'array', items: { type: 'object' }, description: 'x402: one option for each token and network this host takes it in' },
    credits: creditsSchema,
  },
  required: ['credits'],
} as const;

const routedErrors = [
  'invalid_target', 'host_not_allowed', 'not_payable', 'multiple_payment_methods', 'invalid_key', 'wrong_key_type', 'insufficient_balance',
  'key_budget_exceeded', 'key_allowance_exceeded', 'key_price_limit', 'payment_invalid', 'not_found', 'rate_limited', 'unsupported_payment',
  'quote_exceeded', 'settlement_failed', 'response_too_large', 'upstream_unavailable', 'facilitator_unavailable', 'payment_unavailable',
  'redis_not_ready',
] as const;

/**
 * The routed call, `/*` to the router: one path in the document, `/{host}/{path}`, for every method it takes. Its words,
 * its parameters and its 402's body are said once, for the path; each method keeps its answers.
 */
export const routedCallSchema = {
  summary: 'Pay any x402 or MPP API: put this host in front of its link',
  description: [
    'The path stands for any paid API\'s link without `https://`. `{host}` is its host, with `:` and the port when it has one, and `{path}` '
    + 'its path. Both are written as they are: the slashes of the path and the colon of the port are not percent-encoded. The query is the '
    + 'request\'s own query string, sent on as it is.',
    'The call goes on to the API with its method and body, its content headers and its own `X-` headers, never its Authorization or its '
    + 'cookies. The API must ask for a payment in x402 or MPP.',
    'Without a payment the answer is the `402`: the quote, which is the API\'s price with our fee, and each way this host takes it. Call '
    + 'again with exactly one of the ways it names: a payment key as `Authorization: Bearer <key>`, an x402 version 2 payment as '
    + '`PAYMENT-SIGNATURE`, or an MPP credential as `Authorization: Payment ...`.',
    'With a payment, Anyfare pays the API and passes on its status, its body and its content headers. Only a `2xx` is charged, and it '
    + 'carries the receipt header of the way it was paid. Any other answer costs nothing; a `5xx` of the API is answered '
    + '`503 upstream_unavailable`.',
    'The first path segments this host keeps for itself are no links: `_`, `.well-known`, `favicon.ico`, `robots.txt` and `openapi.json`, '
    + 'in any case. A path that starts with one answers `404 not_found`, but for this host\'s own routes.',
  ].join('\n\n'),
  tags: ['pay'],
  // A payment key, or none: x402 and MPP go in headers of their own
  security: [{ paymentKey: [] }, {}],
  errors: routedErrors,
  openapi: {
    path: '/{host}/{path}',
    parameters: [
      { name: 'host', in: 'path', required: true, description: 'The paid API\'s host, such as api.example.com, with `:` and the port when it has one', schema: string },
      { name: 'path', in: 'path', required: true, description: 'The paid API\'s path, with its slashes as they are', schema: string },
      { name: 'PAYMENT-SIGNATURE', in: 'header', required: false, description: 'An x402 version 2 payment of the quote, when the 402 offers x402', schema: string },
    ],
    requestBody: { required: false, description: 'Sent on to the API as it is', content: anything },
    schemas: { PaymentRequired: paymentRequiredSchema },
    responses: {
      '2XX': {
        description: 'The paid API\'s answer, charged. It carries the receipt header of the way it was paid, and is never kept by a shared cache.',
        headers: {
          'Anyfare-Receipt': textHeader('Paid with a payment key: id="<payment ID>", amount="<USD>", currency="USD"'),
          'PAYMENT-RESPONSE': textHeader('Paid with x402: the settlement, as x402 writes it'),
          'Payment-Receipt': textHeader('Paid with MPP: the receipt, as MPP writes it'),
        },
        content: anything,
      },
      402: {
        description: 'Payment required: the quote, and the ways to pay it.',
        headers: {
          'PAYMENT-REQUIRED': textHeader('x402: the challenge, base64 of its JSON. There when this host takes x402'),
          'WWW-Authenticate': textHeader('MPP: a Payment challenge for each token this host takes. There when this host takes MPP'),
          'Cache-Control': textHeader('no-store'),
        },
        content: { 'application/json': { schema: { $ref: '#/components/schemas/PaymentRequired' } } },
      },
      default: { description: 'Any other answer of the paid API, passed on as it came. Not charged.', content: anything },
    },
  },
} as const satisfies FastifySchema;
