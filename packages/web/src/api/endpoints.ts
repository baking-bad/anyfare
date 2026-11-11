import type { ApiResult, Reader } from './reader';
import type { CallsPage, CallsQuery, LiveStats, Period, Receipt, ServiceDetail, ServicesPage, ServicesQuery, Stats, TopStats } from './types';

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
  // The stream takes the list's filters, and no page or size
  callStream: (q: Omit<CallsQuery, 'page' | 'size'> = {}): string => `/v1/calls/stream${query({ paidWith: q.paidWith, service: q.service, host: q.host, endpoint: q.endpoint, status: q.status })}`,
} as const;

const isStats = (value: unknown): value is Stats =>
  isRecord(value) && isRecord(value['calls']) && isRecord(value['volume']) && isRecord(value['buyers']) && isRecord(value['services'])
  && isRecord(value['byPaidWith']) && Array.isArray(value['daily']);

const isLiveStats = (value: unknown): value is LiveStats =>
  isRecord(value) && isRecord(value['today']) && isRecord(value['last24h']);

const isTopStats = (value: unknown): value is TopStats =>
  isRecord(value) && Array.isArray(value['services']) && Array.isArray(value['endpoints']) && Array.isArray(value['paidWith']) && Array.isArray(value['topupTokens']);

const isServicesPage = (value: unknown): value is ServicesPage => isRecord(value) && Array.isArray(value['services']);

const isServiceDetail = (value: unknown): value is ServiceDetail =>
  isRecord(value) && typeof value['host'] === 'string' && isRecord(value['stats']) && Array.isArray(value['endpoints']) && Array.isArray(value['daily'])
  && Array.isArray(value['byPaidWith']) && isRecord(value['topBuyers']) && Array.isArray(value['topBuyers']['buyers']);

const isCallsPage = (value: unknown): value is CallsPage => isRecord(value) && Array.isArray(value['calls']);

export const isReceipt = (value: unknown): value is Receipt =>
  isRecord(value) && typeof value['id'] === 'string' && typeof value['at'] === 'string' && isRecord(value['buyer']) && isRecord(value['ms']) && Array.isArray(value['steps']);

export const getStats = (read: Reader): Promise<ApiResult<Stats>> => read(paths.stats, isStats);

export const getLiveStats = (read: Reader): Promise<ApiResult<LiveStats>> => read(paths.liveStats, isLiveStats);

export const listServices = (read: Reader, q: ServicesQuery = {}): Promise<ApiResult<ServicesPage>> => read(paths.services(q), isServicesPage);

export const getService = (read: Reader, host: string, period?: Period): Promise<ApiResult<ServiceDetail>> => read(paths.service(host, period), isServiceDetail);

export const listCalls = (read: Reader, q: CallsQuery = {}): Promise<ApiResult<CallsPage>> => read(paths.calls(q), isCallsPage);

export const getTopStats = (read: Reader, period: Period): Promise<ApiResult<TopStats>> => read(paths.topStats(period), isTopStats);

export const getReceipt = (read: Reader, id: string): Promise<ApiResult<Receipt>> => read(paths.call(id), isReceipt);
