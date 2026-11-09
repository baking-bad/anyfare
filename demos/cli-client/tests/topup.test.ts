// topup against the fake Anyfare. Every address, hash and amount here is made up.

import { EventEmitter } from 'node:events';
import type { PassThrough } from 'node:stream';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.ts';
import { createContext } from '../src/context.ts';
import { UNDER_ITS_MINIMUM, minimumRefusal, runTopup } from '../src/topup.ts';
import type { TopupCommand, TopupTiming } from '../src/topup.ts';
import { MADE_UP_DEPOSIT, MADE_UP_HASH, startFakeAnyfare } from './fakeAnyfare.ts';
import type { FakeAccount, FakeAnyfare } from './fakeAnyfare.ts';
import { captureIo, fakeFetch, tempAppDir, waitUntil } from './helpers.ts';
import type { IoOptions } from './helpers.ts';

let fake: FakeAnyfare;
let app: { dir: string; remove: () => void };
let account: FakeAccount;

beforeAll(async () => {
  fake = await startFakeAnyfare();
});
afterAll(async () => {
  await fake.close();
});
beforeEach(() => {
  fake.reset();
  fake.topups.enabled = true;
  account = fake.addAccount('0');
  app = tempAppDir();
});
afterEach(() => {
  app.remove();
});

const COMMAND: TopupCommand = { network: 'base', token: 'USDC', amount: '5', yes: true };
const FAST: TopupTiming = { intervalMs: 5, limitMs: 5_000 };

const env = (extra: Record<string, string> = {}): Record<string, string> => ({
  ANYFARE_API_URL: fake.apiUrl,
  ANYFARE_PAY_URL: fake.payUrl,
  ANYFARE_MASTER_KEY: account.masterKey,
  ...extra,
});

/** Runs the top-up itself, with a short poll, and keeps what it printed and how it ended. */
async function topup(
  command: TopupCommand = COMMAND,
  timing: TopupTiming = FAST,
  options: IoOptions = {},
  extra: Record<string, string> = {},
) {
  const io = captureIo(globalThis.fetch, env(extra), { appDir: app.dir, ...options });
  const ctx = createContext(io.io);
  let outcome;
  let failure: Error | undefined;
  try {
    outcome = await runTopup(ctx, command, timing);
  } catch (error) {
    failure = error as Error;
  } finally {
    ctx.close();
  }
  return { outcome, failure, out: io.out(), err: io.err() };
}

const cli = async (argv: readonly string[], extra: Record<string, string> = {}, options: IoOptions = {}) => {
  const io = captureIo(globalThis.fetch, env(extra), { appDir: app.dir, ...options });
  const code = await runCli(argv, io.io);
  return { code, out: io.out(), err: io.err() };
};

const topupArgs = ['topup', '--network', 'base', '--token', 'USDC', '--amount', '5'] as const;

