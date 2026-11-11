import type { Period } from '../api/types';
import { chainName } from '../receipt/content';
import { usdOf } from '../format';
import { defaultPeriod, parsePeriod } from '../services/content';
import { checkHeader, checkMethods, defaultMethod, knownMethod, parseMethod, type CheckMethod } from './method';
import { maxLinkLength, type Asks, type PayableCheck, type PayWay, type Refusal } from './answer';

export { checkHeader, checkMethods, defaultMethod, knownMethod, parseMethod, type CheckMethod };

// The words and small rules of the Check page. The page and its Markdown twin both read them, so they say
// the same. Everything that comes from the pay host's answer is plain text: a function here returns text,
// never markup.

export const checkTitle = 'Check a link';

export const checkDescription = 'Paste the link of one paid API and see what it asks, what it costs through Anyfare, and every way to pay it. Nothing is paid by checking.';

/** Under a payable check whose link a cap or a limit kept out of the list: its service page would be a 404. */
export const unlistedLine = 'This link isn\'t in the list of services yet.';

export const emptyLine = 'Paste the link of one paid endpoint, the one that answers 402.';

export const checkingLine = 'Checking the link. This can take a few seconds.';

export const noCallsLine = 'No calls through Anyfare yet. Yours can be the first.';

export const unavailableTitle = 'We couldn\'t check this link.';

export const unavailableLine = 'The pay host didn\'t answer. Try again in a moment.';

/** The longest description of an API the page shows. */
export const maxDescriptionLength = 300;

/** The longest title the page gives. */
export const maxTitleLength = 80;

/** Text cut to `max` characters, with "…" when it was longer. */
export const cut = (value: string, max: number): string => value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`;

// ---------- The URL ----------

export type CheckTab = 'overview' | 'json' | 'headers' | 'code';

export const checkTabs: readonly { readonly id: CheckTab; readonly label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'json', label: 'JSON' },
  { id: 'headers', label: 'Headers' },
  { id: 'code', label: 'Code' },
];

export const periodChoices: readonly { readonly value: Period; readonly label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: 'all', label: 'All' },
];

/** How a period reads next to a number: "Today", "7 days", "30 days", "All time". */
export const periodName = (period: Period): string => ({ today: 'Today', '7d': '7 days', '30d': '30 days', all: 'All time' } as const)[period];

/** The calls grid's page size. */
export const callsSize = 10;

// The API reads 10,000 calls deep and no further
const maxPage = 1_000;

/** What the page's URL holds: `?url=&method=&tab=&period=&page=`. */
export interface CheckParams {
  // The link as the visitor typed it, trimmed
  readonly url: string;
  // The method the check probes with
  readonly method: CheckMethod;
  readonly tab: CheckTab;
  readonly period: Period;
  // From 1
  readonly page: number;
}

type Source = URLSearchParams | Readonly<Record<string, string | readonly string[] | undefined>>;

const valueOf = (source: Source, name: string): string => {
  const raw = source instanceof URLSearchParams ? source.get(name) ?? undefined : source[name];
  const value = Array.isArray(raw) ? raw[0] : raw;

  return typeof value === 'string' ? value : '';
};

const isTab = (value: string): value is CheckTab => checkTabs.some(tab => tab.id === value);

/** The state a URL's query holds. Anything the page doesn't know is dropped: the method is GET, the tab is Overview, the period 30 days, the page 1. */
export const parseCheckParams = (source: Source): CheckParams => {
  const tab = valueOf(source, 'tab');
  const page = Number(valueOf(source, 'page'));

  return {
    url: valueOf(source, 'url').trim(),
    method: parseMethod(valueOf(source, 'method')),
    tab: isTab(tab) ? tab : 'overview',
    period: parsePeriod(valueOf(source, 'period')),
    page: Number.isInteger(page) && page >= 1 ? Math.min(page, maxPage) : 1,
  };
};

/** The query string of the state, in a fixed order, without what is default (the method GET included). The link goes as typed. */
export const checkQuery = (params: CheckParams): string => {
  const search = new URLSearchParams();
  if (params.url !== '')
    search.set('url', params.url);
  if (params.method !== defaultMethod)
    search.set('method', params.method);
  if (params.tab !== 'overview')
    search.set('tab', params.tab);
  if (params.period !== defaultPeriod)
    search.set('period', params.period);
  if (params.page > 1)
    search.set('page', String(params.page));
  const query = search.toString();

  return query === '' ? '' : `?${query}`;
};

/** The page's address for the state, such as `/check?url=api.example.com%2Fv1&tab=json`. `base` swaps `/check`, such as for the twin. */
export const checkAddress = (params: CheckParams, base = '/check'): string => `${base}${checkQuery(params)}`;

/** Whether the link is too long to send. */
export const isTooLong = (url: string): boolean => url.length > maxLinkLength;

/** The longest link the field repeats. A longer one still reads as too long. */
export const maxFieldLength = maxLinkLength * 2;

// ---------- The link ----------

/**
 * The host and the path of a link as the visitor typed it, without its scheme, query and fragment. A link
 * that isn't one has no host.
 */
export const linkParts = (link: string): { readonly host: string; readonly path: string } => {
  const bare = link.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[?#]/, 1)[0] ?? '';
  const slash = bare.indexOf('/');

  return slash < 0 ? { host: bare, path: '' } : { host: bare.slice(0, slash), path: bare.slice(slash) };
};

/**
 * The link inside a link to the pay host itself, such as `<pay host>/api.example.com/v1/x`: what follows the
 * pay host and its slash, query included. Undefined when the link is not on the pay host. A link to the pay
 * host with nothing after it gives an empty text. `payHost` is the pay host as `host` or `host:port`.
 */
export const ownPayInner = (link: string, payHost: string): string | undefined => {
  const trimmed = link.trim();
  const bare = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const end = bare.search(/[/?#]/);
  const host = (end < 0 ? bare : bare.slice(0, end)).toLowerCase().replace(/\.(?=$|:)/, '');
  if (host === '' || host !== payHost.toLowerCase().replace(/\.(?=$|:)/, ''))
    return undefined;
  const rest = end < 0 ? '' : bare.slice(end);

  return rest.replace(/^\/+/, '').replace(/^[?#].*$/, '');
};

/** What the card says of a link to the pay host itself. */
export const ownPayTitle = 'This is already an Anyfare pay link';

export const ownPayLine = (payHost: string): string => `Paste the API's own link: the part after ${payHost}/.`;

