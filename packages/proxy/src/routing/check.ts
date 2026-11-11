import { createHash } from 'node:crypto';

import {
  BlockedAddressError, DnsLookupError, errorBodySchema, formatUsd, isRecord, isSameAddress, outboundErrorCode, OutboundTimeoutError, parseIpAddress,
  publicAddressPolicy, type IpAddress, type MicroUsd,
} from '@anyfare/common';
import { assetToken, createPaidWith, paidWithValues, type PlatformConfig } from '@anyfare/core';
import { NotPayableError, parseTargetChallenge, UnsupportedPaymentError } from '@anyfare/payments';

import { HostRefusedError, UpstreamUnavailableError, type HostRefusal } from '../errors.js';
import type { X402Requirement } from './support.js';

// What `GET /_/check` answers beside the quote: the target's 402 as it came, what it asks, the ways we
// take the quote, and the endpoint's numbers. Everything from the target is cut to a length and read as
// data: its body never, its other headers never, and no URL in it is fetched.

/**
 * The methods a check probes with. Anyone can make us run a check with a link or an image tag, so every
 * method but GET needs the check's header; HEAD and OPTIONS answer no 402 worth checking.
 */
export const checkMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type CheckMethod = typeof checkMethods[number];

/** The methods a check without one tries, in order, until one gives a price. */
export const defaultCheckMethods: readonly CheckMethod[] = ['GET', 'POST'];

/** The methods a checked endpoint is listed with: the listing keeps GET and POST only. */
export type ListedMethod = Extract<CheckMethod, 'GET' | 'POST'>;
export const isListedMethod = (method: CheckMethod): method is ListedMethod => method === 'GET' || method === 'POST';

export interface CheckQuery {
  readonly url?: string;
  readonly method?: CheckMethod;
}

/**
 * The header any check but GET's needs, `X-Anyfare-Check: 1`. A link, a prefetch or an image tag never
 * sends it, and the pay host's CORS lets no other site's script add it.
 */
export const checkHeader = 'x-anyfare-check';

/** One try of a check, as its answer shows it. */
export interface CheckTry {
  readonly method: CheckMethod;
  // `example`: the JSON body the API's own 402 shows as its example
  readonly body: 'none' | 'example';
  // Null: the API didn't answer, or the try wasn't sent
  readonly status: number | null;
  // Served from the check's cache: no request left
  readonly cached?: true;
  // Not sent: the check's header was missing
  readonly skipped?: 'header';
}

// The target's headers a check shows, and the most of each it keeps. A challenge is kept long enough to
// decode; the header limit of the transport caps all of them together anyway.
const shownHeaderChars = {
  'payment-required': 16_384,
  'www-authenticate': 16_384,
  'content-type': 256,
  'cache-control': 1_024,
  date: 64,
} as const;
export type ShownHeader = keyof typeof shownHeaderChars;
export const shownHeaders = Object.keys(shownHeaderChars) as readonly ShownHeader[];

/** What a check shows of a probe: its status, the shown headers, when it went out, and how long it took. */
export interface ProbeView {
  readonly status: number;
  readonly headers: Readonly<Partial<Record<ShownHeader, string>>>;
  readonly probedAt: string;
  readonly ms: number;
}

/** The probe's view, from its answer: the shown headers only, several values joined as HTTP joins them, each cut. */
export const probeViewOf = (
  status: number, headers: Readonly<Record<string, string | readonly string[] | undefined>>, probedAt: Date, ms: number,
): ProbeView => {
  const shown: Partial<Record<ShownHeader, string>> = {};
  for (const name of shownHeaders) {
    const value = headers[name];
    const text = typeof value === 'string' ? value : Array.isArray(value) ? value.join(', ') : undefined;
    if (text !== undefined && text !== '')
      shown[name] = text.slice(0, shownHeaderChars[name]);
  }

  return { status, headers: shown, probedAt: probedAt.toISOString(), ms };
};

const digestOf = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex');

/**
 * The cache key of a check's own entry: the method and URL as a digest, never the text a buyer sent. A try
 * with the API's example body has an entry of its own, keyed by the body's digest too.
 */
export const checkEntryKey = (prefix: string, method: string, url: string, body?: Buffer): string =>
  `${prefix}check:${digestOf(`${method} ${url}`)}${body === undefined ? '' : `:${digestOf(body)}`}`;

