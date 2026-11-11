/** The body of a Platform API error answer. */
export interface ApiErrorBody {
  readonly error: { readonly code: string; readonly message: string };
}

// The public read API's answers. Money is a USD decimal string, such as "0.01". Times are ISO 8601 UTC
// strings. A day is a UTC day.

/** How the buyer paid, or how Anyfare paid the API. A network that isn't a known one comes as its network ID. */
export type PaidWith = 'near' | 'base' | 'solana' | 'tempo' | 'credits' | (string & {});

export type Period = 'today' | '7d' | '30d' | 'all';

export type CallStatus = 'paid' | 'free';

/** One finished call: a row of the list, an event of the stream, the top of a receipt. */
export interface Call {
  readonly id: string;
  readonly at: string;
  readonly service: string;
  // The path only, never a query
  readonly path: string;
  // null for calls recorded before the method was kept
  readonly method: string | null;
  readonly paidWith: PaidWith;
  // null when Anyfare never signed for the API
  readonly apiPaidWith: PaidWith | null;
  // null for Credits, and when unknown
  readonly payer: string | null;
  // What the buyer paid, or would have paid
  readonly amount: string;
  readonly status: CallStatus;
  readonly apiStatus: number | null;
  // The API's time
  readonly ms: number | null;
}

export interface CallsQuery {
  readonly paidWith?: PaidWith;
  // A part of the host
  readonly service?: string;
  // The exact path
  readonly endpoint?: string;
  readonly status?: CallStatus;
  readonly page?: number;
  readonly size?: number;
}

/** The filters the stream takes. */
export type CallsFilter = Omit<CallsQuery, 'page' | 'size'>;

export interface CallsPage {
  // Newest first
  readonly calls: readonly Call[];
  readonly page: number;
  readonly size: number;
  readonly total: number;
  // true when there are more calls than the count's cap
  readonly totalCapped: boolean;
}

/** One side of a receipt: the buyer's payment, or Anyfare's payment to the API. */
export interface ReceiptSide {
  readonly paidWith: PaidWith;
  // null for Credits
  readonly network: string | null;
  // A display name: USDC, USDC.e or Credits
  readonly asset: string | null;
  readonly amount: string;
  readonly transaction: string | null;
  // null when the network has no explorer Anyfare knows
  readonly explorerUrl: string | null;
}

export type ReceiptStepName = 'received' | 'authorized' | 'api_signed' | 'api_answered' | 'settled' | 'released';

/** `GET /v1/calls/:id`: the public receipt of one finished call. */
export interface Receipt {
  readonly id: string;
  readonly at: string;
  readonly status: CallStatus;
  readonly apiStatus: number | null;
  readonly service: string;
  readonly method: string | null;
  readonly path: string;
  // For Credits: no network, payer, transaction or explorer, and the asset is "Credits"
  readonly buyer: ReceiptSide & { readonly payer: string | null; readonly settledAt: string | null };
  // null when Anyfare never signed for the API
  readonly api: (ReceiptSide & { readonly asset: string; readonly network: string; readonly payTo: string; readonly status: string }) | null;
  // null when `api` is null
  readonly apiPrice: string | null;
  // null while the payment is still settling
  readonly fee: string | null;
  readonly ms: { readonly api: number | null; readonly total: number | null };
  // Only steps whose time was kept. A name the page doesn't know is shown as its code.
  readonly steps: readonly { readonly step: ReceiptStepName | (string & {}); readonly at: string }[];
}

/** A figure for each period. */
export type ByPeriod<TValue> = Readonly<Record<Period, TValue>>;

export interface PaidWithShare {
  readonly paidWith: PaidWith;
  readonly calls: number;
  readonly volume: string;
}

export interface DailyPoint {
  readonly day: string;
  readonly calls: number;
  readonly volume: string;
}

/** `GET /v1/stats`: counted every few minutes. With an empty database every number is 0. */
export interface Stats {
  // null before the first count
  readonly updatedAt: string | null;
  readonly calls: ByPeriod<number>;
  readonly volume: ByPeriod<string> & { readonly currency: string };
  readonly buyers: ByPeriod<number>;
  readonly services: ByPeriod<number>;
  readonly byPaidWith: ByPeriod<readonly PaidWithShare[]>;
  readonly topups: Readonly<Record<'30d' | 'all', { readonly count: number; readonly usd: string }>>;
  // The last 30 UTC days, oldest first, zero days included
  readonly daily: readonly DailyPoint[];
}

