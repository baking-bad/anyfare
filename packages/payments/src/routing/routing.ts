import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from '@x402/core/http';
import type { PaymentRequirements } from '@x402/core/types';
import { Challenge, Receipt } from 'mppx';

import { AnyfareError, isRecord, type MicroUsd } from '@anyfare/common';
import { checkTempoCharge, findNetwork, type Asset, type PlatformConfig, type TempoChargeRefusal } from '@anyfare/core';

/** The link isn't `/<host>/<path>` with a DNS host. */
export class InvalidTargetError extends AnyfareError {
  readonly code = 'invalid_target';
}

/** A host the platform doesn't route to. */
export class HostNotAllowedError extends AnyfareError {
  readonly code = 'host_not_allowed';

  constructor(message = 'Anyfare doesn\'t route payments to this host') {
    super(message);
  }
}

/** The target answered without a 402, so there's nothing to pay. */
export class NotPayableError extends AnyfareError {
  readonly code = 'not_payable';

  constructor() {
    super('The target didn\'t ask for a payment: Anyfare routes paid calls only');
  }
}

/** No option of the target's 402 is one the platform pays. */
export class UnsupportedPaymentError extends AnyfareError {
  readonly code = 'unsupported_payment';

  constructor() {
    super('The target asks for no payment Anyfare can make');
  }
}

/** The target asked more on the paid retry than it quoted. */
export class QuoteExceededError extends AnyfareError {
  readonly code = 'quote_exceeded';

  constructor() {
    super('The target asked for more than its quoted price: nothing was paid');
  }
}

/** A routed link's target. */
export interface RoutingTarget {
  // Lowercase, with the port when one other than 443 was given
  readonly host: string;
  // The hostname alone, for policy checks
  readonly hostname: string;
  // Starts with `/`, without the query
  readonly path: string;
  // With its `?`, or empty
  readonly search: string;
  // Always HTTPS
  readonly url: string;
}

// The whole host segment: a name without colons, and at most one port
const hostPattern = /^([^:]+)(?::(\d{1,5}))?$/;
const hostnamePattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/;
const ipv4Pattern = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * Parses `/<host>/<path>?<query>`: the host has at least one dot and an optional port from 1 to
 * 65535, and isn't an IP address. The target is `https://<host>/<path>?<query>`, and the URL parser
 * must find in it the very host that passed these checks.
 */
export const parseRoutingTarget = (pathAndQuery: string): RoutingTarget => {
  const queryAt = pathAndQuery.indexOf('?');
  const rawPath = queryAt === -1 ? pathAndQuery : pathAndQuery.slice(0, queryAt);
  const search = queryAt === -1 ? '' : pathAndQuery.slice(queryAt);
  const [, rawHost = '', ...rest] = rawPath.split('/');
  const match = hostPattern.exec(rawHost.toLowerCase());
  const hostname = match?.[1] ?? '';
  const port = match?.[2] === undefined ? undefined : Number(match[2]);
  if (rawHost.includes(':') && (port === undefined || port < 1 || port > 65_535))
    throw new InvalidTargetError('The target\'s port must be a number from 1 to 65535');
  if (ipv4Pattern.test(hostname) || hostname.startsWith('['))
    throw new InvalidTargetError('The target must be a host name, not an IP address');
  if (!hostnamePattern.test(hostname))
    throw new InvalidTargetError('The link must be the target URL without https://, such as /api.example.com/v1/pools');
  // 443 is HTTPS's own port: the URL drops it, so the host does too
  const host = port === undefined || port === 443 ? hostname : `${hostname}:${port}`;
  const path = `/${rest.join('/')}`;
  const url = `https://${host}${path}${search}`;
  const parsed = URL.parse(url);
  if (parsed?.host !== host || parsed.hostname !== hostname)
    throw new InvalidTargetError('The link must be the target URL without https://, such as /api.example.com/v1/pools');

  return { host, hostname, path, search, url };
};

type ResponseHeaders = Readonly<Record<string, string | readonly string[] | undefined>>;

