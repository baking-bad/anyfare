// A call paid through Anyfare, found on Anyfare's public API by its NEAR transaction, to show its ID
// and its receipt page. Only reads that need no key. Every failure is a result, never thrown, and the
// whole lookup takes 8 seconds at most.

import { USER_AGENT, limitText, readBody } from './http.ts';
import type { Fetch } from './http.ts';
import { NEAR_NETWORK } from './networks.ts';
import { fetchFailure, raceLimit } from './rpc.ts';
import { isRecord } from './util.ts';

/** The time limits: each request, and the whole lookup. */
export const CALL_REQUEST_TIMEOUT_MS = 5_000;
export const CALL_LOOKUP_TIMEOUT_MS = 8_000;
/** Tries in all, and the pause between two: Anyfare may write the call a moment after its answer. */
const TRIES = 3;
const PAUSE_MS = 1_000;
/** How far a call's time may be from this machine's clock. */
const WINDOW_MS = 10 * 60_000;
/** The calls listed, and how many of the newest are read. */
const LIST_SIZE = 10;
const MAX_CANDIDATES = 3;
/** The most of an answer that is read. */
const MAX_ANSWER_BYTES = 1_000_000;

const CALL_ID = /^pay_[A-Za-z0-9_-]{1,60}$/;
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
// A host name of two labels or more, with its port when it has one
const HOST = new RegExp(`^(?=[^:]{1,253}(?::|$))${LABEL}(?:\\.${LABEL})+(?::[0-9]{1,5})?$`);

export interface CallLimits {
  /** Each request. Default 5 seconds. */
  readonly requestMs?: number;
  /** The whole lookup. Default 8 seconds. */
  readonly totalMs?: number;
  /** Tries in all. Default 3. */
  readonly tries?: number;
  /** Between two tries. Default 1 second. */
  readonly pauseMs?: number;
  /** How far a call's time may be from this machine's clock. Default 10 minutes. */
  readonly windowMs?: number;
}

export interface CallQuery {
  /** Anyfare's API, with no trailing slash. */
  readonly apiUrl: string;
  /** The API's host, as Anyfare routed the call. */
  readonly host: string;
  /** The payer's NEAR account. */
  readonly accountId: string;
  /** The payment's NEAR transaction, from its PAYMENT-RESPONSE. */
  readonly transaction: string;
  readonly limits?: CallLimits;
}

/** The call's ID; or why it was not found, in a few words of the app's own. */
export type CallLookup = { readonly kind: 'found'; readonly id: string } | { readonly kind: 'not_found'; readonly reason: string };

const notFound = (reason: string): CallLookup => ({ kind: 'not_found', reason });

/**
 * The API's host of a request through Anyfare's pay host: the first part of its path, lowercase, such
 * as `pro-api.coinmarketcap.com`. `undefined` when it is not a host name.
 */
export function routedHost(url: string): string | undefined {
  const first = URL.parse(url)?.pathname.split('/')[1]?.toLowerCase() ?? '';
  return HOST.test(first) ? first : undefined;
}

/** One read of Anyfare's API: its JSON, a 404, or why it failed. */
type Read = { readonly kind: 'json'; readonly value: unknown } | { readonly kind: 'missing' } | { readonly kind: 'failed'; readonly reason: string };

/** Why a request failed before an answer: a time limit, or no connection. Nothing of the answer's own. */
function failureReason(error: unknown, url: string, host: string, requestMs: number): string {
  const name = (error as { name?: unknown } | null)?.name;
  if (name === 'TimeoutError') return `${host} did not answer within ${limitText(requestMs)}`;
  const why = fetchFailure(error, url);
  return why === undefined || why === '' ? `could not reach ${host}` : `could not reach ${host}: ${why}`;
}

/** A GET of `url`, never redirected, with no headers but `Accept` and the user agent. Never throws. */
async function readJson(fetchFn: Fetch, url: string, requestMs: number, stop: AbortSignal): Promise<Read> {
  const host = URL.parse(url)?.host ?? "Anyfare's API";
  let response: Response;
  try {
    response = await fetchFn(url, {
      method: 'GET',
      headers: { accept: 'application/json', 'user-agent': USER_AGENT },
      redirect: 'error',
      signal: AbortSignal.any([stop, AbortSignal.timeout(requestMs)]),
    });
  } catch (error) {
    return { kind: 'failed', reason: failureReason(error, url, host, requestMs) };
  }
  if (response.status !== 200) {
    void response.body?.cancel().catch(() => undefined);
    return response.status === 404 ? { kind: 'missing' } : { kind: 'failed', reason: `${host} answered ${response.status}` };
  }
  try {
    const { bytes, truncated } = await readBody(response, MAX_ANSWER_BYTES);
    if (truncated) return { kind: 'failed', reason: `${host} sent more than 1 MB` };
    return { kind: 'json', value: JSON.parse(new TextDecoder().decode(bytes)) as unknown };
  } catch (error) {
    if (error instanceof SyntaxError) return { kind: 'failed', reason: `${host} sent an answer this app can't read` };
    return { kind: 'failed', reason: failureReason(error, url, host, requestMs) };
  }
}

