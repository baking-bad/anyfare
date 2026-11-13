import { Counter } from '@prometheus-io/client';
import type { PaymentRequirements } from '@x402/core/types';
import type { ClientSvmSigner } from '@x402/svm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Challenge } from 'mppx';
import type { LocalAccount } from 'viem';

import {
  AnyfareError, createServer, formatUsd, isRecord, randomIdGenerator, recordErrorCode, Secret, systemClock, type Clock, type ErrorStatusTable, type IdGenerator,
  type Logger, type MicroUsd, type Server,
} from '@anyfare/common';
import type { PlatformConfig } from '@anyfare/core';
import { createRoutingRepository, type Postgres, type Redis, type RoutingRepository } from '@anyfare/db';
import { createTokenCatalog, type OneClickClient } from '@anyfare/topups';

import { createRedisNearPayerStore, type NearPayerStore, type NearWallet } from './near.js';
import { createNearTransfer } from './nearTransfer.js';
import { createRefiller, refillLeaseMs } from './refill.js';
import { createRedisRefillStore, refillSpendKeyPrefix, type RefillStore } from './refillStore.js';
import { createSigner, PayerBusyError, SigningFailedError, SigningRefusedError, type SignRequest } from './sign.js';
import { createRedisSpendLimits, type SpendLimits } from './spend.js';
import { createTempoClient } from './tempo.js';

// The shared secret every sign request carries
export const signerSecretHeader = 'x-signer-secret';

export interface SignerDependencies {
  readonly config: PlatformConfig;
  readonly logger: Logger;
  readonly postgres: Postgres;
  readonly redis: Redis;
  // SIGNER_SECRET. Without it, every sign request is refused.
  readonly secret: Secret | undefined;
  // The hot wallets. NEAR's carries its key in a Secret, and the RPC it reads the chain through.
  readonly wallets: { readonly base?: LocalAccount; readonly tempo?: LocalAccount; readonly solana?: ClientSvmSigner; readonly near?: NearWallet };
  // The Tempo RPC for MPP targets. Default: mpp.rpcUrl, else the chain's public RPC.
  readonly tempoRpcUrl?: string;
  // The Solana RPC for Solana targets: SOLANA_RPC_URL, which may carry a key. Default: the SDK's public RPC.
  readonly solanaRpcUrl?: Secret;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
  // Request IDs for requests without one. Default: random UUIDs.
  readonly requestIds?: IdGenerator;
  // Default: Redis counters with platform config's limits
  readonly spend?: SpendLimits;
  // The NEAR hot wallet's lease and last nonces. Default: the Signer's Redis.
  readonly nearStore?: NearPayerStore;
  // Where signatures are recorded. Default: the signatures table.
  readonly signatures?: Pick<RoutingRepository, 'recordSignature'>;
  // The 1Click API refills are quoted by, built from topups when rebalancing is on. Without it, every refill is refused.
  readonly oneClick?: Pick<OneClickClient, 'tokens' | 'quote'>;
  // Default: Redis counters per target asset and UTC day, with rebalancing.mostPerAssetPerDay
  readonly refillSpend?: SpendLimits;
  // Each refill's record by its ID. Default: the Signer's Redis.
  readonly refills?: RefillStore;
  // How often a refill's transaction whose send had no answer is looked up. Default: a second.
  readonly refillPollMs?: number;
}

// Redis down: without its spend counters the Signer signs nothing, and says so as unavailable
// A NEAR payment in flight from the hot wallet: 409 payer_busy, and the caller tries again in a moment.
// Refills: off or not possible, 503 refills_off; the same ID asked while it runs, 409 refill_in_progress,
// or for another asset or amount than its outcome's, 409 refill_id_conflict; 1Click refused or silent,
// 503 oneclick_unavailable; a transaction that failed, 502 refill_failed; one whose outcome is unknown,
// 502 refill_unknown.
const errorStatuses = {
  unauthorized: 401, invalid_request: 400, signing_refused: 422, payer_busy: 409, signing_failed: 502, redis_not_ready: 503,
  refills_off: 503, refill_in_progress: 409, refill_id_conflict: 409, oneclick_unavailable: 503, refill_failed: 502, refill_unknown: 502,
} as const satisfies ErrorStatusTable;

class UnauthorizedError extends AnyfareError {
  readonly code = 'unauthorized';
}

