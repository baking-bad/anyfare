// A routed call paid with x402, USDC on Base or USDC on NEAR, from the buyer's own wallet: the routing
// link's 402, the one option this app pays, the cap, the confirmation, one signature for that option
// only, one request that is never retried, and the proof.

import { x402Client } from '@x402/core/client';
import type { SpendControls } from '@x402/core/client';
import { decodePaymentResponseHeader, encodePaymentSignatureHeader } from '@x402/core/http';
import type { Network, PaymentPayload, PaymentRequired, PaymentRequirements } from '@x402/core/types';
import type { ClientEvmSigner } from '@x402/evm';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { decodeSignedDelegateB64, parseFtTransferArgs } from '@x402/near';
import type { ClientNearSigner, DecodedDelegateAction } from '@x402/near';
import { ExactNearScheme } from '@x402/near/exact/client';
import { loadConfig } from './config.ts';
import type { Context } from './context.ts';
import { clip, retryIn } from './errors.ts';
import type { ErrorTable } from './errors.ts';
import { WAY_LABELS } from './explain.ts';
import type { Plan } from './explain.ts';
import { limitText } from './http.ts';
import type { Answer, Fetch } from './http.ts';
import { amountText, networkName, sameAddress } from './networks.ts';
import { isKnownUsdc, payWayOf } from './offers.ts';
import { NO_TERMINAL, callingLine, readPaidPlan, sendOnce, shortPlan, stopForAnswer, storyLine } from './paid.ts';
import type { CallCommand, Chosen } from './paid.ts';
import { Stop, fromAtomic, isRecord } from './util.ts';
import { EXPLORERS, isNearAccountId, readWallet } from './wallets.ts';
import type { NearWallet, Wallet } from './wallets.ts';

export type X402Way = 'base' | 'near';

/** The one network of each way. */
export const X402_NETWORKS: Readonly<Record<X402Way, Network>> = { base: 'eip155:8453', near: 'near:mainnet' };

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * The longest a signed payment may stay valid, in seconds: what Anyfare's own payer takes, 1 to 300,
 * and what its 402 offers. Until then, whoever holds the signature can settle it.
 */
export const MAX_TIMEOUT_SECONDS = 300;
/** The longest signing may take, the NEAR RPC's reads included. */
export const SIGNING_TIMEOUT_MS = 30_000;
// Base: the SDK and the app read this machine's clock a moment apart
const CLOCK_SKEW_SECONDS = 5n;
const VALID_BEFORE_SLACK_SECONDS = 30n;
// NEAR: the signer reads the block height a moment after the app does
const NEAR_HEIGHT_SLACK_BLOCKS = 50n;

export interface X402Choice extends Chosen {
  readonly way: X402Way;
  /** The routing link's `payment-required`, as it gave it, to sign from. */
  readonly required: PaymentRequired;
  /** The one option this app pays: the 402's own object, checked. */
  readonly option: PaymentRequirements;
  /** "0.011 USDC on Base". */
  readonly what: string;
}

/**
 * The option of the 402 to sign, checked before anything is signed: the `exact` scheme, the way's one
 * network, its known USDC, whose atomic unit is a micro-USD, a whole amount above zero, a recipient,
 * and a time limit. On Base, the USDC signing domain and EIP-3009, which needs no ETH. A `Stop`, not
 * charged, names what is wrong.
 */
