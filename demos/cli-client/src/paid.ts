// What every paid call does the same way, whatever pays it: the plan and the one amount it pays,
// the cap, the plan in short, one request that is never retried, and the lines after it.

import type { PayWay, ToolArgs } from './cli.ts';
import type { Config } from './config.ts';
import type { Context } from './context.ts';
import { httpErrorOf, stopFor } from './errors.ts';
import type { ErrorTable } from './errors.ts';
import { apiPrice, explainLines, planFailure, readPlan } from './explain.ts';
import type { Plan } from './explain.ts';
import { failureOf, request } from './http.ts';
import type { Answer } from './http.ts';
import { TOOLS } from './tools/index.ts';
import { Stop, usd } from './util.ts';

/** The paid request's time limit. */
export const PAID_TIMEOUT_MS = 60_000;

/** What `call` asks before it pays, when it has no terminal to ask on. */
export const NO_TERMINAL = 'call asks before it pays. Add --yes to pay without a terminal';

export interface CallCommand {
  readonly args: ToolArgs;
  readonly explain: boolean;
  readonly yes: boolean;
}

/** What a payer chose to pay, as far as the shared steps need it. */
export interface Chosen {
  /** The one amount the call pays, in micro-USD: shown, capped and confirmed. */
  readonly micro: bigint;
  /** "Anyfare quotes $0.011": the start of the line that refuses it at the cap. */
  readonly asks: string;
}

/** The API's name inside a sentence: "the evidence API", "CoinMarketCap". */
export function nameInSentence(plan: Plan): string {
  return TOOLS[plan.prepared.tool].name.replace(/^The /, 'the ');
}

/**
 * The free reads, the title, and what the payer chooses to pay, checked against the cap. The choice
 * is made before the explain block, so the block shows what the call pays. A plan that is not whole,
 * a payer that can pay nothing, and an amount over the cap are each a `Stop` that is not charged.
 */
export async function readPaidPlan<T extends Chosen>(
  ctx: Context,
  config: Config,
  command: CallCommand,
  way: PayWay,
  choose: (plan: Plan) => T,
): Promise<{ readonly plan: Plan; readonly chosen: T }> {
  const { io, style } = ctx;
  ctx.requireAnswerable(command.yes, NO_TERMINAL);
  const prepared = await TOOLS[command.args.tool].prepare(command.args, { fetch: io.fetch });
  const plan = await readPlan({ fetch: io.fetch, config, prepared });
  ctx.print(style.styles.title(`${TOOLS[prepared.tool].name}: ${prepared.summary}`));
  const failure = planFailure(plan);
  let chosen: T | undefined;
  let refusal: unknown;
  if (failure === undefined) {
    try {
      chosen = choose(plan);
    } catch (error) {
      refusal = error;
    }
  }
  if (command.explain) ctx.print(explainLines(plan, way, style, chosen?.micro));
  if (failure !== undefined) throw new Stop(/[.!?]$/.test(failure) ? failure : `${failure}.`, { notCharged: true });
  if (chosen === undefined) throw refusal;
  if (chosen.micro > config.maxPayment) {
    throw new Stop(`${chosen.asks}, above your cap MAX_PAYMENT_USD of ${usd(config.maxPayment)}.`, { notCharged: true });
  }
  return { plan, chosen };
}

/**
 * The plan in short: what the API asks, Anyfare's quote and fee, what you pay, and the payer's own
 * lines, such as where the payment goes.
 */
export function shortPlan(
  ctx: Context,
  plan: Plan,
  quote: bigint,
  pays: string,
  more: readonly (readonly [string, string])[] = [],
): string[] {
  const field = (label: string, value: string): string => ctx.style.field(label, value, 15);
  const price = apiPrice(plan);
  const where = [price?.asset, price?.network].every((part) => part !== undefined)
    ? ` in ${price?.asset} on ${price?.network}`
    : '';
  const asks = price?.micro === undefined ? 'not known' : `${usd(price.micro)}${where}`;
  const fee = price?.micro === undefined || price.micro > quote ? 'not known' : usd(quote - price.micro);
  return [
    field('The API asks', asks),
    field("Anyfare's quote", `${usd(quote)}, with a fee of ${fee}`),
    field('You pay', ctx.style.styles.money(pays)),
    ...more.map(([label, value]) => field(label, value)),
    ...(plan.prepared.slow ? ['  This one takes a while.'] : []),
  ];
}

