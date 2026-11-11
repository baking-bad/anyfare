import { listedStatuses, statsPeriods } from '@anyfare/core';

// Fastify schemas of the public numbers. A response schema also keeps out any field it doesn't name.

const string = { type: 'string' } as const;
const integer = { type: 'integer' } as const;
const number = { type: 'number' } as const;
const time = { type: 'string', format: 'date-time' } as const;
const day = { type: 'string', format: 'date' } as const;
const nullable = <TType extends string>(type: TType) => ({ type: [type, 'null'] }) as const;
const nullableTime = { type: ['string', 'null'], format: 'date-time' } as const;
const object = <TProperties extends Record<string, unknown>>(properties: TProperties, description?: string) => ({
  type: 'object', properties, required: Object.keys(properties), additionalProperties: false, ...description === undefined ? {} : { description },
}) as const;
const list = <TItems>(items: TItems) => ({ type: 'array', items }) as const;
const byPeriod = <TValue>(value: TValue) => object({ today: value, '7d': value, '30d': value, all: value });

const period = { type: 'string', enum: [...statsPeriods], default: '30d' } as const;
// A host name as routing keeps it, with a port when it has one: labels of letters, digits and hyphens, at
// least one dot, a name of at most 253 characters and a port of 5 digits. Any case: the routes lowercase it.
const host = {
  type: 'string', minLength: 1, maxLength: 259,
  pattern: '^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\\.)+[A-Za-z][A-Za-z0-9-]{0,62}(?::[0-9]{1,5})?$',
} as const;
// A path only: from its slash, without a query string or a NUL
const path = { type: 'string', minLength: 1, maxLength: 2_048, pattern: '^/[^?\\u0000]*$' } as const;
// Text without a NUL, which Postgres can't take
export const noNul = '^[^\\u0000]*$';
// Pages of services reach this far
export const maxServicesPage = 10_000;

// `newest`: the most recently listed first
export const servicesSorts = ['calls', 'buyers', 'volume', 'endpoints', 'price', 'newest'] as const;
// `paid`: a paid call through Anyfare reached it, or one of the service's endpoints. `checked`: only a payable check listed it.
const listedStatus = { type: 'string', enum: [...listedStatuses] } as const;

// The platform's numbers and the live ones take no query
export const noQuerySchema = { type: 'object', properties: {}, additionalProperties: false } as const;

export const periodQuerySchema = { type: 'object', properties: { period }, additionalProperties: false } as const;

export const servicesQuerySchema = {
  type: 'object',
  properties: {
    // A part of the host, without case. Empty: no filter.
    q: { type: 'string', maxLength: 100, pattern: noNul },
    sort: { type: 'string', enum: [...servicesSorts], default: 'calls' },
    page: { type: 'integer', minimum: 1, maximum: maxServicesPage, default: 1 },
    size: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
  },
  additionalProperties: false,
} as const;

// The host of `/v1/services/{host}`, which the route takes as the rest of its path
export const serviceParamsSchema = { type: 'object', properties: { '*': host }, required: ['*'], additionalProperties: false } as const;

export const endpointQuerySchema = { type: 'object', properties: { host, path, period }, required: ['host', 'path'], additionalProperties: false } as const;

const paidWithCalls = object({ paidWith: string, calls: integer });

export const platformSchema = object({
  // When today's, 7 and 30 days' numbers were counted, and when all time's were
  updatedAt: nullableTime,
  allUpdatedAt: nullableTime,
  calls: byPeriod(integer),
  volume: object({ today: string, '7d': string, '30d': string, all: string, currency: { type: 'string', enum: ['USD'] } }),
  buyers: byPeriod(integer),
  services: byPeriod(integer),
  byPaidWith: byPeriod(list(object({ paidWith: string, calls: integer, volume: string }))),
  topups: object({ '30d': object({ count: integer, usd: string }), all: object({ count: integer, usd: string }) }),
  daily: list(object({ day, calls: integer, volume: string })),
});

