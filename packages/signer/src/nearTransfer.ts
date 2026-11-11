import { KeyPair, type KeyPairString, type PublicKey } from '@near-js/crypto';
import { KeyPairSigner } from '@near-js/signers';
import { actionCreators, createTransaction } from '@near-js/transactions';
import { getBase58Decoder, getBase58Encoder } from '@solana/kit';
import { DEFAULT_FT_TRANSFER_GAS, FT_TRANSFER_METHOD, ONE_YOCTO } from '@x402/near';

import { isRecord, outboundErrorCode } from '@anyfare/common';

import { InvalidNearKeyError, NearRpcError, NearStoreError, type NearPayerStore, type NearWallet } from './near.js';

// A transaction whose send had no answer is looked up every second by default
const defaultPollMs = 1_000;
// While the node doesn't know it, the same signed bytes go again every fifth lookup
const resendEvery = 5;
// A failed read is repeated once, this much later
const retryWaitMs = 100;
// Each call gets at least this long
const minimumAttemptMs = 100;
// NEP-145's storage_deposit for one account: as much gas as ft_transfer gets, far more than it burns
const storageDepositGas = DEFAULT_FT_TRANSFER_GAS;

/** What a NEP-141 transfer from the hot wallet came to. Each carries the transaction's hash and nonce. */
export type NearTransferOutcome = {
  readonly transactionHash: string;
  readonly nonce: bigint;
  // Whether the transaction registered the receiver on the token first
  readonly registers: boolean;
} & (
  // The transaction and every receipt succeeded: the amount moved
  | { readonly kind: 'sent' }
  // The node refused the transaction, or the token's receipt failed: nothing moved
  | { readonly kind: 'failed'; readonly reason: string }
  // No evidence either way: the amount may have moved
  | { readonly kind: 'unknown'; readonly reason: string }
);

export interface NearTransfer {
  readonly accountId: string;
  readonly publicKey: string;
  /** `ft_balance_of(accountId)` on the token, at final. Throws NearRpcError. */
  balanceOf(token: string, accountId: string): Promise<bigint>;
  /**
   * One transaction from the hot wallet to the token contract: `storage_deposit` for the receiver when
   * the token hasn't registered it, then `ft_transfer` of the amount. Throws NearRpcError or
   * NearStoreError only before it is sent: nothing left. Once sent, it answers the outcome.
   */
  transfer(input: { readonly token: string; readonly receiverId: string; readonly amount: bigint }): Promise<NearTransferOutcome>;
}

export interface NearTransferOptions {
  readonly wallet: NearWallet;
  // The last nonce signed with the key, shared with the hot wallet's x402 payments
  readonly store: Pick<NearPayerStore, 'lastNonce' | 'saveNonce'>;
  // Each read, and the first send's wait for an answer
  readonly readMs: number;
  readonly sendMs: number;
  // How long a send without an answer is looked up before its outcome is unknown
  readonly pollBudgetMs: number;
  // Default: a second
  readonly pollMs?: number;
}

// What one JSON-RPC call came to
type Reply =
  | { readonly kind: 'result'; readonly result: unknown }
  // The node's structured error
  | { readonly kind: 'error'; readonly error: Record<string, unknown> }
  // No usable answer: unreachable, a timeout, a 5xx, a 408, a 429, or a body that isn't JSON-RPC
  | { readonly kind: 'none'; readonly reason: string };

const isTimeout = (error: unknown): boolean => error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');

// A name nearcore gives an error, such as INVALID_TRANSACTION. Anything else stays out of a message.
const errorNameOf = (error: Record<string, unknown>): string => {
  const cause = isRecord(error['cause']) ? error['cause']['name'] : undefined;
  const name = typeof cause === 'string' ? cause : error['name'];

  return typeof name === 'string' && /^[A-Za-z_]{1,64}$/.test(name) ? name : 'an error';
};

// The kind of nearcore's InvalidTxError, such as InvalidNonce or Expired
const invalidTxKindOf = (error: Record<string, unknown>): string => {
  const data = isRecord(error['data']) && isRecord(error['data']['TxExecutionError']) ? error['data']['TxExecutionError']['InvalidTxError'] : undefined;
  const info = isRecord(error['cause']) ? error['cause']['info'] : undefined;
  const kind = [data, info].map(value => typeof value === 'string' ? value : isRecord(value) ? Object.keys(value)[0] : undefined).find(Boolean);

  return typeof kind === 'string' && /^[A-Za-z_]{1,64}$/.test(kind) ? kind : 'an invalid transaction';
};

