import { createHash } from 'node:crypto';

import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';

import type { MicroUsd } from '@anyfare/common';
import {
  endpointsPerService, maxListedHostLength, maxListedPathLength, storedPathBytesPerService, topListSize, utcDayStart, type CallCounts, type DayCounts, type EndpointCounts,
  type LiveTail, type PaidWithWay, type PlatformPeriodCounts, type ServicePeriodCounts, type StatsPeriod, type TopBuyerCounts, type TopCounts, type TopupCounts, type WayCounts,
} from '@anyfare/core';

import type { Database } from './postgres.js';
import { callDetails } from './schema/calls.js';
import { finishedCallStatuses, paidCallStatuses, statusIn } from './schema/callStatuses.js';
import { ledgerTransactions, payments } from './schema/ledger.js';
import { routedEndpoints } from './schema/routing.js';
import { statsBuyers } from './schema/stats.js';
import { topups } from './schema/topups.js';

// The statements that count the public numbers from the finished calls, the call details and the
// credited top-ups. Each runs alone in a short transaction of its own, read-only unless it writes, with
// its own statement timeout, so no count holds a snapshot or a connection past one statement. What
// comes back is bounded: ranked and cut in SQL, never a list of every host or path. Each reads its calls
// once and counts every period in that one pass, by filters: no statement joins one set of rows to
// another but by an index or a hash, so its cost grows with the calls it reads, not with their square.

/** A period, and when it starts: undefined for all time. */
export interface CountedPeriod {
  readonly period: StatsPeriod;
  readonly from: Date | undefined;
}

/** Which finished calls a statement reads, and by which index. */
export interface CallScope {
  // From `from`, to before `to`
  readonly from?: Date | undefined;
  readonly to?: Date | undefined;
  // Some hosts, by their md5: payments_calls_host_idx
  readonly hostHashes?: readonly string[];
  // One host and one path, exactly, by the index of `by`: payments_calls_host_idx or payments_calls_path_idx
  readonly endpoint?: { readonly host: string; readonly path: string; readonly by: 'host' | 'path' };
  // One host, exactly, by its md5: payments_calls_host_idx
  readonly host?: string;
  // The newest calls only, at most this many
  readonly cap?: number;
}

export interface StatsCounter {
  /** The platform's numbers of each period, with each way to pay. */
  platform(input: { readonly periods: readonly CountedPeriod[]; readonly to: Date; readonly timeoutMs: number }): Promise<Partial<Record<StatsPeriod, PlatformPeriodCounts>>>;
  /** The platform's paid calls per UTC day, from `from`. */
  platformDays(input: { readonly from: Date; readonly to: Date; readonly timeoutMs: number }): Promise<DayCounts[]>;
  /** Paid calls and their volume per minute, by the minute's start. */
  minutes(input: { readonly from: Date; readonly to: Date; readonly timeoutMs: number }): Promise<{ readonly minute: Date; readonly calls: number; readonly volume: MicroUsd }[]>;
  /** Each period's top services and endpoints by paid calls, of those that may be listed. */
  top(input: { readonly periods: readonly CountedPeriod[]; readonly to: Date; readonly timeoutMs: number }): Promise<Partial<Record<StatsPeriod, TopCounts>>>;
  /** Credited top-ups by network and token, per period of when they were credited. */
  topups(input: { readonly periods: readonly CountedPeriod[]; readonly to: Date; readonly timeoutMs: number }): Promise<Partial<Record<StatsPeriod, TopupCounts[]>>>;
  /**
   * The services with the most paid calls from `from`, at most `limit`, whose host may be listed, and the
   * totals over every service with a paid call then.
   */
  ranking(input: { readonly from: Date; readonly to: Date; readonly limit: number; readonly timeoutMs: number }): Promise<{
    readonly services: readonly { readonly hostHash: string; readonly host: string; readonly calls: number }[];
    readonly totals: { readonly services: number; readonly paidEndpoints: number; readonly calls: number };
  }>;
  /**
   * Keeps the md5 of each of `day`'s buyers to `to`, at most `cap`, and drops earlier days': the live
   * numbers count a buyer since then once. Returns how many it keeps for the day.
   */
  keepBuyers(input: { readonly day: string; readonly from: Date; readonly to: Date; readonly cap: number; readonly timeoutMs: number }): Promise<number>;
  /** Some services' numbers of each period, with each way to pay; `capped` when a capped scope had more calls. */
  services(input: { readonly scope: CallScope; readonly periods: readonly CountedPeriod[]; readonly timeoutMs: number }): Promise<{
    readonly counts: readonly (ServicePeriodCounts & { readonly hostHash: string; readonly period: StatsPeriod })[];
    readonly capped: boolean;
  }>;
  /**
   * The top endpoints of each service by paid calls of `rankBy`, of those whose path is at most
   * `maxPathLength` long: at most 100, and at most 24 KB of path text, with their numbers. `rankBy` is
   * one of `periods`.
   */
  endpoints(input: {
    readonly scope: CallScope;
    readonly periods: readonly CountedPeriod[];
    readonly rankBy: StatsPeriod;
    // Endpoints with a finished call count too, not only those with a paid one
    readonly withFree?: boolean;
    // Only these, of each host
    readonly only?: readonly { readonly hostHash: string; readonly pathHash: string }[];
    // Paid calls per day from this
    readonly dailyFrom: Date | undefined;
    // Default: the longest path the counts keep
    readonly maxPathLength?: number;
    readonly timeoutMs: number;
  }): Promise<EndpointCounts[]>;
  /** Some services' paid calls per UTC day, from the scope's start. */
  serviceDays(input: { readonly scope: CallScope; readonly timeoutMs: number }): Promise<(DayCounts & { readonly hostHash: string })[]>;
  /** Some services' paid calls in each window. */
  callsIn(input: {
    readonly scope: CallScope;
    readonly windows: readonly { readonly period: StatsPeriod; readonly from: Date; readonly to: Date }[];
    readonly timeoutMs: number;
  }): Promise<{ readonly hostHash: string; readonly period: StatsPeriod; readonly calls: number }[]>;
  /**
   * The cheapest last quote of each host's routed endpoints that may be listed and had a paid call from
   * `from`: the hosts' calls by the host index, each path's quote by the routed endpoints' key.
   */
  priceFrom(input: { readonly hostHashes: readonly string[]; readonly from: Date; readonly to: Date; readonly timeoutMs: number }): Promise<Map<string, MicroUsd>>;
  /**
   * When each host's first routed endpoint was listed: its first paid one by routed_endpoints_listed_idx, or the
   * first of its at most 20 checked ones. A host with none is left out.
   */
  listedAt(input: { readonly hosts: readonly string[]; readonly timeoutMs: number }): Promise<Map<string, Date>>;
  /** Whether a capped scope holds more calls than its cap. */
  isCapped(input: { readonly scope: CallScope; readonly timeoutMs: number }): Promise<boolean>;
  /** Whether the host has a paid call, ever: the first one the host index finds. */
  hasPaidCall(input: { readonly host: string; readonly timeoutMs: number }): Promise<boolean>;
  /**
   * The scope of one endpoint's newest calls from `from`, at most `cap`, by the narrower of the host's
   * index and the path's: the finished calls of the host, and of the path on any host, each counted up
   * to `cap` by its own index tell which. Undefined when either has none: the endpoint has no call then.
   */
  endpointScope(input: { readonly host: string; readonly path: string; readonly from: Date | undefined; readonly cap: number; readonly timeoutMs: number }): Promise<CallScope | undefined>;
  /**
   * The live numbers' tail: paid calls from `from`, the frequent count's time, to `at`, today's among them
   * with today's buyers counted once with the kept ones, and the calls per minute from `minutesFrom`. One
   * range of the calls index, from the earlier of the two.
   */
  liveTail(input: { readonly from: Date; readonly at: Date; readonly minutesFrom: Date; readonly timeoutMs: number }): Promise<LiveTail>;
}

