import { Counter, type Registry } from '@prometheus-io/client';

import {
  AnyfareError, atomicToUsd, formatUsd, isRecord, type Clock, type IdGenerator, type LogSink, type MicroUsd, type RequestId,
} from '@anyfare/common';
import type { JsonObject, KeyPrefixes, PlatformConfig, TopupNetwork } from '@anyfare/core';
import { createTopupRepository, type Database, type Topup, type TopupPage } from '@anyfare/db';
import {
  buildQuoteRequest, formatTokenAmount, OneClickRefusedError, OneClickUnavailableError, parseTokenAmount, type OneClickClient,
  type OneClickDepositQuoteResponse, type OneClickQuoteRequest, type OneClickQuoteResponse, type OneClickToken, type TokenCatalog,
} from '@anyfare/topups';

import { NotFoundError } from '../errors.js';

export const topupIdPrefix = 'top_';
// What a top-up's ID looks like: anything else is no top-up of ours
const topupIdPattern = /^top_[A-Za-z0-9-]{1,64}$/;
// When the status job first asks 1Click about a new top-up
const firstPollDelayMs = 10_000;

/** What came of a request for a top-up that reached 1Click, or would have. */
export const topupResults = ['created', 'refused', 'unknown', 'too_small', 'unavailable'] as const;
export type TopupResult = typeof topupResults[number];

/** Top-ups are off, or 1Click didn't answer. Nothing was made that could take a transfer. */
export class TopupsUnavailableError extends AnyfareError {
  readonly code = 'topups_unavailable';
}

/** The client named a network top-ups don't come from. */
export class UnsupportedNetworkError extends AnyfareError {
  readonly code = 'unsupported_network';
}

/** The token the client named holds one of our keys: refused without a lookup, and never echoed. */
export class KeyAsTokenError extends AnyfareError {
  readonly code = 'unknown_token';
}

/** 1Click refused the quote. No deposit address was made. */
export class TopupRefusedError extends AnyfareError {
  readonly code = 'topup_refused';
}

/** 1Click's quote didn't match what we asked for, so its address was never given out. */
export class TopupMismatchError extends AnyfareError {
  readonly code = 'topup_mismatch';
}

/** The top-up is worth less than its network's minimum. */
export class AmountTooSmallError extends AnyfareError {
  readonly code = 'amount_too_small';
}

export interface NewTopupInput {
  readonly accountId: string;
  readonly requestId: RequestId;
  // Our name for the network, such as base
  readonly network: string;
  // A symbol, a contract address or a 1Click asset ID
  readonly token: string;
  // In the token's units, such as 1.5
  readonly amount: string;
  // The request's logger
  readonly log: LogSink;
}

/** A network a top-up may come from, with the tokens 1Click takes on it, or undefined when its list can't be read. */
export interface TopupNetworkOptions {
  readonly network: TopupNetwork;
  readonly tokens: readonly OneClickToken[] | undefined;
}

export interface TopupService {
  /** The networks in config order, with their tokens. A token list that can't be read leaves every network's tokens undefined. */
  options(log: LogSink): Promise<readonly TopupNetworkOptions[]>;
  /**
   * Checks the request against a dry quote, records the top-up, then asks 1Click once for its deposit
   * address. Returns the top-up `waiting` for the transfer. Throws UnsupportedNetworkError,
   * UnknownTokenError, AmbiguousTokenError, InvalidAmountError, AmountTooSmallError and TopupRefusedError
   * for a request that can't be taken, TopupsUnavailableError when 1Click doesn't answer, and
   * TopupMismatchError when its answer isn't for what we asked.
   */
  create(input: NewTopupInput): Promise<Topup>;
  /** The account's own top-up. Throws NotFoundError for another account's or an unknown ID. */
  get(input: { readonly accountId: string; readonly id: string }): Promise<Topup>;
  /**
   * The account's own top-ups, every status, newest first. `after` is the `next` of the page before; one no page gave
   * throws an `invalid_request` error.
   */
  list(input: { readonly accountId: string; readonly limit: number; readonly after?: string }): Promise<TopupPage>;
}

