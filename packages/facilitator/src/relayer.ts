import { createHash } from 'node:crypto';

import { KeyPair, KeyType, type KeyPairString, type PublicKey } from '@near-js/crypto';
import { JsonRpcProvider } from '@near-js/providers';
import { actionCreators, createTransaction, encodeTransaction, SCHEMA, Signature, SignedTransaction, type SignedDelegate } from '@near-js/transactions';
import { baseDecode, baseEncode } from '@near-js/utils';
import { settlementCacheKey, type FacilitatorNearSigner, type NearReceiptStatus, type NearSettlementOutcome } from '@x402/near';
import { deserialize } from 'borsh';

import { AnyfareError, TimeoutError, withTimeout, type Secret } from '@anyfare/common';

// The relayer's provider repeats a failed call once, a tenth of a second later, never for minutes
const rpcRetries = { retries: 2, wait: 100, backoff: 2 } as const;
const defaultPollMs = 1_000;
// While the node doesn't know a transaction we sent, it gets the same bytes again every fifth poll
const resendEvery = 5;
// Blocks past a delegate action's max_block_height after which its transaction is taken as never included
const defaultExpiryBlocks = 10n;
// The NEAR a relayer needs for its transactions' gas: 0.05 NEAR, in yoctoNEAR
export const minimumRelayerBalance = 5n * 10n ** 22n;

// The relayer's key is wrong: neither the key nor the SDK's message about it is kept
export class InvalidRelayerKeyError extends AnyfareError {
  readonly code = 'invalid_relayer_key';

  constructor() {
    super('invalid relayer key');
  }
}

export class NearRpcTimeoutError extends Error {
  override readonly name = 'NearRpcTimeoutError';

  constructor(timeoutMs: number) {
    super(`The NEAR RPC didn't answer within ${timeoutMs} ms`);
  }
}

// The facilitator is closing: a poll stops, with the transaction still in flight
export class RelayerStoppedError extends Error {
  override readonly name = 'RelayerStoppedError';

  constructor() {
    super('The facilitator stopped with the transaction in flight');
  }
}

// The settle was cancelled, or the facilitator is closing, before its transaction was signed: nothing is sent
export class SettleCancelledError extends Error {
  override readonly name = 'SettleCancelledError';

  constructor() {
    super('The settle was cancelled before its transaction was signed');
  }
}

// The node itself says it doesn't know the transaction, and its delegate action has expired
export const notIncludedMessage = 'not included before the delegate action expired';

/** An operation within `timeoutMs`, else NearRpcTimeoutError. The operation itself isn't cancelled. */
export const within = async <TResult>(timeoutMs: number, operation: () => Promise<TResult>): Promise<TResult> => {
  try {
    return await withTimeout(() => operation(), { timeoutMs });
  }
  catch (error) {
    if (error instanceof TimeoutError)
      throw new NearRpcTimeoutError(timeoutMs);
    throw error;
  }
};

