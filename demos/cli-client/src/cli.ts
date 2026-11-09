import { parseArgs } from 'node:util';
import type { Readable, Writable } from 'node:stream';
import { createPaymentKey, keySettings, keyShapeProblem, saveKeys, showBalance, signUp } from './account.ts';
import type { FlagKeys, KeyKind } from './account.ts';
import { createContext } from './context.ts';
import type { Context } from './context.ts';
import { runCall } from './call.ts';
import { hideKeys } from './errors.ts';
import { explainHeader, explainLines, planFailure, readPlan } from './explain.ts';
import { loadConfig } from './config.ts';
import type { Fetch } from './http.ts';
import { createStyle } from './style.ts';
import { DEFAULT_ARGS, TOOLS as IMPLEMENTATIONS } from './tools/index.ts';
import { runInteractive } from './interactive.ts';
import { DEFAULT_TIMING, runTopup } from './topup.ts';
import type { TopupHooks } from './topup.ts';
import { Stop, UsageError, toAtomic } from './util.ts';

export type Tool = 'cmc' | '3route' | 'evidence';
export type PayWay = 'credits' | 'near' | 'base' | 'tempo';

export type ToolArgs =
  | { readonly tool: 'cmc'; readonly pair: string }
  | {
      readonly tool: '3route';
      readonly chain: string;
      readonly from: string;
      readonly to: string;
      readonly amount: string;
    }
  | { readonly tool: 'evidence'; readonly account: string };

/** `keys`: the Anyfare keys given as flags, for this run only. Absent when none was given. */
export type Command =
  | { readonly kind: 'interactive'; readonly keys?: FlagKeys }
  | { readonly kind: 'help' }
  | {
      readonly kind: 'call';
      readonly args: ToolArgs;
      readonly pay: PayWay;
      readonly explain: boolean;
      readonly yes: boolean;
      readonly keys?: FlagKeys;
    }
  | { readonly kind: 'explain'; readonly args: ToolArgs }
  | { readonly kind: 'signup'; readonly yes: boolean }
  | {
      readonly kind: 'key-create';
      readonly label: string;
      readonly daily: string;
      readonly maxPrice: string;
      readonly yes: boolean;
      readonly keys?: FlagKeys;
    }
  | { readonly kind: 'key-save'; readonly yes: boolean; readonly keys?: FlagKeys }
  | { readonly kind: 'balance'; readonly keys?: FlagKeys }
  | {
      readonly kind: 'topup';
      readonly network: string;
      readonly token: string;
      readonly amount: string;
      readonly yes: boolean;
      readonly keys?: FlagKeys;
    };

export interface Io {
  readonly stdout: Writable;
  readonly stderr: Writable;
  readonly stdin: Readable;
  /** True when both stdin and stdout are terminals. */
  readonly isTerminal: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetch: Fetch;
  /** The app's directory, where `.env.local` is. The app writes nowhere else. */
  readonly appDir: string;
  /** How a top-up waits and hears Ctrl-C. Left out, it polls every 5 seconds and listens on the process. */
  readonly topup?: TopupHooks;
}

const TOOLS: readonly Tool[] = ['cmc', '3route', 'evidence'];
const PAY_WAYS: readonly PayWay[] = ['credits', 'near', 'base', 'tempo'];

const OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  yes: { type: 'boolean' },
  explain: { type: 'boolean' },
  tool: { type: 'string' },
  pay: { type: 'string' },
  pair: { type: 'string' },
  chain: { type: 'string' },
  from: { type: 'string' },
  to: { type: 'string' },
  amount: { type: 'string' },
  account: { type: 'string' },
  label: { type: 'string' },
  daily: { type: 'string' },
  'max-price': { type: 'string' },
  network: { type: 'string' },
  token: { type: 'string' },
  'master-key': { type: 'string' },
  'payment-key': { type: 'string' },
} as const;

const KEY_FLAGS: readonly string[] = ['master-key', 'payment-key'];

type Flags = Partial<Record<keyof typeof OPTIONS, string | boolean>>;

