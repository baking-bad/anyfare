// The buyer's own wallets for x402 and MPP: read from the session's settings, checked before anything
// is signed, and never printed. A line about a variable names it and never quotes its value.

import { NEAR_RPC_URLS, createClientNearSigner } from '@x402/near';
import type { ClientNearSigner } from '@x402/near';
import { privateKeyToAccount } from 'viem/accounts';
import type { PrivateKeyAccount } from 'viem/accounts';
import { tempo } from 'viem/chains';
import { Stop, requireEnv } from './util.ts';

type Env = Readonly<Record<string, string | undefined>>;

export const BASE_PRIVATE_KEY = 'BASE_PRIVATE_KEY';
export const BASE_RPC_URL = 'BASE_RPC_URL';
export const NEAR_ACCOUNT_ID = 'NEAR_ACCOUNT_ID';
export const NEAR_PRIVATE_KEY = 'NEAR_PRIVATE_KEY';
export const NEAR_RPC_URL = 'NEAR_RPC_URL';
export const TEMPO_PRIVATE_KEY = 'TEMPO_PRIVATE_KEY';
export const TEMPO_RPC_URL = 'TEMPO_RPC_URL';

export interface BaseWallet {
  readonly way: 'base';
  /** The payer's address. */
  readonly payer: string;
  /** Signs locally. It holds the key, which nothing reads back. */
  readonly account: PrivateKeyAccount;
}

export interface NearWallet {
  readonly way: 'near';
  /** The payer's account ID. */
  readonly payer: string;
  /** The NEAR RPC the signer reads from: `NEAR_RPC_URL`, or the SDK's own. Never printed: it may hold a key. */
  readonly rpcUrl: string;
  /** Its host, the only part of it that is printed. */
  readonly rpcHost: string;
  /** The SDK's signer, made only when it is needed. It reads the key nonce and the block height from the RPC. */
  signer(): ClientNearSigner;
}

export type Wallet = BaseWallet | NearWallet;

export interface TempoWallet {
  readonly way: 'tempo';
  /** The payer's address. */
  readonly payer: string;
  /** Signs locally. It holds the key, which nothing reads back. */
  readonly account: PrivateKeyAccount;
  /** The Tempo RPC the client reads fees and gas from: `TEMPO_RPC_URL`, or the chain's own. Never printed: it may hold a key. */
  readonly rpcUrl: string;
  /** Its host, the only part of it that is printed. */
  readonly rpcHost: string;
}

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
// NEAR's rules: 2 to 64 characters, lowercase parts joined by dots, - or _ inside a part
const NEAR_ACCOUNT = /^(?=.{2,64}$)(?:[a-z\d]+[-_])*[a-z\d]+(?:\.(?:[a-z\d]+[-_])*[a-z\d]+)*$/;

/** The number of bytes a base58 text stands for, or `undefined` when it is not base58. */
function base58Length(text: string): number | undefined {
  let value = 0n;
  for (const char of text) {
    const digit = BASE58.indexOf(char);
    if (digit < 0) return undefined;
    value = value * 58n + BigInt(digit);
  }
  let bytes = /^1*/.exec(text)?.[0].length ?? 0;
  for (; value > 0n; value >>= 8n) bytes += 1;
  return bytes;
}

/** Whether a text is a NEAR account ID, such as `name.near`, or an implicit one. */
export function isNearAccountId(text: string): boolean {
  return NEAR_ACCOUNT.test(text);
}

/** An EVM wallet's key in `name`: `0x` and 64 hex digits, a key of secp256k1. `pays` says what it pays. */
function readEvmAccount(env: Env, name: string, pays: string): PrivateKeyAccount {
  const key = requireEnv(env, name, `It is the private key of the wallet that pays ${pays}: 0x and 64 hex digits.`);
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Stop(`${name} is not a private key: it is 0x and 64 hex digits. Check .env.local.`);
  }
  try {
    return privateKeyToAccount(key as `0x${string}`);
  } catch {
    // Zero, or past the curve's order. The error is not shown: it could quote the key.
    throw new Stop(`${name} is not a valid private key. Check .env.local.`);
  }
}

/**
 * An RPC's URL from `name`, or `fallback` when it is not set, and its host, the only part of it that
 * is printed. The RPC's answers set what is signed, such as how long it stays valid: no one on the
 * way may change them, so it is https, or plain http to this machine only.
 */
function readRpcUrl(env: Env, name: string, fallback: string): { readonly url: string; readonly host: string; readonly own: boolean } {
  const own = env[name]?.trim() || undefined;
  const rpcUrl = own ?? fallback;
  let url: URL | undefined;
  try {
    url = new URL(rpcUrl);
  } catch {
    url = undefined;
  }
  const local = url?.hostname === '127.0.0.1' || url?.hostname === 'localhost';
  if (url === undefined || !(url.protocol === 'https:' || (url.protocol === 'http:' && local))) {
    throw new Stop(`${name} must be an https:// URL, or http:// to 127.0.0.1 or localhost. Check .env.local.`);
  }
  // fetch refuses a URL with a user name or password, and the NEAR SDK hands the URL to it as it is:
  // an API key goes in the path or the query instead
  if (url.username !== '' || url.password !== '') {
    throw new Stop(`${name} can't carry a user name or password: put an API key in its path or query. Check .env.local.`);
  }
  return { url: rpcUrl, host: url.host, own: own !== undefined };
}

/** An RPC the app reads from, and its host, the only part of it that is printed. */
export interface RpcAddress {
  /** Never printed: it may hold a key in its path or query. */
  readonly url: string;
  readonly host: string;
}

