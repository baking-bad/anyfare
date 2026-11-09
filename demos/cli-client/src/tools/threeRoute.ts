import { request } from '../http.ts';
import type { Fetch } from '../http.ts';
import { Stop, UsageError, fromAtomic, isRecord, toAtomic } from '../util.ts';
import { DASH, cutFraction, line, record, textOf } from './read.ts';
import type { PreparedCall, Tool } from './types.ts';

const API = 'https://api.3route.io/v1';
const TIMEOUT_MS = 20_000;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const CHAIN_IDS = [1, 143, 4663, 8453, 42793, 128064] as const;
const CHAIN_NAMES: Readonly<Record<string, number>> = { base: 8453, ethereum: 1, etherlink: 42793, monad: 143 };
const DISPLAY_NAMES: Readonly<Record<number, string>> = { 8453: 'Base', 1: 'Ethereum', 42793: 'Etherlink', 143: 'Monad' };
const RATE_SCALE = 36;

interface Token {
  readonly address: string;
  readonly symbol: string;
  readonly decimals: number;
}

function chainOf(value: string): number {
  const byName = CHAIN_NAMES[value.toLowerCase()];
  if (byName !== undefined) return byName;
  const id = /^[0-9]+$/.test(value) ? Number(value) : undefined;
  const found = CHAIN_IDS.find((known) => known === id);
  if (found !== undefined) return found;
  throw new UsageError(
    `--chain must be base, ethereum, etherlink, monad, or a chain ID (${CHAIN_IDS.join(', ')}), such as --chain base (got "${value}")`,
  );
}

function readToken(value: unknown): Token | undefined {
  if (!isRecord(value)) return undefined;
  const { address, symbol, decimals } = value;
  if (typeof address !== 'string' || typeof symbol !== 'string') return undefined;
  if (typeof decimals !== 'number' || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) return undefined;
  return { address, symbol, decimals };
}

async function tokenList(fetchFn: Fetch, chainId: number): Promise<Token[]> {
  const answer = await request(fetchFn, { method: 'GET', url: `${API}/${chainId}/tokens`, timeoutMs: TIMEOUT_MS });
  const tokens = record(answer.body)['tokens'];
  if (answer.status !== 200 || !isRecord(tokens)) {
    throw new Stop(`3Route's token list for chain ${chainId} answered ${answer.status}`);
  }
  return Object.values(tokens).flatMap((value) => {
    const token = readToken(value);
    return token === undefined ? [] : [token];
  });
}

async function resolve(
  fetchFn: Fetch,
  chainId: number,
  list: readonly Token[],
  flag: '--from' | '--to',
  value: string,
): Promise<Token> {
  if (ADDRESS.test(value)) {
    const listed = list.find((token) => token.address.toLowerCase() === value.toLowerCase());
    if (listed !== undefined) return { ...listed, address: value };
    const answer = await request(fetchFn, {
      method: 'GET',
      url: `${API}/${chainId}/tokens/${value}`,
      timeoutMs: TIMEOUT_MS,
    });
    const token = answer.status === 200 ? readToken(answer.body) : undefined;
    if (token === undefined) {
      throw new Stop(`3Route does not know the token ${value} on chain ${chainId}, so ${flag} cannot be used`);
    }
    return { ...token, address: value };
  }
  const matches = list.filter((token) => token.symbol.toLowerCase() === value.toLowerCase());
  const exact = matches.filter((token) => token.symbol === value);
  const found = exact.length === 1 ? exact : matches;
  if (found.length === 1 && found[0] !== undefined) return found[0];
  if (found.length === 0) {
    throw new UsageError(
      `${flag} "${value}" is not in 3Route's token list for chain ${chainId}. Give a symbol from the list, or an address such as 0x…`,
    );
  }
  throw new UsageError(`${flag} "${value}" matches ${found.length} tokens on chain ${chainId}. Give its address instead`);
}

/** `numerator / denominator` as a decimal with `RATE_SCALE` places, cut. */
function ratio(numerator: bigint, denominator: bigint): string {
  return fromAtomic((numerator * 10n ** BigInt(RATE_SCALE)) / denominator, RATE_SCALE);
}

/** The rate "1 A = x B" from two amounts in smallest units. Exact bigint math, cut and never rounded. */
export function rateText(
  src: { amount: bigint; decimals: number },
  dst: { amount: bigint; decimals: number },
): string {
  if (src.amount === 0n) return DASH;
  return cutFraction(ratio(dst.amount * 10n ** BigInt(src.decimals), src.amount * 10n ** BigInt(dst.decimals)), 8);
}

function atomicOf(value: unknown): bigint | undefined {
  return typeof value === 'string' && /^[0-9]+$/.test(value) ? BigInt(value) : undefined;
}

export const threeRoute: Tool = {
  id: '3route',
  name: '3Route',
  about:
    '3Route: best-priced crypto token swaps, for agents, traders, and apps. Pay-per-call quote & swap API via x402/MPP. No API key or subscription. Takes a chain, a pair and an amount.',
  async prepare(args, context): Promise<PreparedCall> {
    if (args.tool !== '3route') throw new Error('The 3Route tool got the arguments of another tool');
    const chainId = chainOf(args.chain);
    const chain = DISPLAY_NAMES[chainId] ?? `chain ${chainId}`;
    const list = await tokenList(context.fetch, chainId);
    const from = await resolve(context.fetch, chainId, list, '--from', args.from);
    const to = await resolve(context.fetch, chainId, list, '--to', args.to);
    if (from.address.toLowerCase() === to.address.toLowerCase()) {
      throw new UsageError(`--from and --to are the same token (${from.symbol}). Pick two different tokens`);
    }
    let amount: bigint;
    try {
      amount = toAtomic(args.amount, from.decimals);
    } catch (error) {
      const reason = error instanceof Stop ? error.message : 'Not an amount';
      throw new UsageError(`--amount: ${reason}. ${from.symbol} has ${from.decimals} decimals. Example: --amount 1`);
    }
    if (amount === 0n) throw new UsageError('--amount must be more than zero, such as --amount 1');

    const query = `src=${from.address}&dst=${to.address}&amount=${amount}&includeBlockNumber=true`;
    return {
      tool: '3route',
      request: { method: 'GET', url: `${API}/${chainId}/quote?${query}` },
      summary: `${args.amount} ${from.symbol} → ${to.symbol} on ${chain}`,
      slow: false,
      format(answer) {
        const root = record(answer);
        const src = atomicOf(root['srcAmount']);
        const dst = atomicOf(root['dstAmount']);
        const lines: string[] = [];
        if (src === undefined || dst === undefined) {
          lines.push(`${args.amount} ${from.symbol} → ${DASH} ${to.symbol}`);
        } else {
          const srcText = fromAtomic(src, from.decimals);
          lines.push(`${srcText} ${from.symbol} → ${cutFraction(fromAtomic(dst, to.decimals), 8)} ${to.symbol}`);
          lines.push(
            line(
              'Rate',
              `1 ${from.symbol} = ${rateText({ amount: src, decimals: from.decimals }, { amount: dst, decimals: to.decimals })} ${to.symbol}`,
            ),
            line(
              '',
              `1 ${to.symbol} = ${rateText({ amount: dst, decimals: to.decimals }, { amount: src, decimals: from.decimals })} ${from.symbol}`,
            ),
          );
        }
        lines.push(line('Gas', textOf(root['gas'])));
        lines.push(`Block ${textOf(root['blockNumber'])} on ${chain}`);
        return lines;
      },
    };
  },
};
