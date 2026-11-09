// call --pay tempo. Every key here is made in the test, in memory only, and holds nothing. No request
// leaves 127.0.0.1: the fake Anyfare, and a made-up Tempo RPC that takes no transaction. Every charge,
// price and receipt is made up, dated 2026-11-09 or later.

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { Challenge, Credential, Receipt } from 'mppx';
import { HttpRequestError, RpcRequestError, TimeoutError, decodeFunctionData, encodeFunctionData } from 'viem';
import type { Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { PrivateKeyAccount } from 'viem/accounts';
import { Abis, Transaction } from 'viem/tempo';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { routingLink } from '../src/anyfare.ts';
import { runCli } from '../src/cli.ts';
import { createContext } from '../src/context.ts';
import type { Plan } from '../src/explain.ts';
import type { Offer } from '../src/offers.ts';
import {
  CHARGE_OPTIONS,
  callWithTempo,
  checkCharge,
  checkCredential,
  checkFee,
  checkTransfer,
  chooseTempo,
  readReceipt,
  signCredential,
  tempoSigningFailure,
  windowText,
} from '../src/tempo.ts';
import type { TempoChoice } from '../src/tempo.ts';
import { DEFAULT_ARGS } from '../src/tools/index.ts';
import { Stop, toAtomic } from '../src/util.ts';
import { readTempoWallet } from '../src/wallets.ts';
import { EVIDENCE_URL, FAKE_TEMPO_RECIPIENT, ROUTE_URL, TEMPO_USDCE, forwardingFetch, startFakeAnyfare, toolRoutes, toolTargets } from './fakeAnyfare.ts';
import type { FakeAnyfare, FakeTarget, FakeTempoCharge, PaidAnswer } from './fakeAnyfare.ts';
import { HONEST_GAS, HONEST_MAX_FEE_PER_GAS, startFakeTempoRpc } from './fakeTempoRpc.ts';
import type { FakeTempoRpc } from './fakeTempoRpc.ts';
import { brokenAnswer, captureIo, expectResultShape, fixture, tempAppDir } from './helpers.ts';
import type { IoOptions } from './helpers.ts';

const TEMPO_KEY = generatePrivateKey();
const ACCOUNT = privateKeyToAccount(TEMPO_KEY);
const TEMPO_PAYER = ACCOUNT.address;
// pathUSD on Tempo: a TIP-20 stablecoin, but not the one this app pays
const PATH_USD = '0x20c0000000000000000000000000000000000000';
const OTHER = '0x00000000000000000000000000000000000000c3';

/** The three tools as targets whose 402 offers a Tempo charge at their made-up Credits price. */
function tempoTargets(change: Partial<FakeTempoCharge> = {}): Record<'cmc' | '3route' | 'evidence', FakeTarget> {
  const targets = toolTargets();
  const charge = (target: FakeTarget): FakeTempoCharge => ({ amount: toAtomic(target.price, 6).toString(), ...change });
  return {
    cmc: { ...targets.cmc, mpp: charge(targets.cmc) },
    '3route': { ...targets['3route'], mpp: charge(targets['3route']) },
    evidence: { ...targets.evidence, mpp: charge(targets.evidence) },
  };
}

let fake: FakeAnyfare;
let rpc: FakeTempoRpc;
let app: { dir: string; remove: () => void };
const realFetch = globalThis.fetch;

beforeAll(async () => {
  [fake, rpc] = await Promise.all([startFakeAnyfare(), startFakeTempoRpc()]);
  // Nothing here may reach a host but 127.0.0.1, whatever reads the global fetch
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (new URL(url).hostname !== '127.0.0.1') throw new Error('These tests reach no host but 127.0.0.1');
    return realFetch(input, init);
  });
});
afterAll(async () => {
  vi.unstubAllGlobals();
  rpc.reset();
  await Promise.all([fake.close(), rpc.close()]);
});
beforeEach(() => {
  fake.reset();
  rpc.reset();
  for (const target of Object.values(tempoTargets())) fake.addTarget(target);
  app = tempAppDir();
});
afterEach(() => {
  app.remove();
});

const tempoEnv = (path = ''): Record<string, string> => ({ TEMPO_PRIVATE_KEY: TEMPO_KEY, TEMPO_RPC_URL: `${rpc.url}${path}` });
const routedPath = (url: string): string => `/${url.replace(/^https:\/\//, '')}`;
const payHost = (): string => new URL(fake.payUrl).host;
const check = (): string => `https://explore.tempo.xyz/address/${TEMPO_PAYER} shows your payments`;

// What the output may show that is public: addresses, the fakes' hosts and the request IDs
const PUBLIC = /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])|127\.0\.0\.1:[0-9]+|req-made-up-[0-9]+/g;

/**
 * Throws when a text holds the test key, or any part of it longer than 4 characters. The made-up
 * transaction hashes and the public values are taken out first: they are not parts of the key.
 */
function expectNoKeyIn(text: string, hashes: readonly string[] = []): void {
  let rest = text;
  for (const hash of [...fake.mppSettled.map((item) => item.transaction), ...hashes]) rest = rest.split(hash).join(' ');
  rest = rest.replace(PUBLIC, ' ').toLowerCase();
  const body = TEMPO_KEY.slice(2).toLowerCase();
  for (let at = 0; at + 5 <= body.length; at += 1) {
    // The message never holds the part itself
    if (rest.includes(body.slice(at, at + 5))) throw new Error(`The output holds a part of the test key, at ${at}`);
  }
}

async function call(
  argv: readonly string[],
  env: Record<string, string> = {},
  options: IoOptions & { readonly fetch?: typeof fetch; readonly hashes?: readonly string[] } = {},
) {
  const { fetch: forwarding, calls } = forwardingFetch(toolRoutes());
  const io = captureIo(options.fetch ?? forwarding, { ANYFARE_API_URL: fake.apiUrl, ANYFARE_PAY_URL: fake.payUrl, ...env }, { appDir: app.dir, ...options });
  const code = await runCli(['call', ...argv], io.io);
  const result = { code, out: io.out(), err: io.err(), calls };
  expectNoKeyIn(`${result.out}\n${result.err}`, options.hashes);
  return result;
}

const payTempo = (env: Record<string, string> = {}, options: IoOptions & { readonly fetch?: typeof fetch; readonly hashes?: readonly string[] } = {}) =>
  call(['--tool', '3route', '--pay', 'tempo', '--yes'], { ...tempoEnv(), ...env }, options);

/** A Tempo charge as Anyfare's rail offers one, for 0.0012 USDC.e, open for 5 minutes. Made up. */
function anyfareCharge(
  change: { readonly request?: Record<string, unknown>; readonly details?: Record<string, unknown>; readonly top?: Record<string, unknown> } = {},
): Challenge.Challenge {
  return Challenge.from({
    id: 'made-up-charge-id',
    realm: 'pay.example.test',
    method: 'tempo',
    intent: 'charge',
    request: {
      amount: '1200',
      currency: TEMPO_USDCE,
      recipient: FAKE_TEMPO_RECIPIENT,
      methodDetails: { chainId: 4217, supportedModes: ['pull'], ...change.details },
      ...change.request,
    },
    expires: new Date(Date.now() + 5 * 60_000).toISOString(),
    ...change.top,
  } as Parameters<typeof Challenge.from>[0]);
}

const { fetch: directFetch } = forwardingFetch({});