export const liveSchema = object({
  at: time,
  today: object({ calls: integer, volume: string, buyers: integer, nearShare: number }),
  last24h: object({ calls: integer, volume: string, volumeBefore: string }),
  perMinute: list(object({ minute: time, calls: integer })),
});

export const topSchema = object({
  period: string,
  updatedAt: nullableTime,
  services: list(object({ host: string, calls: integer })),
  endpoints: list(object({ host: string, path: string, calls: integer })),
  paidWith: list(paidWithCalls),
  topupTokens: list(object({ network: string, token: string, count: integer })),
});

export const servicesSchema = object({
  services: list(object({
    host: string,
    status: listedStatus,
    // Its listed endpoints, of paid calls and of checks
    paidEndpoints: integer,
    priceFrom: nullable('string'),
    currency: { type: 'string', enum: ['USD'] },
    calls: integer,
    buyers: integer,
    volume: string,
    successRate: nullable('number'),
    p50Ms: nullable('integer'),
    trend: list(integer),
    // When its first endpoint was listed, and when a check last confirmed one: null when never
    listedAt: nullableTime,
    checkedAt: nullableTime,
  })),
  page: integer,
  size: integer,
  total: integer,
  // More services had a paid call in 30 days than the count keeps numbers of: a search may miss some
  totalCapped: { type: 'boolean' },
  totals: object({
    services: { ...integer, description: 'The services the list shows, paid or checked, each once' },
    paidServices: { ...integer, description: 'The paid services the list shows, each once: those with an endpoint a paid call reached, whenever it did' },
    paidEndpoints: { ...integer, description: 'The listed endpoints of the services the list shows, of paid calls and of checks, each once' },
    calls30d: { ...integer, description: 'The paid calls of the last 30 days the count counted, to every service, without those of the counted ones the blocklist names' },
  }, 'Over every service the list shows, whatever the search and the page'),
  updatedAt: nullableTime,
});

export const serviceSchema = object({
  host: string,
  period: string,
  updatedAt: time,
  status: listedStatus,
  listedAt: nullableTime,
  checkedAt: nullableTime,
  // Its listed endpoints, of paid calls and of checks
  paidEndpoints: integer,
  stats: object({
    calls: integer,
    callsBefore: nullable('integer'),
    volume: string,
    buyers: integer,
    returningShare: number,
    successRate: nullable('number'),
    failedCalls: integer,
    p50Ms: nullable('integer'),
    p95Ms: nullable('integer'),
  }),
  // Those of paid calls, then those listed only by a check
  endpoints: list(object({
    path: string,
    method: nullable('string'),
    priceNow: nullable('string'),
    calls: integer,
    buyers: integer,
    volume: string,
    successRate: nullable('number'),
    p50Ms: nullable('integer'),
    link: string,
    status: listedStatus,
    checkedAt: nullableTime,
  })),
  daily: list(object({ day, calls: integer, volume: string, buyers: integer })),
  byPaidWith: list(object({ paidWith: string, calls: integer, share: number, buyers: integer, volume: string })),
  topBuyers: object({
    share: number,
    buyers: list(object({ payer: nullable('string'), paidWith: string, calls: integer, spent: string, lastCallAt: time })),
  }),
  // False: read when asked for, the numbers stopped at their cap and cover the newest calls only
  exact: { type: 'boolean' },
});

export const endpointSchema = object({
  host: string,
  path: string,
  period: string,
  updatedAt: nullableTime,
  stats: object({ calls: integer, buyers: integer, volume: string, successRate: nullable('number'), p50Ms: nullable('integer') }),
  daily: list(object({ day, calls: integer })),
  byPaidWith: list(paidWithCalls),
  // False: read when asked for, the numbers stopped at their cap and cover the newest calls only
  exact: { type: 'boolean' },
});