/** A cached view, when it is well formed, its values of the types the answer says. */
export const parseProbeView = (value: unknown): ProbeView | undefined => {
  const probedAt = isRecord(value) && typeof value['probedAt'] === 'string' ? Date.parse(value['probedAt']) : Number.NaN;
  if (!isRecord(value) || !Number.isSafeInteger(value['status']) || Number.isNaN(probedAt) || typeof value['ms'] !== 'number' || !Number.isFinite(value['ms'])
    || !isRecord(value['headers']))
    return undefined;
  const headers: Partial<Record<ShownHeader, string>> = {};
  for (const name of shownHeaders) {
    const header = value['headers'][name];
    if (typeof header === 'string')
      headers[name] = header.slice(0, shownHeaderChars[name]);
  }

  return { status: value['status'] as number, headers, probedAt: new Date(probedAt).toISOString(), ms: Math.max(0, Math.round(value['ms'])) };
};

// A decoded challenge is any JSON a target sent: kept to this shape before it is answered
const jsonLimits = { depth: 8, entries: 64, keyChars: 128, stringChars: 4_096, totalChars: 48_000 } as const;

const boundValue = (value: unknown, depth: number): unknown => {
  if (value === null || typeof value === 'boolean')
    return value;
  if (typeof value === 'number')
    return Number.isFinite(value) ? value : null;
  if (typeof value === 'string')
    return value.slice(0, jsonLimits.stringChars);
  if (depth >= jsonLimits.depth)
    return null;
  if (Array.isArray(value))
    return value.slice(0, jsonLimits.entries).map(item => boundValue(item, depth + 1));
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).slice(0, jsonLimits.entries)
      .map(([key, item]) => [key.slice(0, jsonLimits.keyChars), boundValue(item, depth + 1)]));
  }

  return null;
};

/**
 * Any JSON value cut to a sane shape: at most 8 levels deep, 64 entries in a list or an object, strings of
 * 4,096 characters, keys of 128. Undefined when even that is over 48,000 characters of JSON.
 */
export const boundJson = (value: unknown): unknown => {
  const bounded = boundValue(value, 0);

  return JSON.stringify(bounded).length > jsonLimits.totalChars ? undefined : bounded;
};

const base64Pattern = /^[A-Za-z0-9+/_-]+={0,2}$/;

/** `PAYMENT-REQUIRED` as sent: base64 of a JSON object. Undefined when it isn't one. */
const decodeRequired = (value: string | undefined): Readonly<Record<string, unknown>> | undefined => {
  if (value === undefined || !base64Pattern.test(value))
    return undefined;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, 'base64').toString('utf8'));

    return isRecord(decoded) ? decoded : undefined;
  }
  catch {
    return undefined;
  }
};

/** The decoded `PAYMENT-REQUIRED`, cut to a sane shape. Undefined when it isn't base64 of a JSON object. */
const decodeX402 = (value: string | undefined): unknown => {
  const decoded = decodeRequired(value);

  return decoded === undefined ? undefined : boundJson(decoded);
};

/** The methods whose bodyless try may be tried again with the API's own example body. */
export const exampleMethods: ReadonlySet<CheckMethod> = new Set<CheckMethod>(['POST', 'PUT', 'PATCH']);
/** The most an example body may be, as JSON, in bytes. */
export const maxExampleBytes = 8_192;

/** A body a check sends from a 402's own example: the JSON value, and the bytes that go out. */
export interface ExampleBody {
  readonly value: unknown;
  readonly bytes: Buffer;
}

const isZeroAmount = (amount: unknown): boolean => (typeof amount === 'string' ? /^0+$/.test(amount) : amount === 0);
const fieldOf = (value: unknown, ...path: readonly string[]): unknown =>
  path.reduce<unknown>((item, key) => (isRecord(item) ? item[key] : undefined), value);

/**
 * The JSON body a bodyless try's `402` shows as its own example, when that 402 asked a price of 0: every x402
 * option's amount is zero, and its `extensions.bazaar.info.input` is an `http` input of the same method
 * (in any case), with `bodyType: "json"` and a body of at most 8 KB as JSON. Undefined otherwise. Only for
 * POST, PUT and PATCH: a price that depends on the body.
 */
