import Link from 'next/link';

/** The logo mark and the name, linking home. `href` is the site's home when the page is on another host. */
export const Logo = ({ href = '/' }: { readonly href?: string }) => (
  <Link className="logo" href={href}>
    <i aria-hidden="true" />
    anyfare
  </Link>
);
