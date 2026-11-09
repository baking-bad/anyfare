// The interactive mode, driven by scripted answers through stdin, against the fake Anyfare. Every key,
// address and price here is made up.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generatePrivateKey } from 'viem/accounts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.ts';
import { toAtomic } from '../src/util.ts';
import { forwardingFetch, startFakeAnyfare, toolRoutes, toolTargets } from './fakeAnyfare.ts';
import type { FakeAnyfare, FakeTarget } from './fakeAnyfare.ts';
import { captureIo, tempAppDir } from './helpers.ts';

const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
// Made up: where the fake Anyfare takes USDC on Base
const BASE_PAY_TO = '0x00000000000000000000000000000000000000b1';

/** The three tools as targets whose 402 also offers x402 on Base, at their made-up Credits price. */
function baseTargets(): Record<'cmc' | '3route' | 'evidence', FakeTarget> {
  const targets = toolTargets();
  const withBase = (target: FakeTarget): FakeTarget => ({
    ...target,
    x402: [
      {
        scheme: 'exact',
        network: 'eip155:8453',
        asset: BASE_USDC,
        amount: toAtomic(target.price, 6).toString(),
        payTo: BASE_PAY_TO,
        maxTimeoutSeconds: 300,
        extra: { name: 'USD Coin', version: '2', assetTransferMethod: 'eip3009' },
      },
    ],
  });
  return { cmc: withBase(targets.cmc), '3route': withBase(targets['3route']), evidence: withBase(targets.evidence) };
}

let fake: FakeAnyfare;
let app: { dir: string; remove: () => void };

beforeAll(async () => {
  fake = await startFakeAnyfare();
});
afterAll(async () => {
  await fake.close();
});
beforeEach(() => {
  fake.reset();
  for (const target of Object.values(baseTargets())) fake.addTarget(target);
  app = tempAppDir();
});
afterEach(() => {
  app.remove();
});

/** Runs the interactive mode with these answers, one for each line. */
async function session(answers: readonly string[], env: Record<string, string> = {}) {
  const { fetch } = forwardingFetch(toolRoutes());
  const io = captureIo(
    fetch,
    { ANYFARE_API_URL: fake.apiUrl, ANYFARE_PAY_URL: fake.payUrl, ...env },
    { appDir: app.dir, isTerminal: true, input: `${answers.join('\n')}\n` },
  );
  const code = await runCli([], io.io);
  return { code, out: io.out(), err: io.err() };
}

/** An account with a made-up balance and a payment key of it, as the settings would hold them. */
function funded(balance = '1'): Record<string, string> {
  const account = fake.addAccount(balance);
  const key = fake.addKey(account, { label: 'demo', dailyBudget: '1', maxPrice: '0.02' });
  return { ANYFARE_PAYMENT_KEY: key.key, ANYFARE_MASTER_KEY: account.masterKey };
}

const paidRequests = () => fake.routed().filter((item) => item.headers['authorization'] !== undefined);

function savedKeys(): Record<string, string> {
  const keys: Record<string, string> = {};
  for (const line of readFileSync(join(app.dir, '.env.local'), 'utf8').split('\n')) {
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) keys[match[1]] = match[2];
  }
  return keys;
}