export const exampleBodyOf = (view: ProbeView, method: CheckMethod): ExampleBody | undefined => {
  if (view.status !== 402 || !exampleMethods.has(method))
    return undefined;
  const required = decodeRequired(view.headers['payment-required']);
  const accepts = required?.['accepts'];
  if (!Array.isArray(accepts) || accepts.length === 0 || !accepts.every(option => isRecord(option) && isZeroAmount(option['amount'])))
    return undefined;
  const input = fieldOf(required, 'extensions', 'bazaar', 'info', 'input');
  if (!isRecord(input) || input['type'] !== 'http' || typeof input['method'] !== 'string' || input['method'].toUpperCase() !== method
    || input['bodyType'] !== 'json' || input['body'] === undefined || input['body'] === null)
    return undefined;
  try {
    const bytes = Buffer.from(JSON.stringify(input['body']), 'utf8');

    return bytes.length > maxExampleBytes ? undefined : { value: input['body'], bytes };
  }
  catch {
    // A body nested too deep to write out is no example
    return undefined;
  }
};

export interface UpstreamAnswer {
  readonly status: number;
  readonly headers: Readonly<Partial<Record<ShownHeader, string>>>;
  readonly x402?: unknown;
  readonly mpp?: readonly unknown[];
}

/** The target's 402 as a check shows it: the status, the shown headers, and each challenge decoded. */
export const upstreamOf = (view: ProbeView): UpstreamAnswer => {
  const x402 = decodeX402(view.headers['payment-required']);
  const wwwAuthenticate = view.headers['www-authenticate'];
  const mpp = wwwAuthenticate === undefined ? [] : (parseTargetChallenge({ 'www-authenticate': wwwAuthenticate })?.mpp ?? []);
  const challenges = boundJson(mpp.slice(0, jsonLimits.entries)) as unknown[] | undefined;

  return {
    status: view.status,
    headers: view.headers,
    ...x402 === undefined ? {} : { x402 },
    ...challenges === undefined || challenges.length === 0 ? {} : { mpp: challenges },
  };
};

/** What the target asks, from the option we would pay. The fields of the other protocol are left out. */
export interface Asks {
  readonly amount: string;
  readonly asset: string;
  readonly network: string;
  readonly paidWith: string;
  readonly payTo?: string;
  readonly scheme?: string;
  readonly x402Version?: number;
  readonly maxTimeoutSeconds?: number;
  readonly description?: string;
  readonly mimeType?: string;
  readonly method?: string;
  readonly intent?: string;
  readonly realm?: string;
  readonly recipient?: string;
  readonly expires?: string;
}

/** The quote's option, as the check reads it: an x402 option, or an MPP challenge as the target sent it. */
export type QuotedOption = {
  readonly network: string;
  readonly asset: string;
  readonly price: MicroUsd;
} & ({
  readonly protocol: 'x402';
  readonly x402Version: number;
  readonly requirement: X402Requirement;
  readonly resource: unknown;
} | {
  readonly protocol: 'mpp';
  readonly challenge: string;
});

const textOf = (value: unknown, chars = 512): string | undefined => typeof value === 'string' && value !== '' ? value.slice(0, chars) : undefined;
const wholeOf = (value: unknown): number | undefined => Number.isSafeInteger(value) ? value as number : undefined;
const defined = <TValue extends Record<string, unknown>>(value: TValue): TValue =>
  Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as TValue;

/** What the target asks, from the quote's option: its price, its token and network, and the option's own fields, cut. */
export const asksOf = (quote: QuotedOption, paidWithOf: (protocol: 'x402' | 'mpp', network: string) => string): Asks => {
  const common = {
    amount: formatUsd(quote.price), asset: assetToken(quote.asset), network: quote.network, paidWith: paidWithOf(quote.protocol, quote.network),
  };
  if (quote.protocol === 'x402') {
    const requirement: Readonly<Record<string, unknown>> = isRecord(quote.requirement) ? quote.requirement : {};
    const resource = isRecord(quote.resource) ? quote.resource : {};

    return defined({
      ...common,
      payTo: textOf(requirement['payTo']),
      scheme: textOf(requirement['scheme'], 64),
      x402Version: quote.x402Version,
      maxTimeoutSeconds: wholeOf(requirement['maxTimeoutSeconds']),
      description: textOf(resource['description'] ?? requirement['description'], 2_000),
      mimeType: textOf(resource['mimeType'] ?? requirement['mimeType'], 256),
    });
  }
  const [challenge] = parseTargetChallenge({ 'www-authenticate': quote.challenge })?.mpp ?? [];

  return defined({
    ...common,
    method: textOf(challenge?.method, 64),
    intent: textOf(challenge?.intent, 64),
    realm: textOf(challenge?.realm),
    recipient: textOf(challenge?.request['recipient']),
    expires: textOf(challenge?.expires, 64),
    description: textOf(challenge?.description, 2_000),
  });
};

