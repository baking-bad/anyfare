import type { ListedStatus, Period, ServiceDetail, ServiceRow } from '../api/types';
import { defaultMethod, knownMethod } from '../check/method';
import { ago, count, pct } from '../format';

// The words and small rules of the Services page and the Service page. The pages and their Markdown
// twins both read them, so they say the same.

export const servicesTitle = 'Services';

export const servicesLead = 'Paid APIs that agents paid or checked through Anyfare. Paste any x402 or MPP link on the home page to add one.';

export const servicesDescription = 'The paid APIs that agents paid or checked through Anyfare: paid endpoints, the price they start at, and for the ones that were paid, calls, buyers and how well they answer, for 30 days. Paste any x402 or MPP link on the home page to add one.';

/** The name of the numbers at the top of the Services page, and of its twin. */
export const servicesNumberLabels = {
  listed: 'Services listed',
  paid: 'Paid through Anyfare',
  calls: 'Calls through Anyfare, 30 days',
} as const;

/** What a service or an endpoint that was only checked says where its calls would be. */
export const notPaidYet = 'Not paid yet';

/** Next to the endpoints of a service nobody has paid. */
export const nobodyPaidLine = 'Nobody has paid this API through Anyfare yet. Copy a pay link and be the first.';

/** How a link joins the list, for the twins. */
export const addServiceLine = 'To add a service, check a paid link: paste it on the home page, or call GET /_/check on the pay host. A paid link you check joins the list of services, as checked, until someone pays it.';

export const noMatchLine = 'Nothing matches. Any x402 or MPP API can still be paid: paste its link on the home page.';

export const firstRunTitle = 'No services yet';

export const firstRunLine = 'Services appear here once agents have paid or checked them through Anyfare.';

/** Under the grid, when more services had a paid call than the list keeps: a search may miss some. */
export const cappedLine = 'The list keeps the most used paid services, so a search may miss some.';

/** Near the numbers read when asked for, which stopped at their cap. */
export const inexactLine = 'Counted over the newest 10,000 calls.';

export const unavailableLine = 'The Platform API didn\'t answer. Try again in a moment.';

/** How to pay any listed service, for the twins. `payUrl` is the pay host's origin. */
export const payHowLine = (payUrl: string): string =>
  `Any of them that asks for x402 or MPP can be paid at ${payUrl}/<host>/<path>, from any way we take: USDC on NEAR, Base or Solana, USDC.e on Tempo, or a payment key. The API's own chain doesn't limit how you pay. The price is a guide: the live 402 is what counts.`;

/** The marker the Check page's Service button puts on its link: a service just listed by that check may need a moment before the API shows it. */
export const fromCheckName = 'from';
export const fromCheckValue = 'check';
export const fromCheck = `${fromCheckName}=${fromCheckValue}`;

export const serviceMissingTitle = 'Service not found';

export const serviceMissingLine = 'No paid call or check has listed this service yet.';

export const serviceDescription = (host: string): string =>
  `${host} through Anyfare: its paid endpoints and prices and, once it is paid, its calls, buyers, how they paid, and how well it answers. Calls to it, live.`;

// The API's host rule, the one rule of the website: labels of letters, digits and hyphens (at most 63, none
// starting or ending with a hyphen), at least one dot, a last label that starts with a letter, an optional
// port of up to five digits, a name of at most 253 characters and the whole of at most 259. Any case: a host
// in capitals is the same host.
const hostPattern = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}(?::[0-9]{1,5})?$/i;

/** The longest host a service page can be about, with its port. */
export const maxHost = 259;

/**
 * Whether a value is a host a service page can be about: `api.example.com` or `fake-api.test:8186`. A trailing
 * dot, a host with no dot, a path character or a value over the length limit is not a host.
 */
export const isHost = (host: string): boolean =>
  host.length <= maxHost && host.replace(/:[0-9]{1,5}$/, '').length <= 253 && hostPattern.test(host);

/**
 * The host an address holds in its path segment: percent-decoded once (a colon may come as `%3A`) and in
 * lower case. The result may still not be a host: ask `isHost`.
 */
export const hostOfSegment = (segment: string): string => {
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  }
  catch {
    // A malformed escape is kept as written, and is not a host
  }

  return decoded.toLowerCase();
};

/** A service page's path for a host: `/services/fake-api.test%3A8186`. The one builder of it. */
export const servicePath = (host: string): string => `/services/${encodeURIComponent(host.toLowerCase())}`;

export const periodChoices: readonly { readonly value: Period; readonly label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: 'all', label: 'All time' },
];

export const defaultPeriod: Period = '30d';

/** The period a query holds. Anything else is 30 days. */
export const parsePeriod = (value: string | null | undefined): Period => periodChoices.find(choice => choice.value === value)?.value ?? defaultPeriod;

/** The period as a sentence names it: "today", "the last 7 days", "the last 30 days", "all time". */
export const periodSentence = (period: Period): string => ({ today: 'today', '7d': 'the last 7 days', '30d': 'the last 30 days', all: 'all time' } as const)[period];

/** What the change in paid calls is against: "the day before", "the 7 days before", "the 30 days before". */
export const comparedWith = (period: Period): string => ({ today: 'the day before', '7d': 'the 7 days before', '30d': 'the 30 days before', all: '' } as const)[period];

/** A service page's address for a period. The default period has no query. */
export const serviceHref = (host: string, period: Period = defaultPeriod, base = '/services'): string =>
  `${base}/${encodeURIComponent(host.toLowerCase())}${period === defaultPeriod ? '' : `?period=${period}`}`;

