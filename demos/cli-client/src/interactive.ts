// The interactive mode: pick a tool, give its data, pick a way to pay, get ready to pay, then call.
// Every step that does something is a function of the flags mode, run here with its own question.

import { MASTER_KEY, OTHER_ACCOUNT, PAYMENT_KEY, createPaymentKey, keyOfAccount, masterKeyOf, paymentKeyOf, signUp, useKeysYouHave } from './account.ts';
import { readWalletBalance, tokenText } from './balances.ts';
import { runCall } from './call.ts';
import type { PayWay, ToolArgs } from './cli.ts';
import { loadConfig } from './config.ts';
import type { Config } from './config.ts';
import type { Context } from './context.ts';
import { creditsPrice } from './credits.ts';
import { hideKeys } from './errors.ts';
import { planFailure, readPlan } from './explain.ts';
import { ENV_LOCAL } from './envLocal.ts';
import * as platform from './platform.ts';
import { createStyle } from './style.ts';
import { DEFAULT_TIMING, OPERATOR_CREDITS, TOPUPS_NOT_YET, isPositiveAmount, minimumRefusal, runTopup, topupOptions } from './topup.ts';
import { DEFAULT_ARGS, TOOLS } from './tools/index.ts';
import type { ToolId } from './tools/types.ts';
import { raceLimit } from './rpc.ts';
import { Stop, UsageError, usd } from './util.ts';
import {
  BASE_PRIVATE_KEY,
  NEAR_ACCOUNT_ID,
  NEAR_PRIVATE_KEY,
  TEMPO_PRIVATE_KEY,
} from './wallets.ts';

const MAX_TRIES = 3;
/** How long the list of ways to pay waits for the balances it shows after ✔. */
export const LIST_BALANCE_MS = 5_000;

interface Way {
  readonly way: PayWay;
  readonly label: string;
  /** The settings it needs. */
  readonly needs: readonly string[];
}

const WAYS: readonly Way[] = [
  { way: 'credits', label: 'Credits', needs: [PAYMENT_KEY] },
  { way: 'near', label: 'USDC on NEAR', needs: [NEAR_ACCOUNT_ID, NEAR_PRIVATE_KEY] },
  { way: 'base', label: 'USDC on Base', needs: [BASE_PRIVATE_KEY] },
  { way: 'tempo', label: 'USDC.e on Tempo', needs: [TEMPO_PRIVATE_KEY] },
];

/** The settings of the payment key that `key create` makes when it is not given any. */
const KEY_DEFAULTS = { label: 'demo', daily: '1', maxPrice: '0.02' } as const;

const isSet = (ctx: Context, name: string): boolean => (ctx.session.env[name]?.trim() ?? '') !== '';

const joined = (names: readonly string[]): string =>
  names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

/** One failure line on stderr, as the flags mode prints it. */
function printFailure(ctx: Context, error: Stop): void {
  const style = createStyle(ctx.io.stderr);
  ctx.io.stderr.write(`${style.fail(hideKeys(error.line()))}\n`);
}

/** Step 3: the tool's data, with the defaults. A bad value is the tool's own line, then asked again. */
async function askToolArgs(ctx: Context, tool: ToolId): Promise<ToolArgs> {
  const prompter = ctx.prompter();
  for (let attempt = 1; attempt <= MAX_TRIES; attempt += 1) {
    let args: ToolArgs;
    switch (tool) {
      case 'cmc':
        args = { tool, pair: await prompter.ask('Pair', DEFAULT_ARGS.cmc.pair) };
        break;
      case '3route': {
        const defaults = DEFAULT_ARGS['3route'];
        args = {
          tool,
          chain: await prompter.ask('Chain', defaults.chain),
          from: await prompter.ask('From (the token you sell)', defaults.from),
          to: await prompter.ask('To (the token you buy)', defaults.to),
          amount: await prompter.ask('Amount of the token you sell', defaults.amount),
        };
        break;
      }
      case 'evidence':
        args = { tool, account: await prompter.ask('NEAR account', DEFAULT_ARGS.evidence.account) };
        break;
    }
    try {
      await TOOLS[tool].prepare(args, { fetch: ctx.io.fetch });
      return args;
    } catch (error) {
      // Only a value that is not valid is asked again: a service that does not answer is not helped by it
      if (!(error instanceof UsageError)) throw error;
      printFailure(ctx, error);
    }
  }
  throw new Stop(`No valid value after ${MAX_TRIES} tries.`);
}

/**
 * The balance a way shows after ✔, read within `LIST_BALANCE_MS`: the Credits balance, or the
 * wallet's. `undefined` when it can't be read in time: the ✔ stands alone.
 */