describe('topup', () => {
  it('asks for an address, says who sends, and follows the top-up from waiting to credited', async () => {
    fake.topups.steps = [
      { status: 'waiting' },
      { status: 'waiting' },
      { status: 'processing', deposited: '5' },
      { status: 'credited', deposited: '5', credited: '4.95', transaction: MADE_UP_HASH },
    ];
    const result = await topup();
    expect(result.failure).toBeUndefined();
    expect(result.outcome).toEqual({ credited: true, status: 'credited' });
    expect(result.err).toBe('');
    const { out } = result;
    expect(out).toMatch(/Network\s+base/);
    expect(out).toMatch(/Token\s+USDC/);
    expect(out).toContain(`Send to       ${MADE_UP_DEPOSIT}`);
    expect(out).toMatch(/Send\s+5 USDC/);
    expect(out).toMatch(/At least\s+5 USDC/);
    expect(out).toMatch(/Credits\s+about \$4\.95/);
    expect(out).toMatch(/Pay by\s+2026-/);
    expect(out).toMatch(/Top-up ID\s+topup_madeup1/);
    expect(out).toContain('Send it yourself, from a wallet of yours. This app sends nothing.');
    expect(out).toContain("Ctrl-C is safe: npm run demo -- balance shows the result later. The top-up's ID is topup_madeup1.");
    // One line for each status, not for each poll
    expect(out.match(/Waiting for your transfer/g)).toHaveLength(1);
    expect(out).toContain('Received. Converting (deposited 5 USDC)');
    expect(out).toContain('✔ Added to your balance (deposited 5 USDC, credited $4.95)');
    expect(out).toContain(`Transaction ${MADE_UP_HASH}`);
    expect(out).toContain(`https://nearblocks.io/txns/${MADE_UP_HASH}`);
    expect(out).not.toContain('Memo');

    expect(fake.topups.created).toEqual([{ network: 'base', token: 'USDC', amount: '5' }]);
    const posts = fake.requests.filter((item) => item.method === 'POST' && item.path === '/v1/topups');
    expect(posts).toHaveLength(1);
    expect(posts[0]?.headers['authorization']).toBe(`Bearer ${account.masterKey}`);
    expect(`${out}${result.err}`).not.toContain(account.masterKey);
  });

  it('shows the memo, and says it is required', async () => {
    fake.topups.memo = 'madeup-memo-42';
    fake.topups.steps = [{ status: 'waiting' }, { status: 'credited', credited: '4.95' }];
    const result = await topup();
    expect(result.out).toMatch(/Memo\s+madeup-memo-42\s+\(the memo is required\)/);
  });

  it('follows incomplete, then credited', async () => {
    fake.topups.steps = [
      { status: 'waiting' },
      { status: 'incomplete', deposited: '2' },
      { status: 'credited', deposited: '5', credited: '4.95', transaction: MADE_UP_HASH },
    ];
    const result = await topup();
    expect(result.outcome?.credited).toBe(true);
    const lines = result.out.split('\n');
    const waiting = lines.findIndex((line) => line.includes('Waiting for your transfer'));
    const incomplete = lines.findIndex((line) => line.includes('Received less than the least to send. Send the rest before the time runs out (deposited 2 USDC)'));
    const credited = lines.findIndex((line) => line.includes('Added to your balance'));
    expect(waiting).toBeGreaterThan(-1);
    expect(incomplete).toBeGreaterThan(waiting);
    expect(credited).toBeGreaterThan(incomplete);
  });

  it('stops at refunded, without a credit', async () => {
    fake.topups.steps = [{ status: 'waiting' }, { status: 'refunded', deposited: '5', refunded: '5' }];
    const result = await topup();
    expect(result.outcome).toEqual({ credited: false, status: 'refunded' });
    expect(result.out).toContain('Not added. We hold the amount for you and will return it. Contact us (deposited 5 USDC, refunded 5 USDC)');
    expect(result.out).not.toContain('Transaction');
  });

  it('stops at expired', async () => {
    fake.topups.steps = [{ status: 'waiting' }, { status: 'expired' }];
    const result = await topup();
    expect(result.outcome).toEqual({ credited: false, status: 'expired' });
    expect(result.out).toContain("The time to pay ran out. Don't send to this address");
  });

  it('warns once about a poll that fails, and goes on', async () => {
    fake.topups.steps = [{ status: 'waiting' }, { status: 'credited', credited: '4.95' }];
    fake.topups.failPolls = 1;
    const result = await topup();
    expect(result.outcome?.credited).toBe(true);
    const warnings = result.err.trimEnd().split('\n');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Could not read the top-up's status: Anyfare failed with an internal error");
    expect(warnings[0]).toContain('Trying again.');
  });

  it('stops waiting at its time limit, and says where the result will be', async () => {
    fake.topups.steps = [{ status: 'waiting' }];
    const result = await topup(COMMAND, { intervalMs: 5, limitMs: 60 });
    expect(result.outcome).toBeUndefined();
    expect(result.failure?.message).toContain('Stopped waiting');
    expect(result.failure?.message).toContain('topup_madeup1');
    expect(result.failure?.message).toContain('balance shows the result later');
  });

  it('links only a transaction that has the shape of a hash', async () => {
    fake.topups.steps = [{ status: 'credited', credited: '4.95', transaction: 'not a hash' }];
    const result = await topup();
    expect(result.out).toContain('Transaction not a hash');
    expect(result.out).not.toContain('nearblocks');
  });

  it('asks first, and a no sends nothing', async () => {
    const result = await topup({ ...COMMAND, yes: false }, FAST, { isTerminal: true, input: 'n\n' });
    expect(result.out).toContain('Ask Anyfare for a deposit address for 5 USDC on base? [y/N]');
    expect(result.failure?.message).toBe('Nothing was asked.');
    expect(fake.requests).toEqual([]);
  });
});

