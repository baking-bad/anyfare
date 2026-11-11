import { Transform, type Readable } from 'node:stream';

import type { FastifyReply, FastifyRequest } from 'fastify';

import {
  formatUsd, isRecord, outboundErrorCode, OutboundHttpError, outboundFields, OutboundTimeoutError, OwnHostError, parseIpAddress, recordErrorCode,
  ResponseTooLargeError as OutboundResponseTooLargeError, upstreamRequestIdOf, type Clock, type IpAddress, type Logger, type LogSink, type MicroUsd,
  type OutboundHttp, type OutboundResponse,
} from '@anyfare/common';
import { createPaidWith, findAsset, type PlatformConfig } from '@anyfare/core';
import type { Ledger, Redis, RoutingRepository } from '@anyfare/db';
import {
  chooseOption, HostNotAllowedError, InvalidTargetError, mppRefusals, NotPayableError, parseRoutingTarget, parseTargetChallenge, QuoteExceededError,
  routingQuote, targetReceipt, UnsupportedPaymentError, x402Refusals, type ChosenOption, type RoutingTarget, type TargetChallenge,
} from '@anyfare/payments';

import {
  CheckHeaderRequiredError, HostRefusedError, NearPaymentInFlightError, ResponseTooLargeError, UpstreamUnavailableError, type HostRefusal,
} from '../errors.js';
import type { ProxyMetrics } from '../metrics.js';
import type { PaidCall, PaymentStep } from '../payments/step.js';
import type { CallDetailsRecorder } from './callDetails.js';
import {
  addressRefusal, asksOf, checkEntryKey, checkHeader, checkMethods, checkRefusalOf, invalidHost, notAUrl, parseProbeView, probeViewOf, upstreamOf,
  type Asks, type CheckMethod, type CheckQuery, type CheckRefusal, type PayWay, type PayWays, type ProbeView, type UpstreamAnswer,
} from './check.js';
import type { CheckStats, EndpointStats } from './checkStats.js';
import { routedRequestHeaders, routedResponseHeaders } from './headers.js';
import { isOwnHost, ownDomainsOf, SignerUnavailableError, type EndpointRegistrar, type SignerClient, type X402Requirement } from './support.js';

// A quote is reused for this long, so a repeat call skips the probe
export const quoteTtlSeconds = 30;
// An MPP quote leaves the cache this long before its challenge expires, so the Signer never gets an expired one
const challengeMarginSeconds = 10;
// The paid retry ends this long before the buyer's payment expires, so it can still settle after the answer
export const settleMarginMs = 5_000;

type RequestHeaders = Record<string, string | readonly string[]>;
type TargetLeg = 'settled' | 'failed';

export interface RoutingOptions {
  readonly config: PlatformConfig;
  readonly http: Pick<OutboundHttp, 'request'>;
  readonly redis: Redis;
  readonly payments: PaymentStep;
  readonly routing: Pick<RoutingRepository, 'isBlocked' | 'endpointFee' | 'recordTargetPayment' | 'updateTargetPayment'>;
  readonly ledger: Pick<Ledger, 'routingLoss'>;
  readonly signer: SignerClient | undefined;
  readonly optedOut: (host: string, log?: LogSink) => Promise<boolean>;
  readonly registrar: Pick<EndpointRegistrar, 'register'>;
  // Keeps a paid call's method, payer and arrival for the public reads, best effort
  readonly callDetails: Pick<CallDetailsRecorder, 'record'>;
  // The per-IP limit of `GET /_/check`
  readonly limitIp: (ip: string) => Promise<void>;
  // The per-IP limit of probes: a call whose quote isn't cached, paid or not
  readonly limitProbe: (ip: string) => Promise<void>;
  // The ways the combined 402 offers a quote, for `GET /_/check`
  readonly payWays: PayWays;
  // An endpoint's counted numbers over 30 days, for `GET /_/check`: null when they can't be read now
  readonly endpointStats: EndpointStats['get'];
  readonly metrics: Pick<ProxyMetrics, 'upstream' | 'routing'>;
  // Whether an MPP challenge has expired, and how long a buyer's payment has left
  readonly clock: Clock;
  readonly logger: Logger;
}

/** A target's price and our quote, as cached: an x402 option or an MPP challenge. */
type RoutingQuote = {
  readonly network: string;
  readonly asset: string;
  readonly price: MicroUsd;
  readonly fee: MicroUsd;
  readonly quote: MicroUsd;
} & ({
  readonly protocol: 'x402';
  readonly x402Version: number;
  readonly requirement: X402Requirement;
  readonly resource: unknown;
} | {
  readonly protocol: 'mpp';
  // The target's `WWW-Authenticate: Payment` challenge, as it sent it
  readonly challenge: string;
});

// What the target offered, for the log when we can pay none of it: scheme and network only, and the MPP challenges' methods
const offeredOptions = (challenge: TargetChallenge | undefined): string[] => [
  ...(challenge?.accepts ?? []).slice(0, 10)
    .map(option => isRecord(option) ? `${String(option['scheme']).slice(0, 32)} ${String(option['network']).slice(0, 64)}` : 'invalid'),
  ...(challenge?.mpp ?? []).slice(0, 10).map(item => `mpp ${item.method.slice(0, 32)}.${item.intent.slice(0, 32)}`),
];

