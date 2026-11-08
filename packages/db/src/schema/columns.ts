import { customType } from 'drizzle-orm/pg-core';

// Column types more than one table uses. Not exported from the schema index: they hold no tables.

// An on-chain amount in an asset's atomic units, which can pass a bigint for 18-decimal assets
export const atomicAmount = customType<{ data: bigint; driverData: string }>({
  dataType: () => 'numeric(78, 0)',
  toDriver: value => value.toString(),
  fromDriver: value => BigInt(value),
});