const paid = statusIn(payments.status, paidCallStatuses);
const finished = statusIn(payments.status, finishedCallStatuses);
const optional = <TValue>(value: TValue | null): TValue | undefined => value ?? undefined;
const micro = (value: string | null): MicroUsd => BigInt(value ?? '0');
const roundedMs = (value: number | null): number | undefined => value === null ? undefined : Math.round(value);
const json = (value: unknown): SQL => sql`${JSON.stringify(value)}::jsonb`;
// As Postgres's md5 of text reckons it: of its UTF-8 bytes
const md5 = (text: string): string => createHash('md5').update(text, 'utf8').digest('hex');
const timeoutOf = (ms: number): SQL => sql.raw(`set local statement_timeout = ${Math.max(1, Math.trunc(ms))}`);

/** One statement in a transaction of its own, giving up after `timeoutMs`; read-only unless it writes. */
const run = async <TRow extends Record<string, unknown>>(db: Database, timeoutMs: number, query: SQL, writes = false): Promise<TRow[]> =>
  db.transaction(async tx => {
    // For this transaction only, so the connection goes back to the pool without it
    await tx.execute(timeoutOf(timeoutMs));

    return (await tx.execute<TRow>(query)).rows as TRow[];
  }, writes ? undefined : { accessMode: 'read only' });

// How a payment was paid: the platform config's name for its rail and network, else its network's ID,
// else its rail's name. Credits are always credits.
const paidWithOf = (ways: readonly PaidWithWay[]): SQL => sql`(case when ${payments.rail} = 'credits' then 'credits'${sql.join(
  ways.map(way => sql` when ${payments.rail} = ${way.rail} and ${payments.network} = ${way.network} then ${way.paidWith}::text`),
)} else coalesce(${payments.network}, ${payments.rail}) end)`;

// Who paid, only ever counted and never read out: a Credits buyer by its account, a chain payer by its
// address (an EVM one without case), and the chain payments whose payer isn't known as one buyer per network
const buyerOf = sql`(case when ${payments.rail} = 'credits' then 'account:' || md5(${payments.buyerAccountId})
  when ${callDetails.payer} is null then 'unknown:' || coalesce(${payments.network}, ${payments.rail})
  when ${callDetails.payer} ~ '^0x[0-9a-fA-F]{40}$' then 'payer:' || lower(${callDetails.payer})
  else 'payer:' || ${callDetails.payer} end)`;


