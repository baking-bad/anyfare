// A fake Anyfare for the tests: the Platform API and the proxy, each on its own port of 127.0.0.1.
// Everything it answers is made up: the keys, the IDs, the prices, the balances and the paid answers.

import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from '@x402/core/http';
import { decodeSignedDelegateB64 } from '@x402/near';
import { verifyTypedData } from 'viem';
import type { Fetch } from '../src/http.ts';
import { fromAtomic, toAtomic } from '../src/util.ts';
import { answerOf, fixture } from './helpers.ts';
import type { Call } from './helpers.ts';
import { base58 } from './fakeNearRpc.ts';
import type { NearChain } from './fakeNearRpc.ts';

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** A made-up key: the prefix, then 43 random base62 characters, new on every run. */
export function madeUpKey(prefix: 'afm_live_' | 'af_live_'): string {
  let body = '';
  for (const byte of randomBytes(43)) body += BASE62[byte % 62];
  return `${prefix}${body}`;
}

const usd = (micro: bigint): string => fromAtomic(micro, 6);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** JSON with its object keys sorted, to compare two values field by field. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) =>
    isObject(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : item,
  );

// EIP-3009's transferWithAuthorization, as the USDC contract hashes it: written out here, not taken
// from the SDK that signs, so the check does not share a mistake with the signer
const TRANSFER_WITH_AUTHORIZATION = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;
const micro = (dollars: string): bigint => toAtomic(dollars, 6);

