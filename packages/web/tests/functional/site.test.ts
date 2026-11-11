import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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

const startSite = async (api: FakeApi | undefined, apiInternalUrl: string): Promise<Running> => {
  const port = await freePort();
  const child = spawn(process.execPath, [nextBin, 'start', '-p', String(port), '-H', '127.0.0.1'], {
    cwd: webRoot,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      NEXT_DIST_DIR: distDir,
      NEXT_TELEMETRY_DISABLED: '1',
      SITE_URL: site,
      PAY_URL: pay,
      CONSOLE_URL: consoleUrl,
      API_URL: 'https://api.example.com',
      API_INTERNAL_URL: apiInternalUrl,
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

beforeAll(async () => {
  const build = spawnSync(process.execPath, [nextBin, 'build'], {
    cwd: webRoot,
    env: { ...process.env, NODE_ENV: 'production', NEXT_DIST_DIR: distDir, NEXT_TELEMETRY_DISABLED: '1' },
    encoding: 'utf8',
  });
  if (build.status !== 0)
    throw new Error(`next build failed:\n${build.stdout}\n${build.stderr}`);

  const [fullApi, emptyApi, downApi] = await Promise.all([startFakeApi('full'), startFakeApi('empty'), startFakeApi('down')]);
  [full, empty, down, refused] = await Promise.all([
    startSite(fullApi, fullApi.url),
    startSite(emptyApi, emptyApi.url),
    startSite(downApi, downApi.url),
    startSite(undefined, await refusedUrl()),
  ]);
}, 300_000);

afterAll(async () => {
  for (const running of [full, empty, down, refused]) {
    running?.process.kill();
    await running?.api?.close();
  }
});

const get = async (at: Running, path: string, init?: RequestInit) => {
  const response = await fetch(`${at.url}${path}`, init);

  return { response, body: await response.text() };
};

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
    const forged = { headers: { 'x-receipt-missing': '1' } };
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

describe('the pages that are not built yet', () => {
  it('answers 404 for a page with no route, and 200 for /_/health', async () => {
    expect((await get(full, '/no-such-page')).response.status).toBe(404);
    expect(await (await fetch(`${full.url}/_/health`)).json()).toEqual({ status: 'ok' });
  });
});
