'use client';

import Link from 'next/link';
import { useMemo, type ReactNode } from 'react';

import { Button } from '../components/Button';
import { DataTable } from '../components/DataTable';
import { EmptyState } from '../components/EmptyState';
import { ErrorState } from '../components/ErrorState';
import { Icon } from '../components/Icon';
import { useSettings } from '../components/Settings';
import { Skeleton } from '../components/Skeleton';
import { usd, usdOf } from '../format';
import { isTopupsOff, listKeys, listPayments, listTopups } from './api';
import { problemText, useConsoleData, useConsolePlaces, useRead } from './context';
import { isPositive } from './format';
import { isActive, keyName, spentToday } from './keys';
import { PaymentHead, PaymentRow } from './PaymentRow';
import { useSession } from './session';
import { TopupHead, TopupRow } from './topup/TopupRow';

const listLength = 5;

/** A state of a table's body (loading, empty or failed) as one row that spans the table. */
const StateRow = ({ columns, children }: { readonly columns: number; readonly children: ReactNode }) => (
  <tr><td colSpan={columns} className="state-cell"><div className="state-inner">{children}</div></td></tr>
);

const SkeletonRows = ({ columns }: { readonly columns: number }) => (
  <>{[0, 1, 2].map(row => <tr key={row}><td colSpan={columns}><Skeleton shape="block" /></td></tr>)}</>
);

/**
 * The Overview: the banner of a sign-up's free Credits (in this visit only), the balance with Top up and New key, what
 * the keys spent today, the last payments and the last top-ups. Each part reads on its own, and one that fails
 * leaves the others as they are.
 */
export const Overview = () => {
  const session = useSession();
  const { apiUrl } = useSettings();
  const { siteUrl } = useConsolePlaces();
  const { balance, readBalanceAgain } = useConsoleData();
  const [keys, keysAgain] = useRead(() => listKeys(apiUrl));
  const [payments, paymentsAgain] = useRead(() => listPayments(apiUrl, { limit: listLength }));
  const [topups, topupsAgain] = useRead(() => listTopups(apiUrl, listLength));
  const keyNames = useMemo(() => new Map(keys.state === 'ok' ? keys.value.map(item => [item.id, keyName(item)] as const) : []), [keys]);
  const now = Date.now();
  const freeCredits = session.status === 'signedIn' ? session.freeCredits : undefined;

  return (
    <div className="stack-lg">
      <h1 className="sr-only">Overview</h1>
      {freeCredits === undefined ? null : (
        <div className="free-banner">
          <Icon name="gift" />
          <span><b>{usdOf(freeCredits)} of free Credits</b> are on your account.</span>
          <Button variant="secondary" size="sm" href="/keys">Make a key</Button>
        </div>
      )}
      {balance.state === 'failed' ? (
        <ErrorState title="The balance didn't load" action={<Button variant="secondary" size="sm" onClick={readBalanceAgain}>Try again</Button>}>
          {problemText(balance.error)}
        </ErrorState>
      ) : (
        <div className="overview-balance">
          <div className="overview-amount">
            <span className="muted">Available</span>
            {balance.state === 'loading' ? (
              <span className="overview-pending" role="status" aria-label="Reading the balance"><Skeleton shape="title" width="md" /><Skeleton width="md" /></span>
            ) : (
              <>
                <span className="balance">{usdOf(balance.value.available)}</span>
                {isPositive(balance.value.held) ? <span className="small muted">{usdOf(balance.value.held)} held for calls in flight</span> : null}
              </>
            )}
          </div>
          <div className="row">
            <Button size="lg" href="/topup"><Icon name="wallet" />Top up</Button>
            <Button size="lg" variant="secondary" href="/keys"><Icon name="plus" />New key</Button>
          </div>
        </div>
      )}
      {keys.state === 'failed' ? (
        <ErrorState title="The keys didn't load" action={<Button variant="secondary" size="sm" onClick={keysAgain}>Try again</Button>}>{problemText(keys.error)}</ErrorState>
      ) : (
        <div className="stat-cards pair">
          <div className="card">
            {keys.state === 'loading' ? <span className="overview-pending" role="status" aria-label="Reading the keys"><Skeleton shape="title" width="sm" /></span> : <span className="v">{usd(spentToday(keys.value))}</span>}
            <span className="l">Spent today, UTC</span>
          </div>
          <div className="card">
            {keys.state === 'loading' ? <span className="overview-pending" aria-hidden="true"><Skeleton shape="title" width="sm" /></span> : <span className="v">{keys.value.filter(item => isActive(item, now)).length}</span>}
            <span className="l">Active keys</span>
          </div>
        </div>
      )}
      <DataTable
        label="Recent payments"
        title="Recent payments"
        aside={<Link className="link" href="/payments">All payments</Link>}
      >
        <PaymentHead />
        <tbody aria-busy={payments.state === 'loading'}>
          {payments.state === 'loading' ? <SkeletonRows columns={5} /> : payments.state === 'failed' ? (
            <StateRow columns={5}>
              <ErrorState title="The payments didn't load" action={<Button variant="secondary" size="sm" onClick={paymentsAgain}>Try again</Button>}>{problemText(payments.error)}</ErrorState>
            </StateRow>
          ) : payments.value.payments.length === 0 ? (
            <StateRow columns={5}>
              <EmptyState small icon="receipt" title="No payments yet">Make a key and call a paid API through Anyfare.</EmptyState>
            </StateRow>
          ) : payments.value.payments.map(payment => <PaymentRow key={payment.id} payment={payment} keyNames={keyNames} siteUrl={siteUrl} />)}
        </tbody>
      </DataTable>
      <DataTable
        label="Latest top-ups"
        title="Latest top-ups"
        aside={<Link className="link" href="/topup">All top-ups</Link>}
      >
        <TopupHead />
        <tbody aria-busy={topups.state === 'loading'}>
          {topups.state === 'loading' ? <SkeletonRows columns={4} /> : topups.state === 'failed' ? (
            <StateRow columns={4}>
              {isTopupsOff(topups.error)
                ? <EmptyState small icon="wallet" title="Top-ups are off right now." />
                : <ErrorState title="The top-ups didn't load" action={<Button variant="secondary" size="sm" onClick={topupsAgain}>Try again</Button>}>{problemText(topups.error)}</ErrorState>}
            </StateRow>
          ) : topups.value.topups.length === 0 ? (
            <StateRow columns={4}>
              <EmptyState small icon="wallet" title="No top-ups yet">Top up to add Credits to your account.</EmptyState>
            </StateRow>
          ) : topups.value.topups.map(topup => <TopupRow key={topup.id} topup={topup} />)}
        </tbody>
      </DataTable>
    </div>
  );
};