export const ownPayButton = 'Check that link';

/** The page's title for a link: "Check: <host><path>", with the method before the link when it is not GET, cut at 80 characters. Without a link it is "Check a link". */
export const titleFor = (link: string, method: CheckMethod = defaultMethod): string => {
  const { host, path } = linkParts(link);
  const shown = `${host}${path}`;

  return shown === '' ? checkTitle : cut(`Check: ${method === defaultMethod ? '' : `${method} `}${shown}`, maxTitleLength);
};

/** The flag of a call by hand: ` -X POST` for a method that is not GET, nothing for GET (curl's own default). */
export const methodFlag = (method: CheckMethod): string => method === defaultMethod ? '' : ` -X ${method}`;

/** A word for a shell: left as it is when it holds only safe characters, otherwise in single quotes with a quote inside closed and reopened. */
export const shellWord = (value: string): string =>
  /^[A-Za-z0-9._~:/@%+,=-]+$/.test(value) ? value : `'${value.replaceAll('\'', '\'\\\'\'')}'`;

// ---------- What the API asks ----------

const asDollars = (amount: string | undefined): string => amount === undefined ? '' : usdOf(amount);

/** The chain or network a payment is on, as a sentence names it: NEAR, Base, Solana, Tempo; an unknown one reads as its ID. */
const where = (asks: Asks): string => asks.paidWith === undefined ? asks.network ?? '' : chainName(asks.paidWith);

/**
 * The parts of the sentence "What the API asks", so the page can bold the figures. `plain` is the same
 * sentence as one string for the Markdown twin.
 */
export interface AsksSentence {
  readonly parts: readonly { readonly text: string; readonly strong?: boolean; readonly code?: boolean }[];
  readonly plain: string;
}

const sentenceOf = (parts: AsksSentence['parts']): AsksSentence => ({ parts, plain: parts.map(part => part.text).join('') });

/** How long until a moment: "in about 25 seconds", or nothing when it has passed or isn't a time. */
const expiresIn = (expires: string | undefined, from: string | undefined): string | undefined => {
  const end = expires === undefined ? Number.NaN : Date.parse(expires);
  const start = from === undefined ? Date.now() : Date.parse(from);
  if (!Number.isFinite(end) || !Number.isFinite(start) || end <= start)
    return undefined;
  const seconds = Math.round((end - start) / 1000);

  return seconds < 90 ? `in about ${seconds} seconds` : `in about ${Math.round(seconds / 60)} minutes`;
};

