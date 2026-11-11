import type { MicroUsd } from '@anyfare/common';
import { RedisNotReadyError, type Redis } from '@anyfare/db';

// The Signer's key space after the connection's prefix. Only the Signer's Redis ACL user may write it,
// so the proxy can't reset it.
export const spendKeyPrefix = 'spend:';

export type SpendRefusal = 'hourly_limit' | 'daily_limit';

/**
 * The windows a reservation counts in, by Redis's clock: the clock hour and the UTC day, as whole hours
 * and days since the Unix epoch. Every Signer reads the same clock, so replicas share their windows.
 */
export interface SpendWindowIds {
  readonly hour: number;
  readonly day: number;
}

/** A reservation's result: the refusal, if any, and each window's total, with this amount when it passed. */
export interface SpendReservation {
  readonly refusal: SpendRefusal | undefined;
  readonly hour: MicroUsd;
  readonly day: MicroUsd;
  readonly windows: SpendWindowIds;
}

/** An amount in the windows of a reservation. */
export interface SpendEntry {
  readonly network: string;
  readonly amount: MicroUsd;
  readonly windows: SpendWindowIds;
}

/** Port: the spend limits per network. */
export interface SpendLimits {
  /** Checks both limits and adds the amount, atomically. Says why it refused, and the windows' totals. */
  reserve(input: { readonly network: string; readonly amount: MicroUsd }): Promise<SpendReservation>;
  /** Gives a reservation back when nothing was signed for it, in the windows it counted in. Never below 0. */
  release(entry: SpendEntry): Promise<void>;
  /** Adds what a signed payment costs beyond its amount, such as a Tempo fee, to its windows. Never refuses. */
  add(entry: SpendEntry): Promise<void>;
}

const hourSeconds = 3_600;
const daySeconds = 86_400;
// Each window's counter outlives the window, so a late release or fee still finds it
const hourTtlSeconds = 2 * hourSeconds;
const dayTtlSeconds = 2 * daySeconds;

// Reads Redis's clock, checks both windows, then adds to both, in one script: two Signers never pass a
// limit together. KEYS[1]: the network's key base. Answers the code, both totals, and both windows.
const reserveScript = `
local now = tonumber(redis.call('TIME')[1])
local hourWindow = math.floor(now / ${hourSeconds})
local dayWindow = math.floor(now / ${daySeconds})
local hourKey = KEYS[1] .. ':hour:' .. hourWindow
local dayKey = KEYS[1] .. ':day:' .. dayWindow
local hour = tonumber(redis.call('GET', hourKey) or '0')
local day = tonumber(redis.call('GET', dayKey) or '0')
local amount = tonumber(ARGV[1])
local hourLimit = tonumber(ARGV[2])
local dayLimit = tonumber(ARGV[3])
if hourLimit >= 0 and hour + amount > hourLimit then return {1, hour, day, hourWindow, dayWindow} end
if day + amount > dayLimit then return {2, hour, day, hourWindow, dayWindow} end
local newHour = redis.call('INCRBY', hourKey, ARGV[1])
redis.call('EXPIRE', hourKey, ${hourTtlSeconds})
local newDay = redis.call('INCRBY', dayKey, ARGV[1])
redis.call('EXPIRE', dayKey, ${dayTtlSeconds})
return {0, newHour, newDay, hourWindow, dayWindow}`;

// Takes the amount off both counters, floored at 0. A counter that expired stays gone.
const releaseScript = `
for _, key in ipairs(KEYS) do
  if redis.call('EXISTS', key) == 1 and redis.call('DECRBY', key, ARGV[1]) < 0 then
    redis.call('SET', key, 0, 'KEEPTTL')
  end
end
return 0`;

// Adds the amount to both counters, without a limit
const addScript = `
redis.call('INCRBY', KEYS[1], ARGV[1])
redis.call('EXPIRE', KEYS[1], ${hourTtlSeconds})
redis.call('INCRBY', KEYS[2], ARGV[1])
redis.call('EXPIRE', KEYS[2], ${dayTtlSeconds})
return 0`;

/**
 * Spend limits per network in Redis: per clock hour and per UTC day of Redis's own clock, in micro-USD.
 * Counters live at `<prefix>spend:<network>:hour:<hours since the epoch>` and
 * `<prefix>spend:<network>:day:<days since the epoch>`. The hourly limit is optional. Fails closed:
 * while Redis is down, nothing is signed. Another `keyPrefix` keeps counters of another kind apart,
 * such as refills per asset under `refill:spend:`.
 */
export const createRedisSpendLimits = ({ redis, hourly, daily, keyPrefix = spendKeyPrefix }: {
  readonly redis: Redis;
  readonly hourly: MicroUsd | undefined;
  readonly daily: MicroUsd;
  // Default: spend:
  readonly keyPrefix?: string;
}): SpendLimits => {
  const baseOf = (network: string) => `${redis.prefix}${keyPrefix}${network}`;
  const keysOf = ({ network, windows }: SpendEntry) => [`${baseOf(network)}:hour:${windows.hour}`, `${baseOf(network)}:day:${windows.day}`];
  const ready = () => {
    if (!redis.client.isReady)
      throw new RedisNotReadyError();
  };

  return {
    reserve: async ({ network, amount }) => {
      ready();
      const result = await redis.client.eval(reserveScript, {
        keys: [baseOf(network)],
        arguments: [amount.toString(), hourly === undefined ? '-1' : hourly.toString(), daily.toString()],
      }) as unknown as readonly [number, number, number, number, number];
      const [code, hour, day, hourWindow, dayWindow] = result;

      return {
        refusal: code === 1 ? 'hourly_limit' : code === 2 ? 'daily_limit' : undefined,
        hour: BigInt(hour) as MicroUsd,
        day: BigInt(day) as MicroUsd,
        windows: { hour: hourWindow, day: dayWindow },
      };
    },
    release: async entry => {
      ready();
      await redis.client.eval(releaseScript, { keys: keysOf(entry), arguments: [entry.amount.toString()] });
    },
    add: async entry => {
      ready();
      await redis.client.eval(addScript, { keys: keysOf(entry), arguments: [entry.amount.toString()] });
    },
  };
};
