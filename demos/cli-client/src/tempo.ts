// A routed call paid with MPP, USDC.e on Tempo, from the buyer's own Tempo wallet: the routing link's
// 402, the one Tempo charge this app pays, checked, the cap, the confirmation, one transaction signed
// for that charge only, its network fee in USDC.e and bounded, never broadcast by the app, one request
// that is never retried, and the proof.

import { Challenge, Credential, Receipt } from 'mppx';
import { Mppx, tempo as tempoMethods } from 'mppx/client';
import { BaseError, createClient, decodeFunctionData, http, keccak256 } from 'viem';
import type { Hex } from 'viem';
import { tempo } from 'viem/chains';
import { Abis, Transaction } from 'viem/tempo';
import { loadConfig } from './config.ts';
import type { Context } from './context.ts';
import { clip, retryIn } from './errors.ts';
import type { ErrorTable } from './errors.ts';
import { WAY_LABELS } from './explain.ts';
import type { Plan } from './explain.ts';
import { limitText } from './http.ts';
import type { Answer, Fetch } from './http.ts';
import { amountText, sameAddress } from './networks.ts';
import { isKnownTempoUsdc, payWayOf } from './offers.ts';
import { askToPay, callingLine, payerLines, printResult, readPaidPlan, sendOnce, shortPlan, stopForAnswer, storyLine } from './paid.ts';
import type { CallCommand, Chosen } from './paid.ts';
import { Stop, isRecord, toAtomic, usd } from './util.ts';
import { EXPLORERS, readTempoWallet } from './wallets.ts';
import type { TempoWallet } from './wallets.ts';
import { SIGNING_TIMEOUT_MS, fetchFailure, raceLimit } from './x402.ts';

export const TEMPO_CHAIN_ID = 4217;
export const TEMPO_NETWORK = `eip155:${TEMPO_CHAIN_ID}`;
/** The longest a charge may stay open, in seconds: the longest window Anyfare's rail takes for a signed transaction. */
export const MAX_CHARGE_LIFETIME_SECONDS = 600;
// A signed transaction may stay valid at most this long past the charge it pays
const VALID_BEFORE_SLACK_SECONDS = 60;
// The client and the app read this machine's clock a moment apart
const CLOCK_SKEW_SECONDS = 5;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
export const RECEIPT_HEADER = 'payment-receipt';
const LABEL = WAY_LABELS.tempo;

/**
 * The highest network fee the app lets a Tempo transfer allow, in US dollars. The fee comes from the
 * RPC's answers: gas, and the highest price per gas. A transfer of USDC.e costs well under a tenth of a
 * cent; this leaves a margin for a busy chain, and keeps a hostile RPC from setting a fee of dollars.
 */
export const MAX_TEMPO_FEE_USD = '0.01';
/** `MAX_TEMPO_FEE_USD` in micro-USD. */
export const MAX_TEMPO_FEE = toAtomic(MAX_TEMPO_FEE_USD, 6);
/**
 * Tempo prices gas in attodollars, 10^-18 US dollars, and charges the fee in the fee token: viem's own
 * highest fee for a Tempo transaction is gas × maxFeePerGas / 10^12, in units of a token of 6 decimals,
 * which for USDC.e are micro-USD.
 */
const ATTODOLLARS_PER_MICRO_USD = 10n ** 12n;

/**
 * How the charge client signs, set explicitly whatever its defaults. `pull`: it signs a transaction and
 * never broadcasts it. Anyfare broadcasts it after the API answers, and refuses a push credential, the
 * hash of a transaction the buyer broadcast. No auto-swap: it would swap other tokens of the wallet
 * into USDC.e.
 */
export const CHARGE_OPTIONS = { mode: 'pull', autoSwap: false } as const;

export type Refuse = (why: string) => never;

