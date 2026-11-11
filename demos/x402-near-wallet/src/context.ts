// What one run of a command works with: the Io, the output and the questions.

import type { Io } from './cli.ts';
import { createPrompter } from './prompt.ts';
import type { Prompter } from './prompt.ts';
import { createStyle } from './style.ts';
import type { Style } from './style.ts';
import { Stop, UsageError } from './util.ts';

export interface Context {
  readonly io: Io;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Styles for stdout. */
  readonly style: Style;
  /** Lines on stdout. */
  print(lines: string | readonly string[]): void;
  /** One warning line on stderr. */
  warn(line: string): void;
  /** A `UsageError` when the command would have to ask and cannot: no terminal and no `--yes`. */
  requireAnswerable(yes: boolean, message: string): void;
  /**
   * Asks yes or no, unless `--yes` was given. Without a terminal it is a `UsageError`; a "no" is a
   * `Stop` with the `declined` line.
   */
  approve(options: {
    readonly yes: boolean;
    readonly question: string;
    readonly noTerminal: string;
    readonly declined: Stop;
  }): Promise<void>;
  /** The run's one prompter, made when first asked for: scripted answers are read in order. */
  prompter(): Prompter;
  /** Ends the questions, if any were asked. */
  close(): void;
}

export function createContext(io: Io): Context {
  const style = createStyle(io.stdout);
  const warnStyle = createStyle(io.stderr);
  let prompter: Prompter | undefined;
  const prompterOf = (): Prompter => (prompter ??= createPrompter({ input: io.stdin, output: io.stdout }));
  const requireAnswerable = (yes: boolean, message: string): void => {
    if (!yes && !io.isTerminal) throw new UsageError(message);
  };
  return {
    io,
    env: io.env,
    style,
    print(lines) {
      const all = typeof lines === 'string' ? [lines] : lines;
      if (all.length > 0) io.stdout.write(`${all.join('\n')}\n`);
    },
    warn(line) {
      io.stderr.write(`${warnStyle.styles.warn(line)}\n`);
    },
    requireAnswerable,
    async approve({ yes, question, noTerminal, declined }) {
      if (yes) return;
      requireAnswerable(yes, noTerminal);
      let answer: boolean;
      try {
        answer = await prompterOf().confirm(question, false);
      } catch (error) {
        // The input ended, or three answers were neither yes nor no: the same as a "no"
        if (!(error instanceof Stop)) throw error;
        throw new Stop(`${error.message}. ${declined.message}`, { notCharged: declined.notCharged });
      }
      if (!answer) throw declined;
    },
    prompter: prompterOf,
    close() {
      prompter?.close();
    },
  };
}
