// The app checks what the SDK signed before it sends it. Here the SDK's client is swapped for one that
// signs a payment to another recipient, of a smaller amount, or valid for 3000 blocks, and still says
// it paid the chosen option: the app must refuse it and send nothing. The key is made in the test, in
// memory only, and holds nothing. Every account and balance is made up.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli.ts';
import { NEAR_USDC, startFakeApi } from './fakeApi.ts';
import type { FakeApi } from './fakeApi.ts';
import { startFakeNearRpc } from './fakeNearRpc.ts';
import type { FakeNearRpc } from './fakeNearRpc.ts';
import { captureIo, expectNoKeyIn, localFetch, nearTestKey } from './helpers.ts';

const tamper = vi.hoisted(() => ({ change: undefined as Record<string, unknown> | undefined, refuse: false }));

vi.mock('@x402/core/client', async (importOriginal) => {
  const real = await importOriginal<typeof import('@x402/core/client')>();
  class Tampering extends real.x402Client {
    override async createPaymentPayload(...args: Parameters<InstanceType<typeof real.x402Client>['createPaymentPayload']>) {
      const [required] = args;
      // The client's own refusal, made before any read of the RPC
      if (tamper.refuse) throw new Error('Payment creation aborted: made up');
      const chosen = required.accepts[0];
      if (tamper.change === undefined || chosen === undefined) return super.createPaymentPayload(...args);
      // Signs another option, then names the chosen one
      const payload = await super.createPaymentPayload({ ...required, accepts: [{ ...chosen, ...tamper.change }] });
      return { ...payload, accepted: chosen };
    }
  }
  return { ...real, x402Client: Tampering };
});

const ACCOUNT = 'alice.near';
const API = 'https://api.example.test';
const { secretKey: KEY, publicKey: PUBLIC_KEY } = nearTestKey();

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

async function payNear() {
  const io = captureIo(localFetch({ [API]: api.url }), { NEAR_ACCOUNT_ID: ACCOUNT, NEAR_PRIVATE_KEY: KEY, NEAR_RPC_URL: rpc.url });
  const code = await runCli([`${API}/v1/quote`, '--yes'], io.io);
  const result = { code, out: io.out(), err: io.err() };
  expectNoKeyIn(`${result.out}\n${result.err}`, KEY);
  return result;
}

describe('a payment the SDK signed otherwise', () => {
  it.each<[string, Record<string, unknown>, string]>([
    ['to another recipient', { payTo: 'thief.example.near' }, 'it pays another recipient'],
    ['of a smaller amount', { amount: '9999' }, 'it pays another amount'],
    ['valid for 3000 blocks', { maxTimeoutSeconds: 3000 }, "it stays valid for more blocks than the option's 300 seconds"],
  ])('is refused, and nothing is sent, when it is %s', async (_what, change, why) => {
    tamper.change = change;
    const result = await payNear();
    expect(result.code).toBe(1);
    expect(result.err).toBe(`✘ The signed payment is not the one the app chose: ${why}. Nothing was sent.\n`);
    expect(result.out).toContain('▸ Signing a transfer of 0.01 USDC to seller.example.near\n');
    expect(result.out).not.toContain('Calling');
    expect(api.paidRequests()).toEqual([]);
    expect(api.requests).toHaveLength(1);
  });

  it("is the x402 client's refusal, not the RPC's, when the client refuses to sign", async () => {
    tamper.change = undefined;
    tamper.refuse = true;
    try {
      const result = await payNear();
      expect(result.code).toBe(1);
      expect(result.err).toBe('✘ Could not sign the payment: the x402 client refused it. Nothing paid.\n');
      expect(api.paidRequests()).toEqual([]);
    } finally {
      tamper.refuse = false;
    }
  });

  it('is sent once when the SDK signed what was chosen', async () => {
    tamper.change = undefined;
    const result = await payNear();
    expect(result.code).toBe(0);
    expect(api.paidRequests()).toHaveLength(1);
    expect(api.settled).toHaveLength(1);
  });
});
