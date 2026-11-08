import { createHash } from 'node:crypto';

import { AnyfareError, isRecord, type Secret } from '@anyfare/common';
import type { FacilitatorClient } from '@x402/core/server';
import type { PaymentPayload, PaymentRequirements, SettleResponse, SupportedResponse, VerifyResponse } from '@x402/core/types';

import type { CdpRequestSigner } from './cdp.js';

/** What a log line says about a facilitator call that failed. */
export interface FacilitatorCall {
  readonly network?: string;
  // `/supported`, `/verify`, or `/settle`
  readonly path?: string;
  readonly method?: string;
  // The answer's status, when there was one
  readonly status?: number;
  // The answer's errorReason or invalidReason, when it carried one
  readonly errorReason?: string;
  readonly durationMs?: number;
}

/**
 * The facilitator didn't answer usably: a timeout, a connection failure, or a `5xx`. For a settle the
 * outcome is unknown, so the payment is repeated later rather than treated as failed.
 */
export class FacilitatorUnavailableError extends AnyfareError {
  readonly code = 'facilitator_unavailable';
  readonly network: string | undefined;
  readonly path: string | undefined;
  readonly method: string | undefined;
  readonly status: number | undefined;
  // The answer's errorReason, else what went wrong: `timeout`, `connection failed`, or the status
  readonly reason: string;
  readonly durationMs: number | undefined;

  constructor(readonly facilitator: string, reason: string, options?: ErrorOptions & FacilitatorCall) {
    super(`The ${facilitator} facilitator is unavailable: ${reason}`, options?.cause === undefined ? undefined : { cause: options.cause });

    this.network = options?.network;
    this.path = options?.path;
    this.method = options?.method;
    this.status = options?.status;
    this.reason = options?.errorReason ?? reason;
    this.durationMs = options?.durationMs === undefined ? undefined : Math.round(options.durationMs);
  }
}

export interface FacilitatorOptions {
  // From platform config, for logs and readiness
  readonly name: string;
  readonly url: string;
  // The networks platform config gives it. Its `/supported` lists no other, so the resource server,
  // which takes the first facilitator that lists a network, never routes another network to it.
  readonly networks: readonly string[];
  // CDP's bearer token per request, or none for a facilitator without auth
  readonly signer: CdpRequestSigner | undefined;
  // Or a static key, sent in the X-API-Key header of every call. Never logged.
  readonly apiKey?: Secret | undefined;
  // `/supported` and `/verify`
  readonly requestTimeoutMs: number;
  // `/settle`: `timeouts.settleMs` from platform config
  readonly settleTimeoutMs: number;
  // Default: the global fetch
  readonly fetch?: typeof fetch;
}

/** One facilitator, as the x402 resource server calls it, plus its name. */
export interface Facilitator extends FacilitatorClient {
  readonly name: string;
}

// The longest answer read from a facilitator. A longer one is the facilitator being unavailable.
export const maxFacilitatorAnswerBytes = 1024 * 1024;
const tooLarge = Symbol('too large');

/** The answer's JSON, undefined when it isn't JSON, or `tooLarge` past the cap, without reading further. */
const readAnswer = async (response: Response): Promise<unknown> => {
  const length = Number(response.headers.get('content-length') ?? 0);
  if (length > maxFacilitatorAnswerBytes) {
    await response.body?.cancel().catch(() => undefined);
    return tooLarge;
  }
  if (!response.body)
    return undefined;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done)
        break;
      size += value.byteLength;
      if (size > maxFacilitatorAnswerBytes) {
        await reader.cancel().catch(() => undefined);
        return tooLarge;
      }
      chunks.push(value);
    }

    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  }
  catch {
    return undefined;
  }
};

// 4xx answers that say nothing about the payment: our auth, a timeout, or a rate limit
const notRefusals = new Set([401, 403, 408, 429]);

/**
 * The reason for a 4xx that carries no verify or settle answer, such as CDP's 400 or 409 in its own
 * error format, or a gateway's 404: `refused_<status>`. It says the facilitator refused, not why.
 */
export const refusedReason = (status: number): string => `refused_${status}`;

// How long a pending settle answer is kept for the same payment's next settle
const pendingAnswerMs = 2 * 60_000;

// The answer's own reason, for the log
const reasonOf = (answer: unknown): string | undefined => {
  const reason = isRecord(answer) ? answer['errorReason'] ?? answer['invalidReason'] : undefined;

  return typeof reason === 'string' && reason !== '' ? reason.slice(0, 200) : undefined;
};

const isVerifyResponse = (value: unknown): value is VerifyResponse => isRecord(value) && typeof value['isValid'] === 'boolean';

// The x402 pending answer: broadcast, not final yet
const settlementPendingReason = 'settlement_pending';

const isPending = (answer: SettleResponse): boolean => !answer.success && answer.errorReason === settlementPendingReason && !!answer.transaction;

const isSettleResponse = (value: unknown): value is SettleResponse =>
  isRecord(value) && typeof value['success'] === 'boolean' && typeof (value['transaction'] ?? '') === 'string' && typeof value['network'] === 'string';

const isSupportedResponse = (value: unknown): value is SupportedResponse =>
  isRecord(value) && Array.isArray(value['kinds']) && value['kinds'].every(kind => isRecord(kind) && typeof kind['scheme'] === 'string' && typeof kind['network'] === 'string');

