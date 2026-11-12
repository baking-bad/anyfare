// NEAR_PRIVATE_KEY never shows in any output, in whole or in part, on any path that prints. Every
// path below runs with the key set; their stdout and stderr are checked together. The key is made in
// the test, in memory only, and holds nothing. Every account, price and balance is made up.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli.ts';
import { NEAR_USDC, startFakeApi } from './fakeApi.ts';
import type { FakeApi, PaidFailure, Unpaid } from './fakeApi.ts';
import { startFakeNearRpc } from './fakeNearRpc.ts';
import type { FakeNearRpc } from './fakeNearRpc.ts';
import { captureIo, expectNoKeyIn, localFetch, nearTestKey } from './helpers.ts';
import type { IoOptions } from './helpers.ts';

const ACCOUNT = 'alice.near';
const API = 'https://api.example.test';
const { secretKey: KEY, publicKey: PUBLIC_KEY } = nearTestKey();
const BODY = KEY.slice('ed25519:'.length);
const option = (change: Record<string, unknown> = {}): Record<string, unknown> => ({
  scheme: 'exact',
  network: 'near:mainnet',
  asset: NEAR_USDC,
  amount: '10000',
  payTo: 'seller.example.near',
  maxTimeoutSeconds: 300,
  extra: {},
  ...change,
});

let api: FakeApi;
let rpc: FakeNearRpc;
beforeAll(async () => {
  [api, rpc] = await Promise.all([startFakeApi(), startFakeNearRpc()]);
  vi.stubGlobal('fetch', localFetch());
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await Promise.all([api.close(), rpc.close()]);
});