describe('a credential for a recorded charge, offline', () => {
  it("signs 3Route's recorded charge, made Anyfare's, in pull mode: one transfer of the amount of USDC.e to the recipient, on chain 4217, with no fee payer", async () => {
    const recorded = Challenge.deserialize(fixture('3route-402.json').headers?.['www-authenticate'] ?? '');
    expect(recorded.request).toMatchObject({ amount: '1000', currency: TEMPO_USDCE, methodDetails: { chainId: 4217 } });
    // Made up: the realm and the recipient as Anyfare's would be, and a charge open for 5 minutes from now
    const challenge = Challenge.from({
      ...recorded,
      id: 'made-up-charge-id',
      realm: 'pay.example.test',
      request: { ...recorded.request, recipient: FAKE_TEMPO_RECIPIENT },
      expires: new Date(Date.now() + 5 * 60_000).toISOString(),
    });
    const chosen = checkCharge(challenge, 'pay.example.test');
    expect(chosen).toMatchObject({ micro: 1000n, what: '0.001 USDC.e on Tempo', recipient: FAKE_TEMPO_RECIPIENT, asks: 'Anyfare asks 0.001 USDC.e on Tempo' });
    const wallet = readTempoWallet(tempoEnv());

    const credential = await signCredential(directFetch, chosen, wallet);

    // The whole Authorization value: the Payment scheme the proxy looks for, and base64url
    expect(credential).toMatch(/^Payment [A-Za-z0-9_-]+$/);
    const { challenge: answered, payload } = Credential.deserialize(credential);
    expect(Challenge.serialize(answered)).toBe(Challenge.serialize(challenge));
    // Pull mode: the signed transaction itself, for Anyfare to broadcast
    expect(payload).toMatchObject({ type: 'transaction', signature: expect.stringMatching(/^0x76[0-9a-f]+$/) });
    const transaction = Transaction.deserialize((payload as { signature: Hex }).signature) as unknown as Record<string, unknown>;
    expect(transaction['chainId']).toBe(4217);
    expect(String(transaction['from']).toLowerCase()).toBe(TEMPO_PAYER.toLowerCase());
    // No fee payer: the buyer's own transaction pays its fee
    expect(transaction['feePayerSignature']).toBeUndefined();
    const calls = transaction['calls'] as { readonly to: string; readonly data: Hex; readonly value?: bigint }[];
    expect(calls).toHaveLength(1);
    expect(calls[0]?.to.toLowerCase()).toBe(TEMPO_USDCE.toLowerCase());
    expect(calls[0]?.value).toBeUndefined();
    const transfer = decodeFunctionData({ abi: Abis.tip20, data: calls[0]?.data ?? '0x' });
    expect(transfer.functionName).toBe('transferWithMemo');
    const [to, amount] = (transfer.args ?? []) as readonly unknown[];
    expect(String(to).toLowerCase()).toBe(FAKE_TEMPO_RECIPIENT);
    expect(amount).toBe(1000n);
    // The client's 25 seconds, within the charge
    const left = Number(transaction['validBefore']) - Math.floor(Date.now() / 1000);
    expect(left).toBeGreaterThan(15);
    expect(left).toBeLessThanOrEqual(25);
    // The fee in USDC.e, whatever token the node fills in, at the node's gas and fees: viem raises the
    // fill's highest price by a fifth, and the client adds 5,000 gas
    expect(String(transaction['feeToken']).toLowerCase()).toBe(TEMPO_USDCE.toLowerCase());
    expect(transaction['gas']).toBe(HONEST_GAS + 5_000n);
    expect(transaction['maxFeePerGas']).toBe((HONEST_MAX_FEE_PER_GAS * 12n) / 10n);
    const checked = checkCredential(credential, chosen, wallet.payer, 20_000n);
    // 57,000 gas at 1.2 × 10^9 attodollars: 68.4 micro-USD, rounded up
    expect(checked).toEqual({ signed: (payload as { signature: Hex }).signature, maxFee: 69n, validBefore: transaction['validBefore'] });
    // The node filled it in; nothing was sent to it, and no balance was read to swap from
    expect(rpc.sent()).toEqual([]);
    expect(rpc.calls.map((item) => item.method)).toEqual(['eth_fillTransaction', 'eth_chainId']);
    // It was asked to fill a fee in USDC.e, not left to pick one
    expect(String((rpc.calls[0]?.params[0] as Record<string, unknown>)['feeToken']).toLowerCase()).toBe(TEMPO_USDCE.toLowerCase());
  });

  it('signs the same with the fill refused, from the fees and the gas estimate the RPC gives one by one', async () => {
    rpc.fill = 'refused';
    const chosen = checkCharge(anyfareCharge(), 'pay.example.test');
    const wallet = readTempoWallet(tempoEnv());
    const credential = await signCredential(directFetch, chosen, wallet);
    const transaction = Transaction.deserialize((Credential.deserialize(credential).payload as { signature: Hex }).signature) as unknown as Record<string, unknown>;
    expect(String(transaction['feeToken']).toLowerCase()).toBe(TEMPO_USDCE.toLowerCase());
    expect(checkCredential(credential, chosen, wallet.payer, 20_000n).maxFee).toBe(1n);
    expect(rpc.calls.map((item) => item.method).sort()).toEqual([
      'eth_chainId',
      'eth_estimateGas',
      'eth_fillTransaction',
      'eth_getBlockByNumber',
      'eth_maxPriorityFeePerGas',
    ]);
    expect(rpc.sent()).toEqual([]);
  });
});

describe('the charge client', () => {
  it('is told explicitly to sign in pull mode, and never to swap', () => {
    expect(CHARGE_OPTIONS).toEqual({ mode: 'pull', autoSwap: false });
  });

  it('never broadcasts, even for a charge that takes push mode only', async () => {
    const chosen = checkCharge(anyfareCharge(), 'pay.example.test');
    // Past the app's own check, which refuses it first: the client alone must not broadcast it
    const push = anyfareCharge({ details: { supportedModes: ['push'] } });
    await expect(signCredential(directFetch, { ...chosen, challenge: push }, readTempoWallet(tempoEnv()))).rejects.toThrow(
      'Could not sign the payment: the MPP client refused to sign it. Nothing was sent.',
    );
    expect(rpc.sent()).toEqual([]);
  });

  it('refuses to sign a charge that closed while the app asked', async () => {
    const chosen = checkCharge(anyfareCharge(), 'pay.example.test');
    const stop = await signCredential(directFetch, { ...chosen, expiresMs: Date.now() - 1 }, readTempoWallet(tempoEnv())).catch((error: unknown) => error);
    expect(stop).toBeInstanceOf(Stop);
    expect((stop as Stop).line()).toBe("Anyfare's USDC.e on Tempo charge closed before it was signed. Nothing was signed or sent. Not charged.");
    expect(rpc.calls).toEqual([]);
  });
});

