import { paths } from '../api/endpoints';
import type { PaidWith, Receipt } from '../api/types';
import { usdOf } from '../format';

// The words of the receipt page. The page and its Markdown twin both read them, so they say the same.

export const receiptEyebrow = 'Receipt';

export const receiptDescription = 'The receipt of one call paid through Anyfare: what the buyer paid, what Anyfare paid the API, both transactions, and the steps in between.';

export const notFoundLine = 'No call with this id. A call appears here once it is finished.';

export const creditsLine = 'Paid from a balance. No transaction per call.';

export const unavailableTitle = 'We couldn\'t load this receipt.';

export const unavailableLine = 'Try again.';

export const noApiLine = 'We did not pay the API for this call.';

/** An id the page asks the API for: letters, digits, `_` and `-`, at most 64. Anything else is no call. */
export const isReceiptId = (id: string): boolean => /^[A-Za-z0-9_-]{1,64}$/.test(id);

export const receiptTitle = (id: string): string => `Receipt ${id}`;

const chainNames: Readonly<Record<string, string>> = { near: 'NEAR', base: 'Base', solana: 'Solana', tempo: 'Tempo' };

/** A chain as a sentence names it. Credits are no chain: they read as "Credits". An unknown network reads as its ID. */
export const chainName = (paidWith: PaidWith): string => chainNames[paidWith] ?? (paidWith === 'credits' ? 'Credits' : paidWith);

const explorers: Readonly<Record<string, string>> = {
  'nearblocks.io': 'NearBlocks',
  'basescan.org': 'Basescan',
  'solscan.io': 'Solscan',
  'explorer.solana.com': 'Solana Explorer',
};

/** The explorer behind a transaction link, named by the URL's host. Any other host reads as itself. */
export const explorerName = (url: string): string => {
  const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');

  return explorers[host] ?? host;
};

/** An explorer URL the page may link to: http or https only. A value that isn't one is no link. */
export const safeExplorerUrl = (url: string | null): string | undefined => {
  if (url === null)
    return undefined;
  try {
    const parsed = new URL(url);

    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : undefined;
  }
  catch {
    return undefined;
  }
};

/** A transaction id short enough to read: `7HkQ…e2Lm`, `0x5b2e…91af`. A short one stays whole. */
export const shortHash = (hash: string): string => {
  if (hash.length <= 14)
    return hash;
  const head = hash.startsWith('0x') ? 6 : 4;

  return `${hash.slice(0, head)}…${hash.slice(-4)}`;
};

/** A token amount with at least three decimals, such as `0.010`. */
export const tokenAmount = (amount: string): string => {
  const value = Number(amount);
  if (amount.trim() === '' || !Number.isFinite(value))
    return amount;
  const [whole = '0', fraction = ''] = amount.trim().split('.');

  return fraction.length >= 3 ? amount.trim() : `${whole}.${fraction.padEnd(3, '0')}`;
};

/** An end-to-end time in seconds, such as `0.92 s`. */
export const seconds = (milliseconds: number): string => `${(milliseconds / 1000).toFixed(2)} s`;

/** A moment as `10 Nov 2026, 10:05:12 UTC`. */
export const utcMoment = (iso: string): string => {
  const date = new Date(iso);
  const month = date.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });

  return `${date.getUTCDate()} ${month} ${date.getUTCFullYear()}, ${iso.slice(11, 19)} UTC`;
};

/** A step's time as `HH:MM:SS.mmm` in UTC. */
export const stepTime = (iso: string): string => new Date(iso).toISOString().slice(11, 23);

const protocolOf = (paidWith: PaidWith): string => paidWith === 'tempo' ? 'MPP' : 'x402';

/** What one side paid, as "0.010 USDC on NEAR", or "0.010 in Credits". */
export const sideLine = (side: { readonly paidWith: PaidWith; readonly asset: string | null; readonly amount: string }): string =>
  side.paidWith === 'credits' ? `${tokenAmount(side.amount)} in Credits` : `${tokenAmount(side.amount)} ${side.asset ?? 'USDC'} on ${chainName(side.paidWith)}`;

/** What a buyer who was not charged would have paid: "Would have paid 0.0044 in Credits", "Would have paid 0.010 USDC on NEAR". */
export const wouldHavePaid = (side: Parameters<typeof sideLine>[0]): string => `Would have paid ${sideLine(side)}`;

/** The wording of one step: a title and sometimes a note. A name the page doesn't know shows its code. */
export const stepWords = (name: string, receipt: Receipt): { readonly title: string; readonly note?: string } => {
  const { buyer, api } = receipt;
  const credits = buyer.paidWith === 'credits';
  const chain = chainName(buyer.paidWith);
  switch (name) {
    case 'received':
      return { title: 'The buyer asked, with a payment' };
    case 'authorized':
      return credits
        ? { title: `We held ${usdOf(buyer.amount)} on the buyer's balance` }
        : { title: 'We checked the buyer\'s payment', note: `${protocolOf(buyer.paidWith)} on ${chain}. Not settled yet` };
    case 'api_signed':
      return api === null
        ? { title: 'We signed a payment for the API' }
        : { title: `We signed ${tokenAmount(api.amount)} ${api.asset} on ${chainName(api.paidWith)} for the API`, note: `From our ${chainName(api.paidWith)} hot wallet` };
    case 'api_answered':
      return {
        title: `The API answered${receipt.apiStatus === null ? '' : ` ${receipt.apiStatus}`}${receipt.ms.api === null ? '' : ` in ${receipt.ms.api} ms`}`,
        ...receipt.status === 'paid' ? { note: 'The answer went to the buyer as it came' } : {},
      };
    case 'settled':
      return credits
        ? { title: 'The hold was taken from the balance' }
        : { title: `The buyer's payment settled on ${chain}`, note: 'Only now: a failed call is never settled' };
    case 'released':
      return { title: 'The buyer was not charged' };
    default:
      return { title: name };
  }
};

/** The status badge's words: "Paid · API answered 200", "Not charged · API answered 502", "Not charged". */
export const statusWords = (receipt: Receipt): string => {
  const answered = receipt.apiStatus === null ? '' : ` · API answered ${receipt.apiStatus}`;

  return `${receipt.status === 'paid' ? 'Paid' : 'Not charged'}${answered}`;
};

/** What the buyer paid, for the head: a free call reads `$0`. */
export const paidAmount = (receipt: Receipt): string => receipt.status === 'paid' ? usdOf(receipt.buyer.amount) : '$0';

/** The call as the details show it: method and path, or the path alone when the method is unknown. */
export const callLine = (receipt: Receipt): string => receipt.method === null ? receipt.path : `${receipt.method} ${receipt.path}`;

/** The request behind the page. */
export const receiptRequestPath = (id: string): string => paths.call(id);
