import { Gauge, type Registry } from '@prometheus-io/client';

import type { Clock } from '@anyfare/common';
import {
  buildLiveBase, buildPlatformAll, buildPlatformRecent, buildServicePage, buildServiceRow, buildStoredEndpoint, buildTopAnswer, emptyTopAnswer,
  endpointDailyDays, endpointNumbersOf, periodBefore, periodStart, recentPeriods, utcDayStart, type PlatformConfig, type ServicesTotals,
} from '@anyfare/core';
import type { CountKind, StatsCounter, StatsRepository } from '@anyfare/db';

// The public numbers, in two counts with locks of their own: today, 7 and 30 days every few minutes, and
// all time less often, so a slow all-time count never holds the others back. Each reads by bounded,
// ranked statements, one at a time, each in a short transaction of its own, and writes only what changed.

export const publicStatsLockId = 7_301_746_212;
export const publicStatsJobName = 'public_stats';
export const publicStatsAllLockId = 7_301_746_213;
export const publicStatsAllJobName = 'public_stats_all';

// Each statement gives up after these, waiting on a lock included
export const recentStatementTimeoutMs = 30_000;
export const allStatementTimeoutMs = 120_000;
// A run stops after these, cleanly, and the next one starts fresh
export const recentBudgetMs = 4 * 60_000;
export const allBudgetMs = 20 * 60_000;
// The services a statement counts together
export const servicesPerBatch = 20;
// Today's buyers kept to tell the live numbers' new ones apart
export const keptBuyersPerDay = 100_000;
// Rows a delete takes at a time
const deleteBatch = 1_000;
const dayMs = 86_400_000;

export const publicStatsIntervalMs = (config: Pick<PlatformConfig, 'stats'>): number => config.stats.intervalSeconds * 1_000;
export const publicStatsAllIntervalMs = (config: Pick<PlatformConfig, 'stats'>): number => config.stats.allIntervalSeconds * 1_000;

/** A run reached its time budget: it stopped between two statements, and what it wrote stays true for its own time. */
export class PublicStatsBudgetError extends Error {
  constructor(readonly result: Readonly<Record<string, number>>) {
    super('A count of the public numbers stopped at its time budget');
  }
}

export interface PublicStatsMetrics {
  /** A count of this kind completed, counting to `countedAt`. */
  counted(kind: CountKind, countedAt: Date): void;
}

/** `workers_public_stats_age_seconds`: how old each kind of count this process completed is. Since the epoch before its first. */
export const createPublicStatsMetrics = (registry: Registry, clock: Clock): PublicStatsMetrics => {
  const last: Record<CountKind, number> = { recent: 0, all: 0 };
  new Gauge({
    name: 'workers_public_stats_age_seconds',
    help: 'How old the public numbers this process last counted are, by kind: recent (today, 7 and 30 days) and all (all time)',
    labelNames: ['count'] as const,
    registers: [registry],
    collect() {
      for (const kind of ['recent', 'all'] as const)
        this.set({ count: kind }, Math.max(0, (clock.now().getTime() - last[kind]) / 1_000));
    },
  });

  return { counted: (kind, countedAt) => {
    last[kind] = countedAt.getTime();
  } };
};

export interface PublicStatsOptions {
  readonly counter: StatsCounter;
  readonly store: StatsRepository;
  // The services cap
  readonly config: Pick<PlatformConfig, 'stats'>;
  readonly metrics: PublicStatsMetrics;
  readonly clock: Clock;
  readonly timeoutMs?: number;
  readonly budgetMs?: number;
  readonly batchSize?: number;
}

/** A budget of time for one run: each statement gets the lesser of its timeout and what is left. */
const startBudget = (budgetMs: number, timeoutMs: number, result: () => Readonly<Record<string, number>>) => {
  const deadline = performance.now() + budgetMs;

  return (): number => {
    const left = Math.floor(deadline - performance.now());
    if (left <= 0)
      throw new PublicStatsBudgetError(result());

    return Math.min(timeoutMs, left);
  };
};

