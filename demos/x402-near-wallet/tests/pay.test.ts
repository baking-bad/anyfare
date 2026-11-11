// One request, paid in USDC on NEAR when it asks for it. Every key here is made in the test, in
// memory only, and holds nothing. Every account, price and balance is made up. No request leaves
// 127.0.0.1: the https APIs are sent to the fake API, and the NEAR signer to the fake NEAR RPC.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli.ts';
import { loadConfig } from '../src/config.ts';
import { createContext } from '../src/context.ts';
import type { Fetch } from '../src/http.ts';
import { payRequest } from '../src/pay.ts';
import type { PayLimits } from '../src/pay.ts';
import { parseRequest } from '../src/request.ts';
import { Stop } from '../src/util.ts';
import { NEAR_USDC, startFakeApi } from './fakeApi.ts';
import type { FakeAnswer, FakeApi, PaidFailure, Unpaid } from './fakeApi.ts';
import { startFakeNearRpc } from './fakeNearRpc.ts';
import type { FakeNearRpc } from './fakeNearRpc.ts';
import { captureIo, expectNoKeyIn, localFetch, nearTestKey, waitUntil, withoutTimes } from './helpers.ts';
import type { IoOptions } from './helpers.ts';

// Made up: the payer, the API's NEAR account, and the hosts the https URLs stand for
const ACCOUNT = 'alice.near';
const PAY_TO = 'seller.example.near';
const API = 'https://api.example.test';
const CMC = 'https://pro-api.coinmarketcap.com';
const PAY = 'https://pay.example.test';
const DEFAULT_PAY = 'https://pay.anyfare.agents.bakingbad.dev';
const CHECK = 'https://nearblocks.io/address/alice.near shows your payments';
const { secretKey: KEY, publicKey: PUBLIC_KEY } = nearTestKey();

/** USDC on NEAR as an API offers it. The amount is made up: 10000 is $0.01. */
const nearOption = (amount = '10000', change: Record<string, unknown> = {}): Record<string, unknown> => ({
  scheme: 'exact',
  network: 'near:mainnet',
  asset: NEAR_USDC,
  amount,
  payTo: PAY_TO,
  maxTimeoutSeconds: 300,
  extra: {},
  ...change,
});

/**
 * The shape of the real 402 of CoinMarketCap, 2026-11-11: 7 options, 1 on Base, 6 on BNB Chain of 4
 * tokens. The amounts and addresses are as in its 402; the extra fields are cut short.
 */