/** One way we take the quote. */
export interface PayWay {
  readonly paidWith: string;
  readonly protocol: 'x402' | 'mpp' | 'credits';
  readonly asset: string;
  readonly amount: string;
  readonly currency: 'USD';
}

/** The assets the combined `402` offers on each rail that takes payments here, and when it offers them. */
export interface OfferedAssets {
  readonly x402: readonly { readonly name: string; readonly network: string; readonly minPrice: MicroUsd }[];
  readonly mpp: { readonly network: string; readonly assets: readonly { readonly name: string; readonly minPrice: MicroUsd }[] } | undefined;
}

/**
 * The ways we take a quote, as the combined `402` offers them: an x402 or MPP asset whose minimum price the
 * quote reaches, and credits always. In the order near, base, solana, tempo, any other network, credits.
 */
export const createPayWays = (config: Pick<PlatformConfig, 'assets' | 'mpp'>, offered: OfferedAssets) => {
  const { paidWithOf } = createPaidWith(config);
  // A network of no known way goes just before credits
  const rank = (paidWith: string): number => {
    const index = (paidWithValues as readonly string[]).indexOf(paidWith);

    return index === -1 ? paidWithValues.indexOf('credits') - 0.5 : index;
  };
  const wayOf = (protocol: 'x402' | 'mpp', network: string, asset: { readonly name: string; readonly minPrice: MicroUsd }) =>
    ({ protocol, paidWith: paidWithOf(protocol, network), asset: assetToken(asset.name), minPrice: asset.minPrice });
  const ways = [
    ...offered.x402.map(asset => wayOf('x402', asset.network, asset)),
    ...offered.mpp === undefined ? [] : offered.mpp.assets.map(asset => wayOf('mpp', offered.mpp!.network, asset)),
  ].sort((a, b) => rank(a.paidWith) - rank(b.paidWith));

  return (quote: MicroUsd): readonly PayWay[] => {
    const amount = formatUsd(quote);
    const seen = new Set<string>();
    const listed: PayWay[] = [];
    for (const { protocol, paidWith, asset, minPrice } of ways) {
      const key = `${protocol} ${paidWith} ${asset}`;
      if (minPrice > quote || seen.has(key))
        continue;
      seen.add(key);
      listed.push({ paidWith, protocol, asset, amount, currency: 'USD' });
    }

    return [...listed, { paidWith: 'credits', protocol: 'credits', asset: 'Credits', amount, currency: 'USD' }];
  };
};

export type PayWays = ReturnType<typeof createPayWays>;

// ---------- Refusals ----------

export type CheckReason = 'invalid_target' | 'host_not_allowed' | 'not_payable' | 'unsupported_payment' | 'upstream_unavailable';

/** Why a check refused a link, finer than its reason, for the page to word. */
export type CheckDetail =
  | 'not_a_url' | 'invalid_host' | 'ip_address'
  | 'blocklisted' | 'own_host' | 'private_address' | 'opted_out'
  | 'no_payment_asked'
  | 'no_challenge' | 'no_option'
  | 'dns' | 'refused' | 'timeout' | 'headers_too_large' | 'unreachable';
// The details whose message is always the same
type FixedDetail = Exclude<CheckDetail, 'no_payment_asked'>;

export interface CheckRefusal {
  readonly reason: CheckReason;
  readonly detail?: CheckDetail;
  readonly message: string;
  // The target's status, when it answered
  readonly status?: number;
}

const messages: Readonly<Record<FixedDetail, string>> = {
  not_a_url: 'The link isn\'t a URL.',
  invalid_host: 'The link must name a host, such as api.example.com.',
  ip_address: 'The link must name a host, such as api.example.com, not an IP address.',
  blocklisted: 'Anyfare doesn\'t route payments to this host.',
  own_host: 'This is one of Anyfare\'s own hosts.',
  private_address: 'This link points to a private or reserved address, which Anyfare never calls.',
  opted_out: 'This host asked Anyfare not to route payments to it.',
  no_challenge: 'The link answered 402, but without a payment request Anyfare can read.',
  no_option: 'The link asks for a payment, but in no way Anyfare can pay yet.',
  dns: 'The link\'s host name doesn\'t resolve.',
  refused: 'The host refused the connection.',
  timeout: 'The host didn\'t answer in time.',
  headers_too_large: 'The host answered with headers too large to read.',
  unreachable: 'The host couldn\'t be reached.',
};

