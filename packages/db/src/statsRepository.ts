import { and, asc, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';

import {
  hostSuffixes, maxListedPathLength, type EndpointNumbers, type JsonObject, type ListedStatus, type LiveBase, type PlatformAllAnswer, type PlatformRecentAnswer,
  type RecentPeriod, type ServicePage, type ServiceRow, type ServicesTotals, type StatsPeriod, type StoredEndpoint, type TopAnswer,
} from '@anyfare/core';

import { withTransaction, type Database, type DatabaseExecutor } from './postgres.js';
import { maxCheckedEndpointsPerHost, maxCheckedHosts } from './routingRepository.js';
import { checkedHosts, hostBlocklist, routedEndpoints } from './schema/routing.js';
import { statsAnswers, statsEndpoints, statsServicePages, statsServices } from './schema/stats.js';

// The public numbers' own tables. A count writes a row only when its numbers changed, and deletes the
// rows that left its set, in batches, each statement in a short transaction of its own. A public read of
// them is one statement.

export interface StatsRepositoryOptions {
  readonly db: Database;
}

/** A stored answer and the time its count counted to. */
export interface StoredAnswer<TAnswer> {
  readonly answer: TAnswer;
  readonly countedAt: Date;
}

/** The kinds of count: today, 7 and 30 days, and all time. */
export type CountKind = 'recent' | 'all';

/**
 * When each kind of count last completed. Such a count verified every row of its kind it left in place,
 * so a row is true as of the later of its own time and its kind's.
 */
export interface CountMarks {
  readonly recent: Date | undefined;
  readonly all: Date | undefined;
}

export type ServicesSort = 'calls' | 'buyers' | 'volume' | 'endpoints' | 'price' | 'newest';

/**
 * A service of the public list: a stored one, with what checks listed of it, or one read now from the checked
 * hosts: listed only by checks, or reached by a paid call since the last complete count. Its numbers are the
 * count's, zeros for one not stored.
 */
export interface ListedServiceRow extends ServiceRow {
  readonly status: ListedStatus;
  // Undefined: not stored, so no count vouches for it
  readonly countedAt: Date | undefined;
  // When its first endpoint was listed, and when a check last confirmed one. Undefined: not known, or never.
  readonly listedAt: Date | undefined;
  readonly checkedAt: Date | undefined;
}

/** What the public list adds to the count's totals, read now. */
export interface ListedTotals {
  // Paid services not stored yet: a paid call reached them after a check, since the last complete count
  readonly paidNotStored: number;
  readonly checked: number;
  // Endpoints listed only by a check, of every service listed, and every endpoint of a paid one not stored
  readonly addedEndpoints: number;
  // The stored services on the blocklist, which the count still counted
  readonly blocked: { readonly services: number; readonly paidEndpoints: number; readonly calls: number };
}

/** An endpoint listed only by a check. */
export interface CheckedEndpointRow {
  readonly path: string;
  readonly method: string | null;
  readonly price: bigint | undefined;
  readonly checkedAt: Date | undefined;
}

/**
 * What checks listed of a host, read now: at most 20 of its endpoints listed only by a check, newest checked
 * first, with paths the public reads list, and when a check last confirmed each of some others.
 */
export interface HostListing {
  readonly blocked: boolean;
  // A paid call reached one of its endpoints
  readonly paid: boolean;
  readonly listedAt: Date | undefined;
  readonly checkedAt: Date | undefined;
  // Every endpoint listed only by a check, counted up to their cap
  readonly checkedCount: number;
  readonly checked: readonly CheckedEndpointRow[];
  // By path
  readonly checkedTimes: ReadonlyMap<string, Date>;
}

/** A cycle of the frequent count over its services: one or more runs, each going on from the last. */
export interface StatsCycle {
  // Its first run's time: each of its rows is true at least as of then
  readonly startedAt: Date;
  readonly services: readonly { readonly hostHash: string; readonly host: string }[];
  readonly next: number;
}

/** A stored endpoint with the times of its two kinds of numbers. */
export interface StoredEndpointRow extends StoredEndpoint {
  readonly countedAt: Date;
  readonly all: EndpointNumbers | undefined;
  readonly allCountedAt: Date | undefined;
}

export interface StatsRepository {
  /** Writes these platform answers, whether or not they changed: there are few, and their time is the count's. */
  putAnswers(input: { readonly answers: readonly { readonly key: string; readonly answer: unknown }[]; readonly countedAt: Date; readonly timeoutMs: number }): Promise<void>;
  /** Writes the service rows whose numbers changed. Returns how many it wrote. */
  putServices(input: { readonly rows: readonly ServiceRow[]; readonly countedAt: Date; readonly timeoutMs: number }): Promise<number>;
  /** Writes the service pages whose numbers changed. Returns how many it wrote. */
  putServicePages(input: {
    readonly pages: readonly { readonly hostHash: string; readonly period: StatsPeriod; readonly answer: ServicePage }[];
    readonly countedAt: Date;
    readonly timeoutMs: number;
  }): Promise<number>;
  /**
   * Writes the endpoints of these hosts whose numbers of today, 7 and 30 days changed, and deletes the
   * hosts' endpoints that aren't among them. Returns how many it wrote and deleted.
   */
  putEndpoints(input: {
    readonly hostHashes: readonly string[];
    readonly endpoints: readonly StoredEndpoint[];
    readonly countedAt: Date;
    readonly timeoutMs: number;
  }): Promise<{ readonly written: number; readonly deleted: number }>;
  /** Writes the all-time numbers of stored endpoints that changed. Returns how many it wrote. */
  putEndpointsAll(input: {
    readonly numbers: readonly { readonly hostHash: string; readonly pathHash: string; readonly all: EndpointNumbers }[];
    readonly countedAt: Date;
    readonly timeoutMs: number;
  }): Promise<number>;
  /** Deletes the services, pages and endpoints of every host but these, `batch` rows a statement. Returns how many it deleted. */
  dropOutside(input: { readonly hostHashes: readonly string[]; readonly batch: number; readonly timeoutMs: number }): Promise<number>;
  /** Records that a count of this kind completed. */
  markComplete(input: { readonly kind: CountKind; readonly countedAt: Date; readonly timeoutMs: number }): Promise<void>;
  /** The frequent count's cycle under way: when it started, its services in order, and the next to count. Undefined: none. */
  cycle(input: { readonly timeoutMs: number }): Promise<StatsCycle | undefined>;
  /** Starts a cycle of these services, from the first. */
  startCycle(input: StatsCycle & { readonly timeoutMs: number }): Promise<void>;
  /** Records the next service of the cycle under way to count. */
  advanceCycle(input: { readonly next: number; readonly timeoutMs: number }): Promise<void>;
  /** Ends the cycle under way. */
  endCycle(input: { readonly timeoutMs: number }): Promise<void>;
  /** The stored services, most paid calls first. */
  storedServices(input: { readonly timeoutMs: number }): Promise<{ readonly hostHash: string; readonly host: string }[]>;
  /** The stored endpoints of these hosts. */
  storedEndpointKeys(input: { readonly hostHashes: readonly string[]; readonly timeoutMs: number }): Promise<{ readonly hostHash: string; readonly pathHash: string }[]>;

  // The public reads: one statement each
  platform(): Promise<{ readonly recent: StoredAnswer<PlatformRecentAnswer> | undefined; readonly all: StoredAnswer<PlatformAllAnswer> | undefined }>;
  top(period: StatsPeriod): Promise<StoredAnswer<TopAnswer> | undefined>;
  live(): Promise<StoredAnswer<LiveBase> | undefined>;
  /**
   * A page of listed services, of both kinds and none on the blocklist, how many match `q`, a part of the host
   * without case, the totals, what the list adds to them, and the marks.
   */
  services(input: { readonly q?: string; readonly sort: ServicesSort; readonly offset: number; readonly limit: number }): Promise<{
    readonly rows: readonly ListedServiceRow[];
    readonly total: number;
    // Every stored service, whatever `q` says
    readonly stored: number;
    readonly totals: StoredAnswer<ServicesTotals> | undefined;
    readonly listed: ListedTotals;
    readonly marks: CountMarks;
  }>;
  /**
   * A stored service's page of a period, with its stored endpoints, most paid calls of the period first, and
   * what checks listed of it. Undefined: not stored.
   */
  servicePage(host: string, period: StatsPeriod): Promise<{
    readonly page: StoredAnswer<ServicePage>;
    readonly endpoints: readonly StoredEndpointRow[];
    readonly listing: HostListing;
    readonly marks: CountMarks;
  } | undefined>;
  /** What checks listed of a host, with when a check last confirmed each of `paths`: at most 100 of them. */
  hostListing(host: string, paths: readonly string[]): Promise<HostListing>;
  /** A stored endpoint. Undefined: not stored. With `timeoutMs`, the statement gives up after it, in a transaction of its own. */
  endpoint(host: string, path: string, options?: { readonly timeoutMs?: number }): Promise<{ readonly row: StoredEndpointRow; readonly marks: CountMarks } | undefined>;
}

const keys = {
  marks: { recent: 'run:recent', all: 'run:all' } satisfies Record<CountKind, string>,
  // The frequent count's cycle under way: its services, written once, and how far it is, after each batch
  cycle: 'cycle:recent',
  next: 'cycle:recent:next',
};
// Rows per insert: well under Postgres's 65,535 parameters, and few enough that one stays short
const insertBatch = 200;

const optional = <TValue>(value: TValue | null): TValue | undefined => value ?? undefined;
// LIKE's own characters match themselves
const containing = (text: string): string => `%${text.replace(/[%_\\]/g, '\\$&')}%`;
const timeoutOf = (ms: number): SQL => sql.raw(`set local statement_timeout = ${Math.max(1, Math.trunc(ms))}`);
const chunks = <TItem>(items: readonly TItem[], size: number): TItem[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));
const json = (value: unknown): SQL => sql`${JSON.stringify(value)}::jsonb`;