/**
 * The paid request, once: never retried and never redirected, so a call is never paid twice. A
 * request that never left is not charged. After it left, a failure is "not known", and `check` says
 * where to look, such as "npm run demo -- balance shows the Credits".
 */
export async function sendOnce(
  ctx: Context,
  plan: Plan,
  payment: Readonly<Record<string, string>>,
  check: string,
): Promise<Answer> {
  const call = plan.prepared.request;
  try {
    return await request(ctx.io.fetch, {
      method: call.method,
      url: plan.link,
      headers: { ...call.headers, ...payment },
      ...(call.body !== undefined && { body: call.body }),
      timeoutMs: PAID_TIMEOUT_MS,
      redirect: 'manual',
    });
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    const failure = failureOf(error);
    // No answer came and no connection was made, so the request never left: nothing could be paid
    if (failure?.stage === 'not_sent') {
      throw new Stop(`${error.message}. The request was never sent.`, { notCharged: true });
    }
    // A 2xx is captured, or settled, even when its body breaks on the way
    if (failure?.status !== undefined && failure.status >= 200 && failure.status < 300) {
      throw new Stop(`${error.message}. The call was most likely paid, and its answer is lost: ${check}.`);
    }
    throw new Stop(`${error.message}. Whether the call was paid is not known: ${check}.`);
  }
}

/** A `Stop` for an answer that is not `2xx`, with the payer's own lines in `extra`. */
export function stopForAnswer(answer: Answer, plan: Plan, way: PayWay, extra: ErrorTable = {}): Stop {
  return stopFor(httpErrorOf(answer), { side: 'proxy', paid: { way, apiName: TOOLS[plan.prepared.tool].name } }, extra);
}

/** "You paid with Credits. Anyfare paid CoinMarketCap in USDC on Base from its own wallet." */
export function storyLine(plan: Plan, youPaid: string): string {
  const price = apiPrice(plan);
  const how =
    price?.asset !== undefined && price.network !== undefined ? ` in ${price.asset} on ${price.network}` : '';
  return `${youPaid} Anyfare paid ${nameInSentence(plan)}${how} from its own wallet.`;
}

/**
 * The payer's own block of a plan that is shown with `--explain`: what you pay, and the rows the payer
 * adds, such as where the payment goes. The quote block above it has its own labels, so no label is
 * said twice; the labels of this block share one width.
 */
export function payerLines(ctx: Context, pays: string, rows: readonly (readonly [string, string])[]): string[] {
  const all: (readonly [string, string])[] = [['You pay', ctx.style.styles.money(pays)], ...rows];
  const width = Math.max(...all.map(([label]) => label.length));
  return ['', ...all.map(([label, value]) => ctx.style.field(label, value, width))];
}

/** The question before a payment, set apart from the plan above it by one blank line. */
export async function askToPay(
  ctx: Context,
  command: CallCommand,
  asking: { readonly question: string; readonly declined: Stop },
): Promise<void> {
  if (!command.yes) ctx.print('');
  await ctx.approve({ yes: command.yes, question: asking.question, noTerminal: NO_TERMINAL, declined: asking.declined });
}

/**
 * The result of a call: the answer's lines, the proof (the receipt, or the transaction and its link),
 * and the story line after one blank line. The result stands apart from the plan: see `Style.result`.
 */
export function printResult(
  ctx: Context,
  plan: Plan,
  answer: readonly string[],
  proof: readonly string[],
  story: string,
): void {
  ctx.print([...ctx.style.result(TOOLS[plan.prepared.tool].name, answer, proof), ctx.style.done(story)]);
}

/** The step line before the paid request. */
export function callingLine(ctx: Context, plan: Plan): string {
  return ctx.style.step(`Calling ${nameInSentence(plan)} through Anyfare`);
}