/** The longest label Anyfare takes for a payment key. */
const MAX_LABEL_LENGTH = 60;

const TOOL_FLAGS: Record<Tool, readonly string[]> = {
  cmc: ['pair'],
  '3route': ['chain', 'from', 'to', 'amount'],
  evidence: ['account'],
};

function list(choices: readonly string[]): string {
  return choices.length < 2
    ? (choices[0] ?? '')
    : `${choices.slice(0, -1).join(', ')} or ${choices[choices.length - 1]}`;
}

function parseFlags(argv: readonly string[]): { positionals: string[]; flags: Flags } {
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      options: OPTIONS,
      allowPositionals: true,
      strict: true,
    });
    return { positionals, flags: values };
  } catch (error) {
    const code = (error as { code?: string }).code;
    const text = error instanceof Error ? error.message : '';
    const flag = /'(-{1,2}[A-Za-z0-9-]+)/.exec(text)?.[1];
    if (code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
      throw new UsageError(`Unknown option ${flag ?? ''}. See --help`.replace('  ', ' '));
    }
    if (code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') {
      throw new UsageError(
        flag === undefined ? 'An option is missing its value. See --help' : `${flag} needs a value`,
      );
    }
    throw new UsageError('Could not read the arguments. See --help');
  }
}

function str(flags: Flags, name: keyof typeof OPTIONS): string | undefined {
  const value = flags[name];
  return typeof value === 'string' ? value : undefined;
}

function bool(flags: Flags, name: keyof typeof OPTIONS): boolean {
  return flags[name] === true;
}

function rejectOther(name: string, flags: Flags, allowed: readonly string[]): void {
  for (const flag of Object.keys(flags)) {
    if (!allowed.includes(flag)) throw new UsageError(`${name} doesn't take --${flag}`);
  }
}

function requireChoice<T extends string>(
  name: string,
  flags: Flags,
  flag: 'tool' | 'pay',
  choices: readonly T[],
): T {
  const value = str(flags, flag);
  if (value === undefined) throw new UsageError(`${name} needs --${flag}: ${list(choices)}`);
  const found = choices.find((choice) => choice === value);
  if (found === undefined) {
    throw new UsageError(`--${flag} must be ${list(choices)}, not "${value}"`);
  }
  return found;
}

function toolArgs(name: string, flags: Flags): ToolArgs {
  const tool = requireChoice(name, flags, 'tool', TOOLS);
  for (const other of TOOLS) {
    if (other === tool) continue;
    for (const flag of TOOL_FLAGS[other]) {
      if (flags[flag as keyof typeof OPTIONS] !== undefined) {
        throw new UsageError(`--${flag} is for --tool ${other}, not --tool ${tool}`);
      }
    }
  }
  const get = (flag: keyof typeof OPTIONS, fallback: string): string => str(flags, flag) ?? fallback;
  switch (tool) {
    case 'cmc':
      return { tool, pair: get('pair', DEFAULT_ARGS.cmc.pair) };
    case '3route': {
      const defaults = DEFAULT_ARGS['3route'];
      return {
        tool,
        chain: get('chain', defaults.chain),
        from: get('from', defaults.from),
        to: get('to', defaults.to),
        amount: get('amount', defaults.amount),
      };
    }
    case 'evidence':
      return { tool, account: get('account', DEFAULT_ARGS.evidence.account) };
  }
}

function usdFlag(flags: Flags, flag: 'daily' | 'max-price', fallback: string): string {
  const value = str(flags, flag) ?? fallback;
  try {
    toAtomic(value, 6);
  } catch (error) {
    throw new UsageError(`--${flag}: ${error instanceof Stop ? error.message : 'not an amount'}`);
  }
  return value;
}

function requireValue(name: string, flags: Flags, flag: 'network' | 'token' | 'amount'): string {
  const value = str(flags, flag);
  if (value === undefined) throw new UsageError(`${name} needs --${flag}`);
  return value;
}

/**
 * The key flags' values, each checked for its shape before any request: a master key where a payment
 * key belongs, or the other way round, is a `UsageError` that names the flag and never quotes it.
 */
