// The networks a check can name, by the ID the API gives (CAIP-2): their name, their official site, and the explorer
// the API links transactions to. The addresses come from the API's 402, so each is checked against its chain's
// shape before it goes into a URL; one of another shape gets no link.

type AddressKind = 'address' | 'token';

interface Network {
  readonly name: string;
  readonly site: string;
  readonly explorer: (kind: AddressKind, address: string) => string | undefined;
}

const evmAddress = /^0x[0-9a-fA-F]{40}$/;
const solanaAddress = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
// A NEAR account: named (`merchant.near`) or implicit (64 hex characters)
const nearAccount = /^(?=.{2,64}$)(?:[a-z\d]+[-_])*[a-z\d]+(?:\.(?:[a-z\d]+[-_])*[a-z\d]+)*$/;

const evm = (host: string) => (kind: AddressKind, address: string): string | undefined =>
  evmAddress.test(address) ? `${host}/${kind}/${address}` : undefined;

const near = (host: string) => (kind: AddressKind, address: string): string | undefined =>
  nearAccount.test(address) ? `${host}/${kind}/${address}` : undefined;

// Solana's explorer shows a token's mint on its address page
const solana = (cluster: string) => (_kind: AddressKind, address: string): string | undefined =>
  solanaAddress.test(address) ? `https://explorer.solana.com/address/${address}${cluster}` : undefined;

const networks: Readonly<Record<string, Network>> = {
  'near:mainnet': { name: 'NEAR', site: 'https://near.org', explorer: near('https://nearblocks.io') },
  'near:testnet': { name: 'NEAR testnet', site: 'https://near.org', explorer: near('https://testnet.nearblocks.io') },
  'eip155:8453': { name: 'Base', site: 'https://base.org', explorer: evm('https://basescan.org') },
  'eip155:84532': { name: 'Base Sepolia', site: 'https://base.org', explorer: evm('https://sepolia.basescan.org') },
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': { name: 'Solana', site: 'https://solana.com', explorer: solana('') },
  'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1': { name: 'Solana Devnet', site: 'https://solana.com', explorer: solana('?cluster=devnet') },
  'eip155:4217': { name: 'Tempo', site: 'https://tempo.xyz', explorer: evm('https://explore.tempo.xyz') },
  'eip155:42431': { name: 'Tempo testnet', site: 'https://tempo.xyz', explorer: evm('https://explore.testnet.tempo.xyz') },
};

const known = (id: string | undefined): Network | undefined => id !== undefined && Object.hasOwn(networks, id) ? networks[id] : undefined;

/** A network's name and official site. Nothing for a network the site doesn't know. */
export const networkOf = (id: string | undefined): { readonly name: string; readonly site: string } | undefined => {
  const network = known(id);

  return network === undefined ? undefined : { name: network.name, site: network.site };
};

/** The explorer's page of an account or a token on a network. Nothing for an unknown network or an address of another shape. */
export const explorerLink = (id: string | undefined, kind: AddressKind, address: string | undefined): string | undefined => {
  const network = known(id);

  return network === undefined || address === undefined ? undefined : network.explorer(kind, address);
};
