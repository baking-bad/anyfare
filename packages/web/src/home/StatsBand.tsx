'use client';

import Link from 'next/link';
import { useState } from 'react';

import type { Period, Stats } from '../api/types';
import { BarChart } from '../components/BarChart';
import { BarList } from '../components/BarList';
import { EmptyState } from '../components/EmptyState';
import { ErrorState } from '../components/ErrorState';
import { Rail } from '../components/Rail';
import { Segmented } from '../components/Segmented';
import { Stat } from '../components/Stat';
import { paidWithName, statsText } from '../content/home';
import { count, usdOf } from '../format';
import { withAllTimeAtLeast30Days } from './allTime';

const periods: readonly { readonly value: Period; readonly label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: 'all', label: 'All' },
];

// "2026-11-11" as "11-11"
const shortDay = (day: string): string => day.slice(5);

/**
 * The stats band: four numbers for the chosen period, paid calls per day, and how buyers paid. The one
 * answer of `GET /v1/stats` holds all four periods, so the switch makes no request. `stats` is null when
 * that read failed: the band keeps its title and shows an error where the numbers go.
 */
export const StatsBand = ({ stats: counted }: { readonly stats: Stats | null }) => {
  const stats = counted === null ? null : withAllTimeAtLeast30Days(counted);
  const [period, setPeriod] = useState<Period>('30d');
  const paidWith = [...stats?.byPaidWith['30d'] ?? []].sort((a, b) => b.calls - a.calls);

  return (
    <section className="inverse-band" id="stats">
      <div className="container section">
        <div className="section-head row-head stats-head">
          <div className="stack stats-intro"><h2 className="h2">{statsText.heading}</h2><p className="lead muted">{statsText.lead}</p></div>
          <div className="row"><Segmented options={periods} value={period} onChange={setPeriod} label="Period" onDark /></div>
        </div>
        {stats === null ? (
          <ErrorState title="The stats didn't load">The Platform API didn&apos;t answer. Reload the page in a moment.</ErrorState>
        ) : (
          <>
            <div className="stat-grid">
              <Stat value={count(stats.calls[period])} label={statsText.calls.label} note={statsText.calls.note} />
              <Stat value={usdOf(stats.volume[period])} label={statsText.volume.label} note={statsText.volume.note} />
              <Stat value={count(stats.buyers[period])} label={statsText.buyers.label} note={statsText.buyers.note} />
              <Stat value={count(stats.services[period])} label={statsText.services.label} note={statsText.services.note} />
            </div>
            <div className="split mt-48 stats-panels">
              <div className="dark-panel stats-panel">
                <div className="row-between"><span className="semi small">Paid calls per day, 30 days</span><span className="xs muted">UTC days</span></div>
                <div className="mt-16">
                  <BarChart
                    height={180}
                    label="Paid calls per day"
                    data={stats.daily.map((day, index) => ({
                      value: day.calls,
                      label: day.day,
                      ...index % 7 === 0 || index === stats.daily.length - 1 ? { tick: shortDay(day.day) } : {},
                    }))}
                  />
                </div>
              </div>
              <div className="dark-panel stats-panel">
                <div className="row-between"><span className="semi small">How buyers paid, 30 days</span><Link className="xs stats-link" href="/calls#top">Details</Link></div>
                <div className="mt-16">
                  {paidWith.length === 0
                    ? <EmptyState icon="activity" title="No paid calls yet">How buyers paid shows here once calls are paid.</EmptyState>
                    : <BarList items={paidWith.map(share => ({ label: <Rail rail={share.paidWith} label={paidWithName(share.paidWith)} />, value: share.calls, tone: share.paidWith === 'near' ? 'near' : 'dim' }))} />}
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </section>
  );
};
