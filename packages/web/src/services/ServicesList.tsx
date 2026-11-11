'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { listServices } from '../api/endpoints';
import { createReader, type ApiResult } from '../api/reader';
import type { ServicesPage } from '../api/types';
import { Button } from '../components/Button';
import { DataTable } from '../components/DataTable';
import { EmptyState } from '../components/EmptyState';
import { ErrorState } from '../components/ErrorState';
import { Icon } from '../components/Icon';
import { Pager } from '../components/Pager';
import { useSettings } from '../components/Settings';
import { Skeleton } from '../components/Skeleton';
import { Sparkline } from '../components/Sparkline';
import { count, ms, pct, usdOf } from '../format';
import { firstRunLine, firstRunTitle, noMatchLine, unavailableLine } from './content';
import { apiServicesQuery, parseServicesFilters, servicesHref, sortChoices, withSearch, withSort, type ServicesFilters } from './filters';

export interface ServicesListProps {
  // The page of the list the server read for the URL
  readonly first: ApiResult<ServicesPage>;
}

const searchDelayMs = 300;
const columns = 10;
const skeletonRows = [0, 1, 2, 3, 4, 5, 6, 7];

type Totals = ServicesPage['totals'];

const Cards = ({ totals }: { readonly totals: Totals | null }) => (
  <div className="stat-cards mt-32">
    <div className="card"><span className="v">{totals === null ? '-' : count(totals.services)}</span><span className="l">Services paid through Anyfare</span></div>
    <div className="card"><span className="v">{totals === null ? '-' : count(totals.paidEndpoints)}</span><span className="l">Paid endpoints on them</span></div>
    <div className="card"><span className="v">{totals === null ? '-' : count(totals.calls30d)}</span><span className="l">Calls through Anyfare, 30 days</span></div>
  </div>
);

/**
 * The numbers, the search and sort, the grid of services, and its pages. The search, the sort and the page
 * live in the URL: the grid reads the list for the URL, and the browser's back and forward move through
 * what it set. The server renders the first page for the URL, so the same URL shows the same page.
 */
export const ServicesList = ({ first }: ServicesListProps) => {
  const { apiUrl } = useSettings();
  const reader = useMemo(() => createReader({ apiUrl }), [apiUrl]);
  const params = useSearchParams();
  const filters = useMemo(() => parseServicesFilters(params), [params]);
  const key = servicesHref(filters);

  const [result, setResult] = useState<ApiResult<ServicesPage>>(first);
  const [totals, setTotals] = useState<Totals | null>(first.ok ? first.value.totals : null);
  const [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);
  const [searchText, setSearchText] = useState(filters.q ?? '');

  const loaded = useRef({ key, reload });
  const request = useRef(0);
  const latest = useRef(filters);
  useEffect(() => {
    latest.current = filters;
  });

  // Moves to the filters: a new entry in the browser's history, and the URL says what the page shows
  const go = useCallback((next: ServicesFilters): void => {
    const href = servicesHref(next);
    if (href !== servicesHref(latest.current))
      window.history.pushState(null, '', href);
  }, []);

  // Reads the list again when the search, the sort, the page, or a "try again" says so
  useEffect(() => {
    if (loaded.current.key === key && loaded.current.reload === reload)
      return;
    loaded.current = { key, reload };
    const id = request.current + 1;
    request.current = id;
    setLoading(true);
    void listServices(reader, apiServicesQuery(latest.current)).then(answer => {
      if (id !== request.current)
        return;
      setResult(answer);
      if (answer.ok)
        setTotals(answer.value.totals);
      setLoading(false);
    });
  }, [key, reload, reader]);

  // The search asks after a pause in the typing
  useEffect(() => {
    if (searchText.trim() === (latest.current.q ?? ''))
      return undefined;
    const timer = setTimeout(() => go(withSearch(latest.current, searchText)), searchDelayMs);

    return () => clearTimeout(timer);
  }, [searchText, go]);

  // Back and forward change the URL under the field
  useEffect(() => {
    setSearchText(current => current.trim() === (filters.q ?? '') ? current : filters.q ?? '');
  }, [filters.q]);

  const searching = filters.q !== undefined;

  return (
    <>
      <Cards totals={totals} />
      <div className="mt-32">
        <DataTable
          label="Services"
          top={(
            <div className="grid-bar svc-bar">
              <div className="filters svc-filters">
                <div className="search svc-search">
                  <Icon name="search" />
                  <input
                    className="input"
                    type="search"
                    placeholder="Search by name or host"
                    aria-label="Search"
                    autoComplete="off"
                    maxLength={100}
                    value={searchText}
                    onChange={event => setSearchText(event.target.value)}
                  />
                </div>
                <select className="input svc-sort" aria-label="Sort" value={filters.sort} onChange={event => go(withSort(filters, event.target.value))}>
                  {sortChoices.map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
                </select>
              </div>
            </div>
          )}
          footer={result.ok ? (
            <Pager page={filters.page} size={result.value.size} total={result.value.total} onPage={page => go({ ...filters, page })} />
          ) : null}
        >
          <thead>
            <tr>
              <th>Service</th><th className="r">Paid endpoints</th><th className="r">Price from</th><th className="r">Calls through Anyfare</th><th>30 days</th>
              <th className="r">Buyers</th><th className="r">Volume</th><th className="r">2xx</th><th className="r">Median</th><th><span className="sr-only">Open</span></th>
            </tr>
          </thead>
          <tbody aria-busy={loading}>
            {loading ? skeletonRows.map(row => (
              <tr key={row}><td colSpan={columns}><Skeleton shape="block" /></td></tr>
            )) : !result.ok ? (
              <tr>
                <td colSpan={columns} className="state-cell">
                  <div className="state-inner">
                    <ErrorState title="The services didn't load" action={<Button variant="secondary" size="sm" onClick={() => setReload(current => current + 1)}>Try again</Button>}>
                      {unavailableLine}
                    </ErrorState>
                  </div>
                </td>
              </tr>
            ) : result.value.services.length === 0 ? (
              <tr>
                <td colSpan={columns} className="state-cell">
                  <div className="state-inner">
                    {searching || (totals !== null && totals.services > 0)
                      ? <p className="small muted">{noMatchLine}</p>
                      : <EmptyState icon="list" title={firstRunTitle} action={<Button variant="outline" href="/">Paste a link</Button>}>{firstRunLine}</EmptyState>}
                  </div>
                </td>
              </tr>
            ) : result.value.services.map(service => (
              <tr key={service.host} className="click">
                <td><Link prefetch={false} className="row-link row-title mono svc-host" href={`/services/${encodeURIComponent(service.host)}`}>{service.host}</Link></td>
                <td className="r">{count(service.paidEndpoints)}</td>
                <td className="r">{usdOf(service.priceFrom, 3)}</td>
                <td className="r semi">{count(service.calls)}</td>
                <td><Sparkline values={service.trend} /></td>
                <td className="r">{count(service.buyers)}</td>
                <td className="r">{usdOf(service.volume, 2)}</td>
                <td className="r">{service.successRate === null ? '-' : pct(service.successRate)}</td>
                <td className="r">{service.p50Ms === null ? '-' : ms(service.p50Ms)}</td>
                <td className="r"><Icon name="chev" className="chev" /></td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      </div>
    </>
  );
};