function keyFlags(flags: Flags): FlagKeys | undefined {
  const read = (flag: 'master-key' | 'payment-key', kind: KeyKind): string | undefined => {
    const value = str(flags, flag)?.trim();
    if (value === undefined) return undefined;
    const problem = keyShapeProblem(value, kind);
    if (problem !== undefined) throw new UsageError(`--${flag} ${problem}`);
    return value;
  };
  const master = read('master-key', 'master');
  const payment = read('payment-key', 'payment');
  if (master === undefined && payment === undefined) return undefined;
  return { ...(master !== undefined && { master }), ...(payment !== undefined && { payment }) };
}

/** The command, with the key flags when any was given. */
function keyed<T extends Command>(command: T, flags: Flags): T {
  const keys = keyFlags(flags);
  return keys === undefined ? command : { ...command, keys };
}

/** Turns the arguments into a command, or throws a `UsageError`. */
export function parseCommand(argv: readonly string[]): Command {
  if (argv.includes('--help') || argv.includes('-h')) return { kind: 'help' };

  const { positionals, flags } = parseFlags(argv);
  for (const [flag, value] of Object.entries(flags)) {
    if (value === '') throw new UsageError(`--${flag} needs a value`);
  }

  const [command, ...rest] = positionals;
  if (command === undefined) {
    const names = Object.keys(flags);
    if (names.length === 0) return { kind: 'interactive' };
    // The interactive mode takes the keys for its run, and nothing else
    if (!names.some((name) => KEY_FLAGS.includes(name))) throw new UsageError('Name a command. See --help');
    rejectOther('The interactive mode', flags, KEY_FLAGS);
    return keyed({ kind: 'interactive' }, flags);
  }

  const yes = bool(flags, 'yes');
  const extra = (count: number): void => {
    if (rest.length > count) throw new UsageError(`Unexpected argument: ${rest[count]}`);
  };

  switch (command) {
    case 'call': {
      extra(0);
      rejectOther('call', flags, ['tool', 'pay', 'explain', 'yes', 'payment-key', ...Object.values(TOOL_FLAGS).flat()]);
      const args = toolArgs('call', flags);
      const pay = requireChoice('call', flags, 'pay', PAY_WAYS);
      // Only Credits pay with the payment key
      if (pay !== 'credits' && flags['payment-key'] !== undefined) {
        throw new UsageError(`--payment-key is for --pay credits, not --pay ${pay}`);
      }
      return keyed({ kind: 'call', args, pay, explain: bool(flags, 'explain'), yes }, flags);
    }
    case 'explain':
      extra(0);
      rejectOther('explain', flags, ['tool', ...Object.values(TOOL_FLAGS).flat()]);
      return { kind: 'explain', args: toolArgs('explain', flags) };
    case 'signup':
      extra(0);
      rejectOther('signup', flags, ['yes']);
      return { kind: 'signup', yes };
    case 'key': {
      if (rest[0] === 'save') {
        extra(1);
        rejectOther('key save', flags, ['master-key', 'payment-key', 'yes']);
        return keyed({ kind: 'key-save', yes }, flags);
      }
      if (rest[0] !== 'create') throw new UsageError('key needs the word create or save: key create, or key save');
      extra(1);
      rejectOther('key create', flags, ['label', 'daily', 'max-price', 'yes', 'master-key']);
      const label = str(flags, 'label') ?? 'demo';
      if (label.length > MAX_LABEL_LENGTH) {
        throw new UsageError(`--label is at most ${MAX_LABEL_LENGTH} characters`);
      }
      return keyed(
        {
          kind: 'key-create',
          label,
          daily: usdFlag(flags, 'daily', '1'),
          maxPrice: usdFlag(flags, 'max-price', '0.02'),
          yes,
        },
        flags,
      );
    }
    case 'balance':
      extra(0);
      rejectOther('balance', flags, KEY_FLAGS);
      return keyed({ kind: 'balance' }, flags);
    case 'topup': {
      extra(0);
      rejectOther('topup', flags, ['network', 'token', 'amount', 'yes', 'master-key']);
      const network = requireValue('topup', flags, 'network');
      const token = requireValue('topup', flags, 'token');
      const amount = requireValue('topup', flags, 'amount');
      let atomic: bigint;
      try {
        atomic = toAtomic(amount, 36);
      } catch (error) {
        throw new UsageError(`--amount: ${error instanceof Stop ? error.message : 'not an amount'}`);
      }
      if (atomic === 0n) throw new UsageError('--amount must be more than zero');
      return keyed({ kind: 'topup', network, token, amount, yes }, flags);
    }
    default:
      throw new UsageError(`Unknown command: ${command}. See --help`);
  }
}

