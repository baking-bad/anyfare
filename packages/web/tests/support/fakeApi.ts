import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

import type { Call, CallsPage, DailyPoint, EndpointStats, LiveStats, PaidWith, Period, Receipt, ServiceDetail, ServiceRow, ServicesPage, Stats, TopStats } from '../../src/api/types';

// A small HTTP server that answers the public read API's endpoints with sample data, for the website's
// tests and for looking at the site by hand. The data is sample data: hosts are example.com, the payer
// is sample.near, and every time is today or counted back from it.
//
// Modes:
// - full: a database with calls, services and stats
// - empty: an empty database: zeros, empty lists, status 200
// - down: every request answers 500
// - capped: as full, with `totalCapped: true` on the services list
//
// In full mode some hosts show the API's less usual answers: `ocr04.example.org` has numbers that stopped at
// their cap (`exact: false`), `tts03.example.org` has no price (`priceFrom` and `priceNow` are `null`), and
// `rpc05.example.org` answers `503 stats_unavailable` for its service page and its endpoint numbers (a check of a
// link to it is payable). The link `busy.example.com` has endpoint numbers that stopped at their cap.
// `pay_settling` is a receipt whose fee is not booked yet.
//
// The same server also answers the pay host's `GET /_/check?url=`: the host of the link picks the case (see
// `sampleCheck`). Every case answers 200 with `payable`, except `limited.example.com`, which is a 429.
//
// A page that reads a new endpoint adds its answer to `answer` below, built from `sample`.
//
// By hand: `node tests/support/fakeApi.ts full 4010`. Calls made while it runs are pushed to the
// streams: `POST /_test/call` with a call as JSON, or with no body for a sample call.

export type FakeApiMode = 'full' | 'empty' | 'down' | 'capped';

const day = 86_400_000;
const periods: readonly Period[] = ['today', '7d', '30d', 'all'];

const hosts = ['api.example.com', 'data.example.com', 'quotes.example.com', 'search.example.com', 'maps.example.com'] as const;
const rails: readonly PaidWith[] = ['near', 'base', 'solana', 'tempo', 'credits'];

const money = (value: number): string => String(Math.round(value * 1000) / 1000);

/** A sample call, `secondsAgo` before `now`. `index` picks its host and how it was paid. */
export const sampleCall = (index: number, now: number, secondsAgo = index * 7 + 3): Call => {
  const paidWith = rails[index % rails.length]!;
  const free = index % 5 === 4;

  return {
    id: `pay_sample${String(index).padStart(4, '0')}`,
    at: new Date(now - secondsAgo * 1000).toISOString(),
    service: hosts[index % hosts.length]!,
    path: `/v1/sample/${index % 3 === 0 ? 'quotes/latest' : 'lookup'}`,
    method: 'GET',
    paidWith,
    apiPaidWith: paidWith === 'credits' ? 'base' : index % 2 === 0 ? 'base' : 'near',
    payer: paidWith === 'credits' ? null : paidWith === 'base' ? `0x${'ab12'.repeat(10)}` : 'sample.near',
    amount: money(0.001 * (1 + index % 10)),
    status: free ? 'free' : 'paid',
    apiStatus: free ? 502 : 200,
    ms: 120 + index * 31 % 900,
  };
};

const utcDay = (time: number): string => new Date(time).toISOString().slice(0, 10);

const dailySeries = (now: number, empty: boolean): readonly DailyPoint[] =>
  Array.from({ length: 30 }, (_, index) => {
    const calls = empty ? 0 : index < 12 ? 0 : 20 + (index * 37) % 90;

    return { day: utcDay(now - (29 - index) * day), calls, volume: money(calls * 0.011) };
  });

const shares = (empty: boolean, scale: number) => empty ? [] : rails.map((paidWith, index) => ({
  paidWith,
  calls: Math.round((300 - index * 55) * scale),
  volume: money((300 - index * 55) * scale * 0.011),
}));

const sampleStats = (now: number, empty: boolean): Stats => {
  const calls = empty ? { today: 0, '7d': 0, '30d': 0, all: 0 } : { today: 212, '7d': 1408, '30d': 1530, all: 1612 };
  const buyers = empty ? { today: 0, '7d': 0, '30d': 0, all: 0 } : { today: 38, '7d': 97, '30d': 126, all: 131 };
  const services = empty ? { today: 0, '7d': 0, '30d': 0, all: 0 } : { today: 4, '7d': 5, '30d': 5, all: 5 };

  return {
    updatedAt: empty ? null : new Date(now - 60_000).toISOString(),
    // The numbers for "all" are counted less often
    allUpdatedAt: empty ? null : new Date(now - 25 * 60_000).toISOString(),
    calls,
    volume: { ...Object.fromEntries(periods.map(period => [period, money(calls[period] * 0.0107)])) as Record<Period, string>, currency: 'USD' },
    buyers,
    services,
    byPaidWith: { today: shares(empty, 0.2), '7d': shares(empty, 0.6), '30d': shares(empty, 1), all: shares(empty, 1.1) },
    topups: { '30d': { count: empty ? 0 : 14, usd: empty ? '0' : '212.5' }, all: { count: empty ? 0 : 14, usd: empty ? '0' : '212.5' } },
    daily: dailySeries(now, empty),
  };
};

