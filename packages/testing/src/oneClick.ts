import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { encodeBase58 } from './solanaRpc.js';

// A fake of the 1Click API of NEAR Intents, answering as 1Click does: GET /v0/tokens, POST /v0/quote and
// GET /v0/status. Quotes are computed simply: the input's USD value at the token's price, less 1 basis
// point, delivered 1:1 in the destination's units.

export type FakeOneClickPath = '/v0/tokens' | '/v0/quote' | '/v0/status';

export interface FakeOneClickRequest {
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly headers: IncomingHttpHeaders;
  // The parsed JSON body, or undefined
  readonly body: unknown;
}

/**
 * A scripted answer. `body` is sent as JSON, `raw` as it is. `chunked` sends it in pieces without a
 * content-length. `delayMs` holds it back, such as past the client's timeout. `destroy` cuts the
 * connection without an answer.
 */
export interface FakeOneClickAnswer {
  readonly status: number;
  readonly body?: unknown;
  readonly raw?: string;
  readonly chunked?: boolean;
  readonly delayMs?: number;
  readonly destroy?: boolean;
}

// Undefined: the default answer
export type FakeOneClickScript = (request: FakeOneClickRequest) => FakeOneClickAnswer | undefined;

export interface FakeOneClickToken {
  readonly assetId: string;
  readonly decimals: number;
  readonly blockchain: string;
  readonly symbol: string;
  readonly price: number;
  readonly priceUpdatedAt: string;
  readonly contractAddress?: string;
}

export const fakeOneClickStatuses = ['KNOWN_DEPOSIT_TX', 'PENDING_DEPOSIT', 'INCOMPLETE_DEPOSIT', 'PROCESSING', 'SUCCESS', 'REFUNDED', 'FAILED'] as const;
export type FakeOneClickStatus = typeof fakeOneClickStatuses[number];

/** A real quote the fake answered, as it answered it. */
export interface FakeOneClickQuote {
  readonly correlationId: string;
  readonly timestamp: string;
  readonly signature: string;
  readonly quoteRequest: Readonly<Record<string, unknown>>;
  readonly quote: Readonly<Record<string, unknown>> & {
    readonly amountIn: string;
    readonly minAmountIn: string;
    readonly amountOut: string;
    readonly minAmountOut: string;
    readonly depositAddress: string;
    readonly depositMemo?: string;
    readonly deadline: string;
    readonly timeWhenInactive: string;
  };
}

export interface FakeOneClick {
  readonly url: string;
  // Every request, in order
  readonly requests: readonly FakeOneClickRequest[];
  /** Scripts one path until `reset`. A script that answers undefined leaves the request to the default. */
  handle(path: FakeOneClickPath, script: FakeOneClickScript): void;
  /** Back to the default answers. Remembered quotes stay. */
  reset(): void;
  // The real quotes answered, in order
  quotes(): readonly FakeOneClickQuote[];
  /**
   * Moves a remembered quote's swap to a status. Its swapDetails are filled from the quote as 1Click
   * fills them for that status; `swapDetails` overrides any field.
   */
  setStatus(depositAddress: string, status: FakeOneClickStatus, swapDetails?: Readonly<Record<string, unknown>>): void;
  close(): Promise<void>;
}

export interface FakeOneClickOptions {
  // Default: defaultOneClickTokens
  readonly tokens?: readonly FakeOneClickToken[];
  // A quote for less, in the origin's atomic units, is too low for the bridge. Default: 150000.
  readonly minAmount?: bigint;
  // For timestamps. Default: the system clock.
  readonly now?: () => Date;
  // The port to listen on. Default: a free one.
  readonly port?: number;
  // Turns on POST /_test/status and GET /_test/quotes, which move a remembered quote's swap to a status from
  // outside the process, and list the quotes. Neither is a 1Click path, and neither is added to `requests`.
  // Default: false, and both paths answer as any unknown path does.
  readonly controls?: boolean;
}

const priceUpdatedAt = '2026-11-09T01:23:00.857Z';

// USDC on NEAR testnet: the near-usdc asset of config/example.yaml. 1Click has no testnet tokens; the
// fake lists it so a quote to it works, under its own symbol so USDC on NEAR stays unambiguous.
export const testnetNearUsdcAddress = '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af';

