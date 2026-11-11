import {
  deepFreeze, findUnsafeValue, formatUsd, getSafeErrorMessage, parseUsd, ValidationError, type MicroUsd, type NetworkId, type ValuePath,
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

// The most Free Credits one new account may get: $10
const maxFreeCreditsAmount: MicroUsd = 10_000_000n;

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
  // The amount, or undefined when it is absent or doesn't parse
  const checkAmount = (path: ValuePath, value: string | undefined): MicroUsd | undefined => {
    if (value === undefined)
      return undefined;
    try {
      return parseUsd(value);
    }
    catch (error) {
      add(path, getSafeErrorMessage(error));
      return undefined;
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
  // The Signer's hot wallets, by their public addresses: EVM on Base and Tempo, base58 on Solana, an
  // account ID on NEAR
  for (const [chain, address] of Object.entries(document.signer?.wallets ?? {})) {
    const network = supportedNetworks.find(item => item.chain === chain);
    if (network && typeof address === 'string' && !isValidAddress(network, address))
      add(['signer', 'wallets', chain], network.namespace === 'near' ? 'is not a NEAR account ID' : `is not a valid address on ${network.title}`);
  }

  // The gift is checked even while it is off, so turning it on can't start a mistake
  const giftAmount = checkAmount(['freeCredits', 'amount'], document.freeCredits?.amount ?? platformDefaults.freeCredits.amount);
  const maxPerDay = checkAmount(['freeCredits', 'maxPerDay'], document.freeCredits?.maxPerDay);
  if (giftAmount !== undefined && giftAmount <= 0n)
    add(['freeCredits', 'amount'], 'must be more than 0. To give nothing, set freeCredits.enabled to false');
  else if (giftAmount !== undefined && giftAmount > maxFreeCreditsAmount)
    add(['freeCredits', 'amount'], `must be at most ${formatUsd(maxFreeCreditsAmount)} USD, the most one new account may get`);
  if (giftAmount !== undefined && maxPerDay !== undefined && maxPerDay < giftAmount)
    add(['freeCredits', 'maxPerDay'], `must be at least freeCredits.amount (${formatUsd(giftAmount)} USD): a smaller daily cap would give nothing`);

  // Top-ups too are checked while they are off. 1Click delivers to a NEAR account and refunds to an
  // account inside intents.near, so the asset is on NEAR and both accounts are NEAR account IDs.
  const topups = document.topups ?? {};
  const topupAsset = topups.asset === undefined ? undefined : document.assets.find(asset => asset.name === topups.asset);
  const topupNetwork = findNetwork(topupAsset?.network ?? '');
  if (topups.asset !== undefined && !topupAsset)
    add(['topups', 'asset'], `is not an asset in assets. Assets: ${document.assets.map(asset => asset.name).join(', ')}`);
  else if (topupAsset && topupNetwork?.namespace !== 'near')
    add(['topups', 'asset'], 'must be an asset on a NEAR network: 1Click delivers it to a NEAR account');
  const nearNetwork = topupNetwork?.namespace === 'near' ? topupNetwork : supportedNetworks.find(item => item.namespace === 'near')!;
  for (const field of ['recipient', 'refundTo'] as const) {
    const account = topups[field];
    if (account !== undefined && !isValidAddress(nearNetwork, account))
      add(['topups', field], 'is not a NEAR account ID');
  }
  const topupNetworkNames = new Set<string>();
  for (const [index, network] of (topups.networks ?? []).entries()) {
    const path = ['topups', 'networks', index];
    if (topupNetworkNames.has(network.name))
      add([...path, 'name'], `duplicate network name ${JSON.stringify(network.name)}`);
    topupNetworkNames.add(network.name);
    const minimum = checkAmount([...path, 'minimum'], network.minimum);
    if (minimum !== undefined && minimum <= 0n)
      add([...path, 'minimum'], 'must be more than 0: the least a top-up on this network must be worth');
    // A top-up's worth is compared in whole cents, so a minimum between two cents could never be met exactly
    else if (minimum !== undefined && minimum % 10_000n !== 0n)
      add([...path, 'minimum'], 'must be whole cents, at most 2 decimals, such as 1 or 2.5: a top-up\'s worth is rounded to the cent');
  }
  if (topups.enabled) {
    for (const field of ['asset', 'recipient', 'refundTo', 'networks'] as const) {
      if (topups[field] === undefined)
        add(['topups'], `missing required field ${JSON.stringify(field)}: top-ups are enabled`);
    }
    if (topups.networks?.length === 0)
      add(['topups', 'networks'], 'must have at least 1 item: top-ups are enabled');
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
    ...document.urls.console === undefined ? [] : [hostOf(document.urls.console)],
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
  const { timeouts, sizeLimits, signer, freeCredits, topups } = platformDefaults;

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
      probeIp: { ...document.rateLimits.probeIp ?? platformDefaults.probeIpRateLimit },
      topups: { ...document.rateLimits.topups ?? platformDefaults.topupsRateLimit },
      publicReads: { ...document.rateLimits.publicReads ?? platformDefaults.publicReadsRateLimit },
    },
    callStream: { ...platformDefaults.callStream, ...document.callStream },
    stats: { ...platformDefaults.stats, ...document.stats },
    timeouts: { ...timeouts, ...document.timeouts },
    sizeLimits: { ...sizeLimits, ...document.sizeLimits },
    signer: {
      maxPerCall: usd(document.signer?.maxPerCall, signer.maxPerCall),
      maxPerNetworkPerHour: document.signer?.maxPerNetworkPerHour === undefined ? undefined : parseUsd(document.signer.maxPerNetworkPerHour),
      maxPerNetworkPerDay: usd(document.signer?.maxPerNetworkPerDay, signer.maxPerNetworkPerDay),
      wallets: {
        base: document.signer?.wallets?.base, tempo: document.signer?.wallets?.tempo, solana: document.signer?.wallets?.solana, near: document.signer?.wallets?.near,
      },
    },
    freeCredits: {
      enabled: document.freeCredits?.enabled ?? freeCredits.enabled,
      amount: usd(document.freeCredits?.amount, freeCredits.amount),
      perIp: { ...document.freeCredits?.perIp ?? freeCredits.perIp },
      maxPerDay: document.freeCredits?.maxPerDay === undefined ? undefined : parseUsd(document.freeCredits.maxPerDay),
    },
    topups: {
      enabled: document.topups?.enabled ?? topups.enabled,
      url: document.topups?.url ?? topups.url,
      apiKey: document.topups?.apiKey,
      asset: assets.find(asset => asset.name === document.topups?.asset),
      recipient: document.topups?.recipient,
      refundTo: document.topups?.refundTo,
      slippageBps: document.topups?.slippageBps ?? topups.slippageBps,
      deadlineMinutes: { ...topups.deadlineMinutes, ...document.topups?.deadlineMinutes },
      stablecoins: [...document.topups?.stablecoins ?? topups.stablecoins],
      timeoutMs: document.topups?.timeoutMs ?? topups.timeoutMs,
      networks: (document.topups?.networks ?? []).map(network => ({ name: network.name, blockchain: network.blockchain, minimum: parseUsd(network.minimum) })),
    },
  });
};

export const findAsset = (config: PlatformConfig, name: string): Asset | undefined =>
  config.assets.find(asset => asset.name === name);

export const findFacilitator = (config: PlatformConfig, networkId: NetworkId) =>
  config.facilitators.find(facilitator => facilitator.networks.includes(networkId));
