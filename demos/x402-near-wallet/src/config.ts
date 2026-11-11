// The app's settings from the environment: the cap on one call, and where the Anyfare link points.

import { Stop, fromAtomic, toAtomic } from './util.ts';

export const DEFAULT_PAY_URL = 'https://pay.anyfare.agents.bakingbad.dev';
export const DEFAULT_MAX_PAYMENT_USD = '0.02';

export interface Config {
  /** Where the "through Anyfare" link points, with no trailing slash. */
  readonly payUrl: string;
  /** The most one call may cost, in micro-USD. */
  readonly maxPayment: bigint;
  /** The cap in dollars, the shortest text: "$0.02", "$0.5", "$1". */
  readonly maxPaymentText: string;
  /** What set the cap. */
  readonly capFrom: 'MAX_PAYMENT_USD' | '--max';
}

type Env = Readonly<Record<string, string | undefined>>;

const PLAIN_AMOUNT = /^[0-9]+(\.[0-9]{1,6})?$/;

function readPayUrl(env: Env): string {
  const name = 'ANYFARE_PAY_URL';
  const raw = env[name]?.trim() || DEFAULT_PAY_URL;
  let url: URL | undefined;
  try {
    url = new URL(raw);
  } catch {
    url = undefined;
  }
  const local = url?.hostname === 'localhost' || url?.hostname === '127.0.0.1';
  if (url === undefined || !(url.protocol === 'https:' || (url.protocol === 'http:' && local))) {
    throw new Stop(`${name} must be an https:// URL, or http:// to localhost or 127.0.0.1.`);
  }
  if (url.username !== '' || url.password !== '') throw new Stop(`${name} can't carry a user name or password.`);
  // The link is built as <pay URL>/<host><path>, so the pay URL has no path, query or fragment
  if (url.pathname.replace(/\/+$/, '') !== '' || raw.includes('?') || raw.includes('#')) {
    throw new Stop(`${name} must be an address with no path, query or fragment, such as ${DEFAULT_PAY_URL}.`);
  }
  return `${url.protocol}//${url.host}`;
}

function readCap(env: Env, maxUsd: string | undefined): { micro: bigint; from: Config['capFrom'] } {
  const from = maxUsd === undefined ? 'MAX_PAYMENT_USD' : '--max';
  const text = maxUsd ?? (env['MAX_PAYMENT_USD']?.trim() || DEFAULT_MAX_PAYMENT_USD);
  const bad = new Stop(`${from} needs a plain amount in dollars above zero, with at most 6 decimals, such as 0.05.`);
  if (!PLAIN_AMOUNT.test(text)) throw bad;
  const micro = toAtomic(text, 6);
  if (micro === 0n) throw bad;
  return { micro, from };
}

/** The settings. `--max` wins over `MAX_PAYMENT_USD` for this run. A bad value is a `Stop` that names it. */
export function loadConfig(env: Env, overrides: { readonly maxUsd?: string } = {}): Config {
  const cap = readCap(env, overrides.maxUsd);
  return {
    payUrl: readPayUrl(env),
    maxPayment: cap.micro,
    maxPaymentText: `$${fromAtomic(cap.micro, 6)}`,
    capFrom: cap.from,
  };
}
