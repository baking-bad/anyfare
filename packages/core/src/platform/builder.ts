import {
  deepFreeze, findUnsafeValue, getSafeErrorMessage, parseUsd, ValidationError, type MicroUsd, type ValuePath,
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

  checkAmount(['paymentKeyDefaults', 'dailyBudget'], document.paymentKeyDefaults?.dailyBudget);

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

  return deepFreeze<PlatformConfig>({
    version: document.version,
    environment: document.environment,
    logger: { level: document.logger?.level ?? platformDefaults.loggerLevel },
    urls: { ...document.urls },
    ownHosts: [...ownHosts],
    keyPrefixes: { ...document.keyPrefixes },
    paymentKeyDefaults: { dailyBudget: usd(document.paymentKeyDefaults?.dailyBudget, platformDefaults.paymentKeyDailyBudget) },
    assets,
    rateLimits: { signup: { ...document.rateLimits.signup } },
    timeouts: { ...platformDefaults.timeouts, ...document.timeouts },
  });
};

export const findAsset = (config: PlatformConfig, name: string): Asset | undefined =>
  config.assets.find(asset => asset.name === name);