const refusal = (reason: CheckReason, detail: FixedDetail): CheckRefusal => ({ reason, detail, message: messages[detail] });

export const notAUrl = refusal('invalid_target', 'not_a_url');
export const invalidHost = refusal('invalid_target', 'invalid_host');

/**
 * A link whose host is an IP address: routing takes host names only. A private, reserved, or special
 * address, by the production policy, or one of ours, is a host we never call; any other is no host name.
 * Only an address written in the link is named private: a name that resolves to one reads as no name.
 */
export const addressRefusal = (hostname: string, ownAddresses: readonly IpAddress[]): CheckRefusal | undefined => {
  const address = parseIpAddress(hostname);
  if (address === undefined)
    return undefined;
  if (ownAddresses.some(own => isSameAddress(own, address)))
    return refusal('host_not_allowed', 'own_host');

  const refused = publicAddressPolicy.refuse(hostname.replace(/^\[(.*)\]$/, '$1')) !== undefined;

  return refused ? refusal('host_not_allowed', 'private_address') : refusal('invalid_target', 'ip_address');
};

const hostDetails: Readonly<Record<HostRefusal, FixedDetail>> = {
  own_host: 'own_host', own_address: 'own_host', blocklisted: 'blocklisted', opted_out: 'opted_out',
};

const causesOf = (error: unknown): unknown[] => {
  const chain: unknown[] = [];
  for (let item: unknown = error, depth = 0; item !== undefined && depth < 10; item = (item as { cause?: unknown } | null)?.cause, depth++)
    chain.push(item);

  return chain;
};

// Why the target couldn't be reached, from the transport's error. A name that resolves only to addresses
// we never call reads as one that doesn't resolve, so a check never tells which internal names exist.
const unreachableRefusal = (error: UpstreamUnavailableError): CheckRefusal => {
  const chain = causesOf(error.cause);
  if (chain.some(item => item instanceof BlockedAddressError || item instanceof DnsLookupError))
    return refusal('upstream_unavailable', 'dns');
  // undici's error when the answer's headers are over the size it takes
  if (chain.some(item => (item as { code?: unknown } | null)?.code === 'UND_ERR_HEADERS_OVERFLOW'))
    return refusal('upstream_unavailable', 'headers_too_large');
  if (chain.some(item => item instanceof OutboundTimeoutError))
    return refusal('upstream_unavailable', 'timeout');

  return refusal('upstream_unavailable', outboundErrorCode(error.cause) === 'ECONNREFUSED' ? 'refused' : 'unreachable');
};

/** A check's refusal for an error of the host checks or the probe, given what the probe saw. Undefined: not a refusal. */
export const checkRefusalOf = (error: unknown, probe: ProbeView | undefined): CheckRefusal | undefined => {
  if (error instanceof HostRefusedError)
    return refusal('host_not_allowed', hostDetails[error.refusal]);
  if (error instanceof NotPayableError) {
    const status = probe?.status;

    return {
      reason: 'not_payable', detail: 'no_payment_asked', ...status === undefined ? {} : { status },
      message: status === undefined
        ? 'The link answered without asking for a payment. Anyfare routes paid calls only.'
        : `The link answered ${status} without asking for a payment. Anyfare routes paid calls only.`,
    };
  }
  if (error instanceof UnsupportedPaymentError) {
    const challenge = probe && parseTargetChallenge(probe.headers);

    return { ...refusal('unsupported_payment', challenge ? 'no_option' : 'no_challenge'), ...probe ? { status: probe.status } : {} };
  }
  if (error instanceof UpstreamUnavailableError)
    return unreachableRefusal(error);

  return undefined;
};

// ---------- Schemas ----------

const string = { type: 'string' } as const;
const integer = { type: 'integer' } as const;
const object = <TProperties extends Record<string, unknown>>(properties: TProperties, required: readonly (keyof TProperties)[] = Object.keys(properties)) =>
  ({ type: 'object', properties, required, additionalProperties: false }) as const;

export const checkHeadersSchema = {
  type: 'object',
  properties: {
    [checkHeader]: {
      type: 'string',
      description: '1: needed with any method but GET. Without it, a check without `method` tries GET only, and shows its POST try as skipped.',
    },
  },
} as const;

