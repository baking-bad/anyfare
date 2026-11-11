import type { ReactNode } from 'react';

/**
 * The shell of a table: the well, a title line, and a box that scrolls sideways on its own, so a wide table
 * never widens the page. Put `<thead>` and `<tbody>` inside; mark number columns `className="r"`. `label`
 * names the scrolling box for screen readers.
 */
export const DataTable = ({ label, title, aside, top, footer, children }: {
  readonly label: string;
  readonly title?: ReactNode;
  readonly aside?: ReactNode;
  // Above the scrolling box, under the title: a filter bar, or a notice
  readonly top?: ReactNode;
  readonly footer?: ReactNode;
  readonly children: ReactNode;
}) => (
  <div className="t-wrap">
    {title === undefined ? null : (
      <div className="well-title">
        <span>{title}</span>
        {aside === undefined ? null : <span className="xs muted">{aside}</span>}
      </div>
    )}
    {top}
    <div className="inner table-scroll" role="region" aria-label={label} tabIndex={0}>
      <table className="t">{children}</table>
    </div>
    {footer}
  </div>
);
