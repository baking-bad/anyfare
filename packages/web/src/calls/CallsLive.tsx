'use client';

import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { getLiveStats, listCalls, paths } from '../api/endpoints';
import { createReader, type ApiResult } from '../api/reader';
import type { Call, CallsPage, LiveStats } from '../api/types';
import { BarChart } from '../components/BarChart';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { DataTable } from '../components/DataTable';
import { EmptyState } from '../components/EmptyState';
import { ErrorState } from '../components/ErrorState';
import { Icon } from '../components/Icon';
import { LiveDot } from '../components/LiveDot';
import { Pager } from '../components/Pager';
import { useSettings } from '../components/Settings';
import { Skeleton } from '../components/Skeleton';
import { paidWithFilterName } from '../content/home';
import { count, usd } from '../format';
import { useCallStream } from '../live/useCallStream';
import { useNow } from '../live/useNow';
import { CallTableRow } from './CallTableRow';
import { callsLine, callsTitle } from './content';
import { apiFilter, apiQuery, callsHref, isFiltered, pageSize, paidWithChoices, parseFilters, withFilter, withoutControls, type CallsFilters } from './filters';

export interface CallsLiveProps {
  // The live numbers, or null when that read failed
  readonly live: LiveStats | null;
  // The first page of the list, as the server read it for the URL
  readonly calls: ApiResult<CallsPage>;
  // Hosts the service field suggests
  readonly suggestions: readonly string[];
  // The address (path and query) the first page of the list was read for. When the page mounts at another address, such as after a move through the Agent view, the list is read again.
  readonly firstKey: string;
  // The server's clock when it rendered: the "when" of each row counts from it until the browser takes over
  readonly now: number;
}

const refreshMs = 30_000;
const rememberedCalls = 500;
const searchDelayMs = 300;

interface Today {
  readonly calls: number;
  readonly volume: number;
  readonly buyers: number;
  // Paid calls paid from NEAR
  readonly near: number;
  readonly perMinute: LiveStats['perMinute'];
}

const todayOf = (live: LiveStats): Today => ({
  calls: live.today.calls,
  volume: Number(live.today.volume) || 0,
  buyers: live.today.buyers,
  near: Math.round(live.today.nearShare * live.today.calls),
  perMinute: live.perMinute ?? [],
});

const minuteLabel = (minute: string): string => `${minute.slice(11, 16)} UTC`;

const skeletonRows = [0, 1, 2, 3, 4, 5, 6, 7];

/**
 * The top of the Calls page and its grid: the title with the live dot, today's numbers, calls per minute,
 * the filters, and the pages. The filters and the page live in the URL. The grid reads the list for the
 * URL, and the browser's back and forward move through the filters it set. The stream, opened with the
 * same filters, puts a new call on top of page 1 and counts it on any other page, or while paused.
 */