const methodSchema = { type: 'string', enum: [...checkMethods] } as const;

export const checkQuerySchema = {
  type: 'object',
  properties: {
    // The link, with or without https://
    url: { type: 'string', maxLength: 8_192 },
    method: {
      ...methodSchema,
      description: 'The method the check tries, once and without a body. Any method but GET needs the header X-Anyfare-Check: 1. '
        + 'Without it, the check tries GET, then POST, and stops at the first that gives a price. '
        + 'A POST, PUT or PATCH that the API asks a price of 0 without a body is tried once more with the JSON body its 402 shows as its own example.',
    },
  },
  additionalProperties: false,
} as const;

const triedSchema = {
  type: 'array',
  description: 'Every try of the check, in order. Empty when no request left, such as for a blocked host or a link that isn\'t one.',
  items: object({
    method: methodSchema,
    body: { type: 'string', enum: ['none', 'example'], description: 'none: no body. example: the JSON body the API\'s own 402 shows as its example.' },
    status: { type: ['integer', 'null'], description: 'The API\'s status. Null: it didn\'t answer, or the try wasn\'t sent.' },
    cached: { type: 'boolean', enum: [true], description: 'Served from the check\'s cache: no request left for it.' },
    skipped: { type: 'string', enum: ['header'], description: 'Not sent: the header X-Anyfare-Check: 1 was missing.' },
  }, ['method', 'body', 'status']),
} as const;

const exampleBodySchema = {
  description: 'The JSON body the check sent from the API\'s own example in its 402, after a try without a body was asked a price of 0. Null: none was sent.',
} as const;

const answerMethodSchema = {
  ...methodSchema,
  description: 'The method of the try that gave the price; on a refusal, of the last try sent.',
} as const;

const asksSchema = object({
  amount: string, asset: string, network: string, paidWith: string, payTo: string, scheme: string, x402Version: integer, maxTimeoutSeconds: integer,
  description: string, mimeType: string, method: string, intent: string, realm: string, recipient: string, expires: string,
}, ['amount', 'asset', 'network', 'paidWith']);

const upstreamSchema = object({
  status: integer,
  headers: object(Object.fromEntries(shownHeaders.map(name => [name, string])), []),
  // The decoded challenges, as the target sent them, cut to a sane shape
  x402: {},
  mpp: { type: 'array', items: {} },
}, ['status', 'headers']);

const payableSchema = object({
  payable: { type: 'boolean', enum: [true] },
  method: answerMethodSchema,
  target: string,
  price: object({ amount: string, currency: string, asset: string, network: { type: ['string', 'null'] } }),
  quote: object({ amount: string, fee: string, currency: string }),
  link: string,
  protocol: { type: 'string', enum: ['x402', 'mpp'] },
  asks: asksSchema,
  upstream: upstreamSchema,
  payWith: { type: 'array', items: object({ paidWith: string, protocol: string, asset: string, amount: string, currency: string }) },
  stats: {
    type: ['object', 'null'],
    description: 'The endpoint\'s paid calls through Anyfare over 30 days. Zeros: none were counted. Null: the numbers couldn\'t be read now.',
    properties: { calls: integer, buyers: integer, volume: string, successRate: { type: ['number', 'null'] }, p50Ms: { type: ['integer', 'null'] } },
    required: ['calls', 'buyers', 'volume', 'successRate', 'p50Ms'],
    additionalProperties: false,
  },
  listed: {
    type: 'boolean',
    description: 'Whether the endpoint is listed among the services, by this check or before it. False: a cap or a limit kept it out, or it wasn\'t known in time.',
  },
  checkedAt: { type: 'string', format: 'date-time' },
  ms: integer,
  exampleBody: exampleBodySchema,
  tried: triedSchema,
});

const refusedSchema = object({
  payable: { type: 'boolean', enum: [false] },
  method: answerMethodSchema,
  reason: string,
  message: string,
  detail: string,
  // The status of the last try sent, when it answered
  upstream: object({ status: integer }),
  exampleBody: exampleBodySchema,
  tried: triedSchema,
}, ['payable', 'method', 'reason', 'message', 'exampleBody', 'tried']);

const errorSchema = errorBodySchema;

// A check's failures to reach the API, its cache, or its listing are answers or are let through, never a 503
export const checkResponseSchema = {
  200: { anyOf: [payableSchema, refusedSchema] },
  400: errorSchema,
  429: errorSchema,
  500: errorSchema,
} as const;
