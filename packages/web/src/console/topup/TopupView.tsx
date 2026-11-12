'use client';

import { useEffect, useState, type ReactNode, type Ref } from 'react';

import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { CopyButton } from '../../components/CopyButton';
import { Icon } from '../../components/Icon';
import { contactEmail } from '../../components/SiteFooter';
import { Skeleton } from '../../components/Skeleton';
import { Spinner } from '../../components/Spinner';
import { usdOf } from '../../format';
import type { Topup } from '../api';
import { useConsoleData } from '../context';
import { utcDateTime } from '../format';
import { DepositAddress } from './DepositAddress';
import { networkName, topupBadge } from './status';
import { topupTransactionLink } from './TopupRow';
import { counts, countdownText, saysTheSame, stepMarks, stepTitles, timeLeft, utcClock, viewOf, type StepMark, type TopupViewKind } from './view';
import { explorerName } from '../../receipt/content';

/**
 * The top-up on screen: the API's last answer for it, when that came, and when a read after it failed. `confirmed`
 * says the answer is the top-up's own (`GET /v1/topups/:id`, or the `POST` that made it): one taken from a list is a
 * snapshot that may be old, and its address waits for that read.
 */
export interface ShownTopup {
  readonly topup: Topup;
  readonly readAt: number;
  readonly confirmed: boolean;
  readonly failedAt?: number;
}

/** The time now, again every second while `ticking`. */
const useNow = (ticking: boolean): number => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking)
      return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);

    return () => clearInterval(timer);
  }, [ticking]);

  return now;
};

const timeUpLine = 'The time to pay ran out. Don\'t send to this address.';

// The page's own line for a view, which the API's message is not repeated next to
const lines: Partial<Record<TopupViewKind, string>> = {
  quoting: 'Getting a deposit address',
  processing: 'Received. Converting.',
  refunded: 'Not added.',
  expired: timeUpLine,
  timeUp: timeUpLine,
  failed: 'Stopped. We are looking into it.',
  noAddress: 'No deposit address was made. Nothing to send.',
};

const markText: Readonly<Record<StepMark, string>> = { done: 'Done', now: 'Under way', stopped: 'Stopped here', next: 'To come' };