export function checkOption(way: X402Way, raw: unknown): PaymentRequirements {
  const refuse = (why: string): never => {
    throw new Stop(`Anyfare's ${WAY_LABELS[way]} option ${why}, so the app won't sign it.`, { notCharged: true });
  };
  if (!isRecord(raw)) return refuse('is not an object');
  const network = X402_NETWORKS[way];
  if (raw['scheme'] !== 'exact') refuse('is not of the exact scheme');
  if (raw['network'] !== network) refuse(`is not on ${networkName(network)}`);
  const asset = raw['asset'];
  if (typeof asset !== 'string' || !isKnownUsdc(network, asset)) refuse(`is not the known USDC of ${networkName(network)}`);
  const amount = raw['amount'];
  if (typeof amount !== 'string' || !/^[0-9]{1,30}$/.test(amount) || BigInt(amount) === 0n) {
    refuse('has no amount this app can read');
  }
  const payTo = raw['payTo'];
  if (typeof payTo !== 'string' || !(way === 'base' ? EVM_ADDRESS.test(payTo) : isNearAccountId(payTo))) {
    refuse('has no recipient this app can read');
  }
  const timeout = raw['maxTimeoutSeconds'];
  if (typeof timeout !== 'number' || !Number.isSafeInteger(timeout) || timeout <= 0) refuse('has no time limit this app can read');
  // The SDK signs a payment valid for this long: on Base until now and this many seconds, on NEAR for this many blocks
  if ((timeout as number) > MAX_TIMEOUT_SECONDS) refuse(`asks for a payment valid for more than ${MAX_TIMEOUT_SECONDS} seconds`);
  const extra = raw['extra'] ?? {};
  if (!isRecord(extra)) return refuse('has extra fields that are not an object');
  if (way === 'base') {
    // The EIP-712 domain of the USDC contract: the signature is made for it
    if (typeof extra['name'] !== 'string' || extra['name'] === '' || typeof extra['version'] !== 'string' || extra['version'] === '') {
      refuse('names no signing domain for USDC');
    }
    // EIP-3009 moves the USDC itself, with no ETH and no approval. Permit2 would need both.
    const method = extra['assetTransferMethod'];
    if (method !== undefined && method !== 'eip3009') refuse('moves USDC another way than EIP-3009');
  }
  return raw as PaymentRequirements;
}

/**
 * The one option of the routing link's 402 that `--pay <way>` pays. None, or more than one: a `Stop`,
 * not charged. Its amount is in micro-USD, since it is USDC with 6 decimals.
 */
