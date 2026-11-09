import type { Fetch } from '../http.ts';
import type { ToolArgs } from '../cli.ts';

export type ToolId = 'cmc' | '3route' | 'evidence';

export interface ToolRequest {
  readonly method: 'GET' | 'POST';
  /** The target's own URL. */
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

export interface PreparedCall {
  readonly tool: ToolId;
  readonly request: ToolRequest;
  /** One line: "BTC in USD", "1 USDC → WETH on Base". */
  readonly summary: string;
  /** True when the API takes a while to answer. */
  readonly slow: boolean;
  /** The answer as lines, with the API's own time or block. */
  format(answer: unknown): readonly string[];
}

export interface Tool {
  readonly id: ToolId;
  /** "CoinMarketCap". */
  readonly name: string;
  /** One line: what it is and what it takes. No price. */
  readonly about: string;
  prepare(args: ToolArgs, context: { readonly fetch: Fetch }): Promise<PreparedCall>;
}
