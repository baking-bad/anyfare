import { KeyPair, type KeyPairString, type PublicKey } from '@near-js/crypto';
import { KeyPairSigner } from '@near-js/signers';
import { actionCreators, buildDelegateAction, encodeSignedDelegate } from '@near-js/transactions';
import type { PaymentRequirements } from '@x402/core/types';
import { computeTimeoutBlocks, DEFAULT_FT_TRANSFER_GAS, FT_TRANSFER_METHOD, ONE_YOCTO, toBase64, type ClientNearSigner } from '@x402/near';

import { isRecord, outboundErrorCode, type Secret } from '@anyfare/common';
import { RedisNotReadyError, type Redis } from '@anyfare/db';

// The Signer's NEAR keys after the connection's prefix: the payer's lease, the quotes released before
// they took it, and the last nonce per key
export const nearKeyPrefix = 'near:';

// A quote released while it held no lease is remembered this long, so a sign that comes later takes
// nothing. Longer than any lease: the longest is 300 s and a minute.
export const releasedQuoteMs = 10 * 60_000;

// The last nonce signed with a key is remembered this long: past a delegate action's window, the
// chain's own nonce has caught up, or the delegate action can no longer run
const nonceTtlSeconds = 86_400;
// A failed read is repeated once, this much later, when the sign's budget allows it
const retryWaitMs = 100;
// Each read attempt gets at least this long
const minimumAttemptMs = 100;

/** The NEAR hot wallet: its account, its full-access key, and the RPC the Signer reads the chain through. */
export interface NearWallet {
  readonly accountId: string;
  // `ed25519:` and base58
  readonly secretKey: Secret;
  // NEAR_RPC_URLS's item for the network, which may carry a key in its path, or the x402 SDK's public RPC
  readonly rpcUrl: Secret;
}

/** The payer's lease on a NEAR payment in flight. */
export interface NearLease {
  readonly accountId: string;
  // The proxy's quote ID of the payment: the proxy always knows it, even when the Signer's answer never reached it
  readonly quoteId: string;
}

/**
 * What taking the lease came to: `taken`; `busy`, another payment holds it; or `released`, the proxy
 * released this quote before it was signed, so nothing is taken.
 */
export type NearLeaseTake = 'taken' | 'busy' | 'released';

/** Port: the NEAR hot wallet's lease and the last nonce it signed, in the Signer's Redis. */
export interface NearPayerStore {
  /** Takes the payer's lease for a payment, for `lifetimeMs` by Redis's clock, unless another holds it or its quote was released. */
  takeLease(lease: NearLease, lifetimeMs: number): Promise<NearLeaseTake>;
  /**
   * Frees the payer's lease only while this payment holds it. Otherwise marks its quote released, for
   * `releasedQuoteMs`, so a sign of it that comes later takes nothing. Whether it freed the lease.
   */
  releaseLease(lease: NearLease): Promise<boolean>;
  /** The last nonce signed with this key, when one is remembered. */
  lastNonce(accountId: string, publicKey: string): Promise<bigint | undefined>;
  /** Remembers the nonce just signed with this key, for a day. */
  saveNonce(accountId: string, publicKey: string, nonce: bigint): Promise<void>;
}

/**
 * How long a NEAR payment holds the payer's lease, in ms: its window in blocks at the SDK's own estimate
 * of a second a block, plus a minute. The delegate action expires at a block height, so its window
 * lasts longest in wall-clock time when blocks are slow; past this, a later delegate action is very
 * unlikely to land before it.
 */
export const nearLeaseMs = (maxTimeoutSeconds: number): number => maxTimeoutSeconds * 1_000 + 60_000;

// Sets the lease only when no payment holds it and its quote wasn't released, until Redis's own clock
// passes its lifetime, so every Signer counts it alike. KEYS: the payer's key, the quote's released
// marker. ARGV: the quote ID, the lifetime in ms. 1: taken; 0: another payment holds it; 2: released.
const takeLeaseScript = `
if redis.call('EXISTS', KEYS[2]) == 1 then return 2 end
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PXAT', string.format('%d', now + tonumber(ARGV[2]))) then return 1 end
return 0`;

// Deletes the lease only when this quote holds it: a late release never frees a newer payment's lease.
// Otherwise the quote is marked released, in the same step, so a sign of it still on its way takes
// nothing. KEYS: the payer's key, the quote's released marker. ARGV: the quote ID, the marker's lifetime in ms.
const releaseLeaseScript = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('DEL', KEYS[1])
  return 1
