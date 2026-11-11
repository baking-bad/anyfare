import { formatUsd, type MicroUsd } from '@anyfare/common';

// The public numbers: what the workers count from the finished calls and the credited top-ups, and the
// ready answers the API serves from what they wrote, or from a bounded read when they wrote none. "Calls"
// are paid calls; a free call counts only toward a success rate. A day is a UTC day. Nothing here names
// a Credits buyer.

/** The day so far, the last 7 and 30 days with today, and all time. */
export const statsPeriods = ['today', '7d', '30d', 'all'] as const;
export type StatsPeriod = typeof statsPeriods[number];
// Counted every few minutes; all time is counted on its own, less often
export const recentPeriods = ['today', '7d', '30d'] as const;
export type RecentPeriod = typeof recentPeriods[number];

const dayMs = 86_400_000;
const minuteMs = 60_000;
const periodDays: Readonly<Record<RecentPeriod, number>> = { today: 1, '7d': 7, '30d': 30 };
// The daily series of the platform and of each service, and of each endpoint
export const statsDailyDays = 30;
export const endpointDailyDays = 14;
// The live numbers' calls per minute
export const liveMinutes = 30;
// Each top list
export const topListSize = 5;
// The endpoints one service keeps and lists, by paid calls: its count says how many it has in all
export const endpointsPerService = 100;
// The longest path the counts keep and list, and the longest host routing keeps: longer ones are counted,
// never stored, listed or linked, and the endpoint read reads them when asked for
export const maxListedPathLength = 512;
export const maxListedHostLength = 259;
// The path text one service keeps in all, in rank order: what its served answer holds stays small
export const storedPathBytesPerService = 24_576;
// The longest path the endpoint read takes
export const maxEndpointReadPathLength = 2_048;

export const utcDayStart = (time: Date): Date => new Date(Math.floor(time.getTime() / dayMs) * dayMs);
export const minuteStart = (time: Date): Date => new Date(Math.floor(time.getTime() / minuteMs) * minuteMs);

/** When a period starts, at a UTC midnight. Undefined for all. */
export const periodStart = (period: StatsPeriod, now: Date): Date | undefined =>
  period === 'all' ? undefined : new Date(utcDayStart(now).getTime() - (periodDays[period] - 1) * dayMs);

/** The period before one: as many UTC days, ending where it starts. */
export const periodBefore = (period: RecentPeriod, now: Date): { readonly from: Date; readonly to: Date } => {
  const to = periodStart(period, now)!;

  return { from: new Date(to.getTime() - periodDays[period] * dayMs), to };
};

/** The last `count` UTC days to `now`'s, oldest first, as YYYY-MM-DD. */
export const lastUtcDays = (now: Date, count: number): readonly string[] => {
  const today = utcDayStart(now).getTime();

  return Array.from({ length: count }, (_, index) => new Date(today - (count - 1 - index) * dayMs).toISOString().slice(0, 10));
};

/** Calls counted together: paid ones, and the free ones a success rate needs. */
export interface CallCounts {
  readonly calls: number;
  // What the paid calls paid
  readonly volume: MicroUsd;
  // Distinct buyers of the paid calls
  readonly buyers: number;
  // Finished calls whose buyer wasn't charged
  readonly free: number;
  // The API's time over the finished calls it answered
  readonly p50Ms: number | undefined;
  readonly p95Ms: number | undefined;
}

/** Paid calls of one way to pay. */
export interface WayCounts {
  readonly paidWith: string;
  readonly calls: number;
  readonly volume: MicroUsd;
  readonly buyers: number;
}

/** The platform's numbers of one period. */
export interface PlatformPeriodCounts extends CallCounts {
  // Distinct services with a paid call
  readonly services: number;
  readonly ways: readonly WayCounts[];
}

/** Paid calls of one UTC day. */
export interface DayCounts {
  readonly day: string;
  readonly calls: number;
  readonly volume: MicroUsd;
  readonly buyers: number;
}

