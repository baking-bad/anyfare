export interface NavItem {
  readonly href: string;
  readonly label: string;
  // Other paths the item stays marked on, besides its own and the ones under it
  readonly alsoOn?: readonly string[];
}

export const navItems: readonly NavItem[] = [
  { href: '/', label: 'Check a link', alsoOn: ['/check'] },
  { href: '/services', label: 'Services' },
  { href: '/calls', label: 'Calls' },
  { href: '/agents', label: 'For agents' },
];

const under = (pathname: string, path: string): boolean => pathname === path || pathname.startsWith(`${path}/`);

/** Whether the nav item is the page being shown. "Check a link" is the home page only, and the check page. */
export const isActive = (pathname: string, item: NavItem): boolean =>
  item.href === '/' ? pathname === '/' || (item.alsoOn ?? []).some(path => under(pathname, path)) : under(pathname, item.href);