/**
 * The check page's address for a host and a path: the path's characters are escaped, its slashes stay. The
 * endpoint's method, as the API lists it (`null` when it isn't known), goes along when it is not GET.
 */
export const checkHref = (host: string, path = '', method?: string | null): string => {
  const probe = knownMethod(method?.toUpperCase());

  return `/check?url=${host}${path.split('/').map(part => encodeURIComponent(part)).join('/')}${probe === undefined || probe === defaultMethod ? '' : `&method=${probe}`}`;
};

/**
 * How much the paid calls changed against the period before, as a share (0.18 is +18%). `null` when there
 * is nothing to compare: no period before (`all`), or no call in it.
 */
export const callsChange = (calls: number, before: number | null): number | null =>
  before === null || !Number.isFinite(before) || before <= 0 || !Number.isFinite(calls) ? null : (calls - before) / before;

/** What a buyer spent on average, in USD: the volume (a decimal string) over the buyers. `null` with no buyer. */
export const perBuyer = (volume: string, buyers: number): number | null => {
  const total = Number(volume);

  if (!(buyers > 0 && Number.isFinite(total)) || volume.trim() === '')
    return null;
  const average = total / buyers;

  // A division has no digits of its own: under a dollar it keeps three significant digits, so $0.14533333 reads $0.145
  return average < 1 ? Number(average.toPrecision(3)) : average;
};

/** How long ago a buyer's last call was: "2m ago", "5h ago", then "Yesterday" for one day, and from two days what `ago` says. */
export const lastCall = (at: string, now: number): string => {
  const time = Date.parse(at);
  if (!Number.isFinite(time))
    return '-';
  const days = Math.floor((now - time) / 86_400_000);

  return days === 1 ? 'Yesterday' : ago(time, now);
};

/**
 * The count of paid endpoints under a service's name: "7 paid endpoints". The API counts every endpoint the
 * service ever had a paid call on, and lists only those with calls in the chosen period, so when fewer are
 * listed the line says how many: "7 paid endpoints, 6 with calls in this period".
 */
export const endpointsLine = (paid: number, listed: number, checked = 0): string => {
  // The listed endpoints and the count both hold the ones a check listed, which have no calls to speak of
  const withCalls = listed - checked;

  return `${count(paid)} paid endpoint${paid === 1 ? '' : 's'}${withCalls < paid - checked ? `, ${count(withCalls)} with calls in this period` : ''}`;
};

const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

const utcDayStart = (time: number): number => Math.floor(time / 86_400_000) * 86_400_000;

/**
 * The UTC day a check was made on, for "Checked <day>": "today", "yesterday", then the date as "11 Nov 2026".
 * `undefined` when there is no time, or it isn't one.
 */
export const checkedDay = (at: string | null, now: number): string | undefined => {
  const time = at === null ? Number.NaN : Date.parse(at);
  if (!Number.isFinite(time))
    return undefined;
  const days = (utcDayStart(now) - utcDayStart(time)) / 86_400_000;
  if (days <= 0)
    return 'today';
  if (days === 1)
    return 'yesterday';
  const date = new Date(time);

  return `${date.getUTCDate()} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
};

/** "Checked today", "Checked 11 Nov 2026". `undefined` when there is no time. */
export const checkedLine = (at: string | null, now: number): string | undefined => {
  const day = checkedDay(at, now);

  return day === undefined ? undefined : `Checked ${day}`;
};

/** A service that was only checked: no paid call reached it yet. */
export const isChecked = (status: ListedStatus): boolean => status === 'checked';

/** What a row of the list says about how its service came to be listed: whether it is unpaid, and the line under its host. */
export const rowStatus = (row: Pick<ServiceRow, 'status' | 'checkedAt'>, now: number): { readonly notPaid: boolean; readonly checked: string | undefined } =>
  isChecked(row.status) ? { notPaid: true, checked: checkedLine(row.checkedAt, now) } : { notPaid: false, checked: undefined };

/**
 * What the head of a service's page says: the count of its endpoints, whether nobody has paid it, and when a
 * check last confirmed it (a paid service says it too when a check did).
 */
export const headStatus = (service: Pick<ServiceDetail, 'status' | 'checkedAt' | 'paidEndpoints'> & { readonly endpoints: readonly Pick<ServiceDetail['endpoints'][number], 'status'>[] }, now: number): {
  readonly endpoints: string;
  readonly notPaid: boolean;
  readonly checked: string | undefined;
} => ({
  endpoints: endpointsLine(service.paidEndpoints, service.endpoints.length, service.endpoints.filter(endpoint => isChecked(endpoint.status)).length),
  notPaid: isChecked(service.status),
  checked: checkedLine(service.checkedAt, now),
});

/** The line under an endpoint's path: "Checked <day>" for one that only a check listed. A paid endpoint has none. */
export const endpointNote = (endpoint: Pick<ServiceDetail['endpoints'][number], 'status' | 'checkedAt'>, now: number): string | undefined =>
  isChecked(endpoint.status) ? checkedLine(endpoint.checkedAt, now) : undefined;

/** The share of a way to pay, against the largest one: how long its meter is, from 0 to 1. */
export const meterShare = (share: number, largest: number): number => largest > 0 ? Math.min(1, Math.max(0, share / largest)) : 0;

/** "<n> failed calls, not charged", and "1 failed call" for one. */
export const failedLine = (failed: number): string => `${failed.toLocaleString('en-US')} failed call${failed === 1 ? '' : 's'}, not charged`;

/** The share of paid calls the top buyers made, as the title bar reads it. */
export const togetherLine = (share: number): string => `Together: ${pct(share)} of paid calls`;
