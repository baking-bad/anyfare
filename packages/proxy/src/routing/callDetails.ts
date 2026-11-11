import type { LogSink } from '@anyfare/common';
import type { CallRepository } from '@anyfare/db';
import type { Authorization } from '@anyfare/payments';

// The most detail writes in flight, whether waiting for a connection or holding one: past it a call's
// details are dropped. With each write giving up after its statement timeout, a stalled database lets
// them hold at most this many of the pool's connections, and only that long; the rest stay for the
// calls' own queries.
export const maxPendingDetails = 2;

// What a payer's address may look like: an EVM or Solana address, or a NEAR account ID
const payerPattern = /^[0-9A-Za-z._-]{1,128}$/;

/**
 * The payer of a payment on a chain, from the rail's `address:<network>:<payer>`. Credits name an
 * account, which is never kept, so they have none; nor has a payer the rail didn't learn.
 */
export const payerOf = (authorization: Pick<Authorization, 'rail' | 'buyer'>): string | undefined => {
  const { rail, buyer } = authorization;
  if (rail === 'credits' || !buyer.startsWith('address:'))
    return undefined;
  const payer = buyer.slice(buyer.lastIndexOf(':') + 1);

  return payer !== 'unknown' && payerPattern.test(payer) ? payer : undefined;
};

export interface CallDetailsRecorder {
  /**
   * Keeps a paid call's method, payer and arrival, best effort: it returns at once, never throws, and
   * a write that fails or is dropped is one warn line. The call never waits for it.
   */
  record(input: { readonly authorization: Pick<Authorization, 'paymentId' | 'rail' | 'buyer'>; readonly method: string; readonly arrivedAt: Date; readonly log: LogSink }): void;
  /** Waits for the writes in flight, so shutdown closes the database after them. */
  drain(): Promise<void>;
}

export const createCallDetailsRecorder = ({ store }: { readonly store: Pick<CallRepository, 'recordDetails'> }): CallDetailsRecorder => {
  const pending = new Set<Promise<void>>();

  return {
    record: ({ authorization, method, arrivedAt, log }) => {
      const { paymentId } = authorization;
      try {
        if (pending.size >= maxPendingDetails) {
          log.warn({ paymentId, pending: pending.size }, 'A call\'s details were not kept: too many writes are in flight. The call goes on.');
          return;
        }
        const write: Promise<void> = store.recordDetails({ paymentId, method, payer: payerOf(authorization), arrivedAt })
          .catch((error: unknown) => {
            log.warn({ error, paymentId }, 'A call\'s details couldn\'t be kept. The call goes on.');
          })
          .finally(() => pending.delete(write));
        pending.add(write);
      }
      catch (error) {
        log.warn({ error, paymentId }, 'A call\'s details couldn\'t be kept. The call goes on.');
      }
    },
    drain: async () => {
      while (pending.size > 0)
        await Promise.allSettled([...pending]);
    },
  };
};
