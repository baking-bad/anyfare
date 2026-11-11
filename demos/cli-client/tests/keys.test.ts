// The Anyfare keys from the command line: the two flags, `key save`, and the interactive mode's "Use
// keys I have". Against the fake Anyfare: every key, account and balance here is made up.

import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FLAG_KEY_WARNING, HELP_TEXT, parseCommand, runCli } from '../src/cli.ts';
import { UsageError, short } from '../src/util.ts';
import { forwardingFetch, madeUpKey, startFakeAnyfare, toolRoutes, toolTargets } from './fakeAnyfare.ts';
import type { FakeAccount, FakeAnyfare, FakeKey } from './fakeAnyfare.ts';
import { captureIo, expectNoSecretIn, fakeTerminalInput, tempAppDir, waitUntil } from './helpers.ts';
import type { IoOptions } from './helpers.ts';

let fake: FakeAnyfare;
let app: { dir: string; remove: () => void };
/** Every output of the test, and every key it made: no output may hold a key, nor a part of one. */
const outputs: string[] = [];
const secrets: string[] = [];

beforeAll(async () => {
  fake = await startFakeAnyfare();
});
afterAll(async () => {
  await fake.close();
});
beforeEach(() => {
  fake.reset();
  for (const target of Object.values(toolTargets())) fake.addTarget(target);
  app = tempAppDir();
});
afterEach(() => {
  try {
    expectNoSecretIn(outputs.join('\n'), secrets);
  } finally {
    outputs.length = 0;
    secrets.length = 0;
    app.remove();
  }
});

/** A made-up account with a made-up balance, and a payment key of it. */
function funded(balance = '1'): { account: FakeAccount; key: FakeKey } {
  const account = fake.addAccount(balance);
  const key = fake.addKey(account, { label: 'demo', dailyBudget: '1', maxPrice: '0.02' });
  secrets.push(account.masterKey, key.key);
  return { account, key };
}

/** A made-up key that the fake Anyfare does not know. */
function unknownKey(prefix: 'afm_live_' | 'af_live_'): string {
  const key = madeUpKey(prefix);
  secrets.push(key);
  return key;
}

async function run(argv: readonly string[], env: Record<string, string> = {}, options: IoOptions & { readonly stdin?: Readable } = {}) {
  const { fetch } = forwardingFetch(toolRoutes());
  const io = captureIo(fetch, { ANYFARE_API_URL: fake.apiUrl, ANYFARE_PAY_URL: fake.payUrl, ...env }, { appDir: app.dir, ...options });
  const code = await runCli(argv, options.stdin === undefined ? io.io : { ...io.io, stdin: options.stdin });
  outputs.push(io.out(), io.err());
  return { code, out: io.out(), err: io.err() };
}

/** The variables of .env.local; `undefined` when there is none. */
function savedKeys(): Record<string, string> | undefined {
  let text: string;
  try {
    text = readFileSync(join(app.dir, '.env.local'), 'utf8');
  } catch {
    return undefined;
  }
  const keys: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) keys[match[1]] = match[2];
  }
  return keys;
}

const requested = () => fake.requests.map((item) => `${item.host} ${item.method} ${item.path}`);
const paidRequests = () => fake.routed().filter((item) => item.headers['authorization'] !== undefined);

function usageMessage(argv: readonly string[]): string {
  try {
    parseCommand(argv);
  } catch (error) {
    expect(error).toBeInstanceOf(UsageError);
    outputs.push((error as UsageError).message);
    return (error as UsageError).message;
  }
  throw new Error(`Expected a usage error for: ${argv.join(' ')}`);
}

