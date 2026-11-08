import type { LoggerLevel } from './document.js';

// Documented defaults for optional platform config fields, kept in one place. Values without a
// documented default, such as rate limits, are required in the file instead.
export const platformDefaults = {
  loggerLevel: 'info' satisfies LoggerLevel,
  // A new payment key gets $5 a day unless the deployment says otherwise
  paymentKeyDailyBudget: '5',
  // An asset is offered for every price unless the deployment sets a minimum
  assetMinPrice: '0',
  timeouts: { connectMs: 5_000, requestMs: 30_000, settleMs: 30_000 },
} as const;