const batchesOf = <TItem>(items: readonly TItem[], size: number): TItem[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));

export interface PublicStatsResult {
  // Services with pages of their own
  readonly services: number;
  // Rows written because their numbers changed, and rows deleted because they left the set
  readonly written: number;
  readonly deleted: number;
}

/**
 * The frequent count: the platform's numbers of today, 7 and 30 days, the top lists, the totals, the live
 * numbers' base, then the services with the most paid calls over 30 days, at most the configured number,
 * a batch at a time, each with at most 100 endpoints, and last the rows of services that left the set.
 */
export const createRecentStats = ({
  counter, store, config, metrics, clock, timeoutMs = recentStatementTimeoutMs, budgetMs = recentBudgetMs, batchSize = servicesPerBatch,
}: PublicStatsOptions) => async (): Promise<PublicStatsResult> => {
  const countedAt = clock.now();
  const to = countedAt;
  const today = utcDayStart(countedAt);
  const periods = recentPeriods.map(period => ({ period, from: periodStart(period, countedAt) }));
  const monthFrom = periodStart('30d', countedAt)!;
  let services = 0;
  let written = 0;
  let deleted = 0;
  const left = startBudget(budgetMs, timeoutMs, () => ({ services, written, deleted }));

  const platform = await counter.platform({ periods, to, timeoutMs: left() });
  const daily = await counter.platformDays({ from: monthFrom, to, timeoutMs: left() });
  const topups = await counter.topups({ periods, to, timeoutMs: left() });
  const top = await counter.top({ periods, to, timeoutMs: left() });
  const minutes = await counter.minutes({ from: new Date(to.getTime() - 2 * dayMs), to, timeoutMs: left() });
  const kept = await counter.keepBuyers({ day: today.toISOString().slice(0, 10), from: today, to, cap: keptBuyersPerDay, timeoutMs: left() });
  const ranking = await counter.ranking({ from: monthFrom, to, limit: config.stats.maxServices, timeoutMs: left() });
  const totals: ServicesTotals = { services: ranking.totals.services, paidEndpoints: ranking.totals.paidEndpoints, calls30d: ranking.totals.calls };
  await store.putAnswers({
    answers: [
      { key: 'platform', answer: buildPlatformRecent({ periods: platform, daily, topups: topups['30d'] ?? [], now: countedAt }) },
      ...recentPeriods.map(period => ({ key: `top:${period}`, answer: buildTopAnswer(top[period] ?? emptyTopAnswer, platform[period]?.ways ?? [], topups[period] ?? []) })),
      { key: 'services', answer: totals },
      { key: 'live', answer: buildLiveBase({ now: countedAt, today: platform.today, buyersKept: kept, minutes }) },
    ],
    countedAt,
    timeoutMs: left(),
  });

  for (const batch of batchesOf(ranking.services, batchSize)) {
    const hostHashes = batch.map(service => service.hostHash);
    const scope = { hostHashes, to };
    const counted = await counter.services({ scope, periods, timeoutMs: left() });
    const endpoints = await counter.endpoints({
      scope, periods, rankBy: '30d', dailyFrom: new Date(today.getTime() - (endpointDailyDays - 1) * dayMs), timeoutMs: left(),
    });
    const days = await counter.serviceDays({ scope: { ...scope, from: monthFrom }, timeoutMs: left() });
    const before = await counter.callsIn({ scope, windows: recentPeriods.map(period => ({ period, ...periodBefore(period, countedAt) })), timeoutMs: left() });
    const prices = await counter.priceFrom({ hosts: batch.map(service => service.host), from: monthFrom, to, timeoutMs: left() });

    const rows = batch.map(service => buildServiceRow({
      hostHash: service.hostHash, host: service.host, month: counted.counts.find(row => row.hostHash === service.hostHash && row.period === '30d'),
      priceFrom: prices.get(service.hostHash), daily: days.filter(day => day.hostHash === service.hostHash), now: countedAt,
    }));
    const pages = batch.flatMap(service => recentPeriods.map(period => ({
      hostHash: service.hostHash,
      period,
      answer: buildServicePage({
        host: service.host, period, counts: counted.counts.find(row => row.hostHash === service.hostHash && row.period === period),
        callsBefore: before.find(row => row.hostHash === service.hostHash && row.period === period)?.calls ?? 0,
        daily: days.filter(day => day.hostHash === service.hostHash), now: countedAt,
      }),
    })));
    written += await store.putServices({ rows, countedAt, timeoutMs: left() });
    written += await store.putServicePages({ pages, countedAt, timeoutMs: left() });
    const stored = await store.putEndpoints({ hostHashes, endpoints: endpoints.map(endpoint => buildStoredEndpoint(endpoint, countedAt)), countedAt, timeoutMs: left() });
    written += stored.written;
    deleted += stored.deleted;
    services += batch.length;
  }

  deleted += await store.dropOutside({ hostHashes: ranking.services.map(service => service.hostHash), batch: deleteBatch, timeoutMs: left() });
  await store.markComplete({ kind: 'recent', countedAt, timeoutMs: left() });
  metrics.counted('recent', countedAt);

  return { services, written, deleted };
};

