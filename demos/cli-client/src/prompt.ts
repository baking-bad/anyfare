import { createInterface } from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';
import { Stop } from './util.ts';

export interface Option<T> {
  readonly label: string;
  readonly value: T;
  readonly note?: string;
}

export interface Prompter {
  ask(question: string, fallback?: string): Promise<string>;
  /**
   * Asks for a secret, read as the answer to this one question from the session's one line queue, and
   * trimmed. On a terminal, raw mode is on while it is typed, so the terminal echoes nothing, and the
   * app prints nothing of it either; raw mode is set back after, also on an error or Ctrl-C. A
   * backspace takes the last character away; Ctrl-C stops, with `SECRET_STOPPED`. Without a terminal,
   * the next line as it is. On a terminal, a line typed before the question appeared answers nothing.
   */
  askSecret(question: string): Promise<string>;
  /**
   * Whether a secret's answer can be kept off the screen: `hidden` on a terminal, `piped` when neither
   * the input nor the output is a terminal (a script), `echoed` when the input is not a terminal but
   * the output is, as in a console that shows what is typed and can't be told not to.
   */
  secretInput(): 'hidden' | 'piped' | 'echoed';
  /**
   * On a terminal, drops the lines typed before the next question appeared: a stray Enter answers
   * nothing. Piped lines are kept: they are a script's answers, in order.
   */
  dropTypedAhead(): void;
  choose<T>(title: string, options: readonly Option<T>[]): Promise<T>;
  confirm(question: string, fallback: boolean): Promise<boolean>;
  /**
   * Waits for the person to press Enter, without asking a question. `pressed` is true when a line
   * came, and never settles while the input stays open and quiet. `cancel` ends the wait: a line that
   * comes later is kept for the next question, not taken.
   */
  waitForEnter(): { readonly pressed: Promise<boolean>; cancel(): void };
  close(): void;
}

const MAX_TRIES = 3;

/** What Ctrl-C at a secret's question says. */
export const SECRET_STOPPED = 'Stopped. Nothing was saved.';

const CTRL_C = '\x03';

/** What a visible question says to an answer that looks like a key, before it asks again. */
export const KEY_REFUSED = 'That looks like a key. It was not used or saved';
/** And when the answer showed as it was typed. */
export const KEY_SHOWN = 'It showed on your screen: if it is real, revoke it and make a new one.';

/** An Anyfare key, a wallet's private key of `0x` and 64 hex digits, or a NEAR key: anywhere in a text. */
// An Anyfare key is its prefix, such as af_live_, then a long base62 body. Anchored at the start of a word,
// so a NEAR account such as leaf_wallet.near is not taken for one
const KEY_LIKE = /(?<![A-Za-z0-9_.-])afm?_[a-z]+_[A-Za-z0-9]{20,}|0x[0-9A-Fa-f]{64}(?![0-9A-Fa-f])|(?:ed25519|secp256k1):[1-9A-HJ-NP-Za-km-z]{32,}/;

/** Whether an answer looks like a key. */
export function looksLikeKey(text: string): boolean {
  return KEY_LIKE.test(text);
}

const isTerminal = (stream: unknown): boolean => (stream as { isTTY?: unknown }).isTTY === true;

/** A terminal whose echo can be turned off: raw mode. Absent: no terminal, or one that can't. */
interface RawModeInput {
  readonly isTTY?: boolean;
  readonly isRaw?: boolean;
  setRawMode?(mode: boolean): unknown;
}

function rawModeOf(input: Readable): { readonly isRaw: boolean; set(mode: boolean): void } | undefined {
  const tty = input as Readable & RawModeInput;
  if (tty.isTTY !== true || typeof tty.setRawMode !== 'function') return undefined;
  return {
    isRaw: tty.isRaw === true,
    set: (mode) => {
      tty.setRawMode?.(mode);
    },
  };
}

/**
 * A line typed in raw mode as the person meant it: each backspace, DEL or BS, takes the character
 * before it away, and Ctrl-C stops. Trimmed.
 */
export function typedSecret(line: string): string {
  const kept: string[] = [];
  for (const char of line) {
    if (char === CTRL_C) throw new Stop(SECRET_STOPPED);
    if (char === '\x7f' || char === '\b') kept.pop();
    else kept.push(char);
  }
  return kept.join('').trim();
}

