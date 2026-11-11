import type { Payment, PaymentState } from './api';
import type { BadgeTone } from '../components/Badge';
import { usdOf } from '../format';

// What the Payments page and the Overview's list work out from the API's payments: no network, no React.

export const pageSize = 20;

/** A host as the API matches it: lower case, letters, digits, dots and hyphens, and a port when there is one. */
const hostPattern = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::\d{1,5})?$/;

/** The host a text stands for (trimmed, lower-cased), or undefined when it doesn't look like one. */
export const hostOf = (text: string): string | undefined => {
  const host = text.trim().toLowerCase();

  return hostPattern.test(host) ? host : undefined;
};

export const stateChoices: readonly { readonly value: PaymentState | ''; readonly label: string }[] = [
  { value: '', label: 'Any' },
  { value: 'paid', label: 'Paid' },
  { value: 'free', label: 'Failed and free' },
  { value: 'pending', label: 'In flight' },
];

const states: readonly string[] = ['paid', 'free', 'pending'];

/** The filters of the Payments page. A field that is not there is not a filter. */
export interface Filters {
  readonly key?: string;
  readonly service?: string;
  readonly state?: PaymentState;
}

export const noFilters: Filters = {};

export const hasFilters = (filters: Filters): boolean => filters.key !== undefined || filters.service !== undefined || filters.state !== undefined;

/**
 * The filters a page address stands for. Each is read through its own check: `key` must be the ID of one of
 * `keyIds` (none when the keys are not known), `service` must look like a host, `state` must be one of the three.
 * Anything else, and every other parameter, is dropped.
 */
export const filtersOfQuery = (search: string, keyIds: readonly string[]): Filters => {
  const query = new URLSearchParams(search);
  const key = query.get('key');
  const service = hostOf(query.get('service') ?? '');
  const state = query.get('state');

  return {
    ...key !== null && keyIds.includes(key) ? { key } : {},
    ...service === undefined ? {} : { service },
    ...state !== null && states.includes(state) ? { state: state as PaymentState } : {},
  };
};

/** The query of a page address for filters: `?key=…&service=…&state=…`, or nothing. */
export const queryOfFilters = (filters: Filters): string => {
  const query = new URLSearchParams();
  if (filters.key !== undefined)
    query.set('key', filters.key);
  if (filters.service !== undefined)
    query.set('service', filters.service);
  if (filters.state !== undefined)
    query.set('state', filters.state);
  const text = query.toString();

  return text === '' ? '' : `?${text}`;
};

/** The pages of a cursor-paged list that were seen: the `after` of each, the first page's is `undefined`. The last is the page shown. */
export interface Cursors {
  readonly seen: readonly (string | undefined)[];
}

export const firstPage: Cursors = { seen: [undefined] };

/** The cursor of the page shown. */
export const cursorNow = (cursors: Cursors): string | undefined => cursors.seen.at(-1);

/** Moves to the page after the shown one, whose cursor the API gave. */
export const older = (cursors: Cursors, next: string): Cursors => ({ seen: [...cursors.seen, next] });

/** Moves back to the page before the shown one, with the cursor it was read with. */
export const newer = (cursors: Cursors): Cursors => cursors.seen.length > 1 ? { seen: cursors.seen.slice(0, -1) } : cursors;

export const hasNewer = (cursors: Cursors): boolean => cursors.seen.length > 1;

/** The badge of a payment: what it says and its color. */
export const paymentBadge = (payment: Payment): { readonly tone: BadgeTone; readonly text: string } => {
  if (payment.state === 'pending')
    return { tone: 'info', text: 'In flight' };
  if (payment.state === 'paid')
    return { tone: 'success', text: 'Paid' };

  return { tone: 'danger', text: payment.upstreamStatus === null ? 'Free' : `${payment.upstreamStatus} · free` };
};

/** The amount column of a payment: "−$0.01" when it was charged, "$0" when it was free, the amount in a muted tone while in flight. */
export const paymentAmount = (payment: Payment): { readonly text: string; readonly muted: boolean } => {
  if (payment.state === 'paid')
    return { text: `−${usdOf(payment.amount)}`, muted: false };
  if (payment.state === 'free')
    return { text: '$0', muted: false };

  return { text: usdOf(payment.amount), muted: true };
};

/** The public receipt of a finished call, or undefined for a call in flight. */
export const receiptUrl = (siteUrl: string, payment: Payment): string | undefined =>
  payment.state === 'pending' ? undefined : `${siteUrl}/calls/${encodeURIComponent(payment.id)}`;
