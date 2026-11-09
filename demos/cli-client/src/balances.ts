// The wallets' balances, read from their chains: for `balance`, for the interactive mode's list of ways
// to pay, and for the check before a payment. Reads only: `ft_balance_of` and `view_account` on NEAR,
// `balanceOf` by `eth_call` on Base and Tempo. Nothing is signed, sent or broadcast for them. A line
// names an RPC by its host only, and never quotes a key.

import { encodeFunctionData, erc20Abi } from 'viem';
import type { Context } from './context.ts';
import { limitText } from './http.ts';
import type { Fetch } from './http.ts';
import { KNOWN_ASSETS } from './networks.ts';
import type { KnownAsset } from './networks.ts';
import { fetchFailure, raceLimit } from './rpc.ts';
import { Stop, fromAtomic, isRecord, usd } from './util.ts';
import { BASE_PRIVATE_KEY, NEAR_ACCOUNT_ID, TEMPO_PRIVATE_KEY, readBaseRpc, readBaseWallet, readNearAccount, readTempoWallet } from './wallets.ts';
import type { RpcAddress } from './wallets.ts';

type Env = Readonly<Record<string, string | undefined>>;

export type WalletWay = 'near' | 'base' | 'tempo';

/** How long the read of one wallet may take, for `balance` and before a payment. */
export const BALANCE_TIMEOUT_MS = 10_000;

const WALLET_WAYS: readonly WalletWay[] = ['near', 'base', 'tempo'];

/** The setting a read of each wallet needs: the account, or the key its address is derived from. */
const READ_NEEDS: Readonly<Record<WalletWay, string>> = { near: NEAR_ACCOUNT_ID, base: BASE_PRIVATE_KEY, tempo: TEMPO_PRIVATE_KEY };

const CHAINS: Readonly<Record<WalletWay, { readonly name: string; readonly network: string; readonly symbol: string }>> = {
  near: { name: 'NEAR', network: 'near:mainnet', symbol: 'USDC' },
  base: { name: 'Base', network: 'eip155:8453', symbol: 'USDC' },
  tempo: { name: 'Tempo', network: 'eip155:4217', symbol: 'USDC.e' },
};

/** Who refuses a payment the wallet can't cover, before anything moves. */
const REFUSER: Readonly<Record<WalletWay, string>> = {
  near: 'The facilitator',
  base: 'The facilitator',
  tempo: 'The Tempo node',
};

// NEAR's own token has 24 decimals; it is shown to 4 of them, rounded down
const YOCTO_PER_SHOWN = 10n ** 20n;

/** The token each way pays in, as `networks.ts` knows it: its contract and its decimals. */
function tokenOf(way: WalletWay): KnownAsset {
  const { network, symbol } = CHAINS[way];
  const asset = KNOWN_ASSETS.find((item) => item.network === network && item.symbol === symbol);
  if (asset === undefined) throw new Error(`networks.ts knows no ${symbol} on ${network}`);
  return asset;
}

/** A wallet's balance, or why it was not read. */
export type WalletBalance =
  | {
      readonly kind: 'read';
      readonly way: WalletWay;
      /** The account or address it was read for. Public. */
      readonly owner: string;
      /** The token's atomic units: micro-USD for USDC and USDC.e. */
      readonly token: bigint;
      /** NEAR only, when asked: the account's own NEAR, in yoctoNEAR. */
      readonly near?: bigint;
    }
  | { readonly kind: 'failed'; readonly way: WalletWay; readonly reason: string };

/** A failure of a read in the app's own words: the RPC by its host, never its URL or its own text. */
class ReadFailure extends Error {
  /** The RPC's own name for the error, such as `UNKNOWN_ACCOUNT`, when it gave a plain one. */
  readonly errorName: string | undefined;

  constructor(message: string, errorName?: string) {
    super(message);
    this.errorName = errorName;
  }
}

interface Rpc extends RpcAddress {
  /** "the NEAR RPC at rpc.example", the start of every line about it. */
  readonly at: string;
}

/** The plain name of a JSON-RPC error, as NEAR's RPC gives it in `cause.name` or `name`. */
function errorNameOf(error: unknown): string | undefined {
  const names = isRecord(error) ? [isRecord(error['cause']) ? error['cause']['name'] : undefined, error['name']] : [];
  return names.find((name): name is string => typeof name === 'string' && /^[A-Z][A-Z_]{1,40}$/.test(name));
}