export interface TempoChoice extends Chosen {
  /** The one charge of the 402 this app pays, as the 402 gave it, checked. */
  readonly challenge: Challenge.Challenge;
  readonly currency: string;
  readonly recipient: string;
  /** When the charge closes, in milliseconds. */
  readonly expiresMs: number;
  /** "0.0012 USDC.e on Tempo". */
  readonly what: string;
}

/** The realm Anyfare binds its charges to: the host of its pay URL. */
export function realmOf(payUrl: string): string {
  return new URL(payUrl).host;
}

/**
 * The charge to sign, checked before anything is signed: a Tempo charge on chain 4217, in the known
 * USDC.e, whose atomic unit is a micro-USD, of a whole amount above zero, to one recipient, with no
 * splits, no fee payer and no swap, that takes a signed transaction, that closes in the future and
 * within 10 minutes, for `realm`. A `Stop`, not charged, names what is wrong.
 */
export function checkCharge(raw: unknown, realm: string, nowMs: number = Date.now()): TempoChoice {
  const refuse: Refuse = (why) => {
    throw new Stop(`Anyfare's ${LABEL} charge ${why}, so the app won't sign it.`, { notCharged: true });
  };
  if (!isRecord(raw) || !isRecord(raw['request'])) return refuse('has no request this app can read');
  const challenge = raw as unknown as Challenge.Challenge;
  if (challenge.method !== 'tempo' || challenge.intent !== 'charge') refuse('is not a Tempo charge');
  const request = challenge.request;
  const details = request['methodDetails'] ?? {};
  if (!isRecord(details)) return refuse('has method details that are not an object');
  if (details['chainId'] !== TEMPO_CHAIN_ID) refuse('is not on Tempo');
  const currency = request['currency'];
  if (typeof currency !== 'string' || !isKnownTempoUsdc(currency)) refuse('is not in the known USDC.e of Tempo');
  const amount = request['amount'];
  if (typeof amount !== 'string' || !/^[0-9]{1,30}$/.test(amount) || BigInt(amount) === 0n) refuse('has no amount this app can read');
  const recipient = request['recipient'];
  if (typeof recipient !== 'string' || !EVM_ADDRESS.test(recipient)) refuse('names no recipient this app can read');
  // The client would pay a share of it to each split's recipient
  if (details['splits'] !== undefined) refuse('splits the payment with other recipients');
  // The buyer's own transaction pays its fee
  if (details['feePayer'] !== undefined && details['feePayer'] !== false) refuse('asks for a fee payer');
  // The client would sign a swap route in place of the transfer
  if (details['machineTokenEnabled'] !== undefined && details['machineTokenEnabled'] !== false) refuse('asks for a swap in place of a transfer');
  const modes = details['supportedModes'];
  if (modes !== undefined && !(Array.isArray(modes) && modes.includes('pull'))) {
    refuse('takes no signed transaction for Anyfare to broadcast');
  }
  // Anyfare's own server refuses a credential for a charge without one, and it bounds what is signed
  const expires = challenge.expires;
  if (expires === undefined) refuse('has no expiry');
  const expiresMs = Date.parse(expires);
  if (!Number.isFinite(expiresMs)) refuse("has an expiry this app can't read");
  if (expiresMs <= nowMs) refuse('has expired');
  if (expiresMs - nowMs > MAX_CHARGE_LIFETIME_SECONDS * 1000) {
    refuse(`stays open for more than ${MAX_CHARGE_LIFETIME_SECONDS / 60} minutes`);
  }
  if (challenge.realm !== realm) refuse(`is for ${clip(challenge.realm)}, not ${realm}`);
  const micro = BigInt(amount);
  const what = amountText(TEMPO_NETWORK, currency, micro);
  return { challenge, currency, recipient, micro, what, asks: `Anyfare asks ${what}`, expiresMs };
}

/**
 * The one charge of the routing link's 402 that `--pay tempo` pays. None, or more than one: a `Stop`,
 * not charged. Its amount is in micro-USD, since it is USDC.e with 6 decimals.
 */
