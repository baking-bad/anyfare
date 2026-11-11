// The interactive mode: lines typed at a prompt, one request each. Every key here is made in the test,
// in memory only, and holds nothing. Every account, price and balance is made up. No request leaves
// 127.0.0.1: the https APIs are sent to the fake API, and the NEAR signer to the fake NEAR RPC.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli.ts';
import type { Io } from '../src/cli.ts';
import { createContext } from '../src/context.ts';
import type { Fetch } from '../src/http.ts';
import { runInteractive } from '../src/interactive.ts';
import { NEAR_USDC, startFakeApi } from './fakeApi.ts';
import type { FakeApi, Unpaid } from './fakeApi.ts';
import { startFakeNearRpc } from './fakeNearRpc.ts';
import type { FakeNearRpc } from './fakeNearRpc.ts';
import { captureIo, expectNoKeyIn, localFetch, nearTestKey, waitUntil, withoutTimes } from './helpers.ts';

// Made up: the payer, the API's NEAR account, and the hosts the https URLs stand for
const ACCOUNT = 'alice.near';
const PAY_TO = 'seller.example.near';
const API = 'https://api.example.test';
const PAY = 'https://pay.example.test';
const { secretKey: KEY, publicKey: PUBLIC_KEY } = nearTestKey();

const PROMPT = 'Link or request (Enter to quit): ';
const CONFIRM = 'Pay 0.01 USDC on NEAR? [y/N] ';
const HEADER = [
  'x402-near-wallet · pay x402 APIs from a NEAR wallet',
  '',
  'Wallet    alice.near',
  'Balance   0.990000 USDC · 0.1200 NEAR',
  'Cap       $0.02 a call (MAX_PAYMENT_USD)',
  '',
  PROMPT,
].join('\n');

/** USDC on NEAR as an API offers it. The amount is made up: 10000 is $0.01. */
const nearOption = (amount = '10000'): Record<string, unknown> => ({
  scheme: 'exact',
  network: 'near:mainnet',
  asset: NEAR_USDC,
  amount,
  payTo: PAY_TO,
  maxTimeoutSeconds: 300,
  extra: {},
});
/** An API that takes USDC on Base only, made up. */
const BASE_ONLY = [
  {
    scheme: 'exact',
    network: 'eip155:8453',
    asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    amount: '10000',
    payTo: '0x3C5f3a6cE224BB89D72f5EB4232ecC27F67B3eeA',
    maxTimeoutSeconds: 30,
    extra: { name: 'USD Coin', version: '1' },
  },
];

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

const wallet = (): Record<string, string> => ({ NEAR_ACCOUNT_ID: ACCOUNT, NEAR_PRIVATE_KEY: KEY, NEAR_RPC_URL: rpc.url, ANYFARE_PAY_URL: PAY });
const forwarding = (): Fetch => localFetch({ [API]: api.url, [PAY]: api.url });

const route = (path: string, unpaid: Unpaid): void => api.route({ method: 'GET', path, unpaid });
const payable = (path: string): void => route(path, { kind: 'x402', accepts: [nearOption()] });

/** The NEAR RPC's calls that only signing makes. */
const signingCalls = () =>
  rpc.calls.filter(
    (call) =>
      call.method === 'status' || call.method === 'block' || (call.params as Record<string, unknown> | undefined)?.['request_type'] === 'view_access_key',
  );

const count = (text: string, part: string): number => text.split(part).length - 1;

interface SessionOptions {
  readonly argv?: readonly string[];
  readonly isTerminal?: boolean;
  readonly fetch?: Fetch;
}

