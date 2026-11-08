import {
  formatUsd, isRecord, outboundErrorCode, outboundFields, ResponseTooLargeError, type Logger, type LogSink, type MicroUsd, type OutboundHttp,
  type Secret,
} from '@anyfare/common';
import type { PlatformConfig } from '@anyfare/core';
import type { Redis } from '@anyfare/db';
import type { ChosenOption } from '@anyfare/payments';

/** The x402 option the Signer pays, as the target sent it. */
export type X402Requirement = Extract<ChosenOption, { readonly protocol: 'x402' }>['requirement'];

/** What a log line says about a Signer call that failed. */
export interface SignerFailure {
  readonly host: string;
  readonly method: 'POST';
  readonly path: string;
  // The Signer's answer, when there was one
  readonly status?: number;
  // `signing_refused` with the Signer's reason, or the transport's error code, such as `ECONNREFUSED`
  readonly code?: string;
  readonly reason?: string;
  readonly durationMs: number;
}

/** The Signer can't be reached, or refused: the buyer pays nothing. */
export class SignerUnavailableError extends Error {
  readonly failure: SignerFailure | undefined;

  constructor(message: string, options?: ErrorOptions & { readonly failure?: SignerFailure }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });

    this.failure = options?.failure;
  }
}

export const signPath = '/internal/v1/sign';
export const signerSecretHeader = 'x-signer-secret';

// The Signer's error envelope: its code and reason, never anything else of the body
const refusalOf = async (response: Response): Promise<{ readonly code?: string; readonly reason?: string }> => {
  try {
    const body: unknown = await response.json();
    const error = isRecord(body) && isRecord(body['error']) ? body['error'] : undefined;
    const code = typeof error?.['code'] === 'string' ? error['code'].slice(0, 64) : undefined;
    const reason = typeof error?.['message'] === 'string' ? error['message'].split('\n', 1)[0]!.slice(0, 200) : undefined;

    return { ...code === undefined ? {} : { code }, ...reason === undefined ? {} : { reason } };
  }
  catch {
    return {};
  }
};

/** What the Signer gives back for a target payment. */
export interface SignedPayment {
  // The PAYMENT-SIGNATURE value for x402, or the Authorization value for MPP: it pays the target, so it's never logged
  readonly header: string;
  readonly signatureId: string;
  readonly network: string;
  readonly asset: string;
  readonly atomicAmount: bigint;
  readonly amount: MicroUsd;
  readonly payTo: string;
}

/** What the Signer pays: the chosen x402 option, or the target's MPP challenge as it sent it. */
export type SignInput = {
  readonly requestId: string;
  readonly quoteId: string;
  readonly url: string;
  // The target's price the buyer was quoted: the Signer never signs above it
  readonly quotedPrice: MicroUsd;
} & ({
  readonly protocol: 'x402';
  readonly requirement: X402Requirement;
  readonly resource: unknown;
} | {
  readonly protocol: 'mpp';
  readonly challenge: string;
});

export interface SignerClient {
  sign(input: SignInput): Promise<SignedPayment>;
}

const decimalPattern = /^\d{1,40}$/;

// A 200's body, checked: a Signer that answers anything else signed nothing we can use
const signedPaymentOf = (body: unknown): SignedPayment | undefined => {
  if (!isRecord(body))
    return undefined;
  const { header, signatureId, network, asset, atomicAmount, amount, payTo } = body;
  const texts = [header, signatureId, network, asset, payTo];
  if (!texts.every(value => typeof value === 'string' && value !== '') || typeof atomicAmount !== 'string' || typeof amount !== 'string'
    || !decimalPattern.test(atomicAmount) || !decimalPattern.test(amount))
    return undefined;

  return {
    header: header as string, signatureId: signatureId as string, network: network as string, asset: asset as string, payTo: payTo as string,
    atomicAmount: BigInt(atomicAmount), amount: BigInt(amount) as MicroUsd,
  };
};

/**
 * The Signer's internal API, `POST /internal/v1/sign`, with its shared secret and the routed call's
 * request ID. Only x402 version 2 is signed. Any failure is SignerUnavailableError.
 */