describe('call --pay tempo', () => {
  it('pays a 3Route call in USDC.e on Tempo, signed once, checked by the fake, with the proof and the story line', async () => {
    const result = await payTempo();
    expect(result.err).toBe('');
    expect(result.code).toBe(0);
    const out = result.out;
    expect(out).toContain('3Route: 1 USDC → WETH on Base');
    expect(out).toMatch(/The API asks\s+\$0\.001 in USDC on Base/);
    expect(out).toMatch(/Anyfare's quote\s+\$0\.0012, with a fee of \$0\.0002/);
    expect(out).toMatch(/You pay\s+0\.0012 USDC\.e on Tempo\n/);
    expect(out).toContain(`To               ${FAKE_TEMPO_RECIPIENT}\n`);
    expect(out).toContain(`From             ${TEMPO_PAYER}\n`);
    // The fee's bound and when the charge closes, before anything is signed; the signed fee and window after
    expect(out).toMatch(
      /From {13}0x[0-9a-fA-F]{40}\n {2}Network fee {6}at most \$0\.01, in USDC\.e on Tempo\n {2}The charge closes in 5 minutes\.\n▸ Signing 0\.0012 USDC\.e on Tempo to 0x0{38}e7\n {2}The signed transfer is valid for 2[0-5] seconds\. Its network fee is at most \$0\.000069\.\n▸ Calling 3Route/,
    );
    expect(out).toContain('1 USDC → 0.00025 WETH');

    // The fake checked the transaction against the charge, and took it once
    expect(fake.mppSettled).toHaveLength(1);
    const [settled] = fake.mppSettled;
    expect(settled?.amount).toBe('1200');
    expect(settled?.payer.toLowerCase()).toBe(TEMPO_PAYER.toLowerCase());
    expect(settled?.recipient.toLowerCase()).toBe(FAKE_TEMPO_RECIPIENT);
    expect(out).toContain(`  Paid 0.0012 USDC.e on Tempo from ${TEMPO_PAYER}, and a network fee of at most $0.000069: transaction ${settled?.transaction}\n`);
    expect(out).toContain(`https://explore.tempo.xyz/tx/${settled?.transaction}\n`);
    expectResultShape(out, {
      name: '3Route',
      answer: [
        '1 USDC → 0.00025 WETH',
        'Rate        1 USDC = 0.00025 WETH',
        '            1 WETH = 4000 USDC',
        'Gas         150000',
        'Block 12345678 on Base',
      ],
      proof: [
        `Paid 0.0012 USDC.e on Tempo from ${TEMPO_PAYER}, and a network fee of at most $0.000069: transaction ${settled?.transaction}`,
        `https://explore.tempo.xyz/tx/${settled?.transaction}`,
      ],
      story: '✔ You paid in USDC.e on Tempo. Anyfare paid 3Route in USDC on Base from its own wallet.',
    });

    // Exactly one request carried the credential: the same call, with Authorization only
    const paid = fake.mppRequests();
    expect(paid).toHaveLength(1);
    expect(paid[0]?.method).toBe('GET');
    expect(paid[0]?.path).toBe(routedPath(ROUTE_URL));
    expect(paid[0]?.headers['authorization']).toMatch(/^Payment [A-Za-z0-9_-]+$/);
    expect(paid[0]?.headers['payment-signature']).toBeUndefined();
    expect(fake.routed()).toHaveLength(2);
    expect(rpc.sent()).toEqual([]);
  });

  it('pays the evidence API, a POST, with the same body and headers', async () => {
    const result = await call(['--tool', 'evidence', '--pay', 'tempo', '--yes'], tempoEnv());
    expect(result.err).toBe('');
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/You pay\s+0\.002 USDC\.e on Tempo/);
    expect(result.out).toContain('Account     anyfare.near');
    expect(result.out).toContain('You paid in USDC.e on Tempo. Anyfare paid the evidence API in USDC on NEAR from its own wallet.');
    const paid = fake.mppRequests();
    expect(paid).toHaveLength(1);
    expect(paid[0]?.method).toBe('POST');
    expect(paid[0]?.path).toBe(routedPath(EVIDENCE_URL));
    expect(paid[0]?.body).toBe('{"accountId":"anyfare.near"}');
    expect(paid[0]?.headers['content-type']).toBe('application/json');
  });

  it('asks before it signs, and signs and sends nothing on a "no"', async () => {
    const result = await call(['--tool', '3route', '--pay', 'tempo'], tempoEnv(), { isTerminal: true, input: 'n\n' });
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/The charge closes in 5 minutes\.\n\nPay 0\.0012 USDC\.e on Tempo/);
    expect(result.out).toContain(`Pay 0.0012 USDC.e on Tempo to ${FAKE_TEMPO_RECIPIENT}, plus a network fee of at most $0.01? [y/N]`);
    expect(result.out).not.toContain('Signing');
    expect(result.err).toBe('✘ Nothing was signed or sent. Not charged.\n');
    expect(rpc.calls).toEqual([]);
    expect(fake.mppRequests()).toEqual([]);
  });

  it('pays on a "yes" at the prompt', async () => {
    const result = await call(['--tool', '3route', '--pay', 'tempo'], tempoEnv(), { isTerminal: true, input: 'y\n' });
    expect(result.code).toBe(0);
    expect(fake.mppRequests()).toHaveLength(1);
  });

  it('is a usage error without --yes and without a terminal, before any request', async () => {
    const result = await call(['--tool', '3route', '--pay', 'tempo'], tempoEnv());
    expect(result.code).toBe(2);
    expect(result.err).toBe('✘ call asks before it pays. Add --yes to pay without a terminal\n');
    expect(fake.requests).toEqual([]);
    expect(result.calls).toEqual([]);
    expect(rpc.calls).toEqual([]);
  });

  it('refuses an amount over the cap: nothing signed, nothing sent', async () => {
    const result = await payTempo({ MAX_PAYMENT_USD: '0.0011' });
    expect(result.code).toBe(1);
    expect(result.err).toBe('✘ Anyfare asks 0.0012 USDC.e on Tempo, above your cap MAX_PAYMENT_USD of $0.0011. Not charged.\n');
    expect(result.out).not.toContain('Signing');
    expect(rpc.calls).toEqual([]);
    expect(fake.mppRequests()).toEqual([]);
    // The only routed request is the plan's unpaid one
    expect(fake.routed()).toHaveLength(1);
  });

  it('refuses a charge at the cap, which leaves nothing for the network fee, before anything is signed', async () => {
    const result = await payTempo({ MAX_PAYMENT_USD: '0.0012' });
    expect(result.code).toBe(1);
    expect(result.err).toBe(
      '✘ Anyfare asks 0.0012 USDC.e on Tempo, all of your cap MAX_PAYMENT_USD of $0.0012, with nothing left for the network fee. Not charged.\n',
    );
    expect(rpc.calls).toEqual([]);
    expect(fake.mppRequests()).toEqual([]);
  });

  it('asks for no more fee than the cap leaves, and refuses a signed fee that would go past the cap', async () => {
    // $0.00005 is left for the fee; the node fills one of up to $0.000069
    const result = await call(['--tool', '3route', '--pay', 'tempo'], { ...tempoEnv(), MAX_PAYMENT_USD: '0.00125' }, { isTerminal: true, input: 'y\n' });
    expect(result.out).toMatch(/Network fee {6}at most \$0\.00005, in USDC\.e on Tempo\n/);
    expect(result.out).toContain(`, plus a network fee of at most $0.00005? [y/N]`);
    expect(result.code).toBe(1);
    expect(result.err).toBe(
      '✘ The signed payment pays 0.0012 USDC.e on Tempo and a network fee of up to $0.000069, $0.001269 in all, above your cap MAX_PAYMENT_USD of $0.00125. Nothing was sent. Not charged.\n',
    );
    expect(result.out).not.toContain('Calling');
    expect(fake.mppRequests()).toEqual([]);
  });

  it('pays a charge and its highest fee at the cap', async () => {
    const result = await payTempo({ MAX_PAYMENT_USD: '0.001269' });
    expect(result.err).toBe('');
    expect(result.code).toBe(0);
    expect(fake.mppSettled).toHaveLength(1);
  });

  it('marks the Tempo charge with --explain, and shows where the payment goes', async () => {
    const result = await call(['--tool', '3route', '--pay', 'tempo', '--explain', '--yes'], tempoEnv());
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/0\.0012 USDC\.e on Tempo \(MPP charge\)\s+--pay tempo\s+← you pay this one/);
    expect(result.out).toMatch(
      /You pay\s+0\.0012 USDC\.e on Tempo\n\s+To\s+0x0{38}e7\n\s+From\s+0x[0-9a-fA-F]{40}\n\s+Network fee\s+at most \$0\.01, in USDC\.e on Tempo\n {2}The charge closes in 5 minutes\.\n/,
    );
    expect(result.out).not.toContain('The API asks');
  });

  it('shows one "You pay" with --explain: the quote block has the quote, the payer block has the payment and the fee', async () => {
    const result = await call(['--tool', '3route', '--pay', 'tempo', '--explain', '--yes'], tempoEnv());
    const { out } = result;
    expect(out.match(/You pay/g)).toHaveLength(1);
    expect(out).not.toMatch(/You pay\s+\$/);
    expect(out).toMatch(/\n {2}Anyfare's quote {2}\$0\.0012\n/);
    // One width for the whole block: that of "Network fee"
    expect(out).toMatch(
      /\n\n {2}You pay {6}0\.0012 USDC\.e on Tempo\n {2}To {11}0x0{38}e7\n {2}From {9}0x[0-9a-fA-F]{40}\n {2}Network fee {2}at most \$0\.01, in USDC\.e on Tempo\n {2}The charge closes in 5 minutes\.\n/,
    );
  });
});

describe('call --pay tempo: the charge, before anything is signed', () => {
  const refusal = (why: string): string => `✘ Anyfare's USDC.e on Tempo charge ${why}, so the app won't sign it. Not charged.\n`;
  const NO_OFFER = '✘ Anyfare offers no USDC.e on Tempo for this call now. Not charged.\n';

  it.each<[string, Partial<FakeTempoCharge> | undefined, () => string]>([
    ['another currency', { currency: PATH_USD }, () => NO_OFFER],
    ['another chain', { methodDetails: { chainId: 42431 } }, () => NO_OFFER],
    ['splits', { methodDetails: { splits: [{ amount: '100', recipient: OTHER }] } }, () => refusal('splits the payment with other recipients')],
    ['an expired challenge', { expiresInMs: -60_000 }, () => refusal('has expired')],
    ['another realm', { realm: 'pay.example.test' }, () => refusal(`is for pay.example.test, not ${payHost()}`)],
    ['no recipient', { recipient: null }, () => refusal('names no recipient this app can read')],
    ['no Tempo offer', undefined, () => NO_OFFER],
    ['a fee payer', { methodDetails: { feePayer: true } }, () => refusal('asks for a fee payer')],
    ['push mode only', { methodDetails: { supportedModes: ['push'] } }, () => refusal('takes no signed transaction for Anyfare to broadcast')],
    ['a swap route', { methodDetails: { machineTokenEnabled: true } }, () => refusal('asks for a swap in place of a transfer')],
    ['a charge open for 11 minutes', { expiresInMs: 11 * 60_000 }, () => refusal('stays open for more than 10 minutes')],
    ['a charge with no expiry', { expiresInMs: null }, () => refusal('has no expiry')],
  ])('refuses %s, and signs and sends nothing', async (_what, change, line) => {
    const route = tempoTargets()['3route'];
    fake.addTarget(change === undefined ? { ...route, mpp: undefined } : { ...route, mpp: { amount: '1200', ...change } });
    const result = await payTempo();
    expect(result.code).toBe(1);
    expect(result.err).toBe(line());
    expect(result.out).not.toContain('Signing');
    // Nothing was even prepared: the RPC was never asked
    expect(rpc.calls).toEqual([]);
    expect(fake.mppRequests()).toEqual([]);
  });

  it('refuses a charge it would not sign before it reads the wallet', async () => {
    fake.addTarget({ ...tempoTargets()['3route'], mpp: { amount: '1200', methodDetails: { splits: [{ amount: '100', recipient: OTHER }] } } });
    const result = await call(['--tool', '3route', '--pay', 'tempo', '--yes']);
    expect(result.err).toBe(refusal('splits the payment with other recipients'));
  });

  it('pays the USDC.e charge of a 402 that offers another Tempo token too', async () => {
    // As the MPP rail offers each Tempo asset of the platform: pathUSD first, then USDC.e
    fake.addTarget({ ...tempoTargets()['3route'], mpp: [{ amount: '1200', currency: PATH_USD }, { amount: '1200' }] });
    const result = await payTempo();
    expect(result.err).toBe('');
    expect(result.code).toBe(0);
    expect(fake.mppSettled).toHaveLength(1);
    const credential = Credential.deserialize(fake.mppRequests()[0]?.headers['authorization'] ?? '');
    expect(String(credential.challenge.request['currency']).toLowerCase()).toBe(TEMPO_USDCE.toLowerCase());
  });
});

