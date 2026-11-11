import { usdOf } from '../format';

// How the console prints money and times. Money is the site's one rule (src/format.ts); times are UTC.

const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A dollar amount in two parts, the whole dollars and the cents, so the cents can be quieter: "$19" and ".43". */
export const moneyParts = (amount: string): { readonly whole: string; readonly cents: string } => {
  const text = usdOf(amount);
  const dot = text.indexOf('.');

  return dot === -1 ? { whole: text, cents: '' } : { whole: text.slice(0, dot), cents: text.slice(dot) };
};

/** Whether an API amount is above zero. */
export const isPositive = (amount: string): boolean => Number(amount) > 0;

/** A moment as its date and time in UTC: "11 Nov 2026, 09:12 UTC". A value that isn't a time reads as a dash. */
export const utcDateTime = (iso: string): string => {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime()))
    return '-';
  const two = (value: number): string => String(value).padStart(2, '0');

  return `${at.getUTCDate()} ${months[at.getUTCMonth()]} ${at.getUTCFullYear()}, ${two(at.getUTCHours())}:${two(at.getUTCMinutes())} UTC`;
};

/** A moment as "11 Nov, 09:12", in UTC. A value that isn't a time reads as a dash. */
export const shortUtc = (iso: string): string => {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime()))
    return '-';
  const two = (value: number): string => String(value).padStart(2, '0');

  return `${at.getUTCDate()} ${months[at.getUTCMonth()]}, ${two(at.getUTCHours())}:${two(at.getUTCMinutes())}`;
};

/** A moment's day as "11 Nov 2026", in UTC. A value that isn't a time reads as a dash. */
export const utcDate = (iso: string): string => {
  const at = new Date(iso);

  return Number.isNaN(at.getTime()) ? '-' : `${at.getUTCDate()} ${months[at.getUTCMonth()]} ${at.getUTCFullYear()}`;
};
