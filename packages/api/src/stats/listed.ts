import { formatUsd } from '@anyfare/common';
import {
  checkedEndpointEntry, endpointListEntry, endpointNumbersOf, endpointsPerService, lastUtcDays, maxListedPathLength, parentDomainOf, statsDailyDays,
  storedPathBytesPerService, type EndpointListEntry, type ListedEndpointEntry, type ListedStatus, type TopAnswer,
} from '@anyfare/core';
import { maxCheckedHostsPerParent, type CountMarks, type HostListing, type ListedServiceRow, type ListedServices, type ServicesSort } from '@anyfare/db';

// What the public list, a service's page and the top lists show of what the reads gave, without a database: the
// blocklist applied, the checked pool held to its caps, and each endpoint counted once.

const iso = (time: Date | undefined): string | null => time?.toISOString() ?? null;
const later = (a: Date, b: Date | undefined): Date => (b !== undefined && b.getTime() > a.getTime() ? b : a);
const earliest = (times: readonly Date[]): Date => new Date(Math.min(...times.map(time => time.getTime())));
// In code points: hosts are lowercase ASCII
const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const timeOf = (time: Date | undefined): number | undefined => time?.getTime();
// Descending, with none last
const newestFirst = (a: Date | undefined, b: Date | undefined): number => (timeOf(b) ?? -Infinity) - (timeOf(a) ?? -Infinity) || 0;
const checkedLast = (a: ListedServiceRow, b: ListedServiceRow): number => Number(a.status === 'checked') - Number(b.status === 'checked');

const orders: Readonly<Record<ServicesSort, (a: ListedServiceRow, b: ListedServiceRow) => number>> = {
  // Paid services first, then checked ones, the newest first
  calls: (a, b) => checkedLast(a, b) || b.calls - a.calls || (a.status === 'checked' ? newestFirst(a.listedAt, b.listedAt) : 0) || compareText(a.host, b.host),
  buyers: (a, b) => b.buyers - a.buyers || checkedLast(a, b) || compareText(a.host, b.host),
  volume: (a, b) => (b.volume > a.volume ? 1 : b.volume < a.volume ? -1 : 0) || checkedLast(a, b) || compareText(a.host, b.host),
  endpoints: (a, b) => b.paidEndpoints - a.paidEndpoints || compareText(a.host, b.host),
  // Cheapest first, and those without a quote last
  price: (a, b) => (a.priceFrom === undefined ? (b.priceFrom === undefined ? 0 : 1) : b.priceFrom === undefined ? -1 : a.priceFrom < b.priceFrom ? -1 : a.priceFrom > b.priceFrom ? 1 : 0)
    || compareText(a.host, b.host),
  // The most recently listed first
  newest: (a, b) => newestFirst(a.listedAt, b.listedAt) || compareText(a.host, b.host),
};

/**
 * The services the list shows, from one read of every kind, in its order: each host once, none the blocklist names
 * or names a parent domain of, and of the checked pool, read the most recently checked first, the 20 newest of one
 * parent domain, a blocked one among them counted as a service's page counts it. A paid service is never left out for
 * its parent domain.
 */
export const shownServices = (listed: ListedServices, isBlocked: (host: string) => boolean): ListedServiceRow[] => {
  const seen = new Set<string>();
  const perParent = new Map<string, number>();
  const shown: ListedServiceRow[] = [];
  for (const row of listed.rows) {
    if (seen.has(row.host))
      continue;
    if (row.kind === 'checked') {
      const parent = parentDomainOf(row.host);
      const held = perParent.get(parent) ?? 0;
      perParent.set(parent, held + 1);
      if (held >= maxCheckedHostsPerParent)
        continue;
    }
    seen.add(row.host);
    if (!isBlocked(row.host))
      shown.push(row);
  }

  return shown;
};

/**
 * The totals of the services the list shows, each once: `services` all of them, `paidServices` those with a paid
 * endpoint, `paidEndpoints` their listed endpoints, of paid calls and of checks, each once. `calls30d` is the count's,
 * without the stored services the blocklist names.
 */
export const servicesTotals = (input: {
  readonly listed: ListedServices;
  readonly shown: readonly ListedServiceRow[];
  readonly isBlocked: (host: string) => boolean;
}) => {
  const { listed, shown, isBlocked } = input;
  const blockedCalls = listed.rows.filter(row => row.kind === 'stored' && isBlocked(row.host)).reduce((sum, row) => sum + row.calls, 0);

  return {
    services: shown.length,
    paidServices: shown.filter(row => row.status === 'paid').length,
    paidEndpoints: shown.reduce((sum, row) => sum + row.paidEndpoints, 0),
    calls30d: Math.max(0, (listed.totals?.answer.calls30d ?? 0) - blockedCalls),
  };
};

/** The rows the list shows, sorted by `sort` once per read. */
export interface ShownServices {
  readonly listed: ListedServices;
  readonly shown: readonly ListedServiceRow[];
  readonly totals: ReturnType<typeof servicesTotals>;
  sorted(sort: ServicesSort): readonly ListedServiceRow[];
}

export const createShownServices = (listed: ListedServices, isBlocked: (host: string) => boolean): ShownServices => {
  const shown = shownServices(listed, isBlocked);
  const sorted = new Map<ServicesSort, readonly ListedServiceRow[]>();

  return {
    listed,
    shown,
    totals: servicesTotals({ listed, shown, isBlocked }),
    sorted: sort => {
      let rows = sorted.get(sort);
      if (!rows) {
        rows = [...shown].sort(orders[sort]);
        sorted.set(sort, rows);
      }

      return rows;
    },
  };
};