async function listBalance(ctx: Context, config: Config, way: PayWay): Promise<string | undefined> {
  if (way !== 'credits') {
    const balance = await readWalletBalance(ctx.io.fetch, ctx.session.env, way, { limitMs: LIST_BALANCE_MS });
    return balance.kind === 'read' ? tokenText(way, balance.token) : undefined;
  }
  // The payment key's own Credits: the master key may be of another account
  const read = (async () => (await platform.keyStatus(ctx.io.fetch, config.payUrl, paymentKeyOf(ctx.session.env))).remaining.balance)();
  try {
    const available = await raceLimit(read, LIST_BALANCE_MS);
    return available === 'late' ? undefined : usd(available);
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    return undefined;
  }
}

/**
 * Step 4: the way to pay, each with what it needs, ✔ or ✘, and after a ✔ the balance when it can be
 * read in time. A way whose settings are missing says which to add, and asks again.
 */
async function chooseWay(ctx: Context, config: Config): Promise<PayWay> {
  const ready = (way: Way): boolean => way.needs.every((name) => isSet(ctx, name));
  // Read at the same time: the list waits for the slowest, and no longer than its limit
  const balances = await Promise.all(WAYS.map((way) => (ready(way) ? listBalance(ctx, config, way.way) : undefined)));
  const options = WAYS.map((way, index) => {
    const balance = balances[index];
    return {
      label: way.label,
      note: `needs ${joined(way.needs)}  ${ready(way) ? `✔${balance === undefined ? '' : `  ${balance}`}` : '✘'}`,
      value: way,
    };
  });
  for (;;) {
    const chosen = await ctx.prompter().choose('How do you pay?', options);
    // Credits can be set up in the next step
    const missing = chosen.needs.filter((name) => !isSet(ctx, name));
    if (chosen.way === 'credits' || missing.length === 0) return chosen.way;
    ctx.print(
      `${chosen.label} needs ${joined(missing)} in ${ENV_LOCAL}. Add ${missing.length === 1 ? 'it' : 'them'} there and start the demo again, or choose another way.`,
    );
  }
}

/** Whether a `Stop` says top-ups are not there on this Anyfare: not made, or off now. */
function topupsAway(error: Stop): boolean {
  return error.message === TOPUPS_NOT_YET || error.message.startsWith('Top-ups are off on this Anyfare');
}

/**
 * The Credits the payment key pays from, by `GET <pay>/_/key`, and the key's ID. Not the master key's
 * balance: the two keys may be of two accounts, and the payment key's is the one a call takes.
 */
async function creditsBalance(ctx: Context, config: Config): Promise<{ readonly available: bigint; readonly keyId: string } | undefined> {
  try {
    const status = await platform.keyStatus(ctx.io.fetch, config.payUrl, paymentKeyOf(ctx.session.env));
    return { available: status.remaining.balance, keyId: status.id };
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    ctx.warn(`Could not read the balance: ${error.message}`);
    return undefined;
  }
}

/** What the chosen call costs in Credits, from the free reads, or `undefined` when they don't give one. */
async function creditsCost(ctx: Context, config: Config, args: ToolArgs): Promise<bigint | undefined> {
  try {
    const prepared = await TOOLS[args.tool].prepare(args, { fetch: ctx.io.fetch });
    const plan = await readPlan({ fetch: ctx.io.fetch, config, prepared });
    if (planFailure(plan) !== undefined) return undefined;
    // The call prints any warning about the quote itself, so it is not printed twice
    return creditsPrice({ ...ctx, warn: () => undefined }, plan);
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    return undefined;
  }
}

/** Asks the network, the token and the amount, from Anyfare's list when it has one, then tops up. */
async function offerTopup(ctx: Context, config: Config): Promise<boolean> {
  const prompter = ctx.prompter();
  const { style } = ctx;
  let options: Awaited<ReturnType<typeof topupOptions>> | undefined;
  try {
    options = await topupOptions(ctx, config);
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    if (topupsAway(error)) {
      printFailure(ctx, error);
      if (error.message !== TOPUPS_NOT_YET) ctx.print(OPERATOR_CREDITS);
      return false;
    }
    ctx.warn(`Could not read the top-up options: ${error.message}`);
  }
  let network: string;
  let token: string;
  let tokenName = 'Token';
  if (options === undefined || options.networks.length === 0) {
    network = await prompter.ask('Network to send from');
    token = await prompter.ask(tokenName);
  } else {
    ctx.print(style.step(`A top-up adds ${options.asset ?? 'USDC on NEAR'} to your Credits`));
    const chosen = await prompter.choose(
      'Which network will you send from?',
      options.networks.map((item) => ({
        label: item.name,
        value: item,
        ...(item.minimum === null ? {} : { note: `worth at least $${item.minimum}` }),
      })),
    );
    network = chosen.name;
    token =
      chosen.tokens === undefined || chosen.tokens.length === 0
        ? await prompter.ask(tokenName)
        : await prompter.choose(
            'Which token?',
            chosen.tokens.map((item) => ({ label: item.symbol, value: item.symbol })),
          );
  }
  tokenName = token;
  let amount = '';
  let valid = false;
  for (let attempt = 1; attempt <= MAX_TRIES && !valid; attempt += 1) {
    amount = await prompter.ask(`Amount of ${tokenName} to send`);
    if (!isPositiveAmount(amount)) {
      if (attempt < MAX_TRIES) ctx.print('Type a plain decimal amount above zero, such as 5.');
      continue;
    }
    // Under the network's minimum: said at once, and asked again, with nothing sent
    const refusal = options === undefined ? undefined : minimumRefusal(options, network, token, amount);
    if (refusal === undefined) valid = true;
    else ctx.print(refusal);
  }
  if (!valid) throw new Stop('No valid amount.');
  try {
    return (await runTopup(ctx, { network, token, amount, yes: false }, ctx.io.topup?.timing ?? DEFAULT_TIMING, {
        options: options ?? null,
        interactive: true,
        ...(ctx.io.topup?.signals !== undefined && { signals: ctx.io.topup.signals }),
      })).credited;
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    printFailure(ctx, error);
    if (topupsAway(error) && error.message !== TOPUPS_NOT_YET) ctx.print(OPERATOR_CREDITS);
    return false;
  }
}

