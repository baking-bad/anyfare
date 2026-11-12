// One request, paid in USDC on NEAR when it asks for it: the unpaid request, the 402 read, the plan,
// the checks and the question, one signature, one paid request that is never retried, the result,
// the proof and the balance after. It returns the exit code and never exits the process.
//
// "Nothing paid" is said only while nothing is signed. Once a signature exists: "Nothing was sent",
// "Not charged" only when it is proved, and "not known" otherwise.

import { encodePaymentSignatureHeader } from '@x402/core/http';
import type { PaymentRequirements } from '@x402/core/types';
import { findAnyfareCall, routedHost } from './anyfareCall.ts';
import type { CallLimits, CallLookup } from './anyfareCall.ts';
import { BALANCE_TIMEOUT_MS, nearText, readNearBalance, usdcText } from './balances.ts';
import type { NearBalance } from './balances.ts';
import type { AppOptions } from './cli.ts';
import type { Config } from './config.ts';
import type { Context } from './context.ts';
import { clip, httpErrorOf, isProxyEnvelope, stopFor } from './errors.ts';
import { MAX_BODY_BYTES, failureOf, request } from './http.ts';
import type { Answer } from './http.ts';
import { NEAR_NETWORK } from './networks.ts';
import { chooseOption, readX402 } from './offers.ts';
import { requestLine } from './request.ts';
import type { HttpRequest } from './request.ts';
import { answerLines, proofLines, proofRows } from './result.ts';
import { Stop, fromAtomic, usd } from './util.ts';
import { NEAR_ACCOUNT_ID, NEAR_EXPLORER, readNearAccount, readNearWallet } from './wallet.ts';
import type { NearWallet, RpcAddress } from './wallet.ts';
import { SIGNING_TIMEOUT_MS, checkSigned, readProof, signOnce, validFor, x402Lines } from './x402.ts';
import type { Proof } from './x402.ts';

/** The time limits: the unpaid request, the paid one, the signing, and each read of the balance. */
export const UNPAID_TIMEOUT_MS = 30_000;
export const PAID_TIMEOUT_MS = 60_000;

export interface PayLimits {
  readonly unpaidMs?: number;
  readonly paidMs?: number;
  readonly signingMs?: number;
  readonly balanceMs?: number;
  /** The lookup of a call paid through Anyfare. */
  readonly anyfareCall?: CallLimits;
}

const NOTHING_PAID = 'Nothing paid.';
const PLAN_LABEL_WIDTH = 15;
const BALANCE_LABEL_WIDTH = 10;
const CALLING_PATH_WIDTH = 40;

/** One turn of the event loop: input that has come in is read meanwhile. */
const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** A line that ends a sentence, then " Nothing paid.". */
const nothingPaid = (line: string): string => `${/[.!?]$/.test(line) ? line : `${line}.`} ${NOTHING_PAID}`;

/** Whether the request goes to Anyfare's pay host: its origin is the origin of `ANYFARE_PAY_URL`. */
export function isPayHost(url: string, config: Config): boolean {
  return URL.parse(url)?.origin === URL.parse(config.payUrl)?.origin;
}

/**
 * The same request through Anyfare, for an API this app can't pay: the pay URL, `/`, then the URL as
 * typed without its `https://`. The bare link for a request that is only its URL; otherwise the
 * whole request with only the URL changed, to paste back. None for a URL on the pay host already,
 * nor for a plain `http` one.
 */
