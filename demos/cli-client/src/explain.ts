// The free reads behind `explain`, and the plain-English lines made from them.

import { checkQuote, readUnpaid, routingLink } from './anyfare.ts';
import type { Check, NotPayable, Unpaid } from './anyfare.ts';
import type { PayWay } from './cli.ts';
import type { Config } from './config.ts';
import type { Fetch } from './http.ts';
import { ANYFARE_ASSETS, amountText, anyfareAssetName, assetLabel, findAsset, networkName, sameAddress } from './networks.ts';
import { payWayOf } from './offers.ts';
import type { Offer } from './offers.ts';
import { createStyle } from './style.ts';
import type { Style } from './style.ts';
import { TOOLS } from './tools/index.ts';
import type { PreparedCall } from './tools/types.ts';
import { Stop, fromAtomic, toAtomic } from './util.ts';

export type Attempt<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'failed'; readonly reason: string };

export interface Plan {
  readonly prepared: PreparedCall;
  readonly config: Config;
  /** The routing link of the target. */
  readonly link: string;
  /** The target's own unpaid answer. */
  readonly api: Attempt<Unpaid>;
  /** `GET /_/check`. Skipped for a tool that is not a GET. */
  readonly check: Attempt<Check | NotPayable> | { readonly kind: 'skipped'; readonly note: string };
  /** The routing link's unpaid answer. */
  readonly anyfare: Attempt<Unpaid>;
}

async function attempt<T>(run: () => Promise<T>): Promise<Attempt<T>> {
  try {
    return { kind: 'ok', value: await run() };
  } catch (error) {
    if (error instanceof Stop) return { kind: 'failed', reason: error.message };
    throw error;
  }
}

/** Makes the three free reads, in order. A failure is kept in the plan, not thrown. */
export async function readPlan(input: {
  readonly fetch: Fetch;
  readonly config: Config;
  readonly prepared: PreparedCall;
}): Promise<Plan> {
  const { fetch: fetchFn, config, prepared } = input;
  const call = prepared.request;
  const link = routingLink(config.payUrl, call.url);
  const api = await attempt(() => readUnpaid(fetchFn, call.url, call));
  const check =
    call.method === 'GET'
      ? await attempt(() => checkQuote(fetchFn, config.payUrl, call.url))
      : ({
          kind: 'skipped',
          note: "GET /_/check probes with GET and no body, so it can't quote a POST call. The price comes from Anyfare's own 402 above.",
        } as const);
  const anyfare = await attempt(() => readUnpaid(fetchFn, link, call));
  return { prepared, config, link, api, check, anyfare };
}

/** The one failure line for a plan that is not whole, or `undefined` when everything was read. */
export function planFailure(plan: Plan): string | undefined {
  const where = plan.config.payUrl;
  if (plan.api.kind === 'failed') return `The API did not answer: ${plan.api.reason}`;
  if (plan.anyfare.kind === 'failed') return `Anyfare at ${where} did not answer.`;
  if (plan.check.kind === 'failed') return `Anyfare at ${where} did not answer its quote.`;
  if (plan.check.kind === 'ok' && !plan.check.value.payable) {
    return `Anyfare cannot pay this call: ${plan.check.value.message}`;
  }
  if (plan.anyfare.value.status !== 402) {
    return `Anyfare at ${where} did not ask for a payment: it ${plan.anyfare.value.note ?? 'answered'}.`;
  }
  return undefined;
}

/** What each `--pay` value pays with, inside a sentence. */
export const WAY_LABELS: Readonly<Record<PayWay, string>> = {
  credits: 'Credits',
  near: 'USDC on NEAR',
  base: 'USDC on Base',
  tempo: 'USDC.e on Tempo',
};

function what(offer: Offer): string {
  if (offer.protocol === 'credits') return `$${fromAtomic(offer.amount, 6)} of Credits`;
  const text = amountText(offer.network, offer.asset, offer.amount, offer.assetName);
  return offer.protocol === 'mpp' ? `${text} (MPP ${offer.scheme})` : text;
}

function how(offer: Offer): string {
  if (offer.protocol !== 'x402') return '';
  return offer.transferMethod === undefined ? offer.scheme : `${offer.scheme} (${offer.transferMethod})`;
}

