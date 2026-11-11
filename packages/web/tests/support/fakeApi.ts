import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

import type { Payment, PaymentKey, PaymentState, Topup } from '../../src/console/api';
import type { Call, CallsPage, DailyPoint, EndpointStats, LiveStats, PaidWith, Period, Receipt, ServiceDetail, ServiceRow, ServicesPage, Stats, TopStats } from '../../src/api/types';

// A small HTTP server that answers the public read API's endpoints with sample data, for the website's
// tests and for looking at the site by hand. The data is sample data: hosts are example.com, the payer
// is sample.near, and every time is today or counted back from it.
//
// Modes:
// - full: a database with calls, services and stats; the services are paid ones and a few that were only checked
// - empty: an empty database: zeros, empty lists, status 200
// - down: every request answers 500
// - capped: as full, with `totalCapped: true` on the services list
// - checked: a database where no call was paid, and links were only checked: every service is a checked one, and calls and stats are empty
// - edge: as full, with the odd shapes a page must hold: a service whose host has a port (`fake-api.test:8186`), one whose
//   host is 200 characters, a call to it with a 512-character path, a free Credits call, and calls from days and weeks ago
//
// In full mode some hosts show the API's less usual answers: `ocr04.example.org` has numbers that stopped at
// their cap (`exact: false`), `tts03.example.org` has no price (`priceFrom` and `priceNow` are `null`), and
// `rpc05.example.org` answers `503 stats_unavailable` for its service page and its endpoint numbers (a check of a
// link to it is payable). The link `busy.example.com` has endpoint numbers that stopped at their cap.
// `pay_settling` is a receipt whose fee is not booked yet.
//
// The same server also answers the pay host's `GET /_/check?url=&method=`: the host of the link picks the case (see
// `sampleCheck`). The method is GET, POST, PUT, PATCH or DELETE, or left out (GET, then POST), and any other value is a 400
// `invalid_request`. Every method but GET is honoured only with the header `X-Anyfare-Check: 1`, and is that 400 without it; with
// no method and no header the POST try is skipped. `post.example.com` is payable only with POST: a GET check of it is `not_payable`.
// `body.example.com` asks 0 for a POST with no body, and $0.001 for the example body its check sends. `gone.example.com` is a 404 to every method.
// The answer holds `exampleBody` and `tried`, as the pay host's does. Every case answers 200 with `payable`, except `limited.example.com`, which is a 429.
//
// A page that reads a new endpoint adds its answer to `answer` below, built from `sample`.
//
// The console's keyed routes (see `keyedAnswer`): `POST /v1/accounts`, `GET /v1/account`, `POST /v1/account/master-key/rotate`
// and `GET /v1/balance`. Accounts live in memory, and the keys are sample keys the fake makes: `afm_test_` and 32 hex
// digits. A key that was rotated away answers `401 invalid_key`, a payment key (`af_test_…`, `af_live_…`) `401 wrong_key_type`,
// and no key `401 unauthorized`. Their answers carry the console's CORS headers for a request from a console origin the
// fake was given, errors too, and nothing for any other origin. In down mode they answer 500, with the same headers.
// `GET /_test/requests` lists every request the fake got (method, path, query and headers), so a check in a browser can
// see where a key went; `POST /_test/limited?on=1` makes the keyed routes answer `429 rate_limited` until `on=0`;
// `POST /_test/held?amount=0.02` sets what every account holds for calls in flight; and `POST /_test/rotate?answer=<how>`
// changes only the rotation's answer, while the rotation itself still happens: `garble` answers a 200 no one can read,
// `drop` closes the connection with no answer, `late&ms=<n>` answers after n milliseconds, and `normal` puts it back.
//
// The keyed routes also hold payment keys, payments and top-ups for each account: `GET`, `POST`, `PATCH` and `DELETE /v1/keys`,
// `GET /v1/payments?limit=&after=&state=&keyId=&service=` and `GET /v1/topups?limit=&after=`. A query parameter they don't know
// is a 400, as the API's is. A new account of `full` mode starts with four keys (one near its day's budget, one with no name, an
// expired one and a revoked one), 45 calls in the payments (one in flight, some free) and eight top-ups in several statuses;
// `edge` adds a key with a 60-character label and calls to the long host with the long path; `empty` has none of them. The payment
// keys the fake issues are `af_test_` and 32 hex digits, and are kept in `FakeAccount.paymentKeys`.
//
// Top-ups: `GET /v1/topups/options` (no key, any origin) lists six networks with sample tokens (`edge` adds a second USDC on
// Arbitrum, so a request must name it by its address); `POST /v1/topups` checks the request as the API does (the network,
// the token, the amount and its decimals, and the least a top-up on the network is worth) and makes a top-up, `waiting`,
// with the network's sample deposit address and an hour to pay; `GET /v1/topups/:id` reads one. Every address is a plain
// sample. The switches: `POST /_test/topup?id=&status=[&memo=1][&seconds=<n>]` moves a top-up (in every account that has
// it, or adds it) to any status with the fields that status carries; `POST /_test/topups?off=1` makes every top-up route
// answer `503 topups_unavailable` until `off=0`; `POST /_test/options?tokens=0` gives the options without their tokens
// until `tokens=1`; `POST /_test/create?answer=<how>` changes how `POST /v1/topups` answers: `hang` (made, no answer),
// `drop` (made, the connection closes), `lost` (closes before anything is made), `late&ms=<n>` (made, answered after n ms),
// and `normal`; and `POST /_test/slow?id=&ms=` makes `GET /v1/topups/:id` of one top-up answer after ms milliseconds.
// Each top-up gets its own sample address, numbered in its last 8 characters, and keeps it when it moves.
//
// By hand: `node tests/support/fakeApi.ts full 4010 0 http://127.0.0.1:3000` (the last is the console's origin). Calls
// made while it runs are pushed to the streams: `POST /_test/call` with a call as JSON, or with no body for a sample call.

export type FakeApiMode = 'full' | 'empty' | 'down' | 'capped' | 'edge' | 'checked';