/**
 * What the target's 402 asks for: x402 options, from the `PAYMENT-REQUIRED` header, and MPP
 * challenges, from `WWW-Authenticate: Payment`. A target may offer both.
 */
export interface TargetChallenge {
  // 0 when the target offers no x402 option. Only version 2 options are paid.
  readonly x402Version: number;
  // As the target sent them: any JSON, checked only when an option is chosen
  readonly accepts: readonly unknown[];
  // The v2 resource, passed back when paying
  readonly resource: unknown;
  // Each kept whole, with its expiry and its body digest when it binds one: the credential echoes it
  readonly mpp: readonly Challenge.Challenge[];
}

// The header's version and options, when it decodes to an object with a numeric version and a list of options
const x402Of = (headers: ResponseHeaders): Pick<TargetChallenge, 'x402Version' | 'accepts' | 'resource'> | undefined => {
  const header = headers['payment-required'];
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== 'string' || value === '')
    return undefined;
  try {
    const required: unknown = decodePaymentRequiredHeader(value);
    if (isRecord(required) && typeof required['x402Version'] === 'number' && Array.isArray(required['accepts']))
      return { x402Version: required['x402Version'], accepts: required['accepts'], resource: required['resource'] };
  }
  catch {
    // Not base64 of a JSON object: no x402 challenge
  }

  return undefined;
};

const paymentBoundary = /\s*Payment\s/iy;

// A `WWW-Authenticate` value cut before each `Payment` challenge, at commas outside quoted strings
const paymentPieces = (value: string): string[] => {
  const pieces: string[] = [];
  let start = 0;
  let quoted = false;
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (quoted) {
      if (char === '\\')
        index++;
      else if (char === '"')
        quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char !== ',')
      continue;
    paymentBoundary.lastIndex = index + 1;
    if (paymentBoundary.test(value)) {
      pieces.push(value.slice(start, index));
      start = index + 1;
    }
  }
  pieces.push(value.slice(start));

  return pieces;
};

// Every `Payment` challenge of `WWW-Authenticate`, in one header or several. Each is parsed on its own:
// one that doesn't parse is skipped, and the others are kept.
const mppOf = (headers: ResponseHeaders): Challenge.Challenge[] => {
  const header = headers['www-authenticate'];
  const values = (Array.isArray(header) ? header : [header]).filter((value): value is string => typeof value === 'string' && value !== '');
  const challenges: Challenge.Challenge[] = [];
  for (const value of values) {
    for (const piece of paymentPieces(value)) {
      try {
        challenges.push(...Challenge.deserializeList(piece));
      }
      catch {
        // Another scheme, or a malformed challenge: nothing to pay with it
      }
    }
  }

  return challenges;
};

/**
 * Reads what a target's 402 asks for: the x402 `PAYMENT-REQUIRED` header and the MPP
 * `WWW-Authenticate: Payment` challenges. Undefined when it holds neither. A v1 JSON body isn't read:
 * a target that offers only that offers nothing the platform pays.
 */
export const parseTargetChallenge = (headers: ResponseHeaders): TargetChallenge | undefined => {
  const x402 = x402Of(headers);
  const mpp = mppOf(headers);
  if (!x402 && mpp.length === 0)
    return undefined;

  return { x402Version: x402?.x402Version ?? 0, accepts: x402?.accepts ?? [], resource: x402?.resource, mpp };
};

/** The option the platform pays, with its asset and its price in micro-USD. */
export type ChosenOption = {
  readonly asset: Asset;
  readonly atomicAmount: bigint;
  readonly price: MicroUsd;
} & ({
  readonly protocol: 'x402';
  readonly requirement: PaymentRequirements;
} | {
  readonly protocol: 'mpp';
  // The challenge as the target sent it, for the Signer
  readonly challenge: string;
  // When the challenge expires, if it says
  readonly expires: string | undefined;
  // The challenge binds the request body: its quote can't serve another body
  readonly bindsBody: boolean;
});

// The chains the Signer holds wallets on, by protocol: x402 on Base and Solana, MPP on Tempo.
export const routableChains = { x402: ['base', 'solana'], mpp: ['tempo'] } as const;

