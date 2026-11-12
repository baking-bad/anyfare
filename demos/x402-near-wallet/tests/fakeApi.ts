// A made-up x402 API on 127.0.0.1, set up per test. It answers by method and path: a free answer, a
// 402 with x402 options, an MPP challenge only, or Anyfare's error envelope. A request with
// PAYMENT-SIGNATURE is checked as a facilitator checks a NEAR payment, against the made-up NEAR RPC,
// then settled, made up: nothing moves anywhere. On its own path, /v1/calls, it also serves Anyfare's
// list of finished calls and their receipts, with a call for each good payment. Everything it answers
// is made up: the prices, the accounts, the transactions, the calls and the answers.

import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from '@x402/core/http';
import { decodeSignedDelegateB64 } from '@x402/near';
import { base58 } from './fakeNearRpc.ts';
import type { FakeNearRpc } from './fakeNearRpc.ts';

/** USDC on NEAR, the one asset the app pays. */
export const NEAR_USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';

/** An answer the fake sends as it is. `contentType: null` sends none. */
export interface FakeAnswer {
  readonly status: number;
  readonly contentType?: string | null;
  readonly body: string | Uint8Array;
  readonly headers?: Readonly<Record<string, string>>;
}

/** What a route answers a request without a payment. */
export type Unpaid =
  | { readonly kind: 'answer'; readonly answer: FakeAnswer }
  /** A 402 with these options: in `PAYMENT-REQUIRED` (the default), or in the JSON body only. */
  | { readonly kind: 'x402'; readonly accepts: readonly Record<string, unknown>[]; readonly in?: 'header' | 'body'; readonly version?: number }
  /** A 402 with an MPP challenge only: `WWW-Authenticate: Payment`, no x402. */
  | { readonly kind: 'mpp' }
  /** A 402 whose `PAYMENT-REQUIRED` is not base64 of JSON. */
  | { readonly kind: 'broken-header' }
  | { readonly kind: 'envelope'; readonly status: number; readonly code: string; readonly message: string };

export interface FakeRoute {
  readonly method: string;
  /** The path, without the query. */
  readonly path: string;
  readonly unpaid: Unpaid;
  /** The answer to a good payment. Default: 200 with a made-up JSON quote. Not a 2xx: nothing settles. */
  readonly paid?: FakeAnswer;
}

/** A failure of the next paid request. */
export type PaidFailure =
  /** Anyfare's payment_invalid, 402: another NEAR payment of the payer is in flight. */
  | 'in_flight'
  /** Anyfare's payment_invalid, 402: the payment was used before. */
  | 'used_before'
  /** Anyfare's payment_unavailable, 503 with Retry-After. */
  | 'payment_unavailable'
  /** Anyfare's settlement_failed, 502. */
  | 'settlement_failed'
  /** 500 with a plain body. */
  | 'plain_500'
  /** 402 with a body that is no envelope. */
  | 'bare_402'
  /** The connection closed once the request arrived, with no answer. */
  | 'drop'
  /** No answer at all, until the client gives up. */
  | 'hang'
  /** A 200 without PAYMENT-RESPONSE. */
  | 'no_receipt'
  /** A 200 whose PAYMENT-RESPONSE is not base64 of JSON. */
  | 'unreadable_receipt'
  /** A 200 whose PAYMENT-RESPONSE says `success: false`. */
  | 'not_settled';