describe('the charge, checked', () => {
  it("takes Anyfare's charge, and what it may leave out or say plainly", () => {
    expect(checkCharge(anyfareCharge(), 'pay.example.test')).toMatchObject({
      micro: 1200n,
      currency: TEMPO_USDCE,
      recipient: FAKE_TEMPO_RECIPIENT,
      what: '0.0012 USDC.e on Tempo',
    });
    expect(() => checkCharge(anyfareCharge({ details: { feePayer: false, supportedModes: ['pull', 'push'] } }), 'pay.example.test')).not.toThrow();
    expect(() => checkCharge(anyfareCharge({ details: { supportedModes: undefined } }), 'pay.example.test')).not.toThrow();
    const tenMinutes = anyfareCharge({ top: { expires: new Date(Date.now() + 10 * 60_000).toISOString() } });
    expect(() => checkCharge(tenMinutes, 'pay.example.test', Date.now())).not.toThrow();
  });

  it.each<[string, Parameters<typeof anyfareCharge>[0], string]>([
    ['another chain', { details: { chainId: 1 } }, 'is not on Tempo'],
    ['no chain', { details: { chainId: undefined } }, 'is not on Tempo'],
    ['pathUSD', { request: { currency: PATH_USD } }, 'is not in the known USDC.e of Tempo'],
    ['a zero amount', { request: { amount: '0' } }, 'has no amount this app can read'],
    ['a decimal amount', { request: { amount: '0.0012' } }, 'has no amount this app can read'],
    ['an amount that is a number', { request: { amount: 1200 } }, 'has no amount this app can read'],
    ['no recipient', { request: { recipient: undefined } }, 'names no recipient this app can read'],
    ['a recipient that is not an address', { request: { recipient: 'pay.anyfare.near' } }, 'names no recipient this app can read'],
    ['splits', { details: { splits: [{ amount: '100', recipient: OTHER }] } }, 'splits the payment with other recipients'],
    ['a fee payer', { details: { feePayer: true } }, 'asks for a fee payer'],
    ['a swap route', { details: { machineTokenEnabled: true } }, 'asks for a swap in place of a transfer'],
    ['push mode only', { details: { supportedModes: ['push'] } }, 'takes no signed transaction for Anyfare to broadcast'],
    ['no expiry', { top: { expires: undefined } }, 'has no expiry'],
    ['an expiry a second ago', { top: { expires: new Date(Date.now() - 1000).toISOString() } }, 'has expired'],
    ['an expiry 11 minutes ahead', { top: { expires: new Date(Date.now() + 11 * 60_000).toISOString() } }, 'stays open for more than 10 minutes'],
    ['another realm', { top: { realm: 'pay.example.invalid' } }, 'is for pay.example.invalid, not pay.example.test'],
    ['another method', { top: { method: 'stripe' } }, 'is not a Tempo charge'],
    ['a session', { top: { intent: 'session' } }, 'is not a Tempo charge'],
    ['method details that are not an object', { request: { methodDetails: 'pull' } }, 'has method details that are not an object'],
  ])('refuses %s', (_what, change, why) => {
    let stop: unknown;
    try {
      checkCharge(anyfareCharge(change), 'pay.example.test');
    } catch (error) {
      stop = error;
    }
    expect(stop).toBeInstanceOf(Stop);
    expect((stop as Stop).notCharged).toBe(true);
    expect((stop as Stop).message).toBe(`Anyfare's USDC.e on Tempo charge ${why}, so the app won't sign it.`);
  });

  it("refuses an expiry it can't read, and a charge with no request", () => {
    expect(() => checkCharge({ ...anyfareCharge(), expires: 'soon' }, 'pay.example.test')).toThrow("has an expiry this app can't read");
    for (const raw of ['Payment', null, { ...anyfareCharge(), request: 'eyJ9' }]) {
      expect(() => checkCharge(raw, 'pay.example.test')).toThrow("Anyfare's USDC.e on Tempo charge has no request this app can read, so the app won't sign it.");
    }
  });

  const planOf = (challenges: readonly Challenge.Challenge[]): Plan => {
    const offers = challenges.map(
      (raw): Offer => ({ protocol: 'mpp', scheme: 'charge', method: 'tempo', network: 'eip155:4217', asset: String(raw.request['currency']), amount: 1200n, raw }),
    );
    return { config: { payUrl: 'https://pay.example.test' }, anyfare: { kind: 'ok', value: { status: 402, offers } } } as unknown as Plan;
  };

  it('refuses a 402 that offers a Tempo charge twice, and picks the one it offers', () => {
    expect(() => chooseTempo(planOf([anyfareCharge(), anyfareCharge({ request: { amount: '1300' } })]))).toThrow(
      "Anyfare offers USDC.e on Tempo more than once for this call, so the app can't tell which one to pay.",
    );
    const charge = anyfareCharge();
    // The 402's own charge, as it gave it, is what gets signed; the realm is the pay URL's host
    expect(chooseTempo(planOf([charge])).challenge).toBe(charge);
    expect(() => chooseTempo(planOf([]))).toThrow('Anyfare offers no USDC.e on Tempo for this call now.');
  });

  it('picks the USDC.e charge of a 402 that offers another Tempo token too', () => {
    const usdce = anyfareCharge();
    expect(chooseTempo(planOf([anyfareCharge({ request: { currency: PATH_USD } }), usdce])).challenge).toBe(usdce);
    expect(() => chooseTempo(planOf([anyfareCharge({ request: { currency: PATH_USD } })]))).toThrow('Anyfare offers no USDC.e on Tempo for this call now.');
  });

  it('says how long a signed payment can stay valid', () => {
    expect([1, 45, 60, 299, 300, 301].map(windowText)).toEqual(['1 second', '45 seconds', '1 minute', '5 minutes', '5 minutes', '6 minutes']);
  });
});

describe('call --pay tempo: the wallet', () => {
  it('needs TEMPO_PRIVATE_KEY, and says so in one line', async () => {
    const result = await call(['--tool', '3route', '--pay', 'tempo', '--yes'], { TEMPO_RPC_URL: rpc.url });
    expect(result.code).toBe(1);
    expect(result.err).toBe(
      '✘ TEMPO_PRIVATE_KEY is not set. Add it to .env.local. It is the private key of the wallet that pays USDC.e on Tempo: 0x and 64 hex digits.\n',
    );
    expect(rpc.calls).toEqual([]);
    expect(fake.mppRequests()).toEqual([]);
  });

  it.each([
    ['too short', '0xc0ffee', 'is not a private key: it is 0x and 64 hex digits'],
    ['without 0x', TEMPO_KEY.slice(2), 'is not a private key: it is 0x and 64 hex digits'],
    ['not hex', `0x${'q'.repeat(64)}`, 'is not a private key: it is 0x and 64 hex digits'],
    ['with a space in it', `${TEMPO_KEY.slice(0, 30)} ${TEMPO_KEY.slice(30)}`, 'is not a private key: it is 0x and 64 hex digits'],
    ['zero, which is no key', `0x${'0'.repeat(64)}`, 'is not a valid private key'],
  ])('refuses a TEMPO_PRIVATE_KEY that is %s in one line, without quoting it', async (_what, value, reason) => {
    const result = await payTempo({ TEMPO_PRIVATE_KEY: value });
    expect(result.code).toBe(1);
    expect(result.err).toBe(`✘ TEMPO_PRIVATE_KEY ${reason}. Check .env.local.\n`);
    expect(result.err).not.toContain(value.replace(/^0x/, '').slice(0, 8));
    expect(rpc.calls).toEqual([]);
    expect(fake.mppRequests()).toEqual([]);
  });

  it('takes a TEMPO_RPC_URL over https only, or http to this machine, and never one with a user name', async () => {
    const rule = '✘ TEMPO_RPC_URL must be an https:// URL, or http:// to 127.0.0.1 or localhost. Check .env.local.\n';
    for (const url of ['ftp://rpc.example.test/?key=made-up', 'http://rpc.example.test/made-up-key', 'http://127.0.0.2:3030', 'not a url']) {
      const refused = await payTempo({ TEMPO_RPC_URL: url });
      expect(refused.err).toBe(rule);
      expect(refused.err).not.toContain('made-up');
    }
    const withCredentials = await payTempo({ TEMPO_RPC_URL: 'https://made-up-user:made-up-pass@rpc.example.test/' });
    expect(withCredentials.err).toBe(
      "✘ TEMPO_RPC_URL can't carry a user name or password: put an API key in its path or query. Check .env.local.\n",
    );
    // Taken, then not reached: no host but 127.0.0.1 answers here
    const https = await payTempo({ TEMPO_RPC_URL: 'https://rpc.example.test/made-up-key' });
    expect(https.err).toBe(
      '✘ Could not sign the payment: the Tempo RPC at rpc.example.test could not be reached (ENOTFOUND). Nothing was sent. Not charged.\n',
    );
    expect(https.out).toContain('▸ Signing 0.0012 USDC.e on Tempo');
    expect(https.out).not.toContain('Calling');
    expect(fake.mppRequests()).toEqual([]);
  });

  it("uses the chain's own RPC when TEMPO_RPC_URL is not set, and names it by its host", async () => {
    expect(readTempoWallet({ TEMPO_PRIVATE_KEY: TEMPO_KEY })).toMatchObject({ rpcUrl: 'https://rpc.tempo.xyz', rpcHost: 'rpc.tempo.xyz', payer: TEMPO_PAYER });
    const result = await call(['--tool', '3route', '--pay', 'tempo', '--yes'], { TEMPO_PRIVATE_KEY: TEMPO_KEY });
    expect(result.err).toBe('✘ Could not sign the payment: the Tempo RPC at rpc.tempo.xyz could not be reached (ENOTFOUND). Nothing was sent. Not charged.\n');
  });
});

