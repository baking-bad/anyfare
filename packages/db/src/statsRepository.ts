import { and, asc, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';

import type {
  EndpointNumbers, JsonObject, LiveBase, PlatformAllAnswer, PlatformRecentAnswer, RecentPeriod, ServicePage, ServiceRow, ServicesTotals, StatsPeriod,
  StoredEndpoint, TopAnswer,
} from '@anyfare/core';

import { withTransaction, type Database, type DatabaseExecutor } from './postgres.js';
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

export type ServicesSort = 'calls' | 'buyers' | 'volume' | 'endpoints' | 'price';

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
  /** A page of stored services, how many match `q`, a part of the host without case, the totals, and the marks. */
  services(input: { readonly q?: string; readonly sort: ServicesSort; readonly offset: number; readonly limit: number }): Promise<{
    readonly rows: readonly (ServiceRow & { readonly countedAt: Date })[];
    readonly total: number;
    // Every stored service, whatever `q` says
    readonly stored: number;
    readonly totals: StoredAnswer<ServicesTotals> | undefined;
    readonly marks: CountMarks;
  }>;
  /** A stored service's page of a period, with its stored endpoints, most paid calls of the period first. Undefined: not stored. */
  servicePage(host: string, period: StatsPeriod): Promise<{
    readonly page: StoredAnswer<ServicePage>;
    readonly endpoints: readonly StoredEndpointRow[];
    readonly marks: CountMarks;
  } | undefined>;
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

const toServiceRow = (row: typeof statsServices.$inferSelect): ServiceRow & { readonly countedAt: Date } => ({
  hostHash: row.hostHash,
  host: row.host,
  paidEndpoints: row.paidEndpoints,
  priceFrom: optional(row.priceFrom),
  calls: row.calls,
  buyers: row.buyers,
  volume: row.volume,
  successRate: row.successRate,
  p50Ms: row.p50Ms,
  trend: row.trend,
  countedAt: row.countedAt,
});

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

const sorts: Readonly<Record<ServicesSort, readonly SQL[]>> = {
  calls: [desc(statsServices.calls), asc(statsServices.host)],
  buyers: [desc(statsServices.buyers), asc(statsServices.host)],
  volume: [desc(statsServices.volume), asc(statsServices.host)],
  endpoints: [desc(statsServices.paidEndpoints), asc(statsServices.host)],
  // Cheapest first, and those without a quote last
  price: [sql`${statsServices.priceFrom} asc nulls last`, asc(statsServices.host)],
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
          volume: row.volume, successRate: row.successRate, p50Ms: row.p50Ms, trend: [...row.trend], countedAt,
        }))).onConflictDoUpdate({
          target: statsServices.hostHash,
          set: {
            host: sql`excluded.host`, paidEndpoints: sql`excluded.paid_endpoints`, priceFrom: sql`excluded.price_from`, calls: sql`excluded.calls`,
            buyers: sql`excluded.buyers`, volume: sql`excluded.volume`, successRate: sql`excluded.success_rate`, p50Ms: sql`excluded.p50_ms`,
            trend: sql`excluded.trend`, countedAt: sql`excluded.counted_at`,
          },
          // Only a row whose numbers changed: an unchanged one keeps its time, and the count's mark vouches for it
          setWhere: sql`(${statsServices.host}, ${statsServices.paidEndpoints}, ${statsServices.priceFrom}, ${statsServices.calls}, ${statsServices.buyers},
            ${statsServices.volume}, ${statsServices.successRate}, ${statsServices.p50Ms}, ${statsServices.trend})
            is distinct from (excluded.host, excluded.paid_endpoints, excluded.price_from, excluded.calls, excluded.buyers, excluded.volume,
            excluded.success_rate, excluded.p50_ms, excluded.trend)`,
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
      const matching = q === undefined ? sql`true` : sql`${statsServices.host} ilike ${containing(q)}`;
      const page = db.select().from(statsServices).where(matching).orderBy(...sorts[sort]).offset(offset).limit(limit);
      const { rows: [row] } = await db.execute<{ rows: unknown; total: number; totals: ServicesTotals | null; totals_at: string | null } & Record<string, unknown>>(sql`
        select coalesce((select json_agg(page) from (${page}) as page), '[]') as rows,
          (select count(*)::int from ${statsServices} where ${matching}) as total,
          (select count(*)::int from ${statsServices}) as stored,
          (select ${statsAnswers.answer} from ${statsAnswers} where ${statsAnswers.key} = 'services') as totals,
          (select ${statsAnswers.countedAt} from ${statsAnswers} where ${statsAnswers.key} = 'services') as totals_at,
          ${marksSql}`);
      const listed = (row?.rows ?? []) as Record<string, unknown>[];

      return {
        rows: listed.map(each => toServiceRow({
          hostHash: each['host_hash'] as string, host: each['host'] as string, paidEndpoints: each['paid_endpoints'] as number,
          priceFrom: each['price_from'] === null ? null : BigInt(each['price_from'] as string | number), calls: each['calls'] as number,
          buyers: each['buyers'] as number, volume: BigInt(each['volume'] as string | number), successRate: each['success_rate'] as number | null,
          p50Ms: each['p50_ms'] as number | null, trend: each['trend'] as number[], countedAt: new Date(each['counted_at'] as string),
        })),
        total: row?.total ?? 0,
        stored: Number(row?.['stored'] ?? 0),
        totals: row?.totals && row.totals_at ? { answer: row.totals, countedAt: new Date(row.totals_at) } : undefined,
        marks: marksOf(row),
      };
    },

    servicePage: async (host, period) => {
      // The period's own numbers order the endpoints; all time's are there once the all-time count reached them
      const order = period === 'all'
        ? sql`(${statsEndpoints.all}->>'calls')::int desc nulls last`
        : sql`(${statsEndpoints.recent}->${period}::text->>'calls')::int desc`;
      const { rows: [row] } = await db.execute<{ answer: ServicePage | null; counted_at: string | null; endpoints: EndpointJson[] } & Record<string, unknown>>(sql`
        select page.answer, page.counted_at,
          coalesce((select jsonb_agg(endpoint order by rank) from (
            select ${endpointJson} as endpoint, row_number() over (order by ${order}, ${statsEndpoints.path}) as rank
            from ${statsEndpoints} where ${statsEndpoints.hostHash} = md5(${host}::text)${period === 'all' ? sql` and ${statsEndpoints.all} is not null` : sql``}
          ) as listed), '[]'::jsonb) as endpoints,
          ${marksSql}
        from (select 1) as one left join ${statsServicePages} as page on page.host_hash = md5(${host}::text) and page.period = ${period}::text`);
      if (!row?.answer || !row.counted_at)
        return undefined;

      return { page: { answer: row.answer, countedAt: new Date(row.counted_at) }, endpoints: row.endpoints.map(toEndpointRow), marks: marksOf(row) };
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