/** A run of the app with a terminal's input that the test writes lines into. */
function session(env: Record<string, string> = wallet(), options: SessionOptions = {}) {
  const captured = captureIo(options.fetch ?? forwarding(), env, { isTerminal: options.isTerminal ?? true });
  const listeners = new Set<() => void>();
  const io: Io = {
    ...captured.io,
    onInterrupt: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const done = runCli(options.argv ?? [], io);
  let lines = 0;
  let answers = 0;
  const all = (): string => `${captured.out()}\n${captured.err()}`;
  return {
    ...captured,
    done,
    listeners,
    /** Types a line once the next prompt is shown. */
    async line(text: string): Promise<void> {
      lines += 1;
      await waitUntil(() => count(captured.out(), PROMPT) >= lines, `prompt ${lines}`);
      captured.stdin.write(`${text}\n`);
    },
    /** Types the answer to the question of a payment. */
    async answer(text: string): Promise<void> {
      answers += 1;
      await waitUntil(() => count(captured.out(), CONFIRM) >= answers, `question ${answers}`);
      captured.stdin.write(`${text}\n`);
    },
    /** Waits for the nth prompt. */
    prompt: (n: number) => waitUntil(() => count(captured.out(), PROMPT) >= n, `prompt ${n}`),
    interrupt(): void {
      for (const listener of [...listeners]) listener();
    },
    /** The run's end, and a check that none of its output holds a part of the key. */
    async finish(): Promise<number> {
      const code = await done;
      expectNoKeyIn(all(), KEY, { known: api.settled.map((item) => item.transaction) });
      return code;
    },
  };
}

describe('the walk of the design', () => {
  it('refuses an API without NEAR, pays the same request through Anyfare, and quits on Enter', async () => {
    route('/v1/quote', { kind: 'x402', accepts: BASE_ONLY });
    payable('/api.example.test/v1/quote');
    const run = session();
    await run.prompt(1);
    expect(run.out()).toBe(HEADER);
    expect(run.err()).toBe('');

    await run.line(`${API}/v1/quote`);
    await run.prompt(2);
    expect(run.err()).toBe("✘ Not supported: this API doesn't take NEAR. It takes USDC on Base. Nothing paid.\n");
    expect(run.out()).toBe(`${HEADER}  Through Anyfare it takes NEAR:\n  ${PAY}/api.example.test/v1/quote\n\n${PROMPT}`);

    await run.line(`${PAY}/api.example.test/v1/quote`);
    await run.answer('y');
    await run.prompt(3);
    await run.line('');
    expect(await run.finish()).toBe(0);

    const out = withoutTimes(run.out());
    expect(out).toContain('▸ The API asks   0.01 USDC on NEAR\n');
    expect(out).toContain(`${CONFIRM}▸ Signing a transfer of 0.01 USDC to ${PAY_TO}\n`);
    expect(out).toContain(' Result · HTTP 200 · application/json · T s\n');
    expect(out).toContain(' Proof\n');
    expect(out).toContain('✔ You paid 0.01 USDC on NEAR.\n\nBalance   0.980000 USDC (−0.01) · 0.1200 NEAR\n\nLink or request (Enter to quit): ');
    expect(out.endsWith(PROMPT)).toBe(true);
    expect(api.paidRequests()).toHaveLength(1);
    expect(api.settled).toHaveLength(1);
  });
});

describe('what a line can end in', () => {
  it('says a free answer cost nothing and asks again', async () => {
    route('/v1/free', { kind: 'answer', answer: { status: 200, body: '{"symbol":"BTC","price":"made up"}' } });
    const run = session();
    await run.line(`${API}/v1/free`);
    await run.prompt(2);
    expect(run.out()).toContain('✔ Free: nothing paid.\n\nLink or request (Enter to quit): ');
    await run.line('');
    expect(await run.finish()).toBe(0);
  });

  it('pays nothing and signs nothing on a "n", and asks again', async () => {
    payable('/v1/quote');
    const run = session();
    await run.line(`${API}/v1/quote`);
    await run.answer('n');
    await run.prompt(2);
    expect(run.err()).toBe('✘ Nothing paid.\n');
    // The typed answer is not echoed here: a terminal echoes it, and its line break
    expect(run.out()).toMatch(/Pay 0\.01 USDC on NEAR\? \[y\/N\] \nLink or request \(Enter to quit\): $/);
    expect(signingCalls()).toEqual([]);
    expect(api.paidRequests()).toEqual([]);
    await run.line('   ');
    expect(await run.finish()).toBe(0);
  });

  it('answers a bad line with one line, and asks again', async () => {
    payable('/v1/quote');
    const run = session();
    await run.line(`-F x ${API}/v1/quote`);
    await run.line(`curl -H 'Accept: x ${API}/v1/quote`);
    await run.line(`--yes ${API}/v1/quote`);
    await run.line('--dry-run');
    await run.line('--bogus');
    await run.prompt(6);
    expect(run.err()).toBe(
      [
        '✘ -F is not supported. This app takes -X, -H, -d, --data, --data-raw, --json, -s and -S',
        '✘ A quote is not closed',
        '✘ The interactive mode always asks. Remove --yes',
        '✘ --dry-run needs a request. See --help',
        '✘ --bogus is not supported. This app takes -X, -H, -d, --data, --data-raw, --json, -s and -S',
        '',
      ].join('\n'),
    );
    expect(api.requests).toEqual([]);
    await run.line('');
    expect(await run.finish()).toBe(0);
  });

  it('prints the help, and asks again', async () => {
    const run = session();
    await run.line('--help');
    await run.prompt(2);
    expect(run.out()).toContain('x402-near-wallet pays x402 APIs in USDC from a NEAR wallet.');
    await run.line('');
    expect(await run.finish()).toBe(0);
  });

  it('shows one ✘ line for an error nobody expected, and asks again', async () => {
    const odd: Fetch = ((input: string | URL | Request, init?: RequestInit) =>
      String(input).includes('/odd') ? ({ status: 200, headers: null } as unknown as Promise<Response>) : forwarding()(input, init)) as Fetch;
    route('/v1/free', { kind: 'answer', answer: { status: 200, body: '{}' } });
    const run = session(wallet(), { fetch: odd });
    await run.line(`${API}/odd`);
    await run.prompt(2);
    expect(run.err()).toMatch(/^✘ [^\n]+\n$/);
    await run.line(`${API}/v1/free`);
    await run.prompt(3);
    expect(run.out()).toContain('✔ Free: nothing paid.');
    await run.line('');
    expect(await run.finish()).toBe(0);
  });
});

describe('the lines the app answers itself', () => {
  it('reads the balance fresh on "balance"', async () => {
    const run = session();
    await run.prompt(1);
    rpc.setBalance(ACCOUNT, 500_000n, 120_000_000_000_000_000_000_000n);
    await run.line('balance');
    await run.prompt(2);
    expect(run.out()).toContain('Wallet    alice.near\nBalance   0.500000 USDC · 0.1200 NEAR\nCap       $0.02 a call (MAX_PAYMENT_USD)\n\nLink or request');
    await run.line('');
    expect(await run.finish()).toBe(0);
  });

  it('shows the cost and pays nothing on --dry-run', async () => {
    payable('/v1/quote');
    const run = session();
    await run.line(`--dry-run ${API}/v1/quote`);
    await run.prompt(2);
    expect(run.out()).toContain('✔ Would pay 0.01 USDC on NEAR to seller.example.near. Not paid.\n\n');
    expect(run.out()).not.toContain(CONFIRM);
    expect(api.paidRequests()).toEqual([]);
    expect(signingCalls()).toEqual([]);
    await run.line('');
    expect(await run.finish()).toBe(0);
  });

  it('applies --max to its line only', async () => {
    payable('/v1/quote');
    const run = session();
    await run.line(`--max 0.001 ${API}/v1/quote`);
    await run.prompt(2);
    expect(run.err()).toBe('✘ Costs $0.01, above your cap of $0.001. Nothing paid. Use a higher --max to pay it.\n');
    await run.line(`--dry-run ${API}/v1/quote`);
    await run.prompt(3);
    expect(run.out()).toContain('Your cap       $0.02 ✔');
    expect(run.out()).toContain('✔ Would pay 0.01 USDC on NEAR');
    await run.line('');
    expect(await run.finish()).toBe(0);
  });

  it('takes --max of the command line as the default for every line, and --max of a line over it', async () => {
    payable('/v1/quote');
    const run = session(wallet(), { argv: ['--max', '0.005'] });
    await run.prompt(1);
    expect(run.out()).toContain('Cap       $0.005 a call (--max)\n');
    await run.line(`${API}/v1/quote`);
    await run.prompt(2);
    expect(run.err()).toBe('✘ Costs $0.01, above your cap of $0.005. Nothing paid. Use a higher --max to pay it.\n');
    await run.line(`--max 0.05 --dry-run ${API}/v1/quote`);
    await run.prompt(3);
    expect(run.out()).toContain('✔ Would pay 0.01 USDC on NEAR');
    await run.line('');
    expect(await run.finish()).toBe(0);
  });
});

describe('the setup', () => {
  it('warns when no key is set, fails a paying request at the wallet, and goes on', async () => {
    payable('/v1/quote');
    const { NEAR_PRIVATE_KEY: _key, ...env } = wallet();
    const run = session(env);
    await run.line(`${API}/v1/quote`);
    await run.prompt(2);
    expect(run.err()).toContain("NEAR_PRIVATE_KEY is not set: the app shows costs, and can't pay. Add it to .env.local.\n");
    expect(run.err()).toContain('✘ NEAR_PRIVATE_KEY is not set. Add it to .env.local: a full-access key of alice.near, ed25519: and base58. Nothing paid.\n');
    expect(run.out()).toContain(HEADER.replace(PROMPT, ''));
    expect(api.paidRequests()).toEqual([]);
    await run.line('');
    expect(await run.finish()).toBe(0);
  });

  it('shows the header without the balance, and says why, when the RPC fails', async () => {
    rpc.failing = { status: 503 };
    const run = session();
    await run.prompt(1);
    expect(run.out()).toBe(
      ['x402-near-wallet · pay x402 APIs from a NEAR wallet', '', 'Wallet    alice.near', 'Cap       $0.02 a call (MAX_PAYMENT_USD)', '', PROMPT].join('\n'),
    );
    expect(run.err()).toBe(`Could not read the balance: the NEAR RPC at ${new URL(rpc.url).host} answered 503.\n`);
    await run.line('');
    expect(await run.finish()).toBe(0);
  });

  it('needs a terminal: exit 2', async () => {
    const run = session(wallet(), { isTerminal: false });
    expect(await run.finish()).toBe(2);
    expect(run.err()).toBe('✘ The interactive mode needs a terminal. Give a request instead; see --help\n');
    expect(run.out()).toBe('');
  });

  it('needs NEAR_ACCOUNT_ID: exit 1', async () => {
    const { NEAR_ACCOUNT_ID: _account, ...env } = wallet();
    const run = session(env);
    expect(await run.finish()).toBe(1);
    expect(run.err()).toBe('✘ NEAR_ACCOUNT_ID is not set. Set it in .env.local or the shell, such as NEAR_ACCOUNT_ID=alice.near\n');
    expect(run.out()).toBe('');
  });
});

describe('quitting', () => {
  it('quits with 0 when the input ends', async () => {
    const run = session();
    await run.prompt(1);
    run.stdin.end();
    expect(await run.finish()).toBe(0);
    expect(run.out()).toBe(HEADER);
  });

  it('quits with 0 on Ctrl-C at the prompt, printing a newline only, and lets go of the signal', async () => {
    const run = session();
    await run.prompt(1);
    expect(run.listeners.size).toBe(1);
    run.interrupt();
    expect(await run.finish()).toBe(0);
    expect(run.out()).toBe(`${HEADER}\n`);
    expect(run.listeners.size).toBe(0);
  });

  it('lets a paid request finish on Ctrl-C, says so, then quits with 0, after one request', async () => {
    payable('/v1/quote');
    const release = api.holdNextPaid();
    const run = session();
    await run.line(`${API}/v1/quote`);
    await run.answer('y');
    await waitUntil(() => api.paidRequests().length === 1, 'the paid request');
    run.interrupt();
    await waitUntil(() => run.out().includes('Stopping after this request.'), 'the line about stopping');
    expect(run.out()).toContain("Stopping after this request. A payment that was sent can't be called back.\n");
    expect(run.out()).not.toContain('You paid');
    release();
    expect(await run.finish()).toBe(0);
    const out = run.out();
    expect(out).toContain('✔ You paid 0.01 USDC on NEAR.\n\nBalance   0.980000 USDC (−0.01) · 0.1200 NEAR\n');
    expect(count(out, PROMPT)).toBe(1);
    expect(api.paidRequests()).toHaveLength(1);
    expect(run.listeners.size).toBe(0);
  });

  it('pays nothing on Ctrl-C at the question of a payment, then quits with 0', async () => {
    payable('/v1/quote');
    const run = session();
    await run.line(`${API}/v1/quote`);
    await waitUntil(() => run.out().endsWith(CONFIRM), 'the question');
    run.interrupt();
    expect(await run.finish()).toBe(0);
    expect(run.out()).toContain("Stopping after this request. A payment that was sent can't be called back.\n");
    expect(run.err()).toBe('✘ No more input. Nothing paid.\n');
    expect(signingCalls()).toEqual([]);
    expect(api.paidRequests()).toEqual([]);
    expect(count(run.out(), PROMPT)).toBe(1);
    expect(run.listeners.size).toBe(0);
  });

  it('ends the process at once on a second Ctrl-C while a request runs', async () => {
    payable('/v1/quote');
    const release = api.holdNextPaid();
    const captured = captureIo(forwarding(), wallet(), { isTerminal: true });
    const listeners = new Set<() => void>();
    const io: Io = {
      ...captured.io,
      onInterrupt: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const ended: number[] = [];
    const ctx = createContext(io);
    const done = runInteractive(ctx, { yes: false, dryRun: false, full: false }, (code) => {
      ended.push(code);
    });
    await waitUntil(() => captured.out().endsWith(PROMPT), 'the prompt');
    captured.stdin.write(`${API}/v1/quote\n`);
    await waitUntil(() => captured.out().endsWith(CONFIRM), 'the question');
    captured.stdin.write('y\n');
    await waitUntil(() => api.paidRequests().length === 1, 'the paid request');
    for (const listener of [...listeners]) listener();
    for (const listener of [...listeners]) listener();
    expect(ended).toEqual([130]);
    release();
    expect(await done).toBe(0);
    ctx.close();
  });
});

describe('the key', () => {
  it('is in no output of a paid run, nor of a failing one', async () => {
    payable('/v1/quote');
    route('/v1/bad', { kind: 'answer', answer: { status: 500, contentType: 'text/plain', body: `made up, with ${KEY} in it` } });
    const run = session();
    await run.line(`${API}/v1/quote`);
    await run.answer('y');
    await run.line(`${API}/v1/bad --full`);
    await run.line('');
    expect(await run.finish()).toBe(0);
    expect(run.out()).toContain('✔ You paid');
    expect(run.out() + run.err()).not.toContain(KEY);
  });
});