describe('call --pay tempo: the Tempo RPC, failing', () => {
  // Made up: a key of the RPC's own, in its path and in its query
  const KEYED = '/made-up-path-Wq3/v3?made-up-query=Zr8LmQ';
  const KEYED_PARTS = ['made-up-path', 'Wq3', '/v3', 'made-up-query', 'Zr8LmQ', '?'];
  const rpcHost = (): string => new URL(rpc.url).host;

  /** A port of 127.0.0.1 that nothing listens on: a connection to it is refused. */
  async function closedPort(): Promise<number> {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return port;
  }

  it('names the RPC by its host only when it answers 503, with a key in its path and query', async () => {
    rpc.failing = { status: 503 };
    const result = await payTempo(tempoEnv(KEYED));
    expect(result.code).toBe(1);
    expect(result.err).toBe(`✘ Could not sign the payment: the Tempo RPC at ${rpcHost()} answered 503. Nothing was sent. Not charged.\n`);
    for (const part of KEYED_PARTS) expect(`${result.out}${result.err}`).not.toContain(part);
    expect(rpc.calls.length).toBeGreaterThan(0);
    for (const item of rpc.calls) expect(item.path).toBe(KEYED);
    expect(fake.mppRequests()).toEqual([]);
  });

  it('says when the RPC refuses the connection, by its host', async () => {
    const port = await closedPort();
    const result = await payTempo({ TEMPO_RPC_URL: `http://127.0.0.1:${port}${KEYED}` });
    expect(result.err).toBe(
      `✘ Could not sign the payment: the Tempo RPC at 127.0.0.1:${port} could not be reached (ECONNREFUSED). Nothing was sent. Not charged.\n`,
    );
    for (const part of KEYED_PARTS) expect(`${result.out}${result.err}`).not.toContain(part);
  });

  const WOULD_FAIL = (): string =>
    `✘ Could not sign the payment: the Tempo RPC at ${rpcHost()} says the transfer would fail, such as for a balance too low. Nothing was sent. Not charged.\n`;

  it('says the transfer would fail when the node refuses to fill it with a revert, as for a balance too low', async () => {
    rpc.errors['eth_fillTransaction'] = { code: 3, message: 'execution reverted: insufficient balance' };
    const result = await payTempo();
    expect(result.err).toBe(WOULD_FAIL());
    expect(rpc.sent()).toEqual([]);
    expect(fake.mppRequests()).toEqual([]);
  });

  // With the fill refused, the client estimates the gas itself, and viem wraps any failure of the estimate alike
  it.each<[string, () => void, () => string]>([
    ['a revert', () => (rpc.errors['eth_estimateGas'] = { code: 3, message: 'execution reverted: insufficient balance' }), WOULD_FAIL],
    [
      'an HTTP 429',
      () => (rpc.failing = { status: 429, only: 'eth_estimateGas' }),
      () => `✘ Could not sign the payment: the Tempo RPC at ${rpcHost()} answered 429. Nothing was sent. Not charged.\n`,
    ],
    [
      'a JSON-RPC rate limit',
      () => (rpc.errors['eth_estimateGas'] = { code: -32005, message: 'Too many requests, slow down' }),
      () => `✘ Could not sign the payment: the Tempo RPC at ${rpcHost()} answered with an error. Nothing was sent. Not charged.\n`,
    ],
  ])('answers a gas estimate that fails with %s with its own line', async (_what, failure, line) => {
    rpc.fill = 'refused';
    failure();
    const result = await payTempo();
    expect(result.err).toBe(line());
    expect(rpc.calls.some((item) => item.method === 'eth_estimateGas')).toBe(true);
    expect(fake.mppRequests()).toEqual([]);
  });

  it('gives up on an RPC that never answers, after the time limit, naming its host only', async () => {
    rpc.hanging = true;
    const { fetch } = forwardingFetch(toolRoutes());
    const io = captureIo(fetch, { ANYFARE_API_URL: fake.apiUrl, ANYFARE_PAY_URL: fake.payUrl, ...tempoEnv(KEYED) }, { appDir: app.dir });
    const ctx = createContext(io.io);
    const started = Date.now();
    let stop: unknown;
    try {
      await callWithTempo(ctx, { args: DEFAULT_ARGS['3route'], explain: false, yes: true }, { signingMs: 400 });
    } catch (error) {
      stop = error;
    } finally {
      ctx.close();
    }
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(stop).toBeInstanceOf(Stop);
    const line = (stop as Stop).line();
    expect(line).toBe(`Could not sign the payment: the Tempo RPC at ${rpcHost()} did not answer in 400 ms. Nothing was sent. Not charged.`);
    for (const part of KEYED_PARTS) expect(`${io.out()}${line}`).not.toContain(part);
    expect(rpc.calls.length).toBeGreaterThan(0);
    expect(fake.mppRequests()).toEqual([]);
    // The read it gave up on is ended now, not at viem's own limit of 10 seconds
    await vi.waitFor(() => expect(rpc.abandoned).toBe(rpc.calls.length), { timeout: 1_000 });
  });

  it('follows no redirect of the RPC, which could send its reads to another host', async () => {
    rpc.redirecting = '/elsewhere';
    const result = await payTempo();
    expect(result.err).toBe(
      `✘ Could not sign the payment: the Tempo RPC at ${rpcHost()} could not be reached (unexpected redirect). Nothing was sent. Not charged.\n`,
    );
    expect(rpc.calls.some((item) => item.path === '/elsewhere')).toBe(false);
    expect(fake.mppRequests()).toEqual([]);
  });

  it('exits as soon as it has said why, with the RPC still not answering', async () => {
    rpc.hanging = true;
    const child = spawn(process.execPath, [new URL('./children/giveUpOnTempoRpc.ts', import.meta.url).pathname], {
      env: { PATH: process.env['PATH'] ?? '', ANYFARE_API_URL: fake.apiUrl, ANYFARE_PAY_URL: fake.payUrl, ...tempoEnv(KEYED) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let err = '';
    child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
    child.stdout.resume();
    const started = Date.now();
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
    // viem's own time limit for each request is 10 seconds: the process does not wait for it
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(code).toBe(1);
    expect(err).toContain('did not answer in 400 ms. Nothing was sent. Not charged.');
    expectNoKeyIn(err);
    for (const part of KEYED_PARTS) expect(err).not.toContain(part);
    expect(fake.mppRequests()).toEqual([]);
  }, 30_000);
});

describe('the Tempo signer, failing', () => {
  const url = 'https://rpc.example.test/made-up-path-Wq3/v3?made-up-query=Zr8LmQ';
  const wallet = () => readTempoWallet({ TEMPO_PRIVATE_KEY: TEMPO_KEY, TEMPO_RPC_URL: url });

  it.each<[string, unknown, string]>([
    ['an HTTP error', new HttpRequestError({ url, status: 401, body: { method: 'eth_estimateGas' }, details: `Invalid key in ${url}` }), 'the Tempo RPC at rpc.example.test answered 401'],
    ["viem's time limit", new TimeoutError({ url, body: { method: 'eth_chainId' } }), 'the Tempo RPC at rpc.example.test did not answer in time'],
    ['a JSON-RPC error that quotes the URL', new RpcRequestError({ url, body: {}, error: { code: -32000, message: `bad request to ${url}` } }), 'the Tempo RPC at rpc.example.test answered with an error'],
    ['a fetch that failed with words naming the URL', new TypeError('fetch failed', { cause: new Error(`connect to ${url} failed`) }), 'the Tempo RPC at rpc.example.test could not be reached'],
    ['a fetch that was refused', new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'ECONNREFUSED' }) }), 'the Tempo RPC at rpc.example.test could not be reached (ECONNREFUSED)'],
    ["the client's own refusal, quoting the URL", new Error(`Challenge does not support pull mode at ${url}.`), 'the MPP client refused to sign it'],
  ])('says %s in a fixed line, naming the host only', (_what, error, line) => {
    expect(tempoSigningFailure(error, wallet())).toBe(line);
  });
});

