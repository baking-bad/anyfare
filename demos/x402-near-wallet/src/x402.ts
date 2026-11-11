// The NEAR payer: the option this app signs, one signature for that option only, the check of what
// was signed before it is sent, and the proof that comes back.

import { x402Client } from '@x402/core/client';
import type { SpendControls } from '@x402/core/client';
import { decodePaymentResponseHeader } from '@x402/core/http';
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from '@x402/core/types';
import { decodeSignedDelegateB64, parseFtTransferArgs } from '@x402/near';
import type { ClientNearSigner, DecodedDelegateAction } from '@x402/near';
import { ExactNearScheme } from '@x402/near/exact/client';
import { clip, retryIn } from './errors.ts';
import type { ErrorTable } from './errors.ts';
import { limitText } from './http.ts';
import type { Fetch } from './http.ts';
import { NEAR_NETWORK, isKnownUsdc } from './networks.ts';
import { fetchFailure, raceLimit } from './rpc.ts';
import { NotSupported, Stop, fromAtomic, isRecord } from './util.ts';
import { isNearAccountId } from './wallet.ts';
import type { NearWallet } from './wallet.ts';

/**
 * The longest a signed payment may stay valid, in seconds: 1 to 300. Until then, whoever holds the
 * signature can settle it.
 */
export const MAX_TIMEOUT_SECONDS = 300;
/** The longest signing may take, the NEAR RPC's reads included. */
export const SIGNING_TIMEOUT_MS = 30_000;
// The signer reads the block height a moment after the app does
const NEAR_HEIGHT_SLACK_BLOCKS = 50n;

/**
 * The option of the 402 to sign, checked before anything is signed: the `exact` scheme, NEAR, its
 * known USDC, whose atomic unit is a micro-USD, a whole amount above zero, a NEAR account to pay, and
 * a time limit. A `NotSupported` names what is wrong.
 */
export function checkOption(raw: unknown): PaymentRequirements {
  const refuse = (why: string): never => {
    throw new NotSupported(`Not supported: the API's NEAR option ${why}, so the app won't sign it. Nothing paid.`);
  };
  if (!isRecord(raw)) return refuse('is not an object');
  if (raw['scheme'] !== 'exact') refuse('is not of the exact scheme');
  if (raw['network'] !== NEAR_NETWORK) refuse('is not on NEAR');
  const asset = raw['asset'];
  if (typeof asset !== 'string' || !isKnownUsdc(NEAR_NETWORK, asset)) refuse('is not the known USDC of NEAR');
  const amount = raw['amount'];
  if (typeof amount !== 'string' || !/^[0-9]{1,30}$/.test(amount) || BigInt(amount) === 0n) {
    refuse('has no amount this app can read');
  }
  const payTo = raw['payTo'];
  if (typeof payTo !== 'string' || !isNearAccountId(payTo)) refuse('has no recipient this app can read');
  const timeout = raw['maxTimeoutSeconds'];
  if (typeof timeout !== 'number' || !Number.isSafeInteger(timeout) || timeout <= 0) refuse('has no time limit this app can read');
  // The SDK signs a delegate action valid for this many blocks
  if ((timeout as number) > MAX_TIMEOUT_SECONDS) refuse(`asks for a payment valid for more than ${MAX_TIMEOUT_SECONDS} seconds`);
  const extra = raw['extra'] ?? {};
  if (!isRecord(extra)) return refuse('has extra fields that are not an object');
  // The flow the app's charge lines are true for: the payment settles only after the API answered
  // 2xx. The SDK would also sign "upfront" and "escrow", which settle before the API answers.
  const flow = extra['paymentFlow'];
  if (flow !== undefined && flow !== null && flow !== 'authorization') refuse("asks for a payment flow this app doesn't sign");
  return raw as PaymentRequirements;
}

/**
 * The SDK's own spend controls, at the app's cap: this one asset at most `cap` in atomic units, which
 * for USDC are micro-USD, and any asset the SDK knows at most `cap` in US dollars.
 */
export function spendControlsFor(option: PaymentRequirements, cap: bigint): SpendControls {
  return {
    maxAmountPerPayment: `$${fromAtomic(cap, 6)}`,
    allowedAssets: [{ network: option.network, asset: option.asset, maxAmountPerPayment: cap.toString() }],
  };
}

/** The x402 client that signs on NEAR only, with its spend controls at the cap. */
export function nearClient(signer: ClientNearSigner, option: PaymentRequirements, cap: bigint): x402Client {
  return new x402Client().setSpendControls(spendControlsFor(option, cap)).register(NEAR_NETWORK, new ExactNearScheme(signer));
}

