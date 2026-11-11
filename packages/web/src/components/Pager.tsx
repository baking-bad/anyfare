import Link from 'next/link';
import type { ReactNode } from 'react';

import { count } from '../format';
import { Icon } from './Icon';

// The page numbers to show: the first, the last, and the ones around the current page
export const pageNumbers = (page: number, pages: number): number[] =>
  [...new Set([1, page - 1, page, page + 1, pages].filter(n => n >= 1 && n <= pages))].sort((a, b) => a - b);

interface PageButtonProps {
  readonly page: number;
  readonly current?: boolean;
  readonly disabled?: boolean;
  readonly label?: string;
  readonly icon?: boolean;
  readonly back?: boolean;
  readonly onPage?: ((page: number) => void) | undefined;
  readonly hrefFor?: ((page: number) => string) | undefined;
  readonly children?: ReactNode;
}

const PageButton = ({ page, current = false, disabled = false, label, icon = false, back = false, onPage, hrefFor, children }: PageButtonProps) => {
  const classes = ['btn', 'sm', current ? 'primary' : 'ghost', icon ? 'icon' : 'num', disabled ? 'disabled' : ''].filter(Boolean).join(' ');
  const content = icon ? <span className={back ? 'flip' : ''}><Icon name="chev" /></span> : children;
  if (hrefFor && !disabled)
    return <Link className={classes} href={hrefFor(page)} aria-label={label} aria-current={current ? 'page' : undefined}>{content}</Link>;

  return <button type="button" className={classes} disabled={disabled} aria-label={label} aria-current={current ? 'page' : undefined} onClick={() => onPage?.(page)}>{content}</button>;
};

/**
 * The pager under a grid: "1–20 of 240", back, page numbers with gaps, next. Give `onPage` from a client
 * component, or `hrefFor` to make the buttons links.
 */
export const Pager = ({ page, size, total, capped = false, onPage, hrefFor }: {
  readonly page: number;
  readonly size: number;
  readonly total: number;
  // The total is a count that stopped at its cap: it reads "10,000+"
  readonly capped?: boolean;
  readonly onPage?: (page: number) => void;
  readonly hrefFor?: (page: number) => string;
}) => {
  const pages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(Math.max(1, page), pages);
  const from = total > 0 ? (current - 1) * size + 1 : 0;
  const to = Math.min(total, current * size);
  const numbers = pageNumbers(current, pages);

  return (
    <nav className="pager" aria-label="Pages">
      <span className="small muted num">{count(from)}–{count(to)} of {count(total)}{capped ? '+' : ''}</span>
      <div className="row pager-pages">
        <PageButton page={current - 1} disabled={current <= 1} label="Back" icon back onPage={onPage} hrefFor={hrefFor} />
        {numbers.map((n, i) => (
          <span key={n} className="pager-item">
            {i > 0 && n - (numbers[i - 1] ?? 0) > 1 ? <span className="small muted pager-gap">…</span> : null}
            <PageButton page={n} current={n === current} label={`Page ${n}`} onPage={onPage} hrefFor={hrefFor}>{count(n)}</PageButton>
          </span>
        ))}
        <PageButton page={current + 1} disabled={current >= pages} label="Next" icon onPage={onPage} hrefFor={hrefFor} />
      </div>
    </nav>
  );
};