/**
 * The IDs of the listed calls that may be this payment, newest first, at most 3: paid in NEAR by this
 * payer, with an ID of Anyfare's form, and a time within the window of `now`.
 */
function candidates(calls: readonly unknown[], accountId: string, windowMs: number, now: number): string[] {
  const found: { readonly id: string; readonly at: number }[] = [];
  for (const call of calls) {
    if (!isRecord(call)) continue;
    const { id, at, payer, paidWith } = call;
    if (typeof id !== 'string' || !CALL_ID.test(id) || payer !== accountId || paidWith !== 'near') continue;
    const time = typeof at === 'string' ? Date.parse(at) : Number.NaN;
    if (Number.isFinite(time) && Math.abs(now - time) <= windowMs) found.push({ id, at: time });
  }
  return found
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_CANDIDATES)
    .map((item) => item.id);
}

/** Whether a receipt is of this payment: on NEAR mainnet, with this very transaction. */
function isOfPayment(receipt: unknown, transaction: string): boolean {
  const buyer = isRecord(receipt) ? receipt['buyer'] : undefined;
  return isRecord(buyer) && buyer['network'] === NEAR_NETWORK && buyer['transaction'] === transaction;
}

/** One try: the list, then the receipts of its candidates. `undefined` when no call is this payment yet. */
async function tryOnce(fetchFn: Fetch, query: CallQuery, stop: AbortSignal): Promise<CallLookup | undefined> {
  const limits = query.limits ?? {};
  const requestMs = limits.requestMs ?? CALL_REQUEST_TIMEOUT_MS;
  const list = new URL('/v1/calls', query.apiUrl);
  list.search = new URLSearchParams({ paidWith: 'near', host: query.host, size: String(LIST_SIZE) }).toString();
  const listed = await readJson(fetchFn, list.href, requestMs, stop);
  if (listed.kind === 'failed') return notFound(listed.reason);
  if (listed.kind === 'missing') return notFound(`${list.host} answered 404`);
  const calls = isRecord(listed.value) ? listed.value['calls'] : undefined;
  if (!Array.isArray(calls)) return notFound(`${list.host} sent a list this app can't read`);
  for (const id of candidates(calls, query.accountId, limits.windowMs ?? WINDOW_MS, Date.now())) {
    const receipt = await readJson(fetchFn, new URL(`/v1/calls/${id}`, query.apiUrl).href, requestMs, stop);
    // A 404 is a call still in flight: not this payment's yet
    if (receipt.kind === 'failed') return notFound(receipt.reason);
    if (receipt.kind === 'json' && isOfPayment(receipt.value, query.transaction)) return { kind: 'found', id };
  }
  return undefined;
}

/** Waits `ms`, or less when `stop` is aborted. Its timer is cleared either way. */
function pause(ms: number, stop: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      stop.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    stop.addEventListener('abort', done, { once: true });
    if (stop.aborted) done();
  });
}

async function lookUp(fetchFn: Fetch, query: CallQuery, stop: AbortSignal): Promise<CallLookup> {
  const tries = Math.max(1, query.limits?.tries ?? TRIES);
  for (let tried = 1; ; tried += 1) {
    const found = await tryOnce(fetchFn, query, stop);
    if (found !== undefined) return found;
    if (tried >= tries) return notFound('no call with this transaction is listed yet');
    await pause(query.limits?.pauseMs ?? PAUSE_MS, stop);
    if (stop.aborted) return notFound('the lookup was stopped');
  }
}

/**
 * The call on Anyfare that this payment paid for. Lists Anyfare's newest NEAR calls to the API's
 * host, and reads the receipts of the payer's recent ones until one names this transaction; tries
 * again, 3 times in all, while none does. Each request takes 5 seconds at most, and the whole lookup 8.
 * Never throws: every failure is a `not_found` with its reason.
 */
export async function findAnyfareCall(fetchFn: Fetch, query: CallQuery): Promise<CallLookup> {
  const totalMs = query.limits?.totalMs ?? CALL_LOOKUP_TIMEOUT_MS;
  const stop = new AbortController();
  try {
    const found = await raceLimit(lookUp(fetchFn, query, stop.signal), totalMs);
    return found === 'late' ? notFound(`the lookup took more than ${limitText(totalMs)}`) : found;
  } catch {
    return notFound('the lookup failed');
  } finally {
    // Ends a request or a pause still running
    stop.abort();
  }
}
