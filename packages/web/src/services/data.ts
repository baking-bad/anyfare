import { getService, listCalls, listServices, paths } from '../api/endpoints';
import type { ApiResult, Reader, ReadFailure } from '../api/reader';
import type { CallsPage, Period, ServiceDetail, ServicesPage } from '../api/types';
import type { AgentRequest } from '../components/AgentView';
import type { SiteSettings } from '../config';
import { apiServicesQuery, type ServicesFilters } from './filters';
import { isHost } from './content';

/** How many calls the service page's live list shows. */
export const serviceCallsSize = 5;

const missing: ReadFailure = { status: 404, code: 'not_found', message: 'No paid call went to this service.' };

/** One page of the services list for the filters. */
export const loadServices = (read: Reader, filters: ServicesFilters): Promise<ApiResult<ServicesPage>> => listServices(read, apiServicesQuery(filters));

/** A service. A host that isn't one is no service, and the API is never asked. */
export const loadService = (read: Reader, host: string, period: Period): Promise<ApiResult<ServiceDetail>> =>
  isHost(host) ? getService(read, host.toLowerCase(), period) : Promise.resolve({ ok: false, error: missing });

/** The last calls to a service. */
export const loadServiceCalls = (read: Reader, host: string): Promise<ApiResult<CallsPage>> =>
  listCalls(read, { host: host.toLowerCase(), size: serviceCallsSize });

/** The request behind the Services page, with the address a browser or an agent uses. */
export const servicesRequests = ({ apiUrl }: Pick<SiteSettings, 'apiUrl'>, filters: ServicesFilters): readonly AgentRequest[] => [
  { method: 'GET', url: `${apiUrl}${paths.services(apiServicesQuery(filters))}`, note: 'The services as pages of JSON. sort: calls, newest, buyers, volume, endpoints or price' },
];

/** The requests behind a Service page. */
export const serviceRequests = ({ apiUrl }: Pick<SiteSettings, 'apiUrl'>, host: string, period: Period): readonly AgentRequest[] => [
  { method: 'GET', url: `${apiUrl}${paths.service(host, period)}`, note: 'The numbers on this page. period: today, 7d, 30d or all' },
  { method: 'SSE', url: `${apiUrl}${paths.callStream({ host })}`, note: 'Calls to this service as they finish' },
  { method: 'GET', url: `${apiUrl}${paths.calls({ host, size: serviceCallsSize })}`, note: 'The last calls to this service, newest first' },
];

const answered = <TValue>(result: ApiResult<TValue>): TValue | { readonly error: { readonly code: string; readonly message: string } } =>
  result.ok ? result.value : { error: { code: result.error.code, message: result.error.message } };

/** The JSON of the Services page: the API's answer as it came, or its error. */
export const servicesJson = (result: ApiResult<ServicesPage>): unknown => answered(result);

/** The JSON of a Service page: the service and the last calls, as the API answered. */
export const serviceJson = (service: ApiResult<ServiceDetail>, calls: ApiResult<CallsPage>): Record<string, unknown> => ({
  service: answered(service),
  calls: answered(calls),
});
