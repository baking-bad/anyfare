import { createHash } from 'node:crypto';

import { KeyPair, KeyType, type KeyPairString } from '@near-js/crypto';
import { actionCreators, createTransaction, decodeSignedTransaction, encodeTransaction, Signature, SignedTransaction } from '@near-js/transactions';
import type { PaymentRequired, PaymentRequirements } from '@x402/core/types';
import { createFacilitatorNearSigner, createProviderFactory, decodeSignedDelegateB64, parseFtTransferArgs, type FacilitatorNearSigner } from '@x402/near';
import { ExactNearScheme } from '@x402/near/exact/facilitator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createTestNearPayer, encodeBase58, generateNearKey, nearEmptyCodeHash, startFakeNearRpc, type FakeNearRpc, type NearTestKey, type TestNearPayer,
} from '../src/index.js';

const network = 'near:testnet';
const token = 'usdc.fakes.testnet';
const shop = 'shop.fakes.testnet';
const relayerId = 'relayer.fakes.testnet';

let rpc: FakeNearRpc;
let relayerKey: NearTestKey;
let relayer: FacilitatorNearSigner;
let payer: TestNearPayer;

beforeEach(async () => {
  rpc = await startFakeNearRpc({ timeoutMs: 100 });
  relayerKey = generateNearKey();
  rpc.addAccount({ accountId: relayerId, publicKey: relayerKey.publicKey });
  rpc.addAccount({ accountId: shop });
  rpc.addToken({ contractId: token, registered: [shop] });
  payer = createTestNearPayer({ accountId: 'buyer.fakes.testnet', rpc });
  rpc.setBalance(token, payer.accountId, 50_000n);
  relayer = createFacilitatorNearSigner({ relayers: [{ accountId: relayerId, secretKey: relayerKey.secretKey }], rpcUrls: { [network]: rpc.url } });
});

afterEach(async () => {
  await rpc.close();
});

interface RpcAnswer {
  readonly status: number;
  readonly result?: any;
  readonly error?: any;
}

const send = async (method: string, params: unknown, signal?: AbortSignal): Promise<RpcAnswer> => {
  const response = await fetch(rpc.url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 'test', method, params }), ...signal ? { signal } : {} });
  const text = await response.text();

  return { status: response.status, ...text === '' ? {} : JSON.parse(text) as Omit<RpcAnswer, 'status'> };
};

const requirement = (overrides: Partial<PaymentRequirements> = {}): PaymentRequirements => ({
  scheme: 'exact', network, asset: token, amount: '10000', payTo: shop, maxTimeoutSeconds: 60, extra: {}, ...overrides,
});

const required = (overrides: Partial<PaymentRequirements> = {}): PaymentRequired => ({
  x402Version: 2, resource: { url: 'https://api.shop.test/v1/item' }, accepts: [requirement(overrides)],
});

const signedDelegate = async (overrides: Partial<PaymentRequirements> = {}): Promise<string> =>
  String((await payer.paymentFor(required(overrides))).payload['signedDelegateAction']);

const submit = (signedDelegateAction: string) => relayer.submitSignedDelegateAction({ network, relayerId, signedDelegateAction });

// The signed transaction of the last send_tx, as the relayer sent it
const lastSignedTransaction = (): string => {
  const call = rpc.calls.filter(item => item.method === 'send_tx').at(-1);

  return String((call?.params as Record<string, unknown> | undefined)?.['signed_tx_base64']);
};

