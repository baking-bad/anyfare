'use client';

import { useEffect, useRef, useState } from 'react';

import { Button } from '../../components/Button';
import { DataTable } from '../../components/DataTable';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { useSettings } from '../../components/Settings';
import { Skeleton } from '../../components/Skeleton';
import { Icon } from '../../components/Icon';
import { isTopupsOff, listTopups, readTopup, readTopupOptions, type NewTopup, type Topup } from '../api';
import { PageTitle } from '../components/PageTitle';
import { problemText, useConsoleData, useRead, type Read } from '../context';
import { cursorNow, firstPage, hasNewer, newer, older, type Cursors } from '../payments';
import { apiRequests, createSender, refusalOf, requestAddress } from './create';
import { documentPage, pollMs, startPolling, timers } from './poll';
import { networkName } from './status';
import { TopupForm, type FormLink, type Refusal } from './TopupForm';
import { TopupHead, TopupRow } from './TopupRow';
import { TopupView, type ShownTopup } from './TopupView';
import { isOpenStatus } from './view';

/** The top-ups a page of "Latest top-ups" holds. */
export const listPageSize = 10;

/** How many of the newest top-ups the page reads when it opens, to bring back one that is still open. */
export const restoreListSize = 20;

const columns = 5;

type Shown = { readonly kind: 'form' } | ({ readonly kind: 'topup' } & ShownTopup);

interface ListPage {
  readonly topups: readonly Topup[];
  readonly next: string | null;
  readonly readAt: number;
}

/** A page of the list, read again when the cursor changes or when asked. A page that comes after another was asked for is dropped. */
const useListPage = (apiUrl: string, after: string | undefined, round: number): Read<ListPage> => {
  const [read, setRead] = useState<Read<ListPage>>({ state: 'loading' });
  useEffect(() => {
    let live = true;
    setRead(before => before.state === 'ok' ? before : { state: 'loading' });
    listTopups(apiUrl, listPageSize, after).then(
      page => {
        if (live)
          setRead({ state: 'ok', value: { ...page, readAt: Date.now() } });
      },
      (error: unknown) => {
        if (live)
          setRead({ state: 'failed', error });
      },
    );

    return () => {
      live = false;
    };
  }, [apiUrl, after, round]);

  return read;
};

/** What the page opens with: the form for a link's amount, else the newest top-up while it is still open, else the form. Undefined while that is read. */
export const openingView = (link: FormLink, newest: Read<{ readonly topups: readonly Topup[]; readonly readAt: number }>): Shown | undefined => {
  if (link.kind !== 'none')
    return { kind: 'form' };
  if (newest.state === 'loading')
    return undefined;
  const first = newest.state === 'ok' ? newest.value.topups[0] : undefined;

  return first !== undefined && isOpenStatus(first.status) && newest.state === 'ok' ? { kind: 'topup', topup: first, readAt: newest.value.readAt, confirmed: false } : { kind: 'form' };
};

/**
 * Whether the top of a card at `top` (from the window's top) is in view: below the room the top bar needs (`margin`, the
 * card's `scroll-margin-top`) and in the upper part of the window. A card in view is not scrolled to.
 */
export const cardInView = (top: number, margin: number, windowHeight: number): boolean => top >= margin && top <= windowHeight * 0.6;

/** What the page shows after a read of top-up `topup.id`: that answer, when that top-up is on screen; otherwise what it showed. */
export const afterRead = (shown: Shown | undefined, topup: Topup, at: number): Shown | undefined =>
  shown?.kind === 'topup' && shown.topup.id === topup.id ? { kind: 'topup', topup, readAt: at, confirmed: true } : shown;

/** What the page shows after a failed read of top-up `id`: the same, marked, when that top-up is on screen. */
export const afterFailedRead = (shown: Shown | undefined, id: string, at: number): Shown | undefined =>
  shown?.kind === 'topup' && shown.topup.id === id ? { ...shown, failedAt: at } : shown;

/**
 * Top up: the form, or one top-up by its status, and under both the list "Latest top-ups". Which top-up is open is
 * this page's state, never the address. When it opens (after a reload, or coming back to it), it brings back the
 * newest top-up while it is still open; a link's amount always opens the form. An open top-up is read again every 5
 * seconds while the tab is visible. When top-ups are off, the whole page says so.
 */