describe('topup as a command', () => {
  it('exits 0 for credited and 1 for the others', async () => {
    fake.topups.steps = [{ status: 'credited', credited: '4.95', transaction: MADE_UP_HASH }];
    const credited = await cli([...topupArgs, '--yes']);
    expect(credited.code).toBe(0);
    expect(credited.out).toContain('✔ Added to your balance (credited $4.95)');

    fake.topups.steps = [{ status: 'expired' }];
    const expired = await cli([...topupArgs, '--yes']);
    expect(expired.code).toBe(1);
  });

  it('says plainly that this Anyfare has no top-ups on a 404', async () => {
    fake.topups.enabled = false;
    const result = await cli([...topupArgs, '--yes']);
    expect(result.code).toBe(1);
    expect(result.err).toBe('✘ Top-ups are not available on this Anyfare yet. The operator credits balances.\n');
  });

  it('says plainly that top-ups are off on topups_unavailable', async () => {
    fake.topups.unavailable = true;
    const result = await cli([...topupArgs, '--yes']);
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/^✘ Top-ups are off on this Anyfare now\. Nothing was made that could take a transfer \(request req-made-up-\d+\)\.\n$/);
  });

  it('needs the master key, and asks for nothing without it', async () => {
    const { fetch, calls } = fakeFetch({});
    const io = captureIo(fetch, { ANYFARE_API_URL: fake.apiUrl }, { appDir: app.dir });
    const code = await runCli([...topupArgs, '--yes'], io.io);
    expect(code).toBe(1);
    expect(io.err()).toBe('✘ ANYFARE_MASTER_KEY is not set. Add it to .env.local. Run npm run demo -- signup first.\n');
    expect(calls).toEqual([]);
    expect(fake.requests).toEqual([]);
  });

  it('is a usage error without a terminal and without --yes, before any request', async () => {
    const result = await cli(topupArgs);
    expect(result.code).toBe(2);
    expect(result.err).toBe('✘ topup asks before it asks Anyfare for a deposit address. Add --yes to go on without a terminal\n');
    expect(fake.requests).toEqual([]);
  });

  it('gives one line for an error of the API, such as a master key that is refused', async () => {
    const bad = await cli([...topupArgs, '--yes'], { ANYFARE_MASTER_KEY: 'afm_live_madeupmadeupmadeupmadeup' });
    expect(bad.code).toBe(1);
    expect(bad.err).toMatch(/^✘ The master key was refused: unknown or revoked \(request req-made-up-\d+\)\.\n$/);
  });
});

const posts = () => fake.requests.filter((item) => item.method === 'POST' && item.path === '/v1/topups');
const optionReads = () => fake.requests.filter((item) => item.path === '/v1/topups/options');