export interface Recorded {
  readonly method: string;
  /** The path with its query. */
  readonly path: string;
  /** In lower case, as Node reads them. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** A payment the fake verified and settled. Made up: nothing moved anywhere. */
export interface Settled {
  readonly payer: string;
  readonly payTo: string;
  readonly amount: string;
  readonly transaction: string;
}

/** A finished call as Anyfare lists it, and its receipt's buyer. Made up. */
export interface FakeCall {
  readonly id: string;
  /** An ISO time. */
  readonly at: string;
  /** The API's host. */
  readonly service: string;
  readonly path: string;
  readonly method: string;
  readonly paidWith: string;
  readonly payer: string;
  readonly amount: string;
  /** The receipt's `buyer.network` and `buyer.transaction`. */
  readonly network: string;
  readonly transaction: string;
  /** Still settling: listed, and its receipt is a 404. */
  readonly inFlight?: boolean;
}

/** Anyfare's public reads of finished calls: `GET /v1/calls` and `GET /v1/calls/<id>`. */
export interface FakeCalls {
  /** The calls, in the order they were added. */
  readonly list: FakeCall[];
  /** The calls that a good payment adds: by default its own call only. */
  onPaid: (call: FakeCall) => readonly FakeCall[];
  /** The next this many lists have no call in them: Anyfare writes a call a moment after its answer. */
  emptyLists: number;
  /** Every read fails: a 500, a redirect, or no answer at all. */
  failure: 'status_500' | 'redirect' | 'hang' | undefined;
}

export interface FakeApi {
  /** `http://127.0.0.1:<port>`. */
  readonly url: string;
  readonly requests: Recorded[];
  readonly settled: Settled[];
  /**
   * Holds the answer to the next good paid request until the returned function is called. The
   * request is checked and settled first, as without a hold.
   */
  holdNextPaid(): () => void;
  /** Makes the next paid request fail. */
  nextFailure: PaidFailure | undefined;
  /** The made-up NEAR chain a payment is checked against, and whose USDC a payment lowers. */
  chain: FakeNearRpc | undefined;
  route(route: FakeRoute): void;
  /** Anyfare's calls, and how its reads of them answer. */
  readonly calls: FakeCalls;
  /** The requests that carried PAYMENT-SIGNATURE. */
  paidRequests(): Recorded[];
  /** The requests to /v1/calls and /v1/calls/<id>. */
  callReads(): Recorded[];
  /** Forgets every route, request and payment. */
  reset(): void;
  close(): Promise<void>;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** JSON with its object keys sorted, to compare two values field by field. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) =>
    isObject(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : item,
  );

const DEFAULT_PAID: FakeAnswer = { status: 200, contentType: 'application/json', body: '{"symbol":"BTC","price":"made up"}' };
const isCallRead = (path: string): boolean => path === '/v1/calls' || path.startsWith('/v1/calls?') || path.startsWith('/v1/calls/');
const USED = 'This payment was already used. Request the resource again and sign a new one.';
const IN_FLIGHT = "This payer has another NEAR payment in flight, which this one's nonce would collide with. Pay again once it has settled.";

export async function startFakeApi(): Promise<FakeApi> {
  const routes = new Map<string, FakeRoute>();
  const requests: Recorded[] = [];
  const settled: Settled[] = [];
  const used = new Set<string>();
  const state = {
    nextFailure: undefined as PaidFailure | undefined,
    chain: undefined as FakeNearRpc | undefined,
    hold: undefined as Promise<void> | undefined,
  };
  const calls: FakeCalls = { list: [], onPaid: (call) => [call], emptyLists: 0, failure: undefined };
  let url = '';

  const send = (response: ServerResponse, answer: FakeAnswer): void => {
    const contentType = answer.contentType === undefined ? 'application/json' : answer.contentType;
    response.writeHead(answer.status, { ...(contentType !== null && { 'content-type': contentType }), ...answer.headers });
    response.end(answer.body);
  };
  const envelope = (response: ServerResponse, status: number, code: string, message: string, headers?: Record<string, string>): void =>
    send(response, { status, body: JSON.stringify({ error: { code, message } }), ...(headers !== undefined && { headers }) });

  const unpaid = (route: FakeRoute, path: string, response: ServerResponse): void => {
    const answer = route.unpaid;
    if (answer.kind === 'answer') {
      send(response, answer.answer);
    } else if (answer.kind === 'envelope') {
      envelope(response, answer.status, answer.code, answer.message);
    } else if (answer.kind === 'mpp') {
      send(response, {
        status: 402,
        body: '{"title":"Payment required"}',
        headers: { 'www-authenticate': 'Payment id="madeUpChallenge", realm="api.example.test", method="tempo", intent="charge", request="e30"' },
      });
    } else if (answer.kind === 'broken-header') {
      send(response, { status: 402, body: '{}', headers: { 'payment-required': '!!not base64!!' } });
    } else {
      const required = {
        x402Version: answer.version ?? 2,
        error: 'Payment required',
        resource: { url: `${url}${path}`, description: 'A made-up API' },
        accepts: answer.accepts,
      };
      if (answer.in === 'body') send(response, { status: 402, body: JSON.stringify(required) });
      else send(response, { status: 402, body: '{}', headers: { 'payment-required': encodePaymentRequiredHeader(required as never) } });
    }
  };

  /**
   * The payer of a NEAR payment, or why it is refused, as a facilitator checks it against the chain:
   * one ft_transfer of the asset, of the amount, to the payTo, with one yoctoNEAR, signed with an access
   * key of its sender, and valid for at most the option's blocks.
   */
  const checkNear = (offered: Record<string, unknown>, payload: Record<string, unknown>): { payer: string } | string => {
    const chain = state.chain;
    if (chain === undefined) return 'The fake has no NEAR chain to check the payment against';
    const signed = isObject(payload['payload']) ? payload['payload']['signedDelegateAction'] : undefined;
    if (typeof signed !== 'string') return 'The payment holds no signed delegate action';
    let decoded: ReturnType<typeof decodeSignedDelegateB64>;
    try {
      decoded = decodeSignedDelegateB64(signed);
    } catch {
      return "The signed delegate action can't be read";
    }
    const { delegate } = decoded;
    if (!decoded.verifySignature()) return "The signature is not made with the delegate action's key";
    if (chain.keyOf(delegate.senderId) !== delegate.publicKey) return 'The key is not an access key of the payer';
    const call = delegate.functionCall;
    if (delegate.receiverId !== offered['asset'] || delegate.actionCount !== 1 || call === null || call.methodName !== 'ft_transfer') {
      return 'The delegate action is not one ft_transfer of the asset';
    }
    if (call.deposit !== 1n) return 'The transfer attaches more than one yoctoNEAR';
    let args: unknown;
    try {
      args = JSON.parse(new TextDecoder().decode(call.args));
    } catch {
      args = undefined;
    }
    if (!isObject(args) || args['receiver_id'] !== offered['payTo'] || args['amount'] !== offered['amount']) {
      return 'The transfer pays another recipient or amount';
    }
    const remaining = delegate.maxBlockHeight - chain.height;
    if (remaining <= 0n) return 'The delegate action has expired';
    if (remaining > BigInt(Number(offered['maxTimeoutSeconds']))) return 'The delegate action stays valid for more blocks than the option';
    if (used.has(signed)) return USED;
    used.add(signed);
    return { payer: delegate.senderId };
  };

  /** A request with PAYMENT-SIGNATURE: checked, then settled, made up, before the answer. */
  const paid = (route: FakeRoute, header: string, request: IncomingMessage, response: ServerResponse): void => {
    const invalid = (message: string): void => envelope(response, 402, 'payment_invalid', message);
    let payload: Record<string, unknown>;
    try {
      payload = decodePaymentSignatureHeader(header) as unknown as Record<string, unknown>;
    } catch {
      invalid("PAYMENT-SIGNATURE isn't an x402 payment: base64 of its JSON");
      return;
    }
    const accepted = isObject(payload['accepted']) ? payload['accepted'] : undefined;
    if (payload['x402Version'] !== 2 || accepted === undefined) {
      invalid("PAYMENT-SIGNATURE isn't an x402 v2 payment");
      return;
    }
    const accepts = route.unpaid.kind === 'x402' ? route.unpaid.accepts : [];
    const offered = accepts.find(
      (option) =>
        option['scheme'] === accepted['scheme'] &&
        option['network'] === accepted['network'] &&
        option['asset'] === accepted['asset'] &&
        option['amount'] === accepted['amount'] &&
        option['payTo'] === accepted['payTo'] &&
        option['maxTimeoutSeconds'] === accepted['maxTimeoutSeconds'] &&
        canonical(option['extra'] ?? {}) === canonical(accepted['extra'] ?? {}),
    );
    if (offered === undefined) {
      invalid("The payment doesn't match an option for this price. Request the resource again for the current options.");
      return;
    }
    const failure = state.nextFailure;
    state.nextFailure = undefined;
    if (failure === 'drop') {
      request.socket.destroy();
      return;
    }
    if (failure === 'hang') return;
    if (failure === 'in_flight') {
      invalid(IN_FLIGHT);
      return;
    }
    const checked = offered['network'] === 'near:mainnet' ? checkNear(offered, payload) : 'The fake checks NEAR only';
    if (typeof checked === 'string') {
      invalid(checked);
      return;
    }
    if (failure === 'used_before') return invalid(USED);
    if (failure === 'payment_unavailable') {
      envelope(response, 503, 'payment_unavailable', 'A payment on NEAR is in flight: retry in a moment', { 'retry-after': '2' });
      return;
    }
    if (failure === 'settlement_failed') {
      envelope(response, 502, 'settlement_failed', "The payment couldn't be settled, so the response wasn't sent. Retry the request.");
      return;
    }
    // Anything but a 2xx cancels the payment: nothing settles
    if (failure === 'plain_500') return send(response, { status: 500, contentType: 'text/plain', body: 'Made-up failure of the API' });
    if (failure === 'bare_402') return send(response, { status: 402, body: '{"message":"Made up: the payment was not taken"}' });
    const answer = route.paid ?? DEFAULT_PAID;
    if (answer.status < 200 || answer.status >= 300) return send(response, answer);
    const payment: Settled = {
      payer: checked.payer,
      payTo: String(offered['payTo']),
      amount: String(offered['amount']),
      // A made-up transaction hash, in NEAR's own form
      transaction: base58(randomBytes(32)),
    };
    settled.push(payment);
    if (failure !== 'not_settled') {
      // Anyfare's call, made up: the host is the first part of the path, as Anyfare routes it
      const [, service = '', ...rest] = (request.url ?? '/').split('?')[0]?.split('/') ?? [];
      const call: FakeCall = {
        id: `pay_${randomUUID()}`,
        at: new Date().toISOString(),
        service,
        path: `/${rest.join('/')}`,
        method: request.method ?? 'GET',
        paidWith: 'near',
        payer: payment.payer,
        amount: (Number(payment.amount) / 1_000_000).toString(),
        network: 'near:mainnet',
        transaction: payment.transaction,
      };
      calls.list.push(...calls.onPaid(call));
    }
    // The made-up chain moves the made-up USDC
    const balance = state.chain?.balanceOf(payment.payer);
    if (balance !== undefined) state.chain?.setBalance(payment.payer, balance.usdc - BigInt(payment.amount), balance.near);
    const receipt =
      failure === 'not_settled'
        ? encodePaymentResponseHeader({ success: false, errorReason: 'invalid_transaction_state', transaction: '', network: 'near:mainnet', payer: payment.payer })
        : encodePaymentResponseHeader({ success: true, transaction: payment.transaction, network: 'near:mainnet', payer: payment.payer });
    const proof: Record<string, string> =
      failure === 'no_receipt' ? {} : { 'payment-response': failure === 'unreadable_receipt' ? '!!not base64!!' : receipt };
    const held = state.hold;
    state.hold = undefined;
    const reply = (): void => send(response, { ...answer, headers: { ...answer.headers, ...proof } });
    if (held === undefined) reply();
    else void held.then(reply);
  };

  /** The list of calls, newest first, and a call's receipt, as Anyfare's public API answers them. */
  const callRead = (path: string, response: ServerResponse): void => {
    if (calls.failure === 'hang') return;
    if (calls.failure === 'status_500') return envelope(response, 500, 'internal_error', 'Made-up failure');
    if (calls.failure === 'redirect') return send(response, { status: 302, contentType: null, body: '', headers: { location: `${url}/v1/calls` } });
    const address = new URL(path, url);
    if (address.pathname === '/v1/calls') {
      const paidWith = address.searchParams.get('paidWith');
      const host = address.searchParams.get('host');
      const size = Number(address.searchParams.get('size') ?? '20');
      const empty = calls.emptyLists > 0;
      if (empty) calls.emptyLists -= 1;
      const found = (empty ? [] : calls.list)
        .filter((call) => (paidWith === null || call.paidWith === paidWith) && (host === null || call.service === host))
        .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
      const listed = found.slice(0, size).map(({ id, at, service, path: callPath, method, paidWith: way, payer, amount }) => ({
        id,
        at,
        service,
        path: callPath,
        method,
        paidWith: way,
        apiPaidWith: 'base',
        payer,
        amount,
        status: 'paid',
        apiStatus: 200,
        ms: 120,
      }));
      return send(response, { status: 200, body: JSON.stringify({ calls: listed, page: 1, size, total: found.length, totalCapped: false }) });
    }
    const id = decodeURIComponent(address.pathname.slice('/v1/calls/'.length));
    const call = calls.list.find((item) => item.id === id && item.inFlight !== true);
    if (call === undefined) return envelope(response, 404, 'not_found', 'No finished call has this ID');
    const receipt = {
      id: call.id,
      at: call.at,
      status: 'paid',
      apiStatus: 200,
      service: call.service,
      method: call.method,
      path: call.path,
      buyer: {
        paidWith: call.paidWith,
        network: call.network,
        asset: 'USDC',
        amount: call.amount,
        payer: call.payer,
        transaction: call.transaction,
        explorerUrl: `https://nearblocks.io/txns/${call.transaction}`,
        settledAt: call.at,
      },
    };
    return send(response, { status: 200, body: JSON.stringify(receipt) });
  };

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const path = request.url ?? '/';
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(request.headers)) {
        if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(', ') : value;
      }
      requests.push({ method: request.method ?? '', path, headers, body: Buffer.concat(chunks).toString('utf8') });
      if (request.method === 'GET' && isCallRead(path)) {
        callRead(path, response);
        return;
      }
      const route = routes.get(`${request.method ?? ''} ${path.split('?')[0] ?? ''}`);
      if (route === undefined) {
        send(response, { status: 404, contentType: 'text/plain', body: 'No made-up route here' });
        return;
      }
      const header = headers['payment-signature'];
      if (header === undefined) unpaid(route, path, response);
      else paid(route, header, request, response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url,
    requests,
    settled,
    get nextFailure() {
      return state.nextFailure;
    },
    set nextFailure(value: PaidFailure | undefined) {
      state.nextFailure = value;
    },
    get chain() {
      return state.chain;
    },
    set chain(value: FakeNearRpc | undefined) {
      state.chain = value;
    },
    calls,
    holdNextPaid: () => {
      let release = (): void => {};
      state.hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
    route: (route) => {
      routes.set(`${route.method} ${route.path}`, route);
    },
    paidRequests: () => requests.filter((item) => item.headers['payment-signature'] !== undefined),
    callReads: () => requests.filter((item) => item.method === 'GET' && isCallRead(item.path)),
    reset: () => {
      routes.clear();
      requests.length = 0;
      settled.length = 0;
      used.clear();
      state.nextFailure = undefined;
      state.hold = undefined;
      calls.list.length = 0;
      calls.onPaid = (call) => [call];
      calls.emptyLists = 0;
      calls.failure = undefined;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