const sampleLive = (now: number, empty: boolean): LiveStats => ({
  at: new Date(now).toISOString(),
  today: empty ? { calls: 0, volume: '0', buyers: 0, nearShare: 0 } : { calls: 213, volume: '2.31', buyers: 38, nearShare: 0.35 },
  last24h: empty ? { calls: 0, volume: '0', volumeBefore: '0' } : { calls: 2140, volume: '18.42', volumeBefore: '16.39' },
  perMinute: Array.from({ length: 30 }, (_, index) => ({ minute: new Date(Math.floor(now / 60_000) * 60_000 - (29 - index) * 60_000).toISOString(), calls: empty ? 0 : index % 7 })),
});

// 27 services: the five the calls are made to, then 22 more, so the list has a second page
const moreHosts = Array.from({ length: 22 }, (_, index) => `${['feed', 'geo', 'tts', 'ocr', 'rpc', 'pdf'][index % 6]}${String(index + 1).padStart(2, '0')}.example.org`);
export const serviceHosts: readonly string[] = [...hosts, ...moreHosts];

/** The service whose numbers stopped at their cap. */
export const inexactHost = 'ocr04.example.org';
/** The service with no known price. */
export const unpricedHost = 'tts03.example.org';
/** The service whose numbers can't be read: its page and its endpoints answer 503. */
export const unavailableHost = 'rpc05.example.org';

const serviceRow = (host: string, index: number): ServiceRow => index < hosts.length ? {
  host,
  paidEndpoints: 4 - index % 3,
  priceFrom: money(0.001 * (1 + index)),
  currency: 'USD',
  calls: 612 - index * 97,
  buyers: 41 - index * 6,
  volume: money((612 - index * 97) * 0.0099),
  successRate: 0.99 - index * 0.01,
  p50Ms: 340 + index * 40,
  trend: Array.from({ length: 30 }, (_, step) => (step * 3 + index * 5) % 17),
} : {
  host,
  paidEndpoints: 1 + index % 4,
  priceFrom: money(0.001 * (1 + index % 7)),
  currency: 'USD',
  calls: 190 - (index - hosts.length) * 7,
  buyers: Math.max(1, 15 - (index - hosts.length)),
  volume: money((190 - (index - hosts.length) * 7) * 0.0099),
  // Some have no rate and no time yet
  successRate: index % 6 === 0 ? null : 0.97,
  p50Ms: index % 6 === 0 ? null : 400 + index * 5,
  trend: Array.from({ length: 30 }, (_, step) => (step * 2 + index) % 9),
};

const rowOf = (host: string, index: number): ServiceRow => host === unpricedHost ? { ...serviceRow(host, index), priceFrom: null } : serviceRow(host, index);

const serviceRows = (empty: boolean): readonly ServiceRow[] => empty ? [] : serviceHosts.map(rowOf);

const callsOf = (now: number, empty: boolean): readonly Call[] => empty ? [] : Array.from({ length: 60 }, (_, index) => sampleCall(index, now));

const intParam = (value: string | null, fallback: number, max: number): number => {
  const parsed = Number(value);

  return Number.isInteger(parsed) && parsed >= 1 ? Math.min(parsed, max) : fallback;
};

/** Whether a call passes the filters of a list or a stream: `paidWith`, `service` (a part of the host), `host` (the exact host), `endpoint` and `status`. */
export const matchesCall = (call: Call, params: URLSearchParams): boolean => {
  const paidWith = params.get('paidWith');
  const service = params.get('service');
  const host = params.get('host');
  const endpoint = params.get('endpoint');
  const status = params.get('status');

  return (paidWith === null || paidWith === call.paidWith)
    && (service === null || call.service.toLowerCase().includes(service.toLowerCase()))
    && (host === null || host === call.service)
    && (endpoint === null || endpoint === call.path)
    && (status === null || status === call.status);
};

