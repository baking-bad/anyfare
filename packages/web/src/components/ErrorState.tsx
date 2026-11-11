import type { ReactNode } from 'react';

import { Icon } from './Icon';

/** Something failed to load: a red alert with a title and one line. Pass a retry `Button` as `action`. */
export const ErrorState = ({ title = 'This didn\'t load', children, action }: {
  readonly title?: string;
  readonly children?: ReactNode;
  readonly action?: ReactNode;
}) => (
  <div className="alert danger" role="alert">
    <Icon name="alert" />
    <div className="stack">
      <span className="t">{title}</span>
      {children === undefined ? null : <span>{children}</span>}
      {action === undefined ? null : <div className="mt-8">{action}</div>}
    </div>
  </div>
);
