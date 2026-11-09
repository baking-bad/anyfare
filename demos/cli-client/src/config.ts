import { Stop, toAtomic } from './util.ts';

export const DEFAULT_API_URL = 'https://api.anyfare.agents.bakingbad.dev';
export const DEFAULT_PAY_URL = 'https://pay.anyfare.agents.bakingbad.dev';
export const DEFAULT_MAX_PAYMENT_USD = '0.02';

export interface Config {
  readonly apiUrl: string;
  readonly payUrl: string;
  /** The most one call may cost, in micro-USD. */
  readonly maxPayment: bigint;
  /** The same cap as the string given, for display. */
  readonly maxPaymentText: string;
}

type Env = Readonly<Record<string, string | undefined>>;

function readUrl(env: Env, name: string, fallback: string): string {
  const raw = env[name]?.trim() || fallback;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Stop(`${name} is not a valid URL: "${raw}"`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Stop(`${name} must start with http:// or https://: "${raw}"`);
  }
  return raw.replace(/\/+$/, '');
}

function readCap(env: Env): { micro: bigint; text: string } {
  const text = env['MAX_PAYMENT_USD']?.trim() || DEFAULT_MAX_PAYMENT_USD;
  let micro: bigint;
  try {
    micro = toAtomic(text, 6);
  } catch (error) {
    const reason = error instanceof Stop ? error.message : 'Not an amount';
    throw new Stop(`MAX_PAYMENT_USD is not a valid amount in US dollars. ${reason}`);
  }
  if (micro === 0n) throw new Stop('MAX_PAYMENT_USD must be more than zero.');
  return { micro, text };
}

export function loadConfig(env: Env): Config {
  const cap = readCap(env);
  return {
    apiUrl: readUrl(env, 'ANYFARE_API_URL', DEFAULT_API_URL),
    payUrl: readUrl(env, 'ANYFARE_PAY_URL', DEFAULT_PAY_URL),
    maxPayment: cap.micro,
    maxPaymentText: cap.text,
  };
}
