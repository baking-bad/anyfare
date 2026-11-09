// A call paid from Credits: the quote, the cap, the confirmation, one request, and the receipt.

import { paymentKeyOf } from './account.ts';
import type { ToolArgs } from './cli.ts';
import { loadConfig } from './config.ts';
import type { Context } from './context.ts';
import { httpErrorOf, stopFor } from './errors.ts';
import { apiPrice, explainLines, planFailure, readPlan } from './explain.ts';
import type { Plan } from './explain.ts';
import { failureOf, request } from './http.ts';
import type { Answer } from './http.ts';
import { TOOLS } from './tools/index.ts';
import { Stop, toAtomic, usd } from './util.ts';

/** The paid request's time limit. */
export const PAID_TIMEOUT_MS = 60_000;

export const RECEIPT_HEADER = 'anyfare-receipt';

export type ReceiptRead =
  | { readonly kind: 'ok'; readonly id: string; readonly amount: bigint }
  | { readonly kind: 'missing' }
  | { readonly kind: 'unreadable' };

// A dictionary member whose value is a structured-field string without escapes
const MEMBER = /^([a-z*][a-z0-9_.*-]*)="([\x20\x21\x23-\x5b\x5d-\x7e]*)"$/;
const RECEIPT_KEYS = ['id', 'amount', 'currency'] as const;

/** `id="…", amount="0.01", currency="USD"`, read strictly: these three keys once each, as quoted strings. */
export function parseReceipt(value: string | null): ReceiptRead {
  if (value === null) return { kind: 'missing' };
  const unreadable = { kind: 'unreadable' } as const;
  const found = new Map<string, string>();
  for (const part of value.split(',')) {
    const match = MEMBER.exec(part.replace(/^[ \t]+|[ \t]+$/g, ''));
    if (match === null) return unreadable;
    const [, key = '', text = ''] = match;
    if (found.has(key) || !(RECEIPT_KEYS as readonly string[]).includes(key)) return unreadable;
    found.set(key, text);
  }
  const id = found.get('id');
  const amount = found.get('amount');
  if (found.size !== RECEIPT_KEYS.length || id === undefined || id === '' || amount === undefined) return unreadable;
  if (found.get('currency') !== 'USD') return unreadable;
  try {
    return { kind: 'ok', id, amount: toAtomic(amount, 6) };
  } catch {
    return unreadable;
  }
}

/** The API's name inside a sentence: "the evidence API", "CoinMarketCap". */
function nameInSentence(plan: Plan): string {
  return TOOLS[plan.prepared.tool].name.replace(/^The /, 'the ');
}

const notUsd = (what: string, currency: string | undefined): Stop =>
  new Stop(`${what} is in ${currency === undefined ? 'no currency' : `"${currency}"`}, not US dollars.`, { notCharged: true });

/**
 * What the call costs in Credits, in micro-USD: the one amount the app shows, confirms, caps and finds
 * on the receipt. For a GET, the higher of the `/_/check` quote and the routing link's 402, which is
 * what the proxy holds; for a POST, the 402's. Both must be in US dollars.
 */
function creditsPrice(ctx: Context, plan: Plan): bigint {
  const credits =
    plan.anyfare.kind === 'ok' ? plan.anyfare.value.offers.find((offer) => offer.protocol === 'credits') : undefined;
  let checked: bigint | undefined;
  if (plan.prepared.request.method === 'GET' && plan.check.kind === 'ok' && plan.check.value.payable) {
    const quote = plan.check.value.quote;
    if (quote.currency !== 'USD') throw notUsd("Anyfare's quote from GET /_/check", quote.currency);
    try {
      checked = toAtomic(quote.amount, 6);
    } catch {
      throw new Stop(`Anyfare gave a price this app can't read: "${quote.amount}".`, { notCharged: true });
    }
  }
  if (credits === undefined) {
    if (checked === undefined) throw new Stop('Anyfare gave no price for this call.', { notCharged: true });
    throw new Stop('Anyfare offers no Credits for this call now.', { notCharged: true });
  }
  if (credits.asset !== 'USD') throw notUsd("The Credits price of Anyfare's 402", credits.asset);
  if (checked === undefined || checked === credits.amount) return credits.amount;
  const price = checked > credits.amount ? checked : credits.amount;
  ctx.warn(
    `Anyfare quotes ${usd(checked)} at GET /_/check and ${usd(credits.amount)} in its 402 for this call. The app takes the higher, ${usd(price)}.`,
  );
  return price;
}