describe('the minimum, before anything is sent', () => {
  const args = (network: string, token: string, amount: string): string[] => ['topup', '--network', network, '--token', token, '--amount', amount, '--yes'];

  it('refuses 0.1 USDC on a $1 network with one line, and sends no POST', async () => {
    const result = await cli(args('base', 'USDC', '0.1'));
    expect(result.code).toBe(1);
    expect(result.err).toBe('✘ A top-up on base must be worth at least $1. 0.1 USDC is worth $0.10.\n');
    expect(result.out).toBe('');
    expect(posts()).toEqual([]);
    expect(fake.topups.created).toEqual([]);
    // The list is read once, and it needs no key
    expect(optionReads()).toHaveLength(1);
    expect(optionReads()[0]?.headers['authorization']).toBeUndefined();
  });

  it('lets 1 USDC pass, at the minimum, and sends it', async () => {
    fake.topups.steps = [{ status: 'credited', credited: '0.99' }];
    const result = await cli(args('base', 'USDC', '1'));
    expect(result.code).toBe(0);
    expect(fake.topups.created).toEqual([{ network: 'base', token: 'USDC', amount: '1' }]);
    expect(optionReads()).toHaveLength(1);
  });

  it.each(['USDC', 'USDT', 'USDT0', 'DAI'])('treats %s as a dollar', async (token) => {
    const result = await cli(args('near', token, '0.5'));
    expect(result.err).toBe(`✘ A top-up on near must be worth at least $1. 0.5 ${token} is worth $0.50.\n`);
    expect(posts()).toEqual([]);
  });

  it('does not price another token: it is sent, and the answer is the API\'s own', async () => {
    fake.topups.steps = [{ status: 'credited', credited: '0.1' }];
    const result = await cli(args('near', 'wNEAR', '0.1'));
    expect(result.code).toBe(0);
    expect(fake.topups.created).toEqual([{ network: 'near', token: 'wNEAR', amount: '0.1' }]);
  });

  it('treats the symbol exactly: another spelling is not a dollar', async () => {
    fake.topups.steps = [{ status: 'credited', credited: '0.1' }];
    const result = await cli(args('base', 'usdc', '0.1'));
    expect(result.code).toBe(0);
    expect(posts()).toHaveLength(1);
  });

  it('skips the check for a network that is not in the list, and when the list cannot be read', async () => {
    fake.topups.steps = [{ status: 'credited', credited: '0.1' }];
    const unknown = await cli(args('other-chain', 'USDC', '0.1'));
    expect(unknown.code).toBe(0);
    expect(posts()).toHaveLength(1);

    const broken = (async (input: string | URL | Request, init?: RequestInit) =>
      String(input).endsWith('/v1/topups/options')
        ? new Response('{}', { status: 500 })
        : globalThis.fetch(input, init)) as typeof fetch;
    const io = captureIo(broken, env(), { appDir: app.dir });
    const code = await runCli(args('base', 'USDC', '0.1'), io.io);
    expect(code).toBe(0);
    expect(posts()).toHaveLength(2);
  });

  it('shows the dollars with at least two decimals, and the minimum as the list gives it', () => {
    const options = { asset: null, networks: [{ name: 'n', minimum: '1.5', tokens: undefined }] };
    expect(minimumRefusal(options, 'n', 'DAI', '0.001')).toBe('A top-up on n must be worth at least $1.5. 0.001 DAI is worth $0.001.');
    expect(minimumRefusal(options, 'n', 'DAI', '1.499')).toBe('A top-up on n must be worth at least $1.5. 1.499 DAI is worth $1.499.');
    expect(minimumRefusal(options, 'n', 'DAI', '1.50')).toBeUndefined();
    expect(minimumRefusal(options, 'n', 'ETH', '0.001')).toBeUndefined();
    expect(minimumRefusal({ asset: null, networks: [{ name: 'n', minimum: null, tokens: undefined }] }, 'n', 'DAI', '0.001')).toBeUndefined();
  });

  it('adds one plain line when the API still says the amount is too low for 1Click', async () => {
    fake.topups.refuse = 'Amount is too low for bridge, try at least 1000000 (made up)';
    const result = await cli(args('base', 'USDC', '5'));
    expect(result.code).toBe(1);
    expect(result.err).toMatch(
      /^✘ The swap service refused the top-up\. No address was made: Amount is too low for bridge, try at least 1000000 \(made up\) \(request req-made-up-\d+\)\.\n/,
    );
    expect(result.err.endsWith(`.\n${UNDER_ITS_MINIMUM}\n`)).toBe(true);
    expect(result.err.split('\n')).toHaveLength(3);
    expect(UNDER_ITS_MINIMUM).toBe("That is under 1Click's own minimum for this route. Try a larger amount.");
  });

  it('adds nothing to another refusal', async () => {
    fake.topups.refuse = 'The route is closed (made up)';
    const result = await cli(args('base', 'USDC', '5'));
    expect(result.err).toMatch(/^✘ The swap service refused the top-up\. No address was made: The route is closed \(made up\) \(request req-made-up-\d+\)\.\n$/);
  });
});

