import { formatUsd } from '@anyfare/common';
import type { Chain, PlatformConfig, RailName } from '@anyfare/core';
import { finalCallStatuses, paidCallStatuses, type CallFilter, type CallLeg, type CallRecord } from '@anyfare/db';

// How a buyer paid, or how we paid the API. A network that is none of these is given as its network ID.
export const paidWithValues = ['near', 'base', 'solana', 'tempo', 'credits'] as const;
export type PaidWith = typeof paidWithValues[number];

export type CallStatus = 'paid' | 'free';

/** A finished call, as the list, the stream and the receipt show it. Never names a Credits buyer. */
export interface CallView {
  readonly id: string;
  readonly at: string;
  readonly service: string;
  // The path only, never the query string
  readonly path: string;
  // Null for a call recorded before the method was kept
  readonly method: string | null;
  readonly paidWith: string;
  // Null when we never signed for the API
  readonly apiPaidWith: string | null;
  // A chain payment's payer, when known. Always null for Credits.
  readonly payer: string | null;
  // What the buyer paid, or would have paid
  readonly amount: string;
  readonly status: CallStatus;
  // The API's HTTP status
  readonly apiStatus: number | null;
  // The API's time
  readonly ms: number | null;
}

export interface ReceiptStep {
  readonly step: 'received' | 'authorized' | 'api_signed' | 'api_answered' | 'settled' | 'released';
  readonly at: string;
}

export interface ReceiptView {
  readonly id: string;
  readonly at: string;
  readonly status: CallStatus;
  readonly apiStatus: number | null;
  readonly service: string;
  readonly method: string | null;
  readonly path: string;
  readonly buyer: {
    readonly paidWith: string;
    readonly network: string | null;
    readonly asset: string | null;
    readonly amount: string;
    readonly payer: string | null;
    readonly transaction: string | null;
    readonly explorerUrl: string | null;
    readonly settledAt: string | null;
  };
  readonly api: {
    readonly paidWith: string;
    readonly network: string;
    readonly asset: string;
    readonly amount: string;
    readonly payTo: string;
    readonly transaction: string | null;
    readonly explorerUrl: string | null;
    readonly status: CallLeg['status'];
  } | null;
  // What the API asked, null when we never signed for it
  readonly apiPrice: string | null;
  // What we kept: null while a settling payment's fee isn't booked yet
  readonly fee: string | null;
  readonly ms: { readonly api: number | null; readonly total: number | null };
  readonly steps: readonly ReceiptStep[];
}

// x402 is paid on these chains, MPP on Tempo
const x402Chains: ReadonlySet<Chain> = new Set(['near', 'base', 'solana']);

const evmHash = /^0x[0-9a-fA-F]{64}$/;
// NEAR's transaction hash and Solana's signature are base58: 32 and 64 bytes
const nearHash = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;
const solanaSignature = /^[1-9A-HJ-NP-Za-km-z]{86,88}$/;

/**
 * Where a transaction is shown, by network: only explorers checked to exist, with their transaction
 * page's URL. A network without one, or a hash of another shape, gets no link.
 */
const explorers: Readonly<Record<string, { readonly hash: RegExp; readonly url: (hash: string) => string }>> = {
  'eip155:8453': { hash: evmHash, url: hash => `https://basescan.org/tx/${hash}` },
  'near:mainnet': { hash: nearHash, url: hash => `https://nearblocks.io/txns/${hash}` },
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': { hash: solanaSignature, url: hash => `https://explorer.solana.com/tx/${hash}` },
  'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1': { hash: solanaSignature, url: hash => `https://explorer.solana.com/tx/${hash}?cluster=devnet` },
  'eip155:4217': { hash: evmHash, url: hash => `https://explore.tempo.xyz/tx/${hash}` },
  'eip155:42431': { hash: evmHash, url: hash => `https://explore.testnet.tempo.xyz/tx/${hash}` },
};

export const explorerUrl = (network: string | undefined, hash: string | undefined): string | null => {
  const explorer = network === undefined ? undefined : explorers[network];

  return explorer !== undefined && hash !== undefined && explorer.hash.test(hash) ? explorer.url(hash) : null;
};

// The token a registry asset name ends in, such as base-usdc: USDC
const tokenNames: Readonly<Record<string, string>> = { usdc: 'USDC', usdce: 'USDC.e', pathusd: 'pathUSD' };
const tokenOf = (asset: string): string => {
  const token = asset.slice(asset.indexOf('-') + 1);

  return tokenNames[token] ?? token.toUpperCase();
};

const isPaid = (status: CallRecord['status']): boolean => (paidCallStatuses as readonly string[]).includes(status);
const isFinal = (status: CallRecord['status']): boolean => (finalCallStatuses as readonly string[]).includes(status);
const iso = (time: Date): string => time.toISOString();