/** A failure of the app's own read of the NEAR RPC. Its message is the app's own, and names nothing but a status. */
class NearRpcFailure extends Error {}

/**
 * A failure inside the SDK's NEAR signer, which reads the key's nonce and the block height from the
 * RPC. Any other failure of the SDK is the x402 client's own: the RPC was not to blame.
 */
export class SignerFailure extends Error {
  constructor(cause: unknown) {
    super('The NEAR signer failed', { cause });
    this.name = 'SignerFailure';
  }
}

/** The SDK's signer, with its failures marked as its own. */
function watched(signer: ClientNearSigner): ClientNearSigner {
  return {
    createSignedDelegateAction: async (input) => {
      try {
        return await signer.createSignedDelegateAction(input);
      } catch (error) {
        throw new SignerFailure(error);
      }
    },
  };
}

const SPEND_CONTROLS = /rejected by spendControls/;
const NO_ACCESS_KEY = /UNKNOWN_ACCESS_KEY|AccessKeyDoesNotExist|access key .*(does ?n.t exist|not found|never been observed)/i;
const NO_ACCOUNT = /UNKNOWN_ACCOUNT|AccountDoesNotExist|account .*(does ?n.t exist|not found)/i;

/**
 * Why the NEAR signer failed, in a fixed line that names the RPC by its host only. The SDK's and the
 * RPC's own texts are never shown: they can hold the RPC's whole URL, with a key in its path or query.
 */
export function nearSigningFailure(error: unknown, wallet: Pick<NearWallet, 'accountId' | 'rpc'>): string {
  const at = `the NEAR RPC at ${wallet.rpc.host}`;
  if (error instanceof NearRpcFailure) return `${at} ${error.message}`;
  // Only the signer reads the RPC: a failure from anywhere else in the SDK is no fault of the RPC
  const fromSigner = error instanceof SignerFailure;
  const inner = fromSigner ? error.cause : error;
  const reason = fetchFailure(inner, wallet.rpc.url);
  if (reason !== undefined) return `${at} could not be reached${reason === '' ? '' : ` (${reason})`}`;
  // Read to pick a line, never printed
  const { message = '', type = '', name = '' } = (inner ?? {}) as { message?: unknown; type?: unknown; name?: unknown };
  const text = `${String(message)} ${String(type)} ${String(name)}`;
  if (SPEND_CONTROLS.test(text)) return "the x402 client's spend controls refused it";
  if (NO_ACCESS_KEY.test(text)) return `${at} says NEAR_PRIVATE_KEY is not an access key of ${wallet.accountId}`;
  if (NO_ACCOUNT.test(text)) return `${at} knows no account ${wallet.accountId}`;
  return fromSigner ? `${at} answered with an error` : 'the x402 client refused it';
}

/** One JSON-RPC call of the app's own to the NEAR RPC the signer uses: its `result`, or `{}`. */
async function rpcCall(fetchFn: Fetch, wallet: NearWallet, method: string, params: unknown, signal: AbortSignal): Promise<Record<string, unknown>> {
  const response = await fetchFn(wallet.rpc.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'x402-near-wallet', method, params }),
    redirect: 'error',
    signal,
  });
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  if (!response.ok) throw new NearRpcFailure(`answered ${response.status}`);
  return isRecord(body) && isRecord(body['result']) ? body['result'] : {};
}

/**
 * That the RPC serves NEAR mainnet. Heights are a chain's own: on another chain's RPC, the app's and
 * the signer's heights would agree, and the payment would stay valid on mainnet far longer than shown.
 */
async function requireMainnet(fetchFn: Fetch, wallet: NearWallet, signal: AbortSignal): Promise<void> {
  const result = await rpcCall(fetchFn, wallet, 'status', [], signal);
  const chain = result['chain_id'];
  if (typeof chain !== 'string') throw new NearRpcFailure('answered with no chain ID');
  if (chain !== 'mainnet') throw new NearRpcFailure('is not a mainnet RPC');
}

/** The final block's height, read once from the NEAR RPC the signer uses, a moment before it signs. */
async function finalHeight(fetchFn: Fetch, wallet: NearWallet, signal: AbortSignal): Promise<bigint> {
  const result = await rpcCall(fetchFn, wallet, 'block', { finality: 'final' }, signal);
  const height = isRecord(result['header']) ? result['header']['height'] : undefined;
  if (typeof height !== 'number' || !Number.isSafeInteger(height) || height < 0) throw new NearRpcFailure('answered with no block height');
  return BigInt(height);
}

