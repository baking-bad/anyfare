import { formatUsd } from '@anyfare/common';

import type { PlatformConfig } from './config.js';

/** What every app's startup line says about the platform. Names, networks, and URLs only. */
export interface PlatformSummary {
  readonly environment: PlatformConfig['environment'];
  readonly urls: PlatformConfig['urls'];
  readonly assets: readonly { readonly name: string; readonly network: string }[];
  readonly rails: {
    readonly credits: true;
    // Each enabled facilitator and the networks it serves
    readonly x402: readonly { readonly facilitator: string; readonly networks: readonly string[] }[];
    // False when MPP is disabled or has no recipient
    readonly mpp: { readonly network: string } | false;
  };
  readonly fees: { readonly routingFeeBps: number };
  // What each new account gets, as a USD string, and whether the gift is on
  readonly freeCredits: { readonly enabled: boolean; readonly amount: string };
}

/**
 * The platform as the startup line logs it: the environment, the public URLs, the assets, the enabled
 * rails with their networks and facilitators, the fees, and the sign-up gift. No secret, key, or
 * address: config holds secrets by name only.
 */
export const platformSummary = (config: PlatformConfig): PlatformSummary => ({
  environment: config.environment,
  urls: config.urls,
  assets: config.assets.map(asset => ({ name: asset.name, network: asset.network.id })),
  rails: {
    credits: true,
    x402: config.facilitators.filter(facilitator => facilitator.enabled).map(facilitator => ({ facilitator: facilitator.name, networks: facilitator.networks })),
    mpp: config.mpp.enabled && config.mpp.recipient !== undefined ? { network: config.mpp.network.id } : false,
  },
  fees: { routingFeeBps: config.routingFeeBps },
  freeCredits: { enabled: config.freeCredits.enabled, amount: formatUsd(config.freeCredits.amount) },
});