/** The plan in short: what the API asks, Anyfare's quote and fee, and what you pay. */
function shortPlan(ctx: Context, plan: Plan, quote: bigint): string[] {
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
    field('You pay', ctx.style.styles.money(`${usd(quote)} of Credits`)),
    ...(plan.prepared.slow ? ['  This one takes a while.'] : []),
  ];
}

function storyLine(plan: Plan): string {
  const price = apiPrice(plan);
  const how =
    price?.asset !== undefined && price.network !== undefined ? ` in ${price.asset} on ${price.network}` : '';
  return `You paid with Credits. Anyfare paid ${nameInSentence(plan)}${how} from its own wallet.`;
}

/** `call --pay credits`. Returns the exit code. */
export async function callWithCredits(
  ctx: Context,
  command: { readonly args: ToolArgs; readonly explain: boolean; readonly yes: boolean },
): Promise<number> {
  const { io, style } = ctx;
  const config = loadConfig(ctx.session.env);
  const key = paymentKeyOf(ctx.session.env);
  ctx.requireAnswerable(command.yes, 'call asks before it pays. Add --yes to pay without a terminal');

  const prepared = await TOOLS[command.args.tool].prepare(command.args, { fetch: io.fetch });
  const plan = await readPlan({ fetch: io.fetch, config, prepared });
  ctx.print(style.styles.title(`${TOOLS[prepared.tool].name}: ${prepared.summary}`));
  const failure = planFailure(plan);
  // The one amount, before the explain block, so that the block shows what the call pays
  let price: bigint | undefined;
  let refusal: unknown;
  if (failure === undefined) {
    try {
      price = creditsPrice(ctx, plan);
    } catch (error) {
      refusal = error;
    }
  }
  if (command.explain) ctx.print(explainLines(plan, 'credits', style, price));
  if (failure !== undefined) throw new Stop(/[.!?]$/.test(failure) ? failure : `${failure}.`, { notCharged: true });
  if (price === undefined) throw refusal;
  if (price > config.maxPayment) {
    throw new Stop(`Anyfare quotes ${usd(price)}, above your cap MAX_PAYMENT_USD of ${usd(config.maxPayment)}.`, {
      notCharged: true,
    });
  }
  if (!command.explain) ctx.print(shortPlan(ctx, plan, price));
  await ctx.approve({
    yes: command.yes,
    question: `Pay ${usd(price)} of Credits?`,
    noTerminal: 'call asks before it pays. Add --yes to pay without a terminal',
    declined: new Stop('Nothing was sent.', { notCharged: true }),
  });

  ctx.print(style.step(`Calling ${TOOLS[prepared.tool].name} through Anyfare`));
  const call = prepared.request;
  let answer: Answer;
  try {
    // One request, never retried and never redirected, so a call is never paid twice
    answer = await request(io.fetch, {
      method: call.method,
      url: plan.link,
      headers: { ...call.headers, authorization: `Bearer ${key}` },
      ...(call.body !== undefined && { body: call.body }),
      timeoutMs: PAID_TIMEOUT_MS,
      redirect: 'manual',
    });
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    const failure = failureOf(error);
    // No answer came and no connection was made, so the request never left: nothing could be held
    if (failure?.stage === 'not_sent') {
      throw new Stop(`${error.message}. The request was never sent.`, { notCharged: true });
    }
    // A 2xx is captured even when its body breaks on the way
    if (failure?.status !== undefined && failure.status >= 200 && failure.status < 300) {
      throw new Stop(
        `${error.message}. The call was most likely paid, and its answer is lost: npm run demo -- balance shows the Credits.`,
      );
    }
    throw new Stop(`${error.message}. Whether the call was paid is not known: npm run demo -- balance shows the Credits.`);
  }

  if (answer.status < 200 || answer.status >= 300) {
    throw stopFor(httpErrorOf(answer), { side: 'proxy', paid: { way: 'credits', apiName: TOOLS[prepared.tool].name } });
  }
  ctx.print(prepared.format(answer.body).map((line) => `  ${line}`));
  const receipt = parseReceipt(answer.headers.get(RECEIPT_HEADER));
  if (receipt.kind === 'ok') {
    ctx.print(`  Receipt ${receipt.id}: ${usd(receipt.amount)} of Credits`);
    if (receipt.amount !== price) ctx.warn(`The receipt's amount, ${usd(receipt.amount)}, is not the price, ${usd(price)}.`);
  } else if (receipt.kind === 'missing') {
    ctx.warn('No receipt came with the answer. npm run demo -- balance shows what was paid.');
  } else {
    ctx.warn('The receipt that came with the answer is unreadable.');
  }
  ctx.print(style.done(storyLine(plan)));
  return 0;
}