export function anyfareHint(config: Config, request: HttpRequest): string[] {
  if (!/^https:\/\//i.test(request.url) || isPayHost(request.url, config)) return [];
  const link = `${config.payUrl}/${request.url.replace(/^https:\/\//i, '')}`;
  return ['  Through Anyfare it takes NEAR:', `  ${request.words.length === 1 ? link : requestLine(request, link)}`];
}

/** "api.example.com/v1/quote": the host and the path without the query, the path cut to 40 characters. */
function callingTarget(url: string): string {
  const parsed = URL.parse(url);
  if (parsed === null) return 'the API';
  const path = parsed.pathname;
  return `${parsed.host}${path.length > CALLING_PATH_WIDTH ? `${path.slice(0, CALLING_PATH_WIDTH)}…` : path}`;
}

/** The unpaid request, as parsed. A failure before any answer: nothing paid. */
async function sendUnpaid(ctx: Context, call: HttpRequest, limitMs: number): Promise<Answer> {
  try {
    return await send(ctx, call, [], limitMs);
  } catch (error) {
    if (error instanceof Stop) throw new Stop(nothingPaid(error.message));
    throw error;
  }
}

/** The request as parsed, with `extra` headers after its own. */
function send(ctx: Context, call: HttpRequest, extra: readonly (readonly [string, string])[], timeoutMs: number): Promise<Answer> {
  return request(ctx.io.fetch, {
    method: call.method,
    url: call.url,
    headers: [...call.headers, ...extra],
    ...(call.body !== undefined && { body: call.body }),
    timeoutMs,
  });
}

/**
 * The paid request, once: never retried and never redirected, so a payment is never sent twice. A
 * request that never left is not charged. After it left, a failure is "not known", and `check` says
 * where to look.
 */
async function sendOnce(ctx: Context, call: HttpRequest, signature: string, check: string, limitMs: number): Promise<Answer> {
  try {
    return await send(ctx, call, [['PAYMENT-SIGNATURE', signature]], limitMs);
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    const failure = failureOf(error);
    // No answer came and no connection was made, so the request never left: nothing could be paid
    if (failure?.stage === 'not_sent') throw new Stop(`${error.message}. The request was never sent.`, { notCharged: true });
    // A 2xx is settled before its answer goes out, even when its body breaks on the way
    if (failure?.status !== undefined && failure.status >= 200 && failure.status < 300) {
      throw new Stop(`${error.message}. The call was most likely paid, and its answer is lost: ${check}.`);
    }
    throw new Stop(`${error.message}. Whether the call was paid is not known: ${check}.`);
  }
}

/** A setting's line as a failure before anything is signed. */
function walletStop(error: unknown): unknown {
  return error instanceof Stop ? new Stop(nothingPaid(error.message)) : error;
}

interface Payer {
  /** Absent for a dry run without `NEAR_ACCOUNT_ID`. */
  readonly accountId: string | undefined;
  /** Absent for a dry run: the key is never read. */
  readonly wallet: NearWallet | undefined;
  readonly balance: Promise<NearBalance> | undefined;
}

/**
 * The payer, and the read of its balance, started now. A dry run needs no account and never reads
 * the key; a payment needs both, checked here.
 */
function readPayer(ctx: Context, dryRun: boolean, balanceMs: number): Payer {
  const read = (accountId: string, rpc: RpcAddress): Promise<NearBalance> =>
    readNearBalance(ctx.io.fetch, accountId, rpc, { limitMs: balanceMs, withNear: true });
  try {
    if (dryRun) {
      if ((ctx.env[NEAR_ACCOUNT_ID]?.trim() ?? '') === '') return { accountId: undefined, wallet: undefined, balance: undefined };
      const { accountId, rpc } = readNearAccount(ctx.env);
      return { accountId, wallet: undefined, balance: read(accountId, rpc) };
    }
    const wallet = readNearWallet(ctx.env);
    return { accountId: wallet.accountId, wallet, balance: read(wallet.accountId, wallet.rpc) };
  } catch (error) {
    throw walletStop(error);
  }
}

/** The plan's rows before the balance: what the API asks, where it goes, the gas, how long, the cap. */
function planRows(ctx: Context, config: Config, option: PaymentRequirements, micro: bigint, what: string): string[] {
  const { label, value, money, ok, error } = ctx.style.styles;
  const field = (name: string, text: string): string => `${label(name.padEnd(PLAN_LABEL_WIDTH))}${text}`;
  return [
    ctx.style.step(field('The API asks', money(what))),
    `  ${field('Pay to', value(option.payTo))}`,
    `  ${field('Gas', value("none: the API's facilitator pays it"))}`,
    `  ${field('Valid for', value(validFor(option.maxTimeoutSeconds)))}`,
    `  ${field('Your cap', `${value(config.maxPaymentText)} ${micro <= config.maxPayment ? ok('✔') : error('✘')}`)}`,
  ];
}

function balanceRow(ctx: Context, balance: NearBalance | undefined, micro: bigint): string {
  const { label, value, ok, error, warn } = ctx.style.styles;
  const name = label('Your balance'.padEnd(PLAN_LABEL_WIDTH));
  if (balance === undefined) return `  ${name}${warn(`not read: ${NEAR_ACCOUNT_ID} is not set`)}`;
  if (balance.kind === 'failed') return `  ${name}${warn(`not read: ${balance.reason}`)}`;
  return `  ${name}${value(usdcText(balance.usdc))} ${balance.usdc >= micro ? ok('✔') : error('✘')}`;
}

/** The balance after the payment, against the one before it. */
function balanceAfterLine(ctx: Context, before: NearBalance | undefined, after: NearBalance): string {
  const { label, value, warn } = ctx.style.styles;
  const name = label('Balance'.padEnd(BALANCE_LABEL_WIDTH));
  if (after.kind === 'failed') return `${name}${warn(`not read: ${after.reason}`)}`;
  const near = after.near === undefined ? '' : ` · ${nearText(after.near)}`;
  if (before?.kind === 'read' && after.usdc < before.usdc) {
    return `${name}${value(`${usdcText(after.usdc)} (−${fromAtomic(before.usdc - after.usdc, 6)})${near}`)}`;
  }
  if (before?.kind === 'read' && after.usdc === before.usdc) {
    return `${name}${value(`${usdcText(after.usdc)}${near}`)} (the payment may not show yet)`;
  }
  return `${name}${value(`${usdcText(after.usdc)}${near}`)}`;
}

/**
 * The proof's rows, and a warning for anything in it that is not what was paid. `settled` is false
 * when there is no proof that the payment settled.
 */
function proofOf(ctx: Context, proof: Proof, accountId: string, check: string): { rows: [string, string][]; settled: boolean } {
  if (proof.kind === 'missing') {
    ctx.warn(`No PAYMENT-RESPONSE came with the answer: ${check}.`);
    return { rows: [], settled: false };
  }
  if (proof.kind === 'unreadable') {
    ctx.warn(`The PAYMENT-RESPONSE that came with the answer is unreadable: ${check}.`);
    return { rows: [], settled: false };
  }
  if (proof.kind === 'failed') {
    ctx.warn(`The PAYMENT-RESPONSE says the payment did not settle (${proof.reason}): ${check}.`);
    return { rows: [], settled: false };
  }
  const linked = NEAR_EXPLORER.hash.test(proof.transaction);
  const pending = proof.kind === 'pending' ? ' (not final yet)' : '';
  const rows: [string, string][] = [
    ['Transaction', `${linked ? proof.transaction : clip(proof.transaction)}${pending}`],
    ...(linked ? [['Explorer', ctx.style.styles.link(NEAR_EXPLORER.transaction(proof.transaction))] as [string, string]] : []),
    ['Network', clip(proof.network ?? NEAR_NETWORK)],
    ['Payer', clip(proof.payer ?? accountId)],
  ];
  if (!linked) ctx.warn('The transaction is not a NEAR transaction hash, so there is no link to it.');
  if (proof.network !== undefined && proof.network !== NEAR_NETWORK) {
    ctx.warn(`The PAYMENT-RESPONSE names another network, ${clip(proof.network)}, not NEAR.`);
  }
  if (proof.payer !== undefined && proof.payer !== accountId) {
    ctx.warn(`The PAYMENT-RESPONSE names another payer, ${clip(proof.payer)}, not ${accountId}.`);
  }
  return { rows, settled: true };
}

/** The lookup of a paid call on Anyfare, under way, and the site its receipt page is on. */
interface CallSearch {
  readonly site: string;
  readonly found: Promise<CallLookup>;
}

/**
 * The lookup of the call on Anyfare, started now: only for a paid request through Anyfare's pay host,
 * whose proof names a NEAR transaction, when the settings give Anyfare's API and site. Never throws.
 */
function searchCall(ctx: Context, config: Config, call: HttpRequest, proof: Proof, accountId: string, limits: CallLimits | undefined): CallSearch | undefined {
  try {
    const { apiUrl, siteUrl } = config;
    if (apiUrl === undefined || siteUrl === undefined || !isPayHost(call.url, config)) return undefined;
    if ((proof.kind !== 'settled' && proof.kind !== 'pending') || !NEAR_EXPLORER.hash.test(proof.transaction)) return undefined;
    const host = routedHost(call.url);
    if (host === undefined) return undefined;
    const query = { apiUrl, host, accountId, transaction: proof.transaction, ...(limits !== undefined && { limits }) };
    return { site: siteUrl, found: findAnyfareCall(ctx.io.fetch, query) };
  } catch {
    return undefined;
  }
}

/**
 * The call's ID and receipt page as the last rows of the proof, once the lookup ends; or one warning
 * when it was not found. Never throws.
 */
async function showCall(ctx: Context, search: CallSearch | undefined): Promise<void> {
  if (search === undefined) return;
  try {
    const found = await search.found;
    if (found.kind === 'found') {
      const { link } = ctx.style.styles;
      ctx.print(proofRows(ctx.style, [['Anyfare call', found.id], ['Receipt', link(`${search.site}/calls/${found.id}`)]]));
    } else {
      ctx.warn(`Anyfare's receipt for this call was not found: ${found.reason}. The NEAR transaction above is the proof of the payment.`);
    }
  } catch {
    // Only the call's rows are lost: the payment is reported as it is
  }
}

/**
 * The answer's lines for the result block, and a warning when its body was too large to read whole.
 * Never throws: an answer that can't be shown is one warning, and the run goes on, since it may have
 * been paid.
 */
function showAnswer(ctx: Context, answer: Answer, full: boolean): string[] {
  if (answer.truncated) ctx.warn(`The answer is larger than ${MAX_BODY_BYTES / 1_000_000} MB; the rest was not read.`);
  try {
    return answerLines(ctx.style, answer, { full });
  } catch (error) {
    ctx.warn(`The answer could not be shown: ${clip(error instanceof Error ? error.message : String(error)).replace(/[.]+$/, '')}.`);
    return [];
  }
}

/** The unpaid answer that is not a 402: free when it is below 400, a failure otherwise. */
function notPaymentRequired(ctx: Context, config: Config, call: HttpRequest, answer: Answer, full: boolean): number {
  if (answer.status >= 200 && answer.status < 400) {
    ctx.print(showAnswer(ctx, answer, full));
    ctx.print(ctx.style.done('Free: nothing paid.'));
    return 0;
  }
  if (isPayHost(call.url, config) && isProxyEnvelope(answer.body)) {
    throw new Stop(nothingPaid(stopFor(httpErrorOf(answer), {}).message));
  }
  ctx.print(showAnswer(ctx, answer, full));
  throw new Stop(`The API answered ${answer.status}. ${NOTHING_PAID}`);
}

/**
 * One request: sent unpaid, then, when it is a 402 that takes USDC on NEAR, paid once and sent again
 * with the payment. Returns the exit code: 0 answered, paid or free. Every failure is thrown: a
 * `Stop`, a `NotSupported` or a `UsageError`.
 */
export async function payRequest(ctx: Context, config: Config, call: HttpRequest, options: AppOptions, limits: PayLimits = {}): Promise<number> {
  const { style } = ctx;
  const payHost = isPayHost(call.url, config);
  // A run that will ask reads the terminal from now on: a line typed while it works is read into the
  // prompter's queue, and dropped before the question, so it answers nothing
  if (!options.yes && !options.dryRun && ctx.io.isTerminal) ctx.prompter();

  // 1. The unpaid request
  const unpaid = await sendUnpaid(ctx, call, limits.unpaidMs ?? UNPAID_TIMEOUT_MS);
  if (unpaid.status !== 402) return notPaymentRequired(ctx, config, call, unpaid, options.full);

  // 2 to 4. The 402, and the one option this app pays
  const hint = anyfareHint(config, call);
  const { required, option, micro } = chooseOption(readX402(unpaid, hint), hint);
  const amount = fromAtomic(micro, 6);
  const what = `${amount} USDC on NEAR`;

  // 5. The wallet, and its balance, read while the plan is shown
  const payer = readPayer(ctx, options.dryRun, limits.balanceMs ?? BALANCE_TIMEOUT_MS);

  // 6. The plan
  ctx.print(planRows(ctx, config, option, micro, what));
  const before = payer.balance === undefined ? undefined : await payer.balance;
  ctx.print(balanceRow(ctx, before, micro));

  // 7. The checks
  if (micro > config.maxPayment) {
    const raise = config.capFrom === '--max' ? 'Use a higher --max to pay it.' : 'Raise MAX_PAYMENT_USD to pay it.';
    throw new Stop(`Costs ${usd(micro)}, above your cap of ${config.maxPaymentText}. ${NOTHING_PAID} ${raise}`);
  }
  if (before?.kind === 'read' && before.usdc < micro) {
    throw new Stop(`Costs ${amount} USDC. The wallet holds ${fromAtomic(before.usdc, 6)}. ${NOTHING_PAID}`);
  }
  if (before?.kind === 'failed') {
    ctx.warn(`Could not read the wallet's balance: ${before.reason}. The facilitator refuses a payment the wallet can't cover.`);
  }
  if (options.dryRun) {
    ctx.print(style.done(`Would pay ${what} to ${option.payTo}. Not paid.`));
    return 0;
  }
  const wallet = payer.wallet;
  // A payment always has its wallet: only a dry run goes without one, and it has returned
  if (wallet === undefined) throw new Stop(nothingPaid(`${NEAR_ACCOUNT_ID} and NEAR_PRIVATE_KEY are needed to pay`));
  const noTerminal = `This request costs ${amount} USDC. Add --yes to pay without a terminal, or --dry-run to see the cost. ${NOTHING_PAID}`;
  ctx.requireAnswerable(options.yes, noTerminal);
  if (!options.yes) {
    ctx.print('');
    // Lets the input typed until now be read, a full turn of the event loop, then drops it
    await nextTurn();
    await nextTurn();
    ctx.prompter().dropTypedAhead();
  }
  await ctx.approve({ yes: options.yes, question: `Pay ${what}?`, noTerminal, declined: new Stop(NOTHING_PAID) });

  // 8. One signature, checked before it is sent
  ctx.print(style.step(`Signing a transfer of ${amount} USDC to ${option.payTo}`));
  const { payload, nearHeight } = await signOnce(ctx.io.fetch, required, option, wallet, config.maxPayment, limits.signingMs ?? SIGNING_TIMEOUT_MS);
  checkSigned(option, wallet.accountId, payload, { nearHeight });

  // 9. One paid request, never retried
  const check = `${NEAR_EXPLORER.address(wallet.accountId)} shows your payments`;
  let signature: string;
  try {
    signature = encodePaymentSignatureHeader(payload);
  } catch {
    throw new Stop('The signed payment could not be written into its header. Nothing was sent.');
  }
  ctx.print(style.step(`Calling ${call.method} ${callingTarget(call.url)}`));
  const answer = await sendOnce(ctx, call, signature, check, limits.paidMs ?? PAID_TIMEOUT_MS);
  if (answer.status < 200 || answer.status >= 300) {
    const shown = answer.bytes.length > 0 && !(payHost && isProxyEnvelope(answer.body));
    // Showing the body never throws, so it never takes the place of the line about the payment
    if (shown) ctx.print(showAnswer(ctx, answer, options.full));
    if (payHost) throw stopFor(httpErrorOf(answer), { paid: { apiName: 'The API', check }, bodyShown: shown }, x402Lines(check));
    // Only Anyfare's rules are known: another API's failure is never said to be free, nor its 402
    if (answer.status === 402) {
      throw new Stop(`The API answered 402 again: it did not accept the payment. Whether it was taken is not known: ${check}.`);
    }
    throw new Stop(`The API answered ${answer.status}. Whether the payment was taken is not known: ${check}.`);
  }

  // 10. The result, the proof, and the balance after. The proof and the line about the payment come
  // whatever happens to the body: the answer is paid. A call through Anyfare is looked up meanwhile,
  // and its rows end the proof.
  const read = readProof(answer.headers.get('payment-response'));
  const proof = proofOf(ctx, read, wallet.accountId, check);
  const search = searchCall(ctx, config, call, read, wallet.accountId, limits.anyfareCall);
  ctx.print([...showAnswer(ctx, answer, options.full), ...proofLines(style, proof.rows)]);
  await showCall(ctx, search);
  ctx.print(style.done(proof.settled ? `You paid ${what}.` : `The API answered. Whether you paid ${what} is not known.`));
  const after = await readNearBalance(ctx.io.fetch, wallet.accountId, wallet.rpc, { limitMs: limits.balanceMs ?? BALANCE_TIMEOUT_MS, withNear: true });
  ctx.print(['', balanceAfterLine(ctx, before, after)]);
  return 0;
}