/** Can Anyfare pay this option? Only `exact` options in the assets it holds, or its Tempo charge. */
function anyfarePayable(offer: Offer): boolean {
  if (offer.protocol === 'x402') {
    return offer.scheme === 'exact' && anyfareAssetName(offer.network, offer.asset) !== undefined;
  }
  return offer.protocol === 'mpp' && offer.scheme === 'charge' && anyfareAssetName(offer.network, offer.asset) !== undefined;
}

interface Mark {
  readonly offer: Offer | undefined;
  /** True when the mark is there only because it is the one option Anyfare can pay. */
  readonly onlyOption: boolean;
}

/** The option of the API's own 402 that Anyfare pays. */
function markOf(offers: readonly Offer[], check: Plan['check']): Mark {
  if (check.kind === 'ok' && check.value.payable) {
    const { network, asset } = check.value.price;
    const onNetwork = offers.filter(
      (offer) => offer.network === network && (offer.protocol === 'mpp' || offer.scheme === 'exact'),
    );
    const target = asset === undefined ? undefined : ANYFARE_ASSETS[asset];
    const named = onNetwork.filter(
      (offer) =>
        target !== undefined &&
        offer.asset !== undefined &&
        network !== undefined &&
        sameAddress(network, target.address, offer.asset),
    );
    return { offer: (named.length > 0 ? named : onNetwork)[0], onlyOption: false };
  }
  const exact = offers.filter((offer) => offer.protocol === 'x402' && anyfarePayable(offer));
  return exact.length === 1 ? { offer: exact[0], onlyOption: true } : { offer: undefined, onlyOption: false };
}

function table(rows: readonly (readonly [string, string, string])[]): string[] {
  const first = Math.max(0, ...rows.map((row) => row[0].length));
  const second = Math.max(0, ...rows.map((row) => row[1].length));
  return rows.map(([a, b, c]) => `    ${a.padEnd(first)}  ${b.padEnd(second)}  ${c}`.trimEnd());
}

function protocols(unpaid: Unpaid): string {
  const parts: string[] = [];
  if (unpaid.x402Version !== undefined) parts.push(`x402 version ${unpaid.x402Version}`);
  if (unpaid.offers.some((offer) => offer.protocol === 'mpp')) parts.push('MPP');
  if (unpaid.offers.some((offer) => offer.protocol === 'credits')) parts.push('Credits');
  return parts.length === 0 ? '' : `, ${parts.join(' and ')}`;
}

function count(n: number): string {
  return `${n} option${n === 1 ? '' : 's'}`;
}

function apiBlock(plan: Plan, style: Style): string[] {
  const lines = [style.step(`What ${toolName(plan).replace(/^The /, 'the ')} asks, without Anyfare`)];
  if (plan.api.kind === 'failed') return [...lines, `  The API did not answer: ${plan.api.reason}`];
  const unpaid = plan.api.value;
  if (unpaid.status !== 402) {
    return [...lines, `  The API ${unpaid.note ?? `answered ${unpaid.status}`} without asking for a payment.`];
  }
  const mark = markOf(unpaid.offers, plan.check);
  lines.push(`  402 Payment Required${protocols(unpaid)}. ${count(unpaid.offers.length)}:`);
  lines.push(
    ...table(
      unpaid.offers.map((offer): [string, string, string] => {
        let note = '';
        if (offer === mark.offer) {
          note = style.styles.ok(mark.onlyOption ? '← Anyfare pays this one (the only option it can pay)' : '← Anyfare pays this one');
        } else if (offer.protocol === 'x402' && offer.scheme !== 'exact') {
          note = style.styles.label('offered, skipped: Anyfare pays exact options only');
        }
        return [what(offer), how(offer), note];
      }),
    ),
  );
  if (mark.offer !== undefined) {
    lines.push('  Anyfare pays the marked option for you.');
  } else if (plan.check.kind === 'ok' && plan.check.value.payable) {
    lines.push("  None of these options is the one Anyfare pays for this call, so it cannot pay the API.");
  } else if (unpaid.offers.some(anyfarePayable)) {
    lines.push('  Anyfare can pay more than one of these. Its own quote decides which.');
  } else {
    lines.push('  Anyfare pays none of these options.');
  }
  return lines;
}

function toolName(plan: Plan): string {
  return TOOLS[plan.prepared.tool].name;
}

