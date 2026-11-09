// call --pay base and call --pay near. Every key here is made in the test, in memory only, and holds
// nothing. No request leaves 127.0.0.1: the NEAR signer is pointed at an RPC that can't be reached.

import { spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { x402Client } from '@x402/core/client';
import { encodePaymentSignatureHeader } from '@x402/core/http';
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from '@x402/core/types';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { routingLink } from '../src/anyfare.ts';
import { runCli } from '../src/cli.ts';
import { loadConfig } from '../src/config.ts';
import { stopFor } from '../src/errors.ts';
import { createContext } from '../src/context.ts';
import { readPlan } from '../src/explain.ts';
import type { Plan } from '../src/explain.ts';
import { DEFAULT_ARGS, TOOLS } from '../src/tools/index.ts';
import { HttpError, Stop, toAtomic } from '../src/util.ts';
import {
  baseClient,
  checkNearTransfer,
  checkOption,
  callWithX402,
  checkSigned,
  chooseX402,
  nearClient,
  nearSigningFailure,
  scrubRpcUrl,
  readProof,
  x402Lines,
} from '../src/x402.ts';
import { CMC_URL, EVIDENCE_URL, forwardingFetch, startFakeAnyfare, toolRoutes, toolTargets } from './fakeAnyfare.ts';
import type { FakeAnyfare, FakeTarget, PaidAnswer } from './fakeAnyfare.ts';
import { startFakeBaseRpc } from './fakeBaseRpc.ts';
import type { FakeBaseRpc } from './fakeBaseRpc.ts';
import { startFakeNearRpc } from './fakeNearRpc.ts';
import type { FakeNearRpc } from './fakeNearRpc.ts';
import { answerOf, brokenAnswer, captureIo, expectResultShape, fakeFetch, tempAppDir } from './helpers.ts';
import { readNearWallet } from '../src/wallets.ts';
import type { IoOptions } from './helpers.ts';

const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const NEAR_USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
// Made up: where the fake Anyfare takes USDC on Base
const BASE_PAY_TO = '0x00000000000000000000000000000000000000b1';
const NEAR_PAY_TO = 'pay.anyfare.near';
// Made up: the buyer's NEAR account
const NEAR_ACCOUNT = 'buyer.example.near';

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);
  let text = '';
  for (; value > 0n; value /= 58n) text = `${BASE58[Number(value % 58n)]}${text}`;
  for (const byte of bytes) {
    if (byte !== 0) break;
    text = `1${text}`;
  }
  return text;
}

/** A NEAR key made here: an ed25519 seed and its public key, base58, as NEAR writes a secret key; and its public key. */
function nearTestKey(): { readonly secretKey: string; readonly publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const seed = Buffer.from(privateKey.export({ format: 'jwk' }).d ?? '', 'base64url');
  const pub = Buffer.from(publicKey.export({ format: 'jwk' }).x ?? '', 'base64url');
  return { secretKey: `ed25519:${base58(Buffer.concat([seed, pub]))}`, publicKey: `ed25519:${base58(pub)}` };
}

const BASE_KEY = generatePrivateKey();
const BASE_PAYER = privateKeyToAccount(BASE_KEY).address;
const { secretKey: NEAR_KEY, publicKey: NEAR_PUBLIC_KEY } = nearTestKey();
// 127.0.0.1:9 is one that fetch refuses to connect to at all
const NEAR_ENV = { NEAR_ACCOUNT_ID: NEAR_ACCOUNT, NEAR_PRIVATE_KEY: NEAR_KEY, NEAR_RPC_URL: 'http://127.0.0.1:9' };
// BASE_RPC_URL is the made-up Base RPC's, set once it runs: the app reads the wallet's balance from it
const BASE_ENV: Record<string, string> = { BASE_PRIVATE_KEY: BASE_KEY };
/** Made up: what the test's Base wallet holds, 1 USDC, enough for every call here. */
const BASE_HOLDS = 1_000_000n;
/** The warning when the NEAR RPC at 127.0.0.1:9, a port fetch refuses, can't be read for the balance. */
const NEAR_BALANCE_UNREAD =
  "Could not read your wallet's balance: the NEAR RPC at 127.0.0.1:9 could not be reached (bad port). The facilitator refuses a payment the wallet can't cover.\n";

/** x402 options as the proxy builds them. The amounts are made up, dated 2026-11-09. */
const baseOption = (amount: string, change: Record<string, unknown> = {}): Record<string, unknown> => ({
  scheme: 'exact',
  network: 'eip155:8453',
  asset: BASE_USDC,
  amount,
  payTo: BASE_PAY_TO,
  maxTimeoutSeconds: 300,
  extra: { name: 'USD Coin', version: '2', assetTransferMethod: 'eip3009' },
  ...change,
});
const nearOption = (amount: string, change: Record<string, unknown> = {}): Record<string, unknown> => ({
  scheme: 'exact',
  network: 'near:mainnet',
  asset: NEAR_USDC,
  amount,
  payTo: NEAR_PAY_TO,
  maxTimeoutSeconds: 300,
  extra: {},
  ...change,
});
const solanaOption = (amount: string): Record<string, unknown> => ({
  scheme: 'exact',
  network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  amount,
  payTo: 'MadeUpSolanaRecipientForTheTest',
  maxTimeoutSeconds: 300,
  extra: { feePayer: 'MadeUpFeePayerForTheTest' },
});

/** The three tools as targets whose 402 offers x402 on Base, Solana and NEAR, at their made-up Credits price. */
function x402Targets(): Record<'cmc' | '3route' | 'evidence', FakeTarget> {
  const targets = toolTargets();
  const options = (target: FakeTarget) => {
    const atomic = toAtomic(target.price, 6).toString();
    return [baseOption(atomic), solanaOption(atomic), nearOption(atomic)];
  };
  return {
    cmc: { ...targets.cmc, x402: options(targets.cmc) },
    '3route': { ...targets['3route'], x402: options(targets['3route']) },
    evidence: { ...targets.evidence, x402: options(targets.evidence) },
  };
}

let fake: FakeAnyfare;
let baseRpc: FakeBaseRpc;
let app: { dir: string; remove: () => void };
const realFetch = globalThis.fetch;

beforeAll(async () => {
  [fake, baseRpc] = await Promise.all([startFakeAnyfare(), startFakeBaseRpc()]);
  BASE_ENV['BASE_RPC_URL'] = baseRpc.url;
  // The NEAR signer reads from its RPC with the global fetch: only 127.0.0.1 is reachable from here
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (new URL(url).hostname !== '127.0.0.1') throw new Error('These tests reach no host but 127.0.0.1');
    return realFetch(input, init);
  });
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await Promise.all([fake.close(), baseRpc.close()]);
});
beforeEach(() => {
  fake.reset();
  baseRpc.reset();
  baseRpc.setBalance(BASE_PAYER, BASE_HOLDS);
  for (const target of Object.values(x402Targets())) fake.addTarget(target);
  app = tempAppDir();
});
afterEach(() => {
  app.remove();
});

const routedPath = (url: string): string => `/${url.replace(/^https:\/\//, '')}`;

// What the output may show that is public: addresses, the fake's own host and its request IDs
const PUBLIC = /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])|127\.0\.0\.1:[0-9]+|req-made-up-[0-9]+/g;

/**
 * Throws when a text holds a test key, or any part of one longer than 4 characters. The made-up
 * transaction hashes and the public values are taken out first: they are not parts of a key.
 */
function expectNoKeyIn(text: string, keys: readonly string[] = [BASE_KEY, NEAR_KEY]): void {
  let rest = text;
  for (const settled of fake.x402Settled) rest = rest.split(settled.transaction).join(' ');
  rest = rest.replace(PUBLIC, ' ');
  for (const key of keys) {
    const hex = key.startsWith('0x');
    const body = hex ? key.slice(2).toLowerCase() : key.slice(key.indexOf(':') + 1);
    const haystack = hex ? rest.toLowerCase() : rest;
    for (let at = 0; at + 5 <= body.length; at += 1) {
      // The message never holds the part itself
      if (haystack.includes(body.slice(at, at + 5))) throw new Error(`The output holds a part of a test key, at ${at}`);
    }
  }
}

async function call(
  argv: readonly string[],
  env: Record<string, string> = {},
  options: IoOptions & { readonly fetch?: typeof fetch } = {},
) {
  const { fetch: forwarding, calls } = forwardingFetch(toolRoutes());
  const io = captureIo(
    options.fetch ?? forwarding,
    { ANYFARE_API_URL: fake.apiUrl, ANYFARE_PAY_URL: fake.payUrl, ...env },
    { appDir: app.dir, ...options },
  );
  const code = await runCli(['call', ...argv], io.io);
  const result = { code, out: io.out(), err: io.err(), calls };
  expectNoKeyIn(`${result.out}\n${result.err}`);
  return result;
}

const payBase = (env: Record<string, string> = {}, options: IoOptions & { readonly fetch?: typeof fetch } = {}) =>
  call(['--tool', 'cmc', '--pay', 'base', '--yes'], { ...BASE_ENV, ...env }, options);