/** One statement in a transaction of its own, giving up after `timeoutMs`. */
const statement = async <TResult>(db: Database, timeoutMs: number, work: (tx: Parameters<Parameters<Database['transaction']>[0]>[0]) => Promise<TResult>): Promise<TResult> =>
  withTransaction(db, async tx => {
    await tx.execute(timeoutOf(timeoutMs));

    return work(tx);
  });

// The marks of both kinds of count, for a read's one statement
const marksSql = sql`(select ${statsAnswers.countedAt} from ${statsAnswers} where ${statsAnswers.key} = ${keys.marks.recent}) as marked_recent,
  (select ${statsAnswers.countedAt} from ${statsAnswers} where ${statsAnswers.key} = ${keys.marks.all}) as marked_all`;
const marksOf = (row: Readonly<Record<string, unknown>> | undefined): CountMarks => ({
  recent: row?.['marked_recent'] ? new Date(row['marked_recent'] as string) : undefined,
  all: row?.['marked_all'] ? new Date(row['marked_all'] as string) : undefined,
});

const timeOf = (value: unknown): Date | undefined => (typeof value === 'string' ? new Date(value) : undefined);

// A listed service as the list's statement gives it, as JSON
const toListedRow = (each: Readonly<Record<string, unknown>>): ListedServiceRow => ({
  hostHash: each['host_hash'] as string,
  host: each['host'] as string,
  status: each['status'] === 'checked' ? 'checked' : 'paid',
  paidEndpoints: Number(each['paid_endpoints'] ?? 0),
  priceFrom: each['price_from'] === null || each['price_from'] === undefined ? undefined : BigInt(each['price_from'] as string | number),
  calls: Number(each['calls'] ?? 0),
  buyers: Number(each['buyers'] ?? 0),
  volume: BigInt((each['volume'] ?? 0) as string | number),
  successRate: (each['success_rate'] ?? null) as number | null,
  p50Ms: (each['p50_ms'] ?? null) as number | null,
  trend: (each['trend'] ?? []) as number[],
  countedAt: timeOf(each['counted_at']),
  listedAt: timeOf(each['listed_at']),
  checkedAt: timeOf(each['checked_at']),
});

