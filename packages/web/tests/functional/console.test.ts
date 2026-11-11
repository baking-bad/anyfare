import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { request } from 'node:http';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startFakeApi, type FakeApi } from '../support/fakeApi';

// The console, from a production build (`next build`, then `next start`), as the image runs it: its pages on the
// console host, what the server's HTML holds, the policy, the server's log, and the fake API's keyed routes. The site
// answers two hosts of one machine, as a person runs it: the public site at `localhost:<port>` and the console at
// `127.0.0.1:<port>`. When `agent-browser` is installed, the browser check of the key (scripts/key-check.mjs) runs too.

const webRoot = fileURLToPath(new URL('../..', import.meta.url));
const nextBin = fileURLToPath(new URL('../../../../node_modules/next/dist/bin/next', import.meta.url));
// Its own build directory: the other functional tests build into theirs at the same time
const distDir = '.next-console';

const freePort = async (): Promise<number> => {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>(resolve => server.close(() => resolve()));

  return port;
};

interface Running {
  readonly url: string;
  readonly port: number;
  readonly process: ChildProcess;
  // What the server wrote to stdout and stderr
  output: string;
}

const startSite = async (port: number, siteUrl: string, consoleUrl: string, apiUrl: string): Promise<Running> => {
  const child = spawn(process.execPath, [nextBin, 'start', '-p', String(port), '-H', '127.0.0.1'], {
    cwd: webRoot,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      NEXT_DIST_DIR: distDir,
      NEXT_TELEMETRY_DISABLED: '1',
      SITE_URL: siteUrl,
      CONSOLE_URL: consoleUrl,
      API_URL: apiUrl,
      API_INTERNAL_URL: apiUrl,
      PAY_URL: apiUrl,
      PAY_INTERNAL_URL: apiUrl,
      // Everything the server logs, so a test can read all of it
      LOG_LEVEL: 'trace',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const running: Running = { url: `http://127.0.0.1:${port}`, port, process: child, output: '' };
  child.stdout?.on('data', (chunk: Buffer) => {
    running.output += chunk.toString('utf8');
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    running.output += chunk.toString('utf8');
  });
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      if ((await fetch(`${running.url}/_/health`)).ok)
        return running;
    }
    catch {
      // Not listening yet
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  child.kill();
  throw new Error('The website didn\'t start');
};

let fake: FakeApi;
let down: FakeApi;
let site: Running;
let shared: Running;
let consoleHost: string;
let publicHost: string;
let sharedHost: string;

beforeAll(async () => {
  const build = spawnSync(process.execPath, [nextBin, 'build'], {
    cwd: webRoot,
    env: { ...process.env, NODE_ENV: 'production', NEXT_DIST_DIR: distDir, NEXT_TELEMETRY_DISABLED: '1' },
    encoding: 'utf8',
  });
  if (build.status !== 0)
    throw new Error(`next build failed:\n${build.stdout}\n${build.stderr}`);

  const [port, sharedPort] = [await freePort(), await freePort()];
  consoleHost = `127.0.0.1:${port}`;
  publicHost = `localhost:${port}`;
  sharedHost = `localhost:${sharedPort}`;
  [fake, down] = await Promise.all([startFakeApi('full', 0, 0, [`http://${consoleHost}`]), startFakeApi('down', 0, 0, [`http://${consoleHost}`])]);
  [site, shared] = await Promise.all([
    startSite(port, `http://${publicHost}`, `http://${consoleHost}`, fake.url),
    startSite(sharedPort, `http://${sharedHost}`, `http://${sharedHost}`, fake.url),
  ]);
}, 300_000);

afterAll(async () => {
  for (const running of [site, shared])
    running?.process.kill();
  await fake?.close();
  await down?.close();
});

interface Reply {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: string;
}

// A request with the `Host` header of a host the site answers to: the server listens on one address, and each host is a header
const getAs = (at: Running, host: string, path: string, headers: Readonly<Record<string, string>> = {}, method = 'GET'): Promise<Reply> => new Promise((resolve, reject) => {
  const outgoing = request({ host: '127.0.0.1', port: at.port, path, method, headers: { host, ...headers } }, incoming => {
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
    incoming.on('end', () => resolve({ status: incoming.statusCode ?? 0, headers: incoming.headers, body: Buffer.concat(chunks).toString('utf8') }));
  });
  outgoing.on('error', reject);
  outgoing.end();
});

const directives = (policy: string): Record<string, string> =>
  Object.fromEntries(policy.split('; ').map(directive => [directive.slice(0, directive.indexOf(' ')), directive.slice(directive.indexOf(' ') + 1)]));

const consolePaths = ['/', '/keys', '/topup', '/payments', '/settings', '/signin'];
const titles: Readonly<Record<string, string>> = { '/': 'Overview', '/keys': 'Keys', '/topup': 'Top up', '/payments': 'Payments', '/settings': 'Settings', '/signin': 'Sign in' };
const publicPaths = ['/services', '/calls', '/agents', '/check', '/services/api.example.com', '/calls/pay_sample0000', '/llms.txt', '/llms-full.txt', '/index.md', '/agents.md', '/sitemap.xml', '/opengraph-image', '/skills/anyfare-buyer/SKILL.md'];
const internalRoutes = ['/_/console', '/_/console/keys', '/_/console/topup', '/_/console/payments', '/_/console/settings', '/_/console/signin', '/_/console?amount=5', '/_/console/topup?amount=5', '/_/console/x'];
// The server's shell of a console page
const shell = 'class="console-opening"';

describe('the console\'s pages on the console host', () => {
  it.each(consolePaths)('serves %s on the console host, with its title, and no search engine keeps it', async path => {
    const reply = await getAs(site, consoleHost, path);

    expect(reply.status).toBe(200);
    expect(reply.headers['content-type']).toContain('text/html');
    expect(reply.body).toContain(shell);
    expect(reply.body).toContain(`<title>${titles[path]} | Anyfare console</title>`);
    expect(reply.body).toMatch(/<meta name="robots" content="noindex, nofollow"\/>/);
    expect(reply.headers['x-robots-tag']).toBe('noindex, nofollow');
    expect(reply.body).not.toContain('og:image');
  });

  it('has no header or footer of the public site, and no link to its files', async () => {
    const { body } = await getAs(site, consoleHost, '/');

    expect(body).not.toContain('class="site-header');
    expect(body).not.toContain('class="site-footer');
    expect(body).not.toContain('text/markdown');
    expect(body).not.toContain('llms.txt');
  });

  it('serves a console page for any query, and nothing under any other path', async () => {
    expect((await getAs(site, consoleHost, '/keys?x=1&y=2')).body).toContain(shell);
    for (const path of ['/console', '/topup/x', '/keys/1', '/Topup', '/settings.md', '/nothing'])
      expect((await getAs(site, consoleHost, path)).status, path).toBe(404);
    // A trailing slash is the framework's redirect to the page itself
    expect((await getAs(site, consoleHost, '/signin/')).headers['location']).toBe('/signin');
  });

  it.each(consolePaths.slice(1))('never serves %s on the public host', async path => {
    const reply = await getAs(site, publicHost, path);

    expect(reply.status).toBe(404);
    expect(reply.body).not.toContain(shell);
  });

  it('serves the home page, not a console page, at / on the public host', async () => {
    const home = await getAs(site, publicHost, '/');

    expect(home.status).toBe(200);
    expect(home.body).toContain('Pay any paid API from the chain you are on.');
    expect(home.body).not.toContain(shell);
  });

  it.each(publicPaths)('answers 404 for the public %s on the console host', async path => {
    const onConsole = await getAs(site, consoleHost, path);

    expect(onConsole.status).toBe(404);
    expect(onConsole.body).not.toContain(shell);
    expect(onConsole.body).not.toContain('Paid through Anyfare');
  });

  it.each(internalRoutes)('answers 404 for the internal route %s, asked directly, on both hosts', async path => {
    for (const host of [consoleHost, publicHost]) {
      const reply = await getAs(site, host, path);

      expect(reply.status, `${host}${path}`).toBe(404);
      expect(reply.body, `${host}${path}`).not.toContain(shell);
    }
  });

  it('ignores a header the visitor sends to choose the host or pass the proxy', async () => {
    const forged = await getAs(site, publicHost, '/settings', { 'x-forwarded-host': consoleHost, 'x-surface': 'console', 'x-surface-pass': 'guess' });
    const internal = await getAs(site, consoleHost, '/_/console/settings', { 'x-surface': 'console', 'x-surface-pass': 'guess' });

    expect(forged.status).toBe(404);
    expect(internal.status).toBe(404);
  });
});

describe('what the server\'s HTML of a console page holds', () => {
  it.each([
    ['/topup?amount=%3Cscript%3E', ['%3Cscript%3E', '&lt;script&gt;', 'amount=&lt;']],
    ['/topup?amount=5&note=hello-from-link', ['hello-from-link', 'note=']],
    ['/signin?key=afm_test_xyz', ['afm_test_xyz', 'key=afm']],
    ['/?next=%2F%2Fevil.test&amount=5', ['evil.test', 'next=']],
  ])('holds no text of the query of %s', async (path, absent) => {
    const reply = await getAs(site, consoleHost, path);

    expect(reply.status).toBe(200);
    for (const text of absent)
      expect(reply.body, text).not.toContain(text);
    expect(JSON.stringify(reply.headers)).not.toMatch(/hello-from-link|afm_test_xyz|evil\.test/);
  });

  it('hands a top-up link\'s amount to the page as a number, and only on /topup', async () => {
    const props = async (path: string): Promise<string> => {
      const { body } = await getAs(site, consoleHost, path);

      return /\{\\"page\\":\\"topup\\"[^}]*\}/.exec(body)?.[0] ?? '';
    };

    expect(await props('/topup?amount=5')).toContain('\\"amount\\":5,');
    expect(await props('/topup?amount=7.25')).toContain('\\"amount\\":7.25,');
    expect(await props('/topup?amount=5')).toContain('\\"amountUnused\\":false');
    // A bad amount is no error: the page gets the flag that it was not used
    for (const query of ['?amount=1001', '?amount=abc', '?amount=', '?amount=%3Cscript%3E']) {
      const found = await props(`/topup${query}`);

      expect(found, query).toContain('\\"amountUnused\\":true');
      expect(found, query).toContain('\\"amount\\":\\"$undefined\\"');
    }
    expect(await props('/topup')).toContain('\\"amountUnused\\":false');
    expect((await getAs(site, consoleHost, '/keys?amount=5')).body).not.toContain('\\"amount\\":5');
  });

  it('holds no key and no account data, whatever is sent, and the server asks the API nothing', async () => {
    const made = await (await fetch(`${fake.url}/v1/accounts`, { method: 'POST' })).json() as { readonly id: string; readonly masterKey: string };
    const before = fake.requests.length;
    for (const path of consolePaths) {
      for (const query of ['', `?key=${made.masterKey}`]) {
        const reply = await getAs(site, consoleHost, `${path}${query}`, { authorization: `Bearer ${made.masterKey}`, cookie: `key=${made.masterKey}` });

        expect(reply.status, path).toBe(200);
        expect(reply.body, path).not.toContain(made.masterKey);
        expect(reply.body, path).not.toContain(made.id);
        expect(reply.body, path).not.toMatch(/afm_(live|test)_|"available"|"held"/);
        expect(JSON.stringify(reply.headers), path).not.toContain(made.masterKey);
      }
    }
    expect(fake.requests.length).toBe(before);
  });
});

describe('the policy of the console\'s pages', () => {
  it.each(consolePaths)('lets %s run scripts by nonce only, take no inline style, and talk only to the site and the API', async path => {
    const reply = await getAs(site, consoleHost, path);
    const policy = directives(String(reply.headers['content-security-policy']));
    const nonce = /'nonce-([^']+)'/.exec(policy['script-src'] ?? '')![1]!;

    expect(policy['script-src']).toBe(`'self' 'nonce-${nonce}' 'strict-dynamic'`);
    expect(policy['connect-src']).toBe(`'self' ${new URL(fake.url).origin}`);
    expect(policy['style-src']).toBe('\'self\'');
    expect(String(reply.headers['content-security-policy'])).not.toMatch(/unsafe-inline|unsafe-eval/);
    expect([...reply.body.matchAll(/<script\b[^>]*>/g)].every(script => script[0].includes(`nonce="${nonce}"`))).toBe(true);
    // No style attribute in the server's HTML: the policy would refuse it
    expect(reply.body).not.toMatch(/<[a-z][^>]*\sstyle="/);
    expect(reply.body).not.toMatch(/<form\b|<input\b|type="password"/);
    expect(reply.headers['referrer-policy']).toBe('no-referrer');
    expect(reply.headers['x-frame-options']).toBe('DENY');
  });
});