// As the x402 SDK's NEAR signer (2.30.0) classifies the RPC's errors
const errorText = (error: unknown): string => {
  if (error instanceof Error)
    return `${error.name}:${error.message}`;
  try {
    return JSON.stringify(error);
  }
  catch {
    return String(error);
  }
};
const isAccountMissing = (error: unknown) => /UNKNOWN_ACCOUNT|does ?n.t exist|doesn't exist|does not exist/i.test(errorText(error));
const isAccessKeyMissing = (error: unknown) => /UNKNOWN_ACCESS_KEY|access key .* (not found|does not exist|doesn't exist)/i.test(errorText(error));
const isMethodNotFound = (error: unknown) => /MethodNotFound|MethodResolveError|MethodEmptyName/i.test(errorText(error));

type PermissionKind = 'FullAccess' | 'FunctionCall' | 'Unknown';

const permissionKindOf = (permission: unknown): PermissionKind => {
  if (permission === 'FullAccess')
    return 'FullAccess';
  if (typeof permission === 'object' && permission !== null && ('FunctionCall' in permission || 'functionCall' in permission))
    return 'FunctionCall';

  return 'Unknown';
};

interface ReceiptStatus {
  readonly SuccessValue?: string;
  readonly Failure?: unknown;
}

interface ExecutionOutcome {
  readonly status?: unknown;
  readonly final_execution_status?: string;
  readonly transaction_outcome?: { readonly id?: string };
  readonly receipts_outcome?: readonly { readonly outcome?: { readonly executor_id?: string; readonly status?: unknown } }[];
}

/** The inner `ft_transfer` receipt's status, as the SDK reads a final outcome. */
export const interpretSettlementOutcome = (outcome: ExecutionOutcome, tokenContractId: string): NearReceiptStatus => {
  const failureOf = (status: unknown): unknown =>
    typeof status === 'object' && status !== null && 'Failure' in status && Boolean((status as ReceiptStatus).Failure) ? (status as ReceiptStatus).Failure : undefined;
  const failure = failureOf(outcome.status);
  if (failure !== undefined)
    return { kind: 'failure', error: JSON.stringify(failure) };
  for (const receipt of outcome.receipts_outcome ?? []) {
    const receiptFailure = failureOf(receipt.outcome?.status);
    if (receiptFailure !== undefined)
      return { kind: 'failure', error: JSON.stringify(receiptFailure) };
  }
  const tokenStatus = (outcome.receipts_outcome ?? []).find(receipt => receipt.outcome?.executor_id === tokenContractId)?.outcome?.status;
  if (typeof tokenStatus === 'object' && tokenStatus !== null && 'SuccessValue' in tokenStatus)
    return { kind: 'success', value: (tokenStatus as ReceiptStatus).SuccessValue ?? '' };

  return { kind: 'failure', error: 'inner_ft_transfer_receipt_not_successful' };
};

// The node's structured refusals of a transaction (nearcore's InvalidTxError and its kinds): it took nothing
const refusals: ReadonlySet<string> = new Set([
  'InvalidTxError', 'InvalidAccessKeyError', 'AccessKeyNotFound', 'ReceiverMismatch', 'MethodNameMismatch', 'RequiresFullAccess', 'NotEnoughAllowance',
  'DepositWithFunctionCall', 'InvalidSignerId', 'SignerDoesNotExist', 'InvalidNonce', 'NonceTooLarge', 'InvalidReceiverId', 'InvalidSignature',
  'NotEnoughBalance', 'LackBalanceForState', 'CostOverflow', 'InvalidChain', 'Expired', 'TransactionSizeExceeded', 'ShardCongested', 'ShardStuck',
]);

const typeOf = (error: unknown): string | undefined => {
  const type = error instanceof Error ? (error as { type?: unknown }).type : undefined;

  return typeof type === 'string' ? type : undefined;
};

const isRefusal = (error: unknown): boolean => refusals.has(typeOf(error) ?? '');
// How near-js words nearcore's UNKNOWN_TRANSACTION: the text of its `data`, `Transaction <hash> doesn't exist`
const isUnknownTransaction = (error: unknown, hash: string): boolean =>
  /UNKNOWN_TRANSACTION/.test(errorText(error)) || (errorText(error).includes(hash) && /doesn't exist|does not exist/.test(errorText(error)));
const isInvalidNonce = (error: unknown): boolean =>
  typeOf(error) === 'InvalidNonce' || /must be larger than nonce of the used access key/.test(errorText(error));

/** The relayer's account and key on chain. */
export interface RelayerState {
  // Its NEAR, in yoctoNEAR. Undefined: the account doesn't exist.
  readonly amount: bigint | undefined;
  // The key's permission. Undefined: it isn't one of the account's keys.
  readonly key: PermissionKind | undefined;
}

/** A relayer transaction, signed and about to be sent. */
export interface SignedRelayerTransaction {
  // The settlement key: a hash of the signed delegate action's bytes
  readonly key: string;
  // The transaction's hash
  readonly transaction: string;
  readonly payer: string;
  readonly maxBlockHeight: bigint;
  readonly nonce: bigint;
}

/** What the relayer tells a settle about its transaction, and reads from it. */
export interface RelayerFlight {
  // Set by the settle: the relayer won't sign once it's true
  readonly cancelled: boolean;
  /** Signed: the hash, before the transaction is sent. Signed again after an InvalidNonce, the new hash. */
  signed(transaction: SignedRelayerTransaction): void;
  /** The first send had no answer: the transaction is polled from now on, and the relayer can take the next settle. */
  sendPhaseOver(): void;
  /**
   * The settle ends without an outcome of the buyer's payment: the node refused our transaction
   * (`refused`), the relayer couldn't read the chain to sign (`unavailable`), or the facilitator
   * stopped with the transaction in flight (`stopped`).
   */
  abandoned(reason: 'refused' | 'unavailable' | 'stopped'): void;
}

export interface RelayerOptions {
  readonly accountId: string;
  // Its full-access key, `ed25519:` and base58
  readonly secretKey: Secret;
  readonly network: string;
  readonly rpcUrl: string;
  // Each read
  readonly readMs: number;
  // How long a send waits for the node's answer before it polls the transaction instead
  readonly sendMs: number;
  // Default: a second. Ten times as long once the delegate action has expired.
  readonly pollMs?: number;
  // Default: 10 blocks
  readonly expiryBlocks?: bigint;
  // The settle the relayer works for now, if any
  readonly flight?: () => RelayerFlight | undefined;
  // Each final height it reads
  readonly onHeight?: (height: bigint) => void;
}

export interface Relayer extends FacilitatorNearSigner {
  readonly accountId: string;
  readonly publicKey: string;
  /** The account's NEAR and the key's permission, read now. */
  state(): Promise<RelayerState>;
  /** Signs nothing more, and ends the polls of transactions whose outcome is unknown. */
  stop(): void;
  readonly stopped: boolean;
}

const final = { finality: 'final' } as const;

const fromBase64 = (value: string): Uint8Array => new Uint8Array(Buffer.from(value, 'base64'));

// What the node says about a transaction we sent
type Lookup =
  | { readonly kind: 'final'; readonly outcome: ExecutionOutcome }
  // The node answered UNKNOWN_TRANSACTION
  | { readonly kind: 'unknown' }
  // The node knows it, not final yet
  | { readonly kind: 'known' }
  // No answer: a timeout, a 5xx, a 408
  | { readonly kind: 'none' };

/**
 * Whether an outcome is final: only when the node says so. An outcome without `final_execution_status`
 * isn't trusted: a delegate action's top-level status turns `SuccessValue` before its inner receipt
 * exists, so reading the statuses would call a transfer that lands a block later failed.
 */
const isFinal = (outcome: ExecutionOutcome): boolean => outcome.final_execution_status === 'FINAL';

/**
 * The relayer, as the x402 SDK's NEAR facilitator signer (`createFacilitatorNearSigner` of @x402/near
 * 2.30.0) does it, method by method, over our own NEAR RPC client, with these changes:
 * - The client repeats a failed call once, never for minutes, and each read has `readMs`.
 * - It signs as near-js's `KeyPairSigner.signTransaction` does, in one step with the flight's checks:
 *   a cancelled settle is never signed, and the flight gets the hash before the transaction is sent.
 * - Its nonce is the higher of the key's nonce on chain and the last one it sent, plus one, so a
 *   transaction still in flight never shares a nonce with the next.
 * - A refusal of the first send for the nonce is signed again with a new one and sent once more.
 *   Another refusal, or any other refusal of the node, fails the settle: nothing was included, and
 *   the flight is abandoned as refused, so nothing is remembered and the signature can be used again.
 * - When the first send has no answer (no reply within `sendMs`, a 5xx, a 408, a dropped connection),
 *   the send phase is over and the outcome is unknown: it polls the transaction every `pollMs`.
 *   Lookups ask with `wait_until: NONE`, the only level at which nearcore answers UNKNOWN_TRANSACTION
 *   for a transaction it hasn't seen. While the node says it doesn't know it, the same signed bytes go
 *   again every fifth poll: the node takes a hash once, and a nonce once, so a resend never doubles a
 *   transfer. A resend refused for its nonce, with nothing of ours landed, means a later transaction
 *   of ours took it: abandoned as refused. Any other refusal of a resend is no answer.
 * - The poll ends on evidence only: a final outcome, or the node saying it doesn't know the
 *   transaction once the final height has passed the delegate action's max_block_height by
 *   `expiryBlocks`, when it can no longer execute: `not included before the delegate action
 *   expired`. While lookups get no answer, it goes on, ten times slower past the expiry.
 * A bad key reports `invalid relayer key` only: near-js's errors may quote it.
 *
 * A known limit: the outcomes and the last nonce live in memory. A settle repeated after a restart
 * while its first transaction isn't final yet sends the delegate action again: the second
 * transaction's inner receipt fails `DelegateActionInvalidNonce`, so nothing moves twice, but the
 * relayer pays its gas.
 */
export const createRelayer = ({
  accountId, secretKey, network, rpcUrl, readMs, sendMs, pollMs = defaultPollMs, expiryBlocks = defaultExpiryBlocks, flight: flightOf = () => undefined, onHeight,
}: RelayerOptions): Relayer => {
  let keyPair: KeyPair;
  let publicKey: PublicKey;
  try {
    keyPair = KeyPair.fromString(secretKey.expose() as KeyPairString);
    publicKey = keyPair.getPublicKey();
  }
  catch {
    throw new InvalidRelayerKeyError();
  }
  const provider = new JsonRpcProvider({ url: rpcUrl }, rpcRetries);
  // The highest nonce sent since start
  let lastNonce = 0n;
  let stopped = false;
  const sleeping = new Set<() => void>();

  const sleep = (ms: number) => new Promise<void>(resolve => {
    const wake = () => {
      clearTimeout(timer);
      sleeping.delete(wake);
      resolve();
    };
    const timer = setTimeout(wake, ms);
    sleeping.add(wake);
  });

  const onNetwork = (name: string): void => {
    if (name !== network)
      throw new Error(`Unsupported NEAR network: ${name}`);
  };

  const readBlock = async () => {
    const block = await within(readMs, () => provider.block(final));
    onHeight?.(BigInt(block.header.height));

    return block;
  };

  const viewAccessKey = async (id: string, key: PublicKey | string) => {
    try {
      const accessKey = await within(readMs, () => provider.viewAccessKey(id, key, final));

      return { nonce: BigInt(accessKey.nonce), permissionKind: permissionKindOf(accessKey.permission) };
    }
    catch (error) {
      if (isAccessKeyMissing(error))
        return null;
      throw error;
    }
  };

  const viewAccount = async (id: string) => {
    try {
      return await within(readMs, () => provider.viewAccount(id, final));
    }
    catch (error) {
      if (isAccountMissing(error))
        return null;
      throw error;
    }
  };

  // With `NONE`, the node answers at once: what it holds, or UNKNOWN_TRANSACTION. With any other level it
  // waits for that level, and answers a 408 for a transaction it hasn't seen: never an answer to act on.
  const lookup = async (hash: string): Promise<Lookup> => {
    try {
      const outcome = await within(readMs, () => provider.txStatus(hash, accountId, 'NONE')) as ExecutionOutcome;

      return isFinal(outcome) ? { kind: 'final', outcome } : { kind: 'known' };
    }
    catch (error) {
      return isUnknownTransaction(error, hash) ? { kind: 'unknown' } : { kind: 'none' };
    }
  };

  const settlementOf = (hash: string, outcome: ExecutionOutcome, tokenContractId: string): NearSettlementOutcome => ({
    transaction: outcome.transaction_outcome?.id ?? hash,
    innerReceipt: interpretSettlementOutcome(outcome, tokenContractId),
  });

  /** The first transaction among `hashes` that's final now. */
  const landedOf = async (hashes: readonly string[]): Promise<{ readonly hash: string; readonly outcome: ExecutionOutcome } | undefined> => {
    for (const hash of hashes) {
      const found = await lookup(hash);
      if (found.kind === 'final')
        return { hash, outcome: found.outcome };
    }

    return undefined;
  };

  /** A transaction whose send had no answer, polled until there's evidence of its outcome. */
  const untilKnown = async (
    hash: string, signedTransaction: SignedTransaction, signed: readonly string[], maxBlockHeight: bigint, tokenContractId: string, flight: RelayerFlight | undefined,
  ): Promise<NearSettlementOutcome> => {
    const stop = (): never => {
      flight?.abandoned('stopped');
      throw new RelayerStoppedError();
    };
    for (let round = 1; ; round++) {
      if (stopped)
        stop();
      const found = await lookup(hash);
      if (found.kind === 'final')
        return settlementOf(hash, found.outcome, tokenContractId);
      let height: bigint | undefined;
      try {
        height = BigInt((await readBlock()).header.height);
      }
      catch {
        height = undefined;
      }
      const expired = height !== undefined && height > maxBlockHeight + expiryBlocks;
      if (found.kind === 'unknown' && expired) {
        // The node doesn't know it, and its delegate action can no longer execute. Once more, in case it became final just now.
        const last = await lookup(hash);
        if (last.kind === 'final')
          return settlementOf(hash, last.outcome, tokenContractId);
        if (last.kind === 'unknown')
          throw new Error(notIncludedMessage);
      }
      if (found.kind === 'unknown' && !expired && round % resendEvery === 0) {
        if (stopped)
          stop();
        try {
          const outcome = await within(sendMs, () => provider.sendTransactionUntil(signedTransaction, 'FINAL')) as ExecutionOutcome;

          return settlementOf(hash, outcome, tokenContractId);
        }
        catch (error) {
          // Refused for its nonce, and nothing of ours for this delegate action landed: a later
          // transaction of ours took the nonce, so this one can never be included. Any other refusal,
          // such as from one node of a pool while another still holds it, is no answer.
          if (isRefusal(error) && isInvalidNonce(error)) {
            const landed = await landedOf(signed);
            if (landed)
              return settlementOf(landed.hash, landed.outcome, tokenContractId);
            flight?.abandoned('refused');
            throw error;
          }
        }
      }
      await sleep(expired ? pollMs * 10 : pollMs);
    }
  };

  return {
    accountId,
    publicKey: publicKey.toString(),
    get stopped() {
      return stopped;
    },
    stop: () => {
      stopped = true;
      for (const wake of [...sleeping])
        wake();
    },
    state: async () => {
      const [account, key] = await Promise.all([viewAccount(accountId), viewAccessKey(accountId, publicKey)]);

      return { amount: account ? BigInt(account.amount) : undefined, key: key?.permissionKind };
    },
    getRelayerIds: () => [accountId],
    getCurrentBlockHeight: async name => {
      onNetwork(name);

      return BigInt((await readBlock()).header.height);
    },
    viewAccount: async ({ network: name, accountId: id }) => {
      onNetwork(name);
      const account = await viewAccount(id);

      return account ? { codeHash: account.code_hash } : null;
    },
    viewAccessKey: async ({ network: name, accountId: id, publicKey: key }) => {
      onNetwork(name);

      return viewAccessKey(id, key);
    },
    ftBalanceOf: async ({ network: name, token, accountId: id }) => {
      onNetwork(name);
      const result = await within(readMs, () => provider.callFunction(token, 'ft_balance_of', { account_id: id }, final));
      if (typeof result !== 'string' || !/^\d+$/.test(result))
        throw new Error('invalid_ft_balance_of_result');

      return BigInt(result);
    },
    storageBalanceOf: async ({ network: name, token, accountId: id }) => {
      onNetwork(name);
      try {
        const result = await within(readMs, () => provider.callFunction(token, 'storage_balance_of', { account_id: id }, final));

        return { supported: true, registered: result != null };
      }
      catch (error) {
        if (isMethodNotFound(error))
          return { supported: false };
        throw error;
      }
    },
    submitSignedDelegateAction: async ({ network: name, relayerId, signedDelegateAction }) => {
      onNetwork(name);
      if (relayerId !== accountId)
        throw new Error(`unknown_relayer:${relayerId}`);
      const flight = flightOf();
      const decoded = deserialize(SCHEMA.SignedDelegate, fromBase64(signedDelegateAction)) as unknown as SignedDelegate;
      const { delegateAction } = decoded;
      const tokenContractId = delegateAction.receiverId;
      const maxBlockHeight = BigInt(delegateAction.maxBlockHeight);
      const key = settlementCacheKey(signedDelegateAction);
      // Every transaction signed for this delegate action
      const signed: string[] = [];

      const sign = async (): Promise<{ readonly hash: string; readonly transaction: SignedTransaction }> => {
        let read: [Awaited<ReturnType<typeof viewAccessKey>>, Awaited<ReturnType<typeof readBlock>>];
        try {
          read = await Promise.all([viewAccessKey(accountId, publicKey), readBlock()]);
        }
        catch (error) {
          flight?.abandoned('unavailable');
          throw error;
        }
        const [accessKey, block] = read;
        if (!accessKey) {
          flight?.abandoned('refused');
          throw new Error(`The relayer's key isn't an access key of ${accountId}`);
        }
        // From the checks to the flight's hash, nothing waits: a settle cancelled now is never signed
        if (stopped)
          flight?.abandoned('stopped');
        if (stopped || flight?.cancelled)
          throw new SettleCancelledError();
        const nonce = (accessKey.nonce > lastNonce ? accessKey.nonce : lastNonce) + 1n;
        const transaction = createTransaction(accountId, publicKey, delegateAction.senderId, nonce, [actionCreators.signedDelegate(decoded)], baseDecode(block.header.hash));
        const digest = new Uint8Array(createHash('sha256').update(encodeTransaction(transaction)).digest());
        const signedTransaction = new SignedTransaction({ transaction, signature: new Signature({ keyType: KeyType.ED25519, data: keyPair.sign(digest).signature }) });
        const hash = baseEncode(digest);
        lastNonce = nonce;
        signed.push(hash);
        flight?.signed({ key, transaction: hash, payer: delegateAction.senderId, maxBlockHeight, nonce });

        return { hash, transaction: signedTransaction };
      };

      let attempt = await sign();
      for (let retried = false; ; retried = true) {
        try {
          const outcome = await within(sendMs, () => provider.sendTransactionUntil(attempt.transaction, 'FINAL')) as ExecutionOutcome;

          return settlementOf(attempt.hash, outcome, tokenContractId);
        }
        catch (error) {
          if (!isRefusal(error)) {
            flight?.sendPhaseOver();

            return untilKnown(attempt.hash, attempt.transaction, signed, maxBlockHeight, tokenContractId, flight);
          }
          // The node took nothing, unless a transaction signed before for this delegate action landed
          const landed = await landedOf(signed);
          if (landed)
            return settlementOf(landed.hash, landed.outcome, tokenContractId);
          if (retried || !isInvalidNonce(error)) {
            flight?.abandoned('refused');
            throw error;
          }
          attempt = await sign();
        }
      }
    },
  };
};
