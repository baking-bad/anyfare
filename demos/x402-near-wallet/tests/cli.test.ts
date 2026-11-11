import { PassThrough, Writable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HANDLERS, HELP_TEXT, parseCommand, runCli } from '../src/cli.ts';
import type { Handlers, Io } from '../src/cli.ts';
import { NotSupported, UsageError } from '../src/util.ts';
import { startFakeNearRpc } from './fakeNearRpc.ts';
import type { FakeNearRpc } from './fakeNearRpc.ts';

const URL_OK = 'https://api.example.com/x';
const parse = (line: string) => parseCommand(line === '' ? [] : line.split(' '));

function usageMessage(line: string): string {
  try {
    parse(line);
  } catch (error) {
    expect(error).toBeInstanceOf(UsageError);
    return (error as UsageError).message;
  }
  throw new Error(`Expected a usage error for: ${line}`);
}

describe('parseCommand', () => {
  it('reads no arguments as interactive', () => {
    expect(parse('')).toEqual({ kind: 'interactive', options: { yes: false, dryRun: false, full: false } });
  });

  it('reads --max and --full alone as interactive', () => {
    expect(parse('--max 0.05 --full')).toEqual({
      kind: 'interactive',
      options: { yes: false, dryRun: false, full: true, maxUsd: '0.05' },
    });
  });

  it('reads balance, and refuses balance with anything else', () => {
    expect(parse('balance')).toEqual({ kind: 'balance' });
    expect(usageMessage('balance --yes')).toContain('balance');
    expect(usageMessage(`balance ${URL_OK}`)).toContain('balance');
    expect(usageMessage('--full balance')).toContain('balance');
  });

  it('refuses --yes or --dry-run without a request', () => {
    expect(usageMessage('--dry-run')).toBe('--dry-run needs a request. See --help');
    expect(usageMessage('--yes')).toBe('--yes needs a request. See --help');
  });

  it('refuses --yes with --dry-run', () => {
    expect(usageMessage(`--yes --dry-run ${URL_OK}`)).toBe('Use --yes or --dry-run, not both');
  });

  it('refuses a --max that is not a plain amount above zero', () => {
    for (const bad of ['0', 'abc', '0.0000001', '-1', '1e3', '0.0', '.5']) {
      expect(usageMessage(`--max ${bad} ${URL_OK}`)).toContain('--max');
    }
    expect(usageMessage(`${URL_OK} --max`)).toContain('--max');
    expect(parse(`--max=0.05 ${URL_OK}`)).toMatchObject({ options: { maxUsd: '0.05' } });
    expect(parse(`--max 0.000001 ${URL_OK}`)).toMatchObject({ options: { maxUsd: '0.000001' } });
  });

  it('takes the app options out of a request wherever they are', () => {
    const command = parse(`--yes -X POST --max 0.05 ${URL_OK} --full`);
    expect(command).toMatchObject({
      kind: 'request',
      options: { yes: true, dryRun: false, full: true, maxUsd: '0.05' },
      request: { method: 'POST', url: URL_OK, words: ['-X', 'POST', URL_OK], urlIndex: 2 },
    });
    expect(parse(`curl ${URL_OK} --dry-run`)).toMatchObject({ kind: 'request', options: { dryRun: true } });
  });

  it('reads a bare URL as a request', () => {
    expect(parse(URL_OK)).toMatchObject({ kind: 'request', request: { method: 'GET' } });
  });

  it('refuses a request that does not parse', () => {
    expect(usageMessage('-F a=b https://example.com')).toContain('-F is not supported');
    expect(usageMessage('http://example.com')).toBe('The URL must start with https://');
  });

  it('reads --help and -h anywhere as help, and -H is not help', () => {
    expect(parse('--help')).toEqual({ kind: 'help' });
    expect(parse('-h')).toEqual({ kind: 'help' });
    expect(parse(`${URL_OK} --yes -h`)).toEqual({ kind: 'help' });
    expect(parse(`--dry-run --help`)).toEqual({ kind: 'help' });
    expect(parse(`-H Accept:x ${URL_OK}`).kind).toBe('request');
  });
});

function fakeIo(env: Record<string, string> = {}): { io: Io; out: () => string; err: () => string } {
  let out = '';
  let err = '';
  const sink = (append: (text: string) => void) =>
    new Writable({
      write(chunk: Buffer, _encoding, done) {
        append(chunk.toString());
        done();
      },
    });
  const io: Io = {
    stdout: sink((text) => (out += text)),
    stderr: sink((text) => (err += text)),
    stdin: new PassThrough(),
    isTerminal: false,
    env,
    fetch: globalThis.fetch,
  };
  return { io, out: () => out, err: () => err };
}

