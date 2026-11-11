import type { Metadata } from 'next';

// The console's pages: their names, where each lives on the console host, and the title a browser tab shows.

export type ConsolePageName = 'overview' | 'keys' | 'topup' | 'payments' | 'settings' | 'signin';

export interface ConsolePage {
  readonly name: ConsolePageName;
  readonly title: string;
  // The path on the console host. The Overview's is `/`, or `/console` when the two hosts are one.
  readonly path: string;
}

export const consolePages: readonly ConsolePage[] = [
  { name: 'overview', title: 'Overview', path: '/' },
  { name: 'keys', title: 'Keys', path: '/keys' },
  { name: 'topup', title: 'Top up', path: '/topup' },
  { name: 'payments', title: 'Payments', path: '/payments' },
  { name: 'settings', title: 'Settings', path: '/settings' },
  { name: 'signin', title: 'Sign in', path: '/signin' },
];

export const pageOf = (name: ConsolePageName): ConsolePage => consolePages.find(page => page.name === name)!;

/** The page a path of the console host shows. Any other path is the Overview, as only the proxy leads here. */
export const pageAtPath = (pathname: string): ConsolePage => consolePages.find(page => page.path === pathname && page.name !== 'overview') ?? pageOf('overview');

/** A page's path: the Overview's is `overviewPath`. */
export const pathOf = (name: ConsolePageName, overviewPath: string): string => name === 'overview' ? overviewPath : pageOf(name).path;

const description = 'The Anyfare console: the balance, payment keys, top-ups and payments of an account.';

/** A console page's metadata: its title, such as "Keys | Anyfare console", and no search engine keeps it. It names no share image. */
export const consoleMetadata = (name: ConsolePageName): Metadata => {
  const title = `${pageOf(name).title} | Anyfare console`;

  return {
    title: { absolute: title },
    description,
    robots: { index: false, follow: false },
    openGraph: { type: 'website', siteName: 'Anyfare', title, description },
    twitter: { card: 'summary', title, description },
  };
};
