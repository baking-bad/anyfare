import { sql, type SQL } from 'drizzle-orm';

import type { MicroUsd } from '@anyfare/common';

import { withTransaction, type DatabaseExecutor } from './postgres.js';
import { routedEndpoints, type RoutedEndpointStatus } from './schema/routing.js';

// The rows one page reads at most, matched or not: a search goes on from where it stopped on the next page
export const catalogScanBudget = 1_000;
// The rows a page takes beyond its size, for the blocklist to leave out without a short page
const blockedMargin = 64;

export interface CatalogRepositoryOptions {
  readonly db: DatabaseExecutor;
}

export interface RoutedCatalogEntry {
  readonly host: string;
  readonly path: string;
  // Undefined: no quote yet
  readonly lastPrice: MicroUsd | undefined;
  readonly createdAt: Date;
  // Reached by a paid call, or listed only by a check
  readonly status: RoutedEndpointStatus;
}

/** Where a page of the catalog goes on from: the last endpoint read, in the catalog's order. */
export interface CatalogCursor {
  readonly createdAt: Date;
  readonly host: string;
  readonly path: string;
}

/** The routed endpoints the catalog lists. */
export interface CatalogRepository {
  /**
   * A page of routed endpoints, of paid calls and of checks, oldest first, after `after`, none of a host `isBlocked`
   * says the blocklist names, and where the next page goes on from. `q` is a case-insensitive substring of the host
   * followed by the path; `maxPrice` leaves out endpoints with no quote. A search reads at most `catalogScanBudget`
   * rows a page. `partial`: the page goes on, with fewer than `limit` endpoints, as a search's budget or the blocklist
   * left it. One statement, giving up after `timeoutMs`.
   */
  routed(input: {
    readonly q?: string;
    readonly maxPrice?: MicroUsd;
    readonly limit: number;
    readonly after?: CatalogCursor;
    readonly isBlocked: (host: string) => boolean;
    readonly timeoutMs: number;
  }): Promise<{ readonly entries: readonly RoutedCatalogEntry[]; readonly next: CatalogCursor | undefined; readonly partial: boolean }>;
}

type CatalogRow = {
  readonly host: string;
  readonly path: string;
  readonly last_price: string | null;
  readonly created_at: string;
  readonly status: RoutedEndpointStatus;
};

const keyOf = (row: { readonly created_at: string | Date; readonly host: string; readonly path: string }): CatalogCursor => ({
  createdAt: new Date(row.created_at), host: row.host, path: row.path,
});

export const createCatalogRepository = ({ db }: CatalogRepositoryOptions): CatalogRepository => {
  const statement = async <TRow extends Record<string, unknown>>(timeoutMs: number, query: SQL): Promise<TRow[]> => withTransaction(db, async tx => {
    await tx.execute(sql.raw(`set local statement_timeout = ${Math.max(1, Math.trunc(timeoutMs))}`));

    return (await tx.execute<TRow>(query)).rows as TRow[];
  });

  return {
    routed: async ({ q, maxPrice, limit, after, isBlocked, timeoutMs }) => {
      // After the cursor, by routed_endpoints_catalog_idx: its time, then its host and path among those of one time, as
      // one row of the index's columns, so the scan starts right after it
      const following = after === undefined
        ? sql`true`
        : sql`(${routedEndpoints.createdAt}, ${routedEndpoints.host}, ${routedEndpoints.path}) > (${after.createdAt}::timestamptz, ${after.host}::text, ${after.path}::text)`;
      const order = sql`${routedEndpoints.createdAt}, ${routedEndpoints.host}, ${routedEndpoints.path}`;
      // A part of the host and path, without case: one pass over each row, whatever the search holds
      const filters = [
        ...q ? [sql`strpos(lower(scan.host || scan.path), ${q.toLowerCase()}) > 0`] : [],
        ...maxPrice !== undefined ? [sql`scan.last_price <= ${maxPrice}`] : [],
      ];
      const wanted = limit + 1 + blockedMargin;
      const columns = sql`${routedEndpoints.host} as host, ${routedEndpoints.path} as path, ${routedEndpoints.lastPrice} as last_price,
        ${routedEndpoints.createdAt} as created_at, ${routedEndpoints.status} as status`;
      let rows: CatalogRow[];
      let windowEnd: CatalogCursor | undefined;
      if (filters.length === 0) {
        // Only as far as the page needs: every row it reads is one it may show
        rows = await statement<CatalogRow>(timeoutMs, sql`select scan.host, scan.path, scan.last_price::text as last_price, scan.created_at, scan.status
          from (select ${columns} from ${routedEndpoints} where ${following} order by ${order} limit ${wanted}) as scan`);
      }
      else {
        // A search reads its budget's window once, and says where the window ends: the next page goes on from there, so
        // no row written or taken out meanwhile is skipped or read twice
        const [found] = await statement<{ rows: CatalogRow[]; last: { host: string; path: string; created_at: string } | null; scanned: number }>(timeoutMs, sql`
          with scan as materialized (
            select ${columns} from ${routedEndpoints} where ${following} order by ${order} limit ${catalogScanBudget}
          )
          select coalesce((select json_agg(matched order by matched.created_at, matched.host, matched.path) from (
              select scan.host, scan.path, scan.last_price::text as last_price, scan.created_at, scan.status from scan
              where ${sql.join(filters, sql` and `)} order by scan.created_at, scan.host, scan.path limit ${wanted}
            ) as matched), '[]'::json) as rows,
            (select json_build_object('host', scan.host, 'path', scan.path, 'created_at', scan.created_at) from scan
              order by scan.created_at desc, scan.host desc, scan.path desc limit 1) as last,
            (select count(*)::int from scan) as scanned`);
        rows = found?.rows ?? [];
        windowEnd = found?.last && found.scanned >= catalogScanBudget ? keyOf(found.last) : undefined;
      }
      const shown = rows.filter(row => !isBlocked(row.host));
      const entries = shown.slice(0, limit).map(row => ({
        host: row.host, path: row.path, lastPrice: row.last_price === null ? undefined : BigInt(row.last_price) as MicroUsd, createdAt: new Date(row.created_at),
        status: row.status,
      }));
      // Where the next page goes on from: after the last one shown of a full page, after the last row read when the
      // blocklist took some out, or after the search's window when its budget ended it. None: the end.
      const next = shown.length > limit
        ? keyOf(shown[limit - 1]!)
        : rows.length === wanted ? keyOf(rows[wanted - 1]!) : windowEnd;

      // A page that goes on with fewer than `limit` endpoints says so, whatever the reason: a client never stops at it
      return { entries, next, partial: next !== undefined && entries.length < limit };
    },
  };
};
