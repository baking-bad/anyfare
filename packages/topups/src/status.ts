import { AnyfareError } from '@anyfare/common';

import type { OneClickStatus } from './oneClick.js';

/** Where a swap stands, as the status job reads it. */
export type SwapProgress = 'waiting' | 'incomplete' | 'processing' | 'success' | 'refunded' | 'failed';

/** 1Click answered a status this code doesn't know. */
export class UnknownOneClickStatusError extends AnyfareError {
  readonly code = 'oneclick_unknown_status';
  readonly status: string;

  constructor(status: string) {
    super(`Unknown 1Click status ${JSON.stringify(status.slice(0, 64))}`);

    this.status = status;
  }
}

const progress: Readonly<Record<OneClickStatus, SwapProgress>> = {
  // 1Click has seen the deposit's transaction but not its confirmation yet
  KNOWN_DEPOSIT_TX: 'waiting',
  PENDING_DEPOSIT: 'waiting',
  INCOMPLETE_DEPOSIT: 'incomplete',
  PROCESSING: 'processing',
  SUCCESS: 'success',
  REFUNDED: 'refunded',
  FAILED: 'failed',
};

/** The swap's progress for a 1Click status. Throws UnknownOneClickStatusError for any other value. */
export const fromOneClickStatus = (status: string): SwapProgress => {
  if (!Object.hasOwn(progress, status))
    throw new UnknownOneClickStatusError(status);

  return progress[status as OneClickStatus];
};