/** One JSON-RPC call, never redirected, until `signal` ends. Its `result`, or a `ReadFailure`. */
async function rpcResult(fetchFn: Fetch, rpc: Rpc, method: string, params: unknown, signal: AbortSignal, limitMs: number): Promise<unknown> {
  let body: unknown;
  try {
    const response = await fetchFn(rpc.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'anyfare-cli', method, params }),
      redirect: 'error',
      signal,
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw new ReadFailure(`${rpc.at} answered ${response.status}`);
    }
    body = await response.json();
  } catch (error) {
    if (error instanceof ReadFailure) throw error;
    if (signal.aborted) throw new ReadFailure(`${rpc.at} did not answer in ${limitText(limitMs)}`);
    const reason = fetchFailure(error, rpc.url);
    if (reason !== undefined) throw new ReadFailure(`${rpc.at} could not be reached${reason === '' ? '' : ` (${reason})`}`);
    throw new ReadFailure(`${rpc.at} answered with no JSON`);
  }
  if (!isRecord(body)) throw new ReadFailure(`${rpc.at} answered with no JSON-RPC result`);
  // The RPC's own text is never shown: it can hold the RPC's URL
  if (body['error'] !== undefined && body['error'] !== null) {
    throw new ReadFailure(`${rpc.at} answered with an error`, errorNameOf(body['error']));
  }
  return body['result'];
}

const unreadable = (rpc: Rpc): ReadFailure => new ReadFailure(`${rpc.at} answered with no balance this app can read`);
const DIGITS = /^[0-9]{1,40}$/;

/** `ft_balance_of` of the USDC contract on NEAR, a view call: the account's USDC, in micro-USD. */
async function nearUsdc(fetchFn: Fetch, rpc: Rpc, accountId: string, signal: AbortSignal, limitMs: number): Promise<bigint> {
  const result = await rpcResult(
    fetchFn,
    rpc,
    'query',
    {
      request_type: 'call_function',
      finality: 'final',
      account_id: tokenOf('near').address,
      method_name: 'ft_balance_of',
      args_base64: Buffer.from(JSON.stringify({ account_id: accountId })).toString('base64'),
    },
    signal,
    limitMs,
  );
  // An older RPC puts a failed view in the result
  if (!isRecord(result) || result['error'] !== undefined) throw new ReadFailure(`${rpc.at} answered with an error`);
  // The view's answer: the bytes of a JSON string of digits
  const bytes = result['result'];
  if (!Array.isArray(bytes) || !bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) throw unreadable(rpc);
  let text: unknown;
  try {
    text = JSON.parse(Buffer.from(bytes as number[]).toString('utf8'));
  } catch {
    throw unreadable(rpc);
  }
  if (typeof text !== 'string' || !DIGITS.test(text)) throw unreadable(rpc);
  return BigInt(text);
}

/** `view_account` on NEAR: the account's own NEAR, in yoctoNEAR. */
async function nearAmount(fetchFn: Fetch, rpc: Rpc, accountId: string, signal: AbortSignal, limitMs: number): Promise<bigint> {
  let result: unknown;
  try {
    result = await rpcResult(fetchFn, rpc, 'query', { request_type: 'view_account', finality: 'final', account_id: accountId }, signal, limitMs);
  } catch (error) {
    // The account ID was checked to be one: it is safe to name
    if (error instanceof ReadFailure && error.errorName === 'UNKNOWN_ACCOUNT') throw new ReadFailure(`${rpc.at} knows no account ${accountId}`);
    throw error;
  }
  const amount = isRecord(result) ? result['amount'] : undefined;
  if (typeof amount !== 'string' || !DIGITS.test(amount)) throw unreadable(rpc);
  return BigInt(amount);
}

/** `balanceOf` of a token by `eth_call`: the owner's balance, in the token's atomic units. */
async function evmBalance(fetchFn: Fetch, rpc: Rpc, token: string, owner: string, signal: AbortSignal, limitMs: number): Promise<bigint> {
  const data = encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [owner as `0x${string}`] });
  const result = await rpcResult(fetchFn, rpc, 'eth_call', [{ to: token, data }, 'latest'], signal, limitMs);
  // One uint256: 32 bytes
  if (typeof result !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(result)) throw unreadable(rpc);
  return BigInt(result);
}

/**
 * The balance of `owner` on the way's chain, read from `rpc` within `limitMs`, in the token the way
 * pays in; on NEAR with its own NEAR too when `withNear` is set. Never throws: a read that fails says
 * why, in a line that names the RPC by its host only.
 */
export async function readBalanceOf(
  fetchFn: Fetch,
  way: WalletWay,
  owner: string,
  address: RpcAddress,
  options: { readonly limitMs?: number; readonly withNear?: boolean } = {},
): Promise<WalletBalance> {
  const limitMs = options.limitMs ?? BALANCE_TIMEOUT_MS;
  const rpc: Rpc = { ...address, at: `the ${CHAINS[way].name} RPC at ${address.host}` };
  const signal = AbortSignal.timeout(limitMs);
  const work = (async (): Promise<WalletBalance> => {
    if (way !== 'near') return { kind: 'read', way, owner, token: await evmBalance(fetchFn, rpc, tokenOf(way).address, owner, signal, limitMs) };
    const [token, near] = await Promise.all([
      nearUsdc(fetchFn, rpc, owner, signal, limitMs),
      options.withNear === true ? nearAmount(fetchFn, rpc, owner, signal, limitMs) : undefined,
    ]);
    return { kind: 'read', way, owner, token, ...(near !== undefined && { near }) };
  })();
  try {
    const read = await raceLimit(work, limitMs);
    return read === 'late' ? { kind: 'failed', way, reason: `${rpc.at} did not answer in ${limitText(limitMs)}` } : read;
  } catch (error) {
    // Anything else is not shown: its text could hold the RPC's URL
    return { kind: 'failed', way, reason: error instanceof ReadFailure ? error.message : `${rpc.at} answered with an error` };
  }
}