export interface Signed {
  readonly payload: PaymentPayload;
  /** The final block's height the app read before signing. */
  readonly nearHeight: bigint;
}

/**
 * One signature, for `option` only, within `limitMs`, from a mainnet RPC. When it fails, no payment
 * has left the process: the app and the signer have at most read the chain, the block height and the
 * key's nonce from the RPC. The SDK takes no abort signal: a signature it makes after the limit is
 * dropped, never checked and never sent.
 */
export async function signOnce(
  fetchFn: Fetch,
  required: PaymentRequired,
  option: PaymentRequirements,
  wallet: NearWallet,
  cap: bigint,
  limitMs: number,
): Promise<Signed> {
  const only: PaymentRequired = { ...required, accepts: [option] };
  const controller = new AbortController();
  const work = (async (): Promise<Signed> => {
    await requireMainnet(fetchFn, wallet, controller.signal);
    const nearHeight = await finalHeight(fetchFn, wallet, controller.signal);
    return { payload: await nearClient(watched(wallet.signer()), option, cap).createPaymentPayload(only), nearHeight };
  })();
  let signed: Signed | 'late';
  try {
    signed = await raceLimit(work, limitMs);
  } catch (error) {
    throw new Stop(`Could not sign the payment: ${nearSigningFailure(error, wallet)}. Nothing paid.`);
  } finally {
    controller.abort();
  }
  // The SDK may still sign after this line, in a process that goes on: that signature is never sent
  if (signed === 'late') {
    throw new Stop(`Could not sign the payment: the NEAR RPC at ${wallet.rpc.host} did not answer in ${limitText(limitMs)}. Nothing was sent.`);
  }
  return signed;
}

type Refuse = (why: string) => never;

/**
 * What a NEAR delegate action does: one `ft_transfer` of the USDC contract, of the amount, to the
 * recipient, valid for at most the option's blocks past `height`, the app's own read of the RPC.
 */
export function checkNearTransfer(
  delegate: Pick<DecodedDelegateAction, 'senderId' | 'receiverId' | 'actionCount' | 'functionCall' | 'maxBlockHeight'>,
  option: PaymentRequirements,
  payer: string,
  height: bigint,
  refuse: Refuse,
): void {
  if (delegate.senderId !== payer) refuse('it pays from another account');
  if (delegate.receiverId !== option.asset) refuse('it calls another contract than USDC');
  const call = delegate.functionCall;
  if (delegate.actionCount !== 1 || call === null || call.methodName !== 'ft_transfer') refuse('it is not one ft_transfer');
  // NEP-141 attaches exactly one yoctoNEAR to a transfer: anything more would spend NEAR too
  if (call?.deposit !== 1n) refuse('it attaches more than one yoctoNEAR');
  let args: ReturnType<typeof parseFtTransferArgs> | undefined;
  try {
    args = parseFtTransferArgs(call?.args ?? new Uint8Array());
  } catch {
    refuse("its transfer can't be read");
  }
  if (args?.receiver_id !== option.payTo) refuse('it pays another recipient');
  if (args?.amount !== option.amount) refuse('it pays another amount');
  // The SDK sets it to the height it read and a block for each second of the option. An RPC that lies
  // to both the app and the signer can still widen it. What bounds that: the RPC is the owner's own
  // NEAR_RPC_URL, or the SDK's public one, over https, so no one on the way changes its answers; and a
  // facilitator refuses a delegate action valid for more blocks than the option, by the chain.
  if (delegate.maxBlockHeight - height > BigInt(option.maxTimeoutSeconds) + NEAR_HEIGHT_SLACK_BLOCKS) {
    refuse(`it stays valid for more blocks than the option's ${option.maxTimeoutSeconds} seconds`);
  }
}

/**
 * What was signed, checked before it is sent: the option it names is the chosen one, and the signed
 * delegate action moves that amount of USDC from the payer to that recipient, valid for no longer
 * than the option past `nearHeight`, the app's own read of the RPC. A `Stop`: nothing was sent.
 */
