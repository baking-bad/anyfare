// Sign-up, payment keys and the balance. Each step is a function, so a flow can chain them.

import { checkQuote } from './anyfare.ts';
import { balanceText, readWalletBalance, walletsOf, wayLabel } from './balances.ts';
import { loadConfig } from './config.ts';
import type { Config } from './config.ts';
import type { Context } from './context.ts';
import { ENV_LOCAL, has } from './envLocal.ts';
import * as platform from './platform.ts';
import { MASTER_KEY_SHAPE, PAYMENT_KEY_SHAPE } from './platform.ts';
import { DEFAULT_ARGS, TOOLS } from './tools/index.ts';
import type { ToolId } from './tools/types.ts';
import { Stop, UsageError, fromAtomic, requireEnv, short, toAtomic, usd } from './util.ts';

export const MASTER_KEY = 'ANYFARE_MASTER_KEY';
export const PAYMENT_KEY = 'ANYFARE_PAYMENT_KEY';

export const SIGNUP_HINT = 'Run npm run demo -- signup first.';
export const SIGNUP_QUESTION =
  'Sign up creates an Anyfare account and a master key. The key is shown only once, so the app saves it to .env.local. Go on?';

const FIELD_WIDTH = 14;
const MAX_TRIES = 3;

export type KeyKind = 'master' | 'payment';

/** Anyfare keys given as flags, for one run: they win over the settings, and only `key save` saves them. */
export interface FlagKeys {
  readonly master?: string;
  readonly payment?: string;
}

const KEY_NAMES: Readonly<Record<KeyKind, string>> = { master: 'master key', payment: 'payment key' };
const KEY_STARTS: Readonly<Record<KeyKind, string>> = { master: 'afm_', payment: 'af_' };

/**
 * Why a text is not the key it should be, to follow its subject, such as "--payment-key"; `undefined`
 * when it is one. It never quotes the text.
 */
export function keyShapeProblem(text: string, wanted: KeyKind): string | undefined {
  const kind = MASTER_KEY_SHAPE.test(text) ? 'master' : PAYMENT_KEY_SHAPE.test(text) ? 'payment' : undefined;
  if (kind === wanted) return undefined;
  const starts = `A ${KEY_NAMES[wanted]} starts with ${KEY_STARTS[wanted]}`;
  if (kind !== undefined) return `is a ${KEY_NAMES[kind]}, not a ${KEY_NAMES[wanted]}. ${starts}`;
  return `does not look like a ${KEY_NAMES[wanted]}. ${starts}`;
}

