import { parseArgs } from 'node:util';
import type { Readable, Writable } from 'node:stream';
import type { Fetch } from './http.ts';
import { createStyle } from './style.ts';
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

export type Command =
  | { readonly kind: 'interactive' }
  | { readonly kind: 'help' }
  | {
      readonly kind: 'call';
      readonly args: ToolArgs;
      readonly pay: PayWay;
      readonly explain: boolean;
      readonly yes: boolean;
    }
  | { readonly kind: 'explain'; readonly args: ToolArgs }
  | { readonly kind: 'signup'; readonly yes: boolean }
  | {
      readonly kind: 'key-create';
      readonly label: string;
      readonly daily: string;
      readonly maxPrice: string;
      readonly yes: boolean;
    }
  | { readonly kind: 'balance' }
  | {
      readonly kind: 'topup';
      readonly network: string;
      readonly token: string;
      readonly amount: string;
      readonly yes: boolean;
    };

export interface Io {
  readonly stdout: Writable;
  readonly stderr: Writable;
  readonly stdin: Readable;
  /** True when both stdin and stdout are terminals. */
  readonly isTerminal: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetch: Fetch;
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
} as const;

type Flags = Partial<Record<keyof typeof OPTIONS, string | boolean>>;

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
      return { tool, pair: get('pair', 'BTC/USD') };
    case '3route':
      return {
        tool,
        chain: get('chain', 'base'),
        from: get('from', 'USDC'),
        to: get('to', 'WETH'),
        amount: get('amount', '1'),
      };
    case 'evidence':
      return { tool, account: get('account', 'anyfare.near') };
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

/** Turns the arguments into a command, or throws a `UsageError`. */
export function parseCommand(argv: readonly string[]): Command {
  if (argv.includes('--help') || argv.includes('-h')) return { kind: 'help' };

  const { positionals, flags } = parseFlags(argv);
  for (const [flag, value] of Object.entries(flags)) {
    if (value === '') throw new UsageError(`--${flag} needs a value`);
  }

  const [command, ...rest] = positionals;
  if (command === undefined) {
    if (Object.keys(flags).length === 0) return { kind: 'interactive' };
    throw new UsageError('Name a command. See --help');
  }

  const yes = bool(flags, 'yes');
  const extra = (count: number): void => {
    if (rest.length > count) throw new UsageError(`Unexpected argument: ${rest[count]}`);
  };

  switch (command) {
    case 'call': {
      extra(0);
      rejectOther('call', flags, ['tool', 'pay', 'explain', 'yes', ...Object.values(TOOL_FLAGS).flat()]);
      const args = toolArgs('call', flags);
      const pay = requireChoice('call', flags, 'pay', PAY_WAYS);
      return { kind: 'call', args, pay, explain: bool(flags, 'explain'), yes };
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
      if (rest[0] !== 'create') throw new UsageError('key needs the word create: key create');
      extra(1);
      rejectOther('key create', flags, ['label', 'daily', 'max-price', 'yes']);
      return {
        kind: 'key-create',
        label: str(flags, 'label') ?? 'demo',
        daily: usdFlag(flags, 'daily', '1'),
        maxPrice: usdFlag(flags, 'max-price', '0.02'),
        yes,
      };
    }
    case 'balance':
      extra(0);
      rejectOther('balance', flags, []);
      return { kind: 'balance' };
    case 'topup': {
      extra(0);
      rejectOther('topup', flags, ['network', 'token', 'amount', 'yes']);
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
      return { kind: 'topup', network, token, amount, yes };
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
  balance                            Show the Credits balance.
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
  --explain  Show the plan and the price before the call.
  --yes      Do not ask for confirmation.
  --help     Show this help.

Settings come from .env, then .env.local, then the shell. The last one wins.
  ANYFARE_API_URL    The Platform API address.
  ANYFARE_PAY_URL    The proxy address.
  MAX_PAYMENT_USD    The most one call may cost, in US dollars. Default 0.02.

Exit codes:
  0  Success.
  1  The command failed in an expected way.
  2  Bad usage.
`;

type Handler<K extends Command['kind']> = (command: Extract<Command, { kind: K }>, io: Io) => Promise<number>;

const COMMAND_NAMES: Record<Command['kind'], string> = {
  interactive: 'interactive mode',
  help: 'help',
  call: 'call',
  explain: 'explain',
  signup: 'signup',
  'key-create': 'key create',
  balance: 'balance',
  topup: 'topup',
};

function notBuilt(kind: Command['kind']): never {
  throw new Stop(`${COMMAND_NAMES[kind]} is not built yet`);
}

/** One handler per command kind. A later task replaces a stub in one place. */
const HANDLERS: { [K in Command['kind']]: Handler<K> } = {
  help: async (_command, io) => {
    io.stdout.write(HELP_TEXT);
    return 0;
  },
  interactive: async (_command, io) => {
    if (!io.isTerminal) {
      throw new UsageError('Interactive mode needs a terminal. Name a command; see --help');
    }
    return notBuilt('interactive');
  },
  call: async () => notBuilt('call'),
  explain: async () => notBuilt('explain'),
  signup: async () => notBuilt('signup'),
  'key-create': async () => notBuilt('key-create'),
  balance: async () => notBuilt('balance'),
  topup: async () => notBuilt('topup'),
};

async function dispatch(command: Command, io: Io): Promise<number> {
  const handler = HANDLERS[command.kind] as (command: Command, io: Io) => Promise<number>;
  return handler(command, io);
}

/** Runs the app and returns the exit code: 0 success, 1 expected failure, 2 bad usage. */
export async function runCli(argv: readonly string[], io: Io): Promise<number> {
  const style = createStyle(io.stderr);
  try {
    return await dispatch(parseCommand(argv), io);
  } catch (error) {
    if (error instanceof Stop) {
      io.stderr.write(`${style.fail(error.line())}\n`);
      return error instanceof UsageError ? 2 : 1;
    }
    const message = error instanceof Error ? error.message : String(error);
    io.stderr.write(`${style.fail(message)}\n`);
    return 1;
  }
}
