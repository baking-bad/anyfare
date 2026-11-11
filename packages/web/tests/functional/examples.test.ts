import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { endpoints } from '../../src/agents/endpoints';
import { errorDocs } from '../../src/agents/errors';
import { curlExamples, exampleCall, exampleLink, exampleLinkPost, type CurlExample } from '../../src/agents/examples';
import { fullGuide } from '../../src/agents/full';
import { startSteps } from '../../src/agents/content';
import { agentsMarkdown } from '../../src/markdown/agents';
import { missingFields, printedAnswers, printedChallenge, printedErrorList } from '../support/printed';
import { startStack, type RunningStack } from '../support/localStack';

// Every example an agent reads, run as a real HTTP request against the local stack (the real API, pay host,
// workers and Signer, with a fake paid API), in the order an agent would. Then the answers the text prints are
// held against the real ones.

let running: RunningStack;
let examples: readonly CurlExample[];
const vars: Record<string, string> = {};
// The first real answer of each example, and the ids that ran, in order
const answers = new Map<string, { status: number; headers: Headers; json: any; text: string }>();
const ran: string[] = [];

interface Reply {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
  readonly json: any;
}

const parse = (text: string): any => {
  try {
    return JSON.parse(text);
  }
  catch {
    return undefined;
  }
};

// An example names a real outside API: the stack's fake paid link stands in for it, and nothing else changes
const localize = (text: string): string => text
  .replaceAll(exampleCall, `${running.paidLink}?symbol=BTC&convert=USD`)
  .replaceAll(exampleLinkPost, running.paidLink)
  .replaceAll(exampleLink, running.paidLink);

const fill = (text: string, own: Readonly<Record<string, string>>): string => text.replace(/\$([A-Z_]+)/g, (_match, name: string) => {
  const value = own[name] ?? vars[name];
  if (value === undefined)
    throw new Error(`${name} has no value yet`);

  return value;
});

/** Sends an example as written: its method, address, headers and body. `own` overrides the variables. */
const send = async (example: CurlExample, own: Readonly<Record<string, string>> = {}): Promise<Reply> => {
  const abort = new AbortController();
  const response = await fetch(fill(localize(example.url), own), {
    method: example.method,
    headers: Object.fromEntries(Object.entries(example.headers).map(([name, value]) => [name, fill(value, own)])),
    ...example.body === undefined ? {} : { body: example.body },
    redirect: 'manual',
    signal: abort.signal,
  });
  // A stream never ends: the headers and its first bytes are the answer
  if (example.flags?.includes('-N') === true) {
    const reader = response.body!.getReader();
    const first = await reader.read();
    abort.abort();
    const text = first.value === undefined ? '' : new TextDecoder().decode(first.value);

    return { status: response.status, headers: response.headers, text, json: undefined };
  }
  const text = await response.text();

  return { status: response.status, headers: response.headers, text, json: parse(text) };
};

const exampleOf = (id: string): CurlExample => {
  const found = examples.find(example => example.id === id);
  if (found === undefined)
    throw new Error(`No example is called ${id}`);

  return found;
};

// What each example's answer is, when it is not JSON
const contentTypeOf = (example: CurlExample): string => example.flags?.includes('-N') === true ? 'text/event-stream' : 'application/json';

/** Runs an example and holds its answer to what the example promises. */
const run = async (id: string, own: Readonly<Record<string, string>> = {}): Promise<Reply> => {
  const example = exampleOf(id);
  const reply = await send(example, own);
  if (!answers.has(id))
    answers.set(id, reply);
  ran.push(id);

  expect(reply.status, `${id}: status, answer ${reply.text.slice(0, 300)}`).toBe(example.expect.status);
  expect(reply.headers.get('content-type') ?? '', `${id}: content type`).toContain(contentTypeOf(example));
  for (const field of example.expect.fields)
    expect(reply.json, `${id}: the answer has ${field}`).toHaveProperty([field]);
  for (const header of example.expect.headers ?? [])
    expect(reply.headers.has(header), `${id}: header ${header}`).toBe(true);

  return reply;
};