export interface Recorded {
  /** Which fake answered: the Platform API or the proxy. */
  readonly host: 'api' | 'pay';
  readonly method: string;
  /** The path with its query. */
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface FakeAccount {
  readonly id: string;
  readonly masterKey: string;
  available: bigint;
  held: bigint;
}

export interface FakeKey {
  readonly id: string;
  readonly key: string;
  readonly account: FakeAccount;
  readonly label: string | undefined;
  readonly dailyBudget: bigint;
  readonly maxPrice: bigint | undefined;
  readonly allowance: bigint | undefined;
  readonly createdAt: string;
  spentToday: bigint;
  spentTotal: bigint;
}

/** A payment key's limits, in US dollars. */
export interface KeyLimits {
  readonly label?: string;
  readonly dailyBudget?: string;
  readonly maxPrice?: string;
  readonly allowance?: string;
}

/** A target the fake routes to. Its prices are made up. */
export interface FakeTarget {
  /** The target's own URL. */
  readonly url: string;
  readonly method: 'GET' | 'POST';
  /** Anyfare's Credits price, in US dollars: what the routing link's 402 asks, and what a paid call holds. */
  readonly price: string;
  /** The `currency` of the 402's `credits`. Default `USD`; `null` leaves it out. */
  readonly creditsCurrency?: string | null;
  /** What `/_/check` answers for it. Absent: not payable. */
  readonly check?: {
    readonly price: string;
    readonly fee: string;
    readonly asset: string;
    readonly network: string;
    /** The quote's amount. Default: `price` of the target, as the real proxy answers within a quote's life. */
    readonly quote?: string;
    /** The quote's `currency`. Default `USD`; `null` leaves it out. */
    readonly currency?: string | null;
  };
  /** The body of the paid answer. */
  readonly answer: unknown;
  /** x402 options for the combined 402, which then carries a `payment-required` header too. */
  readonly x402?: readonly Record<string, unknown>[];
}

/**
 * The answer to the next paid call, after the key and the hold were checked, or after the x402 payment
 * was verified. Anything but a `2xx` charges nothing.
 */
export interface PaidAnswer {
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  /** Leave out the Anyfare-Receipt header of a `2xx`, or its PAYMENT-RESPONSE when it was paid with x402. */
  readonly noReceipt?: boolean;
}

/** One of the proxy's own x402 failures, for the next payment: each charges nothing but `settlement_failed`, whose outcome is unknown. */
export type X402Failure = 'settlement_failed' | 'payment_unavailable' | 'payer_busy';

/** An x402 payment the fake verified and settled. Made up: nothing moved anywhere. */
export interface X402Settled {
  readonly network: string;
  readonly payer: string;
  readonly payTo: string;
  readonly amount: string;
  readonly transaction: string;
}

export interface FakeAnyfare {
  readonly apiUrl: string;
  readonly payUrl: string;
  readonly requests: Recorded[];
  /** The Credits a new account starts with, in US dollars. */
  startingBalance: string;
  /** Answer sign-up with 429 rate_limited. */
  rateLimitSignup: boolean;
  /** Replaces the answer to the next paid call. */
  nextPaid: PaidAnswer | undefined;
  /**
   * Makes the next x402 payment fail as the proxy would: settlement_failed, payment_unavailable, or the
   * in-flight payment_invalid, which the proxy answers on NEAR only.
   */
  nextX402: X402Failure | undefined;
  /** The made-up NEAR chain a NEAR payment is checked against. None: every NEAR payment is refused. */
  nearChain: NearChain | undefined;
  /** The x402 payments it verified and settled. */
  readonly x402Settled: X402Settled[];
  /** Changes the body of a 201 before it is sent: of sign-up, or of key create. */
  rewrite: { signup?: (body: Record<string, unknown>) => unknown; keys?: (body: Record<string, unknown>) => unknown };
  /** Runs while a request is being answered, after the account or the key exists: of sign-up, or of key create. */
  during: { signup?: () => void; keys?: () => void };
  /** A made-up account, as if it had signed up. */
  addAccount(balance?: string): FakeAccount;
  /** A made-up payment key of an account. */
  addKey(account: FakeAccount, limits?: KeyLimits): FakeKey;
  account(masterKey: string): FakeAccount | undefined;
  addTarget(target: FakeTarget): void;
  /** The requests to routed links, paid or not. */
  routed(): Recorded[];
  /** The routed requests that carried an x402 payment. */
  x402Requests(): Recorded[];
  /** Forgets every account, key, target and request. */
  reset(): void;
  close(): Promise<void>;
}

/** Starts both fakes. Stop them with `close()`. */
export async function startFakeAnyfare(): Promise<FakeAnyfare> {
  const requests: Recorded[] = [];
  const accounts = new Map<string, FakeAccount>();
  const keys = new Map<string, FakeKey>();
  const targets = new Map<string, FakeTarget>();
  const x402Settled: X402Settled[] = [];
  // The payments it took, by network: each pays once
  const usedPayments = new Set<string>();
  let counter = 0;
  const next = (): number => (counter += 1);

  const state = {
    startingBalance: '0',
    rateLimitSignup: false,
    nextPaid: undefined as PaidAnswer | undefined,
    nextX402: undefined as X402Failure | undefined,
    nearChain: undefined as NearChain | undefined,
    rewrite: {} as FakeAnyfare['rewrite'],
    during: {} as FakeAnyfare['during'],
  };

  const send = (
    response: ServerResponse,
    status: number,
    body: unknown,
    headers: Readonly<Record<string, string>> = {},
  ): void => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    response.writeHead(status, {
      'content-type': typeof body === 'string' ? 'text/plain' : 'application/json; charset=utf-8',
      'x-request-id': `req-made-up-${next()}`,
      ...headers,
    });
    response.end(text);
  };
  const fail = (response: ServerResponse, status: number, code: string, message: string, headers?: Record<string, string>): void =>
    send(response, status, { error: { code, message } }, headers);

  const bearer = (request: IncomingMessage): string | undefined =>
    /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(request.headers.authorization ?? '')?.[1];

  const makeAccount = (balance: string): FakeAccount => {
    const account: FakeAccount = {
      id: `acct_madeup${next()}`,
      masterKey: madeUpKey('afm_live_'),
      available: micro(balance),
      held: 0n,
    };
    accounts.set(account.masterKey, account);
    return account;
  };