interface ListingJson {
  readonly blocked: boolean;
  readonly paid: boolean;
  readonly listed_at: string | null;
  readonly checked_at: string | null;
  readonly checked_count: number;
  readonly checked: readonly { readonly path: string; readonly method: string | null; readonly price: string | null; readonly checked_at: string | null }[];
  readonly times: Readonly<Record<string, string>>;
}

const toListing = (listing: ListingJson): HostListing => ({
  blocked: listing.blocked,
  paid: listing.paid,
  listedAt: timeOf(listing.listed_at),
  checkedAt: timeOf(listing.checked_at),
  checkedCount: listing.checked_count,
  checked: listing.checked.map(row => ({
    path: row.path, method: row.method, price: row.price === null ? undefined : BigInt(row.price), checkedAt: timeOf(row.checked_at),
  })),
  checkedTimes: new Map(Object.entries(listing.times).map(([path, at]) => [path, new Date(at)])),
});

// The blocklist names a host, or a parent domain of it, for the public reads: each name by the blocklist's key.
// Routing a call refuses the exact name alone: that is the paid path, and it stays so.
const isBlockedHost = (host: string): SQL => sql`exists (select 1 from ${hostBlocklist}
  where ${hostBlocklist.host} in (select jsonb_array_elements_text(${json(hostSuffixes(host))})))`;
// A host's name and each parent of it with two labels or more, as `hostSuffixes` gives them, for a set of rows
const suffixesOf = (host: SQL): SQL => sql`(select array_agg(array_to_string(labels[at:], '.')) from (select string_to_array(split_part(${host}, ':', 1), '.') as labels) as split,
  generate_series(1, greatest(cardinality(labels) - 1, 1)) as at)`;