/** A period's top services and endpoints by paid calls, best first, of the ones that may be listed. */
export interface TopCounts {
  readonly services: readonly { readonly host: string; readonly calls: number }[];
  readonly endpoints: readonly { readonly host: string; readonly path: string; readonly calls: number }[];
}

/** Credited top-ups of one token on one network. */
export interface TopupCounts {
  readonly network: string;
  readonly token: string;
  readonly count: number;
  readonly amount: MicroUsd;
}

/** A buyer of a service, among its top buyers. Never one whose payer isn't known. */
export interface TopBuyerCounts {
  // A chain payer's address. Undefined for Credits.
  readonly payer: string | undefined;
  // How the buyer's last call was paid
  readonly paidWith: string;
  readonly calls: number;
  readonly spent: MicroUsd;
  readonly lastCallAt: Date;
}

/** A service's numbers of one period. */
export interface ServicePeriodCounts extends CallCounts {
  // Distinct paths with a paid call
  readonly paidEndpoints: number;
  readonly ways: readonly WayCounts[];
  // Buyers whose payer is known, and of those the ones who paid on 2 or more UTC days of the period
  readonly knownBuyers: number;
  readonly returning: number;
  readonly topBuyers: readonly TopBuyerCounts[];
}

/** An endpoint's numbers of one period. */
export interface EndpointPeriodCounts extends CallCounts {
  readonly ways: readonly { readonly paidWith: string; readonly calls: number }[];
}

/** One endpoint of a service, with what its answers need. */
export interface EndpointCounts {
  readonly hostHash: string;
  readonly pathHash: string;
  readonly path: string;
  // Its calls' most frequent method, when any is known
  readonly method: string | undefined;
  // The routed endpoint's last quote
  readonly price: MicroUsd | undefined;
  readonly periods: Partial<Readonly<Record<StatsPeriod, EndpointPeriodCounts>>>;
  // Paid calls per UTC day, only days with one
  readonly daily: readonly { readonly day: string; readonly calls: number }[];
}

type ByPeriod<TValue, TPeriod extends string = StatsPeriod> = { readonly [Period in TPeriod]: TValue };

export interface PaidWithCalls {
  readonly paidWith: string;
  readonly calls: number;
}

type PaidWithVolume = PaidWithCalls & { readonly volume: string };

/** The platform's numbers of today, 7 and 30 days, as the frequent count writes them. */
export interface PlatformRecentAnswer {
  readonly calls: ByPeriod<number, RecentPeriod>;
  readonly volume: ByPeriod<string, RecentPeriod>;
  readonly buyers: ByPeriod<number, RecentPeriod>;
  readonly services: ByPeriod<number, RecentPeriod>;
  readonly byPaidWith: ByPeriod<readonly PaidWithVolume[], RecentPeriod>;
  readonly topups: { readonly count: number; readonly usd: string };
  readonly daily: readonly { readonly day: string; readonly calls: number; readonly volume: string }[];
}

/** The platform's numbers of all time, as the all-time count writes them. */
export interface PlatformAllAnswer {
  readonly calls: number;
  readonly volume: string;
  readonly buyers: number;
  readonly services: number;
  readonly byPaidWith: readonly PaidWithVolume[];
  readonly topups: { readonly count: number; readonly usd: string };
}

/** `GET /v1/stats`, without its times. */
export interface PlatformAnswer {
  readonly calls: ByPeriod<number>;
  readonly volume: ByPeriod<string> & { readonly currency: 'USD' };
  readonly buyers: ByPeriod<number>;
  readonly services: ByPeriod<number>;
  readonly byPaidWith: ByPeriod<readonly PaidWithVolume[]>;
  readonly topups: { readonly [Period in '30d' | 'all']: { readonly count: number; readonly usd: string } };
  readonly daily: readonly { readonly day: string; readonly calls: number; readonly volume: string }[];
}