export function checkSigned(option: PaymentRequirements, payer: string, payload: PaymentPayload, bounds: { readonly nearHeight?: bigint } = {}): void {
  const refuse: Refuse = (why) => {
    throw new Stop(`The signed payment is not the one the app chose: ${why}. Nothing was sent.`);
  };
  if (payload.x402Version !== 2) refuse('it is not x402 version 2');
  const accepted: unknown = payload.accepted;
  if (!isRecord(accepted)) return refuse('it names no option');
  if (accepted['scheme'] !== option.scheme || accepted['network'] !== option.network) refuse('it names another scheme or network');
  if (accepted['asset'] !== option.asset) refuse('it names another asset');
  if (accepted['amount'] !== option.amount) refuse('it names another amount');
  if (accepted['payTo'] !== option.payTo) refuse('it names another recipient');
  if (accepted['maxTimeoutSeconds'] !== option.maxTimeoutSeconds) refuse('it names another time limit');
  const signed: unknown = payload.payload;
  if (!isRecord(signed)) return refuse('it holds no signed part');
  if (bounds.nearHeight === undefined) return refuse('there is no block height to check it against');
  let delegate: DecodedDelegateAction | undefined;
  try {
    delegate = decodeSignedDelegateB64(String(signed['signedDelegateAction'] ?? '')).delegate;
  } catch {
    refuse("its delegate action can't be read");
  }
  if (delegate !== undefined) checkNearTransfer(delegate, option, payer, bounds.nearHeight, refuse);
}

export type Proof =
  | {
      readonly kind: 'settled' | 'pending';
      readonly transaction: string;
      readonly network: string | undefined;
      readonly payer: string | undefined;
    }
  | { readonly kind: 'missing' }
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'failed'; readonly reason: string };

/** `PAYMENT-RESPONSE`, decoded: the transaction, the network and the payer. */
export function readProof(value: string | null): Proof {
  if (value === null) return { kind: 'missing' };
  let decoded: unknown;
  try {
    decoded = decodePaymentResponseHeader(value);
  } catch {
    return { kind: 'unreadable' };
  }
  if (!isRecord(decoded) || typeof decoded['success'] !== 'boolean') return { kind: 'unreadable' };
  const text = (key: string): string | undefined => {
    const field = decoded[key];
    return typeof field === 'string' && field !== '' ? field : undefined;
  };
  const transaction = text('transaction');
  const fields = { network: text('network'), payer: text('payer') };
  if (decoded['success']) return transaction === undefined ? { kind: 'unreadable' } : { kind: 'settled', transaction, ...fields };
  // Broadcast and not final: the server sent the answer, and finishes the settlement
  if (decoded['errorReason'] === 'settlement_pending' && transaction !== undefined) return { kind: 'pending', transaction, ...fields };
  return { kind: 'failed', reason: clip(text('errorReason') ?? 'no reason given') };
}

const IN_FLIGHT = /another NEAR payment in flight/i;
const USED_BEFORE = /already used/i;

/**
 * The proxy's x402 answers. `payment_invalid`, `facilitator_unavailable` and `redis_not_ready` refuse
 * the payment before the API is called. `payment_unavailable`, `quote_exceeded`, `response_too_large`
 * and `upstream_unavailable` cancel the verified payment before it settles: only a `2xx` is settled,
 * before its answer goes out. `settlement_failed` may have settled. `check` says where the payer's
 * payments are seen.
 */
export function x402Lines(check: string): ErrorTable {
  return {
    payment_invalid: {
      line: (error) => {
        if (IN_FLIGHT.test(error.message)) {
          return 'Your NEAR account has another payment in flight. Wait until it settles, then run the call again';
        }
        // Only if the request was sent twice on the way: the other copy may have been paid
        if (USED_BEFORE.test(error.message)) {
          return `Anyfare says this payment was used before, and took nothing for this request. Whether the other use was paid is not known: ${check}`;
        }
        return `Anyfare refused the payment, so nothing moved: ${clip(error.message).replace(/[.]+$/, '')}`;
      },
      notCharged: (error) => !USED_BEFORE.test(error.message),
    },
    payment_unavailable: {
      line: (error) => `Anyfare couldn't take a NEAR payment now, so nothing was paid; ${retryIn(error)}`,
      notCharged: true,
    },
    settlement_failed: {
      line: () =>
        `The payment couldn't be settled, and the answer was not sent. Check the wallet (${check}); Anyfare repeats an unknown settlement and charges at most once`,
      notCharged: false,
    },
    upstream_unavailable: {
      line: () => "The API or Anyfare's payer failed, so Anyfare cancelled your payment; retry later",
      notCharged: true,
    },
  };
}

/** How long a signed payment stays valid, for the plan: in blocks, of about 0.6 seconds each. */
export function validFor(seconds: number): string {
  const time = (value: number): string =>
    value % 60 === 0 ? `${value / 60} minute${value === 60 ? '' : 's'}` : `${value} second${value === 1 ? '' : 's'}`;
  return `${seconds} block${seconds === 1 ? '' : 's'}, about ${time(Math.max(1, Math.round(seconds * 0.6)))}`;
}
