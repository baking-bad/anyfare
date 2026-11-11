import { readMasterKey, refusedKey, signOut } from './session';

// The console's requests to the Anyfare API, from the browser. This module is the only code that sends the master key,
// and it sends it only as `Authorization: Bearer <key>`, only to the API's origin (`apiUrl` of the settings). Every
// URL is that origin plus a path built from fixed text and encoded ids. No cookie, no cache, no referrer, and no
// redirect is followed, so the key can't be carried to another host.

/** An answer that is not a success, or the API not answering (`api_unavailable`, status 0). */
export class ConsoleApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly retryAfter?: number) {
    super(message);
    this.name = 'ConsoleApiError';
  }
}

/** The request was not sent: its target is not the API's origin. */
export class RefusedTargetError extends Error {
  constructor() {
    super('The request was not sent: its address is not the Anyfare API');
    this.name = 'RefusedTargetError';
  }
}

export interface Account {
  readonly id: string;
  readonly createdAt: string;
}

export interface NewAccount extends Account {
  // Shown once: the dialog that shows it holds it, and nothing else
  readonly masterKey: string;
  // A USD decimal, "0" when none was given
  readonly freeCredits: string;
}

export interface Balance {
  readonly available: string;
  readonly held: string;
}

export type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/** How long a request waits for its answer. */
export const requestTimeoutMs = 10_000;

/** How long the rotation waits: the API rotates at once, and an answer given up on would leave the new key unseen. */
export const rotateTimeoutMs = 60_000;

/**
 * A path of the API from fixed text and ids, each id encoded: apiPath`/v1/keys/${id}` is `/v1/keys/key_1` for
 * `key_1`, and `/v1/keys/a%2F..%2Fb` for `a/../b`.
 */
export const apiPath = (parts: TemplateStringsArray, ...ids: readonly string[]): string =>
  parts.reduce((path, part, index) => `${path}${part}${index < ids.length ? encodeURIComponent(ids[index]!) : ''}`, '');

// A segment of a path: unreserved characters and percent-escapes, and never `.` or `..`, which a URL resolves away
const segmentPattern = /^(?:[A-Za-z0-9\-._~]|%[0-9A-Fa-f]{2})+$/;
const dotSegment = /^(?:\.|%2e){1,2}$/i;
const isPath = (path: string): boolean =>
  path.startsWith('/') && path.slice(1).split('/').every(segment => segmentPattern.test(segment) && !dotSegment.test(segment));

/**
 * The URL of a request: the API's origin and path from `apiUrl`, then `path`, then the query. Undefined when the
 * result is not on the API's origin, or `apiUrl` is not an http(s) origin, or it is this page's own origin.
 */
export const apiTarget = (apiUrl: string, path: string, query?: Readonly<Record<string, string>>): URL | undefined => {
  let base: URL;
  try {
    base = new URL(apiUrl);
  }
  catch {
    return undefined;
  }
  if ((base.protocol !== 'https:' && base.protocol !== 'http:') || base.username !== '' || base.password !== '' || base.search !== '' || base.hash !== '')
    return undefined;
  if (!isPath(path))
    return undefined;
  const pathname = `${base.pathname.replace(/\/+$/, '')}${path}`;
  const target = new URL(`${base.origin}${pathname}`);
  if (query !== undefined)
    target.search = new URLSearchParams(query).toString();
  // The site's own server never gets a keyed request, whatever the settings say
  const own = typeof location === 'undefined' ? undefined : location.origin;

  return target.origin === base.origin && target.pathname === pathname && target.origin !== own ? target : undefined;
};

export interface ApiRequest {
  readonly method: Method;
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  // Default: requestTimeoutMs
  readonly timeoutMs?: number;
}

const retryAfterOf = (response: Response): number | undefined => {
  const value = Number(response.headers.get('retry-after'));

  return Number.isFinite(value) && value > 0 ? Math.ceil(value) : undefined;
};

const errorOf = (status: number, parsed: unknown, retryAfter: number | undefined): ConsoleApiError => {
  const error = (parsed as { readonly error?: { readonly code?: unknown; readonly message?: unknown } } | undefined)?.error;

  return typeof error?.code === 'string'
    ? new ConsoleApiError(status, error.code, typeof error.message === 'string' ? error.message : error.code, retryAfter)
    : new ConsoleApiError(status, 'unexpected_answer', `The Anyfare API answered ${status}`, retryAfter);
};