/** `GET /v1/stats/top`, without its period and time. */
export interface TopAnswer {
  readonly services: readonly { readonly host: string; readonly calls: number }[];
  readonly endpoints: readonly { readonly host: string; readonly path: string; readonly calls: number }[];
  readonly paidWith: readonly PaidWithCalls[];
  readonly topupTokens: readonly { readonly network: string; readonly token: string; readonly count: number }[];
}

/** Over every service with a paid call in the last 30 days, stored or not. */
export interface ServicesTotals {
  readonly services: number;
  readonly paidEndpoints: number;
  readonly calls30d: number;
}

/** A service with a page of its own, as the public list sorts and searches it: its numbers over 30 days. */
export interface ServiceRow {
  readonly hostHash: string;
  readonly host: string;
  readonly paidEndpoints: number;
  // The cheapest last quote of its endpoints with a paid call in 30 days. Undefined: none has one.
  readonly priceFrom: MicroUsd | undefined;
  readonly calls: number;
  readonly buyers: number;
  readonly volume: MicroUsd;
  readonly successRate: number | null;
  readonly p50Ms: number | null;
  // Paid calls per UTC day, the last 30, oldest first
  readonly trend: readonly number[];
}

export interface ServiceStats {
  readonly calls: number;
  // Null for all
  readonly callsBefore: number | null;
  readonly volume: string;
  readonly buyers: number;
  // Of the buyers whose payer is known
  readonly returningShare: number;
  readonly successRate: number | null;
  readonly failedCalls: number;
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
}

/** A service's page of one period, without its endpoints, which come from their own rows. */
export interface ServicePage {
  readonly host: string;
  readonly period: StatsPeriod;
  readonly paidEndpoints: number;
  readonly stats: ServiceStats;
  readonly daily: readonly { readonly day: string; readonly calls: number; readonly volume: string; readonly buyers: number }[];
  readonly byPaidWith: readonly (PaidWithCalls & { readonly share: number; readonly buyers: number; readonly volume: string })[];
  readonly topBuyers: {
    readonly share: number;
    readonly buyers: readonly {
      // Null for Credits: nothing names a Credits buyer
      readonly payer: string | null;
      readonly paidWith: string;
      readonly calls: number;
      readonly spent: string;
      readonly lastCallAt: string;
    }[];
  };
}

export interface EndpointListEntry {
  readonly path: string;
  readonly method: string | null;
  readonly priceNow: string | null;
  readonly calls: number;
  readonly buyers: number;
  readonly volume: string;
  readonly successRate: number | null;
  readonly p50Ms: number | null;
  readonly link: string;
}

/** `GET /v1/services/{host}`, without its time. */
export interface ServiceAnswer extends ServicePage {
  readonly endpoints: readonly EndpointListEntry[];
  // False when the numbers come from a bounded read that stopped at its cap: they cover the newest calls only
  readonly exact: boolean;
}

/** An endpoint's numbers of one period, as its stored row keeps them. */
export interface EndpointNumbers {
  readonly calls: number;
  readonly buyers: number;
  readonly volume: string;
  readonly successRate: number | null;
  readonly p50Ms: number | null;
  readonly byPaidWith: readonly PaidWithCalls[];
}

/** A stored endpoint: one row a service keeps, with the numbers of each period it was counted for. */
export interface StoredEndpoint {
  readonly hostHash: string;
  readonly pathHash: string;
  readonly path: string;
  readonly method: string | null;
  readonly price: MicroUsd | undefined;
  readonly recent: ByPeriod<EndpointNumbers, RecentPeriod>;
  // Paid calls of the last 14 UTC days to the count's, oldest first
  readonly daily: readonly number[];
}

/** `GET /v1/endpoints/stats`, without its time. */
export interface EndpointAnswer {
  readonly host: string;
  readonly path: string;
  readonly period: StatsPeriod;
  readonly stats: {
    readonly calls: number;
    readonly buyers: number;
    readonly volume: string;
    readonly successRate: number | null;
    readonly p50Ms: number | null;
  };
  readonly daily: readonly { readonly day: string; readonly calls: number }[];
  readonly byPaidWith: readonly PaidWithCalls[];
  // False when the numbers come from a bounded read that stopped at its cap: they cover the newest calls only
  readonly exact: boolean;
}

