import { readFileSync } from 'node:fs';

import { parseStrictYaml } from '@anyfare/common';

import { buildPlatformConfig, type PlatformConfig } from '../src/index.js';

export const examplePlatformConfigPath = new URL('../../../config/example.yaml', import.meta.url);

export const loadExamplePlatformDocument = (): Record<string, unknown> =>
  structuredClone(parseStrictYaml(readFileSync(examplePlatformConfigPath)).value);

export const examplePlatform: PlatformConfig = buildPlatformConfig(loadExamplePlatformDocument() as never);

// Objects merge by key; other values replace. `undefined` deletes the key.
export const patch = (base: unknown, changes: unknown): unknown => {
  if (typeof base !== 'object' || base === null || Array.isArray(base) || typeof changes !== 'object' || changes === null || Array.isArray(changes))
    return changes;

  const result: Record<string, unknown> = { ...base as Record<string, unknown> };
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined)
      delete result[key];
    else
      result[key] = patch(result[key], value);
  }

  return result;
};
