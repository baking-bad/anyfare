import type { ToolArgs } from '../cli.ts';
import { cmc } from './cmc.ts';
import { evidence } from './evidence.ts';
import { threeRoute } from './threeRoute.ts';
import type { Tool, ToolId } from './types.ts';

/** The tools by id, in the order cmc, 3route, evidence. */
export const TOOLS: Readonly<Record<ToolId, Tool>> = {
  cmc,
  '3route': threeRoute,
  evidence,
};

/** The data of each tool's call when no flag gives it. */
export const DEFAULT_ARGS: { readonly [K in ToolId]: Extract<ToolArgs, { tool: K }> } = {
  cmc: { tool: 'cmc', pair: 'BTC/USD' },
  '3route': { tool: '3route', chain: 'base', from: 'USDC', to: 'WETH', amount: '1' },
  evidence: { tool: 'evidence', account: 'anyfare.near' },
};
