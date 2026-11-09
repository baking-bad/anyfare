// One plain line for each error Anyfare answers with, and whether the buyer was charged.

import type { PayWay } from './cli.ts';
import type { Answer } from './http.ts';
import { HttpError, Stop, isRecord } from './util.ts';

export interface ErrorContext {
  /** Which part of Anyfare answered: the Platform API, or the proxy. */
  readonly side: 'api' | 'proxy';
  /** Set for a routed call that carried a payment: how it paid, and the API's name for the line. */
  readonly paid?: { readonly way: PayWay; readonly apiName: string };
}

export interface ErrorLine {
  /** The line, without a final period. */
  readonly line: (error: HttpError, context: ErrorContext) => string;
  /** `true`: a paid call that got this answer was not charged. `'credits'`: only when it paid with Credits. */
  readonly notCharged: boolean | 'credits';
}

export type ErrorTable = Readonly<Record<string, ErrorLine>>;

const MAX_TEXT = 200;

/** "retry in 30 seconds", from `Retry-After` in seconds. */
export function retryIn(error: HttpError): string {
  const value = error.retryAfter?.trim();
  if (value !== undefined && /^[0-9]{1,6}$/.test(value)) {
    const seconds = Number(value);
    return `retry in ${seconds} second${seconds === 1 ? '' : 's'}`;
  }
  return 'retry in a moment';
}

/** The message of Anyfare's envelope, when the answer had one. */
function serverMessage(error: HttpError): string | undefined {
  const body = error.body;
  if (!isRecord(body) || !isRecord(body['error'])) return undefined;
  const message = body['error']['message'];
  return typeof message === 'string' ? message : undefined;
}

const withText = (head: string, text: string): string => (text === '' ? head : `${head}: ${text}`);

const fixed = (line: string) => (): string => line;
const bySide = (api: string, proxy: string) => (_error: HttpError, context: ErrorContext): string =>
  context.side === 'api' ? api : proxy;
const retrying = (line: string) => (error: HttpError): string => `${line}; ${retryIn(error)}`;

/** Every code of the Platform API and the proxy. Later payers add their own lines with `stopFor`'s `extra`. */
export const ERROR_LINES: ErrorTable = {
  // Either host
  // Anyfare's own messages for it never quote a value the request carried, so the message is shown
  invalid_request: {
    line: (error) => withText('Anyfare refused the request as not valid', clip(serverMessage(error) ?? '')),
    notCharged: true,
  },
  unauthorized: {
    line: bySide('The Platform API needs the master key, and none was sent', 'Anyfare needs a payment key here, and none was sent'),
    notCharged: true,
  },
  invalid_key: {
    line: bySide('The master key was refused: unknown or revoked', 'The payment key was refused: unknown, revoked or expired'),
    notCharged: true,
  },
  wrong_key_type: {
    line: bySide(
      'That is a payment key; the Platform API takes the master key',
      'That is a master key; paid calls take a payment key',
    ),
    notCharged: true,
  },
  rate_limited: { line: retrying('Too many requests'), notCharged: true },
  not_found: { line: fixed('Anyfare has nothing at that address'), notCharged: true },
  request_too_large: { line: fixed('The request is too large for Anyfare'), notCharged: true },
  unsupported_media_type: { line: fixed('Anyfare does not take the content type of the request'), notCharged: true },
  internal_error: { line: fixed('Anyfare failed with an internal error'), notCharged: false },
  // The Platform API
  idempotency_conflict: { line: fixed('Anyfare refused a reference that was used before for another request'), notCharged: true },
  // The proxy: the routing link and the target
  invalid_target: { line: fixed("Anyfare can't read the routing link: it must be the API's URL without https://"), notCharged: true },
  host_not_allowed: { line: fixed("Anyfare doesn't route payments to this API's host"), notCharged: true },
  not_payable: { line: fixed("The API didn't ask for a payment, so there is nothing for Anyfare to pay"), notCharged: true },
  unsupported_payment: { line: fixed('The API asks for no payment Anyfare can make'), notCharged: true },
  quote_exceeded: { line: fixed('The API asked for more than it quoted, so Anyfare paid nothing'), notCharged: true },
  // The proxy: the buyer's payment
  multiple_payment_methods: { line: fixed('The request carried more than one payment; send exactly one'), notCharged: true },
  insufficient_balance: { line: fixed("Your Credits don't cover this call. Top up, or ask the operator"), notCharged: true },
  key_budget_exceeded: { line: fixed("The payment key's daily budget is used up"), notCharged: true },
  key_allowance_exceeded: { line: fixed("The payment key's allowance is used up"), notCharged: true },
  key_price_limit: { line: fixed("The price is above the payment key's highest price per call"), notCharged: true },
  payment_invalid: { line: fixed("Anyfare refused the payment: it doesn't match the price, or it was used before"), notCharged: true },
  // Its outcome can be unknown, so it is never said to be not charged
  settlement_failed: { line: fixed("The payment couldn't be settled, so the answer was not sent"), notCharged: false },
  response_too_large: { line: fixed("The API's answer was too large to hold, so it was not sent"), notCharged: true },
  // Credits release the hold on it; a payment that settles before the answer may not be released
  upstream_unavailable: { line: fixed("The API or Anyfare's payer failed; retry later"), notCharged: 'credits' },
  facilitator_unavailable: { line: fixed("The payment facilitator didn't answer, so nothing was paid; retry later"), notCharged: true },
  payment_unavailable: { line: retrying("Anyfare couldn't take the payment right now"), notCharged: true },
  redis_not_ready: { line: fixed("Anyfare's store is not ready, so nothing was paid; retry later"), notCharged: true },
};

