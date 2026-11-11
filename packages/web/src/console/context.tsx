'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { useSettings } from '../components/Settings';
import { ConsoleApiError, readAccount, readBalance, RefusedTargetError, type Account, type Balance } from './api';

// What every console page shares: where the console and the public site live, and, while signed in, the reads the
// frame makes once (the balance and the account). The reads live in the frame, so signing out drops them with it.

export interface ConsolePlaces {
  // The public site's origin, for the links to its pages
  readonly siteUrl: string;
  // The Overview's path on this host: `/`, or `/console` when the two hosts are one
  readonly overviewPath: string;
}

const PlacesContext = createContext<ConsolePlaces | undefined>(undefined);

export const ConsolePlacesProvider = ({ value, children }: { readonly value: ConsolePlaces; readonly children: ReactNode }) => (
  <PlacesContext.Provider value={value}>{children}</PlacesContext.Provider>
);

export const useConsolePlaces = (): ConsolePlaces => {
  const value = useContext(PlacesContext);
  if (value === undefined)
    throw new Error('useConsolePlaces needs a ConsolePlacesProvider above it');

  return value;
};

/** A read: running (the first time, or again after it failed), done, or failed. */
export type Read<TValue> =
  | { readonly state: 'loading' }
  | { readonly state: 'ok'; readonly value: TValue }
  | { readonly state: 'failed'; readonly error: unknown };

/**
 * Runs `load` once, and again on `again()`. A read that runs again keeps showing what it had, unless it had failed.
 * An answer that comes after the component is gone is dropped.
 */
export const useRead = <TValue,>(load: () => Promise<TValue>): readonly [Read<TValue>, () => void] => {
  const [read, setRead] = useState<Read<TValue>>({ state: 'loading' });
  const [round, setRound] = useState(0);
  useEffect(() => {
    let live = true;
    setRead(before => before.state === 'ok' ? before : { state: 'loading' });
    load().then(
      value => {
        if (live)
          setRead({ state: 'ok', value });
      },
      (error: unknown) => {
        if (live)
          setRead({ state: 'failed', error });
      },
    );

    return () => {
      live = false;
    };
    // `load` is a new function on every render; `round` is what asks for another read
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [round]);
  const again = useCallback(() => setRound(count => count + 1), []);

  return [read, again] as const;
};

/** A wait from `Retry-After`: "30 seconds", "1 minute", "5 minutes". */
export const waitText = (seconds: number): string => {
  if (seconds < 60)
    return seconds === 1 ? '1 second' : `${seconds} seconds`;
  const minutes = Math.ceil(seconds / 60);

  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
};

/** What a failed read or request says to a person: the API's own message only when it has no better one. Always text. */
export const problemText = (error: unknown): string => {
  if (error instanceof RefusedTargetError)
    return 'The console\'s settings name no valid address for the Anyfare API.';
  if (!(error instanceof ConsoleApiError))
    return 'Something went wrong. Try again in a moment.';
  if (error.code === 'api_unavailable' || error.status >= 500)
    return 'The Anyfare API didn\'t answer. Try again in a moment.';
  if (error.status === 429)
    return error.retryAfter === undefined ? 'Too many requests. Wait a minute and try again.' : `Too many requests. Wait ${waitText(error.retryAfter)} and try again.`;
  if (error.code === 'unexpected_answer')
    return 'The Anyfare API gave an answer the console can\'t read. Try again in a moment.';

  return error.message;
};

export interface ConsoleData {
  readonly balance: Read<Balance>;
  readonly account: Read<Account>;
  readonly readBalanceAgain: () => void;
  readonly readAccountAgain: () => void;
}

const DataContext = createContext<ConsoleData | undefined>(undefined);

/** The frame's reads: the balance and the account, once each when the frame opens, and again when asked. */
export const ConsoleDataProvider = ({ children }: { readonly children: ReactNode }) => {
  const { apiUrl } = useSettings();
  const [balance, readBalanceAgain] = useRead(() => readBalance(apiUrl));
  const [account, readAccountAgain] = useRead(() => readAccount(apiUrl));
  const value = useMemo(() => ({ balance, account, readBalanceAgain, readAccountAgain }), [balance, account, readBalanceAgain, readAccountAgain]);

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
};

export const useConsoleData = (): ConsoleData => {
  const value = useContext(DataContext);
  if (value === undefined)
    throw new Error('useConsoleData needs a ConsoleDataProvider above it');

  return value;
};