/** The ask in plain words, built from `asks`: the amount, the asset and the chain, the protocol, and what the protocol adds. */
export const asksSentence = (check: Pick<PayableCheck, 'asks' | 'protocol' | 'price' | 'checkedAt'>): AsksSentence => {
  const { asks, protocol } = check;
  const amount = asDollars(asks.amount ?? check.price?.amount);
  const asset = asks.asset ?? '';
  const place = where(asks);
  const price = [amount, asset === '' ? '' : `in ${asset}`, place === '' ? '' : `on ${place}`].filter(Boolean).join(' ');
  const head: AsksSentence['parts'] = [
    { text: 'This API asks ' },
    { text: price === '' ? 'a payment' : price, strong: true },
    { text: ' for each call, over ' },
    { text: protocol === 'mpp' ? 'MPP' : protocol === 'x402' ? 'x402' : protocol, strong: true },
    { text: '. ' },
  ];
  if (protocol === 'mpp') {
    const wants = asks.intent === undefined ? 'a signed payment' : `a signed ${asks.intent}`;
    const left = expiresIn(asks.expires, check.checkedAt);

    return sentenceOf([
      ...head,
      { text: `It wants ${wants}${asks.method === undefined ? '' : ` by the ${asks.method} method`}.` },
      ...left === undefined ? [] : [{ text: ` The charge expires ${left}.` }],
    ]);
  }

  return sentenceOf([
    ...head,
    ...asks.payTo === undefined ? [] : [{ text: 'It pays to ' }, { text: asks.payTo, code: true }, { text: '. ' }],
    ...asks.maxTimeoutSeconds === undefined ? [] : [{ text: `A signed payment is good for ${asks.maxTimeoutSeconds} seconds.` }],
  ]);
};

/** One row of the key-value list under the sentence. */
export interface AskRow {
  readonly label: string;
  readonly value: string;
  // Shown in the mono font
  readonly code?: boolean;
}

// The first entry the decoded x402 challenge offers, for the asset's address and the base units
const firstAccept = (check: Pick<PayableCheck, 'upstream'>): Record<string, unknown> | undefined => {
  const { decoded } = check.upstream;
  const accepts = typeof decoded === 'object' && decoded !== null ? (decoded as { accepts?: unknown }).accepts : undefined;
  const first: unknown = Array.isArray(accepts) ? accepts[0] : undefined;

  return typeof first === 'object' && first !== null ? first as Record<string, unknown> : undefined;
};

const stringOf = (value: unknown): string | undefined => typeof value === 'string' || typeof value === 'number' ? String(value).slice(0, 200) : undefined;

/** A long address as its start and end, so a row stays readable. The whole address is the row's title. */
export const shortValue = (value: string, max = 14): string => value.length <= max + 6 ? value : `${value.slice(0, Math.floor(max / 2) - 1)}…${value.slice(-Math.floor(max / 2) + 1)}`;

/** The key-value list of what the API asks, from `asks` and the decoded challenge. A value the answer lacks, or holds empty, has no row, on any protocol. */
export const askRows = (check: Pick<PayableCheck, 'asks' | 'protocol' | 'upstream' | 'price' | 'checkedAt'>): readonly AskRow[] =>
  askRowsOf(check).filter(row => row.value.trim() !== '');

