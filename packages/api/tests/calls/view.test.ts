import { beforeAll, describe, expect, it } from 'vitest';

import { loadPlatformConfig, type PlatformConfig } from '@anyfare/core';
import type { CallRecord } from '@anyfare/db';

import { createCallViews, explorerUrl } from '../../src/calls/view.js';

let staging: PlatformConfig;
let production: PlatformConfig;

const at = (time: string): Date => new Date(`2026-11-12T10:00:${time}Z`);
const evmHash = `0x${'c4'.repeat(32)}`;

const record = (changes: Partial<CallRecord> = {}): CallRecord => ({
  id: 'pay_view_1',
  rail: 'x402',
  status: 'settled',
  targetHost: 'pro-api.example.com',
  targetPath: '/v3/quotes/latest',
  network: 'eip155:8453',
  asset: 'base-usdc',
  amount: 10_000n,
  fee: 0n,
  upstreamStatus: 200,
  upstreamLatencyMs: 339,
  transactionHash: evmHash,
  createdAt: at('00.200'),
  updatedAt: at('01.016'),
  details: { method: 'GET', payer: '0x7777777777777777777777777777777777777777', arrivedAt: at('00.100') },
  leg: {
    protocol: 'x402', network: 'eip155:8453', asset: 'base-usdc', amount: 10_000n, payTo: '0x3333333333333333333333333333333333333333', status: 'settled',
    transactionHash: evmHash, createdAt: at('00.300'), updatedAt: at('01.000'),
  },
  ...changes,
});

beforeAll(async () => {
  [staging, production] = await Promise.all([
    loadPlatformConfig({ env: { CONFIG_PATH: 'config/example.yaml' } }),
    loadPlatformConfig({ env: { CONFIG_PATH: 'config/production.yaml' } }),
  ]);
});

