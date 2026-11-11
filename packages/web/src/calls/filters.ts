import type { CallStatus, CallsFilter, CallsQuery, PaidWith } from '../api/types';

// The Calls page's filters and page number, and how they read from and write to the page's URL:
// `?paidWith=&service=&endpoint=&status=&page=`. The server renders from the same URL the browser shows.

export const pageSize = 20;

/** The ways to pay the filter offers, in order. */
export const paidWithChoices = ['near', 'base', 'solana', 'tempo', 'credits'] as const;

export const statusChoices: readonly CallStatus[] = ['paid', 'free'];

// A control character, a NUL included, which the API refuses in a filter
// eslint-disable-next-line no-control-regex
const controls = /[\u0000-\u001f\u007f-\u009f]/g;

/** A filter's text without control characters. */
export const withoutControls = (text: string): string => text.replace(controls, '');

const maxServiceLength = 100;
const maxEndpointLength = 300;
const maxPage = 100_000;

export interface CallsFilters {
  readonly paidWith?: PaidWith;
  // A part of the host
  readonly service?: string;
  // The exact path. The page has no control for it, but a link can carry it.
  readonly endpoint?: string;
  readonly status?: CallStatus;
  // From 1
  readonly page: number;
}

type Source = URLSearchParams | Readonly<Record<string, string | readonly string[] | undefined>>;

const valueOf = (source: Source, name: string): string => {
  const raw = source instanceof URLSearchParams ? source.get(name) ?? undefined : source[name];
  const text = Array.isArray(raw) ? raw[0] : raw;

  return typeof text === 'string' ? text : '';
};

/** The filters a URL's query holds. A value the page doesn't know is dropped, and the page counts from 1. */
export const parseFilters = (source: Source): CallsFilters => {
  const paidWith = valueOf(source, 'paidWith');
  const status = valueOf(source, 'status');
  const service = withoutControls(valueOf(source, 'service')).trim().slice(0, maxServiceLength);
  const endpoint = withoutControls(valueOf(source, 'endpoint')).trim();
  const page = Number(valueOf(source, 'page'));

  return {
    ...(paidWithChoices as readonly string[]).includes(paidWith) ? { paidWith } : {},
    ...service === '' ? {} : { service },
    ...endpoint.startsWith('/') && endpoint.length <= maxEndpointLength ? { endpoint } : {},
    ...status === 'paid' || status === 'free' ? { status } : {},
    page: Number.isInteger(page) && page >= 1 ? Math.min(page, maxPage) : 1,
  };
};

/** The query string of the filters, in a fixed order, without what is empty. The first page has no `page`. */
export const filtersQuery = (filters: CallsFilters): string => {
  const search = new URLSearchParams();
  if (filters.paidWith !== undefined)
    search.set('paidWith', filters.paidWith);
  if (filters.service !== undefined && filters.service !== '')
    search.set('service', filters.service);
  if (filters.endpoint !== undefined && filters.endpoint !== '')
    search.set('endpoint', filters.endpoint);
  if (filters.status !== undefined)
    search.set('status', filters.status);
  if (filters.page > 1)
    search.set('page', String(filters.page));
  const text = search.toString();

  return text === '' ? '' : `?${text}`;
};

/** The page's address for the filters, such as `/calls?paidWith=near&page=2`. `base` swaps `/calls`, such as for the twin. */
export const callsHref = (filters: CallsFilters, base = '/calls'): string => `${base}${filtersQuery(filters)}`;

/** Whether any filter is set. The page number isn't one. */
export const isFiltered = ({ paidWith, service, endpoint, status }: CallsFilters): boolean =>
  paidWith !== undefined || service !== undefined || endpoint !== undefined || status !== undefined;

/** The filters the list and the stream take. */
export const apiFilter = ({ paidWith, service, endpoint, status }: CallsFilters): CallsFilter => ({
  ...paidWith === undefined ? {} : { paidWith },
  ...service === undefined ? {} : { service },
  ...endpoint === undefined ? {} : { endpoint },
  ...status === undefined ? {} : { status },
});

/** The list's query for the filters and their page. */
export const apiQuery = (filters: CallsFilters): CallsQuery => ({ ...apiFilter(filters), page: filters.page, size: pageSize });

/** The filters with one set from a control's value, back on the first page. An empty or unknown value clears it. */
export const withFilter = (filters: CallsFilters, name: 'paidWith' | 'service' | 'status', value: string): CallsFilters => {
  const search = new URLSearchParams(filtersQuery({ ...filters, page: 1 }));
  if (value.trim() === '')
    search.delete(name);
  else
    search.set(name, value.trim());

  return parseFilters(search);
};
