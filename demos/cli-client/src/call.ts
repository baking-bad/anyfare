// One paid call by the way chosen: the one place that picks the payer.

import type { PayWay } from './cli.ts';
import type { Context } from './context.ts';
import { callWithCredits } from './credits.ts';
import type { CallCommand } from './paid.ts';
import { callWithTempo } from './tempo.ts';
import { callWithX402 } from './x402.ts';

export async function runCall(ctx: Context, command: CallCommand & { readonly pay: PayWay }): Promise<number> {
  switch (command.pay) {
    case 'credits':
      return callWithCredits(ctx, command);
    case 'base':
    case 'near':
      return callWithX402(ctx, command, command.pay);
    case 'tempo':
      return callWithTempo(ctx, command);
  }
}
