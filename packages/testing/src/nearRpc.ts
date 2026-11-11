import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { KeyPair, PublicKey, type KeyPairString } from '@near-js/crypto';
import { encodeDelegateAction, SCHEMA } from '@near-js/transactions';
import { x402Client } from '@x402/core/client';
import type { PaymentPayload, PaymentRequired } from '@x402/core/types';
import { createClientNearSigner } from '@x402/near';
import { ExactNearScheme } from '@x402/near/exact/client';
import { deserialize } from 'borsh';

import { encodeBase58 } from './solanaRpc.js';

export type NearNetwork = 'near:testnet' | 'near:mainnet';

// The code hash `view_account` answers for an account without a contract: 32 zero bytes in base58
export const nearEmptyCodeHash = '11111111111111111111111111111111';

/** An access key's permission, as `view_access_key` answers it. */
export type NearAccessKeyPermission =
  | 'FullAccess'
  | { readonly FunctionCall: { readonly allowance: string | null; readonly receiver_id: string; readonly method_names: readonly string[] } };

/**
 * What the fake does with the next `send_tx` calls, then `confirm` again. A resend of a transaction it
 * holds answers that transaction's outcome, whatever comes next.
 * - `confirm`: applies it and answers its final outcome;
 * - `revert`: applies it, but the token's receipt fails: nonces move, balances and registrations don't;
 * - `refuse`: answers nearcore's `INVALID_TRANSACTION` error, and applies nothing. `invalid-nonce`
 *   first gives the relayer's key the transaction's nonce, as if another transaction had taken it;
 * - `fail`: answers HTTP 503, and applies nothing: the resend after it is a new call;
 * - `timeout`: applies it, as `confirm` does, holds the answer for `timeoutMs`, then answers HTTP 408
 *   with nearcore's `TIMEOUT_ERROR`;
 * - `drop`: never answers, and applies nothing: the node never saw it, and `tx` doesn't know its hash.
 */
export type NearBroadcast = 'confirm' | 'revert' | 'refuse' | 'fail' | 'timeout' | 'drop';

export interface NearBroadcastOptions {
  // How many `send_tx` calls get it. Default: the next one.
  readonly times?: number;
  // A refusal's error. Default: `expired`, a transaction whose block hash is too old.
  readonly refusal?: 'expired' | 'invalid-nonce';
}

export interface NearRpcCall {
  readonly method: string;
  readonly params: unknown;
}

/** The signed delegate action a relayer's transaction carried. */
export interface NearDelegate {
  readonly senderId: string;
  // The token contract
  readonly receiverId: string;
  readonly publicKey: string;
  readonly nonce: bigint;
  readonly maxBlockHeight: bigint;
  // Its `ft_transfer`, when it is one
  readonly transfer: { readonly receiverId: string; readonly amount: bigint } | undefined;
}

/** A transaction the fake applied, as `send_tx` took it. */
export interface NearTransaction {
  readonly hash: string;
  // The relayer, and the key it signed with
  readonly signerId: string;
  readonly publicKey: string;
  readonly nonce: bigint;
  // The delegate action's sender
  readonly receiverId: string;
  readonly delegate: NearDelegate;
  // `success`: the transfer moved. `failure`: the token receipt failed, as `failure` says.
  readonly status: 'success' | 'failure';
  readonly failure: unknown;
  // The `FinalExecutionOutcome` the node answers for it
  readonly outcome: Readonly<Record<string, unknown>>;
}

/** A function call in a transaction the fake applied, as it was signed. */
export interface NearFunctionCall {
  readonly methodName: string;
  // Its arguments as JSON, or undefined when they aren't JSON
  readonly args: unknown;
  readonly gas: bigint;
  // In yoctoNEAR
  readonly deposit: bigint;
}

/**
 * A transaction of function calls an account signed and sent itself, not a relayed delegate action,
 * such as a hot wallet's `storage_deposit` and `ft_transfer` on a token, as `send_tx` took it.
 */
export interface NearDirectTransaction {
  readonly hash: string;
  readonly signerId: string;
  readonly publicKey: string;
  readonly nonce: bigint;
  // The contract it calls
  readonly receiverId: string;
  readonly calls: readonly NearFunctionCall[];
  // `success`: every call applied. `failure`: one failed, as `failure` says, and none applied.
  readonly status: 'success' | 'failure';
  readonly failure: unknown;
  // The `FinalExecutionOutcome` the node answers for it
  readonly outcome: Readonly<Record<string, unknown>>;
}

export interface FakeNearAccount {
  readonly accountId: string;
  // Adds this key to the account, which is created when it's new. Without one, a plain account with no key.
  readonly publicKey?: string;
  // The key's nonce. Default: as the chain sets it for a new key, from the current height.
  readonly nonce?: bigint;
  // Default: FullAccess
  readonly permission?: NearAccessKeyPermission;
  // The account's NEAR, in yoctoNEAR. Default: 10 NEAR for a new account; an existing one keeps its own.
  readonly amount?: bigint;
}

