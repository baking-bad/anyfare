import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createPrompter } from '../src/prompt.ts';
import type { Prompter } from '../src/prompt.ts';
import { Stop } from '../src/util.ts';

/** A prompter on this input, and what it wrote. */
function prompterOn(input: PassThrough): { prompter: Prompter; out: () => string } {
  let out = '';
  const output = new PassThrough();
  output.on('data', (chunk: Buffer) => (out += chunk.toString()));
  return { prompter: createPrompter({ input, output }), out: () => out };
}

const settled = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('ask', () => {
  it('returns the trimmed line, or the fallback for an empty one', async () => {
    const input = new PassThrough();
    const { prompter, out } = prompterOn(input);
    input.write('  anyfare.near  \n\n');
    expect(await prompter.ask('Account')).toBe('anyfare.near');
    expect(await prompter.ask('Pair', 'BTC/USD')).toBe('BTC/USD');
    await settled();
    expect(out()).toBe('Account Pair [BTC/USD] ');
    prompter.close();
  });

  it('keeps a token or a hash in the answer as it is', async () => {
    const input = new PassThrough();
    const { prompter } = prompterOn(input);
    const line = `curl https://example.com/x -H 'Authorization: Bearer ${'a1b2c3d4'.repeat(8)}'`;
    input.write(`${line}\n`);
    expect(await prompter.ask('Request')).toBe(line);
    prompter.close();
  });

  it('stops when the input ends', async () => {
    const input = new PassThrough();
    const { prompter } = prompterOn(input);
    input.end();
    await expect(prompter.ask('Request')).rejects.toThrow(new Stop('No more input'));
    prompter.close();
  });
});

describe('confirm', () => {
  it('reads y, yes, n, no and the fallback', async () => {
    const input = new PassThrough();
    const { prompter } = prompterOn(input);
    input.write('y\nNO\n\n\nYes\n');
    expect(await prompter.confirm('One?', false)).toBe(true);
    expect(await prompter.confirm('Two?', true)).toBe(false);
    expect(await prompter.confirm('Three?', true)).toBe(true);
    expect(await prompter.confirm('Four?', false)).toBe(false);
    expect(await prompter.confirm('Five?', false)).toBe(true);
    prompter.close();
  });

  it('asks again after an answer that is neither, and stops after three', async () => {
    const input = new PassThrough();
    const { prompter, out } = prompterOn(input);
    input.write('maybe\nn\n');
    expect(await prompter.confirm('Sure?', true)).toBe(false);
    input.write('a\nb\nc\n');
    await expect(prompter.confirm('Sure?', true)).rejects.toThrow(new Stop('No valid answer'));
    await settled();
    expect(out()).toContain('Please answer y or n.\n');
    prompter.close();
  });
});

describe('the line queue', () => {
  it("keeps the lines piped in before a question: they are a script's answers", async () => {
    const input = new PassThrough();
    const { prompter } = prompterOn(input);
    input.write('first\nsecond\n');
    await settled();
    prompter.dropTypedAhead();
    expect(await prompter.ask('One')).toBe('first');
    expect(await prompter.ask('Two')).toBe('second');
    prompter.close();
  });

  it('drops the lines typed ahead on a terminal', async () => {
    const tty = Object.assign(new PassThrough(), { isTTY: true });
    const { prompter } = prompterOn(tty);
    tty.write('stray\n');
    await settled();
    prompter.dropTypedAhead();
    const answer = prompter.ask('One');
    tty.write('typed now\n');
    expect(await answer).toBe('typed now');
    prompter.close();
  });
});
