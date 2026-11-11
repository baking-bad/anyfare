'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { getTopStats } from '../api/endpoints';
import { createReader, type ApiResult } from '../api/reader';
import type { Period, TopStats } from '../api/types';
import { BarList } from '../components/BarList';
import { Card, CardHead } from '../components/Card';
import { EmptyState } from '../components/EmptyState';
import { ErrorState } from '../components/ErrorState';
import { Rail } from '../components/Rail';
import { Segmented } from '../components/Segmented';
import { useSettings } from '../components/Settings';
import { Skeleton } from '../components/Skeleton';
import { paidWithName } from '../content/home';
import { count } from '../format';
import { topPeriods, tokenName } from './content';

const TopItem = ({ rank, href, label, sub, value }: { readonly rank: number; readonly href: string; readonly label: ReactNode; readonly sub?: ReactNode; readonly value: number }) => (
  <Link className="item" href={href} prefetch={false}>
    <span className="rank">{rank}</span>
    <span className="ellipsis">{label}{sub === undefined ? null : <> {sub}</>}</span>
    <span className="num semi">{count(value)}</span>
  </Link>
);

const Empty = ({ children }: { readonly children: ReactNode }) => <EmptyState icon="activity" title={children as string} />;

const Lists = ({ top }: { readonly top: TopStats }) => {
  const paid = [...top.paidWith].sort((a, b) => b.calls - a.calls);

  return (
    <>
      <Card>
        <CardHead title="Services"><span className="xs muted">Paid calls</span></CardHead>
        <div className="top-list">
          {top.services.length === 0 ? <Empty>No paid calls yet</Empty> : top.services.map((service, index) => (
            <TopItem key={service.host} rank={index + 1} href={`/services/${service.host}`} label={service.host} value={service.calls} />
          ))}
        </div>
      </Card>
      <Card>
        <CardHead title="Endpoints"><span className="xs muted">Paid calls</span></CardHead>
        <div className="top-list">
          {top.endpoints.length === 0 ? <Empty>No paid calls yet</Empty> : top.endpoints.map((endpoint, index) => (
            <TopItem
              key={`${endpoint.host}${endpoint.path}`}
              rank={index + 1}
              href={`/check?url=${endpoint.host}${endpoint.path}`}
              label={<span className="mono top-path">{endpoint.path}</span>}
              sub={<span className="xs muted">{endpoint.host}</span>}
              value={endpoint.calls}
            />
          ))}
        </div>
      </Card>
      <Card>
        <CardHead title="How buyers paid"><span className="xs muted">Paid calls</span></CardHead>
        {paid.length === 0
          ? <Empty>No paid calls yet</Empty>
          : <BarList items={paid.map(share => ({ label: <Rail rail={share.paidWith} label={paidWithName(share.paidWith)} />, value: share.calls, tone: share.paidWith === 'near' ? 'near' : 'dim' }))} />}
      </Card>
      <Card>
        <CardHead title="Top-up tokens"><span className="xs muted">Through NEAR Intents</span></CardHead>
        {top.topupTokens.length === 0
          ? <Empty>No top-ups yet</Empty>
          : <BarList items={top.topupTokens.map(token => ({ label: <Rail rail={token.network} label={tokenName(token.token, token.network)} />, value: token.count, tone: token.network === 'near' ? 'near' : 'dim' }))} />}
      </Card>
    </>
  );
};

/**
 * The Top 5 section: four lists for the chosen period. The server renders the first period; another one
 * is read from the API when it is chosen, and kept for the next time.
 */
export const TopFive = ({ top: first }: { readonly top: ApiResult<TopStats> }) => {
  const { apiUrl } = useSettings();
  const reader = useMemo(() => createReader({ apiUrl }), [apiUrl]);
  const [period, setPeriod] = useState<Period>('30d');
  const [results, setResults] = useState<Readonly<Partial<Record<Period, ApiResult<TopStats>>>>>({ '30d': first });
  const asked = useRef(new Set<Period>(['30d']));

  useEffect(() => {
    if (asked.current.has(period))
      return;
    asked.current.add(period);
    void getTopStats(reader, period).then(result => {
      if (!result.ok)
        asked.current.delete(period);
      setResults(current => ({ ...current, [period]: result }));
    });
  }, [period, reader]);

  const result = results[period];

  return (
    <section className="band" id="top">
      <div className="container ruled section">
        <div className="section-head row-head">
          <h2 className="h2">Top 5</h2>
          <Segmented options={topPeriods} value={period} onChange={setPeriod} label="Period" />
        </div>
        {result === undefined ? (
          <div className="top-grid" aria-busy="true">
            {[0, 1, 2, 3].map(card => <Card key={card}><Skeleton shape="title" width="sm" /><div className="mt-16"><Skeleton shape="block" /></div></Card>)}
          </div>
        ) : !result.ok ? (
          <ErrorState title="The top lists didn't load">The Platform API didn&apos;t answer. Choose the period again in a moment.</ErrorState>
        ) : (
          <div className="top-grid"><Lists top={result.value} /></div>
        )}
      </div>
    </section>
  );
};