export const createSignerClient = ({ url, secret, timeoutMs, fetch = globalThis.fetch }: {
  readonly url: string;
  readonly secret: Secret;
  readonly timeoutMs: number;
  readonly fetch?: typeof globalThis.fetch;
}): SignerClient => ({
  sign: async input => {
    const target = `${url.replace(/\/+$/, '')}${signPath}`;
    const started = performance.now();
    const failure = (extra: Pick<SignerFailure, 'status' | 'code' | 'reason'>): SignerFailure => {
      const { host, path } = outboundFields({ url: target, method: 'POST' });

      return { host: String(host), method: 'POST', path: String(path), ...extra, durationMs: Math.round(performance.now() - started) };
    };
    const body = input.protocol === 'x402'
      ? { ...input, x402Version: 2, quotedPrice: input.quotedPrice.toString() }
      : { ...input, quotedPrice: input.quotedPrice.toString() };
    let response: Response;
    try {
      response = await fetch(target, {
        method: 'POST',
        // The request ID goes along, so one ID finds the call in both apps' logs
        headers: { 'content-type': 'application/json', [signerSecretHeader]: secret.expose(), 'x-request-id': input.requestId },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    }
    catch (error) {
      const code = outboundErrorCode(error);
      throw new SignerUnavailableError('The Signer didn\'t answer', { cause: error, failure: failure(code === undefined ? {} : { code }) });
    }
    if (!response.ok) {
      // A 422 signing_refused says why: its code and reason, never the rest of the body
      const refusal = await refusalOf(response);
      throw new SignerUnavailableError(`The Signer answered ${response.status}${refusal.code ? ` ${refusal.code}` : ''}`, { failure: failure({ status: response.status, ...refusal }) });
    }
    let signed: SignedPayment | undefined;
    try {
      signed = signedPaymentOf(await response.json());
    }
    catch (error) {
      throw new SignerUnavailableError('The Signer\'s answer couldn\'t be read', { cause: error, failure: failure({ status: response.status, code: 'invalid_answer' }) });
    }
    if (!signed)
      throw new SignerUnavailableError('The Signer\'s answer isn\'t a signed payment', { failure: failure({ status: response.status, code: 'invalid_answer' }) });

    return signed;
  },
});

/**
 * The hostnames the platform owns: the exact hosts of its three URLs, and `ownHosts`. Never a whole
 * registrable domain: another subdomain of it isn't ours unless `ownHosts` names it.
 */
export const ownDomainsOf = (config: Pick<PlatformConfig, 'urls' | 'ownHosts'>): readonly string[] => {
  const domains = new Set<string>();
  for (const url of [config.urls.website, config.urls.api, config.urls.pay])
    domains.add(new URL(url).hostname.toLowerCase());
  for (const host of config.ownHosts)
    domains.add(host.toLowerCase());

  return [...domains];
};

/** Whether a hostname is one of ours, or a subdomain of one. */
export const isOwnHost = (hostname: string, domains: readonly string[]): boolean => {
  const host = hostname.toLowerCase().replace(/\.$/, '');

  return domains.some(domain => host === domain || host.endsWith(`.${domain}`));
};

// Where a host opts out of routing, on its own origin
export const optOutPath = '/.well-known/anyfare.json';
// An answer is kept a day per host, in Redis under `optout:<host>`. No answer at all, such as a
// timeout, is kept for minutes: the host may still say no.
export const optOutTtlSeconds = 24 * 60 * 60;
const optOutRetrySeconds = 5 * 60;
export const optOutTimeoutMs = 2_000;
export const optOutBodyLimit = 16 * 1024;
const jsonTypePattern = /^application\/(?:[\w.+-]+\+)?json\s*(?:;|$)/i;

type OptOutRead =
  | { readonly answered: true; readonly optedOut: boolean; readonly problem?: string; readonly status?: number }
  | { readonly answered: false; readonly code: string };

const firstHeader = (value: string | readonly string[] | undefined): string | undefined => typeof value === 'string' ? value : value?.[0];

/**
 * Whether a host opted out of routing: `GET https://<host>/.well-known/anyfare.json` answers JSON with
 * `"routing": false`. Any other answer, a missing file, or one that can't be read is no opt-out.
 * Answers are cached a day.
 */
export const createOptOutCheck = ({ http, redis, logger }: {
  readonly http: Pick<OutboundHttp, 'request'>;
  readonly redis: Redis;
  readonly logger: Logger;
}) => {
  const read = async (host: string): Promise<OptOutRead> => {
    let response;
    try {
      response = await http.request({
        url: `https://${host}${optOutPath}`,
        method: 'GET',
        headers: { accept: 'application/json' },
        redirect: 'sameHost',
        totalTimeoutMs: optOutTimeoutMs,
        maxResponseBytes: optOutBodyLimit,
      });
    }
    catch (error) {
      return { answered: false, code: outboundErrorCode(error) ?? 'unknown' };
    }
    const { status } = response;
    if (status !== 200) {
      response.dispose();

      return { answered: true, optedOut: false, status, problem: status === 404 || status === 410 ? 'file_not_found' : 'unexpected_status' };
    }
    if (!jsonTypePattern.test(firstHeader(response.headers['content-type']) ?? '')) {
      response.dispose();

      return { answered: true, optedOut: false, status, problem: 'not_json' };
    }
    let text: string;
    try {
      text = await response.text();
    }
    catch (error) {
      return error instanceof ResponseTooLargeError
        ? { answered: true, optedOut: false, status, problem: 'too_large' }
        : { answered: false, code: outboundErrorCode(error) ?? 'unreadable' };
    }
    let file: unknown;
    try {
      file = JSON.parse(text);
    }
    catch {
      return { answered: true, optedOut: false, status, problem: 'invalid_json' };
    }

    return isRecord(file) ? { answered: true, optedOut: file['routing'] === false, status } : { answered: true, optedOut: false, status, problem: 'not_an_object' };
  };

  // `log`: the request's logger, so its lines carry the request ID
  return async (host: string, log: LogSink = logger): Promise<boolean> => {
    const key = `${redis.prefix}optout:${host}`;
    try {
      const cached = await redis.client.get(key);
      if (cached !== null)
        return cached === '1';
    }
    catch (error) {
      log.warn({ error, host }, 'The opt-out cache is unavailable');
    }
    const result = await read(host);
    const optedOut = result.answered && result.optedOut;
    // Most hosts have no file: that is no opt-out. A file that can't be read is none either, and says why.
    if (!result.answered)
      log.info({ host, code: result.code, timeoutMs: optOutTimeoutMs }, 'The routing opt-out file didn\'t arrive: no opt-out');
    else if (result.problem !== undefined)
      log[result.problem === 'file_not_found' ? 'debug' : 'info']({ host, status: result.status, problem: result.problem }, 'The routing opt-out file couldn\'t be read: no opt-out');
    else if (optedOut)
      log.info({ host }, 'The host opted out of routing');
    try {
      await redis.client.set(key, optedOut ? '1' : '0', { expiration: { type: 'EX', value: result.answered ? optOutTtlSeconds : optOutRetrySeconds } });
    }
    catch (error) {
      log.warn({ error, host }, 'Failed to cache an opt-out');
    }

    return optedOut;
  };
};

export type OptOutCheck = ReturnType<typeof createOptOutCheck>;

export const routedEndpointsPath = '/internal/v1/routed-endpoints';
export const internalSecretHeader = 'x-internal-secret';

/**
 * Registers routed endpoints off the hot path, through the internal API, once each. A registration
 * that got no answer or a 5xx is forgotten, so the next call tries again; a 4xx is final.
 */
export const createEndpointRegistrar = ({ url, secret, logger, fetch = globalThis.fetch, capacity = 1_000, timeoutMs = 5_000, maxSeen = 10_000 }: {
  readonly url: string | undefined;
  readonly secret: Secret | undefined;
  readonly logger: Logger;
  readonly fetch?: typeof globalThis.fetch;
  // How many registrations may wait at once. Past it, a call registers nothing.
  readonly capacity?: number;
  readonly timeoutMs?: number;
  // How many endpoints it remembers as registered. Past it, it forgets them all: paths are unbounded.
  readonly maxSeen?: number;
}) => {
  const seen = new Set<string>();
  const queue: { readonly endpoint: { host: string; path: string; quote?: string }; readonly requestId: string | undefined }[] = [];
  let running = false;

  const drain = async (): Promise<void> => {
    if (running)
      return;
    running = true;
    try {
      while (queue.length > 0) {
        const { endpoint, requestId } = queue.shift()!;
        const target = `${url!.replace(/\/+$/, '')}${routedEndpointsPath}`;
        const started = performance.now();
        // The routed call's request ID goes along, so the internal API's lines carry it too
        const failed = (outcome: { readonly status?: number; readonly error?: unknown }, message: string): void => {
          logger.warn({
            ...outboundFields({ url: target, method: 'PUT', ...outcome, durationMs: performance.now() - started }),
            ...requestId === undefined ? {} : { requestId }, endpointHost: endpoint.host, ...outcome.error === undefined ? {} : { error: outcome.error },
          }, message);
        };
        try {
          const response = await fetch(target, {
            method: 'PUT',
            headers: {
              'content-type': 'application/json', [internalSecretHeader]: secret!.expose(), 'x-internal-caller': 'proxy',
              ...requestId === undefined ? {} : { 'x-request-id': requestId },
            },
            body: JSON.stringify(endpoint),
            signal: AbortSignal.timeout(timeoutMs),
          });
          await response.body?.cancel();
          // A 5xx may pass: the next call tries again. A 4xx refused this endpoint for good.
          if (response.status >= 500)
            seen.delete(`${endpoint.host}${endpoint.path}`);
          if (!response.ok)
            failed({ status: response.status }, 'The internal API refused to register a routed endpoint');
        }
        catch (error) {
          seen.delete(`${endpoint.host}${endpoint.path}`);
          failed({ error }, 'Failed to register a routed endpoint: the next call registers it');
        }
      }
    }
    finally {
      running = false;
    }
  };

  return {
    register: (host: string, path: string, quote?: MicroUsd, requestId?: string): void => {
      if (!url || !secret)
        return;
      const key = `${host}${path}`;
      if (seen.has(key) || queue.length >= capacity)
        return;
      if (seen.size >= maxSeen)
        seen.clear();
      seen.add(key);
      queue.push({ endpoint: { host, path, ...quote === undefined ? {} : { quote: formatUsd(quote) } }, requestId });
      void drain();
    },
    /** For tests and shutdown: waits until the queue is empty. */
    settled: async (): Promise<void> => {
      while (queue.length > 0 || running)
        await new Promise(resolve => setTimeout(resolve, 5));
    },
  };
};

export type EndpointRegistrar = ReturnType<typeof createEndpointRegistrar>;
