// Signing that fails: nothing is signed, and nothing paid is sent. In a file of its own: the NEAR SDK
// keeps retrying an RPC that answers 503 for a minute and more after the app gave up on it, and its
// late calls must not reach the RPC of another test. Every key here is made in the test, in memory
// only, and holds nothing. Every account and balance is made up.

import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli.ts';
import { loadConfig } from '../src/config.ts';
import { createContext } from '../src/context.ts';
import { payRequest } from '../src/pay.ts';
import { parseRequest } from '../src/request.ts';
import { Stop } from '../src/util.ts';
import { NEAR_USDC, startFakeApi } from './fakeApi.ts';
import type { FakeApi } from './fakeApi.ts';
import { startFakeNearRpc } from './fakeNearRpc.ts';
import type { FakeNearRpc } from './fakeNearRpc.ts';
import { captureIo, expectNoKeyIn, localFetch, nearTestKey } from './helpers.ts';

const ACCOUNT = 'alice.near';
const API = 'https://api.example.test';
const { secretKey: KEY, publicKey: PUBLIC_KEY } = nearTestKey();
// Made up: a key of the RPC's own, in its path and in its query
const KEYED = '/made-up-path-Wq3/v3?made-up-query=Zr8LmQ';
const KEYED_PARTS = ['made-up-path', 'Wq3', '/v3', 'made-up-query', 'Zr8LmQ'];

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
beforeEach(() => {
  api.reset();
  api.chain = rpc;
  rpc.failing = undefined;
  rpc.chainId = 'mainnet';
  rpc.calls.length = 0;
  rpc.addAccessKey(ACCOUNT, PUBLIC_KEY, 41n);
  // Made up: 0.99 USDC
  rpc.setBalance(ACCOUNT, 990_000n, 1n);
  api.route({
    method: 'GET',
    path: '/v1/quote',
    unpaid: {
      kind: 'x402',
      accepts: [{ scheme: 'exact', network: 'near:mainnet', asset: NEAR_USDC, amount: '10000', payTo: 'seller.example.near', maxTimeoutSeconds: 300, extra: {} }],
    },
  });
});

async function run(rpcUrl: string) {
  const io = captureIo(localFetch({ [API]: api.url }), { NEAR_ACCOUNT_ID: ACCOUNT, NEAR_PRIVATE_KEY: KEY, NEAR_RPC_URL: rpcUrl });
  const code = await runCli([`${API}/v1/quote`, '--yes'], io.io);
  const result = { code, out: io.out(), err: io.err() };
  expectNoKeyIn(`${result.out}\n${result.err}`, KEY);
  return result;
}