end
redis.call('SET', KEYS[2], '1', 'PX', ARGV[2])
return 0`;

/**
 * The NEAR payer's lease and nonces in Redis: the lease at `<prefix>near:payer:<account>`, whose value is
 * the payment's quote ID, a quote released before it held the lease at `<prefix>near:released:<quote ID>`,
 * and the last nonce at `<prefix>near:nonce:<account>:<public key>`. Fails closed: while Redis is down,
 * nothing is signed.
 */
export const createRedisNearPayerStore = ({ redis }: { readonly redis: Redis }): NearPayerStore => {
  const leaseKey = (accountId: string) => `${redis.prefix}${nearKeyPrefix}payer:${accountId}`;
  const releasedKey = (quoteId: string) => `${redis.prefix}${nearKeyPrefix}released:${quoteId}`;
  const nonceKey = (accountId: string, publicKey: string) => `${redis.prefix}${nearKeyPrefix}nonce:${accountId}:${publicKey}`;
  const ready = () => {
    if (!redis.client.isReady)
      throw new RedisNotReadyError();
  };

  return {
    takeLease: async ({ accountId, quoteId }, lifetimeMs) => {
      ready();
      const result = await redis.client.eval(takeLeaseScript, { keys: [leaseKey(accountId), releasedKey(quoteId)], arguments: [quoteId, String(Math.ceil(lifetimeMs))] });

      return result === 1 ? 'taken' : result === 2 ? 'released' : 'busy';
    },
    releaseLease: async ({ accountId, quoteId }) => {
      ready();

      return await redis.client.eval(releaseLeaseScript, { keys: [leaseKey(accountId), releasedKey(quoteId)], arguments: [quoteId, String(releasedQuoteMs)] }) === 1;
    },
    lastNonce: async (accountId, publicKey) => {
      ready();
      const value = await redis.client.get(nonceKey(accountId, publicKey));

      return typeof value === 'string' && /^\d{1,30}$/.test(value) ? BigInt(value) : undefined;
    },
    saveNonce: async (accountId, publicKey, nonce) => {
      ready();
      await redis.client.set(nonceKey(accountId, publicKey), nonce.toString(), { expiration: { type: 'EX', value: nonceTtlSeconds } });
    },
  };
};

/** The NEAR RPC gave no usable answer, or refused a read. The message never carries its URL or a key. */
export class NearRpcError extends Error {
  override readonly name = 'NearRpcError';
  // No answer at all: worth one more try
  readonly retry: boolean;

  constructor(message: string, retry: boolean) {
    super(message);

    this.retry = retry;
  }
}

// A JSON-RPC answer: its result, or its error
type RpcAnswer = { readonly result: unknown; readonly error?: undefined } | { readonly error: Record<string, unknown> };

const isTimeout = (error: unknown): boolean => error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');

// A name nearcore gives an error, such as UNKNOWN_ACCOUNT. Anything else stays out of the message.
const errorNameOf = (error: Record<string, unknown>): string => {
  const cause = isRecord(error['cause']) ? error['cause']['name'] : undefined;
  const name = typeof cause === 'string' ? cause : error['name'];

  return typeof name === 'string' && /^[A-Za-z_]{1,64}$/.test(name) ? name : 'an error';
};

// The reads of one sign, or of the startup check
type NearRpcCall = (method: string, params: unknown) => Promise<RpcAnswer>;

/**
 * A JSON-RPC client for the two reads the Signer makes, within one budget: the proxy's call timeout,
 * so a NEAR sign ends before the proxy gives up on it. Each attempt gets half the budget less 250 ms
 * (at least 100 ms). A read is repeated once when the node gave no answer (unreachable, a timeout, a
 * 5xx, a 408, a 429, or a body that isn't JSON-RPC), and only when the repeat can end within the
 * budget less 500 ms of the first read; otherwise its first failure is final. So a dead RPC fails fast.
 * Its errors say what failed in its own words, never with the URL.
 */
const createNearRpc = ({ rpcUrl, budgetMs }: { readonly rpcUrl: Secret; readonly budgetMs: number }): (() => NearRpcCall) => {
  const attemptMs = Math.max(minimumAttemptMs, Math.floor(budgetMs / 2) - 250);
  const once = async (body: string): Promise<RpcAnswer> => {
    let response: Response;
    try {
      response = await fetch(rpcUrl.expose(), { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(attemptMs) });
    }
    catch (error) {
      const code = outboundErrorCode(error);
      throw new NearRpcError(isTimeout(error) ? `The NEAR RPC didn't answer within ${attemptMs} ms` : `The NEAR RPC is unreachable${code ? `: ${code}` : ''}`, true);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new NearRpcError(`The NEAR RPC answered HTTP ${response.status}`, response.status >= 500 || response.status === 408 || response.status === 429);
    }
    let json: unknown;
    try {
      json = await response.json();
    }
    catch (error) {
      throw new NearRpcError(isTimeout(error) ? `The NEAR RPC didn't answer within ${attemptMs} ms` : 'The NEAR RPC\'s answer isn\'t JSON', true);
    }
    if (!isRecord(json) || (!('result' in json) && !isRecord(json['error'])))
      throw new NearRpcError('The NEAR RPC\'s answer isn\'t JSON-RPC', true);

    return isRecord(json['error']) ? { error: json['error'] } : { result: json['result'] };
  };

  // The budget counts from here: the reads of one sign share it
  return () => {
    const started = performance.now();

    return async (method, params) => {
      const body = JSON.stringify({ jsonrpc: '2.0', id: 'anyfare-signer', method, params });
      try {
        return await once(body);
      }
      catch (error) {
        const repeatEndsAt = performance.now() - started + retryWaitMs + attemptMs;
        if (!(error instanceof NearRpcError) || !error.retry || repeatEndsAt > budgetMs - 500)
          throw error;
        await new Promise(resolve => setTimeout(resolve, retryWaitMs));

        return once(body);
      }
    };
  };
};

