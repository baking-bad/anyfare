import {
  InvalidEnvironmentError, readCommit, readHost, readLogLevel, readPort, readSecret, Secret, type AppContext, type AppEnvironment, type RunningApp,
} from '@anyfare/common';
import { isValidAddress, loadPlatformConfig, platformSummary, type NetworkInfo } from '@anyfare/core';

import { createApp, hostOf, nearOf, nearRpcUrlOf, nearSetupOf, relayerProblem, type RelayerAccount } from './app.js';
import { createRelayer, minimumRelayerBalance, type RelayerState } from './relayer.js';

export const defaultPort = 8084;
export const defaultMetricsPort = 9084;
// Long enough that guessing it over the network is hopeless
export const minimumFacilitatorSecretLength = 32;

const nearNetworks: readonly string[] = ['near:mainnet', 'near:testnet'];
const nearKeyPattern = /^ed25519:[1-9A-HJ-NP-Za-km-z]{32,128}$/;

const readFacilitatorSecret = (env: AppEnvironment): Secret => {
  const secret = readSecret('FACILITATOR_SECRET', env);
  if (secret.expose().length < minimumFacilitatorSecretLength) {
    secret.destroy();
    throw new InvalidEnvironmentError(`FACILITATOR_SECRET must be at least ${minimumFacilitatorSecretLength} characters`);
  }

  return secret;
};

/**
 * The relayer: FACILITATOR_NEAR_ACCOUNT, and its full-access key from FACILITATOR_NEAR_KEY, `ed25519:`
 * and base58. The key is taken out of the environment as it's read, so nothing that reads the
 * environment later, such as a child process or a crash report, finds it. No error echoes it.
 */
export const readRelayer = (env: AppEnvironment, network: NetworkInfo): RelayerAccount => {
  let key: Secret;
  try {
    key = readSecret('FACILITATOR_NEAR_KEY', env);
  }
  finally {
    delete (env as Record<string, string | undefined>)['FACILITATOR_NEAR_KEY'];
  }
  const value = key.expose().trim();
  key.destroy();
  const accountId = env['FACILITATOR_NEAR_ACCOUNT']?.trim() ?? '';
  if (!isValidAddress(network, accountId))
    throw new InvalidEnvironmentError('FACILITATOR_NEAR_ACCOUNT must be a NEAR account ID');
  if (!nearKeyPattern.test(value))
    throw new InvalidEnvironmentError('FACILITATOR_NEAR_KEY must be ed25519: and a base58 key');

  return { accountId, secretKey: Secret.from(value) };
};

/**
 * The accounts the facilitator accepts payments to: FACILITATOR_RECIPIENTS, NEAR account IDs separated
 * by commas, else the payTo of the platform config's NEAR assets.
 */
export const readRecipients = (env: AppEnvironment, network: NetworkInfo, payTo: readonly string[]): readonly string[] => {
  const value = env['FACILITATOR_RECIPIENTS']?.trim();
  if (!value)
    return payTo;
  const recipients = value.split(',').map(item => item.trim()).filter(Boolean);
  if (recipients.length === 0 || recipients.some(accountId => !isValidAddress(network, accountId)))
    throw new InvalidEnvironmentError('FACILITATOR_RECIPIENTS must be NEAR account IDs, separated by commas');

  return [...new Set(recipients)];
};

const parsedUrl = (value: string): URL | undefined => {
  try {
    const url = new URL(value);

    return url.protocol === 'https:' || url.protocol === 'http:' ? url : undefined;
  }
  catch {
    return undefined;
  }
};

/**
 * NEAR_RPC_URLS: `near:mainnet=https://…` items separated by commas, over the x402 SDK's public RPCs.
 * Only the config's NEAR network may be named. A URL may carry a key in its path or query string,
 * never as a username or password, so an invalid item throws without echoing it, and only hosts are
 * logged.
 */
