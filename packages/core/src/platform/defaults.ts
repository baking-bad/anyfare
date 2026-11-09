import type { LoggerLevel } from './document.js';

// Documented defaults for optional platform config fields, kept in one place. Values without a
// documented default, such as the routing fee and rate limits, are required in the file instead.
export const platformDefaults = {
  loggerLevel: 'info' satisfies LoggerLevel,
  // A new payment key gets $5 a day unless the deployment says otherwise
  paymentKeyDailyBudget: '5',
  // An asset is offered for every price unless the deployment sets a minimum
  assetMinPrice: '0',
  timeouts: { connectMs: 5_000, requestMs: 30_000, settleMs: 30_000 },
  // Request body 1 MiB, buffered response 10 MiB
  sizeLimits: { requestBodyBytes: 1024 * 1024, bufferedResponseBytes: 10 * 1024 * 1024 },
  // $1 per call, $100 a day per network. No hourly limit unless set.
  signer: { maxPerCall: '1', maxPerNetworkPerDay: '100' },
  // Public documents, per client IP
  documentsRateLimit: { requests: 120, windowSeconds: 60 },
  // Probes of routed targets, per client IP: ten a second
  probeIpRateLimit: { requests: 600, windowSeconds: 60 },
  // Free Credits on sign-up: off unless the deployment turns them on, then $0.10 for each of the first
  // three new accounts a day from one client IP. No daily cap unless set.
  freeCredits: { enabled: false, amount: '0.1', perIp: { requests: 3, windowSeconds: 86_400 } },
  // Top-ups: off unless the deployment turns them on. A deposit address takes transfers for a day when
  // the token is a stablecoin, two hours otherwise, since another token's price moves.
  topups: {
    enabled: false,
    url: 'https://1click.chaindefuser.com',
    slippageBps: 100,
    deadlineMinutes: { stablecoin: 1_440, other: 120 },
    stablecoins: ['USDC', 'USDT', 'USDT0', 'DAI', 'USD1'],
    timeoutMs: 15_000,
  },
} as const;