describe('runCli', () => {
  it('writes the help and returns 0', async () => {
    const { io, out, err } = fakeIo();
    expect(await runCli(['--help'], io)).toBe(0);
    expect(out()).toBe(HELP_TEXT);
    expect(err()).toBe('');
    expect(HELP_TEXT.split('\n').length).toBeLessThanOrEqual(41);
  });

  it('writes one ✘ line and returns 2 for a usage error', async () => {
    const { io, out, err } = fakeIo();
    expect(await runCli(['http://example.com'], io)).toBe(2);
    expect(out()).toBe('');
    expect(err()).toBe('✘ The URL must start with https://\n');
  });

  it('returns 1 with one line from each stub', async () => {
    for (const argv of [[], [URL_OK]]) {
      const { io, err } = fakeIo();
      expect(await runCli(argv, io)).toBe(1);
      expect(err()).toBe('✘ Not built yet\n');
    }
  });

  it('returns 3 for NotSupported, and 1 for another error', async () => {
    const handlers: Handlers = {
      ...HANDLERS,
      balance: () => Promise.reject(new NotSupported('This API does not take USDC on NEAR.')),
      interactive: () => Promise.reject(new TypeError('Made up')),
    };
    const first = fakeIo();
    expect(await runCli(['balance'], first.io, handlers)).toBe(3);
    expect(first.err()).toBe('✘ This API does not take USDC on NEAR.\n');
    const second = fakeIo();
    expect(await runCli([], second.io, handlers)).toBe(1);
    expect(second.err()).toBe('✘ Made up\n');
  });
});

describe('balance', () => {
  // Made up: the account, its balances, and a key that is no key
  const ACCOUNT = 'alice.near';
  let rpc: FakeNearRpc;
  beforeAll(async () => {
    rpc = await startFakeNearRpc();
  });
  afterAll(async () => {
    await rpc.close();
  });
  beforeEach(() => {
    rpc.failing = undefined;
    rpc.calls.length = 0;
    rpc.setBalance(ACCOUNT, 990_000n, 120_000_000_000_000_000_000_000n);
  });

  const run = async (env: Record<string, string>) => {
    const { io, out, err } = fakeIo(env);
    const code = await runCli(['balance'], io);
    return { code, out: out(), err: err() };
  };

  it('prints the wallet block and returns 0', async () => {
    const { code, out, err } = await run({ NEAR_ACCOUNT_ID: ACCOUNT, NEAR_RPC_URL: rpc.url });
    expect(code).toBe(0);
    expect(err).toBe('');
    expect(out).toBe(
      ['Wallet    alice.near', 'Balance   0.990000 USDC · 0.1200 NEAR', 'Cap       $0.02 a call (MAX_PAYMENT_USD)', ''].join('\n'),
    );
    expect(rpc.balanceReads()).toHaveLength(2);
  });

  it('works with a NEAR_PRIVATE_KEY that is garbage, and never reads it', async () => {
    const { code, out, err } = await run({ NEAR_ACCOUNT_ID: ACCOUNT, NEAR_RPC_URL: rpc.url, NEAR_PRIVATE_KEY: 'garbage-made-up-key' });
    expect(code).toBe(0);
    expect(out).toContain('0.990000 USDC');
    expect(out + err).not.toContain('garbage-made-up-key');
  });

  it('shows the cap from MAX_PAYMENT_USD', async () => {
    const { out } = await run({ NEAR_ACCOUNT_ID: ACCOUNT, NEAR_RPC_URL: rpc.url, MAX_PAYMENT_USD: '0.5' });
    expect(out).toContain('Cap       $0.5 a call (MAX_PAYMENT_USD)');
  });

  it('prints the wallet and cap, then one ✘ line and returns 1, when the RPC fails', async () => {
    rpc.failing = { status: 503 };
    const { code, out, err } = await run({ NEAR_ACCOUNT_ID: ACCOUNT, NEAR_RPC_URL: rpc.url });
    expect(code).toBe(1);
    expect(out).toBe(['Wallet    alice.near', 'Cap       $0.02 a call (MAX_PAYMENT_USD)', ''].join('\n'));
    expect(err).toBe(`✘ Could not read the balance: the NEAR RPC at ${new URL(rpc.url).host} answered 503.\n`);
  });

  it('says so in one line and returns 1 when NEAR_ACCOUNT_ID is not set', async () => {
    const { code, out, err } = await run({});
    expect(code).toBe(1);
    expect(out).toBe('');
    expect(err).toBe('✘ NEAR_ACCOUNT_ID is not set. Set it in .env.local or the shell, such as NEAR_ACCOUNT_ID=alice.near\n');
  });
});
