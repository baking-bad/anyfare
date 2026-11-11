import { getEndpointStats, listCalls } from '../api/endpoints';
import type { Reader } from '../api/reader';
import { callsJson, callsRequests, loadCalls } from '../calls/data';
import { parseFilters } from '../calls/filters';
import { callsSize, parseCheckParams } from '../check/content';
import { checkJson, checkRequests, type CheckData, type CheckState } from '../check/data';
import { loadService, loadServiceCalls, loadServices, serviceJson, serviceRequests, servicesJson, servicesRequests } from '../services/data';
import { parsePeriod, servicePath } from '../services/content';
import { parseServicesFilters } from '../services/filters';
import { twinHref } from '../seo/twin';
import type { AgentRequest } from './AgentView';

// What an Agent view needs to follow its page when the page changes in the browser: which page it is, and
// the part of the page the browser can't read again. A page's filters, page and period live in its URL and
// change with `pushState` or `replaceState`, so the view reads them from the address as it is now.

/**
 * - `static`: the page's data doesn't depend on its query (Home, For agents, a receipt).
 * - `calls`, `services`: the lists, whose filters, sort and page are in the URL.
 * - `service`: one service, whose period is in the URL.
 * - `check`: the check of a link. The check itself is made once per link, so it travels from the server; the
 *   endpoint's numbers and calls change with the period and the page, and are read again.
 */
export type AgentSource =
  | { readonly kind: 'static' }
  | { readonly kind: 'calls' }
  | { readonly kind: 'services' }
  | { readonly kind: 'service'; readonly host: string }
  | { readonly kind: 'check'; readonly state: CheckState };

/** The twin's path and query for the page as the address bar shows it now. */
export const twinKeyOf = (source: AgentSource, fallback: string, search: URLSearchParams): string => {
  switch (source.kind) {
    case 'calls': return twinHref('/calls', search);
    case 'services': return twinHref('/services', search);
    case 'service': return twinHref(servicePath(source.host), search);
    case 'check': return twinHref('/check', search);
    default: return fallback;
  }
};

/** What the browser reads again for the page's JSON and requests. */
export interface DerivedAgent {
  readonly json: unknown;
  readonly requests: readonly AgentRequest[];
}

export interface DeriveHosts {
  readonly apiUrl: string;
  readonly payUrl: string;
}

/**
 * Reads the page's data again from the public API and builds the JSON and the requests the Agent view lists,
 * with the same builders the server uses. Undefined for a page whose data doesn't change.
 */
export const deriveAgent = async (source: AgentSource, read: Reader, hosts: DeriveHosts, search: URLSearchParams): Promise<DerivedAgent | undefined> => {
  switch (source.kind) {
    case 'calls': {
      const filters = parseFilters(search);

      return { json: callsJson(await loadCalls(read, filters)), requests: callsRequests(hosts, filters) };
    }
    case 'services': {
      const filters = parseServicesFilters(search);

      return { json: servicesJson(await loadServices(read, filters)), requests: servicesRequests(hosts, filters) };
    }
    case 'service': {
      const period = parsePeriod(search.get('period'));
      const [service, calls] = await Promise.all([loadService(read, source.host, period), loadServiceCalls(read, source.host)]);

      return { json: serviceJson(service, calls), requests: serviceRequests(hosts, source.host, period) };
    }
    case 'check': {
      const params = { ...parseCheckParams(search) };
      const { state } = source;
      if (state.kind !== 'payable') {
        const data: CheckData = { params, state };

        return { json: checkJson(data), requests: checkRequests(hosts, data) };
      }
      const { host, path } = state.check;
      const [stats, calls] = await Promise.all([
        getEndpointStats(read, host, path, params.period),
        listCalls(read, { host, endpoint: path, size: callsSize, page: params.page }),
      ]);
      const data: CheckData = { params, state, stats, calls };

      return { json: checkJson(data), requests: checkRequests(hosts, data) };
    }
    default:
      return undefined;
  }
};