/**
 * A facilitator over HTTP: `GET /supported`, `POST /verify`, `POST /settle`, with the body the x402
 * SDK's client sends. A `4xx` that carries a verify or settle answer is that answer. Any other `4xx`
 * on verify or settle refuses the payment, as CDP's `400` for a malformed one does, with the reason
 * `refused_<status>`. A `401`, `403`,
 * `408`, `429` or `5xx`, whatever its body, a timeout, a failed connection, a redirect, an answer over
 * 1 MiB, or one that isn't an answer throw FacilitatorUnavailableError.
 *
 * The resource server repeats a pending settle once and keeps only the second answer. So a pending
 * answer is kept for the same payment's next settle: when that one throws, or is neither settled nor
 * pending, the pending answer comes back instead, and the broadcast transaction isn't lost. Unless the
 * repeat reports that same transaction as failed: that is the final outcome.
 */
export const createFacilitator = ({
  name, url, networks, signer, apiKey, requestTimeoutMs, settleTimeoutMs, fetch: send = fetch,
}: FacilitatorOptions): Facilitator => {
  const base = url.replace(/\/+$/, '');
  // Pending settle answers, by a hash of the payment's payload
  const pending = new Map<string, { readonly answer: SettleResponse; readonly until: number }>();
  const pendingKey = (paymentPayload: PaymentPayload): string => createHash('sha256').update(JSON.stringify(paymentPayload.payload)).digest('hex');
  const takePending = (key: string): SettleResponse | undefined => {
    const kept = pending.get(key);
    pending.delete(key);

    return kept && kept.until > performance.now() ? kept.answer : undefined;
  };
  const keepPending = (key: string, answer: SettleResponse): void => {
    const now = performance.now();
    for (const [other, kept] of pending) {
      if (kept.until <= now)
        pending.delete(other);
    }
    pending.set(key, { answer, until: now + pendingAnswerMs });
  };

  const call = async <TAnswer>(
    method: 'GET' | 'POST',
    path: string,
    payload: unknown,
    timeoutMs: number,
    accept: (value: unknown) => value is TAnswer,
    // The answer to a request the facilitator refused, such as CDP's 400 for a malformed payload, by its status
    refused?: (status: number) => TAnswer,
    network?: string,
  ): Promise<TAnswer> => {
    const target = new URL(`${base}${path}`);
    const started = performance.now();
    const failure = (extra: Pick<FacilitatorCall, 'status' | 'errorReason'> = {}): FacilitatorCall => ({
      method, path, ...network === undefined ? {} : { network }, ...extra, durationMs: performance.now() - started,
    });
    let response: Response;
    try {
      response = await send(target, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(signer ? { authorization: `Bearer ${signer(method, target)}` } : {}),
          ...(apiKey ? { 'x-api-key': apiKey.expose() } : {}),
        },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload, (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value) }),
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    }
    catch (error) {
      throw new FacilitatorUnavailableError(name, error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'connection failed', { cause: error, ...failure() });
    }
    const answer = await readAnswer(response);
    if (answer === tooLarge)
      throw new FacilitatorUnavailableError(name, `${path} answered more than ${maxFacilitatorAnswerBytes} bytes`, failure({ status: response.status }));
    // Auth, timeout, rate limit, and server errors are ours to fix, not the buyer's, whatever their body
    const ours = response.status >= 500 || notRefusals.has(response.status);
    if (!ours && accept(answer))
      return answer;
    // Any other 4xx refuses the payment
    if (!ours && refused && response.status >= 400 && response.status < 500)
      return refused(response.status);

    const errorReason = reasonOf(answer);
    throw new FacilitatorUnavailableError(name, `${path} answered ${response.status}`, failure({ status: response.status, ...errorReason === undefined ? {} : { errorReason } }));
  };

  return {
    name,
    getSupported: async () => {
      const supported = await call('GET', '/supported', undefined, requestTimeoutMs, isSupportedResponse);

      return { ...supported, kinds: supported.kinds.filter(kind => networks.includes(kind.network)) };
    },
    verify: (paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements) =>
      call('POST', '/verify', { x402Version: paymentPayload.x402Version, paymentPayload, paymentRequirements }, requestTimeoutMs, isVerifyResponse,
        status => ({ isValid: false, invalidReason: refusedReason(status) }), paymentRequirements.network),
    settle: async (paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements) => {
      const key = pendingKey(paymentPayload);
      // Kept by the previous settle of this payment, and used once
      const kept = takePending(key);
      let answer: SettleResponse;
      try {
        // A refused settle failed. Whether an earlier settle of the same payment landed, this answer can't tell.
        answer = await call('POST', '/settle', { x402Version: paymentPayload.x402Version, paymentPayload, paymentRequirements }, settleTimeoutMs, isSettleResponse,
          status => ({ success: false, errorReason: refusedReason(status), transaction: '', network: paymentRequirements.network }), paymentRequirements.network);
      }
      catch (error) {
        if (kept)
          return kept;
        throw error;
      }
      if (isPending(answer)) {
        if (!kept)
          keepPending(key, answer);
        return answer;
      }

      if (answer.success || !kept)
        return answer;

      // The broadcast transaction failed on chain
      const sameTransactionFailed = answer.transaction === kept.transaction && answer.errorReason !== settlementPendingReason;

      return sameTransactionFailed ? answer : kept;
    },
  };
};