const askRowsOf = (check: Pick<PayableCheck, 'asks' | 'protocol' | 'upstream' | 'price' | 'checkedAt'>): readonly AskRow[] => {
  const { asks } = check;
  const rows: AskRow[] = [];
  if (check.protocol === 'mpp') {
    rows.push({ label: 'Protocol', value: `MPP${asks.method === undefined ? '' : `, method ${asks.method}`}${asks.intent === undefined ? '' : `, intent ${asks.intent}`}` });
    const amount = asks.amount ?? check.price?.amount;
    if (amount !== undefined)
      rows.push({ label: 'Amount', value: `${amount} ${asks.asset ?? 'USD'}`.trim() });
    if (asks.recipient !== undefined)
      rows.push({ label: 'Recipient', value: asks.recipient, code: true });
    if (asks.realm !== undefined)
      rows.push({ label: 'Realm', value: asks.realm });
    if (asks.expires !== undefined)
      rows.push({ label: 'Expires', value: expiresAt(asks.expires) });

    return rows;
  }
  rows.push({ label: 'Protocol', value: `${check.protocol === 'x402' ? 'x402' : check.protocol}${asks.x402Version === undefined ? '' : ` version ${asks.x402Version}`}${asks.scheme === undefined ? '' : `, scheme ${asks.scheme}`}` });
  if (asks.network !== undefined)
    rows.push({ label: 'Network', value: asks.network, code: true });
  const accept = firstAccept(check);
  const assetId = stringOf(accept?.['asset']);
  if (asks.asset !== undefined || assetId !== undefined)
    rows.push({ label: 'Asset', value: [asks.asset, assetId === undefined ? undefined : shortValue(assetId)].filter(Boolean).join(' · ') });
  const units = stringOf(accept?.['amount']);
  const dollars = asDollars(asks.amount ?? check.price?.amount);
  if (units !== undefined || dollars !== '')
    rows.push({ label: 'Amount', value: [units === undefined ? '' : `${units} base units`, dollars].filter(Boolean).join(' = ') });
  if (asks.payTo !== undefined)
    rows.push({ label: 'Pays to', value: asks.payTo, code: true });
  if (asks.mimeType !== undefined)
    rows.push({ label: 'Answer type', value: asks.mimeType });

  return rows;
};

/** A moment as "10:06:00 UTC". A text that isn't a moment stays as it is. */
export const expiresAt = (moment: string): string => {
  const time = Date.parse(moment);

  return Number.isFinite(time) ? `${new Date(time).toISOString().slice(11, 19)} UTC` : moment;
};

/** The description of the API, cut at 300 characters. Nothing when it has none. */
export const describedAs = (asks: Asks): string | undefined => {
  const description = asks.description?.trim();

  return description === undefined || description === '' ? undefined : cut(description, maxDescriptionLength);
};

// ---------- How to pay ----------

/** The two lines of a way to pay: its name, and what is special about it. */
export const wayWords = (way: PayWay): { readonly name: string; readonly note: string } => {
  const chain = chainName(way.paidWith);
  const note = ({
    near: 'x402 · settles in about 2 s',
    base: 'x402 · settles in about 2 s',
    solana: 'x402 · settles in about 1 s',
    tempo: 'MPP charge · sign and send at once',
    credits: 'No transaction per call',
  } as Readonly<Record<string, string>>)[way.paidWith];

  return {
    name: way.paidWith === 'credits' ? 'Credits, with a payment key' : `${way.asset === '' ? 'USDC' : way.asset} on ${chain}`,
    note: note ?? way.protocol.toUpperCase(),
  };
};

/** The prompt to give an agent, with the pay link. A method that is not GET is named in the first line. */
export const agentPrompt = (link: string, method: CheckMethod = defaultMethod): string => `Call ${link}${method === defaultMethod ? '' : ` with ${method}`} through Anyfare.
Pay with my payment key from $ANYFARE_PAYMENT_KEY.
Don't pay more than $0.05 for one call.`;

// ---------- Refusals ----------

/** What the card says of a link that isn't payable: a title, a line, and whether the link is shown above it. */
export interface RefusalWords {
  readonly title: string;
  readonly text: string;
}

const refusals: Readonly<Record<string, RefusalWords>> = {
  not_payable: { title: 'Not a paid link', text: 'This link answered without asking for a payment. Anyfare checks paid links only: paste the link of one paid endpoint, the one that answers 402.' },
  unsupported_payment: { title: 'A paid link we can\'t pay yet', text: 'This link asks for a payment, but in a way Anyfare doesn\'t make yet.' },
  upstream_unavailable: { title: 'The link didn\'t answer', text: 'We couldn\'t reach this host. Check the link and try again.' },
  invalid_target: { title: 'This isn\'t a link', text: 'Paste a full link to one endpoint, such as api.example.com/v1/quote.' },
  rate_limited: { title: 'Too many checks', text: 'Wait a minute and try again.' },
};