export interface FakeNearToken {
  readonly contractId: string;
  // Atomic balances. An account with a balance is registered.
  readonly balances?: Readonly<Record<string, bigint>>;
  // More accounts registered for storage, with no balance
  readonly registered?: readonly string[];
  // Whether it implements NEP-145's `storage_balance_of`. Default: true.
  readonly storageManagement?: boolean;
}

export interface FakeNearRpc {
  readonly url: string;
  readonly network: NearNetwork;
  // The last block's height. Each `block` call makes a new one.
  readonly height: bigint;
  // Every JSON-RPC call, in order
  readonly calls: readonly NearRpcCall[];
  // Every relayer transaction of a signed delegate action it applied, in order
  readonly transactions: readonly NearTransaction[];
  // Every transaction of function calls it applied, in order
  readonly directTransactions: readonly NearDirectTransaction[];
  addAccount(account: FakeNearAccount): void;
  /** A NEP-141 token contract with NEP-145 storage registrations. */
  addToken(token: FakeNearToken): void;
  /** Sets an account's balance on a token, and registers it. */
  setBalance(contractId: string, accountId: string, amount: bigint): void;
  /** Registers an account for storage on a token. */
  register(contractId: string, accountId: string): void;
  balanceOf(contractId: string, accountId: string): bigint;
  // Undefined: no such key
  nonceOf(accountId: string, publicKey: string): bigint | undefined;
  /** How the next `send_tx` calls are treated. */
  broadcast(outcome: NearBroadcast, options?: NearBroadcastOptions): void;
  /** While true, every call answers HTTP 503, or only the calls of `methods` when given. */
  unavailable(down: boolean, options?: { readonly methods?: readonly string[] }): void;
  /** Back to `confirm` and up, and clears the calls. Accounts, balances, and transactions stay; a dropped call stays unanswered. */
  reset(): void;
  close(): Promise<void>;
}

export interface FakeNearRpcOptions {
  // Default: near:testnet
  readonly network?: NearNetwork;
  // How long a `timeout` holds its answer. Default: 2 s, past the tests' RPC timeouts.
  readonly timeoutMs?: number;
  // The height before the first block. Default: a testnet-like height.
  readonly height?: bigint;
  // The port to listen on. Default: a free one.
  readonly port?: number;
}

// NEAR's access key nonce range: a key starts at (height - 1) × 10^6, and a nonce must stay under height × 10^6
const nonceRange = 1_000_000n;
// A NEP-145 storage deposit on a USDC-like token: 0.00125 NEAR, in yoctoNEAR
const storageDeposit = '1250000000000000000000';
// A new account's NEAR: 10 NEAR, in yoctoNEAR
const defaultAccountAmount = 10n * 10n ** 24n;
const defaultHeight = 200_000_000n;

interface Key {
  nonce: bigint;
  readonly permission: NearAccessKeyPermission;
}

interface Account {
  readonly codeHash: string;
  readonly keys: Map<string, Key>;
  amount: bigint;
}

interface Token {
  readonly balances: Map<string, bigint>;
  readonly registered: Set<string>;
  readonly storageManagement: boolean;
}

// The shapes borsh decodes `SCHEMA.SignedTransaction` into
type Bytes = Uint8Array | readonly number[];

interface BorshPublicKey {
  readonly ed25519Key?: { readonly data: Bytes };
  readonly secp256k1Key?: { readonly data: Bytes };
}

interface BorshSignature {
  readonly ed25519Signature?: { readonly data: Bytes };
  readonly secp256k1Signature?: { readonly data: Bytes };
}

interface BorshFunctionCall {
  readonly methodName: string;
  readonly args: Bytes;
  readonly gas: bigint;
  readonly deposit: bigint;
}

interface BorshDelegateAction {
  readonly senderId: string;
  readonly receiverId: string;
  readonly actions: readonly { readonly functionCall?: BorshFunctionCall }[];
  readonly nonce: bigint;
  readonly maxBlockHeight: bigint;
  readonly publicKey: BorshPublicKey;
}

interface BorshSignedDelegate {
  readonly delegateAction: BorshDelegateAction;
  readonly signature: BorshSignature;
}

interface BorshSignedTransaction {
  readonly transaction: {
    readonly signerId: string;
    readonly publicKey: BorshPublicKey;
    readonly nonce: bigint;
    readonly receiverId: string;
    readonly actions: readonly { readonly signedDelegate?: BorshSignedDelegate; readonly functionCall?: BorshFunctionCall }[];
  };
  readonly signature: BorshSignature;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const sha256 = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash('sha256').update(bytes).digest());

const publicKeyOf = (key: BorshPublicKey): PublicKey => key.ed25519Key
  ? new PublicKey({ keyType: 0, data: Uint8Array.from(key.ed25519Key.data) })
  : new PublicKey({ keyType: 1, data: Uint8Array.from(key.secp256k1Key?.data ?? []) });

const signatureOf = (signature: BorshSignature): Uint8Array => Uint8Array.from(signature.ed25519Signature?.data ?? signature.secp256k1Signature?.data ?? []);

