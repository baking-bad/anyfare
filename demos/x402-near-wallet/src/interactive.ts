// The interactive mode: a header, then one request per line, until the owner quits. Every outcome
// goes back to the prompt. Ctrl-C at the prompt quits; Ctrl-C while a request runs lets it finish,
// and answers "no" to a payment's question that is still open.

import { readNearBalance, walletBlock } from './balances.ts';
import { HELP_TEXT, parseCommand, printFailure } from './cli.ts';
import type { AppOptions } from './cli.ts';
import { loadConfig } from './config.ts';
import type { Config } from './config.ts';
import type { Context } from './context.ts';
import { payRequest } from './pay.ts';
import type { Prompter } from './prompt.ts';
import { splitLine } from './request.ts';
import { Stop, UsageError } from './util.ts';
import { NEAR_PRIVATE_KEY, readNearAccount } from './wallet.ts';

const TITLE = 'x402-near-wallet · pay x402 APIs from a NEAR wallet';
const QUESTION = 'Link or request (Enter to quit):';
const STOPPING = "Stopping after this request. A payment that was sent can't be called back.";

/** One turn of the event loop: input that has come in is read meanwhile. */
const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** The wallet block, read fresh. A balance that can't be read leaves its line out, and says why on stderr. */
async function showWallet(ctx: Context, config: Config): Promise<void> {
  const { accountId, rpc } = readNearAccount(ctx.env);
  const balance = await readNearBalance(ctx.io.fetch, accountId, rpc, { withNear: true });
  ctx.print(walletBlock(ctx, config, accountId, balance));
  if (balance.kind === 'failed') ctx.warn(`Could not read the balance: ${balance.reason}.`);
}

/** The next line, or `undefined` when the input has ended. */
async function askLine(prompter: Prompter): Promise<string | undefined> {
  try {
    return await prompter.ask(QUESTION);
  } catch (error) {
    if (error instanceof Stop) return undefined;
    throw error;
  }
}

/** One line: the app's options and a request, read as the flags mode reads its arguments. */
async function runLine(ctx: Context, line: string, defaults: AppOptions): Promise<void> {
  const words = splitLine(line);
  if (words.includes('--yes')) throw new UsageError('The interactive mode always asks. Remove --yes');
  const command = parseCommand(words);
  const maxUsd = defaults.maxUsd;
  if (command.kind === 'help') {
    ctx.io.stdout.write(HELP_TEXT);
  } else if (command.kind === 'balance') {
    await showWallet(ctx, loadConfig(ctx.env, maxUsd === undefined ? {} : { maxUsd }));
  } else if (command.kind === 'interactive') {
    throw new UsageError('Give a link or request after the options. See --help');
  } else {
    // The options of the line are for this line only; --max and --full of the command line are the defaults
    const given = command.options.maxUsd ?? maxUsd;
    const options: AppOptions = {
      yes: false,
      dryRun: command.options.dryRun,
      full: command.options.full || defaults.full,
      ...(given !== undefined && { maxUsd: given }),
    };
    await payRequest(ctx, loadConfig(ctx.env, given === undefined ? {} : { maxUsd: given }), command.request, options);
  }
}

/**
 * Runs the interactive mode and returns the exit code: 0 when the owner quits. A failure of a line is
 * printed and the prompt comes back. `endNow` ends the process at a second Ctrl-C.
 */
export async function runInteractive(
  ctx: Context,
  options: AppOptions,
  endNow: (code: number) => void = (code) => process.exit(code),
): Promise<number> {
  if (!ctx.io.isTerminal) throw new UsageError('The interactive mode needs a terminal. Give a request instead; see --help');
  readNearAccount(ctx.env);
  const config = loadConfig(ctx.env, options.maxUsd === undefined ? {} : { maxUsd: options.maxUsd });
  // Made now, so the lines typed while the header is read are kept, then dropped before the prompt
  const prompter = ctx.prompter();

  ctx.print([ctx.style.styles.title(TITLE), '']);
  await showWallet(ctx, config);
  if ((ctx.env[NEAR_PRIVATE_KEY]?.trim() ?? '') === '') {
    ctx.warn("NEAR_PRIVATE_KEY is not set: the app shows costs, and can't pay. Add it to .env.local.");
  }
  ctx.print('');

  let busy = false;
  let stopping = false;
  let wake: () => void = () => {};
  const interrupted = new Promise<'interrupt'>((resolve) => {
    wake = () => resolve('interrupt');
  });
  const unsubscribe =
    ctx.io.onInterrupt?.(() => {
      if (!busy) {
        wake();
      } else if (stopping) {
        endNow(130);
      } else {
        stopping = true;
        ctx.print(STOPPING);
        // The input ends here: a question still open, such as "Pay …?", is answered "no", so nothing
        // is signed after a Ctrl-C. A request past its question finishes, and is shown
        prompter.close();
      }
    }) ?? (() => {});

  try {
    for (;;) {
      // Lets the input typed until now be read, then drops it
      await nextTurn();
      await nextTurn();
      prompter.dropTypedAhead();
      const next = await Promise.race([askLine(prompter), interrupted]);
      if (next === 'interrupt') {
        ctx.io.stdout.write('\n');
        return 0;
      }
      // The input ended, or an empty line
      if (next === undefined || next.trim() === '') return 0;

      busy = true;
      try {
        await runLine(ctx, next, options);
      } catch (error) {
        printFailure(ctx, error);
      } finally {
        busy = false;
      }
      if (stopping) return 0;
      ctx.print('');
    }
  } finally {
    unsubscribe();
  }
}
