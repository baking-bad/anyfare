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

  async function ask(question: string, fallback?: string): Promise<string> {
    write(fallback === undefined ? `${question} ` : `${question} [${fallback}] `);
    const answer = await readLine();
    return answer === '' ? (fallback ?? '') : answer;
  }

  async function choose<T>(title: string, options: readonly Option<T>[]): Promise<T> {
    write(`${title}\n`);
    options.forEach((option, index) => {
      write(`  ${index + 1}  ${option.label}${option.note === undefined ? '' : `  ${option.note}`}\n`);
    });
    for (let attempt = 1; attempt <= MAX_TRIES; attempt += 1) {
      write(`Choose 1-${options.length}: `);
      const answer = await readLine();
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
      const answer = (await readLine()).toLowerCase();
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

  return { ask, choose, confirm, waitForEnter, close: () => rl.close() };
}
