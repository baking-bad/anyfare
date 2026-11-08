import type { PlatformConfig } from './config.js';

/** What every app's startup line says about the platform. Names, networks, and URLs only. */
export interface PlatformSummary {
  readonly environment: PlatformConfig['environment'];
  readonly urls: PlatformConfig['urls'];
  readonly assets: readonly { readonly name: string; readonly network: string }[];
}

/** The platform as the startup line logs it. No address: those stay out of logs. */
export const platformSummary = (config: PlatformConfig): PlatformSummary => ({
  environment: config.environment,
  urls: config.urls,
  assets: config.assets.map(asset => ({ name: asset.name, network: asset.network.id })),
});