export const TopupPage = ({ amount, amountUnused = false }: { readonly amount?: number | undefined; readonly amountUnused?: boolean }) => {
  const { apiUrl } = useSettings();
  const { readBalanceAgain, readTopupsAgain } = useConsoleData();
  const link: FormLink = amount !== undefined ? { kind: 'used', amount } : amountUnused ? { kind: 'unused' } : { kind: 'none' };
  const [options, optionsAgain] = useRead(() => readTopupOptions(apiUrl));
  const [newest, newestAgain] = useRead(async () => ({ ...await listTopups(apiUrl, restoreListSize), readAt: Date.now() }));
  const [cursors, setCursors] = useState<Cursors>(firstPage);
  const [listRound, setListRound] = useState(0);
  const list = useListPage(apiUrl, cursorNow(cursors), listRound);
  const [chosen, setChosen] = useState<Shown | undefined>(undefined);
  const [focusRound, setFocusRound] = useState(0);
  const viewBox = useRef<HTMLElement>(null);
  // One request for an address at a time on this page, whichever view shows
  const [sender] = useState(createSender);
  const [sending, setSending] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | undefined>(undefined);
  // A new top-up whose answer came while another one was on screen: the page offers it, and opens nothing on its own
  const [ready, setReady] = useState<Topup | undefined>(undefined);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;

    return () => {
      live.current = false;
    };
  }, []);
  const shown = chosen ?? openingView(link, newest);
  // What is on screen, for an answer that comes later
  const shownNow = useRef(shown);
  useEffect(() => {
    shownNow.current = shown;
  });
  const openId = shown?.kind === 'topup' ? shown.topup.id : undefined;
  const openStatus = shown?.kind === 'topup' ? shown.topup.status : undefined;
  const polled = openStatus !== undefined && isOpenStatus(openStatus);

  // An open top-up is read at once and again until its status is final. Only an answer for the top-up on screen
  // replaces it, and a snapshot from a list shows its address only once that first read answers.
  useEffect(() => {
    if (openId === undefined || !polled)
      return undefined;

    return startPolling<Topup>({
      read: () => readTopup(apiUrl, openId),
      onRead: topup => setChosen(before => afterRead(before ?? shownNow.current, topup, Date.now()) ?? before),
      onFail: () => setChosen(before => afterFailedRead(before ?? shownNow.current, openId, Date.now()) ?? before),
      done: topup => !isOpenStatus(topup.status),
    }, documentPage, timers, pollMs, true);
  }, [apiUrl, openId, polled]);

  // A status that changes on screen reads the list again, and the frame's newest top-ups, so the sidebar's line goes at
  // once when it is final; a top-up that is credited reads the balance again
  const seen = useRef<{ readonly id: string; readonly status: string } | undefined>(undefined);
  useEffect(() => {
    if (openId === undefined || openStatus === undefined)
      return;
    const before = seen.current;
    seen.current = { id: openId, status: openStatus };
    if (before?.id !== openId || before.status === openStatus)
      return;
    setListRound(round => round + 1);
    readTopupsAgain();
    if (openStatus === 'credited')
      readBalanceAgain();
  }, [openId, openStatus, readBalanceAgain, readTopupsAgain]);

  // The view of a top-up that was just opened takes the focus, and comes into sight only when it is out of it
  useEffect(() => {
    const box = viewBox.current;
    if (focusRound === 0 || box === null)
      return;
    if (!cardInView(box.getBoundingClientRect().top, Number.parseFloat(getComputedStyle(box).scrollMarginTop) || 0, innerHeight))
      box.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    box.focus({ preventScroll: true });
  }, [focusRound]);

  // A snapshot (a row, the newest top-up, a new one offered later) opens unconfirmed: its address waits for its own read
  const open = (topup: Topup, readAt: number): void => {
    // The top-up on screen keeps its own newer answer: a row of the list may be older
    if (shown?.kind !== 'topup' || shown.topup.id !== topup.id)
      setChosen({ kind: 'topup', topup, readAt, confirmed: false });
    if (ready?.id === topup.id)
      setReady(undefined);
    setFocusRound(round => round + 1);
  };

  const showForm = (): void => {
    setChosen({ kind: 'form' });
    // The form says which top-up is in progress: from a fresh read
    newestAgain();
  };

  const send = (body: NewTopup, symbol: string, network: string): void => {
    const run = sender.send(() => requestAddress(apiRequests(apiUrl), body, symbol, Date.now()));
    if (run === undefined)
      return;
    setSending(true);
    setRefusal(undefined);
    setReady(undefined);
    void run.then(result => {
      if (!live.current)
        return;
      setSending(false);
      if (result.kind !== 'made' && result.kind !== 'found') {
        setRefusal(refusalOf(result, network));

        return;
      }
      setCursors(firstPage);
      setListRound(round => round + 1);
      // The sidebar shows the new top-up on its way
      readTopupsAgain();
      // The person may have opened another top-up while this one was made: theirs stays, and this one is offered
      if (shownNow.current?.kind !== 'form') {
        setReady(result.topup);

        return;
      }
      // The POST's own answer is this top-up's; one found in the list after no answer is a snapshot
      setChosen({ kind: 'topup', topup: result.topup, readAt: Date.now(), confirmed: result.kind === 'made' });
      setFocusRound(round => round + 1);
    }, () => {
      if (live.current)
        setSending(false);
    });
  };

  const off = [options, newest, list].some(read => read.state === 'failed' && isTopupsOff(read.error));
  const tryAgain = (): void => {
    optionsAgain();
    newestAgain();
    setListRound(round => round + 1);
  };
  const inProgress = link.kind !== 'none' && newest.state === 'ok' && newest.value.topups[0] !== undefined && isOpenStatus(newest.value.topups[0].status) ? newest.value.topups[0] : undefined;

  return (
    <div className="stack-lg">
      <PageTitle title="Top up" lead="Send a token from one of the networks below. NEAR Intents converts it to USDC on NEAR. 1 USDC is 1 Credit." />
      {ready === undefined || off ? null : (
        <div className="topup-progress topup-ready" role="status">
          <Icon name="check" />
          <span className="small grow"><b>Your new deposit address is ready</b>: {ready.amount} {ready.token} on {networkName(ready.network)}.</span>
          <Button variant="secondary" size="sm" onClick={() => open(ready, Date.now())}>Open it</Button>
        </div>
      )}
      {off ? (
        <div className="card">
          <EmptyState icon="wallet" title="Top-ups are off right now." action={<Button variant="secondary" onClick={tryAgain}>Try again</Button>}>Calls keep working.</EmptyState>
        </div>
      ) : (
        <>
          {shown === undefined ? (
            <div className="stack" role="status" aria-label="Loading"><Skeleton shape="block" /><Skeleton shape="block" /></div>
          ) : shown.kind === 'topup' ? (
            <TopupView key={shown.topup.id} shown={shown} focusRef={viewBox} onNew={showForm} />
          ) : (
            <TopupForm
              options={options}
              optionsAgain={optionsAgain}
              link={link}
              inProgress={inProgress}
              sending={sending}
              refusal={refusal}
              onOpen={topup => open(topup, newest.state === 'ok' ? newest.value.readAt : Date.now())}
              onSend={send}
              onChange={() => setRefusal(undefined)}
            />
          )}
          <DataTable
            label="Latest top-ups"
            title="Latest top-ups"
            footer={list.state === 'ok' && (hasNewer(cursors) || list.value.next !== null) ? (
              <nav className="pager" aria-label="Pages">
                <span className="small muted num">Page {cursors.seen.length}</span>
                <div className="row">
                  <Button variant="secondary" disabled={!hasNewer(cursors)} onClick={() => setCursors(newer(cursors))}>Newer</Button>
                  <Button variant="secondary" disabled={list.value.next === null} onClick={() => list.value.next !== null && setCursors(older(cursors, list.value.next))}>Older</Button>
                </div>
              </nav>
            ) : null}
          >
            <TopupHead links />
            <tbody aria-busy={list.state === 'loading'}>
              {list.state === 'loading' ? [0, 1, 2].map(row => (
                <tr key={row}><td colSpan={columns}><Skeleton shape="block" /></td></tr>
              )) : list.state === 'failed' ? (
                <tr>
                  <td colSpan={columns} className="state-cell">
                    <div className="state-inner">
                      <ErrorState title="The top-ups didn't load" action={<Button variant="secondary" size="sm" onClick={() => setListRound(round => round + 1)}>Try again</Button>}>{problemText(list.error)}</ErrorState>
                    </div>
                  </td>
                </tr>
              ) : list.value.topups.length === 0 ? (
                <tr>
                  <td colSpan={columns} className="state-cell">
                    <div className="state-inner"><EmptyState small icon="wallet" title="No top-ups yet." /></div>
                  </td>
                </tr>
              ) : list.value.topups.map(topup => (
                <TopupRow key={topup.id} topup={topup} current={topup.id === openId} onOpen={row => open(row, list.value.readAt)} />
              ))}
            </tbody>
          </DataTable>
        </>
      )}
    </div>
  );
};
