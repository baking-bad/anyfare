import type { ServiceSort, ServicesQuery } from '../api/types';

// The Services page's search, sort and page number, and how they read from and write to the page's URL:
// `?q=&sort=&page=`. The server renders from the same URL the browser shows.

export const servicesPageSize = 20;

export const defaultSort: ServiceSort = 'calls';

/** The sorts the page offers, in order. */
export const sortChoices: readonly { readonly value: ServiceSort; readonly label: string }[] = [
  { value: 'calls', label: 'Most calls through Anyfare' },
  { value: 'buyers', label: 'Most buyers' },
  { value: 'volume', label: 'Most volume' },
  { value: 'endpoints', label: 'Most paid endpoints' },
  { value: 'price', label: 'Cheapest' },
];

const maxSearchLength = 100;
const maxPage = 100_000;

export interface ServicesFilters {
  // A part of the host
  readonly q?: string;
  readonly sort: ServiceSort;
  // From 1
  readonly page: number;
}

type Source = URLSearchParams | Readonly<Record<string, string | readonly string[] | undefined>>;

const valueOf = (source: Source, name: string): string => {
  const raw = source instanceof URLSearchParams ? source.get(name) ?? undefined : source[name];
  const text = Array.isArray(raw) ? raw[0] : raw;

  return typeof text === 'string' ? text : '';
};

const isSort = (value: string): value is ServiceSort => sortChoices.some(choice => choice.value === value);

/** The filters a URL's query holds. A value the page doesn't know is dropped, and the page counts from 1. */
export const parseServicesFilters = (source: Source): ServicesFilters => {
  const q = valueOf(source, 'q').trim().slice(0, maxSearchLength);
  const sort = valueOf(source, 'sort');
  const page = Number(valueOf(source, 'page'));

  return {
    ...q === '' ? {} : { q },
    sort: isSort(sort) ? sort : defaultSort,
    page: Number.isInteger(page) && page >= 1 ? Math.min(page, maxPage) : 1,
  };
};

/** The query string of the filters, in a fixed order, without what is default. */
export const servicesQuery = (filters: ServicesFilters): string => {
  const search = new URLSearchParams();
  if (filters.q !== undefined && filters.q !== '')
    search.set('q', filters.q);
  if (filters.sort !== defaultSort)
    search.set('sort', filters.sort);
  if (filters.page > 1)
    search.set('page', String(filters.page));
  const text = search.toString();

  return text === '' ? '' : `?${text}`;
};

/** The page's address for the filters, such as `/services?sort=price&page=2`. `base` swaps `/services`, such as for the twin. */
export const servicesHref = (filters: ServicesFilters, base = '/services'): string => `${base}${servicesQuery(filters)}`;

/** The list's query for the filters and their page. */
export const apiServicesQuery = (filters: ServicesFilters): ServicesQuery => ({
  ...filters.q === undefined ? {} : { q: filters.q },
  sort: filters.sort,
  page: filters.page,
  size: servicesPageSize,
});

/** The filters with the search set, back on the first page. An empty text clears it. */
export const withSearch = (filters: ServicesFilters, text: string): ServicesFilters => {
  const q = text.trim().slice(0, maxSearchLength);

  return { ...q === '' ? {} : { q }, sort: filters.sort, page: 1 };
};

/** The filters with another sort, back on the first page. A sort the page doesn't know is the default. */
export const withSort = (filters: ServicesFilters, sort: string): ServicesFilters => ({
  ...filters.q === undefined ? {} : { q: filters.q },
  sort: isSort(sort) ? sort : defaultSort,
  page: 1,
});