const Steps = ({ kind, topup }: { readonly kind: TopupViewKind; readonly topup: Topup }) => {
  const marks = stepMarks(kind, topup.deposited);

  return (
    <ol className="steps topup-steps" aria-label="Steps">
      {stepTitles.map((title, index) => {
        const mark = marks[index]!;

        return (
          <li key={title} className={`step ${mark}`}>
            <span className="n" aria-hidden="true">{mark === 'done' ? <Icon name="check" /> : mark === 'stopped' ? <Icon name="x" /> : index + 1}</span>
            <div>
              <div className="t">{title}<span className="sr-only">: {markText[mark]}</span></div>
              {index === 1 && kind === 'incomplete' && topup.deposited !== null && topup.sendAtLeast !== null
                ? <p className="small muted">{topup.deposited} of {topup.sendAtLeast} {topup.token}</p>
                : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
};

const Warn = ({ tone = 'warning', children }: { readonly tone?: 'warning' | 'danger'; readonly children: ReactNode }) => (
  <div className={`alert ${tone}`} role={tone === 'danger' ? 'alert' : undefined}>
    <Icon name="alert" />
    <div className="stack"><span>{children}</span></div>
  </div>
);

/** Where the address goes while the top-up's own answer is read: a skeleton, or, when that read failed, no address. */
const AddressPending = ({ failed }: { readonly failed: boolean }) => failed
  ? <p className="small muted topup-held">The address shows once this top-up can be read again.</p>
  : (
    <div className="stack topup-held" role="status" aria-label="Reading the top-up">
      <p className="small muted">Reading the top-up…</p>
      <Skeleton shape="block" />
    </div>
  );

/** What a view needs from the person, under its badge. The address shows only from the top-up's own answer. */
const StateBlock = ({ kind, topup, confirmed, failed }: { readonly kind: TopupViewKind; readonly topup: Topup; readonly confirmed: boolean; readonly failed: boolean }) => {
  const { balance } = useConsoleData();
  const network = networkName(topup.network);
  switch (kind) {
    case 'quoting':
      return <p className="row topup-quoting"><Spinner />{lines.quoting}</p>;
    case 'waiting':
    case 'incomplete':
      return (
        <div className="stack-lg">
          {kind === 'incomplete' ? (
            <p>We got {topup.deposited ?? '-'} {topup.token}. We need at least {topup.sendAtLeast ?? '-'} {topup.token}. Send the rest before the time runs out.</p>
          ) : topup.sendAtLeast === null ? null : (
            <p className="semi">Send at least {topup.sendAtLeast} {topup.token}</p>
          )}
          {!confirmed ? <AddressPending failed={failed} /> : topup.depositAddress === null ? null : <DepositAddress address={topup.depositAddress} memo={topup.depositMemo} token={topup.token} network={topup.network} />}
          <Warn>Send only {topup.token} on {network}. Money sent after the time runs out may be lost.</Warn>
        </div>
      );
    case 'timeUp':
    case 'expired':
      return <Warn tone="danger">{timeUpLine}</Warn>;
    case 'processing':
      return <p className="row topup-quoting"><Spinner />{lines.processing}</p>;
    case 'credited': {
      const link = topupTransactionLink(topup);

      return (
        <div className="stack">
          <p className="topup-added">Added {topup.credited ?? '-'} Credits</p>
          {link === undefined ? null : <p><a className="link" href={link} target="_blank" rel="noopener noreferrer">The transaction on {explorerName(link)}</a></p>}
          {balance.state === 'ok' ? <p className="small muted">Your balance is {usdOf(balance.value.available)}.</p> : null}
        </div>
      );
    }
    case 'refunded':
      return (
        <div className="stack">
          <p className="semi">{lines.refunded}</p>
          <p>We hold {topup.refunded ?? '-'} {topup.token} for you and will return it. <a className="link" href={`mailto:${contactEmail}`}>Contact us</a> with the top-up id.</p>
          {topup.refundReason === null ? null : <p className="small muted">{topup.refundReason}</p>}
        </div>
      );
    case 'failed':
      return <p>{lines.failed} The top-up id is <code className="topup-code">{topup.id}</code>.</p>;
    case 'noAddress':
      return <p>{lines.noAddress}</p>;
    default:
      return null;
  }
};

/**
 * One top-up, by its status: the left card (the badge and the API's message, the countdown while it waits for the
 * transfer, what the state needs, the four steps, and "New top-up"), and the card "This top-up". Everything it shows
 * is the API's answer for this top-up, as it came. When the time to pay runs out by the page's clock, the address goes
 * at once. When a read after the last answer failed, it says so, with the time of that answer.
 */
export const TopupView = ({ shown, onNew, focusRef }: { readonly shown: ShownTopup; readonly onNew: () => void; readonly focusRef?: Ref<HTMLElement> }) => {
  const { topup, readAt, failedAt, confirmed } = shown;
  const ticking = counts(topup.status);
  const now = useNow(ticking);
  const kind = viewOf(topup, now);
  const badge = topupBadge(topup.status);
  const line = lines[kind];
  const message = topup.message !== null && kind !== 'timeUp' && kind !== 'incomplete' && (line === undefined || !saysTheSame(topup.message, line)) ? topup.message : undefined;

  return (
    <div className="split topup-split">
      <section ref={focusRef} className="card pad-lg stack-lg topup-card" tabIndex={-1} aria-labelledby="topup-status">
        <div className="topup-head">
          <h2 id="topup-status" className="topup-badge"><span className="sr-only">Status: </span><Badge tone={badge.tone} large>{badge.label}</Badge></h2>
          {ticking && kind !== 'timeUp' ? (
            <span className="small muted pay-by">
              Pay by {utcDateTime(topup.payBy)}
              <span className="countdown" role="timer" aria-label="Time left">{countdownText(timeLeft(topup.payBy, now))}</span>
            </span>
          ) : null}
        </div>
        {failedAt === undefined ? null : <p className="xs muted topup-stale" role="status">Can&apos;t refresh right now. Last read at {utcClock(readAt)}.</p>}
        {message === undefined ? null : <p>{message}</p>}
        <StateBlock kind={kind} topup={topup} confirmed={confirmed} failed={failedAt !== undefined} />
        <Steps kind={kind} topup={topup} />
        <div className="row"><Button variant="outline" onClick={onNew}>New top-up</Button></div>
      </section>
      <section className="card stack topup-facts" aria-labelledby="topup-facts">
        <h2 id="topup-facts" className="card-title">This top-up</h2>
        <dl className="kv topup-kv">
          <dt>You send</dt><dd>{topup.amount} {topup.token} on {networkName(topup.network)}</dd>
          <dt>At least</dt><dd>{topup.sendAtLeast === null ? '-' : `${topup.sendAtLeast} ${topup.token}`}</dd>
          <dt>About</dt><dd>{topup.estimatedCredits === null ? '-' : `${topup.estimatedCredits} Credits`}</dd>
          <dt>Started</dt><dd>{utcDateTime(topup.createdAt)}</dd>
          <dt>ID</dt>
          <dd className="topup-id"><code>{topup.id}</code><CopyButton text={topup.id} label="Copy the top-up ID" variant="ghost" iconOnly /></dd>
        </dl>
        <p className="xs muted">Leave this page if you like. It comes back here when you return.</p>
      </section>
    </div>
  );
};
