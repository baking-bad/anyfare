// A made-up Tempo JSON-RPC on 127.0.0.1, offline, with the answers mppx's Tempo charge client needs to
// sign in pull mode. Like a Tempo node, it answers `eth_fillTransaction` with the request filled in:
// gas, fees, the nonce key and a fee token. With the fill refused, the client asks the rest one by one:
// the chain ID, the latest block and its base fee, the priority fee and a gas estimate. It takes no
// transaction: a raw one sent to it is logged and refused, so a test can see that nothing was
// broadcast. Everything it answers is made up: the block, the gas and the fees.

import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface TempoRpcCall {
  readonly path: string;
  readonly method: string;
  readonly params: readonly unknown[];
}

/** Fields of a fill to answer in place of the honest ones, in the node's own hex form. */
export type FillChange = Readonly<Record<string, unknown>>;

/** pathUSD on Tempo: the fee token a node fills in when the request names none. */
export const PATH_USD = '0x20c0000000000000000000000000000000000000';
/** The honest fill's gas and highest fee per gas, made up: 52,000 gas at 10^9 attodollars, under a tenth of a cent. */
export const HONEST_GAS = 52_000n;
export const HONEST_MAX_FEE_PER_GAS = 1_000_000_000n;

export interface FakeTempoRpc {
  /** `http://127.0.0.1:<port>`, with no path. */
  readonly url: string;
  readonly calls: TempoRpcCall[];
  /** The calls that would have broadcast a transaction. */
  sent(): TempoRpcCall[];
  /** Answer with this HTTP status and an empty body: every call, or with `only`, the calls of that method. */
  failing: { readonly status: number; readonly only?: string } | undefined;
  /** JSON-RPC errors to answer, by method, such as an execution revert for `eth_estimateGas`. */
  readonly errors: Record<string, { readonly code: number; readonly message: string }>;
  /** How `eth_fillTransaction` is answered: as a node does, refused as not supported, or with fields changed. */
  fill: 'honest' | 'refused' | FillChange;
  /** Hold every answer until the server closes, as an RPC that never answers. */
  hanging: boolean;
  /** How many held requests the client gave up on and closed. */
  readonly abandoned: number;
  /** Answer every call with a redirect to this path of the same server. */
  redirecting: string | undefined;
  /** Back to the defaults, and clears the log. */
  reset(): void;
  close(): Promise<void>;
}

const TEMPO_CHAIN_ID = 4217;
const ZERO_HASH = `0x${'0'.repeat(64)}`;
const SENDING = new Set(['eth_sendRawTransaction', 'eth_sendRawTransactionSync', 'eth_sendTransaction']);
const hex = (value: bigint): string => `0x${value.toString(16)}`;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The request filled in as a Tempo node fills it: the sender's calls and validity window as they came,
 * with gas, fees, the nonce, the nonce key, and the request's fee token or the node's own, pathUSD.
 */
function filled(request: Record<string, unknown>, change: FillChange): Record<string, unknown> {
  const calls = Array.isArray(request['calls']) ? request['calls'].filter(isObject) : [];
  return {
    type: '0x76',
    chainId: hex(BigInt(TEMPO_CHAIN_ID)),
    from: request['from'],
    calls: calls.map((call) => ({ to: call['to'], value: call['value'] ?? '0x0', input: call['data'] ?? call['input'] ?? '0x' })),
    gas: hex(HONEST_GAS),
    maxFeePerGas: hex(HONEST_MAX_FEE_PER_GAS),
    maxPriorityFeePerGas: hex(HONEST_MAX_FEE_PER_GAS / 10n),
    nonce: request['nonce'] ?? '0x0',
    nonceKey: request['nonceKey'] ?? '0x0',
    ...(request['validBefore'] !== undefined && { validBefore: request['validBefore'] }),
    ...(request['validAfter'] !== undefined && { validAfter: request['validAfter'] }),
    feeToken: request['feeToken'] ?? PATH_USD,
    accessList: [],
    ...change,
  };
}

