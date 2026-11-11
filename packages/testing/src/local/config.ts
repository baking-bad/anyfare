import { loadPlatformConfig, type PlatformConfig } from '@anyfare/core';

// The platform config of the local tools: config/example.yaml with local overrides, so the seed and the
// stack agree on the networks, the fee, and the prefixes of keys.

const generous = { requests: 100_000, windowSeconds: 60 };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const merge = (base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> => {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = merged[key];
    merged[key] = isRecord(current) && isRecord(value) ? merge(current, value) : value;
  }

  return merged;
};

/** What the local tools change in the example config. A 10% routing fee, so a quote shows a fee. */
export const localConfigOverride: Readonly<Record<string, unknown>> = {
  routingFeeBps: 1000,
  rateLimits: { signup: generous, paymentKey: generous, unpaidIp: generous, documents: generous, probeIp: generous, topups: generous, publicReads: generous },
  // A new account gets Credits, so it can pay at once
  freeCredits: { enabled: true, amount: '0.5', perIp: { requests: 1_000, windowSeconds: 3_600 } },
  topups: { enabled: true },
  signer: { maxPerCall: '0.5', maxPerNetworkPerDay: '1000' },
  // Counts the public numbers a little more often than the default, so a call made by hand shows up soon
  stats: { intervalSeconds: 30, allIntervalSeconds: 120 },
};

export interface LocalConfigOptions {
  // Default: CONFIG_PATH of the environment, else config/example.yaml
  readonly configPath?: string;
  // Merged over the local overrides
  readonly extra?: Readonly<Record<string, unknown>>;
}

/** Loads the example config with the local overrides, and `extra` over them. The environment's CONFIG is not read. */
export const loadLocalConfig = async (
  { configPath, extra = {} }: LocalConfigOptions = {}, env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<PlatformConfig> => loadPlatformConfig({
  env: {
    CONFIG_PATH: configPath ?? (env['CONFIG_PATH']?.trim() || 'config/example.yaml'),
    CONFIG: Buffer.from(JSON.stringify(merge({ ...localConfigOverride }, { ...extra }))).toString('base64'),
  },
});
