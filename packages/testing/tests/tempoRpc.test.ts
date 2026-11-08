import { encodeFunctionData, keccak256, numberToHex, parseEventLogs, stringToHex, type Hex, type Log } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { Abis, Transaction } from 'viem/tempo';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { moderatoChainId, pathUsdAddress, startFakeTempoRpc, type FakeTempoRpc } from '../src/index.js';

const recipient = '0x3333333333333333333333333333333333333333';
const payer = privateKeyToAccount(generatePrivateKey());

let rpc: FakeTempoRpc;

beforeEach(async () => {
  rpc = await startFakeTempoRpc({ timeoutMs: 100 });
});

afterEach(async () => {
  await rpc.close();
});

interface RpcAnswer {
  readonly status: number;
  readonly id?: number;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

const send = async (method: string, params: unknown[] = []): Promise<RpcAnswer> => {
  const response = await fetch(rpc.url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 7, method, params }) });
  if (response.status !== 200)
    return { status: response.status };

  return { status: response.status, ...await response.json() as Omit<RpcAnswer, 'status'> };
};

let nonce = 0;
const nowSeconds = () => Math.floor(Date.now() / 1_000);

/**
 * A pathUSD transfer the payer signs as a Tempo transaction, with a memo when one is given. Valid for
 * a minute on Moderato unless told otherwise.
 */
const signedTransfer = async ({ amount = 1_000n, memo, chainId = moderatoChainId, validAfter, validBefore = nowSeconds() + 60 }: {
  readonly amount?: bigint;
  readonly memo?: string;
  readonly chainId?: number;
  readonly validAfter?: number;
  readonly validBefore?: number;
} = {}): Promise<Hex> => {
  const data = memo === undefined
    ? encodeFunctionData({ abi: Abis.tip20, functionName: 'transfer', args: [recipient, amount] })
    : encodeFunctionData({ abi: Abis.tip20, functionName: 'transferWithMemo', args: [recipient, amount, stringToHex(memo, { size: 32 })] });
  nonce += 1;

  return payer.signTransaction({
    type: 'tempo',
    chainId,
    calls: [{ to: pathUsdAddress, data }],
    nonce,
    nonceKey: 1n,
    gas: 100_000n,
    maxFeePerGas: 2n,
    maxPriorityFeePerGas: 1n,
    validBefore,
    ...validAfter === undefined ? {} : { validAfter },
  }, { serializer: Transaction.serialize });
};

const broadcast = (raw: Hex) => send('eth_sendRawTransactionSync', [raw]);
const receiptOf = async (hash: Hex) => (await send('eth_getTransactionReceipt', [hash])).result as { status: string; transactionHash: Hex; logs: Log[] } | null;
const transfersIn = (logs: readonly Log[]) => parseEventLogs({ abi: Abis.tip20, eventName: ['Transfer', 'TransferWithMemo'], logs: [...logs] })
  .map(log => ({ eventName: log.eventName, address: log.address, from: log.args.from, to: log.args.to, amount: log.args.amount }));