// How each rail's payments read on an explorer. Tempo has none the site knows.
const explorerOf = (paidWith: PaidWith, hash: string): string | null => ({
  near: `https://nearblocks.io/txns/${hash}`,
  base: `https://basescan.org/tx/${hash}`,
  solana: `https://solscan.io/tx/${hash}`,
} as Partial<Record<PaidWith, string>>)[paidWith] ?? null;

const assetOf = (paidWith: PaidWith): string => paidWith === 'credits' ? 'Credits' : paidWith === 'tempo' ? 'USDC.e' : 'USDC';
const networkOf = (paidWith: PaidWith): string | null => ({ near: 'near:mainnet', base: 'eip155:8453', solana: 'solana:mainnet', tempo: 'tempo:mainnet' } as Partial<Record<PaidWith, string>>)[paidWith] ?? null;
const hashOf = (paidWith: PaidWith, seed: string): string => paidWith === 'near' ? `NearSample${seed}Tx9` : `0x${Buffer.from(seed).toString('hex').padEnd(64, '1f').slice(0, 64)}`;

/**
 * The receipt of a sample call, steps and times as the API keeps them. The ids the fake knows: a sample
 * call's own id (`pay_sample0000`), and five named cases: `pay_creditspaid`, `pay_freenoapi`,
 * `pay_notxlink` (a transaction with no explorer URL), `pay_unknownstep` and `pay_settling` (the payment is
 * not final: no settled step, no `settledAt`, and a `null` fee). Any other id is unknown.
 */
export const sampleReceipt = (id: string, now: number): Receipt | undefined => {
  const named: Readonly<Record<string, Call>> = {
    pay_creditspaid: { ...sampleCall(3, now, 20), id: 'pay_creditspaid', paidWith: 'credits', payer: null, status: 'paid', apiStatus: 200, apiPaidWith: 'base', amount: '0.01', ms: 340 },
    pay_freenoapi: { ...sampleCall(2, now, 40), id: 'pay_freenoapi', status: 'free', apiStatus: null, apiPaidWith: null, ms: null, paidWith: 'base' },
    pay_notxlink: { ...sampleCall(1, now, 60), id: 'pay_notxlink', paidWith: 'tempo', apiPaidWith: 'tempo', payer: 'sample.near', status: 'paid', apiStatus: 200 },
    pay_unknownstep: { ...sampleCall(0, now, 80), id: 'pay_unknownstep' },
    pay_settling: { ...sampleCall(1, now, 15), id: 'pay_settling', paidWith: 'base', apiPaidWith: 'base', status: 'paid', apiStatus: 200 },
  };
  const index = /^pay_sample(\d{4})$/.exec(id)?.[1];
  const call = named[id] ?? (index === undefined || Number(index) >= 60 ? undefined : sampleCall(Number(index), now));
  if (call === undefined)
    return undefined;

  const start = Date.parse(call.at);
  const at = (offset: number): string => new Date(start + offset).toISOString();
  const credits = call.paidWith === 'credits';
  const paid = call.status === 'paid';
  const settling = id === 'pay_settling';
  const hasApi = call.apiPaidWith !== null;
  const apiAsset = call.apiPaidWith === null ? 'USDC' : assetOf(call.apiPaidWith);
  const buyerHash = credits || !paid ? null : hashOf(call.paidWith, id.slice(-4));
  const apiHash = call.apiPaidWith === null ? null : hashOf(call.apiPaidWith, `api${id.slice(-3)}`);
  const steps: { step: string; at: string }[] = [
    { step: 'received', at: at(0) },
    { step: 'authorized', at: at(120) },
    ...hasApi ? [{ step: 'api_signed', at: at(250) }] : [],
    ...call.apiStatus === null ? [] : [{ step: 'api_answered', at: at(250 + (call.ms ?? 0)) }],
    ...id === 'pay_unknownstep' ? [{ step: 'mystery_step', at: at(900) }] : [],
    ...settling ? [] : [{ step: paid ? 'settled' : 'released', at: at(900) }],
  ];

  return {
    id: call.id,
    at: call.at,
    status: call.status,
    apiStatus: call.apiStatus,
    service: call.service,
    method: call.method,
    path: call.path,
    buyer: {
      paidWith: call.paidWith,
      network: networkOf(call.paidWith),
      asset: assetOf(call.paidWith),
      amount: call.amount,
      payer: call.payer,
      transaction: buyerHash,
      explorerUrl: buyerHash === null ? null : explorerOf(call.paidWith, buyerHash),
      settledAt: paid && !settling ? at(900) : null,
    },
    api: hasApi && call.apiPaidWith !== null
      ? { paidWith: call.apiPaidWith, network: networkOf(call.apiPaidWith) ?? call.apiPaidWith, asset: apiAsset, amount: call.amount, payTo: 'sample-pay-to', transaction: apiHash, explorerUrl: apiHash === null ? null : explorerOf(call.apiPaidWith, apiHash), status: settling ? 'signed' : 'settled' }
      : null,
    apiPrice: hasApi ? call.amount : null,
    fee: settling ? null : '0',
    ms: { api: call.ms, total: call.ms === null ? null : call.ms + 576 },
    steps,
  };
};