/** What the frequent count keeps for the live numbers: today, and paid calls per minute over 48 hours, to its time. */
export interface LiveBase {
  // The count's UTC day
  readonly day: string;
  readonly today: { readonly calls: number; readonly volume: string; readonly nearCalls: number; readonly buyers: number };
  // How many of today's buyers it kept, to be told apart from new ones: all of them, unless there were too many
  readonly buyersKept: number;
  // Minutes with a paid call: its start in ms since the epoch, the calls and their volume in micro-USD
  readonly minutes: readonly (readonly [number, number, string])[];
}

/** The calls since the frequent count, read when the live numbers are asked for. */
export interface LiveTail {
  // From `from`, the count's time, to `at`
  readonly from: Date;
  readonly at: Date;
  readonly calls: number;
  readonly volume: MicroUsd;
  // Those of `at`'s UTC day
  readonly todayCalls: number;
  readonly todayVolume: MicroUsd;
  readonly todayNear: number;
  // Today's buyers: the kept ones and the tail's
  readonly todayBuyers: number;
  // Paid calls per minute of the last 30 minutes to `at`, only minutes with one
  readonly perMinute: readonly { readonly minute: Date; readonly calls: number }[];
}

/** `GET /v1/stats/live`. */
export interface LiveAnswer {
  readonly at: string;
  readonly today: { readonly calls: number; readonly volume: string; readonly buyers: number; readonly nearShare: number };
  readonly last24h: { readonly calls: number; readonly volume: string; readonly volumeBefore: string };
  readonly perMinute: readonly { readonly minute: string; readonly calls: number }[];
}

const noCalls: CallCounts = { calls: 0, volume: 0n, buyers: 0, free: 0, p50Ms: undefined, p95Ms: undefined };

// A share to 4 decimal places: 0 of none
export const share = (part: number, whole: number): number => whole > 0 ? Math.round(part / whole * 10_000) / 10_000 : 0;
// Paid calls of finished ones: 0 when every one was free, null without any
const successRate = ({ calls, free }: CallCounts): number | null => calls + free > 0 ? share(calls, calls + free) : null;
const orNull = <TValue>(value: TValue | undefined): TValue | null => value ?? null;
const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
// Most calls first, then by name
const byCalls = <TItem extends { readonly calls: number }>(name: (item: TItem) => string) => (a: TItem, b: TItem): number =>
  b.calls - a.calls || compareText(name(a), name(b));
const paidWays = <TWay extends PaidWithCalls>(ways: readonly TWay[]): TWay[] => ways.filter(way => way.calls > 0).sort(byCalls(way => way.paidWith));
const sumTopups = (rows: readonly TopupCounts[]) => {
  const total = rows.reduce((sum, row) => ({ count: sum.count + row.count, amount: sum.amount + row.amount }), { count: 0, amount: 0n });

  return { count: total.count, usd: formatUsd(total.amount) };
};
const byRecent = <TValue>(value: (period: RecentPeriod) => TValue): ByPeriod<TValue, RecentPeriod> =>
  ({ today: value('today'), '7d': value('7d'), '30d': value('30d') });

/** The platform's numbers of today, 7 and 30 days, with 30 days of paid calls. */
export const buildPlatformRecent = (input: {
  readonly periods: Partial<Readonly<Record<RecentPeriod, PlatformPeriodCounts>>>;
  readonly daily: readonly DayCounts[];
  // Credited in the last 30 days
  readonly topups: readonly TopupCounts[];
  readonly now: Date;
}): PlatformRecentAnswer => {
  const of = (period: RecentPeriod): PlatformPeriodCounts => input.periods[period] ?? { ...noCalls, services: 0, ways: [] };
  const days = new Map(input.daily.map(day => [day.day, day]));

  return {
    calls: byRecent(period => of(period).calls),
    volume: byRecent(period => formatUsd(of(period).volume)),
    buyers: byRecent(period => of(period).buyers),
    services: byRecent(period => of(period).services),
    byPaidWith: byRecent(period => paidWays(of(period).ways).map(way => ({ paidWith: way.paidWith, calls: way.calls, volume: formatUsd(way.volume) }))),
    topups: sumTopups(input.topups),
    daily: lastUtcDays(input.now, statsDailyDays).map(day => ({ day, calls: days.get(day)?.calls ?? 0, volume: formatUsd(days.get(day)?.volume ?? 0n) })),
  };
};

