// How numbers and times read on the site. The same helpers format on the server and in the browser.

/**
 * A dollar amount. Small amounts show three digits, such as $0.002, the rest two, such as $18.42.
 * `digits` overrides both.
 */
export const usd = (amount: number, digits?: number): string => {
  const places = digits ?? (amount < 0.1 && amount > 0 ? 3 : 2);

  return `$${amount.toLocaleString('en-US', { minimumFractionDigits: places, maximumFractionDigits: places })}`;
};

/** A whole number with thousands separators, such as 2,140. */
export const count = (value: number): string => value.toLocaleString('en-US');

/** A share from 0 to 1 as a percentage: 12.4%, and 100% without a decimal. */
export const pct = (share: number): string => `${(share * 100).toFixed(share === 1 ? 0 : 1)}%`;

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

/** A dollar amount from the API's decimal string, such as "0.01". A value that isn't a number reads as a dash. */
export const usdOf = (amount: string, digits?: number): string => {
  const value = Number(amount);

  return amount.trim() === '' || !Number.isFinite(value) ? '-' : usd(value, digits);
};
