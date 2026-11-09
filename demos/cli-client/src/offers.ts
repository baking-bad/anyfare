// Reads a 402 into one plain model: x402 options, an MPP challenge, and Credits.

import { decodePaymentRequiredHeader } from '@x402/core/http';
import { Challenge } from 'mppx';
import type { PayWay } from './cli.ts';
import { findAsset, sameAddress } from './networks.ts';
import { Stop, isRecord, toAtomic } from './util.ts';

export interface Offer {
  readonly protocol: 'x402' | 'mpp' | 'credits';
  /** The x402 scheme, such as `exact`; `charge` for MPP; `credits` for Credits. */
  readonly scheme: string;
  /** The MPP method, such as `tempo`. */
  readonly method?: string;
  readonly network?: string;
  readonly asset?: string;
  /** The asset's own name, from `extra.name`. */
  readonly assetName?: string;
  /** Atomic units of the asset. For Credits: micro-USD. */
  readonly amount: bigint;
  readonly recipient?: string;
  /** How an x402 payment moves the asset, from `extra.assetTransferMethod`, such as `eip3009`. */
  readonly transferMethod?: string;
  /** The raw object the answer held, for payers that build a payment from it. */
  readonly raw: unknown;
}

export interface Offers {
  readonly x402Version: number | undefined;
  readonly offers: readonly Offer[];
}

export interface AnswerParts {
  readonly headers: Headers;
  readonly body: unknown;
}

const TEMPO_CHAIN_ID = 4217;

function atomic(value: unknown, what: string): bigint {
  if (typeof value === 'string' || typeof value === 'number') {
    try {
      return BigInt(value);
    } catch {
      // Falls through to the stop below.
    }
  }
  throw new Stop(`The 402 has ${what} that is not a whole number`);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function x402Offers(parts: AnswerParts): { version: number | undefined; offers: Offer[] } {
  const header = parts.headers.get('payment-required');
  let required: unknown;
  if (header !== null) {
    try {
      required = decodePaymentRequiredHeader(header);
    } catch {
      throw new Stop('The payment-required header of the 402 is not valid');
    }
  } else if (isRecord(parts.body) && Array.isArray(parts.body['accepts'])) {
    required = parts.body;
  }
  if (!isRecord(required) || !Array.isArray(required['accepts'])) return { version: undefined, offers: [] };

  const offers: Offer[] = [];
  for (const item of required['accepts'] as unknown[]) {
    if (!isRecord(item)) throw new Stop('The 402 lists a payment option that is not an object');
    const extra = isRecord(item['extra']) ? item['extra'] : {};
    const network = text(item['network']);
    const asset = text(item['asset']);
    const assetName = text(extra['name']);
    const recipient = text(item['payTo']);
    const transferMethod = text(extra['assetTransferMethod']);
    offers.push({
      protocol: 'x402',
      scheme: text(item['scheme']) ?? 'unknown',
      ...(network !== undefined && { network }),
      ...(asset !== undefined && { asset }),
      ...(assetName !== undefined && { assetName }),
      amount: atomic(item['amount'] ?? item['maxAmountRequired'], 'an amount'),
      ...(recipient !== undefined && { recipient }),
      ...(transferMethod !== undefined && { transferMethod }),
      raw: item,
    });
  }
  const version = typeof required['x402Version'] === 'number' ? required['x402Version'] : undefined;
  return { version, offers };
}

function mppOffers(headers: Headers): Offer[] {
  if (headers.get('www-authenticate') === null) return [];
  let challenges: ReturnType<typeof Challenge.fromHeadersList>;
  try {
    challenges = Challenge.fromHeadersList(headers);
  } catch (error) {
    // A header that names no Payment scheme, such as a Bearer one, is not an MPP challenge.
    if (error instanceof Error && error.message === 'No Payment schemes found.') return [];
    throw new Stop('The www-authenticate header of the 402 is not valid');
  }
  const offers: Offer[] = [];
  for (const challenge of challenges) {
    const request: unknown = challenge.request;
    if (!isRecord(request)) throw new Stop('An MPP challenge has a request that is not an object');
    const details = isRecord(request['methodDetails']) ? request['methodDetails'] : {};
    const chainId = details['chainId'];
    const currency = text(request['currency']);
    const recipient = text(request['recipient']);
    offers.push({
      protocol: 'mpp',
      scheme: challenge.intent,
      method: challenge.method,
      ...(typeof chainId === 'number' && { network: `eip155:${chainId}` }),
      ...(currency !== undefined && { asset: currency }),
      amount: atomic(request['amount'], 'an MPP amount'),
      ...(recipient !== undefined && { recipient }),
      raw: challenge,
    });
  }
  return offers;
}

function creditsOffers(body: unknown): Offer[] {
  if (!isRecord(body) || !isRecord(body['credits'])) return [];
  const credits = body['credits'];
  const price = text(credits['price']);
  if (price === undefined) return [];
  let micro: bigint;
  try {
    micro = toAtomic(price, 6);
  } catch {
    throw new Stop(`The Credits price of the 402 is not an amount: "${price}"`);
  }
  return [{ protocol: 'credits', scheme: 'credits', asset: 'USD', amount: micro, raw: credits }];
}

/** Every option a 402 lists. A header that cannot be read is a `Stop`. */
export function readOffers(parts: AnswerParts): Offers {
  const x402 = x402Offers(parts);
  return {
    x402Version: x402.version,
    offers: [...x402.offers, ...mppOffers(parts.headers), ...creditsOffers(parts.body)],
  };
}

/** The `--pay` value of this app that pays an offer of Anyfare's, or `undefined` when none does. */
export function payWayOf(offer: Offer): PayWay | undefined {
  if (offer.protocol === 'credits') return 'credits';
  if (offer.protocol === 'x402' && offer.scheme === 'exact') {
    if (offer.network === 'near:mainnet') return 'near';
    if (offer.network === 'eip155:8453') {
      const base = findAsset('eip155:8453', offer.asset);
      if (base?.symbol === 'USDC' && offer.asset !== undefined && sameAddress('eip155:8453', base.address, offer.asset)) {
        return 'base';
      }
    }
  }
  if (
    offer.protocol === 'mpp' &&
    offer.method === 'tempo' &&
    offer.scheme === 'charge' &&
    offer.network === `eip155:${TEMPO_CHAIN_ID}`
  ) {
    return 'tempo';
  }
  return undefined;
}
