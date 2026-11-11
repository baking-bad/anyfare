import type { ReactNode } from 'react';

import { Icon, type IconName } from './Icon';

/** Nothing to show yet: an icon circle, a title, one line, and at most one button (pass a `Button` as `action`). */
export const EmptyState = ({ icon = 'list', title, children, action, small = false }: {
  readonly icon?: IconName;
  // Less padding, for a state inside a card that sits among other content
  readonly small?: boolean;
  readonly title: string;
  readonly children?: ReactNode;
  readonly action?: ReactNode;
}) => (
  <div className={small ? 'empty sm' : 'empty'}>
    <span className="icon-circle"><Icon name={icon} /></span>
    <h3 className="row-title">{title}</h3>
    {children === undefined ? null : <p className="small muted">{children}</p>}
    {action}
  </div>
);
