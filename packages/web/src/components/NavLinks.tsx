'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { isActive, navItems } from './nav';

/** The main links. The one for the page being shown is marked with `aria-current="page"`. */
export const NavLinks = ({ onNavigate }: { readonly onNavigate?: () => void }) => {
  const pathname = usePathname();

  return (
    <>
      {navItems.map(item => (
        <Link key={item.href} href={item.href} aria-current={isActive(pathname, item) ? 'page' : undefined} onClick={onNavigate}>{item.label}</Link>
      ))}
    </>
  );
};
