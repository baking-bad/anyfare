import Link from 'next/link';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

import { Spinner } from './Spinner';

export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger' | 'danger-soft' | 'success-soft' | 'warning' | 'on-brand';
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

export interface ButtonStyle {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  // A square button with only an icon: it needs an `aria-label`
  readonly iconOnly?: boolean;
  // The label hides and a spinner shows; the button keeps its size
  readonly loading?: boolean;
  readonly className?: string;
}

/** The classes of a button, for a link or any element that should look like one. */
export const buttonClass = ({ variant = 'primary', size = 'md', iconOnly = false, loading = false, className }: ButtonStyle = {}): string =>
  ['btn', variant, size === 'md' ? '' : size, iconOnly ? 'icon' : '', loading ? 'loading' : '', className ?? ''].filter(Boolean).join(' ');

export type ButtonProps = ButtonStyle & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> & {
  // With `href` the button is a link: an internal path goes through the router, anything else is a plain link
  readonly href?: string;
  readonly children?: ReactNode;
};

const isExternal = (href: string): boolean => /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href);

/**
 * A button, or a link that looks like one when it has an `href`. Variants and sizes are those of the
 * design: primary, secondary, outline, ghost, danger, danger-soft, success-soft, warning; xs to xl.
 */
export const Button = ({ variant, size, iconOnly, loading, className, href, children, disabled, type = 'button', ...rest }: ButtonProps) => {
  const classes = buttonClass({ ...variant ? { variant } : {}, ...size ? { size } : {}, ...iconOnly ? { iconOnly } : {}, ...loading ? { loading } : {}, ...className ? { className } : {} });
  if (href !== undefined) {
    return isExternal(href)
      ? <a className={classes} href={href}>{children}</a>
      : <Link className={classes} href={href}>{children}</Link>;
  }

  return (
    <button {...rest} type={type} className={classes} disabled={disabled || loading} aria-busy={loading || undefined}>
      {loading ? <Spinner /> : null}
      {loading ? <span className="btn-label">{children}</span> : children}
    </button>
  );
};
