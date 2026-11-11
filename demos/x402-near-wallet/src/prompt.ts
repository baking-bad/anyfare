import { createInterface } from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';
import { Stop } from './util.ts';

export interface Prompter {
  ask(question: string, fallback?: string): Promise<string>;
  /**
   * On a terminal, drops the lines typed before the next question appeared: a stray Enter answers
   * nothing. Piped lines are kept: they are a script's answers, in order.
   */
  dropTypedAhead(): void;
  confirm(question: string, fallback: boolean): Promise<boolean>;
  close(): void;
}

const MAX_TRIES = 3;

const isTerminal = (stream: unknown): boolean => (stream as { isTTY?: unknown }).isTTY === true;

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
  const next = (): Promise<string | undefined> => {
    const early = kept.shift();
    if (early !== undefined) return Promise.resolve(early);
    if (ended) return Promise.resolve(undefined);
    return new Promise<string | undefined>((resolve) => waiting.push(resolve));
  };
  const write = (text: string): void => {
    streams.output.write(text);
  };

  async function readLine(): Promise<string> {
    const line = await next();
    if (line === undefined) throw new Stop('No more input');
    return line.trim();
  }

  function dropTypedAhead(): void {
    if (isTerminal(streams.input)) kept.length = 0;
  }

  async function ask(question: string, fallback?: string): Promise<string> {
    write(fallback === undefined ? `${question} ` : `${question} [${fallback}] `);
    const answer = await readLine();
    return answer === '' ? (fallback ?? '') : answer;
  }

  async function confirm(question: string, fallback: boolean): Promise<boolean> {
    const hint = fallback ? 'Y/n' : 'y/N';
    for (let attempt = 1; attempt <= MAX_TRIES; attempt += 1) {
      write(`${question} [${hint}] `);
      const answer = (await readLine()).toLowerCase();
      if (answer === '') return fallback;
      if (answer === 'y' || answer === 'yes') return true;
      if (answer === 'n' || answer === 'no') return false;
      if (attempt < MAX_TRIES) write('Please answer y or n.\n');
    }
    throw new Stop('No valid answer');
  }

  return { ask, dropTypedAhead, confirm, close: () => rl.close() };
}
