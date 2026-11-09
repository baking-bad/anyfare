import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { parseCommand, runCli } from '../src/cli.ts';
import type { Io } from '../src/cli.ts';
import { createPrompter } from '../src/prompt.ts';
import { Stop, UsageError } from '../src/util.ts';

const parse = (line: string) => parseCommand(line === '' ? [] : line.split(' '));

function usageMessage(line: string): string {
  try {
    parse(line);
  } catch (error) {
    expect(error).toBeInstanceOf(UsageError);
    return (error as UsageError).message;
  }
  throw new Error(`Expected a usage error for: ${line}`);
}

describe('parseCommand', () => {
  it('parses call with the defaults of each tool', () => {
    expect(parse('call --tool cmc --pair BTC/USD --pay credits')).toEqual({
      kind: 'call',
      args: { tool: 'cmc', pair: 'BTC/USD' },
      pay: 'credits',
      explain: false,
      yes: false,
    });
    expect(parse('call --tool 3route --pay near')).toMatchObject({
      args: { tool: '3route', chain: 'base', from: 'USDC', to: 'WETH', amount: '1' },
      pay: 'near',
    });
    expect(parse('call --tool evidence --account anyfare.near --pay base --explain --yes')).toEqual({
      kind: 'call',
      args: { tool: 'evidence', account: 'anyfare.near' },
      pay: 'base',
      explain: true,
      yes: true,
    });
    expect(parse('call --tool cmc --pay tempo')).toMatchObject({ args: { pair: 'BTC/USD' }, pay: 'tempo' });
  });

  it('parses 3route with every flag', () => {
    expect(
      parse('call --tool 3route --chain base --from USDC --to WETH --amount 1 --pay near'),
    ).toMatchObject({ args: { tool: '3route', chain: 'base', from: 'USDC', to: 'WETH', amount: '1' } });
  });

  it('parses explain, signup, balance and topup', () => {
    expect(parse('explain --tool cmc --pair BTC/USD')).toEqual({
      kind: 'explain',
      args: { tool: 'cmc', pair: 'BTC/USD' },
    });
    expect(parse('signup')).toEqual({ kind: 'signup', yes: false });
    expect(parse('signup --yes')).toEqual({ kind: 'signup', yes: true });
    expect(parse('balance')).toEqual({ kind: 'balance' });
    expect(parse('topup --network base --token USDC --amount 5')).toEqual({
      kind: 'topup',
      network: 'base',
      token: 'USDC',
      amount: '5',
      yes: false,
    });
  });

  it('parses key create with and without flags', () => {
    expect(parse('key create --label demo --daily 1 --max-price 0.02')).toEqual({
      kind: 'key-create',
      label: 'demo',
      daily: '1',
      maxPrice: '0.02',
      yes: false,
    });
    expect(parse('key create --yes')).toEqual({
      kind: 'key-create',
      label: 'demo',
      daily: '1',
      maxPrice: '0.02',
      yes: true,
    });
  });

  it('lets --help win anywhere, and no arguments mean interactive', () => {
    expect(parse('--help')).toEqual({ kind: 'help' });
    expect(parse('-h')).toEqual({ kind: 'help' });
    expect(parse('call --tool nope --help')).toEqual({ kind: 'help' });
    expect(parse('--bogus -h')).toEqual({ kind: 'help' });
    expect(parse('')).toEqual({ kind: 'interactive' });
  });

  it('refuses bad usage with a plain message', () => {
    expect(usageMessage('call --tool cmc')).toBe('call needs --pay: credits, near, base or tempo');
    expect(usageMessage('call --pay near')).toBe('call needs --tool: cmc, 3route or evidence');
    expect(usageMessage('call --tool cmc --pay card')).toBe(
      '--pay must be credits, near, base or tempo, not "card"',
    );
    expect(usageMessage('call --tool nope --pay near')).toBe(
      '--tool must be cmc, 3route or evidence, not "nope"',
    );
    expect(usageMessage('call --tool evidence --pair BTC/USD --pay near')).toBe(
      '--pair is for --tool cmc, not --tool evidence',
    );
    expect(usageMessage('signup --pay near')).toBe("signup doesn't take --pay");
    expect(usageMessage('balance --yes')).toBe("balance doesn't take --yes");
    expect(usageMessage('key --label x')).toBe('key needs the word create: key create');
    expect(usageMessage('key create --pay near')).toBe("key create doesn't take --pay");
    expect(usageMessage('--yes')).toBe('Name a command. See --help');
    expect(usageMessage('fly')).toBe('Unknown command: fly. See --help');
    expect(usageMessage('balance now')).toBe('Unexpected argument: now');
    expect(usageMessage('call --bogus')).toBe('Unknown option --bogus. See --help');
    expect(usageMessage('explain --tool cmc --pair')).toBe('--pair needs a value');
    expect(usageMessage('key create --max-price 1e3')).toBe(
      '--max-price: Not a plain decimal amount: "1e3"',
    );
    expect(usageMessage('topup --network base --token USDC')).toBe('topup needs --amount');
    expect(usageMessage('topup --network base --token USDC --amount 0')).toBe(
      '--amount must be more than zero',
    );
  });

  it('refuses an empty value', () => {
    expect(() => parseCommand(['explain', '--tool', 'cmc', '--pair', ''])).toThrow('--pair needs a value');
  });
});

