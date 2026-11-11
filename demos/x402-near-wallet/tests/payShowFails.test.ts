// The answer's lines can't be made, whatever the reason: here the result block is swapped for one
// that throws. A paid answer is still reported whole: the proof, the payment and the balance after;
// and a failed one keeps its line about the payment. Every key here is made in the test, in memory
// only, and holds nothing. Every account, price and balance is made up.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli.ts';
import { NEAR_USDC, startFakeApi } from './fakeApi.ts';
import type { FakeAnswer, FakeApi } from './fakeApi.ts';
import { startFakeNearRpc } from './fakeNearRpc.ts';
import type { FakeNearRpc } from './fakeNearRpc.ts';
import { captureIo, expectNoKeyIn, localFetch, nearTestKey } from './helpers.ts';

vi.mock('../src/result.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/result.ts')>();
  return {
    ...real,
    answerLines: () => {
      throw new RangeError('Made up: Invalid string length');
    },
  };
});

const ACCOUNT = 'alice.near';
const API = 'https://api.example.test';
const CHECK = 'https://nearblocks.io/address/alice.near shows your payments';
const WARNING = 'The answer could not be shown: Made up: Invalid string length.\n';
const { secretKey: KEY, publicKey: PUBLIC_KEY } = nearTestKey();
const option = { scheme: 'exact', network: 'near:mainnet', asset: NEAR_USDC, amount: '10000', payTo: 'seller.example.near', maxTimeoutSeconds: 300, extra: {} };

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
  // Made up: 0.99 USDC and 0.12 NEAR
  rpc.setBalance(ACCOUNT, 990_000n, 120_000_000_000_000_000_000_000n);
});

async function run(argv: readonly string[]) {
  const io = captureIo(localFetch({ [API]: api.url }), { NEAR_ACCOUNT_ID: ACCOUNT, NEAR_PRIVATE_KEY: KEY, NEAR_RPC_URL: rpc.url });
  const code = await runCli(argv, io.io);
  const result = { code, out: io.out(), err: io.err() };
  expectNoKeyIn(`${result.out}\n${result.err}`, KEY, { known: api.settled.map((item) => item.transaction) });
  return result;
}

const payable = (paid?: FakeAnswer): void =>
  api.route({ method: 'GET', path: '/v1/quote', unpaid: { kind: 'x402', accepts: [option] }, ...(paid !== undefined && { paid }) });

describe('an answer that cannot be shown', () => {
  it('is one warning on the free path, and the run goes on', async () => {
    api.route({ method: 'GET', path: '/v1/free', unpaid: { kind: 'answer', answer: { status: 200, body: '{}' } } });
    const result = await run([`${API}/v1/free`]);
    expect(result.code).toBe(0);
    expect(result.err).toBe(WARNING);
    expect(result.out).toBe('✔ Free: nothing paid.\n');
  });

  it('is one warning on the unpaid error path, before the failure', async () => {
    api.route({ method: 'GET', path: '/v1/free', unpaid: { kind: 'answer', answer: { status: 500, body: '{}' } } });
    const result = await run([`${API}/v1/free`]);
    expect(result.code).toBe(1);
    expect(result.err).toBe(`${WARNING}✘ The API answered 500. Nothing paid.\n`);
  });

  it('still reports a paid 2xx whole: the proof, the payment and the balance after', async () => {
    payable();
    const result = await run([`${API}/v1/quote`, '--yes']);
    expect(result.code).toBe(0);
    expect(result.err).toBe(WARNING);
    const tx = api.settled[0]?.transaction ?? '';
    expect(result.out).toContain(
      [
        '▸ Calling GET api.example.test/v1/quote',
        ' Proof',
        ` │ Transaction   ${tx}`,
        ` │ Explorer      https://nearblocks.io/txns/${tx}`,
        ' │ Network       near:mainnet',
        ' │ Payer         alice.near',
        '✔ You paid 0.01 USDC on NEAR.',
        '',
        'Balance   0.980000 USDC (−0.01) · 0.1200 NEAR',
        '',
      ].join('\n'),
    );
    expect(api.paidRequests()).toHaveLength(1);
  });

  it('keeps the line about the payment after a paid answer that is not 2xx', async () => {
    payable({ status: 500, contentType: 'text/plain', body: 'Made up' });
    const result = await run([`${API}/v1/quote`, '--yes']);
    expect(result.code).toBe(1);
    expect(result.err).toBe(`${WARNING}✘ The API answered 500. Whether the payment was taken is not known: ${CHECK}.\n`);
    expect(api.paidRequests()).toHaveLength(1);
  });
});