function anyfareBlock(plan: Plan, style: Style, payWay: PayWay | undefined): string[] {
  const lines = [style.step('What Anyfare asks for the same call')];
  if (plan.anyfare.kind === 'failed') return [...lines, `  Anyfare did not answer: ${plan.anyfare.reason}`];
  const unpaid = plan.anyfare.value;
  if (unpaid.status !== 402) {
    return [...lines, `  Anyfare ${unpaid.note ?? `answered ${unpaid.status}`}, not a 402.`];
  }
  lines.push(`  402 Payment Required${protocols(unpaid)}. ${count(unpaid.offers.length)}:`);
  lines.push(
    ...table(
      unpaid.offers.map((offer): [string, string, string] => {
        const way = payWayOf(offer);
        if (way === undefined) return [what(offer), how(offer), style.styles.label("Anyfare takes it; this app doesn't pay it")];
        const mark = way === payWay ? `  ${style.styles.ok('← you pay this one')}` : '';
        return [what(offer), how(offer), `--pay ${way}${mark}`];
      }),
    ),
  );
  if (payWay !== undefined && !unpaid.offers.some((offer) => payWayOf(offer) === payWay)) {
    lines.push(style.styles.warn(`  Anyfare offers no ${WAY_LABELS[payWay]} for this call now.`));
  }
  return lines;
}

const toMicro = (offer: Offer): bigint | undefined => {
  const known = findAsset(offer.network, offer.asset);
  if (known === undefined) return undefined;
  return known.decimals >= 6
    ? offer.amount / 10n ** BigInt(known.decimals - 6)
    : offer.amount * 10n ** BigInt(6 - known.decimals);
};

const dollars = (micro: bigint): string => `$${fromAtomic(micro, 6)}`;

function capLine(plan: Plan, totalDollars: string): string | undefined {
  let micro: bigint;
  try {
    micro = toAtomic(totalDollars, 6);
  } catch {
    return undefined;
  }
  const cap = `${dollars(plan.config.maxPayment)}`;
  return micro <= plan.config.maxPayment
    ? `  Your cap, MAX_PAYMENT_USD, is ${cap}. This quote is within it.`
    : `  Your cap, MAX_PAYMENT_USD, is ${cap}. This quote is over it, so a call would not go ahead.`;
}

function microOf(dollarsText: string): bigint | undefined {
  try {
    return toAtomic(dollarsText, 6);
  } catch {
    return undefined;
  }
}

