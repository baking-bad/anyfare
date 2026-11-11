import type { Period } from '../api/types';

// The words of the Calls page. The page and its Markdown twin both read them, so they say the same.

export const callsTitle = 'Calls';

export const callsLine = 'Every call paid through Anyfare, as it happens.';

export const callsDescription = 'Every call paid through Anyfare, as it happens: who paid with what, the amount, the status, and how long the API took. Filter by how the buyer paid, by service or by status.';

/** What a call shows, and what it never shows. */
export const callRules: readonly string[] = [
  'The service host and path. Never the query string: it can hold the buyer\'s data.',
  'How the buyer paid, and how we paid the API.',
  'The buyer: a wallet address for a chain payment. It is public on its own chain anyway. A Credits buyer is never named.',
  'The amount, the status, and how long the API took.',
];

export const topPeriods: readonly { readonly value: Period; readonly label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: 'all', label: 'All' },
];

/** How a period reads in a heading, such as "30 days". */
export const periodName = (period: Period): string => topPeriods.find(entry => entry.value === period)?.label.toLowerCase() ?? period;

const networkNames: Readonly<Record<string, string>> = { near: 'NEAR', base: 'Base', solana: 'Solana', tempo: 'Tempo', bitcoin: 'Bitcoin', ethereum: 'Ethereum' };

/** A top-up token as the list reads it: "USDC on Base". */
export const tokenName = (token: string, network: string): string => `${token} on ${networkNames[network] ?? network.slice(0, 1).toUpperCase() + network.slice(1)}`;
