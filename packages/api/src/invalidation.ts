import { withTimeout, type Logger } from '@anyfare/common';
import type { InvalidationBus, InvalidationEvent } from '@anyfare/core';

// How long a write waits to publish its invalidation event before it gives up and logs
export const publishTimeoutMs = 2_000;

/**
 * Publishes an invalidation event after a commit. Best effort, like the bus itself: the change is
 * committed, and caches still expire on their own, so a failure is logged and the request succeeds.
 */
export const createPublisher = ({ invalidation, logger }: { readonly invalidation: Pick<InvalidationBus, 'publish'>; readonly logger: Logger }) =>
  async (event: InvalidationEvent): Promise<void> => {
    try {
      await withTimeout(() => invalidation.publish(event), { timeoutMs: publishTimeoutMs });
    }
    catch (error) {
      logger.error({ error, event }, 'Failed to publish an invalidation event');
    }
  };