const api = (path: string, init: RequestInit = {}): Promise<Reply> => fetch(`${running.hosts.apiUrl}${path}`, init).then(async response => {
  const text = await response.text();

  return { status: response.status, headers: response.headers, text, json: parse(text) };
});
const pay = (path: string, init: RequestInit = {}): Promise<Reply> => fetch(`${running.hosts.payUrl}${path}`, init).then(async response => {
  const text = await response.text();

  return { status: response.status, headers: response.headers, text, json: parse(text) };
});
const expectCursorRefused = (reply: Reply): void => {
  expect(reply.status).toBe(400);
  expect(reply.json?.error?.code).toBe('invalid_request');
};
const bearer = (key: string): Record<string, string> => ({ authorization: `Bearer ${key}` });
const jsonBody = { 'content-type': 'application/json' };

beforeAll(async () => {
  running = await startStack();
  examples = curlExamples(running.hosts);
  vars['ANYFARE_SERVICE_HOST'] = running.stack.paidApiHost;
  vars['ANYFARE_SERVICE_PATH'] = '/base';
}, 120_000);

// Stopping the whole stack can take longer than the default hook limit on a busy machine
afterAll(async () => {
  await running?.stop();
}, 60_000);

describe('the examples, in the order an agent runs them', () => {
  it('checks a link, free, and a link that asks on POST', async () => {
    const checked = await run('check');
    expect(checked.json.payable).toBe(true);
    expect(checked.json.link).toBe(`${running.hosts.payUrl}/${running.paidLink}`);
    const post = await run('check-post');
    expect(post.json.method).toBe('POST');
  });

  it('answers a call with no payment with the 402: every way to pay', async () => {
    const unpaid = await run('unpaid');
    expect(unpaid.headers.get('cache-control')).toContain('no-store');
    // The 402 as the text prints it: every header and body field it names exists
    const printed = printedChallenge(fullGuide(running.hosts));
    expect(printed.headers.length).toBeGreaterThan(2);
    for (const name of printed.headers)
      expect(unpaid.headers.has(name), `the 402 has the header ${name}`).toBe(true);
    expect(missingFields(printed.body, unpaid.json)).toEqual([]);
    // The WWW-Authenticate header holds the MPP charge, and PAYMENT-REQUIRED is the same list as the body's, in base64
    expect(unpaid.headers.get('www-authenticate')).toMatch(/^Payment /);
    const required = JSON.parse(Buffer.from(unpaid.headers.get('payment-required')!, 'base64').toString('utf8'));
    expect(required.accepts).toEqual(unpaid.json.accepts);
    expect(unpaid.json.credits.signup).toEqual({ method: 'POST', url: `${running.hosts.apiUrl}/v1/accounts` });
    expect(unpaid.json.credits.topUp.options).toBe(`${running.hosts.apiUrl}/v1/topups/options`);
  });

  it('signs up: a master key, shown once', async () => {
    const account = await run('signup');
    vars['ANYFARE_MASTER_KEY'] = account.json.masterKey;
    expect(account.json.masterKey).toMatch(/^afm_/);
    expect(Number(account.json.freeCredits)).toBeGreaterThan(0);
    expect((await run('account')).json.id).toBe(account.json.id);
  });

  it('makes a payment key, lists it, changes it', async () => {
    const made = await run('make-key');
    vars['ANYFARE_PAYMENT_KEY'] = made.json.key;
    vars['ANYFARE_KEY_ID'] = made.json.id;
    expect(made.json).toMatchObject({ label: 'research', dailyBudget: '5', maxPrice: '0.05', key: expect.stringMatching(/^af_/) });
    const listed = await run('list-keys');
    expect(listed.json.keys.map((key: { id: string }) => key.id)).toEqual([made.json.id]);
    expect(JSON.stringify(listed.json)).not.toContain(made.json.key);
    const changed = await run('change-key');
    expect(changed.json).toMatchObject({ id: made.json.id, dailyBudget: '10', maxPrice: null });
  });

  it('pays a call with the key: the receipt header, and what is left on the key', async () => {
    const paid = await run('paid-call');
    const receipt = paid.headers.get('anyfare-receipt')!;
    expect(receipt).toMatch(/^id="pay_[^"]+", amount="[0-9.]+", currency="USD"$/);
    vars['ANYFARE_CALL_ID'] = /id="([^"]+)"/.exec(receipt)![1]!;
    expect(paid.json.path).toBe('/base');
    const key = await run('key-status');
    expect(key.json.id).toBe(vars['ANYFARE_KEY_ID']);
    expect(Number(key.json.spent.today)).toBeGreaterThan(0);
    expect(key.json.remaining).toHaveProperty('balance');
  });

  it('reads the receipt of the call, in the public list', async () => {
    await expect.poll(async () => (await send(exampleOf('receipt'))).status, { timeout: 5_000, interval: 100 }).toBe(200);
    const receipt = await run('receipt');
    expect(receipt.json).toMatchObject({ id: vars['ANYFARE_CALL_ID'], status: 'paid', service: running.stack.paidApiHost });
    expect(receipt.json.buyer).toMatchObject({ paidWith: 'credits' });
  });

  it('reads the balance and the payments of the account', async () => {
    const balance = await run('balance');
    expect(Number(balance.json.available)).toBeGreaterThan(0);
    const payments = await run('payments');
    expect(payments.json.payments.length).toBeGreaterThan(0);
  });

  it('lists the top-up options, asks for a top-up and reads it', async () => {
    const options = await run('topup-options');
    expect(options.json.networks.length).toBeGreaterThan(0);
    // The example asks for 20 USDC on Base: the options say whether the stack takes it
    const base = options.json.networks.find((network: { name: string }) => network.name === 'base');
    expect(base, 'the options list the network the example asks for').toBeDefined();
    const topup = await run('topup');
    vars['ANYFARE_TOPUP_ID'] = topup.json.id;
    const status = await run('topup-status');
    expect(status.json.id).toBe(topup.json.id);
  });

  it('reads the public lists, numbers and one service', async () => {
    // Calls the workers count into the numbers: a few more, then the count the workers make on a timer, once, now
    for (let index = 0; index < 3; index += 1)
      expect((await send(exampleOf('paid-call'))).status).toBe(200);
    await running.countNumbers();
    await run('catalog');
    // Two endpoints are listed, so a page of one has a next: its cursor goes back as it came, and the page after it answers
    const nearCheck = await pay(`/_/check?url=${running.stack.paidApiHost}/near`);
    expect(nearCheck.json, nearCheck.text).toMatchObject({ payable: true, listed: true });
    // The page is kept a few seconds once read, so wait on the service's page, then read the catalog once
    await expect.poll(async () => (await api(`/v1/services/${running.stack.paidApiHost}`)).json?.paidEndpoints, { timeout: 4_000, interval: 100 }).toBe(2);
    const first = await api('/v1/catalog?limit=1');
    expect(first.json.endpoints).toHaveLength(1);
    expect(typeof first.json.partial).toBe('boolean');
    const second = await api(`/v1/catalog?limit=1&cursor=${first.json.next}`);
    expect(second.status).toBe(200);
    expect(second.json.endpoints.length).toBeGreaterThan(0);
    expect(second.json.endpoints[0].id).not.toBe(first.json.endpoints[0].id);
    // A cursor no page gave, such as an old page number, is refused
    expectCursorRefused(await api('/v1/catalog?cursor=2'));
    await expect.poll(async () => (await send(exampleOf('calls'))).json?.calls?.length, { timeout: 5_000, interval: 100 }).toBeGreaterThan(0);
    await run('calls');
    const stream = await run('calls-stream');
    expect(stream.text.startsWith('retry:') || stream.text.startsWith(':') || stream.text.startsWith('event:')).toBe(true);
    await run('stats');
    await run('stats-live');
    await run('stats-top');
    await run('services');
    await run('service');
    await run('endpoint-stats');
    await run('openapi-api');
    await run('openapi-pay');
  });

  it('puts the destructive examples last, each on an account of its own', async () => {
    const destructive = examples.filter(example => example.destructive === true).map(example => example.id);
    expect(destructive.sort()).toEqual(['revoke-key', 'rotate']);

    // The sign-up that saves to a file is a sign-up: its account is the one a key is revoked on
    const doomed = await run('signup-to-file');
    const own = { ANYFARE_MASTER_KEY: doomed.json.masterKey };
    const key = await api('/v1/keys', { method: 'POST', headers: { ...bearer(doomed.json.masterKey), ...jsonBody }, body: '{}' });
    expect(key.status).toBe(201);
    expect((await pay('/_/key', { headers: bearer(key.json.key) })).status).toBe(200);
    const revoked = await run('revoke-key', { ...own, ANYFARE_KEY_ID: key.json.id });
    expect(revoked.json.id).toBe(key.json.id);
    // The key made into a file answers as the key made on screen does
    expect((await run('make-key-to-file', own)).json.key).toMatch(/^af_/);
    expect(revoked.json.revokedAt).not.toBeNull();
    // A revoked key stops at once
    const after = await pay('/_/key', { headers: bearer(key.json.key) });
    expect(after.status).toBe(401);
    expect(after.json.error.code).toBe('invalid_key');

    const second = await api('/v1/accounts', { method: 'POST' });
    const rotated = await run('rotate', { ANYFARE_MASTER_KEY: second.json.masterKey });
    expect(rotated.json.masterKey).not.toBe(second.json.masterKey);
    // The old master key stops at once, and the new one works
    expect((await api('/v1/account', { headers: bearer(second.json.masterKey) })).status).toBe(401);
    expect((await api('/v1/account', { headers: bearer(rotated.json.masterKey) })).status).toBe(200);

    const last = ran.slice(-6);
    expect(last.filter(id => destructive.includes(id)).length).toBe(2);
    expect(ran.slice(-3)).toContain('rotate');
  });

  it('runs every example, or says why it can\'t', () => {
    const missed = examples.filter(example => !ran.includes(example.id) && example.cannotRunLocally === undefined).map(example => example.id);
    expect(missed, 'examples that did not run and give no reason').toEqual([]);
    for (const example of examples.filter(candidate => candidate.cannotRunLocally !== undefined))
      expect(example.cannotRunLocally!.length, example.id).toBeGreaterThan(10);
  });
});