const statusFailure = (status: unknown): boolean => isRecord(status) && status['Failure'] !== undefined && status['Failure'] !== null;
const statusSuccess = (status: unknown): boolean => isRecord(status) && ('SuccessValue' in status || 'SuccessReceiptId' in status);

// What a transaction's outcome says: undefined while it isn't final
type Verdict = { readonly kind: 'sent' } | { readonly kind: 'failed' | 'unknown'; readonly reason: string } | undefined;

/**
 * A final outcome of a transaction to the token contract. Only an outcome the node calls FINAL counts.
 * The token's receipt failed, or the transaction failed before it had one: nothing moved, since a
 * receipt's actions apply together or not at all. The transaction and every receipt succeeded: sent.
 * Anything else, such as another receipt failing after the token's succeeded: unknown.
 */
export const verdictOf = (outcome: unknown, tokenContractId: string): Verdict => {
  if (!isRecord(outcome) || outcome['final_execution_status'] !== 'FINAL')
    return undefined;
  const receipts = (Array.isArray(outcome['receipts_outcome']) ? outcome['receipts_outcome'] : [])
    .map(receipt => isRecord(receipt) && isRecord(receipt['outcome']) ? receipt['outcome'] : {});
  const token = receipts.filter(receipt => receipt['executor_id'] === tokenContractId);
  if (token.some(receipt => statusFailure(receipt['status'])))
    return { kind: 'failed', reason: 'The token contract\'s receipt failed' };
  if (statusFailure(outcome['status']) && !token.some(receipt => statusSuccess(receipt['status'])))
    return { kind: 'failed', reason: 'The transaction failed' };
  if (statusSuccess(outcome['status']) && token.length > 0 && receipts.every(receipt => statusSuccess(receipt['status'])))
    return { kind: 'sent' };

  return { kind: 'unknown', reason: 'The final outcome has a failed receipt beside the token\'s' };
};

const fromStore = async <TResult>(operation: () => Promise<TResult>): Promise<TResult> => {
  try {
    return await operation();
  }
  catch (error) {
    throw new NearStoreError({ cause: error });
  }
};

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * NEP-141 transfers from the NEAR hot wallet, each in one transaction it signs and sends itself, as the
 * facilitator's relayer does its own:
 * - Reads go to the wallet's RPC at `final`, each within `readMs`, repeated once when the node gave no
 *   answer.
 * - The nonce is the higher of the key's nonce on chain and the last one the store remembers, plus
 *   one, and the store remembers it before the transaction is sent: the hot wallet's x402 payments
 *   sign with the same key. The caller holds the payer's lease meanwhile.
 * - `send_tx` waits for FINAL, up to `sendMs`. The node's INVALID_TRANSACTION refusal of that first
 *   send fails it: nothing was taken. When the send has no answer, the transaction is looked up every
 *   `pollMs` with `wait_until: NONE`, and while the node doesn't know it, the same signed bytes go again
 *   every fifth lookup: the node takes a hash once, so a resend never moves the amount twice. A new
 *   transaction is never signed. Without a final outcome within `pollBudgetMs`, the outcome is unknown.
 * No message or reason holds the key, the signed transaction, or the RPC's URL, which may carry a key.
 */
