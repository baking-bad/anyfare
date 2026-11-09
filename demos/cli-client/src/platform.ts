// Anyfare's Platform API, and the proxy's `GET /_/key`: sign-up, payment keys and the balance.

import { httpErrorOf, stopFor } from './errors.ts';
import type { ErrorContext } from './errors.ts';
import { failureOf, request } from './http.ts';
import type { Answer, Fetch, RequestOptions } from './http.ts';
import { Stop, isRecord, toAtomic } from './util.ts';

export const PLATFORM_TIMEOUT_MS = 20_000;

/** A master key: `afm_`, then its own prefix and body. */
export const MASTER_KEY_SHAPE = /^afm_[A-Za-z0-9_]{1,196}$/;
/** A payment key: `af_`, then its own prefix and body. */
export const PAYMENT_KEY_SHAPE = /^af_[A-Za-z0-9_]{1,197}$/;

/** The answer to sign-up: the master key, shown this once, and the rest, to read after it is saved. */
export interface SignedUp {
  /** The account's ID. `undefined` when it can't be read. */
  readonly id: string | undefined;
  readonly masterKey: string;
  readonly answer: unknown;
}

/** The answer to key create: the key, shown this once, and the rest, to read after it is saved. */
export interface CreatedKey {
  /** The key's ID. `undefined` when it can't be read. */
  readonly id: string | undefined;
  readonly key: string;
  readonly answer: unknown;
}

/** A payment key's limits, in micro-USD. `null`: no such limit. */
export interface KeyLimits {
  readonly id: string;
  readonly label: string | null;
  readonly dailyBudget: bigint;
  readonly maxPrice: bigint | null;
  readonly allowance: bigint | null;
  readonly expiresAt: string | null;
}

/** What an answer says, for display only: a field that can't be read is `undefined`. */
export type Shown<T> = { readonly [K in keyof T]: T[K] | undefined };

export interface Balance {
  readonly available: bigint;
  readonly held: bigint;
}

export interface KeyStatus extends KeyLimits {
  readonly remaining: {
    readonly dailyBudget: bigint;
    readonly allowance: bigint | null;
    /** The account's available Credits. */
    readonly balance: bigint;
  };
}

const JSON_HEADERS = { 'content-type': 'application/json' } as const;

function base(url: string): string {
  return url.replace(/\/+$/, '');
}

const SIGNUP_LOST = "an account may have been created, and its master key can't be saved. Sign up again.";
const KEY_LOST =
  "a payment key may have been created, and it can't be saved. List the keys with the master key (GET /v1/keys), revoke that one, and create another.";

/**
 * One request. A `2xx` gives its body; anything else is the error's one line. For a request that
 * creates something, `lost` says what may exist when the request was sent and no readable answer came.
 */
async function send(fetchFn: Fetch, options: RequestOptions, context: ErrorContext, lost?: string): Promise<unknown> {
  let answer: Answer;
  try {
    answer = await request(fetchFn, options);
  } catch (error) {
    if (lost === undefined || !(error instanceof Stop)) throw error;
    // Only a request that never left created nothing
    if (failureOf(error)?.stage === 'not_sent') throw new Stop(`${error.message}. Nothing was created.`);
    throw new Stop(`${error.message}. ${lost.charAt(0).toUpperCase()}${lost.slice(1)}`);
  }
  if (answer.status < 200 || answer.status >= 300) throw stopFor(httpErrorOf(answer), context);
  return answer.body;
}

function usdOf(value: unknown): bigint | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    return toAtomic(value, 6);
  } catch {
    return undefined;
  }
}

const textOf = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

/** Reads the fields this app uses, or stops: the answer was not understood. */
function reader(what: string, body: unknown) {
  const fail = (field: string): never => {
    throw new Stop(`Anyfare's answer to ${what} was not understood: ${field} is missing or not valid`);
  };
  const root = isRecord(body) ? body : fail('the body');
  const text = (record: Record<string, unknown>, field: string): string => textOf(record[field]) ?? fail(field);
  const nullableText = (record: Record<string, unknown>, field: string): string | null => {
    const value = record[field];
    if (value === null || value === undefined) return null;
    return typeof value === 'string' ? value : fail(field);
  };
  const usd = (record: Record<string, unknown>, field: string): bigint => usdOf(record[field]) ?? fail(field);
  const nullableUsd = (record: Record<string, unknown>, field: string): bigint | null =>
    record[field] === null || record[field] === undefined ? null : usd(record, field);
  const object = (record: Record<string, unknown>, field: string): Record<string, unknown> => {
    const value = record[field];
    return isRecord(value) ? value : fail(field);
  };
  return { root, text, nullableText, usd, nullableUsd, object };
}

