import type { ReactNode } from 'react';

import { Icon, type IconName } from './Icon';

export type BadgeTone = 'neutral' | 'brand' | 'success' | 'info' | 'warning' | 'danger';

/** A 24 px badge in a status color. `large` makes it 28 px. */
export const Badge = ({ tone = 'neutral', large = false, icon, children }: {
  readonly tone?: BadgeTone;
  readonly large?: boolean;
  readonly icon?: IconName;
  readonly children: ReactNode;
}) => (
  <span className={['badge', tone === 'neutral' ? '' : tone, large ? 'lg' : ''].filter(Boolean).join(' ')}>
    {icon ? <Icon name={icon} /> : null}
    {children}
  </span>
);