export const CallsLive = ({ live, calls: firstCalls, suggestions, firstKey, now: serverNow }: CallsLiveProps) => {
  const { apiUrl } = useSettings();
  const reader = useMemo(() => createReader({ apiUrl }), [apiUrl]);
  const now = useNow(serverNow);
  const params = useSearchParams();
  const filters = useMemo(() => parseFilters(params), [params]);
  const key = callsHref(filters);
  const filtered = isFiltered(filters);

  const [shown, setShown] = useState<{ readonly result: ApiResult<CallsPage> }>({ result: firstCalls });
  const [loading, setLoading] = useState(key !== firstKey);
  const [reload, setReload] = useState(0);
  const [paused, setPaused] = useState(false);
  const [waiting, setWaiting] = useState(0);
  const [freshId, setFreshId] = useState<string | undefined>(undefined);
  const [today, setToday] = useState<Today | null>(live === null ? null : todayOf(live));
  const [serviceText, setServiceText] = useState(filters.service ?? '');

  const loaded = useRef({ key: firstKey, reload });
  const request = useRef(0);
  const seen = useRef(new Set<string>());
  const counted = useRef(new Set<string>());
  const latest = useRef({ filters, paused, loading, page: filters.page });
  useEffect(() => {
    latest.current = { filters, paused, loading, page: filters.page };
  });

  // Moves to the filters: a new entry in the browser's history, and the URL says what the page shows
  const go = useCallback((next: CallsFilters): void => {
    const href = callsHref(next);
    if (href !== callsHref(latest.current.filters))
      window.history.pushState(null, '', href);
  }, []);

  // Reads the list again when the filters, the page, or a "show them" says so
  useEffect(() => {
    if (loaded.current.key === key && loaded.current.reload === reload)
      return;
    loaded.current = { key, reload };
    const id = request.current + 1;
    request.current = id;
    setLoading(true);
    setWaiting(0);
    setFreshId(undefined);
    void listCalls(reader, apiQuery(latest.current.filters)).then(result => {
      if (id !== request.current)
        return;
      setShown({ result });
      setWaiting(0);
      setLoading(false);
    });
  }, [key, reload, reader]);

  // A call counts once, whatever the stream and the read both say
  useEffect(() => {
    seen.current = new Set(shown.result.ok ? shown.result.value.calls.map(call => call.id) : []);
  }, [shown]);

  const onListCall = useCallback((call: Call): void => {
    if (seen.current.has(call.id))
      return;
    seen.current.add(call.id);
    if (seen.current.size > rememberedCalls)
      seen.current.delete(seen.current.values().next().value as string);
    const view = latest.current;
    if (view.page === 1 && !view.paused && !view.loading) {
      setShown(current => {
        if (!current.result.ok)
          return current;
        const { value } = current.result;

        return { result: { ok: true, value: { ...value, calls: [call, ...value.calls].slice(0, pageSize), total: value.total + 1 } } };
      });
      setFreshId(call.id);
    }
    else {
      setWaiting(current => current + 1);
    }
  }, []);

  const onAnyCall = useCallback((call: Call): void => {
    if (!counted.current.has(call.id)) {
      counted.current.add(call.id);
      if (counted.current.size > rememberedCalls)
        counted.current.delete(counted.current.values().next().value as string);
      const amount = Number(call.amount);
      if (call.status === 'paid' && Number.isFinite(amount)) {
        setToday(current => current === null ? current : {
          ...current,
          calls: current.calls + 1,
          volume: current.volume + amount,
          near: current.near + (call.paidWith === 'near' ? 1 : 0),
        });
      }
    }
    if (!isFiltered(latest.current.filters))
      onListCall(call);
  }, [onListCall]);

  // Today's counters follow every call. The list follows the filtered stream, or the same one when nothing is filtered.
  const anyConnected = useCallStream(`${apiUrl}${paths.callStream()}`, onAnyCall);
  const filteredConnected = useCallStream(filtered ? `${apiUrl}${paths.callStream(apiFilter(filters))}` : '', onListCall);
  const connected = filtered ? filteredConnected : anyConnected;

  // The numbers that a stream can't know, and a count the stream's calls may have drifted from
  useEffect(() => {
    const refresh = (): void => {
      if (document.visibilityState === 'hidden')
        return;
      void getLiveStats(reader).then(result => {
        if (result.ok)
          setToday(todayOf(result.value));
      });
    };
    const timer = setInterval(refresh, refreshMs);
    document.addEventListener('visibilitychange', refresh);

    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [reader]);

  // The service field asks after a pause in the typing
  useEffect(() => {
    if (serviceText.trim() === (latest.current.filters.service ?? ''))
      return undefined;
    const timer = setTimeout(() => go(withFilter(latest.current.filters, 'service', serviceText)), searchDelayMs);

    return () => clearTimeout(timer);
  }, [serviceText, go]);

  // Back and forward change the URL under the field
  useEffect(() => {
    setServiceText(current => current.trim() === (filters.service ?? '') ? current : filters.service ?? '');
  }, [filters.service]);

  const showNew = (): void => {
    setPaused(false);
    setWaiting(0);
    go({ ...filters, page: 1 });
    setReload(current => current + 1);
  };

  const togglePause = (): void => {
    if (paused && waiting > 0 && filters.page === 1)
      setReload(current => current + 1);
    setPaused(!paused);
  };

  const result = shown.result;
  const share = today === null || today.calls === 0 ? 0 : Math.round(100 * today.near / today.calls);
  const emptyText = filtered ? 'No calls match these filters yet.' : null;

  return (
    <>
      <div className="stack calls-intro">
        <h1 className="page-title row"><LiveDot paused={paused || !connected} />{callsTitle}</h1>
        <p className="muted">{callsLine}</p>
      </div>

      <div className="ops-top mt-32">
        <div className="card counter">
          <div className="row-between"><span className="card-title">Today, UTC</span><span className="xs muted">Updates live</span></div>
          {today === null ? (
            <div className="mt-12"><ErrorState title="The numbers didn't load">The Platform API didn&apos;t answer. Reload the page in a moment.</ErrorState></div>
          ) : (
            <div className="ops-counts mt-12">
              <div className="stack counter-item"><span className="v">{count(today.calls)}</span><span className="small muted">Paid calls</span></div>
              <div className="stack counter-item"><span className="v">{usd(today.volume)}</span><span className="small muted">Volume</span></div>
              <div className="stack counter-item"><span className="v">{count(today.buyers)}</span><span className="small muted">Buyers</span></div>
              <div className="stack counter-item"><span className="v">{share}%</span><span className="small muted">Paid from NEAR</span></div>
            </div>
          )}
        </div>
        <div className="card stack">
          <div className="row-between"><span className="card-title">Calls per minute</span><span className="xs muted">Last 30 min</span></div>
          {today === null ? (
            <ErrorState title="The chart didn't load">The Platform API didn&apos;t answer.</ErrorState>
          ) : (
            <BarChart
              height={96}
              label="Calls per minute"
              data={today.perMinute.map(point => ({ value: point.calls, label: minuteLabel(point.minute) }))}
            />
          )}
        </div>
      </div>

      <div className="mt-16">
        <DataTable
          label="Calls"
          top={(
            <>
              <div className="grid-bar">
                <div className="filters">
                  <div className="filter-field">
                    <label className="filter-label" htmlFor="f-rail">Paid with</label>
                    <select id="f-rail" className="input f-rail" value={filters.paidWith ?? ''} onChange={event => go(withFilter(filters, 'paidWith', event.target.value))}>
                      <option value="">Any</option>
                      {paidWithChoices.map(choice => <option key={choice} value={choice}>{paidWithFilterName(choice)}</option>)}
                    </select>
                  </div>
                  <div className="filter-field">
                    <label className="filter-label" htmlFor="f-svc">Service</label>
                    <div className="search">
                      <Icon name="search" />
                      <input
                        id="f-svc"
                        className="input f-svc"
                        list="svc-list"
                        placeholder="Name or host"
                        autoComplete="off"
                        maxLength={100}
                        value={serviceText}
                        onChange={event => setServiceText(withoutControls(event.target.value))}
                      />
                    </div>
                    <datalist id="svc-list">{suggestions.map(host => <option key={host} value={host} />)}</datalist>
                  </div>
                  <div className="filter-field">
                    <label className="filter-label" htmlFor="f-status">Status</label>
                    <select id="f-status" className="input f-status" value={filters.status ?? ''} onChange={event => go(withFilter(filters, 'status', event.target.value))}>
                      <option value="">Any</option>
                      <option value="paid">Paid</option>
                      <option value="free">Failed, free</option>
                    </select>
                  </div>
                </div>
                <Button variant="secondary" onClick={togglePause}>
                  <Icon name={paused ? 'play' : 'pause'} />{paused ? 'Resume' : 'Pause'}
                </Button>
              </div>
              {waiting > 0 && (filters.page > 1 || paused) ? (
                <button type="button" className="new-calls" onClick={showNew}>{waiting} new call{waiting === 1 ? '' : 's'}. Show them</button>
              ) : null}
            </>
          )}
          footer={result.ok ? (
            <Pager
              page={filters.page}
              size={result.value.size}
              total={result.value.total}
              capped={result.value.totalCapped}
              onPage={page => go({ ...filters, page })}
            />
          ) : null}
        >
          <thead>
            <tr>
              <th>When</th><th>Service and endpoint</th><th>Paid with</th><th>API paid with</th><th>Buyer</th><th className="r">Amount</th><th>Status</th><th className="r">Time</th><th />
            </tr>
          </thead>
          <tbody aria-busy={loading}>
            {loading ? skeletonRows.map(row => (
              <tr key={row}><td colSpan={9}><Skeleton shape="block" /></td></tr>
            )) : !result.ok ? (
              <tr>
                <td colSpan={9} className="state-cell">
                  <div className="state-inner"><ErrorState title="The calls didn't load" action={<Button variant="secondary" size="sm" onClick={() => setReload(current => current + 1)}>Try again</Button>}>
                    The Platform API didn&apos;t answer. Try again in a moment.
                  </ErrorState></div>
                </td>
              </tr>
            ) : result.value.calls.length === 0 ? (
              <tr>
                <td colSpan={9} className="state-cell">
                  <div className="state-inner">
                    {emptyText === null
                      ? <EmptyState icon="activity" title="No calls yet">Calls appear here as they are paid.</EmptyState>
                      : <p className="small muted">{emptyText}</p>}
                  </div>
                </td>
              </tr>
            ) : result.value.calls.map(call => <CallTableRow key={call.id} call={call} now={now} fresh={call.id === freshId} />)}
          </tbody>
        </DataTable>
      </div>
    </>
  );
};
