import {
  deepFreeze, findUnsafeValue, getSafeErrorMessage, parseUsd, ValidationError, type MicroUsd, type NetworkId, type ValuePath,
} from '@anyfare/common';

import { isValidAddress, isValidAssetAddress } from '../addresses.js';
import { findNetwork, supportedNetworks, type NetworkInfo } from '../networks.js';
import { toIssues, type IssueDraft, type IssueLocator } from '../validation/issues.js';
import { ajv, toSchemaDrafts } from '../validation/schema.js';
import type { Asset, PlatformConfig } from './config.js';
import { platformDefaults } from './defaults.js';
import type { PlatformConfigDocument } from './document.js';
import { platformConfigSchema } from './schema.js';

const validateDocument = ajv.compile<PlatformConfigDocument>(platformConfigSchema);

/** Pass 1: shape. JSON Schema with no unknown fields anywhere. */
export const validatePlatformConfigDocument = (value: unknown): readonly IssueDraft[] => {
  const unsafe = findUnsafeValue(value);
  if (unsafe)
    return [{ path: unsafe.path, message: unsafe.message, key: unsafe.key }];

  return validateDocument(value) ? [] : toSchemaDrafts(validateDocument.errors ?? []);
};

export const assertValidPlatformConfigDocument: (value: unknown, locator?: IssueLocator) => asserts value is PlatformConfigDocument = (value, locator) => {
  const drafts = validatePlatformConfigDocument(value);
  if (drafts.length > 0)
    throw new ValidationError('Invalid platform config', toIssues(drafts, locator));
};

const hostOf = (url: string): string => new URL(url).hostname.toLowerCase();

/** Pass 2: rules across fields, for a document that passed the schema. */
export const checkPlatformConfig = (document: PlatformConfigDocument): readonly IssueDraft[] => {
  const drafts: IssueDraft[] = [];
  const add = (path: ValuePath, message: string) => drafts.push({ path, message });
  const staging = document.environment === 'staging';

  const checkNetwork = (path: ValuePath, id: string): NetworkInfo | undefined => {
    const network = findNetwork(id);
    if (!network) {
      add(path, `is not a supported network. Supported: ${supportedNetworks.map(item => item.id).join(', ')}`);
      return undefined;
    }
    // Staging runs on testnets only, production on mainnets only
    if (network.testnet !== staging)
      add(path, staging ? `${network.title} is a mainnet; staging uses testnets` : `${network.title} is a testnet; production uses mainnets`);

    return network;
  };
  const checkAmount = (path: ValuePath, value: string | undefined): void => {
    if (value === undefined)
      return;
    try {
      parseUsd(value);
    }
    catch (error) {
      add(path, getSafeErrorMessage(error));
    }
  };

  // The first characters of a key tell its kind
  const { master, payment } = document.keyPrefixes;
  if (master.startsWith(payment) || payment.startsWith(master))
    add(['keyPrefixes', 'payment'], 'the master and payment key prefixes must differ, and neither may start with the other');

  const assetNames = new Set<string>();
  const assetTokens = new Set<string>();
  for (const [index, asset] of document.assets.entries()) {
    const path = ['assets', index];
    if (assetNames.has(asset.name))
      add([...path, 'name'], `duplicate asset name ${JSON.stringify(asset.name)}`);
    assetNames.add(asset.name);

    const network = checkNetwork([...path, 'network'], asset.network);
    if (network) {
      if (!isValidAssetAddress(network, asset.address))
        add([...path, 'address'], `is not a valid token address on ${network.title}`);
      if (asset.payTo !== undefined && !isValidAddress(network, asset.payTo))
        add([...path, 'payTo'], `is not a valid address on ${network.title}`);
    }

    const token = `${asset.network}\n${asset.address}`;
    if (assetTokens.has(token))
      add([...path, 'address'], 'another asset already uses this token on the same network');
    assetTokens.add(token);
    checkAmount([...path, 'minPrice'], asset.minPrice);
  }

  const facilitatorNames = new Set<string>();
  const facilitatorByNetwork = new Map<string, string>();
  for (const [index, facilitator] of document.facilitators.entries()) {
    const path = ['facilitators', index];
    if (facilitatorNames.has(facilitator.name))
      add([...path, 'name'], `duplicate facilitator name ${JSON.stringify(facilitator.name)}`);
    facilitatorNames.add(facilitator.name);

    for (const [networkIndex, networkId] of facilitator.networks.entries()) {
      checkNetwork([...path, 'networks', networkIndex], networkId);
      const owner = facilitatorByNetwork.get(networkId);
      if (owner !== undefined)
        add([...path, 'networks', networkIndex], `facilitator ${JSON.stringify(owner)} already serves this network`);
      else
        facilitatorByNetwork.set(networkId, facilitator.name);
    }
  }

  // A Tempo asset serves MPP, on its network and paid to its recipient, and needs no facilitator
  for (const [index, asset] of document.assets.entries()) {
    const path = ['assets', index];
    const chain = findNetwork(asset.network)?.chain;
    if (chain !== 'tempo') {
      if (!facilitatorByNetwork.has(asset.network))
        add([...path, 'network'], 'no facilitator serves this network');
      continue;
    }
    if (asset.network !== document.mpp.network)
      add([...path, 'network'], `is a Tempo network other than mpp.network (${document.mpp.network}). Tempo assets serve MPP, on its network only`);
    else if (asset.payTo !== undefined && document.mpp.recipient !== undefined && asset.payTo.toLowerCase() !== document.mpp.recipient.toLowerCase())
      add([...path, 'payTo'], 'must be the MPP recipient (mpp.recipient): Tempo assets are paid through MPP');
  }

  const mppNetwork = checkNetwork(['mpp', 'network'], document.mpp.network);
  if (mppNetwork && mppNetwork.chain !== 'tempo')
    add(['mpp', 'network'], 'must be a Tempo network');
  if (mppNetwork && document.mpp.recipient !== undefined && !isValidAddress(mppNetwork, document.mpp.recipient))
    add(['mpp', 'recipient'], `is not a valid address on ${mppNetwork.title}`);

  checkAmount(['paymentKeyDefaults', 'dailyBudget'], document.paymentKeyDefaults?.dailyBudget);
  checkAmount(['signer', 'maxPerCall'], document.signer?.maxPerCall);
  checkAmount(['signer', 'maxPerNetworkPerHour'], document.signer?.maxPerNetworkPerHour);
  checkAmount(['signer', 'maxPerNetworkPerDay'], document.signer?.maxPerNetworkPerDay);
  // The Signer's hot wallets, by their public addresses: EVM on Base and Tempo, base58 on Solana
  for (const [chain, address] of Object.entries(document.signer?.wallets ?? {})) {
    const network = supportedNetworks.find(item => item.chain === chain);
    if (network && typeof address === 'string' && !isValidAddress(network, address))
      add(['signer', 'wallets', chain], `is not a valid address on ${network.title}`);
  }

  return drafts;
};

