// The command line: what to run, and the exit code.

import type { Readable, Writable } from 'node:stream';
import { readNearBalance, walletBlock } from './balances.ts';
import { loadConfig } from './config.ts';
import { createContext } from './context.ts';
import type { Context } from './context.ts';
import { clip, hideKeys } from './errors.ts';
import type { Fetch } from './http.ts';
import { runInteractive } from './interactive.ts';
import { payRequest } from './pay.ts';
import { parseRequest } from './request.ts';
import type { HttpRequest } from './request.ts';
import { createStyle } from './style.ts';
import { NotSupported, Stop, UsageError } from './util.ts';
import { readNearAccount, withoutKey } from './wallet.ts';

export interface Io {
  readonly stdout: Writable;
  readonly stderr: Writable;
  readonly stdin: Readable;
  /** True when both stdin and stdout are terminals. */
  readonly isTerminal: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetch: Fetch;
  /** Calls `listener` on each Ctrl-C until the returned function is called. Without it, Ctrl-C keeps its default. */
  readonly onInterrupt?: (listener: () => void) => () => void;
}

export interface AppOptions {
  readonly yes: boolean;
  readonly dryRun: boolean;
  readonly maxUsd?: string;
  readonly full: boolean;
}

export type Command =
  | { readonly kind: 'help' }
  | { readonly kind: 'interactive'; readonly options: AppOptions }
  | { readonly kind: 'balance' }
  | { readonly kind: 'request'; readonly request: HttpRequest; readonly options: AppOptions };

export const HELP_TEXT = `x402-near-wallet pays x402 APIs in USDC from a NEAR wallet.

Usage:
  npm run demo                                  interactive
  npm run demo -- <url>                         pay one request; asks first if there is a terminal
  npm run demo -- <url> --yes                   pay without asking
  npm run demo -- <url> --dry-run               show the cost, pay nothing
  npm run demo -- -X POST --json '{"a":1}' <url>
  npm run demo -- balance                       the wallet's USDC and NEAR, free
  npm run demo -- --help

A request is a URL with curl's options: -X, -H, -d, --data, --data-raw, --json,
-s and -S. A leading "curl" is dropped. The URL must be https.

App options:
  --yes          pay without asking
  --dry-run      show the cost, pay nothing
  --max <usd>    the most to pay for one call, such as 0.05
  --full         show the whole answer

Settings (from .env, then .env.local, then the shell; the last one wins):
  NEAR_ACCOUNT_ID    the wallet, such as alice.near
  NEAR_PRIVATE_KEY   a key of that account; needed to pay
  NEAR_RPC_URL       optional, must be https
  MAX_PAYMENT_USD    the most to pay for one call (default 0.02)
  ANYFARE_PAY_URL    where the Anyfare link points (default https://pay.anyfare.agents.bakingbad.dev)

Exit codes:
  0  answered, paid or free
  1  failed
  2  bad usage
  3  not supported, nothing paid
`;

const MAX_PLAIN = /^[0-9]+(\.[0-9]{1,6})?$/;

function checkMax(text: string): string {
  if (!MAX_PLAIN.test(text) || /^0+(\.0+)?$/.test(text)) {
    throw new UsageError('--max needs a plain amount in dollars above zero, with at most 6 decimals, such as 0.05');
  }
  return text;
}

