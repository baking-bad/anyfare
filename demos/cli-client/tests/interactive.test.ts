// The interactive mode, driven by scripted answers through stdin, against the fake Anyfare. Every key,
// address and price here is made up.

import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PassThrough } from 'node:stream';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.ts';
import { toAtomic } from '../src/util.ts';
import { forwardingFetch, startFakeAnyfare, toolRoutes, toolTargets } from './fakeAnyfare.ts';
import type { FakeAnyfare, FakeTarget } from './fakeAnyfare.ts';
import { startFakeBaseRpc } from './fakeBaseRpc.ts';
import type { FakeBaseRpc } from './fakeBaseRpc.ts';
import { captureIo, tempAppDir, waitUntil } from './helpers.ts';

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
let baseRpc: FakeBaseRpc;
let app: { dir: string; remove: () => void };

beforeAll(async () => {
  [fake, baseRpc] = await Promise.all([startFakeAnyfare(), startFakeBaseRpc()]);
});
afterAll(async () => {
  await Promise.all([fake.close(), baseRpc.close()]);
});
beforeEach(() => {
  fake.reset();
  baseRpc.reset();
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

/** A Base wallet of a key made here, holding a made-up balance on the made-up Base RPC: 1 USDC unless said. */
function baseWallet(key = generatePrivateKey(), micro = 1_000_000n): Record<string, string> {
  baseRpc.setBalance(privateKeyToAccount(key).address, micro);
  return { BASE_PRIVATE_KEY: key, BASE_RPC_URL: baseRpc.url };
}

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
    // The menu: call; CoinMarketCap, the default pair, Credits, sign up: 1 and yes, make the key, pay; quit
    const result = await session(['3', '1', '', '1', '1', 'y', 'y', 'y', '4']);
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
    // The choice, sign-up, its free Credits, the key
    expect(out).toContain('Credits need an Anyfare key, and none is set. How do you get one?\n  1  Sign up: a new account, free\n  2  Use keys I have\n');
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
    expect(out).toContain('What do you want to do?\n  1  See my balances: Credits and wallets\n  2  Top up Credits\n  3  Call a paid API\n  4  Quit\n');
    expect(out.match(/What do you want to do\?/g)).toHaveLength(2);

    const keys = savedKeys();
    expect(keys['ANYFARE_MASTER_KEY']).toMatch(/^afm_live_/);
    expect(keys['ANYFARE_PAYMENT_KEY']).toMatch(/^af_live_/);
    expect(paidRequests()).toHaveLength(1);
    for (const key of Object.values(keys)) expect(`${out}${result.err}`).not.toContain(key);
  });

  it('offers a top-up when the balance is below the price, says the 404, and goes back to the way to pay', async () => {
    const env = { ...funded('0.001'), ...baseWallet() };
    // CoinMarketCap, the default pair, Credits, yes to the top-up, then Base, pay, no more
    const result = await session(['3', '1', '', '1', 'y', '3', 'y', '4'], env);
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
    const result = await session(['3', '1', '', '1', 'y', '1', '1', '5', 'y', 'y', '4'], env);
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
    const env = { ...funded('0.001'), ...baseWallet() };
    const result = await session(['3', '1', '', '1', 'y', '3', 'y', '4'], env);
    expect(result.code).toBe(0);
    expect(result.err).toContain('✘ Top-ups are off on this Anyfare now. Nothing was made that could take a transfer');
    expect(result.out).toContain('The operator credits balances.');
  });

  it('takes typed values for 3Route, and asks again after a bad one', async () => {
    const env = funded();
    // 3Route; a token it does not list; then the chain by its ID, USDC, WETH, 1; Credits; pay; no more
    const result = await session(['3', '2', 'base', 'NOPE', 'WETH', '1', '8453', 'USDC', 'WETH', '1', '1', 'y', '4'], env);
    expect(result.code).toBe(0);
    expect(result.err).toContain('"NOPE" is not in 3Route\'s token list');
    expect(result.out.match(/Chain \[base\]/g)).toHaveLength(2);
    expect(result.out).toContain('3Route: 1 USDC → WETH on Base');
    expect(result.out).toContain('1 USDC → 0.00025 WETH');
    expect(paidRequests()).toHaveLength(1);
  });

  it('ends the call after three bad values, and shows the menu again', async () => {
    const bad = ['3', '2', 'base', 'NOPE', 'WETH', '1'];
    const result = await session([...bad, 'base', 'NOPE', 'WETH', '1', 'base', 'NOPE', 'WETH', '1', '4'], funded());
    expect(result.code).toBe(0);
    expect(result.err).toContain('No valid value after 3 tries.');
    expect(result.out.match(/What do you want to do\?/g)).toHaveLength(2);
    expect(fake.routed()).toEqual([]);
  });

  it('names the variables of a way whose settings are missing, and asks again', async () => {
    const env = funded();
    // The evidence API, the default account; NEAR, Tempo, Base: each is missing; then Credits
    const result = await session(['3', '3', '', '2', '4', '3', '1', 'y', '4'], env);
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
    const result = await session(['3', '1', '', '3', 'y', '4'], baseWallet(key));
    expect(result.err).toBe('');
    expect(result.code).toBe(0);
    // With the made-up balance of the wallet
    expect(result.out).toMatch(/3 {2}USDC on Base {2}needs BASE_PRIVATE_KEY {2}✔ {2}1 USDC\n/);
    expect(result.out).toMatch(/You pay\s+0\.011 USDC on Base/);
    expect(fake.x402Settled).toHaveLength(1);
    const [settled] = fake.x402Settled;
    expect(result.out).toContain(`transaction ${settled?.transaction}`);
    expect(result.out).toContain('✔ You paid in USDC on Base. Anyfare paid CoinMarketCap in USDC on Base from its own wallet.');
    expect(`${result.out}${result.err}`.toLowerCase()).not.toContain(key.slice(2, 18).toLowerCase());
    // Nothing was saved: no key was made
    expect(() => readFileSync(join(app.dir, '.env.local'))).toThrow();
  });

  it('prints the line of a call that failed, and shows the menu all the same', async () => {
    const env = funded();
    fake.nextPaid = { status: 402, body: { error: { code: 'insufficient_balance', message: 'A made-up message' } } };
    const result = await session(['3', '1', '', '1', 'y', '4'], env);
    expect(result.code).toBe(0);
    expect(result.err).toMatch(/^✘ Your Credits don't cover this call\. Top up, or ask the operator \(request req-made-up-\d+\)\. Not charged\.\n$/);
    expect(result.out.trimEnd().endsWith('Choose 1-4:')).toBe(true);
  });

  it('makes two calls in one session, with one set of answers read in order', async () => {
    const env = funded();
    // Call: CoinMarketCap with Credits; call again: the evidence API with Credits; quit
    const result = await session(['3', '1', '', '1', 'y', '3', '3', '', '1', 'y', '4'], env);
    expect(result.err).toBe('');
    expect(result.code).toBe(0);
    expect(result.out.match(/What do you want to do\?/g)).toHaveLength(3);
    expect(result.out).toContain('✔ You paid with Credits. Anyfare paid CoinMarketCap');
    expect(result.out).toContain('✔ You paid with Credits. Anyfare paid the evidence API');
    expect(paidRequests().map((item) => item.method)).toEqual(['GET', 'POST']);
  });

  it('says that nothing was sent when the person answers no to "Pay"', async () => {
    const result = await session(['3', '1', '', '1', 'n', '4'], funded());
    expect(result.code).toBe(0);
    expect(result.err).toBe('✘ Nothing was sent. Not charged.\n');
    expect(paidRequests()).toEqual([]);
  });

  it('offers only a payment key to an account that has a master key and no payment key', async () => {
    const account = fake.addAccount('1');
    const result = await session(['3', '1', '', '1', 'y', 'y', '4'], { ANYFARE_MASTER_KEY: account.masterKey });
    expect(result.code).toBe(0);
    expect(result.out).not.toContain('Sign up creates');
    expect(result.out).toContain('✔ Payment key created');
    expect(fake.requests.some((item) => item.method === 'POST' && item.path === '/v1/accounts')).toBe(false);
    expect(Object.keys(savedKeys())).toEqual(['ANYFARE_PAYMENT_KEY']);
  });

  it('goes back to the way to pay when the person declines the sign-up, and creates nothing', async () => {
    // Credits, sign up: 1, then no
    const result = await session(['3', '1', '', '1', '1', 'n', '3', 'y', '4'], baseWallet());
    expect(result.code).toBe(0);
    expect(result.err).toContain('✘ Nothing was created.');
    expect(fake.requests.some((item) => item.method === 'POST' && item.path === '/v1/accounts')).toBe(false);
    expect(fake.x402Settled).toHaveLength(1);
  });
});

