'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useRef, useState, useSyncExternalStore, type ReactNode } from 'react';

import { Button } from '../components/Button';
import { Icon, type IconName } from '../components/Icon';
import { Skeleton } from '../components/Skeleton';
import { ThemeMenu } from '../components/ThemeMenu';
import { ViewSwitch } from '../components/ViewSwitch';
import { usdOf } from '../format';
import { AccountMenu } from './AccountMenu';
import { useFocusTrap } from './components/focus';
import { SiteLogo } from './components/SiteLogo';
import { RailIcon } from '../components/Rail';
import { Spinner } from '../components/Spinner';
import { topupOnItsWay, useConsoleData, useConsolePlaces } from './context';
import { topupBadge } from './topup/status';
import { isPositive, moneyParts } from './format';
import { pageAtPath, pageOf, pathOf, type ConsolePageName } from './pages';
import type { MaskedKey } from './session';

const ownItems: readonly { readonly name: ConsolePageName; readonly icon: IconName }[] = [
  { name: 'overview', icon: 'home' },
  { name: 'keys', icon: 'key' },
  { name: 'topup', icon: 'wallet' },
  { name: 'payments', icon: 'receipt' },
  { name: 'settings', icon: 'settings' },
];

const publicItems: readonly { readonly label: string; readonly path: string; readonly icon: IconName }[] = [
  { label: 'Check a link', path: '/', icon: 'link' },
  { label: 'Services', path: '/services', icon: 'list' },
  { label: 'Calls', path: '/calls', icon: 'activity' },
];

// Below this width the sidebar is a drawer behind the menu button
const narrowQuery = '(max-width: 1279px)';

const subscribeNarrow = (notify: () => void): (() => void) => {
  const query = matchMedia(narrowQuery);
  query.addEventListener('change', notify);

  return () => query.removeEventListener('change', notify);
};

const useNarrow = (): boolean => useSyncExternalStore(subscribeNarrow, () => matchMedia(narrowQuery).matches, () => false);

/** The top-up on its way, under the balance: the token, the amount and its status, and a spinner, as a link to Top up. Nothing when there is none, or the read failed. */
const OnItsWay = () => {
  const { topups } = useConsoleData();
  const topup = topupOnItsWay(topups);
  if (topup === undefined)
    return null;

  return (
    <Link className="bal-pending" href="/topup">
      <RailIcon rail={topup.network} token={topup.token} />
      <span className="bal-pending-text">{topup.amount} {topup.token}, {topupBadge(topup.status).label.toLowerCase()}</span>
      <Spinner />
    </Link>
  );
};

/** The balance at the foot of the sidebar: what is available, what is held for calls in flight, a top-up on its way, and Top up. */
const BalanceCard = () => {
  const { balance, readBalanceAgain } = useConsoleData();

  return (
    <div className="bal-card">
      <div className="bal-head">
        <span className="bal-label">Balance</span>
        <Link className="xs" href="/payments">Payments<Icon name="chev" /></Link>
      </div>
      {balance.state === 'loading' ? (
        <div className="bal-amount" role="status" aria-label="Reading the balance"><Skeleton shape="title" width="sm" /><Skeleton width="md" /></div>
      ) : balance.state === 'failed' ? (
        <div className="bal-problem" role="alert">
          <span>The balance didn&apos;t load.</span>
          <button type="button" className="btn xs bal-again" onClick={readBalanceAgain}>Try again</button>
        </div>
      ) : (
        <div className="bal-amount">
          <b>{moneyParts(balance.value.available).whole}<span>{moneyParts(balance.value.available).cents}</span></b>
          {isPositive(balance.value.held) ? <small>{usdOf(balance.value.held)} held for calls in flight</small> : null}
        </div>
      )}
      <OnItsWay />
      <Button size="sm" href="/topup" className="bal-topup"><Icon name="plus" />Top up</Button>
    </div>
  );
};

/**
 * The console's frame around a page, while signed in: the dark sidebar (the console's pages, the public site's, and
 * the balance), and the content area with its top bar (the page's name, the Human / Agent switch, the theme menu and
 * the account menu). Below 1280 px the sidebar is a drawer: it closes on Escape, on a click outside and on a move to
 * another page, and the focus stays inside it while it is open.
 */
export const Frame = ({ masked, children }: { readonly masked: MaskedKey; readonly children: ReactNode }) => {
  const { siteUrl, overviewPath } = useConsolePlaces();
  const pathname = usePathname();
  const current = pathname === overviewPath ? pageOf('overview') : pageAtPath(pathname);
  const narrow = useNarrow();
  const [open, setOpen] = useState(false);
  const drawer = useRef<HTMLElement>(null);
  useFocusTrap(drawer, open && narrow, () => setOpen(false));

  // A move to another page closes the drawer, and so does a window that grows past the drawer's width
  const [seen, setSeen] = useState(pathname);
  if (seen !== pathname) {
    setSeen(pathname);
    setOpen(false);
  }
  if (open && !narrow)
    setOpen(false);

  return (
    <div className="console-frame">
      <aside ref={drawer} id="console-nav" className={open ? 'sidebar open' : 'sidebar'} aria-label="Console" tabIndex={-1}>
        <SiteLogo siteUrl={siteUrl} />
        <nav className="side-nav" aria-label="Console">
          {ownItems.map(item => (
            <Link key={item.name} className="nav-item" href={pathOf(item.name, overviewPath)} aria-current={current.name === item.name ? 'page' : undefined}>
              <Icon name={item.icon} />
              {pageOf(item.name).title}
            </Link>
          ))}
          <p className="grp">Public</p>
          {publicItems.map(item => (
            <a key={item.path} className="nav-item" href={`${siteUrl}${item.path}`}>
              <Icon name={item.icon} />
              {item.label}
            </a>
          ))}
        </nav>
        <div className="side-foot">
          <div className="side-view only-sm"><ViewSwitch /></div>
          <BalanceCard />
        </div>
      </aside>
      {open ? <div className="drawer-backdrop" aria-hidden="true" onClick={() => setOpen(false)} /> : null}
      <div className="content">
        <header className="console-top">
          <div className="row console-top-start">
            <button
              type="button"
              className="btn ghost icon sm menu-toggle"
              aria-label={open ? 'Close the menu' : 'Open the menu'}
              aria-expanded={open}
              aria-controls="console-nav"
              onClick={() => setOpen(!open)}
            >
              <Icon name={open ? 'x' : 'menu'} />
            </button>
            <span className="semi">{current.title}</span>
          </div>
          <div className="header-end">
            <ViewSwitch className="hide-sm" />
            <ThemeMenu />
            <AccountMenu masked={masked} />
          </div>
        </header>
        <main id="main" className="content-inner">{children}</main>
      </div>
    </div>
  );
};