/** The platform's numbers of all time. */
export const buildPlatformAll = (counts: PlatformPeriodCounts | undefined, topups: readonly TopupCounts[]): PlatformAllAnswer => {
  const all = counts ?? { ...noCalls, services: 0, ways: [] };

  return {
    calls: all.calls,
    volume: formatUsd(all.volume),
    buyers: all.buyers,
    services: all.services,
    byPaidWith: paidWays(all.ways).map(way => ({ paidWith: way.paidWith, calls: way.calls, volume: formatUsd(way.volume) })),
    topups: sumTopups(topups),
  };
};

/** `GET /v1/stats` from the two counts: zeros for one that hasn't run yet. */
export const composePlatformAnswer = (recent: PlatformRecentAnswer | undefined, all: PlatformAllAnswer | undefined, now: Date): PlatformAnswer => {
  const bounded = recent ?? buildPlatformRecent({ periods: {}, daily: [], topups: [], now });
  const total = all ?? buildPlatformAll(undefined, []);

  return {
    calls: { ...bounded.calls, all: total.calls },
    volume: { ...bounded.volume, all: total.volume, currency: 'USD' },
    buyers: { ...bounded.buyers, all: total.buyers },
    services: { ...bounded.services, all: total.services },
    byPaidWith: { ...bounded.byPaidWith, all: total.byPaidWith },
    topups: { '30d': bounded.topups, all: total.topups },
    daily: bounded.daily,
  };
};

/** One period's top lists: the services and endpoints counted, every way to pay with a paid call, the top-up tokens. */
export const buildTopAnswer = (top: TopCounts, ways: readonly WayCounts[], topups: readonly TopupCounts[]): TopAnswer => ({
  services: top.services.slice(0, topListSize),
  endpoints: top.endpoints.slice(0, topListSize),
  paidWith: paidWays(ways).map(way => ({ paidWith: way.paidWith, calls: way.calls })),
  topupTokens: topups.filter(row => row.count > 0)
    .sort((a, b) => b.count - a.count || compareText(`${a.network} ${a.token}`, `${b.network} ${b.token}`)).slice(0, topListSize)
    .map(row => ({ network: row.network, token: row.token, count: row.count })),
});

export const emptyTopAnswer: TopAnswer = { services: [], endpoints: [], paidWith: [], topupTokens: [] };

/** A service's page of one period. `daily` is its paid calls per day, only days with one. */
export const buildServicePage = (input: {
  readonly host: string;
  readonly period: StatsPeriod;
  readonly counts: ServicePeriodCounts | undefined;
  // Paid calls in the period before. Undefined for all.
  readonly callsBefore: number | undefined;
  readonly daily: readonly DayCounts[];
  readonly now: Date;
}): ServicePage => {
  const counted = input.counts;
  const numbers = counted ?? noCalls;
  const days = new Map(input.daily.map(day => [day.day, day]));
  const top = counted?.topBuyers ?? [];

  return {
    host: input.host,
    period: input.period,
    paidEndpoints: counted?.paidEndpoints ?? 0,
    stats: {
      calls: numbers.calls,
      callsBefore: input.period === 'all' ? null : input.callsBefore ?? 0,
      volume: formatUsd(numbers.volume),
      buyers: numbers.buyers,
      // The unknown payers of a network are no buyer who could return
      returningShare: share(counted?.returning ?? 0, counted?.knownBuyers ?? 0),
      successRate: successRate(numbers),
      failedCalls: numbers.free,
      p50Ms: orNull(numbers.p50Ms),
      p95Ms: orNull(numbers.p95Ms),
    },
    daily: lastUtcDays(input.now, statsDailyDays).map(day => {
      const counts = days.get(day);

      return { day, calls: counts?.calls ?? 0, volume: formatUsd(counts?.volume ?? 0n), buyers: counts?.buyers ?? 0 };
    }),
    byPaidWith: paidWays(counted?.ways ?? []).map(way => ({
      paidWith: way.paidWith, calls: way.calls, share: share(way.calls, numbers.calls), buyers: way.buyers, volume: formatUsd(way.volume),
    })),
    topBuyers: {
      share: share(top.reduce((sum, buyer) => sum + buyer.calls, 0), numbers.calls),
      buyers: top.slice(0, topListSize).map(buyer => ({
        // A Credits buyer is never named, whatever its counts hold
        payer: buyer.paidWith === 'credits' ? null : orNull(buyer.payer),
        paidWith: buyer.paidWith,
        calls: buyer.calls,
        spent: formatUsd(buyer.spent),
        lastCallAt: buyer.lastCallAt.toISOString(),
      })),
    },
  };
};

