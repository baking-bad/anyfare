// Small shared pieces: errors, amounts as bigint, and helpers for answers.

/** An expected failure. Printed as one line on stderr, exit code 1. */
export class Stop extends Error {
  readonly notCharged: boolean;

  constructor(message: string, options: { readonly notCharged?: boolean } = {}) {
    super(message);
    this.name = 'Stop';
    this.notCharged = options.notCharged ?? false;
  }

  /** The text for the one failure line. */
  line(): string {
    return this.notCharged ? `${this.message} Not charged.` : this.message;
  }
}

/** Bad usage. Exit code 2. */
export class UsageError extends Stop {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/** A non-2xx answer. */
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

/** The body as JSON, or as text when it is not JSON. */
export async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === '') return '';
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The JSON body of a 2xx answer, or an `HttpError`. */
export async function expectOk<T>(response: Response): Promise<T> {
  const body = await readBody(response);
  if (response.ok) return body as T;
  let code: string | undefined;
  let message = `The server answered ${response.status}`;
  if (isRecord(body) && isRecord(body['error'])) {
    const envelope = body['error'];
    if (typeof envelope['code'] === 'string') code = envelope['code'];
    if (typeof envelope['message'] === 'string') message = envelope['message'];
  }
  throw new HttpError(response.status, message, {
    ...(code !== undefined && { code }),
    ...(response.headers.get('x-request-id') !== null && {
      requestId: response.headers.get('x-request-id') as string,
    }),
    ...(response.headers.get('retry-after') !== null && {
      retryAfter: response.headers.get('retry-after') as string,
    }),
    body,
  });
}

/** The trimmed value of an environment variable, or a `Stop`. */
export function requireEnv(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  hint: string,
): string {
  const value = env[name]?.trim();
  if (value === undefined || value === '') {
    throw new Stop(`${name} is not set. Add it to .env.local. ${hint}`);
  }
  return value;
}

/** The first 10 characters of a secret, then an ellipsis. Never the whole secret. */
export function short(secret: string): string {
  return secret.length <= 10 ? '…' : `${secret.slice(0, 10)}…`;
}

const PLAIN_DECIMAL = /^[0-9]+(\.[0-9]+)?$/;

/** A plain decimal string as an integer count of the smallest unit. Exact for any size. */
export function toAtomic(amount: string, decimals: number): bigint {
  if (!PLAIN_DECIMAL.test(amount)) {
    throw new Stop(`Not a plain decimal amount: "${amount}"`);
  }
  const [whole = '0', fraction = ''] = amount.split('.');
  if (fraction.length > decimals) {
    throw new Stop(`Too many decimal places in "${amount}": at most ${decimals}`);
  }
  return BigInt(whole + fraction.padEnd(decimals, '0'));
}

/** An integer count of the smallest unit as the shortest exact decimal. */
export function fromAtomic(atomic: bigint | string, decimals: number): string {
  let value: bigint;
  try {
    value = typeof atomic === 'bigint' ? atomic : BigInt(atomic);
  } catch {
    throw new Stop(`Not a whole number: "${String(atomic)}"`);
  }
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, '');
  const text = fraction === '' ? whole : `${whole}.${fraction}`;
  return negative ? `-${text}` : text;
}

/** Micro-USD as a dollar amount, such as `$0.01`. */
export function usd(microUsd: bigint): string {
  return `$${fromAtomic(microUsd, 6)}`;
}