export const createNearTransfer = ({ wallet, store, readMs, sendMs, pollBudgetMs, pollMs = defaultPollMs }: NearTransferOptions): NearTransfer => {
  const { accountId } = wallet;
  let signer: KeyPairSigner;
  let publicKey: PublicKey;
  try {
    const keyPair = KeyPair.fromString(wallet.secretKey.expose().trim() as KeyPairString);
    signer = new KeyPairSigner(keyPair);
    publicKey = keyPair.getPublicKey();
  }
  catch {
    throw new InvalidNearKeyError();
  }
  const publicKeyText = publicKey.toString();

  const once = async (method: string, params: unknown, timeoutMs: number): Promise<Reply> => {
    let response: Response;
    try {
      response = await fetch(wallet.rpcUrl.expose(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'anyfare-signer', method, params }),
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    }
    catch (error) {
      const code = outboundErrorCode(error);

      return { kind: 'none', reason: isTimeout(error) ? `The NEAR RPC didn't answer ${method} within ${timeoutMs} ms` : `The NEAR RPC is unreachable${code ? `: ${code}` : ''}` };
    }
    if (response.status >= 500 || response.status === 408 || response.status === 429) {
      await response.body?.cancel().catch(() => undefined);

      return { kind: 'none', reason: `The NEAR RPC answered ${method} with HTTP ${response.status}` };
    }
    let json: unknown;
    try {
      json = await response.json();
    }
    catch (error) {
      return { kind: 'none', reason: isTimeout(error) ? `The NEAR RPC didn't answer ${method} within ${timeoutMs} ms` : `The NEAR RPC's answer to ${method} isn't JSON` };
    }
    if (isRecord(json) && isRecord(json['error']))
      return { kind: 'error', error: json['error'] };
    if (!response.ok || !isRecord(json) || !('result' in json))
      return { kind: 'none', reason: `The NEAR RPC's answer to ${method} isn't JSON-RPC` };

    return { kind: 'result', result: json['result'] };
  };

  // A read: its result, or its structured error. Throws NearRpcError when the node gave no answer twice.
  const read = async (method: string, params: unknown): Promise<Exclude<Reply, { kind: 'none' }>> => {
    let reply = await once(method, params, readMs);
    if (reply.kind === 'none') {
      await sleep(retryWaitMs);
      reply = await once(method, params, readMs);
    }
    if (reply.kind === 'none')
      throw new NearRpcError(reply.reason, true);

    return reply;
  };

  // A view method's JSON value, or `no_method` when the contract has none by that name
  const view = async (contractId: string, method: string, args: Readonly<Record<string, unknown>>): Promise<{ readonly value: unknown } | 'no_method'> => {
    const reply = await read('query', {
      request_type: 'call_function', finality: 'final', account_id: contractId, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
    });
    // nearcore says a method is missing in a structured error or in the result's error text
    const missing = (failure: unknown) => /MethodNotFound|MethodResolveError/.test(JSON.stringify(failure));
    if (reply.kind === 'error') {
      if (missing(reply.error))
        return 'no_method';
      throw new NearRpcError(`The NEAR RPC refused ${method}: ${errorNameOf(reply.error)}`, false);
    }
    const result = isRecord(reply.result) ? reply.result : {};
    if (typeof result['error'] === 'string') {
      if (missing(result['error']))
        return 'no_method';
      throw new NearRpcError(`The token contract failed ${method}`, false);
    }
    const bytes = result['result'];
    if (!Array.isArray(bytes) || !bytes.every(byte => typeof byte === 'number'))
      throw new NearRpcError(`The NEAR RPC answered ${method} without a result`, false);
    try {
      return { value: JSON.parse(Buffer.from(bytes as number[]).toString('utf8')) };
    }
    catch {
      throw new NearRpcError(`The NEAR RPC answered ${method} with a result that isn't JSON`, false);
    }
  };

  const amountOf = (value: unknown, method: string): bigint => {
    if (typeof value !== 'string' || !/^\d{1,40}$/.test(value))
      throw new NearRpcError(`The NEAR RPC answered ${method} without an amount`, false);

    return BigInt(value);
  };

  const balanceOf = async (token: string, owner: string): Promise<bigint> => {
    const answer = await view(token, 'ft_balance_of', { account_id: owner });
    if (answer === 'no_method')
      throw new NearRpcError('The token contract has no ft_balance_of', false);

    return amountOf(answer.value, 'ft_balance_of');
  };

  // The NEAR a registration costs on the token, or undefined when it needs none: the receiver is
  // registered, or the token doesn't manage storage
  const registrationOf = async (token: string, receiverId: string): Promise<bigint | undefined> => {
    const balance = await view(token, 'storage_balance_of', { account_id: receiverId });
    if (balance === 'no_method' || balance.value !== null)
      return undefined;
    const bounds = await view(token, 'storage_balance_bounds', {});
    const minimum = bounds === 'no_method' || !isRecord(bounds.value) ? undefined : bounds.value['min'];

    return amountOf(minimum, 'storage_balance_bounds');
  };

  const accessKeyNonce = async (): Promise<bigint> => {
    const reply = await read('query', { request_type: 'view_access_key', finality: 'final', account_id: accountId, public_key: publicKeyText });
    if (reply.kind === 'error')
      throw new NearRpcError(`The NEAR RPC refused view_access_key: ${errorNameOf(reply.error)}`, false);
    const result = isRecord(reply.result) ? reply.result : {};
    if (typeof result['error'] === 'string')
      throw new NearRpcError(`The hot wallet's key isn't an access key of ${accountId}`, false);
    const nonce = result['nonce'];
    if ((typeof nonce !== 'number' || !Number.isSafeInteger(nonce) || nonce < 0) && (typeof nonce !== 'string' || !/^\d{1,30}$/.test(nonce)))
      throw new NearRpcError('The NEAR RPC answered an access key without a nonce', false);

    return BigInt(nonce);
  };

  const finalBlockHash = async (): Promise<Uint8Array> => {
    const reply = await read('block', { finality: 'final' });
    if (reply.kind === 'error')
      throw new NearRpcError(`The NEAR RPC refused block: ${errorNameOf(reply.error)}`, false);
    const header = isRecord(reply.result) && isRecord(reply.result['header']) ? reply.result['header'] : {};
    let hash: Uint8Array | undefined;
    try {
      hash = typeof header['hash'] === 'string' ? Uint8Array.from(getBase58Encoder().encode(header['hash'])) : undefined;
    }
    catch {
      hash = undefined;
    }
    if (hash?.length !== 32)
      throw new NearRpcError('The NEAR RPC answered a block without a hash', false);

    return hash;
  };

  return {
    accountId,
    publicKey: publicKeyText,
    balanceOf,
    transfer: async ({ token, receiverId, amount }) => {
      const [onChain, blockHash, last, deposit] = await Promise.all([
        accessKeyNonce(), finalBlockHash(), fromStore(() => store.lastNonce(accountId, publicKeyText)), registrationOf(token, receiverId),
      ]);
      const nonce = (last !== undefined && last > onChain ? last : onChain) + 1n;
      const actions = [
        ...deposit === undefined ? [] : [actionCreators.functionCall('storage_deposit', { account_id: receiverId, registration_only: true }, storageDepositGas, deposit)],
        actionCreators.functionCall(FT_TRANSFER_METHOD, { receiver_id: receiverId, amount: amount.toString() }, DEFAULT_FT_TRANSFER_GAS, ONE_YOCTO),
      ];
      const [digest, signed] = await signer.signTransaction(createTransaction(accountId, publicKey, token, nonce, actions, blockHash));
      await fromStore(() => store.saveNonce(accountId, publicKeyText, nonce));
      const transactionHash = getBase58Decoder().decode(digest);
      const signedBase64 = Buffer.from(signed.encode()).toString('base64');
      const facts = { transactionHash, nonce, registers: deposit !== undefined };
      const done = (verdict: NonNullable<Verdict>): NearTransferOutcome => ({ ...facts, ...verdict });
      const send = (timeoutMs: number) => once('send_tx', { signed_tx_base64: signedBase64, wait_until: 'FINAL' }, timeoutMs);

      const first = await send(sendMs);
      if (first.kind === 'result') {
        const verdict = verdictOf(first.result, token);
        if (verdict)
          return done(verdict);
      }
      else if (first.kind === 'error' && errorNameOf(first.error) === 'INVALID_TRANSACTION')
        return done({ kind: 'failed', reason: `The NEAR node refused the transaction: ${invalidTxKindOf(first.error)}` });

      // No answer to act on: the node may hold it. Looked up until there's evidence, or the budget ends.
      const started = performance.now();
      const left = () => pollBudgetMs - (performance.now() - started);
      const attemptMs = () => Math.max(minimumAttemptMs, Math.min(readMs, left()));
      for (let round = 1; left() > 0; round++) {
        await sleep(Math.min(pollMs, Math.max(0, left())));
        if (left() <= 0)
          break;
        const found = await once('tx', { tx_hash: transactionHash, sender_account_id: accountId, wait_until: 'NONE' }, attemptMs());
        if (found.kind === 'result') {
          const verdict = verdictOf(found.result, token);
          if (verdict)
            return done(verdict);
          continue;
        }
        // Only while the node says it doesn't know the transaction. Any answer to a resend but a final
        // outcome is no evidence: a refusal may come from a node that hasn't seen it land.
        if (found.kind === 'error' && errorNameOf(found.error) === 'UNKNOWN_TRANSACTION' && round % resendEvery === 0 && left() > 0) {
          const again = await send(attemptMs());
          const verdict = again.kind === 'result' ? verdictOf(again.result, token) : undefined;
          if (verdict)
            return done(verdict);
        }
      }

      return done({ kind: 'unknown', reason: `No final outcome within ${pollBudgetMs} ms after the send had no answer` });
    },
  };
};