/** What a scope carries of a call's host and path as text: none, or each when at most so long. */
interface ScopeText {
  readonly hostLength?: number;
  readonly pathLength?: number;
}

/**
 * Finished calls in a scope, with their details: by the calls index on their time, or the host or path
 * index for some hosts or one endpoint. The host and the path come as their md5 and their length, and
 * as text only when asked and short enough to be listed, so a long path costs a statement nothing. Never
 * an account, a key, a request ID, a receipt or a settle request: a chain payer's address only.
 */
const scopedCalls = (ways: readonly PaidWithWay[], scope: CallScope, { paidOnly = false, text = {} }: { readonly paidOnly?: boolean; readonly text?: ScopeText } = {}): SQL => {
  const where: SQL[] = [
    finished,
    ...scope.from === undefined ? [] : [sql`${payments.createdAt} >= ${scope.from}`],
    ...scope.to === undefined ? [] : [sql`${payments.createdAt} < ${scope.to}`],
    ...scope.hostHashes === undefined ? [] : [sql`md5(${payments.targetHost}) = any(array(select jsonb_array_elements_text(${json(scope.hostHashes)})))`],
    // The md5 for the index, the text against a collision. The md5 is reckoned here, so the planner sees its
    // value and the index's statistics for it.
    ...scope.host === undefined ? [] : [sql`md5(${payments.targetHost}) = ${md5(scope.host)}::text`, sql`${payments.targetHost} = ${scope.host}`],
    // One md5 only, the narrower's: the planner has no statistics of either, so the caller tells it which
    ...scope.endpoint === undefined ? [] : [
      scope.endpoint.by === 'host' ? sql`md5(${payments.targetHost}) = ${md5(scope.endpoint.host)}::text` : sql`md5(${payments.targetPath}) = ${md5(scope.endpoint.path)}::text`,
      sql`${payments.targetPath} = ${scope.endpoint.path}`, sql`${payments.targetHost} = ${scope.endpoint.host}`,
    ],
  ];
  const textOf = (column: SQLWrapper, limit: number | undefined, name: string): SQL => limit === undefined
    ? sql.raw(`null::text as ${name}`)
    : sql`case when length(${column}) <= ${limit} then ${column} end as ${sql.identifier(name)}`;
  const select = (filters: readonly SQL[]) => sql`select ${payments.id} as id, ${payments.createdAt} as at,
      md5(${payments.targetHost}) as host_hash, length(${payments.targetHost}) as host_length,
      md5(${payments.targetPath}) as path_hash, length(${payments.targetPath}) as path_length,
      ${textOf(payments.targetHost, text.hostLength, 'host')}, ${textOf(payments.targetPath, text.pathLength, 'path')},
      ${paidWithOf(ways)} as paid_with, ${paid} as paid, ${payments.amount} as amount,
      case when ${payments.upstreamStatus} is not null then ${payments.upstreamLatencyMs} end as ms,
      ${buyerOf} as buyer, case when ${payments.rail} = 'credits' then null else ${callDetails.payer} end as payer,
      ${callDetails.method} as method
    from ${payments} left join ${callDetails} on ${callDetails.paymentId} = ${payments.id}
    where ${sql.join([...filters], sql` and `)}`;

  // A capped scope is the newest finished calls, paid or not, so each statement of one read counts the same calls
  if (scope.cap !== undefined) {
    const newest = sql`${select(where)} order by ${payments.createdAt} desc, ${payments.id} desc limit ${scope.cap}`;

    return paidOnly ? sql`select * from (${newest}) as newest where newest.paid` : newest;
  }

  return select(paidOnly ? [...where, paid] : where);
};

// Whether a capped scope holds more calls than its cap: the first `cap + 1` of them, counted
const cappedOf = (ways: readonly PaidWithWay[], scope: CallScope): SQL => scope.cap === undefined
  ? sql`false`
  : sql`((select count(*) from (${scopedCalls(ways, { ...scope, cap: scope.cap + 1 })}) as newest) > ${scope.cap})`;

// A call in a period: from its start, or any call for all time
const within = (from: Date | undefined): SQL => (from === undefined ? sql`true` : sql`at >= ${from}`);
const named = (name: string, index: number): SQL => sql`${sql.identifier(`${name}_${index}`)}`;

// The numbers of a group of calls, for each period, in one pass
const numbersOf = (periods: readonly CountedPeriod[]): SQL => sql.join(periods.map(({ from }, index) => sql`
  (count(*) filter (where paid and ${within(from)}))::int as ${named('calls', index)},
  coalesce(sum(amount) filter (where paid and ${within(from)}), 0)::text as ${named('volume', index)},
  (count(distinct buyer) filter (where paid and ${within(from)}))::int as ${named('buyers', index)},
  (count(*) filter (where not paid and ${within(from)}))::int as ${named('free', index)},
  percentile_cont(0.5) within group (order by ms) filter (where ${within(from)}) as ${named('p50', index)},
  percentile_cont(0.95) within group (order by ms) filter (where ${within(from)}) as ${named('p95', index)}`), sql`,`);

type Row = Readonly<Record<string, unknown>>;

