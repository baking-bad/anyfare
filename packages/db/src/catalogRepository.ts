import { sql, type SQL } from 'drizzle-orm';

import type { MicroUsd } from '@anyfare/common';

import type { DatabaseExecutor } from './postgres.js';
import { hostBlocklist, routedEndpoints, type RoutedEndpointStatus } from './schema/routing.js';

// The catalog reaches this many endpoints deep, oldest first, and its filters search no further
export const catalogDepth = 10_000;

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

/** The routed endpoints the catalog lists. */
export interface CatalogRepository {
  /**
   * A page of routed endpoints, of paid calls and of checks, oldest first, none of a host the blocklist names
   * or names a parent domain of, and whether more follow. `q` is a case-insensitive substring of the host followed
   * by the path; `maxPrice` leaves out endpoints with no quote. Both search the oldest `catalogDepth` only.
   */
  routed(input: {
    readonly q?: string;
    readonly maxPrice?: MicroUsd;
    readonly limit: number;
    readonly offset: number;
  }): Promise<{ readonly entries: readonly RoutedCatalogEntry[]; readonly more: boolean }>;
}

// A host's name and each parent of it with two labels or more, for the blocklist's key
const blockedSql = (host: SQL): SQL => sql`exists (select 1 from ${hostBlocklist} where ${hostBlocklist.host} in (
  select array_to_string(labels[at:], '.') from (select string_to_array(split_part(${host}, ':', 1), '.') as labels) as split,
    generate_series(1, greatest(cardinality(labels) - 1, 1)) as at))`;

export const createCatalogRepository = ({ db }: CatalogRepositoryOptions): CatalogRepository => ({
  routed: async ({ q, maxPrice, limit, offset }) => {
    if (offset >= catalogDepth)
      return { entries: [], more: false };
    const filters = [
      ...q ? [sql`(oldest.host || oldest.path) ilike ${`%${q.replace(/[%_\\]/g, '\\$&')}%`}`] : [],
      ...maxPrice !== undefined ? [sql`oldest.last_price <= ${maxPrice}`] : [],
      // Read at once: a blocked host leaves before any count
      sql`not ${blockedSql(sql`oldest.host`)}`,
    ];
    // In order by routed_endpoints_created_idx, read only as far as the page needs, and never past the depth
    const { rows } = await db.execute<{ host: string; path: string; last_price: string | null; created_at: string; status: RoutedEndpointStatus }>(sql`
      select oldest.host, oldest.path, oldest.last_price::text as last_price, oldest.created_at, oldest.status from (
        select ${routedEndpoints.host} as host, ${routedEndpoints.path} as path, ${routedEndpoints.lastPrice} as last_price,
          ${routedEndpoints.createdAt} as created_at, ${routedEndpoints.status} as status
        from ${routedEndpoints} order by ${routedEndpoints.createdAt}, ${routedEndpoints.host}, ${routedEndpoints.path} limit ${catalogDepth}
      ) as oldest
      where ${sql.join(filters, sql` and `)}
      order by oldest.created_at, oldest.host, oldest.path offset ${offset} limit ${limit + 1}`);

    return {
      entries: rows.slice(0, limit).map(row => ({
        host: row.host, path: row.path, lastPrice: row.last_price === null ? undefined : BigInt(row.last_price) as MicroUsd, createdAt: new Date(row.created_at),
        status: row.status,
      })),
      more: rows.length > limit && offset + limit < catalogDepth,
    };
  },
});