/**
 * What checks listed of a host, as one JSON value: the blocklist and the checked hosts by their keys, its
 * endpoints listed only by a check by routed_endpoints_checked_idx (at most 20, and only paths the public reads
 * list), and the check times of the paths `paths` gives, each by the routed endpoints' key. A checked endpoint
 * among `paths`, the paid ones the page lists, is left out and not counted: a page holds each endpoint once.
 */
const listingSql = (host: string, paths: SQL): SQL => sql`jsonb_build_object(
  'blocked', ${isBlockedHost(host)},
  -- Its earliest paid endpoint, as an aggregate the index serves: an unordered probe may be taken as a scan
  'paid', (select min(${routedEndpoints.createdAt}) from ${routedEndpoints} where ${routedEndpoints.host} = ${host} and ${routedEndpoints.status} = 'paid') is not null,
  'listed_at', coalesce((select ${checkedHosts.listedAt} from ${checkedHosts} where ${checkedHosts.host} = ${host}), least(
    (select min(${routedEndpoints.createdAt}) from ${routedEndpoints} where ${routedEndpoints.host} = ${host} and ${routedEndpoints.status} = 'paid'),
    -- Fenced, so the at most 20 come by their index: as a bare minimum the planner may walk the catalog's index of every endpoint
    (select min(listed.created_at) from (select ${routedEndpoints.createdAt} as created_at from ${routedEndpoints}
      where ${routedEndpoints.host} = ${host} and ${routedEndpoints.status} = 'checked' offset 0) as listed))),
  'checked_at', (select ${checkedHosts.checkedAt} from ${checkedHosts} where ${checkedHosts.host} = ${host}),
  -- At most 20, as the registration's lock keeps them
  'checked_count', (select count(*)::int from ${routedEndpoints} where ${routedEndpoints.host} = ${host} and ${routedEndpoints.status} = 'checked'
    and ${routedEndpoints.path} not in (${paths})),
  'checked', coalesce((select jsonb_agg(jsonb_build_object('path', listed.path, 'method', listed.method, 'price', listed.price::text, 'checked_at', listed.checked_at)
    order by listed.checked_at desc nulls last, listed.path) from (
      select ${routedEndpoints.path} as path, ${routedEndpoints.checkMethod} as method, ${routedEndpoints.lastPrice} as price, ${routedEndpoints.checkedAt} as checked_at
      from ${routedEndpoints} where ${routedEndpoints.host} = ${host} and ${routedEndpoints.status} = 'checked' and length(${routedEndpoints.path}) <= ${maxListedPathLength}
        and ${routedEndpoints.path} not in (${paths})
      order by ${routedEndpoints.checkedAt} desc nulls last, ${routedEndpoints.path} limit ${maxCheckedEndpointsPerHost}
    ) as listed), '[]'::jsonb),
  'times', coalesce((select jsonb_object_agg(${routedEndpoints.path}, ${routedEndpoints.checkedAt}) from ${routedEndpoints}
    where ${routedEndpoints.host} = ${host} and ${routedEndpoints.path} in (${paths}) and ${routedEndpoints.checkedAt} is not null), '{}'::jsonb))`;

interface EndpointJson {
  readonly host_hash: string;
  readonly path_hash: string;
  readonly path: string;
  readonly method: string | null;
  readonly price: string | null;
  readonly recent: Record<RecentPeriod, EndpointNumbers>;
  readonly daily: number[];
  readonly counted_at: string;
  readonly all: EndpointNumbers | null;
  readonly all_counted_at: string | null;
}

const toEndpointRow = (row: EndpointJson): StoredEndpointRow => ({
  hostHash: row.host_hash,
  pathHash: row.path_hash,
  path: row.path,
  method: row.method,
  price: row.price === null ? undefined : BigInt(row.price),
  recent: row.recent,
  daily: row.daily,
  countedAt: new Date(row.counted_at),
  all: optional(row.all),
  allCountedAt: row.all_counted_at === null ? undefined : new Date(row.all_counted_at),
});

// A stored endpoint as one JSON object, its times as text
const endpointJson = sql`jsonb_build_object('host_hash', ${statsEndpoints.hostHash}, 'path_hash', ${statsEndpoints.pathHash}, 'path', ${statsEndpoints.path},
  'method', ${statsEndpoints.method}, 'price', ${statsEndpoints.price}::text, 'recent', ${statsEndpoints.recent}, 'daily', ${statsEndpoints.daily},
  'counted_at', ${statsEndpoints.countedAt}, 'all', ${statsEndpoints.all}, 'all_counted_at', ${statsEndpoints.allCountedAt})`;