/**
 * The all-time count: the platform's numbers and top lists of all time, then each stored service's page
 * of all time and its stored endpoints' numbers, a batch at a time. It reads every finished call, so it
 * runs less often and may take longer.
 */
export const createAllStats = ({
  counter, store, metrics, clock, timeoutMs = allStatementTimeoutMs, budgetMs = allBudgetMs, batchSize = servicesPerBatch,
}: PublicStatsOptions) => async (): Promise<PublicStatsResult> => {
  const countedAt = clock.now();
  const to = countedAt;
  const periods = [{ period: 'all' as const, from: undefined }];
  const monthFrom = periodStart('30d', countedAt)!;
  let services = 0;
  let written = 0;
  const left = startBudget(budgetMs, timeoutMs, () => ({ services, written, deleted: 0 }));

  const platform = await counter.platform({ periods, to, timeoutMs: left() });
  const topups = await counter.topups({ periods, to, timeoutMs: left() });
  const top = await counter.top({ periods, to, timeoutMs: left() });
  await store.putAnswers({
    answers: [
      { key: 'platform:all', answer: buildPlatformAll(platform.all, topups.all ?? []) },
      { key: 'top:all', answer: buildTopAnswer(top.all ?? emptyTopAnswer, platform.all?.ways ?? [], topups.all ?? []) },
    ],
    countedAt,
    timeoutMs: left(),
  });

  for (const batch of batchesOf(await store.storedServices({ timeoutMs: left() }), batchSize)) {
    const hostHashes = batch.map(service => service.hostHash);
    const scope = { hostHashes, to };
    const counted = await counter.services({ scope, periods, timeoutMs: left() });
    const days = await counter.serviceDays({ scope: { ...scope, from: monthFrom }, timeoutMs: left() });
    const only = await store.storedEndpointKeys({ hostHashes, timeoutMs: left() });
    const endpoints = only.length === 0 ? [] : await counter.endpoints({ scope, periods, rankBy: 'all', only, dailyFrom: to, timeoutMs: left() });
    const pages = batch.map(service => ({
      hostHash: service.hostHash,
      period: 'all' as const,
      answer: buildServicePage({
        host: service.host, period: 'all', counts: counted.counts.find(row => row.hostHash === service.hostHash), callsBefore: undefined,
        daily: days.filter(day => day.hostHash === service.hostHash), now: countedAt,
      }),
    }));
    written += await store.putServicePages({ pages, countedAt, timeoutMs: left() });
    written += await store.putEndpointsAll({
      numbers: endpoints.map(endpoint => ({ hostHash: endpoint.hostHash, pathHash: endpoint.pathHash, all: endpointNumbersOf(endpoint.periods.all) })),
      countedAt,
      timeoutMs: left(),
    });
    services += batch.length;
  }

  await store.markComplete({ kind: 'all', countedAt, timeoutMs: left() });
  metrics.counted('all', countedAt);

  return { services, written, deleted: 0 };
};
