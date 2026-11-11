import { pct } from '../format';

/**
 * How much `now` is above or below `before`, as a share (0.124 is +12.4%). Both are USD decimal strings.
 * `null` when there is nothing to compare: the earlier figure is zero or not a number.
 */
export const changeOf = (now: string, before: string): number | null => {
  const current = Number(now);
  const earlier = Number(before);
  if (!Number.isFinite(current) || !Number.isFinite(earlier) || earlier <= 0)
    return null;

  return (current - earlier) / earlier;
};

/** A change as the pill reads it: `+12.4%`, `-3.1%`, `0.0%`. */
export const formatChange = (change: number): string => `${change > 0 ? '+' : change < 0 ? '-' : ''}${pct(Math.abs(change))}`;