export const readNearRpcUrls = (env: AppEnvironment, network: NetworkInfo): Readonly<Record<string, string>> => {
  const urls: Record<string, string> = {};
  for (const item of (env['NEAR_RPC_URLS'] ?? '').split(',').map(entry => entry.trim()).filter(Boolean)) {
    const separator = item.indexOf('=');
    const name = separator < 0 ? '' : item.slice(0, separator).trim();
    const url = separator < 0 ? '' : item.slice(separator + 1).trim();
    const parsed = parsedUrl(url);
    if (!nearNetworks.includes(name) || !parsed)
      throw new InvalidEnvironmentError('NEAR_RPC_URLS must be near:<network>=<HTTP(S) URL> items, separated by commas');
    if (parsed.username !== '' || parsed.password !== '')
      throw new InvalidEnvironmentError('NEAR_RPC_URLS can\'t carry a username or password: put a key in the path or the query string');
    if (name !== network.id)
      throw new InvalidEnvironmentError(`NEAR_RPC_URLS names ${name}, but the platform config's NEAR network is ${network.id}`);
    urls[name] = url;
  }

  return urls;
};

/**
 * The relayer, once, before the facilitator serves: its account exists, the key is one of its
 * full-access keys, and it holds the NEAR its transactions' gas needs. Otherwise it doesn't start. No
 * message carries the key or the RPC's URL.
 */
export const checkRelayer = async ({ relayer, network, rpcUrl, timeoutMs }: {
  readonly relayer: RelayerAccount;
  readonly network: NetworkInfo;
  readonly rpcUrl: string;
  readonly timeoutMs: number;
}): Promise<void> => {
  const probe = createRelayer({ accountId: relayer.accountId, secretKey: relayer.secretKey, network: network.id, rpcUrl, readMs: timeoutMs, sendMs: timeoutMs });
  let state: RelayerState;
  try {
    state = await probe.state();
  }
  catch {
    throw new Error(`The NEAR RPC at ${hostOf(rpcUrl)} didn't answer for the relayer ${relayer.accountId}`);
  }
  const problem = relayerProblem(state, relayer.accountId);
  if (problem)
    throw new InvalidEnvironmentError(`${problem} on ${network.id}`);
  if (state.amount !== undefined && state.amount < minimumRelayerBalance) {
    throw new InvalidEnvironmentError(
      `The relayer ${relayer.accountId} holds ${nearOf(state.amount)} NEAR, under the ${nearOf(minimumRelayerBalance)} NEAR its transactions' gas needs`,
    );
  }
};

/**
 * Wires the production dependencies from platform config and the environment, then listens. The
 * facilitator serves the platform config's NEAR network, and settles through one relayer whose key
 * comes from the stack's secrets.
 */
export const startFacilitator = async ({ env, logger }: AppContext): Promise<RunningApp> => {
  const config = await loadPlatformConfig({ env });
  // LOG_LEVEL overrides the config's level
  logger.level = readLogLevel(env, config.logger.level);
  const listen = {
    host: readHost(env),
    port: readPort(env, 'PORT', defaultPort),
    metricsPort: readPort(env, 'METRICS_PORT', defaultMetricsPort),
  };
  const { network, payTo } = nearSetupOf(config);
  const secret = readFacilitatorSecret(env);
  const relayer = readRelayer(env, network);
  const recipients = readRecipients(env, network, payTo);
  const rpcUrls = readNearRpcUrls(env, network);
  if (recipients.length === 0)
    logger.warn('The facilitator has no recipients: FACILITATOR_RECIPIENTS is not set and no NEAR asset has a payTo, so every payment is refused');
  const rpcUrl = nearRpcUrlOf(network.id, rpcUrls);
  await checkRelayer({ relayer, network, rpcUrl, timeoutMs: config.timeouts.connectMs });

  const server = createApp({ config, logger, secret, relayer, recipients, rpcUrls });
  const ports = await server.listen(listen);
  // Once, what this facilitator settles with: the relayer's account, never its key, and the RPC's host only
  logger.info({
    app: 'facilitator',
    commit: readCommit(env) ?? null,
    logLevel: logger.level,
    environment: platformSummary(config).environment,
    network: network.id,
    relayer: relayer.accountId,
    recipients,
    rpcHosts: [hostOf(rpcUrl)],
    ports,
  }, 'Started');

  return {
    close: () => server.close(),
  };
};
