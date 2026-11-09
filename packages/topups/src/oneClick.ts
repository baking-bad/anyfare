import { AnyfareError, isRecord, maxAssetDecimals, type Secret } from '@anyfare/common';

// The 1Click API of NEAR Intents: GET /v0/tokens, POST /v0/quote and GET /v0/status. A real quote makes
// a deposit address, and 1Click has no idempotency key: the same request twice makes two addresses. So
// the client never repeats a call. A caller that gets OneClickUnavailableError for a real quote doesn't
// know whether an address exists.

/** A token 1Click swaps from, as `/v0/tokens` lists it. */
export interface OneClickToken {
  // Such as nep141:wrap.near
  readonly assetId: string;
  readonly decimals: number;
  // 1Click's name for the network, such as arb
  readonly blockchain: string;
  readonly symbol: string;
  // In USD
  readonly price: number;
  readonly priceUpdatedAt: string;
  // Absent for a chain's own coin, such as ETH on Base
  readonly contractAddress?: string;
}

export interface OneClickQuoteRequest {
  // True: a price only, with no deposit address
  readonly dry: boolean;
  readonly swapType: 'EXACT_INPUT' | 'EXACT_OUTPUT' | 'FLEX_INPUT';
  // In basis points
  readonly slippageTolerance: number;
  readonly originAsset: string;
  readonly depositType: 'ORIGIN_CHAIN' | 'INTENTS';
  readonly destinationAsset: string;
  // In the origin asset's atomic units
  readonly amount: string;
  readonly refundTo: string;
  readonly refundType: 'ORIGIN_CHAIN' | 'INTENTS';
  readonly recipient: string;
  readonly recipientType: 'DESTINATION_CHAIN' | 'INTENTS';
  // ISO 8601: when refunds start if the swap hasn't completed
  readonly deadline: string;
  readonly depositMode?: 'SIMPLE' | 'MEMO';
}

/** The parts of a quote we use. Amounts are atomic units as strings of digits; USD values are decimal strings. */
export interface OneClickQuote {
  readonly amountIn: string;
  readonly minAmountIn: string;
  readonly amountOut: string;
  readonly minAmountOut: string;
  readonly amountInUsd: string;
  readonly amountOutUsd: string;
  // Seconds from the confirmed deposit to the swap's end
  readonly timeEstimate: number | undefined;
  // A real quote's, never a dry one's
  readonly depositAddress: string | undefined;
  // Some networks need it beside the address
  readonly depositMemo: string | undefined;
  // When the address stops taking transfers
  readonly deadline: string | undefined;
  readonly timeWhenInactive: string | undefined;
}

/** A real quote's: the address to send to and its deadline are always there. */
export interface OneClickDepositQuote extends OneClickQuote {
  readonly depositAddress: string;
  readonly deadline: string;
}

export interface OneClickQuoteResponse<TQuote extends OneClickQuote = OneClickQuote> {
  readonly correlationId: string;
  // 1Click's signature over the quote, kept to settle a dispute
  readonly signature: string | undefined;
  readonly timestamp: string | undefined;
  readonly quote: TQuote;
  // The whole JSON body, to store
  readonly raw: Readonly<Record<string, unknown>>;
}

export type OneClickDepositQuoteResponse = OneClickQuoteResponse<OneClickDepositQuote>;

export const oneClickStatuses = ['KNOWN_DEPOSIT_TX', 'PENDING_DEPOSIT', 'INCOMPLETE_DEPOSIT', 'PROCESSING', 'SUCCESS', 'REFUNDED', 'FAILED'] as const;
export type OneClickStatus = typeof oneClickStatuses[number];

export const isOneClickStatus = (value: unknown): value is OneClickStatus => (oneClickStatuses as readonly unknown[]).includes(value);

export interface OneClickTransaction {
  readonly hash: string;
  // Often empty
  readonly explorerUrl: string;
}

