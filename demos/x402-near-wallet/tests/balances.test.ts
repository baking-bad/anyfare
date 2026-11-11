// Every account and balance is made up, and read from a made-up RPC on 127.0.0.1.

import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { balanceLine, nearText, readNearBalance, usdcText } from '../src/balances.ts';
import { startFakeNearRpc } from './fakeNearRpc.ts';
import type { FakeNearRpc } from './fakeNearRpc.ts';

const ACCOUNT = 'alice.near';
const USDC_CONTRACT = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
// Made up: a key of an RPC's own, in its path and in its query
const KEYED = '/made-up-path-Wq3/v3?made-up-query=Zr8LmQ';
const KEYED_PARTS = ['made-up-path', 'Wq3', '/v3', 'made-up-query', 'Zr8LmQ'];

let rpc: FakeNearRpc;
let silent: Server;
let silentUrl: string;
const address = (url: string) => ({ url, host: new URL(url).host });

beforeAll(async () => {
  rpc = await startFakeNearRpc();
  // An RPC that takes the call and never answers
  silent = createServer(() => undefined);
  await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
  silentUrl = `http://127.0.0.1:${(silent.address() as AddressInfo).port}`;
});
afterAll(async () => {
  silent.closeAllConnections();
  await Promise.all([rpc.close(), new Promise<void>((resolve) => silent.close(() => resolve()))]);
});
beforeEach(() => {
  rpc.failing = undefined;
  rpc.calls.length = 0;
  rpc.setBalance(ACCOUNT, 990_000n, 123_456_789_000_000_000_000_000n);
});

describe('readNearBalance', () => {
  it('reads the USDC and the NEAR', async () => {
    const read = await readNearBalance(fetch, ACCOUNT, address(rpc.url), { withNear: true });
    expect(read).toEqual({ kind: 'read', usdc: 990_000n, near: 123_456_789_000_000_000_000_000n });
  });

  it('reads the USDC only, unless asked for the NEAR', async () => {
    const read = await readNearBalance(fetch, ACCOUNT, address(rpc.url));
    expect(read).toEqual({ kind: 'read', usdc: 990_000n });
    expect(rpc.balanceReads()).toHaveLength(1);
  });

  it('makes the two views at the final block, and nothing else', async () => {
    await readNearBalance(fetch, ACCOUNT, address(rpc.url), { withNear: true });
    expect(rpc.calls).toHaveLength(2);
    const params = rpc.calls.map((call) => call.params as Record<string, unknown>);
    expect(rpc.calls.every((call) => call.method === 'query')).toBe(true);
    expect(params.every((item) => item['finality'] === 'final')).toBe(true);
    const call = params.find((item) => item['request_type'] === 'call_function');
    expect(call).toMatchObject({ account_id: USDC_CONTRACT, method_name: 'ft_balance_of' });
    expect(JSON.parse(Buffer.from(String(call?.['args_base64']), 'base64').toString('utf8'))).toEqual({ account_id: ACCOUNT });
    expect(params.find((item) => item['request_type'] === 'view_account')).toMatchObject({ account_id: ACCOUNT });
  });

  it('reads 0 USDC for an account the contract does not know, when the account exists', async () => {
    rpc.setBalance('bob.near', 0n, 1n);
    expect(await readNearBalance(fetch, 'bob.near', address(rpc.url), { withNear: true })).toMatchObject({ kind: 'read', usdc: 0n });
  });

  it('names the host only when the RPC answers 503, never the path or the query', async () => {
    rpc.failing = { status: 503 };
    const read = await readNearBalance(fetch, ACCOUNT, address(`${rpc.url}${KEYED}`), { withNear: true });
    expect(read).toEqual({ kind: 'failed', reason: `the NEAR RPC at ${new URL(rpc.url).host} answered 503` });
    for (const part of KEYED_PARTS) expect(JSON.stringify(read)).not.toContain(part);
  });

  it('names the host only when the RPC cannot be reached', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const { port } = closed.address() as AddressInfo;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const read = await readNearBalance(fetch, ACCOUNT, address(`http://127.0.0.1:${port}${KEYED}`), { withNear: true });
    expect(read.kind).toBe('failed');
    const reason = read.kind === 'failed' ? read.reason : '';
    expect(reason).toContain(`the NEAR RPC at 127.0.0.1:${port} could not be reached`);
    for (const part of KEYED_PARTS) expect(reason).not.toContain(part);
  });

  it('says an unknown account is unknown', async () => {
    const read = await readNearBalance(fetch, 'nobody.near', address(rpc.url), { withNear: true });
    expect(read).toEqual({ kind: 'failed', reason: `the NEAR RPC at ${new URL(rpc.url).host} knows no account nobody.near` });
  });

  it('gives up at the time limit when the RPC never answers', async () => {
    const started = Date.now();
    const read = await readNearBalance(fetch, ACCOUNT, address(`${silentUrl}${KEYED}`), { limitMs: 200, withNear: true });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(read).toEqual({ kind: 'failed', reason: `the NEAR RPC at ${new URL(silentUrl).host} did not answer in 200 ms` });
  });

  it('never throws, and never quotes the RPC when fetch itself throws', async () => {
    const broken = (() => Promise.reject(new Error(`boom ${KEYED}`))) as unknown as typeof fetch;
    const read = await readNearBalance(broken, ACCOUNT, address(`${rpc.url}${KEYED}`));
    expect(read.kind).toBe('failed');
    for (const part of KEYED_PARTS) expect(JSON.stringify(read)).not.toContain(part);
  });
});

describe('text', () => {
  it('shows USDC with 6 decimals', () => {
    expect(usdcText(990_000n)).toBe('0.990000 USDC');
    expect(usdcText(12_500_000n)).toBe('12.500000 USDC');
    expect(usdcText(0n)).toBe('0.000000 USDC');
    expect(usdcText(1n)).toBe('0.000001 USDC');
  });

  it('shows NEAR with 4 decimals, rounded down', () => {
    expect(nearText(120_000_000_000_000_000_000_000n)).toBe('0.1200 NEAR');
    expect(nearText(123_456_789_000_000_000_000_000n)).toBe('0.1234 NEAR');
    expect(nearText(199_999_999_999_999_999_999_999n)).toBe('0.1999 NEAR');
    expect(nearText(99_999_999_999_999_999_999n)).toBe('0.0000 NEAR');
    expect(nearText(12_500_000_000_000_000_000_000_000n)).toBe('12.5000 NEAR');
    expect(nearText(0n)).toBe('0.0000 NEAR');
  });

  it('puts the two on one line, or says it was not read', () => {
    expect(balanceLine({ kind: 'read', usdc: 990_000n, near: 120_000_000_000_000_000_000_000n })).toBe('0.990000 USDC · 0.1200 NEAR');
    expect(balanceLine({ kind: 'read', usdc: 990_000n })).toBe('0.990000 USDC');
    expect(balanceLine({ kind: 'failed', reason: 'it broke' })).toBe('not read: it broke');
  });
});
