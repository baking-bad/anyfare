// The app's settings from the environment: the cap on one call, where the Anyfare link points, and
// where a call paid through Anyfare is found and shown.

import { Stop, fromAtomic, toAtomic } from './util.ts';

export const DEFAULT_PAY_URL = 'https://pay.anyfare.agents.bakingbad.dev';
export const DEFAULT_MAX_PAYMENT_USD = '0.02';

export interface Config {
  /** Where the "through Anyfare" link points, with no trailing slash. */
  readonly payUrl: string;
  /** Anyfare's API, where a call paid through Anyfare is looked up. None: no lookup. */
  readonly apiUrl: string | undefined;
  /** Anyfare's site, where a call's receipt page is. None: no lookup. */
  readonly siteUrl: string | undefined;
  /** The most one call may cost, in micro-USD. */
  readonly maxPayment: bigint;
  /** The cap in dollars, the shortest text: "$0.02", "$0.5", "$1". */
  readonly maxPaymentText: string;
  /** What set the cap. */
  readonly capFrom: 'MAX_PAYMENT_USD' | '--max';
}

type Env = Readonly<Record<string, string | undefined>>;

const PLAIN_AMOUNT = /^[0-9]+(\.[0-9]{1,6})?$/;

/**
 * An address from `name`, or `fallback` when it is not set: https, or plain http to this machine, with
 * no user, password, path, query or fragment. Returned as its origin, with no trailing slash.
 */
function readOrigin(env: Env, name: string, fallback: string, example: string): string {
  const raw = env[name]?.trim() || fallback;
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
  // Links are built on it, such as <pay URL>/<host><path>, so it has no path, query or fragment
  if (url.pathname.replace(/\/+$/, '') !== '' || raw.includes('?') || raw.includes('#')) {
    throw new Stop(`${name} must be an address with no path, query or fragment, such as ${example}.`);
  }
  return `${url.protocol}//${url.host}`;
}

/**
 * The pay URL with its host changed by `rename`, when its host starts with `pay.`: Anyfare's API and
 * site sit next to its pay host. `undefined` for any other host.
 */
function besidePayHost(payUrl: string, rename: (rest: string) => string): string | undefined {
  const url = URL.parse(payUrl);
  if (url === null || !url.hostname.startsWith('pay.') || url.hostname.length <= 'pay.'.length) return undefined;
  const host = rename(url.hostname.slice('pay.'.length));
  return `${url.protocol}//${host}${url.port === '' ? '' : `:${url.port}`}`;
}

/** `ANYFARE_API_URL` or `ANYFARE_SITE_URL` when it is set, else the one beside the pay host, else none. */
function readBeside(env: Env, name: string, derived: string | undefined, example: string): string | undefined {
  if ((env[name]?.trim() ?? '') === '') return derived;
  return readOrigin(env, name, '', example);
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
  const payUrl = readOrigin(env, 'ANYFARE_PAY_URL', DEFAULT_PAY_URL, DEFAULT_PAY_URL);
  return {
    payUrl,
    apiUrl: readBeside(env, 'ANYFARE_API_URL', besidePayHost(payUrl, (rest) => `api.${rest}`), 'https://api.anyfare.agents.bakingbad.dev'),
    siteUrl: readBeside(env, 'ANYFARE_SITE_URL', besidePayHost(payUrl, (rest) => rest), 'https://anyfare.agents.bakingbad.dev'),
    maxPayment: cap.micro,
    maxPaymentText: `$${fromAtomic(cap.micro, 6)}`,
    capFrom: cap.from,
  };
}