/**
 * What 1Click has seen of a swap. Which fields are set depends on the status: amounts are undefined
 * while 1Click answers null, and lists are empty until there is something to list.
 */
export interface OneClickSwapDetails {
  readonly depositedAmount: string | undefined;
  readonly depositedAmountUsd: string | undefined;
  readonly amountIn: string | undefined;
  readonly amountInUsd: string | undefined;
  readonly amountOut: string | undefined;
  readonly amountOutUsd: string | undefined;
  readonly refundedAmount: string | undefined;
  readonly refundedAmountUsd: string | undefined;
  readonly refundFee: string | undefined;
  readonly refundReason: string | undefined;
  readonly slippage: number | undefined;
  readonly intentHashes: readonly string[];
  readonly nearTxHashes: readonly string[];
  readonly originChainTxHashes: readonly OneClickTransaction[];
  // For a refund, the refund's transaction
  readonly destinationChainTxHashes: readonly OneClickTransaction[];
}

export interface OneClickStatusResponse {
  readonly correlationId: string;
  readonly status: OneClickStatus;
  readonly updatedAt: string;
  readonly swapDetails: OneClickSwapDetails;
  // The whole JSON body, to store. Its quoteResponse is the quote the address was made for.
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface OneClickStatusQuery {
  readonly depositAddress: string;
  readonly depositMemo?: string | undefined;
}

export interface OneClickClient {
  tokens(): Promise<readonly OneClickToken[]>;
  quote(request: OneClickQuoteRequest & { readonly dry: false }): Promise<OneClickDepositQuoteResponse>;
  quote(request: OneClickQuoteRequest): Promise<OneClickQuoteResponse>;
  status(query: OneClickStatusQuery): Promise<OneClickStatusResponse>;
}

export interface OneClickClientOptions {
  readonly url: string;
  // Sent in the X-API-Key header. Without it 1Click is called without a key.
  readonly apiKey?: Secret | undefined;
  // Each call, the answer's body included
  readonly timeoutMs: number;
  // Default: the global fetch
  readonly fetch?: typeof fetch;
}

// What a refusal keeps of 1Click's message
const maxMessageLength = 300;

/** 1Click refused the request with a reason: a 400 or 422 with a message. For a quote, no address was made. */
export class OneClickRefusedError extends AnyfareError {
  readonly code = 'oneclick_refused';
  readonly status: number;
  // 1Click's own words, cut to 300 characters
  readonly reason: string;

  constructor(status: number, reason: string) {
    super(`1Click refused the request: ${reason}`);

    this.status = status;
    this.reason = reason;
  }
}

/** 1Click knows no swap at the deposit address. */
export class OneClickNotFoundError extends AnyfareError {
  readonly code = 'oneclick_not_found';
  readonly depositAddress: string;

  constructor(depositAddress: string) {
    super('1Click knows no swap at the deposit address');

    this.depositAddress = depositAddress;
  }
}

export type OneClickUnavailableReason =
  | 'timeout'
  | 'connection_failed'
  | 'server_error'
  | 'rate_limited'
  // A 401 or 403: our key is wrong, or 1Click wants one
  | 'auth_failed'
  | 'unexpected_status'
  | 'not_json'
  | 'too_large'
  | 'invalid_answer';

/**
 * 1Click didn't answer usably: a timeout, a failed or cut connection, a 5xx, a 429, a 401 or 403, an
 * unexpected status, or an answer that isn't JSON, is over 1 MiB or isn't the expected shape. For a real
 * quote the outcome is unknown: an address may exist. Never carries the key or 1Click's body.
 */
export class OneClickUnavailableError extends AnyfareError {
  readonly code = 'oneclick_unavailable';
  readonly reason: OneClickUnavailableReason;
  readonly method: string;
  // Such as /v0/quote
  readonly path: string;
  // The answer's status, when there was one
  readonly status: number | undefined;
  // For an invalid answer, which field failed. Never a value.
  readonly detail: string | undefined;
  readonly durationMs: number | undefined;

