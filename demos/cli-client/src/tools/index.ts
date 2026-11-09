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
