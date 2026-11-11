import type { Topup } from '../api';
import type { BadgeTone } from '../../components/Badge';
import { usdOf } from '../../format';

// How a top-up reads: its status as a badge, its amount, and the Credits it adds.

const badges: Readonly<Record<string, { readonly tone: BadgeTone; readonly label: string }>> = {
  credited: { tone: 'success', label: 'Added' },
  quoting: { tone: 'info', label: 'Quoting' },
  waiting: { tone: 'info', label: 'Waiting' },
  processing: { tone: 'info', label: 'Converting' },
  incomplete: { tone: 'warning', label: 'Too little' },
  refunded: { tone: 'warning', label: 'Refunded' },
  expired: { tone: 'warning', label: 'Expired' },
  failed: { tone: 'danger', label: 'Failed' },
  quote_failed: { tone: 'danger', label: 'No quote' },
  quote_unknown: { tone: 'danger', label: 'No quote' },
};

/** The badge of a top-up status. A status this code doesn't know reads as the plain word, in a neutral tone. */
export const topupBadge = (status: string): { readonly tone: BadgeTone; readonly label: string } =>
  badges[status] ?? { tone: 'neutral', label: status.replace(/_/g, ' ') };

const networkNames: Readonly<Record<string, string>> = {
  near: 'NEAR',
  base: 'Base',
  arbitrum: 'Arbitrum',
  solana: 'Solana',
  ethereum: 'Ethereum',
  bitcoin: 'Bitcoin',
};

/** A network's display name from its id: "near" is "NEAR", "base" is "Base". An id not in the map reads with a capital first letter. */
export const networkName = (network: string): string =>
  Object.hasOwn(networkNames, network) ? networkNames[network]! : network === '' ? network : `${network[0]!.toUpperCase()}${network.slice(1)}`;

/** The Credits column: "+$19.99" when credited, "≈ $19.99" from the estimate while it is open, nothing (null) otherwise. */
export const topupCredits = (topup: Topup): { readonly text: string; readonly tone: 'added' | 'estimate' } | null => {
  if (topup.status === 'credited' && topup.credited !== null)
    return { text: `+${usdOf(topup.credited)}`, tone: 'added' };
  if ((topup.status === 'quoting' || topup.status === 'waiting' || topup.status === 'processing' || topup.status === 'incomplete') && topup.estimatedCredits !== null)
    return { text: `≈ ${usdOf(topup.estimatedCredits)}`, tone: 'estimate' };

  return null;
};