describe('call --pay base', () => {
  it('pays a CoinMarketCap call in USDC on Base, signed once, checked by the fake, with the proof and the story line', async () => {
    const result = await payBase();
    expect(result.err).toBe('');
    expect(result.code).toBe(0);
    const out = result.out;
    expect(out).toContain('CoinMarketCap: BTC in USD');
    expect(out).toMatch(/The API asks\s+\$0\.01 in USDC on Base/);
    expect(out).toMatch(/Anyfare's quote\s+\$0\.011, with a fee of \$0\.001/);
    expect(out).toMatch(/You pay\s+0\.011 USDC on Base\n/);
    expect(out).toContain(`To               ${BASE_PAY_TO}`);
    expect(out).toContain(`From             ${BASE_PAYER}`);
    // How long the signed payment stays valid, before anything is signed
    expect(out).toMatch(/From {13}0x[0-9a-fA-F]{40}\n {2}Valid for {8}5 minutes\n▸ Signing/);
    expect(out).toContain('Bitcoin Real (BTC)');
    expect(out).toContain('Price       12,345.68 USD');

    // The fake verified the signature against the payer, and settled once
    expect(fake.x402Settled).toHaveLength(1);
    const [settled] = fake.x402Settled;
    expect(settled).toMatchObject({ network: 'eip155:8453', payer: BASE_PAYER, payTo: BASE_PAY_TO, amount: '11000' });
    expect(out).toContain(`Paid 0.011 USDC on Base from ${BASE_PAYER}: transaction ${settled?.transaction}\n`);
    expect(out).toContain(`https://basescan.org/tx/${settled?.transaction}\n`);
    expectResultShape(out, {
      name: 'CoinMarketCap',
      answer: [
        'Bitcoin Real (BTC)',
        'Price       12,345.68 USD',
        '24h         +2.50%',
        'Market cap  987,654,322',
        `Updated     ${out.match(/│ Updated {5}(\S+)/)?.[1] ?? ''}`,
      ],
      proof: [
        `Paid 0.011 USDC on Base from ${BASE_PAYER}: transaction ${settled?.transaction}`,
        `https://basescan.org/tx/${settled?.transaction}`,
      ],
      story: '✔ You paid in USDC on Base. Anyfare paid CoinMarketCap in USDC on Base from its own wallet.',
    });

    const paid = fake.x402Requests();
    expect(paid).toHaveLength(1);
    expect(paid[0]?.method).toBe('GET');
    expect(paid[0]?.path).toBe(routedPath(CMC_URL));
    expect(paid[0]?.headers['authorization']).toBeUndefined();
  });

  it('pays the evidence API, a POST, with the same body and headers', async () => {
    const result = await call(['--tool', 'evidence', '--pay', 'base', '--yes'], BASE_ENV);
    expect(result.err).toBe('');
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/You pay\s+0\.002 USDC on Base/);
    expect(result.out).toContain('This one takes a while.');
    expect(result.out).toContain('Account     anyfare.near');
    expect(result.out).toContain('You paid in USDC on Base. Anyfare paid the evidence API in USDC on NEAR from its own wallet.');
    const paid = fake.x402Requests();
    expect(paid).toHaveLength(1);
    expect(paid[0]?.method).toBe('POST');
    expect(paid[0]?.path).toBe(routedPath(EVIDENCE_URL));
    expect(paid[0]?.body).toBe('{"accountId":"anyfare.near"}');
    expect(paid[0]?.headers['content-type']).toBe('application/json');
  });

  it('asks before it signs, and signs and sends nothing on a "no"', async () => {
    const result = await call(['--tool', 'cmc', '--pay', 'base'], BASE_ENV, { isTerminal: true, input: 'n\n' });
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/Valid for {8}5 minutes\n\nPay 0\.011 USDC on Base/);
    expect(result.out).toContain(`Pay 0.011 USDC on Base to ${BASE_PAY_TO}? [y/N]`);
    expect(result.out).not.toContain('Signing');
    expect(result.err).toBe('✘ Nothing was signed or sent. Not charged.\n');
    expect(fake.x402Requests()).toEqual([]);
    expect(fake.x402Settled).toEqual([]);
  });

  it('pays on a "yes" at the prompt', async () => {
    const result = await call(['--tool', 'cmc', '--pay', 'base'], BASE_ENV, { isTerminal: true, input: 'y\n' });
    expect(result.code).toBe(0);
    expect(result.out).toContain(`▸ Signing 0.011 USDC on Base to ${BASE_PAY_TO}`);
    expect(fake.x402Requests()).toHaveLength(1);
  });

  it('is a usage error without --yes and without a terminal, before any request', async () => {
    const result = await call(['--tool', 'cmc', '--pay', 'base'], BASE_ENV);
    expect(result.code).toBe(2);
    expect(result.err).toBe('✘ call asks before it pays. Add --yes to pay without a terminal\n');
    expect(fake.requests).toEqual([]);
    expect(result.calls).toEqual([]);
  });

  it('refuses an amount over the cap: nothing signed, nothing sent', async () => {
    const result = await payBase({ MAX_PAYMENT_USD: '0.01' });
    expect(result.code).toBe(1);
    expect(result.err).toBe('✘ Anyfare asks 0.011 USDC on Base, above your cap MAX_PAYMENT_USD of $0.01. Not charged.\n');
    expect(result.out).not.toContain('Signing');
    expect(fake.x402Requests()).toEqual([]);
    expect(fake.x402Settled).toEqual([]);
    // The only routed request is the plan's unpaid one
    expect(fake.routed()).toHaveLength(1);
  });

  it('pays an amount at the cap', async () => {
    const result = await payBase({ MAX_PAYMENT_USD: '0.011' });
    expect(result.code).toBe(0);
    expect(fake.x402Settled).toHaveLength(1);
  });

  it('marks the Base option with --explain, and shows where the payment goes', async () => {
    const result = await call(['--tool', 'cmc', '--pay', 'base', '--explain', '--yes'], BASE_ENV);
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/0\.011 USDC on Base\s+exact \(eip3009\)\s+--pay base\s+← you pay this one/);
    expect(result.out).toMatch(/You pay\s+0\.011 USDC on Base\n\s+To\s+0x0{38}b1\n\s+From\s+0x/);
    expect(result.out).not.toContain('The API asks');
  });

  it('shows one "You pay" with --explain: the quote block has the quote, the payer block has the payment', async () => {
    const result = await call(['--tool', 'cmc', '--pay', 'base', '--explain', '--yes'], BASE_ENV);
    const { out } = result;
    expect(out.match(/You pay/g)).toHaveLength(1);
    expect(out).not.toMatch(/You pay\s+\$/);
    // The quote block: the API's price, the fee and the quote, in one width
    expect(out).toMatch(/▸ Anyfare's quote, from GET \/_\/check\n {2}The API's price {2}\$0\.01 in USDC on Base\n {2}Anyfare's fee {4}\$0\.001\n {2}Anyfare's quote {2}\$0\.011\n/);
    // The payer's block: its own width, after one blank line
    expect(out).toMatch(
      / {2}Your cap, MAX_PAYMENT_USD, is \$0\.02\. This quote is within it\.\n\n {2}You pay {4}0\.011 USDC on Base\n {2}To {9}0x0{38}b1\n {2}From {7}0x[0-9a-fA-F]{40}\n {2}Valid for {2}5 minutes\n/,
    );
  });

  it('separates the explain blocks with one blank line each', async () => {
    const result = await call(['--tool', 'cmc', '--pay', 'base', '--explain', '--yes'], BASE_ENV);
    const lines = result.out.split('\n');
    for (const title of ["▸ What Anyfare asks for the same call", "▸ Anyfare's quote, from GET /_/check", '▸ What CoinMarketCap asks, without Anyfare']) {
      const at = lines.indexOf(title);
      expect(at, title).toBeGreaterThan(-1);
      if (!title.includes('What CoinMarketCap')) expect(lines[at - 1], title).toBe('');
      expect(lines[at - 2] ?? 'x', title).not.toBe('');
    }
  });

  it('puts one blank line before the question, and the name inside a sentence in lower case', async () => {
    const result = await call(['--tool', 'evidence', '--pay', 'base'], BASE_ENV, { isTerminal: true, input: 'y\n' });
    expect(result.out).toMatch(/\n {2}Valid for {8}5 minutes\n {2}This one takes a while\.\n\nPay 0\.002 USDC on Base to /);
    expect(result.out).toContain('▸ Calling the evidence API through Anyfare');
    expect(result.out).not.toContain('Calling The evidence API');
  });

  it.each([
    ['offers x402 on other networks only', [solanaOption('11000'), nearOption('11000')]],
    ['offers Credits only', undefined],
  ])('stops with one line when Anyfare %s, and signs nothing', async (_what, x402) => {
    const cmc = x402Targets().cmc;
    fake.addTarget({ ...cmc, ...(x402 === undefined ? { x402: undefined } : { x402 }) });
    const result = await payBase();
    expect(result.code).toBe(1);
    expect(result.err).toBe('✘ Anyfare offers no USDC on Base for this call now. Not charged.\n');
    expect(fake.x402Requests()).toEqual([]);
  });

  it.each([
    ['another token on Base', { asset: '0x000000000000000000000000000000000000dEaD' }],
    ['another scheme', { scheme: 'upto' }],
    ['the batch-settlement scheme', { scheme: 'batch-settlement' }],
    ['another network', { network: 'eip155:84532' }],
  ])('never picks an option in %s', async (_what, change) => {
    const cmc = x402Targets().cmc;
    fake.addTarget({ ...cmc, x402: [baseOption('11000', change)] });
    const result = await payBase();
    expect(result.code).toBe(1);
    expect(result.err).toBe('✘ Anyfare offers no USDC on Base for this call now. Not charged.\n');
    expect(fake.x402Requests()).toEqual([]);
  });

  it('refuses an option it would not sign, before it reads the wallet', async () => {
    const cmc = x402Targets().cmc;
    fake.addTarget({ ...cmc, x402: [baseOption('11000', { extra: { name: 'USD Coin', version: '2', assetTransferMethod: 'permit2' } })] });
    const result = await call(['--tool', 'cmc', '--pay', 'base', '--yes']);
    expect(result.code).toBe(1);
    expect(result.err).toBe("✘ Anyfare's USDC on Base option moves USDC another way than EIP-3009, so the app won't sign it. Not charged.\n");
    expect(fake.x402Requests()).toEqual([]);
  });

  it('refuses an option valid for more than 300 seconds before anything is signed, and pays one of 300', async () => {
    const cmc = x402Targets().cmc;
    fake.addTarget({ ...cmc, x402: [baseOption('11000', { maxTimeoutSeconds: 301 })] });
    const wide = await payBase();
    expect(wide.code).toBe(1);
    expect(wide.err).toBe(
      "✘ Anyfare's USDC on Base option asks for a payment valid for more than 300 seconds, so the app won't sign it. Not charged.\n",
    );
    expect(wide.out).not.toContain('Signing');
    expect(fake.x402Requests()).toEqual([]);
    fake.addTarget({ ...cmc, x402: [baseOption('11000', { maxTimeoutSeconds: 300 })] });
    expect((await payBase()).code).toBe(0);
    expect(fake.x402Settled).toHaveLength(1);
  });

  it('needs BASE_PRIVATE_KEY, and says so in one line', async () => {
    const result = await call(['--tool', 'cmc', '--pay', 'base', '--yes']);
    expect(result.code).toBe(1);
    expect(result.err).toBe(
      '✘ BASE_PRIVATE_KEY is not set. Add it to .env.local. It is the private key of the wallet that pays USDC on Base: 0x and 64 hex digits.\n',
    );
    expect(fake.x402Requests()).toEqual([]);
  });

  it.each([
    ['too short', '0xc0ffee', 'is not a private key: it is 0x and 64 hex digits'],
    ['without 0x', BASE_KEY.slice(2), 'is not a private key: it is 0x and 64 hex digits'],
    ['not hex', `0x${'q'.repeat(64)}`, 'is not a private key: it is 0x and 64 hex digits'],
    ['zero, which is no key', `0x${'0'.repeat(64)}`, 'is not a valid private key'],
  ])('refuses a BASE_PRIVATE_KEY that is %s in one line, without quoting it', async (_what, value, reason) => {
    const result = await call(['--tool', 'cmc', '--pay', 'base', '--yes'], { BASE_PRIVATE_KEY: value });
    expect(result.code).toBe(1);
    expect(result.err).toBe(`✘ BASE_PRIVATE_KEY ${reason}. Check .env.local.\n`);
    expect(result.err).not.toContain(value.replace(/^0x/, ''));
    expect(fake.x402Requests()).toEqual([]);
  });
});