describe('the errors the files list', () => {
  // The paid call's answers with a key of the stack: a key with a limit of its own
  const keyWith = async (body: object): Promise<string> => {
    const account = await api('/v1/accounts', { method: 'POST' });
    const made = await api('/v1/keys', { method: 'POST', headers: { ...bearer(account.json.masterKey), ...jsonBody }, body: JSON.stringify(body) });

    return made.json.key;
  };
  const call = (target: string, key: string, init: RequestInit = {}): Promise<Reply> =>
    pay(`/${target}`, { ...init, headers: { ...bearer(key), ...init.headers as Record<string, string> } });
  const expectError = (reply: Reply, status: number, code: string): void => {
    expect(reply.status, `${code}: ${reply.text.slice(0, 200)}`).toBe(status);
    expect(reply.json?.error?.code).toBe(code);
    expect(typeof reply.json?.error?.message).toBe('string');
  };

  // Each code a trigger can cause on the local stack, with the request that causes it
  const triggers: Readonly<Record<string, () => Promise<Reply>>> = {
    // 400
    invalid_request: () => api('/v1/keys', { method: 'POST', headers: { ...bearer(vars['ANYFARE_MASTER_KEY']!), ...jsonBody }, body: '{"dailyBudget":"abc"}' }),
    invalid_target: () => pay('/not-a-host'),
    host_not_allowed: () => call('a.localhost/prices', vars['ANYFARE_PAYMENT_KEY']!),
    not_payable: () => call(`${running.stack.paidApiHost}/free`, vars['ANYFARE_PAYMENT_KEY']!),
    multiple_payment_methods: () => call(`${running.paidLink}`, vars['ANYFARE_PAYMENT_KEY']!, { headers: { 'payment-signature': 'e30=' } }),
    unsupported_network: () => api('/v1/topups', { method: 'POST', headers: { ...bearer(vars['ANYFARE_MASTER_KEY']!), ...jsonBody }, body: '{"network":"nowhere","token":"USDC","amount":"20"}' }),
    unknown_token: () => api('/v1/topups', { method: 'POST', headers: { ...bearer(vars['ANYFARE_MASTER_KEY']!), ...jsonBody }, body: '{"network":"base","token":"NOSUCH","amount":"20"}' }),
    invalid_amount: () => api('/v1/topups', { method: 'POST', headers: { ...bearer(vars['ANYFARE_MASTER_KEY']!), ...jsonBody }, body: '{"network":"base","token":"USDC","amount":"1.1234567"}' }),
    amount_too_small: () => api('/v1/topups', { method: 'POST', headers: { ...bearer(vars['ANYFARE_MASTER_KEY']!), ...jsonBody }, body: '{"network":"base","token":"USDC","amount":"0.5"}' }),
    // 401
    unauthorized: () => api('/v1/account'),
    invalid_key: () => api('/v1/account', { headers: bearer('afm_test_notakey') }),
    wrong_key_type: () => api('/v1/account', { headers: bearer(vars['ANYFARE_PAYMENT_KEY']!) }),
    // 402
    key_budget_exceeded: async () => call(running.paidLink, await keyWith({ dailyBudget: '0.0005' })),
    key_allowance_exceeded: async () => call(running.paidLink, await keyWith({ allowance: '0.0005' })),
    key_price_limit: async () => call(running.paidLink, await keyWith({ maxPrice: '0.0005' })),
    payment_invalid: () => pay(`/${running.paidLink}`, { headers: { 'payment-signature': 'e30=' } }),
    // 404
    not_found: () => api('/v1/calls/pay_nosuchcall'),
    // 502 and 503: a port nothing listens on
    upstream_unavailable: () => call('fake-api.test:1/base', vars['ANYFARE_PAYMENT_KEY']!),
    unsupported_payment: () => call(`${running.stack.paidApiHost}/unpayable`, vars['ANYFARE_PAYMENT_KEY']!),
  };

  // What can't be caused on the local stack without breaking it or waiting
  const cannotTrigger: Readonly<Record<string, string>> = {
    ambiguous_token: 'the stack\'s token list has no two tokens with one symbol',
    topup_refused: 'the fake swap service accepts every quote',
    insufficient_balance: 'the free Credits of a new account are worth hundreds of calls',
    rate_limited: 'the stack\'s limits are far above what a test sends',
    quote_exceeded: 'the fake paid API never raises its price',
    settlement_failed: 'the fake facilitator and Tempo node settle every payment',
    response_too_large: 'the fake paid API answers small bodies',
    topup_mismatch: 'the fake swap service quotes what is asked',
    facilitator_unavailable: 'the fake facilitator is up',
    payment_unavailable: 'no payment of a payer is in flight',
    redis_not_ready: 'Redis is up',
    topups_unavailable: 'the swap service is on',
    stats_unavailable: 'the stack\'s numbers are read within their bounds',
    shutting_down: 'the server is not restarting',
  };

  const statusOf = (code: string): number => errorDocs.find(error => error.code === code)!.status;

  it.each(Object.keys(triggers))('answers %s with the status the files give', async code => {
    const reply = await triggers[code]!();
    // A code the files list may be answered with another code on the stack: say which
    expectError(reply, statusOf(code), code);
    if (reply.status === 401)
      expect(reply.headers.get('www-authenticate')).toMatch(/^Bearer/);
  });

  it('answers a bad method and a bad check as the files say', async () => {
    // The check of any method but GET needs its header: without it the answer is a 400
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'])
      expectError(await pay(`/_/check?url=${running.paidLink}&method=${method}`), 400, 'invalid_request');
    // A method that is not one of the five is a 400, with the header or without
    const other = await pay(`/_/check?url=${running.paidLink}&method=HEAD`, { headers: { 'x-anyfare-check': '1' } });
    expectError(other, 400, 'invalid_request');
    // A route that takes one method: another is refused
    const wrong = await api('/v1/accounts', { method: 'DELETE' });
    expect(wrong.status).toBeGreaterThanOrEqual(400);
    expect(wrong.status).toBeLessThan(500);
    // A host that can't be routed, checked: a 200 with the reason
    const checked = await pay('/_/check?url=https://10.0.0.5/prices');
    expect(checked.json).toMatchObject({ payable: false, reason: 'host_not_allowed' });
    // An unknown id on the keys, the top-ups and the services
    expectError(await api('/v1/keys/key_nosuchkey', { method: 'DELETE', headers: bearer(vars['ANYFARE_MASTER_KEY']!) }), 404, 'not_found');
    expectError(await api('/v1/topups/top_nosuchtopup', { headers: bearer(vars['ANYFARE_MASTER_KEY']!) }), 404, 'not_found');
    expectError(await api('/v1/services/no-such-host.test'), 404, 'not_found');
    // The pay host takes a payment key; the master key is the wrong kind there
    expectError(await pay('/_/key', { headers: bearer(vars['ANYFARE_MASTER_KEY']!) }), 401, 'wrong_key_type');
    expectError(await pay('/_/key'), 401, 'unauthorized');
  });

  it('lists every code of the files as caused here or as one that can\'t be, and no other', () => {
    const listed = new Set(endpoints.flatMap(endpoint => endpoint.errors.map(error => error.split(' ')[1]!)));
    const known = new Set([...Object.keys(triggers), ...Object.keys(cannotTrigger)]);
    expect([...listed].filter(code => !known.has(code)), 'a code of the endpoint list with no trigger and no reason').toEqual([]);
    expect(errorDocs.map(error => error.code).filter(code => !known.has(code)), 'a code of the error list with no trigger and no reason').toEqual([]);
    expect(Object.keys(triggers).filter(code => Object.keys(cannotTrigger).includes(code))).toEqual([]);
  });

  it('names each endpoint\'s errors in the text the same as the list', () => {
    const text = fullGuide(running.hosts);
    for (const [heading, list] of printedErrorList(text)) {
      const endpoint = endpoints.find(candidate => heading === `${candidate.method === 'SSE' ? 'GET' : candidate.method} ${candidate.path} (${candidate.host === 'pay' ? 'pay host' : 'API host'})`);
      expect(endpoint, heading).toBeDefined();
      expect(list, heading).toEqual(endpoint!.errors);
    }
  });
});