const topScale: Readonly<Record<Period, number>> = { today: 0.11, '7d': 0.72, '30d': 1, all: 1.1 };

const sampleTop = (period: Period, now: number, empty: boolean): TopStats => {
  const scale = topScale[period];

  return {
    period,
    updatedAt: empty ? null : new Date(now - 60_000).toISOString(),
    services: empty ? [] : hosts.map((host, index) => ({ host, calls: Math.round((612 - index * 97) * scale) })),
    endpoints: empty ? [] : hosts.map((host, index) => ({ host, path: `/v1/sample/${index % 2 === 0 ? 'quotes/latest' : 'lookup'}`, calls: Math.round((402 - index * 61) * scale) })),
    paidWith: empty ? [] : rails.map((paidWith, index) => ({ paidWith, calls: Math.round((662 - index * 120) * scale) })),
    topupTokens: empty ? [] : [
      { network: 'base', token: 'USDC', count: Math.max(1, Math.round(7 * scale)) },
      { network: 'solana', token: 'SOL', count: Math.max(1, Math.round(3 * scale)) },
      { network: 'near', token: 'USDC', count: 1 },
    ],
  };
};

const servicePaths = ['/v1/sample/quotes/latest', '/v1/sample/lookup', '/v1/sample/history', '/v1/sample/search'] as const;
const pathShares = [0.65, 0.2, 0.1, 0.05] as const;
const waysShare: Readonly<Record<string, number>> = { near: 0.36, base: 0.22, solana: 0.1, tempo: 0.05, credits: 0.27 };

/**
 * One service for a period, or undefined for a host the fake doesn't know (the hosts of `serviceHosts`).
 * `maps.example.com` has no call in the period before, so it has no change to show. The top buyers hold
 * a Credits buyer with no payer.
 */
export const sampleService = (host: string, period: Period, now: number, payUrl = 'https://pay.example.com'): ServiceDetail | undefined => {
  const index = serviceHosts.indexOf(host);
  if (index < 0)
    return undefined;
  const row = rowOf(host, index);
  const scale = topScale[period];
  const calls = Math.round(row.calls * scale);
  const buyers = Math.max(1, Math.round(row.buyers * Math.min(1, scale)));
  const volume = (value: number): string => money(value * 0.0099);

  return {
    host,
    period,
    updatedAt: new Date(now - 60_000).toISOString(),
    paidEndpoints: row.paidEndpoints,
    stats: {
      calls,
      callsBefore: period === 'all' ? null : host === 'maps.example.com' ? 0 : Math.round(calls * 0.85),
      volume: volume(calls),
      buyers,
      returningShare: 0.63,
      successRate: row.successRate,
      failedCalls: row.successRate === null ? 0 : Math.round(calls * (1 - row.successRate)),
      p50Ms: row.p50Ms,
      p95Ms: row.p50Ms === null ? null : Math.round(row.p50Ms * 2.4),
    },
    endpoints: servicePaths.slice(0, row.paidEndpoints).map((path, step) => ({
      path,
      method: step === row.paidEndpoints - 1 && row.paidEndpoints > 2 ? null : step === 1 ? 'POST' : 'GET',
      priceNow: row.priceFrom === null ? null : money(Number(row.priceFrom) * (1 + step)),
      calls: Math.round(calls * pathShares[step]!),
      buyers: Math.max(1, Math.round(buyers * pathShares[step]!)),
      volume: volume(Math.round(calls * pathShares[step]!)),
      successRate: row.successRate,
      p50Ms: row.p50Ms,
      link: `${payUrl}/${host}${path}`,
    })),
    daily: dailySeries(now, false).map(point => ({ day: point.day, calls: Math.round(point.calls * row.calls / 600), volume: volume(Math.round(point.calls * row.calls / 600)), buyers: Math.round(point.calls * row.calls / 6000) })),
    byPaidWith: rails.map(paidWith => ({
      paidWith,
      calls: Math.round(calls * waysShare[paidWith]!),
      share: waysShare[paidWith]!,
      buyers: Math.max(1, Math.round(buyers * waysShare[paidWith]!)),
      volume: volume(Math.round(calls * waysShare[paidWith]!)),
    })),
    topBuyers: {
      share: 0.48,
      buyers: [
        { payer: 'sample.near', paidWith: 'near', calls: Math.round(calls * 0.2), spent: volume(Math.round(calls * 0.2)), lastCallAt: new Date(now - 120_000).toISOString() },
        { payer: `0x${'ab12'.repeat(10)}`, paidWith: 'base', calls: Math.round(calls * 0.12), spent: volume(Math.round(calls * 0.12)), lastCallAt: new Date(now - 540_000).toISOString() },
        { payer: null, paidWith: 'credits', calls: Math.round(calls * 0.08), spent: volume(Math.round(calls * 0.08)), lastCallAt: new Date(now - 3_600_000).toISOString() },
        { payer: 'SampleSolanaAddress1111111111111111111111111', paidWith: 'solana', calls: Math.round(calls * 0.05), spent: volume(Math.round(calls * 0.05)), lastCallAt: new Date(now - 10_800_000).toISOString() },
        { payer: `0x${'cd34'.repeat(10)}`, paidWith: 'tempo', calls: Math.round(calls * 0.03), spent: volume(Math.round(calls * 0.03)), lastCallAt: new Date(now - 129_600_000).toISOString() },
      ],
    },
    exact: host !== inexactHost,
  };
};

