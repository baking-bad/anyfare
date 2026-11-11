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
   * followed by the path; `maxPrice` leaves out endpoints with no quote. A page reads at most `catalogScanBudget`
   * rows: `partial` says the budget ended its search before the end. One statement or two, each giving up after
   * `timeoutMs`.
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

const keyOf = (row: { readonly created_at: string; readonly host: string; readonly path: string }): CatalogCursor => ({
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
      const filters = [
        ...q ? [sql`(scanned.host || scanned.path) ilike ${`%${q.replace(/[%_\\]/g, '\\$&')}%`}`] : [],
        ...maxPrice !== undefined ? [sql`scanned.last_price <= ${maxPrice}`] : [],
      ];
      const wanted = limit + 1 + blockedMargin;
      // Read only as far as the page needs, and never past the budget
      const rows = await statement<{ host: string; path: string; last_price: string | null; created_at: string; status: RoutedEndpointStatus }>(timeoutMs, sql`
        select scanned.host, scanned.path, scanned.last_price::text as last_price, scanned.created_at, scanned.status from (
          select ${routedEndpoints.host} as host, ${routedEndpoints.path} as path, ${routedEndpoints.lastPrice} as last_price,
            ${routedEndpoints.createdAt} as created_at, ${routedEndpoints.status} as status
          from ${routedEndpoints} where ${following} order by ${order} limit ${catalogScanBudget}
        ) as scanned
        where ${filters.length === 0 ? sql`true` : sql.join(filters, sql` and `)}
        order by scanned.created_at, scanned.host, scanned.path limit ${wanted}`);
      const shown = rows.filter(row => !isBlocked(row.host));
      const entries = shown.slice(0, limit).map(row => ({
        host: row.host, path: row.path, lastPrice: row.last_price === null ? undefined : BigInt(row.last_price) as MicroUsd, createdAt: new Date(row.created_at),
        status: row.status,
      }));
      if (shown.length > limit)
        return { entries, next: keyOf(shown[limit - 1]!), partial: false };
      if (rows.length === wanted)
        return { entries, next: keyOf(rows[wanted - 1]!), partial: false };
      if (filters.length === 0)
        return { entries, next: undefined, partial: false };
      // The search read its whole budget, or came to the end: the budget's last row, if any, is where it goes on
      const [last] = await statement<{ host: string; path: string; created_at: string }>(timeoutMs, sql`
        select ${routedEndpoints.host} as host, ${routedEndpoints.path} as path, ${routedEndpoints.createdAt} as created_at
        from ${routedEndpoints} where ${following} order by ${order} offset ${catalogScanBudget - 1} limit 1`);

      return last === undefined ? { entries, next: undefined, partial: false } : { entries, next: keyOf(last), partial: true };
    },
  };
};
