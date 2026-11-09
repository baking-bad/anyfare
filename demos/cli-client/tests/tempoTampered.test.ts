// The app checks what the client signed before it sends it. Here mppx's Tempo charge client is swapped
// for one that signs another transaction, or makes another credential: the app must refuse it and send
// nothing. The key is made in the test, in memory only, and holds nothing.

import { Credential } from 'mppx';
import { encodeFunctionData } from 'viem';
import type { Hex } from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import type { PrivateKeyAccount } from 'viem/accounts';
import { Abis, Transaction } from 'viem/tempo';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli.ts';
import { FAKE_TEMPO_RECIPIENT, TEMPO_USDCE, forwardingFetch, startFakeAnyfare, toolRoutes, toolTargets } from './fakeAnyfare.ts';
import type { FakeAnyfare } from './fakeAnyfare.ts';
import { PATH_USD, startFakeTempoRpc } from './fakeTempoRpc.ts';
import type { FakeTempoRpc } from './fakeTempoRpc.ts';
import { captureIo, tempAppDir } from './helpers.ts';

type Tamper = (header: string, account: PrivateKeyAccount) => Promise<string>;
const tamper = vi.hoisted(() => ({ change: undefined as Tamper | undefined }));

vi.mock('mppx/client', async (importOriginal) => {
  const real = await importOriginal<typeof import('mppx/client')>();
  type ChargeParameters = NonNullable<Parameters<typeof real.tempo.charge>[0]>;
  const charge = (parameters: ChargeParameters) => {
    const method = real.tempo.charge(parameters);
    return {
      ...method,
      createCredential: async (options: Parameters<typeof method.createCredential>[0]) => {
        const header = await method.createCredential(options);
        return tamper.change === undefined ? header : tamper.change(header, parameters.account as PrivateKeyAccount);
      },
    };
  };
  return { ...real, tempo: Object.assign((...args: Parameters<typeof real.tempo>) => real.tempo(...args), real.tempo, { charge }) };
});

const OTHER = '0x00000000000000000000000000000000000000c3';

/** The credential with its transaction changed, and signed again by the same key. */
const resigned =
  (change: () => Record<string, unknown>): Tamper =>
  async (header, account) => {
    const credential = Credential.deserialize(header);
    const payload = credential.payload as { readonly signature: Hex; readonly type: string };
    const { signature: _signature, from: _from, ...unsigned } = Transaction.deserialize(payload.signature) as unknown as Record<string, unknown>;
    const signature = await account.signTransaction({ ...unsigned, ...change() } as never, { serializer: Transaction.serialize as never });
    return Credential.serialize({ ...credential, payload: { ...payload, signature } });
  };
const transfer = (to: string, amount: bigint) => [{ to: TEMPO_USDCE, data: encodeFunctionData({ abi: Abis.tip20, functionName: 'transfer', args: [to as Hex, amount] }) }];

let fake: FakeAnyfare;
let rpc: FakeTempoRpc;
beforeAll(async () => {
  [fake, rpc] = await Promise.all([startFakeAnyfare(), startFakeTempoRpc()]);
});
afterAll(async () => {
  await Promise.all([fake.close(), rpc.close()]);
});
beforeEach(() => {
  fake.reset();
  rpc.reset();
  // Made up, dated 2026-11-09
  fake.addTarget({ ...toolTargets()['3route'], mpp: { amount: '1200' } });
});

async function payTempo(env: Record<string, string> = {}) {
  const app = tempAppDir();
  try {
    const { fetch } = forwardingFetch(toolRoutes());
    const io = captureIo(
      fetch,
      { ANYFARE_API_URL: fake.apiUrl, ANYFARE_PAY_URL: fake.payUrl, TEMPO_PRIVATE_KEY: generatePrivateKey(), TEMPO_RPC_URL: rpc.url, ...env },
      { appDir: app.dir },
    );
    const code = await runCli(['call', '--tool', '3route', '--pay', 'tempo', '--yes'], io.io);
    return { code, out: io.out(), err: io.err() };
  } finally {
    app.remove();
  }
}

describe('a credential the client made otherwise', () => {
  const now = (): number => Math.floor(Date.now() / 1000);

  it.each<[string, Tamper, string]>([
    ['to another recipient', resigned(() => ({ calls: transfer(OTHER, 1200n) })), 'it pays another recipient'],
    ['of another amount', resigned(() => ({ calls: transfer(FAKE_TEMPO_RECIPIENT, 1201n) })), 'it pays another amount'],
    ['valid for an hour', resigned(() => ({ validBefore: now() + 3600 })), 'it stays valid longer than the charge'],
    ['valid until 2036', resigned(() => ({ validBefore: 2_082_758_400 })), 'it stays valid longer than the charge'],
    ['for another chain', resigned(() => ({ chainId: 42431 })), 'it is signed for another chain'],
    ['with a fee payer', resigned(() => ({ feePayer: true })), 'it has a fee payer'],
    [
      'as a push credential, for a transaction it broadcast',
      async (header) => Credential.serialize({ ...Credential.deserialize(header), payload: { type: 'hash', hash: `0x${'1'.repeat(64)}` } }),
      'it is not a transaction signed for Anyfare to broadcast',
    ],
    [
      'for another charge',
      async (header) => {
        const credential = Credential.deserialize(header);
        return Credential.serialize({ ...credential, challenge: { ...credential.challenge, request: { ...credential.challenge.request, amount: '1' } } });
      },
      'it answers another charge',
    ],
    ['with its fee in pathUSD', resigned(() => ({ feeToken: PATH_USD })), 'it pays its network fee in another token than USDC.e'],
  ])('is refused, and nothing is sent, when it is %s', async (_what, change, why) => {
    tamper.change = change;
    const result = await payTempo();
    expect(result.code).toBe(1);
    expect(result.err).toBe(`✘ The signed payment is not the one the app chose: ${why}. Nothing was sent. Not charged.\n`);
    expect(result.out).not.toContain('Calling');
    expect(fake.mppRequests()).toEqual([]);
    expect(rpc.sent()).toEqual([]);
  });

  it.each<[string, Tamper, string]>([
    [
      'with a fee of dollars',
      resigned(() => ({ maxFeePerGas: 10n ** 15n })),
      'The signed payment allows a network fee of up to $57, above the most the app lets a fee be, $0.01.',
    ],
    [
      'with a fee past the cap',
      resigned(() => ({ maxFeePerGas: 10n ** 11n })),
      'The signed payment pays 0.0012 USDC.e on Tempo and a network fee of up to $0.0057, $0.0069 in all, above your cap MAX_PAYMENT_USD of $0.005.',
    ],
  ])('is refused, and nothing is sent, when it is signed %s', async (_what, change, line) => {
    tamper.change = change;
    const result = await payTempo({ MAX_PAYMENT_USD: '0.005' });
    expect(result.code).toBe(1);
    expect(result.err).toBe(`✘ ${line} Nothing was sent. Not charged.\n`);
    expect(result.out).not.toContain('Calling');
    expect(fake.mppRequests()).toEqual([]);
    expect(rpc.sent()).toEqual([]);
  });

  it('is sent when the client signed what was chosen', async () => {
    tamper.change = undefined;
    const result = await payTempo();
    expect(result.code).toBe(0);
    expect(fake.mppRequests()).toHaveLength(1);
  });
});