const checkHosts = {
  // Payable
  base: 'api.example.com',
  near: 'data.example.com',
  mpp: 'search.example.com',
  hostile: 'hostile.example.com',
  slow: 'slow.example.com',
  // Refused, each reason; a path with `/detail` adds a detail
  notPayable: 'free.example.com',
  unsupported: 'unsupported.example.com',
  blocked: 'blocked.example.com',
  private: 'private.example.com',
  own: 'own.example.com',
  dead: 'dead.example.com',
  other: 'surprise.example.com',
  // A 429 from the pay host
  limited: 'limited.example.com',
  // A link with more than one page of calls
  busy: 'busy.example.com',
} as const;

/** The hosts of the sample links for each case of the check. */
export const sampleCheckHosts = checkHosts;

const hostileDescription = '<script>alert(1)</script>';
const hostileValue = '"><img src=x onerror=alert(1)>';

const base64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64');

/**
 * The answer of the pay host's check for a typed link. The host picks the case: `api.example.com` is x402 on
 * Base, `data.example.com` x402 on NEAR, `search.example.com` MPP on Tempo, `hostile.example.com` an answer
 * whose description and header values hold HTML, `slow.example.com` a slow one (see `checkDelayMs`), and the
 * hosts of `sampleCheckHosts` the refusals. Any other host is "not a paid link". A typed link that isn't one
 * is `invalid_target`.
 */