export async function startFakeTempoRpc(): Promise<FakeTempoRpc> {
  const calls: TempoRpcCall[] = [];
  const held = new Set<ServerResponse>();
  const errors: FakeTempoRpc['errors'] = {};
  const state = {
    failing: undefined as FakeTempoRpc['failing'],
    fill: 'honest' as FakeTempoRpc['fill'],
    hanging: false,
    redirecting: undefined as string | undefined,
    abandoned: 0,
  };

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
        response.on('close', () => {
          if (held.delete(response)) state.abandoned += 1;
        });
        return;
      }
      if (state.redirecting !== undefined && request.url !== state.redirecting) {
        response.writeHead(307, { location: state.redirecting });
        response.end('');
        return;
      }
      const failing = state.failing;
      if (failing !== undefined && (failing.only === undefined || failing.only === method)) {
        response.writeHead(failing.status, { 'content-type': 'text/plain' });
        response.end('');
        return;
      }
      const send = (body: object): void => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, ...body }));
      };
      const error = errors[method];
      if (error !== undefined) {
        send({ error });
        return;
      }
      switch (method) {
        case 'eth_fillTransaction': {
          if (state.fill === 'refused') {
            send({ error: { code: -32601, message: 'the method eth_fillTransaction does not exist/is not available' } });
            return;
          }
          const tx = filled(isObject(params[0]) ? params[0] : {}, state.fill === 'honest' ? {} : state.fill);
          // A node also answers the unsigned transaction's encoding, which the client does not use
          send({ result: { raw: '0x76', tx } });
          return;
        }
        case 'eth_chainId':
          send({ result: hex(BigInt(TEMPO_CHAIN_ID)) });
          return;
        case 'eth_getBlockByNumber':
          send({
            result: {
              // A made-up block of the time of the call
              number: '0x3e8',
              hash: `0x${'b'.repeat(64)}`,
              parentHash: ZERO_HASH,
              timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}`,
              baseFeePerGas: '0x1',
              gasLimit: '0x1c9c380',
              gasUsed: '0x0',
              miner: `0x${'0'.repeat(40)}`,
              transactions: [],
              difficulty: '0x0',
              extraData: '0x',
              logsBloom: `0x${'0'.repeat(512)}`,
              nonce: '0x0000000000000000',
              sha3Uncles: ZERO_HASH,
              size: '0x0',
              stateRoot: ZERO_HASH,
              receiptsRoot: ZERO_HASH,
              transactionsRoot: ZERO_HASH,
              uncles: [],
              mixHash: ZERO_HASH,
              totalDifficulty: '0x0',
            },
          });
          return;
        case 'eth_maxPriorityFeePerGas':
          send({ result: '0x1' });
          return;
        case 'eth_estimateGas':
          send({ result: '0x186a0' });
          return;
        default:
          // A raw transaction is refused
          send({ error: { code: SENDING.has(method) ? -32003 : -32601, message: `${method} is not faked` } });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    sent: () => calls.filter((call) => SENDING.has(call.method)),
    errors,
    get failing() {
      return state.failing;
    },
    set failing(value: FakeTempoRpc['failing']) {
      state.failing = value;
    },
    get fill() {
      return state.fill;
    },
    set fill(value: FakeTempoRpc['fill']) {
      state.fill = value;
    },
    get hanging() {
      return state.hanging;
    },
    set hanging(value: boolean) {
      state.hanging = value;
    },
    get abandoned() {
      return state.abandoned;
    },
    get redirecting() {
      return state.redirecting;
    },
    set redirecting(value: string | undefined) {
      state.redirecting = value;
    },
    reset: () => {
      calls.length = 0;
      state.failing = undefined;
      state.fill = 'honest';
      state.hanging = false;
      state.redirecting = undefined;
      for (const method of Object.keys(errors)) delete errors[method];
      const open = [...held];
      held.clear();
      for (const response of open) response.destroy();
      state.abandoned = 0;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
