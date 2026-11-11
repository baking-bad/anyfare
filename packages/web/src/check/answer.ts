// The pay host's check of a link, read into a shape the page can trust. The answer holds text from an
// outside host (descriptions, header values, a decoded challenge, addresses), so every value is read as a
// string or a number and cut to a length, and nothing is kept that the page doesn't show.

/** The longest link the page sends for a check. A longer one is "not a link" without a request. */
export const maxLinkLength = 2_048;

/** The longest text of one value the page keeps from the answer, such as a header's value. */
const maxValue = 8_000;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A string or a finite number as text, cut to `max`; anything else is nothing. */
const text = (value: unknown, max = maxValue): string | undefined =>
  typeof value === 'string' ? value.slice(0, max) : typeof value === 'number' && Number.isFinite(value) ? String(value) : undefined;

const whole = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/** One way to pay, as the API lists it. */
export interface PayWay {
  readonly paidWith: string;
  readonly protocol: string;
  readonly asset: string;
  readonly amount: string;
  readonly currency: string;
}

/** What the API asks for a call, from the first 402. The fields of the other protocol are missing. */
export interface Asks {
  readonly amount?: string;
  readonly asset?: string;
  readonly network?: string;
  readonly paidWith?: string;
  readonly payTo?: string;
  readonly scheme?: string;
  readonly x402Version?: number;
  readonly maxTimeoutSeconds?: number;
  readonly description?: string;
  readonly mimeType?: string;
  // MPP
  readonly method?: string;
  readonly intent?: string;
  readonly realm?: string;
  readonly recipient?: string;
  readonly expires?: string;
}

export interface Upstream {
  readonly status?: number;
  // The headers the API returned, in the order they came
  readonly headers: readonly (readonly [string, string])[];
  // The decoded challenge (for MPP, the list of the target's challenges), and which protocol it is of
  readonly decoded?: unknown;
  readonly decodedAs?: 'x402' | 'mpp';
}

/** An endpoint's paid calls through Anyfare over 30 days, as the check answers them. */
export interface CheckNumbers {
  readonly calls: number;
  readonly buyers: number;
  readonly volume: string;
  readonly successRate: number | null;
  readonly p50Ms: number | null;
}

export interface PayableCheck {
  // The method the check probed with
  readonly method: string;  // The link as the pay host normalized it, and the pay link
  readonly target: string;
  readonly link: string;
  // From the target: the host, and the path without its query
  readonly host: string;
  readonly path: string;
  readonly protocol: string;
  readonly quote: { readonly amount: string; readonly fee: string; readonly currency: string } | undefined;
  readonly price: { readonly amount: string; readonly currency: string } | undefined;
  readonly asks: Asks;
  readonly upstream: Upstream;
  readonly payWith: readonly PayWay[];
  // The numbers over 30 days; null when the pay host couldn't read them
  readonly stats: CheckNumbers | null;
  // Whether the endpoint is among the services now. false: a cap or a limit kept it out, so its service page doesn't exist yet.
  readonly listed: boolean;
  readonly checkedAt: string | undefined;
  readonly ms: number | undefined;
}

export interface Refusal {
  readonly reason: string;
  readonly message: string;
  // Finer than the reason: `no_payment_asked`, `opted_out`, `dns`...
  readonly detail?: string;
  // The target's status, when it answered
  readonly status?: number;
}

// The answer of `GET /_/check` as it comes on the wire. The reader below keeps what the page shows; these
// two types are the whole answer, and tests/apiShapes.test.ts holds them to the pay host's response schema.

/** What the target asks, on the wire: the four first fields are always there, the rest depend on the protocol. */
export interface AsksAnswer {
  readonly amount: string;
  readonly asset: string;
  readonly network: string;
  readonly paidWith: string;
  readonly payTo: string | undefined;
  readonly scheme: string | undefined;
  readonly x402Version: number | undefined;
  readonly maxTimeoutSeconds: number | undefined;
  readonly description: string | undefined;
  readonly mimeType: string | undefined;
  readonly method: string | undefined;
  readonly intent: string | undefined;
  readonly realm: string | undefined;
  readonly recipient: string | undefined;
  readonly expires: string | undefined;
}

/** A payable link, on the wire. */
export interface PayableAnswer {
  readonly payable: true;
  readonly method: string;
  readonly target: string;
  readonly price: { readonly amount: string; readonly currency: string; readonly asset: string; readonly network: string | null };
  readonly quote: { readonly amount: string; readonly fee: string; readonly currency: string };
  readonly link: string;
  readonly protocol: string;
  readonly asks: AsksAnswer;
  readonly upstream: { readonly status: number; readonly headers: Readonly<Record<string, string>>; readonly x402: unknown | undefined; readonly mpp: readonly unknown[] | undefined };
  readonly payWith: readonly PayWay[];
  readonly stats: { readonly calls: number; readonly buyers: number; readonly volume: string; readonly successRate: number | null; readonly p50Ms: number | null } | null;
  readonly listed: boolean;
  readonly checkedAt: string;
  readonly ms: number;
}

/** A link the pay host won't quote, on the wire: still a 200. */
export interface RefusedAnswer {
  readonly payable: false;
  readonly method: string;
  readonly reason: string;
  readonly message: string;
  readonly detail: string | undefined;
  readonly upstream: { readonly status: number } | undefined;
}