// One sentence for each detail the pay host gives, under its reason's title
const detailText: Readonly<Record<string, string>> = {
  not_a_url: 'Paste a full link to one endpoint, such as api.example.com/v1/quote.',
  invalid_host: 'This isn\'t a host we can route to.',
  ip_address: 'Paste a link with a host name, not an IP address.',
  blocklisted: 'Anyfare doesn\'t route payments to this host.',
  own_host: 'This is one of Anyfare\'s own hosts.',
  private_address: 'This link points to a private address.',
  opted_out: 'This API asked not to be routed through Anyfare.',
  no_challenge: 'This link answered 402, but without a payment request Anyfare can read.',
  no_option: 'This link asks for a payment, but in a way Anyfare can\'t pay yet.',
  dns: 'This host name doesn\'t resolve.',
  headers_too_large: 'The API answered with headers too large to read.',
  refused: 'This host refused the connection.',
  timeout: 'This host didn\'t answer in time.',
  unreachable: 'This host couldn\'t be reached.',
};

// A detail that has a title of its own, where the reason's title would read wrong for it
const detailTitle: Readonly<Record<string, string>> = {
  invalid_host: 'We can\'t route to this host',
};

// The details each reason has: a detail of another reason is not worded as this one
const detailsOf: Readonly<Record<string, readonly string[]>> = {
  invalid_target: ['not_a_url', 'invalid_host', 'ip_address'],
  host_not_allowed: ['blocklisted', 'own_host', 'private_address', 'opted_out'],
  unsupported_payment: ['no_challenge', 'no_option'],
  upstream_unavailable: ['dns', 'refused', 'timeout', 'unreachable', 'headers_too_large'],
};

/** Every reason that has details, with them. `not_payable` has the one, `no_payment_asked`, which its text covers. */
export const refusalDetails: readonly (readonly [string, readonly string[]])[] = [...Object.entries(detailsOf), ['not_payable', ['no_payment_asked']]];

/**
 * The words for a refusal by its `reason` and its `detail`, and the method of the check. A link that answered
 * with a status says it; a probe that wasn't a GET says which method was tried. A reason or detail the page
 * doesn't know shows the API's message as text.
 */
export const refusalWords = (refusal: Refusal, method: CheckMethod = defaultMethod): RefusalWords => {
  const { reason, detail } = refusal;
  if (reason === 'host_not_allowed')
    return { title: 'We don\'t route to this host', text: detail !== undefined && detailsOf[reason]!.includes(detail) ? detailText[detail]! : 'Anyfare doesn\'t send calls to this host.' };
  if (reason === 'not_payable') {
    const answered = refusal.status === undefined ? 'answered' : `answered ${refusal.status}`;
    const sent = method === defaultMethod ? 'This link' : `We sent ${method} to this link and it`;

    return { title: 'Not a paid link', text: `${sent} ${answered} without asking for a payment. Anyfare checks paid links only: paste the link of one paid endpoint, the one that answers 402.` };
  }
  const base = refusals[reason];
  if (base !== undefined)
    return detail !== undefined && detailsOf[reason]?.includes(detail) ? { title: detailTitle[detail] ?? base.title, text: detailText[detail]! } : base;

  return { title: 'We couldn\'t check this link', text: cut(refusal.message, maxDescriptionLength) };
};

/** The line and the button under a link that answered a GET without asking for payment: some APIs ask only on POST. */
export const tryPostLine = 'Some APIs ask for payment only on POST.';

export const tryPostLabel = 'Check it as POST';

/** Whether the refusal is the one that offers the POST check: the link answered a GET without asking for a payment. */
export const offersPost = (refusal: Refusal, method: CheckMethod): boolean => refusal.reason === 'not_payable' && method === defaultMethod;

/** The refusal for a link that is too long, or not a link at all, before any request. */
export const tooLongRefusal: Refusal = { reason: 'invalid_target', detail: 'not_a_url', message: 'The link is too long' };

// ---------- Code ----------

/** The calls of the Code tab, each with the pay link. */
export const codeSamples = (link: string, method: CheckMethod = defaultMethod): { readonly key: string; readonly byHand: string; readonly prompt: string } => ({
  key: `curl${methodFlag(method)} ${shellWord(link)} \\\n  -H "Authorization: Bearer $ANYFARE_PAYMENT_KEY"`,
  byHand: `# 1. Call the pay link. It answers 402 and says what to pay.\ncurl -i${methodFlag(method)} ${shellWord(link)}\n\n# 2. Call it again with the payment your x402 client signed.\ncurl${methodFlag(method)} ${shellWord(link)} \\\n  -H "PAYMENT-SIGNATURE: <the payment your x402 client made>"`,
  prompt: agentPrompt(link, method),
});

/** The one line under the by-hand calls. */
export const byHandNote = 'Any x402 client does both steps for you: give it the pay link and it reads the 402, pays, and repeats the call.';
