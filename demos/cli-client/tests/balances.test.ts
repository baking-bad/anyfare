// The wallets' balances: in `balance`, in the interactive mode's list of ways to pay, and in the check
// before a payment. Every key here is made in the test, in memory only, and holds nothing. Every
// balance, account and address is made up, and read from made-up RPCs on 127.0.0.1 that take no
// transaction. Prices are the fake Anyfare's, made up, dated 2026-11-09.

import { generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readWalletBalance } from '../src/balances.ts';
import { runCli } from '../src/cli.ts';
import { createContext } from '../src/context.ts';
import { DEFAULT_ARGS } from '../src/tools/index.ts';
import { Stop, toAtomic } from '../src/util.ts';
import { callWithX402 } from '../src/x402.ts';
import { BASE_DEFAULT_RPC_URL, readBaseRpc } from '../src/wallets.ts';
import { forwardingFetch, startFakeAnyfare, toolRoutes, toolTargets } from './fakeAnyfare.ts';
import type { FakeAnyfare, FakeTarget } from './fakeAnyfare.ts';
import { BASE_USDC, startFakeBaseRpc } from './fakeBaseRpc.ts';
import type { FakeBaseRpc } from './fakeBaseRpc.ts';
import { base58, startFakeNearRpc } from './fakeNearRpc.ts';
import type { FakeNearRpc } from './fakeNearRpc.ts';
import { startFakeTempoRpc } from './fakeTempoRpc.ts';
import type { FakeTempoRpc } from './fakeTempoRpc.ts';
import { captureIo, expectNoSecretIn, tempAppDir } from './helpers.ts';
import type { IoOptions } from './helpers.ts';

const NEAR_USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
// Made up: where the fake Anyfare takes USDC on Base and on NEAR, and the buyer's NEAR account
const BASE_PAY_TO = '0x00000000000000000000000000000000000000b1';
const NEAR_PAY_TO = 'pay.anyfare.near';
const NEAR_ACCOUNT = 'buyer.example.near';

/** A NEAR key made here: an ed25519 seed and its public key, base58, as NEAR writes a secret key; and its public key. */
function nearTestKey(): { readonly secretKey: string; readonly publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const seed = Buffer.from(privateKey.export({ format: 'jwk' }).d ?? '', 'base64url');
  const pub = Buffer.from(publicKey.export({ format: 'jwk' }).x ?? '', 'base64url');
  return { secretKey: `ed25519:${base58(Buffer.concat([seed, pub]))}`, publicKey: `ed25519:${base58(pub)}` };
}

const BASE_KEY = generatePrivateKey();
const BASE_PAYER = privateKeyToAccount(BASE_KEY).address;
const TEMPO_KEY = generatePrivateKey();
const TEMPO_PAYER = privateKeyToAccount(TEMPO_KEY).address;
const { secretKey: NEAR_KEY, publicKey: NEAR_PUBLIC_KEY } = nearTestKey();
const PRIVATE_KEYS = [BASE_KEY, TEMPO_KEY, NEAR_KEY];
// Made up: a key of an RPC's own, in its path and in its query
const KEYED = '/made-up-path-Wq3/v3?made-up-query=Zr8LmQ';
const KEYED_PARTS = ['made-up-path', 'Wq3', '/v3', 'made-up-query', 'Zr8LmQ', '?'];

/** The three tools as targets whose 402 offers USDC on Base and on NEAR, and a Tempo charge, at their made-up price. */
function walletTargets(): FakeTarget[] {
  return Object.values(toolTargets()).map((target) => {
    const amount = toAtomic(target.price, 6).toString();
    const option = (network: string, asset: string, payTo: string, extra: Record<string, unknown>) => ({
      scheme: 'exact',
      network,
      asset,
      amount,
      payTo,
      maxTimeoutSeconds: 300,
      extra,
    });
    return {
      ...target,
      x402: [
        option('eip155:8453', BASE_USDC, BASE_PAY_TO, { name: 'USD Coin', version: '2', assetTransferMethod: 'eip3009' }),
        option('near:mainnet', NEAR_USDC, NEAR_PAY_TO, {}),
      ],
      mpp: { amount },
    };
  });
}

let fake: FakeAnyfare;
let nearRpc: FakeNearRpc;
let baseRpc: FakeBaseRpc;
let tempoRpc: FakeTempoRpc;
let app: { dir: string; remove: () => void };
const outputs: string[] = [];
const realFetch = globalThis.fetch;