/** Real entries of 1Click's token list, two USDC on hypercore among them, and USDC on NEAR testnet. */
export const defaultOneClickTokens: readonly FakeOneClickToken[] = [
  { assetId: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near', decimals: 6, blockchain: 'base', symbol: 'USDC', price: 0.99948, priceUpdatedAt, contractAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' },
  { assetId: 'nep141:base.omft.near', decimals: 18, blockchain: 'base', symbol: 'ETH', price: 2132.98, priceUpdatedAt },
  { assetId: 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near', decimals: 6, blockchain: 'arb', symbol: 'USDC', price: 0.99948, priceUpdatedAt, contractAddress: '0xaf88d065e77c8cc2239327c5edb3a432268e5831' },
  { assetId: 'nep141:sol.omft.near', decimals: 9, blockchain: 'sol', symbol: 'SOL', price: 87.37, priceUpdatedAt },
  { assetId: 'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near', decimals: 6, blockchain: 'sol', symbol: 'USDC', price: 0.99948, priceUpdatedAt, contractAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
  { assetId: 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', decimals: 6, blockchain: 'near', symbol: 'USDC', price: 0.99948, priceUpdatedAt, contractAddress: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1' },
  { assetId: 'nep141:wrap.near', decimals: 24, blockchain: 'near', symbol: 'wNEAR', price: 3.61, priceUpdatedAt, contractAddress: 'wrap.near' },
  { assetId: 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near', decimals: 6, blockchain: 'eth', symbol: 'USDC', price: 0.99948, priceUpdatedAt, contractAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' },
  { assetId: 'nep141:btc.omft.near', decimals: 8, blockchain: 'btc', symbol: 'BTC', price: 74999, priceUpdatedAt },
  { assetId: '1cs_v1:hypercore:hip1:0x6d1e7cde53ba9467b783cb7c530ce054', decimals: 8, blockchain: 'hypercore', symbol: 'USDC', price: 0.99948, priceUpdatedAt, contractAddress: '0x6d1e7cde53ba9467b783cb7c530ce054' },
  { assetId: '1cs_v1:hypercore:erc20:0xb88339CB7199b77E23DB6E890353E22632Ba630f', decimals: 6, blockchain: 'hypercore', symbol: 'USDC', price: 0.99948, priceUpdatedAt, contractAddress: '0xb88339CB7199b77E23DB6E890353E22632Ba630f' },
  { assetId: `nep141:${testnetNearUsdcAddress}`, decimals: 6, blockchain: 'near', symbol: 'tUSDC', price: 1, priceUpdatedAt, contractAddress: testnetNearUsdcAddress },
];

// The fields a quote request must carry
const requiredQuoteFields = [
  'dry', 'swapType', 'slippageTolerance', 'originAsset', 'depositType', 'destinationAsset', 'amount', 'refundTo', 'refundType', 'recipient', 'recipientType', 'deadline',
] as const;

const usdScale = 12;
const bech32Alphabet = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

// A price as an integer at 12 decimals
const scaledPrice = (price: number): bigint => {
  const [whole = '0', fraction = ''] = price.toFixed(usdScale).split('.');

  return BigInt(whole) * 10n ** BigInt(usdScale) + BigInt(fraction.padEnd(usdScale, '0'));
};

// All the decimals, as 1Click writes USD values: 0.999480000000
const formatFixed = (value: bigint, decimals: number): string => {
  const unit = 10n ** BigInt(decimals);
  const fraction = (value % unit).toString().padStart(decimals, '0');

  return decimals === 0 ? (value / unit).toString() : `${value / unit}.${fraction}`;
};

// Trailing zeros dropped, one kept, as 1Click writes formatted amounts: 1.0, 0.999798
const formatAmount = (value: bigint, decimals: number): string => {
  const unit = 10n ** BigInt(decimals);
  const fraction = decimals === 0 ? '' : (value % unit).toString().padStart(decimals, '0').replace(/0+$/, '');

  return `${value / unit}.${fraction || '0'}`;
};

const usdOf = (amount: bigint, token: FakeOneClickToken): bigint => amount * scaledPrice(token.price) / 10n ** BigInt(token.decimals);

const isEvm = (blockchain: string): boolean => !['sol', 'near', 'btc'].includes(blockchain);

/** A new deposit address in the origin chain's form. */
const depositAddressOn = (blockchain: string): string => {
  switch (blockchain) {
    case 'sol': return encodeBase58(randomBytes(32));
    // An implicit account
    case 'near': return randomBytes(32).toString('hex');
    case 'btc': return `bc1q${Array.from(randomBytes(38), byte => bech32Alphabet[byte % 32]).join('')}`;
    default: return `0x${randomBytes(20).toString('hex')}`;
  }
};

/** A transaction hash in the chain's form. */
const transactionOn = (blockchain: string): string => {
  if (blockchain === 'sol')
    return encodeBase58(randomBytes(64));
  if (blockchain === 'near')
    return encodeBase58(randomBytes(32));

  return isEvm(blockchain) ? `0x${randomBytes(32).toString('hex')}` : randomBytes(32).toString('hex');
};

const nearHash = (): string => encodeBase58(randomBytes(32));

interface Remembered {
  readonly quote: FakeOneClickQuote;
  status: FakeOneClickStatus;
  swapDetails: Readonly<Record<string, unknown>>;
  updatedAt: string;
}

const pendingDetails = (): Readonly<Record<string, unknown>> => ({
  intentHashes: [],
  nearTxHashes: [],
  originChainTxHashes: [],
  destinationChainTxHashes: [],
  depositedAmount: null,
  depositedAmountFormatted: null,
  depositedAmountUsd: null,
  amountIn: null,
  amountInFormatted: null,
  amountInUsd: null,
  amountOut: null,
  amountOutFormatted: null,
  amountOutUsd: null,
  slippage: null,
  refundedAmount: null,
  refundedAmountFormatted: null,
  refundedAmountUsd: null,
  refundReason: null,
});

/**
 * A fake 1Click on 127.0.0.1 that records every request. A real quote gets a new deposit address in its
 * origin chain's form and is remembered, with its status at PENDING_DEPOSIT until `setStatus` moves it.
 * A dry quote has no address and is forgotten.
 */
export const startFakeOneClick = async ({ tokens = defaultOneClickTokens, minAmount = 150_000n, now = () => new Date(), port: listenPort = 0, controls = false }: FakeOneClickOptions = {}): Promise<FakeOneClick> => {
  const requests: FakeOneClickRequest[] = [];
  const remembered = new Map<string, Remembered>();
  let scripts: Partial<Record<FakeOneClickPath, FakeOneClickScript>> = {};
  const timers = new Set<NodeJS.Timeout>();
  const tokenOf = (assetId: unknown): FakeOneClickToken | undefined => tokens.find(token => token.assetId === assetId);

  const validationError = (message: string): FakeOneClickAnswer => ({ status: 400, body: { message, error: 'Bad Request', statusCode: 400 } });
  const logicError = (status: number, message: string, path: string): FakeOneClickAnswer => ({
    status, body: { message, correlationId: randomUUID(), timestamp: now().toISOString(), path },
  });

  const quote = (request: FakeOneClickRequest): FakeOneClickAnswer => {
    if (!isRecord(request.body))
      return validationError('The body must be a JSON object');
    const body = request.body;
    const missing = requiredQuoteFields.filter(field => body[field] === undefined || body[field] === null || body[field] === '');
    if (missing.length > 0)
      return validationError(missing.map(field => `${field} should not be empty`).join(', '));
    if (typeof body['dry'] !== 'boolean')
      return validationError('dry must be a boolean value');
    if (typeof body['amount'] !== 'string' || !/^[0-9]+$/.test(body['amount']))
      return validationError('amount must be an integer string');
    const slippage = body['slippageTolerance'];
    if (typeof slippage !== 'number' || !Number.isInteger(slippage) || slippage < 0 || slippage > 10_000)
      return validationError('slippageTolerance must be a number from 0 to 10000');
    if (typeof body['deadline'] !== 'string' || !Number.isFinite(Date.parse(body['deadline'])))
      return validationError('deadline must be a valid ISO 8601 date string');
    const origin = tokenOf(body['originAsset']);
    const destination = tokenOf(body['destinationAsset']);
    if (!origin)
      return logicError(400, `Asset ${String(body['originAsset'])} is not supported`, '/v0/quote');
    if (!destination)
      return logicError(400, `Asset ${String(body['destinationAsset'])} is not supported`, '/v0/quote');
    const amountIn = BigInt(body['amount']);
    if (amountIn < minAmount)
      return logicError(400, `Amount is too low for bridge, try at least ${minAmount}`, '/v0/quote');

    const kept = BigInt(10_000 - slippage);
    const usdIn = usdOf(amountIn, origin);
    const amountOut = usdIn * 9_999n / 10_000n * 10n ** BigInt(destination.decimals) / 10n ** BigInt(usdScale);
    const real = !body['dry'];
    const deadline = new Date(Date.parse(body['deadline']) + 72 * 3_600_000).toISOString();
    const memo = real && body['depositMode'] === 'MEMO' ? String(randomInt(100_000_000, 1_000_000_000)) : undefined;
    const answer: FakeOneClickQuote = {
      quote: {
        amountIn: amountIn.toString(),
        amountInFormatted: formatAmount(amountIn, origin.decimals),
        amountInUsd: formatFixed(usdIn, usdScale),
        minAmountIn: (amountIn * kept / 10_000n).toString(),
        amountOut: amountOut.toString(),
        amountOutFormatted: formatAmount(amountOut, destination.decimals),
        amountOutUsd: formatFixed(usdOf(amountOut, destination), usdScale),
        minAmountOut: (amountOut * kept / 10_000n).toString(),
        ...real ? { depositAddress: depositAddressOn(origin.blockchain), ...memo === undefined ? {} : { depositMemo: memo }, timeWhenInactive: deadline, deadline } : {},
        timeEstimate: 35,
        refundFee: '0',
        withdrawFee: '0',
      } as FakeOneClickQuote['quote'],
      quoteRequest: { ...body, depositMode: body['depositMode'] ?? 'SIMPLE', confidentiality: 'public' },
      signature: `ed25519:${encodeBase58(randomBytes(64))}`,
      timestamp: now().toISOString(),
      correlationId: randomUUID(),
    };
    if (real)
      remembered.set(answer.quote.depositAddress, { quote: answer, status: 'PENDING_DEPOSIT', swapDetails: pendingDetails(), updatedAt: answer.timestamp });

    return { status: 201, body: answer };
  };

  const status = (request: FakeOneClickRequest): FakeOneClickAnswer => {
    const { depositAddress, depositMemo } = request.query;
    if (!depositAddress)
      return validationError('depositAddress should not be empty');
    const entry = remembered.get(depositAddress);
    if (!entry || (entry.quote.quote.depositMemo !== undefined && depositMemo !== undefined && depositMemo !== entry.quote.quote.depositMemo))
      return { status: 404, body: { message: `Deposit address ${depositAddress} not found` } };
    const { correlationId, ...quoteResponse } = entry.quote;

    return {
      status: 200,
      body: { correlationId, quoteResponse, status: entry.status, updatedAt: entry.updatedAt, swapDetails: entry.swapDetails },
    };
  };

  const defaults: Record<FakeOneClickPath, (request: FakeOneClickRequest) => FakeOneClickAnswer> = {
    '/v0/tokens': () => ({ status: 200, body: tokens }),
    '/v0/quote': quote,
    '/v0/status': status,
  };

  // What 1Click fills in for each status, from the remembered quote
  const detailsFor = (entry: Remembered, next: FakeOneClickStatus): Readonly<Record<string, unknown>> => {
    const { quoteRequest, quote: answered } = entry.quote;
    const origin = tokenOf(quoteRequest['originAsset'])!;
    const destination = tokenOf(quoteRequest['destinationAsset'])!;
    const amountIn = BigInt(answered.amountIn);
    const amountOut = BigInt(answered.amountOut);
    const deposited = (amount: bigint) => ({
      depositedAmount: amount.toString(), depositedAmountFormatted: formatAmount(amount, origin.decimals), depositedAmountUsd: formatFixed(usdOf(amount, origin), usdScale),
    });
    const transaction = () => ({ hash: transactionOn(origin.blockchain), explorerUrl: '' });

    switch (next) {
      case 'PENDING_DEPOSIT':
        return pendingDetails();
      case 'KNOWN_DEPOSIT_TX':
        return { ...pendingDetails(), originChainTxHashes: [transaction()] };
      case 'INCOMPLETE_DEPOSIT':
        return { ...pendingDetails(), ...deposited(BigInt(answered.minAmountIn) / 2n), nearTxHashes: [nearHash()] };
      case 'PROCESSING':
        return { ...pendingDetails(), ...deposited(amountIn), originChainTxHashes: [transaction()], nearTxHashes: [nearHash()] };
      case 'SUCCESS': {
        const nearTransaction = nearHash();

        return {
          ...deposited(amountIn),
          intentHashes: [nearHash()],
          nearTxHashes: [nearTransaction],
          amountIn: amountIn.toString(),
          amountInFormatted: formatAmount(amountIn, origin.decimals),
          amountInUsd: formatFixed(usdOf(amountIn, origin), usdScale),
          amountOut: amountOut.toString(),
          amountOutFormatted: formatAmount(amountOut, destination.decimals),
          amountOutUsd: formatFixed(usdOf(amountOut, destination), usdScale),
          slippage: 0,
          refundedAmount: '0',
          refundedAmountFormatted: '0',
          refundedAmountUsd: '0',
          refundReason: null,
          refundFee: '0',
          withdrawFee: '0',
          originChainTxHashes: [transaction()],
          destinationChainTxHashes: [{ hash: nearTransaction, explorerUrl: '' }],
        };
      }
      case 'REFUNDED':
        return {
          ...pendingDetails(),
          ...deposited(amountIn),
          refundedAmount: amountIn.toString(),
          refundedAmountFormatted: formatAmount(amountIn, origin.decimals),
          refundedAmountUsd: formatFixed(usdOf(amountIn, origin), usdScale),
          refundReason: 'The swap could not complete before the deadline',
          refundFee: '0',
          originChainTxHashes: [transaction()],
          nearTxHashes: [nearHash()],
          // The refund's transaction
          destinationChainTxHashes: [{ hash: nearHash(), explorerUrl: '' }],
        };
      case 'FAILED':
        return { ...pendingDetails(), ...deposited(amountIn) };
    }
  };

  const send = (request: IncomingMessage, response: ServerResponse, answer: FakeOneClickAnswer): void => {
    if (response.destroyed)
      return;
    if (answer.destroy) {
      request.socket.destroy();
      return;
    }
    const payload = Buffer.from(answer.raw ?? (answer.body === undefined ? '' : JSON.stringify(answer.body)), 'utf8');
    const contentType = answer.raw === undefined ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8';
    if (answer.chunked) {
      response.writeHead(answer.status, { 'content-type': contentType });
      for (let offset = 0; offset < payload.length; offset += 64 * 1024)
        response.write(payload.subarray(offset, offset + 64 * 1024));
      response.end();
      return;
    }
    response.writeHead(answer.status, { 'content-type': contentType, 'content-length': payload.length });
    response.end(payload);
  };

  // The control: POST /_test/status moves a swap, GET /_test/quotes lists the remembered quotes
  const control = (method: string, path: string, body: unknown): FakeOneClickAnswer | undefined => {
    if (method === 'GET' && path === '/_test/quotes')
      return { status: 200, body: [...remembered.entries()].map(([depositAddress, entry]) => ({ depositAddress, status: entry.status })) };
    if (method !== 'POST' || path !== '/_test/status')
      return undefined;
    if (!isRecord(body))
      return validationError('The body must be a JSON object');
    const { depositAddress, status: next, swapDetails } = body;
    if (typeof depositAddress !== 'string' || depositAddress === '')
      return validationError('depositAddress must be a non-empty string');
    if (typeof next !== 'string' || !(fakeOneClickStatuses as readonly string[]).includes(next))
      return validationError(`status must be one of ${fakeOneClickStatuses.join(', ')}`);
    if (swapDetails !== undefined && !isRecord(swapDetails))
      return validationError('swapDetails must be a JSON object');
    const entry = remembered.get(depositAddress);
    if (!entry)
      return { status: 404, body: { message: `Deposit address ${depositAddress} not found` } };
    entry.status = next as FakeOneClickStatus;
    entry.swapDetails = { ...detailsFor(entry, entry.status), ...swapDetails };
    entry.updatedAt = now().toISOString();

    return { status: 200, body: { depositAddress, status: next } };
  };

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      let body: unknown;
      try {
        body = text ? JSON.parse(text) : undefined;
      }
      catch {
        body = undefined;
      }
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const recorded: FakeOneClickRequest = {
        method: request.method ?? '', path: url.pathname, query: Object.fromEntries(url.searchParams), headers: request.headers, body,
      };
      const controlled = controls ? control(recorded.method, recorded.path, body) : undefined;
      if (controlled) {
        send(request, response, controlled);
        return;
      }
      requests.push(recorded);
      const path = recorded.path as FakeOneClickPath;
      const known = Object.hasOwn(defaults, path) && recorded.method === (path === '/v0/quote' ? 'POST' : 'GET');
      const answer = known
        ? scripts[path]?.(recorded) ?? defaults[path](recorded)
        : { status: 404, body: { message: `Cannot ${recorded.method} ${recorded.path}`, error: 'Not Found', statusCode: 404 } };
      if (answer.delayMs) {
        const timer = setTimeout(() => {
          timers.delete(timer);
          send(request, response, answer);
        }, answer.delayMs);
        timers.add(timer);
      }
      else
        send(request, response, answer);
    });
  });
  await new Promise<void>(resolve => server.listen(listenPort, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    handle: (path, script) => {
      scripts = { ...scripts, [path]: script };
    },
    reset: () => {
      scripts = {};
    },
    quotes: () => [...remembered.values()].map(entry => entry.quote),
    setStatus: (depositAddress, next, swapDetails = {}) => {
      const entry = remembered.get(depositAddress);
      if (!entry)
        throw new Error(`The fake 1Click made no quote with the deposit address ${depositAddress}`);
      entry.status = next;
      entry.swapDetails = { ...detailsFor(entry, next), ...swapDetails };
      entry.updatedAt = now().toISOString();
    },
    close: async () => {
      for (const timer of timers)
        clearTimeout(timer);
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
};
