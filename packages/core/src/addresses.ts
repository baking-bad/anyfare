import type { NetworkInfo } from './networks.js';

const evmAddressRegExp = /^0x[0-9a-fA-F]{40}$/;
const nearAccountRegExp = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const base58Alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

const decodeBase58 = (value: string): Uint8Array | undefined => {
  let number = 0n;
  for (const character of value) {
    const digit = base58Alphabet.indexOf(character);
    if (digit < 0)
      return undefined;
    number = number * 58n + BigInt(digit);
  }

  const bytes: number[] = [];
  for (; number > 0n; number >>= 8n)
    bytes.unshift(Number(number & 0xffn));
  for (const character of value) {
    if (character !== '1')
      break;
    bytes.unshift(0);
  }

  return Uint8Array.from(bytes);
};

// A Solana account or mint: 32 bytes in base58
const isSolanaKey = (value: string): boolean =>
  value.length >= 32 && value.length <= 44 && decodeBase58(value)?.length === 32;

// A NEAR account ID: a named account, a 64-character hex implicit account, or a token contract
const isNearAccount = (value: string): boolean => value.length >= 2 && value.length <= 64 && nearAccountRegExp.test(value);

/** Whether `address` can receive funds on `network`. The checks are lexical only. */
export const isValidAddress = (network: NetworkInfo, address: string): boolean => {
  switch (network.namespace) {
    case 'eip155': return evmAddressRegExp.test(address);
    case 'solana': return isSolanaKey(address);
    case 'near': return isNearAccount(address);
  }
};

/** Whether `asset` identifies a token on `network`: an ERC-20 contract, a Solana mint or a NEAR token contract. */
export const isValidAssetAddress = (network: NetworkInfo, asset: string): boolean => {
  switch (network.namespace) {
    case 'eip155': return evmAddressRegExp.test(asset);
    case 'solana': return isSolanaKey(asset);
    case 'near': return isNearAccount(asset);
  }
};