describe('the server\'s log', () => {
  it('holds no key, whatever is sent to the server', async () => {
    const made = await (await fetch(`${fake.url}/v1/accounts`, { method: 'POST' })).json() as { readonly masterKey: string };
    const key = made.masterKey;
    for (const host of [consoleHost, publicHost]) {
      for (const path of [...consolePaths, '/nothing', '/_/console', '/services']) {
        await getAs(site, host, `${path}?key=${key}`, { authorization: `Bearer ${key}`, 'x-api-key': key, cookie: `session=${key}` });
        await getAs(site, host, `${path}?key=${key}`, { authorization: `Bearer ${key}` }, 'POST');
      }
    }
    await new Promise(resolve => setTimeout(resolve, 500));

    // The output is read: the startup line is in it
    expect(site.output).toContain('"msg":"Started"');
    expect(site.output).not.toContain(key);
    expect(site.output).not.toContain(key.slice('afm_test_'.length));
  });
});

describe('one host for the site and the console', () => {
  it('serves the Overview at /console and the console paths with the console\'s frame and policy, and the home page at /', async () => {
    for (const path of ['/console', ...consolePaths.slice(1)]) {
      const reply = await getAs(shared, sharedHost, path);

      expect(reply.status, path).toBe(200);
      expect(reply.body, path).toContain(shell);
      expect(reply.body, path).not.toContain('class="site-header');
      expect(directives(String(reply.headers['content-security-policy']))['connect-src'], path).toBe(`'self' ${new URL(fake.url).origin}`);
    }
    expect((await getAs(shared, sharedHost, '/console')).body).toContain('<title>Overview | Anyfare console</title>');
    const home = await getAs(shared, sharedHost, '/');
    expect(home.body).not.toContain(shell);
    expect(home.body).toContain('class="site-header');
    for (const path of ['/_/console', '/_/console/keys', '/console/keys'])
      expect((await getAs(shared, sharedHost, path)).status, path).toBe(404);
  });

  it('tells the console that its Overview is /console', async () => {
    expect((await getAs(shared, sharedHost, '/keys')).body).toContain('\\"overviewPath\\":\\"/console\\"');
    expect((await getAs(site, consoleHost, '/keys')).body).toContain('\\"overviewPath\\":\\"/\\"');
  });
});