describe('the fake NEAR node\'s blocks and views', () => {
  it('makes a block on each call, one higher, with a 32-byte base58 hash', async () => {
    const first = await send('block', { finality: 'final' });
    const second = await send('block', { finality: 'final' });

    expect(second.result.header.height).toBe(first.result.header.height + 1);
    expect(BigInt(second.result.header.height)).toBe(rpc.height);
    expect(second.result.header.prev_hash).toBe(first.result.header.hash);
    expect(await relayer.getCurrentBlockHeight(network)).toBe(rpc.height);
    // The relayer signs over the hash's 32 bytes
    expect(decodeSignedDelegateB64(await signedDelegate()).delegate.maxBlockHeight).toBe(rpc.height + 60n);
  });

  it('answers view_account with the account\'s NEAR and code hash, and nearcore\'s UNKNOWN_ACCOUNT for no account', async () => {
    rpc.addAccount({ accountId: shop, amount: 3n * 10n ** 22n });

    expect(await relayer.viewAccount({ network, accountId: shop })).toEqual({ codeHash: nearEmptyCodeHash });
    expect((await relayer.viewAccount({ network, accountId: token }))?.codeHash).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
    expect((await send('query', { request_type: 'view_account', account_id: shop, finality: 'final' })).result).toMatchObject({ amount: '30000000000000000000000' });
    // The SDK takes nearcore's text as no account
    expect(await relayer.viewAccount({ network, accountId: 'nobody.fakes.testnet' })).toBeNull();
    expect(await send('query', { request_type: 'view_account', account_id: 'nobody.fakes.testnet', finality: 'final' })).toMatchObject({
      status: 200,
      error: {
        name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_ACCOUNT', info: { requested_account_id: 'nobody.fakes.testnet' } }, data: 'account nobody.fakes.testnet does not exist while viewing',
      },
    });
    const args = Buffer.from(JSON.stringify({ account_id: shop })).toString('base64');
    expect((await send('query', { request_type: 'call_function', account_id: 'nobody.fakes.testnet', method_name: 'ft_balance_of', args_base64: args, finality: 'final' })).error)
      .toMatchObject({ cause: { name: 'UNKNOWN_ACCOUNT' } });
  });

  it('answers a request it can\'t parse, or a method it doesn\'t have, with HTTP 400', async () => {
    expect(await send('query', { request_type: 'view_code', account_id: token, finality: 'final' }))
      .toMatchObject({ status: 400, error: { name: 'REQUEST_VALIDATION_ERROR', cause: { name: 'PARSE_ERROR' } } });
    expect(await send('query', { request_type: 'view_account', finality: 'final' })).toMatchObject({ status: 400 });
    expect(await send('status', [])).toMatchObject({ status: 400, error: { name: 'REQUEST_VALIDATION_ERROR', cause: { name: 'METHOD_NOT_FOUND' } } });
  });

  it('answers view_access_key with the key\'s nonce and permission, and nearcore\'s error text for another key', async () => {
    const functionCallKey = generateNearKey();
    rpc.addAccount({
      accountId: 'app.fakes.testnet', publicKey: functionCallKey.publicKey, nonce: 42n,
      permission: { FunctionCall: { allowance: null, receiver_id: token, method_names: ['ft_transfer'] } },
    });

    expect(await relayer.viewAccessKey({ network, accountId: payer.accountId, publicKey: payer.publicKey }))
      .toEqual({ nonce: rpc.nonceOf(payer.accountId, payer.publicKey), permissionKind: 'FullAccess' });
    expect(await relayer.viewAccessKey({ network, accountId: 'app.fakes.testnet', publicKey: functionCallKey.publicKey })).toEqual({ nonce: 42n, permissionKind: 'FunctionCall' });
    expect(await relayer.viewAccessKey({ network, accountId: payer.accountId, publicKey: functionCallKey.publicKey })).toBeNull();
    expect(await relayer.viewAccessKey({ network, accountId: 'nobody.fakes.testnet', publicKey: payer.publicKey })).toBeNull();
    expect((await send('query', { request_type: 'view_access_key', account_id: payer.accountId, public_key: functionCallKey.publicKey, finality: 'final' })).result)
      .toMatchObject({ error: `access key ${functionCallKey.publicKey} does not exist while viewing` });
    // A new key's nonce is as the chain sets it: under the height's nonce range
    expect(rpc.nonceOf(payer.accountId, payer.publicKey)! < rpc.height * 1_000_000n).toBe(true);
  });

  it('answers ft_balance_of and storage_balance_of on the token, and nearcore\'s MethodNotFound text for another method', async () => {
    expect(await relayer.ftBalanceOf({ network, token, accountId: payer.accountId })).toBe(50_000n);
    expect(await relayer.ftBalanceOf({ network, token, accountId: 'nobody.fakes.testnet' })).toBe(0n);
    expect(await relayer.storageBalanceOf({ network, token, accountId: shop })).toEqual({ supported: true, registered: true });
    expect(await relayer.storageBalanceOf({ network, token, accountId: 'new.fakes.testnet' })).toEqual({ supported: true, registered: false });

    rpc.register(token, 'new.fakes.testnet');
    expect(await relayer.storageBalanceOf({ network, token, accountId: 'new.fakes.testnet' })).toEqual({ supported: true, registered: true });
    const args = Buffer.from(JSON.stringify({})).toString('base64');
    expect((await send('query', { request_type: 'call_function', account_id: token, method_name: 'ft_metadata', args_base64: args, finality: 'final' })).result)
      .toMatchObject({ error: 'wasm execution failed with error: FunctionCallError(MethodResolveError(MethodNotFound))', logs: [] });
    // near-js turns that text into its own words
    const missing = createProviderFactory({ [network]: rpc.url })(network).callFunction(token, 'ft_metadata', {}, { finality: 'final' });
    await expect(missing).rejects.toThrow('Contract method is not found');
  });

  it('serves a token without storage_balance_of, which the SDK\'s verify can\'t tell from an RPC failure', async () => {
    const bare = 'bare.fakes.testnet';
    rpc.addToken({ contractId: bare, balances: { [payer.accountId]: 50_000n }, registered: [shop], storageManagement: false });
    const payment = await payer.paymentFor(required({ asset: bare }));

    // The SDK's pattern for a missing method doesn't match near-js's words, so it fails closed
    expect(await new ExactNearScheme(relayer).verify(payment, requirement({ asset: bare })))
      .toEqual({ isValid: false, invalidReason: 'invalid_exact_near_storage_check_failed', payer: payer.accountId });
  });

  it('records every call, and answers 503 to each while unavailable, or to the methods named', async () => {
    rpc.unavailable(true);
    expect((await send('block', { finality: 'final' })).status).toBe(503);
    rpc.unavailable(true, { methods: ['tx'] });
    expect((await send('tx', { tx_hash: '11111111111111111111111111111111', sender_account_id: relayerId })).status).toBe(503);
    expect((await send('block', { finality: 'final' })).status).toBe(200);

    rpc.reset();
    expect(rpc.calls).toEqual([]);
    expect((await send('block', { finality: 'final' })).status).toBe(200);
    expect(rpc.calls).toEqual([{ method: 'block', params: { finality: 'final' } }]);
  });
});

