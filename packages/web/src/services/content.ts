import type { Period } from '../api/types';
import { ago, pct } from '../format';

// The words and small rules of the Services page and the Service page. The pages and their Markdown
// twins both read them, so they say the same.

export const servicesTitle = 'Services';

export const servicesLead = 'Services agents paid through Anyfare. Any x402 or MPP API can be paid the same way: paste its link on the home page.';

export const servicesDescription = 'The services agents paid through Anyfare: paid endpoints, the price they start at, calls, buyers and how well they answer, for 30 days. Any x402 or MPP API can be paid the same way.';

export const noMatchLine = 'Nothing matches. Any x402 or MPP API can still be paid: paste its link on the home page.';

export const firstRunTitle = 'No services yet';

export const firstRunLine = 'Services appear here once agents have paid them through Anyfare.';

export const unavailableLine = 'The Platform API didn\'t answer. Try again in a moment.';

/** How to pay any listed service, for the twins. `payUrl` is the pay host's origin. */
export const payHowLine = (payUrl: string): string =>
  `Any of them that asks for x402 or MPP can be paid at ${payUrl}/<host>/<path>, from any way we take: USDC on NEAR, Base or Solana, USDC.e on Tempo, or a payment key. The API's own chain doesn't limit how you pay. The price is a guide: the live 402 is what counts.`;

export const serviceMissingTitle = 'Service not found';

export const serviceMissingLine = 'No paid call went to this service through Anyfare yet.';

export const serviceDescription = (host: string): string =>
  `${host} through Anyfare: its paid endpoints and prices, paid calls, buyers, how they paid, and how well it answers. Calls to it, live.`;

/**
 * A host name a service page can be about: dot-separated labels of letters, digits and hyphens, at least
 * two, at most 253 characters. A host in capitals is the same host.
 */
export const isHost = (host: string): boolean =>
  host.length <= 253 && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(host);

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
  `${base}/${encodeURIComponent(host)}${period === defaultPeriod ? '' : `?period=${period}`}`;

/** The check page's address for a host and a path: the path's characters are escaped, its slashes stay. */
export const checkHref = (host: string, path = ''): string =>
  `/check?url=${host}${path.split('/').map(part => encodeURIComponent(part)).join('/')}`;

/**
 * How much the paid calls changed against the period before, as a share (0.18 is +18%). `null` when there
 * is nothing to compare: no period before (`all`), or no call in it.
 */
export const callsChange = (calls: number, before: number | null): number | null =>
  before === null || !Number.isFinite(before) || before <= 0 || !Number.isFinite(calls) ? null : (calls - before) / before;

/** What a buyer spent on average, in USD: the volume (a decimal string) over the buyers. `null` with no buyer. */
export const perBuyer = (volume: string, buyers: number): number | null => {
  const total = Number(volume);

  return buyers > 0 && Number.isFinite(total) && volume.trim() !== '' ? total / buyers : null;
};

/** How long ago a buyer's last call was: "2m ago", "5h ago", and from a day "3d ago". */
export const lastCall = (at: string, now: number): string => {
  const time = Date.parse(at);
  if (!Number.isFinite(time))
    return '-';
  const hours = (now - time) / 3_600_000;

  return hours >= 24 ? `${Math.floor(hours / 24)}d ago` : ago(time, now);
};

/** The share of a way to pay, against the largest one: how long its meter is, from 0 to 1. */
export const meterShare = (share: number, largest: number): number => largest > 0 ? Math.min(1, Math.max(0, share / largest)) : 0;

/** "<n> failed calls, not charged", and "1 failed call" for one. */
export const failedLine = (failed: number): string => `${failed.toLocaleString('en-US')} failed call${failed === 1 ? '' : 's'}, not charged`;

/** The share of paid calls the top buyers made, as the title bar reads it. */
export const togetherLine = (share: number): string => `Together: ${pct(share)} of paid calls`;
