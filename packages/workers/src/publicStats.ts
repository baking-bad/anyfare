import { Gauge, type Registry } from '@prometheus-io/client';

import type { Clock } from '@anyfare/common';
import {
  buildLiveBase, buildPlatformAll, buildPlatformRecent, buildServicePage, buildServiceRow, buildStoredEndpoint, buildTopAnswer, emptyTopAnswer,
  endpointDailyDays, endpointNumbersOf, periodBefore, periodStart, recentPeriods, utcDayStart, type PlatformConfig, type ServicesTotals,
} from '@anyfare/core';
import type { CountKind, StatsCounter, StatsRepository } from '@anyfare/db';

import { RunStoppedError } from './scheduler.js';

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
// A run stops after these, between two statements; the frequent count's next run goes on from there
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
  constructor(readonly result: Readonly<Record<string, number>>, options?: ErrorOptions) {
    super('A count of the public numbers stopped at its time budget: the next run goes on from where it stopped', options);
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

// Postgres cancelled the statement: its timeout passed
const isCancelled = (error: unknown): boolean => {
  const codes = (value: unknown): unknown[] => (value instanceof Error ? [(value as Error & { code?: unknown }).code, ...codes(value.cause)] : []);

  return codes(error).includes('57014');
};

/**
 * One run's steps: each gets the lesser of the statement timeout and the run's budget left. Past the
 * budget, or once the workers stop, the run ends between two steps; a statement the budget cut short
 * ends it as the budget's error too, with the counts it reached.
 */
const startSteps = (input: {
  readonly budgetMs: number;
  readonly timeoutMs: number;
  readonly stopping: AbortSignal | undefined;
  readonly result: () => Readonly<Record<string, number>>;
}) => {
  const deadline = performance.now() + input.budgetMs;

  return async <TResult>(step: (timeoutMs: number) => Promise<TResult>): Promise<TResult> => {
    if (input.stopping?.aborted)
      throw new RunStoppedError(input.result());
    const left = Math.floor(deadline - performance.now());
    if (left <= 0)
      throw new PublicStatsBudgetError(input.result());
    const timeoutMs = Math.min(input.timeoutMs, left);
    try {
      return await step(timeoutMs);
    }
    catch (error) {
      if (timeoutMs < input.timeoutMs && isCancelled(error))
        throw new PublicStatsBudgetError(input.result(), { cause: error });
      throw error;
    }
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
 * The frequent count: the platform's numbers of today, 7 and 30 days, the top lists, the totals and the
 * live numbers' base, every run; then the services with the most paid calls over 30 days, at most the
 * configured number, a batch at a time, each with at most 100 endpoints. The services go in cycles: a run
 * that reaches its budget leaves a cursor, and the next goes on from it with the same services, so every
 * cycle completes. Only then are the rows of services that left the set deleted, and the count marked
 * complete as of the cycle's first run, which every row of it is true at least as of.
 */
export const createRecentStats = ({
  counter, store, config, metrics, clock, timeoutMs = recentStatementTimeoutMs, budgetMs = recentBudgetMs, batchSize = servicesPerBatch,
}: PublicStatsOptions) => async (stopping?: AbortSignal): Promise<PublicStatsResult> => {
  const countedAt = clock.now();
  const to = countedAt;
  const today = utcDayStart(countedAt);
  const periods = recentPeriods.map(period => ({ period, from: periodStart(period, countedAt) }));
  const monthFrom = periodStart('30d', countedAt)!;
  let services = 0;
  let written = 0;
  let deleted = 0;
  const step = startSteps({ budgetMs, timeoutMs, stopping, result: () => ({ services, written, deleted }) });

  const platform = await step(ms => counter.platform({ periods, to, timeoutMs: ms }));
  const daily = await step(ms => counter.platformDays({ from: monthFrom, to, timeoutMs: ms }));
  const topups = await step(ms => counter.topups({ periods, to, timeoutMs: ms }));
  const top = await step(ms => counter.top({ periods, to, timeoutMs: ms }));
  const minutes = await step(ms => counter.minutes({ from: new Date(to.getTime() - 2 * dayMs), to, timeoutMs: ms }));
  const kept = await step(ms => counter.keepBuyers({ day: today.toISOString().slice(0, 10), from: today, to, cap: keptBuyersPerDay, timeoutMs: ms }));
  const ranking = await step(ms => counter.ranking({ from: monthFrom, to, limit: config.stats.maxServices, timeoutMs: ms }));
  const totals: ServicesTotals = { services: ranking.totals.services, paidEndpoints: ranking.totals.paidEndpoints, calls30d: ranking.totals.calls };
  await step(ms => store.putAnswers({
    answers: [
      { key: 'platform', answer: buildPlatformRecent({ periods: platform, daily, topups: topups['30d'] ?? [], now: countedAt }) },
      ...recentPeriods.map(period => ({ key: `top:${period}`, answer: buildTopAnswer(top[period] ?? emptyTopAnswer, platform[period]?.ways ?? [], topups[period] ?? []) })),
      { key: 'services', answer: totals },
      { key: 'live', answer: buildLiveBase({ now: countedAt, today: platform.today, buyersKept: kept, minutes }) },
    ],
    countedAt,
    timeoutMs: ms,
  }));

  // The cycle under way, or a new one of the services as ranked now
  const cycle = await step(ms => store.cycle({ timeoutMs: ms })) ?? await step(async ms => {
    const started = { startedAt: countedAt, services: ranking.services.map(({ hostHash, host }) => ({ hostHash, host })), next: 0 };
    await store.startCycle({ ...started, timeoutMs: ms });

    return started;
  });
  const remaining = cycle.services.slice(cycle.next);
  for (const [index, batch] of batchesOf(remaining, batchSize).entries()) {
    const hostHashes = batch.map(service => service.hostHash);
    const scope = { hostHashes, to };
    const counted = await step(ms => counter.services({ scope, periods, timeoutMs: ms }));
    const endpoints = await step(ms => counter.endpoints({
      scope, periods, rankBy: '30d', dailyFrom: new Date(today.getTime() - (endpointDailyDays - 1) * dayMs), timeoutMs: ms,
    }));
    const days = await step(ms => counter.serviceDays({ scope: { ...scope, from: monthFrom }, timeoutMs: ms }));
    const before = await step(ms => counter.callsIn({ scope, windows: recentPeriods.map(period => ({ period, ...periodBefore(period, countedAt) })), timeoutMs: ms }));
    const prices = await step(ms => counter.priceFrom({ hostHashes, from: monthFrom, to, timeoutMs: ms }));
    const listed = await step(ms => counter.listedAt({ hosts: batch.map(service => service.host), timeoutMs: ms }));

    const rows = batch.map(service => buildServiceRow({
      hostHash: service.hostHash, host: service.host, month: counted.counts.find(row => row.hostHash === service.hostHash && row.period === '30d'),
      priceFrom: prices.get(service.hostHash), daily: days.filter(day => day.hostHash === service.hostHash), now: countedAt,
      listedAt: listed.get(service.host),
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
    written += await step(ms => store.putServices({ rows, countedAt, timeoutMs: ms }));
    written += await step(ms => store.putServicePages({ pages, countedAt, timeoutMs: ms }));
    const stored = await step(ms => store.putEndpoints({ hostHashes, endpoints: endpoints.map(endpoint => buildStoredEndpoint(endpoint, countedAt)), countedAt, timeoutMs: ms }));
    written += stored.written;
    deleted += stored.deleted;
    services += batch.length;
    await step(ms => store.advanceCycle({ next: cycle.next + Math.min(remaining.length, (index + 1) * batchSize), timeoutMs: ms }));
  }

  deleted += await step(ms => store.dropOutside({ hostHashes: cycle.services.map(service => service.hostHash), batch: deleteBatch, timeoutMs: ms }));
  await step(ms => store.markComplete({ kind: 'recent', countedAt: cycle.startedAt, timeoutMs: ms }));
  await step(ms => store.endCycle({ timeoutMs: ms }));
  metrics.counted('recent', cycle.startedAt);

  return { services, written, deleted };
};

/**
 * The all-time count: the platform's numbers and top lists of all time, then each stored service's page
 * of all time and its stored endpoints' numbers, a batch at a time. It reads every finished call, so it
 * runs less often and may take longer.
 */
export const createAllStats = ({
  counter, store, metrics, clock, timeoutMs = allStatementTimeoutMs, budgetMs = allBudgetMs, batchSize = servicesPerBatch,
}: PublicStatsOptions) => async (stopping?: AbortSignal): Promise<PublicStatsResult> => {
  const countedAt = clock.now();
  const to = countedAt;
  const periods = [{ period: 'all' as const, from: undefined }];
  const monthFrom = periodStart('30d', countedAt)!;
  let services = 0;
  let written = 0;
  const step = startSteps({ budgetMs, timeoutMs, stopping, result: () => ({ services, written, deleted: 0 }) });

  const platform = await step(ms => counter.platform({ periods, to, timeoutMs: ms }));
  const topups = await step(ms => counter.topups({ periods, to, timeoutMs: ms }));
  const top = await step(ms => counter.top({ periods, to, timeoutMs: ms }));
  await step(ms => store.putAnswers({
    answers: [
      { key: 'platform:all', answer: buildPlatformAll(platform.all, topups.all ?? []) },
      { key: 'top:all', answer: buildTopAnswer(top.all ?? emptyTopAnswer, platform.all?.ways ?? [], topups.all ?? []) },
    ],
    countedAt,
    timeoutMs: ms,
  }));

  for (const batch of batchesOf(await step(ms => store.storedServices({ timeoutMs: ms })), batchSize)) {
    const hostHashes = batch.map(service => service.hostHash);
    const scope = { hostHashes, to };
    const counted = await step(ms => counter.services({ scope, periods, timeoutMs: ms }));
    const days = await step(ms => counter.serviceDays({ scope: { ...scope, from: monthFrom }, timeoutMs: ms }));
    const only = await step(ms => store.storedEndpointKeys({ hostHashes, timeoutMs: ms }));
    const endpoints = only.length === 0 ? [] : await step(ms => counter.endpoints({ scope, periods, rankBy: 'all', only, dailyFrom: to, timeoutMs: ms }));
    const pages = batch.map(service => ({
      hostHash: service.hostHash,
      period: 'all' as const,
      answer: buildServicePage({
        host: service.host, period: 'all', counts: counted.counts.find(row => row.hostHash === service.hostHash), callsBefore: undefined,
        daily: days.filter(day => day.hostHash === service.hostHash), now: countedAt,
      }),
    }));
    written += await step(ms => store.putServicePages({ pages, countedAt, timeoutMs: ms }));
    written += await step(ms => store.putEndpointsAll({
      numbers: endpoints.map(endpoint => ({ hostHash: endpoint.hostHash, pathHash: endpoint.pathHash, all: endpointNumbersOf(endpoint.periods.all) })),
      countedAt,
      timeoutMs: ms,
    }));
    services += batch.length;
  }

  await step(ms => store.markComplete({ kind: 'all', countedAt, timeoutMs: ms }));
  metrics.counted('all', countedAt);

  return { services, written, deleted: 0 };
};
