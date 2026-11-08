import type { MicroUsd } from '@anyfare/common';

import type { PlatformConfig } from './platform/config.js';

export type PaymentMethod = 'credits' | 'x402' | 'mpp';

/**
 * How a buyer may pay for a call at this price: credits always; x402 when an asset we receive in
 * sits on a network of an enabled facilitator (Tempo goes through MPP) and accepts the price; MPP
 * when it is enabled with a recipient and an asset on its network accepts the price.
 */
export const paymentMethodsFor = (price: MicroUsd, config: PlatformConfig): readonly PaymentMethod[] => {
  const methods: PaymentMethod[] = ['credits'];
  const facilitated = new Set(config.facilitators.filter(facilitator => facilitator.enabled).flatMap(facilitator => facilitator.networks));
  if (config.assets.some(asset => asset.payTo !== undefined && asset.network.chain !== 'tempo' && facilitated.has(asset.network.id) && asset.minPrice <= price))
    methods.push('x402');
  if (config.mpp.enabled && config.mpp.recipient !== undefined
    && config.assets.some(asset => asset.network.id === config.mpp.network.id && asset.minPrice <= price))
    methods.push('mpp');

  return methods;
};