describe('the interactive mode: the top-up minimum', () => {
  // CoinMarketCap, the default pair, Credits, yes to the top-up, the first network (base, $1), the first token (USDC)
  const TO_AMOUNT = ['3', '1', '', '1', 'y', '1', '1'];
  const posts = () => fake.requests.filter((item) => item.method === 'POST' && item.path === '/v1/topups');

  it('says the amount is under the minimum, sends nothing, and asks for the amount again', async () => {
    fake.topups.enabled = true;
    fake.topups.steps = [{ status: 'credited', deposited: '5', credited: '4.95' }];
    const result = await session([...TO_AMOUNT, '0.1', '5', 'y', 'y', '4'], funded('0.001'));
    expect(result.code).toBe(0);
    expect(result.out.match(/A top-up on base must be worth at least \$1\. 0\.1 USDC is worth \$0\.10\./g)).toHaveLength(1);
    expect(result.out.match(/Amount of USDC to send/g)).toHaveLength(2);
    expect(fake.topups.created).toEqual([{ network: 'base', token: 'USDC', amount: '5' }]);
    // The list was read once for the questions and the check
    expect(fake.requests.filter((item) => item.path === '/v1/topups/options')).toHaveLength(1);
  });

  it('gives up after three amounts under the minimum, with nothing sent', async () => {
    fake.topups.enabled = true;
    const result = await session([...TO_AMOUNT, '0.1', '0.2', '0.3', '4'], funded('0.001'));
    expect(result.out.match(/must be worth at least \$1\./g)).toHaveLength(3);
    expect(result.err).toContain('No valid amount.');
    expect(posts()).toEqual([]);
  });

  it('sends a token it cannot price, and keeps the API\'s own answer', async () => {
    fake.topups.enabled = true;
    fake.topups.refuse = 'Amount is too low for this route (made up)';
    // The second network (near), its second token (wNEAR), 0.1
    const result = await session(['3', '1', '', '1', 'y', '2', '2', '0.1', 'y', '4'], funded('0.001'));
    expect(result.out).not.toContain('must be worth at least');
    expect(posts()).toHaveLength(1);
    expect(result.err).toContain('✘ The swap service refused the top-up. No address was made: Amount is too low for this route (made up)');
    expect(result.err).toContain("That is under 1Click's own minimum for this route. Try a larger amount.");
  });
});

