// A made-up NEAR JSON-RPC on 127.0.0.1, with the answers the x402 NEAR signer needs: the final block's
// height and hash, and an access key's nonce. Everything in it is made up: the chain, its height, the
// accounts and their keys.

import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Bytes in base58, as NEAR writes keys and hashes. */
export function base58(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);
  let text = '';
  for (; value > 0n; value /= 58n) text = `${BASE58[Number(value % 58n)]}${text}`;
  for (const byte of bytes) {
    if (byte !== 0) break;
    text = `1${text}`;
  }
  return text;
}

/** What the fake Anyfare reads of the chain to check a NEAR payment, as a facilitator would. */
export interface NearChain {
  /** The final block's height. */
  readonly height: bigint;
  /** The access key of an account, as `ed25519:…`, or `undefined` when it has none. */
  keyOf(accountId: string): string | undefined;
}

export interface RpcCall {
  readonly path: string;
  readonly method: string;
  readonly params: unknown;
}

export interface FakeNearRpc extends NearChain {
  /** `http://127.0.0.1:<port>`, with no path. */
  readonly url: string;
  height: bigint;
  /** The heights the next `block` calls answer, first one first, before `height` again. */
  readonly nextHeights: bigint[];
  /** Answer every call with this status and an empty body; with `only`, just the calls of that method. */
  failing: { readonly status: number; readonly only?: 'block' | 'query' } | undefined;
  readonly calls: RpcCall[];
  addAccessKey(accountId: string, publicKey: string, nonce: bigint): void;
  close(): Promise<void>;
}

export async function startFakeNearRpc(): Promise<FakeNearRpc> {
  const keys = new Map<string, { publicKey: string; nonce: bigint }>();
  const calls: RpcCall[] = [];
  const nextHeights: bigint[] = [];
  // A made-up height, of the size mainnet's has
  const state = { height: 180_000_000n, failing: undefined as FakeNearRpc['failing'] };
  const hash = (): string => base58(randomBytes(32));

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      let call: { id?: unknown; method?: unknown; params?: Record<string, unknown> } = {};
      try {
        call = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof call;
      } catch {
        // Answered as an unknown method below
      }
      const method = typeof call.method === 'string' ? call.method : '';
      calls.push({ path: request.url ?? '/', method, params: call.params });
      const send = (body: unknown): void => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, ...(body as object) }));
      };
      const failing = state.failing;
      if (failing !== undefined && (failing.only === undefined || failing.only === method)) {
        response.writeHead(failing.status, { 'content-type': 'text/plain' });
        response.end('');
        return;
      }
      if (method === 'block') {
        const height = nextHeights.shift() ?? state.height;
        send({ result: { author: 'made-up-validator.near', header: { height: Number(height), hash: hash() }, chunks: [] } });
        return;
      }
      const params = call.params ?? {};
      if (method === 'query' && params['request_type'] === 'view_access_key') {
        const key = keys.get(String(params['account_id']));
        if (key === undefined || key.publicKey !== params['public_key']) {
          send({
            error: {
              name: 'HANDLER_ERROR',
              cause: { name: 'UNKNOWN_ACCESS_KEY', info: { public_key: params['public_key'] } },
              code: -32000,
              message: 'Server error',
              data: `Access key for public key ${String(params['public_key'])} has never been observed on the node`,
            },
          });
          return;
        }
        send({
          result: { nonce: Number(key.nonce), permission: 'FullAccess', block_height: Number(state.height), block_hash: hash() },
        });
        return;
      }
      send({ error: { name: 'REQUEST_VALIDATION_ERROR', cause: { name: 'METHOD_NOT_FOUND' }, code: -32601, message: 'Method not found' } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    get height() {
      return state.height;
    },
    set height(value: bigint) {
      state.height = value;
    },
    nextHeights,
    get failing() {
      return state.failing;
    },
    set failing(value: FakeNearRpc['failing']) {
      state.failing = value;
    },
    calls,
    keyOf: (accountId) => keys.get(accountId)?.publicKey,
    addAccessKey: (accountId, publicKey, nonce) => {
      keys.set(accountId, { publicKey, nonce });
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