describe('the key', () => {
  it('never shows in any output, in whole or in any 12 characters of it', async () => {
    const outputs: string[] = [];
    const codes: number[] = [];
    const run = async (argv: readonly string[], env: Record<string, string> = {}, options: IoOptions = {}): Promise<void> => {
      const io = captureIo(
        localFetch({ [API]: api.url }),
        { NEAR_ACCOUNT_ID: ACCOUNT, NEAR_PRIVATE_KEY: KEY, NEAR_RPC_URL: rpc.url, ...env },
        options,
      );
      codes.push(await runCli(argv, io.io));
      outputs.push(io.out(), io.err());
    };
    const at = (unpaid: Unpaid, path = '/v1/quote'): void => api.route({ method: 'GET', path, unpaid });
    const reset = (): void => {
      api.reset();
      api.chain = rpc;
      rpc.failing = undefined;
      rpc.chainId = 'mainnet';
      rpc.addAccessKey(ACCOUNT, PUBLIC_KEY, 41n);
      // Made up: 0.99 USDC
      rpc.setBalance(ACCOUNT, 990_000n, 1n);
    };
    const transactions: string[] = [];
    const callIds: string[] = [];
    const url = `${API}/v1/quote`;
    // Through Anyfare, with its calls looked up on the fake's /v1/calls
    const throughAnyfare = (): Record<string, string> => ({ ANYFARE_PAY_URL: api.url, ANYFARE_API_URL: api.url, ANYFARE_SITE_URL: 'https://anyfare.example.test' });

    reset();
    // Free, failed and unreachable
    at({ kind: 'answer', answer: { status: 200, body: '{"price":"made up"}' } });
    await run([url]);
    at({ kind: 'answer', answer: { status: 500, contentType: 'text/plain', body: 'Made up' } });
    await run([url]);
    await run(['http://127.0.0.1:9/v1/quote']);
    // An answer that echoes the key, as if a request had carried it
    at({ kind: 'answer', answer: { status: 200, body: JSON.stringify({ echo: KEY, body: BODY }) } });
    await run([url]);
    // Not supported, with and without a hint
    for (const unpaid of [
      { kind: 'x402', accepts: [option({ network: 'eip155:8453' })] },
      { kind: 'x402', accepts: [option({ scheme: 'upto' })] },
      { kind: 'x402', accepts: [option({ asset: 'usdt.tether-token.near' })] },
      { kind: 'mpp' },
      { kind: 'x402', accepts: [option({ maxTimeoutSeconds: 301 })] },
    ] as const) {
      at(unpaid);
      await run(['-X', 'POST', '-H', 'X-Made-Up: 1', url]);
      await run([url]);
    }
    // Anyfare's own error
    at({ kind: 'envelope', status: 400, code: 'host_not_allowed', message: 'Made up' }, '/api.example.test/v1/quote');
    await run([`${api.url}/api.example.test/v1/quote`], { ANYFARE_PAY_URL: api.url });
    // The checks, the dry run and the question
    at({ kind: 'x402', accepts: [option({ amount: '50000' })] });
    await run([url, '--yes']);
    await run([url, '--yes', '--max', '0.03']);
    at({ kind: 'x402', accepts: [option()] });
    await run([url, '--dry-run']);
    await run([url]);
    await run([url], {}, { isTerminal: true, input: 'n\n' });
    rpc.setBalance(ACCOUNT, 1n, 1n);
    await run([url, '--yes']);
    // The settings, wrong in each way, the key in the place of the account included
    for (const env of [
      { NEAR_PRIVATE_KEY: `secp256k1:${BODY}` } as Record<string, string>,
      { NEAR_PRIVATE_KEY: BODY },
      { NEAR_PRIVATE_KEY: `ed25519:${BODY.slice(0, 20)}` },
      { NEAR_PRIVATE_KEY: `ed25519:${BODY}0OIl` },
      { NEAR_ACCOUNT_ID: KEY },
      { NEAR_ACCOUNT_ID: BODY },
    ]) {
      await run([url, '--yes'], env);
      await run([url, '--dry-run'], env);
      await run(['balance'], env);
    }
    // Payments, good and failing in each way
    for (const failure of [
      undefined,
      'in_flight',
      'used_before',
      'payment_unavailable',
      'settlement_failed',
      'plain_500',
      'bare_402',
      'drop',
      'no_receipt',
      'unreadable_receipt',
      'not_settled',
    ] satisfies (PaidFailure | undefined)[]) {
      for (const payHost of [false, true]) {
        reset();
        at({ kind: 'x402', accepts: [option()] }, '/v1/quote');
        at({ kind: 'x402', accepts: [option()] }, '/api.example.test/v1/quote');
        api.nextFailure = failure;
        await run(payHost ? [`${api.url}/api.example.test/v1/quote`, '--yes'] : [url, '--yes', '--full'], payHost ? throughAnyfare() : {});
        transactions.push(...api.settled.map((item) => item.transaction));
        callIds.push(...api.calls.list.map((item) => item.id));
      }
    }
    // A call on Anyfare that is not found
    reset();
    at({ kind: 'x402', accepts: [option()] }, '/api.example.test/v1/quote');
    api.calls.failure = 'status_500';
    await run([`${api.url}/api.example.test/v1/quote`, '--yes'], throughAnyfare());
    transactions.push(...api.settled.map((item) => item.transaction));
    reset();
    at({ kind: 'x402', accepts: [option()] });
    await run([url], {}, { isTerminal: true, input: 'y\n' });
    transactions.push(...api.settled.map((item) => item.transaction));
    // Signing that fails
    rpc.addAccessKey(ACCOUNT, nearTestKey().publicKey, 41n);
    await run([url, '--yes']);
    rpc.failing = { status: 503 };
    await run([url, '--yes']);
    await run(['balance']);
    // An RPC of another chain, a deeply nested paid answer, and a pasted MPP credential
    reset();
    at({ kind: 'x402', accepts: [option()] });
    rpc.chainId = 'testnet';
    await run([url, '--yes']);
    reset();
    api.route({ method: 'GET', path: '/v1/deep', unpaid: { kind: 'x402', accepts: [option()] }, paid: { status: 200, body: `${'['.repeat(20_000)}1${']'.repeat(20_000)}` } });
    await run([`${API}/v1/deep`, '--yes']);
    transactions.push(...api.settled.map((item) => item.transaction));
    await run(['-H', 'Authorization: Payment made-up', url]);
    reset();
    await run(['balance']);

    // Every path above ran, and printed
    expect(codes).toContain(0);
    expect(codes).toContain(1);
    expect(codes).toContain(2);
    expect(codes).toContain(3);
    expect(transactions.length).toBeGreaterThanOrEqual(6);
    const all = outputs.join('\n');
    expect(all).toContain('✔ You paid 0.01 USDC on NEAR.');
    expect(all).toContain(' │ Anyfare call  pay_');
    expect(all).toContain("Anyfare's receipt for this call was not found");
    expect(all).toContain('Could not sign the payment');
    expect(all).toContain('is not a mainnet RPC');
    // Public values are not parts of a key: the made-up transaction hashes, and the fakes' hosts
    const known = [...transactions, ...callIds, ...(all.match(/127\.0\.0\.1:[0-9]+/g) ?? [])];
    // 12 characters: shorter slices match random base58 hashes in the output by chance
    expectNoKeyIn(all, KEY, { slice: 12, known });
  });

  it('is found by the check, in whole or in 12 characters', () => {
    expect(() => expectNoKeyIn(`text ${BODY.slice(20, 32)} text`, KEY, { slice: 12 })).toThrow('a part of the key');
    expect(() => expectNoKeyIn(`text ${BODY} text`, KEY, { slice: 12 })).toThrow('the key');
    expect(() => expectNoKeyIn('a payer alice.near and nothing else', KEY, { slice: 12 })).not.toThrow();
  });
});
