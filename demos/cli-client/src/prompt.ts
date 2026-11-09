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
  close(): void;
}

const MAX_TRIES = 3;

export function createPrompter(streams: { readonly input: Readable; readonly output: Writable }): Prompter {
  const rl = createInterface({ input: streams.input, crlfDelay: Infinity });
  // One iterator for the whole session. Lines that arrive before a question is asked are kept.
  const lines = rl[Symbol.asyncIterator]();
  const write = (text: string): void => {
    streams.output.write(text);
  };

  async function readLine(): Promise<string> {
    const next = await lines.next();
    if (next.done === true) throw new Stop('No more input');
    return next.value.trim();
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

  return { ask, choose, confirm, close: () => rl.close() };
}