describe('the fake NEAR node\'s transactions', () => {
  it('applies the relayer\'s transaction: the transfer moves, both nonces rise, and the outcome is final', async () => {
    const signed = await signedDelegate();
    const delegate = decodeSignedDelegateB64(signed).delegate;
    const relayerNonce = rpc.nonceOf(relayerId, relayerKey.publicKey)!;

    const outcome = await submit(signed);

    expect(outcome).toEqual({ transaction: rpc.transactions[0]!.hash, innerReceipt: { kind: 'success', value: '' } });
    expect(rpc.balanceOf(token, payer.accountId)).toBe(40_000n);
    expect(rpc.balanceOf(token, shop)).toBe(10_000n);
    expect(rpc.nonceOf(payer.accountId, payer.publicKey)).toBe(delegate.nonce);
    expect(rpc.nonceOf(relayerId, relayerKey.publicKey)).toBe(relayerNonce + 1n);
    expect(rpc.transactions).toEqual([expect.objectContaining({
      signerId: relayerId, publicKey: relayerKey.publicKey, nonce: relayerNonce + 1n, receiverId: payer.accountId, status: 'success',
      delegate: expect.objectContaining({ senderId: payer.accountId, receiverId: token, nonce: delegate.nonce, transfer: { receiverId: shop, amount: 10_000n } }),
    })]);
    expect(rpc.calls.find(call => call.method === 'send_tx')?.params).toMatchObject({ wait_until: 'FINAL' });
    expect(rpc.transactions[0]!.outcome).toMatchObject({
      final_execution_status: 'FINAL',
      status: { SuccessValue: '' },
      transaction: { hash: outcome.transaction, signer_id: relayerId, receiver_id: payer.accountId },
      transaction_outcome: { id: outcome.transaction, outcome: { executor_id: relayerId } },
      receipts_outcome: [{ outcome: { executor_id: token, status: { SuccessValue: '' }, logs: [expect.stringContaining('"event":"ft_transfer"')] } }],
    });
  });

  it('answers tx and EXPERIMENTAL_tx_status for a transaction it holds, and for another UNKNOWN_TRANSACTION with NONE only, else a 408 after a wait', async () => {
    const { transaction } = await submit(await signedDelegate());

    expect((await send('tx', { tx_hash: transaction, sender_account_id: relayerId, wait_until: 'FINAL' })).result).toEqual(rpc.transactions[0]!.outcome);
    expect((await send('EXPERIMENTAL_tx_status', { tx_hash: transaction, sender_account_id: relayerId })).result).toMatchObject({ transaction: { hash: transaction } });
    const unknown = '11111111111111111111111111111111';
    expect((await send('tx', { tx_hash: unknown, sender_account_id: relayerId, wait_until: 'NONE' })).error).toMatchObject({ cause: { name: 'UNKNOWN_TRANSACTION' } });
    expect((await send('EXPERIMENTAL_tx_status', { tx_hash: unknown, sender_account_id: relayerId, wait_until: 'NONE' })).error).toMatchObject({ cause: { name: 'UNKNOWN_TRANSACTION' } });
    for (const waitUntil of ['FINAL', 'EXECUTED_OPTIMISTIC', undefined]) {
      const started = performance.now();
      expect(await send('tx', { tx_hash: unknown, sender_account_id: relayerId, ...waitUntil === undefined ? {} : { wait_until: waitUntil } }))
        .toMatchObject({ status: 408, error: { cause: { name: 'TIMEOUT_ERROR' } } });
      expect(performance.now() - started).toBeGreaterThanOrEqual(90);
    }
  });

  it('fails a delegate action whose nonce was used, in the token receipt, and moves nothing', async () => {
    const signed = await signedDelegate();
    await submit(signed);

    const again = await submit(signed);

    expect(again.innerReceipt.kind).toBe('failure');
    expect(again.innerReceipt).toMatchObject({ error: expect.stringContaining('DelegateActionInvalidNonce') });
    expect(rpc.transactions[1]!.outcome).toMatchObject({ receipts_outcome: [{ outcome: { executor_id: token, status: { Failure: { ActionError: { kind: { DelegateActionInvalidNonce: {} } } } } } }] });
    expect(rpc.balanceOf(token, payer.accountId)).toBe(40_000n);
  });

  it('fails a transfer the balance doesn\'t cover with the contract\'s panic, and moves nothing', async () => {
    const outcome = await submit(await signedDelegate({ amount: '60000' }));

    expect(outcome.innerReceipt).toEqual({ kind: 'failure', error: expect.stringContaining('The account doesn\'t have enough balance') });
    expect(rpc.balanceOf(token, payer.accountId)).toBe(50_000n);
    expect(rpc.transactions[0]!.status).toBe('failure');
  });

  it('fails a transfer to an account the token hasn\'t registered', async () => {
    const outcome = await submit(await signedDelegate({ payTo: 'new.fakes.testnet' }));

    expect(outcome.innerReceipt).toEqual({ kind: 'failure', error: expect.stringContaining('The account new.fakes.testnet is not registered') });
  });

  it('fails a delegate action past its max_block_height', async () => {
    const signed = await signedDelegate({ maxTimeoutSeconds: 1 });
    await send('block', { finality: 'final' });
    await send('block', { finality: 'final' });

    expect((await submit(signed)).innerReceipt).toEqual({ kind: 'failure', error: expect.stringContaining('DelegateActionExpired') });
  });

  it('reverts the inner receipt when told: the nonces move, the balance doesn\'t', async () => {
    const signed = await signedDelegate();
    rpc.broadcast('revert');

    const outcome = await submit(signed);

    expect(outcome.innerReceipt).toEqual({ kind: 'failure', error: expect.stringContaining('Smart contract panicked') });
    expect(rpc.balanceOf(token, payer.accountId)).toBe(50_000n);
    expect(rpc.nonceOf(payer.accountId, payer.publicKey)).toBe(decodeSignedDelegateB64(signed).delegate.nonce);
  });

  it('refuses a transaction with a JSON-RPC error when told, and applies nothing', async () => {
    rpc.broadcast('refuse');

    await expect(submit(await signedDelegate())).rejects.toThrow('Transaction has expired');
    expect(rpc.transactions).toEqual([]);
    expect(rpc.balanceOf(token, payer.accountId)).toBe(50_000n);
  });

  it('refuses a transaction whose nonce the relayer\'s key already used', async () => {
    rpc.broadcast('refuse');
    await expect(submit(await signedDelegate())).rejects.toThrow();
    const signedTransaction = lastSignedTransaction();
    // Another transaction of the relayer's took the nonce first
    rpc.addAccount({ accountId: relayerId, publicKey: relayerKey.publicKey, nonce: rpc.nonceOf(relayerId, relayerKey.publicKey)! + 1n });
    rpc.broadcast('confirm');

    const answer = await send('send_tx', { signed_tx_base64: signedTransaction, wait_until: 'FINAL' });

    expect(answer.error).toMatchObject({ cause: { name: 'INVALID_TRANSACTION' }, data: { TxExecutionError: { InvalidTxError: { InvalidNonce: {} } } } });
    expect(rpc.transactions).toEqual([]);
  });

  it('answers 503 to the next send_tx calls when told to fail, and applies the resend after them', async () => {
    rpc.broadcast('refuse');
    await expect(submit(await signedDelegate())).rejects.toThrow();
    const signedTransaction = lastSignedTransaction();

    rpc.broadcast('fail', { times: 2 });
    expect((await send('send_tx', { signed_tx_base64: signedTransaction, wait_until: 'FINAL' })).status).toBe(503);
    expect((await send('send_tx', { signed_tx_base64: signedTransaction, wait_until: 'FINAL' })).status).toBe(503);
    expect(rpc.transactions).toEqual([]);

    expect((await send('send_tx', { signed_tx_base64: signedTransaction, wait_until: 'FINAL' })).result).toMatchObject({ status: { SuccessValue: '' } });
    expect(rpc.balanceOf(token, payer.accountId)).toBe(40_000n);
  });

  it('lands a transaction the SDK\'s client resends after a transient 503', async () => {
    rpc.broadcast('fail');

    const outcome = await submit(await signedDelegate());

    expect(outcome.innerReceipt.kind).toBe('success');
    expect(rpc.calls.filter(call => call.method === 'send_tx')).toHaveLength(2);
    expect(rpc.transactions).toHaveLength(1);
  });

  it('applies a transaction when told to time out, and answers HTTP 408 with nearcore\'s TIMEOUT_ERROR after holding it', async () => {
    rpc.broadcast('refuse');
    await expect(submit(await signedDelegate())).rejects.toThrow();
    const signedTransaction = lastSignedTransaction();
    rpc.broadcast('timeout');
    const started = performance.now();

    const answer = await send('send_tx', { signed_tx_base64: signedTransaction, wait_until: 'FINAL' });

    expect(performance.now() - started).toBeGreaterThanOrEqual(90);
    expect(answer).toMatchObject({ status: 408, error: { name: 'HANDLER_ERROR', cause: { name: 'TIMEOUT_ERROR' } } });
    expect(rpc.transactions).toHaveLength(1);
    expect(rpc.balanceOf(token, payer.accountId)).toBe(40_000n);
    // A resend answers the outcome of the transaction it holds, and so does tx
    expect((await send('send_tx', { signed_tx_base64: signedTransaction, wait_until: 'FINAL' })).result).toMatchObject({ status: { SuccessValue: '' } });
    expect((await send('tx', { tx_hash: rpc.transactions[0]!.hash, sender_account_id: relayerId, wait_until: 'FINAL' })).result)
      .toMatchObject({ final_execution_status: 'FINAL' });
  });

  it('never answers a dropped transaction nor knows its hash, and applies a later resend', async () => {
    rpc.broadcast('refuse');
    await expect(submit(await signedDelegate())).rejects.toThrow();
    const signedTransaction = lastSignedTransaction();
    const hash = encodeBase58(createHash('sha256').update(encodeTransaction(decodeSignedTransaction(Buffer.from(signedTransaction, 'base64')).transaction)).digest());
    rpc.broadcast('drop');

    await expect(send('send_tx', { signed_tx_base64: signedTransaction, wait_until: 'FINAL' }, AbortSignal.timeout(200))).rejects.toThrow();
    expect(rpc.transactions).toEqual([]);
    expect((await send('tx', { tx_hash: hash, sender_account_id: relayerId, wait_until: 'NONE' })).error)
      .toMatchObject({ name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_TRANSACTION', info: { requested_transaction_hash: hash } } });
    expect((await send('tx', { tx_hash: hash, sender_account_id: relayerId, wait_until: 'FINAL' })).status).toBe(408);

    const resent = await send('send_tx', { signed_tx_base64: signedTransaction, wait_until: 'FINAL' });
    expect(resent.result).toMatchObject({ status: { SuccessValue: '' }, transaction: { hash } });
    expect(rpc.transactions).toHaveLength(1);
  });

  it('refuses with InvalidNonce when told, giving the relayer\'s key the transaction\'s nonce, and lands the next one', async () => {
    const relayerNonce = rpc.nonceOf(relayerId, relayerKey.publicKey)!;
    rpc.broadcast('refuse', { refusal: 'invalid-nonce' });

    await expect(submit(await signedDelegate())).rejects.toThrow(/Transaction nonce \d+ must be larger than nonce of the used access key \d+/);
    expect(rpc.nonceOf(relayerId, relayerKey.publicKey)).toBe(relayerNonce + 1n);
    expect(rpc.transactions).toEqual([]);

    expect((await submit(await signedDelegate())).innerReceipt.kind).toBe('success');
    expect(rpc.transactions[0]!.nonce).toBe(relayerNonce + 2n);
  });
});

describe('the fake NEAR node\'s transactions of function calls', () => {
  // A hot wallet with its own key, paying from its own balance on the token, and an implicit account the token hasn't registered
  const walletId = 'hot.fakes.testnet';
  const receiver = 'c'.repeat(64);
  const deposit = 1_250_000_000_000_000_000_000n;
  let walletKey: NearTestKey;

  beforeEach(() => {
    walletKey = generateNearKey();
    rpc.addAccount({ accountId: walletId, publicKey: walletKey.publicKey });
    rpc.setBalance(token, walletId, 20_000n);
  });

  const call = (methodName: string, args: Record<string, unknown>, attached: bigint) => actionCreators.functionCall(methodName, args, 30_000_000_000_000n, attached);
  const register = (accountId = receiver) => call('storage_deposit', { account_id: accountId, registration_only: true }, deposit);
  const transferTo = (amount: string, accountId = receiver) => call('ft_transfer', { receiver_id: accountId, amount }, 1n);

  // Signed with the wallet's key at the next nonce, as near-js signs a transaction: its hash, and the signed bytes in base64
  const signed = (actions: ReturnType<typeof call>[], nonce = rpc.nonceOf(walletId, walletKey.publicKey)! + 1n) => {
    const pair = KeyPair.fromString(walletKey.secretKey as KeyPairString);
    const transaction = createTransaction(walletId, pair.getPublicKey(), token, nonce, actions, new Uint8Array(32));
    const digest = new Uint8Array(createHash('sha256').update(encodeTransaction(transaction)).digest());
    const signature = new Signature({ keyType: KeyType.ED25519, data: pair.sign(digest).signature });

    return { hash: encodeBase58(digest), base64: Buffer.from(new SignedTransaction({ transaction, signature }).encode()).toString('base64') };
  };
  const sendTx = (base64: string) => send('send_tx', { signed_tx_base64: base64, wait_until: 'FINAL' });
  const amountOf = async (accountId: string) => BigInt((await send('query', { request_type: 'view_account', finality: 'final', account_id: accountId })).result.amount);

  it('answers storage_balance_bounds with the storage deposit as both bounds', async () => {
    const args = Buffer.from(JSON.stringify({})).toString('base64');
    const { result } = await send('query', { request_type: 'call_function', account_id: token, method_name: 'storage_balance_bounds', args_base64: args, finality: 'final' });

    expect(JSON.parse(Buffer.from(result.result as number[]).toString('utf8'))).toEqual({ min: '1250000000000000000000', max: '1250000000000000000000' });
  });

  it('registers the receiver then transfers, in one receipt on the token, paid from the signer\'s NEAR, and answers a resend with the same outcome', async () => {
    const before = await amountOf(walletId);
    const { hash, base64 } = signed([register(), transferTo('7000')]);

    const answer = await sendTx(base64);

    expect(answer.result).toMatchObject({
      final_execution_status: 'FINAL', status: { SuccessValue: '' }, transaction: { hash, signer_id: walletId, receiver_id: token },
      receipts_outcome: [{ outcome: { executor_id: token, status: { SuccessValue: '' }, logs: [expect.stringContaining(`"new_owner_id":"${receiver}","amount":"7000"`)] } }],
    });
    expect(rpc.balanceOf(token, walletId)).toBe(13_000n);
    expect(rpc.balanceOf(token, receiver)).toBe(7_000n);
    // The storage deposit and ft_transfer's yoctoNEAR
    expect(await amountOf(walletId)).toBe(before - deposit - 1n);
    expect(rpc.directTransactions).toEqual([{
      hash, signerId: walletId, publicKey: walletKey.publicKey, nonce: rpc.nonceOf(walletId, walletKey.publicKey), receiverId: token, status: 'success', failure: undefined,
      outcome: answer.result,
      calls: [
        { methodName: 'storage_deposit', args: { account_id: receiver, registration_only: true }, gas: 30_000_000_000_000n, deposit },
        { methodName: 'ft_transfer', args: { receiver_id: receiver, amount: '7000' }, gas: 30_000_000_000_000n, deposit: 1n },
      ],
    }]);
    expect(rpc.transactions).toEqual([]);
    expect((await send('tx', { tx_hash: hash, sender_account_id: walletId, wait_until: 'NONE' })).result).toEqual(answer.result);

    expect((await sendTx(base64)).result).toEqual(answer.result);
    expect(rpc.balanceOf(token, receiver)).toBe(7_000n);
    expect(rpc.directTransactions).toHaveLength(1);
  });

  it('applies none of the calls when one fails: the failing action\'s index, and the registration undone', async () => {
    const before = await amountOf(walletId);
    const { base64 } = signed([register(), transferTo('20001')]);

    const answer = await sendTx(base64);

    expect(answer.result.status).toEqual({ Failure: { ActionError: { index: 1, kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: The account doesn\'t have enough balance' } } } } });
    expect(rpc.directTransactions[0]).toMatchObject({ status: 'failure' });
    expect(rpc.balanceOf(token, walletId)).toBe(20_000n);
    expect(await amountOf(walletId)).toBe(before);
    // Still unregistered: an ft_transfer alone fails
    expect((await sendTx(signed([transferTo('1')]).base64)).result.status).toMatchObject({ Failure: { ActionError: { index: 0 } } });
  });

  it('reverts the token\'s receipt when told: the nonce moves, balances and registrations don\'t', async () => {
    rpc.broadcast('revert');
    const { base64 } = signed([register(), transferTo('7000')]);

    expect((await sendTx(base64)).result.status).toHaveProperty('Failure');
    expect(rpc.balanceOf(token, walletId)).toBe(20_000n);
    expect(rpc.nonceOf(walletId, walletKey.publicKey)).toBe(rpc.directTransactions[0]!.nonce);
    expect((await sendTx(signed([transferTo('1')]).base64)).result.status).toHaveProperty('Failure');
  });

  it('takes an ft_transfer alone to a registered account, and refuses a nonce the key already used', async () => {
    rpc.register(token, receiver);
    const first = signed([transferTo('500')]);

    expect((await sendTx(first.base64)).result.status).toEqual({ SuccessValue: '' });
    expect(rpc.balanceOf(token, receiver)).toBe(500n);
    const reused = signed([transferTo('501')], rpc.nonceOf(walletId, walletKey.publicKey)!);
    expect((await sendTx(reused.base64)).error).toMatchObject({ cause: { name: 'INVALID_TRANSACTION' }, data: { TxExecutionError: { InvalidTxError: { InvalidNonce: {} } } } });
    expect(rpc.balanceOf(token, receiver)).toBe(500n);
  });
});