describe('the key flags', () => {
  it('are taken by each command that uses the key', () => {
    const master = unknownKey('afm_live_');
    const payment = unknownKey('af_live_');
    expect(parseCommand(['balance', '--master-key', master, '--payment-key', payment])).toEqual({ kind: 'balance', keys: { master, payment } });
    expect(parseCommand(['key', 'create', '--master-key', master, '--yes'])).toMatchObject({ kind: 'key-create', yes: true, keys: { master } });
    expect(parseCommand(['topup', '--network', 'base', '--token', 'USDC', '--amount', '5', '--master-key', master])).toMatchObject({
      kind: 'topup',
      keys: { master },
    });
    expect(parseCommand(['call', '--tool', 'cmc', '--pay', 'credits', '--payment-key', payment])).toMatchObject({ kind: 'call', keys: { payment } });
    expect(parseCommand(['key', 'save', '--payment-key', payment, '--master-key', master, '--yes'])).toEqual({
      kind: 'key-save',
      yes: true,
      keys: { master, payment },
    });
    expect(parseCommand(['key', 'save'])).toEqual({ kind: 'key-save', yes: false });
    // No command: the interactive mode, with the keys for its run
    expect(parseCommand(['--payment-key', payment])).toEqual({ kind: 'interactive', keys: { payment } });
    expect(parseCommand(['--master-key', master, '--payment-key', payment])).toEqual({ kind: 'interactive', keys: { master, payment } });
    // Without a flag, a command has no keys
    expect(parseCommand(['balance'])).toEqual({ kind: 'balance' });
  });

  it('are refused by each command that does not use the key', () => {
    const master = unknownKey('afm_live_');
    const payment = unknownKey('af_live_');
    expect(usageMessage(['key', 'create', '--payment-key', payment])).toBe("key create doesn't take --payment-key");
    expect(usageMessage(['topup', '--network', 'base', '--token', 'USDC', '--amount', '5', '--payment-key', payment])).toBe(
      "topup doesn't take --payment-key",
    );
    expect(usageMessage(['call', '--tool', 'cmc', '--pay', 'credits', '--master-key', master])).toBe("call doesn't take --master-key");
    for (const way of ['base', 'near', 'tempo']) {
      expect(usageMessage(['call', '--tool', 'cmc', '--pay', way, '--payment-key', payment])).toBe(`--payment-key is for --pay credits, not --pay ${way}`);
    }
    expect(usageMessage(['signup', '--master-key', master])).toBe("signup doesn't take --master-key");
    expect(usageMessage(['explain', '--tool', 'cmc', '--payment-key', payment])).toBe("explain doesn't take --payment-key");
    expect(usageMessage(['key', 'save', '--label', 'demo'])).toBe("key save doesn't take --label");
    // The interactive mode takes the two keys and nothing else
    expect(usageMessage(['--payment-key', payment, '--yes'])).toBe("The interactive mode doesn't take --yes");
    expect(usageMessage(['--yes'])).toBe('Name a command. See --help');
    expect(usageMessage(['balance', '--payment-key'])).toBe('--payment-key needs a value');
  });

  it('refuses a key of the other kind, or no key at all, naming the flag and never quoting it', () => {
    const master = unknownKey('afm_live_');
    const payment = unknownKey('af_live_');
    const asPayment = '--payment-key is a master key, not a payment key. A payment key starts with af_';
    const asMaster = '--master-key is a payment key, not a master key. A master key starts with afm_';
    expect(usageMessage(['balance', '--payment-key', master])).toBe(asPayment);
    expect(usageMessage(['balance', '--master-key', payment])).toBe(asMaster);
    expect(usageMessage(['call', '--tool', 'cmc', '--pay', 'credits', '--payment-key', master])).toBe(asPayment);
    expect(usageMessage(['key', 'create', '--master-key', payment])).toBe(asMaster);
    expect(usageMessage(['topup', '--network', 'base', '--token', 'USDC', '--amount', '5', '--master-key', payment])).toBe(asMaster);
    expect(usageMessage(['key', 'save', '--payment-key', master])).toBe(asPayment);
    expect(usageMessage(['--payment-key', master])).toBe(asPayment);
    expect(usageMessage(['--master-key', payment])).toBe(asMaster);
    expect(usageMessage(['balance', '--payment-key', 'af_live_made-up-with-dashes'])).toBe(
      '--payment-key does not look like a payment key. A payment key starts with af_',
    );
    expect(usageMessage(['balance', '--master-key', 'made-up'])).toBe('--master-key does not look like a master key. A master key starts with afm_');
  });

  it('refuses a key of the other kind before any request, with exit code 2', async () => {
    const { account, key } = funded();
    const result = await run(['balance', '--master-key', key.key, '--payment-key', account.masterKey]);
    expect(result.code).toBe(2);
    expect(result.err).toBe(`${FLAG_KEY_WARNING}\n✘ --master-key is a payment key, not a master key. A master key starts with afm_\n`);
    expect(result.out).toBe('');
    expect(fake.requests).toEqual([]);
  });

  it('win over the environment, for that run', async () => {
    const first = funded('1.25');
    const second = funded('7.5');
    const master = await run(['balance', '--master-key', second.account.masterKey], { ANYFARE_MASTER_KEY: first.account.masterKey });
    expect(master.code).toBe(0);
    expect(master.out).toMatch(/Available\s+\$7\.5\n/);
    expect(fake.requests.map((item) => item.headers['authorization'])).toEqual([`Bearer ${second.account.masterKey}`]);

    fake.requests.length = 0;
    const payment = await run(['call', '--tool', 'cmc', '--pay', 'credits', '--payment-key', second.key.key, '--yes'], {
      ANYFARE_PAYMENT_KEY: first.key.key,
    });
    expect(payment.code).toBe(0);
    expect(paidRequests().map((item) => item.headers['authorization'])).toEqual([`Bearer ${second.key.key}`]);
    // Made up: the second account paid the call's $0.011, the first paid nothing
    expect(second.account.available).toBe(7_489_000n);
    expect(first.account.available).toBe(1_250_000n);
  });

  it('are never saved by themselves', async () => {
    const { account, key } = funded();
    expect((await run(['call', '--tool', 'cmc', '--pay', 'credits', '--payment-key', key.key, '--yes'])).code).toBe(0);
    expect((await run(['balance', '--master-key', account.masterKey, '--payment-key', key.key])).code).toBe(0);
    expect(savedKeys()).toBeUndefined();
    // key create saves the key it makes, never the master key of the flag
    expect((await run(['key', 'create', '--master-key', account.masterKey, '--yes'])).code).toBe(0);
    const saved = savedKeys() ?? {};
    expect(Object.keys(saved)).toEqual(['ANYFARE_PAYMENT_KEY']);
    secrets.push(saved['ANYFARE_PAYMENT_KEY'] ?? '');
    expect(readFileSync(join(app.dir, '.env.local'), 'utf8')).not.toContain(account.masterKey);
  });

  it('start the interactive mode with the key, which pays the call and is not saved', async () => {
    const { key } = funded();
    // CoinMarketCap, the default pair, Credits, pay, no more
    const result = await run(['--payment-key', key.key], {}, { isTerminal: true, input: '3\n1\n\n1\ny\n4\n' });
    expect(result.err).toBe(`${FLAG_KEY_WARNING}\n`);
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/1 {2}Credits {2}needs ANYFARE_PAYMENT_KEY {2}✔ {2}\$1\n/);
    expect(result.out).not.toContain('How do you get one?');
    expect(paidRequests().map((item) => item.headers['authorization'])).toEqual([`Bearer ${key.key}`]);
    expect(savedKeys()).toBeUndefined();
  });

  it('say in the help, in one line, where a key in a flag shows, and how to run without npm', () => {
    expect(HELP_TEXT.split('\n').map((line) => line.trim())).toContain(
      "A key in a flag shows on screen and in npm's log, your shell's history and the process list. Use .env.local or key save. " +
        'If you must, run node directly: node --env-file-if-exists=.env --env-file-if-exists=.env.local src/main.ts --payment-key …',
    );
    for (const word of ['--master-key <afm_…>', '--payment-key <af_…>', 'key save', 'BASE_RPC_URL']) expect(HELP_TEXT).toContain(word);
    // No npm example carries a key flag
    expect(HELP_TEXT).not.toMatch(/npm run demo -- .*--(master|payment)-key/);
    expect(HELP_TEXT).not.toMatch(/^ {2}key save .*--(master|payment)-key/m);
    expect(HELP_TEXT).toContain('On a terminal, it asks for them and shows nothing you type.');
  });
});