export const sampleCheck = (typed: string, now: number, payUrl = 'https://pay.example.com'): { readonly status: number; readonly body: unknown } => {
  let target: URL;
  try {
    target = new URL(typed.includes('://') ? typed : `https://${typed}`);
    if (target.host === '' || !target.host.includes('.'))
      throw new Error('not a link');
  }
  catch {
    return { status: 200, body: { payable: false, reason: 'invalid_target', message: 'The link isn\'t a URL' } };
  }
  const { host } = target;
  const detail = target.pathname.includes('/detail');
  const refuse = (reason: string, message: string, text?: string): { readonly status: number; readonly body: unknown } => ({ status: 200, body: { payable: false, reason, message, ...detail || text !== undefined ? { detail: text ?? 'sample detail' } : {} } });
  const refusals: Readonly<Record<string, { readonly status: number; readonly body: unknown }>> = {
    [checkHosts.notPayable]: refuse('not_payable', 'The link didn\'t ask for a payment'),
    [checkHosts.unsupported]: refuse('unsupported_payment', 'The link asks for a payment Anyfare doesn\'t make'),
    [checkHosts.blocked]: refuse('host_not_allowed', 'This host is not allowed'),
    [checkHosts.private]: refuse('host_not_allowed', 'This host is not allowed', 'private or reserved address'),
    [checkHosts.own]: refuse('host_not_allowed', 'This host is not allowed', 'our own host'),
    [checkHosts.dead]: refuse('upstream_unavailable', 'The host did not answer'),
    [checkHosts.other]: refuse('surprise', 'Something we did not expect <b>happened</b>'),
    [checkHosts.limited]: { status: 429, body: { error: { code: 'rate_limited', message: 'Too many requests' } } },
  };
  const refused = refusals[host];
  if (refused !== undefined)
    return refused;
  const known: readonly string[] = [checkHosts.base, checkHosts.near, checkHosts.mpp, checkHosts.hostile, checkHosts.slow, checkHosts.busy, unavailableHost];
  if (!known.includes(host))
    return refuse('not_payable', 'The link didn\'t ask for a payment');

  const mpp = host === checkHosts.mpp;
  const onNear = host === checkHosts.near;
  const hostile = host === checkHosts.hostile;
  const asset = mpp ? 'USDC.e' : 'USDC';
  const paidWith = mpp ? 'tempo' : onNear ? 'near' : 'base';
  const network = mpp ? 'tempo:mainnet' : onNear ? 'near:mainnet' : 'eip155:8453';
  const payTo = onNear ? 'merchant.sample.near' : `0x${'9a1f'.repeat(10)}`;
  const description = hostile ? hostileDescription : mpp ? 'One web search' : 'Latest quotes for sample assets';
  const resource = { url: `https://${host}${target.pathname}`, description, mimeType: 'application/json' };
  const accept = {
    scheme: 'exact',
    network,
    amount: mpp ? '5000' : '10000',
    asset: onNear ? '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1' : '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    payTo,
    maxTimeoutSeconds: 60,
    extra: { name: hostile ? hostileValue : asset },
  };
  const x402 = { x402Version: 2, error: 'Payment required', resource, accepts: [accept] };
  const mppRequest = { method: 'tempo', intent: 'charge', realm: host, amount: '0.005', currency: asset, recipient: `0x${'5d2e'.repeat(10)}`, expires: new Date(now + 25_000).toISOString(), description };
  const price = mpp ? '0.005' : '0.01';
  const ways: readonly { paidWith: string; protocol: string; asset: string }[] = [
    { paidWith: 'near', protocol: 'x402', asset: 'USDC' },
    { paidWith: 'base', protocol: 'x402', asset: 'USDC' },
    { paidWith: 'solana', protocol: 'x402', asset: 'USDC' },
    { paidWith: 'tempo', protocol: 'mpp', asset: 'USDC.e' },
    { paidWith: 'credits', protocol: 'key', asset: 'Credits' },
  ];
  const headers: Record<string, string> = mpp
    ? { 'www-authenticate': `Payment id="ch_sample", realm="${host}", method="tempo", intent="charge", request="${base64(mppRequest)}"`, 'cache-control': 'no-store', 'content-type': 'application/problem+json' }
    : { 'payment-required': base64(x402), 'content-type': hostile ? hostileValue : 'application/json', date: new Date(now).toUTCString() };
  const sampleStats = sampleEndpointStats(host, target.pathname, '30d', now);

  return {
    status: 200,
    body: {
      payable: true,
      target: `https://${host}${target.pathname}${target.search}`,
      price: { amount: price, currency: 'USD', asset: mpp ? 'usdce-tempo' : onNear ? 'usdc-near' : 'usdc-base', network },
      quote: { amount: price, fee: '0', currency: 'USD' },
      link: `${payUrl}/${host}${target.pathname}${target.search}`,
      protocol: mpp ? 'mpp' : 'x402',
      asks: mpp
        ? { amount: price, asset, network, paidWith, method: 'tempo', intent: 'charge', realm: host, recipient: mppRequest.recipient, expires: mppRequest.expires, description }
        : { amount: price, asset, network, paidWith, payTo, scheme: 'exact', x402Version: 2, maxTimeoutSeconds: 60, description, mimeType: 'application/json' },
      upstream: { status: 402, headers, ...mpp ? { mpp: mppRequest } : { x402 } },
      payWith: ways.map(way => ({ ...way, amount: price, currency: 'USD' })),
      stats: sampleStats.stats,
      checkedAt: new Date(now - 4_000).toISOString(),
      ms: 340,
    },
  };
};

/** How long the fake waits before it answers the check of a link: `slow.example.com` takes a moment. */
export const checkDelayMs = (typed: string): number => /(^|\/\/)slow\.example\.com/.test(typed) ? 1_500 : 0;

/** The endpoint's numbers for a period: the sample hosts' calls scaled, and zeros for any other endpoint. */
export const sampleEndpointStats = (host: string, path: string, period: Period, now: number, empty = false): EndpointStats => {
  const known = !empty && (serviceHosts.includes(host) && servicePaths.includes(path as never) || host === checkHosts.busy || host === checkHosts.hostile);
  const scale = known ? topScale[period] : 0;
  const calls = Math.round(402 * scale);

  return {
    host,
    path,
    period,
    updatedAt: new Date(now - 60_000).toISOString(),
    // The busy link's numbers are read when asked for, and stopped at their cap
    exact: host !== inexactHost && host !== checkHosts.busy,
    stats: known
      ? { calls, buyers: Math.max(1, Math.round(33 * Math.min(1, scale))), volume: money(calls * 0.01), successRate: 0.99, p50Ms: 340 }
      : { calls: 0, buyers: 0, volume: '0', successRate: null, p50Ms: null },
    daily: Array.from({ length: 14 }, (_, index) => ({ day: utcDay(now - (13 - index) * day), calls: known ? Math.round((3 + index * 2) * Math.max(scale, 0.05)) : 0 })),
    byPaidWith: known ? rails.map((paidWith, index) => ({ paidWith, calls: Math.round((145 - index * 25) * scale) })) : [],
  };
};