/**
 * Step 5: what Credits need before a call. Keys that are missing are made with the same functions as
 * `signup` and `key create`, each after its own question. Returns false to go back to the way to pay.
 */
async function readyCredits(ctx: Context, config: Config, args: ToolArgs): Promise<boolean> {
  try {
    if (!isSet(ctx, PAYMENT_KEY) && !isSet(ctx, MASTER_KEY)) {
      const how = await ctx.prompter().choose('Credits need an Anyfare key, and none is set. How do you get one?', [
        { label: 'Sign up: a new account, free', value: 'signup' as const },
        { label: 'Use keys I have', value: 'keys' as const },
      ]);
      if (how === 'signup') {
        ctx.print('Sign-up is one call, free, and gives a master key.');
        await signUp(ctx, { yes: false });
      } else {
        await useKeysYouHave(ctx);
      }
    }
    // A new account, or keys that hold a master key only
    if (!isSet(ctx, PAYMENT_KEY)) {
      ctx.print('A payment key pays the calls, with a daily budget and a limit for each call.');
      await createPaymentKey(ctx, { ...KEY_DEFAULTS, yes: false });
    }
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    printFailure(ctx, error);
    return false;
  }
  const credits = await creditsBalance(ctx, config);
  const price = await creditsCost(ctx, config, args);
  if (credits === undefined || price === undefined || credits.available >= price) return true;

  ctx.print(`Your balance is ${usd(credits.available)}, and this call costs ${usd(price)} of Credits.`);
  if (!isSet(ctx, MASTER_KEY)) {
    ctx.print(`A top-up needs ${MASTER_KEY}, and it is not set. ${OPERATOR_CREDITS}`);
    return false;
  }
  // A top-up adds to the master key's account: only of use when the payment key pays from it
  const ofAccount = await keyOfAccount(ctx, config, masterKeyOf(ctx.session.env), credits.keyId);
  if (ofAccount !== true) {
    ctx.print(
      ofAccount === false
        ? `${OTHER_ACCOUNT} A top-up with the master key would not reach it.`
        : "Could not check that the payment key is of the master key's account, so the app offers no top-up.",
    );
    return false;
  }
  if (!(await ctx.prompter().confirm('Add Credits with a top-up?', true))) return false;
  return offerTopup(ctx, config);
}

/** One call: steps 2 to 7. */
async function oneCall(ctx: Context, config: Config): Promise<void> {
  const prompter = ctx.prompter();
  const tool = await prompter.choose(
    'Which API do you call?',
    (Object.values(TOOLS)).map((item) => ({ label: item.about, value: item.id })),
  );
  const args = await askToolArgs(ctx, tool);
  let pay: PayWay;
  for (;;) {
    pay = await chooseWay(ctx, config);
    if (pay !== 'credits' || (await readyCredits(ctx, config, args))) break;
  }
  await runCall(ctx, { args, pay, explain: true, yes: false });
}

/** `npm run demo` with no arguments, on a terminal. Returns 0 when the person ends it. */
export async function runInteractive(ctx: Context): Promise<number> {
  const config = loadConfig(ctx.session.env);
  const { style } = ctx;
  ctx.print([
    style.styles.title('Anyfare demo: call a paid API through Anyfare'),
    style.field('Platform API', config.apiUrl, 12),
    style.field('Pay URL', config.payUrl, 12),
    '',
  ]);
  for (;;) {
    try {
      await oneCall(ctx, config);
    } catch (error) {
      if (!(error instanceof Stop)) throw error;
      printFailure(ctx, error);
    }
    if (!(await ctx.prompter().confirm('Another call?', true))) return 0;
  }
}