/** Sends one request with `key` (none for a request that needs none) and returns the JSON answer. */
const send = async (apiUrl: string, { method, path, query, body, timeoutMs = requestTimeoutMs }: ApiRequest, key: string | undefined): Promise<unknown> => {
  const target = apiTarget(apiUrl, path, query);
  if (target === undefined)
    throw new RefusedTargetError();
  const headers: Record<string, string> = { accept: 'application/json' };
  if (key !== undefined)
    headers['authorization'] = `Bearer ${key}`;
  if (body !== undefined)
    headers['content-type'] = 'application/json';
  let response: Response;
  try {
    response = await fetch(target, {
      method,
      headers,
      ...body === undefined ? {} : { body: JSON.stringify(body) },
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  }
  catch {
    throw new ConsoleApiError(0, 'api_unavailable', 'The Anyfare API didn\'t answer. Try again in a moment.');
  }
  let parsed: unknown;
  try {
    const text = await response.text();
    parsed = text === '' ? undefined : JSON.parse(text);
  }
  catch {
    parsed = undefined;
  }
  if (!response.ok)
    throw errorOf(response.status, parsed, retryAfterOf(response));

  return parsed;
};

/** Whether an error says the key is not, or no longer, a working master key. */
export const isRefusedKey = (error: unknown): boolean =>
  error instanceof ConsoleApiError && error.status === 401 && (error.code === 'invalid_key' || error.code === 'unauthorized');

/**
 * A request with the session's key. When the API refuses the key (`401 invalid_key` or `unauthorized`), the session
 * ends and the sign-in view says so; a key replaced while the request ran ends nothing.
 */
export const keyedRequest = async (apiUrl: string, request: ApiRequest): Promise<unknown> => {
  const key = readMasterKey();
  if (key === undefined) {
    // The tab lost its key, such as when its storage was cleared: there is nothing to send
    signOut('expired');
    throw new ConsoleApiError(401, 'unauthorized', 'Sign in with the master key');
  }
  try {
    return await send(apiUrl, request, key);
  }
  catch (error) {
    if (isRefusedKey(error))
      refusedKey(key);
    throw error;
  }
};

const isText = (value: unknown, max = 512): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
// A key from the API: printable ASCII with no space
const isKey = (value: unknown): value is string => isText(value) && /^[\x21-\x7e]+$/.test(value);

const unexpected = (): ConsoleApiError => new ConsoleApiError(200, 'unexpected_answer', 'The Anyfare API gave an answer the console can\'t read');

const accountOf = (value: unknown): Account => {
  const { id, createdAt } = (value ?? {}) as Record<string, unknown>;
  if (!isText(id) || !isText(createdAt, 64))
    throw unexpected();

  return { id, createdAt };
};

/** `POST /v1/accounts`: a new account, with no key and no body. The answer holds the master key, once. */
export const createAccount = async (apiUrl: string): Promise<NewAccount> => {
  const answer = (await send(apiUrl, { method: 'POST', path: '/v1/accounts' }, undefined) ?? {}) as Record<string, unknown>;
  const { masterKey, freeCredits } = answer;
  if (!isKey(masterKey))
    throw unexpected();

  return { ...accountOf(answer), masterKey, freeCredits: isText(freeCredits, 32) ? freeCredits : '0' };
};

/** `GET /v1/account` with a pasted key, before it is stored. The session is not touched, whatever the answer. */
export const checkMasterKey = async (apiUrl: string, key: string): Promise<Account> =>
  accountOf(await send(apiUrl, { method: 'GET', path: '/v1/account' }, key));

/** `GET /v1/account` with the session's key. */
export const readAccount = async (apiUrl: string): Promise<Account> => accountOf(await keyedRequest(apiUrl, { method: 'GET', path: '/v1/account' }));

/** `GET /v1/balance` with the session's key. */
export const readBalance = async (apiUrl: string): Promise<Balance> => {
  const { available, held } = (await keyedRequest(apiUrl, { method: 'GET', path: '/v1/balance' }) ?? {}) as Record<string, unknown>;
  if (!isText(available, 64) || !isText(held, 64))
    throw unexpected();

  return { available, held };
};

/**
 * `POST /v1/account/master-key/rotate` with `key`, the session's key when the person asked: a new master key, shown once.
 * The key that sent it stops at once. It waits `rotateTimeoutMs` for the answer, and never touches the session: the
 * rotation (rotate.ts) decides what an answer, or none, means.
 */
export const rotateMasterKey = async (apiUrl: string, key: string): Promise<string> => {
  const { masterKey } = (await send(apiUrl, { method: 'POST', path: '/v1/account/master-key/rotate', timeoutMs: rotateTimeoutMs }, key) ?? {}) as Record<string, unknown>;
  if (!isKey(masterKey))
    throw unexpected();

  return masterKey;
};

/**
 * Whether `key` still works: `GET /v1/account` with it. It never ends the session, whatever the answer: the caller
 * decides. `refused` only for a readable `401 invalid_key` or `unauthorized`; anything else that fails throws, as
 * the console can't tell.
 */
export const checkStoredKey = async (apiUrl: string, key: string): Promise<'works' | 'refused'> => {
  try {
    await send(apiUrl, { method: 'GET', path: '/v1/account' }, key);

    return 'works';
  }
  catch (error) {
    if (isRefusedKey(error))
      return 'refused';
    throw error;
  }
};

// ---------- Payment keys, payments and top-ups ----------

export interface PaymentKey {
  readonly id: string;
  readonly label: string | null;
  // USD decimals. `null` is no cap
  readonly allowance: string | null;
  readonly dailyBudget: string;
  readonly maxPrice: string | null;
  readonly expiresAt: string | null;
  readonly createdAt: string;
  readonly revokedAt: string | null;
  readonly spent: { readonly today: string; readonly total: string };
  readonly remaining: { readonly allowance: string | null; readonly dailyBudget: string };
}

/** The fields of a key a person sets. `null` clears a field that may be empty. */
export interface KeyFields {
  readonly label?: string | null;
  readonly dailyBudget?: string;
  readonly maxPrice?: string | null;
  readonly allowance?: string | null;
  readonly expiresAt?: string | null;
}

export type PaymentState = 'paid' | 'free' | 'pending';

export interface Payment {
  readonly id: string;
  readonly requestId: string | null;
  readonly rail: string;
  readonly targetHost: string;
  readonly targetPath: string;
  readonly amount: string;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly keyId: string | null;
  readonly upstreamStatus: number | null;
  readonly state: PaymentState;
}

export interface PaymentsQuery {
  readonly limit: number;
  readonly after?: string | undefined;
  readonly state?: PaymentState | undefined;
  readonly keyId?: string | undefined;
  readonly service?: string | undefined;
}

/**
 * A top-up as the API gives it. Token amounts (`amount`, `send`, `sendAtLeast`, `deposited`, `refunded`) are decimal
 * strings in the token's own units; `estimatedCredits` and `credited` are USD. Null is what it doesn't have yet.
 */
export interface Topup {
  readonly id: string;
  readonly status: string;
  readonly message: string | null;
  readonly network: string;
  readonly token: string;
  readonly amount: string;
  readonly depositAddress: string | null;
  readonly depositMemo: string | null;
  readonly send: string | null;
  readonly sendAtLeast: string | null;
  readonly estimatedCredits: string | null;
  readonly payBy: string;
  readonly addressExpiresAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deposited: string | null;
  readonly credited: string | null;
  // The delivery's transaction hash on NEAR, once credited
  readonly transaction: string | null;
  readonly refunded: string | null;
  readonly refundReason: string | null;
}

/** A token a top-up can come from. `address` is its contract, when it has one. */
export interface TopupToken {
  readonly symbol: string;
  readonly address?: string;
  readonly decimals: number;
}

/** A network a top-up can come from: its name, the least a top-up on it must be worth in USD, and its tokens, missing when their list can't be read. */
export interface TopupNetwork {
  readonly name: string;
  readonly minimum: string;
  readonly tokens?: readonly TopupToken[];
}

export interface TopupOptions {
  // What a top-up adds to the balance
  readonly asset: string;
  readonly networks: readonly TopupNetwork[];
}

/** What `POST /v1/topups` takes: a network's name, a symbol (or the token's address when two share it), and an amount in the token's units. */
export interface NewTopup {
  readonly network: string;
  readonly token: string;
  readonly amount: string;
}

/** How long `POST /v1/topups` waits for its answer: it asks the swap service for an address, which can take a while. */
export const createTopupTimeoutMs = 60_000;

/** Whether the API answered `503 topups_unavailable`: top-ups are off. */
export const isTopupsOff = (error: unknown): boolean => error instanceof ConsoleApiError && error.status === 503 && error.code === 'topups_unavailable';

const amountPattern = /^-?\d{1,18}(?:\.\d{1,18})?$/;
const isAmount = (value: unknown): value is string => typeof value === 'string' && amountPattern.test(value);
const orNull = <TValue,>(value: unknown, test: (item: unknown) => item is TValue): TValue | null | undefined => value === null || value === undefined ? null : test(value) ? value : undefined;
const isTime = (value: unknown): value is string => isText(value, 64) && !Number.isNaN(Date.parse(value));
const isTargetPath = (value: unknown): value is string => typeof value === 'string' && value.length <= 4096;

const objectOf = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw unexpected();

  return value as Record<string, unknown>;
};

const keyOf = (value: unknown): PaymentKey => {
  const item = objectOf(value);
  const label = orNull(item['label'], (text): text is string => typeof text === 'string' && text.length <= 200);
  const allowance = orNull(item['allowance'], isAmount);
  const maxPrice = orNull(item['maxPrice'], isAmount);
  const expiresAt = orNull(item['expiresAt'], isTime);
  const revokedAt = orNull(item['revokedAt'], isTime);
  const spent = objectOf(item['spent']);
  const remaining = objectOf(item['remaining']);
  const remainingAllowance = orNull(remaining['allowance'], isAmount);
  if (!isText(item['id']) || !isAmount(item['dailyBudget']) || !isTime(item['createdAt']) || label === undefined || allowance === undefined || maxPrice === undefined
    || expiresAt === undefined || revokedAt === undefined || !isAmount(spent['today']) || !isAmount(spent['total']) || !isAmount(remaining['dailyBudget']) || remainingAllowance === undefined)
    throw unexpected();

  return {
    id: item['id'],
    label,
    allowance,
    dailyBudget: item['dailyBudget'],
    maxPrice,
    expiresAt,
    createdAt: item['createdAt'],
    revokedAt,
    spent: { today: spent['today'], total: spent['total'] },
    remaining: { allowance: remainingAllowance, dailyBudget: remaining['dailyBudget'] },
  };
};

const listOf = (value: unknown, name: string): readonly unknown[] => {
  const list = objectOf(value)[name];
  if (!Array.isArray(list))
    throw unexpected();

  return list;
};

const nextOf = (value: unknown): string | null => {
  const next = objectOf(value)['next'];
  if (next === null || next === undefined)
    return null;
  if (!isText(next, 2048))
    throw unexpected();

  return next;
};

/** `GET /v1/keys`: every key of the account, revoked ones too. */
export const listKeys = async (apiUrl: string): Promise<readonly PaymentKey[]> =>
  listOf(await keyedRequest(apiUrl, { method: 'GET', path: '/v1/keys' }), 'keys').map(keyOf);

/** `POST /v1/keys`: a new key and the payment key itself, shown once. The caller holds `paymentKey` in the state of its dialog, and nowhere else. */
export const createKey = async (apiUrl: string, fields: KeyFields): Promise<{ readonly key: PaymentKey; readonly paymentKey: string }> => {
  const answer = await keyedRequest(apiUrl, { method: 'POST', path: '/v1/keys', body: fields });
  const { key: paymentKey } = objectOf(answer);
  if (!isKey(paymentKey))
    throw unexpected();

  return { key: keyOf(answer), paymentKey };
};

/** `PATCH /v1/keys/:id`: the key with its new limits. */
export const changeKey = async (apiUrl: string, id: string, fields: KeyFields): Promise<PaymentKey> =>
  keyOf(await keyedRequest(apiUrl, { method: 'PATCH', path: apiPath`/v1/keys/${id}`, body: fields }));

/** `DELETE /v1/keys/:id`: the key stops at once. */
export const revokeKey = async (apiUrl: string, id: string): Promise<{ readonly id: string; readonly revokedAt: string }> => {
  const { id: revoked, revokedAt } = objectOf(await keyedRequest(apiUrl, { method: 'DELETE', path: apiPath`/v1/keys/${id}` }));
  if (!isText(revoked) || !isTime(revokedAt))
    throw unexpected();

  return { id: revoked, revokedAt };
};

const paymentStates: readonly unknown[] = ['paid', 'free', 'pending'];

const paymentOf = (value: unknown): Payment => {
  const item = objectOf(value);
  const requestId = orNull(item['requestId'], isText);
  const keyId = orNull(item['keyId'], isText);
  const upstreamStatus = item['upstreamStatus'] === null || item['upstreamStatus'] === undefined ? null : item['upstreamStatus'];
  const state = item['state'];
  if (!isText(item['id']) || requestId === undefined || !isText(item['rail'], 64) || !isText(item['targetHost']) || !isTargetPath(item['targetPath']) || !isAmount(item['amount'])
    || !isText(item['status'], 64) || !isTime(item['createdAt']) || !isTime(item['updatedAt']) || keyId === undefined
    || (upstreamStatus !== null && !(typeof upstreamStatus === 'number' && Number.isInteger(upstreamStatus) && upstreamStatus >= 0 && upstreamStatus < 1000))
    || !paymentStates.includes(state))
    throw unexpected();

  return {
    id: item['id'],
    requestId,
    rail: item['rail'],
    targetHost: item['targetHost'],
    targetPath: item['targetPath'],
    amount: item['amount'],
    status: item['status'],
    createdAt: item['createdAt'],
    updatedAt: item['updatedAt'],
    keyId,
    upstreamStatus,
    state: state as PaymentState,
  };
};

/** `GET /v1/payments`: a page of the account's calls, newest first, and the cursor of the page after it. Only the parameters the API knows are sent. */
export const listPayments = async (apiUrl: string, { limit, after, state, keyId, service }: PaymentsQuery): Promise<{ readonly payments: readonly Payment[]; readonly next: string | null }> => {
  const query: Record<string, string> = { limit: String(limit) };
  if (after !== undefined)
    query['after'] = after;
  if (state !== undefined)
    query['state'] = state;
  if (keyId !== undefined)
    query['keyId'] = keyId;
  if (service !== undefined)
    query['service'] = service;
  const answer = await keyedRequest(apiUrl, { method: 'GET', path: '/v1/payments', query });

  return { payments: listOf(answer, 'payments').map(paymentOf), next: nextOf(answer) };
};

// A token amount in the token's own units: up to 30 digits each side of the point, as the API takes them
const tokenAmountPattern = /^\d{1,30}(?:\.\d{1,30})?$/;
const isTokenAmount = (value: unknown): value is string => typeof value === 'string' && tokenAmountPattern.test(value);
// A deposit address: printable ASCII with no space, so what the page shows, copies and puts in the QR code is every character there is
const isAddress = (value: unknown): value is string => typeof value === 'string' && /^[\x21-\x7e]{1,256}$/.test(value);
// A memo: printable ASCII, a space only inside it
const isMemo = (value: unknown): value is string => typeof value === 'string' && /^[\x21-\x7e](?:[\x20-\x7e]{0,254}[\x21-\x7e])?$/.test(value);

/** A top-up from the API, every field checked. One of another shape is no top-up: the whole answer is refused. */
export const topupOf = (value: unknown): Topup => {
  const item = objectOf(value);
  const message = orNull(item['message'], isText);
  const depositAddress = orNull(item['depositAddress'], isAddress);
  const depositMemo = orNull(item['depositMemo'], isMemo);
  const send = orNull(item['send'], isTokenAmount);
  const sendAtLeast = orNull(item['sendAtLeast'], isTokenAmount);
  const estimatedCredits = orNull(item['estimatedCredits'], isAmount);
  const addressExpiresAt = orNull(item['addressExpiresAt'], isTime);
  const deposited = orNull(item['deposited'], isTokenAmount);
  const credited = orNull(item['credited'], isAmount);
  const transaction = orNull(item['transaction'], (text): text is string => isText(text, 128));
  const refunded = orNull(item['refunded'], isTokenAmount);
  const refundReason = orNull(item['refundReason'], isText);
  if (!isText(item['id']) || !isText(item['status'], 64) || message === undefined || !isText(item['network'], 64) || !isText(item['token'], 64) || !isTokenAmount(item['amount'])
    || depositAddress === undefined || depositMemo === undefined || send === undefined || sendAtLeast === undefined || estimatedCredits === undefined || !isTime(item['payBy'])
    || addressExpiresAt === undefined || !isTime(item['createdAt']) || !isTime(item['updatedAt']) || deposited === undefined || credited === undefined || transaction === undefined
    || refunded === undefined || refundReason === undefined)
    throw unexpected();

  return {
    id: item['id'],
    status: item['status'],
    message,
    network: item['network'],
    token: item['token'],
    amount: item['amount'],
    depositAddress,
    depositMemo,
    send,
    sendAtLeast,
    estimatedCredits,
    payBy: item['payBy'],
    addressExpiresAt,
    createdAt: item['createdAt'],
    updatedAt: item['updatedAt'],
    deposited,
    credited,
    transaction,
    refunded,
    refundReason,
  };
};

/** `GET /v1/topups`: a page of the account's top-ups, newest first. `503 topups_unavailable` when top-ups are off. */
export const listTopups = async (apiUrl: string, limit: number, after?: string): Promise<{ readonly topups: readonly Topup[]; readonly next: string | null }> => {
  const query: Record<string, string> = { limit: String(limit) };
  if (after !== undefined)
    query['after'] = after;
  const answer = await keyedRequest(apiUrl, { method: 'GET', path: '/v1/topups', query });

  return { topups: listOf(answer, 'topups').map(topupOf), next: nextOf(answer) };
};

/** `GET /v1/topups/:id`: the top-up as it stands now. An answer for another top-up is refused. */
export const readTopup = async (apiUrl: string, id: string): Promise<Topup> => {
  const topup = topupOf(await keyedRequest(apiUrl, { method: 'GET', path: apiPath`/v1/topups/${id}` }));
  if (topup.id !== id)
    throw unexpected();

  return topup;
};

/**
 * `POST /v1/topups`: a new deposit address, `waiting`. Each request makes a new address, so it is sent once and never
 * again by this code; it waits `createTopupTimeoutMs` for the answer.
 */
export const createTopup = async (apiUrl: string, body: NewTopup): Promise<Topup> =>
  topupOf(await keyedRequest(apiUrl, { method: 'POST', path: '/v1/topups', body: { network: body.network, token: body.token, amount: body.amount }, timeoutMs: createTopupTimeoutMs }));

const isDecimals = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 36;

const topupTokenOf = (value: unknown): TopupToken => {
  const item = objectOf(value);
  const address = item['address'];
  if (!isText(item['symbol'], 64) || (address !== undefined && address !== null && !isText(address, 256)) || !isDecimals(item['decimals']))
    throw unexpected();

  return { symbol: item['symbol'], ...typeof address === 'string' ? { address } : {}, decimals: item['decimals'] };
};

const topupNetworkOf = (value: unknown): TopupNetwork => {
  const item = objectOf(value);
  const tokens = item['tokens'];
  if (!isText(item['name'], 64) || !isAmount(item['minimum']) || (tokens !== undefined && tokens !== null && !Array.isArray(tokens)))
    throw unexpected();

  return { name: item['name'], minimum: item['minimum'], ...Array.isArray(tokens) ? { tokens: tokens.map(topupTokenOf) } : {} };
};

/** `GET /v1/topups/options`, with no key: the networks and tokens a top-up can come from. `503 topups_unavailable` when top-ups are off. */
export const readTopupOptions = async (apiUrl: string): Promise<TopupOptions> => {
  const answer = objectOf(await send(apiUrl, { method: 'GET', path: '/v1/topups/options' }, undefined));
  const networks = answer['networks'];
  if (!isText(answer['asset'], 128) || !Array.isArray(networks))
    throw unexpected();

  return { asset: answer['asset'], networks: networks.map(topupNetworkOf) };
};
