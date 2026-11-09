// askSecret: a secret read with the terminal's echo off, as the answer to its own question only, and
// never printed. Every secret here is made up.

import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { KEY_REFUSED, KEY_SHOWN, SECRET_STOPPED, createPrompter, looksLikeKey, typedSecret } from '../src/prompt.ts';
import type { Prompter } from '../src/prompt.ts';
import { Stop } from '../src/util.ts';
import { madeUpKey } from './fakeAnyfare.ts';
import { expectNoSecretIn, fakeTerminalInput } from './helpers.ts';
import type { FakeTerminalInput } from './helpers.ts';

const SECRET = 'made-up-secret-of-the-test';

/** A prompter on this input, and what it wrote. */
function prompterOn(input: PassThrough): { prompter: Prompter; out: () => string } {
  let out = '';
  const output = new PassThrough();
  output.on('data', (chunk: Buffer) => (out += chunk.toString()));
  return { prompter: createPrompter({ input, output }), out: () => out };
}

/** Types a text as a terminal in raw mode sends it: one key at a time. */
function typeKeys(tty: FakeTerminalInput, text: string): void {
  for (const key of text) tty.write(key);
}

/** Lets the output stream hand on what was written. */
const settled = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('askSecret without a terminal', () => {
  it('reads the next line as it is, trimmed, and prints only the question', async () => {
    const input = new PassThrough();
    const { prompter, out } = prompterOn(input);
    input.write(`  ${SECRET}  \nnext\n`);
    expect(await prompter.askSecret('Secret:')).toBe(SECRET);
    expect(await prompter.ask('Next?')).toBe('next');
    await settled();
    expect(out()).toBe('Secret: Next? ');
    prompter.close();
  });
});

describe('askSecret on a terminal', () => {
  it('turns raw mode on while the secret is typed and off after it, and prints nothing of it', async () => {
    const tty = fakeTerminalInput();
    const { prompter, out } = prompterOn(tty);
    const answer = prompter.askSecret('Secret:');
    expect(tty.modes).toEqual([true]);
    typeKeys(tty, `${SECRET}\r`);
    expect(await answer).toBe(SECRET);
    expect(tty.modes).toEqual([true, false]);
    await settled();
    // The question, and the line end the terminal did not echo: no character, no star
    expect(out()).toBe('Secret: \n');
    prompter.close();
  });

  it('takes the last character away on a backspace, DEL or BS', async () => {
    const tty = fakeTerminalInput();
    const { prompter } = prompterOn(tty);
    const answer = prompter.askSecret('Secret:');
    typeKeys(tty, 'madX\x7fe-uq\bp\r');
    expect(await answer).toBe('made-up');
    expect(typedSecret('ab\x7f\x7f\x7fcd')).toBe('cd');
    prompter.close();
  });

  it('stops at once on Ctrl-C, with raw mode off, and what was typed is no later answer', async () => {
    const tty = fakeTerminalInput();
    const { prompter, out } = prompterOn(tty);
    const answer = prompter.askSecret('Secret:');
    typeKeys(tty, 'made-up-part');
    // No Enter: Ctrl-C alone ends the question
    tty.write('\x03');
    await expect(answer).rejects.toThrow(new Stop(SECRET_STOPPED));
    expect(SECRET_STOPPED).toBe('Stopped. Nothing was saved.');
    expect(tty.modes).toEqual([true, false]);
    const next = prompter.ask('Next?');
    tty.write('n\n');
    expect(await next).toBe('n');
    await settled();
    expect(out()).toBe('Secret: \nNext? ');
    expect(out()).not.toContain('made');
    prompter.close();
  });

  it('never gives the secret as the answer to a later question, and keeps the Enter typed there', async () => {
    const tty = fakeTerminalInput();
    const { prompter } = prompterOn(tty);
    const answer = prompter.askSecret('Secret:');
    typeKeys(tty, `${SECRET}\r`);
    expect(await answer).toBe(SECRET);
    // Raw mode is off: Enter is a \n again, and is the answer to this question, not lost after the \r
    const next = prompter.ask('Next?', 'the fallback');
    tty.write('\n');
    expect(await next).toBe('the fallback');
    const sure = prompter.confirm('Sure?', false);
    tty.write('y\n');
    expect(await sure).toBe(true);
    prompter.close();
  });

  it('answers a hidden question with no line typed before it appeared', async () => {
    const tty = fakeTerminalInput();
    const { prompter } = prompterOn(tty);
    const answer = prompter.askSecret('Secret:');
    // Pasted with more after it, and a stray Enter
    tty.write(`${SECRET}\rmade-up-early\r\r`);
    expect(await answer).toBe(SECRET);
    const second = prompter.askSecret('Second:');
    let settledSecond = false;
    void second.then(() => (settledSecond = true));
    await settled();
    // The lines typed before the question appeared are dropped: it waits for one typed now
    expect(settledSecond).toBe(false);
    tty.write('made-up-now\r');
    expect(await second).toBe('made-up-now');
    expect(tty.modes).toEqual([true, false, true, false]);
    prompter.close();
  });

  it('sets raw mode back when the input ends while it asks', async () => {
    const tty = fakeTerminalInput();
    const { prompter } = prompterOn(tty);
    const answer = prompter.askSecret('Secret:');
    tty.end();
    await expect(answer).rejects.toThrow(new Stop('No more input'));
    expect(tty.modes).toEqual([true, false]);
    prompter.close();
  });

  it('leaves raw mode as it found it', async () => {
    const tty = fakeTerminalInput();
    tty.isRaw = true;
    const { prompter } = prompterOn(tty);
    const answer = prompter.askSecret('Secret:');
    typeKeys(tty, `${SECRET}\r`);
    expect(await answer).toBe(SECRET);
    expect(tty.modes).toEqual([true, true]);
    expect(tty.isRaw).toBe(true);
    prompter.close();
  });
});