describe('the fake API\'s keyed routes', () => {
  const origin = (): string => `http://${consoleHost}`;

  it('answer the console\'s origin with its CORS headers, errors too, and never with credentials', async () => {
    const made = await fetch(`${fake.url}/v1/accounts`, { method: 'POST', headers: { origin: origin() } });
    const { masterKey } = await made.json() as { readonly masterKey: string };
    const balance = await fetch(`${fake.url}/v1/balance`, { headers: { origin: origin(), authorization: `Bearer ${masterKey}` } });
    const refused = await fetch(`${fake.url}/v1/balance`, { headers: { origin: origin(), authorization: 'Bearer afm_test_nope' } });

    expect(made.status).toBe(201);
    expect(masterKey).toMatch(/^afm_test_[0-9a-f]{32}$/);
    for (const reply of [made, balance, refused]) {
      expect(reply.headers.get('access-control-allow-origin')).toBe(origin());
      expect(reply.headers.get('vary')).toBe('Origin');
      expect(reply.headers.get('access-control-expose-headers')).toBe('Retry-After, X-Request-Id');
      expect(reply.headers.get('access-control-allow-credentials')).toBeNull();
    }
    expect(await balance.json()).toEqual({ available: '0.1', held: '0' });
    expect(refused.status).toBe(401);
  });

  it('answer the console\'s preflight, and give no CORS header to any other origin', async () => {
    const preflight = await fetch(`${fake.url}/v1/account/master-key/rotate`, { method: 'OPTIONS', headers: { origin: origin(), 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization' } });
    const foreignPreflight = await fetch(`${fake.url}/v1/balance`, { method: 'OPTIONS', headers: { origin: 'https://evil.test' } });
    const foreign = await fetch(`${fake.url}/v1/accounts`, { method: 'POST', headers: { origin: 'https://evil.test' } });

    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe(origin());
    expect(preflight.headers.get('access-control-allow-methods')).toBe('GET, POST, PATCH, DELETE, OPTIONS');
    expect(preflight.headers.get('access-control-allow-headers')).toBe('Authorization, Content-Type');
    expect(preflight.headers.get('access-control-max-age')).toBe('600');
    expect(foreignPreflight.status).toBe(404);
    for (const reply of [foreignPreflight, foreign]) {
      expect(reply.headers.get('access-control-allow-origin')).toBeNull();
      expect(reply.headers.get('access-control-allow-credentials')).toBeNull();
    }
  });

  it('refuse no key, a payment key, and a key rotated away', async () => {
    const { masterKey } = await (await fetch(`${fake.url}/v1/accounts`, { method: 'POST' })).json() as { readonly masterKey: string };
    const code = async (authorization?: string): Promise<string> => {
      const reply = await fetch(`${fake.url}/v1/account`, authorization === undefined ? {} : { headers: { authorization } });

      return reply.ok ? String(reply.status) : `${reply.status} ${(await reply.json() as { readonly error: { readonly code: string } }).error.code}`;
    };

    expect(await code()).toBe('401 unauthorized');
    expect(await code('Bearer af_test_0123456789abcdef')).toBe('401 wrong_key_type');
    expect(await code(`Bearer ${masterKey}`)).toBe('200');
    const rotated = await fetch(`${fake.url}/v1/account/master-key/rotate`, { method: 'POST', headers: { authorization: `Bearer ${masterKey}` } });
    const { masterKey: next } = await rotated.json() as { readonly masterKey: string };
    expect(await code(`Bearer ${masterKey}`)).toBe('401 invalid_key');
    expect(await code(`Bearer ${next}`)).toBe('200');
    // Every request is recorded, with its method, path, query and headers
    expect(fake.requests.at(-1)).toMatchObject({ method: 'GET', path: '/v1/account', query: '' });
  });

  it('rotate all the same when told to garble, drop or delay the rotation\'s answer', async () => {
    const make = async (): Promise<string> => (await (await fetch(`${fake.url}/v1/accounts`, { method: 'POST' })).json() as { readonly masterKey: string }).masterKey;
    const rotate = (key: string): Promise<Response> => fetch(`${fake.url}/v1/account/master-key/rotate`, { method: 'POST', headers: { authorization: `Bearer ${key}` } });
    const works = async (key: string): Promise<number> => (await fetch(`${fake.url}/v1/account`, { headers: { authorization: `Bearer ${key}` } })).status;
    try {
      const garbled = await make();
      await (await fetch(`${fake.url}/_test/rotate?answer=garble`, { method: 'POST' })).text();
      const unreadable = await rotate(garbled);
      expect(unreadable.status).toBe(200);
      expect(await unreadable.text()).not.toMatch(/masterKey/);
      expect(await works(garbled)).toBe(401);

      const dropped = await make();
      fake.rotateAnswer('drop');
      await expect(rotate(dropped)).rejects.toThrow();
      expect(await works(dropped)).toBe(401);

      const late = await make();
      fake.rotateAnswer('late', 300);
      const started = Date.now();
      const answer = await rotate(late);
      expect(Date.now() - started).toBeGreaterThanOrEqual(250);
      expect(await answer.json()).toMatchObject({ masterKey: expect.stringMatching(/^afm_test_/) as unknown });
      expect(await works(late)).toBe(401);
    }
    finally {
      fake.rotateAnswer('normal');
    }
    const plain = await make();
    expect((await rotate(plain)).status).toBe(200);
  });

  it('answer 500 with the CORS headers in down mode, and 429 when limited', async () => {
    const failing = await fetch(`${down.url}/v1/balance`, { headers: { origin: origin(), authorization: 'Bearer afm_test_x' } });
    fake.limit(true);
    const limited = await fetch(`${fake.url}/v1/accounts`, { method: 'POST', headers: { origin: origin() } });
    fake.limit(false);

    expect(failing.status).toBe(500);
    expect(failing.headers.get('access-control-allow-origin')).toBe(origin());
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('30');
    expect(limited.headers.get('access-control-allow-origin')).toBe(origin());
  });
});

// The key in a real browser. CI has no agent-browser: the check says so and passes over it.
const hasBrowser = spawnSync('agent-browser', ['--version'], { encoding: 'utf8' }).error === undefined;

describe('the master key in a real browser', () => {
  it.skipIf(!hasBrowser)('goes only to sessionStorage and to the API, as Authorization', async () => {
    // Run as a person runs it; the fake API answers from this process, so the script runs beside it, not blocking it
    const script = spawn(process.execPath, ['scripts/key-check.mjs', `http://${consoleHost}`, fake.url, '--session', `key-check-test-${process.pid}`], { cwd: webRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    script.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    script.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    const code = await new Promise<number | null>(resolve => script.on('close', resolve));

    expect(output.split('\n').filter(line => line.includes('finding'))).toEqual([]);
    expect(output).toContain('nothing found');
    expect(code).toBe(0);
  }, 240_000);

  it.runIf(!hasBrowser)('is not checked here: agent-browser is not installed (run npm run check:key -w @anyfare/web by hand)', () => {
    expect(hasBrowser).toBe(false);
  });
});