  constructor(reason: OneClickUnavailableReason, options: {
    readonly method: string;
    readonly path: string;
    readonly status?: number | undefined;
    readonly detail?: string | undefined;
    readonly durationMs?: number | undefined;
    readonly cause?: unknown;
  }) {
    const status = options.status === undefined ? '' : ` (${options.status})`;
    const detail = options.detail === undefined ? '' : `: ${options.detail}`;
    super(`1Click is unavailable: ${reason} on ${options.method} ${options.path}${status}${detail}`, options.cause === undefined ? undefined : { cause: options.cause });

    this.reason = reason;
    this.method = options.method;
    this.path = options.path;
    this.status = options.status;
    this.detail = options.detail;
    this.durationMs = options.durationMs === undefined ? undefined : Math.round(options.durationMs);
  }
}

// The longest answer read from 1Click. The full token list is about 55 KB.
export const maxOneClickAnswerBytes = 1024 * 1024;

type Body =
  | { readonly kind: 'json'; readonly value: unknown }
  | { readonly kind: 'not_json' }
  | { readonly kind: 'too_large' }
  | { readonly kind: 'failed'; readonly error: unknown };

/** The answer's JSON, read up to the cap without reading further. */
const readBody = async (response: Response): Promise<Body> => {
  const length = Number(response.headers.get('content-length') ?? 0);
  if (length > maxOneClickAnswerBytes) {
    await response.body?.cancel().catch(() => undefined);
    return { kind: 'too_large' };
  }
  if (!response.body)
    return { kind: 'not_json' };

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done)
        break;
      size += value.byteLength;
      if (size > maxOneClickAnswerBytes) {
        await reader.cancel().catch(() => undefined);
        return { kind: 'too_large' };
      }
      chunks.push(value);
    }
  }
  catch (error) {
    return { kind: 'failed', error };
  }
  try {
    return { kind: 'json', value: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown };
  }
  catch {
    return { kind: 'not_json' };
  }
};

/** A body that isn't the expected shape. `field` names what failed, never its value. */
class InvalidAnswer extends Error {
  constructor(readonly field: string) {
    super(field);
  }
}

const digitsRegExp = /^[0-9]{1,78}$/;
const decimalRegExp = /^[0-9]{1,40}(?:\.[0-9]{1,40})?$/;

const invalid = (field: string, problem: string): never => {
  throw new InvalidAnswer(`${field} ${problem}`);
};
const recordAt = (value: unknown, field: string): Record<string, unknown> => isRecord(value) ? value : invalid(field, 'is not an object');
const textAt = (record: Record<string, unknown>, field: string, path = field): string => {
  const value = record[field];

  return typeof value === 'string' && value !== '' ? value : invalid(path, 'is not a string');
};
const optionalTextAt = (record: Record<string, unknown>, field: string, path = field): string | undefined =>
  record[field] === undefined || record[field] === null ? undefined : textAt(record, field, path);
const digitsAt = (record: Record<string, unknown>, field: string, path = field): string => {
  const value = record[field];

  return typeof value === 'string' && digitsRegExp.test(value) ? value : invalid(path, 'is not an amount in digits');
};
const optionalDigitsAt = (record: Record<string, unknown>, field: string, path = field): string | undefined =>
  record[field] === undefined || record[field] === null ? undefined : digitsAt(record, field, path);
const decimalAt = (record: Record<string, unknown>, field: string, path = field): string => {
  const value = record[field];

  return typeof value === 'string' && decimalRegExp.test(value) ? value : invalid(path, 'is not a decimal string');
};
const optionalDecimalAt = (record: Record<string, unknown>, field: string, path = field): string | undefined =>
  record[field] === undefined || record[field] === null ? undefined : decimalAt(record, field, path);
const numberAt = (record: Record<string, unknown>, field: string, path = field): number => {
  const value = record[field];

  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : invalid(path, 'is not a number');
};
const optionalNumberAt = (record: Record<string, unknown>, field: string, path = field): number | undefined =>
  record[field] === undefined || record[field] === null ? undefined : numberAt(record, field, path);