describe('the test NEAR payer', () => {
  it('signs a delegate action for the 402\'s NEAR option that decodes and verifies', async () => {
    const nonce = rpc.nonceOf(payer.accountId, payer.publicKey)!;

    const payment = await payer.paymentFor(required());
    const decoded = decodeSignedDelegateB64(String(payment.payload['signedDelegateAction']));

    expect(payment).toMatchObject({ x402Version: 2, resource: { url: 'https://api.shop.test/v1/item' }, accepted: requirement() });
    expect(decoded.verifySignature()).toBe(true);
    expect(decoded.delegate).toMatchObject({
      senderId: payer.accountId, receiverId: token, publicKey: payer.publicKey, nonce: nonce + 1n, maxBlockHeight: rpc.height + 60n, actionCount: 1,
    });
    expect(decoded.delegate.functionCall).toMatchObject({ methodName: 'ft_transfer', deposit: 1n });
    expect(parseFtTransferArgs(decoded.delegate.functionCall!.args)).toEqual({ receiver_id: shop, amount: '10000' });
  });

  it('starts from the nonce it is given', async () => {
    const other = createTestNearPayer({ accountId: 'other.fakes.testnet', rpc, nonce: 7n });

    expect(decodeSignedDelegateB64(String((await other.paymentFor(required())).payload['signedDelegateAction'])).delegate.nonce).toBe(8n);
  });
});