// Over the listed services, by the names of the list's statement. A checked service has no calls.
const sorts: Readonly<Record<ServicesSort, SQL>> = {
  // Paid services first, then checked ones, the newest first
  calls: sql`(status = 'checked'), calls desc, case when status = 'checked' then listed_at end desc nulls last, host`,
  buyers: sql`buyers desc, (status = 'checked'), host`,
  volume: sql`volume desc, (status = 'checked'), host`,
  endpoints: sql`paid_endpoints desc, host`,
  // Cheapest first, and those without a quote last
  price: sql`price_from asc nulls last, host`,
  // The most recently listed first
  newest: sql`listed_at desc nulls last, host`,
};

export const createStatsRepository = ({ db }: StatsRepositoryOptions): StatsRepository => {
  const stored = async <TAnswer>(key: string): Promise<StoredAnswer<TAnswer> | undefined> => {
    const [row] = await db.select({ answer: statsAnswers.answer, countedAt: statsAnswers.countedAt }).from(statsAnswers).where(eq(statsAnswers.key, key));

    return row ? { answer: row.answer as unknown as TAnswer, countedAt: row.countedAt } : undefined;
  };

  return {
    putAnswers: async ({ answers, countedAt, timeoutMs }) => {
      if (answers.length === 0)
        return;
      await statement(db, timeoutMs, tx => tx.insert(statsAnswers)
        .values(answers.map(row => ({ key: row.key, answer: row.answer as JsonObject, countedAt })))
        .onConflictDoUpdate({ target: statsAnswers.key, set: { answer: sql`excluded.answer`, countedAt: sql`excluded.counted_at` } }));
    },

    putServices: async ({ rows, countedAt, timeoutMs }) => {
      let written = 0;
      for (const batch of chunks(rows, insertBatch)) {
        const result = await statement(db, timeoutMs, tx => tx.insert(statsServices).values(batch.map(row => ({
          hostHash: row.hostHash, host: row.host, paidEndpoints: row.paidEndpoints, priceFrom: row.priceFrom ?? null, calls: row.calls, buyers: row.buyers,
          volume: row.volume, successRate: row.successRate, p50Ms: row.p50Ms, trend: [...row.trend], countedAt, listedAt: row.listedAt ?? null,
        }))).onConflictDoUpdate({
          target: statsServices.hostHash,
          set: {
            host: sql`excluded.host`, paidEndpoints: sql`excluded.paid_endpoints`, priceFrom: sql`excluded.price_from`, calls: sql`excluded.calls`,
            buyers: sql`excluded.buyers`, volume: sql`excluded.volume`, successRate: sql`excluded.success_rate`, p50Ms: sql`excluded.p50_ms`,
            trend: sql`excluded.trend`, countedAt: sql`excluded.counted_at`, listedAt: sql`excluded.listed_at`,
          },
          // Only a row whose numbers changed: an unchanged one keeps its time, and the count's mark vouches for it
          setWhere: sql`(${statsServices.host}, ${statsServices.paidEndpoints}, ${statsServices.priceFrom}, ${statsServices.calls}, ${statsServices.buyers},
            ${statsServices.volume}, ${statsServices.successRate}, ${statsServices.p50Ms}, ${statsServices.trend}, ${statsServices.listedAt})
            is distinct from (excluded.host, excluded.paid_endpoints, excluded.price_from, excluded.calls, excluded.buyers, excluded.volume,
            excluded.success_rate, excluded.p50_ms, excluded.trend, excluded.listed_at)`,
        }).returning({ hostHash: statsServices.hostHash }));
        written += result.length;
      }

      return written;
    },

    putServicePages: async ({ pages, countedAt, timeoutMs }) => {
      let written = 0;
      for (const batch of chunks(pages, insertBatch)) {
        const result = await statement(db, timeoutMs, tx => tx.insert(statsServicePages)
          .values(batch.map(page => ({ hostHash: page.hostHash, period: page.period, answer: page.answer, countedAt })))
          .onConflictDoUpdate({
            target: [statsServicePages.hostHash, statsServicePages.period],
            set: { answer: sql`excluded.answer`, countedAt: sql`excluded.counted_at` },
            setWhere: sql`${statsServicePages.answer} is distinct from excluded.answer`,
          }).returning({ hostHash: statsServicePages.hostHash }));
        written += result.length;
      }

      return written;
    },

    putEndpoints: async ({ hostHashes, endpoints, countedAt, timeoutMs }) => {
      let written = 0;
      for (const batch of chunks(endpoints, insertBatch)) {
        const result = await statement(db, timeoutMs, tx => tx.insert(statsEndpoints).values(batch.map(endpoint => ({
          hostHash: endpoint.hostHash, pathHash: endpoint.pathHash, path: endpoint.path, method: endpoint.method, price: endpoint.price ?? null,
          recent: endpoint.recent as Record<RecentPeriod, EndpointNumbers>, daily: [...endpoint.daily], countedAt,
        }))).onConflictDoUpdate({
          target: [statsEndpoints.hostHash, statsEndpoints.pathHash],
          set: {
            path: sql`excluded.path`, method: sql`excluded.method`, price: sql`excluded.price`, recent: sql`excluded.recent`, daily: sql`excluded.daily`,
            countedAt: sql`excluded.counted_at`,
          },
          setWhere: sql`(${statsEndpoints.path}, ${statsEndpoints.method}, ${statsEndpoints.price}, ${statsEndpoints.recent}, ${statsEndpoints.daily})
            is distinct from (excluded.path, excluded.method, excluded.price, excluded.recent, excluded.daily)`,
        }).returning({ hostHash: statsEndpoints.hostHash }));
        written += result.length;
      }
      if (hostHashes.length === 0)
        return { written, deleted: 0 };
      // The hosts' endpoints that left their top: at most 100 each
      // The kept ones as the keys of one object: each row is looked up in it, never compared with each
      const kept = Object.fromEntries(endpoints.map(endpoint => [`${endpoint.hostHash}:${endpoint.pathHash}`, true]));
      const deleted = await statement(db, timeoutMs, tx => tx.delete(statsEndpoints).where(and(
        sql`${statsEndpoints.hostHash} = any(array(select jsonb_array_elements_text(${json(hostHashes)})))`,
        sql`not (${json(kept)} ? (${statsEndpoints.hostHash} || ':' || ${statsEndpoints.pathHash}))`,
      )).returning({ hostHash: statsEndpoints.hostHash }));

      return { written, deleted: deleted.length };
    },

    putEndpointsAll: async ({ numbers, countedAt, timeoutMs }) => {
      let written = 0;
      for (const batch of chunks(numbers, insertBatch)) {
        const given = batch.map(row => ({ host_hash: row.hostHash, path_hash: row.pathHash, all: row.all }));
        const result = await statement(db, timeoutMs, tx => tx.execute<{ host_hash: string }>(sql`update ${statsEndpoints}
          set "all" = given.all, all_counted_at = ${countedAt}
          from jsonb_to_recordset(${json(given)}) as given(host_hash text, path_hash text, "all" jsonb)
          where ${statsEndpoints.hostHash} = given.host_hash and ${statsEndpoints.pathHash} = given.path_hash and ${statsEndpoints.all} is distinct from given.all
          returning ${statsEndpoints.hostHash}`));
        written += result.rows.length;
      }

      return written;
    },

    dropOutside: async ({ hostHashes, batch, timeoutMs }) => {
      // The set as the keys of one object: each row is looked up in it, never compared with each
      const set = Object.fromEntries(hostHashes.map(hostHash => [hostHash, true]));
      const outside = (column: SQL) => sql`not (${json(set)} ? ${column})`;
      let deleted = 0;
      for (const table of [statsEndpoints, statsServicePages, statsServices] as const) {
        for (;;) {
          // A batch at a time, each a short statement
          const { rows } = await statement(db, timeoutMs, tx => tx.execute(sql`delete from ${table} where ctid in (
            select ctid from ${table} where ${outside(sql`${table.hostHash}`)} limit ${batch}
          ) returning 1`));
          deleted += rows.length;
          if (rows.length < batch)
            break;
        }
      }

      return deleted;
    },

    cycle: async ({ timeoutMs }) => {
      const rows = await statement(db, timeoutMs, tx => tx.select().from(statsAnswers).where(inArray(statsAnswers.key, [keys.cycle, keys.next])));
      const cycle = rows.find(row => row.key === keys.cycle);
      const next = rows.find(row => row.key === keys.next);

      return cycle === undefined
        ? undefined
        : { startedAt: cycle.countedAt, services: cycle.answer['services'] as StatsCycle['services'], next: Number(next?.answer['next'] ?? 0) };
    },

    startCycle: async ({ startedAt, services, next, timeoutMs }) => {
      await statement(db, timeoutMs, tx => tx.insert(statsAnswers)
        .values([{ key: keys.cycle, answer: { services: services.map(({ hostHash, host }) => ({ hostHash, host })) }, countedAt: startedAt }, { key: keys.next, answer: { next }, countedAt: startedAt }])
        .onConflictDoUpdate({ target: statsAnswers.key, set: { answer: sql`excluded.answer`, countedAt: sql`excluded.counted_at` } }));
    },

    advanceCycle: async ({ next, timeoutMs }) => {
      await statement(db, timeoutMs, tx => tx.update(statsAnswers).set({ answer: { next } }).where(eq(statsAnswers.key, keys.next)));
    },

    endCycle: async ({ timeoutMs }) => {
      await statement(db, timeoutMs, tx => tx.delete(statsAnswers).where(inArray(statsAnswers.key, [keys.cycle, keys.next])));
    },

    markComplete: async ({ kind, countedAt, timeoutMs }) => {
      await statement(db, timeoutMs, tx => tx.insert(statsAnswers).values({ key: keys.marks[kind], answer: {}, countedAt })
        .onConflictDoUpdate({ target: statsAnswers.key, set: { countedAt: sql`excluded.counted_at` } }));
    },

    storedServices: async ({ timeoutMs }) => statement(db, timeoutMs, tx => tx.select({ hostHash: statsServices.hostHash, host: statsServices.host }).from(statsServices)
      .orderBy(desc(statsServices.calls), asc(statsServices.host))),

    storedEndpointKeys: async ({ hostHashes, timeoutMs }) => hostHashes.length === 0
      ? []
      : statement(db, timeoutMs, tx => tx.select({ hostHash: statsEndpoints.hostHash, pathHash: statsEndpoints.pathHash }).from(statsEndpoints)
        .where(inArray(statsEndpoints.hostHash, [...hostHashes]))),

    platform: async () => {
      const rows = await db.select({ key: statsAnswers.key, answer: statsAnswers.answer, countedAt: statsAnswers.countedAt }).from(statsAnswers)
        .where(inArray(statsAnswers.key, ['platform', 'platform:all']));
      const of = <TAnswer>(key: string) => {
        const row = rows.find(each => each.key === key);

        return row ? { answer: row.answer as unknown as TAnswer, countedAt: row.countedAt } : undefined;
      };

      return { recent: of<PlatformRecentAnswer>('platform'), all: of<PlatformAllAnswer>('platform:all') };
    },
    top: period => stored<TopAnswer>(`top:${period}`),
    live: () => stored<LiveBase>('live'),

    services: async ({ q, sort, offset, limit }) => {
      const matching = q === undefined ? sql`true` : sql`host ilike ${containing(q)}`;
      // The stored services, with what checks listed of them by a hash of the checked hosts; then the checked
      // pool, the hosts a check reached that the count doesn't store, the 1,000 checked most recently. The
      // blocklist matched by each host's names in a hash, each table read once: no step reads a row per row,
      // so the statement grows with at most stats.maxServices and 1,000 rows, never with every host checked.
      const { rows: [row] } = await db.execute<{
        rows: unknown; total: number; stored: number; totals: ServicesTotals | null; totals_at: string | null; paid_not_stored: number; checked: number;
        added_endpoints: number; blocked: { services: number; paid_endpoints: number; calls: number } | null;
      } & Record<string, unknown>>(sql`
        with pool as (
          select ${checkedHosts.host} as host, ${checkedHosts.paidAt} as paid_at, ${checkedHosts.listedAt} as listed_at, ${checkedHosts.checkedAt} as checked_at,
            ${checkedHosts.checkedEndpoints} as endpoints, ${checkedHosts.priceFrom} as price_from
          from ${checkedHosts}
          where (${checkedHosts.checkedEndpoints} > 0 or ${checkedHosts.paidAt} is not null)
            and not exists (select 1 from ${statsServices} where ${statsServices.hostHash} = md5(${checkedHosts.host}))
          order by ${checkedHosts.checkedAt} desc, ${checkedHosts.host} limit ${maxCheckedHosts}
        ),
        listed as (
          select ${statsServices.hostHash} as host_hash, ${statsServices.host} as host, 'paid'::text as status, true as stored,
            ${statsServices.paidEndpoints} + coalesce(${checkedHosts.checkedEndpoints}, 0) as paid_endpoints, coalesce(${checkedHosts.checkedEndpoints}, 0) as added_endpoints,
            least(${statsServices.priceFrom}, ${checkedHosts.priceFrom}) as price_from, ${statsServices.calls} as calls, ${statsServices.buyers} as buyers,
            ${statsServices.volume} as volume, ${statsServices.successRate} as success_rate, ${statsServices.p50Ms} as p50_ms, ${statsServices.trend} as trend,
            ${statsServices.countedAt} as counted_at, least(${statsServices.listedAt}, ${checkedHosts.listedAt}) as listed_at, ${checkedHosts.checkedAt} as checked_at
          from ${statsServices} left join ${checkedHosts} on ${checkedHosts.host} = ${statsServices.host}
          union all
          -- Its 30 days are the count's, and it has none: no calls, and its endpoints listed by checks
          select md5(pool.host), pool.host, case when pool.paid_at is null then 'checked' else 'paid' end, false, pool.endpoints, pool.endpoints, pool.price_from,
            0, 0, 0::bigint, null::double precision, null::integer, null::jsonb, null::timestamptz, pool.listed_at, pool.checked_at
          from pool
        ),
        blocked as (
          select distinct listed.host from listed cross join lateral unnest(${suffixesOf(sql`listed.host`)}) as name
          join ${hostBlocklist} on ${hostBlocklist.host} = name
        ),
        visible as (select * from listed where host not in (select host from blocked))
        select coalesce((select json_agg(page) from (select * from visible where ${matching} order by ${sorts[sort]} offset ${offset} limit ${limit}) as page), '[]') as rows,
          (select count(*)::int from visible where ${matching}) as total,
          (select count(*)::int from ${statsServices}) as stored,
          (select count(*)::int from visible where not stored and status = 'paid') as paid_not_stored,
          (select count(*)::int from visible where status = 'checked') as checked,
          (select coalesce(sum(added_endpoints), 0)::int from visible) as added_endpoints,
          (select json_build_object('services', count(*), 'paid_endpoints', coalesce(sum(paid_endpoints - added_endpoints), 0), 'calls', coalesce(sum(calls), 0))
            from listed where stored and host in (select host from blocked)) as blocked,
          (select ${statsAnswers.answer} from ${statsAnswers} where ${statsAnswers.key} = 'services') as totals,
          (select ${statsAnswers.countedAt} from ${statsAnswers} where ${statsAnswers.key} = 'services') as totals_at,
          ${marksSql}`);
      const listed = (row?.rows ?? []) as Record<string, unknown>[];

      return {
        rows: listed.map(toListedRow),
        total: row?.total ?? 0,
        stored: Number(row?.stored ?? 0),
        totals: row?.totals && row.totals_at ? { answer: row.totals, countedAt: new Date(row.totals_at) } : undefined,
        listed: {
          paidNotStored: row?.paid_not_stored ?? 0,
          checked: row?.checked ?? 0,
          addedEndpoints: row?.added_endpoints ?? 0,
          blocked: { services: Number(row?.blocked?.services ?? 0), paidEndpoints: Number(row?.blocked?.paid_endpoints ?? 0), calls: Number(row?.blocked?.calls ?? 0) },
        },
        marks: marksOf(row),
      };
    },

    servicePage: async (host, period) => {
      // The period's own numbers order the endpoints; all time's are there once the all-time count reached them
      const order = period === 'all'
        ? sql`(${statsEndpoints.all}->>'calls')::int desc nulls last`
        : sql`(${statsEndpoints.recent}->${period}::text->>'calls')::int desc`;
      const { rows: [row] } = await db.execute<{ answer: ServicePage | null; counted_at: string | null; endpoints: EndpointJson[]; listing: ListingJson } & Record<string, unknown>>(sql`
        select page.answer, page.counted_at,
          coalesce((select jsonb_agg(endpoint order by rank) from (
            select ${endpointJson} as endpoint, row_number() over (order by ${order}, ${statsEndpoints.path}) as rank
            from ${statsEndpoints} where ${statsEndpoints.hostHash} = md5(${host}::text)${period === 'all' ? sql` and ${statsEndpoints.all} is not null` : sql``}
          ) as listed), '[]'::jsonb) as endpoints,
          ${listingSql(host, sql`select ${statsEndpoints.path} from ${statsEndpoints} where ${statsEndpoints.hostHash} = md5(${host}::text)`)} as listing,
          ${marksSql}
        from (select 1) as one left join ${statsServicePages} as page on page.host_hash = md5(${host}::text) and page.period = ${period}::text`);
      if (!row?.answer || !row.counted_at)
        return undefined;

      return {
        page: { answer: row.answer, countedAt: new Date(row.counted_at) }, endpoints: row.endpoints.map(toEndpointRow), listing: toListing(row.listing), marks: marksOf(row),
      };
    },

    hostListing: async (host, paths) => {
      const { rows: [row] } = await db.execute<{ listing: ListingJson }>(sql`select ${listingSql(host, sql`select jsonb_array_elements_text(${json(paths.slice(0, 100))})`)} as listing`);

      return toListing(row!.listing);
    },

    endpoint: async (host, path, options) => {
      const read = (executor: DatabaseExecutor) => executor.execute<{ endpoint: EndpointJson | null } & Record<string, unknown>>(sql`
        select (select ${endpointJson} from ${statsEndpoints} where ${statsEndpoints.hostHash} = md5(${host}::text) and ${statsEndpoints.pathHash} = md5(${path}::text)
          and ${statsEndpoints.path} = ${path}) as endpoint, ${marksSql}`);
      const { rows: [row] } = options?.timeoutMs === undefined ? await read(db) : await statement(db, options.timeoutMs, read);

      return row?.endpoint ? { row: toEndpointRow(row.endpoint), marks: marksOf(row) } : undefined;
    },
  };
};
