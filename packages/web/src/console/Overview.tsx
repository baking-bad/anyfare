'use client';

import { Button } from '../components/Button';
import { ErrorState } from '../components/ErrorState';
import { Icon } from '../components/Icon';
import { Skeleton } from '../components/Skeleton';
import { usdOf } from '../format';
import { problemText, useConsoleData } from './context';
import { isPositive } from './format';
import { useSession } from './session';

/**
 * The Overview: the banner of a sign-up's free Credits (in this visit only), and the balance with Top up and New key.
 * The places below are marked for the parts a later task fills.
 */
export const Overview = () => {
  const session = useSession();
  const { balance, readBalanceAgain } = useConsoleData();
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
      {/* Spent today: a later task puts the day's spend here */}
      {/* Recent payments: a later task puts the last payments here */}
      {/* Latest top-ups: a later task puts the last top-ups here */}
    </div>
  );
};
