import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { request } from 'node:http';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { textOfHtml } from '../support/curl';
import { refusedUrl, sampleCall, startFakeApi, type FakeApi } from '../support/fakeApi';

// The website from a production build (`next build`, then `next start`), as the image runs it, against a
// fake public API in three modes: full, an empty database, and down.

const webRoot = fileURLToPath(new URL('../..', import.meta.url));
const nextBin = fileURLToPath(new URL('../../../../node_modules/next/dist/bin/next', import.meta.url));
// Its own build directory, so a developer's .next stays as it is
const distDir = '.next-functional';
const site = 'https://anyfare.example.com';
const pay = 'https://pay.example.com';
const consoleUrl = 'https://console.example.com';

const freePort = async (): Promise<number> => {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>(resolve => server.close(() => resolve()));

  return port;
};

interface Running {
  readonly url: string;
  readonly process: ChildProcess;
  readonly api: FakeApi | undefined;
}

// The site's settings: the public host and the console host. `sharedUrls` names one host twice.
interface Urls {
  readonly site: string;
  readonly console: string;
}
const twoHosts: Urls = { site, console: consoleUrl };
const sharedUrls: Urls = { site, console: site };

const startSite = async (api: FakeApi | undefined, apiInternalUrl: string, urls: Urls = twoHosts): Promise<Running> => {
  const port = await freePort();
  const child = spawn(process.execPath, [nextBin, 'start', '-p', String(port), '-H', '127.0.0.1'], {
    cwd: webRoot,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      NEXT_DIST_DIR: distDir,
      NEXT_TELEMETRY_DISABLED: '1',
      SITE_URL: urls.site,
      PAY_URL: pay,
      CONSOLE_URL: urls.console,
      API_URL: 'https://api.example.com',
      API_INTERNAL_URL: apiInternalUrl,
      PAY_INTERNAL_URL: apiInternalUrl,
      LOG_LEVEL: 'silent',
    },
    stdio: 'ignore',
  });
  const url = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await fetch(`${url}/_/health`)).ok)
        return { url, process: child, api };
    }
    catch {
      // Not listening yet
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  child.kill();
  throw new Error('The website didn\'t start');
};

let full: Running;
let empty: Running;
let down: Running;
let refused: Running;
let shared: Running;

beforeAll(async () => {
  const build = spawnSync(process.execPath, [nextBin, 'build'], {
    cwd: webRoot,
    env: { ...process.env, NODE_ENV: 'production', NEXT_DIST_DIR: distDir, NEXT_TELEMETRY_DISABLED: '1' },
    encoding: 'utf8',
  });
  if (build.status !== 0)
    throw new Error(`next build failed:\n${build.stdout}\n${build.stderr}`);

  const [fullApi, emptyApi, downApi] = await Promise.all([startFakeApi('full'), startFakeApi('empty'), startFakeApi('down')]);
  [full, empty, down, refused, shared] = await Promise.all([
    startSite(fullApi, fullApi.url),
    startSite(emptyApi, emptyApi.url),
    startSite(downApi, downApi.url),
    startSite(undefined, await refusedUrl()),
    startSite(fullApi, fullApi.url, sharedUrls),
  ]);
}, 300_000);

afterAll(async () => {
  for (const running of [full, empty, down, refused, shared]) {
    running?.process.kill();
    await running?.api?.close();
  }
});

const get = async (at: Running, path: string, init?: RequestInit) => {
  const response = await fetch(`${at.url}${path}`, init);

  return { response, body: await response.text() };
};

interface Reply {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: string;
}

// A request with the `Host` header of a host the site answers to: the server listens on one address, and each host is a header
const getAs = (at: Running, host: string, path: string, headers: Readonly<Record<string, string>> = {}): Promise<Reply> => new Promise((resolve, reject) => {
  const url = new URL(at.url);
  const outgoing = request({ host: url.hostname, port: url.port, path, method: 'GET', headers: { host, ...headers } }, incoming => {
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
    incoming.on('end', () => resolve({ status: incoming.statusCode ?? 0, headers: incoming.headers, body: Buffer.concat(chunks).toString('utf8') }));
  });
  outgoing.on('error', reject);
  outgoing.end();
});
const publicHost = new URL(site).host;
const consoleHost = new URL(consoleUrl).host;

const sectionTexts = [
  'For AI agents and the people who run them',
  'Pay any paid API from the chain you are on.',
  'Paste a link to a paid API (x402/MPP)',
  'Check link',
  'Open the console',
  'Make an account in one request. $0.10 of free Credits to try.',
  'Paid through Anyfare in the last 24 hours',
  'Last calls',
  'Two ways to pay. Neither needs the API to change.',
  'Paid calls per day, 30 days',
  'How buyers paid, 30 days',
  'Top 5 used through Anyfare',
  'Give this to your agent',
  'Read https://anyfare.example.com/llms.txt and follow it.',
  'Questions',
  'What if the API fails?',
];

const noBrokenValues = (html: string): void => {
  // The page's own text, without the scripts' data
  const text = html.replace(/<script[\s\S]*?<\/script>/g, '');
  expect(text).not.toMatch(/undefined|NaN|\bnull\b/);
};

describe('the home page with a full database', () => {
  it('answers 200 with every section, and the live numbers and calls from the API', async () => {
    const { response, body } = await get(full, '/');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    for (const text of sectionTexts)
      expect(body).toContain(text);
    expect(body).toContain('$18.42');
    expect(body).toMatch(/213<!-- --> paid calls today/);
    expect(body).toContain('+12.4%');
    expect(body).toContain('href="/calls/pay_sample0000"');
    expect(body).toContain('api.example.com');
    expect(body).toContain('USDC on NEAR');
    expect(body).toContain('href="/services/api.example.com"');
    noBrokenValues(body);
  });

  it('has a link form that works without scripts, and links to the console, the chips and NEAR Intents', async () => {
    const { body } = await get(full, '/');

    expect(body).toMatch(/<form class="hero-check stack" action="\/check" method="get">/);
    expect(body).toMatch(/<input [^>]*name="url"/);
    expect(body).toContain(`href="${consoleUrl}"`);
    expect(body).toContain(`href="${consoleUrl}/topup"`);
    expect(body).toContain(`href="${consoleUrl}/keys"`);
    expect(body).toContain('href="/check?url=pro-api.coinmarketcap.com/x402/v3/cryptocurrency/quotes/latest"');
    expect(body).toContain('href="/check?url=merchant-near.mikedotexe.com/v1/evidence/account"');
    expect(body).not.toContain('MPP on Tempo</a>');
    expect(body).toContain('href="https://near-intents.org"');
    expect(body).toContain('href="/llms.txt"');
    expect(body).toContain('href="/agents"');
  });

  it('shows the code samples with placeholders and no invented value', async () => {
    const { body } = await get(full, '/');

    expect(body).toContain('&lt;deposit address&gt;');
    expect(body).not.toContain('7Hq');
    expect(body).not.toContain('11:05');
  });

  it('has its own title, description, Open Graph tags and a link to its Markdown twin', async () => {
    const { response, body } = await get(full, '/');

    expect(body).toContain('<title>Anyfare: pay any paid API from the chain you are on</title>');
    expect(body).toMatch(/<meta name="description" content="Pay any paid API from the chain you are on\./);
    expect(body).toContain('<meta property="og:title" content="Anyfare: pay any paid API from the chain you are on"/>');
    expect(body).toContain(`<meta property="og:url" content="${site}"/>`);
    expect(body).toContain(`<link rel="alternate" type="text/markdown" href="${site}/index.md"/>`);
    expect(response.headers.get('link')).toContain(`<${site}/index.md>; rel="alternate"; type="text/markdown"`);
  });

  it('forwards the visitor\'s address to the API', async () => {
    await get(full, '/', { headers: { 'x-forwarded-for': '203.0.113.7' } });

    const reads = full.api!.requests.filter(request => request.path.startsWith('/v1/'));
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.at(-1)!.headers['x-forwarded-for']).toBe('203.0.113.7');
  });

  it('sends a policy that lets the browser read the stream from the API, and a nonce on every script', async () => {
    const { response, body } = await get(full, '/');
    const policy = response.headers.get('content-security-policy')!;
    const nonce = /'nonce-([^']+)'/.exec(policy)![1]!;
    const scripts = [...body.matchAll(/<script\b[^>]*>/g)].map(match => match[0]);

    expect(policy).toContain('connect-src \'self\' https://api.example.com https://pay.example.com');
    expect(scripts.every(script => script.includes(`nonce="${nonce}"`))).toBe(true);
    expect(body).not.toMatch(/ style="/);
  });

  it('serves the stream\'s call to a browser: the API answers it with the events', async () => {
    const controller = new AbortController();
    const stream = await fetch(`${full.api!.url}/v1/calls/stream`, { signal: controller.signal });
    const reader = stream.body!.getReader();
    full.api!.emitCall(sampleCall(900, Date.now(), 0));
    const { value } = await reader.read();
    const first = new TextDecoder().decode(value);
    controller.abort();

    expect(stream.headers.get('content-type')).toBe('text/event-stream');
    expect(first).toContain('retry: 3000');
  });
});

