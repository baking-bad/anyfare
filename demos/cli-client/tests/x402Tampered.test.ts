// The app checks what the SDK signed before it sends it. Here the SDK's client is swapped for one that
// signs a payment to another recipient, or of another amount: the app must refuse it and send nothing.
// The key is made in the test, in memory only, and holds nothing.

import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli.ts';
import { toAtomic } from '../src/util.ts';
import { forwardingFetch, startFakeAnyfare, toolRoutes, toolTargets } from './fakeAnyfare.ts';
import type { FakeAnyfare } from './fakeAnyfare.ts';
import { startFakeBaseRpc } from './fakeBaseRpc.ts';
import type { FakeBaseRpc } from './fakeBaseRpc.ts';
import { captureIo, tempAppDir } from './helpers.ts';

const tamper = vi.hoisted(() => ({ change: undefined as Record<string, unknown> | undefined }));

vi.mock('@x402/core/client', async (importOriginal) => {
  const real = await importOriginal<typeof import('@x402/core/client')>();
  class Tampering extends real.x402Client {
    override async createPaymentPayload(...args: Parameters<InstanceType<typeof real.x402Client>['createPaymentPayload']>) {
      const payload = await super.createPaymentPayload(...args);
      if (tamper.change === undefined) return payload;
      const authorization = payload.payload['authorization'] as Record<string, unknown>;
      return { ...payload, payload: { ...payload.payload, authorization: { ...authorization, ...tamper.change } } };
    }
  }
  return { ...real, x402Client: Tampering };
});

let fake: FakeAnyfare;
let baseRpc: FakeBaseRpc;
beforeAll(async () => {
  [fake, baseRpc] = await Promise.all([startFakeAnyfare(), startFakeBaseRpc()]);
});
afterAll(async () => {
  await Promise.all([fake.close(), baseRpc.close()]);
});
beforeEach(() => {
  fake.reset();
  baseRpc.reset();
  const cmc = toolTargets().cmc;
  // Made up, dated 2026-11-09
  fake.addTarget({
    ...cmc,
    x402: [
      {
        scheme: 'exact',
        network: 'eip155:8453',
        asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        amount: toAtomic(cmc.price, 6).toString(),
        payTo: '0x00000000000000000000000000000000000000b1',
        maxTimeoutSeconds: 300,
        extra: { name: 'USD Coin', version: '2', assetTransferMethod: 'eip3009' },
      },
    ],
  });
});

async function payBase() {
  const app = tempAppDir();
  try {
    const { fetch } = forwardingFetch(toolRoutes());
    const key = generatePrivateKey();
    // Made up: the wallet holds 1 USDC, so the check before the question lets the call go on to sign
    baseRpc.setBalance(privateKeyToAccount(key).address, 1_000_000n);
    const io = captureIo(
      fetch,
      { ANYFARE_API_URL: fake.apiUrl, ANYFARE_PAY_URL: fake.payUrl, BASE_PRIVATE_KEY: key, BASE_RPC_URL: baseRpc.url },
      { appDir: app.dir },
    );
    const code = await runCli(['call', '--tool', 'cmc', '--pay', 'base', '--yes'], io.io);
    return { code, out: io.out(), err: io.err() };
  } finally {
    app.remove();
  }
}

describe('a payment the SDK signed otherwise', () => {
  const inSeconds = (seconds: number): string => String(Math.floor(Date.now() / 1000) + seconds);

  it.each<[string, () => Record<string, unknown>, string]>([
    ['to another recipient', () => ({ to: '0x00000000000000000000000000000000000000C3' }), 'it pays another recipient'],
    ['of another amount', () => ({ value: '11001' }), 'it pays another amount'],
    ['valid until 2036', () => ({ validBefore: '2082758400' }), "it stays valid longer than the option's 300 seconds"],
    ['valid for 2.85e8 years', () => ({ validBefore: '9000000000000000' }), "it stays valid longer than the option's 300 seconds"],
    ['valid 400 seconds from now', () => ({ validBefore: inSeconds(400) }), "it stays valid longer than the option's 300 seconds"],
    ['valid only from an hour from now', () => ({ validAfter: inSeconds(3600) }), 'it only becomes valid later'],
  ])('is refused, and nothing is sent, when it is %s', async (_what, change, why) => {
    tamper.change = change();
    const result = await payBase();
    expect(result.code).toBe(1);
    expect(result.err).toBe(`✘ The signed payment is not the one the app chose: ${why}. Nothing was sent. Not charged.\n`);
    expect(result.out).not.toContain('Calling');
    expect(fake.x402Requests()).toEqual([]);
  });

  it('is sent when the SDK signed what was chosen', async () => {
    tamper.change = undefined;
    const result = await payBase();
    expect(result.code).toBe(0);
    expect(fake.x402Requests()).toHaveLength(1);
  });
});
