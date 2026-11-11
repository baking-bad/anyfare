import type { TopupOptions } from '../api';
import { networkName } from './status';

// The tokens a top-up can come from, as the form and its token dialog list them: no network, no React.

/** One token on one network: what the person picks. `key` tells two apart, even two of one symbol on one network. */
export interface TokenChoice {
  readonly key: string;
  readonly network: string;
  // The least a top-up on the network must be worth, in USD, as the API gave it
  readonly minimum: string;
  readonly symbol: string;
  readonly address: string | undefined;
  readonly decimals: number;
  // Another token of the network has the same symbol: the request names this one by its address
  readonly shared: boolean;
}

const sameSymbol = (one: string, other: string): boolean => one.toUpperCase() === other.toUpperCase();

/** Every token of the options, network by network, in the API's order. A network whose tokens can't be read has none. */
export const tokenChoices = (options: TopupOptions): readonly TokenChoice[] => options.networks.flatMap(network => {
  const tokens = network.tokens ?? [];

  return tokens.map((token, index) => ({
    key: `${network.name}:${index}:${token.symbol}`,
    network: network.name,
    minimum: network.minimum,
    symbol: token.symbol,
    address: token.address,
    decimals: token.decimals,
    shared: tokens.filter(other => sameSymbol(other.symbol, token.symbol)).length > 1,
  }));
});

/** Whether the options came without their token lists: the dialog can only say so. */
export const tokensMissing = (options: TopupOptions): boolean => options.networks.some(network => network.tokens === undefined);

/** The token the form starts with: USDC on the first network that has it, else the first token. None when there is no token. */
export const defaultChoice = (choices: readonly TokenChoice[]): TokenChoice | undefined =>
  choices.find(choice => choice.symbol === 'USDC') ?? choices[0];

/** How `POST /v1/topups` names the token: its symbol, or its address when another token of the network has the same symbol. */
export const tokenParam = (choice: TokenChoice): string => choice.shared && choice.address !== undefined ? choice.address : choice.symbol;

const dollarSymbols: readonly string[] = ['USDC', 'USDT', 'USDC.E', 'DAI'];

/** Whether a token is worth a dollar a unit: its amount is dollars, so the form can check it against the network's minimum. */
export const isDollarToken = (symbol: string): boolean => dollarSymbols.includes(symbol.trim().toUpperCase());

/**
 * The tokens a search and a network chip leave: `network` is a network's name, or empty for all; `query` matches the
 * symbol or the network's name, in any case.
 */
export const filterChoices = (choices: readonly TokenChoice[], query: string, network: string): readonly TokenChoice[] => {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);

  return choices.filter(choice => {
    if (network !== '' && choice.network !== network)
      return false;
    const text = `${choice.symbol} ${choice.network} ${networkName(choice.network)}`.toLowerCase();

    return words.every(word => text.includes(word));
  });
};

/** A token's address cut to its ends, to tell two of one symbol apart: `0x2222…2222`. */
export const shortAddress = (address: string): string => address.length <= 14 ? address : `${address.slice(0, 6)}…${address.slice(-4)}`;
