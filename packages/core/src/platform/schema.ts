import type { SchemaObject } from 'ajv';

import { assetNamePattern, networkIdPattern } from '@anyfare/common';

import {
  array, constant, host, httpsOrigin, integer, object, oneOfValues, text, usdAmount,
} from '../validation/schema.js';

const assetName: SchemaObject = {
  type: 'string', pattern: assetNamePattern, maxLength: 64,
  errorMessage: 'must be lowercase letters and digits separated by single hyphens, such as base-usdc',
};
const networkId: SchemaObject = {
  type: 'string', pattern: networkIdPattern,
  errorMessage: 'must be a CAIP-2 network ID, such as eip155:8453',
};
const keyPrefix: SchemaObject = {
  type: 'string', pattern: '^[a-z][a-z0-9_]{1,31}$',
  errorMessage: 'must be 2–32 lowercase letters, digits, or underscores, such as af_live_',
};
// An unquoted 0x… address reads as a hex number in YAML: say how to fix it
const addressText = text(128, { errorMessage: { type: 'must be a string: put the address in quotes, since YAML reads an unquoted 0x… as a number' } });
const positive = integer(1);
const rateLimit = object({ requests: positive, windowSeconds: positive }, ['requests', 'windowSeconds']);

export const platformConfigSchema: SchemaObject = {
  $id: 'anyfare-platform-config-v1',
  ...object({
    version: constant(1),
    environment: oneOfValues(['staging', 'production']),
    logger: object({ level: oneOfValues(['trace', 'debug', 'info', 'warn', 'error', 'fatal']) }),
    urls: object({ website: httpsOrigin, api: httpsOrigin, pay: httpsOrigin }, ['website', 'api', 'pay']),
    ownHosts: array(host, { uniqueItems: true }),
    keyPrefixes: object({ master: keyPrefix, payment: keyPrefix }, ['master', 'payment']),
    paymentKeyDefaults: object({ dailyBudget: usdAmount }),
    assets: array(object({
      name: assetName,
      network: networkId,
      address: addressText,
      decimals: integer(0, 36),
      peg: constant('usd'),
      minPrice: usdAmount,
      payTo: addressText,
    }, ['name', 'network', 'address', 'decimals', 'peg']), { minItems: 1 }),
    rateLimits: object({ signup: rateLimit }, ['signup']),
    timeouts: object({ connectMs: positive, requestMs: positive, settleMs: positive }),
  }, ['version', 'environment', 'urls', 'keyPrefixes', 'assets', 'rateLimits']),
};