const unavailable = { status: 503, body: { error: { code: 'stats_unavailable', message: 'These numbers can\'t be read right now: try again shortly' } } } as const;

/** The answer to a read: its status and body. Undefined for a path the fake doesn't know. */
export const answer = (url: URL, mode: Exclude<FakeApiMode, 'down'>, now: number): { readonly status: number; readonly body: unknown } | undefined => {
  const empty = mode === 'empty';
  const { pathname, searchParams } = url;
  if (pathname === '/v1/stats')
    return { status: 200, body: sampleStats(now, empty) };
  if (pathname === '/v1/stats/live')
    return { status: 200, body: sampleLive(now, empty) };
  if (pathname === '/v1/stats/top') {
    const period = searchParams.get('period') ?? '30d';
    if (!periods.includes(period as Period))
      return { status: 400, body: { error: { code: 'invalid_request', message: 'Unknown period' } } };

    return { status: 200, body: sampleTop(period as Period, now, empty) };
  }
  if (pathname === '/_/check')
    return sampleCheck(searchParams.get('url') ?? '', now);
  if (pathname === '/v1/endpoints/stats') {
    const period = searchParams.get('period') ?? '30d';
    if (!periods.includes(period as Period))
      return { status: 400, body: { error: { code: 'invalid_request', message: 'Unknown period' } } };
    if (searchParams.get('host')?.toLowerCase() === unavailableHost)
      return unavailable;

    return { status: 200, body: sampleEndpointStats(searchParams.get('host') ?? '', searchParams.get('path') ?? '', period as Period, now, empty) };
  }
  if (pathname === '/v1/calls') {
    // A NUL in a filter is refused, as the API does
    if ([...searchParams.values()].some(value => value.includes('\u0000')))
      return { status: 400, body: { error: { code: 'invalid_request', message: 'The request is not valid' } } };
    const size = intParam(searchParams.get('size'), 20, 100);
    const page = intParam(searchParams.get('page'), 1, 1000);
    // One endpoint has 25 calls, for a grid with pages
    const busy = searchParams.get('host') === checkHosts.busy && !empty
      ? Array.from({ length: 25 }, (_, index) => ({ ...sampleCall(index, now), service: checkHosts.busy, path: '/v1/busy' }))
      : undefined;
    const all = (busy ?? callsOf(now, empty)).filter(call => matchesCall(call, searchParams));
    const body: CallsPage = { calls: all.slice((page - 1) * size, page * size), page, size, total: all.length, totalCapped: false };

    return { status: 200, body };
  }
  if (pathname.startsWith('/v1/calls/') && pathname !== '/v1/calls/stream') {
    const receipt = empty ? undefined : sampleReceipt(decodeURIComponent(pathname.slice('/v1/calls/'.length)), now);

    return receipt === undefined
      ? { status: 404, body: { error: { code: 'not_found', message: 'No such call' } } }
      : { status: 200, body: receipt };
  }
  if (pathname === '/v1/services') {
    if ([...searchParams.values()].some(value => value.includes('\u0000')))
      return { status: 400, body: { error: { code: 'invalid_request', message: 'The request is not valid' } } };
    const size = intParam(searchParams.get('size'), 20, 100);
    const page = intParam(searchParams.get('page'), 1, 1000);
    const all = [...serviceRows(empty)];
    const q = searchParams.get('q')?.toLowerCase();
    const rows = all.filter(row => q === undefined || row.host.toLowerCase().includes(q));
    const sort = searchParams.get('sort') ?? 'calls';
    if (!['calls', 'buyers', 'volume', 'endpoints', 'price'].includes(sort))
      return { status: 400, body: { error: { code: 'invalid_request', message: 'Unknown sort' } } };
    rows.sort((a, b) => (
      sort === 'buyers' ? b.buyers - a.buyers
        : sort === 'volume' ? Number(b.volume) - Number(a.volume)
          : sort === 'endpoints' ? b.paidEndpoints - a.paidEndpoints
            // A service with no price comes last
            : sort === 'price' ? (a.priceFrom === null ? 1 : 0) - (b.priceFrom === null ? 1 : 0) || Number(a.priceFrom) - Number(b.priceFrom)
              : 0
    ) || b.calls - a.calls);
    const body: ServicesPage = {
      services: rows.slice((page - 1) * size, page * size),
      page,
      size,
      total: rows.length,
      totalCapped: mode === 'capped',
      totals: { services: all.length, paidEndpoints: all.reduce((sum, row) => sum + row.paidEndpoints, 0), calls30d: all.reduce((sum, row) => sum + row.calls, 0) },
      updatedAt: empty ? null : new Date(now - 60_000).toISOString(),
    };

    return { status: 200, body };
  }
  if (pathname.startsWith('/v1/services/')) {
    const period = searchParams.get('period') ?? '30d';
    if (!periods.includes(period as Period))
      return { status: 400, body: { error: { code: 'invalid_request', message: 'Unknown period' } } };
    if (decodeURIComponent(pathname.slice('/v1/services/'.length)).toLowerCase() === unavailableHost && !empty)
      return unavailable;
    const service = empty ? undefined : sampleService(decodeURIComponent(pathname.slice('/v1/services/'.length)), period as Period, now);

    return service === undefined
      ? { status: 404, body: { error: { code: 'not_found', message: 'No paid call went to this service' } } }
      : { status: 200, body: service };
  }

  return undefined;
};