/** The wallets whose settings are present: those whose balance can be read. */
export function walletsOf(env: Env): WalletWay[] {
  return WALLET_WAYS.filter((way) => (env[READ_NEEDS[way]]?.trim() ?? '') !== '');
}

/** Who a wallet is, from the settings: the NEAR account, or the address derived from the key, and its RPC. */
function sourceOf(env: Env, way: WalletWay): { readonly owner: string; readonly rpc: RpcAddress } {
  switch (way) {
    case 'near': {
      const { accountId, rpc } = readNearAccount(env);
      return { owner: accountId, rpc };
    }
    case 'base':
      return { owner: readBaseWallet(env).payer, rpc: readBaseRpc(env) };
    case 'tempo': {
      const wallet = readTempoWallet(env);
      return { owner: wallet.payer, rpc: { url: wallet.rpcUrl, host: wallet.rpcHost } };
    }
  }
}

/** One wallet's balance from the settings, within `limitMs`. Never throws: settings that can't be used say why. */
export async function readWalletBalance(
  fetchFn: Fetch,
  env: Env,
  way: WalletWay,
  options: { readonly limitMs?: number; readonly withNear?: boolean } = {},
): Promise<WalletBalance> {
  let source: ReturnType<typeof sourceOf>;
  try {
    source = sourceOf(env, way);
  } catch (error) {
    // The settings' own lines name the variable, never its value
    if (!(error instanceof Stop)) throw error;
    return { kind: 'failed', way, reason: error.message.replace(/\.$/, '') };
  }
  return readBalanceOf(fetchFn, way, source.owner, source.rpc, options);
}

/** "0.979 USDC": an amount of the token the way pays in. */
export function tokenText(way: WalletWay, atomic: bigint): string {
  return `${fromAtomic(atomic, tokenOf(way).decimals)} ${CHAINS[way].symbol}`;
}

/** "USDC on NEAR": what the way pays in. */
export function wayLabel(way: WalletWay): string {
  return `${CHAINS[way].symbol} on ${CHAINS[way].name}`;
}

/** The balance in `balance`: "0.979 USDC and 1.2345 NEAR in name.near", or "not read: …". */
export function balanceText(balance: WalletBalance): string {
  if (balance.kind === 'failed') return `not read: ${balance.reason}`;
  const near = balance.near === undefined ? '' : ` and ${fromAtomic(balance.near / YOCTO_PER_SHOWN, 4)} NEAR`;
  return `${tokenText(balance.way, balance.token)}${near} in ${balance.owner}`;
}

/**
 * Before the confirmation of a wallet payment: the wallet's balance against `needs`, what the call pays
 * in the token's atomic units. Known and below it: a `Stop`, not charged, since nothing was signed. Not
 * read: one warning, and the call goes on, since a payment the wallet can't cover is refused before
 * anything moves. Returns the balance, for a check after signing.
 */
export async function checkWalletCovers(ctx: Context, reading: Promise<WalletBalance>, needs: bigint): Promise<WalletBalance> {
  const balance = await reading;
  const { way } = balance;
  if (balance.kind === 'failed') {
    ctx.warn(`Could not read your wallet's balance: ${balance.reason}. ${REFUSER[way]} refuses a payment the wallet can't cover.`);
    return balance;
  }
  if (balance.token >= needs) return balance;
  throw new Stop(
    `Your wallet holds ${tokenText(way, balance.token)} on ${CHAINS[way].name}, less than the ${tokenText(way, needs)} this call pays. Nothing was signed.`,
    { notCharged: true },
  );
}

/**
 * After signing on Tempo, once the signed transaction's highest network fee is known, in micro-USD and
 * paid in USDC.e: the balance read before the question against the charge and that fee. Below them: a
 * `Stop`, not charged, since the signed transaction was never sent and the app never broadcasts. A
 * balance that was not read was warned about already.
 */
export function checkCoversWithFee(balance: WalletBalance, charge: bigint, maxFee: bigint): void {
  if (balance.kind !== 'read' || balance.token >= charge + maxFee) return;
  const { way } = balance;
  throw new Stop(
    `Your wallet holds ${tokenText(way, balance.token)} on ${CHAINS[way].name}, less than the ${tokenText(way, charge + maxFee)} this call pays with its network fee: ` +
      `${tokenText(way, charge)} and a fee of at most ${usd(maxFee)}. Nothing was sent.`,
    { notCharged: true },
  );
}