const verifies = (key: PublicKey, message: Uint8Array, signature: BorshSignature): boolean => {
  try {
    return key.verify(message, signatureOf(signature));
  }
  catch {
    return false;
  }
};

// A JSON value as `call_function` answers it: the bytes of its JSON
const resultBytes = (value: unknown): number[] => [...Buffer.from(JSON.stringify(value), 'utf8')];

// A JSON-RPC answer with HTTP 200, another status with an error body, or a status without a body
type Answer =
  | { readonly result: unknown }
  | { readonly error: Record<string, unknown>; readonly status?: number }
  | { readonly status: number }
  | { readonly never: true };

// The structured error a nearcore node answers: a cause the clients match, and a text in `data`
const handlerError = (cause: string, info: Record<string, unknown>, data: unknown): { readonly error: Record<string, unknown> } => ({
  error: { name: 'HANDLER_ERROR', cause: { name: cause, info }, code: -32000, message: 'Server error', data },
});

// What nearcore answers, with HTTP 400, to a request it can't parse or a method it doesn't have
const requestError = (cause: 'PARSE_ERROR' | 'METHOD_NOT_FOUND', data: string): Answer => ({
  status: 400,
  error: { name: 'REQUEST_VALIDATION_ERROR', cause: { name: cause, info: {} }, code: cause === 'PARSE_ERROR' ? -32700 : -32601, message: cause === 'PARSE_ERROR' ? 'Parse error' : 'Method not found', data },
});

// A failed query, as nearcore answers it: HTTP 200, and the error's text in the result
const queryError = (error: string, at: Record<string, unknown>): Answer => ({ result: { error, logs: [], ...at } });

const invalidTransaction = (error: unknown): Answer => handlerError('INVALID_TRANSACTION', isRecord(error) ? error : {}, { TxExecutionError: { InvalidTxError: error } });

// A receipt's failure, as the chain reports an action that failed
const actionError = (kind: unknown, index = 0) => ({ ActionError: { index, kind } });
const panic = (message: string, index = 0) => actionError({ FunctionCallError: { ExecutionError: `Smart contract panicked: ${message}` } }, index);

// A function call's JSON arguments, or undefined
const argsOf = (call: BorshFunctionCall): unknown => {
  try {
    return JSON.parse(Buffer.from(Uint8Array.from(call.args)).toString('utf8'));
  }
  catch {
    return undefined;
  }
};

/**
 * A NEAR node's JSON-RPC on 127.0.0.1, offline: what the x402 NEAR client, the facilitator scheme,
 * its relayer, and the Signer's own transfers call, with nearcore's result and error shapes.
 * - `block`: a new block on each call, its height one more, its hash 32 random bytes in base58.
 * - `query`: `view_account` (the empty code hash for a plain account, a made-up one for a token),
 *   `view_access_key` (nonce and permission), and `call_function` on a token: `ft_balance_of`,
 *   `storage_balance_of`, `storage_balance_bounds` (min and max, both the 0.00125 NEAR deposit), and
 *   `MethodNotFound` for any other method; a token without storage management has neither storage
 *   method. An unknown account is nearcore's `UNKNOWN_ACCOUNT` error; an unknown access key and a
 *   contract's failure are a result with nearcore's error text, as `access key <key> does not exist
 *   while viewing`; a request it can't parse is HTTP 400.
 * - `send_tx`: decodes the signed transaction, checks its signature and raises its key's nonce. A
 *   relayer's transaction carries one signed delegate action: the sender's signature,
 *   `max_block_height`, and nonce, then the inner `ft_transfer` on the token, listed in
 *   `transactions`. A transaction of function calls only, signed with a full-access key, calls the
 *   token directly, in one receipt that applies every call or none: `storage_deposit`, which registers
 *   an account for at least the storage deposit, paid from the signer's NEAR, then `ft_transfer` from
 *   the signer, listed in `directTransactions`. A delegate, call, or transfer problem is a `Failure` in
 *   the token receipt, as an `ActionError` with the failing action's index. The answer is the
 *   `FinalExecutionOutcome`.
 * - `tx` and `EXPERIMENTAL_tx_status`, by `wait_until`: with `NONE`, the outcome of a transaction it
 *   holds or `UNKNOWN_TRANSACTION`; with another level, an unknown one waits, then a 408.
 */