/** A field that may be `null`, for display: `undefined` when it is neither `null` nor what `read` takes. */
function shown<T>(answer: unknown, field: string, read: (value: unknown) => T | undefined): T | null | undefined {
  if (!isRecord(answer)) return undefined;
  const value = answer[field];
  return value === null ? null : read(value);
}

/** The notice of a sign-up answer, if it has one. Never fails. */
export function noticeOf(answer: unknown): string | undefined {
  return isRecord(answer) ? textOf(answer['notice']) : undefined;
}

/** The limits of a key create answer, for display. Never fails: a field that can't be read is `undefined`. */
export function shownLimits(answer: unknown): Shown<KeyLimits> {
  const record = isRecord(answer) ? answer : {};
  return {
    id: textOf(record['id']),
    label: shown(answer, 'label', textOf),
    dailyBudget: usdOf(record['dailyBudget']),
    maxPrice: shown(answer, 'maxPrice', usdOf),
    allowance: shown(answer, 'allowance', usdOf),
    expiresAt: shown(answer, 'expiresAt', textOf),
  };
}

/** The key of a `2xx` that creates one. Without it, a `Stop` that says what may exist. */
function keyIn(answer: unknown, field: string, shape: RegExp, lost: string): string {
  const value = isRecord(answer) ? answer[field] : undefined;
  if (typeof value !== 'string' || !shape.test(value)) {
    throw new Stop(`Anyfare's answer has no ${field} this app can read: ${lost}`);
  }
  return value;
}

/** `POST /v1/accounts`: a new account and its master key, shown this once. Only the key is checked. */
export async function signup(fetchFn: Fetch, apiUrl: string): Promise<SignedUp> {
  const answer = await send(
    fetchFn,
    { method: 'POST', url: `${base(apiUrl)}/v1/accounts`, headers: JSON_HEADERS, body: '{}', timeoutMs: PLATFORM_TIMEOUT_MS },
    { side: 'api' },
    SIGNUP_LOST,
  );
  const masterKey = keyIn(answer, 'masterKey', MASTER_KEY_SHAPE, SIGNUP_LOST);
  return { id: isRecord(answer) ? textOf(answer['id']) : undefined, masterKey, answer };
}

/** `POST /v1/keys` with the master key: a new payment key, shown this once. Only the key is checked. */
export async function createKey(
  fetchFn: Fetch,
  apiUrl: string,
  masterKey: string,
  limits: { readonly label: string; readonly dailyBudget: string; readonly maxPrice: string },
): Promise<CreatedKey> {
  const answer = await send(
    fetchFn,
    {
      method: 'POST',
      url: `${base(apiUrl)}/v1/keys`,
      headers: { ...JSON_HEADERS, authorization: `Bearer ${masterKey}` },
      body: JSON.stringify({ label: limits.label, dailyBudget: limits.dailyBudget, maxPrice: limits.maxPrice }),
      timeoutMs: PLATFORM_TIMEOUT_MS,
    },
    { side: 'api' },
    KEY_LOST,
  );
  const key = keyIn(answer, 'key', PAYMENT_KEY_SHAPE, KEY_LOST);
  return { id: isRecord(answer) ? textOf(answer['id']) : undefined, key, answer };
}

/** `GET /v1/balance` with the master key. */
export async function balance(fetchFn: Fetch, apiUrl: string, masterKey: string): Promise<Balance> {
  const body = await send(
    fetchFn,
    {
      method: 'GET',
      url: `${base(apiUrl)}/v1/balance`,
      headers: { authorization: `Bearer ${masterKey}` },
      timeoutMs: PLATFORM_TIMEOUT_MS,
    },
    { side: 'api' },
  );
  const read = reader('balance', body);
  return { available: read.usd(read.root, 'available'), held: read.usd(read.root, 'held') };
}

/** `GET <pay>/_/key` with a payment key: its limits, what is left of them, and the balance. */
export async function keyStatus(fetchFn: Fetch, payUrl: string, paymentKey: string): Promise<KeyStatus> {
  const body = await send(
    fetchFn,
    {
      method: 'GET',
      url: `${base(payUrl)}/_/key`,
      headers: { authorization: `Bearer ${paymentKey}` },
      timeoutMs: PLATFORM_TIMEOUT_MS,
    },
    { side: 'proxy' },
  );
  const read = reader('GET /_/key', body);
  const { root } = read;
  const remaining = read.object(root, 'remaining');
  return {
    id: read.text(root, 'id'),
    label: read.nullableText(root, 'label'),
    dailyBudget: read.usd(root, 'dailyBudget'),
    maxPrice: read.nullableUsd(root, 'maxPrice'),
    allowance: read.nullableUsd(root, 'allowance'),
    expiresAt: read.nullableText(root, 'expiresAt'),
    remaining: {
      dailyBudget: read.usd(remaining, 'dailyBudget'),
      allowance: read.nullableUsd(remaining, 'allowance'),
      balance: read.usd(remaining, 'balance'),
    },
  };
}
