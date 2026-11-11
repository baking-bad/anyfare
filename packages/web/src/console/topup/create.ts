import { ConsoleApiError, createTopup, listTopups, type NewTopup, type Topup } from '../api';
import { sameAmount } from './amounts';

// Asking for a deposit address. Each `POST /v1/topups` makes a new address, so it is sent once, never again by the
// page. When it gets no answer the page can read, it can't tell whether the address was made: it reads the newest
// top-ups instead, and opens the one that matches.

/** How far back a top-up that matches counts as the one just asked for: a minute before the click, for a clock that is off. */
export const matchWindowMs = 60_000;

/** How many of the newest top-ups the page reads to find the one it asked for. */
export const recoveryListSize = 5;

/** What came of a request for an address. */
export type CreateResult =
  // The API answered with the new top-up
  | { readonly kind: 'made'; readonly topup: Topup }
  // No answer, and the newest top-ups hold one that matches, made since just before the click
  | { readonly kind: 'found'; readonly topup: Topup }
  // The API answered with an error: no address was made
  | { readonly kind: 'refused'; readonly error: unknown }
  // No answer, and no top-up that matches: the address was not made
  | { readonly kind: 'notMade' }
  // No answer, and the newest top-ups could not be read either
  | { readonly kind: 'unknown'; readonly error: unknown };

// The answers that say for sure that no address was made: an error the API names
const refusals: readonly string[] = [
  'unsupported_network', 'unknown_token', 'ambiguous_token', 'invalid_amount', 'amount_too_small', 'topup_refused', 'rate_limited', 'topup_mismatch',
  'topups_unavailable', 'invalid_request', 'unauthorized', 'invalid_key', 'wrong_key_type',
];

/**
 * Whether a failure leaves it open whether the address was made: no answer (no connection, a timeout), an answer no
 * one can read, or a server error the API doesn't name.
 */
export const isUnanswered = (error: unknown): boolean =>
  !(error instanceof ConsoleApiError) || error.status === 0 || error.code === 'unexpected_answer' || (error.status >= 500 && !refusals.includes(error.code));

/** The newest top-up that is the one asked for: same network, token and amount, made since a minute before the click. */
export const matchOf = (topups: readonly Topup[], asked: { readonly network: string; readonly symbol: string; readonly amount: string }, clickedAt: number): Topup | undefined =>
  topups.find(topup => {
    const made = Date.parse(topup.createdAt);

    return topup.network === asked.network && topup.token.toUpperCase() === asked.symbol.toUpperCase() && sameAmount(topup.amount, asked.amount)
      && !Number.isNaN(made) && made >= clickedAt - matchWindowMs;
  });

/** One request for an address at a time: the page holds one, so a form that is shown again can't start a second. */
export interface Sender {
  readonly running: () => boolean;
  // Runs `run` and returns its promise, or sends nothing and returns undefined while another runs
  readonly send: <TValue>(run: () => Promise<TValue>) => Promise<TValue> | undefined;
}

/** A sender that refuses a request while one runs, at once, before any render: a double click or Enter and a click send one. */
export const createSender = (): Sender => {
  let running = false;

  return {
    running: () => running,
    send: run => {
      if (running)
        return undefined;
      running = true;

      return run().finally(() => {
        running = false;
      });
    },
  };
};

/** What the form says about a request that made no address: the page's own heading, and the API's message as text. */
export const refusalOf = (result: Exclude<CreateResult, { readonly kind: 'made' | 'found' }>, network: string): { readonly code: string; readonly title: string; readonly text: string } => {
  if (result.kind === 'notMade')
    return { code: 'not_made', title: 'The address was not made', text: 'The request got no answer, and no new top-up is on your account. Nothing to send. You can press the button again.' };
  if (result.kind === 'unknown')
    return { code: 'unknown', title: 'We can\'t tell whether the address was made', text: 'The request got no answer, and your top-ups could not be read. Look in Latest top-ups before you press again: a new top-up shows there.' };
  const { error } = result;
  if (!(error instanceof ConsoleApiError))
    return { code: 'unknown', title: 'The address was not made', text: 'Something went wrong. Try again in a moment.' };
  const said = error.message;
  const titles: Readonly<Record<string, string>> = {
    unsupported_network: `Top-ups don't come from ${network}`,
    unknown_token: 'This token is not taken',
    ambiguous_token: 'Two tokens have this name',
    invalid_amount: 'The amount was refused',
    amount_too_small: `Under the least for ${network}`,
    topup_refused: 'No address for this token',
    rate_limited: 'Too many top-ups',
    topup_mismatch: 'The quote was not what we asked for',
    topups_unavailable: `Top-ups from ${network} are paused`,
  };
  if (error.code === 'topups_unavailable')
    return { code: error.code, title: titles[error.code]!, text: `${said} Calls keep working. Try another token, or come back later.` };
  if (Object.hasOwn(titles, error.code))
    return { code: error.code, title: titles[error.code]!, text: said };

  return { code: error.code, title: 'The address was not made', text: said };
};

export interface CreateRequests {
  readonly create: (body: NewTopup) => Promise<Topup>;
  readonly listNewest: () => Promise<readonly Topup[]>;
}

/** The requests against the API at `apiUrl`. */
export const apiRequests = (apiUrl: string): CreateRequests => ({
  create: body => createTopup(apiUrl, body),
  listNewest: async () => (await listTopups(apiUrl, recoveryListSize)).topups,
});

/**
 * Sends one `POST /v1/topups` for `body` (whose token is `symbol`, or its address), and works out what came of it.
 * It never sends a second `POST`.
 */
export const requestAddress = async (requests: CreateRequests, body: NewTopup, symbol: string, clickedAt: number): Promise<CreateResult> => {
  try {
    return { kind: 'made', topup: await requests.create(body) };
  }
  catch (error) {
    if (!isUnanswered(error))
      return { kind: 'refused', error };
  }
  try {
    const found = matchOf(await requests.listNewest(), { network: body.network, symbol, amount: body.amount }, clickedAt);

    return found === undefined ? { kind: 'notMade' } : { kind: 'found', topup: found };
  }
  catch (error) {
    return { kind: 'unknown', error };
  }
};
