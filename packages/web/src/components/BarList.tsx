import type { ReactNode } from 'react';

import { count, pct, usd } from '../format';

export type BarTone = 'default' | 'dim' | 'near';

export interface BarListItem {
  // What shows at the left: a name, or a `Rail`
  readonly label: ReactNode;
  readonly value: number;
  // `near` is the brand green, `dim` a lighter gray
  readonly tone?: BarTone;
}

/**
 * A labeled list of bars: the name, the value and its share of the total, and a bar as long as the value
 * is against the largest. `unit` picks how values read: `count` or `usd`. An empty list draws nothing.
 */
export const BarList = ({ items, unit = 'count' }: { readonly items: readonly BarListItem[]; readonly unit?: 'count' | 'usd' }) => {
  const max = Math.max(0, ...items.map(item => item.value));
  const total = items.reduce((sum, item) => sum + item.value, 0);
  const format = unit === 'usd' ? usd : count;

  return (
    <div className="barlist">
      {items.map((item, index) => (
        <div key={index} className="item">
          <div className="name">{item.label}</div>
          <div className="val">
            {format(item.value)}
            <span className="muted">{pct(total > 0 ? item.value / total : 0)}</span>
          </div>
          <div className="track">
            <svg aria-hidden="true">
              <rect className={item.tone && item.tone !== 'default' ? `fill ${item.tone}` : 'fill'} x="0" y="0" width={`${max > 0 ? (100 * item.value / max).toFixed(1) : '0'}%`} height="8" rx="4" />
            </svg>
          </div>
        </div>
      ))}
    </div>
  );
};