  const makeKey = (account: FakeAccount, limits: KeyLimits): FakeKey => {
    const key: FakeKey = {
      id: `key_madeup${next()}`,
      key: madeUpKey('af_live_'),
      account,
      label: limits.label,
      dailyBudget: micro(limits.dailyBudget ?? '5'),
      maxPrice: limits.maxPrice === undefined ? undefined : micro(limits.maxPrice),
      allowance: limits.allowance === undefined ? undefined : micro(limits.allowance),
      createdAt: new Date().toISOString(),
      spentToday: 0n,
      spentTotal: 0n,
    };
    keys.set(key.key, key);
    return key;
  };

  const keyView = (key: FakeKey) => ({
    id: key.id,
    label: key.label ?? null,
    allowance: key.allowance === undefined ? null : usd(key.allowance),
    dailyBudget: usd(key.dailyBudget),
    maxPrice: key.maxPrice === undefined ? null : usd(key.maxPrice),
    expiresAt: null,
    createdAt: key.createdAt,
    spent: { today: usd(key.spentToday), total: usd(key.spentTotal) },
  });
  const left = (limit: bigint, spent: bigint): string => usd(limit > spent ? limit - spent : 0n);

  /** The master key of the request, or the answer that refuses it. */
  const master = (request: IncomingMessage, response: ServerResponse): FakeAccount | undefined => {
    const token = bearer(request);
    if (token === undefined) {
      fail(response, 401, 'unauthorized', 'This endpoint needs a master key: Authorization: Bearer <key>', { 'www-authenticate': 'Bearer' });
      return undefined;
    }
    if (token.startsWith('af_')) {
      fail(response, 401, 'wrong_key_type', 'A payment key works only on the pay host. This endpoint takes the master key.');
      return undefined;
    }
    const account = accounts.get(token);
    if (account === undefined) fail(response, 401, 'invalid_key', 'The key is invalid or revoked');
    return account;
  };

  /** The payment key of the request, or the answer that refuses it. */
  const payment = (request: IncomingMessage, response: ServerResponse): FakeKey | undefined => {
    const token = bearer(request);
    if (token === undefined) {
      fail(response, 401, 'unauthorized', 'GET /_/key needs a payment key: Authorization: Bearer <key>');
      return undefined;
    }
    if (token.startsWith('afm_')) {
      fail(response, 401, 'wrong_key_type', 'A master key works only on the Platform API. Paid calls take a payment key.');
      return undefined;
    }
    const key = keys.get(token);
    if (key === undefined) fail(response, 401, 'invalid_key', 'The key is invalid or revoked');
    return key;
  };

  const api = (request: IncomingMessage, response: ServerResponse, path: string, body: string): void => {
    if (request.method === 'POST' && path === '/v1/accounts') {
      if (state.rateLimitSignup) {
        fail(response, 429, 'rate_limited', 'Too many requests. Retry after 30 s', { 'retry-after': '30' });
        return;
      }
      if (body !== '' && body.trim() !== '{}') {
        fail(response, 400, 'invalid_request', 'body must NOT have more than 0 properties');
        return;
      }
      const account = makeAccount(state.startingBalance);
      const created = {
        id: account.id,
        createdAt: new Date().toISOString(),
        masterKey: account.masterKey,
        notice: 'A made-up notice: store the master key now, it is shown only once.',
      };
      state.during.signup?.();
      send(response, 201, state.rewrite.signup?.(created) ?? created);
      return;
    }
    if (request.method === 'POST' && path === '/v1/keys') {
      const account = master(request, response);
      if (account === undefined) return;
      const limits = (body === '' ? {} : JSON.parse(body)) as Record<string, string | undefined>;
      const key = makeKey(account, {
        ...(limits['label'] !== undefined && { label: limits['label'] }),
        ...(limits['dailyBudget'] !== undefined && { dailyBudget: limits['dailyBudget'] }),
        ...(limits['maxPrice'] !== undefined && { maxPrice: limits['maxPrice'] }),
        ...(limits['allowance'] !== undefined && { allowance: limits['allowance'] }),
      });
      const created = {
        ...keyView(key),
        revokedAt: null,
        remaining: { allowance: key.allowance === undefined ? null : usd(key.allowance), dailyBudget: usd(key.dailyBudget) },
        key: key.key,
      };
      state.during.keys?.();
      send(response, 201, state.rewrite.keys?.(created) ?? created);
      return;
    }
    if (request.method === 'GET' && path === '/v1/balance') {
      const account = master(request, response);
      if (account === undefined) return;
      send(response, 200, { available: usd(account.available), held: usd(account.held) });
      return;
    }
    fail(response, 404, 'not_found', 'Not found');
  };