describe('stopping the wait', () => {
  const SLOW: TopupTiming = { intervalMs: 20, limitMs: 20_000 };
  const STOPPED = /Stopped waiting\. The address stays open until \d{4}-\d{2}-\d{2}T[\d:.]+Z: a transfer sent before then is still credited, and `balance` shows it\. After that time, don't send to it\./;

  /** A top-up that waits on a terminal, with the input left open for the test to type into. */
  function waiting(options: { readonly signals?: EventEmitter; readonly interactive?: boolean } = {}) {
    const io = captureIo(globalThis.fetch, env(), { appDir: app.dir, isTerminal: true });
    const ctx = createContext(io.io);
    const stdin = io.io.stdin as PassThrough;
    const done = runTopup(ctx, COMMAND, SLOW, {
      ...(options.interactive === true && { interactive: true }),
      ...(options.signals !== undefined && { signals: options.signals }),
    }).finally(() => ctx.close());
    return { io, stdin, done };
  }

  it('stops polling at once on Enter, and says what it means', async () => {
    fake.topups.steps = [{ status: 'waiting' }];
    const run = waiting();
    await waitUntil(() => run.io.out().includes('Press Enter to stop waiting.'), 'the hint');
    await waitUntil(() => fake.topups.polls >= 1, 'a first poll');
    run.stdin.write('\n');
    const outcome = await run.done;
    expect(outcome).toEqual({ credited: false, status: 'stopped' });
    expect(run.io.out()).toMatch(STOPPED);
    const polls = fake.topups.polls;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fake.topups.polls).toBe(polls);
    // The same address stays: nothing was cancelled, since there is no route for it
    expect(fake.requests.filter((item) => item.method !== 'GET' && item.path !== '/v1/topups')).toEqual([]);
  });

  it('stops before the next poll when the interval is long', async () => {
    fake.topups.steps = [{ status: 'waiting' }];
    const io = captureIo(globalThis.fetch, env(), { appDir: app.dir, isTerminal: true });
    const ctx = createContext(io.io);
    const done = runTopup(ctx, COMMAND, { intervalMs: 60_000, limitMs: 120_000 }).finally(() => ctx.close());
    await waitUntil(() => io.out().includes('Press Enter to stop waiting.'), 'the hint');
    const started = Date.now();
    (io.io.stdin as PassThrough).write('\n');
    expect((await done).status).toBe('stopped');
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('prints no hint, and reads no Enter, without a terminal', async () => {
    fake.topups.steps = [{ status: 'waiting' }, { status: 'credited', credited: '4.95' }];
    const result = await topup();
    expect(result.outcome?.credited).toBe(true);
    expect(result.out).not.toContain('Press Enter');
  });

  it('still ends the wait on a credited status, and leaves the next line for the next question', async () => {
    fake.topups.steps = [{ status: 'waiting' }, { status: 'waiting' }, { status: 'credited', credited: '4.95' }];
    const signals = new EventEmitter();
    const run = waiting({ signals, interactive: true });
    await waitUntil(() => run.io.out().includes('Press Enter to stop waiting.'), 'the hint');
    expect(signals.listenerCount('SIGINT')).toBe(1);
    expect(await run.done).toEqual({ credited: true, status: 'credited' });
    expect(run.io.out()).not.toContain('Stopped waiting.');
    // The handler is gone, so a Ctrl-C now ends the app as it always does
    expect(signals.listenerCount('SIGINT')).toBe(0);
  });

  it('stops on the first Ctrl-C in the interactive mode, and takes its handler back', async () => {
    fake.topups.steps = [{ status: 'waiting' }];
    const signals = new EventEmitter();
    const run = waiting({ signals, interactive: true });
    await waitUntil(() => run.io.out().includes('Press Enter to stop waiting.'), 'the hint');
    signals.emit('SIGINT');
    expect(await run.done).toEqual({ credited: false, status: 'stopped' });
    expect(run.io.out()).toMatch(STOPPED);
    // A second Ctrl-C finds no handler: the process ends
    expect(signals.listenerCount('SIGINT')).toBe(0);
  });

  it('does not take Ctrl-C in the flags mode', async () => {
    fake.topups.steps = [{ status: 'waiting' }];
    const signals = new EventEmitter();
    const run = waiting({ signals });
    await waitUntil(() => run.io.out().includes('Press Enter to stop waiting.'), 'the hint');
    expect(signals.listenerCount('SIGINT')).toBe(0);
    run.stdin.write('\n');
    await run.done;
  });

  it('exits 1 after the line in the flags mode', async () => {
    fake.topups.steps = [{ status: 'waiting' }];
    const io = captureIo(globalThis.fetch, env(), { appDir: app.dir, isTerminal: true });
    const stdin = io.io.stdin as PassThrough;
    const running = runCli([...topupArgs, '--yes'], { ...io.io, topup: { timing: SLOW } });
    await waitUntil(() => io.out().includes('Press Enter to stop waiting.'), 'the hint');
    stdin.write('\n');
    expect(await running).toBe(1);
    expect(io.out()).toMatch(STOPPED);
    expect(io.err()).toBe('');
  });
});
