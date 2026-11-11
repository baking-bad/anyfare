import {
  decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader,
} from '@x402/core/http';
import type { PaymentRequirements } from '@x402/core/types';
import { Challenge, Receipt, Store } from 'mppx';
import { Mppx, tempo } from 'mppx/server';
import { createClient, http as viemHttp } from 'viem';
import { tempoModerato } from 'viem/chains';

import { findAsset, type PlatformConfig } from '@anyfare/core';

import type { ServerResponse } from 'node:http';

import { startFakeUpstream, type FakeUpstream, type RecordedRequest } from '../upstream.js';
import { fakeTransactionHash } from './seedData.js';

// A fake paid API for the local stack: one HTTPS server with an endpoint for each case a routed call meets.
// It checks nothing on chain: it takes any well-formed x402 payment, and an MPP credential through the
// fake Tempo node.

export interface FakePaidApiOptions {
  readonly config: PlatformConfig;
  // The name the endpoints answer to: the certificate covers it
  readonly host: string;
  readonly port: number;
  // The fake Tempo node its MPP endpoint settles on
  readonly tempoRpcUrl: string;
}

export interface FakePaidApi {
  readonly host: string;
  readonly port: number;
  // The certificate to trust
  readonly ca: string;
  // Each endpoint, with what it answers
  readonly endpoints: readonly { readonly path: string; readonly what: string }[];
  readonly upstream: FakeUpstream;
  close(): Promise<void>;
}

// Made-up recipients: none holds anything
const baseRecipient = `0x${'3'.repeat(40)}`;
const nearRecipient = 'api.merchant.testnet';
const tempoRecipient = `0x${'5'.repeat(40)}`;
const secretKey = 'the-fake-api-s-own-mpp-secret-key-0000';
// The price of every paid endpoint: $0.001
const price = '0.001';

export const fakeApiEndpoints = [
  { path: '/base', what: 'x402 on Base, $0.001' },
  { path: '/near', what: 'x402 on NEAR, $0.001' },
  { path: '/tempo', what: 'MPP on Tempo, $0.001' },
  { path: '/free', what: 'no payment: answers 200' },
  { path: '/unpayable', what: 'x402 on a network we do not pay' },
  { path: '/post-only', what: 'x402 on Base, $0.001, asked only of a POST: a GET answers 405' },
] as const;

const json = (response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
  response.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body));
};

/** Starts the fake paid API. */
export const startFakePaidApi = async ({ config, host, port, tempoRpcUrl }: FakePaidApiOptions): Promise<FakePaidApi> => {
  const upstream = await startFakeUpstream({ hosts: [host], port });
  const baseAsset = findAsset(config, 'base-usdc')!;
  const nearAsset = findAsset(config, 'near-usdc')!;
  const tempoAsset = findAsset(config, 'tempo-pathusd')!;
  let transactions = 0;

  const mpp = Mppx.create({
    methods: [tempo.charge({
      currencies: [tempoAsset.address as `0x${string}`], decimals: tempoAsset.decimals, recipient: tempoRecipient as `0x${string}`, chainId: tempoModerato.id,
      store: Store.memory(),
      getClient: () => createClient({ chain: tempoModerato, transport: viemHttp(tempoRpcUrl, { retryCount: 0 }) }),
      supportedModes: ['pull'], sponsorBudget: false, waitForConfirmation: true,
    })],
    secretKey,
    realm: host,
  });
  const charges = mpp.challenge as unknown as { tempo: { charge: (options: Record<string, unknown>) => Promise<Challenge.Challenge> } };
  const mppRequest = {
    amount: price, currency: tempoAsset.address, decimals: tempoAsset.decimals, recipient: tempoRecipient, chainId: tempoModerato.id, supportedModes: ['pull'],
  };

  const option = (path: string): PaymentRequirements => {
    if (path === '/near') {
      return {
        scheme: 'exact', network: nearAsset.network.id, amount: '1000', asset: nearAsset.address, payTo: nearRecipient, maxTimeoutSeconds: 300, extra: {},
      } as PaymentRequirements;
    }
    if (path === '/unpayable') {
      // Ethereum mainnet: no deployment of ours pays there
      return {
        scheme: 'exact', network: 'eip155:1', amount: '1000', asset: `0x${'a'.repeat(40)}`, payTo: baseRecipient, maxTimeoutSeconds: 60, extra: { name: 'USDC', version: '2' },
      } as PaymentRequirements;
    }

    return {
      scheme: 'exact', network: baseAsset.network.id, amount: '1000', asset: baseAsset.address, payTo: baseRecipient, maxTimeoutSeconds: 60, extra: { name: 'USDC', version: '2' },
    } as PaymentRequirements;
  };

  upstream.handle(async (request: RecordedRequest, response) => {
    const path = request.path.split('?')[0]!;
    const url = `https://${host}:${port}${path}`;
    // The opt-out check: this host takes routing
    if (path === '/.well-known/anyfare.json') {
      json(response, 404, { error: 'not found' });
      return;
    }
    if (path === '/free') {
      json(response, 200, { free: true });
      return;
    }
    if (path === '/tempo') {
      const authorization = request.headers['authorization'];
      const scope = url;
      if (typeof authorization !== 'string') {
        json(response, 402, {}, { 'www-authenticate': Challenge.serialize(await charges.tempo.charge({ ...mppRequest, description: 'Prices', scope })) });
        return;
      }
      try {
        const receipt = Receipt.serialize(await mpp.broadcastCredential(authorization, { request: mppRequest, scope }));
        json(response, 200, { path, paidWith: 'mpp' }, { 'payment-receipt': receipt });
      }
      catch {
        json(response, 402, {}, { 'www-authenticate': Challenge.serialize(await charges.tempo.charge({ ...mppRequest, description: 'Prices', scope })) });
      }

      return;
    }
    if (path === '/post-only' && request.method !== 'POST') {
      json(response, 405, { error: 'method not allowed' }, { allow: 'POST' });
      return;
    }
    if (path !== '/base' && path !== '/near' && path !== '/unpayable' && path !== '/post-only') {
      json(response, 404, { error: 'not found' });
      return;
    }

    const signature = request.headers['payment-signature'];
    if (typeof signature !== 'string' || path === '/unpayable') {
      const required = encodePaymentRequiredHeader({
        x402Version: 2, error: 'Payment required', resource: { url, description: 'A price, for the local stack', mimeType: 'application/json' }, accepts: [option(path)],
      } as never);
      json(response, 402, {}, { 'payment-required': required });
      return;
    }
    const payment = decodePaymentSignatureHeader(signature) as unknown as { payload?: { authorization?: { from?: string } } };
    const requirement = option(path);
    transactions += 1;
    const settled = encodePaymentResponseHeader({
      success: true,
      transaction: fakeTransactionHash(path === '/near' ? 'near' : 'base', transactions),
      network: requirement.network,
      payer: payment.payload?.authorization?.from ?? 'unknown',
    } as never);
    json(response, 200, { path, paidWith: 'x402', price }, { 'payment-response': settled });
  });

  return {
    host,
    port: upstream.port,
    ca: upstream.ca,
    endpoints: fakeApiEndpoints,
    upstream,
    close: () => upstream.close(),
  };
};