/** A port of 127.0.0.1 that nothing listens on: a connection to it is refused. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe('signing that fails', () => {
  it('says the key is not an access key of the account, naming the account', async () => {
    rpc.addAccessKey(ACCOUNT, nearTestKey().publicKey, 41n);
    const result = await run(rpc.url);
    expect(result.code).toBe(1);
    expect(result.out).toContain('▸ Signing a transfer of 0.01 USDC to seller.example.near\n');
    expect(result.out).not.toContain('Calling');
    expect(result.err).toBe(
      `✘ Could not sign the payment: the NEAR RPC at ${new URL(rpc.url).host} says NEAR_PRIVATE_KEY is not an access key of ${ACCOUNT}. Nothing paid.\n`,
    );
    expect(api.paidRequests()).toEqual([]);
  });

  it('says the RPC could not be reached, by its host only', async () => {
    const port = await closedPort();
    const host = `127.0.0.1:${port}`;
    const result = await run(`http://${host}${KEYED}`);
    expect(result.code).toBe(1);
    expect(result.out).toContain(`  Your balance   not read: the NEAR RPC at ${host} could not be reached (ECONNREFUSED)\n`);
    expect(result.err).toBe(
      `Could not read the wallet's balance: the NEAR RPC at ${host} could not be reached (ECONNREFUSED). The facilitator refuses a payment the wallet can't cover.\n` +
        `✘ Could not sign the payment: the NEAR RPC at ${host} could not be reached (ECONNREFUSED). Nothing paid.\n`,
    );
    for (const part of KEYED_PARTS) expect(`${result.out}${result.err}`).not.toContain(part);
    expect(api.paidRequests()).toEqual([]);
  });

  it("names the RPC by its host only when it answers 503 to the app's own reads", async () => {
    rpc.failing = { status: 503 };
    const result = await run(`${rpc.url}${KEYED}`);
    expect(result.code).toBe(1);
    expect(result.err).toContain(`✘ Could not sign the payment: the NEAR RPC at ${new URL(rpc.url).host} answered 503. Nothing paid.\n`);
    for (const part of KEYED_PARTS) expect(`${result.out}${result.err}`).not.toContain(part);
    // The two reads of the balance, then the app's read of the chain: the signer was never asked
    expect(rpc.calls.map((call) => call.method).sort()).toEqual(['query', 'query', 'status']);
    expect(api.paidRequests()).toEqual([]);
  });

  it('refuses an RPC of another chain before anything is signed', async () => {
    // Made up: a testnet RPC, whose heights are its own, and far ahead of mainnet's
    rpc.chainId = 'testnet';
    const result = await run(`${rpc.url}${KEYED}`);
    expect(result.code).toBe(1);
    expect(result.err).toBe(`✘ Could not sign the payment: the NEAR RPC at ${new URL(rpc.url).host} is not a mainnet RPC. Nothing paid.\n`);
    for (const part of KEYED_PARTS) expect(`${result.out}${result.err}`).not.toContain(part);
    // The chain was read; the height and the key never were
    expect(rpc.calls.map((call) => call.method).sort()).toEqual(['query', 'query', 'status']);
    expect(rpc.calls.find((call) => call.method === 'status')?.params).toEqual([]);
    expect(api.paidRequests()).toEqual([]);
  });

  it('refuses an RPC that names no chain', async () => {
    rpc.chainId = '';
    const result = await run(rpc.url);
    expect(result.code).toBe(1);
    expect(result.err).toBe(`✘ Could not sign the payment: the NEAR RPC at ${new URL(rpc.url).host} is not a mainnet RPC. Nothing paid.\n`);
    expect(api.paidRequests()).toEqual([]);
  });

  // Last: the SDK goes on retrying this RPC after the test
  it('gives up on an RPC too slow for the time limit, and sends nothing', async () => {
    // The app's read of the height passes; the signer's read of the key answers 503, which the SDK retries
    rpc.failing = { status: 503, only: 'query' };
    const env = { NEAR_ACCOUNT_ID: ACCOUNT, NEAR_PRIVATE_KEY: KEY, NEAR_RPC_URL: `${rpc.url}${KEYED}` };
    const io = captureIo(localFetch({ [API]: api.url }), env);
    const ctx = createContext(io.io);
    const started = Date.now();
    let failure: unknown;
    try {
      await payRequest(ctx, loadConfig(env), parseRequest([`${API}/v1/quote`]), { yes: true, dryRun: false, full: false }, { signingMs: 400 });
    } catch (error) {
      failure = error;
    } finally {
      ctx.close();
    }
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(failure).toBeInstanceOf(Stop);
    const line = (failure as Stop).line();
    // The SDK may still sign after the limit: that signature is never sent, but it may exist
    expect(line).toBe(`Could not sign the payment: the NEAR RPC at ${new URL(rpc.url).host} did not answer in 400 ms. Nothing was sent.`);
    for (const part of KEYED_PARTS) expect(`${io.out()}${io.err()}${line}`).not.toContain(part);
    expectNoKeyIn(`${io.out()}${io.err()}${line}`, KEY);
    expect(rpc.calls.some((call) => (call.params as Record<string, unknown>)['request_type'] === 'view_access_key')).toBe(true);
    expect(api.paidRequests()).toEqual([]);
  });
});