/** A service's row of the public list: its numbers over 30 days. */
export const buildServiceRow = (input: {
  readonly hostHash: string;
  readonly host: string;
  readonly month: ServicePeriodCounts | undefined;
  readonly priceFrom: MicroUsd | undefined;
  readonly daily: readonly DayCounts[];
  readonly now: Date;
}): ServiceRow => {
  const month = input.month ?? { ...noCalls, paidEndpoints: 0 };
  const days = new Map(input.daily.map(day => [day.day, day.calls]));

  return {
    hostHash: input.hostHash,
    host: input.host,
    paidEndpoints: month.paidEndpoints,
    priceFrom: input.priceFrom,
    calls: month.calls,
    buyers: month.buyers,
    volume: month.volume,
    successRate: successRate(month),
    p50Ms: orNull(month.p50Ms),
    trend: lastUtcDays(input.now, statsDailyDays).map(day => days.get(day) ?? 0),
  };
};

export const endpointNumbersOf = (counts: EndpointPeriodCounts | undefined): EndpointNumbers => {
  const numbers = counts ?? noCalls;

  return {
    calls: numbers.calls,
    buyers: numbers.buyers,
    volume: formatUsd(numbers.volume),
    successRate: successRate(numbers),
    p50Ms: orNull(numbers.p50Ms),
    byPaidWith: paidWays(counts?.ways ?? []),
  };
};

/** An endpoint as its service keeps it, counted at `now`. */
export const buildStoredEndpoint = (counts: EndpointCounts, now: Date): StoredEndpoint => {
  const days = new Map(counts.daily.map(day => [day.day, day.calls]));

  return {
    hostHash: counts.hostHash,
    pathHash: counts.pathHash,
    path: counts.path,
    method: orNull(counts.method),
    price: counts.price,
    recent: byRecent(period => endpointNumbersOf(counts.periods[period])),
    daily: lastUtcDays(now, endpointDailyDays).map(day => days.get(day) ?? 0),
  };
};

/** An endpoint of a service's list. The link is the pay host's, never stored. */
export const endpointListEntry = (input: {
  readonly host: string;
  readonly path: string;
  readonly method: string | null;
  readonly price: MicroUsd | undefined;
  readonly numbers: EndpointNumbers;
  readonly payUrl: string;
}): EndpointListEntry => ({
  path: input.path,
  method: input.method,
  priceNow: input.price === undefined ? null : formatUsd(input.price),
  calls: input.numbers.calls,
  buyers: input.numbers.buyers,
  volume: input.numbers.volume,
  successRate: input.numbers.successRate,
  p50Ms: input.numbers.p50Ms,
  link: `${input.payUrl.replace(/\/+$/, '')}/${input.host}${input.path}`,
});

