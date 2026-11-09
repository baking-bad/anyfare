// A top-up: a person or an agent sends a token on some chain to a deposit address, 1Click swaps it to
// USDC on NEAR, and the arrival is added to the account's balance as Credits.

export const topupStatuses = [
  // Asking 1Click for a deposit address
  'quoting',
  // 1Click refused the quote: no address was made
  'quote_failed',
  // 1Click didn't answer the quote: an address may exist, but nobody was given one
  'quote_unknown',
  'waiting',
  'incomplete',
  'processing',
  'credited',
  'refunded',
  'failed',
  'expired',
] as const;
export type TopupStatus = typeof topupStatuses[number];

// The ones the status job polls
export const openTopupStatuses = ['waiting', 'incomplete', 'processing'] as const satisfies readonly TopupStatus[];
export type OpenTopupStatus = typeof openTopupStatuses[number];

/** What each status means, in plain words, for the person who sends the money. */
export const topupMessages: Readonly<Record<TopupStatus, string>> = Object.freeze({
  quoting: 'Getting a deposit address',
  quote_failed: 'No deposit address: the quote was refused. Nothing to send',
  quote_unknown: 'No deposit address: the quote didn\'t answer. Nothing to send. Ask again',
  waiting: 'Waiting for your transfer',
  incomplete: 'Received less than the least to send. Send the rest before the time runs out',
  processing: 'Received. Converting',
  credited: 'Added to your balance',
  refunded: 'Not added. We hold the amount for you and will return it. Contact us',
  failed: 'Stopped. We are looking into it',
  expired: 'The time to pay ran out. Don\'t send to this address',
});

export const isTopupStatus = (value: string): value is TopupStatus => (topupStatuses as readonly string[]).includes(value);