const day = 86_400_000;
const checkMethods: readonly string[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const periods: readonly Period[] = ['today', '7d', '30d', 'all'];

/** In edge mode: a host with a port, and one of 200 characters. */
export const portHost = 'fake-api.test:8186';
export const longHost = `${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(60)}.long-host.test`;
/** In edge mode: a path of 512 characters. */
export const longPath = `/v1/${'p'.repeat(507)}`;
const edgeHosts: readonly string[] = [portHost, longHost];

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

/** The paid service with no paid call in the last 30 days: its row and page have zero numbers, and it stays in the list. */
export const zeroPaidHost = 'ocr22.example.org';
/** The busy paid service with one paid endpoint that has no call in the period: zero numbers, and its pay link. */
export const quietEndpointHost = 'geo02.example.org';

/** The services only a check listed, newest first: `fresh01` is the newest. */
export const checkedHosts: readonly string[] = ['fresh01.example.net', 'fresh02.example.net', 'fresh03.example.net', 'fresh04.example.net'];
/** The paid service that also has an endpoint only a check listed. */
export const mixedHost = 'pdf06.example.org';
/** The checked service with no price known. */
export const unpricedCheckedHost = 'fresh03.example.net';

const hour = 3_600_000;
// How long before now each checked service was checked: an hour, two hours, three days and twelve days
const checkedAgo: readonly number[] = [hour, 2 * hour, 72 * hour, 288 * hour];
const noTrend: readonly number[] = Array.from({ length: 30 }, () => 0);

/** A service a check listed: no calls, buyers or volume, no rates, a trend of zeros. `index` 0 is the newest. */
const checkedRow = (host: string, index: number, now: number): ServiceRow => {
  const at = new Date(now - (checkedAgo[index] ?? 5 * hour)).toISOString();

  return {
    host,
    status: 'checked',
    paidEndpoints: 1 + index % 3,
    priceFrom: host === unpricedCheckedHost ? null : money(0.002 * (1 + index)),
    currency: 'USD',
    calls: 0,
    buyers: 0,
    volume: '0',
    successRate: null,
    p50Ms: null,
    trend: noTrend,
    listedAt: at,
    checkedAt: at,
  };
};

const paidRow = (host: string, index: number, now: number): ServiceRow => ({
  ...index < hosts.length ? {
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
  },
  status: 'paid',
  listedAt: new Date(now - (20 + index) * day).toISOString(),
  checkedAt: null,
});

const rowOf = (host: string, index: number, now: number): ServiceRow => {
  const row = paidRow(host, index, now);
  if (host === mixedHost) {
    // A check also listed one more endpoint of it: it counts, and it says when it was checked
    return { ...row, paidEndpoints: row.paidEndpoints + 1, checkedAt: new Date(now - 5 * hour).toISOString() };
  }

  if (host === zeroPaidHost)
    return { ...row, calls: 0, buyers: 0, volume: '0', successRate: null, p50Ms: null, trend: noTrend };

  return host === unpricedHost ? { ...row, priceFrom: null } : row;
};

const edgeRow = (host: string, index: number, now: number): ServiceRow => ({
  ...paidRow(host, 0, now), host, paidEndpoints: 3 + index, calls: 700 - index * 20, priceFrom: '0.0044',
});

/** What a service is listed with, newest first: the ones checked while the fake ran, then `checkedHosts`. */
const checkedList = (extra: ReadonlySet<string>): readonly string[] => [...[...extra].reverse(), ...checkedHosts];

const checkedRows = (now: number, extra: ReadonlySet<string>): readonly ServiceRow[] => checkedList(extra).map((host, index) => (
  extra.has(host) ? { ...checkedRow(host, 0, now), host, paidEndpoints: 1, priceFrom: '0.003', listedAt: new Date(now - 1_000 - index).toISOString(), checkedAt: new Date(now - 1_000 - index).toISOString() } : checkedRow(host, checkedHosts.indexOf(host), now)
));

const serviceRows = (now: number, mode: FakeApiMode, extra: ReadonlySet<string> = new Set()): readonly ServiceRow[] =>
  mode === 'empty' ? [] : mode === 'checked' ? checkedRows(now, extra) : [...mode === 'edge' ? edgeHosts.map((host, index) => edgeRow(host, index, now)) : [], ...serviceHosts.map((host, index) => rowOf(host, index, now)), ...checkedRows(now, extra)];

/** The calls of edge mode, newest first: a long host with a long path, a host with a port, and a free Credits call. */
const edgeHead = (now: number): readonly Call[] => [
  { ...sampleCall(1, now, 2), id: 'pay_longpath', service: longHost, path: longPath, paidWith: 'base', payer: `0x${'ab12'.repeat(10)}` },
  { ...sampleCall(2, now, 5), id: 'pay_porthost', service: portHost, path: '/v1/sample/lookup', paidWith: 'near', payer: 'sample.near' },
  { ...sampleCall(3, now, 9), id: 'pay_freecredits', paidWith: 'credits', payer: null, status: 'free', apiStatus: 502, apiPaidWith: 'base', amount: '0.0044' },
];

/** The oldest calls of edge mode, after the sample calls: 165 hours, 337 hours and 90 days ago. */
const edgeOld = (now: number): readonly Call[] => [
  { ...sampleCall(6, now, 165 * 3600), id: 'pay_old165h' },
  { ...sampleCall(7, now, 337 * 3600), id: 'pay_old337h' },
  { ...sampleCall(8, now, 90 * 86_400), id: 'pay_old90d' },
];

const callsOf = (now: number, empty: boolean, edge = false): readonly Call[] =>
  empty ? [] : [...edge ? edgeHead(now) : [], ...Array.from({ length: 60 }, (_, index) => sampleCall(index, now)), ...edge ? edgeOld(now) : []];

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
 * call's own id (`pay_sample0000`), and the named cases: `pay_creditspaid`, `pay_freecredits` (a free Credits call), `pay_longpath` (a 512-character path on a 200-character host), `pay_porthost`, `pay_pathusd` (the buyer pays in USDC on Base, the API in pathUSD on Tempo), `pay_6d2f1c3a-7b84-4e0d-9a51-c3e8f2b4a7d1` (the same, with an id as long as a real one), `pay_freenoapi`,
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
    pay_freecredits: { ...sampleCall(3, now, 9), id: 'pay_freecredits', paidWith: 'credits', payer: null, status: 'free', apiStatus: 502, apiPaidWith: 'base', amount: '0.0044' },
    pay_longpath: { ...sampleCall(1, now, 2), id: 'pay_longpath', service: longHost, path: longPath, paidWith: 'base', payer: `0x${'ab12'.repeat(10)}` },
    pay_pathusd: { ...sampleCall(1, now, 4), id: 'pay_pathusd', paidWith: 'base', apiPaidWith: 'tempo', payer: `0x${'cd34'.repeat(10)}`, status: 'paid', apiStatus: 200 },
    'pay_6d2f1c3a-7b84-4e0d-9a51-c3e8f2b4a7d1': { ...sampleCall(1, now, 6), id: 'pay_6d2f1c3a-7b84-4e0d-9a51-c3e8f2b4a7d1', paidWith: 'base', apiPaidWith: 'tempo', payer: `0x${'cd34'.repeat(10)}`, status: 'paid', apiStatus: 200 },
    pay_porthost: { ...sampleCall(2, now, 5), id: 'pay_porthost', service: portHost, path: '/v1/sample/lookup', paidWith: 'near', payer: 'sample.near' },
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
  const apiAsset = id === 'pay_pathusd' || id.startsWith('pay_6d2f') ? 'pathUSD' : call.apiPaidWith === null ? 'USDC' : assetOf(call.apiPaidWith);
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

const sampleTop = (period: Period, now: number, empty: boolean, edge = false): TopStats => {
  const scale = topScale[period];

  return {
    period,
    updatedAt: empty ? null : new Date(now - 60_000).toISOString(),
    services: empty ? [] : (edge ? [longHost, portHost, ...hosts] : hosts).slice(0, 5).map((host, index) => ({ host, calls: Math.round((612 - index * 97) * scale) })),
    endpoints: empty ? [] : (edge ? [{ host: longHost, path: longPath }, { host: portHost, path: '/v1/sample/lookup' }, ...hosts.map((host, index) => ({ host, path: `/v1/sample/${index % 2 === 0 ? 'quotes/latest' : 'lookup'}` }))] : hosts.map((host, index) => ({ host, path: `/v1/sample/${index % 2 === 0 ? 'quotes/latest' : 'lookup'}` }))).slice(0, 5).map((entry, index) => ({ ...entry, calls: Math.round((402 - index * 61) * scale) })),
    paidWith: empty ? [] : rails.map((paidWith, index) => ({ paidWith, calls: Math.round((662 - index * 120) * scale) })),
    topupTokens: empty ? [] : [
      { network: 'base', token: 'USDC', count: Math.max(1, Math.round(7 * scale)) },
      { network: 'solana', token: 'SOL', count: Math.max(1, Math.round(3 * scale)) },
      { network: 'near', token: 'USDC', count: 1 },
    ],
  };
};

const servicePaths = ['/v1/sample/quotes/latest', '/v1/sample/lookup', '/v1/sample/history', '/v1/sample/search', '/v1/sample/extra'] as const;
const pathShares = [0.65, 0.2, 0.1, 0.05] as const;
const waysShare: Readonly<Record<string, number>> = { near: 0.36, base: 0.22, solana: 0.1, tempo: 0.05, credits: 0.27 };

/** A service only a check listed, as the API answers it: `200` with zeros, its endpoints as checked, and empty lists. */
const checkedService = (row: ServiceRow, period: Period, now: number, payUrl: string): ServiceDetail => ({
  host: row.host,
  period,
  updatedAt: new Date(now).toISOString(),
  status: 'checked',
  listedAt: row.listedAt,
  checkedAt: row.checkedAt,
  paidEndpoints: row.paidEndpoints,
  stats: { calls: 0, callsBefore: period === 'all' ? null : 0, volume: '0', buyers: 0, returningShare: 0, successRate: null, failedCalls: 0, p50Ms: null, p95Ms: null },
  endpoints: servicePaths.slice(0, row.paidEndpoints).map((samplePath, step) => ({
    path: samplePath,
    method: step === 1 ? 'POST' : 'GET',
    priceNow: row.priceFrom === null ? null : money(Number(row.priceFrom) * (1 + step)),
    calls: 0,
    buyers: 0,
    volume: '0',
    successRate: null,
    p50Ms: null,
    link: `${payUrl}/${row.host}${samplePath}`,
    status: 'checked' as const,
    checkedAt: row.checkedAt,
  })),
  daily: [],
  byPaidWith: [],
  topBuyers: { share: 0, buyers: [] },
  exact: true,
});

/** A paid service with no paid call in the period, as the API answers it: zero numbers, every endpoint paid, with its pay link. */
const zeroPaidService = (row: ServiceRow, period: Period, now: number, payUrl: string): ServiceDetail => {
  const checked = checkedService(row, period, now, payUrl);

  return {
    ...checked,
    status: 'paid',
    checkedAt: null,
    endpoints: checked.endpoints.map(endpoint => ({ ...endpoint, status: 'paid' as const, checkedAt: null })),
  };
};

/**
 * One service for a period, or undefined for a host the fake doesn't know (the hosts of `serviceHosts`).
 * `maps.example.com` has no call in the period before, so it has no change to show. The top buyers hold
 * a Credits buyer with no payer.
 */
export const sampleService = (host: string, period: Period, now: number, payUrl = 'https://pay.example.com', edge = false, paid = true, extra: ReadonlySet<string> = new Set()): ServiceDetail | undefined => {
  const checkedRowOf = checkedRows(now, extra).find(row => row.host === host);
  if (checkedRowOf !== undefined)
    return checkedService(checkedRowOf, period, now, payUrl);
  const edgeIndex = edge ? edgeHosts.indexOf(host) : -1;
  const index = serviceHosts.indexOf(host);
  if (!paid || index < 0 && edgeIndex < 0)
    return undefined;
  const row = edgeIndex >= 0 ? edgeRow(host, edgeIndex, now) : rowOf(host, index, now);
  if (host === zeroPaidHost)
    return zeroPaidService(row, period, now, payUrl);
  const scale = topScale[period];
  const calls = Math.round(row.calls * scale);
  const buyers = Math.max(1, Math.round(row.buyers * Math.min(1, scale)));
  const volume = (value: number): string => money(value * 0.0099);

  return {
    host,
    period,
    updatedAt: new Date(now - 60_000).toISOString(),
    // An edge host has one paid endpoint more than the period has calls on
    status: 'paid',
    listedAt: row.listedAt,
    checkedAt: row.checkedAt,
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
    endpoints: [...servicePaths.slice(0, edgeIndex >= 0 ? row.paidEndpoints - 1 : host === mixedHost ? row.paidEndpoints - 1 : row.paidEndpoints).map((samplePath, step) => {
      // A paid endpoint with no call in the period comes after those with calls, with zero numbers
      const quiet = host === quietEndpointHost && step === row.paidEndpoints - 1;

      return {
        path: edgeIndex === 1 && step === 0 ? longPath : samplePath,
        method: step === row.paidEndpoints - 1 && row.paidEndpoints > 2 ? null : step === 1 ? 'POST' : 'GET',
        priceNow: row.priceFrom === null ? null : money(Number(row.priceFrom) * (1 + step)),
        calls: quiet ? 0 : Math.round(calls * pathShares[step]!),
        buyers: quiet ? 0 : Math.max(1, Math.round(buyers * pathShares[step]!)),
        volume: quiet ? '0' : volume(Math.round(calls * pathShares[step]!)),
        successRate: quiet ? null : row.successRate,
        p50Ms: quiet ? null : row.p50Ms,
        link: `${payUrl}/${host}${edgeIndex === 1 && step === 0 ? longPath : samplePath}`,
        status: 'paid' as const,
        checkedAt: null,
      };
    }), ...host === mixedHost ? [{
      // An endpoint only a check listed comes after the paid ones, with zero numbers
      path: '/v1/sample/preview',
      method: 'POST',
      priceNow: money(Number(row.priceFrom) * 2),
      calls: 0,
      buyers: 0,
      volume: '0',
      successRate: null,
      p50Ms: null,
      link: `${payUrl}/${host}/v1/sample/preview`,
      status: 'checked' as const,
      checkedAt: row.checkedAt,
    }] : []],
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
  // Payable, with its numbers in the check, while the API's read of them answers 503
  fallback: 'fallback.example.com',
  // Payable only when checked with POST
  postOnly: 'post.example.com',
  // Payable only with POST and the API's own example body: a POST with no body asks 0
  bodyPriced: 'body.example.com',
  // A 404 to every method: not payable, and no try answered a price
  gone: 'gone.example.com',
  // Refused: each host is one detail of the pay host's. A link with an IP address is `ip_address`, one with no
  // dot in its host `invalid_host`, and one that is no URL `not_a_url`.
  notPayable: 'free.example.com',
  unsupported: 'unsupported.example.com',
  noChallenge: 'nochallenge.example.com',
  blocked: 'blocked.example.com',
  // A name that resolves only to private addresses: `dns`, as a name that doesn't resolve. A private literal IP is `private_address`.
  private: 'private.example.com',
  own: 'own.example.com',
  optedOut: 'optout.example.com',
  dead: 'dead.example.com',
  refused: 'refused.example.com',
  timeout: 'timeout.example.com',
  unreachable: 'unreachable.example.com',
  headersTooLarge: 'bigheaders.example.com',
  // A reason the page doesn't know
  other: 'surprise.example.com',
  // A 429 from the pay host
  limited: 'limited.example.com',
  // A link with more than one page of calls
  busy: 'busy.example.com',
  // Payable, and the API doesn't show its numbers (`404` from the endpoint's stats, as for a blocked host)
  hidden: 'hidden.example.com',
  // Payable, but a limit kept it out of the list of services: `listed` is false, and its service page would be a 404
  unlisted: 'unlisted.example.com',
} as const;

/** The body `body.example.com` gives as its own example. */
export const exampleBody = { urls: ['https://example.com'], text: true };

interface Try {
  readonly method: string;
  readonly body: 'none' | 'example';
  readonly status: number | null;
  readonly skipped?: string;
}

// What a sample link answers to a method with or without the example body: its status, and whether the 402 has a price
const behaviour = (host: string, method: string, body: 'none' | 'example'): { readonly status: number; readonly priced: boolean } => {
  if (host === checkHosts.gone)
    return { status: 404, priced: false };
  // A link that answers 200 to everything, and one the fake doesn't know
  if (host === checkHosts.notPayable || !knownHosts.includes(host))
    return { status: 200, priced: false };
  if (host === checkHosts.postOnly)
    return method === 'POST' ? { status: 402, priced: true } : { status: 404, priced: false };
  if (host === checkHosts.bodyPriced)
    return method === 'POST' ? { status: 402, priced: body === 'example' } : { status: 404, priced: false };

  return { status: 402, priced: true };
};

/** The hosts of the sample links for each case of the check. */
export const sampleCheckHosts = checkHosts;

// The links that ask for a payment, for some method
const knownHosts: readonly string[] = [checkHosts.bodyPriced, checkHosts.postOnly, checkHosts.base, checkHosts.near, checkHosts.mpp, checkHosts.hostile, checkHosts.slow, checkHosts.busy, checkHosts.fallback, checkHosts.hidden, checkHosts.unlisted, unavailableHost, ...checkedHosts, ...edgeHosts];

const hostileDescription = '<script>alert(1)</script>';
const hostileValue = '"><img src=x onerror=alert(1)>';

const base64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64');

/**
 * The answer of the pay host's check for a typed link. The host picks the case: `api.example.com` is x402 on
 * Base, `data.example.com` x402 on NEAR, `search.example.com` MPP on Tempo, `hostile.example.com` an answer
 * whose description and header values hold HTML, `slow.example.com` a slow one (see `checkDelayMs`), and the
 * hosts of `sampleCheckHosts` the refusals, one for each detail the pay host gives. Any other host is "not a paid
 * link". A typed link that isn't one is `invalid_target`, `not_a_url`.
 */
export const sampleCheck = (typed: string, now: number, payUrl = 'https://pay.example.com', method = 'GET', header = true): { readonly status: number; readonly body: unknown } => {
  const answered = (body: unknown): { readonly status: number; readonly body: unknown } => ({ status: 200, body });
  // `ANY` is a check with no method: GET, then POST when the header is there
  const any = method === 'ANY';
  const first = any ? 'GET' : method;
  const tryOf = (host: string, sent: string, body: 'none' | 'example'): Try => ({ method: sent, body, status: behaviour(host, sent, body).status });
  // The tries a check of the host makes, in order, and the one that gave a price
  const plan = (host: string): { readonly tried: Try[]; readonly won: Try | undefined } => {
    const tried: Try[] = [];
    for (const sent of any ? ['GET', 'POST'] : [method]) {
      if (any && sent === 'POST' && !header) {
        tried.push({ method: 'POST', body: 'none', status: null, skipped: 'header' });
        break;
      }
      const plain = tryOf(host, sent, 'none');
      tried.push(plain);
      if (behaviour(host, sent, 'none').priced)
        return { tried, won: plain };
      // An API that asks 0 for a POST with no body: the check sends the API's own example once
      if (sent === 'POST' && host === checkHosts.bodyPriced && plain.status === 402) {
        const example = tryOf(host, sent, 'example');
        tried.push(example);
        if (behaviour(host, sent, 'example').priced)
          return { tried, won: example };
      }
    }

    return { tried, won: undefined };
  };
  const lastMethod = (tried: readonly Try[]): string => [...tried].reverse().find(entry => entry.skipped === undefined)?.method ?? first;
  // A refusal as the pay host answers it: `method`, the reason, the message of its detail, and the target's
  // status in `upstream` when the target answered. One try of the first method has the status, unless `tried` says more.
  const refuse = (reason: string, detail: string, message: string, status?: number, tried?: readonly Try[]): { readonly status: number; readonly body: unknown } => {
    const made = tried ?? (status === undefined ? [] : [{ method: first, body: 'none', status } as Try]);

    return answered({ payable: false, method: lastMethod(made), exampleBody: null, tried: made, reason, message, detail, ...status === undefined ? {} : { upstream: { status } } });
  };
  let target: URL;
  try {
    target = new URL(typed.includes('://') ? typed : `https://${typed}`);
  }
  catch {
    return refuse('invalid_target', 'not_a_url', 'The link isn\'t a URL.');
  }
  if (/^(10|127)\.\d{1,3}\.\d{1,3}\.\d{1,3}$|^192\.168\.\d{1,3}\.\d{1,3}$|^169\.254\.\d{1,3}\.\d{1,3}$|^\[(::1|fe80:.*|fc.*)\]$/.test(target.hostname))
    return refuse('host_not_allowed', 'private_address', 'This link points to a private or reserved address, which Anyfare never calls.');
  if (/^(\d{1,3}(\.\d{1,3}){3}|\[.*\])$/.test(target.hostname))
    return refuse('invalid_target', 'ip_address', 'The link must name a host, such as api.example.com, not an IP address.');
  if (target.host === '' || !target.host.includes('.'))
    return refuse('invalid_target', 'invalid_host', 'The link must name a host, such as api.example.com.');
  const { host } = target;
  const refusals: Readonly<Record<string, { readonly status: number; readonly body: unknown }>> = {
    [checkHosts.notPayable]: refuse('not_payable', 'no_payment_asked', `The link answered 200 without asking for a payment. Anyfare routes paid calls only.`, 200, plan(checkHosts.notPayable).tried),
    [checkHosts.unsupported]: refuse('unsupported_payment', 'no_option', 'The link asks for a payment, but in no way Anyfare can pay yet.', 402),
    [checkHosts.noChallenge]: refuse('unsupported_payment', 'no_challenge', 'The link answered 402, but without a payment request Anyfare can read.', 402),
    [checkHosts.blocked]: refuse('host_not_allowed', 'blocklisted', 'Anyfare doesn\'t route payments to this host.'),
    [checkHosts.private]: refuse('upstream_unavailable', 'dns', 'The link\'s host name doesn\'t resolve.'),
    [checkHosts.own]: refuse('host_not_allowed', 'own_host', 'This is one of Anyfare\'s own hosts.'),
    [new URL(payUrl).host]: refuse('host_not_allowed', 'own_host', 'This is one of Anyfare\'s own hosts.'),
    [checkHosts.optedOut]: refuse('host_not_allowed', 'opted_out', 'This host asked Anyfare not to route payments to it.'),
    [checkHosts.dead]: refuse('upstream_unavailable', 'dns', 'The link\'s host name doesn\'t resolve.'),
    [checkHosts.refused]: refuse('upstream_unavailable', 'refused', 'The host refused the connection.'),
    [checkHosts.timeout]: refuse('upstream_unavailable', 'timeout', 'The host didn\'t answer in time.'),
    [checkHosts.unreachable]: refuse('upstream_unavailable', 'unreachable', 'The host couldn\'t be reached.'),
    [checkHosts.headersTooLarge]: refuse('upstream_unavailable', 'headers_too_large', 'The API answered with headers too large to read.'),
    [checkHosts.other]: answered({ payable: false, method: first, exampleBody: null, tried: [], reason: 'surprise', message: 'Something we did not expect <b>happened</b>' }),
    [checkHosts.limited]: { status: 429, body: { error: { code: 'rate_limited', message: 'Too many requests' } } },
  };
  const refused = refusals[host];
  if (refused !== undefined)
    return refused;
  const { tried, won } = plan(host);
  // The status the last try answered
  const plain = [...tried].reverse().find(entry => entry.status !== null)?.status ?? 200;
  if (won === undefined)
    return refuse('not_payable', 'no_payment_asked', `The link answered ${plain} without asking for a payment. Anyfare routes paid calls only.`, plain, tried);

  const mpp = host === checkHosts.mpp;
  const bodyPriced = host === checkHosts.bodyPriced;
  const onNear = host === checkHosts.near;
  const hostile = host === checkHosts.hostile;
  const asset = mpp ? 'USDC.e' : 'USDC';
  const paidWith = mpp ? 'tempo' : onNear ? 'near' : 'base';
  const network = mpp ? 'eip155:4217' : onNear ? 'near:mainnet' : 'eip155:8453';
  const payTo = onNear ? 'merchant.sample.near' : `0x${'9a1f'.repeat(10)}`;
  const description = hostile ? hostileDescription : mpp ? 'One web search' : 'Latest quotes for sample assets';
  const resource = { url: `https://${host}${target.pathname}`, description, mimeType: 'application/json' };
  const accept = {
    scheme: 'exact',
    network,
    amount: mpp ? '5000' : bodyPriced ? '1000' : '10000',
    asset: onNear ? '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1' : '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    payTo,
    maxTimeoutSeconds: 60,
    extra: { name: hostile ? hostileValue : asset },
  };
  const x402 = { x402Version: 2, error: 'Payment required', resource, accepts: [accept] };
  const mppRequest = { method: 'tempo', intent: 'charge', realm: host, amount: '0.005', currency: asset, recipient: `0x${'5d2e'.repeat(10)}`, expires: new Date(now + 25_000).toISOString(), description };
  const price = mpp ? '0.005' : bodyPriced ? '0.001' : '0.01';
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
      method: won.method,
      exampleBody: bodyPriced ? exampleBody : null,
      tried,
      target: `https://${host}${target.pathname}${target.search}`,
      price: { amount: price, currency: 'USD', asset: mpp ? 'usdce-tempo' : onNear ? 'usdc-near' : 'usdc-base', network },
      quote: { amount: price, fee: '0', currency: 'USD' },
      link: `${payUrl}/${host}${target.pathname}${target.search}`,
      protocol: mpp ? 'mpp' : 'x402',
      asks: mpp
        ? { amount: price, asset, network, paidWith, method: 'tempo', intent: 'charge', realm: host, recipient: mppRequest.recipient, expires: mppRequest.expires, description }
        : { amount: price, asset, network, paidWith, payTo, scheme: 'exact', x402Version: 2, maxTimeoutSeconds: 60, description, mimeType: 'application/json' },
      upstream: { status: 402, headers, ...mpp ? { mpp: [mppRequest] } : { x402 } },
      payWith: ways.map(way => ({ ...way, amount: price, currency: 'USD' })),
      // Null when the numbers can't be read
      stats: host === unavailableHost || host === checkHosts.hidden ? null : sampleStats.stats,
      listed: host !== checkHosts.unlisted,
      checkedAt: new Date(now - 4_000).toISOString(),
      ms: 340,
    },
  };
};

