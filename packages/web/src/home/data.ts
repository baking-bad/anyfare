import { getLiveStats, getStats, listCalls, listServices, paths } from '../api/endpoints';
import type { ApiResult, Reader } from '../api/reader';
import type { CallsPage, LiveStats, ServicesPage, Stats } from '../api/types';
import type { AgentRequest } from '../components/AgentView';
import type { SiteSettings } from '../config';

/** The home page's data: one read for each section, so one failed read leaves the other sections alone. */
export interface HomeData {
  readonly stats: ApiResult<Stats>;
  readonly live: ApiResult<LiveStats>;
  readonly calls: ApiResult<CallsPage>;
  readonly services: ApiResult<ServicesPage>;
}

/** How many calls the live list shows. */
export const lastCallsSize = 6;
/** How many services the top table shows. */
export const topServicesSize = 5;

/**
 * The services the top table may show: those agents paid. The list also holds services a check listed, which come
 * after the paid ones when sorted by calls: they are left out, so the table never shows one as "used", and with
 * fewer than 5 paid services it shows fewer rows, or its empty state.
 */
export const paidServicesOnly = (result: ApiResult<ServicesPage>): ApiResult<ServicesPage> =>
  result.ok ? { ok: true, value: { ...result.value, services: result.value.services.filter(service => service.status === 'paid') } } : result;

/** Reads everything the home page and its Markdown twin show, at once. */
export const loadHome = async (read: Reader): Promise<HomeData> => {
  const [stats, live, calls, services] = await Promise.all([
    getStats(read),
    getLiveStats(read),
    listCalls(read, { size: lastCallsSize }),
    listServices(read, { sort: 'calls', size: topServicesSize }),
  ]);

  return { stats, live, calls, services: paidServicesOnly(services) };
};

/** The requests behind the home page, with the addresses a browser or an agent uses. */
export const homeRequests = ({ apiUrl, payUrl }: Pick<SiteSettings, 'apiUrl' | 'payUrl'>): readonly AgentRequest[] => [
  { method: 'GET', url: `${apiUrl}${paths.stats}`, note: 'The four numbers, paid calls per day, and how buyers paid' },
  { method: 'GET', url: `${apiUrl}${paths.liveStats}`, note: 'The last 24 hours and today, fresh to about 10 seconds' },
  { method: 'GET', url: `${apiUrl}${paths.calls({ size: lastCallsSize })}`, note: 'The last calls, newest first' },
  { method: 'SSE', url: `${apiUrl}${paths.callStream()}`, note: 'Each call as it finishes, as server-sent events' },
  { method: 'GET', url: `${apiUrl}${paths.services({ sort: 'calls', size: topServicesSize })}`, note: 'The services agents paid most, then those only checked. The page keeps the paid ones' },
  { method: 'GET', url: `${payUrl}/_/check?url=<link>`, note: 'Check a link without paying: what it asks and what it costs' },
];

const answered = <TValue>(result: ApiResult<TValue>): TValue | { readonly error: { readonly code: string; readonly message: string } } =>
  result.ok ? result.value : { error: { code: result.error.code, message: result.error.message } };

/** The JSON the page is built from: the API's answers as they came, with the services that were paid only. A read that failed holds its error. */
export const homeJson = (data: HomeData): Record<string, unknown> => ({
  stats: answered(data.stats),
  statsLive: answered(data.live),
  calls: answered(data.calls),
  services: answered(data.services),
});
