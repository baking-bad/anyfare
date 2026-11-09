// A made-up Base JSON-RPC on 127.0.0.1, offline, that answers `eth_call` of `balanceOf` on USDC on Base
// from balances a test sets. It takes no transaction: anything else is logged and refused, so a test can
// see that a balance read sends nothing. Everything it answers is made up: the balances and the owners.

import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** USDC on Base, the token the app reads a Base wallet's balance in. */
export const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

export interface EvmRpcCall {
  readonly path: string;
  readonly method: string;
  readonly params: readonly unknown[];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// balanceOf(address): its selector, then the address in 32 bytes
const BALANCE_OF = /^0x70a08231000000000000000000000000([0-9a-fA-F]{40})$/;

/**
 * The answer to an `eth_call` of `balanceOf(owner)` on `token`, from `balances` by address in lowercase,
 * as a token answers: one uint256, zero for an owner it doesn't know. `undefined` for any other call.
 */
export function balanceOfAnswer(params: readonly unknown[], token: string, balances: ReadonlyMap<string, bigint>): string | undefined {
  const call = params[0];
  if (!isObject(call) || typeof call['to'] !== 'string' || call['to'].toLowerCase() !== token.toLowerCase()) return undefined;
  const data = typeof call['data'] === 'string' ? call['data'] : typeof call['input'] === 'string' ? call['input'] : '';
  const owner = BALANCE_OF.exec(data)?.[1];
  if (owner === undefined) return undefined;
  return `0x${(balances.get(`0x${owner.toLowerCase()}`) ?? 0n).toString(16).padStart(64, '0')}`;
}

export interface FakeBaseRpc {
  /** `http://127.0.0.1:<port>`, with no path. */
  readonly url: string;
  readonly calls: EvmRpcCall[];
  /** Made-up balances of USDC on Base, in micro-USD, by address in lowercase. */
  readonly balances: Map<string, bigint>;
  /** Sets a made-up balance of USDC on Base, in micro-USD. */
  setBalance(address: string, micro: bigint): void;
  /** Answer every call with this HTTP status and an empty body. */
  failing: number | undefined;
  /** Hold every answer until the server closes, as an RPC that never answers. */
  hanging: boolean;
  /** Every call that was not a read of a balance. */
  others(): EvmRpcCall[];
  /** Back to the defaults: no balances, no failure, and an empty log. */
  reset(): void;
  close(): Promise<void>;
}

export async function startFakeBaseRpc(): Promise<FakeBaseRpc> {
  const calls: EvmRpcCall[] = [];
  const balances = new Map<string, bigint>();
  const held = new Set<ServerResponse>();
  const state = { failing: undefined as number | undefined, hanging: false };

  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      let call: { id?: unknown; method?: unknown; params?: unknown } = {};
      try {
        call = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof call;
      } catch {
        // Answered as an unknown method below
      }
      const method = typeof call.method === 'string' ? call.method : '';
      const params = Array.isArray(call.params) ? (call.params as unknown[]) : [];
      calls.push({ path: request.url ?? '/', method, params });
      if (state.hanging) {
        held.add(response);
        response.on('close', () => held.delete(response));
        return;
      }
      if (state.failing !== undefined) {
        response.writeHead(state.failing, { 'content-type': 'text/plain' });
        response.end('');
        return;
      }
      const result = method === 'eth_call' ? balanceOfAnswer(params, BASE_USDC, balances) : undefined;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: call.id,
          ...(result === undefined ? { error: { code: -32601, message: `${method} is not faked` } } : { result }),
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    balances,
    setBalance: (address, micro) => {
      balances.set(address.toLowerCase(), micro);
    },
    get failing() {
      return state.failing;
    },
    set failing(value: number | undefined) {
      state.failing = value;
    },
    get hanging() {
      return state.hanging;
    },
    set hanging(value: boolean) {
      state.hanging = value;
    },
    others: () => calls.filter((call) => call.method !== 'eth_call' || balanceOfAnswer(call.params, BASE_USDC, balances) === undefined),
    reset: () => {
      calls.length = 0;
      balances.clear();
      state.failing = undefined;
      state.hanging = false;
      for (const response of [...held]) response.destroy();
      held.clear();
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const response of [...held]) response.destroy();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
