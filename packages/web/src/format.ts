// How numbers and times read on the site. The same helpers format on the server and in the browser.

/**
 * The one rule for a dollar amount, used by every page and every Markdown twin:
 * - zero reads "$0";
 * - from $1 up, two decimals with thousands separators, such as "$18.42" and "$2,140.50";
 * - under $1, at most 3 significant digits and at least two decimals, with no trailing zero past the second:
 *   "$0.652", "$0.11", "$0.50", "$0.00924", "$0.0105". A non-zero amount is never rounded to zero;
 * - a non-zero amount under a millionth of a dollar reads "<$0.000001".
 * A negative amount keeps its sign in front of the dollar sign.
 */
export const usd = (amount: number): string => {
  if (!Number.isFinite(amount))
    return '-';
  if (amount === 0)
    return '$0';
  const sign = amount < 0 ? '-' : '';
  const size = Math.abs(amount);
  if (size >= 1)
    return `${sign}$${size.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (size < 0.000001)
    return `${sign}<$0.000001`;
  const rounded = Number(size.toPrecision(3));
  if (rounded >= 1)
    return `${sign}$1.00`;
  const trimmed = rounded.toFixed(12).replace(/0+$/, '');
  const decimals = trimmed.split('.')[1] ?? '';

  return `${sign}$${decimals.length < 2 ? `${trimmed}${'0'.repeat(2 - decimals.length)}` : trimmed}`;
};

/** A whole number with thousands separators, such as 2,140. */
export const count = (value: number): string => value.toLocaleString('en-US');

/** A share from 0 to 1 as a percentage: whole from 10%, such as 36% and 99%, and one decimal under it, such as 4.2%. */
export const pct = (share: number): string => {
  const percent = share * 100;
  const tenths = Number(percent.toFixed(1));

  return `${tenths < 10 ? tenths.toFixed(1) : Math.round(percent)}%`;
};

/** A duration in milliseconds: `340 ms`, and from one second `1.8 s`. */
export const ms = (milliseconds: number): string => milliseconds >= 1000 ? `${(milliseconds / 1000).toFixed(1)} s` : `${milliseconds} ms`;

/**
 * How long ago a moment was: `now`, `12s ago`, `5m ago`, `3h ago` (up to 48 hours), `7 days ago` (up to 60
 * days), then the date, such as `Sep 12, 2026` in UTC. A moment in the future reads `now`. The one helper
 * for every page and twin.
 */
export const ago = (moment: Date | number, now: number = Date.now()): string => {
  const time = typeof moment === 'number' ? moment : moment.getTime();
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 5)
    return 'now';
  if (seconds < 60)
    return `${seconds}s ago`;
  if (seconds < 3600)
    return `${Math.floor(seconds / 60)}m ago`;

  const hours = Math.floor(seconds / 3600);
  if (hours <= 48)
    return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days <= 60)
    return `${days} days ago`;

  return new Date(time).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
};

/** A dollar amount from the API's decimal string, such as "0.01". A missing value, or one that isn't a number, reads as a dash. */
export const usdOf = (amount: string | null): string => {
  const value = Number(amount);

  return amount === null || amount.trim() === '' || !Number.isFinite(value) ? '-' : usd(value);
};
