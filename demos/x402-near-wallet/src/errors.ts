// One plain line for each error Anyfare's proxy answers with, and whether the buyer was charged.

import type { Answer } from './http.ts';
import { Stop, isRecord } from './util.ts';

/** An answer that is not `2xx`. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly requestId: string | undefined;
  readonly retryAfter: string | undefined;
  readonly body: unknown;

  constructor(
    status: number,
    message: string,
    details: {
      readonly code?: string;
      readonly requestId?: string;
      readonly retryAfter?: string;
      readonly body?: unknown;
    } = {},
  ) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = details.code;
    this.requestId = details.requestId;
    this.retryAfter = details.retryAfter;
    this.body = details.body;
  }
}

export interface ErrorContext {
  /**
   * Set for a request that carried a payment: the API's name for the line, and where the payer's
   * payments are seen, such as "https://nearblocks.io/address/alice.near shows your payments".
   */
  readonly paid?: { readonly apiName: string; readonly check: string };
  /** The answer's body was shown already, in the result block: the line does not repeat it. */
  readonly bodyShown?: boolean;
}

export interface ErrorLine {
  /** The line, without a final period. */
  readonly line: (error: HttpError) => string;
  /**
   * `true`: a paid request that got this answer was not charged. A function: when the answer's own
   * message decides it.
   */
  readonly notCharged: boolean | ((error: HttpError) => boolean);
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

const withText = (head: string, text: string): string => (text === '' ? head : `${head}: ${text}`);
const fixed = (line: string) => (): string => line;
const retrying = (line: string) => (error: HttpError): string => `${line}; ${retryIn(error)}`;

/** The proxy's codes on a routed request. Later payers add their own lines with `stopFor`'s `extra`. */
export const ERROR_LINES: ErrorTable = {
  // The routing link and the target
  invalid_target: { line: fixed("Anyfare can't read the routing link: it must be the API's URL without https://"), notCharged: true },
  host_not_allowed: { line: fixed("Anyfare doesn't route payments to this API's host"), notCharged: true },
  not_payable: { line: fixed("The API didn't ask for a payment, so there is nothing for Anyfare to pay"), notCharged: true },
  unsupported_payment: { line: fixed('The API asks for no payment Anyfare can make'), notCharged: true },
  quote_exceeded: { line: fixed('The API asked for more than it quoted, so Anyfare paid nothing'), notCharged: true },
  request_too_large: { line: fixed('The request is too large for Anyfare'), notCharged: true },
  rate_limited: { line: retrying('Too many requests'), notCharged: true },
  // The buyer's payment
  multiple_payment_methods: { line: fixed('The request carried more than one payment; send exactly one'), notCharged: true },
  payment_invalid: { line: fixed("Anyfare refused the payment: it doesn't match the price, or it was used before"), notCharged: true },
  // Its outcome can be unknown, so it is never said to be not charged
  settlement_failed: { line: fixed("The payment couldn't be settled, so the answer was not sent"), notCharged: false },
  response_too_large: { line: fixed("The API's answer was too large to hold, so it was not sent"), notCharged: true },
  upstream_unavailable: { line: fixed("The API or Anyfare's payer failed; retry later"), notCharged: false },
  facilitator_unavailable: { line: fixed("The payment facilitator didn't answer, so nothing was paid; retry later"), notCharged: true },
  payment_unavailable: { line: retrying("Anyfare couldn't take the payment right now"), notCharged: true },
  redis_not_ready: { line: fixed("Anyfare's store is not ready, so nothing was paid; retry later"), notCharged: true },
};

/**
 * The codes the proxy itself answers with on a routed request. An error body with any other code is
 * the API's own answer, passed through. The shared server's not_found, invalid_request and
 * internal_error are left out on purpose: an API answers those too, and the proxy passes an API's
 * answer below 500 through.
 */
export const PROXY_CODES: ReadonlySet<string> = new Set(Object.keys(ERROR_LINES));

/**
 * Any Anyfare key in a text, cut to its first 10 characters: one that starts a word, not `af_` inside
 * a word such as `leaf_nodes`. Anything shaped like a wallet's private key, `0x` and 64 hex digits or
 * a NEAR `ed25519:` one, is hidden whole: no part of it is shown.
 */
export function hideKeys(text: string): string {
  return text
    .replace(/(?<![A-Za-z0-9_.-])afm?_[A-Za-z0-9_]{12,}/g, (key) => `${key.slice(0, 10)}…`)
    .replace(/0x[0-9A-Fa-f]{64}(?![0-9A-Fa-f])/g, '0x…')
    .replace(/(?:ed25519|secp256k1):[1-9A-HJ-NP-Za-km-z]{32,}/g, (key) => `${key.slice(0, key.indexOf(':') + 1)}…`);
}

/** Text from an answer as one short line: no control characters, no keys, at most 200 characters. */
export function clip(text: string): string {
  const flat = hideKeys(text.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\s]+/g, ' ').trim());
  return flat.length > MAX_TEXT ? `${flat.slice(0, MAX_TEXT)}…` : flat;
}