const numberOf = (row: Row, name: string, index: number): number => Number(row[`${name}_${index}`] ?? 0);
const countsAt = (row: Row, index: number): CallCounts => ({
  calls: numberOf(row, 'calls', index),
  volume: micro((row[`volume_${index}`] as string | null) ?? null),
  buyers: numberOf(row, 'buyers', index),
  free: numberOf(row, 'free', index),
  p50Ms: roundedMs((row[`p50_${index}`] as number | null) ?? null),
  p95Ms: roundedMs((row[`p95_${index}`] as number | null) ?? null),
});
const waysAt = (rows: readonly Row[], index: number): WayCounts[] => rows.map(row => ({
  paidWith: String(row['paid_with']), calls: numberOf(row, 'calls', index), volume: micro((row[`volume_${index}`] as string | null) ?? null), buyers: numberOf(row, 'buyers', index),
}));
const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export interface StatsCounterOptions {
  readonly db: Database;
  // How each rail on each known network was paid
  readonly ways: readonly PaidWithWay[];
}

export const createStatsCounter = ({ db, ways }: StatsCounterOptions): StatsCounter => {
  const calls = (scope: CallScope, options?: { readonly paidOnly?: boolean; readonly text?: ScopeText }) => scopedCalls(ways, scope, options);
  // The earliest start of these periods, or none when one is all time
  const earliest = (periods: readonly CountedPeriod[]): Date | undefined =>
    periods.some(period => period.from === undefined) ? undefined : new Date(Math.min(...periods.map(period => period.from!.getTime())));

  return {
    platform: async ({ periods, to, timeoutMs }) => {
      const rows = await run<Row>(db, timeoutMs, sql`with calls as (${calls({ from: earliest(periods), to })})
        select grouping(paid_with)::int as by_way, paid_with, ${numbersOf(periods)},
          ${sql.join(periods.map(({ from }, index) => sql`(count(distinct host_hash) filter (where paid and ${within(from)}))::int as ${named('services', index)}`), sql`, `)}
        from calls group by grouping sets ((), (paid_with))`);
      const total = rows.find(row => row['by_way'] === 1);
      const byWay = rows.filter(row => row['by_way'] === 0);

      return Object.fromEntries(total === undefined ? [] : periods.map(({ period }, index) => [period, {
        ...countsAt(total, index), services: numberOf(total, 'services', index), ways: waysAt(byWay, index),
      }]));
    },

    platformDays: async ({ from, to, timeoutMs }) => {
      const rows = await run<{ day: string; calls: number; volume: string; buyers: number }>(db, timeoutMs, sql`with calls as (${calls({ from, to }, { paidOnly: true })})
        select to_char(at at time zone 'UTC', 'YYYY-MM-DD') as day, count(*)::int as calls, sum(amount)::text as volume, (count(distinct buyer))::int as buyers
        from calls group by 1`);

      return rows.map(row => ({ day: row.day, calls: row.calls, volume: micro(row.volume), buyers: row.buyers }));
    },

    minutes: async ({ from, to, timeoutMs }) => {
      const rows = await run<{ minute: string; calls: number; volume: string }>(db, timeoutMs, sql`with calls as (${calls({ from, to }, { paidOnly: true })})
        select (floor(extract(epoch from at) / 60) * 60000)::bigint::text as minute, count(*)::int as calls, sum(amount)::text as volume
        from calls group by 1`);

      return rows.map(row => ({ minute: new Date(Number(row.minute)), calls: row.calls, volume: micro(row.volume) }));
    },

    top: async ({ periods, to, timeoutMs }) => {
      // Each endpoint's paid calls per period in one pass, with the text of those that may be listed; each
      // service's from its endpoints'; then the top of each period, ranked by the md5 on a tie
      const counts = sql.join(periods.map(({ from }, index) => sql`(count(*) filter (where ${within(from)}))::int as ${named('calls', index)}`), sql`, `);
      const sums = sql.join(periods.map((_, index) => sql`sum(${named('calls', index)})::int as ${named('calls', index)}`), sql`, `);
      const tops = periods.flatMap((_, index) => [
        sql`select 'service' as kind, ${index}::int as period, host, null::text as path, calls from (
          select host, ${named('calls', index)} as calls, row_number() over (order by ${named('calls', index)} desc, host_hash) as rank
          from hosts where host is not null and ${named('calls', index)} > 0
        ) as ranked where rank <= ${topListSize}`,
        sql`select 'endpoint', ${index}::int, host, path, calls from (
          select host, path, ${named('calls', index)} as calls, row_number() over (order by ${named('calls', index)} desc, host_hash, path_hash) as rank
          from paths where host is not null and path is not null and ${named('calls', index)} > 0
        ) as ranked where rank <= ${topListSize}`,
      ]);
      const rows = await run<{ kind: 'service' | 'endpoint'; period: number; host: string; path: string | null; calls: number }>(db, timeoutMs, sql`
        with paths as (
          select host_hash, path_hash, min(host) as host, min(path) as path, ${counts}
          from (${calls({ from: earliest(periods), to }, { paidOnly: true, text: { hostLength: maxListedHostLength, pathLength: maxListedPathLength } })}) as calls
          group by host_hash, path_hash
        ),
        hosts as (select host_hash, min(host) as host, ${sums} from paths group by host_hash)
        ${sql.join(tops, sql` union all `)}`);
      const byCalls = <TItem extends { calls: number }>(name: (item: TItem) => string) => (a: TItem, b: TItem) => b.calls - a.calls || compareText(name(a), name(b));

      return Object.fromEntries(periods.map(({ period }, index) => [period, {
        services: rows.filter(row => row.kind === 'service' && row.period === index).map(row => ({ host: row.host, calls: row.calls })).sort(byCalls(row => row.host)),
        endpoints: rows.filter(row => row.kind === 'endpoint' && row.period === index).map(row => ({ host: row.host, path: row.path!, calls: row.calls }))
          .sort(byCalls(row => `${row.host} ${row.path}`)),
      }]));
    },

    topups: async ({ periods, to, timeoutMs }) => {
      // The credits by the ledger's operation index, then each one's top-up by its deposit address, which names one
      const rows = await run<Row>(db, timeoutMs, sql`
        select credited.network, credited.token,
          ${sql.join(periods.map(({ from }, index) => sql`(count(*) filter (where ${from === undefined ? sql`true` : sql`${ledgerTransactions.createdAt} >= ${from}`}))::int
            as ${named('count', index)}, coalesce(sum(credited.amount) filter (where ${from === undefined ? sql`true` : sql`${ledgerTransactions.createdAt} >= ${from}`}), 0)::text
            as ${named('amount', index)}`), sql`, `)}
        from ${ledgerTransactions} cross join lateral (
          select ${topups.network} as network, ${topups.tokenSymbol} as token, ${topups.creditedAmount} as amount
          from ${topups}
          where ${topups.depositAddress} is not null and ${topups.depositAddress} = ${ledgerTransactions.reference}
            and ${topups.ledgerTransactionId} = ${ledgerTransactions.id} and ${topups.status} = 'credited'
          limit 1
        ) as credited
        where ${ledgerTransactions.operation} = 'top_up' and ${ledgerTransactions.createdAt} < ${to}
        group by credited.network, credited.token
        order by count(*) desc limit 1000`);

      return Object.fromEntries(periods.map(({ period }, index) => [period, rows.filter(row => numberOf(row, 'count', index) > 0).map(row => ({
        network: String(row['network']), token: String(row['token']), count: numberOf(row, 'count', index), amount: micro(row[`amount_${index}`] as string),
      }))]));
    },

    ranking: async ({ from, to, limit, timeoutMs }) => {
      const rows = await run<{ host_hash: string | null; host: string | null; calls: number; services: number; paid_endpoints: number }>(db, timeoutMs, sql`
        with hosts as (
          select host_hash, min(host) as host, count(*)::int as calls, count(distinct path_hash)::int as paths
          from (${calls({ from, to }, { paidOnly: true, text: { hostLength: maxListedHostLength } })}) as calls group by host_hash
        )
        select null as host_hash, null as host, coalesce(sum(calls), 0)::int as calls, count(*)::int as services, coalesce(sum(paths), 0)::int as paid_endpoints from hosts
        union all
        select * from (select host_hash, host, calls, 0, 0 from hosts where host is not null order by calls desc, host_hash limit ${limit}) as chosen`);
      const [totals, ...chosen] = rows;

      return {
        services: chosen.map(row => ({ hostHash: row.host_hash!, host: row.host!, calls: row.calls })).sort((a, b) => b.calls - a.calls || compareText(a.host, b.host)),
        totals: { services: totals?.services ?? 0, paidEndpoints: totals?.paid_endpoints ?? 0, calls: totals?.calls ?? 0 },
      };
    },

    keepBuyers: async ({ day, from, to, cap, timeoutMs }) => {
      await run(db, timeoutMs, sql`delete from ${statsBuyers} where ${statsBuyers.day} < ${day}::date`, true);
      await run(db, timeoutMs, sql`insert into ${statsBuyers} (day, buyer_hash)
        select ${day}::date, md5(buyer) from (${calls({ from, to }, { paidOnly: true })}) as calls group by md5(buyer) order by md5(buyer) limit ${cap}
        on conflict do nothing`, true);
      // The lowest `cap` by hash, as every run picks them: one that came lower pushes out the highest
      await run(db, timeoutMs, sql`delete from ${statsBuyers} where ${statsBuyers.day} = ${day}::date and ${statsBuyers.buyerHash} > (
        select ${statsBuyers.buyerHash} from ${statsBuyers} where ${statsBuyers.day} = ${day}::date order by ${statsBuyers.buyerHash} offset ${cap - 1} limit 1
      )`, true);
      const [kept] = await run<{ kept: number }>(db, timeoutMs, sql`select count(*)::int as kept from ${statsBuyers} where ${statsBuyers.day} = ${day}::date`);

      return kept?.kept ?? 0;
    },

    services: async ({ scope, periods, timeoutMs }) => {
      const scoped = { ...scope, from: scope.from ?? earliest(periods) };
      const groups = await run<Row>(db, timeoutMs, sql`with calls as (${calls(scoped)})
        select grouping(paid_with)::int as by_way, host_hash, paid_with, ${numbersOf(periods)},
          ${sql.join(periods.map(({ from }, index) => sql`(count(distinct path_hash) filter (where paid and ${within(from)}))::int as ${named('paths', index)}`), sql`, `)},
          ${cappedOf(ways, scoped)} as capped
        from calls group by grouping sets ((host_hash), (host_hash, paid_with))`);
      // Each buyer's numbers of every period in one pass; its last call, the latest of any period it paid
      // in, gives how it paid and its payer. Then each period's top buyers by a window of their own.
      const buyers = await run<Row>(db, timeoutMs, sql`with numbered as (
          select calls.*, row_number() over (partition by host_hash, buyer order by at desc, id desc) as recent from (${calls(scoped, { paidOnly: true })}) as calls
        ),
        buyers as (
          select host_hash, buyer, buyer like 'unknown:%' as unknown, max(paid_with) filter (where recent = 1) as paid_with, max(payer) filter (where recent = 1) as payer,
            ${sql.join(periods.map(({ from }, index) => sql`(count(*) filter (where ${within(from)}))::int as ${named('calls', index)},
              coalesce(sum(amount) filter (where ${within(from)}), 0) as ${named('spent', index)}, max(at) filter (where ${within(from)}) as ${named('last', index)},
              count(distinct (at at time zone 'UTC')::date) filter (where ${within(from)}) as ${named('days', index)}`), sql`, `)}
          from numbered group by host_hash, buyer
        ),
        ranked as (
          select buyers.*, ${sql.join(periods.map((_, index) => sql`row_number() over (partition by host_hash, ${named('calls', index)} > 0
            order by unknown, ${named('calls', index)} desc, ${named('spent', index)} desc, ${named('last', index)} desc, buyer) as ${named('rank', index)}`), sql`, `)}
          from buyers
        )
        select host_hash, ${sql.join(periods.map((_, index) => sql`
          (count(*) filter (where ${named('calls', index)} > 0 and not unknown))::int as ${named('known', index)},
          (count(*) filter (where ${named('calls', index)} > 0 and not unknown and ${named('days', index)} >= 2))::int as ${named('returning', index)},
          coalesce(jsonb_agg(jsonb_build_object(
            'payer', payer, 'paidWith', paid_with, 'calls', ${named('calls', index)}, 'spent', ${named('spent', index)}::text,
            'lastCallAt', (extract(epoch from ${named('last', index)}) * 1000)::bigint
          ) order by ${named('rank', index)}) filter (where ${named('calls', index)} > 0 and ${named('rank', index)} <= ${topListSize} and not unknown), '[]'::jsonb)
            as ${named('top', index)}`), sql`, `)}
        from ranked group by host_hash`);
      const buyersOf = new Map(buyers.map(row => [String(row['host_hash']), row]));

      return {
        capped: groups.some(row => row['capped'] === true),
        counts: groups.filter(row => row['by_way'] === 1).flatMap(row => {
          const hostHash = String(row['host_hash']);
          const found = buyersOf.get(hostHash);
          const byWay = groups.filter(each => each['by_way'] === 0 && each['host_hash'] === hostHash);

          return periods.map(({ period }, index) => ({
            ...countsAt(row, index),
            hostHash,
            period,
            paidEndpoints: numberOf(row, 'paths', index),
            ways: waysAt(byWay, index),
            knownBuyers: found === undefined ? 0 : numberOf(found, 'known', index),
            returning: found === undefined ? 0 : numberOf(found, 'returning', index),
            topBuyers: ((found?.[`top_${index}`] ?? []) as { payer: string | null; paidWith: string; calls: number; spent: string; lastCallAt: number }[])
              .map((buyer): TopBuyerCounts => ({
                payer: optional(buyer.payer), paidWith: buyer.paidWith, calls: buyer.calls, spent: BigInt(buyer.spent), lastCallAt: new Date(buyer.lastCallAt),
              })),
          }));
        }),
      };
    },

    endpoints: async ({ scope, periods, rankBy, withFree = false, only, dailyFrom, maxPathLength = maxListedPathLength, timeoutMs }) => {
      const scoped = { ...scope, from: scope.from ?? earliest(periods) };
      const rank = Math.max(0, periods.findIndex(({ period }) => period === rankBy));
      const given = only === undefined ? undefined : Object.fromEntries(only.map(key => [`${key.hostHash}:${key.pathHash}`, true]));
      // An endpoint the ranking takes: its host and path short enough, a paid call unless free ones count, one given if any are
      const eligible = sql`(level = 3 and host is not null and path is not null${withFree ? sql`` : sql` and ${named('calls', rank)} > 0`}${
        given === undefined ? sql`` : sql` and ${json(given)} ? (host_hash || ':' || path_hash)`})`;
      const firsts = sql.join(periods.flatMap((_, index) => ['calls', 'volume', 'buyers', 'free', 'p50', 'p95']
        .map(name => sql`max(${named(name, index)}) filter (where level = 3) as ${named(name, index)}`)), sql`, `);
      // Every endpoint's numbers, ways to pay and days in one pass, grouped three ways; each ranked and its
      // path bytes summed by a window; its ways and days kept by a window over its own rows, never a join
      const rows = await run<Row>(db, timeoutMs, sql`with grouped as (
          select grouping(paid_with, day)::int as level, host_hash, path_hash, paid_with, day,
            min(host) as host, min(path) as path, max(path_length)::int as path_length, mode() within group (order by method) as method,
            ${numbersOf(periods)}, (count(*) filter (where paid))::int as day_calls
          from (
            select calls.*, case when calls.paid${dailyFrom === undefined ? sql`` : sql` and calls.at >= ${dailyFrom}`}
              then to_char(calls.at at time zone 'UTC', 'YYYY-MM-DD') end as day
            from (${calls(scoped, { text: { hostLength: maxListedHostLength, pathLength: maxPathLength } })}) as calls
          ) as calls
          group by grouping sets ((host_hash, path_hash), (host_hash, path_hash, paid_with), (host_hash, path_hash, day))
        ),
        ranked as (
          select grouped.*, case when ${eligible} then row_number() over listing end as listed, case when ${eligible} then sum(path_length) over listing end as bytes
          from grouped
          window listing as (partition by host_hash, ${eligible} order by ${named('calls', rank)} desc, ${named('free', rank)} desc, path_hash rows unbounded preceding)
        ),
        kept as (
          select ranked.*, bool_or(listed <= ${endpointsPerService} and bytes <= ${storedPathBytesPerService}) over (partition by host_hash, path_hash) as keep from ranked
        ),
        endpoints as (
          select host_hash, path_hash, max(host) filter (where level = 3) as host, max(path) filter (where level = 3) as path,
            max(method) filter (where level = 3) as method, ${firsts},
            coalesce(jsonb_agg(jsonb_build_array(paid_with, ${sql.join(periods.map((_, index) => named('calls', index)), sql`, `)})) filter (where level = 1), '[]'::jsonb) as ways,
            coalesce(jsonb_agg(jsonb_build_array(day, day_calls)) filter (where level = 2 and day is not null), '[]'::jsonb) as daily
          from kept where keep group by host_hash, path_hash
        )
        select endpoints.*, quoted.price::text as price
        from endpoints left join lateral (
          select ${routedEndpoints.lastPrice} as price from ${routedEndpoints} where ${routedEndpoints.host} = endpoints.host and ${routedEndpoints.path} = endpoints.path limit 1
        ) as quoted on true`);

      return rows.map(row => ({
        hostHash: String(row['host_hash']),
        pathHash: String(row['path_hash']),
        path: String(row['path']),
        method: optional((row['method'] as string | null) ?? null),
        price: row['price'] === null || row['price'] === undefined ? undefined : BigInt(row['price'] as string),
        periods: Object.fromEntries(periods.map(({ period }, index) => [period, {
          ...countsAt(row, index),
          ways: (row['ways'] as [string, ...number[]][]).map(([paidWith, ...counts]) => ({ paidWith, calls: counts[index] ?? 0 })),
        }])),
        daily: (row['daily'] as [string, number][]).map(([day, count]) => ({ day, calls: count })),
      }));
    },

    serviceDays: async ({ scope, timeoutMs }) => {
      const rows = await run<{ host_hash: string; day: string; calls: number; volume: string; buyers: number }>(db, timeoutMs, sql`with calls as (${calls(scope, { paidOnly: true })})
        select host_hash, to_char(at at time zone 'UTC', 'YYYY-MM-DD') as day, count(*)::int as calls, sum(amount)::text as volume, (count(distinct buyer))::int as buyers
        from calls group by 1, 2`);

      return rows.map(row => ({ hostHash: row.host_hash, day: row.day, calls: row.calls, volume: micro(row.volume), buyers: row.buyers }));
    },

    callsIn: async ({ scope, windows, timeoutMs }) => {
      if (windows.length === 0)
        return [];
      const from = new Date(Math.min(...windows.map(window => window.from.getTime())));
      const to = new Date(Math.max(...windows.map(window => window.to.getTime())));
      // Each window by a filter of the one pass; a capped scope keeps its own, so its statements count the same calls
      const rows = await run<Row>(db, timeoutMs, sql`with calls as (${calls(scope.cap === undefined ? { ...scope, from, to } : scope, { paidOnly: true })})
        select host_hash, ${sql.join(windows.map((window, index) => sql`(count(*) filter (where at >= ${window.from} and at < ${window.to}))::int as ${named('calls', index)}`), sql`, `)}
        from calls group by host_hash`);

      return rows.flatMap(row => windows.map(({ period }, index) => ({ hostHash: String(row['host_hash']), period, calls: numberOf(row, 'calls', index) })));
    },

    priceFrom: async ({ hostHashes, from, to, timeoutMs }) => {
      if (hostHashes.length === 0)
        return new Map();
      // The hosts' paths with a paid call, by the host index, then each one's quote by the routed endpoints' key
      const rows = await run<{ host_hash: string; price: string }>(db, timeoutMs, sql`
        with paths as (
          select distinct host_hash, host, path
          from (${calls({ hostHashes, from, to }, { paidOnly: true, text: { hostLength: maxListedHostLength, pathLength: maxListedPathLength } })}) as calls
          where host is not null and path is not null
        )
        select paths.host_hash, min(quoted.price)::text as price
        from paths cross join lateral (
          -- One lookup by the key per path: the lateral read with its limit keeps it so, whatever the table's size
          select ${routedEndpoints.lastPrice} as price from ${routedEndpoints}
          where ${routedEndpoints.host} = paths.host and ${routedEndpoints.path} = paths.path and ${routedEndpoints.lastPrice} is not null limit 1
        ) as quoted
        group by paths.host_hash`);

      return new Map(rows.map(row => [row.host_hash, BigInt(row.price)]));
    },

    liveTail: async ({ from, at, minutesFrom, timeoutMs }) => {
      const dayStart = utcDayStart(at);
      const todayFrom = from.getTime() > dayStart.getTime() ? from : dayStart;
      const [row] = await run<{
        calls: number; volume: string; today_calls: number; today_volume: string; today_near: number; today_buyers: number; per_minute: [string, number][];
      }>(db, timeoutMs, sql`with calls as (${calls({ from: from.getTime() < minutesFrom.getTime() ? from : minutesFrom, to: at }, { paidOnly: true })})
        select (count(*) filter (where at >= ${from}))::int as calls, coalesce(sum(amount) filter (where at >= ${from}), 0)::text as volume,
          (count(*) filter (where at >= ${todayFrom}))::int as today_calls, coalesce(sum(amount) filter (where at >= ${todayFrom}), 0)::text as today_volume,
          (count(*) filter (where at >= ${todayFrom} and paid_with = 'near'))::int as today_near,
          (select count(*)::int from (
            select ${statsBuyers.buyerHash} from ${statsBuyers} where ${statsBuyers.day} = ${dayStart.toISOString().slice(0, 10)}::date
            union select md5(buyer) from calls where at >= ${todayFrom}
          ) as buyers) as today_buyers,
          coalesce((select jsonb_agg(jsonb_build_array(minute::text, count)) from (
            select (floor(extract(epoch from at) / 60) * 60000)::bigint as minute, count(*)::int as count from calls where at >= ${minutesFrom} group by 1
          ) as by_minute), '[]'::jsonb) as per_minute
        from calls`);

      return {
        from,
        at,
        calls: row?.calls ?? 0,
        volume: micro(row?.volume ?? null),
        todayCalls: row?.today_calls ?? 0,
        todayVolume: micro(row?.today_volume ?? null),
        todayNear: row?.today_near ?? 0,
        todayBuyers: row?.today_buyers ?? 0,
        perMinute: (row?.per_minute ?? []).map(([minute, count]) => ({ minute: new Date(Number(minute)), calls: count })),
      };
    },

    listedAt: async ({ hosts, timeoutMs }) => {
      if (hosts.length === 0)
        return new Map();
      const firstPaid = sql`(select min(${routedEndpoints.createdAt}) from ${routedEndpoints}
        where ${routedEndpoints.host} = given.host and ${routedEndpoints.status} = 'paid')`;
      // Fenced, so the at most 20 come by their index: as a bare minimum the planner may walk the catalog's index of every endpoint
      const firstChecked = sql`(select min(listed.created_at) from (select ${routedEndpoints.createdAt} as created_at from ${routedEndpoints}
        where ${routedEndpoints.host} = given.host and ${routedEndpoints.status} = 'checked' offset 0) as listed)`;
      const rows = await run<{ host: string; listed_at: string | null }>(db, timeoutMs, sql`select given.host, least(${firstPaid}, ${firstChecked})::text as listed_at
        from jsonb_array_elements_text(${json(hosts)}) as given(host)`);

      return new Map(rows.flatMap(row => (row.listed_at === null ? [] : [[row.host, new Date(row.listed_at)] as const])));
    },

    isCapped: async ({ scope, timeoutMs }) => {
      const [row] = await run<{ capped: boolean }>(db, timeoutMs, sql`select ${cappedOf(ways, scope)} as capped`);

      return row?.capped === true;
    },

    hasPaidCall: async ({ host, timeoutMs }) => {
      const [row] = await run<{ found: boolean }>(db, timeoutMs, sql`select exists (
        select 1 from ${payments} where md5(${payments.targetHost}) = md5(${host}::text) and ${payments.targetHost} = ${host} and ${finished} and ${paid}
      ) as found`);

      return row?.found === true;
    },

    endpointScope: async ({ host, path, from, cap, timeoutMs }) => {
      const since = from === undefined ? sql`` : sql` and ${payments.createdAt} >= ${from}`;
      const [row] = await run<{ host: number; path: number }>(db, timeoutMs, sql`select
        (select count(*)::int from (select 1 from ${payments} where md5(${payments.targetHost}) = ${md5(host)}::text and ${finished}${since} limit ${cap}) as by_host) as host,
        (select count(*)::int from (select 1 from ${payments} where md5(${payments.targetPath}) = ${md5(path)}::text and ${finished}${since} limit ${cap}) as by_path) as path`);
      const reach = { host: row?.host ?? 0, path: row?.path ?? 0 };
      if (reach.host === 0 || reach.path === 0)
        return undefined;

      return { endpoint: { host, path, by: reach.host <= reach.path ? 'host' : 'path' }, from, cap };
    },
  };
};