  const challenge = (target: FakeTarget, payUrl: string, apiUrl: string) => {
    const resource = { url: `${payUrl}/${target.url.replace(/^https:\/\//, '')}`, description: 'Payment required' };
    const required =
      target.x402 === undefined
        ? undefined
        : { x402Version: 2, error: 'Payment required', resource, accepts: target.x402 };
    const credits = {
      price: target.price,
      ...(target.creditsCurrency !== null && { currency: target.creditsCurrency ?? 'USD' }),
      authorization: 'Bearer <payment key>',
      signup: { method: 'POST', url: `${apiUrl}/v1/accounts` },
    };
    return {
      body: { ...required, credits },
      headers: (required === undefined
        ? {}
        : { 'payment-required': encodePaymentRequiredHeader(required as never) }) as Record<string, string>,
    };
  };

  /** Why a Base payment is refused, or `undefined` when it is good: what the proxy checks before it would settle. */
  /** The payment's own key, so that it pays once: the EIP-3009 nonce on Base, a hash of the signed delegate action on NEAR. */
  const usedBefore = (key: string): boolean => {
    if (usedPayments.has(key)) return true;
    usedPayments.add(key);
    return false;
  };
  const USED = 'This payment was already used. Request the resource again and sign a new one.';

  /** The payer of a Base payment, or why it is refused: what the proxy checks before it would settle. */
  const checkBase = async (offered: Record<string, unknown>, payload: Record<string, unknown>): Promise<{ payer: string } | string> => {
    const signed = isObject(payload['payload']) ? payload['payload'] : {};
    const authorization = isObject(signed['authorization']) ? signed['authorization'] : undefined;
    const signature = signed['signature'];
    const extra = isObject(offered['extra']) ? offered['extra'] : {};
    if (authorization === undefined || typeof signature !== 'string') return 'The payment is not an EIP-3009 authorization';
    const { from, to, value, validAfter, validBefore, nonce } = authorization;
    if (
      typeof from !== 'string' || typeof to !== 'string' || typeof value !== 'string' || typeof validAfter !== 'string' ||
      typeof validBefore !== 'string' || typeof nonce !== 'string' || !/^[0-9]+$/.test(validAfter) || !/^[0-9]+$/.test(validBefore)
    ) {
      return 'The authorization is missing a field';
    }
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (to.toLowerCase() !== String(offered['payTo']).toLowerCase()) return 'The authorization pays another recipient';
    if (value !== offered['amount']) return 'The authorization pays another amount';
    if (BigInt(validAfter) > now) return 'The authorization is not valid yet';
    if (BigInt(validBefore) <= now) return 'The authorization has expired';
    const valid = await verifyTypedData({
      address: from as `0x${string}`,
      domain: {
        name: String(extra['name']),
        version: String(extra['version']),
        chainId: 8453,
        verifyingContract: offered['asset'] as `0x${string}`,
      },
      types: TRANSFER_WITH_AUTHORIZATION,
      primaryType: 'TransferWithAuthorization',
      message: {
        from: from as `0x${string}`,
        to: to as `0x${string}`,
        value: BigInt(value),
        validAfter: BigInt(validAfter),
        validBefore: BigInt(validBefore),
        nonce: nonce as `0x${string}`,
      },
      signature: signature as `0x${string}`,
    }).catch(() => false);
    if (!valid) return 'The signature is not the payer\'s';
    if (usedBefore(`eip155:8453:${nonce.toLowerCase()}`)) return USED;
    return { payer: from };
  };