export function chooseX402(plan: Plan, way: X402Way): X402Choice {
  const unpaid = plan.anyfare.kind === 'ok' ? plan.anyfare.value : undefined;
  const offers = unpaid?.offers.filter((offer) => payWayOf(offer) === way) ?? [];
  const label = WAY_LABELS[way];
  if (offers.length === 0) throw new Stop(`Anyfare offers no ${label} for this call now.`, { notCharged: true });
  if (offers.length > 1) {
    throw new Stop(`Anyfare offers ${label} more than once for this call, so the app can't tell which one to pay.`, {
      notCharged: true,
    });
  }
  const required = unpaid?.paymentRequired;
  if (required === undefined || required['x402Version'] !== 2) {
    throw new Stop("Anyfare's 402 is not x402 version 2, the one this app pays.", { notCharged: true });
  }
  const option = checkOption(way, offers[0]?.raw);
  const micro = BigInt(option.amount);
  const what = amountText(option.network, option.asset, micro);
  return { way, required: required as unknown as PaymentRequired, option, micro, asks: `Anyfare asks ${what}`, what };
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

/** The x402 client that signs on Base only, with its spend controls at the cap. */
export function baseClient(signer: ClientEvmSigner, option: PaymentRequirements, cap: bigint): x402Client {
  return new x402Client().setSpendControls(spendControlsFor(option, cap)).register(X402_NETWORKS.base, new ExactEvmScheme(signer));
}

/** The x402 client that signs on NEAR only, with its spend controls at the cap. */
export function nearClient(signer: ClientNearSigner, option: PaymentRequirements, cap: bigint): x402Client {
  return new x402Client().setSpendControls(spendControlsFor(option, cap)).register(X402_NETWORKS.near, new ExactNearScheme(signer));
}

/**
 * A text with every part of the NEAR RPC's URL taken out but its host: the URL, its path, its query,
 * and each of their parts. Any of them may hold a key.
 */
export function scrubRpcUrl(text: string, rpcUrl: string): string {
  let url: URL | undefined;
  try {
    url = new URL(rpcUrl);
  } catch {
    url = undefined;
  }
  const parts = [rpcUrl, url?.href, url === undefined ? undefined : `${url.origin}${url.pathname}`, url?.pathname, url?.search];
  for (const segment of url?.pathname.split('/') ?? []) {
    parts.push(segment);
    // A stray `%` is not an escape: the segment is scrubbed as it is
    try {
      parts.push(decodeURIComponent(segment));
    } catch {
      // Nothing more to scrub
    }
  }
  for (const [name, value] of url?.searchParams ?? []) parts.push(name, value);
  let scrubbed = text;
  for (const part of parts.filter((item): item is string => item !== undefined && item.length >= 2 && item !== '/')) {
    scrubbed = scrubbed.split(part).join('…');
  }
  return scrubbed;
}

/** A failure of the app's own read of the NEAR RPC. Its message is the app's own, and names nothing but a status. */
class NearRpcFailure extends Error {}

/**
 * The reason of a `fetch` to `rpcUrl` that failed before any answer, in the error or its causes, as a
 * code, or a few plain words with nothing of the URL in them; `undefined` when there is none.
 */
export function fetchFailure(error: unknown, rpcUrl: string): string | undefined {
  let item: unknown = error;
  for (let depth = 0; item instanceof Error && depth < 5; depth += 1, item = item.cause) {
    if (item instanceof TypeError && item.message === 'fetch failed') {
      const cause = item.cause as { code?: unknown; message?: unknown } | undefined;
      if (typeof cause?.code === 'string' && /^[A-Z][A-Z0-9_]{1,40}$/.test(cause.code)) return cause.code;
      // A few plain words, such as "bad port", once anything of the URL is out of them
      const words = typeof cause?.message === 'string' ? scrubRpcUrl(cause.message, rpcUrl) : '';
      return /^[A-Za-z][A-Za-z ]{0,39}$/.test(words) ? words : '';
    }
  }
  return undefined;
}

const SPEND_CONTROLS = /rejected by spendControls/;
const NO_ACCESS_KEY = /UNKNOWN_ACCESS_KEY|AccessKeyDoesNotExist|access key .*(does ?n.t exist|not found|never been observed)/i;
const NO_ACCOUNT = /UNKNOWN_ACCOUNT|AccountDoesNotExist|account .*(does ?n.t exist|not found)/i;

/**
 * Why the NEAR signer failed, in a fixed line that names the RPC by its host only. The SDK's and the
 * RPC's own texts are never shown: they can hold the RPC's whole URL, with a key in its path or query.
 */
export function nearSigningFailure(error: unknown, wallet: NearWallet): string {
  const at = `the NEAR RPC at ${wallet.rpcHost}`;
  if (error instanceof NearRpcFailure) return `${at} ${error.message}`;
  const reason = fetchFailure(error, wallet.rpcUrl);
  if (reason !== undefined) return `${at} could not be reached${reason === '' ? '' : ` (${reason})`}`;
  // Read to pick a line, never printed
  const { message = '', type = '', name = '' } = (error ?? {}) as { message?: unknown; type?: unknown; name?: unknown };
  const text = `${String(message)} ${String(type)} ${String(name)}`;
  if (SPEND_CONTROLS.test(text)) return "the x402 client's spend controls refused it";
  if (NO_ACCESS_KEY.test(text)) return `${at} says NEAR_PRIVATE_KEY is not an access key of ${wallet.payer}`;
  if (NO_ACCOUNT.test(text)) return `${at} knows no account ${wallet.payer}`;
  return `${at} answered with an error`;
}

/** Why signing on Base failed. It is local: its text names no URL, and `clip` hides anything shaped like a key. */
function baseSigningFailure(error: unknown): string {
  return `the x402 client refused: ${clip(error instanceof Error ? error.message : String(error)).replace(/[.]+$/, '')}`;
}

/** The final block's height, read once from the NEAR RPC the signer uses, a moment before it signs. */
async function finalHeight(fetchFn: Fetch, wallet: NearWallet, signal: AbortSignal): Promise<bigint> {
  const response = await fetchFn(wallet.rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'anyfare-cli', method: 'block', params: { finality: 'final' } }),
    redirect: 'error',
    signal,
  });
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  const result = isRecord(body) && isRecord(body['result']) ? body['result'] : {};
  const height = isRecord(result['header']) ? result['header']['height'] : undefined;
  if (!response.ok) throw new NearRpcFailure(`answered ${response.status}`);
  if (typeof height !== 'number' || !Number.isSafeInteger(height) || height < 0) throw new NearRpcFailure('answered with no block height');
  return BigInt(height);
}