/** An access key, as `view_access_key` at `final` answers it, or why there is none. */
export type NearAccessKey =
  | { readonly kind: 'key'; readonly nonce: bigint; readonly permission: 'FullAccess' | 'FunctionCall' | 'Unknown' }
  | { readonly kind: 'no_key' }
  | { readonly kind: 'no_account' };

const permissionOf = (permission: unknown): 'FullAccess' | 'FunctionCall' | 'Unknown' => {
  if (permission === 'FullAccess')
    return 'FullAccess';

  return isRecord(permission) && ('FunctionCall' in permission || 'functionCall' in permission) ? 'FunctionCall' : 'Unknown';
};

const viewAccessKey = async (call: NearRpcCall, accountId: string, publicKey: string): Promise<NearAccessKey> => {
  const answer = await call('query', { request_type: 'view_access_key', finality: 'final', account_id: accountId, public_key: publicKey });
  if (answer.error) {
    // nearcore's structured errors
    const name = errorNameOf(answer.error);
    if (name === 'UNKNOWN_ACCOUNT')
      return { kind: 'no_account' };
    if (name === 'UNKNOWN_ACCESS_KEY')
      return { kind: 'no_key' };
    throw new NearRpcError(`The NEAR RPC refused view_access_key: ${name}`, false);
  }
  const result = isRecord(answer.result) ? answer.result : {};
  // A query's error, as nearcore words it in the result: `access key <key> does not exist while viewing`
  if (typeof result['error'] === 'string') {
    if (/access key/i.test(result['error']) && /does ?n.t exist|doesn't exist|does not exist|not found/i.test(result['error']))
      return { kind: 'no_key' };
    if (/does ?n.t exist|doesn't exist|does not exist/i.test(result['error']))
      return { kind: 'no_account' };
    throw new NearRpcError('The NEAR RPC couldn\'t view the access key', false);
  }
  const nonce = result['nonce'];
  if ((typeof nonce !== 'number' || !Number.isSafeInteger(nonce) || nonce < 0) && (typeof nonce !== 'string' || !/^\d{1,30}$/.test(nonce)))
    throw new NearRpcError('The NEAR RPC answered an access key without a nonce', false);

  return { kind: 'key', nonce: BigInt(nonce), permission: permissionOf(result['permission']) };
};

const finalHeight = async (call: NearRpcCall): Promise<bigint> => {
  const answer = await call('block', { finality: 'final' });
  if (answer.error)
    throw new NearRpcError(`The NEAR RPC refused block: ${errorNameOf(answer.error)}`, false);
  const header = isRecord(answer.result) && isRecord(answer.result['header']) ? answer.result['header'] : {};
  const height = header['height'];
  if (typeof height !== 'number' || !Number.isSafeInteger(height) || height <= 0)
    throw new NearRpcError('The NEAR RPC answered a block without a height', false);

  return BigInt(height);
};

/** `view_access_key` at `final`, for the Signer's startup check, within `budgetMs`. Throws NearRpcError when the RPC gives no answer. */
export const readNearAccessKey = ({ rpcUrl, accountId, publicKey, budgetMs }: {
  readonly rpcUrl: Secret;
  readonly accountId: string;
  readonly publicKey: string;
  readonly budgetMs: number;
}): Promise<NearAccessKey> => viewAccessKey(createNearRpc({ rpcUrl, budgetMs })(), accountId, publicKey);

/**
 * The Signer's Redis failed while the hot wallet's last nonce was read or saved: nothing was paid. Kept
 * apart from the RPC's failures, so the Signer answers it as Redis being down.
 */
export class NearStoreError extends Error {
  override readonly name = 'NearStoreError';

  constructor(options: ErrorOptions) {
    super('The Signer couldn\'t read or save the NEAR nonce in Redis', options);
  }
}

const fromStore = async <TResult>(operation: () => Promise<TResult>): Promise<TResult> => {
  try {
    return await operation();
  }
  catch (error) {
    throw new NearStoreError({ cause: error });
  }
};

/** A NEAR key that doesn't parse. Neither the key nor near-js's message about it is kept. */
export class InvalidNearKeyError extends Error {
  override readonly name = 'InvalidNearKeyError';

  constructor() {
    super('The NEAR key isn\'t ed25519: and a base58 key');
  }
}

/** The public key of a NEAR secret key, `ed25519:` and base58. Throws InvalidNearKeyError, never with the key. */
export const nearPublicKeyOf = (secretKey: Secret): string => {
  try {
    return KeyPair.fromString(secretKey.expose().trim() as KeyPairString).getPublicKey().toString();
  }
  catch {
    throw new InvalidNearKeyError();
  }
};

/** The hot wallet's client signer for x402's `ExactNearScheme`. */
export interface NearPayer extends ClientNearSigner {
  readonly accountId: string;
  readonly publicKey: string;
}

/**
 * The NEAR hot wallet's client signer, as the x402 SDK's `createClientNearSigner` (@x402/near 2.30.0)
 * builds it: one `ft_transfer` of the option's amount to its payTo on the token contract, with 30 Tgas
 * and 1 yoctoNEAR, in a NEP-366 delegate action valid until the final height plus the option's
 * timeout in blocks, signed with the full-access key. One change: the SDK signs the key's nonce at
 * `final` plus one, and a payment whose settlement landed a moment ago isn't final yet, so the next one
 * would get the same nonce and fail. This one signs the higher of the chain's nonce and the last one it
 * signed, plus one, and remembers it right after signing. A delegate action's nonce only has to be
 * above the key's when it runs: gaps are fine. Both reads run at `final`, in parallel, within
 * `budgetMs`: the proxy's call timeout. The store's failures come out as NearStoreError. The key stays
 * inside: no field holds it.
 */
export const createNearPayer = ({ wallet, store, budgetMs }: {
  readonly wallet: NearWallet;
  readonly store: Pick<NearPayerStore, 'lastNonce' | 'saveNonce'>;
  readonly budgetMs: number;
}): NearPayer => {
  const { accountId } = wallet;
  let signer: KeyPairSigner;
  let publicKey: PublicKey;
  try {
    // As KeyPairSigner.fromSecretKey builds it, with the public key at hand
    const keyPair = KeyPair.fromString(wallet.secretKey.expose().trim() as KeyPairString);
    signer = new KeyPairSigner(keyPair);
    publicKey = keyPair.getPublicKey();
  }
  catch {
    throw new InvalidNearKeyError();
  }
  const publicKeyText = publicKey.toString();
  const reads = createNearRpc({ rpcUrl: wallet.rpcUrl, budgetMs });

  return {
    accountId,
    publicKey: publicKeyText,
    createSignedDelegateAction: async ({ paymentRequirements }: { readonly x402Version: number; readonly paymentRequirements: PaymentRequirements }) => {
      const requirement = paymentRequirements;
      const call = reads();
      const [accessKey, height, last] = await Promise.all([
        viewAccessKey(call, accountId, publicKeyText), finalHeight(call), fromStore(() => store.lastNonce(accountId, publicKeyText)),
      ]);
      if (accessKey.kind !== 'key')
        throw new NearRpcError(`The hot wallet's key isn't an access key of ${accountId}`, false);
      const nonce = (last !== undefined && last > accessKey.nonce ? last : accessKey.nonce) + 1n;
      const maxBlockHeight = height + computeTimeoutBlocks(requirement.maxTimeoutSeconds);
      const transfer = actionCreators.functionCall(FT_TRANSFER_METHOD, { receiver_id: requirement.payTo, amount: requirement.amount }, DEFAULT_FT_TRANSFER_GAS, ONE_YOCTO);
      const delegateAction = buildDelegateAction({ actions: [transfer], maxBlockHeight, nonce, publicKey, receiverId: requirement.asset, senderId: accountId });
      const [, signedDelegate] = await signer.signDelegateAction(delegateAction);
      await fromStore(() => store.saveNonce(accountId, publicKeyText, nonce));

      return toBase64(encodeSignedDelegate(signedDelegate));
    },
  };
};