  /**
   * The payer of a NEAR payment, or why it is refused, as a facilitator checks it against the chain:
   * one ft_transfer of the asset, of the amount, to the payTo, with one yoctoNEAR, signed with an access
   * key of its sender, and valid for at most the option's blocks.
   */
  const checkNear = (offered: Record<string, unknown>, payload: Record<string, unknown>): { payer: string } | string => {
    const chain = state.nearChain;
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
    if (usedBefore(`near:mainnet:${createHash('sha256').update(Buffer.from(signed, 'base64')).digest('hex')}`)) return USED;
    return { payer: delegate.senderId };
  };

  /** A request with PAYMENT-SIGNATURE: checked as the proxy checks it, then settled, made up, before the answer. */
  const payX402 = async (target: FakeTarget, header: string, response: ServerResponse): Promise<void> => {
    const invalid = (message: string): void => fail(response, 402, 'payment_invalid', message);
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
    const same = (a: unknown, b: unknown): boolean => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
    const offered = (target.x402 ?? []).find(
      (option) =>
        option['scheme'] === accepted['scheme'] &&
        option['network'] === accepted['network'] &&
        same(option['asset'], accepted['asset']) &&
        option['amount'] === accepted['amount'] &&
        same(option['payTo'], accepted['payTo']) &&
        option['maxTimeoutSeconds'] === accepted['maxTimeoutSeconds'] &&
        canonical(option['extra'] ?? {}) === canonical(accepted['extra'] ?? {}),
    );
    if (offered === undefined) {
      invalid("The payment doesn't match an option for this price. Request the resource again for the current options.");
      return;
    }
    const near = offered['network'] === 'near:mainnet';
    const failure = state.nextX402;
    // The rail claims a payer only on NEAR: the in-flight refusal is NEAR's alone
    if (failure !== 'payer_busy' || near) state.nextX402 = undefined;
    if (failure === 'payer_busy' && near) {
      invalid("This payer has another NEAR payment in flight, which this one's nonce would collide with. Pay again once it has settled.");
      return;
    }
    const checked =
      offered['network'] === 'eip155:8453' ? await checkBase(offered, payload) : near ? checkNear(offered, payload) : 'The fake checks Base and NEAR only';
    if (typeof checked === 'string') {
      invalid(checked);
      return;
    }
    if (failure === 'payment_unavailable') {
      fail(response, 503, 'payment_unavailable', 'A payment on NEAR is in flight: retry in a moment', { 'retry-after': '2' });
      return;
    }
    if (failure === 'settlement_failed') {
      fail(response, 502, 'settlement_failed', "The payment couldn't be settled, so the response wasn't sent. Retry the request.");
      return;
    }
    const paid = state.nextPaid ?? { status: 200 };
    state.nextPaid = undefined;
    // Anything but a 2xx cancels the payment: nothing settles
    if (paid.status < 200 || paid.status >= 300) {
      send(response, paid.status, paid.body ?? '', paid.headers);
      return;
    }
    const settled: X402Settled = {
      network: String(offered['network']),
      payer: checked.payer,
      payTo: String(offered['payTo']),
      amount: String(offered['amount']),
      // A made-up transaction hash, in the network's own form
      transaction: near ? base58(randomBytes(32)) : `0x${randomBytes(32).toString('hex')}`,
    };
    x402Settled.push(settled);
    const proof = encodePaymentResponseHeader({
      success: true,
      transaction: settled.transaction,
      network: settled.network as `${string}:${string}`,
      payer: settled.payer,
    });
    send(response, paid.status, paid.body ?? target.answer, { ...(paid.noReceipt === true ? {} : { 'payment-response': proof }), ...paid.headers });
  };