const dateAt = (record: Record<string, unknown>, field: string, path = field): string => {
  const value = textAt(record, field, path);

  return Number.isFinite(Date.parse(value)) ? value : invalid(path, 'is not a date');
};
const optionalDateAt = (record: Record<string, unknown>, field: string, path = field): string | undefined =>
  record[field] === undefined || record[field] === null ? undefined : dateAt(record, field, path);
// A list 1Click may leave out while it's empty
const listAt = <TItem>(record: Record<string, unknown>, field: string, item: (value: unknown, path: string) => TItem, path = field): readonly TItem[] => {
  const value = record[field];
  if (value === undefined || value === null)
    return [];

  return Array.isArray(value) ? value.map((entry, index) => item(entry, `${path}[${index}]`)) : invalid(path, 'is not a list');
};

const parseToken = (value: unknown): OneClickToken | undefined => {
  if (!isRecord(value))
    return undefined;
  const { assetId, decimals, blockchain, symbol, price, priceUpdatedAt, contractAddress } = value;
  const valid = typeof assetId === 'string' && assetId !== ''
    && typeof decimals === 'number' && Number.isInteger(decimals) && decimals >= 0 && decimals <= maxAssetDecimals
    && typeof blockchain === 'string' && blockchain !== ''
    && typeof symbol === 'string' && symbol !== ''
    && typeof price === 'number' && Number.isFinite(price) && price >= 0
    && typeof priceUpdatedAt === 'string'
    && (contractAddress === undefined || (typeof contractAddress === 'string' && contractAddress !== ''));
  if (!valid)
    return undefined;

  return { assetId, decimals, blockchain, symbol, price, priceUpdatedAt, ...contractAddress === undefined ? {} : { contractAddress } };
};

// An entry 1Click lists that isn't a token we can read is left out, since it can't be resolved anyway.
// A list with none we can read is an invalid answer.
const parseTokens = (body: unknown): readonly OneClickToken[] => {
  if (!Array.isArray(body))
    return invalid('the token list', 'is not a list');
  const tokens = body.map(parseToken).filter(token => token !== undefined);
  if (body.length > 0 && tokens.length === 0)
    return invalid('the token list', 'has no token in the expected shape');

  return tokens;
};

const parseQuote = (value: unknown, real: boolean): OneClickQuote => {
  const quote = recordAt(value, 'quote');
  const at = (field: string) => `quote.${field}`;
  const parsed: OneClickQuote = {
    amountIn: digitsAt(quote, 'amountIn', at('amountIn')),
    minAmountIn: digitsAt(quote, 'minAmountIn', at('minAmountIn')),
    amountOut: digitsAt(quote, 'amountOut', at('amountOut')),
    minAmountOut: digitsAt(quote, 'minAmountOut', at('minAmountOut')),
    amountInUsd: decimalAt(quote, 'amountInUsd', at('amountInUsd')),
    amountOutUsd: decimalAt(quote, 'amountOutUsd', at('amountOutUsd')),
    timeEstimate: optionalNumberAt(quote, 'timeEstimate', at('timeEstimate')),
    depositAddress: optionalTextAt(quote, 'depositAddress', at('depositAddress')),
    depositMemo: optionalTextAt(quote, 'depositMemo', at('depositMemo')),
    deadline: optionalDateAt(quote, 'deadline', at('deadline')),
    timeWhenInactive: optionalDateAt(quote, 'timeWhenInactive', at('timeWhenInactive')),
  };
  if (real && parsed.depositAddress === undefined)
    invalid(at('depositAddress'), 'is missing from a real quote');
  if (real && parsed.deadline === undefined)
    invalid(at('deadline'), 'is missing from a real quote');

  return parsed;
};