describe('key save', () => {
  it('asks for the payment key, then the master key, checks both for free, and saves them at mode 600', async () => {
    const { account, key } = funded();
    const result = await run(['key', 'save', '--yes'], {}, { input: `${key.key}\n${account.masterKey}\n` });
    expect(result.err).toBe('');
    expect(result.code).toBe(0);
    expect(result.out).toBe(
      [
        'Payment key, af_… (Enter to skip): Master key, afm_… (to skip: Enter, then y): ✔ Anyfare took the keys, in a free check',
        `  Payment key     ${short(key.key)}`,
        `  Master key      ${short(account.masterKey)}`,
        '✔ Saved to .env.local',
        '',
      ].join('\n'),
    );
    // The free checks: the payment key at the proxy, the master key at the Platform API
    expect(requested()).toEqual(['pay GET /_/key', 'api GET /v1/account']);
    expect(fake.requests.map((item) => item.headers['authorization'])).toEqual([`Bearer ${key.key}`, `Bearer ${account.masterKey}`]);
    expect(savedKeys()).toEqual({ ANYFARE_PAYMENT_KEY: key.key, ANYFARE_MASTER_KEY: account.masterKey });
    expect(statSync(join(app.dir, '.env.local')).mode & 0o777).toBe(0o600);
  });

  it('reads each key with the echo off on a terminal, takes a backspace, and asks before it saves', async () => {
    const { account, key } = funded();
    const tty = fakeTerminalInput();
    const { fetch } = forwardingFetch(toolRoutes());
    const io = captureIo(fetch, { ANYFARE_API_URL: fake.apiUrl, ANYFARE_PAY_URL: fake.payUrl }, { appDir: app.dir, isTerminal: true });
    const running = runCli(['key', 'save'], { ...io.io, stdin: tty });
    await waitUntil(() => tty.modes.length === 1, 'raw mode for the payment key');
    // A wrong first key, taken back, then the key, one key at a time. No key has a #
    for (const char of `#\x7f${key.key}\r`) tty.write(char);
    await waitUntil(() => tty.modes.length === 3, 'raw mode for the master key');
    for (const char of `${account.masterKey}\r`) tty.write(char);
    await waitUntil(() => io.out().includes('Save to .env.local? [y/N]'), 'the question');
    expect(tty.modes).toEqual([true, false, true, false]);
    tty.write('y\n');
    expect(await running).toBe(0);
    outputs.push(io.out(), io.err());
    // Nothing of what was typed: each question ends with the line end the terminal did not echo
    expect(io.out()).toContain('Payment key, af_… (Enter to skip): \nMaster key, afm_… (to skip: Enter, then y): \n✔ Anyfare took the keys');
    expect(io.out()).not.toContain('#');
    expect(savedKeys()).toEqual({ ANYFARE_PAYMENT_KEY: key.key, ANYFARE_MASTER_KEY: account.masterKey });
  });

  it('stops on Ctrl-C at a hidden question, with raw mode off, and saves nothing', async () => {
    const { key } = funded();
    const tty = fakeTerminalInput();
    const { fetch } = forwardingFetch(toolRoutes());
    const io = captureIo(fetch, { ANYFARE_API_URL: fake.apiUrl, ANYFARE_PAY_URL: fake.payUrl }, { appDir: app.dir, isTerminal: true });
    const running = runCli(['key', 'save'], { ...io.io, stdin: tty });
    await waitUntil(() => tty.modes.length === 1, 'raw mode');
    for (const char of key.key.slice(0, 20)) tty.write(char);
    tty.write('\x03');
    expect(await running).toBe(1);
    outputs.push(io.out(), io.err());
    expect(io.err()).toBe('✘ Stopped. Nothing was saved.\n');
    expect(tty.modes).toEqual([true, false]);
    expect(fake.requests).toEqual([]);
    expect(savedKeys()).toBeUndefined();
  });

  it('saves nothing when Anyfare refuses the payment key, with the usual error line', async () => {
    const { account } = funded();
    const result = await run(['key', 'save', '--yes'], {}, { input: `${unknownKey('af_live_')}\n${account.masterKey}\n` });
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/^✘ The payment key was refused: unknown, revoked or expired \(request req-made-up-\d+\)\. Nothing was saved\.\n$/);
    expect(result.out).not.toContain('Saved');
    expect(savedKeys()).toBeUndefined();
  });

  it('saves nothing, not even the payment key that works, when Anyfare refuses the master key', async () => {
    const { key } = funded();
    const result = await run(['key', 'save', '--yes'], {}, { input: `${key.key}\n${unknownKey('afm_live_')}\n` });
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/^✘ The master key was refused: unknown or revoked \(request req-made-up-\d+\)\. Nothing was saved\.\n$/);
    expect(requested()).toEqual(['pay GET /_/key', 'api GET /v1/account']);
    expect(savedKeys()).toBeUndefined();
  });

  it('saves nothing when a key can not be checked', async () => {
    const { key } = funded();
    // ANYFARE_PAY_URL of a host that does not answer here
    const result = await run(['key', 'save', '--payment-key', key.key, '--yes'], { ANYFARE_PAY_URL: 'https://pay.example.test' });
    expect(result.code).toBe(1);
    expect(result.err).toBe(`${FLAG_KEY_WARNING}\n✘ Could not reach pay.example.test: ENOTFOUND. Nothing was saved.\n`);
    expect(savedKeys()).toBeUndefined();
  });

  it('takes the keys from the flags, checks them, and asks for none', async () => {
    const { key } = funded();
    const result = await run(['key', 'save', '--payment-key', key.key, '--yes']);
    expect(result.code).toBe(0);
    expect(result.out).not.toContain('Enter to skip');
    expect(result.out).toContain(`✔ Anyfare took the key, in a free check\n  Payment key     ${short(key.key)}\n✔ Saved to .env.local\n`);
    expect(requested()).toEqual(['pay GET /_/key']);
    expect(savedKeys()).toEqual({ ANYFARE_PAYMENT_KEY: key.key });
  });

  it('asks again after a key of the other kind, without quoting it, and skips the master key on Enter and a yes', async () => {
    const { account, key } = funded();
    const result = await run(['key', 'save', '--yes'], {}, { input: `${account.masterKey}\n${key.key}\n\ny\n` });
    expect(result.code).toBe(0);
    expect(result.out).toContain('That is a master key, not a payment key. A payment key starts with af_.\n');
    expect(result.out.match(/Payment key, af_… \(Enter to skip\)/g)).toHaveLength(2);
    expect(requested()).toEqual(['pay GET /_/key']);
    expect(savedKeys()).toEqual({ ANYFARE_PAYMENT_KEY: key.key });
  });

  it('stops after three keys that are not one', async () => {
    const result = await run(['key', 'save', '--yes'], {}, { input: 'made-up\nmade-up\nmade-up\n' });
    expect(result.code).toBe(1);
    expect(result.out.match(/That does not look like a payment key\. A payment key starts with af_\./g)).toHaveLength(3);
    expect(result.err).toBe('✘ No payment key after 3 tries. Nothing was saved.\n');
    expect(fake.requests).toEqual([]);
  });

  it('is a usage error without a terminal and without --yes, before any key is asked for or sent', async () => {
    const { key } = funded();
    const result = await run(['key', 'save'], {}, { input: `${key.key}\n\n` });
    expect(result.code).toBe(2);
    expect(result.err).toBe('✘ key save asks before it saves. Add --yes to save without a terminal\n');
    expect(result.out).toBe('');
    expect(fake.requests).toEqual([]);
  });

  it('saves nothing on a "no", after the check', async () => {
    const { key } = funded();
    const result = await run(['key', 'save'], {}, { isTerminal: true, input: `${key.key}\n\ny\nn\n` });
    expect(result.code).toBe(1);
    expect(result.out).toContain('Save to .env.local? [y/N]');
    expect(result.err).toBe('✘ Nothing was saved.\n');
    expect(savedKeys()).toBeUndefined();
  });

  it('saves nothing when no key is given', async () => {
    const result = await run(['key', 'save', '--yes'], {}, { input: '\n\ny\n' });
    expect(result.code).toBe(1);
    expect(result.err).toBe('✘ No key was given. Nothing was saved.\n');
    expect(fake.requests).toEqual([]);
  });

  it('replaces a key in an existing .env.local, keeps its other lines, sets its mode to 600, and says so', async () => {
    const { key } = funded();
    const path = join(app.dir, '.env.local');
    writeFileSync(path, '# Mine\nANYFARE_PAYMENT_KEY=af_live_made-up-old\nMAX_PAYMENT_USD=0.05\n', { mode: 0o644 });
    const result = await run(['key', 'save', '--payment-key', key.key, '--yes']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('ANYFARE_PAYMENT_KEY is in .env.local already: the new key replaces it there.');
    expect(readFileSync(path, 'utf8')).toBe(`# Mine\nANYFARE_PAYMENT_KEY=${key.key}\nMAX_PAYMENT_USD=0.05\n`);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe('the interactive mode: "Use keys I have"', () => {
  async function session(answers: readonly string[], env: Record<string, string> = {}) {
    return run([], env, { isTerminal: true, input: `${answers.join('\n')}\n` });
  }

  it('checks the key, saves it on a yes, and pays with it', async () => {
    const { key } = funded();
    // CoinMarketCap, the default pair, Credits, keys I have: the payment key, no master key (Enter, then yes to skip); save; pay; no more
    const result = await session(['3', '1', '', '1', '2', key.key, '', 'y', 'y', 'y', '4']);
    expect(result.err).toBe('');
    expect(result.code).toBe(0);
    expect(result.out).toContain('Credits need an Anyfare key, and none is set. How do you get one?\n  1  Sign up: a new account, free\n  2  Use keys I have\n');
    expect(result.out).toContain('Skip the master key? [y/N]');
    expect(result.out).toContain(`✔ Anyfare took the key, in a free check\n  Payment key     ${short(key.key)}\nSave to .env.local? [y/N] ✔ Saved to .env.local\n`);
    expect(savedKeys()).toEqual({ ANYFARE_PAYMENT_KEY: key.key });
    expect(paidRequests().map((item) => item.headers['authorization'])).toEqual([`Bearer ${key.key}`]);
    expect(fake.requests.some((item) => item.method === 'POST' && item.path === '/v1/accounts')).toBe(false);
  });

  it('uses the key for this session only on a "no", saves nothing, and pays with it', async () => {
    const { key } = funded();
    const result = await session(['3', '1', '', '1', '2', key.key, '', 'y', 'n', 'y', '4']);
    expect(result.err).toBe('');
    expect(result.code).toBe(0);
    expect(result.out).toContain('Nothing was saved: the key works for this session only.');
    expect(savedKeys()).toBeUndefined();
    expect(paidRequests().map((item) => item.headers['authorization'])).toEqual([`Bearer ${key.key}`]);
  });

  it('with only a master key, saves it and makes the payment key after its own question', async () => {
    const { account } = funded();
    const result = await session(['3', '1', '', '1', '2', '', account.masterKey, 'y', 'y', 'y', '4']);
    expect(result.err).toBe('');
    expect(result.code).toBe(0);
    expect(result.out).toContain('Create a payment key "demo": daily budget $1, at most $0.02 a call, saved to .env.local? [y/N]');
    const saved = savedKeys() ?? {};
    secrets.push(saved['ANYFARE_PAYMENT_KEY'] ?? '');
    expect(saved['ANYFARE_MASTER_KEY']).toBe(account.masterKey);
    expect(saved['ANYFARE_PAYMENT_KEY']).toMatch(/^af_live_/);
    expect(paidRequests()).toHaveLength(1);
  });

  it('saves nothing, and goes back to the way to pay, when Anyfare refuses the key', async () => {
    const result = await session(['3', '1', '', '1', '2', unknownKey('af_live_'), '', 'y']);
    expect(result.err).toMatch(/^✘ The payment key was refused: unknown, revoked or expired \(request req-made-up-\d+\)\. Nothing was saved\.\n/);
    expect(result.out.match(/How do you pay\?/g)).toHaveLength(2);
    expect(savedKeys()).toBeUndefined();
    expect(paidRequests()).toEqual([]);
  });
});

/** `key save` or the interactive mode on a fake terminal: the keys are typed one key at a time. */
function onTerminal(argv: readonly string[], env: Record<string, string> = {}) {
  const tty = fakeTerminalInput();
  const { fetch } = forwardingFetch(toolRoutes());
  const io = captureIo(fetch, { ANYFARE_API_URL: fake.apiUrl, ANYFARE_PAY_URL: fake.payUrl, ...env }, { appDir: app.dir, isTerminal: true });
  const running = runCli(argv, { ...io.io, stdin: tty }).then((code) => {
    outputs.push(io.out(), io.err());
    return code;
  });
  const type = (text: string): void => {
    for (const char of text) tty.write(char);
  };
  const shown = (text: string): Promise<void> => waitUntil(() => io.out().includes(text), text);
  const rawTimes = (count: number): Promise<void> => waitUntil(() => tty.modes.filter((mode) => mode).length === count, `raw mode ${count} times`);
  return { tty, io, running, type, shown, rawTimes };
}

describe('key save on a terminal: a stray Enter, and a key at a visible question', () => {
  it('drops a second Enter typed after the payment key: the master key is still asked for, hidden', async () => {
    const { account, key } = funded();
    const run = onTerminal(['key', 'save']);
    await run.rawTimes(1);
    run.type(`${key.key}\r\r`);
    await run.rawTimes(2);
    run.type(`${account.masterKey}\r`);
    await run.shown('Save to .env.local? [y/N]');
    run.tty.write('y\n');
    expect(await run.running).toBe(0);
    expect(run.io.out()).not.toContain('Skip the master key?');
    expect(savedKeys()).toEqual({ ANYFARE_PAYMENT_KEY: key.key, ANYFARE_MASTER_KEY: account.masterKey });
  });

  it('asks once more, plainly, after an Enter at the master key, and only a y skips it', async () => {
    const { account, key } = funded();
    const run = onTerminal(['key', 'save']);
    await run.rawTimes(1);
    run.type(`${key.key}\r`);
    await run.rawTimes(2);
    // An Enter after the master key's question appeared
    run.type('\r');
    await run.shown('Skip the master key? [y/N] ');
    // Enter is a no: the master key is asked for again, hidden
    run.tty.write('\n');
    await run.rawTimes(3);
    run.type(`${account.masterKey}\r`);
    await run.shown('Save to .env.local? [y/N]');
    run.tty.write('y\n');
    expect(await run.running).toBe(0);
    expect(run.io.out().match(/Master key, afm_… \(to skip: Enter, then y\)/g)).toHaveLength(2);
    expect(savedKeys()).toEqual({ ANYFARE_PAYMENT_KEY: key.key, ANYFARE_MASTER_KEY: account.masterKey });
  });

  it('refuses a key typed at the save question, says it showed, uses and saves nothing, and asks again', async () => {
    const { account, key } = funded();
    const run = onTerminal(['key', 'save']);
    await run.rawTimes(1);
    run.type(`${key.key}\r`);
    await run.rawTimes(2);
    run.type('\r');
    await run.shown('Skip the master key? [y/N] ');
    run.tty.write('y\n');
    await run.shown('Save to .env.local? [y/N] ');
    // The master key, typed where the terminal shows it
    run.tty.write(`${account.masterKey}\n`);
    await run.shown('It showed on your screen');
    run.tty.write('n\n');
    expect(await run.running).toBe(1);
    expect(run.io.out()).toContain(
      'Save to .env.local? [y/N] That looks like a key. It was not used or saved; type y or n.\n' +
        'It showed on your screen: if it is real, revoke it and make a new one.\n' +
        'Save to .env.local? [y/N] ',
    );
    expect(run.io.err()).toBe('✘ Nothing was saved.\n');
    expect(savedKeys()).toBeUndefined();
    // The key typed there was never sent
    expect(fake.requests.some((item) => item.headers['authorization'] === `Bearer ${account.masterKey}`)).toBe(false);
  });

  it('drops a y typed before the save question appeared, and saves nothing on Enter', async () => {
    const { key } = funded();
    const run = onTerminal(['key', 'save']);
    await run.rawTimes(1);
    run.type(`${key.key}\r`);
    await run.rawTimes(2);
    run.type('\r');
    await run.shown('Skip the master key? [y/N] ');
    // A yes, and a y typed ahead of the save question
    run.tty.write('y\ny\n');
    await run.shown('Save to .env.local? [y/N] ');
    run.tty.write('\n');
    expect(await run.running).toBe(1);
    expect(run.io.err()).toBe('✘ Nothing was saved.\n');
    expect(savedKeys()).toBeUndefined();
  });

  it('the interactive mode saves nothing on Enter at its save question: the key is for this session only', async () => {
    const { key } = funded();
    // CoinMarketCap, the default pair, Credits, keys I have: the payment key, no master key; Enter at the save; pay; no more
    const result = await run([], {}, { isTerminal: true, input: ['3', '1', '', '1', '2', key.key, '', 'y', '', 'y', '4', ''].join('\n') });
    expect(result.code).toBe(0);
    expect(result.out).toContain('Save to .env.local? [y/N] Nothing was saved: the key works for this session only.');
    expect(savedKeys()).toBeUndefined();
    expect(paidRequests().map((item) => item.headers['authorization'])).toEqual([`Bearer ${key.key}`]);
  });
});

describe('a key from a flag', () => {
  it('gets one warning first on stderr, in either form of the flag', async () => {
    const { account, key } = funded();
    const spaced = await run(['balance', '--master-key', account.masterKey]);
    expect(spaced.code).toBe(0);
    expect(spaced.err).toBe(`${FLAG_KEY_WARNING}\n`);
    const joined = await run(['balance', `--payment-key=${key.key}`]);
    expect(joined.code).toBe(0);
    expect(joined.err).toBe(`${FLAG_KEY_WARNING}\n`);
    expect(FLAG_KEY_WARNING).toBe("A key from a flag can show in npm's output and log, your shell's history and the process list. Prefer key save.");
  });

  it('gets no warning when no key is on the command line', async () => {
    const { account } = funded();
    expect((await run(['balance'], { ANYFARE_MASTER_KEY: account.masterKey })).err).toBe('');
    expect((await run(['balance', '--payment-key'])).err).toBe('✘ --payment-key needs a value\n');
  });
});

describe('a payment key and a master key of two accounts', () => {
  /** Made up: account A holds $5 and has the master key; account B holds $0.25 and has the payment key. */
  function twoAccounts(b = '0.25'): Record<string, string> {
    const a = funded('5');
    const other = funded(b);
    return { ANYFARE_MASTER_KEY: a.account.masterKey, ANYFARE_PAYMENT_KEY: other.key.key };
  }

  it('balance shows the payment key its own Credits, and says the accounts differ', async () => {
    const result = await run(['balance'], twoAccounts());
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/▸ Credits, with the master key\n {2}Available {7}\$5\n/);
    expect(result.out).toMatch(/Per call {8}at most \$0\.02\n {2}Available {7}\$0\.25\n/);
    expect(result.out).toContain(
      "  The payment key is of another account than the master key: a call it pays takes its own account's Credits.\n",
    );
  });

  it("the way-to-pay list shows the payment key's Credits", async () => {
    const result = await run([], twoAccounts(), { isTerminal: true, input: '3\n1\n\n' });
    expect(result.out).toContain('  1  Credits  needs ANYFARE_PAYMENT_KEY  ✔  $0.25\n');
  });

  it("the check before a Credits call reads the payment key's Credits, and offers no top-up to the other account", async () => {
    // CoinMarketCap, the default pair, Credits; then the input ends
    const result = await run([], twoAccounts('0.001'), { isTerminal: true, input: '3\n1\n\n1\n' });
    expect(result.out).toContain('Your balance is $0.001, and this call costs $0.011 of Credits.');
    expect(result.out).toContain(
      "The payment key is of another account than the master key: a call it pays takes its own account's Credits. A top-up with the master key would not reach it.",
    );
    expect(result.out).not.toContain('Add Credits with a top-up?');
    expect(result.out.match(/How do you pay\?/g)).toHaveLength(2);
    expect(paidRequests()).toEqual([]);
  });
});

describe('key save in a console that shows what is typed', () => {
  /** Piped input, and an output that is a terminal: as in a console without a TTY for its input. */
  async function inEchoingConsole(argv: readonly string[], input: string) {
    const { fetch } = forwardingFetch(toolRoutes());
    const io = captureIo(fetch, { ANYFARE_API_URL: fake.apiUrl, ANYFARE_PAY_URL: fake.payUrl }, { appDir: app.dir, input });
    Object.assign(io.io.stdout, { isTTY: true });
    const code = await runCli(argv, io.io);
    outputs.push(io.out(), io.err());
    return { code, out: io.out(), err: io.err() };
  }

  it('refuses to ask for a key, before any question or request', async () => {
    const { key } = funded();
    const result = await inEchoingConsole(['key', 'save', '--yes'], `${key.key}\n`);
    expect(result.code).toBe(2);
    expect(result.err).toBe("✘ This console can't hide what you type. Give the keys with .env.local, or run in a terminal.\n");
    expect(result.out).toBe('');
    expect(fake.requests).toEqual([]);
    expect(savedKeys()).toBeUndefined();
  });

  it('still takes the keys from the flags there', async () => {
    const { key } = funded();
    const result = await inEchoingConsole(['key', 'save', '--payment-key', key.key, '--yes'], '');
    expect(result.code).toBe(0);
    expect(savedKeys()).toEqual({ ANYFARE_PAYMENT_KEY: key.key });
  });
});
