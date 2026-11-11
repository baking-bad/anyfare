// Names and assets for display. Not prices: amounts always come from an answer.

import { fromAtomic } from './util.ts';

export const NETWORK_NAMES: Readonly<Record<string, string>> = {
  'eip155:8453': 'Base',
  'eip155:56': 'BNB Chain',
  'eip155:42793': 'Etherlink',
  'eip155:4217': 'Tempo',
  'eip155:1': 'Ethereum',
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': 'Solana',
  'near:mainnet': 'NEAR',
};

export interface KnownAsset {
  readonly network: string;
  readonly address: string;
  /** The symbol to show. Absent: the asset's own `extra.name` is shown. */
  readonly symbol?: string;
  readonly decimals: number;
}

export const KNOWN_ASSETS: readonly KnownAsset[] = [
  { network: 'eip155:8453', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', decimals: 6 },
  { network: 'eip155:42793', address: '0x796Ea11Fa2dD751eD01b53C372fFDB4AAa8f00F9', symbol: 'USDC', decimals: 6 },
  { network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC', decimals: 6 },
  { network: 'near:mainnet', address: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', symbol: 'USDC', decimals: 6 },
  { network: 'eip155:4217', address: '0x20C000000000000000000000b9537d11c60E8b50', symbol: 'USDC.e', decimals: 6 },
  { network: 'eip155:56', address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', symbol: 'USDC', decimals: 18 },
  { network: 'eip155:56', address: '0x55d398326f99059fF775485246999027B3197955', symbol: 'USDT', decimals: 18 },
  { network: 'eip155:56', address: '0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d', symbol: 'USD1', decimals: 18 },
  { network: 'eip155:56', address: '0xcE24439F2D9C6a2289F741120FE202248B666666', decimals: 18 },
];

export function networkName(network: string | undefined): string {
  if (network === undefined) return 'an unknown network';
  return NETWORK_NAMES[network] ?? network;
}

/** Addresses on EVM networks are compared in lowercase, the others exactly. */
export function sameAddress(network: string, a: string, b: string): boolean {
  return network.startsWith('eip155:') ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function findAsset(network: string | undefined, address: string | undefined): KnownAsset | undefined {
  if (network === undefined || address === undefined) return undefined;
  return KNOWN_ASSETS.find((asset) => asset.network === network && sameAddress(network, asset.address, address));
}

/** The one network this app pays on. */
export const NEAR_NETWORK = 'near:mainnet';

/** Whether an asset is the USDC this app knows on that network, with 6 decimals: its atomic unit is a micro-USD. */
export function isKnownUsdc(network: string | undefined, asset: string | undefined): boolean {
  const known = findAsset(network, asset);
  return (
    known?.symbol === 'USDC' &&
    known.decimals === 6 &&
    network !== undefined &&
    asset !== undefined &&
    sameAddress(network, known.address, asset)
  );
}

function shortAddress(address: string): string {
  return address.length <= 12 ? address : `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** The asset's symbol, or its own name, or a short address. */
export function assetLabel(network: string | undefined, address: string | undefined, name?: string): string {
  const known = findAsset(network, address);
  if (known?.symbol !== undefined) return known.symbol;
  if (name !== undefined && name !== '') return name;
  return address === undefined ? 'an unknown asset' : shortAddress(address);
}

/**
 * An amount for display: "0.01 USDC on Base". A known asset is shown in whole tokens. An unknown one
 * is shown in atomic units, because its decimals are not known.
 */
export function amountText(
  network: string | undefined,
  address: string | undefined,
  atomic: bigint,
  name?: string,
): string {
  const known = findAsset(network, address);
  const where = networkName(network);
  if (known === undefined) {
    return `${atomic} atomic units of ${assetLabel(network, address, name)} on ${where}`;
  }
  return `${fromAtomic(atomic, known.decimals)} ${assetLabel(network, address, name)} on ${where}`;
}