/** `paying`: the one amount a call pays, in micro-USD, shown in place of the quote when given. */
function quoteBlock(plan: Plan, style: Style, paying: bigint | undefined): string[] {
  const field = (label: string, value: string): string => style.field(label, value, 16);
  if (plan.check.kind === 'skipped') {
    const lines = [style.step("Anyfare's quote, from the routing link's 402"), `  ${plan.check.note}`];
    if (plan.anyfare.kind !== 'ok') return [...lines, '  Anyfare did not answer, so there is no quote.'];
    const credits = plan.anyfare.value.offers.find((offer) => offer.protocol === 'credits');
    if (credits === undefined) return [...lines, "  Anyfare's 402 has no Credits price, so there is no quote."];
    const mark = plan.api.kind === 'ok' ? markOf(plan.api.value.offers, plan.check) : { offer: undefined, onlyOption: false };
    const apiMicro = mark.offer === undefined ? undefined : toMicro(mark.offer);
    const amount = paying ?? credits.amount;
    const total = fromAtomic(amount, 6);
    lines.push(
      field(
        "The API's price",
        apiMicro === undefined || mark.offer === undefined
          ? 'not known'
          : `${dollars(apiMicro)} in ${assetLabel(mark.offer.network, mark.offer.asset, mark.offer.assetName)} on ${networkName(mark.offer.network)}`,
      ),
      field("Anyfare's fee", apiMicro === undefined || apiMicro > amount ? 'not known' : dollars(amount - apiMicro)),
      field('You pay', style.styles.money(`$${total}`)),
    );
    const cap = capLine(plan, total);
    return cap === undefined ? lines : [...lines, cap];
  }
  const lines = [style.step("Anyfare's quote, from GET /_/check")];
  if (plan.check.kind === 'failed') return [...lines, `  Anyfare did not answer: ${plan.check.reason}`];
  const check = plan.check.value;
  if (!check.payable) return [...lines, `  Anyfare cannot pay this call (${check.reason}): ${check.message}`];
  const named = check.price.asset === undefined ? undefined : ANYFARE_ASSETS[check.price.asset];
  const label = named === undefined
    ? `${check.price.asset ?? 'an unknown asset'} on ${networkName(check.price.network)}`
    : `${assetLabel(named.network, named.address)} on ${networkName(named.network)}`;
  const apiMicro = microOf(check.price.amount);
  const fee =
    paying === undefined
      ? `$${check.quote.fee}`
      : apiMicro === undefined || apiMicro > paying
        ? 'not known'
        : dollars(paying - apiMicro);
  lines.push(
    field("The API's price", `$${check.price.amount} in ${label}`),
    field("Anyfare's fee", fee),
    field('You pay', style.styles.money(paying === undefined ? `$${check.quote.amount}` : dollars(paying))),
  );
  // The proxy holds the price of its 402 at the time of the call: say so when it is not the quote
  const quoted = microOf(check.quote.amount);
  const credits = plan.anyfare.kind === 'ok' ? plan.anyfare.value.offers.find((offer) => offer.protocol === 'credits') : undefined;
  if (paying === undefined && credits !== undefined && quoted !== undefined && credits.amount !== quoted) {
    lines.push(`  Anyfare's 402 for the same call asks ${dollars(credits.amount)} of Credits, not ${dollars(quoted)}.`);
  }
  // A call pays the higher of the two, so the cap line judges that one
  const higher = credits !== undefined && quoted !== undefined && credits.amount > quoted ? credits.amount : undefined;
  const judged = paying ?? higher;
  const cap = capLine(plan, judged === undefined ? check.quote.amount : fromAtomic(judged, 6));
  return cap === undefined ? lines : [...lines, cap];
}

/** What Anyfare pays the API for the call. Any part may be unknown. */
export interface ApiPrice {
  /** In micro-USD. */
  readonly micro: bigint | undefined;
  /** The asset's symbol, such as "USDC". */
  readonly asset: string | undefined;
  /** The network's name, such as "Base". */
  readonly network: string | undefined;
}

/** From `/_/check` for a GET; for a POST, from the one option of the API's own 402 that Anyfare can pay. */
export function apiPrice(plan: Plan): ApiPrice | undefined {
  if (plan.check.kind === 'ok') {
    const check = plan.check.value;
    if (!check.payable) return undefined;
    const named = check.price.asset === undefined ? undefined : ANYFARE_ASSETS[check.price.asset];
    const network = named?.network ?? check.price.network;
    let micro: bigint | undefined;
    try {
      micro = toAtomic(check.price.amount, 6);
    } catch {
      micro = undefined;
    }
    return {
      micro,
      asset: named === undefined ? check.price.asset : assetLabel(named.network, named.address),
      network: network === undefined ? undefined : networkName(network),
    };
  }
  if (plan.check.kind !== 'skipped' || plan.api.kind !== 'ok') return undefined;
  const { offer } = markOf(plan.api.value.offers, plan.check);
  if (offer === undefined) return undefined;
  return {
    micro: toMicro(offer),
    asset: assetLabel(offer.network, offer.asset, offer.assetName),
    network: offer.network === undefined ? undefined : networkName(offer.network),
  };
}

/**
 * The three blocks, as lines. `payWay` marks the option of Anyfare's 402 that a later call would pay.
 * `paying`, from a call, is the one amount it pays, in micro-USD: the quote lines and the cap use it.
 */
export function explainLines(
  plan: Plan,
  payWay?: PayWay,
  style: Style = createStyle(process.stdout),
  paying?: bigint,
): string[] {
  return [...apiBlock(plan, style), ...anyfareBlock(plan, style, payWay), ...quoteBlock(plan, style, paying)];
}

/** The title and the two addresses the command talks to. */
export function explainHeader(plan: Plan, style: Style): string[] {
  return [
    style.styles.title(`${toolName(plan)}: ${plan.prepared.summary}`),
    style.field('The API', plan.prepared.request.url, 8),
    style.field('Anyfare', plan.config.payUrl, 8),
    '',
  ];
}