/** Reads the command line. Throws a `UsageError`. */
export function parseCommand(argv: readonly string[]): Command {
  if (argv.includes('--help') || argv.includes('-h')) return { kind: 'help' };

  let yes = false;
  let dryRun = false;
  let full = false;
  let maxUsd: string | undefined;
  const rest: string[] = [];
  for (let at = 0; at < argv.length; at += 1) {
    const word = argv[at] ?? '';
    if (word === '--yes') yes = true;
    else if (word === '--dry-run') dryRun = true;
    else if (word === '--full') full = true;
    else if (word === '--max') {
      const next = argv[at + 1];
      if (next === undefined) throw new UsageError('--max needs a value, such as --max 0.05');
      maxUsd = checkMax(next);
      at += 1;
    } else if (word.startsWith('--max=')) maxUsd = checkMax(word.slice('--max='.length));
    else rest.push(word);
  }
  if (yes && dryRun) throw new UsageError('Use --yes or --dry-run, not both');
  const options: AppOptions = { yes, dryRun, full, ...(maxUsd !== undefined && { maxUsd }) };

  if (rest.length === 0) {
    if (yes || dryRun) throw new UsageError(`${yes ? '--yes' : '--dry-run'} needs a request. See --help`);
    return { kind: 'interactive', options };
  }
  if (rest[0] === 'balance') {
    if (argv.length > 1) throw new UsageError('balance takes no other argument. See --help');
    return { kind: 'balance' };
  }
  return { kind: 'request', request: parseRequest(rest), options };
}

/** One handler per command. It returns the exit code. */
export type Handlers = {
  readonly [K in Command['kind']]: (command: Extract<Command, { kind: K }>, ctx: Context) => Promise<number>;
};

/** `balance`: the wallet's USDC and NEAR. It needs the account only, never the key. */
async function balanceCommand(_command: { readonly kind: 'balance' }, ctx: Context): Promise<number> {
  const { accountId, rpc } = readNearAccount(ctx.env);
  const config = loadConfig(ctx.env);
  const balance = await readNearBalance(ctx.io.fetch, accountId, rpc, { withNear: true });
  ctx.print(walletBlock(ctx, config, accountId, balance));
  if (balance.kind === 'failed') throw new Stop(`Could not read the balance: ${balance.reason}.`);
  return 0;
}

/** A request: sent unpaid, and paid in USDC on NEAR when it asks for it. */
function requestCommand(command: Extract<Command, { kind: 'request' }>, ctx: Context): Promise<number> {
  const { maxUsd } = command.options;
  const config = loadConfig(ctx.env, maxUsd === undefined ? {} : { maxUsd });
  return payRequest(ctx, config, command.request, command.options);
}

export const HANDLERS: Handlers = {
  help: (_command, ctx) => {
    ctx.io.stdout.write(HELP_TEXT);
    return Promise.resolve(0);
  },
  interactive: (command, ctx) => runInteractive(ctx, command.options),
  balance: balanceCommand,
  request: requestCommand,
};

/** One line printed for a failure: no key in it, in whole or in part. */
const safeLine = (ctx: Context, text: string): string => withoutKey(hideKeys(text), ctx.env);

/**
 * Prints a failure: one ✘ line on stderr, then a `NotSupported`'s hint on stdout. Another error than
 * a `Stop` is not the app's own: its text is cut to one short line. The hint is the request itself,
 * to paste back: only the wallet's own key is taken out of it, never a part that merely looks like a
 * key, such as a transaction hash in its URL. Returns the exit code: 1 failed, 2 bad usage, 3 not
 * supported.
 */
export function printFailure(ctx: Context, error: unknown): number {
  const style = createStyle(ctx.io.stderr);
  const line = error instanceof Stop ? error.line() : clip(error instanceof Error ? error.message : String(error));
  ctx.io.stderr.write(`${style.fail(safeLine(ctx, line))}\n`);
  // `print` takes NEAR_PRIVATE_KEY out of every line
  if (error instanceof NotSupported && error.hint.length > 0) ctx.print(error.hint);
  if (error instanceof UsageError) return 2;
  if (error instanceof NotSupported) return 3;
  return 1;
}

/** Runs the app and returns the exit code: 0 answered, 1 failed, 2 bad usage, 3 not supported. */
export async function runCli(argv: readonly string[], io: Io, handlers: Handlers = HANDLERS): Promise<number> {
  const ctx = createContext(io);
  try {
    const command = parseCommand(argv);
    const handler = handlers[command.kind] as (command: Command, ctx: Context) => Promise<number>;
    return await handler(command, ctx);
  } catch (error) {
    return printFailure(ctx, error);
  } finally {
    ctx.close();
  }
}