  const pay = (request: IncomingMessage, response: ServerResponse, path: string, urls: { pay: string; api: string }): void => {
    const url = new URL(path, 'http://fake.invalid');
    if (request.method === 'GET' && url.pathname === '/_/check') {
      const link = url.searchParams.get('url') ?? '';
      const target = targets.get(link);
      if (target?.check === undefined) {
        send(response, 200, { payable: false, reason: 'not_payable', message: "The target didn't ask for a payment: Anyfare routes paid calls only" });
        return;
      }
      send(response, 200, {
        payable: true,
        target: link,
        price: { amount: target.check.price, currency: 'USD', asset: target.check.asset, network: target.check.network },
        quote: {
          amount: target.check.quote ?? target.price,
          fee: target.check.fee,
          ...(target.check.currency !== null && { currency: target.check.currency ?? 'USD' }),
        },
        // Like a stack configured for another host: the app must use its own routing link
        link: `https://pay.example.test/${link.replace(/^https:\/\//, '')}`,
      });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/_/key') {
      const key = payment(request, response);
      if (key === undefined) return;
      send(response, 200, {
        ...keyView(key),
        remaining: {
          allowance: key.allowance === undefined ? null : left(key.allowance, key.spentTotal),
          dailyBudget: left(key.dailyBudget, key.spentToday),
          balance: usd(key.account.available),
        },
      });
      return;
    }

    const target = targets.get(`https://${path.slice(1)}`);
    if (target === undefined || target.method !== request.method) {
      fail(response, 400, 'not_payable', "The target didn't ask for a payment: Anyfare routes paid calls only");
      return;
    }
    const signature = request.headers['payment-signature'];
    if (typeof signature === 'string') {
      if (request.headers.authorization !== undefined) {
        fail(response, 400, 'multiple_payment_methods', 'Send exactly one payment credential');
        return;
      }
      void payX402(target, signature, response);
      return;
    }
    if (request.headers.authorization === undefined) {
      const { body, headers } = challenge(target, urls.pay, urls.api);
      send(response, 402, body, { 'cache-control': 'no-store', ...headers });
      return;
    }
    const key = payment(request, response);
    if (key === undefined) return;
    const price = micro(target.price);
    if (key.maxPrice !== undefined && price > key.maxPrice) {
      fail(response, 402, 'key_price_limit', "The price is above the payment key's maximum per call");
      return;
    }
    if (key.account.available < price) {
      fail(response, 402, 'insufficient_balance', "The credits balance doesn't cover the price");
      return;
    }
    if (key.spentToday + price > key.dailyBudget) {
      fail(response, 402, 'key_budget_exceeded', "The payment key's daily budget doesn't cover the price");
      return;
    }
    const paid = state.nextPaid ?? { status: 200 };
    state.nextPaid = undefined;
    // Anything but a 2xx releases the hold: nothing is charged
    if (paid.status < 200 || paid.status >= 300) {
      send(response, paid.status, paid.body ?? '', paid.headers);
      return;
    }
    key.account.available -= price;
    key.spentToday += price;
    key.spentTotal += price;
    const receipt: Record<string, string> =
      paid.noReceipt === true ? {} : { 'anyfare-receipt': `id="pay_madeup${next()}", amount="${usd(price)}", currency="USD"` };
    send(response, paid.status, paid.body ?? target.answer, { ...receipt, ...paid.headers });
  };