/**
 * Why the platform won't pay a Solana x402 option: the target's facilitator must pay the
 * transaction's fee, so the option names its `feePayer`, and that fee payer is never our own wallet.
 */
export type SolanaRefusal = 'no_fee_payer' | 'fee_payer_is_us';

// Without our Solana wallet in the config, no fee payer is taken for ours
const solanaRefusalOf = (extra: unknown, config: PlatformConfig): SolanaRefusal | undefined => {
  const feePayer = isRecord(extra) ? extra['feePayer'] : undefined;
  if (typeof feePayer !== 'string' || feePayer === '')
    return 'no_fee_payer';

  return feePayer === config.signer.wallets?.solana ? 'fee_payer_is_us' : undefined;
};

/** Why the platform pays none of the target's Solana x402 options it otherwise would, one reason each, for the log. */
export const solanaRefusals = (challenge: TargetChallenge, config: PlatformConfig): readonly SolanaRefusal[] =>
  challenge.x402Version !== 2 ? [] : challenge.accepts.flatMap(requirement => {
    if (!isRecord(requirement))
      return [];
    const { scheme, network, extra } = requirement;
    if (scheme !== 'exact' || typeof network !== 'string' || findNetwork(network)?.chain !== 'solana')
      return [];
    const refusal = solanaRefusalOf(extra, config);

    return refusal === undefined ? [] : [refusal];
  });

/** Why the platform won't pay an MPP challenge: the Tempo charge's check, or its expiry. */
export type MppRefusal = TempoChargeRefusal | 'expired';

const checkMpp = (challenge: Challenge.Challenge, config: PlatformConfig, now: Date): ReturnType<typeof checkTempoCharge> | { readonly charge?: undefined; readonly refusal: 'expired' } => {
  const checked = checkTempoCharge(challenge, config);
  if (checked.refusal !== undefined)
    return checked;
  const expires = challenge.expires === undefined ? Number.NaN : Date.parse(challenge.expires);

  return expires <= now.getTime() ? { refusal: 'expired' } : checked;
};

/** Why the platform pays each MPP challenge it doesn't, one reason each, for the log. */
export const mppRefusals = (challenge: TargetChallenge, config: PlatformConfig, now: Date): readonly MppRefusal[] =>
  challenge.mpp.flatMap(item => {
    const { refusal } = checkMpp(item, config, now);

    return refusal === undefined ? [] : [refusal];
  });

// Rounded up: the platform never quotes less than the target asks
const priceOf = (atomic: bigint, decimals: number): MicroUsd =>
  (decimals >= 6 ? (atomic + 10n ** BigInt(decimals - 6) - 1n) / 10n ** BigInt(decimals - 6) : atomic * 10n ** BigInt(6 - decimals)) as MicroUsd;

// A v2 option of any JSON shape, when the platform pays it
const x402Option = (requirement: unknown, config: PlatformConfig): ChosenOption | undefined => {
  if (!isRecord(requirement))
    return undefined;
  const { scheme, network: networkId, asset: address, amount, extra } = requirement;
  if (scheme !== 'exact' || typeof networkId !== 'string' || typeof address !== 'string' || typeof amount !== 'string' || !/^\d{1,30}$/.test(amount))
    return undefined;
  if (isRecord(extra) && extra['name'] === 'GatewayWalletBatched')
    return undefined;
  const network = findNetwork(networkId);
  if (!network || !(routableChains.x402 as readonly string[]).includes(network.chain))
    return undefined;
  if (network.chain === 'solana' && solanaRefusalOf(extra, config) !== undefined)
    return undefined;
  // Base58 addresses are case-sensitive, EVM addresses aren't
  const sameAddress = network.namespace === 'solana'
    ? (item: Asset) => item.address === address
    : (item: Asset) => item.address.toLowerCase() === address.toLowerCase();
  const asset = config.assets.find(item => item.network.id === network.id && sameAddress(item));
  const atomicAmount = BigInt(amount);
  if (!asset || atomicAmount <= 0n)
    return undefined;

  return { protocol: 'x402', requirement: requirement as PaymentRequirements, asset, atomicAmount, price: priceOf(atomicAmount, asset.decimals) };
};