export interface TopupServiceOptions {
  readonly db: Database;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly config: PlatformConfig['topups'];
  // A token that holds one of these is a key sent by mistake
  readonly keyPrefixes: KeyPrefixes;
  readonly oneClick: Pick<OneClickClient, 'quote'>;
  readonly tokens: TokenCatalog;
  // What came of each request. Default: none.
  readonly record?: (result: TopupResult) => void;
}

const unavailableMessage = '1Click, which makes deposit addresses, didn\'t answer. Nothing to send. Try again';

// The most the fees 1Click's answer names may add up to, in basis points
const maxAppFeesBps = 100;

// What a log line keeps of a value 1Click sent
const maxLoggedLength = 128;

/**
 * A USD decimal string from 1Click, such as `"0.999480000000"`, to the nearest cent, half up, in
 * micro-USD. 1Click prices a stablecoin a little under $1, so 1 USDC must still count as $1.
 */
export const toNearestCent = (usd: string): MicroUsd => {
  const [whole = '0', fraction = ''] = usd.split('.');
  const digits = fraction.padEnd(3, '0');
  const cents = BigInt(whole) * 100n + BigInt(digits.slice(0, 2)) + (Number(digits[2]) >= 5 ? 1n : 0n);

  return cents * 10_000n;
};

// Whole cents, always with two decimals, such as 0.50
const formatCents = (amount: MicroUsd): string => `${amount / 1_000_000n}.${(amount / 10_000n % 100n).toString().padStart(2, '0')}`;

const clip = (value: unknown): unknown => typeof value === 'string' ? value.slice(0, maxLoggedLength) : value;

// The app fees in the answer, in basis points in all: 0 for none, undefined for a value that isn't a list of fees
const appFeesOf = (value: unknown): number | undefined => {
  if (value === undefined || value === null)
    return 0;
  if (!Array.isArray(value))
    return undefined;
  let total = 0;
  for (const entry of value) {
    const fee = isRecord(entry) ? entry['fee'] : undefined;
    if (typeof fee !== 'number' || !Number.isFinite(fee) || fee < 0)
      return undefined;
    total += fee;
  }

  return total;
};

interface Mismatch {
  readonly reason: string;
  readonly expected?: unknown;
  readonly received?: unknown;
}

/**
 * Why a real quote's answer isn't for the request we sent, or undefined when it is. Its quoteRequest
 * must echo every field we sent; 1Click adds fields to it, but never drops ours. Its app fees may add
 * up to 100 basis points, and its amounts must be the amount we asked to send.
 */
const mismatchOf = (request: OneClickQuoteRequest, answer: OneClickQuoteResponse): Mismatch | undefined => {
  const echo = answer.raw['quoteRequest'];
  if (!isRecord(echo))
    return { reason: 'The answer has no quoteRequest' };
  for (const [field, sent] of Object.entries(request)) {
    const echoed = echo[field];
    const same = field === 'deadline'
      // The same moment, however 1Click writes it
      ? typeof echoed === 'string' && Date.parse(echoed) === Date.parse(String(sent))
      : echoed === sent;
    if (!same)
      return { reason: `The answer's quoteRequest.${field} isn't the one asked for`, expected: sent, received: clip(echoed) };
  }
  const fees = appFeesOf(echo['appFees']);
  if (fees === undefined)
    return { reason: 'The answer\'s quoteRequest.appFees isn\'t a list of fees' };
  if (fees > maxAppFeesBps)
    return { reason: `The answer's app fees add up to ${fees} basis points, more than ${maxAppFeesBps}`, expected: maxAppFeesBps, received: fees };

  const { quote } = answer;
  if (quote.depositAddress === undefined)
    return { reason: 'The quote has no deposit address' };
  if (quote.deadline === undefined)
    return { reason: 'The quote has no deadline' };
  if (BigInt(quote.amountIn) !== BigInt(request.amount))
    return { reason: 'The quote\'s amountIn isn\'t the amount asked for', expected: request.amount, received: quote.amountIn };
  if (BigInt(quote.minAmountIn) > BigInt(quote.amountIn))
    return { reason: 'The quote\'s minAmountIn is more than its amountIn', expected: quote.amountIn, received: quote.minAmountIn };
  if (BigInt(quote.minAmountOut) > BigInt(quote.amountOut))
    return { reason: 'The quote\'s minAmountOut is more than its amountOut', expected: quote.amountOut, received: quote.minAmountOut };

  return undefined;
};