export function chooseTempo(plan: Plan, nowMs: number = Date.now()): TempoChoice {
  const unpaid = plan.anyfare.kind === 'ok' ? plan.anyfare.value : undefined;
  const offers = unpaid?.offers.filter((offer) => payWayOf(offer) === 'tempo') ?? [];
  if (offers.length === 0) throw new Stop(`Anyfare offers no ${LABEL} for this call now.`, { notCharged: true });
  if (offers.length > 1) {
    throw new Stop(`Anyfare offers ${LABEL} more than once for this call, so the app can't tell which one to pay.`, {
      notCharged: true,
    });
  }
  return checkCharge(offers[0]?.raw, realmOf(plan.config.payUrl), nowMs);
}

/** How long a signed payment can stay valid at most, for the plan: "45 seconds", "5 minutes". */
export function windowText(seconds: number): string {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

/** The 402 the client signs from: the one chosen charge alone, so that it can pick no other. */
function chargeResponse(challenge: Challenge.Challenge): Response {
  return new Response(null, { status: 402, headers: { 'www-authenticate': Challenge.serialize(challenge) } });
}

/**
 * `mppx`'s client with the Tempo charge only, for the wallet's key, with `CHARGE_OPTIONS`. Its viem
 * client pays the network fee in `feeToken`, and reads the wallet's Tempo RPC with `fetchFn`, with no
 * retries and no redirects, until `signal` aborts.
 */
export function chargeClient(wallet: TempoWallet, fetchFn: Fetch, signal: AbortSignal, feeToken: string) {
  const rpcFetch: Fetch = (input, init) =>
    fetchFn(input, { ...init, redirect: 'error', signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal });
  // viem's Tempo chain puts the chain's fee token in the request before the RPC fills it, and then takes
  // none from the fill: the RPC can't choose the token the fee is paid in
  const chain = tempo.extend({ feeToken: feeToken as Hex });
  const client = createClient({ chain, transport: http(wallet.rpcUrl, { retryCount: 0, fetchFn: rpcFetch }) });
  return Mppx.create({
    methods: [tempoMethods.charge({ account: wallet.account, getClient: () => client, ...CHARGE_OPTIONS })],
    polyfill: false,
  });
}

// The errors viem makes of a node's own refusal to run the transfer, from its code or its words
const WOULD_FAIL = new Set(['ExecutionRevertedError', 'InsufficientFundsError']);

/**
 * Why signing failed, in a fixed line that names the Tempo RPC by its host only. viem's and the
 * client's own texts are never shown: viem's hold the RPC's whole URL, with a key in its path or query.
 * viem wraps any failure of a fill or a gas estimate in the same outer errors, so the line is decided
 * by what is inside them: a transport or HTTP failure, then a revert of the transfer, then any other
 * RPC error.
 */
export function tempoSigningFailure(error: unknown, wallet: TempoWallet): string {
  const at = `the Tempo RPC at ${wallet.rpcHost}`;
  const reason = fetchFailure(error, wallet.rpcUrl);
  if (reason !== undefined) return `${at} could not be reached${reason === '' ? '' : ` (${reason})`}`;
  // The error and its causes, read to pick a line, never printed
  const causes: { readonly name?: unknown; readonly status?: unknown }[] = [];
  for (let item: unknown = error, depth = 0; item instanceof Error && depth < 10; depth += 1, item = item.cause) causes.push(item);
  const http = causes.find((item) => item.name === 'HttpRequestError');
  if (http !== undefined) return typeof http.status === 'number' ? `${at} answered ${http.status}` : `${at} answered with an error`;
  if (causes.some((item) => item.name === 'TimeoutError')) return `${at} did not answer in time`;
  if (causes.some((item) => typeof item.name === 'string' && WOULD_FAIL.has(item.name))) {
    return `${at} says the transfer would fail, such as for a balance too low`;
  }
  if (error instanceof BaseError) return `${at} answered with an error`;
  return 'the MPP client refused to sign it';
}

/**
 * One credential, for the chosen charge only, within `limitMs`. When it fails, no payment has left the
 * process: the client signs in pull mode, and has at most read fees and gas from the RPC. So it is not
 * charged. A credential made after the limit is dropped, never checked and never sent.
 */
export async function signCredential(
  fetchFn: Fetch,
  chosen: TempoChoice,
  wallet: TempoWallet,
  limitMs: number = SIGNING_TIMEOUT_MS,
): Promise<string> {
  // The charge may have closed while the app asked
  if (chosen.expiresMs <= Date.now()) {
    throw new Stop(`Anyfare's ${LABEL} charge closed before it was signed. Nothing was signed or sent.`, { notCharged: true });
  }
  const controller = new AbortController();
  const work = (async () =>
    chargeClient(wallet, fetchFn, controller.signal, chosen.currency).createCredential(chargeResponse(chosen.challenge), CHARGE_OPTIONS))();
  let credential: string | 'late';
  try {
    credential = await raceLimit(work, limitMs);
  } catch (error) {
    throw new Stop(`Could not sign the payment: ${tempoSigningFailure(error, wallet)}. Nothing was sent.`, { notCharged: true });
  } finally {
    // Ends any read of the RPC still in flight, so the process need not wait for it
    controller.abort();
  }
  if (credential === 'late') {
    throw new Stop(`Could not sign the payment: the Tempo RPC at ${wallet.rpcHost} did not answer in ${limitText(limitMs)}. Nothing was sent.`, {
      notCharged: true,
    });
  }
  return credential;
}

const sameEvm = (value: unknown, expected: string): boolean => typeof value === 'string' && sameAddress(TEMPO_NETWORK, value, expected);

/**
 * What a decoded Tempo transaction does: on chain 4217, from the payer, with no fee payer and nothing
 * authorized beside it, its fee paid in USDC.e, one transfer of the amount of USDC.e to the recipient,
 * valid from now at the latest and until no later than a minute past the charge, by this machine's clock.
 */
export function checkTransfer(
  transaction: Readonly<Record<string, unknown>>,
  chosen: Pick<TempoChoice, 'currency' | 'recipient' | 'micro' | 'expiresMs'>,
  payer: string,
  nowSeconds: number,
  refuse: Refuse,
): void {
  if (transaction['type'] !== 'tempo') refuse('it is not a Tempo transaction');
  if (transaction['chainId'] !== TEMPO_CHAIN_ID) refuse('it is signed for another chain');
  if (!sameEvm(transaction['from'], payer)) refuse('it pays from another address');
  // With a fee payer, someone else would pay the fee, and choose the token it is paid in
  if (transaction['feePayerSignature'] !== undefined) refuse('it has a fee payer');
  // A key authorization adds a key to the account; an authorization list delegates it to a contract
  if (transaction['keyAuthorization'] !== undefined || transaction['authorizationList'] !== undefined) {
    refuse('it authorizes more than the transfer');
  }
  // The client is told the charge's own currency; without a fee token, the chain picks one for the payer
  const feeToken = transaction['feeToken'];
  if (feeToken === undefined) refuse('it names no token for its network fee');
  if (!sameEvm(feeToken, chosen.currency)) refuse('it pays its network fee in another token than USDC.e');
  const calls = transaction['calls'];
  if (!Array.isArray(calls) || calls.length !== 1 || !isRecord(calls[0])) return refuse('it is not one transfer');
  const call = calls[0];
  if (!sameEvm(call['to'], chosen.currency)) refuse('it calls another contract than USDC.e');
  if (call['value'] !== undefined && call['value'] !== 0n) refuse('it sends value beside the transfer');
  let decoded: { readonly functionName: string; readonly args?: readonly unknown[] | undefined };
  try {
    decoded = decodeFunctionData({ abi: Abis.tip20, data: call['data'] as Hex });
  } catch {
    return refuse("its transfer can't be read");
  }
  if (decoded.functionName !== 'transfer' && decoded.functionName !== 'transferWithMemo') refuse('it is not one transfer');
  const [to, value] = decoded.args ?? [];
  if (!sameEvm(to, chosen.recipient)) refuse('it pays another recipient');
  if (value !== chosen.micro) refuse('it pays another amount');
  const validBefore = transaction['validBefore'];
  const validAfter = transaction['validAfter'];
  if (typeof validBefore !== 'number' || !Number.isSafeInteger(validBefore)) return refuse('it never expires');
  if (validBefore <= nowSeconds) refuse('it has expired');
  // The client signs one valid for 25 seconds, and never past the charge
  if (validBefore > Math.floor(chosen.expiresMs / 1000) + VALID_BEFORE_SLACK_SECONDS) refuse('it stays valid longer than the charge');
  if (validAfter !== undefined && (typeof validAfter !== 'number' || validAfter > nowSeconds + CLOCK_SKEW_SECONDS)) {
    refuse('it only becomes valid later');
  }
}

/**
 * The highest network fee a decoded Tempo transaction allows, in micro-USD, rounded up: gas times the
 * highest price per gas. It must be at most `MAX_TEMPO_FEE`, and the charge and it together at most
 * `cap`. A `Stop`, not charged, names both amounts.
 */
export function checkFee(transaction: Readonly<Record<string, unknown>>, chosen: Pick<TempoChoice, 'micro' | 'what'>, cap: bigint): bigint {
  const refuse: Refuse = (why) => {
    throw new Stop(`The signed payment ${why}. Nothing was sent.`, { notCharged: true });
  };
  const gas = transaction['gas'];
  const price = transaction['maxFeePerGas'];
  if (typeof gas !== 'bigint' || typeof price !== 'bigint') return refuse("is not the one the app chose: its network fee can't be read");
  const fee = (gas * price + ATTODOLLARS_PER_MICRO_USD - 1n) / ATTODOLLARS_PER_MICRO_USD;
  if (fee > MAX_TEMPO_FEE) refuse(`allows a network fee of up to ${usd(fee)}, above the most the app lets a fee be, ${usd(MAX_TEMPO_FEE)}`);
  if (chosen.micro + fee > cap) {
    refuse(`pays ${chosen.what} and a network fee of up to ${usd(fee)}, ${usd(chosen.micro + fee)} in all, above your cap MAX_PAYMENT_USD of ${usd(cap)}`);
  }
  return fee;
}

export interface CheckedCredential {
  /** The signed transaction. */
  readonly signed: Hex;
  /** The highest network fee it allows, in micro-USD. */
  readonly maxFee: bigint;
  /** When it stops being valid, in Unix seconds. */
  readonly validBefore: number;
}

/**
 * What was signed, checked before it is sent: a credential in pull mode for the chosen charge, whose
 * signed transaction passes `checkTransfer` and `checkFee`. A `Stop`, not charged.
 */
export function checkCredential(
  header: string,
  chosen: TempoChoice,
  payer: string,
  cap: bigint,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): CheckedCredential {
  const refuse: Refuse = (why) => {
    throw new Stop(`The signed payment is not the one the app chose: ${why}. Nothing was sent.`, { notCharged: true });
  };
  // The whole Authorization value, as the proxy finds it: the Payment scheme and base64url
  if (!/^Payment [A-Za-z0-9_-]+$/.test(header)) refuse('it is not an MPP credential');
  let credential: Credential.Credential;
  try {
    credential = Credential.deserialize(header);
  } catch {
    return refuse('it is not an MPP credential');
  }
  let answers: boolean;
  try {
    answers = Challenge.serialize(credential.challenge) === Challenge.serialize(chosen.challenge);
  } catch {
    answers = false;
  }
  if (!answers) refuse('it answers another charge');
  const payload: unknown = credential.payload;
  // Pull mode: the signed transaction itself, never the hash of one already broadcast
  if (!isRecord(payload) || payload['type'] !== 'transaction' || typeof payload['signature'] !== 'string') {
    return refuse('it is not a transaction signed for Anyfare to broadcast');
  }
  const signed = payload['signature'];
  if (!/^0x[0-9a-fA-F]+$/.test(signed)) refuse("its transaction can't be read");
  let transaction: Record<string, unknown>;
  try {
    transaction = Transaction.deserialize(signed as Hex) as unknown as Record<string, unknown>;
  } catch {
    return refuse("its transaction can't be read");
  }
  checkTransfer(transaction, chosen, payer, nowSeconds, refuse);
  const maxFee = checkFee(transaction, chosen, cap);
  return { signed: signed as Hex, maxFee, validBefore: transaction['validBefore'] as number };
}

/** A signed transaction's hash, as Anyfare's rail and the chain derive it: the canonical envelope's. */
export async function transactionHash(signed: Hex): Promise<Hex> {
  return keccak256(await Transaction.serialize(Transaction.deserialize(signed) as Parameters<typeof Transaction.serialize>[0]));
}

export type ReceiptRead = { readonly kind: 'ok'; readonly reference: string } | { readonly kind: 'missing' } | { readonly kind: 'unreadable' };

/** `Payment-Receipt`, decoded: a successful Tempo receipt and its reference, the transaction hash. */
export function readReceipt(value: string | null): ReceiptRead {
  if (value === null) return { kind: 'missing' };
  let receipt: Receipt.Receipt;
  try {
    receipt = Receipt.deserialize(value);
  } catch {
    return { kind: 'unreadable' };
  }
  return receipt.method === 'tempo' && receipt.status === 'success' && receipt.reference !== ''
    ? { kind: 'ok', reference: receipt.reference }
    : { kind: 'unreadable' };
}

/** The proof's lines, and a warning for anything in it that is not what was paid. */
function proofOf(ctx: Context, chosen: TempoChoice, wallet: TempoWallet, answer: Answer, signed: { readonly hash: Hex; readonly maxFee: bigint }, check: string): string[] {
  const receipt = readReceipt(answer.headers.get(RECEIPT_HEADER));
  if (receipt.kind === 'missing') {
    ctx.warn(`No Payment-Receipt came with the answer: ${check}.`);
    return [];
  }
  if (receipt.kind === 'unreadable') {
    ctx.warn(`The Payment-Receipt that came with the answer is unreadable: ${check}.`);
    return [];
  }
  const explorer = EXPLORERS.tempo;
  const linked = explorer.hash.test(receipt.reference);
  // A hash has the shape of a private key, which `clip` hides: one of that shape is shown as it is
  const reference = linked ? receipt.reference : clip(receipt.reference);
  const lines = [
    `Paid ${chosen.what} from ${wallet.payer}, and a network fee of at most ${usd(signed.maxFee)}: transaction ${reference}`,
    ...(linked ? [ctx.style.styles.link(explorer.transaction(receipt.reference))] : []),
  ];
  if (!linked) {
    ctx.warn("The Payment-Receipt's reference is not a Tempo transaction hash, so there is no link to it.");
  } else if (receipt.reference.toLowerCase() !== signed.hash.toLowerCase()) {
    ctx.warn(`The Payment-Receipt names another transaction than the one you signed, ${signed.hash}: ${check}.`);
  }
  return lines;
}

const USED_BEFORE = /already used/i;

/**
 * The proxy's MPP answers, as its MPP rail and its routing make them. `payment_invalid` and
 * `payment_unavailable` refuse the credential before the API is called, and nothing is broadcast.
 * `upstream_unavailable` and every answer that is not billable drop the transaction unbroadcast. Only
 * after a `2xx` does Anyfare broadcast it, before its answer goes out: `settlement_failed` may have
 * landed. `check` says where the payer's payments are seen.
 */
export function mppLines(check: string): ErrorTable {
  return {
    payment_invalid: {
      line: (error) => {
        // Only if the request was sent twice on the way: the other copy may have been paid
        if (USED_BEFORE.test(error.message)) {
          return `Anyfare says this payment was used before, and took nothing for this request. Whether the other use was paid is not known: ${check}`;
        }
        return `Anyfare refused the payment, so nothing moved: ${clip(error.message).replace(/[.]+$/, '')}`;
      },
      notCharged: (error) => !USED_BEFORE.test(error.message),
    },
    payment_unavailable: {
      line: (error) => `Anyfare couldn't take the Tempo payment now, so nothing was paid; ${retryIn(error)}`,
      notCharged: true,
    },
    settlement_failed: {
      line: () => `The payment couldn't be settled, so the answer was not sent. Whether your transaction landed on Tempo is not known: ${check}`,
      notCharged: false,
    },
    upstream_unavailable: {
      line: () => "The API or Anyfare's payer failed, so Anyfare never broadcast your payment; retry later",
      notCharged: true,
    },
  };
}

/** `call --pay tempo`. `signingMs` bounds the signing, 30 seconds unless a test says less. Returns the exit code. */
export async function callWithTempo(ctx: Context, command: CallCommand, limits: { readonly signingMs?: number } = {}): Promise<number> {
  const { style } = ctx;
  const config = loadConfig(ctx.session.env);
  const cap = config.maxPayment;
  const { plan, chosen } = await readPaidPlan(ctx, config, command, 'tempo', (read) => chooseTempo(read));
  // The transfer has a network fee of its own, which the cap must leave room for
  const room = cap - chosen.micro;
  if (room <= 0n) {
    throw new Stop(`${chosen.asks}, all of your cap MAX_PAYMENT_USD of ${usd(cap)}, with nothing left for the network fee.`, { notCharged: true });
  }
  const feeBound = room < MAX_TEMPO_FEE ? room : MAX_TEMPO_FEE;
  // Only now, so that a call this app can't pay never needs a wallet
  const wallet = readTempoWallet(ctx.session.env);
  const { recipient, what } = chosen;
  const closesIn = Math.max(1, Math.ceil((chosen.expiresMs - Date.now()) / 1000));
  const to: [string, string][] = [
    ['To', recipient],
    ['From', wallet.payer],
    ['Network fee', `at most ${usd(feeBound)}, in ${LABEL}`],
  ];
  ctx.print([
    ...(command.explain ? payerLines(ctx, what, to) : shortPlan(ctx, plan, chosen.micro, what, to)),
    `  The charge closes in ${windowText(closesIn)}.`,
  ]);
  await askToPay(ctx, command, {
    question: `Pay ${what} to ${recipient}, plus a network fee of at most ${usd(feeBound)}?`,
    declined: new Stop('Nothing was signed or sent.', { notCharged: true }),
  });

  ctx.print(style.step(`Signing ${what} to ${recipient}`));
  const header = await signCredential(ctx.io.fetch, chosen, wallet, limits.signingMs ?? SIGNING_TIMEOUT_MS);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const { signed, maxFee, validBefore } = checkCredential(header, chosen, wallet.payer, cap, nowSeconds);
  let hash: Hex;
  try {
    hash = await transactionHash(signed);
  } catch {
    throw new Stop("The signed payment is not the one the app chose: its transaction can't be read. Nothing was sent.", { notCharged: true });
  }
  ctx.print(`  The signed transfer is valid for ${windowText(validBefore - nowSeconds)}. Its network fee is at most ${usd(maxFee)}.`);
  const check = `${EXPLORERS.tempo.address(wallet.payer)} shows your payments`;
  ctx.print(callingLine(ctx, plan));
  const answer = await sendOnce(ctx, plan, { authorization: header }, check);
  if (answer.status < 200 || answer.status >= 300) throw stopForAnswer(answer, plan, 'tempo', mppLines(check));
  const proof = proofOf(ctx, chosen, wallet, answer, { hash, maxFee }, check);
  printResult(ctx, plan, plan.prepared.format(answer.body), proof, storyLine(plan, `You paid in ${LABEL}.`));
  return 0;
}