/** A body as one short line. Never throws: a body that can't be written as JSON is left out. */
function bodyText(body: unknown): string {
  if (typeof body === 'string') return clip(body);
  if (body === undefined || body === null) return '';
  try {
    return clip(JSON.stringify(body));
  } catch {
    return '';
  }
}

/** The code of Anyfare's envelope `{ "error": { "code", "message" } }`, when the body is one. */
export function envelopeCode(body: unknown): string | undefined {
  if (!isRecord(body) || !isRecord(body['error'])) return undefined;
  const code = body['error']['code'];
  return typeof code === 'string' ? code : undefined;
}

/** Whether a body is the proxy's own envelope: one with a code of `PROXY_CODES`. */
export function isProxyEnvelope(body: unknown): boolean {
  const code = envelopeCode(body);
  return code !== undefined && PROXY_CODES.has(code);
}

/** An answer that is not `2xx` as an `HttpError`, with Anyfare's code when the body is its envelope. */
export function httpErrorOf(answer: Answer): HttpError {
  let message = `The server answered ${answer.status}`;
  const body = answer.body;
  const code = envelopeCode(body);
  if (code !== undefined && isRecord(body) && isRecord(body['error']) && typeof body['error']['message'] === 'string') {
    message = body['error']['message'];
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

function finish(line: string, error: HttpError, notCharged: boolean, context: ErrorContext): Stop {
  const id = error.requestId?.trim();
  const request = id !== undefined && /^[\x21-\x7e]{1,200}$/.test(id) ? ` (request ${id})` : '';
  const text = `${line}${request}`;
  const sentence = /[.!?]$/.test(text) ? text : `${text}.`;
  // A paid request that is not proved free: say so, and where to look, unless the line says it already
  const check = context.paid?.check;
  if (check !== undefined && !notCharged && !sentence.includes(check)) {
    return new Stop(`${sentence} Whether the payment was taken is not known: ${check}.`);
  }
  return new Stop(sentence, { notCharged });
}

/**
 * The one `Stop` line for an error answer of Anyfare's proxy. `notCharged` is set only for a paid
 * request, where it is known; a paid request that is not proved free says it is not known.
 */
export function stopFor(error: HttpError, context: ErrorContext, extra: ErrorTable = {}): Stop {
  const paid = context.paid;
  const code = error.code;
  const anyfares = code !== undefined && (paid === undefined || PROXY_CODES.has(code) || Object.hasOwn(extra, code));
  const body = context.bodyShown === true ? '' : bodyText(error.body);
  if (code !== undefined && anyfares) {
    const entry = Object.hasOwn(extra, code) ? extra[code] : Object.hasOwn(ERROR_LINES, code) ? ERROR_LINES[code] : undefined;
    if (entry === undefined) {
      return finish(withText(`Anyfare answered ${error.status} ${clip(code)}`, clip(error.message)), error, false, context);
    }
    const rule = entry.notCharged;
    const notCharged = paid !== undefined && (typeof rule === 'function' ? rule(error) : rule);
    return finish(entry.line(error), error, notCharged, context);
  }
  // On a paid request, a body without one of the proxy's codes is not Anyfare's own answer
  if (paid !== undefined) {
    // The 402 again: the payment it carried was not taken
    if (error.status === 402) return finish('Anyfare asked for a payment again: the payment was not accepted', error, true, context);
    // Anyfare passes the API's own answer through below 500, and cancels the x402 payment, never
    // settled, since only a 2xx is billable. A 5xx that is not Anyfare's envelope came from something
    // in front of it: the outcome is not known.
    if (error.status < 500) return finish(withText(`${paid.apiName} answered ${error.status}`, body), error, true, context);
  }
  return finish(withText(`Anyfare answered ${error.status}`, body), error, false, context);
}