/** The public views of calls, with how each was paid from the platform config's networks. */
export const createCallViews = (config: PlatformConfig) => {
  // Every network the platform config names, with its chain
  const chains = new Map<string, Chain>([
    ...config.assets.map(asset => [asset.network.id, asset.network.chain] as const),
    [config.mpp.network.id, config.mpp.network.chain],
  ]);

  const paidWithOf = (rail: RailName, network: string | undefined): string => {
    if (rail === 'credits')
      return 'credits';
    if (network === undefined)
      return rail;
    const chain = chains.get(network);
    if (rail === 'mpp' && chain === 'tempo')
      return 'tempo';
    if (rail === 'x402' && chain !== undefined && x402Chains.has(chain))
      return chain;

    return network;
  };

  /**
   * The list's filter for a way to pay, or undefined when the platform config has no network for it,
   * so nothing matches. A deployment runs one network per chain: mainnets or testnets.
   */
  const filterOf = (paidWith: PaidWith): CallFilter['paidWith'] | undefined => {
    if (paidWith === 'credits')
      return { rail: 'credits' };
    const network = [...chains].find(([, chain]) => chain === paidWith)?.[0];

    return network === undefined ? undefined : { rail: paidWith === 'tempo' ? 'mpp' : 'x402', network };
  };

  const callOf = (record: CallRecord): CallView => ({
    id: record.id,
    at: iso(record.createdAt),
    service: record.targetHost,
    path: record.targetPath,
    method: record.details?.method ?? null,
    paidWith: paidWithOf(record.rail, record.network),
    apiPaidWith: record.leg ? paidWithOf(record.leg.protocol, record.leg.network) : null,
    payer: record.rail === 'credits' ? null : record.details?.payer ?? null,
    amount: formatUsd(record.amount),
    status: isPaid(record.status) ? 'paid' : 'free',
    apiStatus: record.upstreamStatus ?? null,
    // A call the API never answered has no API time
    ms: record.upstreamStatus === undefined ? null : record.upstreamLatencyMs ?? null,
  });

  const receiptOf = (record: CallRecord): ReceiptView => {
    const call = callOf(record);
    const { leg, details } = record;
    const credits = record.rail === 'credits';
    const final = isFinal(record.status);
    const charged = final && call.status === 'paid';
    // When the API answered, derived: we sent our payment right after signing it, and the API took
    // `ms`. The leg's last update is no answer time: the capture or settlement that charges the buyer
    // moves it again, and so does a loss booked for it.
    const answeredAt = leg && call.ms !== null ? new Date(leg.createdAt.getTime() + call.ms) : undefined;
    const steps: ReceiptStep[] = [
      ...details ? [{ step: 'received' as const, at: iso(details.arrivedAt) }] : [],
      { step: 'authorized', at: iso(record.createdAt) },
      ...leg ? [{ step: 'api_signed' as const, at: iso(leg.createdAt) }] : [],
      ...answeredAt ? [{ step: 'api_answered' as const, at: iso(answeredAt) }] : [],
      // A settling payment has no final time yet
      ...final ? [{ step: charged ? 'settled' as const : 'released' as const, at: iso(record.updatedAt) }] : [],
    ];
    const fee = record.fee ?? (call.status === 'free' ? 0n : undefined);
    const totalMs = details && final ? record.updatedAt.getTime() - details.arrivedAt.getTime() : undefined;

    return {
      id: call.id,
      at: call.at,
      status: call.status,
      apiStatus: call.apiStatus,
      service: call.service,
      method: call.method,
      path: call.path,
      buyer: {
        paidWith: call.paidWith,
        network: credits ? null : record.network ?? null,
        asset: credits ? 'Credits' : record.asset === undefined ? null : tokenOf(record.asset),
        amount: call.amount,
        payer: call.payer,
        transaction: credits ? null : record.transactionHash ?? null,
        explorerUrl: credits ? null : explorerUrl(record.network, record.transactionHash),
        settledAt: charged ? iso(record.updatedAt) : null,
      },
      api: leg
        ? {
          paidWith: call.apiPaidWith ?? leg.protocol,
          network: leg.network,
          asset: tokenOf(leg.asset),
          amount: formatUsd(leg.amount),
          payTo: leg.payTo,
          transaction: leg.transactionHash ?? null,
          explorerUrl: explorerUrl(leg.network, leg.transactionHash),
          status: leg.status,
        }
        : null,
      apiPrice: leg ? formatUsd(leg.amount) : null,
      fee: fee === undefined ? null : formatUsd(fee),
      ms: {
        api: call.ms,
        // From the arrival to the payment's final update. Clocks of two hosts that disagree give none.
        total: totalMs !== undefined && totalMs >= 0 ? totalMs : null,
      },
      steps,
    };
  };

  return { paidWithOf, filterOf, callOf, receiptOf };
};

export type CallViews = ReturnType<typeof createCallViews>;
