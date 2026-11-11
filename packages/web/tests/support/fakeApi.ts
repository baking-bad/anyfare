import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

import type { Call, CallsPage, DailyPoint, LiveStats, PaidWith, Period, ServiceRow, ServicesPage, Stats, TopStats } from '../../src/api/types';

// A small HTTP server that answers the public read API's endpoints with sample data, for the website's
// tests and for looking at the site by hand. The data is sample data: hosts are example.com, the payer
// is sample.near, and every time is today or counted back from it.
//
// Modes:
// - full: a database with calls, services and stats
// - empty: an empty database: zeros, empty lists, status 200
// - down: every request answers 500
//
// A page that reads a new endpoint adds its answer to `answer` below, built from `sample`.
//
// By hand: `node tests/support/fakeApi.ts full 4010`. Calls made while it runs are pushed to the
// streams: `POST /_test/call` with a call as JSON, or with no body for a sample call.

export type FakeApiMode = 'full' | 'empty' | 'down';

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

const serviceRows = (empty: boolean): readonly ServiceRow[] => empty ? [] : hosts.map((host, index) => ({
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
}));

const callsOf = (now: number, empty: boolean): readonly Call[] => empty ? [] : Array.from({ length: 60 }, (_, index) => sampleCall(index, now));

const intParam = (value: string | null, fallback: number, max: number): number => {
  const parsed = Number(value);

  return Number.isInteger(parsed) && parsed >= 1 ? Math.min(parsed, max) : fallback;
};

/** Whether a call passes the filters of a list or a stream: `paidWith`, `service` (a part of the host), `endpoint` and `status`. */
export const matchesCall = (call: Call, params: URLSearchParams): boolean => {
  const paidWith = params.get('paidWith');
  const service = params.get('service');
  const endpoint = params.get('endpoint');
  const status = params.get('status');

  return (paidWith === null || paidWith === call.paidWith)
    && (service === null || call.service.toLowerCase().includes(service.toLowerCase()))
    && (endpoint === null || endpoint === call.path)
    && (status === null || status === call.status);
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
  if (pathname === '/v1/calls') {
    const size = intParam(searchParams.get('size'), 20, 100);
    const page = intParam(searchParams.get('page'), 1, 1000);
    const all = callsOf(now, empty).filter(call => matchesCall(call, searchParams));
    const body: CallsPage = { calls: all.slice((page - 1) * size, page * size), page, size, total: all.length, totalCapped: false };

    return { status: 200, body };
  }
  if (pathname === '/v1/services') {
    const size = intParam(searchParams.get('size'), 20, 100);
    const page = intParam(searchParams.get('page'), 1, 1000);
    const rows = [...serviceRows(empty)];
    const sort = searchParams.get('sort') ?? 'calls';
    if (sort === 'buyers')
      rows.sort((a, b) => b.buyers - a.buyers);
    else if (sort === 'price')
      rows.sort((a, b) => Number(a.priceFrom) - Number(b.priceFrom));
    else
      rows.sort((a, b) => b.calls - a.calls);
    const body: ServicesPage = {
      services: rows.slice((page - 1) * size, page * size),
      page,
      size,
      total: rows.length,
      totals: { services: rows.length, paidEndpoints: rows.reduce((sum, row) => sum + row.paidEndpoints, 0), calls30d: rows.reduce((sum, row) => sum + row.calls, 0) },
      updatedAt: empty ? null : new Date(now - 60_000).toISOString(),
    };

    return { status: 200, body };
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
    if (found === undefined)
      json(response, 404, { error: { code: 'not_found', message: 'Not found' } });
    else
      json(response, found.status, found.body);
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

// Run by hand: node tests/support/fakeApi.ts [full|empty|down] [port]
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [mode = 'full', port = '4010'] = process.argv.slice(2);
  if (mode !== 'full' && mode !== 'empty' && mode !== 'down')
    throw new Error('The mode is full, empty or down');
  const api = await startFakeApi(mode, Number(port));
  process.stdout.write(`The fake API answers in ${mode} mode at ${api.url}\n`);
  process.on('SIGTERM', () => void api.close().then(() => process.exit(0)));
  process.on('SIGINT', () => void api.close().then(() => process.exit(0)));
}
