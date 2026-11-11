import type { ApiResult, Reader } from './reader';
import type { CallsPage, CallsQuery, EndpointStats, LiveStats, Period, Receipt, ServiceDetail, ServicesPage, ServicesQuery, Stats, TopStats } from './types';

// The public read API's endpoints a page reads. `paths` builds each path once: the page reads it, and
// the Agent view and the Markdown twin list it.

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const query = (params: Readonly<Record<string, string | number | undefined>>): string => {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined && value !== '')
      search.set(name, String(value));
  }
  const text = search.toString();

  return text === '' ? '' : `?${text}`;
};

export const paths = {
  stats: '/v1/stats',
  liveStats: '/v1/stats/live',
  topStats: (period: Period): string => `/v1/stats/top${query({ period })}`,
  services: (q: ServicesQuery = {}): string => `/v1/services${query({ q: q.q, sort: q.sort, page: q.page, size: q.size })}`,
  service: (host: string, period?: Period): string => `/v1/services/${encodeURIComponent(host)}${query({ period })}`,
  calls: (q: CallsQuery = {}): string => `/v1/calls${query({ paidWith: q.paidWith, service: q.service, host: q.host, endpoint: q.endpoint, status: q.status, page: q.page, size: q.size })}`,
  call: (id: string): string => `/v1/calls/${encodeURIComponent(id)}`,
  endpointStats: (host: string, path: string, period?: Period): string => `/v1/endpoints/stats${query({ host, path, period })}`,
  // The pay host's check of a link. The link goes as the visitor typed it.
  // The method goes only when it isn't GET, the pay host's default
  check: (url: string, method?: string): string => `/_/check${query({ url, method: method === 'GET' ? undefined : method })}`,
  // The stream takes the list's filters, and no page or size
  callStream: (q: Omit<CallsQuery, 'page' | 'size'> = {}): string => `/v1/calls/stream${query({ paidWith: q.paidWith, service: q.service, host: q.host, endpoint: q.endpoint, status: q.status })}`,
} as const;

// A shape check looks at the fields a page reads, one level deep: that each is there, and of the kind the
// schema gives. It never checks a field the page doesn't read.
const isString = (value: unknown): value is string => typeof value === 'string';
const isNullableString = (value: unknown): boolean => value === null || typeof value === 'string';
const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';
const isNumber = (value: unknown): value is number => typeof value === 'number';
const isArray = (value: unknown): value is readonly unknown[] => Array.isArray(value);
const isListedStatus = (value: unknown): boolean => value === 'paid' || value === 'checked';

const isStats = (value: unknown): value is Stats =>
  isRecord(value) && isNullableString(value['updatedAt']) && isNullableString(value['allUpdatedAt'])
  && isRecord(value['calls']) && isRecord(value['volume']) && isRecord(value['buyers']) && isRecord(value['services'])
  && isRecord(value['byPaidWith']) && isRecord(value['topups']) && Array.isArray(value['daily']);

const isLiveStats = (value: unknown): value is LiveStats =>
  isRecord(value) && isString(value['at']) && isRecord(value['today']) && isRecord(value['last24h']) && isArray(value['perMinute']);

const isTopStats = (value: unknown): value is TopStats =>
  isRecord(value) && Array.isArray(value['services']) && Array.isArray(value['endpoints']) && Array.isArray(value['paidWith']) && Array.isArray(value['topupTokens']);

const isServicesPage = (value: unknown): value is ServicesPage =>
  isRecord(value) && Array.isArray(value['services']) && isNumber(value['total']) && isBoolean(value['totalCapped']) && isRecord(value['totals'])
  && isNumber(value['totals']['services']) && isNumber(value['totals']['paidServices'])
  && value['services'].every(row => isRecord(row) && isString(row['host']) && isListedStatus(row['status']) && isNullableString(row['priceFrom']) && isNullableString(row['checkedAt']) && Array.isArray(row['trend']));

const isServiceDetail = (value: unknown): value is ServiceDetail =>
  isRecord(value) && typeof value['host'] === 'string' && isListedStatus(value['status']) && isNullableString(value['checkedAt']) && isBoolean(value['exact']) && isNumber(value['paidEndpoints']) && isRecord(value['stats']) && Array.isArray(value['endpoints'])
  && Array.isArray(value['daily']) && Array.isArray(value['byPaidWith']) && isRecord(value['topBuyers']) && Array.isArray(value['topBuyers']['buyers'])
  && value['endpoints'].every(endpoint => isRecord(endpoint) && isString(endpoint['path']) && isNullableString(endpoint['priceNow']) && isListedStatus(endpoint['status']) && isNullableString(endpoint['checkedAt']));

const isEndpointStats = (value: unknown): value is EndpointStats =>
  isRecord(value) && isBoolean(value['exact']) && isRecord(value['stats']) && Array.isArray(value['daily']) && Array.isArray(value['byPaidWith']);

const isCallsPage = (value: unknown): value is CallsPage => isRecord(value) && Array.isArray(value['calls']) && isBoolean(value['totalCapped']);

export const isReceipt = (value: unknown): value is Receipt =>
  isRecord(value) && typeof value['id'] === 'string' && typeof value['at'] === 'string' && isRecord(value['buyer']) && isRecord(value['ms']) && Array.isArray(value['steps'])
  && isNullableString(value['apiPrice']) && isNullableString(value['fee']);

export const getStats = (read: Reader): Promise<ApiResult<Stats>> => read(paths.stats, isStats);

export const getLiveStats = (read: Reader): Promise<ApiResult<LiveStats>> => read(paths.liveStats, isLiveStats);

export const listServices = (read: Reader, q: ServicesQuery = {}): Promise<ApiResult<ServicesPage>> => read(paths.services(q), isServicesPage);

export const getService = (read: Reader, host: string, period?: Period): Promise<ApiResult<ServiceDetail>> => read(paths.service(host, period), isServiceDetail);

export const listCalls = (read: Reader, q: CallsQuery = {}): Promise<ApiResult<CallsPage>> => read(paths.calls(q), isCallsPage);

export const getTopStats = (read: Reader, period: Period): Promise<ApiResult<TopStats>> => read(paths.topStats(period), isTopStats);

/** An endpoint the API doesn't show, such as a blocked host: no calls, in the shape of an answer. */
export const noEndpointStats = (host: string, path: string, period: Period, now: number): EndpointStats => ({
  host,
  path,
  period,
  updatedAt: null,
  stats: { calls: 0, buyers: 0, volume: '0', successRate: null, p50Ms: null },
  daily: Array.from({ length: 14 }, (_, index) => ({ day: new Date(now - (13 - index) * 86_400_000).toISOString().slice(0, 10), calls: 0 })),
  byPaidWith: [],
  exact: true,
});

/** An endpoint's numbers. A `404` is an endpoint the API doesn't show: its numbers are zeros, not a failure. */
export const getEndpointStats = async (read: Reader, host: string, path: string, period?: Period): Promise<ApiResult<EndpointStats>> => {
  const result = await read(paths.endpointStats(host, path, period), isEndpointStats);

  return !result.ok && result.error.status === 404 ? { ok: true, value: noEndpointStats(host, path, period ?? '30d', Date.now()) } : result;
};

export const getReceipt = (read: Reader, id: string): Promise<ApiResult<Receipt>> => read(paths.call(id), isReceipt);
