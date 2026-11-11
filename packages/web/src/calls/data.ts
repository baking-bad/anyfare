import { getLiveStats, getTopStats, listCalls, paths } from '../api/endpoints';
import type { ApiResult, Reader } from '../api/reader';
import type { CallsPage, LiveStats, TopStats } from '../api/types';
import type { AgentRequest } from '../components/AgentView';
import type { SiteSettings } from '../config';
import { apiFilter, apiQuery, type CallsFilters } from './filters';

/** The Calls page's data: one read for each part, so one failed read leaves the other parts alone. */
export interface CallsData {
  readonly live: ApiResult<LiveStats>;
  readonly calls: ApiResult<CallsPage>;
  // The top 5 lists for 30 days, the period the page opens on
  readonly top: ApiResult<TopStats>;
}

/** Reads everything the Calls page and its Markdown twin show, at once. */
export const loadCalls = async (read: Reader, filters: CallsFilters): Promise<CallsData> => {
  const [live, calls, top] = await Promise.all([
    getLiveStats(read),
    listCalls(read, apiQuery(filters)),
    getTopStats(read, '30d'),
  ]);

  return { live, calls, top };
};

/** The services the filter suggests: the top of all time. A failed read is no suggestion. */
export const loadSuggestions = async (read: Reader): Promise<readonly string[]> => {
  const top = await getTopStats(read, 'all');

  return top.ok ? top.value.services.map(service => service.host) : [];
};

/** The requests behind the page, with the addresses a browser or an agent uses. */
export const callsRequests = ({ apiUrl }: Pick<SiteSettings, 'apiUrl'>, filters: CallsFilters): readonly AgentRequest[] => [
  { method: 'SSE', url: `${apiUrl}${paths.callStream(apiFilter(filters))}`, note: 'Each call as it finishes, with the same filters' },
  { method: 'GET', url: `${apiUrl}${paths.calls(apiQuery(filters))}`, note: 'The calls as pages of JSON, newest first' },
  { method: 'GET', url: `${apiUrl}${paths.liveStats}`, note: 'Today\'s numbers and calls per minute, fresh to about 10 seconds' },
  { method: 'GET', url: `${apiUrl}${paths.topStats('30d')}`, note: 'The top 5 lists. period: today, 7d, 30d or all' },
];

const answered = <TValue>(result: ApiResult<TValue>): TValue | { readonly error: { readonly code: string; readonly message: string } } =>
  result.ok ? result.value : { error: { code: result.error.code, message: result.error.message } };

/** The JSON the page is built from: the API's answers as they came. A read that failed holds its error. */
export const callsJson = (data: CallsData): Record<string, unknown> => ({
  statsLive: answered(data.live),
  calls: answered(data.calls),
  top: answered(data.top),
});
