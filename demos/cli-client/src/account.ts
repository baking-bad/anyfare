// Sign-up, payment keys and the balance. Each step is a function, so a flow can chain them.

import { checkQuote } from './anyfare.ts';
import { loadConfig } from './config.ts';
import type { Config } from './config.ts';
import type { Context } from './context.ts';
import { ENV_LOCAL } from './envLocal.ts';
import * as platform from './platform.ts';
import { PAYMENT_KEY_SHAPE } from './platform.ts';
import { DEFAULT_ARGS, TOOLS } from './tools/index.ts';
import type { ToolId } from './tools/types.ts';
import { Stop, fromAtomic, requireEnv, short, toAtomic, usd } from './util.ts';

export const MASTER_KEY = 'ANYFARE_MASTER_KEY';
export const PAYMENT_KEY = 'ANYFARE_PAYMENT_KEY';

export const SIGNUP_HINT = 'Run npm run demo -- signup first.';
export const SIGNUP_QUESTION =
  'Sign up creates an Anyfare account and a master key. The key is shown only once, so the app saves it to .env.local. Go on?';

const FIELD_WIDTH = 14;

/** A key from the settings, checked before it goes into a header. `undefined` when it is not set. */
function keyIn(env: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const value = env[name]?.trim();
  if (value === undefined || value === '') return undefined;
  if (!/^[\x21-\x7e]{1,500}$/.test(value)) throw new Stop(`${name} has characters a key does not have. Check .env.local.`);
  return value;
}

/** The master key, or a `Stop` with the hint to sign up. */
export function masterKeyOf(env: Readonly<Record<string, string | undefined>>): string {
  requireEnv(env, MASTER_KEY, SIGNUP_HINT);
  return keyIn(env, MASTER_KEY) as string;
}

/** The payment key, checked to be one before any request: a master key is refused here. */
export function paymentKeyOf(env: Readonly<Record<string, string | undefined>>): string {
  requireEnv(env, PAYMENT_KEY, 'Run npm run demo -- signup, then npm run demo -- key create.');
  const key = keyIn(env, PAYMENT_KEY) as string;
  if (key.startsWith('afm_')) throw new Stop('That is a master key. Paid calls take a payment key.');
  if (!PAYMENT_KEY_SHAPE.test(key)) {
    throw new Stop(`${PAYMENT_KEY} does not look like a payment key: it starts with af_. Run npm run demo -- key create.`);
  }
  return key;
}

/** Proves `.env.local` can be written, before a request whose answer holds a key shown only once. */
function checkSavable(ctx: Context): void {
  try {
    ctx.session.checkSavable();
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    throw new Stop(`${error.message} Nothing was created.`);
  }
}

/** Saves a key that was just created. If that still fails, says what exists and what to do. */
function saveNew(ctx: Context, values: Readonly<Record<string, string>>, lost: (reason: string) => string): void {
  let warnings: readonly string[];
  try {
    warnings = ctx.session.save(values);
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    throw new Stop(lost(error.message.replace(/\.$/, '')));
  }
  for (const warning of warnings) ctx.warn(warning);
}

/** Text from the answer as one line. */
const oneLine = (text: string): string => text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ');

/** The free quote of a tool's default call, in micro-USD, or `undefined` when it can't be read. */
async function defaultQuote(ctx: Context, config: Config, tool: ToolId): Promise<bigint | undefined> {
  try {
    const prepared = await TOOLS[tool].prepare(DEFAULT_ARGS[tool], { fetch: ctx.io.fetch });
    const check = await checkQuote(ctx.io.fetch, config.payUrl, prepared.request.url);
    if (!check.payable) return undefined;
    const micro = toAtomic(check.quote.amount, 6);
    return micro > 0n ? micro : undefined;
  } catch (error) {
    if (error instanceof Stop) return undefined;
    throw error;
  }
}

/** The balance after sign-up, and what it buys at this run's prices. A failure is a warning: the account is made. */
async function balanceAfterSignup(ctx: Context, config: Config): Promise<void> {
  let balance: platform.Balance;
  try {
    balance = await platform.balance(ctx.io.fetch, config.apiUrl, masterKeyOf(ctx.session.env));
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    ctx.warn(`Could not read the balance: ${error.message}`);
    return;
  }
  if (balance.available === 0n) {
    ctx.print('Your balance is $0. Credits come from a top-up, or from the operator.');
    return;
  }
  ctx.print(`Your balance is ${usd(balance.available)}.`);
  const parts: string[] = [];
  const cmc = await defaultQuote(ctx, config, 'cmc');
  if (cmc !== undefined) parts.push(`${balance.available / cmc} CoinMarketCap calls at ${usd(cmc)}`);
  const route = await defaultQuote(ctx, config, '3route');
  if (route !== undefined) parts.push(`${balance.available / route} 3Route quotes at ${usd(route)}`);
  if (parts.length > 0) ctx.print(`That pays for ${parts.join(', or ')}.`);
}

/**
 * Creates an account and its master key, saves the key to .env.local, and shows the balance. Refuses
 * when a master key is set already.
 */