// Only after checkPlatformConfig passed: every network is known and every amount parses
const network = (id: string): NetworkInfo => findNetwork(id)!;

/**
 * Builds the runtime platform config from a document that passed the schema. Runs the cross-field
 * checks first and throws a ValidationError listing every problem.
 */
export const buildPlatformConfig = (document: PlatformConfigDocument, locator?: IssueLocator): PlatformConfig => {
  const drafts = checkPlatformConfig(document);
  if (drafts.length > 0)
    throw new ValidationError('Invalid platform config', toIssues(drafts, locator));

  const usd = (value: string | undefined, fallback: string): MicroUsd => parseUsd(value ?? fallback);
  const ownHosts = new Set([
    hostOf(document.urls.website),
    hostOf(document.urls.api),
    hostOf(document.urls.pay),
    ...(document.ownHosts ?? []).map(item => item.toLowerCase()),
  ]);
  const assets = document.assets.map((asset): Asset => ({
    name: asset.name,
    network: network(asset.network),
    address: asset.address,
    decimals: asset.decimals,
    peg: asset.peg,
    minPrice: usd(asset.minPrice, platformDefaults.assetMinPrice),
    payTo: asset.payTo,
  }));
  const { timeouts, sizeLimits, signer } = platformDefaults;

  return deepFreeze<PlatformConfig>({
    version: document.version,
    environment: document.environment,
    logger: { level: document.logger?.level ?? platformDefaults.loggerLevel },
    urls: { ...document.urls },
    ownHosts: [...ownHosts],
    keyPrefixes: { ...document.keyPrefixes },
    paymentKeyDefaults: { dailyBudget: usd(document.paymentKeyDefaults?.dailyBudget, platformDefaults.paymentKeyDailyBudget) },
    routingFeeBps: document.routingFeeBps,
    assets,
    facilitators: document.facilitators.map(facilitator => ({
      name: facilitator.name,
      url: facilitator.url,
      networks: facilitator.networks.map(id => network(id).id),
      auth: facilitator.auth ? { ...facilitator.auth } : undefined,
      enabled: facilitator.enabled ?? true,
    })),
    mpp: {
      network: network(document.mpp.network),
      recipient: document.mpp.recipient,
      enabled: document.mpp.enabled ?? true,
      rpcUrl: document.mpp.rpcUrl,
    },
    rateLimits: {
      paymentKey: { ...document.rateLimits.paymentKey },
      unpaidIp: { ...document.rateLimits.unpaidIp },
      signup: { ...document.rateLimits.signup },
      documents: { ...document.rateLimits.documents ?? platformDefaults.documentsRateLimit },
    },
    timeouts: { ...timeouts, ...document.timeouts },
    sizeLimits: { ...sizeLimits, ...document.sizeLimits },
    signer: {
      maxPerCall: usd(document.signer?.maxPerCall, signer.maxPerCall),
      maxPerNetworkPerHour: document.signer?.maxPerNetworkPerHour === undefined ? undefined : parseUsd(document.signer.maxPerNetworkPerHour),
      maxPerNetworkPerDay: usd(document.signer?.maxPerNetworkPerDay, signer.maxPerNetworkPerDay),
      wallets: { base: document.signer?.wallets?.base, tempo: document.signer?.wallets?.tempo, solana: document.signer?.wallets?.solana },
    },
  });
};

export const findAsset = (config: PlatformConfig, name: string): Asset | undefined =>
  config.assets.find(asset => asset.name === name);

export const findFacilitator = (config: PlatformConfig, networkId: NetworkId) =>
  config.facilitators.find(facilitator => facilitator.networks.includes(networkId));