describe('a visible question, answered with something that looks like a key', () => {
  // Made up, in the shapes of an Anyfare key, a wallet's private key and a NEAR key
  const keys = [madeUpKey('afm_live_'), madeUpKey('af_live_'), `0x${'a1b2c3d4'.repeat(8)}`, `ed25519:${'4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi'.repeat(2)}`];

  it('knows a key by its shape, and an answer that is none', () => {
    for (const key of keys) {
      expect(looksLikeKey(key)).toBe(true);
      expect(looksLikeKey(`  my key is ${key}`)).toBe(true);
    }
    // NEAR accounts with af_ inside them are valid answers, never keys
    for (const answer of ['y', 'BTC/USD', 'anyfare.near', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', '5', 'af_', 'safe_word', 'leaf_wallet.near', 'graf_finance.near', 'staff_payroll_operations_account.near']) {
      expect(looksLikeKey(answer)).toBe(false);
    }
  });

  it('refuses it at a yes-or-no question, never repeats it, and asks again', async () => {
    for (const key of keys) {
      const input = new PassThrough();
      const { prompter, out } = prompterOn(input);
      input.write(`${key}\nn\n`);
      expect(await prompter.confirm('Save to .env.local?', false)).toBe(false);
      await settled();
      // Piped in: nothing showed it on a screen
      expect(out()).toBe(`Save to .env.local? [y/N] ${KEY_REFUSED}; type y or n.\nSave to .env.local? [y/N] `);
      expectNoSecretIn(out(), [key]);
      prompter.close();
    }
  });

  it('says it showed on the screen when the terminal echoed it', async () => {
    const tty = fakeTerminalInput();
    const { prompter, out } = prompterOn(tty);
    const answer = prompter.confirm('Save to .env.local?', false);
    tty.write(`${keys[0]}\n`);
    tty.write('y\n');
    expect(await answer).toBe(true);
    await settled();
    expect(out()).toBe(
      "Save to .env.local? [y/N] That looks like a key. It was not used or saved; type y or n.\n" +
        'It showed on your screen: if it is real, revoke it and make a new one.\n' +
        'Save to .env.local? [y/N] ',
    );
    expect(KEY_SHOWN).toBe('It showed on your screen: if it is real, revoke it and make a new one.');
    prompter.close();
  });

  it('refuses it at a question that asks for a value or a number too', async () => {
    const input = new PassThrough();
    const { prompter, out } = prompterOn(input);
    input.write(`${keys[1]}\nETH/USD\n${keys[2]}\n2\n`);
    expect(await prompter.ask('Pair', 'BTC/USD')).toBe('ETH/USD');
    expect(await prompter.choose('Pick', [{ label: 'one', value: 1 }, { label: 'two', value: 2 }])).toBe(2);
    await settled();
    expect(out()).toContain(`${KEY_REFUSED}; type the answer again.\n`);
    expect(out()).toContain(`${KEY_REFUSED}; type a number from 1 to 2.\n`);
    expectNoSecretIn(out(), [keys[1] ?? '', keys[2] ?? '']);
    prompter.close();
  });

  it('stops after three answers that look like keys', async () => {
    const input = new PassThrough();
    const { prompter } = prompterOn(input);
    input.write(`${keys[0]}\n${keys[0]}\n${keys[0]}\n`);
    await expect(prompter.confirm('Sure?', false)).rejects.toThrow(new Stop('No valid answer'));
    prompter.close();
  });
});

describe('what a console can hide', () => {
  it('is hidden on a terminal, piped in a script, and echoed when only the output is a terminal', () => {
    expect(createPrompter({ input: fakeTerminalInput(), output: new PassThrough() }).secretInput()).toBe('hidden');
    expect(createPrompter({ input: new PassThrough(), output: new PassThrough() }).secretInput()).toBe('piped');
    const screen = Object.assign(new PassThrough(), { isTTY: true });
    expect(createPrompter({ input: new PassThrough(), output: screen }).secretInput()).toBe('echoed');
  });

  it("keeps the lines piped in before a question: they are a script's answers", async () => {
    const input = new PassThrough();
    const { prompter } = prompterOn(input);
    input.write(`${SECRET}\nsecond\n`);
    await settled();
    prompter.dropTypedAhead();
    expect(await prompter.askSecret('Secret:')).toBe(SECRET);
    expect(await prompter.askSecret('Second:')).toBe('second');
    prompter.close();
  });
});