/** `GET /v1/stats/live`: fresh numbers for the live parts of a page. */
export interface LiveStats {
  readonly at: string;
  readonly today: { readonly calls: number; readonly volume: string; readonly buyers: number; readonly nearShare: number };
  // volumeBefore is the 24 hours before those
  readonly last24h: { readonly calls: number; readonly volume: string; readonly volumeBefore: string };
  // The last 30 minutes, oldest first, zero minutes included
  readonly perMinute: readonly { readonly minute: string; readonly calls: number }[];
}

/** `GET /v1/stats/top` */
export interface TopStats {
  readonly period: Period;
  readonly updatedAt: string | null;
  readonly services: readonly { readonly host: string; readonly calls: number }[];
  readonly endpoints: readonly { readonly host: string; readonly path: string; readonly calls: number }[];
  readonly paidWith: readonly { readonly paidWith: PaidWith; readonly calls: number }[];
  readonly topupTokens: readonly { readonly network: string; readonly token: string; readonly count: number }[];
}

export type ServiceSort = 'calls' | 'buyers' | 'volume' | 'endpoints' | 'price';

export interface ServicesQuery {
  readonly q?: string;
  readonly sort?: ServiceSort;
  readonly page?: number;
  readonly size?: number;
}

/** A service in the list: a host with at least one paid call. Calls, buyers and volume are for 30 days. */
export interface ServiceRow {
  readonly host: string;
  readonly paidEndpoints: number;
  readonly priceFrom: string;
  readonly currency: string;
  readonly calls: number;
  readonly buyers: number;
  readonly volume: string;
  // null when there is no data
  readonly successRate: number | null;
  readonly p50Ms: number | null;
  // Paid calls per day, the last 30 UTC days, oldest first
  readonly trend: readonly number[];
}

export interface ServicesPage {
  readonly services: readonly ServiceRow[];
  readonly page: number;
  readonly size: number;
  readonly total: number;
  // Over all services, whatever `q` says
  readonly totals: { readonly services: number; readonly paidEndpoints: number; readonly calls30d: number };
  readonly updatedAt: string | null;
}

/** `GET /v1/services/:host` */
export interface ServiceDetail {
  readonly host: string;
  readonly period: Period;
  readonly updatedAt: string | null;
  readonly paidEndpoints: number;
  readonly stats: {
    readonly calls: number;
    // The period before; null for "all"
    readonly callsBefore: number | null;
    readonly volume: string;
    readonly buyers: number;
    readonly returningShare: number;
    readonly successRate: number | null;
    readonly failedCalls: number;
    readonly p50Ms: number | null;
    readonly p95Ms: number | null;
  };
  readonly endpoints: readonly {
    readonly path: string;
    readonly method: string | null;
    readonly priceNow: string;
    readonly calls: number;
    readonly buyers: number;
    readonly volume: string;
    readonly successRate: number | null;
    readonly p50Ms: number | null;
    readonly link: string;
  }[];
  readonly daily: readonly { readonly day: string; readonly calls: number; readonly volume: string; readonly buyers: number }[];
  readonly byPaidWith: readonly { readonly paidWith: PaidWith; readonly calls: number; readonly share: number; readonly buyers: number; readonly volume: string }[];
  readonly topBuyers: {
    readonly share: number;
    readonly buyers: readonly { readonly payer: string | null; readonly paidWith: PaidWith; readonly calls: number; readonly spent: string; readonly lastCallAt: string }[];
  };
}

/** `GET /v1/endpoints/stats` */
export interface EndpointStats {
  readonly host: string;
  readonly path: string;
  readonly period: Period;
  readonly updatedAt: string | null;
  readonly stats: { readonly calls: number; readonly buyers: number; readonly volume: string; readonly successRate: number | null; readonly p50Ms: number | null };
  // The last 14 UTC days, zero days included
  readonly daily: readonly { readonly day: string; readonly calls: number }[];
  readonly byPaidWith: readonly { readonly paidWith: PaidWith; readonly calls: number }[];
}
