import Link from 'next/link';
import type { ReactNode } from 'react';

import type { ServiceDetail } from '../api/types';
import { shortAddress } from '../calls/address';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { CopyButton } from '../components/CopyButton';
import { DataTable } from '../components/DataTable';
import { ErrorState } from '../components/ErrorState';
import { Icon } from '../components/Icon';
import { Rail } from '../components/Rail';
import { paidWithName } from '../content/home';
import { count, ms, pct, usd, usdOf } from '../format';
import { formatChange } from '../home/change';
import { callsChange, checkHref, comparedWith, endpointsLine, failedLine, inexactLine, lastCall, meterShare, perBuyer, togetherLine } from './content';
import { PeriodSwitch } from './PeriodSwitch';

const methodClass = (method: string): string => ({ GET: 'get', POST: 'post', DELETE: 'del' } as Record<string, string>)[method.toUpperCase()] ?? '';

/** The top of the page: the breadcrumb, the host's tile and name, the number of paid endpoints, and the check button. */
export const ServiceHead = ({ host, service }: { readonly host: string; readonly service: ServiceDetail | undefined }) => {
  const mostUsed = service === undefined ? undefined : [...service.endpoints].sort((a, b) => b.calls - a.calls)[0];

  return (
    <>
      <nav className="row small muted" aria-label="Breadcrumb">
        <Link className="link" href="/services">Services</Link>
        <span aria-hidden="true">/</span>
        <span className="mono crumb-current" aria-current="page">{host}</span>
      </nav>
      <div className="row-between mt-16 svc-head">
        <div className="svc-title">
          <span className="tile svc-tile" aria-hidden="true">{host.charAt(0).toUpperCase()}</span>
          <div className="stack svc-name">
            <h1 className="page-title svc-host-title">{host}</h1>
            {service === undefined ? null : (
              <div className="row svc-count"><Badge>{endpointsLine(service.paidEndpoints, service.endpoints.length)}</Badge></div>
            )}
          </div>
        </div>
        <div className="row"><Button variant="secondary" size="lg" href={checkHref(host, mostUsed?.path)}>Check an endpoint</Button></div>
      </div>
    </>
  );
};

/** The endpoints table. A row opens the check page for its endpoint; its Copy button copies the pay link and opens nothing. */
export const EndpointsTable = ({ host, endpoints }: { readonly host: string; readonly endpoints: ServiceDetail['endpoints'] }) => (
  <div className="mt-32">
    <DataTable label="Endpoints" title="Endpoints" aside="Paths only. We never show query strings: they can hold a buyer's data">
      <thead>
        <tr>
          <th>Endpoint</th><th className="r">Price now</th><th className="r">Paid calls</th><th className="r">Buyers</th><th className="r">Volume</th><th className="r">2xx</th><th className="r">Median</th><th className="r">Pay link</th><th><span className="sr-only">Check</span></th>
        </tr>
      </thead>
      <tbody>
        {endpoints.length === 0 ? (
          <tr><td colSpan={9} className="muted">No paid endpoints.</td></tr>
        ) : endpoints.map(endpoint => (
          <tr key={`${endpoint.method ?? ''} ${endpoint.path}`} className="click">
            <td>
              <Link prefetch={false} className="row-link svc-endpoint" href={checkHref(host, endpoint.path, endpoint.method)}>
                {endpoint.method === null ? null : <span className={`method ${methodClass(endpoint.method)}`.trim()}>{endpoint.method.toUpperCase()}</span>}
                <code>{endpoint.path}</code>
              </Link>
            </td>
            <td className="r">{usdOf(endpoint.priceNow)}</td>
            <td className="r semi">{count(endpoint.calls)}</td>
            <td className="r">{count(endpoint.buyers)}</td>
            <td className="r">{usdOf(endpoint.volume)}</td>
            <td className="r">{endpoint.successRate === null ? '-' : pct(endpoint.successRate)}</td>
            <td className="r">{endpoint.p50Ms === null ? '-' : ms(endpoint.p50Ms)}</td>
            <td className="r"><CopyButton text={endpoint.link} size="xs" withIcon className="row-copy" name={`Copy the pay link of ${endpoint.path}`} /></td>
            <td className="r"><Icon name="chev" className="chev" /></td>
          </tr>
        ))}
      </tbody>
    </DataTable>
  </div>
);

const Kpi = ({ value, label, note, why }: { readonly value: ReactNode; readonly label: string; readonly note?: ReactNode; readonly why?: string }) => (
  <div className="stat">
    <span className="v sm">{value}</span>
    <span className="l small">{label}</span>
    {note === undefined ? null : <span className="n">{note}</span>}
    {why === undefined ? null : <span className="why">{why}</span>}
  </div>
);

/** The change in paid calls as the pill reads it, with what it is against. Nothing when there is nothing to compare. */
export const ChangePill = ({ calls, before, period }: { readonly calls: number; readonly before: number | null; readonly period: ServiceDetail['period'] }) => {
  const change = callsChange(calls, before);
  if (change === null)
    return null;
  const arrow = change > 0 ? '▲ ' : change < 0 ? '▼ ' : '';

  return (
    <>
      <span className={change < 0 ? 'pill-value info' : 'pill-value up'}>{arrow}{formatChange(change, true).replace(/^[+-]/, '')}</span>
      <span>{`vs ${comparedWith(period)}`}</span>
    </>
  );
};

