import { isRecord, outboundErrorCode, type MicroUsd, type Secret } from '@anyfare/common';
import type { JsonObject } from '@anyfare/core';

// The Signer's refill route, and the shared secret's header
export const refillPath = '/internal/v1/refills';
export const signerSecretHeader = 'x-signer-secret';
/**
 * How long the workers wait for a refill's answer: longer than the Signer's worst case for one, about
 * 125 s with the default timeouts, its lease on the NEAR hot wallet. A shorter wait would leave the
 * Signer working on a refill the workers think failed.
 */
export const refillTimeoutMs = 150_000;

/** What the Signer sent from its NEAR hot wallet, or may have sent: 1Click's quote and its transaction. */
export interface SignerTransfer {
  readonly depositAddress: string;
  // In the source's and the target's atomic units
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly quoteDeadline: Date;
  readonly correlationId: string;
  readonly transactionHash: string;
}

/** The Signer's answer to a refill. Only `sent` and `unknown` may have moved money. */
export type SignerRefill =
  // 200: sent, with 1Click's quote as it came
  | { readonly kind: 'sent'; readonly transfer: SignerTransfer; readonly quote: JsonObject }
  // 502 refill_unknown: the transaction may have landed
  | { readonly kind: 'unknown'; readonly transfer: SignerTransfer }
  // 502 refill_failed: the transaction failed, and nothing moved
  | { readonly kind: 'failed'; readonly transactionHash: string | undefined; readonly message: string }
  // 409 refill_in_progress: another ask of this ID runs, or stopped in the middle. Asked again later.
  | { readonly kind: 'in_progress'; readonly message: string }
  // Refused or busy before anything was sent: 409 payer_busy, 422 signing_refused with its reason, 502 signing_failed, or a 503
  | { readonly kind: 'not_sent'; readonly status: number; readonly code: string; readonly reason: string | undefined; readonly message: string }
  // No answer, or one that says nothing usable: a network error, a timeout, another status, or a body we can't read
  | { readonly kind: 'no_answer'; readonly status: number | undefined; readonly code: string | undefined; readonly message: string };

export interface RefillRequest {
  // The workers' refill ID: the Signer sends at most once for it
  readonly refillId: string;
  readonly asset: string;
  // What the target wallet must receive
  readonly amount: MicroUsd;
}

export interface RefillSigner {
  /** Asks the Signer for a refill. Never throws: every outcome is an answer. */
  refill(request: RefillRequest): Promise<SignerRefill>;
}

// The 503s the Signer answers before it sends anything
const unavailableCodes: readonly string[] = ['refills_off', 'oneclick_unavailable', 'redis_not_ready'];
const digitsPattern = /^\d{1,40}$/;
// What a line keeps of a value the Signer sent
const maxTextLength = 200;

const text = (value: unknown): string | undefined => typeof value === 'string' && value !== '' ? value.split('\n', 1)[0]!.slice(0, maxTextLength) : undefined;

// The fields of a sent or unknown refill, checked: undefined when any is missing or malformed
const transferOf = (body: Record<string, unknown>): SignerTransfer | undefined => {
  const { depositAddress, amountIn, amountOut, quoteDeadline, correlationId, transactionHash } = body;
  if (typeof depositAddress !== 'string' || depositAddress === '' || typeof correlationId !== 'string' || typeof transactionHash !== 'string' || transactionHash === '')
    return undefined;
  if (typeof amountIn !== 'string' || !digitsPattern.test(amountIn) || typeof amountOut !== 'string' || !digitsPattern.test(amountOut))
    return undefined;
  const deadline = typeof quoteDeadline === 'string' ? new Date(quoteDeadline) : undefined;
  if (!deadline || Number.isNaN(deadline.getTime()))
    return undefined;

  return { depositAddress, amountIn: BigInt(amountIn), amountOut: BigInt(amountOut), quoteDeadline: deadline, correlationId, transactionHash };
};

/** Reads the Signer's answer: its status, and its JSON body when it has one. */
export const signerRefillOf = (request: RefillRequest, status: number, body: unknown): SignerRefill => {
  const error = isRecord(body) && isRecord(body['error']) ? body['error'] : undefined;
  const code = text(error?.['code'])?.slice(0, 64);
  const message = text(error?.['message']) ?? `The Signer answered ${status}`;
  const unreadable = (detail: string): SignerRefill => ({ kind: 'no_answer', status, code, message: detail });

  if (status === 200) {
    const transfer = isRecord(body) ? transferOf(body) : undefined;
    const quote = isRecord(body) ? body['quote'] : undefined;
    // An answer for another refill is no answer for this one
    if (!isRecord(body) || body['refillId'] !== request.refillId || body['asset'] !== request.asset || body['amount'] !== request.amount.toString())
      return unreadable('The Signer\'s answer isn\'t for this refill');
    if (!transfer || !isRecord(quote))
      return unreadable('The Signer\'s answer isn\'t a sent refill');

    return { kind: 'sent', transfer, quote: quote as JsonObject };
  }
  if (status === 502 && code === 'refill_unknown') {
    const transfer = isRecord(body) ? transferOf(body) : undefined;

    return transfer ? { kind: 'unknown', transfer } : unreadable('The Signer\'s refill_unknown has no transfer');
  }
  if (status === 502 && code === 'refill_failed')
    return { kind: 'failed', transactionHash: isRecord(body) ? text(body['transactionHash']) : undefined, message };
  if (status === 409 && code === 'refill_in_progress')
    return { kind: 'in_progress', message };
  const refused = (status === 409 && code === 'payer_busy') || (status === 422 && code === 'signing_refused') || (status === 502 && code === 'signing_failed')
    || (status === 503 && code !== undefined && unavailableCodes.includes(code));
  if (refused && code !== undefined)
    return { kind: 'not_sent', status, code, reason: isRecord(body) ? text(body['reason'])?.slice(0, 64) : undefined, message };

  return { kind: 'no_answer', status, code, message };
};

/**
 * The Signer's `POST /internal/v1/refills`, with its shared secret and the refill ID as the request ID,
 * within `timeoutMs`: by default longer than the Signer's worst case, never the connect timeout.
 */
export const createRefillSigner = ({ url, secret, timeoutMs = refillTimeoutMs, fetch = globalThis.fetch }: {
  // SIGNER_URL
  readonly url: string;
  // SIGNER_SECRET
  readonly secret: Secret;
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
}): RefillSigner => ({
  refill: async request => {
    const target = `${url.replace(/\/+$/, '')}${refillPath}`;
    let response: Response;
    let body: unknown;
    try {
      response = await fetch(target, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [signerSecretHeader]: secret.expose(), 'x-request-id': request.refillId },
        body: JSON.stringify({ refillId: request.refillId, asset: request.asset, amount: request.amount.toString() }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const raw = await response.text();
      try {
        body = raw === '' ? undefined : JSON.parse(raw);
      }
      catch {
        body = undefined;
      }
    }
    catch (error) {
      // No answer: the Signer may still be working on it, so the refill is asked again with its ID
      return { kind: 'no_answer', status: undefined, code: outboundErrorCode(error), message: 'The Signer didn\'t answer' };
    }

    return signerRefillOf(request, response.status, body);
  },
});