export const HELP_TEXT = `Anyfare demo: call paid APIs through Anyfare.

Usage:
  npm run demo -- <command> [flags]
  npm run demo                       No command starts the interactive mode.

Commands:
  call --tool <tool> --pay <way> [data flags] [--explain] [--yes]
                                     Make one paid call.
  explain --tool <tool> [data flags] Show what a call would do and cost. Free.
  signup [--yes]                     Create an Anyfare account and its master key.
  key create [--label demo] [--daily 1] [--max-price 0.02] [--yes]
                                     Create a payment key. Amounts are in US dollars.
  key save [--yes]                   Check keys you have, for free, and save them to .env.local.
                                     On a terminal, it asks for them and shows nothing you type.
  balance                            Show the Credits balance, and the balance of each wallet.
  topup --network <n> --token <t> --amount <a> [--yes]
                                     Add Credits. Works only when the Anyfare it talks to has top-ups.
  --help, -h                         Show this help.

Tools:
  cmc        CoinMarketCap              --pair BTC/USD
  3route     3Route                     --chain base --from USDC --to WETH --amount 1
  evidence   The evidence API on NEAR   --account anyfare.near
  The values shown are the defaults.

Ways to pay (--pay):
  credits    Prepaid Credits
  near       USDC on NEAR
  base       USDC on Base
  tempo      USDC.e on Tempo

Flags:
  --explain               Show the plan and the price before the call.
  --yes                   Do not ask for confirmation.
  --master-key <afm_…>    The master key, for this run only: key create, balance, topup, key save.
  --payment-key <af_…>    The payment key, for this run only: call --pay credits, balance, key save.
                          With no command, either one starts the interactive mode with that key.
                          A key in a flag wins over the settings, and is not saved but by key save.
  A key in a flag shows on screen and in npm's log, your shell's history and the process list. Use .env.local or key save. If you must, run node directly: node --env-file-if-exists=.env --env-file-if-exists=.env.local src/main.ts --payment-key …
  --help                  Show this help.

Settings come from .env, then .env.local, then the shell. The last one wins.
  ANYFARE_API_URL    The Platform API address.
  ANYFARE_PAY_URL    The proxy address.
  MAX_PAYMENT_USD    The most one call may cost, in US dollars. Default 0.02.
Wallets for --pay base, --pay near and --pay tempo, in .env.local only:
  BASE_PRIVATE_KEY   The key of the wallet that pays USDC on Base: 0x and 64 hex digits.
  BASE_RPC_URL       A Base RPC to read the wallet's balance from. Optional.
  NEAR_ACCOUNT_ID    The NEAR account that pays USDC on NEAR, such as name.near.
  NEAR_PRIVATE_KEY   A full-access key of that account: ed25519: and base58.
  NEAR_RPC_URL       A NEAR RPC to read the account from. Optional.
  TEMPO_PRIVATE_KEY  The key of the wallet that pays USDC.e on Tempo: 0x and 64 hex digits.
  TEMPO_RPC_URL      A Tempo RPC to read fees and gas from. Optional.

Exit codes:
  0  Success.
  1  The command failed in an expected way.
  2  Bad usage.
`;

type Handler<K extends Command['kind']> = (command: Extract<Command, { kind: K }>, ctx: Context) => Promise<number>;