beforeAll(async () => {
  [fake, nearRpc, baseRpc, tempoRpc] = await Promise.all([startFakeAnyfare(), startFakeNearRpc(), startFakeBaseRpc(), startFakeTempoRpc()]);
  // Nothing here may reach a host but 127.0.0.1, whatever reads the global fetch
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (new URL(url).hostname !== '127.0.0.1') throw new Error('These tests reach no host but 127.0.0.1');
    return realFetch(input, init);
  });
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await Promise.all([fake.close(), nearRpc.close(), baseRpc.close(), tempoRpc.close()]);
});
beforeEach(() => {
  fake.reset();
  for (const target of walletTargets()) fake.addTarget(target);
  nearRpc.failing = undefined;
  nearRpc.calls.length = 0;
  baseRpc.reset();
  tempoRpc.reset();
  app = tempAppDir();
});
afterEach(() => {
  try {
    // The made-up transaction hashes are no part of a key
    expectNoSecretIn(outputs.join('\n'), PRIVATE_KEYS, [...fake.x402Settled, ...fake.mppSettled].map((item) => item.transaction));
  } finally {
    outputs.length = 0;
    app.remove();
  }
});

/** The wallets' settings, each with its made-up RPC; `path` goes after each RPC's address. */
const nearEnv = (path = ''): Record<string, string> => ({ NEAR_ACCOUNT_ID: NEAR_ACCOUNT, NEAR_PRIVATE_KEY: NEAR_KEY, NEAR_RPC_URL: `${nearRpc.url}${path}` });
const baseEnv = (path = ''): Record<string, string> => ({ BASE_PRIVATE_KEY: BASE_KEY, BASE_RPC_URL: `${baseRpc.url}${path}` });
const tempoEnv = (path = ''): Record<string, string> => ({ TEMPO_PRIVATE_KEY: TEMPO_KEY, TEMPO_RPC_URL: `${tempoRpc.url}${path}` });
const allWallets = (path = ''): Record<string, string> => ({ ...nearEnv(path), ...baseEnv(path), ...tempoEnv(path) });

/** Made-up balances: 0.979 USDC and 1.2345 NEAR on NEAR, 0.005 USDC on Base, 0.2 USDC.e on Tempo. */
function madeUpBalances(): void {
  nearRpc.setBalance(NEAR_ACCOUNT, 979_000n, 1_234_500_000_000_000_000_000_000n);
  baseRpc.setBalance(BASE_PAYER, 5_000n);
  tempoRpc.setBalance(TEMPO_PAYER, 200_000n);
}

/** Whether anything was signed, sent or broadcast to a chain: only reads of a balance and, for a payment, of what signing needs. */
function expectNothingSentToAChain(): void {
  expect(tempoRpc.sent()).toEqual([]);
  expect(baseRpc.others()).toEqual([]);
  expect(nearRpc.calls.every((item) => item.method === 'query' || item.method === 'block')).toBe(true);
}

async function run(argv: readonly string[], env: Record<string, string> = {}, options: IoOptions = {}) {
  const { fetch } = forwardingFetch(toolRoutes());
  const io = captureIo(fetch, { ANYFARE_API_URL: fake.apiUrl, ANYFARE_PAY_URL: fake.payUrl, ...env }, { appDir: app.dir, ...options });
  const code = await runCli(argv, io.io);
  outputs.push(io.out(), io.err());
  return { code, out: io.out(), err: io.err() };
}