describe('how a call was paid', () => {
  it('names each way to pay from the rail and the config\'s networks, and any other network by its ID', () => {
    const live = createCallViews(production);
    const test = createCallViews(staging);

    expect(live.paidWithOf('credits', undefined)).toBe('credits');
    expect(live.paidWithOf('x402', 'eip155:8453')).toBe('base');
    expect(live.paidWithOf('x402', 'near:mainnet')).toBe('near');
    expect(live.paidWithOf('x402', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp')).toBe('solana');
    expect(live.paidWithOf('mpp', 'eip155:4217')).toBe('tempo');
    expect(test.paidWithOf('x402', 'eip155:84532')).toBe('base');
    expect(test.paidWithOf('mpp', 'eip155:42431')).toBe('tempo');
    // A network this deployment doesn't run, and a rail its network isn't paid on
    expect(live.paidWithOf('x402', 'eip155:84532')).toBe('eip155:84532');
    expect(live.paidWithOf('x402', 'eip155:4217')).toBe('eip155:4217');
    expect(live.paidWithOf('mpp', 'eip155:8453')).toBe('eip155:8453');
  });

  it('filters a way to pay by the rail on this deployment\'s network, and matches nothing without one', () => {
    const test = createCallViews(staging);

    expect(test.filterOf('credits')).toEqual({ rail: 'credits' });
    expect(test.filterOf('near')).toEqual({ rail: 'x402', network: 'near:testnet' });
    expect(test.filterOf('tempo')).toEqual({ rail: 'mpp', network: 'eip155:42431' });
    expect(createCallViews({ ...staging, assets: staging.assets.filter(asset => asset.network.chain !== 'solana') }).filterOf('solana')).toBeUndefined();
  });
});

describe('explorer links', () => {
  it('links a transaction of the right shape on a network with a known explorer, and nothing else', () => {
    expect(explorerUrl('eip155:8453', evmHash)).toBe(`https://basescan.org/tx/${evmHash}`);
    expect(explorerUrl('eip155:4217', evmHash)).toBe(`https://explore.tempo.xyz/tx/${evmHash}`);
    expect(explorerUrl('eip155:42431', evmHash)).toBe(`https://explore.testnet.tempo.xyz/tx/${evmHash}`);
    expect(explorerUrl('near:mainnet', 'GZ1hT9cqVf3mWkPa8nRbXy4LdE6sJu2HtNo5Ki7Qw3Zm')).toBe('https://nearblocks.io/txns/GZ1hT9cqVf3mWkPa8nRbXy4LdE6sJu2HtNo5Ki7Qw3Zm');
    const signature = '5'.repeat(88);
    expect(explorerUrl('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', signature)).toBe(`https://explorer.solana.com/tx/${signature}`);
    expect(explorerUrl('solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1', signature)).toBe(`https://explorer.solana.com/tx/${signature}?cluster=devnet`);
    // Explorers not checked, a hash of another shape, and none
    expect(explorerUrl('eip155:84532', evmHash)).toBeNull();
    expect(explorerUrl('near:testnet', 'GZ1hT9cqVf3mWkPa8nRbXy4LdE6sJu2HtNo5Ki7Qw3Zm')).toBeNull();
    expect(explorerUrl('eip155:8453', '0x12/../../x')).toBeNull();
    expect(explorerUrl('eip155:8453', undefined)).toBeNull();
    expect(explorerUrl(undefined, evmHash)).toBeNull();
  });
});

describe('the call and its receipt', () => {
  it('shows a chain payment\'s call with its payer, the API\'s status and time', () => {
    expect(createCallViews(production).callOf(record())).toEqual({
      id: 'pay_view_1', at: '2026-11-12T10:00:00.200Z', service: 'pro-api.example.com', path: '/v3/quotes/latest', method: 'GET', paidWith: 'base',
      apiPaidWith: 'base', payer: '0x7777777777777777777777777777777777777777', amount: '0.01', status: 'paid', apiStatus: 200, ms: 339,
    });
  });

  it('shows a call from before details were kept, one the API never answered, and one not charged', () => {
    const views = createCallViews(production);

    expect(views.callOf(record({ details: undefined, leg: undefined, status: 'cancelled', upstreamStatus: undefined, upstreamLatencyMs: 0 }))).toMatchObject({
      method: null, payer: null, apiPaidWith: null, status: 'free', apiStatus: null, ms: null,
    });
  });

  it('gives a receipt the kept times only: the arrival, the payment, the signing, the answer, and the settlement', () => {
    const receipt = createCallViews(production).receiptOf(record());

    expect(receipt).toEqual({
      id: 'pay_view_1', at: '2026-11-12T10:00:00.200Z', status: 'paid', apiStatus: 200, service: 'pro-api.example.com', method: 'GET', path: '/v3/quotes/latest',
      buyer: {
        paidWith: 'base', network: 'eip155:8453', asset: 'USDC', amount: '0.01', payer: '0x7777777777777777777777777777777777777777', transaction: evmHash,
        explorerUrl: `https://basescan.org/tx/${evmHash}`, settledAt: '2026-11-12T10:00:01.016Z',
      },
      api: {
        paidWith: 'base', network: 'eip155:8453', asset: 'USDC', amount: '0.01', payTo: '0x3333333333333333333333333333333333333333', transaction: evmHash,
        explorerUrl: `https://basescan.org/tx/${evmHash}`, status: 'settled',
      },
      apiPrice: '0.01',
      fee: '0',
      ms: { api: 339, total: 916 },
      steps: [
        { step: 'received', at: '2026-11-12T10:00:00.100Z' },
        { step: 'authorized', at: '2026-11-12T10:00:00.200Z' },
        { step: 'api_signed', at: '2026-11-12T10:00:00.300Z' },
        { step: 'api_answered', at: '2026-11-12T10:00:00.639Z' },
        { step: 'settled', at: '2026-11-12T10:00:01.016Z' },
      ],
    });
  });

  it('gives a Credits receipt no network, payer, transaction or link, and Credits as the asset', () => {
    const receipt = createCallViews(production).receiptOf(record({
      rail: 'credits', status: 'captured', network: undefined, asset: undefined, transactionHash: undefined,
      details: { method: 'POST', payer: 'acc_never_shown', arrivedAt: at('00.100') },
    }));

    expect(receipt.buyer).toEqual({
      paidWith: 'credits', network: null, asset: 'Credits', amount: '0.01', payer: null, transaction: null, explorerUrl: null, settledAt: '2026-11-12T10:00:01.016Z',
    });
    expect(JSON.stringify(receipt)).not.toContain('acc_never_shown');
  });

  it('ends a free call\'s steps with its release, and a settling one\'s without a final step or total', () => {
    const views = createCallViews(production);
    const released = views.receiptOf(record({ status: 'failed', fee: undefined, upstreamStatus: 502 }));
    const settling = views.receiptOf(record({ status: 'settling', fee: undefined }));

    expect(released.steps.at(-1)).toEqual({ step: 'released', at: '2026-11-12T10:00:01.016Z' });
    expect([released.status, released.fee, released.buyer.settledAt]).toEqual(['free', '0', null]);
    expect(settling.steps.map(step => step.step)).toEqual(['received', 'authorized', 'api_signed', 'api_answered']);
    expect([settling.status, settling.fee, settling.ms.total, settling.buyer.settledAt]).toEqual(['paid', null, null, null]);
  });

  it('names the API leg\'s token from its asset, and leaves out the API when we never signed', () => {
    const views = createCallViews(production);
    const tempo = views.receiptOf(record({
      rail: 'mpp', network: 'eip155:4217', asset: 'tempo-usdce',
      leg: { ...record().leg!, protocol: 'mpp', network: 'eip155:4217', asset: 'tempo-usdce' },
    }));
    const unsigned = views.receiptOf(record({ leg: undefined, status: 'cancelled', fee: undefined, upstreamStatus: undefined }));

    expect([tempo.buyer.paidWith, tempo.buyer.asset, tempo.api?.paidWith, tempo.api?.asset]).toEqual(['tempo', 'USDC.e', 'tempo', 'USDC.e']);
    expect([unsigned.api, unsigned.apiPrice, unsigned.steps.map(step => step.step)]).toEqual([null, null, ['received', 'authorized', 'released']]);
  });
});
