import { curlOf, exampleOf, type Hosts } from '../agents/examples';
import { agentsPath, llmsPath } from '../agents/links';

// The words and requests of the Console page, which stands in until the console is built.

export const consoleTitle = 'The console is being built';
export const consoleDescription = 'The console will show your balance, make and limit payment keys, top up with any token, and list every payment. Until then, every one of those is one request.';

export const consoleLead = 'When it is ready, you will be able to:';

export const consolePlans: readonly string[] = [
  'See the balance',
  'Make and limit payment keys',
  'Top up with any token',
  'See every payment',
  'Rotate the master key',
];

export const todayHeading = 'What works today';
export const todayLead = 'Each of these is one request. Run it from a terminal.';

export interface TodayCard {
  readonly id: string;
  readonly title: string;
  readonly note: string;
  readonly command: string;
}

// The amount goes into the example as a number's text: the example's body is read as JSON, so nothing else changes
const withAmount = (body: string, amount: number): string => JSON.stringify({ ...JSON.parse(body) as Record<string, unknown>, amount: String(amount) });

/** The three cards. `amount` is the top-up link's amount, when it has a valid one. */
export const todayCards = (hosts: Hosts, amount?: number): readonly TodayCard[] => {
  const topup = exampleOf(hosts, 'topup');

  return [
    { id: 'signup', title: 'Make an account', note: 'The answer holds your master key, once. Keep it where only you can read it.', command: curlOf(exampleOf(hosts, 'signup')) },
    { id: 'make-key', title: 'Make a payment key with limits', note: 'A budget per day and a highest price per call. Your agent uses this key, never the master key.', command: curlOf(exampleOf(hosts, 'make-key')) },
    {
      id: 'topup', title: 'Top up',
      note: amount === undefined ? 'Pick a network and a token. The answer gives a deposit address.' : 'Your link\'s amount is in the example. The answer gives a deposit address.',
      command: curlOf(amount === undefined || topup.body === undefined ? topup : { ...topup, body: withAmount(topup.body, amount) }),
    },
  ];
};

/** The two links under the cards: the agents page and the guide, on the public site. */
export const todayLinks = ({ siteUrl }: Pick<Hosts, 'siteUrl'>): readonly { readonly label: string; readonly href: string }[] => [
  { label: 'For agents', href: `${siteUrl}${agentsPath}` },
  { label: 'llms.txt', href: `${siteUrl}${llmsPath}` },
];
