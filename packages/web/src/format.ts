// How numbers and times read on the site. The same helpers format on the server and in the browser.

/**
 * The one rule for a dollar amount, used by every page and every Markdown twin:
 * - zero reads "$0";
 * - from $1 up, two decimals with thousands separators, such as "$18.42" and "$2,140.50";
 * - under $1, the amount's own digits up to six decimals and at least two, with no trailing zero past the
 *   second decimal: "$0.50", "$0.25", "$0.033", "$0.002", "$0.0105". A non-zero amount is never rounded to
 *   zero and no non-zero digit within six decimals is hidden;
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
  const fixed = size.toFixed(6);
  if (Number(fixed) === 0)
    return `${sign}<$0.000001`;
  const trimmed = fixed.replace(/0+$/, '');
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

/** How long ago a moment was: `now`, `12s ago`, `5m ago`, `3h ago`. A moment in the future reads `now`. */
export const ago = (moment: Date | number, now: number = Date.now()): string => {
  const time = typeof moment === 'number' ? moment : moment.getTime();
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 5)
    return 'now';
  if (seconds < 60)
    return `${seconds}s ago`;
  if (seconds < 3600)
    return `${Math.floor(seconds / 60)}m ago`;

  return `${Math.floor(seconds / 3600)}h ago`;
};

/** A dollar amount from the API's decimal string, such as "0.01". A missing value, or one that isn't a number, reads as a dash. */
export const usdOf = (amount: string | null): string => {
  const value = Number(amount);

  return amount === null || amount.trim() === '' || !Number.isFinite(value) ? '-' : usd(value);
};