/** The Base RPC the app reads a balance from when `BASE_RPC_URL` is not set. */
export const BASE_DEFAULT_RPC_URL = 'https://mainnet.base.org';

/** `BASE_RPC_URL`, or Base's own public RPC: only balances are read from it. */
export function readBaseRpc(env: Env): RpcAddress {
  const rpc = readRpcUrl(env, BASE_RPC_URL, BASE_DEFAULT_RPC_URL);
  return { url: rpc.url, host: rpc.host };
}

/** `NEAR_ACCOUNT_ID` and the NEAR RPC, for a read of its balance: it needs no key. */
export function readNearAccount(env: Env): { readonly accountId: string; readonly rpc: RpcAddress } {
  const accountId = requireEnv(env, NEAR_ACCOUNT_ID, 'It is the NEAR account that pays USDC on NEAR, such as name.near.');
  if (!isNearAccountId(accountId)) {
    throw new Stop(`${NEAR_ACCOUNT_ID} is not a NEAR account ID, such as name.near. Check .env.local.`);
  }
  const rpc = readRpcUrl(env, NEAR_RPC_URL, NEAR_RPC_URLS['near:mainnet']);
  return { accountId, rpc: { url: rpc.url, host: rpc.host } };
}

/** `BASE_PRIVATE_KEY`: `0x` and 64 hex digits, a key of secp256k1. */
export function readBaseWallet(env: Env): BaseWallet {
  const account = readEvmAccount(env, BASE_PRIVATE_KEY, 'USDC on Base');
  return { way: 'base', payer: account.address, account };
}

/** The Tempo RPC the client uses when `TEMPO_RPC_URL` is not set: the chain's own. */
export const TEMPO_DEFAULT_RPC_URL: string = tempo.rpcUrls.default.http[0];

/** `TEMPO_PRIVATE_KEY`, `0x` and 64 hex digits, and `TEMPO_RPC_URL` when set. */
export function readTempoWallet(env: Env): TempoWallet {
  const account = readEvmAccount(env, TEMPO_PRIVATE_KEY, 'USDC.e on Tempo');
  const rpc = readRpcUrl(env, TEMPO_RPC_URL, TEMPO_DEFAULT_RPC_URL);
  return { way: 'tempo', payer: account.address, account, rpcUrl: rpc.url, rpcHost: rpc.host };
}

/** `NEAR_ACCOUNT_ID`, its full-access `NEAR_PRIVATE_KEY` (`ed25519:` and base58), and `NEAR_RPC_URL` when set. */
export function readNearWallet(env: Env): NearWallet {
  const accountId = requireEnv(env, NEAR_ACCOUNT_ID, 'It is the NEAR account that pays USDC on NEAR, such as name.near.');
  if (!isNearAccountId(accountId)) {
    throw new Stop(`${NEAR_ACCOUNT_ID} is not a NEAR account ID, such as name.near. Check .env.local.`);
  }
  const key = requireEnv(env, NEAR_PRIVATE_KEY, `It is a full-access key of ${NEAR_ACCOUNT_ID}: ed25519: and base58.`);
  const body = key.startsWith('ed25519:') ? key.slice('ed25519:'.length) : '';
  // A seed of 32 bytes, or the seed and its public key, 64 bytes
  const length = base58Length(body);
  if (length !== 32 && length !== 64) {
    throw new Stop(`${NEAR_PRIVATE_KEY} is not a NEAR private key: it is ed25519: and base58. Check .env.local.`);
  }
  // The RPC's answers set how long the signed payment stays valid
  const rpc = readRpcUrl(env, NEAR_RPC_URL, NEAR_RPC_URLS['near:mainnet']);
  const secretKey = `ed25519:${body}` as const;
  return {
    way: 'near',
    payer: accountId,
    rpcUrl: rpc.url,
    rpcHost: rpc.host,
    signer: () =>
      createClientNearSigner({
        accountId,
        secretKey,
        ...(rpc.own && { rpcUrls: { 'near:mainnet': rpc.url } }),
      }),
  };
}

export function readWallet(env: Env, way: 'base'): BaseWallet;
export function readWallet(env: Env, way: 'near'): NearWallet;
export function readWallet(env: Env, way: 'base' | 'near'): Wallet;
export function readWallet(env: Env, way: 'base' | 'near'): Wallet {
  return way === 'base' ? readBaseWallet(env) : readNearWallet(env);
}

export interface Explorer {
  readonly address: (address: string) => string;
  readonly transaction: (hash: string) => string;
  /** The shape of a transaction hash on the network: only such a hash gets a link. */
  readonly hash: RegExp;
}

/** Where a payer and a transaction can be checked. */
export const EXPLORERS: Readonly<Record<'base' | 'near' | 'tempo', Explorer>> = {
  base: {
    address: (address) => `https://basescan.org/address/${address}`,
    transaction: (hash) => `https://basescan.org/tx/${hash}`,
    hash: /^0x[0-9a-fA-F]{64}$/,
  },
  near: {
    address: (account) => `https://nearblocks.io/address/${account}`,
    transaction: (hash) => `https://nearblocks.io/txns/${hash}`,
    hash: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
  },
  tempo: {
    address: (address) => `https://explore.tempo.xyz/address/${address}`,
    transaction: (hash) => `https://explore.tempo.xyz/tx/${hash}`,
    hash: /^0x[0-9a-fA-F]{64}$/,
  },
};
