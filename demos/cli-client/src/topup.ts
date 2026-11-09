// A top-up: ask Anyfare for a deposit address, say where to send, and watch the transfer until it is
// credited or ends. The app sends nothing: the person sends from a wallet of their own.

import type { EventEmitter } from 'node:events';
import { masterKeyOf } from './account.ts';
import { loadConfig } from './config.ts';
import type { Config } from './config.ts';
import type { Context } from './context.ts';
import { clip, httpErrorOf, stopFor } from './errors.ts';
import { failureOf, request } from './http.ts';
import type { Answer } from './http.ts';
import { Stop, isRecord, toAtomic } from './util.ts';
import { EXPLORERS } from './wallets.ts';

export const TOPUPS_NOT_YET = 'Top-ups are not available on this Anyfare yet. The operator credits balances.';
export const OPERATOR_CREDITS = 'The operator credits balances.';

export const TOPUP_TIMEOUT_MS = 20_000;
/** Poll every 5 seconds, for at most 30 minutes in all. */
export const POLL_INTERVAL_MS = 5_000;
export const POLL_LIMIT_MS = 30 * 60_000;

/** The statuses after which a top-up does not change. */
const FINAL: ReadonlySet<string> = new Set(['quote_failed', 'quote_unknown', 'credited', 'refunded', 'failed', 'expired']);

export interface TopupCommand {
  readonly network: string;
  readonly token: string;
  readonly amount: string;
  readonly yes: boolean;
}

