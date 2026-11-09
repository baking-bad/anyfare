// Talking to Anyfare's proxy for free: the routing link, the quote, and the unpaid 402.

import { request } from './http.ts';
import type { Fetch } from './http.ts';
import { readOffers } from './offers.ts';
import type { Offer } from './offers.ts';
import type { ToolRequest } from './tools/types.ts';
import { Stop, isRecord } from './util.ts';

export const READ_TIMEOUT_MS = 20_000;

/** The target URL without `https://`, after the pay host. */
export function routingLink(payUrl: string, targetUrl: string): string {
  return `${payUrl.replace(/\/+$/, '')}/${targetUrl.replace(/^https:\/\//, '')}`;
}

export interface Check {
  readonly payable: true;
  readonly target: string;
  readonly price: {
    readonly amount: string;
    readonly currency: string;
    readonly asset: string | undefined;
    readonly network: string | undefined;
  };
  readonly quote: { readonly amount: string; readonly fee: string; readonly currency: string };
  readonly link: string;
}

export interface NotPayable {
  readonly payable: false;
  readonly reason: string;
  readonly message: string;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** What an error answer says, as one short phrase. */
export function describeFailure(status: number, body: unknown): string {
  if (isRecord(body) && isRecord(body['error'])) {
    const message = str(body['error']['message']);
    if (message !== undefined) return `answered ${status}: ${message}`;
  }
  return `answered ${status}`;
}

/** `GET /_/check`: a free quote. A `Stop` when Anyfare does not answer with a quote or a refusal. */
export async function checkQuote(
  fetchFn: Fetch,
  payUrl: string,
  targetUrl: string,
): Promise<Check | NotPayable> {
  const url = `${payUrl.replace(/\/+$/, '')}/_/check?url=${encodeURIComponent(targetUrl)}`;
  const answer = await request(fetchFn, { method: 'GET', url, timeoutMs: READ_TIMEOUT_MS });
  const body = answer.body;
  if (answer.status !== 200 || !isRecord(body)) {
    throw new Stop(`/_/check ${describeFailure(answer.status, body)}`);
  }
  if (body['payable'] === false) {
    return {
      payable: false,
      reason: str(body['reason']) ?? 'unknown',
      message: str(body['message']) ?? 'No reason was given',
    };
  }
  const price = body['price'];
  const quote = body['quote'];
  if (body['payable'] !== true || !isRecord(price) || !isRecord(quote)) {
    throw new Stop('/_/check answered something this app does not understand');
  }
  const amount = str(price['amount']);
  const total = str(quote['amount']);
  const fee = str(quote['fee']);
  if (amount === undefined || total === undefined || fee === undefined) {
    throw new Stop('/_/check answered a quote without its amounts');
  }
  const asset = str(price['asset']);
  const network = str(price['network']);
  return {
    payable: true,
    target: str(body['target']) ?? targetUrl,
    price: { amount, currency: str(price['currency']) ?? 'USD', asset, network },
    quote: { amount: total, fee, currency: str(quote['currency']) ?? 'USD' },
    link: str(body['link']) ?? routingLink(payUrl, targetUrl),
  };
}

export interface Unpaid {
  readonly url: string;
  readonly status: number;
  readonly x402Version: number | undefined;
  /** Empty unless the answer was a 402. */
  readonly offers: readonly Offer[];
  /** For an answer other than 402: what it said, in a few words. */
  readonly note: string | undefined;
}

/** Sends the call with no payment and reads the answer. Anything but a 402 is kept as it is. */
export async function readUnpaid(fetchFn: Fetch, url: string, call: ToolRequest): Promise<Unpaid> {
  const answer = await request(fetchFn, {
    method: call.method,
    url,
    ...(call.headers !== undefined && { headers: call.headers }),
    ...(call.body !== undefined && { body: call.body }),
    timeoutMs: READ_TIMEOUT_MS,
  });
  if (answer.status !== 402) {
    return {
      url,
      status: answer.status,
      x402Version: undefined,
      offers: [],
      note: answer.status >= 400 ? describeFailure(answer.status, answer.body) : `answered ${answer.status}`,
    };
  }
  const read = readOffers(answer);
  return { url, status: 402, x402Version: read.x402Version, offers: read.offers, note: undefined };
}