describe('the interactive mode: stopping the wait for a deposit', () => {
  const STOPPED = "Stopped waiting. The address stays open until";

  /** The session with its input left open, so that Enter can be typed during the wait. */
  function open(env: Record<string, string>) {
    const { fetch } = forwardingFetch(toolRoutes());
    const signals = new EventEmitter();
    const io = captureIo(
      fetch,
      { ANYFARE_API_URL: fake.apiUrl, ANYFARE_PAY_URL: fake.payUrl, ...env },
      { appDir: app.dir, isTerminal: true },
    );
    const stdin = io.io.stdin as PassThrough;
    const running = runCli([], { ...io.io, topup: { timing: { intervalMs: 20, limitMs: 20_000 }, signals } });
    const type = (...lines: string[]): void => {
      stdin.write(`${lines.join('\n')}\n`);
    };
    return { io, signals, running, type, stdin };
  }

  // CoinMarketCap, the default pair, Credits, yes to the top-up, base, USDC, 5, yes to the address
  const TO_WAIT = ['3', '1', '', '1', 'y', '1', '1', '5', 'y'];

  it('stops on Enter, and goes back to "How do you pay?"', async () => {
    fake.topups.enabled = true;
    fake.topups.steps = [{ status: 'waiting' }];
    const run = open(funded('0.001'));
    run.type(...TO_WAIT);
    await waitUntil(() => run.io.out().includes('Press Enter to stop waiting.'), 'the hint');
    run.type('');
    await waitUntil(() => run.io.out().match(/How do you pay\?/g)?.length === 2, 'the way-to-pay question again');
    expect(run.io.out()).toContain(STOPPED);
    expect(run.io.out().indexOf(STOPPED)).toBeLessThan(run.io.out().lastIndexOf('How do you pay?'));
    expect(run.signals.listenerCount('SIGINT')).toBe(0);
    // The way to pay is answered: the answer is read by the question, not lost to the wait
    run.stdin.end();
    await run.running;
    expect(run.io.err()).not.toContain('Press Enter');
  });

  it('stops on the first Ctrl-C, and goes back to "How do you pay?"; a second Ctrl-C has no handler', async () => {
    fake.topups.enabled = true;
    fake.topups.steps = [{ status: 'waiting' }];
    const run = open(funded('0.001'));
    run.type(...TO_WAIT);
    await waitUntil(() => run.io.out().includes('Press Enter to stop waiting.'), 'the hint');
    expect(run.signals.listenerCount('SIGINT')).toBe(1);
    run.signals.emit('SIGINT');
    await waitUntil(() => run.io.out().match(/How do you pay\?/g)?.length === 2, 'the way-to-pay question again');
    expect(run.io.out()).toContain(STOPPED);
    expect(run.signals.listenerCount('SIGINT')).toBe(0);
    run.stdin.end();
    await run.running;
  });

  it('goes on to the call when the top-up is credited, and reads the next answer at its question', async () => {
    fake.topups.enabled = true;
    fake.topups.steps = [{ status: 'waiting' }, { status: 'waiting' }, { status: 'credited', deposited: '5', credited: '4.95' }];
    const run = open(funded('0.001'));
    run.type(...TO_WAIT);
    await waitUntil(() => run.io.out().includes('Pay $0.011 of Credits? [y/N]'), 'the question to pay');
    expect(run.io.out()).not.toContain(STOPPED);
    expect(run.io.out()).toContain('✔ Added to your balance');
    // The answers typed now are read by the questions, in order: no to the payment, quit
    run.type('n', '4');
    expect(await run.running).toBe(0);
    expect(run.io.err()).toBe('✘ Nothing was sent. Not charged.\n');
  });
});