const parseQuoteResponse = (body: unknown, real: boolean): OneClickQuoteResponse => {
  const record = recordAt(body, 'the answer');

  return {
    correlationId: textAt(record, 'correlationId'),
    signature: optionalTextAt(record, 'signature'),
    timestamp: optionalDateAt(record, 'timestamp'),
    quote: parseQuote(record['quote'], real),
    raw: record,
  };
};

const parseTransaction = (value: unknown, path: string): OneClickTransaction => {
  const record = recordAt(value, path);
  const explorerUrl = record['explorerUrl'] ?? '';

  return { hash: textAt(record, 'hash', `${path}.hash`), explorerUrl: typeof explorerUrl === 'string' ? explorerUrl : invalid(`${path}.explorerUrl`, 'is not a string') };
};

const parseHash = (value: unknown, path: string): string => typeof value === 'string' && value !== '' ? value : invalid(path, 'is not a string');

const parseSwapDetails = (value: unknown): OneClickSwapDetails => {
  const details = recordAt(value, 'swapDetails');
  const at = (field: string) => `swapDetails.${field}`;

  return {
    depositedAmount: optionalDigitsAt(details, 'depositedAmount', at('depositedAmount')),
    depositedAmountUsd: optionalDecimalAt(details, 'depositedAmountUsd', at('depositedAmountUsd')),
    amountIn: optionalDigitsAt(details, 'amountIn', at('amountIn')),
    amountInUsd: optionalDecimalAt(details, 'amountInUsd', at('amountInUsd')),
    amountOut: optionalDigitsAt(details, 'amountOut', at('amountOut')),
    amountOutUsd: optionalDecimalAt(details, 'amountOutUsd', at('amountOutUsd')),
    refundedAmount: optionalDigitsAt(details, 'refundedAmount', at('refundedAmount')),
    refundedAmountUsd: optionalDecimalAt(details, 'refundedAmountUsd', at('refundedAmountUsd')),
    refundFee: optionalDigitsAt(details, 'refundFee', at('refundFee')),
    refundReason: optionalTextAt(details, 'refundReason', at('refundReason')),
    slippage: details['slippage'] === undefined || details['slippage'] === null
      ? undefined
      : typeof details['slippage'] === 'number' && Number.isFinite(details['slippage']) ? details['slippage'] : invalid(at('slippage'), 'is not a number'),
    intentHashes: listAt(details, 'intentHashes', parseHash, at('intentHashes')),
    nearTxHashes: listAt(details, 'nearTxHashes', parseHash, at('nearTxHashes')),
    originChainTxHashes: listAt(details, 'originChainTxHashes', parseTransaction, at('originChainTxHashes')),
    destinationChainTxHashes: listAt(details, 'destinationChainTxHashes', parseTransaction, at('destinationChainTxHashes')),
  };
};

const parseStatusResponse = (body: unknown): OneClickStatusResponse => {
  const record = recordAt(body, 'the answer');
  const status = record['status'];
  recordAt(record['quoteResponse'], 'quoteResponse');

  return {
    correlationId: textAt(record, 'correlationId'),
    status: isOneClickStatus(status) ? status : invalid('status', 'is not a known status'),
    updatedAt: dateAt(record, 'updatedAt'),
    swapDetails: parseSwapDetails(record['swapDetails']),
    raw: record,
  };
};

// 1Click's reason for a refusal: a string, or the list a field validation error carries
const refusalReason = (body: unknown): string | undefined => {
  const message = isRecord(body) ? body['message'] : undefined;
  const text = typeof message === 'string'
    ? message
    : Array.isArray(message) && message.length > 0 && message.every(item => typeof item === 'string') ? message.join('; ') : undefined;

  return text === undefined || text.trim() === '' ? undefined : text.trim().slice(0, maxMessageLength);
};

const statusReason = (status: number): OneClickUnavailableReason => {
  if (status === 401 || status === 403)
    return 'auth_failed';
  if (status === 429)
    return 'rate_limited';

  return status >= 500 ? 'server_error' : 'unexpected_status';
};

