import type { MicroUsd } from '@anyfare/common';

import type { KeyKind } from './keys.js';

export interface Account {
  readonly id: string;
  readonly createdAt: Date;
}

export interface NewAccount {
  readonly id: string;
  readonly createdAt: Date;
}

/** A stored key. Never the key itself: only its hash is stored, and records don't carry even that. */
export interface ApiKeyRecord {
  readonly id: string;
  readonly accountId: string;
  readonly kind: KeyKind;
  readonly label: string | undefined;
  readonly createdAt: Date;
  readonly revokedAt: Date | undefined;
}

export interface NewApiKey {
  readonly id: string;
  readonly accountId: string;
  readonly kind: KeyKind;
  // hashApiKey of the key
  readonly keyHash: string;
  readonly label?: string;
  readonly createdAt: Date;
}

/** Port: the `accounts` table. */
export interface AccountRepository {
  create(account: NewAccount): Promise<Account>;
  findById(id: string): Promise<Account | undefined>;
}

/** Port: the `api_keys` table. Keys are looked up by hash only. */
export interface ApiKeyRepository {
  insert(key: NewApiKey): Promise<ApiKeyRecord>;
  /** The key with this hash, unless it is revoked. */
  findActiveByHash(keyHash: string): Promise<ApiKeyRecord | undefined>;
  /** Revokes the account's key with this ID and returns it, or undefined when it isn't active. */
  revoke(key: { readonly id: string; readonly accountId: string; readonly revokedAt: Date }): Promise<ApiKeyRecord | undefined>;
}

/** What a payment key may spend, in micro-USD. */
export interface KeyLimits {
  // USD over the key's life. Undefined: no cap beyond the balance and the other limits.
  readonly allowance: MicroUsd | undefined;
  // USD per UTC day. A new key's default comes from platform config.
  readonly dailyBudget: MicroUsd;
  // The highest price of one call. Undefined: no cap.
  readonly maxPrice: MicroUsd | undefined;
  // After this, the key is refused like a revoked one
  readonly expiresAt: Date | undefined;
}

/** A payment key and its limits. Never the key itself: only its hash is stored. */
export interface PaymentKey extends KeyLimits {
  readonly id: string;
  readonly accountId: string;
  // Up to 60 characters
  readonly label: string | undefined;
  readonly createdAt: Date;
  readonly revokedAt: Date | undefined;
}

export interface NewPaymentKey extends KeyLimits {
  readonly id: string;
  readonly accountId: string;
  // hashApiKey of the key
  readonly keyHash: string;
  readonly label: string | undefined;
  readonly createdAt: Date;
}

/** What an owner may change on a payment key. `undefined` leaves a field as it is. */
export type PaymentKeyChanges = Partial<KeyLimits & { readonly label: string | undefined }>;

/** Port: the payment keys in `api_keys`. Each call is scoped to the owning account. */
export interface PaymentKeyRepository {
  insert(key: NewPaymentKey): Promise<PaymentKey>;
  find(key: { readonly id: string; readonly accountId: string }): Promise<PaymentKey | undefined>;
  /** Every payment key of the account, revoked ones too, newest first. */
  list(accountId: string): Promise<readonly PaymentKey[]>;
  /** Changes an active key. Undefined when it isn't the account's or is revoked. */
  update(key: { readonly id: string; readonly accountId: string; readonly changes: PaymentKeyChanges }): Promise<PaymentKey | undefined>;
  /** Revokes an active key. Undefined when it isn't the account's or is already revoked. */
  revoke(key: { readonly id: string; readonly accountId: string; readonly revokedAt: Date }): Promise<PaymentKey | undefined>;
  /** The active payment key with this hash, with its limits: the proxy's lookup. */
  findActiveByHash(keyHash: string): Promise<PaymentKey | undefined>;
}
