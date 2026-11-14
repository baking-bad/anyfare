import { isRecord } from '@anyfare/common';
import { RedisNotReadyError, type Redis } from '@anyfare/db';

// The Signer's refill keys after the connection's prefix: each refill's answer by its ID, and the day's
// refills per target asset, apart from the spend limits of routed payments
export const refillIdKeyPrefix = 'refill:id:';
export const refillSpendKeyPrefix = 'refill:spend:';

// A refill's answer, or its pending marker, is kept this long: its ID is never paid twice
export const refillReplaySeconds = 7 * 86_400;

/** `POST /internal/v1/refills`'s answer for a refill whose transfer went through. Amounts are atomic units, `amount` micro-USD. */
export interface RefillAnswer {
  readonly refillId: string;
  readonly asset: string;
  readonly amount: string;
  readonly depositAddress: string;
  readonly amountIn: string;
  readonly amountOut: string;
  // The deadline the Signer asked 1Click for: a swap unfinished by then is refunded. Not the quote's own
  // deadline, which is when the deposit address goes inactive, days later.
  readonly quoteDeadline: string;
  readonly correlationId: string;
  readonly transactionHash: string;
  // 1Click's answer as it came, kept for a dispute
  readonly quote: Readonly<Record<string, unknown>>;
}

/** A refill whose transaction may have moved the source asset: the workers follow 1Click's status for the deposit address. */
export interface RefillUnknown {
  readonly outcome: 'unknown';
  readonly transactionHash: string;
  readonly depositAddress: string;
  readonly amountIn: string;
  readonly amountOut: string;
  // As in RefillAnswer: the deadline the Signer asked for
  readonly quoteDeadline: string;
  readonly correlationId: string;
}

/**
 * What the replay key holds: the marker of a refill in progress, or the outcome it came to, with the
 * asset and the amount in micro-USD it was asked for, so the ID can't be asked again for another.
 */
export type RefillRecord =
  | { readonly state: 'pending'; readonly marker: string }
  | { readonly state: 'sent'; readonly answer: RefillAnswer }
  | { readonly state: 'unknown'; readonly asset: string; readonly amount: string; readonly body: RefillUnknown };

/** Port: a refill's replay record, so nothing is ever sent twice for one ID. */
export interface RefillStore {
  /** Sets this refill's pending marker unless its key holds a record. Undefined: claimed now. Otherwise the record it holds. */
  claim(refillId: string, marker: string): Promise<RefillRecord | undefined>;
  /** Deletes the pending marker, only while it is this one, so the ID can be asked again. */
  abandon(refillId: string, marker: string): Promise<void>;
  /** Keeps the outcome under the ID, in place of the marker, for `refillReplaySeconds`. */
  settle(refillId: string, record: Exclude<RefillRecord, { state: 'pending' }>): Promise<void>;
}

// Sets the marker when the key holds nothing, or answers what it holds, in one step. KEYS: the
// refill's key. ARGV: the marker, its lifetime in seconds.
const claimScript = `
if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'EX', ARGV[2]) then return false end
return redis.call('GET', KEYS[1])`;

// Deletes the key only while it holds this marker. KEYS: the refill's key. ARGV: the marker.
const abandonScript = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0`;

const pendingOf = (marker: string): string => JSON.stringify({ state: 'pending', marker });

// A record as stored. One that doesn't read is taken as pending: never as a reason to send again.
const parseRecord = (value: string): RefillRecord => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  }
  catch {
    parsed = undefined;
  }
  if (isRecord(parsed) && parsed['state'] === 'sent' && isRecord(parsed['answer']))
    return { state: 'sent', answer: parsed['answer'] as unknown as RefillAnswer };
  if (isRecord(parsed) && parsed['state'] === 'unknown' && isRecord(parsed['body']) && typeof parsed['asset'] === 'string' && typeof parsed['amount'] === 'string')
    return { state: 'unknown', asset: parsed['asset'], amount: parsed['amount'], body: parsed['body'] as unknown as RefillUnknown };

  return { state: 'pending', marker: isRecord(parsed) && typeof parsed['marker'] === 'string' ? parsed['marker'] : '' };
};

/**
 * Refill records in the Signer's Redis, at `<prefix>refill:id:<refill ID>`, as JSON, for 7 days. Fails
 * closed: while Redis is down, no refill is claimed.
 */
export const createRedisRefillStore = ({ redis }: { readonly redis: Redis }): RefillStore => {
  const keyOf = (refillId: string) => `${redis.prefix}${refillIdKeyPrefix}${refillId}`;
  const ready = () => {
    if (!redis.client.isReady)
      throw new RedisNotReadyError();
  };

  return {
    claim: async (refillId, marker) => {
      ready();
      const held = await redis.client.eval(claimScript, { keys: [keyOf(refillId)], arguments: [pendingOf(marker), String(refillReplaySeconds)] });

      return typeof held === 'string' ? parseRecord(held) : undefined;
    },
    abandon: async (refillId, marker) => {
      ready();
      await redis.client.eval(abandonScript, { keys: [keyOf(refillId)], arguments: [pendingOf(marker)] });
    },
    settle: async (refillId, record) => {
      ready();
      await redis.client.set(keyOf(refillId), JSON.stringify(record), { expiration: { type: 'EX', value: refillReplaySeconds } });
    },
  };
};
