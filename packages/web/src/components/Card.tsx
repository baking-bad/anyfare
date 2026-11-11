import Link from 'next/link';
import type { ReactNode } from 'react';

/**
 * A card: a 1 px outline, no shadow. `raised` stands out on the canvas, `flush` has no padding (for a table
 * or a list), `large` pads 24 px. With `href` the whole card is a link with a hover outline.
 */
export const Card = ({ raised = false, flush = false, large = false, href, className, children }: {
  readonly raised?: boolean;
  readonly flush?: boolean;
  readonly large?: boolean;
  readonly href?: string;
  readonly className?: string;
  readonly children: ReactNode;
}) => {
  const classes = ['card', raised ? 'raised' : '', flush ? 'flush' : '', large ? 'pad-lg' : '', className ?? ''].filter(Boolean).join(' ');

  return href === undefined ? <div className={classes}>{children}</div> : <Link className={classes} href={href}>{children}</Link>;
};

/** The top line of a card: a title, and room for a badge or a button at the end. */
export const CardHead = ({ title, children }: { readonly title: ReactNode; readonly children?: ReactNode }) => (
  <div className="card-head">
    <h3 className="card-title">{title}</h3>
    {children}
  </div>
);
