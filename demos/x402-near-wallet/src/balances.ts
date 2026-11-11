// The wallet's balance, read from the NEAR RPC: `ft_balance_of` of the USDC contract and `view_account`.
// Reads only: nothing is signed, sent or broadcast for them. A line names the RPC by its host only, and
// never quotes a key.

import { limitText } from './http.ts';
import type { Fetch } from './http.ts';
import { KNOWN_ASSETS } from './networks.ts';
import { fetchFailure, raceLimit } from './rpc.ts';
import type { Config } from './config.ts';
import type { Context } from './context.ts';
import { isRecord } from './util.ts';
import type { RpcAddress } from './wallet.ts';

/** How long the read of the wallet may take. */
export const BALANCE_TIMEOUT_MS = 10_000;

const USDC_CONTRACT = KNOWN_ASSETS.find((asset) => asset.network === 'near:mainnet' && asset.symbol === 'USDC')?.address;
if (USDC_CONTRACT === undefined) throw new Error('networks.ts knows no USDC on near:mainnet');

// NEAR's own token has 24 decimals; it is shown to 4 of them, rounded down
const YOCTO_PER_SHOWN = 10n ** 20n;

/** The wallet's balance, or why it was not read. */
export type NearBalance =
  | {
      readonly kind: 'read';
      /** The USDC, in micro-USD. */
      readonly usdc: bigint;
      /** When asked: the account's own NEAR, in yoctoNEAR. */
      readonly near?: bigint;
    }
  | { readonly kind: 'failed'; readonly reason: string };

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
      body: JSON.stringify({ jsonrpc: '2.0', id: 'x402-near-wallet', method, params }),
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

/** `ft_balance_of` of the USDC contract, a view call: the account's USDC, in micro-USD. */
async function usdcOf(fetchFn: Fetch, rpc: Rpc, accountId: string, signal: AbortSignal, limitMs: number): Promise<bigint> {
  const result = await rpcResult(
    fetchFn,
    rpc,
    'query',
    {
      request_type: 'call_function',
      finality: 'final',
      account_id: USDC_CONTRACT,
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

/** `view_account`: the account's own NEAR, in yoctoNEAR. */
async function nearOf(fetchFn: Fetch, rpc: Rpc, accountId: string, signal: AbortSignal, limitMs: number): Promise<bigint> {
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

/**
 * The balance of `accountId`, read from `rpc` within `limitMs`: its USDC, and its own NEAR too when
 * `withNear` is set. Never throws: a read that fails says why, in a line that names the RPC by its
 * host only.
 */
export async function readNearBalance(
  fetchFn: Fetch,
  accountId: string,
  address: RpcAddress,
  options: { readonly limitMs?: number; readonly withNear?: boolean } = {},
): Promise<NearBalance> {
  const limitMs = options.limitMs ?? BALANCE_TIMEOUT_MS;
  const rpc: Rpc = { ...address, at: `the NEAR RPC at ${address.host}` };
  const signal = AbortSignal.timeout(limitMs);
  const work = (async (): Promise<NearBalance> => {
    const [usdc, near] = await Promise.all([
      usdcOf(fetchFn, rpc, accountId, signal, limitMs),
      options.withNear === true ? nearOf(fetchFn, rpc, accountId, signal, limitMs) : undefined,
    ]);
    return { kind: 'read', usdc, ...(near !== undefined && { near }) };
  })();
  try {
    const read = await raceLimit(work, limitMs);
    return read === 'late' ? { kind: 'failed', reason: `${rpc.at} did not answer in ${limitText(limitMs)}` } : read;
  } catch (error) {
    // Anything else is not shown: its text could hold the RPC's URL
    return { kind: 'failed', reason: error instanceof ReadFailure ? error.message : `${rpc.at} answered with an error` };
  }
}

/** `atomic` as a decimal with exactly `decimals` decimals. */
function fixed(atomic: bigint, decimals: number): string {
  const digits = atomic.toString().padStart(decimals + 1, '0');
  return `${digits.slice(0, digits.length - decimals)}.${digits.slice(digits.length - decimals)}`;
}

/** "0.990000 USDC": micro-USD with 6 decimals. */
export function usdcText(micro: bigint): string {
  return `${fixed(micro, 6)} USDC`;
}

/** "0.1200 NEAR": yoctoNEAR with 4 decimals, rounded down. */
export function nearText(yocto: bigint): string {
  return `${fixed(yocto / YOCTO_PER_SHOWN, 4)} NEAR`;
}

/** "0.990000 USDC · 0.1200 NEAR", or "not read: …". */
export function balanceLine(balance: NearBalance): string {
  if (balance.kind === 'failed') return `not read: ${balance.reason}`;
  return [usdcText(balance.usdc), ...(balance.near === undefined ? [] : [nearText(balance.near)])].join(' · ');
}

const LABEL_WIDTH = 10;

/**
 * The wallet block's lines: the wallet, its balance, and the cap. A balance that was not read leaves
 * the balance line out.
 */
export function walletBlock(ctx: Context, config: Config, accountId: string, balance: NearBalance): string[] {
  const { label, value } = ctx.style.styles;
  const row = (name: string, text: string): string => `${label(name.padEnd(LABEL_WIDTH))}${value(text)}`;
  return [
    row('Wallet', accountId),
    ...(balance.kind === 'read' ? [row('Balance', balanceLine(balance))] : []),
    row('Cap', `${config.maxPaymentText} a call (${config.capFrom})`),
  ];
}
