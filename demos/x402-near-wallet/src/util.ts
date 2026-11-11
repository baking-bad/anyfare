// Small shared pieces: errors, amounts as bigint, and helpers for answers.

/** An expected failure. Printed as one line on stderr, exit code 1. */
export class Stop extends Error {
  readonly notCharged: boolean;

  constructor(message: string, options: { readonly notCharged?: boolean; readonly cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'Stop';
    this.notCharged = options.notCharged ?? false;
  }

  /** The text for the one failure line. */
  line(): string {
    return this.notCharged ? `${this.message} Not charged.` : this.message;
  }
}

/** The API cannot be paid by this app. Nothing was paid. Exit code 3. */
export class NotSupported extends Stop {
  /** Lines printed on stdout after the failure line, such as the same request through Anyfare. */
  readonly hint: readonly string[];

  constructor(message: string, hint: readonly string[] = []) {
    super(message);
    this.name = 'NotSupported';
    this.hint = hint;
  }
}

/** Bad usage. Exit code 2. */
export class UsageError extends Stop {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