/** The same credential with its transaction changed, and signed again, by `by`. */
async function resign(header: string, change: Record<string, unknown>, by: PrivateKeyAccount = ACCOUNT): Promise<string> {
  const credential = Credential.deserialize(header);
  const payload = credential.payload as { readonly signature: Hex; readonly type: string };
  const { signature: _signature, from: _from, ...unsigned } = Transaction.deserialize(payload.signature) as unknown as Record<string, unknown>;
  const signature = await by.signTransaction({ ...unsigned, ...change } as never, { serializer: Transaction.serialize as never });
  return Credential.serialize({ ...credential, payload: { ...payload, signature } });
}

describe('what was signed, before it is sent', () => {
  let chosen: TempoChoice;
  let header: string;
  beforeAll(async () => {
    rpc.reset();
    chosen = checkCharge(anyfareCharge(), 'pay.example.test');
    header = await signCredential(directFetch, chosen, readTempoWallet(tempoEnv()));
  });
  const refused = (value: string): string => {
    try {
      checkCredential(value, chosen, TEMPO_PAYER, 20_000n);
    } catch (error) {
      expect(error).toBeInstanceOf(Stop);
      expect((error as Stop).notCharged).toBe(true);
      return (error as Stop).message;
    }
    return 'not refused';
  };
  const line = (why: string): string => `The signed payment is not the one the app chose: ${why}. Nothing was sent.`;
  const now = (): number => Math.floor(Date.now() / 1000);

  it('takes the credential the client made for the chosen charge', () => {
    expect(refused(header)).toBe('not refused');
  });

  it('refuses a credential that is not one, a push credential, and one for another charge', () => {
    const credential = Credential.deserialize(header);
    expect(refused(`Bearer ${header.slice('Payment '.length)}`)).toBe(line('it is not an MPP credential'));
    expect(refused('Payment not-base64-json')).toBe(line('it is not an MPP credential'));
    // mppx reads these, but they are not what its client makes, nor what was checked
    expect(refused(header.replace('Payment ', 'payment '))).toBe(line('it is not an MPP credential'));
    expect(refused(header.replace('Payment ', 'Payment  '))).toBe(line('it is not an MPP credential'));
    const push = Credential.serialize({ ...credential, payload: { type: 'hash', hash: `0x${'1'.repeat(64)}` } });
    expect(refused(push)).toBe(line('it is not a transaction signed for Anyfare to broadcast'));
    // The same signed transaction, said to be another kind of payload
    const proof = Credential.serialize({ ...credential, payload: { ...(credential.payload as object), type: 'proof' } });
    expect(refused(proof)).toBe(line('it is not a transaction signed for Anyfare to broadcast'));
    const other = Credential.serialize({ ...credential, challenge: anyfareCharge({ request: { amount: '1300' } }) });
    expect(refused(other)).toBe(line('it answers another charge'));
    const garbled = Credential.serialize({ ...credential, payload: { type: 'transaction', signature: '0x76c0ffee' } });
    expect(refused(garbled)).toBe(line("its transaction can't be read"));
    const notHex = Credential.serialize({ ...credential, payload: { type: 'transaction', signature: 'a signed transaction' } });
    expect(refused(notHex)).toBe(line("its transaction can't be read"));
  });

  it.each<[string, () => Record<string, unknown>, string]>([
    ['for another chain', () => ({ chainId: 42431 }), 'it is signed for another chain'],
    ['valid for an hour', () => ({ validBefore: now() + 3600 }), 'it stays valid longer than the charge'],
    ['valid only from 20 seconds from now', () => ({ validAfter: now() + 20 }), 'it only becomes valid later'],
    ['with a fee payer', () => ({ feePayer: true }), 'it has a fee payer'],
    [
      'to another recipient',
      () => ({ calls: [{ to: TEMPO_USDCE, data: encodeFunctionData({ abi: Abis.tip20, functionName: 'transfer', args: [OTHER, 1200n] }) }] }),
      'it pays another recipient',
    ],
  ])('refuses a transaction signed again %s', async (_what, change, why) => {
    expect(refused(await resign(header, change()))).toBe(line(why));
  });

  it('refuses a transaction signed by another key', async () => {
    expect(refused(await resign(header, {}, privateKeyToAccount(generatePrivateKey())))).toBe(line('it pays from another address'));
  });

  // A decoded transaction as the client signs one, at a made-up time of today
  const NOW = 1_794_200_000;
  const memo = `0x${'ef'.repeat(32)}` as Hex;
  const transferData = (to: string = FAKE_TEMPO_RECIPIENT, amount = 1200n): Hex =>
    encodeFunctionData({ abi: Abis.tip20, functionName: 'transferWithMemo', args: [to as Hex, amount, memo] });
  const good = (): Record<string, unknown> => ({
    type: 'tempo',
    chainId: 4217,
    from: TEMPO_PAYER.toLowerCase(),
    calls: [{ to: TEMPO_USDCE.toLowerCase(), data: transferData() }],
    validBefore: NOW + 25,
    validAfter: NOW - 3600,
    feePayerSignature: undefined,
    feeToken: TEMPO_USDCE.toLowerCase(),
    gas: 57_000n,
    maxFeePerGas: 1_200_000_000n,
  });
  const charge = { currency: TEMPO_USDCE, recipient: FAKE_TEMPO_RECIPIENT, micro: 1200n, expiresMs: (NOW + 300) * 1000 };
  const transferRefusal = (transaction: Record<string, unknown>): string => {
    try {
      checkTransfer(transaction, charge, TEMPO_PAYER, NOW, (why: string): never => {
        throw new Stop(why);
      });
    } catch (error) {
      return (error as Stop).message;
    }
    return 'not refused';
  };

  it('takes one transfer of the amount of USDC.e to the recipient, with or without a memo', () => {
    expect(transferRefusal(good())).toBe('not refused');
    const plain = encodeFunctionData({ abi: Abis.tip20, functionName: 'transfer', args: [FAKE_TEMPO_RECIPIENT, 1200n] });
    expect(transferRefusal({ ...good(), calls: [{ to: TEMPO_USDCE, data: plain }] })).toBe('not refused');
    // Valid until a minute past the charge, and from a moment ahead of this clock
    expect(transferRefusal({ ...good(), validBefore: NOW + 360, validAfter: NOW + 5 })).toBe('not refused');
  });

  it.each<[string, Record<string, unknown>, string]>([
    ['another type', { type: 'eip1559' }, 'it is not a Tempo transaction'],
    ['another chain', { chainId: 42431 }, 'it is signed for another chain'],
    ['from another address', { from: OTHER }, 'it pays from another address'],
    ['with a fee payer to come', { feePayerSignature: null }, 'it has a fee payer'],
    ['with a fee payer signed', { feePayerSignature: { r: '0x1', s: '0x2', yParity: 0 } }, 'it has a fee payer'],
    ['with a key authorization', { keyAuthorization: { expiry: NOW + 86_400 } }, 'it authorizes more than the transfer'],
    ['with an authorization list', { authorizationList: [{ address: OTHER, chainId: 4217, nonce: 0n }] }, 'it authorizes more than the transfer'],
    ['two calls', { calls: [{ to: TEMPO_USDCE, data: transferData() }, { to: TEMPO_USDCE, data: transferData() }] }, 'it is not one transfer'],
    ['no calls', { calls: [] }, 'it is not one transfer'],
    ['another token', { calls: [{ to: PATH_USD, data: transferData() }] }, 'it calls another contract than USDC.e'],
    ['value beside the transfer', { calls: [{ to: TEMPO_USDCE, data: transferData(), value: 1n }] }, 'it sends value beside the transfer'],
    ['data that is no call', { calls: [{ to: TEMPO_USDCE, data: '0xc0ffee' }] }, "its transfer can't be read"],
    [
      'an approval',
      { calls: [{ to: TEMPO_USDCE, data: encodeFunctionData({ abi: Abis.tip20, functionName: 'approve', args: [OTHER, 1200n] }) }] },
      'it is not one transfer',
    ],
    ['another recipient', { calls: [{ to: TEMPO_USDCE, data: transferData(OTHER) }] }, 'it pays another recipient'],
    ['another amount', { calls: [{ to: TEMPO_USDCE, data: transferData(FAKE_TEMPO_RECIPIENT, 1201n) }] }, 'it pays another amount'],
    ['no expiry', { validBefore: undefined }, 'it never expires'],
    ['an expiry that has passed', { validBefore: NOW }, 'it has expired'],
    ['an expiry past the charge and its minute', { validBefore: NOW + 361 }, 'it stays valid longer than the charge'],
    ['an expiry in 2.85e8 years', { validBefore: 9_000_000_000_000_000 }, 'it stays valid longer than the charge'],
    ['an expiry past what a number holds', { validBefore: 2 ** 60 }, 'it never expires'],
    ['a start an hour ahead', { validAfter: NOW + 3600 }, 'it only becomes valid later'],
    ['a start that is not a number', { validAfter: '0' }, 'it only becomes valid later'],
    ['with its fee in pathUSD', { feeToken: PATH_USD }, 'it pays its network fee in another token than USDC.e'],
    ['with no fee token, for the chain to pick', { feeToken: undefined }, 'it names no token for its network fee'],
  ])('refuses a transaction %s', (_what, change, why) => {
    expect(transferRefusal({ ...good(), ...change })).toBe(why);
  });

  const what = { micro: 1200n, what: '0.0012 USDC.e on Tempo' };
  const feeRefusal = (transaction: Record<string, unknown>, cap = 20_000n): string => {
    try {
      return `fee ${checkFee(transaction, what, cap)}`;
    } catch (error) {
      expect((error as Stop).notCharged).toBe(true);
      return (error as Stop).message;
    }
  };

  it('takes the highest fee in micro-USD, rounded up: gas times the highest price per gas, in attodollars', () => {
    expect(feeRefusal(good())).toBe('fee 69');
    expect(feeRefusal({ ...good(), gas: 1n, maxFeePerGas: 1n })).toBe('fee 1');
    // $0.01 exactly, the most the app lets a fee be
    expect(feeRefusal({ ...good(), gas: 100_000n, maxFeePerGas: 100_000_000_000n })).toBe('fee 10000');
    // The charge and its highest fee at the cap
    expect(feeRefusal(good(), 1269n)).toBe('fee 69');
  });

  it.each<[string, Record<string, unknown>, bigint, string]>([
    [
      'a huge price per gas',
      { gas: 2_005_000n, maxFeePerGas: 2_200_000_000_000_000n },
      20_000n,
      'The signed payment allows a network fee of up to $4411, above the most the app lets a fee be, $0.01. Nothing was sent.',
    ],
    [
      'a huge gas limit',
      { gas: 30_005_000n },
      20_000n,
      'The signed payment allows a network fee of up to $0.036006, above the most the app lets a fee be, $0.01. Nothing was sent.',
    ],
    [
      'a fee a micro-USD over the limit',
      { gas: 100_001n, maxFeePerGas: 100_000_000_000n },
      20_000n,
      'The signed payment allows a network fee of up to $0.010001, above the most the app lets a fee be, $0.01. Nothing was sent.',
    ],
    [
      'a charge and fee over the cap',
      {},
      1268n,
      'The signed payment pays 0.0012 USDC.e on Tempo and a network fee of up to $0.000069, $0.001269 in all, above your cap MAX_PAYMENT_USD of $0.001268. Nothing was sent.',
    ],
    ['no gas', { gas: undefined }, 20_000n, "The signed payment is not the one the app chose: its network fee can't be read. Nothing was sent."],
    ['no price per gas', { maxFeePerGas: undefined }, 20_000n, "The signed payment is not the one the app chose: its network fee can't be read. Nothing was sent."],
  ])('refuses %s', (_what, change, cap, line) => {
    expect(feeRefusal({ ...good(), ...change }, cap)).toBe(line);
  });
});