const isTimeout = (error: unknown): boolean => error instanceof Error && (error.name === 'TimeoutError' || (error.cause instanceof Error && error.cause.name === 'TimeoutError'));

interface Call<TAnswer> {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly query?: Readonly<Record<string, string | undefined>>;
  readonly payload?: unknown;
  readonly parse: (body: unknown) => TAnswer;
  // A 400 or 422 with a message refuses the request
  readonly refusable?: boolean;
  // A 404 means 1Click knows no such swap
  readonly notFound?: () => AnyfareError;
}

/**
 * The 1Click client. Each call is made once, with a deadline over the whole answer, and its body is read
 * up to 1 MiB and checked before it is returned. A quote or status that 1Click refuses with a 400 or 422
 * and a message throws OneClickRefusedError, a status for an unknown address OneClickNotFoundError, and
 * anything else OneClickUnavailableError.
 */
export const createOneClickClient = ({ url, apiKey, timeoutMs, fetch: send = fetch }: OneClickClientOptions): OneClickClient => {
  const base = url.replace(/\/+$/, '');

  const call = async <TAnswer>({ method, path, query, payload, parse, refusable = false, notFound }: Call<TAnswer>): Promise<TAnswer> => {
    const target = new URL(`${base}${path}`);
    for (const [name, value] of Object.entries(query ?? {})) {
      if (value !== undefined)
        target.searchParams.set(name, value);
    }
    const started = performance.now();
    const unavailable = (reason: OneClickUnavailableReason, extra: { readonly status?: number; readonly detail?: string; readonly cause?: unknown } = {}) =>
      new OneClickUnavailableError(reason, { method, path, ...extra, durationMs: performance.now() - started });
    const signal = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await send(target, {
        method,
        headers: {
          accept: 'application/json',
          ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
          ...(apiKey ? { 'x-api-key': apiKey.expose() } : {}),
        },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        redirect: 'error',
        signal,
      });
    }
    catch (error) {
      throw unavailable(isTimeout(error) || signal.aborted ? 'timeout' : 'connection_failed', { cause: error });
    }

    const { status } = response;
    const body = await readBody(response);
    if (body.kind === 'failed')
      throw unavailable(isTimeout(body.error) || signal.aborted ? 'timeout' : 'connection_failed', { status, cause: body.error });
    if (body.kind === 'too_large')
      throw unavailable('too_large', { status });

    if (response.ok) {
      if (body.kind === 'not_json')
        throw unavailable('not_json', { status });
      try {
        return parse(body.value);
      }
      catch (error) {
        if (error instanceof InvalidAnswer)
          throw unavailable('invalid_answer', { status, detail: error.field });
        throw error;
      }
    }

    const reason = body.kind === 'json' ? refusalReason(body.value) : undefined;
    if (refusable && (status === 400 || status === 422) && reason !== undefined)
      throw new OneClickRefusedError(status, reason);
    if (notFound && status === 404)
      throw notFound();

    throw unavailable(statusReason(status), { status });
  };

  function quote(request: OneClickQuoteRequest & { readonly dry: false }): Promise<OneClickDepositQuoteResponse>;
  function quote(request: OneClickQuoteRequest): Promise<OneClickQuoteResponse>;
  function quote(request: OneClickQuoteRequest): Promise<OneClickQuoteResponse> {
    return call({ method: 'POST', path: '/v0/quote', payload: request, parse: body => parseQuoteResponse(body, !request.dry), refusable: true });
  }

  return {
    tokens: () => call({ method: 'GET', path: '/v0/tokens', parse: parseTokens }),
    quote,
    status: ({ depositAddress, depositMemo }) => call({
      method: 'GET',
      path: '/v0/status',
      query: { depositAddress, depositMemo },
      parse: parseStatusResponse,
      refusable: true,
      notFound: () => new OneClickNotFoundError(depositAddress),
    }),
  };
};