describe("call --pay base: Anyfare's answers", () => {
  const check = (): string => `https://basescan.org/address/${BASE_PAYER} shows your payments`;
  const envelope = (code: string, message: string) => ({ error: { code, message } });

  it('gets no in-flight refusal on Base: the proxy claims a payer on NEAR only', async () => {
    fake.nextX402 = 'payer_busy';
    const result = await payBase();
    expect(result.code).toBe(0);
    expect(fake.x402Settled).toHaveLength(1);
  });

  it('says when Anyfare could not take the payment now, with its Retry-After, not charged', async () => {
    fake.nextX402 = 'payment_unavailable';
    const result = await payBase();
    expect(result.err).toMatch(
      /^✘ Anyfare couldn't take a NEAR payment now, so nothing was paid; retry in 2 seconds \(request req-made-up-\d+\)\. Not charged\.\n$/,
    );
  });

  it('never says "Not charged" when the settlement failed, and says how to check', async () => {
    fake.nextX402 = 'settlement_failed';
    const result = await payBase();
    expect(result.code).toBe(1);
    const line =
      `✘ The payment couldn't be settled, and the answer was not sent. Check the wallet (${check()}); ` +
      'Anyfare repeats an unknown settlement and charges at most once';
    expect(result.err.startsWith(line)).toBe(true);
    expect(result.err.slice(line.length)).toMatch(/^ \(request req-made-up-\d+\)\.\n$/);
    expect(result.err).not.toContain('Not charged');
    expect(fake.x402Requests()).toHaveLength(1);
  });

  it.each<[string, PaidAnswer, RegExp, boolean]>([
    ['facilitator_unavailable', { status: 503, body: envelope('facilitator_unavailable', 'Made up') }, /^✘ The payment facilitator didn't answer, so nothing was paid; retry later/, true],
    ['redis_not_ready', { status: 503, body: envelope('redis_not_ready', 'Made up') }, /^✘ Anyfare's store is not ready, so nothing was paid; retry later/, true],
    ['quote_exceeded', { status: 502, body: envelope('quote_exceeded', 'Made up') }, /^✘ The API asked for more than it quoted, so Anyfare paid nothing/, true],
    ['response_too_large', { status: 502, body: envelope('response_too_large', 'Made up') }, /^✘ The API's answer was too large to hold, so it was not sent/, true],
    ['upstream_unavailable', { status: 503, body: envelope('upstream_unavailable', 'The upstream is unavailable') }, /^✘ The API or Anyfare's payer failed, so Anyfare cancelled your payment; retry later/, true],
    [
      'payment_invalid',
      { status: 402, body: envelope('payment_invalid', 'The facilitator rejected the payment: insufficient_funds') },
      /^✘ Anyfare refused the payment, so nothing moved: The facilitator rejected the payment: insufficient_funds \(request/,
      true,
    ],
    [
      'payment_invalid for a payment used before',
      { status: 402, body: envelope('payment_invalid', 'This payment was already used. Request the resource again and sign a new one.') },
      /^✘ Anyfare says this payment was used before, and took nothing for this request\. Whether the other use was paid is not known: https:\/\/basescan\.org\/address\/0x[0-9a-fA-F]{40} shows your payments/,
      false,
    ],
    ['a 402 that asks for a payment again', { status: 402, body: { x402Version: 2, accepts: [] } }, /^✘ Anyfare asked for a payment again: the payment was not accepted/, true],
    ["the API's own 404", { status: 404, body: { status: { error_message: 'No such symbol' } } }, /^✘ CoinMarketCap answered 404: \{"status":\{"error_message":"No such symbol"\}\}/, true],
    ['internal_error', { status: 500, body: envelope('internal_error', 'Made up') }, /^✘ Anyfare answered 500/, false],
    ['a 502 that is not Anyfare\'s', { status: 502, body: '<html>Bad Gateway</html>' }, /^✘ Anyfare answered 502: <html>Bad Gateway<\/html>/, false],
  ])('answers %s with its line', async (_what, answer, line, notCharged) => {
    fake.nextPaid = answer;
    const result = await payBase();
    expect(result.code).toBe(1);
    expect(result.err).toMatch(line);
    expect(result.err.split('\n')).toHaveLength(2);
    expect(result.err.endsWith(' Not charged.\n')).toBe(notCharged);
    expect(fake.x402Requests()).toHaveLength(1);
    expect(fake.x402Settled).toEqual([]);
  });

  it('prints the answer of a 2xx without PAYMENT-RESPONSE, with one warning', async () => {
    fake.nextPaid = { status: 200, noReceipt: true };
    const result = await payBase();
    expect(result.code).toBe(0);
    expect(result.out).toContain('Bitcoin Real (BTC)');
    expect(result.out).not.toContain('transaction');
    expect(result.err).toBe(`No PAYMENT-RESPONSE came with the answer: ${check()}.\n`);
    expect(result.out).toContain('You paid in USDC on Base.');
  });

  it('warns about an unreadable PAYMENT-RESPONSE and still prints the answer', async () => {
    fake.nextPaid = { status: 200, headers: { 'payment-response': '!!not base64!!' } };
    const result = await payBase();
    expect(result.code).toBe(0);
    expect(result.out).toContain('Bitcoin Real (BTC)');
    expect(result.err).toBe(`The PAYMENT-RESPONSE that came with the answer is unreadable: ${check()}.\n`);
  });
});

describe('call --pay base: a paid request that fails on the way', () => {
  /** A fetch like `call`'s, whose paid request fails with `failure` instead of reaching the fake. */
  function failing(failure: () => never) {
    const { fetch } = forwardingFetch(toolRoutes());
    const sent: string[] = [];
    const wrapped = (async (input: string | URL | Request, init?: RequestInit) => {
      if (new Headers(init?.headers).has('payment-signature')) {
        sent.push(String(input));
        failure();
      }
      return fetch(input, init);
    }) as typeof fetch;
    return { fetch: wrapped, sent };
  }
  const networkError = (code: string) => (): never => {
    throw new TypeError('fetch failed', { cause: Object.assign(new Error(`Made up: ${code}`), { code }) });
  };
  const host = (): string => `127.0.0.1:${new URL(fake.payUrl).port}`;
  const check = (): string => `https://basescan.org/address/${BASE_PAYER} shows your payments`;

  it.each(['ECONNREFUSED', 'ENOTFOUND'])('says "Not charged" when no connection was made: %s', async (code) => {
    const { fetch, sent } = failing(networkError(code));
    const result = await payBase({}, { fetch });
    expect(result.code).toBe(1);
    expect(result.err).toBe(`✘ Could not reach ${host()}: ${code}. The request was never sent. Not charged.\n`);
    expect(sent).toHaveLength(1);
  });

  it.each(['ECONNRESET', 'UND_ERR_SOCKET'])('says the outcome is not known after a broken connection, and how to check: %s', async (code) => {
    const { fetch, sent } = failing(networkError(code));
    const result = await payBase({}, { fetch });
    expect(result.err).toBe(`✘ Could not reach ${host()}: ${code}. Whether the call was paid is not known: ${check()}.\n`);
    expect(sent).toHaveLength(1);
  });

  it('says the outcome is not known after a timeout', async () => {
    const { fetch, sent } = failing(() => {
      throw new DOMException('Made-up timeout', 'TimeoutError');
    });
    const result = await payBase({}, { fetch });
    expect(result.err).toBe(`✘ ${host()} did not answer within 60 seconds. Whether the call was paid is not known: ${check()}.\n`);
    expect(sent).toHaveLength(1);
  });

  it('says the call was most likely paid when a 2xx was settled and its body broke', async () => {
    const { fetch } = forwardingFetch(toolRoutes());
    const wrapped = (async (input: string | URL | Request, init?: RequestInit) => {
      const response = await fetch(input, init);
      if (!new Headers(init?.headers).has('payment-signature')) return response;
      await response.arrayBuffer();
      return brokenAnswer(response.status, 'ECONNRESET', response.headers);
    }) as typeof fetch;
    const result = await payBase({}, { fetch: wrapped });
    expect(fake.x402Settled).toHaveLength(1);
    expect(result.code).toBe(1);
    expect(result.err).toBe(
      `✘ ${host()} answered 200, but its body broke: ECONNRESET. The call was most likely paid, and its answer is lost: ${check()}.\n`,
    );
    expect(fake.x402Requests()).toHaveLength(1);
  });
});

describe('the fake Anyfare checks x402 on Base as the proxy would', () => {
  const required = (option: Record<string, unknown>): PaymentRequired =>
    ({ x402Version: 2, resource: { url: routingLink(fake.payUrl, CMC_URL), description: 'Made up' }, accepts: [option] }) as unknown as PaymentRequired;
  const signWith = async (key: `0x${string}`, option = baseOption('11000')): Promise<PaymentPayload> =>
    new x402Client()
      .setSpendControls(false)
      .register('eip155:8453', new ExactEvmScheme(privateKeyToAccount(key)))
      .createPaymentPayload(required(option));
  const send = (payload: PaymentPayload): Promise<Response> =>
    realFetch(routingLink(fake.payUrl, CMC_URL), { headers: { 'payment-signature': encodePaymentSignatureHeader(payload) } });
  const codeOf = async (response: Response): Promise<string> => ((await response.json()) as { error: { code: string } }).error.code;

  it('takes a good payment once, and refuses it the second time', async () => {
    const payload = await signWith(BASE_KEY);
    expect((await send(payload)).status).toBe(200);
    const again = await send(payload);
    expect(again.status).toBe(402);
    expect(await codeOf(again)).toBe('payment_invalid');
    expect(fake.x402Settled).toHaveLength(1);
  });

  it("refuses a signature that is not the payer's", async () => {
    const other = await signWith(generatePrivateKey());
    const forged = { ...other, payload: { ...other.payload, authorization: { ...(other.payload['authorization'] as object), from: BASE_PAYER } } };
    const response = await send(forged);
    expect(response.status).toBe(402);
    expect(await codeOf(response)).toBe('payment_invalid');
  });

  it('refuses an authorization for another amount or recipient, and an option it did not offer', async () => {
    const payload = await signWith(BASE_KEY);
    const authorization = payload.payload['authorization'] as Record<string, unknown>;
    for (const change of [{ value: '1' }, { to: '0x00000000000000000000000000000000000000c3' }]) {
      const response = await send({ ...payload, payload: { ...payload.payload, authorization: { ...authorization, ...change } } });
      expect(response.status).toBe(402);
    }
    const cheaper = await signWith(BASE_KEY, baseOption('1'));
    expect((await send(cheaper)).status).toBe(402);
    expect(fake.x402Settled).toEqual([]);
  });

  it('refuses a payment for an option with another time limit or other extra fields', async () => {
    for (const change of [{ maxTimeoutSeconds: 299 }, { extra: { name: 'USD Coin', version: '2' } }, { extra: { name: 'USDC', version: '2', assetTransferMethod: 'eip3009' } }]) {
      const response = await send(await signWith(BASE_KEY, baseOption('11000', change)));
      expect(response.status).toBe(402);
      expect(await codeOf(response)).toBe('payment_invalid');
    }
    expect(fake.x402Settled).toEqual([]);
  });

  const EIP3009_TYPES = {
    TransferWithAuthorization: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
    ],
  } as const;

  it('refuses an authorization that is not valid yet, though well signed', async () => {
    const account = privateKeyToAccount(BASE_KEY);
    const option = baseOption('11000');
    const now = Math.floor(Date.now() / 1000);
    const authorization = {
      from: account.address,
      to: BASE_PAY_TO,
      value: '11000',
      validAfter: String(now + 3600),
      validBefore: String(now + 3900),
      nonce: `0x${'ab'.repeat(32)}` as `0x${string}`,
    } as const;
    const signature = await account.signTypedData({
      domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: BASE_USDC },
      types: EIP3009_TYPES,
      primaryType: 'TransferWithAuthorization',
      message: { ...authorization, value: 11000n, validAfter: BigInt(authorization.validAfter), validBefore: BigInt(authorization.validBefore) },
    });
    const payload = { x402Version: 2, accepted: option, payload: { authorization, signature } } as unknown as PaymentPayload;
    const later = await send(payload);
    expect(later.status).toBe(402);
    expect(((await later.json()) as { error: { message: string } }).error.message).toBe('The authorization is not valid yet');
    // The same, valid from now, is taken: the refusal was the time only
    const nowAuthorization = { ...authorization, validAfter: '0', nonce: `0x${'cd'.repeat(32)}` as `0x${string}` };
    const nowSignature = await account.signTypedData({
      domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: BASE_USDC },
      types: EIP3009_TYPES,
      primaryType: 'TransferWithAuthorization',
      message: { ...nowAuthorization, value: 11000n, validAfter: 0n, validBefore: BigInt(nowAuthorization.validBefore) },
    });
    const taken = await send({ ...payload, payload: { authorization: nowAuthorization, signature: nowSignature } } as unknown as PaymentPayload);
    expect(taken.status).toBe(200);
  });
});

describe('the option, before anything is signed', () => {
  it('takes the exact USDC options of Base and NEAR', () => {
    expect(checkOption('base', baseOption('11000'))).toMatchObject({ amount: '11000', payTo: BASE_PAY_TO });
    expect(checkOption('base', baseOption('11000', { extra: { name: 'USD Coin', version: '2' } }))).toBeDefined();
    expect(checkOption('near', nearOption('10000'))).toMatchObject({ payTo: NEAR_PAY_TO });
  });

  it.each<[string, 'base' | 'near', Record<string, unknown>, string]>([
    ['another scheme', 'base', { scheme: 'upto' }, 'is not of the exact scheme'],
    ['another network', 'base', { network: 'eip155:1' }, 'is not on Base'],
    ['another asset', 'base', { asset: '0x000000000000000000000000000000000000dEaD' }, 'is not the known USDC of Base'],
    ['a zero amount', 'base', { amount: '0' }, 'has no amount this app can read'],
    ['a decimal amount', 'base', { amount: '0.011' }, 'has no amount this app can read'],
    ['an amount that is a number', 'base', { amount: 11000 }, 'has no amount this app can read'],
    ['no recipient', 'base', { payTo: undefined }, 'has no recipient this app can read'],
    ['a recipient that is not an address', 'base', { payTo: 'hot.example.near' }, 'has no recipient this app can read'],
    ['no time limit', 'base', { maxTimeoutSeconds: undefined }, 'has no time limit this app can read'],
    ['a time limit of zero', 'base', { maxTimeoutSeconds: 0 }, 'has no time limit this app can read'],
    ['a time limit of 301 seconds', 'base', { maxTimeoutSeconds: 301 }, 'asks for a payment valid for more than 300 seconds'],
    ['a time limit of 301 seconds on NEAR', 'near', { maxTimeoutSeconds: 301 }, 'asks for a payment valid for more than 300 seconds'],
    ['no signing domain', 'base', { extra: { assetTransferMethod: 'eip3009' } }, 'names no signing domain for USDC'],
    ['Permit2', 'base', { extra: { name: 'USD Coin', version: '2', assetTransferMethod: 'permit2' } }, 'moves USDC another way than EIP-3009'],
    ['a NEAR recipient that is no account', 'near', { payTo: 'Not An Account' }, 'has no recipient this app can read'],
    ['another NEAR token', 'near', { asset: 'usdt.tether-token.near' }, 'is not the known USDC of NEAR'],
  ])('refuses %s', (_what, way, change, why) => {
    const option = way === 'base' ? baseOption('11000', change) : nearOption('10000', change);
    let stop: unknown;
    try {
      checkOption(way, option);
    } catch (error) {
      stop = error;
    }
    expect(stop).toBeInstanceOf(Stop);
    expect((stop as Stop).notCharged).toBe(true);
    expect((stop as Stop).message).toBe(`Anyfare's ${way === 'base' ? 'USDC on Base' : 'USDC on NEAR'} option ${why}, so the app won't sign it.`);
  });

  const planOf = (accepts: Record<string, unknown>[], x402Version = 2): Plan => {
    const required = { x402Version, resource: { url: 'https://pay.example.test/x', description: 'Made up' }, accepts };
    const offers = accepts.map((raw) => ({
      protocol: 'x402' as const,
      scheme: String(raw['scheme']),
      network: String(raw['network']),
      asset: String(raw['asset']),
      amount: BigInt(String(raw['amount'])),
      raw,
    }));
    return { anyfare: { kind: 'ok', value: { status: 402, offers, paymentRequired: required } } } as unknown as Plan;
  };

  it('refuses a 402 that offers USDC on Base twice, or that is not x402 version 2', () => {
    expect(() => chooseX402(planOf([baseOption('11000'), baseOption('12000')]), 'base')).toThrow(
      "Anyfare offers USDC on Base more than once for this call, so the app can't tell which one to pay.",
    );
    expect(() => chooseX402(planOf([baseOption('11000')], 1), 'base')).toThrow("Anyfare's 402 is not x402 version 2");
    const base = baseOption('11000');
    const chosen = chooseX402(planOf([solanaOption('11000'), base]), 'base');
    expect(chosen).toMatchObject({ micro: 11000n, what: '0.011 USDC on Base', asks: 'Anyfare asks 0.011 USDC on Base' });
    // The 402's own object, as it gave it, is what gets signed
    expect(chosen.option).toBe(base);
  });
});

describe('the SDK, signing one option at the cap', () => {
  const required = (option: Record<string, unknown>): PaymentRequired =>
    ({ x402Version: 2, resource: { url: 'https://pay.example.test/x', description: 'Made up' }, accepts: [option] }) as unknown as PaymentRequired;
  const account = privateKeyToAccount(BASE_KEY);
  const counting = () => {
    const signer = {
      calls: 0,
      address: account.address,
      signTypedData: (message: Parameters<typeof account.signTypedData>[0]) => {
        signer.calls += 1;
        return account.signTypedData(message);
      },
    };
    return signer;
  };

  it('has its own spend controls at the cap on Base: it signs nothing above it', async () => {
    const over = baseOption('20001');
    const signer = counting();
    await expect(baseClient(signer, over as PaymentRequirements, 20000n).createPaymentPayload(required(over))).rejects.toThrow(
      /rejected by spendControls/,
    );
    expect(signer.calls).toBe(0);
    // The SDK's own default, $1, would have signed it
    await new x402Client().register('eip155:8453', new ExactEvmScheme(signer)).createPaymentPayload(required(over));
    expect(signer.calls).toBe(1);
    const at = baseOption('20000');
    await baseClient(signer, at as PaymentRequirements, 20000n).createPaymentPayload(required(at));
    expect(signer.calls).toBe(2);
  });

  it('has its own spend controls at the cap on NEAR: it asks the signer for nothing above it', async () => {
    let calls = 0;
    const signer = {
      createSignedDelegateAction: async () => {
        calls += 1;
        return 'AAAA';
      },
    };
    const over = nearOption('20001');
    await expect(nearClient(signer, over as PaymentRequirements, 20000n).createPaymentPayload(required(over))).rejects.toThrow(
      /rejected by spendControls/,
    );
    expect(calls).toBe(0);
    const at = nearOption('20000');
    await nearClient(signer, at as PaymentRequirements, 20000n).createPaymentPayload(required(at));
    expect(calls).toBe(1);
  });
});

describe('what was signed, before it is sent', () => {
  const option = baseOption('11000') as PaymentRequirements;
  const signed = async (): Promise<PaymentPayload> =>
    baseClient(privateKeyToAccount(BASE_KEY), option, 20000n).createPaymentPayload({
      x402Version: 2,
      resource: { url: 'https://pay.example.test/x', description: 'Made up' },
      accepts: [option],
    });
  const refused = (payload: PaymentPayload): string => {
    try {
      checkSigned(option, BASE_PAYER, payload);
    } catch (error) {
      expect(error).toBeInstanceOf(Stop);
      expect((error as Stop).notCharged).toBe(true);
      return (error as Stop).message;
    }
    return 'not refused';
  };

  let signedPayload: PaymentPayload;
  beforeAll(async () => {
    signedPayload = await signed();
  });

  it('takes the payment the SDK made for the chosen option, valid for its 300 seconds', () => {
    expect(() => checkSigned(option, BASE_PAYER, signedPayload)).not.toThrow();
    const validBefore = Number((signedPayload.payload['authorization'] as Record<string, unknown>)['validBefore']);
    expect(validBefore - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(300);
    expect(validBefore - Math.floor(Date.now() / 1000)).toBeGreaterThan(290);
  });

  it.each<[string, (payload: PaymentPayload) => PaymentPayload, string]>([
    ['another x402 version', (p) => ({ ...p, x402Version: 1 }), 'it is not x402 version 2'],
    ['another network', (p) => ({ ...p, accepted: { ...p.accepted, network: 'eip155:1' } }), 'it names another scheme or network'],
    ['another asset', (p) => ({ ...p, accepted: { ...p.accepted, asset: '0x000000000000000000000000000000000000dEaD' } }), 'it names another asset'],
    ['another amount', (p) => ({ ...p, accepted: { ...p.accepted, amount: '11001' } }), 'it names another amount'],
    ['another recipient', (p) => ({ ...p, accepted: { ...p.accepted, payTo: '0x00000000000000000000000000000000000000c3' } }), 'it names another recipient'],
  ])('refuses a payment that names %s', (_what, change, why) => {
    expect(refused(change(signedPayload))).toBe(`The signed payment is not the one the app chose: ${why}. Nothing was sent.`);
  });

  const nowSeconds = (): number => Math.floor(Date.now() / 1000);
  const authorization = (change: Record<string, unknown>) => (p: PaymentPayload): PaymentPayload => ({
    ...p,
    payload: { ...p.payload, authorization: { ...(p.payload['authorization'] as object), ...change } },
  });

  it.each<[string, (payload: PaymentPayload) => PaymentPayload, string]>([
    ['from another address', authorization({ from: '0x00000000000000000000000000000000000000d4' }), 'it pays from another address'],
    ['to another recipient', authorization({ to: '0x00000000000000000000000000000000000000c3' }), 'it pays another recipient'],
    ['another amount', authorization({ value: '11001' }), 'it pays another amount'],
    ['with Permit2', (p) => ({ ...p, payload: { ...p.payload, permit2Authorization: {} } }), 'it is not an EIP-3009 authorization'],
    ['without a signature', (p) => ({ ...p, payload: { ...p.payload, signature: undefined } }), 'it carries no signature'],
    ['valid until 2036', authorization({ validBefore: '2082758400' }), "it stays valid longer than the option's 300 seconds"],
    ['valid 400 seconds from now', (p) => authorization({ validBefore: String(nowSeconds() + 400) })(p), "it stays valid longer than the option's 300 seconds"],
    ['valid from an hour from now', authorization({ validAfter: String(nowSeconds() + 3600) }), 'it only becomes valid later'],
    ['valid until a float', authorization({ validBefore: '1.8e9' }), "its validity window can't be read"],
    ['valid until a number', authorization({ validBefore: nowSeconds() + 60 }), "its validity window can't be read"],
  ])('refuses an authorization that pays %s', (_what, change, why) => {
    expect(refused(change(signedPayload))).toBe(`The signed payment is not the one the app chose: ${why}. Nothing was sent.`);
  });

  const near = nearOption('10000') as PaymentRequirements;
  const transfer = (args: Record<string, unknown>) => new TextEncoder().encode(JSON.stringify(args));
  type Delegate = Parameters<typeof checkNearTransfer>[0];
  // A made-up height: what the app read of the RPC before signing
  const HEIGHT = 180_000_000n;
  const goodCall = { methodName: 'ft_transfer', args: transfer({ receiver_id: NEAR_PAY_TO, amount: '10000' }), gas: 30_000_000_000_000n, deposit: 1n };
  const delegate = (change: Record<string, unknown> = {}): Delegate =>
    ({ senderId: NEAR_ACCOUNT, receiverId: NEAR_USDC, actionCount: 1, functionCall: goodCall, maxBlockHeight: HEIGHT + 300n, ...change }) as Delegate;
  const nearRefusal = (value: Delegate): string => {
    try {
      checkNearTransfer(value, near, NEAR_ACCOUNT, HEIGHT, (why: string): never => {
        throw new Stop(why);
      });
    } catch (error) {
      return (error as Stop).message;
    }
    return 'not refused';
  };
  const call = (change: Record<string, unknown>) => ({ ...goodCall, ...change });

  it('takes a NEAR delegate action of one ft_transfer of the USDC, of the amount, to the recipient', () => {
    expect(nearRefusal(delegate())).toBe('not refused');
    // The signer read the height a moment after the app did
    expect(nearRefusal(delegate({ maxBlockHeight: HEIGHT + 350n }))).toBe('not refused');
  });

  it.each<[string, Record<string, unknown>, string]>([
    ['from another account', { senderId: 'other.example.near' }, 'it pays from another account'],
    ['to another contract', { receiverId: 'usdt.tether-token.near' }, 'it calls another contract than USDC'],
    ['with two actions', { actionCount: 2 }, 'it is not one ft_transfer'],
    ['another method', { functionCall: call({ methodName: 'ft_transfer_call' }) }, 'it is not one ft_transfer'],
    ['more than one yoctoNEAR', { functionCall: call({ deposit: 2n }) }, 'it attaches more than one yoctoNEAR'],
    ['to another recipient', { functionCall: call({ args: transfer({ receiver_id: 'other.example.near', amount: '10000' }) }) }, 'it pays another recipient'],
    ['another amount', { functionCall: call({ args: transfer({ receiver_id: NEAR_PAY_TO, amount: '10001' }) }) }, 'it pays another amount'],
    ['unreadable arguments', { functionCall: call({ args: transfer({ amount: 10000 }) }) }, "its transfer can't be read"],
    ['valid for 351 blocks past the height', { maxBlockHeight: HEIGHT + 351n }, "it stays valid for more blocks than the option's 300 seconds"],
    ['valid for 2.85e8 years of blocks', { maxBlockHeight: HEIGHT + 9_000_000_000_000_000n }, "it stays valid for more blocks than the option's 300 seconds"],
  ])('refuses a NEAR delegate action %s', (_what, change, why) => {
    expect(nearRefusal(delegate(change))).toBe(why);
  });

  it("refuses a NEAR payment whose delegate action can't be read", () => {
    const payload = { x402Version: 2, accepted: near, payload: { signedDelegateAction: 'AAAA' } } as unknown as PaymentPayload;
    expect(() => checkSigned(near, NEAR_ACCOUNT, payload, { nearHeight: HEIGHT })).toThrow(
      "The signed payment is not the one the app chose: its delegate action can't be read. Nothing was sent.",
    );
    // With no height of its own to check the window against, the app sends nothing
    expect(() => checkSigned(near, NEAR_ACCOUNT, payload)).toThrow(
      'The signed payment is not the one the app chose: there is no block height to check it against. Nothing was sent.',
    );
  });
});

describe('the proof', () => {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64');

  it('reads a settled payment, a pending one, and one that did not settle', () => {
    expect(readProof(encode({ success: true, transaction: '0xabc', network: 'eip155:8453', payer: '0x1' }))).toEqual({
      kind: 'settled',
      transaction: '0xabc',
      network: 'eip155:8453',
      payer: '0x1',
    });
    expect(readProof(encode({ success: false, errorReason: 'settlement_pending', transaction: 'Hash', network: 'near:mainnet' }))).toMatchObject({
      kind: 'pending',
      transaction: 'Hash',
    });
    expect(readProof(encode({ success: false, errorReason: 'invalid_transaction_state', transaction: '' }))).toEqual({
      kind: 'failed',
      reason: 'invalid_transaction_state',
    });
    expect(readProof(null)).toEqual({ kind: 'missing' });
    expect(readProof('!!')).toEqual({ kind: 'unreadable' });
    expect(readProof(encode({ success: true }))).toEqual({ kind: 'unreadable' });
    expect(readProof(encode(['not', 'an', 'object']))).toEqual({ kind: 'unreadable' });
  });
});

describe('call --pay near', () => {
  const PAY = 'https://pay.example.test';
  const recordedRoutes = (): Record<string, () => Response> => ({
    [`POST ${EVIDENCE_URL}`]: () => answerOf('evidence-402.json'),
    [`POST ${routingLink(PAY, EVIDENCE_URL)}`]: () => answerOf('anyfare-402-near.json'),
  });

  it("picks the USDC on NEAR option of a recorded 402 of Anyfare's", async () => {
    const { fetch } = fakeFetch(recordedRoutes());
    const prepared = await TOOLS.evidence.prepare({ tool: 'evidence', account: 'anyfare.near' }, { fetch });
    const plan = await readPlan({ fetch, config: loadConfig({ ANYFARE_PAY_URL: PAY }), prepared });
    const chosen = chooseX402(plan, 'near');
    expect(chosen.option).toEqual({
      scheme: 'exact',
      network: 'near:mainnet',
      asset: NEAR_USDC,
      amount: '10000',
      payTo: NEAR_PAY_TO,
      maxTimeoutSeconds: 300,
      extra: {},
    });
    expect(chosen).toMatchObject({ micro: 10000n, what: '0.01 USDC on NEAR' });
    // Signed from the decoded payment-required header, whose resource is the routing link
    expect(chosen.required.resource.url).toBe(routingLink(PAY, EVIDENCE_URL));
    expect(() => chooseX402(plan, 'base')).toThrow('Anyfare offers no USDC on Base for this call now.');
  });

  it('asks before it signs, with the amount, the recipient and the payer, and signs nothing on a "no"', async () => {
    const { fetch, calls } = fakeFetch(recordedRoutes());
    const io = captureIo(fetch, { ANYFARE_PAY_URL: PAY, ...NEAR_ENV }, { appDir: app.dir, isTerminal: true, input: 'n\n' });
    const code = await runCli(['call', '--tool', 'evidence', '--pay', 'near'], io.io);
    expectNoKeyIn(`${io.out()}\n${io.err()}`);
    expect(code).toBe(1);
    expect(io.out()).toMatch(/You pay\s+0\.01 USDC on NEAR\n\s+To\s+pay\.anyfare\.near\n\s+From\s+buyer\.example\.near\n/);
    expect(io.out()).toContain('Pay 0.01 USDC on NEAR to pay.anyfare.near? [y/N]');
    // The NEAR RPC is not routed here: its balance can't be read, and the call goes on to the question
    expect(io.err()).toBe(
      "Could not read your wallet's balance: the NEAR RPC at 127.0.0.1:9 could not be reached (ENOTFOUND). The facilitator refuses a payment the wallet can't cover.\n" +
        '✘ Nothing was signed or sent. Not charged.\n',
    );
    expect(calls.map((item) => `${item.method} ${new URL(item.url).host}`)).toEqual([
      'POST merchant-near.mikedotexe.com',
      'POST pay.example.test',
      'POST 127.0.0.1:9',
    ]);
    // The read of the balance: a view call of the USDC contract, nothing signed
    expect(JSON.parse(calls[2]?.body ?? '')).toMatchObject({ method: 'query', params: { request_type: 'call_function', method_name: 'ft_balance_of' } });
    expect(calls.some((item) => item.headers['payment-signature'] !== undefined)).toBe(false);
  });

  it('refuses at the cap before the wallet is read or the signer made', async () => {
    // No NEAR variable is set: reading the wallet would stop on NEAR_ACCOUNT_ID
    const result = await call(['--tool', 'evidence', '--pay', 'near', '--yes'], { MAX_PAYMENT_USD: '0.001' });
    expect(result.code).toBe(1);
    expect(result.err).toBe('✘ Anyfare asks 0.002 USDC on NEAR, above your cap MAX_PAYMENT_USD of $0.001. Not charged.\n');
    expect(fake.x402Requests()).toEqual([]);
  });

  it.each([
    ['empty after ed25519:', 'ed25519:'],
    ['not base58', 'ed25519:0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl'],
    ['of another curve', `secp256k1:${NEAR_KEY.slice('ed25519:'.length)}`],
    ['without its prefix', NEAR_KEY.slice('ed25519:'.length)],
    ['16 bytes long', `ed25519:${base58(new Uint8Array(16).fill(7))}`],
  ])('refuses a NEAR_PRIVATE_KEY %s in one line, without quoting it', async (_what, value) => {
    const result = await call(['--tool', 'evidence', '--pay', 'near', '--yes'], { ...NEAR_ENV, NEAR_PRIVATE_KEY: value });
    expect(result.code).toBe(1);
    expect(result.err).toBe('✘ NEAR_PRIVATE_KEY is not a NEAR private key: it is ed25519: and base58. Check .env.local.\n');
    expect(fake.x402Requests()).toEqual([]);
  });

  it.each([
    ['missing', undefined, '✘ NEAR_ACCOUNT_ID is not set. Add it to .env.local. It is the NEAR account that pays USDC on NEAR, such as name.near.\n'],
    ['in capitals', 'Buyer.Example.Near', '✘ NEAR_ACCOUNT_ID is not a NEAR account ID, such as name.near. Check .env.local.\n'],
    ['the key put in its place', NEAR_KEY, '✘ NEAR_ACCOUNT_ID is not a NEAR account ID, such as name.near. Check .env.local.\n'],
  ])('refuses a NEAR_ACCOUNT_ID that is %s in one line', async (_what, value, line) => {
    const env: Record<string, string> = { ...NEAR_ENV };
    if (value === undefined) delete env['NEAR_ACCOUNT_ID'];
    else env['NEAR_ACCOUNT_ID'] = value;
    const result = await call(['--tool', 'evidence', '--pay', 'near', '--yes'], env);
    expect(result.err).toBe(line);
    expect(fake.x402Requests()).toEqual([]);
  });

  it('needs NEAR_PRIVATE_KEY, and takes a NEAR_RPC_URL over https only, or http to this machine', async () => {
    const { NEAR_PRIVATE_KEY: _key, ...withoutKey } = NEAR_ENV;
    const missing = await call(['--tool', 'evidence', '--pay', 'near', '--yes'], withoutKey);
    expect(missing.err).toBe(
      '✘ NEAR_PRIVATE_KEY is not set. Add it to .env.local. It is a full-access key of NEAR_ACCOUNT_ID: ed25519: and base58.\n',
    );
    const rule = '✘ NEAR_RPC_URL must be an https:// URL, or http:// to 127.0.0.1 or localhost. Check .env.local.\n';
    for (const url of ['ftp://rpc.example.test/?key=made-up', 'http://rpc.example.test/made-up-key', 'http://127.0.0.2:3030', 'not a url']) {
      const refused = await call(['--tool', 'evidence', '--pay', 'near', '--yes'], { ...NEAR_ENV, NEAR_RPC_URL: url });
      expect(refused.err).toBe(rule);
      expect(refused.err).not.toContain('made-up');
    }
    // fetch refuses a URL with a user name or password, so the app refuses it first
    const withCredentials = await call(['--tool', 'evidence', '--pay', 'near', '--yes'], {
      ...NEAR_ENV,
      NEAR_RPC_URL: 'https://made-up-user:made-up-pass@rpc.example.test/',
    });
    expect(withCredentials.err).toBe(
      "✘ NEAR_RPC_URL can't carry a user name or password: put an API key in its path or query. Check .env.local.\n",
    );
    // Taken, then not reached: no host but 127.0.0.1 answers here
    const https = await call(['--tool', 'evidence', '--pay', 'near', '--yes'], { ...NEAR_ENV, NEAR_RPC_URL: 'https://rpc.example.test/made-up-key' });
    expect(https.err).toBe(
      "Could not read your wallet's balance: the NEAR RPC at rpc.example.test could not be reached (ENOTFOUND). The facilitator refuses a payment the wallet can't cover.\n" +
        '✘ Could not sign the payment: the NEAR RPC at rpc.example.test could not be reached (ENOTFOUND). Nothing was sent. Not charged.\n',
    );
    expect(fake.x402Requests()).toEqual([]);
  });

  /** A port of 127.0.0.1 that nothing listens on: a connection to it is refused. */
  async function closedPort(): Promise<number> {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return port;
  }

  it('builds the signer with a key made here, and fails in one line when the NEAR RPC is unreachable: nothing signed, nothing sent', async () => {
    const blocked = await call(['--tool', 'evidence', '--pay', 'near', '--yes'], NEAR_ENV);
    expect(blocked.code).toBe(1);
    expect(blocked.out).toContain('▸ Signing 0.002 USDC on NEAR to pay.anyfare.near');
    expect(blocked.err.startsWith(NEAR_BALANCE_UNREAD)).toBe(true);
    expect(blocked.err.slice(NEAR_BALANCE_UNREAD.length)).toMatch(
      /^✘ Could not sign the payment: the NEAR RPC at 127\.0\.0\.1:9 could not be reached( \([^)\n]+\))?\. Nothing was sent\. Not charged\.\n$/,
    );
    expect(blocked.out).not.toContain('Calling');

    const port = await closedPort();
    const refused = await call(['--tool', 'evidence', '--pay', 'near', '--yes'], { ...NEAR_ENV, NEAR_RPC_URL: `http://127.0.0.1:${port}` });
    expect(refused.err).toBe(
      `Could not read your wallet's balance: the NEAR RPC at 127.0.0.1:${port} could not be reached (ECONNREFUSED). The facilitator refuses a payment the wallet can't cover.\n` +
        `✘ Could not sign the payment: the NEAR RPC at 127.0.0.1:${port} could not be reached (ECONNREFUSED). Nothing was sent. Not charged.\n`,
    );
    expect(fake.x402Requests()).toEqual([]);
    // Each call sent only its unpaid request to the routed path
    expect(fake.routed()).toHaveLength(2);
  });

  it('says when the NEAR account has another payment in flight, not charged', () => {
    const message = "This payer has another NEAR payment in flight, which this one's nonce would collide with. Pay again once it has settled.";
    const error = new HttpError(402, message, { code: 'payment_invalid', requestId: 'req-made-up-7' });
    const stop = stopFor(error, { side: 'proxy', paid: { way: 'near', apiName: 'The evidence API' } }, x402Lines('made up'));
    expect(stop.line()).toBe(
      'Your NEAR account has another payment in flight. Wait until it settles, then run the call again (request req-made-up-7). Not charged.',
    );
  });
});

describe('call --pay near, signed against a made-up NEAR RPC', () => {
  let rpc: FakeNearRpc;
  const nearEnv = (path = ''): Record<string, string> => ({ ...NEAR_ENV, NEAR_RPC_URL: `${rpc.url}${path}` });
  const payNear = (path = '') => call(['--tool', 'evidence', '--pay', 'near', '--yes'], nearEnv(path));
  // Made up: a key of the RPC's own, in its path and in its query
  const KEYED = '/made-up-path-Wq3/v3?made-up-query=Zr8LmQ';
  const KEYED_PARTS = ['made-up-path', 'Wq3', '/v3', 'made-up-query', 'Zr8LmQ', '?'];

  beforeAll(async () => {
    rpc = await startFakeNearRpc();
  });
  afterAll(async () => {
    await rpc.close();
  });
  beforeEach(() => {
    rpc.height = 180_000_000n;
    rpc.nextHeights.length = 0;
    rpc.failing = undefined;
    rpc.calls.length = 0;
    // Made up: the buyer's account holds the test's key, at a made-up nonce, and 1 USDC
    rpc.addAccessKey(NEAR_ACCOUNT, NEAR_PUBLIC_KEY, 41n);
    rpc.setBalance(NEAR_ACCOUNT, 1_000_000n);
    fake.nearChain = rpc;
  });

  it('pays the evidence API in USDC on NEAR, signed by the SDK and checked by the fake, with the proof and the story line', async () => {
    const result = await payNear();
    expect(result.err).toBe('');
    expect(result.code).toBe(0);
    const out = result.out;
    expect(out).toMatch(/You pay\s+0\.002 USDC on NEAR\n\s+To\s+pay\.anyfare\.near\n\s+From\s+buyer\.example\.near\n\s+Valid for\s+300 blocks, about 3 minutes\n/);
    expect(out).toContain('Account     anyfare.near');
    expect(fake.x402Settled).toHaveLength(1);
    const [settled] = fake.x402Settled;
    expect(settled).toMatchObject({ network: 'near:mainnet', payer: NEAR_ACCOUNT, payTo: NEAR_PAY_TO, amount: '2000' });
    expectResultShape(out, {
      name: 'The evidence API',
      answer: [
        'Account     anyfare.near',
        'Balance     1.23456 NEAR',
        'Storage     4242 bytes',
        'Contract    no',
        'Block       123456789 (FakeBlockHashForTheTest1111111111111111111)',
        'Finality    final',
        'Observed    2026-11-09T10:15:00.000Z',
      ],
      proof: [
        `Paid 0.002 USDC on NEAR from ${NEAR_ACCOUNT}: transaction ${settled?.transaction}`,
        `https://nearblocks.io/txns/${settled?.transaction}`,
      ],
      story: '✔ You paid in USDC on NEAR. Anyfare paid the evidence API in USDC on NEAR from its own wallet.',
    });
    expect(out).toContain('▸ Calling the evidence API through Anyfare');
    const paid = fake.x402Requests();
    expect(paid).toHaveLength(1);
    expect(paid[0]?.method).toBe('POST');
    expect(paid[0]?.body).toBe('{"accountId":"anyfare.near"}');
    // The app's read of the balance and of the height, then the signer's two reads; nothing sent to the chain
    expect(rpc.calls.map((item) => item.method).sort()).toEqual(['block', 'block', 'query', 'query']);
    expect(rpc.balanceReads().map((item) => (item.params as Record<string, unknown>)['method_name'])).toEqual(['ft_balance_of']);
  });

  it('is refused by the fake when the same NEAR payment comes again', async () => {
    expect((await payNear()).code).toBe(0);
    const header = fake.x402Requests()[0]?.headers['payment-signature'] ?? '';
    const again = await realFetch(routingLink(fake.payUrl, EVIDENCE_URL), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'payment-signature': header },
      body: '{"accountId":"anyfare.near"}',
    });
    expect(again.status).toBe(402);
    expect(((await again.json()) as { error: { message: string } }).error.message).toContain('already used');
    expect(fake.x402Settled).toHaveLength(1);
  });

  it('says when the NEAR account has another payment in flight, not charged', async () => {
    fake.nextX402 = 'payer_busy';
    const result = await payNear();
    expect(result.code).toBe(1);
    expect(result.err).toMatch(
      /^✘ Your NEAR account has another payment in flight\. Wait until it settles, then run the call again \(request req-made-up-\d+\)\. Not charged\.\n$/,
    );
    expect(fake.x402Requests()).toHaveLength(1);
    expect(fake.x402Settled).toEqual([]);
  });

  it('refuses before sending a delegate action valid far past the height the app read', async () => {
    // The app reads one height; the signer, a moment later, is told one 10,000 blocks higher
    rpc.nextHeights.push(180_000_000n, 180_010_000n);
    const result = await payNear();
    expect(result.code).toBe(1);
    expect(result.err).toBe(
      "✘ The signed payment is not the one the app chose: it stays valid for more blocks than the option's 300 seconds. Nothing was sent. Not charged.\n",
    );
    expect(result.out).not.toContain('Calling');
    expect(fake.x402Requests()).toEqual([]);
  });

  it('says in one line when the access key is not one of the account, naming the account', async () => {
    rpc.addAccessKey(NEAR_ACCOUNT, nearTestKey().publicKey, 41n);
    const result = await payNear();
    expect(result.err).toBe(
      `✘ Could not sign the payment: the NEAR RPC at ${new URL(rpc.url).host} says NEAR_PRIVATE_KEY is not an access key of ${NEAR_ACCOUNT}. Nothing was sent. Not charged.\n`,
    );
    expect(fake.x402Requests()).toEqual([]);
  });

  it('names the RPC by its host only when it answers 503, with a key in its path and query', async () => {
    rpc.failing = { status: 503 };
    const result = await payNear(KEYED);
    expect(result.code).toBe(1);
    const host = new URL(rpc.url).host;
    expect(result.err).toBe(
      `Could not read your wallet's balance: the NEAR RPC at ${host} answered 503. The facilitator refuses a payment the wallet can't cover.\n` +
        `✘ Could not sign the payment: the NEAR RPC at ${host} answered 503. Nothing was sent. Not charged.\n`,
    );
    for (const part of KEYED_PARTS) expect(`${result.out}${result.err}`).not.toContain(part);
    // The read of the balance, then the app's read of the height
    expect(rpc.calls.map((item) => item.path)).toEqual([KEYED, KEYED]);
    expect(fake.x402Requests()).toEqual([]);
  });

  it('gives up on an RPC the SDK keeps retrying, after the time limit, naming its host only', async () => {
    // The app's own read passes; the signer's read of the key answers 503, which the SDK retries for a minute and more
    rpc.failing = { status: 503, only: 'query' };
    const { fetch } = forwardingFetch(toolRoutes());
    const io = captureIo(fetch, { ANYFARE_API_URL: fake.apiUrl, ANYFARE_PAY_URL: fake.payUrl, ...nearEnv(KEYED) }, { appDir: app.dir });
    const ctx = createContext(io.io);
    const started = Date.now();
    let stop: unknown;
    try {
      await callWithX402(ctx, { args: DEFAULT_ARGS.evidence, explain: false, yes: true }, 'near', { signingMs: 400 });
    } catch (error) {
      stop = error;
    } finally {
      ctx.close();
    }
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(stop).toBeInstanceOf(Stop);
    const line = (stop as Stop).line();
    expect(line).toBe(`Could not sign the payment: the NEAR RPC at ${new URL(rpc.url).host} did not answer in 400 ms. Nothing was sent. Not charged.`);
    for (const part of KEYED_PARTS) expect(`${io.out()}${line}`).not.toContain(part);
    expect(rpc.calls.some((item) => item.method === 'query')).toBe(true);
    expect(fake.x402Requests()).toEqual([]);
  });

  it('exits as soon as it has said why, while the SDK still retries the RPC', async () => {
    rpc.failing = { status: 503, only: 'query' };
    const child = spawn(process.execPath, [new URL('./children/giveUpOnNearRpc.ts', import.meta.url).pathname], {
      env: { PATH: process.env['PATH'] ?? '', ANYFARE_API_URL: fake.apiUrl, ANYFARE_PAY_URL: fake.payUrl, ...nearEnv(KEYED) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let err = '';
    child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
    child.stdout.resume();
    const started = Date.now();
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
    // The SDK's retries of a 503 take about 86 seconds: the process does not wait for them
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(code).toBe(1);
    expect(err).toContain('did not answer in 400 ms. Nothing was sent. Not charged.');
    expectNoKeyIn(err);
    for (const part of KEYED_PARTS) expect(err).not.toContain(part);
  }, 30_000);
});

describe('the NEAR signer, failing', () => {
  const wallet = () => readNearWallet({ ...NEAR_ENV, NEAR_RPC_URL: 'https://rpc.example.test/made-up-path-Wq3/v3?made-up-query=Zr8LmQ' });
  const url = 'https://rpc.example.test/made-up-path-Wq3/v3?made-up-query=Zr8LmQ';

  it.each<[string, unknown, string]>([
    ['the 503 the SDK gives up on', new Error(`${url} unavailable`), 'the NEAR RPC at rpc.example.test answered with an error'],
    ['its retries running out', new Error(`Exceeded 10 attempts for ${url}.`), 'the NEAR RPC at rpc.example.test answered with an error'],
    ['an answer that quotes the URL', Object.assign(new Error(`Invalid key in ${url}`), { cause: 401 }), 'the NEAR RPC at rpc.example.test answered with an error'],
    [
      'a missing access key',
      Object.assign(new Error(`Access key for public key ${NEAR_PUBLIC_KEY} has never been observed on the node`), { type: 'AccessKeyDoesNotExist' }),
      `the NEAR RPC at rpc.example.test says NEAR_PRIVATE_KEY is not an access key of ${NEAR_ACCOUNT}`,
    ],
    [
      'a fetch that failed with words naming the URL',
      new TypeError('fetch failed', { cause: new Error(`connect to ${url} failed`) }),
      'the NEAR RPC at rpc.example.test could not be reached',
    ],
    ['a fetch that was refused', new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'ECONNREFUSED' }) }), 'the NEAR RPC at rpc.example.test could not be reached (ECONNREFUSED)'],
  ])('says %s in a fixed line, naming the host only', (_what, error, line) => {
    expect(nearSigningFailure(error, wallet())).toBe(line);
  });

  it('takes every part of the URL out of a text, but its host', () => {
    expect(scrubRpcUrl(`${url} unavailable; key Zr8LmQ at /made-up-path-Wq3/v3`, url)).toBe('… unavailable; key … at …');
    expect(scrubRpcUrl('rpc.example.test answered', url)).toBe('rpc.example.test answered');
    // A stray `%` in a path segment is not an escape: scrubbed as it is, never a crash
    const stray = 'https://rpc.example.test/v3/MadeUpKey%zz';
    expect(scrubRpcUrl(`${stray} unavailable`, stray)).not.toContain('MadeUpKey');
  });
});

describe('the check for a key in the output', () => {
  it('finds any part of a test key longer than 4 characters', () => {
    expect(() => expectNoKeyIn(`text ${BASE_KEY.slice(20, 25)} text`)).toThrow('a part of a test key');
    expect(() => expectNoKeyIn(`text ${BASE_KEY.slice(20, 25).toUpperCase()} text`)).toThrow('a part of a test key');
    expect(() => expectNoKeyIn(`text ${NEAR_KEY.slice(30, 35)} text`)).toThrow('a part of a test key');
    expect(() => expectNoKeyIn(`a payer ${BASE_PAYER} and nothing else`)).not.toThrow();
  });
});