/** One handler per command kind. A later task replaces a stub in one place. */
const HANDLERS: { [K in Command['kind']]: Handler<K> } = {
  help: async (_command, { io }) => {
    io.stdout.write(HELP_TEXT);
    return 0;
  },
  interactive: async (_command, ctx) => {
    if (!ctx.io.isTerminal) {
      throw new UsageError('Interactive mode needs a terminal. Name a command; see --help');
    }
    return runInteractive(ctx);
  },
  call: async (command, ctx) => runCall(ctx, command),
  explain: async (command, { io, session }) => {
    const config = loadConfig(session.env);
    const prepared = await IMPLEMENTATIONS[command.args.tool].prepare(command.args, { fetch: io.fetch });
    const plan = await readPlan({ fetch: io.fetch, config, prepared });
    const style = createStyle(io.stdout);
    io.stdout.write(`${[...explainHeader(plan, style), ...explainLines(plan, undefined, style)].join('\n')}\n`);
    const failure = planFailure(plan);
    if (failure !== undefined) throw new Stop(failure);
    return 0;
  },
  signup: async (command, ctx) => {
    await signUp(ctx, { yes: command.yes });
    ctx.print('Next: npm run demo -- key create');
    return 0;
  },
  'key-create': async (command, ctx) => {
    await createPaymentKey(ctx, command);
    return 0;
  },
  'key-save': async (command, ctx) => {
    await saveKeys(ctx, { yes: command.yes, ...(command.keys !== undefined && { keys: command.keys }) });
    return 0;
  },
  balance: async (_command, ctx) => {
    await showBalance(ctx);
    return 0;
  },
  topup: async (command, ctx) =>
    (await runTopup(ctx, command, ctx.io.topup?.timing ?? DEFAULT_TIMING, ctx.io.topup?.signals === undefined ? {} : { signals: ctx.io.topup.signals })).credited
      ? 0
      : 1,
};

async function dispatch(command: Command, ctx: Context): Promise<number> {
  const handler = HANDLERS[command.kind] as (command: Command, ctx: Context) => Promise<number>;
  return handler(command, ctx);
}

/** What stderr says first when the command line holds a key. */
export const FLAG_KEY_WARNING =
  "A key from a flag can show in npm's output and log, your shell's history and the process list. Prefer key save.";

/** Whether the command line gives a key flag a value, as `--payment-key <key>` or `--payment-key=<key>`. */
function keyOnCommandLine(argv: readonly string[]): boolean {
  for (let at = 0; at < argv.length; at += 1) {
    const arg = argv[at] ?? '';
    // After --, everything is a positional
    if (arg === '--') return false;
    for (const flag of ['--master-key', '--payment-key']) {
      const next = argv[at + 1];
      if (arg === flag && next !== undefined && next !== '' && !next.startsWith('-')) return true;
      if (arg.startsWith(`${flag}=`) && arg.length > flag.length + 1) return true;
    }
  }
  return false;
}

/** Runs the app and returns the exit code: 0 success, 1 expected failure, 2 bad usage. */
export async function runCli(argv: readonly string[], io: Io): Promise<number> {
  const style = createStyle(io.stderr);
  // Before anything else, whatever the command line does next: the key is out already
  if (keyOnCommandLine(argv)) io.stderr.write(`${style.styles.warn(FLAG_KEY_WARNING)}\n`);
  let ctx: Context | undefined;
  try {
    const command = parseCommand(argv);
    // A key given as a flag wins over the settings, for this run only
    const keys = 'keys' in command ? keySettings(command.keys) : {};
    ctx = createContext({ ...io, env: { ...io.env, ...keys } });
    return await dispatch(command, ctx);
  } catch (error) {
    if (error instanceof Stop) {
      io.stderr.write(`${style.fail(hideKeys(error.line()))}\n`);
      return error instanceof UsageError ? 2 : 1;
    }
    const message = error instanceof Error ? error.message : String(error);
    io.stderr.write(`${style.fail(hideKeys(message))}\n`);
    return 1;
  } finally {
    ctx?.close();
  }
}