/** A port of 127.0.0.1 that nothing listens on: a connection to it is refused. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe('balance shows the wallets', () => {
  it('with only the wallets set and no Anyfare key: one line for each, read from its chain', async () => {
    madeUpBalances();
    const result = await run(['balance'], allWallets());
    expect(result.err).toBe('');
    expect(result.code).toBe(0);
    expect(result.out).toBe(
      [
        '▸ Wallets',
        `  USDC on NEAR     0.979 USDC and 1.2345 NEAR in ${NEAR_ACCOUNT}`,
        `  USDC on Base     0.005 USDC in ${BASE_PAYER}`,
        `  USDC.e on Tempo  0.2 USDC.e in ${TEMPO_PAYER}`,
        '',
      ].join('\n'),
    );
    // No Anyfare key: nothing asked of Anyfare
    expect(fake.requests).toEqual([]);
    // NEAR: a view call of ft_balance_of on the USDC contract, and view_account
    const reads = nearRpc.balanceReads().map((item) => item.params as Record<string, unknown>);
    expect(reads).toContainEqual(expect.objectContaining({ request_type: 'call_function', account_id: NEAR_USDC, method_name: 'ft_balance_of' }));
    expect(reads).toContainEqual(expect.objectContaining({ request_type: 'view_account', account_id: NEAR_ACCOUNT }));
    const args = reads.find((item) => item['request_type'] === 'call_function')?.['args_base64'];
    expect(JSON.parse(Buffer.from(String(args), 'base64').toString('utf8'))).toEqual({ account_id: NEAR_ACCOUNT });
    // Base and Tempo: one eth_call of balanceOf each, on their USDC
    expect(baseRpc.calls.map((item) => item.method)).toEqual(['eth_call']);
    expect(tempoRpc.calls.map((item) => item.method)).toEqual(['eth_call']);
    expectNothingSentToAChain();
  });

  it('after the Credits blocks', async () => {
    madeUpBalances();
    const account = fake.addAccount('1.25');
    const result = await run(['balance'], { ANYFARE_MASTER_KEY: account.masterKey, ...baseEnv() });
    expect(result.code).toBe(0);
    expect(result.out).toBe(`▸ Credits, with the master key\n  Available       $1.25\n  Held            $0\n\n▸ Wallets\n  USDC on Base  0.005 USDC in ${BASE_PAYER}\n`);
  });

  it('in three groups: the Credits, then the wallets, then the payment key on its own', async () => {
    madeUpBalances();
    const account = fake.addAccount('1.25');
    const key = fake.addKey(account, { label: 'demo', dailyBudget: '1', maxPrice: '0.02' });
    const result = await run(['balance'], { ANYFARE_MASTER_KEY: account.masterKey, ANYFARE_PAYMENT_KEY: key.key, ...baseEnv() });
    expect(result.code).toBe(0);
    const credits = result.out.indexOf('▸ Credits, with the master key');
    const wallets = result.out.indexOf('\n\n▸ Wallets\n');
    const paymentKey = result.out.indexOf('\n\n▸ The payment key "demo"\n');
    expect(credits).toBe(0);
    expect(wallets).toBeGreaterThan(credits);
    expect(paymentKey).toBeGreaterThan(wallets);
  });

  it('only of the ways whose settings are present', async () => {
    madeUpBalances();
    const result = await run(['balance'], tempoEnv());
    expect(result.out).toBe(`▸ Wallets\n  USDC.e on Tempo  0.2 USDC.e in ${TEMPO_PAYER}\n`);
    expect(nearRpc.calls).toEqual([]);
    expect(baseRpc.calls).toEqual([]);
  });

  it('with a line for each read that fails, naming the RPC by its host only, and never a key', async () => {
    madeUpBalances();
    nearRpc.failing = { status: 503 };
    baseRpc.failing = 502;
    const port = await closedPort();
    const result = await run(['balance'], { ...allWallets(KEYED), TEMPO_RPC_URL: `http://127.0.0.1:${port}${KEYED}` });
    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    expect(result.out).toBe(
      [
        '▸ Wallets',
        `  USDC on NEAR     not read: the NEAR RPC at ${new URL(nearRpc.url).host} answered 503`,
        `  USDC on Base     not read: the Base RPC at ${new URL(baseRpc.url).host} answered 502`,
        `  USDC.e on Tempo  not read: the Tempo RPC at 127.0.0.1:${port} could not be reached (ECONNREFUSED)`,
        '',
      ].join('\n'),
    );
    for (const part of KEYED_PARTS) expect(result.out).not.toContain(part);
    // The reads went to the RPCs' own paths
    expect(baseRpc.calls.map((item) => item.path)).toEqual([KEYED]);
  });

  it('says which NEAR account the RPC does not know', async () => {
    const result = await run(['balance'], { NEAR_ACCOUNT_ID: 'nobody.example.near', NEAR_RPC_URL: nearRpc.url });
    expect(result.out).toBe(`▸ Wallets\n  USDC on NEAR  not read: the NEAR RPC at ${new URL(nearRpc.url).host} knows no account nobody.example.near\n`);
  });

  it('says which setting can not be used, without its value', async () => {
    const result = await run(['balance'], { ...baseEnv(), BASE_RPC_URL: 'http://rpc.example.test/made-up-key', TEMPO_PRIVATE_KEY: 'made-up' });
    expect(result.code).toBe(0);
    expect(result.out).toBe(
      [
        '▸ Wallets',
        '  USDC on Base     not read: BASE_RPC_URL must be an https:// URL, or http:// to 127.0.0.1 or localhost. Check .env.local',
        '  USDC.e on Tempo  not read: TEMPO_PRIVATE_KEY is not a private key: it is 0x and 64 hex digits. Check .env.local',
        '',
      ].join('\n'),
    );
    expect(result.out).not.toContain('made-up');
  });

  it("reads Base from mainnet.base.org when BASE_RPC_URL is not set, and names it by its host", async () => {
    expect(BASE_DEFAULT_RPC_URL).toBe('https://mainnet.base.org');
    expect(readBaseRpc({})).toEqual({ url: 'https://mainnet.base.org', host: 'mainnet.base.org' });
    // No host but 127.0.0.1 answers here
    const result = await run(['balance'], { BASE_PRIVATE_KEY: BASE_KEY });
    expect(result.out).toBe('▸ Wallets\n  USDC on Base  not read: the Base RPC at mainnet.base.org could not be reached (ENOTFOUND)\n');
  });

  it('gives up on an RPC that never answers, after its time limit', async () => {
    baseRpc.hanging = true;
    const { fetch } = forwardingFetch(toolRoutes());
    const started = Date.now();
    const balance = await readWalletBalance(fetch, baseEnv(KEYED), 'base', { limitMs: 300 });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(balance).toEqual({ kind: 'failed', way: 'base', reason: `the Base RPC at ${new URL(baseRpc.url).host} did not answer in 300 ms` });
  });

  it('reads the wallets at the same time', async () => {
    baseRpc.hanging = true;
    tempoRpc.hanging = true;
    const { fetch } = forwardingFetch(toolRoutes());
    const started = Date.now();
    const both = await Promise.all([readWalletBalance(fetch, baseEnv(), 'base', { limitMs: 400 }), readWalletBalance(fetch, tempoEnv(), 'tempo', { limitMs: 400 })]);
    expect(Date.now() - started).toBeLessThan(750);
    expect(both.map((item) => item.kind)).toEqual(['failed', 'failed']);
  });
});

describe('the interactive mode: the list of ways to pay', () => {
  it('shows the balance after ✔ when it is read in time: the Credits, and each wallet', async () => {
    madeUpBalances();
    const account = fake.addAccount('1.5');
    const key = fake.addKey(account, { label: 'demo', dailyBudget: '1', maxPrice: '0.02' });
    // CoinMarketCap, the default pair, Credits, no to pay, no more
    const result = await run([], { ANYFARE_PAYMENT_KEY: key.key, ...allWallets() }, { isTerminal: true, input: '3\n1\n\n1\nn\n4\n' });
    expect(result.code).toBe(0);
    expect(result.out).toContain(
      [
        'How do you pay?',
        '  1  Credits  needs ANYFARE_PAYMENT_KEY  ✔  $1.50',
        '  2  USDC on NEAR  needs NEAR_ACCOUNT_ID and NEAR_PRIVATE_KEY  ✔  0.979 USDC',
        '  3  USDC on Base  needs BASE_PRIVATE_KEY  ✔  0.005 USDC',
        '  4  USDC.e on Tempo  needs TEMPO_PRIVATE_KEY  ✔  0.2 USDC.e',
      ].join('\n'),
    );
    expectNothingSentToAChain();
  });

  it('shows ✔ alone when a balance can not be read, and ✘ with no read when a setting is missing', async () => {
    nearRpc.failing = { status: 503 };
    baseRpc.failing = 503;
    const result = await run([], { ...nearEnv(), ...baseEnv() }, { isTerminal: true, input: '3\n1\n\n' });
    expect(result.out).toContain(
      [
        '  1  Credits  needs ANYFARE_PAYMENT_KEY  ✘',
        '  2  USDC on NEAR  needs NEAR_ACCOUNT_ID and NEAR_PRIVATE_KEY  ✔',
        '  3  USDC on Base  needs BASE_PRIVATE_KEY  ✔',
        '  4  USDC.e on Tempo  needs TEMPO_PRIVATE_KEY  ✘',
        '',
      ].join('\n'),
    );
    expect(tempoRpc.calls).toEqual([]);
    expect(fake.requests).toEqual([]);
  });
});

describe('the check before paying', () => {
  const NOT_SIGNED = 'Nothing was signed. Not charged.';

  describe('with USDC on Base', () => {
    const payBase = (options: IoOptions = {}) => run(['call', '--tool', 'cmc', '--pay', 'base', ...(options.isTerminal === true ? [] : ['--yes'])], baseEnv(), options);

    it('stops when the wallet holds less than the call pays, before the question, and signs nothing', async () => {
      baseRpc.setBalance(BASE_PAYER, 5_000n);
      const result = await payBase({ isTerminal: true, input: 'y\n' });
      expect(result.code).toBe(1);
      expect(result.err).toBe(`✘ Your wallet holds 0.005 USDC on Base, less than the 0.011 USDC this call pays. ${NOT_SIGNED}\n`);
      expect(result.out).not.toContain('Pay 0.011 USDC on Base');
      expect(result.out).not.toContain('Signing');
      expect(fake.x402Requests()).toEqual([]);
      expect(fake.x402Settled).toEqual([]);
    });

    it('stops with --yes too', async () => {
      baseRpc.setBalance(BASE_PAYER, 10_999n);
      const result = await payBase();
      expect(result.err).toBe(`✘ Your wallet holds 0.010999 USDC on Base, less than the 0.011 USDC this call pays. ${NOT_SIGNED}\n`);
      expect(fake.x402Requests()).toEqual([]);
    });

    it('pays when the wallet holds what the call pays', async () => {
      baseRpc.setBalance(BASE_PAYER, 11_000n);
      const result = await payBase();
      expect(result.err).toBe('');
      expect(result.code).toBe(0);
      expect(fake.x402Settled).toHaveLength(1);
      expectNothingSentToAChain();
    });

    it("warns, and goes on, when the balance can't be read", async () => {
      baseRpc.failing = 503;
      const result = await payBase();
      expect(result.err).toBe(
        `Could not read your wallet's balance: the Base RPC at ${new URL(baseRpc.url).host} answered 503. The facilitator refuses a payment the wallet can't cover.\n`,
      );
      expect(result.code).toBe(0);
      expect(fake.x402Settled).toHaveLength(1);
    });
  });

  describe('with USDC on NEAR', () => {
    const payNear = () => run(['call', '--tool', 'evidence', '--pay', 'near', '--yes'], nearEnv());

    beforeEach(() => {
      // Made up: the buyer's account holds the test's key, at a made-up nonce
      nearRpc.height = 180_000_000n;
      nearRpc.addAccessKey(NEAR_ACCOUNT, NEAR_PUBLIC_KEY, 41n);
      fake.nearChain = nearRpc;
    });

    it('stops when the account holds less than the call pays, and the signer reads nothing', async () => {
      nearRpc.setBalance(NEAR_ACCOUNT, 1_000n);
      const result = await payNear();
      expect(result.code).toBe(1);
      expect(result.err).toBe(`✘ Your wallet holds 0.001 USDC on NEAR, less than the 0.002 USDC this call pays. ${NOT_SIGNED}\n`);
      expect(result.out).not.toContain('Signing');
      // Only the read of the balance: no block height, no access key
      expect(nearRpc.calls.map((item) => (item.params as Record<string, unknown>)['request_type'] ?? item.method)).toEqual(['call_function']);
      expect(fake.x402Requests()).toEqual([]);
    });

    it('pays when the account holds what the call pays', async () => {
      nearRpc.setBalance(NEAR_ACCOUNT, 2_000n);
      const result = await payNear();
      expect(result.err).toBe('');
      expect(result.code).toBe(0);
      expect(fake.x402Settled).toHaveLength(1);
      expectNothingSentToAChain();
    });

    it("warns, and goes on to sign, when the balance can't be read", async () => {
      nearRpc.setBalance(NEAR_ACCOUNT, 1_000n);
      // The RPC refuses every query: the balance, and then the signer's read of the key, which the SDK
      // retries for a minute and more; the signing is given up on after 400 ms
      nearRpc.failing = { status: 503, only: 'query' };
      const { fetch } = forwardingFetch(toolRoutes());
      const io = captureIo(fetch, { ANYFARE_API_URL: fake.apiUrl, ANYFARE_PAY_URL: fake.payUrl, ...nearEnv() }, { appDir: app.dir });
      const ctx = createContext(io.io);
      let stop: unknown;
      try {
        await callWithX402(ctx, { args: DEFAULT_ARGS.evidence, explain: false, yes: true }, 'near', { signingMs: 400 });
      } catch (error) {
        stop = error;
      } finally {
        ctx.close();
      }
      outputs.push(io.out(), io.err());
      expect(io.err()).toBe(
        `Could not read your wallet's balance: the NEAR RPC at ${new URL(nearRpc.url).host} answered 503. The facilitator refuses a payment the wallet can't cover.\n`,
      );
      expect(io.out()).toContain('▸ Signing 0.002 USDC on NEAR');
      expect(stop).toBeInstanceOf(Stop);
      expect(fake.x402Requests()).toEqual([]);
    });
  });

  describe('with USDC.e on Tempo', () => {
    const payTempo = () => run(['call', '--tool', '3route', '--pay', 'tempo', '--yes'], tempoEnv());

    // The charge: 0.0012 USDC.e. The made-up RPC fills a transfer whose fee is at most $0.000069
    const CHARGE = 1_200n;
    const SIGNED_FEE = 69n;

    it('stops before signing when the wallet holds less than the charge', async () => {
      tempoRpc.setBalance(TEMPO_PAYER, CHARGE - 1n);
      const result = await payTempo();
      expect(result.code).toBe(1);
      expect(result.err).toBe(`✘ Your wallet holds 0.001199 USDC.e on Tempo, less than the 0.0012 USDC.e this call pays. ${NOT_SIGNED}\n`);
      expect(result.out).not.toContain('Signing');
      // Only the read of the balance: nothing filled, estimated, signed or sent
      expect(tempoRpc.calls.map((item) => item.method)).toEqual(['eth_call']);
      expect(fake.mppRequests()).toEqual([]);
    });

    it('stops after signing, and sends nothing, when the wallet holds the charge but not the signed fee', async () => {
      tempoRpc.setBalance(TEMPO_PAYER, CHARGE + SIGNED_FEE - 1n);
      const result = await payTempo();
      expect(result.code).toBe(1);
      expect(result.out).toContain('▸ Signing 0.0012 USDC.e on Tempo');
      expect(result.out).not.toContain('Calling');
      expect(result.err).toBe(
        '✘ Your wallet holds 0.001268 USDC.e on Tempo, less than the 0.001269 USDC.e this call pays with its network fee: ' +
          '0.0012 USDC.e and a fee of at most $0.000069. Nothing was sent. Not charged.\n',
      );
      expect(fake.mppRequests()).toEqual([]);
      expect(tempoRpc.sent()).toEqual([]);
    });

    it('pays when the wallet holds the charge and the signed fee, well under the $0.01 bound', async () => {
      tempoRpc.setBalance(TEMPO_PAYER, CHARGE + SIGNED_FEE);
      const result = await payTempo();
      expect(result.err).toBe('');
      expect(result.code).toBe(0);
      expect(fake.mppSettled).toHaveLength(1);
      expectNothingSentToAChain();
    });

    it("warns, and goes on, when the balance can't be read", async () => {
      tempoRpc.failing = { status: 503, only: 'eth_call' };
      const result = await payTempo();
      expect(result.err).toBe(
        `Could not read your wallet's balance: the Tempo RPC at ${new URL(tempoRpc.url).host} answered 503. The Tempo node refuses a payment the wallet can't cover.\n`,
      );
      expect(result.code).toBe(0);
      expect(fake.mppSettled).toHaveLength(1);
    });
  });

  describe('with Credits', () => {
    const payCredits = (balance: string, options: IoOptions = {}) => {
      const account = fake.addAccount(balance);
      const key = fake.addKey(account, { label: 'demo', dailyBudget: '1', maxPrice: '0.02' });
      return run(['call', '--tool', 'cmc', '--pay', 'credits', ...(options.isTerminal === true ? [] : ['--yes'])], { ANYFARE_PAYMENT_KEY: key.key }, options);
    };
    const paid = () => fake.routed().filter((item) => item.headers['authorization'] !== undefined);

    it('stops when the Credits are less than the call pays, from GET /_/key, before the question', async () => {
      const result = await payCredits('0.005', { isTerminal: true, input: 'y\n' });
      expect(result.code).toBe(1);
      expect(result.err).toBe('✘ Your Credits balance is $0.005, less than the $0.011 this call pays. Nothing was sent. Not charged.\n');
      expect(result.out).not.toContain('Pay $0.011 of Credits?');
      expect(fake.requests.filter((item) => item.path === '/_/key')).toHaveLength(1);
      expect(paid()).toEqual([]);
    });

    it('pays when the Credits are what the call pays', async () => {
      const result = await payCredits('0.011');
      expect(result.err).toBe('');
      expect(result.code).toBe(0);
      expect(paid()).toHaveLength(1);
    });
  });
});
