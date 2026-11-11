import { errorBodySchema } from '@anyfare/common';

import { paidWithValues } from './view.js';

// Fastify schemas of the public reads of calls. A response schema also keeps out any field it doesn't name.

const string = { type: 'string' } as const;
const time = { type: 'string', format: 'date-time' } as const;
const nullable = <TType extends string>(type: TType) => ({ type: [type, 'null'] }) as const;
const object = <TProperties extends Record<string, unknown>>(properties: TProperties) => ({
  type: 'object', properties, required: Object.keys(properties), additionalProperties: false,
}) as const;

/** The error envelope, for the statuses a public read answers with. */
export const errorSchema = errorBodySchema;

// Text without a NUL, which Postgres can't take
const noNul = '^[^\\u0000]*$';

// The filters the list and the stream share
const filters = {
  paidWith: { type: 'string', enum: [...paidWithValues] },
  // A part of the host, without case, searched in the newest calls. Empty: no filter.
  service: { type: 'string', maxLength: 100, pattern: noNul },
  // The exact host, with its port when it has one: a name of at most 253 characters and a port of 5 digits.
  // Empty: no filter.
  host: { type: 'string', maxLength: 259, pattern: noNul },
  // The exact path. Empty: no filter.
  endpoint: { type: 'string', maxLength: 2_048, pattern: noNul },
  status: { type: 'string', enum: ['paid', 'free'] },
} as const;

// Pages reach as far as the count goes
export const countCap = 10_000;

export const listQuerySchema = {
  type: 'object',
  properties: {
    ...filters,
    page: { type: 'integer', minimum: 1, maximum: countCap, default: 1 },
    size: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
  },
  additionalProperties: false,
} as const;

export const streamQuerySchema = { type: 'object', properties: filters, additionalProperties: false } as const;

export const receiptParamsSchema = {
  type: 'object',
  properties: { id: { type: 'string', minLength: 1, maxLength: 128 } },
  required: ['id'],
  additionalProperties: false,
} as const;

export const callSchema = object({
  id: string,
  at: time,
  service: string,
  path: string,
  method: nullable('string'),
  paidWith: string,
  apiPaidWith: nullable('string'),
  payer: nullable('string'),
  amount: string,
  status: { type: 'string', enum: ['paid', 'free'] },
  apiStatus: nullable('integer'),
  ms: nullable('integer'),
});

export const listResponseSchema = object({
  calls: { type: 'array', items: callSchema },
  page: { type: 'integer' },
  size: { type: 'integer' },
  total: { type: 'integer' },
  totalCapped: { type: 'boolean' },
});

const nullableTime = { type: ['string', 'null'], format: 'date-time' } as const;

export const receiptSchema = object({
  id: string,
  at: time,
  status: { type: 'string', enum: ['paid', 'free'] },
  apiStatus: nullable('integer'),
  service: string,
  method: nullable('string'),
  path: string,
  buyer: object({
    paidWith: string,
    network: nullable('string'),
    asset: nullable('string'),
    amount: string,
    payer: nullable('string'),
    transaction: nullable('string'),
    explorerUrl: nullable('string'),
    settledAt: nullableTime,
  }),
  api: {
    type: ['object', 'null'],
    properties: {
      paidWith: string,
      network: string,
      asset: string,
      amount: string,
      payTo: string,
      transaction: nullable('string'),
      explorerUrl: nullable('string'),
      status: { type: 'string', enum: ['signed', 'settled', 'failed', 'unknown'] },
    },
    required: ['paidWith', 'network', 'asset', 'amount', 'payTo', 'transaction', 'explorerUrl', 'status'],
    additionalProperties: false,
  },
  apiPrice: nullable('string'),
  fee: nullable('string'),
  ms: object({ api: nullable('integer'), total: nullable('integer') }),
  steps: {
    type: 'array',
    items: object({
      step: { type: 'string', enum: ['received', 'authorized', 'api_signed', 'api_answered', 'settled', 'released'] },
      at: time,
    }),
  },
});

// Server-sent events: `retry`, then an `event: call` with the call as one line of JSON for each
// finished call, and a `: ping` comment every 15 s
export const streamResponseSchema = {
  200: {
    description: 'Server-sent events of finished calls: first a `retry`, then an `event: call` for each call finished after the stream opened, '
      + 'its `data` the call as one line of JSON, as `x-events` describes it, and a `: ping` comment every 15 seconds.',
    content: { 'text/event-stream': { schema: { type: 'string' } } },
  },
} as const;

/** The stream's events, by name, with the schema of their data. */
export const streamEvents = { call: callSchema } as const;