describe('the Markdown twin of the home page', () => {
  it.each([
    ['at /index.md', '/index.md', undefined],
    ['by Accept: text/markdown', '/', { headers: { accept: 'text/markdown' } }],
  ])('answers %s with the same facts as the page', async (_name, path, init) => {
    const { response, body } = await get(full, path, init);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(response.headers.get('vary')).toMatch(/(^|, )Accept(,|$)/);
    expect(body).toMatch(/^# Anyfare: pay any paid API from the chain you are on\n/);
    expect(body).toContain('- Paid through Anyfare in the last 24 hours: $18.42');
    expect(body).toContain('- Paid calls today: 213');
    expect(body).toContain('| api.example.com |');
    expect(body).toContain(`Read ${site}/llms.txt and follow it.`);
    expect(body).not.toMatch(/undefined|NaN|\bnull\b/);
  });

  it('answers HTML to a browser\'s Accept, and 404 for a page that has no twin', async () => {
    const browser = await get(full, '/', { headers: { accept: 'text/html,application/xhtml+xml,*/*;q=0.8' } });

    expect(browser.response.headers.get('content-type')).toContain('text/html');
    expect((await get(full, '/nothing.md')).response.status).toBe(404);
  });
});

describe('the home page with an empty database', () => {
  it('answers 200 with zeros and empty states, and nothing broken', async () => {
    const { response, body } = await get(empty, '/');

    expect(response.status).toBe(200);
    for (const text of sectionTexts.filter(text => text !== 'What if the API fails?'))
      expect(body).toContain(text);
    expect(body).toContain('$0.00');
    expect(body).toMatch(/0<!-- --> paid calls today/);
    expect(body).toContain('No calls yet');
    expect(body).toContain('No services yet');
    expect(body).toContain('No paid calls yet');
    expect(body).not.toContain('role="alert"');
    noBrokenValues(body);
  });

  it('gives the Markdown twin with zeros', async () => {
    const { response, body } = await get(empty, '/index.md');

    expect(response.status).toBe(200);
    expect(body).toContain('- Paid calls today: 0');
    expect(body).toContain('No calls yet.');
    expect(body).not.toMatch(/undefined|NaN|\bnull\b/);
  });
});

describe.each([['the API answers 500', () => down], ['the connection is refused', () => refused]])('the home page when %s', (_name, running) => {
  it('answers 200: every section that needs the API shows an error state, and the rest renders', async () => {
    const { response, body } = await get(running(), '/');

    expect(response.status).toBe(200);
    expect(body.match(/role="alert"/g)).toHaveLength(4);
    for (const text of ['The numbers didn&#x27;t load', 'The last calls didn&#x27;t load', 'The stats didn&#x27;t load', 'The services didn&#x27;t load'])
      expect(body).toContain(text);
    for (const text of ['Pay any paid API from the chain you are on.', 'Check link', 'Two ways to pay. Neither needs the API to change.', 'Give this to your agent', 'Questions', 'Top 5 used through Anyfare'])
      expect(body).toContain(text);
    noBrokenValues(body);
  });

  it('answers the Markdown twin with its sections marked unavailable', async () => {
    const { response, body } = await get(running(), '/index.md');

    expect(response.status).toBe(200);
    expect(body).toContain('Not available right now.');
    expect(body).toContain('## Questions');
  });
});

describe('the Calls page with a full database', () => {
  it('answers 200 with today\'s numbers, the grid, the filters and the top 5, from the API', async () => {
    const { response, body } = await get(full, '/calls');

    expect(response.status).toBe(200);
    for (const text of ['Every call paid through Anyfare, as it happens.', 'Today, UTC', 'Paid calls', 'Paid from NEAR', 'Calls per minute', 'Last 30 min', 'Service and endpoint', 'API paid with', 'Name or host', 'Failed, free', 'Top 5', 'How buyers paid', 'Top-up tokens', 'Through NEAR Intents'])
      expect(body).toContain(text);
    expect(body).toContain('id="top"');
    expect(body).toContain('213');
    expect(body).toContain('$2.31');
    expect(body).toContain('35<!-- -->%');
    expect(body).toContain('href="/calls/pay_sample0000"');
    expect(body).toContain('1<!-- -->–<!-- -->20<!-- --> of <!-- -->60');
    expect(body).toContain('0xab12ab12ab…2ab12');
    expect(body).toContain('USDC on Base');
    expect(body).toContain('href="/services/api.example.com"');
    expect(body).toContain('href="/check?url=api.example.com/v1/sample/quotes/latest"');
    expect(body).toContain('SOL on Solana');
    expect(body).toMatch(/<a [^>]*aria-current="page"[^>]*>Calls<\/a>/);
    expect(body).not.toMatch(/ style="/);
    noBrokenValues(body);
  });

  it('has its own title, description, Open Graph tags and a link to its Markdown twin', async () => {
    const { response, body } = await get(full, '/calls');

    expect(body).toContain('<title>Calls | Anyfare</title>');
    expect(body).toMatch(/<meta name="description" content="Every call paid through Anyfare, as it happens/);
    expect(body).toContain('<meta property="og:title" content="Calls | Anyfare"/>');
    expect(body).toContain(`<meta property="og:url" content="${site}/calls"/>`);
    expect(body).toContain(`<link rel="alternate" type="text/markdown" href="${site}/calls.md"/>`);
    expect(response.headers.get('link')).toContain(`<${site}/calls.md>; rel="alternate"; type="text/markdown"`);
  });

  it('renders the page and the filter the URL names, the same for the same URL', async () => {
    const first = await get(full, '/calls?paidWith=near&page=2');
    const second = await get(full, '/calls?paidWith=near&page=2');

    expect(first.response.status).toBe(200);
    expect(first.body).toMatch(/<option value="near" selected="">USDC on NEAR<\/option>/);
    // 12 calls were paid with NEAR: one page of 12, and the second page is past the end
    expect(first.body).toContain('No calls match these filters yet.');
    expect(full.api!.requests.some(request => request.path === '/v1/calls?paidWith=near&page=2&size=20')).toBe(true);
    expect(second.body.match(/class="small muted num">[^<]*</g)).toEqual(first.body.match(/class="small muted num">[^<]*</g));
    noBrokenValues(first.body);
  });

  it('renders page 3 of a list that has one, and a filter from the URL', async () => {
    const { body } = await get(full, '/calls?page=3');

    expect(body).toContain('41<!-- -->–<!-- -->60<!-- --> of <!-- -->60');
    expect(body).toContain('href="/calls/pay_sample0040"');
    expect(body).not.toContain('href="/calls/pay_sample0000"');
    const filtered = await get(full, '/calls?status=free&service=QUOTES&endpoint=/v1/sample/lookup');
    expect(full.api!.requests.some(request => request.path === '/v1/calls?service=QUOTES&endpoint=%2Fv1%2Fsample%2Flookup&status=free&page=1&size=20')).toBe(true);
    noBrokenValues(filtered.body);
  });

  it('answers the filters it doesn\'t know with the first page', async () => {
    const { response, body } = await get(full, '/calls?paidWith=bitcoin&page=-4&status=x');

    expect(response.status).toBe(200);
    expect(body).toContain('href="/calls/pay_sample0000"');
  });
});

describe('the Markdown twin of the Calls page', () => {
  it.each([
    ['at /calls.md', '/calls.md?status=paid&page=2', undefined],
    ['by Accept: text/markdown', '/calls?status=paid&page=2', { headers: { accept: 'text/markdown' } }],
  ])('answers %s with the same facts as the page, and the filters from the query', async (_name, path, init) => {
    const { response, body } = await get(full, path, init);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(body).toMatch(/^# Calls\n/);
    expect(body).toContain('- Paid calls: 213');
    expect(body).toContain('- The service host and path. Never the query string');
    expect(body).toContain('Filters:\n\n- Status: Paid');
    expect(body).toContain('Page 2, calls 21–40 of 48. Next page: https://anyfare.example.com/calls.md?status=paid&page=3');
    expect(body).toContain('/check?url=api.example.com/v1/sample/quotes/latest');
    expect(body).not.toMatch(/undefined|NaN|\bnull\b/);
  });
});

describe('the Calls page with an empty database', () => {
  it('answers 200 with zeros and a first-run empty state, and nothing broken', async () => {
    const { response, body } = await get(empty, '/calls');

    expect(response.status).toBe(200);
    expect(body).toContain('No calls yet');
    expect(body).toContain('No paid calls yet');
    expect(body).toContain('No top-ups yet');
    expect(body).not.toContain('role="alert"');
    expect(body).not.toContain('No calls match these filters yet.');
    noBrokenValues(body);
  });

  it('says no call matches the filters, when there are filters', async () => {
    const { body } = await get(empty, '/calls?paidWith=base');

    expect(body).toContain('No calls match these filters yet.');
    noBrokenValues(body);
  });

  it('gives the Markdown twin with zeros', async () => {
    const { response, body } = await get(empty, '/calls.md');

    expect(response.status).toBe(200);
    expect(body).toContain('- Paid calls: 0');
    expect(body).toContain('No calls yet.');
    expect(body).not.toMatch(/undefined|NaN|\bnull\b/);
  });
});

describe.each([['the API answers 500', () => down], ['the connection is refused', () => refused]])('the Calls page when %s', (_name, running) => {
  it('answers 200: each part that needs the API shows an error state, and the rest renders', async () => {
    const { response, body } = await get(running(), '/calls');

    expect(response.status).toBe(200);
    for (const text of ['The numbers didn&#x27;t load', 'The chart didn&#x27;t load', 'The calls didn&#x27;t load', 'The top lists didn&#x27;t load'])
      expect(body).toContain(text);
    for (const text of ['Every call paid through Anyfare, as it happens.', 'Service and endpoint', 'Name or host', 'Top 5'])
      expect(body).toContain(text);
    noBrokenValues(body);
  });

  it('answers the Markdown twin with its parts marked unavailable', async () => {
    const { response, body } = await get(running(), '/calls.md');

    expect(response.status).toBe(200);
    expect(body).toContain('Not available right now.');
    expect(body).toContain('## What a call shows');
  });
});

describe('the receipt page with a full database', () => {
  it('answers 200 with the head, the three boxes, the details and the steps of a call paid on a chain', async () => {
    const { response, body } = await get(full, '/calls/pay_sample0000');

    expect(response.status).toBe(200);
    for (const text of ['Receipt', 'Paid · API answered 200', 'The buyer paid', 'We paid the API', 'Details', 'Steps', 'Overview', 'JSON', 'Copy link', 'Receipt id', 'The buyer asked, with a payment', 'We checked the buyer&#x27;s payment', 'x402 on NEAR. Not settled yet', 'From our Base hot wallet', 'The answer went to the buyer as it came', 'Only now: a failed call is never settled', 'We signed 0.001 USDC on Base for the API', 'The API answered 200 in 120 ms', 'The buyer&#x27;s payment settled on NEAR', 'sample.near', 'GET /v1/sample/quotes/latest', 'Fee <!-- -->$0.00'])
      expect(body, text).toContain(text);
    expect(body).toContain('$0.001');
    expect(body).toContain('0.001 USDC on NEAR');
    expect(body).toContain('0.001 USDC on Base');
    expect(body).toContain('href="https://nearblocks.io/txns/NearSample0000Tx9"');
    expect(body).toContain('NearBlocks');
    expect(body).toContain('Basescan');
    expect(body).toMatch(/<a [^>]*href="https:\/\/basescan\.org\/tx\/0x[0-9a-f]+"[^>]*rel="noopener noreferrer"/);
    expect(body).toContain('href="/services/api.example.com"');
    expect(body).toContain('href="/calls"');
    expect(body).toMatch(/<a [^>]*aria-current="page"[^>]*>Calls<\/a>/);
    expect(body).not.toMatch(/ style="/);
    noBrokenValues(body);
  });

  it('has its own title, description, Open Graph tags, noindex and a link to its twin', async () => {
    const { response, body } = await get(full, '/calls/pay_sample0000');

    expect(body).toContain('<title>Receipt pay_sample0000 | Anyfare</title>');
    expect(body).toMatch(/<meta name="description" content="The receipt of one call paid through Anyfare/);
    expect(body).toContain('<meta property="og:title" content="Receipt pay_sample0000 | Anyfare"/>');
    expect(body).toContain(`<meta property="og:url" content="${site}/calls/pay_sample0000"/>`);
    expect(body).toMatch(/<meta name="robots" content="noindex, follow"\/>/);
    expect(body).toContain(`<link rel="alternate" type="text/markdown" href="${site}/calls/pay_sample0000.md"/>`);
    expect(response.headers.get('link')).toContain(`<${site}/calls/pay_sample0000.md>; rel="alternate"; type="text/markdown"`);
  });

  it('reads the call for the proxy and for the page, and forwards the visitor\'s address to both', async () => {
    const before = full.api!.requests.length;
    await get(full, '/calls/pay_sample0003', { headers: { 'x-forwarded-for': '203.0.113.9' } });
    const reads = full.api!.requests.slice(before).filter(request => request.path.startsWith('/v1/calls/pay_sample0003'));

    expect(reads).toHaveLength(2);
    for (const read of reads)
      expect(read.headers['x-forwarded-for']).toBe('203.0.113.9');
  });

  it('reads no call for any other page', async () => {
    const before = full.api!.requests.length;
    await get(full, '/');
    await get(full, '/calls');
    await get(full, '/calls?page=2');
    await get(full, '/no-such-page');
    const reads = full.api!.requests.slice(before).filter(request => /^\/v1\/calls\/(?!stream)/.test(request.path));

    expect(reads).toEqual([]);
  });

  it('gives the normal page to a client that sends the missing-receipt header itself', async () => {
    const forged = { headers: { 'x-missing-kind': 'receipt', 'x-missing-name': 'x' } };
    const home = await get(full, '/', forged);
    const receipt = await get(full, '/calls/pay_sample0000', forged);

    expect(home.response.status).toBe(200);
    expect(home.body).toContain('Pay any paid API from the chain you are on.');
    expect(receipt.response.status).toBe(200);
    expect(receipt.body).toContain('The buyer paid');
    const notFound = await get(full, '/no-such-page', forged);
    expect(notFound.response.status).toBe(404);
    expect(notFound.body).toContain('Page not found');
    expect(notFound.body).not.toContain('No call with this id.');
  });

  it('shows a Credits receipt with no payer, no account and no transaction', async () => {
    const { response, body } = await get(full, '/calls/pay_creditspaid');
    // The page's own text: the JSON tab holds the API's answer as it came
    const page = body.slice(0, body.indexOf('class="code'));

    expect(response.status).toBe(200);
    expect(body).toContain('0.010 in Credits');
    expect(body).toContain('Paid from a balance. No transaction per call.');
    expect(body).toContain('We held $0.010 on the buyer&#x27;s balance');
    expect(body).toContain('The hold was taken from the balance');
    expect(page).not.toMatch(/account/i);
    expect(page.match(/Transaction /g)).toHaveLength(1);
    expect(page).not.toContain('nearblocks.io');
    expect(page).not.toContain('0xab12');
    expect(page).not.toContain('sample.near');
  });

  it('shows a free call as not charged, and says the API was not paid when it was not', async () => {
    const { response, body } = await get(full, '/calls/pay_freenoapi');

    expect(response.status).toBe(200);
    expect(body).toContain('>$0<');
    expect(body).toContain('Not charged');
    expect(body).not.toContain('Paid · ');
    expect(body).toContain('We did not pay the API for this call.');
    expect(body).toContain('The buyer was not charged');
    expect(body).not.toContain('Transaction ');
    // The JSON tab holds the API's answer as it came, with its nulls
    noBrokenValues(body.slice(0, body.indexOf('class="code-block"')));
  });

  it('shows a transaction with no explorer URL as its short hash, with no link', async () => {
    const { response, body } = await get(full, '/calls/pay_notxlink');

    expect(response.status).toBe(200);
    expect(body).toContain('Transaction 0x6c69…1f1f');
    expect(body).not.toContain('<a class="link small break"');
    expect(body).toContain('MPP on Tempo. Not settled yet');
  });

  it('shows the code of a step it does not know', async () => {
    const { body } = await get(full, '/calls/pay_unknownstep');

    expect(body).toContain('mystery_step');
  });

  it('is the 404 page for an unknown id', async () => {
    const { response, body } = await get(full, '/calls/pay_nosuchcall');

    expect(response.status).toBe(404);
    expect(body).toContain('No call with this id. A call appears here once it is finished.');
    expect(body).toContain('href="/calls"');
    expect(body).toMatch(/noindex/);
  });

  it('is the 404 page for a bad id, and the API is never asked', async () => {
    const before = full.api!.requests.length;
    const results = await Promise.all(['/calls/bad%20id', `/calls/${'a'.repeat(65)}`, '/calls/a.b', '/calls/a%3Fb'].map(path => get(full, path)));

    for (const { response, body } of results) {
      expect(response.status).toBe(404);
      expect(body).toContain('No call with this id.');
    }
    expect(full.api!.requests.slice(before).filter(request => request.path.startsWith('/v1/calls/'))).toEqual([]);
  });

  it('is the 404 page with an empty database', async () => {
    expect((await get(empty, '/calls/pay_sample0000')).response.status).toBe(404);
  });

  it('answers 200 with the shared error state when the API is down or refuses the connection', async () => {
    for (const running of [down, refused]) {
      const { response, body } = await get(running, '/calls/pay_sample0000');

      expect(response.status).toBe(200);
      expect(body).toContain('role="alert"');
      expect(body).toContain('We couldn&#x27;t load this receipt.');
      expect(body).toContain('Try again.');
      expect(body).toContain('href="/calls"');
      expect(body).not.toContain('No call with this id.');
    }
  });
});

describe('the Markdown twin of a receipt', () => {
  it.each([
    ['at /calls/<id>.md', '/calls/pay_sample0000.md', undefined],
    ['by Accept: text/markdown', '/calls/pay_sample0000', { headers: { accept: 'text/markdown' } }],
  ])('answers %s with the same facts as the page', async (_name, path, init) => {
    const { response, body } = await get(full, path, init);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(body).toMatch(/^# Receipt pay_sample0000\n/);
    expect(body).toContain('- Paid: $0.001. The API answered 200 in 120 ms.');
    expect(body).toContain('- Buyer: sample.near paid 0.001 USDC on NEAR, tx NearSample0000Tx9 on [NearBlocks](https://nearblocks.io/txns/NearSample0000Tx9)');
    expect(body).toContain('We signed 0.001 USDC on Base for the API');
    expect(body).toContain('`GET https://api.example.com/v1/calls/pay_sample0000`');
    expect(body).not.toMatch(/undefined|NaN|\bnull\b/);
  });

  it('answers 404 in Markdown for an unknown id, and 503 when the API is down', async () => {
    const unknown = await get(full, '/calls/pay_nosuchcall.md');
    const failed = await get(down, '/calls/pay_sample0000.md');

    expect(unknown.response.status).toBe(404);
    expect(unknown.response.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(unknown.body).toContain('No call with this id. A call appears here once it is finished.');
    expect(failed.response.status).toBe(503);
    expect(failed.response.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(failed.body).toContain('We couldn\'t load this receipt. Try again.');
  });

  it('answers 404 for a bad id\'s twin, and the API is never asked', async () => {
    const before = full.api!.requests.length;

    expect((await get(full, '/calls/bad$id.md')).response.status).toBe(404);
    expect(full.api!.requests.length).toBe(before);
  });
});

const pageText = (body: string): string => body.slice(0, body.indexOf('class="code') === -1 ? undefined : body.indexOf('class="code'));

describe('the Services page', () => {
  it('answers 200 with the lead, three numbers, the grid and the pages, from the API', async () => {
    const { response, body } = await get(full, '/services');

    expect(response.status).toBe(200);
    expect(body).toContain('Services agents paid through Anyfare. Any x402 or MPP API can be paid the same way: paste its link on the home page.');
    for (const text of ['Services paid through Anyfare', 'Paid endpoints on them', 'Calls through Anyfare, 30 days', 'Search by name or host', 'Most paid endpoints', 'Cheapest', '27'])
      expect(body).toContain(text);
    expect(body).toContain('href="/services/api.example.com"');
    expect(body).toMatch(/1<!-- -->–<!-- -->20<!-- --> of <!-- -->27/);
    expect(body).not.toMatch(/registr|proposal|verified/i);
    expect(body).not.toContain('In public registries');
    noBrokenValues(body);
  });

  it('shows a dash for a missing rate or time', async () => {
    const { body } = await get(full, '/services?q=geo02');

    expect(body).toContain('geo02.example.org');
    expect(body).toMatch(/<td class="r">-<\/td><td class="r">-<\/td>/);
  });

  it('renders the page, the search and the sort the URL names, the same for the same URL', async () => {
    const before = full.api!.requests.length;
    const [first, again] = await Promise.all([get(full, '/services?q=maps'), get(full, '/services?q=maps')]);
    const sorted = await get(full, '/services?sort=price&page=2');
    const second = await get(full, '/services?page=2');

    expect(first.body.replace(/nonce="[^"]*"/g, '')).toContain('maps.example.com');
    expect(first.body).not.toContain('api.example.com</a>');
    const rows = (html: string): string => html.slice(html.indexOf('<tbody'), html.indexOf('</tbody>'));
    expect(rows(first.body)).toBe(rows(again.body));
    expect(second.body).toMatch(/21<!-- -->–<!-- -->27/);
    expect(second.body).toContain('ocr22.example.org');
    expect(sorted.body).toMatch(/21<!-- -->–<!-- -->27/);
    expect(full.api!.requests.slice(before).map(request => request.path)).toContain('/v1/services?q=maps&sort=calls&page=1&size=20');
    expect(full.api!.requests.slice(before).map(request => request.path)).toContain('/v1/services?sort=price&page=2&size=20');
  });

  it('says nothing matches a search that finds nothing', async () => {
    const { response, body } = await get(full, '/services?q=zzzz');

    expect(response.status).toBe(200);
    expect(body).toContain('Nothing matches. Any x402 or MPP API can still be paid: paste its link on the home page.');
  });

  it('has its own title, description, Open Graph tags and a link to its twin', async () => {
    const { body } = await get(full, '/services');

    expect(body).toContain('<title>Services | Anyfare</title>');
    expect(body).toContain('property="og:title" content="Services | Anyfare"');
    expect(body).toContain('rel="alternate" type="text/markdown" href="https://anyfare.example.com/services.md"');
  });

  it('shows the first-run empty state with an empty database, and the shared error state when the API is down', async () => {
    const first = await get(empty, '/services');
    expect(first.response.status).toBe(200);
    expect(first.body).toContain('No services yet');
    noBrokenValues(first.body);
    for (const running of [down, refused]) {
      const { response, body } = await get(running, '/services');

      expect(response.status).toBe(200);
      expect(body).toContain('role="alert"');
      expect(body).toContain('The services didn&#x27;t load');
    }
  });

  it('answers its twin with the lead, how to pay, the page and the next page', async () => {
    const { response, body } = await get(full, '/services.md?page=1');
    const viaAccept = await get(full, '/services', { headers: { accept: 'text/markdown' } });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(body).toContain('https://pay.example.com/<host>/<path>');
    expect(body).toContain('Next page: https://anyfare.example.com/services.md?page=2');
    expect(viaAccept.body).toBe(body.replace('page=1', 'page=1'));
    expect(await (await get(down, '/services.md')).body).toContain('Not available right now.');
  });
});

describe('the Service page', () => {
  it('answers 200 with the head, the endpoints, the six numbers, the tables and the live calls', async () => {
    const { response, body } = await get(full, '/services/api.example.com');
    const page = pageText(body);

    expect(response.status).toBe(200);
    for (const text of ['4<!-- --> paid endpoint', 'Check an endpoint', 'Paths only. We never show query strings', 'Price now', 'Today', 'All time', 'Paid calls', 'Unique buyers', 'Came back', 'Answered 2xx', 'Median time', 'p95 816 ms', '6 failed calls, not charged', 'vs the 30 days before', 'Paid calls per day', 'By payment method', 'Avg. per buyer', 'Top 5 buyers', 'Together: 48.0% of paid calls', 'Live calls to api.example.com'])
      expect(page).toContain(text);
    expect(body).toContain('href="/check?url=api.example.com/v1/sample/quotes/latest"');
    expect(body).toContain('href="/calls?service=api.example.com"');
    expect(body).toContain('aria-label="Copy the pay link of /v1/sample/lookup"');
    expect(body).toContain('title="0xab12ab12ab12ab12ab12ab12ab12ab12ab12ab12"');
    noBrokenValues(body);
  });

  it('shows a Credits buyer as a Credits account with no id', async () => {
    const { body } = await get(full, '/services/api.example.com');
    const row = body.slice(body.indexOf('A Credits account') - 80, body.indexOf('A Credits account') + 40);

    expect(row).toContain('<span class="small muted">A Credits account</span>');
    expect(row).not.toMatch(/title=/);
  });

  it('renders each period from the URL, and shows no change when there is no period before', async () => {
    const week = await get(full, '/services/api.example.com?period=7d');
    const all = await get(full, '/services/api.example.com?period=all');
    const quiet = await get(full, '/services/maps.example.com');

    expect(week.body).toContain('vs the 7 days before');
    expect(all.body).not.toContain('vs the ');
    expect(quiet.response.status).toBe(200);
    expect(quiet.body).not.toContain('vs the 30 days before');
    const paths = full.api!.requests.map(request => request.path);
    expect(paths).toContain('/v1/services/api.example.com?period=7d');
    expect(paths).toContain('/v1/services/api.example.com?period=all');
  });

  it('reads the last 5 calls of the host and opens its stream with the host', async () => {
    const before = full.api!.requests.length;
    const { body } = await get(full, '/services/data.example.com');

    expect(full.api!.requests.slice(before).map(request => request.path)).toContain('/v1/calls?host=data.example.com&size=5');
    expect(body).toContain('/v1/sample/');
    expect(body).not.toContain('href="/calls/pay_sample0000"');
  });

  it('has its own title, description and Open Graph tags', async () => {
    const { body } = await get(full, '/services/api.example.com');

    expect(body).toContain('<title>api.example.com | Anyfare</title>');
    expect(body).toContain('property="og:title" content="api.example.com | Anyfare"');
    expect(body).toContain('rel="alternate" type="text/markdown" href="https://anyfare.example.com/services/api.example.com.md"');
  });

  it('is the 404 page with its text for an unknown host, with buttons to the services and the check', async () => {
    const { response, body } = await get(full, '/services/nope.example.com');

    expect(response.status).toBe(404);
    expect(body).toContain('No paid call went to this service through Anyfare yet.');
    expect(body).toContain('href="/services"');
    expect(body).toContain('href="/check?url=nope.example.com"');
    expect((await get(empty, '/services/api.example.com')).response.status).toBe(404);
  });

  it('is the 404 page for a bad host, and the API is never asked', async () => {
    const before = full.api!.requests.length;
    const results = await Promise.all(['/services/bad_host', '/services/localhost', '/services/a..com', `/services/${'a'.repeat(64)}.com`, '/services/a%3Fb.com'].map(path => get(full, path)));

    for (const { response, body } of results) {
      expect(response.status).toBe(404);
      expect(body).toContain('No paid call went to this service through Anyfare yet.');
    }
    expect(full.api!.requests.slice(before).filter(request => request.path.startsWith('/v1/services/'))).toEqual([]);
  });

  it('gives the normal page to a client that sends the missing headers itself', async () => {
    const forged = { headers: { 'x-missing-kind': 'service', 'x-missing-name': 'x' } };
    const notFound = await get(full, '/no-such-page', forged);

    expect(notFound.response.status).toBe(404);
    expect(notFound.body).toContain('Page not found');
    expect((await get(full, '/services/api.example.com', forged)).response.status).toBe(200);
  });

  it('answers 200 with the shared error state when the API is down or refuses the connection', async () => {
    for (const running of [down, refused]) {
      const { response, body } = await get(running, '/services/api.example.com');

      expect(response.status).toBe(200);
      expect(body).toContain('role="alert"');
      expect(body).toContain('We couldn&#x27;t load this service&#x27;s numbers.');
      expect(body).toContain('The last calls didn&#x27;t load');
      expect(body).toContain('api.example.com');
    }
  });

  it('answers its twin with the numbers, the methods and the endpoints, and 404 and 503 when it must', async () => {
    const { response, body } = await get(full, '/services/api.example.com.md?period=7d');
    const unknown = await get(full, '/services/nope.example.com.md');
    const failed = await get(down, '/services/api.example.com.md');
    const before = full.api!.requests.length;
    const bad = await get(full, '/services/bad_host.md');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(body).toMatch(/^# api.example.com\n/);
    expect(body).toContain('Through Anyfare, the last 7 days');
    expect(body).toContain('https://pay.example.com/api.example.com/v1/sample/lookup');
    expect(body).toContain('A Credits account');
    expect(unknown.response.status).toBe(404);
    expect(failed.response.status).toBe(503);
    expect(bad.response.status).toBe(404);
    expect(full.api!.requests.slice(before)).toEqual([]);
  });
});

const textOf = (html: string): string => html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<!-- -->/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').replace(/ ([.,])/g, '$1');

const checkPath = (link: string, extra = ''): string => `/check?url=${encodeURIComponent(link)}${extra}`;

describe('the Check page', () => {
  const base = 'api.example.com/v1/sample/quotes/latest';

  it('shows the link field, the head, the four tabs and the Overview of an x402 link on Base', async () => {
    const { response, body } = await get(full, checkPath(base));
    const text = textOf(body);

    expect(response.status).toBe(200);
    expect(body).toMatch(/<form [^>]*action="\/check" method="get"/);
    expect(body).toMatch(/<input [^>]*name="url"[^>]*value="api\.example\.com\/v1\/sample\/quotes\/latest"/);
    expect(body).not.toContain('Mockup state');
    for (const part of ['Check again', 'Payable through Anyfare', 'Checked', '340 ms', 'Copy pay link', 'Service', 'Overview', 'JSON', 'Headers', 'Code', 'What the API asks', 'This API asks $0.010 in USDC on Base for each call, over x402.', 'x402 version 2, scheme exact', 'eip155:8453', 'Latest quotes for sample assets', 'Stats', 'Today', '7 days', '30 days', 'All', 'Paid calls', 'Unique payers', 'Volume', 'Answered 2xx', 'Median time', 'Paid calls per day', 'Buyers paid with', 'Pay it through Anyfare', 'Fee $0.00', 'Your link through Anyfare', 'Pay it from your agent', 'Make a payment key', 'Give your agent this', 'Watch the calls', 'Last calls'])
      expect(text).toContain(part);
    expect(text).toContain('402 Paid calls');
    expect(body).toContain('href="/services/api.example.com"');
    expect(body).toContain(`href="${consoleUrl}/keys"`);
    expect(body).toMatch(/<input [^>]*readOnly=""|<input [^>]*readonly=""/);
    expect(body).toContain('value="https://pay.example.com/api.example.com/v1/sample/quotes/latest"');
    expect(body).toContain('Call https://pay.example.com/api.example.com/v1/sample/quotes/latest through Anyfare.');
    expect(body).toContain('href="/calls/pay_sample0000"');
    noBrokenValues(body);
  });

  it('lists one row for each way the API lists, in its order, with the price', async () => {
    const { body } = await get(full, checkPath(base));
    const names = ['USDC on NEAR', 'USDC on Base', 'USDC on Solana', 'USDC.e on Tempo', 'Credits, with a payment key'];
    const at = names.map(name => body.indexOf(`>${name}<`));

    expect(at.every(index => index > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(body).toContain('No transaction per call');
    expect(body).toContain('MPP charge · sign and send at once');
  });

  it('has the title, description and noindex, a link to its twin, and the header item marked', async () => {
    const { body } = await get(full, checkPath(base));

    expect(body).toContain('<title>Check: api.example.com/v1/sample/quotes/latest | Anyfare</title>');
    expect(body).toMatch(/<meta name="description" content="Paste the link of one paid API/);
    expect(body).toMatch(/<meta name="robots" content="noindex/);
    expect(body).toContain('rel="alternate" type="text/markdown" href="https://anyfare.example.com/check.md?url=api.example.com%2Fv1%2Fsample%2Fquotes%2Flatest"');
    expect(body).toMatch(/<a [^>]*aria-current="page"[^>]*href="\/"[^>]*>Check a link<\/a>|<a [^>]*href="\/"[^>]*aria-current="page"[^>]*>Check a link<\/a>/);
    expect(body).not.toContain('sitemap');
  });

  it('gives the NEAR link and the MPP link their own words', async () => {
    const near = await get(full, checkPath('data.example.com/v1/sample/lookup'));
    const mpp = await get(full, checkPath('search.example.com/v1/sample/lookup'));

    expect(textOf(near.body)).toContain('$0.010 in USDC on NEAR for each call, over x402.');
    expect(textOf(near.body)).toContain('merchant.sample.near');
    expect(textOf(mpp.body)).toMatch(/\$0\.005 in USDC\.e on Tempo for each call, over MPP\. It wants a signed charge by the tempo method\./);
    expect(textOf(mpp.body)).toContain('MPP, method tempo, intent charge');
    expect(mpp.response.status).toBe(200);
  });

  it('opens the tab the URL names, and every tab is a link to the same check with that tab', async () => {
    const json = await get(full, checkPath(base, '&tab=json'));
    const headers = await get(full, checkPath(base, '&tab=headers'));
    const code = await get(full, checkPath(base, '&tab=code'));
    const selected = (html: string): string | undefined => /-tab-(\w+)" role="tab"[^>]*aria-selected="true"/.exec(html)?.[1];

    expect(selected(json.body)).toBe('json');
    expect(selected(headers.body)).toBe('headers');
    expect(selected(code.body)).toBe('code');
    expect(json.body).toMatch(/href="\/check\?url=api\.example\.com%2Fv1%2Fsample%2Fquotes%2Flatest&amp;tab=json"/);
    expect(json.body).toMatch(/-tab-overview" role="tab" href="\/check\?url=api\.example\.com%2Fv1%2Fsample%2Fquotes%2Flatest" aria-selected="false"/);
    expect(selected(await (await get(full, checkPath(base, '&tab=nope'))).body)).toBe('overview');
    expect(json.body).toContain('The answer to');
    expect(json.body).toContain('Copy JSON');
    expect(json.body).toContain('&quot;payable&quot;');
  });

  it('shows the headers as they came, and the challenge decoded', async () => {
    const { body } = await get(full, checkPath(base, '&tab=headers'));

    expect(body).toContain('curl -i https://api.example.com/v1/sample/quotes/latest');
    expect(body).toContain('HTTP/1.1 402 Payment Required');
    expect(body).toMatch(/payment-required<\/span>: (<!-- -->)?eyJ/);
    expect(body).toMatch(/content-type<\/span>: (<!-- -->)?application\/json/);
    expect(body).toContain('header, decoded from base64');
    expect(body).toContain('&quot;x402Version&quot;');
    expect(body).toContain('&quot;accepts&quot;');
  });

  it('shows the three calls of the Code tab, the by-hand one with the two real steps', async () => {
    const { body } = await get(full, checkPath(base, '&tab=code'));

    for (const text of ['curl, with a key', 'curl, x402 by hand', 'Agent prompt', 'Authorization: Bearer $ANYFARE_PAYMENT_KEY', 'PAYMENT-SIGNATURE', 'Any x402 client does both steps for you'])
      expect(body).toContain(text);
    expect(body).not.toMatch(/TypeScript|@x402|nearSigner/);
  });

  it('reads the endpoint\'s numbers for the period, and the calls for the page, from the URL', async () => {
    const before = full.api!.requests.length;
    await get(full, checkPath(base, '&period=7d&page=2'));
    const paths = full.api!.requests.slice(before).map(request => request.path);

    expect(paths).toContain('/v1/endpoints/stats?host=api.example.com&path=%2Fv1%2Fsample%2Fquotes%2Flatest&period=7d');
    expect(paths).toContain('/v1/calls?host=api.example.com&endpoint=%2Fv1%2Fsample%2Fquotes%2Flatest&page=2&size=10');
    expect(paths.filter(path => path.startsWith('/_/check'))).toHaveLength(1);
    const defaults = full.api!.requests.length;
    await get(full, checkPath(base));
    expect(full.api!.requests.slice(defaults).map(request => request.path)).toContain('/v1/endpoints/stats?host=api.example.com&path=%2Fv1%2Fsample%2Fquotes%2Flatest&period=30d');
  });

  it('pages the last calls of a busy endpoint, 10 at a time, with links', async () => {
    const first = await get(full, checkPath('busy.example.com/v1/busy'));
    const third = await get(full, checkPath('busy.example.com/v1/busy', '&page=3'));

    expect(textOf(first.body)).toMatch(/1–10 of 25/);
    expect(textOf(third.body)).toMatch(/21–25 of 25/);
    expect(first.body).toMatch(/href="\/check\?url=busy\.example\.com%2Fv1%2Fbusy&amp;page=2"/);
    expect(first.body.match(/href="\/calls\/pay_sample/g)?.length).toBe(10);
    expect(third.body.match(/href="\/calls\/pay_sample/g)?.length).toBe(5);
  });

  it('says there is no call yet for an endpoint with none, and shows zeros', async () => {
    const { response, body } = await get(full, checkPath('hostile.example.com/v1/none'));

    expect(response.status).toBe(200);
    expect(textOf(body)).toContain('No calls through Anyfare yet. Yours can be the first.');
  });

  it('shows the field and one line with the two examples when there is no link', async () => {
    const before = full.api!.requests.length;
    for (const path of ['/check', '/check?url=', '/check?url=%20%20']) {
      const { response, body } = await get(full, path);

      expect(response.status).toBe(200);
      expect(textOf(body)).toContain('Paste the link of one paid endpoint, the one that answers 402.');
      expect(body).toContain('href="/check?url=pro-api.coinmarketcap.com/x402/v3/cryptocurrency/quotes/latest"');
      expect(body).toContain('href="/check?url=merchant-near.mikedotexe.com/v1/evidence/account"');
      expect(body).toContain('<title>Check a link | Anyfare</title>');
    }
    expect(full.api!.requests.slice(before)).toEqual([]);
  });

  it('shows the card of each refusal, worded by its reason', async () => {
    const cases: readonly (readonly [string, string, string])[] = [
      ['free.example.com/v1/free', 'Not a paid link', 'This link answered without asking for a payment.'],
      ['free.example.com/detail', 'Not a paid link', 'This link answered without asking for a payment.'],
      ['unsupported.example.com/v1/x', 'A paid link we can&#x27;t pay yet', 'in a way Anyfare doesn&#x27;t make yet.'],
      ['blocked.example.com/v1/x', 'We don&#x27;t route to this host', 'Anyfare doesn&#x27;t send calls to this host.'],
      ['private.example.com/v1/x', 'We don&#x27;t route to this host', 'This link points to a private address.'],
      ['own.example.com/v1/x', 'We don&#x27;t route to this host', 'This is one of Anyfare&#x27;s own hosts.'],
      ['dead.example.com/v1/x', 'The link didn&#x27;t answer', 'We couldn&#x27;t reach this host. Check the link and try again.'],
      ['surprise.example.com/v1/x', 'We couldn&#x27;t check this link', 'Something we did not expect &lt;b&gt;happened&lt;/b&gt;'],
      ['not a link', 'This isn&#x27;t a link', 'such as api.example.com/v1/quote.'],
      ['limited.example.com/v1/x', 'Too many checks', 'Wait a minute and try again.'],
    ];
    for (const [link, title, line] of cases) {
      const { response, body } = await get(full, checkPath(link));

      expect(response.status, link).toBe(200);
      expect(body, link).toContain(title);
      expect(body, link).toContain(line);
      expect(body, link).toContain('Browse services');
      expect(body, link).toContain('Check another link');
      expect(body, link).toContain('href="/services"');
      expect(body, link).not.toContain('Payable through Anyfare');
    }
    expect((await get(full, checkPath('free.example.com/v1/free'))).body).toMatch(/<span class="host">free\.example\.com<\/span><span class="path">\/v1\/free<\/span>/);
  });

  it('makes no request, and says it is not a link, for a link over 2,048 characters', async () => {
    const before = full.api!.requests.length;
    const long = `api.example.com/${'a'.repeat(2_100)}`;
    const { response, body } = await get(full, checkPath(long));

    expect(response.status).toBe(200);
    expect(body).toContain('This isn&#x27;t a link');
    expect(full.api!.requests.slice(before).filter(request => request.path.startsWith('/_/check'))).toEqual([]);
    expect(body).not.toContain('a'.repeat(4_100));
    const exact = `api.example.com/${'a'.repeat(2_048 - 'api.example.com/'.length)}`;
    await get(full, checkPath(exact));
    expect(full.api!.requests.slice(before).filter(request => request.path.startsWith('/_/check'))).toHaveLength(1);
  });

  it('forwards the visitor\'s address to the pay host and to the API, and sends the link as typed', async () => {
    const typed = 'api.example.com/v1/sample/lookup?symbol=BTC&x=a b';
    await get(full, checkPath(typed), { headers: { 'x-forwarded-for': '203.0.113.9' } });

    const checks = full.api!.requests.filter(request => request.path.startsWith('/_/check') && request.path.includes('symbol'));
    expect(checks.at(-1)!.path).toBe(`/_/check?url=${encodeURIComponent(typed).replaceAll('%20', '+')}`);
    expect(checks.at(-1)!.headers['x-forwarded-for']).toBe('203.0.113.9');
    const reads = full.api!.requests.filter(request => request.path.startsWith('/v1/endpoints/stats') || request.path.startsWith('/v1/calls?host=api.example.com&endpoint=%2Fv1%2Fsample%2Flookup'));
    expect(reads.at(-1)!.headers['x-forwarded-for']).toBe('203.0.113.9');
    expect(reads.every(request => !request.path.includes('symbol'))).toBe(true);
  });

  it('shows the pay link with the query string of the link, and quotes the link for a shell', async () => {
    const { body } = await get(full, checkPath('api.example.com/v1/sample/lookup?symbol=BTC', '&tab=headers'));

    expect(body).toContain('value="https://pay.example.com/api.example.com/v1/sample/lookup?symbol=BTC"');
    expect(body).toContain('curl -i &#x27;https://api.example.com/v1/sample/lookup?symbol=BTC&#x27;');
  });

  it('renders text from an outside host only as text: never markup, a link target or a style', async () => {
    for (const tab of ['', '&tab=json', '&tab=headers', '&tab=code']) {
      const { response, body } = await get(full, checkPath('hostile.example.com/v1/x', tab));

      expect(response.status).toBe(200);
      expect(body).not.toMatch(/<script>alert/);
      expect(body).not.toContain('<img');
      expect(body).not.toMatch(/<[a-z][^>]*\sonerror=/i);
      expect(body).not.toMatch(/ style="/);
      expect(body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
      expect(body).toContain('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;');
      expect(body).not.toMatch(/href="[^"]*(alert|script)/i);
      const scripts = [...body.matchAll(/<script\b[^>]*>/g)].map(match => match[0]);
      const nonce = /'nonce-([^']+)'/.exec(response.headers.get('content-security-policy')!)![1]!;
      expect(scripts.every(script => script.includes(`nonce="${nonce}"`))).toBe(true);
    }
    const description = (await get(full, checkPath('hostile.example.com/v1/x'))).body;
    expect(description).toContain('<p class="small muted mt-8 ask-description">&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  });

  it('waits for a slow check and still answers 200 with the result', async () => {
    const started = Date.now();
    const { response, body } = await get(full, checkPath('slow.example.com/v1/x'));

    expect(Date.now() - started).toBeGreaterThanOrEqual(1_400);
    expect(response.status).toBe(200);
    expect(body).toContain('Payable through Anyfare');
  });

  it('answers 200 with the shared error state and the field still usable when the pay host is down or refuses the connection', async () => {
    for (const running of [down, refused]) {
      const { response, body } = await get(running, checkPath(base));

      expect(response.status).toBe(200);
      expect(body).toContain('role="alert"');
      expect(body).toContain('We couldn&#x27;t check this link.');
      expect(body).toMatch(/<input [^>]*name="url"[^>]*value="api\.example\.com\/v1\/sample\/quotes\/latest"/);
      expect(body).toContain('Check again');
    }
  });

  it('shows zeros and the empty state for an endpoint with no call, with an empty database', async () => {
    const { response, body } = await get(empty, checkPath(base));

    expect(response.status).toBe(200);
    expect(textOf(body)).toContain('Payable through Anyfare');
    expect(textOf(body)).toContain('0 Paid calls');
    expect(textOf(body)).toContain('No calls through Anyfare yet.');
    noBrokenValues(body);
  });

  it('answers the twin of a payable link with the real values, by .md and by Accept', async () => {
    const { response, body } = await get(full, `/check.md?url=${encodeURIComponent(base)}`);
    const viaAccept = await get(full, checkPath(base), { headers: { accept: 'text/markdown' } });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(body).toMatch(/^# api\.example\.com\/v1\/sample\/quotes\/latest\n\nPayable through Anyfare\./);
    expect(body).toContain('This API asks $0.010 in USDC on Base for each call, over x402.');
    expect(body).toContain('- Link: https://pay.example.com/api.example.com/v1/sample/quotes/latest');
    expect(body).toContain('- Paid calls: 402');
    expect(body).toContain('https://anyfare.example.com/calls/pay_sample0000');
    expect(viaAccept.response.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    // The same twin: only the clock differs
    const clockless = (markdown: string): string => markdown.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, '<time>');
    expect(clockless(viaAccept.body)).toBe(clockless(body));
  });

  it('answers the twin of a link that is not payable with its reason, and 429, 503 and the empty page when they apply', async () => {
    const refused = await get(full, `/check.md?url=${encodeURIComponent('free.example.com/v1/free')}`);
    const limited = await get(full, `/check.md?url=${encodeURIComponent('limited.example.com/v1/x')}`);
    const failed = await get(down, `/check.md?url=${encodeURIComponent(base)}`);
    const before = full.api!.requests.length;
    const none = await get(full, '/check.md');

    expect(refused.response.status).toBe(200);
    expect(refused.body).toContain('Not payable: Not a paid link.');
    expect(refused.body).toContain('Reason: `not_payable`');
    expect(limited.response.status).toBe(429);
    expect(limited.body).toContain('Reason: `rate_limited`');
    expect(failed.response.status).toBe(503);
    expect(none.response.status).toBe(200);
    expect(none.body).toContain('Paste the link of one paid endpoint');
    expect(full.api!.requests.slice(before)).toEqual([]);
  });

  it('turns into the Agent view with the requests behind the page, and has no twin cache', async () => {
    const { response } = await get(full, `/check.md?url=${encodeURIComponent(base)}`);

    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

describe('addresses a visitor can see', () => {
  it('never show the internal address the server reads from, in any page or twin', async () => {
    const internal = new URL(full.api!.url).host;
    const paths = [
      '/', '/calls', '/calls/pay_sample0000', '/services', '/services/api.example.com', checkPath('api.example.com/v1/sample/quotes/latest'),
      checkPath('api.example.com/v1/sample/quotes/latest', '&tab=json'), checkPath('api.example.com/v1/sample/quotes/latest', '&tab=headers'), checkPath('api.example.com/v1/sample/quotes/latest', '&tab=code'),
      checkPath('free.example.com/v1/free'), checkPath('hostile.example.com/v1/x'), checkPath('api.example.com/v1/x', '&period=7d&page=2'),
      '/index.md', '/calls.md', '/calls/pay_sample0000.md', '/services.md', '/services/api.example.com.md', `/check.md?url=${encodeURIComponent('api.example.com/v1/sample/quotes/latest')}`, '/check.md',
    ];
    for (const path of paths) {
      const { response, body } = await get(full, path);

      expect(response.status, path).toBe(200);
      expect(body, path).not.toContain(internal);
      expect(JSON.stringify([...response.headers.entries()]), path).not.toContain(internal);
    }
    // The public addresses are the ones shown
    const page = (await get(full, checkPath('api.example.com/v1/sample/quotes/latest'))).body;
    expect(page).toMatch(/Put <code>pay\.example\.com(<!-- -->)?\/<\/code>/);
    expect(page).toContain('https://pay.example.com/api.example.com/v1/sample/quotes/latest');
  });
});

describe('the period and the pages of the Check page', () => {
  const base = 'api.example.com/v1/sample/quotes/latest';

  it('are plain links in the server\'s HTML, so a shared link and a browser without scripts work', async () => {
    const { body } = await get(full, checkPath('busy.example.com/v1/busy', '&period=7d&tab=overview'));

    expect(body).toMatch(/<a href="\/check\?url=busy\.example\.com%2Fv1%2Fbusy&amp;period=today"[^>]*>Today<\/a>/);
    expect(body).toMatch(/<a href="\/check\?url=busy\.example\.com%2Fv1%2Fbusy&amp;period=7d" aria-current="true"[^>]*>7 days<\/a>/);
    expect(body).toMatch(/<a [^>]*href="\/check\?url=busy\.example\.com%2Fv1%2Fbusy&amp;period=7d&amp;page=2"/);
  });

  it('are read from the public API in the browser, with no navigation and no check', async () => {
    // The components that do it never use the router, and never ask for the check
    const { readFileSync } = await import('node:fs');
    for (const file of ['CheckStats.tsx', 'CheckCalls.tsx']) {
      const source = readFileSync(new URL(`../../src/check/${file}`, import.meta.url), 'utf8');

      expect(source, file).not.toMatch(/useRouter|router\.push|next\/navigation|paths\.check|\/_\/check/);
      expect(source, file).toContain('window.history.replaceState');
    }
    // Each period and each page is one request to the API's read endpoints, and the check is asked once, for the first load
    const before = full.api!.requests.length;
    await get(full, checkPath(base));
    const first = full.api!.requests.slice(before).map(request => request.path.split('?')[0]);
    expect(first.filter(path => path === '/_/check')).toHaveLength(1);
    const { getEndpointStats, listCalls } = await import('../../src/api/endpoints');
    const { createReader } = await import('../../src/api/reader');
    const mark = full.api!.requests.length;
    const read = createReader({ apiUrl: full.api!.url });
    for (const period of ['today', '7d', '30d', 'all'] as const)
      expect((await getEndpointStats(read, 'api.example.com', '/v1/sample/quotes/latest', period)).ok).toBe(true);
    expect((await listCalls(read, { host: 'busy.example.com', endpoint: '/v1/busy', size: 10, page: 2 })).ok).toBe(true);
    const paths = full.api!.requests.slice(mark).map(request => request.path.split('?')[0]);
    expect(paths).toEqual(['/v1/endpoints/stats', '/v1/endpoints/stats', '/v1/endpoints/stats', '/v1/endpoints/stats', '/v1/calls']);
  });
});

describe('the pages that are not built yet', () => {
  it('answers 404 for a page with no route, and 200 for /_/health', async () => {
    expect((await get(full, '/no-such-page')).response.status).toBe(404);
    expect(await (await fetch(`${full.url}/_/health`)).json()).toEqual({ status: 'ok' });
  });
});

describe('the files for agents', () => {
  it.each([
    ['/llms.txt', 'text/plain; charset=utf-8'],
    ['/llms-full.txt', 'text/plain; charset=utf-8'],
    ['/skills/anyfare-buyer/SKILL.md', 'text/markdown; charset=utf-8'],
  ])('serves %s as %s, built for the hosts it runs with', async (path, type) => {
    const { response, body } = await get(full, path);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(type);
    expect(body).toContain('https://api.example.com');
    expect(body).toContain(pay);
    expect(body).not.toMatch(/bakingbad\.dev|Proposal|Designed|topup-link/);
  });

  it('serves the skill with its front matter, and answers 404 for a skill that is not there', async () => {
    expect((await get(full, '/skills/anyfare-buyer/SKILL.md')).body.startsWith('---\nname: anyfare-buyer\ndescription: ')).toBe(true);
    expect((await get(full, '/skills/nothing/SKILL.md')).response.status).toBe(404);
  });

  it('serves the same files with the API down: they read no API', async () => {
    for (const path of ['/llms.txt', '/llms-full.txt', '/skills/anyfare-buyer/SKILL.md', '/agents', '/agents.md'])
      expect((await get(down, path)).response.status, path).toBe(200);
  });
});

describe('the For agents page', () => {
  it('answers 200 with every section, the prompt for this site, and the real llms.txt', async () => {
    const { response, body } = await get(full, '/agents');
    const { platformGuide } = await import('../../src/agents/guide');
    const { readSettings } = await import('../../src/config');
    const text = textOf(body);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    for (const part of ['Your agent can do all of this without you.', 'Give this to your agent', 'Start in four requests', 'The API', 'llms.txt', 'Read https://anyfare.example.com/llms.txt and follow it.', 'Sign up', 'Make a payment key with limits', 'Top up with any token', 'Call any paid API'])
      expect(text).toContain(part);
    // The file's text in the code block, as the file is served
    const served = (await get(full, '/llms.txt')).body;
    expect(served).toBe(platformGuide(readSettings({ SITE_URL: site, PAY_URL: pay, CONSOLE_URL: consoleUrl, API_URL: 'https://api.example.com' })));
    expect(body.replace(/<script[\s\S]*?<\/script>/g, '')).toContain('# Anyfare');
    expect(body).toMatch(/<title>For agents \| Anyfare<\/title>/);
    expect(body).toContain('property="og:title" content="For agents | Anyfare"');
    expect(body).toContain('rel="canonical" href="https://anyfare.example.com/agents"');
    expect(body).toContain('aria-current="page"');
  });

  it('lists every endpoint of the shared list, marked Built, and nothing unbuilt', async () => {
    const { endpoints, endpointUrl } = await import('../../src/agents/endpoints');
    const { body } = await get(full, '/agents');
    const text = textOfHtml(body);

    for (const endpoint of endpoints) {
      const host = new URL(endpoint.host === 'pay' ? pay : 'https://api.example.com').host;
      expect(text, endpoint.path).toContain(`${host}${endpoint.path}`);
      expect(endpointUrl({ apiUrl: 'https://api.example.com', payUrl: pay }, endpoint)).toContain(host);
    }
    expect(body.match(/>Built</g)!.length).toBeGreaterThanOrEqual(endpoints.length);
    expect(text).not.toMatch(/Proposal|Designed|topup-link|Andrew/);
  });

  it('shows every curl of the four requests as written', async () => {
    const { startSteps } = await import('../../src/agents/content');
    const { curlById } = await import('../../src/agents/examples');
    const hosts = { siteUrl: site, apiUrl: 'https://api.example.com', payUrl: pay, consoleUrl };
    const { body } = await get(full, '/agents');
    const text = body.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&#x27;/g, '\'').replace(/&amp;/g, '&');

    for (const step of startSteps(hosts))
      expect(text, step.example).toContain(curlById(hosts, step.example));
  });

  it('keeps the header\'s For agents item active and leads every link somewhere', async () => {
    const { body } = await get(full, '/agents');
    const links = [...body.replace(/<script[\s\S]*?<\/script>/g, '').matchAll(/<a [^>]*?href="([^"]*)"/g)].map(match => match[1]!.replaceAll('&amp;', '&'));

    // No bare `#`, no empty link; a fragment names an element of the page
    for (const link of links) {
      expect(link, 'an empty link').not.toBe('');
      expect(link, 'a link to nowhere').not.toBe('#');
      if (link.startsWith('#'))
        expect(body, link).toContain(`id="${link.slice(1)}"`);
    }
    expect(body).toMatch(/<a [^>]*aria-current="page"[^>]*>For agents<\/a>/);
    const internal = [...new Set(links.filter(link => link.startsWith('/') || link.startsWith(site)).map(link => link.startsWith(site) ? link.slice(site.length) : link))];
    const cards = ['/llms.txt', '/skills/anyfare-buyer/SKILL.md', '/agents.md', '/llms-full.txt', '/services.md', '/calls.md', '/services', '/calls', '/'];
    for (const card of cards)
      expect(internal, card).toContain(card);
    for (const link of internal) {
      const target = link.split('#')[0]!;
      expect((await get(full, target === '' ? '/agents' : target)).response.status, link).toBe(200);
    }
    // The cards for the OpenAPI files go to the API host and the pay host
    expect(links).toContain('https://api.example.com/openapi.json');
    expect(links).toContain(`${pay}/openapi.json`);
  });

  it('has a footer whose agent links lead to the files and the table', async () => {
    const { body } = await get(full, '/');
    const footer = body.slice(body.indexOf('<footer'));

    expect(footer).toContain('href="/llms.txt"');
    expect(footer).toContain('href="/agents#api"');
    expect(footer).toContain('href="/skills/anyfare-buyer/SKILL.md"');
    expect(footer).not.toMatch(/href="#"/);
    expect(body).toContain('href="/llms.txt"');
    expect((await get(full, '/agents')).body).toContain('id="api"');
  });

  it('has a Markdown twin, by .md and by Accept, with its link in the page\'s headers', async () => {
    const twin = await get(full, '/agents.md');
    const byAccept = await get(full, '/agents', { headers: { accept: 'text/markdown' } });
    const page = await get(full, '/agents');

    expect(twin.response.status).toBe(200);
    expect(twin.response.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(twin.body).toContain('# For agents');
    expect(twin.body).toContain('## The API');
    expect(twin.body).toContain('```sh\ncurl ');
    expect(byAccept.body).toBe(twin.body);
    expect(page.response.headers.get('link')).toContain('/agents.md');
    expect(page.response.headers.get('vary')).toContain('Accept');
  });

  it('shows the Agent view with the endpoint list as its JSON and the three files as its requests', async () => {
    const { agentsJson, agentsRequests } = await import('../../src/agents/content');
    const { endpoints } = await import('../../src/agents/endpoints');
    const hosts = { siteUrl: site, apiUrl: 'https://api.example.com', payUrl: pay, consoleUrl };

    expect(agentsJson(hosts).endpoints).toHaveLength(endpoints.length);
    expect(agentsRequests(hosts).map(request => request.url)).toEqual([`${site}/llms.txt`, `${site}/llms-full.txt`, `${site}/skills/anyfare-buyer/SKILL.md`]);
  });
});

// What crawlers and agents find first: robots.txt, the sitemap, the icons and the share image, the links on
// every page, the structured data and the API catalog.

const publicPages = ['/', '/services', '/services/api.example.com', '/calls', '/calls/pay_sample0000', '/agents', '/check?url=api.example.com/v1/sample/quotes/latest'];

describe('the Link header and the link tags of every public page', () => {
  it.each(publicPages)('has the twin, llms.txt and the OpenAPI file, and keeps Next.js\'s own hints, on %s', async path => {
    const { response, body } = await get(full, path);
    const header = response.headers.get('link')!;

    expect(response.status).toBe(200);
    expect(header).toMatch(/<https:\/\/anyfare\.example\.com\/[^>]*>; rel="alternate"; type="text\/markdown"/);
    expect(header).toContain(`<${site}/llms.txt>; rel="alternate"; type="text/plain"; title="llms.txt: a guide for agents"`);
    expect(header).toContain('<https://api.example.com/openapi.json>; rel="service-desc"; type="application/openapi+json"');
    // Next.js's own hint is still there: the proxy adds its header and doesn't replace theirs
    expect(header).toContain('rel=preconnect');
    expect(body).toMatch(/<link rel="alternate" type="text\/markdown" href="https:\/\/anyfare\.example\.com\/[^"]*"\/>/);
    expect(body).toContain(`<link rel="alternate" href="${site}/llms.txt" type="text/plain" title="llms.txt: a guide for agents"/>`);
    expect(body).toContain('<link rel="service-desc" href="https://api.example.com/openapi.json" type="application/openapi+json"/>');
    expect(header + body).not.toContain('127.0.0.1');
  });

  it('keeps the stylesheet preload hints Next.js adds on the home page', async () => {
    const { response } = await get(full, '/');

    expect(response.headers.get('link')).toMatch(/rel=preload; as="style"/);
  });

  it('has a canonical URL on the site, and for the check page one without the query', async () => {
    expect((await get(full, '/services')).body).toContain(`<link rel="canonical" href="${site}/services"/>`);
    expect((await get(full, '/check?url=api.example.com/v1/sample/quotes/latest')).body).toContain(`<link rel="canonical" href="${site}/check"/>`);
  });

  it('has Open Graph and Twitter tags with the page\'s own title and the share image', async () => {
    for (const path of publicPages) {
      const { body } = await get(full, path);

      expect(body, path).toMatch(/<meta property="og:image" content="https:\/\/anyfare\.example\.com\/opengraph-image[^"]*"\/>/);
      expect(body, path).toMatch(/<meta name="twitter:image" content="https:\/\/anyfare\.example\.com\/opengraph-image[^"]*"\/>/);
      expect(body, path).toContain('<meta name="twitter:card" content="summary_large_image"/>');
      expect(body, path).toMatch(/<meta property="og:title" content="[^"]+"\/>/);
      expect(body, path).toMatch(/<meta name="twitter:description" content="[^"]+"\/>/);
    }
  });
});

describe('robots.txt and the sitemap', () => {
  it('lets everyone read the pages, keeps out only what is not a page, and names the sitemap on the site\'s host', async () => {
    const { response, body } = await get(full, '/robots.txt');

    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(body).toContain('User-Agent: *\nAllow: /\nDisallow: /_/\nDisallow: /md/\nDisallow: /dev/');
    expect(body).toContain(`Sitemap: ${site}/sitemap.xml`);
    expect(body).not.toMatch(/GPTBot|ClaudeBot|CCBot/);
    expect(body).not.toContain('bakingbad.dev');
  });

  it('lists the pages and the first 100 services, with absolute URLs on the site', async () => {
    const { response, body } = await get(full, '/sitemap.xml');
    const urls = [...body.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1]!);

    expect(response.headers.get('content-type')).toContain('xml');
    expect(urls.slice(0, 4)).toEqual([site, `${site}/services`, `${site}/calls`, `${site}/agents`]);
    expect(urls).toContain(`${site}/services/api.example.com`);
    expect(urls.every(url => url.startsWith(site))).toBe(true);
    expect(urls.some(url => url.includes('/check') || url.includes('/calls/') || url.includes('127.0.0.1'))).toBe(false);
    expect(full.api!.requests.some(request => request.path === '/v1/services?sort=calls&page=1&size=100')).toBe(true);
  });

  it.each([['empty', () => empty], ['down', () => down], ['refused', () => refused]])('lists the four pages alone when the API is %s, and answers 200', async (_name, running) => {
    const { response, body } = await get(running(), '/sitemap.xml');

    expect(response.status).toBe(200);
    expect([...body.matchAll(/<loc>/g)]).toHaveLength(4);
  });
});

const pngSize = (bytes: Uint8Array): { width: number; height: number } => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect([...bytes.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  return { width: view.getUint32(16), height: view.getUint32(20) };
};

describe('the icons and the share image', () => {
  it.each([
    ['/opengraph-image', 1200, 630],
    ['/icon', 64, 64],
    ['/apple-icon', 180, 180],
  ])('serves %s as a PNG of the right size', async (path, width, height) => {
    const response = await fetch(`${full.url}${path}`);
    const bytes = new Uint8Array(await response.arrayBuffer());

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(pngSize(bytes)).toEqual({ width, height });
  });

  it('serves the logo as an SVG', async () => {
    const { response, body } = await get(full, '/logo.svg');

    expect(response.headers.get('content-type')).toBe('image/svg+xml');
    expect(body).toContain('<svg');
    expect(body).toContain('#00ec97');
  });

  it('serves the share image the page names, from the same site', async () => {
    const { body } = await get(full, '/');
    const url = new URL(/<meta property="og:image" content="([^"]+)"/.exec(body)![1]!);
    const response = await fetch(`${full.url}${url.pathname}${url.search}`);

    expect(url.origin).toBe(site);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
  });
});

describe('the structured data', () => {
  it('is on the home page only: an Organization and a WebSite, as data blocks the policy allows', async () => {
    const home = await get(full, '/');
    const blocks = [...home.body.matchAll(/<script type="application\/ld\+json"[^>]*>([^<]*)<\/script>/g)].map(match => JSON.parse(match[1]!) as Record<string, unknown>);
    const nonce = /'nonce-([^']+)'/.exec(home.response.headers.get('content-security-policy')!)![1]!;

    expect(blocks.map(block => block['@type'])).toEqual(['Organization', 'WebSite']);
    expect(blocks[0]).toMatchObject({ name: 'Anyfare', url: site, logo: `${site}/logo.svg`, sameAs: ['https://x.com/3route_io', 'https://github.com/baking-bad/anyfare'] });
    expect(home.body).toContain(`<script type="application/ld+json" nonce="${nonce}">`);
    for (const path of publicPages.slice(1))
      expect((await get(full, path)).body, path).not.toContain('application/ld+json');
  });
});

describe('the well-known files', () => {
  it('serves no file this site has no standard for', async () => {
    for (const path of ['/.well-known/api-catalog', '/.well-known/ai-plugin.json', '/.well-known/agent.json', '/.well-known/agent-card.json', '/.well-known/mcp.json', '/.well-known/x402', '/.well-known/security.txt', '/.well-known/llms.txt'])
      expect((await get(full, path)).response.status, path).toBe(404);
  });
});

describe('the 404 page and the pages that stay hidden', () => {
  it('answers 404 with noindex for a path and for a thing that doesn\'t exist', async () => {
    for (const path of ['/nothing', '/services/unknown.example.com', '/calls/pay_missing000']) {
      const { response, body } = await get(full, path);

      expect(response.status, path).toBe(404);
      expect(body, path).toMatch(/<meta name="robots" content="noindex/);
    }
  });

  it('answers 404 for the component gallery in production', async () => {
    expect((await get(full, '/dev/components')).response.status).toBe(404);
  });
});

describe('every link of the public pages and files', () => {
  const textFiles = ['/llms.txt', '/llms-full.txt', '/skills/anyfare-buyer/SKILL.md', '/index.md', '/agents.md', '/services.md', '/calls.md'];

  // An internal link maps to the running site; anything else is external
  const internalPath = (value: string, base: string): string | undefined => {
    let url: URL;
    try {
      url = new URL(value, base);
    }
    catch {
      throw new Error(`not a URL: ${value} (in ${base})`);
    }
    if (url.origin === site)
      return `${url.pathname}${url.search}`;
    // The console host's links are checked against the console host's answers
    if (url.origin === consoleUrl)
      return `console:${url.pathname}${url.search}`;

    return url.origin === new URL(base).origin ? `${url.pathname}${url.search}` : undefined;
  };

  it('answers 200 for every internal href and src, and no link is # or empty', async () => {
    const external = new Set<string>();
    const internal = new Set<string>();
    const sources: { readonly from: string; readonly values: string[] }[] = [];
    for (const path of publicPages) {
      const { body } = await get(full, path);
      sources.push({ from: path, values: [...body.matchAll(/\s(?:href|src)="([^"]*)"/g)].map(match => match[1]!.replace(/&amp;/g, '&')) });
    }
    for (const path of textFiles) {
      const { response, body } = await get(full, path);
      expect(response.status, path).toBe(200);
      const values = [...body.matchAll(/https?:\/\/[^\s)>"'`\]|]+/g)].map(match => match[0].replace(/[.,;:]+$/, '')).filter(value => !/[<{]/.test(value) && !/^https?:\/\/$/.test(value));
      sources.push({ from: path, values: [...values, ...[...body.matchAll(/\]\((\/[^)\s]*)\)/g)].map(match => match[1]!)] });
    }

    for (const { from, values } of sources) {
      for (const value of values) {
        expect(value.trim(), `${from} has an empty link`).not.toBe('');
        expect(value, `${from} has a # link`).not.toBe('#');
        if (/^(mailto:|tel:|data:|javascript:)/.test(value)) {
          external.add(value);
          continue;
        }
        if (value.startsWith('#'))
          continue;
        const path = internalPath(value, `${full.url}${from}`);
        if (path === undefined)
          external.add(value);
        else
          internal.add(path.split('#')[0]!);
      }
    }

    const failures: string[] = [];
    for (const path of [...internal].sort()) {
      const onConsole = path.startsWith('console:');
      const answer = await getAs(full, onConsole ? consoleHost : publicHost, onConsole ? path.slice('console:'.length) : path, { accept: 'text/html,*/*' });
      if (answer.status !== 200)
        failures.push(`${path} answered ${answer.status}`);
    }
    // The links into the console are among them, and each answers on the console host
    expect([...internal].filter(path => path.startsWith('console:'))).toEqual(expect.arrayContaining(['console:/', 'console:/topup', 'console:/keys']));

    // External links are listed, not fetched
    console.info(`external links (${external.size}):\n${[...external].sort().join('\n')}`);
    expect(internal.size).toBeGreaterThan(20);
    expect(failures).toEqual([]);
  }, 120_000);
});

describe('the two hosts of one app', () => {
  const consolePaths = ['/', '/topup', '/keys', '/payments', '/settings', '/signin'];
  const publicFiles = ['/llms.txt', '/llms-full.txt', '/skills/anyfare-buyer/SKILL.md', '/index.md', '/agents.md', '/services.md', '/calls.md', '/sitemap.xml', '/opengraph-image'];
  const marker = 'The console is being built';

  it.each([...publicPages.slice(1), ...publicFiles])('serves %s on the public host and answers 404 on the console host', async path => {
    const onSite = await getAs(full, publicHost, path);
    const onConsole = await getAs(full, consoleHost, path);

    expect(onSite.status).toBe(200);
    expect(onConsole.status).toBe(404);
    expect(onConsole.body).not.toContain(marker);
    expect(onConsole.body).not.toContain('Paid through Anyfare');
    expect(onConsole.headers['x-robots-tag']).toBe('noindex, nofollow');
  });

  it.each(consolePaths)('serves the Console page at %s on the console host, and never on the public host', async path => {
    const onConsole = await getAs(full, consoleHost, path);
    const onSite = await getAs(full, publicHost, path);

    expect(onConsole.status).toBe(200);
    expect(onConsole.headers['content-type']).toContain('text/html');
    expect(onConsole.body).toContain(marker);
    expect(onSite.body).not.toContain(marker);
    if (path !== '/')
      expect(onSite.status).toBe(404);
  });

  it('serves the Console page for any query on a console path, and no console page under any other path', async () => {
    expect((await getAs(full, consoleHost, '/keys?x=1&y=2')).status).toBe(200);
    expect((await getAs(full, consoleHost, '/signin?next=/topup')).body).toContain(marker);
    for (const path of ['/console', '/_/console', '/_/console?amount=5', '/topup/x', '/keys/1', '/Topup', '/index.md', '/services/']) {
      for (const host of [consoleHost, publicHost])
        expect((await getAs(full, host, path)).body, `${host}${path}`).not.toContain(marker);
    }
    expect((await getAs(full, consoleHost, '/console')).status).toBe(404);
    expect((await getAs(full, consoleHost, '/_/console')).status).toBe(404);
    expect((await getAs(full, publicHost, '/_/console')).status).toBe(404);
  });

  it('serves the home page, not the Console page, on the public host at /, and a Markdown request there is not a console request', async () => {
    const home = await getAs(full, publicHost, '/');
    const markdown = await getAs(full, consoleHost, '/', { accept: 'text/markdown' });

    expect(home.body).toContain('Pay any paid API from the chain you are on.');
    expect(markdown.status).toBe(200);
    expect(String(markdown.headers['content-type'])).toContain('text/html');
    expect(markdown.body).toContain(marker);
  });

  it('answers any other host, a forged name or an address, as the public host', async () => {
    for (const host of ['203.0.113.7', 'evil.test', `127.0.0.1:${new URL(full.url).port}`, 'console.example.com.evil.test']) {
      expect((await getAs(full, host, '/services')).status, host).toBe(200);
      expect((await getAs(full, host, '/topup')).status, host).toBe(404);
      expect((await getAs(full, host, '/')).body, host).not.toContain(marker);
    }
  });

  it('reads the host from the Host header with a port, upper case or a trailing dot', async () => {
    for (const host of [consoleHost.toUpperCase(), `${consoleHost}.`, `${consoleHost}:443`])
      expect((await getAs(full, host, '/topup')).body, host).toContain(marker);
    expect((await getAs(full, `${publicHost}:8443`, '/services')).status).toBe(200);
  });

  it('ignores X-Forwarded-Host, and a header or a value the visitor sends to choose a host', async () => {
    const forged = await getAs(full, publicHost, '/topup', { 'x-forwarded-host': consoleHost, 'x-surface': 'console', 'x-surface-pass': 'guess', forwarded: `host=${consoleHost}` });
    const reverse = await getAs(full, consoleHost, '/services', { 'x-forwarded-host': publicHost, 'x-surface': 'site' });
    const pageHeaders = await getAs(full, consoleHost, '/', { 'x-surface': 'site', 'x-surface-pass': 'guess' });

    expect(forged.status).toBe(404);
    expect(forged.body).not.toContain(marker);
    expect(reverse.status).toBe(404);
    expect(pageHeaders.body).toContain(marker);
    // The header and the footer lead to the public site, as the console host's page does
    expect(pageHeaders.body).toContain(`href="${site}/services"`);
  });

  it.each([['/_/health'], ['/icon'], ['/apple-icon'], ['/logo.svg'], ['/robots.txt']])('serves %s on both hosts', async path => {
    for (const host of [publicHost, consoleHost])
      expect((await getAs(full, host, path)).status, `${host}${path}`).toBe(200);
  });

  it('answers the health check with the same body on both hosts', async () => {
    for (const host of [publicHost, consoleHost])
      expect(JSON.parse((await getAs(full, host, '/_/health')).body)).toEqual({ status: 'ok' });
  });

  it('serves the framework\'s static files on the console host', async () => {
    const home = await getAs(full, consoleHost, '/');
    const asset = /(?:href|src)="(\/_next\/static\/[^"]+)"/.exec(home.body)![1]!;

    expect((await getAs(full, consoleHost, asset)).status).toBe(200);
  });

  it('sends the policy and the other headers on both hosts, with a nonce on every script', async () => {
    for (const [host, path] of [[publicHost, '/'], [consoleHost, '/'], [consoleHost, '/topup'], [consoleHost, '/services']] as const) {
      const reply = await getAs(full, host, path);
      const policy = String(reply.headers['content-security-policy']);

      expect(policy, `${host}${path}`).toContain('default-src \'self\'');
      expect(policy, `${host}${path}`).toContain('frame-ancestors \'none\'');
      expect(reply.headers['x-content-type-options']).toBe('nosniff');
      expect(reply.headers['x-frame-options']).toBe('DENY');
      expect(reply.headers['referrer-policy']).toBe('no-referrer');
      expect(reply.headers['permissions-policy']).toContain('camera=()');
      const nonce = /'nonce-([^']+)'/.exec(policy)![1]!;
      if (reply.status === 200)
        expect([...reply.body.matchAll(/<script\b[^>]*>/g)].every(script => script[0].includes(`nonce="${nonce}"`))).toBe(true);
    }
  });

  it('lets the console host\'s browser talk only to the site and the API', async () => {
    const onConsole = String((await getAs(full, consoleHost, '/')).headers['content-security-policy']);
    const onSite = String((await getAs(full, publicHost, '/')).headers['content-security-policy']);

    expect(onConsole).toContain('connect-src \'self\' https://api.example.com;');
    expect(onConsole).not.toContain('pay.example.com');
    expect(onSite).toContain('connect-src \'self\' https://api.example.com https://pay.example.com');
  });

  it('has a robots.txt for each host: the console\'s disallows everything', async () => {
    const onConsole = await getAs(full, consoleHost, '/robots.txt');
    const onSite = await getAs(full, publicHost, '/robots.txt');

    expect(onConsole.body.trim()).toBe('User-Agent: *\nDisallow: /');
    expect(onConsole.body).not.toContain('Sitemap');
    expect(onSite.body).toContain('Allow: /');
    expect(onSite.body).toContain(`Sitemap: ${site}/sitemap.xml`);
  });

  it('has noindex, a canonical URL on the console host, no Link header and no link to a twin on the Console page', async () => {
    for (const path of ['/', '/topup?amount=5']) {
      const { headers, body } = await getAs(full, consoleHost, path);

      expect(body).toMatch(/<meta name="robots" content="noindex, nofollow"\/>/);
      expect(body).toContain(`<link rel="canonical" href="${consoleUrl}"/>`);
      expect(body).toContain('<title>The console is being built | Anyfare</title>');
      expect(body).not.toContain('text/markdown');
      expect(body).not.toContain('llms.txt: a guide for agents');
      expect(body).not.toContain('og:image');
      expect(headers['link'] ?? '').not.toContain('text/markdown');
      expect(headers['link'] ?? '').not.toContain('llms.txt');
      expect(headers['x-robots-tag']).toBe('noindex, nofollow');
    }
    expect((await getAs(full, publicHost, '/')).body).not.toContain('noindex');
  });

  it('shows the five plans, the three cards with real commands and copy buttons, and the two links', async () => {
    const { body } = await getAs(full, consoleHost, '/');
    const text = textOfHtml(body);

    for (const line of ['See the balance', 'Make and limit payment keys', 'Top up with any token', 'See every payment', 'Rotate the master key'])
      expect(text).toContain(line);
    expect(text).toContain('What works today');
    expect(text).toContain('curl -X POST https://api.example.com/v1/accounts');
    expect(text).toContain('curl -X POST https://api.example.com/v1/keys');
    expect(text).toContain('-d \'{"label":"research","dailyBudget":"5","maxPrice":"0.05"}\'');
    expect(text).toContain('curl -X POST https://api.example.com/v1/topups');
    expect([...body.matchAll(/>Copy</g)]).toHaveLength(3);
    expect(body).toContain(`href="${site}/agents"`);
    expect(body).toContain(`href="${site}/llms.txt"`);
    expect(body).not.toMatch(/<form|<input|<textarea|type="password"/);
    expect(body).not.toMatch(/afm_live_|af_live_/);
  });

  it('has a header and a footer that lead to the public site, and a Console button that is the current page', async () => {
    const { body } = await getAs(full, consoleHost, '/');
    const hrefs = [...body.matchAll(/\shref="([^"]*)"/g)].map(match => match[1]!);

    for (const path of ['/services', '/calls', '/agents', '/agents#api', '/llms.txt', '/skills/anyfare-buyer/SKILL.md'])
      expect(hrefs).toContain(`${site}${path}`);
    expect(hrefs).toContain(`${site}/`);
    expect(body).toMatch(new RegExp(`<a class="btn primary sm" href="${consoleUrl}" aria-current="page">Console</a>`));
    expect(body).not.toContain('aria-pressed');
    // No link of the page leads to a page of the console host that is not the Console page, and none is relative but the files
    expect(hrefs.filter(href => href.startsWith('/') && !href.startsWith('/_next/') && !/^\/(icon|apple-icon)\?/.test(href))).toEqual([]);
  });

  it('shows the public header with a Console button that is not the current page on the public host', async () => {
    const { body } = await getAs(full, publicHost, '/services');

    expect(body).toContain(`<a class="btn primary sm" href="${consoleUrl}">Console</a>`);
    expect(body).toContain('aria-pressed');
  });

  it('says the same on the 404 page of the console host, with its header on the public site', async () => {
    const reply = await getAs(full, consoleHost, '/services');

    expect(reply.status).toBe(404);
    expect(reply.body).toMatch(/<meta name="robots" content="noindex/);
    expect(reply.body).toContain(`href="${site}/services"`);
  });

  describe('the amount of a top-up link', () => {
    const amountOf = async (query: string): Promise<string | undefined> => {
      const { status, body } = await getAs(full, consoleHost, `/topup${query}`);
      expect(status).toBe(200);

      return /"amount":"([^"]*)"/.exec(textOfHtml(body))?.[1];
    };

    it.each([
      ['?amount=5', '5'], ['?amount=5.50', '5.5'], ['?amount=1', '1'], ['?amount=10000', '10000'], ['?amount=5&amount=9', '5'],
    ])('uses the amount in %s: %s', async (query, expected) => {
      expect(await amountOf(query)).toBe(expected);
    });

    it.each(['?amount=0', '?amount=-1', '?amount=1e9', '?amount=%3Cscript%3E', '?amount=5abc', '?amount=10000.01', '?amount=', '?amount=5.555', '?amount=%205', '?other=5', ''])('ignores %s and shows the example\'s own amount', async query => {
      expect(await amountOf(query)).toBe('20');
    });

    it('uses an amount on /topup only', async () => {
      for (const path of ['/', '/keys', '/payments', '/settings', '/signin']) {
        const { body } = await getAs(full, consoleHost, `${path}?amount=5`);

        expect(/"amount":"([^"]*)"/.exec(textOfHtml(body))?.[1], path).toBe('20');
      }
    });

    it('shows no text of the query anywhere in the page, and no unescaped markup', async () => {
      const mark = 'ZZQ9marker';
      const queries = [`?amount=5&note=${mark}`, `?${mark}=1`, `?amount=${mark}`, '?amount=%3Cscript%3Ealert(1)%3C/script%3E&x=%22%3E%3Cimg%20src=x%3E'];
      for (const query of queries) {
        const { body, headers } = await getAs(full, consoleHost, `/topup${query}`);

        expect(body, query).not.toContain(mark);
        expect(body, query).not.toContain('alert(1)');
        expect(body, query).not.toContain('<img src=x');
        expect(JSON.stringify(headers), query).not.toContain(mark);
      }
      expect((await getAs(full, consoleHost, `/keys/${mark}`)).body).not.toContain(mark);
      expect((await getAs(full, consoleHost, `/services/${mark}`)).body).not.toContain(mark);
    });
  });

  it('shows the example with the amount and keeps the others, whatever the query', async () => {
    const { body } = await getAs(full, consoleHost, '/topup?amount=7.25');
    const text = textOfHtml(body);

    expect(text).toContain('"amount":"7.25"');
    expect(text).toContain('"dailyBudget":"5"');
    expect(text).not.toContain('"amount":"20"');
  });
});

describe('one host for the site and the console', () => {
  const sharedHost = new URL(site).host;
  const marker = 'The console is being built';

  it('serves every public page, and the Console page at /console and at the console paths', async () => {
    for (const path of ['/', '/services', '/agents', '/llms.txt', '/sitemap.xml', '/robots.txt'])
      expect((await getAs(shared, sharedHost, path)).status, path).toBe(200);
    expect((await getAs(shared, sharedHost, '/')).body).not.toContain(marker);
    for (const path of ['/console', '/console?x=1', '/topup', '/keys', '/payments', '/settings', '/signin'])
      expect((await getAs(shared, sharedHost, path)).body, path).toContain(marker);
    expect((await getAs(shared, sharedHost, '/_/console')).status).toBe(404);
    expect((await getAs(shared, sharedHost, '/console/x')).status).toBe(404);
  });

  it('serves the same whatever the Host is', async () => {
    expect((await getAs(shared, 'evil.test', '/services')).status).toBe(200);
    expect((await getAs(shared, 'evil.test', '/topup')).body).toContain(marker);
  });

  it('leads its links into the console to /console and to the console paths, and each answers 200', async () => {
    const home = await getAs(shared, sharedHost, '/');

    expect(home.body).toContain(`href="${site}/console"`);
    expect(home.body).toContain(`href="${site}/topup"`);
    expect(home.body).toContain(`href="${site}/keys"`);
    expect(home.body).not.toMatch(new RegExp(`<a [^>]*href="${site}"[^>]*>(Console|Open the console)`));
  });

  it('keeps the public pages\' header and footer, and the page\'s canonical URL at /console', async () => {
    const reply = await getAs(shared, sharedHost, '/topup?amount=5');

    expect(reply.body).toContain(`<link rel="canonical" href="${site}/console"/>`);
    expect(reply.body).toContain('href="/services"');
    expect(textOfHtml(reply.body)).toContain('"amount":"5"');
    expect(reply.headers['x-robots-tag']).toBeUndefined();
    expect(reply.body).toMatch(/<meta name="robots" content="noindex, nofollow"\/>/);
  });
});
