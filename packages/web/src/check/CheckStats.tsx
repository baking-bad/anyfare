'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { getEndpointStats } from '../api/endpoints';
import { createReader, type ApiResult } from '../api/reader';
import type { EndpointStats, Period } from '../api/types';
import { BarChart } from '../components/BarChart';
import { BarList } from '../components/BarList';
import { ErrorState } from '../components/ErrorState';
import { Rail } from '../components/Rail';
import { useSettings } from '../components/Settings';
import { Skeleton } from '../components/Skeleton';
import { paidWithName } from '../content/home';
import { count, ms, pct, usdOf } from '../format';
import { inexactLine } from '../services/content';
import type { CheckNumbers } from './answer';
import { checkAddress, parseCheckParams, periodChoices, periodName, type CheckParams } from './content';

const Stat = ({ value, label }: { readonly value: string; readonly label: string }) => (
  <div className="card"><span className="v">{value}</span><span className="l">{label}</span></div>
);

const NumberCards = ({ numbers }: { readonly numbers: { readonly calls: number; readonly buyers: number; readonly volume: string; readonly successRate: number | null; readonly p50Ms: number | null } }) => (
  <>
    <Stat value={count(numbers.calls)} label="Paid calls" />
    <Stat value={count(numbers.buyers)} label="Unique payers" />
    <Stat value={usdOf(numbers.volume)} label="Volume" />
    <Stat value={numbers.successRate === null ? '-' : pct(numbers.successRate)} label="Answered 2xx" />
    <Stat value={numbers.p50Ms === null ? '-' : ms(numbers.p50Ms)} label="Median time" />
  </>
);

/**
 * The endpoint's numbers with the period switch. The server renders the period the URL names, and each
 * period is a link to it, so a shared link and a browser without scripts work. With scripts a click reads
 * the numbers straight from the public API, shows a loading state, and rewrites the address with
 * `&period=`. It makes no navigation, so the link is not checked again.
 */
export const CheckStats = ({ host, path, params, period: first, stats: firstStats, fallback }: {
  readonly host: string;
  // The URL's state, for the links of the periods
  readonly params: CheckParams;
  readonly path: string;
  readonly period: Period;
  readonly stats: ApiResult<EndpointStats>;
  // The check's own numbers over 30 days, shown when the API's read fails
  readonly fallback: CheckNumbers | null;
}) => {
  const { apiUrl } = useSettings();
  const [period, setPeriod] = useState(first);
  const [stats, setStats] = useState(firstStats);
  const [loading, setLoading] = useState(false);
  const request = useRef(0);
  useEffect(() => {
    setPeriod(first);
    setStats(firstStats);
  }, [first, firstStats]);

  const choose = useCallback((next: Period): void => {
    const id = request.current + 1;
    request.current = id;
    setPeriod(next);
    setLoading(true);
    window.history.replaceState(null, '', checkAddress({ ...parseCheckParams(new URLSearchParams(window.location.search)), period: next }));
    void getEndpointStats(createReader({ apiUrl }), host, path, next).then(result => {
      if (id !== request.current)
        return;
      setStats(result);
      setLoading(false);
    });
  }, [apiUrl, host, path]);

  // The page mounts again after a visit to the Agent view: the address may hold a period the server's numbers are not for
  useEffect(() => {
    const now = parseCheckParams(new URLSearchParams(window.location.search)).period;
    if (now !== first)
      choose(now);
    // Only when the page mounts
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const link = (value: Period): string => checkAddress({ ...params, period: value });
  // The API's read failed but the check carries its 30-day numbers: show those, and say which period they are
  const fallen = !loading && !stats.ok && fallback !== null;
  const selected = fallen ? '30d' : period;

  return (
    <div className="card" aria-busy={loading}>
      <div className="card-head">
        <h2 className="card-title">Stats</h2>
        <div className="seg sm period-links" role="group" aria-label="Period">
          {periodChoices.map(choice => (
            <a
              key={choice.value}
              href={link(choice.value)}
              aria-current={choice.value === selected ? 'true' : undefined}
              onClick={event => {
                if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0)
                  return;
                event.preventDefault();
                if (choice.value !== period)
                  choose(choice.value);
              }}
            >
              {choice.label}
            </a>
          ))}
        </div>
      </div>
      {loading ? (
        <div className="stack" role="status" aria-label="Loading the numbers">
          <Skeleton shape="block" />
          <Skeleton shape="block" />
        </div>
      ) : fallen ? (
        <>
          <div className="stat-cards ep-stats"><NumberCards numbers={fallback} /></div>
          <p className="small muted mt-8">The last 30 days, from the check. The chart and the other periods didn&apos;t load.</p>
        </>
      ) : !stats.ok ? (
        <ErrorState title="This endpoint's numbers didn't load">
          {stats.error.code === 'stats_unavailable' ? 'These numbers can\'t be read right now. Reload the page in a moment.' : 'The Platform API didn\'t answer. Reload the page in a moment.'}
        </ErrorState>
      ) : <StatsBody stats={stats.value} period={period} />}
    </div>
  );
};

const StatsBody = ({ stats, period }: { readonly stats: EndpointStats; readonly period: Period }) => {
  const { stats: numbers, daily, byPaidWith } = stats;
  // A date under every fourth bar, counting back from today
  const days = daily.map((point, index) => ({ value: point.calls, label: point.day, ...(daily.length - 1 - index) % 4 === 0 ? { tick: point.day.slice(5) } : {} }));
  const ways = [...byPaidWith].sort((a, b) => b.calls - a.calls);

  return (
    <>
      <div className="stat-cards ep-stats"><NumberCards numbers={numbers} /></div>
      {stats.exact ? null : <p className="small muted mt-8 ep-inexact">{inexactLine}</p>}
      <div className="split even ep-split mt-24">
        <div>
          <div className="row-between small"><span className="semi">Paid calls per day</span><span className="muted xs">14 days</span></div>
          <div className="mt-8"><BarChart data={days} height={150} label="Paid calls per day" /></div>
        </div>
        <div>
          <div className="row-between small"><span className="semi">Buyers paid with</span><span className="muted xs">{periodName(period)}</span></div>
          <div className="mt-12">
            {ways.length === 0
              ? <p className="small muted">No paid calls in this period.</p>
              : <BarList items={ways.map(way => ({ label: <Rail rail={way.paidWith} label={paidWithName(way.paidWith)} />, value: way.calls, tone: way.paidWith === 'near' ? 'near' : 'dim' }))} />}
          </div>
        </div>
      </div>
    </>
  );
};