describe('call --pay tempo: a hostile fill', () => {
  /** The fee token and the highest fee of the transaction that came with the paid request. */
  const sentFee = (): { feeToken: string; fee: bigint } => {
    const payload = Credential.deserialize(fake.mppRequests()[0]?.headers['authorization'] ?? '').payload as { signature: Hex };
    const transaction = Transaction.deserialize(payload.signature) as unknown as { feeToken: string; gas: bigint; maxFeePerGas: bigint };
    return { feeToken: transaction.feeToken.toLowerCase(), fee: transaction.gas * transaction.maxFeePerGas };
  };

  it.each<[string, Readonly<Record<string, unknown>>, string]>([
    // 2,000,000 gas at 2 × 10^15 attodollars: viem raises the price by a fifth and the client adds 5,000 gas, $4,812
    ['a huge price per gas', { gas: '0x1e8480', maxFeePerGas: '0x71afd498d0000' }, '$4812'],
    ['a huge gas limit', { gas: '0x1c9c380' }, '$0.036006'],
  ])('is refused before anything is sent: %s', async (_what, change, fee) => {
    rpc.fill = change;
    const result = await payTempo();
    expect(result.code).toBe(1);
    expect(result.err).toBe(
      `✘ The signed payment allows a network fee of up to ${fee}, above the most the app lets a fee be, $0.01. Nothing was sent. Not charged.\n`,
    );
    expect(result.out).not.toContain('Calling');
    expect(fake.mppRequests()).toEqual([]);
    expect(rpc.sent()).toEqual([]);
  });

  it('can choose no other fee token: the client asks for USDC.e, and takes none from the fill', async () => {
    rpc.fill = { feeToken: PATH_USD };
    const result = await payTempo();
    expect(result.code).toBe(0);
    expect(sentFee().feeToken).toBe(TEMPO_USDCE.toLowerCase());
  });

  it('is refused when it adds a fee payer, whose fee token the client would take', async () => {
    rpc.fill = { feeToken: PATH_USD, feePayerSignature: { r: `0x${'1'.repeat(64)}`, s: `0x${'2'.repeat(64)}`, yParity: '0x0' } };
    const result = await payTempo();
    expect(result.code).toBe(1);
    expect(result.err).toBe('✘ The signed payment is not the one the app chose: it has a fee payer. Nothing was sent. Not charged.\n');
    expect(fake.mppRequests()).toEqual([]);
  });

  it('is paid with the honest fill: a fee in USDC.e of well under a tenth of a cent', async () => {
    const result = await payTempo();
    expect(result.code).toBe(0);
    expect(sentFee()).toEqual({ feeToken: TEMPO_USDCE.toLowerCase(), fee: (HONEST_GAS + 5_000n) * ((HONEST_MAX_FEE_PER_GAS * 12n) / 10n) });
  });
});