export interface TopupTiming {
  readonly intervalMs: number;
  readonly limitMs: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_TIMING: TopupTiming = { intervalMs: POLL_INTERVAL_MS, limitMs: POLL_LIMIT_MS };

/** A top-up as Anyfare answers it. `null`: not there yet. Text from the answer is shown clipped to one line. */
export interface Topup {
  readonly id: string;
  readonly status: string;
  readonly message: string | null;
  readonly network: string | null;
  readonly token: string | null;
  readonly amount: string | null;
  readonly depositAddress: string | null;
  readonly depositMemo: string | null;
  readonly send: string | null;
  readonly sendAtLeast: string | null;
  readonly estimatedCredits: string | null;
  readonly payBy: string | null;
  readonly deposited: string | null;
  readonly credited: string | null;
  readonly transaction: string | null;
  readonly refunded: string | null;
}

export interface TopupOutcome {
  readonly credited: boolean;
  /** Anyfare's last status, or `stopped` when the person stopped waiting. */
  readonly status: string;
}

/** What a top-up waits with, for a test to replace: the poll timing, and where Ctrl-C arrives. */
export interface TopupHooks {
  readonly timing?: TopupTiming;
  readonly signals?: Pick<EventEmitter, 'once' | 'removeListener'>;
}

/** What the interactive mode adds to one top-up. */
export interface TopupExtras {
  /**
   * The network list the caller has read: `null` when it could not be read, so there is no minimum to
   * check. Left out, the top-up reads it itself, once.
   */
  readonly options?: TopupOptions | null;
  /** True in the interactive mode: Ctrl-C then stops the wait, and the app goes on. */
  readonly interactive?: boolean;
  /** Where Ctrl-C arrives. The process, unless a test gives another. */
  readonly signals?: Pick<EventEmitter, 'once' | 'removeListener'>;
}

const textOrNull = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

function readTopup(body: unknown): Topup {
  const bad = (field: string): never => {
    throw new Stop(`Anyfare's answer about the top-up was not understood: ${field} is missing or not valid`);
  };
  const root = isRecord(body) ? body : bad('the body');
  const id = textOrNull(root['id']) ?? bad('id');
  const status = textOrNull(root['status']) ?? bad('status');
  const field = (name: string): string | null => textOrNull(root[name]);
  return {
    id,
    status,
    message: field('message'),
    network: field('network'),
    token: field('token'),
    amount: field('amount'),
    depositAddress: field('depositAddress'),
    depositMemo: field('depositMemo'),
    send: field('send'),
    sendAtLeast: field('sendAtLeast'),
    estimatedCredits: field('estimatedCredits'),
    payBy: field('payBy'),
    deposited: field('deposited'),
    credited: field('credited'),
    transaction: field('transaction'),
    refunded: field('refunded'),
  };
}

const base = (url: string): string => url.replace(/\/+$/, '');

/** The line for an answer that is not 2xx. A 404 on the routes that make or list top-ups: there are none here. */
function stopForTopups(answer: Answer, missingMeansOff: boolean): Stop {
  if (missingMeansOff && answer.status === 404) return new Stop(TOPUPS_NOT_YET);
  const error = httpErrorOf(answer);
  const stop = stopFor(error, { side: 'api' });
  // The swap service refuses an amount under its own minimum, which Anyfare cannot know in dollars
  if (error.code === 'topup_refused' && /too low/i.test(error.message)) {
    return new Stop(`${stop.message}\n${UNDER_ITS_MINIMUM}`, { notCharged: stop.notCharged });
  }
  return stop;
}

export const UNDER_ITS_MINIMUM = "That is under 1Click's own minimum for this route. Try a larger amount.";

export interface TopupOptions {
  readonly asset: string | null;
  readonly networks: readonly {
    readonly name: string;
    readonly minimum: string | null;
    readonly tokens: readonly { readonly symbol: string; readonly decimals: number | null }[] | undefined;
  }[];
}

/** `GET /v1/topups/options`, no key. A `Stop` with the 404 line when this Anyfare has no top-ups. */
export async function topupOptions(ctx: Context, config: Config): Promise<TopupOptions> {
  const answer = await request(ctx.io.fetch, {
    method: 'GET',
    url: `${base(config.apiUrl)}/v1/topups/options`,
    timeoutMs: TOPUP_TIMEOUT_MS,
  });
  if (answer.status < 200 || answer.status >= 300) throw stopForTopups(answer, true);
  const body = answer.body;
  if (!isRecord(body) || !Array.isArray(body['networks'])) {
    throw new Stop("Anyfare's list of top-up networks was not understood");
  }
  const networks = body['networks'].flatMap((item: unknown) => {
    if (!isRecord(item)) return [];
    const name = textOrNull(item['name']);
    if (name === null) return [];
    const tokens = Array.isArray(item['tokens'])
      ? item['tokens'].flatMap((token: unknown) => {
          if (!isRecord(token)) return [];
          const symbol = textOrNull(token['symbol']);
          if (symbol === null) return [];
          const decimals = token['decimals'];
          return [{ symbol, decimals: typeof decimals === 'number' ? decimals : null }];
        })
      : undefined;
    return [{ name, minimum: textOrNull(item['minimum']), tokens }];
  });
  return { asset: textOrNull(body['asset']), networks };
}

/** The tokens whose amount is its value in US dollars, by symbol. Nothing else is priced here. */
const DOLLAR_TOKENS: ReadonlySet<string> = new Set(['USDC', 'USDT', 'USDT0', 'DAI']);

/** A plain decimal as dollars, with at least two decimals: 0.1 is $0.10. */
function dollarsOf(amount: string): string {
  const [whole = '0', fraction = ''] = amount.split('.');
  return `$${whole}.${fraction.replace(/0+$/, '').padEnd(2, '0')}`;
}

/**
 * The line that refuses a top-up under the network's minimum, or `undefined`. Only a dollar stablecoin
 * can be compared, since the list has the minimum in dollars and no token price. Anything that cannot
 * be compared is left to the API's own answer.
 */
export function minimumRefusal(
  options: TopupOptions,
  network: string,
  token: string,
  amount: string,
): string | undefined {
  if (!DOLLAR_TOKENS.has(token)) return undefined;
  const minimum = options.networks.find((item) => item.name === network)?.minimum;
  if (minimum === null || minimum === undefined) return undefined;
  try {
    if (toAtomic(amount, 36) >= toAtomic(minimum, 36)) return undefined;
  } catch {
    return undefined;
  }
  return `A top-up on ${one(network)} must be worth at least $${one(minimum)}. ${one(amount)} ${token} is worth ${dollarsOf(amount)}.`;
}

async function createTopup(ctx: Context, config: Config, masterKey: string, command: TopupCommand): Promise<Topup> {
  let answer: Answer;
  try {
    answer = await request(ctx.io.fetch, {
      method: 'POST',
      url: `${base(config.apiUrl)}/v1/topups`,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${masterKey}` },
      body: JSON.stringify({ network: command.network, token: command.token, amount: command.amount }),
      timeoutMs: TOPUP_TIMEOUT_MS,
    });
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    if (failureOf(error)?.stage === 'not_sent') throw new Stop(`${error.message}. Nothing was asked.`);
    throw new Stop(`${error.message}. Whether Anyfare made a deposit address is not known. This app sends nothing; ask again.`);
  }
  if (answer.status < 200 || answer.status >= 300) throw stopForTopups(answer, true);
  return readTopup(answer.body);
}

async function readTopupNow(ctx: Context, config: Config, masterKey: string, id: string): Promise<Topup> {
  const answer = await request(ctx.io.fetch, {
    method: 'GET',
    url: `${base(config.apiUrl)}/v1/topups/${encodeURIComponent(id)}`,
    headers: { authorization: `Bearer ${masterKey}` },
    timeoutMs: TOPUP_TIMEOUT_MS,
  });
  if (answer.status < 200 || answer.status >= 300) throw stopForTopups(answer, false);
  return readTopup(answer.body);
}

const one = (text: string): string => clip(text);

/** The amounts a top-up has by now, in words: "deposited 5 USDC, credited $4.9". */
function amountsOf(topup: Topup): string {
  const token = topup.token === null ? '' : ` ${one(topup.token)}`;
  const parts = [
    topup.deposited === null ? undefined : `deposited ${one(topup.deposited)}${token}`,
    topup.credited === null ? undefined : `credited $${one(topup.credited)}`,
    topup.refunded === null ? undefined : `refunded ${one(topup.refunded)}${token}`,
  ].filter((part): part is string => part !== undefined);
  return parts.length === 0 ? '' : ` (${parts.join(', ')})`;
}

/** The one line of a status: Anyfare's own message, and the amounts by then. */
function statusLine(ctx: Context, topup: Topup): string {
  const { style } = ctx;
  const text = `${one(topup.message ?? topup.status)}${amountsOf(topup)}`;
  if (topup.status === 'credited') return style.done(text);
  if (FINAL.has(topup.status)) return style.styles.warn(`▸ ${text}`);
  return style.step(text);
}

/** The NEAR delivery transaction, with a link when it has the shape of a hash. */
function transactionLines(topup: Topup): string[] {
  if (topup.transaction === null) return [];
  const hash = topup.transaction;
  const explorer = EXPLORERS.near;
  if (!explorer.hash.test(hash)) return [`  Transaction ${one(hash)}`];
  return [`  Transaction ${hash}`, `  ${explorer.transaction(hash)}`];
}

function detailLines(ctx: Context, topup: Topup): string[] {
  const { style } = ctx;
  const field = (label: string, value: string): string => style.field(label, value, 12);
  const token = topup.token === null ? '' : ` ${one(topup.token)}`;
  const memo = topup.depositMemo === null ? [] : [field('Memo', `${one(topup.depositMemo)}  (the memo is required)`)];
  return [
    field('Network', one(topup.network ?? '-')),
    field('Token', one(topup.token ?? '-')),
    field('Send to', one(topup.depositAddress ?? '-')),
    ...memo,
    ...(topup.send === null ? [] : [field('Send', `${one(topup.send)}${token}`)]),
    ...(topup.sendAtLeast === null ? [] : [field('At least', `${one(topup.sendAtLeast)}${token}`)]),
    ...(topup.estimatedCredits === null ? [] : [field('Credits', `about $${one(topup.estimatedCredits)}`)]),
    ...(topup.payBy === null ? [] : [field('Pay by', one(topup.payBy))]),
    field('Top-up ID', one(topup.id)),
  ];
}

/** Waits `ms`, or until the person stops the wait. */
async function pause(ms: number, sleep: ((ms: number) => Promise<void>) | undefined, stopped: Promise<void>): Promise<void> {
  if (sleep !== undefined) {
    await Promise.race([sleep(ms), stopped]);
    return;
  }
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([new Promise<void>((resolve) => (timer = setTimeout(resolve, ms))), stopped]);
  clearTimeout(timer);
}

interface Stopper {
  /** Settles when the person stops the wait: Enter on a terminal, or Ctrl-C in the interactive mode. */
  readonly stopped: Promise<void>;
  isStopped(): boolean;
  /** Takes back the Enter read and the Ctrl-C handler. */
  release(): void;
}

/**
 * What stops the wait. On a terminal the session's one prompter reads the Enter, so the line is not
 * lost and no second reader takes stdin. In the interactive mode the first Ctrl-C is the same as
 * Enter; the handler then goes, so a second Ctrl-C ends the app as it always does.
 */
function listenForStop(ctx: Context, extras: TopupExtras): Stopper {
  let stopNow: () => void = () => undefined;
  const stopped = new Promise<void>((resolve) => (stopNow = resolve));
  let done = false;
  const trigger = (): void => {
    done = true;
    stopNow();
  };
  const releases: (() => void)[] = [];
  if (ctx.io.isTerminal) {
    const enter = ctx.prompter().waitForEnter();
    void enter.pressed.then(trigger);
    releases.push(enter.cancel);
    ctx.print('Press Enter to stop waiting.');
  }
  if (extras.interactive === true) {
    const signals = extras.signals ?? process;
    signals.once('SIGINT', trigger);
    releases.push(() => signals.removeListener('SIGINT', trigger));
  }
  return { stopped, isStopped: () => done, release: () => releases.forEach((release) => release()) };
}

/** The top-up's network list for the minimum check: `null` when it can't be read, so no check is made. */
async function readOptionsForCheck(ctx: Context, config: Config): Promise<TopupOptions | null> {
  try {
    return await topupOptions(ctx, config);
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    return null;
  }
}

/**
 * `topup`: checks the amount against the network's minimum, asks for a deposit address, prints where
 * to send, then polls until a final status or until the person stops waiting. Returns whether the
 * top-up was credited. A `Stop` for every other failure, with its one line.
 */
export async function runTopup(
  ctx: Context,
  command: TopupCommand,
  timing: TopupTiming = DEFAULT_TIMING,
  extras: TopupExtras = {},
): Promise<TopupOutcome> {
  const config = loadConfig(ctx.session.env);
  const masterKey = masterKeyOf(ctx.session.env);
  await ctx.approve({
    yes: command.yes,
    question: `Ask Anyfare for a deposit address for ${command.amount} ${command.token} on ${command.network}?`,
    noTerminal: 'topup asks before it asks Anyfare for a deposit address. Add --yes to go on without a terminal',
    declined: new Stop('Nothing was asked.'),
  });

  // The list has the minimum in dollars: a dollar stablecoin is checked here, before anything is sent
  const options = extras.options === undefined ? await readOptionsForCheck(ctx, config) : extras.options;
  const refusal = options === null ? undefined : minimumRefusal(options, command.network, command.token, command.amount);
  if (refusal !== undefined) throw new Stop(refusal);

  let topup = await createTopup(ctx, config, masterKey, command);
  const hasAddress = topup.depositAddress !== null;
  ctx.print(ctx.style.step('Top-up'));
  ctx.print(hasAddress ? detailLines(ctx, topup) : [ctx.style.field('Top-up ID', one(topup.id), 12)]);
  if (hasAddress && !FINAL.has(topup.status)) {
    ctx.print('  Send it yourself, from a wallet of yours. This app sends nothing.');
  }
  ctx.print(statusLine(ctx, topup));
  ctx.print(transactionLines(topup));
  if (FINAL.has(topup.status)) return { credited: topup.status === 'credited', status: topup.status };

  ctx.print(
    `Ctrl-C is safe: npm run demo -- balance shows the result later. The top-up's ID is ${one(topup.id)}. Checking every ${Math.round(timing.intervalMs / 1000)} seconds.`,
  );
  const stop = listenForStop(ctx, extras);
  try {
    const deadline = Date.now() + timing.limitMs;
    let shown = topup.status;
    let lastWarning = '';
    while (Date.now() < deadline) {
      await pause(timing.intervalMs, timing.sleep, stop.stopped);
      if (stop.isStopped()) break;
      let next: Topup;
      try {
        const reading = readTopupNow(ctx, config, masterKey, topup.id);
        // A read that is given up on may still fail later: nobody waits for it
        reading.catch(() => undefined);
        const read = await Promise.race([reading, stop.stopped]);
        if (read === undefined || stop.isStopped()) break;
        next = read;
      } catch (error) {
        if (!(error instanceof Stop)) throw error;
        // The same warning is not repeated while polling goes on
        const line = `Could not read the top-up's status: ${error.line().replace(/\.$/, '')}. Trying again.`;
        if (line !== lastWarning) ctx.warn(line);
        lastWarning = line;
        continue;
      }
      lastWarning = '';
      topup = next;
      if (topup.status !== shown) {
        shown = topup.status;
        ctx.print(statusLine(ctx, topup));
        ctx.print(transactionLines(topup));
      }
      if (FINAL.has(topup.status)) return { credited: topup.status === 'credited', status: topup.status };
    }
    if (stop.isStopped()) {
      const until = topup.payBy === null ? 'its pay-by time' : one(topup.payBy);
      ctx.print(
        `Stopped waiting. The address stays open until ${until}: a transfer sent before then is still credited, and \`balance\` shows it. After that time, don't send to it.`,
      );
      return { credited: false, status: 'stopped' };
    }
  } finally {
    stop.release();
  }
  throw new Stop(
    `Stopped waiting after ${Math.round(timing.limitMs / 60_000)} minutes. The top-up's ID is ${one(topup.id)}; npm run demo -- balance shows the result later.`,
  );
}

/** Whether a typed amount is a plain decimal above zero, for the questions of the interactive mode. */
export function isPositiveAmount(text: string): boolean {
  try {
    return toAtomic(text, 36) > 0n;
  } catch {
    return false;
  }
}