/** A quote's fields on a log line: the protocol and option chosen, the target's price, the fee, and our quote. */
const quoteFields = (quote: RoutingQuote): Record<string, string | number> => ({
  protocol: quote.protocol,
  network: quote.network,
  asset: quote.asset,
  ...quote.protocol === 'x402' ? { x402Version: quote.x402Version } : {},
  price: formatUsd(quote.price),
  fee: formatUsd(quote.fee),
  quote: formatUsd(quote.quote),
});

const serializeQuote = (quote: RoutingQuote): string => JSON.stringify({ ...quote, price: quote.price.toString(), fee: quote.fee.toString(), quote: quote.quote.toString() });
const parseQuote = (text: string): RoutingQuote => {
  const value = JSON.parse(text) as RoutingQuote & { price: string; fee: string; quote: string };

  return { ...value, price: BigInt(value.price) as MicroUsd, fee: BigInt(value.fee) as MicroUsd, quote: BigInt(value.quote) as MicroUsd };
};

/** How long a quote stays cached: an MPP quote until shortly before its challenge expires, and never one bound to a body. */
const cacheSecondsOf = (chosen: ChosenOption, now: Date): number => {
  if (chosen.protocol === 'x402')
    return quoteTtlSeconds;
  if (chosen.bindsBody)
    return 0;
  const expires = chosen.expires === undefined ? Number.NaN : Date.parse(chosen.expires);

  return Number.isFinite(expires) ? Math.min(quoteTtlSeconds, Math.floor((expires - now.getTime()) / 1_000) - challengeMarginSeconds) : quoteTtlSeconds;
};

/**
 * A paid answer's headers: the target's, the receipt's, and `Cache-Control: private`, so a shared cache
 * never serves one buyer's paid answer to another. The target's directives stay, but `public` gives
 * way to `private`, and a receipt's own directives join them.
 */
const paidAnswerHeaders = (headers: Record<string, string | string[]>, receipt: Readonly<Record<string, string>>): Record<string, string | string[]> => {
  const own = headers['cache-control'];
  const directives = [...(Array.isArray(own) ? own : own === undefined ? [] : [own]), receipt['cache-control'] ?? '', 'private']
    .flatMap(value => value.split(','))
    .map(directive => directive.trim())
    .filter(directive => directive !== '' && directive.toLowerCase() !== 'public');
  const kept = new Map<string, string>();
  for (const directive of directives)
    kept.set(directive.toLowerCase(), directive);

  return { ...headers, ...receipt, 'cache-control': [...kept.values()].join(', ') };
};

const isBillableStatus = (status: number): boolean => status >= 200 && status < 300;
const firstHeader = (value: string | readonly string[] | undefined): string | undefined => typeof value === 'string' ? value : value?.[0];

// Failures before the request left: the target never saw our payment
const unsentCodes = new Set([
  'url_not_allowed', 'own_host', 'blocked_address', 'dns_lookup_failed', 'request_too_large', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH',
  'ENETUNREACH', 'EADDRNOTAVAIL',
]);
// The TLS handshake comes before the request: a handshake that failed sent nothing. Any other TLS
// error, such as a bad record, may come after the request was written.
const handshakeCodes = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID',
  'CERT_REVOKED', 'CERT_UNTRUSTED', 'CERT_SIGNATURE_FAILURE', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_SSL_WRONG_VERSION_NUMBER', 'ERR_TLS_HANDSHAKE_TIMEOUT',
]);

/** Whether a failed paid retry certainly sent nothing: no address, a refused connection or handshake, or a connect timeout. */
const sentNothing = (error: unknown): boolean => {
  if (error instanceof HostNotAllowedError)
    return true;
  const code = outboundErrorCode(error);
  if (code !== undefined && (unsentCodes.has(code) || handshakeCodes.has(code)))
    return true;
  let item: unknown = error;
  for (let depth = 0; item instanceof Error && depth < 10; depth++, item = item.cause) {
    if (item instanceof OutboundTimeoutError && item.phase === 'connect')
      return true;
  }

  return false;
};

/** The body of a paid answer, cut off with ResponseTooLargeError past the limit. */
const limitedBody = (response: OutboundResponse, limit: number, host: string): Readable => {
  let received = 0;
  const limited = new Transform({
    transform: (chunk: Buffer, _encoding, callback) => {
      received += chunk.length;
      if (received > limit)
        callback(new OutboundResponseTooLargeError(host, limit));
      else
        callback(null, chunk);
    },
  });
  response.body.on('error', error => limited.destroy(error));
  limited.on('close', () => response.dispose());

  return response.body.pipe(limited);
};

const readAll = async (body: Readable): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of body)
    chunks.push(Buffer.from(chunk as Uint8Array));

  return Buffer.concat(chunks);
};

/** A quote as a check reads it: with the view of the probe that made it. */
interface CheckedQuote {
  readonly quote: RoutingQuote;
  readonly view: ProbeView;
}

