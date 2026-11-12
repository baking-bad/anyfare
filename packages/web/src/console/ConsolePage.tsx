'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { Skeleton } from '../components/Skeleton';
import { Spinner } from '../components/Spinner';
import { useView } from '../components/view';
import { AgentPanel } from './AgentPanel';
import { PageTitle } from './components/PageTitle';
import { useConsolePlaces } from './context';
import { KeysPage } from './KeysPage';
import { Overview } from './Overview';
import { pageOf, type ConsolePageName } from './pages';
import { PaymentsPage } from './PaymentsPage';
import { useSession } from './session';
import { SettingsPage } from './SettingsPage';
import { SignIn } from './SignIn';
import { TopupPage } from './topup/TopupPage';

/** The console while it reads the session, on the server and while the page hydrates: no data, a spinner. */
export const Opening = () => (
  <main id="main" className="console-opening">
    <Spinner label="Opening the console" />
    <noscript><p className="small muted">The console needs JavaScript.</p></noscript>
  </main>
);

/** A page a later task builds: its title, and a loading shell. */
const PagePending = ({ name }: { readonly name: ConsolePageName }) => (
  <div className="stack-lg">
    <PageTitle title={pageOf(name).title} />
    <div className="stack" role="status" aria-label="Loading">
      <Skeleton shape="block" />
      <Skeleton shape="block" />
    </div>
  </div>
);

/**
 * A console page. Signed out, it is the sign-in view, on this page's own address; signed in, it is the page, or its
 * Agent view. `/signin` leads to the Overview once signed in. `amount` is a top-up link's amount, as a number, and
 * `amountUnused` says the link had an amount that was not used: the Top up page reads both.
 */
export const ConsolePage = ({ page, amount, amountUnused = false }: {
  readonly page: ConsolePageName;
  readonly amount?: number | undefined;
  readonly amountUnused?: boolean;
}) => {
  const session = useSession();
  const view = useView();
  const router = useRouter();
  const { overviewPath } = useConsolePlaces();
  const leave = session.status === 'signedIn' && page === 'signin';
  useEffect(() => {
    if (leave)
      router.replace(overviewPath);
  }, [leave, overviewPath, router]);

  if (session.status === 'unknown')
    return null;
  if (session.status === 'signedOut')
    return <SignIn amount={page === 'topup' ? amount : undefined} amountUnused={page === 'topup' && amountUnused} notice={session.notice} />;
  if (leave)
    return <div className="console-leaving"><Spinner label="Opening the Overview" /></div>;
  if (view === 'agent')
    return <AgentPanel page={page} amount={page === 'topup' ? amount : undefined} />;
  switch (page) {
    case 'overview':
      return <Overview />;
    case 'keys':
      return <KeysPage />;
    case 'payments':
      return <PaymentsPage />;
    case 'settings':
      return <SettingsPage />;
    case 'topup':
      return <TopupPage amount={amount} amountUnused={amountUnused} />;
    default:
      return <PagePending name={page} />;
  }
};
