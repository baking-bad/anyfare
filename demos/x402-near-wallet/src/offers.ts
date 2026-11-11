// Reads a 402 into its x402 request, and picks the one option this app pays: USDC on NEAR, by the
// exact scheme. Anything else is a `NotSupported` that says what the API takes instead.

import { decodePaymentRequiredHeader } from '@x402/core/http';
import type { PaymentRequired, PaymentRequirements } from '@x402/core/types';
import { clip } from './errors.ts';
import type { Answer } from './http.ts';
import { NEAR_NETWORK, NETWORK_NAMES, assetLabel, isKnownUsdc, networkName, sameAddress } from './networks.ts';
import { NotSupported, isRecord } from './util.ts';
import { checkOption } from './x402.ts';

export { isKnownUsdc } from './networks.ts';

/** The x402 request of a 402. */
export interface X402Request {
  readonly x402Version: number;
  /** As the API gave them: any JSON, checked only when an option is chosen. */
  readonly accepts: readonly unknown[];
  /** The decoded `PAYMENT-REQUIRED` header, or the JSON body: what the payer signs from. */
  readonly required: Readonly<Record<string, unknown>>;
}

/** The option this app pays, and the 402 it came from. */
export interface Choice {
  readonly required: PaymentRequired;
  readonly option: PaymentRequirements;
  /** The amount, in micro-USD: USDC on NEAR has 6 decimals. */
  readonly micro: bigint;
}

const NOTHING_PAID = 'Nothing paid.';

/** Text from the API as a short label for a line: one line, no control characters, at most 40 characters. */
function label(value: unknown, fallback: string): string {
  const text = typeof value === 'string' ? clip(value) : '';
  if (text === '') return fallback;
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

/**
 * The x402 request of a 402: the `PAYMENT-REQUIRED` header, or the JSON body when there is no
 * header. Neither, a header that does not decode, or a version other than 2: a `NotSupported` with
 * `hint` after it.
 */
export function readX402(answer: Answer, hint: readonly string[]): X402Request {
  const header = answer.headers.get('payment-required');
  let required: unknown;
  if (header !== null) {
    try {
      required = decodePaymentRequiredHeader(header);
    } catch {
      required = undefined;
    }
  } else {
    required = answer.body;
  }
  if (!isRecord(required) || !Array.isArray(required['accepts']) || typeof required['x402Version'] !== 'number') {
    throw new NotSupported(`Not supported: no x402 payment request. ${NOTHING_PAID}`, hint);
  }
  const version = required['x402Version'];
  // A JSON number: finite, and printed as digits
  if (version !== 2) throw new NotSupported(`Not supported: it asks for x402 version ${version}. This app pays version 2. ${NOTHING_PAID}`, hint);
  return { x402Version: version, accepts: required['accepts'] as unknown[], required };
}

const records = (accepts: readonly unknown[]): Record<string, unknown>[] => accepts.filter(isRecord);
const textOf = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

/** "A", "A, and B", "A, B, and C". */
function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1] ?? ''}`;
}

/**
 * What the options take, for the line of an API that doesn't take NEAR: each network once, the known
 * ones in the order of `NETWORK_NAMES`, then the others in the order they come. On each, its one
 * asset by name, or how many tokens it takes.
 */
export function takesList(accepts: readonly unknown[]): string {
  const networks = new Map<string, { asset: string | undefined; name: unknown }[]>();
  for (const option of records(accepts)) {
    const network = textOf(option['network']);
    if (network === undefined) continue;
    const asset = textOf(option['asset']);
    const assets = networks.get(network) ?? [];
    const same = (other: string | undefined): boolean =>
      asset === undefined || other === undefined ? asset === other : sameAddress(network, asset, other);
    if (!assets.some((item) => same(item.asset))) {
      assets.push({ asset, name: isRecord(option['extra']) ? option['extra']['name'] : undefined });
    }
    networks.set(network, assets);
  }
  const known = Object.keys(NETWORK_NAMES).filter((network) => networks.has(network));
  const others = [...networks.keys()].filter((network) => !Object.hasOwn(NETWORK_NAMES, network));
  return joinList(
    [...known, ...others].map((network) => {
      const assets = networks.get(network) ?? [];
      const where = Object.hasOwn(NETWORK_NAMES, network) ? networkName(network) : label(network, 'an unknown network');
      const first = assets[0];
      if (assets.length === 1 && first !== undefined) {
        return `${label(assetLabel(network, first.asset, textOf(first.name)), 'an unknown token')} on ${where}`;
      }
      return `${assets.length} tokens on ${where}`;
    }),
  );
}

/**
 * The one option this app pays: of the exact scheme, on NEAR, in its known USDC, and passed by
 * `checkOption`; the lowest amount, the first on a tie. Anything else is a `NotSupported`: the
 * cases an API that takes something else, with `hint` after it; and USDC on NEAR the app won't sign,
 * without it.
 */
export function chooseOption(x402: X402Request, hint: readonly string[]): Choice {
  const options = records(x402.accepts);
  const near = options.filter((option) => option['network'] === NEAR_NETWORK);
  if (near.length === 0) {
    const list = takesList(x402.accepts);
    const takes = list === '' ? '' : ` It takes ${list}.`;
    throw new NotSupported(`Not supported: this API doesn't take NEAR.${takes} ${NOTHING_PAID}`, hint);
  }
  const exact = near.filter((option) => option['scheme'] === 'exact');
  if (exact.length === 0) {
    const scheme = label(near[0]?.['scheme'], 'unnamed');
    throw new NotSupported(`Not supported: it asks for the ${scheme} scheme on NEAR. This app pays exact only. ${NOTHING_PAID}`, hint);
  }
  const usdc = exact.filter((option) => isKnownUsdc(NEAR_NETWORK, textOf(option['asset'])));
  if (usdc.length === 0) {
    const first = exact[0] ?? {};
    const name = isRecord(first['extra']) ? textOf(first['extra']['name']) : undefined;
    const token = label(assetLabel(NEAR_NETWORK, textOf(first['asset']), name), 'an unknown token');
    throw new NotSupported(`Not supported: it asks for ${token} on NEAR. This app pays USDC only. ${NOTHING_PAID}`, hint);
  }
  let refusal: unknown;
  let best: PaymentRequirements | undefined;
  for (const raw of usdc) {
    let option: PaymentRequirements;
    try {
      option = checkOption(raw);
    } catch (error) {
      refusal ??= error;
      continue;
    }
    if (best === undefined || BigInt(option.amount) < BigInt(best.amount)) best = option;
  }
  if (best === undefined) throw refusal;
  return {
    required: { ...x402.required, x402Version: 2, accepts: [best] } as unknown as PaymentRequired,
    option: best,
    micro: BigInt(best.amount),
  };
}