describe('the interactive mode: the start menu', () => {
  const MENU = 'What do you want to do?';

  it('asks the menu first, and quits with 0', async () => {
    const result = await session(['4']);
    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    expect(result.out).toContain(`${MENU}\n  1  See my balances: Credits and wallets\n  2  Top up Credits\n  3  Call a paid API\n  4  Quit\n`);
    expect(result.out.match(/What do you want to do\?/g)).toHaveLength(1);
    expect(fake.requests).toEqual([]);
  });

  it('shows the Credits and the wallets with 1, then the menu again', async () => {
    const env = { ...funded('0.5'), ...baseWallet() };
    const result = await session(['1', '4'], env);
    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    expect(result.out).toContain('Credits, with the master key');
    expect(result.out).toContain('The payment key "demo"');
    expect(result.out).toContain('Wallets');
    expect(result.out).toMatch(/USDC on Base\s+1 USDC/);
    expect(result.out.match(/What do you want to do\?/g)).toHaveLength(2);
    expect(paidRequests()).toEqual([]);
  });

  it('says what to add with 1 when no key and no wallet is set', async () => {
    const result = await session(['1', '4']);
    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    expect(result.out).toContain('Nothing to show yet. Add ANYFARE_MASTER_KEY, ANYFARE_PAYMENT_KEY or a wallet\'s settings to .env.local, or use 2 or 3 to set up keys.');
    expect(result.out.match(/What do you want to do\?/g)).toHaveLength(2);
    expect(fake.requests).toEqual([]);
  });

  it('tops up from the menu, shows the Credits when it is credited, and shows the menu again', async () => {
    fake.topups.enabled = true;
    fake.topups.steps = [{ status: 'credited', deposited: '5', credited: '4.95' }];
    // Top up: the first network, the first token, 5, yes to the address; quit
    const result = await session(['2', '1', '1', '5', 'y', '4'], funded('0.001'));
    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    expect(fake.topups.created).toEqual([{ network: 'base', token: 'USDC', amount: '5' }]);
    expect(result.out).toContain('✔ Added to your balance');
    const added = result.out.indexOf('✔ Added to your balance');
    expect(result.out.indexOf('Credits, with the master key', added)).toBeGreaterThan(added);
    expect(result.out.lastIndexOf(MENU)).toBeGreaterThan(result.out.indexOf('Credits, with the master key', added));
    expect(paidRequests()).toEqual([]);
  });

  it('offers sign-up for a top-up without a master key, and creates nothing when it is declined', async () => {
    const result = await session(['2', '1', 'n', '4']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('A top-up needs a master key, and none is set. How do you get one?\n  1  Sign up: a new account, free\n  2  Use keys I have\n');
    expect(result.err).toContain('✘ Nothing was created.');
    expect(fake.requests.some((item) => item.method === 'POST' && item.path === '/v1/accounts')).toBe(false);
    expect(fake.requests.some((item) => item.path === '/v1/topups/options')).toBe(false);
    expect(result.out.match(/What do you want to do\?/g)).toHaveLength(2);
  });

  it('offers no sign-up for a top-up when only a payment key is set, since a new account would not be its own', async () => {
    const paymentKey = funded('0')['ANYFARE_PAYMENT_KEY'] ?? '';
    // Top up; back to the menu; quit
    const result = await session(['2', '2', '4'], { ANYFARE_PAYMENT_KEY: paymentKey });
    expect(result.code).toBe(0);
    expect(result.out).toContain("A top-up needs the master key of your payment key's account, and ANYFARE_MASTER_KEY is not set.");
    expect(result.out).toContain('How do you go on?\n  1  Type the master key I have\n  2  Back to the menu\n');
    expect(result.out).not.toContain('Sign up: a new account, free');
    expect(fake.requests.some((item) => item.method === 'POST' && item.path === '/v1/accounts')).toBe(false);
    expect(fake.topups.created).toEqual([]);
    expect(result.out.match(/What do you want to do\?/g)).toHaveLength(2);
  });

  it("warns before a top-up to the master key's account when the payment key pays from another, and stops on Enter", async () => {
    fake.topups.enabled = true;
    // Made up: the master key of account A, the payment key of account B
    const a = funded('0');
    const b = funded('0');
    // Top up; Enter at "anyway?" (No); quit
    const result = await session(['2', '', '4'], { ANYFARE_MASTER_KEY: a.ANYFARE_MASTER_KEY ?? '', ANYFARE_PAYMENT_KEY: b.ANYFARE_PAYMENT_KEY ?? '' });
    expect(result.code).toBe(0);
    expect(result.out).toContain("A top-up adds to the master key's account, which the payment key doesn't spend.");
    expect(result.out).toContain("Top up the master key's account anyway? [y/N]");
    expect(fake.topups.created).toEqual([]);
    expect(result.out.match(/What do you want to do\?/g)).toHaveLength(2);
  });

  it('calls a paid API from the menu, then shows the menu again', async () => {
    const result = await session(['3', '1', '', '1', 'y', '4'], funded());
    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    expect(result.out).toContain('✔ You paid with Credits. Anyfare paid CoinMarketCap');
    expect(result.out).not.toContain('Another call?');
    expect(result.out.trimEnd().endsWith('Choose 1-4:')).toBe(true);
    expect(result.out.match(/What do you want to do\?/g)).toHaveLength(2);
    expect(paidRequests()).toHaveLength(1);
  });

  it('prints the one line of a failed action, then the menu again', async () => {
    // A top-up when the Anyfare has none: its line, then the menu
    const result = await session(['2', '4'], funded('0.001'));
    expect(result.code).toBe(0);
    expect(result.err).toContain('✘ Top-ups are not available on this Anyfare yet.');
    expect(result.out.match(/What do you want to do\?/g)).toHaveLength(2);
    expect(fake.requests.some((item) => item.method === 'POST' && item.path === '/v1/topups')).toBe(false);
  });

  it('shows the line of a balance that fails, then the menu again', async () => {
    const result = await session(['1', '4'], { ANYFARE_MASTER_KEY: 'afm_live_madeupmadeupmadeupmadeup1234' });
    expect(result.code).toBe(0);
    expect(result.err).toMatch(/^✘ /);
    expect(result.out.match(/What do you want to do\?/g)).toHaveLength(2);
  });
});