class InvalidRequestError extends AnyfareError {
  readonly code = 'invalid_request';
}

// x402: `x402Version` and `requirement`. MPP: `challenge`. Without `protocol`, x402.
// `quotedPrice`: the target price the buyer was quoted, in micro-USD, as a decimal string.
const signBodySchema = {
  type: 'object',
  required: ['quoteId', 'url', 'quotedPrice'],
  properties: {
    requestId: { type: 'string', maxLength: 128 },
    quoteId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$' },
    protocol: { type: 'string', enum: ['x402', 'mpp'] },
    x402Version: { type: 'integer', enum: [2] },
    requirement: { type: 'object' },
    resource: {},
    challenge: { type: 'string', minLength: 1, maxLength: 16_384 },
    url: { type: 'string', minLength: 1, maxLength: 4096 },
    quotedPrice: { type: 'string', pattern: '^\\d{1,20}$' },
  },
  additionalProperties: false,
} as const;

// `POST /internal/v1/refills`: the workers' refill ID, a rebalancing target's asset, and what its wallet
// must receive, in micro-USD, as a decimal string
const refillBodySchema = {
  type: 'object',
  required: ['refillId', 'asset', 'amount'],
  properties: {
    refillId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$' },
    asset: { type: 'string', minLength: 1, maxLength: 64 },
    amount: { type: 'string', pattern: '^\\d{1,20}$' },
  },
  additionalProperties: false,
} as const;

interface RefillBody {
  readonly refillId: string;
  readonly asset: string;
  readonly amount: string;
}

// `POST /internal/v1/quotes/:quoteId/release`: the proxy's quote ID, its payment ID
const releaseParamsSchema = {
  type: 'object',
  required: ['quoteId'],
  properties: {
    quoteId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$' },
  },
} as const;

// A field as asked, for the log: a short string, or null
const short = (value: unknown): string | null => typeof value === 'string' || typeof value === 'number' ? String(value).slice(0, 128) : null;

// What was asked, for a refusal's line: the option's or the challenge's network, asset, amount, and payTo
const askedFields = (body: SignBody): Record<string, string | null> => {
  if (body.protocol !== 'mpp') {
    const requirement = isRecord(body.requirement) ? body.requirement : {};

    return { network: short(requirement['network']), asset: short(requirement['asset']), atomicAmount: short(requirement['amount']), payTo: short(requirement['payTo']) };
  }
  try {
    const { request } = Challenge.deserialize(body.challenge ?? '');
    const details = isRecord(request['methodDetails']) ? request['methodDetails'] : {};

    return {
      network: details['chainId'] === undefined ? null : `eip155:${short(details['chainId'])}`, asset: short(request['currency']), atomicAmount: short(request['amount']),
      payTo: short(request['recipient']),
    };
  }
  catch {
    return { network: null, asset: null, atomicAmount: null, payTo: null };
  }
};

interface SignBody {
  readonly requestId?: string;
  readonly quoteId: string;
  readonly protocol?: 'x402' | 'mpp';
  readonly x402Version?: number;
  readonly requirement?: Record<string, unknown>;
  readonly resource?: unknown;
  readonly challenge?: string;
  readonly url: string;
  readonly quotedPrice: string;
}

const signRequestOf = (body: SignBody, quotedPrice: MicroUsd): SignRequest => {
  const { requestId, quoteId, url } = body;
  if (body.protocol === 'mpp') {
    if (body.challenge === undefined)
      throw new InvalidRequestError('An MPP payment needs the target\'s challenge');

    return { protocol: 'mpp', requestId, quoteId, url, quotedPrice, challenge: body.challenge };
  }
  if (body.x402Version === undefined || body.requirement === undefined)
    throw new InvalidRequestError('An x402 payment needs x402Version and the requirement');

  return {
    protocol: 'x402', requestId, quoteId, url, quotedPrice, x402Version: body.x402Version, requirement: body.requirement as unknown as PaymentRequirements, resource: body.resource,
  };
};

/**
 * The Signer, on the internal network only: `POST /internal/v1/sign`,
 * `POST /internal/v1/quotes/:quoteId/release`, and `POST /internal/v1/refills`, with the shared secret.
 * Readiness covers Postgres and Redis: without its spend counters, it signs nothing.
 */
