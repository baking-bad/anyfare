import type { Clock } from '@anyfare/common';

// How long a settle is kept once its delegate action can no longer execute
export const outcomeRetentionMs = 10 * 60_000;
// The most settles kept: the oldest go first
export const maxOutcomes = 10_000;

/** What became of a payment whose relayer transaction we signed. */
export type SettleOutcome =
  | { readonly state: 'pending'; readonly transaction: string }
  | { readonly state: 'settled'; readonly transaction: string }
  // The transaction is empty when none was included
  | { readonly state: 'failed'; readonly reason: string; readonly message: string | undefined; readonly transaction: string };

export type FinalOutcome = Exclude<SettleOutcome, { readonly state: 'pending' }>;

export interface RememberedSettle {
  readonly outcome: SettleOutcome;
  // The delegate action's sender
  readonly payer: string;
  readonly network: string;
  // The requirement it was settled for, as `requirementOf` writes it
  readonly requirement: string;
  readonly maxBlockHeight: bigint;
}

export interface OutcomeMemory {
  /** The settle of a signed delegate action, by its settlement key, while it's kept. */
  get(key: string): RememberedSettle | undefined;
  /** From when the relayer's transaction is signed: pending, with its hash. Signed again, the new hash. */
  pending(key: string, settle: Omit<RememberedSettle, 'outcome'> & { readonly transaction: string }): void;
  /** The final outcome of a settle kept as pending. */
  finish(key: string, outcome: FinalOutcome): void;
  /** No outcome of the buyer's payment after all, such as when the node refused our transaction: a settle may start afresh. */
  forget(key: string): void;
  /** The final height, from the relayer's last block: past an entry's max_block_height, its time starts. */
  observeHeight(height: bigint): void;
  readonly size: number;
}

export interface OutcomeMemoryOptions {
  readonly clock: Clock;
  readonly retentionMs?: number;
  readonly capacity?: number;
}

/** A requirement's fields a remembered settle must match: the network, asset, amount, and payTo. */
export const requirementOf = (requirement: { readonly network: string; readonly asset: string; readonly amount: string; readonly payTo: string }): string =>
  JSON.stringify([requirement.network, requirement.asset, requirement.amount, requirement.payTo]);

interface Entry extends RememberedSettle {
  // When the height first passed its max_block_height
  passedAt: number | undefined;
}

/**
 * The outcomes of the settles whose relayer transaction we signed, by settlement key: pending with
 * the transaction's hash, settled, or failed. Each is kept from when its transaction is signed until
 * `retentionMs` after its delegate action's max_block_height has passed, and at most `capacity` of
 * them, the oldest going first. In memory only: a restart forgets them, and the chain still keeps a
 * delegate action from landing twice.
 */
export const createOutcomeMemory = ({ clock, retentionMs = outcomeRetentionMs, capacity = maxOutcomes }: OutcomeMemoryOptions): OutcomeMemory => {
  const entries = new Map<string, Entry>();
  let height: bigint | undefined;
  const now = () => clock.now().getTime();
  const expired = (entry: Entry, at: number) => entry.passedAt !== undefined && at - entry.passedAt >= retentionMs;

  return {
    get: key => {
      const entry = entries.get(key);
      if (entry && expired(entry, now())) {
        entries.delete(key);
        return undefined;
      }

      return entry;
    },
    pending: (key, { transaction, ...settle }) => {
      const existing = entries.get(key);
      if (existing) {
        entries.set(key, { ...existing, ...settle, outcome: { state: 'pending', transaction } });
        return;
      }
      entries.set(key, {
        ...settle, outcome: { state: 'pending', transaction }, passedAt: height !== undefined && height > settle.maxBlockHeight ? now() : undefined,
      });
      for (const oldest of entries.keys()) {
        if (entries.size <= capacity)
          break;
        entries.delete(oldest);
      }
    },
    finish: (key, outcome) => {
      const existing = entries.get(key);
      if (existing)
        entries.set(key, { ...existing, outcome });
    },
    forget: key => {
      entries.delete(key);
    },
    observeHeight: observed => {
      if (height !== undefined && observed <= height)
        return;
      height = observed;
      const at = now();
      for (const [key, entry] of entries) {
        if (entry.passedAt === undefined && observed > entry.maxBlockHeight)
          entry.passedAt = at;
        if (expired(entry, at))
          entries.delete(key);
      }
    },
    get size() {
      return entries.size;
    },
  };
};
