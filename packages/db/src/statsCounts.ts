import { sql, type SQL } from 'drizzle-orm';

import type { MicroUsd } from '@anyfare/common';
import {
  endpointsPerService, maxListedHostLength, utcDayStart, maxListedPathLength, topListSize, type CallCounts, type DayCounts, type EndpointCounts, type EndpointPeriodCounts,
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
// comes back is bounded: ranked and cut in SQL, never a list of every host or path.

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
  // One host and one path, exactly, by the path's md5: payments_calls_path_idx
  readonly endpoint?: { readonly host: string; readonly path: string };
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
  /** The top endpoints of each service by paid calls of `rankBy`, at most 100, of those that may be listed, with their numbers. */
  endpoints(input: {
    readonly scope: CallScope;
    readonly periods: readonly CountedPeriod[];
    readonly rankBy: StatsPeriod;
    // Endpoints with a finished call count too, not only those with a paid one
    readonly withFree?: boolean;
    // Only these, of each host
    readonly only?: readonly { readonly hostHash: string; readonly pathHash: string }[];
    readonly dailyFrom: Date | undefined;
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
  /** The cheapest last quote of each host's routed endpoints with a paid call from `from`, by the routed endpoints' key. */
  priceFrom(input: { readonly hosts: readonly string[]; readonly from: Date; readonly to: Date; readonly timeoutMs: number }): Promise<Map<string, MicroUsd>>;
  /** Whether a capped scope holds more calls than its cap. */
  isCapped(input: { readonly scope: CallScope; readonly timeoutMs: number }): Promise<boolean>;
  /** Whether the host has a paid call, ever: the first one the host index finds. */
  hasPaidCall(input: { readonly host: string; readonly timeoutMs: number }): Promise<boolean>;
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

/**
 * Finished calls in a scope, with their details: by the calls index on their time, or the host or path
 * index for some hosts or one endpoint. The host and the path come as their md5 and their length, never
 * their text, so a long path costs a statement nothing. Never an account, a key, a request ID, a
 * receipt or a settle request: a chain payer's address only.
 */
const scopedCalls = (ways: readonly PaidWithWay[], scope: CallScope, { paidOnly = false }: { readonly paidOnly?: boolean } = {}): SQL => {
  const where: SQL[] = [
    finished,
    ...paidOnly ? [paid] : [],
    ...scope.from === undefined ? [] : [sql`${payments.createdAt} >= ${scope.from}`],
    ...scope.to === undefined ? [] : [sql`${payments.createdAt} < ${scope.to}`],
    ...scope.hostHashes === undefined ? [] : [sql`md5(${payments.targetHost}) = any(array(select jsonb_array_elements_text(${json(scope.hostHashes)})))`],
    // The md5 for the index, the text against a collision
    ...scope.host === undefined ? [] : [sql`md5(${payments.targetHost}) = md5(${scope.host}::text)`, sql`${payments.targetHost} = ${scope.host}`],
    ...scope.endpoint === undefined ? [] : [
      sql`md5(${payments.targetPath}) = md5(${scope.endpoint.path}::text)`, sql`${payments.targetPath} = ${scope.endpoint.path}`,
      sql`${payments.targetHost} = ${scope.endpoint.host}`,
    ],
  ];
  const select = sql`select ${payments.id} as id, ${payments.createdAt} as at,
      md5(${payments.targetHost}) as host_hash, length(${payments.targetHost}) as host_length,
      md5(${payments.targetPath}) as path_hash, length(${payments.targetPath}) as path_length,
      ${paidWithOf(ways)} as paid_with, ${paid} as paid, ${payments.amount} as amount,
      case when ${payments.upstreamStatus} is not null then ${payments.upstreamLatencyMs} end as ms,
      ${buyerOf} as buyer, case when ${payments.rail} = 'credits' then null else ${callDetails.payer} end as payer,
      ${callDetails.method} as method
    from ${payments} left join ${callDetails} on ${callDetails.paymentId} = ${payments.id}
    where ${sql.join(where, sql` and `)}`;

  return scope.cap === undefined ? select : sql`${select} order by ${payments.createdAt} desc, ${payments.id} desc limit ${scope.cap}`;
};

// Whether a capped scope holds more calls than its cap: the first `cap + 1` of them, counted
const cappedOf = (ways: readonly PaidWithWay[], scope: CallScope): SQL => scope.cap === undefined
  ? sql`false`
  : sql`((select count(*) from (${scopedCalls(ways, { ...scope, cap: scope.cap + 1 })}) as newest) > ${scope.cap})`;

// The periods a statement counts, joined to each call in them
const periodsOf = (periods: readonly CountedPeriod[]): SQL =>
  sql`(values ${sql.join(periods.map(({ period, from }) => sql`(${period}::text, ${from ?? null}::timestamptz)`), sql`, `)}) as periods(period, since)`;
const inPeriod = sql`(periods.since is null or calls.at >= periods.since)`;

// The numbers of a group of calls
const numbers = sql`(count(*) filter (where paid))::int as calls,
  coalesce(sum(amount) filter (where paid), 0)::text as volume,
  (count(distinct buyer) filter (where paid))::int as buyers,
  (count(*) filter (where not paid))::int as free,
  percentile_cont(0.5) within group (order by ms) as p50,
  percentile_cont(0.95) within group (order by ms) as p95`;

interface NumbersRow extends Record<string, unknown> {
  readonly calls: number;
  readonly volume: string;
  readonly buyers: number;
  readonly free: number;
  readonly p50: number | null;
  readonly p95: number | null;
}

const countsOf = (row: NumbersRow): CallCounts => ({
  calls: row.calls, volume: micro(row.volume), buyers: row.buyers, free: row.free, p50Ms: roundedMs(row.p50), p95Ms: roundedMs(row.p95),
});

interface GroupRow extends NumbersRow {
  readonly by_way: number;
  readonly period: StatsPeriod;
  readonly host_hash: string | null;
  readonly paid_with: string | null;
  readonly services: number;
  readonly paid_endpoints: number;
}

const groupWays = (rows: readonly GroupRow[], key: (row: GroupRow) => string): Map<string, WayCounts[]> => {
  const ways = new Map<string, WayCounts[]>();
  for (const row of rows.filter(each => each.by_way === 0 && each.paid_with !== null)) {
    const list = ways.get(key(row)) ?? ways.set(key(row), []).get(key(row))!;
    list.push({ paidWith: row.paid_with!, calls: row.calls, volume: micro(row.volume), buyers: row.buyers });
  }

  return ways;
};


interface BuyersRow extends Record<string, unknown> {
  readonly period: StatsPeriod;
  readonly host_hash: string;
  readonly known: number;
  readonly returning: number;
  readonly top: readonly { readonly payer: string | null; readonly paidWith: string; readonly calls: number; readonly spent: string; readonly lastCallAt: number }[];
}

interface EndpointRow extends Record<string, unknown> {
  readonly host_hash: string;
  readonly path_hash: string;
  readonly path: string | null;
  readonly method: string | null;
  readonly price: string | null;
  readonly periods: Record<string, NumbersRow & { readonly ways: readonly { readonly paidWith: string; readonly calls: number }[] }> | null;
  readonly daily: readonly (readonly [string, number])[];
}

// The paths a host's calls may be listed by: only those the endpoint read takes
const listable = (alias: string): SQL => sql.raw(`${alias}.path_length <= ${maxListedPathLength} and ${alias}.host_length <= ${maxListedHostLength}`);

export interface StatsCounterOptions {
  readonly db: Database;
  // How each rail on each known network was paid
  readonly ways: readonly PaidWithWay[];
}

export const createStatsCounter = ({ db, ways }: StatsCounterOptions): StatsCounter => {
  const calls = (scope: CallScope, options?: { readonly paidOnly?: boolean }) => scopedCalls(ways, scope, options);
  // The earliest start of these periods, or none when one is all time
  const earliest = (periods: readonly CountedPeriod[]): Date | undefined =>
    periods.some(period => period.from === undefined) ? undefined : new Date(Math.min(...periods.map(period => period.from!.getTime())));

  return {
    platform: async ({ periods, to, timeoutMs }) => {
      const rows = await run<GroupRow>(db, timeoutMs, sql`with calls as (${calls({ from: earliest(periods), to })})
        select grouping(calls.paid_with)::int as by_way, periods.period, null::text as host_hash, calls.paid_with, ${numbers},
          (count(distinct calls.host_hash) filter (where paid))::int as services, 0 as paid_endpoints
        from calls join ${periodsOf(periods)} on ${inPeriod}
        group by grouping sets ((periods.period), (periods.period, calls.paid_with))`);
      const wayLists = groupWays(rows, row => row.period);

      return Object.fromEntries(rows.filter(row => row.by_way === 1).map(row => [row.period, {
        ...countsOf(row), services: row.services, ways: wayLists.get(row.period) ?? [],
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
      // Ranked by the md5 on a tie, then each one's text read by its index
      const rows = await run<{ kind: 'service' | 'endpoint'; period: StatsPeriod; rank: number; calls: number; host: string; path: string | null }>(db, timeoutMs, sql`
        with calls as (${calls({ from: earliest(periods), to }, { paidOnly: true })}),
        counted as (
          select periods.period, calls.host_hash, calls.path_hash, calls.host_length, calls.path_length from calls join ${periodsOf(periods)} on ${inPeriod}
        ),
        hosts as (
          select * from (
            select period, host_hash, count(*)::int as calls, row_number() over (partition by period order by count(*) desc, host_hash) as rank
            from counted where host_length <= ${maxListedHostLength} group by period, host_hash
          ) as ranked where rank <= ${topListSize}
        ),
        paths as (
          select * from (
            select period, host_hash, path_hash, count(*)::int as calls,
              row_number() over (partition by period order by count(*) desc, host_hash, path_hash) as rank
            from counted as listed where ${listable('listed')} group by period, host_hash, path_hash
          ) as ranked where rank <= ${topListSize}
        )
        select 'service' as kind, period, rank::int, calls,
          (select ${payments.targetHost} from ${payments} where md5(${payments.targetHost}) = hosts.host_hash and ${finished} limit 1) as host, null as path
        from hosts
        union all
        select 'endpoint', period, rank::int, calls, found.host, found.path
        from paths cross join lateral (
          select ${payments.targetHost} as host, ${payments.targetPath} as path from ${payments}
          where md5(${payments.targetPath}) = paths.path_hash and md5(${payments.targetHost}) = paths.host_hash and ${finished} limit 1
        ) as found`);
      const byName = (a: { calls: number; name: string }, b: { calls: number; name: string }) => b.calls - a.calls || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

      return Object.fromEntries(periods.map(({ period }) => [period, {
        services: rows.filter(row => row.kind === 'service' && row.period === period).map(row => ({ host: row.host, calls: row.calls, name: row.host }))
          .sort(byName).map(({ host, calls: count }) => ({ host, calls: count })),
        endpoints: rows.filter(row => row.kind === 'endpoint' && row.period === period).map(row => ({ host: row.host, path: row.path!, calls: row.calls, name: `${row.host} ${row.path!}` }))
          .sort(byName).map(({ host, path, calls: count }) => ({ host, path, calls: count })),
      }]));
    },

    topups: async ({ periods, to, timeoutMs }) => {
      // The credits by the ledger's operation index, then each one's top-up by its deposit address, which names one
      const rows = await run<{ period: StatsPeriod; network: string; token: string; count: number; amount: string }>(db, timeoutMs, sql`
        with credits as (
          select ${ledgerTransactions.createdAt} as at, credited.network, credited.token, credited.amount
          from ${ledgerTransactions} cross join lateral (
            select ${topups.network} as network, ${topups.tokenSymbol} as token, ${topups.creditedAmount} as amount
            from ${topups}
            where ${topups.depositAddress} is not null and ${topups.depositAddress} = ${ledgerTransactions.reference}
              and ${topups.ledgerTransactionId} = ${ledgerTransactions.id} and ${topups.status} = 'credited'
            limit 1
          ) as credited
          where ${ledgerTransactions.operation} = 'top_up' and ${ledgerTransactions.createdAt} < ${to}
        )
        select periods.period, network, token, count(*)::int as count, coalesce(sum(amount), 0)::text as amount
        from credits join ${periodsOf(periods)} on (periods.since is null or credits.at >= periods.since)
        group by periods.period, network, token
        order by count(*) desc limit 1000`);

      return Object.fromEntries(periods.map(({ period }) => [period, rows.filter(row => row.period === period)
        .map(row => ({ network: row.network, token: row.token, count: row.count, amount: micro(row.amount) }))]));
    },

    ranking: async ({ from, to, limit, timeoutMs }) => {
      const rows = await run<{ host_hash: string | null; host: string | null; calls: number; services: number; paid_endpoints: number }>(db, timeoutMs, sql`
        with calls as (${calls({ from, to }, { paidOnly: true })}),
        hosts as (select host_hash, max(host_length) as host_length, count(*)::int as calls, count(distinct path_hash)::int as paths from calls group by host_hash),
        chosen as (select host_hash, calls from hosts where host_length <= ${maxListedHostLength} order by calls desc, host_hash limit ${limit})
        select null as host_hash, null as host, coalesce(sum(calls), 0)::int as calls, count(*)::int as services, coalesce(sum(paths), 0)::int as paid_endpoints from hosts
        union all
        select host_hash, (select ${payments.targetHost} from ${payments} where md5(${payments.targetHost}) = chosen.host_hash and ${finished} limit 1), calls, 0, 0
        from chosen`);
      const [totals, ...chosen] = rows;

      return {
        services: chosen.map(row => ({ hostHash: row.host_hash!, host: row.host!, calls: row.calls }))
          .sort((a, b) => b.calls - a.calls || (a.host < b.host ? -1 : a.host > b.host ? 1 : 0)),
        totals: { services: totals?.services ?? 0, paidEndpoints: totals?.paid_endpoints ?? 0, calls: totals?.calls ?? 0 },
      };
    },

    keepBuyers: async ({ day, from, to, cap, timeoutMs }) => {
      await run(db, timeoutMs, sql`delete from ${statsBuyers} where ${statsBuyers.day} < ${day}::date`, true);
      await run(db, timeoutMs, sql`insert into ${statsBuyers} (day, buyer_hash)
        select ${day}::date, md5(buyer) from (${calls({ from, to }, { paidOnly: true })}) as calls group by md5(buyer) order by md5(buyer) limit ${cap}
        on conflict do nothing`, true);
      const [kept] = await run<{ kept: number }>(db, timeoutMs, sql`select count(*)::int as kept from ${statsBuyers} where ${statsBuyers.day} = ${day}::date`);

      return kept?.kept ?? 0;
    },

    services: async ({ scope, periods, timeoutMs }) => {
      const scoped = { ...scope, from: scope.from ?? earliest(periods) };
      const [groups, buyers] = [
        await run<GroupRow & { capped: boolean }>(db, timeoutMs, sql`with calls as (${calls(scoped)})
          select grouping(calls.paid_with)::int as by_way, periods.period, calls.host_hash, calls.paid_with, ${numbers}, 0 as services,
            (count(distinct calls.path_hash) filter (where paid))::int as paid_endpoints, ${cappedOf(ways, scoped)} as capped
          from calls join ${periodsOf(periods)} on ${inPeriod}
          group by grouping sets ((periods.period, calls.host_hash), (periods.period, calls.host_hash, calls.paid_with))`),
        // Each buyer's last call gives how it paid and its payer: numbered newest first, so no buyer's calls are held at once
        await run<BuyersRow>(db, timeoutMs, sql`with calls as (${calls(scoped)}),
          counted as (
            select periods.period, calls.*, row_number() over (partition by periods.period, calls.host_hash, calls.buyer order by calls.at desc, calls.id desc) as recent
            from calls join ${periodsOf(periods)} on ${inPeriod} where calls.paid
          ),
          buyers as (
            select period, host_hash, buyer, buyer like 'unknown:%' as unknown, count(*)::int as calls, sum(amount) as spent, max(at) as last_at,
              count(distinct (at at time zone 'UTC')::date) as days,
              max(paid_with) filter (where recent = 1) as paid_with, max(payer) filter (where recent = 1) as payer
            from counted group by period, host_hash, buyer
          ),
          ranked as (
            select *, row_number() over (partition by period, host_hash order by unknown, calls desc, spent desc, last_at desc, buyer) as rank from buyers
          )
          select period, host_hash, (count(*) filter (where not unknown))::int as known, (count(*) filter (where not unknown and days >= 2))::int as returning,
            coalesce(jsonb_agg(jsonb_build_object(
              'payer', payer, 'paidWith', paid_with, 'calls', calls, 'spent', spent::text, 'lastCallAt', (extract(epoch from last_at) * 1000)::bigint
            ) order by rank) filter (where rank <= ${topListSize} and not unknown), '[]'::jsonb) as top
          from ranked group by period, host_hash`),
      ];
      const wayLists = groupWays(groups, row => `${row.period} ${row.host_hash!}`);
      const buyersOf = new Map(buyers.map(row => [`${row.period} ${row.host_hash}`, row]));

      return {
        capped: groups.some(row => row.capped),
        counts: groups.filter(row => row.by_way === 1).map(row => {
          const key = `${row.period} ${row.host_hash!}`;
          const found = buyersOf.get(key);

          return {
            ...countsOf(row),
            hostHash: row.host_hash!,
            period: row.period,
            paidEndpoints: row.paid_endpoints,
            ways: wayLists.get(key) ?? [],
            knownBuyers: found?.known ?? 0,
            returning: found?.returning ?? 0,
            topBuyers: (found?.top ?? []).map((buyer): TopBuyerCounts => ({
              payer: optional(buyer.payer), paidWith: buyer.paidWith, calls: buyer.calls, spent: BigInt(buyer.spent), lastCallAt: new Date(buyer.lastCallAt),
            })),
          };
        }),
      };
    },

    endpoints: async ({ scope, periods, rankBy, withFree = false, only, dailyFrom, timeoutMs }) => {
      const scoped = { ...scope, from: scope.from ?? earliest(periods) };
      const chosen = only === undefined
        ? sql`select host_hash, path_hash from (
            select host_hash, path_hash, row_number() over (partition by host_hash order by calls desc, free desc, path_hash) as rank
            from numbers where period = ${rankBy}::text and ${listable('numbers')}${withFree ? sql`` : sql` and calls > 0`}
          ) as ranked where rank <= ${endpointsPerService}`
        : sql`select host_hash, path_hash from jsonb_to_recordset(${json(only.map(key => ({ host_hash: key.hostHash, path_hash: key.pathHash })))})
            as given(host_hash text, path_hash text)`;
      const rows = await run<EndpointRow>(db, timeoutMs, sql`with calls as (${calls(scoped)}),
        counted as (select periods.period, calls.* from calls join ${periodsOf(periods)} on ${inPeriod}),
        numbers as (
          select period, host_hash, path_hash, max(host_length) as host_length, max(path_length) as path_length, ${numbers}
          from counted group by period, host_hash, path_hash
        ),
        chosen as (${chosen}),
        way_lists as (
          select period, host_hash, path_hash, jsonb_agg(jsonb_build_object('paidWith', paid_with, 'calls', calls)) as ways from (
            select counted.period, counted.host_hash, counted.path_hash, counted.paid_with, count(*)::int as calls
            from counted join chosen using (host_hash, path_hash) where counted.paid group by 1, 2, 3, 4
          ) as by_way group by 1, 2, 3
        ),
        period_lists as (
          select numbers.host_hash, numbers.path_hash, jsonb_object_agg(numbers.period, jsonb_build_object(
            'calls', numbers.calls, 'volume', numbers.volume, 'buyers', numbers.buyers, 'free', numbers.free, 'p50', numbers.p50, 'p95', numbers.p95,
            'ways', coalesce(way_lists.ways, '[]'::jsonb)
          )) as periods
          from numbers join chosen using (host_hash, path_hash) left join way_lists using (period, host_hash, path_hash)
          group by numbers.host_hash, numbers.path_hash
        ),
        details as (
          select host_hash, path_hash, mode() within group (order by calls.method) as method from calls join chosen using (host_hash, path_hash) group by host_hash, path_hash
        ),
        day_lists as (
          select host_hash, path_hash, jsonb_agg(jsonb_build_array(day, calls)) as daily from (
            select calls.host_hash, calls.path_hash, to_char(calls.at at time zone 'UTC', 'YYYY-MM-DD') as day, count(*)::int as calls
            from calls join chosen using (host_hash, path_hash) where calls.paid${dailyFrom === undefined ? sql`` : sql` and calls.at >= ${dailyFrom}`}
            group by 1, 2, 3
          ) as by_day group by host_hash, path_hash
        )
        select chosen.host_hash, chosen.path_hash, found.host, found.path, details.method, ${routedEndpoints.lastPrice}::text as price,
          period_lists.periods, coalesce(day_lists.daily, '[]'::jsonb) as daily
        from chosen
          join details using (host_hash, path_hash)
          left join period_lists using (host_hash, path_hash)
          left join day_lists using (host_hash, path_hash)
          cross join lateral (
            select ${payments.targetHost} as host, ${payments.targetPath} as path from ${payments}
            where md5(${payments.targetPath}) = chosen.path_hash and md5(${payments.targetHost}) = chosen.host_hash and ${finished} limit 1
          ) as found
          left join ${routedEndpoints} on ${routedEndpoints.host} = found.host and ${routedEndpoints.path} = found.path`);

      return rows.filter(row => row.path !== null).map(row => ({
        hostHash: row.host_hash,
        pathHash: row.path_hash,
        path: row.path!,
        method: optional(row.method),
        price: row.price === null ? undefined : BigInt(row.price),
        periods: Object.fromEntries(Object.entries(row.periods ?? {}).map(([period, counted]): [string, EndpointPeriodCounts] => [period, {
          ...countsOf(counted), ways: counted.ways,
        }])),
        daily: row.daily.map(([day, count]) => ({ day, calls: count })),
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
      const rows = await run<{ host_hash: string; period: StatsPeriod; calls: number }>(db, timeoutMs, sql`with calls as (${calls({ ...scope, from, to }, { paidOnly: true })})
        select calls.host_hash, windows.period, count(*)::int as calls
        from calls join (values ${sql.join(windows.map(window => sql`(${window.period}::text, ${window.from}::timestamptz, ${window.to}::timestamptz)`), sql`, `)})
          as windows(period, since, until) on calls.at >= windows.since and calls.at < windows.until
        group by 1, 2`);

      return rows.map(row => ({ hostHash: row.host_hash, period: row.period, calls: row.calls }));
    },

    priceFrom: async ({ hosts, from, to, timeoutMs }) => {
      if (hosts.length === 0)
        return new Map();
      // Each host's routed endpoints by their key, and for each a paid call since `from` by the path index
      const rows = await run<{ host_hash: string; price: string }>(db, timeoutMs, sql`
        select md5(${routedEndpoints.host}) as host_hash, min(${routedEndpoints.lastPrice})::text as price from ${routedEndpoints}
        where ${routedEndpoints.host} = any(array(select jsonb_array_elements_text(${json(hosts)}))) and ${routedEndpoints.lastPrice} is not null
          and length(${routedEndpoints.path}) <= ${maxListedPathLength}
          and exists (
            select 1 from ${payments}
            where md5(${payments.targetPath}) = md5(${routedEndpoints.path}) and ${payments.targetPath} = ${routedEndpoints.path}
              and ${payments.targetHost} = ${routedEndpoints.host} and ${finished} and ${paid} and ${payments.createdAt} >= ${from} and ${payments.createdAt} < ${to}
          )
        group by ${routedEndpoints.host}`);

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
  };
};