// On a tie: x402 on Base, then x402 on Solana, then MPP. Nothing moves until the target settles an x402
// payment, and its transaction costs us no fee.
const tieOrder = (option: ChosenOption): number => option.protocol === 'mpp' ? 2 : option.asset.network.chain === 'solana' ? 1 : 0;

/**
 * Picks the cheapest option the platform pays. On a tie, x402 on Base, then on Solana, then MPP.
 * - x402: a version 2 challenge's `exact` option with a decimal string `amount`, on Base or Solana, in
 *   an asset of the registry pegged to USD, and not a Circle Gateway nanopayment. On Solana, the option
 *   names a fee payer that isn't our wallet;
 * - MPP: a Tempo charge on `mpp.network` in pull mode, without splits, in an asset of the registry on
 *   that network, and not expired.
 */
export const chooseOption = (challenge: TargetChallenge, config: PlatformConfig, now: Date): ChosenOption | undefined => {
  const candidates: ChosenOption[] = [];
  if (challenge.x402Version === 2) {
    for (const requirement of challenge.accepts) {
      const option = x402Option(requirement, config);
      if (option)
        candidates.push(option);
    }
  }
  for (const item of challenge.mpp) {
    const { charge } = checkMpp(item, config, now);
    if (!charge || !(routableChains.mpp as readonly string[]).includes(charge.asset.network.chain))
      continue;
    candidates.push({
      protocol: 'mpp', challenge: Challenge.serialize(item), expires: item.expires, bindsBody: item.digest !== undefined,
      asset: charge.asset, atomicAmount: charge.atomicAmount, price: charge.price,
    });
  }

  return candidates.sort((left, right) => left.price < right.price ? -1 : left.price > right.price ? 1 : tieOrder(left) - tieOrder(right))[0];
};

/**
 * What the target's answer says it settled of the payment we made with `protocol`, and its transaction.
 * For x402, its `PAYMENT-RESPONSE` (or v1 `X-PAYMENT-RESPONSE`) with `success: true`; for MPP, a
 * successful `Payment-Receipt`. The other protocol's headers aren't read. Undefined when it says
 * nothing was settled.
 */
export const targetReceipt = (
  headers: ResponseHeaders,
  protocol: 'x402' | 'mpp',
): { readonly receipt: string; readonly transaction: string | undefined } | undefined => {
  const first = (name: string): string | undefined => {
    const header = headers[name];
    const value = Array.isArray(header) ? header[0] : header;

    return typeof value === 'string' && value !== '' ? value : undefined;
  };
  if (protocol === 'x402') {
    const x402 = first('payment-response') ?? first('x-payment-response');
    if (x402 === undefined)
      return undefined;
    try {
      const decoded: unknown = decodePaymentResponseHeader(x402);
      if (isRecord(decoded) && decoded['success'] === true) {
        const transaction = decoded['transaction'];

        return { receipt: x402, transaction: typeof transaction === 'string' && transaction !== '' ? transaction : undefined };
      }
    }
    catch {
      // Not base64 of a JSON object: not a receipt
    }

    return undefined;
  }
  const mpp = first('payment-receipt');
  if (mpp === undefined)
    return undefined;
  try {
    const decoded = Receipt.deserialize(mpp);
    if (decoded.status === 'success')
      return { receipt: mpp, transaction: decoded.reference };
  }
  catch {
    // Not a receipt
  }

  return undefined;
};

/**
 * The quote is the target's price plus the routing fee, rounded down. The fee is a whole number of
 * basis points from 0 to 10000.
 */
export const routingQuote = (price: MicroUsd, feeBps: number): { readonly quote: MicroUsd; readonly fee: MicroUsd } => {
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10_000)
    throw new RangeError('The routing fee must be a whole number of basis points from 0 to 10000');
  const fee = (price * BigInt(feeBps)) / 10_000n;

  return { quote: (price + fee) as MicroUsd, fee: fee as MicroUsd };
};