export interface FakeApi {
  // The origin the fake listens on, such as http://127.0.0.1:41234
  readonly url: string;
  // Every request it got, in order: the path with its query, and the headers
  readonly requests: { readonly path: string; readonly headers: IncomingMessage['headers'] }[];
  // Pushes a call to every open stream whose filters it passes
  readonly emitCall: (call: Call) => void;
  readonly openStreams: () => number;
  readonly close: () => Promise<void>;
}

const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, OPTIONS', 'access-control-allow-headers': '*' };

const json = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify(body));
};

/** Starts a fake API. `port` 0 picks a free one. */
export const startFakeApi = async (mode: FakeApiMode, port = 0): Promise<FakeApi> => {
  const requests: FakeApi['requests'][number][] = [];
  // Each open stream with the filters it was opened with
  const streams = new Map<ServerResponse, URLSearchParams>();
  let counter = 1000;
  // Writes a call to every stream whose filters it passes
  const push = (call: Call): void => {
    for (const [stream, filters] of streams) {
      if (matchesCall(call, filters))
        stream.write(`event: call\ndata: ${JSON.stringify(call)}\n\n`);
    }
  };
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://fake.example.com');
    requests.push({ path: `${url.pathname}${url.search}`, headers: request.headers });
    if (request.method === 'OPTIONS') {
      response.writeHead(204, cors).end();

      return;
    }
    if (mode === 'down') {
      json(response, 500, { error: { code: 'internal_error', message: 'Internal server error' } });

      return;
    }
    if (url.pathname === '/v1/calls/stream') {
      response.writeHead(200, { ...cors, 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' });
      response.write('retry: 3000\n\n: ping\n\n');
      streams.set(response, url.searchParams);
      request.on('close', () => streams.delete(response));

      return;
    }
    if (url.pathname === '/_test/call' && request.method === 'POST') {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        counter += 1;
        const call = text === '' ? sampleCall(counter, Date.now(), 0) : JSON.parse(text) as Call;
        push(call);
        json(response, 200, call);
      });

      return;
    }
    const found = answer(url, mode, Date.now());
    const delay = url.pathname === '/_/check' ? checkDelayMs(url.searchParams.get('url') ?? '') : 0;
    const send = (): void => {
      if (found === undefined)
        json(response, 404, { error: { code: 'not_found', message: 'Not found' } });
      else
        json(response, found.status, found.body);
    };
    if (delay > 0)
      setTimeout(send, delay);
    else
      send();
  });
  await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve));

  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    emitCall: push,
    openStreams: () => streams.size,
    close: async () => {
      for (const stream of streams.keys())
        stream.end();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
};

/** An address nothing listens on, for a connection that is refused. */
export const refusedUrl = async (): Promise<string> => {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>(resolve => server.close(() => resolve()));

  return `http://127.0.0.1:${port}`;
};

// Run by hand: node tests/support/fakeApi.ts [full|empty|down|capped] [port]
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [mode = 'full', port = '4010'] = process.argv.slice(2);
  if (mode !== 'full' && mode !== 'empty' && mode !== 'down' && mode !== 'capped')
    throw new Error('The mode is full, empty, down or capped');
  const api = await startFakeApi(mode, Number(port));
  process.stdout.write(`The fake API answers in ${mode} mode at ${api.url}\n`);
  process.on('SIGTERM', () => void api.close().then(() => process.exit(0)));
  process.on('SIGINT', () => void api.close().then(() => process.exit(0)));
}