/** When a stored row's 30 days are true: its own time, or the last complete count of them, which left it in place. */
const verifiedAt = (countedAt: Date, marks: CountMarks): Date => later(countedAt, marks.recent);

/** A page of the list: `q` a part of the host, lowercase; the rows of the page, their total, and the totals of all. */
export const servicesPage = (input: {
  readonly services: ShownServices;
  readonly q: string | undefined;
  readonly sort: ServicesSort;
  readonly page: number;
  readonly size: number;
  readonly now: Date;
}) => {
  const { services, q, sort, page, size, now } = input;
  const { listed, totals } = services;
  const matching = q === undefined ? services.sorted(sort) : services.sorted(sort).filter(row => row.host.includes(q));
  const rows = matching.slice((page - 1) * size, page * size);
  // The oldest time of what the page shows: a service not stored is read now
  const times = [
    ...listed.totals ? [listed.totals.countedAt] : [],
    ...rows.flatMap(row => (row.countedAt === undefined ? [] : [verifiedAt(row.countedAt, listed.marks)])),
  ];
  const noTrend = lastUtcDays(now, statsDailyDays).map(() => 0);

  return {
    services: rows.map(row => ({
      host: row.host,
      status: row.status,
      paidEndpoints: row.paidEndpoints,
      priceFrom: row.priceFrom === undefined ? null : formatUsd(row.priceFrom),
      currency: 'USD',
      calls: row.calls,
      buyers: row.buyers,
      volume: formatUsd(row.volume),
      successRate: row.successRate,
      p50Ms: row.p50Ms,
      trend: row.countedAt === undefined ? noTrend : row.trend,
      listedAt: iso(row.listedAt),
      checkedAt: iso(row.checkedAt),
    })),
    page,
    size,
    total: matching.length,
    totalCapped: (listed.totals?.answer.services ?? 0) > listed.stored,
    totals,
    updatedAt: times.length === 0 ? null : earliest(times).toISOString(),
  };
};

/**
 * A service page's endpoints, each once, within the bounds of a stored service's: 100, paths of at most 512
 * characters and 24 KB of them in all. Its paid endpoints with numbers of the period first, most calls first; then
 * its other paid ones, newest first, with no numbers; then those listed only by a check, newest checked first.
 */
export const listedEndpoints = (input: {
  readonly host: string;
  readonly payUrl: string;
  readonly ranked: readonly EndpointListEntry[];
  readonly listing: HostListing;
}): ListedEndpointEntry[] => {
  const { host, payUrl, ranked, listing } = input;
  const listed: ListedEndpointEntry[] = [];
  const paths = new Set<string>();
  let chars = 0;
  const add = (entry: ListedEndpointEntry): void => {
    if (listed.length >= endpointsPerService || paths.has(entry.path) || entry.path.length > maxListedPathLength
      || chars + entry.path.length > storedPathBytesPerService)
      return;
    paths.add(entry.path);
    chars += entry.path.length;
    listed.push(entry);
  };
  for (const entry of ranked)
    add({ ...entry, status: 'paid', checkedAt: iso(listing.checkedTimes.get(entry.path)) });
  for (const row of listing.paidRows) {
    add({
      ...endpointListEntry({ host, path: row.path, method: row.method, price: row.price, numbers: endpointNumbersOf(undefined), payUrl }),
      status: 'paid', checkedAt: iso(row.checkedAt),
    });
  }
  for (const row of listing.checked)
    add(checkedEndpointEntry({ host, path: row.path, method: row.method, price: row.price, checkedAt: row.checkedAt, payUrl }));

  return listed;
};

/**
 * A service page's listed parts. `paidEndpoints` counts its listed endpoints, paid or checked, each once, as the list
 * does: its row of paid hosts', or before one, `countedEndpoints`, the count's, and those listed only by a check.
 */
export const listedPage = (input: {
  readonly host: string;
  readonly payUrl: string;
  readonly ranked: readonly EndpointListEntry[];
  readonly countedEndpoints: number;
  readonly listing: HostListing;
  readonly status: ListedStatus;
}) => {
  const { listing } = input;

  return {
    status: input.status,
    listedAt: iso(listing.listedAt),
    checkedAt: iso(listing.checkedAt),
    paidEndpoints: listing.paidSummary?.endpoints ?? input.countedEndpoints + listing.checkedCount,
    endpoints: listedEndpoints(input),
  };
};

/**
 * Whether a host's page is not found: the blocklist names it or a parent domain of it, or the list doesn't show it.
 * `paid`: a paid call reached it, as its numbers or the listing says. A paid one the count doesn't store is shown
 * among the newest registered; one listed only by checks, while it is of the checked pool and within its caps.
 */
export const isUnlisted = (listing: HostListing, stored: boolean, paid: boolean): boolean => {
  if (listing.blocked)
    return true;
  if (stored)
    return false;
  if (paid || listing.paid)
    return listing.paidHidden;

  return !listing.pooled || listing.poolHidden;
};

/** The top lists without a host the blocklist names, or names a parent domain of. */
export const topWithoutBlocked = (top: TopAnswer, isBlocked: (host: string) => boolean): TopAnswer => ({
  ...top,
  services: top.services.filter(service => !isBlocked(service.host)),
  endpoints: top.endpoints.filter(endpoint => !isBlocked(endpoint.host)),
});