/**
 * The codes the proxy itself answers with: its error table, and two of the shared server's. On a paid
 * routed call, an error body with any other code is the API's own answer, passed through.
 */
export const PROXY_CODES: ReadonlySet<string> = new Set([
  'invalid_target',
  'host_not_allowed',
  'not_payable',
  'unsupported_payment',
  'quote_exceeded',
  'multiple_payment_methods',
  'unauthorized',
  'invalid_key',
  'wrong_key_type',
  'insufficient_balance',
  'key_budget_exceeded',
  'key_allowance_exceeded',
  'key_price_limit',
  'payment_invalid',
  'rate_limited',
  'settlement_failed',
  'response_too_large',
  'upstream_unavailable',
  'facilitator_unavailable',
  'payment_unavailable',
  'redis_not_ready',
  // The shared server's code that only the proxy itself can answer on a routed call: a body over its
  // limit is refused before the call is routed. The routed scope takes every content type, so a 415
  // there is the target's own. The shared server's not_found, invalid_request and internal_error are
  // left out on purpose: a target answers those too, and the proxy passes a target's answer below 500
  // through, so on a paid call they are read as the API's own.
  'request_too_large',
]);

/** Any key in a text, cut to its first 10 characters. */
export function hideKeys(text: string): string {
  return text.replace(/afm?_[A-Za-z0-9_]{12,}/g, (key) => `${key.slice(0, 10)}…`);
}

/** Text from an answer as one short line: no control characters, no keys, at most 200 characters. */
export function clip(text: string): string {
  const flat = hideKeys(text.replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, ' ').trim());
  return flat.length > MAX_TEXT ? `${flat.slice(0, MAX_TEXT)}…` : flat;
}

function bodyText(body: unknown): string {
  if (typeof body === 'string') return clip(body);
  if (body === undefined || body === null) return '';
  return clip(JSON.stringify(body));
}

/** An answer that is not `2xx` as an `HttpError`, with Anyfare's code when the body is its envelope. */
export function httpErrorOf(answer: Answer): HttpError {
  let code: string | undefined;
  let message = `The server answered ${answer.status}`;
  const body = answer.body;
  if (isRecord(body) && isRecord(body['error']) && typeof body['error']['code'] === 'string') {
    code = body['error']['code'];
    if (typeof body['error']['message'] === 'string') message = body['error']['message'];
  }
  const requestId = answer.headers.get('x-request-id');
  const retryAfter = answer.headers.get('retry-after');
  return new HttpError(answer.status, message, {
    ...(code !== undefined && { code }),
    ...(requestId !== null && { requestId }),
    ...(retryAfter !== null && { retryAfter }),
    body,
  });
}

function finish(line: string, error: HttpError, notCharged: boolean): Stop {
  const id = error.requestId?.trim();
  const request = id !== undefined && /^[\x21-\x7e]{1,200}$/.test(id) ? ` (request ${id})` : '';
  const text = `${line}${request}`;
  return new Stop(/[.!?]$/.test(text) ? text : `${text}.`, { notCharged });
}

/** The one `Stop` line for an error answer. `notCharged` is set only for a paid call, where it is known. */
export function stopFor(error: HttpError, context: ErrorContext, extra: ErrorTable = {}): Stop {
  const paid = context.paid;
  const code = error.code;
  const anyfares = code !== undefined && (paid === undefined || PROXY_CODES.has(code) || Object.hasOwn(extra, code));
  if (code !== undefined && anyfares) {
    const entry = Object.hasOwn(extra, code) ? extra[code] : Object.hasOwn(ERROR_LINES, code) ? ERROR_LINES[code] : undefined;
    if (entry === undefined) {
      return finish(withText(`Anyfare answered ${error.status} ${clip(code)}`, clip(error.message)), error, false);
    }
    const notCharged =
      paid !== undefined && (entry.notCharged === true || (entry.notCharged === 'credits' && paid.way === 'credits'));
    return finish(entry.line(error, context), error, notCharged);
  }
  // On a paid call, a body without one of the proxy's codes is not Anyfare's own answer
  if (paid !== undefined) {
    // The combined 402 again: the payment it carried was not taken
    if (error.status === 402) {
      const what = paid.way === 'credits' ? 'the key' : 'the payment';
      return finish(`Anyfare asked for a payment again: ${what} was not accepted`, error, true);
    }
    // Anyfare passes the API's own answer through below 500, and Credits release the hold on it.
    // A 5xx that is not Anyfare's envelope came from something in front of it: the outcome is not known.
    if (error.status < 500) {
      return finish(withText(`${paid.apiName} answered ${error.status}`, bodyText(error.body)), error, paid.way === 'credits');
    }
  }
  return finish(withText(`Anyfare answered ${error.status}`, bodyText(error.body)), error, false);
}