describe("call --pay tempo: Anyfare's answers", () => {
  const envelope = (code: string, message: string) => ({ error: { code, message } });

  it('says when Anyfare could not take the payment now, not charged', async () => {
    fake.nextMpp = 'payment_unavailable';
    const result = await payTempo();
    expect(result.code).toBe(1);
    expect(result.err).toMatch(
      /^✘ Anyfare couldn't take the Tempo payment now, so nothing was paid; retry in a moment \(request req-made-up-\d+\)\. Not charged\.\n$/,
    );
    expect(fake.mppRequests()).toHaveLength(1);
    expect(fake.mppSettled).toEqual([]);
  });

  it('never says "Not charged" when the settlement failed, and says how to check', async () => {
    fake.nextMpp = 'settlement_failed';
    const result = await payTempo();
    expect(result.code).toBe(1);
    const line = `✘ The payment couldn't be settled, so the answer was not sent. Whether your transaction landed on Tempo is not known: ${check()}`;
    expect(result.err.startsWith(line)).toBe(true);
    expect(result.err.slice(line.length)).toMatch(/^ \(request req-made-up-\d+\)\.\n$/);
    expect(result.err).not.toContain('Not charged');
    expect(fake.mppRequests()).toHaveLength(1);
  });

  it.each<[string, PaidAnswer, RegExp, boolean]>([
    [
      'payment_invalid',
      { status: 402, body: envelope('payment_invalid', "The Tempo node refused the payment's transaction in simulation, such as for an insufficient balance") },
      /^✘ Anyfare refused the payment, so nothing moved: The Tempo node refused the payment's transaction in simulation, such as for an insufficient balance \(request req-made-up-\d+\)\./,
      true,
    ],
    [
      'payment_invalid for a credential used before',
      { status: 402, body: envelope('payment_invalid', 'This payment credential was already used. Request the resource again, and pay the new challenge.') },
      /^✘ Anyfare says this payment was used before, and took nothing for this request\. Whether the other use was paid is not known: https:\/\/explore\.tempo\.xyz\/address\/0x[0-9a-fA-F]{40} shows your payments/,
      false,
    ],
    ['payment_unavailable', { status: 503, body: envelope('payment_unavailable', 'Made up') }, /^✘ Anyfare couldn't take the Tempo payment now, so nothing was paid; retry in a moment/, true],
    ['settlement_failed', { status: 502, body: envelope('settlement_failed', 'Made up') }, /^✘ The payment couldn't be settled, so the answer was not sent/, false],
    ['upstream_unavailable', { status: 503, body: envelope('upstream_unavailable', 'The upstream is unavailable') }, /^✘ The API or Anyfare's payer failed, so Anyfare never broadcast your payment; retry later/, true],
    ['quote_exceeded', { status: 502, body: envelope('quote_exceeded', 'Made up') }, /^✘ The API asked for more than it quoted, so Anyfare paid nothing/, true],
    ['response_too_large', { status: 502, body: envelope('response_too_large', 'Made up') }, /^✘ The API's answer was too large to hold, so it was not sent/, true],
    ['multiple_payment_methods', { status: 400, body: envelope('multiple_payment_methods', 'Made up') }, /^✘ The request carried more than one payment; send exactly one/, true],
    ['a 402 that asks for a payment again', { status: 402, body: { credits: { price: '0.0012' } } }, /^✘ Anyfare asked for a payment again: the payment was not accepted/, true],
    ["the API's own 404", { status: 404, body: { message: 'No such route' } }, /^✘ 3Route answered 404: \{"message":"No such route"\}/, true],
    ['internal_error', { status: 500, body: envelope('internal_error', 'Made up') }, /^✘ Anyfare answered 500/, false],
    ["a 502 that is not Anyfare's", { status: 502, body: '<html>Bad Gateway</html>' }, /^✘ Anyfare answered 502: <html>Bad Gateway<\/html>/, false],
  ])('answers %s with its line', async (_what, answer, line, notCharged) => {
    fake.nextPaid = answer;
    const result = await payTempo();
    expect(result.code).toBe(1);
    expect(result.err).toMatch(line);
    expect(result.err.split('\n')).toHaveLength(2);
    expect(result.err.endsWith(' Not charged.\n')).toBe(notCharged);
    expect(fake.mppRequests()).toHaveLength(1);
    expect(fake.mppSettled).toEqual([]);
  });
});

describe('call --pay tempo: the proof', () => {
  it('prints the answer of a 2xx without Payment-Receipt, with one warning', async () => {
    fake.nextPaid = { status: 200, noReceipt: true };
    const result = await payTempo();
    expect(result.code).toBe(0);
    expect(result.out).toContain('1 USDC → 0.00025 WETH');
    expect(result.out).not.toContain('transaction');
    expect(result.err).toBe(`No Payment-Receipt came with the answer: ${check()}.\n`);
    expect(result.out).toContain('You paid in USDC.e on Tempo.');
  });

  it('warns about an unreadable Payment-Receipt, and still prints the answer', async () => {
    for (const receipt of ['!!not base64!!', Receipt.serialize({ method: 'stripe', reference: 'made-up', status: 'success', timestamp: new Date().toISOString() })]) {
      fake.nextPaid = { status: 200, headers: { 'payment-receipt': receipt } };
      const result = await payTempo();
      expect(result.code).toBe(0);
      expect(result.out).toContain('1 USDC → 0.00025 WETH');
      expect(result.err).toBe(`The Payment-Receipt that came with the answer is unreadable: ${check()}.\n`);
    }
  });

  it('builds no link for a reference that is not a transaction hash', async () => {
    const receipt = Receipt.serialize({ method: 'tempo', reference: 'made-up-reference', status: 'success', timestamp: new Date().toISOString() });
    fake.nextPaid = { status: 200, headers: { 'payment-receipt': receipt } };
    const result = await payTempo();
    expect(result.code).toBe(0);
    expect(result.out).toContain(`Paid 0.0012 USDC.e on Tempo from ${TEMPO_PAYER}, and a network fee of at most $0.000069: transaction made-up-reference\n`);
    expect(result.out).not.toContain('explore.tempo.xyz/tx');
    expect(result.err).toBe("The Payment-Receipt's reference is not a Tempo transaction hash, so there is no link to it.\n");
  });

  it('warns when the receipt names another transaction than the one signed', async () => {
    const other = `0x${'ab'.repeat(32)}`;
    const receipt = Receipt.serialize({ method: 'tempo', reference: other, status: 'success', timestamp: new Date().toISOString() });
    fake.nextPaid = { status: 200, headers: { 'payment-receipt': receipt } };
    const result = await payTempo({}, { hashes: [other] });
    expect(result.code).toBe(0);
    expect(result.out).toContain(`  https://explore.tempo.xyz/tx/${other}\n`);
    const signed = fake.mppSettled[0]?.transaction;
    expect(result.err).toBe(`The Payment-Receipt names another transaction than the one you signed, ${signed}: ${check()}.\n`);
  });

  it('reads a receipt', () => {
    const timestamp = new Date().toISOString();
    const hash = `0x${'cd'.repeat(32)}`;
    expect(readReceipt(Receipt.serialize({ method: 'tempo', reference: hash, status: 'success', timestamp }))).toEqual({ kind: 'ok', reference: hash });
    expect(readReceipt(null)).toEqual({ kind: 'missing' });
    expect(readReceipt('e30')).toEqual({ kind: 'unreadable' });
    expect(readReceipt(Receipt.serialize({ method: 'tempo', reference: '', status: 'success', timestamp }))).toEqual({ kind: 'unreadable' });
  });
});

describe('call --pay tempo: a paid request that fails on the way', () => {
  /** A fetch like `call`'s, whose paid request fails with `failure` instead of reaching the fake. */
  function failing(failure: () => never) {
    const { fetch } = forwardingFetch(toolRoutes());
    const sent: string[] = [];
    const wrapped = (async (input: string | URL | Request, init?: RequestInit) => {
      if (/^Payment /.test(new Headers(init?.headers).get('authorization') ?? '')) {
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

  it.each(['ECONNREFUSED', 'ENOTFOUND'])('says "Not charged" when no connection was made: %s', async (code) => {
    const { fetch, sent } = failing(networkError(code));
    const result = await payTempo({}, { fetch });
    expect(result.code).toBe(1);
    expect(result.err).toBe(`✘ Could not reach ${payHost()}: ${code}. The request was never sent. Not charged.\n`);
    expect(sent).toHaveLength(1);
  });

  it('says the outcome is not known after a broken connection, and how to check', async () => {
    const { fetch, sent } = failing(networkError('ECONNRESET'));
    const result = await payTempo({}, { fetch });
    expect(result.err).toBe(`✘ Could not reach ${payHost()}: ECONNRESET. Whether the call was paid is not known: ${check()}.\n`);
    expect(sent).toHaveLength(1);
  });

  it('says the call was most likely paid when a 2xx came and its body broke', async () => {
    const { fetch } = forwardingFetch(toolRoutes());
    const wrapped = (async (input: string | URL | Request, init?: RequestInit) => {
      const response = await fetch(input, init);
      if (!/^Payment /.test(new Headers(init?.headers).get('authorization') ?? '')) return response;
      await response.arrayBuffer();
      return brokenAnswer(response.status, 'ECONNRESET', response.headers);
    }) as typeof fetch;
    const result = await payTempo({}, { fetch: wrapped });
    expect(fake.mppSettled).toHaveLength(1);
    expect(result.code).toBe(1);
    expect(result.err).toBe(
      `✘ ${payHost()} answered 200, but its body broke: ECONNRESET. The call was most likely paid, and its answer is lost: ${check()}.\n`,
    );
  });
});

describe('the fake Anyfare checks an MPP credential as the proxy would', () => {
  const link = (): string => routingLink(fake.payUrl, ROUTE_URL);
  const codeOf = async (response: Response): Promise<{ code: string; message: string }> =>
    ((await response.json()) as { error: { code: string; message: string } }).error;

  /** A credential the app's client signs for the fake's own charge of the 3Route link. */
  async function credentialForLink(): Promise<{ header: string; chosen: TempoChoice }> {
    const unpaid = await realFetch(link());
    const [challenge] = Challenge.fromHeadersList(unpaid.headers);
    const chosen = checkCharge(challenge, payHost());
    return { header: await signCredential(directFetch, chosen, readTempoWallet(tempoEnv())), chosen };
  }

  it('takes a good credential once, and refuses it the second time', async () => {
    const { header } = await credentialForLink();
    expect((await realFetch(link(), { headers: { authorization: header } })).status).toBe(200);
    const again = await realFetch(link(), { headers: { authorization: header } });
    expect(again.status).toBe(402);
    expect(await codeOf(again)).toMatchObject({ code: 'payment_invalid', message: expect.stringContaining('already used') });
    expect(fake.mppSettled).toHaveLength(1);
  });

  it('refuses a credential for a charge it did not offer, and a transaction that pays another recipient', async () => {
    const own = checkCharge(anyfareCharge({ top: { realm: payHost() } }), payHost());
    const forged = await signCredential(directFetch, own, readTempoWallet(tempoEnv()));
    const refused = await realFetch(link(), { headers: { authorization: forged } });
    expect(refused.status).toBe(402);
    expect((await codeOf(refused)).code).toBe('payment_invalid');

    const { header } = await credentialForLink();
    const elsewhere = await resign(header, {
      calls: [{ to: TEMPO_USDCE, data: encodeFunctionData({ abi: Abis.tip20, functionName: 'transfer', args: [OTHER, 1200n] }) }],
    });
    const redirected = await realFetch(link(), { headers: { authorization: elsewhere } });
    expect(redirected.status).toBe(402);
    expect(await codeOf(redirected)).toMatchObject({ code: 'payment_invalid', message: 'The transfer pays another recipient' });
    expect(fake.mppSettled).toEqual([]);
  });
});

describe('the check for a key in the output', () => {
  it('finds any part of the test key longer than 4 characters', () => {
    expect(() => expectNoKeyIn(`text ${TEMPO_KEY.slice(20, 25)} text`)).toThrow('a part of the test key');
    expect(() => expectNoKeyIn(`text ${TEMPO_KEY.slice(20, 25).toUpperCase()} text`)).toThrow('a part of the test key');
    expect(() => expectNoKeyIn(`a payer ${TEMPO_PAYER} and nothing else`)).not.toThrow();
  });
});