  const urls = { api: '', pay: '' };
  const listen = (host: 'api' | 'pay'): Promise<Server> => {
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const path = request.url ?? '/';
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(request.headers)) {
          if (typeof value === 'string') headers[name] = value;
        }
        requests.push({ host, method: request.method ?? 'GET', path, headers, body });
        if (host === 'api') api(request, response, path, body);
        else pay(request, response, path, urls);
      });
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
  };

  const apiServer = await listen('api');
  const payServer = await listen('pay');
  urls.api = `http://127.0.0.1:${(apiServer.address() as AddressInfo).port}`;
  urls.pay = `http://127.0.0.1:${(payServer.address() as AddressInfo).port}`;

  const close = (server: Server): Promise<void> =>
    new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });

  return {
    apiUrl: urls.api,
    payUrl: urls.pay,
    requests,
    get startingBalance() {
      return state.startingBalance;
    },
    set startingBalance(value: string) {
      state.startingBalance = value;
    },
    get rateLimitSignup() {
      return state.rateLimitSignup;
    },
    set rateLimitSignup(value: boolean) {
      state.rateLimitSignup = value;
    },
    get nextPaid() {
      return state.nextPaid;
    },
    set nextPaid(value: PaidAnswer | undefined) {
      state.nextPaid = value;
    },
    get nextX402() {
      return state.nextX402;
    },
    set nextX402(value: X402Failure | undefined) {
      state.nextX402 = value;
    },
    get nearChain() {
      return state.nearChain;
    },
    set nearChain(value: NearChain | undefined) {
      state.nearChain = value;
    },
    x402Settled,
    get rewrite() {
      return state.rewrite;
    },
    get during() {
      return state.during;
    },
    addAccount: (balance = '0') => makeAccount(balance),
    addKey: (account, limits = {}) => makeKey(account, limits),
    account: (masterKey) => accounts.get(masterKey),
    addTarget: (target) => {
      targets.set(target.url, target);
    },
    routed: () => requests.filter((item) => item.host === 'pay' && !item.path.startsWith('/_/')),
    x402Requests: () =>
      requests.filter((item) => item.host === 'pay' && !item.path.startsWith('/_/') && item.headers['payment-signature'] !== undefined),
    reset: () => {
      requests.length = 0;
      accounts.clear();
      keys.clear();
      targets.clear();
      x402Settled.length = 0;
      usedPayments.clear();
      state.nearChain = undefined;
      state.nextX402 = undefined;
      state.startingBalance = '0';
      state.rateLimitSignup = false;
      state.nextPaid = undefined;
      state.rewrite = {};
      state.during = {};
    },
    close: async () => {
      await Promise.all([close(apiServer), close(payServer)]);
    },
  };
}

/**
 * A fetch that sends requests to 127.0.0.1, the fake Anyfare, to the real fetch, and answers the API
 * hosts by method and URL, as `fakeFetch` does. It keeps the calls to the API hosts only.
 */
export function forwardingFetch(routes: Readonly<Record<string, () => Response>>): { fetch: Fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (new URL(url).hostname === '127.0.0.1') return globalThis.fetch(input, init);
    const method = init?.method ?? 'GET';
    calls.push({
      method,
      url,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    const route = routes[`${method} ${url}`];
    if (route === undefined) throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } });
    return route();
  }) as Fetch;
  return { fetch: fetchFn, calls };
}

export const CMC_URL = 'https://pro-api.coinmarketcap.com/x402/v3/cryptocurrency/quotes/latest?symbol=BTC&convert=USD';
export const ROUTE_URL =
  'https://api.3route.io/v1/8453/quote?src=0x833589fcd6edb6e08f4c7c32d4f71b54bda02913&dst=0x4200000000000000000000000000000000000006&amount=1000000&includeBlockNumber=true';
export const EVIDENCE_URL = 'https://merchant-near.mikedotexe.com/v1/evidence/account';

/** The API hosts' own unpaid answers, and 3Route's token list, from the recorded fixtures. */
export function toolRoutes(): Record<string, () => Response> {
  return {
    [`GET ${CMC_URL}`]: () => answerOf('cmc-402.json'),
    'GET https://api.3route.io/v1/8453/tokens': () => answerOf('3route-tokens.json'),
    [`GET ${ROUTE_URL}`]: () => answerOf('3route-402.json'),
    [`POST ${EVIDENCE_URL}`]: () => answerOf('evidence-402.json'),
  };
}

function paidAnswer(name: string): unknown {
  const { note: _note, ...body } = fixture(name);
  return body;
}

/** The three tools as targets of the fake. The prices and fees are made up, dated 2026-11-09. */
export function toolTargets(): Record<'cmc' | '3route' | 'evidence', FakeTarget> {
  return {
    cmc: {
      url: CMC_URL,
      method: 'GET',
      price: '0.011',
      check: { price: '0.01', fee: '0.001', asset: 'base-usdc', network: 'eip155:8453' },
      answer: paidAnswer('cmc-paid.json'),
    },
    '3route': {
      url: ROUTE_URL,
      method: 'GET',
      price: '0.0012',
      check: { price: '0.001', fee: '0.0002', asset: 'base-usdc', network: 'eip155:8453' },
      answer: paidAnswer('3route-paid.json'),
    },
    evidence: { url: EVIDENCE_URL, method: 'POST', price: '0.002', answer: paidAnswer('evidence-paid.json') },
  };
}