export async function signUp(ctx: Context, options: { readonly yes: boolean }): Promise<void> {
  if (ctx.session.isSet(MASTER_KEY)) {
    throw new Stop(`${MASTER_KEY} is set already, so sign-up created nothing. balance and key create use that key.`);
  }
  const config = loadConfig(ctx.session.env);
  await ctx.approve({
    yes: options.yes,
    question: SIGNUP_QUESTION,
    noTerminal: 'signup asks before it creates an account. Add --yes to go on without a terminal',
    declined: new Stop('Nothing was created.'),
  });
  checkSavable(ctx);
  const account = await platform.signup(ctx.io.fetch, config.apiUrl);
  saveNew(
    ctx,
    { [MASTER_KEY]: account.masterKey },
    (reason) =>
      `The account ${oneLine(account.id ?? '(its ID could not be read)')} was created, but its master key could not be saved: ${reason}. ` +
      "The key can't be shown again, so that account can't be used. Make .env.local writable, then sign up again.",
  );
  // Only now the rest of the answer, for display: nothing in it can lose the key
  const notice = platform.noticeOf(account.answer);
  const { style } = ctx;
  ctx.print([
    style.done('Account created'),
    style.field('Account', account.id === undefined ? '-' : oneLine(account.id), FIELD_WIDTH),
    style.field('Master key', short(account.masterKey), FIELD_WIDTH),
    `  Saved to ${ENV_LOCAL}`,
    ...(notice === undefined ? [] : [`  ${oneLine(notice)}`]),
  ]);
  await balanceAfterSignup(ctx, config);
}

export interface KeyOptions {
  readonly label: string;
  /** US dollars, as typed. */
  readonly daily: string;
  readonly maxPrice: string;
  readonly yes: boolean;
}

const dollars = (text: string): string => fromAtomic(toAtomic(text, 6), 6);

/** Creates a payment key with the master key and saves it to .env.local, in place of the old one. */
export async function createPaymentKey(ctx: Context, options: KeyOptions): Promise<void> {
  const masterKey = masterKeyOf(ctx.session.env);
  const config = loadConfig(ctx.session.env);
  const daily = dollars(options.daily);
  const maxPrice = dollars(options.maxPrice);
  if (ctx.session.isSet(PAYMENT_KEY)) {
    ctx.print(
      `${PAYMENT_KEY} is set already. The new key replaces it in ${ENV_LOCAL}; the old key keeps working until it is revoked.`,
    );
  }
  await ctx.approve({
    yes: options.yes,
    question: `Create a payment key "${options.label}": daily budget $${daily}, at most $${maxPrice} a call, saved to ${ENV_LOCAL}?`,
    noTerminal: 'key create asks before it creates a key. Add --yes to go on without a terminal',
    declined: new Stop('Nothing was created.'),
  });
  checkSavable(ctx);
  const created = await platform.createKey(ctx.io.fetch, config.apiUrl, masterKey, {
    label: options.label,
    dailyBudget: daily,
    maxPrice,
  });
  saveNew(
    ctx,
    { [PAYMENT_KEY]: created.key },
    (reason) =>
      `The payment key ${oneLine(created.id ?? '(its ID could not be read)')} was created, but it could not be saved: ${reason}. ` +
      `Revoke it with the master key (DELETE /v1/keys/${oneLine(created.id ?? '<its ID>')} on the Platform API), then create another.`,
  );
  // Only now the rest of the answer, for display: a field that can't be read shows -
  const shown = platform.shownLimits(created.answer);
  const dash = <T>(value: T | null | undefined, show: (value: T) => string, none: string): string =>
    value === undefined ? '-' : value === null ? none : show(value);
  const { style } = ctx;
  const field = (label: string, value: string): string => style.field(label, value, FIELD_WIDTH);
  ctx.print([
    style.done('Payment key created'),
    field('Key ID', created.id === undefined ? '-' : oneLine(created.id)),
    field('Label', dash(shown.label, oneLine, '-')),
    field('Payment key', short(created.key)),
    field('Daily budget', dash(shown.dailyBudget, usd, '-')),
    field('Per call', dash(shown.maxPrice, (price) => `at most ${usd(price)}`, 'no limit')),
    field('Allowance', dash(shown.allowance, usd, 'none: only the daily budget limits it')),
    field('Expires', dash(shown.expiresAt, oneLine, 'never')),
    `  Saved to ${ENV_LOCAL}`,
  ]);
}

/** The Credits balance with the master key, and the payment key's limits with the payment key. */
export async function showBalance(ctx: Context): Promise<void> {
  const env = ctx.session.env;
  const master = env[MASTER_KEY]?.trim() ? masterKeyOf(env) : undefined;
  const payment = env[PAYMENT_KEY]?.trim() ? paymentKeyOf(env) : undefined;
  if (master === undefined && payment === undefined) {
    throw new Stop(`Neither ${MASTER_KEY} nor ${PAYMENT_KEY} is set. ${SIGNUP_HINT}`);
  }
  const config = loadConfig(env);
  const { style } = ctx;
  const field = (label: string, value: string): string => style.field(label, value, FIELD_WIDTH);
  if (master !== undefined) {
    const balance = await platform.balance(ctx.io.fetch, config.apiUrl, master);
    ctx.print([
      style.step('Credits, with the master key'),
      field('Available', style.styles.money(usd(balance.available))),
      field('Held', usd(balance.held)),
    ]);
  }
  if (payment !== undefined) {
    const key = await platform.keyStatus(ctx.io.fetch, config.payUrl, payment);
    const allowance =
      key.allowance === null || key.remaining.allowance === null
        ? 'none: only the daily budget limits it'
        : `${usd(key.remaining.allowance)} of ${usd(key.allowance)}`;
    ctx.print([
      style.step(`The payment key ${oneLine(key.label === null ? key.id : `"${key.label}"`)}`),
      field('Left today', `${usd(key.remaining.dailyBudget)} of ${usd(key.dailyBudget)}`),
      field('Allowance', allowance),
      field('Per call', key.maxPrice === null ? 'no limit' : `at most ${usd(key.maxPrice)}`),
      ...(master === undefined ? [field('Available', style.styles.money(usd(key.remaining.balance)))] : []),
    ]);
  }
}