function fakeIo(isTerminal: boolean): { io: Io; out: () => string; err: () => string } {
  let out = '';
  let err = '';
  const sink = (append: (text: string) => void) =>
    new Writable({
      write(chunk: Buffer, _encoding, done) {
        append(chunk.toString());
        done();
      },
    });
  const io: Io = {
    stdout: sink((text) => (out += text)),
    stderr: sink((text) => (err += text)),
    stdin: new PassThrough(),
    isTerminal,
    env: {},
  };
  return { io, out: () => out, err: () => err };
}

describe('runCli', () => {
  it('prints the help and returns 0', async () => {
    const fake = fakeIo(false);
    expect(await runCli(['--help'], fake.io)).toBe(0);
    for (const word of ['call', 'explain', 'signup', 'key create', 'balance', 'topup', 'MAX_PAYMENT_USD']) {
      expect(fake.out()).toContain(word);
    }
    expect(fake.err()).toBe('');
  });

  it('returns 2 and one failure line for bad usage', async () => {
    const fake = fakeIo(false);
    expect(await runCli(['call', '--tool', 'cmc'], fake.io)).toBe(2);
    expect(fake.err()).toBe('✘ call needs --pay: credits, near, base or tempo\n');
    expect(fake.out()).toBe('');
  });

  it('returns 1 for a command that is not built yet', async () => {
    const fake = fakeIo(false);
    expect(await runCli(['balance'], fake.io)).toBe(1);
    expect(fake.err()).toBe('✘ balance is not built yet\n');
  });

  it('returns 2 for interactive mode without a terminal', async () => {
    const fake = fakeIo(false);
    expect(await runCli([], fake.io)).toBe(2);
    expect(fake.err()).toBe('✘ Interactive mode needs a terminal. Name a command; see --help\n');
  });

  it('returns 1 for interactive mode on a terminal, which is not built yet', async () => {
    const fake = fakeIo(true);
    expect(await runCli([], fake.io)).toBe(1);
    expect(fake.err()).toContain('not built yet');
  });
});

describe('createPrompter', () => {
  it('keeps piped lines that arrive before the questions', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const prompter = createPrompter({ input, output });
    input.write('hello\n2\nyes\n');
    input.end();
    await new Promise((resolve) => setImmediate(resolve));

    expect(await prompter.ask('Name?', 'x')).toBe('hello');
    expect(await prompter.choose('Pick', [
      { label: 'one', value: 'a' },
      { label: 'two', value: 'b', note: 'second' },
    ])).toBe('b');
    expect(await prompter.confirm('Sure?', false)).toBe(true);
    await expect(prompter.ask('More?')).rejects.toThrow(new Stop('No more input'));
    prompter.close();
  });

  it('uses the fallback on an empty answer and stops after three wrong choices', async () => {
    const input = new PassThrough();
    const prompter = createPrompter({ input, output: new PassThrough() });
    input.write('\n\nx\n9\n0\n');
    input.end();
    expect(await prompter.ask('Q?', 'fallback')).toBe('fallback');
    expect(await prompter.confirm('Sure?', true)).toBe(true);
    await expect(prompter.choose('Pick', [{ label: 'one', value: 1 }])).rejects.toThrow('No valid choice');
    prompter.close();
  });
});