const CMC_ACCEPTS: Record<string, unknown>[] = [
  ['eip155:56', '0xcE24439F2D9C6a2289F741120FE202248B666666', '10000000000000000', 'United Stables'],
  ['eip155:56', '0xcE24439F2D9C6a2289F741120FE202248B666666', '10000000000000000', 'United Stables'],
  ['eip155:8453', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', '10000', 'USD Coin'],
  ['eip155:56', '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', '10000000000000000', 'USD Coin'],
  ['eip155:56', '0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d', '10000000000000000', 'World Liberty Financial USD'],
  ['eip155:56', '0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d', '10000000000000000', 'World Liberty Financial USD'],
  ['eip155:56', '0x55d398326f99059fF775485246999027B3197955', '10000000000000000', 'Tether USD'],
].map(([network, asset, amount, name]) => ({
  scheme: 'exact',
  network,
  asset,
  payTo: '0x3C5f3a6cE224BB89D72f5EB4232ecC27F67B3eeA',
  maxTimeoutSeconds: 30,
  extra: { name, version: '1' },
  amount,
}));

let api: FakeApi;
let rpc: FakeNearRpc;

beforeAll(async () => {
  [api, rpc] = await Promise.all([startFakeApi(), startFakeNearRpc()]);
  // The NEAR signer reads from its RPC with the global fetch: only 127.0.0.1 is reachable from here
  vi.stubGlobal('fetch', localFetch());
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await Promise.all([api.close(), rpc.close()]);
});
beforeEach(() => {
  api.reset();
  api.chain = rpc;
  rpc.height = 180_000_000n;
  rpc.chainId = 'mainnet';
  rpc.nextHeights.length = 0;
  rpc.failing = undefined;
  rpc.calls.length = 0;
  rpc.addAccessKey(ACCOUNT, PUBLIC_KEY, 41n);
  // Made up: 0.99 USDC and 0.12 NEAR
  rpc.setBalance(ACCOUNT, 990_000n, 120_000_000_000_000_000_000_000n);
});

const wallet = (): Record<string, string> => ({ NEAR_ACCOUNT_ID: ACCOUNT, NEAR_PRIVATE_KEY: KEY, NEAR_RPC_URL: rpc.url });
const forwarding = (): Fetch => localFetch({ [API]: api.url, [CMC]: api.url, [PAY]: api.url });

/** Runs the app, and checks that no output holds a part of the key. */
async function run(argv: readonly string[], env: Record<string, string> = wallet(), options: IoOptions & { readonly fetch?: Fetch } = {}) {
  const io = captureIo(options.fetch ?? forwarding(), env, options);
  const code = await runCli(argv, io.io);
  const result = { code, out: io.out(), err: io.err() };
  expectNoKeyIn(`${result.out}\n${result.err}`, KEY, { known: api.settled.map((item) => item.transaction) });
  return result;
}

/** `payRequest` with its time limits set, for the cases that wait for one. */
async function pay(line: readonly string[], limits: PayLimits, env: Record<string, string> = wallet()) {
  const io = captureIo(forwarding(), env);
  const ctx = createContext(io.io);
  let failure: unknown;
  try {
    await payRequest(ctx, loadConfig(env), parseRequest(line), { yes: true, dryRun: false, full: false }, limits);
  } catch (error) {
    failure = error;
  } finally {
    ctx.close();
  }
  return { failure, out: io.out(), err: io.err() };
}

const route = (path: string, unpaid: Unpaid, method = 'GET', paid?: FakeAnswer): void =>
  api.route({ method, path, unpaid, ...(paid !== undefined && { paid }) });
const payable = (path = '/v1/quote', option = nearOption(), method = 'GET'): void => route(path, { kind: 'x402', accepts: [option] }, method);

/** The NEAR RPC's calls that only signing makes: the chain and the height the app reads, and the signer's reads. */
const signingCalls = () =>
  rpc.calls.filter(
    (call) =>
      call.method === 'status' || call.method === 'block' || (call.params as Record<string, unknown> | undefined)?.['request_type'] === 'view_access_key',
  );

/** Nothing was signed and nothing paid was sent. */
function expectNothingSigned(): void {
  expect(signingCalls()).toEqual([]);
  expect(api.paidRequests()).toEqual([]);
}

/** JSON nested 20000 deep: 40 KB that a naive indent would grow past any string's length. */
const DEEP = `${'['.repeat(20_000)}1${']'.repeat(20_000)}`;
/** Its one line in the block: its own text, cut at 200 characters. */
const DEEP_LINE = ` │ ${'['.repeat(200)}…`;
/** A body over the 10 MB read: made up, 10.5 MB of lines. */
const HUGE = `${'made up line of a large answer\n'.repeat(350_000)}`;
const TOO_LARGE = 'The answer is larger than 10 MB; the rest was not read.\n';

const PLAN = [
  '▸ The API asks   0.01 USDC on NEAR',
  '  Pay to         seller.example.near',
  "  Gas            none: the API's facilitator pays it",
  '  Valid for      300 blocks, about 3 minutes',
  '  Your cap       $0.02 ✔',
  '  Your balance   0.990000 USDC ✔',
];

describe('a free answer', () => {
  it('prints the result block and says nothing was paid, after one request', async () => {
    route('/v1/free', { kind: 'answer', answer: { status: 200, body: '{"symbol":"BTC","price":"made up"}' } });
    const result = await run([`${API}/v1/free`]);
    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    expect(withoutTimes(result.out)).toBe(
      [' Result · HTTP 200 · application/json · T s', ' │ {', ' │   "symbol": "BTC",', ' │   "price": "made up"', ' │ }', '✔ Free: nothing paid.', ''].join('\n'),
    );
    expect(api.requests).toHaveLength(1);
    expect(api.requests[0]).toMatchObject({ method: 'GET', path: '/v1/free' });
    expect(api.requests[0]?.headers['user-agent']).toBe('x402-near-wallet/0.1.0');
    expect(rpc.calls).toEqual([]);
  });

  it('takes a redirect as an answer, and never follows it', async () => {
    route('/v1/moved', { kind: 'answer', answer: { status: 302, contentType: null, body: '', headers: { location: `${API}/v1/free` } } });
    const result = await run([`${API}/v1/moved`]);
    expect(result.code).toBe(0);
    expect(withoutTimes(result.out)).toBe([' Result · HTTP 302 · no content type · T s', ' │ (empty)', '✔ Free: nothing paid.', ''].join('\n'));
    expect(api.requests).toHaveLength(1);
  });

  it('prints the block, then fails, for an error that is not a 402', async () => {
    route('/v1/missing', { kind: 'answer', answer: { status: 404, contentType: 'text/plain', body: 'Made up: no such pair' } });
    const result = await run([`${API}/v1/missing`]);
    expect(result.code).toBe(1);
    expect(withoutTimes(result.out)).toBe([' Result · HTTP 404 · text/plain · T s', ' │ Made up: no such pair', ''].join('\n'));
    expect(result.err).toBe('✘ The API answered 404. Nothing paid.\n');
  });

  it('says in one line that the API could not be reached', async () => {
    const result = await run([`${API}/v1/free`], wallet(), { fetch: localFetch({ [API]: 'http://127.0.0.1:9' }) });
    expect(result.code).toBe(1);
    expect(result.out).toBe('');
    expect(result.err).toMatch(/^✘ Could not reach api\.example\.test: [^\n]+\. Nothing paid\.\n$/);
  });
});

describe('an API this app does not pay', () => {
  const notSupported = async (unpaid: Unpaid, url = `${API}/v1/quote`, argv: readonly string[] = []) => {
    route(new URL(url).pathname, unpaid);
    const result = await run([...argv, url]);
    expect(result.code).toBe(3);
    expectNothingSigned();
    expect(rpc.calls).toEqual([]);
    return result;
  };
  const hint = (link: string): string => `  Through Anyfare it takes NEAR:\n  ${link}\n`;

  it("names what CoinMarketCap's real 402 takes, and the same request through Anyfare", async () => {
    const url = `${CMC}/x402/v3/cryptocurrency/quotes/latest?symbol=BTC&convert=USD`;
    const result = await notSupported({ kind: 'x402', accepts: CMC_ACCEPTS }, url);
    expect(result.err).toBe("✘ Not supported: this API doesn't take NEAR. It takes USDC on Base, and 4 tokens on BNB Chain. Nothing paid.\n");
    expect(result.out).toBe(hint(`${DEFAULT_PAY}/pro-api.coinmarketcap.com/x402/v3/cryptocurrency/quotes/latest?symbol=BTC&convert=USD`));
    expect(api.requests).toHaveLength(1);
  });

  it('lists each network once, known ones first, and joins three with commas', async () => {
    const accepts = [
      { scheme: 'exact', network: 'made-up:chain', asset: 'MadeUpToken', amount: '1', payTo: 'x' },
      { scheme: 'exact', network: 'eip155:56', asset: '0x55d398326f99059fF775485246999027B3197955', amount: '1', payTo: 'x' },
      { scheme: 'exact', network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', amount: '1', payTo: 'x' },
    ];
    const result = await notSupported({ kind: 'x402', accepts });
    expect(result.err).toBe("✘ Not supported: this API doesn't take NEAR. It takes USDT on BNB Chain, USDC on Solana, and MadeUpToken on made-up:chain. Nothing paid.\n");
  });

  it('names a NEAR scheme other than exact', async () => {
    const result = await notSupported({ kind: 'x402', accepts: [nearOption('10000', { scheme: 'upto' })] });
    expect(result.err).toBe('✘ Not supported: it asks for the upto scheme on NEAR. This app pays exact only. Nothing paid.\n');
    expect(result.out).toBe(hint(`${DEFAULT_PAY}/api.example.test/v1/quote`));
  });

  it('names a NEAR token other than USDC', async () => {
    const tether = nearOption('10000', { asset: 'usdt.tether-token.near', extra: { name: 'Tether USD' } });
    const result = await notSupported({ kind: 'x402', accepts: [tether] });
    expect(result.err).toBe('✘ Not supported: it asks for Tether USD on NEAR. This app pays USDC only. Nothing paid.\n');
    expect(result.out).toBe(hint(`${DEFAULT_PAY}/api.example.test/v1/quote`));
  });

  it.each<[string, Unpaid, string]>([
    ['an MPP challenge only', { kind: 'mpp' }, 'Not supported: no x402 payment request.'],
    ['a PAYMENT-REQUIRED that does not decode', { kind: 'broken-header' }, 'Not supported: no x402 payment request.'],
    ['x402 version 1 in the body', { kind: 'x402', accepts: [nearOption()], in: 'body', version: 1 }, 'Not supported: it asks for x402 version 1. This app pays version 2.'],
  ])('says there is no x402 v2 request for %s', async (_what, unpaid, line) => {
    const result = await notSupported(unpaid);
    expect(result.err).toBe(`✘ ${line} Nothing paid.\n`);
    expect(result.out).toBe(hint(`${DEFAULT_PAY}/api.example.test/v1/quote`));
  });

  it.each<[string, Record<string, unknown>[], string]>([
    ['valid for more than 300 seconds', [nearOption('10000', { maxTimeoutSeconds: 301 })], 'asks for a payment valid for more than 300 seconds'],
    ['to no NEAR account', [nearOption('10000', { payTo: 'Not An Account' })], 'has no recipient this app can read'],
    ['of no amount', [nearOption('0')], 'has no amount this app can read'],
    ['the first refusal of two', [nearOption('10000', { maxTimeoutSeconds: 3000 }), nearOption('1.5')], 'asks for a payment valid for more than 300 seconds'],
    ['in a payment flow it does not sign', [nearOption('10000', { extra: { paymentFlow: 'escrow' } })], "asks for a payment flow this app doesn't sign"],
  ])('refuses USDC on NEAR %s, with no hint', async (_what, accepts, why) => {
    const result = await notSupported({ kind: 'x402', accepts });
    expect(result.err).toBe(`✘ Not supported: the API's NEAR option ${why}, so the app won't sign it. Nothing paid.\n`);
    expect(result.out).toBe('');
  });
});

describe('the hint through Anyfare', () => {
  beforeEach(() => {
    route('/v1/quote', { kind: 'x402', accepts: CMC_ACCEPTS }, 'POST');
    route('/api.example.test/v1/quote', { kind: 'x402', accepts: CMC_ACCEPTS });
  });

  it('is the whole request, with only the URL changed, to paste back', async () => {
    const result = await run(['-X', 'POST', '--json', '{"accountId":"anyfare.near"}', `${API}/v1/quote`]);
    expect(result.code).toBe(3);
    expect(result.out).toBe(`  Through Anyfare it takes NEAR:\n  -X POST --json '{"accountId":"anyfare.near"}' ${DEFAULT_PAY}/api.example.test/v1/quote\n`);
  });

  it('quotes a URL with a query, and drops a leading curl and the app options', async () => {
    route('/v1/quote', { kind: 'x402', accepts: CMC_ACCEPTS });
    const result = await run(['curl', '-sS', `${API}/v1/quote?a=1&b=2`, '--max', '0.05']);
    expect(result.out).toBe(`  Through Anyfare it takes NEAR:\n  -sS '${DEFAULT_PAY}/api.example.test/v1/quote?a=1&b=2'\n`);
  });

  it('points at ANYFARE_PAY_URL', async () => {
    route('/v1/quote', { kind: 'x402', accepts: CMC_ACCEPTS });
    const result = await run([`${API}/v1/quote`], { ...wallet(), ANYFARE_PAY_URL: 'https://pay.example.test/' });
    expect(result.code).toBe(3);
    expect(result.out).toBe('  Through Anyfare it takes NEAR:\n  https://pay.example.test/api.example.test/v1/quote\n');
  });

  it.each([`/v1/tx/0x${'ab'.repeat(32)}`, '/v1/leaf_nodes_by_height', `/v1/af_live_${'A'.repeat(43)}`])(
    'keeps a URL whole that holds what looks like a key: %s',
    async (path) => {
      route(path, { kind: 'x402', accepts: CMC_ACCEPTS });
      const result = await run([`${API}${path}`]);
      expect(result.code).toBe(3);
      expect(result.out).toBe(`  Through Anyfare it takes NEAR:\n  ${DEFAULT_PAY}/api.example.test${path}\n`);
    },
  );

  it('is left out for a URL on the pay host, and for a plain http one', async () => {
    const onPayHost = await run([`${PAY}/api.example.test/v1/quote`], { ...wallet(), ANYFARE_PAY_URL: PAY });
    expect(onPayHost.code).toBe(3);
    expect(onPayHost.out).toBe('');
    const plain = await run([`${api.url}/api.example.test/v1/quote`]);
    expect(plain.code).toBe(3);
    expect(plain.out).toBe('');
  });
});

describe("Anyfare's own error on the unpaid request", () => {
  it.each([
    ['host_not_allowed', "Anyfare doesn't route payments to this API's host"],
    ['not_payable', "The API didn't ask for a payment, so there is nothing for Anyfare to pay"],
  ])('says %s in its line, and that nothing was paid', async (code, line) => {
    route('/api.example.test/v1/quote', { kind: 'envelope', status: 400, code, message: 'Made up' });
    const result = await run([`${api.url}/api.example.test/v1/quote`], { ...wallet(), ANYFARE_PAY_URL: api.url });
    expect(result.code).toBe(1);
    expect(result.out).toBe('');
    expect(result.err).toBe(`✘ ${line}. Nothing paid.\n`);
  });

  it("shows the API's own error passed through, as any other API's", async () => {
    route('/api.example.test/v1/quote', { kind: 'envelope', status: 404, code: 'not_found', message: 'Made up' });
    const result = await run([`${api.url}/api.example.test/v1/quote`], { ...wallet(), ANYFARE_PAY_URL: api.url });
    expect(result.code).toBe(1);
    expect(result.out).toContain(' │   "error": {');
    expect(result.err).toBe('✘ The API answered 404. Nothing paid.\n');
  });
});

describe('the checks before signing', () => {
  it('refuses above the cap of MAX_PAYMENT_USD: nothing signed', async () => {
    payable('/v1/quote', nearOption('50000'));
    const result = await run([`${API}/v1/quote`, '--yes']);
    expect(result.code).toBe(1);
    expect(result.out).toContain('▸ The API asks   0.05 USDC on NEAR\n');
    expect(result.out).toContain('  Your cap       $0.02 ✘\n');
    expect(result.err).toBe('✘ Costs $0.05, above your cap of $0.02. Nothing paid. Raise MAX_PAYMENT_USD to pay it.\n');
    expectNothingSigned();
  });

  it('refuses above the cap of --max, and names it', async () => {
    payable('/v1/quote', nearOption('50000'));
    const result = await run([`${API}/v1/quote`, '--yes', '--max', '0.03'], { ...wallet(), MAX_PAYMENT_USD: '1' });
    expect(result.code).toBe(1);
    expect(result.out).toContain('  Your cap       $0.03 ✘\n');
    expect(result.err).toBe('✘ Costs $0.05, above your cap of $0.03. Nothing paid. Use a higher --max to pay it.\n');
    expectNothingSigned();
  });

  it('refuses when the wallet holds less: nothing signed', async () => {
    rpc.setBalance(ACCOUNT, 5_000n, 1n);
    payable();
    const result = await run([`${API}/v1/quote`, '--yes']);
    expect(result.code).toBe(1);
    expect(result.out).toContain('  Your balance   0.005000 USDC ✘\n');
    expect(result.err).toBe('✘ Costs 0.01 USDC. The wallet holds 0.005. Nothing paid.\n');
    expectNothingSigned();
  });

  it('needs the key to pay, before the plan', async () => {
    payable();
    const { NEAR_PRIVATE_KEY: _key, ...withoutKey } = wallet();
    const result = await run([`${API}/v1/quote`, '--yes'], withoutKey);
    expect(result.code).toBe(1);
    expect(result.out).toBe('');
    expect(result.err).toBe('✘ NEAR_PRIVATE_KEY is not set. Add it to .env.local: a full-access key of alice.near, ed25519: and base58. Nothing paid.\n');
    expectNothingSigned();
  });
});

describe('--dry-run', () => {
  it('shows the plan and what it would pay, with the account and no key: nothing signed', async () => {
    payable();
    const result = await run([`${API}/v1/quote`, '--dry-run'], { NEAR_ACCOUNT_ID: ACCOUNT, NEAR_RPC_URL: rpc.url });
    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    expect(result.out).toBe([...PLAN, '✔ Would pay 0.01 USDC on NEAR to seller.example.near. Not paid.', ''].join('\n'));
    expect(rpc.balanceReads()).toHaveLength(2);
    expectNothingSigned();
  });

  it('works with no account: the balance is not read', async () => {
    payable();
    const result = await run([`${API}/v1/quote`, '--dry-run'], { NEAR_RPC_URL: rpc.url });
    expect(result.code).toBe(0);
    expect(result.out).toContain('  Your balance   not read: NEAR_ACCOUNT_ID is not set\n');
    expect(result.out).toContain('✔ Would pay 0.01 USDC on NEAR to seller.example.near. Not paid.\n');
    expect(result.err).toBe('');
    expect(rpc.calls).toEqual([]);
  });

  it('never looks at the key, whatever it is', async () => {
    payable();
    const result = await run([`${API}/v1/quote`, '--dry-run'], { NEAR_ACCOUNT_ID: ACCOUNT, NEAR_RPC_URL: rpc.url, NEAR_PRIVATE_KEY: 'garbage-made-up-key' });
    expect(result.code).toBe(0);
    expect(`${result.out}${result.err}`).not.toContain('garbage');
    expectNothingSigned();
  });

  it('refuses an account that is not one', async () => {
    payable();
    const result = await run([`${API}/v1/quote`, '--dry-run'], { NEAR_ACCOUNT_ID: 'Alice.NEAR', NEAR_RPC_URL: rpc.url });
    expect(result.code).toBe(1);
    expect(result.err).toBe('✘ NEAR_ACCOUNT_ID is not a NEAR account ID, such as alice.near. Check .env.local. Nothing paid.\n');
  });

  it('runs the cap and balance checks of a real run', async () => {
    payable('/v1/quote', nearOption('50000'));
    const result = await run([`${API}/v1/quote`, '--dry-run'], { NEAR_ACCOUNT_ID: ACCOUNT, NEAR_RPC_URL: rpc.url });
    expect(result.code).toBe(1);
    expect(result.err).toBe('✘ Costs $0.05, above your cap of $0.02. Nothing paid. Raise MAX_PAYMENT_USD to pay it.\n');
  });

  it('warns once when the balance could not be read, and goes on', async () => {
    payable();
    rpc.failing = { status: 503 };
    const host = new URL(rpc.url).host;
    const result = await run([`${API}/v1/quote`, '--dry-run'], { NEAR_ACCOUNT_ID: ACCOUNT, NEAR_RPC_URL: rpc.url });
    expect(result.code).toBe(0);
    expect(result.out).toContain(`  Your balance   not read: the NEAR RPC at ${host} answered 503\n`);
    expect(result.err).toBe(
      `Could not read the wallet's balance: the NEAR RPC at ${host} answered 503. The facilitator refuses a payment the wallet can't cover.\n`,
    );
  });
});

describe('the question', () => {
  it('is a usage error with no terminal and no --yes: nothing signed', async () => {
    payable();
    const result = await run([`${API}/v1/quote`]);
    expect(result.code).toBe(2);
    expect(result.err).toBe('✘ This request costs 0.01 USDC. Add --yes to pay without a terminal, or --dry-run to see the cost. Nothing paid.\n');
    expectNothingSigned();
  });

  it('pays nothing on a "no" at a terminal', async () => {
    payable();
    const result = await run([`${API}/v1/quote`], wallet(), { isTerminal: true, input: 'n\n' });
    expect(result.code).toBe(1);
    expect(result.out).toBe([...PLAN, '', 'Pay 0.01 USDC on NEAR? [y/N] '].join('\n'));
    expect(result.err).toBe('✘ Nothing paid.\n');
    expectNothingSigned();
  });

  it('pays nothing when the input ends', async () => {
    payable();
    const result = await run([`${API}/v1/quote`], wallet(), { isTerminal: true, input: '' });
    expect(result.code).toBe(1);
    expect(result.err).toBe('✘ No more input. Nothing paid.\n');
    expectNothingSigned();
  });

  it('pays on a "y" at a scripted terminal', async () => {
    payable();
    const result = await run([`${API}/v1/quote`], wallet(), { isTerminal: true, input: 'y\n' });
    expect(result.code).toBe(0);
    expect(result.out).toContain('Pay 0.01 USDC on NEAR? [y/N] ▸ Signing a transfer of 0.01 USDC to seller.example.near\n');
    expect(result.out).toContain('✔ You paid 0.01 USDC on NEAR.\n');
    expect(api.paidRequests()).toHaveLength(1);
    expect(api.settled).toHaveLength(1);
  });
});

describe('a payment', () => {
  it('signs with the NEAR SDK, is checked by the fake, and shows the result, the proof and the balance after', async () => {
    payable();
    const result = await run([`${API}/v1/quote?symbol=BTC`, '--yes']);
    expect(result.err).toBe('');
    expect(result.code).toBe(0);
    expect(api.settled).toHaveLength(1);
    const [settled] = api.settled;
    const tx = settled?.transaction ?? '';
    expect(settled).toMatchObject({ payer: ACCOUNT, payTo: PAY_TO, amount: '10000' });
    expect(withoutTimes(result.out)).toBe(
      [
        ...PLAN,
        '▸ Signing a transfer of 0.01 USDC to seller.example.near',
        '▸ Calling GET api.example.test/v1/quote',
        ' Result · HTTP 200 · application/json · T s',
        ' │ {',
        ' │   "symbol": "BTC",',
        ' │   "price": "made up"',
        ' │ }',
        ' Proof',
        ` │ Transaction   ${tx}`,
        ` │ Explorer      https://nearblocks.io/txns/${tx}`,
        ' │ Network       near:mainnet',
        ' │ Payer         alice.near',
        '✔ You paid 0.01 USDC on NEAR.',
        '',
        'Balance   0.980000 USDC (−0.01) · 0.1200 NEAR',
        '',
      ].join('\n'),
    );
    // Two requests: the unpaid one, then the same with the payment
    expect(api.requests).toHaveLength(2);
    const [first, second] = api.requests;
    expect(first?.headers['payment-signature']).toBeUndefined();
    expect(second?.headers['payment-signature']).toMatch(/^[A-Za-z0-9+/]+=*$/);
    const { 'payment-signature': _signature, ...rest } = second?.headers ?? {};
    expect(rest).toEqual(first?.headers);
    expect(second).toMatchObject({ method: first?.method, path: first?.path, body: first?.body });
    // The app's reads: the balance twice, the chain and the height; the signer's: the height and the key
    expect(rpc.calls.map((call) => call.method).sort()).toEqual(['block', 'block', 'query', 'query', 'query', 'query', 'query', 'status']);
  });

  it('sends a POST with the same method, headers and body twice', async () => {
    payable('/v1/quote', nearOption(), 'POST');
    const result = await run(['-X', 'POST', '-H', 'X-Made-Up: 1', '--json', '{"symbol":"BTC"}', `${API}/v1/quote`, '--yes']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('▸ Calling POST api.example.test/v1/quote\n');
    expect(api.requests).toHaveLength(2);
    const [first, second] = api.requests;
    expect(first).toMatchObject({ method: 'POST', body: '{"symbol":"BTC"}' });
    expect(first?.headers).toMatchObject({ 'content-type': 'application/json', accept: 'application/json', 'x-made-up': '1' });
    const { 'payment-signature': _signature, ...rest } = second?.headers ?? {};
    expect(rest).toEqual(first?.headers);
    expect(second).toMatchObject({ method: 'POST', body: '{"symbol":"BTC"}' });
  });

  it('pays the lowest of the USDC options on NEAR, the first on a tie', async () => {
    const options = [nearOption('15000'), nearOption('9000', { payTo: 'cheap.example.near' }), nearOption('9000', { payTo: 'later.example.near' })];
    route('/v1/quote', { kind: 'x402', accepts: options });
    const result = await run([`${API}/v1/quote`, '--yes']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('▸ The API asks   0.009 USDC on NEAR\n  Pay to         cheap.example.near\n');
    expect(api.settled[0]).toMatchObject({ payTo: 'cheap.example.near', amount: '9000' });
  });

  it('takes the options from the JSON body when there is no PAYMENT-REQUIRED', async () => {
    route('/v1/quote', { kind: 'x402', accepts: [nearOption()], in: 'body' });
    const result = await run([`${API}/v1/quote`, '--yes']);
    expect(result.code).toBe(0);
    expect(api.settled).toHaveLength(1);
  });

  it('pays through Anyfare, the pay host, as any API', async () => {
    payable('/api.example.test/v1/quote', nearOption('10000', { payTo: 'pay.anyfare.near' }));
    const result = await run([`${api.url}/api.example.test/v1/quote`, '--yes'], { ...wallet(), ANYFARE_PAY_URL: api.url });
    expect(result.code).toBe(0);
    expect(result.out).toContain(`▸ Calling GET ${new URL(api.url).host}/api.example.test/v1/quote\n`);
    expect(api.settled).toHaveLength(1);
  });

  it('shows (not final yet) for a pending settlement, and warns about what is not the payment', async () => {
    payable();
    const transaction = 'MadeUpPendingHashForTheTest11111111';
    const receipt = Buffer.from(
      JSON.stringify({ success: false, errorReason: 'settlement_pending', transaction, network: 'near:testnet', payer: 'bob.near' }),
    ).toString('base64');
    api.route({ method: 'GET', path: '/v1/quote', unpaid: { kind: 'x402', accepts: [nearOption()] }, paid: { status: 200, body: '{}', headers: { 'payment-response': receipt } } });
    // The fake's own PAYMENT-RESPONSE is set after the route's: send the route's instead
    api.nextFailure = 'no_receipt';
    const result = await run([`${API}/v1/quote`, '--yes']);
    expect(result.code).toBe(0);
    expect(result.out).toContain(` │ Transaction   ${transaction} (not final yet)\n │ Explorer      https://nearblocks.io/txns/${transaction}\n │ Network       near:testnet\n │ Payer         bob.near\n`);
    expect(result.err).toBe(
      'The PAYMENT-RESPONSE names another network, near:testnet, not NEAR.\nThe PAYMENT-RESPONSE names another payer, bob.near, not alice.near.\n',
    );
  });
});

describe('a paid request that fails', () => {
  const throughAnyfare = async (failure: PaidFailure) => {
    payable('/api.example.test/v1/quote', nearOption('10000', { payTo: 'pay.anyfare.near' }));
    api.nextFailure = failure;
    const result = await run([`${api.url}/api.example.test/v1/quote`, '--yes'], { ...wallet(), ANYFARE_PAY_URL: api.url });
    // Sent once, whatever happened
    expect(api.paidRequests()).toHaveLength(1);
    return result;
  };

  it.each<[PaidFailure, string]>([
    ['in_flight', 'Your NEAR account has another payment in flight. Wait until it settles, then run the call again. Not charged.'],
    [
      'used_before',
      `Anyfare says this payment was used before, and took nothing for this request. Whether the other use was paid is not known: ${CHECK}.`,
    ],
    ['payment_unavailable', "Anyfare couldn't take a NEAR payment now, so nothing was paid; retry in 2 seconds. Not charged."],
    [
      'settlement_failed',
      `The payment couldn't be settled, and the answer was not sent. Check the wallet (${CHECK}); Anyfare repeats an unknown settlement and charges at most once.`,
    ],
  ])("says Anyfare's %s in one line, with what is known of the charge", async (failure, line) => {
    const result = await throughAnyfare(failure);
    expect(result.code).toBe(1);
    expect(result.err).toBe(`✘ ${line}\n`);
    expect(result.out).not.toContain('Result');
    expect(result.out).not.toContain('You paid');
  });

  it("shows a 500 of Anyfare's that is no envelope, and says the charge is not known", async () => {
    const result = await throughAnyfare('plain_500');
    expect(result.code).toBe(1);
    expect(withoutTimes(result.out)).toContain(' Result · HTTP 500 · text/plain · T s\n │ Made-up failure of the API\n');
    expect(result.err).toBe(`✘ Anyfare answered 500. Whether the payment was taken is not known: ${CHECK}.\n`);
  });

  it('says Anyfare asked again for a 402 with no envelope: not charged', async () => {
    const result = await throughAnyfare('bare_402');
    expect(result.code).toBe(1);
    expect(result.out).toContain(' │   "message": "Made up: the payment was not taken"\n');
    expect(result.err).toBe('✘ Anyfare asked for a payment again: the payment was not accepted. Not charged.\n');
  });

  it('says the charge is not known when the connection drops after the request', async () => {
    const result = await throughAnyfare('drop');
    expect(result.code).toBe(1);
    expect(result.err).toMatch(new RegExp(`^✘ Could not reach 127\\.0\\.0\\.1:\\d+: [^\\n]+\\. Whether the call was paid is not known: ${CHECK.replaceAll('.', '\\.')}\\.\\n$`));
    expect(result.err).not.toContain('Not charged');
  });

  it("never says Not charged for another API's 500", async () => {
    payable();
    api.nextFailure = 'plain_500';
    const result = await run([`${API}/v1/quote`, '--yes']);
    expect(result.code).toBe(1);
    expect(result.out).toContain(' │ Made-up failure of the API\n');
    expect(result.err).toBe(`✘ The API answered 500. Whether the payment was taken is not known: ${CHECK}.\n`);
    expect(api.paidRequests()).toHaveLength(1);
  });

  it("says another API's 402 again did not accept the payment, and that whether it was taken is not known", async () => {
    payable();
    api.nextFailure = 'bare_402';
    const result = await run([`${API}/v1/quote`, '--yes']);
    expect(result.code).toBe(1);
    expect(result.err).toBe(`✘ The API answered 402 again: it did not accept the payment. Whether it was taken is not known: ${CHECK}.\n`);
    expect(result.err).not.toContain('Not charged');
    expect(api.paidRequests()).toHaveLength(1);
  });

  it("says another API's error envelope is not known, never Anyfare's", async () => {
    payable();
    api.nextFailure = 'payment_unavailable';
    const result = await run([`${API}/v1/quote`, '--yes']);
    expect(result.code).toBe(1);
    expect(result.out).toContain('"code": "payment_unavailable"');
    expect(result.err).toBe(`✘ The API answered 503. Whether the payment was taken is not known: ${CHECK}.\n`);
  });

  it('says the request was never sent, not charged, when it could not connect', async () => {
    payable();
    const local = forwarding();
    // The unpaid request goes; the paid one finds no host
    const refusing = (async (input: string | URL | Request, init?: RequestInit) => {
      if (new Headers(init?.headers).has('payment-signature')) {
        throw new TypeError('fetch failed', { cause: Object.assign(new Error('Made up: connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
      }
      return local(input, init);
    }) as Fetch;
    const result = await run([`${API}/v1/quote`, '--yes'], wallet(), { fetch: refusing });
    expect(result.code).toBe(1);
    expect(result.err).toBe('✘ Could not reach api.example.test: ECONNREFUSED. The request was never sent. Not charged.\n');
  });

  it('says a 2xx whose body broke was most likely paid', async () => {
    payable();
    const local = forwarding();
    const broken = (async (input: string | URL | Request, init?: RequestInit) => {
      if (!new Headers(init?.headers).has('payment-signature')) return local(input, init);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new TypeError('terminated', { cause: Object.assign(new Error('Made up: reset'), { code: 'ECONNRESET' }) }));
        },
      });
      return new Response(body, { status: 200 });
    }) as Fetch;
    const result = await run([`${API}/v1/quote`, '--yes'], wallet(), { fetch: broken });
    expect(result.code).toBe(1);
    expect(result.err).toBe(
      `✘ api.example.test answered 200, but its body broke: ECONNRESET. The call was most likely paid, and its answer is lost: ${CHECK}.\n`,
    );
  });

  it('says the charge is not known when the paid request times out', async () => {
    payable();
    api.nextFailure = 'hang';
    const result = await pay([`${API}/v1/quote`], { paidMs: 300 });
    expect(result.failure).toBeInstanceOf(Stop);
    expect((result.failure as Stop).line()).toBe(`api.example.test did not answer within 300 ms. Whether the call was paid is not known: ${CHECK}.`);
    expect(api.paidRequests()).toHaveLength(1);
  });
});

describe('an answer that is hard to show', () => {
  it('shows a deeply nested free answer as its own text', async () => {
    route('/v1/deep', { kind: 'answer', answer: { status: 200, body: DEEP } });
    const result = await run([`${API}/v1/deep`]);
    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    expect(withoutTimes(result.out)).toBe([' Result · HTTP 200 · application/json · T s', DEEP_LINE, '✔ Free: nothing paid.', ''].join('\n'));
  });

  it('shows a deeply nested error answer, then the failure', async () => {
    route('/v1/deep', { kind: 'answer', answer: { status: 404, body: DEEP } });
    const result = await run([`${API}/v1/deep`]);
    expect(result.code).toBe(1);
    expect(result.out).toContain(`${DEEP_LINE}\n`);
    expect(result.err).toBe('✘ The API answered 404. Nothing paid.\n');
  });

  it('reports a paid, deeply nested answer whole: the proof, the payment and the balance', async () => {
    api.route({ method: 'GET', path: '/v1/quote', unpaid: { kind: 'x402', accepts: [nearOption()] }, paid: { status: 200, body: DEEP } });
    const result = await run([`${API}/v1/quote`, '--yes']);
    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    const tx = api.settled[0]?.transaction ?? '';
    expect(result.out).toContain(`${DEEP_LINE}\n Proof\n │ Transaction   ${tx}\n`);
    expect(result.out).toContain('✔ You paid 0.01 USDC on NEAR.\n\nBalance   0.980000 USDC (−0.01) · 0.1200 NEAR\n');
    expect(api.paidRequests()).toHaveLength(1);
  });

  it('keeps the line about the payment after a paid, deeply nested error answer', async () => {
    api.route({ method: 'GET', path: '/v1/quote', unpaid: { kind: 'x402', accepts: [nearOption()] }, paid: { status: 500, body: DEEP } });
    const result = await run([`${API}/v1/quote`, '--yes']);
    expect(result.code).toBe(1);
    expect(result.out).toContain(`${DEEP_LINE}\n`);
    expect(result.err).toBe(`✘ The API answered 500. Whether the payment was taken is not known: ${CHECK}.\n`);
    expect(api.paidRequests()).toHaveLength(1);
  });

  it('reads 10 MB of a free answer and says the rest was not read', async () => {
    route('/v1/huge', { kind: 'answer', answer: { status: 200, contentType: 'text/plain', body: HUGE } });
    const result = await run([`${API}/v1/huge`]);
    expect(result.code).toBe(0);
    expect(result.err).toBe(TOO_LARGE);
    expect(result.out).toContain(' │ made up line of a large answer\n');
    expect(result.out).toMatch(/ │ … \d+ more lines\n✔ Free: nothing paid\.\n$/);
  });

  it('reports a paid answer over 10 MB as paid, not as a failure', async () => {
    api.route({
      method: 'GET',
      path: '/v1/quote',
      unpaid: { kind: 'x402', accepts: [nearOption()] },
      paid: { status: 200, contentType: 'text/plain', body: HUGE },
    });
    const result = await run([`${API}/v1/quote`, '--yes']);
    expect(result.code).toBe(0);
    expect(result.err).toBe(TOO_LARGE);
    expect(result.out).toContain(' Proof\n');
    expect(result.out).toContain('✔ You paid 0.01 USDC on NEAR.\n');
    expect(api.paidRequests()).toHaveLength(1);
  });
});

describe('a line typed on a terminal before the question', () => {
  it('answers nothing: a "y" typed before the plan appears pays nothing', async () => {
    payable();
    const io = captureIo(forwarding(), wallet(), { isTerminal: true, tty: true });
    // Typed and Enter, before the request and the plan
    io.stdin.write('y\n');
    let done = false;
    const running = runCli([`${API}/v1/quote`], io.io).then((code) => {
      done = true;
      return code;
    });
    await waitUntil(() => io.out().includes('Pay 0.01 USDC on NEAR? [y/N] '), 'the question');
    // Time enough for the dropped line to have answered, had it been kept
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(done).toBe(false);
    expectNothingSigned();
    io.stdin.end();
    expect(await running).toBe(1);
    expect(io.err()).toBe('✘ No more input. Nothing paid.\n');
    expectNothingSigned();
  });

  it('pays on a "y" typed once the question is there', async () => {
    payable();
    const io = captureIo(forwarding(), wallet(), { isTerminal: true, tty: true });
    const running = runCli([`${API}/v1/quote`], io.io);
    await waitUntil(() => io.out().includes('Pay 0.01 USDC on NEAR? [y/N] '), 'the question');
    io.stdin.write('y\n');
    expect(await running).toBe(0);
    expect(io.out()).toContain('✔ You paid 0.01 USDC on NEAR.\n');
    expect(api.paidRequests()).toHaveLength(1);
  });
});

describe('a paid answer without a proof', () => {
  it.each<[PaidFailure, string]>([
    ['no_receipt', `No PAYMENT-RESPONSE came with the answer: ${CHECK}.`],
    ['unreadable_receipt', `The PAYMENT-RESPONSE that came with the answer is unreadable: ${CHECK}.`],
    ['not_settled', `The PAYMENT-RESPONSE says the payment did not settle (invalid_transaction_state): ${CHECK}.`],
  ])('shows the answer for %s, with one warning, and does not say it was paid', async (failure, warning) => {
    payable();
    api.nextFailure = failure;
    const result = await run([`${API}/v1/quote`, '--yes']);
    expect(result.code).toBe(0);
    expect(result.err).toBe(`${warning}\n`);
    expect(result.out).toContain(' │   "price": "made up"\n');
    expect(result.out).not.toContain(' Proof');
    expect(result.out).toContain('✔ The API answered. Whether you paid 0.01 USDC on NEAR is not known.\n');
    expect(api.paidRequests()).toHaveLength(1);
  });
});

describe('the balance after', () => {
  it('says the payment may not show yet when the balance did not change', async () => {
    payable();
    const result = await run([`${API}/v1/quote`, '--yes'], wallet(), {
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        // The chain moves the USDC a moment later than this read
        const answer = await forwarding()(input, init);
        if (api.settled.length > 0) rpc.setBalance(ACCOUNT, 990_000n, 120_000_000_000_000_000_000_000n);
        return answer;
      }) as Fetch,
    });
    expect(result.code).toBe(0);
    expect(result.out).toContain('\n\nBalance   0.990000 USDC · 0.1200 NEAR (the payment may not show yet)\n');
  });
});
