// A call paid from Credits: the quote, the cap, the confirmation, one request, and the receipt.

import { paymentKeyOf } from './account.ts';
import { loadConfig } from './config.ts';
import type { Context } from './context.ts';
import type { Plan } from './explain.ts';
import { NO_TERMINAL, callingLine, readPaidPlan, sendOnce, shortPlan, stopForAnswer, storyLine } from './paid.ts';
import type { CallCommand } from './paid.ts';
import { Stop, toAtomic, usd } from './util.ts';

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

const notUsd = (what: string, currency: string | undefined): Stop =>
  new Stop(`${what} is in ${currency === undefined ? 'no currency' : `"${currency}"`}, not US dollars.`, { notCharged: true });

/**
 * What the call costs in Credits, in micro-USD: the one amount the app shows, confirms, caps and finds
 * on the receipt. For a GET, the higher of the `/_/check` quote and the routing link's 402, which is
 * what the proxy holds; for a POST, the 402's. Both must be in US dollars.
 */
export function creditsPrice(ctx: Context, plan: Plan): bigint {
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

const BALANCE_SHOWS = 'npm run demo -- balance shows the Credits';

/** `call --pay credits`. Returns the exit code. */
export async function callWithCredits(ctx: Context, command: CallCommand): Promise<number> {
  const config = loadConfig(ctx.session.env);
  const key = paymentKeyOf(ctx.session.env);
  const { plan, chosen } = await readPaidPlan(ctx, config, command, 'credits', (read) => {
    const micro = creditsPrice(ctx, read);
    return { micro, asks: `Anyfare quotes ${usd(micro)}` };
  });
  const price = chosen.micro;
  if (!command.explain) ctx.print(shortPlan(ctx, plan, price, `${usd(price)} of Credits`));
  await ctx.approve({
    yes: command.yes,
    question: `Pay ${usd(price)} of Credits?`,
    noTerminal: NO_TERMINAL,
    declined: new Stop('Nothing was sent.', { notCharged: true }),
  });

  ctx.print(callingLine(ctx, plan));
  const answer = await sendOnce(ctx, plan, { authorization: `Bearer ${key}` }, BALANCE_SHOWS);
  if (answer.status < 200 || answer.status >= 300) throw stopForAnswer(answer, plan, 'credits');
  ctx.print(plan.prepared.format(answer.body).map((line) => `  ${line}`));
  const receipt = parseReceipt(answer.headers.get(RECEIPT_HEADER));
  if (receipt.kind === 'ok') {
    ctx.print(`  Receipt ${receipt.id}: ${usd(receipt.amount)} of Credits`);
    if (receipt.amount !== price) ctx.warn(`The receipt's amount, ${usd(receipt.amount)}, is not the price, ${usd(price)}.`);
  } else if (receipt.kind === 'missing') {
    ctx.warn('No receipt came with the answer. npm run demo -- balance shows what was paid.');
  } else {
    ctx.warn('The receipt that came with the answer is unreadable.');
  }
  ctx.print(ctx.style.done(storyLine(plan, 'You paid with Credits.')));
  return 0;
}