export const createApp = ({
  config, logger, postgres, redis, secret, wallets, tempoRpcUrl, solanaRpcUrl, clock = systemClock, ids = randomIdGenerator, requestIds,
  spend = createRedisSpendLimits({ redis, hourly: config.signer.maxPerNetworkPerHour, daily: config.signer.maxPerNetworkPerDay }),
  nearStore = createRedisNearPayerStore({ redis }),
  signatures = createRoutingRepository({ db: postgres.db, clock }),
  oneClick,
  refillSpend = createRedisSpendLimits({ redis, hourly: undefined, daily: config.rebalancing.mostPerAssetPerDay, keyPrefix: refillSpendKeyPrefix }),
  refills = createRedisRefillStore({ redis }),
  refillPollMs,
}: SignerDependencies): Server => {
  const server = createServer({
    logger,
    errorStatuses,
    requestIds,
    readinessChecks: [
      { name: 'postgres', check: () => postgres.ping() },
      { name: 'redis', check: () => redis.ping() },
    ],
  });
  const spent = new Counter({
    name: 'signer_spend_usd_total',
    help: 'USD the Signer signed for, per network',
    labelNames: ['network'] as const,
    registers: [server.metrics.registry],
  });
  const fees = new Counter({
    name: 'signer_fees_usd_total',
    help: 'The most our signed Tempo transactions pay in fees, in USD, per network: their gas limit at their maximum fee',
    labelNames: ['network'] as const,
    registers: [server.metrics.registry],
  });
  // MPP targets: the RPC the mppx client fills our Tempo transactions from, within the connect timeout
  const tempoClient = wallets.tempo
    ? createTempoClient({ network: config.mpp.network, url: tempoRpcUrl ?? config.mpp.rpcUrl, timeoutMs: config.timeouts.connectMs })
    : undefined;
  const signer = createSigner({
    config, wallets, ...tempoClient ? { tempoClient } : {}, ...solanaRpcUrl ? { solanaRpcUrl } : {}, spend, nearStore, signatures, clock, ids,
    logger,
    onSigned: ({ network, amount, maxFee }) => {
      spent.inc({ network }, Number(amount) / 1_000_000);
      if (maxFee !== undefined)
        fees.inc({ network }, Number(maxFee) / 1_000_000);
    },
  });
  const refilled = new Counter({
    name: 'signer_refills_usd_total',
    help: 'USD the Signer refilled its hot wallets with, per target asset: what each wallet was to receive',
    labelNames: ['asset'] as const,
    registers: [server.metrics.registry],
  });
  // Refills: each read and the send within the connect timeout, and lookups of a send without an answer
  // for as long as a settle may take
  const nearTiming = { readMs: config.timeouts.connectMs, sendMs: config.timeouts.connectMs, pollBudgetMs: config.timeouts.settleMs };
  const refiller = createRefiller({
    config, wallets, spend: refillSpend, store: refills, nearStore, clock, ids, leaseMs: refillLeaseMs(nearTiming),
    transfer: wallets.near && createNearTransfer({ wallet: wallets.near, store: nearStore, ...nearTiming, ...refillPollMs === undefined ? {} : { pollMs: refillPollMs } }),
    oneClick,
    tokens: oneClick && createTokenCatalog({
      client: oneClick, clock,
      onStale: ({ error, ageMs }) => logger.warn({ error, ageMs }, 'The 1Click token list couldn\'t be read: refills resolve tokens from an older list'),
    }),
    onRefilled: ({ asset, amount }) => refilled.inc({ asset }, Number(amount) / 1_000_000),
  });

  // The shared secret, compared with `Secret.equals`, which is timing-safe
  const authenticate = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const header = request.headers[signerSecretHeader];
    const given = typeof header === 'string' && header !== '' ? Secret.from(header) : undefined;
    try {
      if (secret && given?.equals(secret))
        return;
    }
    finally {
      given?.destroy();
    }
    reply.header('www-authenticate', 'Bearer');
    throw new UnauthorizedError(`The Signer needs the ${signerSecretHeader} header`);
  };

  server.app.post<{ Body: SignBody }>('/internal/v1/sign', { onRequest: authenticate, schema: { body: signBodySchema } }, async request => {
    const { body } = request;
    const { requestId, quoteId, url, quotedPrice } = body;
    if (!/^https:\/\//.test(url))
      throw new InvalidRequestError('url must be an HTTPS URL');
    const protocol = body.protocol ?? 'x402';
    // One line per sign request. The request's own ID labels it, as the proxy sent it.
    const started = performance.now();
    const caller = requestId !== undefined && requestId !== request.id ? { callerRequestId: requestId } : {};
    let signed;
    try {
      signed = await signer.sign(signRequestOf(body, BigInt(quotedPrice) as MicroUsd), request.log);
    }
    catch (error) {
      const asked = { ...caller, quoteId, protocol, ...askedFields(body), quotedPrice: formatUsd(BigInt(quotedPrice)) };
      if (error instanceof SigningRefusedError) {
        request.log.info({
          ...asked, result: 'refused', reason: error.reason, message: error.message, ...error.spend, durationMs: Math.round(performance.now() - started),
        }, 'Refused to sign a routed payment');
      }
      // Another NEAR payment from the hot wallet is in flight: nothing was reserved
      else if (error instanceof PayerBusyError) {
        request.log.info({
          ...asked, result: 'busy', reason: error.code, message: error.message, durationMs: Math.round(performance.now() - started),
        }, 'Refused to sign a routed payment');
      }
      // The RPC's short message only: never a request, a transaction, or the RPC's URL
      else if (error instanceof SigningFailedError)
        request.log.warn({ ...asked, result: 'failed', reason: error.reason, durationMs: Math.round(performance.now() - started) }, 'Failed to sign a routed payment');
      throw error;
    }
    // Never the signed header: it pays the target. For MPP, the most our transaction pays in fees.
    request.log.info({
      ...caller, quoteId, protocol: signed.protocol, network: signed.network, asset: signed.asset, amount: formatUsd(signed.amount),
      atomicAmount: signed.atomicAmount.toString(), payTo: signed.payTo, signatureId: signed.signatureId,
      ...signed.maxFee === undefined ? {} : { maxFee: formatUsd(signed.maxFee) }, result: 'signed', durationMs: Math.round(performance.now() - started),
    }, 'Signed a routed payment');

    return {
      header: signed.header,
      signatureId: signed.signatureId,
      network: signed.network,
      asset: signed.asset,
      atomicAmount: signed.atomicAmount.toString(),
      amount: signed.amount.toString(),
      payTo: signed.payTo,
    };
  });

  // The workers ask for a refill of a hot wallet. The Signer quotes it, checks it, and pays it from its
  // NEAR hot wallet, or refuses. Its answer, and an unknown outcome, are answered again for the same ID.
  server.app.post<{ Body: RefillBody }>('/internal/v1/refills', { onRequest: authenticate, schema: { body: refillBodySchema } }, async (request, reply) => {
    const { refillId, asset, amount } = request.body;
    let result;
    try {
      result = await refiller.refill({ refillId, asset, amount: BigInt(amount) as MicroUsd }, request.log);
    }
    catch (error) {
      // A refusal says why beside its error, so the workers can tell a short hot wallet from the other refusals
      if (!(error instanceof SigningRefusedError))
        throw error;
      recordErrorCode(request, error.code);

      return reply.status(errorStatuses.signing_refused).send({ error: { code: error.code, message: error.message }, reason: error.reason });
    }
    if (result.kind === 'sent')
      return result.answer;
    const code = result.kind === 'failed' ? 'refill_failed' : 'refill_unknown';
    recordErrorCode(request, code);

    return result.kind === 'failed'
      ? reply.status(errorStatuses.refill_failed).send({ error: { code, message: result.message }, transactionHash: result.transactionHash })
      : reply.status(errorStatuses.refill_unknown).send({
        error: { code, message: 'The refill\'s transaction may have gone through: follow 1Click\'s status for its deposit address' }, ...result.body,
      });
  });

  // The proxy is done with a payment: its NEAR lease, if it holds one, goes, and the next NEAR payment
  // may be signed. Idempotent: always 204, and a payment on another chain never holds the lease. The
  // proxy knows the quote ID even when the sign's answer never reached it.
  server.app.post<{ Params: { quoteId: string } }>(
    '/internal/v1/quotes/:quoteId/release',
    { onRequest: authenticate, schema: { params: releaseParamsSchema } },
    async (request, reply) => {
      const { quoteId } = request.params;
      const released = await signer.release(quoteId);
      request.log.debug({ quoteId, released }, 'Released a quote\'s NEAR lease');

      return reply.status(204).send();
    },
  );

  return server;
};