export const startFakeNearRpc = async ({ network = 'near:testnet', timeoutMs = 2_000, height: startHeight = defaultHeight, port: listenPort = 0 }: FakeNearRpcOptions = {}): Promise<FakeNearRpc> => {
  const calls: NearRpcCall[] = [];
  const transactions: NearTransaction[] = [];
  const directTransactions: NearDirectTransaction[] = [];
  // The outcome of each transaction it applied, by hash
  const held = new Map<string, Readonly<Record<string, unknown>>>();
  const accounts = new Map<string, Account>();
  const tokens = new Map<string, Token>();
  const timers = new Set<NodeJS.Timeout>();
  let height = startHeight;
  let blockHash = encodeBase58(randomBytes(32));
  // The scripted outcome, and how many more send_tx calls get it
  let scripted: { outcome: NearBroadcast; left: number; refusal: 'expired' | 'invalid-nonce' } | undefined;
  // Down: every method (true), or these
  let down: boolean | ReadonlySet<string> = false;

  const at = () => ({ block_height: Number(height), block_hash: blockHash });

  const accountOf = (accountId: string): Account => {
    const existing = accounts.get(accountId);
    if (existing)
      return existing;
    const account: Account = { codeHash: nearEmptyCodeHash, keys: new Map(), amount: defaultAccountAmount };
    accounts.set(accountId, account);

    return account;
  };

  const tokenOf = (contractId: string): Token => {
    const token = tokens.get(contractId);
    if (!token)
      throw new Error(`The fake NEAR RPC has no token ${contractId}`);

    return token;
  };

  const newBlock = () => {
    const previous = blockHash;
    height += 1n;
    blockHash = encodeBase58(randomBytes(32));
    const nanoseconds = BigInt(Date.now()) * 1_000_000n;

    return {
      author: 'node.fake.testnet',
      header: { height: Number(height), hash: blockHash, prev_hash: previous, timestamp: Number(nanoseconds), timestamp_nanosec: nanoseconds.toString(), chunks_included: 1 },
      chunks: [],
    };
  };

  // nearcore's structured error for an account it doesn't know
  const unknownAccount = (accountId: string): Answer =>
    handlerError('UNKNOWN_ACCOUNT', { requested_account_id: accountId, ...at() }, `account ${accountId} does not exist while viewing`);

  // As nearcore words a contract call that failed in the VM
  const vmError = (error: string): Answer => queryError(`wasm execution failed with error: FunctionCallError(${error})`, at());

  const callFunction = (accountId: string, method: string, argsBase64: unknown): Answer => {
    if (!accounts.has(accountId))
      return unknownAccount(accountId);
    const token = tokens.get(accountId);
    if (!token)
      return vmError(`CompilationError(CodeDoesNotExist { account_id: AccountId("${accountId}") })`);
    let args: unknown;
    try {
      args = JSON.parse(Buffer.from(String(argsBase64 ?? ''), 'base64').toString('utf8'));
    }
    catch {
      args = undefined;
    }
    const of = isRecord(args) && typeof args['account_id'] === 'string' ? args['account_id'] : undefined;
    const implemented = method === 'ft_balance_of'
      || ((method === 'storage_balance_of' || method === 'storage_balance_bounds') && token.storageManagement);
    if (!implemented)
      return vmError('MethodResolveError(MethodNotFound)');
    if (method === 'storage_balance_bounds')
      return { result: { result: resultBytes({ min: storageDeposit, max: storageDeposit }), logs: [], ...at() } };
    if (of === undefined)
      return vmError('HostError(GuestPanic { panic_msg: "Failed to deserialize input from JSON." })');
    const value = method === 'ft_balance_of'
      ? (token.balances.get(of) ?? 0n).toString()
      : token.registered.has(of) ? { total: storageDeposit, available: '0' } : null;

    return { result: { result: resultBytes(value), logs: [], ...at() } };
  };

  const query = (params: unknown): Answer => {
    const request = isRecord(params) ? params : {};
    const accountId = request['account_id'];
    if (typeof accountId !== 'string')
      return requestError('PARSE_ERROR', 'Failed parsing args: missing field `account_id`');
    switch (request['request_type']) {
      case 'view_account': {
        const account = accounts.get(accountId);
        if (!account)
          return unknownAccount(accountId);

        return { result: { amount: account.amount.toString(), locked: '0', code_hash: account.codeHash, storage_usage: 182, storage_paid_at: 0, ...at() } };
      }
      case 'view_access_key': {
        const publicKey = String(request['public_key'] ?? '');
        const key = accounts.get(accountId)?.keys.get(publicKey);
        if (!key)
          return queryError(`access key ${publicKey} does not exist while viewing`, at());

        return { result: { nonce: Number(key.nonce), permission: key.permission, ...at() } };
      }
      case 'call_function':
        return callFunction(accountId, String(request['method_name'] ?? ''), request['args_base64']);
      default:
        return requestError('PARSE_ERROR', 'Failed parsing args: unknown request_type');
    }
  };

  /**
   * One `ft_transfer` on a token's balances and registrations, from `senderId`, as the `index`th action
   * of its receipt: undefined when it moved the amount, else its failure.
   */
  const ftTransfer = (token: Pick<Token, 'balances' | 'registered'>, senderId: string, call: BorshFunctionCall, index = 0): unknown => {
    if (BigInt(call.deposit) !== 1n)
      return panic('Requires attached deposit of exactly 1 yoctoNEAR', index);
    const args = argsOf(call);
    const receiver = isRecord(args) && typeof args['receiver_id'] === 'string' ? args['receiver_id'] : undefined;
    const amount = isRecord(args) && typeof args['amount'] === 'string' && /^\d+$/.test(args['amount']) ? BigInt(args['amount']) : undefined;
    if (receiver === undefined || amount === undefined)
      return panic('Failed to deserialize input from JSON.', index);
    if (amount === 0n)
      return panic('The amount should be a positive number', index);
    if (receiver === senderId)
      return panic('Sender and receiver should be different', index);
    for (const accountId of [senderId, receiver]) {
      if (!token.registered.has(accountId))
        return panic(`The account ${accountId} is not registered`, index);
    }
    const balance = token.balances.get(senderId) ?? 0n;
    if (balance < amount)
      return panic('The account doesn\'t have enough balance', index);
    token.balances.set(senderId, balance - amount);
    token.balances.set(receiver, (token.balances.get(receiver) ?? 0n) + amount);

    return undefined;
  };

  /** The inner `ft_transfer` receipt on the token: undefined when it moved the amount, else its failure. */
  const transfer = (delegate: BorshDelegateAction): unknown => {
    const [action, ...more] = delegate.actions;
    const call = action?.functionCall;
    if (!call || more.length > 0)
      return panic('the fake token takes one ft_transfer per delegate action');
    const token = tokens.get(delegate.receiverId);
    if (!token)
      return actionError({ FunctionCallError: { CompilationError: { CodeDoesNotExist: { account_id: delegate.receiverId } } } });
    if (call.methodName !== 'ft_transfer')
      return actionError({ FunctionCallError: { MethodResolveError: 'MethodNotFound' } });

    return ftTransfer(token, delegate.senderId, call);
  };

  /**
   * A transaction's function calls on a token, in one receipt, as the chain applies it: every call
   * applies, or none does. `storage_deposit` registers an account, its own or `account_id`, for at
   * least the storage deposit, and keeps only that much with `registration_only`; an account already
   * registered gets its deposit back. `ft_transfer` moves the amount from the signer. The signer's
   * NEAR pays the deposits. Undefined when they applied, else the failure.
   */
  const applyCalls = (signerId: string, contractId: string, calls: readonly BorshFunctionCall[], revert: boolean): unknown => {
    const token = tokens.get(contractId);
    if (!token)
      return actionError({ FunctionCallError: { CompilationError: { CodeDoesNotExist: { account_id: contractId } } } });
    if (revert)
      return panic('The transfer was reverted', calls.length - 1);
    // Applied to copies, kept when every call succeeded
    const state = { balances: new Map(token.balances), registered: new Set(token.registered) };
    let kept = 0n;
    for (const [index, call] of calls.entries()) {
      if (call.methodName === 'ft_transfer') {
        const failure = ftTransfer(state, signerId, call, index);
        if (failure !== undefined)
          return failure;
        kept += 1n;
        continue;
      }
      if (call.methodName !== 'storage_deposit' || !token.storageManagement)
        return actionError({ FunctionCallError: { MethodResolveError: 'MethodNotFound' } }, index);
      const args = argsOf(call);
      const accountId = isRecord(args) && typeof args['account_id'] === 'string' ? args['account_id'] : signerId;
      if (state.registered.has(accountId))
        continue;
      if (BigInt(call.deposit) < BigInt(storageDeposit))
        return panic('The attached deposit is less than the minimum storage balance', index);
      state.registered.add(accountId);
      kept += isRecord(args) && args['registration_only'] === true ? BigInt(storageDeposit) : BigInt(call.deposit);
    }
    token.balances.clear();
    for (const [accountId, amount] of state.balances)
      token.balances.set(accountId, amount);
    for (const accountId of state.registered)
      token.registered.add(accountId);
    accountOf(signerId).amount -= kept;

    return undefined;
  };

  /** The relayer's one signed delegate action, applied as the chain does: undefined when it landed, else its failure. */
  const applyDelegate = (receiverId: string, signed: BorshSignedDelegate, revert: boolean): unknown => {
    const delegate = signed.delegateAction;
    const key = publicKeyOf(delegate.publicKey);
    if (!verifies(key, sha256(encodeDelegateAction(delegate as unknown as Parameters<typeof encodeDelegateAction>[0])), signed.signature))
      return actionError('DelegateActionInvalidSignature');
    if (BigInt(delegate.maxBlockHeight) < height)
      return actionError('DelegateActionExpired');
    if (delegate.senderId !== receiverId)
      return actionError({ DelegateActionSenderDoesNotMatchTxReceiver: { sender_id: delegate.senderId, receiver_id: receiverId } });
    const accessKey = accounts.get(delegate.senderId)?.keys.get(key.toString());
    if (!accessKey)
      return actionError({ DelegateActionAccessKeyError: { AccessKeyNotFound: { account_id: delegate.senderId, public_key: key.toString() } } });
    const nonce = BigInt(delegate.nonce);
    if (nonce <= accessKey.nonce)
      return actionError({ DelegateActionInvalidNonce: { delegate_nonce: Number(nonce), ak_nonce: Number(accessKey.nonce) } });
    if (nonce >= height * nonceRange)
      return actionError({ DelegateActionNonceTooLarge: { delegate_nonce: Number(nonce), upper_bound: Number(height * nonceRange) } });
    if (accessKey.permission !== 'FullAccess')
      return actionError({ DelegateActionAccessKeyError: 'DepositWithFunctionCall' });
    accessKey.nonce = nonce;

    return revert ? panic('The transfer was reverted') : transfer(delegate);
  };

  const delegateOf = (signed: BorshSignedDelegate): NearDelegate => {
    const delegate = signed.delegateAction;
    const call = delegate.actions.length === 1 ? delegate.actions[0]?.functionCall : undefined;
    let args: unknown;
    try {
      args = call?.methodName === 'ft_transfer' ? JSON.parse(Buffer.from(Uint8Array.from(call.args)).toString('utf8')) : undefined;
    }
    catch {
      args = undefined;
    }
    const receiver = isRecord(args) ? args['receiver_id'] : undefined;
    const amount = isRecord(args) ? args['amount'] : undefined;

    return {
      senderId: delegate.senderId,
      receiverId: delegate.receiverId,
      publicKey: publicKeyOf(delegate.publicKey).toString(),
      nonce: BigInt(delegate.nonce),
      maxBlockHeight: BigInt(delegate.maxBlockHeight),
      transfer: typeof receiver === 'string' && typeof amount === 'string' && /^\d+$/.test(amount) ? { receiverId: receiver, amount: BigInt(amount) } : undefined,
    };
  };

  // The token's receipt executes on `executorId`. `moved`: the ft_transfer it logs when it succeeded.
  const outcomeOf = (
    hash: string, signed: BorshSignedTransaction, signerKey: string, executorId: string, moved: { readonly from: string; readonly to: string; readonly amount: bigint } | undefined,
    failure: unknown,
  ): Record<string, unknown> => {
    const { transaction } = signed;
    const receiptId = encodeBase58(sha256(Buffer.from(`${hash}:token`)));
    const status = failure === undefined ? { SuccessValue: '' } : { Failure: failure };
    const logs = failure === undefined && moved
      ? [`EVENT_JSON:${JSON.stringify({
        standard: 'nep141', version: '1.0.0', event: 'ft_transfer',
        data: [{ old_owner_id: moved.from, new_owner_id: moved.to, amount: moved.amount.toString() }],
      })}`]
      : [];
    const metadata = { version: 1, gas_profile: null };

    return {
      final_execution_status: 'FINAL',
      status,
      transaction: {
        hash, signer_id: transaction.signerId, public_key: signerKey, nonce: Number(transaction.nonce), receiver_id: transaction.receiverId, priority_fee: 0,
        signature: `ed25519:${encodeBase58(signatureOf(signed.signature))}`,
      },
      transaction_outcome: {
        id: hash, block_hash: blockHash, proof: [],
        outcome: {
          executor_id: transaction.signerId, gas_burnt: 2_428_000_000_000, tokens_burnt: '242800000000000000000', logs: [], receipt_ids: [receiptId],
          status: { SuccessReceiptId: receiptId }, metadata,
        },
      },
      receipts_outcome: [{
        id: receiptId, block_hash: blockHash, proof: [],
        outcome: { executor_id: executorId, gas_burnt: 3_000_000_000_000, tokens_burnt: '300000000000000000000', logs, receipt_ids: [], status, metadata },
      }],
    };
  };

  // The scripted outcome of this send_tx call, or `confirm`
  const nextOutcome = () => {
    const current = scripted;
    if (!current)
      return { outcome: 'confirm' as NearBroadcast, refusal: 'expired' as const };
    current.left -= 1;
    if (current.left <= 0)
      scripted = undefined;

    return current;
  };

  const sendTransaction = async (params: unknown): Promise<Answer> => {
    const base64 = isRecord(params) ? params['signed_tx_base64'] : undefined;
    if (typeof base64 !== 'string')
      return requestError('PARSE_ERROR', 'Failed parsing args: missing field `signed_tx_base64`');
    const raw = Buffer.from(base64, 'base64');
    let signed: BorshSignedTransaction;
    try {
      signed = deserialize(SCHEMA.SignedTransaction, raw) as unknown as BorshSignedTransaction;
    }
    catch {
      return requestError('PARSE_ERROR', 'Failed to decode transaction');
    }
    // The hash of the borsh transaction: the bytes before its signature, a tag and 64 or 65 bytes
    const message = raw.subarray(0, raw.length - 1 - signatureOf(signed.signature).length);
    const hash = encodeBase58(sha256(message));
    // A resend of a transaction it applied: the same outcome
    const known = held.get(hash);
    if (known)
      return { result: known };

    const { outcome, refusal } = nextOutcome();
    if (outcome === 'fail')
      return { status: 503 };
    if (outcome === 'drop')
      return { never: true };

    const { transaction } = signed;
    const signerKey = publicKeyOf(transaction.publicKey);
    const key = accounts.get(transaction.signerId)?.keys.get(signerKey.toString());
    if (outcome === 'refuse') {
      if (refusal === 'expired')
        return invalidTransaction('Expired');
      // Another transaction of the signer's took the nonce first
      if (key && key.nonce < BigInt(transaction.nonce))
        key.nonce = BigInt(transaction.nonce);
    }
    if (!key)
      return invalidTransaction({ InvalidAccessKeyError: { AccessKeyNotFound: { account_id: transaction.signerId, public_key: signerKey.toString() } } });
    if (!verifies(signerKey, sha256(message), signed.signature))
      return invalidTransaction('InvalidSignature');
    if (BigInt(transaction.nonce) <= key.nonce)
      return invalidTransaction({ InvalidNonce: { tx_nonce: Number(transaction.nonce), ak_nonce: Number(key.nonce) } });
    const [action, ...more] = transaction.actions;
    const calls = transaction.actions.map(item => item.functionCall).filter(call => call !== undefined);
    const direct = transaction.actions.length > 0 && calls.length === transaction.actions.length;
    if (!direct && (!action?.signedDelegate || more.length > 0))
      return handlerError('INVALID_TRANSACTION', {}, 'The fake NEAR RPC takes one signed delegate action, or function calls only, per transaction');
    // Function calls attach deposits, which only a full-access key may, and the signer's NEAR pays them
    const deposits = calls.reduce((sum, call) => sum + BigInt(call.deposit), 0n);
    if (direct && key.permission !== 'FullAccess')
      return invalidTransaction({ InvalidAccessKeyError: 'DepositWithFunctionCall' });
    if (direct && accountOf(transaction.signerId).amount < deposits)
      return invalidTransaction({ NotEnoughBalance: { signer_id: transaction.signerId, balance: accountOf(transaction.signerId).amount.toString(), cost: deposits.toString() } });
    key.nonce = BigInt(transaction.nonce);

    let result: Readonly<Record<string, unknown>>;
    if (direct) {
      const failure = applyCalls(transaction.signerId, transaction.receiverId, calls, outcome === 'revert');
      const summaries = calls.map(call => ({ methodName: call.methodName, args: argsOf(call), gas: BigInt(call.gas), deposit: BigInt(call.deposit) }));
      const moved = summaries.find(call => call.methodName === 'ft_transfer')?.args;
      const entry: NearDirectTransaction = {
        hash, signerId: transaction.signerId, publicKey: signerKey.toString(), nonce: BigInt(transaction.nonce), receiverId: transaction.receiverId, calls: summaries,
        status: failure === undefined ? 'success' : 'failure', failure,
        outcome: outcomeOf(hash, signed, signerKey.toString(), transaction.receiverId, isRecord(moved) && typeof moved['receiver_id'] === 'string' && typeof moved['amount'] === 'string'
          ? { from: transaction.signerId, to: moved['receiver_id'], amount: BigInt(moved['amount']) }
          : undefined, failure),
      };
      directTransactions.push(entry);
      result = entry.outcome;
    }
    else {
      const signedDelegate = action!.signedDelegate!;
      const failure = applyDelegate(transaction.receiverId, signedDelegate, outcome === 'revert');
      const delegate = delegateOf(signedDelegate);
      const moved = delegate.transfer && { from: delegate.senderId, to: delegate.transfer.receiverId, amount: delegate.transfer.amount };
      const entry: NearTransaction = {
        hash, signerId: transaction.signerId, publicKey: signerKey.toString(), nonce: BigInt(transaction.nonce), receiverId: transaction.receiverId, delegate,
        status: failure === undefined ? 'success' : 'failure', failure, outcome: outcomeOf(hash, signed, signerKey.toString(), delegate.receiverId, moved, failure),
      };
      transactions.push(entry);
      result = entry.outcome;
    }
    held.set(hash, result);
    if (outcome === 'timeout') {
      await hold();

      // As nearcore answers a transaction that isn't final within its own wait
      return { status: 408, ...handlerError('TIMEOUT_ERROR', {}, 'Timeout') };
    }

    return { result };
  };

  const hold = () => new Promise<void>(resolve => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      resolve();
    }, timeoutMs);
    timers.add(timer);
  });

  /**
   * As nearcore's `tx_status_fetch`: with `wait_until: NONE`, at once, the outcome it holds or
   * UNKNOWN_TRANSACTION. With another level (nearcore's default, EXECUTED_OPTIMISTIC, when none is
   * given), a transaction it holds answers its outcome, final at once here, and one it hasn't seen
   * holds for `timeoutMs`, then answers HTTP 408 with TIMEOUT_ERROR.
   */
  const transactionStatus = async (params: unknown, withReceipts: boolean): Promise<Answer> => {
    const hash = isRecord(params) ? params['tx_hash'] : Array.isArray(params) ? params[0] : undefined;
    const waitUntil = isRecord(params) && typeof params['wait_until'] === 'string' ? params['wait_until'] : 'EXECUTED_OPTIMISTIC';
    const entry = typeof hash === 'string' ? held.get(hash) : undefined;
    if (entry)
      return { result: withReceipts ? { ...entry, receipts: [] } : entry };
    if (waitUntil === 'NONE')
      return handlerError('UNKNOWN_TRANSACTION', { requested_transaction_hash: hash ?? null }, `Transaction ${String(hash)} doesn't exist`);
    await hold();

    return { status: 408, ...handlerError('TIMEOUT_ERROR', {}, 'Timeout') };
  };

  const answer = async (method: string, params: unknown): Promise<Answer> => {
    switch (method) {
      case 'block':
        return { result: newBlock() };
      case 'query':
        return query(params);
      case 'send_tx':
        return sendTransaction(params);
      case 'tx':
        return transactionStatus(params, false);
      case 'EXPERIMENTAL_tx_status':
        return transactionStatus(params, true);
      default:
        return requestError('METHOD_NOT_FOUND', method);
    }
  };

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      void (async () => {
        let body: { id?: unknown; method?: unknown; params?: unknown };
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof body;
        }
        catch {
          response.writeHead(400).end();
          return;
        }
        const method = String(body.method ?? '');
        calls.push({ method, params: body.params });
        if (down === true || (down !== false && down.has(method))) {
          response.writeHead(503).end();
          return;
        }
        const result = await answer(method, body.params);
        if (response.destroyed || 'never' in result)
          return;
        if ('error' in result) {
          response.writeHead(result.status ?? 200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id ?? null, error: result.error }));
          return;
        }
        if ('status' in result) {
          response.writeHead(result.status).end();
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id ?? null, result: result.result }));
      })();
    });
  });
  await new Promise<void>(resolve => server.listen(listenPort, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    network,
    get height() {
      return height;
    },
    calls,
    transactions,
    directTransactions,
    addAccount: ({ accountId, publicKey, nonce, permission = 'FullAccess', amount }) => {
      const account = accountOf(accountId);
      if (amount !== undefined)
        account.amount = amount;
      if (publicKey !== undefined)
        account.keys.set(publicKey, { nonce: nonce ?? (height - 1n) * nonceRange, permission });
    },
    addToken: ({ contractId, balances = {}, registered = [], storageManagement = true }) => {
      // A made-up code hash: the contract has code
      const existing = accounts.get(contractId);
      accounts.set(contractId, {
        codeHash: encodeBase58(sha256(Buffer.from(`token:${contractId}`))), keys: existing?.keys ?? new Map(), amount: existing?.amount ?? defaultAccountAmount,
      });
      const entries = Object.entries(balances);
      tokens.set(contractId, { balances: new Map(entries), registered: new Set([...entries.map(([accountId]) => accountId), ...registered]), storageManagement });
    },
    setBalance: (contractId, accountId, amount) => {
      const token = tokenOf(contractId);
      token.balances.set(accountId, amount);
      token.registered.add(accountId);
    },
    register: (contractId, accountId) => {
      tokenOf(contractId).registered.add(accountId);
    },
    balanceOf: (contractId, accountId) => tokenOf(contractId).balances.get(accountId) ?? 0n,
    nonceOf: (accountId, publicKey) => accounts.get(accountId)?.keys.get(publicKey)?.nonce,
    broadcast: (outcome, { times = 1, refusal = 'expired' } = {}) => {
      scripted = outcome === 'confirm' || times <= 0 ? undefined : { outcome, left: times, refusal };
    },
    unavailable: (value, { methods } = {}) => {
      down = value && methods ? new Set(methods) : value;
    },
    reset: () => {
      calls.length = 0;
      scripted = undefined;
      down = false;
    },
    close: async () => {
      for (const timer of timers)
        clearTimeout(timer);
      timers.clear();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
};

/** An ed25519 key pair made in the test, as NEAR writes it: `ed25519:` and base58. */
export interface NearTestKey {
  readonly publicKey: string;
  readonly secretKey: KeyPairString;
}

export const generateNearKey = (): NearTestKey => {
  const pair = KeyPair.fromRandom('ed25519');

  return { publicKey: pair.getPublicKey().toString(), secretKey: pair.toString() };
};

export interface TestNearPayerOptions {
  readonly accountId: string;
  // The fake node: the payer's key is added to it, and the client signer reads it
  readonly rpc: FakeNearRpc;
  // The key's nonce on the fake. Default: as the chain sets it for a new key.
  readonly nonce?: bigint;
}

export interface TestNearPayer {
  readonly accountId: string;
  readonly publicKey: string;
  // The x402 SDK's NEAR client scheme, signing with the payer's key
  readonly scheme: ExactNearScheme;
  /**
   * The x402 payment for a 402, as the SDK's client builds it: a signed delegate action for its NEAR
   * option. Without the client's spend controls, so it signs for any token and amount it's asked.
   */
  paymentFor(required: PaymentRequired): Promise<PaymentPayload>;
}

/** A buyer on NEAR: a key generated in the test, added to the fake node, and the x402 SDK's NEAR client. */
export const createTestNearPayer = ({ accountId, rpc, nonce }: TestNearPayerOptions): TestNearPayer => {
  const key = generateNearKey();
  rpc.addAccount({ accountId, publicKey: key.publicKey, ...nonce === undefined ? {} : { nonce } });
  const scheme = new ExactNearScheme(createClientNearSigner({ accountId, secretKey: key.secretKey, rpcUrls: { [rpc.network]: rpc.url } }));

  return {
    accountId,
    publicKey: key.publicKey,
    scheme,
    paymentFor: required => new x402Client().register(rpc.network, scheme).setSpendControls(false).createPaymentPayload(required),
  };
};