/** An endpoint's answer of one period: `daily` is its paid calls of the 14 days to `dailyTo`'s, oldest first. */
export const buildEndpointAnswer = (input: {
  readonly host: string;
  readonly path: string;
  readonly period: StatsPeriod;
  readonly numbers: EndpointNumbers | undefined;
  readonly daily: readonly number[];
  readonly dailyTo: Date;
  readonly exact: boolean;
}): EndpointAnswer => {
  const numbers = input.numbers ?? endpointNumbersOf(undefined);

  return {
    host: input.host,
    path: input.path,
    period: input.period,
    stats: { calls: numbers.calls, buyers: numbers.buyers, volume: numbers.volume, successRate: numbers.successRate, p50Ms: numbers.p50Ms },
    daily: lastUtcDays(input.dailyTo, endpointDailyDays).map((day, index) => ({ day, calls: input.daily[index] ?? 0 })),
    byPaidWith: numbers.byPaidWith,
    exact: input.exact,
  };
};

/** The live numbers' base, from the frequent count's numbers of today and its minutes. */
export const buildLiveBase = (input: {
  readonly now: Date;
  readonly today: PlatformPeriodCounts | undefined;
  readonly buyersKept: number;
  readonly minutes: readonly { readonly minute: Date; readonly calls: number; readonly volume: MicroUsd }[];
}): LiveBase => ({
  day: input.now.toISOString().slice(0, 10),
  today: {
    calls: input.today?.calls ?? 0,
    volume: String(input.today?.volume ?? 0n),
    nearCalls: input.today?.ways.find(way => way.paidWith === 'near')?.calls ?? 0,
    buyers: input.today?.buyers ?? 0,
  },
  buyersKept: input.buyersKept,
  minutes: input.minutes.map(minute => [minute.minute.getTime(), minute.calls, String(minute.volume)] as const),
});

/**
 * `GET /v1/stats/live` at the tail's time: the base's numbers to its time and the tail's after it. The last
 * 24 hours and the 24 before them go by whole minutes of the base. Today's buyers are the kept ones and the
 * tail's together, or the base's count when it kept too many to tell new ones apart.
 */
export const buildLiveAnswer = (base: LiveBase | undefined, tail: LiveTail): LiveAnswer => {
  const at = tail.at.getTime();
  const sameDay = base !== undefined && base.day === tail.at.toISOString().slice(0, 10);
  const dayFrom = Math.floor(at / minuteMs) * minuteMs - 24 * 60 * minuteMs;
  const beforeFrom = dayFrom - 24 * 60 * minuteMs;
  let dayCalls = 0;
  let dayVolume = 0n;
  let beforeVolume = 0n;
  for (const [minute, calls, volume] of base?.minutes ?? []) {
    if (minute >= dayFrom) {
      dayCalls += calls;
      dayVolume += BigInt(volume);
    }
    else if (minute >= beforeFrom)
      beforeVolume += BigInt(volume);
  }
  const todayCalls = (sameDay ? base.today.calls : 0) + tail.todayCalls;
  const complete = !sameDay || base.buyersKept >= base.today.buyers;
  const lastMinute = Math.floor(at / minuteMs) * minuteMs;
  const perMinute = new Map(tail.perMinute.map(row => [row.minute.getTime(), row.calls]));

  return {
    at: tail.at.toISOString(),
    today: {
      calls: todayCalls,
      volume: formatUsd((sameDay ? BigInt(base.today.volume) : 0n) + tail.todayVolume),
      buyers: complete ? tail.todayBuyers : base.today.buyers,
      nearShare: share((sameDay ? base.today.nearCalls : 0) + tail.todayNear, todayCalls),
    },
    last24h: { calls: dayCalls + tail.calls, volume: formatUsd(dayVolume + tail.volume), volumeBefore: formatUsd(beforeVolume) },
    perMinute: Array.from({ length: liveMinutes }, (_, index) => {
      const minute = lastMinute - (liveMinutes - 1 - index) * minuteMs;

      return { minute: new Date(minute).toISOString(), calls: perMinute.get(minute) ?? 0 };
    }),
  };
};