describe('the answers the text prints are the real ones', () => {
  it('has every field llms-full.txt shows after "Answer", at its place in the real answer', () => {
    const printed = printedAnswers(fullGuide(running.hosts));
    const compared: string[] = [];
    for (const answer of printed) {
      const endpoint = endpoints.find(candidate => answer.heading === `${candidate.method === 'SSE' ? 'GET' : candidate.method} ${candidate.path} (${candidate.host === 'pay' ? 'pay host' : 'API host'})`);
      expect(endpoint, answer.heading).toBeDefined();
      if (endpoint?.example === undefined)
        continue;
      const real = answers.get(endpoint.example);
      expect(real, `${answer.heading}: its example ran`).toBeDefined();
      expect(missingFields(answer.json, real!.json), `${answer.heading}: fields shown and not in the real answer`).toEqual([]);
      compared.push(answer.heading);
    }
    // The ones with an answer to compare: every JSON answer of the list
    expect(compared.length).toBe(endpoints.filter(endpoint => endpoint.answer.json !== undefined).length);
  });

  it('has every field the For agents page shows under a command, at its place in the real answer', () => {
    const steps = startSteps(running.hosts);
    expect(steps.length).toBeGreaterThan(3);
    const text = agentsMarkdown(running.hosts);
    for (const step of steps) {
      expect(text, `step ${step.number}'s answer is on the page`).toContain(`Answer: \`${step.answer}\``);
      const real = answers.get(step.example)!;
      if (step.answer.startsWith('{')) {
        // The shape is written with … for what is left out: read the names
        const names = [...step.answer.matchAll(/"(\w+)":/g)].map(match => match[1]!);
        expect(names.length).toBeGreaterThan(1);
        for (const name of names)
          expect(real.json, `step ${step.number}: ${name}`).toHaveProperty([name]);
      }
      else {
        // `200 OK  Anyfare-Receipt: id="pay_…", amount="0.01", currency="USD"`
        expect(real.status).toBe(200);
        for (const part of ['id', 'amount', 'currency'])
          expect(real.headers.get('anyfare-receipt'), part).toContain(`${part}="`);
        expect(step.answer).toContain('Anyfare-Receipt');
      }
    }
  });
});