/** How long the fake waits before it answers the check of a link: `slow.example.com` takes a moment. */
export const checkDelayMs = (typed: string): number => /(^|\/\/)slow\.example\.com/.test(typed) ? 1_500 : 0;

/** The endpoint's numbers for a period: the sample hosts' calls scaled, and zeros for any other endpoint. */
export const sampleEndpointStats = (host: string, path: string, period: Period, now: number, empty = false): EndpointStats => {
  const known = !empty && (edgeHosts.includes(host) || serviceHosts.includes(host) && servicePaths.includes(path as never) || host === checkHosts.busy || host === checkHosts.hostile || host === checkHosts.postOnly || host === checkHosts.bodyPriced || host === checkHosts.fallback);
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
export const answer = (url: URL, mode: Exclude<FakeApiMode, 'down'>, now: number, headers: Readonly<Record<string, string | string[] | undefined>> = {}, extra: ReadonlySet<string> = new Set()): { readonly status: number; readonly body: unknown } | undefined => {
  // No call was paid: an empty database, or one where links were only checked
  const empty = mode === 'empty' || mode === 'checked';
  const { pathname, searchParams } = url;
  if (pathname === '/v1/stats')
    return { status: 200, body: sampleStats(now, empty) };
  if (pathname === '/v1/stats/live')
    return { status: 200, body: sampleLive(now, empty) };
  if (pathname === '/v1/stats/top') {
    const period = searchParams.get('period') ?? '30d';
    if (!periods.includes(period as Period))
      return { status: 400, body: { error: { code: 'invalid_request', message: 'Unknown period' } } };

    return { status: 200, body: sampleTop(period as Period, now, empty, mode === 'edge') };
  }
  if (pathname === '/_/check') {
    const method = searchParams.get('method') ?? 'ANY';
    if (method !== 'ANY' && !checkMethods.includes(method))
      return { status: 400, body: { error: { code: 'invalid_request', message: 'The method is GET, POST, PUT, PATCH or DELETE' } } };
    const header = Object.entries(headers).some(([name, value]) => name.toLowerCase() === 'x-anyfare-check' && value === '1');
    // A check with a method but GET is honoured only with the header, so a plain link can't make the pay host send one
    if (method !== 'ANY' && method !== 'GET' && !header)
      return { status: 400, body: { error: { code: 'invalid_request', message: `A ${method} check needs the header X-Anyfare-Check: 1` } } };

    return sampleCheck(searchParams.get('url') ?? '', now, undefined, method, header);
  }
  if (pathname === '/v1/endpoints/stats') {
    const period = searchParams.get('period') ?? '30d';
    if (!periods.includes(period as Period))
      return { status: 400, body: { error: { code: 'invalid_request', message: 'Unknown period' } } };
    if ([unavailableHost, checkHosts.fallback].includes(searchParams.get('host')?.toLowerCase() ?? ''))
      return unavailable;
    if (searchParams.get('host')?.toLowerCase() === checkHosts.hidden)
      return { status: 404, body: { error: { code: 'not_found', message: 'No such endpoint' } } };

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
    const all = (busy ?? callsOf(now, empty, mode === 'edge')).filter(call => matchesCall(call, searchParams));
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
    const all = [...serviceRows(now, mode, extra)];
    const q = searchParams.get('q')?.toLowerCase();
    const rows = all.filter(row => q === undefined || row.host.toLowerCase().includes(q));
    const sort = searchParams.get('sort') ?? 'calls';
    if (!['calls', 'buyers', 'volume', 'endpoints', 'price', 'newest'].includes(sort))
      return { status: 400, body: { error: { code: 'invalid_request', message: 'Unknown sort' } } };
    const newest = (a: ServiceRow, b: ServiceRow): number => Date.parse(b.listedAt ?? '') - Date.parse(a.listedAt ?? '');
    rows.sort((a, b) => (
      sort === 'newest' ? newest(a, b)
        : sort === 'buyers' ? b.buyers - a.buyers
          : sort === 'volume' ? Number(b.volume) - Number(a.volume)
            : sort === 'endpoints' ? b.paidEndpoints - a.paidEndpoints
              // A service with no price comes last
              : sort === 'price' ? (a.priceFrom === null ? 1 : 0) - (b.priceFrom === null ? 1 : 0) || Number(a.priceFrom) - Number(b.priceFrom)
                // By calls the paid services come first, then the checked ones, newest first
                : (a.status === 'checked' ? 1 : 0) - (b.status === 'checked' ? 1 : 0)
    ) || (sort === 'newest' ? 0 : b.calls - a.calls) || newest(a, b));
    const body: ServicesPage = {
      services: rows.slice((page - 1) * size, page * size),
      page,
      size,
      total: rows.length,
      totalCapped: mode === 'capped',
      totals: {
        services: all.length,
        paidServices: all.filter(row => row.status === 'paid').length,
        paidEndpoints: all.reduce((sum, row) => sum + row.paidEndpoints, 0),
        calls30d: all.reduce((sum, row) => sum + row.calls, 0),
      },
      updatedAt: all.length === 0 ? null : new Date(now - 60_000).toISOString(),
    };

    return { status: 200, body };
  }
  if (pathname.startsWith('/v1/services/')) {
    const period = searchParams.get('period') ?? '30d';
    if (!periods.includes(period as Period))
      return { status: 400, body: { error: { code: 'invalid_request', message: 'Unknown period' } } };
    if (decodeURIComponent(pathname.slice('/v1/services/'.length)).toLowerCase() === unavailableHost && mode !== 'empty' && mode !== 'checked')
      return unavailable;
    const service = mode === 'empty' ? undefined : sampleService(decodeURIComponent(pathname.slice('/v1/services/'.length)).toLowerCase(), period as Period, now, undefined, mode === 'edge', mode !== 'checked', extra);

    return service === undefined
      ? { status: 404, body: { error: { code: 'not_found', message: 'No paid call or payable check has listed this host' } } }
      : { status: 200, body: service };
  }

  return undefined;
};

/** One request the fake got. */
export interface FakeRequest {
  readonly method: string;
  // The path with its query
  readonly path: string;
  // The query alone, without its `?`
  readonly query: string;
  readonly headers: IncomingMessage['headers'];
}

/** An account of the keyed routes. */
export interface FakeAccount {
  readonly id: string;
  readonly createdAt: string;
  masterKey: string;
  available: string;
  held: string;
  keys: FakeKey[];
  // Newest first
  payments: Payment[];
  // Newest first
  topups: Topup[];
  // The payment keys the fake issued to this account, secrets as they were shown once
  paymentKeys: string[];
}

/** A payment key of an account as the fake keeps it: the numbers it spent are plain numbers, the API's strings are made on the way out. */
export interface FakeKey {
  readonly id: string;
  label: string | null;
  allowance: string | null;
  dailyBudget: string;
  maxPrice: string | null;
  expiresAt: string | null;
  readonly createdAt: string;
  revokedAt: string | null;
  spentToday: number;
  spentTotal: number;
}

export interface FakeApi {
  // The origin the fake listens on, such as http://127.0.0.1:41234
  readonly url: string;
  // Every request it got, in order, but its own `/_test/` ones
  readonly requests: FakeRequest[];
  // Pushes a call to every open stream whose filters it passes
  readonly emitCall: (call: Call) => void;
  // Lists a host as a checked service, as a payable check does: its service page answers 200 from now on. The services list holds it first.
  readonly listChecked: (host: string) => void;
  readonly openStreams: () => number;
  // The accounts made through `POST /v1/accounts`, in order
  readonly accounts: () => readonly FakeAccount[];
  // Lets an origin call the keyed routes from a browser
  readonly allowConsoleOrigin: (origin: string) => void;
  // Makes the keyed routes answer `429 rate_limited`, or not
  readonly limit: (on: boolean) => void;
  // How the rotation answers once it has rotated: see `RotateAnswer`
  readonly rotateAnswer: (answer: RotateAnswer, ms?: number) => void;
  // How `POST /v1/topups` answers: see `CreateAnswer`; `ms` is how late a `late` answer comes
  readonly createAnswer: (answer: CreateAnswer, ms?: number) => void;
  readonly close: () => Promise<void>;
}

const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, OPTIONS', 'access-control-allow-headers': '*' };

const json = (response: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = cors): void => {
  response.writeHead(status, { ...headers, 'content-type': 'application/json' }).end(JSON.stringify(body));
};

// The routes that take the master key, and sign-up. The console calls them from its own origin.
const keyedRoots: readonly string[] = ['/v1/accounts', '/v1/account', '/v1/balance', '/v1/keys', '/v1/payments', '/v1/topups'];

/** Whether a path is one of the console's keyed routes, or sign-up. */
export const isKeyedPath = (pathname: string): boolean => keyedRoots.some(root => pathname === root || pathname.startsWith(`${root}/`));

/**
 * The CORS headers of a keyed route's answer, as the API sends them: the console's origin, matched exactly, and never
 * credentials. Any other origin, or none, gets no CORS header. Every answer says `Vary: Origin`.
 */
export const consoleCors = (origin: string | undefined, allowed: ReadonlySet<string>): Readonly<Record<string, string>> =>
  origin !== undefined && allowed.has(origin)
    ? { vary: 'Origin', 'access-control-allow-origin': origin, 'access-control-expose-headers': 'Retry-After, X-Request-Id' }
    : { vary: 'Origin' };

/**
 * How `POST /v1/topups` answers: as the API does; `hang`, the top-up is made and no answer ever comes; `drop`, it is made
 * and the connection closes with no answer; `lost`, the connection closes before anything is made; `late`, it is made
 * and answered after `ms` milliseconds.
 */
export type CreateAnswer = 'normal' | 'hang' | 'drop' | 'lost' | 'late';

const createAnswers: readonly CreateAnswer[] = ['normal', 'hang', 'drop', 'lost', 'late'];

/** How the rotation answers once it has rotated: as the API does, a 200 no one can read, no answer at all, or late. */
export type RotateAnswer = 'normal' | 'garble' | 'drop' | 'late';

const rotateAnswers: readonly RotateAnswer[] = ['normal', 'garble', 'drop', 'late'];

const consolePreflight = { 'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS', 'access-control-allow-headers': 'Authorization, Content-Type', 'access-control-max-age': '600' };

const sampleMasterKey = (): string => `afm_test_${randomBytes(16).toString('hex')}`;

const fail = (status: number, code: string, message: string) => ({ status, body: { error: { code, message } } });


const samplePaymentKey = (): string => `af_test_${randomBytes(16).toString('hex')}`;

/** An amount as the API prints it: at most 6 decimals, no trailing zero. */
const amountText = (value: number): string => {
  const text = (Math.round(value * 1_000_000) / 1_000_000).toFixed(6).replace(/0+$/, '').replace(/\.$/, '');

  return text === '-0' ? '0' : text;
};

/** The Key the API answers with. */
const keyBody = (key: FakeKey): PaymentKey => ({
  id: key.id,
  label: key.label,
  allowance: key.allowance,
  dailyBudget: key.dailyBudget,
  maxPrice: key.maxPrice,
  expiresAt: key.expiresAt,
  createdAt: key.createdAt,
  revokedAt: key.revokedAt,
  spent: { today: amountText(key.spentToday), total: amountText(key.spentTotal) },
  remaining: {
    allowance: key.allowance === null ? null : amountText(Math.max(0, Number(key.allowance) - key.spentTotal)),
    dailyBudget: amountText(Math.max(0, Number(key.dailyBudget) - key.spentToday)),
  },
});

const newKeyId = (): string => `key_${randomBytes(6).toString('hex')}`;

/** In edge mode: a key whose label is 60 characters. */
export const longLabel = `Agent ${'n'.repeat(54)}`;

const seedKeys = (mode: FakeApiMode, now: number): FakeKey[] => {
  if (mode === 'empty' || mode === 'checked')
    return [];
  const at = (days: number): string => new Date(now + days * day).toISOString();
  const keys: FakeKey[] = [
    { id: newKeyId(), label: 'research agent', allowance: '20', dailyBudget: '5', maxPrice: '0.05', expiresAt: at(60), createdAt: at(-20), revokedAt: null, spentToday: 4.2, spentTotal: 12.4 },
    { id: newKeyId(), label: null, allowance: null, dailyBudget: '1', maxPrice: null, expiresAt: null, createdAt: at(-9), revokedAt: null, spentToday: 0.12, spentTotal: 0.5 },
    { id: newKeyId(), label: 'trial agent', allowance: '2', dailyBudget: '0.5', maxPrice: '0.01', expiresAt: at(-2), createdAt: at(-30), revokedAt: null, spentToday: 0, spentTotal: 1.9 },
    { id: newKeyId(), label: 'retired agent', allowance: null, dailyBudget: '2', maxPrice: '0.02', expiresAt: null, createdAt: at(-40), revokedAt: at(-12), spentToday: 0, spentTotal: 3.3 },
  ];
  if (mode === 'edge')
    keys.splice(1, 0, { id: newKeyId(), label: longLabel, allowance: '100', dailyBudget: '25', maxPrice: '1', expiresAt: at(120), createdAt: at(-3), revokedAt: null, spentToday: 7.5, spentTotal: 31.2 });

  return keys;
};

/** The sample calls of an account, newest first, 45 of them: some free, and in `full` and `edge` one in flight. */
const seedPayments = (mode: FakeApiMode, keys: readonly FakeKey[], now: number): Payment[] => {
  if (keys.length === 0)
    return [];
  const owners: readonly (string | null)[] = [keys[0]!.id, keys[1]!.id, keys[0]!.id, keys[2]!.id, null];
  const payments = Array.from({ length: 45 }, (_unused, index): Payment => {
    const call = sampleCall(index, now, index * 420 + 90);
    const free = call.status === 'free';
    const pending = index === 1;

    return {
      id: call.id,
      requestId: `req_sample${String(index).padStart(4, '0')}`,
      rail: call.paidWith,
      targetHost: call.service,
      targetPath: call.path,
      amount: call.amount,
      status: pending ? 'pending' : call.status,
      createdAt: call.at,
      updatedAt: call.at,
      keyId: owners[index % owners.length] ?? null,
      upstreamStatus: pending ? null : free ? (index === 9 ? null : 502) : 200,
      state: pending ? 'pending' : free ? 'free' : 'paid',
    };
  });
  if (mode === 'edge') {
    const at = new Date(now - 30_000).toISOString();
    payments.unshift({
      id: 'pay_longpath', requestId: 'req_longpath', rail: 'near', targetHost: longHost, targetPath: longPath, amount: '0.003', status: 'paid', createdAt: at, updatedAt: at,
      keyId: keys[1]!.id, upstreamStatus: 200, state: 'paid',
    });
  }

  return payments;
};

// ---------- Top-ups ----------

/** The API's sentence for each status of a top-up. */
export const topupMessages: Readonly<Record<string, string>> = {
  quoting: 'Getting a deposit address',
  quote_failed: 'No deposit address: the quote was refused. Nothing to send',
  quote_unknown: 'No deposit address: the quote didn\'t answer. Nothing to send. Ask again',
  waiting: 'Waiting for your transfer',
  incomplete: 'Received less than the least to send. Send the rest before the time runs out',
  processing: 'Received. Converting',
  credited: 'Added to your balance',
  refunded: 'Not added. We hold the amount for you and will return it. Contact us',
  failed: 'Stopped. We are looking into it',
  expired: 'The time to pay ran out. Don\'t send to this address',
};

export const topupStatusNames: readonly string[] = Object.keys(topupMessages);

interface SampleToken {
  readonly symbol: string;
  readonly address?: string;
  readonly decimals: number;
  // A sample price in USD, for the estimate
  readonly usd: number;
}

interface SampleNetwork {
  readonly name: string;
  readonly minimum: string;
  readonly tokens: readonly SampleToken[];
}

// The six networks a top-up comes from, with sample tokens. Every address is a plain sample: no real contract or wallet.
const sampleNetworks: readonly SampleNetwork[] = [
  { name: 'base', minimum: '1', tokens: [{ symbol: 'USDC', address: `0x${'1'.repeat(40)}`, decimals: 6, usd: 1 }, { symbol: 'ETH', decimals: 18, usd: 3000 }] },
  { name: 'arbitrum', minimum: '1', tokens: [{ symbol: 'USDC', address: `0x${'2'.repeat(40)}`, decimals: 6, usd: 1 }, { symbol: 'ARB', address: `0x${'3'.repeat(40)}`, decimals: 18, usd: 0.5 }] },
  { name: 'solana', minimum: '1', tokens: [{ symbol: 'USDC', address: '4'.repeat(44), decimals: 6, usd: 1 }, { symbol: 'SOL', decimals: 9, usd: 150 }] },
  { name: 'near', minimum: '1', tokens: [{ symbol: 'USDC', address: 'usdc.sample.near', decimals: 6, usd: 1 }, { symbol: 'wNEAR', address: 'wrap.sample.near', decimals: 24, usd: 3 }] },
  { name: 'ethereum', minimum: '5', tokens: [{ symbol: 'USDC', address: `0x${'5'.repeat(40)}`, decimals: 6, usd: 1 }, { symbol: 'USDT', address: `0x${'6'.repeat(40)}`, decimals: 6, usd: 1 }, { symbol: 'DAI', address: `0x${'7'.repeat(40)}`, decimals: 18, usd: 1 }] },
  { name: 'bitcoin', minimum: '10', tokens: [{ symbol: 'BTC', decimals: 8, usd: 60000 }] },
];

// In edge mode Arbitrum has a second token named USDC, so a request names it by its address
const edgeNetworks: readonly SampleNetwork[] = sampleNetworks.map(network => network.name === 'arbitrum'
  ? { ...network, tokens: [...network.tokens, { symbol: 'USDC', address: `0x${'8'.repeat(40)}`, decimals: 6, usd: 1 }] }
  : network);

const networksOf = (mode: FakeApiMode): readonly SampleNetwork[] => mode === 'edge' ? edgeNetworks : sampleNetworks;

/** `GET /v1/topups/options`: the networks with their tokens, or without them when the token list "can't be read". */
export const sampleTopupOptions = (mode: FakeApiMode, withTokens = true) => ({
  asset: 'USDC on NEAR',
  networks: networksOf(mode).map(network => ({
    name: network.name,
    minimum: network.minimum,
    ...withTokens ? { tokens: network.tokens.map(token => ({ symbol: token.symbol, ...token.address === undefined ? {} : { address: token.address }, decimals: token.decimals })) } : {},
  })),
});

// Each new deposit address gets the next number, so no two top-ups share one
let addressCounter = 0;

/**
 * A sample deposit address on a network, with its number in its last 8 characters: `0xaaaa…00000007` on Base. A plain
 * sample of the network's shape, no real wallet.
 */
export const sampleDepositAddress = (network: string, number: number): string => {
  const tail = String(number).padStart(8, '0');
  const shapes: Readonly<Record<string, string>> = {
    base: `0x${'a'.repeat(32)}${tail}`,
    arbitrum: `0x${'b'.repeat(32)}${tail}`,
    ethereum: `0x${'c'.repeat(32)}${tail}`,
    solana: `${'9'.repeat(36)}${tail.replace(/0/g, '9')}`,
    near: `${'d'.repeat(56)}${tail}`,
    bitcoin: `bc1q${'q'.repeat(30)}${tail}`,
  };

  return shapes[network] ?? `0x${'e'.repeat(32)}${tail}`;
};

const nextDepositAddress = (network: string): string => {
  addressCounter += 1;

  return sampleDepositAddress(network, addressCounter);
};

/** The memo the fake gives when asked for one. */
export const sampleMemo = '424242';

/** A sample delivery transaction on NEAR: base58 of the right length, plainly not a real one. */
export const sampleTransaction = (index: number): string => `SampTx${(index % 9) + 1}${'1'.repeat(37)}`;

const tokenOf = (network: string, symbol: string): SampleToken | undefined =>
  sampleNetworks.concat(edgeNetworks).find(item => item.name === network)?.tokens.find(token => token.symbol.toUpperCase() === symbol.toUpperCase());

/** An amount of a token, at most its decimals (and 6), without the zeros at the end. */
const units = (value: number, decimals: number): string => {
  const text = value.toFixed(Math.min(decimals, 6)).replace(/0+$/, '').replace(/\.$/, '');

  return text === '' ? '0' : text;
};

/** A decimal string without its leading zeros and the zeros at the end of its fraction, as the API prints an amount. */
const plainUnits = (amount: string): string => {
  const [whole = '0', fraction = ''] = amount.split('.');
  const wholePart = whole.replace(/^0+(?=\d)/, '');
  const fractionPart = fraction.replace(/0+$/, '');

  return fractionPart === '' ? wholePart : `${wholePart}.${fractionPart}`;
};

const usdText = (value: number): string => String(Math.round(value * 100) / 100);

/**
 * A top-up moved to `status` with the fields that status carries, from what was asked: the address and the amounts to
 * send while it can take a transfer, what arrived from `incomplete` on, the Credits once credited. `seconds` is the
 * time left to pay.
 */
export const topupAt = (base: Pick<Topup, 'id' | 'network' | 'token' | 'amount' | 'createdAt'> & { readonly depositAddress?: string | null }, status: string, now: number, options: { readonly memo?: boolean; readonly seconds?: number } = {}): Topup => {
  const token = tokenOf(base.network, base.token) ?? { symbol: base.token, decimals: 6, usd: 1 };
  const amount = Number(base.amount);
  const sendAtLeast = units(amount * 0.995, token.decimals);
  const quoted = status !== 'quoting' && status !== 'quote_failed' && status !== 'quote_unknown';
  const arrived = ['processing', 'credited', 'refunded', 'failed'].includes(status);
  const payBy = status === 'expired' ? now - 60_000 : now + (options.seconds ?? 3600) * 1000;

  return {
    id: base.id,
    status,
    message: topupMessages[status] ?? status,
    network: base.network,
    token: base.token,
    amount: base.amount,
    // A top-up keeps its own address when it moves; one that gets an address now gets a new one
    depositAddress: quoted ? base.depositAddress ?? nextDepositAddress(base.network) : null,
    depositMemo: quoted && options.memo === true ? sampleMemo : null,
    send: quoted ? base.amount : null,
    sendAtLeast: quoted ? sendAtLeast : null,
    estimatedCredits: quoted ? usdText(amount * token.usd * 0.999) : null,
    payBy: new Date(payBy).toISOString(),
    addressExpiresAt: quoted ? new Date(payBy).toISOString() : null,
    createdAt: base.createdAt,
    updatedAt: new Date(now).toISOString(),
    deposited: status === 'incomplete' ? units(amount * 0.6, token.decimals) : arrived ? base.amount : null,
    credited: status === 'credited' ? usdText(amount * token.usd * 0.999) : null,
    transaction: status === 'credited' ? sampleTransaction(base.id.length) : null,
    refunded: status === 'refunded' ? base.amount : null,
    refundReason: status === 'refunded' ? 'The swap could not be done at the quoted price.' : null,
  };
};

const seedTopups = (mode: FakeApiMode, now: number): Topup[] => {
  if (mode === 'empty' || mode === 'checked')
    return [];
  const make = (index: number, status: string, network: string, token: string, amount: string): Topup =>
    topupAt({ id: `top_sample${index}`, network, token, amount, createdAt: new Date(now - (index * 5 + 2) * 3_600_000).toISOString() }, status, now);

  return [
    make(0, 'processing', 'base', 'USDC', '20'),
    make(1, 'credited', 'base', 'ETH', '0.0061'),
    make(2, 'waiting', 'solana', 'SOL', '0.2'),
    make(3, 'incomplete', 'near', 'USDC', '5'),
    make(4, 'refunded', 'ethereum', 'USDC', '10'),
    make(5, 'expired', 'arbitrum', 'USDC', '7'),
    make(6, 'failed', 'bitcoin', 'BTC', '0.0003'),
    make(7, 'quote_failed', 'near', 'wNEAR', '4'),
  ];
};

/** What the top-up routes are told by the fake's switches: off (`503`), the options without tokens, and the clock. */
export interface TopupSwitches {
  readonly off: boolean;
  readonly tokens: boolean;
}

const unavailable503 = () => fail(503, 'topups_unavailable', 'Top-ups are off right now. Calls keep working.');

/** `POST /v1/topups`: the request checked as the API checks it, then a new top-up, `waiting`, at the top of the account's list. */
const createTopupAnswer = (account: FakeAccount, body: unknown, mode: FakeApiMode, now: number): { readonly status: number; readonly body: unknown } => {
  const fields = bodyObject(body);
  if (fields === undefined || Object.keys(fields).some(name => !['network', 'token', 'amount'].includes(name)))
    return badRequest('The body is network, token and amount');
  const { network, token, amount } = fields;
  if (typeof network !== 'string' || typeof token !== 'string' || typeof amount !== 'string')
    return badRequest('network, token and amount are strings');
  const place = networksOf(mode).find(item => item.name === network);
  if (place === undefined)
    return fail(400, 'unsupported_network', `Top-ups come from ${networksOf(mode).map(item => item.name).join(', ')}`);
  const bySymbol = place.tokens.filter(item => item.symbol.toUpperCase() === token.toUpperCase());
  if (bySymbol.length > 1)
    return fail(400, 'ambiguous_token', `Two tokens on ${network} are named ${token}: name one by its address`);
  const chosen = bySymbol[0] ?? place.tokens.find(item => item.address === token);
  if (chosen === undefined)
    return fail(400, 'unknown_token', `No token ${token} on ${network}`);
  const match = /^[0-9]{1,30}(?:\.([0-9]{1,30}))?$/.exec(amount);
  if (match === null || (match[1] ?? '').length > chosen.decimals || Number(amount) <= 0)
    return fail(400, 'invalid_amount', `The amount is a number above 0 with at most ${chosen.decimals} decimals`);
  const worth = Number(amount) * chosen.usd;
  if (worth < Number(place.minimum))
    return fail(400, 'amount_too_small', `A top-up on ${network} must be worth at least $${Number(place.minimum).toFixed(2)}. This one is worth $${worth.toFixed(2)}.`);
  const topup = topupAt({ id: `top_${randomBytes(8).toString('hex')}`, network, token: chosen.symbol, amount: plainUnits(amount), createdAt: new Date(now).toISOString() }, 'waiting', now);
  account.topups.unshift(topup);

  return { status: 201, body: topup };
};

const seedAccount = (account: FakeAccount, mode: FakeApiMode, now: number): void => {
  account.keys = seedKeys(mode, now);
  account.payments = seedPayments(mode, account.keys, now);
  account.topups = seedTopups(mode, now);
};

const decimalPattern = /^\d{1,12}(?:\.\d{1,6})?$/;

const badRequest = (message: string) => fail(400, 'invalid_request', message);

/** A message naming the field the body gets wrong, or undefined when every field is right. `null` clears an optional field. */
const keyBodyProblem = (body: Record<string, unknown>, now: number): string | undefined => {
  const known = ['label', 'dailyBudget', 'maxPrice', 'allowance', 'expiresAt'];
  for (const name of Object.keys(body)) {
    if (!known.includes(name))
      return `${name} is not a field of a key`;
  }
  const { label, dailyBudget, maxPrice, allowance, expiresAt } = body;
  if (label !== undefined && label !== null && (typeof label !== 'string' || label.length > 60))
    return 'label is at most 60 characters';
  if (dailyBudget !== undefined && (typeof dailyBudget !== 'string' || !decimalPattern.test(dailyBudget) || Number(dailyBudget) <= 0))
    return 'dailyBudget is a USD amount above 0 with at most 6 decimals';
  for (const [name, value] of [['maxPrice', maxPrice], ['allowance', allowance]] as const) {
    if (value !== undefined && value !== null && (typeof value !== 'string' || !decimalPattern.test(value) || Number(value) <= 0))
      return `${name} is a USD amount above 0 with at most 6 decimals`;
  }
  if (expiresAt !== undefined && expiresAt !== null && (typeof expiresAt !== 'string' || Number.isNaN(Date.parse(expiresAt)) || Date.parse(expiresAt) <= now))
    return 'expiresAt is a full ISO time in the future';

  return undefined;
};

const bodyObject = (body: unknown): Record<string, unknown> | undefined =>
  body === undefined ? {} : typeof body === 'object' && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : undefined;

/** The page of a list that `limit` and `after` ask for, newest first. A cursor is `cur_` and the id of the last item before the page. */
const pageOf = <TItem extends { readonly id: string }>(all: readonly TItem[], search: URLSearchParams): { readonly items: readonly TItem[]; readonly next: string | null } | string => {
  const limitText = search.get('limit') ?? '20';
  const limit = Number(limitText);
  if (!/^\d+$/.test(limitText) || limit < 1 || limit > 100)
    return 'limit is a whole number from 1 to 100';
  const after = search.get('after');
  let start = 0;
  if (after !== null) {
    const index = all.findIndex(item => `cur_${item.id}` === after);
    if (index === -1)
      return 'after is not a cursor this list gave';
    start = index + 1;
  }
  const items = all.slice(start, start + limit);

  return { items, next: start + limit < all.length && items.length > 0 ? `cur_${items.at(-1)!.id}` : null };
};

/** What a keyed route is asked beyond its method and path: the mode of the fake, the query, and the JSON body (undefined when there is none). */
export interface KeyedAsk {
  readonly mode: FakeApiMode;
  readonly search: URLSearchParams;
  readonly body: unknown;
  // The top-up switches; none is all on
  readonly topups?: TopupSwitches;
}

const keysAnswer = (method: string, pathname: string, account: FakeAccount, ask: KeyedAsk): { readonly status: number; readonly body: unknown } | undefined => {
  const now = Date.now();
  if (pathname === '/v1/keys') {
    if (method === 'GET')
      return { status: 200, body: { keys: account.keys.map(keyBody) } };
    if (method !== 'POST')
      return fail(405, 'method_not_allowed', 'Use GET or POST');
    const body = bodyObject(ask.body);
    const problem = body === undefined ? 'The body is a JSON object' : keyBodyProblem(body, now);
    if (body === undefined || problem !== undefined)
      return badRequest(problem ?? 'The body is a JSON object');
    const key: FakeKey = {
      id: newKeyId(),
      label: typeof body['label'] === 'string' ? body['label'] : null,
      allowance: typeof body['allowance'] === 'string' ? body['allowance'] : null,
      dailyBudget: typeof body['dailyBudget'] === 'string' ? body['dailyBudget'] : '5',
      maxPrice: typeof body['maxPrice'] === 'string' ? body['maxPrice'] : null,
      expiresAt: typeof body['expiresAt'] === 'string' ? new Date(body['expiresAt']).toISOString() : null,
      createdAt: new Date(now).toISOString(),
      revokedAt: null,
      spentToday: 0,
      spentTotal: 0,
    };
    const secret = samplePaymentKey();
    account.keys.unshift(key);
    account.paymentKeys.push(secret);

    return { status: 201, body: { ...keyBody(key), key: secret } };
  }
  const id = /^\/v1\/keys\/([^/]+)$/.exec(pathname)?.[1];
  if (id === undefined)
    return undefined;
  const key = account.keys.find(item => item.id === decodeURIComponent(id));
  if (key === undefined)
    return fail(404, 'not_found', 'There is no such key on this account');
  if (method === 'PATCH') {
    if (key.revokedAt !== null)
      return fail(409, 'key_revoked', 'A revoked key can\'t be changed');
    const body = bodyObject(ask.body);
    const problem = body === undefined ? 'The body is a JSON object' : keyBodyProblem(body, now);
    if (body === undefined || problem !== undefined)
      return badRequest(problem ?? 'The body is a JSON object');
    if (body['dailyBudget'] === null)
      return badRequest('dailyBudget can\'t be cleared');
    if ('label' in body)
      key.label = body['label'] as string | null;
    if (typeof body['dailyBudget'] === 'string')
      key.dailyBudget = body['dailyBudget'];
    if ('maxPrice' in body)
      key.maxPrice = body['maxPrice'] as string | null;
    if ('allowance' in body)
      key.allowance = body['allowance'] as string | null;
    if ('expiresAt' in body)
      key.expiresAt = body['expiresAt'] === null ? null : new Date(body['expiresAt'] as string).toISOString();

    return { status: 200, body: keyBody(key) };
  }
  if (method === 'DELETE') {
    key.revokedAt ??= new Date(now).toISOString();

    return { status: 200, body: { id: key.id, revokedAt: key.revokedAt } };
  }

  return fail(405, 'method_not_allowed', 'Use PATCH or DELETE');
};

const paymentsAnswer = (account: FakeAccount, search: URLSearchParams): { readonly status: number; readonly body: unknown } => {
  for (const name of search.keys()) {
    if (!['limit', 'after', 'state', 'keyId', 'service'].includes(name))
      return badRequest(`${name} is not a parameter of this route`);
  }
  const state = search.get('state');
  if (state !== null && !['paid', 'free', 'pending'].includes(state))
    return badRequest('state is paid, free or pending');
  const keyId = search.get('keyId');
  const service = search.get('service');
  const matching = account.payments.filter(payment => (state === null || payment.state === (state as PaymentState)) && (keyId === null || payment.keyId === keyId) && (service === null || payment.targetHost === service));
  const page = pageOf(matching, search);

  return typeof page === 'string' ? badRequest(page) : { status: 200, body: { payments: page.items, next: page.next } };
};

const topupsAnswer = (account: FakeAccount, search: URLSearchParams): { readonly status: number; readonly body: unknown } => {
  for (const name of search.keys()) {
    if (!['limit', 'after'].includes(name))
      return badRequest(`${name} is not a parameter of this route`);
  }
  const page = pageOf(account.topups, search);

  return typeof page === 'string' ? badRequest(page) : { status: 200, body: { topups: page.items, next: page.next } };
};

/**
 * The answer of a keyed route, from the accounts in `byKey`: sign-up, the account, the rotation and the balance. A
 * rotation drops the key that sent it, so that key answers `401 invalid_key` from then on.
 */
export const keyedAnswer = (method: string, pathname: string, authorization: string | undefined, byKey: Map<string, FakeAccount>, made: FakeAccount[], ask: KeyedAsk = { mode: 'full', search: new URLSearchParams(), body: undefined }): { readonly status: number; readonly body: unknown } => {
  if (pathname === '/v1/accounts') {
    if (method !== 'POST')
      return fail(405, 'method_not_allowed', 'Use POST');
    const account: FakeAccount = { id: `acc_${randomUUID()}`, createdAt: new Date().toISOString(), masterKey: sampleMasterKey(), available: '0.1', held: '0', keys: [], payments: [], topups: [], paymentKeys: [] };
    seedAccount(account, ask.mode, Date.now());
    byKey.set(account.masterKey, account);
    made.push(account);

    return {
      status: 201,
      body: { id: account.id, createdAt: account.createdAt, masterKey: account.masterKey, freeCredits: '0.1', notice: 'Keep the master key: it is shown once and can\'t be recovered.' },
    };
  }
  const key = /^Bearer (\S+)$/.exec(authorization ?? '')?.[1];
  if (key === undefined)
    return fail(401, 'unauthorized', 'Send the master key as Authorization: Bearer <key>');
  if (/^af_(?:live|test)_/.test(key))
    return fail(401, 'wrong_key_type', 'This is a payment key. This route takes the master key.');
  const account = byKey.get(key);
  if (account === undefined)
    return fail(401, 'invalid_key', 'This key is not valid');
  if (pathname === '/v1/account' && method === 'GET')
    return { status: 200, body: { id: account.id, createdAt: account.createdAt } };
  if (pathname === '/v1/account/master-key/rotate' && method === 'POST') {
    byKey.delete(key);
    account.masterKey = sampleMasterKey();
    byKey.set(account.masterKey, account);

    return { status: 200, body: { masterKey: account.masterKey } };
  }
  if (pathname === '/v1/balance' && method === 'GET')
    return { status: 200, body: { available: account.available, held: account.held } };
  if (pathname === '/v1/payments' && method === 'GET')
    return paymentsAnswer(account, ask.search);
  if (pathname === '/v1/topups' || pathname.startsWith('/v1/topups/')) {
    if (ask.topups?.off === true)
      return unavailable503();
    if (pathname === '/v1/topups' && method === 'GET')
      return topupsAnswer(account, ask.search);
    if (pathname === '/v1/topups' && method === 'POST')
      return createTopupAnswer(account, ask.body, ask.mode, Date.now());
    if (method === 'GET') {
      const id = decodeURIComponent(pathname.slice('/v1/topups/'.length));
      const topup = account.topups.find(item => item.id === id);

      return topup === undefined ? fail(404, 'not_found', 'No such top-up on this account') : { status: 200, body: topup };
    }

    return fail(405, 'method_not_allowed', 'Use GET or POST');
  }
  if (pathname === '/v1/keys' || pathname.startsWith('/v1/keys/'))
    return keysAnswer(method, pathname, account, ask) ?? fail(404, 'not_found', 'Not found');

  return fail(404, 'not_found', 'Not found');
};

/** Starts a fake API. `port` 0 picks a free one. `consoleOrigins` may call the keyed routes from a browser. */
export const startFakeApi = async (mode: FakeApiMode, port = 0, slowMs = 0, consoleOrigins: readonly string[] = []): Promise<FakeApi> => {
  const requests: FakeRequest[] = [];
  const allowed = new Set(consoleOrigins);
  const byKey = new Map<string, FakeAccount>();
  const made: FakeAccount[] = [];
  let limited = false;
  let requestCounter = 0;
  let rotation: { answer: RotateAnswer; ms: number } = { answer: 'normal', ms: 0 };
  let topupSwitches: TopupSwitches = { off: false, tokens: true };
  let creation: CreateAnswer = 'normal';
  let creationMs = 0;
  // How long `GET /v1/topups/:id` waits for one top-up, by its id
  const slowReads = new Map<string, number>();
  // Requests held open by `hang`, closed with the server
  const held = new Set<ServerResponse>();
  // Each open stream with the filters it was opened with
  const streams = new Map<ServerResponse, URLSearchParams>();
  // The hosts listed while the fake runs
  const listed = new Set<string>();
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
    const method = request.method ?? 'GET';
    if (url.pathname === '/_test/requests' && method === 'GET') {
      json(response, 200, { requests });

      return;
    }
    if (url.pathname === '/_test/limited' && method === 'POST') {
      limited = url.searchParams.get('on') === '1';
      json(response, 200, { limited });

      return;
    }
    if (url.pathname === '/_test/rotate' && method === 'POST') {
      const answer = url.searchParams.get('answer') ?? 'normal';
      if (!rotateAnswers.includes(answer as RotateAnswer)) {
        json(response, 400, { error: { code: 'invalid_request', message: `The answer is ${rotateAnswers.join(', ')}` } });

        return;
      }
      rotation = { answer: answer as RotateAnswer, ms: Number(url.searchParams.get('ms') ?? '0') || 0 };
      json(response, 200, rotation);

      return;
    }
    if (url.pathname === '/_test/slow' && method === 'POST') {
      // `GET /v1/topups/:id` of this top-up answers after `ms` milliseconds; 0 puts it back
      const id = url.searchParams.get('id') ?? '';
      const ms = Number(url.searchParams.get('ms') ?? '0') || 0;
      if (ms > 0)
        slowReads.set(id, ms);
      else
        slowReads.delete(id);
      json(response, 200, { id, ms });

      return;
    }
    if (url.pathname === '/_test/topups' && method === 'POST') {
      topupSwitches = { ...topupSwitches, off: url.searchParams.get('off') === '1' };
      json(response, 200, topupSwitches);

      return;
    }
    if (url.pathname === '/_test/options' && method === 'POST') {
      topupSwitches = { ...topupSwitches, tokens: url.searchParams.get('tokens') !== '0' };
      json(response, 200, topupSwitches);

      return;
    }
    if (url.pathname === '/_test/create' && method === 'POST') {
      const answer = url.searchParams.get('answer') ?? 'normal';
      if (!createAnswers.includes(answer as CreateAnswer)) {
        json(response, 400, { error: { code: 'invalid_request', message: `The answer is ${createAnswers.join(', ')}` } });

        return;
      }
      creation = answer as CreateAnswer;
      creationMs = Number(url.searchParams.get('ms') ?? '0') || 0;
      json(response, 200, { answer: creation, ms: creationMs });

      return;
    }
    if (url.pathname === '/_test/topup' && method === 'POST') {
      // Moves the top-up with this id, in every account that has it, to a status with the fields it carries; an account
      // without it gets it, at the top, as a USDC top-up on Base
      const id = url.searchParams.get('id') ?? '';
      const status = url.searchParams.get('status') ?? '';
      if (!/^top_[A-Za-z0-9_-]{1,64}$/.test(id) || !topupStatusNames.includes(status)) {
        json(response, 400, { error: { code: 'invalid_request', message: `id is a top-up id, status one of ${topupStatusNames.join(', ')}` } });

        return;
      }
      const seconds = url.searchParams.get('seconds');
      const options = { memo: url.searchParams.get('memo') === '1', ...seconds === null ? {} : { seconds: Number(seconds) || 0 } };
      const now = Date.now();
      let moved = 0;
      for (const account of made) {
        const index = account.topups.findIndex(item => item.id === id);
        const base = index === -1 ? { id, network: 'base', token: 'USDC', amount: '20', createdAt: new Date(now).toISOString() } : account.topups[index]!;
        const next = topupAt(base, status, now, options);
        if (index === -1)
          account.topups.unshift(next);
        else
          account.topups[index] = next;
        moved += 1;
      }
      json(response, 200, { accounts: moved });

      return;
    }
    if (url.pathname === '/_test/held' && method === 'POST') {
      for (const account of made)
        account.held = url.searchParams.get('amount') ?? '0';
      json(response, 200, { accounts: made.length });

      return;
    }
    requests.push({ method, path: `${url.pathname}${url.search}`, query: url.search.slice(1), headers: request.headers });
    // The networks of a top-up: no key, and any origin may read them, as the API's
    if (url.pathname === '/v1/topups/options') {
      if (method === 'OPTIONS')
        response.writeHead(204, cors).end();
      else if (mode === 'down')
        json(response, 500, { error: { code: 'internal_error', message: 'Internal server error' } });
      else if (topupSwitches.off)
        json(response, 503, unavailable503().body);
      else if (method !== 'GET')
        json(response, 405, { error: { code: 'method_not_allowed', message: 'Use GET' } });
      else
        json(response, 200, sampleTopupOptions(mode, topupSwitches.tokens));

      return;
    }
    if (isKeyedPath(url.pathname)) {
      requestCounter += 1;
      const origin = typeof request.headers.origin === 'string' ? request.headers.origin : undefined;
      const headers: Record<string, string> = { ...consoleCors(origin, allowed), 'x-request-id': `req_${requestCounter}` };
      if (method === 'OPTIONS') {
        // The console's preflight; any other is answered as a path with no route, as the API does
        if (headers['access-control-allow-origin'] !== undefined)
          response.writeHead(204, { ...headers, ...consolePreflight }).end();
        else
          json(response, 404, { error: { code: 'not_found', message: 'Not found' } }, headers);

        return;
      }
      if (mode === 'down') {
        json(response, 500, { error: { code: 'internal_error', message: 'Internal server error' } }, headers);

        return;
      }
      if (limited) {
        json(response, 429, { error: { code: 'rate_limited', message: 'Too many requests' } }, { ...headers, 'retry-after': '30' });

        return;
      }
      // The body of a keyed request is read before it is answered: a key is made or changed from it
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        let body: unknown;
        try {
          const text = Buffer.concat(chunks).toString('utf8');
          body = text === '' ? undefined : JSON.parse(text);
        }
        catch {
          body = 'not json';
        }
        const creating = url.pathname === '/v1/topups' && method === 'POST' && !topupSwitches.off && byKey.has(/^Bearer (\S+)$/.exec(request.headers.authorization ?? '')?.[1] ?? '');
        // Lost: the connection closes before the top-up is made
        if (creating && creation === 'lost') {
          response.destroy();

          return;
        }
        const found = keyedAnswer(method, url.pathname, request.headers.authorization, byKey, made, { mode, search: url.searchParams, body, topups: topupSwitches });
        // The top-up was made above; only its answer is changed
        if (creating && found.status === 201 && creation === 'drop') {
          response.destroy();

          return;
        }
        if (creating && found.status === 201 && creation === 'hang') {
          held.add(response);
          response.on('close', () => held.delete(response));

          return;
        }
        const rotated = url.pathname === '/v1/account/master-key/rotate' && found.status === 200;
        // The rotation happened above; only its answer is changed
        if (rotated && rotation.answer === 'drop') {
          response.destroy();

          return;
        }
        const send = (): void => {
          if (rotated && rotation.answer === 'garble')
            response.writeHead(200, { ...headers, 'content-type': 'text/html' }).end('<html><body>Bad gateway</body></html>');
          else
            json(response, found.status, found.body, headers);
        };
        const readId = method === 'GET' && url.pathname.startsWith('/v1/topups/') ? decodeURIComponent(url.pathname.slice('/v1/topups/'.length)) : undefined;
        const delay = rotated && rotation.answer === 'late' ? rotation.ms
          : creating && found.status === 201 && creation === 'late' ? creationMs
            : readId !== undefined && slowReads.has(readId) ? slowReads.get(readId)! : slowMs;
        if (delay > 0)
          setTimeout(send, delay);
        else
          send();
      });

      return;
    }
    if (method === 'OPTIONS') {
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
    if (url.pathname === '/_test/checked' && request.method === 'POST') {
      listed.add((url.searchParams.get('host') ?? '').toLowerCase());
      json(response, 200, { listed: [...listed] });

      return;
    }
    const found = answer(url, mode, Date.now(), request.headers, listed);
    // `slowMs` slows every read, to see a loading state in a browser
    const delay = Math.max(slowMs, url.pathname === '/_/check' ? checkDelayMs(url.searchParams.get('url') ?? '') : 0);
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
    listChecked: host => void listed.add(host.toLowerCase()),
    openStreams: () => streams.size,
    accounts: () => made,
    allowConsoleOrigin: origin => void allowed.add(origin),
    limit: on => {
      limited = on;
    },
    rotateAnswer: (answer, ms = 0) => {
      rotation = { answer, ms };
    },
    createAnswer: (answer, ms = 0) => {
      creation = answer;
      creationMs = ms;
    },
    close: async () => {
      for (const response of held)
        response.destroy();
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

// Run by hand: node tests/support/fakeApi.ts [full|empty|down|capped|edge|checked] [port] [milliseconds every read waits] [console origin...]
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [mode = 'full', port = '4010', slow = '0', ...origins] = process.argv.slice(2);
  if (mode !== 'full' && mode !== 'empty' && mode !== 'down' && mode !== 'capped' && mode !== 'edge' && mode !== 'checked')
    throw new Error('The mode is full, empty, down, capped, edge or checked');
  const api = await startFakeApi(mode, Number(port), Number(slow), origins);
  process.stdout.write(`The fake API answers in ${mode} mode at ${api.url}\n`);
  process.on('SIGTERM', () => void api.close().then(() => process.exit(0)));
  process.on('SIGINT', () => void api.close().then(() => process.exit(0)));
}