export function createPrompter(streams: { readonly input: Readable; readonly output: Writable }): Prompter {
  const rl = createInterface({ input: streams.input, crlfDelay: Infinity });
  // One queue for the whole session. Lines that arrive before a question is asked are kept.
  type Waiter = (line: string | undefined) => void;
  const kept: string[] = [];
  const waiting: Waiter[] = [];
  let ended = false;
  rl.on('line', (line) => {
    const waiter = waiting.shift();
    if (waiter === undefined) kept.push(line);
    else waiter(line);
  });
  rl.on('close', () => {
    ended = true;
    for (const waiter of waiting.splice(0)) waiter(undefined);
  });
  /** The next line, or `undefined` when the input has ended. */
  const next = (): { readonly line: Promise<string | undefined>; cancel(): void } => {
    const early = kept.shift();
    if (early !== undefined) return { line: Promise.resolve(early), cancel: () => undefined };
    if (ended) return { line: Promise.resolve(undefined), cancel: () => undefined };
    let waiter: Waiter = () => undefined;
    const line = new Promise<string | undefined>((resolve) => {
      waiter = resolve;
      waiting.push(waiter);
    });
    return {
      line,
      cancel: () => {
        const at = waiting.indexOf(waiter);
        if (at >= 0) waiting.splice(at, 1);
      },
    };
  };
  const write = (text: string): void => {
    streams.output.write(text);
  };

  async function readLine(): Promise<string> {
    const line = await next().line;
    if (line === undefined) throw new Stop('No more input');
    return line.trim();
  }

  /** On a terminal, the input shows what is typed at a visible question; some consoles show it without one. */
  const echoes = (): boolean => isTerminal(streams.input) || isTerminal(streams.output);

  /**
   * A line read for a visible question, or `undefined` when it looks like a key: then the key is not
   * used, nothing of it is printed, and the person is told to type `retry`, and that it showed.
   */
  async function visibleAnswer(retry: string): Promise<string | undefined> {
    const answer = await readLine();
    if (!looksLikeKey(answer)) return answer;
    write(`${KEY_REFUSED}; ${retry}.\n`);
    if (echoes()) write(`${KEY_SHOWN}\n`);
    return undefined;
  }

  function dropTypedAhead(): void {
    if (isTerminal(streams.input)) kept.length = 0;
  }

  function secretInput(): 'hidden' | 'piped' | 'echoed' {
    if (rawModeOf(streams.input) !== undefined) return 'hidden';
    return isTerminal(streams.output) ? 'echoed' : 'piped';
  }

  async function ask(question: string, fallback?: string): Promise<string> {
    for (let attempt = 1; attempt <= MAX_TRIES; attempt += 1) {
      write(fallback === undefined ? `${question} ` : `${question} [${fallback}] `);
      const answer = await visibleAnswer('type the answer again');
      if (answer !== undefined) return answer === '' ? (fallback ?? '') : answer;
    }
    throw new Stop('No valid answer');
  }

  async function askSecret(question: string): Promise<string> {
    // A line typed before the question appeared, such as a second Enter after the last secret, is not its answer
    dropTypedAhead();
    write(`${question} `);
    const raw = rawModeOf(streams.input);
    if (raw === undefined) return readLine();
    // Ctrl-C ends the question at once, not at the next Enter: the line typed so far is ended here, so
    // that it is this question's answer and never a later one's. readline has read the chunk already:
    // its listener came first. A chunk with a line end in it ends the line itself.
    const onData = (chunk: Buffer | string): void => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('latin1');
      if (!ended && text.includes(CTRL_C) && !/[\r\n]/.test(text)) rl.write('\r');
    };
    raw.set(true);
    try {
      streams.input.on('data', onData);
      const line = await next().line;
      if (line === undefined) throw new Stop('No more input');
      return typedSecret(line);
    } finally {
      streams.input.off('data', onData);
      raw.set(raw.isRaw);
      // Raw mode sends Enter as a lone \r, which readline remembers, to drop a \n that follows it: the
      // empty write forgets it, so the first Enter at the next question, a \n again, is not lost
      if (!ended) rl.write('');
      // The Enter was not echoed
      write('\n');
    }
  }

  async function choose<T>(title: string, options: readonly Option<T>[]): Promise<T> {
    write(`${title}\n`);
    options.forEach((option, index) => {
      write(`  ${index + 1}  ${option.label}${option.note === undefined ? '' : `  ${option.note}`}\n`);
    });
    for (let attempt = 1; attempt <= MAX_TRIES; attempt += 1) {
      write(`Choose 1-${options.length}: `);
      const answer = await visibleAnswer(`type a number from 1 to ${options.length}`);
      if (answer === undefined) continue;
      if (/^[0-9]+$/.test(answer)) {
        const chosen = options[Number(answer) - 1];
        if (chosen !== undefined) return chosen.value;
      }
      if (attempt < MAX_TRIES) write(`Please type a number from 1 to ${options.length}.\n`);
    }
    throw new Stop('No valid choice');
  }

  async function confirm(question: string, fallback: boolean): Promise<boolean> {
    const hint = fallback ? 'Y/n' : 'y/N';
    for (let attempt = 1; attempt <= MAX_TRIES; attempt += 1) {
      write(`${question} [${hint}] `);
      const typed = await visibleAnswer('type y or n');
      if (typed === undefined) continue;
      const answer = typed.toLowerCase();
      if (answer === '') return fallback;
      if (answer === 'y' || answer === 'yes') return true;
      if (answer === 'n' || answer === 'no') return false;
      if (attempt < MAX_TRIES) write('Please answer y or n.\n');
    }
    throw new Stop('No valid answer');
  }

  function waitForEnter(): { readonly pressed: Promise<boolean>; cancel(): void } {
    const reading = next();
    const pressed = new Promise<boolean>((resolve) => {
      void reading.line.then((line) => {
        if (line !== undefined) resolve(true);
        // The input ended: nobody can press Enter, and the wait goes on without it
      });
    });
    return { pressed, cancel: reading.cancel };
  }

  return { ask, askSecret, secretInput, dropTypedAhead, choose, confirm, waitForEnter, close: () => rl.close() };
}