/** The period switch and the six numbers of the period. */
export const ServiceStats = ({ host, service }: { readonly host: string; readonly service: ServiceDetail }) => {
  const { stats } = service;

  return (
    <>
      <div className="row-between mt-48">
        <h2 className="h3">Stats</h2>
        <PeriodSwitch host={host} period={service.period} />
      </div>
      <div className="card flush mt-16">
        <div className="kpis">
          <Kpi value={count(stats.calls)} label="Paid calls" note={<ChangePill calls={stats.calls} before={stats.callsBefore} period={service.period} />} />
          <Kpi value={usdOf(stats.volume)} label="Volume" note="Paid to the API by us" />
          <Kpi value={count(stats.buyers)} label="Unique buyers" note="Wallets, plus Credits accounts" />
          <Kpi value={pct(stats.returningShare)} label="Came back" why="Buyers who paid on 2 or more days" />
          <Kpi value={stats.successRate === null ? '-' : pct(stats.successRate)} label="Answered 2xx" note={failedLine(stats.failedCalls)} />
          <Kpi value={stats.p50Ms === null ? '-' : ms(stats.p50Ms)} label="Median time" note={stats.p95Ms === null ? undefined : `p95 ${ms(stats.p95Ms)}`} />
        </div>
      </div>
      {service.exact ? null : <p className="small muted mt-8 svc-inexact">{inexactLine}</p>}
    </>
  );
};

/** How buyers paid: paid calls, the share with a meter, buyers, volume, and what a buyer spent on average. */
export const PaidWithTable = ({ service }: { readonly service: ServiceDetail }) => {
  const largest = Math.max(0, ...service.byPaidWith.map(way => way.share));

  return (
    <div className="mt-16">
      <DataTable label="By payment method" title="By payment method">
        <thead>
          <tr><th>Buyer paid with</th><th className="r">Paid calls</th><th>Share</th><th className="r">Buyers</th><th className="r">Volume</th><th className="r">Avg. per buyer</th></tr>
        </thead>
        <tbody>
          {service.byPaidWith.length === 0 ? (
            <tr><td colSpan={6} className="muted">No paid calls in this period.</td></tr>
          ) : service.byPaidWith.map(way => {
            const average = perBuyer(way.volume, way.buyers);

            return (
              <tr key={way.paidWith}>
                <td><Rail rail={way.paidWith} label={paidWithName(way.paidWith)} /></td>
                <td className="r">{count(way.calls)}</td>
                <td>
                  <span className="meter" aria-hidden="true">
                    <svg><rect className={way.paidWith === 'near' ? 'fill near' : 'fill'} x="0" y="0" width={`${(100 * meterShare(way.share, largest)).toFixed(1)}%`} height="6" rx="3" /></svg>
                  </span>
                  {' '}<span className="small muted num">{pct(way.share)}</span>
                </td>
                <td className="r">{count(way.buyers)}</td>
                <td className="r">{usdOf(way.volume)}</td>
                <td className="r">{average === null ? '-' : usd(average)}</td>
              </tr>
            );
          })}
        </tbody>
      </DataTable>
    </div>
  );
};

/** The five buyers that paid most. A Credits buyer is "A Credits account": no id, no name. A wallet is shortened, with its whole address as the title. */
export const TopBuyers = ({ service, now }: { readonly service: ServiceDetail; readonly now: number }) => (
  <div className="mt-16">
    <DataTable label="Top 5 buyers" title="Top 5 buyers" aside={service.topBuyers.buyers.length === 0 ? undefined : togetherLine(service.topBuyers.share)}>
      <thead>
        <tr><th>Buyer</th><th>Paid with</th><th className="r">Calls</th><th className="r">Spent</th><th>Last call</th></tr>
      </thead>
      <tbody>
        {service.topBuyers.buyers.length === 0 ? (
          <tr><td colSpan={5} className="muted">No buyers in this period.</td></tr>
        ) : service.topBuyers.buyers.map((buyer, index) => (
          <tr key={`${buyer.paidWith}-${buyer.payer ?? index}`}>
            <td>
              {buyer.paidWith === 'credits' || buyer.payer === null
                ? <span className="small muted">{buyer.paidWith === 'credits' ? 'A Credits account' : 'Unknown'}</span>
                : <span className="mono small buyer" title={buyer.payer}>{shortAddress(buyer.payer)}</span>}
            </td>
            <td><Rail rail={buyer.paidWith} /></td>
            <td className="r">{count(buyer.calls)}</td>
            <td className="r">{usdOf(buyer.spent)}</td>
            <td className="small muted">{lastCall(buyer.lastCallAt, now)}</td>
          </tr>
        ))}
      </tbody>
    </DataTable>
  </div>
);

/** The service's numbers could not be read. */
export const ServiceUnavailable = ({ code }: { readonly code?: string }) => (
  <div className="mt-32">
    <ErrorState title="We couldn't load this service's numbers." action={<Button variant="outline" size="sm" href="/services">Back to Services</Button>}>
      {code === 'stats_unavailable'
        ? 'These numbers can\'t be read right now. Reload the page in a moment.'
        : 'The Platform API didn\'t answer. Reload the page in a moment.'}
    </ErrorState>
  </div>
);
