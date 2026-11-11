// The wallet, from the environment: checked before anything is signed, and never printed. A line about
// a variable names it and never quotes its value.

import { NEAR_RPC_URLS, createClientNearSigner } from '@x402/near';
import type { ClientNearSigner } from '@x402/near';
import { Stop } from './util.ts';

type Env = Readonly<Record<string, string | undefined>>;

export const NEAR_ACCOUNT_ID = 'NEAR_ACCOUNT_ID';
export const NEAR_PRIVATE_KEY = 'NEAR_PRIVATE_KEY';
export const NEAR_RPC_URL = 'NEAR_RPC_URL';

/** The NEAR RPC a read goes to, and its host, the only part of it that is printed. */
export interface RpcAddress {
  /** Never printed: it may hold a key in its path or query. */
  readonly url: string;
  readonly host: string;
}

export interface NearWallet {
  /** The payer's account ID. */
  readonly accountId: string;
  readonly rpc: RpcAddress;
  /** The SDK's signer, made only when it is needed. It reads the key nonce and the block height from the RPC. */
  signer(): ClientNearSigner;
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

/** The trimmed value of a variable, or a `Stop` that names it. */
function requireEnv(env: Env, name: string, hint: string): string {
  const value = env[name]?.trim();
  if (value === undefined || value === '') throw new Stop(`${name} is not set. Set it in .env.local or the shell, ${hint}`);
  return value;
}

/**
 * The RPC's URL from `NEAR_RPC_URL`, or the SDK's own, and its host. The RPC's answers set how long a
 * signed payment stays valid: no one on the way may change them, so it is https, or plain http to this
 * machine only.
 */
export function readRpcUrl(env: Env): RpcAddress & { readonly own: boolean } {
  const own = env[NEAR_RPC_URL]?.trim() || undefined;
  const rpcUrl = own ?? NEAR_RPC_URLS['near:mainnet'];
  let url: URL | undefined;
  try {
    url = new URL(rpcUrl);
  } catch {
    url = undefined;
  }
  const local = url?.hostname === '127.0.0.1' || url?.hostname === 'localhost';
  if (url === undefined || !(url.protocol === 'https:' || (url.protocol === 'http:' && local))) {
    throw new Stop(`${NEAR_RPC_URL} must be an https:// URL, or http:// to 127.0.0.1 or localhost. Check .env.local.`);
  }
  // fetch refuses a URL with a user name or password, and the NEAR SDK hands the URL to it as it is:
  // an API key goes in the path or the query instead
  if (url.username !== '' || url.password !== '') {
    throw new Stop(`${NEAR_RPC_URL} can't carry a user name or password: put an API key in its path or query. Check .env.local.`);
  }
  return { url: rpcUrl, host: url.host, own: own !== undefined };
}

function readAccountId(env: Env): string {
  const accountId = requireEnv(env, NEAR_ACCOUNT_ID, 'such as NEAR_ACCOUNT_ID=alice.near');
  if (!isNearAccountId(accountId)) {
    throw new Stop(`${NEAR_ACCOUNT_ID} is not a NEAR account ID, such as alice.near. Check .env.local.`);
  }
  return accountId;
}

/** `NEAR_ACCOUNT_ID` and the NEAR RPC, for a read of its balance: it needs no key and never looks at one. */
export function readNearAccount(env: Env): { readonly accountId: string; readonly rpc: RpcAddress } {
  const accountId = readAccountId(env);
  const { url, host } = readRpcUrl(env);
  return { accountId, rpc: { url, host } };
}

/** `NEAR_ACCOUNT_ID`, its full-access `NEAR_PRIVATE_KEY` (`ed25519:` and base58), and `NEAR_RPC_URL` when set. */
export function readNearWallet(env: Env): NearWallet {
  const accountId = readAccountId(env);
  const key = env[NEAR_PRIVATE_KEY]?.trim() ?? '';
  // A key belongs in .env.local only: never in the shell, where its history keeps it
  if (key === '') throw new Stop(`${NEAR_PRIVATE_KEY} is not set. Add it to .env.local: a full-access key of ${accountId}, ed25519: and base58.`);
  const body = key.startsWith('ed25519:') ? key.slice('ed25519:'.length) : '';
  // A seed of 32 bytes, or the seed and its public key, 64 bytes
  const length = base58Length(body);
  if (length !== 32 && length !== 64) {
    throw new Stop(`${NEAR_PRIVATE_KEY} is not a NEAR private key: it is ed25519: and base58. Check .env.local.`);
  }
  const rpc = readRpcUrl(env);
  const secretKey = `ed25519:${body}` as const;
  return {
    accountId,
    rpc: { url: rpc.url, host: rpc.host },
    signer: () =>
      createClientNearSigner({
        accountId,
        secretKey,
        ...(rpc.own && { rpcUrls: { 'near:mainnet': rpc.url } }),
      }),
  };
}

/**
 * A text with `NEAR_PRIVATE_KEY` taken out, its body too, wherever it is. A last guard on every line
 * printed: no line of the app holds the key, but an answer could echo what a request carried. The
 * key is only looked for here, never checked: a run that needs no key works with any value.
 */
export function withoutKey(text: string, env: Env): string {
  const key = env[NEAR_PRIVATE_KEY]?.trim() ?? '';
  const body = key.startsWith('ed25519:') ? key.slice('ed25519:'.length) : key;
  // Too short to be a key: such a text is no secret, and it would match ordinary words
  if (body.length < 12) return text;
  return text.split(key).join('…').split(body).join('…');
}

export interface Explorer {
  readonly address: (address: string) => string;
  readonly transaction: (hash: string) => string;
  /** The shape of a transaction hash on the network: only such a hash gets a link. */
  readonly hash: RegExp;
}

/** Where a payer and a transaction can be checked. */
export const NEAR_EXPLORER: Explorer = {
  address: (account) => `https://nearblocks.io/address/${account}`,
  transaction: (hash) => `https://nearblocks.io/txns/${hash}`,
  hash: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
};
