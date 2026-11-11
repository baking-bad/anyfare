import type { PaidWith } from '../api/types';

// The words of the home page. The page and its Markdown twin both read them, so they say the same.

export const siteName = 'Anyfare';

export const tagline = 'pay any paid API from the chain you are on';

export const homeTitle = `${siteName}: ${tagline}`;

export const homeDescription = 'Pay any paid API from the chain you are on. Or top up with any token and give your agent a key with a budget.';

export const hero = {
  eyebrow: 'For AI agents and the people who run them',
  line: 'Pay any paid API from the chain you are on.',
  lead: 'Paste a link to a paid API (x402/MPP) and see what it asks, what it costs, and how you can pay it through Anyfare.',
  placeholder: 'Paste a paid API link',
  freeCredits: 'Make an account in one request. $0.10 of free Credits to try.',
} as const;

/** The two links the hero offers to try. The NEAR one asks for payment only on POST. */
export const tryLinks: readonly { readonly label: string; readonly note: string; readonly url: string; readonly method?: 'POST' }[] = [
  { label: 'x402 on Base', note: 'CoinMarketCap', url: 'pro-api.coinmarketcap.com/x402/v3/cryptocurrency/quotes/latest' },
  { label: 'x402 on NEAR', note: 'Evidence API', url: 'merchant-near.mikedotexe.com/v1/evidence/account', method: 'POST' },
];

/** The check page's address for a link to try, with its method when it is not GET. */
export const tryHref = (link: { readonly url: string; readonly method?: 'POST' }): string => `/check?url=${link.url}${link.method === undefined ? '' : `&method=${link.method}`}`;

export const ways = {
  heading: 'Two ways to pay. Neither needs the API to change.',
  lead: 'We take the payment on your chain. We pay the API on its chain.',
  wallet: {
    title: 'Pay per call from your wallet',
    text: 'USDC on NEAR, Base or Solana over x402. Or MPP on Tempo. No account.',
    notes: ['Your payment settles only after the API answers 2xx.', 'A failed call costs nothing.'],
  },
  key: {
    title: 'Top up, then give your agent a key',
    text: 'Send any token from any chain. Your agent spends from a balance, within a budget you set.',
  },
} as const;

export const nearIntentsUrl = 'https://near-intents.org';

export const statsText = {
  heading: 'Stats',
  lead: 'What agents paid through Anyfare. A call counts only when the API answered and the buyer paid.',
  calls: { label: 'Paid calls', note: 'Answered 2xx and paid for' },
  volume: { label: 'Volume', note: 'The dollars of those calls' },
  buyers: { label: 'Buyers', note: 'Wallets and accounts that paid' },
  services: { label: 'Services used', note: 'APIs with a paid call' },
} as const;

export const topText = {
  heading: 'Top 5 used through Anyfare',
  lead: 'Any x402 or MPP API can be paid through us. These are the 5 that agents paid most this month.',
} as const;

export const agentsText = {
  eyebrow: 'Agent first',
  heading: 'Give this to your agent',
  lead: 'It reads one file, signs up with your permission, and calls with a key that has the limits you set. Every page here has a Markdown twin and a JSON API. Try Agent in the header.',
} as const;

/** The prompt a person gives to an agent. `siteUrl` is the website's own address. */
export const agentPrompt = (siteUrl: string): string => `Read ${siteUrl}/llms.txt and follow it.
Ask me before you sign up, top up, or make a key.
Pay with a payment key, never the master key.
Keep spend under $5 a day and $0.05 a call.`;

export const questions: readonly { readonly q: string; readonly a: string }[] = [
  { q: 'How do I use Anyfare with my agent?', a: 'Give it the prompt above, or the link to llms.txt. It signs up, asks you before it tops up, and calls with a payment key that has your limits. An agent with its own wallet needs no account at all: it pays our 402 from its chain.' },
  { q: 'Do I need a subscription?', a: 'No. No subscription, no monthly fee, no plan. You pay per call, and only for calls that worked.' },
  { q: 'Do I need an account with each API?', a: 'No. One key pays every API we can reach. The API doesn\'t sign up with us either. We pay it the way it asks, over x402 or MPP.' },
  { q: 'Which chains and tokens can I pay with?', a: 'Per call: USDC on NEAR, Base or Solana over x402, or USDC.e on Tempo over MPP. To top up: any of 216 tokens on 39 networks that NEAR Intents takes, Bitcoin included.' },
  { q: 'Can I limit what my agent spends?', a: 'Yes. Each key has a budget per day, a highest price per call, a total, and an end date. The limits live in our database, not in the agent\'s prompt. So the agent can\'t talk its way past them.' },
  { q: 'What does it cost?', a: 'The API\'s price. We add no fee. A top-up pays only the swap\'s fee inside NEAR Intents, about 0.01% for USDC.' },
  { q: 'What if the API fails?', a: 'You pay nothing. Your payment settles, or the hold on your balance is taken, only after a 2xx answer.' },
  { q: 'Can I try it without a wallet?', a: 'Yes. A new account gets $0.10 in free Credits. That pays about 10 calls at $0.01.' },
];

const railNames: Readonly<Record<string, string>> = {
  near: 'USDC on NEAR',
  base: 'USDC on Base',
  solana: 'USDC on Solana',
  tempo: 'MPP on Tempo',
  credits: 'Credits',
};

/** How a way of paying reads in a list, such as "USDC on NEAR". An unknown network reads as its ID. */
export const paidWithName = (paidWith: PaidWith): string => railNames[paidWith] ?? paidWith;

/** How a way of paying reads in a filter: the token with the network, such as "USDC.e on Tempo". The bar lists keep `paidWithName`. */
export const paidWithFilterName = (paidWith: PaidWith): string => paidWith === 'tempo' ? 'USDC.e on Tempo' : paidWithName(paidWith);
