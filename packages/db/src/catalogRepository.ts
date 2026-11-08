import { and, asc, sql } from 'drizzle-orm';

import type { MicroUsd } from '@anyfare/common';

import type { DatabaseExecutor } from './postgres.js';
import { routedEndpoints } from './schema/routing.js';

export interface CatalogRepositoryOptions {
  readonly db: DatabaseExecutor;
}

export interface RoutedCatalogEntry {
  readonly host: string;
  readonly path: string;
  // Undefined: no quote yet
  readonly lastPrice: MicroUsd | undefined;
  readonly createdAt: Date;
}

/** The routed endpoints the catalog lists. */
export interface CatalogRepository {
  /**
   * Routed endpoints, oldest first, with how many match. `q` is a case-insensitive substring of the
   * host followed by the path; `maxPrice` leaves out endpoints with no quote.
   */
  routed(input: {
    readonly q?: string;
    readonly maxPrice?: MicroUsd;
    readonly limit: number;
    readonly offset: number;
  }): Promise<{ readonly entries: readonly RoutedCatalogEntry[]; readonly total: number }>;
}

export const createCatalogRepository = ({ db }: CatalogRepositoryOptions): CatalogRepository => ({
  routed: async ({ q, maxPrice, limit, offset }) => {
    const where = [
      ...q ? [sql`(${routedEndpoints.host} || ${routedEndpoints.path}) ilike ${`%${q.replace(/[%_\\]/g, '\\$&')}%`}`] : [],
      ...maxPrice !== undefined ? [sql`${routedEndpoints.lastPrice} <= ${maxPrice}`] : [],
    ];
    const condition = where.length > 0 ? and(...where) : undefined;
    const rows = await db.select().from(routedEndpoints).where(condition)
      .orderBy(asc(routedEndpoints.createdAt), asc(routedEndpoints.host), asc(routedEndpoints.path)).limit(limit).offset(offset);
    const [counted] = await db.select({ count: sql<number>`count(*)::int` }).from(routedEndpoints).where(condition);

    return {
      entries: rows.map(row => ({ host: row.host, path: row.path, lastPrice: row.lastPrice ?? undefined, createdAt: row.createdAt })),
      total: counted?.count ?? 0,
    };
  },
});