/** The answer of `GET /_/check`: a payable link, or a refusal. */
export type CheckAnswer =
  | { readonly payable: true; readonly check: PayableCheck }
  | { readonly payable: false; readonly refusal: Refusal };

const readAsks = (value: unknown): Asks => {
  if (!isRecord(value))
    return {};
  const pick = (name: string): string | undefined => text(value[name], 600);
  const version = whole(value['x402Version']);
  const timeout = whole(value['maxTimeoutSeconds']);
  const entries: [string, string | number | undefined][] = [
    ['amount', pick('amount')], ['asset', pick('asset')], ['network', pick('network')], ['paidWith', pick('paidWith')], ['payTo', pick('payTo')],
    ['scheme', pick('scheme')], ['x402Version', version], ['maxTimeoutSeconds', timeout], ['description', text(value['description'], 2_000)],
    ['mimeType', pick('mimeType')], ['method', pick('method')], ['intent', pick('intent')], ['realm', pick('realm')], ['recipient', pick('recipient')],
    ['expires', pick('expires')],
  ];

  return Object.fromEntries(entries.filter(([, entry]) => entry !== undefined)) as Asks;
};

const readStats = (value: unknown): CheckNumbers | null => {
  if (!isRecord(value))
    return null;
  const calls = whole(value['calls']);
  const buyers = whole(value['buyers']);
  const volume = text(value['volume'], 100);
  if (calls === undefined || buyers === undefined || volume === undefined)
    return null;
  const success = whole(value['successRate']);
  const median = whole(value['p50Ms']);

  return { calls, buyers, volume, successRate: success ?? null, p50Ms: median ?? null };
};

const readUpstream = (value: unknown): Upstream => {
  if (!isRecord(value))
    return { headers: [] };
  const headers = isRecord(value['headers'])
    ? Object.entries(value['headers']).flatMap(([name, header]) => {
      const content = text(header);

      return content === undefined ? [] : [[name.slice(0, 200), content] as const];
    })
    : [];
  const status = whole(value['status']);
  const decodedAs = value['x402'] !== undefined ? 'x402' : value['mpp'] !== undefined ? 'mpp' : undefined;

  return {
    ...status === undefined ? {} : { status },
    headers,
    ...decodedAs === undefined ? {} : { decoded: value[decodedAs], decodedAs },
  };
};

const readWays = (value: unknown): readonly PayWay[] => Array.isArray(value)
  ? value.flatMap((way): PayWay[] => {
    if (!isRecord(way))
      return [];
    const paidWith = text(way['paidWith'], 100);
    const amount = text(way['amount'], 100);
    if (paidWith === undefined || amount === undefined)
      return [];

    return [{ paidWith, protocol: text(way['protocol'], 100) ?? '', asset: text(way['asset'], 100) ?? '', amount, currency: text(way['currency'], 20) ?? 'USD' }];
  })
  : [];

const readQuote = (value: unknown): PayableCheck['quote'] => {
  if (!isRecord(value))
    return undefined;
  const amount = text(value['amount'], 100);
  const fee = text(value['fee'], 100);

  return amount === undefined || fee === undefined ? undefined : { amount, fee, currency: text(value['currency'], 20) ?? 'USD' };
};

const readPrice = (value: unknown): PayableCheck['price'] => {
  if (!isRecord(value))
    return undefined;
  const amount = text(value['amount'], 100);

  return amount === undefined ? undefined : { amount, currency: text(value['currency'], 20) ?? 'USD' };
};

/**
 * The answer of the check, or `undefined` when it isn't one: no `payable` flag, a payable answer with no
 * target or link, or a refusal with no reason. Other fields are optional: a missing one is left out of the page.
 */
export const readCheckAnswer = (value: unknown): CheckAnswer | undefined => {
  if (!isRecord(value) || typeof value['payable'] !== 'boolean')
    return undefined;
  if (!value['payable']) {
    const reason = text(value['reason'], 100);
    if (reason === undefined)
      return undefined;
    const detail = text(value['detail'], 300);
    const status = isRecord(value['upstream']) ? whole(value['upstream']['status']) : undefined;

    return { payable: false, refusal: { reason, message: text(value['message'], 600) ?? '', ...detail === undefined ? {} : { detail }, ...status === undefined ? {} : { status } } };
  }
  const target = text(value['target'], 4_096);
  const link = text(value['link'], 4_096);
  if (target === undefined || link === undefined)
    return undefined;
  let url: URL;
  try {
    url = new URL(target);
  }
  catch {
    return undefined;
  }
  const quote = readQuote(value['quote']);
  const price = readPrice(value['price']);
  const checkedAt = text(value['checkedAt'], 40);
  const ms = whole(value['ms']);

  return {
    payable: true,
    check: {
      method: text(value['method'], 10) ?? 'GET',
      target,
      link,
      host: url.host,
      path: url.pathname,
      protocol: text(value['protocol'], 20) ?? 'x402',
      quote,
      price,
      asks: readAsks(value['asks']),
      upstream: readUpstream(value['upstream']),
      payWith: readWays(value['payWith']),
      stats: readStats(value['stats']),
      // Only a plain true lists it: an answer without the field never leads to a page that may not exist
      listed: value['listed'] === true,
      checkedAt,
      ms,
    },
  };
};