interface Signed {
  readonly payload: PaymentPayload;
  /** NEAR: the final block's height the app read before signing. */
  readonly nearHeight?: bigint;
}

/**
 * What `work` gives, or `'late'` when `limitMs` runs out first. Its failure after the limit is no
 * one's to hear, and the timer is cleared either way, so it keeps no process alive.
 */
export async function raceLimit<T>(work: Promise<T>, limitMs: number): Promise<T | 'late'> {
  work.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<'late'>((resolve) => {
    timer = setTimeout(() => resolve('late'), limitMs);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One signature, for the chosen option only, within `limitMs`. When it fails, no payment has left the
 * process: on NEAR the app and the signer have at most read the block height and the key's nonce from
 * the RPC. So it is not charged. The SDK takes no abort signal: a signature it makes after the limit
 * is dropped, never checked and never sent, and the process exits without waiting for it.
 */
async function signOnce(ctx: Context, chosen: X402Choice, wallet: Wallet, cap: bigint, limitMs: number): Promise<Signed> {
  const required: PaymentRequired = { ...chosen.required, accepts: [chosen.option] };
  const controller = new AbortController();
  const work = (async (): Promise<Signed> => {
    if (wallet.way === 'base') return { payload: await baseClient(wallet.account, chosen.option, cap).createPaymentPayload(required) };
    const nearHeight = await finalHeight(ctx.io.fetch, wallet, controller.signal);
    return { payload: await nearClient(wallet.signer(), chosen.option, cap).createPaymentPayload(required), nearHeight };
  })();
  let signed: Signed | 'late';
  try {
    signed = await raceLimit(work, limitMs);
  } catch (error) {
    const why = wallet.way === 'near' ? nearSigningFailure(error, wallet) : baseSigningFailure(error);
    throw new Stop(`Could not sign the payment: ${why}. Nothing was sent.`, { notCharged: true });
  } finally {
    controller.abort();
  }
  if (signed === 'late') {
    const who = wallet.way === 'near' ? `the NEAR RPC at ${wallet.rpcHost}` : 'the signer';
    throw new Stop(`Could not sign the payment: ${who} did not answer in ${limitText(limitMs)}. Nothing was sent.`, { notCharged: true });
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
  // NEAR_RPC_URL, or the SDK's public one, over https, so no one on the way changes its answers; and
  // Anyfare's facilitator refuses a delegate action valid for more blocks than the option, by the chain.
  if (delegate.maxBlockHeight - height > BigInt(option.maxTimeoutSeconds) + NEAR_HEIGHT_SLACK_BLOCKS) {
    refuse(`it stays valid for more blocks than the option's ${option.maxTimeoutSeconds} seconds`);
  }
}

/** A whole number written as digits, as the SDK writes EIP-3009's times; `undefined` for anything else, a float included. */
const wholeNumber = (value: unknown): bigint | undefined =>
  typeof value === 'string' && /^[0-9]{1,30}$/.test(value) ? BigInt(value) : undefined;

/**
 * What was signed, checked before it is sent: the option it names is the chosen one, and the signed
 * part moves that amount of that asset from the payer to that recipient, valid for no longer than the
 * option. On Base against this machine's clock, on NEAR against `nearHeight`, the app's own read of
 * the RPC. A `Stop`, not charged.
 */
export function checkSigned(
  option: PaymentRequirements,
  payer: string,
  payload: PaymentPayload,
  bounds: { readonly nowSeconds?: bigint; readonly nearHeight?: bigint } = {},
): void {
  const refuse: Refuse = (why) => {
    throw new Stop(`The signed payment is not the one the app chose: ${why}. Nothing was sent.`, { notCharged: true });
  };
  const network = option.network;
  if (payload.x402Version !== 2) refuse('it is not x402 version 2');
  const accepted: unknown = payload.accepted;
  if (!isRecord(accepted)) return refuse('it names no option');
  if (accepted['scheme'] !== option.scheme || accepted['network'] !== network) refuse('it names another scheme or network');
  const same = (value: unknown, expected: string): boolean => typeof value === 'string' && sameAddress(network, value, expected);
  if (!same(accepted['asset'], option.asset)) refuse('it names another asset');
  if (accepted['amount'] !== option.amount) refuse('it names another amount');
  if (!same(accepted['payTo'], option.payTo)) refuse('it names another recipient');
  const signed: unknown = payload.payload;
  if (!isRecord(signed)) return refuse('it holds no signed part');
  if (network === X402_NETWORKS.base) {
    const authorization = signed['authorization'];
    if (!isRecord(authorization) || signed['permit2Authorization'] !== undefined) return refuse('it is not an EIP-3009 authorization');
    if (!same(authorization['from'], payer)) refuse('it pays from another address');
    if (!same(authorization['to'], option.payTo)) refuse('it pays another recipient');
    if (authorization['value'] !== option.amount) refuse('it pays another amount');
    if (typeof signed['signature'] !== 'string' || !/^0x[0-9a-fA-F]+$/.test(signed['signature'])) refuse('it carries no signature');
    const now = bounds.nowSeconds ?? BigInt(Math.floor(Date.now() / 1000));
    const validAfter = wholeNumber(authorization['validAfter']);
    const validBefore = wholeNumber(authorization['validBefore']);
    if (validAfter === undefined || validBefore === undefined) return refuse("its validity window can't be read");
    // The SDK signs one valid from 0 until now and the option's seconds
    if (validAfter > now + CLOCK_SKEW_SECONDS) refuse('it only becomes valid later');
    if (validBefore > now + BigInt(option.maxTimeoutSeconds) + VALID_BEFORE_SLACK_SECONDS) {
      refuse(`it stays valid longer than the option's ${option.maxTimeoutSeconds} seconds`);
    }
    return;
  }
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
  // Broadcast and not final: Anyfare sent the answer, and finishes the settlement
  if (decoded['errorReason'] === 'settlement_pending' && transaction !== undefined) return { kind: 'pending', transaction, ...fields };
  return { kind: 'failed', reason: clip(text('errorReason') ?? 'no reason given') };
}

/** The proof's lines on stdout, and a warning for anything in it that is not what was paid. */
function printProof(ctx: Context, chosen: X402Choice, wallet: Wallet, answer: Answer, check: string): void {
  const proof = readProof(answer.headers.get('payment-response'));
  if (proof.kind === 'missing') {
    ctx.warn(`No PAYMENT-RESPONSE came with the answer: ${check}.`);
    return;
  }
  if (proof.kind === 'unreadable') {
    ctx.warn(`The PAYMENT-RESPONSE that came with the answer is unreadable: ${check}.`);
    return;
  }
  if (proof.kind === 'failed') {
    ctx.warn(`The PAYMENT-RESPONSE says the payment did not settle (${proof.reason}): ${check}.`);
    return;
  }
  const explorer = EXPLORERS[chosen.way];
  const linked = explorer.hash.test(proof.transaction);
  const network = chosen.option.network;
  const payer = proof.payer ?? wallet.payer;
  const pending = proof.kind === 'pending' ? ', not final yet: Anyfare finishes its settlement' : '';
  // A Base hash has the shape of a private key, which `clip` hides: one of that shape is shown as it is
  const transaction = linked ? proof.transaction : clip(proof.transaction);
  ctx.print([
    `  Paid ${chosen.what} from ${clip(payer)}: transaction ${transaction}${pending}`,
    ...(linked ? [`  ${ctx.style.styles.link(explorer.transaction(proof.transaction))}`] : []),
  ]);
  if (!linked) ctx.warn(`The transaction is not a ${networkName(network)} transaction hash, so there is no link to it.`);
  if (proof.network !== undefined && proof.network !== network) {
    ctx.warn(`The PAYMENT-RESPONSE names another network, ${clip(proof.network)}, not ${networkName(network)}.`);
  }
  if (proof.payer !== undefined && !sameAddress(network, proof.payer, wallet.payer)) {
    ctx.warn(`The PAYMENT-RESPONSE names another payer, ${clip(proof.payer)}, not ${wallet.payer}.`);
  }
}

const IN_FLIGHT = /another NEAR payment in flight/i;
const USED_BEFORE = /already used/i;

/**
 * The proxy's x402 answers, as `serve` and the x402 rail make them. `payment_invalid`,
 * `facilitator_unavailable` and `redis_not_ready` refuse the payment before the API is called.
 * `payment_unavailable`, `quote_exceeded`, `response_too_large` and `upstream_unavailable` cancel the
 * verified payment before it settles: only a `2xx` is settled, before its answer goes out.
 * `settlement_failed` may have settled. `check` says where the payer's payments are seen.
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

/** How long a signed payment stays valid, for the plan: "5 minutes"; on NEAR in blocks, of about 0.6 seconds each. */
export function validFor(way: X402Way, seconds: number): string {
  const time = (value: number): string =>
    value % 60 === 0 ? `${value / 60} minute${value === 60 ? '' : 's'}` : `${value} second${value === 1 ? '' : 's'}`;
  return way === 'base' ? time(seconds) : `${seconds} block${seconds === 1 ? '' : 's'}, about ${time(Math.max(1, Math.round(seconds * 0.6)))}`;
}

/** `call --pay base` and `call --pay near`. `signingMs` bounds the signing, 30 seconds unless a test says less. Returns the exit code. */
export async function callWithX402(
  ctx: Context,
  command: CallCommand,
  way: X402Way,
  limits: { readonly signingMs?: number } = {},
): Promise<number> {
  const { style } = ctx;
  const config = loadConfig(ctx.session.env);
  const { plan, chosen } = await readPaidPlan(ctx, config, command, way, (read) => chooseX402(read, way));
  // Only now, so that a call this app can't pay never needs a wallet
  const wallet = readWallet(ctx.session.env, way);
  const { option, what } = chosen;
  const to: [string, string][] = [
    ['To', option.payTo],
    ['From', wallet.payer],
    ['Valid for', validFor(way, option.maxTimeoutSeconds)],
  ];
  const field = (label: string, value: string): string => style.field(label, value, 15);
  ctx.print(
    command.explain
      ? [field('You pay', style.styles.money(what)), ...to.map(([label, value]) => field(label, value))]
      : shortPlan(ctx, plan, chosen.micro, what, to),
  );
  await ctx.approve({
    yes: command.yes,
    question: `Pay ${what} to ${option.payTo}?`,
    noTerminal: NO_TERMINAL,
    declined: new Stop('Nothing was signed or sent.', { notCharged: true }),
  });

  ctx.print(style.step(`Signing ${what} to ${option.payTo}`));
  const { payload, nearHeight } = await signOnce(ctx, chosen, wallet, config.maxPayment, limits.signingMs ?? SIGNING_TIMEOUT_MS);
  checkSigned(option, wallet.payer, payload, nearHeight === undefined ? {} : { nearHeight });
  const check = `${EXPLORERS[way].address(wallet.payer)} shows your payments`;
  ctx.print(callingLine(ctx, plan));
  const answer = await sendOnce(ctx, plan, { 'payment-signature': encodePaymentSignatureHeader(payload) }, check);
  if (answer.status < 200 || answer.status >= 300) throw stopForAnswer(answer, plan, way, x402Lines(check));
  ctx.print(plan.prepared.format(answer.body).map((line) => `  ${line}`));
  printProof(ctx, chosen, wallet, answer, check);
  ctx.print(style.done(storyLine(plan, `You paid in ${WAY_LABELS[way]}.`)));
  return 0;
}