/** `GET /_/check`'s answer for a payable link. */
export interface PayableCheck {
  readonly payable: true;
  readonly method: CheckMethod;
  readonly target: string;
  readonly price: { readonly amount: string; readonly currency: 'USD'; readonly asset: string; readonly network: string | null };
  readonly quote: { readonly amount: string; readonly fee: string; readonly currency: 'USD' };
  readonly link: string;
  readonly protocol: 'x402' | 'mpp';
  readonly asks: Asks;
  readonly upstream: UpstreamAnswer;
  readonly payWith: readonly PayWay[];
  readonly stats: CheckStats | null;
  readonly checkedAt: string;
  readonly ms: number;
}

/** `GET /_/check`'s answer for a link it won't quote: still a 200. */
export interface RefusedCheck {
  readonly payable: false;
  readonly method: CheckMethod;
  readonly reason: string;
  readonly message: string;
  readonly detail?: string;
  readonly upstream?: { readonly status: number };
}

/** Payment routing: `/<host>/<path>` pays any x402 or MPP API for the buyer, and `GET /_/check` quotes one. */
export const createRouting = ({
  config, http, redis, payments, routing, ledger, signer, optedOut, registrar, callDetails, limitIp, limitProbe, payWays, endpointStats, metrics, clock,
}: RoutingOptions) => {
  const payUrl = config.urls.pay.replace(/\/+$/, '');
  const ownDomains = ownDomainsOf(config);
  const ownAddresses = config.ownHosts.map(host => parseIpAddress(host)).filter((address): address is IpAddress => address !== undefined);
  const { paidWithOf } = createPaidWith(config);
  const maxResponseBytes = config.sizeLimits.bufferedResponseBytes;
  const quoteKey = (method: string, target: RoutingTarget): string => `${redis.prefix}quote:${method} ${target.url}`;

  // Why a host is refused, at info: the buyer picked it
  const refuseHost = (log: LogSink, target: RoutingTarget, reason: HostRefusal): never => {
    metrics.routing('refused_host');
    log.info({ host: target.host, code: 'host_not_allowed', reason }, 'Routing refused the host');
    throw new HostRefusedError(reason);
  };

  const refuseOwnHost = (target: RoutingTarget, log: LogSink): void => {
    if (isOwnHost(target.hostname, ownDomains))
      refuseHost(log, target, 'own_host');
  };

  /** Blocklisted hosts and hosts that opted out. A blocklisted host gets no request from us at all. */
  const checkHost = async (target: RoutingTarget, log: LogSink): Promise<void> => {
    if (await routing.isBlocked(target.hostname))
      refuseHost(log, target, 'blocklisted');
    if (await optedOut(target.host, log))
      refuseHost(log, target, 'opted_out');
  };

  // `attempt`: 1 for the probe, 2 for the paid retry. The probe's body is never read, and the paid
  // retry's is limited here, once its status is known: a 2xx over the limit still took our payment.
  const send = async (
    target: RoutingTarget, method: string, headers: RequestHeaders, body: Buffer | undefined, log: LogSink, attempt: number, totalTimeoutMs?: number,
  ): Promise<OutboundResponse> => {
    const started = performance.now();
    try {
      const response = await http.request({
        url: target.url, method, headers, body, redirect: 'none', maxResponseBytes: Number.MAX_SAFE_INTEGER,
        ...totalTimeoutMs === undefined ? {} : { totalTimeoutMs },
      });
      metrics.upstream({ status: response.status }, (performance.now() - started) / 1_000);

      return response;
    }
    catch (error) {
      metrics.upstream({ reason: error instanceof OutboundHttpError ? error.code : 'other' }, (performance.now() - started) / 1_000);
      // A host that resolves to our addresses
      if (error instanceof OwnHostError)
        return refuseHost(log, target, 'own_address');
      // The address policy and the transport say why, at warn
      if (error instanceof OutboundHttpError) {
        log.warn({ ...outboundFields({ url: target.url, method, error, durationMs: performance.now() - started, attempt }), error }, 'The routed target couldn\'t be reached');
        throw new UpstreamUnavailableError({ cause: error });
      }
      throw error;
    }
  };

  /** A quote made within its TTL, or undefined. */
  const cachedQuote = async (target: RoutingTarget, method: string, log: LogSink): Promise<RoutingQuote | undefined> => {
    try {
      const cached = await redis.client.get(quoteKey(method, target));
      if (cached === null)
        return undefined;
      const quote = parseQuote(cached);
      log.debug({ host: target.host, path: target.path, ...quoteFields(quote), cached: true }, 'Routing quote');

      return quote;
    }
    catch (error) {
      log.warn({ error }, 'The quote cache is unavailable');

      return undefined;
    }
  };

  /**
   * The probe, the option, and the quote, with how long the quote may be cached. `observe`, for a check's
   * own probe only, hears what the probe saw, its status and the headers a check shows, whatever its outcome.
   */
  const probeQuote = async (
    target: RoutingTarget, method: string, headers: RequestHeaders, body: Buffer | undefined, log: LogSink, observe?: (view: ProbeView) => void,
  ): Promise<{ readonly quote: RoutingQuote; readonly cacheSeconds: number }> => {
    const started = performance.now();
    const probedAt = observe && clock.now();
    const response = await send(target, method, headers, body, log, 1);
    // The probe's options are in its headers: its body is never read
    response.body.on('error', () => undefined);
    response.dispose();
    const probe = {
      host: target.host, path: target.path, targetStatus: response.status, targetRequestId: upstreamRequestIdOf(response.headers),
      durationMs: Math.round(performance.now() - started),
    };
    if (observe)
      observe(probeViewOf(response.status, response.headers, probedAt!, probe.durationMs));
    if (response.status !== 402) {
      metrics.routing('not_payable');
      log.info({ ...probe, code: 'not_payable' }, 'The routed target didn\'t ask for a payment');
      throw new NotPayableError();
    }
    const challenge = parseTargetChallenge(response.headers);
    const now = clock.now();
    const chosen = challenge && chooseOption(challenge, config, now);
    if (!challenge || !chosen) {
      // And why each option or MPP challenge isn't payable, such as push_only, splits, or no_fee_payer
      const refusals = challenge
        ? [
          ...challenge.x402Version !== 0 && challenge.x402Version !== 2 ? ['unsupported_x402_version'] : [],
          ...x402Refusals(challenge, config), ...mppRefusals(challenge, config, now),
        ]
        : [];
      metrics.routing('unsupported');
      log.info({
        ...probe, code: 'unsupported_payment', offered: offeredOptions(challenge), ...refusals.length > 0 ? { reasons: [...new Set(refusals)] } : {},
      }, 'The routed target offers no payment we make');
      throw new UnsupportedPaymentError();
    }

    const feeBps = await routing.endpointFee(target.host, target.path) ?? config.routingFeeBps;
    const { quote, fee } = routingQuote(chosen.price, feeBps);
    const amounts = { network: chosen.asset.network.id, asset: chosen.asset.name, price: chosen.price, fee, quote };
    const result: RoutingQuote = chosen.protocol === 'x402'
      ? { protocol: 'x402', x402Version: challenge.x402Version, requirement: chosen.requirement, resource: challenge.resource, ...amounts }
      : { protocol: 'mpp', challenge: chosen.challenge, ...amounts };
    log.info({ ...probe, ...quoteFields(result), cached: false }, 'Routing quote');

    return { quote: result, cacheSeconds: cacheSecondsOf(chosen, now) };
  };

  /** The probe, the option, and the quote, cached by method and URL. */
  const probeFor = async (target: RoutingTarget, method: string, headers: RequestHeaders, body: Buffer | undefined, log: LogSink): Promise<RoutingQuote> => {
    const { quote: result, cacheSeconds } = await probeQuote(target, method, headers, body, log);
    try {
      if (cacheSeconds > 0)
        await redis.client.set(quoteKey(method, target), serializeQuote(result), { expiration: { type: 'EX', value: cacheSeconds } });
    }
    catch (error) {
      log.warn({ error }, 'Failed to cache a quote');
    }

    return result;
  };

  /**
   * The host checks and the quote. A quote not cached costs a probe, and the opt-out fetch before it,
   * so the per-IP probe limit counts it first: whatever the target answers, and whatever credential
   * the call carries. A cached quote costs nothing.
   */
  const quoteFor = async (
    target: RoutingTarget, method: string, headers: RequestHeaders, body: Buffer | undefined, request: { readonly ip: string; readonly log: LogSink },
  ): Promise<RoutingQuote> => {
    refuseOwnHost(target, request.log);
    const cached = await cachedQuote(target, method, request.log);
    if (!cached)
      await limitProbe(request.ip);
    await checkHost(target, request.log);

    return cached ?? await probeFor(target, method, headers, body, request.log);
  };

  // The target leg's outcome, best effort: whatever the database says, the buyer's payment is finished after
  const updateLeg = async (paymentId: string, change: Parameters<RoutingRepository['updateTargetPayment']>[1], log: LogSink): Promise<void> => {
    try {
      await routing.updateTargetPayment(paymentId, change);
    }
    catch (error) {
      log.error({ error, paymentId, targetLeg: change.status }, 'The target leg couldn\'t be recorded. The buyer\'s payment is finished anyway.');
    }
  };

  // A target that kept our payment while the buyer wasn't charged: the loss, booked now. If the
  // booking fails, the routing loss job finds the leg and books it.
  const bookLoss = async (call: PaidCall, target: RoutingTarget, status: number | undefined, quoted: RoutingQuote, amount: MicroUsd, log: LogSink): Promise<void> => {
    const { paymentId } = call.authorization;
    metrics.routing('loss');
    try {
      await ledger.routingLoss({ paymentId });
      log.warn({
        paymentId, host: target.host, ...status === undefined ? {} : { status }, protocol: quoted.protocol, network: quoted.network, amount: formatUsd(amount),
        asset: quoted.asset,
      }, 'A target kept a routed payment for a failed call: booked as a routing loss');
    }
    catch (error) {
      log.error({ error, paymentId, host: target.host }, 'A routing loss couldn\'t be booked. The routing loss job books it.');
    }
  };

  const serve = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const log = request.log;
    // When the request arrived: Fastify has been on it since, its body included
    const arrivedAt = new Date(clock.now().getTime() - Math.round(reply.elapsedTime));
    // A buyer who goes away is never charged, and never settled for. Watched from the start: once the
    // connection has closed, a listener added later never hears it.
    let buyerGone = false;
    const closed = new Promise<void>(resolve => {
      // Gone already: its close has fired, and would never be heard
      if (reply.raw.destroyed) {
        buyerGone = true;
        resolve();
        return;
      }
      reply.raw.once('close', () => {
        buyerGone = !reply.raw.writableFinished;
        resolve();
      });
    });
    const target = parseRoutingTarget(request.raw.url ?? '/');
    const headers = routedRequestHeaders(request.headers, request.id);
    const body = request.body as Buffer | undefined;
    const quoted = await quoteFor(target, request.method, headers, body, { ip: request.ip, log });

    // The buyer pays the quote, with a key, x402, or MPP; or gets the combined 402 at it
    const payment = await payments.begin({
      headers: request.headers, ip: request.ip, log, requestId: request.id, host: target.host, path: target.path,
      resource: `${payUrl}/${target.host}${target.path}`, quote: quoted.quote,
    });
    if (payment.kind === 'challenge') {
      metrics.routing('quoted');

      return reply.status(payment.response.status).headers(payment.response.headers).send(payment.response.body);
    }

    const call: PaidCall = payment.call;
    const { paymentId } = call.authorization;
    // Returns at once and never throws: the call never waits for it
    callDetails.record({ authorization: call.authorization, method: request.method, arrivedAt, log });
    const abortBuyer = async (status: number | undefined): Promise<void> => {
      await payments.finish(call, await payments.decide(call, { status, latencyMs: 0 }));
    };
    // The buyer's connection is gone, so nothing can be sent: an answer for the request line only
    const answerGone = (): FastifyReply => {
      recordErrorCode(request, 'buyer_gone');

      return reply.status(503).send({ error: { code: 'upstream_unavailable', message: new UpstreamUnavailableError().message } });
    };
    const leg = { paymentId, host: target.host, path: target.path, ...quoteFields(quoted) };

    if (buyerGone) {
      log.info(leg, 'The buyer left before the target was paid: nothing was paid');
      await abortBuyer(undefined);
      return answerGone();
    }
    // Pay the target only now, through the Signer, within the quote
    if (!signer) {
      metrics.routing('signer_refused');
      log.warn(leg, 'Payment routing pays no targets: no Signer is configured');
      await abortBuyer(undefined);
      throw new UpstreamUnavailableError();
    }
    // On NEAR the Signer pays one payment at a time: from the sign on, the hot wallet's lease holds this
    // payment's ID until it is released, or expires minutes later. Once the Signer was asked to sign, it
    // is released exactly once, whatever the Signer answered: when the target's answer arrives, since an
    // x402 target settles before it answers, or when the payment is dropped, since the Signer may have
    // signed after we gave up. A release that holds nothing does nothing. It's fired, never waited for:
    // a failure is the client's warn line, and the lease expires on its own.
    const holdsLease = quoted.protocol === 'x402' && quoted.network.startsWith('near:');
    let released = false;
    const releaseOnce = (): void => {
      if (!holdsLease || released)
        return;
      released = true;
      void signer.release(paymentId, { requestId: request.id, log }).catch((error: unknown) => {
        log.warn({ paymentId, error }, 'The Signer didn\'t release the NEAR payment\'s lease: it expires on its own');
      });
    };
    let signed;
    try {
      const option = quoted.protocol === 'x402'
        ? { protocol: 'x402' as const, requirement: quoted.requirement, resource: quoted.resource }
        : { protocol: 'mpp' as const, challenge: quoted.challenge };
      signed = await signer.sign({ requestId: request.id, quoteId: paymentId, ...option, url: target.url, quotedPrice: quoted.price });
    }
    catch (error) {
      releaseOnce();
      await abortBuyer(undefined);
      if (error instanceof SignerUnavailableError) {
        // The Signer's refusal reason from 422 signing_refused, or why it couldn't be reached
        const { failure } = error;
        const fields = {
          ...leg, signer: failure, ...failure?.code === undefined ? {} : { code: failure.code }, ...failure?.reason === undefined ? {} : { reason: failure.reason },
          ...error.cause === undefined ? {} : { error: error.cause },
        };
        // Another NEAR payment is in flight: expected under load, and the buyer may try again in a moment
        if (failure?.status === 409 && failure.code === 'payer_busy') {
          metrics.routing('signer_busy');
          log.info(fields, 'The Signer is paying another NEAR payment: nothing was paid, and the buyer may retry');
          throw new NearPaymentInFlightError();
        }
        metrics.routing('signer_refused');
        log.warn(fields, 'The Signer didn\'t sign a routed payment');
        throw new UpstreamUnavailableError();
      }
      throw error;
    }
    const signedLeg = { ...leg, signatureId: signed.signatureId, payTo: signed.payTo };
    // The target leg, recorded before the payment goes out
    try {
      await routing.recordTargetPayment({
        paymentId, protocol: quoted.protocol, network: signed.network, asset: signed.asset, amount: signed.amount, atomicAmount: signed.atomicAmount,
        payTo: signed.payTo, signatureId: signed.signatureId,
      });
    }
    catch (error) {
      // Nothing was sent: the signed payment is dropped, and the buyer pays nothing
      releaseOnce();
      await abortBuyer(undefined);
      throw error;
    }

    // A buyer's payment that expires, such as an MPP transaction's validBefore or an x402 authorization's:
    // the target's answer must come early enough for it to settle after
    const { deadlineMs } = call.authorization;
    const timeoutMs = deadlineMs === undefined
      ? config.timeouts.requestMs
      : Math.min(config.timeouts.requestMs, deadlineMs - clock.now().getTime() - settleMarginMs);
    if (timeoutMs <= 0) {
      releaseOnce();
      log.warn({ ...signedLeg, targetLeg: 'failed', reason: 'payment_expiring' }, 'The buyer\'s payment expires too soon to call the target: nothing was sent');
      await updateLeg(paymentId, { status: 'failed' }, log);
      await abortBuyer(undefined);
      throw new UpstreamUnavailableError();
    }

    // Our payment, never the buyer's own Authorization
    const paymentHeader = quoted.protocol === 'mpp' ? 'authorization' : 'payment-signature';
    const started = performance.now();
    let response: OutboundResponse;
    try {
      response = await send(target, request.method, { ...headers, [paymentHeader]: signed.header }, body, log, 2, timeoutMs);
    }
    catch (error) {
      releaseOnce();
      // Nothing sent: the target never saw our payment. Anything else, such as a timeout or a reset, may
      // have reached it: the leg stays unknown. The buyer isn't charged either way.
      const targetLeg = sentNothing(error) ? 'failed' : 'unknown';
      log.warn({ ...signedLeg, targetLeg, timeoutMs }, targetLeg === 'failed'
        ? 'The routed target couldn\'t be reached for the paid retry: nothing was sent'
        : 'The routed target didn\'t answer the paid retry: its payment\'s outcome is unknown');
      await updateLeg(paymentId, { status: targetLeg }, log);
      await abortBuyer(undefined);
      throw error;
    }
    // The target's answer has arrived, whatever its status, and its body isn't read yet: an x402 target
    // settled our payment, if it did, before it answered
    releaseOnce();
    const latencyMs = Math.round(performance.now() - started);
    const targetRequestId = upstreamRequestIdOf(response.headers);
    const answered = {
      ...signedLeg, targetStatus: response.status, ...targetRequestId === undefined ? {} : { targetRequestId }, durationMs: latencyMs, timeoutMs, attempt: 2,
    };
    // The body can fail while the payment is decided, before anyone reads it. Unheard, that error would
    // crash the process. Whoever reads the body still gets it.
    response.body.on('error', () => undefined);
    // Its PAYMENT-RESPONSE or Payment-Receipt for the protocol we paid with, and the transaction it names
    const settled = targetReceipt(response.headers, quoted.protocol);
    const receipt = settled && { receipt: settled.receipt, ...settled.transaction === undefined ? {} : { transactionHash: settled.transaction } };
    const outcome = { status: response.status, latencyMs, upstreamRequestId: targetRequestId };
    // The buyer isn't charged: finish its payment, and book the loss when the target kept ours
    const notCharged = async (targetLeg: TargetLeg, delivered: boolean): Promise<void> => {
      response.dispose();
      await payments.finish(call, await payments.decide(call, { ...outcome, delivered }));
      if (targetLeg === 'settled')
        await bookLoss(call, target, response.status, quoted, signed.amount, log);
    };

    // A retry that asks for a payment again refused ours, unless it says it settled it; one above the
    // quote is quote_exceeded. The buyer isn't charged.
    if (response.status === 402) {
      const challenge = parseTargetChallenge(response.headers);
      const again = challenge && chooseOption(challenge, config, clock.now());
      const targetLeg: TargetLeg = receipt ? 'settled' : 'failed';
      metrics.routing('target_refused');
      await updateLeg(paymentId, { status: targetLeg, ...receipt }, log);
      await notCharged(targetLeg, true);
      await redis.client.del(quoteKey(request.method, target)).catch(() => undefined);
      const exceeded = again !== undefined && again.price > quoted.price;
      log.warn({
        ...answered, targetLeg, receipt: receipt !== undefined, code: exceeded ? 'quote_exceeded' : 'upstream_unavailable',
        ...again ? { askedPrice: formatUsd(again.price) } : {},
      }, 'The routed target refused our payment on the paid retry');
      if (exceeded)
        throw new QuoteExceededError();
      throw new UpstreamUnavailableError();
    }

    // A 2xx took our payment. Any other answer did only if it says so.
    const targetLeg: TargetLeg = isBillableStatus(response.status) || receipt ? 'settled' : 'failed';
    // A target's 5xx is an expected outcome: info
    log.info({ ...answered, targetLeg, receipt: receipt !== undefined }, 'Routed call answered');
    await updateLeg(paymentId, { status: targetLeg, ...receipt }, log);
    if (buyerGone) {
      log.info({ ...answered, targetLeg }, 'The buyer left before the answer: not charged');
      await notCharged(targetLeg, false);
      return answerGone();
    }
    const answerHeaders = routedResponseHeaders(response.headers, { payUrl, target });
    const bodyless = request.method === 'HEAD' || response.status === 204 || response.status === 304;
    // An answer that declares a body over the limit is never read, whatever the buyer's rail
    if (!bodyless && Number(firstHeader(response.headers['content-length'])) > maxResponseBytes) {
      log.warn({ ...answered, maxResponseBytes }, 'The routed target\'s answer is over the size limit: the buyer isn\'t charged');
      await notCharged(targetLeg, false);
      throw new ResponseTooLargeError();
    }
    const answerBody = limitedBody(response, maxResponseBytes, target.host);
    answerBody.on('error', () => undefined);

    // x402 and MPP buyers: no byte goes out before their money moves, so the answer is buffered first
    let buffered: Buffer | undefined;
    if (isBillableStatus(response.status) && call.rail.settlesBeforeResponse && !bodyless) {
      try {
        buffered = await readAll(answerBody);
      }
      catch (error) {
        // Too large to buffer, past the deadline, or broken off: no usable answer, and nothing settles
        log.warn({ ...answered, error }, 'The routed target\'s answer couldn\'t be buffered: the buyer isn\'t charged');
        await notCharged(targetLeg, false);
        throw error instanceof OutboundResponseTooLargeError ? new ResponseTooLargeError() : new UpstreamUnavailableError();
      }
      if (buyerGone) {
        log.info({ ...answered, targetLeg }, 'The buyer left before the answer: not charged');
        await notCharged(targetLeg, false);
        return answerGone();
      }
    }

    const decision = await payments.decide(call, outcome);
    if (decision !== 'billable') {
      // Not charged. If the target kept our payment anyway, it's a routing loss.
      await payments.finish(call, decision);
      if (receipt)
        await bookLoss(call, target, response.status, quoted, signed.amount, log);
      // A server error is opaque
      if (response.status >= 500) {
        answerBody.destroy();
        throw new UpstreamUnavailableError();
      }
      reply.status(response.status).headers(answerHeaders);
      if (bodyless) {
        answerBody.destroy();
        return reply.send();
      }

      return reply.send(answerBody);
    }

    registrar.register(target.host, target.path, quoted.quote, request.id);
    if (call.rail.settlesBeforeResponse) {
      if (bodyless)
        answerBody.destroy();
      let buyerReceipt;
      try {
        buyerReceipt = await payments.settleNow(call);
      }
      catch (error) {
        // The target is paid and the buyer isn't: the routing loss job books it once the buyer's
        // payment is final. The Signer's limits cap this risk.
        metrics.routing('loss');
        log.warn({ error, paymentId, host: target.host, rail: call.rail.name, amount: formatUsd(signed.amount), asset: signed.asset },
          'A routed buyer\'s settlement failed after the target was paid');
        throw error;
      }
      metrics.routing('paid');

      return reply.status(response.status).headers(paidAnswerHeaders(answerHeaders, buyerReceipt.headers)).send(buffered);
    }
    metrics.routing('paid');
    // Credits: the answer streams, and the capture follows once it is out or the buyer has gone. A
    // stream that breaks off after the status went out is still captured: the decision was billable.
    void closed.then(() => payments.finish(call, decision));
    reply.status(response.status).headers(paidAnswerHeaders(answerHeaders, call.authorization.receipt?.headers ?? {}));
    if (bodyless) {
      answerBody.destroy();
      return reply.send();
    }

    return reply.send(answerBody);
  };

  // The refusals `GET /_/check` answers as `payable: false`
  const unpayable = new Set(['invalid_target', 'host_not_allowed', 'not_payable', 'unsupported_payment', 'upstream_unavailable']);

  // A check's own cache entry: its quote and its probe's view, under one key. Only a check writes it, and
  // only a check reads it. The key is a digest of the method and URL, never the text a buyer sent.
  const checkKey = (method: string, target: RoutingTarget): string => checkEntryKey(redis.prefix, method, target.url);

  /** The check's cached entry, or undefined. Never a quote a routed call cached: its probe carried that buyer's headers and body. */
  const cachedCheck = async (target: RoutingTarget, method: string, log: LogSink): Promise<CheckedQuote | undefined> => {
    try {
      const text = await redis.client.get(checkKey(method, target));
      const entry: unknown = text === null ? undefined : JSON.parse(text);
      const view = isRecord(entry) ? parseProbeView(entry['view']) : undefined;
      if (!isRecord(entry) || typeof entry['quote'] !== 'string' || view === undefined)
        return undefined;
      const quote = parseQuote(entry['quote']);
      log.debug({ host: target.host, path: target.path, ...quoteFields(quote), cached: true }, 'Routing quote');

      return { quote, view };
    }
    catch (error) {
      log.warn({ error }, 'The check\'s cache is unavailable');

      return undefined;
    }
  };

  /**
   * Caches a check's quote with its view, for checks. Paid calls may use the quote only when none is
   * cached: it is set if absent, so a routed call's quote is never replaced, extended or shortened. Best
   * effort: a check that can't cache still answers.
   */
  const keepCheck = async (target: RoutingTarget, method: string, checked: CheckedQuote, seconds: number, log: LogSink): Promise<void> => {
    const serialized = serializeQuote(checked.quote);
    const expiration = { type: 'EX', value: seconds } as const;
    const writes = [
      () => redis.client.set(checkKey(method, target), JSON.stringify({ quote: serialized, view: checked.view }), { expiration }),
      () => redis.client.set(quoteKey(method, target), serialized, { condition: 'NX', expiration }),
    ];
    await Promise.all(writes.map(async write => {
      try {
        await write();
      }
      catch (error) {
        log.warn({ error }, 'Failed to cache a check\'s quote');
      }
    }));
  };

  /**
   * The host checks and the quote of a check, as a routed call makes them, from a probe of its own. A
   * quote not cached costs a probe, counted first; `seen` hears the probe's view, whatever the outcome.
   */
  const quoteForCheck = async (target: RoutingTarget, method: CheckMethod, request: FastifyRequest, seen: { view?: ProbeView }): Promise<CheckedQuote> => {
    refuseOwnHost(target, request.log);
    const cached = await cachedCheck(target, method, request.log);
    if (!cached)
      await limitProbe(request.ip);
    await checkHost(target, request.log);
    if (cached)
      return cached;
    // Only what the check sets: no body, and no header but its own request ID
    const { quote, cacheSeconds } = await probeQuote(target, method, routedRequestHeaders({}, request.id), undefined, request.log, view => {
      seen.view = view;
    });
    const checked = { quote, view: seen.view! };
    if (cacheSeconds > 0)
      await keepCheck(target, method, checked, cacheSeconds, request.log);

    return checked;
  };

  /**
   * `GET /_/check?url=&method=`: is the link payable, at what price, our quote, the target's 402 as it
   * came, the ways we take the quote, and the endpoint's numbers, without paying. The probe goes with
   * `method`, GET or POST, and no body, under every check and limit a routed call has. POST needs the
   * header `X-Anyfare-Check: 1`, which a link, a prefetch or an image tag never sends. A link it won't
   * quote is a 200 with the reason, and a detail the page can word.
   */
  const check = async (request: FastifyRequest<{ Querystring: CheckQuery }>): Promise<PayableCheck | RefusedCheck> => {
    // The schema takes only these, GET when none is given
    const method: CheckMethod = checkMethods.find(item => item === request.query.method) ?? 'GET';
    if (method === 'POST' && request.headers[checkHeader] !== '1')
      throw new CheckHeaderRequiredError();
    await limitIp(request.ip);
    const refused = ({ reason, detail, message, status }: CheckRefusal): RefusedCheck => ({
      payable: false, method, reason, message, ...detail === undefined ? {} : { detail }, ...status === undefined ? {} : { upstream: { status } },
    });
    const link = request.query.url ?? '';
    let parsed: URL;
    try {
      parsed = new URL(link.includes('://') ? link : `https://${link}`);
    }
    catch {
      return refused(notAUrl);
    }
    const address = addressRefusal(parsed.hostname, ownAddresses);
    if (address)
      return refused(address);
    let target: RoutingTarget;
    try {
      target = parseRoutingTarget(`/${parsed.host}${parsed.pathname}${parsed.search}`);
    }
    catch (error) {
      if (error instanceof InvalidTargetError)
        return refused(invalidHost);
      throw error;
    }

    const seen: { view?: ProbeView } = {};
    let quoted: RoutingQuote;
    let view: ProbeView;
    try {
      ({ quote: quoted, view } = await quoteForCheck(target, method, request, seen));
    }
    catch (error) {
      const refusal = checkRefusalOf(error, seen.view);
      if (refusal)
        return refused(refusal);
      const code = (error as { code?: unknown }).code;
      if (typeof code === 'string' && unpayable.has(code))
        return refused({ reason: code as CheckRefusal['reason'], message: (error as Error).message });
      throw error;
    }
    const asset = findAsset(config, quoted.asset);
    metrics.routing('quoted');

    return {
      payable: true,
      method,
      target: target.url,
      price: { amount: formatUsd(quoted.price), currency: 'USD', asset: quoted.asset, network: asset?.network.id ?? null },
      quote: { amount: formatUsd(quoted.quote), fee: formatUsd(quoted.fee), currency: 'USD' },
      link: `${payUrl}/${target.host}${target.path}${target.search}`,
      protocol: quoted.protocol,
      asks: asksOf(quoted, paidWithOf),
      upstream: upstreamOf(view),
      payWith: payWays(quoted.quote),
      stats: await endpointStats(target.host, target.path, request.log),
      checkedAt: view.probedAt,
      ms: view.ms,
    };
  };

  return { serve, check };
};

export type Routing = ReturnType<typeof createRouting>;