const changed = (topup: Topup | undefined, id: string): Topup => {
  if (!topup)
    throw new Error(`The top-up ${id} is no longer quoting, so its quote can't be recorded`);

  return topup;
};

/**
 * Top-ups through 1Click. A dry quote checks the request first, and nothing is recorded for a request
 * it refuses. Then the top-up is recorded as `quoting` before its one real quote, which is never
 * repeated: 1Click has no idempotency key, and a second quote makes a second address.
 */
export const createTopupService = ({
  db,
  clock,
  ids,
  config,
  keyPrefixes,
  oneClick,
  tokens,
  record = () => undefined,
}: TopupServiceOptions): TopupService => {
  const topups = createTopupRepository({ db, clock });
  const networkNames = config.networks.map(network => network.name).join(', ');

  // 1Click didn't answer before anything was recorded: no address can exist
  const unavailable = (log: LogSink, error: OneClickUnavailableError, step: string): TopupsUnavailableError => {
    log.warn({ step, reason: error.reason, error }, '1Click didn\'t answer, so no top-up was made');
    record('unavailable');

    return new TopupsUnavailableError(unavailableMessage);
  };

  // Anywhere in the token, in any case: the catalog's refusal would echo it
  const keyMarks = [keyPrefixes.master, keyPrefixes.payment].map(prefix => prefix.toLowerCase());

  /**
   * A write after the real quote. If it fails, the top-up stays `quoting` and 1Click's answer is
   * stored nowhere but this line, so it names what an operator needs before the error goes on.
   */
  const recordOutcome = async (write: () => Promise<Topup | undefined>, facts: Readonly<Record<string, unknown>>, log: LogSink): Promise<Topup> => {
    try {
      return changed(await write(), String(facts['topupId']));
    }
    catch (error) {
      log.error({ ...facts, error }, 'A top-up\'s quote could not be recorded, so it stays quoting. An operator should look at it');
      throw error;
    }
  };

  const resolveToken = async (network: TopupNetwork, query: string, log: LogSink): Promise<OneClickToken> => {
    const lowered = query.toLowerCase();
    if (keyMarks.some(mark => lowered.includes(mark)))
      throw new KeyAsTokenError('That is an Anyfare key, not a token. Keep it secret, and send the token\'s symbol, contract address or 1Click asset ID');
    try {
      return await tokens.resolve({ blockchain: network.blockchain, token: query });
    }
    catch (error) {
      if (error instanceof OneClickUnavailableError)
        throw unavailable(log, error, 'tokens');
      throw error;
    }
  };

  const dryQuote = async (request: OneClickQuoteRequest, log: LogSink): Promise<OneClickQuoteResponse> => {
    try {
      return await oneClick.quote(request);
    }
    catch (error) {
      if (error instanceof OneClickRefusedError) {
        record('refused');
        throw new TopupRefusedError(`1Click refused the top-up: ${error.reason}`);
      }
      if (error instanceof OneClickUnavailableError)
        throw unavailable(log, error, 'dry_quote');
      throw error;
    }
  };

  return {
    options: async log => {
      let lists: (readonly OneClickToken[])[] | undefined;
      try {
        // Concurrent lookups share the catalog's one fetch
        lists = await Promise.all(config.networks.map(network => tokens.list(network.blockchain)));
      }
      catch (error) {
        log.warn({ error }, 'The 1Click token list can\'t be read, so the top-up options go out without tokens');
      }

      return config.networks.map((network, index) => ({ network, tokens: lists?.[index] }));
    },

    create: async ({ accountId, requestId, network: networkName, token: query, amount: typed, log }) => {
      const network = config.networks.find(candidate => candidate.name === networkName);
      if (!network)
        throw new UnsupportedNetworkError(`Top-ups don't come from that network. Networks: ${networkNames}`);
      const asset = config.asset;
      if (!asset)
        throw new Error('topups.asset is not set: top-ups are not configured');
      const token = await resolveToken(network, query, log);
      const amount = parseTokenAmount(typed, token.decimals);

      const now = clock.now();
      const dry = buildQuoteRequest({ topups: config, token, amount, now, dry: true });
      const priced = await dryQuote(dry, log);
      const worth = toNearestCent(priced.quote.amountInUsd);
      if (worth < network.minimum) {
        record('too_small');
        throw new AmountTooSmallError(`A top-up on ${network.name} must be worth at least $${formatUsd(network.minimum)}. This one is worth $${formatCents(worth)}.`);
      }

      // The real request is the dry one with the same deadline, recorded before it is sent
      const request: OneClickQuoteRequest & { readonly dry: false } = { ...dry, dry: false };
      const created = await topups.create({
        id: `${topupIdPrefix}${ids.next()}`,
        accountId,
        requestId,
        network: network.name,
        blockchain: network.blockchain,
        tokenSymbol: token.symbol,
        originAsset: token.assetId,
        tokenDecimals: token.decimals,
        amount,
        destinationAsset: asset.name,
        recipient: request.recipient,
        refundTo: request.refundTo,
        payBy: new Date(request.deadline),
        // As JSON, exactly as the client sends it
        quoteRequest: JSON.parse(JSON.stringify(request)) as JsonObject,
      });
      const fields = { topupId: created.id, accountId, network: network.name, token: token.symbol, amount: formatTokenAmount(amount, token.decimals) };

      let answer: OneClickDepositQuoteResponse;
      try {
        answer = await oneClick.quote(request);
      }
      catch (error) {
        if (error instanceof OneClickRefusedError) {
          await recordOutcome(() => topups.markQuoteFailed(created.id, { error: error.reason }), fields, log);
          record('refused');
          throw new TopupRefusedError(`1Click refused the top-up: ${error.reason}`);
        }
        // No answer: an address may exist at 1Click, but nobody was given it, so nothing can be sent to it
        const reason = error instanceof OneClickUnavailableError ? error.reason : 'unexpected_error';
        await recordOutcome(() => topups.markQuoteUnknown(created.id, reason), fields, log);
        log.warn({ ...fields, reason, error }, 'A top-up\'s quote didn\'t answer, so no deposit address was given');
        if (!(error instanceof OneClickUnavailableError))
          throw error;
        record('unknown');
        throw new TopupsUnavailableError('No deposit address was made. Nothing to send. Try again.');
      }

      // What the answer says, for the log whether or not it gets recorded
      const answered = {
        ...fields,
        ...answer.quote.depositAddress === undefined ? {} : { depositAddress: answer.quote.depositAddress },
        correlationId: answer.correlationId,
      };
      const mismatch = mismatchOf(request, answer);
      if (mismatch !== undefined) {
        await recordOutcome(() => topups.markQuoteFailed(created.id, {
          error: mismatch.reason, quoteResponse: answer.raw as JsonObject, correlationId: answer.correlationId,
        }), answered, log);
        log.error({ ...answered, ...mismatch }, 'A top-up\'s quote didn\'t match the request, so its deposit address was not given');
        record('refused');
        throw new TopupMismatchError('The quote didn\'t match the request. Nothing to send.');
      }

      const { quote } = answer;
      const quoted = await recordOutcome(() => topups.markQuoted(created.id, {
        quoteResponse: answer.raw as JsonObject,
        correlationId: answer.correlationId,
        depositAddress: quote.depositAddress,
        depositMemo: quote.depositMemo,
        addressExpiresAt: new Date(quote.deadline),
        sendAmount: BigInt(quote.amountIn),
        sendAtLeast: BigInt(quote.minAmountIn),
        estimatedCredits: atomicToUsd(BigInt(quote.amountOut), { decimals: asset.decimals, rounding: 'floor' }),
        nextPollAt: new Date(clock.now().getTime() + firstPollDelayMs),
      }), answered, log);
      log.info(answered, 'A top-up was created');
      record('created');

      return quoted;
    },

    get: async ({ accountId, id }) => {
      const topup = topupIdPattern.test(id) ? await topups.findForAccount(id, accountId) : undefined;
      if (!topup)
        throw new NotFoundError('No such top-up');

      return topup;
    },

    list: input => topups.listForAccount(input),
  };
};

/** Counts requests for top-ups as `api_topups_total`, by what came of them. */
export const createTopupsCounter = (registry: Registry): ((result: TopupResult) => void) => {
  const results = new Counter({
    name: 'api_topups_total',
    help: 'Requests for a top-up, by what came of them: created, refused, unknown, too_small, unavailable',
    labelNames: ['result'] as const,
    registers: [registry],
  });

  return result => results.inc({ result });
};
