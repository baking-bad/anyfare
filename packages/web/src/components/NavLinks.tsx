'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { isActive, navItems } from './nav';

/**
 * The main links. The one for the page being shown is marked with `aria-current="page"`. `base` is the site's
 * origin when the page is on another host: the links then lead to the site and none is marked.
 */
export const NavLinks = ({ onNavigate, base = '' }: { readonly onNavigate?: () => void; readonly base?: string }) => {
  const pathname = usePathname();

  return (
    <>
      {navItems.map(item => (
        <Link key={item.href} href={`${base}${item.href}`} aria-current={base === '' && isActive(pathname, item) ? 'page' : undefined} onClick={onNavigate}>{item.label}</Link>
      ))}
    </>
  );
};