describe('the fake Tempo RPC', () => {
  it('answers eth_chainId with Moderato\'s chain ID, or the one set until reset', async () => {
    expect(await send('eth_chainId')).toMatchObject({ status: 200, id: 7, result: '0xa5bf' });
    expect(moderatoChainId).toBe(42_431);

    rpc.answerChainId(4_217);
    expect((await send('eth_chainId')).result).toBe('0x1079');
    rpc.reset();
    expect((await send('eth_chainId')).result).toBe('0xa5bf');
  });

  it('includes a confirmed broadcast, and answers with a successful receipt carrying its TIP-20 transfer logs', async () => {
    const raw = await signedTransfer({ amount: 1_234n, memo: 'pay_tempo_1' });

    const answer = await broadcast(raw);

    const hash = keccak256(raw);
    const receipt = answer.result as { status: string; transactionHash: Hex; from: string; logs: Log[] };
    expect(receipt).toMatchObject({ status: '0x1', transactionHash: hash, from: payer.address.toLowerCase() });
    const transfer = { address: pathUsdAddress, from: payer.address, to: recipient, amount: 1_234n };
    expect(transfersIn(receipt.logs)).toEqual([{ eventName: 'Transfer', ...transfer }, { eventName: 'TransferWithMemo', ...transfer }]);
    expect(await receiptOf(hash)).toEqual(receipt);
    expect(rpc.transactions).toEqual([hash]);
    expect(rpc.rawTransactions).toEqual([raw]);
    expect(rpc.calls.map(call => call.method)).toEqual(['eth_sendRawTransactionSync', 'eth_getTransactionReceipt']);
  });

  it('includes a reverted broadcast with a failed receipt and no logs', async () => {
    const raw = await signedTransfer();
    rpc.broadcast('revert');

    const receipt = (await broadcast(raw)).result as { status: string; logs: Log[] };

    expect(receipt).toMatchObject({ status: '0x0', logs: [] });
    expect(rpc.transactions).toEqual([keccak256(raw)]);
  });

  it('refuses a broadcast with a JSON-RPC error, including nothing', async () => {
    const raw = await signedTransfer();
    rpc.broadcast('refuse');

    expect(await broadcast(raw)).toMatchObject({ status: 200, error: { code: -32_003 } });
    expect(rpc.rawTransactions).toEqual([raw]);
    expect(rpc.transactions).toEqual([]);
    expect(await receiptOf(keccak256(raw))).toBeNull();
  });

  it('fails a broadcast with HTTP 503, including nothing', async () => {
    const raw = await signedTransfer();
    rpc.broadcast('fail');

    expect(await broadcast(raw)).toEqual({ status: 503 });
    expect(rpc.rawTransactions).toEqual([raw]);
    expect(rpc.transactions).toEqual([]);
  });

  it('holds a timed-out broadcast\'s answer, leaves it pending, and includes it when told, with either status', async () => {
    const raw = await signedTransfer({ amount: 500n });
    const other = await signedTransfer();
    rpc.broadcast('timeout');

    const started = Date.now();
    expect(await broadcast(raw)).toMatchObject({ status: 200, error: { code: 4 } });
    expect(Date.now() - started).toBeGreaterThanOrEqual(90);
    await broadcast(other);
    const [hash, otherHash] = [keccak256(raw), keccak256(other)];
    expect(rpc.transactions).toEqual([hash, otherHash]);
    expect(await receiptOf(hash)).toBeNull();

    rpc.include(hash);
    rpc.include(otherHash, 'reverted');

    const included = await receiptOf(hash);
    expect(included).toMatchObject({ status: '0x1', transactionHash: hash });
    expect(transfersIn(included!.logs)).toEqual([{ eventName: 'Transfer', address: pathUsdAddress, from: payer.address, to: recipient, amount: 500n }]);
    expect(await receiptOf(otherHash)).toMatchObject({ status: '0x0', logs: [] });
    expect(() => rpc.include(`0x${'9'.repeat(64)}`)).toThrow('never received');
  });

  it('answers every call with HTTP 503 while unavailable, and keeps the transactions it holds across a reset', async () => {
    const raw = await signedTransfer();
    await broadcast(raw);
    rpc.unavailable(true);

    expect(await send('eth_chainId')).toEqual({ status: 503 });
    expect(await send('eth_getTransactionReceipt', [keccak256(raw)])).toEqual({ status: 503 });
    rpc.unavailable(false);
    expect((await send('eth_chainId')).result).toBe('0xa5bf');

    rpc.unavailable(true);
    rpc.reset();
    expect(await send('eth_chainId')).toMatchObject({ status: 200 });
    expect(rpc.rawTransactions).toEqual([]);
    expect(rpc.calls.map(call => call.method)).toEqual(['eth_chainId']);
    expect(await receiptOf(keccak256(raw))).toMatchObject({ status: '0x1' });
  });

  it('includes a broadcast it already knows as confirmed, and answers "already known"', async () => {
    const raw = await signedTransfer({ amount: 700n });
    rpc.broadcast('already-known');

    expect(await broadcast(raw)).toMatchObject({ status: 200, error: { code: -32_000, message: 'already known' } });

    const receipt = await receiptOf(keccak256(raw));
    expect(receipt).toMatchObject({ status: '0x1', transactionHash: keccak256(raw) });
    expect(transfersIn(receipt!.logs)).toEqual([{ eventName: 'Transfer', address: pathUsdAddress, from: payer.address, to: recipient, amount: 700n }]);
  });

  it('answers "already known" for a transaction it holds pending, and includes it when told', async () => {
    const raw = await signedTransfer();
    rpc.broadcast('already-known-pending');

    expect(await broadcast(raw)).toMatchObject({ status: 200, error: { code: -32_000, message: 'already known' } });

    expect(rpc.transactions).toEqual([keccak256(raw)]);
    expect(await receiptOf(keccak256(raw))).toBeNull();
    rpc.include(keccak256(raw));
    expect(await receiptOf(keccak256(raw))).toMatchObject({ status: '0x1' });
  });

  it.each([
    ['signed for another chain', { chainId: 4_217 }, 'invalid chain id 4217'],
    ['expired', { validBefore: nowSeconds() - 1 }, 'transaction expired'],
    ['not valid yet', { validAfter: nowSeconds() + 60, validBefore: nowSeconds() + 120 }, 'transaction not valid yet'],
  ])('refuses a broadcast %s, whatever the outcome set, and includes nothing', async (_case, change, message) => {
    const raw = await signedTransfer(change);
    rpc.broadcast('already-known');

    expect(await broadcast(raw)).toMatchObject({ status: 200, error: { code: -32_000, message } });
    expect(rpc.rawTransactions).toEqual([raw]);
    expect(rpc.transactions).toEqual([]);
  });

  it.each([
    ['signed for another chain', { chainId: numberToHex(4_217) }, 'invalid chain id 4217'],
    ['expired', { validBefore: numberToHex(nowSeconds() - 1) }, 'transaction expired'],
    ['not valid yet', { validAfter: numberToHex(nowSeconds() + 60), validBefore: numberToHex(nowSeconds() + 120) }, 'transaction not valid yet'],
  ])('reverts a simulation of a transaction %s', async (_case, fields, message) => {
    const call = { from: payer.address, calls: [{ to: pathUsdAddress, data: '0x' }], type: '0x76', ...fields };

    expect((await send('eth_call', [call, 'latest'])).error).toEqual({ code: 3, message: `execution reverted: ${message}` });
    expect((await send('eth_call', [{ ...call, chainId: numberToHex(moderatoChainId), validBefore: numberToHex(nowSeconds() + 60), validAfter: '0x0' }, 'latest'])).result)
      .toBe('0x');
  });

  it('simulates with success or an execution revert, and logs the methods it doesn\'t fake', async () => {
    expect((await send('eth_call', [{ to: pathUsdAddress, data: '0x' }, 'latest'])).result).toBe('0x');
    rpc.simulate('revert');
    expect((await send('eth_call', [{ to: pathUsdAddress, data: '0x' }, 'latest'])).error).toMatchObject({ code: 3 });

    expect((await send('eth_fillTransaction')).error).toMatchObject({ code: -32_601 });
    expect((await send('eth_getLogs')).error).toMatchObject({ code: -32_601 });
    expect(rpc.unknownMethods).toEqual(['eth_getLogs']);
  });
});