describe('the interactive mode', () => {
  it('goes from nothing to a paid call with Credits: sign-up, a payment key, the explain lines, the answer', async () => {
    fake.startingBalance = '1';
    fake.rewrite.signup = (body) => ({ ...body, freeCredits: '0.10' });
    // CoinMarketCap, the default pair, Credits, sign up, make the key, pay, no more
    const result = await session(['1', '', '1', 'y', 'y', 'y', 'n']);
    expect(result.err).toBe('');
    expect(result.code).toBe(0);
    const { out } = result;

    // The title, and which Anyfare it talks to
    expect(out).toContain('Anyfare demo');
    expect(out).toContain(`Platform API  ${fake.apiUrl}`);
    expect(out).toContain(`Pay URL       ${fake.payUrl}`);
    // The tools, by their about line
    expect(out).toContain('1  CoinMarketCap: the latest price of a coin. Takes a pair, such as BTC/USD.');
    expect(out).toContain('2  3Route: best-priced crypto token swaps');
    expect(out).toContain('3  The evidence API: a NEAR account');
    expect(out).toContain('Pair [BTC/USD]');
    // The ways, with what each needs and whether it is set
    expect(out).toMatch(/1 {2}Credits {2}needs ANYFARE_PAYMENT_KEY {2}✘/);
    expect(out).toMatch(/2 {2}USDC on NEAR {2}needs NEAR_ACCOUNT_ID and NEAR_PRIVATE_KEY {2}✘/);
    expect(out).toMatch(/3 {2}USDC on Base {2}needs BASE_PRIVATE_KEY {2}✘/);
    expect(out).toMatch(/4 {2}USDC\.e on Tempo {2}needs TEMPO_PRIVATE_KEY {2}✘/);
    // Sign-up, its free Credits, the key
    expect(out).toContain('Sign-up is one call, free, and gives a master key.');
    expect(out).toContain('Sign up creates an Anyfare account and a master key.');
    expect(out).toContain('You got $0.10 of free Credits');
    expect(out).toContain('Create a payment key "demo": daily budget $1, at most $0.02 a call');
    expect(out).toContain('✔ Payment key created');
    // Explain, the question, the answer, the receipt, the story
    expect(out).toMatch(/The API's price\s+\$0\.01 in USDC on Base/);
    expect(out).toMatch(/Anyfare's fee\s+\$0\.001/);
    expect(out).toMatch(/\$0\.011 of Credits\s+--pay credits\s+← you pay this one/);
    expect(out).toContain('Pay $0.011 of Credits? [y/N]');
    expect(out).toContain('Bitcoin Real (BTC)');
    expect(out).toMatch(/Receipt pay_madeup\d+: \$0\.011 of Credits/);
    expect(out).toContain('✔ You paid with Credits. Anyfare paid CoinMarketCap in USDC on Base from its own wallet.');
    expect(out).toContain('Another call? [Y/n]');

    const keys = savedKeys();
    expect(keys['ANYFARE_MASTER_KEY']).toMatch(/^afm_live_/);
    expect(keys['ANYFARE_PAYMENT_KEY']).toMatch(/^af_live_/);
    expect(paidRequests()).toHaveLength(1);
    for (const key of Object.values(keys)) expect(`${out}${result.err}`).not.toContain(key);
  });

  it('offers a top-up when the balance is below the price, says the 404, and goes back to the way to pay', async () => {
    const env = { ...funded('0.001'), BASE_PRIVATE_KEY: generatePrivateKey() };
    // CoinMarketCap, the default pair, Credits, yes to the top-up, then Base, pay, no more
    const result = await session(['1', '', '1', 'y', '3', 'y', 'n'], env);
    expect(result.code).toBe(0);
    expect(result.out).toContain('Your balance is $0.001, and this call costs $0.011 of Credits.');
    expect(result.out).toContain('Add Credits with a top-up? [Y/n]');
    expect(result.err).toContain('✘ Top-ups are not available on this Anyfare yet. The operator credits balances.');
    // Back at the way to pay: asked a second time
    expect(result.out.match(/How do you pay\?/g)).toHaveLength(2);
    expect(result.out).toContain('✔ You paid in USDC on Base.');
    expect(fake.requests.filter((item) => item.path === '/v1/topups/options')).toHaveLength(1);
    expect(fake.requests.some((item) => item.method === 'POST' && item.path === '/v1/topups')).toBe(false);
    expect(fake.x402Settled).toHaveLength(1);
  });

  it('shows the networks and tokens, asks, and goes on to the call once the top-up is credited', async () => {
    fake.topups.enabled = true;
    fake.topups.steps = [{ status: 'credited', deposited: '5', credited: '4.95' }];
    const env = funded('0.001');
    // Credits, top up: the first network, the first token, 5; the question; then pay; no more
    const result = await session(['1', '', '1', 'y', '1', '1', '5', 'y', 'y', 'n'], env);
    expect(result.code).toBe(0);
    expect(result.out).toContain('A top-up adds USDC on NEAR to your Credits');
    expect(result.out).toContain('1  base  worth at least $1');
    expect(result.out).toContain('Ask Anyfare for a deposit address for 5 USDC on base? [y/N]');
    expect(result.out).toContain('Send to       madeup-deposit-address.test');
    expect(fake.topups.created).toEqual([{ network: 'base', token: 'USDC', amount: '5' }]);
    expect(result.out).toContain('Pay $0.011 of Credits? [y/N]');
  });

  it('says top-ups are off, and that the operator credits balances', async () => {
    fake.topups.enabled = true;
    fake.topups.unavailable = true;
    const env = { ...funded('0.001'), BASE_PRIVATE_KEY: generatePrivateKey() };
    const result = await session(['1', '', '1', 'y', '3', 'y', 'n'], env);
    expect(result.code).toBe(0);
    expect(result.err).toContain('✘ Top-ups are off on this Anyfare now. Nothing was made that could take a transfer');
    expect(result.out).toContain('The operator credits balances.');
  });

  it('takes typed values for 3Route, and asks again after a bad one', async () => {
    const env = funded();
    // 3Route; a token it does not list; then the chain by its ID, USDC, WETH, 1; Credits; pay; no more
    const result = await session(['2', 'base', 'NOPE', 'WETH', '1', '8453', 'USDC', 'WETH', '1', '1', 'y', 'n'], env);
    expect(result.code).toBe(0);
    expect(result.err).toContain('"NOPE" is not in 3Route\'s token list');
    expect(result.out.match(/Chain \[base\]/g)).toHaveLength(2);
    expect(result.out).toContain('3Route: 1 USDC → WETH on Base');
    expect(result.out).toContain('1 USDC → 0.00025 WETH');
    expect(paidRequests()).toHaveLength(1);
  });

  it('ends the call after three bad values, and asks whether to call again', async () => {
    const bad = ['2', 'base', 'NOPE', 'WETH', '1'];
    const result = await session([...bad, 'base', 'NOPE', 'WETH', '1', 'base', 'NOPE', 'WETH', '1', 'n'], funded());
    expect(result.code).toBe(0);
    expect(result.err).toContain('No valid value after 3 tries.');
    expect(result.out).toContain('Another call?');
    expect(fake.routed()).toEqual([]);
  });

  it('names the variables of a way whose settings are missing, and asks again', async () => {
    const env = funded();
    // The evidence API, the default account; NEAR, Tempo, Base: each is missing; then Credits
    const result = await session(['3', '', '2', '4', '3', '1', 'y', 'n'], env);
    expect(result.code).toBe(0);
    expect(result.out).toContain('USDC on NEAR needs NEAR_ACCOUNT_ID and NEAR_PRIVATE_KEY in .env.local.');
    expect(result.out).toContain('USDC.e on Tempo needs TEMPO_PRIVATE_KEY in .env.local.');
    expect(result.out).toContain('USDC on Base needs BASE_PRIVATE_KEY in .env.local.');
    expect(result.out).toMatch(/1 {2}Credits {2}needs ANYFARE_PAYMENT_KEY {2}✔/);
    expect(result.out).toMatch(/3 {2}USDC on Base {2}needs BASE_PRIVATE_KEY {2}✘/);
    expect(result.out.match(/How do you pay\?/g)).toHaveLength(4);
    expect(result.out).toContain('✔ You paid with Credits. Anyfare paid the evidence API in USDC on NEAR from its own wallet.');
    expect(fake.x402Requests()).toEqual([]);
  });

  it('pays on Base from a key made in the test, end to end, and shows no part of it', async () => {
    const key = generatePrivateKey();
    const result = await session(['1', '', '3', 'y', 'n'], { BASE_PRIVATE_KEY: key });
    expect(result.err).toBe('');
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/3 {2}USDC on Base {2}needs BASE_PRIVATE_KEY {2}✔/);
    expect(result.out).toMatch(/You pay\s+0\.011 USDC on Base/);
    expect(fake.x402Settled).toHaveLength(1);
    const [settled] = fake.x402Settled;
    expect(result.out).toContain(`transaction ${settled?.transaction}`);
    expect(result.out).toContain('✔ You paid in USDC on Base. Anyfare paid CoinMarketCap in USDC on Base from its own wallet.');
    expect(`${result.out}${result.err}`.toLowerCase()).not.toContain(key.slice(2, 18).toLowerCase());
    // Nothing was saved: no key was made
    expect(() => readFileSync(join(app.dir, '.env.local'))).toThrow();
  });

  it('prints the line of a call that failed, and asks "Another call?" all the same', async () => {
    const env = funded();
    fake.nextPaid = { status: 402, body: { error: { code: 'insufficient_balance', message: 'A made-up message' } } };
    const result = await session(['1', '', '1', 'y', 'n'], env);
    expect(result.code).toBe(0);
    expect(result.err).toMatch(/^✘ Your Credits don't cover this call\. Top up, or ask the operator \(request req-made-up-\d+\)\. Not charged\.\n$/);
    expect(result.out.trimEnd().endsWith('Another call? [Y/n]')).toBe(true);
  });

  it('makes two calls in one session, with one set of answers read in order', async () => {
    const env = funded();
    // CoinMarketCap with Credits; another call; the evidence API with Credits; no more
    const result = await session(['1', '', '1', 'y', 'y', '3', '', '1', 'y', 'n'], env);
    expect(result.err).toBe('');
    expect(result.code).toBe(0);
    expect(result.out.match(/Another call\?/g)).toHaveLength(2);
    expect(result.out).toContain('✔ You paid with Credits. Anyfare paid CoinMarketCap');
    expect(result.out).toContain('✔ You paid with Credits. Anyfare paid the evidence API');
    expect(paidRequests().map((item) => item.method)).toEqual(['GET', 'POST']);
  });

  it('says that nothing was sent when the person answers no to "Pay"', async () => {
    const result = await session(['1', '', '1', 'n', 'n'], funded());
    expect(result.code).toBe(0);
    expect(result.err).toBe('✘ Nothing was sent. Not charged.\n');
    expect(paidRequests()).toEqual([]);
  });

  it('offers only a payment key to an account that has a master key and no payment key', async () => {
    const account = fake.addAccount('1');
    const result = await session(['1', '', '1', 'y', 'y', 'n'], { ANYFARE_MASTER_KEY: account.masterKey });
    expect(result.code).toBe(0);
    expect(result.out).not.toContain('Sign up creates');
    expect(result.out).toContain('✔ Payment key created');
    expect(fake.requests.some((item) => item.method === 'POST' && item.path === '/v1/accounts')).toBe(false);
    expect(Object.keys(savedKeys())).toEqual(['ANYFARE_PAYMENT_KEY']);
  });

  it('goes back to the way to pay when the person declines the sign-up, and creates nothing', async () => {
    const key = generatePrivateKey();
    const result = await session(['1', '', '1', 'n', '3', 'y', 'n'], { BASE_PRIVATE_KEY: key });
    expect(result.code).toBe(0);
    expect(result.err).toContain('✘ Nothing was created.');
    expect(fake.requests.some((item) => item.method === 'POST' && item.path === '/v1/accounts')).toBe(false);
    expect(fake.x402Settled).toHaveLength(1);
  });
});