/** The settings that keys stand for: `ANYFARE_MASTER_KEY` and `ANYFARE_PAYMENT_KEY`. */
export function keySettings(keys: FlagKeys | undefined): Record<string, string> {
  return {
    ...(keys?.master !== undefined && { [MASTER_KEY]: keys.master }),
    ...(keys?.payment !== undefined && { [PAYMENT_KEY]: keys.payment }),
  };
}

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
  const free = platform.freeCreditsOf(account.answer);
  const { style } = ctx;
  ctx.print([
    style.done('Account created'),
    style.field('Account', account.id === undefined ? '-' : oneLine(account.id), FIELD_WIDTH),
    style.field('Master key', short(account.masterKey), FIELD_WIDTH),
    `  Saved to ${ENV_LOCAL}`,
    ...(notice === undefined ? [] : [`  ${oneLine(notice)}`]),
    ...(free === undefined ? [] : [`  You got $${free} of free Credits`]),
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

/**
 * The Credits balance with the master key, the payment key's limits with the payment key, and then the
 * balance of each wallet whose settings are present. The wallets are read at the same time as the
 * Credits, each with its own time limit; one that can't be read is a line that says why.
 */
export async function showBalance(ctx: Context): Promise<void> {
  const env = ctx.session.env;
  const master = env[MASTER_KEY]?.trim() ? masterKeyOf(env) : undefined;
  const payment = env[PAYMENT_KEY]?.trim() ? paymentKeyOf(env) : undefined;
  const wallets = walletsOf(env);
  if (master === undefined && payment === undefined && wallets.length === 0) {
    throw new Stop(`Neither ${MASTER_KEY} nor ${PAYMENT_KEY} is set. ${SIGNUP_HINT}`);
  }
  const reads = Promise.all(wallets.map((way) => readWalletBalance(ctx.io.fetch, env, way, { withNear: true })));
  // Not left unheard when the Credits stop the command first
  reads.catch(() => undefined);
  const { style } = ctx;
  const field = (label: string, value: string): string => style.field(label, value, FIELD_WIDTH);
  // Three groups, in this order, with a blank line between them: the Credits, the wallets, the payment key
  const groups: string[][] = [];
  if (master !== undefined) groups.push(await masterCredits(ctx, master, field));
  if (wallets.length > 0) {
    const balances = await reads;
    const width = Math.max(...balances.map((balance) => wayLabel(balance.way).length));
    groups.push([style.step('Wallets'), ...balances.map((balance) => style.field(wayLabel(balance.way), balanceText(balance), width))]);
  }
  if (payment !== undefined) groups.push(await paymentKeyLines(ctx, master, payment, field));
  groups.forEach((group, index) => ctx.print(index === 0 ? group : ['', ...group]));
}

/** The master key's account: its Credits. */
async function masterCredits(ctx: Context, master: string, field: (label: string, value: string) => string): Promise<string[]> {
  const config = loadConfig(ctx.session.env);
  const { style } = ctx;
  const balance = await platform.balance(ctx.io.fetch, config.apiUrl, master);
  return [
    style.step('Credits, with the master key'),
    field('Available', style.styles.money(usd(balance.available))),
    field('Held', usd(balance.held)),
  ];
}

/** The payment key: its limits, what is left, and its own account's Credits. */
async function paymentKeyLines(
  ctx: Context,
  master: string | undefined,
  payment: string,
  field: (label: string, value: string) => string,
): Promise<string[]> {
  const config = loadConfig(ctx.session.env);
  const { style } = ctx;
  {
    const key = await platform.keyStatus(ctx.io.fetch, config.payUrl, payment);
    // The payment key pays: its account's Credits are the ones a call takes
    const ofAccount = master === undefined ? undefined : await keyOfAccount(ctx, config, master, key.id);
    const allowance =
      key.allowance === null || key.remaining.allowance === null
        ? 'none: only the daily budget limits it'
        : `${usd(key.remaining.allowance)} of ${usd(key.allowance)}`;
    return [
      style.step(`The payment key ${oneLine(key.label === null ? key.id : `"${key.label}"`)}`),
      field('Left today', `${usd(key.remaining.dailyBudget)} of ${usd(key.dailyBudget)}`),
      field('Allowance', allowance),
      field('Per call', key.maxPrice === null ? 'no limit' : `at most ${usd(key.maxPrice)}`),
      field('Available', style.styles.money(usd(key.remaining.balance))),
      ...(ofAccount === false ? [style.styles.warn(`  ${OTHER_ACCOUNT}`)] : []),
    ];
  }
}

/** The line for a payment key that is not of the master key's account. */
export const OTHER_ACCOUNT =
  "The payment key is of another account than the master key: a call it pays takes its own account's Credits.";

/**
 * Whether the payment key `keyId` is one of the master key's account, by `GET /v1/keys`: free.
 * `undefined` when that can't be read.
 */
export async function keyOfAccount(ctx: Context, config: Config, masterKey: string, keyId: string): Promise<boolean | undefined> {
  try {
    return (await platform.keyIds(ctx.io.fetch, config.apiUrl, masterKey)).includes(keyId);
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    return undefined;
  }
}

/** A `Stop` that says nothing was saved, once. */
function notSaved(error: Stop): Stop {
  if (error.message.endsWith('Nothing was saved.')) return error;
  return new Stop(`${error.message.replace(/\.$/, '')}. Nothing was saved.`);
}

const SECRET_QUESTIONS: Readonly<Record<KeyKind, string>> = {
  payment: 'Payment key, af_… (Enter to skip):',
  master: 'Master key, afm_… (to skip: Enter, then y):',
};

/** What a console that shows what is typed says before any key is asked for. */
export const ECHOING_CONSOLE = "This console can't hide what you type. Give the keys with .env.local, or run in a terminal.";

/**
 * A key asked with hidden input, checked for its shape, and asked again after a wrong one. `undefined`:
 * skipped. An empty master key is asked about once more, plainly: a stray Enter must not skip it, or the
 * key would next be typed at a question that shows it.
 */
async function askKey(ctx: Context, kind: KeyKind): Promise<string | undefined> {
  const prompter = ctx.prompter();
  for (let attempt = 1; attempt <= MAX_TRIES; attempt += 1) {
    const answer = await prompter.askSecret(SECRET_QUESTIONS[kind]);
    if (answer === '') {
      if (kind === 'payment' || (await prompter.confirm('Skip the master key?', false))) return undefined;
      continue;
    }
    const problem = keyShapeProblem(answer, kind);
    if (problem === undefined) return answer;
    ctx.print(`That ${problem}.`);
  }
  throw new Stop(`No ${KEY_NAMES[kind]} after ${MAX_TRIES} tries. Nothing was saved.`);
}

/**
 * The keys a person has: from the flags, whose shape the command line checked, or else asked with
 * hidden input, the payment key first. Then each is checked for free, before it is saved or used: the
 * master key with `GET /v1/account`, the payment key with `GET <pay>/_/key`. A key that is refused, or
 * that can't be checked, stops it all, and nothing is saved. Prints only `short(key)`.
 */
async function keysYouHave(ctx: Context, flags: FlagKeys | undefined): Promise<Record<string, string>> {
  // Before any question: a key typed here would show
  if (flags === undefined && ctx.prompter().secretInput() === 'echoed') throw new UsageError(ECHOING_CONSOLE);
  let keys: FlagKeys;
  try {
    if (flags !== undefined) {
      keys = flags;
    } else {
      const payment = await askKey(ctx, 'payment');
      const master = await askKey(ctx, 'master');
      keys = { ...(payment !== undefined && { payment }), ...(master !== undefined && { master }) };
    }
    if (keys.payment === undefined && keys.master === undefined) throw new Stop('No key was given. Nothing was saved.');
    const config = loadConfig(ctx.session.env);
    if (keys.payment !== undefined) await platform.keyStatus(ctx.io.fetch, config.payUrl, keys.payment);
    if (keys.master !== undefined) await platform.account(ctx.io.fetch, config.apiUrl, keys.master);
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    throw notSaved(error);
  }
  const { style } = ctx;
  const given = (['payment', 'master'] as const).filter((kind) => keys[kind] !== undefined);
  ctx.print([
    style.done(given.length === 1 ? 'Anyfare took the key, in a free check' : 'Anyfare took the keys, in a free check'),
    ...given.map((kind) => style.field(kind === 'payment' ? 'Payment key' : 'Master key', short(keys[kind] ?? ''), FIELD_WIDTH)),
  ]);
  return keySettings(keys);
}

/** Saves checked keys into .env.local, at mode 600, and says so; a failure saves nothing. */
function saveChecked(ctx: Context, values: Readonly<Record<string, string>>): void {
  for (const name of Object.keys(values)) {
    if (has(ctx.io.appDir, name)) ctx.print(`${name} is in ${ENV_LOCAL} already: the new key replaces it there.`);
  }
  let warnings: readonly string[];
  try {
    warnings = ctx.session.save(values);
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    throw notSaved(error);
  }
  for (const warning of warnings) ctx.warn(warning);
  ctx.print(ctx.style.done(`Saved to ${ENV_LOCAL}`));
}

/**
 * `key save`: the keys a person has, from the flags or asked with hidden input, checked for their
 * shape and then for free, saved into .env.local after a yes. `--yes` skips the yes.
 */
export async function saveKeys(ctx: Context, options: { readonly keys?: FlagKeys; readonly yes: boolean }): Promise<void> {
  const noTerminal = 'key save asks before it saves. Add --yes to save without a terminal';
  // Before any key is asked for or sent
  ctx.requireAnswerable(options.yes, noTerminal);
  const values = await keysYouHave(ctx, options.keys);
  // A line typed before the question appeared does not answer it
  if (!options.yes) ctx.prompter().dropTypedAhead();
  await ctx.approve({
    yes: options.yes,
    question: SAVE_QUESTION,
    noTerminal,
    declined: new Stop('Nothing was saved.'),
  });
  saveChecked(ctx, values);
}

/** The question before keys are saved. Its answer is No unless it is a y. */
const SAVE_QUESTION = `Save to ${ENV_LOCAL}?`;

/**
 * The interactive mode's "Use keys I have": the steps of `key save`, with hidden input. Anything but a
 * "yes" to the save, Enter too, uses the keys for this session only.
 */
export async function useKeysYouHave(ctx: Context): Promise<void> {
  const values = await keysYouHave(ctx, undefined);
  let save: boolean;
  try {
    ctx.prompter().dropTypedAhead();
    save = await ctx.prompter().confirm(SAVE_QUESTION, false);
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    throw notSaved(error);
  }
  if (save) {
    saveChecked(ctx, values);
    return;
  }
  ctx.session.use(values);
  ctx.print(`Nothing was saved: ${Object.keys(values).length === 1 ? 'the key works' : 'the keys work'} for this session only.`);
}
